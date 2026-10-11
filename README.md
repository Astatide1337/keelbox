# Waypoint

Inspect Kubernetes manifests and investigate real readiness and liveness failures in a dedicated local Minikube application. Source clusters and imported files remain unchanged.

## Start

Use Node 22 or 24 on Linux. Install the prepared npm tarball (the package is not yet published):

```sh
npm install -g ./kubernetes-learning-playground-0.1.0.tgz
waypoint start
```

Open the one-time local connection link printed by the CLI and complete **Sign in with ChatGPT** in your browser. Waypoint stores its own owner-only OAuth credentials locally. AI inference goes to OpenAI after you review the selected evidence. No other application's credentials are used. Quotas and account eligibility apply.

Docker with a local Unix socket, Minikube, kubectl, at least 2 CPUs, 4 GiB free RAM, and 10 GiB disk are required to create a lab. Installing or starting the UI does not create a cluster. Run `waypoint doctor` for actual prerequisite results. Helm is needed for Helm imports and the optional local Vault fixture.

```sh
waypoint import /path/to/application
waypoint import /path/to/repo --list
waypoint import /path/to/repo --entry apps/web/overlays/demo
waypoint import /path/to/chart --values values-demo.yaml --namespace demo
```

Use Topology, Resources, Events and Manifest files to explore. Practice reviews a namespace transformation and capability diagnostics before **Create local lab**. Establish the baseline, choose readiness or liveness, inspect actual evidence, record a hypothesis, edit the lab YAML, **Apply repair**, and **Check recovery**. Requested hints and solutions are separate from normal exploration. The deterministic runtime checks award completion; ChatGPT explains evidence.

`waypoint lab status` prints the explicit private kubeconfig/context command for your terminal. Never replace it with your ambient work-cluster context. Reset reapplies the baseline; it does not recreate Jobs or erase PVC data. Cleanup validates ownership before removing only the owned profile.

## Supported boundaries

This release supports a documented application subset and reports separate import, explanation, deployment, observation and exercise capabilities. It does not claim most repositories work. See [capability details](SETUP.md).

- Plain YAML/JSON and typed Lists; explicit monorepo app/environment selection.
- Temporary-copy Helm and contained Kustomize overlays/components/generators/replacements.
- Explicit pinned public Argo source resolution with provenance; no GitOps reconciliation.
- Namespace-scoped common resources and local test-only Secret/registry/Vault configuration.
- HTTP readiness/liveness exercises require an eligible Deployment/container plus TCP Service. Verification checks ready EndpointSlices and an HTTP request **through the Service from inside the cluster**.
- NetworkPolicy execution is gated without a verified enforcing CNI. HPA execution is gated until metrics and dynamic-replica checks exist. Hooks, CRDs/operators, remote Kustomize plugins and hostile/host-access workloads are refused.
- Public prebuilt images can be pulled. Existing local Docker images can be explicitly mapped and loaded. Waypoint does not build images automatically.

Snapshots are captured history, not live connections. Live cache freshness is distinct from resource health. Logs are bounded and selected per Pod/container; missing permissions, stream gaps and truncation remain visible. Logs, Secret values, ConfigMap values and raw event messages are excluded from AI context.

## Contribute / verify

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
npm pack
pnpm package:verify
```

`npm pack` builds the compiled CLI and production Next assets before creating the archive. Installation has no postinstall hooks or machine changes. Live browser tests require explicit owned-runtime opt-in and official browser consent; unit tests do not substitute for that proof.

Licensed under MIT; see [LICENSE](LICENSE). No npm publication, cloud hosting, enterprise Argo parity, or production-cluster mutation is part of this release.
