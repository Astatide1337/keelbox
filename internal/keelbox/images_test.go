package keelbox

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func TestImageProfilesPreserveRegistrySemantics(t *testing.T) {
	for _, tc := range []struct {
		name        string
		builds      []buildSpec
		input, want string
		policy      string
	}{
		{"local", []buildSpec{{Name: "api", Image: "localhost:5000/api"}}, "localhost:5000/api:old", "localhost:5000/api:kb-new", "IfNotPresent"},
		{"prebuilt", nil, "registry.example/api:stable", "registry.example/api:stable", "Always"},
		{"mixed-sidecar", []buildSpec{{Name: "api", Image: "local/api"}}, "registry.example/sidecar:v1", "registry.example/sidecar:v1", "Always"},
		{"pinned-same-repository", []buildSpec{{Name: "api", Image: "local/api"}}, "local/api@sha256:abcdef", "local/api@sha256:abcdef", "Always"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			node := object{"image": tc.input, "imagePullPolicy": "Always", "imagePullSecrets": []any{map[string]any{"name": "registry-auth"}}}
			secrets := node["imagePullSecrets"]
			if err := rewriteImages(node, tc.builds, map[string]imageArtifact{"api": {Tag: "localhost:5000/api:kb-new"}}); err != nil {
				t.Fatal(err)
			}
			if node["image"] != tc.want || node["imagePullPolicy"] != tc.policy || !reflect.DeepEqual(node["imagePullSecrets"], secrets) {
				t.Fatalf("unexpected rewrite: %#v", node)
			}
		})
	}
	node := object{"image": "local/api:v1"}
	if err := rewriteImages(node, []buildSpec{{Name: "api", Image: "local/api"}}, nil); err == nil {
		t.Fatal("mapped image must require a built artifact")
	}
	unconfigured := object{"image": "registry.example/api:stable"}
	if err := rewriteImages(unconfigured, nil, nil); err != nil {
		t.Fatal(err)
	}
	if _, exists := unconfigured["imagePullPolicy"]; exists {
		t.Fatal("must not invent prebuilt pull policy")
	}
}

func TestPrebuiltOnlyConfigurationAndBuild(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keelbox.yaml")
	data := []byte("version: 1\nname: api\nnamespace: dev\nproject: .\nhelm: {chart: chart}\nworkloads: {api: deployment/api}\nendpoint: {service: api, port: 80, localPort: 8080}\n")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	config, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", t.TempDir())
	e := &environment{config: config}
	if err = e.build(t.Context(), ""); err != nil {
		t.Fatalf("empty build must not invoke Docker: %v", err)
	}
	if err = e.build(t.Context(), "missing"); err == nil || !strings.Contains(err.Error(), "unknown image") {
		t.Fatalf("explicit unknown build: %v", err)
	}
}

func TestAppliedImageReferencesIncludePrebuiltAndRejectOldPods(t *testing.T) {
	objects, err := decodeObjects([]byte("kind: Deployment\nspec:\n  template:\n    spec:\n      containers:\n      - image: local/api:kb-new\n      - image: registry.example/sidecar:v1\n"))
	if err != nil {
		t.Fatal(err)
	}
	applied, err := appliedImageReferences(objects)
	if err != nil {
		t.Fatal(err)
	}
	if !appliedImagesMatch([]string{"local/api:kb-new", "registry.example/sidecar:v1"}, applied) {
		t.Fatal("mixed application cannot access current Pod")
	}
	if appliedImagesMatch([]string{"local/api:kb-old", "registry.example/sidecar:v1"}, applied) {
		t.Fatal("prebuilt sidecar accepted stale application")
	}
	if !appliedImagesMatch([]string{"registry.example/sidecar:v1"}, applied) {
		t.Fatal("prebuilt image not recorded")
	}
}

func TestBuildReusesMatchingImageIdentity(t *testing.T) {
	b := testBuild(t)
	fingerprint, err := buildFingerprint(b)
	if err != nil {
		t.Fatal(err)
	}
	tag := b.Image + ":kb-" + fingerprint[:20]
	dir := t.TempDir()
	docker := filepath.Join(dir, "docker")
	if err = os.WriteFile(docker, []byte("#!/bin/sh\nif [ \"$3 $4\" = 'image inspect' ]; then printf 'sha256:expected'; else exit 98; fi\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	artifact := imageArtifact{Fingerprint: fingerprint, Tag: tag, ID: "sha256:expected"}
	e := &environment{dir: t.TempDir(), state: environmentState{Images: map[string]imageArtifact{}, Artifacts: map[string]imageArtifact{tag: artifact}}}
	if err = e.buildImage(t.Context(), "local", b); err != nil {
		t.Fatal(err)
	}
	if e.state.Images[b.Name] != artifact {
		t.Fatal("cached image identity changed")
	}
}

func TestAppliedImagesRejectMalformedPodInputs(t *testing.T) {
	for _, input := range []string{
		"kind: Deployment", "kind: Deployment\nspec: []", "kind: Deployment\nspec: {template: {spec: {containers: []}}}",
		"kind: Job\nspec: {template: {spec: {containers: [{image: 42}]}}}",
	} {
		objects, err := decodeObjects([]byte(input))
		if err != nil {
			t.Fatal(err)
		}
		if _, err = appliedImageReferences(objects); err == nil {
			t.Fatalf("accepted malformed Pod inputs: %s", input)
		}
	}
}
