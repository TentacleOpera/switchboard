# Fix Epic `is_epic=0` Clobber + Add Runtime Self-Heal

**Complexity:** 5

## Goal

Epics consistently lose their `is_epic=1` DB flag (it gets clobbered to `0`), so a created
epic never appears as an epic card on the Kanban board — it renders as a plain plan card, its
subtask list goes stale, and every epic-specific operation (`_regenerateEpicFile`,
`recomputeEpicColumnFromSubtasks`, `getEpicPlans`, the Epics tab) silently ignores it because
they all gate on `is_epic === 1`. The user reports this happens for **every** epic-creation
path (group-into-epics button, Epics-tab "+ New Epic", `create-epic.js` / API). This plan
makes `is_epic` self-healing so a clobber — from any vector — is automatically repaired
instead of permanently breaking the epic.

### Problem & Root Cause Analysis

**Evidence (live DB, workspace `038bffef…`):**
- Epic `908739dc-42a1-475b-9772-0c1209b24cba` — file
  `.switchboard/epics/change-epics-to-features-908739dc-…-0c1209b24cba.md` exists with 3
  subtasks listed, the 3 subtask rows ARE correctly linked
  (`epic_id='908739dc-…'`), but the epic row itself has `is_epic=0`, `epic_id=''`,
  `kanban_column='PLAN REVIEWED'`, `project='switchboard'`, `project_id=''`. Created
  `2026-07-04T13:41:01`, last updated `2026-07-04T13:41:20` (19s later — during/right after
  `createEpicFromPlanIds`).
- A second epic `0ea8d297-…` (`.switchboard/epics/epic-0ea8d297-…md`) is also `is_epic=0`
  (created 2026-06-10, predates the June 27/30 fixes — a pre-fix casualty never healed).
- 2 of 50 epic files in the DB are `is_epic=0`. The other 48 are healthy (`is_epic=1`).

**Why `is_epic` gets clobbered to 0 in the first place:**

The current source (`src/services/GlobalPlanWatcherService.ts`, `src/services/KanbanDatabase.ts`,
`src/services/KanbanProvider.ts`) already has three layers of defense, added in commits
`3d7f8bc` (2026-06-27) and `d827e30` (2026-06-30):

1. `UPSERT_PLAN_SQL` / `insertFileDerivedPlan` ON CONFLICT clause is *sticky*:
   `is_epic = CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END`
   (KanbanDatabase.ts:640, 1465) — once 1, a re-import with `is_epic=0` cannot clear it.
2. The watcher sets `newRecord.isEpic = 1` / `updatedRecord.isEpic = 1` **before** calling
   `insertFileDerivedPlan` for any `relativePath.startsWith('.switchboard/epics/')`
   (GlobalPlanWatcherService.ts:572-574, 638-640) and re-asserts via
   `updateEpicStatus(planId, 1, '')` after (lines 577, 650).
3. `createEpicFromPlanIds` re-asserts `updateEpicStatus(effectiveEpicPlanId, 1, '')` as the
   **final** DB write before refresh (KanbanProvider.ts:10181).

**These defenses are in the source the epic was created with (July 4 > June 30), yet the
epic is still clobbered.** Two explanations, both contributing:

- **(A) Stale installed VSIX (most likely immediate cause).** `CLAUDE.md` states "All testing
  is done via an installed VSIX — nothing is served from the repo's `dist/`. `npm run
  compile` is only needed when producing a VSIX for release." If the installed VSIX was built
  **before** `3d7f8bc`/`d827e30`, the user is running the OLD code where:
  `newRecord.isEpic = 1` was set **after** `insertFileDerivedPlan` (too late — the fresh INSERT
  already used the schema default `is_epic=0`), and the ON CONFLICT clause was
  `COALESCE(excluded.is_epic, is_epic)` which clobbered to 0 because callers passed literal
  `0` (not NULL). This explains the **consistent** clobber for **every** creation path. No
  installed extension was found in the standard `~/.vscode/extensions` /
  `~/.vscode-insiders/extensions` / `~/.cursor/extensions` locations (the user runs
  Antigravity), so the VSIX build provenance could not be verified directly — but the symptom
  pattern matches a stale build exactly.

- **(B) Residual race in current source (narrower).** `updateEpicStatus` updates by
  `plan_file + workspace_id` (KanbanDatabase.ts:1639), looked up from `planId`. If a
  concurrent `_handlePlanDelete` (atomic-write temp+rename, or a genuine delete) removes the
  row between the `createEpicFromPlanIds` upsert and the final re-assert, the re-assert
  returns false (0 rows, logged as a warn) and leaves the row at whatever a subsequent
  re-insert set. The watcher's re-insert sets `is_epic=1`, so this *should* self-correct —
  but there is a window where the row is gone, the re-assert no-ops, and no re-insert has
  fired yet.

**Why a clobbered epic stays broken forever (the REAL, durable gap):**

Once `is_epic=0`, **no runtime mechanism restores it.** Every self-heal path gates on
`is_epic === 1` and therefore skips clobbered epics:

- `_runMigrationV37` (KanbanDatabase.ts:5612-5653) DOES heal `is_epic` for any row under
  `.switchboard/epics/` (line 5626-5628: "Any file under .switchboard/epics/ is an epic …
  match regardless of is_epic, since the clobbering bug also resets that flag") — but it is a
  **one-shot migration**. The DB is at migration version **45**; V37 ran long ago and will
  never re-run. Epic `908739dc` was clobbered July 4, long after V37, so V37 never touched it.
- `regenerateAllEpicFiles` (KanbanProvider.ts:9985) uses `db.getEpicPlans(workspaceId)` which
  filters `WHERE is_epic = 1` (KanbanDatabase.ts:3010) — clobbered epics are **excluded** from
  the startup self-heal (TaskViewerProvider.ts:2663-2665).
- `_regenerateEpicFile` guards `if (!epic.isEpic) return` (KanbanProvider.ts:9881) — bails.
- `recomputeEpicColumnFromSubtasks` guards `if (!epic || !epic.isEpic) return`
  (KanbanProvider.ts:5588) — bails.
- The board maps `isEpic: !!row.isEpic` (KanbanProvider.ts:2920) — clobbered epics render as
  plain plan cards, never as epic cards.

So the defenses **prevent** clobbering, but if a clobber slips through (stale VSIX, race,
manual edit, future regression), the epic is **permanently** broken with no recovery short of
manual SQL or a migration-version rollback. This is the defect that makes the bug
**consistent** rather than transient: a single clobber is unrecoverable.

### Background / Invariant

The architectural invariant (documented at KanbanDatabase.ts:5616-5618 and
GlobalPlanWatcherService.ts:537-546) is: **any `.md` file under `.switchboard/epics/` IS an
epic.** The `is_epic` flag is a denormalized cache of that file-location truth. V37 already
encodes this ("match regardless of is_epic"). The fix promotes that one-shot migration logic
to a **runtime invariant**: the file location is authoritative; the flag is derived and
self-healed.

## Implementation

### Step 1 — Add `reconcileEpicFlagsFromFilePaths` to `KanbanDatabase`

New public method in `src/services/KanbanDatabase.ts` (near `getEpicPlans`, ~line 3014):

```ts
/**
 * Runtime invariant: any active row whose plan_file lives under .switchboard/epics/ IS an
 * epic — restore is_epic=1 for rows that were clobbered to 0/NULL by a stale build, a
 * watcher race, a manual edit, or a future regression. Mirrors the one-shot V37 heal
 * (line 5626-5628) but runs every startup/refresh so a clobber is never permanent.
 * Returns the count of rows healed (0 when already consistent — cheap no-op).
 */
public async reconcileEpicFlagsFromFilePaths(workspaceId: string): Promise<number> {
    if (!(await this.ensureReady()) || !this._db) return 0;
    try {
        this._db.run('BEGIN');
        this._db.run(
            `UPDATE plans SET is_epic = 1
             WHERE workspace_id = ? AND status = 'active'
               AND plan_file LIKE '.switchboard/epics/%'
               AND (is_epic IS NULL OR is_epic = 0)`,
            [workspaceId]
        );
        const healed = this._db.getRowsModified();
        this._db.run('COMMIT');
        if (healed > 0) {
            await this._persist();
            console.log(`[KanbanDatabase] reconcileEpicFlagsFromFilePaths: restored is_epic=1 for ${healed} clobbered epic row(s)`);
        }
        return healed;
    } catch (err) {
        try { this._db.run('ROLLBACK'); } catch { /* ignore */ }
        console.error('[KanbanDatabase] reconcileEpicFlagsFromFilePaths failed:', err);
        return 0;
    }
}
```

Notes:
- `status = 'active'` guard so archived/completed/deleted rows under `epics/` (legacy) are
  not resurrected as active epics.
- `plan_file LIKE '.switchboard/epics/%'` matches the V37 selector exactly (line 5620).
- 0-row case is a cheap no-op (one UPDATE, no persist) — safe to run every refresh.

### Step 2 — Call the reconciler on startup, BEFORE `regenerateAllEpicFiles`

In `src/services/TaskViewerProvider.ts`, modify the deferred startup block (lines 2663-2665)
so the flag heal runs **before** the file-regen heal (which depends on `is_epic=1` to pick up
the epic via `getEpicPlans`):

```ts
// Self-heal: (1) restore is_epic=1 for any clobbered epic row whose file is in epics/,
// then (2) regenerate all epic files so subtask lists stay in sync. Order matters: the
// file-regen pass uses getEpicPlans (filters is_epic=1), so the flag heal MUST run first
// or clobbered epics stay invisible forever.
setTimeout(async () => {
    try {
        const db = await this._getKanbanDb(effectiveWorkspaceRootForOrphanCheck);
        const wsId = db ? await db.getWorkspaceId() : null;
        if (db && wsId) {
            const healed = await db.reconcileEpicFlagsFromFilePaths(wsId);
            if (healed > 0) {
                void this._kanbanProvider?._refreshBoard(effectiveWorkspaceRootForOrphanCheck);
            }
        }
    } catch (e) {
        console.warn('[TaskViewerProvider] epic flag reconcile failed:', e);
    }
    void this._kanbanProvider?.regenerateAllEpicFiles(effectiveWorkspaceRootForOrphanCheck);
}, 3000);
```

(Keep the existing 3000ms deferral so startup is not blocked.)

### Step 3 — Call the reconciler on each board refresh (throttled)

In `src/services/KanbanProvider.ts` `_refreshBoardImpl` (after the `dbReady` check, ~line
2843), add a fire-and-forget reconcile so a clobber is repaired within one refresh cycle even
without a restart. Throttle to once per 60s per workspace to avoid running the UPDATE on every
drag/refresh:

```ts
// Runtime self-heal: restore is_epic=1 for clobbered epic rows. Throttled — the 0-row
// case is cheap, but avoid the UPDATE on every drag/refresh.
const now = Date.now();
if (!this._lastEpicFlagReconcile || now - this._lastEpicFlagReconcile > 60000) {
    this._lastEpicFlagReconcile = now;
    void db.reconcileEpicFlagsFromFilePaths(workspaceId).then(healed => {
        if (healed > 0) {
            console.log(`[KanbanProvider] self-healed ${healed} clobbered epic flag(s) during refresh`);
        }
    }).catch(() => { /* non-fatal */ });
}
```

Add a private field `private _lastEpicFlagReconcile = 0;` to the class.

### Step 4 — Harden `createEpicFromPlanIds` re-assert against the 0-rows race

In `src/services/KanbanProvider.ts` `createEpicFromPlanIds` (line 10181), the final
`updateEpicStatus(effectiveEpicPlanId, 1, '')` can return `false` (0 rows) if a concurrent
`_handlePlanDelete` deleted the row mid-creation. Re-upsert so the epic is never left without
a row:

```ts
// Re-assert is_epic=1 as the FINAL DB write before refresh — defensive hardening
// so any intermediate file-watcher/scan event that might touch the record leaves
// is_epic=1 as the last-write-wins state.
const reassertOk = await db.updateEpicStatus(effectiveEpicPlanId, 1, '');
if (!reassertOk) {
    // Row was deleted mid-creation (atomic-write race / concurrent delete). Re-upsert
    // so the epic is not left missing — the watcher's pending-creation guard may have
    // expired, leaving no auto re-import. is_epic=1 on the upsert record + the sticky
    // ON CONFLICT clause guarantees the flag survives.
    await db.upsertPlan({
        planId: effectiveEpicPlanId, sessionId, topic: epicName, planFile: epicPlanFile,
        kanbanColumn: effectiveColumn, status: 'active', complexity: 'Unknown',
        project: epicProject, workspaceId, createdAt: now, updatedAt: new Date().toISOString(),
        sourceType: 'local', isEpic: 1, epicId: '', projectId: epicProjectId
    });
    console.warn('[KanbanProvider] createEpicFromPlanIds: re-assert updateEpicStatus returned 0 rows — re-upserted epic record');
}
```

### Step 5 — One-time data repair for the 2 currently-clobbered epics

The runtime heal (Steps 1-3) repairs these automatically on the next startup/refresh — no
manual SQL needed. Verify after implement by running:

```bash
sqlite3 .switchboard/kanban.db "SELECT plan_id, is_epic FROM plans WHERE plan_file LIKE '.switchboard/epics/%' AND is_epic=0;"
```

Expected: 0 rows after the extension starts once with the fix.

## Files Touched

- `src/services/KanbanDatabase.ts` — add `reconcileEpicFlagsFromFilePaths` (Step 1)
- `src/services/TaskViewerProvider.ts` — startup heal-before-regen (Step 2)
- `src/services/KanbanProvider.ts` — refresh-throttled heal (Step 3) + re-assert hardening (Step 4)
- (No webview/HTML changes — the board already renders `is_epic=1` rows as epic cards; the
  fix is purely backend self-heal.)

## Verification

1. **Unit test** (`src/services/__tests__/KanbanDatabase.epicStatus.test.ts`): add a case that
   inserts an epic row with `is_epic=0` and `plan_file='.switchboard/epics/foo-<uuid>.md'`,
   calls `reconcileEpicFlagsFromFilePaths(workspaceId)`, and asserts `is_epic === 1`
   afterward. Also assert a row in `.switchboard/plans/` is NOT touched, and a
   `status='archived'` epic-path row is NOT touched.
2. **Live DB check** (Step 5): the 2 clobbered rows heal to `is_epic=1` after one startup.
3. **Repro the original bug is gone**: create an epic via the group-into-epics flow, the
   Epics-tab "+ New Epic", and `create-epic.js`; confirm each appears as an epic card
   (subtask count badge, epic styling) and survives a window reload.
4. **`npm run compile`** succeeds (only needed for VSIX release, per CLAUDE.md).

## Out of Scope (separate defects, noted for awareness)

- **`project_id` not resolved for project names absent from the `projects` table.** The
  example epic has `project='switchboard'` but `project_id=''` because only `Remote sync`
  exists as a project entity (so the epic won't appear on a `switchboard`-filtered board).
  This is a distinct issue from `is_epic` and is not addressed here.
- **Stale-VSIX hygiene.** If the installed VSIX predates `3d7f8bc`/`d827e30`, the user is
  running pre-fix code. The runtime self-heal (Steps 1-3) makes the system resilient to a
  stale build, but the user should still rebuild/reinstall the VSIX from current source to
  get the upstream clobber *prevention* (sticky ON CONFLICT, isEpic-before-insert). The
  self-heal is defense-in-depth, not a substitute for running current code.
