import { readFile, lstat } from "node:fs/promises";
import { join } from "node:path";
import { stateRoot } from "../lib/server/runtime";
import { z } from "zod";
const configSchema = z.object({
  origin: z.string().url(),
  token: z.string().min(32),
});
export async function broker() {
  const path = join(stateRoot, "server.json"),
    file = await lstat(path);
  if (
    !file.isFile() ||
    file.isSymbolicLink() ||
    file.mode & 0o077 ||
    (process.getuid && file.uid !== process.getuid())
  )
    throw Error("Local broker file must be an owner-only regular file.");
  const config = configSchema.parse(
    JSON.parse(await readFile(join(stateRoot, "server.json"), "utf8")),
  );
  const url = new URL(config.origin);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw Error("Refusing a non-loopback broker address.");
  const headers: Record<string, string> = {
    Authorization: "Bearer " + config.token,
    Origin: config.origin,
    "Content-Type": "application/json",
  };
  async function call(path: string, body?: unknown) {
    const r = await fetch(config.origin + path, {
      method: body ? "POST" : "GET",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(65000),
    });
    const data = await r.json();
    if (!r.ok) throw Error(data.error ?? "Local broker request failed.");
    return data;
  }
  const status = await call("/api/auth");
  if (status.profile) {
    headers["x-waypoint-profile"] = status.profile.key;
    headers["x-waypoint-epoch"] = status.epoch;
  }
  return { call, status };
}
export async function accountCommand(command: string, args: string[]) {
  const { call, status } = await broker();
  if (command === "auth" && (args[0] ?? "status") === "status") {
    const { csrf: unusedCsrf, ...publicStatus } = status;
    console.log(JSON.stringify(publicStatus, null, 2));
    return;
  }
  if (command === "auth" && args[0] === "logout") {
    const result = await call("/api/auth", { kind: "signout" });
    console.log(
      result.revoked
        ? "Signed out; remote token revoked."
        : "Signed out locally. Remote revocation could not be confirmed; manage access in ChatGPT settings.",
    );
    return;
  }
  if (command === "login" || (command === "auth" && args[0] === "switch")) {
    const account = command === "auth" ? args[1] : undefined;
    if (command === "auth" && !account)
      throw Error("Usage: auth switch CLIENT_ID (listed by auth status).");
    const attempt = await call("/api/auth", { kind: "login", account });
    console.log(
      `Complete official sign-in and consent in your browser:\n${attempt.url}\nThe link is single-use. No cluster data is sent during sign-in.`,
    );
    return;
  }
  throw Error(
    "Commands: login, auth status, auth switch CLIENT_ID, auth logout.",
  );
}

export async function projectPublisher() {
  let connection: Awaited<ReturnType<typeof broker>>;
  try {
    connection = await broker();
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (!connection.status.enabled) return null;
  if (!connection.status.profile)
    throw Error(
      "Sign in through pnpm cli login before importing an account-owned project.",
    );
  return async (project: unknown) =>
    connection.call("/api/project", { kind: "select", project });
}
