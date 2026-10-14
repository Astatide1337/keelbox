package keelbox

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
)

type imageArtifact struct {
	Fingerprint string
	Tag         string
	ID          string
}
type resourceRef struct {
	APIVersion string
	Kind       string
	Name       string
	UID        string
}
type environmentState struct {
	Version        int
	ID             string
	Cluster        string
	Namespace      string
	Context        string
	DockerContext  string
	ContainerID    string
	KubeconfigHash string
	ConfigPath     string
	Images         map[string]imageArtifact
	Artifacts      map[string]imageArtifact
	Resources      []resourceRef
	Endpoint       endpointSpec
	Up             bool
	LoadedImages   map[string]string
	AppliedImages  map[string]imageArtifact
	AppliedDigest  string
}
type environment struct {
	config     *projectConfig
	dir        string
	kubeconfig string
	state      environmentState
	lock       *os.File
}

func openEnvironment(c *projectConfig) (*environment, error) {
	base := os.Getenv("XDG_STATE_HOME")
	if base == "" {
		home, e := os.UserHomeDir()
		if e != nil {
			return nil, e
		}
		base = filepath.Join(home, ".local", "state")
	}
	e := &environment{config: c, dir: filepath.Join(base, "keelbox", c.ID)}
	if err := os.MkdirAll(e.dir, 0700); err != nil {
		return nil, err
	}
	e.kubeconfig = filepath.Join(e.dir, "kubeconfig")
	lock, err := os.OpenFile(filepath.Join(e.dir, "lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = syscall.Flock(int(lock.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		return nil, errors.Join(fmt.Errorf("another Keelbox operation owns this environment: %w", err), lock.Close())
	}
	e.lock = lock
	e.state = environmentState{Version: 1, ID: c.ID, Cluster: "keelbox-" + c.Name + "-" + c.ID, Namespace: c.Namespace, Context: "kind-keelbox-" + c.Name + "-" + c.ID, Images: map[string]imageArtifact{}, LoadedImages: map[string]string{}, ConfigPath: c.Path, Endpoint: c.Endpoint}
	data, err := os.ReadFile(filepath.Join(e.dir, "state.json"))
	if err == nil {
		if err = json.Unmarshal(data, &e.state); err != nil {
			return nil, errors.Join(err, e.close())
		}
		if e.state.Version != 1 || e.state.ID != c.ID || e.state.Namespace != c.Namespace || e.state.ConfigPath != c.Path {
			return nil, errors.Join(fmt.Errorf("environment identity/configuration mismatch"), e.close())
		}
	} else if !os.IsNotExist(err) {
		return nil, errors.Join(err, e.close())
	}
	return e, nil
}
func (e *environment) close() error {
	if e.lock != nil {
		unlockErr := syscall.Flock(int(e.lock.Fd()), syscall.LOCK_UN)
		closeErr := e.lock.Close()
		e.lock = nil
		return errors.Join(unlockErr, closeErr)
	}
	return nil
}
func (e *environment) save() error { return writeJSON(filepath.Join(e.dir, "state.json"), e.state) }
func writeJSON(path string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	f, err := os.OpenFile(path+".tmp", os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	if _, err = f.Write(data); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(path+".tmp", path)
}
