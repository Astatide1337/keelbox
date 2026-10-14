package keelbox

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func (e *environment) kubeArgs(args ...string) []string {
	return append([]string{"--kubeconfig", e.kubeconfig, "--context", e.state.Context, "--namespace", e.state.Namespace}, args...)
}
func (e *environment) kubectl(ctx context.Context, args ...string) (string, error) {
	return capture(ctx, "kubectl", e.kubeArgs(args...)...)
}

func localDocker(ctx context.Context) (string, error) {
	if _, err := exec.LookPath("docker"); err != nil {
		return "", fmt.Errorf("docker is required but the docker command was not found in PATH. Install Docker Engine: https://docs.docker.com/engine/install/; then rerun this command")
	}
	if os.Getenv("DOCKER_HOST") != "" {
		return "", fmt.Errorf("unset DOCKER_HOST; this pilot requires an explicit local Docker context")
	}
	current, err := capture(ctx, "docker", "context", "show")
	if err != nil {
		return "", fmt.Errorf("cannot read the Docker context; check `docker context ls`: %w", err)
	}
	current = strings.TrimSpace(current)
	endpoint, err := capture(ctx, "docker", "context", "inspect", current, "--format", "{{.Endpoints.docker.Host}}")
	if err != nil {
		return "", fmt.Errorf("cannot inspect Docker context %q; check `docker context ls`: %w", current, err)
	}
	if !strings.HasPrefix(strings.TrimSpace(endpoint), "unix://") {
		return "", fmt.Errorf("docker context %s is not a local Unix socket", current)
	}
	if _, err = capture(ctx, "docker", "--context", current, "info", "--format", "{{.ServerVersion}}"); err != nil {
		if ctx.Err() != nil {
			return "", ctx.Err()
		}
		return "", fmt.Errorf("docker is installed but unavailable in context %q. Start Docker and ensure your user can access it; retry `docker --context %s info`. Startup help: https://docs.docker.com/engine/daemon/start/\nDetails: %w", current, current, err)
	}
	return current, nil
}
func (e *environment) kindCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := command(ctx, "kind", args...)
	cmd.Env = append(cmd.Env, "DOCKER_CONTEXT="+e.state.DockerContext, "KIND_EXPERIMENTAL_PROVIDER=docker")
	return cmd
}
func (e *environment) validateCluster(ctx context.Context) error {
	current, err := localDocker(ctx)
	if err != nil {
		return err
	}
	if current != e.state.DockerContext {
		return fmt.Errorf("docker context changed; expected %s", e.state.DockerContext)
	}
	if e.state.ContainerID == "" {
		return fmt.Errorf("owned cluster has not been created; run up")
	}
	actual, err := capture(ctx, "docker", "--context", current, "inspect", e.state.Cluster+"-control-plane", "--format", "{{.Id}}")
	if err != nil || strings.TrimSpace(actual) != e.state.ContainerID {
		return fmt.Errorf("owned cluster identity does not match; refusing Kubernetes operations")
	}
	hash, err := fileHash(e.kubeconfig)
	if err != nil {
		return err
	}
	if hash != e.state.KubeconfigHash {
		return fmt.Errorf("private kubeconfig identity changed; refusing access")
	}
	return nil
}
