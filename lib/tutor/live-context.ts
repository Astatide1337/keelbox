import { observationFreshness } from "../domain/freshness";
import {
  learningContextSchema,
  type LearningContext,
} from "../practice/live-learning";
import { tutorContext, safeText, sanitizeTutorValue } from "./context";
import { at, text, resourceKey } from "../domain/types";
import { digest } from "../domain/deployment-plan";
import { projectResources, type Snapshot } from "../domain/snapshot";
import { analyze } from "../domain/analyzer";
import { graphProjection } from "../domain/presentation";
import type { MinikubeRuntime } from "../server/minikube-runtime";
export function liveTutorContext(
  view: ReturnType<MinikubeRuntime["view"]>,
  scope: {
    resourceId?: string;
    relationshipId?: string;
    learning?: LearningContext;
  },
) {
  const lab = view.lab;
  if (
    !lab ||
    lab.phase === "stopped" ||
    observationFreshness(lab.evidence.status).state !== "current" ||
    ("connection" in lab.evidence &&
      lab.evidence.connection &&
      lab.evidence.connection.state !== "current")
  )
    throw Error(
      "Live evidence is stale or unavailable. Reconnect before asking.",
    );
  const selected = scope.resourceId
    ? lab.evidence.resources.find(
        (r) => at(r, "metadata", "uid") === scope.resourceId,
      )
    : undefined;
  if (scope.resourceId && !selected)
    throw Error(
      "Selected resource UID was replaced. Select its current replacement.",
    );
  const snapshot: Snapshot = {
    format: "playground-snapshot-v2",
    id: lab.id,
    label: "Owned local application",
    origin: "captured",
    captureStartedAt: lab.evidence.receivedAt,
    captureEndedAt: lab.evidence.receivedAt,
    resources: lab.evidence.resources,
    files: [],
    errors: [],
    contracts: [],
    coverage: lab.evidence.status.map((s) => ({
      kind: s.kind,
      namespace: lab.namespace,
      state: "captured",
      capturedAt: s.receivedAt ?? "",
    })),
  };
  const resourceIds = new Map(
    lab.evidence.resources.map((r) => [
      text(at(r, "metadata", "uid")),
      resourceKey(
        text(r.kind),
        text(at(r, "metadata", "namespace")) || null,
        text(at(r, "metadata", "name")),
        text(r.apiVersion),
      ),
    ]),
  );
  // A controller's events usually belong to descendant Pods, not its own UID.
  const relevantUids = new Set(
    selected ? [text(at(selected, "metadata", "uid"))] : [],
  );
  if (selected)
    for (let depth = 0; depth < 3; depth++)
      for (const r of lab.evidence.resources) {
        const owners = at(r, "metadata", "ownerReferences");
        if (
          Array.isArray(owners) &&
          owners.some((o) => relevantUids.has(text(at(o, "uid"))))
        )
          relevantUids.add(text(at(r, "metadata", "uid")));
      }
  const namedResources = projectResources(snapshot);
  const uidResources = namedResources.map((r) => ({
    ...r,
    id: text(at(r.raw, "metadata", "uid")) || r.id,
  }));
  const exactEdge = scope.relationshipId
    ? analyze(uidResources).relationships.find(
        (r) => r.id === scope.relationshipId,
      )
    : undefined;
  if (scope.relationshipId && !exactEdge)
    throw Error("Relationship is no longer present in this lab revision.");
  const namedEdges = graphProjection(
    namedResources,
    analyze(namedResources).relationships,
    snapshot,
  );
  const namedEdge = exactEdge
    ? namedEdges.find(
        (r) =>
          r.from === resourceIds.get(exactEdge.from) &&
          r.to === (exactEdge.to ? resourceIds.get(exactEdge.to) : null) &&
          r.kind === exactEdge.kind &&
          r.title === exactEdge.title,
      )
    : undefined;
  if (exactEdge && !namedEdge)
    throw Error("Relationship evidence is unavailable in this revision.");
  const result = tutorContext(snapshot, {
    relationshipId: namedEdge?.id,
    resourceId: selected
      ? resourceKey(
          text(selected.kind),
          text(at(selected, "metadata", "namespace")) || null,
          text(at(selected, "metadata", "name")),
          text(selected.apiVersion),
        )
      : undefined,
  });
  const context = sanitizeTutorValue({
    ...result.context,
    project: { ...result.context.project, live: true },
    learning: scope.learning
      ? learningContextSchema.parse(scope.learning)
      : undefined,
    lab: {
      sessionId: lab.id,
      generation: lab.generation,
      revision: lab.revision,
      phase: lab.phase,
      incident: lab.incident,
      checks: lab.checks.map((c) => ({
        name: safeText(c.name),
        passed: c.passed,
        reason: safeText(c.detail),
      })),
    },
    events: lab.evidence.events
      .filter(
        (e) =>
          !selected || relevantUids.has(text(at(e, "involvedObject", "uid"))),
      )
      .slice(-15)
      .map((e) => ({
        uid: safeText(at(e, "metadata", "uid")),
        resourceUid: safeText(at(e, "involvedObject", "uid")),
        resourceId: resourceIds.get(text(at(e, "involvedObject", "uid"))),
        reason: safeText(e.reason),
        type: safeText(e.type),
        source: safeText(at(e, "source", "component")),
        firstTimestamp: safeText(e.firstTimestamp),
        lastTimestamp: safeText(e.lastTimestamp ?? e.eventTime),
        count:
          typeof e.count === "number" &&
          Number.isFinite(e.count) &&
          e.count >= 0
            ? e.count
            : "unknown",
      })),
  });
  return { context, digest: digest(context) };
}
