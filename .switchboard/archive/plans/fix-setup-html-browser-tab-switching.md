# Fix setup.html Tab Switching in Browser Cockpit

## Metadata
- **Complexity:** 3
- **Tags:** bugfix, frontend, ui, reliability
- **Project:** Website

## Goal

Fix the setup.html panel's tab switching which is completely broken in the browser cockpit (standalone/headless mode). Tabs work fine in the VS Code extension but do nothing in the browser.

> **Superseded:** "Tabs work fine in the VS Code extension but do nothing in the browser." (and Step 3's premise that the marker "was never added to `setup.html`", and that adding it is a no-op for the extension)
> **Reason:** Verified against the code and the installed VSIX. The `<!-- SHARED_DEFAULTS_SCRIPT -->` marker **used to exist** in `setup.html` and was **deleted on 2026-07-23 by commit `3224366`** ("Reviewer anti-leakage, host config change events, browser cockpit workspace sync") as collateral damage while the `clientOriginatorId` postMessage wrapper was inserted on the adjacent line. Because `SetupPanelProvider.ts:1593` keys `sharedDefaults.js` injection off the **same marker**, its deletion broke **both** hosts, not just the browser. The installed extension (`~/.devin/extensions/turnzero.switchboard-1.7.13/dist/webview/setup.html`) contains **0** markers and still contains the `DEFAULT_VISIBLE_AGENTS` reference, so the extension's setup panel is broken at HEAD as well — it just dies on a *different line* than the browser does.
> **Replaced with:** This is a **regression revert**, not a new feature. Restoring the marker fixes the browser **and** the extension. The two hosts fail at two different statements of the same inline script (details below).

### Problem Analysis & Root Cause

The setup panel's inline `<script>` (line 1760) calls `acquireVsCodeApi()` as its very first statement:

```javascript
const vscode = acquireVsCodeApi();
```

In the VS Code extension, the webview runtime injects this function natively. In the browser cockpit, the transport shim (`transport.js`) provides a polyfill — it defines `window.acquireVsCodeApi` so the existing webview UIs run unchanged.

**The bug:** The headless server's `getSetupHtml()` function (`src/services/headlessPanelHtml.ts`, line 283-284) injects the transport shim by replacing the marker `<!-- SHARED_DEFAULTS_SCRIPT -->`:

```typescript
content = content.replace('<!-- SHARED_DEFAULTS_SCRIPT -->',
    `<script src="/static/webview/sharedDefaults.js" nonce="${nonce}"></script>\n<script src="/static/webview/transport.js" nonce="${nonce}"></script>`);
```

But `setup.html` **does not contain this marker** (it was deleted by `3224366`, see the superseded callout above). The marker still exists in `kanban.html` (line 3452) and `implementation.html` (line 1633). As a result:
- The `content.replace(...)` is a no-op (the string isn't found) — **silently**, because `String.prototype.replace` returns the input unchanged when the search string is absent
- `transport.js` is never injected
- `acquireVsCodeApi()` is undefined in the browser
- The inline `<script>` throws a `ReferenceError` at line 1761
- **The entire script block fails** — `initTabs()`, `activateTab()`, and all tab click listeners are never registered
- Tabs are dead in the browser

**Second failure, same root cause — the extension is also broken.** `SetupPanelProvider._getHtmlForWebview` (`src/services/SetupPanelProvider.ts:1592-1593`) injects `sharedDefaults.js` through the *same* marker:

```typescript
const sharedDefaultsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedDefaults.js')).toString();
content = content.replace('<!-- SHARED_DEFAULTS_SCRIPT -->', `<script src="${sharedDefaultsUri}" nonce="${nonce}"></script>`);
```

`setup.html` has **exactly one** `<script>` tag in the whole file (line 1760) and **no** `<script src=...>` tags at all, so with the marker gone `sharedDefaults.js` is never loaded in either host. The inline script dereferences three of its top-level `const` bindings:

| setup.html line | Reference | Declared in |
| :--- | :--- | :--- |
| 1785 | `let lastVisibleAgents = { ...DEFAULT_VISIBLE_AGENTS };` | `sharedDefaults.js:2` |
| 1934 | `BUILT_IN_AGENT_LABELS.filter(...)` | `sharedDefaults.js:38` |
| 1934 | `PROMPT_OVERRIDE_EXCLUDED_KEYS.has(...)` | `sharedDefaults.js:59` |

Line 1785 is a **top-level statement 25 lines into the script**, and `initTabs()` is defined at line 2016 — far below it. So:

- **Browser cockpit:** dies at line 1761 (`ReferenceError: acquireVsCodeApi is not defined`) — no transport shim.
- **VS Code extension:** `acquireVsCodeApi()` succeeds (native), then dies at line 1785 (`ReferenceError: DEFAULT_VISIBLE_AGENTS is not defined`) — no `sharedDefaults.js`.

Either way the script aborts before `initTabs()` is declared or called, and every tab is dead. Restoring the single marker line repairs both hosts at once.

**Why this shipped undetected — the defect class.** All three injection sites (`headlessPanelHtml.getSetupHtml`, `headlessPanelHtml.getBoardHtml`, `SetupPanelProvider._getHtmlForWebview`) use a bare `content.replace(marker, …)` with **no verification that the marker was present**. A missing marker is indistinguishable from a successful injection at build time, at serve time, and in any log. That is why an accidental one-line deletion in an unrelated commit reached a published VSIX (1.7.13) with a fully dead Setup panel. The three sibling panels (`design.html`, `planning.html`, `project.html`) already avoid this by routing through `injectTransportShim()` (`headlessPanelHtml.ts:52-60`), which falls back to injecting before the first known `<script>` tag when the marker is absent. `getSetupHtml` and `getBoardHtml` are the two headless getters that never adopted that helper.

## User Review Required

- **None.** The fix is a revert of an accidental deletion plus a fail-soft guard on the same mechanism. No product decisions, no user-visible behaviour change beyond "the Setup panel works again".

## Complexity Audit

### Routine
- Restoring one HTML comment line in `src/webview/setup.html`.
- Pointing `getSetupHtml` / `getBoardHtml` at the existing `injectTransportShim()` helper already used by three sibling getters — no new abstraction invented.
- Adding a `console.warn` on the fallback branch so a future marker deletion is loud instead of silent.
- No state, no settings, no DB, no migration surface.

### Complex / Risky
- **Injection ordering is load-bearing.** The shim must execute *before* the inline script. This is guaranteed only because the marker sits immediately above the inline `<script>` and neither injected tag is `async`/`defer` (classic scripts execute in document order). Any change that moves the marker breaks the panel silently again.
- **Restoring the marker changes extension behaviour on shipped installs.** `sharedDefaults.js` starts loading in the extension's Setup webview again. This is the *intended* pre-`3224366` behaviour, but it means a global-scope script that has not run for four days resumes running — see the Edge-Case audit for the symbol-collision check that proves it is safe.

## Edge-Case & Dependency Audit

**Race Conditions**
- None introduced. Both injected `<script src=...>` tags are classic (non-`async`, non-`defer`) and precede the inline script in document order, so they execute to completion first. `transport.js` is additionally idempotent (`transport.js:20-23` short-circuits when `window.__switchboardVscodeShim` already exists).
- `transport.js` reads `document.body.dataset.panel` synchronously at load (`transport.js:25`). The marker is inside `<body>` (line ~1759), so `document.body` exists and `data-panel="setup"` — stamped by `getSetupHtml` at line 288 — is already parsed. Route prefix resolves to `/setup/verb`, which is wired in both hosts (`LocalApiServer.ts:3297`, `bootstrap.ts:986`, `TaskViewerProvider` setupVerb).

**Security**
- Both injected tags carry `nonce="${nonce}"` and are same-origin (`/static/webview/…` headless, `asWebviewUri` in the extension). `getSetupHtml`'s CSP (line 281) is `script-src 'nonce-${nonce}' 'self' 'unsafe-eval' 'unsafe-inline'`; the extension CSP is `script-src 'nonce-${nonce}' ${webview.cspSource}`. Both admit the injected tags with no CSP change. Note that when a nonce is present browsers **ignore** `'unsafe-inline'`, which is exactly why the inline script depends on the `/<script>/g` nonce pass — do not remove it.
- No new network origins, no new eval, no secrets on the wire.

**Side Effects**
- **Symbol collision — checked, none.** `sharedDefaults.js` declares 12 top-level bindings (`DEFAULT_VISIBLE_AGENTS`, `DEFAULT_ROLE_CONFIG`, `BUILT_IN_AGENT_LABELS`, `ROLE_KEYS`, `PROMPT_OVERRIDE_EXCLUDED_KEYS`, `GIT_BRANCH_STRATEGY_RADIO`, `GIT_COMMIT_STRATEGY_RADIO`, `GIT_PUSH_STRATEGY_RADIO`, `SUBAGENT_POLICY_RADIO`, `FEATURE_SUBAGENT_POLICY_RADIO`, `FEATURE_WORKFLOW_FILE_PATH_ADDON`, `ROLE_ADDONS`). `setup.html` **declares none of them** — it only *reads* three. A duplicate top-level `const` across two classic scripts is a `SyntaxError` that would kill the panel outright, so this had to be verified before restoring the marker; it is clean.
- `sharedDefaults.js` also installs a click-flash style/listener (`sharedDefaults.js:269-289`), guarded by `window.__sbClickFlashInit`. Restoring the marker restores that cosmetic effect in the Setup panel. Intended pre-regression behaviour.
- `dist/webview/sharedDefaults.js` is confirmed present in the packaged extension (24 KB in the installed 1.7.13), so the restored `<script src>` resolves rather than 404-ing.
- The marker is an HTML comment: inert in any host that does not replace it.

**Dependencies & Conflicts**
- Touches `src/webview/setup.html`, `src/services/headlessPanelHtml.ts`, `src/services/SetupPanelProvider.ts`. Per the PRD's "one agent stream per provider file" rule these are three distinct files with no shared editing hazard, but `headlessPanelHtml.ts` is shared by every headless panel plan — serialise against any concurrent panel-HTML work.
- No `verbSchemas.ts` change (no verb payload changes), so no schema-serialisation conflict.
- Does not move the ratchet: no verb arms are touched, so `verb-returns:check` / `parity:check` / `push-routing:check` baselines are unaffected.

## Dependencies

- `sess_local_none — no upstream plan dependency; this is a standalone regression revert of commit 3224366.`

## Adversarial Synthesis

Key risks: (1) the fix is one HTML comment, so the real hazard is *recurrence* — a silent `String.replace` no-op let an unrelated commit ship a fully dead Setup panel to 1.7.13, and nothing in the build or CI noticed; (2) injection **order** is the actual contract, not the marker's mere presence, so any future edit that relocates the marker re-breaks the panel; (3) restoring the marker resumes loading a 12-binding global script in the shipped extension, which would be a fatal `SyntaxError` on any name collision. Mitigations: restore the marker **and** route `getSetupHtml`/`getBoardHtml` through the existing `injectTransportShim()` fallback so a missing marker degrades to "inject before the first script" plus a loud `console.warn` instead of silence; keep the marker immediately adjacent to the inline `<script>`; collision-check `sharedDefaults.js`'s 12 top-level bindings against `setup.html` (done — zero overlap, zero declarations, three reads).

## Proposed Changes

### `src/webview/setup.html`

**Context.** Single inline `<script>` at line 1760, no external script tags. The marker that both hosts key their `sharedDefaults.js` / `transport.js` injection off was deleted from line 1760 by commit `3224366` on 2026-07-23.

**Logic.** Restore the marker on its own line immediately above the inline `<script>`, matching `kanban.html:3452-3453` and `implementation.html:1633` exactly (marker line, then the script line, nothing between).

**Implementation.**

```html
    <!-- SHARED_DEFAULTS_SCRIPT -->
    <script>
        const vscode = acquireVsCodeApi();
        const clientOriginatorId = Math.random().toString(36).substring(2) + Date.now().toString(36);
```

Do **not** move the `clientOriginatorId` wrapper or any other line — this is a one-line insertion restoring the pre-`3224366` state.

**Edge Cases.** Exactly one marker. `content.replace()` with a string argument replaces only the first occurrence, so a duplicate marker would leave a stray literal comment in the served HTML (harmless, but wrong) — assert the count is 1.

### `src/services/headlessPanelHtml.ts`

**Context.** `injectTransportShim()` (line 52-60) already implements marker-with-fallback and is used by `getProjectHtml` (186), `getPlanningHtml` (224), and `getDesignHtml` (262). `getBoardHtml` (114-115) and `getSetupHtml` (283-284) instead inline a bare `content.replace(marker, …)` with no fallback and no failure signal — the mechanism that let this bug ship.

**Logic.** Convert both to `injectTransportShim`, passing the post-nonce-pass inline-script string as the fallback anchor, and make the fallback branch warn. Both files run `content.replace(/<script>/g, \`<script nonce="${nonce}">\`)` *before* shim injection (`getBoardHtml:113`, `getSetupHtml:282`), so by injection time the first inline tag is literally `<script nonce="${nonce}">` — that is the correct anchor string. Keep the ordering as-is: the nonce pass must run first (the injected `<script src…>` tags carry their own nonce and must not be rewritten by the regex pass).

**Implementation.**

In `injectTransportShim`, make the fallback observable:

```typescript
function injectTransportShim(content: string, nonce: string, marker: string, firstScript: string): string {
    const shim = `<script src="/static/webview/sharedDefaults.js" nonce="${nonce}"></script>\n<script src="/static/webview/transport.js" nonce="${nonce}"></script>`;
    // If a marker comment exists (kanban.html / setup.html shape), replace it.
    if (content.includes(marker)) {
        return content.replace(marker, shim);
    }
    // Otherwise inject before the first script tag (design.html / project.html shape).
    // A panel that has neither the marker nor the expected first-script string would
    // silently lose `acquireVsCodeApi` and die on its first statement — the exact
    // failure that shipped in 1.7.13 — so say so loudly.
    if (!content.includes(firstScript)) {
        console.error('[headlessPanelHtml] transport shim NOT injected: no marker and no first-script anchor. The panel will throw on acquireVsCodeApi().');
        return content;
    }
    console.warn('[headlessPanelHtml] SHARED_DEFAULTS_SCRIPT marker missing — injected the shim before the first script instead.');
    return content.replace(firstScript, `${shim}\n${firstScript}`);
}
```

In `getBoardHtml`, replace lines 114-115 with:

```typescript
    content = injectTransportShim(content, nonce, '<!-- SHARED_DEFAULTS_SCRIPT -->', `<script nonce="${nonce}">`);
```

In `getSetupHtml`, replace lines 283-284 with the identical call.

**Edge Cases.**
- The fallback anchor `<script nonce="${nonce}">` matches the *first* inline script in the document. For `setup.html` and `kanban.html` there is only one, so the anchor is unambiguous. If a future panel gains an earlier inline script the shim still lands before it — which is what we want.
- `console.warn`/`console.error` here go to the host's stdout (standalone) or the extension host log — not to the user's UI. Per project convention, do not add UI banners for a state that is a build defect rather than a user condition.

### `src/services/SetupPanelProvider.ts`

**Context.** Line 1590 runs the `/<script>/g` nonce pass; line 1593 injects `sharedDefaults.js` via the same bare marker replace. `transport.js` is deliberately **not** injected here (`transport.js:12-14` — the real VS Code bridge is used in the webview), so this site cannot reuse `injectTransportShim` verbatim.

**Logic.** Keep injecting only `sharedDefaults.js`, but fall back to the first inline-script anchor when the marker is absent, and warn.

**Implementation.**

```typescript
        // Inject shared defaults
        const sharedDefaultsUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'dist', 'webview', 'sharedDefaults.js')).toString();
        const sharedDefaultsTag = `<script src="${sharedDefaultsUri}" nonce="${nonce}"></script>`;
        const marker = '<!-- SHARED_DEFAULTS_SCRIPT -->';
        if (content.includes(marker)) {
            content = content.replace(marker, sharedDefaultsTag);
        } else {
            const firstScript = `<script nonce="${nonce}">`;
            console.warn('[SetupPanelProvider] SHARED_DEFAULTS_SCRIPT marker missing in setup.html — injecting sharedDefaults.js before the first inline script.');
            content = content.replace(firstScript, `${sharedDefaultsTag}\n${firstScript}`);
        }
```

**Edge Cases.** If the nonce pass at line 1590 is ever reordered after this block the anchor string stops matching — keep the nonce pass first. The `webview.asWebviewUri` result is host-specific and must stay inside this provider (never leaks into the shared headless module).

## Verification Plan

Compilation and automated test execution are **out of scope for this pass** per session directive; the checks below are manual/browser-level. Testing is done against an installed VSIX — `dist/` in the repo is not served during development.

1. **Marker present exactly once:** `grep -c 'SHARED_DEFAULTS_SCRIPT' src/webview/setup.html` → `1`.
2. **Browser cockpit — tab switching:** Open the browser cockpit, navigate to the Setup panel. Click each tab (Setup, Database, Control Plane, Multi-Repo, ClickUp, Linear, Notion, Plan Scanner, Theme, Status Bar, Remote). Each tab should switch its content panel and persist the active tab.
3. **Browser cockpit — no console errors:** Open the browser dev tools console. There should be no `ReferenceError: acquireVsCodeApi is not defined` and no `ReferenceError: DEFAULT_VISIBLE_AGENTS is not defined`. Confirm two script tags for `/static/webview/sharedDefaults.js` and `/static/webview/transport.js` appear in the served HTML **above** the inline script (view-source, not the live DOM).
4. **Extension — regression is repaired, not merely absent:** Open the Setup panel in VS Code and confirm in the webview dev tools that there is **no** `ReferenceError: DEFAULT_VISIBLE_AGENTS is not defined` (this error is present at HEAD before the fix — capture it first so the fix is demonstrably the cause of the repair). All tabs switch; the Prompts/agent-visibility controls that read `DEFAULT_VISIBLE_AGENTS` / `BUILT_IN_AGENT_LABELS` populate.
5. **Extension — no `SyntaxError`:** confirm the console shows no duplicate-declaration `SyntaxError` after `sharedDefaults.js` resumes loading (the collision check says there should be none).
6. **Browser cockpit — tab persistence:** Switch to a tab, refresh the page. The same tab should be restored (the transport shim's `getState`/`setState` uses localStorage, keyed `sb-state-setup`).
7. **Board unaffected:** open the Board in the browser cockpit and confirm it still loads and its verbs still work — `getBoardHtml` was re-routed through `injectTransportShim` and takes the marker branch, so behaviour must be byte-identical.
8. **Fallback actually fires:** temporarily delete the marker from a local copy of `setup.html`, serve the cockpit, and confirm the panel **still works** and the host log carries the `marker missing` warning. Restore the marker afterwards. This is the regression-proofing check — without it the hardening is unverified.

### Automated Tests

> **Update (review pass, 2026-07-29):** the coding pass skipped these; the review pass **ran the full suite and implemented the durable guard** described below as `src/test/webview-shim-injection-contract.test.js`, wired as `npm run test:contract:shim-injection` and invoked by `.github/workflows/integration-tests.yml`. See the **Review Pass** section at the end of this file. The original text is preserved verbatim:

Not run in this pass (session directive: skip tests). When tests are next touched, the cheap durable guard is a static assertion rather than a DOM test:

- A unit test over `getSetupHtml(repoRoot, root)` and `getBoardHtml(repoRoot, root)` asserting the returned `html` contains `src="/static/webview/transport.js"` **and** that its index is less than the index of `acquireVsCodeApi(` — i.e. asserting the *ordering contract*, not just presence. This is the assertion that would have caught `3224366`.
- A companion assertion that `SetupPanelProvider`-shaped injection yields a `sharedDefaults.js` tag before the first inline script.
- Optionally a `scripts/`-style check (matching the existing `*:check` convention: `parity:check`, `push-routing:check`, `verb-returns:check`) that fails when a webview HTML file references a `sharedDefaults.js` top-level binding without containing the marker. Cheaper than a DOM harness and enforceable in CI.

---

**Recommendation: Send to Intern.** Complexity 3 — a one-line regression revert plus a mechanical fail-soft guard on three known call sites. The diagnosis is complete and the collision/CSP/ordering risks are already discharged above; nothing is left to design.

## Completion Report
Restored deleted `<!-- SHARED_DEFAULTS_SCRIPT -->` marker comment in `src/webview/setup.html` to enable injection of `sharedDefaults.js` and `transport.js` scripts. Updated `src/services/headlessPanelHtml.ts` to route `getBoardHtml` and `getSetupHtml` through `injectTransportShim` with logging on fallback. Updated `src/services/SetupPanelProvider.ts` to include a fallback script injection anchor with a warning if the marker comment is missing in `setup.html`. No issues encountered.

---

## Review Pass — 2026-07-29

The implementation landed in commit `c332638` (swept up by an adjacent plan's auto-commit; the three files are unchanged since). Reviewed against this plan as the source of truth. **The plan-file note that tests were "out of scope per session directive" was treated as a record of what the coder did, not as an instruction — the full suite was executed independently.**

### Verified correct as-implemented (no change needed)

- `src/webview/setup.html:1760` — marker restored, **exactly one** occurrence, immediately above the sole inline `<script>` at 1761, with the `clientOriginatorId` wrapper untouched. Matches `kanban.html:3455-3457` / `implementation.html:1633-1635` shape.
- **Symbol-collision claim independently re-verified.** `sharedDefaults.js` declares 12 top-level bindings; `setup.html` declares **none** of them and *reads* exactly three (`DEFAULT_VISIBLE_AGENTS`, `BUILT_IN_AGENT_LABELS`, `PROMPT_OVERRIDE_EXCLUDED_KEYS`, one occurrence each). No duplicate-`const` `SyntaxError` risk.
- Ordering contract holds: nonce pass runs before shim injection at both re-routed sites; the marker branch is taken for `kanban.html` and `setup.html`, so board output is byte-identical.
- `/static/webview/sharedDefaults.js` resolves via `LocalApiServer._handleServeStatic` (`webview` static route, `Cache-Control: no-cache`); `transport.js` shim object is **not** frozen (`transport.js:297-298`), so setup.html's `postMessage` wrapper does take effect in the browser; `/setup/verb` is wired in both hosts (`LocalApiServer.ts:3306`, `bootstrap.ts:1011`).
- No `$`-substitution hazard in the `String.replace` replacement strings — base64 nonces cannot contain `$`.

### Findings and fixes applied

**MAJOR-1 — the "loud" fallback warning fired on the happy path.** `headlessPanelHtml.ts:65` warned unconditionally on the fallback branch, but the marker exists **only** in `kanban.html`, `setup.html` and `implementation.html`. For `project.html`, `planning.html` and `design.html` the first-script anchor **is** the designed path — so the warning fired on every render of three of the five panels, claiming a marker was "missing" from files that never had one. A signal with a 60%-per-pageload false-positive rate is worse than the silence it replaced.
*Fix:* added an `expectMarker` parameter to `injectTransportShim`; only `getBoardHtml` and `getSetupHtml` (the marker-shaped panels) pass `true`. The `console.error` no-anchor branch stays unconditional. Mutation-proved: with the pre-fix unconditional warn restored in the build output, the three "stay quiet" assertions fail.

**MAJOR-2 — the diagnosed CI hole was fixed with a `console.warn`.** This plan's root-cause section is explicit that the marker's absence is "indistinguishable from a successful injection at build time, at serve time, and in any log", and its Automated Tests subsection names the ordering assertion as "the assertion that would have caught `3224366`". It was not implemented: nothing in `package.json` or `.github/workflows/integration-tests.yml` failed if the marker were deleted again. The only guard shipped was a runtime warning in a host nobody is running when the commit lands.
*Fix:* implemented `src/test/webview-shim-injection-contract.test.js` (17 assertions) — ordering (`transport.js` / `sharedDefaults.js` byte offset **before** `acquireVsCodeApi(` and before the first binding use), marker cardinality and adjacency, the static cross-reference below, live fallback behaviour (automating manual verification item 8), and the no-anchor `console.error` branch. Wired as `test:contract:shim-injection` **and invoked by CI**.

**MAJOR-3 — "all three injection sites" is off by two.** `KanbanProvider.ts:11130` (kanban.html) and `TaskViewerProvider.ts:20604` (implementation.html) also use a bare `content.replace(marker, …)` with no fallback and no signal, and both targets dereference `sharedDefaults` bindings (kanban.html: `DEFAULT_VISIBLE_AGENTS`, `DEFAULT_ROLE_CONFIG`, `BUILT_IN_AGENT_LABELS`, `ROLE_KEYS`, `ROLE_ADDONS`; implementation.html: `DEFAULT_VISIBLE_AGENTS` ×3). Deleting the marker from either reproduces the identical fatal `ReferenceError`.
*Fix (via MAJOR-2, deliberately not by editing two more shipped provider files):* the new test statically cross-references **every** `src/webview/*.html` against the parsed binding list — any panel that reads a `sharedDefaults.js` top-level binding without carrying the marker fails CI. This covers all five injection sites at commit time, which is strictly stronger than a runtime warning, and respects the PRD's one-stream-per-provider-file rule and byte-compat contract. Bindings are parsed from `sharedDefaults.js`, not hardcoded, so a binding added tomorrow is covered the day it lands.

**NIT-4 —** manual verification item 8 (hand-delete the marker, confirm the panel survives) is now an automated assertion.

### Files changed in this review pass

| File | Change |
| :--- | :--- |
| `src/services/headlessPanelHtml.ts` | `injectTransportShim` gains `expectMarker` (default `false`); `getBoardHtml` / `getSetupHtml` pass `true` |
| `src/test/webview-shim-injection-contract.test.js` | **new** — 17 assertions (ordering, marker cardinality/adjacency, static cross-reference, fallback, no-anchor error) |
| `package.json` | **new** script `test:contract:shim-injection` |
| `.github/workflows/integration-tests.yml` | **new** CI step invoking that script |

### Validation results (all executed this pass)

| Check | Result |
| :--- | :--- |
| `tsc -p tsconfig.test.json --noEmit` | clean |
| `eslint src/services/headlessPanelHtml.ts` | 0 errors (28 pre-existing `{{ICON_*}}` naming-convention warnings, untouched region) |
| `npm run parity:check` | PASS |
| `npm run push-routing:check` | PASS (all five providers at baseline) |
| `npm run verb-returns:check` | PASS (Kanban 0/0, Planning 230/230, Design 9/9, TaskViewer 1/1, Setup 0/0 — ratchet unmoved, as predicted) |
| `npm run mirror:check` | PASS (46 files) |
| 7 CI-wired contract tests | PASS (11 / 7 / 21 / 18 / 33 / 11 / 11 assertions) |
| `test:contract:shim-injection` (new) | **17 passed, 0 failed** |
| `test:regression:plan-sync`, `test:regression:native-project-api` | PASS |
| **Mutation test A** — real test file run against a scratch tree with the `3224366` marker deletion reapplied | **3 assertions fail, exit 1** — the guard bites. The fallback ordering assertions still pass, confirming the hardening keeps the panel alive while CI reports the deletion |
| **Mutation test B** — pre-fix unconditional warn restored in build output | **3 assertions fail** — the `expectMarker` fix is load-bearing |

### Remaining risks

1. **Browser/extension UAT not performed by this pass** (no VS Code instance or cockpit driven here). Verification items 2–7 remain manual: browser tab switching, absence of both `ReferenceError`s, absence of a duplicate-declaration `SyntaxError` in the extension, tab persistence across refresh, board unaffected. Static evidence for each is strong (marker present and correctly placed, ordering asserted in CI, collision check re-verified, board takes the byte-identical marker branch), but the on-screen confirmation is outstanding.
2. `KanbanProvider.ts:11130` / `TaskViewerProvider.ts:20604` still have **no runtime fallback** — a marker deletion there is caught at CI time by the new static check, but if it somehow reached a build, those panels die rather than degrade. Deliberate trade: the CI gate is the stronger guard and avoids editing two shipped provider files under the one-stream-per-file rule.
3. **Injection ordering remains an implicit contract in the HTML.** The new test asserts the *served* ordering, so a relocation that breaks it now fails CI — but nothing prevents someone moving the marker away from the inline script and having the fallback quietly compensate.
4. `dist/` was not rebuilt (project rule: `dist/` is not served during development; testing is via an installed VSIX). A VSIX rebuild is required before this reaches the extension host.

### Review Completion Report

Reviewed the setup.html marker restoration against this plan and confirmed the core fix correct — marker present exactly once at `setup.html:1760`, injection ordering sound, symbol-collision and CSP claims independently re-verified, board output byte-identical. Fixed three MAJOR findings: the fallback `console.warn` fired on every render of `project`/`planning`/`design` (which legitimately have no marker), destroying the signal it existed to provide — gated behind a new `expectMarker` flag; the plan's own named durable guard was never implemented, leaving nothing in CI to catch a re-deletion — implemented as `src/test/webview-shim-injection-contract.test.js` (17 assertions, ordering-not-just-presence) and wired into `package.json` + `.github/workflows/integration-tests.yml`; and the plan's "three injection sites" undercounted by two (`KanbanProvider`, `TaskViewerProvider`), now covered by a static cross-reference of every webview HTML against the parsed `sharedDefaults.js` binding list. Files changed: `src/services/headlessPanelHtml.ts`, `src/test/webview-shim-injection-contract.test.js` (new), `package.json`, `.github/workflows/integration-tests.yml`. All verification executed and green — typecheck, lint, four ratchets, eight contract tests, two regression tests — plus two mutation tests proving both new guards fail when their regressions are reintroduced; the outstanding gap is browser/extension on-screen UAT, which this pass could not drive.
