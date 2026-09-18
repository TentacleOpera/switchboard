# Design Panel: Rename PREVIEWS to HTML and Promote Images to Its Own Top-Level Tab

## Goal

Rename the Design panel's `PREVIEWS` tab to `HTML`, remove Images from its source dropdown, and give Images its own top-level tab alongside STITCH / HTML / DESIGN SYSTEM.

### Problem Analysis & Root Cause

`src/webview/design.html` has three top-level tabs (`design.html:3618-3622`):

```html
<button class="shared-tab-btn active" data-tab="stitch">STITCH</button>
<button class="shared-tab-btn" data-tab="previews">PREVIEWS</button>
<button class="shared-tab-btn" data-tab="design">DESIGN SYSTEM</button>
```

`#previews-content` is a container holding a source dropdown with three values and three sibling sub-panels (`design.html:3739-3949`):

```html
<select id="previews-source-select">
  <option value="stitch-html">Stitch HTML</option>
  <option value="html-preview">HTML Previews</option>
  <option value="images">Images</option>
</select>
...
<div id="stitch-html-content" class="previews-subpanel active">…
<div id="html-preview-content" class="previews-subpanel">…
<div id="images-content" class="previews-subpanel">…
```

Two problems follow from this shape:

1. **The tab name lies about its contents.** "PREVIEWS" is a container noun that tells the user nothing; two of its three sources are HTML surfaces (cached Stitch screen HTML, and local HTML preview folders) and the third is an image browser. The honest name for the HTML pair is `HTML`.
2. **Images is buried one level deep for no reason.** Image browsing shares nothing with HTML preview: different sidebar (`#tree-pane-images`), different controls strip, different workspace filter (`#images-workspace-filter`), different preview container (`#image-preview-container-images`), different backend refresh path. It was collapsed into the PREVIEWS dropdown as a container-consolidation exercise, and the comment at `design.html:219-222` records that: *"These three panes were `.shared-tab-content` before the PREVIEWS collapse; the dropdown handler now owns their visibility."* So Images was previously a first-class tab and lost that status; this restores it.

**The backend already treats these as separate surfaces**, which is what makes the change cheap. `DesignPanelProvider` keys off the *effective* source id, never `'previews'`:

- `_isPolledTab` → `tab === 'html-preview' || tab === 'claude' || tab === 'images'` (`DesignPanelProvider.ts:4306`)
- `refreshDocsForTab` dispatch table has explicit `'html-preview'` and `'images'` entries (`DesignPanelProvider.ts:3906-3914`)
- persisted tab keys include `'images'` and `'activeTab'` (`DesignPanelProvider.ts:2499`)

and `selectPreviewsSource` already posts the effective surface up, with the reason spelled out (`design.js:185-187`):

```js
// Seat protocol: report the EFFECTIVE surface, never 'previews' —
// _isPolledTab / seat preview-clearing key on the original ids.
vscode.postMessage({ type: 'activeTabChanged', tab: state.previewsSource });
```

**Root cause:** a purely front-end container decision. The provider's surface vocabulary (`stitch`, `html-preview`, `images`, `design`) never changed; only `design.html` and `design.js` wrapped two of them behind a dropdown named PREVIEWS. Reversing the wrap for Images and renaming the label is a front-end restructure with no provider contract change.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, refactor
- **Project:** Browser Switchboard
- **Files touched:** `src/webview/design.html`, `src/webview/design.js`
- **Risk:** Low-medium — no backend change, but the tab/sub-panel visibility rules and the persisted-tab restore path both need to learn the new `images` top-level tab, or Images opens blank.

## User Review Required

None. Tab name and Images placement were both specified.

## Complexity Audit

### Routine
- Rename the `PREVIEWS` button label to `HTML`.
- Delete the `Images` `<option>` from `#previews-source-select`.
- Add an `IMAGES` tab button.
- Move `#images-content` out of `#previews-content` and re-class it as a `.shared-tab-content`.
- Add `#images-content` to the two CSS rule lists that give tab containers their `display` behaviour.

### Complex / Risky
- **`switchTab` must gain an `images` arm.** It currently has `stitch`, `previews`, and an else-branch; the else-branch posts `activeTabChanged` but never triggers a docs refresh, so a naive addition gives an Images tab that renders its chrome and no files.
- **The persisted-tab restore path double-encodes the old shape.** `design.js:3207-3220` accepts `'images'` as a *previews source* and rewrites it to `activeTab: 'previews'`. Left alone, a user whose last surface was Images lands on the HTML tab after this change. This is shipped persisted state (`persistTab('activeTab', …)` and `persistTab('previews.source', …)`), so it needs a remap, not a deletion.
- **`state.previewsSource` may hold `'images'` on first boot after upgrade**, which would then match no sub-panel and leave the HTML tab empty. Needs a sanitising read.

## Edge-Case & Dependency Audit

1. **Restored `activeTab === 'images'` (new) vs restored `previews.source === 'images'` (legacy).** Both must land on the new IMAGES tab. Handle by mapping a restored `previews.source` of `'images'` to `activeTab: 'images'` and dropping it from the previews-source whitelist.
2. **`validTabs` gate.** `design.js:3219` guards `switchTab` with `['stitch','previews','design']`; `'images'` must be added or the restore silently no-ops.
3. **Zoom engine.** `zoomState` already has an `images` entry and `_fitPending.images` exists (`design.js:265-275`). Promoting the container does not change the element ids the zoom code queries (`#image-preview-container-images`, `#image-preview-img-images`), so panning/zooming survives — confirm by exercising it.
4. **CSS height contract.** Tab containers use `height: calc(100vh - 40px)` with `display:none` / `.active{display:flex}` (`design.html:198-215`); the previews sub-panel rule uses `flex: 1 1 auto; min-height: 0; overflow: hidden` (`design.html:222-232`). `#images-content` must adopt the *container* rule set, and its inner `.content-row` must keep filling the container — a mis-port yields a zero-height sidebar.
5. **`#previews-content .previews-subpanel` is a descendant selector.** Once `#images-content` moves out of `#previews-content` it loses that rule entirely; if the class attribute is left as `previews-subpanel` the pane is unstyled and permanently visible. The class must change.
6. **Two-option dropdown.** With Images gone, `#previews-source-select` has two entries. Keep it (the tab still switches between Stitch HTML and local HTML preview folders) rather than replacing it with a second tab bar.
7. **`activeTabChanged` seat protocol.** The IMAGES tab must post `tab: 'images'` — the value `_isPolledTab` and the seat preview-clearing logic already expect. Posting `'previews'` or nothing breaks polling.
8. **Deep link from the Stitch gallery.** `design.js:2384-2411` sets `state.previewsSource = 'stitch-html'` then clicks `[data-tab="previews"]`. The selector must be updated in lockstep with the renamed button's `data-tab`. **Decision: keep `data-tab="previews"` unchanged** and rename only the label — the identifier is referenced by that deep link, by `#previews-content`, by `persistTab('previews.source', …)` and by the provider's persisted key list. Renaming the label is the whole ask; renaming the id is gratuitous churn.
9. **No provider change needed.** Confirmed by grep: `DesignPanelProvider` contains no `'previews'` literal.

## Dependencies

- None

## Adversarial Synthesis

Key risks: a legacy persisted `previews.source: 'images'` / `activeTab: 'images'` restore landing on a blank HTML tab; the moved `#images-content` losing the descendant-selector CSS and rendering unstyled or permanently visible; a naive `switchTab` addition that renders Images chrome with no files. Mitigations: remap both legacy keys at restore and widen `validTabs`; re-class the container and add it to both CSS rule lists; the explicit `images` arm posts both `activeTabChanged` and `refreshDocsForTab`. No provider contract change — verified by grep.

## Proposed Changes

### `src/webview/design.html`

**1. Tab bar** (line 3618-3622) — rename PREVIEWS, add IMAGES:

```html
<div id="research-tab-bar" class="shared-tab-bar">
    <button class="shared-tab-btn active" data-tab="stitch">STITCH</button>
    <!-- data-tab stays "previews": it keys #previews-content, the
         persistTab('previews.source') state, and the Stitch gallery's
         deep link. Only the label changes. -->
    <button class="shared-tab-btn" data-tab="previews">HTML</button>
    <button class="shared-tab-btn" data-tab="images">IMAGES</button>
    <button class="shared-tab-btn" data-tab="design">DESIGN SYSTEM</button>
</div>
```

**2. Source dropdown** (line 3741-3745) — drop Images:

```html
<select id="previews-source-select" class="workspace-filter-select" style="max-width:220px; margin-bottom:0;">
    <option value="stitch-html">Stitch HTML</option>
    <option value="html-preview">HTML Previews</option>
</select>
```

**3. Move `#images-content`** out of the `#previews-content` element (it currently closes at line 3948, immediately before `#previews-content`'s closing `</div>`) to a sibling position after `#previews-content`, and re-class it:

```html
<!-- Images Tab (promoted out of the PREVIEWS dropdown: it shares no sidebar,
     controls strip, workspace filter or preview container with the HTML panes) -->
<div id="images-content" class="shared-tab-content">
    <div class="controls-strip" id="controls-strip-images">
    …unchanged inner markup…
</div>
```

**4. CSS** — add `#images-content` to both tab-container rule lists (lines 198-215):

```css
#local-content,
#online-content,
#kanban-content,
#design-content,
#previews-content,
#images-content,
#tickets-content { display: none; flex-direction: column; height: calc(100vh - 40px); background: var(--panel-bg); }

#local-content.active,
…
#previews-content.active,
#images-content.active,
#tickets-content.active { display: flex; }
```

Add `min-height: 0` to `#images-content` if the inner `.content-row` does not already establish it, so the sidebar and preview pane can scroll rather than overflow.

### `src/webview/design.js`

**1. `selectPreviewsSource`** (line 177-199) — two valid sources only:

> **Superseded:** `state.previewsSource = (source === 'stitch-html' || source === 'html-preview') ? source : 'stitch-html';`
> **Reason:** Cross-subtask reconciliation — the sibling plan *Previews Tab Must Default Its Source Dropdown to "HTML Previews"* makes `'html-preview'` the default at every other site in this file; a `'stitch-html'` fallback here would re-introduce the remote-call default through the sanitiser path.
> **Replaced with:** the same whitelist guard falling back to `'html-preview'` (this is the single reconciled end-state for the assignment line both plans touch — apply once):

```js
function selectPreviewsSource(source) {
    // 'images' is a top-level tab now; a legacy persisted value must not
    // select a sub-panel that no longer lives here. Fallback is 'html-preview'
    // to match the new default (local readdir, no Stitch API call).
    state.previewsSource = (source === 'stitch-html' || source === 'html-preview')
        ? source
        : 'html-preview';
    …unchanged…
}
```

**2. `switchTab`** (line 210-259) — add an `images` arm before the else:

```js
} else if (tabName === 'previews') {
    selectPreviewsSource(state.previewsSource);
} else if (tabName === 'images') {
    vscode.postMessage({ type: 'activeTabChanged', tab: 'images' });
    vscode.postMessage({ type: 'refreshDocsForTab', tab: 'images' });
} else {
    vscode.postMessage({ type: 'activeTabChanged', tab: tabName });
}
```

**3. `sbTransportReconnected` handler** (line 41-45) — the reconnect re-assert must not translate `images` into a previews source:

```js
let activeTab = activeTabBtn ? activeTabBtn.dataset.tab : (state.activeTab || 'stitch');
if (activeTab === 'previews') {
    activeTab = state.previewsSource || 'stitch-html';
}
// 'images' already IS the effective surface id — pass it through unchanged.
```

**4. `restoredTabState` handler** (line 3207-3225) — remap legacy state and widen `validTabs`:

```js
const restoredPreviewsSource = (msg.panel || {})['previews.source'];
if (restoredPreviewsSource && ['stitch-html', 'html-preview'].includes(restoredPreviewsSource)) {
    state.previewsSource = restoredPreviewsSource;
}

let restoredTab = (msg.panel || {})['activeTab'];
// Legacy shape: Images used to be a PREVIEWS source, so both keys could
// carry 'images'. Either now means the top-level IMAGES tab.
if (restoredTab === 'images' || restoredPreviewsSource === 'images') {
    restoredTab = 'images';
} else if (['stitch-html', 'html-preview'].includes(restoredTab)) {
    state.previewsSource = restoredTab;
    restoredTab = 'previews';
}

const validTabs = ['stitch', 'previews', 'images', 'design'];
```

## Verification Plan

### Automated Tests

None run — the dispatch directive excludes compilation and automated tests from this verification. The change is webview-only with no provider edit, so existing per-provider tests are untouched; signal comes from the static checks and UAT below.

1. **Static check:** `grep -n "previews-subpanel" src/webview/design.html` returns only the two HTML sub-panels; `grep -n "'images'" src/webview/design.js` shows the new `switchTab` arm and the restore remap.
2. **UAT — tab bar** reads `STITCH  HTML  IMAGES  DESIGN SYSTEM`.
3. **UAT — HTML tab.** Open it: the source dropdown offers exactly `Stitch HTML` and `HTML Previews`, no Images entry. Switching between them swaps sub-panels as before.
4. **UAT — Images tab.** Open it: the images controls strip, workspace filter, search box and sidebar render; configured image folders list their files; selecting one previews it; zoom in / out / reset / fit all work; the sidebar collapse toggle works.
5. **UAT — persistence.** Select IMAGES, reload the panel → IMAGES is still active. Select HTML with source `HTML Previews`, reload → HTML tab active with `HTML Previews` selected.
6. **UAT — legacy state migration.** Before the change, leave the panel on PREVIEWS → Images (so `previews.source` persists as `images`). Apply the change, reload → the panel opens on the new IMAGES tab, not on an empty HTML tab.
7. **UAT — Stitch deep link.** From the STITCH gallery, click a screen's HTML preview button: it must still jump to the HTML tab with `Stitch HTML` selected and the screen loaded.
8. **UAT — polling.** With the IMAGES tab open, add a file to a configured images folder; it appears without a manual refresh (confirms `activeTabChanged: 'images'` reached `_isPolledTab`).

## Review Findings

Reviewed against plan requirements: tab bar reads STITCH/HTML/IMAGES/DESIGN SYSTEM, source dropdown has only Stitch HTML + HTML Previews, `#images-content` is a `shared-tab-content` sibling with correct CSS, `switchTab` has an `images` arm posting `activeTabChanged`+`refreshDocsForTab`, legacy `previews.source==='images'` remaps to the IMAGES tab, and `validTabs` includes `'images'`. Files changed: `src/webview/design.html` (tab bar, dropdown, CSS, images-content promotion, tooltip fix), `src/webview/design.js` (selectPreviewsSource whitelist, switchTab images arm, reconnect handler, restoredTabState remap). One MAJOR finding fixed: stale "PREVIEWS → Stitch HTML" tooltip text in `design.html:4038` and `design.js:2428` updated to "HTML → Stitch HTML" to match the renamed tab. Verification: `tsc --noEmit` (no new errors), `eslint` (no new warnings), 4 design/stitch test suites (54 tests total, all pass), `push-routing:check`/`parity:check`/`verb-returns:check` all pass. Remaining risk: stale CSS comment at `design.html:220` references "three panes" (now two) — cosmetic only.
