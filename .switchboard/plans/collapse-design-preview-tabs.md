# Plan: Collapse Design-Panel Preview Tabs into One "Previews" Tab with a Persisted Source Dropdown

## Goal
Collapse the three preview-oriented tabs in the Design Panel — **STITCH HTML**, **HTML PREVIEWS**, and **IMAGES** — into a single **PREVIEWS** tab whose content source is chosen by a dropdown (Stitch HTML | HTML Previews | Images). Persist the selected source across panel reloads. Leave **STITCH** (a generation/input surface) and **DESIGN SYSTEM** as their own tabs. This declutters the tab bar while preserving every existing preview capability.

### Problem Context
The Design Panel currently has six top-level tabs. Three of them — STITCH HTML, HTML PREVIEWS, IMAGES — are all *browse/preview* surfaces over folder-backed artifacts. They differ only in what they render (Stitch-generated HTML, arbitrary HTML pages, image files), not in interaction model. Six tabs is visual clutter; three of them collapse naturally into one.

### Root Cause Analysis
- **One axis modeled as three tabs:** "which preview source" is a single selection axis, currently spread across three sibling tabs. A source dropdown is the correct control for a single-select axis.
- **Established precedent already in this file:** the **DESIGN SYSTEM** tab already implements exactly this pattern — a `#design-source-select` dropdown (Local / Stitch / Claude) that shows/hides `#design-local-panel` vs `#design-systems-panel`. The Planning panel does the same with `#docs-source-filter` inside a single DOCS tab. This plan reuses that pattern rather than inventing one.

## Metadata
- **Tags:** frontend, ui, ux, refactor, cleanup
- **Complexity:** 5

## User Review Required
- Confirm the collapsed tab label: **PREVIEWS** (alternatives: OUTPUTS, GALLERY).
- Confirm the dropdown default when no persisted selection exists: **Stitch HTML** (first option).
- Confirm persistence scope: remember the last-selected source per panel session via `vscode.setState` (matches the existing `activeTab` / design-source persistence). This plan assumes **yes, persist**.

## Complexity Audit

### Routine
- Replace the three tab buttons (`data-tab="stitch-html"`, `data-tab="html-preview"`, `data-tab="images"`) in `#research-tab-bar` with a single `data-tab="previews"` button.
- Add a `#previews-content` `.shared-tab-content` wrapper containing a source dropdown (`#previews-source-select`) modeled on `#design-source-select`, and move the three existing content bodies inside it as sub-panels (`#stitch-html-content`, `#html-preview-content`, `#images-content`).
- Add a `change` handler on `#previews-source-select` that shows the selected sub-panel and hides the others, and persists the choice.

### Complex / Risky
- **Persistence + restore:** add `previewsSource` to the `vscode.setState` payload (mirror `saveState`/`getState` usage in `design.js`, e.g. ~lines 2070, 4585). On load, read the persisted value, set the dropdown, and reveal the matching sub-panel. If the persisted `activeTab` was one of the removed tab ids (`stitch-html` / `html-preview` / `images`), map it to `previews` and set the dropdown to the corresponding source.
- **Programmatic tab navigation:** existing code jumps directly to removed tabs, e.g. `document.querySelector('[data-tab="stitch-html"]')?.click()` (`design.js` ~line 2554) after a Stitch generation completes. Every such call site must be redirected to: click the PREVIEWS tab, set `#previews-source-select` to the intended source, and fire the source-change handler.
- **`validTabs` + restore guard:** update the `validTabs` array (`design.js` ~line 3399) to replace the three removed ids with `previews`, and ensure the restore path (~line 3398) tolerates legacy persisted ids by mapping them forward.

## Edge-Case & Dependency Audit
- **Per-source sub-state must survive the move:** each sub-panel keeps its own workspace filter, search box, sidebar-collapse state, and (for Images) zoom/pan listeners. Moving the markup under `#previews-content` must not change element ids, so existing handlers (`initZoomListeners('image-preview-container-images', …)`, search/filter bindings, `toggleSidebarCollapsed` branches for `#tree-pane-html` / `#tree-pane-images` / `#tree-pane-stitch-html`) keep resolving. Prefer relocating the existing DOM subtrees verbatim rather than rewriting them.
- **Message routing unchanged:** the provider broadcasts `htmlDocsReady`, image previews, and Stitch-HTML updates keyed by `sourceId`. Because sub-panel element ids are preserved, the webview message handlers need no routing changes — only the *visibility* toggle moves from tab-switch to dropdown-change.
- **Hidden sub-panels still receive updates:** currently a background `htmlDocsReady` updates the HTML tree even when the tab is not active. Preserve that: the dropdown controls visibility only; data handlers still run for all three sub-panels so switching sources shows fresh content without a reload.
- **CSS active-display rules:** the `#*-content.active { display: … }` rules that currently gate the three tabs must be reworked so the *outer* `#previews-content.active` governs the tab, and an inner mechanism (e.g. a `.previews-subpanel.active` class or inline `display`) governs which source shows. Update every theme group (default, `.cyber-theme-enabled`, `body.theme-claudify`) consistently.
- **Interaction with the Briefs-cut plan:** independent of `cut-briefs-tab-design-panel.md`. If Briefs is still present, this collapse takes the panel from 6 tabs to 4; after both plans, to 3 (STITCH, PREVIEWS, DESIGN SYSTEM). Neither plan depends on the other; apply in either order.

## Proposed Changes

### `src/webview/design.html`
1. In `#research-tab-bar`, replace the `stitch-html`, `html-preview`, and `images` buttons with a single:
   ```html
   <button class="shared-tab-btn" data-tab="previews">PREVIEWS</button>
   ```
2. Add a `#previews-content` `.shared-tab-content` wrapper. At its top, a source strip modeled on the Design System source selector:
   ```html
   <div style="display:flex; gap:8px; padding:6px 12px; border-bottom:1px solid var(--border-color,#333); background:var(--panel-bg2,#1a1a1a);">
       <select id="previews-source-select" class="workspace-filter-select" style="max-width:220px;">
           <option value="stitch-html">Stitch HTML</option>
           <option value="html-preview">HTML Previews</option>
           <option value="images">Images</option>
       </select>
   </div>
   ```
3. Move the existing `#stitch-html-content`, `#html-preview-content`, and `#images-content` subtrees inside `#previews-content` as sub-panels, **preserving all inner element ids**. Give each a common class (e.g. `previews-subpanel`) for visibility toggling.
4. Rework the active-display CSS: `#previews-content.active` gates the tab; `.previews-subpanel` defaults to `display:none` and the selected one gets shown (via `.active` class or inline style). Apply across default, cyber, and claudify theme groups.

### `src/webview/design.js`
1. `validTabs` (~line 3399): replace `'stitch-html'`, `'html-preview'`, `'images'` with `'previews'`.
2. Add a `#previews-source-select` `change` handler: hide all `.previews-subpanel`, show the selected one, then `saveState()`.
3. Persistence: add `previewsSource` to the `vscode.setState` payload; on init, read it (default `'stitch-html'`), set the dropdown value, and apply the visibility toggle.
4. Restore mapping: in the panel-state restore path (~line 3398), if `activeTab` is a legacy `stitch-html`/`html-preview`/`images`, set `activeTab='previews'` and `previewsSource` to that value.
5. Redirect programmatic navigation: replace `document.querySelector('[data-tab="stitch-html"]')?.click()` (~line 2554) and any analogous `[data-tab="html-preview"]` / `[data-tab="images"]` clicks with a helper `selectPreviewsSource(source)` that clicks the PREVIEWS tab, sets the dropdown, and fires the change handler.
6. Leave `initZoomListeners('image-preview-container-images', …)`, search/filter bindings, and `toggleSidebarCollapsed` branches unchanged (ids preserved).

### `src/services/DesignPanelProvider.ts`
- No functional change expected (routing is by preserved `sourceId`). If the provider persists/echoes `activeTab`, extend it to also round-trip `previewsSource`, and map legacy `activeTab` values forward on read.

## Verification Plan

### Automated Tests
- `npm run compile` to confirm the webview bundle builds; no schema/verb changes expected.

### Manual Verification
1. Open the Design Panel — confirm the tab bar shows STITCH, PREVIEWS, DESIGN SYSTEM (plus BRIEFS only if that cut plan hasn't been applied).
2. In PREVIEWS, switch the dropdown across Stitch HTML / HTML Previews / Images and confirm each sub-panel renders correctly, including image zoom/pan and per-source search/filter.
3. Confirm each sub-panel's sidebar-collapse state and workspace filter behave independently and persist across reloads.
4. Select Images, reload the webview, and confirm PREVIEWS reopens with the Images source selected (persistence).
5. Run a Stitch generation and confirm the post-generation navigation lands on PREVIEWS with the Stitch HTML source selected (redirected `.click()` path).
6. Load a panel state persisted with a legacy `activeTab` of `stitch-html`/`html-preview`/`images` and confirm it opens PREVIEWS with the mapped source (forward-migration of persisted tab id).
7. Verify no CSS regressions in default and cyber themes; confirm hidden sub-panels still receive background `htmlDocsReady` updates (switching sources shows current content without a manual refresh).

## Risk Assessment
- **Medium.** The mechanical move of three subtrees under one wrapper is low-risk *if* element ids are preserved. The real risks are: (1) the active-display CSS rework regressing visibility in one theme; (2) missed programmatic `.click()` navigations to the removed tab ids leaving dead post-generation jumps; (3) forgetting to forward-map legacy persisted `activeTab` values, stranding returning users on a missing tab. All three are covered by the verification steps and mitigated by preserving ids and adding the legacy-id mapping.

**Recommendation:** Send to Coder
