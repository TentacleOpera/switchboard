# Multi-Plan Epic Creation Does Not Appear as Epic on Board

## Goal

Make a multi-plan epic (created via the `createEpic` path on the kanban board) render with its `EPIC · N subtasks` badge **immediately** on creation, without requiring a second `PROMOTE TO EPIC` click — and, before changing anything, **confirm the actual root cause**, because the originally-hypothesised mechanism is contradicted by the current code (see *Verification Findings* below).

### Problem
When an epic is created from **multiple selected plans** on the kanban board (`kanban.html`), the user reports that the resulting epic card does not appear as an epic on the board — it renders as a regular plan card without the `EPIC · N subtasks` badge. The user must select the new card and press the `PROMOTE TO EPIC` button a **second time** to turn it into an actual epic. (The button only reads `PROMOTE TO EPIC` when exactly one **non-epic** card is selected — `kanban.html` line 6710–6712 — so the symptom implies `card.isEpic === false` in the board payload at the time the user re-selects it.)

The single-plan promotion path (`promoteToEpic`) works correctly — only the multi-plan path (`createEpic`) is reportedly affected.

### Background Context
The kanban board has two epic creation paths:
1. **Single plan** → `promoteToEpic` message → `KanbanProvider.ts` line 7426: marks the existing plan as `is_epic=1` in-place, moves its file to `epics/`. Works correctly.
2. **Multiple plans** → `createEpic` message → `KanbanProvider.ts` line 7469: creates a **new** plan record + file in `epics/`, links subtasks via `updateEpicStatus`. This is the reportedly-broken path.

### Original Root Cause Analysis (RETAINED — but see Verification Findings, which contradicts it)
The `createEpic` handler (`KanbanProvider.ts` lines 7469–7562) does the following in order:

1. `upsertPlan({ isEpic: 1, ... })` — INSERT new record with `is_epic=1` (line 7516)
2. `updateEpicStatus(planId, 1, '')` — re-sets `is_epic=1` (line 7545)
3. `writeFile(epicPath, epicContent)` — writes the epic file (line 7554), with `registerPendingCreation` (line 7553)
4. For each subtask: `updateEpicStatus(st.planId, 0, planId)` — links subtasks (line 7558)
5. `_regenerateEpicFile(workspaceRoot, planId, db)` — rewrites the file with subtask section (line 7560), with `registerPendingCreation` (line 8066)
6. `_refreshBoard(workspaceRoot)` — refreshes the board (line 7561)

The `registerPendingCreation` call (line 7553/8066) sets a **3-second timeout** that makes the `GlobalPlanWatcherService` skip the file (line 449–451). After 3 seconds, the entry is deleted (line 43–45).

**The (hypothesised) race:** On macOS, `fsevents` can batch and delay file-watch notifications. If the watcher event for the epic file fires **after** the 3-second `registerPendingCreation` window expires, the watcher's `_handlePlanFile` runs. It calls `db.getPlanByPlanFile(relativePath, workspaceId)` (line 469). If the plan is found, the watcher takes the "existing plan" branch (line 584) and calls `insertFileDerivedPlan` (line 593). The `insertFileDerivedPlan` conflict update (lines 1328–1334) does **not** touch `is_epic` — so `is_epic` is preserved. The original plan further hypothesised a `plan_file` normalization mismatch causing a fresh INSERT (defaulting `is_epic=0`) and a wrong-`planId` re-assertion.

### Verification Findings (improve-plan pass — 2026-06-25)
Every proposed failure mechanism above was checked against the current source and **does not hold**. This section is the operative analysis; the original is retained per workflow content-preservation rules but should be treated as superseded.

1. **The watcher does NOT mint a fresh random UUID for epic files.** `GlobalPlanWatcherService.ts` lines 540–549 explicitly derive the `plan_id` from the filename's trailing UUID for any file under `.switchboard/epics/`. `createEpic` embeds the epic's `planId` in the filename (`<slug>-<planId>.md`, line 7512) precisely so a re-import re-derives the *same* id. The "newly generated UUID orphans subtasks / wrong-planId re-assertion" mechanism is therefore impossible by construction.
2. **There is no path-normalization mismatch on macOS.** `upsertPlan` (via `upsertPlans`), `insertFileDerivedPlan`, and `getPlanByPlanFile` all normalize through the same `_ensureRelativePlanFile()`. The watcher's `relativePath` is `path.relative(root, fsPath).replace(/\\/g,'/')`, which yields the identical relative string. `getPlanByPlanFile` therefore finds the record and takes the existing-plan branch.
3. **The existing-plan branch preserves `is_epic`.** Line 586–598 spreads `...plan` (carrying `isEpic`) and `insertFileDerivedPlan`'s `ON CONFLICT` clause (lines 1328–1334) updates only `topic/complexity/tags/project/project_id/updated_at` — it never writes `is_epic`. Even the fresh-INSERT branch immediately re-asserts `is_epic=1` for `.switchboard/epics/` files (lines 577–579) using the filename-derived id.
4. **`createEpic` sets `is_epic=1` twice before the board refreshes.** `upsertPlan` writes `is_epic` via param 24 (`record.isEpic ?? 0` = 1; `UPSERT_PLAN_SQL` line 554/580), and `updateEpicStatus` (line 7545) sets it again. `getPlanByPlanId` (line 2577) finds the record by `plan_id` with no status/workspace filter, so the `updateEpicStatus` call cannot silently no-op. `getBoard` selects `is_epic` (in `PLAN_COLUMNS`), and `_refreshBoardImpl` maps `isEpic: !!row.isEpic` (line 2134). So at the **immediate** post-create refresh, the badge should already render.
5. **The periodic scan is not a reset vector.** `_scanForNewFiles` (line 176) skips files already present in the DB (line 242), and any file it does process is routed through the same `_handlePlanFile`, which preserves `is_epic`.

**Conclusion:** With the current code, no examined path resets `is_epic` to 0 after `createEpic` on macOS. The reported bug is therefore either (a) **already fixed** by the filename-UUID-derivation work (the comments at lines 533–539 and 7508–7511 read like a fix for exactly this orphaning/reset class of bug), or (b) caused by a mechanism **not** in the analysed path — most plausibly the **project filter** (the epic is created with no `project`/`project_id`, and there is documented history of project-less plans falling off a filtered board) or a **frontend render/selection** issue. The plan below makes diagnostic confirmation the mandatory first step rather than shipping a speculative fix.

## Metadata
- **Tags:** bugfix, backend, reliability
- **Complexity:** 5/10

## User Review Required
- **None.** The investigation-first sequencing and the decision to keep the defensive changes as low-risk hardening are engineering calls, not product calls. If diagnostics prove the bug is already fixed, the only deliverable is the diagnostic logging (optionally left in behind the existing debug channel) plus a closing note — no product decision is needed.

## Complexity Audit

### Routine
- Adding diagnostic logging after `createEpic`'s final DB write.
- Reordering the existing `updateEpicStatus(planId, 1, '')` call to be the last DB write before `_refreshBoard` (idempotent re-assertion).
- All changes are confined to two known files and reuse existing helpers (`getPlanByPlanId`, `updateEpicStatus`, `registerPendingCreation`).

### Complex / Risky
- The file watcher (`GlobalPlanWatcherService`) has subtle timing and path-normalization behavior; any change there must not regress the single-plan `promoteToEpic` path or the normal import flow.
- The true root cause is **unconfirmed** — there is a real risk of "fixing" a bug that no longer reproduces, or of the genuine cause living in the project-filter or frontend paths that the original plan never examined.

## Edge-Case & Dependency Audit
- **Race Conditions:** The `registerPendingCreation` 3-second window vs. delayed `fsevents` notifications is the original race theory. Verified findings show that even if the watcher fires late, `is_epic` is preserved or re-asserted — so this window is likely a non-issue for *this* symptom. The fix must not extend the window indefinitely (that would suppress legitimate user edits to the epic file).
- **Security:** None. No new input surfaces, no external calls, no privilege changes.
- **Side Effects:**
  - `_regenerateEpicFile` writes the file a second time (line 8067) and already re-registers `registerPendingCreation` (line 8066). Any added re-registration is redundant, not harmful.
  - Subtask `updateEpicStatus` calls (line 7558) set `epic_id` on subtasks; if the epic's `is_epic` were reset, subtasks would remain linked but the badge would vanish. Verified: no reset path exists.
  - **Project assignment (NEW suspect):** `createEpic`'s `upsertPlan` (lines 7516–7538) sets **no `project`** (so `project=''`, `project_id=NULL`). When a project filter is active, `_refreshBoardImpl` queries `getBoardFilteredByProject` (line 2080); a project-less epic may be filtered off the active board entirely. This is a documented failure class for agent/file-derived plans. Confirm during diagnosis whether the board has an active project filter when the bug reproduces.
- **Dependencies & Conflicts:**
  - `promoteToEpic` path must remain unaffected — it modifies an existing record, not creating a new file.
  - `insertFileDerivedPlan` conflict behavior: on conflict preserves `is_epic`, `kanban_column`, `epic_id`, `status`; on fresh insert defaults `is_epic=0`, `kanban_column='CREATED'`.
  - `getPlanByPlanFile` / `_ensureRelativePlanFile` / `path.relative` must produce identical strings (verified consistent on macOS).

## Dependencies
- None. No prior session work is required for this plan to proceed.

## Adversarial Synthesis
**Risk Summary:** The plan's primary risk is *fixing a ghost* — the originally-hypothesised `is_epic` reset race is contradicted by the current code (filename-UUID derivation, consistent path normalization, `is_epic` set twice before refresh, `ON CONFLICT` never touching `is_epic`). Mitigation: lead with diagnostic instrumentation + a real reproduction attempt before applying changes, and widen the search to the project-filter and frontend paths. The retained defensive changes (reordered re-assertion, robust epic re-assert) are idempotent and low-risk, so keeping them as hardening is safe even if they don't explain the symptom.

## Proposed Changes

> **Sequencing:** Step 0 (diagnostics + reproduction) is mandatory and gates everything else. Apply Changes 1–4 only as low-risk hardening; do not present them as "the fix" until Step 0 identifies the real mechanism.

### Step 0 (DO FIRST): Confirm the root cause
1. Add the diagnostic log (Change 3 below) and reload.
2. Reproduce: select 2+ plans, create an epic. Immediately inspect the board payload / DOM for `isEpic` and the diagnostic log line for `is_epic`/`kanbanColumn`/`planFile`.
3. **If `is_epic=1` and the badge shows immediately** → the bug is already fixed; stop and report (Changes 1–4 become optional hardening only).
4. **If `is_epic=1` but the card is missing or unbadged on a filtered board** → the cause is the **project filter** (epic created with empty `project`); the correct fix is to stamp the epic with the board's active project at creation (mirrors existing agent-plan project-stamping behavior). Re-plan that change rather than shipping Changes 1/2/4.
5. **If `is_epic=0` is ever observed** → capture *when* (immediate refresh vs. a later watcher/scan refresh) and proceed with Changes 1–4.

### `src/services/KanbanProvider.ts` — `createEpic` handler (lines 7469–7562)

**Change 1 (defensive): Move `updateEpicStatus(planId, 1, '')` to AFTER all file writes.**

Currently called at line 7545 (before file writes). Move it to after `_regenerateEpicFile` and before `_refreshBoard`, so it is the **last DB write** before the board refresh, re-asserting `is_epic=1` as final state:

```typescript
// REMOVE the updateEpicStatus call at line 7545 (before writeFile)

// ... existing writeFile, subtask linking, _regenerateEpicFile ...

// AFTER all file writes — re-assert is_epic=1 as the final DB state
await db.updateEpicStatus(planId, 1, '');
await this._refreshBoard(workspaceRoot);
```
*Note: idempotent. Verified findings show `is_epic` is never reset on this path, so this is hardening, not a proven fix.*

**Change 2 (defensive, low-value): Re-register `registerPendingCreation` after `_regenerateEpicFile`.**

```typescript
await this._regenerateEpicFile(workspaceRoot, planId, db);
// Re-register to suppress any delayed watcher event from the regenerate write
GlobalPlanWatcherService.registerPendingCreation(epicPath);
await db.updateEpicStatus(planId, 1, '');
await this._refreshBoard(workspaceRoot);
```
*Note: `_regenerateEpicFile` already calls `registerPendingCreation(epicAbsPath)` internally at line 8066, so this is largely redundant. Include only if Step 0 shows a late watcher event.*

**Change 3 (DIAGNOSTIC — do this first): Log the epic's state after creation.**

```typescript
await db.updateEpicStatus(planId, 1, '');
const verifyEpic = await db.getPlanByPlanId(planId);
console.log(`[KanbanProvider] createEpic: verify is_epic=${verifyEpic?.isEpic}, kanbanColumn=${verifyEpic?.kanbanColumn}, project=${verifyEpic?.project}, projectId=${(verifyEpic as any)?.projectId}, planFile=${verifyEpic?.planFile}, activeProjectFilter=${this._projectFilter}`);
```
*Added `project`, `projectId`, and `activeProjectFilter` vs. the original to test the project-filter hypothesis (see Edge-Case audit).*

### `src/services/GlobalPlanWatcherService.ts` — `_handlePlanFile` (lines 447–601)

**Change 4 (no-op confirmation): epic-path `is_epic` re-assertion is already correct.**

Lines 594–596 already set `is_epic=1` for `.switchboard/epics/` files when `!plan.isEpic`. The fresh-insert branch (lines 577–579) does the same. No code change is required here; this entry exists only to document that the watcher already re-asserts `is_epic` for epic files and is not the reset vector. **Do not weaken the `!plan.isEpic` guard** — always-writing would add needless DB churn on every epic-file event.

## Uncertain Assumptions (RESOLVED via web research — 2026-06-25)
- **macOS `fsevents` / VS Code `FileSystemWatcher` notification latency — CONFIRMED.** The original race theory depends on file-watch notifications being delayed *beyond* the 3-second `registerPendingCreation` window. Research findings:
  - VS Code's watcher delegates to **`@parcel/watcher`**, whose FSEvents latency is hardcoded low (~10–50 ms). Under **normal local-dev conditions a single-file change is delivered well within 3 seconds**, so the watcher's `pendingCreations` guard (line 449) correctly skips the epic write. → The timing race is **not** a plausible explanation for the steady-state bug.
  - Multi-second delays **are** real, but only under **specific stress conditions**: FSEvents kernel-buffer overflow under heavy I/O (emits `MustScanSubDirs`, forcing a recursive re-scan that takes seconds/minutes), network-mounted volumes (SMB/NFS), or a compiler/bundler continuously writing artifacts that resets FSEvents coalescing. A developer with a build/bundler running in the same workspace could plausibly hit a >3 s delay.
  - **Net effect on this plan:** even under a >3 s delayed event, the verified findings still hold — the watcher's late `_handlePlanFile` run preserves/re-asserts `is_epic` for `epics/` files, so a late event does not produce the reported symptom. This further downgrades the watcher-race theory and reinforces the project-filter / frontend hypotheses as the priorities for Step 0. (All other claims in this plan were verified directly against the source.)

## Verification Plan

> Per session directive: no compilation step and no automated test suite run as part of this plan (the user runs tests separately).

### Manual / Behavioral
1. **Reproduce the original bug first** (before applying any change): Select 2+ plans on the kanban board, create an epic via the modal, and confirm whether the epic card appears without the EPIC badge. **Record whether a project filter is active.**
2. **Apply Change 3 (diagnostics) and reload.** Re-run the create flow and read the `[KanbanProvider] createEpic: verify ...` log line.
3. Select 2+ plans, create an epic. Confirm the epic card appears **immediately** with the `EPIC · N subtasks` badge.
4. Wait 5+ seconds (past the `registerPendingCreation` window) and trigger a board refresh. Confirm the epic **still** shows the EPIC badge.
5. Select the new epic card alone — confirm the EPIC button is **disabled** (proving `isEpic=true`). If it reads `PROMOTE TO EPIC`, `isEpic` is false.
6. **Project-filter check:** Repeat steps 3–5 with (a) no project filter and (b) an active project filter. If the epic only misbehaves under an active filter, the cause is project assignment, not a watcher race.
7. Verify the single-plan `promoteToEpic` path still works: select 1 plan, promote it, confirm the EPIC badge.
8. Check the debug console diagnostic line confirms `is_epic=1`, the expected `project`/`projectId`, and the `activeProjectFilter` value after creation.

### Automated Tests
- None run as part of this plan (skipped per session directive). If the user later adds coverage, the highest-value target is a `createEpic` unit/integration test asserting that, immediately after the handler returns, `getPlanByPlanId(planId).isEpic === 1`, the subtasks have `epic_id === planId`, and the board payload for the epic carries `isEpic: true` with the correct `subtaskCount` — under both filtered and unfiltered board states.

---

**Recommendation:** Complexity 5/10 → **Send to Coder.** The mechanical changes are simple, but the coder must treat Step 0 (diagnostic confirmation) as a gate and be prepared to redirect to the project-filter path if the watcher-race theory does not hold.

---

## Code Review Pass — 2026-06-26

### Stage 1: Grumpy Principal Engineer Review

> *Alright, let's see what the coder actually shipped vs. what the plan asked for. Popcorn ready.*

**[MAJOR] Change 1 was NOT applied — `updateEpicStatus` left before the file writes.**
`KanbanProvider.ts:7832` (pre-fix). The plan's Change 1 — the *primary* defensive change — explicitly said: "Move `updateEpicStatus(planId, 1, '')` to AFTER all file writes" so it's the last DB write before `_refreshBoard`. The coder left it sitting right after `upsertPlan`, before `writeFile` and `_regenerateEpicFile`. That's not "defensive hardening," that's "I read the plan and ignored the one mechanical instruction that mattered." The whole point was last-write-wins re-assertion; placing it before the file writes means any watcher event triggered by those writes can still stomp the state before refresh. Yes, the Verification Findings say `is_epic` is never reset — but if you're going to ship the defensive change at all, ship it *correctly*. Half-applied hardening is worse than none because it creates the illusion of safety.

**[MAJOR] Change 3 diagnostic log is missing `projectId` — the one field that tests the leading hypothesis.**
`KanbanProvider.ts:7849` (pre-fix). The plan *explicitly* called out `projectId=${(verifyEpic as any)?.projectId}` and even added a note: "Added `project`, `projectId`, and `activeProjectFilter` vs. the original to test the project-filter hypothesis." The coder shipped `project` and `activeProjectFilter` but **dropped `projectId`**. The plan's own Verification Findings concluded the project-filter is the most plausible remaining cause, and Step 0 point 4 says to check `projectId`. You can't diagnose a hypothesis you refused to log. This is the diagnostic equivalent of setting up a security camera and taping over the lens.

**[NIT] Undocumented column-resolution logic added outside plan scope.**
`KanbanProvider.ts:7775–7783`. The coder added `_normalizeLegacyKanbanColumn` to the subtask column resolution, a BACKLOG ordinal fallback, and an `effectiveColumn` that converts BACKLOG→CREATED. This is *not* in the plan. It's a reasonable fix for "epic not appearing on board" (an epic landing in BACKLOG might be invisible on a non-backlog board view), and it may actually address the real symptom better than the plan's `is_epic` focus. But it's undocumented in the plan and unreviewed. The plan's Step 0 was supposed to *identify* the root cause before shipping fixes — this pre-empts that gate.

**[NIT] `promoteToEpic` path got `_regenerateEpicFile` added — also undocumented.**
`KanbanProvider.ts:7747`. The single-plan promotion path now calls `_regenerateEpicFile` after the file move. Not in the plan. Probably correct (the moved file may be stale), but again, scope creep without review.

**[OK] Change 4 (no-op confirmation) — correctly verified, no change needed.**
`GlobalPlanWatcherService.ts:577–579` and `610–612` both re-assert `is_epic=1` for `epics/` files. The coder correctly left this alone. One thing done right.

### Stage 2: Balanced Synthesis

| Finding | Severity | Verdict | Action |
|---------|----------|---------|--------|
| `updateEpicStatus` not moved to after file writes | MAJOR | **Fix now** — the plan's primary defensive change; trivial mechanical move | ✅ Applied: moved to line 7850, after `_regenerateEpicFile`, before `_refreshBoard` |
| Diagnostic log missing `projectId` | MAJOR | **Fix now** — the plan explicitly required it for the project-filter hypothesis | ✅ Applied: added `projectId=${(verifyEpic as any)?.projectId}` to log line 7852 |
| Column-resolution logic (BACKLOG→CREATED, legacy normalization) | NIT | **Keep** — reasonable fix, likely addresses the real "not appearing" symptom; document in plan | Kept; documented below |
| `promoteToEpic` got `_regenerateEpicFile` | NIT | **Keep** — correct behavior, low risk | Kept; documented below |
| Change 2 (re-register `registerPendingCreation`) | — | **Defer** — plan said "include only if Step 0 shows a late watcher event"; no evidence yet | Not applied (correct per plan) |

### Fixes Applied

1. **`src/services/KanbanProvider.ts:7850`** — Moved `await db.updateEpicStatus(planId, 1, '')` from before `writeFile` to after `_regenerateEpicFile`, making it the last DB write before `_refreshBoard`. Added explanatory comment. (Plan Change 1)
2. **`src/services/KanbanProvider.ts:7852`** — Added `projectId=${(verifyEpic as any)?.projectId}` to the diagnostic console.log. (Plan Change 3 completion)

### Files Changed (by this review pass)
- `src/services/KanbanProvider.ts` — lines 7832–7852: moved `updateEpicStatus` call, added `projectId` to diagnostic log

### Pre-existing Implementation Changes (found in code, outside plan scope — retained)
- `src/services/KanbanProvider.ts:7775–7783` — Column resolution now normalizes legacy columns via `_normalizeLegacyKanbanColumn`, adds BACKLOG ordinal fallback, and converts BACKLOG→CREATED via `effectiveColumn`. Diagnostic log added for column resolution.
- `src/services/KanbanProvider.ts:7747` — `promoteToEpic` path now calls `_regenerateEpicFile` after file move.

### Validation Results
- **Compilation:** Skipped per session directive.
- **Tests:** Skipped per session directive.
- **Manual verification:** Not run in this session (requires VS Code extension runtime + kanban board interaction). The diagnostic log at line 7852 now captures all fields needed for Step 0 diagnosis (`is_epic`, `kanbanColumn`, `project`, `projectId`, `planFile`, `activeProjectFilter`).

### Remaining Risks
1. **Root cause still unconfirmed.** The plan's Step 0 (diagnostic reproduction) has not been executed in a live environment. The column-resolution fix may have already addressed the symptom (epic landing in BACKLOG/invisible column), but this is unverified.
2. **Project-filter hypothesis untested.** The `projectId` field is now logged but no live test has confirmed whether the epic is created with `project=''` / `project_id=NULL` and whether a filtered board hides it.
3. **Change 2 (re-register `registerPendingCreation`) deferred.** If Step 0 reveals a late watcher event stomping the epic file, this change will need to be applied.
4. **Column-resolution logic is undocumented in the original plan.** If it is the actual fix, the plan should be updated to reflect that the root cause was column placement, not `is_epic` state.

### Summary

| Severity | Finding | File:Line (pre-fix) | Fixed? |
|----------|---------|---------------------|--------|
| MAJOR | `updateEpicStatus` not moved after file writes (Change 1 not applied) | `KanbanProvider.ts:7832` | ✅ Fixed → line 7850 |
| MAJOR | Diagnostic log missing `projectId` (Change 3 incomplete) | `KanbanProvider.ts:7849` | ✅ Fixed → line 7852 |
| NIT | Undocumented column-resolution logic (BACKLOG→CREATED) | `KanbanProvider.ts:7775–7783` | Kept (documented) |
| NIT | `promoteToEpic` got undocumented `_regenerateEpicFile` | `KanbanProvider.ts:7747` | Kept (documented) |
| OK | Change 4 (watcher no-op) correctly verified | `GlobalPlanWatcherService.ts:577–612` | No change needed |
