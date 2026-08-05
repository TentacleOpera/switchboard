# Browser Host: URL, Secrets Path & Rail Layout

**Complexity:** 5

## Goal

Three browser-host surface gaps where earlier work delivered a capability but not the user-facing default: the board URL still reads 127.0.0.1 because --hostname is an opt-in flag nobody passes and the extension's Open in Browser builds its URL inline; the token inputs' hint names the editor as the only path even though an encrypted secrets store and a CLI writer exist (the mirror is write-only, so the editor host cannot see them); and the Setup icon sits mid-rail instead of in the bottom settings cluster beside the theme toggle.

## How the Subtasks Achieve This

- **Browser Board URL Must Default to switchboard.localhost, Not 127.0.0.1**: Adds a shared `resolveDisplayHostname` (default + reachability probe + fallback) in `loopbackHostname.ts` and routes all three URL builders (CLI, bootstrap, extension Open in Browser) through it — turns the existing opt-in hostname capability into the actual default the user sees, safely.
- **Browser Setup/Tickets Panels: "Set This in the Editor" Hint Ignores the Encrypted Secrets Store**: Adds the missing read direction to the secrets mirror (fill-only import of the machine-global store into the keychain at activation) and rewrites the disabled-input hint to name both real paths — makes `npx switchboard secrets set` genuinely work for the editor host and makes the browser-panel copy true.
- **Browser Shell: Move the Setup Icon to the Bottom of the Rail, Next to the Theme Toggle**: Adds a `placement: 'bottom'` manifest marker and a two-pass rail render so the Setup icon joins the bottom settings cluster beside the theme toggle — puts the settings surface where users expect it without disturbing manifest-order consumers.

## Dependencies & sequencing

- **Cross-feature dependencies:** None. Each subtask builds on already-merged foundations (the loopback-hostname capability + contract test; the encrypted store + CLI + write-only mirror; the shell manifest + terminal-strip anchor). Nothing from other in-flight features must land first.
- **Shipping order within this feature:** Subtasks are independent and can land in any order. One soft constraint: the URL and secrets subtasks both edit `src/extension.ts` (disjoint regions — openInBrowser ~1178-1191 vs the secrets mirror ~650-702), so per the PRD's one-agent-stream-per-file discipline they must be coded serially or merged carefully, not edited in parallel.
- **Prerequisites / guards:** The reachability probe in the URL subtask is mandatory (never ship an unprobed default hostname); the secrets subtask must keep `secretsEntry: false` and the no-HTTP-writes gate for the extension host (contract-test pinned); the rail subtask must keep the `margin-top: auto` anchor mechanism intact (pinned by `shell-terminal-strip.test.js`).

## Reconciled end-state (post-audit)

Cross-subtask audit found no overlap, contradiction, or supersession. Shared surfaces: `src/extension.ts` (URL + secrets subtasks, disjoint regions — serialise edits); `src/services/headlessPanelHtml.ts` (rail subtask modifies the manifest; the other two only read/confirm). No restructure was needed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Browser Board URL Must Default to switchboard.localhost, Not 127.0.0.1](../plans/feature_plan_20260805105305_browser-board-url-defaults-to-switchboard-localhost.md) — **CODE REVIEWED**
- [ ] [Browser Setup/Tickets Panels: "Set This in the Editor" Hint Ignores the Encrypted Secrets Store](../plans/feature_plan_20260805105306_browser-setup-secrets-hint-names-cli-secrets-store.md) — **CODE REVIEWED**
- [ ] [Browser Shell: Move the Setup Icon to the Bottom of the Rail, Next to the Theme Toggle](../plans/feature_plan_20260805105312_browser-shell-setup-icon-moves-to-bottom-rail.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Completion Report

All three subtasks were implemented. `src/utils/loopbackHostname.ts` now exports `DEFAULT_DISPLAY_HOSTNAME` and `resolveDisplayHostname`, which the standalone CLI, bootstrap, and extension `openInBrowser` all use to default to `switchboard.localhost` with a 500 ms `/health` reachability probe and automatic `127.0.0.1` fallback. The editor-host secrets mirror in `src/extension.ts` gained the missing `importSecretFromGlobalStore` fill-only read direction before the existing write-only sweep, and `src/webview/transport.js` now shows the accurate CLI hint. The Setup panel icon was moved to the bottom rail cluster by adding `placement: 'bottom'` in `src/services/headlessPanelHtml.ts`, splitting `renderManifest` in `src/webview/shell.js`, and adding the `strip-placement-bottom` CSS rule in `src/webview/shell.html`. Contract tests were updated to cover the new defaults, import ordering, and placement. No compilation or test runs were performed per the dispatch directive.

## Review Findings

Reviewed all three subtasks in place; verification was run independently (the coder's "no test runs" note is a record, not a directive). Three CRITICALs in the rail subtask: the Setup icon never actually moved — a column flex box collapses its free space into whichever child holds the auto top margin, so appending Setup *before* `#strip-terminals`/the theme toggle left it packed with the top group with 299–339px of empty rail below it (reproduced and then re-measured in headless Chrome against the real CSS), and two of the coder's own new assertions were RED (a CSS comment containing the literal `margin-top: auto` tripped the file-wide `anchors === 1` count; the placement regex's `[^}]*` could not cross the `${iconDir}` brace). One MAJOR in the URL subtask: `isHostnameReachable` could hang forever, because `req.setTimeout` only arms on socket inactivity after a socket exists and `http.get` throws synchronously on a malformed name — and both `openInBrowser` and the standalone launch await it. All fixed, plus three MINORs (an unused `DEFAULT_DISPLAY_HOSTNAME` import beside a hardcoded help string, an unexercised `resolveDisplayHostname` import with zero probe coverage, and a missing `MIRRORED_SECRET_KEYS` gate on the secrets import); the secrets subtask had no CRITICAL or MAJOR. Files changed by the review: `src/utils/loopbackHostname.ts`, `src/standalone/cli.ts`, `src/extension.ts`, `src/webview/shell.js`, `src/webview/shell.html`, `src/test/loopback-hostname-contract.test.js`, `src/test/shell-terminal-strip.test.js`. Verification: `tsc --noEmit` (5 pre-existing TS2835 errors, none in touched files), `npm run compile` clean, all three contract tests green (shell-terminal-strip 24/24, previously 21 pass / 2 fail), plus `catalog:check`, `parity:check`, `push-routing:check`, `verb-returns:check`, `mirror:check`, `icons:parity`, `panel-runtime-surface`, `panel-scrollbars` — and every automated check named in the three plans is confirmed wired in `.github/workflows/integration-tests.yml` (lines 106, 230, 372). Remaining risk is UAT-only: whether `switchboard.localhost` resolves is per-machine, so the probe's positive branch and the cross-origin `127.0.0.1` asset loads under the new page origin still need a live pass.
