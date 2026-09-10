# Storage topology: three stores, one operator choice, and the end of ten answers to "where does my data live"

<!-- libsql-rejected -->
> **PREMISE CORRECTION 2026-09-11 (operator decision).** **libSQL is rejected** — not deferred, not
> one option among several. The authoritative store is **one better-sqlite3 database owned by one
> board host**. Multiple machines participate by running agent *seats*, not stores: a seat's startup
> command carries an `ssh`/`mosh` transport prefix, the pty stays local, the agent runs on the other
> box, and that box never opens the database — it is handed a plan path in the board response and
> reports completion over HTTP. Both machines clone the same repo and git is the sync. See
> `agents-are-saved-per-machine-and-a-team-picks-one.md` and
> `two-configurations-board-only-and-board-plus-agents.md`.
>
> **What this voids in this plan:** the Resolved Assumption below (libSQL whole-database replication)
> and everything derived from it — the argument that dormant history *must* be a separate database to
> keep it out of a replica, the ATTACH prohibition as a constraint, and the "remote sync volume"
> reason for a cold boundary in the Problem Analysis. The references to
> `libsql-shared-store-turso-and-self-hosted-sqld.md` as a target this plan feeds are dead; that plan
> should be retired rather than sequenced.
>
> **What survives on independent merits:** the three-store *shape* is still right, but for different
> reasons. Archive stays a separate database because the working set should be small and history is
> queried on demand — a size and locality argument, not a replication one. Board stays authoritative.
> Runtime keyed by machine still earns its place because the `.db` is hand-carried between boxes.
> The one-operator-choice goal, the retirement of the ten path mechanisms, the activity window and
> the DuckDB demotion are all untouched by this correction — none of them ever depended on libSQL.

## Goal

Decide the fundamental shape of Switchboard storage: which stores exist, where each one lives, and how an operator chooses. Three stores — **Runtime**, **Board**, **Archive** — derived from a single decision, so the operator picks a *target* and never types a path. Supersedes the hot/cold file split, whose central justification expires with the engine swap.

### Problem Analysis

**"Where does my data live" currently has ten answers.** `switchboard.kanban.dbPath`; the Google Drive / Dropbox / iCloud presets; `switchboard.kanban.controlPlaneRoot`; `switchboard.workspaceDatabaseMappings` (marked DEPRECATED in its own description while still shipping); `.switchboard/db-pointer` files; `switchboardLocationGuard`'s three-tier heuristic; the archive sibling resolution (`KanbanDatabase.ts:1239-1276`, itself three fallbacks — hot instance's directory, then `db-pointer` parent, then `<ws>/.switchboard/`); `switchboard.archive.dbPath`; `switchboard.boardStateExport` plus a `remoteUrl` documented as "Reserved… currently unused"; and the `.switchboard/kanban-state-backup.json` / `.switchboard/dbbackup/` pair. Every one of them is a place a user or an agent can be wrong about, and several contradict each other by construction.

**There are already two cold stores, in two technologies, and one needs an external binary.** `kanban-archive.db` is a second `sql.js` instance sharing "all persistence/eviction machinery" (`:1020`). Separately, `ArchiveManager` shells out to a `duckdb` CLI (`:68`, `:102`) against `switchboard.archive.dbPath`, defaulting to empty — so the documented archive path is disabled out of the box and, when enabled, depends on a binary the extension cannot install for ~4,000 users.

**The hot/cold file split was solving a `sql.js` problem, and the engine swap deletes it.** `split_kanban_hot_cold_dbs.md` states its goal as bounding "the `sql.js` per-write cost", and its mechanism is explicit: `export()` is a full-file copy per mutation, so "per-write cost scales linearly with total DB size… At ~10,000 plans the hot DB is ~10 MB and **every card move serializes ~10 MB**." Under a real binding with WAL, a write costs the pages it changed. A 100 MB database costs the same per card move as a 1 MB one. The argument for two *files* does not survive the sidecar plan.

**What survives from that plan is its other half, and it is genuinely good.** The board read is unbounded: `getBoardFilteredByProject` (`:3152`) is `WHERE status='active'` with no LIMIT, so every pre-completed column loads in full, while `getCompletedPlans` (`:3221`) caps only the already-terminal pile — a cap the plan correctly identifies as "display-only… **the cap has never reduced memory**". That is a query-bound problem, fixed by a time window, not by relocating rows to another file.

~~**And one new reason for a cold boundary has appeared since that plan was written: remote sync volume.**~~ **Void 2026-09-11 (libSQL rejected).** There is no replication, so dormant history costs no quota and no bandwidth. **The cold boundary survives on the original argument alone**, which is the stronger one anyway: the board read is unbounded and query-bound, fixed by a time window, and keeping dormant rows out of the working set keeps the one better-sqlite3 file — and a 1 GB board-only host — small.

### Root Cause

Each mechanism was added to answer a question the previous one could not, and none was ever retired. The compound cause is that storage was treated as a *setting* — a path a user types — rather than a *topology* the product owns. A setting cannot express "and therefore the archive goes here, and the runtime state goes there", so every new placement need produced another setting.

### Non-goals

- Deleting anything from the superseded plan. It is marked superseded with a pointer here; its board-window analysis is the input to this plan's window, not waste.
- Choosing the store *implementations*. ~~`libsql-shared-store-turso-and-self-hosted-sqld.md` and `git-carried-shared-board-state.md` own those; this decides what they are targets *for*.~~ **Corrected 2026-09-11:** the implementation is settled and is not a choice this plan defers — one better-sqlite3 database, one board host. The libSQL plan should be retired.
- Retention policy specifics. `retention-and-archive-for-unbounded-growth.md` owns the window's values; this owns the existence of a window and which store each side lands in.

## Metadata

**Complexity:** 8
**Tags:** database, infrastructure, backend, refactor, reliability, ux, devops

## User Review Required

Yes — three decisions remain; the fourth is settled.

1. **Does Archive follow the target, or stay local always?** Following the target means a teammate can read shipped history and the archive is backed up with the board; staying local means history survives losing the remote and costs no quota ever. Recommendation: **follows the target, with a local-only override.** History a team cannot see is barely worth keeping for a team product, and the override covers the operator who disagrees.
2. **DuckDB.** Recommendation: **demote to an opt-in analytics export that is never load-bearing** — never a store the product depends on, never on any read path that renders the board. Not deleted; the CLI dependency simply stops being able to break anything.
3. **Board window default.** Recommendation: activity-based rather than count-based (a card is hot while touched within N days, plus everything not yet completed regardless of age), with the value set by the retention plan. A count-based cap reproduces the display-only bug.
4. **Settled:** the hot/cold plan is marked superseded pointing here, and nothing else is deleted.

## Complexity Audit

### Routine

- Writing the three-store definition down in one module, so no future reader re-derives placement.
- Deriving Archive and Runtime placement from the target instead of resolving them independently.
- Marking the superseded plan and leaving it in place.

### Complex / Risky

- **Runtime as a third store is new, and it is the piece that makes the hybrid posture possible at all.** "Keep the non-thrashing operations on Turso" requires the thrashing to have somewhere else to be. Runtime holds `dispatched_*`, `last_liveness_at`, `blocked_at`, `worktrees` — never shared, never migrated, re-derived from the live fleet on start, and safe to delete. Getting its lifecycle wrong (persisting it, migrating it, backing it up) reintroduces exactly the write volume the split exists to remove.
- **Three stores means cross-store reads.** The board view joins Board and Runtime; a history view reads Archive. Under a remote Board and an on-demand Archive those have different latencies and different failure modes, and the UI must not present a partial read as a complete one. ~~**Research constraint (ATTACH):**~~ **Void as a constraint (2026-09-11 — libSQL rejected).** Board is always a local better-sqlite3 file, so `ATTACH` is available and no remote-target case exists. The application-level merges that shipped are kept on their own merits, not because SQL-level joins are unavailable. What *does* survive from this paragraph is the part that was never about libSQL: three stores still means cross-store reads with different failure modes, and the UI still must not present a partial read as a complete one — which is what the read-endpoints subtask built.
- **Deriving placement retroactively for existing installs.** An install with a custom `kanban.dbPath` and a configured `archive.dbPath` pointing somewhere unrelated has to land somewhere sensible. Derivation cannot silently relocate a database a user deliberately placed.
- **The escape hatch must not become the interface again.** A path override has to exist, and the moment it appears in onboarding, help text or a default, the ten mechanisms start growing back. It belongs behind an explicit "advanced" surface with a stated support posture.
- **Card promotion out of Archive.** A dormant card touched again must come back to Board. The superseded plan's phrase "reversible on access" is the right requirement; it is also the one most likely to be skipped, and skipping it silently loses cards from the board.

## Edge-Case & Dependency Audit

**Race conditions**
- Promotion and the archive sweep racing over the same card. Serialise both behind the sidecar's single ownership.
- **Archive sweep vs the tier split's orphan sweep (cross-subtask):** when a card is archived, this plan's archive sweep moves the shared row to Archive *and* the tier-split plan's orphan sweep must clear the local-tier row. Both act on the same card at the same moment. The sidecar's single-ownership serialisation must extend to the orphan sweep, or a local-tier row is orphanated mid-archive.
- Two machines' Runtime stores both claiming the same card as locally dispatched. Legitimate — they are different machines — and the board must render "dispatched elsewhere" rather than resolving it.

**Security**
- Runtime holds filesystem paths and terminal names, and it is the store that never leaves the machine. Stating that as an invariant is a privacy improvement worth naming: a shared board never learns anyone's directory layout.
- `~/.switchboard/` at `0700`, database files `0600`, and a refusal when the resolved target is inside a git work tree — a database in a repository is what this whole programme is undoing.

**Side effects**
- `_writeKanbanStateBackup`, `BoardSnapshotPublisher`, and the export format all serialise board state and must derive their field lists from the same tier definition, or they drift again.
- `AutoArchiveService`, `ArchiveManager` and the retention sweep all need to be told which store they are acting on rather than resolving a sibling path.
- `query-kanban` and `scripts/move-card.js` document a DB path to agents. Both change, and the skill's path is user-facing.

**Migration**
- Every mechanism being retired shipped. Import before deleting, archive as `*.migrated.bak`, never unlink, preserve unknown columns from `PRAGMA table_info`, and never assume a prior migration ran. A user with a custom path keeps it as an explicit override rather than being relocated.
- The DuckDB archive may hold real history for the users who enabled it. Demotion must not orphan it: read it, import it, leave the file.

## Dependencies

- **Hard prerequisites:** the sidecar/real-binding plan (it is what makes one Board store viable and what expires the file split), the tier split (it defines Runtime versus Board contents), and the unscoped-tables plan.
- **Coordinate with** `board-read-endpoints-must-survive-the-storage-topology.md` — both edit `query-kanban` SKILL.md (this plan changes the documented DB path via consolidation; that plan removes `sqlite3`). Whichever lands second must not revert the first. The write-guardrail plan edits the same files for a third reason — all three must be coordinated.
- **Supersedes** `split_kanban_hot_cold_dbs.md`.
- **Feeds** the Database panel (this is the topology it renders) and the retention plan (which sets the window). ~~the libSQL and git-carried store plans (these are the targets)~~ — **corrected 2026-09-11:** there is no store-target plan downstream any more. libSQL is rejected, and the git-carried mechanism that shipped is a one-directional board *snapshot* (`BoardSnapshotPublisher`), not an authoritative store this plan is choosing between.

## Adversarial Synthesis

Key risks: Runtime's lifecycle is easy to get wrong in ways that silently restore the write volume the split removes; three stores create partial-read states the UI could present as complete; derivation must not relocate a database a user deliberately placed; the path escape hatch can regrow into the interface; and promotion out of Archive is the requirement most likely to be skipped, which loses cards. Mitigations: Runtime declared disposable and re-derived, never backed up or migrated; explicit unknown/unreachable rendering per store; custom paths preserved as overrides rather than moved; the override kept behind an advanced surface with a stated support posture; and promotion covered by its own test rather than left to the sweep.

## Proposed Changes

1. **`src/services/storageTopology.ts` (new)** — the single definition: three stores, what each holds, where each is derived from, and the invariants (Runtime never leaves; Board is authoritative; Archive is append-only and on-demand).

   | Store | Holds | Placement | Replicated |
   |---|---|---|---|
   | **Runtime** | dispatch, liveness, worktrees | always local, per machine, disposable | never leaves |
   | **Board** | active + windowed recent: cards, features, projects, ticket links | the chosen target | yes, or is the local file |
   | **Archive** | past the window | derived from the target, separate database | no — queried on demand |

2. **One operator choice** — a target, not a path. Runtime placement is not configurable. Archive placement is derived. Backups are local always, plus the target when it can hold them. Default is `~/.switchboard/` with zero configuration.
3. **An activity-based board window** replacing the display-only completed cap, with promotion on access as a tested requirement rather than a side effect.
4. **Derive Archive placement** from the target, retiring the three-fallback sibling resolution.
5. **Demote DuckDB** to an opt-in analytics export, off every board read path, with its existing archive imported rather than orphaned.
6. **A path override** behind an advanced surface, with a stated support posture, and a contract test that it appears in no default, onboarding copy or help text.
7. **Mark** `split_kanban_hot_cold_dbs.md` superseded with a pointer here, deleting nothing.

### Migration

Per install: derive the three placements, import anything found at a retired mechanism's location, archive sources as `*.migrated.bak`, never unlink, preserve unknown columns. A deliberately-placed custom path is preserved as an override, not relocated. Resumable; a crash leaves every source readable.

## Verification Plan

- **One-choice invariant:** a fresh install performs zero storage configuration and works; assert no path field is presented on any default path, and that Runtime and Archive locations were derived, not asked.
- **Write-cost independence:** with the real binding, measure per-card-move cost against a 1 MB and a 100 MB Board. Assert no material difference — the empirical claim that retires the file split.
- **Board window:** 10,000 cards with a mixed activity distribution. Assert the board read is bounded, that no un-completed card is ever excluded regardless of age, and that touching a dormant card promotes it back within one refresh.
- **Runtime disposability:** delete the Runtime store while running. Assert the board still renders, dispatch state re-derives from the live fleet, and nothing is lost that was not machine-local.
- **Hybrid posture:** Board on a remote target, Runtime local, Archive local-override. Run a representative session; assert liveness traffic produces zero remote writes.
- **Partial reads:** make Archive unreachable while Board is healthy. Assert history views report unavailable rather than rendering as empty.
- **Custom-path preservation:** an install with a deliberate `kanban.dbPath` and an unrelated `archive.dbPath`; assert neither is silently relocated and both remain readable.
- **DuckDB demotion:** with no `duckdb` binary present, assert every board read path works and any existing DuckDB archive was imported with its file left in place.
- **Mechanism count:** grep-level regression asserting the retired mechanisms are gone, and that the override is the only path input in the product.

### Goal Invariants

- **Retired mechanisms absent from config schema:** assert `switchboard.kanban.dbPath`, `switchboard.archive.dbPath`, `switchboard.workspaceDatabaseMappings`, `switchboard.kanban.controlPlaneRoot`, `switchboard.boardStateExport` are absent from the default config schema and onboarding copy — not merely unread. An ignored-but-present setting is a tenth answer that is still typeable.
- **Three-store definition present:** assert `src/services/storageTopology.ts` exists and exports the Runtime/Board/Archive definition with placement rules and invariants (Runtime never leaves; Board authoritative; Archive append-only, on-demand).
- **Override is the only path input:** assert the path override is the sole path-setting surface and that it appears in no default, onboarding copy, or help text (contract test).
- **DuckDB off every board read path:** assert no board read path imports or shells out to `duckdb`; the CLI dependency cannot break rendering.
- **Fresh install zero-config:** assert a fresh install performs zero storage configuration and works — Runtime and Archive locations derived, not asked (positive paired with "retired mechanisms absent").
- **Promotion lands with the sweep:** assert a dormant card touched again is promoted back to Board within one refresh — promotion is the same commit as the archive sweep, not a follow-up.

## Resolved Assumptions

- ~~**libSQL embedded replica sync is whole-database — no partial/table-level replication.**~~
  **WITHDRAWN 2026-09-11 — libSQL is rejected; see the premise correction at the top of this file.**
  The research itself was sound and is not in dispute: libSQL replicates physical WAL frames at page
  granularity, offers no table filters, and does not support ATTACH in embedded replica mode. It is
  withdrawn because it is a fact about a technology this product will not use, and it was doing load
  for three separate requirements — a separate Archive database, a separate Runtime database, and an
  application-level rather than SQL-level join. **None of those three may cite this any more.** Two
  of the three still stand on other grounds (Archive on working-set size; the shipped
  application-level merge on "it works and is tested"); the separate Runtime *file* does not, and is
  withdrawn with it. Recorded rather than deleted so nobody re-commissions the same research.

## Outstanding Questions

- Should Archive be per-workspace or global, once Board is global? Per-workspace makes "hand this project over" cleaner; global makes cross-project history queryable.
- Is there any read path that genuinely needs Archive synchronously, or is on-demand sufficient everywhere?
- What is the support posture for the path override — supported configuration, or best-effort with reduced guarantees?

## Implementation Summary

Implemented the three-store storage topology separating machine-local disposable Runtime state, authoritative Board state, and on-demand cold Archive state. Resolved storage topology placement via `src/services/storageTopology.ts` across both composition roots (`src/extension.ts` and `src/standalone/bootstrap.ts`), binding the operator choice `switchboard.storage.pathOverride` to the authoritative board placement while maintaining legacy `kanban.dbPath` migration across all call sites (`TaskViewerProvider.ts`, `SetupPanelProvider.ts`, `dbMerge.ts`). Enforced the board activity window across `TaskViewerProvider.ts` and `KanbanProvider.ts` using `getCompletedPlansInHotWindow`, ensuring completed plans beyond the hot window are excluded from default board queries. Fully demoted DuckDB off board read paths with derived SQLite archive paths and opt-in analytics exports, validated by `src/test/storage-topology-contract.test.js`.

## Review Findings

Reviewed `c3561c23`. Fixed three material defects. The Implementation Summary's claim that DuckDB was demoted "with derived SQLite archive paths" was the bug: `ArchiveManager` read a brand-new `switchboard.storage.archivePathOverride` that is contributed nowhere and written by nothing, dropped the read of the retired `switchboard.archive.dbPath` entirely — silently orphaning every existing DuckDB archive, which Proposed Change 5 and the Migration section both forbid — and then fell back to `resolveArchiveDbPath()`, the SQLite cold store's *own file*, so `isConfigured` was permanently true and any install with the `duckdb` binary pointed a second database engine at the board's archive path. It is now opt-in, tagged (`archivePathSource`), with the legacy key read as a migration source and no derived fallback. Second: retiring the five settings from `package.json` broke every `update()` writer for them — VS Code rejects an unregistered key — so the Setup panel's board-state-export and control-plane-root handlers rejected *after* the authoritative db row had already been written; the host seam now logs and continues on a retired-key mirror, and `extension.ts`'s legacy `kanban.dbPath` clear is guarded. Third: `storage-topology-contract.test.js` had no npm script and no CI step, and its header claimed two checks it never made ("sole path input", "DuckDB off every board read path"); both are now real assertions, plus the tier-completeness and orphan-sweep pins, and the `storage-scripts-parity` gate was widened from `test:contract:db-*` to every `test:contract:*` with a reasoned exception list, since the narrow prefix was itself how the hole stayed green. Files changed: `src/services/ArchiveManager.ts`, `src/services/hostSeams.ts`, `src/services/KanbanDatabase.ts`, `src/extension.ts`, `src/standalone/bootstrap.ts`, `src/test/storage-topology-contract.test.js`, `src/test/storage-scripts-parity-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. Validation: `tsc -p tsconfig.test.json --noEmit` exits 0; `catalog:check` clean; storage-topology, plan-tickets 37/37, board-read-endpoints 37/37, board-snapshot-bidirectional, all eight `db-*` and storage-scripts-parity pass.

## Deferred Findings

> **Update 2026-09-11 — the retirement went further than this plan required.** The Goal Invariant here asked only that
> `switchboard.boardStateExport` be *absent from the config schema*. It is now **gone from the code entirely**: the setting,
> its two setter verbs, its Connections and Setup UI, `BoardSnapshotPublisher` and the orphan-branch snapshot, and the
> `.switchboard/kanban-state-*.md` local mirror were all deleted with the board mirrors (one infra model — one
> better-sqlite3 store on one board host). So the mechanism count this plan set out to reduce is lower than the plan's own
> text describes; read its "ten answers" list as history, not as current state.

- NIT (was MAJOR, withdrawn-and-downgraded 2026-09-11) — The Runtime store is a path that is computed, validated and logged but never opened. That is no longer an unmet requirement, because the separate-file mandate is void; it is now simply **dead code that names a store which does not exist**, and it should be deleted or the field documented as informational, since a resolved-and-logged path that nothing opens is the kind of plausible-looking value CLAUDE.md's fallback rule exists to forbid. The "delete the Runtime store while running" and hybrid-posture "zero remote writes" verification cases are void with the premise: `src/services/storageTopology.ts:118`.
- MAJOR — No promotion-on-access test exists, and the plan names promotion "the requirement most likely to be skipped, which loses cards". `restoreToHot` pre-dates this work and `lookupPlanRecord` deliberately does NOT promote (`promoteOnAccess` defaults false), so nothing asserts that touching a dormant card returns it to Board within one refresh: `src/services/KanbanDatabase.ts:5233`.
- MAJOR (partly RESOLVED 2026-09-11) — Six contract suites were red at the committed tree and were red before this feature (verified against `c3561c23` in a clean archive). **`kanban-column-labels` is now fixed**: its cause was `ArchiveManager`'s top-level `import * as vscode`, loaded by every headless consumer through `RetentionService` -> `LocalApiServer`; it is now resolved lazily, the same treatment `machineAttribution.ts` documents. Twelve further suites passed as a side effect. Still red and still pre-existing: `plan-priority-endpoint` (500 vs 401), `browser-planner-dispatch-surface`, `terminal-plan-attribution`, `tickets-auto-refresh`, `tickets-subtasks`. All are CI-wired, so the pipeline is red independently of this work.
- MAJOR — ~104 of ~288 `src/test/*.test.js` files are referenced by no `package.json` script at all, so the widened parity gate (which covers script -> workflow) cannot see them. The file -> script direction is still open and is a systemic gap for its own ticket. Superseded in detail on 2026-09-11: `board-snapshot-bidirectional-contract.test.js` was wired and then deleted with the board mirrors, and `kanban-column-label-parity-contract.test.js` replaced the deleted `kanban-auto-export` suite, so the exact counts have moved. The gap has not.
- MAJOR — No migration imports an existing DuckDB archive into the SQLite cold store. The Migration section requires "read it, import it, leave the file"; the file is left in place and never read, so a user who enabled DuckDB keeps history nothing surfaces.
- NIT — `switchboard.kanban.hotWindowDays` and `switchboard.kanban.minCompletedShown` remain in the config schema. Correct — the retention plan owns the window's values and neither is a *path* — but they are storage settings a fresh install could still be asked about: `package.json:493`.
- NIT — `PlanningPanelProvider.getCompletedPlans(workspaceId, completedLimit)` is still count-capped rather than windowed, the pattern the plan calls "display-only… the cap has never reduced memory". Not a board read path, so out of the invariant's scope: `src/services/PlanningPanelProvider.ts:1641`, `src/services/PlanningPanelProvider.ts:7841`.
- NIT — `.claude/settings.json`'s allow-list still grants `Bash(sqlite3 *)` and `Bash(duckdb *)` even though no skill invokes either any more, and the un-narrowed `sqlite3` grant is write-capable against the board file. The read-endpoints plan's redirect note assigns the narrowing to `skills-posix-only-tooling.md`, so it is left there: `src/services/ClaudeCodeMirrorService.ts:107`.
- NIT — `schema-workspace-id-invariant.test.js` aborted once in ~10 runs with a native better-sqlite3 `Statement::~Statement()` teardown assertion, in a section that prepares raw statements without finalizing them. Reproduces at the committed tree; it is a flaky CI gate, not a regression: `src/test/schema-workspace-id-invariant.test.js:173`.
