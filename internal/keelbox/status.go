package keelbox

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"strings"
	"time"
)

type workloadObservation struct {
	APIVersion string
	Kind       string
	Metadata   struct {
		Name, UID   string
		Generation  *int64
		Annotations map[string]string
	}
	Spec   struct{ Replicas *int64 }
	Status struct {
		ObservedGeneration *int64
		Replicas           int64
		ReadyReplicas      int64
		UpdatedReplicas    int64
		AvailableReplicas  int64
		Conditions         []struct{ Type, Status, Reason, Message string }
	}
}

func (e *environment) status(ctx context.Context) error {
	if err := e.validateCluster(ctx); err != nil {
		return err
	}
	fmt.Printf("Cluster: %s; namespace: %s\n", e.state.Cluster, e.state.Namespace)
	fmt.Println("WORKLOAD\tKUBERNETES RESOURCE\tREADY/DESIRED\tSTATUS")
	var observationErr error
	for _, name := range sortedWorkloads(e.config) {
		if err := e.workloadStatus(ctx, name); err != nil {
			observationErr = errors.Join(observationErr, err)
		}
	}
	if e.state.Up {
		fmt.Println("Last startup: completed workload rollout; this is not evidence that current repository changes were applied.")
	} else {
		fmt.Println("Last startup: not recorded as complete (not started, down, or interrupted). Retry up -d to reconcile the project.")
	}
	fmt.Println("Localhost access:", e.accessStatus(ctx))
	fmt.Println("Application verification: not performed; run the application's own tests.")
	return observationErr
}

func (e *environment) workloadStatus(ctx context.Context, name string) error {
	target := e.config.Workloads[name]
	kind, resourceName, _ := strings.Cut(target, "/")
	ref := resourceRef{APIVersion: "apps/v1", Kind: "Deployment", Name: resourceName}
	if kind == "statefulset" {
		ref.Kind = "StatefulSet"
	}
	actual, err := e.observe(ctx, ref)
	if err == nil && actual == nil {
		err = fmt.Errorf("resource is missing; run up -d to recreate it")
	}
	if err == nil {
		err = e.checkStatusIdentity(actual, ref)
	}
	if err != nil {
		fmt.Printf("%s\t%s\tunknown\tobservation failed: %v\n", name, target, err)
		return fmt.Errorf("observe workload %s: %w", name, err)
	}
	data, err := json.Marshal(actual)
	if err != nil {
		return err
	}
	ready, status, err := summarizeWorkload(data)
	if err != nil {
		fmt.Printf("%s\t%s\tunknown\tinvalid observation: %v\n", name, target, err)
		return fmt.Errorf("observe workload %s: %w", name, err)
	}
	fmt.Printf("%s\t%s\t%s\t%s\n", name, target, ready, status)
	return nil
}

func (e *environment) checkStatusIdentity(actual map[string]any, ref resourceRef) error {
	observed, err := objectResource(actual)
	if err != nil {
		return err
	}
	if observed.APIVersion != ref.APIVersion || observed.Kind != ref.Kind || observed.Name != ref.Name {
		return fmt.Errorf("unexpected Kubernetes resource identity")
	}
	for _, recorded := range e.state.Resources {
		if recorded.Kind == ref.Kind && recorded.Name == ref.Name {
			if recorded.UID == "" {
				return fmt.Errorf("resource has no recorded UID; run up -d to complete startup")
			}
			return e.checkResourceOwnership(actual, ref)
		}
	}
	return fmt.Errorf("resource has no recorded ownership; run up -d to complete startup")
}

func summarizeWorkload(data []byte) (string, string, error) {
	var workload workloadObservation
	if err := json.Unmarshal(data, &workload); err != nil {
		return "", "", fmt.Errorf("invalid workload status: %w", err)
	}
	desired := workload.Spec.Replicas
	status := workload.Status
	if desired == nil || *desired < 0 || status.Replicas < 0 || status.ReadyReplicas < 0 || status.UpdatedReplicas < 0 || status.AvailableReplicas < 0 {
		return "", "", fmt.Errorf("missing or invalid replica counts")
	}
	counts := fmt.Sprintf("%d/%d", status.ReadyReplicas, *desired)
	if workload.Metadata.Generation == nil || status.ObservedGeneration == nil || *workload.Metadata.Generation < 1 || *status.ObservedGeneration < *workload.Metadata.Generation {
		return counts, "unknown: controller has not observed the current generation", nil
	}
	if failure := workload.controllerFailure(); failure != "" {
		return counts, "unavailable: " + failure, nil
	}
	if *desired == 0 {
		if workload.hasObservedReplicas() {
			return counts, "scaling down: observed replicas remain", nil
		}
		return counts, "scaled to zero", nil
	}
	if status.ReadyReplicas < *desired || status.UpdatedReplicas < *desired || (workload.Kind == "Deployment" && status.AvailableReplicas < *desired) {
		return counts, "not ready: waiting for ready, updated replicas", nil
	}
	return counts, "ready (Kubernetes workload)", nil
}

func (workload workloadObservation) hasObservedReplicas() bool {
	status := workload.Status
	return status.Replicas != 0 || status.ReadyReplicas != 0 || status.UpdatedReplicas != 0 || status.AvailableReplicas != 0
}

func (workload workloadObservation) controllerFailure() string {
	for _, condition := range workload.Status.Conditions {
		if (condition.Type == "ReplicaFailure" && condition.Status == "True") || ((condition.Type == "Progressing" || condition.Type == "Available") && condition.Status == "False") {
			return strings.TrimSpace(condition.Type + ": " + condition.Reason + " " + condition.Message)
		}
	}
	return ""
}

func (e *environment) accessStatus(ctx context.Context) string {
	helper, err := readHelper(e.dir)
	if errors.Is(err, os.ErrNotExist) {
		return "unavailable: no access helper recorded"
	}
	if err != nil {
		return "unknown: cannot read access helper state: " + err.Error()
	}
	if !helperMatches(e.dir, helper) {
		return "unavailable: recorded access helper is not running"
	}
	if helper.Endpoint != e.state.Endpoint || helper.InputDigest != e.state.AppliedDigest {
		return "unavailable: helper does not match the applied endpoint or inputs"
	}
	if !helper.Ready {
		return "unavailable: " + helper.Error
	}
	dialer := net.Dialer{Timeout: time.Second}
	address := fmt.Sprintf("127.0.0.1:%d", helper.Endpoint.LocalPort)
	conn, err := dialer.DialContext(ctx, "tcp", address)
	if err != nil {
		return "unavailable: localhost listener could not be reached: " + err.Error()
	}
	if err = conn.Close(); err != nil {
		return "unknown: closing localhost probe: " + err.Error()
	}
	return "localhost listener reachable at http://" + address + " (application behavior not verified)"
}
