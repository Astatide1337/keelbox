# Waypoint

Waypoint teaches Kubernetes through inspected manifests, live cluster evidence, and guided recovery in a dedicated local Minikube profile. Importing a project or starting the UI does not create a cluster. The source project and ambient Kubernetes context remain unchanged.

## Install and start

Use Node.js 22 or 24 on Linux. From the prepared local tarball:

```sh
npm install --global ./waypoint-k8s-0.1.0.tgz
waypoint doctor
waypoint start
```

Open the loopback connection link from the CLI and sign in to enable account-backed ChatGPT explanations and lesson generation. The runtime and deterministic incident checks do not depend on generated commands. Docker with a local Unix socket, Minikube, kubectl, `flock`, at least 2 CPUs, 4 GiB RAM, and 10 GiB disk are required for an owned lab. `waypoint doctor` reports the actual local prerequisites. Starting Waypoint does not create a cluster.

## Run the synthetic market-data lesson

With Waypoint running and signed in, select the bundled fixture:

```sh
waypoint demo market-data
```

Open **Practice**, review the deployment plan and effects, and choose **Create local lab**. The fixture runs an official prebuilt Python image in two Deployments. `market-producer` serves synthetic quotes through the `market-producer` Service; `market-consumer` polls that Service and exposes sequence and freshness metrics. Producer control binds only to `127.0.0.1:8081` inside its Pod; the Service exposes only the quote/probe listener. Waypoint forwards control only to the exact Ready producer Pod in the owned namespace. It uses no real quote source, trading, credentials, Secrets, or persistent storage. No image is built.

Choose **Stale synthetic market data** to pause the producer through its typed, loopback-forwarded lab endpoint. The lesson records that the producer `/livez` and `/readyz` stay HTTP 200 while its `feed_id` and `sequence` stop advancing. After the freshness window, the consumer reports stale data, `/livez` remains HTTP 200, `/readyz` returns HTTP 503, its Pod becomes NotReady, and its ready EndpointSlice entry is removed without a restart. **Resume synthetic feed** restores sequence progress; **Check recovery** requires a later sequence and the consumer Pod and EndpointSlice to return to Ready.

The selected workload also offers applicable readiness/liveness probe, Service selector, Service targetPort, missing-image, and missing-ConfigMap-key lessons. Waypoint displays each exact fault and repair before starting it. Image and config faults use only a synthetic missing value in the lab copy. ChatGPT may select among the choices validated for the selected workload; Waypoint supplies all mutations, repair, and checks. Generated text cannot provide shell commands, YAML patches, or cluster targets.

## Other applications

Import a trusted app or a selected repository entry, then inspect the topology, events, resources, and authored YAML:

```sh
waypoint import /path/to/application
waypoint import /path/to/repository --list
waypoint import /path/to/repository --entry apps/web/overlays/demo
```

Review the namespace transformation and capability report before creating a lab. `waypoint lab status` prints the explicit private kubeconfig/context for terminal inspection. Reset reapplies only the reviewed baseline; cleanup validates ownership before deleting the owned profile. Waypoint never targets a shared or production cluster as part of this guided scenario.

## CPU-only fixture checks and measurement

The quote producer and consumer can be checked over local HTTP without Kubernetes or a container runtime:

```sh
python3 "$(npm root -g)/waypoint-k8s/examples/market-data/tests/test_local.py"
```

Or run the fixture check from a source checkout:

```sh
python3 examples/market-data/tests/test_local.py
```

For a repeatable local-observer measurement, forward the producer data Service, the producer Pod-loopback control listener, and the consumer through the explicit private kubeconfig shown by `waypoint lab status`, then use:

```sh
python3 examples/market-data/tools/measure_detection.py \
  --producer-url http://127.0.0.1:18080 \
  --control-url http://127.0.0.1:18082 \
  --consumer-url http://127.0.0.1:18081 \
  --trials 5 \
  --environment-note "Kubernetes version, node type/architecture, available resources, and limits"
```

The helper emits raw per-trial timings and min/median/max along with the image, workload settings, host, architecture, and polling interval. These measure client-observed quote freshness through HTTP; they do not claim kubelet or EndpointSlice propagation latency. Do not insert example values in place of an actual run.

## Build and verify the tarball

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
npm pack
node scripts/verify-package.mjs
```

The artifact includes the synthetic fixture, compiled CLI/UI, and bundled dependency notices. Installation has no lifecycle hooks. The automated CI workflow does not create clusters or build container images. This work has not been published to npm.

See [SETUP.md](SETUP.md) for supported import boundaries, account details, and deeper verification guidance. Licensed under MIT; see [LICENSE](LICENSE).
