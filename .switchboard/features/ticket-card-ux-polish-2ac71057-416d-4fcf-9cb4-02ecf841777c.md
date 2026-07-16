# Ticket Card UX Polish

**Complexity:** 2

## Goal

Clean up the visual and interaction quality of ticket cards in the sidebar — align button justification with plan cards, shorten verbose button labels to fit small cards, and constrain the status/assignees click target to the text area instead of the full-width row. All three touch the ticket card rendering path in planning.js / planning.html and share the capability theme of ticket card presentation and click ergonomics.

## How the Subtasks Achieve This

- **Justify Ticket Card Buttons Left**: Changes `.ticket-node .card-actions` from `justify-content: flex-end` to `flex-start` so ticket card buttons align left, matching tree/plan node cards.
- **Shorten Ticket Card Button Labels**: Shortens the two verbose card buttons ("Add to kanban" → "To kanban", "Link to ticket" → "Link") in `_renderClickUpTicketCard` / `_renderLinearTicketCard` and adds `title` attributes for full context. (The other card buttons — Refine/Move/Open — are already short. The plan's original "Edit ticket / Add sub-ticket / Attach image / Save ticket" labels were dropped — those buttons don't exist on ticket cards.)
- **Fix Status/Assignees Clickable Area on Ticket Cards**: Constrains the Status/Assignees rows to their content width via CSS (`align-self:flex-start; width:fit-content; max-width:100%` on the existing `.tickets-issue-meta[data-edit-*]` rule) so only the text is clickable — no markup or click-handler change. (Reconciled from the plan's original "move data-edit-* to an inner span" approach, which was based on markup that doesn't exist.)

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Plan: Fix Status/Assignees Clickable Area on Ticket Cards](../plans/feature_plan_20260716_fix_status_assignees_clickable_area.md) — **INTERN CODED**
- [ ] [Plan: Shorten Ticket Card Button Labels](../plans/feature_plan_20260716_shorten_ticket_card_button_labels.md) — **INTERN CODED**
- [ ] [Plan: Justify Ticket Card Buttons Left](../plans/feature_plan_20260716_justify_ticket_card_buttons_left.md) — **INTERN CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

After reconciliation the shared-surface map is:
- **`src/webview/planning.js`** — edited only by **Shorten Ticket Card Button Labels** (the clickable-area fix moved to CSS, so it no longer touches these render functions). No JS conflict remains.
- **`src/webview/planning.html`** (the `.ticket-node { ... }` CSS block) — edited by both **Justify Ticket Card Buttons Left** (`.card-actions`, lines 2862–2868) and **Fix Status/Assignees Clickable Area** (`.tickets-issue-meta[data-edit-*]`, lines 2852–2855). Different rules, no line overlap.

No cross-feature dependencies, and no functional ordering constraint — the three subtasks are independent and can land in any order. The only coordination note: the two `planning.html` edits touch the same CSS block, so apply them in one coordinated pass (or land them back-to-back) to avoid a trivial merge conflict.
