# Worktree Delete/Merge/Abandon Must Close Its Spawned Terminals

**Plan ID:** 8b4c2d9e-1a3f-4b56-9c7d-0e2f3a4b5c6d

## Goal

When a worktree is removed from the kanban.html WORKTREES tab (via **Merge** or **Abandon**) or by an internal convergence/rollback flow, every VS Code terminal that was created for that worktree must be disposed and dropped from terminal state. Today the on-disk git worktree and its DB row are cleaned up, but the terminals opened for it (via **Open terminals** or the auto "open with grid" path) are left orphaned — still visible in the Terminal panel, still routed to a worktree path that no longer exists.

### Problem analysis / root cause

Terminals are created per-worktree by `TaskViewerProvider.ensureWorktreeTerminals(worktreePath, roles)` (`src/services/TaskViewerProvider.ts:7422`). Each terminal is recorded in persisted terminal state (`state.terminals[name]`) with a `worktreePath` field, and a live `vscode.Terminal` object is held in `_registeredTerminals`.

The deletion paths never touch terminals:

- `mergeWorktree` handler (`src/services/KanbanProvider.ts:8039-8093`) runs `git merge`, `git worktree remove --force`, `db.updateWorktreeStatus('merged')`, then `_sendWorktreeConfig`. No terminal cleanup.
- `abandonWorktree` handler (`src/services/KanbanProvider.ts:8095-8113`) runs `git worktree remove --force`, `db.updateWorktreeStatus('abandoned')`, then `_sendWorktreeConfig`. No terminal cleanup.
- `_removeWorktreeRow` (`src/services/KanbanProvider.ts:8754-8768`) — the shared helper used by epic merge/abandon convergence flows (`_cleanupEpicWorktrees` at line 8787, `_mergeSubtaskIntoIntegration`, `_mergeEpicIntegrationIntoMain`) — only does `git worktree remove --force` + `db.updateWorktreeStatus`. No terminal cleanup.
- **`_provisionHighLowTierWorktrees` rollback** (`src/services/KanbanProvider.ts:8670-8693`) — when tier-provisioning fails mid-flight, the catch block runs `git worktree remove --force` + `db.updateWorktreeStatus('abandoned')` DIRECTLY (lines 8681-8691), NOT through `_removeWorktreeRow`. Terminals were already created via `ensureWorktreeTerminals` at lines 8663/8668 before the failure, so they would be orphaned. This is a fourth deletion entry point the original plan missed.

So every terminal spawned for a worktree outlives the worktree. The terminal still references a deleted directory, dispatch routing (`_findTerminalNameByWorktreePathAndRole`) keeps matching the stale path until the state record is manually removed, and the user is left closing terminals one-by-one.

`TaskViewerProvider` already has the primitives to fix this:
- `findTerminalNameByWorktreePath(worktreePath)` (`TaskViewerProvider.ts:7377`) — finds **one** terminal name by path (any role).
- `_findTerminalNameByWorktreePathAndRole(path, role, strictRole)` (`TaskViewerProvider.ts:6352`) — finds one by path + role.
- `killTerminal(name)` (`TaskViewerProvider.ts:7345`) — disposes the VS Code terminal, removes autoban pool references, deletes the state record, refreshes statuses. Async; best-effort (early-returns on empty name, does not throw if terminal not found).
- `_closeTerminal(name)` (`TaskViewerProvider.ts:15512`) — disposes the terminal + deletes the state record.

What is missing is a "close **all** terminals for a worktree path" method and a call site in each deletion path.

## Metadata

**Complexity:** 4
**Tags:** backend, bugfix, refactor

## User Review Required

None. No UI/UX change, no state migration; purely closes orphaned terminals that reference deleted directories.

## Current State

- Worktree rows persist in the `worktrees` SQLite table (`status='active'`); deletion sets `status` to `'merged'`/`'abandoned'` and `git worktree remove --force` deletes the directory.
- Terminal state records carry `worktreePath`; `killTerminal`/`_closeTerminal` already dispose the VS Code Terminal object and delete the state entry.
- No existing method enumerates *all* terminals for a given worktree path (only the first match via `findTerminalNameByWorktreePath`).
- Worktree terminals are stored in `state.terminals` under **suffixed** keys (e.g. `"Coder-Visual Studio Code"`) via `_suffixedName`. `killTerminal` handles suffix stripping internally (`_stripIdeSuffix` at lines 7354, 7365), so passing the suffixed state key to `killTerminal` works correctly.

## Complexity Audit

### Routine
- One new enumerating method on `TaskViewerProvider` that reuses the existing `killTerminal` primitive.
- A best-effort call in each of the four deletion entry points in `KanbanProvider`.
- No schema change, no webview change, no new message type.

### Complex / Risky
- Iterating state inside `updateState` (the established transactional pattern) then closing outside the transaction (because `killTerminal` opens its own `updateState` at line 7362 — nesting would deadlock/re-queue). The plan's read-then-close-outside pattern avoids this.
- Epic convergence (`_cleanupEpicWorktrees`) walks N child worktrees via `_removeWorktreeRow`; terminal cleanup must run per-worktree and be best-effort (log + continue), matching `_removeWorktreeRow`'s existing log-and-continue contract, so one failure doesn't abort the walk.

## Edge-Case & Dependency Audit

- **Race Conditions:** `closeWorktreeTerminals` reads terminal names in one `updateState` snapshot, then closes outside the transaction. A terminal created concurrently (e.g. user clicks "Open terminals" while a merge is in flight) would not be in the snapshot and would survive — acceptable edge case; the user initiated both actions.
- **Security:** No untrusted input; `worktreePath` comes from the DB row / message handler. `path.resolve` normalizes it.
- **Side Effects:** Disposing a terminal that is mid-command kills the command. This matches the user's intent (the worktree is being deleted) and the existing "no confirmation dialogs" project rule (`CLAUDE.md`). Do not add a confirm gate.
- **Dependencies & Conflicts:** None. This plan is independent of the other epic subtasks. It does not touch the agents-tab display layer or the grid toggle.
- **Epic convergence deletes multiple worktrees** — `_cleanupEpicWorktrees` (`KanbanProvider.ts:8787`) walks N child worktrees via `_removeWorktreeRow`. Terminal cleanup runs per-worktree inside `_removeWorktreeRow` (hooked below), so it is automatically covered for all convergence flows.
- **Tier-provisioning rollback** — `_provisionHighLowTierWorktrees` (lines 8670-8693) creates terminals at 8663/8668 then on failure removes worktrees directly (not via `_removeWorktreeRow`). Terminal cleanup must be added to the rollback loop at 8681-8691.
- **Worktree directory already gone** (partial earlier failure) — terminal cleanup must still run; terminals are tracked by path in state, not by directory existence. `git worktree remove` may throw but terminals still need closing.
- **Terminals shared across roles on the same path** — a worktree can have Planner + Coder + Reviewer terminals. The new method closes *all* roles for the path, not just the first.
- **`killTerminal` vs `_closeTerminal`** — prefer `killTerminal` (also clears autoban pool references + posts refreshed autoban state) so the deleted terminals don't linger in the pool/terminal-status UI. Worktree terminals are autoban-pool terminals, so `killTerminal` is the right call.
- **`this._taskViewerProvider` may be unset** in `KanbanProvider` — guard the call (same guard already used by `openWorktreeTerminals` at `KanbanProvider.ts:8029`).
- **Path normalization** — match on `path.resolve()` exactly as `findTerminalNameByWorktreePath` and `_findTerminalNameByWorktreePathAndRole` already do, to avoid missing terminals stored with a non-normalized path.
- **Collected names are suffixed state keys** — `killTerminal` handles suffix stripping internally, so passing the raw state key is correct. No pre-stripping needed.

## Dependencies

None. This plan is self-contained and does not depend on any other plan in the epic.

## Adversarial Synthesis

Key risk: the original plan covered only 3 of 4 deletion entry points, missing the `_provisionHighLowTierWorktrees` rollback (lines 8670-8693) which creates terminals before the try block and removes worktrees directly on failure — orphaning terminals on a failure path that's specifically designed to fire on errors. Mitigation: add the fourth hook inside the rollback loop. Secondary risk: nested `updateState` if `killTerminal` is called inside the enumeration transaction — mitigated by the read-then-close-outside pattern. Line numbers refreshed to verified values (`_removeWorktreeRow` at 8754, `_cleanupEpicWorktrees` at 8787).

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
    });

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
- Reads names in one `updateState` snapshot, then closes outside the transaction (`killTerminal` opens its own `updateState` at line 7362 — nesting would re-queue/deadlock) to avoid nested `updateState` calls.
- Reuses `killTerminal` so the autoban pool + terminal-status UI stays consistent.
- `killTerminal` is async, takes a single string (the suffixed state key), and is best-effort (early-returns on empty, does not throw if terminal not found). The try/catch in the loop is belt-and-suspenders.

### 2. `KanbanProvider` — call terminal cleanup on every deletion path

Resolve the worktree row's `path` and call `this._taskViewerProvider?.closeWorktreeTerminals(wtPath)` **before** `git worktree remove` (so the terminal's cwd still resolves cleanly for dispose), best-effort.

> **Implementer note:** Line numbers verified against current source. If shifted, grep for `mergeWorktree`, `abandonWorktree`, `_removeWorktreeRow`, and `_provisionHighLowTierWorktrees`.

**(a) `mergeWorktree` plain/project path** (`KanbanProvider.ts:8083-8091`) — add before the `git merge`/`worktree remove` block:

```ts
if (this._taskViewerProvider && wtPath) {
    try { await this._taskViewerProvider.closeWorktreeTerminals(wtPath); }
    catch (e) { console.warn('[KanbanProvider] mergeWorktree: terminal cleanup failed (continuing):', e); }
}
```

(The subtask/tier/integration branches at `8055-8079` route through `_mergeSubtaskIntoIntegration` / `_mergeEpicIntegrationIntoMain`, which use `_removeWorktreeRow` — covered in (c).)

**(b) `abandonWorktree`** (`KanbanProvider.ts:8101-8111`) — add at the top of the `try`, before `git worktree remove`:

```ts
if (this._taskViewerProvider && wtPath) {
    try { await this._taskViewerProvider.closeWorktreeTerminals(wtPath); }
    catch (e) { console.warn('[KanbanProvider] abandonWorktree: terminal cleanup failed (continuing):', e); }
}
```

**(c) `_removeWorktreeRow`** (`KanbanProvider.ts:8754-8768`) — the shared helper used by all epic convergence flows (`_cleanupEpicWorktrees`, `_mergeSubtaskIntoIntegration`, `_mergeEpicIntegrationIntoMain`). Add terminal cleanup as the **first** best-effort step (before the `git worktree remove` try), so it covers subtask/tier/integration worktrees too:

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

**(d) `_provisionHighLowTierWorktrees` rollback** (`KanbanProvider.ts:8681-8691`) — the rollback loop removes worktrees directly (not via `_removeWorktreeRow`). Add terminal cleanup inside the loop, before `git worktree remove`:

```ts
for (const created of toRemove) {
    try {
        // Close terminals spawned for this tier worktree before removing the directory.
        if (this._taskViewerProvider && created.path) {
            try { await this._taskViewerProvider.closeWorktreeTerminals(created.path); }
            catch (e) { console.warn(`[KanbanProvider] _provisionHighLowTierWorktrees rollback: terminal cleanup failed for ${created.branch} (continuing):`, e); }
        }
        if (fs.existsSync(created.path)) {
            await execFileAsync('git', ['worktree', 'remove', '--force', created.path], { cwd: workspaceRoot });
        }
        const row = await db.getWorktreeByBranch(created.branch);
        if (row) await db.updateWorktreeStatus(row.id, 'abandoned');
    } catch (rollbackErr) {
        console.warn(`[KanbanProvider] _provisionHighLowTierWorktrees: rollback cleanup failed for ${created.branch} (continuing):`, rollbackErr);
    }
}
```

Because (c) covers the convergence flows, the explicit calls in (a)/(b) only need to cover the two non-convergence entry points (plain/project merge into main, and abandon). (d) covers the tier-provisioning failure rollback. `wtPath`/`wt.path`/`created.path` is already available in each handler.

### 3. Tests

> **Session directive:** SKIP automated tests in this session. The test below is for the implementer/user to run separately.

Add a unit test exercising `closeWorktreeTerminals` against a fake terminal-state record set:
- Seed `state.terminals` with two entries sharing `worktreePath` (different roles) + one entry on a different path.
- Call `closeWorktreeTerminals(sharedPath)`.
- Assert the two matching entries are disposed + removed from state, the unrelated entry is untouched, and `killTerminal`'s pool/state cleanup ran for each.
- Add a test for the rollback path (d): simulate tier-provisioning failure, assert terminals created at 8663/8668 are closed.

## Non-Goals

- No webview/kanban.html change (deletion UX is unchanged; terminals just disappear on their own).
- No new message type between webview and extension.
- No confirm dialog before killing terminals (per `CLAUDE.md` "NEVER add confirmation dialogs").
- No change to terminal creation (`ensureWorktreeTerminals`).

## Verification Plan

> **Session directives:** SKIP compilation (no `npm run compile` / `tsc`) and SKIP automated tests in this session — the project is pre-compiled and tests run separately. The steps below are for the implementer/user to run after the session.

### Automated Tests
- (Run separately by user) Unit test from §3.
- (Run separately by user) Existing worktree merge/abandon tests in `src/test/` — confirm no regressions in the deletion flows.

### Manual Verification
1. Manual: create a worktree from the WORKTREES tab → click **Open terminals** (confirm 1+ terminals appear in the VS Code Terminal panel) → click **Abandon** → confirm the worktree disappears from the list AND its terminals are gone from the Terminal panel. Confirms hook (b).
2. Manual: same as above but with **Merge** instead of Abandon → confirm terminals closed. Confirms hook (a).
3. Manual: epic with per-subtask worktrees (auto mode) → open terminals for a subtask worktree → merge the epic integration worktree (triggers `_cleanupEpicWorktrees` → `_removeWorktreeRow`) → confirm all child worktree terminals are closed, not just the integration one. Confirms hook (c).
4. Manual: trigger a tier-provisioning failure (e.g. make the high/low worktree branch names collide so creation throws) → confirm the terminals opened before the failure are closed by the rollback. Confirms hook (d).
5. Confirm no confirmation dialog appears at any step.

## Review Findings

Implementation verified against plan: `closeWorktreeTerminals` method at `TaskViewerProvider.ts:7402-7423` (read-then-close-outside pattern, avoids nested `updateState`), and all 4 hook sites present and correctly placed before `git worktree remove`: mergeWorktree (`KanbanProvider.ts:8121`), abandonWorktree (`:8144`), `_removeWorktreeRow` (`:8802`), and `_provisionHighLowTierWorktrees` rollback (`:8730`). `killTerminal` handles suffixed state keys via `_stripIdeSuffix` matching. No code changes needed. No CRITICAL/MAJOR findings. NIT: `killTerminal` triggers `_refreshTerminalStatuses()` per close (N sequential refreshes for N terminals) — existing behavior, not a regression. Remaining risk: low — a terminal created concurrently during merge/abandon (user clicks "Open terminals" mid-operation) would survive the snapshot; acceptable per plan.

## Recommendation

Complexity 4 → **Send to Coder** (additive method + 4 hook sites; transactional care needed for the `updateState`/`killTerminal` nesting boundary; the rollback-path hook is the trickiest to place correctly).
