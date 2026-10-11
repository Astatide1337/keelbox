import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Helm's inherited flags can override explicit kubeconfig targeting or borrow
 * repository/registry/SQL credentials. Callers add only their disposable paths. */
export function helmBaseEnvironment(
  base: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...base };
  for (const key of Object.keys(env))
    if (
      key.startsWith("HELM_") ||
      [
        "KUBERNETES_MASTER",
        "KUBERNETES_SERVICE_HOST",
        "KUBERNETES_SERVICE_PORT",
        "DOCKER_CONFIG",
        "DOCKER_AUTH_CONFIG",
      ].includes(key)
    )
      delete env[key];
  return env;
}
/** Helm 4 also falls back to Docker's store, and ORAS detects native helpers
 * for empty stores. A nonempty, credential-free .invalid entry disables that
 * detection in both stores. The caller removes its disposable parent in finally. */
export async function isolatedHelmCredentials(parent: string) {
  const directory = join(parent, "helm-credentials");
  await mkdir(directory, { mode: 0o700 });
  const registry = join(directory, "registry.json");
  const content = JSON.stringify({
    auths: { "waypoint-no-credentials.invalid": {} },
  });
  await writeFile(join(directory, "config.json"), content, { mode: 0o600 });
  await writeFile(registry, content, { mode: 0o600 });
  return { DOCKER_CONFIG: directory, HELM_REGISTRY_CONFIG: registry };
}
