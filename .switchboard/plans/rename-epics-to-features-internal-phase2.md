---
description: Phase 2 of the epic→feature rename — internal identifiers, persisted state, on-disk directory, DB columns, and parsed markers. Unreleased feature, clean break, no external migration.
---

# Plan: Rename "Epics" → "Features" (Internal Identifiers + Persisted State — Phase 2)

## Goal

Complete the "epic" → "feature" rename for the layers that Phase 1 (`rename-epics-to-features-user-facing.md`) deliberately left untouched: the `.switchboard/epics/` on-disk directory, SQLite columns `is_epic`/`epic_id`, the `> **Epic Plan ID:**` parsed marker, TS internal identifiers (option callback keys, KanbanProvider methods, `isEpicCandidate`), CSS classes/ids, and webview↔extension message-type constants. The entire epic feature is unreleased experimental work (maintainer-confirmed 2026-07-04), so this is a **clean break with no external migration**.

### Problem / Background

Phase 1 renamed user-facing display text + slash commands + skill filenames + HTTP route strings to `feature`, but left internal identifiers and persisted state as `epic` to keep the diff bounded and the breakage surface small. This created a deliberate split:

- **Agent-facing surfaces** (what agents read): `feature` — done in Phase 1.
- **Internal identifiers** (what code reads): `epic` — deferred to this plan.
- **Persisted state** (what disk/DB stores): `epic` — deferred to this plan.

The split is functionally correct (agents don't see internal identifiers), but it leaves a consistency debt: the codebase speaks two languages. This plan pays that debt. Since the feature is unreleased, there is no migration risk — the maintainer's own dev `kanban.db` and `.switchboard/epics/` files are the only existing state, and both can be rebuilt/renamed in-place.

### Root-cause insight

Every `epic` reference in the internal layer is either:
1. **A path string** (`.switchboard/epics/`) — rename the directory + update the ~48 path refs.
2. **A DB column/index** (`is_epic`, `epic_id`, `idx_plans_is_epic`, `idx_plans_epic_id`) — `ALTER TABLE ... RENAME COLUMN` migration (one-time, dev-only).
3. **A TS identifier** (`isEpic`, `epicId`, `createEpic`, `isEpicCandidate`, `removeFromEpic`, `_handleKanbanCreateEpic`, etc.) — find-replace within type-safe boundaries (compiler catches misses).
4. **A CSS class/id** (`.epic-card`, `#epics-list-pane`) — find-replace in webview HTML/JS + any JS that queries by class/id.
5. **A message-type constant** (`suggestEpics`, `setEpicWorkflowMode`, `promoteToEpic`, `createWorktreeForEpic`, `removeSubtaskFromEpic`, `deleteEpic`) — must change on BOTH ends (webview + extension) together.
6. **A parsed marker** (`> **Epic Plan ID:**`, `subtask-of:`, `epic` HTML-comment tags) — rename in both generator and parser.

None of these carry external migration risk (unreleased). The risk is **internal consistency**: a missed reference breaks compilation (TS) or runtime (path/string/message-type). The compiler catches TS misses; grep + manual review catches string/path misses.

## Metadata
- **Plan ID:** C311567A-43ED-4B82-A753-64A4D142CD65
- **Tags:** refactor, database, ui, backend
- **Complexity:** 7
- **Project:** switchboard

## User Review Required
No — maintainer confirmed the entire epic feature is unreleased experimental work (2026-07-04). No external migration. The maintainer's own dev `kanban.db` can be rebuilt or migrated in-place via `ALTER TABLE RENAME COLUMN`.

## Scope

### ✅ IN SCOPE — internal identifiers + persisted state (full rename, clean break)

**1. On-disk directory: `.switchboard/epics/` → `.switchboard/features/`**
- `git mv .switchboard/epics .switchboard/features` (moves ~49 physical epic files).
- Update ~48 path refs across 11 source files:
  - `GlobalPlanWatcherService.ts` (10 refs — lines 175, 393, 396, 537, 572, 576, 608, 638, 649, 784) — the watcher treats "any file under `.switchboard/epics/`" as an epic; this is the load-bearing path.
  - `KanbanProvider.ts` (8 refs — lines 8940, 8971, 8976, 8979, 10087, 10093, 10318, 10355).
  - `PlanManifestService.ts` (6 refs — lines 130, 182, 225, 229, 230, 234).
  - `KanbanDatabase.ts` (6 refs — lines 4224, 5616, 5620, 5664, 5677, 5682).
  - `ClickUpSyncService.ts` (5 refs — lines 2912, 2929, 3050, 3097, 3100).
  - `PlanningPanelProvider.ts` (4 refs — lines 1052, 4534, 4613, 4617).
  - `LinearSyncService.ts` (4 refs — lines 2397, 2550, 2680, 2683).
  - `WorkspaceExcludeService.ts` (2 refs — lines 14, 27).
  - `TaskViewerProvider.ts` (1 ref — line 3006).
  - `agentPromptBuilder.ts` (1 ref — line 661).
  - `src/services/__tests__/agentPromptBuilder.test.ts` (1 ref — line 251) — the one test that references the path.

**2. Epic filename convention: `epic-<uuid>.md` → `feature-<uuid>.md`**
- Most physical files use descriptive names (not the `epic-` prefix), so only a subset of files need renaming. But the ~50 code refs to the `epic-` prefix convention (generator + parser + glob patterns) must update to `feature-`.
- The `isEpicFile` / epic-file detection logic in `GlobalPlanWatcherService` and `PlanManifestService` that keys off the `epic-` prefix or the directory path must re-point to `feature-` / `.switchboard/features/`.

**3. Parsed marker: `> **Epic Plan ID:**` → `> **Feature Plan ID:**`**
- Update the generator (wherever epic markdown files are written — `_regenerateEpicFile` in KanbanProvider) and the parser (wherever epic files are read — `PlanManifestService`, `GlobalPlanWatcherService`).
- Also rename the `subtask-of:` / `epic` HTML-comment tags if they use the word `epic` — update generator + parser together.

**4. SQLite columns + indexes**
- `is_epic` → `is_feature`, `epic_id` → `feature_id`.
- Indexes `idx_plans_is_epic` → `idx_plans_is_feature`, `idx_plans_epic_id` → `idx_plans_feature_id`.
- Migration approach: add a new migration (next version number after V41) using `ALTER TABLE plans RENAME COLUMN is_epic TO is_feature;` and `ALTER TABLE plans RENAME COLUMN epic_id TO feature_id;` + `DROP INDEX ... / CREATE INDEX ...` for the renamed indexes. SQLite ≥3.25.0 supports `RENAME COLUMN`. This is a **dev-only migration** (the feature is unreleased; only the maintainer's `kanban.db` has these columns).
- Update all ~90 refs to `is_epic`/`epic_id` in `KanbanDatabase.ts` (column names in SQL strings, TypeScript interface fields, upsert logic, sticky-epic CASE expressions, migration SQL).
- Update the `PLAN_COLUMNS` constant and any `record.isEpic` → `record.isFeature` mapping.

**5. TS internal identifiers (~600 occurrences)**
- Variables & functions: `isEpic` → `isFeature`, `epicId` → `featureId`, `createEpic` → `createFeature`, `epicUltracodeEnabled` → `featureUltracodeEnabled`, `updateEpicActionButton` → `updateFeatureActionButton`, `getEpicPlans` → `getFeaturePlans`, `cascadeEpicByPlanId` → `cascadeFeatureByPlanId`, `createEpicFromPlanIds` → `createFeatureFromPlanIds`, `assignPlansToEpic` → `assignPlansToFeature`, `_regenerateEpicFile` → `_regenerateFeatureFile`, `_handleKanbanCreateEpic` → `_handleKanbanCreateFeature`, etc. **Plus the 3 new methods + handlers introduced by the agent-clarity plan** (`feature_plan_20260704232500_epic-operations-agent-clarity.md`) — these do not exist at Phase 2 authoring time but MUST be renamed when the agent-clarity plan lands first (strict ordering): `_removeSubtaskFromEpic` → `_removeSubtaskFromFeature`, `_deleteEpic` → `_deleteFeature`, `_splitEpic` → `_splitFeature`, and the LocalApiServer handler methods `_handleKanbanRemoveFromEpic` → `_handleKanbanRemoveFromFeature`, `_handleKanbanDeleteEpic` → `_handleKanbanDeleteFeature`, `_handleKanbanSplitEpic` → `_handleKanbanSplitFeature`.
- `isEpicCandidate` TS field on `RemoteStateDelta` (`RemoteProvider.ts:29`) → `isFeatureCandidate` + writers/readers (`LinearRemoteProvider.ts:77`, `NotionRemoteProvider.ts:112`, `RemoteControlService.ts:469, 530-531`).
- LocalApiServer option-callback keys: `createEpic` → `createFeature`, `assignToEpic` → `assignToFeature`, `removeFromEpic` → `removeFromFeature`, `deleteEpic` → `deleteFeature`, `splitEpic` → `splitFeature` (in `LocalApiServerOptions` interface + `TaskViewerProvider.ts` injection sites + `KanbanProvider` method delegations).
- Config keys: `epic_ultracode_enabled` → `feature_ultracode_enabled`, `epic_goal_enabled` → `feature_goal_enabled` (in `KanbanProvider.ts` getConfig/setConfig calls — these are DB config table string keys, dev-only).
- The TypeScript compiler will catch any missed identifier references — this is the safety net.

**6. CSS classes / element IDs**
- `.epic-card` → `.feature-card`, `.epic-plan-item` → `.feature-plan-item`, `#epics-list-pane` → `#features-list-pane`, `#new-epic-modal` → `#new-feature-modal`, etc.
- Update in webview HTML (`project.html` ~85, `kanban.html` clusters) AND in JS that queries by class/id (`project.js`, `kanban.html` inline JS).
- CSS rules in `<style>` blocks referencing these classes.

**7. Webview↔extension message-type constants**
- `suggestEpics` → `suggestFeatures`, `setEpicWorkflowMode` → `setFeatureWorkflowMode`, `promoteToEpic` → `promoteToFeature`, `createWorktreeForEpic` → `createWorktreeForFeature`, `removeSubtaskFromEpic` → `removeSubtaskFromFeature`, `deleteEpic` → `deleteFeature`, etc.
- Must change on BOTH ends together: the `postMessage({type:...})` in webview JS AND the `case '...'` switch in `KanbanProvider.ts` / `PlanningPanelProvider.ts` handleMessage. A miss on either end silently breaks the action.

### ⚙️ OUT OF SCOPE — already done in Phase 1
- User-facing display text (labels, buttons, tooltips, placeholders, notifications).
- Slash command names + skill filenames + workflow filenames.
- HTTP route path strings (`/kanban/feature/*`).
- Notion `Is Feature`/`Feature` property strings.
- Documentation prose.

## Dependencies
- `rename-epics-to-features-user-facing.md` (Phase 1) — **MUST land first.** Phase 1 establishes the `feature`-facing / `epic`-internal boundary. Phase 2 collapses the internal side. Running Phase 2 before Phase 1 creates a window where agents see `feature` scripts but `epic` internal errors — confusing.
- `feature_plan_20260704232500_epic-operations-agent-clarity.md` — the verb scripts + endpoints + cheatsheet. Phase 2 renames the TS option-callback keys those scripts POST to (`createEpic`→`createFeature` etc.). The scripts' fetch bodies use the TS key names as JSON field names — so the script files' request body field names must update in lockstep with the TS key rename. Coordinate.
- `sess_20260702_remoteEpicStructure` — the Notion/Linear epic-aware mirroring. Phase 2 renames `isEpicCandidate` → `isFeatureCandidate` in the `RemoteStateDelta` interface shared by this work. Both unreleased; clean break.

## Complexity Audit

### Routine
- `git mv .switchboard/epics .switchboard/features` — one command.
- `ALTER TABLE RENAME COLUMN` migration — two SQL statements + index rebuild.
- CSS class/id find-replace in webview HTML/JS — mechanical.
- TS identifier find-replace — compiler-verified.

### Complex / Risky
- **Message-type constant dual-end consistency**: each `postMessage({type:'...'})` must match its `case '...'` handler. A miss silently breaks an action (no compiler catch — these are string literals). ~20 message types to rename, each touching 2+ files.
- **`GlobalPlanWatcherService` path coupling**: the watcher's epic-detection logic keys off the directory path + filename prefix. Renaming both simultaneously requires care — a stale glob pattern silently stops detecting epics.
- **Parsed marker consistency**: the `> **Epic Plan ID:**` marker is written by the generator and read by the parser. Existing epic files on disk have the old marker — either (a) bulk-rewrite all existing epic files to the new marker, or (b) make the parser accept both markers during a transition. Since the feature is unreleased (only the maintainer's files), option (a) is simplest: a one-time `sed` pass over `.switchboard/features/*.md`.
- **`PLAN_COLUMNS` + upsert sticky-epic logic**: the `is_epic` column has a sticky-upsert CASE expression (`CASE WHEN excluded.is_epic > 0 THEN ...`) that must rename correctly or epics silently lose their sticky flag on re-import.
- **Config key rename** (`epic_ultracode_enabled` → `feature_ultracode_enabled`): existing dev DB config rows have the old key. Either (a) delete the old config rows (dev-only, acceptable), or (b) add a migration that copies old→new. Option (a) is simplest — the maintainer re-toggles the ultracode setting once.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — no async/state behavior changes. The rename is structural.
- **Security:** None.
- **Side Effects:** The maintainer's own `.switchboard/epics/` files move to `.switchboard/features/`. Any open editor tabs pointing at the old path will show "file deleted" — close and reopen. Any git branches with epic files in the old path will merge cleanly (git tracks the rename).
- **Dependencies & Conflicts:** Must not land concurrently with Phase 1 or the agent-clarity plan — strict sequencing (Phase 1 → agent-clarity → Phase 2). The TS key rename in Phase 2 changes the JSON field names the verb scripts send — those scripts must update in the same commit. **Merge-order hazard (cross-subtask):** Phase 1 renames the Notion property string `'Is Epic'`→`'Is Feature'` at `NotionRemoteProvider.ts:112`; Phase 2 renames the TS field `isEpicCandidate`→`isFeatureCandidate` at the SAME line 112 (different tokens, same line). If Phase 1 and Phase 2 are developed on parallel branches, line 112 produces a git merge conflict — Phase 2 must rebase on Phase 1 before merging.
- **Test impact:** `src/services/__tests__/agentPromptBuilder.test.ts:251` references the old `.switchboard/epics/` path — update it. Grep test dirs for `is_epic`, `epic_id`, `isEpic`, `epicId`, `epic-card`, `suggestEpics`, `Epic Plan ID` after the rename and fix any remaining refs. The compiler catches TS misses; string-literal misses need grep verification.

## Uncertain Assumptions
- ~~**sql.js bundled SQLite version vs `ALTER TABLE RENAME COLUMN`:**~~ **RESOLVED (2026-07-04, web research).** `sql.js@1.14.1` bundles **SQLite 3.49.1** (released Feb 18, 2025), confirmed via the library's v1.14.1 `Makefile` (compiles `sqlite-amalgamation-3490100.zip`) + runtime `SELECT sqlite_version()`. `ALTER TABLE ... RENAME COLUMN` (requires ≥ 3.25.0, Sept 2018) is **fully supported natively** — no fallback table-rebuild needed. The migration below proceeds with the native `RENAME COLUMN` syntax. The fallback (create-new-table/copy/drop/rename) remains documented as a defensive note only; it is NOT required. This was the only uncertain factual claim in the plan; all other code/structure claims were verified against the repo.
- **Implementation guidance from research (Clarification — strictly implied by the migration requirement):** (a) wrap the DDL in `BEGIN TRANSACTION;` ... `COMMIT;` with `ROLLBACK;` on exception, and do NOT persist the DB to disk (the `sql.js` `.export()` + `fs.writeFile` step) until the migration commits successfully — this prevents a half-migrated schema from being written; (b) execute each DDL statement as an individual `db.run()` call rather than one multi-statement string, for cleaner error isolation in the WASM runtime; (c) optional resilience: probe `SELECT sqlite_version()` at migration time to gate on ≥ 3.25.0 before running `RENAME COLUMN` (cheap, guards against a hypothetical downgrade).

## Adversarial Synthesis
Key risks: (1) message-type dual-end consistency — each `postMessage({type:'...'})` must match its `case '...'` handler; a miss silently breaks an action with no compiler catch (~20 types, 2+ files each); (2) `GlobalPlanWatcherService` path+prefix coupling — renaming the `.switchboard/epics/` directory AND the `epic-` filename glob simultaneously means a stale glob silently stops detecting features; (3) the sticky-upsert `CASE WHEN excluded.is_epic > 0 ...` column rename must preserve "once true, only explicit clear resets" or epics silently lose their flag on re-import; (4) the parsed-marker generator/parser/sed pass must land together or existing feature files stop parsing; (5) supersession coverage — Phase 2 must rename the 3 new KanbanProvider methods + endpoint handler methods the agent-clarity plan creates (`_removeSubtaskFromEpic`→`_removeSubtaskFromFeature`, `_deleteEpic`→`_deleteFeature`, `_splitEpic`→`_splitFeature`, `_handleKanbanRemoveFromEpic`→`_handleKanbanRemoveFromFeature` etc.), not just the pre-existing identifiers. Mitigations: grep-verify both ends of every message type, re-point the watcher glob in the same commit as the directory move, carry the sticky CASE expression across the column rename verbatim, run the marker sed pass with the generator+parser change, and explicitly enumerate the agent-clarity-introduced methods in the rename set.

## Proposed Changes

### `.switchboard/epics/` → `.switchboard/features/` (directory + physical files)
- **Context:** The on-disk epic-identity invariant. ~49 physical files.
- **Logic:** `git mv .switchboard/epics .switchboard/features`. Update ~48 path string refs across 11 source files (enumerated in Scope section 1). The path appears in `path.join(workspaceRoot, '.switchboard', 'epics')` patterns — rename the `'epics'` segment to `'features'`.
- **Implementation:** After the `git mv`, grep for `'.switchboard/epics'` and `'epics'` path segments across `src/` and replace. Run the compiler + manual smoke test (create a feature, confirm it lands in `.switchboard/features/`).
- **Edge Cases:** The `GlobalPlanWatcherService` glob pattern must re-point to the new directory or epic detection silently stops.

### `src/services/KanbanDatabase.ts` (DB columns + indexes + migration)
- **Context:** `is_epic`/`epic_id` columns, `idx_plans_is_epic`/`idx_plans_epic_id` indexes, sticky-epic upsert CASE, ~90 refs.
- **Logic:** Rename columns `is_epic` → `is_feature`, `epic_id` → `feature_id`. Add a new migration (next version after V41): `ALTER TABLE plans RENAME COLUMN is_epic TO is_feature; ALTER TABLE plans RENAME COLUMN epic_id TO feature_id; DROP INDEX idx_plans_is_epic; DROP INDEX idx_plans_epic_id; CREATE INDEX idx_plans_is_feature ON plans(is_feature); CREATE INDEX idx_plans_feature_id ON plans(feature_id);`. Update `PLAN_COLUMNS`, the upsert CASE expression, all SQL string literals, and the TS interface field `epic_id` → `feature_id`.
- **Implementation:** The migration is dev-only (unreleased feature). The maintainer's `kanban.db` upgrades in-place via the migration. The sticky-epic CASE (`CASE WHEN excluded.is_epic > 0 THEN excluded.is_epic ELSE plans.is_epic END`) becomes `CASE WHEN excluded.is_feature > 0 THEN excluded.is_feature ELSE plans.is_feature END`. **Transaction safety (per web research on sql.js WASM):** wrap the 6 DDL statements in `BEGIN TRANSACTION;` ... `COMMIT;` with `ROLLBACK;` on exception; execute each statement as an individual `db.run()` call (not one multi-statement string) for clean error isolation; do NOT call `.export()` + `fs.writeFile` to persist until `COMMIT` succeeds (prevents a half-migrated schema reaching disk). Native `RENAME COLUMN` is confirmed supported (SQLite 3.49.1 bundled in sql.js 1.14.1).
- **Edge Cases:** The sticky logic must preserve the "once true, only explicit clear can reset" semantics. The `record.isEpic ?? 0` mapping becomes `record.isFeature ?? 0`.

### `src/services/GlobalPlanWatcherService.ts` (watcher — epic detection)
- **Context:** 10 refs to `.switchboard/epics/` + the `epic-` filename prefix. This is the load-bearing epic-detection logic.
- **Logic:** Re-point the watched directory to `.switchboard/features/` and the filename glob from `epic-*` to `feature-*`. Update the `isEpicFile` detection function.
- **Implementation:** Test by creating a file in `.switchboard/features/` and confirming it appears on the board as a feature.
- **Edge Cases:** If the watcher caches the old path, a restart may be needed during dev.

### `src/services/KanbanProvider.ts` + `PlanningPanelProvider.ts` + `TaskViewerProvider.ts` (TS identifiers + message types)
- **Context:** ~600 TS identifier refs + ~20 message-type constants across these providers.
- **Logic:** Rename TS methods (`createEpicFromPlanIds`→`createFeatureFromPlanIds`, `assignPlansToEpic`→`assignPlansToFeature`, `_regenerateEpicFile`→`_regenerateFeatureFile`, `_handleKanbanCreateEpic`→`_handleKanbanCreateFeature`, etc.). Rename message-type `case` labels (`'suggestEpics'`→`'suggestFeatures'`, `'promoteToEpic'`→`'promoteToFeature'`, `'removeSubtaskFromEpic'`→`'removeSubtaskFromFeature'`, `'deleteEpic'`→`'deleteFeature'`, etc.). Rename LocalApiServer option-callback keys (`createEpic`→`createFeature`, `assignToEpic`→`assignToFeature`, `removeFromEpic`→`removeFromFeature`, `deleteEpic`→`deleteFeature`, `splitEpic`→`splitFeature`).
- **Implementation:** The compiler catches TS identifier misses. Message-type string literals need grep verification on BOTH ends (webview JS `postMessage` + provider `case`).
- **Edge Cases:** The option-callback key rename changes the JSON field name the verb scripts send. The scripts (`create-feature.js`, `assign-to-feature.js`, `remove-from-feature.js`, `delete-feature.js`, `split-feature.js`) must update their request body field names in the same commit.

### `src/services/remote/RemoteProvider.ts` + `LinearRemoteProvider.ts` + `NotionRemoteProvider.ts` + `RemoteControlService.ts` (isEpicCandidate)
- **Context:** The `isEpicCandidate` field on `RemoteStateDelta`, shared by Linear + Notion providers + the control service.
- **Logic:** Rename `isEpicCandidate` → `isFeatureCandidate` across the interface + all writers/readers.
- **Implementation:** Compiler-verified. 5 files, ~6 refs.
- **Edge Cases:** None — pure TS identifier, no external contract.

### Webview HTML/JS (CSS classes + element IDs)
- **Context:** `project.html` (~85 class/id refs), `kanban.html` (clusters), `project.js` (DOM queries by class/id).
- **Logic:** Rename `.epic-card` → `.feature-card`, `#epics-list-pane` → `#features-list-pane`, `#new-epic-modal` → `#new-feature-modal`, etc. Update CSS rules, HTML class/id attributes, and JS `querySelector`/`getElementById` calls.
- **Implementation:** Grep for `epic-` in webview files, replace with `feature-` for class/id/selector references only. Do NOT touch Phase 1 display text (already done).
- **Edge Cases:** A CSS class renamed in HTML but missed in JS `querySelector` silently breaks DOM lookup. Grep-verify both ends.

### Parsed marker (`> **Epic Plan ID:**` → `> **Feature Plan ID:**`)
- **Context:** Written by `_regenerateEpicFile` (→`_regenerateFeatureFile`), read by `PlanManifestService` + `GlobalPlanWatcherService`.
- **Logic:** Update the generator to write `> **Feature Plan ID:**` and the parser to read it. Bulk-rewrite existing epic files on disk: `sed -i '' 's/\*\*Epic Plan ID:\*\*/\*\*Feature Plan ID:\*\*/g' .switchboard/features/*.md`.
- **Implementation:** Generator + parser + sed pass must land together. A stale parser reading the old marker would fail to detect existing features after the sed pass.
- **Edge Cases:** If any epic file has a variant casing (`Epic plan ID:`, `EPIC PLAN ID:`), the sed pattern misses it. Grep for case variants first.

## Verification Plan

### Automated Tests
- **None required.** Per session directive, automated tests are skipped. Compilation is also skipped per session directive. The TypeScript compiler is the primary safety net for identifier renames — recommend running `npm run compile` manually after implementation to catch TS misses (this is a recommendation, not a plan step).

### Manual Verification
- **Directory + watcher:** create a new feature via the UI — confirm the file lands in `.switchboard/features/` (not `.switchboard/epics/`). Confirm existing features (moved by `git mv`) still load on the board.
- **DB columns:** open `kanban.db` in sqlite3 — confirm columns are `is_feature`/`feature_id` (not `is_epic`/`epic_id`). Confirm existing epics still show `is_feature=1`. Create a new feature — confirm `is_feature=1` persists across re-import (sticky upsert works).
- **Message types:** exercise every board action that sends a message-type constant (promote to feature, suggest features, remove subtask, delete feature, create worktree for feature, set workflow mode). Confirm none silently fail.
- **CSS/DOM:** open kanban + project views — confirm epic-card styling, epic-list-pane scrolling, new-feature modal all render correctly. A missed CSS rename shows as broken styling; a missed JS selector shows as a dead button.
- **Parsed marker:** open an existing feature file — confirm it shows `> **Feature Plan ID:**`. Confirm the board still groups subtasks under it.
- **Verb scripts:** run `create-feature.js`, `assign-to-feature.js`, `remove-from-feature.js`, `delete-feature.js`, `split-feature.js` — confirm all POST successfully (the TS key rename changed their request body field names; a miss returns 400/502).
- **Remote providers:** if Linear/Notion sync is configured, run one sync cycle — confirm `isFeatureCandidate` is read/written correctly (a miss throws a TS compile error, so this is compiler-caught).
- **Grep sweep:** `grep -ri 'epic' src/ --include='*.ts' --include='*.html' --include='*.js'` — confirm zero remaining `epic` references in source (excluding this plan file, comments explaining the rename history, and the `Epic Ultracode` setting description which is a separate feature).

---

**Recommendation:** Complexity 7 → **Send to Lead Coder.** The TS identifier rename is compiler-safe, but the message-type dual-end consistency, the watcher path coupling, the sticky-upsert column rename, and the parsed-marker generator/parser/sed coordination each carry silent-failure risk that needs careful review.

## Review Findings
Reviewed against commit `0a63d67`; found one **CRITICAL (fixed)**. The V46 migration used a table-rebuild from `SCHEMA_TABLES_SQL`, which omits later ALTER-added columns (`needs_path_fix`, `needs_relative_conversion`, `has_worktree`), so `INSERT … SELECT` would throw "no column named …" and roll back on every startup — leaving the live DB stuck at v45/`is_epic` while all renamed code queries `is_feature` (a fully broken board). Replaced with native `ALTER TABLE RENAME COLUMN` (+ index drop/recreate; also covers the `worktrees.epic_id` column no plan listed but the implementer correctly caught), validated by running the DDL against a copy of the real 1525-row `kanban.db` — all rows/49 features preserved, columns+indexes renamed, extra columns intact. Files changed: `KanbanDatabase.ts` (+`KanbanProvider.ts` for the shared split fix) plus a repo-wide `an feature`→`a feature` grammar sweep (~79 sites, incl. the ULTRACODE agent-prompt prefix); message-type dual-end consistency and zero orphaned runtime `epic` refs verified. Remaining risk: possible double subtask-worktree provisioning on re-parent (pre-existing, flagged in Agent Clarity's audit) — not introduced by this rename.
