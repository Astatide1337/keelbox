package keelbox

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"
)

func TestMain(m *testing.M) {
	if os.Getenv("KEELBOX_TEST_HELPER") == "1" && len(os.Args) == 4 && os.Args[1] == "--access-helper" {
		if os.Getenv("KEELBOX_TEST_DESCENDANT") == "1" {
			signal.Ignore(syscall.SIGTERM)
			child := exec.Command("/bin/sh", "-c", "trap '' TERM; echo $$ > \"$1\"; exec /bin/sleep 60", "helper", filepath.Join(os.Args[2], "child.pid"))
			if err := child.Start(); err != nil {
				os.Exit(2)
			}
			if err := child.Wait(); err != nil {
				os.Exit(3)
			}
		}
		// This child deliberately never writes access.json: cancellation can arrive
		// after launch and before the real helper registers its state.
		time.Sleep(time.Minute)
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestStopHelperBeforeStateRegistration(t *testing.T) {
	e := &environment{dir: t.TempDir()}
	cmd := unregisteredTestHelper(t, e.dir)
	h := accessHelperState{PID: cmd.Process.Pid, Token: "test-token"}
	if err := e.cleanupLaunchedAccess(cmd, h); err != nil {
		t.Fatal(err)
	}
	if cmd.ProcessState == nil || helperMatches(e.dir, h) {
		t.Fatal("unregistered helper was not terminated and reaped")
	}
}

func TestCanceledAccessStartupReapsUnregisteredHelper(t *testing.T) {
	e := &environment{dir: t.TempDir()}
	cmd := unregisteredTestHelper(t, e.dir)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err := e.waitForAccess(ctx, cmd, "test-token"); !errors.Is(err, context.Canceled) {
		t.Fatalf("startup cancellation was lost: %v", err)
	}
	if cmd.ProcessState == nil {
		t.Fatal("canceled startup left the launched helper unreaped")
	}
}

func unregisteredTestHelper(t *testing.T, dir string) *exec.Cmd {
	t.Helper()
	t.Setenv("KEELBOX_TEST_HELPER", "1")
	cmd := exec.Command(os.Args[0], "--access-helper", dir, "test-token")
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if cmd.ProcessState == nil {
			if err := terminateLaunchedHelper(cmd); err != nil {
				t.Errorf("helper cleanup failed: %v", err)
			}
		}
	})
	return cmd
}

func TestStartupCleanupStopsUnresponsiveDescendant(t *testing.T) {
	e := &environment{dir: t.TempDir()}
	t.Setenv("KEELBOX_TEST_DESCENDANT", "1")
	cmd := unregisteredTestHelper(t, e.dir)
	deadline := time.Now().Add(3 * time.Second)
	var childPID int
	for childPID == 0 {
		data, readErr := os.ReadFile(filepath.Join(e.dir, "child.pid"))
		if readErr == nil {
			var parseErr error
			childPID, parseErr = strconv.Atoi(strings.TrimSpace(string(data)))
			if parseErr != nil {
				t.Fatal(parseErr)
			}
		}
		if time.Now().After(deadline) {
			t.Fatal("helper descendant did not start")
		}
		time.Sleep(10 * time.Millisecond)
	}
	if err := e.cleanupLaunchedAccess(cmd, accessHelperState{PID: cmd.Process.Pid, Token: "test-token"}); err != nil {
		t.Fatal(err)
	}
	stat, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", childPID))
	// The process can disappear after procfs opens its entry but before reading it.
	if os.IsNotExist(err) || errors.Is(err, syscall.ESRCH) {
		return
	}
	if err != nil {
		t.Fatal(err)
	}
	fields := strings.Fields(string(stat)[strings.LastIndex(string(stat), ")")+1:])
	if len(fields) == 0 || (fields[0] != "Z" && fields[0] != "X") {
		t.Fatal("helper descendant was left running")
	}
}
