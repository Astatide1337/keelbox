"use client";
import { useState } from "react";
import { Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from "@/components/ui/select";
import { incidents } from "@/lib/practice/scenarios/catalog";
import { compatibility } from "@/lib/practice/compatibility";
import type { IncidentId } from "@/lib/practice/types";
import type { Snapshot } from "@/lib/domain/snapshot";
import { IncidentCard, incidentLevels } from "./IncidentCard";
export function IncidentCatalog({
  source,
  onStart,
  busy,
}: {
  source: Snapshot;
  onStart: (id: IncidentId) => void;
  busy: boolean;
}) {
  const [query, setQuery] = useState(""),
    [level, setLevel] = useState("all");
  const filtered = incidents.filter(
    (i) =>
      (level === "all" || incidentLevels[i.id] === level) &&
      `${i.title} ${i.symptom} ${i.objective}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <div className="catalog-filter">
        <div className="search-field">
          <Search />
          <Input
            aria-label="Find an incident"
            placeholder="Find an incident…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger aria-label="Incident level">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All levels</SelectItem>
            <SelectItem value="Beginner">Beginner</SelectItem>
            <SelectItem value="Intermediate">Intermediate</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div className="incident-grid">
        {filtered.map((incident) => (
          <IncidentCard
            key={incident.id}
            incident={incident}
            supported={compatibility(source, incident.id).supported}
            busy={busy}
            onStart={() => onStart(incident.id)}
          />
        ))}
      </div>
      {!filtered.length && (
        <div className="empty">
          <strong>No incidents match</strong>
          <p>Try another search or level.</p>
        </div>
      )}
    </>
  );
}
