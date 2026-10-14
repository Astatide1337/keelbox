package keelbox

import "testing"

func TestVersionWithoutProject(t *testing.T) {
	for _, command := range []string{"version", "--version"} {
		if err := Run(t.Context(), []string{command, "--config", "/missing/keelbox.yaml"}); err != nil {
			t.Fatalf("%s requires no project: %v", command, err)
		}
	}
	if err := Run(t.Context(), []string{"version", "unexpected"}); err == nil {
		t.Fatal("version accepted unexpected arguments")
	}
	if versionInfo() != "keelbox dev (commit unknown)" {
		t.Fatalf("unexpected source-build identity: %s", versionInfo())
	}
}
