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
  const [revealedFilters, setRevealedFilters] = useState<Pick<
    WorkspaceContext,
    "namespace" | "query" | "kind"
  > | null>(null);
  const urlReady = useRef(false);
  useEffect(() => {
    const restore = () => {
      const url = new URL(location.href);
      const context = { ...empty };
      if (
        url.searchParams.get("workspace") === workspaceKey ||
        !url.searchParams.has("workspace")
      ) {
        for (const key of [
          "selected",
          "namespace",
          "query",
          "kind",
          "tab",
        ] as const) {
          const value = url.searchParams.get(key);
          if (value !== null) context[key] = value;
        }
      }
      setContexts((previous) => ({ ...previous, [workspaceKey]: context }));
      urlReady.current = true;
    };
    restore();
    window.addEventListener("popstate", restore);
    return () => {
      window.removeEventListener("popstate", restore);
      urlReady.current = false;
    };
  }, [workspaceKey]);
  useEffect(() => {
    if (!urlReady.current) return;
    const url = new URL(location.href);
    url.searchParams.set("workspace", workspaceKey);
    for (const key of [
      "selected",
      "namespace",
      "query",
      "kind",
      "tab",
    ] as const) {
      const value = state[key];
      if (value && value !== empty[key]) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, "", url);
  }, [workspaceKey, state]);
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
    setSelected: (s: string | null) => {
      if (
        s &&
        !visible.some((r) => r.id === s) &&
        all.some((r) => r.id === s)
      ) {
        setRevealedFilters({
          namespace: state.namespace,
          query: state.query,
          kind: state.kind,
        });
        setContexts((previous) => ({
          ...previous,
          [workspaceKey]: {
            ...state,
            selected: s,
            namespace: "all",
            query: "",
            kind: "all",
          },
        }));
      } else update("selected", s);
    },
    revealedFilters,
    restoreFilters: () => {
      if (revealedFilters)
        setContexts((previous) => ({
          ...previous,
          [workspaceKey]: { ...state, ...revealedFilters },
        }));
      setRevealedFilters(null);
    },
    setNamespace: (s: string) => update("namespace", s),
    setQuery: (s: string) => update("query", s),
    setKind: (s: string) => update("kind", s),
    setTab: (s: string) => update("tab", s),
    all,
    visible,
    resource: all.find((r) => r.id === state.selected),
    diagnostics: parsed.diagnostics,
  };
}
