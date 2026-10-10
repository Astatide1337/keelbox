import type { ObjectMap, SourceFile, SessionState } from "../domain/types";
import type { EndpointContract, Snapshot } from "../domain/snapshot";
export type IncidentId = "readiness" | "liveness" | "http503";
export type Targets = {
  deployment: string;
  service: string;
  podUids: string[];
  container: string;
  namespace: string;
  contract: EndpointContract;
};
export type Compatibility =
  | { supported: true; targets: Targets }
  | { supported: false; reasons: string[] };
export type PracticeCheck = {
  id: string;
  passed: boolean;
  explanation: string;
};
export type SyntheticEvent = {
  uid: string;
  reason: string;
  message: string;
  modelTime: number;
  count: number;
};
export type Exercise = {
  id: string;
  scenario: IncidentId;
  sourceId: string;
  sourceDigest: string;
  source: Snapshot;
  targets: Targets;
  attempt: number;
  revision: number;
  state: SessionState;
  draftFiles: SourceFile[];
  baselineFiles: SourceFile[];
  resources: ObjectMap[];
  events: SyntheticEvent[];
  logs: Record<string, string[]>;
  modelTime: number;
  modelRevision: number;
  modeledFiles: SourceFile[];
  hintsRevealed: number;
  checks: PracticeCheck[];
  resets: { attempt: number; revision: number }[];
  operations: Record<
    string,
    { revision: number; kind: "check" | "reset"; result?: Exercise }
  >;
};
