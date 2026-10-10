import { isMap, isSeq, LineCounter, parseAllDocuments, type Node } from "yaml";
import {
  at,
  object,
  resourceKey,
  text,
  type EvidenceRef,
  type Parsed,
  type Resource,
  type SourceFile,
} from "./types";
const clusterKinds = new Set([
  "Namespace",
  "Node",
  "ClusterRole",
  "ClusterRoleBinding",
  "CustomResourceDefinition",
  "PersistentVolume",
  "StorageClass",
]);
const namespacedKinds = new Set([
  "Pod",
  "Service",
  "Deployment",
  "ReplicaSet",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "ConfigMap",
  "Secret",
  "Ingress",
  "ServiceAccount",
  "Role",
  "RoleBinding",
  "PersistentVolumeClaim",
  "EndpointSlice",
  "Endpoints",
  "NetworkPolicy",
  "Route",
  "Application",
]);
const supportedKinds = new Set([
  "Pod",
  "Service",
  "Deployment",
  "ReplicaSet",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "ConfigMap",
  "Secret",
  "Ingress",
  "Namespace",
  "EndpointSlice",
  "Route",
  "Application",
]);
export function parseSources(
  files: SourceFile[],
  defaultNamespace = "default",
): Parsed {
  const result: Parsed = { resources: [], diagnostics: [] };
  const seen = new Set<string>();
  if (
    files.length > 100 ||
    files.reduce((n, f) => n + f.content.length, 0) > 2_000_000
  )
    return {
      resources: [],
      diagnostics: [
        {
          fileId: files[0]?.id ?? "",
          line: 1,
          message: "Import limit: 100 files / 2 MB.",
        },
      ],
    };
  for (const file of files) {
    const lines = new LineCounter();
    let docs;
    try {
      docs = parseAllDocuments(file.content, {
        lineCounter: lines,
        keepSourceTokens: true,
        uniqueKeys: true,
      });
    } catch (e) {
      result.diagnostics.push({ fileId: file.id, line: 1, message: String(e) });
      continue;
    }
    docs.forEach((doc, document) => {
      if (doc.errors.length) {
        for (const e of doc.errors)
          result.diagnostics.push({
            fileId: file.id,
            line: lines.linePos(e.pos[0]).line,
            message: e.message,
          });
        return;
      }
      let raw: unknown;
      try {
        raw = doc.toJS({ maxAliasCount: 25 });
      } catch (e) {
        result.diagnostics.push({
          fileId: file.id,
          line: 1,
          message: `Unsafe aliases: ${String(e)}`,
        });
        return;
      }
      if (raw == null) return;
      const refs: Record<string, EvidenceRef> = {};
      let tooDeep = false;
      function walk(node: unknown, path: string[], depth = 0) {
        if (depth > 60) {
          tooDeep = true;
          return;
        }
        const n = node as Node | null;
        if (!n) return;
        const range = n.range;
        if (range) {
          refs[path.join(".")] = {
            fileId: file.id,
            document,
            path,
            start: range[0],
            end: range[1],
            line: lines.linePos(range[0]).line,
            value: file.content.slice(range[0], range[1]),
          };
        }
        if (isMap(n)) {
          for (const pair of n.items)
            walk(pair.value, [...path, String(pair.key)], depth + 1);
        } else if (isSeq(n)) {
          n.items.forEach((v, i) => walk(v, [...path, String(i)], depth + 1));
        }
      }
      walk(doc.contents, []);
      if (tooDeep) {
        result.diagnostics.push({
          fileId: file.id,
          line: 1,
          message: "YAML nesting exceeds 60 levels.",
        });
        return;
      }
      function add(value: unknown, prefix: string[] = []) {
        const r = object(value);
        const kind = text(r.kind);
        if (kind === "List") {
          if (!Array.isArray(r.items)) {
            result.diagnostics.push({
              fileId: file.id,
              line: 1,
              message: "List.items must be an array.",
            });
            return;
          }
          r.items.forEach((v, i) => add(v, [...prefix, "items", String(i)]));
          return;
        }
        const name = text(at(r, "metadata", "name")),
          apiVersion = text(r.apiVersion);
        if (!kind || !name || !apiVersion) {
          result.diagnostics.push({
            fileId: file.id,
            line: refs[prefix.join(".")]?.line ?? 1,
            message: "Each resource needs apiVersion, kind and metadata.name.",
          });
          return;
        }
        const scope = clusterKinds.has(kind)
          ? "cluster"
          : namespacedKinds.has(kind)
            ? "namespace"
            : "unknown";
        const ns =
          scope === "cluster"
            ? null
            : text(at(r, "metadata", "namespace")) || defaultNamespace;
        const id = resourceKey(kind, ns, name, apiVersion);
        if (seen.has(id)) {
          result.diagnostics.push({
            fileId: file.id,
            line: 1,
            message: `Duplicate resource identity: ${kind}/${ns}/${name}.`,
          });
          return;
        }
        seen.add(id);
        const localRefs: Record<string, EvidenceRef> = {};
        for (const [key, ref] of Object.entries(refs)) {
          const root = prefix.join(".");
          if (!root || key === root || key.startsWith(root + "."))
            localRefs[key.slice(root ? root.length + 1 : 0)] = ref;
        }
        const source = refs[prefix.join(".")] ?? {
          fileId: file.id,
          document,
          path: prefix,
          start: 0,
          end: file.content.length,
          line: 1,
          value: "",
        };
        result.resources.push({
          id,
          apiVersion,
          kind,
          name,
          namespace: ns,
          scope,
          raw: r,
          source,
          refs: localRefs,
          supported: supportedKinds.has(kind),
        } as Resource);
      }
      add(raw);
    });
  }
  return result;
}
