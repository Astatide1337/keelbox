import { parseSources } from "../domain/importer";
import { at, list, text, type ObjectMap } from "../domain/types";
import type { DeploymentPlan, HttpContract } from "../domain/deployment-plan";

/** Authored resources must never overwrite the receipt used to authorize mutation. */
export function assertNoReservedResources(resources: ObjectMap[]) {
  for (const resource of resources) {
    if (
      resource.kind === "ConfigMap" &&
      at(resource, "metadata", "name") === "waypoint-ownership"
    )
      throw Error(
        "ConfigMap/waypoint-ownership is reserved for cluster ownership. Rename it before deployment; no resources were applied.",
      );
  }
}

export function assertSafeApplicationSource(source: string) {
  const parsed = parseSources([
    { id: "runtime", name: "runtime.yaml", content: source },
  ]);
  if (parsed.diagnostics.length)
    throw Error(
      "Application source is invalid: " +
        parsed.diagnostics.map((d) => d.message).join("; "),
    );
  if (!parsed.resources.length)
    throw Error("Application source contains no resources.");
  assertNoReservedResources(parsed.resources.map((r) => r.raw));
}

export function checkedHttpContracts(plan: DeploymentPlan): HttpContract[] {
  const contracts = plan.contracts ?? (plan.contract ? [plan.contract] : []);
  for (const contract of contracts) {
    const namespace = contract.namespace ?? plan.namespace;
    const service = plan.resources.find(
      (r) =>
        r.kind === "Service" &&
        at(r, "metadata", "name") === contract.service &&
        at(r, "metadata", "namespace") === namespace,
    );
    const servicePort = list(at(service, "spec", "ports")).find(
      (p) => p.port === contract.port,
    );
    const deployment = plan.resources.find(
      (r) =>
        r.kind === "Deployment" &&
        at(r, "metadata", "name") === contract.deployment &&
        at(r, "metadata", "namespace") === namespace,
    );
    const container = list(
      at(deployment, "spec", "template", "spec", "containers"),
    ).find((c) => c.name === contract.container);
    const probePort = list(container?.ports).find((p) =>
      typeof contract.probePort === "string"
        ? p.name === contract.probePort
        : p.containerPort === contract.probePort,
    );
    if (
      !servicePort ||
      (servicePort.protocol ?? "TCP") !== "TCP" ||
      (probePort && (probePort.protocol ?? "TCP") !== "TCP")
    )
      throw Error(
        `HTTP verification requires TCP: ${namespace}/Service/${contract.service}:${contract.port}. UDP and SCTP cannot be verified as HTTP.`,
      );
  }
  return contracts;
}

export function resetPreview(plan: DeploymentPlan) {
  return {
    action: "reapply-reviewed-baseline" as const,
    preservesVolumeData: true,
    recreatesJobs: false,
    runsCronJobs: false,
    details: [
      "Restore reviewed manifests and required test configuration. Controllers may roll out replacement Pods.",
      ...(plan.resources.some((r) => r.kind === "Job")
        ? [
            "Existing Jobs are not recreated or rerun. Completed execution remains recorded.",
          ]
        : []),
      ...(plan.resources.some((r) => r.kind === "CronJob")
        ? [
            "CronJob schedules remain schedules; reset does not trigger an execution.",
          ]
        : []),
      ...(plan.resources.some((r) => r.kind === "PersistentVolumeClaim")
        ? [
            "PVC data is preserved. Reset does not restore or erase application data; a readiness pass does not prove a clean database.",
          ]
        : []),
    ],
  };
}

/** Execute only the reviewed template, never additions made to the live CronJob. */
export function reviewedCronJobRun(
  expected: ObjectMap,
  observed: ObjectMap,
  name: string,
): ObjectMap {
  const uid = text(at(observed, "metadata", "uid"));
  if (
    !uid ||
    observed.kind !== "CronJob" ||
    at(expected, "metadata", "name") !== at(observed, "metadata", "name") ||
    at(expected, "metadata", "namespace") !==
      at(observed, "metadata", "namespace")
  )
    throw Error("CronJob identity is unavailable or changed.");
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      ...(at(expected, "spec", "jobTemplate", "metadata", "labels")
        ? {
            labels: structuredClone(
              at(expected, "spec", "jobTemplate", "metadata", "labels"),
            ),
          }
        : {}),
      ...(at(expected, "spec", "jobTemplate", "metadata", "annotations")
        ? {
            annotations: structuredClone(
              at(expected, "spec", "jobTemplate", "metadata", "annotations"),
            ),
          }
        : {}),
      name,
      namespace: at(expected, "metadata", "namespace"),
      ownerReferences: [
        {
          apiVersion: "batch/v1",
          kind: "CronJob",
          name: at(expected, "metadata", "name"),
          uid,
          controller: true,
          blockOwnerDeletion: false,
        },
      ],
    },
    spec: structuredClone(at(expected, "spec", "jobTemplate", "spec")),
  };
}

export function cronJobExecution(jobs: ObjectMap[], uid: string) {
  const owned = jobs
    .filter((job) =>
      list(at(job, "metadata", "ownerReferences")).some(
        (owner) => owner.uid === uid,
      ),
    )
    .sort((a, b) => {
      const time = (job: ObjectMap) =>
        Date.parse(
          text(
            at(job, "status", "startTime") ??
              at(job, "metadata", "creationTimestamp"),
          ),
        ) || 0;
      return (
        time(b) - time(a) ||
        text(at(a, "metadata", "uid")).localeCompare(
          text(at(b, "metadata", "uid")),
        )
      );
    });
  // A historical success cannot erase a later failed or still-active scheduled run.
  const latest = owned.slice(0, 1);
  if (
    latest.some((job) =>
      list(at(job, "status", "conditions")).some(
        (c) => c.type === "Complete" && c.status === "True",
      ),
    )
  )
    return {
      state: "completed" as const,
      detail:
        "A completed execution was observed; its result does not establish that every future scheduled run will succeed.",
    };
  if (
    latest.some((job) =>
      list(at(job, "status", "conditions")).some(
        (c) => c.type === "Failed" && c.status === "True",
      ),
    )
  )
    return {
      state: "failed" as const,
      detail:
        "A scheduled execution failed. Inspect its Job and Pod events/logs.",
    };
  return {
    state: "awaiting" as const,
    detail: owned.length
      ? "Execution is in progress; completion has not been observed."
      : "Configuration is valid; awaiting a scheduled run. Execution has not been verified. Use the reviewed one-run action to test it now.",
  };
}

/** A not-ready condition/restart counter alone cannot diagnose a probe failure. */
export function corroboratedProbeFailure(
  pod: ObjectMap,
  events: ObjectMap[],
  container: string,
  incident: "readiness" | "liveness",
  injectedAt: string,
) {
  const uid = text(at(pod, "metadata", "uid"));
  const after = Date.parse(injectedAt);
  if (!uid || !Number.isFinite(after)) return false;
  const event = events.some((e) => {
    const time = Date.parse(
      text(
        at(e, "series", "lastObservedTime") ??
          e.lastTimestamp ??
          e.eventTime ??
          e.firstTimestamp ??
          at(e, "metadata", "creationTimestamp"),
      ),
    );
    return (
      at(e, "involvedObject", "uid") === uid &&
      e.reason === "Unhealthy" &&
      (!at(e, "involvedObject", "fieldPath") ||
        text(at(e, "involvedObject", "fieldPath")) ===
          `spec.containers{${container}}`) &&
      Number.isFinite(time) &&
      time >= after &&
      text(e.message)
        .toLowerCase()
        .includes(incident + " probe")
    );
  });
  return (
    event &&
    (incident === "liveness"
      ? list(at(pod, "status", "containerStatuses")).some(
          (c) =>
            c.name === container &&
            Number(c.restartCount) > 0 &&
            Date.parse(text(at(c, "lastState", "terminated", "finishedAt"))) >=
              after,
        )
      : list(at(pod, "status", "containerStatuses")).some(
          (c) => c.name === container && c.ready === false,
        ) &&
        list(at(pod, "status", "conditions")).some(
          (c) => c.type === "Ready" && c.status === "False",
        ))
  );
}
