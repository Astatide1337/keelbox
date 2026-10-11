import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applicableIncidents,
  incidentOperation,
  isSyntheticMarketData,
} from "../../lib/domain/live-incidents";
import { recipeEvidence, validateRecipe } from "../../lib/domain/generated-incident";
import type {
  DeploymentPlan,
  HttpContract,
} from "../../lib/domain/deployment-plan";

type TestResource = {
  kind: string;
  metadata: { name: string; labels?: Record<string, unknown> };
  spec?: any;
};

const namespace = "waypoint-lab-0123456789ab";
const producer: HttpContract = {
  deployment: "market-producer",
  container: "producer",
  service: "market-producer",
  port: 8080,
  path: "/readyz",
  probePort: "http",
  livenessPath: "/livez",
};
const consumer: HttpContract = {
  deployment: "market-consumer",
  container: "consumer",
  service: "market-consumer",
  port: 8081,
  path: "/readyz",
  probePort: "http",
  livenessPath: "/livez",
};
test("incident summary preserves exact structural targets and expanded faults", () => {
  const summary = recipeEvidence(plan()).context;
  const target = summary.targets.find((entry) => entry.deployment === "market-producer")!;
  assert.equal(target.target, `${namespace}/market-producer/producer`);
  assert.ok(target.target.length > 40);
  assert.deepEqual(target.incidents.map((entry) => entry.id), [
    "readiness", "liveness", "service-selector", "service-target-port",
    "image-pull", "configmap-key", "market-data-stale",
  ]);
  const unsafe = structuredClone(plan());
  unsafe.namespace = "a".repeat(48);
  for (const contract of unsafe.contracts!) contract.namespace = unsafe.namespace;
  for (const resource of unsafe.resources)
    (resource.metadata as { namespace: string }).namespace = unsafe.namespace;
  assert.equal(recipeEvidence(unsafe).context.targets[0].target, "[redacted]");
});
function deployment(
  name: string,
  containerName: string,
  port: number,
  env: unknown[] = [],
) {
  return {
    apiVersion: "apps/v1",
    kind: "Deployment",
    metadata: {
      name,
      namespace,
      labels: { "app.kubernetes.io/part-of": "waypoint-market-data-lab" },
    },
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: containerName,
              image: "python:3.12.15-slim-trixie",
              env,
              ports: [{ name: "http", containerPort: port }],
              readinessProbe: { httpGet: { path: "/readyz", port: "http" } },
              livenessProbe: { httpGet: { path: "/livez", port: "http" } },
            },
          ],
        },
      },
    },
  };
}
function plan(): DeploymentPlan {
  return {
    namespace,
    contract: producer,
    contracts: [producer, consumer],
    resources: [
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "market-producer", namespace },
        spec: {
          selector: { app: "market-producer" },
          ports: [{ port: 8080, targetPort: "http" }],
        },
      },
      {
        apiVersion: "v1",
        kind: "Service",
        metadata: { name: "market-consumer", namespace },
        spec: {
          selector: { app: "market-consumer" },
          ports: [{ port: 8081, targetPort: "http" }],
        },
      },
      deployment("market-producer", "producer", 8080, [
        {
          name: "QUOTE_SYMBOL",
          valueFrom: {
            configMapKeyRef: {
              name: "market-producer-settings",
              key: "symbol",
            },
          },
        },
      ]),
      deployment("market-consumer", "consumer", 8081, [
        { name: "PRODUCER_URL", value: "http://market-producer:8080/quote" },
      ]),
      {
        apiVersion: "v1",
        kind: "ConfigMap",
        metadata: { name: "market-producer-settings", namespace },
        data: { symbol: "SYNTH-EDU" },
      },
    ],
    source: "",
  } as unknown as DeploymentPlan;
}

test("market-data availability is exact to the reviewed producer and its required endpoints", () => {
  const reviewed = plan();
  assert.equal(isSyntheticMarketData(reviewed), true);
  const producerChoices = applicableIncidents(
    reviewed,
    `${namespace}/market-producer/producer`,
  );
  assert.deepEqual(
    producerChoices.map((choice) => choice.id),
    [
      "readiness",
      "liveness",
      "service-selector",
      "service-target-port",
      "image-pull",
      "configmap-key",
      "market-data-stale",
    ],
  );
  assert(
    !applicableIncidents(
      reviewed,
      `${namespace}/market-consumer/consumer`,
    ).some((choice) => choice.id === "market-data-stale"),
  );
  const markerRemoved = structuredClone(reviewed);
  const marker = (markerRemoved.resources as unknown as TestResource[]).find(
    (r) => r.kind === "Deployment" && r.metadata.name === "market-producer",
  )!;
  delete marker.metadata.labels;
  assert.equal(isSyntheticMarketData(markerRemoved), false);
  assert.throws(
    () =>
      incidentOperation(
        markerRemoved,
        "market-data-stale",
        `${namespace}/market-producer/producer`,
        "12345678",
      ),
    /not applicable/,
  );
});

test("typed faults change one reviewed field and keep a resettable baseline", () => {
  const reviewed = plan(),
    target = `${namespace}/market-producer/producer`;
  const selector = incidentOperation(
    reviewed,
    "service-selector",
    target,
    "lab-uid",
  ) as unknown as TestResource[];
  assert.deepEqual(
    selector.find(
      (r) => r.kind === "Service" && r.metadata.name === "market-producer",
    )?.spec?.selector,
    {
      app: "market-producer",
      "waypoint.dev/no-match": "lab-uid",
    },
  );
  const targetPort = incidentOperation(
    reviewed,
    "service-target-port",
    target,
    "12345678",
  ) as unknown as TestResource[];
  assert.equal(
    targetPort.find(
      (r) => r.kind === "Service" && r.metadata.name === "market-producer",
    )?.spec?.ports?.[0]?.targetPort,
    1,
  );
  const image = incidentOperation(
    reviewed,
    "image-pull",
    target,
    "12345678",
  ) as unknown as TestResource[];
  const imageContainer = image.find(
    (r) => r.kind === "Deployment" && r.metadata.name === "market-producer",
  )?.spec?.template?.spec?.containers?.[0];
  assert.match(String(imageContainer?.image), /^python:waypoint-missing-/);
  assert.equal(imageContainer?.imagePullPolicy, "Never");
  const config = incidentOperation(
    reviewed,
    "configmap-key",
    target,
    "12345678",
  ) as unknown as TestResource[];
  assert.equal(
    config.find(
      (r) => r.kind === "Deployment" && r.metadata.name === "market-producer",
    )?.spec?.template?.spec?.containers?.[0]?.env?.[0]?.valueFrom
      ?.configMapKeyRef?.key,
    "symbol-waypoint-missing",
  );
  const probe = incidentOperation(
    reviewed,
    "readiness",
    target,
    "12345678",
  ) as unknown as TestResource[];
  const probeContainer = probe.find(
    (r) => r.kind === "Deployment" && r.metadata.name === "market-producer",
  )?.spec?.template?.spec?.containers?.[0];
  assert.equal(
    probeContainer?.readinessProbe?.httpGet?.path,
    "/waypoint-missing-12345678",
  );
  assert.equal(probeContainer?.livenessProbe?.httpGet?.path, "/livez");
  assert.notEqual(probe, reviewed.resources);
  assert.equal(
    (
      reviewed.resources.find(
        (r) => r.kind === "Service",
      ) as unknown as TestResource
    ).spec?.ports?.[0]?.targetPort,
    "http",
  );
});

test("generated proposals cannot select a scenario outside the validated target choices", () => {
  const reviewed = plan(),
    target = `${namespace}/market-producer/producer`;
  const recipe = {
    title: "Stale quote sequence",
    symptom: "The process is answering but the sequence is not moving.",
    objective: "Find why the consumer stops receiving fresh data.",
    incident: "market-data-stale",
    target,
    hints: [
      "Inspect the sequence value.",
      "Compare producer and consumer freshness.",
      "Restore updates and check the later sequence.",
    ],
    grader: [
      "baseline-configuration",
      "replicas-ready",
      "ready-backends",
      "service-http",
      "producer-live",
      "feed-sequence-advances",
      "consumer-freshness",
      "consumer-ready-endpoint",
    ],
  };
  assert.equal(validateRecipe(recipe, reviewed).incident, "market-data-stale");
  assert.throws(
    () =>
      validateRecipe(
        {
          ...recipe,
          incident: "market-data-stale",
          target: `${namespace}/market-consumer/consumer`,
        },
        reviewed,
      ),
    /not applicable/,
  );
  assert.throws(
    () =>
      validateRecipe(
        {
          ...recipe,
          grader: [
            "baseline-configuration",
            "replicas-ready",
            "ready-backends",
            "service-http",
          ],
        },
        reviewed,
      ),
    /exact code-defined/,
  );
});
