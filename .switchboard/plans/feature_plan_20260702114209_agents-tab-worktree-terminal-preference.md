# Agents Tab Terminal List Does Not Respect Worktree Terminals

**Plan ID:** a1b2c3d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d

## Goal

### Problem

When a worktree is active for a project, the agents tab in `implementation.html` shows the original workspace terminals instead of the worktree terminals. The user expects the agents tab to display the worktree terminals (which are scoped to the worktree path) when a worktree is active, not the main workspace terminals.

### Background Context

Switchboard supports git worktrees for isolated development. When a worktree is active, dedicated terminals are created inside the worktree path (via `ensureWorktreeTerminals` in `TaskViewerProvider.ts`). These worktree terminals have a `worktreePath` field set in their terminal state record.

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

## Metadata

- **Tags:** bugfix, worktree, terminals, ui
- **Complexity:** 4

## Complexity Audit

### Routine
- Modifying the `findTerminalFn` callbacks in `renderAgentList` (lines 3048-3129 of `implementation.html`) to prefer worktree terminals.
- Adjusting the `resolvedTermName` priority logic in `createAgentRow` (line 2709) to prefer worktree-routed terminals from `dispatchReadiness` over `findTerminalFn` results.

### Complex / Risky
- The `findTerminalFn` is called for every agent row on every re-render. Adding worktree preference logic must remain O(n) in terminal count (it already is — `Object.keys().find()` is O(n)).
- The `dispatchReadiness` worktree preference only activates when a plan is selected (it looks up the plan's worktree path from the DB). When no plan is selected, there's no worktree context, so `findTerminalFn` is the only signal. The fix must handle both cases: plan-selected (use dispatch readiness) and no-plan (prefer worktree terminals in findTerminalFn).
- Must not break the `(worktree)` suffix display (line 2764-2765) which already checks `dispatchInfo.isWorktreeTerminal` — this will now correctly fire more often.

## Edge-Case & Dependency Audit

1. **No worktree active**: When no worktree terminals exist, `findTerminalFn` should behave exactly as before — find the first role-matching terminal. The worktree preference is a tiebreaker, not a filter.

2. **`suppressMainTerminals` is on**: When main terminals are suppressed, only worktree terminals exist in `enrichedTerminals`. `findTerminalFn` will naturally find them. The fix is a no-op in this case — correct.

3. **`suppressMainTerminals` is off (both exist)**: This is the primary bug scenario. Both main and worktree terminals are registered. `findTerminalFn` currently finds the main one first. The fix should prefer the worktree one.

4. **Multiple worktrees**: If multiple worktrees are active (e.g. per-subtask mode), there may be multiple worktree terminals for the same role. `findTerminalFn` should prefer any worktree terminal over a main terminal. The specific worktree selection for dispatch is already handled by `dispatchReadiness` (which uses the plan's worktree path). The display just needs to show *a* worktree terminal, and `dispatchReadiness` will refine the exact one for dispatch.

5. **Chat-only agents**: Chat agents (`_isChat: true`, no `_isLocal`) don't have worktree variants. The fix must not affect chat agent display.

6. **Jules**: Jules is a cloud service, not a terminal. It's handled separately (line 2717-2721). The fix must not affect Jules display.

7. **Dispatch readiness without plan**: `_computeDispatchReadiness` is called from `_refreshTerminalStatuses` (line 18574) without a `plan` argument. It falls back to looking up the plan by `this._lastSessionId` (line 1853-1868). If no plan is selected, no worktree preference is applied in dispatch readiness. The `findTerminalFn` fix covers this gap.

## Proposed Changes

### File: `src/webview/implementation.html`

#### Change 1: Make `findTerminalFn` prefer worktree terminals

Modify each `findTerminalFn` callback in `renderAgentList` to prefer terminals with `worktreePath` set. Create a shared helper function and use it for all agent rows.

Add a helper function near the top of the rendering section (after line 2491):

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

Then replace each `findTerminalFn` in `renderAgentList` (lines 3050, 3060, 3068, 3076, 3084, 3091, 3118, 3126) from:

```js
terminals => Object.keys(terminals).find(key => terminals[key].role === 'planner')
```

to:

```js
terminals => findTerminalByRole(terminals, 'planner')
```

(repeat for each role: `'planner'`, `'lead'`, `'coder'`, `'intern'`, `'reviewer'`, `'tester'`, and custom agent roles)

#### Change 2: Prefer worktree-routed terminal from dispatch readiness

In `createAgentRow` (line 2709), change the priority so that worktree-routed terminals from `dispatchReadiness` take precedence over `findTerminalFn` results when the dispatch info indicates a worktree terminal:

```js
// Before:
const resolvedTermName = termName || routedTermName;

// After:
const isWorktreeRoute = dispatchInfo && dispatchInfo.isWorktreeTerminal;
const resolvedTermName = (isWorktreeRoute && routedTermName) ? routedTermName : (termName || routedTermName);
```

This ensures that when `dispatchReadiness` has identified a worktree terminal (via `isWorktreeTerminal: true`), that terminal is used for display — not the main workspace terminal found by `findTerminalFn`.

#### Change 3: Use `findTerminalByRole` for the worktree suffix check

The existing `(worktree)` suffix display (line 2764) checks `dispatchInfo.isWorktreeTerminal`. With the fix above, `resolvedTermName` may now point to a worktree terminal even when `dispatchInfo` doesn't have `isWorktreeTerminal` set (the `findTerminalFn` path). Add a fallback check:

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

1. **Setup**: Create a project with an active worktree (via the Kanban worktree tab). Open agent terminals for both the main workspace and the worktree.
2. **Test — worktree active, plan selected**: Select a plan that belongs to the project with the active worktree. Verify the agents tab shows worktree terminal names (with `(worktree)` suffix) and the correct status dots.
3. **Test — worktree active, no plan selected**: With no plan selected, verify the agents tab still prefers worktree terminals (via `findTerminalByRole`) when both main and worktree terminals exist.
4. **Test — no worktree active**: With no worktree, verify the agents tab behaves exactly as before — shows main workspace terminals.
5. **Test — `suppressMainTerminals` on**: With main terminals suppressed, verify only worktree terminals appear (existing behavior, should be unchanged).
6. **Test — dispatch**: Click dispatch on an agent row. Verify the dispatch goes to the worktree terminal (already handled by `dispatchReadiness`, but confirm the display match).
7. **Test — chat-only agents**: Verify chat-only agents are unaffected (no worktree preference applied).
