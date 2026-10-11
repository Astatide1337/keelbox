import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { repositoryFiles } from "../../lib/server/repository-import";
import { parseSources } from "../../lib/domain/importer";
import { manifestProject } from "../../lib/domain/snapshot";
import { deploymentPlan } from "../../lib/domain/deployment-plan";
import { at } from "../../lib/domain/types";

// Remote evidence is opt-in and uses one pinned upstream public chart. A skip is NOT RUN.
test("pinned upstream public OCI dependency renders without ambient Helm configuration or source changes", async (context) => {
  if (
    process.env.WAYPOINT_OCI_CORPUS !== "1" ||
    !process.env.WAYPOINT_HELM_BIN
  ) {
    context.skip(
      "Set WAYPOINT_OCI_CORPUS=1 and WAYPOINT_HELM_BIN for actual public OCI renderer evidence.",
    );
    return;
  }
  const root = resolve("tests/corpus/helm-oci"),
    before = await readFile(join(root, "Chart.yaml"), "utf8");
  const sentinel = await mkdtemp(join(tmpdir(), "waypoint-oci-env-"));
  const saved = new Map<string, string | undefined>();
  for (const key of [
    "HELM_REGISTRY_CONFIG",
    "HELM_REPOSITORY_CONFIG",
    "HELM_REPOSITORY_CACHE",
    "DOCKER_CONFIG",
    "DOCKER_AUTH_CONFIG",
    "PATH",
  ])
    saved.set(key, process.env[key]);
  try {
    // Deliberately invalid test-only files prove the importer replaces inherited paths.
    await writeFile(
      join(sentinel, "registry.json"),
      "not JSON; synthetic isolation canary",
      { mode: 0o600 },
    );
    await writeFile(
      join(sentinel, "repositories.yaml"),
      "[invalid YAML; synthetic isolation canary",
      { mode: 0o600 },
    );
    await mkdir(join(sentinel, "docker"));
    await mkdir(join(sentinel, "bin"));
    await writeFile(
      join(sentinel, "docker", "config.json"),
      "invalid test-only Docker JSON",
      { mode: 0o600 },
    );
    const trace = join(sentinel, "helper-called");
    await writeFile(join(sentinel, "bin", "pass"), "#!/bin/sh\nexit 1\n", {
      mode: 0o700,
    });
    await writeFile(
      join(sentinel, "bin", "docker-credential-pass"),
      `#!/bin/sh\nprintf 'invoked\\n' >> '${trace}'\nprintf 'credentials not found in native keychain'\nexit 1\n`,
      { mode: 0o700 },
    );
    process.env.DOCKER_CONFIG = join(sentinel, "docker");
    process.env.DOCKER_AUTH_CONFIG = "synthetic unused auth canary";
    process.env.PATH = join(sentinel, "bin") + ":" + process.env.PATH;
    process.env.HELM_REGISTRY_CONFIG = join(sentinel, "registry.json");
    process.env.HELM_REPOSITORY_CONFIG = join(sentinel, "repositories.yaml");
    process.env.HELM_REPOSITORY_CACHE = join(sentinel, "cache");
    const result = await repositoryFiles([root], {
      release: "oci-corpus",
      namespace: "corpus",
    });
    const parsed = parseSources(result.files);
    assert.deepEqual(parsed.diagnostics, []);
    const deployment = parsed.resources.find(
      (resource) => resource.kind === "Deployment",
    );
    assert(deployment, "upstream chart must render an actual Deployment");
    assert(parsed.resources.some((resource) => resource.kind === "Service"));
    assert.match(
      String(
        at(
          deployment.raw,
          "spec",
          "template",
          "spec",
          "containers",
          "0",
          "image",
        ),
      ),
      /podinfo:6\.15\.0$/,
    );
    assert.equal(at(deployment.raw, "spec", "replicas"), 1);
    const plan = deploymentPlan(
      manifestProject(result.files),
      "waypoint-lab-0123456789ab",
    );
    assert.equal(plan.capabilities.importable.status, "supported");
    assert.equal(plan.capabilities.deployable.status, "blocked");
    assert.equal(plan.capabilities.exerciseEligible.status, "blocked");
    assert(
      plan.blockers.length > 0 &&
        plan.blockers.every((reason) => reason.includes("Helm hook lifecycle")),
      "Upstream test hooks must be refused explicitly rather than applied as ordinary Pods.",
    );
    assert(
      result.provenance[0].sourceMappings.some((mapping) =>
        mapping.includes("podinfo/templates/deployment.yaml"),
      ),
    );
    assert.equal(await readFile(join(root, "Chart.yaml"), "utf8"), before);
    assert.deepEqual((await readdir(root)).sort(), [
      "Chart.yaml",
      "values.yaml",
    ]);
    assert.equal(
      await readFile(join(sentinel, "registry.json"), "utf8"),
      "not JSON; synthetic isolation canary",
    );
    await assert.rejects(
      readFile(trace),
      { code: "ENOENT" },
      "Native credential helper must never execute during public chart rendering.",
    );
    assert.equal(
      await readFile(join(sentinel, "docker", "config.json"), "utf8"),
      "invalid test-only Docker JSON",
    );
    assert.equal(
      await readFile(join(sentinel, "repositories.yaml"), "utf8"),
      "[invalid YAML; synthetic isolation canary",
    );
  } finally {
    for (const [key, value] of saved)
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(sentinel, { recursive: true, force: true });
  }
});
