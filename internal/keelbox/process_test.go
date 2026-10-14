package keelbox

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestCaptureHonorsCallerCancellation(t *testing.T) {
	path := filepath.Join(t.TempDir(), "unexpected-start")
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	_, err := capture(ctx, "/bin/sh", "-c", `touch "$1"`, "probe", path)
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("expected caller cancellation, got %v", err)
	}
	if _, err = os.Stat(path); !os.IsNotExist(err) {
		t.Fatalf("canceled subprocess must not start: %v", err)
	}
}
