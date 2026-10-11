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
import { randomUUID } from "node:crypto";
import { parseAllDocuments, stringify } from "yaml";
import { run } from "./process";
import { at, object, type SourceFile } from "../domain/types";
export type RepositoryEntry = {
  path: string;
  kind: "helm" | "kustomize" | "yaml";
  name: string;
};
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
        (i) => i.isFile() && /\.ya?ml$/i.test(i.name) && !sensitive(i.name),
      )
    )
      entries.push({ path, kind: "yaml", name: basename(path) });
    for (const i of items)
      if (i.isDirectory() && !ignored.has(i.name) && !i.name.startsWith("."))
        await visit(join(path, i.name), depth + 1);
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
      return !!at(v, "apiVersion") && !!at(v, "kind");
    })
    .map(scrub);
  return { content: safe.map((v) => stringify(v)).join("---\n"), notes };
}
export async function repositoryFiles(
  paths: string[],
  options: { entry?: string; values?: string[]; release?: string } = {},
) {
  const expanded: string[] = [];
  const notes: string[] = [];
  const rendered: SourceFile[] = [];
  for (const input of paths) {
    const root = resolve(input),
      st = await lstat(root);
    if (st.isSymbolicLink()) throw Error("Import symlinks are unsupported.");
    if (st.isFile()) {
      expanded.push(root);
      continue;
    }
    const entries = await repositoryEntries(root);
    const chosen = options.entry
      ? entries.filter(
          (e) =>
            relative(root, e.path) === options.entry ||
            e.path === resolve(root, options.entry!),
        )
      : entries;
    if (options.entry && !chosen.length)
      throw Error("Application entry not found. Run import --list REPOSITORY.");
    if (
      !options.entry &&
      entries.some((e) => e.kind !== "yaml") &&
      entries.length > 1
    )
      throw Error(
        `Select an application with --entry. Entries: ${entries.map((e) => relative(root, e.path) || ".").join(", ")}`,
      );
    for (const entry of chosen) {
      if (entry.kind === "yaml") {
        for (const name of await readdir(entry.path))
          if (/\.ya?ml$/i.test(name) && !sensitive(name))
            expanded.push(join(entry.path, name));
      } else {
        let output: string;
        if (entry.kind === "helm") {
          const release = options.release ?? "waypoint";
          if (!/^[a-z][a-z0-9-]{0,52}$/.test(release))
            throw Error("Invalid Helm release name.");
          const temp = await mkdtemp(join(tmpdir(), "waypoint-helm-"));
          try {
            const copied = new Set<string>();
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
                  return !ignored.has(basename(p)) && !sensitive(basename(p));
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
              ...process.env,
              KUBECONFIG: "/dev/null",
              HELM_CACHE_HOME: join(temp, "cache"),
              HELM_CONFIG_HOME: join(temp, "config"),
              HELM_DATA_HOME: join(temp, "data"),
              HELM_PLUGINS: join(temp, "plugins"),
            };
            const metadata = object(
              parseAllDocuments(
                await readFile(join(chart, "Chart.yaml"), "utf8"),
              )[0]?.toJS(),
            );
            if (
              Array.isArray(metadata.dependencies) &&
              metadata.dependencies.length
            )
              await run(
                process.env.WAYPOINT_HELM_BIN ?? "helm",
                ["dependency", "build", chart],
                { env, timeout: 120000 },
              );
            output = await run(
              process.env.WAYPOINT_HELM_BIN ?? "helm",
              [
                "template",
                release,
                chart,
                "--include-crds",
                ...(options.values ?? []).flatMap((v) => [
                  "--values",
                  resolve(root, v),
                ]),
              ],
              { env, timeout: 60000 },
            );
          } catch (e) {
            throw Error(
              `Helm rendering failed. Install Helm or resolve the reported chart dependency. Source files were not modified. ${(e as Error).message}`,
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
            if (sensitive(basename(actual)))
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
          output = await run("kubectl", ["kustomize", entry.path], {
            timeout: 60000,
            env: { ...process.env, KUBECONFIG: "/dev/null" },
          });
        }
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
    const safe = publicManifest(raw);
    notes.push(...safe.notes);
    if (safe.content)
      rendered.push({ id: randomUUID(), name: path, content: safe.content });
  }
  if (!rendered.length || rendered.length > 100)
    throw Error(
      "Choose an application containing 1–100 rendered manifest files.",
    );
  return { files: rendered, notes };
}
