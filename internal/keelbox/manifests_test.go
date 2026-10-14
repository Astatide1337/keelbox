package keelbox

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestPlainManifestConfiguration(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keelbox.yaml")
	base := "version: 1\nname: api\nnamespace: dev\nproject: .\nworkloads: {api: deployment/api}\nendpoint: {service: api, port: 80, localPort: 8080}\n"
	for _, tc := range []struct{ name, extra, want string }{
		{"plain", "resources: [app.yaml]\n", ""},
		{"helm", "helm: {chart: chart}\n", ""},
		{"both", "helm: {chart: chart}\nresources: [app.yaml]\n", ""},
		{"none", "", "declare helm.chart or resources"},
		{"empty-path", "resources: ['']\n", "nonempty"},
		{"values-without-chart", "resources: [app.yaml]\nhelm: {values: [values.yaml]}\n", "require helm.chart"},
		{"dependencies-without-chart", "resources: [app.yaml]\nhelm: {dependencies: [{source: chart, destination: charts/api}]}\n", "require helm.chart"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if err := os.WriteFile(path, []byte(base+tc.extra), 0600); err != nil {
				t.Fatal(err)
			}
			config, err := loadConfig(path)
			if tc.want != "" {
				if err == nil || !strings.Contains(err.Error(), tc.want) {
					t.Fatalf("wanted %q, got %v", tc.want, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			if tc.name == "plain" && config.Helm.Chart != "" {
				t.Fatal("plain recipe acquired a Helm chart")
			}
		})
	}
}

func TestPlainAndHelmUseSameResourcePipeline(t *testing.T) {
	manifest := "apiVersion: apps/v1\nkind: Deployment\nmetadata: {name: api}\nspec:\n  template:\n    spec:\n      containers: [{name: api, image: registry.example/api:v1, imagePullPolicy: Always}]\n"
	for _, helm := range []bool{false, true} {
		t.Run(map[bool]string{false: "plain", true: "helm"}[helm], func(t *testing.T) {
			dir := t.TempDir()
			e := &environment{dir: dir, config: &projectConfig{ID: "owned", Dir: dir, Name: "api", Namespace: "dev"}}
			if helm {
				chart := filepath.Join(dir, "chart")
				if err := os.Mkdir(chart, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(chart, "Chart.yaml"), []byte("apiVersion: v2\nname: api\nversion: 0.1.0\n"), 0600); err != nil {
					t.Fatal(err)
				}
				e.config.Helm.Chart = chart
				tools := t.TempDir()
				script := "#!/bin/sh\ncase \"$1\" in\ndependency) exit 0;;\ntemplate) printf '%s' '" + manifest + "';;\n*) exit 99;;\nesac\n"
				if err := os.WriteFile(filepath.Join(tools, "helm"), []byte(script), 0700); err != nil {
					t.Fatal(err)
				}
				t.Setenv("PATH", tools)
			} else {
				e.config.Resources = []string{"app.yaml"}
				if err := os.WriteFile(filepath.Join(dir, "app.yaml"), []byte(manifest), 0600); err != nil {
					t.Fatal(err)
				}
				t.Setenv("PATH", t.TempDir())
			}
			objects, err := e.render(t.Context())
			if err != nil {
				t.Fatal(err)
			}
			if len(objects) != 2 {
				t.Fatalf("namespace + deployment: %#v", objects)
			}
			metadata := fixtureMap(t, objects[1]["metadata"])
			if metadata["namespace"] != "dev" || fixtureMap(t, metadata["labels"])["keelbox.dev/environment"] != "owned" {
				t.Fatalf("scoping lost: %#v", metadata)
			}
			refs, err := appliedImageReferences(objects)
			if err != nil || refs["registry.example/api:v1"].Tag != "registry.example/api:v1" {
				t.Fatalf("image identity lost: %#v %v", refs, err)
			}
			first, err := inputDigest(e.config, objects)
			if err != nil {
				t.Fatal(err)
			}
			metadata["name"] = "changed"
			changed, err := inputDigest(e.config, objects)
			if err != nil || changed == first {
				t.Fatalf("resource change not reflected in input identity: %v", err)
			}
		})
	}
}

func TestPlainManifestRejectsInvalidResources(t *testing.T) {
	for _, tc := range []struct{ name, input, want string }{
		{"empty", "# empty\n", "contains no resources"},
		{"malformed", "[", ""},
		{"unsupported", "apiVersion: networking.k8s.io/v1\nkind: Ingress\nmetadata: {name: api}\n", "unsupported resource"},
		{"cross-namespace", "apiVersion: v1\nkind: Service\nmetadata: {name: api, namespace: other}\n", "unexpected namespace"},
		{"duplicate", "apiVersion: v1\nkind: Service\nmetadata: {name: api}\n---\napiVersion: v1\nkind: Service\nmetadata: {name: api}\n", "duplicate resource"},
		{"list", "apiVersion: v1\nkind: List\nmetadata: {name: api}\nitems: []\n", "unsupported resource"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			if err := os.WriteFile(filepath.Join(dir, "app.yaml"), []byte(tc.input), 0600); err != nil {
				t.Fatal(err)
			}
			e := &environment{dir: dir, config: &projectConfig{ID: "owned", Dir: dir, Namespace: "dev", Resources: []string{"app.yaml"}}}
			if _, err := e.render(t.Context()); err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("wanted failure %q, got %v", tc.want, err)
			}
		})
	}
	dir := t.TempDir()
	e := &environment{dir: dir, config: &projectConfig{Dir: dir, Resources: []string{"missing.yaml"}}}
	if _, err := e.render(t.Context()); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("missing manifest error identity lost: %v", err)
	}
}

func TestPlainManifestDoctorDoesNotRequireHelm(t *testing.T) {
	dir := t.TempDir()
	scripts := map[string]string{
		"docker": "#!/bin/sh\ncase \"$1 $2\" in\n'context show') printf 'default';;\n'context inspect') printf 'unix:///var/run/docker.sock';;\n'--context default') printf '29.8.2';;\n*) exit 99;;\nesac\n",
		"kind":   "#!/bin/sh\nexit 0\n", "kubectl": "#!/bin/sh\nexit 0\n",
	}
	for name, script := range scripts {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("DOCKER_HOST", "")
	if err := doctor(t.Context(), &projectConfig{Resources: []string{"app.yaml"}}); err != nil {
		t.Fatalf("plain manifests acquired Helm prerequisite: %v", err)
	}
	if err := doctor(t.Context(), &projectConfig{Helm: helmSpec{Chart: "chart"}}); err == nil || !strings.Contains(err.Error(), "missing helm") {
		t.Fatalf("Helm project must require Helm: %v", err)
	}
}
