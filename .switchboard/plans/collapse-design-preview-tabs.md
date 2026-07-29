# Plan: Collapse Design-Panel Preview Tabs into One "Previews" Tab with a Persisted Source Dropdown

## Goal
Collapse the three preview-oriented tabs in the Design Panel — **STITCH HTML**, **HTML PREVIEWS**, and **IMAGES** — into a single **PREVIEWS** tab whose content source is chosen by a dropdown (Stitch HTML | HTML Previews | Images). Persist the selected source across panel reloads. Leave **STITCH** (a generation/input surface) and **DESIGN SYSTEM** as their own tabs. This declutters the tab bar while preserving every existing preview capability.

### Problem Context
The Design Panel currently has six top-level tabs. Three of them — STITCH HTML, HTML PREVIEWS, IMAGES — are all *browse/preview* surfaces over folder-backed artifacts. They differ only in what they render (Stitch-generated HTML, arbitrary HTML pages, image files), not in interaction model. Six tabs is visual clutter; three of them collapse naturally into one.

### Root Cause Analysis
- **One axis modeled as three tabs:** "which preview source" is a single selection axis, currently spread across three sibling tabs. A source dropdown is the correct control for a single-select axis.
- **Established precedent already in this file:** the **DESIGN SYSTEM** tab already implements exactly this pattern — a `#design-source-select` dropdown (Local / Stitch / Claude) that shows/hides `#design-local-panel` vs `#design-systems-panel`. The Planning panel does the same with `#docs-source-filter` inside a single DOCS tab. This plan reuses that pattern rather than inventing one.

## Metadata
- **Tags:** frontend, ui, ux, refactor
- **Complexity:** 6

> **Superseded:** Complexity: 5.
> **Reason:** Code verification found a hidden functional dependency the original plan missed: the provider's per-seat protocol (`activeTabChanged` → `seat.activeTab` → `_isPolledTab` → external-file polling and preview auto-refresh) keys on the ORIGINAL tab ids. A naive collapse that reports `'previews'` silently kills folder polling and preview refresh for every collapsed surface. Handling this correctly (the effective-tab protocol below) adds coordination risk.
> **Replaced with:** Complexity: 6 (medium — multi-file, one subtle cross-layer protocol to preserve; still "Send to Coder").

## User Review Required
- Confirm the collapsed tab label: **PREVIEWS** (alternatives: OUTPUTS, GALLERY).
- Confirm the dropdown default when no persisted selection exists: **Stitch HTML** (first option).
- Confirm persistence scope: remember the last-selected source per panel via the provider-side tab-state store (`persistTab` → `persistTabState` → `_stateStore`), matching how `activeTab` is persisted today. This plan assumes **yes, persist**.

> **Superseded:** "Confirm persistence scope: remember the last-selected source per panel session via `vscode.setState` (matches the existing `activeTab` / design-source persistence)."
> **Reason:** Factually wrong about the existing mechanism. `activeTab` is NOT persisted via `vscode.setState` — it is persisted via `persistTab('activeTab', tabName)` (`design.js:209`) → `persistTabState` message → provider `_stateStore` (`DesignPanelProvider.ts:2497-2508`), and restored via the `restoredTabState` payload built from the `tabKeys` allowlist in the provider's `ready` handler (`:2460-2470`). `vscode.setState` is only used for minor webview-local bits (pane collapse states, folder-modal state) and does not reach browser-surface clients.
> **Replaced with:** Persist via the tab-state store: `persistTab('previews.source', source)` on change, add `'previews.source'` to the provider's `tabKeys` array, read it back in the `restoredTabState` handler.

## Complexity Audit

### Routine
- Replace the three tab buttons (`data-tab="stitch-html"` at `design.html:3634`, `data-tab="html-preview"` at `:3636`, `data-tab="images"` at `:3637`) with a single `data-tab="previews"` button.
- Add a `#previews-content` `.shared-tab-content` wrapper containing a source dropdown (`#previews-source-select`) modeled on `#design-source-select`, and move the three existing content subtrees (`#stitch-html-content` `:3784`, `#html-preview-content` `:3875`, `#images-content` `:3943`) inside it as sub-panels, preserving every inner element id.
- Add a `change` handler on `#previews-source-select` that shows the selected sub-panel, hides the others, and persists the choice.
- Add `'previews.source'` to the provider `tabKeys` allowlist (`DesignPanelProvider.ts:2460`) — one-line, additive.

### Complex / Risky
- **Effective-tab protocol (the load-bearing change):** the provider's seat/polling machinery keys on original tab ids — `activeTabChanged` clears `seat.htmlPreview`/`seat.stitchHtmlPreview` when the reported tab differs (`DesignPanelProvider.ts:2539-2552`), `_isPolledTab` only polls for `'html-preview' | 'claude' | 'images' | 'briefs'` (`:4307-4309`), and the poll loop reads folder sets per tab id (`:4362-4394`). The webview must keep reporting the *effective surface* (`'stitch-html'`/`'html-preview'`/`'images'`) in `activeTabChanged` whenever the PREVIEWS tab is active, so the provider needs no seat/poll changes at all.
- **Tab-switch loop vs nested sub-panels:** `switchTab` strips `.active` from EVERY `.shared-tab-content` whose id doesn't match the incoming tab (`design.js:154-172`). If the moved panes keep that class, entering PREVIEWS deactivates all three sub-panels and the pane goes blank. The moved panes must swap `shared-tab-content` for a new `previews-subpanel` class so the dropdown handler solely owns their visibility.
- **CSS id-specificity:** `#html-preview-content` / `#images-content` appear in an id-based display block (`design.html:175-198`) whose `display:none` + `height: calc(100vh - 40px)` beat any class rule on specificity. Those two ids must be removed from that block so the new `.previews-subpanel` rules own display and height (nested panels must flex-fill under the source strip, not re-claim full viewport height).
- **Restore + legacy mapping:** update `validTabs` (`design.js:3434`) and the restore path (`:3432-3440`) to map legacy persisted ids forward.

## Edge-Case & Dependency Audit

### Race Conditions
- **Transport reconnect (browser surface):** `design.js:9-20` re-asserts `activeTabChanged` on `sbTransportReconnected`. This site must also report the effective tab (source id when PREVIEWS is active), or a reconnect would desync the seat and stop polling. (Pre-existing defect at this site, out of scope but note: it queries `.tab-button.active`, a class that doesn't exist in this webview — buttons use `shared-tab-btn` — so it always falls through to `state.activeTab || 'html-preview'`, and `state.activeTab` is never written. Flagged to the user in review; this plan only requires the site to route through the same effective-tab helper.)
- **Restore vs default:** the initial `switchTab(initialTab)` at load (`design.js:219-220`) runs before `restoredTabState` arrives; the restore handler then switches if the persisted tab differs — same two-step as today, no new race. The persisted `previews.source` must be applied before (or atomically with) any restore-driven `switchTab('previews')` so the effective-tab report is correct on first activation.

### Security
- No new surface. No new verbs (persistTabState already exists in `DESIGN_VERB_SCHEMAS` with a free-form `tabKey`), no new routes, no new file access. The provider change is one string in an allowlist array.

### Side Effects
- **Hidden sub-panels still receive updates:** provider broadcasts (`htmlDocsReady`, image lists, Stitch-HTML updates) render into the DOM regardless of visibility today; because element ids are preserved and message handlers are untouched, this behavior survives. The dropdown governs visibility only.
- **Per-source sub-state survives:** workspace filters (`html.root`, `images.root`, `stitchHtml.projectId` etc. in the tab-state store), search boxes, sidebar-collapse state, and image zoom/pan (`zoomState` keys at `design.js:223-228` are name-based, not tab-id-based) all keep working because ids and handlers are unchanged.
- **Seat preview-clearing semantics preserved:** with the effective-tab protocol, `seat.stitchHtmlPreview`/`seat.htmlPreview` clearing on tab exit (`DesignPanelProvider.ts:2542-2550`) behaves exactly as before — switching the dropdown from Stitch HTML to Images reports `'images'` and clears `seat.stitchHtmlPreview`, matching today's tab-switch behavior.

### Dependencies & Conflicts
- **`cut-briefs-tab-design-panel.md`:** independent — neither plan depends on the other; apply in either order. Both edit `validTabs` (`design.js:3434`) and the tab bar (`design.html:3633-3638`); whichever lands second resolves a trivial merge conflict at those two sites. Panel goes 6→4 tabs with this plan alone, 6→3 after both (STITCH, PREVIEWS, DESIGN SYSTEM).
- **Per-client view-state work (uncommitted, in-flight):** this plan builds ON that mechanism (`persistTab`/`_stateStore`/seats). Coordinate: this plan must be coded against the tree with that work present.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) breaking external-file polling and preview auto-refresh by reporting `'previews'` to the seat protocol — eliminated by the effective-tab design, which keeps the provider untouched; (2) blank sub-panels from `switchTab`'s global `.shared-tab-content` deactivation loop — eliminated by re-classing the moved panes; (3) stranding returning users whose persisted `activeTab` is a removed id — covered by the forward-mapping in the restore path. Mitigations are structural (protocol/class design), not test-only.

## Proposed Changes

### `src/webview/design.html`
1. In the tab bar (`:3633-3638`), replace the `stitch-html`, `html-preview`, and `images` buttons with a single:
   ```html
   <button class="shared-tab-btn" data-tab="previews">PREVIEWS</button>
   ```
2. Add a `#previews-content` `.shared-tab-content` wrapper (flex column). At its top, a source strip modeled on the Design System source selector:
   ```html
   <div style="display:flex; gap:8px; padding:6px 12px; border-bottom:1px solid var(--border-color,#333); background:var(--panel-bg2,#1a1a1a);">
       <select id="previews-source-select" class="workspace-filter-select" style="max-width:220px;">
           <option value="stitch-html">Stitch HTML</option>
           <option value="html-preview">HTML Previews</option>
           <option value="images">Images</option>
       </select>
   </div>
   ```
3. Move the existing `#stitch-html-content` (`:3784`), `#html-preview-content` (`:3875`), and `#images-content` (`:3943`) subtrees verbatim inside `#previews-content`, **preserving all inner element ids**. On each moved root, replace class `shared-tab-content` with `previews-subpanel`.

> **Superseded:** "Give each a common class (e.g. `previews-subpanel`) for visibility toggling" [in addition to `shared-tab-content`] and "Rework the active-display CSS … Apply across default, cyber, and claudify theme groups."
> **Reason:** Two verified code facts change the mechanism. (a) `switchTab` strips `.active` from every `.shared-tab-content` whose id isn't `${tabName}-content` (`design.js:154-172`), so sub-panels keeping that class would be force-deactivated whenever any tab switch happens — the class must be *replaced*, not supplemented. (b) The theme groups need almost no rework: cyber/claudify rules on these panes are id-based styling (`design.html:2230`, `:2313`) that keeps applying unchanged; only the id-based *display/height* block (`:175-198`) conflicts, because `#html-preview-content { display:none; height: calc(100vh - 40px) }` beats any class rule on specificity.
> **Replaced with:** (i) moved panes swap `shared-tab-content` → `previews-subpanel`; (ii) remove `#html-preview-content` and `#images-content` (and their `.active` partners) from the id-based display block at `:175-198` (`#stitch-html-content` was never in it); (iii) add one new theme-agnostic block: `#previews-content .previews-subpanel { display:none; flex-direction:column; flex:1 1 auto; min-height:0; }` and `#previews-content .previews-subpanel.active { display:flex; }`; (iv) leave all id-based theme styling rules untouched.

### `src/webview/design.js`
1. `validTabs` (`:3434`): current value is `['stitch', 'briefs', 'html-preview', 'images', 'design']` — replace `'html-preview'` and `'images'` with `'previews'` (keep `'briefs'` unless the briefs-cut plan has landed).

> **Superseded:** "`validTabs` (~line 3399): replace `'stitch-html'`, `'html-preview'`, `'images'` with `'previews'`."
> **Reason:** Verified: `'stitch-html'` is NOT in the current `validTabs` array (`design.js:3434`) — a pre-existing gap, meaning a persisted `activeTab` of `'stitch-html'` never restored anyway (it silently fell back to the default tab). There is nothing to remove for it; there IS a persisted-value population to map forward, since `switchTab` has been persisting `'stitch-html'` all along.
> **Replaced with:** Replace `'html-preview'`/`'images'` with `'previews'`; the legacy-mapping step below handles all three old ids (including `'stitch-html'`, incidentally fixing the pre-existing restore gap).

2. Add a helper owning source selection (the single choke point):
   ```js
   function selectPreviewsSource(source) {
       // source: 'stitch-html' | 'html-preview' | 'images'
       const sel = document.getElementById('previews-source-select');
       if (sel && sel.value !== source) sel.value = source;
       document.querySelectorAll('#previews-content .previews-subpanel').forEach(p => {
           p.classList.toggle('active', p.id === source + '-content');
       });
       // Seat protocol: report the EFFECTIVE surface, never 'previews' —
       // _isPolledTab / seat preview-clearing key on the original ids.
       vscode.postMessage({ type: 'activeTabChanged', tab: source });
       // Per-source tab-entry behavior, relocated from switchTab:
       if (source === 'stitch-html') {
           populateStitchHtmlProjectSelect(state.stitchProjects || []);
           vscode.postMessage({ type: 'stitchListProjects', workspaceRoot: state.stitchWorkspaceRoot });
       } else {
           vscode.postMessage({ type: 'refreshDocsForTab', tab: source });
       }
       persistTab('previews.source', source);
   }
   ```
   Wire it to the dropdown's `change` event; track the current source in `state.previewsSource` (default `'stitch-html'`).
3. `switchTab` (`:156-210`): on `tabName === 'previews'`, call `selectPreviewsSource(state.previewsSource)` instead of the removed per-tab branches (the `'stitch-html'` branch at `:191-198` moves into the helper; the `refreshDocsForTab` gate at `:203` drops `'html-preview'`/`'images'`, which now refresh via the helper). `persistTab('activeTab', 'previews')` (`:209`) stays as-is — `activeTabChanged` reports the effective source; `activeTab` persistence records the outer tab.
4. Restore path (`:3432-3440`): read `(msg.panel || {})['previews.source']` into `state.previewsSource` (default `'stitch-html'`); if the persisted `activeTab` is a legacy `'stitch-html'`/`'html-preview'`/`'images'`, map it to `'previews'` with `state.previewsSource` set to the legacy value before calling `switchTab`.
5. Redirect the one programmatic navigation to a removed tab:

> **Superseded:** "existing code jumps directly to removed tabs, e.g. `document.querySelector('[data-tab=\"stitch-html\"]')?.click()` (`design.js` ~line 2554) after a Stitch generation completes. Every such call site must be redirected…"
> **Reason:** Verified: there is exactly ONE such call site, at `design.js:2589`, and it is not a post-generation jump — it is the "Open in HTML Tab" button handler in the Stitch screen preview (`:2565-2591`), which pre-selects the project, posts `stitchHtmlListDocs`, clicks the tab, then opens the screen's cached file. The `[data-tab="stitch"]` clicks at `:3485` and `:5240-5242` target a surviving tab and need no change; there are no `[data-tab="html-preview"]` or `[data-tab="images"]` programmatic clicks.
> **Replaced with:** In that handler, replace the `.click()` line with: click the PREVIEWS tab button, then `selectPreviewsSource('stitch-html')`; keep the surrounding `stitchHtmlListDocs` post and `loadDocumentPreview` call unchanged.

6. Reconnect handler (`:9-20`): report the effective tab — if the active tab is `'previews'`, send `state.previewsSource`; otherwise send the active tab id.
7. Leave `initZoomListeners`, search/filter bindings, and `toggleSidebarCollapsed` branches (`:529`: `#tree-pane-html` / `#tree-pane-images` / `#tree-pane-stitch-html`) unchanged — ids preserved.

### `src/services/DesignPanelProvider.ts`

> **Superseded:** "No functional change expected (routing is by preserved `sourceId`). If the provider persists/echoes `activeTab`, extend it to also round-trip `previewsSource`, and map legacy `activeTab` values forward on read."
> **Reason:** Half right, and the wrong half was dangerous. Routing needs no change, but the provider's seat/poll machinery (`activeTabChanged` handler `:2539-2552`, `_isPolledTab` `:4307-4309`, `_polledTabsAcrossSeats` `:4311-4322`, poll-signature loop `:4362-4394`, `checkAndRefresh` `:4684-4710`) keys on original tab ids. Without the webview-side effective-tab protocol, external-file polling and preview auto-refresh silently die for all three collapsed surfaces — the panel would LOOK collapsed-and-working while background refresh is gone. Legacy-mapping on the provider read side is unnecessary; the webview restore path owns the mapping.
> **Replaced with:** Exactly one provider change: add `'previews.source'` to the `tabKeys` array in the `ready` handler (`:2460`) so the persisted source is included in the `restoredTabState` payload. All seat/poll code is untouched because the webview keeps reporting effective tab ids.

## Verification Plan

### Automated Tests
- None — session directive: skip compilation and automated tests for this plan. (Per repo build rule, `dist/` is not used during development; no compile step is required to validate `src/` changes.)

> **Superseded:** "`npm run compile` to confirm the webview bundle builds; no schema/verb changes expected."
> **Reason:** Session directive forbids compilation in this plan's verification. The "no schema/verb changes" half stands (persistTabState's schema takes any `tabKey`).
> **Replaced with:** Manual verification only, below.

### Manual Verification
1. Open the Design Panel — confirm the tab bar shows STITCH, PREVIEWS, DESIGN SYSTEM (plus BRIEFS only if that cut plan hasn't been applied).
2. In PREVIEWS, switch the dropdown across Stitch HTML / HTML Previews / Images and confirm each sub-panel renders correctly, including image zoom/pan and per-source search/filter.
3. Confirm each sub-panel's sidebar-collapse state and workspace filter behave independently and persist across reloads.
4. Select Images, reload the webview, and confirm PREVIEWS reopens with the Images source selected (persistence via `previews.source`).
5. In the Stitch tab, open a screen preview and click "Open in HTML Tab" — confirm it lands on PREVIEWS with the Stitch HTML source selected and the screen's cached HTML open (redirected `:2589` path).
6. With a tab-state store carrying a legacy `activeTab` of `stitch-html` / `html-preview` / `images`, open the panel and confirm it opens PREVIEWS with the mapped source (forward-migration of persisted tab id).
7. **Poll-preservation check (the regression this plan is most likely to cause):** with PREVIEWS active on HTML Previews, create a new `.html` file in a configured folder from OUTSIDE VS Code — confirm the tree picks it up without switching tabs (proves `_isPolledTab` still sees `'html-preview'`). Repeat for Images.
8. While PREVIEWS shows Images, drop a new file into an HTML folder, then switch the dropdown to HTML Previews — confirm the new file is listed (hidden sub-panels still receive background updates).
9. Verify no CSS regressions in default, cyber, and claudify themes — the moved panes' id-based theme rules must still apply inside the wrapper.

## Risk Assessment
- **Medium.** The DOM move is low-risk with ids preserved. The real risks are: (1) any `activeTabChanged` path reporting `'previews'` to the provider, silently killing folder polling and preview auto-refresh — mitigated by routing every report through `selectPreviewsSource`/the effective-tab rule and by Manual Verification step 7; (2) sub-panel blanking via `switchTab`'s global `.shared-tab-content` deactivation — mitigated by re-classing the moved panes; (3) id-specificity fights in the legacy display block — mitigated by removing the two ids from that block. Legacy persisted tab ids are forward-mapped, incidentally fixing the pre-existing `'stitch-html'` restore gap.

**Recommendation:** Send to Coder

## Completion Report
Implemented single PREVIEWS tab replacing STITCH HTML, HTML PREVIEWS, and IMAGES tabs in the Design Panel. Added `#previews-source-select` dropdown with state persistence (`previews.source`) and legacy tab forward mapping. Preserved seat/polling protocols by emitting effective surface tab IDs in `activeTabChanged`.

Files modified:
- `src/services/DesignPanelProvider.ts`: Added `'previews.source'` to `tabKeys` allowlist.
- `src/webview/design.html`: Collapsed preview tab buttons into PREVIEWS tab, added `#previews-source-select` strip, wrapped subpanels with `previews-subpanel` class, and updated CSS rules.
- `src/webview/design.js`: Added `selectPreviewsSource` helper, updated `switchTab`, `sbTransportReconnected`, `restoredTabState`, and redirected Stitch screen HTML button click.

No issues encountered.

---

## Code Review — Reviewer Pass (2026-07-30)

### Verdict
The two load-bearing mechanisms this plan identified as its real risks are implemented **correctly**, and both were verified against the provider rather than taken on the plan's word:
- **Effective-tab protocol holds.** All three `activeTabChanged` emitters were audited (`design.js:33`, `:173`, `:232`, `:236`); none can emit `'previews'`. `_isPolledTab` (`DesignPanelProvider.ts:4365-4367`) still sees `'html-preview'`/`'images'`, so external-file polling and preview auto-refresh survive. The provider diff is exactly the one authorized string at `:2559`.
- **Sub-panel blanking avoided.** The three moved panes carry only `previews-subpanel` (no residual `shared-tab-content`), so `switchTab`'s global deactivation loop cannot reach them. The id-based display block removals match the pre-change file exactly (`#html-preview-content`/`#images-content` and their `.active` partners removed; `#stitch-html-content` was never in it).
- **Two bonus repairs beyond the plan's scope, both confirmed correct:** the reconnect handler's selector was fixed (`.tab-button.active` → `.shared-tab-btn.active`, `design.js:27`), closing the pre-existing defect the plan only promised not to worsen; and the legacy forward-map (`:3189-3192`) covers `'stitch-html'`, which was never in `validTabs`, incidentally fixing a long-standing restore gap. The `|| restoredTab === 'previews'` clause at `:3197` is load-bearing (it forces source application when the tab is already correct, and re-persists `activeTab` so a legacy value self-heals).

### Findings and fixes applied

**MAJOR — cyber-theme background regression (fixed).** `#previews-content` was added to the base display block (`design.html:181`) where it picks up `background: var(--panel-bg)` = `#000000`, but was **omitted from the cyber transparent list** at `:2199-2205`. Pre-change, `#html-preview-content`/`#images-content` were direct children of `.container` and explicitly transparent, and `#stitch-html-content` had no background rule at all — all three let the body's `#171717` + cyan grid (`:2125-2132`) show through. Wrapping them in an opaque parent hid that grid, so PREVIEWS rendered flat black while STITCH and DESIGN SYSTEM kept the grid — in the panel's default shipped theme (`<body class="cyber-theme-enabled">`, `:3599`). **Fix:** added `.cyber-theme-enabled #previews-content` (and `#stitch-html-content` for completeness) to the transparent list. Specificity checked: `1 id + 1 class` beats the base `1 id` rule, and it is later in source order.

**MAJOR — `Open in HTML Tab` doubled an outbound Stitch API call (fixed).** `design.js:2384-2385` did `.click()` on the PREVIEWS button and *then* called `selectPreviewsSource('stitch-html')`. The click routes through `switchTab('previews')` → `selectPreviewsSource(state.previewsSource)`, which in the common case (`state.previewsSource === 'stitch-html'`, the default) already posted `stitchListProjects` — so the explicit second call posted it again. `stitchListProjects` **always** refreshes from the Stitch API (`DesignPanelProvider.ts:3397-3400`), so this was a genuine duplicate external round trip on a hot user path, and a regression against the old single-`.click()` behavior. When the prior source was `'images'`, the click additionally fired a spurious `refreshDocsForTab: 'images'` (a recursive 10-deep readdir of every configured image folder, `:4497-4528`) plus a `seat.stitchHtmlPreview` clear/un-clear cycle. **Fix:** set `state.previewsSource = 'stitch-html'` before the click so the click's own routing does the work exactly once, with an explicit `selectPreviewsSource` fallback if the button is absent.

**NIT — `.previews-subpanel` had dropped `overflow: hidden` (fixed).** The class it replaced (`.shared-tab-content`, `:3558-3563`) provided it; the replacement reproduced `display`, `flex-direction`, and `flex` but not the clipping. Nothing was visibly broken (`.content-row`'s own `overflow:hidden` covered it), but the panes hold iframes and zoom-transformed canvases that should stay clipped. Restored, with a comment explaining why.

**NIT — source strip lacked `flex-shrink: 0` (fixed).** Every `.controls-strip` in this file has it (`:216`); the new inline-styled strip did not. `min-height: auto` floored it in practice, but the guard is free.

**NIT — tooltips named a deleted tab (fixed).** `design.html:4022` and `design.js:2368` both read "…in the **Stitch HTML tab**…", a tab that no longer exists in the tab bar. Reworded to "under PREVIEWS → Stitch HTML" in both places, and the adjacent code comment at `design.js:2360` updated to match. The visible button label "Open in HTML Tab" was left alone — renaming it is a separate copy decision outside this plan.

### Gate-wiring audit
This plan's `### Automated Tests` subsection names **no** automated checks (it declared manual verification only), so there is no plan-named check to audit for CI wiring — and no new check was added by this work that could sit defined-but-unwired. For the record, the pre-existing CI gates that do cover these files are all invoked by `.github/workflows/integration-tests.yml`: `test:contract:design-view-state` (:79), `test:contract:stitch-html-tab` (:82), `test:contract:design-system` (:53), `test:contract:design-asset` (:47), `test:contract:design-reply-addressing` (:50), `test:contract:shim-injection` (:85), plus `compile`, `compile-tests`, `parity:check`, `verb-returns:check`, `mirror:check`. Two suites (`test:contract:verb-engine`, `test:contract:verb-engine-planning`) are deliberately unwired with a documented red-cause rationale at `:67-76` — pre-existing and unrelated to this change.

### Validation results (executed in this review pass)
The plan's note that compilation and tests were skipped is a record of the coding session, not a directive to the reviewer; the dispatch prompt carried no `SKIP TESTS:`/`SKIP COMPILATION:` line, so verification was run independently — **after** the fixes above.

| Check | Result |
|---|---|
| `tsc -p tsconfig.test.json --noEmit` | ✅ clean |
| `node --check src/webview/design.js` | ✅ syntax OK |
| `eslint src/webview/design.js src/services/DesignPanelProvider.ts` | ✅ 0 errors (153 pre-existing style warnings) |
| `npm run compile` (webpack) | ✅ compiled (3 pre-existing optional-dep warnings) |
| `test:contract:design-view-state` | ✅ 11 passed, 0 failed |
| `test:contract:stitch-html-tab` | ✅ 11 passed, 0 failed |
| `test:contract:design-system` | ✅ 21 passed, 0 failed |
| `test:contract:design-asset` | ✅ 11 passed, 0 failed |
| `test:contract:design-reply-addressing` | ✅ 7 passed, 0 failed |
| `test:contract:shim-injection` | ✅ 17 passed, 0 failed |
| `parity:check` / `verb-returns:check` / `mirror:check` / `catalog:check` | ✅ all pass, no drift |

### Files changed by this review pass
- `src/webview/design.html` — cyber transparent list (+`#previews-content`, +`#stitch-html-content`); `.previews-subpanel` gains `overflow: hidden`; source strip gains `flex-shrink: 0`; `preview-btn-html` tooltip reworded.
- `src/webview/design.js` — `Open in HTML Tab` handler no longer double-dispatches `selectPreviewsSource`; tooltip string and adjacent comment reworded.

### Remaining risks
- **No automated coverage for the collapse itself.** The seat/poll protocol is exercised by `design-view-state` at the provider level, but nothing asserts that the *webview* reports an effective source rather than `'previews'`. A regression there would be silent (folders stop polling; the panel still looks fine) and would only surface via the plan's Manual Verification step 7. A small DOM-free contract test over `design.js`'s emitter set would close this — worth its own plan.
- **Manual steps still owed.** Steps 2, 3, 7, 8, and 9 of the Manual Verification plan require a running panel: per-source zoom/pan and filter independence, the two poll-preservation checks, hidden-sub-panel background updates, and a visual pass on cyber/claudify now that the wrapper transparency is fixed.
- **Pre-existing, out of scope, worth its own plan:** `persistTab('stitchModelId')`, `persistTab('stitchCreativeRange')`, `persistTab('stitchAspects')`, `persistTab('stitchHtml.projectId')` and `persistTab('stitch.projectId')` (`design.js:4072`, `:4079`, `:4093`, `:2375`, `:2679`) all write to the tab-state store but appear in **neither** the panel nor byRoot side of the `tabKeys` allowlist (`DesignPanelProvider.ts:2559`) — they persist and are never restored. This predates the plan and is exactly the failure mode the plan's one-line `tabKeys` addition guarded against for `previews.source`.
- **Merge note:** `cut-briefs-tab-design-panel.md` has already landed — the tab bar is STITCH / PREVIEWS / DESIGN SYSTEM (3 tabs), `validTabs` is `['stitch', 'previews', 'design']`, and `_isPolledTab` no longer lists `'briefs'`. No residual conflict.

### Reviewer completion summary
Reviewed the PREVIEWS collapse against this plan as source of truth. The effective-tab seat/poll protocol and the `previews-subpanel` re-classing — the two changes the plan flagged as load-bearing — are both correct, verified directly against `DesignPanelProvider.ts` rather than assumed. Fixed two real defects: `#previews-content` was missing from the cyber-theme transparent list, so the collapsed tab rendered flat black instead of showing the body grid in the default theme; and `Open in HTML Tab` double-dispatched `selectPreviewsSource`, duplicating an outbound Stitch API call (and firing a spurious recursive folder readdir when the prior source wasn't Stitch HTML). Also restored `overflow: hidden` on the moved panes, added `flex-shrink: 0` to the source strip, and reworded two tooltips that still named the deleted "Stitch HTML tab". Files touched: `src/webview/design.html`, `src/webview/design.js`. Verification ran independently of the plan's skip note and is fully green: tsc, eslint (0 errors), webpack, six design contract suites (78 assertions), and all four protocol ratchets.
