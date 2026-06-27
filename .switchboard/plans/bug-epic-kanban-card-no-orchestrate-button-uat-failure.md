# UAT Failure: Epic Kanban Board Cards Have No Orchestrate Button and ORCHESTRATING Column Never Appears

## Goal

Three plans were implemented and code-reviewed targeting epic orchestration UX:

1. **`epic-only-orchestrator-board-column`** — added the `ORCHESTRATING` column to `agentConfig.ts` with `epicOnly: true`, `hideWhenNoAgent: true`, and all three guard layers (visibility filter, auto-advance skip, DB move reject, webview drop reject).
2. **`orchestrate_column_not_visible_epics`** — added the `markEpicOrchestrating` teleport helper and wired it into `PlanningPanelProvider`'s `case 'orchestrateEpic'` for both `'send'` and `'copy'` modes.
3. **`per-card-epic-action-buttons`** — added per-card action buttons (Copy Link, Copy Planning Prompt, Send to Planner) to epic cards **in the Epics tab** (`project.js` / `project.html`).

**UAT failure:** The ORCHESTRATING column never appears on the kanban board, and epic cards on the kanban board have no Orchestrate button.

### Problem Analysis & Root Cause

The three plans above collectively omitted one critical piece: **an Orchestrate button on kanban board epic cards** in `kanban.html`'s `createCardHtml`.

The entry points that currently exist:
- **Epics tab meta-bar** — `requestEpicOrchestration('copy')` at `project.js:1647`. Routes to `case 'orchestrateEpic'` in `PlanningPanelProvider.ts`, which does call `markEpicOrchestrating`. This path *should* work.
- **Epics tab overlay "Send to Orchestrator"** — `requestEpicOrchestration('send')` at `project.js:1804`. Routes through `dispatchEpicOrchestration`, which also calls `markEpicOrchestrating`. This path *should* work.

**What does NOT exist:**
- Any Orchestrate button on **kanban board epic cards** (`kanban.html` `createCardHtml`, lines ~5311–5347). Kanban board epic cards only render: EPIC badge / worktree chip / review / complete. There is no Orchestrate button.

The result: a user on the kanban board cannot orchestrate an epic from the board at all. The `markEpicOrchestrating` teleport and the ORCHESTRATING column are correctly implemented in the backend — but the kanban board has no button to fire the entry point, so the column never gets an occupant, and therefore never becomes visible.

**Secondary question to investigate before coding:** Does the Epics tab meta-bar Orchestrate button currently produce a visible ORCHESTRATING column? The code path looks correct, but UAT reported the column as non-appearing. The implementer should test the Epics tab path first and confirm whether we have one problem (missing kanban button only) or two (missing kanban button + silent failure in the Epics tab path). The `markEpicOrchestrating` helper has `console.warn` on failure — check the extension host output for any silent teleport failure on the Epics tab path.

## Metadata

**Complexity:** 4
**Tags:** frontend, backend, bugfix, ui, ux

## Open Questions

Before coding, the implementer must answer: does the Epics tab meta-bar Orchestrate button (`project.js:1647`, mode `'copy'`) currently produce a visible ORCHESTRATING column? Test this first. This determines whether we have one problem (missing kanban button) or two (missing kanban button + broken Epics tab teleport).

## Proposed Changes

### `src/webview/kanban.html` — Add Orchestrate button to epic card HTML

In `createCardHtml` (lines ~5311–5347), epic cards render a footer with the EPIC badge, review button, complete button, and optionally a worktree chip. Add an **Orchestrate** button to this footer, visible only when `card.isEpic`.

Requirements:
- Label: "Orchestrate" (or "🎯 Orchestrate").
- Must `stopPropagation` to avoid triggering card selection on click.
- On click, post: `{ type: 'orchestrateEpic', sessionId: card.sessionId || card.planId, workspaceRoot: card.workspaceRoot, mode: 'copy' }` — identical to the Epics tab meta-bar message.
- Provide click feedback (e.g. button text changes to "Copied!" for 2s via a local timeout keyed on the `orchestrateEpicResult` or `kanbanPlanPromptCopied` response, or a simple local `setTimeout`). Do not use a pre-response optimistic text mutation that races with the backend response.
- The `case 'orchestrateEpic'` handler in `PlanningPanelProvider.ts` already calls `markEpicOrchestrating` for `mode === 'copy'`. **No backend change is needed** — wiring the button to post the same message is sufficient for the teleport to fire.

### Verify and fix (if needed): Epics tab path

If the Epics tab meta-bar Orchestrate button is also broken (column not appearing despite the code path looking correct), investigate:
- Does `getPlanByPlanId(epicSessionId)` return the epic? (Check `plan_id` vs `session_id` if there is a resolution mismatch.)
- Is the `markEpicOrchestrating` call actually reached, or does the copy branch early-return before it?
- Check extension host console for any `[KanbanProvider] markEpicOrchestrating: ...` warn lines.

### No changes required to

- `agentConfig.ts` — `ORCHESTRATING` column definition is correct and complete.
- `KanbanProvider.ts` `markEpicOrchestrating` — implementation verified correct in code review.
- `KanbanProvider.ts` `_filterDynamicColumns` — occupancy-based visibility correctly implemented.
- `PlanningPanelProvider.ts` `case 'orchestrateEpic'` — both `'copy'` and `'send'` branches call `markEpicOrchestrating` (verified in code reviewer table).

## Verification Plan

### Manual Verification

1. **Kanban board epic card:** Open the kanban board. Confirm an epic card has an Orchestrate button in its footer.
2. **Copy path from kanban board:** Click Orchestrate on a kanban board epic card. Confirm: (a) orchestrator prompt is copied to clipboard, and (b) the epic moves into the ORCHESTRATING column, which becomes visible on the board.
3. **Epics tab path:** Click Orchestrate from the Epics tab meta-bar. Confirm the same outcome — epic in ORCHESTRATING, column visible.
4. **Column hides when empty:** Move or advance the epic out of ORCHESTRATING. Confirm the column disappears.
5. **Non-epics unaffected:** Confirm regular plan cards on the kanban board have no Orchestrate button.
6. **Send path:** Use "Send to Orchestrator" from the Epics tab overlay. Confirm the epic lands in ORCHESTRATING.
7. **Idempotency:** With an epic already in ORCHESTRATING, click Orchestrate again. Confirm no duplicate integration sync fires and no board flicker.
