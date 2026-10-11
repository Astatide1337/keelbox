"use client";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import { targetKey } from "@/lib/domain/generated-incident";
import { QuestionDialog } from "../auth/QuestionDialog";
import { resourceKey } from "@/lib/domain/types";
import { LocalImages } from "./LocalImages";
import { GenerateIncident } from "./GenerateIncident";
import { useState, useEffect, useMemo, useRef } from "react";
import { stringify } from "yaml";
import { useAccount } from "../auth/AccountProvider";
import { Button } from "../ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "../ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "../ui/tabs";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "../ui/resizable";
import { SourceEditor } from "../workspace/SourceEditor";
import { ResourceGraph } from "../workspace/ResourceGraph";
import { parseSources } from "@/lib/domain/importer";
import { analyze } from "@/lib/domain/analyzer";
import {
  at,
  list,
  text,
  type Resource,
  type Observation,
} from "@/lib/domain/types";
import type { Snapshot } from "@/lib/domain/snapshot";
import type { DeploymentPlan } from "@/lib/domain/deployment-plan";
import type { LiveLab } from "@/lib/server/minikube-runtime";
import type { CacheStatus, LogBuffer } from "@/lib/server/observations/cache";
type View = {
  plan: DeploymentPlan | null;
  lab:
    | (Omit<LiveLab, "target" | "operations"> & {
        terminal: string;
        evidence: {
          resources: Record<string, unknown>[];
          events: Record<string, unknown>[];
          status: CacheStatus[];
          receivedAt: string | null;
        };
      })
    | null;
};
const retainedLabDrafts = new Map<
  string,
  {
    draft: string;
    selected: string | null;
    tab: string;
    dirty: boolean;
    revision: string;
    positions: Record<string, { x: number; y: number }>;
  }
>();
export function LivePractice({
  project,
  destination = "Practice",
}: {
  project: Snapshot;
  destination?: string;
}) {
  const practice = destination === "Practice";
  const [incidentTarget, setIncidentTarget] = useState("");
  const [questionOpen, setQuestionOpen] = useState(false);
  const account = useAccount();
  const accountKey = account.status?.profile?.key ?? "development";
  const retained = useRef(retainedLabDrafts.get(accountKey)).current;
  const { request } = account,
    [view, setView] = useState<View>({ plan: null, lab: null }),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [draft, setDraft] = useState(retained?.draft ?? ""),
    [selected, select] = useState<string | null>(retained?.selected ?? null),
    [tab, setTab] = useState(retained?.tab ?? "overview"),
    [hint, setHint] = useState(0),
    [logs, setLogs] = useState<LogBuffer | null>(null),
    [kind, setKind] = useState("all"),
    [controllers, setControllers] = useState(true);
  const dirty = useRef(retained?.dirty ?? false),
    revision = useRef(retained?.revision ?? ""),
    alive = useRef(true),
    positions = useRef<Record<string, { x: number; y: number }>>(
      retained?.positions ?? {},
    );
  useEffect(() => {
    retainedLabDrafts.set(accountKey, {
      draft,
      selected,
      tab,
      dirty: dirty.current,
      revision: revision.current,
      positions: positions.current,
    });
  }, [accountKey, draft, selected, tab]);
  const pendingApply = useRef<{ id: string; revision: number } | null>(null);
  const update = (data: View) => {
    if (!alive.current) return;
    setView(data);
    if (
      pendingApply.current &&
      data.lab?.id === pendingApply.current.id &&
      data.lab.revision > pendingApply.current.revision
    ) {
      dirty.current = false;
      pendingApply.current = null;
    }
    const key =
      data.lab?.id + ":" + data.lab?.generation + ":" + data.lab?.revision;
    if (key !== revision.current && !dirty.current) {
      setDraft(data.lab?.source ?? "");
      revision.current = key;
    }
  };
  useEffect(() => {
    alive.current = true;
    let polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        const r = await request("/api/lab");
        const data = await r.json();
        if (!r.ok) throw Error(data.error);
        update(data);
      } catch (e) {
        if (alive.current) setError((e as Error).message);
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [request]);
  async function action(kind: string, extra: Record<string, unknown> = {}) {
    setPending(true);
    setError("");
    try {
      const lab = view.lab;
      if (kind === "apply" && lab)
        pendingApply.current = { id: lab.id, revision: lab.revision };
      const body = {
        kind,
        ...(["plan", "create"].includes(kind)
          ? {}
          : {
              operationId: crypto.randomUUID(),
              sessionId: lab?.id,
              generation: lab?.generation,
              revision: lab?.revision,
            }),
        ...extra,
      };
      const r = await request("/api/lab", {
        method: "POST",
        body: JSON.stringify(body),
      });
      const data = await r.json();
      if (!r.ok) throw Error(data.error);
      if (kind === "reset") {
        dirty.current = false;
        revision.current = "";
      }
      if (kind === "reset") {
        setHint(0);
        setLogs(null);
        select(null);
      }
      update(data);
    } catch (e) {
      pendingApply.current = null;
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  const lab = view.lab,
    busy = pending || !!lab?.operation;
  const parsed = useMemo(
    () =>
      parseSources([
        {
          id: "live",
          name: "Live Kubernetes response",
          content: (lab?.evidence.resources ?? [])
            .map((r) => stringify(r))
            .join("---\n"),
        },
      ]),
    [lab?.evidence.resources],
  );
  const resources = useMemo(
    () =>
      parsed.resources
        .filter(
          (r) =>
            !["waypoint-ownership", "kube-root-ca.crt"].includes(r.name) &&
            !r.name.startsWith("waypoint-check-"),
        )
        .map((r) => ({
          ...r,
          id: text(at(r.raw, "metadata", "uid")) || r.id,
        })),
    [parsed],
  );
  const analysis = useMemo(() => analyze(resources), [resources]);
  const resource = resources.find((r) => r.id === selected) ?? null;
  const stale =
    !!lab &&
    (!lab.evidence.status.length ||
      lab.evidence.status.some((s) => s.state !== "current"));
  const draftParsed = useMemo(
    () => parseSources([{ id: "draft", name: "Lab repair", content: draft }]),
    [draft],
  );
  const authored =
    resource &&
    draftParsed.resources.find(
      (r) =>
        r.kind === resource.kind &&
        r.name === resource.name &&
        r.namespace === resource.namespace,
    );
  const selectedSource = authored?.source;
  const draftErrors = useMemo(
    () =>
      draft
        ? parseSources([{ id: "draft", name: "Lab repair", content: draft }])
            .diagnostics
        : [],
    [draft],
  );
  const observation: Observation | null = lab
    ? {
        sessionId: lab.id,
        generation: lab.generation,
        revision: lab.revision,
        sequence: 0,
        resources: lab.evidence.resources,
        capturedAt: lab.evidence.receivedAt ?? "",
        errors: lab.evidence.status.filter((s) => s.error).map((s) => s.error!),
      }
    : null;
  const displayed = resources.filter(
    (r) =>
      (kind === "all" || r.kind === kind) &&
      (controllers || !["ReplicaSet", "EndpointSlice"].includes(r.kind)),
  );
  const stream = resource?.kind === "Pod" ? resource : null;
  const container = stream
    ? text(at(stream.raw, "spec", "containers", "0", "name"))
    : "";
  useEffect(() => {
    setLogs(null);
    if (tab !== "logs" || !stream || !container) return;
    let stopped = false;
    const uid = stream.id;
    const read = async () => {
      try {
        const r = await request("/api/lab", {
          method: "POST",
          body: JSON.stringify({ kind: "logs", uid, container }),
        });
        const data = await r.json();
        if (!stopped) {
          if (r.ok) setLogs(data.logs);
          else setError(data.error);
        }
      } catch (e) {
        if (!stopped) setError((e as Error).message);
      }
    };
    void read();
    const timer = setInterval(read, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
      void request("/api/lab", {
        method: "POST",
        body: JSON.stringify({ kind: "closeLogs", uid, container }),
      }).catch(() => {});
    };
  }, [tab, stream?.id, container, request, lab?.generation]);
  if (!lab || lab.phase === "stopped")
    return (
      <div className="catalog">
        <Card>
          <CardHeader>
            <CardTitle>Prepare a local application</CardTitle>
            <CardDescription>
              Review {project.label} before deploying it to a private Waypoint
              Minikube cluster.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Button
              disabled={pending}
              onClick={() => action("plan", { project })}
            >
              Review deployment
            </Button>
          </CardContent>
        </Card>
        {error && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
        {view.plan && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle>Deployment review</CardTitle>
            </CardHeader>
            <CardContent>
              <LocalImages
                project={project}
                onSaved={() => void action("plan", { project })}
              />
              <Tabs defaultValue="changes">
                <TabsList>
                  <TabsTrigger value="changes">Changes</TabsTrigger>
                  <TabsTrigger value="yaml">Deployment YAML</TabsTrigger>
                  <TabsTrigger value="effects">Cluster effects</TabsTrigger>
                </TabsList>
                <TabsContent value="changes">
                  <ul className="my-4 space-y-2">
                    {view.plan.changes.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ul>
                </TabsContent>
                <TabsContent value="yaml">
                  <div style={{ height: 350, overflow: "hidden" }}>
                    <SourceEditor
                      value={view.plan.source}
                      onChange={() => {}}
                      ranges={[]}
                      readOnly
                    />
                  </div>
                </TabsContent>
                <TabsContent value="effects">
                  <p className="my-4">
                    Creates one dedicated Minikube Docker profile, private
                    kubeconfig and namespace (2 CPUs, 4 GiB). Your normal
                    context and source cluster remain unchanged. Trusted
                    developer inputs only; this is not a hostile-workload
                    sandbox.
                    {view.plan.needsIngress &&
                      " Installs the local nginx ingress controller."}
                    {view.plan.needsVault &&
                      " Installs the official HashiCorp Vault development server and Agent injector with local test data and cluster-local authentication."}
                  </p>
                </TabsContent>
              </Tabs>
              {view.plan.blockers.length > 0 && (
                <ul role="alert" className="my-4 text-destructive">
                  {view.plan.blockers.map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              )}
              {!view.plan.contract && (
                <p className="my-4">
                  This application can be deployed and inspected. Probe
                  incidents require an HTTP readiness probe and a selecting
                  Service; no compatible incident is available in this plan.
                </p>
              )}
              <Button
                disabled={pending || !!view.plan.blockers.length}
                onClick={() =>
                  action("create", { planHash: view.plan!.planHash })
                }
              >
                Create local lab
              </Button>
            </CardContent>
          </Card>
        )}
      </div>
    );
  return (
    <div className="live-practice">
      <div className="lab-strip">
        <div>
          <strong>
            {lab.incident === "liveness"
              ? "Liveness investigation"
              : false
                ? "Gateway HTTP 503 investigation"
                : lab.incident === "readiness"
                  ? "Readiness investigation"
                  : "Local application"}
          </strong>
          <span>
            {lab.phase} {lab.operation ? "· " + lab.operation : ""} ·{" "}
            {lab.namespace}
          </span>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              dirty.current = false;
              action("reset");
            }}
          >
            Reset baseline
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => action("cleanup")}
          >
            Clean up lab
          </Button>
        </div>
      </div>
      {lab.phase === "failed" && (
        <Button
          disabled={busy}
          variant="outline"
          onClick={() => action("recover")}
        >
          Retry owned lab preparation
        </Button>
      )}
      {(error || lab.error) && (
        <p role="alert" className="notice">
          {error || lab.error}
        </p>
      )}
      {stale && (
        <p role="status" className="notice">
          Live evidence is connecting or stale.{" "}
          {lab.evidence.status
            .filter((s) => s.state !== "current")
            .map((s) => `${s.kind}: ${s.error ?? s.state}`)
            .join(" · ")}
        </p>
      )}
      {lab.phase === "preparing" && (
        <p className="p-6">
          Preparing the owned cluster and proving a healthy baseline. This can
          take several minutes. Actual failures will appear here.
        </p>
      )}
      {practice && lab.phase === "ready" && (
        <div className="incident-grid">
          <div className="col-span-full">
            <Select
              value={
                incidentTarget ||
                (lab.plan.contract
                  ? targetKey(lab.plan.contract, lab.namespace)
                  : "")
              }
              onValueChange={setIncidentTarget}
            >
              <SelectTrigger aria-label="Practice workload">
                <SelectValue placeholder="Choose a workload" />
              </SelectTrigger>
              <SelectContent>
                {(lab.plan.contracts ?? []).map((c) => (
                  <SelectItem
                    key={targetKey(c, lab.namespace)}
                    value={targetKey(c, lab.namespace)}
                  >
                    {c.deployment} / {c.container} · {c.namespace}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <GenerateIncident
            key={[lab.id, lab.generation, lab.revision].join(":")}
            lab={lab}
            busy={busy || stale}
            onStart={(recipe, id) =>
              action("incident", {
                incident: recipe.incident,
                target: recipe.target,
                proposalId: id,
              })
            }
          />
          <Card>
            <CardHeader>
              <CardTitle>Readiness probe failure</CardTitle>
              <CardDescription>
                A process runs but its Pods stop becoming ready. Restore the
                intended replicas and Service traffic.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                disabled={busy || stale || !lab.plan.contract}
                onClick={() =>
                  action("incident", {
                    incident: "readiness",
                    target: incidentTarget || undefined,
                  })
                }
              >
                Start readiness investigation
              </Button>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Liveness probe failure</CardTitle>
              <CardDescription>
                Investigate kubelet failures and container restarts.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                disabled={
                  busy ||
                  stale ||
                  !(lab.plan.contracts ?? []).find(
                    (c) =>
                      targetKey(c, lab.namespace) ===
                      (incidentTarget ||
                        (lab.plan.contract
                          ? targetKey(lab.plan.contract, lab.namespace)
                          : "")),
                  )?.livenessPath
                }
                onClick={() =>
                  action("incident", {
                    incident: "liveness",
                    target: incidentTarget || undefined,
                  })
                }
              >
                Start liveness investigation
              </Button>
              {!(lab.plan.contracts ?? []).find(
                (c) =>
                  targetKey(c, lab.namespace) ===
                  (incidentTarget ||
                    (lab.plan.contract
                      ? targetKey(lab.plan.contract, lab.namespace)
                      : "")),
              )?.livenessPath && (
                <p className="mt-3">Requires an HTTP liveness probe.</p>
              )}
            </CardContent>
          </Card>
        </div>
      )}
      {practice && lab.incident && (
        <div className="lab-strip">
          <p>
            {lab.recipe?.objective ??
              "Restore required probes, healthy replicas and an HTTP request through the Service."}
          </p>
          <div className="flex gap-2">
            <Button
              variant="outline"
              onClick={() => setHint((h) => Math.min(h + 1, 3))}
            >
              Hint
            </Button>
            <Button
              disabled={busy || stale || dirty.current}
              onClick={() => action("check")}
            >
              Check recovery
            </Button>
          </div>
        </div>
      )}
      {practice && hint > 0 && (
        <p className="p-3 text-muted-foreground">
          {
            (lab.recipe
              ? ["", ...lab.recipe.hints]
              : [
                  "",
                  "Inspect Pod conditions and recent kubelet events. Restart counts alone do not explain their cause.",
                  false
                    ? "Compare the gateway upstream, backend Service selector and ready EndpointSlices."
                    : "Compare the HTTP probe path with application access logs and the immutable healthy baseline.",
                  false
                    ? "Restore the backend Service selector. Keep the gateway and required backend replicas."
                    : "Restore the original working probe path; keep the probe, replicas, image and configuration.",
                ])[hint]
          }
        </p>
      )}
      {practice && lab.checks.length > 0 && (
        <ul className="lab-checks">
          {lab.checks.map((c, i) => (
            <li key={i} className={c.passed ? "pass" : ""}>
              {c.passed ? "✓" : "×"} {c.name}
              <details>
                <summary>Evidence</summary>
                <pre>{c.detail}</pre>
              </details>
            </li>
          ))}
        </ul>
      )}
      {practice && lab.phase === "completed" && (
        <p className="notice pass">
          Recovery verified in the owned cluster. Required replicas,
          configuration, ready Service backends and an in-cluster HTTP request
          passed. Reset restores the healthy baseline before repeating the
          exercise.
        </p>
      )}
      <div className="lab-strip">
        <Button variant="outline" onClick={() => setControllers((c) => !c)}>
          {controllers
            ? "Collapse controller detail"
            : "Show controller detail"}
        </Button>
        <label>
          Kind{" "}
          <select
            aria-label="Lab resource kind"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="all">All kinds</option>
            {[...new Set(resources.map((r) => r.kind))].map((k) => (
              <option key={k}>{k}</option>
            ))}
          </select>
        </label>
        <span className="text-muted-foreground">
          Actual lab observations · source import unchanged
        </span>
      </div>
      <ResizablePanelGroup className="lab-panels" orientation="horizontal">
        <ResizablePanel defaultSize="18%" minSize="12%">
          <nav className="resource-tree" aria-label="Application resource tree">
            <strong>{project.label}</strong>
            <details open>
              <summary>{lab.namespace}</summary>
              {resources
                .filter(
                  (r) =>
                    !list(at(r.raw, "metadata", "ownerReferences")).some((o) =>
                      resources.some(
                        (p) => at(p.raw, "metadata", "uid") === o.uid,
                      ),
                    ),
                )
                .map((r) => (
                  <Tree
                    key={r.id}
                    resource={r}
                    resources={resources}
                    selected={selected}
                    select={select}
                    detail={controllers}
                  />
                ))}
            </details>
          </nav>
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="49%" minSize="25%">
          {destination === "Resources" ? (
            <div className="live-resource-list">
              {displayed.map((r) => (
                <Button
                  key={r.id}
                  variant="ghost"
                  className="tree-resource"
                  aria-pressed={selected === r.id}
                  onClick={() => select(r.id)}
                >
                  {r.kind} / {r.name}
                </Button>
              ))}
            </div>
          ) : destination === "Events" ? (
            <div className="live-event-list">
              {lab.evidence.events.map((e) => (
                <button
                  className="live-event text-left w-full"
                  key={text(at(e, "metadata", "uid"))}
                  onClick={() => {
                    select(text(at(e, "involvedObject", "uid")));
                    setTab("events");
                  }}
                >
                  <strong>
                    {text(e.type)} · {text(e.reason)}
                  </strong>
                  <p>{text(e.message)}</p>
                  <small>
                    {text(e.lastTimestamp)} ·{" "}
                    {text(at(e, "involvedObject", "name"))}
                  </small>
                </button>
              ))}
            </div>
          ) : destination === "Manifest files" ? (
            <div className="lab-editor">
              <SourceEditor
                value={draft}
                onChange={(v) => {
                  dirty.current = true;
                  setDraft(v);
                }}
                ranges={[]}
                contextKey={lab.id}
              />
            </div>
          ) : (
            <ResourceGraph
              resources={displayed}
              relationships={analysis.relationships.filter(
                (e) =>
                  displayed.some((r) => r.id === e.from) &&
                  (!e.to || displayed.some((r) => r.id === e.to)),
              )}
              selected={selected}
              onSelect={select}
              onRelationship={() => setTab("relationships")}
              observation={observation}
              stale={stale}
              endpointCoverage={() => !stale}
              initialPositions={positions.current}
              onPositionsChange={(p) => {
                positions.current = p;
              }}
              provenance={
                stale ? "Last received lab state · stale" : "Live lab state"
              }
            />
          )}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel defaultSize="33%" minSize="25%">
          <section className="live-inspector">
            {account.status?.planEnabled && resource && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => setQuestionOpen(true)}
              >
                Ask ChatGPT
              </Button>
            )}
            <QuestionDialog
              open={questionOpen}
              onOpenChange={setQuestionOpen}
              title="Ask about this lab resource"
              evidenceKey={[
                lab.id,
                lab.generation,
                lab.revision,
                selected,
              ].join(":")}
              scope={{
                labId: lab.id,
                labGeneration: lab.generation,
                labRevision: lab.revision,
                resourceId: selected ?? undefined,
              }}
              disabledReason={
                stale
                  ? "Reconnect before asking about live state."
                  : busy
                    ? "Wait for the lab operation to finish."
                    : ""
              }
              prepare={async () => undefined}
              onEvidence={(id) => {
                const current = resources.find(
                  (r) =>
                    resourceKey(r.kind, r.namespace, r.name, r.apiVersion) ===
                    id,
                );
                if (current) select(current.id);
              }}
            />
            <h2>
              {resource
                ? `${resource.kind} / ${resource.name}`
                : "Select a resource"}
            </h2>
            {selected && !resource && (
              <p role="status">
                This resource UID is no longer present. Select its replacement
                in the tree; earlier evidence belongs to the old resource.
              </p>
            )}
            <Tabs value={tab} onValueChange={setTab}>
              <TabsList variant="line">
                <TabsTrigger value="overview">Overview</TabsTrigger>
                <TabsTrigger value="yaml">YAML</TabsTrigger>
                <TabsTrigger value="events">Events</TabsTrigger>
                <TabsTrigger value="logs">Logs</TabsTrigger>
                <TabsTrigger value="relationships">Relationships</TabsTrigger>
              </TabsList>
              <TabsContent value="overview">
                {resource && (
                  <>
                    <dl>
                      <dt>UID</dt>
                      <dd>{resource.id}</dd>
                      <dt>Namespace</dt>
                      <dd>{resource.namespace}</dd>
                      <dt>Observation</dt>
                      <dd>{stale ? "Stale / unknown" : "Live"}</dd>
                    </dl>
                    <details>
                      <summary>Raw status and UID</summary>
                      <p>{resource.id}</p>
                      <pre>{stringify(resource.raw.status ?? {})}</pre>
                    </details>
                  </>
                )}
              </TabsContent>
              <TabsContent value="yaml">
                <Tabs defaultValue="repair">
                  <TabsList>
                    <TabsTrigger value="repair">Lab repair</TabsTrigger>
                    <TabsTrigger value="observed">Observed YAML</TabsTrigger>
                    <TabsTrigger value="baseline">Healthy baseline</TabsTrigger>
                  </TabsList>
                  <TabsContent value="repair">
                    <div className="lab-editor">
                      <SourceEditor
                        value={draft}
                        onChange={(v) => {
                          dirty.current = true;
                          setDraft(v);
                        }}
                        ranges={[]}
                        contextKey={lab.id}
                      />
                    </div>
                    {draftErrors.map((d) => (
                      <p role="alert" key={d.line}>
                        Line {d.line}: {d.message}. Draft retained; previous
                        graph unchanged.
                      </p>
                    ))}
                    <Button
                      disabled={busy || !!draftErrors.length || !dirty.current}
                      onClick={() => action("apply", { source: draft })}
                    >
                      Apply repair
                    </Button>
                  </TabsContent>
                  <TabsContent value="observed">
                    <div className="lab-editor">
                      <SourceEditor
                        value={resource ? stringify(resource.raw) : ""}
                        onChange={() => {}}
                        ranges={[]}
                        readOnly
                      />
                    </div>
                    <p className="text-muted-foreground">
                      Live API response; not an authored manifest file.
                    </p>
                  </TabsContent>
                  <TabsContent value="baseline">
                    <div className="lab-editor">
                      <SourceEditor
                        value={lab.plan.source}
                        onChange={() => {}}
                        ranges={[]}
                        readOnly
                      />
                    </div>
                  </TabsContent>
                </Tabs>
              </TabsContent>
              <TabsContent value="events">
                {lab.evidence.events
                  .filter(
                    (e) =>
                      !selected || at(e, "involvedObject", "uid") === selected,
                  )
                  .map((e) => (
                    <article
                      key={text(at(e, "metadata", "uid"))}
                      className="live-event"
                    >
                      <strong>
                        {text(e.type)} · {text(e.reason)}
                      </strong>
                      <p>{text(e.message)}</p>
                      <small>
                        {text(e.lastTimestamp) ||
                          text(at(e, "metadata", "creationTimestamp"))}{" "}
                        · {text(at(e, "source", "component"))}
                      </small>
                    </article>
                  ))}
                {!lab.evidence.events.some(
                  (e) =>
                    !selected || at(e, "involvedObject", "uid") === selected,
                ) && (
                  <p>
                    No events in the available recent window for this resource.
                  </p>
                )}
              </TabsContent>
              <TabsContent value="logs">
                {stream ? (
                  <>
                    <p>
                      {stream.name} / {container}
                    </p>
                    <p className="text-muted-foreground">
                      Selected container only · bounded recent window
                    </p>
                    {logs ? (
                      <>
                        <pre className="live-log">{logs.lines.join("\n")}</pre>
                        <p>
                          {logs.state}
                          {logs.truncated ? " · truncated" : ""} {logs.error}
                        </p>
                        {logs.gaps.map((g) => (
                          <p key={g} className="text-muted-foreground">
                            {g}
                          </p>
                        ))}
                        {logs.previous && (
                          <details>
                            <summary>Previous container logs</summary>
                            <pre>{logs.previous}</pre>
                          </details>
                        )}
                      </>
                    ) : (
                      <p>Connecting log stream…</p>
                    )}
                  </>
                ) : (
                  <p>
                    Select a Pod to follow one container’s logs. Controller and
                    Service resources do not have container logs.
                  </p>
                )}
              </TabsContent>
              <TabsContent value="relationships">
                {analysis.relationships
                  .filter((e) => e.from === selected || e.to === selected)
                  .map((e) => (
                    <article key={e.id} className="live-event">
                      <strong>{e.title}</strong>
                      <p>{e.explanation}</p>
                      <Button
                        variant="link"
                        onClick={() =>
                          select(e.from === selected ? e.to : e.from)
                        }
                      >
                        Select related resource
                      </Button>
                    </article>
                  ))}
              </TabsContent>
            </Tabs>
          </section>
        </ResizablePanel>
      </ResizablePanelGroup>
      <details className="lab-terminal">
        <summary>Use your terminal</summary>
        <pre>
          {lab.terminal} get pods,services,endpointslices{"\n"}
          {lab.terminal} edit deployment/{lab.plan.contract?.deployment}
        </pre>
        <p>
          Your host shell is unrestricted. These commands explicitly target the
          owned lab; do not switch your normal context.
        </p>
      </details>
    </div>
  );
}
function Tree({
  resource,
  resources,
  selected,
  select,
  detail,
}: {
  resource: Resource;
  resources: Resource[];
  selected: string | null;
  select: (id: string) => void;
  detail: boolean;
}) {
  const children = resources.filter((r) =>
    list(at(r.raw, "metadata", "ownerReferences")).some(
      (o) => o.uid === resource.id,
    ),
  );
  return (
    <div>
      <Button
        variant="ghost"
        className="tree-resource"
        aria-pressed={selected === resource.id}
        onClick={() => select(resource.id)}
      >
        {resource.kind} / {resource.name}
      </Button>
      {(detail || resource.kind === "Deployment") &&
        children.map((c) =>
          detail ? (
            <div className="tree-child" key={c.id}>
              <Tree
                resource={c}
                resources={resources}
                selected={selected}
                select={select}
                detail={detail}
              />
            </div>
          ) : (
            <span key={c.id} className="text-muted-foreground">
              {" "}
              {children.length} controller(s)
            </span>
          ),
        )}
    </div>
  );
}
