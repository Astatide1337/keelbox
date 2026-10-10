import {
  at,
  list,
  text,
  type Resource,
  type Relationship,
  type Observation,
} from "./types";
import { capturedResource, type Snapshot } from "./snapshot";
export type ResourcePresentation = {
  label: string;
  tone: "healthy" | "warning" | "unknown";
  provenance: string;
};
export function resourceOrigin(resource: Resource, source: Snapshot) {
  if (source.files.some((f) => f.id === resource.source.fileId))
    return "Authored manifest";
  return list(at(resource.raw, "metadata", "ownerReferences")).some(
    (o) => o.controller === true,
  )
    ? "Controller-generated · captured"
    : "Captured API object";
}
export function resourcePresentation(
  r: Resource,
  observation: Observation | null,
  endpointsKnown = false,
): ResourcePresentation {
  const obs = observation?.resources.find(
    (o) =>
      o.kind === r.kind &&
      at(o, "metadata", "name") === r.name &&
      (at(o, "metadata", "namespace") ?? null) === r.namespace,
  );
  const provenance = obs ? "Displayed observation" : "Declared facts";
  if (r.kind === "Pod") {
    const ready = list(at(obs, "status", "conditions")).find(
      (c) => c.type === "Ready",
    );
    return {
      label: ready ? `Ready: ${ready.status}` : "Readiness unknown",
      tone:
        ready?.status === "True"
          ? "healthy"
          : ready?.status === "False"
            ? "warning"
            : "unknown",
      provenance,
    };
  }
  if (["Deployment", "ReplicaSet"].includes(r.kind)) {
    const ready = at(obs, "status", "readyReplicas"),
      desired =
        at(r.raw, "spec", "replicas") ??
        (r.kind === "Deployment" ? 1 : "Unknown");
    return {
      label:
        typeof ready === "number"
          ? `${ready} / ${desired} ready`
          : `${desired} replicas declared`,
      tone:
        typeof ready === "number"
          ? ready === desired
            ? "healthy"
            : "warning"
          : "unknown",
      provenance,
    };
  }
  if (r.kind === "Service") {
    if (!endpointsKnown)
      return { label: "Endpoints unknown", tone: "unknown", provenance };
    const n =
      observation?.resources
        .filter(
          (o) =>
            o.kind === "EndpointSlice" &&
            at(o, "metadata", "namespace") === r.namespace &&
            at(o, "metadata", "labels", "kubernetes.io/service-name") ===
              r.name,
        )
        .flatMap((o) => list(o.endpoints))
        .filter((e) => at(e, "conditions", "ready") === true).length ?? 0;
    return {
      label: `${n} ready endpoints`,
      tone: n ? "healthy" : "warning",
      provenance,
    };
  }
  return {
    label: obs ? "Captured fields" : "Declared",
    tone: "unknown",
    provenance,
  };
}
/** Service selectors target Pods when available; template matches remain evidence in the inspector. */
export function graphProjection(
  resources: Resource[],
  relationships: Relationship[],
  snapshot?: Snapshot,
): Relationship[] {
  const byId = new Map(resources.map((r) => [r.id, r]));
  const result = relationships.filter((e) => {
    if (e.kind === "owns") return false;
    const from = byId.get(e.from),
      to = e.to ? byId.get(e.to) : null;
    if (
      e.kind === "references" &&
      ["Pod", "ReplicaSet"].includes(from?.kind ?? "")
    )
      return false;
    if (
      e.kind === "selects" &&
      from?.kind === "Service" &&
      to?.kind !== "Pod"
    ) {
      return !resources.some(
        (r) => r.kind === "Pod" && r.namespace === from.namespace,
      );
    }
    return true;
  });
  for (const child of resources) {
    for (const ref of list(at(child.raw, "metadata", "ownerReferences"))) {
      if (ref.controller !== true || !text(ref.uid)) continue;
      const parent = resources.find(
        (r) =>
          r.namespace === child.namespace &&
          r.kind === ref.kind &&
          at(
            snapshot ? capturedResource(snapshot, r) : r.raw,
            "metadata",
            "uid",
          ) === ref.uid,
      );
      if (!parent) continue;
      const proof = child.refs["metadata.ownerReferences"] ?? child.source;
      result.push({
        id: `owner:${parent.id}:${child.id}`,
        from: parent.id,
        to: child.id,
        kind: "owns",
        status: "match",
        title: `${parent.kind} owns ${child.kind}`,
        explanation:
          "Inferred from the captured controller ownerReference UID, matched to the parent UID.",
        evidence: [proof],
      });
    }
  }
  return result;
}
