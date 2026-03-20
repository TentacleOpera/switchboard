# change kanban headers

## Notebook Plan

The kanban headers should be simplified to match actions. ensure all backend references match the columns so there is no frontend-backend breakage.

Plan created - change to NEW
Plan reviewed - change to PLANNED
Code reviewed - change to REVIEWED

## Goal
- Rename the **display labels** of three kanban columns:
  - "Plan Created" → **"New"**
  - "Plan Reviewed" → **"Planned"**
  - "Code Reviewed" → **"Reviewed"**
- The internal column **IDs** (`CREATED`, `PLAN REVIEWED`, `CODE REVIEWED`) must remain unchanged to avoid breaking runsheet event derivation, the SQLite database `kanban_column` values, MCP tools, and autoban routing.
- Only the `label` field in column definitions and the frontend display text change.

## Dependencies
- **No blocking dependencies.** This is a label-only change. All other kanban plans reference column IDs (e.g. `'CREATED'`, `'PLAN REVIEWED'`), not display labels.
- **Potential conflict with "Change kanban header"** (sess_1773612759813) — that plan changes the board title/subtitle text. No overlap with column labels.

## Proposed Changes

### Step 1 — Update DEFAULT_KANBAN_COLUMNS labels in agentConfig.ts (Routine)
- **File**: `src/services/agentConfig.ts`
- **Lines 30-35**: Change the `label` values in the `DEFAULT_KANBAN_COLUMNS` array:
  ```ts
  // Before:
  { id: 'CREATED', label: 'Plan Created', order: 0, kind: 'created', autobanEnabled: true },
  { id: 'PLAN REVIEWED', label: 'Plan Reviewed', role: 'planner', order: 100, kind: 'review', autobanEnabled: true },
  { id: 'CODE REVIEWED', label: 'Code Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', autobanEnabled: false }
  
  // After:
  { id: 'CREATED', label: 'New', order: 0, kind: 'created', autobanEnabled: true },
  { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', autobanEnabled: true },
  { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', autobanEnabled: false }
  ```
- The `CODED` column label stays as "Coded" (not mentioned in the plan).

### Step 2 — Update fallback column definitions in kanban.html (Routine)
- **File**: `src/webview/kanban.html`
- **Lines 393-398**: Update the hardcoded fallback `columnDefinitions` array to match:
  ```js
  { id: 'CREATED', label: 'New', role: null, autobanEnabled: true },
  { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', autobanEnabled: true },
  { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', autobanEnabled: false }
  ```
- Note: these fallbacks are overridden by the `updateColumns` message from the backend, but they must stay consistent for the brief render before the backend pushes data.

### Step 3 — Verify no other hardcoded label references (Routine)
- Search the entire codebase for the old label strings `"Plan Created"`, `"Plan Reviewed"`, and `"Code Reviewed"` (case-sensitive).
- Expected hits: only the two files above. If any other files use these strings for display, update them.
- **Important**: Do NOT search for/change the column IDs (`CREATED`, `PLAN REVIEWED`, `CODE REVIEWED`) — those must remain as-is.

### Step 4 — Verify MCP tool output is unaffected (Routine)
- **File**: `src/mcp-server/register-tools.js`
- The `get_kanban_state` MCP tool returns column IDs (e.g. `"CREATED"`, `"PLAN REVIEWED"`), not labels. Confirm this is still the case after changes — no action needed unless labels leaked into MCP output.

## Verification Plan
1. `npm run compile` — no build errors.
2. `grep -r "Plan Created\|Plan Reviewed\|Code Reviewed" src/` — confirm zero hits (all replaced).
3. `grep -r "'CREATED'\|'PLAN REVIEWED'\|'CODE REVIEWED'" src/` — confirm these ID strings are **unchanged**.
4. Open kanban board → column headers display "New", "Planned", "Coded", "Reviewed".
5. Drag a card between columns → verify agent triggers still fire correctly (IDs unchanged).
6. Call `get_kanban_state` MCP tool → verify output still uses column ID keys (`CREATED`, `PLAN REVIEWED`, etc.), not labels.
7. Autoban → verify column routing still works (uses IDs internally).

## Complexity Audit

### Band A — Routine
- Change 3 label strings in `agentConfig.ts`
- Change 3 label strings in `kanban.html` fallback
- Grep verification

### Band B — Complex / Risky
- None

**Recommendation**: Send it to the **Coder agent** — pure string label replacements with grep verification.
