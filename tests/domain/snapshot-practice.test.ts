import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse, stringify } from "yaml";
import { importSnapshot, snapshotDigest } from "../../lib/domain/snapshot";
import { compatibility } from "../../lib/practice/compatibility";
import {
  createExercise,
  editDraft,
  checkRepair,
  restartExercise,
} from "../../lib/practice/engine";
const input = readFileSync("examples/storefront/snapshot.json", "utf8");
for (const scenario of ["readiness", "liveness", "http503"] as const)
  test(`${scenario}: fault, real semantic repair, modeled result, repeated reset and immutable source`, () => {
    const s = importSnapshot(input),
      digest = snapshotDigest(s);
    assert.equal(compatibility(s, scenario).supported, true);
    let e = createExercise(s, scenario);
    assert(e.events.length > 0 || scenario === "http503");
    let bad = checkRepair(e, e.revision, "bad");
    assert.equal(bad.state, "running");
    assert.equal(bad.checks[0].passed, false);
    const f = e.draftFiles.find((f) =>
      f.content.includes(
        scenario === "http503" ? "practice-unmatched" : "practice-unavailable",
      ),
    )!;
    e = editDraft(
      e,
      e.revision,
      f.id,
      f.content.replace(
        scenario === "http503" ? "practice-unmatched" : "/practice-unavailable",
        scenario === "http503" ? "web" : "/healthz",
      ),
    );
    e = checkRepair(e, e.revision, "check");
    assert.equal(e.state, "completed");
    assert.equal(checkRepair(e, e.revision - 1, "check").state, "completed");
    assert.throws(() => checkRepair(e, 0, "stale"), /Stale/);
    assert.throws(() => restartExercise(e, e.revision, "check"), /reused/);
    for (let i = 0; i < 2; i++) e = restartExercise(e, e.revision, "reset" + i);
    assert.equal(e.attempt, 3);
    assert.equal(e.checks.length, 0);
    assert.equal(e.resets.length, 2);
    assert.equal(snapshotDigest(s), digest);
    assert.throws(() => {
      s.resources.push({});
    }, TypeError);
  });
test("malformed edits are retained; deletion, probe removal and scaling shortcuts fail", () => {
  const s = importSnapshot(input);
  let e = createExercise(s, "readiness");
  const f = e.draftFiles.find((f) =>
    f.content.includes("/practice-unavailable"),
  )!;
  const invalid = editDraft(e, 0, f.id, "apiVersion: [");
  assert.equal(
    invalid.draftFiles.find((x) => x.id === f.id)?.content,
    "apiVersion: [",
  );
  assert.equal(
    checkRepair(invalid, invalid.revision, "invalid").checks[0].passed,
    false,
  );
  for (const transform of [
    (d: any) => {
      d.spec.replicas = 0;
    },
    (d: any) => {
      delete d.spec.template.spec.containers[0].readinessProbe;
    },
    (d: any) => {
      d.spec.template.spec.containers[0].env = [];
    },
  ]) {
    const d = parse(f.content);
    d.spec.template.spec.containers[0].readinessProbe.httpGet.path = "/healthz";
    transform(d);
    const changed = editDraft(e, e.revision, f.id, stringify(d));
    assert.equal(
      checkRepair(changed, changed.revision, crypto.randomUUID()).checks[0]
        .passed,
      false,
    );
  }
});
test("partial capture and no endpoint contract fail compatibility rather than defaulting healthy", () => {
  const s = JSON.parse(input);
  s.resources = s.resources.filter((r: any) => r.kind !== "Pod");
  assert.equal(
    compatibility(importSnapshot(JSON.stringify(s)), "readiness").supported,
    false,
  );
  s.contracts = [];
  assert.match(
    (
      compatibility(importSnapshot(JSON.stringify(s)), "liveness") as any
    ).reasons.join(),
    /contract/,
  );
});
test("legacy snapshot imports preserve unavailable fields and malformed JSON fails", () => {
  const s = importSnapshot(
    JSON.stringify({
      format: "playground-snapshot-v1",
      context: "demo",
      capturedAt: "2026-10-10T12:00:00Z",
      items: [],
      errors: [],
    }),
  );
  assert.equal(s.coverage.length, 0);
  assert.match(s.errors[0], /unknown/);
  assert.throws(() => importSnapshot("{"));
  assert.throws(
    () =>
      importSnapshot(input.replace('"kind": "Service"', '"kind": "Secret"')),
    /Secret/,
  );
});
test("unhealthy baselines, missing target slices, unsupported sidecars and wrong gateway backend are incompatible", () => {
  for (const change of [
    (s: any) => {
      s.resources = s.resources.filter((r: any) => r.kind !== "EndpointSlice");
    },
    (s: any) => {
      s.resources.find(
        (r: any) => r.kind === "Pod",
      ).status.conditions[0].status = "False";
    },
    (s: any) => {
      const f = s.files.find(
        (f: any) =>
          f.content.includes("name: web") &&
          f.content.includes("kind: Deployment"),
      );
      const d = parse(f.content);
      d.spec.template.spec.containers.push({ name: "sidecar" });
      f.content = stringify(d);
    },
    (s: any) => {
      s.contracts[0].gateway.backendService = "missing";
    },
  ]) {
    const s = JSON.parse(input);
    change(s);
    assert.equal(
      compatibility(importSnapshot(JSON.stringify(s)), "http503").supported,
      false,
    );
  }
});
test("Secret in snapshot-authored files is rejected", () => {
  const s = JSON.parse(input);
  s.files.push({
    id: "secret",
    name: "secret.yaml",
    content:
      "apiVersion: v1\nkind: Secret\nmetadata:\n  name: hidden\ndata:\n  token: aGVsbG8=\n",
  });
  assert.throws(() => importSnapshot(JSON.stringify(s)), /Secret/);
});

test("captured nested Lists and legacy imports cannot carry Secrets", () => {
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: { name: "forbidden" },
    data: { token: "never-import" },
  };
  const nested = {
    apiVersion: "v1",
    kind: "List",
    items: [{ apiVersion: "v1", kind: "List", items: [secret] }],
  };
  const v2 = JSON.parse(input);
  v2.resources = [nested];
  assert.throws(() => importSnapshot(JSON.stringify(v2)), /Secret/);
  assert.throws(
    () =>
      importSnapshot(
        JSON.stringify({
          format: "playground-snapshot-v1",
          context: "demo",
          capturedAt: "2026-10-10T12:00:00Z",
          items: [nested],
          errors: [],
        }),
      ),
    /Secret/,
  );
  assert.throws(
    () =>
      importSnapshot(
        JSON.stringify({
          format: "playground-snapshot-v1",
          context: "demo",
          capturedAt: "2026-10-10T12:00:00Z",
          items: [secret],
          errors: [],
        }),
      ),
    /Secret/,
  );
});
