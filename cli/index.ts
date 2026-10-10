import { accountCommand, projectPublisher } from "./account";
import { projectStore, readManifestInputs } from "../lib/server/project-store";
import { importSnapshot } from "../lib/domain/snapshot";
import { collectSnapshot } from "../lib/server/collector";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { run } from "../lib/server/process";
import { stateRoot } from "../lib/server/runtime";
import { at, list, object, text } from "../lib/domain/types";
const [command = "start", ...args] = process.argv.slice(2);
async function main() {
  if (command === "login" || command === "auth")
    return accountCommand(command, args);
  if (command === "doctor") {
    for (const [tool, params] of [
      ["node", ["--version"]],
      ["docker", ["info", "--format", "{{.ServerVersion}}"]],
      ["kind", ["version"]],
      ["kubectl", ["version", "--client=true", "-o", "json"]],
    ] as const) {
      try {
        const out = await run(tool, [...params]);
        console.log(
          `${tool}: available ${tool === "kubectl" ? "" : out.trim()}`,
        );
      } catch (e) {
        console.log(`${tool}: unavailable — ${(e as Error).message}`);
        process.exitCode = 1;
      }
    }
    return;
  }
  if (command === "import") {
    const publish = await projectPublisher();
    const project = await readManifestInputs(args);
    const selected = publish
      ? (await publish(project)).selected
      : await projectStore.select(project);
    console.log(
      `Selected project: ${selected.project.label}. Open exploration views update automatically; active edits/practice show an Open CLI project action.`,
    );
    return;
  }
  if (command === "collect") {
    const context = args[args.indexOf("--context") + 1];
    const ns = args[args.indexOf("--namespaces") + 1];
    const out = args[args.indexOf("--out") + 1];
    const kubeconfig = args.includes("--kubeconfig")
      ? args[args.indexOf("--kubeconfig") + 1]
      : undefined;
    if (
      !args.includes("--context") ||
      !args.includes("--namespaces") ||
      !args.includes("--out") ||
      !context ||
      !ns ||
      !out
    )
      throw new Error(
        "Usage: collect --context NAME --namespaces ns1,ns2 --out snapshot.json [--kubeconfig FILE]. Read-only; no Secrets/logs.",
      );
    const publish = await projectPublisher();
    const snapshot = importSnapshot(
      JSON.stringify(await collectSnapshot(context, ns.split(","), kubeconfig)),
    );
    await writeFile(resolve(out), JSON.stringify(snapshot, null, 2), {
      mode: 0o600,
    });
    try {
      if (publish) await publish(snapshot);
      else await projectStore.select(snapshot);
    } catch (e) {
      throw Error(
        `Snapshot saved to ${out}, but selection was rejected: ${(e as Error).message}`,
      );
    }
    console.log(
      `Selected project ${snapshot.label}. Read-only snapshot saved to ${out}; ${snapshot.coverage.filter((c) => c.state !== "captured").length} partial-access errors. No Secrets or logs collected.`,
    );
    return;
  }
  if (command === "status" || command === "stop") {
    const config = object(
      JSON.parse(await readFile(join(stateRoot, "server.json"), "utf8")),
    );
    const origin = text(config.origin),
      token = text(config.token);
    const headers = {
      Authorization: "Bearer " + token,
      Origin: origin,
      "Content-Type": "application/json",
    };
    const data = await fetch(origin + "/api/session", { headers }).then((r) =>
      r.json(),
    );
    if (command === "status") {
      const local = object(
        JSON.parse(await readFile(join(stateRoot, "session.json"), "utf8")),
      );
      console.log(
        JSON.stringify(
          {
            id: data.lab?.id,
            state: data.lab?.state,
            phase: data.lab?.phase,
            error: data.lab?.error,
            scenario: data.lab?.scenario,
            revision: data.lab?.revision,
            generation: data.lab?.generation,
            checks: data.lab?.checks,
            capturedAt: data.lab?.observation?.capturedAt,
          },
          null,
          2,
        ),
      );
      if (local.kubeconfig)
        console.log(
          `Explicit sandbox commands:\nkubectl --kubeconfig ${JSON.stringify(local.kubeconfig)} --context kind-${local.clusterName} -n ${local.namespace} get pods,services,endpointslices\nkubectl --kubeconfig ${JSON.stringify(local.kubeconfig)} --context kind-${local.clusterName} -n ${local.namespace} describe pod\n`,
        );
    } else if (data.lab) {
      const r = await fetch(origin + "/api/lab", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "stop",
          operationId: crypto.randomUUID(),
          sessionId: data.lab.id,
          generation: data.lab.generation,
          expectedRevision: data.lab.revision,
        }),
      });
      console.log(await r.text());
    }
    return;
  }
  if (command !== "start")
    throw new Error("Commands: start, doctor, import, collect, status, stop.");
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid PORT.");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const lock = join(stateRoot, "server.lock");
  try {
    const f = await open(lock, "wx", 0o600);
    await f.writeFile(String(process.pid));
    await f.close();
  } catch {
    let pid = 0;
    try {
      pid = Number(await readFile(lock, "utf8"));
      process.kill(pid, 0);
    } catch {
      await unlink(lock);
      return main();
    }
    throw new Error(
      `A local UI owner is already running (PID ${pid}). Stop it before another start.`,
    );
  }
  const token = randomBytes(32).toString("hex"),
    bootstrap = randomBytes(32).toString("hex"),
    origin = `http://127.0.0.1:${port}`;
  await writeFile(
    join(stateRoot, "server.json"),
    JSON.stringify({ origin, token, pid: process.pid }),
    { mode: 0o600 },
  );
  const child = spawn(
    process.execPath,
    [
      join(process.cwd(), "node_modules/next/dist/bin/next"),
      "dev",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    {
      stdio: "inherit",
      env: {
        ...process.env,
        ...(args.includes("--ai") && !args.includes("--dev")
          ? {
              PLAYGROUND_AI_ENABLED: "1",
              PLAYGROUND_ALLOW_CREDENTIAL_STORAGE: "1",
            }
          : {}),
        ...(args.includes("--dev")
          ? {
              PLAYGROUND_AI_ENABLED: "0",
              PLAYGROUND_ALLOW_CREDENTIAL_STORAGE: "0",
            }
          : {}),
        NEXT_TELEMETRY_DISABLED: "1",
        PLAYGROUND_ORIGIN: origin,
        PLAYGROUND_API_TOKEN: token,
        PLAYGROUND_BOOTSTRAP: bootstrap,
      },
    },
  );
  console.log(
    `\nOpen once to connect your local workspace:\n${origin}/?connect=${bootstrap}\n\n${args.includes("--dev") || (!args.includes("--ai") && process.env.PLAYGROUND_AI_ENABLED !== "1") ? "Development mode: ChatGPT sign-in and AI inference are disabled. No OAuth credentials are stored; authored hints are available." : "AI mode: Waypoint stores its own protected OAuth credentials locally after browser consent. Inference is sent to OpenAI."} Ctrl+C stops the UI. If you separately started an optional real lab, run pnpm cli stop before exiting.\n`,
  );
  const clean = async () => {
    await unlink(lock).catch(() => {});
    await unlink(join(stateRoot, "server.json")).catch(() => {});
  };
  child.on("exit", async (code) => {
    await clean();
    process.exitCode = code ?? 0;
  });
  process.on("SIGINT", () => child.kill("SIGINT"));
  process.on("SIGTERM", () => child.kill("SIGTERM"));
}
main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
