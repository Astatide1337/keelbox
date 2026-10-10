"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Upload,
  ChevronLeft,
  ChevronRight,
  Play,
  RotateCcw,
  Check,
  Square,
  Terminal,
  ArrowUpRight,
  BookOpen,
  AlertTriangle,
  Network,
  PanelRight,
  Settings,
  X,
  Download,
  Link2,
} from "lucide-react";
import { stringify } from "yaml";
import type { EditorView } from "@codemirror/view";
import { SourceEditor } from "./SourceEditor";
import { ResourceGraph } from "./ResourceGraph";
import { parseSources } from "@/lib/domain/importer";
import { analyze } from "@/lib/domain/analyzer";
import {
  at,
  list,
  object,
  text,
  type LabView,
  type Resource,
  type SourceFile,
  type ScenarioId,
  type EvidenceRef,
} from "@/lib/domain/types";
import { fixtureSource, scenarios } from "@/lib/domain/scenarios";
const initial: SourceFile[] = [
  {
    id: "lesson",
    name: "service-selector.yaml",
    content: fixtureSource("service-selector"),
  },
];
function download(name: string, content: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type: "text/plain" }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 500);
}
export function Workspace() {
  const [files, setFiles] = useState(initial),
    [activeFile, setActiveFile] = useState("lesson"),
    [valid, setValid] = useState(() => parseSources(initial)),
    [selected, setSelected] = useState<string | null>(null),
    [edgeId, setEdgeId] = useState<string | null>(null),
    [nav, setNav] = useState(true),
    [panelWidth, setPanelWidth] = useState(420),
    [panel, setPanel] = useState<"source" | "inspect" | "events" | "logs">(
      "source",
    ),
    [mobileView, setMobileView] = useState<"graph" | "source">("graph"),
    [scenario, setScenario] = useState<ScenarioId>("service-selector"),
    [lab, setLab] = useState<LabView | null>(null),
    [connected, setConnected] = useState(false),
    [connectionError, setConnectionError] = useState(""),
    [notice, setNotice] = useState(""),
    [hint, setHint] = useState(-1),
    [pending, setPending] = useState(false),
    [inspection, setInspection] = useState(""),
    [importOpen, setImportOpen] = useState(false),
    [paste, setPaste] = useState(""),
    [settings, setSettings] = useState(false),
    [aiEnabled, setAiEnabled] = useState(false),
    [aiText, setAiText] = useState(""),
    [accounts, setAccounts] = useState<
      { id: string; label: string; active: boolean; planEnabled: boolean }[]
    >([]),
    [models, setModels] = useState<{ id: string; name: string }[]>([]),
    [model, setModel] = useState(""),
    [pod, setPod] = useState(""),
    [snapshot, setSnapshot] = useState<{
      capturedAt: string;
      errors: unknown[];
    } | null>(null);
  const csrf = useRef(""),
    labRef = useRef<LabView | null>(null),
    draft = useRef(false),
    adoptReset = useRef(false),
    view = useRef<EditorView | null>(null),
    importDialog = useRef<HTMLDialogElement>(null),
    settingsDialog = useRef<HTMLDialogElement>(null),
    fileInput = useRef<HTMLInputElement>(null);
  const parsed = useMemo(() => parseSources(files), [files]);
  const stale = parsed.diagnostics.length > 0;
  const analysis = useMemo(() => analyze(valid.resources), [valid]);
  const resource =
    valid.resources.find((r) => r.id === selected) ?? valid.resources[0];
  const edge =
    analysis.relationships.find((e) => e.id === edgeId) ??
    analysis.findings.find(
      (e) => e.from === resource?.id || e.to === resource?.id,
    ) ??
    analysis.relationships.find(
      (e) => e.from === resource?.id || e.to === resource?.id,
    );
  const refs = useMemo(
    () => edge?.evidence ?? (resource ? [resource.source] : []),
    [edge, resource],
  );
  const ranges = useMemo(
    () =>
      refs
        .filter((r) => r.fileId === activeFile)
        .map((r) => ({ start: r.start, end: r.end })),
    [refs, activeFile],
  );
  const file = files.find((f) => f.id === activeFile) ?? files[0];
  const running = !!lab && lab.state !== "stopped";
  const busy = pending || !!lab?.operation;
  const runtimeFresh =
    connected &&
    !lab?.error &&
    !!lab?.observation &&
    !lab.observation.errors.length &&
    Date.now() - Date.parse(lab.observation.capturedAt) < 12000;
  useEffect(() => {
    if (!parsed.diagnostics.length) setValid(parsed);
  }, [parsed]);
  const selectResource = useCallback((id: string) => {
    setSelected(id);
    setEdgeId(null);
  }, []);
  const selectEdge = useCallback((id: string) => {
    setEdgeId(id);
    setPanel("source");
  }, []);
  const changeSource = useCallback(
    (value: string) => {
      setFiles((f) =>
        f.map((x) => (x.id === activeFile ? { ...x, content: value } : x)),
      );
      draft.current = true;
    },
    [activeFile],
  );
  async function api(path: string, body?: unknown) {
    const r = await fetch(path, {
      method: body ? "POST" : "GET",
      headers: body
        ? {
            "Content-Type": "application/json",
            "X-Playground-CSRF": csrf.current,
          }
        : {},
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error ?? "Local request failed.");
    return data;
  }
  const sync = useCallback(async () => {
    try {
      const d = await fetch("/api/session").then(async (r) => {
        if (!r.ok)
          throw new Error(
            "Connect the local workspace using the one-time link printed by pnpm dev.",
          );
        return r.json();
      });
      csrf.current = d.csrf;
      setConnected(true);
      setConnectionError("");
      setAiEnabled(d.aiEnabled);
      const next: LabView | null = d.lab;
      const previous = labRef.current;
      if (
        next &&
        previous?.id === next.id &&
        (next.generation < previous.generation ||
          (next.generation === previous.generation &&
            next.revision < previous.revision))
      )
        return;
      if (
        next &&
        (previous?.id !== next.id ||
          (adoptReset.current && !next.operation && next.state === "running"))
      ) {
        setFiles([
          { id: "lesson", name: next.scenario + ".yaml", content: next.source },
        ]);
        setActiveFile("lesson");
        draft.current = false;
        adoptReset.current = false;
        setSnapshot(null);
        setHint(-1);
        setScenario(next.scenario);
      }
      labRef.current = next;
      setLab(next);
    } catch (e) {
      setConnected(false);
      setConnectionError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    let cancelled = false;
    async function connect() {
      const url = new URL(location.href);
      const bootstrap = url.searchParams.get("connect");
      if (bootstrap) {
        try {
          const r = await fetch("/api/session", {
            method: "POST",
            headers: { "X-Playground-Bootstrap": bootstrap },
          });
          if (!r.ok)
            throw new Error(
              "Connect link expired or already used. Restart the UI for a new link.",
            );
        } catch (e) {
          setConnectionError((e as Error).message);
        }
        url.searchParams.delete("connect");
        history.replaceState(null, "", url.pathname + url.search);
      }
      const auth = url.searchParams.get("auth");
      if (auth)
        setNotice(
          auth === "connected"
            ? "ChatGPT connected. Eligible hints use your ChatGPT plan. Manage usage in ChatGPT settings."
            : auth === "identity-only"
              ? "Signed in, but plan usage was not authorized."
              : "ChatGPT sign-in failed or was declined. Development mode remains usable.",
        );
      if (!cancelled) await sync();
    }
    void connect();
    const interval = setInterval(() => {
      if (!cancelled) void sync();
    }, 2200);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [sync]);
  useEffect(() => {
    const d = importDialog.current;
    if (importOpen) d?.showModal();
    else d?.close();
  }, [importOpen]);
  useEffect(() => {
    const d = settingsDialog.current;
    if (settings) {
      d?.showModal();
      void api("/api/auth")
        .then((data) => {
          setAccounts(data.accounts ?? []);
          setModels(data.models ?? []);
          setModel((m) => m || data.models?.[0]?.id || "");
        })
        .catch((e) => setNotice(e.message));
    } else d?.close();
  }, [settings]);
  async function operation(
    kind: "start" | "apply" | "verify" | "reset" | "stop",
  ) {
    setPending(true);
    setNotice("");
    try {
      if (kind === "apply" && stale)
        throw new Error(
          "Repair the YAML syntax before applying. Your draft is retained.",
        );
      if (kind === "verify" && draft.current)
        throw new Error(
          "Apply the edited source before verification. The previous grade belongs to an older source revision.",
        );
      const current = labRef.current;
      const data = await api(
        "/api/lab",
        kind === "start"
          ? { kind, scenario }
          : {
              kind,
              operationId: crypto.randomUUID(),
              sessionId: current?.id,
              generation: current?.generation,
              expectedRevision: current?.revision,
              ...(kind === "apply"
                ? { source: files.map((f) => f.content).join("\n---\n") }
                : {}),
            },
      );
      if (kind === "apply") draft.current = false;
      if (kind === "reset") adoptReset.current = true;
      labRef.current = data.lab;
      setLab(data.lab);
      if (kind === "start") {
        setFiles([
          { id: "lesson", name: scenario + ".yaml", content: data.lab.source },
        ]);
        setActiveFile("lesson");
        draft.current = false;
        setSnapshot(null);
        setHint(-1);
      }
      setNotice(
        kind === "apply"
          ? "Repair accepted. Waiting for actual Kubernetes state."
          : kind === "verify"
            ? "Checking semantic repair and runtime behavior."
            : kind === "reset"
              ? "Restoring baseline and reinjecting the original fault."
              : kind === "stop"
                ? "Removing only the owned sandbox cluster."
                : "Preparing your disposable kind sandbox.",
      );
    } catch (e) {
      setNotice((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  function jump(ref: EvidenceRef) {
    setPanel("source");
    setActiveFile(ref.fileId);
    setMobileView("source");
    if (!stale)
      setTimeout(() => {
        const v = view.current;
        if (v && ref.start <= v.state.doc.length) {
          v.dispatch({
            selection: {
              anchor: ref.start,
              head: Math.min(ref.end, v.state.doc.length),
            },
            effects: [],
          });
          v.dispatch({ scrollIntoView: true });
          v.focus();
        }
      }, 60);
  }
  function loadFiles(next: SourceFile[]) {
    setFiles(next);
    setActiveFile(next[0]?.id ?? "");
    setSelected(null);
    setEdgeId(null);
    setSnapshot(null);
    draft.current = true;
    setImportOpen(false);
    setNotice(
      "Imported source is analysis-only. It will never be applied to a cluster.",
    );
  }
  async function upload(event: React.ChangeEvent<HTMLInputElement>) {
    const uploaded = Array.from(event.target.files ?? []);
    if (uploaded.length > 100) {
      setNotice("Import limit: 100 files.");
      return;
    }
    if (uploaded.reduce((n, f) => n + f.size, 0) > 2_000_000) {
      setNotice("Import limit: 2 MB.");
      return;
    }
    try {
      const next = await Promise.all(
        uploaded.map(async (f, i) => ({
          id: "file-" + i,
          name: f.name,
          content: await f.text(),
        })),
      );
      if (next.length === 1 && next[0].name.endsWith(".json")) {
        const s = JSON.parse(next[0].content);
        if (s.format === "playground-snapshot-v1") {
          loadFiles([
            {
              id: "snapshot",
              name: "snapshot.yaml",
              content: list(s.items)
                .map((r) => stringify(r))
                .join("---\n"),
            },
          ]);
          setSnapshot({ capturedAt: s.capturedAt, errors: s.errors ?? [] });
          return;
        }
      }
      loadFiles(next);
    } catch (e) {
      setNotice("Import failed: " + (e as Error).message);
    }
    event.target.value = "";
  }
  async function inspect() {
    setPending(true);
    try {
      const data = await api("/api/resources", {
        kind: panel,
        name: panel === "logs" ? pod : "",
      });
      setInspection(
        typeof data.data === "string"
          ? data.data
          : JSON.stringify(data.data, null, 2),
      );
    } catch (e) {
      setInspection((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  async function aiHint() {
    setPending(true);
    try {
      const data = await api("/api/tutor", {
        model,
        sessionId: lab?.id,
        generation: lab?.generation,
        revision: lab?.revision,
        hintLevel: Math.max(hint, 0),
      });
      if (labRef.current?.revision !== data.revision)
        throw new Error(
          "Lesson changed during inference; this hint is no longer current.",
        );
      setAiText(data.text);
    } catch (e) {
      setAiText((e as Error).message);
    } finally {
      setPending(false);
    }
  }
  const observed = lab?.observation?.resources.find(
    (r) =>
      r.kind === resource?.kind && at(r, "metadata", "name") === resource?.name,
  );
  const pods =
    lab?.observation?.resources.filter(
      (r) => r.kind === "Pod" && at(r, "metadata", "labels", "app") === "web",
    ) ?? [];
  return (
    <main className="app-shell">
      <header className="topbar">
        <a className="brand" href="/" onClick={(e) => e.preventDefault()}>
          <span className="brand-symbol">
            <Network size={21} />
          </span>
          <span>
            Kubernetes
            <br />
            <strong>Learning Playground</strong>
          </span>
        </a>
        <div className="top-context">
          <span className={"connection-dot " + (connected ? "online" : "")} />
          {running ? "Owned local sandbox" : "Manifest exploration"}
          <span className="context-divider" />{" "}
          {aiEnabled ? "ChatGPT available" : "Development mode · AI off"}
        </div>
        <div className="top-actions">
          <button onClick={() => setImportOpen(true)}>
            <Upload size={15} />
            Import manifests
          </button>
          <button
            className="icon-button"
            onClick={() => setSettings(true)}
            aria-label="Settings"
          >
            <Settings size={18} />
          </button>
        </div>
      </header>
      <section className="workspace-heading">
        <div>
          <span className="breadcrumb">
            Workspace /{" "}
            {snapshot
              ? "Captured snapshot"
              : running
                ? "Practice lesson"
                : "Manifest relationships"}
          </span>
          <h1>
            {running ? scenarios[scenario].title : "Follow the connection."}
          </h1>
          <p>
            {running
              ? scenarios[scenario].summary
              : "See how your resources fit together. Select a connection to read the evidence."}
          </p>
        </div>
        <div className="lesson-launch">
          <label htmlFor="lesson">Practice a lesson</label>
          <select
            id="lesson"
            value={scenario}
            disabled={running || busy}
            onChange={(e) => {
              const id = e.target.value as ScenarioId;
              setScenario(id);
              setFiles([
                {
                  id: "lesson",
                  name: id + ".yaml",
                  content: fixtureSource(id),
                },
              ]);
              setActiveFile("lesson");
              setSelected(null);
              setEdgeId(null);
              setHint(-1);
              draft.current = false;
            }}
          >
            {Object.entries(scenarios).map(([id, s]) => (
              <option key={id} value={id}>
                {s.title}
              </option>
            ))}
          </select>
          <button
            className="button-primary"
            onClick={() => operation("start")}
            disabled={running || busy || !connected}
          >
            <Play size={14} />
            Start local lab
          </button>
        </div>
      </section>
      {(!connected || lab?.error) && (
        <div className="notice error" role="alert">
          <AlertTriangle size={17} />
          <div>
            <strong>
              {lab?.error
                ? "Runtime needs attention"
                : "Local runtime unavailable"}
            </strong>
            <p>{lab?.error ?? connectionError}</p>
            <button onClick={() => void sync()}>Retry connection</button>
          </div>
        </div>
      )}
      <section
        className={
          "objective-strip " +
          (lab?.state === "completed" && !draft.current ? "complete" : "")
        }
        aria-label="Lesson objective"
      >
        <div>
          <BookOpen size={19} />
          <span>
            <strong>{running ? "Your objective" : "Explore safely"}</strong>
            <span>
              {running
                ? scenarios[scenario].objective
                : snapshot
                  ? `Snapshot captured ${snapshot.capturedAt} · ${snapshot.errors.length} partial-access errors · not live`
                  : "Imported manifests are analysis-only. Start a curated lesson to practice in a disposable cluster."}
            </span>
          </span>
        </div>
        {running && (
          <div className="objective-actions">
            <span className="state-badge">
              {lab.state}
              {lab.operation ? " · " + lab.operation : ""}
            </span>
            <button
              onClick={() => operation("verify")}
              disabled={
                busy ||
                !runtimeFresh ||
                stale ||
                !["running", "completed"].includes(lab.state)
              }
            >
              <Check size={15} />
              Verify
            </button>
            <button
              onClick={() => operation("reset")}
              disabled={busy || !connected || !lab.observation}
            >
              <RotateCcw size={14} />
              Reset
            </button>
            <button
              className="icon-button"
              aria-label="Stop owned lab"
              onClick={() => operation("stop")}
              disabled={busy || !connected}
            >
              <Square size={13} />
            </button>
          </div>
        )}
      </section>
      {lab?.operation && (
        <div className="operation-strip" role="status">
          <span className="spinner" />
          {lab.phase}
          <span>The workspace stays available.</span>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          <span>{notice}</span>
          <button
            className="icon-button"
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      <div className="mobile-switch">
        <button
          aria-pressed={mobileView === "graph"}
          onClick={() => setMobileView("graph")}
        >
          Graph
        </button>
        <button
          aria-pressed={mobileView === "source"}
          onClick={() => setMobileView("source")}
        >
          Source & inspector
        </button>
      </div>
      <section
        className={
          "workbench " + (!nav ? "nav-hidden " : "") + "mobile-" + mobileView
        }
        style={{ "--panel-width": panelWidth + "px" } as React.CSSProperties}
      >
        {nav && (
          <aside className="resource-nav" aria-label="Resources">
            <div className="nav-heading">
              <strong>
                Resources <span>{valid.resources.length}</span>
              </strong>
              <button
                className="icon-button"
                aria-label="Collapse resource navigator"
                onClick={() => setNav(false)}
              >
                <ChevronLeft size={16} />
              </button>
            </div>
            <p className="nav-caption">
              {snapshot
                ? "Captured resources"
                : running
                  ? lab.namespace
                  : "Imported source"}
            </p>
            {valid.resources.map((r) => (
              <button
                key={r.id}
                className={
                  "nav-resource " + (resource?.id === r.id ? "active" : "")
                }
                onClick={() => selectResource(r.id)}
              >
                <span>{r.kind}</span>
                <strong>{r.name}</strong>
                <small>
                  {r.namespace ?? "cluster scoped"}
                  {r.scope === "unknown" ? " · scope unknown" : ""}
                </small>
              </button>
            ))}
            {!valid.resources.length && (
              <p>No resources yet. Import manifests to begin.</p>
            )}
            <div className="nav-bottom">
              <span className="tag">
                {running ? "Curated fixture" : "Analysis only"}
              </span>
              <p>
                {valid.resources.filter((r) => !r.supported).length} resources
                with limited analyzer support
              </p>
              <button onClick={() => setImportOpen(true)}>
                <Upload size={13} />
                Import more
              </button>
            </div>
          </aside>
        )}
        <div className="graph-workspace">
          {!nav && (
            <button
              className="expand-nav icon-button"
              aria-label="Expand resource navigator"
              onClick={() => setNav(true)}
            >
              <ChevronRight size={17} />
            </button>
          )}
          {valid.resources.length ? (
            <ResourceGraph
              resources={valid.resources}
              relationships={analysis.relationships}
              selected={resource?.id ?? null}
              onSelect={selectResource}
              onRelationship={selectEdge}
              observation={runtimeFresh ? (lab?.observation ?? null) : null}
              stale={stale}
            />
          ) : (
            <div className="empty-state">
              <Network size={40} />
              <h2>Your manifests become a map.</h2>
              <p>
                Import YAML to follow resource relationships and source
                evidence.
              </p>
              <button onClick={() => setImportOpen(true)}>
                Import manifests
              </button>
            </div>
          )}
          <div className="graph-bottom">
            <span>
              <Link2 size={12} />
              {analysis.relationships.length} relationships
            </span>
            <span>
              {analysis.findings.length} findings ·{" "}
              {stale
                ? "previous valid graph"
                : snapshot
                  ? "captured snapshot"
                  : runtimeFresh
                    ? "live observation"
                    : "manifest inference"}
            </span>
          </div>
        </div>
        <div
          className="resize-handle"
          role="separator"
          tabIndex={0}
          aria-label="Resize source panel"
          aria-orientation="vertical"
          aria-valuenow={panelWidth}
          aria-valuemin={320}
          aria-valuemax={620}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
              e.preventDefault();
              setPanelWidth((w) =>
                Math.min(
                  620,
                  Math.max(320, w + (e.key === "ArrowLeft" ? 20 : -20)),
                ),
              );
            }
          }}
          onPointerDown={(e) => {
            const start = e.clientX,
              initial = panelWidth;
            const move = (ev: PointerEvent) =>
              setPanelWidth(
                Math.max(320, Math.min(620, initial + start - ev.clientX)),
              );
            const end = () => {
              window.removeEventListener("pointermove", move);
              window.removeEventListener("pointerup", end);
            };
            window.addEventListener("pointermove", move);
            window.addEventListener("pointerup", end);
          }}
        />
        <aside className="inspector" aria-label="Resource inspector">
          <div className="inspector-title">
            <span className="kind-icon">
              <PanelRight size={17} />
            </span>
            <div>
              <span>{resource?.kind ?? "Workspace"}</span>
              <h2>{resource?.name ?? "Source"}</h2>
            </div>
            <button
              className="icon-button"
              aria-label="Download current source"
              onClick={() =>
                download(file?.name ?? "manifests.yaml", file?.content ?? "")
              }
            >
              <Download size={16} />
            </button>
          </div>
          <div className="inspector-tabs">
            {(["source", "inspect", "events", "logs"] as const).map((t) => (
              <button
                key={t}
                onClick={() => {
                  setPanel(t);
                  setInspection("");
                }}
                aria-pressed={panel === t}
              >
                {t === "source"
                  ? "Source"
                  : t === "inspect"
                    ? "Inspect"
                    : t === "events"
                      ? "Events"
                      : "Logs"}
              </button>
            ))}
          </div>
          {panel === "source" ? (
            <>
              <div
                className={
                  "evidence-panel " +
                  (edge?.status === "mismatch" ? "fault" : "")
                }
              >
                <div className="evidence-title">
                  {edge?.status === "mismatch" ? (
                    <AlertTriangle size={15} />
                  ) : (
                    <Link2 size={15} />
                  )}
                  <strong>{edge?.title ?? "Resource source"}</strong>
                  <span className="tag">{stale ? "Stale" : "Inferred"}</span>
                </div>
                <p>
                  {edge?.explanation ??
                    "Select a resource or connection. Source evidence links highlight the exact fields."}
                </p>
                <div className="evidence-links">
                  {refs.map((r, i) => (
                    <button key={i} onClick={() => jump(r)} disabled={stale}>
                      {files.find((f) => f.id === r.fileId)?.name ?? "Source"}:
                      {r.line}
                      <ArrowUpRight size={12} />
                    </button>
                  ))}
                </div>
                {running && (
                  <div className="hint-area">
                    <button onClick={() => setHint((h) => Math.min(h + 1, 2))}>
                      <BookOpen size={13} />{" "}
                      {hint < 0 ? "Get a hint" : "Next hint"}
                    </button>
                    {hint >= 0 && (
                      <p>
                        <span>Authored lesson hint {hint + 1}/3</span>
                        {scenarios[scenario].hints[hint]}
                      </p>
                    )}
                    {aiEnabled && (
                      <button
                        disabled={pending || !model || !runtimeFresh}
                        onClick={() => void aiHint()}
                      >
                        Explain with ChatGPT
                      </button>
                    )}
                    {aiText && <p className="ai-text">{aiText}</p>}
                  </div>
                )}
              </div>
              <div className="source-filebar">
                <select
                  aria-label="Source file"
                  value={activeFile}
                  onChange={(e) => setActiveFile(e.target.value)}
                >
                  {files.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </select>
                <span>
                  {stale
                    ? "Invalid · graph retained"
                    : draft.current
                      ? "Draft edited"
                      : "Valid YAML"}
                </span>
              </div>
              {stale && (
                <div className="syntax-error" role="alert">
                  {parsed.diagnostics.slice(0, 3).map((d, i) => (
                    <p key={i}>
                      Line {d.line}: {d.message}
                    </p>
                  ))}
                </div>
              )}
              <SourceEditor
                value={file?.content ?? ""}
                onChange={changeSource}
                ranges={ranges}
                onView={(v) => (view.current = v)}
              />
              <div className="editor-footer">
                <span>
                  {running
                    ? "Only the scenario repair field may change."
                    : "Source stays in your browser."}
                </span>
                <button
                  className="button-primary"
                  disabled={
                    !running ||
                    busy ||
                    stale ||
                    !runtimeFresh ||
                    activeFile !== "lesson" ||
                    !["running", "completed"].includes(lab!.state)
                  }
                  onClick={() => operation("apply")}
                >
                  Apply repair
                </button>
              </div>
            </>
          ) : (
            <div className="inspection-body">
              {panel === "inspect" ? (
                <>
                  <span className="tag">
                    {observed
                      ? "Observed Kubernetes object"
                      : "Imported manifest"}
                  </span>
                  <pre>
                    {JSON.stringify(observed ?? resource?.raw ?? {}, null, 2)}
                  </pre>
                </>
              ) : (
                <>
                  <h3>
                    {panel === "events"
                      ? "Events tell the story."
                      : "Logs are opt-in."}
                  </h3>
                  <p>
                    {panel === "events"
                      ? "Read bounded, timestamped events from the owned lab namespace. A selector mismatch may produce no warning event."
                      : "Choose an observed workload Pod. Fetch the last 100 lines, capped at 16 KB. Logs never go to the tutor."}
                  </p>
                  {panel === "logs" && (
                    <select
                      aria-label="Pod for logs"
                      value={pod}
                      onChange={(e) => setPod(e.target.value)}
                    >
                      <option value="">Select a Pod</option>
                      {pods.map((p) => (
                        <option key={text(at(p, "metadata", "name"))}>
                          {text(at(p, "metadata", "name"))}
                        </option>
                      ))}
                    </select>
                  )}
                  <button
                    disabled={
                      !runtimeFresh || busy || (panel === "logs" && !pod)
                    }
                    onClick={() => void inspect()}
                  >
                    Fetch {panel}
                  </button>
                  <pre>{inspection || "No data fetched."}</pre>
                </>
              )}
              <details>
                <summary>
                  <Terminal size={14} />
                  Use your normal terminal
                </summary>
                <p>
                  The terminal is a host shell, not a security sandbox. Use the
                  dedicated kubeconfig shown by the CLI.
                </p>
                <code>pnpm cli status</code>
                <p>
                  Local session files:
                  ~/.local/state/kubernetes-learning-playground. Inspect the
                  named lab kubeconfig with an explicit --kubeconfig; do not
                  switch your default context.
                </p>
              </details>
              {process.env.NEXT_PUBLIC_ARGO_URL && (
                <a
                  href={process.env.NEXT_PUBLIC_ARGO_URL}
                  target="_blank"
                  rel="noreferrer"
                >
                  Open actual sandbox Argo CD <ArrowUpRight size={13} />
                </a>
              )}
            </div>
          )}
        </aside>
      </section>
      <section className="relationship-list">
        <details>
          <summary>
            Relationships & verification{" "}
            <span>{analysis.findings.length} findings</span>
          </summary>
          <div className="relationship-rows">
            {analysis.relationships.map((e) => (
              <button
                key={e.id}
                onClick={() => {
                  selectEdge(e.id);
                  setMobileView("source");
                }}
              >
                <span className={e.status}>
                  {e.status === "match" ? "✓" : "!"} {e.title}
                </span>
                <span>
                  {valid.resources.find((r) => r.id === e.from)?.kind}/
                  {valid.resources.find((r) => r.id === e.from)?.name} →{" "}
                  {valid.resources.find((r) => r.id === e.to)?.name ??
                    "not imported"}
                </span>
              </button>
            ))}
          </div>
        </details>
        {running && lab.checks.length > 0 && (
          <div className={"grade-results " + (draft.current ? "outdated" : "")}>
            <strong>
              {draft.current
                ? "Previous grade · source edited"
                : lab.state === "completed"
                  ? "Repair proven"
                  : "Verification results"}
            </strong>
            {lab.checks.map((c) => (
              <p key={c.id} className={c.status}>
                {c.status === "pass" ? "✓" : "!"} {c.explanation}
              </p>
            ))}
            {lab.state === "completed" && !draft.current && (
              <p className="completion-explanation">
                {scenario === "service-selector"
                  ? "The Service selector now matches the intended Pod labels. Kubernetes populated ready EndpointSlices, and a request through the Service returned the expected body."
                  : scenario === "configmap-key"
                    ? "The required ConfigMap key is restored. New containers can start with that value, both replicas are ready, and Service routing works."
                    : "The probe now requests a path the server serves. Both Pods became ready and Kubernetes restored them to Service routing."}
              </p>
            )}
          </div>
        )}
      </section>
      <footer className="workspace-footer">
        <span>
          {connected
            ? "Local session connected"
            : "Exploration available without a runtime"}
        </span>
        <span>
          {lab?.observation
            ? `Captured ${new Date(lab.observation.capturedAt).toLocaleTimeString()} · revision ${lab.revision} · generation ${lab.generation}`
            : "No live cluster state"}{" "}
          · {aiEnabled ? "AI opt-in" : "AI disabled"}
        </span>
      </footer>
      <input
        className="visually-hidden"
        type="file"
        multiple
        accept=".yaml,.yml,.json"
        ref={fileInput}
        onChange={upload}
        aria-label="Upload manifest files"
      />
      <dialog ref={importDialog} onCancel={() => setImportOpen(false)}>
        <div className="dialog-heading">
          <h2>Bring your manifests.</h2>
          <button
            className="icon-button"
            aria-label="Close import"
            onClick={() => setImportOpen(false)}
          >
            <X size={18} />
          </button>
        </div>
        <p>
          Import YAML files or a sanitized collector snapshot. Helm and
          Kustomize output can be imported as rendered YAML. This never runs
          imported workloads.
        </p>
        <button onClick={() => fileInput.current?.click()}>
          <Upload size={16} />
          Choose files
        </button>
        <label htmlFor="paste-yaml">Or paste multi-document YAML</label>
        <textarea
          id="paste-yaml"
          value={paste}
          onChange={(e) => setPaste(e.target.value)}
          placeholder="apiVersion: v1…"
        />
        <div className="dialog-actions">
          <button onClick={() => setImportOpen(false)}>Cancel</button>
          <button
            className="button-primary"
            onClick={() =>
              loadFiles([
                { id: "pasted", name: "imported.yaml", content: paste },
              ])
            }
            disabled={!paste.trim()}
          >
            Explore source
          </button>
        </div>
      </dialog>
      <dialog ref={settingsDialog} onCancel={() => setSettings(false)}>
        <div className="dialog-heading">
          <h2>Workspace settings</h2>
          <button
            className="icon-button"
            aria-label="Close settings"
            onClick={() => setSettings(false)}
          >
            <X size={18} />
          </button>
        </div>
        <div className="settings-section">
          <h3>{aiEnabled ? "Use your ChatGPT plan" : "Development mode"}</h3>
          <p>
            {aiEnabled
              ? "Eligible AI requests use your ChatGPT plan. Inference is sent to OpenAI; local hosting does not keep it local."
              : "Explore, inspect, repair, verify and reset without signing in. AI features are disabled. Authored progressive hints remain available."}
          </p>
          <button
            className="chatgpt-button"
            disabled={!aiEnabled || busy}
            onClick={async () => {
              try {
                const d = await api("/auth/openai", {});
                location.assign(d.url);
              } catch (e) {
                setNotice((e as Error).message);
              }
            }}
          >
            Continue with ChatGPT
          </button>
          {!aiEnabled && (
            <p className="muted">
              Credential storage and real inference await your separate
              authorization. No API-key fallback is used.
            </p>
          )}
          {accounts.map((a) => (
            <div key={a.id}>
              <button
                onClick={async () => {
                  await api("/api/auth", { kind: "select", account: a.id });
                  const d = await api("/api/auth");
                  setAccounts(d.accounts);
                  setModels(d.models);
                  setModel(d.models[0]?.id ?? "");
                }}
              >
                {a.label}
                {a.active ? " · active" : ""}
                {a.planEnabled ? "" : " · identity only"}
              </button>
            </div>
          ))}
          {models.length > 0 && (
            <>
              <label htmlFor="model">Authorized account model</label>
              <select
                id="model"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              >
                {models.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </select>
            </>
          )}
          {accounts.some((a) => a.active) && (
            <button
              onClick={async () => {
                const d = await api("/api/auth", { kind: "signout" });
                setNotice(
                  d.revoked
                    ? "Signed out. Renewable session revoked."
                    : "Signed out locally; remote revocation was not confirmed. Disconnect the app in ChatGPT settings.",
                );
                setAccounts(await api("/api/auth").then((d) => d.accounts));
              }}
            >
              Sign out
            </button>
          )}
          <a
            href="https://chatgpt.com/settings/usage"
            target="_blank"
            rel="noreferrer"
          >
            Manage ChatGPT usage <ArrowUpRight size={14} />
          </a>
        </div>
        <div className="settings-section">
          <h3>Source privacy</h3>
          <p>
            Imports stay in this browser. Tutor requests use only curated lesson
            metadata and deterministic checks; ConfigMap bodies, raw logs and
            credentials are excluded.
          </p>
          <button
            onClick={() => {
              loadFiles([]);
              setSettings(false);
            }}
          >
            Clear imported source
          </button>
        </div>
      </dialog>
    </main>
  );
}
