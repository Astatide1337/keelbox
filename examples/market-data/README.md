# Synthetic market-data freshness lab

> **Evidence status:** The bundled [Minikube proof is historical only](evidence/README.md). It predates the recovered Pod-loopback controls and does not verify this source.

This self-contained Waypoint Practice lab teaches a Kubernetes failure that a
process-health check cannot detect: the producer is still serving HTTP, but its
synthetic quote sequence has stopped advancing. The consumer keeps running,
detects the stale feed, and becomes unready.

The quote symbol is always `SYNTH-EDU`; prices are deterministic teaching data.
Nothing connects to an exchange or uses money, credentials, Secrets, persistent
storage, or external quote data. Both Deployments use the prebuilt Docker
Official Image `python:3.12.15-slim-trixie`; no image or build workflow is part
of this scenario. See the [official Python image](https://hub.docker.com/_/python).

## What communicates

| Component | Address                | Behavior                                                               |
| --------- | ---------------------- | ---------------------------------------------------------------------- |
| Producer  | `market-producer:8080` | Advances `feed_id` + `sequence` every 0.5 seconds and serves `/quote`. |
| Consumer  | `market-consumer:8081` | Polls the producer Service every 0.25 seconds and reports `/metrics`.  |

The producer's data listener serves HTTP on port 8080. Its separate control
listener binds to `127.0.0.1:8081` inside the producer Pod's network namespace;
the `market-producer` Service exposes only port 8080. A peer Pod using the
Service or producer Pod IP cannot reach the control listener. Waypoint forwards
the control port only to the exact Ready producer Pod in its owned namespace.

The consumer uses Kubernetes Service DNS, not a Pod IP. It treats a quote as
fresh only when the feed identity is valid, the sequence has advanced, and the
consumer's own monotonic clock says that the last advance was observed within
3 seconds. It does not compare producer and consumer wall clocks. A producer
restart creates a new `feed_id`, so a legitimate sequence restart is visible and
can be accepted as a new feed generation.

The automated correctness invariant is: **the consumer is ready only while it
has a valid quote whose sequence has advanced within the configured freshness
window**. A duplicate sequence does not refresh freshness; a regressing
sequence is a protocol error. `tests/test_local.py` exercises the invariant and
recovery over actual local HTTP requests.

## Probe lesson

The producer's `/livez` means its HTTP process is answering. Its `/readyz` means
it has a quote API response to serve. Those checks remain successful when the
quote is frozen: the producer is alive and can serve an old quote. The
consumer's `/livez` also stays successful while its process is answering, but
its `/readyz` fails when the feed is stale. Kubernetes can then stop routing
Service traffic to the consumer Pod without restarting the container. This
follows Kubernetes' distinction between liveness (restart decision) and
readiness (traffic eligibility); see the [Kubernetes probe
guide](https://kubernetes.io/docs/concepts/workloads/pods/probes/).

The fixture uses HTTP probes, as in Waypoint's existing local HTTP example. Its
repeatable data fault uses a bounded `POST /lab/pause` / `POST /lab/resume` on
the producer's Pod-loopback control listener. The Service-facing data listener
returns 404 for those routes. It does not use `kubectl exec`, arbitrary shell
execution, or a liveness-probe failure to fake a stale feed. Apply this fixture
only to a dedicated local or otherwise disposable cluster; do not expose its
Services publicly or use a shared/production cluster.

## Run in an owned local cluster

No cluster is created by this fixture. Before applying it, inspect
`kubectl config get-contexts` and set `LOCAL_LAB_CONTEXT` to the exact context
for your owned local lab. Use that explicit context for every command below; do
not point this lab at production. From this directory:

```sh
LOCAL_LAB_CONTEXT="your-verified-local-context"
kubectl --context "$LOCAL_LAB_CONTEXT" apply -k .
kubectl --context "$LOCAL_LAB_CONTEXT" -n waypoint-market-data rollout status deployment/market-producer
kubectl --context "$LOCAL_LAB_CONTEXT" -n waypoint-market-data rollout status deployment/market-consumer
kubectl --context "$LOCAL_LAB_CONTEXT" -n waypoint-market-data get deployments,services,pods
```

The two Services are `ClusterIP`; no ingress, load balancer, node port, or
external route is created. The pod specs disable service-account token mounts,
run non-root with a read-only root filesystem, drop Linux capabilities, and set
small CPU and memory requests/limits.

Open three terminals for local observation. The control forward targets the
exact producer Pod and binds on the local machine and inside the Pod. Each
forward stays running until stopped.
See [Kubernetes port-forwarding documentation](https://kubernetes.io/docs/tasks/access-application-cluster/port-forward-access-application-cluster/).

```sh
# Terminal A: producer data API through the Service; no control routes
kubectl --context "$LOCAL_LAB_CONTEXT" -n waypoint-market-data port-forward service/market-producer 18080:8080

# Terminal B: consumer metrics/probes. Target the Deployment so observation
# remains available when its Pod is NotReady and removed from its Service.
kubectl --context "$LOCAL_LAB_CONTEXT" -n waypoint-market-data port-forward deployment/market-consumer 18081:8081

# Terminal C: control only. Resolve the exact producer Pod, then forward its
# loopback-only listener; this port is not exposed by the Service.
PRODUCER_POD="$(kubectl --context "$LOCAL_LAB_CONTEXT" -n waypoint-market-data get pods -l app=market-producer -o jsonpath='{.items[0].metadata.name}')"
kubectl --context "$LOCAL_LAB_CONTEXT" -n waypoint-market-data port-forward --address=127.0.0.1 "pod/$PRODUCER_POD" 18082:8081
```

In a third terminal, inspect live evidence:

```sh
curl -sS http://127.0.0.1:18080/quote
curl -sS http://127.0.0.1:18081/metrics
kubectl --context "$LOCAL_LAB_CONTEXT" -n waypoint-market-data get pods -w
```

### Pause, observe, recover

Start with `market-producer` and `market-consumer` both Ready. Confirm the data
port refuses the control route, then pause the synthetic quote updates through
the separate Pod-loopback port-forward while leaving the producer serving:

```sh
curl -i -X POST http://127.0.0.1:18080/lab/pause # expect HTTP 404
curl -sS -X POST http://127.0.0.1:18082/lab/pause
```

The producer keeps returning the same `feed_id`, `sequence`, and
`generated_at_utc`. Its `/livez` and `/readyz` remain HTTP 200. Once the last
sequence advance ages past 3 seconds, consumer `/metrics` reports `fresh:false`
and `/readyz` returns HTTP 503. `kubectl get pods -w` should show the consumer
as not Ready while its restart count stays unchanged. The consumer Service's
EndpointSlice should no longer mark that Pod ready. The exact time for the Pod
condition and EndpointSlice update depends on kubelet probe scheduling and the
cluster; the client measurement helper does not claim to measure that delay.

Resume and wait for a later sequence:

```sh
curl -sS -X POST http://127.0.0.1:18082/lab/resume
curl -sS http://127.0.0.1:18081/metrics
```

The consumer should become fresh/Ready again without restarting. The producer
pause state exists only in memory; a producer restart also resumes the feed.

## CPU-only local correctness check

This check needs only Python 3 and loopback HTTP. It starts both components on
ephemeral local ports; it does not need `kubectl`, a container runtime, image
builds, or a cluster.

```sh
python3 tests/test_local.py
```

It confirms that the consumer receives a quote from the producer, that pausing
the producer leaves its health endpoints green while the consumer ages the
unchanged sequence into a stale/not-ready result, that liveness stays green,
and that advancing sequence data restores readiness. It also checks that a
sequence regression fails the correctness invariant. This local check does not
prove Kubernetes DNS, Service routing, kubelet probes, or EndpointSlice
behavior; those need a later run in an owned cluster.

## Reproducible measurement

With the producer data, producer Pod-control, and consumer port-forwards above
active, run:

```sh
python3 tools/measure_detection.py \
  --producer-url http://127.0.0.1:18080 \
  --control-url http://127.0.0.1:18082 \
  --consumer-url http://127.0.0.1:18081 \
  --trials 5 \
  --environment-note "kind version ..., node type/architecture ..., relevant limits ..."
```

The helper verifies that producer and consumer agree on a current sequence,
confirms a newer sequence, pauses the producer, and requires the consumer to
observe that frozen quote before timing until it reports stale. It records both
pause-ack-to-observation and frozen-quote-seen-to-observation samples, then
resumes the feed and requires a later sequence before the next trial. It makes
a final best-effort resume if an intermediate step fails.

The JSON report discloses the host Python/platform/architecture/CPU count,
fixture image and resource declarations, producer update interval, consumer
poll and freshness settings, helper polling interval, URLs, per-trial samples,
and min/median/max. Preserve the report without replacing measured values with
examples. For a cluster comparison, also record the Kubernetes version, node
type/architecture, resource availability, and any observed CPU throttling; use
the same image and workload settings when comparing runs.

These timings measure what the local observer sees through its HTTP path and
include the helper's polling granularity. They do **not** measure when the
kubelet changes Pod `Ready` or when the EndpointSlice controller publishes the
change. Record those separately by watching the consumer Pod and its Service
EndpointSlice, and report the two timings as distinct measurements. Do not
describe this single-replica, low-rate teaching workload as a production
benchmark.

The historical sample in
[`evidence/minikube-proof-2026-10-11.json`](evidence/minikube-proof-2026-10-11.json)
predates isolation of the producer control listener. Its five trials record
frozen-quote-seen to stale-observed time with a 3.0059s median
(2.9104–3.0092s range), and pause-acknowledgement to stale-observed time with a
3.0079s median (2.9123–3.0112s range). Those measurements belong to that earlier
implementation and environment; they do not verify the current listener
boundary or establish current-version performance.

## Reset and Waypoint integration

The helper resumes the producer after each measured trial. If a session is
interrupted, call `/lab/resume` through the producer Pod-control port-forward. For a full
lab reset, delete only this owned lab namespace and re-apply the fixture:

```sh
kubectl --context "$LOCAL_LAB_CONTEXT" delete namespace waypoint-market-data
kubectl --context "$LOCAL_LAB_CONTEXT" apply -k .
```

The fixture can also be imported directly into Waypoint Practice with
`waypoint demo market-data`. Waypoint applies its reviewed baseline in a
Waypoint-owned Minikube profile, adds typed Service/probe/image/configuration
faults, and requires the freshness, sequence, Pod readiness, and ready
EndpointSlice evidence described in
[`INTEGRATION_NOTES.md`](INTEGRATION_NOTES.md). The checked-in proof report is
historical and predates the current producer-control isolation. A new owned
cluster proof of the current listener boundary and Kubernetes recovery flow is
still pending; see [`INTEGRATION_NOTES.md`](INTEGRATION_NOTES.md).

This guide's direct `kubectl` steps remain useful for learning the fixture
manually. They are separate from Waypoint's private profile ownership and
cleanup flow.
