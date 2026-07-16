# Plan: Fix Status/Assignees Clickable Area on Ticket Cards

## Goal
Constrain the click target of the "Status" and "Assignees" meta rows on ticket cards to the text itself, so clicking empty space to the right of the text no longer opens the status/assignees editor.

**Problem / Root cause:** The Status and Assignees meta rows are flex children of `.ticket-node` (a `display:flex; flex-direction:column` container, `planning.html:2790`). With the default `align-items: stretch`, each row stretches to the card's full width. The rows carry `data-edit-status` / `data-edit-assignees`, and the click handler in `planning.js` (`9545`, `9557`) uses `e.target.closest('[data-edit-status]')` / `closest('[data-edit-assignees]')` — so clicking anywhere on the full-width row, including the empty space right of the text, triggers the edit action.

## Metadata
- **Tags:** ui, ux, bugfix
- **Complexity:** 2

## User Review Required
None. The behavior change is unambiguous (text-only click target); no product decision.

## Complexity Audit
### Routine
- Additive CSS on an existing rule in one file (`planning.html`).
- No markup, no JavaScript, and no click-handler changes.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — static CSS.
- **Security:** None.
- **Side Effects:** Shrinking the rows to content width means the existing hover affordance (underline + teal, `planning.html:2856–2860`) now applies only over the text — the desired ergonomics. Clicking the empty area of those rows now falls through to the bare-card click (selection / drill-down), consistent with clicking any other empty part of the card.
- **Dependencies & Conflicts:** Edits the same `.ticket-node { ... }` CSS block in `planning.html` as sibling subtask "Justify Ticket Card Buttons Left" — but a *different* rule (`.tickets-issue-meta[data-edit-*]` at 2852–2855 vs `.card-actions` at 2862–2868). No line overlap. After reconciliation this subtask NO LONGER touches `planning.js` (see Superseded note below), so it does not conflict with "Shorten Ticket Card Button Labels".

## Dependencies
- None.

## Adversarial Synthesis
Key risk: a flex child that is a plain block might not visibly shrink under `align-self: flex-start` alone. Mitigation: pair `align-self: flex-start` with `width: fit-content` (deterministic content sizing) and `max-width: 100%` (prevents long assignee lists from overflowing the card). The click handler is untouched and keeps working because the `data-edit-*` attributes stay on the same elements — only their rendered width changes.

## Proposed Changes
### src/webview/planning.html
- **Context:** The editable-rows rule at lines 2852–2855:
  ```css
  .ticket-node .tickets-issue-meta[data-edit-status],
  .ticket-node .tickets-issue-meta[data-edit-assignees] {
      cursor: pointer;
  }
  ```
- **Logic:** Stop the rows from stretching to full card width so only the text is the click/hover target.
- **Implementation:**
  ```css
  .ticket-node .tickets-issue-meta[data-edit-status],
  .ticket-node .tickets-issue-meta[data-edit-assignees] {
      cursor: pointer;
      align-self: flex-start; /* override .ticket-node's align-items:stretch */
      width: fit-content;     /* size the click target to the text, not the row */
      max-width: 100%;        /* never overflow the card on long assignee lists */
  }
  ```
  > **Superseded:** The original Root Cause showed the rows rendering an inner `<span class="kanban-meta-label">Status:</span>` plus `<span class="ticket-status-text">Open</span>`, and the original Fix moved `data-edit-status` / `data-edit-assignees` onto a new inner inline `<span>` inside `_renderClickUpTicketCard` / `_renderLinearTicketCard`.
  > **Reason:** That markup does not exist. The real rows are `<div class="tickets-issue-meta ticket-status-row" data-edit-status ...>${status}${syncBadge}</div>` and `<div class="tickets-issue-meta ticket-edit-assignees" data-edit-assignees ...>${assignees}</div>` (`planning.js:10450–10451`, `10478–10479`) — no `kanban-meta-label` / `ticket-status-text` spans and no "Status:" prefix. The span-move approach would also break the existing CSS selectors (`[data-edit-status]:hover` etc. at 2852–2860), needlessly touch the JS render functions, and put the fix on the same shared surface as the "Shorten Ticket Card Button Labels" subtask.
  > **Replaced with:** A pure-CSS fix that keeps the `data-edit-*` attributes exactly where they are (so `closest('[data-edit-status]')` / `closest('[data-edit-assignees]')` in `planning.js:9545,9557` keep working) and simply shrinks the rows to content width via `align-self: flex-start; width: fit-content; max-width: 100%`.
- **Edge Cases:**
  - The status row is itself `display:flex` (`.ticket-status-row`, `planning.html:2842–2846`) to keep the sync badge inline — `align-self`/`width:fit-content` size the row's outer box without disturbing that internal layout, so the badge stays adjacent to the state name.
  - Long assignee strings: `max-width: 100%` keeps the row within the card; text wraps as before.

## Verification Plan
### Automated Tests
- None. Per session directive, skip automated tests and compilation.

**Manual verification:**
1. Click the text "Open" on the Status row → the status modal opens.
2. Click the empty space to the right of the text on the Status row → the modal does NOT open (bare-card selection/drill-down fires instead).
3. Repeat (1)–(2) for the Assignees row.
4. Confirm the sync badge still sits inline next to the status text.
5. Test on both ClickUp and Linear cards.

## Recommendation
Complexity 2 → **Send to Intern.**

## Completion Report (2026-07-16)
Implemented the pure-CSS fix as planned: added `align-self: flex-start`, `width: fit-content`, and `max-width: 100%` to the existing `.ticket-node .tickets-issue-meta[data-edit-status], [data-edit-assignees]` rule in `src/webview/planning.html`. The `data-edit-*` attributes stay on the same elements, so the `closest()` click handlers in `planning.js` are untouched and keep working. Status/assignees rows now shrink to text width — clicks in the empty space to the right fall through to bare-card selection. No issues encountered; the sync badge's inline layout is unaffected since the row's internal flex display is preserved.

## Review Findings
**Reviewer pass (2026-07-17): PASS — no code changes.** Verified `planning.html:2836-2842` matches the plan exactly; `.ticket-node` confirmed `display:flex; flex-direction:column` (`2774-2777`), so the cross-axis shrink is effective. Delegated click handler at `planning.js:9516,9528` returns early with `stopPropagation`; gap-clicks correctly fall through to the bare-card selector at `planning.js:9632` (no double-trigger). `.ticket-status-row` internal `display:flex` (badge inline) undisturbed. Findings were NIT-only: `align-self:flex-start` is redundant given `width:fit-content` (kept as self-documenting); hover-underline is now the sole signal distinguishing text-click (modal) from gap-click (select); plan line refs to handler locations (9545/9557) are stale (actual 9516/9528). Validation: `node --check` OK, HTML parse OK (compilation/tests skipped per directive). Remaining risk: none material — cursor-affordance nuance is cosmetic.
