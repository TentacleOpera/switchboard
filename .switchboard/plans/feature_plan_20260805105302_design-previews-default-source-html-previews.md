# Design Panel: Previews Tab Must Default Its Source Dropdown to "HTML Previews"

## Goal

Make the Design panel's Previews tab open on the **HTML Previews** source instead of **Stitch HTML** when there is no persisted preference.

### Problem Analysis & Root Cause

The Previews tab's source dropdown (`src/webview/design.html:3741-3745`) offers `Stitch HTML`, `HTML Previews`, and `Images`. `Stitch HTML` is hardcoded as the default in four places in `src/webview/design.js`:

| Site | Code | Effect |
| --- | --- | --- |
| `design.js:75` | `previewsSource: 'stitch-html',` | initial in-memory state |
| `design.js:178` | `state.previewsSource = source \|\| 'stitch-html';` | fallback when `selectPreviewsSource` is called with nothing |
| `design.js:44` | `activeTab = state.previewsSource \|\| 'stitch-html';` | transport-reconnect re-assert |
| `design.html:3749` | `<div id="stitch-html-content" class="previews-subpanel active">` | first-paint active sub-panel before JS runs |

Choosing `stitch-html` as the default is actively costly, not merely arbitrary. `selectPreviewsSource` branches on it (`design.js:189-196`):

```js
if (state.previewsSource === 'stitch-html') {
    populateStitchHtmlProjectSelect(state.stitchProjects || []);
    vscode.postMessage({ type: 'stitchListProjects', workspaceRoot: state.stitchWorkspaceRoot });
} else {
    vscode.postMessage({ type: 'refreshDocsForTab', tab: state.previewsSource });
}
```

`stitchListProjects` is not a local read — the provider always hits the Stitch API on that path (`DesignPanelProvider.ts:3322-3380`: cache-then-network, *"then ALWAYS refresh from the API"*). So every open of the Previews tab with the default source fires a remote Stitch call, and if no Stitch project is selected the pane shows `No project selected` with an empty sidebar. `HTML Previews`, by contrast, is a pure local `readdir` over configured folders (`refreshDocsForTab` → `_sendHtmlDocsReady`) and shows content immediately.

**Root cause:** the default was set to the sub-panel that happened to be authored first (hence the hardcoded `active` class on `#stitch-html-content`), not to the source that renders useful content without a remote round-trip. Nothing derives the default from user behaviour or from which sources are configured.

## Metadata

- **Complexity:** 2
- **Tags:** frontend, ui, performance
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/design.js`, `src/webview/design.html`
- **Risk:** Low — a default-value change. The persisted-preference path is unchanged, so a user who has explicitly chosen Stitch HTML keeps it.

## User Review Required

None. The requested default was stated explicitly.

## Complexity Audit

### Routine
- Change three `'stitch-html'` default literals in `design.js` to `'html-preview'`.
- Move the hardcoded `active` class from `#stitch-html-content` to `#html-preview-content` so the pre-JS first paint matches.

### Complex / Risky
- **The persisted preference must still win.** `restoredTabState` (`design.js:3207-3210`) overwrites `state.previewsSource` from `previews.source` when it validates. That path runs *after* the initial `switchTab(initialTab)` call at `design.js:263-264`, so ordering matters: the initial paint may briefly show the new default before the restore lands. This is already the existing behaviour for every restored value in this panel and is acceptable, but it must not regress into the restore being *ignored*.
- **The Stitch-gallery deep link must keep forcing `stitch-html`.** `design.js:2404` sets `state.previewsSource = 'stitch-html'` before clicking the tab, with a comment explaining that pre-setting keeps the navigation to one `activeTabChanged` + one `stitchListProjects`. That explicit assignment must be left intact — it is not a default.

## Edge-Case & Dependency Audit

1. **First-paint flash.** `#stitch-html-content` carries `class="previews-subpanel active"` in markup so *something* is visible before JS runs. If only the JS defaults change, the very first frame shows the Stitch HTML pane and then swaps. Move the `active` class to `#html-preview-content` to eliminate the flash.
2. **`switchTab('previews')`** calls `selectPreviewsSource(state.previewsSource)` (`design.js:247-248`). With `state.previewsSource` initialised to `'html-preview'`, this now posts `refreshDocsForTab: 'html-preview'` on tab open — a local folder read. Confirm no `stitchListProjects` fires from merely opening the tab.
3. **No HTML preview folders configured.** The pane shows its own empty state ("Configure a folder…") rather than Stitch's "No project selected". Both are empty; the difference is that the HTML pane's empty state points at an action the user can take locally. Acceptable and preferable.
4. **Persisted `previews.source === 'stitch-html'`.** Must still restore to Stitch HTML. This is the main regression risk and is covered in verification.
5. **Transport reconnect.** `design.js:41-45` re-asserts the effective surface after a WebSocket reconnect; its fallback literal must change too or a reconnect while on the Previews tab reports `stitch-html` to the seat protocol while the UI shows the HTML pane.
6. **Provider seat protocol.** `'html-preview'` is already a first-class polled surface (`DesignPanelProvider.ts:4306`, `:3912`), so no backend change is required.
7. **Stitch API cost.** Removing the unconditional `stitchListProjects` on tab open is a straight reduction in remote calls; nothing depends on that call as a side effect (the Stitch tab issues its own on activation, `design.js:242-246`).

## Dependencies

- None

## Adversarial Synthesis

Key risks: the persisted preference being ignored (a permanent regression — the persisted value is rewritten on every switch), a first-paint flash if the markup `active` class is not moved in lockstep with the JS default, and the reconnect fallback literal being missed so the seat protocol is told `stitch-html` while the UI shows HTML Previews. Mitigations: the restore whitelist path is untouched and still wins; move the hardcoded `active` class to `#html-preview-content`; all four default sites are enumerated and changed, with a grep tripwire in verification. The change also removes an unconditional Stitch API call on tab open — a pure cost reduction.

## Proposed Changes

### `src/webview/design.js`

**1. Initial state** (line 75):

```js
// 'html-preview' is a local readdir; 'stitch-html' unconditionally hits the
// Stitch API (DesignPanelProvider stitchListProjects is cache-then-ALWAYS-network)
// and shows "No project selected" until one is picked. Default to the local one.
previewsSource: 'html-preview',
```

**2. `selectPreviewsSource` fallback** (line 178):

```js
state.previewsSource = source || 'html-preview';
```

**Shared surface:** the sibling plan *Rename PREVIEWS to HTML and Promote Images to Its Own Top-Level Tab* rewrites this same assignment with a two-value whitelist guard (it must reject a legacy persisted `'images'`). The reconciled end-state is the sibling's guard form with `'html-preview'` as the fallback — apply that single line once; this plan's edit is subsumed by it.

**3. Reconnect re-assert** (line 44):

```js
activeTab = state.previewsSource || 'html-preview';
```

### `src/webview/design.html`

Move the pre-JS `active` class so the first painted frame is the new default (lines 3749 and 3840):

```html
<!-- Stitch HTML Sub-panel -->
<div id="stitch-html-content" class="previews-subpanel">
…
<!-- HTML Previews Sub-panel — carries `active` so the pre-JS first paint
     matches the JS default in design.js (state.previewsSource). Keep the two
     in lockstep. -->
<div id="html-preview-content" class="previews-subpanel active">
```

## Verification Plan

### Automated Tests

None run — the dispatch directive excludes compilation and automated tests from this verification. Signal comes from the static checks and UAT below.

1. **Static check:** `grep -n "stitch-html'" src/webview/design.js` — the only remaining occurrences should be the deep-link assignment near line 2404, the `selectPreviewsSource` branch condition, and the restore whitelist. No default literals.
2. **UAT — fresh state.** Clear the panel's persisted tab state (or use a workspace that has never opened the Design panel), open Design → Previews. The dropdown reads `HTML Previews` and the HTML previews sidebar renders.
3. **UAT — no Stitch call on open.** With the Stitch API key configured, open Previews and confirm no Stitch project fetch is triggered (watch the Switchboard output channel / network); the status line must not read `No project selected`.
4. **UAT — persisted choice wins.** Select `Stitch HTML`, reload the panel: it reopens on Stitch HTML.
5. **UAT — no first-paint flash.** Reload with JS throttled (or watch the first frame): the HTML previews pane is the one that appears, never Stitch HTML first.
6. **UAT — Stitch deep link unaffected.** From the STITCH tab gallery, click a screen's HTML-preview action: it still lands on Previews with `Stitch HTML` selected and that screen open.
7. **UAT — reconnect.** With Previews open on HTML Previews, restart the API server so the transport reconnects; the pane stays on HTML Previews and files still refresh.

## Review Findings

Reviewed against plan requirements: initial state defaults to `'html-preview'` (`design.js:79`), `selectPreviewsSource` fallback is `'html-preview'` (`design.js:186-188`), reconnect fallback is `'html-preview'` (`design.js:44`), and the `active` class is on `#html-preview-content` not `#stitch-html-content` (`design.html:3847`). No remaining `'stitch-html'` default literals — all 8 occurrences are guards, branch conditions, the deep-link assignment, or restore whitelists. Files changed: `src/webview/design.js`, `src/webview/design.html`. No findings — implementation matches the plan exactly. Verification: `tsc --noEmit` (no new errors), 4 design/stitch test suites (54 tests, all pass), `push-routing:check`/`parity:check`/`verb-returns:check` all pass. No remaining risks.
