package keelbox

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"
)

func fileHash(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:]), nil
}
func (e *environment) ensureCluster(ctx context.Context) error {
	if e.state.ContainerID != "" {
		return e.validateCluster(ctx)
	}
	current, err := localDocker(ctx)
	if err != nil {
		return err
	}
	e.state.DockerContext = current
	exists, err := capture(ctx, "docker", "--context", current, "ps", "-a", "--filter", "name=^/"+e.state.Cluster+"-control-plane$", "--format", "{{.ID}}")
	if err != nil {
		return err
	}
	if trim(exists) != "" {
		return fmt.Errorf("cluster name is already occupied without a recorded identity; refusing adoption")
	}
	if err = e.save(); err != nil {
		return err
	}
	fmt.Println("Creating local cluster:", e.state.Cluster)
	cmd := e.kindCommand(ctx, "create", "cluster", "--name", e.state.Cluster, "--kubeconfig", e.kubeconfig, "--wait", "120s")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	runErr := cmd.Run()
	id, inspectErr := capture(context.WithoutCancel(ctx), "docker", "--context", current, "inspect", e.state.Cluster+"-control-plane", "--format", "{{.Id}}")
	if inspectErr == nil {
		e.state.ContainerID = trim(id)
		if hash, hashErr := fileHash(e.kubeconfig); hashErr == nil {
			e.state.KubeconfigHash = hash
		}
		if err = e.save(); err != nil {
			return err
		}
	}
	if runErr != nil {
		return fmt.Errorf("cluster creation interrupted/failed; completed state retained: %w", runErr)
	}
	if inspectErr != nil {
		return inspectErr
	}
	return e.validateCluster(ctx)
}
func (e *environment) up(ctx context.Context) error {
	if err := e.build(ctx, ""); err != nil {
		return err
	}
	objects, err := e.render(ctx)
	if err != nil {
		return err
	}
	appliedImages, err := appliedImageReferences(objects)
	if err != nil {
		return err
	}
	if err = e.ensureCluster(ctx); err != nil {
		return err
	}
	e.state.Up = false
	if err = e.save(); err != nil {
		return err
	}
	if err = e.loadImages(ctx); err != nil {
		return err
	}
	for _, o := range objects {
		if err = e.applyResource(ctx, o); err != nil {
			return err
		}
	}
	if err = e.reconcileResources(ctx, objects); err != nil {
		return err
	}
	targets := []string{}
	for _, target := range e.config.Workloads {
		targets = append(targets, target)
	}
	sort.Strings(targets)
	for _, target := range targets {
		fmt.Println("Waiting for", target)
		if _, err = e.kubectl(ctx, "rollout", "status", target, "--timeout=300s"); err != nil {
			e.diagnostics(context.WithoutCancel(ctx))
			return err
		}
	}
	e.state.AppliedDigest, err = inputDigest(e.config, objects)
	if err != nil {
		return err
	}
	e.state.AppliedImages = appliedImages
	e.state.Up = true
	e.state.Endpoint = e.config.Endpoint
	if err = e.save(); err != nil {
		return err
	}
	if err = e.ensureAccess(ctx); err != nil {
		return err
	}
	fmt.Printf("%s environment ready: http://localhost:%d\n", e.config.Name, e.config.Endpoint.LocalPort)
	fmt.Println("Run application tests with keelbox exec, or through localhost.")
	return nil
}
func (e *environment) observe(ctx context.Context, r resourceRef) (map[string]any, error) {
	out, err := e.kubectl(ctx, "get", strings.ToLower(r.Kind), r.Name, "--ignore-not-found", "-o", "json")
	if err != nil {
		return nil, err
	}
	if trim(out) == "" {
		return nil, nil
	}
	var o map[string]any
	err = json.Unmarshal([]byte(out), &o)
	return o, err
}
func (e *environment) diagnostics(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for _, args := range [][]string{{"get", "pods", "-o", "wide"}, {"get", "events", "--sort-by=.lastTimestamp"}} {
		out, err := e.kubectl(ctx, args...)
		if err == nil {
			fmt.Fprint(os.Stderr, out)
		}
	}
}

func (e *environment) down(ctx context.Context) error {
	if err := e.validateCluster(ctx); err != nil {
		return err
	}
	if err := e.stopAccess(); err != nil {
		return err
	}
	if err := e.stopDatabases(ctx); err != nil {
		return err
	}
	retained := []resourceRef{}
	for _, r := range e.state.Resources {
		o, err := e.observe(ctx, r)
		if err != nil {
			return err
		}
		if o == nil {
			continue
		}
		uid, uidErr := objectUID(o)
		if uidErr != nil {
			return uidErr
		}
		if uid != r.UID {
			return fmt.Errorf("%s/%s was replaced; refusing removal", r.Kind, r.Name)
		}
		if r.Kind == "Namespace" || r.Kind == "PersistentVolumeClaim" {
			retained = append(retained, r)
			continue
		}
		if r.Kind == "StatefulSet" {
			retained = append(retained, r)
			continue
		}
		if err = e.deleteOwned(ctx, r); err != nil {
			return err
		}
	}
	e.state.Resources = retained
	e.state.Up = false
	if err := e.save(); err != nil {
		return err
	}
	fmt.Println("Application down. Cluster, scaled-down database StatefulSets, namespace and PVC data retained.")
	return nil
}
func (e *environment) deleteOwned(ctx context.Context, r resourceRef) (err error) {
	plural := map[string]string{"Deployment": "deployments", "StatefulSet": "statefulsets", "ConfigMap": "configmaps", "Secret": "secrets", "Service": "services", "Job": "jobs", "PersistentVolumeClaim": "persistentvolumeclaims"}[r.Kind]
	if plural == "" {
		return fmt.Errorf("refusing unsupported deletion")
	}
	prefix := "/api/v1"
	if r.APIVersion != "v1" {
		prefix = "/apis/" + r.APIVersion
	}
	options := map[string]any{"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": map[string]string{"uid": r.UID}, "propagationPolicy": "Background"}
	path := filepath.Join(e.dir, "delete.json")
	if err = writeJSON(path, options); err != nil {
		return err
	}
	defer func() { err = errors.Join(err, os.Remove(path)) }()
	_, err = e.kubectl(ctx, "delete", "--raw", prefix+"/namespaces/"+e.state.Namespace+"/"+plural+"/"+r.Name, "-f", path)
	return err
}

// Replica changes use one Update manager, independent of manifest Apply ownership.
func applyPayload(o object) (object, any, error) {
	if o["kind"] != "Deployment" && o["kind"] != "StatefulSet" {
		return o, nil, nil
	}
	payload := object{}
	for key, value := range o {
		payload[key] = value
	}
	spec := map[string]any{}
	originalSpec, ok := o["spec"].(map[string]any)
	if !ok {
		return nil, nil, fmt.Errorf("workload spec is missing or is not an object")
	}
	for key, value := range originalSpec {
		spec[key] = value
	}
	replicas, ok := spec["replicas"]
	if !ok {
		replicas = 1
	}
	delete(spec, "replicas")
	payload["spec"] = spec
	return payload, replicas, nil
}
func (e *environment) setReplicas(ctx context.Context, r resourceRef, replicas any, version string) error {
	operations := []map[string]any{{"op": "test", "path": "/metadata/uid", "value": r.UID}}
	if version != "" {
		operations = append(operations, map[string]any{"op": "test", "path": "/metadata/resourceVersion", "value": version})
	}
	operations = append(operations, map[string]any{"op": "add", "path": "/spec/replicas", "value": replicas})
	patch, err := json.Marshal(operations)
	if err != nil {
		return err
	}
	_, err = e.kubectl(ctx, "patch", strings.ToLower(r.Kind), r.Name, "--type=json", "--field-manager=keelbox-lifecycle", "-p", string(patch))
	return err
}

func (e *environment) loadImages(ctx context.Context) error {
	if e.state.LoadedImages == nil {
		e.state.LoadedImages = map[string]string{}
	}
	for _, b := range e.config.Build {
		image := e.state.Images[b.Name]
		if e.state.LoadedImages[image.Tag] == image.ID {
			continue
		}
		fmt.Println("Loading image:", b.Name)
		cmd := e.kindCommand(ctx, "load", "docker-image", "--name", e.state.Cluster, image.Tag)
		cmd.Stdout = os.Stdout
		cmd.Stderr = os.Stderr
		if err := cmd.Run(); err != nil {
			return err
		}
		e.state.LoadedImages[image.Tag] = image.ID
		if err := e.save(); err != nil {
			return err
		}
	}
	return nil
}

func (e *environment) applyResource(ctx context.Context, o object) error {
	resource, resourceErr := objectResource(o)
	if resourceErr != nil {
		return resourceErr
	}
	existing, observeErr := e.observe(ctx, resource)
	if observeErr != nil {
		return observeErr
	}
	if ownershipErr := e.checkResourceOwnership(existing, resource); ownershipErr != nil {
		return ownershipErr
	}
	payload, replicas, payloadErr := applyPayload(o)
	if payloadErr != nil {
		return payloadErr
	}
	data, marshalErr := yaml.Marshal(payload)
	if marshalErr != nil {
		return marshalErr
	}
	path := filepath.Join(e.dir, "apply.yaml")
	if err := os.WriteFile(path, data, 0600); err != nil {
		return err
	}
	_, err := e.kubectl(ctx, "apply", "--server-side", "--field-manager=keelbox", "-f", path)
	err = errors.Join(err, os.Remove(path))
	if err != nil {
		if resource.Kind == "Secret" {
			return fmt.Errorf("local Secret apply failed (details hidden)")
		}
		return err
	}
	actual, actualErr := e.observe(ctx, resource)
	if actualErr != nil {
		return actualErr
	}
	if actual == nil {
		return fmt.Errorf("resource disappeared during apply")
	}
	resource.UID, err = objectUID(actual)
	if err != nil {
		return err
	}
	found := false
	for i, r := range e.state.Resources {
		if r.Kind == resource.Kind && r.Name == resource.Name {
			e.state.Resources[i] = resource
			found = true
		}
	}
	if !found {
		e.state.Resources = append(e.state.Resources, resource)
	}
	if err = e.save(); err != nil {
		return err
	}
	if replicas != nil {
		if err = e.setReplicas(ctx, resource, replicas, ""); err != nil {
			return err
		}
	}
	return nil
}

func (e *environment) stopDatabases(ctx context.Context) error {
	// Stop retained databases before removing Services or mounted configuration.
	for _, r := range e.state.Resources {
		if r.Kind != "StatefulSet" {
			continue
		}
		actual, err := e.observe(ctx, r)
		if err != nil {
			return err
		}
		if actual == nil {
			continue
		}
		if err = e.verifyRecordedResource(actual, r); err != nil {
			return err
		}
		if err = safeStatefulRetention(actual); err != nil {
			return err
		}
		if err = e.stopRetainedStatefulSet(ctx, r); err != nil {
			return err
		}
	}
	return nil
}

func (e *environment) checkResourceOwnership(existing map[string]any, resource resourceRef) error {
	if existing != nil {
		meta, metaErr := objectMetadata(existing)
		if metaErr != nil {
			return metaErr
		}
		annotations, annotationsOK := meta["annotations"].(map[string]any)
		if !annotationsOK {
			return fmt.Errorf("refusing to overwrite unowned %s/%s", resource.Kind, resource.Name)
		}
		for _, recorded := range e.state.Resources {
			if recorded.Kind == resource.Kind && recorded.Name == resource.Name && meta["uid"] != recorded.UID {
				return fmt.Errorf("%s/%s was replaced; refusing adoption", resource.Kind, resource.Name)
			}
		}
		if annotations["keelbox.dev/environment"] != e.state.ID {
			return fmt.Errorf("refusing to overwrite unowned %s/%s", resource.Kind, resource.Name)
		}
	}
	return nil
}

func (e *environment) removeEnvironment(ctx context.Context) error {
	if err := e.validateCluster(ctx); err != nil {
		return err
	}
	if err := e.stopAccess(); err != nil {
		return err
	}
	fmt.Println("Removing owned cluster and its local database data:", e.state.Cluster)
	cmd := e.kindCommand(ctx, "delete", "cluster", "--name", e.state.Cluster)
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	if err := cmd.Run(); err != nil {
		return err
	}
	e.state.ContainerID = ""
	e.state.KubeconfigHash = ""
	e.state.Resources = nil
	e.state.LoadedImages = map[string]string{}
	e.state.Up = false
	removeErr := os.Remove(e.kubeconfig)
	if os.IsNotExist(removeErr) {
		removeErr = nil
	}
	return errors.Join(e.save(), removeErr)
}
