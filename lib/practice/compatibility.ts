import { at, list, text, object } from "../domain/types";
import {
  projectResources,
  coverage,
  type Snapshot,
  type EndpointContract,
} from "../domain/snapshot";
import type { Compatibility, IncidentId } from "./types";
export function compatibility(
  snapshot: Snapshot,
  scenario: IncidentId,
  contract?: EndpointContract,
): Compatibility {
  const reasons: string[] = [];
  const endpoint = contract ?? snapshot.contracts[0];
  if (!endpoint)
    return {
      supported: false,
      reasons: [
        "No supported healthy HTTP endpoint contract. Provide a reviewed endpoint contract or explicitly use the bundled example.",
      ],
    };
  const rs = projectResources(snapshot);
  const deployment = rs.find(
    (r) =>
      r.kind === "Deployment" &&
      r.name === endpoint.deployment &&
      r.namespace === endpoint.namespace,
  );
  if (!deployment)
    return {
      supported: false,
      reasons: ["The contracted Deployment is missing."],
    };
  const c = list(
    at(deployment.raw, "spec", "template", "spec", "containers"),
  ).find((c) => c.name === endpoint.container);
  const replicas = at(deployment.raw, "spec", "replicas");
  if (typeof replicas !== "number" || replicas < 1)
    reasons.push("The intended nonzero replica count must be declared.");
  if (!c) reasons.push("The contracted container is missing.");
  const probe = object(
    c?.[scenario === "liveness" ? "livenessProbe" : "readinessProbe"],
  );
  if (
    !Object.keys(probe).length ||
    !at(probe, "httpGet", "path") ||
    at(probe, "httpGet", "port") !== endpoint.port
  )
    reasons.push("A supported HTTP probe on the contracted port is required.");
  if (
    list(at(deployment.raw, "spec", "template", "spec", "containers"))
      .length !== 1
  )
    reasons.push(
      "Multi-container workloads are outside this bounded exercise.",
    );
  if (
    at(deployment.raw, "spec", "template", "spec", "restartPolicy") &&
    at(deployment.raw, "spec", "template", "spec", "restartPolicy") !== "Always"
  )
    reasons.push("The workload must use restartPolicy Always.");
  if (at(probe, "httpGet", "path") !== endpoint.path)
    reasons.push(
      "The baseline probe must use the known healthy endpoint before injecting this incident.",
    );
  for (const key of [
    "periodSeconds",
    "timeoutSeconds",
    "failureThreshold",
    "successThreshold",
  ]) {
    const value = probe[key];
    if (
      value !== undefined &&
      (!Number.isInteger(value) || Number(value) < 1 || Number(value) > 60)
    )
      reasons.push(
        `Unsupported probe ${key}; use a positive integer up to 60.`,
      );
  }
  if (
    scenario === "liveness" &&
    probe.successThreshold !== undefined &&
    probe.successThreshold !== 1
  )
    reasons.push("Liveness successThreshold must be 1.");
  if (scenario === "liveness") {
    const readiness = object(c?.readinessProbe);
    if (
      at(readiness, "httpGet", "path") !== endpoint.path ||
      at(readiness, "httpGet", "port") !== endpoint.port
    )
      reasons.push(
        "Liveness practice requires a healthy supported readiness probe to remain configured.",
      );
  }
  for (const env of list(c?.env)) {
    const ref = object(at(env, "valueFrom", "configMapKeyRef"));
    if (Object.keys(ref).length && ref.optional !== true) {
      const config = rs.find(
        (r) =>
          r.kind === "ConfigMap" &&
          r.name === ref.name &&
          r.namespace === endpoint.namespace,
      );
      if (
        !config ||
        !(
          Object.prototype.hasOwnProperty.call(
            object(config.raw.data),
            String(ref.key),
          ) ||
          (Array.isArray(config.raw.configurationKeys) &&
            config.raw.configurationKeys.includes(ref.key))
        )
      )
        reasons.push(
          `Required ConfigMap key ${ref.name}/${ref.key} is unavailable.`,
        );
    }
    if (at(env, "valueFrom", "secretKeyRef"))
      reasons.push(
        "Required Secret dependencies are outside this bounded capture; no credentials are imported.",
      );
  }
  for (const volume of list(
    at(deployment.raw, "spec", "template", "spec", "volumes"),
  )) {
    const ref = object(volume.configMap);
    if (
      Object.keys(ref).length &&
      ref.optional !== true &&
      !rs.some(
        (r) =>
          r.kind === "ConfigMap" &&
          r.name === ref.name &&
          r.namespace === endpoint.namespace,
      )
    )
      reasons.push(`Required ConfigMap ${ref.name} is unavailable.`);
    if (volume.secret)
      reasons.push(
        "Secret-mounted workloads are outside this bounded capture.",
      );
  }
  if (c?.startupProbe)
    reasons.push(
      "Startup-probe interactions are outside this bounded exercise.",
    );
  const service = rs.find(
    (r) =>
      r.kind === "Service" &&
      r.namespace === endpoint.namespace &&
      (scenario !== "http503" || r.name === endpoint.gateway?.backendService) &&
      Object.entries(object(at(r.raw, "spec", "selector"))).length > 0 &&
      Object.entries(object(at(r.raw, "spec", "selector"))).every(
        ([k, v]) =>
          at(deployment.raw, "spec", "template", "metadata", "labels", k) === v,
      ),
  );
  if (
    service &&
    !list(at(service.raw, "spec", "ports")).some(
      (p) =>
        p.targetPort === endpoint.port ||
        list(c?.ports).some(
          (cp) =>
            cp.name === p.targetPort && cp.containerPort === endpoint.port,
        ),
    )
  )
    reasons.push("The Service must route to the contracted container port.");
  if (!service)
    reasons.push(
      "A selector-based Service targeting the intended workload is required.",
    );
  const depUid = text(
    at(
      snapshot.resources.find(
        (r) =>
          r.kind === "Deployment" &&
          at(r, "metadata", "name") === deployment.name &&
          at(r, "metadata", "namespace") === deployment.namespace,
      ),
      "metadata",
      "uid",
    ),
  );
  const replicaSets = snapshot.resources.filter(
    (r) =>
      r.kind === "ReplicaSet" &&
      at(r, "metadata", "namespace") === endpoint.namespace &&
      list(at(r, "metadata", "ownerReferences")).some(
        (o) => o.uid === depUid && o.controller === true,
      ),
  );
  const podUids = snapshot.resources
    .filter(
      (r) =>
        r.kind === "Pod" &&
        at(r, "metadata", "namespace") === endpoint.namespace &&
        list(at(r, "metadata", "ownerReferences")).some(
          (o) =>
            replicaSets.some((rs) => at(rs, "metadata", "uid") === o.uid) &&
            o.controller === true,
        ),
    )
    .map((r) => text(at(r, "metadata", "uid")))
    .filter(Boolean);
  if (!depUid || podUids.length !== replicas)
    reasons.push(
      "Capture the exact intended Pods and their UID controller chain (Deployment → ReplicaSet → Pod).",
    );
  const pods = snapshot.resources.filter((r) =>
    podUids.includes(text(at(r, "metadata", "uid"))),
  );
  if (
    pods.some(
      (p) =>
        !list(at(p, "status", "conditions")).some((c) => c.type === "Ready") ||
        !list(at(p, "status", "containerStatuses")).some(
          (c) =>
            c.name === endpoint.container &&
            typeof c.ready === "boolean" &&
            typeof c.restartCount === "number",
        ),
    )
  )
    reasons.push(
      "Pod Ready conditions and container readiness/restart counts are unavailable.",
    );
  if (
    pods.some(
      (p) =>
        !list(at(p, "status", "conditions")).some(
          (c) => c.type === "Ready" && c.status === "True",
        ) ||
        !list(at(p, "status", "containerStatuses")).some(
          (c) => c.name === endpoint.container && c.ready === true,
        ),
    )
  )
    reasons.push(
      "This bounded incident requires a baseline with captured ready Pods; existing unhealthy state needs a different investigation.",
    );
  const slices = snapshot.resources.filter(
    (r) =>
      r.kind === "EndpointSlice" &&
      at(r, "metadata", "namespace") === endpoint.namespace &&
      at(r, "metadata", "labels", "kubernetes.io/service-name") ===
        service?.name,
  );
  const readyUids = slices
    .flatMap((s) => list(s.endpoints))
    .filter((e) => at(e, "conditions", "ready") === true)
    .map((e) => text(at(e, "targetRef", "uid")));
  if (!slices.length || podUids.some((uid) => !readyUids.includes(uid)))
    reasons.push(
      "Capture ready EndpointSlice target UIDs for each intended baseline Pod.",
    );
  if (
    coverage(snapshot, "EndpointSlice", endpoint.namespace)?.state !==
    "captured"
  )
    reasons.push(
      "EndpointSlice coverage is unavailable; missing reads are not zero endpoints.",
    );
  if (scenario === "http503" && !endpoint.gateway)
    reasons.push(
      "HTTP 503 requires an explicit supported gateway fallback contract; a Service alone does not produce this diagnosis.",
    );
  if (
    scenario === "http503" &&
    endpoint.gateway &&
    !rs.some(
      (r) =>
        r.kind === "Deployment" &&
        r.name === endpoint.gateway!.deployment &&
        r.namespace === endpoint.namespace,
    )
  )
    reasons.push("The contracted gateway Deployment is missing.");
  return reasons.length
    ? { supported: false, reasons }
    : {
        supported: true,
        targets: {
          deployment: deployment.id,
          service: service!.id,
          podUids,
          container: endpoint.container,
          namespace: endpoint.namespace,
          contract: endpoint,
        },
      };
}
