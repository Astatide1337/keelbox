import { createHash, randomUUID } from "node:crypto";
import { constants, unlinkSync } from "node:fs";
import {
  chmod,
  mkdir,
  open,
  lstat,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import { credentialSchema, storageAllowed, type Credential } from "./identity";
export const authRoot = () =>
  process.env.PLAYGROUND_AUTH_DIR ??
  join(homedir(), ".config/kubernetes-learning-playground");
const g = globalThis as typeof globalThis & {
  waypointBrokerRoots?: Map<string, Promise<void>>;
};
const owners = (g.waypointBrokerRoots ??= new Map());
async function ownBroker(root: string) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await lstat(root);
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    (process.getuid && dir.uid !== process.getuid())
  )
    throw Error("Credential directory must be an owned directory, not a link.");
  await chmod(root, 0o700);
  const path = join(root, "broker.lock"),
    owned = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const f = await open(path, "wx", 0o600);
      try {
        await f.writeFile(owned);
      } finally {
        await f.close();
      }
      process.once("exit", () => {
        try {
          if (readFileSyncSafe(path) === owned) unlinkSync(path);
        } catch {}
      });
      return;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink())
        throw Error("Invalid credential broker lock.");
      const raw = await readFile(path, "utf8");
      const pid = z.number().int().positive().parse(JSON.parse(raw).pid);
      try {
        process.kill(pid, 0);
        throw Error(
          "Another local UI owns ChatGPT credentials. Use that UI or stop its owner before starting AI mode.",
        );
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
      }
      if ((await readFile(path, "utf8")) === raw) await unlink(path);
    }
  }
  throw Error("Credential broker could not acquire ownership. Retry.");
}
// Exit handlers cannot await. Read only this app-owned lock, never credentials.
import { readFileSync } from "node:fs";
function readFileSyncSafe(path: string) {
  return readFileSync(path, "utf8");
}
export async function requireCredentialStorage() {
  if (!storageAllowed())
    throw Error(
      "AI is disabled. Start with pnpm cli start --ai; pnpm dev never stores OAuth credentials.",
    );
  const root = authRoot();
  let claim = owners.get(root);
  if (!claim) {
    claim = ownBroker(root).catch((e) => {
      owners.delete(root);
      throw e;
    });
    owners.set(root, claim);
  }
  await claim;
  return root;
}
function accountName(client: string) {
  return (
    "account-" + createHash("sha256").update(client).digest("hex") + ".json"
  );
}
async function protectedJson(name: string) {
  const root = await requireCredentialStorage(),
    path = join(root, name);
  const f = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await f.stat();
    if (
      !stat.isFile() ||
      stat.size > 100000 ||
      stat.mode & 0o077 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error(
        "Protected account file has invalid ownership, permissions or size.",
      );
    return JSON.parse(await f.readFile("utf8"));
  } finally {
    await f.close();
  }
}
async function atomic(name: string, value: unknown) {
  const root = await requireCredentialStorage(),
    temp = join(root, "." + randomUUID() + ".tmp");
  try {
    await writeFile(temp, JSON.stringify(value), { flag: "wx", mode: 0o600 });
    await rename(temp, join(root, name));
  } finally {
    await unlink(temp).catch(() => {});
  }
}
export async function readAccount(client: string): Promise<Credential> {
  const c = credentialSchema.parse(await protectedJson(accountName(client)));
  if (c.client_id !== client) throw Error("Account registration mismatch.");
  return c;
}
export async function writeAccount(c: Credential) {
  await atomic(accountName(c.client_id), credentialSchema.parse(c));
}
export async function listAccounts() {
  const root = await requireCredentialStorage(),
    files = (await readdir(/* turbopackIgnore: true */ root)).filter((f) =>
      /^account-[a-f0-9]{64}\.json$/.test(f),
    );
  if (files.length > 50)
    throw Error("Account catalog is limited to 50 local registrations.");
  const accounts: Credential[] = [],
    issues: string[] = [];
  for (const f of files) {
    try {
      accounts.push(credentialSchema.parse(await protectedJson(f)));
    } catch {
      issues.push(
        "A saved registration needs reconnecting; its original file has been preserved.",
      );
    }
  }
  return { accounts, issues };
}
export async function hostId() {
  try {
    return z
      .string()
      .regex(/^urn:uuid:[0-9a-f-]{36}$/i)
      .parse((await protectedJson("host.json")).id);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    const id = "urn:uuid:" + randomUUID();
    await atomic("host.json", { id });
    return id;
  }
}
export async function selectedAccount() {
  try {
    return z
      .string()
      .max(200)
      .nullable()
      .parse((await protectedJson("active.json")).client);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    return null;
  }
}
export async function saveSelection(client: string | null) {
  await atomic("active.json", { client });
}
