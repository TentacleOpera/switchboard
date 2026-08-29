# The memo modal never updates in standalone, because only one host watches the file

## Goal

Make the memo modal reflect memo file changes live under `npx switchboard`, as it already does under the VS Code extension. An agent appending an entry to `.switchboard/memo.md` — which is the whole point of memo capture mode — currently produces no visible change in a standalone operator's open modal until something else re-triggers a load.

### The problem

The operator opens the memo modal in the standalone browser board and watches it while entries are captured. Nothing appears. The file on disk is correct; the panel is showing a snapshot taken when it opened.

This is a composition-root divergence of exactly the shape `CLAUDE.md` names — *"the trap is composition-root wiring: service seams, options objects handed to shared services, and `Promise<void>` callbacks where 'never wired' and 'working' are the same value."* A verb-reachability audit finds nothing wrong here: `memoLoad` is answered correctly by both hosts, so every request-response path is green. What is missing is the **push**.

### Root cause

> **Superseded:** *"The extension watches the memo file. Standalone does not."* / *"src/standalone/bootstrap.ts knows the same path … It never watches it, and it never pushes. Its only memo messages are `{ success: true, type: 'memoContent', content }` returned as verb responses."*
> **Reason:** This conclusion was reached by reading `bootstrap.ts`'s memo *verb* arms (`:2560`) and mistaking the request/response plumbing for the watch surface. In fact standalone **constructs `TaskViewerProvider`** (`bootstrap.ts:1103`) — the same class that owns the watch → debounce → `memoUpdated` push chain the extension uses (`_memoWatchers` at `TaskViewerProvider.ts:1418`, `_setupMemoWatcher` at `:15473`, `_pushMemoContent` at `:15525`). The watcher machinery exists and is meant to run in standalone; it is born dead on an **ordering bug**, not absent.
> **Replaced with:** The ordering bug below.

**The watcher is set up before its host seam is injected, bails on a null root, and is never re-run.**

`bootstrap.ts` calls `taskViewerProvider.activateHostIntegrations()` at `:1113`, and `taskViewerProvider.initHeadlessVerbServing(headlessSeams, headlessBroadcaster)` on the **very next line** at `:1114`. `activateHostIntegrations` runs `_setupMemoWatcher()` (`TaskViewerProvider.ts:1819`), which at `:15481` calls `this._resolveWorkspaceRoot()` → `_getWorkspaceRoots()` (`:4463`):

```ts
private _getWorkspaceRoots(): string[] {
    const seamRoots = this._hostSeams?.workspace?.getWorkspaceRoots();
    if (seamRoots && seamRoots.length > 0) { return seamRoots; }
    return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
}
```

At that instant `this._hostSeams` is still `undefined` (injected by `initHeadlessVerbServing`, one line later). So `_getWorkspaceRoots` falls to `vscode.workspace.workspaceFolders`, which the standalone shim hardcodes to `[]`:

```ts
// vscodeShim.ts:245
export const workspaceFolders: readonly WorkspaceFolder[] = [];
```

`_resolveWorkspaceRoot` returns `null` (kanban is not wired yet either — `setKanbanProvider` lands at `:1173`), and `_setupMemoWatcher` bails:

```ts
// TaskViewerProvider.ts:15481-15482
const workspaceRoot = this._resolveWorkspaceRoot();
if (!workspaceRoot) { return; }
```

The only other call site that re-runs `_setupMemoWatcher` is `reinitializePlanWatcher` (`:8386`), invoked **solely** from `KanbanProvider`'s `selectWorkspace` verb handler (`KanbanProvider.ts:9666`) — a webview-originated user action that standalone never auto-sends on boot. So the watcher is never revived.

**Why the extension is unaffected:** the editor host's `vscode.workspace.workspaceFolders` is populated, so `_getWorkspaceRoots` returns real folders even before `_hostSeams` is derived. Only the standalone shim's empty folder list trips the bail.

**The rest of the chain is intact and would work if the watcher were armed:**
- The headless seam watcher is real: `createVscodeHostSeams` (`bootstrap.ts:1066`) builds a `VscodeHostFileWatcher` whose `watchFile` uses `vscode.workspace.createFileSystemWatcher`, and the shim's implementation is backed by real `fs.watch` (`vscodeShim.ts:273`; confirmed at `bootstrap.ts:1067-1069`).
- `_pushMemoContent` sends `this.postMessage({ type: 'memoUpdated', content })` (`TaskViewerProvider.ts:15536`), which routes through `_broadcaster.push` → `mirrorToWs` → `apiServer.broadcastWs('memoUpdated', msg, /*surface*/ undefined)` (`broadcastHub.ts:102-128`). The `apiServer` is wired later via `taskViewerProvider.setApiServer(server)` (`bootstrap.ts:3354`) — fine, because pushes only fire on post-boot file events.
- `broadcastWs` with `surface === undefined` is delivered to **every** connection (`wsHub.ts:409` — a push is skipped only when surface is truthy AND the connection declared a set AND the tag is absent). The memo panel subscribes to `[memo, common]` (`wsHub.ts:76`) and handles `memoUpdated` (`memo.js:126`). So an armed watcher reaches the browser modal with no further wiring.

**The client is not the problem.** `memo.js` already handles both `memoContent` and `memoUpdated` (`:127`, `:126`), including a dirty-guard so a push cannot clobber unsaved local edits. Nothing needs teaching; it is simply never sent anything.

**The rail already exists.** `bootstrap.ts` uses `server.broadcastWs(...)` for other live updates, and the `TaskViewerProvider` push path uses the same hub. The transport for a standalone push is present and in use — only the watcher is dead.

> **Note (scope observation, not a change):** `bootstrap.ts` carries its own memo *verb* arms (`memoLoad`/`memoSave`/`memoClear`/`memoGeneratePrompt` at `:2560-2631`) that intercept before delegating to `TaskViewerProvider.handleServiceVerb`, while `TaskViewerProvider` *also* has memo verb arms (`:14863+`) used by the extension. The verb split is a separate stale-code concern; this plan does not touch it. The confusion in the original diagnosis stemmed from reading the bootstrap verb arms as the watch surface. The watch/push surface lives in `TaskViewerProvider` and is the single correct place to fix this.

### Why this matters more than a stale panel

Memo capture mode is defined by an agent appending to this file while the operator watches. `switchboard-memo` exists so entries can be captured without analysis and reviewed later. On the host where the operator is most likely to be watching a browser panel rather than an editor, the one surface that shows those entries does not update — so the mode's core feedback loop is missing exactly where it is needed.

## Metadata

- **Complexity:** 2
- **Tags:** bugfix, backend, reliability, ux

## User Review Required

None. Three decisions are made here:

1. **Fix standalone to match the extension, do not change the extension's behavior.** The extension's watch → debounce → push chain is correct and shipped. Standalone gains the same behaviour by *activating the existing `TaskViewerProvider` watcher* (the same class the extension uses), not by adding a parallel watcher. The fix adds one public method to the shared `TaskViewerProvider` class and one call site in `bootstrap.ts`; it does not alter any extension-host code path (the new method is invoked only from `bootstrap.ts`).
2. **Push `memoUpdated`, not `memoContent`.** The client treats them alike, but the two names carry different meanings — `memoContent` is a verb *response*, `memoUpdated` is an unsolicited *event*. Reusing the response type for a push would blur that and break the distinction the dirty-guard reasoning depends on. The existing `_pushMemoContent` already sends `memoUpdated` (`TaskViewerProvider.ts:15536`); activating the watcher preserves this automatically.
3. **Keep the 150 ms debounce.** An agent appending entries can write several times in quick succession; the extension already settled on this value and the two hosts must not drift on it. The existing `_setupMemoWatcher` debounce is 150 ms (`:15512-15515`); reusing it makes parity automatic.

## Complexity Audit

### Routine

- Adding a public `reinitializeMemoWatcher()` method to `TaskViewerProvider` that wraps the existing private `_setupMemoWatcher()`.
- Calling it once from `bootstrap.ts` after `initHeadlessVerbServing` so `_hostSeams` is set when it runs.

### Complex / Risky

- **None.** The fix reuses the existing, extension-proven watch → debounce → push chain. It does not introduce a new watcher, a new debounce, a new broadcast path, or a new root-resolution strategy. The only behavioural change is that the existing watcher stops bailing.

## Edge-Case & Dependency Audit

- **The file does not exist yet.** `_setupMemoWatcher` watches `_getMemoPath(folder)` via `VscodeHostFileWatcher.watchFile` → `RelativePattern(dirname, basename)` (`hostSeams.ts:571-579`), i.e. it watches the `.switchboard/` **directory** for `memo.md`, not a single inode. The shim's `createFileSystemWatcher` seeds a `seen` set from `readdirSync` and emits `onDidCreate` when `memo.md` appears (`vscodeShim.ts:318-340`). A missing file is handled — creation fires the watcher. `.switchboard/` itself is created at `bootstrap.ts:168-170`, before any provider is constructed, so the directory is always present when the watcher is armed.
- **Atomic writes (tmp-then-rename).** An agent that writes via tmp-and-rename replaces the inode. A path-bound `fs.watch` would go deaf — but this watcher is **directory-scoped** (`RelativePattern(<root>/.switchboard, 'memo.md')`), so renaming a tmp file to `memo.md` fires `onDidCreate` (the `rename` event with the file absent-from-`seen`, `vscodeShim.ts:334-336`). The atomic-replace case is handled by the existing watcher shape; no directory-watching or re-establishment needs to be added.
- **Double-fire.** `fs.watch` can emit twice for one write (notably macOS FSEvents). The 150 ms debounce in `onMemoFsEvent` (`TaskViewerProvider.ts:15510-15516`) coalesces these, and `_pushMemoContent`'s `_lastServedMemoContent` guard (`:15532-15534`) suppresses a redundant push when content is unchanged. Both are already in the reused path.
- **Unsaved local edits.** `memo.js` carries a dirty-guard so an inbound push does not discard what the operator is typing (`memo.js:130-133`). That guard is client-side and already covers this path; do not add a second one server-side.
- **No memo panel open.** The broadcast is fire-and-forget on the memo surface; with no subscriber it is a no-op (`wsHub.ts:409`).
- **Workspace switch.** `reinitializePlanWatcher` (`TaskViewerProvider.ts:8380`) is called by `KanbanProvider` on `selectWorkspace` (`KanbanProvider.ts:9666`) and re-runs `_setupMemoWatcher` (`:8386`), re-arming the watcher for the new root. Once the initial watcher is established by this fix, workspace switches are handled by the existing machinery — no extra work.
- **Disposal.** `_setupMemoWatcher` disposes prior `_memoWatchers` before re-creating (`:15474`), so re-invocation is idempotent (no leak). `TaskViewerProvider.dispose()` tears down `_memoWatchers` (`:24154`), and `bootstrap.ts` calls `taskViewerProvider.dispose?.()` on shutdown (`:3490`). No new disposal code is needed.
- **Plan watching must not be disturbed.** Standalone watches plan files through its own `PlanIngestionEngine` (`bootstrap.ts:559`, initialized at `:872`), not through `TaskViewerProvider._setupPlanWatcher` (which bails for the same ordering reason). This fix deliberately arms **only** the memo watcher — it does **not** reorder `activateHostIntegrations`/`initHeadlessVerbServing` (which would arm `_setupPlanWatcher`/`_setupStateWatcher` too and double-watch plans against the ingestion engine).
- **Both hosts must stay in step.** This fix closes the divergence by reusing the *same* code path the extension uses, so the debounce value and the message type are identical by construction — there is no second implementation to drift.

## Dependencies

- **Related:** `Memo modal geometry in the shell modal host` (PLAN REVIEWED). That feature concerns the modal's layout in the shell host, not its data. No conflict, but both touch the memo panel — review the combined diff.
- **Independent of** the memo processing path (`process memo` → plan files), which is unchanged.
- **Independent of** the `PlanIngestionEngine` plan-watching path; this fix does not touch plan watchers.

## Adversarial Synthesis

Key risks: (1) mis-diagnosing the bail as "no watcher exists" and adding a parallel `bootstrap.ts` watcher — would pass manual tests while leaving the ordering bug latent and risking double-broadcast once `reinitializePlanWatcher` arms the real watcher on a workspace switch; mitigated by reusing the existing `TaskViewerProvider` watcher via a public re-init method. (2) Over-fixing by reordering `activateHostIntegrations`/`initHeadlessVerbServing` — would arm `_setupPlanWatcher`/`_setupStateWatcher` and double-watch plans against `PlanIngestionEngine`; mitigated by arming memo only. (3) The fix silently no-ops if `.switchboard/` is absent at arm time — mitigated by the directory being created at `bootstrap.ts:168-170`, before providers are constructed. Mitigations are verified by the "watcher registered after boot" and "no parallel watcher" goal invariants below.

## Proposed Changes

### `src/services/TaskViewerProvider.ts`

> **Superseded:** *(no change to this file — the original plan proposed no TaskViewerProvider edit.)*
> **Reason:** The original plan located the entire fix in `bootstrap.ts`, treating `TaskViewerProvider`'s watcher as extension-only. That premise was wrong; the watcher is constructed in standalone too and only fails to arm.
> **Replaced with:** Expose the existing watcher setup so standalone can re-arm it after the seam is wired.

- Add a public method beside `reinitializePlanWatcher` (`:8380`) that wraps the existing private setup:
  ```ts
  /**
   * Re-arm the memo file watcher for the resolved workspace root. Standalone
   * (`bootstrap.ts`) calls this after `initHeadlessVerbServing` injects
   * `_hostSeams`, because `activateHostIntegrations` runs `_setupMemoWatcher`
   * BEFORE the seam is set and the watcher bails on a null root
   * (`_getWorkspaceRoots` falls to the shim's empty `workspaceFolders`).
   * Idempotent: `_setupMemoWatcher` disposes prior watchers first.
   */
  public reinitializeMemoWatcher(): void {
      this._setupMemoWatcher();
  }
  ```
- **Context:** No logic is added — `_setupMemoWatcher` (`:15473`) already resolves the root, builds `foldersToWatch` (falling back to `[workspaceRoot]`), debounces 150 ms, and pushes `memoUpdated`. The method merely makes it callable after seams are wired.
- **Edge cases:** Idempotent re-arm (disposes old watchers, `:15474`); directory-scoped watch handles missing-file and atomic-replace; disposal covered by existing `dispose()` (`:24154`).

### `src/standalone/bootstrap.ts`

> **Superseded:** *"Register a watch on the memo file (or its directory) for the active workspace root, near the existing memo verb arms … On change, debounce 150 ms, read the file (ENOENT → empty string), and `server.broadcastWs('memoUpdated', { content }, <memo surface>)`. Re-establish the watch when the active workspace root changes, and dispose it on shutdown."*
> **Reason:** This duplicates the exact chain `TaskViewerProvider` already owns and ships in the extension. A parallel watcher has no `_lastServedMemoContent` dedupe, so once `reinitializePlanWatcher` arms the real watcher on a workspace switch, both would broadcast — double push to every client. It also leaves the real ordering bug latent, and re-implements disposal/workspace-switch handling that already exists.
> **Replaced with:** One call to the existing watcher setup, after the seam is wired.

- After `taskViewerProvider.initHeadlessVerbServing(headlessSeams, headlessBroadcaster);` (`:1114`), re-arm the memo watcher now that `_hostSeams` is set and `.switchboard/` exists (`:168-170`):
  ```ts
  taskViewerProvider.initHeadlessVerbServing(headlessSeams, headlessBroadcaster);
  // activateHostIntegrations (:1113) ran _setupMemoWatcher BEFORE _hostSeams
  // was injected, so it bailed on a null root (shim workspaceFolders is []).
  // Re-arm now that the seam is wired; idempotent — _setupMemoWatcher disposes
  // the (empty) prior watcher set first. The broadcaster's apiServer is wired
  // later (setApiServer, :3354) but pushes only fire on post-boot file events.
  taskViewerProvider.reinitializeMemoWatcher();
  ```
- **Context:** `_hostSeams` is now set, so `_getWorkspaceRoots()` returns `[workspaceRoot]` via `VscodeHostWorkspace`'s fallback (`hostSeams.ts:524-528`), `_resolveWorkspaceRoot()` resolves to `workspaceRoot`, and `_setupMemoWatcher` arms the directory-scoped watch on `<workspaceRoot>/.switchboard/memo.md`. The push reaches the browser via the existing `broadcastWs` rail (`surface === undefined` → all connections, `wsHub.ts:409`).
- **Logic:** No new debounce, no new broadcast, no new root-resolution, no new disposal. The 150 ms debounce, `memoUpdated` type, and `ENOENT → empty` read all remain in `_pushMemoContent`/`_setupMemoWatcher`.
- **Edge cases:** Workspace switches are handled by the existing `reinitializePlanWatcher`→`_setupMemoWatcher` path (`KanbanProvider.ts:9666`); shutdown disposal by `taskViewerProvider.dispose?.()` (`:3490`). Plan watching is untouched (owned by `PlanIngestionEngine`).

## Files Changed

- `src/services/TaskViewerProvider.ts` — add public `reinitializeMemoWatcher()` (wraps existing private `_setupMemoWatcher()`).
- `src/standalone/bootstrap.ts` — call `taskViewerProvider.reinitializeMemoWatcher()` after `initHeadlessVerbServing` (`:1114`).
- Tests — watcher registered after boot (no bail), push on append, push on create, push after atomic replace, unsaved-edit guard survives, disposal, and host parity of type and debounce.

## Verification Plan

> **Session directive:** compilation and automated tests are skipped for this review run. The checks below remain the canonical verification; they are simply not executed now.

1. **Watcher is armed after boot (the core regression guard).** Start `npx switchboard`; after init, assert `taskViewerProvider._memoWatchers.length >= 1` (the watcher did not bail). This is the direct assertion that the ordering bug is fixed.
2. **Append updates an open modal.** With the memo modal open under `npx switchboard`, append a line to `.switchboard/memo.md` from a shell; assert the modal shows it without interaction.
3. **Atomic replace still updates.** Write via tmp-then-rename — the way an agent is likely to write — and assert the modal updates. The directory-scoped `RelativePattern` watcher fires `onDidCreate` for the rename target.
4. **Creation from absent.** Delete the file, open the modal (empty), then create it; assert the modal updates.
5. **Unsaved edits survive.** Type into the modal without saving, trigger an external append, and assert the local text is not clobbered — the existing client dirty-guard (`memo.js:130-133`) must still hold.
6. **Disposal.** Start and stop the server repeatedly; assert no watcher accumulation (`_memoWatchers` is cleared by `dispose()`).
7. **Host parity.** Assert both hosts emit `memoUpdated` with a 150 ms debounce, by source-level assertion in both roots — the fix reuses the same `_setupMemoWatcher`/`_pushMemoContent` code, so parity is structural; the assertion guards against a future divergence.

### Goal Invariants

- Assert `TaskViewerProvider` exposes a public method named `reinitializeMemoWatcher` (symbol resolvable at `src/services/TaskViewerProvider.ts`).
- Assert `src/standalone/bootstrap.ts` calls `taskViewerProvider.reinitializeMemoWatcher()` at least once after the `initHeadlessVerbServing` call.
- Assert `taskViewerProvider._memoWatchers.length >= 1` after standalone bootstrap completes (the watcher did not bail on a null root).
- Assert no parallel memo `fs.watch` / `createFileSystemWatcher` call targeting `memo.md` is added in `src/standalone/bootstrap.ts` (the fix reuses the existing seam watcher, not a duplicate) — a negative invariant guarding against regression to the superseded approach.
