# Add separate column for coder and lead coder

coder and lead coder should be two separate columns rather than controlled by a dropdown. the dorpdown is confusing because you  can't see which agent you sent the plan to. 

## Goal
Replace the single "Coded" column (which uses a Lead/Coder dropdown selector) with two distinct columns: **"Lead Coder"** and **"Coder"**. Each column routes to its respective agent. The user can see at a glance which agent a plan was dispatched to by which column it lands in.

## Source Analysis

**Column definitions** in `src/services/agentConfig.ts` (line 30–35):
```ts
const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
    { id: 'CREATED', label: 'New', order: 0, kind: 'created', autobanEnabled: true },
    { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', autobanEnabled: true },
    { id: 'CODED', label: 'Coded', role: 'coder', order: 200, kind: 'coded', autobanEnabled: true },
    { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', autobanEnabled: false },
];
```
The `CODED` column currently has a single role `'coder'` with a runtime override via `_codedColumnTarget`.

**Dropdown in kanban.html** (line ~604–608):
```html
<select id="coded-target-select" class="column-select">
    <option value="lead">Lead Coder</option>
    <option value="coder">Coder</option>
</select>
```
This dropdown switches `currentCodedTarget` which `columnToRole()` uses to decide dispatch routing.

**`_codedColumnTarget`** in `KanbanProvider.ts` (line 40, 52): persisted via `workspaceState.get('kanban.codedTarget')`. Used by autoban engine's `_autobanColumnToRole()` in TaskViewerProvider.ts (~line 1186–1189).

**Column derivation** in `kanbanColumnDerivation.ts`/`.js`: maps events to column IDs. Currently maps to `'CODED'` — would need new event names or column IDs.

**DB schema** in `KanbanDatabase.ts` (line 44): `kanban_column TEXT NOT NULL DEFAULT 'CREATED'` — stores column as a string. Adding new column IDs is backward-compatible.

## Proposed Changes

### Step 1: Add two new columns, remove CODED (Complex)
**File:** `src/services/agentConfig.ts`
- Replace the single `CODED` entry with:
  ```ts
  { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 190, kind: 'coded', autobanEnabled: true },
  { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 200, kind: 'coded', autobanEnabled: true },
  ```
- Remove or deprecate the `CODED` ID.

### Step 2: Update column derivation logic (Complex)
**File:** `src/services/kanbanColumnDerivation.js`
- When events indicate dispatch to `lead` role → derive column as `'LEAD CODED'`.
- When events indicate dispatch to `coder` role → derive column as `'CODER CODED'`.
- For backward compatibility: existing events with just `'CODED'` should map to `'LEAD CODED'` (the previous default was lead).

### Step 3: Remove the dropdown from kanban.html (Routine)
**File:** `src/webview/kanban.html`
- Remove the `coded-target-select` dropdown (~lines 604–608).
- Remove `currentCodedTarget` variable and `columnToRole()` override logic.
- Each column now has its own role natively from `columnDefinitions`.

### Step 4: Update KanbanProvider routing (Moderate)
**File:** `src/services/KanbanProvider.ts`
- Remove `_codedColumnTarget` property and all references to `kanban.codedTarget` workspace state.
- Remove `getCodedColumnTarget()` method.
- Update `_handleMessage()` to remove `setColumnTarget` case.
- In `_refreshBoard()`, remove the `updateTarget` message.

### Step 5: Update autoban engine routing (Moderate)
**File:** `src/services/TaskViewerProvider.ts`
- `_autobanColumnToRole()` (~line 1179): add cases for `'LEAD CODED'` → `'lead'` and `'CODER CODED'` → `'coder'`.
- Remove the `_codedColumnTarget` fallback logic.
- The dynamic complexity routing in `_autobanTickColumn()` (~line 1307) already splits into `lowSessions` (coder) and `highSessions` (lead) — but it currently only processes `'PLAN REVIEWED'` source column. This logic may need adjustment since the target columns are now split.

### Step 6: DB migration for existing CODED cards (Moderate)
**File:** `src/services/KanbanMigration.ts`
- Add migration v2: for all plans with `kanban_column = 'CODED'`, remap to `'LEAD CODED'` (or use the plan's last dispatch event to determine which column).
- Bump `SCHEMA_VERSION` to 2.

### Step 7: Update MCP tool kanban state reader (Routine)
**File:** `src/mcp-server/register-tools.js`
- In `readKanbanStateFromDb()` (~line 353), add `'LEAD CODED'` and `'CODER CODED'` to the columns object initialization.

## Dependencies
- **Plan 3 (autoban send limits):** Both modify autoban routing. Plan 3 adds terminal pools; this plan changes column structure. Implement this plan first, then Plan 3 adapts to the new column IDs.
- **Plan 6 (backwards move):** Backward move logic uses column index ordering — adding a column changes indices. Must verify backward move still works.
- **Plan 10 (column ordering):** Adds sorting to PLAN REVIEWED. Independent but both touch column rendering.

## Verification Plan
1. Open kanban board — confirm 5 columns: New, Planned, Lead Coder, Coder, Reviewed.
2. Drag a card from Planned to Lead Coder column → confirm dispatch to lead agent.
3. Drag a card from Planned to Coder column → confirm dispatch to coder agent.
4. No dropdown should appear anywhere.
5. Enable autoban — confirm PLAN REVIEWED cards route correctly (high → Lead Coder, low → Coder).
6. Existing CODED cards from DB should appear in Lead Coder column after migration.
7. Run `npm run compile`.

## Complexity Audit

### Band A (Routine)
- Removing dropdown from kanban.html (~15 lines deleted).
- Removing `_codedColumnTarget` from KanbanProvider (~10 lines).
- MCP tool column list update (~2 lines).

### Band B (Complex/Risky)
- Column derivation logic rewrite — must handle legacy events that reference `'CODED'` without a role qualifier.
- DB migration for existing `CODED` rows — must be idempotent and handle both file-based and DB-based boards.
- Autoban engine routing rework — the dynamic complexity routing logic currently operates on `'PLAN REVIEWED'` as the source column but must now produce two distinct target columns.
- Backward compatibility: any external tools or MCP consumers that reference `'CODED'` will break.

## Adversarial Review

### Grumpy Critique
- "This is a breaking change to the column schema. Every consumer of column IDs (MCP, DB, events, derivation) must be updated." → Valid. This is the biggest risk — a missed reference means cards silently disappear.
- "The autoban complexity routing already splits by role. Now it also has to route to different *columns*. You're complicating dispatch logic." → Valid but unavoidable. The routing needs to produce the right column ID for the event log.
- "What about custom agents with `includeInKanban: true`? They insert columns dynamically. Does this break the ordering?" → Verify that `buildKanbanColumns()` still produces correct sort order with the two new columns.
- "DB migration: what if the user has no DB yet? Is that path handled?" → Yes — `bootstrapIfNeeded()` creates from scratch, so new installs get the new column IDs. Migration only matters for existing DBs.

### Balanced Synthesis
- This is a justified breaking change — the dropdown UX is genuinely confusing.
- Create a checklist of every file that references `'CODED'` and update them all. Use grep for `'CODED'` and `CODED` across the codebase.
- The DB migration should be conservative: default existing `CODED` → `LEAD CODED` and let the user manually re-sort if needed.
- Test with custom agents enabled to verify column ordering doesn't break.

## Agent Recommendation
Send it to the **Lead Coder** — this is an architectural change affecting column definitions, event derivation, DB schema, autoban routing, and the MCP tool. Multiple files, cross-cutting concerns, and backward compatibility risk.
