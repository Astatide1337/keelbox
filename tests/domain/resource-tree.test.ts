import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResourceTree } from "../../components/workspace/ResourceTree";
import { manifestProject, projectResources } from "../../lib/domain/snapshot";
import { readFile } from "node:fs/promises";
test("manifest-only resources with unknown UIDs remain roots; missing UIDs never imply ownership", async () => {
  const source = manifestProject([
    {
      id: "app",
      name: "application.yaml",
      content: await readFile("examples/local-http/application.yaml", "utf8"),
    },
  ]);
  const resources = projectResources(source);
  const html = renderToStaticMarkup(
    createElement(ResourceTree, {
      resources,
      source,
      observation: null,
      selected: null,
      onSelect: () => {},
    }),
  );
  assert.equal((html.match(/<button /g) ?? []).length, resources.length);
  assert(!html.includes("managed resources"));
});

import { ResourceInspector } from "../../components/workspace/ResourceInspector";
import { importSnapshot } from "../../lib/domain/snapshot";
test("Service inspector excludes terminating endpoints just like the graph", async () => {
  const source = structuredClone(
    importSnapshot(await readFile("examples/storefront/snapshot.json", "utf8")),
  );
  const resources = projectResources(source);
  const service = resources.find(
    (r) => r.kind === "Service" && r.name === "web",
  )!;
  source.resources = source.resources.filter((r) => r.kind !== "EndpointSlice");
  source.resources.push({
    apiVersion: "discovery.k8s.io/v1",
    kind: "EndpointSlice",
    metadata: {
      name: "test",
      namespace: service.namespace,
      labels: { "kubernetes.io/service-name": service.name },
    },
    endpoints: [{ conditions: { ready: true, terminating: true } }],
  });
  const html = renderToStaticMarkup(
    createElement(ResourceInspector, {
      resource: service,
      source,
      files: source.files,
      exercise: null,
      tab: "Overview",
      onTab: () => {},
      onSelect: () => {},
      onEdit: () => {},
      onHint: () => {},
      diagnostics: [],
      relationships: [],
      resources,
    }),
  );
  assert.match(html, /Ready endpoints<\/dt><dd>0<\/dd>/);
});
