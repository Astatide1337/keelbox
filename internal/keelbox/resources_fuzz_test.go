package keelbox

import (
	"encoding/json"
	"testing"
)

func FuzzResourceMetadata(f *testing.F) {
	for _, seed := range []string{
		`{"apiVersion":"v1","kind":"Service","metadata":{"name":"api","uid":"owned","labels":{"app":"api"}},"status":{"replicas":1}}`,
		`{"metadata":{"name":12,"uid":null,"annotations":{"key":42}},"status":{"replicas":-1}}`,
		`{"metadata":"invalid","status":[]}`,
		`{}`, `null`, `[]`,
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		var value object
		if err := json.Unmarshal(data, &value); err != nil {
			return
		}
		metadata, metadataErr := objectMetadata(value)
		if ref, err := objectResource(value); err == nil {
			if metadataErr != nil || ref.APIVersion == "" || ref.Kind == "" || ref.Name == "" {
				t.Fatal("accepted resource without identity")
			}
			if ref.APIVersion != value["apiVersion"] || ref.Kind != value["kind"] || ref.Name != metadata["name"] {
				t.Fatal("resource identity changed during validation")
			}
		}
		if uid, err := objectUID(value); err == nil && (metadataErr != nil || uid == "" || uid != metadata["uid"]) {
			t.Fatal("accepted missing or changed UID")
		}
		assertMetadataStrings(t, metadata)
		if replicas, err := observedReplicas(value); err == nil && replicas < 0 {
			t.Fatal("accepted negative replica count")
		}
	})
}

func assertMetadataStrings(t *testing.T, metadata map[string]any) {
	t.Helper()
	for _, field := range []string{"labels", "annotations"} {
		if values, err := metadataValues(metadata, field); err == nil {
			for _, item := range values {
				if _, ok := item.(string); !ok {
					t.Fatal("accepted non-string metadata value")
				}
			}
		}
	}
}
