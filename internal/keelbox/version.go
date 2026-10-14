package keelbox

import "fmt"

// Set by the release build's linker flags; ordinary source builds remain dev.
var buildVersion = "dev"
var buildCommit = "unknown"

func versionInfo() string {
	return fmt.Sprintf("keelbox %s (commit %s)", buildVersion, buildCommit)
}

// printInformation handles commands that do not require project or runtime state.
func printInformation(args []string) (bool, error) {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" {
		fmt.Println("Keelbox — local Kubernetes development (Linux pilot)")
		fmt.Println("Usage: keelbox <command> --config <keelbox.yaml>")
		fmt.Println("Commands: version, doctor, config, build [image], up [-d], ps, logs [-f] <workload>, exec [-it] <workload> -- <command>, down, env rm --volumes")
		return true, nil
	}
	if args[0] != "version" && args[0] != "--version" {
		return false, nil
	}
	if len(args) != 1 {
		return true, fmt.Errorf("usage: keelbox --version")
	}
	fmt.Println(versionInfo())
	return true, nil
}
