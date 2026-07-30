# Let a `**Project:**` Pin Apply to an Unassigned Plan Instead of Being Frozen Forever

## Goal

Make a project pin apply on re-import when the plan's stored project is **empty**, so a plan that imported unassigned can be fixed by its own file instead of requiring a board drag or an API call. Today a missed pin is permanently unrecoverable.

### Problem

When a plan file carrying `**Project:** <name>` imports without the project being applied, the plan sits at `project=''` and **no edit to that file can ever fix it**. Re-saving the file, correcting the pin, re-importing — all no-ops. The only remedies are dragging the card on the board or calling `PUT /kanban/plans/project`. For an agent authoring plans from a prompt that carries a PROJECT PIN directive, that means the pin silently fails and the cards land unassigned with no recovery path in the medium the agent controls.

Measured on this repo's own board: of 26 plan/feature files whose pin names a real project, **7 sit at `project=''`** while their file says otherwise.

### Root cause

Two deliberate freezes, both correct in intent, that together leave no path back:

1. **The upsert self-assigns `project` on conflict.** `insertFileDerivedPlan`'s SQL ([KanbanDatabase.ts:2151-2158](../../src/services/KanbanDatabase.ts#L2151-L2158)):

   ```sql
   ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
       topic = excluded.topic,
       complexity = excluded.complexity,
       tags = excluded.tags,
       project = plans.project,        -- self-assignment: deliberate no-op
       project_id = plans.project_id,
       ...
   ```

2. **The watcher's update branch passes the DB value, not the file value.** `PlanIngestionEngine.ts:795` sets `project: plan.project` on the updated record, so `metadata.project` is discarded on every pass after the first.

The intent is documented and load-bearing: *"no file-derived re-import can ever move a card between projects regardless of what the caller passes"* (KanbanDatabase.ts:2121-2130). That invariant protects a user's board arrangement from being yanked around by a stale pin in a file. It is worth keeping.

But it is currently enforced as *"a file can never change project"* rather than *"a file can never **move** a card between projects"*. Filling an **unassigned** card is not a move. Nothing is overwritten, no user arrangement is lost, and the card is currently invisible on any project-filtered board view — the worst possible resting state.

Confirmed empirically: a plan imported with no pin, then rewritten with `**Project:** Browser Switchboard`, stayed at `project=''` after the re-import (topic/complexity/tags all updated correctly on the same pass).

### Scope

This plan fixes **recoverability only** — a pin can fill an empty project. It does **not** address why pins fail to apply on first insert; that is the sibling subtask (same-snapshot resolution fix) in this feature, implemented in the same coding session. This change is valuable on its own: it turns every present and future missed pin into a self-healing case.

## Metadata

- **Complexity:** 4
- **Tags:** backend, database, bugfix, reliability
- **Project:** Browser Switchboard

## User Review Required

- **Subtask governance decision changed during review.** The earlier draft had the fill *inherit the feature's project* inside `_resolveProjectForInsert`. This review supersedes that with *skip the fill for feature-linked rows* (a `feature_id` condition in the SQL CASE), because subtask↔feature project inheritance is already owned by existing machinery (`reconcileSubtaskProjectInheritance` runs every startup; the guard/cascade at KanbanDatabase.ts:3522 handles feature project changes; the API rejects direct subtask project writes with 400). Veto here if you want fill-time inheritance instead.
- **The 7 known-stuck cards heal lazily, not eagerly.** They self-repair on each file's next import (`touch` the files to force it). A one-shot backfill remains explicitly out of scope.

## Complexity Audit

### Routine

- Two-expression SQL change in one statement, plus a one-line conditional in the watcher's update branch — both surfaces already exist and are well-commented.
- Contract test follows the repo's existing `src/test/*-contract.test.js` pattern with a `package.json` script registration.
- The CASE/`excluded.*` upsert idiom is already used in the same statement (`is_feature`), so no new SQL pattern is introduced.

### Complex / Risky

- **Small diff, load-bearing invariant.** The risk is entirely in whether the relaxation preserves the invariant its comment block promises. It does, narrowly: `CASE WHEN plans.project = '' … THEN excluded.project ELSE plans.project END` can only ever transition `'' → <name>`. A card already in a project is untouched, so "a re-import can never move a card between projects" still holds. The dangerous shape — which this plan must **not** produce — is `project = excluded.project`, which would let a stale file pin drag a card the user had rearranged. Any reviewer should check for exactly that.
- **`project` and `project_id` must move together.** Setting the name while leaving `project_id` null recreates the stranded state this repo already has cards in — a non-empty `project` string with a null id is filtered out of **both** the project view (no id) and the Unassigned view (non-empty string). The two columns' CASE expressions must be driven by the same condition.
- **The watcher's update branch and the SQL must agree.** If the SQL is relaxed but `PlanIngestionEngine` keeps sending `project: plan.project`, `excluded.project` is the empty DB value and the relaxation is dead code that looks correct.

## Edge-Case & Dependency Audit

### Race Conditions

- The fill only fires inside the existing `ON CONFLICT` clause of a single upsert statement, inside the existing `BEGIN`/`COMMIT` — no new read-modify-write window is introduced.
- A concurrent board drag (API write) and a file re-import can interleave, but the CASE keys on `plans.project` *at statement execution time*: if the drag landed first, the row is non-empty and the fill is a no-op; if the import landed first, the drag overwrites it as an explicit user action. Both orders end in a user-consistent state.

### Security

- No new input surface. The pin value still flows exclusively through `_resolveProjectForInsert`, which enforces resolve-only semantics (unknown pins yield `('', null)` and never mint a `projects` row).

### Side Effects

- **A pin removed from a file must not clear an assigned project.** If the file's pin is deleted, `excluded.project` is `''` and the CASE leaves `plans.project` alone (it is non-empty). Correct by construction — but assert it, because the naive `CASE WHEN excluded.project <> ''` variant behaves differently.
- **Subtask invariant.** A subtask's project is governed by its feature (`_handlePlanFieldUpdate` rejects direct subtask project changes with 400 — LocalApiServer.ts:2524-2533; `reconcileSubtaskProjectInheritance` repairs drift every startup — KanbanDatabase.ts:4054-4081). The fill CASEs therefore also require `plans.feature_id` to be empty, so a file pin can never make a subtask diverge from its feature (see Proposed Changes 1 and the superseded callout at Change 3).
- **Existing 7 stuck cards do not self-heal until touched.** The fill happens on the next import of each file. Either touch the files (`touch` bumps mtime → watcher re-import) or accept lazy healing; a one-shot backfill is explicitly out of scope here.

### Dependencies & Conflicts

- **`project_id` must be resolved, not copied.** On the update path the record's `projectId` is null for an unassigned row, so `_resolveProjectForInsert` performs the name lookup and `excluded.project_id` carries the resolved id. Do not bypass `_resolveProjectForInsert` by reaching for `record.project` directly in the SQL bindings.
- **Resolve-only still applies.** A pin naming a non-existent project must continue to produce `('', null)`, not create a `projects` row. `_resolveProjectForInsert` already enforces this; the fill inherits it unchanged because `excluded.*` are the values that helper produced for this pass.
- **`upsertPlans` is a different path.** It is DB-sourced (Notion restore, manifest ingest) and legitimately carries project. Leave it alone; this change is scoped to the file-derived path (`insertFileDerivedPlan`).
- **Sibling subtask (same-snapshot resolution fix) — same coding session, implement this plan's changes first.** The sibling moves `project_id` resolution into the INSERT statement's VALUES; the fill CASE composes unchanged — `excluded.project_id` carries the subquery-computed value (the exact combined shape is verified empirically, see Resolved Assumptions). Since both plans edit `insertFileDerivedPlan`'s SQL, write the combined statement once, and keep both contract tests green against it.
- **Build/deploy dependency.** The running extension serves from its install folder (`~/.devin/extensions/turnzero.switchboard-1.7.13/dist/`), not this repo's `dist/`. A change is not live until built and synced there and the window reloaded. Verified for this investigation: the installed bundle's `insertFileDerivedPlan` is logically identical to src, so there is no version skew to work around — but "compiled" is not "live".
- **`npm run verb-returns:check` / `catalog:check`** are unaffected (no verb signature or push site changes); `catalog.json` records line numbers and this edit shifts them in `KanbanDatabase.ts`, so a `catalog:generate` refresh may be needed when the implementer's pipeline runs those gates.

## Dependencies

- None (no session dependencies; sibling-subtask ordering is recorded in the feature file's Dependencies & sequencing).

## Adversarial Synthesis

Key risks: (1) the relaxation accidentally shipping as an overwrite (`project = excluded.project`) instead of a fill, which would let stale file pins move user-arranged cards; (2) `project`/`project_id` CASEs diverging and recreating the stranded name-without-id state; (3) the engine guard and SQL CASE disagreeing, leaving the fill as dead code. Mitigations: both CASEs share one condition, the contract test asserts fill, no-move, pin-removal, resolve-only, and subtask-skip separately, and a source-regex assertion pins the engine guard's shape.

## Resolved Assumptions

Settled empirically this session (2026-07-30) against the vendored sql.js — do not re-flag or re-research:

- The bundled SQLite is **3.49.1**; `CASE`/`excluded.*` in `DO UPDATE SET`, a scalar subquery inside `INSERT … VALUES`, and `excluded.project_id` reflecting that subquery's computed value all behave as this plan assumes (probe: fill `''→name` with id ✓, no-move on different pin ✓, subtask-skip via `feature_id` condition ✓).

## Proposed Changes

### 1. `src/services/KanbanDatabase.ts` — relax the two self-assignments to apply-if-empty (non-subtask rows only)

In `insertFileDerivedPlan`'s `ON CONFLICT` clause (lines 2151-2158):

```sql
            ON CONFLICT(plan_file, workspace_id) DO UPDATE SET
                topic = excluded.topic,
                complexity = excluded.complexity,
                tags = excluded.tags,
                -- APPLY-IF-EMPTY, not overwrite. The invariant this preserves is
                -- "a file-derived re-import can never MOVE a card between
                -- projects" — filling an UNASSIGNED card is not a move, and an
                -- unassigned card with a pin is currently invisible on every
                -- project-filtered view with no recovery path from the file.
                -- Do NOT simplify to `project = excluded.project`: that would let
                -- a stale pin drag a card the user rearranged on the board.
                -- feature_id guard: a subtask's project is governed by its feature
                -- (startup reconcile + cascade own inheritance); a file pin must
                -- never make a subtask diverge, so feature-linked rows never fill.
                project    = CASE WHEN plans.project = '' AND (plans.feature_id IS NULL OR plans.feature_id = '') THEN excluded.project    ELSE plans.project    END,
                project_id = CASE WHEN plans.project = '' AND (plans.feature_id IS NULL OR plans.feature_id = '') THEN excluded.project_id ELSE plans.project_id END,
                updated_at = excluded.updated_at,
                is_feature = CASE WHEN excluded.is_feature > 0 THEN excluded.is_feature ELSE plans.is_feature END
```

Both CASEs key off the **same** condition so name and id can never split. `excluded.project` / `excluded.project_id` are the values `_resolveProjectForInsert` already produced for this pass, so resolve-only semantics are inherited unchanged. `plans.feature_id` is the DB truth at update time (the INSERT column list never carries `feature_id` — it is DB-owned), so the subtask guard cannot be spoofed by the caller.

### 2. `src/services/PlanIngestionEngine.ts` — stop discarding the file's pin on the update path

At line 795, the updated record currently freezes the DB value:

```ts
                const updatedRecord: KanbanPlanRecord = {
                    ...plan,
                    topic: metadata.topic,
                    complexity: metadata.complexity,
                    tags: metadata.tags,
                    // Send the FILE's pin when the DB row is unassigned and not a
                    // subtask, so the SQL's apply-if-empty CASE has something to
                    // apply; keep the DB value otherwise so a re-import can never
                    // move an assigned card (and a subtask's project stays
                    // governed by its feature).
                    project: (plan.project === '' && !plan.featureId && metadata.project) ? metadata.project : plan.project,
                    updatedAt: fileMtime
                };
```

The guard is belt-and-braces with the SQL CASE: either alone is insufficient (the SQL cannot apply a value the caller never sends; the caller cannot overwrite what the SQL self-assigns). The `!plan.featureId` term mirrors the SQL's `feature_id` condition so the two layers state the same rule; `plan` is DB truth here (fetched via `getPlanByPlanFile`), so `plan.featureId` is authoritative.

### 3. Subtask decision — encoded in the SQL, not in `_resolveProjectForInsert`

> **Superseded:** In `_resolveProjectForInsert`, before returning a filled pin for a record whose row has a non-empty `feature_id`, either inherit the feature's project or return `('', null)`. Recommended: **inherit the feature's project**, matching the cascade `_handlePlanFieldUpdate` already performs, so a subtask can never disagree with its feature.
> **Reason:** Inheritance machinery already exists and owns this invariant: `reconcileSubtaskProjectInheritance()` (KanbanDatabase.ts:4054-4081) repairs any subtask/feature project drift on **every startup**, the guard/cascade at KanbanDatabase.ts:3522 propagates feature project changes to subtasks, and the API rejects direct subtask project writes with 400. Fill-time inheritance inside `_resolveProjectForInsert` would duplicate that logic and add an async feature lookup to every import. Also, on the fresh-INSERT path the feature link does not exist yet (`_applyFeatureLink` runs post-insert), so `_resolveProjectForInsert` cannot reliably see `feature_id` — the DB row can, at conflict-update time.
> **Replaced with:** The fill CASEs in Change 1 additionally require `plans.feature_id` to be empty — a subtask row simply never fills from its own file, and its project continues to come from its feature via the existing cascade/startup reconcile. `_resolveProjectForInsert` is not modified at all (which also removes any merge collision with the sibling subtask's instrumentation of that function).

### 4. `src/test/project-pin-apply-if-empty-contract.test.js` — new contract test

```js
'use strict';
/**
 * Contract: a file pin FILLS an unassigned plan and NEVER moves an assigned one,
 * and never fills a feature-linked (subtask) row.
 *
 * The regression this locks down: `ON CONFLICT ... project = plans.project` plus
 * the watcher's `project: plan.project` made a missed pin unrecoverable from the
 * file — a plan could sit at project='' forever while its own metadata named a
 * real project. Verified empirically before the fix: adding a pin to an
 * already-imported plan changed nothing.
 */
const assert = require('assert');

// Fill: unassigned row + real pin on re-import → applied, WITH project_id.
await db.insertFileDerivedPlan({ ...rec, project: '' });               // first import, no pin
await db.insertFileDerivedPlan({ ...rec, project: 'Browser Switchboard' });
let row = await db.getPlanByPlanId(rec.planId);
assert.strictEqual(row.project, 'Browser Switchboard');
assert.ok(row.projectId != null, 'name filled but project_id left null — strands the card');

// No move: assigned row + DIFFERENT pin → unchanged (the load-bearing invariant).
await db.insertFileDerivedPlan({ ...rec, project: 'Website' });
row = await db.getPlanByPlanId(rec.planId);
assert.strictEqual(row.project, 'Browser Switchboard', 'a re-import MOVED an assigned card');

// Pin removed from the file → assigned project survives.
await db.insertFileDerivedPlan({ ...rec, project: '' });
row = await db.getPlanByPlanId(rec.planId);
assert.strictEqual(row.project, 'Browser Switchboard');

// Resolve-only intact: unknown pin fills nothing and creates no projects row.
await db.insertFileDerivedPlan({ ...rec2, project: 'No Such Project' });
row = await db.getPlanByPlanId(rec2.planId);
assert.strictEqual(row.project, '');
assert.strictEqual(await db.getProjectIdByName(wsId, 'No Such Project'), null);

// Subtask-skip: a feature-linked row with an empty project NEVER fills from a pin.
await db.insertFileDerivedPlan({ ...rec3, project: '' });              // first import
await db.updateFeatureStatus(rec3.planId, 0, featurePlanId);           // link to a feature
await db.insertFileDerivedPlan({ ...rec3, project: 'Browser Switchboard' });
row = await db.getPlanByPlanId(rec3.planId);
assert.strictEqual(row.project, '', 'a file pin filled a subtask — its project is governed by its feature');

// The watcher actually sends the pin when the row is unassigned and not a subtask.
const engine = require('fs').readFileSync('src/services/PlanIngestionEngine.ts', 'utf8');
assert.match(engine, /plan\.project === ''\s*&&\s*!plan\.featureId\s*&&\s*metadata\.project/,
    'update branch still discards the file pin — SQL CASE has nothing to apply');
```

### 5. `package.json` — register the test

```json
    "test:contract:project-pin-fill": "node src/test/project-pin-apply-if-empty-contract.test.js",
```

The sibling subtask also appends a script line here — trivial merge, land this plan's line first.

## Verification Plan

Per session directive (SKIP COMPILATION / SKIP TESTS), compilation and automated-test execution are **not** part of this plan's verification pass; the contract test is authored as a deliverable and runs in CI / the implementer's pipeline.

### Automated Tests

Authored, not run in this workflow:

1. `test:contract:project-pin-fill` (Change 4) — fill, no-move, pin-removal, resolve-only, subtask-skip, and the engine-guard source-shape assertion.
2. Mutation checks for the implementer's pipeline: (a) revert the `PlanIngestionEngine` guard only and confirm the "watcher actually sends the pin" assertion **fails** — proving the two halves are both required; (b) change the SQL to the dangerous shape (`project = excluded.project`) and confirm the **no-move** assertion fails — this is the assertion protecting the documented invariant; it must bite.

### Manual Verification

Prerequisite (outside this plan's verification scope): the built extension synced to `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/` and the window reloaded.

1. Write a new plan file with `**Project:** Browser Switchboard` in its Metadata block. Check the row: `sqlite3 .switchboard/kanban.db "SELECT project, project_id FROM plans WHERE plan_file LIKE '%<name>%';"`. If the first insert still lands unassigned (the sibling root-cause bug), **re-save the file** — after this change the pin now applies on that second pass, with a non-null `project_id`.
2. On the board, drag that card to a different project, then re-save the file again. The card must **stay** where you dragged it — the file must not pull it back.
3. Delete the pin line from the file and re-save. The card keeps its board-assigned project.
4. Backfill check on the 7 known-stuck cards: `touch` their plan files, then confirm each now shows its pinned project with a non-null `project_id` and appears under that project on the board.
5. Subtask check: pin a subtask file to a project different from its feature's, re-save, and confirm the row's project does **not** change (the fill skips feature-linked rows; inheritance stays with the feature's cascade/startup reconcile).

---

**Recommendation:** Complexity 4 → **Send to Coder**.

### Completion Report
I have successfully implemented this plan. I modified `src/services/PlanIngestionEngine.ts` to forward the file's pin on updates when the database project is empty and not a subtask, and updated `src/services/KanbanDatabase.ts` ON CONFLICT UPDATE to set `project` and `project_id` when the database project is empty and not a subtask. I registered a contract test `project-pin-apply-if-empty-contract.test.js` under `test:contract:project-pin-fill`. No issues were encountered during this work.
