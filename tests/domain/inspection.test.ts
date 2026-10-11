import { test } from "node:test";
import assert from "node:assert/strict";
import { configurationDifferences, resourceAge } from "../../lib/ui/inspection";
import {
  analysisFilesDigest,
  draftKey,
  readDraft,
  writeDraft,
} from "../../lib/ui/analysis-drafts";
test("desired/live diff ignores bookkeeping but retains defaults and configuration changes", () => {
  const desired = {
    kind: "Deployment",
    metadata: { name: "web" },
    spec: { replicas: 2 },
  };
  const live = {
    ...desired,
    metadata: {
      name: "web",
      uid: "uid",
      resourceVersion: "4",
      managedFields: [{}],
    },
    status: { readyReplicas: 2 },
    spec: { replicas: 1, strategy: { type: "RollingUpdate" } },
  };
  assert.deepEqual(
    configurationDifferences(desired, live).map((d) => d.path),
    ["/spec/replicas", "/spec/strategy"],
  );
  assert.equal(
    resourceAge(
      { metadata: { creationTimestamp: "2026-10-10T00:00:00Z" } },
      "2026-10-10T00:04:00Z",
    ),
    "4m at observation",
  );
  assert.equal(resourceAge({}, null), "Unknown");
});
test("drafts survive reload without crossing account/project identities and reject foreign files", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (k: string) => values.get(k) ?? null,
    setItem: (k: string, v: string) => {
      values.set(k, v);
    },
  };
  const original = [{ id: "a", name: "app.yaml", content: "original" }],
    edited = [{ ...original[0], content: "incomplete: [" }];
  writeDraft(storage, draftKey("A", "project1"), {
    files: edited,
    savedFiles: original,
    updatedAt: "now",
  });
  assert.deepEqual(
    readDraft(storage, draftKey("A", "project1"), original)?.files,
    edited,
  );
  assert.equal(readDraft(storage, draftKey("B", "project1"), original), null);
  assert.equal(readDraft(storage, draftKey("A", "project2"), original), null);
  assert.equal(
    readDraft(storage, draftKey("A", "project1"), [
      { id: "other", name: "other.yaml", content: "" },
    ]),
    null,
  );
});

test("draft identity follows immutable file revisions, not project metadata", () => {
  const files = [{ id: "a", name: "app.yaml", content: "original" }];
  assert.equal(
    analysisFilesDigest(files),
    analysisFilesDigest(structuredClone(files)),
  );
  assert.notEqual(
    analysisFilesDigest(files),
    analysisFilesDigest([{ ...files[0], content: "updated" }]),
  );
  assert.notEqual(
    analysisFilesDigest(files),
    analysisFilesDigest([{ ...files[0], id: "b" }]),
  );
});
