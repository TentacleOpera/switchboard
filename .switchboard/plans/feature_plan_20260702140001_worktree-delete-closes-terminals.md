# Worktree Delete/Merge/Abandon Must Close Its Spawned Terminals

## Goal

When a worktree is removed from the kanban.html WORKTREES tab (via **Merge** or **Abandon**), every VS Code terminal that was created for that worktree must be disposed and dropped from terminal state. Today the on-disk git worktree and its DB row are cleaned up, but the terminals opened for it (via **Open terminals** or the auto "open with grid" path) are left orphaned — still visible in the Terminal panel, still routed to a worktree path that no longer exists.

### Problem analysis / root cause

Terminals are created per-worktree by `TaskViewerProvider.ensureWorktreeTerminals(worktreePath, roles)` (`src/services/TaskViewerProvider.ts:7422`). Each terminal is recorded in persisted terminal state (`state.terminals[name]`) with a `worktreePath` field, and a live `vscode.Terminal` object is held in `_registeredTerminals`.

The deletion paths never touch terminals:

- `mergeWorktree` handler (`src/services/KanbanProvider.ts:8039-8093`) runs `git merge`, `git worktree remove --force`, `db.updateWorktreeStatus('merged')`, then `_sendWorktreeConfig`. No terminal cleanup.
- `abandonWorktree` handler (`src/services/KanbanProvider.ts:8095-8113`) runs `git worktree remove --force`, `db.updateWorktreeStatus('abandoned')`, then `_sendWorktreeConfig`. No terminal cleanup.
- `_removeWorktreeRow` (`src/services/KanbanProvider.ts:8743-8757`) — the shared helper used by epic merge/abandon convergence flows (`_cleanupEpicWorktrees`, `_mergeSubtaskIntoIntegration`, `_mergeEpicIntegrationIntoMain`) — only does `git worktree remove --force` + `db.updateWorktreeStatus`. No terminal cleanup.

So every terminal spawned for a worktree outlives the worktree. The terminal still references a deleted directory, dispatch routing (`_findTerminalNameByWorktreePathAndRole`) keeps matching the stale path until the state record is manually removed, and the user is left closing terminals one-by-one.

`TaskViewerProvider` already has the primitives to fix this:
- `findTerminalNameByWorktreePath(worktreePath)` (`TaskViewerProvider.ts:7377`) — finds **one** terminal name by path (any role).
- `_findTerminalNameByWorktreePathAndRole(path, role, strictRole)` (`TaskViewerProvider.ts:6352`) — finds one by path + role.
- `killTerminal(name)` (`TaskViewerProvider.ts:7345`) — disposes the VS Code terminal, removes autoban pool references, deletes the state record, refreshes statuses.
- `_closeTerminal(name)` (`TaskViewerProvider.ts:15512`) — disposes the terminal + deletes the state record.

What is missing is a "close **all** terminals for a worktree path" method and a call site in each deletion path.

## Metadata

**Complexity:** 4
**Tags:** backend, worktrees, terminals, bug

## Current State

- Worktree rows persist in the `worktrees` SQLite table (`status='active'`); deletion sets `status` to `'merged'`/`'abandoned'` and `git worktree remove --force` deletes the directory.
- Terminal state records carry `worktreePath`; `killTerminal`/`_closeTerminal` already dispose the VS Code Terminal object and delete the state entry.
- No existing method enumerates *all* terminals for a given worktree path (only the first match).

## Complexity Audit

**Routine.** The work is additive: one new enumerating method on `TaskViewerProvider` that reuses the existing dispose/state-delete primitives, plus a call in each of the three deletion entry points in `KanbanProvider`. No schema change, no webview change, no new message type. The only mild care is iterating state inside `updateState` (the established transactional pattern) and keeping cleanup best-effort so one stuck terminal doesn't abort a multi-worktree epic convergence.

## Edge-Case & Dependency Audit

- **Epic convergence deletes multiple worktrees** — `_cleanupEpicWorktrees` (`KanbanProvider.ts:8776`) walks N child worktrees via `_removeWorktreeRow`. Terminal cleanup must run per-worktree and be best-effort (log + continue), matching `_removeWorktreeRow`'s existing log-and-continue contract, so one failure doesn't abort the walk.
- **Worktree directory already gone** (partial earlier failure) — terminal cleanup must still run; terminals are tracked by path in state, not by directory existence. `git worktree remove` may throw but terminals still need closing.
- **Terminals shared across roles on the same path** — a worktree can have Planner + Coder + Reviewer terminals. The new method must close *all* roles for the path, not just the first.
- **`killTerminal` vs `_closeTerminal`** — prefer `killTerminal` (also clears autoban pool references + posts refreshed autoban state) so the deleted terminals don't linger in the pool/terminal-status UI. Fall back to `_closeTerminal` if `killTerminal`'s pool logic is undesirable in bulk context; but `killTerminal` is the right call since these are autoban-pool terminals.
- **Terminal currently running a command** — `vscode.Terminal.dispose()` will kill it; this matches the user's intent (the worktree is being deleted) and the existing "no confirmation dialogs" project rule (`CLAUDE.md`). Do not add a confirm gate.
- **`this._taskViewerProvider` may be unset** in `KanbanProvider` — guard the call (same guard already used by `openWorktreeTerminals` at `KanbanProvider.ts:8029`).
- **Path normalization** — match on `path.resolve()` exactly as `findTerminalNameByWorktreePath` and `_findTerminalNameByWorktreePathAndRole` already do, to avoid missing terminals stored with a non-normalized path.

## Proposed Changes

### 1. `TaskViewerProvider` — new `closeWorktreeTerminals(worktreePath)`

`src/services/TaskViewerProvider.ts`, add a public method next to `findTerminalNameByWorktreePath` (~line 7394):

```ts
/**
 * Close (dispose + drop from state + remove from autoban pool) EVERY terminal
 * whose stored worktreePath matches the given path, regardless of role. Used when
 * a worktree is deleted/merged/abandoned so its spawned terminals don't outlive it.
 * Best-effort: each terminal is closed independently so one failure doesn't abort the rest.
 */
public async closeWorktreeTerminals(worktreePath: string): Promise<void> {
    const resolvedTarget = path.resolve(worktreePath);
    // Collect names inside an updateState transaction so we read a consistent snapshot.
    const names: string[] = [];
    await this.updateState(async (state) => {
        if (state.terminals) {
            for (const [name, info] of Object.entries(state.terminals) as [string, any][]) {
                if (info.worktreePath && path.resolve(info.worktreePath) === resolvedTarget) {
                    names.push(name);
                }
            }
        }
    }).then(() => { /* updateState resolves after persistence */ });

    for (const name of names) {
        try {
            await this.killTerminal(name); // disposes VS Code terminal, drops state + pool refs, refreshes UI
        } catch (e) {
            console.warn(`[TaskViewerProvider] closeWorktreeTerminals: failed to close ${name} (continuing):`, e);
        }
    }
}
```

Notes:
- Reads names in one `updateState` snapshot, then closes outside the transaction (killTerminal opens its own transaction) to avoid nested `updateState` calls.
- Reuses `killTerminal` so the autoban pool + terminal-status UI stays consistent.

### 2. `KanbanProvider` — call terminal cleanup on every deletion path

Resolve the worktree row's `path` and call `this._taskViewerProvider?.closeWorktreeTerminals(wtPath)` **before** `git worktree remove` (so the terminal's cwd still resolves cleanly for dispose), best-effort.

**(a) `mergeWorktree` plain/project path** (`KanbanProvider.ts:8083-8091`) — add before the `git merge`/`worktree remove` block:

```ts
if (this._taskViewerProvider && wtPath) {
    try { await this._taskViewerProvider.closeWorktreeTerminals(wtPath); }
    catch (e) { console.warn('[KanbanProvider] mergeWorktree: terminal cleanup failed (continuing):', e); }
}
```

(The subtask/tier/integration branches at `8055-8079` route through `_removeWorktreeRow`-based helpers, covered in (c).)

**(b) `abandonWorktree`** (`KanbanProvider.ts:8101-8111`) — add at the top of the `try`, before `git worktree remove`:

```ts
if (this._taskViewerProvider && wtPath) {
    try { await this._taskViewerProvider.closeWorktreeTerminals(wtPath); }
    catch (e) { console.warn('[KanbanProvider] abandonWorktree: terminal cleanup failed (continuing):', e); }
}
```

**(c) `_removeWorktreeRow`** (`KanbanProvider.ts:8743-8757`) — the shared helper used by all epic convergence flows. Add terminal cleanup as the **first** best-effort step (before the `git worktree remove` try), so it covers subtask/tier/integration worktrees too:

```ts
private async _removeWorktreeRow(workspaceRoot: string, db: KanbanDatabase, wt: WorktreeRow, finalStatus: 'merged' | 'abandoned'): Promise<void> {
    const execFileAsync = promisify(cp.execFile);
    // Close terminals spawned for this worktree before the directory disappears.
    if (this._taskViewerProvider && wt.path) {
        try { await this._taskViewerProvider.closeWorktreeTerminals(wt.path); }
        catch (e) { console.warn(`[KanbanProvider] _removeWorktreeRow: terminal cleanup failed for ${wt.branch} (continuing):`, e); }
    }
    try {
        if (wt.path && fs.existsSync(wt.path)) {
            await execFileAsync('git', ['worktree', 'remove', '--force', wt.path], { cwd: workspaceRoot });
        }
    } catch (e) {
        console.warn(`[KanbanProvider] _removeWorktreeRow: failed to remove worktree dir for ${wt.branch} (continuing):`, e);
    }
    try {
        await db.updateWorktreeStatus(wt.id, finalStatus);
    } catch (e) {
        console.warn(`[KanbanProvider] _removeWorktreeRow: failed to update worktree status for ${wt.branch} (continuing):`, e);
    }
}
```

Because (c) covers the convergence flows, the explicit calls in (a)/(b) only need to cover the two non-convergence entry points (plain/project merge into main, and abandon). `wtPath`/`wt.path` is already available in each handler.

### 3. Tests

Add a unit test exercising `closeWorktreeTerminals` against a fake terminal-state record set:
- Seed `state.terminals` with two entries sharing `worktreePath` (different roles) + one entry on a different path.
- Call `closeWorktreeTerminals(sharedPath)`.
- Assert the two matching entries are disposed + removed from state, the unrelated entry is untouched, and `killTerminal`'s pool/state cleanup ran for each.

## Non-Goals

- No webview/kanban.html change (deletion UX is unchanged; terminals just disappear on their own).
- No new message type between webview and extension.
- No confirm dialog before killing terminals (per `CLAUDE.md` "NEVER add confirmation dialogs").
- No change to terminal creation (`ensureWorktreeTerminals`).

## Verification Plan

1. Unit test from §3.
2. Manual: create a worktree from the WORKTREES tab → click **Open terminals** (confirm 1+ terminals appear in the VS Code Terminal panel) → click **Abandon** → confirm the worktree disappears from the list AND its terminals are gone from the Terminal panel.
3. Manual: same as above but with **Merge** instead of Abandon → confirm terminals closed.
4. Manual: epic with per-subtask worktrees (auto mode) → open terminals for a subtask worktree → merge the epic integration worktree (triggers `_cleanupEpicWorktrees`) → confirm all child worktree terminals are closed, not just the integration one.
5. Confirm no confirmation dialog appears at any step.

## User Review Required

None.
