# Batch-to-team-head cap disclosed only after click — no pre-click "SEND N OF 12" label

## Goal

The batch-to-a-team-head cap (TEAM_BATCH_PLAN_CAP = 5) is still disclosed only after the click. The plan's first line of defence — a control label reading "SEND 5 OF 12" — is not built. Two gaps prevent it:

1. **`Move All` is an icon-only button** (kanban.html:8121). It has no text label, so there's no surface to render "SEND 5 OF 12" on. The button is a single icon with a tooltip.

2. **Board state carries no team-headness for the drop target.** The webview's `moveAll` handler (kanban.html:8290–8312) sends `{ type: 'moveAll', column: backendColumn }` with no information about whether the target column's role is a team head. The cap logic lives in the backend (`handleKanbanBatchTrigger` → `selectTeamBatchPlans`), which is too late for a pre-click label.

**Root cause:** The cap was implemented as a backend safety net (in `handleKanbanBatchTrigger` and `generateUnifiedPrompt`), but the pre-click UX was never scoped. The board state doesn't include team-headness metadata for columns, and the `Move All` button was designed as an icon-only control with no text slot.

## Metadata

**Complexity:** 6
**Tags:** frontend, ui, backend
**Project:** Browser Switchboard

## User Review Required

No user decision needed. The design choice (server-side metadata + webview-rendered label) is resolved in the architecture review. One open question: whether to extend the cap label to the Move Selected button or document the asymmetry — resolved below (extend it).

## Complexity Audit

### Routine
- The cap value (5) and the column's plan count are both available in the webview.
- The `moveAll` handler already reads `getAllInColumn(column)` to get the IDs.
- The `updateBoard` message (KanbanProvider.ts:4186) is the existing payload path — adding fields is a small edit.
- Column definitions already carry a `role` field (agentConfig.ts:121–132), sent via `updateColumns`.

### Complex / Risky
- **Team-headness in board state:** The webview needs to know whether the target column's dispatch role is a team head BEFORE the click. This requires the extension host sending team-headness metadata in the board state payload. The webview cannot infer it from `codingHeadLive` (that just means a lead terminal exists, not that it heads a team).
- **Column-to-role mapping:** The board state includes column definitions via `updateColumns` (with `role` field), but `role === 'lead'` alone is insufficient — `isCodingTeamHead` checks whether the configured lead agent actually heads a registered team (a DB lookup via `resolveTeamMembersForHead`).
- **Dynamic label:** The label "SEND 5 OF 12" must update when plans are added/removed from the column. The label re-renders on every `updateBoard` message (board refresh). Optimistic card moves (drag-and-drop) do not trigger a full refresh — the label is stale until the next `updateBoard`. This is acceptable for a pre-click advisory label.
- **Move Selected path:** The `moveSelected` button (line 8118) has the same problem — a selected subset could also exceed the cap. The label must cover both paths: Move All shows the column total vs. cap; Move Selected shows the selection count vs. cap when selection exceeds cap.

## Edge-Case & Dependency Audit

- **Board state payload:** The `updateBoard` message (line 4186) sends `cards`, `dbUnavailable`, `showingBacklog`, `dispatchAnalyzeAvailable`, `coderTerminalCount`, `codingHeadLive`, `anyCodingTerminalLive`, `routingConfig`, `featureWorktrees`. Add `teamHeadColumns: string[]` and `teamBatchPlanCap: number` to this payload.
- **Column role resolution:** `isCodingTeamHead` is called per column with `role === 'lead'`, no terminal name. It falls back to `_getAgentNames(workspaceRoot)` to resolve the configured lead agent name. Multiple lead columns (LEAD CODED + custom lead columns) all resolve to the same agent name and thus the same team-headness — this is correct, they all dispatch to the same terminal.
- **Performance:** `isCodingTeamHead` is called once per lead column (typically 1–2) per board refresh. Each call does a single config read (`resolveTeamMembersForHead`). Negligible compared to existing `_refreshBoardImpl` work. No caching needed.
- **Non-team columns:** Columns whose role is not 'lead' or whose lead is not a team head show no cap label — the button stays icon-only.
- **STAGING column:** STAGING has its own queue semantics. The cap label should not appear on STAGING (STAGING has `kind: 'staging'`, not `role: 'lead'`).
- **Empty columns:** If a column has 0 plans, no label is needed (count is under cap).
- **`TEAM_BATCH_PLAN_CAP` sourcing:** Must be sent from the backend in the `updateBoard` payload. Do NOT hardcode it in the webview — it's an exported constant from `agentPromptBuilder.ts` that could change.
- **Attribute selector safety:** Column IDs like "PLAN REVIEWED" contain spaces. The querySelector `[data-column="${col}"]` handles this correctly because attribute values are quoted. Column IDs are uppercase constants with no double quotes, so this is safe.

## Dependencies

- **Subtask 1 (dispatch means):** No code dependency — this subtask touches the board state payload (`_refreshBoardImpl`) and the webview (`kanban.html`), while subtask 1 touches `generateUnifiedPrompt`'s gate. They can land independently. However, both touch `KanbanProvider.ts`, so merge order matters: land subtask 1 first (it adds methods), then this subtask (it adds fields to the board state payload).

## Adversarial Synthesis

Key risks: (1) `TEAM_BATCH_PLAN_CAP` hardcoded in the webview would drift from the backend constant — mitigate by always sending it in the `updateBoard` payload. (2) The `moveSelected` button is uncapped — a user selecting 8 plans and clicking Move Selected sends 8 with no cap while Move All says "SEND 5 OF 12" — mitigate by extending the label to Move Selected. (3) The label is stale during optimistic card moves (drag-and-drop) — acceptable for a pre-click advisory; updates on next `updateBoard`.

## Proposed Changes

### 1. Add team-headness and cap to board state (src/services/KanbanProvider.ts:4186–4197)

In `_refreshBoardImpl`, after resolving `visibleAgents` and before the `updateBoard` postMessage, resolve team-head columns:

```typescript
// Resolve which columns have a team-head dispatch target.
// isCodingTeamHead falls back to _getAgentNames for the agent name —
// same path as prompt previews. Called once per lead column (1-2 typically).
const teamHeadColumns: string[] = [];
for (const col of filteredColumns) {
    if (col.role === 'lead') {
        const isHead = await this.isCodingTeamHead(resolvedWorkspaceRoot, 'lead');
        if (isHead) teamHeadColumns.push(col.id);
    }
}
```

Include in the `updateBoard` payload:

```typescript
this.postMessage((scope: string | null | undefined) => ({
    type: 'updateBoard',
    cards,
    dbUnavailable,
    showingBacklog: this._showingBacklog,
    dispatchAnalyzeAvailable: true,
    coderTerminalCount,
    codingHeadLive,
    anyCodingTerminalLive,
    routingConfig: this._routingMapForScope(scope),
    featureWorktrees,
    teamHeadColumns,           // NEW
    teamBatchPlanCap: TEAM_BATCH_PLAN_CAP  // NEW
}));
```

`TEAM_BATCH_PLAN_CAP` is already imported at line 25.

### 2. Render the cap label on the Move All button (src/webview/kanban.html:8117–8123)

Replace the icon-only Move All button with a conditional label. The webview reads `teamHeadColumns` and `teamBatchPlanCap` from the `updateBoard` message:

```javascript
const isTeamHeadCol = boardState.teamHeadColumns?.includes(def.id) ?? false;
const colCount = getAllInColumn(def.id).length;
const cap = boardState.teamBatchPlanCap ?? 5;
const moveAllLabel = isTeamHeadCol && colCount > cap
    ? `SEND ${Math.min(cap, colCount)} OF ${colCount}`
    : '';
const moveAllBtn = moveAllLabel
    ? `<button class="column-icon-btn column-icon-btn-labeled" data-action="moveAll" data-column="${escapeAttr(def.id)}" data-tooltip="Move all plans in this column to next stage (cap: ${cap} for team head)">
        <img src="${ICON_MOVE_ALL}" alt="Move All">
        <span class="cap-label">${moveAllLabel}</span>
       </button>`
    : `<button class="column-icon-btn" data-action="moveAll" data-column="${escapeAttr(def.id)}" data-tooltip="Move all plans in this column to next stage">
        <img src="${ICON_MOVE_ALL}" alt="Move All">
       </button>`;
```

Replace the existing Move All button in the `pipelineButtons` template (line 8121) with `moveAllBtn`.

### 3. Render the cap label on the Move Selected button (src/webview/kanban.html:8118)

When the selection count on a team-head column exceeds the cap, show a label on Move Selected too:

```javascript
const selectedCount = [...selectedCards].filter(id => {
    const card = document.querySelector(`[data-card-id="${id}"]`);
    return card?.closest(`[data-column="${def.id}"]`);
}).length;
const moveSelectedLabel = isTeamHeadCol && selectedCount > cap
    ? `SEND ${Math.min(cap, selectedCount)} OF ${selectedCount}`
    : '';
```

Apply the same labeled/unlabeled pattern to the Move Selected button.

### 4. Add CSS for the labeled button variant

```css
.column-icon-btn-labeled {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 2px 6px;
}
.column-icon-btn-labeled .cap-label {
    font-size: 9px;
    font-weight: 600;
    color: var(--vscode-editorWarning-foreground, #cca700);
    white-space: nowrap;
}
```

### 5. Update the label on board refresh

The label is rendered in the column template (step 2), which is rebuilt on every `updateBoard` message. No separate `updateCapLabels()` function is needed — the template already reads `boardState.teamHeadColumns` and `getAllInColumn(def.id).length` at render time. The label is stale during optimistic card moves (drag-and-drop) but updates on the next `updateBoard` refresh. This is acceptable for a pre-click advisory label.

### 6. Store `teamHeadColumns` and `teamBatchPlanCap` in the webview's board state

In the webview's `updateBoard` message handler, store the new fields:

```javascript
case 'updateBoard':
    // ... existing field assignments ...
    boardState.teamHeadColumns = msg.teamHeadColumns ?? [];
    boardState.teamBatchPlanCap = msg.teamBatchPlanCap ?? 5;
    break;
```

## Verification Plan

### Automated Tests

1. **Unit test:** Assert `boardState.teamHeadColumns` is populated correctly for a workspace with a team-headed lead (contains 'LEAD CODED').
2. **Unit test:** Assert `boardState.teamHeadColumns` is empty for a workspace with no team.
3. **Unit test:** Assert `boardState.teamBatchPlanCap` equals `TEAM_BATCH_PLAN_CAP` (5).

### Manual Tests

4. **Manual test:** A column with 12 plans whose role is a team head — assert the Move All button shows "SEND 5 OF 12".
5. **Manual test:** A column with 3 plans whose role is a team head — assert no cap label (under the cap).
6. **Manual test:** A column with 12 plans whose role is NOT a team head — assert no cap label (icon-only button).
7. **Manual test:** Add a plan to a team-head column — assert the label updates on next board refresh.
8. **Manual test:** Remove a plan from a team-head column — assert the label updates or disappears on next board refresh.
9. **Manual test:** Select 8 plans in a team-head column — assert Move Selected shows "SEND 5 OF 8".
10. **Manual test:** Click Move All on a team-head column with 12 plans — assert the backend caps at 5 (only 5 cards move, 7 remain).

### Goal Invariants

- **Positive:** `updateBoard` payload contains `teamHeadColumns` array and `teamBatchPlanCap` number when a team-headed lead is configured.
- **Negative:** `updateBoard` payload does NOT contain `teamHeadColumns` for columns whose role is not 'lead'.
- **Positive:** Move All button HTML on a team-head column with count > cap contains a `<span class="cap-label">` element with text matching `SEND \d+ OF \d+`.
- **Negative:** Move All button HTML on a non-team-head column does NOT contain a `cap-label` span.
- **Positive:** `teamBatchPlanCap` in the `updateBoard` payload equals the exported `TEAM_BATCH_PLAN_CAP` constant from `agentPromptBuilder.ts`.

## Implementation Summary

Added `teamHeadColumns` and `teamBatchPlanCap` resolution and delivery across all board refresh paths in `KanbanProvider.ts` (`_refreshBoardImpl`, `refreshWithData`, `_refreshBoardWithData`, and `_buildResyncMessages`). In `kanban.html`, added styled `.column-icon-btn-labeled` UI support and dynamic `updateCapLabels()` logic to render pre-click "SEND N OF M" labels on Move All and Move Selected buttons whenever plans in a team-head column exceed the batch cap (`TEAM_BATCH_PLAN_CAP` = 5). Added contract tests covering team-head column resolution, non-team empty state, cap constant assertion, and webview HTML contract validation.
