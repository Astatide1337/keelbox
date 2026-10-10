"use client";
import { QuestionDialog } from "@/components/auth/QuestionDialog";
import { useAccount } from "@/components/auth/AccountProvider";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import {
  Network,
  Boxes,
  Activity,
  FileCode2,
  FlaskConical,
  RotateCcw,
  Check,
  ArrowLeft,
  PanelLeftClose,
  Upload,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { MobileNavigation } from "@/components/shell/MobileNavigation";
import { AppHeader } from "@/components/shell/AppHeader";
import { AppSidebar } from "@/components/shell/AppSidebar";
import { WorkspaceLayout } from "@/components/shell/WorkspaceLayout";
import { WorkspaceToolbar } from "./WorkspaceToolbar";
import { ContinueLearning } from "@/components/practice/ContinueLearning";
import { graphProjection } from "@/lib/domain/presentation";
import type { Viewport } from "@xyflow/react";
import { Badge } from "@/components/ui/badge";
import { ImportDialog } from "./ImportDialog";
import { EndpointContractDialog } from "@/components/practice/EndpointContractDialog";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableHeader,
  TableRow,
  TableHead,
  TableBody,
  TableCell,
} from "@/components/ui/table";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "@/components/ui/resizable";
import { ResourceGraph } from "./ResourceGraph";
import { ResourceInspector } from "./ResourceInspector";
import { useProjectWorkspace } from "./useProjectWorkspace";
import { IncidentCatalog } from "@/components/practice/IncidentCatalog";
import { Debrief } from "@/components/practice/Debrief";
import {
  importSnapshot,
  manifestProject,
  snapshotDigest,
  coverage,
  type Snapshot,
} from "@/lib/domain/snapshot";
import { parseSources } from "@/lib/domain/importer";
import { analyze } from "@/lib/domain/analyzer";
import {
  at,
  list,
  text,
  type SourceFile,
  type Relationship,
  type Observation,
} from "@/lib/domain/types";
import { compatibility } from "@/lib/practice/compatibility";
import {
  createExercise,
  editDraft,
  checkRepair,
  restartExercise,
} from "@/lib/practice/engine";
import { incidents } from "@/lib/practice/scenarios/catalog";
import type { Exercise, IncidentId } from "@/lib/practice/types";
import example from "@/examples/storefront/snapshot.json";
const bundled = importSnapshot(JSON.stringify(example));
function save(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const profileDrafts = new Map<
  string,
  {
    source: Snapshot;
    files: SourceFile[];
    exercise: Exercise | null;
    destination: string;
    saved: Map<string, number>;
  }
>();
export function WorkspaceShell() {
  const account = useAccount(),
    accountFetch = account.request;
  const profileKey = account.status?.profile?.key ?? "signed-out";
  const retained = useRef(profileDrafts.get(profileKey)).current;
  const [questionOpen, setQuestionOpen] = useState(false),
    [questionScope, setQuestionScope] = useState<{
      resourceId?: string;
      relationshipId?: string;
    }>({});
  const [source, setSource] = useState<Snapshot>(retained?.source ?? bundled),
    [analysisFiles, setAnalysisFiles] = useState<SourceFile[]>(
      retained?.files ?? bundled.files,
    ),
    [destination, setDestination] = useState(
      retained?.destination ?? "Topology",
    ),
    [exercise, setExercise] = useState<Exercise | null>(
      retained?.exercise ?? null,
    ),
    [incompatible, setIncompatible] = useState<{
      scenario: IncidentId;
      reasons: string[];
    } | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [collapsed, setCollapsed] = useState(false),
    [mobileInspector, setMobileInspector] = useState(false),
    [importOpen, setImportOpen] = useState(false),
    [endpointOpen, setEndpointOpen] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false),
    [focusRelationship, setFocusRelationship] = useState<string | null>(null),
    [historyRevision, setHistoryRevision] = useState(0);
  const navigationTrigger = useRef<HTMLButtonElement | null>(null);
  const viewports = useRef(new Map<string, Viewport>());
  const [pendingProject, setPendingProject] = useState<Snapshot | null>(null);
  const [retainedDrafts, setRetainedDrafts] = useState<
    { source: Snapshot; files: SourceFile[] }[]
  >([]);
  const [projectSyncError, setProjectSyncError] = useState("");
  const projectRevision = useRef<string | null>(null);
  const receiveProject = useRef<(s: Snapshot) => void>(() => {});
  const [connected, setConnected] = useState(false),
    [persistence, setPersistence] = useState(
      "In-memory exploration; connecting local checkpoint storage…",
    );
  const csrf = useRef(""),
    savedRevisions = useRef(retained?.saved ?? new Map<string, number>()),
    queue = useRef(Promise.resolve()),
    activeExercise = useRef<Exercise | null>(null);
  activeExercise.current = exercise;
  profileDrafts.set(profileKey, {
    source,
    files: analysisFiles,
    exercise,
    destination,
    saved: savedRevisions.current,
  });
  const initialUrl = useRef<string | null>(null);
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        initialUrl.current ??= location.href;
        const url = new URL(initialUrl.current);
        const response = await accountFetch("/api/practice");
        const info = await response.json();
        if (!response.ok) throw Error(info.error);
        if (!alive) return;
        csrf.current = info.csrf;
        setConnected(true);
        setPersistence("Local checkpoint storage connected");
        const id = url.searchParams.get("exercise");
        if (id && !retained) {
          const resume = await accountFetch(
            "/api/practice?id=" + encodeURIComponent(id),
          );
          const saved = await resume.json();
          if (!resume.ok) throw Error(saved.error);
          if (!alive) return;
          savedRevisions.current.set(id, saved.savedRevision);
          setSource(importSnapshot(JSON.stringify(saved.project)));
          setAnalysisFiles(saved.project.files);
          setExercise(saved.exercise);
          setDestination("Practice");
          setPersistence(
            "Exercise recovered from local checkpoint. Review the evidence before continuing.",
          );
        }
      } catch (e) {
        if (alive)
          setPersistence(
            (e as Error).message +
              " Browser practice remains available in memory.",
          );
      }
    })();
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    if (persistence !== "Saved") return;
    const timer = setTimeout(() => setPersistence(""), 1800);
    return () => clearTimeout(timer);
  }, [persistence]);
  useEffect(() => {
    const url = new URL(location.href);
    if (destination === "Practice" && exercise)
      url.searchParams.set("exercise", exercise.id);
    else url.searchParams.delete("exercise");
    history.replaceState(null, "", url);
  }, [destination, exercise?.id]);
  useEffect(() => {
    if (!exercise || !connected) return;
    setPersistence("Saving…");
    const pending = exercise,
      project = source;
    const timer = setTimeout(() => {
      queue.current = queue.current.then(async () => {
        if (activeExercise.current?.id !== pending.id) return;
        try {
          const response = await accountFetch("/api/practice", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Playground-Csrf": csrf.current,
            },
            body: JSON.stringify({
              exercise: { ...pending, operations: {} },
              project,
              expectedSavedRevision:
                savedRevisions.current.get(pending.id) ?? null,
            }),
          });
          const data = await response.json();
          if (!response.ok) throw Error(data.error);
          savedRevisions.current.set(pending.id, data.savedRevision);
          if (
            activeExercise.current?.id === pending.id &&
            activeExercise.current.revision === pending.revision
          ) {
            setPersistence("Saved");
          }
        } catch (e) {
          if (activeExercise.current?.id === pending.id)
            setPersistence(
              "Checkpoint unavailable: " +
                (e as Error).message +
                " Draft retained in memory.",
            );
        }
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [exercise, connected, source]);
  const editorContexts = useRef(
    new Map<string, import("./SourceEditor").EditorContext>(),
  );
  const startIdentity = useRef(0),
    positions = useRef(
      new Map<string, Record<string, { x: number; y: number }>>(),
    );
  const currentExercise = destination === "Practice" ? exercise : null;
  const displayedSource = useMemo(
    () =>
      currentExercise
        ? { ...currentExercise.source, resources: currentExercise.resources }
        : source,
    [source, currentExercise],
  );
  const files = currentExercise?.draftFiles ?? analysisFiles;
  const ws = useProjectWorkspace(
    displayedSource,
    files,
    currentExercise?.id ?? source.id,
  );
  const analysis = useMemo(() => analyze(ws.all), [ws.all]);
  const select = useCallback(
    (id: string) => {
      ws.setSelected(id);
      ws.setTab("Overview");
      setFocusRelationship(null);
      setMobileInspector(true);
    },
    [ws.setSelected, ws.setTab],
  );
  const relations = useMemo(
    () => graphProjection(ws.all, analysis.relationships, displayedSource),
    [ws.all, analysis.relationships, displayedSource],
  );
  const observed: Observation | null = displayedSource.resources.length
    ? {
        sessionId: currentExercise?.id ?? source.id,
        generation: currentExercise?.attempt ?? 1,
        revision: currentExercise?.revision ?? 0,
        sequence: currentExercise?.revision ?? 0,
        capturedAt: displayedSource.captureEndedAt ?? "",
        resources: displayedSource.resources,
        errors: displayedSource.errors,
      }
    : null;
  function navigate(name: string) {
    startIdentity.current++;
    setBusy(false);
    setDestination(name);
    setNotice("");
    setMobileInspector(false);
    setNavigationOpen(false);
  }
  function start(scenario: IncidentId, target = source) {
    const compatible = compatibility(target, scenario);
    if (!compatible.supported) {
      setIncompatible({ scenario, reasons: compatible.reasons });
      return;
    }
    setBusy(true);
    setNotice("");
    const identity = ++startIdentity.current;
    setTimeout(() => {
      if (startIdentity.current !== identity) return;
      try {
        setExercise(createExercise(target, scenario));
        setIncompatible(null);
      } catch (e) {
        setNotice((e as Error).message);
      } finally {
        setBusy(false);
      }
    }, 200);
  }
  function repair() {
    if (!exercise) return;
    try {
      const result = checkRepair(
        exercise,
        exercise.revision,
        crypto.randomUUID(),
      );
      setExercise(result);
      setNotice(
        result.state === "completed"
          ? "Passing the practice scenario. Modeled outcome only."
          : result.checks.map((c) => c.explanation).join(" "),
      );
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  function reset() {
    if (!exercise) return;
    try {
      setExercise(
        restartExercise(exercise, exercise.revision, crypto.randomUUID()),
      );
      setNotice("Exercise restarted. Original import unchanged.");
      ws.setTab("Overview");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  function edit(fileId: string, content: string) {
    try {
      if (currentExercise)
        setExercise(
          editDraft(currentExercise, currentExercise.revision, fileId, content),
        );
      else
        setAnalysisFiles((fs) =>
          fs.map((f) => (f.id === fileId ? { ...f, content } : f)),
        );
      setNotice("");
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  function adopt(s: Snapshot, preserveExercise = false) {
    startIdentity.current++;
    setBusy(false);
    setSource(s);
    setAnalysisFiles(s.files);
    if (!preserveExercise) setExercise(null);
    setPendingProject(null);
    setDestination("Topology");
    setImportOpen(false);
    setNotice("");
  }
  function retainCurrentDraft() {
    if (JSON.stringify(analysisFiles) !== JSON.stringify(source.files))
      setRetainedDrafts((drafts) => [
        ...drafts.filter((d) => d.source.id !== source.id),
        { source, files: analysisFiles },
      ]);
  }
  function openCliProject(project: Snapshot) {
    retainCurrentDraft();
    adopt(project, true);
  }
  function resumeDraft(draft: { source: Snapshot; files: SourceFile[] }) {
    retainCurrentDraft();
    setRetainedDrafts((drafts) =>
      drafts.filter((d) => d.source.id !== draft.source.id),
    );
    adopt(draft.source, true);
    setAnalysisFiles(draft.files);
    setNotice(
      "Previous exploration draft restored. No cluster changes were made.",
    );
  }
  receiveProject.current = (project) => {
    if (
      exercise ||
      JSON.stringify(analysisFiles) !== JSON.stringify(source.files)
    ) {
      setPendingProject(project);
    } else adopt(project);
  };
  useEffect(() => {
    if (!connected) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await accountFetch("/api/project", {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok)
          throw Error(body.error || "Project synchronization failed.");
        if (!alive) return;
        setProjectSyncError("");
        if (
          body.selected &&
          body.selected.revision !== projectRevision.current
        ) {
          const project = importSnapshot(JSON.stringify(body.selected.project));
          projectRevision.current = body.selected.revision;
          receiveProject.current(project);
        }
      } catch (e) {
        if (alive)
          setProjectSyncError(
            "CLI project sync unavailable: " + (e as Error).message,
          );
      } finally {
        if (alive) timer = setTimeout(poll, 1500);
      }
    }
    void poll();
    return () => {
      alive = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, [connected]);
  function importContent(content: string, name = "imported.yaml") {
    try {
      if (
        content.trim().startsWith("{") &&
        content.includes("playground-snapshot-")
      )
        adopt(importSnapshot(content));
      else {
        const imported = [{ id: crypto.randomUUID(), name, content }];
        const parsed = parseSources(imported);
        if (parsed.diagnostics.length)
          throw Error(
            parsed.diagnostics
              .map((d) => `Line ${d.line}: ${d.message}`)
              .join("\n"),
          );
        if (parsed.resources.some((r) => r.kind === "Secret"))
          throw Error(
            "Do not import Secret values into the browser. Provide manifests with credentials removed.",
          );
        adopt(manifestProject(imported));
      }
    } catch (e) {
      setNotice((e as Error).message);
    }
  }
  async function checkpointCurrent() {
    const pending = exercise;
    if (!pending || !connected) return;
    const operation = queue.current.then(async () => {
      const response = await accountFetch("/api/practice", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Playground-Csrf": csrf.current,
        },
        body: JSON.stringify({
          exercise: { ...pending, operations: {} },
          project: source,
          expectedSavedRevision: savedRevisions.current.get(pending.id) ?? null,
        }),
      });
      const result = await response.json();
      if (!response.ok) throw Error(result.error);
      savedRevisions.current.set(pending.id, result.savedRevision);
    });
    queue.current = operation.catch(() => {});
    await operation;
  }
  const memoryExercises = useRef(new Map<string, Exercise>());
  async function leaveInvestigation() {
    if (exercise) memoryExercises.current.set(exercise.id, exercise);
    const identity = ++startIdentity.current;
    setBusy(true);
    try {
      await checkpointCurrent();
      if (connected && exercise) memoryExercises.current.delete(exercise.id);
    } catch (e) {
      setPersistence(
        "Checkpoint unavailable: " +
          (e as Error).message +
          " Draft retained in memory.",
      );
    }
    if (identity !== startIdentity.current) return;
    setExercise(null);
    setBusy(false);
    setNotice("");
    setHistoryRevision((n) => n + 1);
  }
  async function resumeInvestigation(id: string) {
    const identity = ++startIdentity.current;
    setBusy(true);
    setNotice("");
    try {
      const response = await accountFetch(
        "/api/practice?id=" + encodeURIComponent(id),
        { cache: "no-store" },
      );
      const saved = await response.json();
      if (!response.ok) throw Error(saved.error);
      if (startIdentity.current !== identity) return;
      savedRevisions.current.set(id, saved.savedRevision);
      setExercise(saved.exercise);
      setDestination("Practice");
      setPersistence(
        "Exercise recovered from local checkpoint. Original exercise source retained.",
      );
    } catch (e) {
      if (startIdentity.current === identity)
        setNotice("Resume unavailable: " + (e as Error).message);
    } finally {
      if (startIdentity.current === identity) setBusy(false);
    }
  }
  const namespaces = [
    ...new Set(ws.all.map((r) => r.namespace).filter((n): n is string => !!n)),
  ];
  const catalog = destination === "Practice" && !exercise;
  return (
    <>
      <QuestionDialog
        open={questionOpen}
        onOpenChange={setQuestionOpen}
        title={
          currentExercise
            ? "Ask for investigation guidance"
            : questionScope.resourceId
              ? "Ask about this resource"
              : "Ask about this project"
        }
        evidenceKey={
          source.id +
          ":" +
          snapshotDigest(source) +
          ":" +
          (currentExercise?.revision ?? "source")
        }
        scope={{
          ...questionScope,
          ...(currentExercise
            ? {
                exerciseId: currentExercise.id,
                exerciseRevision: currentExercise.revision,
              }
            : {}),
        }}
        disabledReason={
          ws.diagnostics.length
            ? "Fix malformed YAML before asking; the graph shows previous evidence."
            : currentExercise &&
                currentExercise.modelRevision !== currentExercise.revision
              ? "Check this repair draft before asking about its resulting modeled evidence."
              : !currentExercise &&
                  JSON.stringify(analysisFiles) !== JSON.stringify(source.files)
                ? "Save or revert your exploration edits before asking about this source project."
                : ""
        }
        onEvidence={(id) => {
          ws.setSelected(id);
          ws.setTab("YAML");
          setMobileInspector(true);
        }}
        prepare={async () => {
          await queue.current;
          if (currentExercise) {
            const r = await accountFetch("/api/practice", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                exercise: currentExercise,
                project: source,
                expectedSavedRevision:
                  savedRevisions.current.get(currentExercise.id) ?? null,
              }),
            });
            const d = await r.json();
            if (!r.ok) throw Error(d.error);
            savedRevisions.current.set(currentExercise.id, d.savedRevision);
            return undefined;
          }
          const r = await accountFetch("/api/project", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ kind: "select", project: source }),
          });
          const d = await r.json();
          if (!r.ok) throw Error(d.error);
          projectRevision.current = d.selected.revision;
          return d.selected.revision;
        }}
      />
      <WorkspaceLayout
        header={
          <AppHeader
            navigationTrigger={navigationTrigger}
            source={source}
            connected={connected}
            onImport={() => {
              setNotice("");
              setImportOpen(true);
            }}
            onAsk={() => {
              setQuestionScope({});
              setQuestionOpen(true);
            }}
            onExport={() =>
              save("snapshot.json", JSON.stringify(source, null, 2))
            }
            onConfigurePractice={() => setEndpointOpen(true)}
            saveError={
              currentExercise &&
              persistence &&
              ![
                "Saved",
                "Saving…",
                "Local checkpoint storage connected",
              ].includes(persistence) &&
              !persistence.startsWith("In-memory exploration;") &&
              !persistence.startsWith("Exercise recovered")
                ? persistence
                : undefined
            }
            onMenu={() => setNavigationOpen(!navigationOpen)}
          />
        }
        navigation={
          <>
            <div className="navigation-container">
              <AppSidebar
                destination={destination}
                collapsed={collapsed}
                onCollapse={() => setCollapsed(!collapsed)}
                onNavigate={navigate}
                resources={ws.visible}
                onSelect={select}
              />
            </div>
            <MobileNavigation
              triggerRef={navigationTrigger}
              open={navigationOpen}
              onOpenChange={setNavigationOpen}
            >
              <AppSidebar
                destination={destination}
                collapsed={false}
                onCollapse={() => setNavigationOpen(false)}
                onNavigate={navigate}
                resources={ws.visible}
                onSelect={(id) => {
                  select(id);
                  setNavigationOpen(false);
                }}
              />
            </MobileNavigation>
          </>
        }
      >
        {pendingProject && (
          <div className="notice" role="status">
            CLI selected {pendingProject.label}. Your current draft or exercise
            is unchanged.
            <Button
              variant="outline"
              onClick={() => openCliProject(pendingProject)}
            >
              Open CLI project
            </Button>
          </div>
        )}
        {retainedDrafts.length > 0 && (
          <div className="notice" role="status">
            Exploration drafts retained in memory.
            {retainedDrafts.map((draft) => (
              <Button
                key={draft.source.id}
                variant="outline"
                onClick={() => resumeDraft(draft)}
              >
                Resume draft: {draft.source.label}
              </Button>
            ))}
          </div>
        )}
        {projectSyncError && (
          <div className="notice" role="status">
            {projectSyncError} Current workspace retained.
          </div>
        )}
        <div
          className={
            "page-title " +
            (catalog || currentExercise ? "" : "exploration-title")
          }
        >
          <div>
            <h1>
              {catalog
                ? "Practice"
                : currentExercise
                  ? incidents.find((i) => i.id === currentExercise.scenario)!
                      .title
                  : destination}
            </h1>
            <p>
              {catalog
                ? "Investigate incidents in a safe copy of your environment."
                : currentExercise
                  ? incidents.find((i) => i.id === currentExercise.scenario)!
                      .symptom
                  : ""}
            </p>
          </div>
        </div>
        {notice && (
          <div
            role="status"
            className={
              "notice " + (exercise?.state === "completed" ? "pass" : "")
            }
          >
            {notice}
          </div>
        )}
        {catalog ? (
          <div className="catalog">
            <IncidentCatalog source={source} onStart={start} busy={busy} />
            {!connected && memoryExercises.current.size > 0 && (
              <section className="continue-learning">
                <h2>Continue learning in this browser</h2>
                {[...memoryExercises.current.values()].map((e) => (
                  <Button
                    key={e.id}
                    variant="outline"
                    onClick={() => {
                      setExercise(e);
                      setNotice("");
                    }}
                  >
                    Resume {incidents.find((i) => i.id === e.scenario)?.title}
                  </Button>
                ))}
              </section>
            )}
            <ContinueLearning
              connected={connected}
              refreshKey={historyRevision}
              onResume={resumeInvestigation}
              busy={busy}
            />
          </div>
        ) : (
          <>
            {currentExercise ? (
              <>
                <div className="objective-strip">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={leaveInvestigation}
                    disabled={busy}
                  >
                    <ArrowLeft size={14} />
                    Incidents
                  </Button>
                  <span>
                    <strong>Objective</strong>
                    {
                      incidents.find((i) => i.id === currentExercise.scenario)!
                        .objective
                    }
                  </span>
                  {persistence === "Saved" && (
                    <Badge variant="outline" aria-live="polite">
                      Saved
                    </Badge>
                  )}
                  <Badge variant="outline">
                    Attempt {currentExercise.attempt}
                  </Badge>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    onClick={reset}
                  >
                    <RotateCcw size={14} />
                    Restart
                  </Button>
                  <Button
                    size="sm"
                    onClick={repair}
                    disabled={busy || ws.diagnostics.length > 0}
                  >
                    <Check size={14} />
                    Check repair
                  </Button>
                </div>
                <Debrief exercise={currentExercise} />
              </>
            ) : null}
            <WorkspaceToolbar
              query={ws.query}
              onQuery={ws.setQuery}
              namespace={ws.namespace}
              onNamespace={ws.setNamespace}
              namespaces={namespaces}
              kind={ws.kind}
              onKind={ws.setKind}
              kinds={[...new Set(ws.all.map((r) => r.kind))].sort()}
              mode={
                destination === "Events"
                  ? "events"
                  : destination === "Manifest files"
                    ? "files"
                    : "resources"
              }
              count={
                destination === "Manifest files"
                  ? source.files.length
                  : destination === "Events"
                    ? source.resources.filter(
                        (r) =>
                          r.kind === "Event" &&
                          (ws.namespace === "all" ||
                            at(r, "metadata", "namespace") === ws.namespace),
                      ).length
                    : ws.visible.length
              }
              mobileInspector={mobileInspector}
              onMobileInspector={() => setMobileInspector(!mobileInspector)}
            />
            <div
              className={
                "workspace " + (mobileInspector ? "inspect-mobile" : "")
              }
            >
              <ResizablePanelGroup orientation="horizontal">
                <ResizablePanel defaultSize="70%" minSize="35%">
                  <div className="primary-surface">
                    {!ws.visible.length &&
                    destination !== "Events" &&
                    destination !== "Manifest files" ? (
                      <div className="empty">
                        <Boxes />
                        <strong>No resources in this view</strong>
                        <p>
                          Adjust namespace or resource filters, or import
                          manifest files.
                        </p>
                      </div>
                    ) : destination === "Topology" || currentExercise ? (
                      <ResourceGraph
                        key={currentExercise?.id ?? source.id}
                        resources={ws.visible.filter(
                          (r) =>
                            r.kind !== "Event" && r.kind !== "EndpointSlice",
                        )}
                        relationships={relations.filter(
                          (e) =>
                            ws.visible.some((r) => r.id === e.from) &&
                            ws.visible.some((r) => r.id === e.to),
                        )}
                        initialPositions={positions.current.get(
                          currentExercise?.id ?? source.id,
                        )}
                        onPositionsChange={(p) =>
                          positions.current.set(
                            currentExercise?.id ?? source.id,
                            p,
                          )
                        }
                        initialViewport={viewports.current.get(
                          currentExercise?.id ?? source.id,
                        )}
                        onViewportChange={(v) =>
                          viewports.current.set(
                            currentExercise?.id ?? source.id,
                            v,
                          )
                        }
                        selected={ws.resource?.id ?? null}
                        onSelect={select}
                        onRelationship={(id) => {
                          const rel = relations.find((r) => r.id === id);
                          if (rel) {
                            ws.setSelected(rel.from);
                            ws.setTab("Overview");
                            setFocusRelationship(id);
                            setMobileInspector(true);
                          }
                        }}
                        observation={observed}
                        provenance={
                          currentExercise
                            ? "Synthetic practice state + inferred relationships"
                            : source.origin === "bundled"
                              ? "Bundled reference + inferred relationships"
                              : "Captured snapshot + inferred relationships"
                        }
                        endpointCoverage={(ns) =>
                          !!currentExercise ||
                          coverage(source, "EndpointSlice", ns)?.state ===
                            "captured"
                        }
                        stale={ws.diagnostics.length > 0}
                      />
                    ) : destination === "Resources" ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Resource</TableHead>
                            <TableHead>Kind</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {ws.visible.map((r) => (
                            <TableRow key={r.id}>
                              <TableCell>
                                <Button
                                  variant="link"
                                  onClick={() => select(r.id)}
                                >
                                  {r.name}
                                </Button>
                              </TableCell>
                              <TableCell>{r.kind}</TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : destination === "Events" ? (
                      <div className="pane-padding">
                        <h2>Captured events</h2>
                        {source.resources.filter(
                          (r) =>
                            r.kind === "Event" &&
                            (ws.namespace === "all" ||
                              at(r, "metadata", "namespace") === ws.namespace),
                        ).length ? (
                          source.resources
                            .filter(
                              (r) =>
                                r.kind === "Event" &&
                                (ws.namespace === "all" ||
                                  at(r, "metadata", "namespace") ===
                                    ws.namespace),
                            )
                            .map((e, i) => (
                              <div className="event" key={i}>
                                <strong>{text(e.reason)}</strong>
                                <p>{text(e.message)}</p>
                                <small>
                                  {text(e.lastTimestamp) ||
                                    "Timestamp unavailable"}
                                </small>
                                <Button
                                  variant="link"
                                  onClick={() => {
                                    const target = ws.all.find(
                                      (r) =>
                                        at(r.raw, "metadata", "uid") ===
                                        at(e, "involvedObject", "uid"),
                                    );
                                    if (target) {
                                      select(target.id);
                                      ws.setTab("Events");
                                    }
                                  }}
                                >
                                  Inspect resource
                                </Button>
                              </div>
                            ))
                        ) : (
                          <div className="empty">
                            <strong>Events unavailable or not captured</strong>
                            <p>
                              Omitted access does not mean no failures. See
                              capture coverage and timestamps.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="pane-padding">
                        <h2>Authored manifest files</h2>
                        {source.files.length ? (
                          source.files.map((f) => (
                            <Button
                              key={f.id}
                              variant="ghost"
                              className="file-row"
                              onClick={() => {
                                const r = ws.all.find(
                                  (r) => r.source.fileId === f.id,
                                );
                                if (r) {
                                  ws.setSelected(r.id);
                                  ws.setTab("YAML");
                                  setMobileInspector(true);
                                }
                              }}
                            >
                              <FileCode2 size={16} />
                              {f.name}
                            </Button>
                          ))
                        ) : (
                          <p>
                            No authored files were included. Captured resources
                            have API YAML only.
                          </p>
                        )}
                        <p className="muted">
                          Generated Pods and EndpointSlices do not receive
                          invented original manifest files.
                        </p>
                      </div>
                    )}
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize="30%" minSize="25%">
                  {ws.resource ? (
                    <ResourceInspector
                      onAsk={
                        account.status?.enabled
                          ? () => {
                              setQuestionScope({
                                resourceId: ws.resource?.id,
                                relationshipId: focusRelationship ?? undefined,
                              });
                              setQuestionOpen(true);
                            }
                          : undefined
                      }
                      onClose={() => {
                        ws.setSelected(null);
                        setMobileInspector(false);
                      }}
                      focusRelationship={focusRelationship}
                      editorContexts={editorContexts.current}
                      resource={ws.resource}
                      source={displayedSource}
                      files={files}
                      exercise={currentExercise}
                      tab={ws.tab}
                      onTab={ws.setTab}
                      onSelect={ws.setSelected}
                      onEdit={edit}
                      onHint={() =>
                        currentExercise &&
                        setExercise({
                          ...currentExercise,
                          hintsRevealed: Math.min(
                            3,
                            currentExercise.hintsRevealed + 1,
                          ),
                        })
                      }
                      diagnostics={ws.diagnostics}
                      relationships={[
                        ...analysis.relationships.filter(
                          (r) => r.kind !== "owns",
                        ),
                        ...relations.filter((r) => r.kind === "owns"),
                      ].filter(
                        (r) =>
                          r.from === ws.resource?.id ||
                          r.to === ws.resource?.id,
                      )}
                      resources={ws.all}
                    />
                  ) : (
                    <div className="empty">Select a resource</div>
                  )}
                </ResizablePanel>
              </ResizablePanelGroup>
            </div>
          </>
        )}
      </WorkspaceLayout>
      <ImportDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        onContent={importContent}
        onProject={adopt}

        error={notice}
        onError={setNotice}
      />
      <Dialog open={!!incompatible} onOpenChange={() => setIncompatible(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>This snapshot is incompatible</DialogTitle>
            <DialogDescription>
              Required evidence or relationships are missing. The imported
              project will not be replaced automatically.
            </DialogDescription>
          </DialogHeader>
          <ul>
            {incompatible?.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIncompatible(null)}>
              Keep project
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <EndpointContractDialog
        open={endpointOpen}
        onOpenChange={setEndpointOpen}
        source={source}
        onDeclare={setSource}
      />
    </>
  );
}
