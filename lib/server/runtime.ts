import { mkdir, readFile, writeFile, rename, chmod } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { parse } from "yaml";
import { run } from "./process";
import { kubeconfigIdentity } from "./ownership";
import { fixtureSource, WEB_IMAGE } from "../domain/scenarios";
import {
  semanticChecks,
  validateRepair,
  matchesExpected,
} from "../domain/practice";
import {
  at,
  list,
  object,
  text,
  type LabView,
  type ObjectMap,
  type ScenarioId,
} from "../domain/types";
export const NODE_IMAGE =
  "kindest/node:v1.37.0@sha256:a1ed56cfb0e7b93589bdf97c8cd566405a265939e3620fc4f5de89adff580ae5";
export const stateRoot =
  process.env.PLAYGROUND_STATE_DIR ??
  join(homedir(), ".local", "state", "kubernetes-learning-playground");
type OwnedLab = LabView & {
  clusterName: string;
  kubeconfig: string;
  containerId: string | null;
  fingerprint: string | null;
  namespaceUid: string | null;
  operations: Record<
    string,
    { kind: string; revision: number; generation: number }
  >;
};
export class Conflict extends Error {}
export class Runtime {
  lab: OwnedLab | null = null;
  busy = false;
  polling = false;
  loaded = false;
  async load() {
    if (this.loaded) return;
    this.loaded = true;
    await mkdir(stateRoot, { recursive: true, mode: 0o700 });
    try {
      this.lab = JSON.parse(
        await readFile(join(stateRoot, "session.json"), "utf8"),
      );
      if (this.lab?.operation) {
        this.lab.state = "failed";
        this.lab.error =
          "Previous operation was interrupted. Its outcome may have committed. Inspect current state before retry or reset.";
        this.lab.operation = null;
        await this.save();
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  view(): LabView | null {
    if (!this.lab) return null;
    const {
      id,
      scenario,
      state,
      phase,
      generation,
      revision,
      source,
      operation,
      error,
      observation,
      checks,
      startedAt,
      namespace,
    } = this.lab;
    return {
      id,
      scenario,
      state,
      phase,
      generation,
      revision,
      source,
      operation,
      error,
      observation,
      checks,
      startedAt,
      namespace,
    };
  }
  async save() {
    if (!this.lab) return;
    const p = join(stateRoot, "session.json");
    await writeFile(p + ".tmp", JSON.stringify(this.lab), { mode: 0o600 });
    await rename(p + ".tmp", p);
  }
  async kubectl(args: string[], input?: string, timeout = 30000) {
    if (!this.lab) throw new Error("No owned lab session.");
    return run(
      "kubectl",
      [
        "--kubeconfig",
        this.lab.kubeconfig,
        "--context",
        "kind-" + this.lab.clusterName,
        "--request-timeout=20s",
        ...args,
      ],
      { input, timeout },
    );
  }
  async fingerprint() {
    if (!this.lab) throw new Error("No lab.");
    const config = object(parse(await readFile(this.lab.kubeconfig, "utf8")));
    return kubeconfigIdentity(config, this.lab.clusterName);
  }
  async establishOwnership() {
    const lab = this.lab!;
    const containers = list(
      JSON.parse(
        await run("docker", ["inspect", `${lab.clusterName}-control-plane`]),
      ),
    );
    const c = containers[0];
    if (at(c, "Config", "Labels", "io.x-k8s.kind.cluster") !== lab.clusterName)
      throw new Error("Owned kind container label mismatch.");
    lab.containerId = text(c.Id);
    lab.fingerprint = await this.fingerprint();
  }
  async assertOwned(namespace = true) {
    const lab = this.lab;
    if (!lab || !lab.containerId || !lab.fingerprint)
      throw new Error(
        "Cluster ownership is not established; mutation refused.",
      );
    const containers = list(
      JSON.parse(
        await run("docker", ["inspect", `${lab.clusterName}-control-plane`]),
      ),
    );
    if (
      text(containers[0]?.Id) !== lab.containerId ||
      at(containers[0], "Config", "Labels", "io.x-k8s.kind.cluster") !==
        lab.clusterName ||
      (await this.fingerprint()) !== lab.fingerprint
    )
      throw new Error("Cluster identity changed. Mutation/cleanup refused.");
    if (namespace) {
      const ns = object(
        JSON.parse(
          await this.kubectl(["get", "namespace", lab.namespace, "-o", "json"]),
        ),
      );
      if (
        at(ns, "metadata", "uid") !== lab.namespaceUid ||
        at(ns, "metadata", "labels", "playground-session") !== lab.id
      )
        throw new Error(
          "Namespace ownership changed. Mutation/cleanup refused.",
        );
    }
  }
  async observe() {
    await this.load();
    const lab = this.lab;
    if (
      !lab ||
      ["preparing", "stopped", "resetting"].includes(lab.state) ||
      this.polling ||
      this.busy
    )
      return this.view();
    this.polling = true;
    const generation = lab.generation,
      revision = lab.revision;
    try {
      await this.assertOwned();
      const data = object(
        JSON.parse(
          await this.kubectl([
            "get",
            "pods,deployments,replicasets,services,configmaps,endpointslices",
            "-n",
            lab.namespace,
            "-o",
            "json",
          ]),
        ),
      );
      if (
        this.lab === lab &&
        lab.generation === generation &&
        lab.revision === revision
      ) {
        lab.observation = {
          sessionId: lab.id,
          generation,
          revision,
          sequence: (lab.observation?.sequence ?? 0) + 1,
          capturedAt: new Date().toISOString(),
          resources: list(data.items),
          errors: [],
        };
        if (lab.error?.startsWith("Observation unavailable:")) lab.error = null;
      }
    } catch (e) {
      lab.error = "Observation unavailable: " + safeError(e);
      if (lab.observation) lab.observation.errors = [lab.error];
    } finally {
      this.polling = false;
    }
    return this.view();
  }
  async capture() {
    const lab = this.lab!;
    const data = object(
      JSON.parse(
        await this.kubectl([
          "get",
          "pods,deployments,replicasets,services,configmaps,endpointslices",
          "-n",
          lab.namespace,
          "-o",
          "json",
        ]),
      ),
    );
    lab.observation = {
      sessionId: lab.id,
      generation: lab.generation,
      revision: lab.revision,
      sequence: (lab.observation?.sequence ?? 0) + 1,
      capturedAt: new Date().toISOString(),
      resources: list(data.items),
      errors: [],
    };
  }
  async start(scenario: ScenarioId) {
    await this.load();
    if (this.busy) throw new Conflict("Another operation is running.");
    if (this.lab && this.lab.state !== "stopped")
      throw new Conflict(
        "Stop the existing owned session before starting another.",
      );
    this.busy = true;
    const id = randomUUID();
    const namespace = "lab-" + id.slice(0, 8);
    this.lab = {
      id,
      scenario,
      state: "preparing",
      phase: "Checking local tools",
      generation: 1,
      revision: 0,
      source: fixtureSource(scenario, namespace, true),
      operation: "start",
      error: null,
      observation: null,
      checks: [],
      startedAt: new Date().toISOString(),
      namespace,
      clusterName: "playground-" + id.slice(0, 8),
      kubeconfig: join(stateRoot, id + ".kubeconfig"),
      containerId: null,
      fingerprint: null,
      namespaceUid: null,
      operations: {},
    };
    await this.save();
    void this.prepare()
      .catch(async (e) => {
        this.lab!.state = "failed";
        this.lab!.error = safeError(e);
      })
      .finally(async () => {
        this.lab!.operation = null;
        this.busy = false;
        await this.save();
      });
    return this.view();
  }
  async prepare() {
    const lab = this.lab!;
    await run("kind", ["version"]);
    await run("docker", ["info", "--format", "{{.ServerVersion}}"]);
    lab.phase = "Creating dedicated kind cluster";
    await this.save();
    await run(
      "kind",
      [
        "create",
        "cluster",
        "--name",
        lab.clusterName,
        "--kubeconfig",
        lab.kubeconfig,
        "--image",
        NODE_IMAGE,
        "--wait",
        "120s",
      ],
      { timeout: 240000 },
    );
    await chmod(lab.kubeconfig, 0o600);
    await this.establishOwnership();
    await this.save();
    await this.assertOwned(false);
    await this.kubectl(
      ["apply", "-f", "-"],
      JSON.stringify({
        apiVersion: "v1",
        kind: "Namespace",
        metadata: {
          name: lab.namespace,
          labels: {
            "playground-session": lab.id,
            "pod-security.kubernetes.io/enforce": "restricted",
          },
        },
      }),
    );
    const ns = object(
      JSON.parse(
        await this.kubectl(["get", "ns", lab.namespace, "-o", "json"]),
      ),
    );
    lab.namespaceUid = text(at(ns, "metadata", "uid"));
    await this.save();
    await this.assertOwned();
    lab.phase = "Testing healthy fixture";
    await this.save();
    await this.kubectl(
      ["apply", "-f", "-"],
      fixtureSource(lab.scenario, lab.namespace, false),
    );
    await this.waitReady();
    await this.createProbe();
    await this.verifyRuntime(fixtureSource(lab.scenario, lab.namespace, false));
    if (lab.checks.some((c) => c.status !== "pass"))
      throw new Error(
        "Healthy fixture did not pass its routing checks. " +
          lab.checks.map((c) => c.explanation).join(" "),
      );
    lab.state = "ready";
    lab.phase = "Healthy fixture verified";
    await this.save();
    await this.inject();
  }
  async createProbe() {
    const lab = this.lab!;
    await this.assertOwned();
    const pod = {
      apiVersion: "v1",
      kind: "Pod",
      metadata: {
        name: "routing-check",
        namespace: lab.namespace,
        labels: { "playground-probe": "true" },
      },
      spec: {
        automountServiceAccountToken: false,
        restartPolicy: "Always",
        securityContext: {
          runAsNonRoot: true,
          runAsUser: 101,
          seccompProfile: { type: "RuntimeDefault" },
        },
        containers: [
          {
            name: "probe",
            image: WEB_IMAGE,
            command: ["/bin/sh", "-c", "sleep 2147483647"],
            securityContext: {
              allowPrivilegeEscalation: false,
              capabilities: { drop: ["ALL"] },
            },
            resources: {
              requests: { cpu: "5m", memory: "8Mi" },
              limits: { cpu: "100m", memory: "64Mi" },
            },
          },
        ],
      },
    };
    await this.kubectl(["apply", "-f", "-"], JSON.stringify(pod));
    await this.kubectl(
      [
        "wait",
        "--for=condition=Ready",
        "pod/routing-check",
        "-n",
        lab.namespace,
        "--timeout=120s",
      ],
      undefined,
      130000,
    );
  }
  async waitReady() {
    const lab = this.lab!;
    await this.kubectl(
      [
        "rollout",
        "status",
        "deployment/web",
        "-n",
        lab.namespace,
        "--timeout=120s",
      ],
      undefined,
      130000,
    );
  }
  async inject() {
    const lab = this.lab!;
    lab.phase = "Injecting one fault";
    await this.assertOwned();
    await this.kubectl(["apply", "-f", "-"], lab.source);
    if (lab.scenario === "configmap-key") {
      await this.kubectl(
        ["delete", "pods", "-n", lab.namespace, "-l", "app=web", "--wait=true"],
        undefined,
        60000,
      );
    }
    lab.state = "running";
    lab.phase = "Investigate the fault";
    lab.checks = [];
    lab.revision++;
    await this.capture();
  }
  async operate(input: {
    kind: "apply" | "verify" | "reset" | "stop";
    operationId: string;
    sessionId: string;
    generation: number;
    expectedRevision: number;
    source?: string;
  }) {
    await this.load();
    const lab = this.lab;
    if (!lab || input.sessionId !== lab.id)
      throw new Conflict("Session changed. Reload observations.");
    const previous = lab.operations[input.operationId];
    if (previous) {
      if (
        previous.kind !== input.kind ||
        previous.revision !== input.expectedRevision ||
        previous.generation !== input.generation
      )
        throw new Conflict("Operation ID was reused for a different request.");
      return this.view();
    }
    if (this.busy || this.polling)
      throw new Conflict(
        "Another operation or observation is in progress. Retry after it settles.",
      );
    if (
      input.generation !== lab.generation ||
      input.expectedRevision !== lab.revision
    )
      throw new Conflict(
        "Stale session or revision. Your source draft is preserved.",
      );
    if (lab.state === "stopped") throw new Conflict("The session is stopped.");
    if (
      input.kind !== "stop" &&
      input.kind !== "reset" &&
      !["running", "completed"].includes(lab.state)
    )
      throw new Conflict("This operation requires a running session.");
    let proposed: ObjectMap[] | undefined;
    if (input.kind === "apply")
      proposed = validateRepair(
        input.source ?? "",
        lab.scenario,
        lab.namespace,
      );
    this.busy = true;
    lab.operation = input.kind;
    lab.error = null;
    lab.operations[input.operationId] = {
      kind: input.kind,
      revision: input.expectedRevision,
      generation: input.generation,
    };
    await this.save();
    void (async () => {
      try {
        if (input.kind === "stop") {
          if (lab.containerId) {
            await this.assertOwned(Boolean(lab.namespaceUid));
          } else {
            const clusters = (await run("kind", ["get", "clusters"])).split(
              "\n",
            );
            if (clusters.includes(lab.clusterName)) {
              throw new Error('A named cluster exists but its creation identity was not recorded. Automatic cleanup refused. Inspect this failed creation manually.');
            }
            lab.state='stopped';lab.phase='No cluster remains from failed preparation';lab.observation=null;return;
          }
          await run(
            "kind",
            [
              "delete",
              "cluster",
              "--name",
              lab.clusterName,
              "--kubeconfig",
              lab.kubeconfig,
            ],
            { timeout: 120000 },
          );
          lab.state = "stopped";
          lab.phase = "Owned cluster removed";
          lab.observation = null;
        } else {
          await this.assertOwned();
          if (input.kind === "apply") {
            lab.phase = "Applying reviewed repair";
            lab.state = "checking";
            await this.kubectl(["apply", "-f", "-"], input.source);
            lab.source = input.source!;
            lab.revision++;
            lab.checks = [];
            await this.capture();
            lab.state = "running";
            lab.phase = "Repair applied. Verify runtime behavior.";
          }
          if (input.kind === "verify") {
            lab.state = "checking";
            lab.phase = "Checking replicas, endpoints and Service routing";
            await this.verifyRuntime(lab.source);
            lab.state = lab.checks.every((c) => c.status === "pass")
              ? "completed"
              : "running";
            lab.phase =
              lab.state === "completed"
                ? "Repair verified"
                : "Repair did not pass every check";
          }
          if (input.kind === "reset") {
            lab.state = "resetting";
            lab.generation++;
            lab.checks = [];
            lab.observation = null;
            lab.phase = "Restoring healthy baseline";
            await this.kubectl(
              ["apply", "-f", "-"],
              fixtureSource(lab.scenario, lab.namespace, false),
            );
            await this.waitReady();
            await this.verifyRuntime(
              fixtureSource(lab.scenario, lab.namespace, false),
            );
            if (lab.checks.some((c) => c.status !== "pass"))
              throw new Error("Reset healthy baseline failed verification.");
            lab.source = fixtureSource(lab.scenario, lab.namespace, true);
            await this.inject();
          }
        }
      } catch (e) {
        lab.state = "failed";
        lab.error = safeError(e);
        lab.phase = "Operation failed; inspect before recovery";
      } finally {
        lab.operation = null;
        this.busy = false;
        await this.save();
      }
    })();
    return this.view();
  }
  async verifyRuntime(source: string) {
    const lab = this.lab!;
    await this.assertOwned();
    const proposed = validateRepair(source, lab.scenario, lab.namespace);
    lab.checks = semanticChecks(proposed, lab.scenario);
    try {
      await this.waitReady();
    } catch {
      lab.checks.push({
        id: "ready",
        status: "fail",
        explanation:
          "Both intended replicas did not become ready before the timeout.",
      });
      await this.capture();
      return;
    }
    await this.capture();
    const resources = lab.observation!.resources;
    const dep = resources.find(
      (r) => r.kind === "Deployment" && at(r, "metadata", "name") === "web",
    );
    lab.checks.push({
      id: "live-invariants",
      status: proposed.every((expected) => {
        const actual = resources.find(
          (r) =>
            r.kind === expected.kind &&
            at(r, "metadata", "name") === at(expected, "metadata", "name"),
        );
        return matchesExpected(expected, actual);
      })
        ? "pass"
        : "fail",
      explanation:
        "Actual resources must preserve the submitted replicas, image, ports, configuration and required probe.",
    });
    const ownedReplicaSets = resources.filter(
      (r) =>
        r.kind === "ReplicaSet" &&
        list(at(r, "metadata", "ownerReferences")).some(
          (owner) =>
            owner.uid === at(dep, "metadata", "uid") &&
            owner.controller === true,
        ),
    );
    const replicaSetUids = new Set(
      ownedReplicaSets.map((r) => at(r, "metadata", "uid")),
    );
    const templateSpec = at(
      proposed.find((r) => r.kind === "Deployment"),
      "spec",
      "template",
      "spec",
    );
    const pods = resources.filter(
      (r) =>
        r.kind === "Pod" &&
        at(r, "metadata", "labels", "app") === "web" &&
        list(at(r, "metadata", "ownerReferences")).some(
          (owner) => replicaSetUids.has(owner.uid) && owner.controller === true,
        ) &&
        matchesExpected(templateSpec, r.spec),
    );
    const ready = pods.filter((p) =>
      list(at(p, "status", "conditions")).some(
        (c) => c.type === "Ready" && c.status === "True",
      ),
    );
    lab.checks.push({
      id: "ready",
      status:
        at(dep, "spec", "replicas") === 2 &&
        ready.length === 2 &&
        at(dep, "status", "observedGeneration") ===
          at(dep, "metadata", "generation")
          ? "pass"
          : "fail",
      explanation: `${ready.length}/2 intended Pods ready; Deployment generation observed.`,
    });
    const slices = resources.filter(
      (r) =>
        r.kind === "EndpointSlice" &&
        at(r, "metadata", "labels", "kubernetes.io/service-name") === "web",
    );
    const endpoints = slices
      .flatMap((s) => list(s.endpoints))
      .filter((e) => at(e, "conditions", "ready") === true);
    const uids = new Set(endpoints.map((e) => at(e, "targetRef", "uid")));
    lab.checks.push({
      id: "endpoints",
      status:
        ready.length === 2 &&
        ready.every((p) => uids.has(at(p, "metadata", "uid"))) &&
        uids.size === 2
          ? "pass"
          : "fail",
      explanation: `${uids.size} ready endpoint Pod references; must cover exactly the intended two Pods.`,
    });
    try {
      const body = await this.kubectl(
        [
          "exec",
          "routing-check",
          "-n",
          lab.namespace,
          "--",
          "wget",
          "-q",
          "-T",
          "5",
          "-O",
          "-",
          `http://web.${lab.namespace}.svc.cluster.local:80/`,
        ],
        undefined,
        10000,
      );
      lab.checks.push({
        id: "service-http",
        status: body.trim() === "kubernetes-playground" ? "pass" : "fail",
        explanation:
          body.trim() === "kubernetes-playground"
            ? "HTTP through Service DNS/port returned the expected lesson body."
            : "Service returned an unexpected body.",
      });
    } catch {
      lab.checks.push({
        id: "service-http",
        status: "fail",
        explanation:
          "HTTP through the Service DNS/port failed. No Pod port-forward was used.",
      });
    }
    if (lab.scenario === "configmap-key") {
      try {
        const v = await this.kubectl([
          "exec",
          text(at(ready[0], "metadata", "name")),
          "-n",
          lab.namespace,
          "--",
          "printenv",
          "HEALTH_TOKEN",
        ]);
        lab.checks.push({
          id: "config-runtime",
          status: v.trim() === "lesson-ready" ? "pass" : "fail",
          explanation:
            "Required HEALTH_TOKEN is present in the running container.",
        });
      } catch {
        lab.checks.push({
          id: "config-runtime",
          status: "fail",
          explanation: "Required runtime configuration could not be confirmed.",
        });
      }
    }
  }
  async inspect(kind: "inspect" | "events" | "logs", name: string) {
    await this.load();
    await this.assertOwned();
    const lab = this.lab!;
    if (kind === "events") {
      const data = object(
        JSON.parse(
          await this.kubectl([
            "get",
            "events",
            "-n",
            lab.namespace,
            "-o",
            "json",
          ]),
        ),
      );
      return list(data.items)
        .slice(-50)
        .map((e) => ({
          reason: e.reason,
          message: e.message,
          at: e.lastTimestamp ?? e.eventTime,
          resource: at(e, "involvedObject", "name"),
        }));
    }
    const pods =
      lab.observation?.resources.filter((r) => r.kind === "Pod") ?? [];
    if (kind === "logs") {
      if (!pods.some((p) => at(p, "metadata", "name") === name))
        throw new Error("Select an observed owned Pod.");
      return await this.kubectl([
        "logs",
        name,
        "-n",
        lab.namespace,
        "--container=web",
        "--tail=100",
        "--limit-bytes=16384",
        "--timestamps=true",
      ]);
    }
    return (
      lab.observation?.resources.filter(
        (r) => !name || at(r, "metadata", "name") === name,
      ) ?? []
    );
  }
}
export function safeError(e: unknown) {
  return (e instanceof Error ? e.message : String(e))
    .replace(
      /(token|password|secret|authorization)[=:]\s*\S+/gi,
      "$1=[redacted]",
    )
    .slice(0, 6000);
}
const globalRuntime = globalThis as typeof globalThis & {
  playgroundRuntime?: Runtime;
};
export const runtime = (globalRuntime.playgroundRuntime ??= new Runtime());
// Keep session ownership while replacing method definitions during Next dev HMR.
Object.setPrototypeOf(runtime, Runtime.prototype);
