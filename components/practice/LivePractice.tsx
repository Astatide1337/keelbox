"use client";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "../ui/select";
import {
  acceptsObservation,
  type ObservationIdentity,
} from "@/lib/practice/live-observation";
import { observationFreshness } from "@/lib/domain/freshness";
import { snapshotDigest } from "@/lib/domain/snapshot";
import { LearningJourney } from "./LearningJourney";
import {
  emptyProgress,
  restoreProgress,
  learningKey,
  lessonCopy,
  summarizeEvidence,
  type LearningProgress,
  type LearningContext,
} from "@/lib/practice/live-learning";
import type { Relationship } from "@/lib/domain/types";
import { targetKey } from "@/lib/domain/contract-target";
import {
  applicableIncidents,
  incidentChoice,
  type LiveIncidentChoice,
} from "@/lib/domain/live-incidents";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "../ui/dialog";
import {
  conditionSummary,
  resourceAge,
  configurationDifferences,
} from "@/lib/ui/inspection";
import { QuestionDialog } from "../auth/QuestionDialog";
import { resourceKey } from "@/lib/domain/types";
import { resourcePresentation } from "@/lib/domain/presentation";
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
  resetPreview?: {
    details: string[];
    preservesVolumeData: boolean;
    recreatesJobs: boolean;
    runsCronJobs: boolean;
  } | null;
  scheduledExecutions?: {
    target: string;
    name: string;
    state: string;
    detail: string;
  }[];
  lab:
    | (Omit<LiveLab, "target" | "operations"> & {
        terminal: string;
        evidence: {
          resources: Record<string, unknown>[];
          events: Record<string, unknown>[];
          status: CacheStatus[];
          connection?: {
            state: "connecting" | "stale" | "current";
            lastObservation: string | null;
            reasons: string[];
          };
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
const exerciseDescriptions: Record<LiveIncidentChoice["id"], string> = {
  readiness: "A running app stops receiving traffic.",
  liveness: "A failing health check repeatedly restarts a container.",
  "service-selector": "A Service loses its connection to healthy Pods.",
  "service-target-port": "Traffic is sent to the wrong container port.",
  "image-pull": "A Pod cannot start with its configured image.",
  "configmap-key": "A required configuration value is missing.",
  "market-data-stale": "The app stays alive while its quotes stop updating.",
};
export function LivePractice({
  project,
  destination = "Practice",
  onContext,
  askRequest = 0,
}: {
  project: Snapshot;
  destination?: string;
  onContext?: (value: {
    scope: {
      labId?: string;
      labGeneration?: number;
      labRevision?: number;
      resourceId?: string;
      relationshipId?: string;
      learning?: LearningContext;
    };
    evidenceKey: string;
    stale: boolean;
    available: boolean;
  }) => void;
  askRequest?: number;
}) {
  const practice = destination === "Practice";
  const [incidentTarget, setIncidentTarget] = useState("");
  const [reviewOperation, setReviewOperation] = useState<{
    kind: "reset" | "cleanup" | "run-cronjob";
    target?: string;
  } | null>(null);
  const [questionOpen, setQuestionOpen] = useState(false);
  const account = useAccount();
  const accountKey = account.status?.profile?.key ?? "development";
  const sourceDigest = useMemo(() => snapshotDigest(project), [project]);
  const [projectFileHash, setProjectFileHash] = useState("");
  useEffect(() => {
    let active = true;
    setProjectFileHash("");
    void crypto.subtle
      .digest(
        "SHA-256",
        new TextEncoder().encode(JSON.stringify(project.files)),
      )
      .then((buffer) => {
        if (active)
          setProjectFileHash(
            [...new Uint8Array(buffer)]
              .map((n) => n.toString(16).padStart(2, "0"))
              .join(""),
          );
      });
    return () => {
      active = false;
    };
  }, [sourceDigest]);
  const [loadedNotebook, setLoadedNotebook] = useState("");
  const [progress, setProgress] = useState<LearningProgress>(emptyProgress);
  const [transport, setTransport] = useState<{
    state: "connecting" | "current" | "disconnected";
    lastSuccess: string | null;
    reason: string;
  }>({
    state: "connecting",
    lastSuccess: null,
    reason: "Connecting to local runtime",
  });
  const [pollEpoch, setPollEpoch] = useState(0);
  const [revealedFilters, setRevealedFilters] = useState<{
    kind: string;
    controllers: boolean;
  } | null>(null);
  const [helpField, setHelpField] = useState<string | undefined>(undefined);
  const [selectedEdge, setSelectedEdge] = useState<Relationship | null>(null);
  const notebookScope = useRef("");
  const [projectQuestion, setProjectQuestion] = useState(false);
  const initialAsk = useRef(askRequest);
  useEffect(() => {
    if (askRequest !== initialAsk.current) {
      initialAsk.current = askRequest;
      setProjectQuestion(true);
      setHelpField(undefined);
      setQuestionOpen(true);
    }
  }, [askRequest]);
  const { request } = account,
    [view, setView] = useState<View>({ plan: null, lab: null }),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false),
    [draft, setDraft] = useState(""),
    [selected, selectResource] = useState<string | null>(null),
    [tab, setTab] = useState("overview"),
    [logs, setLogs] = useState<LogBuffer | null>(null),
    [kind, setKind] = useState("all"),
    [controllers, setControllers] = useState(true);
  const [mobilePane, setMobilePane] = useState<"tree" | "graph" | "inspector">(
    "graph",
  );
  const [notebookOpen, setNotebookOpen] = useState(false);
  const [deploymentOpen, setDeploymentOpen] = useState(false);
  const [exerciseOpen, setExerciseOpen] = useState(false);
  const [exerciseReview, setExerciseReview] =
    useState<LiveIncidentChoice | null>(null);
  const [persistenceError, setPersistenceError] = useState("");
  function select(id: string | null) {
    setSelectedEdge(null);
    setHelpField(undefined);
    selectResource(id);
    if (id) setMobilePane("inspector");
  }
  const dirty = useRef(false),
    draftEditVersion = useRef(0),
    revision = useRef(""),
    alive = useRef(true),
    positions = useRef<Record<string, { x: number; y: number }>>({});
  const mutationEpoch = useRef(0),
    requestSequence = useRef(0),
    acceptedSequence = useRef(0);
  const acceptedIdentity = useRef<ObservationIdentity>(null);
  const contextOwner = useRef(accountKey + ":" + sourceDigest);
  useEffect(() => {
    const owner = accountKey + ":" + sourceDigest;
    if (contextOwner.current === owner) return;
    contextOwner.current = owner;
    mutationEpoch.current++;
    acceptedIdentity.current = null;
    notebookScope.current = "";
    setLoadedNotebook("");
    setView({ plan: null, lab: null });
    setProgress(emptyProgress());
    dirty.current = false;
    revision.current = "";
    positions.current = {};
    setDraft("");
    select(null);
    setLogs(null);
    setQuestionOpen(false);
    setPending(false);
  }, [accountKey, sourceDigest]);
  const pendingApply = useRef<{
    id: string;
    revision: number;
    editVersion: number;
  } | null>(null);
  const update = (data: View, sequence = ++requestSequence.current) => {
    if (
      !alive.current ||
      !acceptsObservation(
        acceptedIdentity.current,
        data.lab,
        sequence,
        acceptedSequence.current,
      )
    )
      return;
    acceptedSequence.current = Math.max(acceptedSequence.current, sequence);
    acceptedIdentity.current = data.lab
      ? {
          id: data.lab.id,
          generation: data.lab.generation,
          revision: data.lab.revision,
        }
      : null;
    if (
      data.lab &&
      data.lab.phase !== "stopped" &&
      data.lab.plan.sourceHash !== projectFileHash
    ) {
      setError(
        "A lab for a previous project is still running. Return to that project to inspect or clean it up before creating this project's lab.",
      );
      setView({
        plan: data.plan?.sourceHash === projectFileHash ? data.plan : null,
        lab: null,
      });
      return;
    }
    setView(data);
    if (
      pendingApply.current &&
      data.lab?.id === pendingApply.current.id &&
      data.lab.revision > pendingApply.current.revision
    ) {
      if (draftEditVersion.current === pendingApply.current.editVersion)
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
    let stopped = false;
    const poll = async () => {
      if (polling || !projectFileHash) return;
      polling = true;
      const epoch = mutationEpoch.current,
        sequence = ++requestSequence.current;
      try {
        const r = await request("/api/lab");
        const data = await r.json();
        if (stopped || epoch !== mutationEpoch.current) return;
        if (!r.ok) throw Error(data.error);
        setTransport({
          state: "current",
          lastSuccess: new Date().toISOString(),
          reason: "",
        });
        update(data, sequence);
      } catch (e) {
        if (!stopped && alive.current && epoch === mutationEpoch.current)
          setTransport((previous) => ({
            ...previous,
            state: "disconnected",
            reason: (e as Error).message,
          }));
      } finally {
        polling = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 1500);
    return () => {
      stopped = true;
      alive.current = false;
      clearInterval(timer);
    };
  }, [request, sourceDigest, projectFileHash, pollEpoch]);
  async function action(kind: string, extra: Record<string, unknown> = {}) {
    setPending(true);
    setError("");
    const epoch = ++mutationEpoch.current,
      sequence = ++requestSequence.current;
    try {
      const lab = view.lab;
      if (kind === "apply" && lab)
        pendingApply.current = {
          id: lab.id,
          revision: lab.revision,
          editVersion: draftEditVersion.current,
        };
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
      if (!alive.current || epoch !== mutationEpoch.current) return;
      if (!r.ok) throw Error(data.error);
      if (kind === "reset") {
        dirty.current = false;
        revision.current = "";
      }
      if (kind === "repair") {
        dirty.current = false;
        revision.current = "";
      }
      if (kind === "reset") {
        setProgress(emptyProgress());
        setLogs(null);
        select(null);
      }
      update(data, sequence);
    } catch (e) {
      if (alive.current && epoch === mutationEpoch.current) {
        pendingApply.current = null;
        setError((e as Error).message);
      }
    } finally {
      if (alive.current && epoch === mutationEpoch.current) setPending(false);
    }
  }
  const lab = view.lab,
    busy = pending || !!lab?.operation;
  useEffect(() => {
    if (lab?.phase === "ready") setNotebookOpen(false);
  }, [lab?.generation, lab?.phase]);
  const persistenceKey = lab
    ? learningKey(accountKey, sourceDigest, lab.id, lab.generation)
    : "";
  useEffect(() => {
    if (!persistenceKey || notebookScope.current === persistenceKey) return;
    notebookScope.current = persistenceKey;
    setQuestionOpen(false);
    setSelectedEdge(null);
    setLogs(null);
    let restored = emptyProgress();
    try {
      restored = restoreProgress(localStorage.getItem(persistenceKey));
    } catch {}
    setProgress(restored);
    setLoadedNotebook(persistenceKey);
    const saved = retainedLabDrafts.get(persistenceKey);
    let stored: typeof saved = saved;
    if (!stored)
      try {
        const json = localStorage.getItem(persistenceKey + ":draft");
        if (json && json.length < 2_100_000) stored = JSON.parse(json);
      } catch {}
    if (stored && typeof stored.draft === "string") {
      dirty.current = !!stored.dirty;
      revision.current = stored.revision;
      setDraft(stored.draft);
      select(stored.selected);
      setTab(stored.tab);
      positions.current = stored.positions ?? {};
    } else {
      dirty.current = false;
      revision.current = "";
      setDraft(lab?.source ?? "");
      select(null);
      setTab("overview");
      positions.current = {};
    }
    const query = new URL(window.location.href).searchParams;
    if (
      query.get("labSession") === lab?.id &&
      query.get("labGeneration") === String(lab?.generation) &&
      query.get("labProject") === sourceDigest
    ) {
      select(query.get("labResource"));
      const restoredKind = query.get("labKind");
      if (restoredKind) setKind(restoredKind);
      setControllers(query.get("labControllers") !== "collapsed");
      const nextTab = query.get("labTab");
      if (
        nextTab &&
        ["overview", "yaml", "events", "logs", "relationships"].includes(
          nextTab,
        )
      )
        setTab(nextTab);

      const pane = query.get("labPane");
      if (pane === "tree" || pane === "graph" || pane === "inspector")
        setMobilePane(pane);
    }
  }, [persistenceKey]);
  useEffect(() => {
    if (!lab || loadedNotebook !== persistenceKey) return;
    const url = new URL(window.location.href);
    url.searchParams.set("labSession", lab.id);
    url.searchParams.set("labGeneration", String(lab.generation));
    url.searchParams.set("labProject", sourceDigest);
    url.searchParams.set("labKind", kind);
    url.searchParams.set(
      "labControllers",
      controllers ? "expanded" : "collapsed",
    );
    url.searchParams.set("labTab", tab);
    url.searchParams.set("labPane", mobilePane);
    if (selected) url.searchParams.set("labResource", selected);
    else url.searchParams.delete("labResource");
    if (url.href !== window.location.href)
      window.history.replaceState(null, "", url);
  }, [
    loadedNotebook,
    persistenceKey,
    lab?.id,
    lab?.generation,
    selected,
    tab,
    mobilePane,
    sourceDigest,
    kind,
    controllers,
  ]);
  useEffect(() => {
    const restore = () => {
      const query = new URL(window.location.href).searchParams;
      if (
        query.get("labSession") !== lab?.id ||
        query.get("labGeneration") !== String(lab?.generation) ||
        query.get("labProject") !== sourceDigest
      )
        return;
      select(query.get("labResource"));
      const restoredKind = query.get("labKind");
      if (restoredKind) setKind(restoredKind);
      setControllers(query.get("labControllers") !== "collapsed");
      const nextTab = query.get("labTab");
      if (
        nextTab &&
        ["overview", "yaml", "events", "logs", "relationships"].includes(
          nextTab,
        )
      )
        setTab(nextTab);
    };
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, [lab?.id, lab?.generation, sourceDigest]);
  useEffect(() => {
    if (!persistenceKey || loadedNotebook !== persistenceKey) return;
    const saved = {
      draft,
      selected,
      tab,
      dirty: dirty.current,
      revision: revision.current,
      positions: positions.current,
    };
    retainedLabDrafts.set(persistenceKey, saved);
    if (retainedLabDrafts.size > 100)
      retainedLabDrafts.delete(retainedLabDrafts.keys().next().value!);
    try {
      localStorage.setItem(persistenceKey + ":draft", JSON.stringify(saved));
      localStorage.setItem(persistenceKey, JSON.stringify(progress));
      setPersistenceError("");
    } catch {
      setPersistenceError(
        "Browser storage is full or unavailable. This draft and notebook remain in memory; copy the draft before closing or clearing storage.",
      );
    }
  }, [persistenceKey, loadedNotebook, draft, selected, tab, progress]);
  useEffect(() => {
    if (!lab || !persistenceKey || loadedNotebook !== persistenceKey) return;
    const summary = summarizeEvidence(
      lab.evidence.resources,
      lab.evidence.events,
      lab.evidence.receivedAt,
      lab.revision,
    );
    if (lab.phase === "running" && !!lab.incidentObservedAt && !progress.before)
      setProgress((p) => ({ ...p, before: summary }));
    if (lab.phase === "completed" && !progress.after)
      setProgress((p) => ({ ...p, after: summary }));
  }, [
    lab?.phase,
    lab?.evidence.receivedAt,
    persistenceKey,
    loadedNotebook,
    progress.before,
    progress.after,
  ]);
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
  useEffect(() => {
    if (
      selectedEdge &&
      !analysis.relationships.some((e) => e.id === selectedEdge.id)
    )
      setSelectedEdge(null);
  }, [analysis, selectedEdge]);
  const resource = resources.find((r) => r.id === selected) ?? null;
  const evidenceConnection = lab
    ? observationFreshness(lab.evidence.status)
    : null;
  const stale = Boolean(
    transport.state !== "current" ||
    (!!lab &&
      (evidenceConnection?.state !== "current" ||
        (lab.evidence.connection &&
          lab.evidence.connection.state !== "current"))),
  );
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
        live: true,
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
  const [selectedContainer, setSelectedContainer] = useState("");
  const [showPreviousLogs, setShowPreviousLogs] = useState(false);
  const [logError, setLogError] = useState("");
  const [logEpoch, setLogEpoch] = useState(0);
  const containers = stream
    ? [
        ...list(at(stream.raw, "spec", "containers")).map((c) => ({
          name: text(c.name),
          init: false,
        })),
        ...list(at(stream.raw, "spec", "initContainers")).map((c) => ({
          name: text(c.name),
          init: true,
        })),
      ]
    : [];
  const container = containers.some((c) => c.name === selectedContainer)
    ? selectedContainer
    : (containers[0]?.name ?? "");
  useEffect(() => {
    setLogs(null);
    setLogError("");
    if (tab !== "logs" || !stream || !container) return;
    let stopped = false;
    const uid = stream.id;
    const logScope = {
      sessionId: lab!.id,
      generation: lab!.generation,
      revision: lab!.revision,
    };
    const read = async () => {
      try {
        const r = await request("/api/lab", {
          method: "POST",
          body: JSON.stringify({ kind: "logs", uid, container, ...logScope }),
        });
        const data = await r.json();
        if (!stopped) {
          if (r.ok) {
            setLogs(data.logs);
            setLogError("");
          } else setLogError(data.error ?? "Log connection failed");
        }
      } catch (e) {
        if (!stopped) setLogError((e as Error).message);
      }
    };
    void read();
    const timer = setInterval(read, 1500);
    return () => {
      stopped = true;
      clearInterval(timer);
      void request("/api/lab", {
        method: "POST",
        body: JSON.stringify({
          kind: "closeLogs",
          uid,
          container,
          ...logScope,
        }),
      }).catch(() => {});
    };
  }, [
    tab,
    stream?.id,
    container,
    request,
    lab?.id,
    lab?.generation,
    lab?.revision,
    logEpoch,
  ]);
  const baselineDeployment = lab?.evidence.resources.find(
    (r) =>
      r.kind === "Deployment" &&
      at(r, "metadata", "name") === lab.plan.contract?.deployment &&
      at(r, "metadata", "namespace") === lab.plan.contract?.namespace,
  );
  const draftDeployment = draftParsed.resources.find(
    (r) =>
      r.kind === "Deployment" &&
      r.name === lab?.plan.contract?.deployment &&
      r.namespace === lab.plan.contract?.namespace,
  );
  const baselineContainer = list(
    at(baselineDeployment, "spec", "template", "spec", "containers"),
  ).find((c) => c.name === lab?.plan.contract?.container);
  const draftContainer = list(
    at(draftDeployment?.raw, "spec", "template", "spec", "containers"),
  ).find((c) => c.name === lab?.plan.contract?.container);
  const repairChanges = (["readinessProbe", "livenessProbe"] as const).flatMap(
    (probe) => {
      const desired = text(at(baselineContainer, probe, "httpGet", "path")),
        next = text(at(draftContainer, probe, "httpGet", "path"));
      return desired && next && desired !== next
        ? [
            {
              field:
                probe === "readinessProbe"
                  ? ("readinessPath" as const)
                  : ("livenessPath" as const),
              desired,
              draft: next,
            },
          ]
        : [];
    },
  );
  const selectedIncidentTarget =
    incidentTarget ||
    (lab?.plan.contract ? targetKey(lab.plan.contract, lab.namespace) : "");
  const availableIncidents = lab
    ? applicableIncidents(lab.plan, selectedIncidentTarget)
    : [];
  const learning: LearningContext = {
    lesson: lab?.incident ?? "healthy",
    objective:
      lab?.recipe?.objective ??
      lessonCopy[lab?.incident ?? "healthy"].objective,
    hypothesis: progress.hypothesis,
    prediction: progress.prediction,
    hintLevel: progress.hintLevel,
    visibleHints: (
      lab?.recipe?.hints ?? [...lessonCopy[lab?.incident ?? "healthy"].hints]
    ).slice(0, progress.hintLevel),
    solutionRequested: progress.solutionRequested,
    fieldPath: helpField,
    repairChanges: dirty.current ? repairChanges : undefined,
    helpTarget:
      lab?.phase === "completed"
        ? "debrief"
        : dirty.current && repairChanges.length
          ? "repair-diff"
          : helpField
            ? "yaml-field"
            : selectedEdge
              ? "relationship"
              : tab === "yaml"
                ? "yaml-field"
                : lab?.checks.some((c) => !c.passed)
                  ? "failed-check"
                  : "investigation",
  };
  const contextKey = JSON.stringify([
    lab?.id,
    lab?.generation,
    lab?.revision,
    selected,
    selectedEdge?.id,
    learning,
  ]);
  useEffect(() => {
    onContext?.({
      scope: {
        labId: lab?.id,
        labGeneration: lab?.generation,
        labRevision: lab?.revision,
        resourceId: selected ?? undefined,
        relationshipId: selectedEdge?.id,
        learning,
      },
      evidenceKey: contextKey,
      stale,
      available: !!lab && lab.phase !== "stopped",
    });
  }, [contextKey, stale, lab?.phase, onContext]);
  if (!lab || lab.phase === "stopped")
    return (
      <div className="catalog">
        <Card>
          <CardHeader>
            <CardTitle>Practice with {project.label}</CardTitle>
            <CardDescription>
              Create a local copy to explore, break, and repair.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Dialog open={deploymentOpen} onOpenChange={setDeploymentOpen}>
              <DialogTrigger asChild>
                <Button
                  disabled={pending}
                  onClick={() => action("plan", { project })}
                >
                  Review deployment
                </Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>Deploy {project.label}</DialogTitle>
                  <DialogDescription>
                    Creates a separate local cluster using 2 CPUs and 4 GiB of
                    memory.
                  </DialogDescription>
                </DialogHeader>
                {pending && <p role="status">Preparing deployment review…</p>}
                {error && (
                  <p role="alert" className="text-destructive">
                    {error}
                  </p>
                )}
                {view.plan && !pending && (
                  <>
                    <Tabs defaultValue="overview">
                      <TabsList>
                        <TabsTrigger value="overview">Overview</TabsTrigger>
                        <TabsTrigger value="changes">Changes</TabsTrigger>
                        <TabsTrigger value="yaml">Manifests</TabsTrigger>
                        <TabsTrigger value="settings">Options</TabsTrigger>
                      </TabsList>
                      <TabsContent value="overview" className="space-y-4">
                        <p className="text-sm">
                          Deploy {view.plan.resources.length} resources in a
                          separate local namespace.
                        </p>
                        <ul className="space-y-2 text-sm">
                          {[
                            ...new Set(
                              view.plan.resources.map((r) => text(r.kind)),
                            ),
                          ].map((kind) => (
                            <li key={kind}>
                              {kind}:{" "}
                              {
                                view.plan!.resources.filter(
                                  (r) => text(r.kind) === kind,
                                ).length
                              }
                            </li>
                          ))}
                        </ul>
                        <p className="text-sm text-muted-foreground">
                          Your original application stays unchanged. Cleaning up
                          this lab removes its local data.
                          {view.plan.needsIngress &&
                            " Includes an ingress controller."}
                          {view.plan.needsVault &&
                            " Includes a local Vault instance with test data."}
                        </p>
                      </TabsContent>
                      <TabsContent value="changes" className="space-y-4">
                        <ul className="space-y-2 text-sm">
                          {view.plan.changes.map((c) => (
                            <li key={c}>{c}</li>
                          ))}
                        </ul>
                        <p className="text-sm text-muted-foreground">
                          Your original application stays unchanged. Cleaning up
                          this lab removes its local data.
                          {view.plan.needsIngress &&
                            " Includes an ingress controller."}
                          {view.plan.needsVault &&
                            " Includes a local Vault instance with test data."}
                        </p>
                      </TabsContent>
                      <TabsContent value="yaml">
                        <div className="h-80 overflow-hidden">
                          <SourceEditor
                            value={view.plan.source}
                            onChange={() => {}}
                            ranges={[]}
                            readOnly
                          />
                        </div>
                      </TabsContent>
                      <TabsContent value="settings" className="space-y-4">
                        <LocalImages
                          project={project}
                          onSaved={() => void action("plan", { project })}
                        />
                        {!!view.plan.requirements?.length && (
                          <details>
                            <summary>Deployment requirements</summary>
                            <ul className="mt-3 space-y-2 text-sm">
                              {view.plan.requirements.map((r) => (
                                <li key={r}>{r}</li>
                              ))}
                            </ul>
                          </details>
                        )}
                      </TabsContent>
                    </Tabs>
                    {!!view.plan.blockers.length && (
                      <ul role="alert" className="space-y-2 text-destructive">
                        {view.plan.blockers.map((b) => (
                          <li key={b}>{b}</li>
                        ))}
                      </ul>
                    )}
                    {!view.plan.contract && (
                      <p className="text-sm text-muted-foreground">
                        You can explore this application. Guided exercises need
                        a compatible HTTP health check and Service.
                      </p>
                    )}
                    <Button
                      disabled={pending || !!view.plan.blockers.length}
                      onClick={() => {
                        setDeploymentOpen(false);
                        void action("create", {
                          planHash: view.plan!.planHash,
                        });
                      }}
                    >
                      Create local lab
                    </Button>
                  </>
                )}
                {!view.plan && !pending && error && (
                  <Button onClick={() => action("plan", { project })}>
                    Try again
                  </Button>
                )}
              </DialogContent>
            </Dialog>
          </CardContent>
        </Card>
        {transport.state === "disconnected" && (
          <p role="status" className="notice">
            Connection lost.{" "}
            <Button
              variant="outline"
              onClick={() => setPollEpoch((v) => v + 1)}
            >
              Reconnect
            </Button>
          </p>
        )}
        {error && !deploymentOpen && (
          <p role="alert" className="notice">
            {error}
          </p>
        )}
      </div>
    );
  const repairEditor = (
    <>
      <div className="lab-editor">
        <SourceEditor
          value={draft}
          onChange={(v) => {
            dirty.current = true;
            draftEditVersion.current++;
            setDraft(v);
          }}
          ranges={[]}
          contextKey={lab.id}
        />
      </div>
      {draftErrors.map((d) => (
        <p role="alert" key={d.line}>
          Line {d.line}: {d.message}.
        </p>
      ))}
      <Button
        disabled={
          busy ||
          stale ||
          !!draftErrors.length ||
          !dirty.current ||
          (!!lab?.incident && !["readiness", "liveness"].includes(lab.incident))
        }
        onClick={() => action("apply", { source: draft })}
      >
        Apply repair
      </Button>
      {lab?.incident && !["readiness", "liveness"].includes(lab.incident) && (
        <p className="mt-2 text-xs text-muted-foreground">
          Use the repair button for this exercise.
        </p>
      )}
    </>
  );
  return (
    <div className="live-practice">
      <Dialog
        open={!!reviewOperation}
        onOpenChange={(open) => {
          if (!open) setReviewOperation(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {reviewOperation?.kind === "reset"
                ? "Reset this lab?"
                : reviewOperation?.kind === "cleanup"
                  ? "Delete this lab?"
                  : "Review one scheduled execution"}
            </DialogTitle>
            <DialogDescription>
              {reviewOperation?.kind === "run-cronjob"
                ? `Create one Job from ${reviewOperation.target} in this owned lab. The existing schedule remains unchanged; this can write application data.`
                : reviewOperation?.kind === "cleanup"
                  ? "This removes the local cluster and all its data. Your original application stays unchanged."
                  : "Restore the original configuration and start a new notebook. Unsaved repair edits will be discarded."}
            </DialogDescription>
          </DialogHeader>
          {reviewOperation?.kind === "reset" && (
            <ul className="space-y-2 text-sm">
              {(
                view.resetPreview?.details ?? [
                  "Restore reviewed manifests. Existing Job execution and PVC data are preserved; this does not erase application data.",
                ]
              ).map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          )}
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => setReviewOperation(null)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() => {
                const op = reviewOperation;
                setReviewOperation(null);
                if (op)
                  void action(op.kind, op.target ? { target: op.target } : {});
              }}
            >
              {reviewOperation?.kind === "reset"
                ? "Confirm reset"
                : reviewOperation?.kind === "cleanup"
                  ? "Confirm cleanup"
                  : "Run once"}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <div className="lab-strip">
        <div>
          <strong>
            {lab.incident
              ? incidentChoice(lab.incident).title
              : "Local application"}
          </strong>
          <span role="status">
            {lab.operation
              ? "Working…"
              : lab.phase === "completed"
                ? "Recovered"
                : lab.phase === "ready"
                  ? "Ready"
                  : lab.phase === "running"
                    ? "Investigating"
                    : lab.phase === "preparing"
                      ? "Preparing…"
                      : "Needs attention"}
          </span>
        </div>
        <div className="flex flex-wrap gap-2">
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="ghost">Lab details</Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>Local lab</DialogTitle>
                <DialogDescription>
                  This is the separate cluster used for your practice.
                </DialogDescription>
              </DialogHeader>
              <dl className="space-y-3 text-sm">
                <div>
                  <dt className="text-muted-foreground">Cluster</dt>
                  <dd className="break-all">{lab.profile}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Namespace</dt>
                  <dd className="break-all">{lab.namespace}</dd>
                </div>
              </dl>
              <details>
                <summary>Terminal commands</summary>
                <pre className="mt-3 overflow-x-auto text-xs">
                  {lab.terminal} get pods,services,endpointslices
                </pre>
              </details>
            </DialogContent>
          </Dialog>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setReviewOperation({ kind: "reset" })}
          >
            Reset baseline
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => setReviewOperation({ kind: "cleanup" })}
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
      {persistenceError && (
        <p className="notice" role="status">
          {persistenceError}
        </p>
      )}
      {stale && (
        <p role="status" className="notice">
          Live updates are unavailable.{" "}
          <Button variant="outline" onClick={() => setPollEpoch((v) => v + 1)}>
            Reconnect
          </Button>
        </p>
      )}
      {lab.phase === "preparing" && (
        <p className="py-6" role="status">
          Preparing your lab… This can take a few minutes.
        </p>
      )}
      {!!view.scheduledExecutions?.length && (
        <Card className="mx-4 my-3">
          <CardHeader>
            <CardTitle>Scheduled workloads</CardTitle>
            <CardDescription>
              Configuration validity and observed execution are separate.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {view.scheduledExecutions.map((job) => (
              <div
                key={job.target}
                className="my-2 flex flex-wrap items-center gap-3"
              >
                <span>
                  {job.target} · {job.state}
                </span>
                <p className="text-sm text-muted-foreground">{job.detail}</p>
                <Button
                  variant="outline"
                  disabled={busy || stale}
                  onClick={() =>
                    setReviewOperation({
                      kind: "run-cronjob",
                      target: job.target,
                    })
                  }
                >
                  Review one run
                </Button>
              </div>
            ))}
          </CardContent>
        </Card>
      )}
      {practice && (lab.phase === "ready" || !!lab.incident) && (
        <div className="practice-toolbar">
          {lab.phase === "ready" && (
            <>
              <Select
                value={selectedIncidentTarget}
                onValueChange={setIncidentTarget}
              >
                <SelectTrigger
                  aria-label="Practice workload"
                  className="w-full sm:w-64"
                >
                  <SelectValue placeholder="Choose a workload" />
                </SelectTrigger>
                <SelectContent>
                  {(lab.plan.contracts ?? []).map((c) => (
                    <SelectItem
                      key={targetKey(c, lab.namespace)}
                      value={targetKey(c, lab.namespace)}
                    >
                      {c.deployment} / {c.container}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Dialog
                open={exerciseOpen}
                onOpenChange={(open) => {
                  setExerciseOpen(open);
                  if (!open) setExerciseReview(null);
                }}
              >
                <DialogTrigger asChild>
                  <Button
                    disabled={busy || stale || !availableIncidents.length}
                  >
                    Choose exercise
                  </Button>
                </DialogTrigger>
                <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-xl">
                  <DialogHeader>
                    <DialogTitle>
                      {exerciseReview?.title ?? "Choose an exercise"}
                    </DialogTitle>
                    <DialogDescription>
                      {exerciseReview
                        ? exerciseReview.objective
                        : "Choose a problem to investigate in your local lab."}
                    </DialogDescription>
                  </DialogHeader>
                  {exerciseReview ? (
                    <>
                      <p className="text-sm">
                        Workload:{" "}
                        <strong>
                          {selectedIncidentTarget
                            .split("/")
                            .slice(1)
                            .join(" / ")}
                        </strong>
                      </p>
                      <p className="text-sm">
                        {exerciseReview.id === "market-data-stale"
                          ? "Pause quote updates while the producer stays running."
                          : `Introduce a ${exerciseReview.title.toLowerCase()} in this workload.`}{" "}
                        Only this local lab changes.
                      </p>
                      <details className="text-sm">
                        <summary>What changes</summary>
                        <p className="mt-3">{exerciseReview.operation}</p>
                        <p className="mt-2">Repair: {exerciseReview.repair}</p>
                      </details>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          onClick={() => setExerciseReview(null)}
                        >
                          Back
                        </Button>
                        <Button
                          disabled={busy || stale || !selectedIncidentTarget}
                          onClick={() => {
                            const choice = exerciseReview;
                            setExerciseOpen(false);
                            setExerciseReview(null);
                            void action("incident", {
                              incident: choice.id,
                              target: selectedIncidentTarget,
                            });
                          }}
                        >
                          Start investigation
                        </Button>
                      </div>
                    </>
                  ) : (
                    <div className="divide-y divide-border">
                      {availableIncidents.map((choice) => (
                        <button
                          key={choice.id}
                          className="exercise-choice"
                          onClick={() => setExerciseReview(choice)}
                        >
                          <strong>{choice.title}</strong>
                          <span>{exerciseDescriptions[choice.id]}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </DialogContent>
              </Dialog>
              <GenerateIncident
                key={[lab.id, lab.generation, lab.revision].join(":")}
                lab={lab}
                busy={busy || stale}
                available={availableIncidents}
                onStart={(recipe, id) =>
                  action("incident", {
                    incident: recipe.incident,
                    target: recipe.target,
                    proposalId: id,
                  })
                }
              />
            </>
          )}
          <Dialog open={notebookOpen} onOpenChange={setNotebookOpen}>
            <DialogTrigger asChild>
              <Button variant="outline">
                {lab.phase === "completed"
                  ? "Recovery debrief"
                  : lab.incident
                    ? "Investigation notebook"
                    : "Healthy application guide"}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
              <DialogHeader>
                <DialogTitle>
                  {lab.phase === "completed"
                    ? "Recovery debrief"
                    : lab.incident
                      ? "Investigation notebook"
                      : "Healthy application guide"}
                </DialogTitle>
                <DialogDescription>
                  {lab.recipe?.objective ??
                    lessonCopy[lab.incident ?? "healthy"].objective}
                </DialogDescription>
              </DialogHeader>
              <LearningJourney
                incident={lab.incident}
                completed={lab.phase === "completed"}
                progress={progress}
                onChange={setProgress}
                baselinePath={
                  lab.incident === "liveness"
                    ? lab.plan.contract?.livenessPath
                    : lab.plan.contract?.path
                }
                generatedHints={lab.recipe?.hints}
                objective={lab.recipe?.objective}
                onInspect={(tab) => {
                  setTab(tab);
                  setMobilePane("inspector");
                  setNotebookOpen(false);
                }}
                onCheck={() => void action("check")}
                disabled={busy || stale}
                dirty={dirty.current}
              />
            </DialogContent>
          </Dialog>
          {lab.incident && lab.phase !== "completed" && (
            <>
              <Button
                variant="outline"
                disabled={
                  busy ||
                  stale ||
                  lab.phase !== "running" ||
                  !lab.incidentObservedAt
                }
                onClick={() => action("repair")}
              >
                {lab.incident === "market-data-stale"
                  ? "Resume synthetic feed"
                  : "Reapply reviewed baseline"}
              </Button>
              <Button
                disabled={
                  busy || stale || dirty.current || !lab.incidentObservedAt
                }
                onClick={() => action("check")}
              >
                Check recovery
              </Button>
            </>
          )}
          {!!lab.checks.length && (
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="ghost">View checks</Button>
              </DialogTrigger>
              <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-2xl">
                <DialogHeader>
                  <DialogTitle>
                    {lab.phase === "completed"
                      ? "Recovery verified"
                      : "Lab checks"}
                  </DialogTitle>
                  <DialogDescription>
                    Results from the most recent verification.
                  </DialogDescription>
                </DialogHeader>
                <ul className="space-y-4">
                  {lab.checks.map((c, i) => (
                    <li key={i} className="space-y-1 text-sm">
                      <strong
                        className={
                          c.passed ? "text-primary" : "text-destructive"
                        }
                      >
                        {c.passed ? "✓" : "×"} {c.name}
                      </strong>
                      <p className="text-muted-foreground">{c.detail}</p>
                      {!c.passed && (
                        <Button
                          variant="link"
                          disabled={stale || busy}
                          onClick={() => {
                            setProjectQuestion(false);
                            setHelpField(undefined);
                            setQuestionOpen(true);
                          }}
                        >
                          Ask ChatGPT
                        </Button>
                      )}
                    </li>
                  ))}
                </ul>
              </DialogContent>
            </Dialog>
          )}
        </div>
      )}
      {practice && lab.phase === "completed" && (
        <p className="practice-success" role="status">
          Recovery checks passed for this workload.
        </p>
      )}
      <div className="lab-strip">
        {revealedFilters && (
          <Button
            variant="outline"
            onClick={() => {
              setKind(revealedFilters.kind);
              setControllers(revealedFilters.controllers);
              setRevealedFilters(null);
            }}
          >
            Restore filters
          </Button>
        )}
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
      </div>
      <div
        className="flex gap-2 px-4 py-2 md:hidden"
        aria-label="Workspace pane"
      >
        <Button
          variant={mobilePane === "tree" ? "default" : "outline"}
          onClick={() => setMobilePane("tree")}
        >
          Resources
        </Button>
        <Button
          variant={mobilePane === "graph" ? "default" : "outline"}
          onClick={() => setMobilePane("graph")}
        >
          Topology
        </Button>
        <Button
          variant={mobilePane === "inspector" ? "default" : "outline"}
          onClick={() => setMobilePane("inspector")}
        >
          Inspector
        </Button>
      </div>
      <ResizablePanelGroup
        className="lab-panels"
        data-mobile-pane={mobilePane}
        orientation="horizontal"
      >
        <ResizablePanel
          data-pane="tree"
          className={`${mobilePane === "tree" ? "" : "max-md:!hidden"} max-md:!basis-full max-md:!w-full max-md:!grow`}
          defaultSize="18%"
          minSize="12%"
        >
          <nav className="resource-tree" aria-label="Application resource tree">
            <strong>{project.label}</strong>
            {[...new Set(resources.map((r) => r.namespace ?? "cluster"))]
              .sort()
              .map((namespace) => (
                <details key={namespace} open>
                  <summary>{namespace}</summary>
                  {resources
                    .filter(
                      (r) =>
                        (r.namespace ?? "cluster") === namespace &&
                        !list(at(r.raw, "metadata", "ownerReferences")).some(
                          (o) => resources.some((p) => p.id === o.uid),
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
                        observation={observation}
                        stale={stale}
                      />
                    ))}
                </details>
              ))}
          </nav>
        </ResizablePanel>
        <ResizableHandle className="max-md:hidden" withHandle />
        <ResizablePanel
          data-pane="graph"
          className={`${mobilePane === "graph" ? "" : "max-md:!hidden"} max-md:!basis-full max-md:!w-full max-md:!grow`}
          defaultSize="49%"
          minSize="25%"
        >
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
                  {r.namespace ?? "cluster"} · {r.kind} / {r.name}
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
            repairEditor
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
              onRelationship={(id) => {
                const relationship = analysis.relationships.find(
                  (e) => e.id === id,
                );
                if (!relationship) return;
                select(relationship.from);
                setSelectedEdge(relationship);
                setTab("relationships");
              }}
              observation={observation}
              stale={stale}
              staleReason="Last received lab state · stale"
              endpointCoverage={() => !stale}
              initialPositions={positions.current}
              onPositionsChange={(p) => {
                positions.current = p;
                const retained = retainedLabDrafts.get(persistenceKey);
                if (retained) {
                  retained.positions = p;
                  try {
                    localStorage.setItem(
                      persistenceKey + ":draft",
                      JSON.stringify(retained),
                    );
                  } catch {}
                }
              }}
              provenance={
                stale ? "Last received lab state · stale" : "Live lab state"
              }
            />
          )}
        </ResizablePanel>
        <ResizableHandle className="max-md:hidden" withHandle />
        <ResizablePanel
          data-pane="inspector"
          className={`${mobilePane === "inspector" ? "" : "max-md:!hidden"} max-md:!basis-full max-md:!w-full max-md:!grow`}
          defaultSize="33%"
          minSize="25%"
        >
          <section className="live-inspector">
            <QuestionDialog
              open={questionOpen}
              onOpenChange={setQuestionOpen}
              title="ChatGPT"
              retentionKey={sourceDigest}
              evidenceKey={[
                lab.id,
                lab.generation,
                lab.revision,
                selected,
                selectedEdge?.id,
                JSON.stringify(learning),
              ].join(":")}
              scope={{
                relationshipId: projectQuestion ? undefined : selectedEdge?.id,
                learning,
                labId: lab.id,
                labGeneration: lab.generation,
                labRevision: lab.revision,
                resourceId: projectQuestion
                  ? undefined
                  : (selected ?? undefined),
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
                : selected
                  ? "Resource unavailable"
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
                      <dt>Kind / name</dt>
                      <dd>
                        {resource.kind} / {resource.name}
                      </dd>
                      <dt>UID</dt>
                      <dd>{resource.id}</dd>
                      <dt>Namespace</dt>
                      <dd>{resource.namespace}</dd>
                      <dt>API version</dt>
                      <dd>{resource.apiVersion}</dd>
                      <dt>Age</dt>
                      <dd>
                        {resourceAge(resource.raw, lab.evidence.receivedAt)}
                      </dd>
                      <dt>Provenance</dt>
                      <dd>
                        {list(at(resource.raw, "metadata", "ownerReferences"))
                          .length
                          ? "Controller-generated live API resource"
                          : "Live API resource"}
                      </dd>
                      <dt>Owners</dt>
                      <dd>
                        {list(
                          at(resource.raw, "metadata", "ownerReferences"),
                        ).map((o) => (
                          <Button
                            key={text(o.uid)}
                            variant="link"
                            onClick={() => {
                              setRevealedFilters({ kind, controllers });
                              setKind("all");
                              setControllers(true);
                              select(text(o.uid));
                            }}
                          >
                            {text(o.kind)} / {text(o.name)} · {text(o.uid)}
                          </Button>
                        ))}
                      </dd>
                      <dt>Conditions</dt>
                      <dd>
                        {conditionSummary(resource.raw).join("; ") ||
                          "No conditions reported"}
                      </dd>
                      <dt>Observation</dt>
                      <dd>{stale ? "Stale / unknown" : "Live"}</dd>
                    </dl>
                    {list(
                      at(
                        resource.raw,
                        "spec",
                        ...(resource.kind === "Pod"
                          ? []
                          : ["template", "spec"]),
                        "containers",
                      ),
                    ).map((container, index) => (
                      <div key={text(container.name)} className="my-3 text-sm">
                        <strong>{text(container.name)}</strong>
                        {(["readinessProbe", "livenessProbe"] as const).map(
                          (probe) =>
                            at(container, probe) ? (
                              <div key={probe}>
                                <p>
                                  {probe}: HTTP path{" "}
                                  {text(
                                    at(container, probe, "httpGet", "path"),
                                  ) || "non-HTTP"}
                                </p>
                                <Button
                                  variant="link"
                                  disabled={stale || busy}
                                  onClick={() => {
                                    setProjectQuestion(false);
                                    setHelpField(
                                      `spec.${resource.kind === "Pod" ? "" : "template.spec."}containers.${index}.${probe}.httpGet.path`,
                                    );
                                    setQuestionOpen(true);
                                  }}
                                >
                                  Ask about this probe field
                                </Button>
                              </div>
                            ) : null,
                        )}
                      </div>
                    ))}
                    {authored && (
                      <details>
                        <summary>Desired / live normalized diff</summary>
                        <p className="text-xs text-muted-foreground">
                          API bookkeeping removed; defaults and controller
                          changes remain visible.
                        </p>
                        <pre>
                          {stringify(
                            configurationDifferences(
                              authored.raw,
                              resource.raw,
                            ),
                          )}
                        </pre>
                      </details>
                    )}
                    <details>
                      <summary>Raw status and UID</summary>
                      <p>{resource.id}</p>
                      <pre>{stringify(resource.raw.status ?? {})}</pre>
                    </details>
                  </>
                )}
              </TabsContent>
              <TabsContent value="yaml">
                <Tabs
                  key={
                    destination === "Manifest files"
                      ? "observed-file-inspector"
                      : "repair-inspector"
                  }
                  defaultValue={
                    destination === "Manifest files" ? "observed" : "repair"
                  }
                >
                  <TabsList>
                    {destination !== "Manifest files" && (
                      <TabsTrigger value="repair">Lab repair</TabsTrigger>
                    )}
                    <TabsTrigger value="observed">Observed YAML</TabsTrigger>
                    <TabsTrigger value="baseline">Healthy baseline</TabsTrigger>
                  </TabsList>
                  {destination !== "Manifest files" && (
                    <TabsContent value="repair">{repairEditor}</TabsContent>
                  )}
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
                    <Select
                      value={container}
                      onValueChange={(v) => {
                        setSelectedContainer(v);
                        setShowPreviousLogs(false);
                      }}
                    >
                      <SelectTrigger aria-label="Lab log container">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {containers.map((c) => (
                          <SelectItem key={c.name} value={c.name}>
                            {c.name}
                            {c.init ? " (init)" : ""}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      variant="outline"
                      onClick={() => setShowPreviousLogs((v) => !v)}
                    >
                      {showPreviousLogs
                        ? "Show current logs"
                        : "Show previous container logs"}
                    </Button>
                    {logError && (
                      <p role="alert">
                        {logError}{" "}
                        <Button
                          variant="outline"
                          onClick={() => setLogEpoch((v) => v + 1)}
                        >
                          Retry logs
                        </Button>
                      </p>
                    )}
                    {logs ? (
                      <>
                        <pre className="live-log">
                          {showPreviousLogs
                            ? (logs.previous ??
                              "Previous container logs unavailable in this window.")
                            : logs.lines.join("\n")}
                        </pre>
                        <p>
                          {logs.state}
                          {logs.truncated ? " · truncated" : ""} {logs.error}
                        </p>
                        {logs.gaps.map((g) => (
                          <p key={g} className="text-muted-foreground">
                            {g}
                          </p>
                        ))}
                        {!showPreviousLogs && logs.previous && (
                          <details>
                            <summary>Previous container logs</summary>
                            <pre>{logs.previous}</pre>
                          </details>
                        )}
                      </>
                    ) : (
                      <p>
                        {logError
                          ? "Log stream unavailable."
                          : "Connecting log stream…"}
                      </p>
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
                  .filter((e) =>
                    selectedEdge
                      ? e.id === selectedEdge.id
                      : e.from === selected || e.to === selected,
                  )
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
    </div>
  );
}
function Tree({
  resource,
  resources,
  selected,
  select,
  detail,
  observation,
  stale,
}: {
  resource: Resource;
  resources: Resource[];
  selected: string | null;
  select: (id: string) => void;
  detail: boolean;
  observation: Observation | null;
  stale: boolean;
}) {
  const status = stale
    ? "Stale / unknown"
    : resourcePresentation(resource, observation, true).label;
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
        aria-label={`${resource.namespace ?? "cluster"} · ${resource.kind} / ${resource.name}`}
        title={`UID ${resource.id} · ${status} · ${conditionSummary(resource.raw).join("; ")} · ${resourceAge(resource.raw, observation?.capturedAt ?? null)} · observed API resource`}
        aria-pressed={selected === resource.id}
        onClick={() => select(resource.id)}
      >
        <span className="min-w-0 block truncate">
          {resource.kind} / {resource.name}
        </span>
        <small className="min-w-0 block truncate text-muted-foreground">
          {resource.namespace ?? "cluster"} · {status}
        </small>
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
                observation={observation}
                stale={stale}
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
