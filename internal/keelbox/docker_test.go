package keelbox

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestMissingDockerStopsUpWithInstallGuidance(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	t.Setenv("DOCKER_HOST", "")
	e := &environment{config: &projectConfig{Build: []buildSpec{{Name: "api"}}}}
	err := e.up(context.Background())
	if err == nil || !strings.Contains(err.Error(), "not found in PATH") || !strings.Contains(err.Error(), "https://docs.docker.com/engine/install/") {
		t.Fatalf("expected actionable prerequisite failure before build or cluster work, got %v", err)
	}
	if err = doctor(context.Background(), nil); err == nil || !strings.Contains(err.Error(), "https://docs.docker.com/engine/install/") {
		t.Fatalf("doctor must give the same Docker prerequisite guidance, got %v", err)
	}
}

func TestDockerAvailabilityAndLocalContext(t *testing.T) {
	for _, tc := range []struct {
		name, endpoint, info, wantError string
	}{
		{"available", "unix:///var/run/docker.sock", "printf '29.8.2'", ""},
		{"unavailable", "unix:///var/run/docker.sock", "printf 'permission denied connecting to Docker' >&2; exit 1", "docker is installed but unavailable"},
		{"remote", "tcp://remote:2375", "exit 99", "not a local Unix socket"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			script := "#!/bin/sh\ncase \"$1 $2\" in\n'context show') printf 'default';;\n'context inspect') printf '" + tc.endpoint + "';;\n'--context default') " + tc.info + ";;\n*) exit 98;;\nesac\n"
			if err := os.WriteFile(filepath.Join(dir, "docker"), []byte(script), 0700); err != nil {
				t.Fatal(err)
			}
			t.Setenv("PATH", dir)
			t.Setenv("DOCKER_HOST", "")
			current, err := localDocker(context.Background())
			if tc.wantError == "" {
				if err != nil || current != "default" {
					t.Fatalf("healthy local Docker rejected: %q %v", current, err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.wantError) {
				t.Fatalf("expected %q, got %v", tc.wantError, err)
			}
			if tc.name == "unavailable" && (!strings.Contains(err.Error(), "permission denied") || !strings.Contains(err.Error(), "docker --context default info") || !strings.Contains(err.Error(), "https://docs.docker.com/engine/daemon/start/")) {
				t.Fatalf("connection failure lost its cause or recovery guidance: %v", err)
			}
		})
	}
}
