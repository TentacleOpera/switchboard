# Kanban DB Backup Retention Deletes the Most Valuable Snapshot First

## Goal

Fix `KanbanDatabase.writeDbBackup`'s retention so it keeps the newest backups per event class instead of the alphabetically-highest reason string. Today a `bulk-change` snapshot — taken immediately before a mass mutation of the user's plan data — is always the first file deleted, regardless of age, while `pre-migration` snapshots from any point in the past survive. Also stop the mechanism writing byte-identical 5 MB copies on every DB initialization.

### Problem

`writeDbBackup(reason)` ([KanbanDatabase.ts:6532-6554](../../src/services/KanbanDatabase.ts#L6532)) names each snapshot `kanban.db.backup.${cleanReason}.${ts}`, then prunes:

```ts
const files = (await fs.promises.readdir(backupDir))
    .filter(f => f.startsWith('kanban.db.backup.'))
    .sort();
for (const old of files.slice(0, Math.max(0, files.length - 5))) {
    await fs.promises.unlink(path.join(backupDir, old)).catch(() => {});
}
```

`reason` precedes the timestamp in the filename, so a plain lexicographic `.sort()` orders by **reason first and time second**. `slice(0, length - 5)` then deletes from the **front** of that ordering — the lowest-sorting entries.

Exactly two reasons exist in the codebase:

| reason | written by | what it protects |
| :--- | :--- | :--- |
| `bulk-change` | `PlanIngestionEngine.ts:529` — fires when the plan watcher sees ≥5 plan-file events inside 2 s | the state immediately before a **mass mutation of user plan data** |
| `pre-migration` | `KanbanDatabase.ts:6557`, unconditionally at the top of `_runMigrations()` | the state before schema migrations run |

`'bulk-change' < 'pre-migration'` (b before p). **So every `bulk-change` backup sorts to the front and is deleted before any `pre-migration` backup of any age.** Concretely: with 3 `bulk-change` snapshots written seconds ago and 5 week-old `pre-migration` snapshots present, the prune deletes all three fresh `bulk-change` files and keeps all five stale `pre-migration` files.

The higher-value snapshot is the one being thrown away. A schema migration is deterministic and re-derivable from code; a bulk plan mutation is not.

**And `pre-migration` churns hard enough to guarantee the starvation.** `_writePreMigrationBackup()` is called unconditionally as the first statement of `_runMigrations()`, with **no version gate** — there is no schema-version column anywhere in `KanbanDatabase`; migrations are idempotent-by-`try/catch` and every one re-runs on every initialization. `_runMigrations()` is invoked from three places including DB init (`:1827`) and two reload paths (`:6250`, `:6345`). So **every window reload writes a fresh 5 MB `pre-migration` backup whether or not anything migrated.** Five reloads fill the entire global ring of 5, at which point any `bulk-change` snapshot is evicted at the very next prune — and, per the sort order, before anything else.

Observed on this machine, 2026-07-31:

```
.switchboard/dbbackup — 25 MB, 5 files, ALL pre-migration,
  all timestamped inside a single 25-minute window on 2026-07-30
  (18:25:27, 18:43:30, 18:43:38, 18:45:59, 18:48:49), 5.0 MB each.
  kanban.db itself is 5.0 MB.
```

Five near-identical copies of the same database, spanning 25 minutes, consuming 5× the size of the thing they protect. Zero `bulk-change` snapshots present. That is the entire retention budget spent on the least useful history, which is exactly what the two defects predict.

### Measured during review, 2026-07-31 — the snapshots are *not* byte-identical

Both statements below were verified directly on this machine and they change what the third fix has to be.

**1. Every observed snapshot is byte-distinct.** `shasum -a 256` over all 10 snapshots in the two populated backup directories returns 10 different digests:

```
.switchboard/dbbackup (this repo)            5 files × 5,222,400 B — 5 distinct SHA-256
/Users/patrickvuleta/Documents/Gitlab/.switchboard/dbbackup
                                             5 files ×   827,392 B — 5 distinct SHA-256
```

Two of the Gitlab pairs are 7 s and 8 s apart (`18:25:20` / `18:25:27`, `18:43:30` / `18:43:38`) and still differ, so something writes to the DB within seconds of every initialization — plausibly the config-table/state mirroring that runs at startup. Identical *sizes* (page-aligned) made the files look like duplicates; they are not.

**2. `sql.js`'s `export()` is byte-stable, so content comparison is sound when it does apply.** Round-tripping the live 5,222,400-byte `kanban.db` through the bundled `sql.js` (`node_modules/sql.js/dist/sql-wasm.js`): `new SQL.Database(bytes).export()` returns a buffer **byte-equal to the source file**; a second `export()` from the same handle, an `export()` after a `SELECT`, an `export()` after a zero-row `UPDATE` of the exact shape `_runMigrations` runs (`UPDATE plans SET status='completed' WHERE status='active' AND kanban_column='COMPLETED'`), and an `export()` from a second fresh load are all byte-identical to the first. So SQLite header counters do **not** drift on open, read, or no-op write — a genuinely idle reload would dedupe correctly.

Together: content-dedupe is *correct*, but it would have suppressed **0 of the 10 observed snapshots**, because the database really was changing between them. Something other than hashing has to carry the churn fix.

### Root cause

1. **Sort key is the filename, and the filename leads with `reason`.** The timestamp is present and correctly formatted for lexicographic comparison (`2026-07-30T18-48-49-180Z`), but it is in the wrong position to be the primary key.
2. **Retention is a single global cap shared across reasons.** With one high-frequency reason and one low-frequency reason competing for 5 slots, the high-frequency one wins every time — independent of defect 1. Fixing the sort alone would still let five reloads evict a `bulk-change` snapshot purely on recency.
3. **No content check before writing.** `this._db.export()` is already in hand; nothing compares it against the newest existing snapshot, so a reload that changed nothing still costs 5 MB and one retention slot.
4. **(Added by review) No rate limit, and content equality does not supply one.** The write is unconditional per initialization, and per the measurement above the bytes differ every time in practice — so nothing bounds the *frequency* of `pre-migration` snapshots. Five reloads in 25 minutes cost five 5 MB writes and consume the whole budget no matter how (1)–(3) are fixed.

## Metadata

- **Complexity:** 5
- **Tags:** reliability, bugfix, database

> **Superseded:** **Complexity:** 4
> **Reason:** The review added a fourth mechanism (per-reason rate limit), a required extraction of the prune into a separately-testable private method (all ten proposed tests presuppose "run a prune", which the current inline prune cannot offer), and a corrected disk budget that has to be chosen rather than copied. Still one file and one method's worth of behaviour, but it is now four interacting policies against shipped on-disk state across ~4,000 installs, not one sort fix.
> **Replaced with:** **Complexity:** 5 → Send to Coder (routing unchanged).

## User Review Required

None.

## Complexity Audit

### Routine

- One method, ~20 lines, in one file. No callers change — `writeDbBackup(reason)`'s signature and contract are untouched.
- The timestamp format already in use is unambiguous and parseable; nothing about naming needs to change for the fix to work.
- Both call sites keep passing the same two reason strings.
- `crypto` is already imported at the top of `KanbanDatabase.ts` (`:2`), so the hash needs no new import and no webpack consideration.

### Complex / Risky

- **Shipped state: existing backup files must stay prunable.** ~4,000 installs have `dbbackup/` directories full of `kanban.db.backup.<reason>.<ts>` files. If the new pruner recognises only a new filename layout, every pre-existing file becomes permanently un-prunable and each install's backup directory grows without bound — turning a retention bug into a disk leak. The fix must therefore be **format-agnostic**, which is also the reason this plan does *not* rename the files.
- **Retention change alters disk consumption, and the current numbers are already large.** 5 MB per snapshot against a 5 MB database. Any per-reason scheme multiplies the cap by the number of reasons, so the cap has to be chosen against real measured sizes rather than by copying the existing `5`.
- **`writeDbBackup` is best-effort by contract** — the whole body is inside a `try/catch` that logs and swallows. New logic (timestamp parsing, hashing) must not introduce a throw that escapes it, and must not make a backup *failure* look like a backup *success* to the caller. It returns `Promise<void>` and callers ignore the result, so silence is the only channel; keep the existing `console.error`.
- **Content-dedupe interacts with the reason.** Two different reasons can legitimately want a snapshot of byte-identical state (a bulk change immediately followed by a reload). Dedupe must be scoped **per reason**, or a `bulk-change` snapshot will be suppressed because an identical `pre-migration` one already exists — reintroducing the exact loss this plan fixes, by a different route.
- **Dedupe state cannot live in memory.** The churn this plan targets happens *across* process lifetimes — one `pre-migration` snapshot per window reload, each in a fresh extension host. An in-memory `lastHashByReason` map would be empty on every init and would dedupe nothing. The comparison must read from disk (or be replaced by the timestamp-based rate limit, which reads only filenames).
- **The rate limit trades snapshot freshness for bounded disk, and that is a judgement call.** Skipping a `pre-migration` snapshot because a 10-minute-old one exists means that, if the next migration does destroy data, the restore point is up to 10 minutes stale. This is deliberate and must be documented at the constant; the alternative (a snapshot per init forever) is what produced 25 MB of near-duplicates in 25 minutes.
- **`writeDbBackup` is `public`** and awaited on the init path (`_runMigrations` `:6563`, reached from init `:1827` and both reload paths `:6250`/`:6345`). Any added I/O lands on DB startup latency, and any future caller inherits the new throttle defaults — so unknown reasons must default to *no* throttle.

## Edge-Case & Dependency Audit

### Race Conditions

- **Two workspaces, one shared DB.** `KanbanDatabase.forWorkspace()` plus the db-pointer redirection means two open folders can resolve the same control plane. Both can prune concurrently and both can try to unlink the same file; the existing per-unlink `.catch(() => {})` already makes a double-unlink a non-event and must be preserved.
- **Same-millisecond collision.** Two snapshots for the same reason inside one millisecond produce the same filename and the second overwrites the first. Harmless (near-identical content), and already true today — do not add a disambiguator, it would only complicate the timestamp parse.
- **Prune racing a write.** A snapshot written between another process's `readdir` and its `unlink` loop is simply not considered for that pass. Self-correcting on the next write.
- **Dedupe read racing a prune.** The dedupe step reads the newest existing snapshot for the reason; a concurrent prune may delete it mid-read. Treat a read failure as "no match" and write the snapshot — failing toward *more* backups is the safe direction.
- **Rate-limit check racing a write.** Two initializations seconds apart (observed: 7 s in the Gitlab workspace) can both see no recent snapshot and both write. The window is a `readdir`-wide race with no locking; the outcome is one extra snapshot, which the per-reason cap then prunes. Do not add locking for this.
- **Clock skew / backwards time.** The rate limit compares a parsed filename timestamp against `Date.now()`. A snapshot stamped in the future (clock adjustment, restored backup directory) would suppress writes until real time catches up. Guard by treating a negative age as "no recent snapshot" — again failing toward more backups.

### Security

- No change to file modes or locations. Snapshots stay inside the workspace's existing `.switchboard/dbbackup/`.
- The DB may contain plan text and ticket content. This plan does not change what is written or where, only how many copies persist — and it strictly reduces the count in the observed case.
- Path safety is already handled: `reason` is sanitised via `replace(/[^a-zA-Z0-9_-]/g, '_')` before it reaches the filename, so no reason string can inject a separator. Preserve that, and apply the same sanitisation when grouping by reason so a crafted reason cannot create a group that escapes the cap.
- The timestamp regex must not be spoofable by a reason string. Sanitised reasons may legitimately contain digits and dashes, so an unanchored "first match wins" regex could pick a timestamp-shaped substring *out of the reason* and mis-group the file. Anchor the match to the end of the filename, with the unanchored form only as a fallback.

### Side Effects

> **Superseded:** "**Disk goes down, not up, in the observed case.** Today: 5 × 5 MB = 25 MB, all one reason. Under the proposed 3-per-reason cap with dedupe, the same workload yields 1 `pre-migration` (repeated reloads dedupe to one while the DB is unchanged) plus up to 3 `bulk-change` — materially less than 25 MB while finally retaining the snapshot class that matters."
> **Reason:** Measured and false. All five observed `pre-migration` snapshots are byte-distinct (10 of 10 across two workspaces), so dedupe suppresses none of them and the observed workload yields **3** `pre-migration` files at the cap, not 1. With `bulk-change` also at its cap the footprint is 3 × 5 MB + 3 × 5 MB = **30 MB — more than the 25 MB the plan set out to reduce.** The arithmetic was derived from an assumption about the files rather than from the files.
> **Replaced with:** **Disk is bounded, and only goes down once the rate limit is in place.** Retention alone changes the ceiling from `5 × db-size` (one reason) to `cap × reasons × db-size`; at `cap = 3` that is 30 MB against today's 25 MB, so the cap must be chosen deliberately. Recommended: **`cap = 2` per reason** — worst case 4 × 5 MB = 20 MB, below today's 25 MB, while guaranteeing a `bulk-change` snapshot can never be starved. The observed workload then settles at 2 `pre-migration` files (10 MB) plus whatever `bulk-change` history exists, and the rate limit (fix (d)) is what collapses "5 reloads in 25 minutes" from 5 writes to 1.

- **A third reason would cost `cap` × db-size.** Only two exist. Note it at the retention constant so whoever adds a third makes the disk decision deliberately.
- **Write amplification, not just footprint.** Today every window reload writes 5 MB on the DB-init critical path. Retention caps how much *persists*; only the rate limit stops the repeated *writing*. That is the difference between a tidy directory and a mechanism that stops costing anything.
- `.gitignore` already covers this territory (see `.switchboard/plans/gitignore-rules-audit.md`, which inventories the `kanban.db` backup/temp zoo) — no ignore changes needed.
- Legacy files are pruned by the new logic rather than orphaned, so most installs will see a one-time *drop* in `dbbackup/` size on first run after upgrade. That is intended; it is the retention policy finally being applied correctly.
- **Init latency.** A content check that reads back a 5 MB snapshot adds a 5 MB read plus two SHA-256 passes to DB startup. The rate limit costs a `readdir` and no reads at all, and short-circuits the content check entirely on throttled inits — so ordering the checks (rate limit first) matters for latency, not just for logic.

### Dependencies & Conflicts

- Independent of the three plans in the **Integration Config Durability** feature. Different file (`kanban.db` vs `integration-config.json`), different service. It shares one design lesson with that feature's backup plan — retention keyed on the wrong thing is worse than no retention, because it presents as protection — but there is no code overlap and no ordering constraint.
- No new dependencies. `fs`, `path`, and `crypto` only — and all three are already imported at the top of `KanbanDatabase.ts` (`:1-5`).
- `sql.js`'s `export()` determinism is load-bearing for fix (c) and is verified for the bundled version (see the measurement above). If a future `sql.js` upgrade made `export()` non-deterministic, (c) would silently stop matching and write more snapshots — a safe-direction failure that the cap and the rate limit still contain.

## Dependencies

None.

**Migration:** none required, and deliberately so. Existing `kanban.db.backup.<reason>.<ts>` files are **not** renamed. The pruner is made format-agnostic (parse the ISO timestamp out of the filename wherever it sits; fall back to `mtime` when absent), so every legacy file remains both recognised and prunable. Renaming shipped backup files would be a pointless write of ~25 MB per install and would risk orphaning anything the rename missed.

## Adversarial Synthesis

**Risk summary.** The fix is small but has three traps that would each convert a retention bug into something worse. First, changing the filename layout to make lexicographic sorting correct would strand every pre-existing backup outside the pruner's filter and turn a bounded ring into an unbounded disk leak across ~4,000 installs — so the pruner is made format-agnostic and nothing is renamed. Second, scoping content-dedupe globally rather than per reason would suppress a `bulk-change` snapshot because an identical `pre-migration` one exists, losing the exact file this plan exists to protect. Third — and only visible once measured — content-dedupe does not actually fix the churn it was assigned: all 10 observed snapshots are byte-distinct, so the promised "5 reloads collapse to 1 file" needs a per-reason rate limit, and a 3-per-reason cap without it would raise the worst-case footprint from 25 MB to 30 MB. Residual accepted risks: the rate limit means a `pre-migration` restore point can be up to one throttle interval stale, and per-reason retention multiplies the disk cap by the number of reasons — which is why the cap is set to 2 against measured 5 MB snapshots and annotated at the constant.

## Proposed Changes

### `src/services/KanbanDatabase.ts` — `writeDbBackup` (`:6532-6554`)

**Context.** Best-effort snapshot writer, called with one of two reasons, whose prune step currently sorts by filename and deletes from the front. Signature and caller contract stay exactly as they are. It is `await`ed on the DB-init path via `_writePreMigrationBackup()` → `_runMigrations()` (`:6556-6563`), so added I/O is startup latency.

**Logic.**

**(a) Sort by parsed timestamp, not by filename.** Extract the timestamp with a regex that finds it wherever it appears in the name — `/(\d{4}-\d{2}-\d{2}T[\d-]+Z)/` matches the existing `2026-07-30T18-48-49-180Z` shape. Sort descending by that value; fall back to `fs.stat().mtimeMs` for any file the regex does not match. This is the format-agnostic property that keeps legacy files prunable and makes renaming unnecessary.

> **Superseded:** an unanchored `/(\d{4}-\d{2}-\d{2}T[\d-]+Z)/` as the sole matcher.
> **Reason:** `cleanReason` is only sanitised to `[a-zA-Z0-9_-]`, so a reason may itself contain digits and dashes. An unanchored first-match regex could lift a timestamp-shaped substring out of the *reason* segment, mis-deriving both the sort key and the grouping key for that file.
> **Replaced with:** Match the trailing segment first — `/\.(\d{4}-\d{2}-\d{2}T[\d-]+Z)$/` — and only fall back to the unanchored form (then to `mtime`) if that fails. Derive the reason group as the substring between the `kanban.db.backup.` prefix and the matched timestamp, so key and group are extracted from the same parse and cannot diverge.

**(b) Retain per reason, not globally.** Group the matched files by their sanitised reason and keep the newest **2** of each group, deleting the rest. This is the fix for the starvation, and it is independent of (a): correcting the sort alone would still let five reloads evict a `bulk-change` snapshot on pure recency. Define the cap as a named constant with a comment recording the disk arithmetic — 2 per reason × 2 reasons × ~5 MB ≈ 20 MB worst case (below today's observed 25 MB), and a third reason costs another ~10 MB.

> **Superseded:** "keep the newest **3** of each group […] 3 per reason × 2 reasons × ~5 MB ≈ 30 MB worst case".
> **Reason:** 30 MB is *more* than the 25 MB this plan is fixing. The 3 was only tolerable under the (now measured as false) assumption that dedupe would collapse `pre-migration` to a single file.
> **Replaced with:** cap = 2 per reason — 20 MB worst case, strictly below today's footprint, and still enough to hold both the current and the previous state of each event class.

**(c) Skip byte-identical snapshots, scoped per reason.** Before writing, hash the `this._db.export()` buffer already in hand and compare it against the newest existing snapshot **for the same reason**; if equal, log and return without writing. Scope is load-bearing: a global comparison would suppress a `bulk-change` snapshot whenever an identical `pre-migration` one existed, which is this plan's own bug wearing a different hat.

> **Superseded:** "This kills the repeated-reload churn that produced five identical 5 MB copies in 25 minutes."
> **Reason:** Measured: the five files are byte-*distinct* (10 distinct digests across 10 files in two workspaces), including pairs written 7–8 s apart. The database genuinely changes between initializations, so this check would have fired zero times on the reported evidence. `export()` *is* byte-stable for an unchanged DB (verified by round-trip), so the check is correct and worth keeping — it just protects a narrower case than claimed: a genuinely idle reload with no intervening write.
> **Replaced with:** Keep (c) as a cheap correctness win for the idle-reload case, and **stop assigning it the churn fix** — that is (d). Order the checks so (d) runs first, since a throttled write skips (c)'s read entirely. Add a size pre-check: compare `fs.stat(newest).size` against `data.length` and only read+hash on a match, so a genuine change costs one `stat` instead of a 5 MB read.

> **Superseded:** "Hashing a 5 MB buffer is sub-10 ms and happens on a path that is already writing 5 MB to disk; no measurable cost."
> **Reason:** The hash is not the cost — the *read-back* is. Comparing against the newest snapshot means reading 5 MB from disk and hashing **two** buffers, on the awaited DB-init path. The in-memory alternative does not exist: the churn spans process lifetimes, so a `lastHashByReason` field would be empty on every init and dedupe nothing.
> **Replaced with:** Cost is one `stat` in the common (changed) case thanks to the size pre-check, and one 5 MB read + two hashes only when sizes match — against the 5 MB write it avoids. The rate limit (d) removes even that on throttled inits.

**(d) Rate-limit per reason (added by review).** Before doing anything else, `readdir` the backup directory, find the newest snapshot **for this reason** using (a)'s parse, and skip the write entirely if it is younger than that reason's minimum interval. Define the intervals as a named map with the default for unknown reasons being **0 (no throttle)** — failing toward more backups:

- `pre-migration`: **30 minutes.** This is the mechanism that turns "5 reloads in 25 minutes → 5 files" into 1, and it is the only one of the four fixes that reduces *writes* rather than just retained copies.
- `bulk-change`: **0.** Never throttle it. A bulk change two minutes after another bulk change is precisely the state most worth capturing; throttling it would reintroduce this plan's own bug from a third direction.

Log the skip at the same level as the other best-effort messages so the behaviour is visible in the output channel rather than silent.

**(e) Extract the prune into `private async _pruneDbBackups(backupDir: string): Promise<void>` (added by review).** All of the automated tests below are "seed a directory, run a prune, assert survivors"; with the prune inline in `writeDbBackup`, every one of them would have to write a real snapshot first, perturbing the very file set under test. Extract it, call it from `writeDbBackup` exactly where the current prune sits, and keep it `private` — the tests reach it by index access (`db['_pruneDbBackups']`), which is the established pattern for testing private members from the JS test files.

**Implementation.** Keep the entire body inside the existing `try { … } catch (e) { console.error(…) }`. Reuse the existing `reason.replace(/[^a-zA-Z0-9_-]/g, '_')` sanitisation for both the filename and the grouping key so they cannot diverge. Keep the per-unlink `.catch(() => {})`. Retain the `f.startsWith('kanban.db.backup.')` filter so unrelated files in the directory are never touched. Order the body: `mkdir` → (d) rate-limit check → `export()` → (c) size/hash check → `writeFile` → `_pruneDbBackups`. Note that `export()` must happen before (c) but after (d), so a throttled init never pays for the export.

**Edge cases.**
- A file matching the prefix but carrying no parseable timestamp *and* failing `stat` sorts last (treated as oldest) and is pruned first — correct, it is unidentifiable.
- A reason group with fewer than `cap` files prunes nothing.
- The dedupe comparison must handle "no existing snapshot for this reason" as *not* a match, so the first snapshot of a reason always writes.
- The rate-limit check must handle the same case as "no recent snapshot" (write), and must treat a future-dated snapshot (negative age) the same way rather than throttling until the clock catches up.
- An unknown reason gets no throttle and its own retention group — a new caller can never be silently starved, and can never silently suppress its own first snapshot.
- Do not gate `_writePreMigrationBackup()` on a schema version — none exists (migrations are idempotent-by-`try/catch` and all re-run every init), and inventing one is a far larger, riskier change against shipped state. (d) addresses the churn without touching migration behaviour at all.
- **Rejected alternative — hash the schema (`SELECT sql FROM sqlite_master`) into a `config` row and skip the backup when it is unchanged.** Precise for schema drift and it would eliminate churn completely, but `_runMigrations` also performs *data* fixes (the zombie-plan `UPDATE` at `:6574`, the workspace_id consolidation at `:6582`+) that a schema-hash gate would leave unprotected. Rejected: it optimises the frequency by weakening the guarantee, while (d) weakens only freshness, by a bounded and documented amount.

## Verification Plan

### Automated Tests — new `src/test/kanban-db-backup-retention.test.js`

Follow the existing `kanban-database-*.test.js` convention: plain `node` script, `require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'))`, `fs.promises.mkdtemp` sandbox workspace, `KanbanDatabase.invalidateWorkspace(ws)` + `rm -rf` in a `finally` (see `kanban-database-mtime.test.js` for the shape).

> **Superseded:** "register the script in `package.json` with the same `--require ./src/test/bootstrap/sandboxStateHome.js` prefix as its siblings."
> **Reason:** The siblings have no `package.json` entry — `grep kanban-database package.json` returns nothing, and `.vscode-test.mjs` globs only five specific files, none of them `kanban-database-*`. The five existing `kanban-database-*.test.js` files are currently unreachable from any npm script, so "the same as its siblings" would mean not registered at all.
> **Replaced with:** Register it explicitly as `"test:contract:db-backup-retention": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/kanban-db-backup-retention.test.js"`, matching the ~30 `test:contract:*` entries that *are* registered (`package.json:777-797`). Note the prerequisite: these tests load `out/services/KanbanDatabase.js`, so they require `npm run compile-tests` (tsc → `out/`) — out of scope for this session per the skip-compilation and skip-tests directives, so the tests are authored here and run by the implementer.

1. **The reported bug, reproduced then fixed.** Seed a `dbbackup/` directory with 5 old `pre-migration` files and 3 recent `bulk-change` files, using the **current** filename layout. Call `_pruneDbBackups(dir)` directly. Assert all 3 `bulk-change` files **survive**. Against today's code this fails, deleting exactly those three — that is the regression being fixed.
2. **Newest-per-reason is what survives.** 6 `pre-migration` files spanning a week: assert the newest `cap` remain and the rest are gone. Repeat for `bulk-change`.
3. **Reasons cannot starve each other.** 20 `pre-migration` files and 1 `bulk-change` file: assert the single `bulk-change` file survives and exactly `cap` `pre-migration` files remain.
4. **Legacy files stay prunable — the migration-safety assertion.** Populate the directory with only current-layout filenames (as every shipped install has) and assert they are counted, sorted, and pruned normally. Then add one file whose name matches the prefix but contains no parseable timestamp, and assert it is treated as oldest and pruned rather than retained forever.
5. **Adversarial reason ordering.** Reason `zzz` with the *newest* timestamps and reason `aaa` with the *oldest*: assert retention is decided by time within each reason and that neither reason's whole group is sacrificed to the other. This is the direct regression test for the lexicographic sort.
6. **Content dedupe, per reason.** Call `writeDbBackup('pre-migration')` twice with no intervening DB change **and the rate limit stubbed off for the test**: assert exactly one file exists. Then call `writeDbBackup('bulk-change')` with the DB still unchanged: assert a **second** file is written — the per-reason scoping check. A global dedupe passes the first half and fails this. (This test is what pins the measured `export()` byte-stability; if it ever fails with two `pre-migration` files, `export()` determinism has regressed, not the dedupe logic.)
7. **Dedupe does not suppress a real change.** Mutate the DB between two same-reason calls (rate limit stubbed off); assert two files exist.
8. **Rate limit throttles `pre-migration` and never throttles `bulk-change`.** Seed a `pre-migration` snapshot stamped 1 minute ago, call `writeDbBackup('pre-migration')`, assert **no** new file. Seed a `bulk-change` snapshot stamped 1 second ago, call `writeDbBackup('bulk-change')`, assert a new file **is** written. Then seed a `pre-migration` snapshot stamped 45 minutes ago and assert the write proceeds. This is the direct test for the observed 5-files-in-25-minutes churn.
9. **A future-dated snapshot does not block writes.** Seed a `pre-migration` file stamped an hour in the future; assert `writeDbBackup('pre-migration')` still writes.
10. **An unknown reason is never throttled and gets its own group.** Call `writeDbBackup('some-new-reason')` twice in quick succession with the DB mutated between; assert both write and that neither displaces the other reasons' files.
11. **A reason containing digits and dashes is grouped correctly.** Write snapshots under a reason like `v2-2026-fix` and assert the trailing-timestamp anchor groups them under that reason rather than mis-parsing a timestamp out of the reason segment.
12. **Unrelated files are untouched.** Place a file not matching the prefix in `dbbackup/`; assert it survives every prune.
13. **Best-effort contract holds.** Make `dbbackup/` unwritable (or stub `writeFile` to throw); assert `writeDbBackup` resolves without throwing and logs an error.
14. **Mutation checks** — restore after each: revert (a) to a plain `.sort()` → items 1 and 5 must fail; revert (b) to the global cap of 5 → item 3 must fail; scope (c) globally instead of per reason → item 6's second half must fail; remove (d) → item 8's first assertion must fail; throttle `bulk-change` too → item 8's second assertion must fail.

### Manual

15. **Confirm the one-time cleanup on a real directory.** With the current 5 × 5 MB `pre-migration` files in `.switchboard/dbbackup/` (25 MB, verified byte-distinct), reload the window once and confirm the directory settles to `cap` `pre-migration` files or fewer, that no file with an unrecognised name was removed, and that total size drops. Repeat for `/Users/patrickvuleta/Documents/Gitlab/.switchboard/dbbackup` (5 × 827,392 B) to cover a second real workspace.
16. **Prove a `bulk-change` snapshot now survives a reload storm.** Trigger a bulk plan change (≥5 plan-file writes inside 2 s) so a `bulk-change` snapshot is written, confirm it exists, then reload the window five times. Assert the `bulk-change` file is **still present**. Under today's code it is gone after the first prune that crosses the cap. This is the whole plan, observed end-to-end.
17. **Prove the churn is gone.** During the same five reloads, assert **at most one** new `pre-migration` file appears (the rate limit), not five. Note the file count before and after. This is the check that would have caught the superseded arithmetic: content dedupe alone leaves five distinct files.
18. Confirm `du -sh .switchboard/dbbackup` is materially below 25 MB afterwards, and record the figure in the Completion Report so the disk arithmetic at the retention constant can be checked against reality.

## Recommendation

Complexity 5 → **Send to Coder.**
