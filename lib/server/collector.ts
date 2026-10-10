import { at, list, object, text, type ObjectMap } from "../domain/types";
import type { Snapshot } from "../domain/snapshot";
import { run } from "./process";
export const reads = [
  ["pods", "Pod"],
  ["deployments", "Deployment"],
  ["replicasets", "ReplicaSet"],
  ["services", "Service"],
  ["endpointslices", "EndpointSlice"],
  ["ingresses", "Ingress"],
  ["events", "Event"],
  ["configmaps", "ConfigMap"],
] as const;
function probe(input: unknown) {
  const p = object(input),
    http = object(p.httpGet);
  return Object.keys(http).length
    ? {
        httpGet: {
          path:
            typeof http.path === "string" && !/[?]/.test(http.path)
              ? http.path
              : undefined,
          port: http.port,
        },
        periodSeconds: p.periodSeconds,
        timeoutSeconds: p.timeoutSeconds,
        failureThreshold: p.failureThreshold,
        successThreshold: p.successThreshold,
      }
    : undefined;
}
function container(c: ObjectMap) {
  return {
    name: c.name,
    image: c.image,
    ports: c.ports,
    readinessProbe: probe(c.readinessProbe),
    livenessProbe: probe(c.livenessProbe),
    startupProbe: c.startupProbe ? { unsupported: true } : undefined,
    env: list(c.env)
      .filter((e) => e.valueFrom)
      .map((e) => ({
        name: e.name,
        valueFrom: {
          configMapKeyRef: at(e, "valueFrom", "configMapKeyRef"),
          secretKeyRef: at(e, "valueFrom", "secretKeyRef"),
        },
      })),
  };
}
export function projectCaptured(r: ObjectMap): ObjectMap {
  const metadata = {
    name: at(r, "metadata", "name"),
    namespace: at(r, "metadata", "namespace"),
    uid: at(r, "metadata", "uid"),
    labels: at(r, "metadata", "labels"),
    ownerReferences: list(at(r, "metadata", "ownerReferences")).map((o) => ({
      apiVersion: o.apiVersion,
      kind: o.kind,
      name: o.name,
      uid: o.uid,
      controller: o.controller,
    })),
  };
  const out: ObjectMap = { apiVersion: r.apiVersion, kind: r.kind, metadata };
  if (r.kind === "Pod") {
    out.spec = {
      containers: list(at(r, "spec", "containers")).map(container),
      volumes: list(at(r, "spec", "volumes")).map((v) => ({
        name: v.name,
        configMap: v.configMap,
        secret: v.secret,
      })),
      restartPolicy: at(r, "spec", "restartPolicy"),
    };
    out.status = {
      phase: at(r, "status", "phase"),
      conditions: list(at(r, "status", "conditions")).map((c) => ({
        type: c.type,
        status: c.status,
        reason: c.reason,
        lastTransitionTime: c.lastTransitionTime,
      })),
      containerStatuses: list(at(r, "status", "containerStatuses")).map(
        (c) => ({
          name: c.name,
          ready: c.ready,
          restartCount: c.restartCount,
          started: c.started,
          state: Object.fromEntries(
            Object.entries(object(c.state)).map(([k, v]) => [
              k,
              {
                reason: at(v, "reason"),
                exitCode: at(v, "exitCode"),
                startedAt: at(v, "startedAt"),
                finishedAt: at(v, "finishedAt"),
              },
            ]),
          ),
        }),
      ),
    };
  }
  if (r.kind === "Deployment" || r.kind === "ReplicaSet") {
    out.spec = {
      replicas: at(r, "spec", "replicas"),
      selector: at(r, "spec", "selector"),
      template: {
        metadata: { labels: at(r, "spec", "template", "metadata", "labels") },
        spec: {
          containers: list(at(r, "spec", "template", "spec", "containers")).map(
            container,
          ),
          volumes: list(at(r, "spec", "template", "spec", "volumes")).map(
            (v) => ({ name: v.name, configMap: v.configMap, secret: v.secret }),
          ),
        },
      },
    };
    out.status = {
      readyReplicas: at(r, "status", "readyReplicas"),
      availableReplicas: at(r, "status", "availableReplicas"),
      observedGeneration: at(r, "status", "observedGeneration"),
    };
  }
  if (r.kind === "Service")
    out.spec = {
      selector: at(r, "spec", "selector"),
      ports: at(r, "spec", "ports"),
      type: at(r, "spec", "type"),
    };
  if (r.kind === "EndpointSlice") {
    out.addressType = r.addressType;
    out.ports = r.ports;
    out.endpoints = list(r.endpoints).map((e) => ({
      conditions: e.conditions,
      targetRef: e.targetRef,
    }));
  }
  if (r.kind === "Ingress") out.spec = { rules: at(r, "spec", "rules") };
  if (r.kind === "ConfigMap")
    out.configurationKeys = Object.keys(object(r.data)); // values never collected
  if (r.kind === "Event") {
    out.involvedObject = r.involvedObject;
    out.reason = r.reason;
    out.type = r.type;
    out.count = r.count;
    out.firstTimestamp = r.firstTimestamp;
    out.lastTimestamp = r.lastTimestamp;
    out.eventTime = r.eventTime;
    const match = text(r.message).match(
      /^(Readiness|Liveness) probe failed: HTTP probe failed with statuscode: (\d{3})$/,
    );
    out.message = match
      ? match[0]
      : "Message omitted by collector sanitization";
  }
  return out;
}
export async function collectSnapshot(
  context: string,
  namespaces: string[],
  kubeconfig?: string,
  execute = run,
): Promise<Snapshot> {
  if (!context || context.startsWith("-"))
    throw Error("Select an explicit context.");
  if (
    !namespaces.length ||
    namespaces.some((ns) => !/^([a-z0-9]([-a-z0-9]*[a-z0-9])?)$/.test(ns))
  )
    throw Error("Select explicit valid namespaces.");
  const snapshot: Snapshot = {
    format: "playground-snapshot-v2",
    id: crypto.randomUUID(),
    label: context,
    origin: "captured",
    captureStartedAt: new Date().toISOString(),
    captureEndedAt: null,
    resources: [],
    files: [],
    coverage: [],
    errors: [],
    contracts: [],
  };
  for (const namespace of namespaces)
    for (const [plural, kind] of reads) {
      try {
        const result = object(
          JSON.parse(
            await execute("kubectl", [
              ...(kubeconfig ? ["--kubeconfig", kubeconfig] : []),
              "--context",
              context,
              "--request-timeout=15s",
              "get",
              plural,
              "-n",
              namespace,
              "-o",
              "json",
            ]),
          ),
        );
        snapshot.resources.push(
          ...list(result.items).map((r) => ({
            ...projectCaptured(r),
            capturedAt: new Date().toISOString(),
          })),
        );
        snapshot.coverage.push({
          kind,
          namespace,
          state: "captured",
          capturedAt: new Date().toISOString(),
        });
      } catch (error) {
        const message = (error as Error).message.slice(0, 500);
        snapshot.coverage.push({
          kind,
          namespace,
          state: /forbidden/i.test(message) ? "forbidden" : "failed",
          capturedAt: new Date().toISOString(),
          reason: message,
        });
        snapshot.errors.push(`${kind}/${namespace}: ${message}`);
      }
    }
  snapshot.captureEndedAt = new Date().toISOString();
  snapshot.errors.push(
    "Logs omitted by default. ConfigMap values, literal environment values and arbitrary event messages are omitted. Review identifiers and labels before sharing.",
  );
  return snapshot;
}
