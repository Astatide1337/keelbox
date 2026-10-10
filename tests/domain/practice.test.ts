import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAllDocuments, stringify } from "yaml";
import { fixtureSource } from "../../lib/domain/scenarios";
import { semanticChecks, validateRepair } from "../../lib/domain/practice";
import { at, object, type ScenarioId } from "../../lib/domain/types";
for (const scenario of [
  "service-selector",
  "configmap-key",
  "readiness-path",
] as ScenarioId[]) {
  test(`${scenario}: fault fails, healthy repair passes`, () => {
    const fault = validateRepair(
      fixtureSource(scenario, "owned", true),
      scenario,
      "owned",
    );
    assert.equal(semanticChecks(fault, scenario)[1].status, "fail");
    const healthy = validateRepair(
      fixtureSource(scenario, "owned", false),
      scenario,
      "owned",
    );
    assert.equal(semanticChecks(healthy, scenario)[1].status, "pass");
  });
}
function mutate(fn: (docs: Record<string, unknown>[]) => void) {
  const docs = parseAllDocuments(
    fixtureSource("service-selector", "owned"),
  ).map((d) => d.toJS());
  fn(docs);
  return docs.map((d) => stringify(d)).join("---\n");
}
test("reject zero replicas, deletion, foreign namespace and arbitrary image", () => {
  for (const fn of [
    (d: Record<string, unknown>[]) => {
      object(d[1].spec).replicas = 0;
    },
    (d: Record<string, unknown>[]) => {
      d.pop();
    },
    (d: Record<string, unknown>[]) => {
      object(d[0].metadata).namespace = "work";
    },
    (d: Record<string, unknown>[]) => {
      object(at(d[1], "spec", "template", "spec", "containers", "0")).image =
        "untrusted";
    },
  ])
    assert.throws(() =>
      validateRepair(mutate(fn), "service-selector", "owned"),
    );
});
test("missing required probe cannot be a repair", () => {
  const docs = parseAllDocuments(fixtureSource("readiness-path", "owned")).map(
    (d) => d.toJS(),
  );
  delete object(at(docs[1], "spec", "template", "spec", "containers", "0"))
    .readinessProbe;
  assert.throws(() =>
    validateRepair(
      docs.map((d) => stringify(d)).join("---\n"),
      "readiness-path",
      "owned",
    ),
  );
});
