# Cache plan write-sets in kanban.db so dispatch-analysis stops re-reading the whole backlog

<!-- board-collapse-01 -->
> **RESCOPED 2026-09-04 (Board Collapse 01).** Two corrections. (1) **Do not reserve a migration number.** This plan claims V61; the schema is at **V67**. Use "the next free migration version at implementation time" and delete the "if staging is dropped or reordered, renumber this to V60" instruction. (2) Its stated prerequisite `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md` was **retired and its file deleted** — `DISPATCH` became a real `STAGING` column in commit `52404992`, so `plans.staged_at` was never built. Remove the dependency and anchor on the live STAGING column.


## Goal

Persist each plan's extracted **write set** (the files it will create or modify, plus its declared plan-level dependencies) in `kanban.db`, keyed on the plan file's mtime and size, so a dispatch-analysis run reads only the plan files that actually changed since the last pass instead of re-reading every candidate from scratch.

The conflict graph is not the artifact worth keeping — the write sets are. Store nodes, recompute edges.

### Problem & background

**The pass is stateless, and it throws away the expensive half of its own work.** `.agents/skills/dispatch-analysis/SKILL.md` step 2 instructs the agent to read every candidate plan file on every run. Step 5 moves cards. Step 6 reports. Then the skill's final rule — *"One shot. Report and exit."* — discards everything.

Measured on this workspace against the live server on 2026-08-10: a Browser Switchboard pass had **14 candidates spanning 50 plan files totalling ~1.3 MB** (13 feature cards plus their 36 subtasks, plus one standalone plan). Extracting write sets from that prose is the dominant cost of the pass — the graph itself is 14 nodes and 91 pairwise set intersections, which is microseconds.

**Root cause — the invalidation key is a card move, when it should be a file edit.**

A write set is a function of the plan file's *content*. It does not change when the card moves columns, when a feature is regenerated, when a coder finishes, or when the user re-presses Analyze. It changes only when someone edits the plan.

But the pass has no memory, so its effective invalidation rule is "everything, every run." That inverts the actual dependency: the thing that changes most often (board state) triggers full recomputation of the thing that changes least often (plan contents). A feature shipping — which removes exactly one node from the graph — costs a complete 50-file re-read to discover.

This is what makes the "keep two lanes hot" workflow expensive. With a saturated conflict graph (measured 2026-08-10: 13 of 14 candidates conflicted with 11+ others, because `TaskViewerProvider.ts` appears in 12 of 14 write sets), each pass stages only 1-2 cards, so lanes free up often and the pass must run often. Every one of those runs re-derives 49 write sets it already knew.

**Why the extension cannot do the extraction.** Deciding which files a plan *writes* — as opposed to merely cites as evidence, root-cause context, or a line reference — is a judgement over prose, not a parse. The same plan text contains `KanbanProvider.ts:815` as evidence of existing behaviour and `KanbanProvider.ts` as an edit target, and only reading the surrounding argument distinguishes them. A regex sweep over a plan file yields both the write set and a pile of citations with no reliable separator. So the agent must remain the extractor; the extension owns storage and invalidation.

### Related but distinct

`feature_plan_20260810173147_dispatch-analysis-reads-the-board-mirror-not-a-full-json-board-dump.md` (`PLAN REVIEWED`) reduces the cost of reading the **board** (a full-workspace JSON dump → per-column markdown mirrors). This plan reduces the cost of reading the **plans**. They attack different halves of the same pass and neither subsumes the other: the board read is ~1 request, the plan read is 50 files.

---

## Metadata
**Complexity:** 5
**Tags:** performance, backend, database, agent-protocol
**Project:** Browser Switchboard

---

## User Review Required

**None.** Four decisions made here:

* **Store write sets, not the conflict graph.** 14 node rows, not 91 edge rows. One plan edit invalidates one row; storing edges means one plan edit invalidates up to 13 rows and the correctness of that fan-out is easy to get wrong and impossible to notice when wrong.
* **mtime + size as the cache key, not a content hash.** `KanbanDatabase._initialize` (`:6588-6592`) already uses a forward-mtime comparison (`fileMtime > previousMtime`) to detect an external/cloud write to `kanban.db`, so this is the house pattern; size catches the same-mtime edit that mtime alone misses. Hashing 1.3 MB per run to avoid reading 1.3 MB per run saves nothing.
* **The agent extracts; the extension stores and invalidates.** See "Why the extension cannot do the extraction" above.
* **A cache miss degrades to today's behaviour, never to a failure.** Missing table, empty table, stale row, unreachable endpoint — all fall back to reading the plan file. The cache is an accelerator with no correctness authority.

---

## Complexity Audit
* **Score:** 5 / 10

### Routine
* One additive `CREATE TABLE`, one migration step following the established V58/V59 shape.
* Two HTTP endpoints — one read, one upsert.
* Skill steps that fetch before reading and post after extracting.

### Complex / Risky
* **A stale write set is a silent false negative.** This is the whole risk of the plan. If the cache returns a set from before an edit that *added* a file, the pass will parallelise two plans that now collide — the exact unrecoverable failure the skill exists to prevent, except now it is invisible because the pass believes it did the work. Every ambiguous invalidation case must resolve to *miss*, not *hit*.
* **Skill-rule drift needs a global invalidation lever.** When the extraction rules in the skill change, every cached row was produced under the old rules and is wrong in a way no per-file mtime can detect. Without an `extractor_version` the cache would serve pre-change sets forever.
* **Fresh-DB and migrated-DB paths are separate and both mandatory.** Per the comment at `KanbanDatabase.ts:406` ("Additive CREATE TABLE IF NOT EXISTS; fresh DBs already get it from `SCHEMA_TABLES_SQL`"), additive tables go in `SCHEMA_TABLES_SQL` *and* in a numbered migration. Shipping only the migration leaves fresh installs without the table; shipping only the schema leaves ~4,000 existing installs without it. Note the corollary the comment does **not** state: `SCHEMA_TABLES_SQL` is not a superset of the migrated schema, so a fresh DB still runs the whole V20–V61 chain — never stamp a baseline version to skip it.
* **Two hosts, one DB.** The extension host and `npx switchboard` both open `kanban.db`. The table must be created by whichever host initialises first, and the standalone host reaches the schema through `_initialize` (`:6571`) rather than `createIfMissing()` — it never calls the latter, so a table added only on the `createIfMissing` path would be extension-only.

---

## Edge-Case & Dependency Audit

### Race Conditions
* **A plan is edited between the cache read and the card move.** The pass acted on a stale set. Bounded by taking the mtime/size snapshot at *read* time and re-verifying it immediately before the moves in step 5; a changed stamp aborts that card's promotion and names it in the report. Cheap — a `stat`, not a read.
* **Two hosts writing the same row.** `plan_id` is the primary key and the payload is derived from file content, so concurrent writers converge on the same value. Last write wins is correct here.
* **Feature file regenerated mid-pass** (`_regenerateFeatureFile` fires on cascades). This bumps the feature file's mtime without changing its write set, producing a spurious miss. Harmless: a miss costs one file read.

### Security
* None. Workspace-local derived data, no new external input, no new privilege. The stored payload is a list of repo-relative paths already present in the plan files.

### Side Effects
* `kanban.db` grows by roughly one row per plan — a JSON array of ~20 short strings. Negligible against a DB already holding 1,708 plan rows, and well clear of the sql.js WASM heap ceiling that manifests as spurious "disk I/O error".
* First run after the migration is a full extraction and populates the cache; it is no slower than today.

### Dependencies & Conflicts
> **Superseded:** "edited by this plan, by `feature_plan_20260811094500_dispatch-analysis-blind-to-already-staged-cards.md`, and by `feature_plan_20260810173147_…board-mirror…`. All three serialise on that file. This plan lands **last** of the three: the occupancy fix is a safety hole and goes first…"
> **Reason:** The occupancy plan no longer exists — `feature_plan_20260811094500_dispatch-analysis-blind-to-already-staged-cards.md` is absent from `.switchboard/plans/` at HEAD. It was superseded by `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md`, which removes the invisibility rather than working around it, and was deleted. The ordering conclusion (this plan lands last) is unchanged, but its stated first term names a plan that is gone, and the follow-on reasoning in change 3 ("after the sibling occupancy plan lands…") points at nothing.
> **Replaced with:** Three plans serialise on `.agents/skills/dispatch-analysis/SKILL.md` and this one lands **last**:
> 1. `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md` — retires the `DISPATCH` column, rewrites step 5 from a card move to a `staged_at` stamp, and takes migration **V60**.
> 2. `feature_plan_20260810173147_…board-mirror…` — rewrites step 1/1a/2's read and the Rules.
> 3. **This plan** — rewrites step 2 again into fetch-then-fill and adds the step-5 staleness re-check. Authored once against the other two's final shape rather than rebased through them.
>
> A fourth sibling (`feature_plan_20260811143000_…worktree-recommendation.md`) adds steps 4a/6a/6b to disjoint sections and does not need to serialise with these.

> **Superseded:** "`.claude/skills/dispatch-analysis/SKILL.md` is generated — edit only `.agents/`; `npm run mirror:check` is a CI gate."
> **Reason:** Wrong at HEAD. `.claude/skills/dispatch-analysis/` does not exist; `scripts/check-claude-mirror.js` walks `.claude/skills/**` and never sees this file. The instruction is harmless but it implies a gate that is not there, and it contradicts the sibling worktree plan, which states the position correctly.
> **Replaced with:** `.agents/skills/dispatch-analysis/SKILL.md` is the only copy — read by the extension **by path**, packaged via `.agents/.switchboard-bundled.json:37`, and **not** covered by `npm run mirror:check`. There is no mirror to update and no CI signal if the skill drifts, which is why this plan's contract-test assertions matter more than they would for a mirrored skill.

* **`src/services/KanbanDatabase.ts`** — `SCHEMA_TABLES_SQL` (`:170`), the migration constants (`MIGRATION_V58_SQL` `:467`, `MIGRATION_V59_SQL` `:482`) and the migration runner (`:8318-8337`). Migration head at HEAD is confirmed **V59**; `feature_plan_20260811103000_staging-flag-replaces-dispatch-column.md` takes **V60** and lands first, so this is **V61**. If that plan is dropped or reordered, renumber this one to V60 — do not leave a gap.
* **Never edit a shipped `MIGRATION_Vnn_SQL` body.** V20-V59 are historical; a rename sweep through them corrupts installed users' upgrade path. Add V61 only.
* **`src/services/LocalApiServer.ts`** — two new routes, registered in the flat `else if` ladder alongside `/worktree/cleanup` (`:3977`) and `/worktree/list` (`:4013`), and advertised in `_handleGetCatalog` (`:2760`) or fleet agents cannot see them. **`src/standalone/bootstrap.ts`** — the same routes must exist in the standalone host, or the cache silently never populates under `npx switchboard`.
* **`src/services/verbSchemas.ts`** is not involved — these are raw HTTP routes, not kanban verbs, so they take the route-handler's own body validation rather than a verb schema. Validate at the boundary regardless (PRD contract #5): `planIds` is a caller-supplied CSV and `entries[].files` a caller-supplied array.

---

## Dependencies
* No blocking plan dependencies. The migration runner, `SCHEMA_TABLES_SQL`, and the LocalApiServer routing surface all exist at HEAD.
* Serialises **behind** the two sibling skill plans on `.agents/skills/dispatch-analysis/SKILL.md` (see above).
* Migration V61 is additive-only: a new table, no `ALTER` on `plans`, no existing row touched. Rollback is dropping an unread table.

---

## Adversarial Synthesis

Key risks: (1) **a stale hit produces the unrecoverable failure the pass exists to prevent** — two coders in one file, with the pass reporting success, which is strictly worse than the current slow-but-honest behaviour and is why every ambiguous case must resolve to miss; (2) **skill-rule drift** — changing the extraction rules silently invalidates every row in a way mtime cannot see, so an `extractor_version` gate is mandatory, not a nice-to-have; (3) **storing edges instead of nodes** — 91 rows whose invalidation fan-out is easy to implement subtly wrong and impossible to spot when wrong, versus 14 rows with a one-to-one invalidation; (4) **half-shipping the schema** — a migration without the `SCHEMA_TABLES_SQL` entry breaks fresh installs, the reverse breaks ~4,000 existing ones, and each failure mode is invisible on the host you tested; (5) **extension-only routes** — omitting the standalone host means the cache never populates under `npx switchboard` while the extension host looks fixed, violating "two hosts, one engine"; (6) **over-engineering the key** — content hashing costs the read it was meant to avoid. Mitigations: mtime+size verified again immediately before the moves, with any mismatch demoting that card to a miss and naming it in the report; an `extractor_version` constant bumped in the same commit as any skill-rule change; nodes only, edges recomputed per run; both schema paths in one commit with a test per path; routes registered in both hosts; and a documented fallback to full extraction on any miss, error, or unreachable endpoint.

---

## Proposed Changes

**Build order:** (1) schema + migration → (2) read/upsert endpoints in both hosts → (3) skill rewrite of step 2 → (4) the staleness re-check before moves.

### 1. V61 — a `plan_write_sets` table

**Implementation:** add to `SCHEMA_TABLES_SQL` (`KanbanDatabase.ts:170`) *and* as `MIGRATION_V61_SQL` following the V58/V59 shape — the `CREATE TABLE` and the `CREATE INDEX` as **two separate array elements**, because the runner's `try/catch` is per statement and a combined string lets a re-run's first failure swallow the second (`MIGRATION_V13_SQL` at `:490` is the precedent):

```sql
CREATE TABLE IF NOT EXISTS plan_write_sets (
    plan_id           TEXT PRIMARY KEY,
    workspace_id      TEXT NOT NULL,
    plan_file         TEXT NOT NULL,
    source_mtime_ms   INTEGER NOT NULL,
    source_size       INTEGER NOT NULL,
    files             TEXT NOT NULL DEFAULT '[]',
    declared_deps     TEXT NOT NULL DEFAULT '[]',
    extractor_version INTEGER NOT NULL DEFAULT 1,
    extracted_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_write_sets_ws ON plan_write_sets(workspace_id);
```

Register in the runner (`:8318-8337`, immediately after the V59 block) with the existing idempotent shape:

```ts
const v61 = await this.getMigrationVersion();
if (v61 < 61) {
    for (const sql of MIGRATION_V61_SQL) {
        try { this._db.exec(sql); } catch { /* already exists */ }
    }
    await this.setMigrationVersion(61);
    console.log('[KanbanDatabase] V61 migration completed: plan_write_sets table added');
}
```

`files` and `declared_deps` are JSON arrays of repo-relative paths and plan IDs. `plan_file` is stored so a moved or renamed plan file forces a miss even when mtime and size coincide.

**Logic:** one row per plan makes invalidation one-to-one with the thing that changes. `extractor_version` is a single integer that invalidates the whole cache when the skill's extraction rules change.

**Edge cases:** a plan with a genuinely empty write set stores `'[]'`, which is a *hit* meaning "touches nothing" — distinct from a missing row, which means "unknown". Conflating the two would let an unread plan look parallel-safe with everything, and the skill's rule is that unprovable stays in Planned.

### 2. Two endpoints, registered in both hosts

**Implementation:**

* `GET /dispatch/writesets?workspaceRoot=&planIds=<csv>` — for each requested plan, `stat` its `plan_file` and compare mtime, size, path and `extractor_version` against the row. Return `{ hits: [{planId, files, declaredDeps}], misses: [{planId, planFile, reason}] }` where `reason` is one of `no-row`, `mtime-changed`, `size-changed`, `path-changed`, `extractor-version`, `stat-failed`. The server decides hit versus miss; the agent never compares stamps itself.
* `POST /dispatch/writesets` — upsert `{ workspaceRoot, entries: [{planId, planFile, files, declaredDeps}] }`. The server re-`stat`s at write time and stores the stamp it observed, so a file edited *during* extraction is stored with the newer stamp and correctly misses next run.

Register in `LocalApiServer.ts` and in the standalone host's route table (`src/standalone/bootstrap.ts`).

**Logic:** putting the comparison server-side keeps one implementation of the invalidation rule. Returning a typed `reason` per miss makes a cache that has quietly stopped hitting diagnosable rather than merely slow.

**Edge cases:** `stat-failed` (plan file missing) is a miss, and the skill's existing rule then leaves that plan in Planned. Never serve a cached set for a file that no longer exists — the row is the last thing that would reveal a deleted plan.

### 3. Skill step 2 becomes fetch-then-fill

**Implementation:** rewrite step 2 of `.agents/skills/dispatch-analysis/SKILL.md`:

1. `GET /dispatch/writesets` for every candidate **and** every occupied-lane plan.
2. For hits, use the returned `files` / `declaredDeps` directly. **Do not open the plan file.**
3. For misses, read the plan file exactly as today and extract.
4. `POST /dispatch/writesets` with the newly extracted entries before moving any cards.
5. Report the hit/miss split, and the miss reasons, in step 6.

Add a rule: *"A cache miss, an error, or an unreachable endpoint means read the plan file. The cache never decides that a plan is safe — it only saves the reading. If the endpoint is unavailable, run exactly as the uncached pass does and say so in the report."*

Also add: *"`extractor_version` must be bumped in `KanbanDatabase.ts` in the same change as any edit to the extraction rules in this step. A rules change without a bump serves stale sets indefinitely."*

**Logic:** including occupied lanes in the fetch matters — after the staging plan lands, staged plans stay in `PLAN REVIEWED` and are therefore in the candidate set on every subsequent pass, so they are read every run. They are also the plans *least* likely to have changed, which makes them the cache's best hits. "Occupied lane" after that plan means **a plan carrying a `staged_at` stamp**, not a plan sitting in a `DISPATCH` column; write step 2 with that spelling.

**Edge cases:** a partial `POST` failure is not fatal; those plans simply miss next run. Never abandon the pass because the cache write failed.

### 4. Re-verify the stamp immediately before the moves

**Implementation:** in step 5, before the first `POST /kanban/move`, re-`GET /dispatch/writesets` for the selected set only. Any plan that now reports a miss is **dropped from the dispatch set** and named in the report as `edited during analysis — not staged`.

**Logic:** this closes the read-to-move window for the case that actually matters. The whole set was chosen on the assumption these files are what the plans touch; if a plan changed under the pass, the assumption is void for that card and staging it is the unrecoverable direction. One extra request over a handful of plan IDs.

**Edge cases:** if the re-check drops every selected card, stage nothing and say why. Do not re-run selection — the pass is one-shot, and a second selection round on freshly-changed inputs is a loop the skill deliberately does not have.

---

## Verification Plan

### Automated Tests
* **Both schema paths:** a fresh DB built from `SCHEMA_TABLES_SQL` has `plan_write_sets`; a DB stamped at V60 gains it after the migration runs and reports version 61.
* **Migration idempotence:** running the V61 step twice leaves one table and version 61, no throw.
* **Hit:** an unchanged plan file returns a hit with the stored `files`; the plan file is not read.
* **Miss per reason:** touching mtime → `mtime-changed`; appending a byte → `size-changed`; renaming the plan file → `path-changed`; bumping `extractor_version` → `extractor-version`; deleting the file → `stat-failed`; no row → `no-row`.
* **Empty set is a hit, not a miss:** a plan stored with `files: []` returns a hit — the regression guard for conflating "touches nothing" with "unknown".
* **Upsert stamps at write time:** a file modified between extraction and `POST` is stored with the newer stamp and misses on the next `GET`.
* **Staleness re-check drops the card:** a selected plan edited after the initial read is excluded from the moves and reported.
* **Fallback:** with the endpoint returning 500, the pass completes with the same dispatch set as an uncached run.
* **Standalone parity:** both routes respond under the standalone host, not only the extension host.

### Manual Verification (VSIX install)
1. **Cold run.** Empty cache, press Analyze. Report shows all misses (`no-row`), the same dispatch set as today, and the cache populated afterwards.
2. **Warm run — the headline check.** Press Analyze again with no plan edited. Report shows all hits and reads zero plan files; the dispatch set is identical to the cold run's.
3. **Edit one plan, re-run.** Exactly one miss, named, with reason `mtime-changed` or `size-changed`. The other candidates hit.
4. **Ship a feature, re-run.** The freed lane is filled without re-reading the other plans — the workflow this plan exists to make cheap.
5. **Rules-change invalidation.** Bump `extractor_version`; every plan misses on the next run.
6. **Endpoint down.** Stop the API server mid-workflow and Analyze. The pass runs uncached and says so; it does not fail and does not skip conflict checking.
7. **Standalone host.** Under `npx switchboard`, run a cold then a warm Analyze and confirm the second hits — the cache must not be extension-only.
8. **Upgrade path.** Open a workspace whose `kanban.db` predates V61. Confirm the migration runs once, logs V61, and no existing plan row or column value changes.

---

## Recommendation

Complexity 5 → **Send to Coder.** Additive schema, two endpoints, one skill step rewritten — no existing data touched and rollback is dropping an unread table. Land it **after** the staging plan (V60) and the board-mirror plan, since all three edit `.agents/skills/dispatch-analysis/SKILL.md` and step 2 should be authored once against their final shape rather than rebased twice. Write "occupied lane" as *carrying a `staged_at` stamp*, not *in the `DISPATCH` column* — that column is gone by the time this lands.

Two things must not be traded away under time pressure, because both fail silently and both defeat the pass's core guarantee: the `extractor_version` gate (without it, a future edit to the extraction rules serves stale write sets forever) and the pre-move staleness re-check (without it, the read-to-move window can stage a plan whose file set changed underneath the analysis). A cache that is merely fast is not worth a pass that can put two coders in the same file while reporting success.
