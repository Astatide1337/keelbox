package keelbox

import (
	"context"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func commandOutput(t *testing.T, run func() error) (string, error) {
	t.Helper()
	reader, writer, err := os.Pipe()
	if err != nil {
		t.Fatal(err)
	}
	old := os.Stdout
	os.Stdout = writer
	defer func() { os.Stdout = old }()
	runErr := run()
	if err = writer.Close(); err != nil {
		t.Fatal(err)
	}
	data, err := io.ReadAll(reader)
	if closeErr := reader.Close(); err != nil || closeErr != nil {
		t.Fatal(errors.Join(err, closeErr))
	}
	return string(data), runErr
}

func doctorTools(t *testing.T) {
	t.Helper()
	dir := t.TempDir()
	for name, script := range map[string]string{
		"docker": "case \"$1 $2\" in\n'context show') printf default;;\n'context inspect') printf unix:///var/run/docker.sock;;\n'--context default') printf 29;;\n*) exit 99;;\nesac\n",
		"kind":   "exit 99\n", "kubectl": "exit 99\n", "helm": "exit 99\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("DOCKER_HOST", "")
}

func doctorProject(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	path := filepath.Join(dir, "keelbox.yaml")
	for name, data := range map[string]string{
		"keelbox.yaml": "version: 1\nname: api\nnamespace: dev\nproject: .\nhelm: {chart: chart}\nbuild: [{name: api, context: ., dockerfile: Dockerfile, image: local/api}]\nworkloads: {api: deployment/api}\nendpoint: {service: api, port: 80, localPort: 8080}\n",
		"Dockerfile":   "FROM scratch\n",
	} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	return path
}

func TestDoctorConfigurationDiscovery(t *testing.T) {
	doctorTools(t)
	t.Chdir(t.TempDir())
	t.Setenv("XDG_STATE_HOME", filepath.Join(t.TempDir(), "absent-state"))
	out, err := commandOutput(t, func() error { return Run(t.Context(), []string{"doctor"}) })
	if err != nil || !strings.Contains(out, "machine prerequisites passed") {
		t.Fatalf("machine doctor: %s %v", out, err)
	}
	if _, err = os.Stat(os.Getenv("XDG_STATE_HOME")); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("doctor created private state: %v", err)
	}
	if err = Run(t.Context(), []string{"doctor", "--config", "missing.yaml"}); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("explicit missing config ignored: %v", err)
	}
	if err = os.WriteFile("keelbox.yaml", []byte("not: valid"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = Run(t.Context(), []string{"doctor"}); err == nil || !strings.Contains(err.Error(), "correct the file") {
		t.Fatalf("invalid default ignored: %v", err)
	}
}

func TestDoctorProjectAndMissingPrerequisites(t *testing.T) {
	doctorTools(t)
	path := doctorProject(t)
	out, err := commandOutput(t, func() error { return Run(t.Context(), []string{"doctor", "--config", path}) })
	if err != nil || !strings.Contains(out, "Workload api: deployment/api") || !strings.Contains(out, "were not checked") {
		t.Fatalf("project doctor: %s %v", out, err)
	}
	t.Setenv("PATH", t.TempDir())
	if err = Run(t.Context(), []string{"doctor", "--config", path}); err == nil || !strings.Contains(err.Error(), "Install Docker") {
		t.Fatalf("missing prerequisite: %v", err)
	}
}

func TestInterruptedStartupPreservesCancellationAndGuidance(t *testing.T) {
	doctorTools(t)
	config, err := loadConfig(doctorProject(t))
	if err != nil {
		t.Fatal(err)
	}
	e := &environment{config: config}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	err = e.start(ctx, true)
	if !errors.Is(err, context.Canceled) || !strings.Contains(err.Error(), "startup did not complete") || !strings.Contains(err.Error(), "retry up -d") {
		t.Fatalf("interrupted startup: %v", err)
	}
}

func TestDoctorReportsEachMissingSupportingTool(t *testing.T) {
	for _, name := range []string{"kind", "kubectl", "helm"} {
		t.Run(name, func(t *testing.T) {
			doctorTools(t)
			if err := os.Remove(filepath.Join(os.Getenv("PATH"), name)); err != nil {
				t.Fatal(err)
			}
			err := doctor(t.Context(), nil)
			if err == nil || !strings.Contains(err.Error(), "missing "+name) || !strings.Contains(err.Error(), "PATH") {
				t.Fatalf("missing tool %s: %v", name, err)
			}
		})
	}
}
