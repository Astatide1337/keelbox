import {
  helmBaseEnvironment,
  isolatedHelmCredentials,
} from "./helm-environment";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  lstat,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, relative, sep } from "node:path";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { parseAllDocuments, stringify } from "yaml";
import { at, list, object, text, type SourceFile } from "../domain/types";
import { run } from "./process";
import { parseSources } from "../domain/importer";
import {
  repositoryFiles,
  type RepositoryOptions,
  type RenderProvenance,
} from "./repository-import";

const pinnedGit = /^[a-f0-9]{40}$/i;
const pinnedChart = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/;
async function publicRepository(raw: string, oci = false) {
  const url = new URL(raw);
  if (
    !(url.protocol === "https:" || (oci && url.protocol === "oci:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    isIP(url.hostname) ||
    /(^localhost$|\.localhost$|\.local$|^127\.|^10\.|^192\.168\.|^169\.254\.)/i.test(
      url.hostname,
    )
  )
    throw Error(
      "Argo sources must use credential-free public HTTPS (or public OCI for charts). Private source authentication is not borrowed from your Git/Helm configuration.",
    );
  const addresses = await lookup(url.hostname, { all: true });
  if (
    !addresses.length ||
    addresses.some(({ address }) =>
      /^(0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|::1$|::$|::ffff:|f[cd]|fe[89ab])/i.test(
        address,
      ),
    )
  )
    throw Error(
      "Argo remote sources must resolve to public network addresses; use an explicit local checkout for private networks.",
    );
  return url.toString().replace(/\/$/, "");
}
async function within(root: string, path: string) {
  const actual = await realpath(resolve(root, path));
  if (actual !== root && !actual.startsWith(root + sep))
    throw Error("Argo source path escapes its repository.");
  return actual;
}
async function boundCheckout(root: string) {
  let bytes = 0,
    files = 0;
  async function walk(path: string) {
    for (const item of await readdir(path, { withFileTypes: true })) {
      if (item.name === ".git") continue;
      const current = join(path, item.name);
      if (item.isSymbolicLink())
        throw Error(
          "Argo repository symlinks are not supported; render an explicit regular-file copy.",
        );
      if (++files > 5000)
        throw Error(
          "Argo checkout exceeds 5,000 paths; select a smaller repository.",
        );
      if (item.isDirectory()) await walk(current);
      else {
        bytes += (await lstat(current)).size;
        if (bytes > 20_000_000)
          throw Error(
            "Argo checkout exceeds 20 MB; import a bounded local checkout instead.",
          );
      }
    }
  }
  await walk(root);
}
/** Resolve authored Applications once. This imports desired resources, never syncs a cluster. */
export async function resolveArgoFiles(files: SourceFile[]) {
  const applications = files
    .flatMap((file) =>
      parseAllDocuments(file.content)
        .filter((doc) => !doc.errors.length)
        .map((doc) => object(doc.toJS())),
    )
    .filter((resource) => resource.kind === "Application");
  if (!applications.length)
    throw Error("No Argo Application found in the selected manifests.");
  const output: SourceFile[] = [],
    provenance: RenderProvenance[] = [],
    notes: string[] = [];
  const temp = await mkdtemp(join(tmpdir(), "waypoint-argo-"));
  try {
    const env = {
      ...helmBaseEnvironment(process.env),
      HOME: temp,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "0",
      GIT_CONFIG_PARAMETERS: "",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      KUBECONFIG: "/dev/null",
      HELM_CACHE_HOME: join(temp, "helm-cache"),
      HELM_CONFIG_HOME: join(temp, "helm-config"),
      HELM_DATA_HOME: join(temp, "helm-data"),
      HELM_PLUGINS: join(temp, "helm-plugins"),
      ...(await isolatedHelmCredentials(temp)),
      HELM_REPOSITORY_CONFIG: join(temp, "helm-config", "repositories.yaml"),
      HELM_REPOSITORY_CACHE: join(temp, "helm-cache", "repository"),
    };
    for (const [applicationIndex, application] of applications.entries()) {
      const spec = object(application.spec),
        sources = list(spec.sources).length
          ? list(spec.sources)
          : [object(spec.source)],
        checkouts: {
          source: ReturnType<typeof object>;
          root: string;
          repository: string;
          ref: string;
        }[] = [];
      if (sources.length > 10)
        throw Error(
          "Argo import supports at most ten ordered sources per Application.",
        );
      for (const [index, source] of sources.entries()) {
        const repo = await publicRepository(
            text(source.repoURL),
            !!source.chart,
          ),
          ref = text(source.targetRevision),
          root = join(temp, `app-${applicationIndex}-source-${index}`);
        await mkdir(root, { recursive: true });
        if (source.chart) {
          if (!pinnedChart.test(ref))
            throw Error(
              `Argo chart ${text(source.chart)} requires an exact pinned chart version, not ${ref || "an omitted revision"}.`,
            );
          if (
            !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(text(source.chart)) ||
            text(source.chart).includes("..")
          )
            throw Error("Invalid Argo chart name.");
          const chart = repo.startsWith("oci:")
            ? repo + "/" + text(source.chart)
            : text(source.chart);
          await run(
            process.env.WAYPOINT_HELM_BIN ?? "helm",
            [
              "pull",
              chart,
              ...(repo.startsWith("oci:") ? [] : ["--repo", repo]),
              "--version",
              ref,
              "--untar",
              "--untardir",
              root,
            ],
            { env, timeout: 120000 },
          );
          const dirs = await readdir(root);
          if (dirs.length !== 1)
            throw Error("Chart archive must contain one chart directory.");
          checkouts.push({
            source,
            root: await realpath(join(root, dirs[0])),
            repository: repo,
            ref,
          });
        } else {
          if (!pinnedGit.test(ref))
            throw Error(
              `Argo Git source ${repo} requires a pinned 40-character commit SHA. Branches and tags may change between preview and apply.`,
            );
          await run(
            "git",
            [
              "-c",
              "credential.helper=",
              "-c",
              "core.hooksPath=/dev/null",
              "-c",
              "protocol.file.allow=never",
              "init",
              root,
            ],
            { env },
          );
          await run(
            "git",
            [
              "-C",
              root,
              "-c",
              "credential.helper=",
              "-c",
              "http.extraHeader=",
              "-c",
              "http.followRedirects=false",
              "-c",
              "protocol.file.allow=never",
              "fetch",
              "--depth=1",
              "--no-tags",
              repo,
              ref,
            ],
            { env, timeout: 120000 },
          );
          await run(
            "git",
            [
              "-C",
              root,
              "-c",
              "core.hooksPath=/dev/null",
              "checkout",
              "--detach",
              "FETCH_HEAD",
            ],
            { env, timeout: 30000 },
          );
          const actual = (
            await run("git", ["-C", root, "rev-parse", "HEAD"], { env })
          ).trim();
          if (actual !== ref.toLowerCase())
            throw Error(
              "Argo fetched revision does not match the reviewed pin.",
            );
          await boundCheckout(root);
          checkouts.push({
            source,
            root: await realpath(root),
            repository: repo,
            ref,
          });
        }
      }
      const refs = new Map(
        checkouts
          .filter((item) => item.source.ref)
          .map((item) => [text(item.source.ref), item.root]),
      );
      for (const [index, item] of checkouts.entries()) {
        const source = item.source;
        if (!source.path && !source.chart) {
          if (!source.ref)
            throw Error(
              "Argo source requires path, chart, or an external-values ref.",
            );
          continue;
        }
        const entry = source.chart
          ? item.root
          : await within(item.root, text(source.path));
        const options: RepositoryOptions = {
          entry: relative(item.root, entry) || ".",
          namespace: text(at(spec, "destination", "namespace")) || undefined,
          release:
            text(at(source, "helm", "releaseName")) ||
            text(at(application, "metadata", "name")) ||
            "waypoint",
          values: [],
          recurse: at(source, "directory", "recurse") === true,
        };
        if (at(source, "helm", "skipCrds") === true)
          notes.push(
            "Argo skipCrds requested; CRDs still cause an explicit local-deployment refusal if present. No operator is silently installed.",
          );
        const helm = object(source.helm);
        if (helm.passCredentials === true)
          throw Error(
            "Argo passCredentials is not supported; credentials are never propagated to chart hosts.",
          );
        if (helm.version && helm.version !== "v3")
          throw Error(
            "Only the installed current Helm renderer is supported, not legacy Helm v2.",
          );
        if (
          Object.keys(object(source.directory)).some((key) => key !== "recurse")
        )
          throw Error(
            "Argo directory include/exclude/Jsonnet options are not silently ignored; prepare an explicit selected local manifest directory.",
          );
        const originalValuePaths: string[] = [];
        options.kubernetesVersion = text(helm.kubeVersion) || undefined;
        options.apiVersions = Array.isArray(helm.apiVersions)
          ? helm.apiVersions.filter(
              (value): value is string => typeof value === "string",
            )
          : undefined;
        options.parameters = list(helm.parameters).map((parameter) => {
          if (
            typeof parameter.name !== "string" ||
            typeof parameter.value !== "string" ||
            parameter.name.length > 200 ||
            parameter.value.length > 10000
          )
            throw Error("Invalid or oversized Argo Helm parameter.");
          return {
            name: parameter.name,
            value: parameter.value,
            forceString: parameter.forceString === true,
          };
        });
        if (helm.fileParameters)
          throw Error(
            "Argo Helm fileParameters require explicit local values files; file contents are not passed via shell flags.",
          );
        for (const [valueIndex, value] of (Array.isArray(helm.valueFiles)
          ? helm.valueFiles
          : []
        ).entries()) {
          if (typeof value !== "string")
            throw Error("Argo valueFiles must be strings.");
          let valuesPath: string;
          if (value.startsWith("$")) {
            const slash = value.indexOf("/"),
              root = refs.get(value.slice(1, slash));
            if (!root || slash < 0)
              throw Error(`Argo external values ref ${value} is unresolved.`);
            valuesPath = await within(root, value.slice(slash + 1));
          } else {
            try {
              valuesPath = await within(entry, value);
            } catch (error) {
              if (
                helm.ignoreMissingValueFiles === true &&
                (error as NodeJS.ErrnoException).code === "ENOENT"
              ) {
                notes.push(`Optional Argo values file skipped: ${value}`);
                continue;
              }
              throw error;
            }
          }
          const content = await readFile(valuesPath, "utf8");
          if (Buffer.byteLength(content) > 2_000_000)
            throw Error("Argo values file exceeds 2 MB.");
          const destination = join(
            item.root,
            `waypoint-values-${index}-${valueIndex}.yaml`,
          );
          await writeFile(destination, content, { mode: 0o600 });
          options.values!.push(relative(item.root, destination));
          originalValuePaths.push(value);
        }
        for (const [key, content] of [
          ["values", typeof helm.values === "string" ? helm.values : undefined],
          [
            "valuesObject",
            helm.valuesObject ? stringify(helm.valuesObject) : undefined,
          ],
        ] as const)
          if (content) {
            const destination = join(
              item.root,
              `waypoint-${key}-${index}.yaml`,
            );
            await writeFile(destination, content, { mode: 0o600 });
            options.values!.push(relative(item.root, destination));
            originalValuePaths.push(`inline ${key}`);
          }
        if (source.kustomize && Object.keys(object(source.kustomize)).length)
          throw Error(
            "Argo Kustomize overrides are unsupported; import a reviewed overlay with those settings committed explicitly.",
          );
        if (source.plugin)
          throw Error(
            "Argo config-management plugins are not executed. Import their rendered output explicitly.",
          );
        const result = await repositoryFiles([item.root], options);
        if (options.namespace)
          for (const file of result.files) {
            const docs = parseAllDocuments(file.content).map((doc) =>
              object(doc.toJS()),
            );
            for (const resource of docs)
              if (
                ![
                  "Namespace",
                  "ClusterRole",
                  "ClusterRoleBinding",
                  "CustomResourceDefinition",
                  "PersistentVolume",
                  "StorageClass",
                ].includes(text(resource.kind)) &&
                !at(resource, "metadata", "namespace")
              )
                object(resource.metadata).namespace = options.namespace;
            file.content = docs
              .map((resource) => stringify(resource))
              .join("---\n");
          }
        output.push(...result.files);
        notes.push(...result.notes);
        provenance.push(
          ...result.provenance.map((proof) => ({
            ...proof,
            values: proof.values.map((value, index) => ({
              ...value,
              path: originalValuePaths[index] ?? value.path,
              repository: originalValuePaths[index]?.startsWith("$")
                ? checkouts.find(
                    (c) =>
                      c.source.ref ===
                      originalValuePaths[index].split("/")[0].slice(1),
                  )?.repository
                : item.repository,
              ref: originalValuePaths[index]?.startsWith("$")
                ? checkouts.find(
                    (c) =>
                      c.source.ref ===
                      originalValuePaths[index].split("/")[0].slice(1),
                  )?.ref
                : item.ref,
            })),
            repository: item.repository,
            ref: item.ref,
          })),
        );
      }
      notes.push(
        `Application/${text(at(application, "metadata", "name"))}: pinned desired sources resolved in order; destination cluster ${text(at(spec, "destination", "server")) || text(at(spec, "destination", "name")) || "unspecified"} is provenance only and is never contacted. Local deployment uses an owned namespace.`,
      );
    }
    if (!output.length)
      throw Error("Argo sources produced no Kubernetes resources.");
    // Argo multi-source semantics: last source wins for each full resource identity.
    const ordered = new Map<string, unknown>();
    // Parse each source independently so duplicate identity diagnostics cannot discard later-source precedence.
    for (const file of output)
      for (const item of parseSources([file]).resources) {
        const resource = item.raw;
        const identity = [
          text(resource.apiVersion).split("/").slice(0, -1).join("/"),
          resource.kind,
          at(resource, "metadata", "namespace") ?? "default",
          at(resource, "metadata", "name"),
        ].join("/");
        if (ordered.has(identity))
          notes.push(
            `Argo repeated resource ${identity}: later source takes precedence.`,
          );
        ordered.set(identity, resource);
      }
    const content = [...ordered.values()]
      .map((resource) => stringify(resource))
      .join("---\n");
    if (Buffer.byteLength(content) > 2_000_000)
      throw Error("Resolved Argo manifests exceed 2 MB.");
    return {
      files: [
        {
          id: files[0].id + "-argo",
          name: "Argo resolved desired resources",
          content,
        },
      ],
      notes,
      provenance,
    };
  } catch (error) {
    throw Error(
      `Argo source resolution failed: ${(error as Error).message}. Private repositories/charts need a separately user-authenticated local checkout; no production credentials were requested.`,
    );
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}
