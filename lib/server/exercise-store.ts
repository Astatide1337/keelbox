import {
  mkdir,
  readFile,
  writeFile,
  rename,
  unlink,
  readdir,
  lstat,
} from "node:fs/promises";
import type { Stats } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  importSnapshot,
  snapshotDigest,
  type Snapshot,
} from "../domain/snapshot";
import { createExercise, checkRepair } from "../practice/engine";
import type { InvestigationPage } from "../practice/history";
import type { Exercise } from "../practice/types";
const header = z.object({
  id: z.string().uuid(),
  scenario: z.enum(["readiness", "liveness", "http503"]),
  revision: z.number().int().min(0).max(100000),
  attempt: z.number().int().min(1).max(1000),
  state: z.enum([
    "preparing",
    "ready",
    "running",
    "checking",
    "completed",
    "failed",
    "resetting",
    "stopped",
  ]),
  sourceDigest: z.string(),
  source: z.unknown(),
  draftFiles: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        content: z.string().max(2_000_000),
      }),
    )
    .max(100),
  modelRevision: z.number().int().min(0).optional(),
  modeledFiles: z
    .array(
      z.object({
        id: z.string(),
        name: z.string(),
        content: z.string().max(2_000_000),
      }),
    )
    .max(100)
    .optional(),
  hintsRevealed: z.number().int().min(0).max(3),
  resets: z
    .array(z.object({ attempt: z.number().int(), revision: z.number().int() }))
    .max(1000),
});
export function restoreExercise(input: unknown): Exercise {
  const saved = header.parse(input);
  const source = importSnapshot(JSON.stringify(saved.source));
  if (snapshotDigest(source) !== saved.sourceDigest)
    throw Error("Source digest mismatch. Reimport the source.");
  let fresh = createExercise(source, saved.scenario);
  if (
    saved.draftFiles.length !== fresh.draftFiles.length ||
    saved.draftFiles.some(
      (f) =>
        !fresh.baselineFiles.some((b) => b.id === f.id && b.name === f.name),
    )
  )
    throw Error("Exercise files do not match the source.");
  if (saved.modeledFiles) {
    const applied = { ...fresh, draftFiles: saved.modeledFiles };
    const expectedFault = JSON.stringify(fresh.draftFiles);
    if (JSON.stringify(saved.modeledFiles) !== expectedFault) {
      const verified = checkRepair(applied, applied.revision, "restore-model");
      if (verified.state !== "completed")
        throw Error(
          "Saved modeled checkpoint does not pass deterministic checks.",
        );
      fresh = { ...verified, operations: {} };
    }
    fresh.modelRevision = saved.modelRevision ?? 0;
    fresh.modeledFiles = saved.modeledFiles;
  }
  fresh = {
    ...fresh,
    id: saved.id,
    draftFiles: saved.draftFiles,
    revision: saved.revision,
    attempt: saved.attempt,
    hintsRevealed: saved.hintsRevealed,
    resets: saved.resets,
  };
  if (saved.state === "completed") {
    const verified = checkRepair(fresh, fresh.revision, "restore-check");
    if (verified.state !== "completed")
      throw Error("Saved completion does not pass deterministic checks.");
    fresh = {
      ...verified,
      revision: saved.revision,
      modelRevision: saved.revision,
      operations: {},
    };
  } else if (saved.state === "checking" || saved.state === "resetting") {
    fresh.state = "running";
    fresh.checks = [
      {
        id: "recovery",
        passed: false,
        explanation:
          "Interrupted operation recovered from the last atomic checkpoint. Review the draft and retry.",
      },
    ];
  } else {
    fresh.state = saved.state === "stopped" ? "stopped" : "running";
    fresh.checks = [];
  }
  return fresh;
}
export class ExerciseStore {
  private locks = ((
    globalThis as typeof globalThis & {
      playgroundCheckpointLocks?: Set<string>;
    }
  ).playgroundCheckpointLocks ??= new Set<string>());
  constructor(
    private root = join(
      homedir(),
      ".local/state/kubernetes-learning-playground/exercises",
    ),
  ) {}
  private path(id: string) {
    z.string().uuid().parse(id);
    return join(this.root, id + ".json");
  }
  async list(cursor?: string, limit = 20): Promise<InvestigationPage> {
    if (cursor) z.string().uuid().parse(cursor);
    z.number().int().min(1).max(50).parse(limit);
    let names: string[];
    try {
      names = await readdir(this.root);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { items: [], issues: [] };
      throw Error("Local checkpoint directory is unavailable.");
    }
    const ids = names
      .filter(
        (n) =>
          /^[0-9a-f-]{36}\.json$/i.test(n) &&
          z.string().uuid().safeParse(n.slice(0, -5)).success,
      )
      .map((n) => n.slice(0, -5))
      .sort();
    const metadata = new Map<string, Stats>();
    for (const id of ids) {
      try {
        metadata.set(id, await lstat(this.path(id)));
      } catch {
        /* Removed during enumeration; retained as an issue if selected. */
      }
    }
    ids.sort(
      (a, b) =>
        (metadata.get(b)?.mtimeMs ?? 0) - (metadata.get(a)?.mtimeMs ?? 0) ||
        a.localeCompare(b),
    );
    const after = cursor ? ids.indexOf(cursor) : -1;
    if (cursor && after < 0)
      throw Error("Checkpoint list changed. Retry from the first page.");
    const pending = ids.slice(after + 1),
      selected = pending.slice(0, limit);
    const result: InvestigationPage = { items: [], issues: [] };
    for (const id of selected) {
      try {
        const meta = metadata.get(id);
        if (!meta) throw Error("Checkpoint removed during enumeration");
        if (!meta.isFile() || meta.isSymbolicLink() || meta.size > 8_000_000)
          throw Error("Unsupported checkpoint file");
        const saved = await this.load(id);
        if (saved.exercise.id !== id)
          throw Error("Checkpoint identity mismatch");
        const timestamp = z.string().datetime().safeParse(saved.updatedAt);
        result.items.push({
          id,
          scenario: saved.exercise.scenario,
          sourceId: saved.exercise.source.id,
          projectLabel: saved.exercise.source.label,
          state: saved.exercise.state,
          attempt: saved.exercise.attempt,
          revision: saved.exercise.revision,
          updatedAt: timestamp.success
            ? timestamp.data
            : meta.mtime.toISOString(),
          timestampOrigin: timestamp.success ? "saved" : "file-modified",
        });
      } catch {
        result.issues.push(
          `Checkpoint ${id.slice(0, 8)} is unreadable or invalid. Its file has been preserved.`,
        );
      }
    }
    if (pending.length > selected.length)
      result.nextCursor = selected[selected.length - 1];
    return result;
  }
  async load(id: string) {
    const raw = await readFile(this.path(id), "utf8");
    if (raw.length > 8_000_000) throw Error("Saved exercise exceeds limits.");
    const envelope = JSON.parse(raw);
    return {
      exercise: restoreExercise(envelope.exercise),
      project: importSnapshot(
        JSON.stringify(envelope.project ?? envelope.exercise.source),
      ),
      savedRevision: z.number().int().min(0).parse(envelope.savedRevision),
      updatedAt: z.string().datetime().safeParse(envelope.updatedAt).success
        ? (envelope.updatedAt as string)
        : undefined,
    };
  }
  async save(
    input: unknown,
    expectedSavedRevision: number | null,
    project?: Snapshot,
    guard: () => void = () => {},
  ) {
    const exercise = restoreExercise(input),
      path = this.path(exercise.id);
    if (this.locks.has(path))
      throw Error(
        "Exercise checkpoint is busy. Retry after the current operation.",
      );
    this.locks.add(path);
    const temp = path + "." + crypto.randomUUID() + ".tmp";
    try {
      let prior: number | null = null;
      try {
        prior = (await this.load(exercise.id)).savedRevision;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      }
      if (prior !== expectedSavedRevision)
        throw Error("Stale checkpoint revision. Reload the saved exercise.");
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      await writeFile(
        temp,
        JSON.stringify({
          updatedAt: new Date().toISOString(),
          project: project ?? exercise.source,
          savedRevision: exercise.revision,
          exercise: { ...exercise, operations: {} },
        }),
        { mode: 0o600, flag: "wx" },
      );
      guard();
      await rename(temp, path);
      return { savedRevision: exercise.revision };
    } finally {
      this.locks.delete(path);
      await unlink(temp).catch(() => {});
    }
  }
}
export const exerciseStore = new ExerciseStore();
