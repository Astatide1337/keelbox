import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { importSnapshot, projectResources } from "../../lib/domain/snapshot";
import { analyze } from "../../lib/domain/analyzer";
import {
  graphProjection,
  resourceOrigin,
  resourcePresentation,
} from "../../lib/domain/presentation";
import type { Observation } from "../../lib/domain/types";
test("graph preserves UID ownership through authored Deployment, targets Pod selectors and excludes duplicate configuration edges", async () => {
  const source = importSnapshot(
    await readFile("examples/storefront/snapshot.json", "utf8"),
  );
  const resources = projectResources(source),
    relations = graphProjection(
      resources,
      analyze(resources).relationships,
      source,
    );
  const dep = resources.find(
      (r) => r.kind === "Deployment" && r.name === "web",
    )!,
    rs = resources.find((r) => r.kind === "ReplicaSet")!;
  assert(
    relations.some(
      (e) => e.from === dep.id && e.to === rs.id && e.kind === "owns",
    ),
  );
  assert(
    relations
      .filter((e) => e.kind === "selects")
      .every((e) => resources.find((r) => r.id === e.to)?.kind === "Pod"),
  );
  assert(
    !relations.some(
      (e) =>
        e.kind === "references" &&
        resources.find((r) => r.id === e.from)?.kind === "Pod",
    ),
  );
  const wrong = structuredClone(source);
  const raw = wrong.resources.find(
    (r) => r.kind === "Deployment" && (r.metadata as any).name === "web",
  )!;
  (raw.metadata as any).uid = "different-uid";
  assert(
    !graphProjection(resources, analyze(resources).relationships, wrong).some(
      (e) => e.from === dep.id && e.to === rs.id && e.kind === "owns",
    ),
  );
  assert.equal(resourceOrigin(dep, source), "Authored manifest");
  assert.match(
    resourceOrigin(
      resources.find((r) => r.kind === "Pod")!,
      source,
    ),
    /Controller-generated/,
  );
});
test("missing readiness and endpoint observations remain unknown, and readiness does not assert probe failure", async () => {
  const source = importSnapshot(
      await readFile("examples/storefront/snapshot.json", "utf8"),
    ),
    resources = projectResources(source);
  const pod = resources.find((r) => r.kind === "Pod")!,
    service = resources.find((r) => r.kind === "Service")!;
  assert.equal(resourcePresentation(pod, null).tone, "unknown");
  assert.equal(resourcePresentation(service, null).label, "Endpoints unknown");
  const observation: Observation = {
    sessionId: "x",
    generation: 1,
    revision: 0,
    sequence: 0,
    capturedAt: "",
    errors: [],
    resources: [
      {
        ...pod.raw,
        status: { conditions: [{ type: "Ready", status: "False" }] },
      },
    ],
  };
  assert.equal(resourcePresentation(pod, observation).label, "Ready: False");
  assert(!resourcePresentation(pod, observation).label.includes("probe"));
});
