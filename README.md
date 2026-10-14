# Keelbox

A Docker Compose-style workflow for Kubernetes applications on your laptop.
Build, run, inspect, and remove a local application environment through familiar
commands. Docker builds the images, kind manages the owned local cluster, and
Kubernetes runs the workloads. Keelbox coordinates that workflow.

Projects supply their own application source, Dockerfiles, Kubernetes
configuration, and private local inputs. Keelbox does not distribute third-party
applications or their development/deployment configurations as examples.

## Build and run

Requires Go 1.25+, Docker Engine, kind, kubectl, and Helm 3 on Linux. Docker must
be running through a local Unix-socket context. `doctor` reports missing tools;
this prototype does not yet install them automatically.

Docker is a user-supplied prerequisite. `up`, `build`, and `doctor` report a
missing Docker command with the official installation link. If Docker is installed
but unavailable, they explain how to check the selected context and point to
startup guidance. Keelbox does not install Docker, start its service, or change
host permissions. The pilot still requires kind, kubectl, and Helm on PATH;
managing those supporting tools privately is a remaining packaging task.

```sh
go build -o bin/keelbox ./cmd/keelbox
project_config=/path/to/your/project/keelbox.yaml
bin/keelbox doctor --config "$project_config"
bin/keelbox up -d --config "$project_config"
```

The commands below assume a maintained `keelbox.yaml` for your own project.
It identifies build contexts, the Helm chart and local resources, workload names,
and a localhost endpoint. `up` prints the configured application URL when ready.
Use your project's actual workload names in place of `api`.

```sh
bin/keelbox ps --config "$project_config"
bin/keelbox logs -f api --config "$project_config"
bin/keelbox exec --config "$project_config" api -- sh
bin/keelbox down --config "$project_config"
```

`up -d` returns after readiness and loopback access setup. A recorded,
environment-scoped helper manages `kubectl port-forward` and retries after Pod
replacement. Foreground `up` attaches to a declared workload's output; Ctrl+C
leaves accepted workload state and detached access running.

Change application files or manifests, then rerun `up -d`. Builds use Docker's
cache and Dockerignore-aware input fingerprints; unchanged images are reused.
Image builds do not deploy anything. Application tests belong to the application: run
its own commands with `exec`, or exercise it through localhost. Use `exec -it`
for an interactive shell; omit `-it` for scripts. Startup readiness means the
configured workloads rolled out and local access is available, not that tests passed.

## Data and ownership

Every Kubernetes command uses the environment's private kubeconfig, explicit
context, and namespace. The CLI checks the local Docker context, recorded kind
container identity, and kubeconfig fingerprint before cluster operations. It
refuses unowned resources and deletes application objects with UID preconditions.
An advisory lock prevents concurrent environment writers.

`down` removes stateless application objects, scales retained StatefulSets to
zero, waits for database shutdown, and preserves PVCs and the namespace. It retains the cluster and its
control-plane memory. `up` restores the declared application and replicas.

Full removal destroys the selected owned cluster and its local database data:

```sh
bin/keelbox env rm --volumes --config "$project_config"
```

State, kubeconfig, applied input identity, and helper diagnostics are private
under `$XDG_STATE_HOME/keelbox/<environment-id>` (default
`~/.local/state/keelbox`). Environment identity is derived from the canonical
configuration file path and project source path. Moving that configuration or
project creates a separate environment; remove the old one deliberately.

## Prototype boundary

Supported commands: `doctor`, `config`, `build`, `up`, `ps`, `logs`, `exec`,
`down`, and `env rm --volumes`. The explicit YAML recipe connects existing
Dockerfiles and Kubernetes configuration to a local workflow. The current pilot
supports staged Helm charts, declared local dependencies/resources, named
Deployments/StatefulSets, and one endpoint. Rendered resource kinds are restricted
to this pilot's application resources. Recipes and Dockerfiles are trusted
executable inputs, not hostile-code sandboxes.

The project maintainer supplies Dockerfiles, Kubernetes manifests, and explicit
local adaptations. Onboarding may help connect these inputs; it should not infer
business dependencies or redesign the application. Kubernetes remains the source
of truth for workloads, networking, and storage.

Keelbox's product scope is the local application lifecycle. Production deployment,
cloud provisioning, GitOps-platform management, cloud-service emulation,
production-parity certification, and a dedicated testing/reporting framework are
outside that scope. Tests remain application-owned; there is no `test` command or
`checks` configuration.

Interactive configuration, watch mode, prerequisite setup, stop/start, additional
endpoints, and cross-platform support are potential improvements to the same
workflow. They are not implemented yet. The supported pilot is native Linux with
Docker Engine. Partial failures retain observed resources for diagnosis; there is
no deployment-wide transaction or automatic rollback. Keelbox operates on its
owned local cluster; projects supply their own local dependencies and inputs.

## Contributing and architecture

The repository contains the CLI entry point under `cmd`, implementation and its
behavior tests under `internal`, contributor policy tooling under `tools`, this
maintained README, repository instructions,
and build/lint/CI configuration. Research, generated output, private state, tool downloads, and compiled binaries
are not tracked source. `make check-layout` enforces removal of the old research
directories.

The current implementation is one cohesive internal package with `Run` as its
only exported entry point. File boundaries make ownership explicit:

- `cli.go` interprets commands and formats results.
- `config.go` validates project intent and resolves paths.
- `lifecycle.go` coordinates startup/teardown and records accepted resource UIDs.
- `state.go` owns the private state format, atomic file replacement, and locking.
- `runtime.go` validates Docker/cluster identity and scopes Kubernetes commands.
- `process.go` executes subprocesses and preserves their failure causes.
- `resources.go` validates untyped Kubernetes identities, metadata, and status.
- `render.go` stages manifests and applies inspectable local adaptations.
- `build.go` owns build inputs, image identity, and cache reuse.
- `access.go` owns helper identity, port-forward children, and reconnection.

Lifecycle remains the single coordinator for mutations. Accepted Kubernetes
writes are recorded individually; failures preserve observed state and report
unfinished work. This is not a transaction across Docker, Kubernetes, and local
files. Internal types are private, while existing JSON/YAML field names remain a
compatibility contract. A new package or interface must hide a real independent
responsibility or support a demonstrated caller; a package per command would
spread lifecycle knowledge without creating useful isolation.

Development requires the Go version in `go.mod`, make, and the golangci-lint
version pinned in [.golangci-version](.golangci-version). Install that version
and put it on PATH using the [official installation guide](https://golangci-lint.run/docs/welcome/install/).
These are contributor tools, separate from application runtime prerequisites.

```sh
make fmt    # Apply gofmt and goimports.
make lint   # Verify the pinned version/config and inspect all code, including tests.
make test   # Run behavior tests with race detection.
make check  # Check layout, lint, policy enforcement, race tests, and CLI build.
make fuzz   # Fuzz configuration and resource metadata for 10s each, two workers.
make audit  # Scan reachable vulnerabilities, including tests (network required).
```

For tools outside PATH, pass `GO=/absolute/path/to/go` and
`LINT=/absolute/path/to/golangci-lint` to make. All formatting and build/check
commands reject source symlinks before invoking tools.

`make check-policy` checks the private implementation API and rejects blanket
lint suppressions. It also runs deliberately invalid, first-party snippets in
temporary directories to prove important lint rules reject violations. These
fixtures use the checked-in configuration; weakening a protected rule fails the
gate even when ordinary source has no violations.

`FUZZ_TIME=30s` extends active fuzzing. Fuzz seeds run with ordinary tests;
failing inputs saved under `internal/keelbox/testdata/fuzz` become regression
fixtures. YAML fuzzing uses a pure decoder and never resolves application paths.

`make audit` runs the version in [.govulncheck-version](.govulncheck-version)
through `go run`, outside product dependencies. The pin supports the Go baseline
in `go.mod`. Findings and database/download failures fail the command. The scan
uses the Go executable selected by `GO` and its native build configuration; it
is not evidence for every OS, architecture, build tag, or reflection-only call.
CI scans with the current stable Go release; its separate build/test job checks
the minimum Go version in `go.mod`. Use a supported, patched Go toolchain for
application builds; the minimum compiler version is not a security endorsement.

The lint configuration rejects ignored errors (including explicit blank
assignments), unchecked type assertions, shadowed variables, incorrect error
wrapping, broken context inheritance, static-analysis defects, unused code, and
functions exceeding a cyclomatic complexity of 20. Formatting and imports are also checked. There are
no blanket exclusions or test exemptions. Specific lint suppressions require an
explanation and review; changing rules to evade findings is not a fix.

CI runs the same pinned lint version, layout and policy checks, race tests,
bounded fuzzing, build, and a separate vulnerability scan for pushes and
pull requests. Actions are pinned to commit IDs and the workflow has read-only
repository permissions. Required `quality` and `vulnerabilities` checks should
protect the maintained integration branch; merely adding a workflow does not enforce branch protection.

Lint catches mechanical defects; design review must still assess ownership,
state transitions, failure recovery, and whether a normal feature change stays
within its owning module. Behavior regressions cover real invariants such as
scoped ownership, data retention, applied-image access, and malformed input.
