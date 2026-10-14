package keelbox

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func reconciliationEnvironment(t *testing.T, refs []resourceRef) *environment {
	t.Helper()
	dir := t.TempDir()
	script := `#!/bin/sh
shift 6
case "$1" in
get) if test -f "$KB_FIXTURE/$3.json"; then /bin/cat "$KB_FIXTURE/$3.json"; fi ;;
delete)
 name=${3##*/}
 if test "$name" = "$KB_FAIL"; then printf 'injected failure' >&2; exit 1; fi
 /bin/cat "$5" >> "$KB_FIXTURE/deletions"
 /bin/rm -f "$KB_FIXTURE/$name.json"
 ;;
patch) printf '%s\n' "$*" >> "$KB_FIXTURE/patches" ;;
*) exit 99 ;;
esac
`
	if err := os.WriteFile(filepath.Join(dir, "kubectl"), []byte(script), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	t.Setenv("KB_FIXTURE", dir)
	t.Setenv("KB_FAIL", "")
	e := &environment{dir: dir, kubeconfig: filepath.Join(dir, "kubeconfig"), state: environmentState{ID: "owned", Namespace: "dev", Context: "kind-owned", Resources: refs}}
	for _, r := range refs {
		writeReconciliationObject(t, e, r, "owned", r.UID)
	}
	return e
}

func writeReconciliationObject(t *testing.T, e *environment, r resourceRef, owner, uid string) {
	t.Helper()
	o := object{"apiVersion": r.APIVersion, "kind": r.Kind, "metadata": map[string]any{"name": r.Name, "uid": uid, "annotations": map[string]any{"keelbox.dev/environment": owner}}, "spec": map[string]any{}, "status": map[string]any{"replicas": 0}}
	if err := writeJSON(filepath.Join(e.dir, r.Name+".json"), o); err != nil {
		t.Fatal(err)
	}
}

func TestReconcileAdditionsAndModificationsKeepExistingResources(t *testing.T) {
	r := resourceRef{APIVersion: "v1", Kind: "ConfigMap", Name: "existing", UID: "uid"}
	e := reconciliationEnvironment(t, []resourceRef{r})
	desired := []object{{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": "existing"}, "data": map[string]any{"changed": "value"}}, {"apiVersion": "v1", "kind": "Service", "metadata": map[string]any{"name": "added"}}}
	if err := e.reconcileResources(t.Context(), desired); err != nil {
		t.Fatal(err)
	}
	if len(e.state.Resources) != 1 {
		t.Fatal("desired resource was removed")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "deletions")); !os.IsNotExist(err) {
		t.Fatalf("unexpected deletion: %v", err)
	}
}

func TestReconcileRemovesOnlyObsoleteWithUIDPreconditions(t *testing.T) {
	refs := []resourceRef{{APIVersion: "v1", Kind: "ConfigMap", Name: "obsolete", UID: "uid-obsolete"}, {APIVersion: "v1", Kind: "Service", Name: "keep", UID: "uid-keep"}}
	e := reconciliationEnvironment(t, refs)
	desired := []object{{"apiVersion": "v1", "kind": "Service", "metadata": map[string]any{"name": "keep"}}}
	if err := e.reconcileResources(t.Context(), desired); err != nil {
		t.Fatal(err)
	}
	if len(e.state.Resources) != 1 || e.state.Resources[0] != refs[1] {
		t.Fatalf("wrong inventory: %#v", e.state.Resources)
	}
	data, err := os.ReadFile(filepath.Join(e.dir, "deletions"))
	if err != nil {
		t.Fatal(err)
	}
	var options struct {
		Preconditions struct {
			UID string `json:"uid"`
		} `json:"preconditions"`
	}
	if err = json.Unmarshal(data, &options); err != nil {
		t.Fatal(err)
	}
	if options.Preconditions.UID != "uid-obsolete" {
		t.Fatal("deletion did not require recorded UID")
	}
}

func TestReconcileRefusesUnownedAndReplacedBeforeAnyRemoval(t *testing.T) {
	for _, tc := range []struct{ name, owner, uid string }{{"unowned", "someone-else", "uid-b"}, {"replaced", "owned", "new-uid"}} {
		t.Run(tc.name, func(t *testing.T) {
			refs := []resourceRef{{APIVersion: "v1", Kind: "ConfigMap", Name: "first", UID: "uid-a"}, {APIVersion: "v1", Kind: "Service", Name: "second", UID: "uid-b"}}
			e := reconciliationEnvironment(t, refs)
			writeReconciliationObject(t, e, refs[1], tc.owner, tc.uid)
			if err := e.reconcileResources(t.Context(), nil); err == nil {
				t.Fatal("unsafe reconciliation accepted")
			}
			if _, err := os.Stat(filepath.Join(e.dir, "deletions")); !os.IsNotExist(err) {
				t.Fatalf("preflight allowed partial unsafe removal: %v", err)
			}
		})
	}
}

func TestReconcilePartialFailureAndRetryPreserveInventory(t *testing.T) {
	refs := []resourceRef{{APIVersion: "v1", Kind: "ConfigMap", Name: "first", UID: "uid-a"}, {APIVersion: "v1", Kind: "Service", Name: "second", UID: "uid-b"}}
	e := reconciliationEnvironment(t, refs)
	t.Setenv("KB_FAIL", "second")
	if err := e.reconcileResources(t.Context(), nil); err == nil {
		t.Fatal("injected failure ignored")
	}
	var state environmentState
	data, err := os.ReadFile(filepath.Join(e.dir, "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Resources) != 1 || state.Resources[0] != refs[1] {
		t.Fatalf("lost partial failure state: %#v", state.Resources)
	}
	e.state = state
	t.Setenv("KB_FAIL", "")
	if err = e.reconcileResources(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	if len(e.state.Resources) != 0 {
		t.Fatal("retry did not finish")
	}
}

func TestReconcileCancellationPreservesInventory(t *testing.T) {
	r := resourceRef{APIVersion: "v1", Kind: "Service", Name: "api", UID: "uid"}
	e := reconciliationEnvironment(t, []resourceRef{r})
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if err := e.reconcileResources(ctx, nil); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation lost: %v", err)
	}
	if len(e.state.Resources) != 1 {
		t.Fatal("cancellation lost recorded inventory")
	}
}

func TestReconcileRetainsDataAndScalesRemovedStatefulSet(t *testing.T) {
	refs := []resourceRef{{APIVersion: "v1", Kind: "Namespace", Name: "dev", UID: "ns"}, {APIVersion: "v1", Kind: "PersistentVolumeClaim", Name: "data", UID: "pvc"}, {APIVersion: "apps/v1", Kind: "StatefulSet", Name: "database", UID: "db"}}
	e := reconciliationEnvironment(t, refs)
	if err := e.reconcileResources(t.Context(), nil); err != nil {
		t.Fatal(err)
	}
	if len(e.state.Resources) != 3 {
		t.Fatal("retained data inventory lost")
	}
	if _, err := os.Stat(filepath.Join(e.dir, "deletions")); !os.IsNotExist(err) {
		t.Fatalf("retained resource deleted: %v", err)
	}
	data, err := os.ReadFile(filepath.Join(e.dir, "patches"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"value":"db"`) || !strings.Contains(string(data), `"value":0`) {
		t.Fatalf("missing UID-protected scale down: %s", data)
	}
}

func TestReconcileRefusesDestructiveStatefulSetRetention(t *testing.T) {
	r := resourceRef{APIVersion: "apps/v1", Kind: "StatefulSet", Name: "database", UID: "db"}
	e := reconciliationEnvironment(t, []resourceRef{r})
	path := filepath.Join(e.dir, "database.json")
	var actual map[string]any
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err = json.Unmarshal(data, &actual); err != nil {
		t.Fatal(err)
	}
	actual["spec"] = map[string]any{"persistentVolumeClaimRetentionPolicy": map[string]any{"whenScaled": "Delete"}}
	if err = writeJSON(path, actual); err != nil {
		t.Fatal(err)
	}
	if err = e.reconcileResources(t.Context(), nil); err == nil || !strings.Contains(err.Error(), "refusing data deletion") {
		t.Fatalf("unsafe retention accepted: %v", err)
	}
	if _, err = os.Stat(filepath.Join(e.dir, "patches")); !os.IsNotExist(err) {
		t.Fatalf("scaled destructive StatefulSet: %v", err)
	}
}
