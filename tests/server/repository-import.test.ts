import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  repositoryEntries,
  publicManifest,
  kustomizeRendererVersion,
} from "../../lib/server/repository-import";
import { readManifestInputs } from "../../lib/server/project-store";
import { LocalConfiguration } from "../../lib/server/local-configuration";
import {
  deploymentPlan,
  digest,
  validateLabRepair,
} from "../../lib/domain/deployment-plan";
import {
  recipeEvidence,
  validateRecipe,
  targetKey,
} from "../../lib/domain/generated-incident";
import { stringify } from "yaml";
import { at, list, object } from "../../lib/domain/types";
test("Kustomize provenance retains bounded actual versions rather than kubectl build metadata", () => {
  assert.equal(
    kustomizeRendererVersion(
      JSON.stringify({
        clientVersion: {
          gitVersion: "v1.37.1",
          gitCommit: "a".repeat(500),
          buildDate: "2026-01-01",
        },
        kustomizeVersion: "v5.8.1",
      }),
    ),
    "kubectl v1.37.1; kustomize v5.8.1",
  );
  for (const output of [
    "invalid",
    "{}",
    JSON.stringify({
      clientVersion: { gitVersion: "v1.37.1" },
      kustomizeVersion: "password: synthetic",
    }),
  ])
    assert.throws(() => kustomizeRendererVersion(output));
});
test("recursive repository discovery finds application entries and ignores machine state", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-repository-"));
  try {
    await mkdir(join(root, "apps", "demo"), { recursive: true });
    await mkdir(join(root, ".git"));
    await writeFile(
      join(root, "apps/demo/service.yaml"),
      "apiVersion: v1\nkind: Service\nmetadata: {name: api}\n",
    );
    await writeFile(join(root, ".git/ignored.yaml"), "not a manifest");
    const entries = await repositoryEntries(root);
    assert.equal(entries.length, 1);
    const project = await readManifestInputs([root]);
    assert.equal(project.files.length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("Secret values and last-applied payloads are stripped, including nested Lists", () => {
  const yaml = stringify({
    apiVersion: "v1",
    kind: "List",
    items: [
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: {
          name: "test",
          annotations: {
            "kubectl.kubernetes.io/last-applied-configuration": "SECRET_CANARY",
          },
        },
        stringData: { password: "SECRET_CANARY" },
      },
    ],
  });
  const result = publicManifest(yaml);
  assert(!result.content.includes("SECRET_CANARY"));
  assert(result.content.includes("password"));
  assert(result.notes.length);
});
test("explicit local test Secrets unblock references without entering deployment source or API summaries", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-config-"));
  try {
    const project = structuredClone(
      await readManifestInputs(["examples/local-http"]),
    );
    project.files[0].content = project.files[0].content.replace(
      "image: nginx:1.28-alpine",
      "image: nginx:1.28-alpine\n          env: [{name: APP_PASSWORD, valueFrom: {secretKeyRef: {name: app-test, key: password}}}]",
    );
    const store = new LocalConfiguration(root);
    const key = digest(project.files);
    assert(
      deploymentPlan(project, "waypoint-lab-0123456789ab").blockers.some((b) =>
        b.includes("app-test"),
      ),
    );
    await store.save(
      key,
      {
        namespace: "demo",
        name: "app-test",
        type: "Opaque",
        values: { password: "SECRET_CANARY" },
      },
      () => {},
    );
    const loaded = await store.load(key),
      summary = store.public(loaded);
    assert(!JSON.stringify(summary).includes("SECRET_CANARY"));
    const plan = deploymentPlan(project, "waypoint-lab-0123456789ab", summary);
    assert.deepEqual(plan.blockers, []);
    assert(!JSON.stringify(plan).includes("SECRET_CANARY"));
    assert.equal((await stat(join(root, key + ".json"))).mode & 0o777, 0o600);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("multiple namespaces remain separate; a same-label Service in another namespace is not a probe contract", async () => {
  const project = structuredClone(
    await readManifestInputs(["examples/local-http"]),
  );
  project.files[0].content +=
    "\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: extra, namespace: another}\ndata: {x: y}\n";
  const plan = deploymentPlan(project, "waypoint-lab-0123456789ab");
  assert.deepEqual(plan.blockers, []);
  assert.equal(new Set(Object.values(plan.namespaceMap)).size, 2);
  assert(plan.resources.some((r) => r.kind === "Namespace"));
});
test("AI incident graders require deterministic recovery criteria and an eligible manifest target", async () => {
  const plan = deploymentPlan(
    await readManifestInputs(["examples/local-http"]),
    "waypoint-lab-0123456789ab",
  );
  const recipe = {
    title: "The application is not ready",
    symptom: "Pods run, but the Service has no ready backends.",
    objective: "Restore readiness and Service traffic.",
    incident: "readiness",
    target: targetKey(plan.contract!, plan.namespace),
    hints: [
      "Inspect current conditions.",
      "Inspect recent kubelet events.",
      "Compare the probe with the healthy baseline.",
    ],
    grader: [
      "baseline-configuration",
      "replicas-ready",
      "ready-backends",
      "service-http",
    ],
  };
  assert.equal(validateRecipe(recipe, plan).incident, "readiness");
  assert.throws(() =>
    validateRecipe({ ...recipe, grader: ["replicas-ready"] }, plan),
  );
  assert.throws(() =>
    validateRecipe({ ...recipe, target: "foreign/workload" }, plan),
  );
  assert(!JSON.stringify(recipeEvidence(plan)).includes("data:"));
});
test("nested Kustomize bases cannot read outside the selected repository", async () => {
  const temp = await mkdtemp(join(tmpdir(), "waypoint-kustomize-boundary-"));
  try {
    await mkdir(join(temp, "repo/child"), { recursive: true });
    await writeFile(
      join(temp, "outside.yaml"),
      "apiVersion: v1\nkind: ConfigMap\nmetadata: {name: outside}\ndata: {x: PRIVATE_CANARY}\n",
    );
    await writeFile(
      join(temp, "repo/kustomization.yaml"),
      "resources: [child]\n",
    );
    await writeFile(
      join(temp, "repo/child/kustomization.yaml"),
      "resources: [../../outside.yaml]\n",
    );
    await assert.rejects(readManifestInputs([join(temp, "repo")]), /escapes/);
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
test("unchanged repair with identical resource names in separate namespaces remains valid", async () => {
  const project = structuredClone(
    await readManifestInputs(["examples/local-http"]),
  );
  project.files[0].content +=
    "\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: web-config, namespace: extra}\ndata: {different: value}\n";
  const plan = deploymentPlan(project, "waypoint-lab-0123456789ab");
  assert.deepEqual(plan.blockers, []);
  assert.equal(
    validateLabRepair(plan, plan.source).length,
    plan.resources.length,
  );
});
test("typed SecretList is scrubbed and snapshot validation rejects unsanitized nested values", async () => {
  const yaml = stringify({
    apiVersion: "v1",
    kind: "SecretList",
    metadata: { name: "list" },
    items: [
      {
        apiVersion: "v1",
        kind: "Secret",
        metadata: { name: "secret" },
        stringData: { password: "NESTED_SECRET_CANARY" },
      },
    ],
  });
  assert(!publicManifest(yaml).content.includes("NESTED_SECRET_CANARY"));
  const { manifestProject, importSnapshot } =
    await import("../../lib/domain/snapshot");
  assert.throws(
    () =>
      importSnapshot(
        JSON.stringify(
          manifestProject([
            { id: "nested", name: "nested.yaml", content: yaml },
          ]),
        ),
      ),
    /Secret/,
  );
});

test("last-applied metadata on ordinary resources cannot export embedded credentials", () => {
  const result = publicManifest(
    stringify({
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: "public-config",
        annotations: {
          "kubectl.kubernetes.io/last-applied-configuration": JSON.stringify({
            stringData: { password: "LAST_APPLIED_SECRET_CANARY" },
          }),
        },
      },
      data: { publicSetting: "enabled" },
    }),
  );
  assert(!result.content.includes("LAST_APPLIED_SECRET_CANARY"));
  assert(result.content.includes("publicSetting"));
});
