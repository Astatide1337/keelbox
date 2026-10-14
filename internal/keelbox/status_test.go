package keelbox

import (
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

const readyWorkload = `{"apiVersion":"apps/v1","kind":"Deployment","metadata":{"name":"api","uid":"uid-api","generation":2,"annotations":{"keelbox.dev/environment":"test"}},"spec":{"replicas":1},"status":{"observedGeneration":2,"readyReplicas":1,"updatedReplicas":1,"availableReplicas":1}}`

func TestWorkloadReadinessObservations(t *testing.T) {
	for _, tc := range []struct {
		name, data, want string
		invalid          bool
	}{
		{"ready", readyWorkload, "ready (Kubernetes workload)", false},
		{"unavailable", strings.Replace(readyWorkload, `"readyReplicas":1`, `"readyReplicas":0`, 1), "not ready", false},
		{"stale generation", strings.Replace(readyWorkload, `"observedGeneration":2`, `"observedGeneration":1`, 1), "unknown", false},
		{"missing status", strings.Replace(readyWorkload, `"observedGeneration":2,`, ``, 1), "unknown", false},
		{"scaled down", strings.ReplaceAll(readyWorkload, `:1`, `:0`), "scaled to zero", false},
		{"unready replicas scaling down", strings.Replace(strings.ReplaceAll(readyWorkload, `:1`, `:0`), `"status":{`, `"status":{"replicas":1,`, 1), "scaling down", false},
		{"ready replicas scaling down", strings.Replace(readyWorkload, `"replicas":1`, `"replicas":0`, 1), "scaling down", false},
		{"negative total replicas", strings.Replace(readyWorkload, `"status":{`, `"status":{"replicas":-1,`, 1), "", true},
		{"wrong replica type", strings.Replace(readyWorkload, `"replicas":1`, `"replicas":"one"`, 1), "", true},
		{"missing desired", strings.Replace(readyWorkload, `"replicas":1`, ``, 1), "", true},
		{"negative replicas", strings.Replace(readyWorkload, `"readyReplicas":1`, `"readyReplicas":-1`, 1), "", true},
		{"controller failure", strings.Replace(readyWorkload, `"status":{`, `"status":{"conditions":[{"type":"Progressing","status":"False","reason":"ProgressDeadlineExceeded","message":"rollout timed out"}],`, 1), "ProgressDeadlineExceeded rollout timed out", false},
		{"stateful ready", strings.ReplaceAll(readyWorkload, "Deployment", "StatefulSet"), "ready (Kubernetes workload)", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			counts, status, err := summarizeWorkload([]byte(tc.data))
			if tc.invalid {
				if err == nil {
					t.Fatalf("invalid observation accepted: %s %s", counts, status)
				}
				return
			}
			if err != nil || !strings.Contains(status, tc.want) {
				t.Fatalf("status=%q counts=%q error=%v", status, counts, err)
			}
		})
	}
}

func statusEnvironment(t *testing.T, response, failure string) *environment {
	t.Helper()
	doctorTools(t)
	dir := t.TempDir()
	script := "#!/bin/sh\ncase \"$1 $2\" in\n'context show') printf default;;\n'context inspect') printf unix:///var/run/docker.sock;;\n'--context default') if [ \"$3\" = inspect ]; then printf cluster-id; else printf 29; fi;;\n*) exit 99;;\nesac\n"
	if err := os.WriteFile(filepath.Join(os.Getenv("PATH"), "docker"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "response.json"), []byte(response), 0600); err != nil {
		t.Fatal(err)
	}
	t.Setenv("KEELBOX_TEST_RESPONSE", filepath.Join(dir, "response.json"))
	script = "#!/bin/sh\n[ \"$1\" = --kubeconfig ] && [ \"$3\" = --context ] && [ \"$4\" = owned-context ] && [ \"$5\" = --namespace ] && [ \"$6\" = dev ] || exit 98\n" + failure + "\n/bin/cat \"$KEELBOX_TEST_RESPONSE\"\n"
	if err := os.WriteFile(filepath.Join(os.Getenv("PATH"), "kubectl"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	kubeconfig := filepath.Join(dir, "kubeconfig")
	if err := os.WriteFile(kubeconfig, []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	hash, err := fileHash(kubeconfig)
	if err != nil {
		t.Fatal(err)
	}
	return &environment{dir: dir, kubeconfig: kubeconfig, config: &projectConfig{Workloads: map[string]string{"api": "deployment/api"}}, state: environmentState{ID: "test", Cluster: "owned", Namespace: "dev", Context: "owned-context", DockerContext: "default", ContainerID: "cluster-id", KubeconfigHash: hash, Resources: []resourceRef{{Kind: "Deployment", Name: "api", UID: "uid-api"}}}}
}

func TestStatusObservationFailuresAndStartupState(t *testing.T) {
	for _, tc := range []struct {
		name, response, failure, want string
		failed                        bool
	}{
		{"ready but interrupted startup", readyWorkload, "", "ready (Kubernetes workload)", false},
		{"missing", "", "", "resource is missing", true},
		{"permission denied", "", "printf 'forbidden' >&2; exit 1", "forbidden", true},
		{"malformed", "not json", "", "observation failed", true},
		{"replacement", strings.Replace(readyWorkload, "uid-api", "replacement", 1), "", "was replaced", true},
		{"wrong identity", strings.Replace(readyWorkload, `"name":"api"`, `"name":"other"`, 1), "", "unexpected Kubernetes resource identity", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			e := statusEnvironment(t, tc.response, tc.failure)
			out, err := commandOutput(t, func() error { return e.status(t.Context()) })
			if (err != nil) != tc.failed || !strings.Contains(out, tc.want) {
				t.Fatalf("status: %s error=%v", out, err)
			}
			if !strings.Contains(out, "not recorded as complete") || !strings.Contains(out, "Application verification: not performed") || !strings.Contains(out, "unavailable: no access helper") {
				t.Fatalf("startup/access/test phases conflated: %s", out)
			}
		})
	}
}

func TestStatusRefusesUnrecordedAndUnownedResources(t *testing.T) {
	for _, recorded := range []bool{true, false} {
		e := statusEnvironment(t, strings.Replace(readyWorkload, `"keelbox.dev/environment":"test"`, `"keelbox.dev/environment":"other"`, 1), "")
		if !recorded {
			e.state.Resources = nil
		}
		out, err := commandOutput(t, func() error { return e.status(t.Context()) })
		if err == nil || strings.Contains(out, "ready (Kubernetes workload)") {
			t.Fatalf("unowned/unrecorded healthy: %s %v", out, err)
		}
	}
}

func TestAccessStatusSeparatesListenerFromApplication(t *testing.T) {
	e := &environment{dir: t.TempDir()}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if closeErr := listener.Close(); closeErr != nil {
			t.Error(closeErr)
		}
	})
	address, ok := listener.Addr().(*net.TCPAddr)
	if !ok {
		t.Fatal("expected TCP address")
	}
	cmd := unregisteredTestHelper(t, e.dir)
	e.state.Endpoint = endpointSpec{LocalPort: address.Port}
	e.state.AppliedDigest = "applied"
	helper := accessHelperState{PID: cmd.Process.Pid, Token: "test-token", Ready: true, Endpoint: e.state.Endpoint, InputDigest: "applied"}
	if err = writeJSON(helperPath(e.dir), helper); err != nil {
		t.Fatal(err)
	}
	if status := e.accessStatus(t.Context()); !strings.Contains(status, fmt.Sprint(address.Port)) || !strings.Contains(status, "application behavior not verified") {
		t.Fatal(status)
	}
	helper.InputDigest = "stale"
	if err = writeJSON(helperPath(e.dir), helper); err != nil {
		t.Fatal(err)
	}
	if status := e.accessStatus(t.Context()); !strings.Contains(status, "does not match") {
		t.Fatal(status)
	}
	if err = os.WriteFile(helperPath(e.dir), []byte("broken"), 0600); err != nil {
		t.Fatal(err)
	}
	if status := e.accessStatus(t.Context()); !strings.Contains(status, "unknown") {
		t.Fatal(status)
	}
}

func FuzzWorkloadStatus(f *testing.F) {
	f.Add([]byte(readyWorkload))
	f.Add([]byte(`{"spec":{"replicas":0}}`))
	f.Fuzz(func(t *testing.T, data []byte) {
		var value any
		if json.Unmarshal(data, &value) != nil {
			return
		}
		counts, status, err := summarizeWorkload(data)
		if err == nil && (counts == "" || status == "") {
			t.Fatal("empty accepted status")
		}
	})
}
