package keelbox

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func testBuild(t *testing.T) buildSpec {
	t.Helper()
	dir := t.TempDir()
	if writeErr := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\nCOPY app /app\n"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	if writeErr := os.WriteFile(filepath.Join(dir, "app"), []byte("before"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	return buildSpec{Name: "api", Context: dir, Dockerfile: "Dockerfile", Image: "keelbox/test"}
}
func TestBuildFingerprintHonorsDockerignoreAndNegation(t *testing.T) {
	b := testBuild(t)
	if mkdirErr := os.Mkdir(filepath.Join(b.Context, "cache"), 0700); mkdirErr != nil {
		t.Fatal(mkdirErr)
	}
	if writeErr := os.WriteFile(filepath.Join(b.Context, ".dockerignore"), []byte("cache/*\n!cache/keep\n"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	if writeErr := os.WriteFile(filepath.Join(b.Context, "cache", "keep"), []byte("important"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	if writeErr := os.WriteFile(filepath.Join(b.Context, "cache", "discard"), []byte("noise"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	before, err := buildFingerprint(b)
	if err != nil {
		t.Fatal(err)
	}
	if writeErr := os.WriteFile(filepath.Join(b.Context, "cache", "discard"), []byte("changed noise"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	ignored, err := buildFingerprint(b)
	if err != nil {
		t.Fatal(err)
	}
	if ignored != before {
		t.Fatal("ignored files must not invalidate build cache")
	}
	if writeErr := os.WriteFile(filepath.Join(b.Context, "cache", "keep"), []byte("changed source"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	changed, err := buildFingerprint(b)
	if err != nil {
		t.Fatal(err)
	}
	if changed == before {
		t.Fatal("negated ignore rule must retain source identity")
	}
}
func TestExecArgumentsAreNotConsumedAsGlobalOptions(t *testing.T) {
	args := []string{"exec", "api", "--", "echo", "--config", "child.yaml", "-d", "--volumes"}
	path, detach, volumes, rest, err := parseOptions(args)
	if err != nil || path != "keelbox.yaml" || detach || volumes || !reflect.DeepEqual(rest, args) {
		t.Fatalf("child arguments corrupted: %q %t %t %q %v", path, detach, volumes, rest, err)
	}
}
func TestDecodeResourcesUsesPlainNestedMaps(t *testing.T) {
	objects, err := decodeObjects([]byte("apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: api\nspec:\n  template:\n    spec:\n      containers:\n      - name: api\n        image: keelbox/test:old\n"))
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := objects[0]["metadata"].(map[string]any); !ok {
		t.Fatal("metadata type cannot be consumed by resource pipeline")
	}
	if rewriteErr := rewriteImages(objects[0], []buildSpec{{Name: "api", Image: "keelbox/test"}}, map[string]imageArtifact{"api": {Tag: "keelbox/test:new"}}); rewriteErr != nil {
		t.Fatal(rewriteErr)
	}
	pod := fixtureMap(t, fixtureMap(t, fixtureMap(t, objects[0]["spec"])["template"])["spec"])
	containers, ok := pod["containers"].([]any)
	if !ok || len(containers) != 1 {
		t.Fatal("fixture containers missing")
	}
	container := fixtureMap(t, containers[0])
	if container["image"] != "keelbox/test:new" || container["imagePullPolicy"] != "IfNotPresent" {
		t.Fatal("image mapping not applied to Pod template")
	}
}
func TestEnvironmentLockSerializesWriters(t *testing.T) {
	t.Setenv("XDG_STATE_HOME", t.TempDir())
	c := &projectConfig{ID: "unit-lock", Name: "test", Namespace: "test", Path: "/test/config"}
	first, err := openEnvironment(c)
	if err != nil {
		t.Fatal(err)
	}
	if _, lockErr := openEnvironment(c); lockErr == nil {
		t.Fatal("second writer acquired active lock")
	}
	if err = first.close(); err != nil {
		t.Fatal(err)
	}
	second, err := openEnvironment(c)
	if err != nil {
		t.Fatal(err)
	}
	if err = second.close(); err != nil {
		t.Fatal(err)
	}
}
func TestEnvParserDoesNotEvaluateShellAndRejectsDuplicates(t *testing.T) {
	path := filepath.Join(t.TempDir(), "local.env")
	if writeErr := os.WriteFile(path, []byte("TOKEN='$(must-stay-literal)'\n"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	values, err := loadEnv(path)
	if err != nil || values["TOKEN"] != "$(must-stay-literal)" {
		t.Fatal("environment input was not literal", err)
	}
	if writeErr := os.WriteFile(path, []byte("TOKEN=first\nTOKEN=private-second\n"), 0600); writeErr != nil {
		t.Fatal(writeErr)
	}
	_, err = loadEnv(path)
	if err == nil || strings.Contains(err.Error(), "private-second") {
		t.Fatal("duplicate input must fail without exposing values")
	}
}

func TestEndpointRejectsOldApplicationWithUnchangedSidecar(t *testing.T) {
	applied := map[string]imageArtifact{"app": {Tag: "app:new"}, "sidecar": {Tag: "sidecar:current"}}
	if appliedImagesMatch([]string{"app:old", "sidecar:current"}, applied) {
		t.Fatal("unchanged sidecar cannot certify the previous application image")
	}
	if !appliedImagesMatch([]string{"app:new", "sidecar:current"}, applied) {
		t.Fatal("current application and sidecar must be eligible")
	}
	if appliedImagesMatch(nil, applied) {
		t.Fatal("empty Pod cannot be a ready application endpoint")
	}
}

func TestReplicaApplyDoesNotMutateDesiredInput(t *testing.T) {
	for _, kind := range []string{"Deployment", "StatefulSet"} {
		desired := object{"kind": kind, "spec": map[string]any{"replicas": 3, "template": map[string]any{"example": "unchanged"}}}
		payload, replicas, err := applyPayload(desired)
		if err != nil {
			t.Fatal(err)
		}
		if replicas != 3 {
			t.Fatal("desired replica count lost")
		}
		if _, exists := fixtureMap(t, payload["spec"])["replicas"]; exists {
			t.Fatal("SSA must not own replicas")
		}
		if fixtureMap(t, desired["spec"])["replicas"] != 3 {
			t.Fatal("applied-input digest would lose replica intent")
		}
		_, replicas, err = applyPayload(object{"kind": kind, "spec": map[string]any{}})
		if err != nil {
			t.Fatal(err)
		}
		if replicas != 1 {
			t.Fatal("Kubernetes default replica count not preserved")
		}
	}
}

func fixtureMap(t *testing.T, value any) map[string]any {
	t.Helper()
	result, ok := value.(map[string]any)
	if !ok {
		t.Fatalf("fixture is not a map: %T", value)
	}
	return result
}
