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
- **Tags:** frontend, ui, ux, refactor
- **Complexity:** 5

> **Superseded:** Complexity: 4.
> **Reason:** Code verification found the removal surface is substantially wider than the original plan enumerated: 6 provider verb handlers plus watchers/debounce/poller branches in `DesignPanelProvider.ts`, 5 verb schemas in `verbSchemas.ts`, the `getDesignAssetRoots` allowlist, the folders-modal scope machinery, and ~15 distinct `design.js` handler/state/message-case sites. Still mechanical deletion, but multi-file coordination with migration constraints.
> **Replaced with:** Complexity: 5 (medium — multi-file, moderate coordination, still "Send to Coder").

## User Review Required
- Confirm the brief `.md` files themselves must NOT be deleted — this plan removes only the UI/plumbing; user brief files stay untouched on disk in their configured folders.
- Confirm the `stitchSendBrief` "create Stitch project from brief" flow can be dropped entirely (no replacement entry point requested). Note this also removes the `stitchBriefInjected` auto-generate path on the Stitch tab, whose only producer is the `stitchSendBrief` handler.
- Confirm the headless/browser verb surface may drop the five brief verbs (`listBriefsFolders`, `addBriefsFolder`, `removeBriefsFolder`, `createBrief`, `deleteBrief`) — external HTTP callers of these verbs (if any exist) will get unknown-verb errors after the cut.

## Migration & Compatibility (published extension — ~4,000 installs)
`briefsFolderPaths` shipped in released versions of `LocalFolderService` (evidenced by the existing `_migratedBriefs` migration flag at `LocalFolderService.ts:160`). Per the repo migration rule, this cut MUST stay legacy-tolerant:
- **Do NOT delete or throw on the `briefsFolderPaths` config key.** Keep `LocalFolderService`'s parse paths that read `parsed.briefsFolderPaths || []` intact (`LocalFolderService.ts:138, 201` and the interface field at `:23`, defaults at `:103, 151, 217`) so existing user configs continue to load without error.
- **The parse tolerance is load-bearing for round-trip writes, not just for load.** `LocalFolderService` rewrites the whole config object when any folder set changes (the `cleanConfig` spread at `:160`). If parsing dropped `briefsFolderPaths`, the next `addHtmlFolderPath`/etc. write would silently DELETE the user's key. Keeping the field in the parsed shape is what preserves it across rewrites. The key becomes inert (nothing reads it for UI), which is a safe no-op — not a breaking change.
- **Do NOT unlink any user brief files.** Removing the tab strands only the now-unused config key; the actual markdown files remain in the user's folders.
- Leaving the config-layer read tolerant is the migration-safe path; a stricter removal (folding `briefsFolderPaths` into another folder set) is explicitly out of scope to avoid touching released persistence semantics.
- **Stale persisted view state is self-healing:** a persisted `activeTab === 'briefs'` in the tab-state store fails the `validTabs.includes(...)` check in the restore path (`design.js:3433-3440`) once `'briefs'` is removed from the array, so the panel falls back to the HTML default tab (STITCH). No state migration needed.

## Complexity Audit

### Routine
- Remove the `BRIEFS` tab button (`design.html:3635`, `data-tab="briefs"`) from the tab bar.
- Remove the entire `#briefs-content` tab pane (`design.html:3642-~3675`: controls strip, tree pane, preview/editor panes).
- Remove Briefs-specific CSS selectors in `design.html`: the `#briefs-content` members of the shared display block (`:181, :195`), collapsed-tree rules (`:300, :312`), `#tree-pane-briefs` (`:668`), the large `#markdown-preview-briefs` typography block (`:1027-1379`), cyber-theme variants (`:1061-1080, :2101, :2112, :2176, :2231`), claudify variants (`:2313, :2326`).
- Remove `'briefs'` from the `validTabs` array (`design.js:3434`).
- Remove Briefs handlers, state, and event bindings in `design.js` (full enumeration in Proposed Changes).
- Remove the five brief verb schemas from `DESIGN_VERB_SCHEMAS` (`verbSchemas.ts:121-137`).

### Complex / Risky
- The sidebar-collapse helper (`toggleSidebarCollapsed`, `design.js:527-548`) enumerates `#tree-pane-briefs` in its `closest(...)` chain (`:529`) and has a `briefsPreviewCollapsed` branch (`:543-544`); remove both cleanly so the chain still resolves for the remaining panes.
- The `stitchSendBrief` flow spans three sites that must be removed together: the send site (`design.js:2760-2776`), the provider handler (`DesignPanelProvider.ts:3954-4015`), and the webview-side `stitchBriefInjected` consumer case (`design.js:3479-3507`) whose only producer is that handler (`DesignPanelProvider.ts:4006`).
- Provider poller/watcher plumbing: `_isPolledTab` includes `'briefs'` (`DesignPanelProvider.ts:4308`), the external-file-poll signature loop has a `tab === 'briefs'` branch (`:4373-4375`), and `_briefsFolderWatchers`/`_briefsDocsDebounce` (`:221, :235, :842-843, :1466-1498`) must be torn out without disturbing the sibling tabs' watchers.
- CSS bleed: Briefs selectors are frequently grouped in comma-separated rules with sibling-tab equivalents (e.g. `design.html:180-198, :2230-2231`). Remove ONLY the `-briefs` members from shared rules; do not delete whole rules and regress sibling tabs.

## Edge-Case & Dependency Audit

### Race Conditions
- **Persisted `activeTab === 'briefs'` restore:** handled — the restore guard (`design.js:3433-3440`) only switches to tabs present in `validTabs`, so stale state falls back to the default tab. Verify, don't re-implement.
- **In-flight `briefsDocsReady` after teardown:** the provider's `_briefsDocsDebounce` can have a pending timeout when the removal lands only partially. Full removal of both the debounce and the `briefsDocsReady` webview case eliminates the window; there is no cross-session race because both ends ship in the same VSIX.

### Security
- **`getDesignAssetRoots` tightens:** remove `...service.getBriefsFolderPaths()` from the `GET /design/asset` allowlist (`DesignPanelProvider.ts:189`). This shrinks the headless asset-serving surface — a strict improvement. Nothing else serves brief folders.
- **Browser verb surface shrinks:** deleting the five brief verbs from `DESIGN_VERB_SCHEMAS` removes their headless/browser reachability (schema validation rejects unknown verbs before dispatch). No new surface is added anywhere.

### Side Effects
- The `briefsFolderPaths` config key becomes inert but is preserved on load AND on config rewrites (see Migration — the parse tolerance is what keeps the key alive through the `cleanConfig` spread).
- `saveState()` (`design.js:2104-2114`) currently persists `briefsPreviewCollapsed` via `vscode.setState`; removing the field leaves old persisted blobs carrying a dead key — harmless, `vscode.getState()` spreads preserve it.
- The provider's `ready` handler stops sending `briefsDocs` in the `designReadyComplete` payload (`DesignPanelProvider.ts:2487, :2494`); the browser transport fans out only nested payloads that exist, so no consumer breaks.
- External HTTP callers of the five brief verbs (if any) start receiving unknown-verb errors — flagged in User Review Required.

### Dependencies & Conflicts
- **`collapse-design-preview-tabs.md`:** independent — that plan touches the STITCH HTML / HTML PREVIEWS / IMAGES tabs and never references briefs. Apply in either order. Both plans edit `validTabs` (`design.js:3434`) and the tab bar (`design.html:3633-3638`), so whichever lands second resolves a trivial merge conflict at those two sites.
- **`verbSchemas.ts` / browser-surface work:** the brief verbs live in `DESIGN_VERB_SCHEMAS`, which the in-flight browser-surface work also touches. Coordinate the deletion with whatever state that file is in when coding starts.
- **`LocalApiServer.ts`:** no brief-specific routes exist (see Proposed Changes) — only two doc comments mention Briefs.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) over-deleting shared comma-grouped CSS rules and regressing sibling tabs — mitigated by removing only `-briefs` members and verifying the remaining tabs in all three themes; (2) leaving one end of the three-site `stitchSendBrief`/`stitchBriefInjected` flow orphaned — mitigated by the explicit three-site enumeration; (3) breaking released-config round-trips by removing parse tolerance — mitigated by the Migration section's explicit keep-list. All are deletion-scoping risks, not design risks.

## Proposed Changes

### `src/webview/design.html`
1. Delete the `<button class="shared-tab-btn" data-tab="briefs">BRIEFS</button>` line (`:3635`).
2. Delete the full `<!-- Briefs Tab --> <div id="briefs-content" class="shared-tab-content"> … </div>` block (`:3641-~3675`), including `#controls-strip-briefs`, `#briefs-workspace-filter`, `#btn-new-brief`, `#briefs-docs-search`, `#status-briefs`, `#tree-pane-briefs`, `#preview-pane-briefs`, `#markdown-preview-briefs`, `#markdown-editor-briefs`.
3. Delete or de-comma all Briefs-only CSS: `#briefs-content` in the shared display block (`:181, :195`), `.content-row.collapsed #tree-pane-briefs` rules (`:300, :312`), `#tree-pane-briefs` (`:668`), the `#markdown-preview-briefs` typography block (`:1027-1379`), cyber variants (`:1061, :1071, :1080, :2101, :2112, :2176, :2231`), claudify variants (`:2313, :2326`). Where a selector is a comma list shared with siblings, remove only the `-briefs` members.

### `src/webview/design.js`
1. Remove `'briefs'` from `validTabs` (`:3434`).
2. Remove the `#tree-pane-briefs` member of the `closest(...)` chain (`:529`) and the `briefsPreviewCollapsed` branch (`:543-544`) in `toggleSidebarCollapsed`.
3. Remove briefs state fields (`:44-66`): `briefsFolderPathsByRoot`, `briefsPreviewCollapsed`, `briefsWorkspaceRootFilter`, `briefsDocsSearch`, `_lastBriefsDocsMsg`, `activeBriefSourceId`, `activeBriefDocId`, `briefEditMode`, `briefEditOriginalContent`, plus `_pendingAutoOpenBrief` usage (`:3455-3466`).
4. Remove `'briefs'` from the `refreshDocsForTab` gate (`:203`).
5. Remove tree rendering: `renderBriefsDocs` (`:911-955`), `createBriefDocCard` (`:957-`), the `openFoldersModal('briefs')` binding (`:926`).
6. Remove the `'briefs-folder'` branches in `loadDocumentPreview` (`:1469-1490`) and the doc-content-ready handler (`:1760-1780`).
7. Remove the brief editor block: `updateBriefDocControls` (`:1936-1945`), `enterBriefEditMode`/`exitBriefEditMode` (`:1947-2007`), `initBriefDocControls` IIFE (`:2009-2081`) including the `createBrief` (`:2061`) and `deleteBrief` (`:2074`) posts and the brief save via `originalContent`/`tab: 'briefs'` (`:2022-2033`).
8. Remove `briefsPreviewCollapsed` from `saveState()` (`:2110`) and its initial read (`:48`).
9. Remove the `btn-send-brief-to-stitch` binding and `stitchSendBrief` post (`:2760-2776`).
10. Remove the `'briefs.root'` restore block (`:3414-3421`).
11. Remove message cases: `briefsDocsReady` (`:3443-3467`), `stitchBriefInjected` (`:3479-3507`), `briefsFoldersListed` (`:3509-`), `briefCreated` (`:3519-`), `briefDeleted`.
12. Folders modal: remove the `'briefs'` scope branch (`:4638`), the briefs members of `getScopeFolderMap`/`getScopeTabRoot`, and the `listBriefsFolders` (`:4586, :4829`), `removeBriefsFolder` (`:4729`), `addBriefsFolder` (`:4847`) posts.

### `src/services/DesignPanelProvider.ts`
1. Remove `_briefsFolderWatchers` (`:221, :842-843, :1466-1476`) and `_briefsDocsDebounce` (`:235, :1485-1498`) and `_sendBriefsDocsReady` (`~:1520-1545`).
2. `ready` handler: remove `'briefs'` and `'briefs.root'` from `tabKeys` (`:2460`); remove the `briefsDocs` await (`:2487`) and its member in the `designReadyComplete` return (`:2494`).
3. Remove the `'briefs'` mapping in the `refreshDocsForTab` dispatch (`:3735`) and the adjacent comment (`:3726`).
4. Remove verb handler cases: `listBriefsFolders` (`:3807`), `addBriefsFolder` (`:3814`), `removeBriefsFolder` (`:3830`), `createBrief` (`:3840-3888`), `deleteBrief` (`:3890-3923`), `stitchSendBrief` (`:3954-4015`).
5. Remove `...service.getBriefsFolderPaths()` from `getDesignAssetRoots` (`:189`).
6. Remove `tab === 'briefs'` from `_isPolledTab` (`:4308`) and the `'briefs'` folder-signature branch (`:4373-4375`).

### `src/services/verbSchemas.ts`
1. Remove `listBriefsFolders`, `addBriefsFolder`, `removeBriefsFolder` (`:121-123`), `createBrief` (`:124-130`), `deleteBrief` (`:131-137`) from `DESIGN_VERB_SCHEMAS`.

### `src/services/LocalApiServer.ts`

> **Superseded:** "Remove any brief-only route/verb that only served the Briefs tab (verify against `verbAllowlist` / `verbSchemas`). Keep generic folder plumbing intact."
> **Reason:** Verified: `LocalApiServer.ts` has NO brief-specific routes. Brief verbs route generically through `designVerb` → `DesignPanelProvider.handleServiceVerb`, validated by `DESIGN_VERB_SCHEMAS`. The only Briefs references in this file are two doc comments (`:185`, `:852`) describing the `GET /design/asset` allowlist, which the provider owns.
> **Replaced with:** No route changes. Update the two doc comments (`:185`, `:852`) to drop "Briefs" from the folder-list description, matching the tightened `getDesignAssetRoots`.

### `src/services/LocalFolderService.ts`
1. **Keep** the `briefsFolderPaths` interface field (`:23`), all parse-tolerance reads (`:138, :201`), and defaults (`:103, :151, :217`) — load-bearing for config round-trip preservation (see Migration).
2. Remove the now-unused public brief methods — `getBriefsFolderPaths` (`:995`), `getBriefsFolderPath` (`:1005`), `addBriefsFolderPath` (`:1010`), `removeBriefsFolderPath` (`:1022`), `listBriefsFiles` (`:1031`) — AFTER the provider cuts land; every caller (`DesignPanelProvider.ts:189, :3973, :4374` and the verb handlers) is removed by this plan, so no caller remains.

## Verification Plan

### Automated Tests
- None — session directive: skip compilation and automated tests for this plan. (Per repo build rule, `dist/` is not used during development; no compile step is required to validate `src/` changes.)

> **Superseded:** "If `verbAllowlist`/`verbSchemas` are generated, regenerate and confirm no dangling brief verb references break the build (`npm run compile`)."
> **Reason:** Session directive forbids compilation/tests in this plan's verification; additionally `verbSchemas.ts` is hand-maintained, not generated, so there is nothing to regenerate.
> **Replaced with:** Manual grep sweep (Manual Verification step 7) to prove no dangling references.

### Manual Verification
1. Open the Design Panel — confirm the tab bar shows STITCH, STITCH HTML, HTML PREVIEWS, IMAGES, DESIGN SYSTEM and **no BRIEFS tab**.
2. Confirm the remaining five tabs each open and render correctly (no CSS regressions in default, cyber, and claudify themes — briefs selectors were comma-grouped with sibling selectors in all three).
3. Confirm the Stitch tab still functions (generation, project create, screen previews) with the brief entry point gone.
4. Load a config JSON that still contains `briefsFolderPaths`, then add/remove an HTML folder and re-open the config — confirm `briefsFolderPaths` survives the round-trip write (legacy-tolerant).
5. With a tab-state store carrying `activeTab: 'briefs'`, open the panel — confirm it falls back to the default tab with no console error.
6. Confirm no console errors reference removed elements (`#briefs-content`, `btn-send-brief-to-stitch`, `stitchSendBrief`, `briefsDocsReady`).
7. Grep sweep: `grep -rn "brief" src/webview/design.js src/webview/design.html src/services/DesignPanelProvider.ts src/services/verbSchemas.ts` returns only the retained `LocalFolderService` parse-tolerance references (and the updated LocalApiServer comments if the word survives there).
8. Confirm user brief markdown files on disk are untouched.

## Risk Assessment
**Recommendation:** Send to Coder

## Completion Report
- **What was implemented:** Completely removed the BRIEFS tab UI, styles, webview state/message handlers, backend verb handlers (`listBriefsFolders`, `addBriefsFolder`, `removeBriefsFolder`, `createBrief`, `deleteBrief`, `stitchSendBrief`), verb schemas, folder watchers, and unused `LocalFolderService` methods. Retained `LocalFolderService` parse-tolerance fields (`briefsFolderPaths`) for legacy config preservation.
- **Files changed:** [design.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.html), [design.js](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.js), [DesignPanelProvider.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/DesignPanelProvider.ts), [verbSchemas.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/verbSchemas.ts), [LocalApiServer.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalApiServer.ts), [LocalFolderService.ts](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/services/LocalFolderService.ts).
- **Issues encountered:** Large multi-chunk replace call timed out on design.html; split into smaller targeted replacement chunks to execute cleanly.

