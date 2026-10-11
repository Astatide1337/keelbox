import { join } from "node:path";
import { homedir } from "node:os";
import { ProjectStore } from "../project-store";
import { ExerciseStore } from "../exercise-store";
import { assertPrincipal } from "./session";
import type { Principal } from "./identity";
export function ownedStores(principal: Principal) {
  assertPrincipal(principal);
  const root =
    process.env.PLAYGROUND_STATE_DIR ??
    join(homedir(), ".local/state/kubernetes-learning-playground");
  const key = principal.profile.key;
  if (key !== "development" && !/^[a-f0-9]{64}$/.test(key))
    throw Error("Invalid profile identity.");
  const ownedRoot = key === "development" ? root : join(root, "profiles", key);
  return {
    root: ownedRoot,
    project: new ProjectStore(ownedRoot),
    exercises: new ExerciseStore(join(ownedRoot, "exercises")),
    guard: () => assertPrincipal(principal),
  };
}
