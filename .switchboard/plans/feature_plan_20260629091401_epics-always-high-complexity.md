# Epics Are Always High Complexity (Regardless of Subtasks)

## Metadata
**Complexity:** 3
**Tags:** backend, kanban, epic, complexity, routing, migration, bugfix

## Goal

Make an epic's complexity **always High** — a constant property of being an epic, never derived from or averaged across its subtasks, and never `'Unknown'`. This makes epic routing deterministic and correct everywhere (board AUTOCODE drop, column dispatch, batch/preview), and fixes the current behavior where a default epic silently routes to the Coder lane.

### Problem Analysis

An epic's `complexity` is stored as `'Unknown'` at creation (`KanbanProvider.ts:8669`, `createEpicFromPlanIds`) and is **not** aggregated from subtasks (deliberate design: "Switchboard does not compute aggregate complexity"). That `'Unknown'` causes two concrete problems:

1. **Wrong lane on AUTOCODE drop.** When an epic is dragged into the AUTOCODE column with dynamic complexity routing on, the frontend lane resolver (`kanban.html:5652`, `resolveCodedAutoTarget`) does `parseInt(card.complexity)` → `NaN` for `'Unknown'` → returns **`CODER CODED`**. The whole epic + all subtasks are then dispatched to the **Coder** agent (the backend honors the frontend-chosen lane via `_columnToRole`). Subtask complexity is irrelevant — the epic's single score decides the lane for everything.

2. **Frontend/backend divergence.** The backend role resolvers (`resolveRoutedRole` / `scoreToRoutingRole`) map `'Unknown'`→score `0`→**`lead`** (the "Unknown defaults to lead" rule, `complexityScale.ts:64`). So the *same* `'Unknown'` epic routes to **Coder** if dragged to AUTOCODE but to **Lead** if advanced via the column button. Same card, two destinations — and the AUTOCODE path is semantically wrong (an epic is not "unknown" complexity; it is high).

The fix is not to rely on the `'Unknown'`→lead coincidence, but to make epics genuinely High so every read path agrees.

### Root Cause

There are three different complexity *sources* feeding routing — frontend `card.complexity` (DB), backend batch filters reading `c.complexity` (DB, `KanbanProvider.ts:2681,7426`), and backend per-session/role resolvers reading the plan **file** via `getComplexityFromPlan` (`KanbanProvider.ts:4961`, `TaskViewerProvider.ts:2103,13871`). Crucially, `getComplexityFromPlan` falls back to the **DB** complexity (its step 2, `KanbanProvider.ts:~4460`) when the file has no explicit complexity. Therefore **storing a real High score in the DB `complexity` column fixes all three read paths at once** — no per-site logic changes, no reliance on defaults.

One sharp edge to guard: `isValidComplexityValue('Unknown')` returns **true** (`complexityScale.ts`), so `updateComplexityByPlanFile`/`updateComplexityByPlanId` will happily write `'Unknown'` back. A self-heal or mirror-metadata sync that parses an epic file with no complexity line could therefore downgrade a stored `8` to `'Unknown'`. A write-layer guard is required to make "always High" actually hold.

## Decision (no open product questions)

- **Epic complexity = High = score `8`** (`categoryToScore('High')`). High, not Very High, matches the literal "high complexity"; the value flows through the existing routing map so custom maps are still honored.
- **Enforce at three layers** so the rule is true for new epics, existing epics, and against any future write path:
  1. **Creation** stores `8`.
  2. **Migration** backfills existing epics.
  3. **Write-guard** clamps any epic complexity write to a minimum of High.
- **Reads are untouched.** Storing `8` in the DB column makes the frontend, backend batch filters, and `getComplexityFromPlan` (DB fallback) all resolve `8`→lead uniformly. No derived `isEpic` checks scattered through routing.
- **Manual override is allowed upward only.** A user may raise an epic to Very High (9/10); attempts to set it below High are clamped back to `8`. This honors "epics should always have high complexity."
- **Subtasks are excluded.** The rule applies to `is_epic = 1` rows only. Subtasks keep their own complexity and route individually when dispatched standalone — this is the "regardless of subtasks" requirement (constant High for the epic, no aggregation).

### Rejected Alternatives
- *Pure derived (`isEpic ? 8 : …` at each read site)* — rejected: scatters checks across 3+ routing sites, leaves existing epics' **stored** complexity as `'Unknown'` (display surfaces stay inconsistent), and relies on the `'Unknown'`→lead coincidence for backend paths. Storing a real value is cleaner and matches the codebase's "real state over runtime fiction" preference.
- *Aggregate epic complexity from subtasks* — explicitly rejected by the requirement.
- *Fix only `resolveCodedAutoTarget`* — rejected: addresses the symptom (AUTOCODE lane) but leaves the stored value wrong and the frontend/backend divergence in place.

## Complexity Audit

### Routine
- Change the creation literal `'Unknown'` → `'8'`.
- Append one idempotent data-backfill UPDATE to the migration sequence.

### Complex / Risky
- The write-guard in `updateComplexityByPlanFile`/`updateComplexityByPlanId` adds an `is_epic` lookup before writing. Low risk, but it is the enforcement chokepoint — must be correct (clamp lower values, allow ≥ High, never block subtasks).

## Edge-Case & Dependency Audit

- **Custom routing map:** score `8` routes wherever the user's `routingMapConfig` sends `8` (default: lead). This is the user's explicit configuration and is respected — "high complexity" is honored regardless of where they route it.
- **Subtasks:** migration `WHERE is_epic = 1` does not touch subtasks (subtasks have `epic_id` set but `is_epic = 0`). Write-guard checks `is_epic` so subtask writes are unaffected.
- **Interaction with the Pair-button-removal plan** (`feature_plan_20260629085554_remove-per-card-pair-button.md`): with epics now High, an epic in PLAN REVIEWED will satisfy that button's `isHighComplexity` gate and show "Pair" — until the other plan removes the button. The two plans are compatible; if Pair is still present when this lands, epics simply gain it (resolved when the removal plan merges).
- **`getComplexityFromPlan` precedence:** a `**Manual Complexity Override:**` line in an epic file (step 1) still wins over the DB. That is intended (explicit user override) and does not conflict with the upward-only manual-override decision.
- **Display surfaces:** Epics-tab / archive that read `complexity` now show "High" consistently for all epics. The board card already shows "EPIC: N SUBTASKS" instead of a complexity chip (`kanban.html:5384`), so it is unaffected.

### Migration safety (per CLAUDE.md — epics shipped in a released version)
- Backfill is idempotent and best-effort (mirrors the existing V3 zombie-plan `UPDATE` precedent at `KanbanDatabase.ts:4303-4308`).
- No-op for epics already carrying a numeric score; only `'Unknown'`/empty/NULL are upgraded.
- No keys or rows dropped; subtasks and non-epic plans untouched.

## Proposed Changes

### 1. `src/services/KanbanProvider.ts` — store High at epic creation
- Add `categoryToScore` to the import (`:25`):
  ```ts
  import { legacyToScore, scoreToRoutingRole, parseComplexityScore, categoryToScore } from './complexityScale';
  ```
- In `createEpicFromPlanIds` (`:8669`), change the upsert field:
  ```ts
  complexity: String(categoryToScore('High')),   // '8' — epics are always High (was 'Unknown')
  ```

### 2. `src/services/KanbanDatabase.ts` — backfill existing epics
- In `_runMigrations` (`:4291`), append a new idempotent step alongside the other data fixes (same try/exec pattern as V3):
  ```ts
  // V-epic-complexity: epics are always High; upgrade legacy 'Unknown'/empty epics to score 8.
  try {
      this._db.exec(
          "UPDATE plans SET complexity = '8' WHERE is_epic = 1 AND (complexity = 'Unknown' OR complexity = '' OR complexity IS NULL)"
      );
  } catch { /* best effort */ }
  ```

### 3. `src/services/KanbanDatabase.ts` — write-guard (clamp epic complexity to ≥ High)
- In `updateComplexityByPlanId` (`:1630`) and `updateComplexityByPlanFile` (`:1609`), after validation, look up the target row's `is_epic`. If it is an epic and the incoming value parses to a score `< 7` (or is `'Unknown'`/legacy `Low`/`Medium`), substitute `'8'` before the UPDATE and log the clamp. Values `≥ 7` (High/Very High) pass through unchanged. Pseudocode:
  ```ts
  let effective = complexity;
  const row = /* SELECT is_epic FROM plans WHERE plan_id = ? (or plan_file = ? AND workspace_id = ?) */;
  if (row?.is_epic) {
      const score = parseComplexityScore(complexity); // 'Unknown'/Low/Medium -> < 7
      if (score < 7) { effective = '8'; console.log(`[KanbanDatabase] Clamped epic complexity ${complexity} -> 8`); }
  }
  // ...UPDATE with `effective`
  ```

## Verification Plan

### Automated
- **Frontend unit:** `resolveCodedAutoTarget` for an epic card whose `complexity = '8'` returns `'LEAD CODED'` (with dynamic routing on and a default routing map).
- **Creation:** `createEpicFromPlanIds` writes `complexity = '8'` to the DB.
- **Migration:** seed an epic with `'Unknown'`, a subtask (`is_epic = 0`, `epic_id` set) with `'5'`, and a non-epic plan with `'Unknown'`; run `_runMigrations`; assert only the epic becomes `'8'`.
- **Write-guard:** `updateComplexity*` on an epic with `'5'` → stored `'8'`; with `'10'` → stored `'10'`; on a subtask with `'5'` → stored `'5'` (unaffected).
- `npm test` green.

### Manual (installed VSIX — dev does not use `dist/`)
1. Create a new epic; confirm it routes to **LEAD CODED** when dragged to AUTOCODE (dynamic routing on), and the lead agent is dispatched with epic + subtasks; epic + subtasks cascade together.
2. Turn dynamic routing **off**; drag epic to AUTOCODE → still LEAD CODED.
3. Advance the same epic via the column button and via AUTOCODE drag → **same** destination (Lead) both ways (divergence gone).
4. On an upgraded install, a pre-existing epic (previously `'Unknown'`) now routes to Lead after the backfill.
5. Try to set an epic's complexity to Medium via the complexity control → it clamps back to High; setting Very High sticks.
