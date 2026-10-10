export type ObjectMap = Record<string, unknown>;
export function object(value: unknown): ObjectMap {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as ObjectMap)
    : {};
}
export function at(value: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (v, key) => (Array.isArray(v) ? v[Number(key)] : object(v)[key]),
    value,
  );
}
export function list(value: unknown): ObjectMap[] {
  return Array.isArray(value) ? value.map(object) : [];
}
export function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
export type SourceFile = { id: string; name: string; content: string };
export type EvidenceRef = {
  fileId: string;
  document: number;
  path: string[];
  start: number;
  end: number;
  line: number;
  value: string;
};
export type Resource = {
  id: string;
  apiVersion: string;
  kind: string;
  name: string;
  namespace: string | null;
  scope: "namespace" | "cluster" | "unknown";
  raw: ObjectMap;
  source: EvidenceRef;
  refs: Record<string, EvidenceRef>;
  supported: boolean;
};
export type Diagnostic = { fileId: string; line: number; message: string };
export type Parsed = { resources: Resource[]; diagnostics: Diagnostic[] };
export type Relationship = {
  id: string;
  from: string;
  to: string | null;
  kind: "selects" | "owns" | "references" | "routes";
  status: "match" | "mismatch" | "unresolved";
  title: string;
  explanation: string;
  evidence: EvidenceRef[];
};
export type Analysis = {
  relationships: Relationship[];
  findings: Relationship[];
};
export type ScenarioId =
  "service-selector" | "configmap-key" | "readiness-path";
export type SessionState =
  | "preparing"
  | "ready"
  | "running"
  | "checking"
  | "completed"
  | "failed"
  | "resetting"
  | "stopped";
export type Check = {
  id: string;
  status: "pass" | "fail" | "pending" | "unavailable";
  explanation: string;
};
export type Observation = {
  sessionId: string;
  generation: number;
  revision: number;
  sequence: number;
  capturedAt: string;
  resources: ObjectMap[];
  errors: string[];
};
export type LabView = {
  id: string;
  scenario: ScenarioId;
  state: SessionState;
  phase: string;
  generation: number;
  revision: number;
  source: string;
  operation: string | null;
  error: string | null;
  observation: Observation | null;
  checks: Check[];
  startedAt: string;
  namespace: string;
};
export const resourceKey = (
  kind: string,
  ns: string | null,
  name: string,
  api = "v1",
) =>
  `${api.includes("/") ? api.split("/")[0] : "core"}/${kind}/${ns ?? "_"}/${name}`;
