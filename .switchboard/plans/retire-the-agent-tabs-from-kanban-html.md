# Retire the agent tabs from kanban.html

## Goal

After `agent-control.html` has run a week without defects, delete the Agents, Teams and Prompts tabs from `kanban.html` along with the whole `data-view="agent-control"` projection, leaving one implementation of each tab and a board file that only renders the board.

### Problem Analysis

This is the second half of the extraction. Once `extract-agent-control-into-its-own-panel-file.md` ships, the three tabs exist twice: in the new panel, and in `kanban.html` behind the `data-view` projection. Dual-run is deliberate — it gives a fallback while the new panel is exercised — but it is not a resting state. Two copies of a tab is how the two diverge.

**What comes out, once the gate is met:**

| Site | What it is |
|---|---|
| `kanban.html:2913` | the negative-selector tab filter (`:not([data-tab="agents"])…`) |
| `kanban.html:2914-2918` | the five `display: none !important` content-pane rules |
| `kanban.html:2909-2918` | the whole `Agent Control view (opt-in…)` CSS block |
| `kanban.html:2940-2942` | the three tab buttons |
| `kanban.html:3187-3864` | the three content panes (~677 lines) |
| `kanban.html:6526`, `:6533` | the `AGENT_CONTROL_VIEW` opt-in constant and its comment |
| `kanban.html:6563-6567` | the Agent-Control initial-tab resolver |
| `KanbanProvider.ts:13633` | the `viewAttr` / `data-view` injection |
| `KanbanProvider.ts:13591` | the `viewMarker?: 'agent-control'` parameter, if no other caller needs it |

Plus whatever the extraction's shared modules made redundant on the board side.

**What stays.** `_handleMessage(msg, source?: 'agent-control')` (`KanbanProvider.ts:8960-8963`) stays — the new panel still identifies itself as that source. The manifest entry, route, icon and label stay, because they were always panel identity rather than projection machinery. `_agentControlPanel` and its full-state push (`:1407-1429`) stay: it is the panel's webview, not the projection.

### Root Cause

Nothing here is a mistake to fix; it is scaffolding that has served its purpose. Recording it as its own plan exists to stop the dual-run becoming permanent — the same way the `data-view` projection became permanent by being useful.

## Metadata

**Complexity:** 3
**Tags:** frontend, refactor, ui

## User Review Required

- **The gate is yours to call.** "A week of UAT with no bugs" needs a decision on what counts: a week of the new panel being the way you actually open Agent Control, with no defect attributed to it. If a defect appears, the clock restarts rather than the deletion proceeding with a known issue.
- Confirm no workflow depends on reaching these tabs from inside the board view. After this, Agents/Teams/Prompts exist only at `/agent-control` — which is the intent, but it is a habit change if you currently reach them from the board's tab strip.

## Complexity Audit

### Routine

- Deleting the rows in the table above.
- Re-running the board's own tests, which should be unaffected.

### Complex / Risky

- **Deleting the fallback is the irreversible step**, and it is the reason this is a separate plan rather than a follow-up commit. Until now a defect in the new panel could be worked around by using the board's copy; after this there is no second implementation. The gate is the mitigation, so it must be met rather than assumed.
- **`viewMarker` may have other callers.** `_getHtml(webview, viewMarker?: 'agent-control')` (`:13591`) is a general parameter. Check every caller before removing it; a signature change to a method that builds webview HTML for more than one panel is how an unrelated panel loses its state injection.
- **Shared modules must not lose their last board-side consumer silently.** If the extraction moved a helper into a module that only these panes used, deleting the panes leaves an orphan module. Harmless but worth sweeping, and cheaper to spot now than as dead code later.
- **Tests keyed on the projection must be deleted, not disabled.** Any test asserting the `:2913` filter or `AGENT_CONTROL_VIEW` behaviour is testing machinery that no longer exists. A skipped test is a claim that something still works; a deleted test is honest about what shipped.
- **The board's tab strip loses three buttons**, so its layout should be checked at narrow widths — the strip is a flex row and removing a third of its items can change wrapping.

## Edge-Case & Dependency Audit

**Migration.** No user state. The `/agent-control` route, panel id, label and icon are untouched, so nothing a user bookmarked or learned changes. The only behaviour change is that the three tabs are no longer reachable from the board view.

**Security.** Deletion only. No endpoint, auth or CSP change.

**Side effects.** `kanban.html` drops ~700 lines of markup plus the projection CSS and JS. Its parse cost falls for board users too, not just Agent Control.

**Ordering.** Strictly after the extraction, and after the gate. There is no version of this plan that ships first.

## Dependencies

- **Requires** `extract-agent-control-into-its-own-panel-file.md`, shipped and exercised for a week without defects.
- Independent of `add-an-orders-tab-to-agent-control.md` — Orders lands in the new file and is never added here, so the two do not interact.

## Adversarial Synthesis

**"Just leave the tabs in the board — they work and deletion is risk for no feature."** Two implementations of the same tab is a standing cost: every change is made twice or diverges once. This programme has already produced one instance of exactly that failure class in standing orders, where two installed orders contradicted each other because nobody could see both. Leaving a second copy of three tabs is the same shape.

**"Fold this into the extraction as a final commit."** Then the extraction has no fallback and its cutover is irreversible on the panel used to drive agents. The week is the whole value; a plan that can be silently skipped is not a gate.

**"A week is arbitrary."** It is, and a defect resetting it matters more than the number. The point is that the gate is evidence-based rather than "it looked fine".

## Proposed Changes

1. **Confirm the gate:** a week of the new panel in real use with no attributed defect. If one appeared and was fixed, the week restarts.
2. **Delete the projection CSS** — `kanban.html:2909-2918`, the filter and the five hide rules.
3. **Delete the three tab buttons** (`:2940-2942`) and the three content panes (`:3187-3864`).
4. **Delete `AGENT_CONTROL_VIEW`** (`:6526`, `:6533`) and the Agent-Control initial-tab resolver (`:6563-6567`).
5. **Remove the `viewAttr` injection** (`KanbanProvider.ts:13633`) and the `viewMarker` parameter (`:13591`) **only after checking every caller**.
6. **Keep** the message-source branch (`:8960-8963`), `_agentControlPanel` and its full-state push (`:1407-1429`), and the manifest entry — all panel identity, not projection.
7. **Delete projection-specific tests** rather than skipping them, and sweep for modules whose last board-side consumer just went.

### Migration

None.

## Verification Plan

### Goal Invariants

- No occurrence of `data-view="agent-control"` or `AGENT_CONTROL_VIEW` remains in `src/`.
- `kanban.html` contains no `data-tab="agents"`, `="teams"` or `="prompts"` button and none of the three panes.
- `/agent-control` still serves the panel, with its rail icon, label and route unchanged.
- All three tabs still function from the new panel in both hosts.

### Automated Tests

- **Projection gone:** assert `src/` contains no `data-view="agent-control"`, no `AGENT_CONTROL_VIEW`, and that `kanban.html` has none of the three `data-tab` buttons or pane ids. One test, both halves — a partial deletion that leaves the CSS filter behind is invisible.
- **Panel unaffected:** the extraction plan's full test set passes unchanged. If retiring the board copies breaks the new panel, a shared module was still resolving against the board's DOM.
- **Route and manifest intact:** assert the `agent-control` manifest entry and `/agent-control` route still resolve — the deletion must not take panel identity with it.
- **`viewMarker` callers:** assert every remaining caller of `_getHtml` compiles and still injects state. This is the one signature change with reach beyond the two files.
- **No orphan modules:** assert every module the extraction created still has a consumer.
- **Board tests unchanged:** the board's own suite passes with no edits, confirming the three panes were genuinely separable.

### Manual Verification

- Open the board and confirm the tab strip renders correctly at narrow widths with three fewer buttons.
- Open `/agent-control` in both hosts and exercise all tabs, including Orders if it has landed.

## Outstanding Questions

- **[user]** What resets the week — any defect, or only one in the three tabs?
- Does anything outside `kanban.html` and `KanbanProvider.ts` reference the three pane ids? A test or a deep link would need updating, and it is cheaper to know before the deletion.
