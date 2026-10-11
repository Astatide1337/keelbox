import { repositoryEntries } from "../lib/server/repository-import";
import { acquireOperationLock } from "../lib/server/operation-lock";
import { createServer } from "node:net";
import { doctor } from "./doctor";
import { broker } from "./account";
import { existsSync } from "node:fs";
import { accountCommand, projectPublisher } from "./account";
import { projectStore, readManifestInputs } from "../lib/server/project-store";
import { importSnapshot } from "../lib/domain/snapshot";
import { collectSnapshot } from "../lib/server/collector";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, open, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";
import { realpathSync } from "node:fs";
import { run } from "../lib/server/process";
import { stateRoot } from "../lib/server/runtime";
import { at, list, object, text } from "../lib/domain/types";
import { targetKey } from "../lib/domain/generated-incident";
const [command = "start", ...args] = process.argv.slice(2);
async function main() {
  if (command === "login" || command === "auth")
    return accountCommand(command, args);
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(`Waypoint — local Kubernetes debugging and learning
Commands:
  start                       Open local UI and sign in with ChatGPT
  doctor                       Check Linux/Docker/Minikube/kubectl and resources
  import PATH                  Review/select YAML/JSON, Helm or Kustomize in the local UI
  demo market-data             Select the bundled synthetic market-data lesson
    --list | --entry PATH      Choose an application/environment in a repository
    --values FILE (ordered) --release NAME --namespace NAME
    --kube-version VERSION --api-version API (repeatable)
    --recurse                  Explicitly include a selected YAML subtree
    --resolve-argo             Resolve pinned public Argo desired sources once
  collect --context NAME --namespaces ns1,ns2 --out FILE [--kubeconfig FILE]
                               Read-only capture; no Secrets/logs
  lab plan PATH                Preview a supported local deployment
  lab create                   Create the reviewed, owned Minikube lab
  lab status                   Actual session/evidence state and explicit terminal target
  lab incident INCIDENT [TARGET]  Start a validated incident for one exact workload
    readiness|liveness|service-selector|service-target-port|image-pull|configmap-key|market-data-stale
  lab repair                      Reapply the reviewed repair for a corroborated incident
  lab apply FILE               Apply a repair to the lab copy only
  lab check | reset | cleanup   Verify, reapply baseline (preserve Job/PVC data), or delete owned lab
  lab run-cronjob NS/NAME --confirm
                               Run one reviewed Job without changing its schedule
  login | auth status | auth logout
PORT controls the loopback UI port (default 3000). No image builds or postinstall effects.`);
    return;
  }
  if (command === "doctor") {
    const checks = await doctor();
    for (const c of checks)
      console.log(`${c.ok ? "OK" : "FAIL"} ${c.name}: ${c.detail}`);
    if (checks.some((c) => !c.ok)) process.exitCode = 1;
    return;
  }
  if (command === "demo") {
    if (args[0] !== "market-data")
      throw Error("Usage: waypoint demo market-data");
    const entry = realpathSync(process.argv[1] ?? ""),
      packageRoot =
        basename(entry) === "index.ts"
          ? resolve(dirname(entry), "..")
          : resolve(dirname(entry), "../.."),
      demoPath = resolve(packageRoot, "examples/market-data"),
      publish = await projectPublisher();
    if (!publish)
      throw Error(
        "Start Waypoint and sign in with ChatGPT before selecting a demo.",
      );
    const project = await readManifestInputs([demoPath]);
    const selected = (await publish(project)).selected;
    console.log(
      `Selected ${selected.project.label}. Open Waypoint Practice and review the deployment plan before creating its owned local lab.`,
    );
    return;
  }
  if (
    command === "lab" ||
    command === "cleanup" ||
    command === "status" ||
    command === "stop"
  ) {
    const { call } = await broker(),
      kind =
        command === "lab"
          ? (args[0] ?? "status")
          : command === "stop"
            ? "cleanup"
            : command;
    if (kind === "plan") {
      console.log(
        JSON.stringify(
          await call("/api/lab", {
            kind: "plan",
            project: await readManifestInputs(args.slice(1)),
          }),
          null,
          2,
        ),
      );
      return;
    }
    const current = await call("/api/lab");
    if (kind === "status") {
      console.log(JSON.stringify(current, null, 2));
      return;
    }
    if (kind === "create") {
      if (!current.plan)
        throw Error("Run lab plan and review its changes first.");
      console.log(
        JSON.stringify(
          await call("/api/lab", {
            kind: "create",
            planHash: current.plan.planHash,
          }),
          null,
          2,
        ),
      );
      return;
    }
    if (
      ![
        "incident",
        "repair",
        "apply",
        "check",
        "reset",
        "recover",
        "cleanup",
        "run-cronjob",
      ].includes(kind)
    )
      throw Error("Unknown lab command. Run waypoint help.");
    if (!current.lab) throw Error("No local lab. Review lab plan first.");
    if (kind === "reset")
      console.log(
        JSON.stringify(
          current.resetPreview ??
            current.lab.resetPreview ?? {
              effect: "Reapply baseline; preserve Job executions and PVC data.",
            },
          null,
          2,
        ),
      );
    if (kind === "run-cronjob" && (!args.includes("--confirm") || !args[1]))
      throw Error(
        "Review waypoint lab status scheduledExecutions, then use waypoint lab run-cronjob NAMESPACE/NAME --confirm. This creates one Job in the owned lab.",
      );
    const body = {
      kind,
      operationId: crypto.randomUUID(),
      sessionId: current.lab.id,
      generation: current.lab.generation,
      revision: current.lab.revision,
      ...(kind === "incident"
        ? {
            incident: args[1] ?? "readiness",
            target:
              args[2] ??
              (current.lab.plan.contract
                ? targetKey(current.lab.plan.contract, current.lab.namespace)
                : undefined),
          }
        : {}),
      ...(kind === "run-cronjob" ? { target: args[1] } : {}),
      ...(kind === "apply"
        ? { source: await readFile(resolve(args[1] ?? ""), "utf8") }
        : {}),
    };
    console.log(JSON.stringify(await call("/api/lab", body), null, 2));
    return;
  }
  if (command === "import") {
    if (args.includes("--list")) {
      const root = resolve(args.find((a) => !a.startsWith("--")) ?? ".");
      console.log(JSON.stringify(await repositoryEntries(root), null, 2));
      return;
    }
    const options: import("../lib/server/repository-import").RepositoryOptions & {
      resolveArgo?: boolean;
    } = {
      values: [],
    };
    const paths: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === "--resolve-argo") {
        options.resolveArgo = true;
        continue;
      }
      if (args[i] === "--recurse") {
        options.recurse = true;
        continue;
      }
      if (
        [
          "--entry",
          "--values",
          "--release",
          "--namespace",
          "--kube-version",
          "--api-version",
        ].includes(args[i])
      ) {
        const flag = args[i],
          value = args[++i];
        if (!value || value.startsWith("--"))
          throw Error("Missing value for " + flag);
        if (flag === "--values") (options.values ??= []).push(value);
        else if (flag === "--entry") options.entry = value;
        else if (flag === "--namespace") options.namespace = value;
        else if (flag === "--kube-version") options.kubernetesVersion = value;
        else if (flag === "--api-version")
          (options.apiVersions ??= []).push(value);
        else options.release = value;
      } else if (args[i].startsWith("--"))
        throw Error("Unknown import option: " + args[i]);
      else paths.push(args[i]);
    }
    const publish = await projectPublisher();
    if (!publish)
      throw Error("Start Waypoint and sign in with ChatGPT before importing.");
    const project = await readManifestInputs(paths, options);
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
      else {
        console.log(
          `Read-only snapshot saved to ${out}. Start Waypoint and sign in with ChatGPT, then import this file to select it.`,
        );
        return;
      }
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
  if (command !== "start")
    throw new Error("Unknown command. Run waypoint help.");
  if (args.includes("--dev"))
    throw Error(
      "The no-login development mode has been removed. Run waypoint start and sign in with ChatGPT.",
    );
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1024 || port > 65535)
    throw new Error("Invalid PORT.");
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const lock = join(stateRoot, "server.lock");
  await new Promise<void>((resolve, reject) => {
    const probe = createServer();
    probe.once("error", () =>
      reject(Error(`Port ${port} is unavailable. Choose another PORT.`)),
    );
    probe.listen(port, "127.0.0.1", () => probe.close(() => resolve()));
  });
  const serverLock = await acquireOperationLock(lock);
  const token = randomBytes(32).toString("hex"),
    bootstrap = randomBytes(32).toString("hex"),
    origin = `http://127.0.0.1:${port}`;
  await writeFile(
    join(stateRoot, "server.json"),
    JSON.stringify({ origin, token, pid: process.pid }),
    { mode: 0o600 },
  );
  const packaged =
    typeof __dirname !== "undefined" &&
    existsSync(join(__dirname, "../ui/server.js"));
  const uiRoot = packaged ? resolve(__dirname, "../ui") : process.cwd();
  const child = spawn(
    process.execPath,
    packaged
      ? [join(uiRoot, "server.js")]
      : [
          join(uiRoot, "node_modules/next/dist/bin/next"),
          "dev",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(port),
        ],
    {
      stdio: "inherit",
      cwd: uiRoot,
      env: {
        ...process.env,
        PLAYGROUND_AI_ENABLED: "1",
        PLAYGROUND_ALLOW_CREDENTIAL_STORAGE: "1",
        NEXT_TELEMETRY_DISABLED: "1",
        HOSTNAME: "127.0.0.1",
        PORT: String(port),
        PLAYGROUND_ORIGIN: origin,
        PLAYGROUND_API_TOKEN: token,
        PLAYGROUND_BOOTSTRAP: bootstrap,
      },
    },
  );
  console.log(
    `\nOpen once to connect your local workspace:\n${origin}/?connect=${bootstrap}\n\nSign in with ChatGPT. Waypoint stores its own protected OAuth credentials locally after browser consent. Inference is sent to OpenAI. Ctrl+C stops the UI. Use waypoint lab cleanup to remove an owned lab. Stopping the UI does not delete clusters.\n`,
  );
  const clean = async () => {
    await serverLock.close();
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
