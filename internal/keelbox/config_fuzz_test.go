package keelbox

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestLoadConfigResolvesAcceptedRecipe(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "keelbox.yaml")
	data := []byte("version: 1\nname: api\nnamespace: dev\nproject: .\nhelm: {chart: chart}\nbuild: [{name: api, context: ., dockerfile: Dockerfile, image: local/api}]\nworkloads: {api: deployment/api}\nendpoint: {service: api, port: 80, localPort: 8080}\n")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte("FROM scratch\n"), 0600); err != nil {
		t.Fatal(err)
	}
	config, err := loadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if config.Project != dir || config.Build[0].Context != dir || config.Helm.Chart != filepath.Join(dir, "chart") || config.Path != path || len(config.ID) != 12 {
		t.Fatal("accepted recipe must retain resolved paths and environment identity")
	}
	if err = os.Remove(filepath.Join(dir, "Dockerfile")); err != nil {
		t.Fatal(err)
	}
	if _, err = loadConfig(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("accepted YAML must still validate its build inputs: %v", err)
	}
}

func FuzzConfig(f *testing.F) {
	for _, seed := range []string{
		"version: 1\nname: api\nnamespace: dev\nproject: .\n",
		"version: 1\nname: api\nnamespace: dev\nunknown: true\n",
		"version: 1\nname: api\nnamespace: dev\n---\nname: other\n",
		"version: 1\nname: api\nnamespace: dev\nworkloads: {api: deployment/api}\n",
		"", "null", "[]", "name: &name [*name]",
	} {
		f.Add([]byte(seed))
	}
	f.Fuzz(func(t *testing.T, data []byte) {
		config, err := decodeConfig(data)
		if err != nil {
			return
		}
		if config.Version != 1 || !dnsName.MatchString(config.Name) || !dnsName.MatchString(config.Namespace) {
			t.Fatal("accepted invalid project identity")
		}
		encoded, err := yaml.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		again, err := decodeConfig(encoded)
		if err != nil {
			t.Fatalf("accepted configuration must round-trip: %v", err)
		}
		reencoded, err := yaml.Marshal(again)
		if err != nil || !bytes.Equal(encoded, reencoded) {
			t.Fatalf("configuration serialization must remain stable: %v", err)
		}
		for _, suffix := range []string{"\n---\nname: other\n", "\nkeelboxUnknownField: true\n"} {
			if _, err = decodeConfig(append(encoded, []byte(suffix)...)); err == nil {
				t.Fatal("accepted additional document or unknown field")
			}
		}
	})
}
