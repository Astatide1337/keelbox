import {
  at,
  list,
  object,
  text,
  type Analysis,
  type EvidenceRef,
  type Relationship,
  type Resource,
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
export function analyze(resources: Resource[]): Analysis {
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
  ) {
    const id = `${from.id}:${kind}:${to?.id ?? title}:${title}`;
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
      function reference(
        kind: string,
        name: string,
        key: string | undefined,
        path: string,
      ) {
        if (!name) return;
        const target =
          resources.find(
            (t) =>
              t.kind === kind && t.name === name && t.namespace === r.namespace,
          ) ?? null;
        const missing =
          target &&
          key !== undefined &&
          !(key in object(target.raw.data)) &&
          !(key in object(target.raw.binaryData));
        push(
          r,
          target,
          "references",
          !target ? "unresolved" : missing ? "mismatch" : "match",
          missing ? `Missing ${kind} key: ${key}` : `${kind} reference`,
          !target
            ? "Referenced resource is not in this import."
            : missing
              ? "The required referenced key is absent from this manifest."
              : "The named dependency is present. Runtime behavior remains unobserved.",
          [proof(r, path), ...(target ? [proof(target, "data")] : [])],
        );
      }
      list(spec.containers).forEach((c, i) => {
        list(c.env).forEach((env, j) => {
          for (const [field, kind] of [
            ["configMapKeyRef", "ConfigMap"],
            ["secretKeyRef", "Secret"],
          ]) {
            const ref = object(at(env, "valueFrom", field));
            reference(
              kind,
              text(ref.name),
              text(ref.key) || undefined,
              `${prefix}.containers.${i}.env.${j}.valueFrom.${field}`,
            );
          }
        });
        list(c.envFrom).forEach((env, j) => {
          for (const [field, kind] of [
            ["configMapRef", "ConfigMap"],
            ["secretRef", "Secret"],
          ])
            reference(
              kind,
              text(at(env, field, "name")),
              undefined,
              `${prefix}.containers.${i}.envFrom.${j}.${field}`,
            );
        });
      });
      list(spec.volumes).forEach((v, i) => {
        reference(
          "ConfigMap",
          text(at(v, "configMap", "name")),
          undefined,
          `${prefix}.volumes.${i}.configMap`,
        );
        reference(
          "Secret",
          text(at(v, "secret", "secretName")),
          undefined,
          `${prefix}.volumes.${i}.secret`,
        );
      });
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
            t.kind === owner.kind &&
            t.name === owner.name &&
            t.namespace === r.namespace,
        ) ?? null;
      push(
        r,
        target,
        "owns",
        target ? "match" : "unresolved",
        "Owner reference",
        "Recorded ownerReference; actual UID ownership needs observed objects.",
        [proof(r, "metadata.ownerReferences")],
      );
    }
  }
  return {
    relationships,
    findings: relationships.filter((e) => e.status !== "match"),
  };
}
