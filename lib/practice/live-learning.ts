import { z } from "zod";

/** Browser progress is notes, not a grade or permission to mutate a cluster. */
export const learningContextSchema = z
  .object({
    lesson: z.enum(["healthy", "readiness", "liveness"]),
    objective: z.string().max(500),
    hypothesis: z.string().max(1500),
    prediction: z.string().max(1500),
    hintLevel: z.number().int().min(0).max(3),
    visibleHints: z.array(z.string().max(500)).max(3),
    solutionRequested: z.boolean(),
    fieldPath: z.string().max(500).optional(),
    repairChanges: z
      .array(
        z
          .object({
            field: z.enum(["readinessPath", "livenessPath"]),
            desired: z.string().max(500),
            draft: z.string().max(500),
          })
          .strict(),
      )
      .max(2)
      .optional(),
    helpTarget: z.enum([
      "investigation",
      "relationship",
      "yaml-field",
      "failed-check",
      "repair-diff",
      "debrief",
    ]),
  })
  .strict();
export type LearningContext = z.infer<typeof learningContextSchema>;
export type LearningProgress = {
  hypothesis: string;
  prediction: string;
  interpretation: string;
  teachBack: string;
  hintLevel: number;
  solutionRequested: boolean;
  before: EvidenceSummary | null;
  after: EvidenceSummary | null;
  updatedAt: string;
};
export type EvidenceSummary = {
  observedAt: string | null;
  revision: number;
  pods: {
    uid: string;
    name: string;
    phase: string;
    ready: string;
    restarts: number;
    waiting: string[];
  }[];
  endpoints: { uid: string; ready: number; total: number }[];
  events: { uid: string; reason: string; timestamp: string }[];
};
export function emptyProgress(): LearningProgress {
  return {
    hypothesis: "",
    prediction: "",
    interpretation: "",
    teachBack: "",
    hintLevel: 0,
    solutionRequested: false,
    before: null,
    after: null,
    updatedAt: "",
  };
}
export function learningKey(
  account: string,
  project: string,
  lab: string,
  generation: number,
) {
  return (
    "waypoint:learning:v1:" +
    JSON.stringify([account, project, lab, generation])
  );
}
export function restoreProgress(serialized: string | null): LearningProgress {
  if (!serialized || serialized.length > 100_000) return emptyProgress();
  try {
    const value = JSON.parse(serialized);
    const basic = z
      .object({
        hypothesis: z.string().max(1500),
        prediction: z.string().max(1500),
        interpretation: z.string().max(1500),
        teachBack: z.string().max(1500),
        hintLevel: z.number().int().min(0).max(3),
        solutionRequested: z.boolean(),
        updatedAt: z.string().max(100),
        before: z.unknown(),
        after: z.unknown(),
      })
      .parse(value);
    const summary = z.object({
      observedAt: z.string().nullable(),
      revision: z.number().int(),
      pods: z
        .array(
          z.object({
            uid: z.string(),
            name: z.string(),
            phase: z.string(),
            ready: z.string(),
            restarts: z.number(),
            waiting: z.array(z.string()),
          }),
        )
        .max(30),
      endpoints: z
        .array(
          z.object({ uid: z.string(), ready: z.number(), total: z.number() }),
        )
        .max(30),
      events: z
        .array(
          z.object({
            uid: z.string(),
            reason: z.string(),
            timestamp: z.string(),
          }),
        )
        .max(15),
    });
    return {
      ...basic,
      before: basic.before ? summary.parse(basic.before) : null,
      after: basic.after ? summary.parse(basic.after) : null,
    };
  } catch {
    return emptyProgress();
  }
}
export const lessonCopy = {
  healthy: {
    objective:
      "Trace desired replicas to running, ready Pods and their Service backends.",
    hints: [
      "Select a Deployment, then its controller-owned ReplicaSet and Pods.",
      "Compare desired replicas with observed Ready conditions. Running alone does not mean Ready.",
      "Follow a Service to its EndpointSlices and target Pod UIDs. Only an actual request can establish HTTP success.",
    ],
  },
  readiness: {
    objective:
      "Explain why a running container is excluded from traffic and restore the healthy readiness contract.",
    hints: [
      "Compare Pod Ready conditions with container readiness, then inspect recent kubelet events.",
      "Check the HTTP readiness probe configuration and whether its reported response matches the healthy baseline.",
      "Follow Service → EndpointSlice → Pod. A failed readiness check removes traffic eligibility without itself restarting the process.",
    ],
  },
  liveness: {
    objective:
      "Corroborate probe-triggered restarts, restore the liveness contract, and prove recovery.",
    hints: [
      "Inspect container restarts, last termination and recent kubelet events together. Counts alone do not identify a cause.",
      "Look for repeated liveness failures followed by a kubelet killing event. Readiness and liveness have different effects.",
      "Compare the selected container's liveness probe with its healthy baseline. Preserve the probe and its dependencies.",
    ],
  },
} as const;

export function summarizeEvidence(
  resources: Record<string, unknown>[],
  events: Record<string, unknown>[],
  observedAt: string | null,
  revision: number,
): EvidenceSummary {
  const record = (v: unknown): Record<string, unknown> =>
    v && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : {};
  const str = (v: unknown) => (typeof v === "string" ? v : "unknown");
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(record) : []);
  return {
    observedAt,
    revision,
    pods: resources
      .filter((r) => r.kind === "Pod")
      .slice(0, 30)
      .map((r) => {
        const m = record(r.metadata),
          s = record(r.status),
          containers = arr(s.containerStatuses);
        return {
          uid: str(m.uid),
          name: str(m.name),
          phase: str(s.phase),
          ready: str(arr(s.conditions).find((c) => c.type === "Ready")?.status),
          restarts: containers.reduce(
            (sum, c) =>
              sum + (typeof c.restartCount === "number" ? c.restartCount : 0),
            0,
          ),
          waiting: containers.flatMap((c) => {
            const reason = record(record(c.state).waiting).reason;
            return typeof reason === "string" ? [reason] : [];
          }),
        };
      }),
    endpoints: resources
      .filter((r) => r.kind === "EndpointSlice")
      .slice(0, 30)
      .map((r) => ({
        uid: str(record(r.metadata).uid),
        total: arr(r.endpoints).length,
        ready: arr(r.endpoints).filter(
          (e) =>
            record(e.conditions).ready === true &&
            record(e.conditions).terminating !== true,
        ).length,
      })),
    events: events.slice(-15).map((e) => ({
      uid: str(record(e.metadata).uid),
      reason: str(e.reason),
      timestamp: str(e.lastTimestamp ?? record(e.metadata).creationTimestamp),
    })),
  };
}
