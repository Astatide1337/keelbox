import { basename, join, resolve } from "node:path";
import { tmpdir, cpus, freemem, totalmem, platform, arch } from "node:os";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { readManifestInputs } from "../lib/server/project-store";
import { MinikubeRuntime, type LiveLab } from "../lib/server/minikube-runtime";
import { kube, minikubeBinary } from "../lib/server/minikube";
import { run } from "../lib/server/process";
import { targetKey } from "../lib/domain/generated-incident";
import type { LiveIncidentId } from "../lib/domain/live-incidents";

const enabled = process.env.WAYPOINT_LIVE_MARKET_DATA === "1";
const stateRoot = process.env.PLAYGROUND_STATE_DIR;
const outputPath = resolve(
  process.env.WAYPOINT_PROOF_OUT ??
    "/tmp/waypoint-market-data-cluster-proof.json",
);
const tempRoot = resolve(tmpdir());
if (
  !enabled ||
  !stateRoot ||
  !resolve(stateRoot).startsWith(tempRoot + "/") ||
  !outputPath.startsWith(tempRoot + "/")
)
  throw Error(
    "Set WAYPOINT_LIVE_MARKET_DATA=1 with a fresh private PLAYGROUND_STATE_DIR and a new WAYPOINT_PROOF_OUT path below the system temp directory. This opt-in script creates and deletes one dedicated Waypoint Minikube profile.",
  );
const resolvedStateRoot = resolve(stateRoot);
if (
  outputPath === resolvedStateRoot ||
  outputPath.startsWith(resolvedStateRoot + "/")
)
  throw Error("Proof output must be outside the private state directory.");

const root = resolve(process.cwd());
const statePath = resolvedStateRoot;
const runtime = new MinikubeRuntime(join(statePath, "runtime"));
const internals = runtime as unknown as {
  lab: LiveLab | null;
  marketDataProducerPod: () => Promise<{ name: string; uid: string }>;
};
const startedAt = new Date().toISOString();
let stateRootCreated = false;
let ownedLabId: string | null = null;
const proof: Record<string, unknown> = {
  startedAt,
  environment: {
    node: process.version,
    platform: platform(),
    architecture: arch(),
    logicalCpus: cpus().length,
    memoryBytes: { total: totalmem(), availableAtStart: freemem() },
    clusterProfile:
      "generated unique Waypoint profile (recorded after creation)",
    driver: "docker",
    workload: {
      replicas: 1,
      producerImage: "python:3.12.15-slim-trixie",
      consumerImage: "python:3.12.15-slim-trixie",
      producerUpdateIntervalSeconds: 0.5,
      consumerPollIntervalSeconds: 0.25,
      freshnessWindowSeconds: 3.0,
      resourcesPerPod: {
        requests: { cpu: "10m", memory: "48Mi" },
        limits: { cpu: "100m", memory: "96Mi" },
      },
    },
  },
  incidents: [],
  measurement: null,
  cleanup: "pending",
};

function currentLab() {
  const lab = runtime.view().lab;
  if (!lab) throw Error("Waypoint lab session disappeared.");
  return lab;
}

async function ensureFreshRunPaths() {
  for (const [path, label] of [
    [statePath, "State directory"],
    [outputPath, "Proof output file"],
  ] as const) {
    try {
      await lstat(path);
      throw Error(`${label} already exists; choose a fresh private path.`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  await mkdir(statePath, { mode: 0o700 });
  stateRootCreated = true;
}

async function waitFor(
  label: string,
  predicate: (lab: ReturnType<typeof currentLab>) => boolean,
  timeoutMs = 600000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const lab = currentLab();
    if (lab.phase === "failed" || (lab.error && !lab.operation))
      throw Error(
        `${label} failed: ${lab.error ?? "runtime reported failed state"}`,
      );
    if (predicate(lab) && !lab.operation) return lab;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw Error(
    `${label} did not finish within ${Math.round(timeoutMs / 1000)} seconds.`,
  );
}

async function operate(kind: string, extra: Record<string, unknown> = {}) {
  const lab = currentLab();
  await runtime.operate(
    {
      kind,
      operationId: randomUUID(),
      sessionId: lab.id,
      generation: lab.generation,
      revision: lab.revision,
      ...extra,
    },
    () => {},
  );
}

async function settleIncident(id: LiveIncidentId, target: string) {
  const before = currentLab();
  await operate("incident", { incident: id, target });
  const faulted = await waitFor(
    `${id} proof`,
    (lab) =>
      lab.phase === "running" &&
      lab.incident === id &&
      !!lab.incidentObservedAt,
  );
  const faultEvidence = {
    incident: id,
    target,
    checks: faulted.checks,
    evidence: faulted.incidentEvidence ?? null,
    observedAt: faulted.incidentObservedAt,
  };
  await operate("repair");
  await waitFor(
    `${id} baseline repair`,
    (lab) => lab.phase === "running" && lab.revision > faulted.revision,
  );
  await operate("check");
  const recovered = await waitFor(
    `${id} recovery grade`,
    (lab) => lab.phase === "completed" && lab.revision > faulted.revision,
  );
  const record = {
    ...faultEvidence,
    recoveryChecks: recovered.checks,
    recoveryEvidence:
      id === "market-data-stale" ? (recovered.incidentEvidence ?? null) : null,
    generation: before.generation,
    revisionAfterRecovery: recovered.revision,
    result: "PASS",
  };
  (proof.incidents as unknown[]).push(record);
  await operate("reset");
  await waitFor(
    `${id} clean reset`,
    (lab) =>
      lab.phase === "ready" &&
      lab.generation > recovered.generation &&
      !lab.incident,
  );
}

async function collectInfrastructureEvidence() {
  const lab = currentLab();
  const privateTarget = internals.lab?.target;
  if (!privateTarget) throw Error("Private owned target receipt unavailable.");
  const version = JSON.parse(
    await kube(privateTarget, ["version", "-o", "json"]),
  );
  const node = JSON.parse(
    await kube(privateTarget, ["get", "nodes", "-o", "json"]),
  );
  const namespace = lab.namespace;
  const pods = JSON.parse(
    await kube(privateTarget, ["-n", namespace, "get", "pods", "-o", "json"]),
  );
  const imageIds = (pods.items ?? []).flatMap((pod: Record<string, any>) =>
    (pod.status?.containerStatuses ?? []).map(
      (container: Record<string, unknown>) => ({
        workload: pod.metadata?.labels?.app,
        image: container.image,
        imageID: container.imageID,
      }),
    ),
  );
  return {
    kubernetes: version.serverVersion,
    node: (node.items ?? []).map((item: Record<string, any>) => ({
      architecture: item.status?.nodeInfo?.architecture,
      kubeletVersion: item.status?.nodeInfo?.kubeletVersion,
      capacity: item.status?.capacity,
      allocatable: item.status?.allocatable,
    })),
    imageIds,
  };
}

async function runMeasurement(environmentNote: string) {
  const lab = currentLab(),
    target = internals.lab?.target;
  if (!target)
    throw Error("Private owned target receipt unavailable for measurement.");
  const ns = lab.plan.namespaceMap?.["waypoint-market-data"] ?? lab.namespace;
  const { withOwnedPodControlForward, withOwnedServicePortForward } =
    await import("../lib/server/loopback-port-forward");
  const producerPod = await internals.marketDataProducerPod();
  return withOwnedServicePortForward(
    target,
    ns,
    "market-producer",
    8080,
    (producerUrl) =>
      withOwnedPodControlForward(target, ns, producerPod, (controlUrl) =>
        withOwnedServicePortForward(
          target,
          ns,
          "market-consumer",
          8081,
          async (consumerUrl) => {
            const raw = await run(
              "python3",
              [
                join(root, "examples/market-data/tools/measure_detection.py"),
                "--producer-url",
                producerUrl,
                "--control-url",
                controlUrl,
                "--consumer-url",
                consumerUrl,
                "--trials",
                "5",
                "--poll-interval",
                "0.1",
                "--environment-note",
                environmentNote,
                "--workload-mode",
                "kubernetes-port-forward",
              ],
              { timeout: 180000, limit: 200000 },
            );
            return JSON.parse(raw);
          },
        ),
      ),
  );
}

async function main() {
  proof.environment = {
    ...(proof.environment as Record<string, unknown>),
    docker: await run("docker", ["info", "--format", "{{.ServerVersion}}"]),
    minikube: (await run(minikubeBinary(), ["version", "--short"])).trim(),
    kubectlClient: (
      await run("kubectl", ["version", "--client=true", "-o", "json"])
    ).trim(),
  };
  await runtime.load();
  if (runtime.view().lab)
    throw Error("Fresh proof state unexpectedly contains an existing lab.");
  const project = await readManifestInputs([
    join(root, "examples/market-data"),
  ]);
  const preview = await runtime.plan(project);
  if (!preview.plan || preview.plan.blockers.length)
    throw Error(
      `Fixture deployment plan is blocked: ${preview.plan?.blockers.join("; ") ?? "missing plan"}`,
    );
  const existingLabId = runtime.view().lab?.id ?? null;
  let created: Awaited<ReturnType<typeof runtime.create>> | null = null;
  try {
    created = await runtime.create(preview.plan.planHash, () => {});
  } finally {
    const labAfterCreate = runtime.view().lab;
    if (!existingLabId && labAfterCreate) ownedLabId = labAfterCreate.id;
  }
  if (!created?.lab) throw Error("Waypoint did not create the lab session.");
  ownedLabId = created.lab.id;
  await waitFor("owned Minikube baseline", (lab) => lab.phase === "ready");
  const lab = currentLab();
  proof.environment = {
    ...(proof.environment as Record<string, unknown>),
    clusterProfile: lab.profile,
    clusterNamespace: lab.namespace,
    ...(await collectInfrastructureEvidence()),
  };
  const target = targetKey(
    (lab.plan.contracts ?? []).find(
      (contract) => contract.deployment === "market-producer",
    )!,
    lab.namespace,
  );
  const env = proof.environment as Record<string, unknown>;
  const measurementNote = [
    `Minikube ${String(env.minikube)}`,
    `Kubernetes ${JSON.stringify(env.kubernetes)}`,
    `Docker ${String(env.docker).trim()}`,
    "single-node Docker driver",
    `host ${String(env.logicalCpus)} logical CPUs/${String((env.memoryBytes as Record<string, unknown>).availableAtStart)} available bytes at start/${String(env.architecture)}`,
    `node ${JSON.stringify(env.node)}`,
    `image IDs ${JSON.stringify(env.imageIds)}`,
    "workload declares requests 10m CPU/48Mi and limits 100m CPU/96Mi per pod",
  ].join("; ");
  proof.measurement = await runMeasurement(measurementNote);

  await settleIncident("market-data-stale", target);
  await settleIncident("service-selector", target);
  await settleIncident("service-target-port", target);
  await settleIncident("image-pull", target);
  await settleIncident("configmap-key", target);
  await settleIncident("readiness", target);
  await settleIncident("liveness", target);
  proof.cleanup = "PASS: deleting only the Waypoint-owned Minikube profile";
}

async function execute() {
  try {
    await ensureFreshRunPaths();
    await main();
  } catch (error) {
    proof.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    try {
      const lab = runtime.view().lab;
      if (ownedLabId && lab?.id === ownedLabId && lab.phase !== "stopped") {
        await operate("cleanup");
        await waitFor(
          "owned profile cleanup",
          (current) => current.phase === "stopped",
          180000,
        );
        proof.cleanup = "PASS: only the Waypoint-owned profile was deleted";
      } else if (
        ownedLabId &&
        lab?.id === ownedLabId &&
        lab.phase === "stopped"
      ) {
        proof.cleanup = "PASS: owned profile already stopped";
      } else if (lab && lab.phase !== "stopped") {
        proof.cleanup =
          "BLOCKED: refused to clean up a lab not created by this proof run";
        process.exitCode = 1;
      } else {
        proof.cleanup = "PASS: no lab profile was created";
      }
    } catch (error) {
      proof.cleanup = `BLOCKED: ${(error as Error).message}`;
      process.exitCode = 1;
    }
    (proof as Record<string, unknown>).finishedAt = new Date().toISOString();
    const incidents = proof.incidents as Array<{ result?: unknown }>;
    const measurement = proof.measurement as { trials?: unknown[] } | null;
    const cleanupPassed =
      typeof proof.cleanup === "string" && proof.cleanup.startsWith("PASS:");
    const complete =
      proof.error === undefined &&
      cleanupPassed &&
      incidents.length === 7 &&
      incidents.every((incident) => incident.result === "PASS") &&
      Array.isArray(measurement?.trials) &&
      measurement.trials.length === 5;
    proof.status = complete ? "PASS" : "FAIL";
    if (!complete) process.exitCode = 1;
    else if (process.exitCode === undefined) process.exitCode = 0;
    runtime.close();
    if (stateRootCreated && cleanupPassed) {
      try {
        await rm(statePath, { recursive: true, force: true });
        proof.stateCleanup = "PASS: private state directory removed";
      } catch (error) {
        proof.stateCleanup = `BLOCKED: ${(error as Error).message}`;
        proof.status = "FAIL";
        process.exitCode = 1;
      }
    } else {
      proof.stateCleanup = stateRootCreated
        ? "RETAINED: profile cleanup did not pass; private recovery state preserved"
        : "NOT CREATED: proof state directory was already present or could not be claimed";
    }
    await writeFile(outputPath, JSON.stringify(proof, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(
      JSON.stringify({
        outputPath: basename(outputPath),
        status: proof.status,
        cleanup: proof.cleanup,
      }),
    );
  }
}

void execute();
