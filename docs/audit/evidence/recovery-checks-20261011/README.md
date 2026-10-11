# Source-recovery checks (2026-10-11)

These files preserve raw stdout and stderr for the local checks rerun after adding the historical-proof status notice. Commands exited successfully unless stated otherwise.

## Results

- TypeScript: passed under Node 22.23.3 (`typecheck.log`).
- Node test suite: **116 total; 114 passed, 2 skipped, 0 failed** (`unit-tests.log`). The two skips are optional environment-dependent tests; “114 passed” is not the total test count.
- Synthetic market-data fixture HTTP suite: **4 passed** (`fixture-http-tests.log`), using ephemeral loopback listeners only.
- Package build: passed using Node 24.14.0 / npm 11.9.0. `npm pack` ran the `prepack` lifecycle, whose `package:build` script invokes Next.js Webpack; no image build or cluster command is part of this script (`package-build.log`).
- Package verification: **PASS**, 4,358 files, 4,347 text files scanned, 101,351,131 unpacked bytes, no install hooks, static assets present, MIT license (`package-verify.log`). The verifier scope is recorded in `market-data-package-scan.json`; it is not an exhaustive semantic secret detector.
- Offline package install and `waypoint help`: passed without registry access (`offline-install-help.log`). Runtime versions are in `runtime-versions.log`.

The preserved archive is [`waypoint-k8s-0.1.0.tgz`](/tmp/waypoint-market-data-recovery-evidence-status-20261011/waypoint-k8s-0.1.0.tgz), SHA-256 `927a479b3fea91d000c73610807016d1303c1fa01aeb814a685dc7b6bb1a77c5`. It was built from the recovered source plus the evidence-status documentation included in the package. It was not published.

The independent remote review reported **0 CI checks and 0 CI runs**, so there is no external CI result to report for this recovery. No Kubernetes or Minikube command, OAuth change, container-image build, or npm publication was performed. The historical Minikube record is explicitly classified as pre-recovery in [its adjacent status notice](../../../../examples/market-data/evidence/README.md).
