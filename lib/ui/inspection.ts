import { at, list, object, text, type ObjectMap } from "../domain/types";
/** Remove API bookkeeping, never desired fields or meaningful defaulted live configuration. */
export function normalizedConfiguration(value: unknown): ObjectMap {
  const copy = structuredClone(object(value));
  delete copy.status;
  const metadata = object(copy.metadata);
  for (const key of [
    "uid",
    "resourceVersion",
    "generation",
    "creationTimestamp",
    "managedFields",
    "selfLink",
    "deletionTimestamp",
  ])
    delete metadata[key];
  const annotations = object(metadata.annotations);
  delete annotations["kubectl.kubernetes.io/last-applied-configuration"];
  if (Object.keys(annotations).length) metadata.annotations = annotations;
  else delete metadata.annotations;
  copy.metadata = metadata;
  return copy;
}
export type FieldDifference = {
  path: string;
  desired: unknown;
  observed: unknown;
};
export function configurationDifferences(
  desired: unknown,
  observed: unknown,
): FieldDifference[] {
  const differences: FieldDifference[] = [];
  function walk(a: unknown, b: unknown, path: string) {
    if (JSON.stringify(a) === JSON.stringify(b)) return;
    if (
      a &&
      b &&
      typeof a === "object" &&
      typeof b === "object" &&
      !Array.isArray(a) &&
      !Array.isArray(b)
    ) {
      for (const key of [
        ...new Set([...Object.keys(a), ...Object.keys(b)]),
      ].sort())
        walk(object(a)[key], object(b)[key], `${path}/${key}`);
    } else differences.push({ path, desired: a, observed: b });
  }
  walk(normalizedConfiguration(desired), normalizedConfiguration(observed), "");
  return differences;
}
export function resourceAge(raw: unknown, observedAt: string | null): string {
  const created = text(at(raw, "metadata", "creationTimestamp"));
  if (!created || !observedAt) return "Unknown";
  const delta = Date.parse(observedAt) - Date.parse(created);
  if (!Number.isFinite(delta) || delta < 0) return "Unknown";
  const minutes = Math.floor(delta / 60000);
  return minutes < 60
    ? `${minutes}m at observation`
    : `${Math.floor(minutes / 60)}h at observation`;
}
export function conditionSummary(raw: unknown) {
  return list(at(raw, "status", "conditions")).map(
    (c) =>
      `${text(c.type)}: ${text(c.status)}${c.reason ? ` · ${text(c.reason)}` : ""}`,
  );
}
