import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFile,
  mkdtemp,
  mkdir,
  writeFile,
  rm,
  access,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { stringify } from "yaml";
import { parseSources } from "../../lib/domain/importer";
import { manifestProject, importSnapshot } from "../../lib/domain/snapshot";
import { deploymentPlan } from "../../lib/domain/deployment-plan";
import { podDependencies } from "../../lib/domain/dependencies";
import { at, list, object } from "../../lib/domain/types";
import {
  publicManifest,
  repositoryFiles,
} from "../../lib/server/repository-import";
import { resolveArgoFiles } from "../../lib/server/argo-import";
const namespace = "waypoint-lab-0123456789ab";

test("checked-in manifest corpus has explicit supported and refused capability outcomes", async () => {
  const expectations = JSON.parse(
    await readFile("tests/corpus/expected.json", "utf8"),
  );
  const healthy = await readFile("tests/corpus/manifests/healthy.yaml", "utf8");
  for (const expected of expectations) {
    const content = await readFile(
      join("tests/corpus/manifests", expected.file),
      "utf8",
    );
    const project = manifestProject([
      {
        id: "corpus",
        name: expected.file,
        content:
          expected.file === "healthy.yaml"
            ? content
            : healthy + "\n---\n" + content,
      },
    ]);
    const plan = deploymentPlan(project, namespace);
    assert.equal(
      plan.capabilities.importable.status,
      "supported",
      expected.file,
    );
    assert.equal(
      plan.capabilities.deployable.status,
      expected.deployable,
      expected.file,
    );
    if (expected.exercise)
      assert.equal(
        plan.capabilities.exerciseEligible.status,
        expected.exercise,
        expected.file,
      );
    if (expected.reason)
      assert(
        plan.blockers.some((message) => message.includes(expected.reason)),
        expected.file + ": " + plan.blockers.join("; "),
      );
  }
});
test("namespace labels, account subjects and boundary-delimited Service DNS stay semantically aligned", async () => {
  const healthy = await readFile("tests/corpus/manifests/healthy.yaml", "utf8"),
    extra = await readFile(
      "tests/corpus/manifests/namespace-labels.yaml",
      "utf8",
    );
  const project = manifestProject([
    {
      id: "test",
      name: "test.yaml",
      content:
        healthy +
        "\n---\n" +
        extra +
        "\n---\napiVersion: v1\nkind: ConfigMap\nmetadata: {name: dns, namespace: demo}\ndata: {endpoint: 'http://web.demo.svc:80/path', unrelated: 'web.demo.svcfake'}\n",
    },
  ]);
  const plan = deploymentPlan(project, namespace);
  assert.equal(plan.namespaceLabels[namespace].team, "development");
  assert.equal(
    plan.namespaceLabels[namespace]["pod-security.kubernetes.io/enforce"],
    "baseline",
  );
  assert.equal(
    at(
      plan.resources.find((r) => r.kind === "RoleBinding"),
      "subjects",
      "0",
      "namespace",
    ),
    namespace,
  );
  const config = plan.resources.find(
    (r) => at(r, "metadata", "name") === "dns",
  );
  assert.equal(
    at(config, "data", "endpoint"),
    `http://web.${namespace}.svc:80/path`,
  );
  assert.equal(at(config, "data", "unrelated"), "web.demo.svcfake");
  assert.equal(
    at(
      parseSources(project.files).resources.find((r) => r.name === "dns")?.raw,
      "data",
      "endpoint",
    ),
    "http://web.demo.svc:80/path",
  );
});
test("dependency walker covers regular/init env/envFrom and direct/projected configuration item keys", () => {
  const refs = podDependencies({
    initContainers: [
      {
        name: "init",
        env: [{ valueFrom: { secretKeyRef: { name: "s", key: "init" } } }],
      },
    ],
    containers: [
      {
        name: "app",
        envFrom: [{ configMapRef: { name: "optional", optional: true } }],
      },
    ],
    volumes: [
      {
        projected: {
          sources: [
            {
              secret: { name: "s", items: [{ key: "projected", path: "key" }] },
            },
            {
              configMap: {
                name: "c",
                items: [{ key: "config", path: "file" }],
              },
            },
          ],
        },
      },
      {
        secret: {
          secretName: "direct",
          items: [{ key: "direct", path: "file" }],
        },
      },
    ],
    serviceAccountName: "custom",
  });
  assert.deepEqual(
    refs.map((ref) => [ref.kind, ref.name, ref.keys, ref.optional]),
    [
      ["ConfigMap", "optional", [], true],
      ["Secret", "s", ["init"], false],
      ["Secret", "s", ["projected"], false],
      ["ConfigMap", "c", ["config"], false],
      ["Secret", "direct", ["direct"], false],
      ["ServiceAccount", "custom", [], false],
    ],
  );
});
test("typed SecretList inherits item identity, removes values and retains only safe key metadata", () => {
  const safe = publicManifest(
    stringify({
      apiVersion: "v1",
      kind: "SecretList",
      items: [
        { metadata: { name: "db" }, stringData: { password: "SHORT_CANARY" } },
      ],
    }),
  );
  assert(!safe.content.includes("SHORT_CANARY"));
  const parsed = parseSources([
    { id: "x", name: "secrets.json", content: safe.content },
  ]);
  assert.equal(parsed.resources[0].kind, "Secret");
  assert.equal(parsed.resources[0].name, "db");
  const project = manifestProject([
    { id: "x", name: "secret.yaml", content: safe.content },
  ]);
  const plan = deploymentPlan(project, namespace, {
    revision: "test",
    secrets: [
      { namespace: "default", name: "db", type: "Opaque", keys: ["password"] },
    ],
  });
  assert(!plan.blockers.some((reason) => reason.includes("Secret/db")));
});
test("plain YAML/JSON monorepos demand an explicit app choice and expose skipped-file diagnostics", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-monorepo-audit-"));
  try {
    for (const name of ["apps/frontend", "apps/backend", ".git", "credentials"])
      await mkdir(join(root, name), { recursive: true });
    await writeFile(
      join(root, "apps/frontend/service.json"),
      JSON.stringify({
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "front" },
      }),
    );
    await writeFile(
      join(root, "apps/backend/service.yaml"),
      "apiVersion: v1\nkind: Service\nmetadata: {name: back}\n",
    );
    await writeFile(join(root, "credentials/secret.yaml"), "DO_NOT_READ");
    await assert.rejects(repositoryFiles([root]), /Select an application/);
    const result = await repositoryFiles([root], { entry: "apps/frontend" });
    assert.equal(parseSources(result.files).resources[0].name, "front");
    assert.equal(result.files.length, 1);
    assert(result.notes.some((message) => message.includes("credentials")));
    assert.equal(result.provenance[0].renderer, "yaml");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("HTTP contracts cover every matching TCP Service and refuse SCTP instead of treating it as HTTP", async () => {
  const files = [
    {
      id: "h",
      name: "healthy.yaml",
      content: await readFile("tests/corpus/manifests/healthy.yaml", "utf8"),
    },
  ];
  files[0].content +=
    "\n---\napiVersion: v1\nkind: Service\nmetadata: {name: second, namespace: demo}\nspec: {selector: {app: web}, ports: [{port: 8080, targetPort: 8080}]}\n";
  const plan = deploymentPlan(manifestProject(files), namespace);
  assert(plan.contracts.some((contract) => contract.service === "web"));
  assert(plan.contracts.some((contract) => contract.service === "second"));
  files[0].content +=
    "\n---\napiVersion: v1\nkind: Service\nmetadata: {name: sctp, namespace: demo}\nspec: {selector: {app: web}, ports: [{port: 8080, targetPort: 8080, protocol: SCTP}]}\n";
  const refused = deploymentPlan(manifestProject(files), namespace);
  assert(refused.blockers.some((reason) => reason.includes("SCTP")));
  assert(!refused.contracts.some((contract) => contract.service === "sctp"));
});
test("CronJob schedule and PVC preservation are requirements, not claimed completed execution or data erasure", async () => {
  const files = await Promise.all(
    ["healthy.yaml", "cron-job.yaml", "pvc.yaml"].map(async (name) => ({
      id: name,
      name,
      content: await readFile(join("tests/corpus/manifests", name), "utf8"),
    })),
  );
  const plan = deploymentPlan(manifestProject(files), namespace);
  assert.equal(plan.resetSemantics.cronJobs.length, 1);
  assert.equal(plan.resetSemantics.persistentVolumes.length, 1);
  assert(
    plan.requirements.some((reason) => reason.includes("awaiting schedule")),
  );
  assert(plan.resetSemantics.description.includes("PVC data is preserved"));
});
test("Argo mutable revisions and credential-bearing URLs are refused before fetching", async () => {
  const application = (repoURL: string, targetRevision: string) => [
    {
      id: "argo",
      name: "application.yaml",
      content: stringify({
        apiVersion: "argoproj.io/v1alpha1",
        kind: "Application",
        metadata: { name: "test" },
        spec: {
          source: { repoURL, targetRevision, path: "app" },
          destination: { namespace: "demo" },
        },
      }),
    },
  ];
  await assert.rejects(
    resolveArgoFiles(
      application("https://github.com/example/repo.git", "main"),
    ),
    /pinned 40-character/,
  );
  await assert.rejects(
    resolveArgoFiles(
      application("https://user:SHORT_CANARY@example.com/repo", "a".repeat(40)),
    ),
    /credential-free public/,
  );
});

test("real local Kustomize overlay renders components, generator hashes and replacements without modifying source", async () => {
  const path = resolve("tests/corpus/kustomize");
  const before = await readFile(
    join(path, "overlays/local/kustomization.yaml"),
    "utf8",
  );
  const result = await repositoryFiles([path], { entry: "overlays/local" });
  const resources = parseSources(result.files).resources;
  const deployment = resources.find(
    (resource) => resource.kind === "Deployment",
  )!;
  assert.equal(at(deployment.raw, "spec", "replicas"), 2);
  assert.equal(
    at(
      deployment.raw,
      "spec",
      "template",
      "spec",
      "containers",
      "0",
      "readinessProbe",
      "httpGet",
      "path",
    ),
    "/healthz",
  );
  assert.equal(at(deployment.raw, "metadata", "labels", "tier"), "test");
  assert(
    resources.some(
      (resource) =>
        resource.kind === "ConfigMap" && /app-settings-/.test(resource.name),
    ),
  );
  assert.equal(
    await readFile(join(path, "overlays/local/kustomization.yaml"), "utf8"),
    before,
  );
  assert.equal(result.provenance[0].renderer, "kustomize");
  const snapshot = importSnapshot(
    JSON.stringify({
      ...manifestProject(result.files),
      renderProvenance: result.provenance,
    }),
  );
  assert.match(snapshot.renderProvenance![0].version, /^kubectl v?\d/);
  assert.ok(snapshot.renderProvenance![0].version.length <= 300);
});

test("real installed Helm renders ordered values, release namespace and capabilities with source provenance", async (context) => {
  const helm = process.env.WAYPOINT_HELM_BIN;
  if (!helm) {
    context.skip(
      "Set WAYPOINT_HELM_BIN for real Helm renderer evidence; not a mocked renderer pass.",
    );
    return;
  }
  await access(helm);
  const result = await repositoryFiles(["tests/corpus/helm"], {
    values: ["override-first.yaml", "override-last.yaml"],
    release: "corpus",
    namespace: "reviewed",
    kubernetesVersion: "1.35.0",
    apiVersions: ["apps/v1/Deployment"],
  });
  const deployment = parseSources(result.files).resources.find(
    (resource) => resource.kind === "Deployment",
  )!;
  assert.equal(at(deployment.raw, "spec", "replicas"), 3);
  assert.equal(deployment.namespace, "reviewed");
  assert.equal(result.provenance[0].values.length, 2);
  assert.equal(result.provenance[0].namespace, "reviewed");
  assert(
    result.provenance[0].sourceMappings.some((source) =>
      source.includes("application.yaml"),
    ),
  );
});
