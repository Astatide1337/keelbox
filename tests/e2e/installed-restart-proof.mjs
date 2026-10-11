/** Explicitly opted-in interruption proof. Uses only the supplied installed product and its owned UI/cluster. */
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readFile, realpath, readlink, open } from "node:fs/promises";
import { join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
const exec = promisify(execFile);

export async function proveInstalledRestart(context) {
  const {
    cli,
    state,
    output,
    broker,
    profileKey,
    ownedId,
    expectedPvcUid,
    api,
    raw,
    operation,
    verifiedTarget,
    privateJson,
    poll,
    bindBroker,
  } = context;
  const executable = await realpath(cli);
  const node = await realpath(
    process.env.WAYPOINT_MATRIX_NODE ?? process.execPath,
  );
  const origin = new URL(broker.origin);
  assert(
    origin.protocol === "http:" &&
      origin.hostname === "127.0.0.1" &&
      origin.pathname === "/" &&
      !origin.username &&
      !origin.password &&
      !origin.search &&
      !origin.hash,
    "Only the supplied loopback UI may be restarted.",
  );
  async function verifyProcess(candidate) {
    assert.equal(candidate.origin, broker.origin);
    assert(Number.isSafeInteger(candidate.pid) && candidate.pid > 1);
    const directory = `/proc/${candidate.pid}`;
    const stat = await lstat(directory);
    if (process.getuid) assert.equal(stat.uid, process.getuid());
    const argv = (await readFile(join(directory, "cmdline"), "utf8"))
      .split("\0")
      .filter(Boolean);
    assert.equal(
      argv.length,
      3,
      "Only the supplied installed CLI start process may be stopped.",
    );
    assert.equal(await realpath(argv[1]), executable);
    assert.equal(argv[2], "start");
    assert.equal(await readlink(join(directory, "exe")), node);
    const processStat = await readFile(join(directory, "stat"), "utf8");
    return processStat.slice(processStat.lastIndexOf(")") + 2).split(" ")[19];
  }
  await verifiedTarget();
  const before = await api();
  assert.equal(before.lab.id, ownedId);
  const oldBroker = await privateJson(join(state, "server.json"));
  const processStart = await verifyProcess(oldBroker);
  const scope = {
    sessionId: ownedId,
    generation: before.lab.generation,
    revision: before.lab.revision,
  };
  const reset = await raw("/api/lab", {
    kind: "reset",
    operationId: randomUUID(),
    ...scope,
  });
  assert.equal(reset.status, 202);
  const journalPath = join(
    state,
    "profiles",
    profileKey,
    "runtime",
    "minikube-session.json",
  );
  const active = await privateJson(journalPath);
  assert.equal(active.id, ownedId);
  assert.equal(
    active.operation,
    "reset",
    "Stop must occur while the real journal operation is active.",
  );
  assert.equal(
    await verifyProcess(oldBroker),
    processStart,
    "Refuse stopping a recycled UI PID.",
  );
  process.kill(oldBroker.pid, "SIGTERM");
  await poll(
    async () => {
      try {
        process.kill(oldBroker.pid, 0);
        return false;
      } catch (error) {
        if (error.code === "ESRCH") return true;
        throw error;
      }
    },
    (stopped) => stopped,
    "verified installed UI stop",
    30000,
  );
  const journal = await privateJson(journalPath);
  const wasInterrupted = journal.operation === "reset";
  const startupPath = join(
    output,
    "installed-restart-" + randomUUID() + ".log",
  );
  const startup = await open(startupPath, "wx", 0o600);
  const child = spawn(node, [executable, "start"], {
    // Keep the verified broker-managed UI out of the runner's process group:
    // exec harnesses may terminate that entire group when the runner exits.
    // The integrator still owns final shutdown through the verified broker.
    detached: true,
    cwd: dirname(executable),
    env: {
      ...process.env,
      PORT: new URL(broker.origin).port,
      PLAYGROUND_STATE_DIR: state,
    },
    stdio: ["ignore", startup.fd, startup.fd],
  });
  let spawnError;
  child.once("error", (error) => {
    spawnError = error;
  });
  child.unref(); // The verified broker makes the owned UI discoverable for the integrator's final shutdown.
  await startup.close();
  let newBroker;
  try {
    newBroker = await poll(
      async () => {
        if (spawnError) throw spawnError;
        if (child.exitCode !== null)
          throw Error(
            `Restarted installed CLI exited with code ${child.exitCode}. Inspect its protected startup log without exporting the connection capability.`,
          );
        try {
          const candidate = await privateJson(join(state, "server.json"));
          if (candidate.pid !== child.pid) return null;
          await verifyProcess(candidate);
          return candidate;
        } catch (error) {
          if (error.code === "ENOENT") return null;
          throw error;
        }
      },
      (candidate) => !!candidate,
      "restarted installed CLI broker",
      120000,
    );
  } catch (error) {
    // A child without a discoverable broker must not be left behind.
    child.kill("SIGTERM");
    throw error;
  }
  await bindBroker(newBroker); // Refresh capability/account epoch internally. Neither is returned in evidence.
  // Restore a discoverable usable UI even when graceful shutdown happened to
  // finish the reset. That outcome fails interruption proof, but must not
  // prevent the caller's typed owned-cluster cleanup.
  assert(
    wasInterrupted,
    "Reset completed during shutdown; interruption was not demonstrated.",
  );
  const interrupted = await api();
  assert.equal(interrupted.lab.id, ownedId);
  assert.equal(interrupted.lab.phase, "failed");
  assert.match(interrupted.lab.error, /interrupted/i);
  assert.equal(interrupted.lab.operation, null);
  const recovered = await operation("recover");
  assert.equal(recovered.lab.phase, "ready");
  assert(
    recovered.lab.checks.some(
      (check) =>
        check.passed && check.name.startsWith("in-cluster Service HTTP"),
    ),
  );
  await poll(
    api,
    (view) =>
      view.lab?.id === ownedId &&
      view.lab.evidence.connection.state === "current",
    "confirmed observations after restart recovery",
    120000,
  );
  const { direct, target } = await verifiedTarget();
  const pvc = JSON.parse(
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
  assert.equal(pvc.metadata.uid, expectedPvcUid);
  const pods = JSON.parse(
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
  );
  const pod = pods.items.find(
    (candidate) => !candidate.metadata.deletionTimestamp,
  );
  assert.equal(
    (
      await direct([
        "-n",
        target.namespace,
        "exec",
        pod.metadata.name,
        "-c",
        "web",
        "--",
        "cat",
        "/data/sentinel",
      ])
    ).trim(),
    "waypoint-matrix-test-only",
  );
  return {
    interruptedOperation: "reset",
    recovery: "real healthy baseline and Service HTTP",
    pvcUidPreserved: true,
    sentinelPreserved: true,
    ownedUiPid: newBroker.pid,
    origin: newBroker.origin,
    privateStartupLog: startupPath,
    startupCapabilitiesExported: false,
  };
}
