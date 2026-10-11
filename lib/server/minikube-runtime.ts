import { prepareVault } from "./local-vault";
import {
  validateRecipe,
  type IncidentRecipe,
  targetKey,
} from "../domain/generated-incident";
import { LocalConfiguration } from "./local-configuration";
import { run } from "./process";
import { onProfileChange } from "./auth/session";
import { doctor } from "../../cli/doctor";
import { readFile } from "node:fs/promises";
import { acquireOperationLock, type OperationLock } from "./operation-lock";
import { join, dirname } from "node:path";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { stringify } from "yaml";
import {
  digest,
  deploymentPlan,
  validateLabRepair,
  type DeploymentPlan,
} from "../domain/deployment-plan";
import { at, list, object, text, type ObjectMap } from "../domain/types";
import type { Snapshot } from "../domain/snapshot";
import {
  minikubeBinary,
  environment,
  createCluster,
  completeOwnership,
  assertNeverCreated,
  deleteCluster,
  assertOwned,
  atomicJson,
  privateDirectory,
  kube,
  type OwnedTarget,
} from "./minikube";
import { LiveCache } from "./observations/cache";
export type LabPhase =
  | "preparing"
  | "ready"
  | "running"
  | "checking"
  | "completed"
  | "failed"
  | "resetting"
  | "stopped";
export type LiveLab = {
  id: string;
  profile: string;
  namespace: string;
  phase: LabPhase;
  generation: number;
  revision: number;
  plan: DeploymentPlan;
  source: string;
  incident: "readiness" | "liveness" | null;
  recipe?: IncidentRecipe;
  operation: string | null;
  error: string | null;
  checks: { name: string; passed: boolean; detail: string }[];
  target: OwnedTarget;
  startedAt: string;
  operations: Record<
    string,
    { kind: string; generation: number; revision: number; requestHash?: string }
  >;
};
export class LabConflict extends Error {}
export class MinikubeRuntime {
  private lab: LiveLab | null = null;
  private loaded = false;
  private cache: LiveCache | null = null;
  private pending: DeploymentPlan | null = null;
  private proposals = new Map<
    string,
    {
      recipe: IncidentRecipe;
      sessionId: string;
      generation: number;
      revision: number;
    }
  >();
  private recovering = false;
  private loading: Promise<void> | null = null;
  private saving: Promise<void> = Promise.resolve();
  constructor(private root: string) {}
  private file() {
    return join(this.root, "minikube-session.json");
  }
  private save() {
    const snapshot = structuredClone(this.lab);
    this.saving = this.saving.then(() => atomicJson(this.file(), snapshot));
    return this.saving;
  }
  private async acquire() {
    await privateDirectory(this.root);
    return acquireOperationLock(join(this.root, "lab-operation.lock"));
  }
  private async release(handle: OperationLock) {
    await handle.close();
  }
  private async refreshLocked() {
    try {
      this.lab = JSON.parse(await readFile(this.file(), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
  }
  async load() {
    if (this.loading) return this.loading;
    if (this.loaded) return;
    this.loading = this.loadOnce();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  private async loadOnce() {
    if (this.loaded) return;
    await privateDirectory(this.root);
    try {
      this.lab = JSON.parse(await readFile(this.file(), "utf8"));
      if (this.lab?.operation) {
        this.lab.phase = "failed";
        this.lab.error =
          "Operation interrupted. Inspect actual state before retry or reset.";
        this.lab.operation = null;
        // Recovery is in-memory until an operation acquires the process lock.
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    this.loaded = true;
    if (
      this.lab &&
      this.lab.phase !== "stopped" &&
      this.lab.target.markerUid &&
      !this.recovering
    ) {
      this.recovering = true;
      try {
        await assertOwned(this.lab.target);
        await this.startCache();
      } catch (e) {
        this.lab.error = (e as Error).message;
        this.lab.phase = "failed";
      } finally {
        this.recovering = false;
      }
    }
  }
  private async startCache() {
    this.cache?.stop();
    if (!this.lab) return;
    this.cache = new LiveCache(
      this.lab.target,
      Object.values(
        this.lab.plan.namespaceMap ?? { default: this.lab.namespace },
      ),
    );
    await this.cache.start();
  }
  view() {
    if (!this.lab) return { lab: null, plan: this.pending };
    const { target, operations, ...lab } = this.lab;
    return {
      lab: {
        ...lab,
        evidence: this.cache?.view() ?? {
          resources: [],
          events: [],
          status: [],
          receivedAt: null,
        },
        terminal: `kubectl --kubeconfig '${target.kubeconfig.replaceAll("'", "'\\''")}' --context '${target.profile}' -n '${target.namespace}'`,
      },
      plan: this.pending,
    };
  }
  propose(
    recipe: IncidentRecipe,
    version: { sessionId: string; generation: number; revision: number },
  ) {
    if (
      !this.lab ||
      this.lab.id !== version.sessionId ||
      this.lab.generation !== version.generation ||
      this.lab.revision !== version.revision ||
      this.lab.phase !== "ready" ||
      this.lab.operation
    )
      throw new LabConflict("Lab changed while creating the proposal.");
    validateRecipe(recipe, this.lab.plan);
    if (this.proposals.size >= 10)
      this.proposals.delete(this.proposals.keys().next().value!);
    const id = randomUUID();
    this.proposals.set(id, { recipe, ...version });
    return { id, recipe };
  }
  async plan(project: Snapshot) {
    await this.load();
    if (this.lab?.operation)
      throw new LabConflict("A lab operation is in progress.");
    const namespace = "waypoint-lab-" + randomBytes(6).toString("hex");
    const configuration = new LocalConfiguration(
      join(dirname(this.root), "configuration"),
    );
    this.pending = deploymentPlan(
      project,
      namespace,
      configuration.public(await configuration.load(digest(project.files))),
    );
    return this.view();
  }
  async create(planHash: string, guard: () => void) {
    await this.load();
    const handle = await this.acquire();
    try {
      await this.refreshLocked();
      if (this.lab && this.lab.phase !== "stopped")
        throw new LabConflict(
          "Clean up the existing lab before creating another.",
        );
      if (!this.pending || this.pending.planHash !== planHash)
        throw new LabConflict("Deployment preview changed. Review it again.");
      if (this.pending.blockers.length)
        throw Error(this.pending.blockers.join("; "));
      const local = await new LocalConfiguration(
        join(dirname(this.root), "configuration"),
      ).load(this.pending.sourceHash);
      if (local.revision !== this.pending.configurationRevision)
        throw new LabConflict(
          "Local test configuration changed. Review the deployment plan again.",
        );
      const prerequisites = await doctor();
      const failures = prerequisites.filter((check) => !check.ok);
      if (failures.length)
        throw Error(
          failures.map((check) => `${check.name}: ${check.detail}`).join("\n"),
        );
      guard();
      const id = randomUUID(),
        profile = "waypoint-" + id.slice(0, 12),
        home = join(this.root, "labs", id),
        target: OwnedTarget = {
          profile,
          home,
          kubeconfig: join(home, "config"),
          namespace: this.pending.namespace,
          nonce: randomBytes(32).toString("hex"),
        };
      await privateDirectory(home);
      guard();
      this.lab = {
        id,
        profile,
        namespace: target.namespace,
        phase: "preparing",
        generation: 1,
        revision: 0,
        plan: this.pending,
        source: this.pending.source,
        incident: null,
        operation: "create",
        error: null,
        checks: [],
        target,
        startedAt: new Date().toISOString(),
        operations: {},
      };
      await this.save();
      this.launch(
        async () => {
          await createCluster(target, () => this.save());
          guard();
          await assertOwned(target);
          if (this.lab!.plan.needsIngress) {
            await run(
              minikubeBinary(),
              ["--profile", target.profile, "addons", "enable", "ingress"],
              { env: environment(target), timeout: 180000 },
            );
            await assertOwned(target);
            await kube(
              target,
              [
                "-n",
                "ingress-nginx",
                "rollout",
                "status",
                "deployment/ingress-nginx-controller",
                "--timeout=120s",
              ],
              undefined,
              130000,
            );
          }
          await this.applyBaseline();
          await this.startCache();
          await this.healthy();
          this.lab!.phase = "ready";
        },
        guard,
        handle,
      );
      return this.view();
    } catch (e) {
      await this.release(handle);
      throw e;
    }
  }
  private launch(
    work: () => Promise<void>,
    guard: () => void,
    handle: OperationLock,
  ) {
    void (async () => {
      try {
        await work();
        guard();
      } catch (e) {
        if (this.lab) {
          this.lab.phase = "failed";
          this.lab.error = (e as Error).message;
        }
      } finally {
        try {
          if (this.lab) {
            this.lab.operation = null;
            await this.save();
          }
        } finally {
          await this.release(handle);
        }
      }
    })();
  }
  async operate(
    op: {
      kind: string;
      operationId: string;
      sessionId: string;
      generation: number;
      revision: number;
      source?: string;
      incident?: "readiness" | "liveness";
      target?: string;
      proposalId?: string;
    },
    guard: () => void,
  ) {
    await this.load();
    const handle = await this.acquire();
    try {
      await this.refreshLocked();
      const lab = this.lab;
      if (!lab || lab.id !== op.sessionId)
        throw new LabConflict("Wrong lab session.");
      const requestHash = createHash("sha256")
        .update(
          JSON.stringify({
            kind: op.kind,
            source: op.source,
            incident: op.incident,
            target: op.target,
            proposalId: op.proposalId,
          }),
        )
        .digest("hex");
      const previous = lab.operations[op.operationId];
      if (previous) {
        if (
          previous.kind !== op.kind ||
          previous.generation !== op.generation ||
          previous.revision !== op.revision ||
          (previous.requestHash !== undefined &&
            previous.requestHash !== requestHash)
        )
          throw new LabConflict(
            "Operation identifier reused for a different request.",
          );
        await this.release(handle);
        return this.view();
      }
      if (lab.operation) {
        if (!["reset", "recover", "cleanup"].includes(op.kind))
          throw new LabConflict(
            "Interrupted operation requires recovery/reset/cleanup.",
          );
        lab.operation = null;
      }
      if (lab.generation !== op.generation || lab.revision !== op.revision)
        throw new LabConflict("Lab revision changed. Refresh before applying.");
      if (lab.phase === "stopped") throw Error("Lab is stopped.");
      if (
        op.kind === "incident" &&
        !["readiness", "liveness"].includes(op.incident ?? "readiness")
      )
        throw Error("Select a readiness or liveness incident.");
      let recipe: IncidentRecipe | undefined;
      if (op.kind === "incident") {
        if (op.proposalId) {
          const proposal = this.proposals.get(op.proposalId);
          if (
            !proposal ||
            proposal.sessionId !== lab.id ||
            proposal.generation !== lab.generation ||
            proposal.revision !== lab.revision
          )
            throw new LabConflict(
              "Generated proposal expired or belongs to another lab revision.",
            );
          recipe = validateRecipe(proposal.recipe, lab.plan);
          if (op.incident !== recipe.incident || op.target !== recipe.target)
            throw Error("Incident differs from the reviewed proposal.");
        }
        const contract = (
          lab.plan.contracts ?? (lab.plan.contract ? [lab.plan.contract] : [])
        ).find((c) => !op.target || targetKey(c, lab.namespace) === op.target);
        if (!contract)
          throw Error(
            "Choose a workload with an HTTP readiness probe and matching Service.",
          );
      }
      if (op.kind === "incident" && lab.phase !== "ready")
        throw Error(
          "Reset to a proven healthy baseline before introducing an incident.",
        );
      if (op.kind === "apply") {
        if (!op.source) throw Error("Source required.");
        validateLabRepair(lab.plan, op.source);
      }
      guard();
      lab.operations[op.operationId] = {
        kind: op.kind,
        generation: op.generation,
        revision: op.revision,
        requestHash,
      };
      if (Object.keys(lab.operations).length > 1000)
        delete lab.operations[Object.keys(lab.operations)[0]];
      lab.operation = op.kind;
      lab.error = null;
      lab.checks = [];
      if (op.kind === "reset") lab.phase = "resetting";
      if (op.kind === "check") lab.phase = "checking";
      await this.save();
      this.launch(
        async () => {
          guard();
          if (!["recover", "cleanup"].includes(op.kind))
            await assertOwned(lab.target);
          if (op.kind === "incident") {
            lab.plan.contract = (
              lab.plan.contracts ?? [lab.plan.contract!]
            ).find(
              (c) => !op.target || targetKey(c, lab.namespace) === op.target,
            )!;
            lab.recipe = recipe;
            await this.healthy();
            const values = structuredClone(lab.plan.resources),
              dep = values.find(
                (v) =>
                  v.kind === "Deployment" &&
                  at(v, "metadata", "name") === lab.plan.contract!.deployment &&
                  at(v, "metadata", "namespace") ===
                    (lab.plan.contract!.namespace ?? lab.namespace),
              )!;
            const c = list(
              at(dep, "spec", "template", "spec", "containers"),
            ).find(
              (container) => container.name === lab.plan.contract!.container,
            );
            if (!c) throw Error("Selected practice container is unavailable.");
            {
              const field =
                op.incident === "liveness" ? "livenessProbe" : "readinessProbe";
              if (!at(c, field, "httpGet", "path"))
                throw Error(
                  "This application has no supported HTTP liveness probe.",
                );
              object(at(c, field, "httpGet")).path =
                "/waypoint-missing-" + lab.id.slice(0, 8);
            }
            lab.source = values.map((v) => stringify(v)).join("---\n");
            await kube(lab.target, ["apply", "-f", "-"], lab.source);
            lab.incident = op.incident ?? "readiness";
            lab.revision++;
            lab.phase = "running";
            await this.proveIncident();
          } else if (op.kind === "apply") {
            await kube(lab.target, ["apply", "-f", "-"], op.source);
            lab.source = op.source!;
            lab.revision++;
            lab.phase = "running";
          } else if (op.kind === "check") {
            try {
              if (!this.cache?.fresh())
                throw Error(
                  "Observations are stale or unavailable; reconnect before checking.",
                );
              await this.healthy();
              if (!this.cache?.fresh())
                throw Error(
                  "Observations disconnected during checking; outcome unavailable.",
                );
              lab.phase = "completed";
            } catch (e) {
              lab.phase = "running";
              lab.error = (e as Error).message;
            }
          } else if (op.kind === "recover") {
            this.cache?.stop();
            await completeOwnership(lab.target, () => this.save());
            await this.applyBaseline();
            lab.source = lab.plan.source;
            lab.generation++;
            lab.revision++;
            lab.incident = null;
            lab.recipe = undefined;
            this.proposals.clear();
            await this.startCache();
            await this.healthy();
            lab.phase = "ready";
          } else if (op.kind === "reset") {
            this.cache?.stop();
            await this.applyBaseline();
            lab.source = lab.plan.source;
            lab.generation++;
            lab.revision++;
            lab.incident = null;
            lab.recipe = undefined;
            this.proposals.clear();
            await this.startCache();
            await this.healthy();
            lab.phase = "ready";
          } else if (op.kind === "cleanup") {
            this.cache?.stop();
            if (!lab.target.containerId) await assertNeverCreated(lab.target);
            else await deleteCluster(lab.target);
            lab.phase = "stopped";
          } else throw Error("Unknown typed lab operation.");
        },
        guard,
        handle,
      );
      return this.view();
    } catch (e) {
      await this.release(handle);
      throw e;
    }
  }
  private async applyBaseline() {
    const lab = this.lab!;
    await assertOwned(lab.target);
    const config = await new LocalConfiguration(
      join(dirname(this.root), "configuration"),
    ).load(lab.plan.sourceHash);
    if (config.revision !== lab.plan.configurationRevision)
      throw Error(
        "Local test configuration changed; clean up and review a new deployment plan.",
      );
    for (const image of lab.plan.localImages ?? []) {
      const current = (
        await run("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          image.reference,
        ])
      ).trim();
      if (current !== image.imageId)
        throw Error(
          "A selected local Docker image changed or disappeared. Review the deployment again.",
        );
      await assertOwned(lab.target);
      await run(
        minikubeBinary(),
        [
          "image",
          "load",
          "--profile",
          lab.target.profile,
          "--daemon",
          image.reference,
        ],
        { env: environment(lab.target), timeout: 180000 },
      );
      if (
        (
          await run("docker", [
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            image.reference,
          ])
        ).trim() !== image.imageId
      )
        throw Error(
          "Local image changed during loading. Review the deployment again.",
        );
      await assertOwned(lab.target);
    }
    if (lab.plan.needsVault) {
      if (!("vault" in config) || !config.vault)
        throw Error("Local Vault test configuration missing.");
      await prepareVault(lab.target, lab.plan, config.vault);
    }
    for (const requirement of lab.plan.secretRequirements ?? []) {
      const secret = config.secrets.find(
        (s) =>
          s.name === requirement.name && s.namespace === requirement.namespace,
      );
      if (!secret || requirement.keys.some((k) => !(k in secret.values)))
        throw Error("Required local test Secret is unavailable.");
      const namespace =
        lab.plan.namespaceMap?.[requirement.namespace] ?? lab.namespace;
      // Additional namespaces are created before their test Secrets.
      if (namespace !== lab.namespace)
        await kube(
          lab.target,
          ["apply", "-f", "-"],
          JSON.stringify({
            apiVersion: "v1",
            kind: "Namespace",
            metadata: {
              name: namespace,
              labels: { "waypoint.dev/lab": lab.namespace },
            },
          }),
        );
      await kube(
        lab.target,
        ["-n", namespace, "apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Secret",
          metadata: { name: secret.name, namespace },
          type: secret.type,
          stringData: secret.values,
        }),
      );
    }
    await kube(lab.target, ["apply", "-f", "-"], lab.plan.source);
  }
  async healthy() {
    const lab = this.lab!;
    await assertOwned(lab.target);
    const checks: LiveLab["checks"] = [];
    lab.checks = checks;
    const check = (name: string, passed: boolean, detail: string) => {
      checks.push({ name, passed, detail });
      if (!passed) throw Error(detail);
    };
    for (const expected of lab.plan.resources.filter((r) =>
      ["Service", "ConfigMap"].includes(text(r.kind)),
    )) {
      const name = text(at(expected, "metadata", "name"));
      const actual = JSON.parse(
        await kube(lab.target, [
          "-n",
          text(at(expected, "metadata", "namespace")) || lab.namespace,
          "get",
          text(expected.kind),
          name,
          "-o",
          "json",
        ]),
      );
      check(
        text(expected.kind) + "/" + name + " configuration",
        containsDeclared(
          actual.spec ?? actual.data,
          expected.spec ?? expected.data,
        ),
        "Required Service selectors/ports and ConfigMap contents must match the reviewed baseline.",
      );
    }
    for (const dep of lab.plan.resources.filter(
      (v) => v.kind === "Deployment",
    )) {
      const name = text(at(dep, "metadata", "name"));
      await kube(
        lab.target,
        [
          "-n",
          text(at(dep, "metadata", "namespace")) || lab.namespace,
          "rollout",
          "status",
          "deployment/" + name,
          "--timeout=120s",
        ],
        undefined,
        130000,
      );
      const actual = object(
        JSON.parse(
          await kube(lab.target, [
            "-n",
            text(at(dep, "metadata", "namespace")) || lab.namespace,
            "get",
            "deployment",
            name,
            "-o",
            "json",
          ]),
        ),
      );
      const desired = Number(at(dep, "spec", "replicas"));
      check(
        name + " replicas",
        at(actual, "spec", "replicas") === desired &&
          (at(actual, "status", "readyReplicas") ?? 0) === desired &&
          (at(actual, "status", "updatedReplicas") ?? 0) === desired &&
          at(actual, "status", "observedGeneration") ===
            at(actual, "metadata", "generation"),
        "Intended nonzero replicas must be ready and current.",
      );
      check(
        name + " template",
        containsDeclared(
          at(actual, "spec", "template", "spec"),
          at(dep, "spec", "template", "spec"),
        ),
        "Container configuration changed outside the repair contract.",
      );
    }
    for (const expected of lab.plan.resources.filter((r) =>
      ["StatefulSet", "DaemonSet", "Job", "PersistentVolumeClaim"].includes(
        text(r.kind),
      ),
    )) {
      const name = text(at(expected, "metadata", "name")),
        namespace =
          text(at(expected, "metadata", "namespace")) || lab.namespace;
      if (expected.kind === "StatefulSet" || expected.kind === "DaemonSet")
        await kube(
          lab.target,
          [
            "-n",
            namespace,
            "rollout",
            "status",
            text(expected.kind).toLowerCase() + "/" + name,
            "--timeout=120s",
          ],
          undefined,
          130000,
        );
      else
        await kube(
          lab.target,
          [
            "-n",
            namespace,
            "wait",
            expected.kind === "Job"
              ? "--for=condition=Complete"
              : "--for=jsonpath={.status.phase}=Bound",
            text(expected.kind).toLowerCase() + "/" + name,
            "--timeout=120s",
          ],
          undefined,
          130000,
        );
      const actual = JSON.parse(
        await kube(lab.target, [
          "-n",
          namespace,
          "get",
          text(expected.kind),
          name,
          "-o",
          "json",
        ]),
      );
      check(
        text(expected.kind) + "/" + name + " baseline",
        containsDeclared(actual.spec, expected.spec),
        "Reviewed resource configuration and runtime readiness/binding/completion are required.",
      );
    }
    for (const expected of lab.plan.resources.filter((r) => r.kind === "Pod")) {
      const name = text(at(expected, "metadata", "name")),
        ns = text(at(expected, "metadata", "namespace")) || lab.namespace;
      await kube(
        lab.target,
        [
          "-n",
          ns,
          "wait",
          "--for=condition=Ready",
          "pod/" + name,
          "--timeout=120s",
        ],
        undefined,
        130000,
      );
      const actual = JSON.parse(
        await kube(lab.target, ["-n", ns, "get", "pod", name, "-o", "json"]),
      );
      check(
        "Pod/" + name + " ready",
        containsDeclared(
          normalizePodSpec(actual, expected, lab.plan.needsVault),
          expected.spec,
        ),
        "Standalone Pod must be Ready and preserve its reviewed configuration.",
      );
    }
    for (const expected of lab.plan.resources.filter(
      (r) => r.kind === "CronJob",
    )) {
      const name = text(at(expected, "metadata", "name")),
        ns = text(at(expected, "metadata", "namespace")) || lab.namespace;
      const actual = JSON.parse(
        await kube(lab.target, [
          "-n",
          ns,
          "get",
          "cronjob",
          name,
          "-o",
          "json",
        ]),
      );
      check(
        "CronJob/" + name + " configuration",
        containsDeclared(actual.spec, expected.spec),
        "CronJob schedule/template must match the reviewed baseline.",
      );
      // A schedule alone cannot establish workload health. Require a completed execution.
      const jobs = list(
        object(
          JSON.parse(
            await kube(lab.target, ["-n", ns, "get", "jobs", "-o", "json"]),
          ),
        ).items,
      ).filter((j) =>
        list(at(j, "metadata", "ownerReferences")).some(
          (o) => o.uid === at(actual, "metadata", "uid"),
        ),
      );
      check(
        "CronJob/" + name + " execution",
        jobs.some((j) =>
          list(at(j, "status", "conditions")).some(
            (c) => c.type === "Complete" && c.status === "True",
          ),
        ),
        "CronJob has no observed successful execution yet. Wait for its schedule or run an execution in the owned cluster, then retry baseline verification.",
      );
    }
    if (!lab.plan.contract) return;
    const contract = lab.plan.contract!;
    const slices = list(
      object(
        JSON.parse(
          await kube(lab.target, [
            "-n",
            contract.namespace ?? lab.namespace,
            "get",
            "endpointslices",
            "-l",
            "kubernetes.io/service-name=" + contract.service,
            "-o",
            "json",
          ]),
        ),
      ).items,
    );
    const pods = list(
      object(
        JSON.parse(
          await kube(lab.target, [
            "-n",
            contract.namespace ?? lab.namespace,
            "get",
            "pods",
            "-o",
            "json",
          ]),
        ),
      ).items,
    );
    const replicas = list(
      object(
        JSON.parse(
          await kube(lab.target, [
            "-n",
            contract.namespace ?? lab.namespace,
            "get",
            "replicasets",
            "-o",
            "json",
          ]),
        ),
      ).items,
    );
    const selectedDeployment = object(
      JSON.parse(
        await kube(lab.target, [
          "-n",
          contract.namespace ?? lab.namespace,
          "get",
          "deployment",
          contract.deployment,
          "-o",
          "json",
        ]),
      ),
    );
    const deploymentUid = text(at(selectedDeployment, "metadata", "uid"));
    const replicaUids = new Set(
      replicas
        .filter((r) =>
          list(at(r, "metadata", "ownerReferences")).some(
            (o) => o.uid === deploymentUid,
          ),
        )
        .map((r) => text(at(r, "metadata", "uid"))),
    );
    const selectedPods = pods.filter((p) =>
      list(at(p, "metadata", "ownerReferences")).some((o) =>
        replicaUids.has(text(o.uid)),
      ),
    );
    const ready = new Set(
      slices
        .flatMap((s) => list(s.endpoints))
        .filter(
          (e) =>
            at(e, "conditions", "ready") === true &&
            at(e, "conditions", "terminating") !== true,
        )
        .map((e) => text(at(e, "targetRef", "uid"))),
    );
    check(
      "ready Service backends",
      selectedPods.filter(
        (p) =>
          ready.has(text(at(p, "metadata", "uid"))) &&
          list(at(p, "status", "conditions")).some(
            (c) => c.type === "Ready" && c.status === "True",
          ),
      ).length === Number(at(selectedDeployment, "spec", "replicas")),
      "Ready EndpointSlices must target every intended ready replica.",
    );
    await this.httpCheck(
      contract.service,
      contract.port,
      contract.path,
      checks,
    );
    if (contract.gateway)
      await this.httpCheck(
        contract.gateway.service,
        contract.gateway.port,
        contract.gateway.path,
        checks,
      );
    if (lab.incident === "liveness") {
      const before = new Map(
        selectedPods.map((p) => [
          text(at(p, "metadata", "uid")),
          list(at(p, "status", "containerStatuses")).reduce(
            (n, c) => n + Number(c.restartCount ?? 0),
            0,
          ),
        ]),
      );
      await new Promise((resolve) => setTimeout(resolve, 15000));
      const after = list(
        object(
          JSON.parse(
            await kube(lab.target, [
              "-n",
              contract.namespace ?? lab.namespace,
              "get",
              "pods",
              "-o",
              "json",
            ]),
          ),
        ).items,
      );
      check(
        "stable restart window",
        after.filter((p) => before.has(text(at(p, "metadata", "uid"))))
          .length === before.size &&
          after
            .filter((p) => before.has(text(at(p, "metadata", "uid"))))
            .every(
              (p) =>
                list(at(p, "status", "containerStatuses")).reduce(
                  (n, c) => n + Number(c.restartCount ?? 0),
                  0,
                ) === before.get(text(at(p, "metadata", "uid"))),
            ),
        "No new container restarts across the 15-second recovery window.",
      );
    }
  }
  private async httpCheck(
    service: string,
    port: number,
    path: string,
    checks: LiveLab["checks"],
  ) {
    const lab = this.lab!;
    await assertOwned(lab.target);
    const helper = "waypoint-check-" + randomBytes(4).toString("hex");
    let helperUid = "";
    try {
      const created = object(
        JSON.parse(
          await kube(
            lab.target,
            [
              "-n",
              lab.plan.contract?.namespace ?? lab.namespace,
              "create",
              "-f",
              "-",
              "-o",
              "json",
            ],
            JSON.stringify({
              apiVersion: "v1",
              kind: "Pod",
              metadata: {
                name: helper,
                namespace: lab.plan.contract?.namespace ?? lab.namespace,
                labels: { "waypoint/check": "true" },
              },
              spec: {
                restartPolicy: "Never",
                automountServiceAccountToken: false,
                containers: [
                  {
                    name: "request",
                    image: "busybox:1.37",
                    command: [
                      "wget",
                      "-T",
                      "15",
                      "-O",
                      "-",
                      `http://${service}:${port}${path}`,
                    ],
                    resources: { limits: { cpu: "100m", memory: "32Mi" } },
                  },
                ],
              },
            }),
          ),
        ),
      );
      helperUid = text(at(created, "metadata", "uid"));
      await kube(
        lab.target,
        [
          "-n",
          lab.plan.contract?.namespace ?? lab.namespace,
          "wait",
          "--for=jsonpath={.status.phase}=Succeeded",
          "pod/" + helper,
          "--timeout=90s",
        ],
        undefined,
        100000,
      );
      const logs = await kube(
        lab.target,
        ["-n", lab.plan.contract?.namespace ?? lab.namespace, "logs", helper],
        undefined,
        20000,
      );
      checks.push({
        name: "in-cluster Service HTTP " + service,
        passed: true,
        detail: logs.slice(0, 2000),
      });
    } finally {
      if (helperUid) {
        await assertOwned(lab.target);
        const now = object(
          JSON.parse(
            await kube(lab.target, [
              "-n",
              lab.plan.contract?.namespace ?? lab.namespace,
              "get",
              "pod",
              helper,
              "-o",
              "json",
            ]),
          ),
        );
        if (at(now, "metadata", "uid") === helperUid)
          await kube(lab.target, [
            "-n",
            lab.plan.contract?.namespace ?? lab.namespace,
            "delete",
            "pod",
            helper,
            "--wait=false",
          ]);
      }
    }
  }
  private async proveIncident() {
    const lab = this.lab!,
      contract = lab.plan.contract!,
      deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const pods = list(
        object(
          JSON.parse(
            await kube(lab.target, [
              "-n",
              lab.plan.contract?.namespace ?? lab.namespace,
              "get",
              "pods",
              "-o",
              "json",
            ]),
          ),
        ).items,
      );
      const events = list(
        object(
          JSON.parse(
            await kube(lab.target, [
              "-n",
              lab.plan.contract?.namespace ?? lab.namespace,
              "get",
              "events",
              "-o",
              "json",
            ]),
          ),
        ).items,
      );
      const field =
        lab.incident === "liveness" ? "livenessProbe" : "readinessProbe";
      const relevant = pods.filter((p) =>
        list(at(p, "spec", "containers")).some(
          (c) =>
            c.name === contract.container &&
            text(at(c, field, "httpGet", "path")).startsWith(
              "/waypoint-missing-",
            ),
        ),
      );
      const confirmed = relevant.some(
        (p) =>
          events.some(
            (e) =>
              at(e, "involvedObject", "uid") === at(p, "metadata", "uid") &&
              e.reason === "Unhealthy" &&
              text(e.message)
                .toLowerCase()
                .includes(
                  lab.incident === "liveness"
                    ? "liveness probe"
                    : "readiness probe",
                ),
          ) &&
          (lab.incident === "liveness"
            ? list(at(p, "status", "containerStatuses")).some(
                (c) =>
                  c.name === contract.container && Number(c.restartCount) > 0,
              )
            : list(at(p, "status", "conditions")).some(
                (c) => c.type === "Ready" && c.status === "False",
              )),
      );
      if (confirmed) {
        lab.checks = [
          {
            name: "Actual incident evidence",
            passed: true,
            detail:
              "Current fault-bearing Pod UID has kubelet probe-failure events and matching readiness/restart symptoms.",
          },
        ];
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw Error(
      "Injected probe change did not produce corroborated symptoms within 90 seconds. Reset the baseline; this application may not support this incident.",
    );
  }
  async logs(uid: string, container: string, close = false) {
    await this.load();
    if (!this.cache) throw Error("Lab observations unavailable.");
    if (close) {
      this.cache.closeLog(uid, container);
      return null;
    }
    return this.cache.follow(uid, container);
  }
  close() {
    this.cache?.stop();
  }
}
const global = globalThis as typeof globalThis & {
  waypointMinikubeRuntimes?: Map<string, MinikubeRuntime>;
  waypointMinikubeProfileCleanup?: boolean;
};
export function minikubeRuntime(root: string) {
  const map = (global.waypointMinikubeRuntimes ??= new Map());
  if (!global.waypointMinikubeProfileCleanup) {
    global.waypointMinikubeProfileCleanup = true;
    onProfileChange(() => {
      for (const runtime of map.values()) runtime.close();
      map.clear();
    });
  }
  let r = map.get(root);
  if (!r) {
    r = new MinikubeRuntime(root);
    map.set(root, r);
  }
  return r;
}

function containsDeclared(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(expected))
    return (
      Array.isArray(actual) &&
      expected.length === actual.length &&
      expected.every((v, i) => containsDeclared(actual[i], v))
    );
  if (expected && typeof expected === "object")
    return (
      !!actual &&
      typeof actual === "object" &&
      Object.entries(expected).every(([k, v]) =>
        containsDeclared(object(actual)[k], v),
      )
    );
  return actual === expected;
}

function normalizePodSpec(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  vault: boolean,
) {
  const spec = structuredClone(object(actual.spec));
  const expectedSpec = object(expected.spec);
  const injected =
    vault &&
    at(
      actual,
      "metadata",
      "annotations",
      "vault.hashicorp.com/agent-inject-status",
    ) === "injected";
  const permittedVolume = (name: unknown) =>
    typeof name === "string" &&
    (name.startsWith("kube-api-access-") ||
      (injected &&
        (name === "vault-secrets" ||
          name === "home-init" ||
          name === "home-sidecar")));
  for (const field of ["containers", "initContainers"]) {
    const declared = new Set(list(expectedSpec[field]).map((c) => c.name));
    spec[field] = list(spec[field]).filter(
      (c) =>
        declared.has(c.name) ||
        !(
          injected &&
          ["vault-agent", "vault-agent-init"].includes(text(c.name)) &&
          /^hashicorp\/vault:[a-zA-Z0-9._-]+$/.test(text(c.image))
        ),
    );
    for (const c of list(spec[field])) {
      const base = list(expectedSpec[field]).find((b) => b.name === c.name);
      if (base)
        c.volumeMounts = list(c.volumeMounts).filter(
          (m) =>
            list(base.volumeMounts).some((b) => b.name === m.name) ||
            !permittedVolume(m.name),
        );
    }
    if (!expectedSpec[field] && !list(spec[field]).length) delete spec[field];
  }
  spec.volumes = list(spec.volumes).filter(
    (v) =>
      list(expectedSpec.volumes).some((b) => b.name === v.name) ||
      !permittedVolume(v.name),
  );
  if (!expectedSpec.volumes && !list(spec.volumes).length) delete spec.volumes;
  return spec;
}
