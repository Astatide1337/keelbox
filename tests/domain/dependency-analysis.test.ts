import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSources } from "../../lib/domain/importer";
import { analyze } from "../../lib/domain/analyzer";
import { stringify } from "yaml";
test("analysis and planning share init, projected, optional and sanitized Secret key semantics", () => {
  const deployment = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace: "demo" },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: "app",
              envFrom: [{ configMapRef: { name: "optional", optional: true } }],
              env: [
                {
                  name: "KEY",
                  valueFrom: { secretKeyRef: { name: "test", key: "present" } },
                },
              ],
            },
          ],
          initContainers: [
            {
              name: "setup",
              envFrom: [{ configMapRef: { name: "required-init" } }],
            },
          ],
          volumes: [
            {
              name: "config",
              projected: {
                sources: [{ configMap: { name: "required-projected" } }],
              },
            },
          ],
          serviceAccountName: "worker",
        },
      },
    },
  };
  const secret = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: "test",
      namespace: "demo",
      annotations: { "waypoint.dev/secret-keys": '["present"]' },
    },
  };
  const resources = parseSources([
    {
      id: "files",
      name: "application.yaml",
      content: [deployment, secret].map((v) => stringify(v)).join("---\n"),
    },
  ]).resources;
  const result = analyze(resources);
  assert.equal(
    result.relationships.filter((r) => r.kind === "references").length,
    5,
  );
  assert(
    result.relationships.some(
      (r) => r.title === "Optional ConfigMap reference" && r.status === "match",
    ),
  );
  assert.equal(
    result.findings.filter((r) => r.kind === "references").length,
    3,
  );
  assert(
    result.relationships.some(
      (r) => r.title === "Secret reference" && r.status === "match",
    ),
  );
  assert(
    result.relationships.find((r) => r.title === "ConfigMap reference")
      ?.evidence[0].line! > 1,
  );
});
