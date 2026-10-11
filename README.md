# Waypoint

A local Kubernetes debugging and learning tool. Explore manifests, inspect live resources, and practice repairs in a dedicated Waypoint-owned Minikube cluster.

## Run

Use Node.js 22 or 24 on Linux. Labs need Docker, Minikube, kubectl, `flock`, 2 CPUs, 4 GiB RAM, and 10 GiB free disk. Helm imports also need Helm.

Install a locally built package:

```sh
npm install --global ./waypoint-k8s-0.1.0.tgz
waypoint doctor
waypoint start
```

Open the **full one-time connection URL** printed by the CLI (`http://127.0.0.1:3000/?connect=…`), then sign in with ChatGPT. Keep the terminal running. Opening `localhost:3000` alone does not authorize your browser. ChatGPT explanations require an eligible account; reviewed AI requests go to OpenAI.

Starting the UI does not create a cluster. Your imported files, normal Kubernetes context, and other clusters remain unchanged.

## Import and explore

```sh
waypoint import /path/to/application
waypoint import /path/to/repository --list
waypoint import /path/to/repository --entry apps/web/overlays/demo
```

Use **Topology**, **Resources**, **Events**, and **Manifest files** to inspect the selected application. YAML/JSON, local Helm charts, and contained Kustomize overlays are supported. Select one app/environment in a monorepo. Captured snapshots are historical observations, not live connections.

## Practice

1. Open **Practice**, review the deployment changes, and create the local lab.
2. Establish a healthy baseline, then choose an eligible incident.
3. Investigate actual resources, events, and logs. Request hints when needed.
4. Edit the lab YAML, **Apply repair**, and **Check recovery**.
5. Reset to the reviewed baseline or clean up the owned cluster.

Incidents cover probes, Service selectors/ports, missing images/configuration, and the bundled stale-feed lesson when compatible. ChatGPT can propose only validated fault choices; deterministic Kubernetes checks decide success.

Use **Secrets / Vault** for local test configuration. Original Secret values are not copied. Reset preserves existing Jobs and PVC data; cleanup deletes the owned cluster and its data. `waypoint lab status` shows the explicit private kubeconfig/context for terminal work.

NetworkPolicy/HPA execution, Helm hooks, custom operators, and remote Kustomize/plugins have explicit limits or gates. Imports report unsupported dependencies before deployment. Use trusted workloads; a local cluster is not isolation for hostile code. Waypoint uses prebuilt or explicitly mapped local images and does not build images automatically.

### Synthetic quote demo

```sh
waypoint demo market-data
```

The producer serves synthetic quotes; the consumer becomes unready when the sequence stops advancing. Pausing the feed leaves the producer alive while the consumer detects stale data. Recovery requires advancing quotes, consumer readiness, and ready endpoints. No real market connection or credentials are used.

The fixture's local HTTP tests and measurement helper live in `examples/market-data/tests/test_local.py` and `examples/market-data/tools/measure_detection.py`. The helper reports client-observed detection timing, not kubelet or EndpointSlice propagation latency.

## Develop and package

```sh
pnpm install --frozen-lockfile
pnpm dev
# In another terminal:
pnpm cli import /path/to/application
```

```sh
pnpm typecheck
pnpm test
npm pack
pnpm package:verify
```

`npm pack` builds the compiled CLI and production UI. Installation needs no checkout, development dependencies, or runtime build, and has no install hooks. Run `waypoint help` for all commands.

MIT licensed. See [LICENSE](LICENSE) and [dependency notices](THIRD_PARTY_NOTICES.md).
