import { at, list, object, text } from "./types";
import type { DeploymentPlan, HttpContract } from "./deployment-plan";

export const LIVE_INCIDENT_IDS = [
  "readiness",
  "liveness",
  "service-selector",
  "service-target-port",
  "image-pull",
  "configmap-key",
  "market-data-stale",
] as const;
export type LiveIncidentId = (typeof LIVE_INCIDENT_IDS)[number];

export type LiveIncidentChoice = {
  id: LiveIncidentId;
  title: string;
  objective: string;
  operation: string;
  repair: string;
  hints: [string, string, string];
};

const copy: Record<LiveIncidentId, Omit<LiveIncidentChoice, "id">> = {
  readiness: {
    title: "Readiness probe failure",
    objective:
      "Explain why a running container is excluded from traffic and restore its readiness contract.",
    operation:
      "Waypoint changes only the selected HTTP readiness path to a lab-only missing path.",
    repair:
      "Reapply the reviewed baseline and verify Ready Pods, EndpointSlices, and Service HTTP.",
    hints: [
      "Compare the Pod Ready condition with container readiness and recent kubelet events.",
      "Inspect the selected container's readiness probe and the actual HTTP response.",
      "Trace Service → EndpointSlice → Pod. Readiness changes traffic eligibility without restarting the process.",
    ],
  },
  liveness: {
    title: "Liveness probe failure",
    objective:
      "Corroborate probe-triggered restarts, restore the liveness contract, and prove recovery.",
    operation:
      "Waypoint changes only the selected HTTP liveness path to a lab-only missing path.",
    repair:
      "Reapply the reviewed baseline and verify the workload recovers with its original probes.",
    hints: [
      "Inspect container restarts, last termination, and recent kubelet events together.",
      "Look for repeated liveness failures followed by a kubelet kill; readiness has a different effect.",
      "Compare the selected container's liveness probe with the reviewed baseline.",
    ],
  },
  "service-selector": {
    title: "Service selector mismatch",
    objective:
      "Trace why a Service has no matching backend while the selected workload remains healthy.",
    operation:
      "Waypoint adds one lab-specific no-match selector label to the selected Service.",
    repair:
      "Reapply the reviewed Service selector and confirm ready EndpointSlice backends and HTTP traffic.",
    hints: [
      "Compare the Service selector with the selected Deployment's Pod template labels.",
      "Inspect the Service's EndpointSlices and their target Pod UIDs.",
      "Restore the baseline selector, then confirm a request succeeds through the Service.",
    ],
  },
  "service-target-port": {
    title: "Service targetPort mismatch",
    objective:
      "Separate ready Service endpoints from a broken port mapping to the selected workload.",
    operation:
      "Waypoint changes only the selected Service targetPort to the reserved lab port 1.",
    repair: "Reapply the reviewed targetPort and verify Service HTTP traffic.",
    hints: [
      "Check the Service port and targetPort separately; the Service can still select ready Pods.",
      "Compare a named targetPort with the selected container's declared ports.",
      "Restore the reviewed targetPort and repeat the HTTP check through the Service.",
    ],
  },
  "image-pull": {
    title: "Image unavailable",
    objective:
      "Identify an unavailable container image from structured Pod state and restore the reviewed image.",
    operation:
      "Waypoint selects a deliberately unavailable tag in the same public image repository with pull policy Never; no registry credentials or image build are used.",
    repair:
      "Reapply the reviewed image and pull policy, then verify the Deployment rollout.",
    hints: [
      "Inspect the container's complete image reference and the Pod's waiting reason.",
      "Distinguish ErrImageNeverPull / ErrImagePull / ImagePullBackOff from a process CrashLoopBackOff.",
      "Restore the reviewed prebuilt image reference and pull policy, then observe rollout readiness.",
    ],
  },
  "configmap-key": {
    title: "Missing ConfigMap key",
    objective:
      "Trace a startup configuration error to a required namespaced ConfigMap key and restore the reference.",
    operation:
      "Waypoint changes one non-secret ConfigMap key reference in the selected container to a lab-only missing key.",
    repair:
      "Reapply the reviewed configuration reference and verify the Deployment rollout.",
    hints: [
      "Inspect the Pod's structured waiting reason and related events.",
      "Compare the selected container's configMapKeyRef name/key with the ConfigMap in the same namespace.",
      "Restore the baseline key reference; do not disable the required reference or modify a Secret.",
    ],
  },
  "market-data-stale": {
    title: "Stale synthetic market data",
    objective:
      "Distinguish a live producer process from a fresh quote sequence, then restore feed progress.",
    operation:
      "Waypoint pauses the producer through its exact loopback-forwarded lab control endpoint; no Pod exec, shell, or manifest probe mutation is used.",
    repair:
      "Resume the synthetic producer, then verify a later sequence restores consumer readiness and its Service endpoint.",
    hints: [
      "Compare feed_id and sequence over time. An unchanged sequence does not become fresh because the HTTP process responds.",
      "Check producer and consumer /livez, /readyz, and /metrics separately; producer readiness is API availability, not feed freshness.",
      "Confirm the consumer Pod becomes NotReady, leaves its ready EndpointSlice, and recovers after a newer sequence.",
    ],
  },
};

export function incidentChoice(id: LiveIncidentId): LiveIncidentChoice {
  return { id, ...copy[id] };
}

function contracts(plan: DeploymentPlan): HttpContract[] {
  return plan.contracts ?? (plan.contract ? [plan.contract] : []);
}
function targetKey(c: HttpContract, namespace: string) {
  return [c.namespace ?? namespace, c.deployment, c.container].join("/");
}
function selectedContract(plan: DeploymentPlan, target: string) {
  return contracts(plan).find((c) => targetKey(c, plan.namespace) === target);
}
function deploymentFor(plan: DeploymentPlan, c: HttpContract) {
  return plan.resources.find(
    (r) =>
      r.kind === "Deployment" &&
      at(r, "metadata", "name") === c.deployment &&
      at(r, "metadata", "namespace") === (c.namespace ?? plan.namespace),
  );
}
function containerFor(plan: DeploymentPlan, c: HttpContract) {
  const deployment = deploymentFor(plan, c);
  return list(at(deployment, "spec", "template", "spec", "containers")).find(
    (container) => container.name === c.container,
  );
}
function serviceFor(plan: DeploymentPlan, c: HttpContract) {
  return plan.resources.find(
    (r) =>
      r.kind === "Service" &&
      at(r, "metadata", "name") === c.service &&
      at(r, "metadata", "namespace") === (c.namespace ?? plan.namespace),
  );
}
function isMarketDataFixture(plan: DeploymentPlan) {
  const deployments = plan.resources.filter((r) => r.kind === "Deployment"),
    producer = deployments.find(
      (r) => at(r, "metadata", "name") === "market-producer",
    ),
    consumer = deployments.find(
      (r) => at(r, "metadata", "name") === "market-consumer",
    ),
    services = plan.resources.filter((r) => r.kind === "Service"),
    producerService = services.find(
      (r) => at(r, "metadata", "name") === "market-producer",
    ),
    consumerService = services.find(
      (r) => at(r, "metadata", "name") === "market-consumer",
    ),
    producerContainer = list(
      at(producer, "spec", "template", "spec", "containers"),
    )[0],
    consumerContainer = list(
      at(consumer, "spec", "template", "spec", "containers"),
    )[0];
  return Boolean(
    producer &&
    consumer &&
    producerService &&
    consumerService &&
    at(producer, "metadata", "labels", "app.kubernetes.io/part-of") ===
      "waypoint-market-data-lab" &&
    at(consumer, "metadata", "labels", "app.kubernetes.io/part-of") ===
      "waypoint-market-data-lab" &&
    at(producerContainer, "readinessProbe", "httpGet", "path") === "/readyz" &&
    at(producerContainer, "livenessProbe", "httpGet", "path") === "/livez" &&
    at(consumerContainer, "readinessProbe", "httpGet", "path") === "/readyz" &&
    at(consumerContainer, "livenessProbe", "httpGet", "path") === "/livez" &&
    list(at(consumerContainer, "env")).some(
      (v) =>
        v.name === "PRODUCER_URL" &&
        text(v.value) === "http://market-producer:8080/quote",
    ),
  );
}

export function applicableIncidents(
  plan: DeploymentPlan,
  target: string,
): LiveIncidentChoice[] {
  const c = selectedContract(plan, target);
  if (!c) return [];
  const container = containerFor(plan, c),
    service = serviceFor(plan, c);
  if (!container || !service) return [];
  const choices: LiveIncidentId[] = [];
  if (text(at(container, "readinessProbe", "httpGet", "path")))
    choices.push("readiness");
  if (text(at(container, "livenessProbe", "httpGet", "path")))
    choices.push("liveness");
  if (Object.keys(object(at(service, "spec", "selector"))).length)
    choices.push("service-selector", "service-target-port");
  if (text(container.image)) choices.push("image-pull");
  const configKeys = new Map(
    plan.resources
      .filter((r) => r.kind === "ConfigMap")
      .map((r) => [
        `${text(at(r, "metadata", "namespace"))}/${text(at(r, "metadata", "name"))}`,
        new Set(Object.keys(object(r.data))),
      ]),
  );
  if (
    list(container.env).some((entry) => {
      const ref = object(at(entry, "valueFrom", "configMapKeyRef"));
      return (
        !ref.optional &&
        typeof ref.key === "string" &&
        configKeys
          .get(`${c.namespace ?? plan.namespace}/${text(ref.name)}`)
          ?.has(ref.key)
      );
    })
  )
    choices.push("configmap-key");
  if (isMarketDataFixture(plan) && c.deployment === "market-producer")
    choices.push("market-data-stale");
  return choices.map(incidentChoice);
}

export function incidentOperation(
  plan: DeploymentPlan,
  id: LiveIncidentId,
  target: string,
  labId: string,
) {
  const c = selectedContract(plan, target);
  if (!c) throw Error("Incident target is not part of the reviewed lab.");
  if (!applicableIncidents(plan, target).some((choice) => choice.id === id))
    throw Error("This incident is not applicable to the selected workload.");
  const resources = structuredClone(plan.resources),
    deployment = resources.find(
      (r) =>
        r.kind === "Deployment" &&
        at(r, "metadata", "name") === c.deployment &&
        at(r, "metadata", "namespace") === (c.namespace ?? plan.namespace),
    ),
    container = list(
      at(deployment, "spec", "template", "spec", "containers"),
    ).find((v) => v.name === c.container),
    service = resources.find(
      (r) =>
        r.kind === "Service" &&
        at(r, "metadata", "name") === c.service &&
        at(r, "metadata", "namespace") === (c.namespace ?? plan.namespace),
    );
  if (!container || !service) throw Error("Reviewed fault target disappeared.");
  switch (id) {
    case "readiness":
    case "liveness": {
      const field = id === "readiness" ? "readinessProbe" : "livenessProbe";
      const path = at(container, field, "httpGet", "path");
      if (typeof path !== "string" || !path)
        throw Error("The selected HTTP probe is unavailable.");
      object(at(container, field, "httpGet")).path =
        "/waypoint-missing-" + labId.slice(0, 8);
      break;
    }
    case "service-selector":
      object(at(service, "spec")).selector = {
        ...object(at(service, "spec", "selector")),
        "waypoint.dev/no-match": labId,
      };
      break;
    case "service-target-port": {
      const ports = list(at(service, "spec", "ports"));
      const port = ports.find((v) => Number(v.port) === c.port) ?? ports[0];
      if (!port) throw Error("The selected Service has no port.");
      port.targetPort = 1;
      break;
    }
    case "image-pull": {
      const image = text(container.image);
      if (!image) throw Error("The selected container has no image.");
      const repository = image.split("@")[0];
      const tagIndex = repository.lastIndexOf(":");
      const faultImage =
        tagIndex > repository.lastIndexOf("/")
          ? `${repository.slice(0, tagIndex)}:waypoint-missing-${labId.slice(0, 8)}`
          : `${repository}:waypoint-missing-${labId.slice(0, 8)}`;
      container.image = faultImage;
      container.imagePullPolicy = "Never";
      break;
    }
    case "configmap-key": {
      const env = list(container.env).find((entry) => {
        const ref = object(at(entry, "valueFrom", "configMapKeyRef"));
        const cm = resources.find(
          (r) =>
            r.kind === "ConfigMap" &&
            at(r, "metadata", "name") === ref.name &&
            at(r, "metadata", "namespace") === (c.namespace ?? plan.namespace),
        );
        return (
          !ref.optional &&
          typeof ref.key === "string" &&
          cm &&
          Object.hasOwn(object(cm.data), ref.key)
        );
      });
      if (!env) throw Error("No required non-secret ConfigMap key applies.");
      const ref = object(at(env, "valueFrom", "configMapKeyRef"));
      ref.key = `${text(ref.key)}-waypoint-missing`;
      break;
    }
    case "market-data-stale":
      if (!isMarketDataFixture(plan) || c.deployment !== "market-producer")
        throw Error("The reviewed synthetic market-data fixture is required.");
      break;
    default: {
      const never: never = id;
      throw Error(`Unsupported typed incident: ${never}`);
    }
  }
  return resources;
}

export function isSyntheticMarketData(plan: DeploymentPlan) {
  return isMarketDataFixture(plan);
}

export function describeIncidentPlan(id: LiveIncidentId, target: string) {
  return `${copy[id].operation}\nTarget: ${target}.\nRepair: ${copy[id].repair}`;
}
