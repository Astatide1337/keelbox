import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSources } from "../../lib/domain/importer";
import { analyze } from "../../lib/domain/analyzer";
import { fixtureSource } from "../../lib/domain/scenarios";
const source = (content: string) => [{ id: "a", name: "a.yaml", content }];
test("selector relationship includes exact field evidence", () => {
  const files = source(fixtureSource("service-selector"));
  const parsed = parseSources(files);
  assert.equal(parsed.diagnostics.length, 0);
  const edge = analyze(parsed.resources).findings.find(
    (e) => e.kind === "selects",
  );
  assert.equal(edge?.status, "mismatch");
  assert.equal(edge?.evidence.length, 2);
  for (const ref of edge!.evidence)
    assert.equal(files[0].content.slice(ref.start, ref.end), ref.value);
  assert.match(edge!.evidence[0].value, /storefront/);
  assert.match(edge!.evidence[1].value, /web/);
});
test("namespace mismatch does not connect resources", () => {
  const parsed = parseSources(
    source(
      fixtureSource("service-selector").replace(
        "namespace: lab-demo",
        "namespace: other",
      ),
    ),
  );
  const edges = analyze(parsed.resources).relationships.filter(
    (e) => e.kind === "selects",
  );
  assert.equal(edges.length, 1);
  assert.equal(edges[0].status, "unresolved");
});
test("multi-doc identities, duplicate identity and invalid syntax", () => {
  assert.equal(
    parseSources(source(fixtureSource("service-selector"))).resources.length,
    3,
  );
  assert.match(
    parseSources(
      source(
        fixtureSource("service-selector") +
          "---\n" +
          fixtureSource("service-selector"),
      ),
    ).diagnostics[0].message,
    /Duplicate/,
  );
  assert.ok(parseSources(source("spec: [")).diagnostics.length);
});
test("cluster and unknown scopes are honest", () => {
  const result = parseSources(
    source(
      "apiVersion: v1\nkind: Namespace\nmetadata:\n  name: team\n---\napiVersion: example.dev/v1\nkind: Widget\nmetadata:\n  name: demo\n",
    ),
  );
  assert.equal(result.resources[0].namespace, null);
  assert.equal(result.resources[1].scope, "unknown");
  assert.equal(result.resources[1].supported, false);
});
test("List expands resources and keeps source refs", () => {
  const result = parseSources(
    source(
      "apiVersion: v1\nkind: List\nitems:\n- apiVersion: v1\n  kind: ConfigMap\n  metadata:\n    name: settings\n  data:\n    x: value\n",
    ),
  );
  assert.equal(result.resources.length, 1);
  assert.equal(result.resources[0].refs["data.x"].value, "value");
});
test("required ConfigMap key mismatch is detected", () => {
  const parsed = parseSources(source(fixtureSource("configmap-key")));
  assert.ok(
    analyze(parsed.resources).findings.some((e) =>
      e.title.includes("HEALTH_TOKEN"),
    ),
  );
});
test("no imported workload is not a claimed cluster outage", () => {
  const p = parseSources(
    source(
      "apiVersion: v1\nkind: Service\nmetadata:\n  name: x\nspec:\n  selector:\n    app: x",
    ),
  );
  assert.match(analyze(p.resources).findings[0].explanation, /not proof/);
});
