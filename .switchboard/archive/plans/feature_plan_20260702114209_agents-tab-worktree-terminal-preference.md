# Agents Tab Terminal List Does Not Respect Worktree Terminals

**Plan ID:** a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d

## Goal

Make the agents tab in `implementation.html` prefer worktree-scoped terminals over main-workspace terminals when a worktree is active, so the displayed terminal name, status dot, and dispatch target all reflect the worktree the user is actually working in.

### Problem

When a worktree is active for a project, the agents tab in `implementation.html` shows the original workspace terminals instead of the worktree terminals. The user expects the agents tab to display the worktree terminals (which are scoped to the worktree path) when a worktree is active, not the main workspace terminals.

### Background Context

Switchboard supports git worktrees for isolated development. When a worktree is active, dedicated terminals are created inside the worktree path (via `ensureWorktreeTerminals` in `TaskViewerProvider.ts:7422`). These worktree terminals have a `worktreePath` field set in their terminal state record.

The backend already has worktree-aware dispatch routing: `_computeDispatchReadiness` (line 1933-1948 of `TaskViewerProvider.ts`) prefers worktree terminals when a plan is worktree-routed. It sets `isWorktreeTerminal: true` on the dispatch readiness entry and routes to the worktree terminal name.

However, the **display** layer in the agents tab does not use this worktree preference. The agents tab uses a `findTerminalFn` callback that simply finds the first terminal with a matching role:

```js
terminals => Object.keys(terminals).find(key => terminals[key].role === 'planner')
```

This finds whichever terminal appears first in object key iteration order — typically the main workspace terminal, not the worktree terminal.

### Root Cause Analysis

In `createAgentRow` (line 2701 of `implementation.html`), the terminal name resolution is:

```js
const termName = explicitTermName || (findTerminalFn ? findTerminalFn(lastTerminals) : null);
const dispatchInfo = lastDispatchReadiness && roleId ? lastDispatchReadiness[roleId] : null;
const routedTermName = (dispatchInfo && dispatchInfo.terminalName) ? dispatchInfo.terminalName : null;
const resolvedTermName = termName || routedTermName;
```

`termName` (from `findTerminalFn`) takes **priority** over `routedTermName` (from `dispatchReadiness`, which is worktree-aware). So even when `dispatchReadiness` correctly identifies a worktree terminal, the display falls back to the main workspace terminal found by `findTerminalFn`.

Additionally, `findTerminalFn` itself has no worktree awareness — it returns the first role-matching terminal regardless of whether it's a worktree or main terminal.

The `enrichedTerminals` object sent from the backend (line 18510-18547 of `TaskViewerProvider.ts`) does include `worktreePath` on each terminal entry (spread from `terminalsMap[key]`), so the frontend has the data needed to distinguish worktree terminals — it just doesn't use it.

**Scope gap discovered during review:** The original plan only covered the 8 `findTerminalFn` callbacks in `renderAgentList`. Two additional sites use their own inline `Object.keys(lastTerminals).find(...)` pattern that bypasses `findTerminalFn` entirely:
- `isAgentGreen` (line 2947) — heartbeat fallback for agents with no dispatch info.
- `createAnalystRow` (line 3341) — the Analyst row's own terminal lookup.

Both must be updated for the display layer to be consistently worktree-aware, or the Analyst row and green-dot status will still reference the main-workspace terminal while other rows correctly prefer worktree ones.

## Metadata

- **Complexity:** 4
- **Tags:** bugfix, ui, frontend, backend

## User Review Required

None. Pure display-layer preference fix; no state migration, no schema change.

## Complexity Audit

### Routine
- Adding a shared `findTerminalByRole` helper near line 2491 (after the `// --- Rendering ---` comment).
- Rewiring the 8 `findTerminalFn` callbacks in `renderAgentList` (lines 3050, 3060, 3068, 3076, 3084, 3091, 3118, 3126) to use the helper.
- Updating `isAgentGreen` (line 2947) and `createAnalystRow` (line 3341) inline finds to prefer worktree terminals.
- Adjusting the `resolvedTermName` priority in `createAgentRow` (line 2709) to prefer worktree-routed terminals from `dispatchReadiness`.
- Extending the `(worktree)` suffix check (line 2764) to also fire when the resolved terminal itself has `worktreePath` (not only when `dispatchInfo.isWorktreeTerminal` is set).

### Complex / Risky
- The `findTerminalFn` is called for every agent row on every re-render. Adding worktree preference logic must remain O(n) in terminal count (it already is — `Object.entries().find()` is O(n)).
- The `dispatchReadiness` worktree preference only activates when a plan is selected (it looks up the plan's worktree path from the DB). When no plan is selected, there's no worktree context, so `findTerminalFn` is the only signal. The fix handles both cases: plan-selected (use dispatch readiness) and no-plan (prefer worktree terminals in findTerminalFn).
- Must not break the `(worktree)` suffix display (line 2764-2765) which already checks `dispatchInfo.isWorktreeTerminal` — this will now correctly fire more often.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `findTerminalByRole` reads `lastTerminals` (the most recent `terminalStatuses` payload) synchronously on render; no concurrent mutation.
- **Security:** No untrusted input; role strings are hardcoded literals from the agent-role definitions.
- **Side Effects:** Display-only. No terminal state mutation, no dispatch routing change (routing is already worktree-aware in `_computeDispatchReadiness`).
- **Dependencies & Conflicts:** Shares the `implementation.html` render path with the planner-suffix fix (subtask: "Planner Agent Row Shows IDE-Suffixed Terminal Name"). That plan changes the *content* of `lastPlannerTarget`; this plan changes *which* terminal the row resolves to when `findTerminalFn`/`dispatchReadiness` is used. Applied together: a worktree planner terminal should show a stripped, unsuffixed name with a `(worktree)` suffix. The two edits do not overlap at the line level. Verify the combined state during the epic verification pass.
1. **No worktree active**: When no worktree terminals exist, `findTerminalByRole` behaves exactly as before — find the first role-matching terminal. The worktree preference is a tiebreaker, not a filter.
2. **`suppressMainTerminals` is on**: When main terminals are suppressed, only worktree terminals exist in `enrichedTerminals`. `findTerminalByRole` will naturally find them. The fix is a no-op in this case — correct.
3. **`suppressMainTerminals` is off (both exist)**: This is the primary bug scenario. Both main and worktree terminals are registered. `findTerminalByRole` currently finds the main one first. The fix prefers the worktree one.
4. **Multiple worktrees**: If multiple worktrees are active (e.g. per-subtask mode), there may be multiple worktree terminals for the same role. `findTerminalByRole` prefers any worktree terminal over a main terminal. The specific worktree selection for dispatch is already handled by `dispatchReadiness` (which uses the plan's worktree path). The display just needs to show *a* worktree terminal, and `dispatchReadiness` refines the exact one for dispatch.
5. **Chat-only agents**: Chat agents (`_isChat: true`, no `_isLocal`) don't have worktree variants. `findTerminalByRole` finds them by role as before; the `worktreePath` check simply won't match (chat agents have no `worktreePath`). The locate-button disable logic (line 2827-2829) is unaffected.
6. **Jules**: Jules is a cloud service, not a terminal. It is handled separately at line 2940 (`if (roleId === 'jules') return false;` in `isAgentGreen`) and has no terminal entry. The `findTerminalFn` for `'jules'` at line 3126 will never find a match (no terminal with `role === 'jules'` exists), so the worktree preference is a no-op for Jules. Leave the Jules `findTerminalFn` callback in place for consistency but it is effectively dead.
7. **Dispatch readiness without plan**: `_computeDispatchReadiness` is called from `_refreshTerminalStatuses` (line 18574) without a `plan` argument. It falls back to looking up the plan by `this._lastSessionId` (line 1853-1868). If no plan is selected, no worktree preference is applied in dispatch readiness. The `findTerminalByRole` fix covers this gap.
8. **`isAgentGreen` (line 2947) and `createAnalystRow` (line 3341)**: Both bypass `findTerminalFn`. Without updating them, the Analyst row and the green-dot heartbeat fallback would still pick the main-workspace terminal while other rows prefer worktree ones — an inconsistency. Update both to use the same `findTerminalByRole` preference.

## Dependencies

None. This plan is self-contained. It shares the `implementation.html` render path with the planner-suffix subtask but does not edit the same lines; a combined verification pass is recommended (see Verification Plan).

## Adversarial Synthesis

Key risk: the original plan covered only 8 of 10 terminal-resolution sites in the display layer, leaving `isAgentGreen` (line 2947) and `createAnalystRow` (line 3341) with their own inline `Object.keys().find()` that would still prefer main-workspace terminals — producing an inconsistent UI where most rows show the worktree terminal but the Analyst row and green-dot status reference the main one. Mitigation: extend `findTerminalByRole` usage to all 10 sites. Secondary risk: the `resolvedTermName` priority flip must only override when `dispatchInfo.isWorktreeTerminal` is true, not unconditionally, so that the no-plan case (where `dispatchReadiness` has no worktree info) still falls back to `findTerminalByRole`.

## Proposed Changes

### File: `src/webview/implementation.html`

> **Implementer note:** Line numbers are verified against current source. If shifted, grep for `Object.keys(terminals).find(key => terminals[key].role ===` to locate all `findTerminalFn` sites, and grep for `Object.keys(lastTerminals).find(key => lastTerminals[key]` for the two inline-find sites.

#### Change 1: Add `findTerminalByRole` helper

Add a shared helper near the top of the rendering section (after the `// --- Rendering ---` comment at line 2491, before `renderRunSheetDropdown` at line 2493):

```js
function findTerminalByRole(terminals, role) {
    const entries = Object.entries(terminals);
    // Prefer worktree terminals (worktreePath set) over main workspace terminals
    const worktreeMatch = entries.find(([, info]) =>
        info?.role === role && info?.worktreePath
    );
    if (worktreeMatch) return worktreeMatch[0];
    // Fall back to any terminal with matching role
    const anyMatch = entries.find(([, info]) => info?.role === role);
    return anyMatch ? anyMatch[0] : null;
}
```

#### Change 2: Rewire all 8 `findTerminalFn` callbacks in `renderAgentList`

Replace each `findTerminalFn` at lines 3050, 3060, 3068, 3076, 3084, 3091, 3118, 3126 from:

```js
terminals => Object.keys(terminals).find(key => terminals[key].role === 'planner')
```

to:

```js
terminals => findTerminalByRole(terminals, 'planner')
```

Roles at each line (verified):
- Line 3050: `'planner'`
- Line 3060: `'lead'`
- Line 3068: `'coder'`
- Line 3076: `'intern'`
- Line 3084: `'reviewer'`
- Line 3091: `'tester'`
- Line 3118: `customAgent.role` (dynamic)
- Line 3126: `'jules'` (no-op — Jules has no terminal, but keep for consistency)

#### Change 3: Update `isAgentGreen` inline find (line 2947)

```js
// Before (line 2947):
const matchedTermName = Object.keys(lastTerminals).find(key => lastTerminals[key]?.role === roleId);

// After:
const matchedTermName = findTerminalByRole(lastTerminals, roleId);
```

#### Change 4: Update `createAnalystRow` inline find (line 3341)

```js
// Before (line 3341):
const termName = Object.keys(lastTerminals).find(key => lastTerminals[key].role === 'analyst');

// After:
const termName = findTerminalByRole(lastTerminals, 'analyst');
```

#### Change 5: Prefer worktree-routed terminal from dispatch readiness

In `createAgentRow` (line 2709), change the priority so that worktree-routed terminals from `dispatchReadiness` take precedence over `findTerminalFn` results when the dispatch info indicates a worktree terminal:

```js
// Before:
const resolvedTermName = termName || routedTermName;

// After:
const isWorktreeRoute = dispatchInfo && dispatchInfo.isWorktreeTerminal;
const resolvedTermName = (isWorktreeRoute && routedTermName) ? routedTermName : (termName || routedTermName);
```

This ensures that when `dispatchReadiness` has identified a worktree terminal (via `isWorktreeTerminal: true`), that terminal is used for display — not the main workspace terminal found by `findTerminalFn`. When `isWorktreeTerminal` is not set (no plan selected, or plan not worktree-routed), the `findTerminalByRole` result (which itself prefers worktree terminals) is used.

#### Change 6: Extend the `(worktree)` suffix check

The existing `(worktree)` suffix display (line 2764) checks `dispatchInfo.isWorktreeTerminal`. With the fix above, `resolvedTermName` may now point to a worktree terminal even when `dispatchInfo` doesn't have `isWorktreeTerminal` set (the `findTerminalByRole` path). Add a fallback check:

```js
// Before (line 2764):
if (dispatchInfo && dispatchInfo.isWorktreeTerminal) {
    suffix = ' <span style="font-size:9px; opacity:0.6;">(worktree)</span>';
}

// After:
const isWtTerm = (dispatchInfo && dispatchInfo.isWorktreeTerminal) ||
    (resolvedTermName && lastTerminals[resolvedTermName]?.worktreePath);
if (isWtTerm) {
    suffix = ' <span style="font-size:9px; opacity:0.6;">(worktree)</span>';
}
```

## Verification Plan

> **Session directives:** SKIP compilation (no `npm run compile` / `tsc`) and SKIP automated tests in this session — the project is pre-compiled and tests run separately. The steps below are for the implementer/user to run after the session.

### Automated Tests
- (Run separately by user) Any existing agents-tab / `createAgentRow` render tests. The display-layer preference change should not affect dispatch-routing tests (routing is untouched).

### Manual Verification
1. **Setup**: Create a project with an active worktree (via the Kanban worktree tab). Open agent terminals for both the main workspace and the worktree.
2. **Test — worktree active, plan selected**: Select a plan that belongs to the project with the active worktree. Verify the agents tab shows worktree terminal names (with `(worktree)` suffix) and the correct status dots.
3. **Test — worktree active, no plan selected**: With no plan selected, verify the agents tab still prefers worktree terminals (via `findTerminalByRole`) when both main and worktree terminals exist.
4. **Test — no worktree active**: With no worktree, verify the agents tab behaves exactly as before — shows main workspace terminals.
5. **Test — `suppressMainTerminals` on**: With main terminals suppressed, verify only worktree terminals appear (existing behavior, should be unchanged).
6. **Test — dispatch**: Click dispatch on an agent row. Verify the dispatch goes to the worktree terminal (already handled by `dispatchReadiness`, but confirm the display match).
7. **Test — chat-only agents**: Verify chat-only agents are unaffected (no worktree preference applied; locate button still disabled for non-local chat agents).
8. **Test — Analyst row**: With a worktree active and an analyst terminal in both main and worktree, verify the Analyst row shows the worktree analyst terminal (confirms Change 4).
9. **Test — green-dot status**: With a worktree active, verify the green/red dot on agent rows reflects the worktree terminal's heartbeat (confirms Change 3 updates `isAgentGreen`).
10. **Epic cross-check**: Apply the planner-suffix fix (sibling subtask) alongside this plan. With a worktree planner terminal active, verify the Planner row shows `PLANNER - Planner` (stripped, unsuffixed) with the `(worktree)` suffix and the correct worktree terminal is targeted on dispatch. Confirms the two display-layer changes compose correctly.

## Review Findings

Implementation verified against plan: `findTerminalByRole` helper at `implementation.html:2701-2712` (with defensive null guard), all 10 terminal-resolution sites rewired (8 `findTerminalFn` callbacks + `isAgentGreen:2963` + `createAnalystRow:3357`), `resolvedTermName` priority at `:2722-2723`, and `(worktree)` suffix fallback at `:2778-2782`. Grep confirms zero orphaned `Object.keys().find()` patterns remain. No code changes needed. No CRITICAL/MAJOR findings. Two NITs noted (pre-existing, not regressions): (1) `displayName` text label uses binary-derived name for non-worktree-route cases — same text for same binary, no visible inconsistency; (2) planner row `(worktree)` suffix fallback doesn't fire when no plan is selected because `explicitTermName` is a stripped name (not a valid suffixed key in `lastTerminals`). Remaining risk: low — both NITs are pre-existing display-layer limitations outside this plan's scope.

## Recommendation

Complexity 4 → **Send to Coder** (multi-site display-layer change across 10 terminal-resolution sites + priority logic; well-scoped but needs care to cover all sites consistently).
