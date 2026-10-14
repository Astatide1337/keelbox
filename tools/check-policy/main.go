// Command check-policy proves that repository quality boundaries reject violations.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"regexp"
	"strings"
	"syscall"
	"time"
)

func main() {
	lint := flag.String("lint", "golangci-lint", "pinned golangci-lint executable")
	flag.Parse()
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	if err := run(ctx, *lint); err != nil {
		fmt.Fprintln(os.Stderr, "quality policy:", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, lint string) error {
	version, err := os.ReadFile(".golangci-version")
	if err != nil {
		return err
	}
	pin := strings.TrimSpace(string(version))
	if !regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`).MatchString(pin) {
		return fmt.Errorf(".golangci-version must pin one stable major.minor.patch version")
	}
	installed, err := exec.CommandContext(ctx, lint, "version", "--short").CombinedOutput()
	if err != nil {
		return fmt.Errorf("read lint version: %w: %s", err, installed)
	}
	if strings.TrimSpace(string(installed)) != pin {
		return fmt.Errorf("lint version does not match .golangci-version")
	}
	if err = checkSourcePolicy(); err != nil {
		return err
	}
	config, err := os.ReadFile(".golangci.yml")
	if err != nil {
		return err
	}
	goVersion, err := projectGoVersion()
	if err != nil {
		return err
	}
	return runFixtures(ctx, lint, config, goVersion)
}

func projectGoVersion() (string, error) {
	data, err := os.ReadFile("go.mod")
	if err != nil {
		return "", err
	}
	for _, line := range strings.Split(string(data), "\n") {
		fields := strings.Fields(line)
		if len(fields) == 2 && fields[0] == "go" {
			return fields[1], nil
		}
	}
	return "", fmt.Errorf("go.mod has no Go version directive")
}

func checkSourcePolicy() error {
	for _, directory := range []string{"cmd", "internal", "tools"} {
		if err := filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.Type()&os.ModeSymlink != 0 {
				return fmt.Errorf("%s: source symlinks are forbidden; keep source inside its owning tree", path)
			}
			if entry.IsDir() || filepath.Ext(path) != ".go" {
				return nil
			}
			file, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ParseComments)
			if parseErr != nil {
				return parseErr
			}
			productionAPI := filepath.Dir(path) == filepath.Join("internal", "keelbox") && !strings.HasSuffix(path, "_test.go")
			if policyErr := checkFilePolicy(file, productionAPI); policyErr != nil {
				return fmt.Errorf("%s: %w", path, policyErr)
			}
			return nil
		}); err != nil {
			return err
		}
	}
	return nil
}

func checkFilePolicy(file *ast.File, productionAPI bool) error {
	for _, group := range file.Comments {
		for _, comment := range group.List {
			if err := checkDirective(comment.Text); err != nil {
				return err
			}
		}
	}
	if !productionAPI {
		return nil
	}
	for _, declaration := range file.Decls {
		if err := checkDeclaration(declaration); err != nil {
			return err
		}
	}
	return nil
}

func checkDeclaration(declaration ast.Decl) error {
	switch value := declaration.(type) {
	case *ast.FuncDecl:
		if value.Name.IsExported() && (value.Name.Name != "Run" || value.Recv != nil) {
			return fmt.Errorf("production API exports %s; keep implementation private", value.Name.Name)
		}
	case *ast.GenDecl:
		for _, spec := range value.Specs {
			switch named := spec.(type) {
			case *ast.TypeSpec:
				if named.Name.IsExported() {
					return fmt.Errorf("production API exports type %s", named.Name.Name)
				}
			case *ast.ValueSpec:
				for _, name := range named.Names {
					if name.IsExported() {
						return fmt.Errorf("production API exports value %s", name.Name)
					}
				}
			}
		}
	}
	return nil
}

func checkDirective(comment string) error {
	if !strings.HasPrefix(comment, "//") {
		return nil
	}
	fields := strings.Fields(strings.TrimPrefix(comment, "//"))
	if len(fields) == 0 {
		return nil
	}
	if fields[0] == "nolint" {
		return fmt.Errorf("blanket nolint directive is forbidden; fix the cause or name a reviewed specific rule")
	}
	if strings.HasPrefix(fields[0], "nolint:") {
		for _, name := range strings.Split(strings.TrimPrefix(fields[0], "nolint:"), ",") {
			if name == "" || name == "all" {
				return fmt.Errorf("blanket nolint directive is forbidden")
			}
		}
	}
	return nil
}

type lintFixture struct {
	name, source, rule string
}

func runFixtures(ctx context.Context, lint string, config []byte, goVersion string) (err error) {
	dir, err := os.MkdirTemp("", "keelbox-lint-policy-")
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, os.RemoveAll(dir)) }()
	for name, data := range map[string][]byte{
		".golangci.yml": config,
		"go.mod":        []byte("module policyfixture\n\ngo " + goVersion + "\n"),
	} {
		if err = os.WriteFile(filepath.Join(dir, name), data, 0600); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	for _, fixture := range lintFixtures() {
		if err = runFixture(ctx, lint, dir, fixture); err != nil {
			return err
		}
		fmt.Printf("Policy fixture %s: rejected by %s\n", fixture.name, fixture.rule)
	}
	return nil
}

func runFixture(ctx context.Context, lint, dir string, fixture lintFixture) (err error) {
	filename := "probe.go"
	if strings.HasSuffix(fixture.name, "-test") {
		filename = "probe_test.go"
	}
	path := filepath.Join(dir, filename)
	if err = os.WriteFile(path, []byte(fixture.source), 0600); err != nil {
		return err
	}
	defer func() { err = errors.Join(err, os.Remove(path)) }()
	if fixture.rule != "gofmt" {
		formatter := exec.CommandContext(ctx, lint, "fmt")
		formatter.Dir = dir
		formatter.Env = append(os.Environ(), "GOWORK=off")
		if output, formatErr := formatter.CombinedOutput(); formatErr != nil {
			return fmt.Errorf("format fixture %s: %w: %s", fixture.name, formatErr, output)
		}
	}
	command := exec.CommandContext(ctx, lint, "run")
	command.Dir = dir
	command.Env = append(os.Environ(), "GOWORK=off")
	output, err := command.CombinedOutput()
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if err == nil {
		return fmt.Errorf("fixture %s unexpectedly passed; %s must reject it", fixture.name, fixture.rule)
	}
	var exitErr *exec.ExitError
	if !errors.As(err, &exitErr) || !strings.Contains(string(output), "("+fixture.rule+")") {
		return fmt.Errorf("fixture %s was not rejected by %s: %w: %s", fixture.name, fixture.rule, err, output)
	}
	return nil
}

func lintFixtures() []lintFixture {
	complexitySource := "package policyfixture\n// Probe exercises complexity.\nfunc Probe(x int) int {\n"
	for i := range 22 {
		complexitySource += fmt.Sprintf("if x == %d { return %d }\n", i, i)
	}
	complexitySource += "return x\n}\n"
	return []lintFixture{
		{"ignored-error", "package policyfixture\nimport \"os\"\n// Probe exercises ignored errors.\nfunc Probe() { _ = os.Remove(\"unused\") }\n", "errcheck"},
		{"ignored-error-test", "package policyfixture\nimport (\"os\"; \"testing\")\nfunc TestProbe(t *testing.T) { _ = os.Remove(\"unused\") }\n", "errcheck"},
		{"unchecked-assertion", "package policyfixture\n// Probe exercises assertions.\nfunc Probe(value any) { _ = value.(string) }\n", "errcheck"},
		{"formatting", "package policyfixture\n// Probe exercises formatting.\nfunc Probe( ) int{return 1}\n", "gofmt"},
		{"shadowing", "package policyfixture\nimport \"os\"\n// Probe exercises shadowing.\nfunc Probe(file *os.File) error { var err error; for { _, err := file.Stat(); if err != nil { break } }; return err }\n", "govet"},
		{"complexity", complexitySource, "cyclop"},
		{"lost-cancellation", "package policyfixture\nimport (\"context\"; \"os/exec\")\n// Probe exercises inherited cancellation.\nfunc Probe(ctx context.Context) error { if err := ctx.Err(); err != nil { return err }; return exec.CommandContext(context.Background(), \"unused\").Run() }\n", "contextcheck"},
		{"static-analysis", "package policyfixture\nimport \"regexp\"\n// Probe exercises static analysis.\nfunc Probe() { regexp.MustCompile(\"[\") }\n", "staticcheck"},
		{"unused-code", "package policyfixture\nfunc hidden() {}\n", "unused"},
		{"builtin-shadowing", "package policyfixture\n// Probe exercises builtin naming.\nfunc Probe() { complex := 1; _ = complex }\n", "revive"},
		{"unexplained-suppression", "package policyfixture\nimport \"os\"\n// Probe exercises suppression explanations.\nfunc Probe() {\n//nolint:errcheck\nos.Remove(\"unused\")\n}\n", "nolintlint"},
	}
}
