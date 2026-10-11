import { spawn } from "node:child_process";
import { lstat, readFile, writeFile, chmod } from "node:fs/promises";
export type OperationLock = { close: () => Promise<void> };
export class OperationLockBusy extends Error {}
export async function acquireOperationLock(
  path: string,
): Promise<OperationLock> {
  try {
    const stat = await lstat(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw Error("Lock must be an owned regular file.");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  // A permanent inode plus a kernel lock avoids stale-PID unlink races. Closing
  // stdin (including after a parent crash) releases the child's kernel lock.
  return new Promise((resolve, reject) => {
    const child = spawn(
      "flock",
      [
        "--exclusive",
        "--nonblock",
        "--conflict-exit-code",
        "75",
        path,
        "sh",
        "-c",
        "printf READY; cat >/dev/null",
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let ready = false,
      output = "",
      detail = "";
    child.stderr.on("data", (data) => {
      detail = (detail + data.toString()).slice(-1000);
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (!ready)
        reject(
          code === 75
            ? new OperationLockBusy(
                "Another runtime owns the operation lock. Wait for its operation to finish.",
              )
            : Error(
                "Unable to acquire the operation lock. Check flock and file access. " +
                  detail,
              ),
        );
    });
    child.stdout.on("data", async (data) => {
      output += data.toString();
      if (ready || !output.includes("READY")) return;
      ready = true;
      const close = () =>
        new Promise<void>((done) => {
          if (child.exitCode !== null) return done();
          child.once("exit", () => done());
          child.stdin.end();
        });
      try {
        const legacy = (await readFile(path, "utf8")).trim();
        if (/^\d+$/.test(legacy)) {
          const pid = Number(legacy);
          if (pid > 0) {
            try {
              process.kill(pid, 0);
              throw new OperationLockBusy(
                "Another runtime owns the operation lock (legacy owner).",
              );
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
            }
          }
        }
        await writeFile(
          path,
          JSON.stringify({ protocol: "flock-v1", pid: process.pid }),
          { mode: 0o600 },
        );
        await chmod(path, 0o600);
        resolve({ close });
      } catch (e) {
        await close();
        reject(e);
      }
    });
  });
}
