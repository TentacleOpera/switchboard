# The plan-delete endpoint hits a foreign-key wall and then fails to unlink the file

## Goal

`DELETE /kanban/plans?planId=<id>&deleteFile=true` deletes the DB row and unlinks the `.md` file in one call, for any plan — including ones with `plan_events` history. Today it does neither for any plan that has been dispatched at least once.

### Problem analysis

**The endpoint runs a bare `DELETE FROM plans WHERE plan_id = ?` with no cascade.** `_handleDeletePlan` (`src/services/LocalApiServer.ts:11143-11187`) calls `db.deletePlanByPlanId(planId)` (`KanbanDatabase.ts:4268-4274`), which runs:

```sql
DELETE FROM plans WHERE plan_id = ?
```

The `plan_events` table has a foreign key: `FOREIGN KEY (plan_id) REFERENCES plans(plan_id)` (`KanbanDatabase.ts:1365`, V20 rebuild) — no `ON DELETE CASCADE` (SQLite default `ON DELETE NO ACTION`). FK enforcement IS on (`src/services/sqliteDriver.ts:229` sets `PRAGMA foreign_keys = ON` on every non-readonly open). So any plan with at least one `plan_events` row (every plan that has been dispatched, completed, or column-moved) hits `SQLITE_CONSTRAINT_FOREIGNKEY` inside `_persistedUpdate` (`KanbanDatabase.ts:12854-12870`), which catches it, logs it, and returns `false`. The endpoint returns `{ success: false, fileDeleted: false }` and the plan stays on the board.

> NOTE: a stale comment at `KanbanDatabase.ts:8012` claims "SQLite FK enforcement is OFF in this codebase (PRAGMA foreign_keys is not set to ON)." This is **wrong** — `sqliteDriver.ts:229` turns it ON. The implementer should ignore that comment; it describes a state that does not hold and will mislead anyone who trusts it.

This was found deleting `the-pi-cannot-build-so-ci-should-and-the-reviewer-should-read-it.md` (plan ID `c818d2bb-...`). The plan had exactly one `plan_events` row. Clearing that row manually unblocked the delete — proving the FK is the only blocker, not a missing plan or a wrong ID.

**The file-unlink branch then silently no-ops even when the DB delete succeeds.** After `deletePlanByPlanId` returns `true`, the endpoint reads `record.planFile` (captured before the delete) and unlinks the file if `deleteFile=true`. But on the successful retry (after the manual `plan_events` clear), the endpoint returned `{ success: true, fileDeleted: false }` — the DB row was gone but the file stayed on disk. The plan watcher would have re-imported it on the next sweep, resurrecting the card. The file had to be unlinked by hand.

The unlink block (`LocalApiServer.ts:11173-11179`) has multiple silent-failure paths, only one of which the original analysis considered:

```js
if (url.searchParams.get('deleteFile') === 'true' && record.planFile && root) {
    const plansDir = path.resolve(path.join(root, '.switchboard', 'plans'));
    const abs = path.resolve(path.isAbsolute(record.planFile) ? record.planFile : path.join(root, record.planFile));
    if (abs.startsWith(plansDir + path.sep)) {
        try { await fs.unlink(abs); fileDeleted = true; } catch { /* already gone */ }
    }
}
```

- `root = url.searchParams.get('workspaceRoot') || this._options.workspaceRoot || ''` (`:11156`). If `root` is empty, the `&& root` guard skips the **entire** block with no log — `fileDeleted: false`, no error, no clue. This is the AGENTS.md fallback pattern: `|| ''` makes "no root passed" indistinguishable from "root is empty string" and silently drops the unlink.
- If the `abs.startsWith(plansDir + path.sep)` guard rejects (e.g. `record.planFile` resolved via the DB's `_workspaceRoot` while `plansDir` resolved via a divergent query-param `root` — symlink, trailing-slash, or a different-normalized root), `fileDeleted` stays `false` with no log.
- If `fs.unlink` throws a **non-ENOENT** error (permissions, EBUSY), the bare `catch { /* already gone */ }` swallows it as "already gone." A permission error is NOT "already gone" — the file stays on disk and the log says nothing.

### Root cause

Two defects in one endpoint:
1. **FK cascade missing.** `plan_events.plan_id` has no `ON DELETE CASCADE`, and the endpoint doesn't clear child rows before deleting the parent. Every dispatched plan fails to delete. The same bare `DELETE FROM plans WHERE plan_id = ?` also exists in the deprecated `deletePlan(sessionId)` (`KanbanDatabase.ts:4258-4265`), to which `TaskViewerProvider._handleDeletePlan` falls back (`TaskViewerProvider.ts:21225`) for legacy run sheets — so the bug is not isolated to the API endpoint.
2. **Silent unlink failure.** The file-unlink block can skip or reject without logging why (empty `root`, guard rejection, or a swallowed non-ENOENT unlink error), leaving the file on disk to be re-imported.

## Metadata

**Feature:** 4b69fe8b-8bdb-4669-82dc-06e5460c184a
**Complexity:** 4
**Tags:** bugfix, database, api
**Project:** Browser Switchboard

## User Review Required

None.

## Complexity Audit

### Routine

- Adding `DELETE FROM plan_events WHERE plan_id = ?` (and the other child-table clears) before the `DELETE FROM plans` call inside `deletePlanByPlanId` and `deletePlan`, in one transaction — mirroring the existing `deletePlanByPlanFile` (`KanbanDatabase.ts:4203-4223`).
- Logging the `abs` vs `plansDir` vs `root` comparison in the unlink guard so a silent rejection is diagnosable.
- Logging the reason when the unlink block is skipped entirely (empty `root` or empty `record.planFile`).

### Complex / Risky

- **Manual-clear vs. `ON DELETE CASCADE` (resolved — see Superseded callout in Proposed Changes).** The manual-clear approach mirrors a proven in-repo pattern and needs no schema migration.
- **The unlink path resolution.** The guard compares an absolute `record.planFile` (resolved via the DB's `_workspaceRoot` through `_resolveAbsolutePlanFile`, `KanbanDatabase.ts:14639`) against `plansDir` resolved from the query-param `root`. If the two roots diverge (symlink, trailing slash, different normalization), the guard rejects. The fix resolves both sides through `fs.realpathSync` (guarded against ENOENT — see Edge Cases) before comparing, OR logs the rejected paths so the failure is visible. The bare `catch` must also stop swallowing non-ENOENT errors.

## Edge-Case & Dependency Audit

- **Race Conditions:** The child-row clears and the `plans` delete must be in the same transaction, or a concurrent event insert between them re-creates the FK violation. `deletePlanByPlanFile` already demonstrates the correct `BEGIN`…`COMMIT` shape; the fix reuses it.
- **Security:** No new surface — this tightens an existing delete path. The `abs.startsWith(plansDir + path.sep)` guard must remain the boundary that prevents unlinking arbitrary files; realpath resolution must not weaken it.
- **Side Effects:** Deleting `plan_events` rows removes the plan's history. This is correct — the plan is being deleted, its history is meaningless without it (`plan_events` is queried by `plan_id`). The same transaction should also clear `plan_runtime_state`, `plan_dependencies`, and `plan_tickets` rows for the `plan_id`: these tables have **no** FK to `plans` (only `plan_events` does), so they do not block the delete, but they orphan otherwise and accumulate forever. If any archive consumer depends on `plan_events`, it must read them before the delete, not after.
- **Dependencies & Conflicts:** All three delete paths funnel through `deletePlanByPlanId` / `deletePlan`:
  - `LocalApiServer._handleDeletePlan` (`:11169`) — the API endpoint.
  - `TaskViewerProvider._handleDeletePlan` (`:21223`, fallback `:21225`) — the extension's delete. **It does NOT clear `plan_events` itself**; it relies on the DB method. The original plan's claim that it "already handles the `plan_events` clear implicitly" was wrong — see Superseded callout below.
  - `PlanningPanelProvider` (`:4274`) — the webview delete.
  Fixing the choke point (`deletePlanByPlanId` + `deletePlan`) fixes all three callers in one change. The existing `deletePlanByPlanFile` (`:4203`) already clears `plan_events` and is unaffected.

## Dependencies

None.

## Adversarial Synthesis

Key risks: a `plan_events` table-rebuild migration to add `ON DELETE CASCADE` repeats the 2026-09-11 V74 incident (a rebuild took the board down on this exact FK) — disproportionate for a bugfix; the manual clear belongs inside the shared `deletePlanByPlanId`/`deletePlan` choke point (mirroring the proven `deletePlanByPlanFile`), not in each caller, so the "fragility" argument against it is a strawman; the unlink block has three silent-failure paths (empty `root` skip, guard rejection, swallowed non-ENOENT error), only one of which the original plan logged. Mitigations: manual clear in one transaction covering all four child tables; log every skip/rejection path; stop swallowing non-ENOENT unlink errors; guard `realpath` against ENOENT.

## Proposed Changes

### 1. Clear `plan_events` (and orphan-prone child tables) before deleting the plan row

In `deletePlanByPlanId` (`KanbanDatabase.ts:4268-4274`) and the deprecated `deletePlan` (`KanbanDatabase.ts:4258-4265`), run the child-row clears and the parent delete in one `BEGIN`…`COMMIT` transaction, mirroring `deletePlanByPlanFile` (`:4203-4223`):

```ts
public async deletePlanByPlanId(planId: string): Promise<boolean> {
    if (!planId) return false;
    if (!(await this.ensureReady()) || !this._db) return false;
    try {
        this._db.run('BEGIN');
        // plan_events has the FK (ON DELETE NO ACTION) — must clear first or the
        // parent DELETE raises SQLITE_CONSTRAINT_FOREIGNKEY. The other three have
        // no FK but orphan if left; clear them in the same transaction.
        this._db.run('DELETE FROM plan_events WHERE plan_id = ?', [planId]);
        this._db.run('DELETE FROM plan_runtime_state WHERE plan_id = ?', [planId]);
        this._db.run('DELETE FROM plan_dependencies WHERE plan_id = ?', [planId]);
        this._db.run('DELETE FROM plan_tickets WHERE plan_id = ?', [planId]);
        this._db.run('DELETE FROM plans WHERE plan_id = ?', [planId]);
        this._db.run('COMMIT');
    } catch (error) {
        try { this._db.run('ROLLBACK'); } catch { /* transaction already gone */ }
        console.error(`[KanbanDatabase] deletePlanByPlanId failed for ${planId}:`, error);
        return false;
    }
    return this._persist();
}
```

`deletePlan(sessionId)` should resolve the `planId` (via `getPlanBySessionId`) and delegate to `deletePlanByPlanId`, so the two paths cannot drift.

> **Superseded:** Decision: `ON DELETE CASCADE`. "The manual-clear approach is fragile — every future delete path must remember to clear `plan_events` first, and one forgotten path brings the bug back. Cascade is permanent: the database enforces it, not the code. The cost is a table-rebuild migration for the published install base, which is the right trade for a bug that cannot recur."
> **Reason:** The "fragility" argument is a strawman: the clear lives inside `deletePlanByPlanId` (and `deletePlan`), the single DB methods all three callers already funnel through — a future caller is covered automatically by calling the method, not by remembering to clear. Meanwhile `ON DELETE CASCADE` requires a `plan_events` table rebuild (SQLite cannot `ALTER TABLE` to add cascade), the same `PRAGMA foreign_keys=OFF` procedure that took this board down on 2026-09-11 (V74, `KanbanDatabase.ts:11815` — 1,919 orphaned `plan_events` rows bit the rebuild). Repeating that dance voluntarily, for a bugfix, against a published install base, is disproportionate risk. Cascade also only covers `plan_events`; `plan_runtime_state`, `plan_dependencies`, and `plan_tickets` have no FK and would still orphan. The manual clear covers all four child tables in one transaction, mirrors the existing proven `deletePlanByPlanFile` (`:4203`), needs no migration, and fixes all three callers at the choke point.
> **Replaced with:** Manual clear inside `deletePlanByPlanId` and `deletePlan` (one transaction, four child-table clears + parent delete), mirroring `deletePlanByPlanFile`. No schema change, no migration.

> **Superseded:** "The `TaskViewerProvider._handleDeletePlan` path (`:21277-21287`) already handles the `plan_events` clear implicitly — it deletes via `deletePlanByPlanId` and regenerates the feature file. If the FK bug exists there too, it's the same root cause."
> **Reason:** `deletePlanByPlanId` does NOT clear `plan_events` (it runs a bare `DELETE FROM plans WHERE plan_id = ?`). `TaskViewerProvider._handleDeletePlan` calls `deletePlanByPlanId` (`TaskViewerProvider.ts:21223`) and falls back to `deletePlan` (`:21225`); neither clears. The FK bug therefore exists in the `TaskViewerProvider` path too — it is not "already handled implicitly." The same applies to `PlanningPanelProvider` (`:4274`).
> **Replaced with:** All three delete paths (`LocalApiServer`, `TaskViewerProvider`, `PlanningPanelProvider`) share the FK bug because they share the choke point. Fixing `deletePlanByPlanId` + `deletePlan` fixes all three; no per-caller change is needed.

### 2. Log the unlink guard's rejected paths AND every silent skip

In `_handleDeletePlan` (`LocalApiServer.ts:11173-11179`):

- When the whole unlink block is skipped because `root` is empty or `record.planFile` is empty, log it (with the values) so the silent `fileDeleted: false` is diagnosable. The `|| ''` fallback on `root` is the AGENTS.md "fallback indistinguishable from a real value" pattern — logging re-tags it so "no root passed" is answerable after the fact.
- When the `abs.startsWith(plansDir + path.sep)` guard rejects, log `abs`, `plansDir`, and `root`.

### 3. Resolve both paths through `realpath` before comparing (guarded against ENOENT)

The unlink guard compares `abs` (from `record.planFile`, resolved via the DB's `_workspaceRoot`) against `plansDir` (from the query-param `root`). If one is symlink-resolved and the other isn't, the guard rejects a valid path. Resolve both through `fs.realpathSync` before the `startsWith` check — **but guard it**: `fs.realpathSync` throws `ENOENT` on a non-existent path, and the file may already be gone at guard time (it is being deleted). Wrap each `realpathSync` in a try and fall back to the unresolved path on `ENOENT`/`ENOENT`-class errors, so a missing file turns into a graceful no-op rather than a 500.

### 4. Stop swallowing non-ENOENT unlink errors

The bare `catch { /* already gone */ }` (`:11177`) treats every `fs.unlink` failure as "already gone." A permission error or `EBUSY` is not "already gone" — the file stays on disk and the watcher resurrects the card. Distinguish `ENOENT` (genuinely already gone — leave `fileDeleted` as-is, log "already gone") from other errors (log the error code/message, and surface it in the response as an `unlinkError` field so the caller knows the file was not removed). The response stays `{ success: ok, fileDeleted }` (DB delete and file unlink remain decoupled — the row is the primary goal and a leftover file is recoverable), but the failure is no longer silent.

## Verification Plan

1. A plan with at least one `plan_events` row (any dispatched plan) deletes successfully via `DELETE /kanban/plans?planId=<id>&deleteFile=true` — returns `{ success: true, fileDeleted: true }` (when the file exists and unlinks cleanly).
2. The `.md` file is unlinked from disk — `ls` confirms it's gone.
3. The plan watcher does not re-import the plan (no card resurrection on the next sweep).
4. A plan with no `plan_events` rows still deletes (regression — the simple case must not break).
5. `deletePlanByPlanId` clears `plan_events`, `plan_runtime_state`, `plan_dependencies`, and `plan_tickets` rows for the `plan_id` in the same transaction as the `plans` delete — a post-delete query confirms all four child tables have zero rows for that `plan_id`.
6. The unlink block logs the reason when skipped (empty `root` / empty `planFile`) and logs `abs`/`plansDir`/`root` when the guard rejects — no silent `fileDeleted: false`.
7. A non-ENOENT unlink error (e.g. simulate a permission-denied file) is logged and surfaced as `unlinkError` in the response, not swallowed as "already gone."
8. `fs.realpathSync` on an already-missing file does not throw a 500 — the guard falls back to the unresolved path and the endpoint returns gracefully.

### Automated Tests

- Unit test: a plan with `plan_events` rows deletes via `deletePlanByPlanId` and leaves zero rows in `plan_events`, `plan_runtime_state`, `plan_dependencies`, `plan_tickets`.
- Unit test: the deprecated `deletePlan(sessionId)` delegates to `deletePlanByPlanId` and clears `plan_events` (regression for the `TaskViewerProvider` fallback path).
- Unit test: `_handleDeletePlan` with an empty `root` logs the skip and returns `fileDeleted: false` (no silent skip).
- Unit test: `_handleDeletePlan` unlink guard rejection logs `abs`/`plansDir`/`root`.
- Unit test: a non-ENOENT unlink error is surfaced as `unlinkError`, not swallowed.
- Regression: a plan with zero `plan_events` rows still deletes.

### Goal Invariants

- **Positive:** After `DELETE /kanban/plans?planId=<id>&deleteFile=true` on a plan with at least one `plan_events` row, the `plans` row for that `plan_id` is absent from the DB.
- **Negative:** After a successful delete, `plan_events` rows for that `plan_id` are absent from the DB (cleared in the same transaction, not left as orphans).
- **Negative:** After a successful delete, `plan_runtime_state`, `plan_dependencies`, and `plan_tickets` rows for that `plan_id` are absent (no orphan accumulation).
- **Negative:** After a successful delete with `deleteFile=true` and a pre-existing file, the plan's `.md` file is absent from `.switchboard/plans/` (not re-imported by the watcher).
- **Positive:** A plan with zero `plan_events` rows still deletes successfully (regression guard).
- **Positive:** A non-ENOENT unlink error is surfaced (response carries an `unlinkError` field or an equivalent diagnostic), not swallowed as `fileDeleted: false` with no log.

## Fresh reproduction (2026-09-19) — and one detail of the analysis above is stale

Hit deliberately while deleting a redundant plan
(`8d250d8d-803f-4308-8bf0-b56f3b85d0f7`, "Multi-Agent Planning Team — Fan-Out Head
Prompt and Peer-Planner Roster", which had shipped):

```
DELETE /kanban/plans?planId=<id>&deleteFile=true&workspaceRoot=<root>
  → {"success":false,"fileDeleted":true}
```

**The foreign-key wall is confirmed.** `deletePlanByPlanId` is a bare
`DELETE FROM plans WHERE plan_id = ?`; the plan had `plan_events` history, the
delete failed, and `_persistedUpdate` returned `false`.

**But the file DID unlink.** The goal above says the call "does neither" — on this
build it does the second half: `fileDeleted: true`, and the `.md` is gone from
`.switchboard/plans/`. So the failure is now WORSE than described rather than
merely incomplete: the endpoint destroys the file and keeps the row, which is the
one combination that cannot be recovered from either side. Re-verify that clause
before implementing; the fix must not assume the unlink is still guarded behind a
successful delete.

**The row is left as a tombstone.** After the call the row survives with
`status = 'missing'` (a watcher noticed the vanished file), still stamped
`kanban_column = 'PLAN REVIEWED'`. It is off the board, because every board read
filters `status = 'active'` — the column's active count went 351 → 350 — so the
operator sees the card go and nothing reports that the deletion half-failed.
A retry returns `{"success":false,"fileDeleted":false}` forever.

That silent half-success is worth folding into this plan's verification: a delete
that cannot remove the row must SAY so, rather than returning a shape the caller
reads as "gone" while the row is still there.
