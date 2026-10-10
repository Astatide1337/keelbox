"use client";
import { Search, SlidersHorizontal } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
export function WorkspaceToolbar({
  mode = "resources",
  query,
  onQuery,
  namespace,
  onNamespace,
  namespaces,
  kind,
  onKind,
  kinds,
  count,
  mobileInspector,
  onMobileInspector,
}: {
  mode?: "resources" | "events" | "files";
  query: string;
  onQuery: (s: string) => void;
  namespace: string;
  onNamespace: (s: string) => void;
  namespaces: string[];
  kind: string;
  onKind: (s: string) => void;
  kinds: string[];
  count: number;
  mobileInspector: boolean;
  onMobileInspector: () => void;
}) {
  return (
    <div className="toolbar">
      {mode === "resources" && (
        <div className="search-field">
          <Search />
          <Input
            aria-label="Filter resources"
            placeholder="Search resources…"
            value={query}
            onChange={(e) => onQuery(e.target.value)}
          />
        </div>
      )}
      {mode !== "files" && (
        <Select value={namespace} onValueChange={onNamespace}>
          <SelectTrigger aria-label="Namespace">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All namespaces</SelectItem>
            {namespaces.map((n) => (
              <SelectItem key={n} value={n}>
                {n}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {mode === "resources" && (
        <Select value={kind} onValueChange={onKind}>
          <SelectTrigger aria-label="Resource kind">
            <SlidersHorizontal />
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All kinds</SelectItem>
            {kinds.map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <span className="resource-count">
        {count} {mode}
      </span>
      <Button
        variant="outline"
        className="mobile-toggle"
        onClick={onMobileInspector}
      >
        {mobileInspector ? "Show workspace" : "Show inspector"}
      </Button>
    </div>
  );
}
