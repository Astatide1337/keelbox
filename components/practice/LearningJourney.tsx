"use client";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import type { LiveIncidentId } from "@/lib/domain/live-incidents";
import {
  lessonCopy,
  type LearningProgress,
  type EvidenceSummary,
} from "@/lib/practice/live-learning";

export function LearningJourney({
  incident,
  completed,
  progress,
  onChange,
  baselinePath,
  generatedHints,
  objective,
  onInspect,
  onCheck,
  disabled,
  dirty,
}: {
  incident: LiveIncidentId | null;
  completed: boolean;
  progress: LearningProgress;
  onChange: (value: LearningProgress) => void;
  baselinePath?: string;
  generatedHints?: string[];
  objective?: string;
  onInspect: (tab: string) => void;
  onCheck: () => void;
  disabled: boolean;
  dirty: boolean;
}) {
  const lesson = lessonCopy[incident ?? "healthy"],
    hints = generatedHints ?? [...lesson.hints];
  const edit = (patch: Partial<LearningProgress>) =>
    onChange({ ...progress, ...patch, updatedAt: new Date().toISOString() });
  return (
    <div className="space-y-4">
      {!incident ? (
        <>
          <p className="text-sm">
            Follow the connections from a Deployment to its Pods and Service. A
            running Pod receives traffic only when it is Ready.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() => onInspect("relationships")}
            >
              Trace ownership and traffic
            </Button>
            <Button variant="outline" onClick={() => onInspect("yaml")}>
              Compare desired and observed YAML
            </Button>
          </div>
        </>
      ) : (
        <>
          <div
            className="flex flex-wrap gap-2"
            aria-label="Investigation steps"
          >
            <Button variant="outline" onClick={() => onInspect("overview")}>
              Observe
            </Button>
            <Button variant="outline" onClick={() => onInspect("events")}>
              Inspect events
            </Button>
            <Button variant="outline" onClick={() => onInspect("logs")}>
              Inspect logs
            </Button>
            <Button variant="outline" onClick={() => onInspect("yaml")}>
              Repair YAML
            </Button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-sm">
              Hypothesis
              <Textarea
                aria-label="Investigation hypothesis"
                maxLength={1500}
                value={progress.hypothesis}
                onChange={(e) => edit({ hypothesis: e.target.value })}
                placeholder="What could explain these observations?"
              />
            </label>
            <label className="space-y-1 text-sm">
              Prediction
              <Textarea
                aria-label="Investigation prediction"
                maxLength={1500}
                value={progress.prediction}
                onChange={(e) => edit({ prediction: e.target.value })}
                placeholder="Which condition or event would support or reject it?"
              />
            </label>
          </div>
          <label className="block space-y-1 text-sm">
            Interpretation
            <Textarea
              aria-label="Evidence interpretation"
              maxLength={1500}
              value={progress.interpretation}
              onChange={(e) => edit({ interpretation: e.target.value })}
              placeholder="Record which evidence changed your hypothesis."
            />
          </label>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={progress.hintLevel >= hints.length}
              onClick={() =>
                edit({ hintLevel: Math.min(progress.hintLevel + 1, 3) })
              }
            >
              Request hint {Math.min(progress.hintLevel + 1, 3)}
            </Button>
            <Button
              variant="ghost"
              onClick={() => edit({ solutionRequested: true })}
            >
              Show solution
            </Button>
            <Button disabled={disabled || dirty} onClick={onCheck}>
              Check recovery
            </Button>
          </div>
          {dirty && (
            <p className="text-xs text-muted-foreground">
              Apply your manifest changes before checking recovery.
            </p>
          )}
          {hints.slice(0, progress.hintLevel).map((hint, i) => (
            <p key={i} className="border-l-2 border-primary pl-3 text-sm">
              Hint {i + 1}: {hint}
            </p>
          ))}
          {progress.solutionRequested && (
            <p className="rounded border p-3 text-sm">
              {incident === "readiness" || incident === "liveness" ? (
                <>
                  Restore the selected container's original {incident} HTTP
                  probe path
                  {baselinePath ? (
                    <>
                      {" "}
                      <code>{baselinePath}</code>
                    </>
                  ) : (
                    " from the reviewed baseline"
                  )}
                  . Keep required probes, replicas, images, selectors, and
                  configuration. Observe the rollout and then run checks.
                </>
              ) : incident === "market-data-stale" ? (
                "Resume the synthetic feed, then check that new quotes reach the consumer and it becomes Ready."
              ) : (
                "Restore the original configuration, then check recovery."
              )}
            </p>
          )}
          {completed && (
            <>
              <p className="text-sm">
                The workload passed its recovery checks.{" "}
                {incident === "readiness"
                  ? "The corrected readiness contract allows the healthy Pods to become eligible backends."
                  : incident === "liveness"
                    ? "The corrected liveness contract stops repeated probe-triggered replacement. Old restart counts can remain; stability over the check window matters."
                    : incident === "market-data-stale"
                      ? "The producer remained live while its synthetic quote sequence stopped advancing. Recovery required a later sequence and consumer readiness."
                      : "The repaired workload passed its recovery checks."}{" "}
                Compare the observations before and after your repair.
              </p>
              <div className="grid gap-3 md:grid-cols-2">
                <Summary title="Before repair" value={progress.before} />
                <Summary title="Verified recovery" value={progress.after} />
              </div>
              <label className="block space-y-1 text-sm">
                Teach-back
                <Textarea
                  aria-label="Recovery teach-back"
                  maxLength={1500}
                  value={progress.teachBack}
                  onChange={(e) => edit({ teachBack: e.target.value })}
                  placeholder="Explain the cause, the evidence, the repair, and what you would check in a real incident."
                />
              </label>
              <p className="text-xs text-muted-foreground">
                Next time, compare the Pod's health checks, events, and Service
                backends. Verify recovery with an HTTP request.
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
function Summary({
  title,
  value,
}: {
  title: string;
  value: EvidenceSummary | null;
}) {
  return (
    <section className="rounded border p-3 text-xs">
      <h3 className="font-medium">{title}</h3>
      {value ? (
        <>
          <p>{value.observedAt ?? "Observation time unavailable"}</p>
          {value.pods.map((p) => (
            <p key={p.uid}>
              {p.name}: {p.phase}, Ready {p.ready}, restarts {p.restarts}
              {p.waiting.length ? " · " + p.waiting.join(", ") : ""}
            </p>
          ))}
          {value.endpoints.map((e) => (
            <p key={e.uid}>
              EndpointSlice: {e.ready}/{e.total} ready, nonterminating
            </p>
          ))}
          <p>
            Recent event reasons:{" "}
            {[...new Set(value.events.map((e) => e.reason))].join(", ") ||
              "none captured"}
          </p>
        </>
      ) : (
        <p>
          Evidence not captured for this attempt; no before/after claim is
          available.
        </p>
      )}
    </section>
  );
}
