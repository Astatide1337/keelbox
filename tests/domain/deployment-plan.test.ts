import { test } from "node:test";
import assert from "node:assert/strict";
import { readManifestInputs } from "../../lib/server/project-store";
import {
  deploymentPlan,
  validateLabRepair,
} from "../../lib/domain/deployment-plan";
import { at, list, object } from "../../lib/domain/types";
import { stringify } from "yaml";
const ns = "waypoint-lab-0123456789ab";
test("deployment plan preserves originals, rewrites owned namespaces, exposes contracts and rejects replica/probe shortcuts", async () => {
  const project = await readManifestInputs(["examples/local-http"]),
    before = JSON.stringify(project);
  const plan = deploymentPlan(project, ns);
  assert.deepEqual(plan.blockers, []);
  assert.equal(plan.contract?.service, "web");
  assert.equal(plan.contract?.gateway, undefined);
  assert.equal(JSON.stringify(project), before);
  assert(plan.resources.every((r) => at(r, "metadata", "namespace") === ns));
  assert.equal(validateLabRepair(plan, plan.source).length, 6);
  for (const shortcut of ["zero", "probe", "delete"]) {
    const bad = structuredClone(plan.resources);
    const dep = bad.find((r) => r.kind === "Deployment")!;
    if (shortcut === "zero") object(dep.spec).replicas = 0;
    if (shortcut === "probe")
      delete list(at(dep, "spec", "template", "spec", "containers"))[0]
        .readinessProbe;
    if (shortcut === "delete") bad.splice(bad.indexOf(dep), 1);
    assert.throws(() =>
      validateLabRepair(plan, bad.map((r) => stringify(r)).join("---\n")),
    );
  }
  const altered = structuredClone(plan.resources);
  object(
    at(
      altered.find((r) => r.kind === "Deployment"),
      "spec",
      "template",
      "spec",
      "containers",
      "0",
      "readinessProbe",
      "httpGet",
    ),
  ).path = "/still-wrong";
  const repaired = altered.map((r) => stringify(r)).join("---\n");
  const actual = validateLabRepair(plan, repaired);
  assert.equal(
    at(
      actual.find((r) => r.kind === "Deployment"),
      "spec",
      "template",
      "spec",
      "containers",
      "0",
      "readinessProbe",
      "httpGet",
      "path",
    ),
    "/still-wrong",
    "validator must not silently fix an incorrect draft",
  );
  assert.throws(() => validateLabRepair(plan, "a: [broken"), /Line/);
});
test("captured, privileged, secret and unsupported applications fail compatibility without substitution", async () => {
  const source = await readManifestInputs(["examples/local-http"]);
  const copy = structuredClone(source);
  copy.origin = "captured";
  assert(
    deploymentPlan(copy, ns).blockers.some((b) =>
      b.includes("Captured snapshots"),
    ),
  );
  const bad = structuredClone(source);
  bad.files[0].content = bad.files[0].content.replace(
    "image: nginx:1.28-alpine",
    "image: private.registry/internal:secret\n          securityContext: {privileged: true}",
  );
  const plan = deploymentPlan(bad, ns);
  assert(!plan.blockers.some((b) => b.includes("image")));
  assert(plan.blockers.some((b) => b.includes("dangerous")));
  const secret = structuredClone(source);
  secret.files[0].content +=
    "\n---\napiVersion: v1\nkind: Secret\nmetadata: {name: missing, namespace: demo}\n";
  assert(
    deploymentPlan(secret, ns).blockers.some((b) =>
      b.includes("Secret/missing"),
    ),
  );
});
test("dropping Linux capabilities is allowed; adding host capabilities is blocked", async () => {
  const source = await readManifestInputs(["examples/local-http"]);
  const reduced = structuredClone(source);
  reduced.files[0].content = reduced.files[0].content.replace(
    "image: nginx:1.28-alpine",
    "image: nginx:1.28-alpine\n          securityContext: {allowPrivilegeEscalation: false, capabilities: {drop: [ALL]}}",
  );
  assert.deepEqual(deploymentPlan(reduced, ns).blockers, []);
  const escalated = structuredClone(source);
  escalated.files[0].content = escalated.files[0].content.replace(
    "image: nginx:1.28-alpine",
    "image: nginx:1.28-alpine\n          securityContext: {capabilities: {add: [SYS_ADMIN]}}",
  );
  assert(
    deploymentPlan(escalated, ns).blockers.some((b) => b.includes("dangerous")),
  );
});

test("application image names and commands are preserved without a fixture whitelist", async () => {
  const source = structuredClone(
    await readManifestInputs(["examples/local-http"]),
  );
  source.files[0].content = source.files[0].content.replaceAll(
    "image: nginx:1.28-alpine",
    "image: ghcr.io/example-team/custom-application@sha256:" + "a".repeat(64),
  );
  const plan = deploymentPlan(source, ns);
  assert.deepEqual(plan.blockers, []);
  assert.equal(
    at(
      plan.resources.find((r) => r.kind === "Deployment"),
      "spec",
      "template",
      "spec",
      "containers",
      "0",
      "image",
    ),
    "ghcr.io/example-team/custom-application@sha256:" + "a".repeat(64),
  );
});

test("probe repairs are scoped to the selected Deployment and container", async () => {
  const project = await readManifestInputs(["examples/local-http"]);
  const plan = deploymentPlan(project, ns);
  const selected = plan.resources.find(
    (r) =>
      r.kind === "Deployment" &&
      at(r, "metadata", "name") === plan.contract!.deployment,
  )!;
  const other = structuredClone(selected);
  object(other.metadata).name = "another-workload";
  plan.resources.push(other);
  const sidecar = structuredClone(
    list(at(selected, "spec", "template", "spec", "containers"))[0],
  );
  sidecar.name = "sidecar";
  object(at(selected, "spec", "template", "spec")).containers = [
    ...list(at(selected, "spec", "template", "spec", "containers")),
    sidecar,
  ];
  const serialize = (rs: typeof plan.resources) =>
    rs.map((r) => stringify(r)).join("---\n");
  const changed = structuredClone(plan.resources);
  const target = changed.find(
    (r) => at(r, "metadata", "name") === plan.contract!.deployment,
  )!;
  object(
    at(
      list(at(target, "spec", "template", "spec", "containers"))[0],
      "readinessProbe",
      "httpGet",
    ),
  ).path = "/repair";
  assert.doesNotThrow(() => validateLabRepair(plan, serialize(changed)));
  object(
    at(
      list(at(target, "spec", "template", "spec", "containers"))[1],
      "readinessProbe",
      "httpGet",
    ),
  ).path = "/wrong-sidecar";
  assert.throws(
    () => validateLabRepair(plan, serialize(changed)),
    /Only HTTP probe paths/,
  );
  const wrong = structuredClone(plan.resources);
  object(
    at(
      list(
        at(
          wrong.find((r) => at(r, "metadata", "name") === "another-workload"),
          "spec",
          "template",
          "spec",
          "containers",
        ),
      )[0],
      "readinessProbe",
      "httpGet",
    ),
  ).path = "/wrong-workload";
  assert.throws(
    () => validateLabRepair(plan, serialize(wrong)),
    /Only HTTP probe paths/,
  );
});

test("local Docker mapping is explicit, immutable, and never pulls from the registry", async () => {
  const project = await readManifestInputs(["examples/local-http"]);
  const original = JSON.stringify(project);
  const imageId = "sha256:" + "a".repeat(64);
  const plan = deploymentPlan(project, ns, {
    revision: "local-image-test",
    secrets: [],
    images: [
      {
        original: "nginx:1.28-alpine",
        reference: "nginx:1.28-alpine",
        imageId,
      },
    ],
  });
  assert.equal(JSON.stringify(project), original);
  assert.equal(plan.localImages[0].imageId, imageId);
  assert(plan.changes.some((c) => c.includes("pull policy Never")));
  for (const workload of plan.resources.filter((r) => r.kind === "Deployment"))
    assert.equal(
      at(
        workload,
        "spec",
        "template",
        "spec",
        "containers",
        "0",
        "imagePullPolicy",
      ),
      "Never",
    );
});

test("a metrics Service cannot hide the application Service practice contract", async () => {
  const project = structuredClone(
    await readManifestInputs(["examples/local-http"]),
  );
  project.files[0].content =
    "apiVersion: v1\nkind: Service\nmetadata: {name: metrics, namespace: demo}\nspec:\n  selector: {app: web}\n  ports: [{port: 9090, targetPort: 9090}]\n---\n" +
    project.files[0].content;
  const plan = deploymentPlan(project, ns);
  assert(
    plan.contracts.some((c) => c.deployment === "web" && c.service === "web"),
  );
});
test("owned lab plan uses cache-first pull policy and leaves imported YAML unchanged", async () => {
  const project = await readManifestInputs(["examples/local-http"]);
  const original = JSON.stringify(project);
  const plan = deploymentPlan(project, ns);
  const deployments = plan.resources.filter((r) => r.kind === "Deployment");
  assert(deployments.length > 0);
  for (const dep of deployments) {
    for (const container of list(
      at(dep, "spec", "template", "spec", "containers"),
    ))
      assert.equal(container.imagePullPolicy, "IfNotPresent");
  }
  assert.equal(JSON.stringify(project), original);
  assert(plan.changes.some((c) => c.includes("prefer a cached/local image")));
});
