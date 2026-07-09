# Split kanban.db into Hot (operational) + Cold (archive) Stores, with a Time-Based Board Window

## Goal

Make the extension snappy at scale and *permanently* bound the sql.js per-write cost by keeping the **hot** operational DB to the working set. Introduce a **mandatory second sql.js DB** (`kanban-archive.db`) for cold/long-term plans, and **replace the count-based Completed cap with a time/activity-based window** that also defines the hot/cold boundary. No external dependency (the cold store is sql.js, not DuckDB), no data loss (plans **move**, never delete), reversible on access.

### Core problem / background / root-cause analysis

**The board is a bounded *view* over an unbounded *store*.** Two board reads with asymmetric limits (verified in `src/services/KanbanDatabase.ts`):
- `getBoardFilteredByProject` (`:3152`) — `WHERE status='active'`, **no LIMIT**. Every pre-completed column (CREATED, PLAN REVIEWED, all CODED lanes, **CODE REVIEWED**) is loaded **in full**.
- `getCompletedPlans` (`:3221`) — `WHERE status='completed' ORDER BY updated_at DESC LIMIT ?` (default 100, `switchboard.kanban.completedLimit`, applied in `KanbanProvider._refreshBoardImpl` `:3070`).

Two consequences, both root causes of unbounded growth:

1. **The 100-cap is on the wrong axis.** It bounds only `status='completed'`. The pile that actually grows — cards parked in **CODE REVIEWED** (`status='active'`) because the user never advances them — is uncapped and fully loaded. The cap guards the already-terminal pile and ignores the live one.

2. **Even for completed plans the cap is display-only.** `LIMIT 100` bounds what the *query returns to the webview*, not what's *in the DB*. All completed rows remain in `kanban.db` and load into the sql.js WASM heap regardless. **The cap has never reduced memory** — it is purely UI.

**Why this bites at scale.** sql.js has **no incremental writes**: `_persist()` (`:7139`) calls `this._db.export()` (`:7150`) — a full-file `Uint8Array` copy — on every mutation. So per-write cost scales linearly with total DB size. Measured today: `plans` ≈ **~960 bytes/row all-in** (table + 6 indexes). At ~10,000 plans the hot DB is ~10 MB and **every card move serializes ~10 MB**. Keeping *lifetime* history in the file the extension rewrites on every keystroke is the structural flaw.

**The fix** aligns "what's resident" with "what's the working set": a hot DB holding active work + recent history, and a cold DB (mandatory sql.js, opened on demand, written rarely) holding everything dormant. The cold store being sql.js — not DuckDB — means it works for **all ~4,000 installs with no CLI dependency**; DuckDB drops to an optional analytics layer that is never load-bearing.

**Relationship to the crash hotfix.** This plan builds on and **supersedes the scaling concern** in `fix_kanban_db_wasm_memory_exhaustion.md` (Workstreams A eviction / B coalescing / C telemetry-GC / D probe removal). It does **not** replace that hotfix — it composes with it: eviction still evicts idle *hot* DBs; coalescing still applies (and matters less once the hot DB is small); telemetry GC can move to the cold DB. **Land the hotfix first**; this is Phase 2.

## Metadata
- **Tags:** infrastructure, reliability, performance, database, refactor
- **Complexity:** 8
- **Primary files:** `src/services/KanbanDatabase.ts` (cold store + read routing) and `src/services/KanbanProvider.ts` (board window). Single-repo workspace.

## User Review Required

1. **Hot/cold boundary predicate.** Proposed: **activity-based and status-agnostic** — a plan is *hot* if `updated_at` is within **N days** (default **45**) **OR** it is genuinely in-flight (has an active worktree / is dispatched); otherwise it is eligible to move *cold*. **Reversible:** any read/edit/move of a cold plan restores it to hot. This directly fixes the CODE-REVIEWED pileup (a dormant card goes cold regardless of column/status) without hiding real WIP (recent or in-flight work is pinned hot; a "show older →" affordance pages cold rows in on demand). **Confirm N (45d) and the in-flight pin.** Alternative considered and rejected: cold-store only terminal statuses — rejected because a user who never completes cards keeps everything `active` and the hot DB never shrinks (exactly the reported case).
2. **Migration strategy for the one-time split.** Proposed: on the upgrade that introduces the cold DB, run a resumable one-time partition — for each workspace, copy cold-eligible rows to `kanban-archive.db`, verify, then delete from hot; crash-safe ordering (write-cold → verify → delete-hot) so an interruption can only leave a row transiently in *both* (reconciled on next read, hot wins), never in neither. **Confirm** the write-then-delete ordering and the 45d cutoff for the initial partition.
3. **DuckDB's role.** Proposed: **leave DuckDB untouched** — it stays an optional analytics mirror layered *above* the cold sql.js store. The mandatory cold store is the system of record for history; DuckDB is orthogonal. **Confirm no DuckDB changes in this plan.**
4. **Feature-cohesion grain.** A feature with mixed-age subtasks must not straddle stores. Proposed: cohesion is enforced **at the feature grain** — while a feature is non-terminal it (and all its subtasks) stays hot; once the feature itself is closed/dormant, the whole set moves cold **as a unit even if one subtask was touched recently**, so a single fidgety subtask can't pin an entire closed feature hot forever. **Confirm** move-on-feature-close vs. keep-hot-until-every-subtask-dormant (recommend the former).

## Complexity Audit

### Routine
- Reuse `KanbanDatabase` for the cold store — it is already multi-instance keyed by DB path (`_instancesByDbPath` `:780`, `new KanbanDatabase(stable, resolvedDbPath)` `:935`). The cold DB is another instance pointed at `kanban-archive.db`; no new engine, no new persistence code.
- Replace/augment the count cap: keep `switchboard.kanban.completedLimit` as a hard display ceiling but drive board membership from the new time window setting (`switchboard.kanban.hotWindowDays`, default 45).
- Cold DB schema = the `plans` (+ `plan_events`/`activity_log` if telemetry GC relocates) subset; reuse existing DDL.

### Complex / Risky
- **Cross-store read routing.** Many public readers assume one DB: `getBoard`/`getBoardFiltered`/`getBoardFilteredByProject` (hot-only — the win), `getCompletedPlans*` (hot-recent + paged cold), `getPlansByColumn`, `hasPlan`/`hasPlanByPlanFile`/`hasActivePlans`, `getPlanBySessionId`/`getPlanFile*`, and the DISTINCT `project`/`workspace_name` queries (`:1596`, `:2980`) which must union both stores or they under-report. Each needs an explicit hot-only / cold-only / union decision, and **every union reader must go through one shared helper** — not hand-rolled per call-site — so a future reader can't silently forget the cold store.
- **Project-enumeration is a data-loss trap.** The "projects with no plans" query (`:2980`/`:2994`, `NOT IN (SELECT DISTINCT project FROM plans …)`) drives the board's *delete-empty-project* affordance. If it reads hot-only, a project whose plans all went cold reads as empty and the board offers to **delete a project that still has cold plans**. This query MUST union both stores (or the delete path must re-check cold before deleting). Highest-severity routing case.
- **Single-home invariant + move atomicity.** A plan must live in exactly one store (unlike the DuckDB *copy*). Two sql.js files cannot share a transaction, so moves use write-cold → verify → delete-hot (and reopen: write-hot → verify → delete-cold). A crash mid-move can leave a row in both → dedup-on-read (hot wins) + a lightweight reconciliation sweep on activation.
- **Feature/subtask cohesion.** A feature and its subtasks (`feature_id`, `is_feature`) must not straddle stores. Enforce cohesion **at the feature grain** (see User Review 4): while a feature is non-terminal, it and its subtasks stay hot; on feature-close the whole set moves cold as a unit — so a single recently-touched subtask cannot pin a closed feature (and its back-catalogue) hot indefinitely. The cohesion check runs per partition sweep, so it must be a single grouped query, not per-row lookups.
- **Project JOIN self-sufficiency.** `getBoardFilteredByProject` LEFT JOINs the `projects` table (which lives in hot). Cold plans must carry the denormalized `project` name (already a TEXT column) so cold reads don't need the hot `projects` table; `project_id` FK is hot-only.
- **Worktree pin.** A plan with an active row in `worktrees` must stay hot regardless of age.
- **Migration on ~4,000 installs.** Shipped-state rule: preserve every row. Use a **new** migration/one-time task keyed in `migration_meta` — do **not** edit any frozen `MIGRATION_Vnn_SQL` body (that has corrupted historical migrations before). Idempotent + resumable.

## Edge-Case & Dependency Audit

- **Race Conditions:**
  - *Move vs. concurrent read/write of the same plan* — serialize moves through the hot instance's write chain (`_writeTail`); a read arriving mid-move must resolve via dedup-on-read (hot wins) so it never sees a half-moved plan.
  - *Crash mid-move* — write-cold-then-delete-hot ordering guarantees no data loss; reconciliation sweep removes the stale cold duplicate (or completes the delete) on next activation.
  - *Reopen (cold→hot) vs. board refresh* — the restore must complete (or be in-flight-visible) before the refreshed board queries hot.
  - *Reconciliation timing* — `reconcileHotCold()` must run (and settle) **before the first board read** on activation, not lazily, so no reader ever observes a transient double-home that a later reconcile would have healed.
- **Security:** none. Cold DB is local, same trust boundary. No new external surface.
- **Side Effects:**
  - "Show older" Completed history now pages from the cold DB (one-time open cost on demand).
  - Search/reporting that must be exhaustive now unions two stores; callers that only care about active work stay hot-only (faster).
  - Board renders fewer cards by default (dormant folded to cold) — a UX change; provide the show-older affordance and document it.
  - **Project deletion safety:** the delete-empty-project path must treat a project with cold-only plans as non-empty (see routing trap above) — never delete a project that still owns cold plans.
- **Dependencies & Conflicts:**
  - **Depends on `fix_kanban_db_wasm_memory_exhaustion.md`** (the A/B/C/D hotfix) landing first — this plan assumes eviction + coalescing exist and composes with them; the cold instance is subject to the same eviction/flush discipline.
  - Migration rule (CLAUDE.md): move-not-delete; preserve all rows; new migration key, never edit frozen `MIGRATION_Vnn_SQL`.
  - Interacts with AutoArchive: its "move to COMPLETED" becomes the natural trigger to also move a plan cold once dormant (but AutoArchive stays off-by-default and is not required by this plan).

## Dependencies
- `sess_kanban_wasm_hotfix — fix_kanban_db_wasm_memory_exhaustion.md` (A/B/C/D). This plan is **Phase 2** and should land after it; it reuses that plan's eviction/flush machinery for the cold instance.

## Adversarial Synthesis

**Risk Summary:** The dangerous failure modes are (1) a plan lost or duplicated across two non-transactional sql.js files during a move/reopen, and (2) an exhaustive reader (search, project/workspace enumeration) silently under-reporting because it forgot the cold store. Mitigations: strict single-home with write-then-delete ordering, dedup-on-read (hot wins) plus an activation reconciliation sweep, feature-unit cohesion so subtasks never straddle stores, and an explicit routing decision recorded for every `plans` reader with a test that a cold-only plan is still found by search/`hasPlan`. Land after the crash hotfix, behind a migration flag, with the initial partition resumable and reversible.

## Proposed Changes

> **Anchor note (verified during improve-feature pass, 2026-07-09).** Line numbers below were authored against an earlier revision; `KanbanDatabase.ts` is now **7,885 lines** and anchors have drifted. **Grep the named symbol, not the line.** Verified current anchors — `KanbanDatabase.ts`: `_instancesByDbPath` **:780**, private ctor **:1303**, `new KanbanDatabase(stable, resolvedDbPath)` **:935**; `getBoardFilteredByProject` **:3184**; `getCompletedPlans` **:3253**; `_persist()` **:7179**, `this._db.export()` **:7190**; the empty-project enumeration `NOT IN (SELECT DISTINCT project FROM plans …)` at **:3012** and **:3026** (the data-loss trap); `SELECT DISTINCT workspace_name FROM plans` **:1596**. `KanbanProvider.ts`: `completedLimit` read+clamped **:3086–:3087** inside `_refreshBoardImpl` **:3081**; board reads `getBoardFilteredByProject` **:3151** / `getCompletedPlans` **:3182**.

### `src/services/KanbanDatabase.ts` — cold store as a second instance
- **Context:** class is already per-path (`_instancesByDbPath` `:780`; private ctor `:1303`); `getInstance` keys by workspace root today.
- **Logic:** add a sibling accessor (e.g. `getArchiveInstance(workspaceRoot)`) returning a `KanbanDatabase` bound to `<ws>/.switchboard/kanban-archive.db`, sharing all persistence/eviction machinery. Cold schema = `plans` (+ optionally the telemetry tables if GC relocates there). The hot instance gains `archiveToCold(planId)` / `restoreToHot(planId)` implementing the safe write→verify→delete move across the two instances.
  - **Telemetry-GC handoff (reconciled with `fix_kanban_db_wasm_memory_exhaustion.md` Workstream C):** the Phase-1 hotfix intentionally writes `purgeOldPlanEvents`/`cleanupActivityLog` with row *selection* separated from the *sink*. This plan's opportunity is to swap that sink from "delete aged telemetry from the single DB" to "relocate aged telemetry into the cold store" — reusing the same age/min-per-plan selection and its tests unchanged. If you take that option, add `plan_events`/`activity_log` to the cold schema; if not, telemetry GC stays a hot-only delete and this is a no-op. Either way, do not re-implement the selection logic.
- **Edge Cases:** single-home invariant; feature-unit moves; worktree/in-flight pin; `reconcileHotCold()` runs and **settles before the first board read** on activation (not lazily).
- **Do not over-engineer the cold write path.** The cold store inherits sql.js's whole-file-rewrite, but it is written rarely (only on move), so the frequent-write concern does not apply to it.
  - **Engine decision (2026-07-09): sql.js is the mandatory engine for both stores; `node:sqlite` is decided against.** Although `node:sqlite` (built-in Node 22.5+) would remove the WASM ceiling, MEMFS, and the whole-file `export()` loop, the extension's host matrix includes VS Code *forks* — Cursor, Google Antigravity, Devin Desktop (ex-Windsurf) — that lag the Node 22.5+ baseline **by design** (Node 22.5 only reached stock VS Code in 1.121, May 2026; Cursor's documented base is Node 20.x). There is therefore **no version-distribution re-check gating this plan** — it is justified on sql.js alone (a bounded working set helps on any engine). Still keep the cold-store write path thin: if `node:sqlite` ever became universally available it would be an *opportunistic* swap behind a runtime probe with an sql.js fallback, never a hard dependency.

### `src/services/KanbanDatabase.ts` — read routing
- **Logic:** annotate each `plans` reader with its store scope. Hot-only: `getBoard*`, `getPlansByColumn`, `hasActivePlans`. Union (hot + cold): `hasPlan`, `hasPlanByPlanFile`, `getPlanBySessionId`, `getPlanFile*`, DISTINCT `project`/`workspace_name`, **and the empty-project enumeration (`:2980`/`:2994`)**. Hot-recent + on-demand cold page: `getCompletedPlans*`. Route **all** union reads through a single `_readUnion(...)` helper (dedup, hot-wins) — never hand-rolled per call-site — so a new reader cannot silently omit the cold store.
- **Edge Cases:** union readers must dedup (hot wins) to survive a transient double-home; the delete-empty-project path must re-check cold before deleting (project with cold-only plans is **not** empty).

### `src/services/KanbanProvider.ts` — time-based board window
- **Context:** completed cap applied at `:3070`/`:3166`; active rows from `getBoardFilteredByProject` `:3166` region.
- **Logic:** replace count-driven membership with the `hotWindowDays` predicate. The board renders hot rows (active + recent terminal); the Completed column shows recent from hot with a "show older →" control that pages cold. Keep `completedLimit` as a final display ceiling only.
- **Edge Cases:** empty cold DB; workspace with everything recent (cold DB stays empty — fine).

### One-time migration / partition
- **Logic:** new `migration_meta` key gates a resumable partition: per workspace, select cold-eligible rows (dormant > `hotWindowDays`, not in-flight, feature-cohesive), copy to `kanban-archive.db`, verify counts, delete from hot. Idempotent; safe to resume. Never edit frozen `MIGRATION_Vnn_SQL`.
- **Edge Cases:** interrupted partition (reconcile on next run); huge existing DBs (batch the copy; hold the write chain per batch). **Crash-during-partition under memory pressure** is the worst case (the very condition this addresses may kill the process mid-migration): each batch commits write-cold → verify → delete-hot atomically, so a kill between batches leaves earlier batches done, the current one at worst double-homed, and the rest untouched — resumable with zero row loss (asserted by the die-mid-partition test).

## Verification Plan

> `dist/` is not the test surface (installed VSIX is); treat `src/` as source of truth. Compile/tests may be skipped as planning-pass steps — the below are the coder's acceptance criteria.

### Automated Tests
- **Move integrity:** `archiveToCold` then assert the plan is in cold, absent from hot, and found by `hasPlan`/search; `restoreToHot` reverses it. Simulate a crash between write-cold and delete-hot; assert reconciliation converges to single-home (hot wins) with no data loss.
- **Routing:** a cold-only plan is invisible to `getBoardFilteredByProject` but visible to `hasPlan`, `getPlanBySessionId`, search, and DISTINCT project/workspace enumeration. `getCompletedPlans` returns hot-recent; the cold page returns older.
- **Project-deletion safety (highest severity):** a project whose plans are **all cold** must NOT appear in the empty-project enumeration and must NOT be offered for deletion; deleting it and confirming the cold plans survive. Also verify a new union reader added without the shared helper fails a lint/guard (or at least the test that asserts the enumeration unions cold).
- **Feature cohesion:** a feature with one dormant + one recent subtask stays wholly hot; a fully-dormant feature moves as a unit.
- **Window:** with `hotWindowDays=45`, a 46-day-idle CODE-REVIEWED card becomes cold-eligible; touching it restores it hot. An in-flight (worktree) card of any age stays hot.
- **Migration:** seed a single legacy `kanban.db` with mixed ages; run the partition; assert row-count conservation (hot+cold == original), idempotency on re-run, and resumability after a mid-run abort.
- **Die-mid-partition:** abort the process between batches (simulating the memory-pressure kill this plan addresses); on restart assert reconciliation completes, hot+cold == original with no row loss and no double-home survivors, and the board's first read is correct.
- **Reconcile-before-read:** with a seeded transient double-home, assert the first board read after activation already reflects the reconciled (hot-wins, single-home) state.

### Manual (the real acceptance gate)
- On the 4.8 MB switchboard board: after migration, confirm the hot DB shrinks to the working set, per-write serialize size drops correspondingly, and the board is snappier; "show older" pages cold completed plans on demand; reopening a cold card returns it to the active board.

---
**Recommendation:** Complexity 8 → **Send to Lead Coder.** Architecture change with a data-migration on a large install base and cross-store read routing — genuinely Complex/Risky, so it must land **after** the `fix_kanban_db_wasm_memory_exhaustion.md` hotfix and behind a resumable, reversible migration. The payoff is structural: the hot DB is bounded by working set forever, per-write cost stops scaling with lifetime plan count, the "10k plans" question disappears, and it removes DuckDB from the critical path entirely (cold store is mandatory sql.js). Keep sql.js as the **mandatory** engine (`node:sqlite` decided against — the fork matrix lags Node 22.5 by design); keep DuckDB optional. The split is justified on sql.js alone — a bounded working set helps on any engine — so keep the cold-store write path thin, but **do not gate this plan on any engine migration**.
