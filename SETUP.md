# Waypoint — local Kubernetes debugging

Waypoint serves a local web UI and deploys reviewed application copies into a dedicated, owned Minikube profile. Importing files or starting the UI does **not** create a cluster. Imported files and your normal Kubernetes context remain unchanged.

## Install the package

Use Node.js **22 or 24**. The initial lab driver supports **Linux with local Docker**. Install Docker, Minikube, kubectl and `flock` (util-linux) yourself; Waypoint does not install privileged dependencies. A lab requests 2 CPUs, 4 GiB RAM and 10 GiB disk. Keep enough additional capacity for your other clusters.

From the source checkout, build the npm artifact once:

```sh
pnpm install --frozen-lockfile
npm pack
node scripts/verify-package.mjs
```

Install that tarball into a separate directory:

```sh
mkdir waypoint-demo && cd waypoint-demo
npm install /absolute/path/waypoint-k8s-0.1.0.tgz
npx waypoint doctor
npx waypoint start
```

The installed package contains the compiled executable and production UI assets; it needs no source checkout, development dependencies or runtime build. There are no postinstall hooks. Open the one-time connect URL printed by `start` to authorize your browser to the local API, then complete Sign in with ChatGPT (or restore your own prior account authorization). Only one AI-enabled UI may own the protected credential store at a time. `PORT=3110 waypoint start` selects another loopback port.

In a source checkout, `pnpm dev` runs the development server. Use `pnpm cli` in place of `waypoint` below. `WAYPOINT_MINIKUBE_BIN=/absolute/path/minikube` can select an explicitly installed Minikube binary.

## Reproducible real demo

Keep the UI running. In another terminal with the same state-directory environment, select the bundled market-data fixture:

```sh
waypoint demo market-data
```

1. Explore **Topology**, **Resources**, **Events** and **Manifest files**. Authored YAML declares intent; it does not establish observed health.
2. Open **Practice → Review deployment**. Inspect namespace/metadata transformations, deployment YAML and cluster effects. Choose **Create local lab** explicitly.
3. Wait for a healthy baseline: intended Deployment replicas, probe/configuration checks, ready EndpointSlice targets and an HTTP request **through the Service from inside the cluster**.
4. Choose an applicable typed lesson. For stale market data, control binds only to producer Pod loopback and Waypoint forwards to the exact Ready producer Pod; the generated quote is synthetic and no Pod shell is opened. Probe, Service selector/targetPort, missing-image and ConfigMap-key faults are exact reversible changes in the Waypoint-owned namespace.
5. Compare Service traffic, Pod readiness, producer/consumer metrics, feed id and sequence. The runtime requires distinct process-liveness and feed-freshness evidence. For the stale feed, consumer `/livez` stays 200 while `/readyz` becomes 503; after the stale window, Kubernetes marks its Pod NotReady and removes the ready EndpointSlice endpoint without restarting it.
6. Apply the displayed typed repair or restore a probe path in the **lab copy**, then **Check recovery**. Market-data recovery requires a sequence later than the frozen value and a Ready consumer endpoint. Generated lesson choices select only code-validated operations; generated text is not executed.
7. Switch the header environment to **Imported source** to inspect unchanged original data. The **Local lab** environment exposes live resources in all five sections.
8. **Clean up lab** and confirm the owned cluster/data deletion, or run `waypoint lab cleanup`. Cleanup validates the private kubeconfig, driver identity, cluster UID and ownership marker before deleting the owned profile. It preserves other clusters.

The market-data example uses the prebuilt Docker Official Image `python:3.12.15-slim-trixie`; the existing generic local HTTP sample remains available for probe exercises. Liveness uses kubelet probe events plus observed restarts, and recovery includes a bounded stable-restart window.

Your normal terminal remains an unrestricted host shell. Use the explicit private `kubectl --kubeconfig … --context …` command displayed in the lab. Do not switch your default context. Closing the UI stops observation streams; it leaves the lab running so you can reconnect and inspect or clean it up.

## CLI lifecycle

```sh
waypoint help
waypoint demo market-data
waypoint lab plan /path/to/manifests
waypoint lab create
waypoint lab status
waypoint lab incident market-data-stale WAYPOINT_NAMESPACE/market-producer/producer
waypoint lab repair
waypoint lab check
waypoint lab reset
waypoint lab recover
waypoint lab cleanup
```

Mutations serialize through a kernel lock and require the current session/generation/revision. Interrupted operations expose an actual failure; `recover` retries owned preparation and restores the baseline. Identity mismatch refuses mutation and cleanup. Recovery does not adopt an unrelated profile. A never-created attempt can be abandoned only after checking that no matching container, private profile or kubeconfig exists. If ownership was not durably established for a partial cluster, Waypoint refuses automatic adoption or deletion and reports the missing receipt.

## Supported inputs and evidence

Import a selected plain YAML/JSON application directory, a Helm chart with ordered values, or a local Kustomize entry. Recursive YAML selection requires explicit `--recurse`; monorepos require an application/environment choice. Repository discovery does not deploy the entire GitOps control plane:

```sh
waypoint import /path/to/repository --list
waypoint import /path/to/repository --entry apps/my-app --values apps/my-app/values-dev.yaml
waypoint import /path/to/gitops --entry chart --values apps/production/my-app/values.yaml
```

Helm must be installed for chart imports (`WAYPOINT_HELM_BIN` can select its binary). Chart dependencies are resolved in a temporary copy; original repositories are not modified. Kustomize uses `kubectl kustomize`, including contained overlays, components, generators and replacements, with no executable plugins or embedded Helm. Remote bases must be fetched explicitly first. Select one application/environment rather than rendering every environment together. Encrypted files are not decrypted or copied as production secrets.

Helm rendering runs the installed Helm binary against explicitly selected charts and their dependencies. It uses disposable repository/registry configuration rather than your configured Helm credentials. Argo checks the initial repository's public address and disables Git redirects; Helm chart downloads, dependency URLs and redirects remain Helm-managed network requests. These inputs must be trusted: the importer is not a network isolation boundary for a malicious chart repository.

The deployment planner handles Deployments with sidecars/init containers, StatefulSets, DaemonSets, Jobs, CronJobs, standalone Pods, Services, ConfigMaps, ServiceAccounts, namespace-scoped RBAC, PVCs, Ingress and disruption-budget resources. NetworkPolicy and HPA are importable/explainable, but deployment and exercise execution are gated: the default CNI is not verified to enforce policies, and metrics/dynamic replica grading are not implemented. Source namespaces map to separate owned namespaces. Images are preserved without an image-name whitelist. Image pulls, storage/controller dependencies and runtime failures remain real prerequisites, not simulated outcomes. Host access remains prohibited. CRDs/custom controllers require explicit local provisioning; arbitrary production-cluster replay is not promised.

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

A healthy lab can request **Create an incident with ChatGPT**. Review the outgoing target and applicable fault choices before sending. Waypoint validates the proposed incident, exact workload, progressive hints, and code-defined grading checklist. The app displays the concrete operation and repair before starting it. No model-generated shell code, YAML, cluster target, or grader code runs. Actual Kubernetes evidence and deterministic recovery checks decide completion; this is not unrestricted cluster mutation.

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
WAYPOINT_E2E_CONNECT_LOG=/absolute/path/to/owned-startup.log \
WAYPOINT_E2E_CLI=/absolute/path/to/install/node_modules/.bin/waypoint \
WAYPOINT_E2E_FIXTURE=/absolute/path/to/install/node_modules/waypoint-k8s/examples/local-http \
pnpm exec playwright test tests/e2e/minikube-practice.spec.ts
```

Use `PLAYWRIGHT_CHROMIUM_PATH` if Chromium is installed outside Playwright's default cache. Historical modeled-Practice browser tests are retained under `tests/legacy-snapshot`; they are not acceptance tests for the real runtime. Auth adapter unit tests and controlled auth UI regressions do not establish new real OAuth/inference success. The previously working official integration is preserved; this runtime delivery does not automatically send cluster data to an AI endpoint.

### Reuse a local Docker image

Public images in manifests can be pulled directly by the lab. For private or already-cached images, pull the image yourself with Docker, then choose **Use a local Docker image** in the deployment review and enter its existing local tag. Waypoint reads image identity metadata, loads the image into its owned profile, and shows the mapping and `imagePullPolicy: Never` in the review. It does not read or copy Docker registry credentials, change your Docker context, or build images. A changed or missing local image requires another review. Reset reloads the reviewed image from Docker; keep that image available until the lab is cleaned up.

## Capability matrix and evidence boundaries

The deployment review publishes separate **importable**, **explainable**, **deployable**, **observable**, and **exercise eligible** statuses. A successful render is not proof of successful deployment. API connection freshness is not Kubernetes health. HTTP checks cover each supported contract and explicitly exclude other ports/protocols/external dependencies.

| Input / behavior                                                        | Import and explanation                                                                                             | Local execution / practice                                                                             |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| Selected YAML/JSON app, typed Lists                                     | Supported with 2 MB / 100-file bounds and skipped-file diagnostics                                                 | Supported resource subset; explicit prerequisites                                                      |
| Deployment, Service, ConfigMap                                          | UID ownership, selectors, EndpointSlices and configuration references                                              | Real healthy/readiness/liveness workflows for eligible HTTP/TCP contracts                              |
| Init/env/envFrom/direct/projected references                            | Shared dependency walker; optional references and sanitized Secret key metadata                                    | Missing required resource/item keys block apply; user supplies local test values                       |
| StatefulSet, DaemonSet, Pod, Job, CronJob, PVC                          | Generic configuration plus observed state                                                                          | Resource-specific checks; CronJob awaiting execution is distinguished from success; PVC state persists |
| Namespace / RBAC                                                        | Safe labels, known namespace references and DNS transformations reviewed                                           | Explicit owned namespaces; unrelated subjects and unsupported references diagnosed                     |
| Helm                                                                    | Temporary copies; versions, release/namespace, Kubernetes/API options, ordered values/hashes/lockfiles/source maps | Rendered resources still pass normal planner; hooks/CRDs refused early                                 |
| Kustomize                                                               | Contained overlays/components/generators/replacements                                                              | Remote inputs, plugins and embedded Helm refused; explicit pre-rendered output is an alternative       |
| Pinned public Argo sources                                              | `--resolve-argo`; single and ordered multi-source, external values, exact pins and precedence                      | Desired resource import only; source destination is never contacted; no reconciliation controller      |
| NetworkPolicy                                                           | Imported and explained                                                                                             | Blocked without demonstrated enforcing CNI; provisioning needs separate approval                       |
| HPA                                                                     | Imported and explained                                                                                             | Blocked until metrics, observation and dynamic-replica grading are supported                           |
| Cloud LoadBalancer, GPUs, custom CRDs/operators, private images/storage | Requirements and missing dependencies reported                                                                     | No silent substitutions; explicit reviewed configuration/provisioning required                         |
| Captured snapshots                                                      | Historical observations, capture times and unavailable access                                                      | Analysis only until authored manifests and local test configuration exist                              |

`waypoint import REPO --entry CHART --namespace demo --kube-version VERSION --api-version GROUP/VERSION/KIND --values FIRST --values LAST` records renderer options and ordered values. `waypoint import APPLICATION.yaml --resolve-argo` requires pinned public sources; private authentication is not borrowed. Helm precedence is value files → inline values → valuesObject → parameters; later multi-source resources override earlier resources with the same identity. Unknown namespace-sensitive semantics remain diagnostics and are not promised compatible.

Use the **Application capabilities** and **Runtime requirements** review before Create. Review every transformation. For unsupported policies, operators or substitutions, prepare an explicit test-only fixture and import it separately; do not obtain production credentials to make it run.

## Inspection, editing and learning

Resource namespace/kind/name, ownership UID, conditions, reasons, provenance and age are available in the graph/tree/table/inspector. Generated objects do not receive invented authored files. Normalized desired/live differences exclude API bookkeeping/status while retaining defaulted configuration. Exact relationship selection and YAML evidence are inspectable.

Manifest files keeps the editor available even when a draft removes its last resource. Analysis edits remain drafts. Save commits a browser-local analysis checkpoint; it does not apply to Kubernetes or replace the original import. Revert restores the last saved draft. **Export source** exports immutable originals; **Export draft** exports edited analysis without claiming captured observations. Recent projects retain separate drafts in the project menu. Browser storage is account-scoped and bounded by browser quota; export important drafts before clearing browser data.

Practice notebooks are optional, so expert exploration remains available. Open the notebook to record a hypothesis, prediction and interpretation, request progressive hints, or explicitly reveal a solution. Verification opens a before/after debrief and teach-back. Notes/drafts/questions are scoped to the account, project, lab and generation. Reset begins a fresh generation and preserves earlier scoped storage; it does not claim restored application data. Resource/filter/tab/pane navigation is URL-restorable.

CronJob schedules are not assumed to have executed. Review the **Run once** action, or inspect `waypoint lab status`, then use `waypoint lab run-cronjob NAMESPACE/NAME --confirm`. This creates one Job from the reviewed template in the owned cluster and can write application data. Reset does not rerun that Job or clear PVCs.

The checked-in corpus lives in `tests/corpus`, with supported/refused expectations and actual Helm/Kustomize rendering checks. It is representative evidence, not a claim that most repositories work. See `docs/audit/checklist.md` and its linked results for current PASS/FAIL/NOT RUN scope. Legacy modeled tests do not establish live runtime success.

The MIT license applies to source/package. The CI workflow prepares Node 22/24 checks and artifact verification without image builds or publication. External CI, npm publication, pushes and fresh authorization grants require separate permission.
