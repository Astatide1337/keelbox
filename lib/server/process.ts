import { spawn } from "node:child_process";
export function run(
  command: string,
  args: string[],
  options: { input?: string; timeout?: number; limit?: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal } = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      env: options.env ?? process.env,
      signal: options.signal,
    });
    let out = "",
      err = "",
      settled = false;
    const limit = options.limit ?? 2_000_000;
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(
        new Error(`${command} timed out after ${options.timeout ?? 30000}ms.`),
      );
    }, options.timeout ?? 30000);
    function finish(error?: Error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      error ? reject(error) : resolve(out);
    }
    child.on("error", finish);
    child.stdout.on("data", (d) => {
      out += d.toString();
      if (out.length > limit) {
        child.kill("SIGKILL");
        finish(new Error("Command output exceeded its bound."));
      }
    });
    child.stderr.on("data", (d) => {
      err = (err + d.toString()).slice(-12000);
    });
    child.on("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(`${command} failed (${code}): ${err || out}`),
      ),
    );
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}
