import { repositoryFiles } from "./repository-import";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  rm,
  lstat,
  readdir,
} from "node:fs/promises";
import { join, resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  importSnapshot,
  manifestProject,
  type Snapshot,
} from "../domain/snapshot";
import type { SourceFile } from "../domain/types";
const envelope = z.object({
  revision: z.string().uuid(),
  selectedAt: z.string().datetime(),
  project: z.unknown(),
});
export class ProjectStore {
  constructor(
    private root = process.env.PLAYGROUND_STATE_DIR ??
      join(homedir(), ".local/state/kubernetes-learning-playground"),
  ) {}
  async load() {
    try {
      const raw = await readFile(join(this.root, "project.json"), "utf8");
      if (raw.length > 2_100_000)
        throw Error("Selected project exceeds limits.");
      const saved = envelope.parse(JSON.parse(raw));
      return {
        ...saved,
        project: importSnapshot(JSON.stringify(saved.project)),
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async select(project: Snapshot, guard: () => void = () => {}) {
    const validated = importSnapshot(JSON.stringify(project));
    const selected = {
      revision: randomUUID(),
      selectedAt: new Date().toISOString(),
      project: validated,
    };
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const temp = join(this.root, "project." + randomUUID() + ".tmp");
    try {
      await writeFile(temp, JSON.stringify(selected), {
        mode: 0o600,
        flag: "wx",
      });
      guard();
      await rename(temp, join(this.root, "project.json"));
    } finally {
      await rm(temp, { force: true });
    }
    return selected;
  }
}
export const projectStore = new ProjectStore();
export async function readManifestInputs(paths: string[], options: {entry?:string; values?:string[]; release?:string} = {}): Promise<Snapshot> {
  if (!paths.length) throw Error("Usage: waypoint import REPOSITORY [--entry APPLICATION] [--values FILE]");
  const {files, notes} = await repositoryFiles(paths, options);
  if(files.length===1 && files[0].content.trim().startsWith("{") && files[0].content.includes("playground-snapshot-")) return importSnapshot(files[0].content);
  const first=resolve(paths[0]); const st=await lstat(first);
  const label=options.entry ? basename(options.entry) : st.isDirectory() ? basename(first)==="manifests" ? basename(dirname(first)) : basename(first) : basename(first);
  return importSnapshot(JSON.stringify({...manifestProject(files),label,errors:notes}));
}
