import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  helmBaseEnvironment,
  isolatedHelmCredentials,
} from "../../lib/server/helm-environment";
test("Helm subprocesses cannot inherit target overrides, SQL storage, repository or registry credentials", () => {
  const env = helmBaseEnvironment({
    NODE_ENV: "test",
    PATH: "/tools",
    KUBECONFIG: "/owned/config",
    WAYPOINT_HELM_BIN: "/tools/helm",
    HELM_KUBEAPISERVER: "https://unowned.invalid",
    HELM_KUBETOKEN: "synthetic-canary",
    HELM_KUBECAFILE: "/ambient/ca",
    HELM_KUBEINSECURE_SKIP_TLS_VERIFY: "true",
    HELM_DRIVER: "sql",
    HELM_DRIVER_SQL_CONNECTION_STRING: "synthetic-sql",
    HELM_REPOSITORY_CONFIG: "/ambient/repositories",
    HELM_REGISTRY_CONFIG: "/ambient/registry",
    HELM_PLUGINS: "/ambient/plugins",
    DOCKER_CONFIG: "/ambient/docker",
    DOCKER_AUTH_CONFIG: "synthetic-docker-auth",
    KUBERNETES_MASTER: "https://unowned.invalid",
  });
  assert(!Object.keys(env).some((key) => key.startsWith("HELM_")));
  assert(!JSON.stringify(env).includes("synthetic"));
  assert.equal(env.KUBERNETES_MASTER, undefined);
  assert.equal(env.DOCKER_CONFIG, undefined);
  assert.equal(env.DOCKER_AUTH_CONFIG, undefined);
  assert.equal(env.PATH, "/tools");
  assert.equal(env.KUBECONFIG, "/owned/config");
  assert.equal(env.WAYPOINT_HELM_BIN, "/tools/helm");
});

test("disposable Helm and Docker stores are private and suppress native helper detection without credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "waypoint-helm-env-test-"));
  try {
    const env = await isolatedHelmCredentials(root);
    assert.equal((await stat(env.DOCKER_CONFIG)).mode & 0o777, 0o700);
    for (const path of [
      join(env.DOCKER_CONFIG, "config.json"),
      env.HELM_REGISTRY_CONFIG,
    ]) {
      assert.equal((await stat(path)).mode & 0o777, 0o600);
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), {
        auths: { "waypoint-no-credentials.invalid": {} },
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
