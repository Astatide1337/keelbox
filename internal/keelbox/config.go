package keelbox

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"gopkg.in/yaml.v3"
)

type buildSpec struct {
	Name       string `yaml:"name"`
	Context    string `yaml:"context"`
	Dockerfile string `yaml:"dockerfile"`
	Target     string `yaml:"target,omitempty"`
	Image      string `yaml:"image"`
}
type stagedDependency struct {
	Source      string `yaml:"source"`
	Destination string `yaml:"destination"`
}
type helmSpec struct {
	Chart        string             `yaml:"chart"`
	Values       []string           `yaml:"values"`
	Dependencies []stagedDependency `yaml:"dependencies"`
}
type endpointSpec struct {
	Service   string `yaml:"service"`
	Port      int    `yaml:"port"`
	LocalPort int    `yaml:"localPort"`
}
type projectConfig struct {
	Version    int               `yaml:"version"`
	Name       string            `yaml:"name"`
	Project    string            `yaml:"project"`
	Namespace  string            `yaml:"namespace"`
	Helm       helmSpec          `yaml:"helm"`
	Resources  []string          `yaml:"resources"`
	EnvFile    string            `yaml:"envFile"`
	SecretName string            `yaml:"secretName"`
	Build      []buildSpec       `yaml:"build"`
	Workloads  map[string]string `yaml:"workloads"`
	Endpoint   endpointSpec      `yaml:"endpoint"`
	Path       string            `yaml:"-"`
	Dir        string            `yaml:"-"`
	ID         string            `yaml:"-"`
}

var dnsName = regexp.MustCompile(`^[a-z][a-z0-9-]{0,39}$`)
var regexpEnvKey = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

func trim(s string) string { return strings.TrimSpace(s) }

func loadConfig(path string) (*projectConfig, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, err
	}
	absolute, err = filepath.EvalSymlinks(absolute)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(absolute)
	if err != nil {
		return nil, err
	}
	c, err := decodeConfig(data)
	if err != nil {
		return nil, err
	}
	c.Path = absolute
	c.Dir = filepath.Dir(absolute)
	if c.Project == "" {
		return nil, fmt.Errorf("project source directory is required")
	}
	c.Project = resolve(c.Dir, c.Project)
	if info, e := os.Stat(c.Project); e != nil || !info.IsDir() {
		return nil, fmt.Errorf("project directory does not exist: %s", c.Project)
	}
	c.Helm.Chart = resolve(c.Dir, c.Helm.Chart)
	if c.Helm.Chart == c.Dir {
		return nil, fmt.Errorf("helm.chart is required")
	}
	if err = c.resolveBuilds(); err != nil {
		return nil, err
	}
	if err = c.validateApplication(); err != nil {
		return nil, err
	}
	sum := sha256.Sum256([]byte(absolute + "\x00" + c.Project))
	c.ID = hex.EncodeToString(sum[:])[:12]
	return c, nil
}

// decodeConfig validates serialized configuration without inspecting the filesystem.
func decodeConfig(data []byte) (*projectConfig, error) {
	c := new(projectConfig)
	decoder := yaml.NewDecoder(bytes.NewReader(data))
	decoder.KnownFields(true)
	if err := decoder.Decode(c); err != nil {
		return nil, fmt.Errorf("configuration: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return nil, fmt.Errorf("configuration must contain one YAML document")
	}
	if c.Version != 1 || !dnsName.MatchString(c.Name) || !dnsName.MatchString(c.Namespace) {
		return nil, fmt.Errorf("version must be 1; name and namespace must be lowercase DNS names")
	}
	return c, nil
}

func resolve(base, path string) string {
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	return filepath.Join(base, path)
}
func within(base, path string) bool {
	rel, e := filepath.Rel(base, path)
	return e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator))
}

func (c *projectConfig) resolveBuilds() error {
	seen := map[string]bool{}
	for i, b := range c.Build {
		if !dnsName.MatchString(b.Name) || b.Image == "" || b.Dockerfile == "" || b.Context == "" || seen[b.Image] {
			return fmt.Errorf("builds need unique image names and explicit name/context/dockerfile")
		}
		seen[b.Image] = true
		b.Context = resolve(c.Project, b.Context)
		dockerfile := resolve(b.Context, b.Dockerfile)
		if !within(b.Context, dockerfile) {
			return fmt.Errorf("dockerfile must be within its build context")
		}
		if _, e := os.Stat(dockerfile); e != nil {
			return fmt.Errorf("build %s: %w", b.Name, e)
		}
		c.Build[i] = b
	}
	return nil
}

func (c *projectConfig) validateApplication() error {
	if len(c.Build) == 0 || len(c.Workloads) == 0 {
		return fmt.Errorf("declare at least one build and workload")
	}
	for alias, target := range c.Workloads {
		parts := strings.Split(target, "/")
		if !dnsName.MatchString(alias) || len(parts) != 2 || (parts[0] != "deployment" && parts[0] != "statefulset") || !dnsName.MatchString(parts[1]) {
			return fmt.Errorf("invalid workload mapping %q", target)
		}
	}
	if !dnsName.MatchString(c.Endpoint.Service) || c.Endpoint.Port < 1 || c.Endpoint.Port > 65535 || c.Endpoint.LocalPort < 1024 || c.Endpoint.LocalPort > 65535 {
		return fmt.Errorf("endpoint needs service and valid unprivileged localPort")
	}
	if c.EnvFile != "" && !dnsName.MatchString(c.SecretName) {
		return fmt.Errorf("envFile requires a secretName")
	}
	for _, d := range c.Helm.Dependencies {
		if d.Source == "" || d.Destination == "" || filepath.IsAbs(d.Destination) {
			return fmt.Errorf("invalid staged Helm dependency")
		}
	}
	return nil
}
