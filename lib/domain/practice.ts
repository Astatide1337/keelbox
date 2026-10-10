import { fixtureObjects } from "./scenarios";
import { parseSources } from "./importer";
import { at, object, type ObjectMap, type ScenarioId } from "./types";
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(object(value))
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value) ?? "null";
}
export function validateRepair(
  source: string,
  scenario: ScenarioId,
  namespace: string,
): ObjectMap[] {
  const parsed = parseSources(
    [{ id: "lesson", name: "lesson.yaml", content: source }],
    namespace,
  );
  if (parsed.diagnostics.length)
    throw new Error(
      parsed.diagnostics.map((d) => `Line ${d.line}: ${d.message}`).join("\n"),
    );
  if (parsed.resources.length !== 3)
    throw new Error(
      "Keep the three required lesson resources. Deletion and extra resources are not allowed.",
    );
  const proposed = parsed.resources.map((r) => structuredClone(r.raw));
  const baseline = fixtureObjects(scenario, namespace, false);
  for (const o of proposed) {
    const ref = baseline.find(
      (b) =>
        b.kind === o.kind &&
        at(b, "metadata", "name") === at(o, "metadata", "name"),
    );
    if (!ref)
      throw new Error("Only the owned lesson resources may be changed.");
    if (scenario === "service-selector" && o.kind === "Service") {
      const v = at(o, "spec", "selector", "app");
      if (typeof v !== "string" || v.length > 63)
        throw new Error("Service selector must be a label string.");
      object(at(o, "spec", "selector")).app = "web";
    }
    if (scenario === "configmap-key" && o.kind === "ConfigMap") {
      const v = at(o, "data", "HEALTH_TOKEN");
      if (v !== undefined && (typeof v !== "string" || v.length > 100))
        throw new Error("HEALTH_TOKEN must be a short string.");
      object(o.data).HEALTH_TOKEN = "lesson-ready";
    }
    if (scenario === "readiness-path" && o.kind === "Deployment") {
      const containers = at(o, "spec", "template", "spec", "containers");
      const c = Array.isArray(containers) ? containers[0] : null;
      const v = at(c, "readinessProbe", "httpGet", "path");
      if (typeof v !== "string" || !v.startsWith("/") || v.length > 100)
        throw new Error("Readiness path must be an HTTP path.");
      object(at(c, "readinessProbe", "httpGet")).path = "/healthz";
    }
    if (canonical(o) !== canonical(ref))
      throw new Error(
        "This lesson only allows its repair field. Keep replicas, images, ports, required configuration, probe and namespace unchanged.",
      );
  }
  return parsed.resources.map((r) => r.raw);
}
export function semanticChecks(objects: ObjectMap[], scenario: ScenarioId) {
  const service = objects.find((o) => o.kind === "Service"),
    deployment = objects.find((o) => o.kind === "Deployment"),
    config = objects.find((o) => o.kind === "ConfigMap");
  const containers = at(deployment, "spec", "template", "spec", "containers");
  const container = Array.isArray(containers) ? containers[0] : null;
  return [
    {
      id: "required-resources",
      status: "pass" as const,
      explanation:
        "All required resources and two intended replicas are preserved.",
    },
    {
      id: "repair",
      status: (
        scenario === "service-selector"
          ? at(service, "spec", "selector", "app") === "web"
          : scenario === "configmap-key"
            ? at(config, "data", "HEALTH_TOKEN") === "lesson-ready"
            : at(container, "readinessProbe", "httpGet", "path") === "/healthz"
      )
        ? ("pass" as const)
        : ("fail" as const),
      explanation:
        scenario === "service-selector"
          ? "Service selector must select app: web."
          : scenario === "configmap-key"
            ? "HEALTH_TOKEN must be lesson-ready; its required reference stays intact."
            : "Readiness probe must request the served /healthz path on port 8080.",
    },
  ];
}

export function matchesExpected(expected: unknown, actual: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) => matchesExpected(v, actual[i]))
    );
  if (expected !== null && typeof expected === "object")
    return (
      actual !== null &&
      typeof actual === "object" &&
      Object.entries(object(expected)).every(([key, value]) =>
        matchesExpected(value, object(actual)[key]),
      )
    );
  return expected === actual;
}
