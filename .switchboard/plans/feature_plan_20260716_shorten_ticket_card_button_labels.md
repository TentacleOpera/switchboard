# Plan: Shorten Ticket Card Button Labels

## Goal
Shorten the verbose action-button labels on ticket sidebar cards so the button row fits without crowding small cards, and add `title` attributes so the full label is still available on hover.

**Problem / Root cause:** In `src/webview/planning.js`, `_renderClickUpTicketCard` (button row at lines ~10452–10458) and `_renderLinearTicketCard` (lines ~10481–10487) render the card action buttons. Two labels are wordy — "Add to kanban" and "Link to ticket" — and consume excessive horizontal space on narrow sidebar cards, forcing the row to wrap. The other card buttons ("Refine", "Move", "Open") are already one word.

## Metadata
- **Tags:** ui, ux
- **Complexity:** 2

## User Review Required
None. Label copy is a straightforward UX polish; no product decision.

## Complexity Audit
### Routine
- Text-only edits to button labels in two sibling render functions in one file.
- Adding `title` attributes reuses the standard HTML tooltip pattern.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — static template strings.
- **Security:** Labels are static literals (not user data); no escaping concerns. Existing `escapeAttr`/`escapeHtml` on data-bound values is unchanged.
- **Side Effects:** Shorter labels change only display text; `data-*` attributes and click handlers (`data-import-plan-id`, `data-link-ticket-id`, etc.) are untouched, so all actions keep working.
- **Dependencies & Conflicts:** After reconciliation this is the ONLY subtask that edits `planning.js` — the "Fix Status/Assignees Clickable Area" subtask was moved to a CSS-only fix and no longer touches these render functions. No shared-surface conflict remains.

## Dependencies
- None.

## Adversarial Synthesis
Key risk: shortening a label could reduce discoverability of what a button does. Mitigation: add `title` attributes carrying the full original wording so hover gives full context, and leave already-short labels unchanged. No functional risk — only display text changes; `data-*` hooks and handlers are untouched.

## Proposed Changes
### src/webview/planning.js
- **Context:** The `.card-actions` button rows in `_renderClickUpTicketCard` (lines 10453–10454) and `_renderLinearTicketCard` (lines 10482–10483). The real card buttons are: **Add to kanban**, **Link to ticket**, **Refine**, **Move**, and (conditionally) **Open**.
- **Logic:** Shorten the two verbose labels and add `title` attributes preserving the full wording. Leave "Refine", "Move", and "Open" as-is (already concise).
- **Implementation:** Apply to BOTH render functions (ClickUp and Linear); their button markup is identical apart from `data-provider`:
  ```html
  <!-- Before -->
  <button ... data-import-plan-id="..." data-provider="...">Add to kanban</button>
  <button ... data-link-ticket-id="..." data-provider="...">Link to ticket</button>

  <!-- After -->
  <button ... data-import-plan-id="..." data-provider="..." title="Add to kanban">To kanban</button>
  <button ... data-link-ticket-id="..." data-provider="..." title="Link to ticket">Link</button>
  ```
  > **Superseded:** The original plan's label table proposed changes for "Add sub-ticket → Sub-ticket", "Edit ticket → Edit", "Attach image → Image", "Save ticket → Save", and "Cancel" (unchanged).
  > **Reason:** Those buttons do not exist in the ticket card render functions. `_renderClickUpTicketCard` / `_renderLinearTicketCard` only render "Add to kanban", "Link to ticket", "Refine", "Move", and "Open"; a grep across `planning.js` finds no "Edit ticket", "Add sub-ticket", "Attach image", or "Save ticket" card/detail buttons. Implementing the fictional rows would be a no-op.
  > **Replaced with:** Only the two real verbose labels are shortened ("Add to kanban" → "To kanban", "Link to ticket" → "Link"), each gaining a `title` attribute for full context. "Refine"/"Move"/"Open" are already short and unchanged.
- **Edge Cases:** "Open" is rendered conditionally (only when an external URL exists) — leave it untouched. Applying identical edits to both provider functions keeps ClickUp and Linear cards consistent.

## Verification Plan
### Automated Tests
- None. Per session directive, skip automated tests and compilation.

**Manual verification:**
1. In the Tickets sidebar, confirm ClickUp and Linear cards show "To kanban" and "Link".
2. Hover each — the full "Add to kanban" / "Link to ticket" tooltip appears.
3. Click each button and confirm its action still fires (import to kanban; link to ticket).

## Recommendation
Complexity 2 → **Send to Intern.**

## Completion Report (2026-07-16)
Implemented as planned: shortened "Add to kanban" → "To kanban" and "Link to ticket" → "Link" in both `_renderClickUpTicketCard` and `_renderLinearTicketCard` in `src/webview/planning.js`, adding `title` attributes carrying the full original wording for hover context. All `data-*` attributes and handlers are untouched, so button actions are unchanged. Refine/Move/Open labels left as-is per plan. A grep confirmed no other occurrences of the verbose labels remain outside the new `title` attributes; no issues encountered.
