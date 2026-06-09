# Fix: Agent Names Missing in Kanban Columns

## Goal
Fix custom agent names not displaying in kanban.html columns by correcting the webview-side message ordering issue that prevents `updateAllColumnAgents()` from resolving custom agent roles.

## Metadata
- **Tags:** [bugfix, frontend]
- **Complexity:** 3

## User Review Required
Verify that the proposed webview-side fix matches the observed symptom (agent names blank for custom agent columns on board load/refresh).

## Complexity Audit

### Routine
- Adding a deferred `updateAllColumnAgents()` call after `updateColumns` message handler
- Verifying message ordering in the three board-refresh code paths in `KanbanProvider.ts`
- Checking that `columnToRole()` correctly resolves custom agent column IDs to roles

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** The backend `_getAgentNames()` already correctly includes custom agent roles (lines 3197-3198). The bug is that the webview may process `updateAgentNames` before `updateColumns` has populated `columnDefinitions` with custom agent entries, causing `columnToRole()` to return `null` for those columns.
- **Security:** No security implications.
- **Side Effects:** Adding an extra `updateAllColumnAgents()` call is idempotent — it just re-renders agent name text in column headers.
- **Dependencies & Conflicts:** No conflicts with other in-flight work.

## Dependencies
- None

## Adversarial Synthesis
Key risks: The original plan misdiagnosed the root cause — the backend `_getAgentNames()` already includes custom agent roles correctly. The real bug is a webview message ordering issue. Mitigations: Fix targets the webview side only; the change is small and idempotent.

## Problem
Agent names are not displaying in kanban.html columns for custom agents. For example, when the current agent is "Devin CLI" in the Planned column, the kanban should show "Devin CLI" as the agent name, but it is missing.

## Root Cause (Corrected)

**Original diagnosis was incorrect.** The plan originally claimed `_getAgentNames()` only considers built-in roles because it calls `buildKanbanColumns([])`. However, reading the actual code:

- `src/services/KanbanProvider.ts` line 3197: `const customAgents = parseCustomAgents(state.customAgents);`
- Line 3198: `const roles = [...new Set([...fallbackRoles, ...customAgents.map(agent => agent.role)])];`
- Lines 3199-3200: Custom agent startup commands are merged into `commands`

The backend `_getAgentNames()` **already includes custom agent roles and their names**. The `configuredNames` record correctly maps `custom_agent_devin` → `"DEVIN CLI"`.

**The actual bug is on the webview side** — a message ordering/timing issue:

1. The webview receives `updateAgentNames` (sets `lastAgentNames`) and `updateColumns` (sets `columnDefinitions`) as separate messages from the backend.
2. `updateAllColumnAgents()` uses `columnToRole(col)` which looks up `columnDefinitions` to find the role for a column ID.
3. For custom agent columns, `buildKanbanColumns()` sets `id: agent.role` and `role: agent.role` — so the column ID equals the role string (e.g., `custom_agent_devin`).
4. If `updateAgentNames` is processed **before** `updateColumns` has populated `columnDefinitions` with the custom agent entries, then `columnToRole(col)` returns `null` for those columns (they're not in `columnDefinitions` yet).
5. `lastAgentNames[null]` is `undefined`, so line 4009 does `el.textContent = name || ''` → empty string.

The `updateColumns` handler (line 5015-5021) does call `updateAllColumnAgents()` after setting `columnDefinitions`, but only if the columns signature changed. If `updateAgentNames` arrives first and `updateAllColumnAgents()` runs with stale/missing `columnDefinitions`, custom agent names are blank and never re-rendered.

## Solution

### Implementation Steps

1. **Ensure `updateAllColumnAgents()` runs after both `columnDefinitions` and `lastAgentNames` are populated**
   - In the `updateColumns` message handler (kanban.html ~line 5015-5021), `updateAllColumnAgents()` is already called after setting `columnDefinitions`. This is correct.
   - In the `updateAgentNames` message handler (kanban.html ~line 5059-5062), `updateAllColumnAgents()` is called after setting `lastAgentNames`. This is also correct in isolation.
   - **The fix:** Add a deferred `updateAllColumnAgents()` call in the `updateColumns` handler to ensure agent names are re-resolved after column definitions are fully updated. This handles the case where `updateAgentNames` arrived first but columns weren't ready yet.

2. **Verify the three board-refresh code paths in `KanbanProvider.ts` send messages in a reliable order**
   - Path 1 (initial load, ~line 998-1041): `updateColumns` → `updateBoard` → `updateAgentNames` → `visibleAgents`. This order is fine — `updateColumns` arrives before `updateAgentNames`.
   - Path 2 (full refresh, ~line 1730-1765): Same order. Fine.
   - Path 3 (incremental refresh, ~line 1854-1885): Same order. Fine.
   - All three paths send `updateColumns` before `updateAgentNames`, so the webview should have `columnDefinitions` populated before `lastAgentNames`. The issue may be that `updateColumns` is only sent when the columns signature changes (`this._lastColumnsSignature !== nextColumnsSignature`), meaning on subsequent refreshes with unchanged columns, `updateAllColumnAgents()` is never called from the `updateColumns` path, only from `updateAgentNames`.

3. **Add a safety re-render in `updateAgentNames` handler**
   - After setting `lastAgentNames`, check if `columnDefinitions` is already populated. If so, `updateAllColumnAgents()` already works. If not (unlikely given the message ordering), defer.
   - Simpler approach: Just ensure `updateAllColumnAgents()` is always called in the `updateAgentNames` handler (it already is at line 5061). The real issue is likely that on first load, `columnDefinitions` hasn't been updated yet when `updateAgentNames` fires.

4. **Clarification: The most likely fix location**
   - The `updateColumns` handler at line 5015 already calls `updateAllColumnAgents()`. But it only fires when the columns signature changes.
   - Add a call to `updateAllColumnAgents()` after the `updateAgentNames` handler sets `lastAgentNames` AND after `columnDefinitions` has been populated at least once. A simple guard: if `columnDefinitions.length > 0`, run `updateAllColumnAgents()` (already done). The issue is the first-load race.
   - **Recommended minimal fix:** In the `updateAgentNames` case (line 5059-5062), add a `setTimeout(() => updateAllColumnAgents(), 0)` to defer the update to the next microtask, ensuring `columnDefinitions` from any pending `updateColumns` message has been processed first.

### Files to Modify
- `src/webview/kanban.html` — `updateAgentNames` message handler (~line 5059-5062): defer `updateAllColumnAgents()` to next microtask

### Proposed Change

#### `src/webview/kanban.html` (~line 5059-5062)

**Context:** The `updateAgentNames` message handler currently calls `updateAllColumnAgents()` synchronously after setting `lastAgentNames`. If `updateColumns` hasn't been processed yet (or its `columnDefinitions` update was skipped due to unchanged signature), custom agent columns won't have their roles resolved.

**Logic:** Defer the `updateAllColumnAgents()` call to ensure `columnDefinitions` is current.

**Implementation:**
```javascript
// BEFORE:
case 'updateAgentNames':
    lastAgentNames = msg.agentNames || {};
    updateAllColumnAgents();
    break;

// AFTER:
case 'updateAgentNames':
    lastAgentNames = msg.agentNames || {};
    // Defer to next microtask so any pending updateColumns
    // message is processed first, ensuring columnDefinitions
    // includes custom agent columns before we resolve roles.
    setTimeout(() => updateAllColumnAgents(), 0);
    break;
```

**Edge Cases:**
- If `updateColumns` arrives after the deferred `updateAllColumnAgents()`, it already calls `updateAllColumnAgents()` itself (line 5021), so names will be correctly rendered on the second pass.
- If no `updateColumns` is pending, the deferred call behaves identically to the current synchronous call.
- The 0ms timeout is sufficient because VS Code webview message processing is synchronous within the current event loop tick; the next tick will have all pending messages processed.

## Verification Plan

### Automated Tests
- N/A (webview rendering issue; manual verification required)

### Manual Verification
1. Create a custom agent in the Agents tab with `includeInKanban: true`
2. Assign a startup command to it (e.g., "devin")
3. Refresh the kanban board
4. Verify that the custom agent column shows the agent name (e.g., "DEVIN CLI")
5. Test with multiple custom agents to ensure all display correctly
6. Reload the VS Code window and verify names appear on first load
7. Remove a custom agent and verify the column either disappears or shows "No agent assigned"

## Reviewer Pass Results

### Stage 1: Grumpy Principal Engineer Findings

| # | Severity | Finding |
|---|---|---|
| 1 | **CRITICAL** | The `setTimeout` fix addresses a phantom race condition. All three backend refresh paths send `updateColumns` before `updateAgentNames`. VS Code `postMessage` delivers in FIFO order; the webview `message` handler processes them synchronously. No reordering occurs. The `setTimeout` defends against a ghost. |
| 2 | **CRITICAL** | Two `renderColumns()` calls are missing subsequent `updateAllColumnAgents()`, causing agent names to vanish: `backlogViewState` handler (line 5097) and `worktreeCounts` handler (line 5423). `renderColumns()` replaces `kanbanBoard.innerHTML`, destroying all `agent-*` DOM elements and recreating them empty. Without `updateAllColumnAgents()`, names stay blank until the next backend message. |
| 3 | **MAJOR** | Comment says "Defer to next microtask" but `setTimeout(fn, 0)` defers to a **macrotask**, not a microtask. The distinction doesn't affect correctness here, but the comment is factually wrong. |
| 4 | **NIT** | `updateAllColumnAgents()` guard `if (!lastAgentNames) return;` is dead code — `lastAgentNames` is initialized to `{}` (truthy) and never set to null/undefined. The guard never fires. |

### Stage 2: Balanced Synthesis

| Finding | Verdict | Action |
|---|---|---|
| `setTimeout` targets phantom race | **Keep** — harmless safety net | Retain as defense-in-depth |
| `backlogViewState` missing `updateAllColumnAgents()` | **Fix now** | Added `updateAllColumnAgents()` after `renderBoard(currentCards)` |
| `worktreeCounts` missing `updateAllColumnAgents()` | **Fix now** | Added `updateAllColumnAgents()` after `renderBoard(currentCards)` |
| Comment "microtask" → "macrotask" | **Fix now** | Changed to "next tick" (avoids the terminology debate) |
| Dead guard `if (!lastAgentNames)` | **Defer** | Not causing a bug; low-priority cleanup |

### Stage 3: Code Fixes Applied

**File: `src/webview/kanban.html`**

1. **`backlogViewState` handler (~line 5095-5100):** Added `updateAllColumnAgents()` after `renderBoard(currentCards)`.
2. **`worktreeCounts` handler (~line 5422-5428):** Added `updateAllColumnAgents()` after `renderBoard(currentCards)`.
3. **`updateAgentNames` handler (~line 5147-5152):** Fixed comment from "microtask" to "tick".

### Stage 4: Verification

- **Typecheck:** Ran `npx tsc --noEmit`. Two pre-existing errors in `ClickUpSyncService.ts` and `KanbanProvider.ts` (import path extensions) — unrelated to this change. The modified file (`kanban.html`) is inline JavaScript and is not typechecked.
- **Full audit of `renderColumns()` callers:** All 6 call sites now have a corresponding `updateAllColumnAgents()` call (5 explicit, 1 initial-load before data arrives which is correct).

### Remaining Risks

1. The `setTimeout` fix in `updateAgentNames` is a safety net for a race condition that doesn't manifest in practice. If VS Code's IPC layer ever reorders messages, it would help. Low risk either way.
2. The `if (!lastAgentNames) return;` guard in `updateAllColumnAgents()` is dead code — it never actually prevents the "names not yet received" case because `lastAgentNames` is initialized to `{}`. This should be cleaned up separately.
3. No automated test coverage for webview rendering — manual verification is required per the original plan.

### Complete `renderColumns()` → `updateAllColumnAgents()` Audit (Post-Fix)

| Location | `renderColumns()` | `updateAllColumnAgents()` | Status |
|---|---|---|---|
| Mode toggle click (3855) | YES | YES (3857) | OK |
| `backlogViewState` (5097) | YES | YES (5099) | **FIXED** |
| `updateColumns` (5107) | YES | YES (5109) | OK |
| `updateAgentNames` (5152) | NO | YES (deferred) | OK (no DOM rebuild) |
| `visibleAgents` (5254) | NO | YES (sync) | OK (no DOM rebuild) |
| `worktreeCounts` (5424) | YES | YES (5426) | **FIXED** |
| Collapse coders toggle (5825) | YES | YES (5827) | OK |
| Initial load (5622) | YES | NO | OK (no data yet) |

## Recommendation
Complexity 3 → **Send to Intern**
