# Evidence status

> **Historical record only. This is not verification of the recovered source.**

[`minikube-proof-2026-10-11.json`](minikube-proof-2026-10-11.json) is preserved as the raw record of an earlier run from 2026-10-11 07:07:47Z to 07:16:10Z. It predates the recovered integration commit `a84d36bbac9e03c1ada4e954b1df7b1887ea116d` and the producer's separate Pod-loopback control listener.

The historical file records `status: PASS`, seven passing incident results out of seven, and five measurement trials. Those results describe only the earlier source state. Do not present them as passing live verification for the recovered source. Its `cleanup` field is present, but it has no `stateCleanup` field; the current `scripts/prove-market-data-live.ts` writes `stateCleanup` in its final record. The original JSON was not edited.

The historical proof file SHA-256 is `7942bc1508eae6c32846ed012ca5ee32a18478a1848c48ea1a37c3ae3b363b8f`.

No Kubernetes or Minikube commands ran during source recovery or this follow-up. Current cluster verification remains **not run**. The machine-readable summary is in [`status.json`](status.json).
