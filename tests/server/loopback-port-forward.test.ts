import { test } from "node:test";
import assert from "node:assert/strict";
import {
  ownedLabControlPath,
  selectSingleReadyDeploymentPod,
} from "../../lib/server/loopback-port-forward";
import type { ObjectMap } from "../../lib/domain/types";

function pod(
  name: string,
  uid: string,
  options: { ready?: boolean; phase?: string; deleting?: boolean } = {},
): ObjectMap {
  return {
    metadata: {
      name,
      uid,
      ...(options.deleting
        ? { deletionTimestamp: "2026-10-11T00:00:00Z" }
        : {}),
    },
    status: {
      phase: options.phase ?? "Running",
      conditions: [
        { type: "Ready", status: options.ready === false ? "False" : "True" },
      ],
    },
  };
}

test("control forwards select one exact Running Ready owned Pod", () => {
  assert.deepEqual(
    selectSingleReadyDeploymentPod([pod("market-producer-abc", "pod-uid")]),
    { name: "market-producer-abc", uid: "pod-uid" },
  );
  assert.throws(
    () => selectSingleReadyDeploymentPod([]),
    /exactly one Ready Pod/,
  );
  assert.throws(
    () =>
      selectSingleReadyDeploymentPod([
        pod("market-producer-abc", "pod-uid", { ready: false }),
      ]),
    /exactly one Ready Pod/,
  );
  assert.throws(
    () =>
      selectSingleReadyDeploymentPod([
        pod("market-producer-abc", "pod-uid", { phase: "Pending" }),
      ]),
    /exactly one Ready Pod/,
  );
  assert.throws(
    () =>
      selectSingleReadyDeploymentPod([
        pod("market-producer-abc", "pod-uid", { deleting: true }),
      ]),
    /exactly one Ready Pod/,
  );
  assert.throws(
    () =>
      selectSingleReadyDeploymentPod([
        pod("market-producer-abc", "pod-uid"),
        pod("market-producer-def", "other-uid"),
      ]),
    /exactly one Ready Pod/,
  );
});

test("control endpoint builder accepts only fixed pause and resume operations", () => {
  assert.equal(ownedLabControlPath("pause"), "/lab/pause");
  assert.equal(ownedLabControlPath("resume"), "/lab/resume");
  assert.throws(
    () => ownedLabControlPath("exec"),
    /Unsupported synthetic feed control/,
  );
  assert.throws(
    () => ownedLabControlPath("/lab/resume"),
    /Unsupported synthetic feed control/,
  );
});
