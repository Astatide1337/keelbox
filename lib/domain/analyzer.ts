import { podDependencies, secretKeyMetadata } from "./dependencies";
import {
  at,
  list,
  object,
  text,
  type Analysis,
  type EvidenceRef,
  type Relationship,
  type Resource,
  type ObjectMap,
} from "./types";
function proof(r: Resource, path: string): EvidenceRef {
  return r.refs[path] ?? r.source;
}
export function podSpec(r: Resource) {
  return r.kind === "Pod"
    ? object(r.raw.spec)
    : r.kind === "CronJob"
      ? object(at(r.raw, "spec", "jobTemplate", "spec", "template", "spec"))
      : object(at(r.raw, "spec", "template", "spec"));
}
export function podLabels(r: Resource) {
  return r.kind === "Pod"
    ? object(at(r.raw, "metadata", "labels"))
    : r.kind === "CronJob"
      ? object(
          at(
            r.raw,
            "spec",
            "jobTemplate",
            "spec",
            "template",
            "metadata",
            "labels",
          ),
        )
      : object(at(r.raw, "spec", "template", "metadata", "labels"));
}
export function analyze(
  resources: Resource[],
  observed: ObjectMap[] = [],
): Analysis {
  const uid = (r: Resource) =>
    at(r.raw, "metadata", "uid") ??
    at(
      observed.find(
        (o) =>
          o.kind === r.kind &&
          at(o, "metadata", "name") === r.name &&
          at(o, "metadata", "namespace") === r.namespace,
      ),
      "metadata",
      "uid",
    );
  const relationships: Relationship[] = [];
  const workloads = resources.filter((r) =>
    [
      "Pod",
      "Deployment",
      "StatefulSet",
      "DaemonSet",
      "ReplicaSet",
      "Job",
      "CronJob",
    ].includes(r.kind),
  );
  function push(
    from: Resource,
    to: Resource | null,
    kind: Relationship["kind"],
    status: Relationship["status"],
    title: string,
    explanation: string,
    evidence: EvidenceRef[],
    identity?: string,
  ) {
    const id = `${from.id}:${kind}:${to?.id ?? identity ?? title}:${title}`;
    const existing = relationships.find((e) => e.id === id);
    if (existing) {
      existing.evidence.push(
        ...evidence.filter(
          (ref) =>
            !existing.evidence.some(
              (old) => old.fileId === ref.fileId && old.start === ref.start,
            ),
        ),
      );
      return;
    }
    relationships.push({
      id,
      from: from.id,
      to: to?.id ?? null,
      kind,
      status,
      title,
      explanation,
      evidence,
    });
  }
  for (const r of resources) {
    if (r.kind === "Service") {
      const selector = object(at(r.raw, "spec", "selector"));
      if (!Object.keys(selector).length) {
        push(
          r,
          null,
          "selects",
          "unresolved",
          "No selector",
          "This Service has no selector. Manually managed endpoints or an ExternalName cannot be established from workload labels.",
          [proof(r, "spec")],
        );
        continue;
      }
      const same = workloads.filter((w) => w.namespace === r.namespace);
      const matched = same.filter((w) =>
        Object.entries(selector).every(([k, v]) => podLabels(w)[k] === v),
      );
      if (matched.length) {
        for (const w of matched)
          push(
            r,
            w,
            "selects",
            "match",
            "Selects workload",
            "Every selector key matches the workload’s Pod labels in the same namespace. Actual readiness and routing require cluster evidence.",
            [
              proof(r, "spec.selector"),
              proof(
                w,
                w.kind === "Pod"
                  ? "metadata.labels"
                  : "spec.template.metadata.labels",
              ),
            ],
          );
      } else {
        const likely = same.filter(
          (w) =>
            w.name === r.name ||
            Object.keys(selector).some((k) => k in podLabels(w)),
        );
        if (likely.length)
          for (const w of likely)
            push(
              r,
              w,
              "selects",
              "mismatch",
              "Selector mismatch",
              "No imported Pod or Pod template satisfies every selector field. Compare these labels; missing imported workloads may still exist in a cluster.",
              [
                proof(r, "spec.selector"),
                proof(
                  w,
                  w.kind === "Pod"
                    ? "metadata.labels"
                    : "spec.template.metadata.labels",
                ),
              ],
            );
        else
          push(
            r,
            null,
            "selects",
            "unresolved",
            "Workload not imported",
            "No matching workload is present in these files. This is not proof that the cluster has no matching Pods.",
            [proof(r, "spec.selector")],
          );
      }
    }
    if (workloads.includes(r)) {
      const spec = podSpec(r);
      const prefix =
        r.kind === "Pod"
          ? "spec"
          : r.kind === "CronJob"
            ? "spec.jobTemplate.spec.template.spec"
            : "spec.template.spec";
      for (const dependency of podDependencies(spec)) {
        const target =
          resources.find(
            (t) =>
              t.kind === dependency.kind &&
              t.name === dependency.name &&
              t.namespace === r.namespace,
          ) ?? null;
        const availableKeys = target
          ? dependency.kind === "Secret"
            ? secretKeyMetadata(target.raw)
            : [
                ...Object.keys(object(target.raw.data)),
                ...Object.keys(object(target.raw.binaryData)),
              ]
          : [];
        const keysKnown =
          target &&
          (dependency.kind !== "Secret" ||
            at(
              target.raw,
              "metadata",
              "annotations",
              "waypoint.dev/secret-keys",
            ) !== undefined ||
            target.raw.data !== undefined ||
            target.raw.stringData !== undefined);
        const missingKeys = keysKnown
          ? dependency.keys.filter((key) => !availableKeys.includes(key))
          : [];
        const requiredMissing =
          !dependency.optional && (!target || !!missingKeys.length);
        push(
          r,
          target,
          "references",
          dependency.optional
            ? "match"
            : !target || (dependency.keys.length && !keysKnown)
              ? "unresolved"
              : missingKeys.length
                ? "mismatch"
                : "match",
          dependency.optional
            ? `Optional ${dependency.kind} reference`
            : missingKeys.length
              ? `Missing ${dependency.kind} key: ${missingKeys.join(", ")}`
              : `${dependency.kind} reference`,
          dependency.optional
            ? "Optional dependency may be absent; its absence does not prevent Pod startup."
            : !target
              ? "Required dependency was not included. Cluster presence is unknown."
              : dependency.keys.length && !keysKnown
                ? "Secret values were removed and key metadata is unavailable. Key presence is unknown."
                : requiredMissing
                  ? "The required item key is absent from the imported configuration."
                  : "The dependency is declared; runtime behavior is separate evidence.",
          [
            proof(r, `${prefix}.${dependency.path}`),
            ...(target
              ? [
                  proof(
                    target,
                    dependency.kind === "Secret"
                      ? "metadata.annotations.waypoint.dev/secret-keys"
                      : "data",
                  ),
                ]
              : []),
          ],
          dependency.name,
        );
      }
    }
    if (r.kind === "Ingress" || r.kind === "Route") {
      const names =
        r.kind === "Route"
          ? [text(at(r.raw, "spec", "to", "name"))]
          : list(at(r.raw, "spec", "rules")).flatMap((rule) =>
              list(at(rule, "http", "paths")).map((p) =>
                text(at(p, "backend", "service", "name")),
              ),
            );
      const defaultName = text(
        at(r.raw, "spec", "defaultBackend", "service", "name"),
      );
      if (defaultName) names.push(defaultName);
      for (const name of new Set(names.filter(Boolean))) {
        const target =
          resources.find(
            (t) =>
              t.kind === "Service" &&
              t.namespace === r.namespace &&
              t.name === name,
          ) ?? null;
        push(
          r,
          target,
          "routes",
          target ? "match" : "unresolved",
          "Routes to Service",
          target
            ? "Named backend Service is present; ingress/route controller behavior is not observed."
            : "Named backend is missing from the import.",
          [proof(r, "spec"), ...(target ? [target.source] : [])],
        );
      }
    }
    for (const owner of list(at(r.raw, "metadata", "ownerReferences"))) {
      const target =
        resources.find(
          (t) =>
            t.namespace === r.namespace &&
            t.kind === owner.kind &&
            text(owner.uid) &&
            uid(t) === owner.uid,
        ) ?? null;
      if (target)
        push(
          target,
          r,
          "owns",
          "match",
          "Controller ownership",
          "Observed ownerReference UID matches the parent UID.",
          [proof(r, "metadata.ownerReferences")],
        );
      else
        push(
          r,
          null,
          "owns",
          "unresolved",
          "Unresolved owner UID",
          "The referenced parent UID is not present; name equality is not ownership proof.",
          [proof(r, "metadata.ownerReferences")],
        );
    }
    if (r.kind === "EndpointSlice") {
      const name = text(
        at(r.raw, "metadata", "labels", "kubernetes.io/service-name"),
      );
      const service =
        resources.find(
          (t) =>
            t.kind === "Service" &&
            t.namespace === r.namespace &&
            t.name === name,
        ) ?? null;
      if (service)
        push(
          service,
          r,
          "references",
          "match",
          "EndpointSlice association",
          "Observed kubernetes.io/service-name label associates this slice with the Service.",
          [proof(r, "metadata.labels")],
        );
      for (const endpoint of list(r.raw.endpoints)) {
        const ref = object(endpoint.targetRef),
          pod =
            resources.find(
              (t) =>
                t.kind === ref.kind &&
                t.namespace === r.namespace &&
                text(ref.uid) &&
                uid(t) === ref.uid,
            ) ?? null;
        const ready = at(endpoint, "conditions", "ready"),
          terminating = at(endpoint, "conditions", "terminating");
        push(
          r,
          pod,
          "references",
          !pod || typeof ready !== "boolean"
            ? "unresolved"
            : ready && terminating !== true
              ? "match"
              : "mismatch",
          "Endpoint target",
          `Endpoint ready=${String(ready ?? "unknown")}, terminating=${String(terminating ?? "unknown")}; UID target association. This does not prove HTTP traffic.`,
          [proof(r, "endpoints")],
        );
      }
    }
  }
  return {
    relationships,
    findings: relationships.filter((e) => e.status !== "match"),
  };
}
