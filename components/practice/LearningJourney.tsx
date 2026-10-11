"use client";
import { Button } from "../ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../ui/card";
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
    <Card className="mx-4 my-3">
      <CardHeader className="pb-3">
        <CardTitle>
          {completed
            ? "Explain the recovery"
            : incident
              ? "Investigation notebook"
              : "Explore a healthy application"}
        </CardTitle>
        <CardDescription>{objective ?? lesson.objective}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!incident ? (
          <>
            <p className="text-sm">
              A Deployment declares desired replicas. Its ReplicaSet owns Pods.
              Running describes the process; Ready determines traffic
              eligibility. A Service's selector expresses intent, while
              EndpointSlices record observed backends. An HTTP check proves only
              the routes actually checked.
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
            <p className="text-xs text-muted-foreground">
              Probe exercises need a healthy Deployment, an HTTP probe and a
              selecting TCP Service. Configuration edits may require a rollout;
              changing a ConfigMap alone does not prove a process reloaded it.
            </p>
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
                Apply your draft beside the editor before checking. Notes and
                clicking through this guide never award success.
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
                  "Resume synthetic sequence updates through the reviewed producer control and verify that the consumer observes a later sequence before it returns Ready."
                ) : (
                  "Reapply the reviewed baseline for this exact incident and verify the workload, Service endpoints, and HTTP request recover."
                )}
              </p>
            )}
            {completed && (
              <>
                <p className="text-sm">
                  The runtime awarded recovery after its recorded checks passed.{" "}
                  {incident === "readiness"
                    ? "The corrected readiness contract allows the healthy Pods to become eligible backends."
                    : incident === "liveness"
                      ? "The corrected liveness contract stops repeated probe-triggered replacement. Old restart counts can remain; stability over the check window matters."
                      : incident === "market-data-stale"
                        ? "The producer remained live while its synthetic quote sequence stopped advancing. Recovery required a later sequence and consumer readiness."
                        : "Structured runtime evidence identified a fault in the selected Kubernetes resource and confirmed recovery after restoring the reviewed baseline."}{" "}
                  Compare the captured evidence below. These are bounded
                  observations, not a complete history.
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
                  In a real cluster: inspect the selected Pod UID, conditions,
                  probe configuration, recent kubelet events and previous
                  container logs; follow owner UIDs and EndpointSlice
                  targetRefs. Compare desired/live state, then verify a request
                  through the Service. Reset starts a new notebook and draft;
                  the prior attempt remains local to this account and project.
                </p>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
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
          <p>
            {value.observedAt ?? "Observation time unavailable"} · revision{" "}
            {value.revision}
          </p>
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
