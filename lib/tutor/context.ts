import { createHash } from "node:crypto";
import { projectResources, type Snapshot } from "../domain/snapshot";
import { graphProjection } from "../domain/presentation";
import { analyze } from "../domain/analyzer";
import { at, list, object, text } from "../domain/types";
import type { Exercise } from "../practice/types";
import { incidents } from "../practice/scenarios/catalog";
export function safeText(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (
    value.length > 200 ||
    /bearer\s|password|secret|token|private.?key|BEGIN .*KEY|[A-Za-z0-9_+/=-]{40,}/i.test(
      value,
    )
  )
    return "[redacted]";
  return value;
}
function map(value: unknown) {
  return Object.fromEntries(
    Object.entries(object(value))
      .slice(0, 20)
      .map(([k, v]) => [safeText(k) ?? "unknown", safeText(v)]),
  );
}
function numeric(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : "unknown";
}
function probe(value: unknown) {
  const p = object(value),
    http = object(p.httpGet);
  return Object.keys(p).length
    ? {
        httpGet: Object.keys(http).length
          ? {
              path: safeText(http.path),
              port:
                typeof http.port === "number" ? http.port : safeText(http.port),
            }
          : undefined,
        periodSeconds: numeric(p.periodSeconds),
        failureThreshold: numeric(p.failureThreshold),
      }
    : undefined;
}
export function tutorContext(
  project: Snapshot,
  scope: { resourceId?: string; relationshipId?: string },
  exercise?: Exercise,
) {
  const all = projectResources(
    project,
    exercise?.modeledFiles ?? project.files,
  );
  const analysis = {
    relationships: graphProjection(all, analyze(all).relationships, project),
  };
  const relationship = scope.relationshipId
    ? analysis.relationships.find((r) => r.id === scope.relationshipId)
    : undefined;
  if (scope.relationshipId && !relationship)
    throw Error("Relationship is no longer present in this evidence revision.");
  const selected = scope.resourceId
    ? all.find((r) => r.id === scope.resourceId)
    : undefined;
  if (scope.resourceId && !selected)
    throw Error("Resource is no longer present in this evidence revision.");
  const keys = new Set(
    [selected?.id, relationship?.from, relationship?.to].filter(Boolean),
  );
  if (keys.size)
    for (let depth = 0; depth < 2; depth++) {
      const prior = new Set(keys);
      for (const r of analysis.relationships)
        if (prior.has(r.from) || (r.to && prior.has(r.to))) {
          keys.add(r.from);
          if (r.to) keys.add(r.to);
        }
    }
  const resources = keys.size ? all.filter((r) => keys.has(r.id)) : all;
  const evidence = resources.slice(0, 30).map((r, i) => {
    const raw =
      exercise?.resources.find(
        (v) =>
          text(at(v, "metadata", "name")) === r.name &&
          text(at(v, "metadata", "namespace")) === (r.namespace ?? "") &&
          v.kind === r.kind,
      ) ??
      project.resources.find(
        (v) =>
          text(at(v, "metadata", "name")) === r.name &&
          text(at(v, "metadata", "namespace")) === (r.namespace ?? "") &&
          v.kind === r.kind,
      );
    const containers = list(
      at(
        r.raw,
        r.kind === "Pod" ? "spec" : "spec",
        ...(r.kind === "Pod" ? [] : ["template", "spec"]),
        "containers",
      ),
    );
    const observed = raw
      ? {
          phase: safeText(at(raw, "status", "phase")),
          conditions: list(at(raw, "status", "conditions")).map((c) => ({
            type: safeText(c.type),
            status: safeText(c.status),
            lastTransitionTime: safeText(c.lastTransitionTime),
          })),
          containers: list(at(raw, "status", "containerStatuses")).map((c) => ({
            name: safeText(c.name),
            ready: typeof c.ready === "boolean" ? c.ready : "unknown",
            restartCount:
              typeof c.restartCount === "number" ? c.restartCount : "unknown",
          })),
          readyReplicas: numeric(at(raw, "status", "readyReplicas")),
        }
      : "unavailable";
    return {
      id: "E" + (i + 1),
      resourceId: r.id,
      kind: r.kind,
      name: safeText(r.name),
      namespace: safeText(r.namespace),
      configuration: {
        provenance: project.files.some((f) => f.id === r.source.fileId)
          ? "declared in authored manifest"
          : exercise
            ? "synthetic practice resource"
            : "captured resource configuration; no authored manifest",
        labels: map(at(r.raw, "metadata", "labels")),
        selector: map(
          at(
            r.raw,
            "spec",
            "selector",
            ...(["Deployment", "ReplicaSet"].includes(r.kind)
              ? ["matchLabels"]
              : []),
          ),
        ),
        controllerOwners: list(at(r.raw, "metadata", "ownerReferences"))
          .filter((o) => o.controller === true)
          .map((o) => ({
            kind: safeText(o.kind),
            name: safeText(o.name),
            uid: safeText(o.uid),
          })),
        replicas: numeric(at(r.raw, "spec", "replicas")),
        containers: containers.map((c) => ({
          name: safeText(c.name),
          ports: list(c.ports).map((p) => ({
            containerPort: numeric(p.containerPort),
            name: safeText(p.name),
          })),
          readinessProbe: probe(c.readinessProbe),
          livenessProbe: probe(c.livenessProbe),
        })),
      },
      source: {
        fileId: r.source.fileId,
        line: r.source.line,
        path: r.source.path.map((p) => safeText(p)),
        origin: project.files.some((f) => f.id === r.source.fileId)
          ? "authored"
          : "captured resource; no authored file",
      },
      observation: {
        provenance: exercise
          ? "synthetic practice state"
          : project.origin === "captured"
            ? "captured snapshot"
            : project.origin === "bundled"
              ? "bundled example"
              : "unavailable; manifest-only project",
        capturedAt: project.captureEndedAt,
        data: observed,
      },
    };
  });
  const result = {
    project: {
      label: safeText(project.label),
      origin: project.origin,
      capturedAt: project.captureEndedAt,
      live: false,
    },
    evidence,
    omittedResources: Math.max(0, resources.length - 30),
    relationships: analysis.relationships
      .filter(
        (r) =>
          evidence.some((e) => e.resourceId === r.from) &&
          evidence.some((e) => e.resourceId === r.to),
      )
      .slice(0, 60)
      .map((r) => ({
        id: r.id,
        provenance: "inferred",
        from: r.from,
        to: r.to,
        kind: r.kind,
        status: r.status,
        source: r.evidence.map((e) => ({
          fileId: e.fileId,
          line: e.line,
          path: e.path.map((p) => safeText(p)),
        })),
      })),
    coverage: project.coverage.slice(0, 60).map((c) => ({
      kind: c.kind,
      namespace: safeText(c.namespace),
      state: c.state,
      capturedAt: c.capturedAt,
    })),
    practice: exercise
      ? {
          id: exercise.id,
          revision: exercise.revision,
          provenance: "synthetic",
          objective: incidents.find((i) => i.id === exercise.scenario)
            ?.objective,
          visibleHints: incidents
            .find((i) => i.id === exercise.scenario)
            ?.hints.slice(0, exercise.hintsRevealed),
          events: exercise.events.slice(-15).map((e) => ({
            reason: safeText(e.reason),
            modelTime: e.modelTime,
            count: e.count,
          })),
          checks: exercise.checks.map((c) => ({ id: c.id, passed: c.passed })),
          state: exercise.state,
        }
      : undefined,
    excluded: [
      "Secret values",
      "ConfigMap contents",
      "environment values",
      "annotations",
      "raw logs",
      "raw event messages",
    ],
  };
  const serialized = JSON.stringify(result);
  if (serialized.length > 40000)
    throw Error("Evidence is too large. Select a narrower resource scope.");
  return {
    context: result,
    digest: createHash("sha256").update(serialized).digest("hex"),
  };
}
