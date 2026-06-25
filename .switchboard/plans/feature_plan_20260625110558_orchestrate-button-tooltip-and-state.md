# Fix Orchestrate Button: Add Clear Tooltip and Reflect Orchestrator Agent Configuration State

## Goal

Make the Orchestrate button in the Epics tab communicate (1) what it does via a clear, descriptive tooltip, and (2) whether an orchestrator agent is actually configured via its visual state — dimmed/secondary when no orchestrator agent is set up, teal/active only when one is. Currently the button always renders with a teal accent border regardless of orchestrator configuration, misleading the user into thinking orchestration is ready when it is not.

### Problem analysis & root cause

The Orchestrate button is rendered in `renderEpicMetaBar` (`project.js:1354`):

```javascript
<button class="strip-btn" id="btn-epic-orchestrate" style="border-color: var(--accent-teal);" title="Assemble the orchestrator prompt for this epic and copy it">Orchestrate</button>
```

Two problems:

1. **Tooltip is unclear.** The `title` attribute says "Assemble the orchestrator prompt for this epic and copy it" — but the user doesn't know what "orchestrate" means in this context. It doesn't explain that it hands the whole epic to a single orchestrator agent that uses native subagents, nor that it copies the prompt if no orchestrator terminal exists. The user reports: "I am not sure what it does."

2. **Always looks active.** The button has `border-color: var(--accent-teal)` hardcoded — a teal accent that visually signals "primary/active action." But the orchestrator agent is **hidden by default** (`orchestrator: false` in `getVisibleAgents` defaults at `TaskViewerProvider.ts:3616`). The project.js webview **never receives agent visibility info** (confirmed: no `visibleAgents` or `startupCommands` handler in `project.js`), so it cannot know whether an orchestrator terminal is configured. The button looks ready even when no orchestrator agent is set up, which is the user's complaint: "it shows as active even though I have not set any orchestration agent."

**Root cause:** The epic-orchestration-onramp plan (Phase 2) added the Orchestrate button with a static teal style and a terse tooltip, without wiring it to backend agent-configuration state. The webview has no data about orchestrator availability.

## Metadata

- **Tags:** `feature`, `ui`, `backend`
- **Complexity:** 4/10 (three-file change: new async method on KanbanProvider, one field added to an existing message payload, conditional button styling + state variable in project.js — all following established patterns, no new architecture)

## User Review Required

No — this is a self-contained visual/tooltip fix with a safe fallback (button always copies the prompt regardless of state). No data migrations, no breaking changes, no confirmation dialogs.

## Complexity Audit

### Routine
- Expanding the `title` attribute on the Orchestrate button — pure HTML/JS string change.
- Conditionally applying the teal border vs. a dimmed style based on a boolean flag — simple CSS class toggle.
- Adding `orchestratorAvailable` to the existing `kanbanPlansReady` message payload (`PlanningPanelProvider.ts:2557-2564`) — one extra field.
- Adding a `_orchestratorAvailable` state variable in `project.js` — one line near other state variables (line 166 area).
- Re-rendering the meta-bar when `kanbanPlansReady` arrives and an epic is selected — one conditional function call.

### Complex / Risky
- **New public method on KanbanProvider** to check orchestrator availability — must access `this._taskViewerProvider?.getVisibleAgents()` (private field at `KanbanProvider.ts:150`) and `getStartupCommands()`. The method must be safe to call when `_taskViewerProvider` is undefined (returns false).
- **State sync timing** — `kanbanPlansReady` is sent on plan list refresh. If the user enables the orchestrator agent in the kanban Agents tab after the Epics tab loaded, the button state won't update until the next `kanbanPlansReady` message. This is acceptable (switching to the Epics tab triggers a plan refresh which fires `kanbanPlansReady`), but the placement of the `await isOrchestratorAvailable()` call matters: it must be computed BEFORE the request guard check at `PlanningPanelProvider.ts:2554` to avoid sending a stale message if a newer request arrives during the await.
- **Error-branch placement** — the webview `kanbanPlansReady` handler has an early return on `msg.error` (`project.js:294-297`). The `_orchestratorAvailable` assignment MUST be placed BEFORE the error check so the error branch (which sends `orchestratorAvailable: false`) correctly resets the state.

## Edge-Case & Dependency Audit

- **Race Conditions:** The `await isOrchestratorAvailable()` call in the `kanbanPlansReady` sender introduces a small async gap. To avoid stale-message issues, compute the value BEFORE the request guard check at line 2554, not after. The webview handler does not check requestId for `kanbanPlansReady`, so a stale message would overwrite newer state — placing the await before the guard ensures the guard still catches newer requests.
- **Security:** No security implications — the method reads agent configuration state only, no credentials or secrets involved.
- **Side Effects:** `isOrchestratorAvailable()` calls `getVisibleAgents()` and `getStartupCommands()`, both of which read from the machine-global config (`~/.switchboard`) or legacy state files. These are read-only operations with no side effects.
- **Dependencies & Conflicts:** No new dependencies. The method reuses existing `TaskViewerProvider` public APIs (`getVisibleAgents`, `getStartupCommands`) that are already called elsewhere in `KanbanProvider` (e.g. lines 2684-2685).
- **No orchestrator terminal configured:** Button renders dimmed with tooltip explaining the user needs to enable the Orchestrator agent in the kanban Agents tab. Clicking still works (copies the prompt — the backend's `dispatchEpicOrchestration` already handles missing terminals gracefully by copying instead, per `PlanningPanelProvider.ts:2871-2878`).
- **Orchestrator visible but no startup command:** Button renders dimmed — the orchestrator is enabled but has no CLI command configured, so dispatch will fail. Check both visibility AND startup command presence.
- **Orchestrator configured but no terminal running:** Button renders teal/active (heuristic passes: visible + startup command), but `dispatchCustomPromptToRole` (`TaskViewerProvider.ts:2634-2646`) may still fail if no terminal is running for the role. The tooltip hedges with "attempts to dispatch" rather than "dispatches." The prompt is always copied as a fallback, so the user is never left empty-handed.
- **`_taskViewerProvider` is null:** `isOrchestratorAvailable()` returns false — safe fallback.
- **Standalone epic documents:** The Orchestrate button is already hidden for standalone epics (`isManageable` guard at `project.js:1351`). No change needed.
- **No confirmation dialogs** (project rule) — not applicable (this is a visual/tooltip fix).
- **Button still works when dimmed:** The button is NOT disabled — it is visually de-emphasized to signal "no agent configured," but clicking it still copies the prompt (the backend always copies, dispatch is optional). This matches the existing fallback behavior.
- **Legacy per-workspace state files:** `isOrchestratorAvailable()` is called without a workspaceRoot. For users on the machine-global config (`~/.switchboard`), this works. For users on legacy per-workspace state files, `getVisibleAgents(undefined)` falls back to defaults (`orchestrator: false`). This affects a shrinking minority of the install base; the button still copies the prompt when clicked regardless.

## Dependencies

- None — this plan is self-contained and does not depend on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) async state-sync timing — the `await isOrchestratorAvailable()` call must be placed before the request guard to avoid stale messages; (2) error-branch placement — the webview `_orchestratorAvailable` assignment must precede the early-return error check; (3) heuristic vs truth — the availability check verifies config but not running terminals, so the tooltip must hedge. Mitigations: compute availability before the guard, place the webview assignment before the error check, and use "attempts to dispatch" language in the active tooltip.

## Proposed Changes

### `src/services/KanbanProvider.ts` — New public method

**1. Add `isOrchestratorAvailable` method (near `dispatchEpicOrchestration` at line 3048, after the closing brace of `dispatchEpicOrchestration`):**

```typescript
/**
 * Returns true if the orchestrator agent is both visible (enabled) and has
 * a startup command configured. Used by the Epics tab to style the
 * Orchestrate button to reflect whether dispatch will succeed.
 * Note: this is a heuristic — it checks configuration, not whether a
 * terminal is currently running. The prompt is always copied as a fallback.
 */
public async isOrchestratorAvailable(workspaceRoot?: string): Promise<boolean> {
    if (!this._taskViewerProvider) { return false; }
    try {
        const visibleAgents = await this._taskViewerProvider.getVisibleAgents(workspaceRoot);
        if (!visibleAgents?.orchestrator) { return false; }
        const commands = await this._taskViewerProvider.getStartupCommands(workspaceRoot);
        return !!(commands?.orchestrator && commands.orchestrator.trim());
    } catch {
        return false;
    }
}
```

### `src/services/PlanningPanelProvider.ts` — Include orchestrator availability in `kanbanPlansReady`

**2. Compute `orchestratorAvailable` BEFORE the request guard check (line 2554), then include it in the `kanbanPlansReady` message (line 2557-2564):**

Insert the availability computation before line 2554 (`if (requestId !== ...)`):

```typescript
// Compute orchestrator availability before the guard check so a newer
// request arriving during the await doesn't get a stale message.
const orchestratorAvailable = this._kanbanProvider
    ? await this._kanbanProvider.isOrchestratorAvailable()
    : false;
if (requestId !== this._latestRequestIds.get(guardKey)) { break; }
```

Then add the field to the postMessage at line 2557:

```typescript
this._projectPanel?.webview.postMessage({
    type: 'kanbanPlansReady',
    plans: allPlans,
    workspaceItems,
    allWorkspaceProjects,
    columns: mergedColumns,
    requestId,
    orchestratorAvailable
});
```

Also add `orchestratorAvailable: false` to the error branch at line 2567 for consistency:

```typescript
this._projectPanel?.webview.postMessage({ type: 'kanbanPlansReady', plans: [], columns: [], requestId, error: String(err), orchestratorAvailable: false });
```

### `src/webview/project.js` — Store orchestrator availability and style the button

**3. Add a state variable (near other state variables, after line 166 `let _epicSelectedPlan = null;`):**

```javascript
let _orchestratorAvailable = false;
```

**4. Update the state from `kanbanPlansReady` handler — BEFORE the error check (insert after line 293, before line 294):**

```javascript
// Inside the kanbanPlansReady handler — MUST be before the msg.error check
// so the error branch (which sends orchestratorAvailable: false) resets state.
_orchestratorAvailable = !!msg.orchestratorAvailable;
```

**5. Re-render the meta-bar when `kanbanPlansReady` arrives (if an epic is selected) — add after line 307 (`tryResolvePendingEpicSelection();`):**

```javascript
if (_epicSelectedPlan) renderEpicMetaBar(_epicSelectedPlan);
```

**6. Update `renderEpicMetaBar` to use the flag (line 1354):**

Replace the static Orchestrate button:

```javascript
// OLD:
<button class="strip-btn" id="btn-epic-orchestrate" style="border-color: var(--accent-teal);" title="Assemble the orchestrator prompt for this epic and copy it">Orchestrate</button>

// NEW:
<button class="strip-btn" id="btn-epic-orchestrate" style="${_orchestratorAvailable ? 'border-color: var(--accent-teal);' : 'opacity: 0.6; border-color: var(--border-color);'}" title="${_orchestratorAvailable ? 'Hand this epic to one orchestrator agent that runs all subtasks end-to-end with native subagents. Copies the prompt and attempts to dispatch to the orchestrator terminal.' : 'Hand this epic to one orchestrator agent that runs all subtasks end-to-end. No orchestrator agent is configured yet — clicking copies the prompt. Enable the Orchestrator agent in the kanban Agents tab to dispatch directly.'}">Orchestrate</button>
```

Note the active tooltip uses "attempts to dispatch" (not "dispatches") because the availability check verifies configuration but not whether a terminal is currently running — dispatch may still fail if no terminal is active for the orchestrator role.

## Verification Plan

> Manual verification against an installed VSIX (per project norm). No compilation or automated tests run in this session.

### Manual Verification

1. **No orchestrator configured (default state):** Open the Epics tab, select a DB-backed epic → the Orchestrate button is dimmed (opacity 0.6, default border color). Hover shows the long tooltip explaining what it does and that no orchestrator is configured.
2. **Orchestrator configured:** Enable the Orchestrator agent in the kanban Agents tab (check the visibility checkbox, enter a startup command) → return to the Epics tab, refresh → the Orchestrate button is teal/active. Hover shows the tooltip explaining it attempts to dispatch to the orchestrator terminal.
3. **Click when dimmed:** Click the dimmed Orchestrate button → the orchestration overlay opens with the assembled prompt, and a toast says "Orchestrator prompt copied" (no terminal dispatch since none is configured). The button still works — it is NOT disabled.
4. **Click when active:** Click the active Orchestrate button → the prompt is dispatched to the orchestrator terminal and copied.
5. **Tooltip clarity:** The tooltip clearly explains what "Orchestrate" means: "Hand this epic to one orchestrator agent that runs all subtasks end-to-end with native subagents."
6. **State updates on refresh:** After toggling orchestrator visibility in the Agents tab, switching to the Epics tab and back (or triggering a plan refresh) updates the button style correctly.
7. **No regression:** The +Subtask and Delete Epic buttons in the meta-bar are unaffected.
8. **Error path:** If `kanbanPlansReady` arrives with an error, the button resets to dimmed (orchestratorAvailable: false from the error branch, and the assignment runs before the early return).

---

**Recommendation:** Complexity 4/10 → **Send to Coder**. Three-file change with established patterns, no new architecture, safe fallback behavior. The main attention points are the placement of the `await` (before the guard) and the webview assignment (before the error check) — both documented above.

---

## Review Pass — 2026-06-25

**Reviewer:** In-place adversarial review (Grumpy Principal Engineer → Balanced synthesis).

### Files Changed (verified in source)

| File | Lines | Change |
|------|-------|--------|
| `src/services/KanbanProvider.ts` | 3131-3148 | New `isOrchestratorAvailable` method after `dispatchEpicOrchestration` |
| `src/services/PlanningPanelProvider.ts` | 2544-2548, 2560, 2564 | `orchestratorAvailable` computed before guard; added to postMessage + error branch |
| `src/webview/project.js` | 164, 288, 315, 1436 | State var, handler assignment before error check, meta-bar re-render, conditional button style+tooltip |

### Findings by Severity

| Severity | Finding | Location | Status |
|----------|---------|----------|--------|
| CRITICAL | (none) | — | — |
| MAJOR | (none) | — | — |
| NIT | Overlay "Send to Orchestrator" button (`btn-epic-orchestrate-send`) still has hardcoded teal border — UX inconsistency with the dimmed meta-bar button, but out of this plan's scope | `src/webview/project.html:1623` | Deferred — separate follow-up |
| NIT | Inline `title`/`style` ternary produces a ~450-char line — ugly but consistent with existing `renderEpicMetaBar` conventions | `src/webview/project.js:1436` | Not worth fixing |

### Fixes Applied

None — no CRITICAL or MAJOR findings. The implementation is a faithful, correct execution of the plan.

### Validation Results (static verification — compilation/tests skipped per session directives)

- ✅ All 6 planned change sites present and correctly placed.
- ✅ `await isOrchestratorAvailable()` computed BEFORE the request guard (`PlanningPanelProvider.ts:2544-2549`) — stale messages caught by guard.
- ✅ Webview `_orchestratorAvailable` assignment BEFORE `msg.error` early return (`project.js:288` before `293`) — error branch resets state to dimmed.
- ✅ `isOrchestratorAvailable` null-safe on `_taskViewerProvider` (`KanbanProvider.ts:3139`).
- ✅ Heuristic checks both visibility AND startup command (`KanbanProvider.ts:3142, 3144`).
- ✅ `getVisibleAgents` default has `orchestrator: false` (`TaskViewerProvider.ts:3652`) — confirms default-dimmed behavior.
- ✅ Error branch sends `orchestratorAvailable: false` (`PlanningPanelProvider.ts:2564`).
- ✅ No `confirm()` gates introduced (grep: 0 matches in `project.js`) — project rule intact.
- ✅ Button NOT disabled when dimmed — no `disabled` attribute; clicking still copies the prompt.
- ✅ Tooltip text matches plan exactly (both active and inactive strings).
- ✅ Method signatures match: `getVisibleAgents → Record<string,boolean>`, `getStartupCommands → Record<string,string>` (`TaskViewerProvider.ts:3636, 3558`).

### Remaining Risks

1. **Overlay button inconsistency (NIT, deferred):** The "Send to Orchestrator" button inside the orchestration overlay (`project.html:1623`) always renders teal regardless of orchestrator configuration. A user who clicks the dimmed meta-bar button sees a fully-active "Send" button in the overlay — slightly contradictory. Out of this plan's scope; recommend a follow-up plan to conditionally style `btn-epic-orchestrate-send` based on `_orchestratorAvailable`.
2. **Heuristic vs. truth:** The availability check verifies configuration (visible + startup command) but not whether a terminal is currently running. The active tooltip hedges with "attempts to dispatch" — acceptable. The prompt is always copied as a fallback.
3. **Legacy per-workspace state files:** `isOrchestratorAvailable()` is called without a `workspaceRoot`, so users on legacy per-workspace state files get `getVisibleAgents(undefined)` → defaults (`orchestrator: false`) → button always dimmed. The button still copies the prompt when clicked. Affects a shrinking minority of the install base; documented in the plan's Edge-Case Audit.
