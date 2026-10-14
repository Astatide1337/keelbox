package keelbox

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"gopkg.in/yaml.v3"
)

type object map[string]any

func inputDigest(c *projectConfig, objects []object) (string, error) {
	data, err := yaml.Marshal(struct {
		Config  *projectConfig
		Objects []object
	}{c, objects})
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

var allowedKinds = map[string]string{"Namespace": "v1", "ConfigMap": "v1", "Secret": "v1", "Service": "v1", "PersistentVolumeClaim": "v1", "Deployment": "apps/v1", "StatefulSet": "apps/v1", "Job": "batch/v1"}

func copyDirectory(source, dest string) error {
	return filepath.WalkDir(source, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(source, path)
		if err != nil {
			return err
		}
		if d.Name() == ".git" && d.IsDir() {
			return filepath.SkipDir
		}
		target := filepath.Join(dest, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0700)
		}
		if d.Type()&os.ModeSymlink != 0 {
			return fmt.Errorf("staged charts cannot contain symlinks: %s", path)
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0600)
	})
}
func (e *environment) renderHelm(ctx context.Context) (objects []object, err error) {
	temp, err := os.MkdirTemp(e.dir, "render-")
	if err != nil {
		return nil, err
	}
	defer func() { err = errors.Join(err, os.RemoveAll(temp)) }()
	chart := filepath.Join(temp, "apps", "chart")
	if err = copyDirectory(e.config.Helm.Chart, chart); err != nil {
		return nil, err
	}
	for _, d := range e.config.Helm.Dependencies {
		dest := resolve(chart, d.Destination)
		if !within(temp, dest) {
			return nil, fmt.Errorf("helm dependency escapes staging directory")
		}
		if err = copyDirectory(resolve(e.config.Dir, d.Source), dest); err != nil {
			return nil, err
		}
	}
	if _, err = capture(ctx, "helm", "dependency", "build", chart); err != nil {
		return nil, err
	}
	args := []string{"template", e.config.Name, chart, "--namespace", e.config.Namespace}
	for _, v := range e.config.Helm.Values {
		args = append(args, "--values", resolve(e.config.Dir, v))
	}
	rendered, err := capture(ctx, "helm", args...)
	if err != nil {
		return nil, err
	}
	return decodeObjects([]byte(rendered))
}
func (e *environment) render(ctx context.Context) ([]object, error) {
	var objects []object
	if e.config.Helm.Chart != "" {
		rendered, err := e.renderHelm(ctx)
		if err != nil {
			return nil, err
		}
		objects = append(objects, rendered...)
	}
	for _, path := range e.config.Resources {
		data, readErr := os.ReadFile(resolve(e.config.Dir, path))
		if readErr != nil {
			return nil, fmt.Errorf("manifest %s: %w", path, readErr)
		}
		extra, decodeErr := decodeObjects(data)
		if decodeErr != nil {
			return nil, fmt.Errorf("manifest %s: %w", path, decodeErr)
		}
		if len(extra) == 0 {
			return nil, fmt.Errorf("manifest %s contains no resources", path)
		}
		objects = append(objects, extra...)
	}
	if len(objects) == 0 {
		return nil, fmt.Errorf("application manifests contain no resources")
	}
	if e.config.EnvFile != "" {
		data, envErr := loadEnv(resolve(e.config.Dir, e.config.EnvFile))
		if envErr != nil {
			return nil, envErr
		}
		objects = append(objects, object{"apiVersion": "v1", "kind": "Secret", "metadata": map[string]any{"name": e.config.SecretName}, "type": "Opaque", "stringData": data})
	}
	ns := object{"apiVersion": "v1", "kind": "Namespace", "metadata": map[string]any{"name": e.config.Namespace}}
	objects = append([]object{ns}, objects...)
	seen := map[string]bool{}
	for _, o := range objects {
		resource, prepareErr := e.prepareResource(o)
		if prepareErr != nil {
			return nil, prepareErr
		}
		key := resource.Kind + "/" + resource.Name
		if seen[key] {
			return nil, fmt.Errorf("duplicate resource %s", key)
		}
		seen[key] = true
	}
	return objects, nil
}
func decodeObjects(data []byte) ([]object, error) {
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	var result []object
	for {
		var o map[string]any
		err := decoder.Decode(&o)
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
		if len(o) > 0 {
			result = append(result, object(o))
		}
	}
	return result, nil
}
func rewriteImages(value any, builds []buildSpec, images map[string]imageArtifact) error {
	switch node := value.(type) {
	case object:
		return rewriteImages(map[string]any(node), builds, images)
	case map[string]any:
		if image, ok := node["image"].(string); ok && !strings.Contains(image, "@") {
			base := image
			if i := strings.LastIndex(base, ":"); i > strings.LastIndex(base, "/") {
				base = base[:i]
			}
			for _, b := range builds {
				if base == b.Image {
					artifact, ok := images[b.Name]
					if !ok {
						return fmt.Errorf("image %s has not been built; run build or up", b.Name)
					}
					node["image"] = artifact.Tag
					node["imagePullPolicy"] = "IfNotPresent"
					break
				}
			}
		}
		for _, v := range node {
			if err := rewriteImages(v, builds, images); err != nil {
				return err
			}
		}
	case []any:
		for _, v := range node {
			if err := rewriteImages(v, builds, images); err != nil {
				return err
			}
		}
	}
	return nil
}
func loadEnv(path string) (map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	values := map[string]string{}
	keyPattern := regexpEnvKey
	for i, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if !ok || !keyPattern.MatchString(key) {
			return nil, fmt.Errorf("invalid env key at line %d (values hidden)", i+1)
		}
		if _, ok := values[key]; ok {
			return nil, fmt.Errorf("duplicate env key %s", key)
		}
		if strings.HasPrefix(value, "\"") {
			value, err = strconv.Unquote(value)
			if err != nil {
				return nil, fmt.Errorf("invalid quoted env value at line %d", i+1)
			}
		} else if strings.HasPrefix(value, "'") && strings.HasSuffix(value, "'") {
			value = value[1 : len(value)-1]
		}
		values[key] = value
	}
	return values, nil
}

func (e *environment) prepareResource(o object) (resourceRef, error) {
	resource, identityErr := objectResource(o)
	if identityErr != nil {
		return resourceRef{}, identityErr
	}
	kind, api, name := resource.Kind, resource.APIVersion, resource.Name
	if expected, ok := allowedKinds[kind]; !ok || api != expected {
		return resourceRef{}, fmt.Errorf("unsupported resource %s %s; local adaptation required", api, kind)
	}
	meta, metaErr := objectMetadata(o)
	if metaErr != nil {
		return resourceRef{}, metaErr
	}
	if name == "" || strings.ContainsAny(name, "/\n") {
		return resourceRef{}, fmt.Errorf("invalid resource name")
	}
	if kind == "Namespace" {
		if name != e.config.Namespace {
			return resourceRef{}, fmt.Errorf("namespace mismatch")
		}
	} else {
		if rawNamespace, exists := meta["namespace"]; exists {
			ns, namespaceOK := rawNamespace.(string)
			if !namespaceOK || (ns != "" && ns != e.config.Namespace) {
				return resourceRef{}, fmt.Errorf("resource %s targets an invalid or unexpected namespace", name)
			}
		}
		meta["namespace"] = e.config.Namespace
	}
	annotations, annotationsErr := metadataValues(meta, "annotations")
	if annotationsErr != nil {
		return resourceRef{}, annotationsErr
	}
	meta["annotations"] = annotations
	annotations["keelbox.dev/environment"] = e.config.ID
	labels, labelsErr := metadataValues(meta, "labels")
	if labelsErr != nil {
		return resourceRef{}, labelsErr
	}
	meta["labels"] = labels
	labels["keelbox.dev/environment"] = e.config.ID
	if err := rewriteImages(o, e.config.Build, e.state.Images); err != nil {
		return resourceRef{}, err
	}
	return resource, nil
}

// appliedImageReferences records exact desired container references, including
// registry images, so access never accepts a Pod from an older image rollout.
func appliedImageReferences(objects []object) (map[string]imageArtifact, error) {
	images := map[string]imageArtifact{}
	for _, o := range objects {
		kind, ok := o["kind"].(string)
		if !ok {
			return nil, fmt.Errorf("resource kind must be a string")
		}
		if kind != "Deployment" && kind != "StatefulSet" && kind != "Job" {
			continue
		}
		spec, ok := o["spec"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s spec must be a mapping", kind)
		}
		template, ok := spec["template"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s Pod template must be a mapping", kind)
		}
		pod, ok := template["spec"].(map[string]any)
		if !ok {
			return nil, fmt.Errorf("%s Pod spec must be a mapping", kind)
		}
		containers, ok := pod["containers"].([]any)
		if !ok || len(containers) == 0 {
			return nil, fmt.Errorf("%s needs Pod containers", kind)
		}
		for _, value := range containers {
			container, ok := value.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("%s container must be a mapping", kind)
			}
			image, ok := container["image"].(string)
			if !ok || image == "" {
				return nil, fmt.Errorf("%s container image must be a nonempty string", kind)
			}
			images[image] = imageArtifact{Tag: image}
		}
	}
	return images, nil
}
