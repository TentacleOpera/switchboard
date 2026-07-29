# Fix STITCH HTML Tab — Stuck on Loading & Missing Auto-Cache

## Metadata
- **Complexity:** 6
- **Tags:** bugfix, frontend, backend, ui, reliability
- **Project:** Website

## Goal

Fix the STITCH HTML tab in `design.html` which is broken in both the VS Code extension and the browser cockpit. Two distinct symptoms are reported:

1. **Stuck on "loading preview" forever** — clicking an HTML file in the sidebar never renders the preview; the loading spinner stays visible indefinitely.
2. **Sidebar requires "rebuild cache"** — the HTML file list is empty until the user manually clicks "Rebuild Cache" in the STITCH tab; HTML files are not auto-cached for existing screens.

### Problem Analysis & Root Cause

**Symptom 1 — Stuck on loading:**
The `previewError` handler in `design.js` (line 3625) does NOT handle the `stitch-html-folder` sourceId. It checks `design-folder`, `images-folder`, `briefs-folder`, and falls back to `status-html` for everything else. When the backend's `_buildAndSendPreview` throws (sending `previewError` instead of `previewReady`), the handler:
- Sets the wrong status element (`status-html` instead of `status-stitch-html`)
- **Never hides `stitch-html-loading-state`** — the loading spinner stays visible forever

The deeper question of WHY the backend errors needs investigation during implementation. The `fetchPreview` message from the frontend (design.js line 1397) does NOT include `workspaceRoot` — the backend falls back to `this._getWorkspaceRoot()`. If that returns empty (or the `allowedFolders` check in `_buildAndSendPreview` fails because the project's cache dir isn't in the allowed set), the backend throws and the frontend never recovers.

> **Superseded:** "The `fetchPreview` message … does NOT include `workspaceRoot` — the backend falls back to `this._getWorkspaceRoot()`. **If that returns empty** … the backend throws." — and the framing of Part B step 3 as a *mitigation* for multi-workspace only.
> **Reason:** Verified against both hosts. `workspaceRoot` is injected for us at the HTTP boundary in **both** headless hosts — `bootstrap.ts:983` (`workspaceRoot: workspaceRootArg || payload?.workspaceRoot || workspaceRoot`) and `TaskViewerProvider.ts:1768-1772` (injects `wsRoot` when `payload.workspaceRoot == null`) — so an *empty* root is not the failure mode over HTTP. The real defect is a **wrong** root, not an empty one: `fetchPreview` is the **only** stitch-html message that omits `workspaceRoot`. Every sibling message sends `workspaceRoot: state.stitchWorkspaceRoot` — the root the STITCH tab's own dropdown selected (`design.js:2552`, `2601`, `2636`, `2762`–`2813`, `4808`). When the host's default root differs from the tab's selected root, the backend computes the cache dir under the **wrong** root: in the VS Code webview it resolves `this._getWorkspaceRoot()` (the panel's injected root, not the tab's), and over HTTP it resolves the *cockpit's* root from the panel URL. Either way `_getImageCacheDir(wrongRoot, projectId)` is not in `allowedFolders` (which is built from `_getWorkspaceRoots()` × `db.getStitchProjects()` per root) → `sourceFolder is not a configured design/html/claude/briefs/images folder` → `previewError` → perpetual spinner.
> **Replaced with:** Sending `workspaceRoot: state.stitchWorkspaceRoot` on `fetchPreview` is the **primary** fix for Symptom 1's backend throw, not a multi-root mitigation — it makes `fetchPreview` consistent with every other stitch-html message and removes the host's default-root guess from the path entirely. The error-handler fix (Part A) is what makes any *residual* failure visible instead of silent.

> **Superseded:** "If there's a path resolution mismatch (e.g., trailing slash, case sensitivity on macOS), normalize both sides with `path.resolve()`."
> **Reason:** Already true in the code — the allowlist is built with `allowedFolders.add(path.resolve(this._getImageCacheDir(root, p.id)))` (`DesignPanelProvider.ts:4342`) and compared against `const resolvedFolder = path.resolve(sourceFolder)` (`:4346`). Both sides are the output of the *same* function through the *same* normaliser, so trailing-slash / case drift cannot occur. Verified independently against this workspace's real cache: `_sanitizeProjectFolderName` reproduces the on-disk directory names exactly (project `5008392467340858339` "Stitch Switchboard GUI Optimization" → `stitch-switchboard-gui-optimization-50083924`; project `6248498206992463926` "Switchboard landing page" → `switchboard-landing-page-62484982`), and both projects are present in `stitch_projects`, so the name-cache path also agrees.
> **Replaced with:** The `allowedFolders` check has exactly **two** remaining failure modes, and neither is string normalisation: (a) `root` is not the root the project's cache lives under (the wrong-root defect above), or (b) the project has no `stitch_projects` row for that root (only possible if `stitchListProjects` never completed a successful API fetch there — it upserts every project at `:3028`). Add a one-line diagnostic that logs `resolvedFolder` and the `allowedFolders` size/contents on the throw so the branch is identified on first reproduction rather than guessed.

**Additional root causes of Symptom 1 found during this pass (all independent of the backend throw):**

1. **`previewError` never clears the loading state for *any* tab.** The handler (3625-3642) only sets status text. `html-folder` and `images-folder` hang on the same spinner for the same reason — the missing `stitch-html-folder` branch is one instance of a generic defect, not a stitch-specific omission. `loadDocumentPreview` sets `loadingState.style.display = 'flex'` for html (1375), stitch-html (1394) and images (1413), and **only** `handlePreviewReady` ever sets it back to `none`.
2. **`handlePreviewReady`'s stale-response guard leaks the spinner.** Line 1544 (`stitch-html-folder`), 1476 (`html-folder`) and 1607 (`images-folder`) all do `if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) return;` — and that `return` happens **before** the `loadingState.style.display = 'none'` at 1562 / 1613. Any dropped-as-stale response therefore leaves a permanent spinner even when nothing errored. `state.previewRequestId` is incremented on every click (1362), so a fast second click while the first is in flight produces exactly this.
3. **`previewError` has no `requestId` guard at all.** A late error from a superseded request will overwrite the status line of the newer in-flight request, reporting a failure for a preview that is still loading.
4. **The failure is invisible to an HTTP caller.** The `fetchPreview` arm does `const res = await this._buildAndSendPreview({…}); return { success: true, preview: res };` (`:2566-2573`). `_buildAndSendPreview` is declared `Promise<void>` and swallows its error into a `previewError` **push**, so the arm returns `{success: true, preview: undefined}` **even when the preview failed**. That violates the project PRD's return-in-body contract (#4: "Failure branches — including the aggregate `catch` — return `{success:false, error}` so an HTTP caller sees the failure, never a false success") and means the browser cockpit's only notification of failure is the WebSocket push.

**Symptom 2 — Missing auto-cache:**
HTML files are only downloaded to disk in specific flows:
- `_formatScreen` (line 1787) — eagerly downloads HTML when formatting a screen from the Stitch API (STITCH tab Phase 2)
- `_backfillStitchHtmlCache` (line 1753) — background sweep, but only called from `stitchGetProjectScreens` (line 3152), NOT from `stitchHtmlListDocs`
- `_formatScreenFromCache` (line 1605) — serves screens from DB cache (STITCH tab Phase 1), sets `htmlUrl: ''` and does NOT download HTML

The STITCH HTML tab's `stitchHtmlListDocs` handler calls `_sendStitchHtmlDocsReady` (line 1139), which reads the cache dir and lists `.html` files on disk. If no HTML has been downloaded yet (screens served from cache, backfill hasn't run or hasn't completed), the sidebar is empty. The "Rebuild Cache" button works because it calls `_formatScreen` (not `_formatScreenFromCache`), which eagerly downloads HTML.

**Confirmed with local evidence.** This workspace's cache reproduces the split exactly: `.switchboard/stitch/stitch-switchboard-gui-optimization-50083924/` holds 10+ `.png` files and **zero** `.html` files (a project whose screens were served from the DB cache — permanently empty sidebar), while `.switchboard/stitch/switchboard-landing-page-62484982/` holds matched `.png`/`.html` pairs (a project that passed through `_formatScreen`).

> **Superseded:** the implication that Symptom 2 is an ongoing *capture* defect — that HTML "is not auto-cached for existing screens" because `_formatScreenFromCache` doesn't download it and the backfill isn't wired into `stitchHtmlListDocs`.
> **Reason:** Both halves are true as code facts, but they are not why the user's sidebars are empty, and the plan as written would send a coder hunting a capture bug that does not exist. Dated against git and the on-disk cache: `_formatScreen`'s eager HTML download **and** `_backfillStitchHtmlCache` both landed in the **same commit `df9ecb1` (2026-07-12)**. The two projects with zero HTML had their PNGs written **Jun 15** and **Jun 16** — roughly four weeks *before* the feature existed. The project with matched pairs was generated **Jul 27**, after it existed. So HTML capture for newly generated screens already works; the empty sidebars are **legacy data from before 2026-07-12**. Furthermore the recovery sweep is not missing either — `_backfillStitchHtmlCache` already covers the *full* screen list on every `stitchGetProjectScreens` (`:3152`), including screens Phase 2 skips because they were cached with an image (`:3140`). It has simply never run for those two projects because its only trigger is a project load in the **STITCH** tab, and neither June project has been opened there since 07-12. Their DB rows are all present (13 and 10, matching their PNG counts exactly), so enumeration is not the obstacle.
> **Replaced with:** Symptom 2 is a **trigger-coverage** defect, not a capture or capability defect. Part C's value is giving an existing, working sweep a second entry point so the STITCH HTML tab does not silently depend on the user having visited the STITCH tab. Scope narrows accordingly: no new capability, no change to the generation path, and nothing to fix for screens generated after 2026-07-12. The diagnosis is correct as written.

**Adjacent behaviour that is intentional — do NOT "fix" it.** `state.selectedStitchHtmlProjectId` is written to panel state (`persistTab('stitchHtml.projectId', …)` at `design.js:2545`, `4799`) but never read back — there is no `getRestoredState('stitchHtml.projectId', …)` anywhere. So the tab always opens with "Select Project…" and an empty sidebar until the user picks a project. This mirrors the STITCH tab, where the equivalent restore is **explicitly disabled** in source: `// Restore project selection for this root — DISABLED per initialization requirements` (`design.js:3300-3302`, repeated at `:3349`). Adding project-selection restore is a deliberate product decision that has already been made the other way; it is **out of scope** for this plan.

## Implementation Plan

### Part A: Fix the stuck-on-loading error handler (frontend)

**File:** `src/webview/design.js`

1. In the `previewError` case handler (line 3625-3642), add a branch for `stitch-html-folder`:
   - Set `activeStatus = 'status-stitch-html'`
   - Hide `stitch-html-loading-state` (set `display: none`)
   - Show `stitch-html-initial-state` (set `display: flex`) so the user sees the empty state instead of a perpetual spinner
   - Hide `stitch-html-preview-wrapper` (set `display: none`)
   - Hide `stitch-html-edit-bar` (set `display: none`)

2. Ensure the error message is visible in `status-stitch-html` (same pattern as other tabs: `'Preview error: ' + msg.error`).

3. **Clarification (implementation shape, not new scope):** implement 1-2 as a **sourceId → element-ids table** rather than another `else if` limb, and reuse the same table on the stale-response early-return path. The `stitch-html-folder` entry is the required fix; `html-folder` and `images-folder` entries fix the byte-identical hang two lines away and are the reason the table is worth having. See *Proposed Changes* for the exact code.

4. Add a `requestId` staleness guard to `previewError` matching `handlePreviewReady`'s, so a superseded error cannot clobber a newer in-flight request's UI — but only *after* the cleanup decision, so the current request's spinner is always cleared.

### Part B: Fix the backend error cause

**File:** `src/services/DesignPanelProvider.ts`, `src/webview/design.js`

5. Add `workspaceRoot: state.stitchWorkspaceRoot` to the `fetchPreview` postMessage in the `stitch-html-folder` branch (`design.js:1397-1404`). This is the primary fix for the backend throw (see the superseded callout above), and makes `fetchPreview` consistent with every other stitch-html message. No schema change is needed: `verbSchemas.ts` defines **no** schema for `fetchPreview`, so it passes through validation unchanged, and no schema in that file uses `additionalProperties: false`.

6. Add a diagnostic to `_buildAndSendPreview`'s allowlist rejection (`:4347-4349`) that logs the rejected `resolvedFolder`, the roots iterated, and the allowlist size. This converts the remaining ambiguity — wrong root vs. missing `stitch_projects` row — into a single-run answer instead of a guess.

7. If the HTML file doesn't exist on disk (the user clicked a file that was listed but has since been removed, or there's a race), ensure the error message is clear: "HTML file not found on disk — try Rebuild Cache" rather than a generic "sourceFolder is not a configured..." error.

8. Honour the PRD return contract on the failure path: have `_buildAndSendPreview` **return** its outcome and have the `fetchPreview` arm return `{success:false, error}` when it failed. Today the arm returns `{success:true, preview:undefined}` regardless of outcome.

### Part C: Auto-cache HTML when STITCH HTML tab selects a project

**File:** `src/services/DesignPanelProvider.ts`

9. In the `stitchHtmlListDocs` handler (line 3550-3564), after calling `_sendStitchHtmlDocsReady`, trigger a background HTML backfill for the project — the same `_backfillStitchHtmlCache` sweep that runs in `stitchGetProjectScreens`. This ensures that when a user selects a project in the STITCH HTML tab, any missing HTML files are downloaded in the background.

   Implementation:
   - Fetch the screen list from the DB (`db.getStitchScreensForProject(projectId)`)
   - Load the full screen objects from the Stitch API (like `stitchRebuildImageCache` does at line 3186-3191) — **but only for screens missing HTML on disk** (filter with `_getStitchHtmlPath` first, so a fully-cached project makes **zero** API calls)
   - Call `_backfillStitchHtmlCache` with the loaded screens
   - After backfill completes, re-send `stitchHtmlDocsReady` so the sidebar updates with the newly-cached files

   **Important:** This must be fire-and-forget (void) so the tab doesn't block. The initial `_sendStitchHtmlDocsReady` call still returns immediately with whatever is on disk. The backfill populates files in the background and then pushes a fresh `stitchHtmlDocsReady` message.

10. Guard the backfill with `_stitchOperationLock` check — if another Stitch operation is in progress, skip the backfill (the lock-based operations like rebuild cache will handle it).

11. Also gate on the API-key check. `hasKey` (`= authInfo.valid`, `:2293`) is already in scope for every arm in `_handleMessage`; without it, an unconfigured install spends a `loadStitch` + N `getScreen` calls to fail N times inside the sweep's per-screen `catch`.

12. Return the docs in the HTTP body. `stitchHtmlListDocs` currently returns a bare `{ success: true }` while the data goes out only as a push — a read/query arm that returns no data violates PRD contract #4. Make `_sendStitchHtmlDocsReady` return the payload it posts (exactly as `_sendHtmlDocsReady` already does at `:1116-1124`) and return it from the arm.

### Part D: Frontend — refresh sidebar after backfill

**File:** `src/webview/design.js`

13. The `stitchHtmlDocsReady` handler (line 4098) already calls `renderStitchHtmlDocs(docs)`. Verify that a second `stitchHtmlDocsReady` message (sent after backfill) correctly re-renders the sidebar without duplicating entries or losing the user's selection. The current implementation clears `treePane.innerHTML` and rebuilds, so this should work — but verify the selected doc state is preserved.

> **Superseded:** Part D as a *verification task* ("verify … without duplicating entries or losing the user's selection … but verify the selected doc state is preserved").
> **Reason:** The question is answerable from the code and has been answered, so leaving it as an open implementation task invites a redundant investigation. `renderStitchHtmlDocs` (`design.js:1096-1147`) clears `treePane.innerHTML` and rebuilds every card, so duplication is structurally impossible. Selection is **not** stored on the DOM: each card's `isSelected` is derived from module state — `state.activeSource === 'stitch-html-folder' && state.activeDocId === doc.file` (`:1140`) — and neither field is touched by re-render. So a second `stitchHtmlDocsReady` re-renders with the selection intact, and the in-flight/rendered preview is untouched because the handler never touches the preview wrapper or the loading state.
> **Replaced with:** **No frontend re-render change is required for Part D**, but a refresh-cadence change is. The *host split* that makes Part C's explicit re-send mandatory: in the extension, the per-project folder watcher (`_setupStitchHtmlFolderWatchers`, `:995-1009`) already calls `_sendStitchHtmlDocsReady` on every file event, so each backfilled download refreshes the sidebar on its own. Under the standalone host the seam bundle is built from the vscode shim whose watchers are **no-ops** (`bootstrap.ts:438-441`), so nothing refreshes the sidebar unless Part C pushes explicitly.

> **Superseded:** "place it **after** the sweep completes (one message) rather than per-file, so the extension's watcher-driven refreshes are not multiplied."
> **Reason:** Wrong trade, given the confirmed latency. The sweep is two serial round trips per screen and runs for tens of seconds to minutes, so a single terminal push leaves the sidebar showing *"No cached HTML found for this project"* for the entire run — indistinguishable from the bug being unfixed, and the exact "passes its own check while the goal is unmet" failure this plan is meant to avoid. The multiplication worry is also mis-aimed: the stitch-html watcher callbacks call `_sendStitchHtmlDocsReady` **undebounced** (`:999`, `:1009`), and there are two watchers per dir (seam + `_setupNativeFolderWatchFallback`), so the extension already fires ~2 rebuild-and-push cycles *per downloaded file* today. Every sibling tab solved this years ago with a 300 ms debounce (`_scheduleHtmlDocsReady:1069`, plus the Claude/design/briefs/images twins at `:1177`, `:1242`, `:1325`, `:1410`); stitch-html is the only one that never got one.
> **Replaced with:** Add the missing `_scheduleStitchHtmlDocsReady()` debounce (300 ms, verbatim shape of `_scheduleHtmlDocsReady`), point the two watcher callbacks at it, and have the sweep call it **after each successful download**. That gives progressive sidebar population in *both* hosts, coalesces the existing extension storm instead of adding to it, and removes the need for a special terminal push (fire one final `_sendStitchHtmlDocsReady` after the sweep so the last file cannot be lost to a trailing debounce).

### Part E: Do not change (verified non-defects)

Recorded so an implementer does not "fix" working code:

- **`"Open in HTML Tab"` builds its docId correctly.** `design.js:2555` calls `loadDocumentPreview('stitch-html-folder', \`${screen.id}.html\`, …)` while the backend writes files as `\`${path.basename(screen.id)}.html\`` (`:1765`, `:1792`). These agree because Stitch screen ids are **bare 32-hex strings with no path separators** — verified against `stitch_screens` in this workspace's `kanban.db` (e.g. `4a94d00841254b6cbf06d3744e28dbc1`) and against the on-disk filenames. The defensive `path.basename` calls are belt-and-braces, not evidence of a slashed id.
- **Sidebar clicks pass the right docId.** `renderStitchHtmlDocs` uses `doc.file` (the bare filename from `readdir`) as both `nodeId` and the `loadDocumentPreview` docId (`:1137`, `:1142`), matching `_sendStitchHtmlDocsReady`'s `file: entry`. The docs objects deliberately carry `screenId`/`file`/`sourceFolder`/`absolutePath` and **no** `id` field — that is consistent with the caller.
- **The standalone broadcaster is wired.** `designProvider.setApiServer(server)` (`bootstrap.ts:1009`) forwards into the hub (`DesignPanelProvider.setApiServer` → `this._broadcaster?.setApiServer(server)`), so `postMessage` pushes do reach the browser over the WS hub. Do not "fix" push delivery.

## User Review Required

- **None.** The two symptoms are defects with determined fixes. The one genuine product question in the area — whether the tab should restore its last-selected project on open — has already been decided the other way in source ("DISABLED per initialization requirements") and is explicitly out of scope.

## Complexity Audit

### Routine
- Adding the `stitch-html-folder` branch (as a table) to `previewError` and reusing it on the stale-response return path — pure DOM show/hide, matching three existing sibling branches.
- Adding `workspaceRoot: state.stitchWorkspaceRoot` to one `postMessage` — every sibling stitch message already does this.
- Making `_sendStitchHtmlDocsReady` return its payload and the arm return it — `_sendHtmlDocsReady` is the verbatim template (`:1116-1124`).
- Adding a diagnostic log line on the allowlist rejection.

### Complex / Risky
- **The background backfill issues N remote API calls** (`stitch.project(projectId).getScreen(id)` per screen missing HTML) from a *list* handler that until now only did a `readdir`. A project with dozens of uncached screens turns a tab click into a long sequential remote sweep. Must be gated on `hasKey`, gated on `_stitchOperationLock`, filtered to only-missing screens, and left sequential (the sweep is deliberately non-parallel — `:1763`). Note this is a *latency* and tidiness concern, not a quota one: the shipped `stitchGetProjectScreens` and `stitchRebuildImageCache` paths already fan the same calls out in parallel across a whole project (see *Resolved Assumptions*).
- **Changing `_buildAndSendPreview`'s signature from `Promise<void>`** touches three call sites (`:2566`, `:2596`, `:4495`), one of which is the auto-refresh path that must keep failing silently (`requestId === -1`).
- **Return-contract changes are ratchet-visible.** Any conversion of `break` to `return` in `DesignPanelProvider` moves the Design provider's residual `break` count. Design's ceiling floors at **14** legitimate nested-control-flow breaks — never force it to 0.

## Edge-Case & Dependency Audit

**Race Conditions**
- **Backfill vs. click (already noted, now bounded):** if the user clicks a file while the sweep is still downloading it, `fetchPreview` fails with ENOENT. Part A guarantees a cleared spinner and a readable message ("HTML file not found on disk — try Rebuild Cache"). A retry-after-backfill is explicitly out of scope.
- **Stale-response spinner leak (new):** two clicks in quick succession bump `state.previewRequestId` twice; the first response is dropped by the guard at `:1544` *before* the spinner is cleared. The second response clears it — unless the second one is the one that errors, in which case the un-guarded `previewError` handler previously left the spinner up. Fix both paths together or the hang survives in the double-click case.
- **Late error clobbering a live request (new):** `previewError` has no `requestId` guard, so an error from request *n* can overwrite the status of in-flight request *n+1*. Guard it.
- **Backfill vs. watcher storm (extension only):** each downloaded file fires the folder watcher, which calls `_sendStitchHtmlDocsReady`. A 30-screen sweep fires ~30 rebuild-and-push cycles. Acceptable (the watcher path already existed for the STITCH tab's own backfill), but push the explicit refresh **once after** the sweep, not per file.
- **Project switch mid-sweep:** the sweep captures `workspaceRoot`/`projectId` at start. `stitchHtmlListDocs` re-entry for a different project nulls `_activeStitchHtmlPreview` and re-targets watchers (`:3556-3561`), but an in-flight sweep for the old project keeps downloading into the old project's dir. Harmless (files are correct for their own project) — but the post-sweep `stitchHtmlDocsReady` must carry/verify its own `workspaceRoot`+project so it cannot repaint the sidebar for a project the user has since left. The frontend's handler does **not** currently filter on project, so the backend must not emit a stale one: skip the final push if `projectId !== this._activeStitchHtmlProjectId || workspaceRoot !== this._activeStitchHtmlWorkspaceRoot`.
- **Concurrent duplicate downloads:** already solved — `_downloadToCache` dedupes by target path via `_cacheDownloadsInFlight` (`:1729-1744`), so a sweep and a `_formatScreen` racing on the same file join one download.

**Security**
- No new trust boundary. `fetchPreview` for `stitch-html-folder` continues to resolve the folder **server-side** from `projectId` (`:2544-2556`) and never trusts a webview-supplied path; adding `workspaceRoot` to the message hands the backend a *root*, still validated against `_getWorkspaceRoots()` × `getStitchProjects()` in `allowedFolders`, plus the `absPath.startsWith(resolvedFolder + path.sep)` traversal check (`:4351`).
- The diagnostic log must print paths only — never the Stitch API key, never a signed URL (signed URLs are credentials).
- `verbSchemas.ts` has no schema for `fetchPreview` or `stitchHtmlListDocs`, so both pass through validation. Adding a field cannot be rejected; equally, nothing validates it — keep the server-side root validation as the real gate.

**Side Effects**
- Restoring data flow into the HTTP body (Parts B8, C12) is additive: the pushes stay, so the VS Code webview is unaffected.
- `_sendStitchHtmlDocsReady` gaining a return value changes no existing caller (the watcher calls it with `void`).
- **Pre-existing, mildly worsened:** in standalone the `BroadcastHub` has `webview: null`, and `push()` appends to `_pendingWebviewMessages` on every call with no cap (`BroadcastHub.ts:63-69`) — a queue that is never flushed because no webview ever binds. Part C's extra pushes add to it. Not this plan's job to fix; worth a follow-up, and a reason to prefer the single post-sweep push over per-file pushes.
- Nothing here reads or writes shipped state/settings/DB schema, so **no migration is required** despite the ~4,000-install base.

**Dependencies & Conflicts**
- Files touched: `src/webview/design.js`, `src/services/DesignPanelProvider.ts`. Per the PRD's "one agent stream per provider file" rule, `DesignPanelProvider.ts` must be a single stream — serialise against any other Design provider work (e.g. the Design Layer-1 verb burndown).
- No `verbSchemas.ts` edit, so no shared-file serialisation there.
- `npm run verb-returns:check` gates the return-contract edits; the Design ceiling in `scripts/verb-return-contract-baseline.json` must be lowered to the provider's **true residual** `break` count in the same change if the count drops, and never forced below the legitimate-nested-`break` floor (Design = 14).
- Third-party: none blocking. The Stitch SDK calls Part C makes are already made by two shipped paths — see *Resolved Assumptions*.

## Dependencies

- `sess_local_none — no upstream plan dependency; self-contained fix in the Design provider and its webview.`

## Adversarial Synthesis

Key risks: (1) the *visible* bug is a missing error branch, but the actual hang has three independent causes — the un-cleared spinner on `previewError`, the stale-response `return` that skips the same cleanup, and the backend throw itself — so fixing only the first leaves a reproducible hang; (2) Part C turns a cheap `readdir` handler into an N-remote-call background sweep, which without `hasKey` / lock / only-missing gating becomes a tab-click-triggered API storm; (3) the fix set is only *verifiable* if failures stop being silent — the arm currently returns `{success:true}` on failure, so an HTTP caller (the whole browser cockpit) cannot distinguish a broken preview from a working one. Mitigations: implement the loading-state cleanup as one sourceId table reused by both the error path and the stale-response path; gate the sweep on `hasKey` + `_stitchOperationLock` + a missing-HTML filter and keep it sequential; return `{success:false, error}` from the failure branch and return the docs payload from `stitchHtmlListDocs` per PRD contract #4; and log the rejected folder plus the allowlist on the `allowedFolders` throw so the one remaining unknown (wrong root vs. missing project row) is answered on first reproduction rather than guessed.

## Proposed Changes

### `src/webview/design.js` — `previewError` handler (line 3625-3642)

**Context.** The handler maps three sourceIds to a status element and falls through to `status-html`. It never touches any loading state, so every tab that shows a spinner in `loadDocumentPreview` (html 1375, stitch-html 1394, images 1413) hangs on error.

**Logic.** Replace the `else if` chain with a table keyed by sourceId, carrying the status element plus the elements to reset. Add a staleness guard that suppresses only the *status text* of a superseded request, never the cleanup.

**Implementation.**

```javascript
            case 'previewError': {
                console.error('[DesignPanel Webview] Preview error:', msg.error);
                // sourceId → { status, hide[], show[] }. A table rather than another
                // else-if limb: every tab that raises a spinner in loadDocumentPreview
                // must lower it here, and the old chain lowered none of them.
                const PREVIEW_ERROR_TARGETS = {
                    'stitch-html-folder': {
                        status: 'status-stitch-html',
                        hide: ['stitch-html-loading-state', 'stitch-html-preview-wrapper', 'stitch-html-edit-bar'],
                        show: ['stitch-html-initial-state']
                    },
                    'html-folder': {
                        status: 'status-html',
                        hide: ['html-loading-state', 'html-preview-wrapper'],
                        show: ['html-initial-state']
                    },
                    'images-folder': {
                        status: 'status-images',
                        hide: ['images-loading-state', 'image-preview-container-images'],
                        show: ['images-initial-state']
                    },
                    'design-folder': { status: 'status-design', hide: [], show: [] },
                    'briefs-folder': { status: 'status-briefs', hide: [], show: [] }
                };
                const target = PREVIEW_ERROR_TARGETS[msg.sourceId] || { status: 'status-html', hide: [], show: [] };
                // Always clear the spinner — a stale error still means THAT request is
                // over. Only the status text is suppressed when superseded, so a late
                // failure can't overwrite a newer in-flight request's message.
                target.hide.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'none'; });
                target.show.forEach(id => { const el = document.getElementById(id); if (el) el.style.display = 'flex'; });
                const isStale = msg.requestId !== undefined && msg.requestId !== -1
                    && msg.requestId !== state.previewRequestId;
                if (!isStale) {
                    const statusEl = document.getElementById(target.status);
                    if (statusEl) {
                        statusEl.textContent = 'Preview error: ' + msg.error;
                        statusEl.style.color = '#ff6b6b';
                    }
                }
                break;
            }
```

**Edge Cases.**
- The case gains braces — the existing `let activeStatus` / `const statusEl` bindings in the bare `case` are removed, so no redeclaration clash with the other `case` blocks in the same `switch`.
- `show` uses `display: flex` because that is what `loadDocumentPreview` toggles these containers with (1374-1376, 1393-1395).
- `design-folder` / `briefs-folder` intentionally have empty `hide`/`show`: those tabs render a "Loading preview..." string into the markdown preview element rather than a spinner overlay, and their existing behaviour (status text only) is already correct.
- `stitch-html-edit-bar` is hidden on error because it is only meaningful for a successfully previewed screen (it is shown at 1602 on `previewReady`).

### `src/webview/design.js` — stale-response cleanup in `handlePreviewReady`

**Context.** Lines 1476, 1544, 1607 return on a `requestId` mismatch before the spinner is hidden (1562 / 1613).

**Logic.** On the stale path, still lower the spinner for that tab, then return. Reuse the table above (hoist it to module scope next to the other constants so both the error handler and this path share one definition).

**Implementation (stitch-html shown; apply the same shape at 1476 and 1607).**

```javascript
        } else if (sourceId === 'stitch-html-folder') {
            if (requestId !== undefined && requestId !== -1 && requestId !== state.previewRequestId) {
                // Superseded by a newer click. Drop the payload, but never leave the
                // spinner up — the newer request owns the pane and will paint it.
                const loading = document.getElementById('stitch-html-loading-state');
                if (loading) loading.style.display = 'none';
                return;
            }
```

**Edge Cases.** Do not show the initial state here — a newer request is in flight and owns the pane; only the spinner is lowered. `requestId === -1` (auto-refresh) still bypasses the guard entirely.

### `src/webview/design.js` — `fetchPreview` payload (line 1397-1404)

**Context.** The only stitch-html message that omits `workspaceRoot`.

**Implementation.**

```javascript
            vscode.postMessage({
                type: 'fetchPreview',
                sourceId,
                docId,
                requestId: state.previewRequestId,
                sourceFolder,
                projectId: state.selectedStitchHtmlProjectId,
                workspaceRoot: state.stitchWorkspaceRoot
            });
```

**Edge Cases.** When `state.stitchWorkspaceRoot` is `''` (tab never initialised) the backend's `message.workspaceRoot || …` fallback chain is unchanged, so behaviour is no worse than today; over HTTP the host's injection still applies because both wrappers treat a falsy payload root as absent (`bootstrap.ts:983` uses `||`; `TaskViewerProvider.ts:1772` injects when `== null` — note the `== null` check means an **empty string** is *not* replaced there, so the provider's own `_getWorkspaceRoot()` fallback at `:2546` is what covers it).

### `src/webview/design.js` — `stitchHtmlDocsReady` progress + stale empty-state copy

**Context.** The handler (`:4098-4110`) sets the status line to a file count or `'No cached HTML'`. The empty state (`:1117`) reads *"No cached HTML found for this project. HTML caches as screens load in the Stitch tab."* Both are written on the assumption that caching happens elsewhere and instantly. With a sweep that runs for tens of seconds to minutes, an unchanged "No cached HTML" line during the sweep is the user-visible equivalent of the bug being unfixed. The original plan's own Risks section already required this ("the user should see a loading indicator in the sidebar") — this is that requirement, made concrete.

**Logic.** Prefer the backfill progress over the file count while a sweep is active, and correct the empty-state sentence now that this tab caches too.

**Implementation.**

```javascript
            case 'stitchHtmlDocsReady': {
                const docs = msg.docs || [];
                state.stitchHtmlDocs = docs;
                state.stitchHtmlBackfill = msg.backfill || null;
                renderStitchHtmlDocs(docs);
                const statusEl = document.getElementById('status-stitch-html');
                if (statusEl) {
                    const bf = msg.backfill;
                    if (bf && bf.total) {
                        // A sweep is running: report it, and keep the file count visible
                        // so files landing progressively are obviously progress.
                        statusEl.textContent = `Caching HTML… ${bf.done}/${bf.total}`
                            + (docs.length ? ` · ${docs.length} ready` : '');
                    } else {
                        statusEl.textContent = docs.length > 0
                            ? `${docs.length} file${docs.length === 1 ? '' : 's'}`
                            : 'No cached HTML';
                    }
                }
                break;
            }
```

And in `renderStitchHtmlDocs`'s empty branch (`:1117`), make the copy true and tell the user to wait rather than to go to another tab:

```javascript
            docList.innerHTML = '<div class="empty-state" style="padding: 12px; font-size: 12px; color: var(--text-secondary);">'
                + (state.stitchHtmlBackfill && state.stitchHtmlBackfill.total
                    ? 'Caching HTML for this project — files appear as they download.'
                    : 'No cached HTML for this project yet.')
                + '</div>';
```

**Edge Cases.**
- `msg.backfill` is `undefined` on every watcher-driven refresh and on any host that has not run a sweep, so the existing file-count text is the default path — no behaviour change outside an active sweep.
- The progress line is warranted here precisely because the operation is long. Do **not** extend this pattern to sub-second states; per project convention, status UI is for durations a human perceives, not for races.
- `bf.done` can legitimately finish below `bf.total`: `_backfillStitchHtmlCache` skips screens whose `getHtml()` returns `''` (image-space, `:1761`). The `finally` block clears the progress object, so the line resolves to the file count regardless — never leave a stuck `4/13`.

### `src/services/DesignPanelProvider.ts` — `_buildAndSendPreview` (line 4310-4434)

**Context.** Declared `Promise<void>`; swallows failure into a `previewError` push; the `fetchPreview` arm therefore reports success unconditionally.

**Logic.** Return a result object. Keep the push (additive, per PRD #1/#4). Keep auto-refresh (`requestId === -1`) silent. Add the allowlist diagnostic and the file-not-found message.

**Implementation.**

```typescript
    private async _buildAndSendPreview(opts: {
        sourceId: string;
        sourceFolder?: string;
        docId: string;
        requestId: number;
        target?: string;
        isAutoRefreshed?: boolean;
    }): Promise<{ success: boolean; error?: string }> {
```

At the allowlist rejection (replacing `:4347-4349`):

```typescript
            if (!allowedFolders.has(resolvedFolder)) {
                // Which branch failed is otherwise unknowable from the UI: a wrong
                // workspace root, or a project with no stitch_projects row for this
                // root. Paths only — never log signed URLs or the API key.
                console.error('[DesignPanel] preview folder rejected', {
                    sourceId, resolvedFolder,
                    roots: this._getWorkspaceRoots(),
                    allowedCount: allowedFolders.size
                });
                throw new Error('sourceFolder is not a configured design/html/claude/briefs/images folder');
            }
```

Before the read, distinguish a missing file (replacing the bare `readFile` failure with a clear message):

```typescript
            try {
                await fs.promises.stat(absPath);
            } catch {
                throw new Error('HTML file not found on disk — try Rebuild Cache');
            }
```

At the end of the success path, `return { success: true };`. In the `catch`:

```typescript
        } catch (err: any) {
            const error = err.message || String(err);
            // Auto-refresh (requestId === -1) must fail silently — the file may be mid-write.
            if (requestId === -1) return { success: false, error };
            this.postMessage({ type: 'previewError', sourceId, requestId, error });
            return { success: false, error };
        }
```

**Edge Cases.**
- The `stat` guard applies to every sourceId, not just stitch — it turns an opaque ENOENT into a readable message everywhere. It is one extra `stat` per preview; negligible against the `readFile` that follows.
- Auto-refresh returns `{success:false}` **without** pushing — the silence contract is about the *push*, not the return value, and no HTTP caller drives `requestId === -1`.
- Call site `:4495` invokes this as `void`/fire-and-forget; the widened return type is source-compatible.

### `src/services/DesignPanelProvider.ts` — `fetchPreview` arm (line 2566-2573)

**Implementation.**

```typescript
                    const res = await this._buildAndSendPreview({
                        sourceId: message.sourceId,
                        sourceFolder: resolvedFolder,
                        docId: rawDocId,
                        requestId: message.requestId,
                        isAutoRefreshed: false
                    });
                    // PRD contract #4: the aggregate failure must reach the HTTP caller.
                    // Returning {success:true} here made every broken preview look fine
                    // to the browser cockpit.
                    return res.success ? { success: true } : { success: false, error: res.error };
```

**Edge Cases.** Apply the same treatment to the `html-folder`/`claude-folder` branch at `:2596` if it shares the pattern; do not convert any nested `break` that is genuine inner control flow (the ratchet counts those legitimately).

### `src/services/DesignPanelProvider.ts` — `_sendStitchHtmlDocsReady` (line 1139-1175)

**Logic.** Return the payload it posts, mirroring `_sendHtmlDocsReady` (`:1116-1124`). Three exit points (early-empty, success, catch) each build and return their payload.

**Implementation (success path shown; apply to all three exits).**

```typescript
    private async _sendStitchHtmlDocsReady(workspaceRoot: string, projectId: string): Promise<any> {
        if (!workspaceRoot || !projectId) {
            const empty = { type: 'stitchHtmlDocsReady', docs: [], workspaceRoot };
            this.postMessage(empty);
            return empty;
        }
        …
            const payload = { type: 'stitchHtmlDocsReady', docs, workspaceRoot };
            this.postMessage(payload);
            return payload;
```

**Edge Cases.** The watcher callers (`:999`, `:1009`) use `void` and are unaffected.

### `src/services/DesignPanelProvider.ts` — `stitchHtmlListDocs` arm (line 3550-3564)

**Logic.** Return the docs payload; kick off the gated background sweep.

**Implementation.**

```typescript
            case 'stitchHtmlListDocs': {
                const workspaceRoot = message.workspaceRoot || this._getWorkspaceRoot() || '';
                const projectId: string = message.projectId;
                if (projectId !== this._activeStitchHtmlProjectId || workspaceRoot !== this._activeStitchHtmlWorkspaceRoot) {
                    this._activeStitchHtmlProjectId = projectId;
                    this._activeStitchHtmlWorkspaceRoot = workspaceRoot;
                    this._activeStitchHtmlPreview = null;
                    void this._setupStitchHtmlFolderWatchers().catch(() => {});
                }
                const payload = await this._sendStitchHtmlDocsReady(workspaceRoot, projectId);
                // Fire-and-forget: the sidebar already returned whatever is on disk.
                // _formatScreenFromCache never downloads HTML, so a project served from
                // the DB cache has PNGs and no HTML until something sweeps for it.
                if (hasKey && workspaceRoot && projectId && !this._stitchOperationLock) {
                    void this._backfillStitchHtmlForProject(workspaceRoot, projectId)
                        .catch(err => console.error('[DesignPanel] stitch-html backfill failed:', err));
                }
                return { success: true, ...(payload || {}) };
            }
```

New private helper:

```typescript
    /**
     * Background HTML sweep for the STITCH HTML tab. Unlike the STITCH tab, this tab
     * never passes screens through _formatScreen, so nothing else downloads their HTML.
     * Only screens with no HTML on disk cost an API call — a fully cached project makes
     * zero remote calls. Sequential on purpose (see _backfillStitchHtmlCache).
     */
    private _stitchHtmlBackfill?: { done: number; total: number };

    private async _backfillStitchHtmlForProject(workspaceRoot: string, projectId: string): Promise<void> {
        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        await db.ensureReady();
        const rows = await db.getStitchScreensForProject(projectId);
        const missing: any[] = [];
        for (const row of rows) {
            if (await this._getStitchHtmlPath(row.id, workspaceRoot, projectId)) continue;
            missing.push(row);
        }
        if (missing.length === 0) return;

        // Progress is published through the existing stitchHtmlDocsReady payload
        // rather than a new message type — the sweep runs for tens of seconds to
        // minutes, so "No cached HTML found" must not be the only thing on screen.
        this._stitchHtmlBackfill = { done: 0, total: missing.length };
        this._scheduleStitchHtmlDocsReady();
        try {
            const stitch = await loadStitch('');
            // Resolve screen handles with BOUNDED concurrency. This phase is the cost
            // Part C adds (the HTML tab never populates _activeScreens, so every screen
            // needs a getScreen before its getHtml — two serial round trips each). A
            // small window cuts wall-clock without exceeding bursts the product already
            // performs: stitchGetProjectScreens (:3133) and stitchRebuildImageCache
            // (:3186) both Promise.all these same calls across a whole project.
            const CONCURRENCY = 4;
            const screens: any[] = [];
            for (let i = 0; i < missing.length; i += CONCURRENCY) {
                const batch = missing.slice(i, i + CONCURRENCY);
                const resolved = await Promise.all(batch.map(async (row) => {
                    const cached = this._activeScreens.get(row.id);
                    if (cached) return cached;
                    try {
                        const screen = await stitch.project(projectId).getScreen(row.id);
                        this._activeScreens.set(row.id, screen);
                        return screen;
                    } catch (err) {
                        console.error(`[DesignPanel] getScreen failed for ${row.id}:`, err);
                        return null;
                    }
                }));
                screens.push(...resolved.filter(Boolean));
                // Abandon the sweep if the user left this project mid-flight.
                if (projectId !== this._activeStitchHtmlProjectId
                    || workspaceRoot !== this._activeStitchHtmlWorkspaceRoot) return;
            }
            if (screens.length === 0) return;

            // Downloads stay sequential (the shared sweep's documented contract at
            // :1763). Each completed file bumps the counter and schedules a debounced
            // refresh, so files appear in the sidebar as they land in BOTH hosts.
            await this._backfillStitchHtmlCache(screens, workspaceRoot, () => {
                if (this._stitchHtmlBackfill) this._stitchHtmlBackfill.done++;
                this._scheduleStitchHtmlDocsReady();
            });
        } finally {
            this._stitchHtmlBackfill = undefined;
            // Final unconditional send so the last file can never be lost to a
            // trailing debounce, and the progress line always clears. Skip it if the
            // user has since switched project/root — the frontend does not filter.
            if (projectId === this._activeStitchHtmlProjectId && workspaceRoot === this._activeStitchHtmlWorkspaceRoot) {
                void this._sendStitchHtmlDocsReady(workspaceRoot, projectId);
            }
        }
    }
```

Add the missing debounce helper, verbatim in the shape of `_scheduleHtmlDocsReady` (`:1069`) and its four siblings, and point the two watcher callbacks (`:999`, `:1009`) at it instead of calling `_sendStitchHtmlDocsReady` directly:

```typescript
    private _stitchHtmlDocsDebounce?: ReturnType<typeof setTimeout>;

    /** Debounced watcher entry point — see _scheduleHtmlDocsReady. */
    private _scheduleStitchHtmlDocsReady(): void {
        if (this._stitchHtmlDocsDebounce) {
            clearTimeout(this._stitchHtmlDocsDebounce);
        }
        this._stitchHtmlDocsDebounce = setTimeout(() => {
            this._stitchHtmlDocsDebounce = undefined;
            const root = this._activeStitchHtmlWorkspaceRoot;
            const projectId = this._activeStitchHtmlProjectId;
            if (root && projectId) void this._sendStitchHtmlDocsReady(root, projectId);
        }, 300);
    }
```

Publish the progress in the payload built by `_sendStitchHtmlDocsReady` (all three exits), so it rides the push *and* the HTTP body:

```typescript
            const payload = {
                type: 'stitchHtmlDocsReady',
                docs,
                workspaceRoot,
                backfill: this._stitchHtmlBackfill ? { ...this._stitchHtmlBackfill } : undefined
            };
```

Give the shared sweep an optional per-file callback — defaulted, so the existing `stitchGetProjectScreens` caller (`:3152`) is unchanged:

```typescript
    private async _backfillStitchHtmlCache(screens: any[], workspaceRoot: string, onCached?: () => void): Promise<void> {
        …
                await this._downloadToCache(htmlUrl, cacheDir,
                    path.join(cacheDir, `${path.basename(screen.id)}.html`));
                onCached?.();
```
```

**Edge Cases.**
- `_backfillStitchHtmlCache` re-checks `_getStitchHtmlPath` per screen (`:1758`) and skips screens whose `getHtml()` returns empty (image-space screens, `:1761`), so the pre-filter is an optimisation, not a correctness requirement — a file that lands between the filter and the sweep is skipped safely.
- The sweep does **not** take `_stitchOperationLock`; it only declines to start while another operation holds it. Taking the lock would make a background sweep block user-initiated Stitch operations.
- `_downloadToCache` dedupe (`:1729`) makes a concurrent `_formatScreen` and this sweep join one download rather than double-fetching.
- Repeated tab entries re-run the sweep. After the first successful pass every screen has HTML on disk, so subsequent passes exit at the `missing.length === 0` check with no API calls.

## Resolved Assumptions

Recorded so these are not re-opened: **no web research is required for this plan.** Part C adds a second *caller* of an existing sweep, not a new API-call pattern, and the two questions that looked external are answered by shipped behaviour in this repository.

- **`screen.getHtml()` mints a usable URL on each call.** `_formatScreen` (`:1785`) calls `getHtml()` on every format, and screens are re-formatted repeatedly (Phase-2 refreshes, polls, `stitchRebuildImageCache`). A stale-cached or pre-expired URL would already have broken the STITCH tab's own eager download; it has not. The `_backfillStitchHtmlCache` docstring (`:1746-1752`) states this is exactly why the sweep re-calls `getHtml()` rather than reusing a stored link.
- **Burst tolerance is already established, and Part C is strictly gentler than what ships.** `stitchGetProjectScreens` (`:3133`) fans out `_formatScreen` — hence `getHtml()` — across **every** screen in parallel via `Promise.all`, and `stitchRebuildImageCache` (`:3186-3193`) fans out `getScreen()` **plus** `_formatScreen` across every cached screen in parallel behind the user-facing Rebuild Cache button. Part C's sweep is sequential and touches only screens with no HTML on disk, so it cannot exceed a burst the product already performs on demand. No pacing or backoff work is warranted beyond keeping it sequential.
- The `hasKey` gate is retained for cleanliness, not quota safety: without it an unconfigured install spends a `loadStitch` plus N doomed round-trips failing inside the sweep's per-screen `catch`.
- **Legacy recovery works — confirmed by the user (2026-07-28).** Screens generated before 2026-07-12 *do* get their HTML fetched by `_backfillStitchHtmlCache` when the sweep finally runs for them; `getHtml()` re-derives the asset server-side rather than depending on a link stored at generation time, so age is not a barrier. The image-space / `htmlCode: {}` worry does not apply to these projects. Part C therefore ships as a trigger fix with a real payoff for existing data.
- **But it is slow, and that is now a design input, not a footnote.** The user's report is that HTML "sometimes takes a while" to appear. The cause is structural: `_backfillStitchHtmlCache` is sequential by design (`:1763`), and each screen costs a `getHtml()` round trip plus a download. Part C's entry point is worse than the STITCH tab's, because the HTML tab never populates `_activeScreens`, so every screen also needs a `getScreen()` call first — **two serial round trips per screen** (~39 serial operations for a 13-screen project). A sweep measured in tens of seconds to minutes invalidates the "one push when the sweep finishes" refresh design: the sidebar would sit on *"No cached HTML found for this project"* for the whole run, which reads as "still broken". See the superseded callout in Part D and the progress requirements in Part C.

## Verification Plan

Compilation and automated test execution are **out of scope for this pass** per session directive. Testing is against an installed VSIX; `dist/` in the repo is not served during development.

0. **Legacy recovery — already confirmed, do not re-probe.** The user verified (2026-07-28) that the existing sweep does fetch HTML for pre-2026-07-12 screens, slowly. Recorded in *Resolved Assumptions*; no probe required. The remaining legacy-data question is a **latency** one, covered by items 3, 4 and 14 below.

1. **Extension — stuck on loading:** Open the Design panel, go to STITCH HTML tab, select a project, click an HTML file in the sidebar. The preview should render (or show a clear error if the file is missing — NOT stuck on loading forever).
2. **Browser — stuck on loading:** Same test in the browser cockpit. The preview should render.
3. **Extension — auto-cache, progressively:** Open the Design panel, go to STITCH HTML tab, select a project that has screens but no cached HTML. Use `stitch-switchboard-gui-optimization-50083924` (10 DB rows, 10 PNGs, 0 HTML) or `switchboard-terracotta-theme-47201300` (13 / 13 / 0) — both verified reproduction cases. The status line must show `Caching HTML… n/total` **while it runs**, files must appear in the sidebar **one by one** rather than all at the end, and the line must resolve to the file count when done. A sweep that only paints at completion is a fail even if the final state is correct.
4. **Browser — auto-cache, progressively:** Same test in the browser cockpit. This is the case the debounced sweep pushes exist for (shim watchers are no-ops), so confirm the sidebar populates incrementally **without** a manual refresh.
5. **Error recovery:** Manually delete an HTML file from the cache dir while it's listed in the sidebar, then click it. The loading state should clear and show `Preview error: HTML file not found on disk — try Rebuild Cache`, not hang forever.
6. **Rebuild Cache still works:** Click "Rebuild Cache" in the STITCH tab — it should still download HTML and images as before.
7. **Open in HTML Tab:** From the STITCH tab, click "Open in HTML Tab" on a screen — the STITCH HTML tab should open and render the preview.
8. **Stale-response spinner (new):** click two different HTML files in rapid succession. Both spinners must clear; the pane must show the second file. Then force an error on the second click (delete its file first) — the spinner must clear and the message must be the *second* file's error.
9. **Failure reaches the HTTP caller (new):** with the cockpit open, `POST /design/verb/fetchPreview` with a bogus `projectId` and confirm the response body is `{"success":false,"error":…}` — not `{"success":true}`. This is the PRD contract #4 check and the only way to prove the browser can see a failure.
10. **Docs return in the body (new):** `POST /design/verb/stitchHtmlListDocs` with a valid `workspaceRoot`+`projectId` and confirm the response body carries the `docs` array, not a bare ack.
11. **Cached project makes no API calls (new):** re-enter the tab on a fully cached project and confirm no `getScreen` traffic and no error log — the `missing.length === 0` early exit.
12. **Diagnostic fires (new):** point `workspaceRoot` at an unrelated root and confirm the `preview folder rejected` log names the rejected folder and the roots iterated — this is what identifies the residual branch (wrong root vs. missing project row) if any host still fails.
13. **Unconfigured install (new):** with no Stitch API key, enter the tab. The sidebar must list on-disk files (or be empty) with **no** sweep attempted and no error toast.
14. **Project switch mid-sweep (new):** start a sweep on a 13-screen project, then switch the dropdown to another project before it finishes. The abandoned sweep must not repaint the new project's sidebar, and the progress line must not persist into the new project's view. Then switch back — the sweep must resume from whatever is still missing, having kept the files it already downloaded.
15. **Debounce coalescing (new):** during a sweep in the extension, confirm the sidebar is not rebuilding per watcher event in a visible flicker storm. The two watchers per dir plus the sweep's own callback previously produced ~3 immediate rebuilds per file; the 300 ms debounce must collapse them.

### Automated Tests

Not run in this pass (session directive: skip tests). When tests are next touched, the durable assertions are:

- A headless test that dispatches `fetchPreview` through `handleServiceVerb` with an unresolvable `projectId` and asserts the returned **body** is `{success:false, error:…}` — a data-asserting test, per the PRD's "green ratchets + a data-asserting test are the definition of done".
- A headless test that dispatches `stitchHtmlListDocs` against a temp cache dir containing two `.html` files and asserts the returned body's `docs` array has both, with `file`/`sourceFolder`/`absolutePath` populated.
- A unit test over the `PREVIEW_ERROR_TARGETS` table asserting every sourceId that raises a loading state in `loadDocumentPreview` has a matching entry that lowers it — the invariant whose absence caused this bug.
- If any `break` → `return` conversion lands in `DesignPanelProvider`, re-run `npm run verb-returns:check` and lower the Design ceiling in `scripts/verb-return-contract-baseline.json` to the true residual count reported by `analyze-verb-migration2.js` in the same change. Never force it below the legitimate nested-`break` floor (Design = 14).

---

**Recommendation: Send to Coder.** Complexity 6 — mostly routine DOM and return-value work across two files, with one moderate, well-scoped risk (a background sweep that issues remote API calls from a list handler) that is bounded by the `hasKey` / lock / only-missing gates specified above.

## Completion Report

Implemented fixes for STITCH HTML tab loading hangs and missing auto-cache. Added `PREVIEW_ERROR_TARGETS` table, loading state resets, stale request guards, and `workspaceRoot` propagation in `src/webview/design.js`. Added debounced watcher refreshes, diagnostic logging for rejected folders, explicit ENOENT error handling, and background HTML auto-caching (`_backfillStitchHtmlForProject`) in `src/services/DesignPanelProvider.ts`. Files changed: `src/webview/design.js` and `src/services/DesignPanelProvider.ts`. No issues encountered.

