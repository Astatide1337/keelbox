import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { MinikubeRuntime } from "../../lib/server/minikube-runtime";
test("a live competing operation lock rejects before changing the session journal", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-lock-test-"));
  const id = randomUUID(),
    file = join(root, "minikube-session.json");
  const session = {
    id,
    phase: "running",
    operation: null,
    generation: 1,
    revision: 0,
    target: {
      kubeconfig: "/private/test",
      profile: "waypoint-test",
      namespace: "lab",
    },
    operations: {},
    checks: [],
    error: null,
  };
  const original = JSON.stringify(session);
  await writeFile(file, original, { mode: 0o600 });
  const holder = spawn("flock", [
    "--exclusive",
    join(root, "lab-operation.lock"),
    "sh",
    "-c",
    "printf READY; cat >/dev/null",
  ]);
  await new Promise<void>((resolve) =>
    holder.stdout.once("data", () => resolve()),
  );
  const runtime = new MinikubeRuntime(root);
  await runtime.load();
  await assert.rejects(
    runtime.operate(
      {
        kind: "check",
        operationId: randomUUID(),
        sessionId: id,
        generation: 1,
        revision: 0,
      },
      () => {},
    ),
    /owns the operation lock/,
  );
  assert.equal(await readFile(file, "utf8"), original);
  holder.stdin.end();
});
test("parallel initialization does not race or overwrite an interrupted session", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-load-test-"));
  const session = {
    id: randomUUID(),
    phase: "preparing",
    operation: "create",
    generation: 1,
    revision: 0,
    target: {
      kubeconfig: "/private/test",
      profile: "waypoint-test",
      namespace: "lab",
    },
    operations: {},
    checks: [],
    error: null,
  };
  const file = join(root, "minikube-session.json"),
    original = JSON.stringify(session);
  await writeFile(file, original, { mode: 0o600 });
  const runtime = new MinikubeRuntime(root);
  await Promise.all([runtime.load(), runtime.load(), runtime.load()]);
  assert.equal(await readFile(file, "utf8"), original);
  assert.equal(runtime.view().lab?.phase, "failed");
});

test("a stale PID file cannot yield simultaneous kernel-lock owners", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-flock-test-"));
  await writeFile(join(root, "lab-operation.lock"), "2147483647", {
    mode: 0o600,
  });
  const runtimes = Array.from({ length: 12 }, () => new MinikubeRuntime(root));
  const results = await Promise.allSettled(
    runtimes.map((r) =>
      (
        r as unknown as {
          acquire: () => Promise<{ close: () => Promise<void> }>;
        }
      ).acquire(),
    ),
  );
  const owners = results.filter(
    (r): r is PromiseFulfilledResult<{ close: () => Promise<void> }> =>
      r.status === "fulfilled",
  );
  assert.equal(owners.length, 1);
  await owners[0].value.close();
});
