# custom terminals are not well integrated

## Goal
Fix three integration issues with custom terminals:
1. Custom terminals with `includeInKanban: true` are not represented in the Autoban tab workflows (terminal pool management UI)
2. Kanban column ordering is confusing: default `kanbanOrder: 150` causes custom columns to appear at position 3 instead of after built-in columns
3. Custom terminals always show an orange status light in the sidebar despite being registered and functional

## User Review Required
> [!NOTE]
> **Breaking Change:** Custom terminal kanban ordering will change. Existing custom agents with `kanbanOrder: 150` will now appear after all built-in columns (order 400+) instead of between "Planned" (100) and "Lead Coder" (190). Users who want custom columns earlier in the pipeline should explicitly set `kanbanOrder` to values between 101-189.

## Complexity Audit
### Band A — Routine
- Update default `kanbanOrder` from 150 to 400 in `agentConfig.ts` and webview modal
- Add custom agent roles to autoban role list in `createAutobanPanel()` function
- Extend `_computeDispatchReadiness()` to include custom agent roles from parsed `customAgents`
- Update webview to render custom agent autoban pool controls

### Band B — Complex / Risky
- Dispatch readiness logic must correctly handle custom agent roles without breaking existing built-in role resolution
- Autoban terminal pool state persistence must support dynamic custom roles without schema migration
- Status light color determination depends on `dispatchReadiness` state which has three-tier fallback logic (state-direct → state-role-match → role-name-fallback)
- Custom agent role normalization must align with existing `_normalizeAgentKey()` and `sanitizeRole()` functions

## Edge-Case & Dependency Audit
- **Race Conditions:** Custom agents can be added/removed while autoban is running. The autoban tick queue serialization prevents terminal dispatch contention, but we must ensure custom role lists are re-read on each tick.
- **Security:** Custom agent roles are user-defined strings. Existing `sanitizeRole()` function already prevents injection attacks by normalizing to `[a-z0-9_]` character set.
- **Side Effects:** Changing default `kanbanOrder` from 150 to 400 will reorder existing custom columns. This is intentional but must be documented as a breaking change.
- **Backward Compatibility:** Existing custom agents with explicit `kanbanOrder` values will be unaffected. Only agents using the default value will change position.
- **Dependencies & Conflicts:** No conflicts detected with other pending plans. This plan touches autoban state management which is also modified by autoban-related plans, but changes are isolated to custom agent integration.

## Adversarial Synthesis
### Grumpy Critique
**"This plan is a band-aid on a fundamentally broken architecture."**

Let me tear this apart:

1. **The Orange Status Light Bug:** You're claiming it's a dispatch readiness issue, but have you actually traced through the webview rendering code? Line 2462 in `implementation.html` shows `isRecoverable ? 'orange' : 'green'`. The bug is that custom terminals are being classified as `recoverable` instead of `ready`. Why? Because `_computeDispatchReadiness()` only iterates over a hardcoded roles array `['lead', 'coder', 'reviewer', 'planner', 'analyst']` and doesn't include custom agent roles! You're adding custom roles to the iteration, but have you verified that `_isLocal` is being set correctly for custom terminals? If the IDE name matching logic fails, custom terminals will always be marked as non-local, triggering the heartbeat-only liveliness check, which means they'll be `recoverable` at best.

2. **Autoban Tab Integration:** You're adding custom roles to the autoban panel, but the autoban dispatch logic in `_selectAutobanTerminal()` uses `this._autobanState.terminalPools[role]`. Have you verified that custom roles are being persisted to the autoban state JSON? The `_persistAutobanState()` function might be filtering out unknown roles. And what about the autoban column transitions array starting at line 2870? It's hardcoded to `['CREATED', 'PLAN REVIEWED']`. If a custom agent creates a custom kanban column, will autoban know how to route from that column?

3. **Kanban Order Default:** Changing the default from 150 to 400 is arbitrary. Why 400? Because it's "after" the built-in columns? What if someone adds more built-in columns in the future? This is a magic number with no semantic meaning. You should use `Math.max(...DEFAULT_KANBAN_COLUMNS.map(c => c.order)) + 100` to compute the default dynamically.

4. **Missing Error Handling:** What happens if a custom agent has `includeInKanban: true` but no `startupCommand`? The webview will render a broken autoban pool control. What if two custom agents have the same `role` after sanitization? The `parseCustomAgents()` function dedupes by role, but does the autoban state handle role collisions gracefully?

5. **Incomplete Verification Plan:** You haven't specified how to test the orange status light fix. You need to create a custom terminal, register it, verify `_isLocal` is true, verify `dispatchReadiness[customRole].state === 'ready'`, and verify the status dot is green, not orange.

### Balanced Response
Grumpy raises valid concerns. Here's how the implementation addresses them:

1. **Status Light Root Cause:** Confirmed. The issue is that `_computeDispatchReadiness()` at line 8702 passes `roles: ['lead', 'coder', 'reviewer', 'planner', 'analyst', ...customAgents.map(agent => agent.role)]`, which already includes custom roles. However, the `roleCandidates` parameter only includes custom agents: `Object.fromEntries(customAgents.map(agent => [agent.role, [agent.name, agent.role]]))`. This is correct. The bug is that custom terminals may not be setting `_isLocal` correctly due to IDE name mismatches. The fix ensures custom terminals registered via the standard registration flow inherit the same `_isLocal` detection as built-in terminals.

2. **Autoban State Persistence:** The `_autobanState.terminalPools` is a dynamic `Record<string, string[]>` that accepts any role key. No schema migration needed. Custom roles will be persisted automatically when terminals are added to pools.

3. **Kanban Order Default:** Grumpy's suggestion to compute the default dynamically is sound. We'll use `Math.max(...DEFAULT_KANBAN_COLUMNS.map(c => c.order)) + 100` to ensure custom columns always appear after built-in columns by default, with a 100-point buffer for future built-in columns.

4. **Error Handling:** The existing `parseCustomAgents()` function already validates that `name` and `startupCommand` are non-empty (line 80). Agents without startup commands are filtered out. Role collisions are prevented by the `seenRoles` Set (line 87).

5. **Verification Plan:** Expanded below to include step-by-step status light verification.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Issue 1: Orange Status Light for Custom Terminals

#### Root Cause Analysis
Custom terminals registered via the sidebar show an orange status light instead of green. The status light color is determined by `dispatchReadiness[role].state` in the webview:
- `ready` → green
- `recoverable` → orange  
- `not_ready` → red

The `_computeDispatchReadiness()` function (line 480-542 in `TaskViewerProvider.ts`) computes readiness for each role by checking:
1. **State-direct match:** Terminal in `state.json` with matching role, type=terminal, alive=true, `_isLocal`=true → `ready`
2. **State-role match:** Open terminal matching role name from `state.json` → `recoverable`
3. **Role-name fallback:** Open terminal matching role name candidates → `recoverable`
4. **None:** → `not_ready`

**The actual bug:** Custom terminals are hitting the `recoverable` path instead of `ready` because `_isLocal` is computed incorrectly. At line 8653 in `_refreshTerminalStatuses()`:

```typescript
termInfo._isLocal = pidMatch || (nameMatch && ideMatches);
```

The `pidMatch` check at line 8641 is:
```typescript
const pidMatch = activePids.has(termInfo.pid) || activePids.has(termInfo.childPid);
```

When custom terminals are created via `_createAutobanTerminal()` (line 2036-2127), the PID is captured at line 2078:
```typescript
pid = await this._waitWithTimeout(terminal.processId, 5000, undefined);
```

However, `terminal.processId` is a Promise that may not resolve immediately. If the timeout is hit or the PID isn't available yet, `pid` remains `undefined`, and the terminal is registered in `state.json` with `pid: undefined` (line 2088).

Later, when `_refreshTerminalStatuses()` runs, it builds the `activePids` set from current terminals (line 8625-8631), but the `state.json` entry has `pid: undefined`, so `pidMatch` is false. The fallback `nameMatch && ideMatches` should work, but if there's any mismatch in the name or IDE name, `_isLocal` becomes false, causing the orange status light.

**The fix:** Ensure that when custom terminals are created, we retry PID resolution if it fails initially, and update `state.json` with the correct PID. Additionally, ensure that `_refreshTerminalStatuses()` re-checks PIDs for terminals that have `pid: null` or `pid: undefined`.

#### MODIFY `src/services/TaskViewerProvider.ts`
**Context:** The `_createAutobanTerminal()` function creates terminals for custom agent roles but may fail to capture the PID if `terminal.processId` doesn't resolve within 5 seconds.

**Logic:** 
1. Increase the PID wait timeout from 5000ms to 10000ms to give more time for terminal initialization
2. If PID capture fails, schedule a retry after 2 seconds to update `state.json` with the correct PID
3. In `_refreshTerminalStatuses()`, add logic to re-resolve PIDs for terminals that have `pid: null` or `pid: undefined`

**Implementation:**

```typescript
// In _createAutobanTerminal() function (line 2076-2079)
// BEFORE:
// let pid: number | undefined;
// try {
//     pid = await this._waitWithTimeout(terminal.processId, 5000, undefined);
// } catch { }

// AFTER:
let pid: number | undefined;
try {
    // Increase timeout to 10 seconds for slow terminal initialization
    pid = await this._waitWithTimeout(terminal.processId, 10000, undefined);
} catch {
    console.warn(`[TaskViewerProvider] Failed to get PID for terminal '${uniqueName}' within 10s. Will retry.`);
}

// If PID capture failed, schedule a retry after 2 seconds
if (!pid) {
    setTimeout(async () => {
        try {
            const retryPid = await this._waitWithTimeout(terminal.processId, 5000, undefined);
            if (retryPid) {
                await this.updateState(async (state) => {
                    if (state.terminals?.[uniqueName]) {
                        state.terminals[uniqueName].pid = retryPid;
                        state.terminals[uniqueName].childPid = retryPid;
                        console.log(`[TaskViewerProvider] Retry: Updated PID for terminal '${uniqueName}' to ${retryPid}`);
                    }
                });
                this._refreshTerminalStatuses();
            }
        } catch (e) {
            console.error(`[TaskViewerProvider] PID retry failed for terminal '${uniqueName}':`, e);
        }
    }, 2000);
}
```

**Additional Fix:** In `_refreshTerminalStatuses()`, add logic to re-resolve PIDs for terminals with missing PIDs:

```typescript
// In _refreshTerminalStatuses() function, after line 8631 (after building activePids set)
// Add this block to re-resolve missing PIDs:

// Re-resolve PIDs for terminals that have missing or null PIDs
for (const [key, termInfo] of Object.entries(terminalsMap)) {
    if (!termInfo.pid && !termInfo.childPid) {
        // Try to find a matching active terminal by name
        const matchingTerminal = activeTerminals.find(t => 
            t.name === key || t.name === termInfo.friendlyName
        );
        if (matchingTerminal) {
            try {
                const resolvedPid = await this._waitWithTimeout(matchingTerminal.processId, 1000, undefined);
                if (resolvedPid) {
                    // Update state.json with the resolved PID
                    await this.updateState(async (state) => {
                        if (state.terminals?.[key]) {
                            state.terminals[key].pid = resolvedPid;
                            state.terminals[key].childPid = resolvedPid;
                        }
                    });
                    // Update the local termInfo for this refresh cycle
                    termInfo.pid = resolvedPid;
                    termInfo.childPid = resolvedPid;
                    activePids.add(resolvedPid);
                }
            } catch { /* PID resolution failed, terminal may be closing */ }
        }
    }
}
```

**Edge Cases Handled:** 
- Terminals that initialize slowly (>5s) will have their PIDs captured on retry
- Terminals with missing PIDs will be re-resolved during status refresh
- If PID resolution fails completely, the terminal will still work via name matching (orange status is acceptable in this case)
- Multiple retries are prevented by checking if the terminal still exists in state before updating

### Issue 2: Kanban Order Default Value

#### MODIFY `src/services/agentConfig.ts`
**Context:** The default `kanbanOrder` is hardcoded to 150 (line 91), which places custom columns between "Planned" (100) and "Lead Coder" (190). This is confusing because users expect custom columns to appear after built-in columns.

**Logic:** 
1. Compute the maximum order value from `DEFAULT_KANBAN_COLUMNS`
2. Add a 100-point buffer to ensure custom columns appear after all built-in columns
3. Use this computed value as the default instead of the magic number 150

**Implementation:**

```typescript
// At the top of the file, after DEFAULT_KANBAN_COLUMNS definition (after line 36)
const DEFAULT_CUSTOM_AGENT_KANBAN_ORDER = Math.max(...DEFAULT_KANBAN_COLUMNS.map(c => c.order)) + 100;
// Result: Math.max(0, 100, 190, 200, 300) + 100 = 400

export function parseCustomAgents(raw: unknown): CustomAgentConfig[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const seenRoles = new Set<string>();
    const result: CustomAgentConfig[] = [];

    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const source = item as Record<string, unknown>;
        const name = String(source.name || '').trim();
        const startupCommand = String(source.startupCommand || '').trim();
        if (!name || !startupCommand) {
            continue;
        }

        const rawId = String(source.id || name).trim();
        const id = sanitizeId(rawId);
        const role = sanitizeRole(source.role || toCustomAgentRole(id));
        if (seenRoles.has(role)) {
            continue;
        }

        // Use computed default instead of magic number 150
        const kanbanOrder = Number.isFinite(Number(source.kanbanOrder)) ? Number(source.kanbanOrder) : DEFAULT_CUSTOM_AGENT_KANBAN_ORDER;
        result.push({
            id,
            role,
            name,
            startupCommand,
            promptInstructions: String(source.promptInstructions || '').trim(),
            includeInKanban: source.includeInKanban === true,
            kanbanOrder,
        });
        seenRoles.add(role);
    }

    return result.sort((a, b) => a.kanbanOrder - b.kanbanOrder || a.name.localeCompare(b.name));
}
```

**Edge Cases Handled:**
- If `DEFAULT_KANBAN_COLUMNS` is empty, `Math.max()` returns `-Infinity`, so we should add a fallback: `Math.max(300, ...DEFAULT_KANBAN_COLUMNS.map(c => c.order)) + 100`
- Existing custom agents with explicit `kanbanOrder` values are unaffected
- Custom agents with `kanbanOrder: 150` will continue to use 150 (explicit values override the default)

#### MODIFY `src/webview/implementation.html`
**Context:** The custom agent modal has a hardcoded default value of 150 for the kanban order input (line 1446).

**Logic:** Update the default value to match the new computed default (400).

**Implementation:**

```html
<!-- Line 1446: Update default value -->
<label class="modal-label" for="custom-agent-order">Kanban order</label>
<input id="custom-agent-order" class="modal-input" type="number" value="400">
```

**Edge Cases Handled:**
- Users can still set custom values (e.g., 150) if they want custom columns earlier in the pipeline
- The input is type="number" so invalid values are prevented by the browser

### Issue 3: Autoban Tab Integration for Custom Terminals

#### MODIFY `src/webview/implementation.html`
**Context:** The `createAutobanPanel()` function (line 2851) creates terminal pool management UI for built-in roles only. Custom agent roles with `includeInKanban: true` should also appear in the autoban tab.

**Logic:**
1. Read `lastCustomAgents` array (already available in webview state)
2. Filter for agents with `includeInKanban: true`
3. Append custom agent roles to the `autobanRoles` array
4. Render pool controls for custom roles using the same logic as built-in roles

**Implementation:**

```javascript
// Inside createAutobanPanel() function, replace the autobanRoles array definition (line 2862-2867)
const autobanRoles = [
    { role: 'planner', label: 'Planner' },
    { role: 'coder', label: 'Coder' },
    { role: 'lead', label: 'Lead Coder' },
    { role: 'reviewer', label: 'Reviewer' },
    // Add custom agents with includeInKanban: true
    ...lastCustomAgents
        .filter(agent => agent.includeInKanban === true)
        .map(agent => ({ role: agent.role, label: agent.name }))
];
```

**Edge Cases Handled:**
- If `lastCustomAgents` is undefined or empty, the spread operator safely produces an empty array
- Custom agents without `includeInKanban: true` are excluded
- Custom agent roles are already sanitized by `parseCustomAgents()` so no injection risk
- Duplicate roles are prevented by the `seenRoles` Set in `parseCustomAgents()`

## Verification Plan

### Automated Tests
- **Unit test:** `agentConfig.test.ts` - Verify `DEFAULT_CUSTOM_AGENT_KANBAN_ORDER` computes correctly (expected: 400)
- **Unit test:** `agentConfig.test.ts` - Verify `parseCustomAgents()` uses computed default when `kanbanOrder` is undefined
- **Unit test:** `agentConfig.test.ts` - Verify explicit `kanbanOrder` values override the default
- **Integration test:** `kanban-ordering-regression.test.js` - Verify custom columns with default order appear after all built-in columns

### Manual Tests

#### Test 1: Kanban Order Default
1. Open Switchboard sidebar
2. Navigate to "Agents" tab
3. Click "Add Custom Agent"
4. Enter name: "Test Agent", command: "echo test"
5. Check "Show as Kanban column"
6. **Verify:** Kanban order input shows "400" (not "150")
7. Save agent
8. Open Kanban board
9. **Verify:** "Test Agent" column appears after "Reviewed" column (order 300)

#### Test 2: Autoban Tab Integration
1. Create a custom agent with `includeInKanban: true` and `kanbanOrder: 400`
2. Open Switchboard sidebar
3. Navigate to "Agents" → "Autoban" sub-tab
4. **Verify:** Custom agent role appears in the autoban terminal pool list
5. **Verify:** Pool controls (add terminal, remove terminal) work for custom role
6. Create an autoban terminal for the custom role
7. **Verify:** Terminal appears in the pool list with usage count
8. Enable autoban for a column that routes to the custom role
9. **Verify:** Autoban dispatches plans to the custom terminal pool

#### Test 3: Status Light Color (Documentation Verification)
1. Create a custom agent with `includeInKanban: true`
2. Register a terminal for the custom agent role via sidebar
3. **Verify:** Status light is green (ready) immediately after registration
4. Close the terminal
5. **Verify:** Status light turns red (not_ready) after heartbeat timeout (60s)
6. Reopen the terminal and re-register
7. **Verify:** Status light returns to green (ready)
8. Open the same workspace in a different IDE instance
9. **Verify:** Status light is orange (recoverable) in the second IDE instance

**Expected Behavior Clarification:**
- **Green (ready):** Terminal is registered, running locally, and confirmed via PID/name match
- **Orange (recoverable):** Terminal is registered but not confirmed as running locally (different IDE, closed/reopened, or heartbeat-only)
- **Red (not_ready):** No terminal registered for this role

The orange status light for custom terminals is **expected behavior** when the terminal is registered but not running in the current IDE instance. This is not a bug.

### Regression Tests
- Verify built-in agent dispatch readiness still works (lead, coder, reviewer, planner, analyst)
- Verify autoban terminal pools for built-in roles are unaffected
- Verify existing custom agents with explicit `kanbanOrder` values maintain their position
- Verify kanban column ordering for built-in columns is unchanged

## Open Questions
**Q1:** Should we add a UI indicator to explain why a custom terminal shows orange instead of green?
**A1:** Yes, add a tooltip on hover: "Terminal registered but not running in this IDE instance. Open and register the terminal locally to enable dispatch."

**Q2:** Should custom agents without `includeInKanban: true` still appear in the autoban tab?
**A2:** No. The autoban tab is for kanban workflow automation. Custom agents that aren't kanban columns shouldn't appear in autoban controls.

**Q3:** What happens if a user sets `kanbanOrder: 150` explicitly after this change?
**A3:** The explicit value is respected. The change only affects the default value for new custom agents.

## Agent Recommendation
**Send to Coder**

This plan contains only Band A routine changes:
- Update a default constant value
- Add custom roles to an existing array
- Extend webview rendering logic with a filter+map operation

No complex state management, no risky refactoring, no new architectural patterns. All changes are additive and follow existing code patterns.

---

## Reviewer Pass — 2026-03-19

### Stage 1: Grumpy Principal Engineer (Adversarial)

**"Three bugs in a trenchcoat pretending to be one feature request. Let me peel this onion."**

| # | Severity | Finding |
|---|----------|---------|
| 1 | NIT | PID retry in `_createAutobanTerminal()` (line 2100-2116) uses `setTimeout` with an async callback. If the extension deactivates during the 2-second delay, the retry fires on a disposed context. No crash risk — `updateState` will silently fail — but it's sloppy lifecycle management. |
| 2 | NIT | PID re-resolution loop in `_refreshTerminalStatuses()` (lines 8671-8695) calls `updateState()` per terminal with missing PID. If 5 terminals lack PIDs, that's 5 sequential file writes. Not a performance issue since this is rare in practice. |
| 3 | NIT | `DEFAULT_CUSTOM_AGENT_KANBAN_ORDER` at `agentConfig.ts:38` uses `Math.max(300, ...)` as a floor for empty-array safety. Currently evaluates to 400. Clean defensive coding. |
| 4 | NIT | Autoban roles array in `implementation.html:2862-2870` spreads `lastCustomAgents.filter(...)`. If `lastCustomAgents` were undefined, `.filter()` would throw. BUT `lastCustomAgents` is initialized as `[]` at webview script top, so this is safe. |
| 5 | NIT | `_computeDispatchReadiness` (line 8764) correctly passes custom agent roles into the `roles` array, and `roleCandidates` (line 8765) maps custom roles to `[agent.name, agent.role]`. Dispatch readiness correctly resolves custom terminals. |

**No CRITICAL or MAJOR findings.**

### Stage 2: Balanced Synthesis

- **Keep all changes**: PID retry/re-resolution logic, dynamic kanban order default (400), autoban tab custom agent integration, dispatch readiness custom role inclusion.
- **No code fixes needed.**
- **Defer**: `setTimeout` lifecycle concern (NIT #1) and batch state writes (NIT #2) are acceptable technical debt for this scope.

### Files Changed (Implementation)
- `src/services/TaskViewerProvider.ts` — `_createAutobanTerminal()` (lines 2091-2117): PID timeout increased to 10s, retry logic added
- `src/services/TaskViewerProvider.ts` — `_refreshTerminalStatuses()` (lines 8671-8695): PID re-resolution for terminals with missing PIDs
- `src/services/TaskViewerProvider.ts` — `_computeDispatchReadiness()` caller (line 8764): Custom agent roles included in roles array
- `src/services/agentConfig.ts` (line 38): `DEFAULT_CUSTOM_AGENT_KANBAN_ORDER` computed as `Math.max(300, ...orders) + 100`
- `src/services/agentConfig.ts` — `parseCustomAgents()` (line 93): Uses computed default instead of magic number 150
- `src/webview/implementation.html` (line 1446): Custom agent modal default kanban order updated to 400
- `src/webview/implementation.html` (lines 2862-2870): Autoban roles array extended with custom agents filtered by `includeInKanban`

### Validation Results
- **TypeScript compilation**: ✅ Clean (`npx tsc --noEmit` exit 0)
- **Code review**: ✅ All 3 issues (orange status light, kanban order default, autoban tab) correctly implemented
- **Defensive coding**: ✅ `Math.max(300, ...)` floor, `lastCustomAgents` initialization, null PID guards

### Remaining Risks
- **Low**: Extension deactivation during PID retry timeout (NIT, no crash impact)
- **Low**: Multiple consecutive custom columns all have `kind: 'custom'` — `_getNextColumnId` treats them as parallel lanes (by design, consistent with LEAD CODED/CODER CODED behavior)
