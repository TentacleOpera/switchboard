# Fix: Atomic-Write DELETE Event Permanently Drops the Plan/Epic Row (Definitive Symptom Fix + Safety Net)

## Goal

Close the atomic-write race in `GlobalPlanWatcherService` that the two `is_epic`/`kanban_column` plans only patched symptomatically. When an epic or plan file is saved by any tool that writes atomically (temp file + rename — the `write` tool, agents, and most editors do this), a spurious DELETE event can win the debounce-ordering and **permanently remove the DB row** until the next manual scan or panel reopen. The card simply vanishes from the board.

This is the residual risk flagged by the 2026-06-28 reviewer pass on `fix-create-epic-not-setting-is-epic.md` (remaining risk #1). The sibling plans close the *common* interleaving (delete-before-insert, where `is_epic`/`kanban_column` are re-asserted after re-INSERT). This plan closes the *reverse* interleaving (delete-after-insert) and the broader "row disappears entirely" failure, by making the DELETE handler verify the file is actually gone before destroying its row.

**Framing clarification (from adversarial review):** This is the **definitive symptom fix** — it makes the permanent-row-loss failure impossible by guarding the destructive path. The *true* root cause (divergent debounce keys for CREATE vs DELETE that fail to coalesce) is explicitly scoped out as future work (see Adversarial Synthesis). This guard is a general safety net that covers all callers of `_handlePlanDelete`, not a redesign of the debounce-key architecture.

### Root Cause

An atomic write (`temp.md` → `rename` over `target.md`) fires **two** filesystem events for the watched path:
- a DELETE (the old inode is replaced), and
- a CREATE/CHANGE (the new file appears).

These are dispatched to two **separately-keyed** debounce timers:
- `_debounceHandleFile` keys on `uri.fsPath` (`GlobalPlanWatcherService.ts:439`).
- `_debounceHandleDelete` keys on `delete:${uri.fsPath}` (`GlobalPlanWatcherService.ts:451`).

Because the keys differ, the CREATE and DELETE events **do not coalesce** — both 300 ms timers fire, and `_handlePlanFile` + `_handlePlanDelete` run in nondeterministic order.

The destructive path is **`_handlePlanDelete` (`GlobalPlanWatcherService.ts:683-711`)**: it calls `deletePlanByPlanFile` (line 703) on a DELETE event **without ever checking whether the file currently exists on disk**. Its only suppression is `_recentRenames`, which is populated *only* by extension-initiated `registerRename` (line 48-51) — NOT by external atomic writes. So for the exact scenario this plan targets, the suppression never fires.

Failure interleaving (delete-after-insert):
1. `_handlePlanFile` runs: re-INSERTs the row and (for epics) re-asserts `is_epic = 1` / re-derives `kanban_column`.
2. `_handlePlanDelete` runs *after* it: the file already exists again (the rename completed), but the handler doesn't check, so it calls `deletePlanByPlanFile` and **the row is gone**.
3. The board refresh shows the card missing. It only returns on the next `triggerScan` / panel reopen, which re-imports the file.

This is strictly worse than the `is_epic = 0` symptom the sibling plans fixed: there is **no row at all**, so `is_epic`/`kanban_column` re-asserts have nothing to write to.

### Background

The **native `fs.watch` path already guards against this**: at `GlobalPlanWatcherService.ts:419-425` it only schedules a debounce-delete when `!fs.existsSync(fullPath)` *at event time*. The **VS Code `FileSystemWatcher`** path does not — its `onDidDelete` (line 382-385) routes unconditionally to `_debounceHandleDelete`. So the bug is specific to the VS Code watcher (the primary watcher for in-workspace folders).

Checking existence *at event time* (as the native watcher does) is necessary but not sufficient: with an atomic rename the new file may land during the 300 ms debounce window. The correct, fully-general place to re-check is **inside `_handlePlanDelete`, after the debounce has elapsed**, where the rename has definitely completed. Centralizing the guard there also covers every caller of `_handlePlanDelete` (today both watcher paths route through it), not just the VS Code one.

`deletePlanByPlanFile` (`KanbanDatabase.ts:1900`) is a hard delete of the row keyed by `(plan_file, workspace_id)`.

## Metadata

**Complexity:** 2
**Tags:** bugfix, backend, reliability

## User Review Required

None. The correct behavior is unambiguous: a DELETE event for a path that still exists on disk was not a real deletion (it was an atomic rewrite/rename), and the row must be preserved. There is no product trade-off to decide. The only behavioral change is that a spurious delete is ignored; a genuine delete (file actually gone) is unaffected.

## Complexity Audit

### Routine
- Single localized guard: one `fs.existsSync` check + early `return` at the top of `_handlePlanDelete`, before any DB work.
- `fs` is already imported (`import * as fs from 'fs'`, line 4) and `fs.existsSync` is already the idiom in this file (lines 194, 211, 214, 320, 327, 399, 419-420).
- Idempotent and side-effect-free on the skip path (it only returns earlier).

### Complex / Risky
- The guard runs in an async hot path; `fs.existsSync` is a synchronous syscall. One stat per delete event is negligible and matches the existing synchronous-existence checks in this same file, but it is technically a sync call inside an `async` method (acceptable, consistent with local convention).
- TOCTOU window: the file can be deleted in the instant *after* the existence check. Bounded staleness — the stale row lingers until the next `triggerScan` (up to 10s via `_scanIntervalMs`) or panel reopen, not instant self-healing. Acceptable for a delete-skip path.
- This does NOT redesign the divergent debounce keys (create vs delete). That coalescing redesign is a larger behavioral change and is explicitly scoped out (see Adversarial Synthesis).

## Edge-Case & Dependency Audit

**Race Conditions**
- *Atomic write (temp + rename)* — the headline case: after the 300 ms debounce, the renamed target exists → `fs.existsSync` is `true` → delete skipped → row preserved. The CREATE/CHANGE event's `_handlePlanFile` updates the row as normal. ✅ Fixed.
- *Genuine delete* — file is gone → `fs.existsSync` is `false` → delete proceeds exactly as today. ✅ No regression.
- *Delete-then-recreate within 300 ms* (the delete debounce coalesces to one run): by execution time the file exists again → skip → correct (the plan still exists).
- *Create-then-delete within 300 ms*: by delete-execution time the file is gone → delete proceeds. A racing `_handlePlanFile` that tries to re-import reads the now-missing file (`fs.promises.readFile`, line 517) and throws → caught by the outer try/catch → no phantom row is inserted. ✅
- *TOCTOU (exists at check, deleted immediately after)*: the delete is skipped this cycle, leaving the row briefly stale (up to 10s — the `_scanIntervalMs` interval — until the next `triggerScan` reconciles, or panel reopen). Bounded staleness, not instant self-healing; acceptable for a delete-skip path where the alternative is permanent row loss.

**Security**
- None. `uri.fsPath` is derived from the watched `.switchboard/{plans,epics}/**/*.md` pattern; no untrusted input reaches the check. `fs.existsSync` on a path already constrained to the workspace subtree introduces no new surface.

**Side Effects**
- On the skip path, `_handlePlanDelete` no longer fires `this._onPlanDiscovered.fire(...)` (line 705) — correct, because nothing was deleted; the CREATE/CHANGE event independently drives `_handlePlanFile` and any downstream refresh.
- One extra `fs.existsSync` syscall per DELETE event. Negligible; delete events are infrequent and already debounced.

**Dependencies & Conflicts**
- Complementary to the native watcher's existing event-time guard (line 419-425) — this adds the post-debounce execution-time guard the native path lacks and the VS Code path omits entirely. No conflict.
- Complementary to `_recentRenames` (extension-initiated renames): that fast-path stays as-is; the new check is the general safety net for external atomic writes it never covered.
- Does not touch `UPSERT_PLAN_SQL`, `updateEpicStatus`, or any cascade path — orthogonal to the two sibling plans. No migration: this is pure watcher logic, no state/file/settings schema change.

## Dependencies

- `fix-create-epic-not-setting-is-epic.md` — symptomatic fix for the `is_epic = 0` vector of this same race (delete-before-insert ordering). This plan closes the underlying race that fix scoped out.
- `fix-epic-loses-status-on-column-move.md` — shares the broader epic-reliability context; no code overlap.
- `fix-epic-default-column-from-subtasks.md` — the `kanban_column = 'CREATED'` clobber from this same race for subtask-less epics. Once this root-cause guard lands, that clobber can no longer occur via the delete-after-insert path either.

## Adversarial Synthesis

Key risks: (1) TOCTOU after the existence check leaves a stale row for up to 10s (`_scanIntervalMs`) — bounded staleness, acceptable vs. permanent row loss; (2) this is a definitive *symptom* fix (safety net on the destructive path), not a root-cause redesign of the divergent CREATE/DELETE debounce keys, which is explicitly scoped out as future work; (3) `fs.existsSync` is a sync syscall in an async method — consistent with the 11 existing `existsSync` calls in this file and negligible given 300ms debounce coalescing. Mitigations: the guard is surgical, idempotent, covers both watcher paths, and makes the reported "card disappears" failure impossible without touching DB/cascade/migration logic.

## Proposed Changes

### `src/services/GlobalPlanWatcherService.ts` — `_handlePlanDelete` (line 683)

Add an early-return guard as the first statement inside the `try`, before any DB work:

```typescript
private async _handlePlanDelete(uri: vscode.Uri, workspaceRoot: string): Promise<void> {
    try {
        // Atomic-write guard. External tools (the write tool, agents, most editors) save
        // via temp-file + rename, which fires a DELETE event for the target path even though
        // the rename immediately recreated it. The VS Code FileSystemWatcher's onDidDelete
        // (unlike the native fs.watch path) does not re-check the filesystem, and the create
        // vs delete debounce timers are separately keyed so they do not coalesce — so without
        // this guard a spurious delete can win the ordering and hard-delete the row for a file
        // that still exists, racing a concurrent _handlePlanFile re-insert. Checked here, AFTER
        // the 300ms debounce, so the rename has definitely landed (an event-time check, as the
        // native watcher does at line 419-425, can fire mid-rename).
        if (fs.existsSync(uri.fsPath)) {
            this._outputChannel?.appendLine(
                `[GlobalPlanWatcher] Skipping delete; file still exists (atomic write/rename): ${uri.fsPath}`
            );
            return;
        }

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        await db.ensureReady();
        // ... existing body unchanged ...
```

No other code changes. The existing `_recentRenames` check (line 692) and completed-plan skip (line 699) remain as-is — the new guard sits ahead of them as the general safety net.

## Verification Plan

> Compilation and automated tests are deferred to the user (run separately). The verification below is manual/observational.

### Automated Tests
- Deferred to user. Suggested coverage if added later:
  - A watcher test that simulates an atomic write (write temp + rename over an existing epic file) and asserts the DB row is NOT deleted and the card remains on the board without a `triggerScan`.
  - A test that `_handlePlanDelete` for a path that still exists is a no-op (no `deletePlanByPlanFile` call, no `_onPlanDiscovered` fire).
  - A regression test that a genuine delete (file removed) still deletes the row.

### Manual Verification
- Edit an epic file with a tool that writes atomically (temp + rename) → the epic card stays on the board, badge and column intact, with no panel reopen.
- Rapidly re-save an epic file several times → the card never flickers out / disappears.
- Genuinely delete a plan file from disk → the card is removed from the board (no regression of real deletes).
- Delete then immediately re-save a plan within ~300 ms → the plan remains (delete skipped because the file exists at execution time).
- Check the output channel: an atomic write should log `Skipping delete; file still exists (atomic write/rename): …`; a real delete should log `Deleted plan: …`.
- DB check after an atomic-write edit: `SELECT plan_id, is_epic, kanban_column FROM plans WHERE plan_id = '<epic_id>'` — the row exists and is unchanged.
