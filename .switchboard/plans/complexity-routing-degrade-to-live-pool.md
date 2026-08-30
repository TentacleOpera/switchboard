# Complexity Routing Degrades to the Live Terminal Pool

## Goal

Make complexity routing choose the preferred tier when available, otherwise degrade across the live terminal pool. If only one coding agent exists, send everything to it. The degradation is bidirectional — a high-complexity card degrades down to coder/intern if no lead is live, and a low-complexity card degrades up to coder/lead if no intern is live.

### Problem

Complexity routing selects an exact role (1–4 → intern, 5–6 → coder, 7–10/unknown → lead) and then looks for a terminal with that exact role. If no terminal with the preferred role is live, dispatch fails with "No agent assigned to role 'X'" — it does not degrade to another available role. The intern → coder → lead fallback only fires after an agent *reports failure*, not when the preferred role is simply *absent from the pool*.

Additionally, `getAliveCodingTerminalNames()` only collects `lead` and `coder` terminals — interns are excluded entirely. This means an intern-only grid cannot enable the Run-queue button, and the queue dispatch fallback never finds an intern as a coding head.

#### Current behavior matrix

| Available agents | Current result |
|---|---|
| No intern, low-complexity card | Dispatch fails |
| Only intern | Run queue disabled; all dispatch fails |
| Only coder | Medium cards work; low/high cards fail |
| Only lead | High cards work; low/medium cards fail |

#### Expected behavior

| Available agents | Expected result |
|---|---|
| No intern, low-complexity card | Degrades to coder (or lead if no coder) |
| Only intern | Run queue enabled; all cards route to intern |
| Only coder | All cards route to coder |
| Only lead | All cards route to lead |

### Root Causes

Three independent gaps combine to produce the failure:

#### Gap 1: `_resolveAgentTerminalForPlan` has no cross-role degradation

`_resolveAgentTerminalForPlan` (<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts" /> lines 10064–10097) tries worktree match → team match → PTY fleet match → `_getAgentNameForRole`, all scoped to the *exact* requested role. If none finds a terminal with that role, it returns `undefined`. Every caller then fails:

- UI dispatch (line 21677): shows "No agent assigned to role 'X'"
- Batch dispatch (lines 6276, 6968, 6982): same error
- Pair program (line 12010): "no Coder terminal found"

#### Gap 2: `getAliveCodingTerminalNames` excludes interns

`getAliveCodingTerminalNames` (lines 1926–1950) only collects `lead` and `coder` terminals. Interns are never added to the result. This breaks:

- `anyCodingTerminalLive` (KanbanProvider lines 1295, 2299, 4021, 4226) — false when only interns are live → Run-queue button stays disabled
- Queue dispatch fallback (TaskViewerProvider line 12082) — won't find an intern as coding head
- `_scheduleQueuePop` (lines 13255–13265) — resolves lead → coder → dead end, never tries intern

#### Gap 3: `resolveCodingRolesFromGroups` / `resolveCodingHeadFromGroups` exclude interns

`resolveCodingRolesFromGroups` (KanbanProvider lines 5295–5330) only collects leads and coders from team groups. An intern-headed team is invisible. `resolveCodingHeadFromGroups` (lines 5338–5343) returns null when only an intern head is live, breaking queue dispatch, schedule queue pop, and queue watch arming.

## Metadata

**Complexity:** 6
**Tags:** backend, bugfix, feature, reliability
**Project:** Browser Switchboard

## User Review Required

This plan introduces bidirectional complexity degradation — a high-complexity card may route to an intern, or a low-complexity card to a lead, when the preferred role has no live terminal. This is a deliberate product decision (the alternative is dispatch failure), but it means an agent may receive a card outside its intended complexity band. Review and confirm this is acceptable before implementation.

## Complexity Audit

### Routine
- Adding a pure `resolveRoleWithDegradation` function to `complexityScale.ts` — no side effects, trivially unit-testable
- Including interns in `getAliveCodingTerminalNames` — adding one more `Set` to an existing loop (lines 1926–1950)
- Including interns in `resolveCodingRolesFromGroups` — adding one more array to an existing loop (lines 5295–5330)
- Including intern in `resolveCodingHeadFromGroups` — adding one more fallback check (lines 5338–5343)
- `anyCodingTerminalLive` automatically corrects after intern inclusion in `getAliveCodingTerminalNames` — no code change needed (verify only)

### Complex / Risky
- Bidirectional degradation in `_resolveAgentTerminalForPlan` — the central choke point for ALL dispatch paths (UI, batch, pair program, queue). A bug here breaks every dispatch, not just edge cases
- `resolveAutoDispatchColumn` liveness check (Step 7) — introduces a second independent liveness read within the same dispatch, creating a potential column-terminal mismatch if a terminal dies between the two reads (low probability, cosmetic impact — documented as known limitation)
- Pair programming mode interaction — degradation must not offer `intern` as a target when pair mode is active, adding conditional pool-filtering logic
- Hidden-column interaction — degradation must exclude roles whose coding column the operator has hidden; visibility is an operator intent signal, not just a UI preference

## Edge-Case & Dependency Audit

**Race Conditions:**
- `resolveAutoDispatchColumn` (Step 7) and `_resolveAgentTerminalForPlan` (Step 3) each read liveness independently within the same `performKanbanDispatch` call. If a terminal exits between the two reads (millisecond window), the card lands in a column that doesn't match the terminal that received it. Impact is cosmetic (wrong column label), not functional (card is still dispatched). Documented as a known limitation; resolving terminal-first would require reordering `performKanbanDispatch`, which is outside this plan's scope.

**Security:**
- No new attack surface. Degradation only selects among already-registered, already-live terminals. No user input is passed to the degradation helper — it receives a preferred role and a `Set` of available roles, both derived from internal state.

**Side Effects:**
- A card may be dispatched to an agent outside its intended complexity band (e.g., complexity-5 card to an intern). This is the explicit product decision behind bidirectional degradation. The dispatch reason string must include the degradation decision (e.g., "degraded coder→intern") so the operator is aware.
- `getAliveCodingTerminalNames` return order changes from `leads → coders` to `leads → coders → interns`. Callers that depend on ordering (e.g., picking `[0]` as the head) are unaffected — leads are still first.

**Dependencies & Conflicts:**
- `restrictToOriginTeam` path in `performKanbanDispatch` (LocalApiServer line 1525–1528) returns a 409 before reaching `_resolveAgentTerminalForPlan`. The workspace-wide degradation in Step 3 only fires for the non-restricted path. Team-scoped dispatch is not affected — a team-scoped miss refuses, it does not leak to another team's terminal.
- Custom routing maps (`kanban.routingMapConfig`) are respected — degradation happens *after* `resolveRoutedRole` determines the preferred role. Only the fallback changes.
- `_validateOrDegradeCodingColumn` throws `KanbanDispatchError` when no coding column is visible. Terminal-level degradation must not override this — if all coding columns are hidden, dispatch fails regardless of terminal liveness. The degradation only fires when the column is visible but no terminal with that role is live.
- PTY fleet terminals: `getAliveCodingRolesWithTerminals` must include PTY fleet terminals via `getFleetLiveness()`, same as `getAliveCodingTerminalNames` does.
- Dead code — `_autobanRoutePlanReviewedCard` (line 12057): defined but has no callers. Uses `resolveRoutedRole` but never resolves a terminal. No change needed — if called in the future, the degradation in `_resolveAgentTerminalForPlan` will cover it.
- `getAliveRoleTerminalNames` vs `getAliveCodingTerminalNames`: different data sources. `getAliveRoleTerminalNames` reads from `_getAliveAutobanTerminalRegistry` (deprecated state.json path). `getAliveCodingTerminalNames` reads from `_terminalAgentInfo` + `getFleetLiveness()`. The new `getAliveCodingRolesWithTerminals` must use the same sources as `getAliveCodingTerminalNames` (the non-deprecated path).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) pool-map shortcut in Step 3 would bypass worktree/team affinity — corrected to re-run the full resolution chain with the degraded role; (2) Step 6 originally used the deprecated `getAliveRoleTerminalNames` — corrected to use the new `getAliveCodingRolesWithTerminals`; (3) hidden-column roles must be filtered from the degradation pool to respect operator intent — added; (4) column-terminal TOCTOU mismatch in Step 7 is low-probability and cosmetic — documented as a known limitation. Mitigations: commit to the resolution chain (not the pool map), use non-deprecated data sources, filter by column visibility, and surface degradation decisions in the dispatch reason string.

## Proposed Changes

### `src/services/complexityScale.ts`

**Context:** This module is the single source of truth for complexity scoring and role routing. It already has `scoreToRoutingRole` (score→role) and `getFallbackRole` (upward-only fallback: intern→coder→lead). The plan adds a bidirectional degradation helper.

**Logic:** Add a pure function that, given a preferred role and the set of available roles, returns the nearest available role — searching outward in both directions (upward first, then downward).

**Implementation:**

```typescript
/**
 * Resolve the preferred role against the live pool, degrading to the
 * nearest available role if the preferred role has no live terminal.
 * Search order: preferred → next-up (intern→coder→lead) → next-down
 * (lead→coder→intern). Returns null when the pool is empty.
 */
export function resolveRoleWithDegradation(
    preferred: 'intern' | 'coder' | 'lead',
    available: Set<'intern' | 'coder' | 'lead'>
): 'intern' | 'coder' | 'lead' | null
```

The ladder is `['intern', 'coder', 'lead']`. Search outward from the preferred index: check index, then index+1, then index-1, then index+2, then index-2, etc. This gives:
- preferred=intern, available={coder} → coder
- preferred=intern, available={lead} → coder (not found) → lead
- preferred=lead, available={intern} → coder (not found) → intern
- preferred=coder, available={intern} → coder (not found) → intern (nearest down)
- preferred=coder, available={lead} → lead (nearest up)
- preferred=any, available={} → null

The upward-first bias means degradation prefers promoting to a higher-capability role (intern→coder rather than staying at intern) when both directions are available. This minimizes the risk of under-assigning capability.

**Edge Cases:** Empty pool returns `null`. Single-role pool returns that role if different from preferred. Full pool returns preferred.

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/complexityScale.ts" />

### `src/services/TaskViewerProvider.ts`

**Context:** This file contains the dispatch choke point (`_resolveAgentTerminalForPlan`), the liveness query (`getAliveCodingTerminalNames`), the queue pop scheduler (`_scheduleQueuePop`), and all UI/batch dispatch callers. Three of the eight steps touch this file.

**Logic — Step 2: Add `getAliveCodingRolesWithTerminals`:**

Add a new public method that returns a map of live coding role → first available terminal name, including interns. This generalizes `getAliveCodingTerminalNames` with role information.

```typescript
/**
 * Returns the set of live coding roles and one terminal name per role.
 * Includes intern (unlike getAliveCodingTerminalNames). Reads from
 * _terminalAgentInfo + getFleetLiveness(), same sources as
 * getAliveCodingTerminalNames.
 */
public getAliveCodingRolesWithTerminals(): Map<'intern' | 'coder' | 'lead', string>
```

Implementation mirrors `getAliveCodingTerminalNames` (lines 1926–1950) but:
- Adds an `interns` set alongside `leads` and `coders`
- Returns a `Map` of role → terminal name (first alive per role)
- Includes intern in the fleet liveness loop (`role === 'intern'`)
- Includes intern in the `_terminalAgentInfo` loop (`role === 'intern'`)

**Logic — Step 3: Add degradation fallback to `_resolveAgentTerminalForPlan`:**

After the existing resolution chain (worktree → team → PTY fleet → `_getAgentNameForRole`) returns `undefined` for the preferred role, add a degradation pass:

1. Call `getAliveCodingRolesWithTerminals()` to get the live pool.
2. Build the available roles `Set` from the pool map keys.
3. **Filter out roles whose coding column is hidden** — call `_taskViewerProvider?._getVisibleAgents()` (or equivalent) and exclude any role whose column is not visible. This respects operator intent: a hidden INTERN column means intern is not a valid degradation target.
4. **Filter out `intern` when pair programming mode is active** — same check as line 12073–12076 (`_autobanState?.pairProgrammingMode !== 'off'`).
5. Call `resolveRoleWithDegradation(preferredRole, filteredAvailable)`.
6. If degradation returns a role, **re-run the full resolution chain** (`_resolveAgentTerminalForPlan` recursively, or inline the worktree → team → PTY fleet → `_getAgentNameForRole` sequence) with the degraded role. This preserves worktree affinity and team boundaries.

> **Superseded:** Step 3 bullet 4 originally said "resolve a terminal for that role using the same chain (worktree → team → PTY fleet → `_getAgentNameForRole`), **or just use the terminal from the pool map directly**."
> **Reason:** The pool map shortcut bypasses worktree matching and team-scoped resolution. A coder assigned to worktree A would receive a card meant for worktree B because it was the "nearest available role." The pool map tells you WHAT is available, not WHO should get the card. The four-step resolution chain respects worktree affinity and team boundaries — it must not be bypassed.
> **Replaced with:** Re-run the full resolution chain with the degraded role. The pool map is used only to determine availability (Step 2–3), not to select the terminal (Step 6).

7. If degradation returns `null` (empty pool after filtering), return `undefined` as before — the caller will show the error.
8. **Include the degradation decision in the dispatch reason string** — when degradation fires, the caller should surface "degraded {preferred}→{degraded}" so the operator knows the card may exceed the agent's intended complexity band.

**Edge case — `restrictToOriginTeam`:** When the caller passes `restrictToOriginTeam: true` (the external-headed queue/next branch in LocalApiServer), the degradation should NOT cross team boundaries. The team-scoped resolution in `performKanbanDispatch` (line 1525–1528) already returns a 409 on a team miss. The degradation in `_resolveAgentTerminalForPlan` is workspace-wide and would leak across teams. To prevent this, the `restrictToOriginTeam` case must be handled BEFORE `_resolveAgentTerminalForPlan` is called — the existing 409 in `performKanbanDispatch` already gates this. No change needed there; the degradation in `_resolveAgentTerminalForPlan` only fires for the non-restricted path.

**Logic — Step 4: Include interns in `getAliveCodingTerminalNames`:**

Add an `interns` set to the method and include intern terminals in the returned array. The return order becomes: leads (sorted) → coders (sorted) → interns (sorted).

**Logic — Step 6: Include intern in `_scheduleQueuePop` head fallback:**

In `_scheduleQueuePop` (lines 13255–13265), after trying lead and coder, also try intern.

> **Superseded:** Step 6 originally used `getAliveRoleTerminalNames('intern', workspaceRoot)` for the intern fallback.
> **Reason:** `getAliveRoleTerminalNames` reads from `_getAliveAutobanTerminalRegistry` (the deprecated state.json path) and is invisible to PTY fleet terminals. The plan's own edge case 7 acknowledges this. Using the deprecated path for a new fallback extends a known-broken data source. Step 2 introduces `getAliveCodingRolesWithTerminals` (the non-deprecated path including interns) — it should be used here.
> **Replaced with:** Use `getAliveCodingRolesWithTerminals()` to check for a live intern, or `getAliveCodingTerminalNames()` (which now includes interns after Step 4) and filter for the intern role. Either avoids the deprecated `getAliveRoleTerminalNames` path.

```typescript
if (!headTerminal) {
    const roles = this.getAliveCodingRolesWithTerminals();
    if (roles.has('intern')) { headTerminal = roles.get('intern')!; }
}
```

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/TaskViewerProvider.ts" />

### `src/services/KanbanProvider.ts`

**Context:** This file contains the team-group role resolution (`resolveCodingRolesFromGroups` / `resolveCodingHeadFromGroups`), the column-level dispatch resolution (`resolveAutoDispatchColumn`), and the `anyCodingTerminalLive` computation. Three steps touch this file.

**Logic — Step 5: Include interns in `resolveCodingRolesFromGroups` and `resolveCodingHeadFromGroups`:**

**`resolveCodingRolesFromGroups`** (lines 5295–5330):
- Add an `interns` array alongside `leads` and `coders`.
- In the group iteration loop (line 5323), add `else if (role === 'intern') interns.push(headName)`.
- Change the return type to include `interns: string[]`.
- Sort interns.

**`resolveCodingHeadFromGroups`** (lines 5338–5343):
- After leads and coders, try interns: `if (interns.length > 0) return interns[0]`.

**Logic — Step 7: Add degradation to `resolveAutoDispatchColumn` (column-level):**

`resolveAutoDispatchColumn` (lines 8806–8822) currently degrades the column based on `visibleAgents` (column visibility) via `_validateOrDegradeCodingColumn`. But visibility ≠ liveness — a column can be visible with no live terminal.

After determining the preferred role (line 8818), check if that role has a live terminal by calling `_taskViewerProvider?.getAliveCodingRolesWithTerminals()`. If the preferred role is not in the live pool, call `resolveRoleWithDegradation` to find the nearest live role, then use that role's column instead.

This ensures the card lands in the column matching the terminal that will actually do the work (e.g., a low-complexity card with no live intern lands in CODER CODED, not INTERN CODED).

**Known limitation:** `resolveAutoDispatchColumn` and `_resolveAgentTerminalForPlan` make independent liveness reads within the same `performKanbanDispatch` call. If a terminal exits between the two reads (millisecond window), the card may land in a column that doesn't match the terminal that received it. Impact is cosmetic (wrong column label), not functional (card is still dispatched). Resolving terminal-first would require reordering `performKanbanDispatch`, which is outside this plan's scope.

**Logic — Step 8: Update `anyCodingTerminalLive` to account for interns:**

The `anyCodingTerminalLive` computation (KanbanProvider lines 1295, 2299, 4021, 4226) uses `getAliveCodingTerminalNames().length > 0`. After Step 4 includes interns, this automatically becomes true when only interns are live. No code change needed beyond Step 4 — verify this is the case.

<ref_file file="/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/KanbanProvider.ts" />

## Verification Plan

### Automated Tests

- [ ] **Unit test: `resolveRoleWithDegradation`** — test all combinations of preferred role × available roles, including empty pool, single-role pool, and full pool. Verify the nearest-role selection order (upward first, then downward).
- [ ] **Unit test: `getAliveCodingRolesWithTerminals`** — mock `_terminalAgentInfo` and `getFleetLiveness()` with intern/coder/lead entries; verify all three roles appear in the map.
- [ ] **Unit test: `getAliveCodingTerminalNames` includes interns** — mock an intern-only terminal set; verify the returned array is non-empty.
- [ ] **Integration test: intern-only grid enables Run-queue** — verify `anyCodingTerminalLive` is true when only an intern terminal is live.
- [ ] **Integration test: degradation on dispatch** — mock a coder-only live pool; dispatch a low-complexity card (score 3, preferred role=intern); verify it routes to the coder terminal and lands in CODER CODED.
- [ ] **Integration test: single-agent grid gets everything** — mock a lead-only live pool; dispatch cards of all complexity levels; verify all route to the lead.
- [ ] **Integration test: pair mode excludes intern degradation** — with pair mode active and only an intern live, verify dispatch fails (pair bypass means intern is not a valid target) rather than routing to intern.
- [ ] **Integration test: team-scoped dispatch still refuses** — with `restrictToOriginTeam: true` and no matching role on the team, verify 409 is returned (no cross-team degradation).
- [ ] **Integration test: hidden-column role excluded from degradation** — with the INTERN column hidden and only an intern live, verify dispatch fails rather than degrading to intern.
- [ ] **Integration test: degradation reason in dispatch string** — verify the dispatch reason includes "degraded {preferred}→{degraded}" when degradation fires.
- [ ] **Run existing tests:** `npm test` — verify no regressions in `kanban-complexity.test.ts` and `pair-programming-comprehensive.test.ts`.
- [ ] **Compile check:** `npm run compile` — verify no type errors.

## Implementation Summary
Implemented bidirectional complexity routing degradation across the live coding terminal pool. Added `resolveRoleWithDegradation` in `complexityScale.ts` to search outward (upward bias first) from the preferred role against live, visible roles. Updated `TaskViewerProvider.ts`, `KanbanProvider.ts`, and `PtyFleetService.ts` to enforce strictly PTY-only terminal collection with role-bearing liveness in both extension and standalone hosts, degrade `recommendedRole` on plan reads across the live pool, degrade unknown-complexity cards across the live pool, honestly refuse dispatch when all live roles are hidden or ineligible, and prevent non-PTY worktree matches from suppressing live-pool degradation. Added unit and contract tests in `kanban-complexity.test.ts`, `queue-pipeline-contract.test.js`, and `standalone-agent-team-isolation-contract.test.js`.
