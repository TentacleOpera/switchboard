# Memo Write-Back Watcher — Reflect External Edits to `memo.md`

## Goal

Watch `.switchboard/memo.md` and refresh the Memo panel when the file changes on disk, so a memo written or rewritten by an **external agent** appears without the user reloading the panel.

### Problem & background

**Root cause: plans are watched, memo is not.** `GlobalPlanWatcherService` registers `createFileSystemWatcher` handles over plan-file patterns (`src/services/GlobalPlanWatcherService.ts:141, 186`), so a plan file written by any process — a local agent, the user's editor, an external AI with folder access — is imported and shows up on the board. `.switchboard/memo.md` has no equivalent. Its path is resolved at `TaskViewerProvider.ts:4674` (`path.join(workspaceRoot, '.switchboard', 'memo.md')`), and the panel reads it strictly on demand through the `memoLoad` verb, which `PlanningPanelProvider` delegates to `TaskViewerProvider` (`PlanningPanelProvider.ts:114-119`).

That was fine while the only writers were the Memo panel itself and a local agent the user was watching. It stops being fine the moment an **external** agent is a first-class writer: the sibling *External-Agent Skill Launchers* plan hands a memo-processing prompt to Gemini Spark, which writes back via its Connected Folders access. Today the result is invisible in an open Memo panel until the panel is reloaded — the file is correct, the UI silently is not, and the user cannot tell which.

**Why this is its own plan.** It is a small, self-contained fix with a different risk profile from the two UI plans it supports, it is independently shippable and useful (it also covers the user hand-editing `memo.md` in their editor), and bundling it into the launcher plan would hide a service-layer change inside a UI change.

---

## Metadata
**Complexity:** 2
**Tags:** bugfix, backend, reliability
**Project:** browser-switchboard

---

## User Review Required

**None.**

---

## Complexity Audit
* **Score:** 2 / 10

### Routine
* Registering one watcher over a single known path.
* Pushing an existing payload shape to the panel on change — the `memoLoad` result already exists and is already rendered.
* Disposing the watcher with the provider.

### Complex / Risky
* **Echo suppression.** The Memo panel writes the same file through `memoSave`. A naive watcher fires on the panel's own write and pushes state back at it, which at best is wasted work and at worst clobbers in-progress typing.
* **Watcher reliability caveat is documented in this codebase.** `DesignPanelProvider.ts:291` records that `createFileSystemWatcher` silently drops events on macOS fsevents and Linux in some conditions, and `:1006-1011` describes the native-fallback reasoning. Do not assume a single VS Code watcher is sufficient without checking that precedent.

---

## Edge-Case & Dependency Audit

### Race Conditions
* **Self-write echo** — the primary hazard. Suppress by comparing content, or by ignoring events within a short window of the provider's own `memoSave`. Prefer content comparison: it is stateless and cannot leak a suppression window into an unrelated external write that happens to arrive quickly.
* **Partial write** — an external agent may write in chunks, firing a change event mid-write. Debounce briefly (~150-300 ms) and read after the debounce, not on the raw event.
* **Panel closed** — a change arriving with no panel open must be a no-op, not an error. The next `memoLoad` picks up the file as it always has.
* **User typing while an external write lands** — a real conflict with no good silent answer. For v1 do **not** silently overwrite an unsaved buffer; refresh only when the panel has no pending local edit, and otherwise leave the panel alone. Do not add a merge dialog.

### Security
* None. Local file read of a path already read by the same provider.

### Side Effects
* Memo panel becomes reactive rather than load-on-demand. Deliberate.
* One additional watcher handle per workspace root. Negligible, but it must be disposed with the provider or it leaks across reloads.

### Dependencies & Conflicts
* Memo path — `TaskViewerProvider.ts:4674`.
* Memo verbs — `memoLoad` / `memoSave` / `memoClear` / `memoGeneratePrompt`, delegated at `PlanningPanelProvider.ts:114-119`.
* **Watcher seam — `hostSeams.ts:543-580`** (`HostFileWatcher`; use `watchFile` for this single-file watch, abstracting `vscode.workspace.createFileSystemWatcher`). Use the seam, never `vscode.*` directly, so the arm stays host-agnostic and runs under the standalone host (PRD contract #3).
* Precedent and warnings — `TaskViewerProvider.ts:13077-13099` (same-provider native `fs.watch` fallback + dedup guard for `.switchboard`, the direct pattern to mirror); `GlobalPlanWatcherService.ts:141, 186`; `DesignPanelProvider.ts:291, 1006-1011`.
* Push path — the existing broadcaster; the push is **additive** to the HTTP body contract, not a replacement (PRD contract #4).

---

## Dependencies
* None. Ships independently; the memo launcher in the sibling plan is materially better with it.

---

## Adversarial Synthesis

Key risks: (1) **self-write echo** — the panel saves the file it is watching, so an unguarded watcher pushes state back at the panel and can clobber in-progress typing; (2) **watcher unreliability** — this codebase already documents `createFileSystemWatcher` silently dropping events on macOS fsevents and Linux (`DesignPanelProvider.ts:291`), so a single naive handle may simply not fire; (3) **partial reads** — an external agent writing in chunks fires mid-write and yields truncated content. Mitigations: suppress echoes by content comparison rather than a timing window; follow the existing native-fallback precedent rather than assuming one watcher suffices; debounce and read after settle; never overwrite a panel with unsaved local edits.

---

## Proposed Changes

### 1. `src/services/TaskViewerProvider.ts` — watch the memo file

**Context:** this provider owns the memo path (`:4674`) and the memo verbs, so the watcher belongs beside them.

**Implementation:**
> **Superseded:** register a watcher over `<workspaceRoot>/.switchboard/memo.md` through `hostSeams.watchFolder` (`hostSeams.ts:532-564`).
> **Reason:** `watchFolder` watches a folder recursively — the wrong tool for a single known file. The seam has a dedicated single-file method, `watchFile(filePath, listener)` (`hostSeams.ts:548-549`; vscode impl at `:571-580`, which pins a `RelativePattern` to the exact filename).
> **Replaced with:** register the watcher **through `hostSeams.watchFile`** on `<workspaceRoot>/.switchboard/memo.md` — not `watchFolder`, and never `vscode.workspace.createFileSystemWatcher` directly.
* Debounce change events (~150-300 ms). After the debounce, read the file.
* Compare against the last content this provider wrote or served. If unchanged, drop the event — that is the echo guard.
* If changed, broadcast the same payload `memoLoad` returns, so the panel's existing render path handles it with no new client-side shape.
* Dispose the watcher with the provider.

**Logic:** content comparison rather than a time window means a genuine external write arriving milliseconds after a local save is still delivered. A timing window would swallow it, and that is precisely the case this plan exists to serve.

**Edge cases:**
* File absent (never created, or cleared by `memoClear`) — treat as empty, do not throw. `memoClear` legitimately removes or empties it.
* **Native fallback is warranted — the precedent is in this same file.** `TaskViewerProvider.ts:13077-13099` records that `createFileSystemWatcher` can miss `.switchboard` events depending on workspace watcher exclusions and gitignore behaviour, and already ships a native `fs.watch` fallback with a dedup guard (`_recentNativePlanCreations`, 10 s TTL) for exactly this directory. That is a stronger, closer precedent than the out-of-workspace note at `DesignPanelProvider.ts:1006-1011` (and `:291`): plan the memo watcher as seam watcher **plus** native fallback with a dedup guard, mirroring the plan-watcher pattern already in this provider.
* Panel not open → no-op.

### 2. `src/webview/memo.js` — handle the push

**Implementation:** add a handler for the broadcast that re-renders from the pushed payload, guarded so it does not replace content while the user has unsaved local edits.

**Edge cases:** if a local edit is pending, skip the refresh silently. Do not show a "content changed on disk" banner — it is a sub-second, self-resolving condition and the project rule is no UI messaging for edge cases the user cannot act on. The next save-or-reload reconciles.

---

## Verification Plan

### Automated Tests
Tests are skipped per session directive, and compilation is skipped per session directive. Target coverage for the coding pass:
* Echo-guard unit test: a write whose content matches the last-served content produces **no** broadcast; a write with different content produces exactly one.
* Debounce test: three change events inside the window produce one read and one broadcast.

### Manual Verification
1. **External write reflects:** open the Memo panel, append a line to `.switchboard/memo.md` from an editor or a shell, and watch the panel update without a reload.
2. **No echo:** type in the Memo panel and save. The panel must not flicker, re-render from disk, or lose the caret.
3. **Unsaved-edit guard:** with unsaved text in the panel, write to the file externally. The panel must not discard the unsaved text.
4. **Cleared file:** run `memoClear`, then write the file externally. Panel handles both transitions without error.
5. **Both hosts:** works in the extension and under `npx switchboard` — the arm must run with no `vscode` reachable, which is the seam acceptance signal (PRD contract #3).
6. **No leak:** reload the window repeatedly; watcher handles are disposed, not accumulated.
7. **Real end-to-end:** run the sibling plan's `memo-process` launcher through an external agent with folder access and confirm the panel reflects the rewritten memo unprompted.
8. **Plan import:** confirm the importer registers this plan on the board.

---

## Recommendation

Complexity 2 → **Send to Intern.**

---

## Review Findings

**Not implemented.** No code was written for this plan: `src/services/TaskViewerProvider.ts` and `src/webview/memo.js` are both absent from the commit, and a grep for `watchFile` in `TaskViewerProvider.ts` returns nothing. Missing in full: the `hostSeams.watchFile` registration on `<workspaceRoot>/.switchboard/memo.md`, the 150–300 ms debounce, the content-comparison echo guard, the native `fs.watch` fallback with dedup guard the plan identified at `TaskViewerProvider.ts:13077-13099`, watcher disposal, and the `memo.js` push handler with its unsaved-edit guard. Nothing was fixed — this is a whole feature, not a defect, and writing it under a review pass would ship unreviewed service-layer watcher code into the provider three other subtasks also want to touch. Validation: `tsc --noEmit` and `npm run lint` pass; the plan's echo-guard and debounce tests do not exist. Note that `npm run test:contract:memo-browser-clear` is red, but pre-existing — it exercises memo verbs in files this feature never touched.

### Second review pass (post-coder)

**Correction to the finding above: a memo watcher already existed.** `_setupMemoWatcher` has been at `TaskViewerProvider.ts:13140` all along, registered at `:848` / `:6002` and disposed at `:21474`, with debounce (`_memoFsDebounce`) and a native-fallback shape already in place; `memo.js`'s unsaved-edit guard (`isFocused || _memoDirty`) also predates this work. The first-pass verdict "not implemented at all" was wrong — the real gap was narrower. **Now closed:** the coder added the content-comparison echo guard (`_lastServedMemoContent`, set on `memoLoad`/`memoSave`, compared before broadcast) and a `memoUpdated` case in `memo.js`. This plan is substantially complete. Two NITs left: `_handleMemoFileChange` posts **both** `memoContent` and `memoUpdated` with identical payloads and `memo.js` handles them by fallthrough, so every external change renders twice — drop one; and the plan's echo-guard and debounce unit tests still do not exist.
