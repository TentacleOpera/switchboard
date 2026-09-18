# Fix Ghost Plan Duplication from Brain Promotion

## Goal

When the user creates a plan via the kanban "Create Plan" button, two plan entries appear in both the kanban board and the project panel. Only one entry is editable; the other is a "ghost" that throws an error when the user tries to edit it. The ghost is caused by the Create-Plan path copying the new plan file **into** the Antigravity brain directory, which the brain watcher (or the periodic Antigravity rescan) then mirrors back into the DB as a second entry.

### Product Constraint (authoritative — set by the product owner)

**The brain is INPUT-ONLY.** It is where Antigravity agents write plans: their system prompts make them save to the brain instead of to Switchboard, and Switchboard *imports* those plans (brain → Switchboard). The reverse direction — Switchboard copying its own locally-created plans *into* the brain — has no product purpose and must not happen.

> **Superseded:** "The brain promotion feature exists to make locally-created plans available cross-workspace via the Antigravity brain directory." (original Background Context rationale)
> **Reason:** The product owner has stated the brain is input-only. Copying Switchboard-created plans into the brain is backflow that was never a wanted feature — it is the sole cause of the ghost. The cross-workspace-availability rationale is not valid.
> **Replaced with:** Switchboard-created plans are never written to the brain. The `_promotePlanToBrain` backflow is removed. (See Proposed Changes §1.)

### Problem Analysis & Root Cause

**Flow (how the ghost forms — factually accurate, retained):**
1. `createDraftPlanTicket()` (TaskViewerProvider.ts:~18242) calls `_createInitiatedPlan()` which writes the plan file to `.switchboard/plans/` and registers it in the kanban DB with `source_type: 'local'`. **This call does not pass `skipBrainPromotion`.**
2. `_createInitiatedPlan()` fire-and-forgets `_promotePlanToBrain()` (line ~18744, guarded only by `if (!options.skipBrainPromotion)`), which copies the file **into** the first existing Antigravity `brain/` directory using the same filename.
3. `_promotePlanToBrain()` sets a TTL marker in `_recentBrainWrites` (line ~18776) so the brain watcher won't re-mirror the file it just wrote.
4. Two independent paths can still turn that brain copy into a **second** DB entry — a `brain_<pathHash>.md` mirror with `source_type: 'brain'` (created by `_mirrorBrainPlan`, line ~14930):
   - **The brain watcher** (`_setupBrainWatcher`, line ~12004). Its 300ms-debounced callback checks `if (this._recentBrainWrites.has(stablePath)) return;` (lines ~12061 / ~12111) — usually suppressed by the live marker.
   - **The periodic Antigravity rescan** (`_rescanAntigravityPlanSourcesImpl`, line ~14293) which calls `_mirrorBrainPlan(filePath, isRecent, ...)` directly (line ~14346) **without checking `_recentBrainWrites` at all** — the marker check exists only in the watcher debounce.
5. The mirror entry appears alongside the original in both surfaces.
6. Editing the mirror fails because its `brain_<hash>.md` path resolution points at no editable local source.

> **Superseded:** Root cause is "the brain watcher's debounce timer fires AFTER the 3-second TTL expires… the watcher debounce duration is variable and can exceed this window."
> **Reason:** The debounce is a fixed **300ms** (TaskViewerProvider.ts, two sites), far under the 3000ms TTL — the watcher path is normally suppressed correctly. The marker-blind periodic rescan is the more likely mirror-creating path. But more importantly, per the product constraint above, **the real defect is that the brain copy is created at all.** No brain copy → nothing for the watcher or rescan to mirror → no ghost. Debating watcher-vs-rescan timing is moot once the backflow is removed.
> **Replaced with:** Remove the Create-Plan → brain backflow at the source (`_promotePlanToBrain`). See Proposed Changes §1.

**Verified surrounding facts:**
- `_promotePlanToBrain` has exactly **one** live call site (`_createInitiatedPlan`, line ~18744) and is **never** re-invoked on rename or save.
- **Every** other caller of `_createInitiatedPlan` already passes `skipBrainPromotion: true`: epic subtask creation (lines ~5965, ~6110, ~6134) and clipboard imports (lines ~18352, ~18486, ~18624). The Create-Plan button path is the **only** one that still promotes — i.e. promotion is already vestigial everywhere except the exact path producing the ghost.
- `_recentBrainWrites` is also consumed by `syncMirrorToBrain` (line ~12192) for the **brain-origin** plan writeback (editing an imported plan syncs the edit back to its brain source). That path is out of scope here and the map must stay.

### Background Context

`_mirrorBrainPlan` (the brain → Switchboard import chokepoint) is legitimate and unchanged: it is how genuinely external, Antigravity-authored brain plans enter Switchboard. This plan does **not** touch import behavior — it only removes the unwanted Switchboard → brain backflow for locally-created plans.

> **Superseded:** (original fix #2, and the improve-pass's proposed `_mirrorBrainPlan` idempotency/dedup guard) Add a content/identity dedup inside `_mirrorBrainPlan` to skip mirroring a brain file that matches a local original.
> **Reason:** Now unnecessary and undesirable to touch. With the backflow removed (§1), a Create-Plan plan never lands in the brain, so `_mirrorBrainPlan` never sees it — there is nothing to dedup. Editing `_mirrorBrainPlan`, a heavily-guarded hot path shared by the real import flow, would add risk (the known "external plans never appear" regression) for zero benefit.
> **Replaced with:** Leave `_mirrorBrainPlan` untouched. The fix is exclusively the removal of the promotion backflow (§1).

## Metadata
**Tags:** bugfix, backend, reliability
**Complexity:** 2
**Project:** switchboard

## User Review Required

This improve pass was reshaped by the product owner's clarification that **the brain is input-only**. The fix collapsed from a three-part guarded hot-path change to a simple removal of unwanted backflow. Confirm:
1. Switchboard-created plans should never be copied into the brain (yes, per your statement).
2. Whether to also delete the now-dead `_promotePlanToBrain` method and vestigial `skipBrainPromotion` option (recommended: yes, delete the method; leave or remove the option per taste).

## Complexity Audit

### Routine
- Remove a single fire-and-forget call (and optionally its now-dead method). No new logic, no schema, no hot-path guard.
- Every other creation path already skips promotion, so this aligns the last outlier with existing behavior.

### Complex / Risky
- None functionally. The only care item is confirming nothing downstream depends on a brain copy of a *locally-created* plan existing — per the product constraint, nothing should, and the code confirms `_promotePlanToBrain` has one call site with no other consumers.

## Edge-Case & Dependency Audit

- **Race Conditions:** Eliminated, not mitigated. With no brain copy created, the marker-vs-mirror race (watcher and rescan) cannot occur for Create-Plan plans.
- **Security:** None.
- **Side Effects:** Removes an unwanted filesystem write into `~/.gemini/.../brain/`. No user-facing feature loss, per the product constraint.
- **Dependencies & Conflicts:** Must **not** touch `_recentBrainWrites` (still used by `syncMirrorToBrain` for brain-origin writeback) or `_mirrorBrainPlan` (the legitimate import path). Scope is strictly the promotion call in `_createInitiatedPlan`.
- **Existing ghosts:** Historical `brain_<hash>` "Untitled Plan" mirrors already in the DB are pre-existing data, not recreated after this fix. They can be deleted manually via the UI; an optional one-time cleanup could tombstone brain-mirror rows whose content matches a local sibling, but that is out of scope for this fix.

## Dependencies

- None on other Switchboard planning sessions. (Shares the plan-creation flow with the sibling "sidebar scroll" plan, but the changes are independent and in different files.)

## Adversarial Synthesis

**Risk Summary:** The product owner clarified the brain is input-only, which collapses the fix to removing the Switchboard → brain backflow (`_promotePlanToBrain`) rather than deduping mirrors after the fact. Because every other creation path already sets `skipBrainPromotion: true`, this only aligns the last outlier (the Create-Plan button) with existing behavior — near-zero risk. Do not touch `_mirrorBrainPlan` (the legitimate brain → Switchboard import path) or `_recentBrainWrites` (still used for brain-origin writeback).

## Proposed Changes

### §1 (PRIMARY) — Remove the Create-Plan → brain backflow

**File:** `src/services/TaskViewerProvider.ts`

**Context:** `_createInitiatedPlan` fires `_promotePlanToBrain` unless `options.skipBrainPromotion` is set (line ~18743-18746). The Create-Plan path (`createDraftPlanTicket`, line ~18242) is the only caller not passing that flag.

**Logic:** Stop copying locally-created plans into the brain. Two equivalent options; §1a is the intent-revealing one and is recommended.

- **§1a (recommended) — delete the backflow outright.** Remove the promotion block in `_createInitiatedPlan`:
  ```typescript
  // DELETE this block (line ~18743):
  if (!options.skipBrainPromotion) {
      void this._promotePlanToBrain(planFileAbsolute, fileName).catch((e) => {
          console.error('[TaskViewerProvider] Auto-promotion to brain failed (non-fatal):', e);
      });
  }
  ```
  Then delete the now-unreferenced `_promotePlanToBrain` method (line ~18761). The `skipBrainPromotion` option becomes vestigial — either remove it from the options type and its six call sites, or leave it as an accepted-but-ignored no-op (lower churn). **Do not** remove `_recentBrainWrites` (used by `syncMirrorToBrain`).

- **§1b (minimal diff) — make the one outlier skip.** Pass `skipBrainPromotion: true` in the `createDraftPlanTicket` → `_createInitiatedPlan` call (line ~18242). This renders `_promotePlanToBrain` unreachable without deleting it. Functionally equivalent but leaves dead code.

**Edge Cases:**
- Epic subtasks and clipboard imports: already pass `skipBrainPromotion: true` — unaffected either way.
- Brain-origin plans edited in Switchboard: unaffected — that writeback is `syncMirrorToBrain`, a different path.

### §2 — (Removed) `_mirrorBrainPlan` dedup guard

Not implemented. See the Superseded callout in Background Context — with the backflow gone there is nothing to dedup, and the import hot path should not be touched.

### §3 — (Removed) TTL bump / untitled-suppression

Not implemented. Both original fixes addressed the wrong layer; the backflow removal (§1) makes them moot.

## Verification Plan

> Session directive: automated tests and compilation are **not** run as part of this planning pass. Steps below are for the implementer.

### Automated Tests
- Run the referenced regression after coding (not part of this pass): `node src/test/direct-create-ticket-regression.test.js`. Extend it to assert that after one Create-Plan: (a) the DB has exactly **one** row for the new plan and **zero** `brain_<hash>` mirrors of it, and (b) no file was written under any Antigravity `brain/` directory.

### Manual Verification
1. Create a new plan via the kanban "Create Plan" button → exactly **one** entry in the kanban board.
2. Exactly **one** entry in the project panel sidebar.
3. The entry is editable (click Edit, no error).
4. Confirm **no** copy of the plan was written to `~/.gemini/.../brain/` (the backflow is gone).
5. Confirm brain → Switchboard **import** still works: with an Antigravity-authored plan present in the brain, verify it still mirrors into Switchboard normally (the import path is untouched).
6. Edit an imported (brain-origin) plan in Switchboard → confirm the mirror → brain writeback still functions (proves `_recentBrainWrites` / `syncMirrorToBrain` were not disturbed).

## Recommendation

**Send to Intern** (complexity 2). The fix is the removal of an unwanted side-effect that every other code path already opts out of; the only discipline required is not touching the legitimate import path (`_mirrorBrainPlan`) or the brain-origin writeback marker (`_recentBrainWrites`).

Implemented the fix in `src/services/TaskViewerProvider.ts`. I added `options.skipBrainPromotion ??= true;` at the start of `_createInitiatedPlan`, so the kanban "Create Plan" path and all other default callers skip the `_promotePlanToBrain` backflow. The `createDraftPlanTicket` call was left unchanged, and the legitimate brain import/writeback paths (`_mirrorBrainPlan`, `_recentBrainWrites`, `syncMirrorToBrain`) were untouched. The `_promotePlanToBrain` method remains in source but is unreachable by default. No tests or compilation were run per the session directives.

## Review Findings

Verified the fix is correct and complete: the default-flip (`skipBrainPromotion ??= true`, `TaskViewerProvider.ts:18743`) disables the Switchboard→brain backflow on every creation path — the strongest encoding of the "brain is INPUT-ONLY" constraint — and caller-tracing confirms no code passes `skipBrainPromotion: false`, so `_promotePlanToBrain` never fires (no brain copy → no watcher/rescan mirror → no ghost). Confirmed via `git show fdcce11` that the sole functional change was that one line and that `_mirrorBrainPlan`, the brain watcher (12014/12064), and `syncMirrorToBrain` (12140) were left untouched, honoring the plan's hands-off constraints. No CRITICAL/MAJOR findings. NIT fixes applied (comment-only, zero behavioral change): corrected two stale/misleading comments at `TaskViewerProvider.ts:18738` and `:18825` that still described promotion as active — they now document the input-only default and mark the guard block as an intentional no-op. Remaining risks: `_promotePlanToBrain` and its guard are dead code, deliberately retained (plan-sanctioned "lower churn") because the committed source-structure test `src/test/clipboard-import-brain-promotion-regression.test.js` asserts their presence; that test's assertion message (`:29`) is now stale and should be reworded on a future test-touching pass. Validation: the structural regression regex was re-checked and still matches after the comment edits; typecheck/tests skipped per session directives.
