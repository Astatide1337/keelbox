import type { IncidentId, Exercise } from "./types";
export type SavedInvestigation = {
  id: string;
  scenario: IncidentId;
  sourceId: string;
  projectLabel: string;
  state: Exercise["state"];
  attempt: number;
  revision: number;
  updatedAt: string;
  timestampOrigin: "saved" | "file-modified";
};
export type InvestigationPage = {
  items: SavedInvestigation[];
  nextCursor?: string;
  issues: string[];
};
