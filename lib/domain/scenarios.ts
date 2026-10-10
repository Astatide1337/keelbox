import { stringify } from "yaml";
import { at, object, type ObjectMap, type ScenarioId } from "./types";
export const WEB_IMAGE =
  "nginxinc/nginx-unprivileged@sha256:4483b2e4c12fe77211e051cd0546ee79770d5174535c961b04ac918ebb75b469";
export const scenarios: Record<
  ScenarioId,
  { title: string; summary: string; objective: string; hints: string[] }
> = {
  "service-selector": {
    title: "The missing connection",
    summary: "Ready Pods. An unreachable Service. Follow the labels.",
    objective:
      "Restore web Service routing while keeping both replicas and the existing ports.",
    hints: [
      "Inspect the Service’s ready EndpointSlices. A running Pod does not prove Service routing.",
      "Compare spec.selector with the workload’s Pod template labels in the same namespace.",
      "The intended Pods have app: web. Align the Service selector, then prove HTTP routing through the Service.",
    ],
  },
  "configmap-key": {
    title: "The missing ingredient",
    summary: "A workload cannot start. Trace the required configuration.",
    objective:
      "Restore the required HEALTH_TOKEN key without removing its reference.",
    hints: [
      "Inspect Pod events for the reason the containers cannot start.",
      "Follow env.valueFrom.configMapKeyRef from the workload to its ConfigMap.",
      "Restore HEALTH_TOKEN: lesson-ready in web-config. Keep the reference required.",
    ],
  },
  "readiness-path": {
    title: "Running isn’t ready",
    summary: "The server is alive, but it never receives traffic.",
    objective:
      "Repair the readiness path without disabling or weakening the probe.",
    hints: [
      "Compare the Pod phase and Ready condition; inspect readiness events.",
      "Compare the HTTP probe path with the nginx configuration in the ConfigMap.",
      "The server serves /healthz. Keep the HTTP probe enabled on port 8080 and repair its path.",
    ],
  },
};
export function fixtureObjects(
  scenario: ScenarioId,
  namespace: string,
  fault = false,
): ObjectMap[] {
  const security = {
    runAsNonRoot: true,
    runAsUser: 101,
    allowPrivilegeEscalation: false,
    capabilities: { drop: ["ALL"] },
    seccompProfile: { type: "RuntimeDefault" },
  };
  const config: ObjectMap = {
    apiVersion: "v1",
    kind: "ConfigMap",
    metadata: { name: "web-config", namespace },
    data: {
      HEALTH_TOKEN: "lesson-ready",
      "default.conf":
        'server { listen 8080; location = / { default_type text/plain; return 200 "kubernetes-playground\\n"; } location = /healthz { return 200 "ready\\n"; } }',
    },
  };
  if (fault && scenario === "configmap-key")
    delete object(config.data).HEALTH_TOKEN;
  const deployment: ObjectMap = {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: { name: "web", namespace },
    spec: {
      replicas: 2,
      selector: { matchLabels: { app: "web" } },
      strategy: { type: "Recreate" },
      template: {
        metadata: { labels: { app: "web" } },
        spec: {
          automountServiceAccountToken: false,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 101,
            seccompProfile: { type: "RuntimeDefault" },
          },
          containers: [
            {
              name: "web",
              image: WEB_IMAGE,
              imagePullPolicy: "IfNotPresent",
              ports: [{ containerPort: 8080, name: "http" }],
              securityContext: security,
              resources: {
                requests: { cpu: "20m", memory: "32Mi" },
                limits: { cpu: "250m", memory: "128Mi" },
              },
              env: [
                {
                  name: "HEALTH_TOKEN",
                  valueFrom: {
                    configMapKeyRef: {
                      name: "web-config",
                      key: "HEALTH_TOKEN",
                    },
                  },
                },
              ],
              readinessProbe: {
                httpGet: {
                  path:
                    fault && scenario === "readiness-path"
                      ? "/not-ready"
                      : "/healthz",
                  port: 8080,
                },
                periodSeconds: 2,
                timeoutSeconds: 1,
                failureThreshold: 2,
              },
              volumeMounts: [
                {
                  name: "config",
                  mountPath: "/etc/nginx/conf.d",
                  readOnly: true,
                },
              ],
            },
          ],
          volumes: [
            {
              name: "config",
              configMap: {
                name: "web-config",
                items: [{ key: "default.conf", path: "default.conf" }],
              },
            },
          ],
        },
      },
    },
  };
  const service: ObjectMap = {
    apiVersion: "v1",
    kind: "Service",
    metadata: { name: "web", namespace },
    spec: {
      type: "ClusterIP",
      selector: {
        app: fault && scenario === "service-selector" ? "storefront" : "web",
      },
      ports: [{ name: "http", port: 80, targetPort: 8080 }],
    },
  };
  return [service, deployment, config];
}
export function fixtureSource(
  scenario: ScenarioId,
  namespace = "lab-demo",
  fault = true,
) {
  return fixtureObjects(scenario, namespace, fault)
    .map((o) => stringify(o))
    .join("---\n");
}
export function mutableValue(
  scenario: ScenarioId,
  objects: ObjectMap[],
): unknown {
  const get = (kind: string) => objects.find((o) => o.kind === kind);
  return scenario === "service-selector"
    ? at(get("Service"), "spec", "selector", "app")
    : scenario === "readiness-path"
      ? at(
          get("Deployment"),
          "spec",
          "template",
          "spec",
          "containers",
          "0",
          "readinessProbe",
          "httpGet",
          "path",
        )
      : at(get("ConfigMap"), "data", "HEALTH_TOKEN");
}
