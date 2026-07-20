# Tickets tab: remove the Refine button from ticket cards

## Goal

Remove the **Refine** button from every Tickets sidebar card (Linear and ClickUp), because it is redundant with **Link** — both hand the agent the ticket and ask it to help write/spec the ticket — and it adds noise to the already-crowded card action row.

### Problem & root-cause analysis

Each ticket card renders a Refine button ([src/webview/planning.js:10804](src/webview/planning.js) for ClickUp, [:10833](src/webview/planning.js) for Linear):

```html
<button type="button" class="card-icon-btn" data-refine-ticket-id="${id}" data-provider="clickup">Refine</button>
```

Clicking it ([planning.js:9960-9986](src/webview/planning.js)) posts `copyRefinePrompt` to the extension, which copies a "produce a complete, agent-actionable specification for this ticket" prompt to the clipboard ([PlanningPanelProvider.ts:6684](src/services/PlanningPanelProvider.ts), backed by `.agents/skills/refine_ticket.md`).

That is functionally the same user intent as **Link** — "give the agent this ticket so it can work on / write it up." Two buttons for one job doubles the card-action footprint for no added capability. Refine is the one to cut: Link is the more general primitive.

## User Review Required

- Confirm the **backend orphan cleanup is in-scope**: with the only caller gone, the `copyRefinePrompt` message handler ([PlanningPanelProvider.ts:6684-6710](src/services/PlanningPanelProvider.ts)) and the `refine_ticket` skill registration ([ClaudeCodeMirrorService.ts:150](src/services/ClaudeCodeMirrorService.ts)) become dead. The plan removes both and deletes `.agents/skills/refine_ticket.md`. The legacy `.agent/skills/refine_ticket.md` copy does not exist (verified). Confirm before implementation.
- Confirm **`refine_feature` (Features-tab Refine) must NOT be touched** — it is a separate skill/flow at [ClaudeCodeMirrorService.ts:151](src/services/ClaudeCodeMirrorService.ts) and stays.

## Metadata
**Tags:** frontend, ui, cleanup
**Complexity:** 2

## Complexity Audit

### Routine
- Deleting the Refine button from both card renderers: [planning.js:10804](src/webview/planning.js) (ClickUp `_renderClickUpTicketCard`) and [planning.js:10833](src/webview/planning.js) (Linear `_renderLinearTicketCard`).
- Deleting the click-delegation branch for `data-refine-ticket-id` ([planning.js:9960-9986](src/webview/planning.js)).
- Deleting the `copyRefinePrompt` case in `PlanningPanelProvider.ts` ([6684-6710](src/services/PlanningPanelProvider.ts)).
- Deleting the `refine_ticket` skill registration at [ClaudeCodeMirrorService.ts:150](src/services/ClaudeCodeMirrorService.ts) — take care to remove **only line 150**, not line 151 (`refine_feature`).
- Deleting `.agents/skills/refine_ticket.md` (verified to exist; the `.agent/` legacy copy does not).

### Complex / Risky
- **Stale references in generated/comment code.** `KanbanProvider.ts:11964-11966` mentions `copyRefinePrompt` in *comments* (trade-off notes vs another handler). These become stale after removal. Harmless (comments), but should be updated or left for the next regeneration. `verbAllowlist.ts:9` lists `copyRefinePrompt` in `PLANNING_VERBS` — this is a generated allowlist; if it is auto-regenerated from handlers, it will self-clean on the next generation. If hand-maintained, remove the entry. Verify which.
- **Accidental deletion of `refine_feature`.** The `refine_ticket` and `refine_feature` skill registrations are adjacent ([ClaudeCodeMirrorService.ts:150-151](src/services/ClaudeCodeMirrorService.ts)). A careless `git rm` or line-range edit could take out both. Implementation must target only line 150.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The button is gone; no concurrent click path remains.
- **Security:** No new surface. Removing a clipboard-copy handler slightly reduces surface (one fewer prompt-copy path).
- **Side Effects:** Drill-down subtask cards share the same renderers (`_renderClickUpTicketCard` / `_renderLinearTicketCard`), so Refine disappears from subtask cards too — intended. No other UI references `data-refine-ticket-id` (grep confirmed: only the renderer + the delegation branch).
- **Dependencies & Conflicts:**
  - **Soft ordering:** *Stop sidebar cards resizing on hover* reasons about "4 card buttons max after Refine-removal lands." Landing this subtask first is slightly cleaner but either order works.
  - **Must NOT touch** `refine_feature` (Features-tab Refine) — separate skill/flow.
  - No backend message-protocol changes beyond removing the dead handler.

## Dependencies

- **Soft ordering:** land before *Stop sidebar cards resizing on hover* so that subtask reasons about a 4-button row, not 5. Either order works.
- No external session dependencies.

## Adversarial Synthesis

Key risks: (1) the `refine_ticket` and `refine_feature` skill registrations are adjacent — a careless edit could delete both; (2) stale `copyRefinePrompt` references in `KanbanProvider.ts` comments and the generated `verbAllowlist.ts` will linger unless explicitly cleaned. Mitigations: target only [ClaudeCodeMirrorService.ts:150](src/services/ClaudeCodeMirrorService.ts) (not 151); grep `copyRefinePrompt` and `refine_ticket` across `src/` after removal and decide per-file whether to update (comments) or regenerate (allowlist).

## Proposed Changes

### `src/webview/planning.js`
- **Context:** Card renderers at [planning.js:10801-10807](src/webview/planning.js) (ClickUp) and [planning.js:10830-10836](src/webview/planning.js) (Linear); click delegation at [planning.js:9960-9986](src/webview/planning.js).
- **Logic:** Remove the Refine button from both card renderers and delete its click-delegation branch.
- **Implementation:**
  1. **Delete the Refine button** from both card renderers: [planning.js:10804](src/webview/planning.js) (ClickUp `_renderClickUpTicketCard`) and [planning.js:10833](src/webview/planning.js) (Linear `_renderLinearTicketCard`).
  2. **Delete the click-delegation branch** for `data-refine-ticket-id` ([planning.js:9960-9986](src/webview/planning.js)).
- **Edge Cases:** Drill-down subtask cards share the renderers — Refine disappears from them too (intended).

### `src/services/PlanningPanelProvider.ts`
- **Context:** `copyRefinePrompt` case at [PlanningPanelProvider.ts:6684-6710](src/services/PlanningPanelProvider.ts).
- **Logic:** Orphan cleanup — remove the dead handler now that the only caller is gone.
- **Implementation:** Remove the `case 'copyRefinePrompt':` block. Verify the surrounding `case 'moveTicketResult':` ([:6680-6683](src/services/PlanningPanelProvider.ts)) and the next case after `copyRefinePrompt` remain intact.
- **Edge Cases:** The handler reads `.agents/skills/refine_ticket.md` and falls back to a `.agent/` legacy path then to an embedded fallback string — all three paths are dead once the button is gone.

### `src/services/ClaudeCodeMirrorService.ts`
- **Context:** Skill registration at [ClaudeCodeMirrorService.ts:150](src/services/ClaudeCodeMirrorService.ts).
- **Logic:** Remove the `refine_ticket` skill entry; keep `refine_feature` (line 151).
- **Implementation:** Delete **only line 150**:
  ```
  { source: 'skills/refine_ticket.md', name: 'refine-ticket', invocation: 'no-model' },
  ```
  Do NOT delete line 151 (`refine_feature`).
- **Edge Cases:** Adjacent-line risk — see Complexity Audit.

### `.agents/skills/refine_ticket.md`
- **Context:** The skill file backing the `copyRefinePrompt` handler.
- **Logic:** Delete the file (git is the undo).
- **Implementation:** `git rm .agents/skills/refine_ticket.md`. The `.agent/skills/refine_ticket.md` legacy copy does not exist (verified) — no action needed for it.

### `src/generated/verbAllowlist.ts` (verify only)
- **Context:** `PLANNING_VERBS` set at [verbAllowlist.ts:9](src/generated/verbAllowlist.ts) includes `copyRefinePrompt`.
- **Logic:** If this file is auto-generated from handlers, it self-cleans on regeneration. If hand-maintained, remove the `'copyRefinePrompt'` entry.
- **Implementation:** Check the file header / generation script. If generated, run the generator. If hand-maintained, edit the set.
- **Edge Cases:** Leaving the entry is harmless (allowlist only permits; no handler means no-op) but is stale.

### `src/services/KanbanProvider.ts` (comments only)
- **Context:** Comments at [KanbanProvider.ts:11964-11966](src/services/KanbanProvider.ts) reference `copyRefinePrompt` in trade-off notes.
- **Logic:** Stale comments after removal.
- **Implementation:** Update or leave for the next regeneration. Harmless either way.

## Verification Plan

### Automated Tests
- Skipped per session directive (no automated tests run).

### Manual Checks
- Ticket cards (Linear + ClickUp, including drill-down subtask cards) render with To kanban / Link / Move / Open and **no Refine**.
- Clicking anywhere on a card no longer triggers a `copyRefinePrompt` message.
- Grep confirms zero remaining `data-refine-ticket-id` / `copyRefinePrompt` references in the webview; if backend removal is approved, grep confirms zero `refine_ticket` (ticket, not feature) references in `src/services/` and `.agents/skills/`.
- Grep confirms `refine_feature` registration at [ClaudeCodeMirrorService.ts:151](src/services/ClaudeCodeMirrorService.ts) is still present and the Features-tab Refine flow still works.

## Decisions (confirmed)
- Remove the backend `copyRefinePrompt` handler + `refine_ticket` skill too — they are orphaned once the button is gone.

## Routing
**Complexity 2 → Send to Intern.** Pure deletion across 3 frontend/backend files + 1 skill file. One care risk (adjacent `refine_feature` line) that careful targeting resolves.

## Review Findings

Reviewed the committed implementation (commit 32bc8ab) against this plan. The Refine button is deleted from both card renderers (planning.js:10879, 10907) and the `data-refine-ticket-id` click-delegation branch is removed — grep confirms zero remaining references in `src/webview/`. The `copyRefinePrompt` handler is removed from PlanningPanelProvider.ts with the surrounding `moveTicketResult` and `refineFeature` cases intact. Only the `refine_ticket` skill registration (ClaudeCodeMirrorService.ts:150) is deleted; `refine_feature` (line 151) is preserved. `.agents/skills/refine_ticket.md` is `git rm`'d. No CRITICAL/MAJOR findings. The stale `copyRefinePrompt` references in `verbAllowlist.ts:9` (auto-generated, self-cleans on next `catalog:generate`) and `KanbanProvider.ts:11964-11966` (comments) are exactly as the plan predicted — harmless, deferred. Important non-issue: `refine-ticket` in `agentPromptBuilder.ts`/`agentConfig.ts` is `ticketUpdateMode` (a separate agent config concept), NOT the removed skill — correctly preserved. Verification: grep across `src/` and `src/webview/` confirmed no orphaned `data-refine-ticket-id`/`refineBtn`/`copyRefinePrompt` references in the webview; no test files reference the removed handler. Remaining risk: none — the `refine-ticket` ticketUpdateMode name collision is a documentation clarity issue, not a runtime risk.
