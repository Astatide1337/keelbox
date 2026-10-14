# Repository rules

- Keep the product focused on a Docker Compose-style local Kubernetes lifecycle.
  Application Dockerfiles and manifests remain authoritative. Application tests
  belong to the application.
- Keep only implementation, behavior tests, maintained usage/contributor
  documentation, first-party fixtures, and build/CI configuration in this repo.
  Research notes, generated reports, private state, tool downloads, and binaries
  belong outside tracked source.
- Third-party applications and their project-specific configuration must remain
  outside this repository unless their owners explicitly authorize publication.
  A private integration pilot is not authorization to publish an example.
- Run `make check` before delivery. Do not weaken lint settings, skip test files,
  add blanket exclusions, or use unchecked errors/assertions to make it pass.
  A specific suppression needs a concrete reason and reviewer approval.
- Keep `Run` as the public entry point until another actual caller needs an API.
  Internal implementation types stay private; serialized field names are a
  compatibility contract.
- Preserve file ownership: CLI parses/formats; configuration validates project
  intent; environment lifecycle coordinates changes; runtime validates targets;
  state owns locking/persistence; resources validates Kubernetes representations;
  build owns images; access owns localhost helper/child processes; process owns
  subprocess execution.
- Validate untyped data at its boundary. Never turn malformed Kubernetes metadata
  or status into assumed ownership or a successful lifecycle result.
- Propagate actionable errors and cleanup failures. Preserve error identity with
  wrapping or `errors.Join`. Retry only where the owner defines the policy.
- Extract functions around decisions or invariants, not just to satisfy a size
  limit. Avoid generic utility packages, speculative interfaces, plugin systems,
  and pass-through layers.
- Every Kubernetes command must use the private kubeconfig and explicit context
  and namespace. Preserve ownership/UID checks and data-retention behavior.
- Never add AI-agent co-author/session trailers. Never merge, enable auto-merge,
  or deploy to remote environments.
