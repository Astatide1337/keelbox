#!/usr/bin/env node
/** Live proof against the installed npm artifact. No checkout imports, mocks, image builds or ambient kubeconfig. */
import assert from "node:assert/strict";
import { proveInstalledRestart } from "./installed-restart-proof.mjs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";

const exec = promisify(execFile);
const checks = [];
const failures = [];
let report;
function record(name, status, detail) {
  checks.push({ name, status, detail });
}
function requireEnvironment(name) {
  const value = process.env[name];
  if (!value)
    throw Error(`Set ${name} explicitly for the installed-product matrix.`);
  return value;
}
function sha(value) {
  return createHash("sha256").update(value).digest("hex");
}
async function privateJson(file) {
  const stat = await lstat(file);
  assert(
    stat.isFile() && !stat.isSymbolicLink() && !(stat.mode & 0o077),
    "Expected an owner-only regular file.",
  );
  if (process.getuid) assert.equal(stat.uid, process.getuid());
  return JSON.parse(await readFile(file, "utf8"));
}
async function poll(operation, predicate, description, timeout = 240000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await operation();
    if (predicate(value)) return value;
    if (value?.lab?.phase === "failed" && !value?.lab?.operation)
      throw Error(`${description}: ${value.lab.error ?? "lab failed"}`);
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error(`${description}: timed out after ${timeout} ms.`);
}
function app(name = "matrix-web") {
  return `apiVersion: apps/v1
kind: Deployment
metadata:
  name: ${name}
spec:
  replicas: 1
  selector: {matchLabels: {app: ${name}}}
  template:
    metadata: {labels: {app: ${name}}}
    spec:
      initContainers:
      - name: setup
        image: busybox:1.37
        command: [sh, -c, "echo waypoint-init-test-only"]
      containers:
      - name: web
        image: nginx:1.28-alpine
        ports: [{name: http, containerPort: 80, protocol: TCP}]
        readinessProbe: {httpGet: {path: /, port: http}, periodSeconds: 2, failureThreshold: 1}
        livenessProbe: {httpGet: {path: /, port: http}, periodSeconds: 2, failureThreshold: 1}
---
apiVersion: v1
kind: Service
metadata:
  name: ${name}
spec:
  selector: {app: ${name}}
  ports: [{name: http, port: 80, targetPort: http, protocol: TCP}]
`;
}
export async function writeMatrixFixtures(root) {
  const plain = join(root, "plain"),
    helm = join(root, "helm"),
    kustomize = join(root, "kustomize"),
    failed = join(root, "failed-deployment");
  await Promise.all([
    mkdir(plain),
    mkdir(failed),
    mkdir(join(helm, "templates"), { recursive: true }),
    mkdir(join(kustomize, "base"), { recursive: true }),
  ]);
  const workload = app()
    .replace(
      "        ports:",
      "        volumeMounts: [{name: data, mountPath: /data}]\n        ports:",
    )
    .replace(
      "---\napiVersion: v1",
      "      volumes: [{name: data, persistentVolumeClaim: {claimName: matrix-data}}]\n---\napiVersion: v1",
    );
  await writeFile(
    join(plain, "application.yaml"),
    workload +
      `---
apiVersion: v1
kind: PersistentVolumeClaim
metadata: {name: matrix-data}
spec:
  accessModes: [ReadWriteOnce]
  resources: {requests: {storage: 16Mi}}
---
apiVersion: batch/v1
kind: CronJob
metadata: {name: matrix-once}
spec:
  schedule: "0 0 * * *"
  suspend: true
  jobTemplate:
    spec:
      template:
        spec:
          restartPolicy: Never
          containers:
          - name: write-sentinel
            image: busybox:1.37
            command: [sh, -c, "printf '%s' waypoint-matrix-test-only > /data/sentinel"]
            volumeMounts: [{name: data, mountPath: /data}]
          volumes: [{name: data, persistentVolumeClaim: {claimName: matrix-data}}]
`,
  );
  await writeFile(
    join(helm, "Chart.yaml"),
    "apiVersion: v2\nname: waypoint-matrix\nversion: 0.1.0\n",
  );
  await writeFile(join(helm, "values.yaml"), "replicas: 1\n");
  await writeFile(
    join(helm, "templates", "application.yaml"),
    app("matrix-helm").replace(
      "replicas: 1",
      "replicas: {{ .Values.replicas }}",
    ),
  );
  await writeFile(
    join(kustomize, "base", "application.yaml"),
    app("matrix-kustomize"),
  );
  await writeFile(
    join(kustomize, "base", "kustomization.yaml"),
    "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: [application.yaml]\n",
  );
  await writeFile(
    join(kustomize, "kustomization.yaml"),
    "apiVersion: kustomize.config.k8s.io/v1beta1\nkind: Kustomization\nresources: [base]\nnameSuffix: -overlay\nreplicas:\n- name: matrix-kustomize\n  count: 1\n",
  );
  await writeFile(
    join(failed, "application.yaml"),
    app("matrix-failed")
      .replace("  replicas: 1", "  replicas: 1\n  progressDeadlineSeconds: 30")
      .replace(
        "        image: nginx:1.28-alpine",
        '        image: nginx:1.28-alpine\n        command: [sh, -c, "echo waypoint-failed-deployment-test-only; sleep 1; exit 42"]',
      ),
  );
  return [
    { name: "plain-cronjob-pvc", path: plain },
    { name: "helm", path: helm },
    { name: "kustomize-overlay", path: kustomize },
    { name: "failed-deployment", path: failed, expectedFailure: true },
  ];
}

async function main() {
  if (process.env.WAYPOINT_REAL_MATRIX !== "1")
    throw Error(
      "NOT RUN: Set WAYPOINT_REAL_MATRIX=1 only after coordinating serial owned-cluster execution. This script creates and cleans four disposable Minikube profiles using trusted prebuilt nginx/busybox images.",
    );
  const cli = resolve(requireEnvironment("WAYPOINT_E2E_CLI"));
  assert(
    !cli.includes("/cli/index.ts") && !cli.includes("/node_modules/.bin/tsx"),
    "Use the installed compiled CLI.",
  );
  const state = resolve(requireEnvironment("PLAYGROUND_STATE_DIR"));
  const output = resolve(requireEnvironment("WAYPOINT_MATRIX_OUTPUT"));
  await mkdir(output, { recursive: true, mode: 0o700 });
  const fixtureRoot = await mkdtemp(join(output, "fixtures-"));
  report = join(output, "live-matrix-results.json");
  let config = await privateJson(join(state, "server.json"));
  const origin = new URL(config.origin);
  assert(
    origin.protocol === "http:" &&
      origin.hostname === "127.0.0.1" &&
      !origin.username &&
      !origin.password &&
      origin.pathname === "/" &&
      !origin.search &&
      !origin.hash,
    "Owned loopback broker required.",
  );
  const headers = {
    Authorization: "Bearer " + config.token,
    Origin: config.origin,
    "Content-Type": "application/json",
  };
  async function raw(path, body) {
    const response = await fetch(config.origin + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(65000),
    });
    return { status: response.status, data: await response.json() };
  }
  let auth = await raw("/api/auth");
  assert.equal(auth.status, 200);
  assert(
    auth.data.profile?.kind === "chatgpt",
    "Real signed-in account required; no auth mock or bypass.",
  );
  assert.match(auth.data.profile.key, /^[a-f0-9]{64}$/);
  headers["X-Waypoint-Profile"] = auth.data.profile.key;
  headers["X-Waypoint-Epoch"] = String(auth.data.epoch);
  async function api(body) {
    const response = await raw("/api/lab", body);
    if (response.status >= 400)
      throw Error(response.data.error ?? "Lab request failed.");
    return response.data;
  }
  async function cliJson(args) {
    return JSON.parse(
      (
        await exec(cli, args, {
          env: process.env,
          timeout: 65000,
          maxBuffer: 8 * 1024 * 1024,
        })
      ).stdout,
    );
  }
  async function operation(kind, extra = {}) {
    const current = await api();
    assert(
      current.lab && current.lab.phase !== "stopped",
      "Active owned lab required.",
    );
    const body = {
      kind,
      operationId: randomUUID(),
      sessionId: current.lab.id,
      generation: current.lab.generation,
      revision: current.lab.revision,
      ...extra,
    };
    await api(body);
    return poll(
      api,
      (view) => view.lab?.id === current.lab.id && !view.lab.operation,
      kind,
    );
  }
  async function verifiedTarget() {
    const view = await api();
    const journal = await privateJson(
      join(
        state,
        "profiles",
        auth.data.profile.key,
        "runtime",
        "minikube-session.json",
      ),
    );
    const target = journal.target;
    assert.equal(journal.id, view.lab.id);
    assert.equal(
      resolve(target.home),
      join(
        state,
        "profiles",
        auth.data.profile.key,
        "runtime",
        "labs",
        journal.id,
      ),
    );
    assert.match(target.namespace, /^waypoint-lab-[a-f0-9]{12}$/);
    assert.match(target.profile, /^waypoint-[a-f0-9-]+$/);
    assert.equal(
      resolve(target.kubeconfig),
      join(resolve(target.home), "config"),
    );
    assert(
      target.containerId &&
        target.clusterUid &&
        target.namespaceUid &&
        target.markerUid &&
        target.fingerprint &&
        target.nonce,
    );
    await privateJsonFileCheck(target.kubeconfig);
    const direct = async (args) =>
      (
        await exec(
          "kubectl",
          [
            "--kubeconfig",
            target.kubeconfig,
            "--context",
            target.profile,
            "--request-timeout=20s",
            ...args,
          ],
          {
            env: {
              ...process.env,
              MINIKUBE_HOME: target.home,
              KUBECONFIG: target.kubeconfig,
            },
            timeout: 30000,
            maxBuffer: 1024 * 1024,
          },
        )
      ).stdout;
    const clusters = JSON.parse(
      await direct(["config", "view", "--raw", "-o", "jsonpath={.clusters}"]),
    );
    assert.equal(clusters.length, 1);
    assert.equal(
      sha(
        JSON.stringify({
          profile: target.profile,
          server: clusters[0].cluster.server,
          ca: clusters[0].cluster["certificate-authority-data"],
        }),
      ),
      target.fingerprint,
    );
    const container = JSON.parse(
      (
        await exec("docker", [
          "inspect",
          "--format",
          "{{json .Id}}",
          target.profile,
        ])
      ).stdout,
    );
    assert.equal(container, target.containerId);
    const system = JSON.parse(
      await direct(["get", "namespace", "kube-system", "-o", "json"]),
    );
    const namespace = JSON.parse(
      await direct(["get", "namespace", target.namespace, "-o", "json"]),
    );
    const marker = JSON.parse(
      await direct([
        "-n",
        target.namespace,
        "get",
        "configmap",
        "waypoint-ownership",
        "-o",
        "json",
      ]),
    );
    assert.equal(system.metadata.uid, target.clusterUid);
    assert.equal(namespace.metadata.uid, target.namespaceUid);
    assert.equal(marker.metadata.uid, target.markerUid);
    assert.equal(marker.data.nonce, target.nonce);
    return { target, direct, lab: view.lab };
  }
  async function disconnectAndRecover(ownedId) {
    const { target } = await verifiedTarget();
    const connected = await poll(
      api,
      (view) =>
        view.lab?.id === ownedId &&
        view.lab.evidence.connection?.state === "current",
      "confirmed cache before disconnect",
      120000,
    );
    const scope = {
      generation: connected.lab.generation,
      revision: connected.lab.revision,
    };
    let pauseAttempted = false;
    let disconnected;
    try {
      pauseAttempted = true;
      await exec("docker", ["pause", target.containerId], { timeout: 30000 });
      disconnected = await poll(
        api,
        (view) =>
          view.lab?.id === ownedId &&
          ["stale", "connecting"].includes(
            view.lab.evidence.connection?.state,
          ) &&
          view.lab.evidence.connection.reasons.length > 0 &&
          view.lab.evidence.status.some((status) => status.error),
        "actual disconnected observations",
        120000,
      );
      assert.equal(disconnected.lab.generation, scope.generation);
      assert.equal(disconnected.lab.revision, scope.revision);
      assert(
        disconnected.lab.evidence.connection.lastObservation,
        "Retain last confirmed observation while disconnected.",
      );
      const retained = new Map(
        disconnected.lab.evidence.status
          .filter((status) => status.error)
          .map((status) => [
            status.kind,
            {
              receivedAt: status.receivedAt,
              resourceVersion: status.resourceVersion,
            },
          ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const stillDisconnected = await api();
      assert.notEqual(
        stillDisconnected.lab.evidence.connection.state,
        "current",
        "A polling API response must not turn disconnected Kubernetes data into current evidence.",
      );
      for (const status of stillDisconnected.lab.evidence.status)
        if (retained.has(status.kind)) {
          assert.equal(
            status.receivedAt,
            retained.get(status.kind).receivedAt,
            "Reconnect attempts must retain the confirmed data timestamp.",
          );
          assert.equal(
            status.resourceVersion,
            retained.get(status.kind).resourceVersion,
          );
        }
      record("owned container disconnect", "PASS", {
        lastObservation: disconnected.lab.evidence.connection.lastObservation,
        state: disconnected.lab.evidence.connection.state,
        reasons: disconnected.lab.evidence.connection.reasons,
        generationUnchanged: true,
        revisionUnchanged: true,
      });
    } finally {
      if (pauseAttempted) {
        // Even a failed/timed-out pause command may have paused the container.
        // Resume exactly the verified immutable ID before any lab cleanup.
        const paused = (
          await exec(
            "docker",
            ["inspect", "--format", "{{.State.Paused}}", target.containerId],
            { timeout: 30000 },
          )
        ).stdout.trim();
        if (paused === "true")
          await exec("docker", ["unpause", target.containerId], {
            timeout: 30000,
          });
      }
    }
    const recovered = await poll(
      api,
      (view) =>
        view.lab?.id === ownedId &&
        view.lab.evidence.connection?.state === "current" &&
        view.lab.evidence.status.every((status) => status.state === "current"),
      "actual watch/relist recovery",
      120000,
    );
    assert.equal(recovered.lab.generation, scope.generation);
    assert.equal(recovered.lab.revision, scope.revision);
    assert(
      recovered.lab.evidence.status.some(
        (status) =>
          Date.parse(status.receivedAt) >
          Date.parse(
            disconnected.lab.evidence.status.find(
              (previous) => previous.kind === status.kind,
            )?.receivedAt ?? "",
          ),
      ),
      "Recovery must include a new confirming resource receipt, not just a successful local API response.",
    );
    await verifiedTarget();
    record("owned container reconnect", "PASS", {
      state: recovered.lab.evidence.connection.state,
      lastObservation: recovered.lab.evidence.connection.lastObservation,
      identityReverified: true,
    });
  }
  async function overlappingResetRejected(ownedId) {
    const current = await api();
    assert.equal(current.lab.id, ownedId);
    const scope = {
      sessionId: ownedId,
      generation: current.lab.generation,
      revision: current.lab.revision,
    };
    const resetting = await raw("/api/lab", {
      kind: "reset",
      operationId: randomUUID(),
      ...scope,
    });
    assert.equal(resetting.status, 202);
    assert.equal(resetting.data.lab.operation, "reset");
    const competing = await raw("/api/lab", {
      kind: "apply",
      operationId: randomUUID(),
      ...scope,
      source: current.lab.plan.source,
    });
    assert.equal(
      competing.status,
      409,
      "Overlapping mutations must report a conflict without applying.",
    );
    assert.match(competing.data.error, /operation|lock|busy/i);
    const restored = await poll(
      api,
      (view) =>
        view.lab?.id === ownedId &&
        !view.lab.operation &&
        view.lab.phase === "ready",
      "reset after rejected overlap",
      240000,
    );
    assert.equal(restored.lab.generation, scope.generation + 1);
    assert.equal(restored.lab.revision, scope.revision + 1);
    assert.equal(restored.lab.source, restored.lab.plan.source);
    record(
      "overlapping reset/apply",
      "PASS",
      "Apply returned409 during reset; one healthy reset completed with one generation/revision increment.",
    );
  }
  async function restartInterruptedReset(ownedId, expectedPvcUid) {
    if (process.env.WAYPOINT_MATRIX_RESTART !== "1") {
      record(
        "installed UI restart interruption",
        "NOT RUN",
        "Set WAYPOINT_MATRIX_RESTART=1 with the supplied installed node/CLI environment to authorize this owned UI lifecycle test.",
      );
      return;
    }
    const profileKey = auth.data.profile.key;
    const proof = await proveInstalledRestart({
      cli,
      state,
      output,
      broker: config,
      profileKey,
      ownedId,
      expectedPvcUid,
      api,
      raw,
      operation,
      verifiedTarget,
      privateJson,
      poll,
      bindBroker: async (newBroker) => {
        config = newBroker;
        headers.Authorization = "Bearer " + config.token;
        headers.Origin = config.origin;
        delete headers["X-Waypoint-Profile"];
        delete headers["X-Waypoint-Epoch"];
        auth = await poll(
          async () => {
            try {
              const result = await raw("/api/auth");
              return result.status === 200 ? result : null;
            } catch {
              return null;
            }
          },
          (result) => !!result,
          "restarted UI authentication initialization",
          120000,
        );
        assert.equal(
          auth.data.profile?.kind,
          "chatgpt",
          "Restart must restore the authorized account; no bypass or copied credentials.",
        );
        assert.equal(auth.data.profile.key, profileKey);
        headers["X-Waypoint-Profile"] = profileKey;
        headers["X-Waypoint-Epoch"] = String(auth.data.epoch);
      },
    });
    record("installed UI restart interruption", "PASS", proof);
  }
  async function privateJsonFileCheck(file) {
    const s = await lstat(file);
    assert(s.isFile() && !s.isSymbolicLink() && !(s.mode & 0o077));
    if (process.getuid) assert.equal(s.uid, process.getuid());
  }
  const initial = await api();
  assert(
    !initial.lab || initial.lab.phase === "stopped",
    "Finish and clean the integrator's active lab before the matrix. This script will never adopt/clean a pre-existing session.",
  );
  const cases = await writeMatrixFixtures(fixtureRoot);
  // This is an API trust-boundary rejection, not a cluster test substitute.
  const reserved = {
    format: "playground-snapshot-v2",
    id: "reserved-rejection",
    label: "reserved-rejection",
    origin: "manifests",
    captureStartedAt: null,
    captureEndedAt: null,
    files: [
      {
        id: "reserved",
        name: "reserved.yaml",
        content:
          "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: waypoint-ownership}\ndata: {nonce: not-allowed}\n",
      },
    ],
    resources: [],
    coverage: [],
    errors: [],
    contracts: [],
  };
  const rejected = await raw("/api/lab", { kind: "plan", project: reserved });
  if (rejected.status >= 400) {
    assert.match(rejected.data.error, /reserved|ownership/i);
    record(
      "reserved-marker API plan",
      "PASS",
      "Rejected before cluster creation.",
    );
  } else {
    assert(
      rejected.data.plan.blockers.some((b) => /reserved|ownership/i.test(b)),
    );
    const creation = await raw("/api/lab", {
      kind: "create",
      planHash: rejected.data.plan.planHash,
    });
    assert(creation.status >= 400);
    record(
      "reserved-marker API create",
      "PASS",
      "Rejected authored ownership collision before cluster creation.",
    );
  }
  for (const sample of cases) {
    let ownedId, ownedProfile;
    try {
      const originals = {};
      async function hashFiles(path, target = originals) {
        const { readdir } = await import("node:fs/promises");
        for (const entry of await readdir(path, { withFileTypes: true })) {
          const file = join(path, entry.name);
          if (entry.isDirectory()) await hashFiles(file, target);
          else target[file] = sha(await readFile(file));
        }
      }
      await hashFiles(sample.path);
      await exec(cli, ["import", sample.path], {
        env: process.env,
        timeout: 65000,
        maxBuffer: 8 * 1024 * 1024,
      });
      const preview = await cliJson(["lab", "plan", sample.path]);
      assert.equal(
        preview.plan.blockers.length,
        0,
        preview.plan.blockers.join("; "),
      );
      assert(preview.plan.contracts.length > 0);
      record(`${sample.name}: import/plan`, "PASS", {
        contracts: preview.plan.contracts.length,
        transformedNamespaces: Object.values(preview.plan.namespaceMap),
      });
      const created = await cliJson(["lab", "create"]);
      ownedId = created.lab.id;
      ownedProfile = created.lab.profile;
      if (sample.expectedFailure) {
        // The owned cluster startup remains bounded separately. Kubernetes's
        // progress deadline is 30s and the product rollout limit is 120s.
        const failed = await poll(
          api,
          (view) =>
            view.lab?.id === ownedId &&
            view.lab.phase === "failed" &&
            !view.lab.operation,
          "expected actual failed deployment",
          660000,
        );
        assert.match(
          failed.lab.error ?? "",
          /progress deadline|timed out|rollout|deployment/i,
        );
        assert.equal(
          failed.lab.incident,
          null,
          "This is baseline failure, not a synthetic incident.",
        );
        assert(
          !failed.lab.checks.some(
            (check) =>
              check.passed && check.name.startsWith("in-cluster Service HTTP"),
          ),
        );
        const captured = await poll(
          async () => ({ view: await api() }),
          ({ view }) => {
            const pod = view.lab.evidence.resources.find(
              (resource) =>
                resource.kind === "Pod" &&
                resource.metadata?.ownerReferences?.some(
                  (owner) => owner.kind === "ReplicaSet",
                ) &&
                !resource.metadata?.deletionTimestamp,
            );
            const status = pod?.status?.containerStatuses?.find(
              (container) => container.name === "web",
            );
            return (
              status &&
              status.restartCount > 0 &&
              status.ready === false &&
              view.lab.evidence.events.some(
                (event) =>
                  (event.involvedObject?.uid ?? event.regarding?.uid) ===
                    pod.metadata.uid &&
                  ["BackOff", "Unhealthy"].includes(event.reason),
              )
            );
          },
          "actual failed Pod and kubelet evidence",
          120000,
        );
        await verifiedTarget();
        const failureView = captured.view;
        const pod = failureView.lab.evidence.resources.find(
          (resource) =>
            resource.kind === "Pod" &&
            resource.metadata?.ownerReferences?.some(
              (owner) => owner.kind === "ReplicaSet",
            ) &&
            !resource.metadata?.deletionTimestamp,
        );
        const logScope = {
          kind: "logs",
          sessionId: ownedId,
          generation: failureView.lab.generation,
          revision: failureView.lab.revision,
          uid: pod.metadata.uid,
          container: "web",
        };
        const logs = await poll(
          async () => {
            const result = await raw("/api/lab", logScope);
            if (result.status >= 400) throw Error(result.data.error);
            return result.data.logs;
          },
          (buffer) =>
            buffer.lines.some((line) =>
              line.includes("waypoint-failed-deployment-test-only"),
            ) ||
            buffer.previous?.includes("waypoint-failed-deployment-test-only"),
          "selected failed-container actual logs",
          30000,
        );
        assert(logs.lines.length <= 500 && logs.bytes <= 256 * 1024);
        assert((logs.previous?.length ?? 0) <= 65536);
        assert.equal(
          (await raw("/api/lab", { ...logScope, kind: "closeLogs" })).status,
          202,
        );
        const filesAfter = {};
        await hashFiles(sample.path, filesAfter);
        assert.deepEqual(filesAfter, originals);
        record("failed-deployment: actual baseline failure", "PASS", {
          phase: failureView.lab.phase,
          noSimulatedSuccess: true,
          podUid: pod.metadata.uid,
          restartCount: pod.status.containerStatuses.find(
            (container) => container.name === "web",
          ).restartCount,
          kubeletReasons: [
            ...new Set(
              failureView.lab.evidence.events
                .filter(
                  (event) =>
                    (event.involvedObject?.uid ?? event.regarding?.uid) ===
                    pod.metadata.uid,
                )
                .map((event) => event.reason),
            ),
          ],
          selectedContainerLog: true,
          boundedBuffer: true,
          originalsUnchanged: true,
        });
        continue; // finally still cleans exactly this owned failed profile.
      }
      const ready = await poll(
        api,
        (view) =>
          view.lab?.id === ownedId &&
          view.lab.phase === "ready" &&
          !view.lab.operation,
        "healthy baseline",
        660000,
      );
      assert(
        ready.lab.checks.some(
          (check) =>
            check.passed && check.name.startsWith("in-cluster Service HTTP"),
        ),
        "Actual Service HTTP evidence required.",
      );
      record(`${sample.name}: healthy baseline`, "PASS", {
        profile: ready.lab.profile,
        checks: ready.lab.checks.map((c) => ({
          name: c.name,
          passed: c.passed,
          detail: c.detail,
        })),
      });
      const observedPod = ready.lab.evidence.resources.find(
        (resource) =>
          resource.kind === "Pod" &&
          resource.metadata?.ownerReferences?.some(
            (owner) => owner.kind === "ReplicaSet",
          ) &&
          !resource.metadata?.deletionTimestamp,
      );
      assert(
        observedPod,
        "An observed current application Pod is required for log-selection checks.",
      );
      for (const [uid, container, reason] of [
        [observedPod.metadata.uid, "not-a-container", /not present/i],
        [randomUUID(), "web", /no longer present/i],
      ]) {
        const logs = await raw("/api/lab", {
          kind: "logs",
          sessionId: ready.lab.id,
          generation: ready.lab.generation,
          revision: ready.lab.revision,
          uid,
          container,
        });
        assert(logs.status >= 400);
        assert.match(logs.data.error, reason);
      }
      record(
        `${sample.name}: explicit initial log errors`,
        "PASS",
        "Unknown container and absent Pod UID rejected explicitly; no fake log output.",
      );
      const initScope = {
        kind: "logs",
        sessionId: ready.lab.id,
        generation: ready.lab.generation,
        revision: ready.lab.revision,
        uid: observedPod.metadata.uid,
        container: "setup",
      };
      const initResult = await poll(
        async () => {
          const result = await raw("/api/lab", initScope);
          if (result.status >= 400) throw Error(result.data.error);
          return result.data;
        },
        (result) =>
          result.logs?.lines.some((line) =>
            line.includes("waypoint-init-test-only"),
          ),
        "actual init-container logs",
        30000,
      );
      assert(initResult.logs.lines.every((line) => !line.includes("Bearer ")));
      const closed = await raw("/api/lab", { ...initScope, kind: "closeLogs" });
      assert.equal(closed.status, 202);
      record(
        `${sample.name}: actual init-container logs`,
        "PASS",
        "Selected setup container output retained in its UID-scoped bounded buffer; subscription closed.",
      );
      if (sample.name === "plain-cronjob-pvc") {
        await disconnectAndRecover(ownedId);
        await overlappingResetRejected(ownedId);
        assert(
          ready.lab.checks.some(
            (check) =>
              /awaiting execution/.test(check.name) &&
              /not been verified/.test(check.detail),
          ),
        );
        const reviewed = ready.scheduledExecutions.find(
          (entry) => entry.name === "matrix-once",
        );
        assert(reviewed);
        const noConfirm = await exec(
          cli,
          ["lab", "run-cronjob", reviewed.target],
          { env: process.env, timeout: 65000 },
        ).then(
          () => null,
          (error) => error,
        );
        assert(noConfirm, "CLI must require the reviewed --confirm action.");
        const { direct, target } = await verifiedTarget();
        const pvcBefore = JSON.parse(
          await direct([
            "-n",
            target.namespace,
            "get",
            "pvc",
            "matrix-data",
            "-o",
            "json",
          ]),
        );
        await exec(cli, ["lab", "run-cronjob", reviewed.target, "--confirm"], {
          env: process.env,
          timeout: 65000,
          maxBuffer: 8 * 1024 * 1024,
        });
        await poll(
          api,
          (view) => view.lab?.id === ownedId && !view.lab.operation,
          "CronJob one-run request",
        );
        const completed = await poll(
          async () =>
            JSON.parse(
              await direct([
                "-n",
                target.namespace,
                "get",
                "jobs",
                "-o",
                "json",
              ]),
            ),
          (jobs) =>
            jobs.items.some(
              (job) =>
                job.metadata.ownerReferences?.some(
                  (owner) =>
                    owner.kind === "CronJob" && owner.name === "matrix-once",
                ) &&
                job.status.conditions?.some(
                  (condition) =>
                    condition.type === "Complete" &&
                    condition.status === "True",
                ),
            ),
          "CronJob completion",
        );
        const job = completed.items.find((job) =>
          job.metadata.ownerReferences?.some(
            (owner) => owner.name === "matrix-once",
          ),
        );
        const webPod = JSON.parse(
          await direct([
            "-n",
            target.namespace,
            "get",
            "pods",
            "-l",
            "app=matrix-web",
            "-o",
            "json",
          ]),
        ).items.find((pod) => !pod.metadata.deletionTimestamp);
        assert.equal(
          (
            await direct([
              "-n",
              target.namespace,
              "exec",
              webPod.metadata.name,
              "-c",
              "web",
              "--",
              "cat",
              "/data/sentinel",
            ])
          ).trim(),
          "waypoint-matrix-test-only",
        );
        record("CronJob reviewed one-run", "PASS", {
          jobUid: job.metadata.uid,
          completed: true,
          actualPVCMarker: true,
        });
        const reset = await operation("reset");
        assert.equal(reset.lab.phase, "ready");
        const verified = await verifiedTarget();
        const pvcAfter = JSON.parse(
          await verified.direct([
            "-n",
            verified.target.namespace,
            "get",
            "pvc",
            "matrix-data",
            "-o",
            "json",
          ]),
        );
        assert.equal(pvcAfter.metadata.uid, pvcBefore.metadata.uid);
        const currentPod = JSON.parse(
          await verified.direct([
            "-n",
            verified.target.namespace,
            "get",
            "pods",
            "-l",
            "app=matrix-web",
            "-o",
            "json",
          ]),
        ).items.find((pod) => !pod.metadata.deletionTimestamp);
        assert.equal(
          (
            await verified.direct([
              "-n",
              verified.target.namespace,
              "exec",
              currentPod.metadata.name,
              "-c",
              "web",
              "--",
              "cat",
              "/data/sentinel",
            ])
          ).trim(),
          "waypoint-matrix-test-only",
        );
        const jobsAfter = JSON.parse(
          await verified.direct([
            "-n",
            verified.target.namespace,
            "get",
            "jobs",
            "-o",
            "json",
          ]),
        );
        assert(
          jobsAfter.items.some((j) => j.metadata.uid === job.metadata.uid),
        );
        record("reset PVC and Job preservation", "PASS", {
          pvcUidUnchanged: true,
          sentinelRetained: true,
          completedJobUidUnchanged: true,
        });
        await restartInterruptedReset(ownedId, pvcBefore.metadata.uid);
      }
      const live = await api();
      for (const source of [
        "spec: [",
        live.lab.plan.source.replace("replicas: 1", "replicas: 0"),
      ]) {
        const bad = await raw("/api/lab", {
          kind: "apply",
          operationId: randomUUID(),
          sessionId: live.lab.id,
          generation: live.lab.generation,
          revision: live.lab.revision,
          source,
        });
        assert(
          bad.status >= 400,
          "Malformed/shortcut repair must reject before mutation.",
        );
      }
      const same = await api();
      assert.equal(same.lab.revision, live.lab.revision);
      assert.equal(same.lab.source, live.lab.source);
      record(
        `${sample.name}: invalid and constrained repair rejection`,
        "PASS",
        "Malformed YAML and scale-to-zero rejected without revision or source changes.",
      );
      const filesAfter = {};
      await hashFiles(sample.path, filesAfter);
      assert.deepEqual(
        filesAfter,
        originals,
        "Renderer must not add, delete or edit original fixture files.",
      );
      record(
        `${sample.name}: immutable original files`,
        "PASS",
        "All generated fixture file hashes remain unchanged.",
      );
    } catch (error) {
      failures.push(sample.name);
      record(sample.name, "FAIL", String(error.message).slice(0, 1000));
    } finally {
      if (ownedId) {
        try {
          const view = await api();
          assert.equal(
            view.lab.id,
            ownedId,
            "Refuse cleanup of a different session.",
          );
          await operation("cleanup");
          const survivingNames = (
            await exec("docker", ["ps", "-a", "--format", "{{.Names}}"])
          ).stdout.split("\n");
          assert(
            !survivingNames.includes(ownedProfile),
            "Owned Minikube driver container must actually be removed.",
          );
          const stopped = await api();
          assert.equal(stopped.lab.phase, "stopped");
          const again = await raw("/api/lab", {
            kind: "cleanup",
            operationId: randomUUID(),
            sessionId: ownedId,
            generation: stopped.lab.generation,
            revision: stopped.lab.revision,
          });
          assert(again.status >= 400 && /stopped/.test(again.data.error));
          record(
            `${sample.name}: cleanup repeated safely`,
            "PASS",
            "Owned profile stopped; a new duplicate cleanup request rejected without a second mutation.",
          );
        } catch (error) {
          failures.push(`${sample.name} cleanup`);
          record(
            `${sample.name}: cleanup`,
            "FAIL",
            String(error.message).slice(0, 1000),
          );
          break;
        }
      }
    }
  }
  await writeFile(
    report,
    JSON.stringify(
      {
        node: process.version,
        executable: cli,
        installedArtifact: true,
        auth: "real account",
        images: ["nginx:1.28-alpine", "busybox:1.37"],
        imageBuilds: false,
        checks,
        failures,
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  for (const check of checks) console.log(`${check.status} ${check.name}`);
  if (failures.length) process.exitCode = 1;
}
if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main().catch(async (error) => {
    console.error(String(error.message).slice(0, 1000));
    if (report)
      await writeFile(
        report,
        JSON.stringify(
          { checks, failures, fatal: String(error.message).slice(0, 1000) },
          null,
          2,
        ),
        { mode: 0o600 },
      );
    process.exitCode = 1;
  });
