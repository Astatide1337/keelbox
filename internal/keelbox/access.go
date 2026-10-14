package keelbox

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
)

type accessHelperState struct {
	PID         int
	Token       string
	Ready       bool
	Error       string
	Endpoint    endpointSpec
	InputDigest string
}

func (e *environment) accessTarget(ctx context.Context) (string, int, error) {
	serviceJSON, err := e.kubectl(ctx, "get", "service", e.state.Endpoint.Service, "-o", "json")
	if err != nil {
		return "", 0, err
	}
	var service struct {
		Spec struct {
			Selector map[string]string
			Ports    []struct {
				Port       int
				TargetPort any
				Protocol   string
			}
		}
	}
	if err = json.Unmarshal([]byte(serviceJSON), &service); err != nil {
		return "", 0, err
	}
	selector := []string{}
	for key, value := range service.Spec.Selector {
		selector = append(selector, key+"="+value)
	}
	if len(selector) == 0 {
		return "", 0, fmt.Errorf("endpoint Service needs a Pod selector")
	}
	sort.Strings(selector)
	var target any
	for _, port := range service.Spec.Ports {
		if port.Port == e.state.Endpoint.Port && (port.Protocol == "TCP" || port.Protocol == "") {
			target = port.TargetPort
		}
	}
	if target == nil {
		return "", 0, fmt.Errorf("endpoint Service has no configured TCP port")
	}
	podsJSON, err := e.kubectl(ctx, "get", "pods", "-l", strings.Join(selector, ","), "-o", "json")
	if err != nil {
		return "", 0, err
	}
	var pods struct{ Items []endpointPod }
	if err = json.Unmarshal([]byte(podsJSON), &pods); err != nil {
		return "", 0, err
	}
	return selectEndpointPod(pods.Items, target, e.state.AppliedImages)
}

func appliedImagesMatch(containers []string, applied map[string]imageArtifact) bool {
	if len(containers) == 0 {
		return false
	}
	tags := map[string]bool{}
	for _, image := range applied {
		tags[image.Tag] = true
	}
	for _, image := range containers {
		if !tags[image] {
			return false
		}
	}
	return true
}

func helperPath(dir string) string { return filepath.Join(dir, "access.json") }
func readHelper(dir string) (accessHelperState, error) {
	var h accessHelperState
	data, err := os.ReadFile(helperPath(dir))
	if err == nil {
		err = json.Unmarshal(data, &h)
	}
	return h, err
}
func helperMatches(dir string, h accessHelperState) bool {
	if h.PID < 2 || h.Token == "" {
		return false
	}
	data, err := os.ReadFile(fmt.Sprintf("/proc/%d/cmdline", h.PID))
	if err != nil {
		return false
	}
	args := strings.Split(string(data), "\x00")
	return len(args) >= 4 && args[1] == "--access-helper" && args[2] == dir && args[3] == h.Token
}
func (e *environment) stopAccess() error {
	h, err := readHelper(e.dir)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	return e.stopHelper(h)
}

func (e *environment) stopHelper(h accessHelperState) error {
	var err error
	if helperMatches(e.dir, h) {
		if err = syscall.Kill(h.PID, syscall.SIGTERM); err != nil && !errors.Is(err, syscall.ESRCH) {
			return err
		}
		deadline := time.Now().Add(10 * time.Second)
		for helperMatches(e.dir, h) && time.Now().Before(deadline) {
			time.Sleep(100 * time.Millisecond)
		}
		if helperMatches(e.dir, h) {
			return fmt.Errorf("access helper did not stop; refusing lifecycle change")
		}
	}
	recorded, readErr := readHelper(e.dir)
	if os.IsNotExist(readErr) {
		return nil
	}
	if readErr != nil {
		return readErr
	}
	if recorded.PID != h.PID || recorded.Token != h.Token {
		return fmt.Errorf("access helper identity changed during stop; refusing removal")
	}
	return os.Remove(helperPath(e.dir))
}
func (e *environment) ensureAccess(ctx context.Context) (err error) {
	h, err := readHelper(e.dir)
	if err == nil && e.accessIsCurrent(h) {
		return nil
	}
	if err == nil && helperMatches(e.dir, h) {
		if err = e.stopAccess(); err != nil {
			return err
		}
	}
	cmd, token, err := e.startAccessHelper()
	if err != nil {
		return err
	}
	return e.waitForAccess(ctx, cmd, token)
}

func (e *environment) accessIsCurrent(h accessHelperState) bool {
	return helperMatches(e.dir, h) && h.Ready && h.Endpoint == e.state.Endpoint && h.InputDigest == e.state.AppliedDigest
}
func accessHelper(ctx context.Context, dir, token string) (err error) {
	data, err := os.ReadFile(filepath.Join(dir, "state.json"))
	if err != nil {
		return err
	}
	e := &environment{dir: dir, kubeconfig: filepath.Join(dir, "kubeconfig")}
	if err = json.Unmarshal(data, &e.state); err != nil {
		return err
	}
	h := accessHelperState{PID: os.Getpid(), Token: token, Endpoint: e.state.Endpoint, InputDigest: e.state.AppliedDigest}
	defer func() {
		h.Ready = false
		err = errors.Join(err, writeJSON(helperPath(dir), h))
	}()
	if err = writeJSON(helperPath(dir), h); err != nil {
		return err
	}
	for ctx.Err() == nil {
		if err = e.validateCluster(ctx); err != nil {
			h.Error = err.Error()
			return errors.Join(err, writeJSON(helperPath(dir), h))
		}
		h.Ready = false
		h.Error = ""
		if err = writeJSON(helperPath(dir), h); err != nil {
			return err
		}
		pod, port, targetErr := e.accessTarget(ctx)
		if targetErr != nil {
			fmt.Fprintln(os.Stderr, targetErr)
			select {
			case <-ctx.Done():
				return nil
			case <-time.After(time.Second):
				continue
			}
		}
		if err = e.forwardAccess(ctx, pod, port, &h); err != nil {
			return err
		}
		h.Ready = false
		if err = writeJSON(helperPath(dir), h); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-time.After(time.Second):
		}
	}
	return nil
}

func (e *environment) forwardAccess(ctx context.Context, pod string, port int, h *accessHelperState) error {
	forwardCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	cmd := command(forwardCtx, "kubectl", e.kubeArgs("port-forward", "--address=127.0.0.1", "pod/"+pod, fmt.Sprintf("%d:%d", e.state.Endpoint.LocalPort, port))...)
	out, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err = cmd.Start(); err != nil {
		return err
	}
	scanner := bufio.NewScanner(out)
	for scanner.Scan() {
		line := scanner.Text()
		fmt.Println(line)
		if strings.HasPrefix(line, "Forwarding from 127.0.0.1:") {
			h.Ready = true
			if err = writeJSON(helperPath(e.dir), h); err != nil {
				cancel()
				return errors.Join(err, cmd.Wait())
			}
		}
	}
	if scanner.Err() != nil {
		cancel()
	}
	if waitErr := cmd.Wait(); waitErr != nil && ctx.Err() == nil {
		// Pod replacement and connection loss are retried by the access helper.
		fmt.Fprintln(os.Stderr, "port-forward exited:", waitErr)
	}
	return scanner.Err()
}

type endpointPod struct {
	Metadata struct {
		Name              string
		DeletionTimestamp *string
	}
	Status struct {
		Phase      string
		Conditions []struct {
			Type   string
			Status string
		}
	}
	Spec struct {
		Containers []struct {
			Image string
			Ports []struct {
				Name          string
				ContainerPort int
			}
		}
	}
}

func selectEndpointPod(pods []endpointPod, target any, applied map[string]imageArtifact) (string, int, error) {
	for _, pod := range pods {
		if pod.Metadata.DeletionTimestamp != nil || pod.Status.Phase != "Running" {
			continue
		}
		ready := false
		for _, condition := range pod.Status.Conditions {
			if condition.Type == "Ready" && condition.Status == "True" {
				ready = true
			}
		}
		if !ready {
			continue
		}
		containerImages := []string{}
		for _, container := range pod.Spec.Containers {
			containerImages = append(containerImages, container.Image)
		}
		if !appliedImagesMatch(containerImages, applied) {
			continue
		}
		if number, ok := target.(float64); ok {
			return pod.Metadata.Name, int(number), nil
		}
		if name, ok := target.(string); ok {
			for _, container := range pod.Spec.Containers {
				for _, port := range container.Ports {
					if port.Name == name {
						return pod.Metadata.Name, port.ContainerPort, nil
					}
				}
			}
		}
	}
	return "", 0, fmt.Errorf("waiting for a ready endpoint Pod with the applied image")
}

func (e *environment) startAccessHelper() (cmd *exec.Cmd, token string, err error) {
	tokenBytes := make([]byte, 16)
	if _, err = rand.Read(tokenBytes); err != nil {
		return nil, "", err
	}
	token = hex.EncodeToString(tokenBytes)
	exe, err := os.Executable()
	if err != nil {
		return nil, "", err
	}
	log, err := os.OpenFile(filepath.Join(e.dir, "access.log"), os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return nil, "", err
	}
	defer func() {
		closeErr := log.Close()
		if closeErr != nil && cmd != nil && cmd.Process != nil {
			closeErr = errors.Join(closeErr, terminateLaunchedHelper(cmd))
		}
		err = errors.Join(err, closeErr)
	}()
	cmd = exec.Command(exe, "--access-helper", e.dir, token)
	cmd.Stdout = log
	cmd.Stderr = log
	cmd.Env = os.Environ()
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err = cmd.Start(); err != nil {
		return nil, "", err
	}
	return cmd, token, nil
}

// The helper starts a private session. Keep its leader unreaped until group
// cleanup finishes, so the process-group ID cannot be reused while signaling.
func terminateLaunchedHelper(cmd *exec.Cmd) error {
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.Setsid {
		return fmt.Errorf("refusing to terminate a helper without an owned process group")
	}
	termErr := syscall.Kill(-cmd.Process.Pid, syscall.SIGTERM)
	if errors.Is(termErr, syscall.ESRCH) {
		termErr = nil
	}
	// Give the helper a bounded chance to cancel and wait for kubectl itself.
	// A forced group stop also covers a crashed helper or an unresponsive child.
	time.Sleep(300 * time.Millisecond)
	killErr := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
	if errors.Is(killErr, syscall.ESRCH) {
		killErr = nil
	}
	waitErr := cmd.Wait()
	var exitErr *exec.ExitError
	if errors.As(waitErr, &exitErr) {
		waitErr = nil // Termination is the requested outcome.
	}
	return errors.Join(termErr, killErr, waitErr)
}

func (e *environment) cleanupLaunchedAccess(cmd *exec.Cmd, h accessHelperState) error {
	if err := terminateLaunchedHelper(cmd); err != nil {
		return err
	}
	return e.stopHelper(h)
}

func (e *environment) waitForAccess(ctx context.Context, cmd *exec.Cmd, token string) (err error) {
	pid := cmd.Process.Pid
	started := accessHelperState{PID: pid, Token: token}
	detached := false
	defer func() {
		if !detached {
			err = errors.Join(err, e.cleanupLaunchedAccess(cmd, started))
		}
	}()
	deadline := time.NewTimer(45 * time.Second)
	defer deadline.Stop()
	ticker := time.NewTicker(200 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-deadline.C:
			return fmt.Errorf("localhost access did not start; see %s", filepath.Join(e.dir, "access.log"))
		case <-ticker.C:
			h, helperErr := readHelper(e.dir)
			if helperErr == nil && h.PID == pid && h.Token == token && helperMatches(e.dir, h) && h.Ready {
				if err = cmd.Process.Release(); err != nil {
					return err
				}
				detached = true
				return nil
			}
			if helperErr == nil && h.PID == pid && h.Token == token && h.Error != "" {
				return fmt.Errorf("access helper: %s", h.Error)
			}
		}
	}
}
