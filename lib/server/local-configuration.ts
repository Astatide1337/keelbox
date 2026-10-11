import { randomUUID, randomBytes } from "node:crypto";
import { acquireOperationLock } from "./operation-lock";
import { join } from "node:path";
import { readFile, lstat } from "node:fs/promises";
import { z } from "zod";
import { atomicJson, privateDirectory } from "./minikube";
import { digest } from "../domain/deployment-plan";
const name = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/)
  .max(253);
export const secretInput = z
  .object({
    namespace: name.default("default"),
    name,
    type: z
      .enum(["Opaque", "kubernetes.io/dockerconfigjson", "kubernetes.io/tls"])
      .default("Opaque"),
    values: z.record(
      z.string().regex(/^[A-Za-z0-9_.-]+$/),
      z.string().max(65536),
    ),
  })
  .strict();
export type LocalSecret = z.infer<typeof secretInput>;
export const vaultInput = z
  .object({
    mount: z
      .string()
      .regex(/^[a-z][a-z0-9-]*$/)
      .max(63)
      .default("secret"),
    path: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_./-]*$/)
      .max(250)
      .refine((p) => !p.split("/").includes("..")),
    role: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(100),
    values: z.record(
      z.string().regex(/^[A-Za-z0-9_.-]+$/),
      z.string().max(65536),
    ),
  })
  .strict();
export type VaultEntry = z.infer<typeof vaultInput>;
export const localImageInput = z
  .object({
    original: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/),
    reference: z
      .string()
      .min(1)
      .max(500)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._/:@-]*$/),
    imageId: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  })
  .strict();
const configSchema = z.object({
  secrets: z.array(secretInput).max(100),
  revision: z.string(),
  images: z.array(localImageInput).max(100).default([]),
  vault: z
    .object({
      rootToken: z.string().min(32),
      entries: z.array(vaultInput).max(100),
    })
    .optional(),
});
export class LocalConfiguration {
  constructor(private root: string) {}
  private file(project: string) {
    if (!/^[a-f0-9]{64}$/.test(project))
      throw Error("Invalid project configuration identity.");
    return join(this.root, project + ".json");
  }
  async load(project: string) {
    try {
      const path = this.file(project),
        st = await lstat(path);
      if (
        !st.isFile() ||
        st.isSymbolicLink() ||
        st.mode & 0o077 ||
        (process.getuid && st.uid !== process.getuid())
      )
        throw Error("Local configuration must be an owner-only regular file.");
      return configSchema.parse(JSON.parse(await readFile(path, "utf8")));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      return {
        secrets: [] as LocalSecret[],
        images: [] as z.infer<typeof localImageInput>[],
        revision: digest([]),
      };
    }
  }
  async save(project: string, secret: LocalSecret, guard: () => void) {
    await privateDirectory(this.root);
    const lock = await acquireOperationLock(this.file(project) + ".lock");
    try {
      const value = secretInput.parse(secret),
        current = await this.load(project);
      current.secrets = current.secrets.filter(
        (s) => s.name !== value.name || s.namespace !== value.namespace,
      );
      current.secrets.push(value);
      const next = { ...current, revision: randomUUID() };
      await privateDirectory(this.root);
      guard();
      await atomicJson(this.file(project), next);
      return this.public(next);
    } finally {
      await lock.close();
    }
  }
  async saveImage(
    project: string,
    image: z.infer<typeof localImageInput>,
    guard: () => void,
  ) {
    await privateDirectory(this.root);
    const lock = await acquireOperationLock(this.file(project) + ".lock");
    try {
      const value = localImageInput.parse(image),
        current = await this.load(project);
      const next = {
        ...current,
        images: [
          ...current.images.filter((i) => i.original !== value.original),
          value,
        ],
        revision: randomUUID(),
      };
      guard();
      await atomicJson(this.file(project), next);
      return this.public(next);
    } finally {
      await lock.close();
    }
  }
  async saveVault(project: string, entry: VaultEntry, guard: () => void) {
    await privateDirectory(this.root);
    const lock = await acquireOperationLock(this.file(project) + ".lock");
    try {
      const value = vaultInput.parse(entry),
        config = await this.load(project);
      const vault = ("vault" in config ? config.vault : undefined) ?? {
        rootToken: randomBytes(32).toString("hex"),
        entries: [] as VaultEntry[],
      };
      vault.entries = vault.entries.filter(
        (e) =>
          e.mount !== value.mount ||
          e.path !== value.path ||
          e.role !== value.role,
      );
      vault.entries.push(value);
      const next = { ...config, vault, revision: randomUUID() };
      guard();
      await atomicJson(this.file(project), next);
      return this.public(next);
    } finally {
      await lock.close();
    }
  }
  public(config: Awaited<ReturnType<LocalConfiguration["load"]>>) {
    return {
      revision: config.revision,
      images: config.images,
      vault:
        "vault" in config && config.vault
          ? {
              entries: config.vault.entries.map((e) => ({
                mount: e.mount,
                path: e.path,
                role: e.role,
                keys: Object.keys(e.values),
              })),
            }
          : undefined,
      secrets: config.secrets.map(({ namespace, name, type, values }) => ({
        namespace,
        name,
        type,
        keys: Object.keys(values),
      })),
    };
  }
}
