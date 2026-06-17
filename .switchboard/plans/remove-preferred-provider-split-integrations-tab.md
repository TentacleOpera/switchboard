# Remove Preferred Provider and Split Integrations Tab

## Metadata
**Complexity:** 7
**Tags:** ui, ux, refactor, backend, frontend

## Goal
Remove the `switchboard.integrations.preferredProvider` setting and split the Integrations tab in setup.html into separate tabs for ClickUp, Linear, and Notion. Update planning.html Tickets tab to dynamically show provider dropdown or rename based on configured integrations.

## Problem Analysis

### Background & Root Cause
The architecture was designed around a single "preferred provider" concept, stored in a VS Code setting. This creates a bottleneck where setup.html must hide/show provider sections based on selection, planning.html must read the setting to know which provider to use, and users cannot easily switch between providers without changing a global setting. Additionally, the `preferredProvider` setting lacks `"scope": "resource"` in `package.json`, causing "does not support the folder resource scope" errors when users try to change the dropdown in multi-root workspaces.

### Current Issues
1. **Single Integrations tab is confusing** — Shows a dropdown to select between Linear/ClickUp, but only one provider section is visible at a time. Users don't understand why they can't see both configurations simultaneously.
2. **preferredProvider setting causes scope errors** — The missing `"scope": "resource"` triggers configuration errors in multi-root workspaces.
3. **Tickets tab is generic** — Always shows "TICKETS" regardless of which provider is configured, requiring users to remember which integration they're using.
4. **No multi-provider support** — The architecture assumes a single "preferred" provider, but users may want to use both ClickUp and Linear in different contexts.
5. **Sync logic is setting-driven, not plan-driven** — `ContinuousSyncService` reads `preferredProvider` instead of using plan metadata (`clickupTaskId` vs `linearIssueId`) to decide where to sync.

### Proposed Solution
1. Remove the preferred provider concept entirely
2. Make each integration independently configurable in separate tabs
3. Let planning.html detect which providers are configured and adapt UI accordingly
4. Use plan metadata (`clickupTaskId` vs `linearIssueId`) to determine sync target in `ContinuousSyncService`
5. Allow users to switch ticket providers dynamically via a dropdown when both are configured

## User Review Required
- Confirm whether per-provider "Ticket Import Location" should be shared state (same path shown in both tabs) or forked state (separate paths per provider). Current plan assumes shared state duplicated in UI.
- Confirm acceptable behavior for memory-only ticket provider dropdown state: reload resets to default, or should it persist via `ExtensionContext.workspaceState`?

## Complexity Audit

### Routine
- Removing a single VS Code configuration property from `package.json`
- Deleting a message handler case block in `SetupPanelProvider.ts`
- Deleting a broadcast/postMessage block in `TaskViewerProvider.ts`
- Removing mock configuration objects from two test files
- Removing a `.vscode/settings.json` line
- Converting one tab button to three in HTML
- CSS tab-bar layout already supports multiple tabs (no new styles needed)

### Complex / Risky
- Splitting a single conditional visibility div into three independent tab content divs without breaking existing event listeners and form save handlers
- Replacing setting-driven sync with plan-metadata-driven sync in `ContinuousSyncService` — any logic error skips sync silently
- Coordinating message protocol changes across backend (TypeScript) and frontend (planning.js) — missed consumer = broken tickets panel
- Preserving ticket import location configuration while moving its DOM between tabs
- Dynamic tab label and dropdown logic in planning.html/planning.js requires careful state synchronization with `lastIntegrationProvider`

## Edge-Case & Dependency Audit

### Race Conditions
- **Setup panel load race**: If `getIntegrationSetupStates` is called before secret storage resolves, the new tab structure must not throw on missing `preferredProvider` field. (Mitigation: the function already returns defaults for missing tokens; `preferredProvider` removal is just one fewer field.)
- **Sync target ambiguity**: If a plan has both `clickupTaskId` and `linearIssueId`, the new `if...else if` chain prioritizes ClickUp. Document this behavior and log the decision.

### Security
- No new secret storage reads/writes. Existing token storage patterns unchanged.

### Side Effects
- **Dead code risk**: `integrationProviderPreference` message type becomes obsolete. Any remaining listeners in webviews will receive no more messages, which is harmless but should be cleaned up.
- **Ghost setting**: Users with `switchboard.integrations.preferredProvider` in `.vscode/settings.json` or user settings will have a stale value. VS Code ignores unknown settings, so this is harmless.

### Dependencies & Conflicts
- No external dependencies. Self-contained refactor across switchboard extension only.
- Potential conflict: if another branch adds new `preferredProvider` consumers, merge will break. Recommend running a final `grep` for `preferredProvider` and `integrationProviderPreference` before merge.

## Dependencies
None — this is a self-contained refactor.

## Adversarial Synthesis
Key risks: (1) `src/webview/planning.js` was omitted from the original plan but is a critical consumer of `integrationProviderPreference` messages; missing it breaks ticket loading. (2) Test harnesses for `ContinuousSyncService` may silently no-op if mock plans lack `clickupTaskId` after the setting read is removed. (3) Memory-only `_activeTicketsProvider` Map resets on panel reload, creating UX confusion. Mitigations: explicitly add planning.js to Phase 3, verify mock plan metadata before updating tests, and consider `workspaceState` persistence or document the reset behavior.

## Verification Plan

### Automated Tests
- Verify `continuous-sync-timeout-stall.test.js` and `continuous-sync-debounce.test.js` mock plans include `clickupTaskId` so the new metadata-driven path triggers. If not, add the field to harness plan objects.
- Run existing integration tests for ClickUp and Linear import/sync workflows to confirm no regression.
- grep `src/` for `preferredProvider` and `integrationProviderPreference` after all phases to catch stragglers.

### Manual Tests
- **Setup Panel**: Open setup.html in fresh workspace. Verify three tabs (ClickUp, Linear, Notion). Verify no provider dropdown. Configure ClickUp, switch to Linear tab, verify ClickUp config persists. Configure Linear, verify both active.
- **Planning Panel (no integrations)**: Open planning.html. Verify "TICKETS" label, no dropdown.
- **Planning Panel (ClickUp only)**: Configure ClickUp. Reload planning.html. Verify "CLICKUP" label, no dropdown. Verify ticket loading works.
- **Planning Panel (both)**: Configure Linear. Reload planning.html. Verify "TICKETS" label with dropdown. Switch dropdown to Linear. Verify tickets reload.
- **Planning Panel (Linear only)**: Remove ClickUp config. Reload. Verify "LINEAR" label, no dropdown.
- **Continuous Sync**: Create plan with `clickupTaskId`, move to trigger sync, verify ClickUp side hit. Create plan with `linearIssueId`, verify Linear side hit. Create plan with neither, verify sync skipped.

## Implementation Plan

### Phase 1: Update setup.html Tab Structure

**File: `src/webview/setup.html`**

1. Replace the single "Integrations" tab button with three separate tabs:
   - Change from: `<button class="shared-tab-btn" data-tab="integration">Integrations</button>`
   - To: 
     ```html
     <button class="shared-tab-btn" data-tab="clickup">ClickUp</button>
     <button class="shared-tab-btn" data-tab="linear">Linear</button>
     <button class="shared-tab-btn" data-tab="notion">Notion</button>
     ```

2. Split the `#project-mgmt-fields` content div into three separate divs:
   - `#clickup-fields` (data-tab-content="clickup")
   - `#linear-fields` (data-tab-content="linear")
   - `#notion-fields` (data-tab-content="notion")

3. Remove the "Project Management Provider" dropdown section (lines 633-646)

4. Move the "Ticket Import Location" section to both ClickUp and Linear tabs (shared configuration)

5. Move Notion configuration to its own tab (already exists, just needs to be separated)

6. Update JavaScript to remove:
   - `integration-provider-selector` event listener (lines 3586-3596)
   - `updateIntegrationProviderVisibility()` function
   - `selectedIntegrationProvider` variable
   - `saveIntegrationProviderPreference` message handler in SetupPanelProvider.ts

### Phase 2: Remove preferredProvider Setting

**File: `package.json`**

1. Remove the `switchboard.integrations.preferredProvider` property definition (lines 324-336)

**File: `src/services/SetupPanelProvider.ts`**

1. Remove the `saveIntegrationProviderPreference` case handler (lines 673-689)

**File: `src/services/TaskViewerProvider.ts`**

1. Remove the `preferredProvider` read and `integrationProviderPreference` broadcast (lines 3763-3767)
2. Remove `preferredProvider` from `getIntegrationSetupStates` return type (line 3900)
3. Remove `preferredProvider` reads in `getIntegrationSetupStates` (line 3912, 3925, 4062)
4. Remove `integrationProviderPreference` from `initialState` message (line 4939)

**File: `src/services/PlanningPanelProvider.ts`**

1. Remove `integrationProviderPreference` message sends (lines 1166, 1234)
2. Keep the provider detection logic (lines 1160-1162, 1226-1228) but don't send it to webview

**File: `src/services/ContinuousSyncService.ts`**

1. Replace preferredProvider read with plan metadata detection:
   ```typescript
   // Current (lines 485-496):
   const preferredProvider = vscode.workspace?.getConfiguration
     ? vscode.workspace
         .getConfiguration('switchboard', folderUri)
         .get<'linear' | 'clickup'>('integrations.preferredProvider') || 'linear'
     : 'linear';
   
   let syncResult;
   if (preferredProvider === 'clickup') {
       syncResult = await this._syncToClickUp(plan, content, workspaceRoot, controller.signal);
   } else {
       syncResult = await this._syncToLinear(plan, content, workspaceRoot, controller.signal);
   }
   
   // New:
   let syncResult;
   if (plan.clickupTaskId) {
       if (plan.linearIssueId) {
           console.log('[ContinuousSync] Plan has both clickupTaskId and linearIssueId; prioritizing ClickUp.');
       }
       syncResult = await this._syncToClickUp(plan, content, workspaceRoot, controller.signal);
   } else if (plan.linearIssueId) {
       syncResult = await this._syncToLinear(plan, content, workspaceRoot, controller.signal);
   } else {
       // No sync target - skip
       return;
   }
   ```

### Phase 3: Update planning.html and planning.js Tickets Tab

**File: `src/webview/planning.html`**

1. Update the tab button to have an ID for dynamic relabeling:
   ```html
   <button class="shared-tab-btn" data-tab="tickets" id="tickets-tab-btn">TICKETS</button>
   ```

2. Add provider dropdown inside the `#tickets-content` area (near the workspace filter or controls row):
   ```html
   <select id="tickets-provider-selector" class="workspace-filter-select" style="display:none;">
       <option value="clickup">ClickUp</option>
       <option value="linear">Linear</option>
   </select>
   ```

**File: `src/webview/planning.js`**

1. Add handler for `integrationProviderStates` message:
   - Receive `{ clickupSetupComplete, linearSetupComplete }` from backend
   - If both true: show `#tickets-provider-selector`, keep tab label as "TICKETS"
   - If only clickupSetupComplete: hide selector, set tab label to "CLICKUP"
   - If only linearSetupComplete: hide selector, set tab label to "LINEAR"
   - If neither: hide selector, keep tab label as "TICKETS"
   - After determining the effective provider, set `lastIntegrationProvider` and trigger appropriate ticket load

2. Add dropdown change listener:
   - On `#tickets-provider-selector` change, send `switchTicketsProvider` message to backend with `{ provider, workspaceRoot }`
   - Update `lastIntegrationProvider` locally and trigger ticket reload

3. Remove or repurpose the old `integrationProviderPreference` handler (line ~3639). Since `PlanningPanelProvider.ts` no longer sends this message type, the handler will never fire. Replace it with the new `integrationProviderStates` handler to avoid confusion.

**File: `src/services/PlanningPanelProvider.ts`**

1. Add message handler for `switchTicketsProvider`:
   ```typescript
   case 'switchTicketsProvider': {
       const { provider } = msg;
       const workspaceRoot = msg.workspaceRoot;
       if (!workspaceRoot) break;
       
       // Store provider preference in memory (not persisted)
       this._activeTicketsProvider.set(workspaceRoot, provider);
       
       // Re-fetch tickets with new provider
       if (provider === 'clickup') {
           // Load ClickUp tickets
       } else {
           // Load Linear tickets
       }
       break;
   }
   ```

2. Add `integrationProviderStates` to the `initialState` message payload:
   ```typescript
   this._panel?.webview.postMessage({
       type: 'initialState',
       // ... existing fields
       integrationProviderStates: {
           clickupSetupComplete: clickupConfig?.setupComplete === true,
           linearSetupComplete: linearConfig?.setupComplete === true
       }
   });
   ```

3. Add private field to track active provider per workspace:
   ```typescript
   private _activeTicketsProvider = new Map<string, 'clickup' | 'linear'>();
   ```

### Phase 4: Update Tickets Tab Backend Logic

**File: `src/services/TaskViewerProvider.ts`**

1. Update ticket loading to use active provider instead of preferredProvider:
   - When loading tickets, check `_activeTicketsProvider` for the workspace
   - Default to whichever provider is configured if not set
   - If both configured, default to ClickUp (or first alphabetically)

2. Update ticket sync to use plan metadata (already done in Phase 2 for ContinuousSyncService, but ensure consistency)

### Phase 5: Clean Up Test Files and Stragglers

**File: `src/test/continuous-sync-timeout-stall.test.js`**

1. Remove `integrations.preferredProvider` mock (lines 33-39)
2. Verify the harness plan object includes `clickupTaskId` so the new metadata-driven sync path triggers; if missing, add it

**File: `src/test/continuous-sync-debounce.test.js`**

1. Remove `integrations.preferredProvider` mock (lines 30-34)
2. Verify the harness plan object includes `clickupTaskId`; if missing, add it

**File: `.vscode/settings.json`**

1. Remove `switchboard.integrations.preferredProvider` line (line 23)

**File: `src/webview/planning.js`**

1. Remove the old `integrationProviderPreference` message handler if not already repurposed in Phase 3
2. Verify no remaining references to `lastIntegrationProvider` logic that depend on the old message type

**Final Verification Step**

Run the following grep across `src/` to catch any missed references:
```bash
grep -rn "preferredProvider\|integrationProviderPreference\|saveIntegrationProviderPreference" src/
```
Expected result: zero matches (except in comments referencing the removal).

## Rollback Plan

If issues arise, revert changes in reverse order:
1. Revert Phase 5 (test files and stragglers)
2. Revert Phase 4 (tickets backend)
3. Revert Phase 3 (planning.html and planning.js)
4. Revert Phase 2 (preferredProvider removal)
5. Revert Phase 1 (setup.html structure)

## Remaining Risks

1. **User migration** — Users with existing `preferredProvider` settings will lose that preference. They'll need to manually select provider in planning.html if both are configured. VS Code ignores unknown settings, so no hard errors.
2. **Memory state volatility** — Active provider in planning.html is stored in a `_activeTicketsProvider` Map. Reloading VS Code, closing/reopening the panel, or switching workspaces resets it to default. Consider persisting via `ExtensionContext.workspaceState` if UX feedback is negative.
3. **Test harness fragility** — Continuous sync tests mock `preferredProvider` in `getConfiguration`. After removal, the code no longer reads that setting. If the mock plan objects lack `clickupTaskId`, the new metadata-driven sync path short-circuits and tests pass without actually testing sync logic.
4. **Dead message handler** — `integrationProviderPreference` is still handled in `planning.js` (line ~3639). While no backend sender remains after Phase 2, leaving the handler creates maintenance confusion. Must be removed in Phase 5.
5. **Ticket Import Location duplication** — If moved to both ClickUp and Linear tabs as shared state, both tabs must read/write the same configuration key. If a future developer makes the paths per-provider, data model changes are required.
6. **Sidebar webview** — TaskViewerProvider's `initialState` at line 4939 sends `integrationProviderPreference`. If the sidebar webview (`sidebar.html` or equivalent) reads this field, removing it may cause issues. Verify sidebar consumers before merge.

## Recommendation

Complexity 7 → **Send to Lead Coder**

