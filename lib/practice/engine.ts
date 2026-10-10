import { stringify } from "yaml";
import { parseSources } from "../domain/importer";
import {
  at,
  list,
  object,
  text,
  resourceKey,
  type ObjectMap,
  type SourceFile,
} from "../domain/types";
import {
  capturedFiles,
  snapshotDigest,
  type Snapshot,
} from "../domain/snapshot";
import { compatibility } from "./compatibility";
import type { Exercise, IncidentId, Targets } from "./types";
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.entries(v)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(v) ?? "null";
}
function container(d: ObjectMap, t: Targets) {
  return list(at(d, "spec", "template", "spec", "containers")).find(
    (c) => c.name === t.container,
  )!;
}
function probe(c: ObjectMap, scenario: IncidentId) {
  return object(
    c[scenario === "liveness" ? "livenessProbe" : "readinessProbe"],
  );
}
function target(objects: ObjectMap[], id: string) {
  return objects.find(
    (r) =>
      resourceKey(
        text(r.kind),
        text(at(r, "metadata", "namespace")) || null,
        text(at(r, "metadata", "name")),
        text(r.apiVersion),
      ) === id,
  )!;
}
function faultFiles(files: SourceFile[], scenario: IncidentId, t: Targets) {
  return files.map((f) => {
    const p = parseSources([f]);
    if (p.diagnostics.length) throw Error("Invalid exercise baseline.");
    const objects = p.resources.map((r) => structuredClone(r.raw));
    for (const r of objects) {
      if (
        resourceKey(
          text(r.kind),
          text(at(r, "metadata", "namespace")) || null,
          text(at(r, "metadata", "name")),
          text(r.apiVersion),
        ) === (scenario === "http503" ? t.service : t.deployment)
      ) {
        if (scenario === "http503") {
          const selector = object(at(r, "spec", "selector"));
          const key = Object.keys(selector)[0];
          selector[key] = "practice-unmatched";
        } else
          object(probe(container(r, t), scenario).httpGet).path =
            "/practice-unavailable";
      }
    }
    return { ...f, content: objects.map((o) => stringify(o)).join("\n---\n") };
  });
}
function modeled(exercise: Exercise, healthy: boolean) {
  const e = exercise;
  e.modelRevision = e.revision;
  e.modeledFiles = structuredClone(e.draftFiles);
  const d = target(
    parseSources(e.draftFiles).resources.map((r) => r.raw),
    e.targets.deployment,
  );
  const c = container(d, e.targets);
  const failureThreshold = Number(probe(c, e.scenario).failureThreshold ?? 3);
  const successThreshold = Number(probe(c, e.scenario).successThreshold ?? 1);
  const period = Number(probe(c, e.scenario).periodSeconds ?? 10);
  e.modelTime = healthy
    ? period * successThreshold + 60
    : period * failureThreshold * (e.scenario === "liveness" ? 3 : 1);
  const restartBase = e.source.resources.filter((r) =>
    e.targets.podUids.includes(text(at(r, "metadata", "uid"))),
  );
  e.resources = structuredClone(e.source.resources);
  for (const r of e.resources) {
    if (
      r.kind === "Deployment" &&
      at(r, "metadata", "name") === e.targets.contract.deployment &&
      at(r, "metadata", "namespace") === e.targets.namespace
    ) {
      r.spec = structuredClone(d.spec);
      r.status = {
        ...object(r.status),
        readyReplicas:
          healthy || e.scenario === "http503" ? e.targets.podUids.length : 0,
      };
    }
    if (e.targets.podUids.includes(text(at(r, "metadata", "uid")))) {
      r.spec = structuredClone(at(d, "spec", "template", "spec"));
      const podReady = healthy || e.scenario === "http503";
      const base = restartBase.find(
        (p) => at(p, "metadata", "uid") === at(r, "metadata", "uid"),
      );
      r.status = {
        ...object(r.status),
        phase: "Running",
        conditions: [
          {
            type: "Ready",
            status: podReady ? "True" : "False",
            reason: podReady ? "PracticeProbeSucceeded" : "PracticeProbeFailed",
          },
        ],
        containerStatuses: [
          {
            name: e.targets.container,
            ready: podReady,
            restartCount:
              Number(
                list(at(base, "status", "containerStatuses")).find(
                  (c) => c.name === e.targets.container,
                )?.restartCount ?? 0,
              ) + (e.scenario === "liveness" ? 3 : 0),
          },
        ],
      };
    }
  }
  const service = target(
    parseSources(e.draftFiles).resources.map((r) => r.raw),
    e.targets.service,
  );
  for (const r of e.resources) {
    if (
      r.kind === "Service" &&
      at(r, "metadata", "name") === at(service, "metadata", "name") &&
      at(r, "metadata", "namespace") === e.targets.namespace
    )
      r.spec = structuredClone(service.spec);
    if (
      r.kind === "EndpointSlice" &&
      at(r, "metadata", "labels", "kubernetes.io/service-name") ===
        at(service, "metadata", "name") &&
      at(r, "metadata", "namespace") === e.targets.namespace
    )
      r.endpoints = e.targets.podUids.map((uid) => ({
        conditions: { ready: healthy },
        targetRef: { kind: "Pod", uid },
      }));
  }
  e.events = e.targets.podUids.flatMap((uid) =>
    healthy
      ? [
          {
            uid,
            reason: "PracticeStable",
            message:
              e.scenario === "liveness"
                ? "Healthy probes; no additional modeled restarts in the check window."
                : "Modeled healthy endpoint and traffic eligibility.",
            modelTime: e.modelTime,
            count: 1,
          },
        ]
      : e.scenario === "http503"
        ? []
        : [
            {
              uid,
              reason: "Unhealthy",
              message: `${e.scenario === "liveness" ? "Liveness" : "Readiness"} probe failed: HTTP probe failed with statuscode: 404`,
              modelTime: e.modelTime,
              count: failureThreshold * (e.scenario === "liveness" ? 3 : 1),
            },
            ...(e.scenario === "liveness"
              ? [
                  {
                    uid,
                    reason: "Killing",
                    message:
                      "Container failed liveness probe, will be restarted",
                    modelTime: e.modelTime + 1,
                    count: 3,
                  },
                ]
              : []),
          ],
  );
  e.logs = Object.fromEntries(
    e.targets.podUids.map((uid) => [
      uid,
      [
        `T+0s ${e.targets.container}: listening on :${e.targets.contract.port}`,
        healthy || e.scenario === "http503"
          ? `T+${e.modelTime}s GET ${e.targets.contract.path} 200`
          : "T+10s GET /practice-unavailable 404",
      ],
    ]),
  );
  if (e.scenario === "http503")
    e.logs.gateway = [
      healthy
        ? "gateway: HTTP 200, expected backend response"
        : "gateway: HTTP 503 backend unavailable (explicit scenario fallback contract)",
    ];
}
export function createExercise(
  source: Snapshot,
  scenario: IncidentId,
): Exercise {
  const c = compatibility(source, scenario);
  if (!c.supported) throw Error(c.reasons.join("\n"));
  const authoredIds = new Set(
    parseSources(source.files).resources.map((r) => r.id),
  );
  const supplemental = capturedFiles(source).filter((f) =>
    parseSources([f]).resources.some(
      (r) =>
        !authoredIds.has(r.id) &&
        !["Pod", "ReplicaSet", "EndpointSlice", "Event"].includes(r.kind),
    ),
  );
  const baselineFiles = structuredClone([...source.files, ...supplemental]);
  const e: Exercise = {
    id: crypto.randomUUID(),
    scenario,
    sourceId: source.id,
    sourceDigest: snapshotDigest(source),
    source,
    targets: c.targets,
    attempt: 1,
    revision: 0,
    state: "preparing",
    draftFiles: [],
    baselineFiles,
    resources: [],
    events: [],
    logs: {},
    modelTime: 0,
    modelRevision: 0,
    modeledFiles: [],
    hintsRevealed: 0,
    checks: [],
    resets: [],
    operations: {},
  };
  e.draftFiles = faultFiles(baselineFiles, scenario, e.targets);
  modeled(e, false);
  e.state = "running";
  return e;
}
function guard(e: Exercise, revision: number) {
  if (snapshotDigest(e.source) !== e.sourceDigest)
    throw Error("The source snapshot changed. Reimport before continuing.");
  if (Object.keys(e.operations).length >= 100)
    throw Error("Exercise operation limit reached. Start a new exercise.");
  if (e.revision !== revision) throw Error("Stale exercise revision.");
  if (["checking", "resetting", "stopped", "failed"].includes(e.state))
    throw Error(`Exercise is ${e.state}.`);
}
export function editDraft(
  e: Exercise,
  revision: number,
  fileId: string,
  content: string,
): Exercise {
  guard(e, revision);
  if (content.length > 2_000_000) throw Error("Draft exceeds 2 MB.");
  if (!e.draftFiles.some((f) => f.id === fileId))
    throw Error("This captured object is not editable.");
  return {
    ...e,
    draftFiles: e.draftFiles.map((f) =>
      f.id === fileId ? { ...f, content } : f,
    ),
    revision: e.revision + 1,
    state: "running",
    checks: [],
  };
}
function replay(
  e: Exercise,
  revision: number,
  id: string,
  kind: "check" | "reset",
) {
  const previous = e.operations[id];
  if (!previous) return false;
  if (previous.revision !== revision || previous.kind !== kind)
    throw Error("Operation ID reused for another request.");
  return previous.result ?? e;
}
function receipt(e: Exercise, id: string): Exercise {
  const record = e.operations[id];
  const result = { ...e, operations: {} };
  return { ...e, operations: { ...e.operations, [id]: { ...record, result } } };
}
export function checkRepair(
  e: Exercise,
  revision: number,
  id: string,
): Exercise {
  const replayed = replay(e, revision, id, "check");
  if (replayed) return replayed;
  guard(e, revision);
  const next = {
    ...e,
    revision: e.revision + 1,
    state: "checking" as const,
    operations: { ...e.operations, [id]: { revision, kind: "check" as const } },
  };
  const parsed = parseSources(e.draftFiles);
  let failure = "";
  if (parsed.diagnostics.length)
    failure = parsed.diagnostics
      .map((d) => `Line ${d.line}: ${d.message}`)
      .join("\n");
  else {
    const proposed = parsed.resources.map((r) => structuredClone(r.raw));
    const expected = parseSources(e.baselineFiles).resources.map((r) =>
      structuredClone(r.raw),
    );
    if (e.scenario !== "http503") {
      const d = target(expected, e.targets.deployment);
      object(probe(container(d, e.targets), e.scenario).httpGet).path =
        e.targets.contract.path;
    }
    if (canonical(proposed) !== canonical(expected))
      failure =
        "Repair the intended field while preserving all resources, replicas, required configuration, probe settings and dependencies.";
  }
  if (failure)
    return receipt(
      {
        ...next,
        state: "running",
        checks: [{ id: "semantic", passed: false, explanation: failure }],
      },
      id,
    );
  const finished: Exercise = {
    ...next,
    state: "completed",
    checks: [
      {
        id: "semantic",
        passed: true,
        explanation:
          "Intended repair validated; all required resources and settings preserved.",
      },
      {
        id: "modeled",
        passed: true,
        explanation:
          e.scenario === "liveness"
            ? "Healthy liveness probes; no additional modeled restarts over a 60-second check window. Restart history retained."
            : e.scenario === "http503"
              ? "Intended Pod UIDs are eligible backend targets; gateway contract models HTTP 200."
              : "Modeled readiness succeeds; intended Pods become eligible endpoints.",
      },
    ],
  };
  modeled(finished, true);
  const pods = finished.resources.filter((r) =>
    finished.targets.podUids.includes(text(at(r, "metadata", "uid"))),
  );
  const ready =
    pods.length === finished.targets.podUids.length &&
    pods.every(
      (p) =>
        list(at(p, "status", "conditions")).some(
          (c) => c.type === "Ready" && c.status === "True",
        ) &&
        list(at(p, "status", "containerStatuses")).some(
          (c) => c.name === finished.targets.container && c.ready === true,
        ),
    );
  const slices = finished.resources.filter(
    (r) =>
      r.kind === "EndpointSlice" &&
      at(r, "metadata", "namespace") === finished.targets.namespace &&
      at(r, "metadata", "labels", "kubernetes.io/service-name") ===
        at(serviceTarget(finished), "metadata", "name"),
  );
  const uids = slices
    .flatMap((r) => list(r.endpoints))
    .filter((e) => at(e, "conditions", "ready") === true)
    .map((e) => text(at(e, "targetRef", "uid")));
  if (!ready || finished.targets.podUids.some((uid) => !uids.includes(uid))) {
    finished.state = "running";
    finished.checks[1] = {
      id: "modeled",
      passed: false,
      explanation: "The modeled readiness/endpoint invariants did not pass.",
    };
  }
  return receipt(finished, id);
}
export function restartExercise(
  e: Exercise,
  revision: number,
  id: string,
): Exercise {
  const replayed = replay(e, revision, id, "reset");
  if (replayed) return replayed;
  guard(e, revision);
  const fresh: Exercise = {
    ...e,
    attempt: e.attempt + 1,
    revision: e.revision + 1,
    state: "resetting",
    draftFiles: faultFiles(e.baselineFiles, e.scenario, e.targets),
    checks: [],
    hintsRevealed: 0,
    resets: [...e.resets, { attempt: e.attempt, revision: e.revision }],
    operations: { ...e.operations, [id]: { revision, kind: "reset" } },
  };
  modeled(fresh, false);
  fresh.state = "running";
  return receipt(fresh, id);
}

function serviceTarget(e: Exercise) {
  return target(
    parseSources(e.draftFiles).resources.map((r) => r.raw),
    e.targets.service,
  );
}
