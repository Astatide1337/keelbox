import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  acquireOperationLock,
  OperationLockBusy,
} from "../../lib/server/operation-lock";
test("actual kernel lock reports contention specifically and becomes usable after release", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-lock-proof-"));
  let first: Awaited<ReturnType<typeof acquireOperationLock>> | undefined;
  try {
    first = await acquireOperationLock(join(root, "lock"));
    await assert.rejects(
      acquireOperationLock(join(root, "lock")),
      OperationLockBusy,
    );
    await first.close();
    first = undefined;
    const next = await acquireOperationLock(join(root, "lock"));
    await next.close();
  } finally {
    await first?.close();
    await rm(root, { recursive: true, force: true });
  }
});
test("invalid lock files are not reported as ordinary contention", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-lock-proof-"));
  try {
    await symlink("/dev/null", join(root, "lock"));
    await assert.rejects(
      acquireOperationLock(join(root, "lock")),
      (e) => e instanceof Error && !(e instanceof OperationLockBusy),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
