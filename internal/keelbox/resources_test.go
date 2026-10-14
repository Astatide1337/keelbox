package keelbox

import (
	"encoding/json"
	"testing"
)

func TestMalformedResourcesReturnErrors(t *testing.T) {
	for _, value := range []object{
		{},
		{"metadata": "invalid"},
		{"apiVersion": "v1", "kind": 42, "metadata": map[string]any{"name": "api"}},
	} {
		if _, err := objectResource(value); err == nil {
			t.Fatalf("malformed resource accepted: %#v", value)
		}
		if _, err := objectUID(value); err == nil {
			t.Fatalf("resource without valid UID accepted: %#v", value)
		}
	}
	if _, _, err := applyPayload(object{"kind": "Deployment", "spec": "invalid"}); err == nil {
		t.Fatal("malformed workload spec accepted")
	}
	if _, err := observedReplicas(map[string]any{"status": map[string]any{"replicas": "invalid"}}); err == nil {
		t.Fatal("malformed replica count treated as a stopped workload")
	}
}

func TestInputDigestIncludesConfiguration(t *testing.T) {
	config := &projectConfig{Name: "api", Endpoint: endpointSpec{LocalPort: 8080}}
	before, err := inputDigest(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	config.Endpoint.LocalPort = 8081
	after, err := inputDigest(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	if before == after {
		t.Fatal("endpoint configuration must affect applied identity and helper reuse")
	}
}

func TestMalformedLabelsAndAnnotationsAreRejected(t *testing.T) {
	e := &environment{config: &projectConfig{Namespace: "dev", ID: "owned"}}
	for _, field := range []string{"labels", "annotations"} {
		for _, invalid := range []any{"invalid", map[string]any{"key": 42}} {
			value := object{"apiVersion": "v1", "kind": "ConfigMap", "metadata": map[string]any{"name": "api", field: invalid}}
			if _, err := e.prepareResource(value); err == nil {
				t.Fatalf("malformed metadata.%s was silently replaced", field)
			}
		}
	}
}

func TestPersistedStateKeepsExistingFieldNames(t *testing.T) {
	state := environmentState{ID: "existing", Endpoint: endpointSpec{LocalPort: 8080}, Images: map[string]imageArtifact{"api": {ID: "image-id"}}}
	data, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var stored struct {
		ID       string
		Endpoint struct{ LocalPort int }
		Images   map[string]struct{ ID string }
	}
	if err = json.Unmarshal(data, &stored); err != nil {
		t.Fatal(err)
	}
	if stored.ID != "existing" || stored.Endpoint.LocalPort != 8080 || stored.Images["api"].ID != "image-id" {
		t.Fatal("private Go type names must not change persisted state fields")
	}
}
