import { test } from "node:test";
import assert from "node:assert/strict";
import {
  tutorContext,
  safeText,
  sanitizeTutorValue,
} from "../../lib/tutor/context";
import { liveTutorContext } from "../../lib/tutor/live-context";
import { projectResources, type Snapshot } from "../../lib/domain/snapshot";
import { analyze } from "../../lib/domain/analyzer";
import type { MinikubeRuntime } from "../../lib/server/minikube-runtime";
import {
  learningKey,
  emptyProgress,
  restoreProgress,
  summarizeEvidence,
  learningContextSchema,
} from "../../lib/practice/live-learning";
const now = new Date().toISOString();
const snapshot = (resources: Record<string, unknown>[]): Snapshot => ({
  format: "playground-snapshot-v2",
  id: "fixture",
  label: "Test app",
  origin: "captured",
  captureStartedAt: now,
  captureEndedAt: now,
  resources,
  files: [],
  errors: [],
  contracts: [],
  coverage: [],
});
const pod = (index: number) => ({
  apiVersion: "v1",
  kind: "Pod",
  metadata: {
    name: "api-" + index,
    namespace: "demo",
    uid: "pod-" + index,
    labels: { app: "api" },
  },
  spec: {
    containers: [
      {
        name: "api",
        readinessProbe: { httpGet: { path: "/health", port: 8080 } },
      },
    ],
  },
  status: {
    phase: "Running",
    conditions: [
      { type: "Ready", status: "False", reason: "ContainersNotReady" },
    ],
    containerStatuses: [
      {
        name: "api",
        ready: false,
        restartCount: 1,
        state: { waiting: { reason: "CrashLoopBackOff" } },
      },
    ],
  },
});
const service = {
  apiVersion: "v1",
  kind: "Service",
  metadata: { name: "api", namespace: "demo", uid: "service-uid" },
  spec: {
    selector: { app: "api" },
    ports: [{ port: 80, targetPort: 8080, protocol: "TCP" }],
  },
};
const slice = {
  apiVersion: "discovery.k8s.io/v1",
  kind: "EndpointSlice",
  metadata: {
    name: "api-slice",
    namespace: "demo",
    uid: "slice-uid",
    labels: { "kubernetes.io/service-name": "api" },
  },
  endpoints: [
    {
      targetRef: { kind: "Pod", name: "api-0", uid: "pod-0" },
      conditions: { ready: false, terminating: false },
    },
  ],
};
test("sensitive label keys redact their values atomically and structural facts remain readable", () => {
  const values = [pod(0), service];
  Object.assign((values[0] as ReturnType<typeof pod>).metadata.labels, {
    password: "short-canary",
    "x/api_key": "key-canary",
    safe: "api",
    accessToken: "camel-token-canary",
    clientSecret: "camel-secret-canary",
    version: "v1.2",
  });
  const context = JSON.stringify(tutorContext(snapshot(values), {}));
  assert.ok(!context.includes("short-canary"));
  assert.ok(!context.includes("key-canary"));
  assert.ok(!context.includes("camel-token-canary"));
  assert.ok(!context.includes("camel-secret-canary"));
  assert.ok(context.includes("v1.2"));
  assert.equal(
    safeText("request to https://user:CANARY_URL@api.example.test failed"),
    "[redacted]",
  );
  assert.ok(context.includes("ContainersNotReady"));
  assert.ok(context.includes("/health"));
  assert.equal(safeText("Secret"), "Secret");
  assert.equal(safeText("password: short-canary"), "[redacted]");
});
test("every serialized field has the same redaction boundary including ids, citations, errors and telemetry", () => {
  const fields = [
    "identifier",
    "preview",
    "citation",
    "error",
    "telemetry",
    "uid",
    "resourceId",
    "fileId",
    "path",
    "name",
    "reason",
    "timestamp",
  ];
  const payload = Object.fromEntries(
    fields.map((field) => [field, `password: canary-${field}`]),
  );
  const serialized = JSON.stringify(
    sanitizeTutorValue({ payload, nested: [payload], password: "short-value" }),
  );
  for (const field of fields)
    assert.ok(!serialized.includes(`canary-${field}`));
  assert.ok(!serialized.includes("short-value"));
  const project = snapshot([pod(0), service, slice]);
  project.label = "token=project-canary";
  project.resources[0].metadata = {
    name: "password: name-canary",
    namespace: "token=namespace-canary",
    uid: "password: uid-canary",
  };
  const outbound = JSON.stringify(tutorContext(project, {}));
  for (const value of [
    "project-canary",
    "name-canary",
    "namespace-canary",
    "uid-canary",
  ])
    assert.ok(!outbound.includes(value));
});
test("selected Service and EndpointSlice survive thirty preceding Pods and report deterministic omissions", () => {
  const project = snapshot([
    ...Array.from({ length: 40 }, (_, i) => pod(i)),
    service,
    slice,
  ]);
  const selected = projectResources(project).find((r) => r.kind === "Service")!;
  const first = tutorContext(project, { resourceId: selected.id });
  assert.equal(first.context.evidence[0].resourceId, selected.id);
  assert.ok(first.context.evidence.some((e) => e.kind === "EndpointSlice"));
  assert.equal(first.context.evidence.length, 30);
  assert.equal(first.context.omittedResources, 12);
  assert.deepEqual(first, tutorContext(project, { resourceId: selected.id }));
  const backend = first.context.evidence.find(
    (e) => e.kind === "EndpointSlice",
  )!;
  assert.equal(backend.configuration.endpoints?.[0].targetUid, "pod-0");
  assert.equal(
    first.context.evidence[0].configuration.servicePorts?.[0].targetPort,
    8080,
  );
});
function liveView() {
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { uid: "deploy-uid", name: "api", namespace: "demo" },
  };
  const replica = {
    apiVersion: "apps/v1",
    kind: "ReplicaSet",
    metadata: {
      uid: "replica-uid",
      name: "api-rs",
      namespace: "demo",
      ownerReferences: [
        {
          uid: "deploy-uid",
          kind: "Deployment",
          name: "api",
          controller: true,
        },
      ],
    },
  };
  const child = pod(0);
  Object.assign(child.metadata, {
    ownerReferences: [
      {
        uid: "replica-uid",
        kind: "ReplicaSet",
        name: "api-rs",
        controller: true,
      },
    ],
  });
  return {
    plan: null,
    lab: {
      id: "lab-uid",
      generation: 1,
      revision: 2,
      phase: "running",
      incident: "readiness",
      operation: null,
      namespace: "demo",
      checks: [
        { name: "traffic", passed: false, detail: "password: check-canary" },
      ],
      evidence: {
        resources: [deployment, replica, child, service, slice],
        receivedAt: now,
        status: [{ kind: "Pod", state: "current", receivedAt: now }],
        events: [
          {
            metadata: { uid: "event-uid" },
            involvedObject: { uid: "pod-0" },
            reason: "Unhealthy",
            type: "Warning",
            message: "raw-message-canary",
            lastTimestamp: now,
            source: { component: "kubelet" },
          },
        ],
      },
    },
  } as unknown as ReturnType<MinikubeRuntime["view"]>;
}
test("live tutor includes descendant Pod evidence and reviewed lesson facts, excludes raw values and rejects stale state", () => {
  const view = liveView();
  const learning = learningContextSchema.parse({
    lesson: "readiness",
    objective: "Inspect evidence",
    hypothesis: "password: hypothesis-canary",
    prediction: "Pod stays Running but not Ready",
    hintLevel: 1,
    visibleHints: ["Inspect events"],
    solutionRequested: false,
    helpTarget: "failed-check",
  });
  const result = liveTutorContext(view, { resourceId: "deploy-uid", learning });
  assert.equal(result.context.events[0].resourceUid, "pod-0");
  assert.equal(result.context.learning?.hintLevel, 1);
  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes("raw-message-canary"));
  assert.ok(!serialized.includes("check-canary"));
  assert.ok(!serialized.includes("hypothesis-canary"));
  view.lab!.evidence.status[0].state = "stale";
  assert.throws(
    () => liveTutorContext(view, { resourceId: "deploy-uid" }),
    /stale/,
  );
});
test("exact live edges preserve their scope and reject replaced relationships", () => {
  const view = liveView();
  const resources = projectResources(
    snapshot(view.lab!.evidence.resources),
  ).map((r) => ({ ...r, id: String((r.raw.metadata as { uid: string }).uid) }));
  const edge = analyze(resources).relationships.find((e) => e.kind === "owns")!;
  const result = liveTutorContext(view, { relationshipId: edge.id });
  assert.ok(result.context.evidence.some((e) => e.name === "api-rs"));
  assert.throws(
    () => liveTutorContext(view, { relationshipId: "replaced-edge" }),
    /no longer present/,
  );
});
test("learning progress resumes only in its explicit account/project/lab/attempt scope, corruption fails safely", () => {
  const key = learningKey("account", "project", "lab", 1);
  for (const other of [
    learningKey("other", "project", "lab", 1),
    learningKey("account", "other", "lab", 1),
    learningKey("account", "project", "other", 1),
    learningKey("account", "project", "lab", 2),
  ])
    assert.notEqual(other, key);
  const progress = {
    ...emptyProgress(),
    hypothesis: "readiness failed",
    prediction: "no ready backend",
    hintLevel: 1,
    before: summarizeEvidence([pod(0), slice], [], now, 2),
  };
  assert.deepEqual(restoreProgress(JSON.stringify(progress)), progress);
  assert.deepEqual(restoreProgress("{invalid"), emptyProgress());
  assert.deepEqual(
    restoreProgress(JSON.stringify({ ...progress, hintLevel: 999 })),
    emptyProgress(),
  );
  assert.equal(progress.before.pods[0].ready, "False");
});

test("late transport responses cannot move a lab backwards across revisions or resets", async () => {
  const { acceptsObservation } =
    await import("../../lib/practice/live-observation");
  const current = { id: "lab", generation: 2, revision: 5 };
  assert.equal(
    acceptsObservation(
      current,
      { ...current, generation: 1, revision: 9 },
      99,
      3,
    ),
    false,
  );
  assert.equal(
    acceptsObservation(current, { ...current, revision: 4 }, 99, 3),
    false,
  );
  assert.equal(acceptsObservation(current, current, 2, 3), false);
  assert.equal(
    acceptsObservation(current, { ...current, revision: 6 }, 2, 3),
    true,
  );
  let resolveOld!: (v: typeof current) => void;
  const old = new Promise<typeof current>((resolve) => {
    resolveOld = resolve;
  });
  let accepted = current;
  const late = old.then((value) => {
    if (acceptsObservation(accepted, value, 1, 2)) accepted = value;
  });
  resolveOld({ ...current, revision: 4 });
  await late;
  assert.deepEqual(accepted, current);
});

test("current transport enums never override stale receipt timestamps", async () => {
  const { observationFreshness } = await import("../../lib/domain/freshness");
  const status = [
    { kind: "Pod", state: "current", receivedAt: "2000-01-01T00:00:00.000Z" },
  ];
  assert.equal(observationFreshness(status).state, "stale");
  const view = liveView();
  view.lab!.evidence.status[0].receivedAt = status[0].receivedAt;
  assert.throws(() => liveTutorContext(view, {}), /stale/);
});

test("safe long questions and learner prose are preserved but credential assignments still redact", () => {
  const question = "Explain why readiness excludes a running Pod. ".repeat(25);
  assert.ok(question.length > 500 && question.length < 2000);
  assert.equal(safeText(question, 2000), question);
  assert.equal(
    sanitizeTutorValue({ hypothesis: question }).hypothesis,
    question,
  );
  assert.equal(
    safeText(question + " password: long-question-canary", 2000),
    "[redacted]",
  );
});

test("composed Kubernetes resource references survive redaction and remain usable citation targets", () => {
  const id = "core/Pod/waypoint-lab-415ceb2bda2e/web-fc74569ff-v8pxj";
  const clean = sanitizeTutorValue({
    resourceId: id,
    from: id,
    to: id,
    identifier: "password: short-canary",
  });
  assert.equal(clean.resourceId, id);
  assert.equal(clean.from, id);
  assert.equal(clean.to, id);
  assert.equal(clean.identifier, "[redacted]");
  assert.equal(
    sanitizeTutorValue({ resourceId: "core/Pod/demo/" + "X".repeat(48) })
      .resourceId,
    "[redacted]",
  );
});
