"use client";
import { useState, useRef, useEffect } from "react";
import { stringify } from "yaml";
import { Lightbulb, Box, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { RelationshipEvidence } from "./inspector/RelationshipEvidence";
import { resourcePresentation } from "@/lib/domain/presentation";
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
import {
  configurationDifferences,
  resourceAge,
  conditionSummary,
} from "@/lib/ui/inspection";
export function ResourceInspector({
  resource,
  source,
  files,
  exercise,
  tab,
  onTab,
  onSelect,
  onEdit,
  onHint,
  diagnostics,
  relationships,
  resources,
  editorContexts,
  onClose,
  focusRelationship,
  draftDirty,
  onSave,
  onRevert,
  onExportDraft,
}: {
  resource: Resource;
  source: Snapshot;
  files: SourceFile[];
  exercise: Exercise | null;
  tab: string;
  onTab: (t: string) => void;
  onSelect: (id: string) => void;
  onEdit: (id: string, value: string) => void;
  onHint: () => void;
  diagnostics: Diagnostic[];
  relationships: Relationship[];
  resources: Resource[];
  onClose?: () => void;
  focusRelationship?: string | null;
  draftDirty?: boolean;
  onSave?: () => void;
  onRevert?: () => void;
  onExportDraft?: () => void;
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
  const differences =
    file && displayed ? configurationDifferences(resource.raw, displayed) : [];
  useEffect(() => {
    if (tab === "Diff" && !differences.length) onTab("Overview");
  }, [tab, differences.length, onTab]);
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
      <Tabs
        value={tab === "Diff" && !differences.length ? "Overview" : tab}
        onValueChange={onTab}
      >
        <TabsList className="inspector-tabs">
          {[
            "Overview",
            "YAML",
            "Events",
            "Logs",
            "Relationships",
            ...(differences.length ? ["Diff"] : []),
          ].map((t) => (
            <TabsTrigger key={t} value={t}>
              {t === "Diff" ? "Changes" : t}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="Overview" className="pane-padding">
          <dl className="facts">
            <dt>UID</dt>
            <dd className="break-all">{uid || "Not captured"}</dd>
            <dt>Age</dt>
            <dd>{resourceAge(displayed, source.captureEndedAt)}</dd>
            <dt>Observed</dt>
            <dd>{source.captureEndedAt || "Unavailable"}</dd>
          </dl>
          {!!source.renderProvenance?.length && (
            <details className="mt-3">
              <summary className="cursor-pointer">Render provenance</summary>
              {source.renderProvenance.map((proof, i) => (
                <dl key={i} className="facts text-xs">
                  <dt>Input</dt>
                  <dd>
                    {proof.repository ?? "Local"} / {proof.path}{" "}
                    {proof.ref ?? ""}
                  </dd>
                  <dt>Renderer</dt>
                  <dd>
                    {proof.renderer} {proof.version}
                  </dd>
                  <dt>Options</dt>
                  <dd>
                    Release {proof.release ?? "—"} · namespace{" "}
                    {proof.namespace ?? "—"} · Kubernetes{" "}
                    {proof.kubernetesVersion ?? "default capabilities"}
                  </dd>
                  {proof.values.map((v, i) => (
                    <div key={i} className="col-span-2 break-all">
                      Values {i + 1}: {v.path} · SHA256 {v.sha256}
                    </div>
                  ))}
                  <dt>Templates</dt>
                  <dd>{proof.sourceMappings.join(", ")}</dd>
                </dl>
              ))}
            </details>
          )}
          {conditionSummary(displayed).map((c) => (
            <p key={c} className="text-sm">
              {c}
            </p>
          ))}
          {list(
            at(displayed ?? resource.raw, "metadata", "ownerReferences"),
          ).map((o) => {
            const target = resources.find(
              (r) =>
                at(capturedResource(source, r) ?? r.raw, "metadata", "uid") ===
                o.uid,
            );
            return (
              <div key={String(o.uid)} className="text-sm">
                Owner {text(o.kind)} / {text(o.name)}{" "}
                {target ? (
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => onSelect(target.id)}
                  >
                    Inspect owner
                  </Button>
                ) : (
                  " · not captured"
                )}
              </div>
            );
          })}
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
          {resource.kind !== "Deployment" && (
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
                                  (e) =>
                                    at(e, "conditions", "ready") === true &&
                                    at(e, "conditions", "terminating") !== true,
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
          )}
        </TabsContent>
        <TabsContent value="YAML" className="yaml-pane">
          {file && onSave && (
            <div className="flex gap-2 p-2 flex-wrap items-center">
              <span className="text-xs">
                {draftDirty ? "Unsaved draft" : "Saved draft"}
              </span>
              <Button
                size="sm"
                onClick={onSave}
                disabled={!draftDirty || !!diagnostics.length}
              >
                Save draft
              </Button>
              <Button
                size="sm"
                variant="outline"
                onClick={onRevert}
                disabled={!draftDirty}
              >
                Revert
              </Button>
              <Button size="sm" variant="ghost" onClick={onExportDraft}>
                Export draft
              </Button>
            </div>
          )}
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
                ? null
                : "No original authored file is available."}
          </div>
        </TabsContent>
        <TabsContent value="Relationships" className="pane-padding">
          <RelationshipEvidence
            relationships={relationships}
            resources={resources}
            resourceId={resource.id}
            onResource={onSelect}
            files={files}
            focusId={focusRelationship}
            onEvidence={(ref) => {
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
        <TabsContent value="Diff" className="pane-padding">
          <h3>Changes from your manifest</h3>
          {differences.map((difference) => (
            <div className="event" key={difference.path}>
              <strong>{difference.path}</strong>
              <pre className="whitespace-pre-wrap break-all">{`Manifest: ${JSON.stringify(difference.desired) ?? "(absent)"}\nSnapshot: ${JSON.stringify(difference.observed) ?? "(absent)"}`}</pre>
            </div>
          ))}
        </TabsContent>
        <TabsContent value="Events" className="pane-padding">
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
                    : "No events recorded"}
              </strong>
              <p>
                {exercise
                  ? "Select the affected Pod for kubelet evidence."
                  : source.origin === "bundled"
                    ? "This example has no recorded events. Open Practice to create a live local lab."
                    : source.origin === "manifests"
                      ? "Manifests contain configuration. Open Practice to see events from a local lab."
                      : "No events were included for this resource in the snapshot."}
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
                  ? "No logs recorded"
                  : "This resource has no container logs"}
              </strong>
              <p>
                {["Pod", "Deployment"].includes(resource.kind)
                  ? "Open Practice to create a local lab and view container logs."
                  : "Select a Pod to view container logs."}
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
