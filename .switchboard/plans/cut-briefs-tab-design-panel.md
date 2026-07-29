# Plan: Cut the Briefs Tab from the Design Panel

## Goal
Remove the **BRIEFS** tab from the Design Panel (`src/webview/design.html`) and its supporting code, reducing the panel's top-level tab count and eliminating a redundant local-markdown browser. The Briefs surface duplicates functionality already provided by the Design System "Local Docs" source and the Planning panel's docs browser; its only unique action is a single "Send to Stitch" button, which does not justify a dedicated top-level tab.

### Problem Context
The Design Panel currently exposes six top-level tabs: STITCH, STITCH HTML, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM. This is too many for one panel and creates visual clutter. The Briefs tab is a folder-backed markdown CRUD surface (new/edit/delete/search) scoped to "design briefs", plus one downstream action — `btn-send-brief-to-stitch`, which posts a `stitchSendBrief` message to create a Stitch project from the selected brief.

### Root Cause Analysis
- **Redundant surface:** Briefs is a fourth local-markdown file browser, overlapping the Design System tab's "Local Docs" source and the Planning panel's docs browser. It uses the same `LocalFolderService` → `postMessage` → provider architecture as those surfaces.
- **Not load-bearing:** The brief content is never injected into the planning or coding agent pipeline. Its sole consumer is the panel-local `stitchSendBrief` flow. Cutting it removes no agent-context capability.
- **Disproportionate weight:** Briefs carries a large brief-specific CSS block in `design.html` (dozens of `#markdown-preview-briefs …` rules and `#tree-pane-briefs` / `#briefs-content` rules across theme groups) and a large body of handlers in `design.js` — more code weight than several higher-value tabs.

## Metadata
- **Tags:** frontend, ui, ux, refactor, cleanup
- **Complexity:** 4

## User Review Required
- Confirm the brief `.md` files themselves must NOT be deleted — this plan removes only the UI/plumbing; user brief files stay untouched on disk in their configured folders.
- Confirm the `stitchSendBrief` "create Stitch project from brief" flow can be dropped entirely (no replacement entry point requested).

## Migration & Compatibility (published extension — ~4,000 installs)
`briefsFolderPaths` shipped in released versions of `LocalFolderService` (evidenced by the existing `_migratedBriefs` migration flag). Per the repo migration rule, this cut MUST stay legacy-tolerant:
- **Do NOT delete or throw on the `briefsFolderPaths` config key.** Keep `LocalFolderService`'s parse paths that read `parsed.briefsFolderPaths || []` intact so existing user configs continue to load without error. The key becomes inert (nothing reads it for UI), which is a safe no-op — not a breaking change.
- **Do NOT unlink any user brief files.** Removing the tab strands only the now-unused config key; the actual markdown files remain in the user's folders.
- Leaving the config-layer read tolerant is the migration-safe path; a stricter removal (folding `briefsFolderPaths` into another folder set) is explicitly out of scope to avoid touching released persistence semantics.

## Complexity Audit

### Routine
- Remove the `BRIEFS` tab button (`data-tab="briefs"`) from the `#research-tab-bar` in `src/webview/design.html`.
- Remove the entire `#briefs-content` tab pane (controls strip, tree pane, preview/editor panes) from `src/webview/design.html`.
- Remove all Briefs-specific CSS selectors in `src/webview/design.html` (`#briefs-content`, `#tree-pane-briefs`, `#markdown-preview-briefs …`, `#controls-strip-briefs`, and their `.cyber-theme-enabled` / `body.theme-claudify` variants).
- Remove `'briefs'` from the `validTabs` array in `src/webview/design.js` (~line 3399).
- Remove Briefs handlers, state, and event bindings in `src/webview/design.js` (rendering, search/filter, edit/save/cancel, `btn-send-brief-to-stitch`, `btn-new-brief`, `btn-delete-brief`, `btn-edit-brief`).

### Complex / Risky
- The sidebar-collapse helper (`toggleSidebarCollapsed`, `design.js` ~line 511) enumerates `#tree-pane-briefs` in its `closest(...)` chain; remove that branch cleanly so the chain still resolves for the remaining panes.
- The `stitchSendBrief` message has a backend handler in `src/services/DesignPanelProvider.ts` and may have a route in `src/services/LocalApiServer.ts`; both the send site (`design.js` ~line 2735) and the handler must be removed together, or an orphaned message/route remains.

## Edge-Case & Dependency Audit
- **Default/active tab:** If any persisted panel state has `activeTab === 'briefs'`, the restore path must fall back to a valid tab (e.g. `stitch`) rather than selecting a now-missing button. Verify the restore logic (`design.js` ~line 3398) tolerates an unknown/removed tab.
- **`stitchSendBrief` provider handler:** Removing the send site without removing the handler leaves dead code; removing the handler without the send site is fine but incomplete. Remove both. Confirm no other caller posts `stitchSendBrief`.
- **`LocalFolderService` brief methods:** `getBriefsFolderPaths` / `addBriefsFolderPath` / `removeBriefsFolderPath` / `listBriefsFiles` become unused once the UI is gone. They MAY be removed, but the config-key *parsing* (`parsed.briefsFolderPaths || []`) must remain (see Migration). Prefer removing the now-unused public methods while keeping the parse tolerance, OR leave the methods as dead-but-harmless if removal risks touching shared parse code — reviewer's call, guided by keeping released persistence intact.
- **Manage Folders modal:** If the shared "Manage Folders" modal has a Briefs section/tab, remove that section so it does not reference removed config setters.
- **CSS bleed:** Briefs CSS selectors are frequently grouped in comma-separated rules with HTML/Design equivalents. Remove ONLY the `-briefs` fragments from shared rules; do not delete the whole rule and regress the sibling tabs.

## Proposed Changes

### `src/webview/design.html`
1. Delete the `<button class="shared-tab-btn" data-tab="briefs">BRIEFS</button>` line from `#research-tab-bar`.
2. Delete the full `<!-- Briefs Tab --> <div id="briefs-content" class="shared-tab-content"> … </div>` block.
3. Delete or de-comma all Briefs-only CSS: every selector containing `briefs-content`, `tree-pane-briefs`, `markdown-preview-briefs`, `controls-strip-briefs`, `preview-pane-briefs`, including `.cyber-theme-enabled` and `body.theme-claudify` variants. Where a selector is shared (comma list), remove only the `-briefs` members.

### `src/webview/design.js`
1. Remove `'briefs'` from `validTabs` (~line 3399).
2. Remove the `#tree-pane-briefs` branch from `toggleSidebarCollapsed` (~line 511).
3. Remove brief rendering, state (`briefEditMode`, brief filter/search state, `_lastBriefsDocsMsg` or equivalent), and all `btn-*-brief` / `btn-send-brief-to-stitch` event bindings and helpers (including the `stitchSendBrief` post at ~line 2735 and the enable/disable logic at ~lines 1908–1909, 2725–2727).
4. Remove any `case 'briefsDocsReady'` (or equivalent) branch in the webview message listener.

### `src/services/DesignPanelProvider.ts`
1. Remove the `stitchSendBrief` message handler and any brief list/CRUD message handlers that only served the Briefs tab.

### `src/services/LocalApiServer.ts`
1. Remove any brief-only route/verb that only served the Briefs tab (verify against `verbAllowlist` / `verbSchemas`). Keep generic folder plumbing intact.

### `src/services/LocalFolderService.ts`
1. **Keep** all `parsed.briefsFolderPaths || []` parse tolerance (Migration).
2. Optionally remove the now-unused public brief methods (`getBriefsFolderPaths`, `addBriefsFolderPath`, `removeBriefsFolderPath`, `listBriefsFiles`) if no caller remains after the webview/provider cuts.

## Verification Plan

### Automated Tests
- If `verbAllowlist`/`verbSchemas` are generated, regenerate and confirm no dangling brief verb references break the build (`npm run compile`).

### Manual Verification
1. Open the Design Panel — confirm the tab bar shows STITCH, STITCH HTML, HTML PREVIEWS, IMAGES, DESIGN SYSTEM and **no BRIEFS tab**.
2. Confirm the remaining five tabs each open and render correctly (no CSS regressions in the default and cyber themes).
3. Confirm the Stitch tab still functions (its generation flow no longer depends on a "Send to Stitch from brief" entry point).
4. Load a config JSON that still contains `briefsFolderPaths` and confirm the panel loads without error (legacy-tolerant).
5. Confirm no console errors reference removed elements (`#briefs-content`, `btn-send-brief-to-stitch`, `stitchSendBrief`).
6. Confirm user brief markdown files on disk are untouched.

## Risk Assessment
- **Low–Medium.** Changes are mostly webview UI plus a small provider/route removal. The one real risk is regressing sibling tabs by over-deleting shared CSS rules or the `toggleSidebarCollapsed` chain — mitigated by removing only `-briefs` fragments and verifying the remaining tabs in both themes. Migration risk is avoided by keeping `briefsFolderPaths` parse tolerance and never deleting user files.

**Recommendation:** Send to Coder
