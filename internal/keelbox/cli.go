package keelbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"sort"
	"strings"
)

// Run executes a Keelbox command with cancellation scoped to the caller.
func Run(ctx context.Context, args []string) (err error) {
	if len(args) == 3 && args[0] == "--access-helper" {
		return accessHelper(ctx, args[1], args[2])
	}
	configPath, detached, volumes, rest, err := parseOptions(args)
	if err != nil {
		return err
	}
	if len(rest) == 0 || rest[0] == "help" || rest[0] == "--help" {
		fmt.Println("Keelbox — local Kubernetes development (Linux pilot)")
		fmt.Println("Usage: keelbox <command> --config <keelbox.yaml>")
		fmt.Println("Commands: doctor, config, build [image], up [-d], ps, logs [-f] <workload>, exec [-it] <workload> -- <command>, down, env rm --volumes")
		return nil
	}
	if rest[0] == "doctor" {
		return runDoctor(ctx, configPath, args)
	}
	c, err := loadConfig(configPath)
	if err != nil {
		return err
	}
	if rest[0] == "config" {
		return printConfig(c)
	}
	e, err := openEnvironment(c)
	if err != nil {
		return err
	}
	defer func() { err = errors.Join(err, e.close()) }()
	switch rest[0] {
	case "build":
		only := ""
		if len(rest) > 1 {
			only = rest[1]
		}
		return e.build(ctx, only)
	case "up":
		return e.start(ctx, detached)
	case "ps":
		return e.status(ctx)
	case "logs", "exec":
		return e.workloadCommand(ctx, rest)
	case "down":
		if volumes {
			return fmt.Errorf("use env rm --volumes for explicit full data removal; down preserves data")
		}
		return e.down(ctx)
	case "env":
		return e.environmentCommand(ctx, rest, volumes)
	default:
		return fmt.Errorf("unknown command %q", rest[0])
	}
}

func printConfig(c *projectConfig) error {
	safe := *c
	safe.Path = ""
	safe.Dir = ""
	safe.ID = ""
	data, err := json.MarshalIndent(safe, "", "  ")
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	return nil
}
func doctor(ctx context.Context, c *projectConfig) error {
	dockerContext, err := localDocker(ctx)
	if err != nil {
		return err
	}
	fmt.Println("Local Docker context:", dockerContext)
	tools := []string{"kind", "kubectl"}
	if c != nil && c.Helm.Chart != "" {
		tools = append(tools, "helm")
	}
	for _, name := range tools {
		path, err := exec.LookPath(name)
		if err != nil {
			return fmt.Errorf("missing %s: install it or add its directory to PATH", name)
		}
		fmt.Println(name+":", path)
	}
	if c == nil {
		fmt.Println("No keelbox.yaml found; machine prerequisites passed. Run doctor from a configured project for project diagnostics. No cluster was created.")
		return nil
	}
	fmt.Printf("Project: %s; namespace: %s; configuration: %s\n", c.Name, c.Namespace, c.Path)
	for _, b := range c.Build {
		fmt.Printf("Build %s: %s\n", b.Name, b.Context)
	}
	for _, name := range sortedWorkloads(c) {
		fmt.Printf("Workload %s: %s\n", name, c.Workloads[name])
	}
	fmt.Printf("Declared endpoint: http://localhost:%d → service/%s:%d\n", c.Endpoint.LocalPort, c.Endpoint.Service, c.Endpoint.Port)
	fmt.Println("Project configuration and machine prerequisites passed. Workload readiness, localhost access, and application behavior were not checked. No cluster was created.")
	return nil
}

// Missing default configuration is useful for machine diagnostics; an explicit path
// and present configuration remain contracts and must not be silently ignored.
func runDoctor(ctx context.Context, path string, args []string) error {
	explicit := false
	for _, arg := range args {
		if arg == "--" {
			break
		}
		if arg == "--config" {
			explicit = true
			break
		}
	}
	if _, err := os.Lstat(path); errors.Is(err, os.ErrNotExist) && !explicit {
		return doctor(ctx, nil)
	}
	c, err := loadConfig(path)
	if err != nil {
		return fmt.Errorf("cannot diagnose project configuration %q; correct the file or run doctor outside this project for machine checks: %w", path, err)
	}
	return doctor(ctx, c)
}
func sortedWorkloads(c *projectConfig) []string {
	keys := []string{}
	for k := range c.Workloads {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}
func parseOptions(args []string) (string, bool, bool, []string, error) {
	configPath := "keelbox.yaml"
	detached := false
	volumes := false
	rest := []string{}
	for i := 0; i < len(args); i++ {
		if args[i] == "--" {
			rest = append(rest, args[i:]...)
			break
		}
		switch args[i] {
		case "--config":
			i++
			if i >= len(args) {
				return "", false, false, nil, fmt.Errorf("--config needs a path")
			}
			configPath = args[i]
		case "-d", "--detach":
			detached = true
		case "--volumes":
			volumes = true
		default:
			rest = append(rest, args[i])
		}
	}
	return configPath, detached, volumes, rest, nil
}

func (e *environment) status(ctx context.Context) error {
	if err := e.validateCluster(ctx); err != nil {
		return err
	}
	out, statusErr := e.kubectl(ctx, "get", "deployments,statefulsets,pods,services,pvc", "-o", "wide")
	if statusErr != nil {
		return statusErr
	}
	fmt.Print(out)
	h, helperErr := readHelper(e.dir)
	fmt.Printf("Cluster: %s; namespace: %s; localhost access: %t\n", e.state.Cluster, e.state.Namespace, helperErr == nil && helperMatches(e.dir, h) && h.Ready)
	return nil
}

func (e *environment) workloadCommand(ctx context.Context, rest []string) error {
	if err := e.validateCluster(ctx); err != nil {
		return err
	}
	follow := false
	interactive := false
	position := 1
	for position < len(rest) && strings.HasPrefix(rest[position], "-") {
		switch rest[position] {
		case "-f", "--follow":
			follow = true
		case "-it":
			interactive = true
		default:
			return fmt.Errorf("unsupported option %s", rest[position])
		}
		position++
	}
	if position >= len(rest) {
		return fmt.Errorf("workload name required")
	}
	target, ok := e.config.Workloads[rest[position]]
	if !ok {
		return fmt.Errorf("unknown workload")
	}
	position++
	if rest[0] == "logs" {
		a := []string{"logs", target, "--all-containers=true", "--prefix=true"}
		if follow {
			a = append(a, "--follow")
		}
		return stream(ctx, "kubectl", e.kubeArgs(a...)...)
	}
	if position < len(rest) && rest[position] == "--" {
		position++
	}
	if position >= len(rest) {
		return fmt.Errorf("exec command required")
	}
	out, replicasErr := e.kubectl(ctx, "get", target, "-o", "jsonpath={.status.replicas}")
	if replicasErr != nil {
		return replicasErr
	}
	if trim(out) != "1" {
		return fmt.Errorf("exec requires a workload with exactly one replica in this pilot")
	}
	execArgs := []string{"exec"}
	if interactive {
		execArgs = append(execArgs, "-it")
	}
	execArgs = append(execArgs, target, "--")
	return stream(ctx, "kubectl", e.kubeArgs(append(execArgs, rest[position:]...)...)...)
}

func (e *environment) environmentCommand(ctx context.Context, rest []string, volumes bool) error {
	if len(rest) != 2 || rest[1] != "rm" {
		return fmt.Errorf("supported environment operation: env rm --volumes")
	}
	if !volumes {
		return fmt.Errorf("environment removal destroys database data; specify --volumes explicitly")
	}
	return e.removeEnvironment(ctx)
}

func (e *environment) start(ctx context.Context, detached bool) error {
	if err := e.up(ctx); err != nil {
		return fmt.Errorf("startup did not complete; accepted resources and data are retained. Correct the reported problem and retry up -d; use ps to observe a created environment: %w", err)
	}
	if !detached {
		fmt.Println("Attached; Ctrl+C leaves application and access running. Use down to stop.")
		return stream(ctx, "kubectl", e.kubeArgs("logs", e.config.Workloads[sortedWorkloads(e.config)[0]], "--all-containers=true", "--follow")...)
	}
	return nil
}
