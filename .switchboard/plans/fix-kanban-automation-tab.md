# Fix Kanban Automation Tab

## Goal
Fix the Kanban automation tab so that single-column mode is the default, mode options have descriptive help text, and the single-column UI matches the multi-column UI's sectioned layout (Automation Rules, Column Rules, Terminal Pools) with unused options removed.

## Issues
1. Default automation mode appears to be multi-column instead of single-column
2. No descriptive text under each dropdown option in the mode selector
3. Single-column controls look vastly different from multi-column controls - they should look the same but with unused options removed

## Requirements
- Single-column mode should still have automation rules
- Single-column mode should still have column rules, but with only displaying one option (not a checkbox)
- Single-column mode should still have terminal pools, but with only one option

## Metadata
- **Tags:** [frontend, UI, bugfix, workflow]
- **Complexity:** 6

## User Review Required
- Which role should the single-column terminal pool display? (Default assumption: `coder`, matching the single-column engine's default agent assignment)
- Should the default mode fallback logic in `autobanState.ts` be changed to always prefer `single-column` for fresh/empty states, even if the user previously used multi-column?

## Complexity Audit

### Routine
- Adding a help text block below the mode selector that updates on mode change
- Restructuring single-column UI into `db-subsection` / `subsection-header` sections matching multi-column layout
- Copying batch size and complexity controls from multi-column into single-column Automation Rules section
- Adding a single interval control (no checkbox) to the single-column Column Rules section
- Adding a single terminal pool block to the single-column Terminal Pools section
- Applying `guardInteraction()` to all new interactive elements in single-column mode
- Updating `SingleColumnAutobanConfig` type to include `complexityFilter` and `terminalPools`
- Updating `normalizeSingleColumnConfig` to handle new fields
- Updating the single-column `postKanbanMessage` payloads to include new fields

### Complex / Risky
- **Root cause of default mode bug is in backend normalization** (`autobanState.ts` lines 235-239): the fallback logic classifies any state with `enabled === true` or `rules.length > 1` as `multi-column`. Since `DEFAULT_AUTOBAN_RULES` has 4 entries, fresh states default to multi-column. Fix must change this normalization without breaking existing multi-column users.
- **`emitAutobanState()` is undefined** — called 5 times in multi-column mode (lines 6476, 6508, 6537, 6578, 6605) but never defined anywhere. This is a pre-existing bug: multi-column state changes (batch, complexity, routing, rules) silently fail to propagate to the backend. Must be defined before the new single-column UI can reuse it.
- **Single-column state schema extension** requires coordinated changes across `autobanState.ts` (type + normalizer), `TaskViewerProvider.ts` (backend handler), and `kanban.html` (frontend). Risk of state desync if any layer is missed.

## Edge-Case & Dependency Audit

- **Race Conditions**: The `guardInteraction` / `isAutobanPanelInteracting` pattern prevents re-renders during user interaction. New single-column controls must register with `guardInteraction()` or risk mid-edit re-renders wiping user input.
- **Security**: No security implications — all changes are UI layout and state management within the webview.
- **Side Effects**: Defining `emitAutobanState()` will fix the pre-existing multi-column state persistence bug. This is a positive side effect but should be tested to ensure multi-column controls now correctly persist.
- **Dependencies & Conflicts**: The `autobanState.ts` normalization logic is shared by both the initial state load and the `updateAutobanConfig` message path. Changing the default fallback affects both paths. Must ensure existing multi-column users' saved state is not overridden to single-column on load.

## Dependencies
- `autobanState.ts` — type definitions and normalization logic for `SingleColumnAutobanConfig` and `AutobanConfigState`
- `TaskViewerProvider.ts` — backend handler `setAutomationModeFromKanban()` for single-column config persistence
- `kanban.html` — frontend `createAutobanPanel()` function containing all three mode UIs

## Adversarial Synthesis
Key risks: (1) `emitAutobanState()` is undefined — multi-column state changes are already broken, and the new single-column UI must not copy this broken pattern; (2) the default mode root cause is in backend normalization, not the frontend variable; (3) extending `SingleColumnAutobanConfig` requires coordinated changes across 3 files. Mitigations: define `emitAutobanState()` as a prerequisite fix, patch the `autobanState.ts` fallback to respect saved `automationMode` over heuristic detection, and update all three layers for the schema extension.

## Implementation Plan

### 0. Prerequisite: Define `emitAutobanState()`
**File**: `src/webview/kanban.html`
**Location**: Inside `createAutobanPanel()`, after the `guardInteraction` helper definition (around line 6190)

**Context**: `emitAutobanState()` is called 5 times in the multi-column branch but is never defined. This means batch size, complexity, routing, and column rule changes in multi-column mode silently fail to propagate to the backend.

**Implementation**: Add a local function that posts the current `state` (which is `autobanConfig`) back to the backend:
```javascript
const emitAutobanState = () => {
    postKanbanMessage({ type: 'updateAutobanConfig', state: { ...state } });
};
```
**Clarification**: The exact message type and payload shape should match what `KanbanProvider.ts` expects. Verify by checking how `updateAutobanConfig` messages are handled on the backend. If no handler exists for client-initiated `updateAutobanConfig`, use `setAutomationMode` with the full state or add a new message type.

**Edge Cases**: Must deep-copy `state` to avoid reference mutations. Must not emit during panel rebuild (guard with `isAutobanPanelInteracting`).

### 1. Fix Default Automation Mode
**File**: `src/services/autobanState.ts`
**Location**: Lines 235-239 inside `normalizeAutobanConfigState()`

**Current logic**:
```typescript
automationMode: (['single-column', 'multi-column', 'antigravity-batch'] as const).includes(state?.automationMode as any)
    ? state!.automationMode!
    : (state?.enabled === true || Object.keys(state?.rules ?? {}).length > 1)
        ? 'multi-column'
        : 'single-column',
```

**Root cause**: When `automationMode` is not explicitly saved (e.g., fresh install or migrated state), the fallback heuristic checks `enabled === true` or `rules.length > 1`. Since `DEFAULT_AUTOBAN_RULES` always has 4 entries, the heuristic always selects `'multi-column'`.

**Action**: Change the fallback to prefer `'single-column'` unless `automationMode` is explicitly set to `'multi-column'`:
```typescript
automationMode: (['single-column', 'multi-column', 'antigravity-batch'] as const).includes(state?.automationMode as any)
    ? state!.automationMode!
    : 'single-column',
```

**Edge Cases**: Existing multi-column users who have never saved `automationMode` will now default to single-column on next load. This is acceptable because: (a) the mode selector is visible and they can switch back; (b) single-column is the intended default per the issue description.

**File**: `src/webview/kanban.html`
**Location**: Line 5171 — `let currentAutomationMode = 'single-column';`

**Verification**: This is already correct. The JS variable defaults to `'single-column'`. The bug is in the backend normalization, not here. No change needed at this line.

### 2. Add Descriptive Text Under Mode Selector
**File**: `src/webview/kanban.html`
**Location**: After the mode selector row (after line 6214, before the `modeSelect.addEventListener` block)

**Constraint**: Native HTML `<option>` elements do not support subtitles or multi-line content. A `description` field on the option object will not render. Instead, add a help text block below the selector.

**Implementation**: Add a `div` below `modeRow` that displays a description based on the currently selected mode:
```javascript
const modeDescriptions = {
    'single-column': 'Automates a single kanban column transition. Best for simple workflows with one agent role.',
    'multi-column': 'Automates multiple column transitions with per-role terminal pools. Best for full pipeline automation.',
    'antigravity-batch': 'Generates a one-shot batch prompt for Antigravity chat. No continuous automation — run manually as needed.'
};
const modeHelpText = document.createElement('div');
modeHelpText.style.cssText = 'padding:0 8px 8px 8px; font-family:var(--font-mono); font-size:9px; color:var(--text-secondary); line-height:1.4;';
modeHelpText.textContent = modeDescriptions[currentAutomationMode] || '';
container.appendChild(modeHelpText);
```

Update the `modeSelect.addEventListener('change', ...)` callback (line 6216) to also update `modeHelpText.textContent`:
```javascript
modeHelpText.textContent = modeDescriptions[newMode] || '';
```

**Edge Cases**: The help text must update both on user-initiated mode change and on initial load when `autobanConfig` arrives and sets `currentAutomationMode`.

### 3. Restructure Single-Column UI to Match Multi-Column Layout
**File**: `src/webview/kanban.html`
**Location**: Lines 6242-6380 (single-column UI block within `createAutobanPanel()`)

**Current Single-Column UI** (lines 6242-6380):
- Status row
- Interval slider
- Batch size selector
- Clear terminal toggle
- Start/Stop/Reset buttons

**Current Multi-Column UI** (lines 6381-6730):
- Automation Rules section (`db-subsection` + `subsection-header`) — batch size, complexity, routing
- Column Rules section (`db-subsection` + `subsection-header`) — per-column transitions with checkboxes and intervals
- Terminal Pools section (`db-subsection` + `subsection-header`) — per-role terminal pools with add/remove/focus
- Reset row

**Required Single-Column UI**:
- **Automation Rules section**: batch size + complexity (no routing — not relevant for single-column)
- **Column Rules section**: ONE rule for the single column transition (no checkbox, always enabled), with interval input. Label: "CREATED -> COMPLETED"
- **Terminal Pools section**: ONE role's pool (coder by default). Same card layout as multi-column but only one role block.
- **Status row**: Keep at top (same as current)
- **Clear terminal toggle**: Keep (same as current)
- **Start/Stop/Reset buttons**: Keep (same as current)

**Action**:
1. Refactor the single-column UI block (lines 6242-6380) to use `db-subsection` / `subsection-header` sections:

   a. **Automation Rules Section** — Create `automationRulesSection` div with `className='db-subsection'`, add `subsection-header` with text "KANBAN AUTOMATION RULES". Inside, add:
      - Batch size row: Copy the multi-column batch select pattern (lines 6457-6481) but read from `singleColumnConfig.batchSize` and emit via `postKanbanMessage({ type: 'setAutomationMode', mode: 'single-column', ... })`
      - Complexity row: Copy the multi-column complexity select pattern (lines 6483-6513) but store in `singleColumnConfig.complexityFilter` and emit via the same message

   b. **Column Rules Section** — Create `columnRulesSection` div with `className='db-subsection'`, add `subsection-header` with text "COLUMN RULES". Inside, add:
      - Timing explanation text (copy from multi-column line 6557-6559)
      - Single rule row: No checkbox. Label "CREATED -> COMPLETED", "every" text, number input for interval, "min" text. Use `autobanNumberInputStyle` for the input. Apply `guardInteraction()`.

   c. **Terminal Pools Section** — Create `terminalPoolsSection` div with `className='db-subsection'`, add `subsection-header` with text "TERMINAL POOLS". Inside, add:
      - Pools help text (copy from multi-column line 6631-6634)
      - Single role block for `coder` role: Use `getRolePoolEntries('coder')` (move this helper definition to before the mode branch so both modes can use it), render same card layout as multi-column (lines 6636-6728) but only for one role

2. Move shared helper definitions **before** the `if (currentAutomationMode === 'single-column')` branch so both modes can use them:
   - `getAutobanRuleIdSuffix` (line 6398)
   - `resolveTerminalLiveness` (line 6407)
   - `getRolePoolEntries` (line 6419)
   - `autobanSelectStyle` (already defined at line 6170, before the branch — OK)
   - `autobanNumberInputStyle` (already defined at line 6171 — OK)
   - `chipStyle` (already defined at line 6172 — OK)
   - `smallButtonStyle` (already defined at line 6173 — OK)

3. Ensure consistent styling:
   - Use same `.db-subsection` class
   - Use same `.subsection-header` class
   - Use same font sizes, colors, spacing

4. Keep existing controls that don't map to multi-column sections:
   - Status row (top)
   - Clear terminal toggle (after Terminal Pools or in Automation Rules)
   - Start/Stop/Reset buttons (bottom)

### 4. Update State Management
**Files**: `src/services/autobanState.ts`, `src/services/TaskViewerProvider.ts`, `src/webview/kanban.html`

**4a. Extend `SingleColumnAutobanConfig` type** (`autobanState.ts` line 16-20):
```typescript
export type SingleColumnAutobanConfig = {
    enabled: boolean;
    intervalMinutes: number;
    batchSize: number;
    complexityFilter: AutobanComplexityFilter;  // NEW
    terminalPools: Record<string, string[]>;     // NEW
};
```

**4b. Update `DEFAULT_SINGLE_COLUMN_CONFIG`** (`autobanState.ts` line 22-26):
```typescript
export const DEFAULT_SINGLE_COLUMN_CONFIG: SingleColumnAutobanConfig = {
    enabled: false,
    intervalMinutes: 15,
    batchSize: 3,
    complexityFilter: 'all',
    terminalPools: {}
};
```

**4c. Update `normalizeSingleColumnConfig`** (`autobanState.ts` line 28-34):
```typescript
export function normalizeSingleColumnConfig(state?: Partial<SingleColumnAutobanConfig> | null): SingleColumnAutobanConfig {
    return {
        enabled: state?.enabled === true,
        intervalMinutes: Math.max(5, Math.min(60, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 15)),
        batchSize: normalizeAutobanBatchSize(state?.batchSize),
        complexityFilter: (['all', 'low_and_below', 'medium_and_below', 'medium_and_above', 'high_and_above'] as const).includes(state?.complexityFilter as any)
            ? state!.complexityFilter!
            : 'all',
        terminalPools: (typeof state?.terminalPools === 'object' && state!.terminalPools !== null)
            ? Object.fromEntries(Object.entries(state!.terminalPools).map(([k, v]) => [k, Array.isArray(v) ? v.filter(Boolean) : []]))
            : {}
    };
}
```

**4d. Update backend handler** (`TaskViewerProvider.ts` line 5824+):
In `setAutomationModeFromKanban()`, when `newMode === 'single-column'`, read `msg.complexityFilter` and include it in the state update. Also ensure `terminalPools` is preserved from existing state if not provided in the message.

**4e. Update frontend payloads** (`kanban.html`):
All `postKanbanMessage({ type: 'setAutomationMode', mode: 'single-column', ... })` calls in the single-column branch must include `complexityFilter` in the payload.

### 5. Testing Checklist
- [ ] Verify default mode is single-column on fresh load (after `autobanState.ts` fix)
- [ ] Verify descriptive help text appears below mode selector and updates on mode change
- [ ] Verify single-column UI has same visual structure as multi-column (sectioned layout)
- [ ] Verify single-column has Automation Rules section (batch size, complexity)
- [ ] Verify single-column has Column Rules section (single interval, no checkbox)
- [ ] Verify single-column has Terminal Pools section (single coder role)
- [ ] Verify all controls function correctly in single-column mode
- [ ] Verify switching between modes preserves state correctly
- [ ] Verify `emitAutobanState()` now works for Verify multi-column batch/complexity/routing/rule changes persist after panel re-render
- [ ] Verify existing multi-column users are not unexpectedly reset to single-column (check `automationMode` persistence)

## Proposed Changes

### `src/services/autobanState.ts`
- **Context**: Type definitions and normalization for autoban state
- **Logic**: Change default `automationMode` fallback from heuristic to `'single-column'`. Extend `SingleColumnAutobanConfig` with `complexityFilter` and `terminalPools`. Update normalizer.
- **Implementation**: Lines 16-34 (type + defaults + normalizer), lines 235-239 (fallback logic)
- **Edge Cases**: Existing state without `complexityFilter`/`terminalPools` must normalize gracefully (defaults: `'all'` and `{}`)

### `src/services/TaskViewerProvider.ts`
- **Context**: Backend handler for `setAutomationMode` messages from kanban
- **Logic**: Include `complexityFilter` in single-column state updates. Preserve `terminalPools` from existing state.
- **Implementation**: Lines 5835-5859 (`setAutomationModeFromKanban` single-column branch)
- **Edge Cases**: Messages from old frontend (without `complexityFilter`) must not crash — use fallback `'all'`

### `src/webview/kanban.html`
- **Context**: Frontend `createAutobanPanel()` function containing all three mode UIs
- **Logic**: (a) Define `emitAutobanState()`; (b) Add mode help text block; (c) Restructure single-column UI into sectioned layout; (d) Move shared helpers before mode branch; (e) Update `postKanbanMessage` payloads to include `complexityFilter`
- **Implementation**: Lines 6190 (add `emitAutobanState`), 6214 (add help text), 6242-6380 (restructure single-column UI), 6387-6444 (move helpers before branch)
- **Edge Cases**: `guardInteraction()` must be applied to all new interactive elements. `getRolePoolEntries` and `resolveTerminalLiveness` must be accessible from both mode branches.

## Verification Plan

### Automated Tests
- No compilation step (per session constraints)
- No automated test suite run (per session constraints)
- Manual verification via the Testing Checklist in section 5 above

### Manual Verification Steps
1. Open Kanban board → Automation tab → confirm mode selector shows "Switchboard Single Column" and help text is visible
2. Switch to multi-column → confirm sectioned layout appears → change batch size → confirm value persists after tab switch
3. Switch back to single-column → confirm sectioned layout matches multi-column structure
4. Verify single-column Column Rules shows one rule without checkbox
5. Verify single-column Terminal Pools shows coder role pool
6. Close and reopen the board → confirm mode persists as single-column

## Recommendation
**Send to Coder** — Complexity 6: multi-file coordination (3 files) with moderate logic changes, but all changes extend existing patterns. The `emitAutobanState` prerequisite fix and well-defined schema extension as routine.

---

## Review Pass (2026-05-31)

### Stage 1: Grumpy Principal Engineer Review

| # | Severity | Finding | Details |
|---|----------|---------|---------|
| 1 | **CRITICAL** | Terminal pool additions/removals in single-column mode not synced to `_singleColumnAutobanState` | `_createAutobanTerminal` and `_removeAutobanTerminal` only update `this._autobanState.terminalPools`. When `setAutomationModeFromKanban` is next called, it reads stale `this._singleColumnAutobanState.terminalPools` and overwrites the main state, losing user's terminal additions. |
| 2 | **MAJOR** | Single-column `postKanbanMessage` payloads missing `terminalPools` | All 4 single-column `setAutomationMode` payloads include `complexityFilter` but omit `terminalPools`. Backend falls back to stale `_singleColumnAutobanState.terminalPools`. |
| 3 | **MAJOR** | `emitAutobanState()` uses shallow spread `{ ...state }` instead of deep copy | Plan explicitly required deep copy. In practice, `normalizeAutobanConfigState` on the backend creates fresh objects, so risk is theoretical. |
| 4 | **NIT** | `emitAutobanState` doesn't guard against emitting during panel rebuild | Only called from user event handlers, never during rebuild. Low risk. |
| 5 | **NIT** | Single-column min interval floor is 5 vs multi-column's 1 | Intentional per normalizer. |
| 6 | **PASS** | `emitAutobanState()` defined | Line 6192-6194, correctly posts `updateAutobanConfig` message. |
| 7 | **PASS** | Default mode fallback fixed | `autobanState.ts` line 245-247, now defaults to `'single-column'`. |
| 8 | **PASS** | Mode help text added | Lines 6220-6228, updates on mode change (line 6239). |
| 9 | **PASS** | Single-column UI restructured into sectioned layout | Automation Rules, Column Rules, Terminal Pools sections all present with `db-subsection`/`subsection-header`. |
| 10 | **PASS** | Shared helpers moved before mode branch | `getAutobanRuleIdSuffix`, `resolveTerminalLiveness`, `getRolePoolEntries` at lines 6257-6294. |
| 11 | **PASS** | `SingleColumnAutobanConfig` type extended | `complexityFilter` and `terminalPools` added (lines 16-22). |
| 12 | **PASS** | `normalizeSingleColumnConfig` updated | Handles new fields with proper defaults (lines 32-43). |
| 13 | **PASS** | Backend handler updated | `setAutomationModeFromKanban` reads `complexityFilter` and `terminalPools` from message (lines 5847-5848). |
| 14 | **PASS** | `guardInteraction()` applied to all new interactive elements | Batch select, complexity select, interval input all guarded. |

### Stage 2: Balanced Synthesis

| # | Severity | Action | Rationale |
|---|----------|--------|-----------|
| 1 | CRITICAL | **Fix now** | Terminal pool data loss on config change in single-column mode. |
| 2 | MAJOR | **Fix now** | Payloads must include `terminalPools` for backend to receive current data. |
| 3 | MAJOR | **Defer** | Shallow spread is safe in practice due to backend normalization. Mark as known risk. |
| 4 | NIT | **Defer** | No practical impact. |
| 5 | NIT | **Keep** | Intentional design choice. |

### Code Fixes Applied

#### Fix #1 (CRITICAL): Sync terminalPools to `_singleColumnAutobanState`
**File**: `src/services/TaskViewerProvider.ts`
**Change**: Added `_syncSingleColumnTerminalPools()` private method (after line 5718) that copies `this._autobanState.terminalPools` into `this._singleColumnAutobanState.terminalPools` when in single-column mode, and persists via `workspaceState.update`. Called after `_createAutobanTerminal` (line 5697), `_removeAutobanTerminal` (line 5716), and `_resetAutobanPools` (line 5764).

#### Fix #2 (MAJOR): Add `terminalPools` to single-column payloads
**File**: `src/webview/kanban.html`
**Change**: Added `terminalPools: singleColumnConfig.terminalPools` to all 4 single-column `setAutomationMode` payloads:
- Batch size change handler (line 6347)
- Complexity change handler (line 6385)
- Interval change handler (line 6438)
- START button handler (line 6602)

### Validation Results

- **Compilation**: Skipped per session constraints
- **Automated tests**: Skipped per session constraints
- **Manual verification**: All plan requirements verified by code inspection:
  - [x] Requirement 0: `emitAutobanState()` defined and functional
  - [x] Requirement 1: Default mode fallback changed to `'single-column'`
  - [x] Requirement 2: Mode help text added and updates on change
  - [x] Requirement 3: Single-column UI restructured with sectioned layout
  - [x] Requirement 4a-4e: State management updated across all 3 files
  - [x] Fix #1: Terminal pool sync added to backend
  - [x] Fix #2: Terminal pools included in frontend payloads

### Remaining Risks

1. **Shallow spread in `emitAutobanState()`** (deferred MAJOR): The `{ ...state }` spread does not deep-copy nested objects. In practice, `normalizeAutobanConfigState` on the backend creates fresh objects for all nested fields, so the risk of reference mutation is theoretical. If the backend ever changes to in-place mutation, this would become a real bug.
2. **Existing multi-column users without saved `automationMode`**: Will default to single-column on next load. They can switch back via the mode selector. This is the intended behavior per the plan.
3. **`getRolePoolEntries` reads from `state.terminalPools`** (multi-column state) in single-column mode: This works because `setAutomationModeFromKanban` copies single-column `terminalPools` into the main state, and `_syncSingleColumnTerminalPools` keeps them in sync. But it's an indirect dependency that could break if the sync logic is removed in the future.
