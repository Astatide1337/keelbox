# Waypoint — local Kubernetes debugging

Waypoint serves a local web UI and deploys reviewed application copies into a dedicated, owned Minikube profile. Importing files or starting the UI does **not** create a cluster. Imported files and your normal Kubernetes context remain unchanged.

## Install the package

Use Node.js **22 or 24**. The initial lab driver supports **Linux with local Docker**. Install Docker, Minikube, kubectl and `flock` (util-linux) yourself; Waypoint does not install privileged dependencies. A lab requests 2 CPUs, 4 GiB RAM and 10 GiB disk. Keep enough additional capacity for your other clusters.

From the source checkout, build the npm artifact once:

```sh
pnpm install --frozen-lockfile
pnpm package:build
npm pack
```

Install that tarball into a separate directory:

```sh
mkdir waypoint-demo && cd waypoint-demo
npm install /absolute/path/kubernetes-learning-playground-0.1.0.tgz
npx waypoint doctor
npx waypoint start
```

The installed package contains the compiled executable and production UI assets; it needs no source checkout, development dependencies or runtime build. There are no postinstall hooks. Open the one-time connect URL printed by `start` to authorize your browser to the local API. `PORT=3110 npx waypoint start` selects another loopback port.

In a source checkout, `pnpm dev` runs the development server. Use `pnpm cli` in place of `npx waypoint` below. `WAYPOINT_MINIKUBE_BIN=/absolute/path/minikube` can select an explicitly installed Minikube binary.

## Reproducible real demo

Keep the UI running. In another terminal with the same state-directory environment:

```sh
npx waypoint import node_modules/kubernetes-learning-playground/examples/local-http
```

1. Explore **Topology**, **Resources**, **Events** and **Manifest files**. Authored YAML declares intent; it does not establish observed health.
2. Open **Practice → Review deployment**. Inspect namespace/metadata transformations, deployment YAML and cluster effects. Choose **Create local lab** explicitly.
3. Wait for a healthy baseline: intended Deployment replicas, probe/configuration checks, ready EndpointSlice targets and an HTTP request **through the Service from inside the cluster**.
4. Start the readiness investigation. Inspect the actual Pod conditions, kubelet Events, nginx request logs and YAML. Hints are available on request.
5. Repair the wrong readiness path in the **lab copy**, keeping required probes, configuration and replicas. Apply, then **Check recovery**. Malformed YAML stays in the editor; unsafe shortcuts fail validation.
6. **Reset baseline** proves healthy state again. Repeat the exercise, or choose a liveness incident or review a ChatGPT-generated investigation.
7. Switch the header environment to **Imported source** to inspect unchanged original data. The **Local lab** environment exposes live resources in all five sections.
8. **Clean up lab**, or run `npx waypoint lab cleanup`. Cleanup validates the private kubeconfig, driver identity, cluster UID and ownership marker before deleting the owned profile. It preserves other clusters.

The example uses prebuilt `nginx:1.28-alpine` and `busybox:1.37` images. The old fixture-specific HTTP 503 exercise has been removed. Liveness uses kubelet probe events plus observed restarts, and recovery includes a bounded stable-restart window.

Your normal terminal remains an unrestricted host shell. Use the explicit private `kubectl --kubeconfig … --context …` command displayed in the lab. Do not switch your default context. Closing the UI stops observation streams; it leaves the lab running so you can reconnect and inspect or clean it up.

## CLI lifecycle

```sh
npx waypoint help
npx waypoint lab plan /path/to/manifests
npx waypoint lab create
npx waypoint lab status
npx waypoint lab incident readiness
npx waypoint lab apply /path/to/repaired-lab.yaml
npx waypoint lab check
npx waypoint lab reset
npx waypoint lab recover
npx waypoint lab cleanup
```

Mutations serialize through a kernel lock and require the current session/generation/revision. Interrupted operations expose an actual failure; `recover` retries owned preparation and restores the baseline. Identity mismatch refuses mutation and cleanup. Recovery does not adopt an unrelated profile. A never-created attempt can be abandoned only after checking that no matching container, private profile or kubeconfig exists. If ownership was not durably established for a partial cluster, Waypoint refuses automatic adoption or deletion and reports the missing receipt.

## Supported inputs and evidence

Import plain YAML folders recursively, a selected Helm chart with values, or a local Kustomize entry. Repository discovery does not deploy the entire GitOps control plane:

```sh
npx waypoint import /path/to/repository --list
npx waypoint import /path/to/repository --entry apps/my-app --values apps/my-app/values-dev.yaml
npx waypoint import /path/to/gitops --entry chart --values apps/production/my-app/values.yaml
```

Helm must be installed for chart imports (`WAYPOINT_HELM_BIN` can select its binary). Chart dependencies are resolved in a temporary copy; original repositories are not modified. Kustomize uses `kubectl kustomize`, with local reference containment checks and no executable plugins. Remote bases must be fetched explicitly first. Select one application/environment rather than rendering every environment together. Encrypted files are not decrypted or copied as production secrets.

The deployment planner handles Deployments with sidecars/init containers, StatefulSets, DaemonSets, Jobs, CronJobs, standalone Pods, Services, ConfigMaps, ServiceAccounts, namespace-scoped RBAC, PVCs, NetworkPolicies, Ingress, autoscaling and disruption-budget resources. Source namespaces map to separate owned namespaces. Images are preserved without an image-name whitelist. Image pulls, storage/controller dependencies and runtime failures remain real prerequisites, not simulated outcomes. Host access remains prohibited. CRDs/custom controllers require explicit local provisioning; arbitrary production-cluster replay is not promised.

OpenShift Routes can be translated into local nginx Ingress; TLS passthrough needs separate configuration. Review every transformation and addon effect before creating a lab. Generated Pods/ReplicaSets/EndpointSlices are observed rather than redeployed as controller duplicates. Probe incidents require an eligible HTTP readiness probe, selecting Service and nonzero replicas; other workloads can be inspected without claiming probe compatibility.

Use **Secrets / Vault** to supply local test values. Imported Secret payloads are stripped; only reference names/key names enter project files and exports. Test values are stored in owner-only account configuration files and applied only to the owned cluster. Updating configuration requires a new deployment review. CSI secret-provider file mounts can explicitly use supplied local test Secrets; this is a substitution, not verification of the source provider.

Vault Agent-injected KV v2 dependencies can use a disposable local HashiCorp Vault development server and injector, with user-defined paths, roles and test values. Configuring Vault creates a protected local test credential. The reviewed lab installs the official chart, scopes Kubernetes authentication to its application namespaces and reseeds test data on reset. Source Vault servers are not contacted. Production unsealing, dynamic database credentials, arbitrary Vault authentication methods and external Vault access are not reproduced automatically.

A local developer cluster is **not a security sandbox for hostile workloads**. Use trusted application manifests. Waypoint does not build images.

Live resources and Kubernetes Events use bounded LIST/WATCH caches keyed by UID. Reconnects track resourceVersion and relist expired history. Stale/disconnected or denied evidence is visible and cannot pass a recovery check. Logs follow selected Pod/container identities only (four subscriptions maximum, 500 lines/256 KiB per recent buffer). Replacement Pods require selection of their new UID. Restarted containers can reconnect and show previous-container logs where Kubernetes provides them. Gaps/truncation are explicit; there is no durable complete log history.

The source collector remains read-only:

```sh
npx waypoint collect --context YOUR_CONTEXT --namespaces YOUR_NAMESPACE --out /tmp/snapshot.json --kubeconfig /path/to/explicit/kubeconfig
```

It imports a point-in-time snapshot with capture time and partial-access errors. It excludes Secrets/logs and ConfigMap values. Snapshots remain analysis-only until supported authored manifests and local configuration are provided; they are not silently replayed or replaced by an example.

## Accounts and AI

ChatGPT sign-in is required. Run `waypoint start`, open its one-time connect link, then choose **Sign in with ChatGPT**. `--dev` is rejected; there is no anonymous development account. Subscription inference requires an eligible plan and authorized scopes. The CLI and browser share the active account, with protected credentials and project storage kept on this computer.

A healthy lab can request **Create an incident with ChatGPT**. Review the outgoing probe/Service summary before sending. Waypoint validates the proposed target, progressive hints and typed grading checklist. No model-generated shell code or grader code runs. Actual Kubernetes evidence and deterministic recovery checks decide completion. Currently generated incidents use the supported readiness/liveness fault primitives; this is not unrestricted cluster mutation.

The existing question flow previews sanitized, selected source evidence before sending it to OpenAI. Local hosting does not make inference local. Raw logs, ConfigMap values and Secret values are excluded. AI explains evidence; deterministic Kubernetes checks decide recovery. Select a lab resource and use its **Ask ChatGPT** action to review a bounded, sanitized observation snapshot. Answers are tied to that resource UID and lab revision; running operations, stale caches, resets and replaced Pods require a new review.

## Verification

```sh
pnpm typecheck
pnpm test
```

The real Playwright journey is explicit opt-in because it creates and cleans an owned cluster. Start the installed package with an isolated `PLAYGROUND_STATE_DIR` and a legitimately signed-in account, then run:

```sh
WAYPOINT_REAL_LAB=1 \
PLAYGROUND_STATE_DIR=/absolute/path/to/test-state \
PLAYGROUND_E2E_ORIGIN=http://127.0.0.1:3120 \
WAYPOINT_E2E_CLI=/absolute/path/to/install/node_modules/.bin/waypoint \
WAYPOINT_E2E_FIXTURE=/absolute/path/to/install/node_modules/kubernetes-learning-playground/examples/local-http \
pnpm exec playwright test tests/e2e/minikube-practice.spec.ts
```

Use `PLAYWRIGHT_CHROMIUM_PATH` if Chromium is installed outside Playwright's default cache. Historical modeled-Practice browser tests are retained under `tests/legacy-snapshot`; they are not acceptance tests for the real runtime. Auth adapter unit tests and controlled auth UI regressions do not establish new real OAuth/inference success. The previously working official integration is preserved; this runtime delivery does not automatically send cluster data to an AI endpoint.

### Reuse a local Docker image

Public images in manifests can be pulled directly by the lab. For private or already-cached images, pull the image yourself with Docker, then choose **Use a local Docker image** in the deployment review and enter its existing local tag. Waypoint reads image identity metadata, loads the image into its owned profile, and shows the mapping and `imagePullPolicy: Never` in the review. It does not read or copy Docker registry credentials, change your Docker context, or build images. A changed or missing local image requires another review. Reset reloads the reviewed image from Docker; keep that image available until the lab is cleaned up.
