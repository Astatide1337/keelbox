# Waypoint lesson contract and verification status

The fixture is available from Waypoint Practice after `waypoint demo market-data`. The package contains the Kustomize inputs, Python source, CPU-only HTTP checks, and the measured-detection helper. The repository also has an owned-lab proof helper at `scripts/prove-market-data-live.ts`; that helper is not included in the npm package. The scenario uses synthetic quotes, prebuilt official Python images, and no market-data credentials, Secrets, persistent storage, or image builds.

## Guided operation contract

- Waypoint recognizes the fixture only when the producer and consumer Deployments, Services, probes, producer URL, and fixture marker match the reviewed contract.
- Fault choices are typed and applicability checked for the current plan and target. The model can select only a listed incident ID and exact workload string.
- Probe-path, Service selector, targetPort, image, and ConfigMap key incidents change one known lab-copy field. The image lesson uses an unavailable tag from the same public image repository and `imagePullPolicy: Never`.
- The producer quote/probe listener serves port 8080 and returns 404 for `/lab/pause` and `/lab/resume`. Controls use a separate listener bound to `127.0.0.1:8081` in the producer Pod network namespace; the Service maps only port 8080. Waypoint resolves the exact Ready producer Pod through its Deployment and ReplicaSet owner UIDs, then opens a short-lived host-loopback port-forward to that Pod's fixed control port. It does not run a shell or `kubectl exec` in either workload. Reset, repair, and recovery resume the in-memory producer first. Cleanup deletes the verified owned profile directly, so it does not depend on the paused producer responding.
- Generated title, symptoms, and hints are display text. The operation and deterministic grade come from application code. Model output cannot include commands, YAML, targets outside the selected plan, or executable grader logic.
- Stale-feed recovery requires a higher sequence for the same feed ID, consumer freshness, a Ready consumer Pod, and a ready EndpointSlice backend.

## Correctness invariant

The invariant is: **the consumer is Ready only while it has a valid quote whose sequence has advanced within the configured freshness window**. A stale-feed fault freezes quotes while the producer process remains live and API-ready. The consumer `/livez` should remain 200 while `/readyz` changes to 503; kubelet readiness then removes it from ready Service endpoints without a liveness restart. Recovery requires observing a later producer sequence and the consumer's return to Ready.

The CPU-only `tests/test_local.py` exercises producer-to-consumer HTTP communication, duplicate and regressed sequences, stale readiness, recovery, loopback binding of the control listener, and rejection of control requests on the data listener. Those checks cannot establish Pod-IP reachability, Service DNS, kubelet timing, Pod conditions, or EndpointSlice propagation.

## Cluster evidence status

The checked-in [historical Minikube proof](evidence/minikube-proof-2026-10-11.json) predates isolation of the producer control listener. It does not verify the current Pod-loopback boundary or prove peer-Pod isolation.

This source-recovery run did not invoke Kubernetes or Minikube commands and did not create or test a cluster. Current Pod port-forward behavior, peer-Pod isolation, kubelet readiness transitions, and EndpointSlice propagation remain unverified here. The opt-in live proof script contains checks for an authorized future run; its presence is not evidence that those checks ran.

When cluster proof is authorized, preserve raw trial output and disclose the image digest, cluster and Kubernetes versions, node type/architecture, CPU and memory availability, resource requests/limits, update/poll/freshness settings, observer interval, and CPU throttling if measured. The measurement helper records client-observed freshness timings and per-trial samples; it does not measure kubelet Pod-Ready or EndpointSlice latency. Record those transitions separately from actual Pod and EndpointSlice observations. Do not substitute example values or describe this single-replica teaching workload as a production benchmark.
## Package and local checks

The recovered source uses package metadata for waypoint-k8s@0.1.0. The prior tarball is preserved as a binary input, but this recovery does not claim that its source is identical to the recovered code. A fresh archive built from this source with npm pack and Next.js Webpack is recorded by the repository-only scan report at [market-data-package-scan.json](../../docs/audit/evidence/market-data-package-scan.json). That report includes the exact archive SHA-256, file counts, scan scope, and verifier status. The archive is a local verification artifact; it was not published.

The restored source passed the TypeScript check under Node 22.23.3, the unit suite (114 passed, 2 optional environment-dependent tests skipped), and all four CPU-only fixture HTTP tests under Python 3.14. The HTTP tests use only ephemeral loopback listeners.

No Kubernetes or Minikube commands were run for this source recovery. A current signed-in browser journey, external CI, and npm publication remain outside the evidence collected here.
