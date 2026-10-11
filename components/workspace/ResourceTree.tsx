"use client";
import { Button } from "../ui/button";
import {
  at,
  list,
  text,
  type Resource,
  type Observation,
} from "@/lib/domain/types";
import {
  resourcePresentation,
  resourceOrigin,
} from "@/lib/domain/presentation";
import {
  capturedResource,
  coverage,
  type Snapshot,
} from "@/lib/domain/snapshot";
import { resourceAge } from "@/lib/ui/inspection";
export function ResourceTree({
  resources,
  source,
  observation,
  selected,
  onSelect,
}: {
  resources: Resource[];
  source: Snapshot;
  observation: Observation | null;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const byUid = new Map(
    resources
      .map((r) => [
        text(at(capturedResource(source, r) ?? r.raw, "metadata", "uid")),
        r,
      ])
      .filter(([uid]) => !!uid) as [string, Resource][],
  );
  const parent = (r: Resource) =>
    list(
      at(capturedResource(source, r) ?? r.raw, "metadata", "ownerReferences"),
    ).find((o) => o.controller === true);
  const children = (r: Resource) => {
    const uid = text(
      at(capturedResource(source, r) ?? r.raw, "metadata", "uid"),
    );
    return uid ? resources.filter((c) => text(parent(c)?.uid) === uid) : [];
  };
  function branch(r: Resource, seen = new Set<string>()) {
    if (seen.has(r.id)) return null;
    const next = new Set(seen).add(r.id),
      nested = children(r);
    const status = resourcePresentation(
      r,
      observation,
      coverage(source, "EndpointSlice", r.namespace)?.state === "captured",
    ).label;
    const button = (
      <Button
        variant="ghost"
        size="sm"
        className="tree-resource"
        aria-pressed={r.id === selected}
        onClick={() => onSelect(r.id)}
        title={`${status} · ${resourceOrigin(r, source)} · UID ${text(at(capturedResource(source, r) ?? r.raw, "metadata", "uid")) || "unavailable"} · ${resourceAge(capturedResource(source, r), source.captureEndedAt)}`}
      >
        {r.kind} / {r.name}
        <small>{r.namespace ?? "Cluster"}</small>
        <small>{status}</small>
      </Button>
    );
    return (
      <li key={r.id}>
        {button}
        {nested.length > 0 && (
          <details open>
            <summary>{nested.length} managed resources</summary>
            <ul>{nested.map((c) => branch(c, next))}</ul>
          </details>
        )}
      </li>
    );
  }
  return (
    <details className="source-tree" open>
      <summary>Application tree</summary>
      <nav aria-label="Source resource tree">
        <ul>
          {resources
            .filter((r) => !parent(r) || !byUid.has(String(parent(r)?.uid)))
            .map((r) => branch(r))}
        </ul>
      </nav>
    </details>
  );
}
