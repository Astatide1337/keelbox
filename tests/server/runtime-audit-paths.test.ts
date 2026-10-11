import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { stringify } from "yaml";
import {
  MinikubeRuntime,
  type LiveLab,
} from "../../lib/server/minikube-runtime";
import { deploymentPlan } from "../../lib/domain/deployment-plan";
import { readManifestInputs } from "../../lib/server/project-store";
import { at, list, object } from "../../lib/domain/types";

async function setup(phase: LiveLab["phase"] = "running") {
  const root = await mkdtemp(join(tmpdir(), "waypoint-runtime-audit-"));
  const plan = deploymentPlan(
    await readManifestInputs(["examples/local-http"]),
    "waypoint-lab-0123456789ab",
  );
  const lab = {
    id: randomUUID(),
    profile: "waypoint-test",
    namespace: plan.namespace,
    phase,
    operation: null,
    generation: 1,
    revision: 2,
    plan,
    source: plan.source,
    incident: "readiness",
    target: {
      home: root,
      kubeconfig: join(root, "config"),
      profile: "waypoint-test",
      namespace: plan.namespace,
      nonce: "unit-test-only",
    },
    operations: {},
    checks: [],
    error: null,
    startedAt: new Date().toISOString(),
  } as LiveLab;
  const file = join(root, "minikube-session.json");
  const original = JSON.stringify(lab);
  await writeFile(file, original, { mode: 0o600 });
  const runtime = new MinikubeRuntime(root);
  await runtime.load();
  return {
    root,
    lab,
    runtime,
    file,
    original,
    scope: {
      sessionId: lab.id,
      generation: lab.generation,
      revision: lab.revision,
    },
  };
}

test("ownership collision rejects runtime create before doctor, cluster creation or journal", async () => {
  const context = await setup("stopped");
  try {
    const malicious = structuredClone(context.lab.plan);
    malicious.resources.push({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: { name: "waypoint-ownership", namespace: malicious.namespace },
    });
    malicious.source = malicious.resources
      .map((r) => stringify(r))
      .join("---\n");
    (context.runtime as unknown as { pending: typeof malicious }).pending =
      malicious;
    await assert.rejects(
      context.runtime.create(malicious.planHash, () => {}),
      /reserved/,
    );
    assert.equal(await readFile(context.file, "utf8"), context.original);
    assert.equal(context.runtime.view().lab?.phase, "stopped");
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("repeated cleanup of a stopped lab rejects before external processes and preserves journal", async () => {
  const context = await setup("stopped");
  try {
    for (let i = 0; i < 3; i++)
      await assert.rejects(
        context.runtime.operate(
          { kind: "cleanup", operationId: randomUUID(), ...context.scope },
          () => {},
        ),
        /stopped/,
      );
    assert.equal(await readFile(context.file, "utf8"), context.original);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("runtime apply rejects malformed YAML, deleted resources, scaling to zero and disabled probes before mutation", async () => {
  const context = await setup();
  try {
    const sources = ["spec: ["];
    for (const shortcut of ["zero", "probe", "delete"]) {
      const altered = structuredClone(context.lab.plan.resources);
      const deployment = altered.find((r) => r.kind === "Deployment")!;
      if (shortcut === "zero") object(deployment.spec).replicas = 0;
      if (shortcut === "probe")
        delete list(at(deployment, "spec", "template", "spec", "containers"))[0]
          .readinessProbe;
      if (shortcut === "delete") altered.splice(altered.indexOf(deployment), 1);
      sources.push(altered.map((r) => stringify(r)).join("---\n"));
    }
    for (const source of sources)
      await assert.rejects(
        context.runtime.operate(
          {
            kind: "apply",
            source,
            operationId: randomUUID(),
            ...context.scope,
          },
          () => {},
        ),
      );
    assert.equal(await readFile(context.file, "utf8"), context.original);
    assert.equal(context.runtime.view().lab?.revision, context.scope.revision);
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("initial log connection failure is explicit and late replies reject the changed lab scope", async () => {
  const context = await setup();
  try {
    await assert.rejects(
      context.runtime.logs(randomUUID(), "web", false, context.scope),
      /observations unavailable/,
    );
    const runtime = context.runtime as unknown as {
      cache: { follow: () => Promise<unknown> };
      lab: LiveLab;
    };
    runtime.cache = {
      follow: async () => {
        throw Error("Selected container log HTTP 403");
      },
    };
    await assert.rejects(
      context.runtime.logs(randomUUID(), "web", false, context.scope),
      /HTTP 403/,
    );
    runtime.cache = {
      follow: async () => {
        runtime.lab.revision++;
        return { lines: ["late old-generation log"] };
      },
    };
    await assert.rejects(
      context.runtime.logs(randomUUID(), "web", false, context.scope),
      /Lab changed/,
    );
  } finally {
    await rm(context.root, { recursive: true, force: true });
  }
});

test("installed live-matrix YAML fixture is deployable and schedules no implicit CronJob run", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-matrix-fixture-"));
  try {
    const module = await import(
      pathToFileURL(resolve("tests/e2e/installed-live-matrix.mjs")).href
    );
    const fixtures = await module.writeMatrixFixtures(root);
    const project = await readManifestInputs([fixtures[0].path]);
    const plan = deploymentPlan(project, "waypoint-lab-0123456789ab");
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.contracts.length, 1);
    assert(plan.resources.some((r) => r.kind === "PersistentVolumeClaim"));
    const cron = plan.resources.find((r) => r.kind === "CronJob")!;
    assert.equal(at(cron, "spec", "suspend"), true);
    assert.equal(at(cron, "spec", "schedule"), "0 0 * * *");
    assert.equal(fixtures.length, 4);
    const failed = fixtures.find(
      (fixture: { name: string }) => fixture.name === "failed-deployment",
    );
    assert.equal(failed.expectedFailure, true);
    const failedPlan = deploymentPlan(
      await readManifestInputs([failed.path]),
      "waypoint-lab-0123456789ab",
    );
    assert.deepEqual(failedPlan.blockers, []);
    const failingDeployment = failedPlan.resources.find(
      (resource) => resource.kind === "Deployment",
    )!;
    assert.equal(at(failingDeployment, "spec", "progressDeadlineSeconds"), 30);
    assert.match(
      String(
        at(
          failingDeployment,
          "spec",
          "template",
          "spec",
          "containers",
          "0",
          "command",
        ),
      ),
      /exit 42/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
