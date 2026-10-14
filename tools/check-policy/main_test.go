package main

import (
	"go/parser"
	"go/token"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestMakeUsesPinnedLintDefault(t *testing.T) {
	dir := t.TempDir()
	for _, name := range []string{"Makefile", ".golangci-version"} {
		data, err := os.ReadFile(filepath.Join("../..", name))
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	for _, name := range []string{"cmd", "internal", "tools"} {
		if err := os.Mkdir(filepath.Join(dir, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(dir, "golangci-lint"), []byte("#!/bin/sh\ntouch pinned-lint-invoked\ncat .golangci-version\n"), 0700); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir+string(os.PathListSeparator)+os.Getenv("PATH"))
	command := exec.Command("make", "lint-version")
	command.Dir = dir
	// Remove inherited command overrides to expose GNU Make's built-in default.
	for _, value := range os.Environ() {
		if !strings.HasPrefix(value, "LINT=") && !strings.HasPrefix(value, "MAKEFLAGS=") && !strings.HasPrefix(value, "MAKEOVERRIDES=") {
			command.Env = append(command.Env, value)
		}
	}
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("default pinned linter must run: %v: %s", err, output)
	}
	if _, err := os.Stat(filepath.Join(dir, "pinned-lint-invoked")); err != nil {
		t.Fatalf("pinned linter must be invoked: %v", err)
	}
}

func TestSourceSymlinksRejectedBeforeTools(t *testing.T) {
	makefile, err := os.ReadFile("../../Makefile")
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for _, name := range []string{"cmd", "internal", "tools"} {
		if err = os.Mkdir(filepath.Join(dir, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	for name, content := range map[string][]byte{
		"Makefile":          makefile,
		".golangci-version": []byte("2.14.0\n"),
		"lint":              []byte("#!/bin/sh\ntouch tool-invoked\nexit 0\n"),
	} {
		if err = os.WriteFile(filepath.Join(dir, name), content, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.Symlink(t.TempDir(), filepath.Join(dir, "cmd", "external")); err != nil {
		t.Fatal(err)
	}
	t.Chdir(dir)
	if err = checkSourcePolicy(); err == nil || !strings.Contains(err.Error(), "symlinks are forbidden") {
		t.Fatalf("expected source symlink rejection: %v", err)
	}
	command := exec.Command("make", "fmt", "LINT="+filepath.Join(dir, "lint"))
	output, err := command.CombinedOutput()
	if err == nil || !strings.Contains(string(output), "symlinks are forbidden") {
		t.Fatalf("expected make to reject source symlink: %v: %s", err, output)
	}
	if _, err = os.Stat("tool-invoked"); !os.IsNotExist(err) {
		t.Fatalf("tool must not run before layout rejection: %v", err)
	}
}

func TestSourcePolicyBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name, source string
		production   bool
		allowed      bool
	}{
		{"entry-and-serialized-fields", "package keelbox\nfunc Run() {}\ntype state struct { ID string }", true, true},
		{"private-helper", "package keelbox\nfunc helper() {}", true, true},
		{"test-entry", "package keelbox\nfunc TestProbe() {}", false, true},
		{"public-helper", "package keelbox\nfunc Helper() {}", true, false},
		{"public-type", "package keelbox\ntype State struct{}", true, false},
		{"public-value", "package keelbox\nvar State = 1", true, false},
		{"public-method", "package keelbox\ntype state struct{}\nfunc (s state) Run() {}", true, false},
		{"blanket-all", "package keelbox\n//nolint:all // bypass\nfunc helper() {}", false, false},
		{"blanket-unscoped", "package keelbox\n//nolint // bypass\nfunc helper() {}", false, false},
		{"specific-directive", "package keelbox\n//nolint:errcheck // concrete reason still requires review\nfunc helper() {}", false, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			file, err := parser.ParseFile(token.NewFileSet(), "fixture.go", tc.source, parser.ParseComments)
			if err != nil {
				t.Fatal(err)
			}
			err = checkFilePolicy(file, tc.production)
			if (err == nil) != tc.allowed {
				t.Fatalf("policy allowed=%t, expected=%t: %v", err == nil, tc.allowed, err)
			}
		})
	}
}
