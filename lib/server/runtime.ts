import { homedir } from "node:os";
import { join } from "node:path";

export const stateRoot =
  process.env.PLAYGROUND_STATE_DIR ??
  join(homedir(), ".local", "state", "kubernetes-learning-playground");

export function safeError(e: unknown) {
  return (e instanceof Error ? e.message : String(e))
    .replace(
      /(token|password|secret|authorization)[=:]\s*\S+/gi,
      "$1=[redacted]",
    )
    .slice(0, 6000);
}
