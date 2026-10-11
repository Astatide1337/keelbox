import {
  helmBaseEnvironment,
  isolatedHelmCredentials,
} from "./helm-environment";
import { join } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { at, list, object, text } from "../domain/types";
import { stringify } from "yaml";
import { kube, assertOwned, environment, type OwnedTarget } from "./minikube";
import { run } from "./process";
import type { DeploymentPlan } from "../domain/deployment-plan";
import type { VaultEntry } from "./local-configuration";
// Development Vault is owned by the disposable cluster. No source Vault is contacted.
export async function prepareVault(
  target: OwnedTarget,
  plan: DeploymentPlan,
  config: { rootToken: string; entries: VaultEntry[] },
) {
  await assertOwned(target);
  const namespace = target.namespace + "-vault",
    temporary = await mkdtemp(join(target.home, "vault-values-"));
  const values = join(temporary, "values.yaml");
  let stage = "installing the official Vault chart";
  try {
    const helmEnv = {
      ...helmBaseEnvironment(environment(target)),
      HELM_PLUGINS: join(temporary, "plugins"),
      HELM_CONFIG_HOME: join(temporary, "config"),
      HELM_CACHE_HOME: join(temporary, "cache"),
      HELM_DATA_HOME: join(temporary, "data"),
      ...(await isolatedHelmCredentials(temporary)),
      HELM_REPOSITORY_CONFIG: join(temporary, "config", "repositories.yaml"),
      HELM_REPOSITORY_CACHE: join(temporary, "cache", "repository"),
    };
    await writeFile(
      values,
      stringify({
        server: {
          dev: { enabled: true, devRootToken: config.rootToken },
          authDelegator: { enabled: true },
          resources: {
            requests: { cpu: "100m", memory: "128Mi" },
            limits: { cpu: "500m", memory: "256Mi" },
          },
        },
        injector: {
          enabled: true,
          resources: {
            requests: { cpu: "50m", memory: "64Mi" },
            limits: { cpu: "200m", memory: "128Mi" },
          },
        },
        ui: { enabled: false },
      }),
      { mode: 0o600 },
    );
    let installed = false;
    try {
      const releases = JSON.parse(
        await run(
          process.env.WAYPOINT_HELM_BIN ?? "helm",
          [
            "list",
            "--kubeconfig",
            target.kubeconfig,
            "--kube-context",
            target.profile,
            "--namespace",
            namespace,
            "--filter",
            "^waypoint-vault$",
            "--output",
            "json",
          ],
          {
            env: helmEnv,
          },
        ),
      );
      installed = releases.some(
        (r: { name: string; chart: string; status: string }) =>
          r.name === "waypoint-vault" &&
          r.chart === "vault-0.34.1" &&
          r.status === "deployed",
      );
    } catch {
      /* A fresh owned cluster has no Vault release yet. */
    }
    if (!installed) {
      const version = await run(
        process.env.WAYPOINT_HELM_BIN ?? "helm",
        ["version", "--short"],
        { env: helmEnv },
      );
      const clientApply = /^v4\./.test(version.trim())
        ? ["--server-side=false"]
        : [];
      await run(
        process.env.WAYPOINT_HELM_BIN ?? "helm",
        [
          "upgrade",
          ...clientApply,
          "--install",
          "waypoint-vault",
          "vault",
          "--repo",
          "https://helm.releases.hashicorp.com",
          "--version",
          "0.34.1",
          "--kubeconfig",
          target.kubeconfig,
          "--kube-context",
          target.profile,
          "--namespace",
          namespace,
          "--create-namespace",
          "--values",
          values,
          "--wait",
          "--timeout",
          "180s",
        ],
        {
          env: helmEnv,
          timeout: 200000,
        },
      );
    }
    stage = "waiting for local Vault readiness";
    await kube(
      target,
      [
        "-n",
        namespace,
        "wait",
        "--for=condition=Ready",
        "pod/waypoint-vault-0",
        "--timeout=120s",
      ],
      undefined,
      130000,
    );
    await kube(
      target,
      [
        "-n",
        namespace,
        "rollout",
        "status",
        "deployment/waypoint-vault-agent-injector",
        "--timeout=120s",
      ],
      undefined,
      130000,
    );
    await assertOwned(target);
    const exec = (args: string[], input?: string) =>
      kube(
        target,
        [
          "-n",
          namespace,
          "exec",
          "-i",
          "waypoint-vault-0",
          "--",
          "sh",
          "-c",
          'IFS= read -r VAULT_TOKEN; export VAULT_TOKEN; exec vault "$@"',
          "vault",
          ...args,
        ],
        config.rootToken + "\n" + (input ?? ""),
      );
    stage = "configuring local Vault authentication and test data";
    const mounts = JSON.parse(await exec(["secrets", "list", "-format=json"]));
    for (const mount of new Set(config.entries.map((e) => e.mount)))
      if (!mounts[mount + "/"])
        await exec(["secrets", "enable", "-path=" + mount, "-version=2", "kv"]);
    const auth = JSON.parse(await exec(["auth", "list", "-format=json"]));
    if (!auth["kubernetes/"]) await exec(["auth", "enable", "kubernetes"]);
    await exec([
      "write",
      "auth/kubernetes/config",
      "kubernetes_host=https://kubernetes.default.svc:443",
    ]);
    for (const entry of config.entries)
      await exec(
        ["kv", "put", entry.mount + "/" + entry.path, "-"],
        JSON.stringify(entry.values),
      );
    const namespaces = Object.values(
      plan.namespaceMap ?? { default: target.namespace },
    );
    for (const role of new Set(config.entries.map((e) => e.role))) {
      const entries = config.entries.filter((e) => e.role === role),
        policy = "waypoint-" + role;
      await exec(
        ["policy", "write", policy, "-"],
        entries
          .map(
            (e) =>
              `path "${e.mount}/data/${e.path}" { capabilities = ["read"] }`,
          )
          .join("\n"),
      );
      // Tokens are bound only to the disposable application's namespaces and short lived.
      await exec([
        "write",
        "auth/kubernetes/role/" + role,
        "bound_service_account_names=" +
          [
            ...new Set(
              plan.resources.flatMap((r) => {
                const template =
                  r.kind === "Pod"
                    ? r
                    : r.kind === "CronJob"
                      ? object(at(r, "spec", "jobTemplate", "spec", "template"))
                      : object(at(r, "spec", "template"));
                return at(
                  template,
                  "metadata",
                  "annotations",
                  "vault.hashicorp.com/role",
                ) === role
                  ? [
                      text(at(template, "spec", "serviceAccountName")) ||
                        "default",
                    ]
                  : [];
              }),
            ),
          ].join(","),
        "bound_service_account_namespaces=" + namespaces.join(","),
        "policies=" + policy,
        "ttl=15m",
      ]);
    }
  } catch (error) {
    let reason = (error as Error).message;
    for (const value of [
      config.rootToken,
      ...config.entries.flatMap((e) => Object.values(e.values)),
    ])
      if (value) reason = reason.replaceAll(value, "[redacted]");
    throw Error(
      `Local Vault setup failed while ${stage}: ${reason.slice(0, 2000)}. No source Vault was contacted.`,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
