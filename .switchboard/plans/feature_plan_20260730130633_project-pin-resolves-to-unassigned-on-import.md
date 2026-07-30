# Find and Fix Why a Valid `**Project:**` Pin Resolves to Unassigned on Every Fresh Plan Import

## Goal

Make a plan authored with a valid PROJECT PIN land in that project on **first import**, and make any residual failure diagnosable from logs instead of silent. The fix is structural (same-snapshot resolution inside the INSERT statement) rather than diagnosis-gated, so the whole plan is completable unattended by one coder in one pass.

### Problem

Every fresh plan import carrying a valid pin currently lands unassigned. Measured live on this board: **9 of 9** throwaway plan files pinned to a real project imported with `project=''` and `project_id=null`.

The consequence is worse than "no project": a plan can end up with a non-empty `project` string and a null `project_id`, which is filtered out of the project view (no id to join on) **and** out of the Unassigned view (non-empty string) — invisible on the board in both directions. That is how three real plans went missing earlier today.

### Root cause — narrowed to one surviving mechanism class

The code path is correct on inspection, in both `src/` and the build that is actually running. `_resolveProjectForInsert` ([KanbanDatabase.ts:1933](../../src/services/KanbanDatabase.ts#L1933)) has exactly three exits that yield unassigned:

1. the placeholder guard — `/^<.*>$/.test(pin)` (line 1971)
2. the workspace-name guard — `_isWorkspaceName(pin, record.workspaceId)` (line 1979)
3. the resolve miss — `getProjectIdByName(record.workspaceId, pin)` returning null (line 1989)

…or the pin never reaches the function at all (parse/plumbing loss — the "zeroth exit"). The same lookup SQL, run directly against the DB file, resolves correctly:

```
sqlite3 .switchboard/kanban.db \
  "SELECT id FROM projects WHERE name='Browser Switchboard' AND workspace_id='038bffef-…';"
→ 11
```

**What the evidence eliminates.** The pins are real names (not `<placeholders>`), all `workspace_name` values for this workspace are empty (guard should no-op), the parser regex (`planMetadataUtils.ts:102`) was inspected and tolerates plain/list-item/numbered/blockquote forms case-insensitively, and `record.workspaceId` matched the projects row's `workspace_id` in every failing row examined. What survives all of it is the **resolve-miss class**: the in-process lookup misses against a snapshot that differs from what the same statement's write later commits — some flavor of sql.js instance/snapshot divergence (`_instancesByDbPath` dedupes per resolved path *string*, so two path spellings of one file create two instances — the exact hazard the code documents at KanbanDatabase.ts:6156-6159; `_reloadIfStale` runs on every `ensureReady()` but is stat-debounced and can fail, logging `"Reload from disk failed"`).

**Why this plan no longer tries to name the exact flavor first:** the divergence mechanics are only observable inside the live, long-running extension-host process (a fresh headless repro loads the on-disk file — which contains the projects row — and resolves fine). Pinning down the flavor requires an instrumented build running in the user's window, which cannot happen in the middle of an unattended coding dispatch. The fix below therefore targets the *class*, not the flavor: resolve inside the INSERT so lookup and write share one snapshot by construction — correct under a healthy snapshot, self-healing under a divergent one — and ship permanent tripwires so any residual non-resolve-miss mechanism identifies itself in logs on its next natural occurrence.

### Hypotheses already excluded — do not re-test these

| Hypothesis | Why it's dead |
| :--- | :--- |
| Watcher read a partially-written file | Pin byte-offset does not predict failure (failures at offset 106 and 14054; successes at 134 and 5588). Every failing row had `created_at == updated_at`, i.e. a single insert pass — no create-then-change double import. |
| The `projects` row didn't exist yet | `Website` id 10 created 2026-07-13, `Browser Switchboard` id 11 created 2026-07-17; every affected plan imported after both. |
| Pin syntax / list-item prefix | Across 1,395 files: list-item form 7 applied / 7 empty, plain form 7 applied / 5 empty — no correlation. Both styles failed live. Parser regex additionally inspected in review: tolerant of both forms, case-insensitive, trims the capture. |
| Stale installed build (src fixed, build old) | The running bundle's `insertFileDerivedPlan`, `_resolveProjectForInsert`, `getProjectIdByName`, `_isWorkspaceName` and `getDistinctWorkspaceNamesUnion` were disassembled and are logically identical to `src/`. Repo and installed both report 1.7.13. |
| Write mechanics | In-place single-shot write and atomic rename from outside the watched directory behave identically — both fail. |
| The workspace-name guard matching by accident | All `workspace_name` values for this workspace are empty, and `getDistinctWorkspaceNamesUnion` filters `!= ''`, so the guard should no-op. Ranked unlikely but not conclusively excluded — covered by a permanent DROP tripwire rather than pre-fix diagnosis. |

### Historical note

Of 26 corpus files whose pin names a real project, 14 show the pinned project. Given the pin demonstrably does not work now, those are more consistent with precedence #2 — `kanban.activeProjectFilter`, the active board project at insert time (KanbanDatabase.ts:1994-2010) — having been populated when those plans imported. That key is currently empty in this DB, which is why nothing rescues the miss today. The permanent tripwires settle this question passively over time; it does not gate the fix.

## Metadata

- **Complexity:** 6
- **Tags:** backend, database, bugfix, reliability
- **Project:** Browser Switchboard

## User Review Required

- **Approach changed during review (see superseded callout in Proposed Changes):** the original diagnose-first structure required a live-window reproduction mid-dispatch, which is incompatible with single-shot unattended coding. The structural fix ships without first proving which divergence flavor fired. The trade-off is explicit: we may never learn the exact mechanism of the 9/9 failures — in exchange, the resolve-miss class becomes impossible by construction, and any *other* mechanism identifies itself in logs on its next occurrence while the sibling's fill fix makes it recoverable meanwhile. Veto if you want the diagnosis session first instead.
- **Post-merge acceptance is yours, not the coder's:** after installing the built extension, author one pinned plan and check the row (Manual Verification step 1). If it still lands unassigned, the tripwire logs now say exactly why — paste them into a follow-up.

## Complexity Audit

### Routine

- The tripwire log lines and the regression/contract tests follow existing repo patterns.
- The subquery-in-INSERT shape is probe-verified against the vendored sql.js and mirrors the existing name-join pattern (KanbanDatabase.ts:670-672).

### Complex / Risky

- **Load-bearing SQL on the hottest import path.** `insertFileDerivedPlan` runs for every plan import (1,395 files on this board). The computed `project`/`project_id` expressions must preserve resolve-only semantics exactly (unknown pin → `('', null)`, never a minted `projects` row, never the stranded name-without-id state).
- **Two of the three original exits are shared code.** `getProjectIdByName` is used by `resolveProjectId`, `addProject`, `ensureProjectExists` and the board's own filters; `_isWorkspaceName` guards every insert path. This plan deliberately leaves both untouched — the TS-side resolution stays primary; the SQL fallback only catches what it missed.
- **The failure being fixed is invisible.** Nothing logs, nothing throws today. The regression test must assert the *applied* path, and the tripwires must survive into the merged build (downgraded, not deleted).

## Edge-Case & Dependency Audit

### Race Conditions

- The whole point of the fix: resolution and write happen in **one statement on one snapshot**, eliminating the lookup/write divergence window entirely. No new async boundary is introduced; `_resolveProjectForInsert` still runs before the statement as the primary (guards + activeProjectFilter precedence), and the SQL fallback re-resolves atomically only when the TS side came back null.

### Security

- No new input surface. The pin only reaches the SQL binding after passing the existing placeholder and workspace-name guards; an unknown name simply misses the subquery and lands `('', null)`.

### Side Effects

- **Tripwires must be signal, not noise.** The engine-side anomaly line fires only when the file *contains* a `**Project` marker but the parser extracted nothing (a genuine anomaly, near-zero frequency). The DB-side DROP lines fire only on drops. No per-import APPLY logging survives to merge.
- **Perf:** the fallback subquery executes only when the TS lookup returned null (bound id short-circuits via `COALESCE`), and the `projects` table is tiny; cost on the healthy path is nil.

### Dependencies & Conflicts

- **Do not "fix" it by auto-creating the project.** Resolve-only is deliberate: only the user creates projects, via `addProject`. An unknown pin must still drop to unassigned. The import guard is the backstop against phantom projects and must survive — the regression test asserts it.
- **Sibling subtask (apply-if-empty fill) — same coding session, implement first.** Its fill CASE and this plan's computed `excluded.*` values compose in the same ON CONFLICT statement; the exact combined shape (subquery-computed VALUES + fill CASE keyed on `plans.project = ''` with the `feature_id` guard) is probe-verified (see Resolved Assumptions). Shared files: `insertFileDerivedPlan`'s SQL (both edit it — write it once, together), `PlanIngestionEngine.ts` (sibling ~795, this plan ~705), `package.json` (one script line each).
- **Multi-workspace:** the subquery binds the same `record.workspaceId` the row is written with, so a systematically wrong `workspaceId` would make both miss consistently — that residual case is exactly what the DROP tripwire's `wsId` field exposes.
- **Build/deploy:** the running extension serves from `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/`; the fix is live only after build + sync + reload. That is the user's post-merge acceptance step, not a mid-dispatch gate.

## Dependencies

- None (no session dependencies; in-session ordering with the sibling is recorded in the feature file's Dependencies & sequencing).

## Adversarial Synthesis

Key risks: (1) the computed SQL expressions drifting from resolve-only semantics (minting nothing must stay guaranteed; name-without-id must stay unrepresentable); (2) shipping a class-level fix means the exact historical mechanism may never be named — mitigated by permanent DROP/anomaly tripwires that make any residual failure self-identifying; (3) same-statement collision with the sibling's fill CASE — mitigated by writing the combined statement once in the same session, locked by both contract tests plus the probe-verified combined shape.

## Resolved Assumptions

Settled empirically this session (2026-07-30) — do not re-flag or re-research:

- Vendored sql.js bundles **SQLite 3.49.1**; a scalar subquery inside `INSERT … VALUES` works, and `excluded.project_id` in the ON CONFLICT clause reflects the subquery-computed value. The probe exercised the exact combined shape this feature ships: subquery-computed VALUES + apply-if-empty CASE (fill `''→name` with id ✓, no-move on different pin ✓, subtask-skip via `feature_id` condition ✓).
- `parsePlanMetadata`'s project regex (`planMetadataUtils.ts:102`) accepts plain, list-item, numbered, and blockquote pin forms, case-insensitively, and trims the capture (CRLF-safe).

## Proposed Changes

> **Superseded:** the original plan structure — temporary instrumentation of all resolver exits, a live reproduction gated as "do not write the fix before the `[pin]` line exists", then a fix shape chosen per observed exit (instance coherency / argument mismatch / guard collision / parse loss).
> **Reason:** the reproduction requires building, syncing to the installed extension, reloading the user's live window, and reading exthost logs — steps only the user's environment can perform. The feature dispatches to one coder, all subtasks in one unattended pass; a mid-dispatch human gate makes the plan undispatchable in that model. Meanwhile the evidence already narrows the live mechanism to the resolve-miss class, and a same-snapshot fix defeats that entire class without needing to know which flavor fired.
> **Replaced with:** ship the structural fix (Change 1) plus permanent, gated observability (Change 2) plus headless tests (Changes 3–4) in one pass. The diagnosis value is preserved by the tripwires: if a residual mechanism ever fires again, its log line names it — no instrumented rebuild needed.

### 1. `src/services/KanbanDatabase.ts` — same-snapshot fallback resolution in `insertFileDerivedPlan`

`_resolveProjectForInsert` stays exactly as-is (placeholder guard, workspace-name guard, activeProjectFilter precedence, resolve-only). What changes: the INSERT no longer trusts the TS lookup as the *only* resolution attempt. Bind an `effectiveName` — the TS-resolved name if non-empty, otherwise the guard-passed pin (empty string when there was no usable pin) — and compute both columns in SQL:

```ts
        const { project: resolvedProject, projectId: resolvedProjectId } =
            await this._resolveProjectForInsert(record, isExisting);
        // Same-snapshot fallback: if the TS lookup missed (resolvedProjectId null)
        // but a guard-passed pin exists, let the INSERT re-resolve it atomically
        // against the same image the write commits to. A lookup and a write in one
        // statement cannot see two different snapshots — this closes the
        // resolve-miss class (silent unassigned imports) by construction.
        const guardPassedPin = await this._guardPassedPin(record); // trimmed pin, or '' (placeholder/ws-name guards applied; NO getProjectIdByName call)
        const effectiveName = resolvedProject !== '' ? resolvedProject : guardPassedPin;
```

```sql
            INSERT INTO plans (
                plan_id, session_id, topic, plan_file, kanban_column, status, complexity, tags,
                repo_scope, project, project_id, workspace_id, created_at, updated_at, last_action, source_type,
                brain_source_path, mirror_path, routed_to, dispatched_agent, dispatched_ide,
                clickup_task_id, linear_issue_id, notion_page_id, workspace_name, is_feature
            ) VALUES (?, ?, ?, ?, 'CREATED', 'active', ?, ?, '',
                -- project: only ever non-empty when the id resolves in this same
                -- statement — the stranded name-without-id state is unrepresentable.
                CASE WHEN COALESCE(?, (SELECT id FROM projects WHERE name = ? AND workspace_id = ?)) IS NOT NULL
                     THEN ? ELSE '' END,
                -- project_id: TS-resolved id when the lookup hit; same-snapshot
                -- subquery otherwise. Resolve-only: an unknown name misses both
                -- and lands NULL — no projects row is ever minted here.
                COALESCE(?, (SELECT id FROM projects WHERE name = ? AND workspace_id = ?)),
                ?, ?, ?, '', ?, '', '', '', '', '', '', '', '', ?, ?)
```

with bindings `[resolvedProjectId, effectiveName, record.workspaceId, effectiveName, resolvedProjectId, effectiveName, record.workspaceId, …]`. When `effectiveName` is `''` both subqueries miss and the columns land `('', NULL)` — identical to today's unpinned behavior. When the TS lookup hit, `COALESCE` short-circuits and behavior is byte-identical to today's healthy path. The new `_guardPassedPin` helper extracts the existing placeholder + workspace-name checks (reusing them, not duplicating) and never calls `getProjectIdByName` — the whole point is that the *name→id* step moves into the statement.

The ON CONFLICT clause is written **once, jointly with the sibling subtask** (same session): these computed VALUES feed `excluded.project` / `excluded.project_id`, and the sibling's apply-if-empty CASE consumes them. Combined shape probe-verified.

### 2. Permanent tripwires (survive to merge, gated to near-zero noise)

**2a. `KanbanDatabase._resolveProjectForInsert`** — `console.debug` on each DROP exit, each line carrying `this.instanceId` (the diagnostic id added for the is_feature-clobber investigation — if lines for one `kanban.db` ever show two instance ids, the path-divergence flavor is confirmed for free):

```ts
                console.debug(`[pin] ${this.instanceId} DROP placeholder pin=${JSON.stringify(pin)} file=${record.planFile}`);
                console.debug(`[pin] ${this.instanceId} DROP workspace-name-guard pin=${JSON.stringify(pin)} wsId=${record.workspaceId}`);
                console.debug(`[pin] ${this.instanceId} DROP resolve-miss pin=${JSON.stringify(pin)} wsId=${record.workspaceId} visibleProjects=${JSON.stringify(await this.getAllProjectNamesForDebug(record.workspaceId))}`);
```

(`getAllProjectNamesForDebug` as originally specified, kept private-ish but permanent; the `projects` table is tiny.) Note the resolve-miss DROP can now only fire when the *same-statement* subquery would also decide — its `visibleProjects` dump remains the forensic record of what the in-memory image saw. These lines land in the editor's **extension-host log** (`console.*` does not reach the Switchboard output channel).

**2b. `PlanIngestionEngine._handlePlanFile`** — one anomaly line via the host logger (this one *does* reach the Switchboard output channel), immediately after `parsePlanMetadata` (line 705), fired only when the file visibly carries a pin marker the parser didn't extract:

```ts
            if (!metadata.project && /\*\*Project\b/i.test(content)) {
                this._host.logger.appendLine(
                    `[GlobalPlanWatcher] [pin-parse] file contains a **Project marker but no pin was parsed: ${relativePath}`
                );
            }
```

This closes the zeroth-exit blind spot permanently: parse/plumbing loss can never again fail silently.

### 3. `src/test/project-pin-resolve-contract.test.js` — regression test (headless, no live window needed)

```js
'use strict';
/**
 * Contract: a pin naming an existing project in the plan's workspace RESOLVES
 * on first insert — including when the caller's TS-side lookup came back null
 * (the same-snapshot fallback). Measured before the fix: 9 of 9 fresh imports
 * with a valid pin landed project='' / project_id=null, silently.
 */
await db.addProject(wsId, 'Contract Project');

// Healthy path: TS lookup resolves, first insert lands assigned.
await db.insertFileDerivedPlan({ ...rec, project: 'Contract Project', projectId: null });
const row = await db.getPlanByPlanId(rec.planId);
assert.strictEqual(row.project, 'Contract Project', 'valid pin did not resolve on first insert');
assert.ok(row.projectId != null, 'project name stored with null project_id — strands the card on both filter paths');

// Same-snapshot fallback: statement-level resolution with a null bound id.
// Drive the raw statement shape with resolvedProjectId=null and the pin bound
// (mirrors the probe): the subquery must resolve name AND id together.
// (Implement as a direct-statement test against an in-memory instance.)

// Resolve-only survives the fix.
await db.insertFileDerivedPlan({ ...rec2, project: 'Phantom Project', projectId: null });
const row2 = await db.getPlanByPlanId(rec2.planId);
assert.strictEqual(row2.project, '');
assert.strictEqual(await db.getProjectIdByName(wsId, 'Phantom Project'), null, 'resolve-only broken: pin minted a projects row');

// The stranded state is unrepresentable: non-empty name always has an id.
const stranded = await db.allPlansWithProjectButNoId?.(wsId) ?? [];
assert.strictEqual(stranded.length, 0, `${stranded.length} plans have a project name with no project_id`);
```

### 4. `package.json` — register the test

```json
    "test:contract:project-pin-resolve": "node src/test/project-pin-resolve-contract.test.js",
```

(One line each from this plan and the sibling — written in the same session, no merge conflict in practice.)

## Verification Plan

Per session directive (SKIP COMPILATION / SKIP TESTS), compilation and automated-test execution are **not** part of this plan's verification pass; the tests are authored as deliverables and run in CI / the implementer's pipeline.

### Automated Tests

Authored, not run in this workflow:

1. `test:contract:project-pin-resolve` — first-insert resolution, same-snapshot fallback at the statement level, resolve-only survival, stranded-state unrepresentability. Mutation check for the implementer's pipeline: revert the SQL to plain bound values and confirm the fallback assertion fails.
2. `test:contract:project-pin-fill` (the sibling's recoverability contract) — must stay green against the jointly-written statement.
3. The repo's standing gates (`verb-returns:check`, `push-routing:check`, `catalog:check`, `lint`) run in the implementer's pipeline; `catalog.json` line numbers shift with this edit.

### Manual Verification (user's post-merge acceptance, after build + sync + reload)

4. Author a plan file with `**Project:** Browser Switchboard` and let the watcher import it. `sqlite3 .switchboard/kanban.db "SELECT project, project_id FROM plans WHERE plan_file LIKE '%<name>%';"` → `Browser Switchboard | 11` on the **first** import, with no API call.
5. The card appears on the board under Browser Switchboard without a refresh-and-hope cycle.
6. Author a plan pinned to `No Such Project` → lands unassigned, appears under Unassigned, and `SELECT * FROM projects` gained no row.
7. Board-wide invariant: `SELECT COUNT(*) FROM plans WHERE project <> '' AND project_id IS NULL;` → `0`.
8. Backfill the 7 known-stuck cards by touching their files; each resolves to its pinned project with a non-null id (exercises the sibling's fill path against this fix).
9. **If step 4 ever still lands unassigned:** grep the Switchboard output channel for `[pin-parse]` and the editor's exthost log for `[pin]` — the tripwires name the residual mechanism; paste the lines into a follow-up plan.

---

**Recommendation:** Complexity 6 → **Send to Coder**.

### Completion Report
I have successfully implemented this plan. I modified `src/services/KanbanDatabase.ts` to perform atomic statement-level fallback resolution of project names and IDs within the `insertFileDerivedPlan` query. I added parser-level and database-level tripwire logs to track anomalies and resolution drops, and registered a contract test `project-pin-resolve-contract.test.js` under `test:contract:project-pin-resolve`. No issues were encountered during this work.
