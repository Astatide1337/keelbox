import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  stat,
  rm,
  writeFile,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { importSnapshot } from "../../lib/domain/snapshot";
import {
  createExercise,
  editDraft,
  checkRepair,
  restartExercise,
} from "../../lib/practice/engine";
import {
  ExerciseStore,
  restoreExercise,
} from "../../lib/server/exercise-store";
import { collectSnapshot, projectCaptured } from "../../lib/server/collector";
test("owner-only atomic checkpoints recover malformed drafts, reject stale saves and corrupt sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "practice-store-"));
  try {
    const s = importSnapshot(
      await readFile("examples/storefront/snapshot.json", "utf8"),
    );
    let e = createExercise(s, "readiness");
    const store = new ExerciseStore(root);
    await store.save(e, null);
    assert.equal((await stat(join(root, e.id + ".json"))).mode & 0o777, 0o600);
    e = editDraft(e, e.revision, e.draftFiles[1].id, "apiVersion: [");
    await store.save(e, 0);
    const loaded = await store.load(e.id);
    assert.equal(loaded.exercise.draftFiles[1].content, "apiVersion: [");
    await assert.rejects(store.save(e, 0), /Stale/);
    assert.equal(restoreExercise({ ...e, state: "checking" }).state, "running");
    assert.throws(
      () => restoreExercise({ ...e, sourceDigest: "wrong" }),
      /digest/,
    );
    await writeFile(join(root, e.id + ".json"), "broken");
    await assert.rejects(store.load(e.id));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("completed checkpoint is regraded, not trusted from stored state", async () => {
  const s = importSnapshot(
    await readFile("examples/storefront/snapshot.json", "utf8"),
  );
  let e = createExercise(s, "readiness");
  assert.throws(
    () => restoreExercise({ ...e, state: "completed" }),
    /completion/,
  );
  const file = e.draftFiles.find((f) =>
    f.content.includes("/practice-unavailable"),
  )!;
  e = editDraft(
    e,
    e.revision,
    file.id,
    file.content.replace("/practice-unavailable", "/healthz"),
  );
  e = checkRepair(e, e.revision, "check");
  assert.equal(restoreExercise(e).state, "completed");
  const revision = e.revision;
  e = restartExercise(e, e.revision, "reset");
  assert.equal(checkRepair(e, revision - 1, "check").state, "completed");
  assert.equal(e.state, "running");
});
test("collector projects safe fields and preserves partial RBAC coverage; never executes mutations", async () => {
  const calls: string[][] = [];
  const s = await collectSnapshot(
    "explicit",
    ["storefront"],
    "/dedicated/read-only.kubeconfig",
    async (cmd, args) => {
      assert.equal(cmd, "kubectl");
      calls.push(args);
      if (args.includes("events")) throw Error("Forbidden events");
      return JSON.stringify({
        items: args.includes("configmaps")
          ? [
              {
                apiVersion: "v1",
                kind: "ConfigMap",
                metadata: { name: "private", namespace: "storefront" },
                data: { PASSWORD: "sensitive" },
              },
            ]
          : [],
      });
    },
  );
  assert(
    calls.every(
      (a) =>
        a.includes("--context") &&
        a.includes("--kubeconfig") &&
        a.includes("get") &&
        !a.includes("apply"),
    ),
  );
  assert.equal(s.coverage.find((c) => c.kind === "Event")?.state, "forbidden");
  assert(!JSON.stringify(s).includes("sensitive"));
  const pod = projectCaptured({
    kind: "Pod",
    metadata: { name: "p" },
    spec: {
      containers: [
        {
          name: "web",
          env: [{ name: "TOKEN", value: "credential" }],
          readinessProbe: {
            httpGet: {
              path: "/healthz?token=credential",
              port: 8080,
              httpHeaders: [{ value: "credential" }],
            },
          },
        },
      ],
    },
  });
  assert(!JSON.stringify(pod).includes("credential"));
});
test("unfinished drafts recover the last modeled state and exact model revision", async () => {
  const s = importSnapshot(
    await readFile("examples/storefront/snapshot.json", "utf8"),
  );
  let e = createExercise(s, "readiness");
  const f = e.draftFiles.find((f) =>
    f.content.includes("/practice-unavailable"),
  )!;
  e = editDraft(
    e,
    e.revision,
    f.id,
    f.content.replace("/practice-unavailable", "/healthz"),
  );
  e = checkRepair(e, e.revision, "check");
  const completed = restoreExercise(e);
  assert.equal(completed.modelRevision, completed.revision);
  const modelRevision = e.modelRevision;
  const oldResources = e.resources;
  e = editDraft(e, e.revision, f.id, "apiVersion: [");
  const recovered = restoreExercise(e);
  assert.equal(recovered.modelRevision, modelRevision);
  assert.deepEqual(recovered.resources, oldResources);
  assert.equal(recovered.state, "running");
  assert.equal(recovered.checks.length, 0);
});
test("checkpoint catalog is bounded, preserves corrupt entries, supports legacy timestamps and resumes original sources", async () => {
  const root = await mkdtemp(join(tmpdir(), "practice-list-"));
  try {
    const source = importSnapshot(
      await readFile("examples/storefront/snapshot.json", "utf8"),
    );
    const store = new ExerciseStore(root),
      first = createExercise(source, "readiness"),
      second = createExercise(source, "liveness");
    await store.save(first, null);
    await store.save(second, null);
    const corrupt = "ffffffff-ffff-4fff-afff-ffffffffffff";
    await writeFile(join(root, corrupt + ".json"), "{broken");
    const initial = await store.list(undefined, 1);
    assert(initial.nextCursor);
    const rest = await store.list(initial.nextCursor, 2);
    assert.equal(initial.items.length + rest.items.length, 2);
    assert.equal(initial.issues.length + rest.issues.length, 1);
    assert.equal(rest.nextCursor, undefined);
    const path = join(root, first.id + ".json"),
      legacy = JSON.parse(await readFile(path, "utf8"));
    delete legacy.updatedAt;
    await writeFile(path, JSON.stringify(legacy));
    const result = await store.list();
    assert.equal(
      result.items.find((i) => i.id === first.id)?.timestampOrigin,
      "file-modified",
    );
    assert.equal(
      result.items.find((i) => i.id === second.id)?.sourceId,
      source.id,
    );
    assert.equal(
      (await store.load(first.id)).exercise.sourceDigest,
      first.sourceDigest,
    );
    await assert.rejects(store.list("../outside"));
    await assert.rejects(store.list(undefined, 51));
    assert.equal(
      await readFile(join(root, corrupt + ".json"), "utf8"),
      "{broken",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("recent checkpoint precedes lexicographically earlier UUID, with stable pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "practice-recency-"));
  try {
    const source = importSnapshot(
      await readFile("examples/storefront/snapshot.json", "utf8"),
    );
    const store = new ExerciseStore(root);
    const old = {
        ...createExercise(source, "readiness"),
        id: "00000000-0000-4000-a000-000000000001",
      },
      recent = {
        ...createExercise(source, "liveness"),
        id: "ffffffff-ffff-4fff-afff-ffffffffffff",
      };
    await store.save(recent, null);
    await store.save(old, null);
    await utimes(
      join(root, old.id + ".json"),
      new Date("2026-01-01T00:00:00Z"),
      new Date("2026-01-01T00:00:00Z"),
    );
    await utimes(
      join(root, recent.id + ".json"),
      new Date("2026-10-10T00:00:00Z"),
      new Date("2026-10-10T00:00:00Z"),
    );
    const page = await store.list(undefined, 1);
    assert.equal(page.items[0].id, recent.id);
    assert.equal(page.nextCursor, recent.id);
    const next = await store.list(page.nextCursor, 1);
    assert.equal(next.items[0].id, old.id);
    assert.equal(next.nextCursor, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
