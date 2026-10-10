# Waypoint local demo

Use Node.js 22+ and pnpm 11. From this directory:

```sh
pnpm install --frozen-lockfile
pnpm dev
```

Open the one-time localhost connect URL printed by the CLI to authorize the local API and checkpoints. This is not ChatGPT authentication. Development mode disables AI inference and OAuth credential storage. Core practice needs no Docker, kind, Minikube, cluster connection, or login.

## Demo

Explore Topology, Resources, Events, and Manifest files. The initial Storefront project is explicitly bundled reference data, not a Minikube capture. Select a Service and follow relationship evidence into YAML. Controller-generated resources expose captured API objects, not invented original files.

Open Practice → readiness investigation. Inspect Pod conditions, synthetic Unhealthy events, logs and owner/workload YAML. Hints are available on request. Repair the readiness HTTP path using the healthy endpoint in the ConfigMap, then Check repair. Invalid YAML remains in the editor with a stale graph. Removing probes, deleting resources or scaling to zero cannot pass.

A passing result explains the modeled outcome. Restart reinjects the incident. Returning to exploration shows the unchanged source. Liveness has distinct restart/Killing evidence. The 503 exercise models an explicit gateway fallback caused by a backend Service selector mismatch; it does not claim every empty Service returns 503.

## Import and optional capture

Import multi-document/multiple YAML files or snapshot JSON. Helm/Kustomize rendering is not implemented; import rendered YAML. YAML-only imports establish declarations and inferred relationships, not observed health.

Optional collection needs kubectl and existing explicit access:

```sh
pnpm cli collect --context YOUR_CONTEXT --namespaces YOUR_NAMESPACE --out /tmp/waypoint-snapshot.json --kubeconfig /path/to/dedicated-kubeconfig
```

The allowlisted collector is read-only, does not change default context, excludes Secrets/logs and ConfigMap values, and records timestamps and partial-access errors. Review exported identifiers/labels before sharing. A snapshot is not live. Collection was tested with controlled command responses, not your actual cluster. The sibling ../minikube directory remains unprovisioned.

Practice requires supported single-container Deployment topology, captured owned ReplicaSet/Pods and ready EndpointSlice targets, configuration and an explicitly known healthy HTTP endpoint contract. Unsupported or incomplete imports show reasons; the bundled fallback is an explicit choice and leaves your exploration project intact. The bundled gateway contract describes modeled behavior, not runtime-tested nginx proxy behavior.

## Recovery and checks

Checkpoints use owner-only atomic files under ~/.local/state/kubernetes-learning-playground/exercises/. Reload the exercise URL to recover. Failed/disconnected storage retains drafts in memory and reports that saving is unavailable. This is exercise/source data, not OAuth credentials.

Keep the CLI dev server running for browser tests:

```sh
pnpm typecheck
pnpm test
pnpm build
pnpm exec playwright install chromium
pnpm test:e2e
```

On another machine, set PLAYWRIGHT_CHROMIUM_PATH to its installed Chromium/headless-shell executable; the current config defaults to this workspace executable. Browser tests use the app's own local API session, never ChatGPT. Screenshots: /tmp/waypoint-v3-evidence/. Report: playwright-report/index.html.

## Remaining boundaries

Practice verifies deterministic modeled behavior, not live traffic, reconciliation or cluster health. Optional owned-kind runtime code is retained separately; the complete current optional lab UI/demo path is unverified. Actual Argo integration, Helm/Kustomize rendering and general Kubernetes simulation are outside this delivery. Official ChatGPT adapter code remains gated; OAuth credential storage and real subscription-backed inference await authorization. No source cluster mutation, container image build, commit, push or merge was performed.
