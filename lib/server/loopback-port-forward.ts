import { spawn } from "node:child_process";
import { createServer } from "node:net";
import {
  assertOwned,
  environment,
  kube,
  kubeArgs,
  type OwnedTarget,
} from "./minikube";
import { at, list, object, text, type ObjectMap } from "../domain/types";

export type JsonHttpResponse = {
  status: number;
  body: Record<string, unknown>;
};
export type OwnedReadyPod = { name: string; uid: string };

type ForwardResource = `pod/${string}` | `service/${string}`;

function validResourceName(name: string) {
  return name.length <= 253 && /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(name);
}

export function selectSingleReadyDeploymentPod(
  pods: ObjectMap[],
): OwnedReadyPod {
  // Callers supply only Pods whose owner UID chain leads to the selected Deployment.
  const ready = pods.filter(
    (pod) =>
      text(at(pod, "status", "phase")) === "Running" &&
      !at(pod, "metadata", "deletionTimestamp") &&
      list(at(pod, "status", "conditions")).some(
        (condition) =>
          condition.type === "Ready" && condition.status === "True",
      ),
  );
  if (ready.length !== 1)
    throw Error(
      "Expected exactly one Ready Pod owned by the selected Deployment.",
    );
  const name = text(at(ready[0], "metadata", "name"));
  const uid = text(at(ready[0], "metadata", "uid"));
  if (!validResourceName(name) || !uid || uid.length > 128)
    throw Error("The selected owned Pod has an invalid Kubernetes identity.");
  return { name, uid };
}

async function availableLoopbackPort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw Error("Could not reserve a loopback port for the owned lab.");
  }
  const { port } = address;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

async function withOwnedPortForward<T>(
  target: OwnedTarget,
  namespace: string,
  resource: ForwardResource,
  remotePort: number,
  action: (origin: string) => Promise<T>,
) {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace))
    throw Error("Invalid owned lab namespace for port-forward.");
  const [kind, name, ...extra] = resource.split("/");
  if (
    extra.length ||
    (kind !== "pod" && kind !== "service") ||
    !validResourceName(name)
  )
    throw Error("Invalid owned lab port-forward resource.");
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65535)
    throw Error("Invalid reviewed remote port.");
  await assertOwned(target);
  const localPort = await availableLoopbackPort(),
    args = kubeArgs(target, [
      "-n",
      namespace,
      "port-forward",
      "--address=127.0.0.1",
      resource,
      `${localPort}:${remotePort}`,
    ]),
    child = spawn("kubectl", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: environment(target),
    });
  let output = "";
  const ready = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(Error("Owned lab port-forward did not become ready.")),
      10000,
    );
    const onData = (data: Buffer) => {
      output = (output + data.toString()).slice(-4000);
      if (output.includes(`127.0.0.1:${localPort} -> ${remotePort}`)) {
        clearTimeout(timer);
        child.stdout.off("data", onData);
        resolve();
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", (data: Buffer) => {
      output = (output + data.toString()).slice(-4000);
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      reject(
        Error(
          `Owned lab port-forward exited before listening (${code}): ${output.slice(-1000)}`,
        ),
      );
    });
  });
  try {
    await ready;
    await assertOwned(target);
    return await action(`http://127.0.0.1:${localPort}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
        resolve();
      }, 1500);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
    await assertOwned(target);
  }
}

export function withOwnedServicePortForward<T>(
  target: OwnedTarget,
  namespace: string,
  service: string,
  remotePort: number,
  action: (origin: string) => Promise<T>,
) {
  return withOwnedPortForward(
    target,
    namespace,
    `service/${service}`,
    remotePort,
    action,
  );
}

export function withOwnedPodControlForward<T>(
  target: OwnedTarget,
  namespace: string,
  pod: OwnedReadyPod,
  action: (origin: string) => Promise<T>,
) {
  if (!validResourceName(pod.name) || !pod.uid || pod.uid.length > 128)
    throw Error("Invalid owned producer Pod identity for control forwarding.");
  return withOwnedPortForward(
    target,
    namespace,
    `pod/${pod.name}`,
    8081,
    async (origin) => {
      await assertOwned(target);
      const current = object(
        JSON.parse(
          await kube(target, [
            "-n",
            namespace,
            "get",
            "pod",
            pod.name,
            "-o",
            "json",
          ]),
        ),
      );
      const stillReady =
        text(at(current, "metadata", "uid")) === pod.uid &&
        text(at(current, "status", "phase")) === "Running" &&
        !at(current, "metadata", "deletionTimestamp") &&
        list(at(current, "status", "conditions")).some(
          (condition) =>
            condition.type === "Ready" && condition.status === "True",
        );
      if (!stillReady)
        throw Error(
          "The exact owned producer Pod changed before control forwarding.",
        );
      return action(origin);
    },
  );
}

async function jsonRequest(
  origin: string,
  path: string,
  method: "GET" | "POST",
): Promise<JsonHttpResponse> {
  const response = await fetch(origin + path, {
    method,
    signal: AbortSignal.timeout(2000),
    headers: { Accept: "application/json" },
  });
  const raw = await response.text();
  if (raw.length > 64_000)
    throw Error("Owned lab response exceeded its bound.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw Error("Owned lab endpoint returned invalid JSON.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw Error("Owned lab endpoint returned a non-object response.");
  return { status: response.status, body: body as Record<string, unknown> };
}

export function ownedLabJson(
  origin: string,
  path: "/quote" | "/metrics" | "/livez" | "/readyz",
): Promise<JsonHttpResponse> {
  return jsonRequest(origin, path, "GET");
}

export function ownedLabControlPath(action: unknown) {
  if (action === "pause") return "/lab/pause" as const;
  if (action === "resume") return "/lab/resume" as const;
  throw Error("Unsupported synthetic feed control.");
}

export function ownedLabControl(
  origin: string,
  action: "pause" | "resume",
): Promise<JsonHttpResponse> {
  return jsonRequest(origin, ownedLabControlPath(action), "POST");
}
