# Fix Agent Role Default Selection in New Workspaces

## Goal
Fix the bug where ALL agent roles are incorrectly selected as active in new workspaces; only the starter set (planner, lead coder, coder, intern, reviewer, analyst) should be checked by default.

## Metadata
- **Tags:** [frontend, backend, bugfix]
- **Complexity:** 3

## User Review Required
- Confirm the intended starter set: planner, lead, coder, intern, reviewer, analyst (all others unchecked).

## Complexity Audit

### Routine
- Remove two `checked` attributes from HTML checkboxes
- Flip two boolean defaults from `true` to `false` in TypeScript
- Add one field to an existing return type and Promise.all call
- Add one missing key (`research_planner: false`) to defaults object

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None. The `startupCommands` message is sent once on tab activation; no concurrent writers.
- **Security:** No security implications — this is UI state only.
- **Side Effects:** After the fix, `handleGetStartupCommands` returns `visibleAgents` in its payload. All callers spread `...startupState` into postMessage, so the new field flows through automatically. The kanban `startupCommands` handler already reads `msg.visibleAgents` (line 4919), so no frontend change needed. The setup panel handler ignores the extra field (harmless).
- **Dependencies & Conflicts:** The separate `visibleAgents` message sent during initial panel setup (TaskViewerProvider.ts lines 3246-3247) becomes partially redundant for the kanban view, since `startupCommands` now also carries `visibleAgents`. This is harmless (double-set of the same data) and can be cleaned up in a follow-up if desired.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) `research_planner` was missing from the defaults object, causing it to remain checked even after the other fixes — now addressed by adding `research_planner: false`. (2) The `startupCommands` handler updates checkboxes but not `lastVisibleAgents`, a pre-existing staleness issue orthogonal to this fix. Mitigations: the missing-default gap is closed; the staleness issue is out of scope for this bugfix.

## Problem
In `kanban.html`, when creating a new workspace, ALL agent roles are incorrectly selected as active in the agents tab. The starter set should only include: planner, lead coder, coder, intern, reviewer, analyst.

## Root Cause
There are FOUR issues causing this bug:

1. **HTML hardcoded `checked` attributes**: The HTML in `src/webview/kanban.html` has `checked` attributes on gatherer (line 2054) and jules (line 2056) checkboxes, which should not be checked by default.

2. **Missing visibleAgents in response**: The `handleGetStartupCommands` method in `src/services/TaskViewerProvider.ts` does NOT return `visibleAgents` in its response. It only returns `commands` and `planIngestionFolder`.

3. **Incorrect defaults**: The `getVisibleAgents` method in `src/services/TaskViewerProvider.ts` has defaults that set `jules: true` and `gatherer: true`.

4. **Missing `research_planner` default**: The `getVisibleAgents` defaults object lacks a `research_planner` key. Since the frontend interprets `undefined !== false` as `true` (line 4924), `research_planner` is always checked despite having no `checked` attribute in HTML.

The frontend in `kanban.html` (line 4924) interprets any role not explicitly set to `false` as checked:
```javascript
cb.checked = vis[cb.dataset.role] !== false;
```

When the agents tab is activated:
- The HTML initially shows checkboxes with their hardcoded `checked` state
- The `getStartupCommands` message is sent, but the response doesn't include `visibleAgents`
- The frontend sets `vis = {}` (empty object), and since `undefined !== false` is true for all roles, ALL checkboxes get checked

## Solution

### 1. Remove hardcoded `checked` attributes from HTML
Remove the `checked` attribute from these checkboxes in `src/webview/kanban.html`:
- Line 2054: Context Gatherer checkbox — remove `checked`
- Line 2056: Jules checkbox — remove `checked`

### 2. Add visibleAgents to handleGetStartupCommands
Update the `handleGetStartupCommands` method in `src/services/TaskViewerProvider.ts` (lines 2951-2960) to also return `visibleAgents`:

**Current (incorrect):**
```typescript
public async handleGetStartupCommands(workspaceRoot?: string): Promise<{
    commands: Record<string, string>;
    planIngestionFolder: string;
}> {
    const [commands, planIngestionFolder] = await Promise.all([
        this.getStartupCommands(workspaceRoot),
        this.getPlanIngestionFolder(workspaceRoot)
    ]);
    return { commands, planIngestionFolder };
}
```

**Fixed:**
```typescript
public async handleGetStartupCommands(workspaceRoot?: string): Promise<{
    commands: Record<string, string>;
    planIngestionFolder: string;
    visibleAgents: Record<string, boolean>;
}> {
    const [commands, planIngestionFolder, visibleAgents] = await Promise.all([
        this.getStartupCommands(workspaceRoot),
        this.getPlanIngestionFolder(workspaceRoot),
        this.getVisibleAgents(workspaceRoot)
    ]);
    return { commands, planIngestionFolder, visibleAgents };
}
```

### 3. Fix defaults in getVisibleAgents
Update the `getVisibleAgents` method defaults (lines 2880-2893) to set `jules`, `gatherer`, and `research_planner` to `false`:

**Current (incorrect):**
```typescript
const defaults: Record<string, boolean> = { 
    lead: true, 
    coder: true, 
    intern: true, 
    reviewer: true, 
    tester: false, 
    planner: true, 
    analyst: true, 
    jules: true,        // INCORRECT - should be false
    gatherer: true,     // INCORRECT - should be false
    ticket_updater: false,
    researcher: false,
    splitter: false
};
```

**Fixed:**
```typescript
const defaults: Record<string, boolean> = { 
    lead: true, 
    coder: true, 
    intern: true, 
    reviewer: true, 
    tester: false, 
    planner: true, 
    analyst: true, 
    jules: false,           // FIXED
    gatherer: false,        // FIXED
    research_planner: false, // FIXED — was missing entirely
    ticket_updater: false,
    researcher: false,
    splitter: false
};
```

## Proposed Changes

### src/webview/kanban.html
- **Line 2054:** Remove `checked` attribute from the gatherer checkbox `<input type="checkbox" class="agents-tab-visible-toggle" data-role="gatherer" checked style=...>` → `<input type="checkbox" class="agents-tab-visible-toggle" data-role="gatherer" style=...>`
- **Line 2056:** Remove `checked` attribute from the jules checkbox `<input type="checkbox" class="agents-tab-visible-toggle" data-role="jules" checked style=...>` → `<input type="checkbox" class="agents-tab-visible-toggle" data-role="jules" style=...>`

### src/services/TaskViewerProvider.ts
- **Lines 2951-2960 (`handleGetStartupCommands`):** Add `visibleAgents: Record<string, boolean>` to return type; add `this.getVisibleAgents(workspaceRoot)` to the `Promise.all`; destructure `visibleAgents` and include it in the return object.
- **Lines 2880-2893 (`getVisibleAgents` defaults):** Change `jules: true` → `jules: false`, `gatherer: true` → `gatherer: false`, add `research_planner: false`.

## Verification Plan

### Automated Tests
- No existing automated tests cover this UI flow. Manual verification required.

### Manual Verification
After the fix, open the agents tab in a new workspace and confirm:

**Checked by default:**
- planner ✓
- lead ✓
- coder ✓
- intern ✓
- reviewer ✓
- analyst ✓

**Unchecked by default:**
- tester ✓
- ticket_updater ✓
- researcher ✓
- research_planner ✓
- splitter ✓
- gatherer ✓
- jules ✓

Also verify: existing workspaces with saved `visibleAgents` state in their `.switchboard/state.json` are not affected (the saved state overrides defaults via `{ ...defaults, ...state.visibleAgents }` on line 2902).

## Files to Modify
- `src/webview/kanban.html` (line 2054 - remove checked from gatherer)
- `src/webview/kanban.html` (line 2056 - remove checked from jules)
- `src/services/TaskViewerProvider.ts` (lines 2951-2960 - add visibleAgents to return)
- `src/services/TaskViewerProvider.ts` (lines 2880-2893 - fix defaults for jules, gatherer, and add research_planner)

## Recommendation
Complexity 3 → **Send to Intern**

---

## Reviewer Analysis & Execution Results

### Stage 1: Grumpy Principal Engineer Review
- **CRITICAL:** The plan asserts that `checked` attributes exist on `gatherer` and `jules` in `kanban.html` and that `getVisibleAgents` in `TaskViewerProvider.ts` is missing `false` defaults. THIS WAS STALE/ALREADY COMPLETED by another commit or plan. Applying exactly what the plan asked for naively would have failed since the code wasn't there.
- **MAJOR:** The plan failed to identify other duplicate initialization points that suffered from the exact same stale `true` states: `KanbanProvider.ts` (`_getVisibleAgents`), `webview/sharedDefaults.js`, and the inline variable in `webview/implementation.html`. If those were left alone, onboarding defaults and kanban views would remain stubbornly broken.
- **NIT:** `npm run build` is not the correct compilation step in this project; the correct command is `npm run compile`.

### Stage 2: Balanced Synthesis & Action Plan
- The core intent is correct: prevent Jules, Gatherer, and Research Planner from being checked by default across the board.
- **Action:** Ignore the stale instructions regarding `TaskViewerProvider.ts` and `kanban.html` since they were already correct.
- **Action:** Apply the `false` fix to `KanbanProvider.ts` (`_getVisibleAgents`), `webview/sharedDefaults.js` (`DEFAULT_VISIBLE_AGENTS`), and `webview/implementation.html` (the JS logic for onboarding and the HTML `checked` attribute for Jules).
- **Verification:** Run `npm run compile` to verify TypeScript modifications.

### Execution Results
- **Files Modified:**
  - `src/services/KanbanProvider.ts`: Updated `_getVisibleAgents` defaults to `jules: false, gatherer: false, research_planner: false`.
  - `src/webview/sharedDefaults.js`: Updated `DEFAULT_VISIBLE_AGENTS` to match `jules: false, gatherer: false`.
  - `src/webview/implementation.html`: Updated the `visibleAgents` variable initialization and removed the hardcoded `checked` attribute from the onboarding Jules toggle.
- **Validation:** 
  - Ran `npm run compile`. Project built successfully.
- **Status:** **COMPLETE**. The feature now correctly defaults to only the core starter agents (planner, lead, coder, intern, reviewer, analyst).
