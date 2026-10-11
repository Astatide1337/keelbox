import {
  helmBaseEnvironment,
  isolatedHelmCredentials,
} from "./helm-environment";
import { tmpdir } from "node:os";
import {
  lstat,
  readdir,
  readFile,
  mkdtemp,
  cp,
  rm,
  mkdir,
  realpath,
} from "node:fs/promises";
import { basename, join, dirname, relative, resolve, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parseAllDocuments, stringify } from "yaml";
import { run } from "./process";
import { at, object, type SourceFile } from "../domain/types";
export type RepositoryEntry = {
  path: string;
  kind: "helm" | "kustomize" | "yaml";
  name: string;
};
export type RenderProvenance = {
  path: string;
  renderer: "yaml" | "helm" | "kustomize";
  version: string;
  namespace?: string;
  release?: string;
  kubernetesVersion?: string;
  apiVersions?: string[];
  values: { path: string; sha256: string; repository?: string; ref?: string }[];
  parameters?: { name: string; sha256: string; forceString: boolean }[];
  lockfiles: { path: string; sha256: string }[];
  sourceMappings: string[];
  repository?: string;
  ref?: string;
};
export type RepositoryOptions = {
  entry?: string;
  values?: string[];
  release?: string;
  namespace?: string;
  kubernetesVersion?: string;
  apiVersions?: string[];
  recurse?: boolean;
  parameters?: { name: string; value: string; forceString?: boolean }[];
};
const sha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export function kustomizeRendererVersion(output: string): string {
  let version: unknown;
  try {
    version = JSON.parse(output);
  } catch {
    throw Error("kubectl returned invalid client-version JSON.");
  }
  const client = at(version, "clientVersion", "gitVersion");
  const kustomize = at(version, "kustomizeVersion");
  const valid = (value: unknown): value is string =>
    typeof value === "string" &&
    /^v?\d+\.\d+\.\d+[A-Za-z0-9.+-]*$/.test(value) &&
    value.length <= 100;
  if (!valid(client) || !valid(kustomize))
    throw Error(
      "kubectl did not report supported client and Kustomize versions.",
    );
  return `kubectl ${client}; kustomize ${kustomize}`;
}
const maximumBytes = 2_000_000;
const ignored = new Set([
  ".git",
  "node_modules",
  ".next",
  "dist",
  ".waypoint",
  "secrets",
  "credentials",
]);
const sensitive = (name: string) =>
  /(^\.env|\.enc\.|\.sops\.|\.age$|\.pem$|\.key$|^keys\.txt$|kubeconfig)/i.test(
    name,
  );
export async function repositoryEntries(
  root: string,
  skipped: string[] = [],
): Promise<RepositoryEntry[]> {
  const entries: RepositoryEntry[] = [];
  let visited = 0;
  async function visit(path: string, depth: number) {
    if (++visited > 5000 || depth > 20)
      throw Error(
        "Repository discovery exceeded its traversal bound. Select an application subdirectory.",
      );
    const items = (await readdir(path, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    if (items.some((i) => i.isFile() && i.name === "Chart.yaml")) {
      entries.push({ path, kind: "helm", name: basename(path) });
      return;
    }
    if (
      items.some(
        (i) =>
          i.isFile() &&
          ["kustomization.yaml", "kustomization.yml", "Kustomization"].includes(
            i.name,
          ),
      )
    ) {
      entries.push({ path, kind: "kustomize", name: basename(path) });
      return;
    }
    if (
      items.some(
        (i) =>
          i.isFile() && /\.(ya?ml|json)$/i.test(i.name) && !sensitive(i.name),
      )
    )
      entries.push({ path, kind: "yaml", name: basename(path) });
    for (const i of items) {
      if (
        ignored.has(i.name) ||
        sensitive(i.name) ||
        i.isSymbolicLink() ||
        i.name.startsWith(".")
      )
        skipped.push(
          `Skipped ${relative(root, join(path, i.name))}: machine state, credential-sensitive name, hidden path or symlink.`,
        );
      if (i.isDirectory() && !ignored.has(i.name) && !i.name.startsWith("."))
        await visit(join(path, i.name), depth + 1);
    }
  }
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink())
    throw Error("Choose a regular repository directory.");
  await visit(root, 0);
  return entries;
}
// Values are intentionally excluded from the browser, snapshots and AI context.
// Rendered Secret keys remain available for dependency discovery and local configuration.
export function publicManifest(content: string): {
  content: string;
  notes: string[];
} {
  const docs = parseAllDocuments(content),
    notes: string[] = [];
  if (docs.some((d) => d.errors.length))
    throw Error(
      "invalid YAML. Render templates first or correct the manifest.",
    );
  const values = docs.filter((d) => d.contents).map((d) => d.toJS());
  const scrub = (v: any): any => {
    if (Array.isArray(v)) return v.map(scrub);
    if (!v || typeof v !== "object") return v;
    if (
      object(v.annotations)[
        "kubectl.kubernetes.io/last-applied-configuration"
      ] !== undefined
    ) {
      delete v.annotations["kubectl.kubernetes.io/last-applied-configuration"];
      notes.push("Server last-applied payload omitted from imported source.");
    }
    if (
      typeof v.kind === "string" &&
      v.kind.endsWith("List") &&
      v.kind !== "List" &&
      Array.isArray(v.items)
    )
      v.items = v.items.map((item: unknown) => ({
        apiVersion: v.apiVersion,
        kind: v.kind.slice(0, -4),
        ...object(item),
      }));
    for (const [k, x] of Object.entries(v))
      if (x && typeof x === "object") v[k] = scrub(x);
    if (at(v, "kind") === "Secret") {
      const keys = [
        ...new Set([
          ...Object.keys(object(v.data)),
          ...Object.keys(object(v.stringData)),
        ]),
      ];
      delete v.data;
      delete v.stringData;
      v.metadata = {
        name: at(v, "metadata", "name"),
        ...(at(v, "metadata", "namespace")
          ? { namespace: at(v, "metadata", "namespace") }
          : {}),
        annotations: { "waypoint.dev/secret-keys": JSON.stringify(keys) },
      };
      notes.push(
        `Secret/${at(v, "metadata", "name")}: values omitted; supply local test values.`,
      );
    }
    return v;
  };
  const safe = values
    .filter((v) => {
      if (object(v).sops) {
        notes.push(
          "Encrypted document omitted; configure local test secrets instead.",
        );
        return false;
      }
      const manifest = !!at(v, "apiVersion") && !!at(v, "kind");
      if (!manifest)
        notes.push(
          "Document skipped: no Kubernetes apiVersion/kind (for example values or repository configuration).",
        );
      return manifest;
    })
    .map(scrub);
  return { content: safe.map((v) => stringify(v)).join("---\n"), notes };
}
export async function repositoryFiles(
  paths: string[],
  options: RepositoryOptions = {},
) {
  const expanded: string[] = [];
  const notes: string[] = [];
  const provenance: RenderProvenance[] = [];
  const rendered: SourceFile[] = [];
  for (const input of paths) {
    const root = resolve(input),
      st = await lstat(root);
    if (st.isSymbolicLink()) throw Error("Import symlinks are unsupported.");
    if (st.isFile()) {
      expanded.push(root);
      continue;
    }
    const entries = await repositoryEntries(root, notes);
    const chosen = options.entry
      ? entries.filter(
          (e) =>
            relative(root, e.path) === options.entry ||
            e.path === resolve(root, options.entry!) ||
            (options.recurse === true &&
              e.kind === "yaml" &&
              e.path.startsWith(resolve(root, options.entry!) + sep)),
        )
      : entries;
    if (options.entry && !chosen.length)
      throw Error("Application entry not found. Run import --list REPOSITORY.");
    if (!options.entry && entries.length > 1)
      throw Error(
        `Select an application with --entry. Entries: ${entries.map((e) => relative(root, e.path) || ".").join(", ")}`,
      );
    for (const entry of chosen) {
      if (entry.kind === "yaml") {
        for (const name of await readdir(entry.path))
          if (/\.(ya?ml|json)$/i.test(name) && !sensitive(name))
            expanded.push(join(entry.path, name));
      } else {
        let output: string;
        const proof: RenderProvenance = {
          path: relative(root, entry.path) || ".",
          renderer: entry.kind,
          version: "unknown",
          values: [],
          lockfiles: [],
          sourceMappings: [],
        };
        if (entry.kind === "helm") {
          const release = options.release ?? "waypoint";
          if (!/^[a-z][a-z0-9-]{0,52}$/.test(release))
            throw Error("Invalid Helm release name.");
          if (
            options.namespace &&
            !/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(options.namespace)
          )
            throw Error("Invalid Helm namespace.");
          if (
            options.kubernetesVersion &&
            !/^v?\d+\.\d+(?:\.\d+)?(?:[-+][a-zA-Z0-9.-]+)?$/.test(
              options.kubernetesVersion,
            )
          )
            throw Error("Invalid Kubernetes version.");
          if (
            options.apiVersions?.some(
              (value) => !/^[a-zA-Z0-9./-]+$/.test(value),
            )
          )
            throw Error("Invalid Helm API capability.");
          proof.release = release;
          proof.namespace = options.namespace ?? "default";
          proof.kubernetesVersion = options.kubernetesVersion;
          proof.apiVersions = options.apiVersions;
          proof.parameters = options.parameters?.map((p) => ({
            name: p.name,
            sha256: sha256(p.value),
            forceString: p.forceString === true,
          }));
          for (const filename of ["Chart.lock", "requirements.lock"]) {
            try {
              // User-selected chart inputs are runtime files, never bundled assets.
              const content = await readFile(
                /* turbopackIgnore: true */ join(
                  /* turbopackIgnore: true */ entry.path,
                  filename,
                ),
                "utf8",
              );
              proof.lockfiles.push({ path: filename, sha256: sha256(content) });
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT")
                throw error;
            }
          }
          for (const filename of options.values ?? []) {
            const valuesPath = await realpath(resolve(root, filename));
            const actualRoot = await realpath(root);
            if (
              valuesPath !== actualRoot &&
              !valuesPath.startsWith(actualRoot + sep)
            )
              throw Error("Helm values escape the selected repository.");
            if (sensitive(basename(valuesPath)))
              throw Error("Sensitive credential files cannot be Helm values.");
            const content = await readFile(valuesPath, "utf8");
            if (Buffer.byteLength(content) > maximumBytes)
              throw Error("Helm values exceed 2 MB.");
            proof.values.push({
              path: relative(root, valuesPath),
              sha256: sha256(content),
            });
          }
          const temp = await mkdtemp(join(tmpdir(), "waypoint-helm-"));
          try {
            const copied = new Set<string>();
            let copiedBytes = 0,
              copiedPaths = 0;
            async function copyChart(source: string) {
              if (copied.has(source)) return;
              copied.add(source);
              if (source !== root && !source.startsWith(root + sep))
                throw Error("Local chart dependency escapes the repository.");
              const dest = join(temp, relative(root, source));
              await mkdir(dirname(dest), { recursive: true });
              await cp(source, dest, {
                recursive: true,
                filter: async (p) => {
                  const st = await lstat(p);
                  if (st.isSymbolicLink())
                    throw Error(
                      "Chart symlinks must be resolved before import.",
                    );
                  if (
                    ignored.has(basename(p)) ||
                    sensitive(basename(p)) ||
                    (p !== source && basename(p).startsWith("."))
                  )
                    return false;
                  if (++copiedPaths > 5000)
                    throw Error("Helm input exceeds 5,000 paths.");
                  if (st.isFile()) copiedBytes += st.size;
                  if (copiedBytes > 20_000_000)
                    throw Error(
                      "Helm input exceeds 20 MB; select a smaller repository.",
                    );
                  return true;
                },
              });
              const chart = object(
                parseAllDocuments(
                  await readFile(join(source, "Chart.yaml"), "utf8"),
                )[0]?.toJS(),
              );
              for (const d of Array.isArray(chart.dependencies)
                ? chart.dependencies
                : [])
                if (
                  typeof d.repository === "string" &&
                  d.repository.startsWith("file://")
                )
                  await copyChart(resolve(source, d.repository.slice(7)));
            }
            await copyChart(entry.path);
            const chart = join(temp, relative(root, entry.path));
            const env = {
              ...helmBaseEnvironment(process.env),
              KUBECONFIG: "/dev/null",
              HELM_CACHE_HOME: join(temp, "cache"),
              HELM_CONFIG_HOME: join(temp, "config"),
              HELM_DATA_HOME: join(temp, "data"),
              HELM_PLUGINS: join(temp, "plugins"),
              ...(await isolatedHelmCredentials(temp)),
              HELM_REPOSITORY_CONFIG: join(temp, "config", "repositories.yaml"),
              HELM_REPOSITORY_CACHE: join(temp, "cache", "repository"),
            };
            // Even Helm's version command initializes registry configuration in Helm 4.
            // Keep every invocation on the same disposable configuration paths.
            proof.version = (
              await run(
                process.env.WAYPOINT_HELM_BIN ?? "helm",
                ["version", "--short"],
                { env, timeout: 10000 },
              )
            ).trim();
            const metadata = object(
              parseAllDocuments(
                await readFile(join(chart, "Chart.yaml"), "utf8"),
              )[0]?.toJS(),
            );
            if (
              Array.isArray(metadata.dependencies) &&
              metadata.dependencies.length
            ) {
              const dependencyStatus = (
                await run(
                  process.env.WAYPOINT_HELM_BIN ?? "helm",
                  ["dependency", "list", chart],
                  { env, timeout: 10000 },
                )
              )
                .trim()
                .split("\n")
                .slice(1)
                .filter((line) => line.trim());
              if (
                dependencyStatus.length !== metadata.dependencies.length ||
                dependencyStatus.some((line) => !/\bok\s*$/.test(line))
              )
                await run(
                  process.env.WAYPOINT_HELM_BIN ?? "helm",
                  ["dependency", "build", chart],
                  { env, timeout: 120000 },
                );
              else
                notes.push(
                  "Vendored Helm dependencies match the chart; no registry download was needed.",
                );
            }
            output = await run(
              process.env.WAYPOINT_HELM_BIN ?? "helm",
              [
                "template",
                release,
                chart,
                "--include-crds",
                "--namespace",
                options.namespace ?? "default",
                ...(options.kubernetesVersion
                  ? ["--kube-version", options.kubernetesVersion]
                  : []),
                ...(options.apiVersions ?? []).flatMap((version) => [
                  "--api-versions",
                  version,
                ]),
                ...(options.parameters ?? []).flatMap((parameter) => [
                  parameter.forceString ? "--set-string" : "--set",
                  `${parameter.name}=${parameter.value}`,
                ]),
                ...(options.values ?? []).flatMap((v) => [
                  "--values",
                  resolve(root, v),
                ]),
              ],
              { env, timeout: 60000 },
            );
          } catch (e) {
            throw Error(
              `Helm rendering failed. Public OCI and local/vendored dependencies are supported. Private registries require an explicit user-managed authenticated renderer; Waypoint does not borrow registry credentials. Install Helm or resolve the reported chart dependency. Source files were not modified. ${(e as Error).message}`,
            );
          } finally {
            await rm(temp, { recursive: true, force: true });
          }
        } else {
          const seen = new Set<string>();
          const rootReal = await realpath(root);
          async function checkPath(base: string, ref: string): Promise<string> {
            const raw = ref.includes("=")
              ? ref.slice(ref.indexOf("=") + 1)
              : ref;
            if (!raw || /https?:|git@|github\.com|git::/.test(raw))
              throw Error(
                "Remote Kustomize files must be fetched explicitly into the repository first.",
              );
            const path = resolve(base, raw),
              actual = await realpath(path);
            if (actual !== rootReal && !actual.startsWith(rootReal + sep))
              throw Error("Kustomize input escapes the selected repository.");
            if (
              relative(rootReal, actual)
                .split(sep)
                .some(
                  (segment) =>
                    ignored.has(segment) ||
                    sensitive(segment) ||
                    segment.startsWith("."),
                )
            )
              throw Error(
                "Sensitive machine credential files cannot be used as Kustomize inputs.",
              );
            if ((await lstat(path)).isSymbolicLink())
              throw Error("Resolve Kustomize symlinks before importing.");
            return actual;
          }
          async function validateKustomization(directory: string) {
            if (seen.has(directory)) return;
            seen.add(directory);
            if (seen.size > 100)
              throw Error("Kustomize reference graph exceeds 100 directories.");
            const filename = (await readdir(directory)).find((n) =>
              [
                "kustomization.yaml",
                "kustomization.yml",
                "Kustomization",
              ].includes(n),
            );
            if (!filename) return;
            const doc = object(
              parseAllDocuments(
                await readFile(join(directory, filename), "utf8"),
              )[0]?.toJS(),
            );
            if (doc.generators || doc.transformers || doc.helmCharts)
              throw Error(
                "Custom Kustomize plugins and embedded Helm charts must be rendered explicitly first.",
              );
            for (const field of [
              "resources",
              "bases",
              "components",
              "patchesStrategicMerge",
              "configurations",
              "crds",
            ])
              for (const ref of Array.isArray(doc[field]) ? doc[field] : []) {
                if (typeof ref !== "string") continue;
                const path = await checkPath(directory, ref);
                if ((await lstat(path)).isDirectory())
                  await validateKustomization(path);
              }
            for (const field of ["patches", "patchesJson6902", "replacements"])
              for (const patch of Array.isArray(doc[field]) ? doc[field] : [])
                if (typeof patch.path === "string")
                  await checkPath(directory, patch.path);
            for (const field of ["secretGenerator", "configMapGenerator"])
              for (const generator of Array.isArray(doc[field])
                ? doc[field]
                : [])
                for (const ref of [
                  ...(generator.files ?? []),
                  ...(generator.envs ?? []),
                  ...(generator.env ? [generator.env] : []),
                ]) {
                  if (typeof ref !== "string")
                    throw Error("Invalid generator input.");
                  await checkPath(directory, ref);
                }
            if (at(doc, "openapi", "path"))
              await checkPath(directory, String(at(doc, "openapi", "path")));
          }
          await validateKustomization(entry.path);
          proof.version = kustomizeRendererVersion(
            await run("kubectl", ["version", "--client", "-o", "json"], {
              timeout: 10000,
              env: {
                ...helmBaseEnvironment(process.env),
                KUBECONFIG: "/dev/null",
              },
            }),
          );
          const temp = await mkdtemp(join(tmpdir(), "waypoint-kustomize-"));
          try {
            let copiedBytes = 0,
              copiedPaths = 0;
            const copiedRoot = join(temp, "repository");
            await cp(root, copiedRoot, {
              recursive: true,
              filter: async (path) => {
                const name = basename(path);
                if (
                  path !== root &&
                  (ignored.has(name) || sensitive(name) || name.startsWith("."))
                )
                  return false;
                const stat = await lstat(path);
                if (stat.isSymbolicLink())
                  throw Error("Kustomize symlinks are unsupported.");
                if (++copiedPaths > 5000)
                  throw Error("Kustomize input exceeds 5,000 paths.");
                if (stat.isFile()) copiedBytes += stat.size;
                if (copiedBytes > 20_000_000)
                  throw Error(
                    "Kustomize input exceeds 20 MB; select a smaller repository.",
                  );
                return true;
              },
            });
            output = await run(
              "kubectl",
              ["kustomize", join(copiedRoot, relative(root, entry.path))],
              {
                timeout: 60000,
                env: {
                  ...helmBaseEnvironment(process.env),
                  KUBECONFIG: "/dev/null",
                },
              },
            );
          } finally {
            await rm(temp, { recursive: true, force: true });
          }
        }
        if (Buffer.byteLength(output) > maximumBytes)
          throw Error(
            "Rendered import exceeds 2 MB. Select a smaller application entry.",
          );
        proof.sourceMappings = [
          ...new Set(
            [...output.matchAll(/^# Source: (.+)$/gm)].map((match) => match[1]),
          ),
        ];
        provenance.push(proof);
        const safe = publicManifest(output);
        notes.push(...safe.notes);
        rendered.push({
          id: randomUUID(),
          name: `${entry.path} (${entry.kind} rendered)`,
          content: safe.content,
        });
      }
    }
  }
  let size = rendered.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
  for (const path of [...new Set(expanded)]) {
    const st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink())
      throw Error("Import expects regular files.");
    size += st.size;
    if (size > 2_000_000)
      throw Error("Import exceeds 2 MB. Select a smaller application entry.");
    const raw = await readFile(path, "utf8");
    if (raw.trim().startsWith("{") && raw.includes("playground-snapshot-")) {
      rendered.push({ id: randomUUID(), name: path, content: raw });
      continue;
    }
    provenance.push({
      path,
      renderer: "yaml",
      version: "YAML 1.2",
      values: [],
      lockfiles: [],
      sourceMappings: [path],
    });
    const safe = publicManifest(raw);
    notes.push(...safe.notes);
    if (safe.content)
      rendered.push({ id: randomUUID(), name: path, content: safe.content });
  }
  if (!rendered.length || rendered.length > 100)
    throw Error(
      "Choose an application containing 1–100 rendered manifest files.",
    );
  if (size > maximumBytes) throw Error("Rendered import exceeds 2 MB.");
  return { files: rendered, notes, provenance };
}
