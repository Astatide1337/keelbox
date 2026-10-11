import { createHash } from "node:crypto";
import { stringify } from "yaml";
import { parseSources } from "./importer";
import {
  at,
  list,
  object,
  text,
  type ObjectMap,
  type SourceFile,
} from "./types";
import type { Snapshot } from "./snapshot";
export type HttpContract = {
  namespace?: string;
  deployment: string;
  container: string;
  service: string;
  port: number;
  path: string;
  probePort: number | string;
  livenessPath?: string;
  gateway?: {
    deployment: string;
    service: string;
    port: number;
    path: string;
    backendService: string;
  };
};
export type DeploymentPlan = {
  sourceHash: string;
  planHash: string;
  namespace: string;
  namespaceMap: Record<string, string>;
  resources: ObjectMap[];
  source: string;
  changes: string[];
  blockers: string[];
  contract: HttpContract | null;
  contracts: HttpContract[];
  original: SourceFile[];
  configurationRevision: string;
  secretRequirements: { namespace: string; name: string; keys: string[] }[];
  needsIngress: boolean;
  needsVault: boolean;
  localImages: { original: string; reference: string; imageId: string }[];
};
export const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type TestConfiguration = {
  images?: { original: string; reference: string; imageId: string }[];
  revision: string;
  vault?: {
    entries: { mount: string; path: string; role: string; keys: string[] }[];
  };
  secrets: { namespace: string; name: string; type: string; keys: string[] }[];
};
const appKinds = new Set([
  "Deployment",
  "StatefulSet",
  "DaemonSet",
  "Job",
  "CronJob",
  "Pod",
  "Service",
  "ConfigMap",
  "Secret",
  "ServiceAccount",
  "Role",
  "RoleBinding",
  "Ingress",
  "PersistentVolumeClaim",
  "NetworkPolicy",
  "HorizontalPodAutoscaler",
  "PodDisruptionBudget",
  "Route",
  "SecretProviderClass",
]);
export function deploymentPlan(
  project: Snapshot,
  namespace: string,
  configuration: TestConfiguration = { revision: digest([]), secrets: [] },
): DeploymentPlan {
  if (!/^waypoint-lab-[a-f0-9]{12}$/.test(namespace))
    throw Error("Invalid owned namespace.");
  const blockers: string[] = [],
    changes: string[] = [],
    resources: ObjectMap[] = [];
  if (project.origin === "captured")
    blockers.push(
      "Captured snapshots omit configuration values. Import authored manifests and explicit local test configuration before deployment.",
    );
  const parsed = parseSources(project.files);
  blockers.push(
    ...parsed.diagnostics.map((d) => `${d.fileId}:${d.line}: ${d.message}`),
  );
  const namespaces = new Set(
    parsed.resources
      .filter((r) => r.kind !== "Namespace")
      .map((r) => r.namespace ?? "default"),
  );
  const namespaceMap = Object.fromEntries(
    [...namespaces]
      .sort()
      .map((ns, i) => [
        ns,
        i === 0 ? namespace : namespace + "-" + digest(ns).slice(0, 8),
      ]),
  );
  for (const ns of Object.values(namespaceMap))
    if (ns !== namespace)
      resources.push({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: { name: ns, labels: { "waypoint.dev/lab": namespace } },
      });
  const secretRequirements = new Map<
    string,
    { namespace: string; name: string; keys: Set<string> }
  >();
  const requireSecret = (
    name: string,
    sourceNamespace: string,
    key?: string,
  ) => {
    const id = sourceNamespace + "/" + name;
    const ref = secretRequirements.get(id) ?? {
      namespace: sourceNamespace,
      name,
      keys: new Set<string>(),
    };
    if (key) ref.keys.add(key);
    secretRequirements.set(id, ref);
    const local = configuration.secrets.find(
      (s) => s.namespace === sourceNamespace && s.name === name,
    );
    if (!local || (key && !local.keys.includes(key)))
      blockers.push(
        `Secret/${name}: configure local test ${key ? "key " + key : "values"} in Secrets / Vault`,
      );
  };
  const configKeys = new Map(
    parsed.resources
      .filter((r) => r.kind === "ConfigMap")
      .map((r) => [
        (r.namespace ?? "default") + "/" + r.name,
        new Set(Object.keys(object(r.raw.data))),
      ]),
  );
  for (const r of parsed.resources) {
    if (
      ["Pod", "ReplicaSet", "EndpointSlice", "Event"].includes(r.kind) &&
      list(at(r.raw, "metadata", "ownerReferences")).length
    ) {
      changes.push(`${r.kind}/${r.name}: generated resource excluded`);
      continue;
    }
    if (r.kind === "Namespace") {
      changes.push(`Namespace/${r.name}: mapped to owned namespace`);
      continue;
    }
    if (!appKinds.has(r.kind)) {
      blockers.push(
        `${r.kind}/${r.name}: unsupported; resolve this dependency explicitly`,
      );
      continue;
    }
    const value = structuredClone(r.raw),
      metadata = object(value.metadata);
    value.metadata = {
      name: r.name,
      namespace: namespaceMap[r.namespace ?? "default"] ?? namespace,
      ...(metadata.labels ? { labels: metadata.labels } : {}),
      ...(metadata.annotations
        ? {
            annotations: Object.fromEntries(
              Object.entries(object(metadata.annotations)).filter(
                ([k]) =>
                  !k.startsWith("kubectl.") &&
                  !k.startsWith("deployment.kubernetes.io/"),
              ),
            ),
          }
        : {}),
    };
    delete value.status;
    changes.push(
      `${r.kind}/${r.name}: namespace ${r.namespace ?? "default"} → ${namespace}; server metadata/status removed`,
    );
    if (r.kind === "SecretProviderClass") {
      requireSecret(r.name, r.namespace ?? "default");
      changes.push(
        `SecretProviderClass/${r.name}: explicit local test Secret substitutes provider-mounted files; no source provider credentials are copied`,
      );
      continue;
    }
    if (r.kind === "Route") {
      const backend = object(at(value, "spec", "to"));
      if (backend.kind && backend.kind !== "Service")
        blockers.push(
          `Route/${r.name}: local Ingress requires a Service backend.`,
        );
      if (at(value, "spec", "tls", "termination") === "passthrough")
        blockers.push(
          `Route/${r.name}: TLS passthrough requires explicit local ingress configuration.`,
        );
      value.kind = "Ingress";
      value.apiVersion = "networking.k8s.io/v1";
      value.spec = {
        ingressClassName: "nginx",
        rules: [
          {
            http: {
              paths: [
                {
                  path: text(at(r.raw, "spec", "path")) || "/",
                  pathType: "Prefix",
                  backend: {
                    service: {
                      name: text(backend.name),
                      port:
                        typeof at(r.raw, "spec", "port", "targetPort") ===
                        "number"
                          ? { number: at(r.raw, "spec", "port", "targetPort") }
                          : {
                              name:
                                text(at(r.raw, "spec", "port", "targetPort")) ||
                                "http",
                            },
                    },
                  },
                },
              ],
            },
          },
        ],
      };
      changes.push(
        `Route/${r.name}: translated to local nginx Ingress; original hostname/TLS are not published`,
      );
    }
    if (r.kind === "Secret") {
      let keys: string[] = [];
      try {
        keys = JSON.parse(
          text(
            at(value, "metadata", "annotations", "waypoint.dev/secret-keys"),
          ) || "[]",
        );
      } catch {}
      keys = [
        ...new Set([
          ...keys,
          ...Object.keys(object(value.data)),
          ...Object.keys(object(value.stringData)),
        ]),
      ];
      delete value.data;
      delete value.stringData;
      requireSecret(r.name, r.namespace ?? "default");
      for (const key of keys)
        requireSecret(r.name, r.namespace ?? "default", key);
      continue;
    }
    if (r.kind === "Ingress") {
      const cls =
        at(value, "spec", "ingressClassName") ??
        at(value, "metadata", "annotations", "kubernetes.io/ingress.class");
      if (cls && cls !== "nginx")
        blockers.push(
          `Ingress/${r.name}: configure the ${cls} controller for this local application.`,
        );
      else object(value.spec).ingressClassName = "nginx";
      for (const tls of list(at(value, "spec", "tls")))
        if (tls.secretName)
          requireSecret(text(tls.secretName), r.namespace ?? "default");
    }
    if (r.kind === "Service") {
      for (const k of [
        "clusterIP",
        "clusterIPs",
        "ipFamilies",
        "ipFamilyPolicy",
        "healthCheckNodePort",
      ])
        if (k === "clusterIP" && at(value, "spec", k) === "None") continue;
        else delete object(value.spec)[k];
      if (at(value, "spec", "externalIPs")) {
        delete object(value.spec).externalIPs;
        changes.push(
          `Service/${r.name}: external IP binding removed for local deployment`,
        );
      }
      for (const port of list(at(value, "spec", "ports"))) delete port.nodePort;
    }
    if (
      [
        "Deployment",
        "StatefulSet",
        "DaemonSet",
        "Job",
        "CronJob",
        "Pod",
      ].includes(r.kind)
    ) {
      const pod = object(
        r.kind === "Pod"
          ? value.spec
          : r.kind === "CronJob"
            ? at(value, "spec", "jobTemplate", "spec", "template", "spec")
            : at(value, "spec", "template", "spec"),
      );
      const annotations = object(
        r.kind === "Pod"
          ? at(value, "metadata", "annotations")
          : r.kind === "CronJob"
            ? at(
                value,
                "spec",
                "jobTemplate",
                "spec",
                "template",
                "metadata",
                "annotations",
              )
            : at(value, "spec", "template", "metadata", "annotations"),
      );
      if (
        Object.keys(annotations).some((k) =>
          k.startsWith("vault.hashicorp.com/"),
        )
      ) {
        const role = text(annotations["vault.hashicorp.com/role"]);
        if (!role || !configuration.vault?.entries.some((e) => e.role === role))
          blockers.push(
            `${r.kind}/${r.name}: configure local Vault test values for role ${role || "(missing)"} in Secrets / Vault`,
          );
        for (const [key, path] of Object.entries(annotations).filter(([key]) =>
          key.startsWith("vault.hashicorp.com/agent-inject-secret-"),
        )) {
          const entry = configuration.vault?.entries.find(
            (e) => e.role === role && `${e.mount}/data/${e.path}` === path,
          );
          if (!entry)
            blockers.push(
              `${r.kind}/${r.name}: local Vault path ${text(path)} is not configured`,
            );
        }
        annotations["vault.hashicorp.com/service"] =
          `http://waypoint-vault.${namespace}-vault.svc:8200`;
        changes.push(
          `${r.kind}/${r.name}: Vault Agent uses the owned local Vault with explicitly supplied test values`,
        );
      }
      if (
        pod.hostNetwork ||
        pod.hostPID ||
        pod.hostIPC ||
        pod.shareProcessNamespace
      )
        blockers.push(
          `${r.kind}/${r.name}: host/process access cannot run in the local lab.`,
        );
      if (pod.nodeName) {
        delete pod.nodeName;
        changes.push(`${r.kind}/${r.name}: source node binding removed`);
      }
      if (r.kind === "Deployment" || r.kind === "StatefulSet") {
        const replicas = at(value, "spec", "replicas") ?? 1;
        if (
          typeof replicas !== "number" ||
          !Number.isInteger(replicas) ||
          replicas < 0
        )
          blockers.push(`${r.kind}/${r.name}: invalid replica count`);
        object(value.spec).replicas = replicas;
      }
      const pulls = configuration.secrets.filter(
        (s) =>
          s.namespace === (r.namespace ?? "default") &&
          s.type === "kubernetes.io/dockerconfigjson",
      );
      if (pulls.length) {
        pod.imagePullSecrets = [
          ...list(pod.imagePullSecrets),
          ...pulls
            .filter(
              (s) => !list(pod.imagePullSecrets).some((r) => r.name === s.name),
            )
            .map((s) => ({ name: s.name })),
        ];
        changes.push(
          `${r.kind}/${r.name}: explicitly supplied local registry pull credentials attached`,
        );
      }
      for (const ref of list(pod.imagePullSecrets))
        requireSecret(text(ref.name), r.namespace ?? "default");
      for (const c of [...list(pod.initContainers), ...list(pod.containers)]) {
        const local = configuration.images?.find((i) => i.original === c.image);
        if (local) {
          c.image = local.reference;
          c.imagePullPolicy = "Never";
          changes.push(
            `${r.kind}/${r.name}, container ${text(c.name)}: ${local.original} → local Docker image ${local.reference} (${local.imageId}); pull policy Never`,
          );
        }
        // Imported trusted application images are preserved. Registry authentication
        // and pull failures are observed from Kubernetes, never guessed from a name.
        if (
          !text(c.image) ||
          /[\s\x00-\x1f]/.test(text(c.image)) ||
          text(c.image).includes("://")
        )
          blockers.push(
            `Deployment/${r.name}: invalid container image reference`,
          );
        const sec = object(c.securityContext),
          capabilities = object(sec.capabilities);
        if (
          sec.privileged ||
          sec.allowPrivilegeEscalation === true ||
          (Array.isArray(capabilities.add)
            ? capabilities.add.length > 0
            : capabilities.add !== undefined) ||
          Object.keys(capabilities).some(
            (key) => !["drop", "add"].includes(key),
          ) ||
          (sec.procMount !== undefined && sec.procMount !== "Default") ||
          sec.runAsUser === 0
        )
          blockers.push(
            `Deployment/${r.name}: dangerous security configuration`,
          );
        for (const e of list(c.env)) {
          if (
            at(e, "valueFrom", "secretKeyRef") &&
            at(e, "valueFrom", "secretKeyRef", "optional") !== true
          )
            requireSecret(
              text(at(e, "valueFrom", "secretKeyRef", "name")),
              r.namespace ?? "default",
              text(at(e, "valueFrom", "secretKeyRef", "key")),
            );
          const ref = object(at(e, "valueFrom", "configMapKeyRef"));
          if (
            ref.name &&
            !configKeys
              .get((r.namespace ?? "default") + "/" + text(ref.name))
              ?.has(text(ref.key))
          )
            blockers.push(
              `Deployment/${r.name}: missing ConfigMap key ${text(ref.name)}/${text(ref.key)}`,
            );
        }
        for (const e of list(c.envFrom)) {
          if (e.secretRef && at(e, "secretRef", "optional") !== true)
            requireSecret(
              text(at(e, "secretRef", "name")),
              r.namespace ?? "default",
            );
          if (
            e.configMapRef &&
            !configKeys.has(
              (r.namespace ?? "default") +
                "/" +
                text(at(e, "configMapRef", "name")),
            )
          )
            blockers.push(`Deployment/${r.name}: missing ConfigMap reference`);
        }
      }
      for (const v of list(pod.volumes)) {
        if (at(v, "csi", "driver") === "secrets-store.csi.k8s.io") {
          const name = text(
            at(v, "csi", "volumeAttributes", "secretProviderClass"),
          );
          requireSecret(name, r.namespace ?? "default");
          delete v.csi;
          v.secret = { secretName: name };
          changes.push(
            `${r.kind}/${r.name}: CSI volume ${text(v.name)} uses explicitly supplied local test Secret ${name}`,
          );
        }
        if (v.hostPath)
          blockers.push(`${r.kind}/${r.name}: hostPath is not permitted.`);
        if (v.secret && at(v, "secret", "optional") !== true) {
          requireSecret(
            text(at(v, "secret", "secretName")),
            r.namespace ?? "default",
          );
          for (const item of list(at(v, "secret", "items")))
            requireSecret(
              text(at(v, "secret", "secretName")),
              r.namespace ?? "default",
              text(item.key),
            );
        }
        if (
          v.configMap &&
          at(v, "configMap", "optional") !== true &&
          !configKeys.has(
            (r.namespace ?? "default") + "/" + text(at(v, "configMap", "name")),
          )
        )
          blockers.push(`${r.kind}/${r.name}: missing volume ConfigMap`);
        if (
          v.persistentVolumeClaim &&
          !parsed.resources.some(
            (p) =>
              p.kind === "PersistentVolumeClaim" &&
              (p.namespace ?? "default") === (r.namespace ?? "default") &&
              p.name === text(at(v, "persistentVolumeClaim", "claimName")),
          )
        )
          blockers.push(
            `${r.kind}/${r.name}: missing PVC ${text(at(v, "persistentVolumeClaim", "claimName"))}`,
          );
        for (const projected of list(at(v, "projected", "sources")))
          if (projected.secret)
            requireSecret(
              text(at(projected, "secret", "name")),
              r.namespace ?? "default",
            );
      }
      for (const c of [...list(pod.containers), ...list(pod.initContainers)])
        for (const port of list(c.ports))
          if (port.hostPort)
            blockers.push(`${r.kind}/${r.name}: hostPort is not permitted.`);
      if (
        pod.serviceAccountName &&
        pod.serviceAccountName !== "default" &&
        !parsed.resources.some(
          (p) =>
            p.kind === "ServiceAccount" &&
            (p.namespace ?? "default") === (r.namespace ?? "default") &&
            p.name === pod.serviceAccountName,
        )
      )
        blockers.push(
          `${r.kind}/${r.name}: missing ServiceAccount ${text(pod.serviceAccountName)}`,
        );
    }
    if (r.kind === "RoleBinding")
      for (const subject of list(value.subjects))
        if (subject.kind === "ServiceAccount")
          subject.namespace =
            namespaceMap[text(subject.namespace) || r.namespace || "default"] ??
            text(subject.namespace);
    resources.push(value);
  }
  if (
    !resources.some((r) =>
      [
        "Deployment",
        "StatefulSet",
        "DaemonSet",
        "Pod",
        "Job",
        "CronJob",
      ].includes(text(r.kind)),
    )
  )
    blockers.push("Select an application containing a workload.");
  let contract: HttpContract | null = null;
  const contracts: HttpContract[] = [];
  for (const dep of resources.filter((r) => r.kind === "Deployment")) {
    if (Number(at(dep, "spec", "replicas") ?? 1) === 0) continue;
    for (const c of list(at(dep, "spec", "template", "spec", "containers"))) {
      const probe = object(at(c, "readinessProbe", "httpGet"));
      if (
        !probe.path ||
        !probe.port ||
        probe.scheme === "HTTPS" ||
        probe.host ||
        probe.httpHeaders
      )
        continue;
      const labels = object(at(dep, "spec", "template", "metadata", "labels"));
      const probePort =
        typeof probe.port === "number"
          ? probe.port
          : list(c.ports).find((p) => p.name === probe.port)?.containerPort;
      const service = resources.find(
        (r) =>
          r.kind === "Service" &&
          at(r, "metadata", "namespace") === at(dep, "metadata", "namespace") &&
          Object.keys(object(at(r, "spec", "selector"))).length &&
          Object.entries(object(at(r, "spec", "selector"))).every(
            ([k, v]) => labels[k] === v,
          ) &&
          list(at(r, "spec", "ports")).some((p) => {
            const target = p.targetPort ?? p.port;
            const number =
              typeof target === "number"
                ? target
                : list(c.ports).find((cp) => cp.name === target)?.containerPort;
            return (
              p.protocol !== "UDP" &&
              probePort !== undefined &&
              number === probePort
            );
          }),
      );
      const port = list(at(service, "spec", "ports")).find((p) => {
        const target = p.targetPort ?? p.port;
        const targetNumber =
          typeof target === "number"
            ? target
            : list(c.ports).find((cp) => cp.name === target)?.containerPort;
        return (
          p.protocol !== "UDP" &&
          probePort !== undefined &&
          targetNumber === probePort
        );
      });
      if (service && port && typeof port.port === "number") {
        const candidate: HttpContract = {
          namespace: text(at(dep, "metadata", "namespace")),
          deployment: text(at(dep, "metadata", "name")),
          container: text(c.name),
          service: text(at(service, "metadata", "name")),
          port: port.port,
          path: text(probe.path),
          probePort: probe.port as number | string,
          livenessPath:
            text(at(c, "livenessProbe", "httpGet", "path")) || undefined,
        };
        contracts.push(candidate);
      }
    }
  }
  contract = contracts[0] ?? null;
  function rewriteDNS(v: unknown): unknown {
    if (typeof v === "string") {
      let result = v;
      for (const [original, owned] of Object.entries(namespaceMap))
        result = result.replaceAll(`.${original}.svc`, `.${owned}.svc`);
      if (result !== v)
        changes.push(
          "Cross-namespace Service DNS rewritten to owned namespaces",
        );
      return result;
    }
    if (Array.isArray(v)) return v.map(rewriteDNS);
    if (v && typeof v === "object")
      return Object.fromEntries(
        Object.entries(v).map(([k, x]) => [k, rewriteDNS(x)]),
      );
    return v;
  }
  for (let i = 0; i < resources.length; i++)
    resources[i] = rewriteDNS(resources[i]) as ObjectMap;
  const source = resources.map((r) => stringify(r)).join("---\n"),
    sourceHash = digest(project.files);
  return {
    sourceHash,
    planHash: digest({
      sourceHash,
      namespace,
      resources,
      contract,
      configurationRevision: configuration.revision,
    }),
    namespace,
    namespaceMap,
    resources,
    source,
    changes,
    blockers: [...new Set(blockers)],
    contract,
    contracts,
    original: structuredClone(project.files),
    configurationRevision: configuration.revision,
    secretRequirements: [...secretRequirements.values()].map((r) => ({
      ...r,
      keys: [...r.keys],
    })),
    localImages: configuration.images ?? [],
    needsIngress: resources.some((r) => r.kind === "Ingress"),
    needsVault: resources.some((r) =>
      Object.keys(
        object(
          r.kind === "Pod"
            ? at(r, "metadata", "annotations")
            : r.kind === "CronJob"
              ? at(
                  r,
                  "spec",
                  "jobTemplate",
                  "spec",
                  "template",
                  "metadata",
                  "annotations",
                )
              : at(r, "spec", "template", "metadata", "annotations"),
        ),
      ).some((k) => k.startsWith("vault.hashicorp.com/")),
    ),
  };
}
export function validateLabRepair(
  plan: DeploymentPlan,
  source: string,
  allowServiceSelector = false,
) {
  const parsed = parseSources([
    { id: "repair", name: "lab.yaml", content: source },
  ]);
  if (parsed.diagnostics.length)
    throw Error(
      parsed.diagnostics.map((d) => `Line ${d.line}: ${d.message}`).join("; "),
    );
  const expected = structuredClone(plan.resources),
    repaired = parsed.resources.map((r) => r.raw),
    actual = structuredClone(repaired);
  if (expected.length !== actual.length)
    throw Error(
      "Keep every baseline resource; deletion or extra resources are not a repair.",
    );
  for (const baseline of expected) {
    const v = actual.find(
      (r) =>
        r.kind === baseline.kind &&
        at(r, "metadata", "name") === at(baseline, "metadata", "name") &&
        at(r, "metadata", "namespace") ===
          at(baseline, "metadata", "namespace"),
    );
    if (!v) throw Error("Baseline resource missing.");
    // These exercises permit probe HTTP path repairs only. Everything else remains reviewed baseline.
    if (
      baseline.kind === "Deployment" &&
      at(baseline, "metadata", "name") === plan.contract?.deployment &&
      at(baseline, "metadata", "namespace") === plan.contract?.namespace
    )
      for (const field of ["readinessProbe", "livenessProbe"]) {
        const bc = list(
            at(baseline, "spec", "template", "spec", "containers"),
          ).find((c) => c.name === plan.contract?.container),
          vc = list(at(v, "spec", "template", "spec", "containers")).find(
            (c) => c.name === plan.contract?.container,
          );
        if (at(bc, field, "httpGet", "path"))
          object(at(vc, field, "httpGet")).path = at(
            bc,
            field,
            "httpGet",
            "path",
          );
      }
    if (
      allowServiceSelector &&
      baseline.kind === "Service" &&
      at(baseline, "metadata", "name") ===
        plan.contract?.gateway?.backendService
    )
      object(v?.spec).selector = at(baseline, "spec", "selector");
    if (digest(baseline) !== digest(v))
      throw Error(
        "Repair must preserve replicas, resources, dependencies, images and required probes. Only HTTP probe paths may change.",
      );
  }
  return repaired;
}
