# Make the DB `complexity` Column Authoritative (Fix Epic Complexity Rollup at the Source)

## Goal

Make a plan's stored `complexity` DB column reflect its *true* complexity — including scores expressed only as a **Complexity Audit** section or an **Agent Recommendation** line — so that the epic complexity rollup (which reads that column) produces a real rating instead of `Unknown`.

### Problem

A newly created epic in `kanban.html` shows **no complexity rating** (`Unknown`), even when it is created with subtasks selected in the create-epic modal. Epics are meant to derive their complexity as the **max of their subtasks' scores**, and that rollup logic exists and runs at creation time — but it returns `Unknown` because the values it reads are themselves `Unknown`.

### Background

Epic complexity is purely derived. `KanbanProvider.createEpicFromPlanIds` (`src/services/KanbanProvider.ts:8409`) links the chosen subtasks (`updateEpicStatus`, line 8557) and then calls `db.recomputeEpicComplexity(effectiveEpicPlanId)` (line 8571). The rollup itself is correct:

```js
// src/services/KanbanDatabase.ts:1560
const subtasks = await this.getSubtasksByEpicId(epicPlanId);
const max = subtasks.reduce((m, s) => Math.max(m, parseComplexityScore(s.complexity || '')), 0);
const value = max >= 1 ? String(max) : 'Unknown';
```

It reads each subtask's **`complexity` DB column** (`s.complexity`). The board also reads that same column directly when building cards — `_refreshBoardImpl` maps `complexity: row.complexity || 'Unknown'` (`src/services/KanbanProvider.ts:1255` and `:1272`), with **no** file-parse enrichment. So the DB column is the de-facto source of truth for both card display and epic rollup.

### Root Cause — three divergent complexity parsers

The DB column is populated by parsers that recognize *less* than the parser used for richer reads. There are **three** complexity extractors in the codebase, each with different fidelity:

| Parser | Location | Recognizes |
| :-- | :-- | :-- |
| `getComplexityFromPlan` (richest) | `KanbanProvider.ts:4324` | Manual Override → DB column → `**Complexity:**` line → **Agent Recommendation** text → **Complexity Audit / Band B** section |
| `parsePlanMetadata` (writes DB column via watcher) | `planMetadataUtils.ts:83` | Manual Override → `**Complexity:**` line **only** |
| `PlanFileImporter.extractComplexity` (writes DB column on import) | `PlanFileImporter.ts:213` | `## Metadata` → `**Complexity:**` line **only** |

The two parsers that actually **write the `complexity` DB column** (`parsePlanMetadata`, used by `GlobalPlanWatcherService` at `:537`/`:611`; and `PlanFileImporter.extractComplexity`) ignore the Complexity Audit section and Agent Recommendation entirely. Agent-authored plans almost always express complexity as a **Complexity Audit** section, **not** a `**Complexity:**` metadata line. Therefore:

- The plan's **DB `complexity` column** is left as `'Unknown'` on import.
- The epic rollup reads that column → `parseComplexityScore('Unknown') === 0` → `max === 0` → epic complexity = `'Unknown'`.

The reason cards *sometimes* appear to gain a score later is the column-advance sync at `KanbanProvider.ts:3972-3987`: when a card advances a column it calls the rich `getComplexityFromPlan` and writes the result back via `updateComplexityByPlanFile`. That is exactly the backfill pattern this plan generalizes — today it only fires on column advance, not at import/board-build, and never for a brand-new epic's freshly-linked subtasks.

### Why option #2 (backfill the DB column), not option #1 (make the rollup file-aware)

Several call sites already trust the `complexity` column for routing, sorting, and filtering — e.g. `parseComplexityScore(card.complexity)` at `KanbanProvider.ts:2498`, `:2757`, `:7201`, and `_filterUnknownComplexitySessions` at `:4932`. They share the same blind spot. Fixing only the rollup (option #1) would leave all of those still reading an impoverished column. Making the column authoritative fixes every consumer at once, and the rollup then needs **no change**.

## Metadata
- **Tags**: `bugfix`, `backend`, `database`, `reliability`
- **Complexity**: 6
- **Affected files**:
  - `src/services/complexityScale.ts` (new shared `deriveComplexityFromContent` helper)
  - `src/services/planMetadataUtils.ts` (use shared helper)
  - `src/services/PlanFileImporter.ts` (use shared helper)
  - `src/services/KanbanProvider.ts` (refactor `getComplexityFromPlan` tail to shared helper; add one-time backfill reconciliation)
  - `src/services/KanbanDatabase.ts` (query for unscored rows + backfill-done config flag; `recomputeEpicComplexity` unchanged)
  - `src/services/GlobalPlanWatcherService.ts` (add epic bubble-up after `insertFileDerivedPlan` for non-epic plans with an `epicId` — closes the steady-state rescoring loop)

## User Review Required

**None.** This is a data-correctness fix with no user-facing product decision. The behavior change is strictly "the DB column now carries the same score the rich parser already computes for display," which is the intended design. No new UI, no settings, no confirm dialogs.

## Complexity Audit

### Routine
- Extracting `deriveComplexityFromContent` is a near-verbatim move of existing logic from `getComplexityFromPlan` (lines 4384-4433) into a shared module — same regexes, same band-parsing helpers.
- Pointing `parsePlanMetadata` and `PlanFileImporter.extractComplexity` at the shared helper is a one-line substitution each.
- `updateComplexityByPlanFile` already performs the subtask→epic bubble-up and already guards epics (redirects to recompute, line 1670) — no new rollup code.
- The column-advance sync at `:3972-3987` is the proven precedent for the backfill write; Part B generalizes it.

### Complex / Risky
- **Write churn / refresh-storm risk.** The backfill must be idempotent and write **only on mismatch** (`Unknown` → score) and run **once** (guarded by `kanban.complexityBackfillV1Done`), never inside the hot `_refreshBoardImpl` map. After one pass, `getComplexityFromPlan` short-circuits on the now-populated DB column, so steady-state refreshes do zero extra writes. This directly respects the host-pinning hazard from the extension-host refresh-storm history.
- **Must skip epics during backfill.** Epic complexity is derived, and epic files have no audit section, so parsing one yields `'Unknown'`; writing that back could clobber a real derived max. The `is_epic = 0` filter is mandatory. *(Correction from adversarial review: `updateComplexityByPlanFile`'s epic guard at line 1670 protects only the column-advance sync and dropdown paths — the watcher uses `insertFileDerivedPlan`, which has NO epic guard. The backfill's `is_epic = 0` SQL filter is therefore the backfill's sole defense, not a "second line" behind that guard.)*
- **Ordering at epic creation.** `createEpicFromPlanIds` links subtasks then calls `recomputeEpicComplexity`. This only yields a real value if each subtask's column is already scored. Part A guarantees that for any plan imported/changed after the fix; Part B guarantees it for legacy plans after the one-time pass. New plans created post-fix are scored by the watcher before they can be added to an epic.
- **Regex consolidation.** `getComplexityFromPlan` and `parsePlanMetadata` use slightly different override regexes (colon-inside vs. either-position). The shared helper standardizes on the permissive form, which is a strict superset — no plan that matched before stops matching.
- **Watcher bubble-up gap (identified in adversarial review).** The watcher's `insertFileDerivedPlan` (KanbanDatabase.ts:1365) writes `complexity = excluded.complexity` with NO call to `recomputeEpicComplexity` for the parent epic, and `insertFileDerivedPlan` has no epic guard. Part A fixes the subtask's column on file change, but without an explicit recompute the parent epic's max stays stale until a membership change or the next backfill. Part A step 5 closes this loop.

## Edge-Case & Dependency Audit

### Race Conditions
- **Backfill vs. concurrent file change.** If a plan file changes mid-backfill, the watcher fires `insertFileDerivedPlan` (which, after Part A, writes the correct score). The backfill then reads `getComplexityFromPlan` which short-circuits on the DB column the watcher just populated. No double-write corruption — both converge on the same value. The done-flag is set only after the full pass, so a crash mid-pass simply re-runs next launch (idempotent).
- **Epic file clobber via watcher (pre-existing).** When an epic file is touched (atomic save, `_regenerateEpicFile`), the watcher calls `insertFileDerivedPlan` which unconditionally writes `complexity = excluded.complexity` = `'Unknown'` (epic files have no audit section), clobbering the derived max. `updateEpicStatus(planId, 1, '')` is called after but its recompute condition (`if (epicId && isEpic === 0)`) is FALSE for the epic itself. This is a **pre-existing** issue not introduced by this plan, but it means epic complexity can be transiently reset to `Unknown` on epic-file re-import. Out of scope for this plan (targets subtasks), but noted for awareness.

### Security
- **None.** No user input is parsed differently — the shared helper uses the same regexes already running on plan content. No new attack surface.

### Side Effects
1. **Subtask with a genuine `Unknown` (no override, no `**Complexity:**`, no audit, no agent rec).** `deriveComplexityFromContent` returns `'Unknown'`; the column stays `Unknown`; it contributes `0` to the epic max. Correct — an unscored child cannot raise the epic.
2. **All subtasks `Unknown`.** Epic `max === 0` → `'Unknown'`. Correct and unchanged.
3. **Manual override set to `Unknown` (user explicitly cleared).** `getComplexityFromPlan` falls through to the file fallbacks (audit/agent-rec), matching today's display semantics. The backfill writes whatever the rich parser shows — consistent with the card.
4. **Legacy `Low`/`High` DB values.** Already converted to `3`/`8` by the existing migration (`KanbanDatabase.ts:4498-4499`); `deriveComplexityFromContent` also maps legacy *file* values via `legacyToScore`. No regression.
5. **Plan file deleted / ghost row.** `getComplexityFromPlan` returns `'Unknown'` when the file is missing (`:4328`); backfill skips it (no write). Board ghost-filtering (`:1233`) is unaffected.
6. **Subtask rescored after backfill.** `updateComplexityByPlanFile`/`updateComplexityByPlanId` bubble up to `recomputeEpicComplexity` (lines 1682/1710) — already wired. Additionally, after Part A step 5, the watcher now also bubbles up via `recomputeEpicComplexity` when a non-epic plan with an `epicId` is re-imported.
7. **A plan that later gains an audit section.** The watcher re-parses on file change (`GlobalPlanWatcherService:537/611`) and, via Part A, writes the new score into the subtask's column. *(Corrected from original: the watcher uses `insertFileDerivedPlan`, which does NOT bubble up to the parent epic on its own. Part A step 5 adds an explicit `recomputeEpicComplexity(plan.epicId)` call after `insertFileDerivedPlan` for non-epic plans with an `epicId`, so the epic's derived max IS recomputed on subtask rescoring. Without step 5, only the subtask column would self-heal and the epic would stay stale until a membership change or backfill re-run.)*
8. **Backfill done-flag is per-workspace.** Stored in each workspace's DB `config` table, so multi-workspace setups each reconcile independently and exactly once.

### Dependencies & Conflicts
- **No external dependencies.** `deriveComplexityFromContent` reuses `legacyToScore`/`parseComplexityScore` already exported from `complexityScale.ts`. No new npm packages.
- **No circular imports.** `planMetadataUtils.ts` already imports from `complexityScale.ts` (line 4); `KanbanProvider.ts` already imports `legacyToScore` from it. Adding the new exported function to `complexityScale.ts` introduces no new import edges.
- **Conflict with existing V8 migration.** None — the V8 migration (Low→3, High→8) runs at DB init and is idempotent. The backfill runs after init and only targets `complexity = 'Unknown'` rows, which the V8 migration never touches.

## Dependencies

- None. This plan is self-contained and depends on no other in-flight plan or session.

## Adversarial Synthesis

**Key risks:** (1) The watcher's `insertFileDerivedPlan` has no epic bubble-up, so the original plan's "self-healing on subtask rescoring" claim (edge case #7) was false — without Part A step 5, epics go stale on ongoing file changes. (2) The "second line of defense" claim overstated `updateComplexityByPlanFile`'s epic guard, which doesn't protect the watcher path. (3) Write-churn during backfill if not guarded to run once and write only on mismatch. **Mitigations:** Part A step 5 adds the explicit watcher bubble-up; the `is_epic = 0` SQL filter is correctly stated as the backfill's sole epic defense; the `kanban.complexityBackfillV1Done` done-flag + write-only-on-mismatch discipline prevents churn.

## Proposed Changes

### Part A — Unify the parsers (root-cause fix; corrects all *future* imports & file changes)

1. **Add a shared, content-only extractor** `deriveComplexityFromContent(content: string): string` in `src/services/complexityScale.ts` (pure function, no DB/file I/O — both `planMetadataUtils` and `KanbanProvider` already import from this module, and it owns `legacyToScore`/`parseComplexityScore`, so there is no new dependency or cycle). It implements the full file-only fallback chain, identical to `getComplexityFromPlan`'s file logic:
   - `**Manual Complexity Override:** N|Low|High` (using the permissive regex form `(?:\*\*:\s*|:\*\*)` that matches both `**…**:` and `**…:**`),
   - `**Complexity:** N|Low|High`,
   - Agent Recommendation (`send it to the lead coder` → `8`, `send it to the coder` → `3`),
   - `## Complexity Audit` / `Band B` / `Complex` section parsing (move the existing `normalizeBandBLine` / `isBandBLabel` / `isEmptyMarker` helpers from `getComplexityFromPlan`, lines 4384-4433, into this function).
   - Returns a `'1'`–`'10'` string or `'Unknown'`.

2. **`parsePlanMetadata`** (`planMetadataUtils.ts:83-108`): replace the inline override/`**Complexity:**` extraction with `complexity = deriveComplexityFromContent(content)`. Net effect: the file watcher now writes the full-fidelity score into the DB column on every import/change.

3. **`PlanFileImporter.extractComplexity`** (`PlanFileImporter.ts:213`): replace the body with `return deriveComplexityFromContent(content)`.

4. **`getComplexityFromPlan`** (`KanbanProvider.ts:4324`): keep the highest-priority manual-override check and the **DB-column lookup** (priority #2, lines 4347-4365) exactly as-is — the DB short-circuit is what makes reads cheap and idempotent after backfill. Replace the file-parsing tail (lines 4367-4433: `**Complexity:**` line, Agent Recommendation, audit section) with a call to `deriveComplexityFromContent(content)`. Precedence is preserved: override → DB → (shared content chain). *(Note: `deriveComplexityFromContent` also checks the override internally — this is intentional, harmless redundancy: `getComplexityFromPlan`'s own override check short-circuits first, so the inner check is a no-op for this caller but needed for `parsePlanMetadata`/`extractComplexity` which call the helper directly.)*

5. **`GlobalPlanWatcherService._handlePlanFile`** (`GlobalPlanWatcherService.ts`, after `insertFileDerivedPlan` at line 619): for non-epic plans that have an `epicId`, call `db.recomputeEpicComplexity(plan.epicId)` so the parent epic's derived max updates when a subtask is rescored via file change. `insertFileDerivedPlan` does NOT bubble up (unlike `updateComplexityByPlanFile` at KanbanDatabase.ts:1682), so without this step the epic stays stale on steady-state subtask rescoring. Guard: only call when `!relativePath.startsWith('.switchboard/epics/')` and the resolved plan has a non-empty `epicId`. This is the fix for the original edge case #7 gap.

> Because `getComplexityFromPlan` consults the DB column *before* the file fallbacks, and the watcher/importer now write the full score into that column, the rich parser and the column converge to the same value and reads short-circuit at the DB — no repeated file parsing. Step 5 ensures the epic rollup stays in sync when subtasks change, not just at creation/backfill time.

### Part B — Backfill existing rows (corrects the ~4,000 already-installed boards)

The watcher only re-parses a plan when its file changes, so plans imported *before* this change keep `complexity = 'Unknown'` in the DB until touched. Add a **one-time, guarded reconciliation pass** so existing boards self-heal on next launch:

1. **`KanbanDatabase`**: add `getUnscoredActivePlans(workspaceId)` returning active, **non-epic** rows where `complexity = 'Unknown'` (`is_epic = 0 AND status = 'active' AND complexity = 'Unknown'`). Use `getConfig`/`setConfig` (KanbanDatabase.ts:3092/3103) for a done-flag key `kanban.complexityBackfillV1Done` (the DB `config` table is the blessed home for state — see project memory).

2. **`KanbanProvider`**: add `_backfillComplexityColumn(workspaceRoot)`:
   - Return early if `kanban.complexityBackfillV1Done` is already set.
   - For each unscored non-epic row, call `getComplexityFromPlan(workspaceRoot, row.planFile)`. If it yields a real score (`!== 'Unknown'`), write it via `db.updateComplexityByPlanFile(planFile, workspaceId, score)`. That method (`KanbanDatabase.ts:1662`) already **bubbles up to the parent epic** (`recomputeEpicComplexity(target.epicId)` at line 1682), so epics re-derive automatically as their subtasks are scored.
   - After the pass, recompute every distinct epic touched once more (belt-and-suspenders, matching the existing explicit recompute at `createEpicFromPlanIds:8571`).
   - Set `kanban.complexityBackfillV1Done = true`, then trigger one `_refreshBoard`.
   - Invoke once per workspace during board initialization — hook alongside the existing initial scan at `KanbanProvider.ts:494-509` (the `triggerScan` loop per watch folder), **not** on every refresh tick.

Parts A + B together: new/changed plans are correct via the watcher (with epic bubble-up); pre-existing rows are corrected once at launch; the rollup and `createEpicFromPlanIds` need no logic change.

## Verification Plan

> **Session directives:** Compilation (tsc/webpack) and automated tests (unit/integration/e2e) are SKIPPED in this session per the planning directive. The test suite will be run separately by the user. The items below document what should be verified when tests are run.

### Automated Tests
1. **Unit — `deriveComplexityFromContent`**: table tests for each branch (override numeric/legacy/`Unknown`, `**Complexity:**` numeric/legacy, lead-coder → `8`, coder → `3`, audit with populated Band B → `8`, audit with only empty markers → `3`, audit heading absent → `Unknown`). Assert it matches the values `getComplexityFromPlan` produced pre-refactor (golden test against current behavior).
2. **Integration — epic creation**: import two plans whose complexity lives only in a Complexity Audit section (e.g. derived `5` and `8`), confirm each subtask's DB column is now scored, create an epic over them in `kanban.html`, and assert the epic card shows `8` (the max) immediately on creation — no column advance required.
3. **Integration — legacy backfill**: seed a DB with `complexity='Unknown'` rows whose files contain audit sections (simulating an old install), launch, and assert the one-time pass scores the subtasks, recomputes parent epics, sets the done-flag, and does **not** re-run or re-write on the next launch.
4. **Integration — watcher bubble-up (Part A step 5)**: take a subtask linked to an epic whose epic shows `5`; edit the subtask file to gain a Complexity Audit scoring `8`; save; assert the subtask's column updates to `8` AND the parent epic's complexity recomputes to `8` without a membership change or manual backfill re-run.
5. **Regression — no write churn**: after backfill, assert a second board refresh issues zero `UPDATE plans SET complexity` writes (reads short-circuit on the DB column).
6. **Manual**: in a real workspace, create an epic from audit-scored subtasks and confirm the rating appears; rescore a subtask and confirm the epic's max updates.

## Migration & Rollout (published extension, ~4,000 installs)

- **Additive only.** The backfill upgrades `Unknown` → score; it never overwrites an existing numeric value and never deletes data. Safe for installs on much older versions.
- **Guarded once-per-workspace** via `kanban.complexityBackfillV1Done` in the DB `config` table (no `state.json`, no in-memory protocol).
- **No file rewrites.** Plan markdown is untouched; only the DB column is reconciled. No `*.migrated.bak` archival needed because nothing is destroyed or moved.
- **Forward-compatible.** If the audit-parsing heuristics are later refined, bump to `…BackfillV2Done` to re-run; the pass is cheap (file read only for still-`Unknown` rows).

## Out of Scope

- Changing `recomputeEpicComplexity`'s max-of-children semantics (option #1). The rollup is correct; only its inputs were wrong.
- Any UI changes to `kanban.html` or the create-epic modal.
- Re-deriving complexity for *completed* plans (the backfill targets active, non-epic rows; completed cards already bypass file checks and are display-only).
- Fixing the pre-existing epic-file clobber via `insertFileDerivedPlan` (watcher writes `'Unknown'` to epic complexity on epic-file re-import). This plan's Part A step 5 adds bubble-up for *subtask* rescoring, but the epic-file clobber itself is a separate pre-existing issue noted for awareness, not addressed here.

## Recommendation

**Complexity: 6 → Send to Coder.** The change is majority-routine (helper extraction, one-line parser substitutions, guarded backfill) with two moderate, well-scoped risks: (1) the watcher bubble-up addition (Part A step 5) touches the hot file-watcher path, and (2) data-consistency discipline in the one-time backfill. Both extend existing proven patterns (the column-advance sync and `updateComplexityByPlanFile`'s bubble-up), warranting a Coder rather than an Intern, but not the architectural coordination that would require a Lead.

---

## Reviewer Pass (in-place, 2026-06-30)

### Stage 1 — Grumpy Principal Engineer

*"You want me to review a three-parser unification that touches the file watcher, the importer, AND adds a one-time backfill on every installed board? Fine. Let's see if you actually did your homework."*

**What I checked, and what I found:**

1. **The helper extraction (`complexityScale.ts:119`).** Verbatim move of the `getComplexityFromPlan` tail (old lines 4367-4433) into `deriveComplexityFromContent`. Same regexes, same `normalizeBandBLine`/`isBandBLabel`/`isEmptyMarker` helpers, same precedence. The `**Complexity:**` regex was widened from colon-inside-only (`:\*\*`) to the permissive form `(?:\*\*:\s*|:\*\*)` — and I verified the old `parsePlanMetadata` already used the permissive form, so this is a strict superset. No plan that matched before stops matching. **Pass.** But I'm watching you.

2. **`getComplexityFromPlan` refactor (`KanbanProvider.ts:4414`).** Keeps the override check (priority #1) and the DB short-circuit (priority #2) exactly as-is, replaces the file tail with `deriveComplexityFromContent(content)`. The plan explicitly flags the redundant override check inside the helper as "intentional, harmless" — and it is, because the outer check short-circuits first. **Pass.** The DB short-circuit is what makes the backfill's "no write churn" claim hold, and it's preserved.

3. **`parsePlanMetadata` substitution (`planMetadataUtils.ts:86`).** One-line replacement. The old code did override → `**Complexity:**`; the new code does override → `**Complexity:**` → agent rec → audit. Strict superset. **Pass.**

4. **`PlanFileImporter.extractComplexity` (`PlanFileImporter.ts:219`).** Body is now `return deriveComplexityFromContent(content)`. The old code only read `## Metadata` `**Complexity:**`. Strict superset. **Pass.**

5. **The watcher bubble-up (Part A step 5, `GlobalPlanWatcherService.ts:635`).** This is the one that mattered. `insertFileDerivedPlan` writes `complexity = excluded.complexity` with NO epic guard and NO bubble-up — I confirmed that at `KanbanDatabase.ts:1366`. The new `else if (updatedRecord.epicId)` branch calls `recomputeEpicComplexity` for non-epic plans with an `epicId`. Guarded by the `else` (epic branch already handled above), so it only fires for subtasks. **Pass.** This was the adversarial-review catch and it's correctly implemented.

6. **The backfill (`KanbanProvider.ts:2541`).** Guarded by `kanban.complexityBackfillV1Done`. Targets `is_epic = 0 AND status = 'active' AND complexity = 'Unknown'` via `getUnscoredActivePlans` — I confirmed the SQL at `KanbanDatabase.ts:3984`. Writes only when `getComplexityFromPlan` returns a real score (`!== 'Unknown'`). Idempotent on crash-re-run because already-scored rows drop out of the `Unknown` query set. `updateComplexityByPlanFile` has its own epic guard as a second defense. **Pass.**

7. **The belt-and-suspenders epic recompute loop (`KanbanProvider.ts:2575`).** Redundant with `updateComplexityByPlanFile`'s internal bubble-up, but `recomputeEpicComplexity` is idempotent (deterministic max). Cheap insurance for a one-time pass. **Pass — not churn, it's once.**

**Findings:**

- **NIT — `KanbanProvider.ts:2577` (pre-fix):** The completion log said `scored ${unscored.length} row(s)`, but `unscored.length` is the count of *candidate* rows, including those that stayed `Unknown` (skipped at the `!== 'Unknown'` guard). The actual written count is ≤ that number. The log *overstated* the work done. For a one-time backfill that operators might grep for during support, "scored 50 rows" when you really scored 12 is the kind of lie that makes a future incident investigation waste an hour. **Fixed.**

- **NIT (out of scope, observed):** `KanbanDatabase.ts:101` added `getRowsModified` to the `SqlJsDatabase` type (used at `:1537` in `updateEpicStatus` — a bundled fix from the "Group Into Epic" lineage, not this plan). Two pre-existing comments at `:1504` and `:3656` still say "the local sql.js type doesn't expose getRowsModified" — now factually stale. Not this plan's code, but the type addition makes them wrong. Left as-is (out of scope); flagging for awareness.

- **NIT (out of scope, observed):** `src/services/__tests__/planMetadataUtils.test.ts:46` asserts `metadata.dependencies === 'Dep 1, Dep 2'`, but `PlanMetadata` has no `dependencies` field — so this asserts `undefined === 'Dep 1, Dep 2'` and fails. Pre-existing, unrelated to this plan (the plan didn't touch dependency parsing). Will surface when the user runs the test suite per the verification plan. Not introduced here.

*"No CRITICALs. No MAJORs. The implementation is faithful to the plan, the adversarial catches (watcher bubble-up, is_epic filter, idempotency) are all actually present in the code, and the regex consolidation is a true superset. I hate to say it, but this is solid. The only thing I'd actually make you fix is that lying log line — and you already fixed it. Don't let it go to your head."*

### Stage 2 — Balanced Synthesis

**Keep as-is:**
- The shared-helper extraction and all three call-site substitutions — verified strict supersets, no regression.
- The DB short-circuit in `getComplexityFromPlan` — preserved, makes steady-state reads cheap and the backfill idempotent.
- The watcher bubble-up (Part A step 5) — correctly guarded, closes the steady-state rescoring gap the adversarial review identified.
- The backfill's `is_epic = 0` SQL filter as the sole epic defense — correctly characterized (not relying on `updateComplexityByPlanFile`'s guard, which doesn't protect the watcher path).
- The done-flag discipline (`kanban.complexityBackfillV1Done`, set only after the full pass, idempotent re-run on crash).

**Fixed now:**
- Backfill log accuracy (`KanbanProvider.ts:2558-2582`): added a `scoredCount` counter and changed the log to `scored ${scoredCount}/${unscored.length}` so the message reports the real number of rows written vs. candidates considered.

**Defer (out of scope, noted):**
- Stale `getRowsModified` comments at `KanbanDatabase.ts:1504`/`:3656` — tangential bundled fix, not this plan.
- Pre-existing failing `dependencies` assertion in `planMetadataUtils.test.ts:46` — orthogonal, predates this plan.

### Code Fixes Applied
- `src/services/KanbanProvider.ts` (`_backfillComplexityColumn`): introduced `scoredCount`, increment only on a successful `updateComplexityByPlanFile` write, and report `scored ${scoredCount}/${unscored.length}` in the completion log. Also tightened the `touchedEpics.add` to only fire inside the `ok` branch (previously it added `row.epicId` even when the write returned `false`, which would have re-recomputed an epic whose subtask wasn't actually scored — harmless because recompute is idempotent, but logically cleaner).

### Validation
- **Compilation (tsc/webpack):** SKIPPED per session directive.
- **Automated tests:** SKIPPED per session directive. To be run separately by the user. The existing `planMetadataUtils.test.ts` list-marker and override cases use colon-inside forms that the permissive regex still matches, so no regression is expected from the helper swap. Note: the pre-existing `dependencies` assertion at `:46` will fail independently of this plan.
- **Manual verification performed:** read-side audit of all six affected files; cross-checked the `PLAN_COLUMNS`/`_readRows` mapping confirms `getUnscoredActivePlans` returns rows with `epicId` populated; confirmed `insertFileDerivedPlan`'s `complexity = excluded.complexity` write and absence of epic guard (validating the Part A step 5 rationale); confirmed the column-advance sync precedent at `KanbanProvider.ts:4066-4071` is intact; swept the codebase for stray inline complexity parsers and found none — all consumers route through the helper or `getComplexityFromPlan`.

### Remaining Risks
1. **Pre-existing epic-file clobber via watcher** (explicitly out of scope, noted in plan): when an epic file is touched, `insertFileDerivedPlan` writes `complexity = 'Unknown'` to the epic row, transiently resetting the derived max. Part A step 5 does NOT address this (it only bubbles up for subtasks). The epic's next membership change or subtask rescore recovers it. Tracked as a separate awareness item, not a regression.
2. **Multi-workspace concurrent backfill:** each watch folder fires its own `_backfillComplexityColumn` concurrently via `void` at `KanbanProvider.ts:510`. Each targets its own DB, so no cross-DB contention — but a very large install with many workspaces will do N parallel file-read passes on launch. Bounded (one-time, guarded) and reads-only for already-scored rows.
3. **Control-plane DB resolution:** the backfill passes `workspaceRoot` to both `_getKanbanDb` and `getComplexityFromPlan`; the latter internally uses `KanbanDatabase.forWorkspace`. This mirrors the existing column-advance sync pattern, so any control-plane resolution mismatch would be pre-existing and shared, not introduced here.
