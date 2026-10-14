# Hello: a first-party Keelbox application

This small original HTTP application demonstrates the local developer workflow.
It embeds `message.txt` in its executable, logs requests, and uses a PVC marker to
make retained development data visible. It is maintained here as a distributable
first-party example; it contains no private application or credentials.

Supported profile: native Linux amd64, local Docker Engine, kind, kubectl, and
Helm 3 for the optional Helm recipe. Docker must be running in a local Unix-socket
context. Initial startup downloads base images and a kind node image. Allow enough
memory for a Kubernetes control plane and application; two environments can exist
briefly during the scripted exercise. No Keelbox account or remote registry push
is required.

Build Keelbox using the repository Go prerequisite, then run from this directory:

```sh
# From the repository root:
go build -o /tmp/keelbox ./cmd/keelbox
cd examples/hello
/tmp/keelbox doctor
/tmp/keelbox up -d
curl --fail http://localhost:18080/
/tmp/keelbox ps
/tmp/keelbox logs api
/tmp/keelbox exec api -- cat /data/marker
```

Change `message.txt`, then run `up -d` again. The response changes after a rebuild
and rollout. An unchanged `up` reports `Reusing image: api`. The application has a
readiness probe; startup does not claim that application tests passed.

```sh
/tmp/keelbox down           # Keeps the PVC and local cluster.
/tmp/keelbox up -d
/tmp/keelbox exec api -- cat /data/marker  # Still reads "retained".
/tmp/keelbox down
/tmp/keelbox env rm --volumes  # Explicitly destroys this cluster and its data.
```

`keelbox.helm.yaml` uses Helm and localhost port 18081. Both recipes consume the
same `chart/templates/application.yaml`; the Helm chart deliberately needs no
templating. They have different configuration paths and therefore own different
clusters and PVCs. Remove each environment explicitly after using it:

```sh
/tmp/keelbox up -d --config keelbox.helm.yaml
/tmp/keelbox ps --config keelbox.helm.yaml
/tmp/keelbox down --config keelbox.helm.yaml
/tmp/keelbox env rm --volumes --config keelbox.helm.yaml
```

For an automated real-runtime exercise, from the repository root:

```sh
KEELBOX=/tmp/keelbox bash tools/integration/hello.sh
```

The script additionally requires Bash, Python 3, curl, and ordinary Linux
utilities. It copies this example into a fresh temporary directory and uses
isolated private Keelbox state. It checks HTTP responses, cache reuse, a source
edit, `ps`, logs, exec, invalid manifests, resource replacement refusal, local/mixed/prebuilt image
profiles, resource reconciliation and data retention. Retention checks write
unique nondefault sentinels and compare PVC UIDs, so a freshly recreated volume
cannot satisfy them. It destroys only its owned environments on exit with explicit volume
removal; image/build caches remain. Output identifies the temporary directory
containing the executable checksum, logs, and cleanup results. A failed cleanup
fails the journey and preserves evidence for inspection. Review these results;
unit mocks do not establish a live pass.

Offline contributor checks (`make check`, including this application's HTTP
handler test) require no Docker or Kubernetes runtime. `make fuzz` uses first-party
parser input; `make audit` needs network access. The integration script is opt-in
and is not silently run by unit tests or ordinary CI. Example container images are
built locally, never by a hosted image publishing workflow.
