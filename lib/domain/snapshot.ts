import { z } from "zod";
import { stringify } from "yaml";
import { parseSources } from "./importer";
import type { RenderProvenance } from "../server/repository-import";
const renderProvenanceSchema = z
  .object({
    path: z.string().max(500),
    renderer: z.enum(["yaml", "helm", "kustomize"]),
    version: z.string().max(300),
    namespace: z.string().max(253).optional(),
    release: z.string().max(253).optional(),
    kubernetesVersion: z.string().max(100).optional(),
    apiVersions: z.array(z.string().max(200)).max(100).optional(),
    parameters: z
      .array(
        z
          .object({
            name: z.string().max(200),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            forceString: z.boolean(),
          })
          .strict(),
      )
      .max(100)
      .optional(),
    values: z
      .array(
        z.object({
          path: z.string().max(500),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
          repository: z.string().max(1000).optional(),
          ref: z.string().max(200).optional(),
        }),
      )
      .max(100),
    lockfiles: z
      .array(
        z.object({
          path: z.string().max(500),
          sha256: z.string().regex(/^[a-f0-9]{64}$/),
        }),
      )
      .max(100),
    sourceMappings: z.array(z.string().max(1000)).max(1000),
    repository: z.string().max(1000).optional(),
    ref: z.string().max(200).optional(),
  })
  .strict();
import {
  at,
  list,
  object,
  resourceKey,
  text,
  type ObjectMap,
  type SourceFile,
  type Resource,
} from "./types";
const sourceSchema = z.object({
  id: z.string().max(200),
  name: z.string().max(500),
  content: z.string().max(2_000_000),
});
const coverageSchema = z.object({
  kind: z.string(),
  namespace: z.string(),
  state: z.enum(["captured", "omitted", "forbidden", "failed"]),
  capturedAt: z.string(),
  reason: z.string().optional(),
});
export type Coverage = z.infer<typeof coverageSchema>;
export type EndpointContract = {
  deployment: string;
  namespace: string;
  container: string;
  path: string;
  port: number;
  responseBody?: string;
  gateway?: {
    deployment: string;
    backendService: string;
    unavailableStatus: 503;
    healthyStatus: 200;
  };
};
export type Snapshot = {
  format: "playground-snapshot-v2";
  id: string;
  label: string;
  origin: "captured" | "bundled" | "manifests";
  captureStartedAt: string | null;
  captureEndedAt: string | null;
  resources: ObjectMap[];
  files: SourceFile[];
  coverage: Coverage[];
  errors: string[];
  contracts: EndpointContract[];
  renderProvenance?: RenderProvenance[];
};
export type Evidence =
  | {
      kind: "declared";
      fileId: string;
      path: string[];
      start: number;
      end: number;
    }
  | {
      kind: "captured";
      captureId: string;
      uid: string;
      pointer: string;
      observedAt: string | null;
    }
  | { kind: "inferred"; rule: string; inputs: Evidence[] }
  | {
      kind: "synthetic";
      exerciseId: string;
      revision: number;
      modelTime: number;
      rule: string;
    };
const snapshotSchema = z.object({
  renderProvenance: z.array(renderProvenanceSchema).max(100).optional(),
  format: z.literal("playground-snapshot-v2"),
  id: z.string().max(200),
  label: z.string().max(200),
  origin: z.enum(["captured", "bundled", "manifests"]),
  captureStartedAt: z.string().datetime().nullable(),
  captureEndedAt: z.string().datetime().nullable(),
  resources: z.array(z.record(z.string(), z.unknown())).max(1000),
  files: z.array(sourceSchema).max(100),
  coverage: z.array(coverageSchema).max(1000),
  errors: z.array(z.string().max(1000)).max(1000),
  contracts: z
    .array(
      z.object({
        deployment: z.string(),
        namespace: z.string(),
        container: z.string(),
        path: z.string().startsWith("/"),
        port: z.number().int().min(1).max(65535),
        responseBody: z.string().optional(),
        gateway: z
          .object({
            deployment: z.string(),
            backendService: z.string(),
            unavailableStatus: z.literal(503),
            healthyStatus: z.literal(200),
          })
          .optional(),
      }),
    )
    .max(100),
});
export function freezeSnapshot(snapshot: Snapshot): Snapshot {
  function freeze(v: unknown) {
    if (v && typeof v === "object") {
      for (const child of Object.values(v)) freeze(child);
      Object.freeze(v);
    }
  }
  freeze(snapshot);
  return snapshot;
}
export function snapshotDigest(snapshot: Snapshot): string {
  // stable identity; integrity guard, not a security signature
  const s = JSON.stringify(snapshot);
  let h = 2166136261;
  for (let i = 0; i < s.length; i++)
    h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16) + ":" + s.length;
}
function containsSecret(resource: ObjectMap): boolean {
  return (
    resource.kind === "Secret" || list(resource.items).some(containsSecret)
  );
}
function hasSecretPayload(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(hasSecretPayload);
  const v = object(value);
  return (
    (v.kind === "Secret" &&
      (v.data !== undefined || v.stringData !== undefined)) ||
    Object.values(v).some(hasSecretPayload)
  );
}
export function importSnapshot(content: string): Snapshot {
  if (content.length > 2_000_000) throw Error("Snapshot exceeds 2 MB.");
  let input = object(JSON.parse(content));
  if (input.format === "playground-snapshot-v1") {
    const timestamp = text(input.capturedAt);
    if (!Number.isFinite(Date.parse(timestamp)))
      throw Error("Invalid capture timestamp.");
    input = {
      format: "playground-snapshot-v2",
      id: crypto.randomUUID(),
      label: text(input.context) || "Imported snapshot",
      origin: "captured",
      captureStartedAt: timestamp,
      captureEndedAt: timestamp,
      resources: list(input.items),
      files: [],
      coverage: [],
      errors: [
        "Legacy v1 capture: probe, owner, container and endpoint fields may be omitted. Coverage is unknown.",
        ...list(input.errors).map(
          (e) => `${e.kind}/${e.namespace}: ${e.error}`,
        ),
      ],
      contracts: [],
    };
  }
  const result = snapshotSchema.parse(input);
  if (result.resources.some(containsSecret))
    throw Error("Snapshots must not contain Secret resources.");
  const authored = parseSources(result.files);
  if (authored.diagnostics.length)
    throw Error("Snapshot authored files contain invalid YAML.");
  if (
    authored.resources.some(
      (r) =>
        hasSecretPayload(r.raw) ||
        (result.origin !== "manifests" && containsSecret(r.raw)),
    )
  )
    throw Error("Snapshot authored files must not contain Secret values.");
  const captured = parseSources(capturedFiles(result));
  if (captured.resources.some((r) => r.kind === "Secret"))
    throw Error("Snapshots must not contain Secret resources.");
  if (captured.diagnostics.length)
    throw Error("Captured resources have invalid or duplicate identities.");
  return freezeSnapshot(result);
}
export function manifestProject(files: SourceFile[]): Snapshot {
  return freezeSnapshot({
    format: "playground-snapshot-v2",
    id: crypto.randomUUID(),
    label: files[0]?.name ?? "Imported manifests",
    origin: "manifests",
    captureStartedAt: null,
    captureEndedAt: null,
    resources: [],
    files: structuredClone(files),
    coverage: [],
    errors: [],
    contracts: [],
  });
}
export function capturedFiles(snapshot: Snapshot): SourceFile[] {
  return snapshot.resources.map((r, i) => ({
    id: `capture:${i}`,
    name: `Captured API object / ${r.kind}/${text(at(r, "metadata", "name"))}`,
    content: stringify(r),
  }));
}
export function projectResources(
  snapshot: Snapshot,
  files = snapshot.files,
): Resource[] {
  const authored = parseSources(files).resources;
  const seen = new Set(authored.map((r) => r.id));
  return [
    ...authored,
    ...parseSources(capturedFiles(snapshot)).resources.filter(
      (r) => !seen.has(r.id),
    ),
  ];
}
export function capturedResource(snapshot: Snapshot, r: Resource) {
  return snapshot.resources.find(
    (o) =>
      resourceKey(
        text(o.kind),
        text(at(o, "metadata", "namespace")) || null,
        text(at(o, "metadata", "name")),
        text(o.apiVersion),
      ) === r.id,
  );
}
export function coverage(
  snapshot: Snapshot,
  kind: string,
  namespace: string | null,
) {
  return snapshot.coverage.find(
    (c) => c.kind === kind && c.namespace === (namespace ?? ""),
  );
}
