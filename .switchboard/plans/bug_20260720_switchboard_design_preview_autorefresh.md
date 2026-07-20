# Switchboard Design preview doesn't auto-refresh on external/agent edits

> **Doc status (2026-07-20):** bug fix in the **switchboard** extension repo
> (`switchboard/src/services/DesignPanelProvider.ts`). Not a viaapp/`fe`/`be`
> change. Diagnosed from source against the working sibling (Planning preview);
> fix is specified below but not yet implemented.

> **⚠️ CORRECTION (2026-07-20 improve pass):** The original "Root problem /
> background" section below is **factually wrong** about the current code state.
> `DesignPanelProvider` **already** has folder watchers that call
> `_autoRefreshHtmlPreview()` on external writes — added 2026-07-17 (commit
> `00d6a942`), three days before this plan was authored:
> - `_setupHtmlFolderWatchers()` (`DesignPanelProvider.ts:832`) → calls
>   `_autoRefreshHtmlPreview(filePath)` at L845.
> - `_setupClaudeFolderWatchers()` (`DesignPanelProvider.ts:886`) → calls
>   `_autoRefreshHtmlPreview(filePath)` at L901.
> - `_setupStitchHtmlFolderWatchers()` (`DesignPanelProvider.ts:855`) → calls
>   `_autoRefreshHtmlPreview(filePath)` at L879.
>
> These cover **all three** preview types (html, claude, stitch-html) and fire on
> external/agent/script/git writes — same `createFileSystemWatcher` primitive the
> Planning sibling uses. The `onDidSaveTextDocument` listener at L4154 is a
> **redundant backstop**, not the only trigger. The original diagnosis is
> preserved verbatim below per the improve-plan content-preservation rule, but
> the reasoning conclusions are superseded with callouts, and the Approach has
> been reframed to **diagnose-then-fix** (see "## Approach" and
> "## Uncertain Assumptions"). **User review required** before implementation —
> see "## User Review Required".

## Goal

Make the Design panel's HTML preview auto-refresh whenever the previewed file
changes on disk — including edits made by an AI agent, a script, or git — not
only when the file is saved through the VS Code editor.

### Root problem / background

- The Design preview's auto-refresh is wired to the **wrong event**.
  `DesignPanelProvider._registerSaveTextDocListener()`
  (`src/services/DesignPanelProvider.ts:4154`) listens to
  `vscode.workspace.onDidSaveTextDocument`, which fires **only** on an editor
  save (Cmd+S on an open tab). External writes — Claude's Edit tool, build
  scripts, `git`, any non-editor process — never fire it, so
  `_autoRefreshHtmlPreview()` is never called and the preview goes stale.

  > **Superseded:** "The Design preview's auto-refresh is wired to the wrong
  > event... external writes never fire it, so `_autoRefreshHtmlPreview()` is
  > never called."
  > **Reason:** Factual error. `DesignPanelProvider` already runs folder
  > watchers (`_setupHtmlFolderWatchers` L832, `_setupClaudeFolderWatchers`
  > L886, `_setupStitchHtmlFolderWatchers` L855) that call
  > `_autoRefreshHtmlPreview(filePath)` on any external write to the configured
  > html/claude/stitch folders. These were added 2026-07-17 (commit `00d6a942`),
  > predating this plan. The `onDidSaveTextDocument` listener is a redundant
  > backstop, not the sole trigger.
  > **Replaced with:** The auto-refresh IS already wired to filesystem watchers
  * for external writes. The real bug is that the existing watchers do not fire
  * (or their output is filtered out) for the user's specific scenario. Root
  * cause is **unknown** pending reproduction — see "## Uncertain Assumptions"
  * and the reframed Approach.

- The refresh handler itself, `_autoRefreshHtmlPreview()`
  (`DesignPanelProvider.ts:4164`), is correct: 300ms debounce, exact path match
  against the active preview, silent-fail on mid-write reads (`requestId === -1`).
  Only its **trigger** is wrong.

  > **Superseded:** "Only its trigger is wrong."
  > **Reason:** The trigger is NOT wrong — folder watchers already feed it. If
  > the handler is reached and the preview is still stale, the more likely
  > culprit is the **exact-path match** at L4174 (`changedPath !== activePath`)
  > failing due to path normalization (trailing slash, symlink, case on
  > case-insensitive macOS), OR the folder watcher never firing because the
  > design folder sits outside any VS Code workspace folder (where
  > `createFileSystemWatcher` is unreliable on macOS fsevents).
  > **Replaced with:** Both the trigger AND the path-match filter are suspect.
  * Diagnose before fixing.

- **Proof — the working sibling.** The Planning preview has the identical
  feature and refreshes correctly because it watches the filesystem:
  `PlanningPanelProvider.ts:2121` uses
  `this._seams().watcher.watchFile(activePath, …)` →
  `createFileSystemWatcher.onDidChange` (`hostSeams.ts:447`), which catches
  external writes. Both providers even name the field `_saveTextDocListener`;
  Design wired it to the editor-save event, Planning to a file watcher.

  > **Superseded:** "Design wired it to the editor-save event, Planning to a
  > file watcher" — implying Design has no file watcher.
  > **Reason:** Misleading by omission. Design ALSO has file watchers — three
  > `watchFolder` setups (L842, L873, L896) that fire on external writes to the
  > configured folders. Planning's `watchFile` at L2121 is a per-active-file
  > watcher; Design's `watchFolder` is a per-folder watcher. Both use the same
  > `createFileSystemWatcher` primitive (`hostSeams.ts:429-456`). The sibling
  > comparison does NOT establish that Design lacks external-write coverage.
  > **Replaced with:** The meaningful difference is **scope**: Planning watches
  * the single active preview file; Design watches the whole configured folder.
  * If the active preview file lives OUTSIDE the configured folder (or outside
  * any workspace folder), Design's folder watcher misses it while Planning's
  * per-file watcher would not. That is the testable hypothesis — not "Design
  * has no watcher."

- **Why it recurs / seems flaky.** In this workflow the design files are almost
  always edited by an agent or a script, never by a manual editor save — so the
  preview is stale after essentially every AI edit. It only appears to work when
  the file is hand-edited and saved, which is why it feels intermittent.

  > **Superseded:** "the preview is stale after essentially every AI edit."
  > **Reason:** If the existing folder watchers work, AI edits inside the
  > configured folders DO refresh the preview. The "feels intermittent" symptom
  > is consistent with a **coverage** bug (some folders/files covered, others
  > not — e.g. out-of-workspace, or a `sourceFolder` from the webview that
  > doesn't resolve to a watched path), not a "never works" bug.
  > **Replaced with:** Symptom is consistent with partial coverage or
  * path-mismatch — reproduce and log before claiming a trigger defect.

## Approach

> **Superseded (whole section):** Original Approach #1–#4 proposed replacing the
> `onDidSaveTextDocument` registration with a `watchFile` watcher and
> re-registering on preview switch, framed as "the trigger is wrong, replace
> it."
> **Reason:** The premise is false — folder watchers already exist and already
> call `_autoRefreshHtmlPreview`. Replacing the (harmless, redundant)
> `onDidSaveTextDocument` listener does not fix anything. Mirroring Planning's
> `watchFile` would add a SECOND watcher layer over the same
> `createFileSystemWatcher` primitive, inheriting the same out-of-workspace
> blind spot if that is the real root cause.
> **Replaced with:** Diagnose-then-fix (below). The original per-file `watchFile`
> idea is retained as **option (c)** — a supplement, not a replacement.

**Reframed approach — Branch A is the confirmed fix (user + research confirmed).**

> **Update (2026-07-20):** The user confirmed their design folder is outside
> any VS Code workspace root (separate repo, not added as a multi-root child).
> Combined with the web research confirming `createFileSystemWatcher` is
> unreliable for out-of-workspace paths, **Branch A is the locked diagnosis**.
> Branches B/C/D are retained below as fallbacks only if Branch A's fix fails
> to resolve the bug in reproduction.

1. **Reproduce + instrument (OPTIONAL now — root cause confirmed).** The coder
   MAY add temporary logging to verify the folder watcher fails to fire before
   applying the fix, but it is not blocking. If skipping, go straight to Step 2
   Branch A. If logging:
   - `_setupHtmlFolderWatchers` / `_setupClaudeFolderWatchers` /
     `_setupStitchHtmlFolderWatchers` — log each watched path, whether
     `fs.existsSync(p)` was true, and whether the path is inside any workspace
     root.
   - The folder-watcher callback (L842/L873/L896) — log `event` + `filePath`
     when it fires (expected: does NOT fire for the out-of-workspace folder).
   - `_autoRefreshHtmlPreview` entry (L4164) — log `changedFsPath` (expected:
     not reached for external writes to the out-of-workspace folder).
   - Reproduce: open a design preview for the out-of-workspace folder, edit
     the file with an external tool, observe the watcher callback does NOT fire.

2. **Apply the fix — Branch A (out-of-workspace `fs.watch` fallback):**
   - In `_setupHtmlFolderWatchers` (L832), `_setupClaudeFolderWatchers` (L886),
     and `_setupStitchHtmlFolderWatchers` (L855), after creating the
     `createFileSystemWatcher` handle, check whether the folder is inside any
     workspace root:
     `this._getWorkspaceRoots().some(r => p.startsWith(r + path.sep))`.
   - If NOT inside any workspace root, add a native
     `fs.watch(p, { recursive: true }, (event, filename) => { ... })` calling
     the same `_sendXDocsReady()` + `_autoRefreshHtmlPreview(filePath)` logic,
     with a 4s TTL dedup map mirroring `TaskViewerProvider.ts:370` (prevents
     `fs.watch` double-fire on macOS).
   - Push the `fs.watch` handle into a parallel `_xFolderNativeWatchers`
     array so the dispose path at L713-735 disposes it.
   - **Linux guard (CONFIRMED):** `fs.watch` with `{ recursive: true }` is
     unsupported on Linux — wrap in try/catch, log a warning
     `"[DesignPanelProvider] fs.watch recursive fallback unavailable on Linux for '<path>' — out-of-workspace external writes may not refresh"`,
     and skip the native handle on Linux. Do NOT fall back to `chokidar`.
   - Keep the `createFileSystemWatcher` as primary (it works for in-workspace
     folders); layer `fs.watch` ONLY for out-of-workspace paths.
   - Do NOT use the v1.84+ `createFileSystemWatcher(pattern, options)`
     proposed-API variant (extension does not opt into proposed APIs).

3. **Fallback branches (only if Branch A fails to resolve in reproduction):**
   - **Branch B — folder watcher fires but `_autoRefreshHtmlPreview` rejects
     the path** (path normalization mismatch at L4174). Fix: normalize both
     sides — `fs.realpathSync` + `path.normalize` + darwin lowercase — at L4165
     and L4172. Guard `realpathSync` with try/catch. CONFIRMED justified by
     VS Code Issue #162498 (trailing-slash silent failure).
   - **Branch C — folder watcher fires, path matches, but no refresh**
     (`_panel?.visible` false at fire time, or `_active*Preview` cleared
     between fire and the 300ms debounce callback). Least likely — the debounce
     callback already re-resolves the active preview (L4180-4189).
   - **Branch D — per-active-file `watchFile` supplement** mirroring
     `PlanningPanelProvider.ts:2121`, re-registered on each preview set/clear
     at L2318/L2338/L2344/L2352/L2354/L3301 with disposal. SUPPLEMENT to the
     folder watchers, not a replacement. Note: `watchFile` uses the same
     `createFileSystemWatcher` primitive (`hostSeams.ts:447`) and would
     inherit the same out-of-workspace blind spot — so Branch D alone would
     NOT fix this bug; it is only useful as a supplement after Branch A.

3. **Lifecycle (applies to any branch that adds a watcher):** dispose the
   previous watcher on preview switch and on panel dispose (L713-735 already
   disposes `_htmlFolderWatchers`/`_claudeFolderWatchers`/`_stitchHtmlFolderWatchers`
   — extend the same pattern). The stitch watcher already carries a
   race-guard comment at L866-870 against orphan callbacks; any new per-file
   watcher must follow the same guard.

4. **Remove instrumentation** after the fix is confirmed.

## Files

- `switchboard/src/services/DesignPanelProvider.ts` — primary target.
  - `_registerSaveTextDocListener()` (L4154) — redundant backstop; keep.
  - `_autoRefreshHtmlPreview()` (L4164-4205) — path-match filter at L4174
    suspect (Branch B); visibility/active-preview guards at L4157, L4183
    (Branch C).
  - `_setupHtmlFolderWatchers()` (L832-853), `_setupClaudeFolderWatchers()`
    (L886-909), `_setupStitchHtmlFolderWatchers()` (L855-884) — watcher
    coverage (Branch A); add `fs.watch` fallback here if out-of-workspace.
  - `_active*Preview` assignment sites: L2163-2169, L2318, L2338, L2344,
    L2352-2354, L3301 — re-registration points for any per-file watcher
    (Branch D).
  - Dispose path: L713-735.
- Reference only (do not change unless Branch A/D chosen):
  - `PlanningPanelProvider.ts:2121` — per-file `watchFile` pattern (Branch D).
  - `hostSeams.ts:429-456` — `watchFolder`/`watchFile` both use
    `createFileSystemWatcher`; same out-of-workspace limitation.
  - `TaskViewerProvider.ts:12221-12274`, `GlobalPlanWatcherService.ts:428,463,566`
    — proven `fs.watch` native fallback pattern (Branch A).
  - `LocalFolderService.ts:416,493` — `getHtmlFolderPaths`/`getClaudeFolderPaths`
    return configured folders; verify the user's design folder is in this set.

## Acceptance criteria

- [ ] Reproduction confirms which branch (A/B/C/D) applies; root cause documented
      in the plan or a linked note before the fix is applied.
- [ ] Editing a previewed design HTML file with an external tool (agent/script/git)
      refreshes the Design preview within ~300ms, with no editor save.
- [ ] Works for all three preview types (html, claude, stitch-html).
- [ ] Works for design folders **outside** any VS Code workspace folder (Branch A
      acceptance) — verify with an out-of-workspace design folder.
- [ ] Switching the active preview re-points any per-file watcher; the old file
      no longer triggers refreshes and watchers are disposed (no leaks).
- [ ] Manual editor save still refreshes (no regression —
      `onDidSaveTextDocument` kept).
- [ ] Mid-write reads still fail silently (no error toast on partial files —
      `requestId === -1` path at L4144 preserved).
- [ ] Path-match filter (L4174) does not reject valid writes due to trailing
      slash, symlink, or case differences (Branch B acceptance).

## Risks / notes

- Watcher lifecycle: ensure old watchers are disposed on preview switch and panel
  dispose to avoid leaks / duplicate refreshes.
- Rapid successive writes are already covered by the existing 300ms debounce.
- **Do not ship a "fix" that only passes the in-workspace acceptance test** —
  the user's perceived bug may be out-of-workspace. The acceptance criteria
  explicitly include an out-of-workspace case.
- `fs.watch` recursive behavior is platform-dependent (reliable on macOS/Win,
  limited on Linux without `chokidar`). The existing fallbacks in
  `TaskViewerProvider`/`GlobalPlanWatcherService` use `{ recursive: true }` —
  follow the same pattern; do not introduce `chokidar` as a new dependency.

## Metadata

- **Tags:** bugfix, frontend, reliability
- **Complexity:** 5

## User Review Required

**Update (2026-07-20): RESOLVED.** The user confirmed the bug scenario:
- Design files live in a **separate repo** on disk (not nested inside the
  switchboard repo).
- The design repo was **NOT added as a child workspace** (VS Code multi-root
  workspace root) to the parent switchboard repo.
- The design folder IS configured in `htmlFolderPaths` (otherwise the preview
  would not open — `_buildAndSendPreview` L4078 hard-rejects unconfigured
  folders).

**Diagnosis locked: Branch A (out-of-workspace watcher failure).** The folder
watcher IS created (`_setupHtmlFolderWatchers` L842) but
`createFileSystemWatcher(RelativePattern(absoluteFolder, '**/*'))` silently
drops events for folders outside any VS Code workspace root — confirmed by web
research (macOS fsevents, Linux inotify, Windows buffer/trailing-slash). The
`onDidSaveTextDocument` backstop only catches editor saves, so external writes
(agent/script/git) leave the preview stale.

**The diagnose-then-fix Step 1 (instrumentation) is now optional** — the root
cause is confirmed by the user's scenario + research. The coder MAY still add
temporary logs to verify the watcher fails to fire before applying the fix, but
it is not blocking. Proceed directly to Branch A implementation.

**Remaining user decision (non-blocking):** on Linux, `fs.watch({ recursive: true })`
is unsupported (CONFIRMED). The fix will be macOS/Windows-only for parity with
existing in-repo fallbacks (`TaskViewerProvider`, `GlobalPlanWatcherService`),
with a logged warning on Linux. If the user needs Linux coverage, a custom
recursive subdirectory tracker is required (more code) — defer unless requested.

## Complexity Audit

### Routine
- Adding temporary logging at three call sites (Step 1) — single-file, no new
  patterns.
- Path normalization in `_autoRefreshHtmlPreview` (Branch B) — two-line
  `fs.realpathSync` + `path.normalize` with try/catch.
- Keeping `onDidSaveTextDocListener` as-is (no change).
- Removing instrumentation after fix.

### Complex / Risky
- Branch A `fs.watch` native fallback: new pattern for this provider (though
  proven in `TaskViewerProvider`/`GlobalPlanWatcherService`); platform-dependent
  recursive behavior; lifecycle must mesh with the existing
  `createFileSystemWatcher` primary without double-firing.
- Branch D per-file `watchFile` supplement: re-registration across three preview
  types and six assignment sites; disposal correctness; interaction with the
  existing folder watchers (double-refresh risk — mitigated by the existing
  300ms debounce, but still a state surface).
- Root cause is UNKNOWN — wrong branch wastes effort and may ship a non-fix.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - Folder watcher fires while `_active*Preview` is mid-switch — the stitch
    watcher already guards this (L866-870); any new watcher must too.
  - 300ms debounce callback (L4177) re-resolves the active preview (L4180-4189)
    — correct, but a per-file watcher's closure could capture a stale
    `activePath`; re-resolve inside the callback, do not trust the closure.
  - `fs.watch` double-fires on macOS — `TaskViewerProvider` uses a 4s TTL dedup
    map (L370); reuse the same dedup strategy if Branch A is taken.
- **Security:** No new surface. Watchers do not execute content; refresh just
  re-reads and re-renders HTML already trusted by the existing preview path.
- **Side Effects:**
  - Adding `fs.watch` handles leaks OS file descriptors if not disposed —
    follow the L713-735 dispose pattern.
  - Path-normalization with `fs.realpathSync` can throw on a mid-write file
    (transient ENOENT) — must try/catch and skip, not crash the watcher.
- **Dependencies & Conflicts:**
  - No new npm dependencies. Do NOT introduce `chokidar` — the codebase uses
    native `fs.watch` for fallbacks.
  - Conflicts with any in-flight PR touching `_setupHtmlFolderWatchers` or
    `_autoRefreshHtmlPreview` — check `git log` before editing.

## Dependencies

- None. Single-file change in `switchboard/src/services/DesignPanelProvider.ts`
  (Branch B) or same file plus a small `fs.watch` block (Branch A). No
  cross-plan dependencies.

## Uncertain Assumptions

> **Update (2026-07-20):** Web research completed. Items 1, 3, and 4 are now
> **CONFIRMED** (findings below). Item 2 remains user-input-dependent.

1. ✅ **CONFIRMED — `createFileSystemWatcher(RelativePattern(absoluteFolder, '**/*'))`
   IS officially supported for out-of-workspace paths (VS Code v1.64, Jan 2022)
   but is unreliable across platforms:**
   - **macOS (`fsevents`):** silently drops events under heavy system I/O;
     may trigger OS permission requests for sandbox-protected paths.
   - **Windows (`ReadDirectoryChangesW`):** fails on absolute paths with
     trailing slashes (e.g. `C:\`) — VS Code Issue #162498; OS buffer
     overflow on massive write bursts drops events.
   - **Linux (`inotify`):** exhausts `max_user_watches` → silent failure;
     `files.watcherExclude` does NOT apply to out-of-workspace paths;
     cross-host-boundary (Docker/WSL 9P) drops events.
   - Sources: [VS Code Wiki — File Watcher Internals](https://github.com/microsoft/vscode/wiki/File-Watcher-Internals),
     [File Watcher Issues](https://github.com/microsoft/vscode/wiki/File-Watcher-Issues),
     [v1.64 release notes](https://code.visualstudio.com/updates/v1_64#_vscodeworkspacecreatefilesystemwatcher-now-supports-any-path),
     [Issue #162498](https://github.com/microsoft/vscode/issues/162498).
   - **Implication:** Branch A's premise holds — out-of-workspace watching is
     officially supported but lossy. The existing in-repo `fs.watch` fallbacks
     in `TaskViewerProvider`/`GlobalPlanWatcherService` are justified.
2. ✅ **CONFIRMED — The user's design folders sit OUTSIDE the VS Code workspace
   root.** User confirmed: design files live in a separate repo that was NOT
   added as a child workspace (multi-root) to the parent switchboard repo. The
   folder IS in `htmlFolderPaths` config (preview opens) but is NOT inside any
   VS Code workspace root. **Branch A is the confirmed root cause.**
3. ✅ **CONFIRMED with caveat — `fs.watch({ recursive: true })` is NOT supported
   on Linux** (only macOS/Windows native). On Linux it fails silently or
   throws. **This means the existing `TaskViewerProvider.ts:12221` and
   `GlobalPlanWatcherService.ts:566` `{ recursive: true }` fallbacks are
   silently broken on Linux.** Any Branch A fix must either: (a) accept
   macOS/Windows-only fallback (matches existing in-repo pattern, leaves Linux
   out-of-workspace uncovered — document this), (b) build a custom recursive
   subdirectory tracker using non-recursive `fs.watch` per directory (more
   code), or (c) use `chokidar` (new dependency — **rejected** per existing
   codebase convention; see Risks). Recommended: option (a) for parity with
   existing fallbacks, with a logged warning on Linux.
4. ✅ **CONFIRMED — Path normalization mismatch (Branch B) is a real, documented
   failure mode.** VS Code Issue #162498 documents that absolute paths with
   trailing slashes cause `RelativePattern` matching to silently fail on
   Windows. The webview-supplied `sourceFolder` (L2339, L2345) is
   `path.resolve(message.sourceFolder)` — `path.resolve` strips trailing
   slashes on POSIX but NOT always on Windows drive roots. Combined with
   symlinked design folders and case-insensitive macOS, the L4174
   `changedPath !== activePath` exact-string compare is fragile. Branch B
   (`fs.realpathSync` + `path.normalize` + darwin lowercase) is justified.

**Additional findings from research (not assumptions, but actionable):**
- **VS Code v1.84+ (Oct 2023)** introduced
  `createFileSystemWatcher(pattern, options?: FileSystemWatcherOptions)` with
  custom exclude rules — bypasses `files.watcherExclude` limitations. This is
  a **proposed API**; using it requires `enableProposedApi` + a proposed-api
  contract, which the extension likely does not have. **Do NOT use** unless
  the extension already opts into proposed APIs.
- **Non-existent watched folder → 5s polling fallback** (VS Code handles
  automatically). If the user's design folder is created AFTER the watcher
  setup, there's a 5s lag — acceptable for this feature.
- **Double-firing on save from within VS Code** (Issue #163352) — relevant to
  the existing 300ms debounce; already mitigated. No action needed.
- **Pure string glob (e.g. `'**/*.json'`) limits to workspace only** — does
  NOT apply here; `hostSeams.ts:430` correctly uses `RelativePattern`.

## Adversarial Synthesis

Key risks: (1) the original plan was built on a misdiagnosis (folder watchers
already exist) — corrected; (2) the confirmed root cause is out-of-workspace
`createFileSystemWatcher` failure, and the fix (native `fs.watch` fallback) is
NOT supported on Linux (`{ recursive: true }` is macOS/Windows-only) — Linux
out-of-workspace users remain uncovered, documented with a logged warning;
(3) `fs.watch` double-fires on macOS — mitigated by a 4s TTL dedup map
mirroring `TaskViewerProvider.ts:370`; (4) lifecycle — native handles must be
disposed on preview switch and panel dispose (extend L713-735). Mitigations:
Branch A is the locked fix (user + research confirmed); fallback branches
B/C/D retained only if reproduction fails; explicit out-of-workspace
acceptance criterion.

## Proposed Changes

### `switchboard/src/services/DesignPanelProvider.ts`

**Context:** The provider already has three folder-watcher setups
(`_setupHtmlFolderWatchers` L832, `_setupClaudeFolderWatchers` L886,
`_setupStitchHtmlFolderWatchers` L855) that call `_autoRefreshHtmlPreview` on
external writes, plus a redundant `onDidSaveTextDocument` backstop (L4154). The
user reports stale previews despite this — root cause unknown.

**Logic:** Diagnose first (Step 1 instrumentation), then apply exactly one
branch fix (A/B/C/D) based on the observed failure. Do NOT apply all branches.

**Implementation:**

- **Step 1 (instrumentation, all branches):** Add `console.debug` (or
  `_outputChannel`) logging at:
  - L832/L855/L886 — entry of each `_setup*FolderWatchers`: log each candidate
    path, `fs.existsSync` result, and watcher-creation outcome.
  - L842/L873/L896 — inside each watcher callback: log `event` + `filePath`.
  - L4164 — `_autoRefreshHtmlPreview` entry: log `changedFsPath`.
  - L4174 — the reject check: log `changedPath`, `activePath`, and whether the
    check rejected.
  - Reproduce the user's scenario, capture logs, pick the branch.
- **Branch A (out-of-workspace `fs.watch` fallback):** In each
  `_setup*FolderWatchers`, after creating the `createFileSystemWatcher` handle,
  check whether the folder is inside any workspace root
  (`this._getWorkspaceRoots().some(r => p.startsWith(r + path.sep))`). If NOT,
  add `fs.watch(p, { recursive: true }, (event, filename) => { ... })` calling
  the same `_sendXDocsReady()` + `_autoRefreshHtmlPreview(filePath)` logic,
  with a 4s TTL dedup map mirroring `TaskViewerProvider.ts:370`. Push the
  `fs.watch` handle into the same `_xFolderWatchers` array (or a parallel
  `_xFolderNativeWatchers` array) so L713-735 disposes it. **Linux guard:**
  `fs.watch` with `{ recursive: true }` is unsupported on Linux (CONFIRMED) —
  wrap in try/catch, log a warning
  `"[DesignPanelProvider] fs.watch recursive fallback unavailable on Linux for '<path>' — out-of-workspace external writes may not refresh"`,
  and skip the native handle on Linux. Do NOT fall back to `chokidar`.
- **Branch B (path normalization):** At L4165, replace
  `const changedPath = path.resolve(changedFsPath);` with a normalized form:
  `let changedPath; try { changedPath = fs.realpathSync(path.resolve(changedFsPath)); } catch { changedPath = path.resolve(changedFsPath); }`.
  Do the same at L4172 for `activePath`. On darwin, additionally lowercase both
  for the comparison only (keep originals for logging). **CONFIRMED justified:**
  VS Code Issue #162498 documents trailing-slash silent-failure on Windows;
  `path.resolve` does not always strip trailing slashes on Windows drive roots.
  Also strip trailing slashes explicitly with `path.normalize` before compare.
- **Branch C (visibility/active-preview gate):** Inspect L4157
  (`!this._panel?.visible`) and L4183 (`!current || !this._panel`). If the
  watcher fires while the panel is hidden but the user later focuses it and
  expects fresh content, consider relaxing the visibility gate for auto-refresh
  OR adding a "refresh on panel re-show" hook. Confirm via logs first.
- **Branch D (per-file `watchFile` supplement):** Add a
  `_activePreviewFileWatcher?: HostWatchHandle` field. At each
  `_active*Preview = …` assignment site (L2318, L2338, L2344) and clear site
  (L2163-2169, L2352-2354, L3301), dispose the old handle and, when a new
  active preview is set, call
  `this._seams().watcher.watchFile(activePath, (event) => { if (event === 'change') this._autoRefreshHtmlPreview(activePath); })`.
  Add the new handle to `_disposables` and to the dispose path at L713-735.
  Re-resolve `activePath` inside the callback (do not trust the closure across
  preview switches).
- **Step 4 (cleanup):** Remove all Step 1 instrumentation logging.

**Edge Cases:**
- Mid-write `realpathSync`/`readFile` failures — try/catch, skip silently
  (preserve the `requestId === -1` silent-fail contract at L4144).
- `fs.watch` macOS double-fire — dedup map (Branch A).
- Per-file watcher closure capturing a stale `activePath` — re-resolve inside
  the callback (Branch D).
- Rapid preview switching — dispose-before-create ordering; the stitch race
  guard at L866-870 is the template.

## Verification Plan

> **Per session directives:** SKIP compilation. SKIP automated tests. The
> verification is manual reproduction only.

### Automated Tests
- None required for this pass (skipped per session directive). If a test
  harness for `DesignPanelProvider` exists later, the path-normalization
  (Branch B) and watcher-dispose (Branch A/D) paths are the highest-value
  unit tests to add.

### Manual Verification (reproduction-driven)
1. **Baseline (before fix):** Open a Design preview for a file in the user's
   actual design folder. Edit the file with an external tool (e.g.
   `echo "<p>edit</p>" >> file.html` from a terminal, or an agent Edit tool).
   Confirm the preview does NOT refresh (reproduces the bug).
2. **Instrumentation (Step 1):** Apply the logging, reload the extension,
   reproduce, capture logs. Confirm which branch applies.
3. **Fix (chosen branch):** Apply the single branch fix, reload, reproduce.
   Confirm the preview refreshes within ~300ms.
4. **Out-of-workspace (Branch A acceptance):** Configure a design folder
   outside the VS Code workspace root, open a preview, external-edit, confirm
   refresh.
5. **All three preview types:** Repeat for html, claude, stitch-html.
6. **No regression:** Open a file in an editor tab, Cmd+S save, confirm
   refresh still fires (via the kept `onDidSaveTextDocument` backstop).
7. **No leaks:** Switch active preview 10 times, check
   `DesignPanelProvider` watcher arrays (`_htmlFolderWatchers`,
   `_claudeFolderWatchers`, `_stitchHtmlFolderWatchers`, and any new
   per-file/native arrays) stay bounded — no growth across switches.
8. **Mid-write silent fail:** External-edit with a tool that writes in two
   rapid partial flushes; confirm no error toast, preview settles on final
   content.

## Recommendation

Complexity 5 → **Send to Coder** (with the User Review Required block resolved
first). The fix itself is small, but the diagnose-first step and the
out-of-workspace fallback (if needed) require judgment and reproduction
discipline — not an Intern task.
