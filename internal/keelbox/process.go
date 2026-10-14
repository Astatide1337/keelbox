package keelbox

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"strings"
)

func command(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Env = append(os.Environ(), "KUBECONFIG=/dev/null")
	return cmd
}
func capture(ctx context.Context, name string, args ...string) (string, error) {
	cmd := command(ctx, name, args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return "", fmt.Errorf("%s failed: %s: %w", name, strings.TrimSpace(string(out)), err)
	}
	return string(out), nil
}
func stream(ctx context.Context, name string, args ...string) error {
	cmd := command(ctx, name, args...)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Stdin = os.Stdin
	return cmd.Run()
}
