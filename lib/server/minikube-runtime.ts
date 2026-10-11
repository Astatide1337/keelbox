import {
  assertNoReservedResources,
  assertSafeApplicationSource,
  checkedHttpContracts,
  resetPreview,
  reviewedCronJobRun,
  cronJobExecution,
  corroboratedProbeFailure,
} from "./runtime-invariants";
import { prepareVault } from "./local-vault";
import {
  validateRecipe,
  type IncidentRecipe,
  targetKey,
} from "../domain/generated-incident";
import {
  applicableIncidents,
  incidentOperation,
  isSyntheticMarketData,
  type LiveIncidentId,
} from "../domain/live-incidents";
import { LocalConfiguration } from "./local-configuration";
import { dockerBuildContexts, resolveLocalImage } from "./local-images";
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
import {
  ownedLabControl,
  ownedLabJson,
  selectSingleReadyDeploymentPod,
  withOwnedPodControlForward,
  withOwnedServicePortForward,
} from "./loopback-port-forward";
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
  incident: LiveIncidentId | null;
  recipe?: IncidentRecipe;
  incidentInjectedAt?: string;
  incidentObservedAt?: string;
  incidentEvidence?: Record<string, string | number | boolean | null>;
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
      resetPreview: this.lab.plan ? resetPreview(this.lab.plan) : null,
      scheduledExecutions: (this.lab.plan?.resources ?? [])
        .filter((r) => r.kind === "CronJob")
        .map((r) => ({
          ...cronJobExecution(
            this.cache?.view().resources.filter((r) => r.kind === "Job") ?? [],
            text(
              at(
                this.cache
                  ?.view()
                  .resources.find(
                    (o) =>
                      o.kind === "CronJob" &&
                      at(o, "metadata", "name") === at(r, "metadata", "name") &&
                      at(o, "metadata", "namespace") ===
                        at(r, "metadata", "namespace"),
                  ),
                "metadata",
                "uid",
              ),
            ),
          ),
          target: `${text(at(r, "metadata", "namespace")) || this.lab!.namespace}/${text(at(r, "metadata", "name"))}`,
          name: text(at(r, "metadata", "name")),
          namespace:
            text(at(r, "metadata", "namespace")) || this.lab!.namespace,
          effect:
            "Create one Job from the reviewed CronJob template in the owned lab. It may modify application data; its schedule remains unchanged.",
        })),
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
      assertNoReservedResources(this.pending.resources);
      assertSafeApplicationSource(this.pending.source);
      checkedHttpContracts(this.pending);
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
      incident?: LiveIncidentId;
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
      let recipe: IncidentRecipe | undefined;
      if (op.kind === "incident") {
        if (!op.incident || !op.target)
          throw Error("Select a validated incident and exact workload target.");
        if (
          !applicableIncidents(lab.plan, op.target).some(
            (choice) => choice.id === op.incident,
          )
        )
          throw Error(
            "This incident is not applicable to the selected workload.",
          );
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
        assertSafeApplicationSource(op.source);
        validateLabRepair(lab.plan, op.source);
      }
      if (
        op.kind === "repair" &&
        (lab.phase !== "running" || !lab.incident || !lab.incidentObservedAt)
      )
        throw Error(
          "A corroborated incident is required before applying its reviewed repair.",
        );
      if (
        op.kind === "run-cronjob" &&
        !lab.plan.resources.some(
          (r) =>
            r.kind === "CronJob" &&
            `${text(at(r, "metadata", "namespace")) || lab.namespace}/${text(at(r, "metadata", "name"))}` ===
              op.target,
        )
      )
        throw Error("Choose an imported CronJob in this owned lab.");
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
            // Lifecycle 'ready' records the previous baseline, not perpetual health.
            // Re-check current state under the operation lock before injecting a fault.
            await this.healthy();
            lab.plan.contract = (
              lab.plan.contracts ?? [lab.plan.contract!]
            ).find(
              (c) => !op.target || targetKey(c, lab.namespace) === op.target,
            )!;
            lab.recipe = recipe;
            await this.healthy();
            const values = incidentOperation(
              lab.plan,
              op.incident!,
              op.target!,
              lab.id,
            );
            lab.incident = op.incident!;
            lab.incidentInjectedAt = new Date().toISOString();
            lab.incidentObservedAt = undefined;
            lab.incidentEvidence = undefined;
            if (op.incident === "market-data-stale") {
              if (!isSyntheticMarketData(lab.plan))
                throw Error("Market-data fault requires the reviewed fixture.");
              lab.source = lab.plan.source;
              await this.pauseMarketData();
            } else {
              lab.source = values.map((v) => stringify(v)).join("---\n");
              assertSafeApplicationSource(lab.source);
              await kube(lab.target, ["apply", "-f", "-"], lab.source);
            }
            lab.revision++;
            lab.phase = "running";
            await this.proveIncident();
            lab.incidentObservedAt = new Date().toISOString();
          } else if (op.kind === "repair") {
            if (lab.incident === "market-data-stale")
              await this.resumeMarketData();
            await this.applyBaseline();
            lab.source = lab.plan.source;
            lab.revision++;
            lab.phase = "running";
          } else if (op.kind === "apply") {
            await kube(lab.target, ["apply", "-f", "-"], op.source);
            lab.source = op.source!;
            lab.revision++;
            lab.phase = "running";
          } else if (op.kind === "check") {
            try {
              if (lab.incident && !lab.incidentObservedAt)
                throw Error(
                  "The incident has not been corroborated in this session. Recover or reset before claiming an exercise recovery.",
                );
              if (!this.cache?.fresh())
                throw Error(
                  "Observations are stale or unavailable; reconnect before checking.",
                );
              await this.healthy();
              if (lab.incident === "market-data-stale")
                await this.proveMarketDataRecovery();
              if (!this.cache?.fresh())
                throw Error(
                  "Observations disconnected during checking; outcome unavailable.",
                );
              lab.phase = lab.incident ? "completed" : "ready";
            } catch (e) {
              lab.phase = "running";
              lab.error = (e as Error).message;
              if (!lab.checks.some((check) => !check.passed))
                lab.checks.push({
                  name: "Recovery verification",
                  passed: false,
                  detail: lab.error,
                });
            }
          } else if (op.kind === "recover") {
            this.cache?.stop();
            if (lab.incident === "market-data-stale")
              await this.resumeMarketData();
            await completeOwnership(lab.target, () => this.save());
            await this.applyBaseline();
            lab.source = lab.plan.source;
            lab.generation++;
            lab.revision++;
            lab.incident = null;
            lab.recipe = undefined;
            lab.incidentInjectedAt = undefined;
            lab.incidentObservedAt = undefined;
            lab.incidentEvidence = undefined;
            this.proposals.clear();
            await this.startCache();
            await this.healthy();
            lab.phase = "ready";
          } else if (op.kind === "reset") {
            this.cache?.stop();
            if (lab.incident === "market-data-stale")
              await this.resumeMarketData();
            await this.applyBaseline();
            lab.source = lab.plan.source;
            lab.generation++;
            lab.revision++;
            lab.incident = null;
            lab.recipe = undefined;
            lab.incidentInjectedAt = undefined;
            lab.incidentObservedAt = undefined;
            lab.incidentEvidence = undefined;
            this.proposals.clear();
            await this.startCache();
            await this.healthy();
            lab.phase = "ready";
          } else if (op.kind === "run-cronjob") {
            const [namespace, name] = op.target!.split("/");
            const actual = object(
              JSON.parse(
                await kube(lab.target, [
                  "-n",
                  namespace,
                  "get",
                  "cronjob",
                  name,
                  "-o",
                  "json",
                ]),
              ),
            );
            const expected = lab.plan.resources.find(
              (r) =>
                r.kind === "CronJob" &&
                at(r, "metadata", "namespace") === namespace &&
                at(r, "metadata", "name") === name,
            )!;
            if (!containsDeclared(actual.spec, expected.spec))
              throw Error(
                "CronJob configuration differs from the reviewed template; reset before a one-run action.",
              );
            const job = reviewedCronJobRun(
              expected,
              actual,
              "waypoint-run-" + randomBytes(6).toString("hex"),
            );
            assertNoReservedResources([job]);
            await assertOwned(lab.target);
            await kube(
              lab.target,
              ["-n", namespace, "create", "-f", "-"],
              JSON.stringify(job),
            );
            lab.revision++;
            lab.checks = [
              {
                name: `CronJob/${name} one-run requested`,
                passed: true,
                detail:
                  "An actual Job was created from the reviewed template. Execution completion is not yet verified; inspect its Pods, events and logs.",
              },
            ];
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
    assertNoReservedResources(lab.plan.resources);
    assertSafeApplicationSource(lab.plan.source);
    checkedHttpContracts(lab.plan);
    await assertOwned(lab.target);
    const config = await new LocalConfiguration(
      join(dirname(this.root), "configuration"),
    ).load(lab.plan.sourceHash);
    if (config.revision !== lab.plan.configurationRevision)
      throw Error(
        "Local test configuration changed; clean up and review a new deployment plan.",
      );
    // Preserve reviewed source Namespace labels on every rewritten namespace,
    // including the primary namespace initially created for the ownership receipt.
    for (const namespace of Object.values(
      lab.plan.namespaceMap ?? { default: lab.namespace },
    )) {
      await assertOwned(lab.target);
      await kube(
        lab.target,
        ["apply", "-f", "-"],
        JSON.stringify({
          apiVersion: "v1",
          kind: "Namespace",
          metadata: {
            name: namespace,
            labels: lab.plan.namespaceLabels?.[namespace] ?? {
              "waypoint.dev/lab": lab.namespace,
            },
          },
        }),
      );
    }
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
    const buildContexts = dockerBuildContexts();
    const images = new Set<string>();
    const collectImages = (value: unknown) => {
      if (Array.isArray(value)) return value.forEach(collectImages);
      if (!value || typeof value !== "object") return;
      for (const [key, child] of Object.entries(value)) {
        if (key === "containers" || key === "initContainers")
          for (const container of list(child)) {
            const image = text(container.image);
            if (image) images.add(image);
          }
        else collectImages(child);
      }
    };
    collectImages(lab.plan.resources);
    for (const reference of images) {
      if (lab.plan.localImages.some((image) => image.reference === reference))
        continue;
      await assertOwned(lab.target);
      const resolved = await resolveLocalImage(reference, buildContexts);
      if (resolved.buildError)
        console.warn(
          `Local Docker build failed for ${reference}; trying registry fallback: ${resolved.buildError}`,
        );
      if (!resolved.imageId) continue;
      await assertOwned(lab.target);
      await run(
        minikubeBinary(),
        [
          "image",
          "load",
          "--profile",
          lab.target.profile,
          "--daemon",
          reference,
        ],
        {
          env: environment(lab.target),
          timeout: 180000,
        },
      );
      const current = (
        await run("docker", [
          "image",
          "inspect",
          "--format",
          "{{.Id}}",
          reference,
        ])
      ).trim();
      if (current !== resolved.imageId)
        throw Error("Local Docker image changed while loading the owned lab.");
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
      const execution = cronJobExecution(
        jobs,
        text(at(actual, "metadata", "uid")),
      );
      checks.push({
        name: `CronJob/${name} ${execution.state === "awaiting" ? "awaiting execution" : "execution"}`,
        passed: execution.state !== "failed",
        detail: execution.detail,
      });
      if (execution.state === "failed") throw Error(execution.detail);
    }
    const contracts = checkedHttpContracts(lab.plan);
    checks.push({
      name: "HTTP verification scope",
      passed: true,
      detail: contracts.length
        ? `Checking all ${contracts.length} supported Deployment/container/Service HTTP contracts. Other ports, protocols and external dependencies are not verified as HTTP.`
        : "No supported HTTP contract was found. Resource configuration/readiness checks do not establish successful application traffic.",
    });
    for (const contract of contracts) {
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
      const deploymentUid = text(at(selectedDeployment, "metadata", "uid")),
        replicaUids = new Set(
          replicas
            .filter((r) =>
              list(at(r, "metadata", "ownerReferences")).some(
                (o) => o.uid === deploymentUid,
              ),
            )
            .map((r) => text(at(r, "metadata", "uid"))),
        ),
        expectedReplicas = Number(at(selectedDeployment, "spec", "replicas"));
      let selectedPods: ReturnType<typeof list> = [],
        readyBackendCount = 0;
      const endpointDeadline = Date.now() + 15000;
      do {
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
          ),
          pods = list(
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
        selectedPods = pods.filter((p) =>
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
        readyBackendCount = selectedPods.filter(
          (p) =>
            ready.has(text(at(p, "metadata", "uid"))) &&
            list(at(p, "status", "conditions")).some(
              (c) => c.type === "Ready" && c.status === "True",
            ),
        ).length;
        if (readyBackendCount === expectedReplicas) break;
        if (Date.now() < endpointDeadline)
          await new Promise((resolve) => setTimeout(resolve, 250));
      } while (Date.now() < endpointDeadline);
      check(
        `${contract.namespace ?? lab.namespace}/${contract.service} ready Service backends`,
        readyBackendCount === expectedReplicas,
        "Ready EndpointSlices must target every intended ready replica.",
      );
      await this.httpCheck(
        contract.service,
        contract.port,
        contract.path,
        checks,
        contract.namespace ?? lab.namespace,
      );
      if (contract.gateway)
        await this.httpCheck(
          contract.gateway.service,
          contract.gateway.port,
          contract.gateway.path,
          checks,
          contract.namespace ?? lab.namespace,
        );
      if (
        lab.incident === "liveness" &&
        targetKey(contract, lab.namespace) ===
          targetKey(lab.plan.contract!, lab.namespace)
      ) {
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
  }
  private async httpCheck(
    service: string,
    port: number,
    path: string,
    checks: LiveLab["checks"],
    namespace: string,
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
            ["-n", namespace, "create", "-f", "-", "-o", "json"],
            JSON.stringify({
              apiVersion: "v1",
              kind: "Pod",
              metadata: {
                name: helper,
                namespace: namespace,
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
          namespace,
          "wait",
          "--for=jsonpath={.status.phase}=Succeeded",
          "pod/" + helper,
          "--timeout=90s",
        ],
        undefined,
        100000,
      );
      checks.push({
        name: `in-cluster Service HTTP ${namespace}/${service}:${port}${path}`,
        passed: true,
        detail: `HTTP request through Service ${namespace}/${service}:${port}${path} exited successfully in a separate in-cluster Pod. Response body is excluded from grading evidence.`,
      });
    } finally {
      if (helperUid) {
        await assertOwned(lab.target);
        const now = object(
          JSON.parse(
            await kube(lab.target, [
              "-n",
              namespace,
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
            namespace,
            "delete",
            "pod",
            helper,
            "--wait=false",
          ]);
      }
    }
  }
  private async marketDataNamespace() {
    const lab = this.lab!;
    if (!isSyntheticMarketData(lab.plan))
      throw Error("The reviewed synthetic market-data fixture is unavailable.");
    const producer = lab.plan.resources.find(
      (r) =>
        r.kind === "Deployment" &&
        at(r, "metadata", "name") === "market-producer",
    );
    const namespace = text(at(producer, "metadata", "namespace"));
    if (!producer || !namespace)
      throw Error("The owned market-data producer target is unavailable.");
    return namespace;
  }
  private async marketDataProducerPod() {
    const lab = this.lab!,
      namespace = await this.marketDataNamespace();
    await assertOwned(lab.target);
    return selectSingleReadyDeploymentPod(
      await this.deploymentPods(namespace, "market-producer"),
    );
  }
  private async marketFeedControl(action: "pause" | "resume") {
    const lab = this.lab!,
      namespace = await this.marketDataNamespace(),
      pod = await this.marketDataProducerPod();
    return withOwnedPodControlForward(
      lab.target,
      namespace,
      pod,
      async (origin) => {
        const currentPod = await this.marketDataProducerPod();
        if (currentPod.name !== pod.name || currentPod.uid !== pod.uid)
          throw Error("The owned producer Pod changed before feed control.");
        const result = await ownedLabControl(origin, action);
        if (
          result.status !== 200 ||
          result.body.action !== action ||
          !result.body.quote ||
          typeof result.body.quote !== "object"
        )
          throw Error(`Synthetic feed ${action} control was not confirmed.`);
        const quote = object(result.body.quote);
        if (
          typeof quote.feed_id !== "string" ||
          typeof quote.sequence !== "number" ||
          !Number.isInteger(quote.sequence) ||
          quote.sequence < 1
        )
          throw Error(
            "Synthetic feed control returned invalid sequence evidence.",
          );
        return quote;
      },
    );
  }
  private async pauseMarketData() {
    const lab = this.lab!,
      quote = await this.marketFeedControl("pause");
    const contract = (lab.plan.contracts ?? []).find(
      (c) => c.deployment === "market-consumer",
    );
    if (!contract) throw Error("The market-data consumer contract is missing.");
    const pods = await this.deploymentPods(
      contract.namespace ?? lab.namespace,
      contract.deployment,
    );
    lab.incidentEvidence = {
      feedId: text(quote.feed_id),
      producerSequence: Number(quote.sequence),
      consumerRestartsBefore: this.restartCount(pods),
      producerPaused: true,
    };
  }
  private async resumeMarketData() {
    const lab = this.lab!;
    await this.marketDataNamespace();
    const quote = await this.marketFeedControl("resume");
    if (lab.incidentEvidence) {
      lab.incidentEvidence = {
        ...lab.incidentEvidence,
        producerPaused: false,
        producerSequenceAtResume: Number(quote.sequence),
      };
    }
  }
  private async deploymentPods(namespace: string, name: string) {
    const lab = this.lab!;
    const deployment = object(
      JSON.parse(
        await kube(lab.target, [
          "-n",
          namespace,
          "get",
          "deployment",
          name,
          "-o",
          "json",
        ]),
      ),
    );
    const replicas = list(
      object(
        JSON.parse(
          await kube(lab.target, [
            "-n",
            namespace,
            "get",
            "replicasets",
            "-o",
            "json",
          ]),
        ),
      ).items,
    );
    const replicaUids = new Set(
      replicas
        .filter((r) =>
          list(at(r, "metadata", "ownerReferences")).some(
            (owner) => owner.uid === at(deployment, "metadata", "uid"),
          ),
        )
        .map((r) => text(at(r, "metadata", "uid"))),
    );
    const pods = list(
      object(
        JSON.parse(
          await kube(lab.target, [
            "-n",
            namespace,
            "get",
            "pods",
            "-o",
            "json",
          ]),
        ),
      ).items,
    ).filter((p) =>
      list(at(p, "metadata", "ownerReferences")).some((owner) =>
        replicaUids.has(text(owner.uid)),
      ),
    );
    return pods;
  }
  private restartCount(pods: ObjectMap[]) {
    return pods.reduce(
      (sum, pod) =>
        sum +
        list(at(pod, "status", "containerStatuses")).reduce(
          (count, status) => count + Number(status.restartCount ?? 0),
          0,
        ),
      0,
    );
  }
  private async serviceReadyEndpoints(namespace: string, service: string) {
    const lab = this.lab!;
    const slices = list(
      object(
        JSON.parse(
          await kube(lab.target, [
            "-n",
            namespace,
            "get",
            "endpointslices",
            "-l",
            `kubernetes.io/service-name=${service}`,
            "-o",
            "json",
          ]),
        ),
      ).items,
    );
    return slices
      .flatMap((slice) => list(slice.endpoints))
      .filter(
        (endpoint) =>
          at(endpoint, "conditions", "ready") === true &&
          at(endpoint, "conditions", "terminating") !== true,
      );
  }
  private isPodReady(pods: ObjectMap[]) {
    return pods.some((pod) =>
      list(at(pod, "status", "conditions")).some(
        (condition) =>
          condition.type === "Ready" && condition.status === "True",
      ),
    );
  }
  private async proveServiceIncident() {
    const lab = this.lab!,
      contract = lab.plan.contract!;
    const ns = contract.namespace ?? lab.namespace,
      deadline = Date.now() + 90000;
    const service = lab.plan.resources.find(
      (r) =>
        r.kind === "Service" &&
        at(r, "metadata", "name") === contract.service &&
        at(r, "metadata", "namespace") === ns,
    );
    if (!service) throw Error("The selected reviewed Service is unavailable.");
    while (Date.now() < deadline) {
      const pods = await this.deploymentPods(ns, contract.deployment),
        endpoints = await this.serviceReadyEndpoints(ns, contract.service),
        ready = this.isPodReady(pods);
      const currentService = object(
        JSON.parse(
          await kube(lab.target, [
            "-n",
            ns,
            "get",
            "service",
            contract.service,
            "-o",
            "json",
          ]),
        ),
      );
      if (
        lab.incident === "service-selector" &&
        ready &&
        endpoints.length === 0 &&
        at(currentService, "spec", "selector", "waypoint.dev/no-match") ===
          lab.id
      ) {
        lab.incidentEvidence = {
          workloadPodReady: true,
          serviceReadyEndpoints: 0,
          selectorMatchesBaseline: false,
          consumerEffect: "Service has no ready backends",
        };
        lab.checks = [
          {
            name: "Service selector evidence",
            passed: true,
            detail:
              "The selected Deployment Pod remains Ready while its Service selector has no matching EndpointSlice backend.",
          },
        ];
        return;
      }
      if (
        lab.incident === "service-target-port" &&
        ready &&
        endpoints.length > 0
      ) {
        const actualService = currentService;
        const declaredPorts = list(
          at(
            lab.plan.resources.find(
              (r) =>
                r.kind === "Deployment" &&
                at(r, "metadata", "name") === contract.deployment,
            ),
            "spec",
            "template",
            "spec",
            "containers",
          ),
        ).flatMap((container) => list(container.ports));
        const mapped = list(at(actualService, "spec", "ports")).find(
          (port) => Number(port.port) === contract.port,
        );
        if (
          Number(at(mapped, "targetPort")) === 1 &&
          !declaredPorts.some(
            (port) => Number(port.containerPort) === 1 || port.name === "1",
          )
        ) {
          lab.incidentEvidence = {
            workloadPodReady: true,
            serviceReadyEndpoints: endpoints.length,
            serviceTargetPort: 1,
            declaredTargetPortExists: false,
          };
          lab.checks = [
            {
              name: "Service targetPort evidence",
              passed: true,
              detail:
                "The Service still selects a Ready Pod, but its targetPort 1 does not match a declared container port.",
            },
          ];
          return;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw Error(
      "The selected Service fault did not produce its expected Pod and EndpointSlice evidence within 90 seconds.",
    );
  }
  private async proveStartupIncident() {
    const lab = this.lab!,
      contract = lab.plan.contract!;
    const ns = contract.namespace ?? lab.namespace,
      deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const pods = await this.deploymentPods(ns, contract.deployment),
        statuses = pods.flatMap((pod) =>
          list(at(pod, "status", "containerStatuses")),
        ),
        reasons = statuses
          .map((status) => text(at(status, "state", "waiting", "reason")))
          .filter(Boolean),
        expected =
          lab.incident === "image-pull"
            ? ["ErrImageNeverPull", "ErrImagePull", "ImagePullBackOff"]
            : ["CreateContainerConfigError"];
      const reason = reasons.find((value) => expected.includes(value));
      if (reason) {
        lab.incidentEvidence = {
          workloadPodReady: this.isPodReady(pods),
          containerWaitingReason: reason,
          imagePullPolicy: lab.incident === "image-pull" ? "Never" : null,
        };
        lab.checks = [
          {
            name:
              lab.incident === "image-pull"
                ? "Structured image state"
                : "Structured configuration state",
            passed: true,
            detail:
              lab.incident === "image-pull"
                ? `The selected Pod reports ${reason} for the deliberately unavailable same-repository image variant.`
                : "The selected Pod reports CreateContainerConfigError for the deliberately missing required ConfigMap key.",
          },
        ];
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 1500));
    }
    throw Error(
      "The selected startup fault did not reach its structured Pod waiting state within 90 seconds.",
    );
  }
  private async proveMarketDataIncident() {
    const lab = this.lab!,
      ns = await this.marketDataNamespace(),
      baseline = lab.incidentEvidence ?? {},
      oldSequence = Number(baseline.producerSequence),
      oldFeedId = text(baseline.feedId),
      deadline = Date.now() + 90000;
    if (!Number.isFinite(oldSequence) || !oldFeedId)
      throw Error("The paused synthetic quote sequence was not recorded.");
    const consumerContract = (lab.plan.contracts ?? []).find(
      (c) => c.deployment === "market-consumer",
    )!;
    const beforeRestarts = Number(baseline.consumerRestartsBefore ?? 0);
    const proved = await withOwnedServicePortForward(
      lab.target,
      ns,
      "market-producer",
      8080,
      async (producerUrl) =>
        withOwnedServicePortForward(
          lab.target,
          ns,
          "market-consumer",
          8081,
          async (consumerUrl) => {
            while (Date.now() < deadline) {
              const [
                producerLive,
                producerReady,
                quote,
                consumerLive,
                consumerReady,
                metrics,
              ] = await Promise.all([
                ownedLabJson(producerUrl, "/livez"),
                ownedLabJson(producerUrl, "/readyz"),
                ownedLabJson(producerUrl, "/quote"),
                ownedLabJson(consumerUrl, "/livez"),
                ownedLabJson(consumerUrl, "/readyz"),
                ownedLabJson(consumerUrl, "/metrics"),
              ]);
              const consumerPods = await this.deploymentPods(
                  consumerContract.namespace ?? lab.namespace,
                  consumerContract.deployment,
                ),
                consumerEndpoints = await this.serviceReadyEndpoints(
                  consumerContract.namespace ?? lab.namespace,
                  consumerContract.service,
                ),
                currentQuote = object(quote.body),
                currentMetrics = metrics.body,
                sequenceStillFrozen =
                  currentQuote.feed_id === oldFeedId &&
                  currentQuote.sequence === oldSequence,
                consumerSawFrozenQuote =
                  currentMetrics.feed_id === oldFeedId &&
                  currentMetrics.sequence === oldSequence,
                stale =
                  metrics.status === 200 &&
                  currentMetrics.state === "stale" &&
                  currentMetrics.fresh === false;
              if (
                producerLive.status === 200 &&
                producerReady.status === 200 &&
                sequenceStillFrozen &&
                consumerLive.status === 200 &&
                consumerReady.status === 503 &&
                consumerSawFrozenQuote &&
                stale &&
                !this.isPodReady(consumerPods) &&
                consumerEndpoints.length === 0 &&
                this.restartCount(consumerPods) === beforeRestarts
              ) {
                lab.incidentEvidence = {
                  feedId: oldFeedId,
                  producerSequence: oldSequence,
                  consumerSequence: Number(currentMetrics.sequence),
                  producerLive: true,
                  producerReady: true,
                  consumerLive: true,
                  consumerReady: false,
                  consumerPodReady: false,
                  consumerReadyEndpoints: 0,
                  consumerRestartsBefore: beforeRestarts,
                  consumerRestartsAfter: this.restartCount(consumerPods),
                  producerPaused: true,
                };
                lab.checks = [
                  {
                    name: "Producer process liveness",
                    passed: true,
                    detail:
                      "Producer /livez returns HTTP 200 while its in-memory sequence is paused.",
                  },
                  {
                    name: "Producer API readiness",
                    passed: true,
                    detail:
                      "Producer /readyz returns HTTP 200 because it can still serve the last quote.",
                  },
                  {
                    name: "Consumer feed freshness",
                    passed: true,
                    detail: `Consumer observed feed ${oldFeedId} sequence ${oldSequence}, then marked it stale.`,
                  },
                  {
                    name: "Kubernetes traffic readiness",
                    passed: true,
                    detail:
                      "Consumer /livez remains HTTP 200; /readyz is HTTP 503, Pod Ready is False, its ready EndpointSlice backend is removed, and restarts are unchanged.",
                  },
                ];
                return true;
              }
              await new Promise((resolve) => setTimeout(resolve, 1000));
            }
            return false;
          },
        ),
    );
    if (!proved)
      throw Error(
        "The stale-feed invariant, process liveness, Pod readiness, and EndpointSlice change did not all appear within 90 seconds.",
      );
  }
  private async proveMarketDataRecovery() {
    const lab = this.lab!,
      ns = await this.marketDataNamespace(),
      oldSequence = Number(lab.incidentEvidence?.producerSequence),
      oldFeedId = text(lab.incidentEvidence?.feedId),
      deadline = Date.now() + 30000;
    const consumerContract = (lab.plan.contracts ?? []).find(
      (c) => c.deployment === "market-consumer",
    )!;
    const proved = await withOwnedServicePortForward(
      lab.target,
      ns,
      "market-producer",
      8080,
      async (producerUrl) =>
        withOwnedServicePortForward(
          lab.target,
          ns,
          "market-consumer",
          8081,
          async (consumerUrl) => {
            while (Date.now() < deadline) {
              const [
                producerLive,
                producerReady,
                quote,
                consumerLive,
                consumerReady,
                metrics,
              ] = await Promise.all([
                ownedLabJson(producerUrl, "/livez"),
                ownedLabJson(producerUrl, "/readyz"),
                ownedLabJson(producerUrl, "/quote"),
                ownedLabJson(consumerUrl, "/livez"),
                ownedLabJson(consumerUrl, "/readyz"),
                ownedLabJson(consumerUrl, "/metrics"),
              ]);
              const currentQuote = object(quote.body),
                currentMetrics = metrics.body;
              if (
                producerLive.status === 200 &&
                producerReady.status === 200 &&
                quote.status === 200 &&
                consumerLive.status === 200 &&
                consumerReady.status === 200 &&
                metrics.status === 200 &&
                currentMetrics.fresh === true &&
                currentQuote.feed_id === oldFeedId &&
                currentMetrics.feed_id === oldFeedId &&
                typeof currentQuote.sequence === "number" &&
                currentQuote.sequence > oldSequence &&
                currentMetrics.sequence === currentQuote.sequence
              ) {
                const consumerPods = await this.deploymentPods(
                    consumerContract.namespace ?? lab.namespace,
                    consumerContract.deployment,
                  ),
                  consumerEndpoints = await this.serviceReadyEndpoints(
                    consumerContract.namespace ?? lab.namespace,
                    consumerContract.service,
                  );
                const consumerRestartsAfterRecovery =
                  this.restartCount(consumerPods);
                if (
                  !this.isPodReady(consumerPods) ||
                  consumerEndpoints.length === 0 ||
                  consumerRestartsAfterRecovery !==
                    Number(lab.incidentEvidence?.consumerRestartsBefore)
                )
                  throw Error(
                    "Fresh sequence returned before process health, Kubernetes readiness, EndpointSlice recovery, and restart stability.",
                  );
                lab.checks.push(
                  {
                    name: "Producer remains live",
                    passed: true,
                    detail:
                      "Producer /livez and /readyz both return HTTP 200 after feed recovery.",
                  },
                  {
                    name: "Consumer process and API readiness recovered",
                    passed: true,
                    detail:
                      "Consumer /livez and /readyz both return HTTP 200 after observing fresh feed data.",
                  },
                  {
                    name: "Fresh sequence advanced",
                    passed: true,
                    detail: `Feed ${oldFeedId} advanced from ${oldSequence} to ${currentQuote.sequence}; consumer observed the same sequence.`,
                  },
                  {
                    name: "Consumer and EndpointSlice recovered",
                    passed: true,
                    detail:
                      "Consumer reports fresh data, Pod Ready is True, and the ready Service EndpointSlice backend is restored.",
                  },
                );
                lab.incidentEvidence = {
                  ...lab.incidentEvidence,
                  producerPaused: false,
                  producerSequenceAfterRecovery: Number(currentQuote.sequence),
                  consumerSequenceAfterRecovery: Number(
                    currentMetrics.sequence,
                  ),
                  producerLiveAfterRecovery: true,
                  producerReadyAfterRecovery: true,
                  consumerLiveAfterRecovery: true,
                  consumerReadyAfterRecovery: true,
                  consumerFreshAfterRecovery: true,
                  consumerPodReadyAfterRecovery: true,
                  consumerReadyEndpointsAfterRecovery: consumerEndpoints.length,
                  consumerRestartsAfterRecovery,
                };
                return true;
              }
              await new Promise((resolve) => setTimeout(resolve, 500));
            }
            return false;
          },
        ),
    );
    if (!proved)
      throw Error(
        "The consumer did not observe a later quote sequence and regain readiness within 30 seconds.",
      );
  }
  private async proveIncident() {
    const lab = this.lab!,
      incident = this.lab!.incident;
    if (incident === "service-selector" || incident === "service-target-port")
      return this.proveServiceIncident();
    if (incident === "image-pull" || incident === "configmap-key")
      return this.proveStartupIncident();
    if (incident === "market-data-stale") return this.proveMarketDataIncident();
    if (incident !== "readiness" && incident !== "liveness")
      throw Error("No supported incident is active for proof.");
    const contract = lab.plan.contract!,
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
        incident === "liveness" ? "livenessProbe" : "readinessProbe";
      const deployment = object(
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
      const ownedReplicas = new Set(
        replicas
          .filter((r) =>
            list(at(r, "metadata", "ownerReferences")).some(
              (owner) => owner.uid === at(deployment, "metadata", "uid"),
            ),
          )
          .map((r) => text(at(r, "metadata", "uid"))),
      );
      const relevant = pods.filter(
        (p) =>
          list(at(p, "metadata", "ownerReferences")).some((owner) =>
            ownedReplicas.has(text(owner.uid)),
          ) &&
          list(at(p, "spec", "containers")).some(
            (c) =>
              c.name === contract.container &&
              text(at(c, field, "httpGet", "path")).startsWith(
                "/waypoint-missing-",
              ),
          ),
      );
      const confirmed = relevant.some((p) =>
        corroboratedProbeFailure(
          p,
          events,
          contract.container,
          incident,
          lab.incidentInjectedAt ?? lab.startedAt,
        ),
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
  async logs(
    uid: string,
    container: string,
    close = false,
    scope?: { sessionId: string; generation: number; revision: number },
  ) {
    await this.load();
    const assertScope = () => {
      if (
        !scope ||
        this.lab?.id !== scope.sessionId ||
        this.lab.generation !== scope.generation ||
        this.lab.revision !== scope.revision
      )
        throw new LabConflict(
          "Lab changed. Reopen logs for the current session.",
        );
    };
    assertScope();
    if (!this.cache) throw Error("Lab observations unavailable.");
    if (close) {
      this.cache.closeLog(uid, container);
      return null;
    }
    const buffer = await this.cache.follow(uid, container);
    assertScope();
    return buffer;
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
