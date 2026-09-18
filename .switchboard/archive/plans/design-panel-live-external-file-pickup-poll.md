# Live External-File Pickup for Design Panel Folder Tabs (Visibility-Gated Poll)

## Goal

Make the Design panel's folder-backed tabs (HTML Previews, Images, Briefs) detect **externally-created files** (written by scripts, agents, git checkouts, or anything not going through VS Code's own file ops) without the user having to leave and re-enter the tab — and do it **without adding yet another always-on `setInterval`** to an extension that already runs many timers.

### Problem Analysis

- VS Code's `createFileSystemWatcher` reliably fires for edits made *through* VS Code, but **frequently misses `onDidCreate` for files created by external processes**, especially under load or for folders outside the primary workspace root. This is the OS-watcher limitation, not a config bug.
- The Design panel already renders watcher pushes live (`htmlDocsReady` → `renderHtmlDocs` in `design.js` has **no active-tab guard**), so *when the watcher fires*, the list updates live. The gap is purely the **missed event**.
- A fetch-on-tab-activation backstop was added (`refreshDocsForTab` message → `_sendHtmlDocsReady` / `_sendImagesDocsReady` / `_sendBriefsDocsReady`), bringing Design to parity with `planning.js`/`project.html`. That recovers a stale list **only on tab re-entry**.
- Remaining gap: a user sitting on the HTML Previews tab while a file is created externally sees nothing until they navigate away and back. `planning.js`/`project.html` share this exact limitation — **neither polls** — so this plan is a deliberate enhancement *beyond* the reference panels, justified by the design workflow (files arrive from external generators/agents while the user watches the tab).

### Performance Constraint (primary design driver)

The extension already runs a significant number of timers — `TaskViewerProvider` alone holds ~10 `setInterval` handles, plus `ContinuousSyncService` (×2), `GlobalPlanWatcherService`, and `PlanningPanelProvider`'s periodic sync. **We must not add an unconditional background poll.** Any poll added here must be:

1. **Visibility-gated** — runs only while `panel.visible === true`. The Design panel does **not** currently wire `onDidChangeViewState`, so this must be added. NOTE: there is no existing `onDidChangeViewState` handler anywhere in `src/services/` to mirror — the only precedent is the dual `onDidDispose` registration pattern at `DesignPanelProvider.ts` lines 117 and 196; the visibility wiring is novel-but-low-risk and follows the same dual-registration shape (open + restore paths).
2. **Tab-gated** — runs only while the active tab is one of the three polled folder tabs: `html-preview` / `images` / `briefs`. When the user is on `stitch` **or `design`**, the poll is fully stopped (not just skipped). See "Out of Scope" for why `design` is excluded.
3. **Single shared timer** — exactly one `setInterval` for the whole panel, not one per tab/folder/root. It re-targets the active tab's scan; it never stacks.
4. **Cheap + diffed** — each tick computes a lightweight directory *signature* and only posts a `*DocsReady` message (triggering a webview re-render) when the signature actually changed. No change → no message → no render churn.
5. **Conservative cadence** — default 4–5s, behind a setting so it can be tuned or disabled.
6. **Fully torn down** — cleared on tab-switch-away, panel hide, and `onDidDispose`; restarted on show/return.

## Metadata

**Complexity:** 5
**Tags:** backend, frontend, performance, feature, reliability

## User Review Required

- Confirm default poll interval (proposed **4000ms**) and that it should ship **enabled by default** for folder tabs (vs. opt-in via setting).
- Confirm scope: HTML Previews + Images + Briefs only. (Stitch is API-backed, not folder-backed — excluded. The `design` tab IS folder-backed but is a design-system doc browser, not a destination for external generators — also excluded; confirm this rationale.)
- Confirm the new setting key name: `switchboard.design.externalFilePollMs` (0 = disabled, falls back to watcher + tab-reenter only).

## Complexity Audit

### Routine
- Wiring `onDidChangeViewState` follows the same dual-registration shape (open + restore paths) as the existing `onDidDispose` handlers at `DesignPanelProvider.ts` lines 117 and 196. No prior `onDidChangeViewState` exists in the codebase, but the registration mechanics are identical.
- Reusing existing `_send*DocsReady()` and `LocalFolderService` extension filters (`.html/.htm` for HTML via `_isHtmlOrImageFile` at line 518; the image set via `_isImageFile` at line 523; `.md` family via `_isTextFile` at line 358).
- Adding a config key to `package.json` under the existing `configuration` block (after the `switchboard.theme.*` entries ending at line 669).

### Complex / Risky
- **Avoiding timer leaks/stacking:** start/stop must be idempotent across the open vs. restore lifecycle and rapid tab switching. A second `open()` of an already-open panel, or a restore, must not leave an orphaned interval. The dual open/restore registration paths (lines 85–165 and 167–246) both need the visibility + poll wiring.
- **Signature cost:** the per-tick `readdir`+`stat` must stay cheap; for a designs folder with hundreds of files this runs every 4s while visible. Mitigate by hashing only `name|size|mtimeMs` (no file reads) and keeping it non-recursive (mirror `LocalFolderService._MAX_DEPTH = 10` only if the existing list methods recurse — they do, so the signature must cover the same depth or it will miss subfolder changes). Confirm the worst-case folder size is acceptable; if folders can be huge, cap the entry count and fall back to mtime-of-dir only. For multi-root workspaces, per-tick cost scales as roots × configured folders × entries — apply the same cap.
- **Double signalling — committed invariant:** **The poll owns `_lastFolderSignature` exclusively.** The watcher path (`_setup*FolderWatchers` → `_send*DocsReady`) does NOT read or write `_lastFolderSignature`. When the watcher fires and pushes a render, the next poll tick recomputes the signature, sees it already matches the post-render state, and no-ops. This removes the ordering hazard entirely.
- **No existing readdir timeout guard (correction):** `LocalFolderService` wraps `readdir` in `try { } catch { return; }` (e.g. line 294) — this catches errors but imposes **no deadline**. A hung NFS/SMB mount would wedge the tick. The tick must add its own per-`readdir` deadline via `Promise.race` against a 5s timer (reject → treat as empty/skip that folder for this tick). This is net-new work, not a reuse.

## Edge-Case & Dependency Audit

- **Race Conditions:** Tab-switch during an in-flight tick — guard the tick with a "still visible && still this tab" re-check before posting (capture `this._activeTab` and `this._panel?.visible` at tick start, re-check before `postMessage`). Panel disposed mid-tick — `_panel` null-check before `postMessage` (already the pattern in `_sendHtmlDocsReady` at line 442). The signature computation is async; if the tab changed by the time the signature is ready, discard it (don't write `_lastFolderSignature[oldTab]` from a scan that the user has already navigated away from — or do write it, since it's still a valid signature for that tab; but do NOT post the render).
- **Performance:** This is the core risk and the reason for visibility+tab gating and signature diffing. Net cost when the panel is hidden or on Stitch/Design: **zero** (timer stopped). When visible on a polled folder tab: one shallow `readdir`+`stat` per configured folder per 4s, no webview message unless something changed.
- **Security:** None. No new input surfaces; reads only already-configured folders via existing `LocalFolderService` resolution (which already validates configured paths).
- **Side Effects:** New config key (backward-compatible default). One additional timer that exists *only* while the panel is visible on a polled folder tab.
- **Dependencies & Conflicts:** Builds on the already-shipped `refreshDocsForTab` handler at `DesignPanelProvider.ts` line 2109. No conflict with the file watchers — they remain as the primary live mechanism; the poll is a safety net for missed external creates. The new `activeTabChanged` message is additive and does not alter `refreshDocsForTab` semantics.

## Dependencies

- None. This plan is self-contained within the Design panel.

## Adversarial Synthesis

Key risks: (1) the plan originally cited a pre-existing NFS/SMB readdir timeout guard that does not exist in `LocalFolderService` — the tick must add its own 5s `Promise.race` deadline or risk wedging on hung mounts; (2) the `design` tab is folder-backed but was never addressed, creating an undefined-handling gap in tab-gating — it must be explicitly excluded and treated as a poll-stopping tab alongside `stitch`; (3) timer-lifecycle correctness across the dual open/restore paths is the most failure-prone surface. Mitigations: commit to poll-exclusive signature ownership (watcher never touches `_lastFolderSignature`), use a separate `activeTabChanged` message rather than overloading `refreshDocsForTab`, and register the visibility handler in both lifecycle paths mirroring the existing dual `onDidDispose`.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`
- **Context:** The provider owns all folder scans and watcher registrations. It currently has no visibility handling and no notion of "active tab" beyond the `refreshDocsForTab` message (line 2109), which only fires for the three polled tabs on tab-entry.
- **Logic:**
  - Add private fields near the existing debounce fields (after line 52):
    - `private _activeTab: string = '';`
    - `private _externalFilePollTimer?: NodeJS.Timeout;`
    - `private _lastFolderSignature: Record<string, string> = {};`  // keyed by tab name
  - Wire `onDidChangeViewState` in **both** `open()` (after the `onDidDispose` at line 117) and `deserializeWebviewPanel` (after the `onDidDispose` at line 196):
    - `this._panel.onDidChangeViewState(e => this._onVisibilityChanged(e.webviewPanel.visible), null, this._disposables);`
  - Add `_onVisibilityChanged(visible: boolean)`: if `visible && this._isPolledTab(this._activeTab)` → `_startExternalFilePoll()`; else → `_stopExternalFilePoll()`.
  - Add `_isPolledTab(tab: string): boolean` → `tab === 'html-preview' || tab === 'images' || tab === 'briefs'`. (`design` and `stitch` both return false → poll stops.)
  - Extend the `onDidChangeConfiguration` handler (lines 153, 234) to also re-read `switchboard.design.externalFilePollMs` and call `_stopExternalFilePoll()` then `_startExternalFilePoll()` if currently visible+polled (to apply the new cadence), or stop if set to 0.
  - Add a new message case `activeTabChanged` (separate from `refreshDocsForTab` — do NOT overload it): set `this._activeTab = message.tab`; if `_isPolledTab(tab)` and panel visible → `_startExternalFilePoll()`; else → `_stopExternalFilePoll()`. Also keep the existing `refreshDocsForTab` case (line 2109) unchanged — it still triggers an immediate rescan on tab entry.
  - Add `_startExternalFilePoll()`: idempotent guard (`if (this._externalFilePollTimer) return;`); read `externalFilePollMs` (default 4000); if 0 → return; `this._externalFilePollTimer = setInterval(() => this._pollTick(), ms)`.
  - Add `_stopExternalFilePoll()`: `if (this._externalFilePollTimer) { clearInterval(this._externalFilePollTimer); this._externalFilePollTimer = undefined; }`.
  - Add `async _pollTick()`:
    - Capture `const tab = this._activeTab; const visible = !!this._panel?.visible;` at entry.
    - Re-check: `if (!visible || !this._isPolledTab(tab) || !this._panel) return;`
    - Compute signature across `_getWorkspaceRoots()` → the tab's `get*FolderPaths()` (resolve via `this._getLocalFolderService(root)`): for each folder, `await Promise.race([fs.promises.readdir(dir, {withFileTypes:true}), timeoutReject(5000)])`, then for each matching-extension entry, `fs.promises.stat` (also raced) collecting `name|size|mtimeMs`. Concatenate and hash (use the already-imported `crypto`).
    - If signature !== `_lastFolderSignature[tab]`: update it and call the matching `_send*DocsReady()` (`html-preview`→`_sendHtmlDocsReady`, `images`→`_sendImagesDocsReady`, `briefs`→`_sendBriefsDocsReady`). Else: no-op.
  - Add `timeoutReject(ms)` helper: `new Promise<never>((_, reject) => setTimeout(() => reject(new Error('readdir timeout')), ms))`.
  - In `onDidDispose` (both paths, lines 117/196): call `this._stopExternalFilePoll()` alongside `this.disposeWatchers()`.
- **Edge Cases:** Hung mount → raced `readdir` rejects → catch per-folder, skip that folder for this tick (signature omits it; next tick retries). Tab switch mid-scan → re-check guard before posting. Panel disposed mid-scan → `_panel` null-check. Config change to 0 → stop; config change to new ms → restart with new cadence.

### `src/webview/design.js`
- **Context:** `switchTab(tabName)` (line 130) currently posts `refreshDocsForTab` only for the three polled tabs (line 170). The provider needs to know about **every** tab switch — including to `stitch` and `design` — so it can stop the poll.
- **Logic:** In `switchTab()`, add an **unconditional** `vscode.postMessage({ type: 'activeTabChanged', tab: tabName });` call (independent of the existing `refreshDocsForTab` block at line 170, which stays as-is for the three polled tabs). Place it before or after the existing `refreshDocsForTab` post — both are fire-and-forget.
- **Edge Cases:** The `activeTabChanged` message must fire on the initial `switchTab(initialTab)` call at line 185 too, so the provider learns the starting tab on `ready`/restore. (The provider's `ready` handler at line 1079 does not currently know the active tab — this fixes that.)

### `package.json`
- **Context:** The `configuration` block starts at line 166; theme entries end at line 669.
- **Logic:** Add after the `switchboard.theme.name` entry (line 669):
  ```json
  "switchboard.design.externalFilePollMs": {
    "type": "number",
    "default": 4000,
    "minimum": 0,
    "description": "Poll interval (ms) for detecting externally-created files in Design panel folder tabs (HTML Previews, Images, Briefs) while the panel is visible. 0 disables polling (falls back to watcher + tab-reenter only).",
    "scope": "window"
  }
  ```
- **Edge Cases:** `minimum: 0` so 0 is valid (disabled). `scope: window` to match the theme settings.

## Verification Plan

### Automated Tests
- SKIP: No automated tests will be run as part of this session. The test suite will be run separately by the user.

### Manual Verification
- With `externalFilePollMs=4000`: open Design panel → HTML Previews tab → from a terminal, `cp` a new `.html` into the configured folder → it appears within ~4s **without** touching the tab.
- Switch to Stitch, repeat the `cp` → confirm (via a temporary log or the debugger) the timer is stopped and no scan runs.
- Switch to the `design` tab, repeat the `cp` into a design folder → confirm the timer is stopped (the `design` tab is excluded from polling).
- Hide the panel (focus another editor group / close the tab group) → confirm `panel.visible` flips and the timer stops.
- Set `externalFilePollMs=0` → confirm no timer is created and behavior falls back to watcher + tab-reenter.
- Drop a large folder (e.g. 500 files) and confirm tick cost is acceptable (signature build time logged once).
- Rapidly switch tabs (html-preview → stitch → images → design → briefs) several times → confirm via debugger/log that only ONE timer ever exists and it correctly starts/stops per tab.
- Restore a hidden panel (`retainContextWhenHidden: true` is set at line 97) → confirm the poll restarts on show if the active tab is polled.
- Simulate a hung mount (point a configured folder at a stalled NFS path) → confirm the tick does not wedge beyond 5s per folder and subsequent ticks still run.

## Out of Scope / Explicitly Not Doing

- No polling for the Stitch tab (API-backed).
- No polling for the `design` tab. It IS folder-backed (`getDesignFolderPaths` / `listDesignFiles` / `_setupDesignFolderWatchers` / `_sendDesignDocsReady` all exist), but it is a design-system document browser, not a destination for external file generators. The watcher + tab-reenter backstop is sufficient there. The poll-stopping logic treats `design` identically to `stitch`. (User to confirm this rationale.)
- No change to `planning.js`/`project.html`. If the watcher-miss recovery is wanted there too, it's a separate plan; this one is scoped to the Design panel where external generators most often write files while the user watches.
- No always-on / panel-hidden polling under any circumstance.

---

**Recommendation:** Complexity is 5 (Mixed: mostly routine wiring + one moderate, well-scoped risk in timer-lifecycle correctness across the dual open/restore paths, plus the net-new readdir timeout wrapper). **Send to Coder.**

## Reviewer Pass (2026-06-21)

### Stage 1 — Adversarial Findings

| ID | Severity | File:Line | Finding |
|---|---|---|---|
| C1 | CRITICAL | `DesignPanelProvider.ts:2649` | `fs.existsSync(dir)` is a **synchronous** stat that runs *before* the raced `readdir`. On a hung NFS/SMB mount it blocks the event loop indefinitely, defeating the 5s `Promise.race` deadline the plan mandated as the #1 adversarial risk. The verification plan's "hung mount" line item would fail. |
| M1 | MAJOR | `DesignPanelProvider.ts:2718` | Signature only collected file entries (`entry.isFile() && filterFn`), not directory entries. The list methods (`_scanHtmlFolder` etc.) render folder nodes, so an externally-created **empty subfolder** would change the rendered list but not the signature → no re-render → missed by both watcher (missed event) and poll (no signature delta). |
| N1 | NIT | `DesignPanelProvider.ts:2729` | Per-stat `Promise.race` against `setTimeout(5000)` leaves orphaned timers when `stat` resolves first. ~500 orphaned timers per tick at 500-file scale. Not a correctness issue (re-check guards prevent stale posts); Node handles it. Deferred. |
| N2 | NIT | `DesignPanelProvider.ts:274` | Public `dispose()` doesn't call `_stopExternalFilePoll()` directly. Transitively safe (`dispose()` → `_panel.dispose()` → `onDidDispose` → stop), but asymmetric with `disposeWatchers()` on the next line. Deferred. |

### Stage 2 — Balanced Synthesis

- **C1 → Fix now.** The `existsSync` guard is both redundant (the raced `readdir` in `_getFolderSignature` already catches non-existent dirs and returns `[]`) and dangerous (synchronous, unraced). Removed.
- **M1 → Fix now.** Added directory entries (`${name}|dir|dir`) to the signature so empty-subfolder creation is detected. Cheap, aligns with rendered output.
- **N1 → Defer.** Not a correctness bug; Node tolerates the timer volume.
- **N2 → Defer.** Transitively covered by `onDidDispose`.

### Verified Correct (no changes needed)

- `_lastFolderSignature` is **poll-exclusive** (only written at `_pollTick` lines 2668-2669); watcher path (`_send*DocsReady`) never reads/writes it — committed invariant holds.
- `onDidChangeViewState` wired in both `open()` (line 126) and `deserializeWebviewPanel` (line 214).
- `onDidDispose` calls `_stopExternalFilePoll()` in both paths (lines 123, 211).
- Config handler reacts to `externalFilePollMs` in both paths (lines 168-173, 258-263).
- `activeTabChanged` is a separate message from `refreshDocsForTab`; the latter is unchanged.
- `switchTab` posts `activeTabChanged` unconditionally (design.js:174), including the initial `switchTab(initialTab)` at line 187 — provider learns the starting tab on ready/restore.
- `_isPolledTab` correctly excludes `design` and `stitch`.
- `_startExternalFilePoll` is idempotent and honors `ms <= 0`.
- Tick re-checks `visible` and `activeTab` before posting (line 2664).
- `package.json` entry matches spec (default 4000, minimum 0, scope window).
- Extension filters match `LocalFolderService` list methods exactly (byte-for-byte).
- Excluded dirs match `_EXCLUDED_DIRS` = `['node_modules', '.git', '.switchboard']`.
- Recursion depth cap matches `_MAX_DEPTH = 10`.
- Symlink and dotfile skipping match the list methods.

### Fixes Applied

1. **`src/services/DesignPanelProvider.ts:2648-2657`** — Removed `fs.existsSync(dir)` gate; `_getFolderSignature` is now called directly. The raced `readdir` inside it handles non-existent dirs (reject → caught → `[]`). Added an explanatory comment documenting why `existsSync` must not be reintroduced.
2. **`src/services/DesignPanelProvider.ts:2718-2725`** — Directory entries now emit a `${entry.name}|dir|dir` signature string, so externally-created empty subfolders are detected by the poll.

### Validation Results

- **Typecheck (`tsc --noEmit`):** 2 pre-existing errors in unrelated files (`ClickUpSyncService.ts:2419`, `KanbanProvider.ts:4866` — relative import extension issues). **Zero new errors** introduced by this review's edits.
- **Compilation:** Skipped per session instructions.
- **Automated tests:** Skipped per session instructions (to be run separately by user).

### Remaining Risks

- **N1 (orphaned stat timers):** At very large folder counts (500+ files) the per-stat `setTimeout` orphans accumulate. Not a correctness issue; if it becomes a perf concern, switch to a single per-folder `AbortController`-based timeout or clear timers on stat resolution.
- **N2 (`dispose()` symmetry):** Safe today via `onDidDispose` cascade; add `_stopExternalFilePoll()` to `dispose()` if the disposal path is ever restructured.
- **Tick overlap:** `setInterval` does not absorb overlapping ticks. If a tick exceeds the interval (multiple hung folders × 5s timeout), the next tick fires concurrently. The re-check guards (`this._activeTab !== tab`, `this._panel?.visible`) prevent stale posts, and signature writes are last-writer-wins idempotent. Acceptable for the 4s default + 5s worst-case-per-folder math.
- **Manual verification items** in the plan's Verification Plan section remain to be executed by the user (hung-mount simulation, rapid tab switching, large-folder cost, restore-after-hide).
