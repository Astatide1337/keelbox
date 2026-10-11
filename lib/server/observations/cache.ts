import { observationFreshness } from "../../domain/freshness";
export { observationFreshness } from "../../domain/freshness";
import { request, Agent } from "node:https";
import type { IncomingMessage } from "node:http";
import { at, object, text, type ObjectMap } from "../../domain/types";
import { configIdentity, type OwnedTarget } from "../minikube";
export type CacheStatus = {
  kind: string;
  state: "connecting" | "current" | "stale" | "denied" | "unavailable";
  receivedAt: string | null;
  resourceVersion: string;
  error?: string;
};
export type LogBuffer = {
  uid: string;
  container: string;
  lines: string[];
  bytes: number;
  truncated: boolean;
  state: "following" | "unavailable" | "stopped";
  error?: string;
  receivedAt?: string;
  previous?: string;
  gaps: string[];
  containerId?: string;
  restartCount?: number;
  generation?: number;
};
const routes: Record<string, string> = {
  Pod: "/api/v1",
  Service: "/api/v1",
  ConfigMap: "/api/v1",
  Event: "/api/v1",
  StatefulSet: "/apis/apps/v1",
  DaemonSet: "/apis/apps/v1",
  Job: "/apis/batch/v1",
  CronJob: "/apis/batch/v1",
  Ingress: "/apis/networking.k8s.io/v1",
  PersistentVolumeClaim: "/api/v1",
  NetworkPolicy: "/apis/networking.k8s.io/v1",
  ServiceAccount: "/api/v1",
  Deployment: "/apis/apps/v1",
  ReplicaSet: "/apis/apps/v1",
  EndpointSlice: "/apis/discovery.k8s.io/v1",
};
const plurals: Record<string, string> = {
  Pod: "pods",
  Service: "services",
  ConfigMap: "configmaps",
  Event: "events",
  StatefulSet: "statefulsets",
  DaemonSet: "daemonsets",
  Job: "jobs",
  CronJob: "cronjobs",
  Ingress: "ingresses",
  PersistentVolumeClaim: "persistentvolumeclaims",
  NetworkPolicy: "networkpolicies",
  ServiceAccount: "serviceaccounts",
  Deployment: "deployments",
  ReplicaSet: "replicasets",
  EndpointSlice: "endpointslices",
};
export class LiveCache {
  private agent: Agent | null = null;
  private server = "";
  private stopped = false;
  private connections = new Set<IncomingMessage>();
  private timers = new Set<NodeJS.Timeout>();
  private maps = new Map<string, Map<string, ObjectMap>>();
  statuses: CacheStatus[] = [];
  logs = new Map<string, LogBuffer>();
  private logConnections = new Map<string, IncomingMessage>();
  constructor(
    private target: OwnedTarget,
    private namespaces: string[] = [target.namespace],
  ) {}
  async start() {
    const { cluster, user } = await configIdentity(this.target);
    this.server = text(cluster.server);
    this.agent = new Agent({
      ca: Buffer.from(text(cluster["certificate-authority-data"]), "base64"),
      cert: Buffer.from(text(user["client-certificate-data"]), "base64"),
      key: Buffer.from(text(user["client-key-data"]), "base64"),
      keepAlive: true,
    });
    for (const kind of Object.keys(routes)) {
      this.maps.set(kind, new Map());
      const status: CacheStatus = {
        kind,
        state: "connecting",
        receivedAt: null,
        resourceVersion: "",
      };
      this.statuses.push(status);
      void this.watch(kind, status);
    }
  }
  private async response(path: string) {
    if (this.stopped) throw Error("Observation session stopped.");
    return new Promise<IncomingMessage>((resolve, reject) => {
      const req = request(
        new URL(path, this.server),
        { agent: this.agent!, method: "GET", timeout: 65000 },
        resolve,
      );
      req.on("error", reject);
      req.on("timeout", () => req.destroy(Error("Kubernetes stream timeout")));
      req.end();
    });
  }
  private async json(path: string) {
    const r = await this.response(path);
    this.connections.add(r);
    let b = "";
    try {
      for await (const part of r) {
        b += part.toString();
        if (Buffer.byteLength(b) > 10 * 1024 * 1024) {
          r.destroy();
          throw Error("Resource list exceeds 10 MiB limit.");
        }
      }
      if (r.statusCode !== 200)
        throw Error(`Kubernetes HTTP ${r.statusCode}: ${b.slice(0, 300)}`);
      return object(JSON.parse(b));
    } finally {
      this.connections.delete(r);
    }
  }
  private delay(ms: number) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        resolve();
      }, ms);
      this.timers.add(timer);
    });
  }
  private async watch(kind: string, status: CacheStatus) {
    let failures = 0;
    const base = `${routes[kind]}/${plurals[kind]}`;
    while (!this.stopped) {
      let stream: IncomingMessage | undefined;
      try {
        if (!status.resourceVersion) {
          const data = await this.json(base);
          const items = Array.isArray(data.items)
            ? data.items
                .map(object)
                .filter((v) =>
                  this.namespaces.includes(
                    text(at(v, "metadata", "namespace")),
                  ),
                )
            : [];
          if (items.length > 2000)
            throw Error("Resource count exceeds 2,000 limit.");
          const candidate = new Map(
            items.map(
              (v) =>
                [
                  text(at(v, "metadata", "uid")),
                  {
                    ...v,
                    kind,
                    apiVersion: routes[kind]
                      .split("/")
                      .slice(-2)
                      .join("/")
                      .replace("api/v1", "v1"),
                  },
                ] as const,
            ),
          );
          if (
            Buffer.byteLength(JSON.stringify([...candidate.values()])) >
            10 * 1024 * 1024
          )
            throw Error("Resource cache limit exceeded on relist.");
          this.maps.set(kind, candidate);
          status.resourceVersion = text(
            at(data, "metadata", "resourceVersion"),
          );
          status.state = "current";
          status.receivedAt = new Date().toISOString();
          delete status.error;
        }
        // A reconnect attempt is not a successful observation. Retain the
        // last confirmed receipt time and retry count until data is received.
        status.state = "connecting";
        stream = await this.response(
          `${base}?watch=true&allowWatchBookmarks=true&timeoutSeconds=45&resourceVersion=${encodeURIComponent(status.resourceVersion)}`,
        );
        this.connections.add(stream);
        if (stream.statusCode === 410) {
          status.resourceVersion = "";
          throw Error("Watch history expired; relisting.");
        }
        if (stream.statusCode !== 200)
          throw Error(`Watch HTTP ${stream.statusCode}`);
        status.state = "current";
        delete status.error;
        const openedAt = Date.now();
        let receivedFrame = false;
        let pending = "";
        for await (const bytes of stream) {
          if (this.stopped) break;
          pending += bytes.toString();
          if (Buffer.byteLength(pending) > 2 * 1024 * 1024)
            throw Error("Watch record exceeded buffer bound.");
          let nl;
          while ((nl = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, nl);
            pending = pending.slice(nl + 1);
            if (!line.trim()) continue;
            const event = object(JSON.parse(line)),
              value = object(event.object),
              uid = text(at(value, "metadata", "uid"));
            if (event.type === "ERROR") {
              if (value.code === 410) status.resourceVersion = "";
              throw Error(`Watch error ${value.code ?? "unknown"}`);
            }
            if (
              !["ADDED", "MODIFIED", "DELETED", "BOOKMARK"].includes(
                text(event.type),
              ) ||
              !text(at(value, "metadata", "resourceVersion")) ||
              (event.type !== "BOOKMARK" && !uid)
            )
              throw Error(
                "Watch record lacks a supported type, UID or resourceVersion.",
              );
            receivedFrame = true;
            failures = 0;
            const rv = text(at(value, "metadata", "resourceVersion"));
            if (
              event.type !== "BOOKMARK" &&
              !this.namespaces.includes(
                text(at(value, "metadata", "namespace")),
              )
            ) {
              status.resourceVersion =
                text(at(value, "metadata", "resourceVersion")) ||
                status.resourceVersion;
              continue;
            }
            if (event.type !== "BOOKMARK" && uid) {
              const candidate = new Map(this.maps.get(kind)!);
              if (event.type === "DELETED") candidate.delete(uid);
              else
                candidate.set(uid, {
                  ...value,
                  kind,
                  apiVersion:
                    value.apiVersion ??
                    (routes[kind] === "/api/v1" ? "v1" : routes[kind].slice(6)),
                });
              const cap = kind === "Event" ? 2 * 1024 * 1024 : 10 * 1024 * 1024;
              if (kind === "Event") {
                while (
                  candidate.size > 2000 ||
                  Buffer.byteLength(JSON.stringify([...candidate.values()])) >
                    cap
                ) {
                  candidate.delete(candidate.keys().next().value!);
                  status.error = "Recent events truncated to buffer limits.";
                }
              } else if (
                candidate.size > 2000 ||
                Buffer.byteLength(JSON.stringify([...candidate.values()])) > cap
              ) {
                status.resourceVersion = "";
                throw Error(
                  "Resource cache limit exceeded; bounded relist required.",
                );
              }
              this.maps.set(kind, candidate);
              if (kind === "Pod" && event.type === "DELETED")
                for (const [key, b] of this.logs) {
                  if (b.uid === uid) {
                    this.logConnections.get(key)?.destroy();
                    b.state = "unavailable";
                    b.gaps.push(
                      "Selected Pod was deleted/replaced; logs stopped for this UID.",
                    );
                  }
                }
            }
            if (rv) status.resourceVersion = rv;
            status.receivedAt = new Date().toISOString();
            status.state = "current";
          }
        }
        if (!this.stopped) {
          if (!receivedFrame && Date.now() - openedAt < 1000)
            throw Error("Watch closed before receiving data; reconnecting.");
          // Quiet watches need a bounded confirming LIST, rather than an
          // invented heartbeat timestamp on every new HTTP connection.
          if (
            !status.receivedAt ||
            Date.now() - Date.parse(status.receivedAt) >= 45000
          )
            status.resourceVersion = "";
        }
      } catch (e) {
        if (this.stopped) break;
        status.state = String(e).includes("403") ? "denied" : "stale";
        status.error = (e as Error).message;
        failures++;
        await this.delay(
          Math.min(30000, 1000 * 2 ** Math.min(failures, 5)) +
            Math.random() * 250,
        );
      } finally {
        if (stream) {
          stream.destroy();
          this.connections.delete(stream);
        }
      }
    }
  }
  view() {
    return {
      resources: [...this.maps.entries()]
        .filter(([k]) => k !== "Event")
        .flatMap(([, m]) => [...m.values()]),
      events: [...(this.maps.get("Event")?.values() ?? [])],
      status: structuredClone(this.statuses),
      connection: observationFreshness(this.statuses),
      receivedAt:
        this.statuses
          .map((s) => s.receivedAt)
          .filter(Boolean)
          .sort()
          .at(-1) ?? null,
    };
  }
  fresh() {
    return (
      this.statuses.length === Object.keys(routes).length &&
      observationFreshness(this.statuses).state === "current"
    );
  }
  async follow(uid: string, container: string) {
    const pod = this.maps.get("Pod")?.get(uid);
    if (!pod)
      throw Error(
        "Selected Pod UID is no longer present. Select its replacement.",
      );
    if (
      ![
        ...((at(pod, "spec", "containers") as ObjectMap[]) ?? []),
        ...((at(pod, "spec", "initContainers") as ObjectMap[]) ?? []),
      ].some((c) => c.name === container)
    )
      throw Error("Container is not present on the selected Pod.");
    const key = uid + ":" + container,
      existing = this.logs.get(key);
    const podPath = `/api/v1/namespaces/${encodeURIComponent(text(at(pod, "metadata", "namespace")))}/pods/${encodeURIComponent(text(at(pod, "metadata", "name")))}`;
    const current = await this.json(podPath);
    if (at(current, "metadata", "uid") !== uid) {
      this.logConnections.get(key)?.destroy();
      if (existing) {
        existing.state = "unavailable";
        existing.gaps.push(
          "Pod UID changed; replacement logs are not attached to this resource.",
        );
      }
      throw Error("Pod UID changed; select its replacement.");
    }
    const state = [
      ...((at(current, "status", "containerStatuses") as ObjectMap[]) ?? []),
      ...((at(current, "status", "initContainerStatuses") as ObjectMap[]) ??
        []),
    ].find((c) => c.name === container);
    if (
      existing?.state === "following" &&
      existing.containerId === text(state?.containerID)
    )
      return existing;
    if (!existing && this.logs.size >= 4)
      throw Error(
        "Four log subscriptions maximum. Close another stream first.",
      );
    const buffer: LogBuffer = existing ?? {
      uid,
      container,
      lines: [],
      bytes: 0,
      truncated: false,
      state: "following",
      gaps: [
        "Only the recent selected-container window is retained; earlier history may be unavailable.",
      ],
    };
    this.logConnections.get(key)?.destroy();
    if (existing) {
      buffer.gaps.push(
        "Reconnected recent log window; history may overlap or contain gaps.",
      );
      if (buffer.gaps.length > 20) buffer.gaps = buffer.gaps.slice(-20);
    }
    buffer.generation = (buffer.generation ?? 0) + 1;
    buffer.state = "following";
    buffer.containerId = text(state?.containerID);
    buffer.restartCount = Number(state?.restartCount ?? 0);
    delete buffer.error;
    this.logs.set(key, buffer);
    const path = podPath + `/log?container=${encodeURIComponent(container)}`;
    void this.readLogs(
      key,
      path + "&follow=true&tailLines=100&timestamps=true",
      buffer,
      podPath,
      buffer.containerId,
      buffer.generation,
    );
    if (buffer.restartCount > 0)
      void this.previous(path, buffer, podPath, buffer.generation);
    return buffer;
  }
  private append(b: LogBuffer, line: string) {
    b.lines.push(line.slice(0, 16384));
    b.bytes = Buffer.byteLength(b.lines.join("\n"));
    while (b.lines.length > 500 || b.bytes > 256 * 1024) {
      b.lines.shift();
      b.truncated = true;
      b.bytes = Buffer.byteLength(b.lines.join("\n"));
    }
    b.receivedAt = new Date().toISOString();
  }
  private async previous(
    path: string,
    b: LogBuffer,
    podPath: string,
    generation: number,
  ) {
    try {
      const r = await this.response(
        path + "&previous=true&tailLines=100&limitBytes=65536&timestamps=true",
      );
      let s = "";
      for await (const chunk of r) {
        s += chunk.toString();
        if (Buffer.byteLength(s) > 65536) {
          r.destroy();
          break;
        }
      }
      if (r.statusCode !== 200) throw Error("Previous logs unavailable");
      if (at(await this.json(podPath), "metadata", "uid") !== b.uid)
        throw Error("Pod identity changed");
      if (b.generation !== generation || this.stopped) return;
      b.previous = s.slice(0, 65536);
    } catch {
      if (b.generation === generation && !this.stopped)
        b.gaps = [...b.gaps, "Previous-container logs unavailable."].slice(-20);
    }
  }
  private async readLogs(
    key: string,
    path: string,
    b: LogBuffer,
    podPath: string,
    containerId: string,
    generation: number,
  ) {
    try {
      const r = await this.response(path);
      if (
        this.stopped ||
        b.generation !== generation ||
        this.logs.get(key) !== b
      ) {
        r.destroy();
        return;
      }
      this.logConnections.set(key, r);
      if (r.statusCode !== 200) throw Error(`Log HTTP ${r.statusCode}`);
      const current = await this.json(podPath);
      const statuses = [
        ...((at(current, "status", "containerStatuses") as ObjectMap[]) ?? []),
        ...((at(current, "status", "initContainerStatuses") as ObjectMap[]) ??
          []),
      ];
      if (
        at(current, "metadata", "uid") !== b.uid ||
        text(statuses.find((c) => c.name === b.container)?.containerID) !==
          containerId
      ) {
        r.destroy();
        throw Error("Pod/container identity changed while attaching logs.");
      }
      let pending = "";
      for await (const chunk of r) {
        if (b.generation !== generation || this.stopped) {
          r.destroy();
          return;
        }
        pending += chunk.toString();
        if (pending.length > 32768) {
          this.append(b, pending.slice(0, 16384));
          pending = "";
          b.truncated = true;
        }
        let nl;
        while ((nl = pending.indexOf("\n")) >= 0) {
          this.append(b, pending.slice(0, nl));
          pending = pending.slice(nl + 1);
        }
      }
      if (b.generation !== generation || this.stopped) return;
      if (pending) this.append(b, pending);
      b.state = "stopped";
      b.gaps.push(
        "Stream ended. Restart following to reconnect or select the replacement Pod.",
      );
    } catch (e) {
      if (b.generation !== generation || this.stopped) return;
      b.state = "unavailable";
      b.error = (e as Error).message;
    } finally {
      if (b.generation === generation) this.logConnections.delete(key);
    }
  }
  closeLog(uid?: string, container?: string) {
    const keys = uid ? [uid + ":" + container] : [...this.logs.keys()];
    for (const key of keys) {
      this.logConnections.get(key)?.destroy();
      this.logConnections.delete(key);
      const buffer = this.logs.get(key);
      if (buffer) buffer.generation = (buffer.generation ?? 0) + 1;
      this.logs.delete(key);
    }
  }
  stop() {
    this.stopped = true;
    for (const r of this.connections) r.destroy();
    this.connections.clear();
    this.closeLog();
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    this.agent?.destroy();
    for (const s of this.statuses) s.state = "stale";
  }
}
