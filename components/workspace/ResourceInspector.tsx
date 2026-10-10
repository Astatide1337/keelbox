"use client";
import { useState, useRef, useEffect } from "react";
import { stringify } from "yaml";
import { Lightbulb, Box, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { RelationshipEvidence } from "./inspector/RelationshipEvidence";
import {
  resourceOrigin,
  resourcePresentation,
} from "@/lib/domain/presentation";
import { SourceEditor, type EditorContext } from "./SourceEditor";
import {
  at,
  list,
  text,
  type Resource,
  type SourceFile,
  type Diagnostic,
  type ObjectMap,
  type Relationship,
  type EvidenceRef,
} from "@/lib/domain/types";
import {
  capturedResource,
  coverage,
  type Snapshot,
} from "@/lib/domain/snapshot";
import type { Exercise } from "@/lib/practice/types";
import { incidents } from "@/lib/practice/scenarios/catalog";
export function ResourceInspector({
  resource,
  source,
  files,
  exercise,
  tab,
  onTab,
  onSelect,
  onEdit,
  onAsk,
  onHint,
  diagnostics,
  relationships,
  resources,
  editorContexts,
  onClose,
  focusRelationship,
}: {
  resource: Resource;
  source: Snapshot;
  files: SourceFile[];
  exercise: Exercise | null;
  tab: string;
  onTab: (t: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, value: string) => void;
  onAsk?: () => void;
  onHint: () => void;
  diagnostics: Diagnostic[];
  relationships: Relationship[];
  resources: Resource[];
  onClose?: () => void;
  focusRelationship?: string | null;
  editorContexts?: Map<string, EditorContext>;
}) {
  const inspectorRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    inspectorRef.current?.scrollTo({ top: 0 });
  }, [resource.id, tab]);
  const [requestedRef, setRequestedRef] = useState<EvidenceRef | null>(null);
  const focusedRef = useRef<EvidenceRef | null>(null);
  const file = files.find((f) => f.id === resource.source.fileId);
  const captured = capturedResource(source, resource);
  const displayed = exercise
    ? exercise.resources.find(
        (r) =>
          r.kind === resource.kind &&
          at(r, "metadata", "name") === resource.name &&
          at(r, "metadata", "namespace") === resource.namespace,
      )
    : captured;
  const uid = text(at(displayed, "metadata", "uid"));
  const ready = list(at(displayed, "status", "conditions")).find(
    (c) => c.type === "Ready",
  );
  const statuses = list(at(displayed, "status", "containerStatuses"));
  const authored = source.files.some((f) => f.id === file?.id);
  const origin = resourceOrigin(resource, source);
  const presentation = resourcePresentation(
    resource,
    displayed
      ? {
          sessionId: exercise?.id ?? source.id,
          generation: 1,
          revision: 0,
          sequence: 0,
          capturedAt: source.captureEndedAt ?? "",
          resources: exercise?.resources ?? source.resources,
          errors: [],
        }
      : null,
    !!exercise ||
      coverage(source, "EndpointSlice", resource.namespace)?.state ===
        "captured",
  );
  const declaration =
    file?.content ??
    stringify(
      exercise ? (displayed ?? resource.raw) : (captured ?? resource.raw),
    );
  const eventData = exercise
    ? exercise.events.filter((e) => e.uid === uid)
    : source.resources.filter(
        (r) => r.kind === "Event" && at(r, "involvedObject", "uid") === uid,
      );
  const logs =
    exercise?.logs[uid] ??
    (exercise && resource.name === exercise.targets.contract.gateway?.deployment
      ? exercise.logs.gateway
      : undefined);
  const ranges = Object.values(resource.refs)
    .filter(
      (r) =>
        r.path.includes("readinessProbe") ||
        r.path.includes("livenessProbe") ||
        r.path.join(".") === "spec.selector",
    )
    .map((r) => ({ start: r.start, end: r.end }));
  const owner = source.resources.find(
    (r) =>
      r.kind === "ReplicaSet" &&
      at(r, "metadata", "namespace") === resource.namespace &&
      list(at(resource.raw, "metadata", "ownerReferences")).some(
        (o) => o.controller === true && o.uid === at(r, "metadata", "uid"),
      ),
  );
  const parentRef = list(at(owner, "metadata", "ownerReferences")).find(
    (o) => o.kind === "Deployment" && o.controller === true,
  );
  const deployment = resources.find(
    (r) =>
      r.kind === "Deployment" &&
      r.namespace === resource.namespace &&
      parentRef?.uid &&
      at(capturedResource(source, r), "metadata", "uid") === parentRef.uid,
  );
  const deploymentName = deployment?.name;
  function ownerLink() {
    if (deployment) {
      onSelect(deployment.id);
      onTab("YAML");
    }
  }
  return (
    <aside className="inspector" ref={inspectorRef}>
      <div className="inspector-heading">
        <Box aria-hidden="true" />
        <div>
          <span className="section-label">{resource.kind}</span>
          <h2>{resource.name}</h2>
          <div className="inspector-meta">
            <span>{resource.namespace ?? "Cluster scoped"}</span>
            <span>·</span>
            <span>{resource.apiVersion}</span>
          </div>
          <Badge variant="outline" className="mt-3">
            {exercise ? "Practice copy" : origin}
          </Badge>
        </div>
        {onClose && (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close inspector"
            onClick={onClose}
          >
            <X />
          </Button>
        )}
      </div>
      <div className={`condition-card ${presentation.tone}`}>
        <strong>
          <span className="status-dot" />
          {presentation.label}
        </strong>
        <small>
          {exercise
            ? "Synthetic practice state"
            : source.origin === "bundled"
              ? "Bundled reference data"
              : displayed
                ? "As captured · not live"
                : "Observation unavailable"}
        </small>
      </div>
      {onAsk && (
        <Button variant="outline" className="m-4" onClick={onAsk}>
          {exercise
            ? "Ask for investigation guidance"
            : "Ask about this resource"}
        </Button>
      )}
      <Tabs value={tab} onValueChange={onTab}>
        <TabsList className="inspector-tabs">
          {["Overview", "YAML", "Events", "Logs"].map((t) => (
            <TabsTrigger key={t} value={t}>
              {t}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="Overview" className="pane-padding">
          {resource.kind === "Pod" && eventData.length > 0 && (
            <Card className="evidence-card">
              <CardHeader>
                <CardTitle>
                  {exercise ? "Practice evidence" : "Observation evidence"}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="evidence-label">
                  <small>
                    {exercise
                      ? `Scenario time: ${exercise.modelTime}s`
                      : text(at(displayed, "capturedAt")) ||
                        source.captureEndedAt ||
                        "Manifest import · no cluster observations"}
                  </small>
                </div>
                {resource.kind === "Pod" && eventData.length > 0 && (
                  <>
                    <p>{String((eventData[0] as ObjectMap).message)}</p>
                    {!exercise && (
                      <p className="muted">
                        Historical event · last reported{" "}
                        {String(
                          (eventData[0] as ObjectMap).lastTimestamp ??
                            (eventData[0] as ObjectMap).eventTime ??
                            "time unavailable",
                        )}
                        . This does not establish that the failure is still
                        occurring.
                      </p>
                    )}
                    <Button
                      variant="link"
                      size="sm"
                      onClick={() => onTab("Events")}
                    >
                      View event evidence
                    </Button>
                  </>
                )}
              </CardContent>
            </Card>
          )}
          <Card className="evidence-card">
            <CardHeader>
              <CardTitle>{resource.kind} details</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="facts">
                {resource.kind === "Pod" ? (
                  <>
                    <dt>Phase</dt>
                    <dd>
                      {text(at(displayed, "status", "phase")) || "Unknown"}
                    </dd>
                    <dt>Ready condition</dt>
                    <dd>
                      {ready ? String(ready.status) : "Unknown · unavailable"}
                    </dd>
                    <dt>Containers</dt>
                    <dd>
                      {statuses.length
                        ? statuses
                            .map(
                              (c) =>
                                `${c.name}: ready=${c.ready ?? "unknown"}, restarts=${c.restartCount ?? "unknown"}`,
                            )
                            .join("; ")
                        : "Unknown · fields unavailable"}
                    </dd>
                  </>
                ) : resource.kind === "Deployment" ? (
                  <>
                    <dt>Replicas</dt>
                    <dd>
                      {String(
                        at(resource.raw, "spec", "replicas") ?? "Unknown",
                      )}{" "}
                      declared
                    </dd>
                    <dt>Ready replicas</dt>
                    <dd>
                      {String(
                        at(displayed, "status", "readyReplicas") ??
                          "Unknown · unavailable",
                      )}
                    </dd>
                  </>
                ) : resource.kind === "Service" ? (
                  <>
                    <dt>Selector</dt>
                    <dd>
                      {JSON.stringify(
                        at(resource.raw, "spec", "selector") ?? "Unknown",
                      )}
                    </dd>
                    <dt>Ready endpoints</dt>
                    <dd>
                      {exercise ||
                      coverage(source, "EndpointSlice", resource.namespace)
                        ?.state === "captured"
                        ? String(
                            (exercise?.resources ?? source.resources)
                              .filter(
                                (r) =>
                                  r.kind === "EndpointSlice" &&
                                  at(r, "metadata", "namespace") ===
                                    resource.namespace &&
                                  at(
                                    r,
                                    "metadata",
                                    "labels",
                                    "kubernetes.io/service-name",
                                  ) === resource.name,
                              )
                              .flatMap((r) => list(r.endpoints))
                              .filter(
                                (e) => at(e, "conditions", "ready") === true,
                              ).length,
                          )
                        : "Unknown · EndpointSlices unavailable"}
                    </dd>
                  </>
                ) : (
                  <>
                    <dt>Health</dt>
                    <dd>No general health assertion for {resource.kind}</dd>
                  </>
                )}
              </dl>
              {resource.kind === "Pod" && (
                <details className="mt-3 text-sm">
                  <summary className="cursor-pointer">
                    Infrastructure details
                  </summary>
                  <dl className="facts">
                    <dt>Node</dt>
                    <dd>
                      {text(at(displayed, "spec", "nodeName")) ||
                        "Unavailable in snapshot"}
                    </dd>
                    <dt>IP</dt>
                    <dd>
                      {text(at(displayed, "status", "podIP")) ||
                        "Unavailable in snapshot"}
                    </dd>
                  </dl>
                </details>
              )}
            </CardContent>
          </Card>
          <RelationshipEvidence
            relationships={relationships}
            files={files}
            focusId={focusRelationship}
            onEvidence={(ref) => {
              focusedRef.current = null;
              setRequestedRef(ref);
              const target = resources.find(
                (r) =>
                  r.source.fileId === ref.fileId &&
                  r.source.document === ref.document,
              );
              if (target) onSelect(target.id);
              onTab("YAML");
            }}
          />
        </TabsContent>
        <TabsContent value="YAML" className="yaml-pane">
          <div className="yaml-label">
            {file?.name ??
              `Captured API object / ${resource.kind}/${resource.name}`}
            <Badge variant="outline">
              {exercise
                ? file
                  ? "Practice draft"
                  : "Synthetic object"
                : file
                  ? "Analysis draft"
                  : "Read-only capture"}
            </Badge>
          </div>
          {resource.kind === "Pod" && !authored && deploymentName && (
            <Button variant="link" onClick={ownerLink}>
              Open owner manifest
            </Button>
          )}
          {diagnostics.length > 0 && (
            <div className="notice" role="alert">
              Invalid YAML · draft retained; previous graph is stale.{" "}
              {diagnostics[0].message}
            </div>
          )}
          <SourceEditor
            contextKey={`${exercise ? `${exercise.id}:${exercise.attempt}` : source.id}:${file?.id ?? resource.id}`}
            contexts={editorContexts}
            value={declaration}
            onChange={(value) => file && onEdit(file.id, value)}
            ranges={
              requestedRef && requestedRef.fileId === resource.source.fileId
                ? [{ start: requestedRef!.start, end: requestedRef!.end }]
                : file
                  ? ranges
                  : []
            }
            onView={(v) => {
              if (
                requestedRef &&
                focusedRef.current !== requestedRef &&
                requestedRef.fileId === resource.source.fileId &&
                requestedRef!.end <= v.state.doc.length
              ) {
                focusedRef.current = requestedRef;
                v.dispatch({
                  selection: {
                    anchor: requestedRef!.start,
                    head: requestedRef!.end,
                  },
                  scrollIntoView: true,
                });
              }
            }}
            readOnly={!file}
          />
          <div className="yaml-footer">
            {exercise
              ? "Repairs affect this practice copy only."
              : file
                ? "Local analysis draft. Captured observations and source import are unchanged."
                : "No original authored file is available."}
          </div>
        </TabsContent>
        <TabsContent value="Events" className="pane-padding">
          <Badge variant="outline">
            {exercise
              ? "Synthetic scenario events"
              : "Captured Kubernetes events"}
          </Badge>
          {eventData.length ? (
            eventData.map((raw, i) => {
              const e = raw as ObjectMap;
              return (
                <div key={i} className="event">
                  <strong>{String(e.reason)}</strong>
                  <p>{String(e.message)}</p>
                  <small>
                    {exercise
                      ? `T+${e.modelTime}s · ${e.count} occurrences`
                      : `First ${e.firstTimestamp ?? "unknown"} · last ${e.lastTimestamp ?? e.eventTime ?? "unknown"} · count ${e.count ?? "unknown"}`}
                  </small>
                </div>
              );
            })
          ) : (
            <div className="empty">
              <strong>
                {exercise
                  ? "No scenario events for this resource"
                  : coverage(source, "Event", resource.namespace)?.state ===
                      "captured"
                    ? "No events captured for this resource"
                    : "Events unavailable"}
              </strong>
              <p>
                {exercise
                  ? "Select the affected Pod for kubelet evidence."
                  : "Missing or old events do not establish current health or current probe failure."}
              </p>
            </div>
          )}
        </TabsContent>
        <TabsContent value="Logs" className="pane-padding">
          {logs ? (
            <>
              <Badge variant="outline">Synthetic scenario logs</Badge>
              <pre className="log-output">{logs.join("\n")}</pre>
              <p className="muted">
                These logs belong to the exercise, not the source cluster.
              </p>
            </>
          ) : (
            <div className="empty">
              <strong>
                {["Pod", "Deployment"].includes(resource.kind)
                  ? "Logs unavailable"
                  : "This resource has no container logs"}
              </strong>
              <p>
                Logs were omitted from the capture. Unavailable is not a healthy
                empty log.
              </p>
            </div>
          )}
        </TabsContent>
      </Tabs>
      {exercise && (
        <div className="hints">
          <Button variant="ghost" size="sm" onClick={onHint}>
            <Lightbulb size={15} />
            Request hint{" "}
            {exercise.hintsRevealed ? `(${exercise.hintsRevealed}/3)` : ""}
          </Button>
          {exercise.hintsRevealed > 0 && (
            <p>
              {
                incidents.find((i) => i.id === exercise.scenario)!.hints[
                  exercise.hintsRevealed - 1
                ]
              }
            </p>
          )}
        </div>
      )}
    </aside>
  );
}
