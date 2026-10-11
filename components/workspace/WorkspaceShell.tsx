"use client";
import { Sparkles } from "lucide-react";
import { ManifestFileEditor } from "./ManifestFileEditor";
import { useState, useMemo, useCallback, useRef, useEffect } from "react";
import { Boxes, FileCode2 } from "lucide-react";
import type { Viewport } from "@xyflow/react";
import { SecretsVault } from "@/components/configuration/SecretsVault";
import { LivePractice } from "@/components/practice/LivePractice";
import { QuestionDialog } from "@/components/auth/QuestionDialog";
import { useAccount } from "@/components/auth/AccountProvider";
import { Button } from "@/components/ui/button";
import { MobileNavigation } from "@/components/shell/MobileNavigation";
import { AppHeader } from "@/components/shell/AppHeader";
import { AppSidebar, destinations } from "@/components/shell/AppSidebar";
import { WorkspaceLayout } from "@/components/shell/WorkspaceLayout";
import { WorkspaceToolbar } from "./WorkspaceToolbar";
import {
  graphProjection,
  resourcePresentation,
  resourceOrigin,
} from "@/lib/domain/presentation";
import { ImportDialog } from "./ImportDialog";
import { EndpointContractDialog } from "@/components/practice/EndpointContractDialog";
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
import { ResourceTree } from "./ResourceTree";
import { ResourceInspector } from "./ResourceInspector";
import { useProjectWorkspace } from "./useProjectWorkspace";
import {
  importSnapshot,
  manifestProject,
  snapshotDigest,
  coverage,
  type Snapshot,
} from "@/lib/domain/snapshot";
import { analyze } from "@/lib/domain/analyzer";
import {
  at,
  text,
  type SourceFile,
  type Observation,
} from "@/lib/domain/types";
import {
  analysisFilesDigest,
  draftKey,
  readDraft,
  writeDraft,
} from "@/lib/ui/analysis-drafts";
import { resourceAge } from "@/lib/ui/inspection";
import example from "@/examples/storefront/snapshot.json";
const bundled = importSnapshot(JSON.stringify(example));
function download(name: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function WorkspaceShell() {
  const account = useAccount();
  return (
    <ProfileWorkspace key={account.status?.profile?.key ?? "signed-out"} />
  );
}
function ProfileWorkspace() {
  const account = useAccount(),
    accountFetch = account.request;
  const profileKey = account.status?.profile?.key ?? "signed-out";
  const initialRoute = useRef(
    typeof window === "undefined" ? null : new URL(window.location.href),
  );
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [source, setSource] = useState<Snapshot>(bundled),
    [analysisFiles, setAnalysisFiles] = useState<SourceFile[]>(bundled.files),
    [savedFiles, setSavedFiles] = useState<SourceFile[]>(bundled.files);
  const [destination, setDestination] = useState("Topology"),
    [environment, setEnvironment] = useState<"source" | "lab">("source");
  const [notice, setNotice] = useState(""),
    [projectSyncError, setProjectSyncError] = useState(""),
    [pendingProject, setPendingProject] = useState<Snapshot | null>(null);
  const [importOpen, setImportOpen] = useState(false),
    [endpointOpen, setEndpointOpen] = useState(false),
    [questionOpen, setQuestionOpen] = useState(false),
    [questionScope, setQuestionScope] = useState<{
      resourceId?: string;
      relationshipId?: string;
    }>({});
  const [askRequest, setAskRequest] = useState(0),
    [collapsed, setCollapsed] = useState(false),
    [navigationOpen, setNavigationOpen] = useState(false),
    [mobileInspector, setMobileInspector] = useState(false),
    [focusRelationship, setFocusRelationship] = useState<string | null>(null),
    [connected, setConnected] = useState(false);
  const [labAvailable, setLabAvailable] = useState(false);
  const receiveLabContext = useCallback(
    (value: { available: boolean }) => setLabAvailable(value.available),
    [],
  );
  const projectRevision = useRef<string | null>(null),
    projectMutationEpoch = useRef(0),
    projectMutationPending = useRef(false),
    sourceRef = useRef(source),
    filesRef = useRef(analysisFiles),
    receiveProject = useRef<(s: Snapshot) => void>(() => {}),
    navigationTrigger = useRef<HTMLButtonElement | null>(null);
  sourceRef.current = source;
  filesRef.current = analysisFiles;
  const positions = useRef(
      new Map<string, Record<string, { x: number; y: number }>>(),
    ),
    viewports = useRef(new Map<string, Viewport>()),
    editorContexts = useRef(
      new Map<string, import("./SourceEditor").EditorContext>(),
    );
  const activeLab =
    destination !== "Secrets / Vault" &&
    (destination === "Practice" || environment === "lab");
  const ws = useProjectWorkspace(
    source,
    analysisFiles,
    profileKey + ":" + source.id,
  );
  const analysis = useMemo(() => analyze(ws.all), [ws.all]);
  const relations = useMemo(
    () => graphProjection(ws.all, analysis.relationships, source),
    [ws.all, analysis, source],
  );
  useEffect(() => {
    if (!focusRelationship) return;
    const relationship = relations.find((r) => r.id === focusRelationship);
    if (
      !relationship ||
      (relationship.from !== ws.selected && relationship.to !== ws.selected)
    )
      setFocusRelationship(null);
  }, [relations, ws.selected, focusRelationship]);
  const observed: Observation | null = source.resources.length
    ? {
        sessionId: source.id,
        generation: 1,
        revision: 0,
        sequence: 0,
        capturedAt: source.captureEndedAt ?? "",
        resources: source.resources,
        errors: source.errors,
      }
    : null;
  const dirty = JSON.stringify(analysisFiles) !== JSON.stringify(savedFiles),
    modified = JSON.stringify(analysisFiles) !== JSON.stringify(source.files);
  const sourceKey = profileKey + ":" + source.id + ":" + snapshotDigest(source);
  const analysisKey = draftKey(
    profileKey,
    source.id + ":files:" + analysisFilesDigest(source.files),
  );
  const [draftReady, setDraftReady] = useState("");
  const [recentProjects, setRecentProjects] = useState<Snapshot[]>([]);
  const [catalogReady, setCatalogReady] = useState(false);
  useEffect(() => {
    try {
      const json = localStorage.getItem("waypoint:projects:v1:" + profileKey);
      const items = json ? JSON.parse(json) : [];
      setRecentProjects(
        Array.isArray(items)
          ? items.slice(0, 4).map((p) => importSnapshot(JSON.stringify(p)))
          : [],
      );
    } catch {
      setRecentProjects([]);
    }
    setCatalogReady(true);
  }, [profileKey]);
  useEffect(() => {
    if (!catalogReady) return;
    setRecentProjects((previous) =>
      [source, ...previous.filter((p) => p.id !== source.id)].slice(0, 4),
    );
  }, [catalogReady, source]);
  useEffect(() => {
    if (!catalogReady) return;
    try {
      localStorage.setItem(
        "waypoint:projects:v1:" + profileKey,
        JSON.stringify(recentProjects),
      );
    } catch {
      setNotice(
        "Recent-project storage is full. Current drafts remain available; export drafts before closing.",
      );
    }
  }, [catalogReady, recentProjects, profileKey]);
  useEffect(() => {
    const draft =
      readDraft(localStorage, analysisKey, source.files) ??
      readDraft(
        localStorage,
        draftKey(profileKey, source.id + ":" + snapshotDigest(source)),
        source.files,
      );
    setAnalysisFiles(draft?.files ?? source.files);
    setSavedFiles(draft?.savedFiles ?? source.files);
    setDraftReady(analysisKey);
  }, [analysisKey]);
  useEffect(() => {
    if (draftReady !== analysisKey) return;
    try {
      writeDraft(localStorage, analysisKey, {
        files: analysisFiles,
        savedFiles,
        updatedAt: new Date().toISOString(),
      });
    } catch {
      setNotice(
        "Draft storage is full or unavailable. Export your draft before closing this browser.",
      );
    }
  }, [analysisFiles, savedFiles, draftReady, analysisKey]);
  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    const restore = () => {
      const url = new URL(location.href);
      const next = url.searchParams.get("view");
      if (destinations.some((d) => d.name === next)) setDestination(next!);
      setSelectedFile(url.searchParams.get("file"));
      setEnvironment(
        url.searchParams.get("environment") === "lab" ? "lab" : "source",
      );
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => window.removeEventListener("popstate", restore);
  }, []);
  function navigate(name: string) {
    if (name === "Practice") setEnvironment("lab");
    setDestination(name);
    setNotice("");
    setMobileInspector(false);
    setNavigationOpen(false);
    const url = new URL(location.href);
    url.searchParams.set("view", name);
    url.searchParams.set(
      "environment",
      name === "Practice" ? "lab" : environment,
    );
    history.pushState(null, "", url);
  }
  const select = useCallback(
    (id: string) => {
      ws.setSelected(id);
      ws.setTab("Overview");
      setFocusRelationship(null);
      setMobileInspector(true);
    },
    [ws.setSelected, ws.setTab],
  );
  function adopt(project: Snapshot, restoreInitialRoute = false) {
    // Each project's drafts are persisted independently before changing source.
    setFocusRelationship(null);
    setSource(project);
    setAnalysisFiles(project.files);
    setSavedFiles(project.files);
    setPendingProject(null);
    setImportOpen(false);
    setEndpointOpen(false);
    const restored = restoreInitialRoute ? initialRoute.current : null;
    setSelectedFile(restored?.searchParams.get("file") ?? null);
    setEnvironment(
      restored?.searchParams.get("environment") === "lab" ? "lab" : "source",
    );
    const view = restored?.searchParams.get("view");
    setDestination(
      view && destinations.some((d) => d.name === view) ? view : "Topology",
    );
    setQuestionOpen(false);
    setLabAvailable(false);
    setNotice("");
    if (restored) history.replaceState(null, "", restored);
    else {
      const url = new URL(location.href);
      url.searchParams.set("view", "Topology");
      url.searchParams.set("environment", "source");
      for (const p of ["selected", "namespace", "kind", "query", "tab"])
        url.searchParams.delete(p);
      history.pushState(null, "", url);
    }
  }
  receiveProject.current = (project) => {
    if (snapshotDigest(project) === snapshotDigest(sourceRef.current)) return;
    if (modified || activeLab) setPendingProject(project);
    else adopt(project);
  };
  useEffect(() => {
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();
    async function poll() {
      const epoch = projectMutationEpoch.current;
      try {
        const response = await accountFetch("/api/project", {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.json();
        if (!response.ok)
          throw Error(body.error || "Project synchronization failed.");
        if (
          !alive ||
          projectMutationPending.current ||
          epoch !== projectMutationEpoch.current
        )
          return;
        setConnected(true);
        setProjectSyncError("");
        if (
          body.selected &&
          body.selected.revision !== projectRevision.current
        ) {
          const firstSelection = projectRevision.current === null;
          projectRevision.current = body.selected.revision;
          const project = importSnapshot(JSON.stringify(body.selected.project));
          if (
            firstSelection &&
            JSON.stringify(filesRef.current) ===
              JSON.stringify(sourceRef.current.files)
          ) {
            adopt(
              project,
              initialRoute.current?.searchParams.get("workspace") ===
                profileKey + ":" + project.id,
            );
          } else receiveProject.current(project);
        }
      } catch (e) {
        if (
          alive &&
          !projectMutationPending.current &&
          epoch === projectMutationEpoch.current
        ) {
          setConnected(false);
          setProjectSyncError((e as Error).message);
        }
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
  }, [accountFetch, profileKey]);
  async function persistProject(project: Snapshot) {
    if (projectMutationPending.current)
      throw Error(
        "A project change is already saving. Please retry when it finishes.",
      );
    projectMutationPending.current = true;
    const epoch = ++projectMutationEpoch.current;
    try {
      const response = await accountFetch("/api/project", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "select", project }),
      });
      const body = await response.json();
      if (!response.ok)
        throw Error(body.error || "Project could not be saved. Please retry.");
      if (epoch !== projectMutationEpoch.current)
        throw Error("Project changed while saving. Please retry.");
      projectRevision.current = body.selected.revision;
      return {
        project: importSnapshot(JSON.stringify(body.selected.project)),
        revision: body.selected.revision as string,
      };
    } finally {
      // Invalidate polls begun both before and during this write.
      projectMutationEpoch.current++;
      projectMutationPending.current = false;
    }
  }
  async function selectImportedProject(project: Snapshot) {
    adopt((await persistProject(project)).project);
  }
  function editFile(id: string, value: string) {
    setAnalysisFiles((fs) =>
      fs.map((f) => (f.id === id ? { ...f, content: value } : f)),
    );
  }
  function saveDraft() {
    if (ws.diagnostics.length) {
      setNotice("Fix YAML errors before saving. Your text is retained.");
      return;
    }
    setSavedFiles(analysisFiles);
    setNotice(
      "Analysis draft saved locally. Original manifests and cluster unchanged.",
    );
  }
  function revertDraft() {
    if (
      dirty &&
      !window.confirm(
        "Discard unsaved edits and return to your last saved analysis draft?",
      )
    )
      return;
    setAnalysisFiles(savedFiles);
    setNotice("Reverted to saved draft.");
  }
  function exportDraft() {
    download(
      "analysis-draft.json",
      JSON.stringify(
        {
          ...source,
          files: analysisFiles,
          resources: [],
          origin: "manifests",
          captureStartedAt: null,
          captureEndedAt: null,
          coverage: [],
          errors: [],
        },
        null,
        2,
      ),
    );
  }
  const activeFile =
    destination === "Manifest files"
      ? (analysisFiles.find((f) => f.id === selectedFile) ?? analysisFiles[0])
      : undefined;
  const namespaces = [
    ...new Set(ws.all.map((r) => r.namespace).filter((n): n is string => !!n)),
  ];
  return (
    <>
      <Button
        size="icon"
        className="fixed bottom-6 right-6 z-40 size-14 rounded-full shadow-lg"
        aria-label="Ask ChatGPT"
        title="Ask ChatGPT"
        onClick={() => {
          if (activeLab && labAvailable) setAskRequest((n) => n + 1);
          else {
            setQuestionScope({});
            setQuestionOpen(true);
          }
        }}
      >
        <Sparkles className="size-6" />
      </Button>
      <QuestionDialog
        retentionKey={snapshotDigest(source)}
        open={questionOpen}
        onOpenChange={setQuestionOpen}
        title={questionScope.resourceId ? "Ask about this resource" : "ChatGPT"}
        evidenceKey={sourceKey}
        scope={questionScope}
        disabledReason={
          ws.diagnostics.length
            ? "Fix malformed YAML; the graph still shows the previous valid revision."
            : modified
              ? "Analysis drafts are not imported evidence. Revert or import the draft as a separate project before asking."
              : ""
        }
        onEvidence={(id) => {
          select(id);
          ws.setTab("YAML");
          setMobileInspector(true);
        }}
        prepare={async () => (await persistProject(source)).revision}
      />
      <WorkspaceLayout
        header={
          <AppHeader
            navigationTrigger={navigationTrigger}
            source={source}
            labAvailable={labAvailable}
            recentProjects={recentProjects}
            onProject={(project) => {
              void selectImportedProject(project).catch((e) =>
                setNotice(e.message),
              );
            }}
            environment={activeLab ? "lab" : "source"}
            connected={connected}
            onEnvironment={(value) => {
              setEnvironment(value);
              if (value === "source" && destination === "Practice")
                navigate("Topology");
              const url = new URL(location.href);
              url.searchParams.set("environment", value);
              history.replaceState(null, "", url);
            }}
            onImport={() => {
              setNotice("");
              setImportOpen(true);
            }}
            onExport={() =>
              download("original-source.json", JSON.stringify(source, null, 2))
            }
            onConfigurePractice={() => setEndpointOpen(true)}
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
            CLI selected {pendingProject.label}.{" "}
            <Button variant="outline" onClick={() => adopt(pendingProject)}>
              Open CLI project
            </Button>{" "}
            Current drafts remain saved to this project.
          </div>
        )}
        {projectSyncError && (
          <div className="notice" role="status">
            Project connection unavailable: {projectSyncError}. Current evidence
            retained.
          </div>
        )}
        <div
          className={
            "page-title " +
            (destination === "Practice" ? "" : "exploration-title")
          }
        >
          <h1>{destination}</h1>
        </div>
        {notice && (
          <div className="notice" role="status">
            {notice}
          </div>
        )}
        {destination === "Secrets / Vault" ? (
          <SecretsVault
            project={source}
            revision={projectRevision.current ?? undefined}
          />
        ) : activeLab ? (
          <LivePractice
            key={profileKey + ":" + source.id + ":" + snapshotDigest(source)}
            project={source}
            destination={destination}
            askRequest={askRequest}
            onContext={receiveLabContext}
          />
        ) : (
          <>
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
                  : ws.visible.length
              }
              mobileInspector={mobileInspector}
              onMobileInspector={() => setMobileInspector(!mobileInspector)}
            />
            {ws.revealedFilters && (
              <div className="pane-padding text-sm">
                Filters adjusted to reveal the selected resource.{" "}
                <Button size="sm" variant="link" onClick={ws.restoreFilters}>
                  Restore filters
                </Button>
              </div>
            )}
            <div
              className={
                "workspace " + (mobileInspector ? "inspect-mobile" : "")
              }
            >
              <ResizablePanelGroup orientation="horizontal">
                <ResizablePanel defaultSize="70%" minSize="35%">
                  <div className="primary-surface">
                    {destination === "Topology" ? (
                      !ws.visible.length ? (
                        <div className="empty">
                          <Boxes />
                          <strong>No resources in this view</strong>
                          <p>Adjust filters or import manifest files.</p>
                        </div>
                      ) : (
                        <div className="source-topology">
                          <ResourceTree
                            resources={ws.visible.filter(
                              (r) => r.kind !== "Event",
                            )}
                            source={source}
                            observation={observed}
                            selected={ws.resource?.id ?? null}
                            onSelect={select}
                          />
                          <ResourceGraph
                            key={source.id}
                            resources={ws.visible.filter(
                              (r) => r.kind !== "Event",
                            )}
                            relationships={relations.filter(
                              (e) =>
                                ws.visible.some((r) => r.id === e.from) &&
                                ws.visible.some((r) => r.id === e.to),
                            )}
                            initialPositions={positions.current.get(source.id)}
                            onPositionsChange={(p) =>
                              positions.current.set(source.id, p)
                            }
                            initialViewport={viewports.current.get(source.id)}
                            onViewportChange={(v) =>
                              viewports.current.set(source.id, v)
                            }
                            selected={ws.resource?.id ?? null}
                            onSelect={select}
                            onRelationship={(id) => {
                              const rel = relations.find((r) => r.id === id);
                              if (rel) {
                                ws.setSelected(rel.from);
                                ws.setTab("Relationships");
                                setFocusRelationship(id);
                                setMobileInspector(true);
                              }
                            }}
                            observation={observed}
                            endpointCoverage={(ns) =>
                              coverage(source, "EndpointSlice", ns)?.state ===
                              "captured"
                            }
                            stale={ws.diagnostics.length > 0}
                          />
                        </div>
                      )
                    ) : destination === "Resources" ? (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>Resource</TableHead>
                            <TableHead>Namespace</TableHead>
                            <TableHead>Kind</TableHead>
                            <TableHead>Status</TableHead>
                            <TableHead>Age</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {ws.visible.map((r) => (
                            <TableRow key={r.id}>
                              <TableCell>
                                <Button
                                  variant="link"
                                  onClick={() => select(r.id)}
                                  title={`${resourceOrigin(r, source)} · UID ${text(at(r.raw, "metadata", "uid")) || "unavailable"}`}
                                >
                                  {r.name}
                                </Button>
                              </TableCell>
                              <TableCell>{r.namespace ?? "Cluster"}</TableCell>
                              <TableCell>{r.kind}</TableCell>
                              <TableCell>
                                {
                                  resourcePresentation(
                                    r,
                                    observed,
                                    coverage(
                                      source,
                                      "EndpointSlice",
                                      r.namespace,
                                    )?.state === "captured",
                                  ).label
                                }
                              </TableCell>
                              <TableCell>
                                {resourceAge(r.raw, source.captureEndedAt)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    ) : destination === "Events" ? (
                      <div className="pane-padding">
                        <h2>Captured events</h2>
                        {source.resources
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
                                  text(e.eventTime) ||
                                  "Timestamp unavailable"}{" "}
                                · {text(at(e, "metadata", "namespace"))} ·{" "}
                                {text(e.type)} ·{" "}
                                {text(at(e, "source", "component"))}
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
                          ))}
                        {!source.resources.some((r) => r.kind === "Event") && (
                          <div className="empty">
                            <strong>Events unavailable or not captured</strong>
                            <p>
                              Missing evidence does not establish healthy state.
                            </p>
                          </div>
                        )}
                      </div>
                    ) : (
                      <div className="pane-padding">
                        <h2>Manifest files</h2>
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
                                setSelectedFile(f.id);
                                if (r) {
                                  select(r.id);
                                  ws.setTab("YAML");
                                }
                                setMobileInspector(true);
                                const url = new URL(location.href);
                                url.searchParams.set("file", f.id);
                                history.replaceState(null, "", url);
                              }}
                            >
                              <FileCode2 size={16} />
                              {f.name}
                              {analysisFiles.find((d) => d.id === f.id)
                                ?.content !==
                              savedFiles.find((d) => d.id === f.id)?.content
                                ? " · unsaved"
                                : ""}
                            </Button>
                          ))
                        ) : (
                          <p>
                            No authored files included. Generated resources
                            expose captured API YAML.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </ResizablePanel>
                <ResizableHandle withHandle />
                <ResizablePanel defaultSize="30%" minSize="25%">
                  {activeFile ? (
                    <ManifestFileEditor
                      file={activeFile}
                      projectId={source.id}
                      dirty={dirty}
                      diagnostics={ws.diagnostics}
                      contexts={editorContexts.current}
                      onEdit={editFile}
                      onSave={saveDraft}
                      onRevert={revertDraft}
                      onExport={exportDraft}
                      onClose={() => setMobileInspector(false)}
                    />
                  ) : ws.resource ? (
                    <ResourceInspector
                      resource={ws.resource}
                      source={source}
                      files={analysisFiles}
                      exercise={null}
                      tab={ws.tab}
                      onTab={ws.setTab}
                      onSelect={select}
                      onEdit={editFile}
                      onHint={() => {}}
                      diagnostics={ws.diagnostics}
                      relationships={relations.filter(
                        (r) =>
                          r.from === ws.resource?.id ||
                          r.to === ws.resource?.id,
                      )}
                      resources={ws.all}
                      editorContexts={editorContexts.current}
                      focusRelationship={focusRelationship}
                      onClose={() => {
                        ws.setSelected(null);
                        setFocusRelationship(null);
                        setMobileInspector(false);
                      }}
                      draftDirty={dirty}
                      onSave={saveDraft}
                      onRevert={revertDraft}
                      onExportDraft={exportDraft}
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
        onProject={selectImportedProject}
        error={notice}
        onError={setNotice}
      />
      <EndpointContractDialog
        key={analysisKey}
        open={endpointOpen}
        onOpenChange={setEndpointOpen}
        source={source}
        onDeclare={async (project) => {
          setSource((await persistProject(project)).project);
        }}
      />
    </>
  );
}
