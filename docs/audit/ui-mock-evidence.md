# Controlled browser regression evidence

These checks exercise the installed production UI with **mocked authentication,
project, configuration, lab, and tutor API routes**. They prove the covered UI
state, persistence, and response-order behavior. They do not prove real OAuth,
OpenAI inference, project API persistence, Kubernetes health, or cluster safety.
No credential files, startup tickets, broker capabilities, or cluster operations
were used by this suite.

## Installed artifact and command

- Installed package: `/tmp/waypoint-audit-verified24`
- Artifact SHA-256:
  `6ad2a568f6bc109525337619f151b851983b5d706858cc1218dda6bf92bce089`
- Production UI: `http://127.0.0.1:3124`
- Test files: `tests/e2e/audit-account.spec.ts`, `tests/e2e/audit-edges.spec.ts`
- Viewports: 1366 × 768 desktop and 390 × 844 narrow-screen, Chromium headless, one worker.

```sh
PLAYGROUND_E2E_ORIGIN=http://127.0.0.1:3124 pnpm exec playwright test \
  tests/e2e/audit-account.spec.ts tests/e2e/audit-edges.spec.ts \
  --output=/tmp/waypoint-implementation/audit-verified-final-mock-browser
```

Raw log: `/tmp/waypoint-implementation/audit-verified-final-mock.log`.
Result: **14 PASS, 0 FAIL, 36.7 seconds**.
Typecheck: **PASS**, recorded in
`/tmp/waypoint-implementation/audit-verified-final-typecheck.log`.

## Assertions and boundaries

| Check | Result | Covered behavior |
| --- | --- | --- |
| Same-epoch account change | PASS | Account A's catalog, malformed analysis draft, and original-file markers are never written under account B; returning to A restores its draft. All storage writes are observed, including transient writes. |
| Global Ask after leaving Practice | PASS | A mocked live-lab preview carries the exact lab ID/generation/revision. Switching to Secrets / Vault produces a source preview with project revision and no lab scope fields. |
| Source URL hydration | PASS | A saved project-scoped Topology/YAML/resource URL survives the initial delayed selected-project response and restores the editor. |
| Practice URL hydration | PASS | A saved Practice URL loads its matching source project and lab generation without a spurious pending CLI project or previous-project mismatch. |
| GET started before browser import | PASS | A held old project response cannot overwrite a successful Confirm import POST. Subsequent polls are blocked during the assertion so they cannot conceal a transient overwrite. |
| Recent project selection | PASS | Selecting a recent project issues the canonical select POST; a subsequent reload hydrates that selection. Backend persistence itself remains mocked. |
| Endpoint metadata and drafts | PASS | The endpoint metadata POST keeps original source files immutable and preserves an unrelated workload's existing contract. Saved and unsaved analysis edits survive the metadata change and reload; Revert returns to the saved draft. |
| GET started during browser import | PASS | A GET begun while the import POST is pending cannot undo that POST after it succeeds. Later polls are again blocked during the assertion. |
| Overlapping selections | PASS | A second recent-project selection displays the retry message and starts no competing POST. The first pending selection settles correctly. |
| Live transport failure and recovery | PASS | A failed lab GET removes the Live observation label, marks retained evidence stale, displays the failure reason and last observation, and disables starting an incident. Retry restores Live observation while retaining the exact selected Service UID. Every mocked lab request is GET-only. |
| Exact source relationship | PASS | A real SVG path click from an unrelated prior selection displays only the exact relationship. Citation and owner navigation clear old edge scope; project adoption is exercised with an exact edge freshly focused immediately before switching. |
| Exact live relationship | PASS | A real SVG path click selects the edge's source resource and exact relationship; the reviewed Ask request carries matching resource/relationship/generation/revision fields. |
| Narrow live panes | PASS | Resources, Topology, and Inspector occupy the active full-width pane; graph height is nonzero and usable. Clicking the exact edge opens its inspector, switching panes retains it, and document width does not overflow. |
| Manifest repair and acknowledgment | PASS | Manifest files has one repair editor and adjacent Apply control. Invalid YAML remains visible with a line error and no POST. A valid probe-path edit sends the exact session/generation/revision/source and operation ID. A newer draft typed while that POST is held survives the older apply acknowledgment, remains dirty, survives reload, and is retained while stale transport disables Apply until retry. |

The same-epoch account case is a deliberately synthetic defense regression.
Independent review withdrew the earlier reachable-account-leak claim after
tracing the existing AccountProvider epoch-key boundary. Do not cite this test
as reproduction of a real account authentication flaw.

The latest run includes the strengthened assertion requiring preservation of an
unrelated workload's endpoint contract. That assertion and the draft assertions
all passed. The earlier nine-test run against artifact
`8f992ff9dd98099409c6193986a76f53f9c54fdd6e7e5ad05c957c7b7d55feed`
also passed (23.8 seconds), with log
`/tmp/waypoint-implementation/audit-complete-mock.log`; it preceded the
additional contract-preservation assertion.
The nine-test run including that assertion also passed (24.2 seconds) against
`04d905431d0ed8f5d557b19598cb3bd8e4d1da836e7d46ba5ac33f18bf3018e1`,
with log `/tmp/waypoint-implementation/audit-ship-mock.log`.
The prior ten-test delivery run passed (27.1 seconds) against artifact
`e79c4204160fc60215c80458ddfec7afd16bafdf29aa3a6a778d104776c0e5da`,
with log `/tmp/waypoint-implementation/audit-delivery-final-mock.log`.
The next frozen-artifact run passed all ten tests (28.3 seconds) against
`23067ffa00350eb40890ae32707eace7a5b612b78465f19fb715f2a894f09364`,
with log `/tmp/waypoint-implementation/audit-final-freeze-mock.log`.

The first delivery-artifact run passed the original nine tests but failed the
new transport test because its initial URL omitted the required `labProject`
digest, leaving the resource inspector unselected. That test setup failure is
preserved in `/tmp/waypoint-implementation/audit-delivery-mock.log`; no product
change was made for it. Adding the matching digest produced a targeted PASS
(`/tmp/waypoint-implementation/audit-delivery-transport.log`) and the clean
ten-test result above.

## Preserved URL-hydration failure baseline

Before the source hydration correction, both saved-URL tests failed against the
earlier installed `/tmp/waypoint-audit-product24` artifact:

- The source project loaded, but URL `tab` and `selected` were removed and the
  selected-resource editor was not restored.
- Practice retained the bundled project, offered the saved source as a pending
  CLI project, and reported a previous-project lab mismatch despite matching
  source/lab fixtures.

Raw baseline log: `/tmp/waypoint-implementation/audit-url-mock.log`.
Failure screenshots and traces:
`/tmp/waypoint-implementation/audit-url-browser-evidence/`.
The baseline is retained separately from the passing run.

## Screenshots and review

Passing screenshots are under
`/tmp/waypoint-implementation/audit-verified-final-mock-browser/`, including
`mock-restored-source-url.png`, `mock-restored-practice-url.png`,
`mock-self-import-after-old-get.png`, `mock-during-post-get-rejected.png`,
`mock-recent-project-after-reload.png`, and
`mock-draft-after-endpoint-metadata.png`,
`mock-live-disconnected-stale.png`, and `mock-live-reconnected.png`.

The latest artifact's disconnected transport screenshot and the prior frozen
artifact's source URL screenshot were inspected directly. The source image shows the selected Service, matching
source YAML and ready endpoint coverage. The earlier endpoint-draft screenshot
shows the Saved draft state after metadata update, reload,
and Revert. Comment retention is established by editor text assertions; that
comment is below the screenshot's visible viewport. The prior during-POST screenshot was inspected and
shows only the newly imported ConfigMap after the stale response.
Earlier account-isolation and source-Ask screenshots were also inspected.
The transport screenshots were inspected: the failed connection notice and
disabled incident controls become the recovered view with enabled controls,
while the Service remains selected. Inspector observation text is verified by
the browser assertions; it is below the visible screenshot viewport.
Independent review inspected the original account/Ask assertions, raw passing
log, and source-Ask screenshot and accepted only the controlled mock claim.

Real signed-in browser, inference, owned-cluster lifecycle, live readiness and
liveness, and installed backend checks require separate evidence in the main
audit record. This document does not substitute for them.

## Exact graph-edge regressions and narrow layout baseline

`tests/e2e/audit-edges.spec.ts` adds three controlled cases using actual mouse
clicks on the exact SVG relationship path. The source case also checks citation,
owner, and project-adoption transitions. The live case verifies that the reviewed
Ask request identifies the selected edge and its endpoint resource with matching
lab generation/revision. The mobile case checks all three panes at 390 × 844,
full-width geometry, graph height, absence of horizontal document overflow, and
relationship retention while switching panes. Every backend route is mocked;
these are not live Kubernetes edge checks.

The original installed-artifact baseline failed all three edge cases:
`/tmp/waypoint-implementation/audit-edges-baseline.log`. The source inspector
showed multiple relationships after an exact edge click; live selection retained
an unrelated resource; the mobile inspector stayed hidden. Narrow fixes filter
focused evidence to the selected relationship, select its endpoint before
showing the inspector, and clear focus when navigating to a different resource
or project.

The first production run then passed the original 13 checks
(`/tmp/waypoint-implementation/audit-release-mock.log`), but screenshot inspection
revealed a clipped mobile inspector. Stronger geometry checks correctly failed
at `/tmp/waypoint-implementation/audit-mobile-edge-layout.log`. An initial flex
class correction also failed because panel classes affect inner wrappers while
outer library panels retained their widths. The computed receipt is preserved at
`/tmp/waypoint-implementation/audit-mobile-edge-grid-detail-browser/audit-edges-MOCK-edges-mob-2e3fa-xact-relationship-inspector/mobile-layout.json`.

Targeting outer panels corrected width but setting the active panel to `block`
collapsed the React Flow child to zero height. Real pointer clicks on the graph
and Fit control failed; no forced handler was used. That failure and receipt are
preserved at `/tmp/waypoint-implementation/audit-mobile-handoff-geometry.log` and
`/tmp/waypoint-implementation/audit-mobile-handoff-geometry-browser/audit-edges-MOCK-edges-mob-2e3fa-xact-relationship-inspector/mobile-initial-geometry.json`.
The receipt shows a 356px wide active outer panel and a 420px canvas with a
zero-height React Flow child. These failed attempts remain separate from final
verification. Restoring the active outer panel's flex layout passed all 13
checks in the earlier shipping artifact, then all 14 checks in the final artifact above. The graph begins with a 356 × 758px React
Flow viewport; all six settled pane receipts show one 356px active panel within
the 358px group and zero-width hidden panels. Full-page document overflow is
asserted at no more than 391px.

Final screenshots were inspected directly: `mock-source-exact-edge.png` shows
one focused relationship, `mock-live-exact-edge.png` shows its Service selected,
and `mock-mobile-live-edge.png` shows a full-width Service inspector with the
same exact relationship. They are under the corresponding `audit-edges-*`
subdirectories of `/tmp/waypoint-implementation/audit-verified-final-mock-browser/`.
Safe computed geometry receipts are preserved in
`audit-edges-MOCK-edges-mob-2e3fa-xact-relationship-inspector/` as
`mobile-initial-geometry.json` and `mobile-layout-1-liveinspector.json` through
`mobile-layout-6-liveinspector.json`. These receipts contain only DOM geometry,
styles, and pane identifiers from the controlled fixture.

## Manifest repair and pending-apply baseline

The missing Manifest files Apply control was demonstrated against the earlier
shipping artifact: `/tmp/waypoint-implementation/audit-editor-baseline.log`
failed with one editor and zero Apply controls. The editor surface now shares
the repair control and validation behavior with the inspector's repair tab.

A held-response check then demonstrated loss of a newer draft after an older
Apply acknowledgment on the intermediate installed UI. The exact intermediate
package digest was not captured by this test, so this is retained as a failure
trace, not package acceptance evidence:
`/tmp/waypoint-implementation/audit-editor-ack-final-baseline.log`.
The test waits for the POST acknowledgment and a subsequent GET before checking
retention; a transient pre-acknowledgment view cannot satisfy the assertion.

The first final-artifact run passed the acknowledgment check but failed the
post-reload text assertion because CodeMirror initially renders only the top
of the file. That test setup issue is retained in
`/tmp/waypoint-implementation/audit-verified-mock.log`. Using the actual editor's
Control+End navigation exposes the saved tail before asserting its marker;
no product change was made for this correction. The targeted check passed
(`/tmp/waypoint-implementation/audit-verified-editor.log`), followed by the clean
14-test final-artifact run above.

`mock-manifest-repair-applied.png` and `mock-manifest-repair-stale.png` under
`audit-edges-MOCK-editor-Ma-d8243--and-blocks-stale-transport/` were inspected.
The first shows the newer draft marker and enabled Apply control. The second
shows the same marker, disconnected reason, stale resource labels, and Retry
control; disabled Apply is established by the browser assertion. The mock POST
acknowledges a repair only; it does not establish a real Kubernetes apply or
probe recovery.
