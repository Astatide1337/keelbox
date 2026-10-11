import { tutorContext, safeText } from "./context";
import { at, text, resourceKey } from "../domain/types";
import { digest } from "../domain/deployment-plan";
import type { Snapshot } from "../domain/snapshot";
import type { MinikubeRuntime } from "../server/minikube-runtime";
export function liveTutorContext(
  view: ReturnType<MinikubeRuntime["view"]>,
  scope: { resourceId?: string },
) {
  const lab = view.lab;
  if (
    !lab ||
    lab.phase === "stopped" ||
    !lab.evidence.status.length ||
    lab.evidence.status.some((s) => s.state !== "current")
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
  const result = tutorContext(snapshot, {
    resourceId: selected
      ? resourceKey(
          text(selected.kind),
          text(at(selected, "metadata", "namespace")) || null,
          text(at(selected, "metadata", "name")),
          text(selected.apiVersion),
        )
      : undefined,
  });
  const context = {
    ...result.context,
    project: { ...result.context.project, live: true },
    lab: {
      sessionId: lab.id,
      generation: lab.generation,
      revision: lab.revision,
      phase: lab.phase,
      incident: lab.incident,
      checks: lab.checks.map((c) => ({
        name: safeText(c.name),
        passed: c.passed,
      })),
    },
    events: lab.evidence.events
      .filter(
        (e) =>
          !selected ||
          at(e, "involvedObject", "uid") === at(selected, "metadata", "uid"),
      )
      .slice(-15)
      .map((e) => ({
        uid: at(e, "metadata", "uid"),
        reason: safeText(e.reason),
        type: safeText(e.type),
        source: safeText(at(e, "source", "component")),
        firstTimestamp: e.firstTimestamp,
        lastTimestamp: e.lastTimestamp,
        count: e.count,
      })),
  };
  return { context, digest: digest(context) };
}
