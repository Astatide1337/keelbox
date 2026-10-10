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
export async function readManifestInputs(paths: string[]): Promise<Snapshot> {
  if (!paths.length)
    throw Error("Usage: pnpm cli import folder-or-file [more.yaml]");
  const expanded: string[] = [];
  for (const input of paths) {
    const path = resolve(input),
      st = await lstat(path);
    if (st.isSymbolicLink()) throw Error("Import symlinks are unsupported.");
    if (st.isDirectory()) {
      for (const item of (await readdir(path, { withFileTypes: true })).sort(
        (a, b) => a.name.localeCompare(b.name),
      ))
        if (/\.ya?ml$/i.test(item.name)) {
          if (!item.isFile())
            throw Error("Import expects regular manifest files.");
          expanded.push(join(path, item.name));
        }
    } else if (st.isFile()) expanded.push(path);
    else throw Error("Import expects regular files or a manifest directory.");
  }
  if (!expanded.length || expanded.length > 100)
    throw Error("Import needs 1–100 manifest files.");
  const files: SourceFile[] = [];
  let size = 0;
  for (const path of expanded) {
    const st = await lstat(path);
    if (!st.isFile()) throw Error("Import expects regular files.");
    size += st.size;
    if (size > 2_000_000) throw Error("Import exceeds 2 MB.");
    const content = await readFile(path, "utf8");
    files.push({ id: randomUUID(), name: path, content });
  }
  if (
    files.length === 1 &&
    files[0].content.trim().startsWith("{") &&
    files[0].content.includes("playground-snapshot-")
  )
    return importSnapshot(files[0].content);
  const first = resolve(paths[0]);
  const isDir = (await lstat(first)).isDirectory();
  const label = isDir
    ? basename(first) === "manifests"
      ? basename(dirname(first))
      : basename(first)
    : basename(first);
  const project = { ...manifestProject(files), label };
  return importSnapshot(JSON.stringify(project));
}
