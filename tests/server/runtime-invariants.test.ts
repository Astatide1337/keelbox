import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertNoReservedResources,
  assertSafeApplicationSource,
  checkedHttpContracts,
  cronJobExecution,
  corroboratedProbeFailure,
  resetPreview,
  reviewedCronJobRun,
} from "../../lib/server/runtime-invariants";
import type {
  DeploymentPlan,
  HttpContract,
} from "../../lib/domain/deployment-plan";
import { at, type ObjectMap } from "../../lib/domain/types";
import {
  observationFreshness,
  LiveCache,
} from "../../lib/server/observations/cache";

const contract = (name: string): HttpContract => ({
  namespace: "lab",
  deployment: name,
  container: name,
  service: name,
  port: 80,
  path: "/ready",
  probePort: "http",
});
function plan(protocol?: string): DeploymentPlan {
  const contracts = [contract("first"), contract("second")];
  const resources: ObjectMap[] = contracts.flatMap((c) => [
    {
      kind: "Service",
      metadata: { name: c.service, namespace: "lab" },
      spec: {
        ports: [
          { port: 80, targetPort: "http", ...(protocol ? { protocol } : {}) },
        ],
      },
    },
    {
      kind: "Deployment",
      metadata: { name: c.deployment, namespace: "lab" },
      spec: {
        template: {
          spec: {
            containers: [
              {
                name: c.container,
                ports: [{ name: "http", containerPort: 8080 }],
              },
            ],
          },
        },
      },
    },
  ]);
  return {
    namespace: "lab",
    resources,
    contracts,
    contract: contracts[0],
  } as DeploymentPlan;
}

test("reserved ownership receipt is refused for direct resources and nested imported Lists", () => {
  assert.throws(
    () =>
      assertNoReservedResources([
        {
          kind: "ConfigMap",
          metadata: { name: "waypoint-ownership", namespace: "another" },
        },
      ]),
    /reserved/,
  );
  assert.throws(
    () =>
      assertSafeApplicationSource(
        "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: ConfigMap\n  metadata:\n    name: waypoint-ownership\n",
      ),
    /reserved/,
  );
  assert.doesNotThrow(() =>
    assertSafeApplicationSource(
      "apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: application-config\ndata:\n  mode: test\n",
    ),
  );
});

test("HTTP scope reserves every declared contract and rejects UDP and SCTP", () => {
  assert.deepEqual(
    checkedHttpContracts(plan()).map((c) => c.service),
    ["first", "second"],
  );
  assert.equal(checkedHttpContracts(plan("TCP")).length, 2);
  for (const protocol of ["UDP", "SCTP"])
    assert.throws(() => checkedHttpContracts(plan(protocol)), /requires TCP/);
  const p = plan();
  (
    (p.resources[3].spec as ObjectMap).template as {
      spec: { containers: { ports: ObjectMap[] }[] };
    }
  ).spec.containers[0].ports[0].protocol = "SCTP";
  assert.throws(() => checkedHttpContracts(p), /requires TCP/);
});

test("reset preview does not promise Job recreation, scheduled execution or PVC erasure", () => {
  const p = plan();
  p.resources.push(
    { kind: "Job" },
    { kind: "CronJob" },
    { kind: "PersistentVolumeClaim" },
  );
  const result = resetPreview(p);
  assert.equal(result.recreatesJobs, false);
  assert.equal(result.runsCronJobs, false);
  assert.equal(result.preservesVolumeData, true);
  assert.match(result.details.join(" "), /not restore or erase/);
});

test("CronJob configuration can await a schedule without claiming successful execution", () => {
  assert.equal(cronJobExecution([], "wanted").state, "awaiting");
  const job = {
    metadata: { ownerReferences: [{ uid: "other" }] },
    status: { conditions: [{ type: "Complete", status: "True" }] },
  };
  assert.equal(cronJobExecution([job], "wanted").state, "awaiting");
  job.metadata.ownerReferences[0].uid = "wanted";
  assert.equal(cronJobExecution([job], "wanted").state, "completed");
  job.status.conditions[0].type = "Failed";
  assert.equal(cronJobExecution([job], "wanted").state, "failed");
});

test("transport freshness stays distinct from resource health and recovers on observations", () => {
  const now = Date.now(),
    receivedAt = new Date(now).toISOString();
  const statuses = [
    {
      kind: "Pod",
      state: "current" as const,
      receivedAt,
      resourceVersion: "123",
    },
  ];
  assert.equal(observationFreshness(statuses, now).state, "current");
  assert.equal(observationFreshness(statuses, now + 91000).state, "stale");
  assert.equal(
    observationFreshness(
      [{ ...statuses[0], state: "stale", error: "connection refused" }],
      now,
    ).state,
    "stale",
  );
  assert.match(
    observationFreshness(
      [{ ...statuses[0], state: "stale", error: "connection refused" }],
      now,
    ).reasons[0],
    /connection refused/,
  );
  assert.equal(observationFreshness(statuses, now).lastObservation, receivedAt);
  assert.equal(observationFreshness([], now).state, "connecting");
});

test("live cache retains bounded buffers and permits init container log selection", async () => {
  const cache = new LiveCache({ namespace: "lab" } as never);
  const internals = cache as unknown as {
    maps: Map<string, Map<string, ObjectMap>>;
    json: (path: string) => Promise<ObjectMap>;
    readLogs: () => Promise<void>;
    append: (
      b: { lines: string[]; bytes: number; truncated: boolean },
      line: string,
    ) => void;
  };
  const pod = {
    metadata: { name: "p", namespace: "lab", uid: "u" },
    spec: {
      containers: [{ name: "app" }],
      initContainers: [{ name: "setup" }],
    },
    status: {
      initContainerStatuses: [
        { name: "setup", containerID: "containerd://one", restartCount: 0 },
      ],
    },
  };
  internals.maps.set("Pod", new Map([["u", pod]]));
  internals.json = async () => pod;
  internals.readLogs = async () => {};
  const buffer = await cache.follow("u", "setup");
  assert.equal(buffer.containerId, "containerd://one");
  for (let i = 0; i < 800; i++) internals.append(buffer, "line " + i);
  assert.equal(buffer.lines.length, 500);
  assert.equal(buffer.truncated, true);
  await assert.rejects(cache.follow("u", "other"), /not present/);
  cache.stop();
  assert.equal(cache.logs.size, 0);
});

test("probe diagnosis requires a current UID event after fault injection, not counters or old evidence", () => {
  const pod = {
    metadata: { uid: "current" },
    status: {
      conditions: [{ type: "Ready", status: "False" }],
      containerStatuses: [{ name: "app", restartCount: 5, ready: false }],
    },
  };
  const event = {
    involvedObject: { uid: "current" },
    reason: "Unhealthy",
    lastTimestamp: "2026-10-10T12:00:01Z",
    message: "Readiness probe failed: HTTP status 404",
  };
  assert.equal(
    corroboratedProbeFailure(
      pod,
      [],
      "app",
      "readiness",
      "2026-10-10T12:00:00Z",
    ),
    false,
  );
  assert.equal(
    corroboratedProbeFailure(
      pod,
      [event],
      "app",
      "readiness",
      "2026-10-10T12:00:00Z",
    ),
    true,
  );
  assert.equal(
    corroboratedProbeFailure(
      pod,
      [event],
      "app",
      "readiness",
      "2026-10-10T12:00:02Z",
    ),
    false,
  );
  assert.equal(
    corroboratedProbeFailure(
      pod,
      [event],
      "app",
      "liveness",
      "2026-10-10T12:00:00Z",
    ),
    false,
  );
  Object.assign(event.involvedObject, {
    fieldPath: "spec.containers{sidecar}",
  });
  assert.equal(
    corroboratedProbeFailure(
      pod,
      [event],
      "app",
      "readiness",
      "2026-10-10T12:00:00Z",
    ),
    false,
  );
  Object.assign(event.involvedObject, { fieldPath: "spec.containers{app}" });
  event.message = "Liveness probe failed: HTTP status 404";
  assert.equal(
    corroboratedProbeFailure(
      pod,
      [event],
      "app",
      "liveness",
      "2026-10-10T12:00:00Z",
    ),
    false,
  );
  Object.assign(pod.status.containerStatuses[0], {
    lastState: { terminated: { finishedAt: "2026-10-10T12:00:01Z" } },
  });
  assert.equal(
    corroboratedProbeFailure(
      pod,
      [event],
      "app",
      "liveness",
      "2026-10-10T12:00:00Z",
    ),
    true,
  );
  event.involvedObject.uid = "previous";
  assert.equal(
    corroboratedProbeFailure(
      pod,
      [event],
      "app",
      "liveness",
      "2026-10-10T12:00:00Z",
    ),
    false,
  );
});

test("CronJob latest failed or active execution is not hidden by old success", () => {
  const job = (uid: string, time: string, type: string) => ({
    kind: "Job",
    metadata: {
      uid,
      creationTimestamp: time,
      ownerReferences: [{ uid: "cron" }],
    },
    status: { conditions: type ? [{ type, status: "True" }] : [] },
  });
  const previous = job("old", "2026-10-01T00:00:00Z", "Complete");
  assert.equal(
    cronJobExecution(
      [previous, job("new", "2026-10-10T00:00:00Z", "Failed")],
      "cron",
    ).state,
    "failed",
  );
  assert.equal(
    cronJobExecution([previous, job("new", "2026-10-10T00:00:00Z", "")], "cron")
      .state,
    "awaiting",
  );
  assert.equal(
    cronJobExecution(
      [
        {
          ...job("foreign", "2026-10-11T00:00:00Z", "Failed"),
          metadata: { ownerReferences: [{ uid: "other" }] },
        },
        previous,
      ],
      "cron",
    ).state,
    "completed",
  );
});

test("one-run Job uses only reviewed CronJob executable fields, never live additions", () => {
  const expected = {
    kind: "CronJob",
    metadata: { name: "daily", namespace: "lab" },
    spec: {
      jobTemplate: {
        metadata: {
          labels: { app: "daily" },
          annotations: { "example.dev/purpose": "reviewed" },
        },
        spec: {
          template: {
            spec: {
              restartPolicy: "Never",
              containers: [{ name: "app", image: "trusted:1" }],
            },
          },
        },
      },
    },
  };
  const observed = {
    ...structuredClone(expected),
    metadata: { ...expected.metadata, uid: "cron-uid" },
  };
  const pod = observed.spec.jobTemplate.spec.template.spec;
  Object.assign(pod.containers[0], {
    command: ["unreviewed"],
    securityContext: { privileged: true },
  });
  const job = reviewedCronJobRun(expected, observed, "one-run");
  assert.deepEqual(job.spec, expected.spec.jobTemplate.spec);
  assert.deepEqual(
    at(job, "metadata", "labels"),
    expected.spec.jobTemplate.metadata.labels,
  );
  assert.deepEqual(
    at(job, "metadata", "annotations"),
    expected.spec.jobTemplate.metadata.annotations,
  );
  assert.equal(at(job, "metadata", "ownerReferences", "0", "uid"), "cron-uid");
  assert.throws(
    () =>
      reviewedCronJobRun(
        expected,
        { ...observed, metadata: { ...observed.metadata, uid: "" } },
        "one-run",
      ),
    /identity/,
  );
});

test("late log close after reset cannot stop a new-generation stream", async () => {
  const { MinikubeRuntime } = await import("../../lib/server/minikube-runtime");
  const runtime = new MinikubeRuntime("/unused");
  const state = runtime as unknown as {
    loaded: boolean;
    lab: { id: string; generation: number; revision: number };
    cache: { closeLog: () => void; follow: () => Promise<unknown> };
  };
  state.loaded = true;
  state.lab = { id: "lab", generation: 2, revision: 5 };
  let closed = false;
  state.cache = {
    closeLog: () => {
      closed = true;
    },
    follow: async () => ({ lines: ["safe"] }),
  };
  await assert.rejects(
    runtime.logs("pod", "app", true, {
      sessionId: "lab",
      generation: 1,
      revision: 4,
    }),
    /Lab changed/,
  );
  assert.equal(closed, false);
  await runtime.logs("pod", "app", true, {
    sessionId: "lab",
    generation: 2,
    revision: 5,
  });
  assert.equal(closed, true);
});
