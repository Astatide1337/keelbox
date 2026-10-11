/** Connection age never implies Kubernetes readiness or application health. */
export type EvidenceStatus = {
  kind: string;
  state: string;
  receivedAt: string | null;
  error?: string;
};
export function observationFreshness(
  statuses: EvidenceStatus[],
  now = Date.now(),
) {
  const lastObservation =
    statuses
      .map((s) => s.receivedAt)
      .filter((s): s is string => !!s)
      .sort()
      .at(-1) ?? null;
  const unavailable = statuses.filter(
    (s) =>
      s.state !== "current" ||
      !s.receivedAt ||
      !Number.isFinite(Date.parse(s.receivedAt)) ||
      now - Date.parse(s.receivedAt) > 90_000 ||
      Date.parse(s.receivedAt) > now + 30_000,
  );
  return {
    state:
      !statuses.length || !lastObservation
        ? ("connecting" as const)
        : unavailable.length
          ? ("stale" as const)
          : ("current" as const),
    lastObservation,
    reasons: unavailable.map(
      (s) =>
        `${s.kind}: ${s.error ?? (s.state !== "current" ? s.state : "No valid successful observation in the last 90 seconds.")}`,
    ),
  };
}
