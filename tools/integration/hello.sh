#!/usr/bin/env bash
set -euo pipefail

# Opt-in real runtime exercise. Never reads an ambient Kubernetes context.
repo=$(cd "$(dirname "$0")/../.." && pwd)
keelbox=${KEELBOX:?Set KEELBOX to the absolute path of a built Keelbox executable}
case "$keelbox" in /*) ;; *) printf 'KEELBOX must be absolute\n' >&2; exit 1;; esac
for prerequisite in docker kind kubectl helm curl python3; do
  command -v "$prerequisite" >/dev/null || { printf 'Missing prerequisite: %s\n' "$prerequisite" >&2; exit 1; }
done
journey=$(mktemp -d "${TMPDIR:-/tmp}/keelbox-hello.XXXXXX")
cp -R "$repo/examples/hello" "$journey/app"
export XDG_STATE_HOME="$journey/state"
cd "$journey/app"
printf 'Evidence and private state: %s\n' "$journey"
configs=()
cleanup() {
  result=$?
  trap - EXIT
  set +e
  for config in "${configs[@]}"; do
    "$keelbox" env rm --volumes --config "$config" > "$journey/cleanup-$config.log" 2>&1
    cleanup_result=$?
    # A configuration never started has no owned cluster to destroy.
    if [[ $cleanup_result != 0 ]] && ! grep -q 'owned cluster has not been created' "$journey/cleanup-$config.log"; then
      printf 'Cleanup needs inspection: %s/cleanup-%s.log\n' "$journey" "$config" >&2
      result=1
    fi
  done
  printf 'Journey result: %s; retained logs at %s\n' "$result" "$journey"
  exit "$result"
}
trap cleanup EXIT
exec > >(tee "$journey/journey.log") 2>&1
sha256sum "$keelbox"
"$keelbox" doctor
configs+=(keelbox.yaml)
"$keelbox" up -d | tee "$journey/first-up.log"
[[ $(curl --fail --silent http://localhost:18080/) == 'Hello from Keelbox!' ]]
"$keelbox" ps
"$keelbox" logs api
"$keelbox" exec api -- cat /data/marker | grep -qx retained
"$keelbox" up -d | tee "$journey/unchanged-up.log"
grep -q 'Reusing image' "$journey/unchanged-up.log"
printf 'Hello after a source change!\n' > message.txt
"$keelbox" up -d | tee "$journey/changed-up.log"
[[ $(curl --fail --silent http://localhost:18080/) == 'Hello after a source change!' ]]
# Add, change and remove an owned resource through ordinary up reconciliation.
cat > extra.yaml <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: temporary
 data: {}
YAML
python3 - <<'PY'
p='keelbox.yaml'
s=open(p).read().replace('  - chart/templates/application.yaml','  - chart/templates/application.yaml\n  - extra.yaml')
open(p,'w').write(s)
PY
if "$keelbox" up -d > "$journey/malformed-up.log" 2>&1; then
  printf 'Malformed manifest unexpectedly accepted\n' >&2; exit 1
fi
cat > extra.yaml <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: temporary
data:
  value: first
YAML
"$keelbox" up -d
# Locate only this recipe's private state; Kubernetes commands remain explicit.
state=$(find "$XDG_STATE_HOME/keelbox" -name state.json -type f)
readarray -t identity < <(python3 - "$state" <<'PY'
import json,sys
s=json.load(open(sys.argv[1]));print(s['Context']);print(s['Namespace'])
PY
)
kubeconfig="$(dirname "$state")/kubeconfig"
kube=(kubectl --kubeconfig "$kubeconfig" --context "${identity[0]}" --namespace "${identity[1]}")
[[ $("${kube[@]}" get configmap temporary -o jsonpath='{.data.value}') == first ]]
sed -i 's/value: first/value: second/' extra.yaml
"$keelbox" up -d
[[ $("${kube[@]}" get configmap temporary -o jsonpath='{.data.value}') == second ]]
sed -i '/  - extra.yaml/d' keelbox.yaml
"$keelbox" up -d
[[ -z $("${kube[@]}" get configmap temporary --ignore-not-found -o name) ]]
# Exercise retained StatefulSet PVCs through the same reconciliation path.
cat > stateful.yaml <<'YAML'
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: worker
spec:
  replicas: 1
  serviceName: hello
  selector:
    matchLabels: {app: worker}
  template:
    metadata:
      labels: {app: worker}
    spec:
      containers:
        - name: worker
          image: busybox:1.37.0
          command: [sh, -c, 'test -f /data/marker || echo worker-retained > /data/marker; exec sleep 86400']
          volumeMounts:
            - {name: data, mountPath: /data}
  volumeClaimTemplates:
    - metadata: {name: data}
      spec:
        accessModes: [ReadWriteOnce]
        resources:
          requests: {storage: 64Mi}
YAML
sed -i '/  - chart\/templates\/application.yaml/a\  - stateful.yaml' keelbox.yaml
"$keelbox" up -d
"${kube[@]}" rollout status statefulset/worker --timeout=120s
worker_sentinel="worker-$RANDOM-$RANDOM"
"${kube[@]}" exec worker-0 -- sh -c 'printf "%s\n" "$1" > /data/marker' marker "$worker_sentinel"
worker_pvc_uid=$("${kube[@]}" get pvc data-worker-0 -o jsonpath='{.metadata.uid}')
"${kube[@]}" exec worker-0 -- cat /data/marker | grep -Fxq "$worker_sentinel"
sed -i '/  - stateful.yaml/d' keelbox.yaml
"$keelbox" up -d
[[ $("${kube[@]}" get statefulset worker -o jsonpath='{.spec.replicas}') == 0 ]]
"${kube[@]}" get pvc data-worker-0
sed -i '/  - chart\/templates\/application.yaml/a\  - stateful.yaml' keelbox.yaml
"$keelbox" up -d
"${kube[@]}" rollout status statefulset/worker --timeout=120s
"${kube[@]}" exec worker-0 -- cat /data/marker | grep -Fxq "$worker_sentinel"
[[ $("${kube[@]}" get pvc data-worker-0 -o jsonpath='{.metadata.uid}') == "$worker_pvc_uid" ]]
sed -i '/  - stateful.yaml/d' keelbox.yaml
"$keelbox" up -d
# A same-name resource replacement must never be adopted or pruned.
sed -i '/  - chart\/templates\/application.yaml/a\  - extra.yaml' keelbox.yaml
"$keelbox" up -d
uid=$("${kube[@]}" get configmap temporary -o jsonpath='{.metadata.uid}')
printf '{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"%s"}}\n' "$uid" > delete-options.json
"${kube[@]}" delete --raw "/api/v1/namespaces/${identity[1]}/configmaps/temporary" -f delete-options.json
"${kube[@]}" create -f extra.yaml
replacement=$("${kube[@]}" get configmap temporary -o jsonpath='{.metadata.uid}')
[[ $replacement != "$uid" ]]
sed -i '/  - extra.yaml/d' keelbox.yaml
if "$keelbox" up -d > "$journey/replaced-up.log" 2>&1; then
  printf 'Replacement was unexpectedly adopted/deleted\n' >&2; exit 1
fi
grep -q 'was replaced' "$journey/replaced-up.log"
[[ $("${kube[@]}" get configmap temporary -o jsonpath='{.metadata.uid}') == "$replacement" ]]
printf '{"apiVersion":"v1","kind":"DeleteOptions","preconditions":{"uid":"%s"}}\n' "$replacement" > delete-options.json
"${kube[@]}" delete --raw "/api/v1/namespaces/${identity[1]}/configmaps/temporary" -f delete-options.json
"$keelbox" up -d

sentinel="retained-$RANDOM-$RANDOM"
"$keelbox" exec api -- sh -c 'printf "%s\n" "$1" > /data/marker' marker "$sentinel"
pvc_uid=$("${kube[@]}" get pvc hello-data -o jsonpath='{.metadata.uid}')
"$keelbox" down
"${kube[@]}" get pvc hello-data
"$keelbox" up -d
"$keelbox" exec api -- cat /data/marker | grep -Fxq "$sentinel"
[[ $("${kube[@]}" get pvc hello-data -o jsonpath='{.metadata.uid}') == "$pvc_uid" ]]
# Mix a local build with a prebuilt sidecar, then run without any builds.
cp chart/templates/application.yaml application.original
cp keelbox.yaml keelbox.original
python3 - <<'PY'
p='chart/templates/application.yaml'
s=open(p).read().replace('              memory: 64Mi','              memory: 64Mi\n        - name: sidecar\n          image: busybox:1.37.0\n          imagePullPolicy: IfNotPresent\n          command: [sleep, "86400"]')
open(p,'w').write(s)
PY
"$keelbox" up -d
[[ $(curl --fail --silent http://localhost:18080/) == 'Hello after a source change!' ]]
[[ $("${kube[@]}" get deployment hello -o jsonpath='{.spec.template.spec.containers[1].image}') == busybox:1.37.0 ]]
[[ $("${kube[@]}" get deployment hello -o jsonpath='{.spec.template.spec.containers[1].imagePullPolicy}') == IfNotPresent ]]
python3 - <<'PY'
p='keelbox.yaml';s=open(p).read();a=s.index('build:');b=s.index('workloads:',a);open(p,'w').write(s[:a]+s[b:])
p='chart/templates/application.yaml';s=open(p).read().replace('image: keelbox-example/api:development','image: busybox:1.37.0').replace('test -f /data/marker || echo retained > /data/marker; exec /hello','mkdir -p /tmp/www; echo prebuilt > /tmp/www/index.html; exec httpd -f -p 8080 -h /tmp/www');open(p,'w').write(s)
PY
"$keelbox" up -d
[[ $(curl --fail --silent http://localhost:18080/) == prebuilt ]]
[[ $("${kube[@]}" get deployment hello -o jsonpath='{.spec.template.spec.containers[0].image}') == busybox:1.37.0 ]]
cp application.original chart/templates/application.yaml
cp keelbox.original keelbox.yaml
"$keelbox" up -d

"$keelbox" down
configs+=(keelbox.helm.yaml)
"$keelbox" up -d --config keelbox.helm.yaml
[[ $(curl --fail --silent http://localhost:18081/) == 'Hello after a source change!' ]]
"$keelbox" ps --config keelbox.helm.yaml
"$keelbox" down --config keelbox.helm.yaml
printf 'PASS: plain/Helm, local/mixed/prebuilt images, access, cache, source update, logs, exec, reconciliation, replacement refusal, failure, retained data.\n'
