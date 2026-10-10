"use client";
import { useState, useMemo, useEffect, useRef } from "react";
import { parseSources } from "@/lib/domain/importer";
import { projectResources, type Snapshot } from "@/lib/domain/snapshot";
import type { SourceFile } from "@/lib/domain/types";
type WorkspaceContext = {
  selected: string | null;
  namespace: string;
  query: string;
  kind: string;
  tab: string;
};
const empty: WorkspaceContext = {
  selected: null,
  namespace: "all",
  query: "",
  kind: "all",
  tab: "Overview",
};
export function useProjectWorkspace(
  source: Snapshot,
  files: SourceFile[],
  workspaceKey = source.id,
) {
  const [contexts, setContexts] = useState<Record<string, WorkspaceContext>>(
    {},
  );
  const state = contexts[workspaceKey] ?? empty;
  function update<K extends keyof WorkspaceContext>(
    key: K,
    value: WorkspaceContext[K],
  ) {
    setContexts((previous) => ({
      ...previous,
      [workspaceKey]: { ...(previous[workspaceKey] ?? empty), [key]: value },
    }));
  }
  const parsed = useMemo(() => parseSources(files), [files]);
  const current = useMemo(
    () => projectResources(source, files),
    [source, files],
  );
  const validByWorkspace = useRef(new Map<string, typeof current>());
  useEffect(() => {
    if (!parsed.diagnostics.length)
      validByWorkspace.current.set(workspaceKey, current);
  }, [current, parsed, workspaceKey]);
  const all = parsed.diagnostics.length
    ? (validByWorkspace.current.get(workspaceKey) ?? projectResources(source))
    : current;
  const visible = useMemo(
    () =>
      all.filter(
        (r) =>
          (state.namespace === "all" || r.namespace === state.namespace) &&
          (state.kind === "all" || r.kind === state.kind) &&
          `${r.kind} ${r.name}`
            .toLowerCase()
            .includes(state.query.toLowerCase()),
      ),
    [all, state.namespace, state.kind, state.query],
  );
  return {
    ...state,
    setSelected: (s: string | null) => update("selected", s),
    setNamespace: (s: string) => update("namespace", s),
    setQuery: (s: string) => update("query", s),
    setKind: (s: string) => update("kind", s),
    setTab: (s: string) => update("tab", s),
    all,
    visible,
    resource: visible.find((r) => r.id === state.selected),
    diagnostics: parsed.diagnostics,
  };
}
