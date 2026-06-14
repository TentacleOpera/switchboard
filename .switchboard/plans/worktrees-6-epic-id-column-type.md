# Worktrees Part 6: Fix `worktrees.epic_id` Column Type

## Goal

Fix a silent data loss bug introduced in V30: `worktrees.epic_id` is declared `INTEGER REFERENCES plans(id)`, but `plans` has no `id` column — its primary key is `plan_id TEXT`. The FK is silently ignored by SQLite (no enforcement), and the INTEGER type coerces every non-numeric `plan_id` string to `0` on insert. Every worktree→epic lookup in `_cardsToPromptPlans` therefore silently misses, and worktree routing never activates for any plan.

## Metadata

**Tags:** backend, bugfix, database
**Complexity:** 3

## User Review Required

None.

## Complexity Audit

### Routine
- V31 migration (drop/recreate `worktrees`, restore rows)
- SCHEMA_SQL `worktrees` definition update (`INTEGER` → `TEXT`, remove FK)
- `String()` normalization in `_cardsToPromptPlans` lines 2161 and 2187

### Complex / Risky
- **Migration data preservation**: Existing rows with `epic_id = 0` or `NULL` are semantically equivalent to `NULL` in the new schema. Restore them with `epic_id = NULL`. Do not attempt to recover the original `plan_id` values — they were never stored correctly.
- **SCHEMA_SQL and migration must match**: If SCHEMA_SQL is patched but the V31 migration is missing, existing installs keep the broken INTEGER column. Both must be changed together.

## Edge-Case & Dependency Audit

### Race Conditions
- **Concurrent `addWorktree` during migration**: Migration runs during `_migrate()` inside `ensureReady()`, which holds the in-memory DB exclusively. No concurrent writes possible.

### Security
- None — no auth, PII, or external trust boundary is involved.

### Side Effects
- **DROP TABLE transient removal**: The V31 migration drops and recreates `worktrees`. If the migration fails after `DROP` but before `CREATE`, the table is temporarily gone. The `BEGIN...COMMIT` block mitigates this; on error, `ROLLBACK` restores the transaction. sql.js in-memory databases do not survive process crashes regardless, so this is consistent with existing migration behavior.
- **Fresh install**: SCHEMA_SQL is applied directly. After this fix, fresh installs use `epic_id TEXT` from the start and require no migration.

### Dependencies & Conflicts
- **Requires Part 4 complete.** Part 4 introduced `worktrees.epic_id` in V30 and the first consumers of `getWorktrees()`. This plan fixes the V30 schema error.
- **No Worktrees Exist**: V31 migration runs, drops and recreates the empty table. No user impact.
- **Worktrees Exist With `epic_id = 0` or `NULL`**: After migration, these rows have `epic_id = NULL`. They remain unlinked to any epic — same effective state as before.
- **Worktrees Exist With a Correctly Stored `epic_id`**: Not possible with the V30 schema: any non-numeric `plan_id` was coerced to `0`. Numeric `plan_id` values are theoretically possible but plans do not use numeric IDs. Treat all existing `epic_id` values as unrecoverable; restore as `NULL`.

## Dependencies

**Requires Part 4 complete.** Part 4 introduced `worktrees.epic_id` in V30 and the first consumers of `getWorktrees()`. This plan fixes the V30 schema error.

## Adversarial Synthesis

Key risks: (1) V31 migration and SCHEMA_SQL must change atomically or one install class remains broken; (2) existing epic_id values are unrecoverable but harmless; (3) defensive `String()` wrappers in `KanbanProvider` are redundant because `getWorktrees()` already normalizes `epic_id` to `string | null`, yet they add safety against future drift. Mitigations: apply both schema changes in a single commit; the migration intentionally omits `epic_id` from the `SELECT` to avoid propagating coerced zeros; verify `getWorktrees()` return type after the schema change.

## Proposed Changes

### `src/services/KanbanDatabase.ts`

**Context:** The base schema and the V30 migration both incorrectly define `worktrees.epic_id` as `INTEGER REFERENCES plans(id)`. `plans` has no `id` column; its primary key is `plan_id TEXT`. This causes SQLite to silently coerce every non-numeric `plan_id` to `0`, breaking all epic-linked worktree lookups.

**Step 1 — Fix SCHEMA_SQL** (the base table definition used for fresh installs):

Change the `worktrees` table definition in `SCHEMA_SQL` (`src/services/KanbanDatabase.ts:155`):

```sql
-- Before
epic_id     INTEGER REFERENCES plans(id) ON DELETE SET NULL,

-- After
epic_id     TEXT,
```

**Step 2 — Add V31 migration** (after the V30 block in `_runMigrations()`, around `src/services/KanbanDatabase.ts:4410`):

```typescript
// V31: Fix worktrees.epic_id column type — was INTEGER (coerces non-numeric plan_id to 0),
// must be TEXT to store plans.plan_id values correctly.
const v31 = await this.getMigrationVersion();
if (v31 < 31) {
    try {
        this._db.exec('BEGIN');

        // Preserve existing rows — epic_id values are all NULL or 0 (unusable),
        // restore as NULL since the original plan_id values were never stored correctly.
        const oldRows: Array<{ id: number; branch: string; path: string; created_at: string; status: string }> = [];
        try {
            const stmt = this._db.prepare(`SELECT id, branch, path, created_at, status FROM worktrees`);
            while (stmt.step()) {
                const row = stmt.getAsObject();
                oldRows.push({
                    id: Number(row.id),
                    branch: String(row.branch || ''),
                    path: String(row.path || ''),
                    created_at: String(row.created_at || ''),
                    status: String(row.status || 'active'),
                });
            }
            stmt.free();
        } catch { /* table may not exist */ }

        this._db.exec(`DROP TABLE IF EXISTS worktrees`);
        this._db.exec(`
            CREATE TABLE IF NOT EXISTS worktrees (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                branch      TEXT NOT NULL UNIQUE,
                path        TEXT NOT NULL,
                epic_id     TEXT,
                created_at  TEXT NOT NULL DEFAULT (datetime('now')),
                status      TEXT NOT NULL DEFAULT 'active'
            );
        `);

        for (const row of oldRows) {
            this._db.run(
                `INSERT OR IGNORE INTO worktrees (id, branch, path, epic_id, created_at, status) VALUES (?, ?, ?, ?, ?, ?)`,
                [row.id, row.branch, row.path, null, row.created_at, row.status]
            );
        }

        this._db.exec('COMMIT');
        await this.setMigrationVersion(31);
        console.log('[KanbanDatabase] V31 migration completed: worktrees.epic_id changed to TEXT');
    } catch (e) {
        try { this._db.exec('ROLLBACK'); } catch { /* ignore */ }
        console.error('[KanbanDatabase] V31 migration failed:', e);
    }
}
```

### `src/services/KanbanProvider.ts`

**Context:** `_cardsToPromptPlans` builds a `worktreePathMap` keyed by `epic_id`. Because the V30 schema coerced the stored value to `0`, every lookup misses. After the schema fix, `wt.epic_id` is already normalized to `string | null` by `getWorktrees()`, but explicit `String()` calls guard against future drift.

**Step 3 — Normalize `String()` in `_cardsToPromptPlans`** (`src/services/KanbanProvider.ts`):

At line 2161, make the key type explicit:

```typescript
// Before
worktreePathMap.set(wt.epic_id, wt.path);

// After
if (wt.epic_id) {
    worktreePathMap.set(String(wt.epic_id), wt.path);
}
```

At line 2187, normalize the lookup key:

```typescript
// Before
worktreePath = worktreePathMap.get(card.epicId);

// After
worktreePath = worktreePathMap.get(String(card.epicId));
```

And at line 2210 (subtask lookup):

```typescript
// Before
const stWorktreePath = st.epicId ? worktreePathMap.get(st.epicId) : worktreePath;

// After
const stWorktreePath = st.epicId ? worktreePathMap.get(String(st.epicId)) : worktreePath;
```

## Files Changed

- `src/services/KanbanDatabase.ts` — Fix SCHEMA_SQL `worktrees` definition; add V31 migration
- `src/services/KanbanProvider.ts` — Explicit `String()` normalization in `_cardsToPromptPlans`

## Verification Plan

### Automated Tests
- Skipped per session directive. The test suite will be run separately by the user.

### Manual Verification
1. **Fresh install**: Create a worktree linked to an epic → dispatch a plan in that epic → terminal routes to worktree terminal (not default role terminal).
2. **Existing install (V30 DB)**: Migration runs without error; existing worktrees are preserved (branch/path intact, epic_id = NULL); `getWorktrees()` returns correct rows.
3. **`addWorktree` stores plan_id correctly**: After V31, insert a worktree with `epicId = "some-plan-id-string"` → `getWorktrees()` returns `epic_id: "some-plan-id-string"` (not `"0"`).
4. **`worktreePathMap` lookup succeeds**: Plan with `epicId` matching a linked worktree → `_cardsToPromptPlans` returns `worktreePath` set to the worktree path.
5. **Regression**: Plans with no linked worktree → `worktreePath` remains `undefined`; dispatch unchanged.

## Risks

- **SCHEMA_SQL and V31 must both change**: Missing either half leaves one install class broken. Change both in the same commit.
- **Row preservation SELECT must not include `epic_id`**: The old column type coerced values to integers; selecting and reinserting them would propagate bad data. The migration intentionally drops `epic_id` from the SELECT and restores all rows with `epic_id = NULL`.

---

**Recommendation:** Send to Intern
