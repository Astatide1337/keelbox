package keelbox

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestEnvironmentRemovalScopesKindToPrivateKubeconfig(t *testing.T) {
	dir := t.TempDir()
	kubeconfig := filepath.Join(dir, "private-kubeconfig")
	if err := os.WriteFile(kubeconfig, []byte("private configuration"), 0600); err != nil {
		t.Fatal(err)
	}
	hash, err := fileHash(kubeconfig)
	if err != nil {
		t.Fatal(err)
	}
	scripts := map[string]string{
		"docker": `case "$1 $2" in
'context show') printf default;;
'context inspect') printf unix:///var/run/docker.sock;;
'--context default') case "$3" in info) printf 29;; inspect) printf owned-node;; *) exit 91;; esac;;
*) exit 92;;
esac`,
		"kind": `printf '%s\n' "$*" > "$KB_REMOVAL_LOG"
test "$1 $2 $3 $4 $5" = 'delete cluster --name owned --kubeconfig' || exit 93
test "$6" = "$KB_PRIVATE_CONFIG" || exit 94`,
	}
	for name, script := range scripts {
		if err = os.WriteFile(filepath.Join(dir, name), []byte("#!/bin/sh\n"+script+"\n"), 0700); err != nil {
			t.Fatal(err)
		}
	}
	t.Setenv("PATH", dir)
	t.Setenv("DOCKER_HOST", "")
	t.Setenv("KB_PRIVATE_CONFIG", kubeconfig)
	t.Setenv("KB_REMOVAL_LOG", filepath.Join(dir, "kind.log"))
	e := &environment{dir: dir, kubeconfig: kubeconfig, state: environmentState{Cluster: "owned", ContainerID: "owned-node", DockerContext: "default", KubeconfigHash: hash}}
	if err = e.removeEnvironment(t.Context()); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(dir, "kind.log"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), "--kubeconfig "+kubeconfig) || e.state.ContainerID != "" {
		t.Fatal("removal lost private scope or accepted cleanup state")
	}
	if _, err = os.Stat(kubeconfig); !os.IsNotExist(err) {
		t.Fatalf("private kubeconfig retained after cluster deletion: %v", err)
	}
}
