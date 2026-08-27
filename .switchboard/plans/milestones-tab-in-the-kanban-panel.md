# A Milestones tab on the board — goals, their cards, and where those cards are

## Goal

Add a **MILESTONES** tab to `kanban.html` showing each long-term goal with the
board status of its cards, where a user can create a milestone, add cards to it,
mark it complete or reopen it, and reorder the list.

### Problem Analysis

**`milestones-long-term-targets-on-the-board.md` makes milestones real but
invisible.** It adds the tables, the derived column status, and nine HTTP routes.
Without a tab, a human's only access is `curl`. The tab is also the honesty check
on the model: counts nobody looks at are never discovered to be wrong.

**The board panel is the right home, with one inconsistency worth naming.** The
closest sibling concept, FEATURES, lives in `project.html:1273`, not in the board
panel — so this splits two related views across two panels. It is still right: a
milestone is a view over *these* cards, and adding members starts from a board
selection. Mission Control likewise has its own panel (`mission-control.html`)
without that being a problem. The FEATURES placement is pre-existing and is **not**
relitigated here.

**The tab's real risk is becoming a second board.** Every affordance that would
make it feel complete — a dispatch button, a column dropdown, a "start this
milestone" action — turns a goal into an execution vehicle and duplicates Mission
Control. The parent plan's inertness has to be enforced here, where the pressure
to add one more button is strongest. Showing a card's column is not the same as
offering to change it.

### Non-goals

- **Dispatching, queueing, or moving cards from this tab.** Columns are shown;
  changing one is the board's job.
- **Date machinery.** `targetDate` renders if set. No overdue styling, no
  reminders, no date-driven sorting — the parent plan stores the field and nothing
  more.
- **Auto-completion.** The tab never marks a milestone complete on its own, however
  finished its cards look. Completion is a human's or an agent's declaration.
- **Gantt bars or a timeline canvas.** An ordered list with per-column counts is
  the deliverable.
- **Editing card content.** The tab links to cards; it does not author them.
- **Confirm gates.** Per project rule, none — and `window.confirm()` is a silent
  no-op in VS Code webviews, so a gate here would make the button do literally
  nothing.

## Metadata

**Complexity:** 5
**Tags:** feature, frontend, ui, ux

## Dependencies

Blocked on `milestones-long-term-targets-on-the-board.md` — tables, derived
status, routes. This plan adds no state of its own.

## Proposed Changes

### 1. `src/webview/kanban.html` — the tab

**Seams, all existing and all conventional:**

- **Button** — add `<button class="shared-tab-btn" data-tab="milestones">MILESTONES</button>`
  to the `.shared-tab-bar` at `:2979-2987`, directly after `KANBAN`: it is a
  board-level view, and the tail of that bar (`UAT`, `SETUP`) is where
  configuration lives.
- **Content** — `<div id="milestones-tab-content" class="shared-tab-content">`,
  matching the `#<tab>-tab-content` convention the switch handler derives from
  (`:6598`).
- **Hydrate on activate** — the click handler at `:6581-6605` already has per-tab
  hydration branches (`agents` `:6608`, `teams` `:6615`). Add a `milestones`
  branch posting `getMilestones`. Do **not** load on board refresh: the board
  refreshes constantly and this tab is usually not visible.
- **Agent Control view** — non-agent tabs are hidden by an explicit selector list
  (`:2930-2934`). Add `#milestones-tab-content` to it, or the tab leaks into a view
  it does not belong to. This is the omission that ships looking fine because the
  default view is correct.

**Render — `renderMilestonesTab()`**, following `renderWorktreesTab()` (`:12651`):
one root element rebuilt from the last payload, no partial DOM surgery.

Each row shows:

- **name**, with description and `targetDate` (if set) on expand;
- **column status** — the per-column counts from the payload, rendered as the
  breakdown itself (`3 created · 2 coded · 1 completed`) rather than a single
  percentage. This is the thing the tab exists to show: *where the work for this
  goal currently is*. Columns come from the payload, so a renamed column renders
  under its new name with no frontend change.
- **complete state** — a completed milestone is visibly settled and sorts after
  the open ones;
- **members on expand**, grouped by their current column, each linking to the card
  through the existing plan-open path;
- **remove member** inline.

**Counts are never computed in the webview.** A second implementation of the
parent plan's feature-dedupe rule is a second answer, and the discrepancy would
surface as the tab and the API disagreeing about how much work a goal contains.
Render the payload's numbers.

**Ordering** — drag to reorder rows, posting the full ordered id list: the same
post-drop-full-list shape the board's own drop handler uses (`:10128`), so there
is one ordering idiom in this codebase rather than two.

**Empty state** must teach: what a milestone is, that cards are added by selecting
them on the board, and that an agent can create and populate them too. A blank tab
is where this feature gets misread as broken.

**Create** — a name field plus optional description and date, inline at the top.
No modal.

**Complete / Reopen** — one toggle per row, posting `setMilestoneComplete`. It
must work with cards outstanding, and the label must not imply otherwise: this is
"mark this goal met", not "finish the remaining work". Reopen is the same control.

**Delete** — immediate, no confirm, labelled so the destructive reading is
impossible to hold: it removes the **goal**, not the work. The parent plan
guarantees the cards survive; the label is what stops a user believing otherwise.

### 2. `src/webview/kanban.html` — add to a milestone from the board

The board already maintains a `selectedCards` Map (`:6454`) driving the
controls-strip actions (`ASSIGN` at `:3059` and neighbours). Add one strip button
— `ADD TO MILESTONE` — enabled on a non-empty selection, opening a milestone
picker (a multi-choice decision dialog, which the project rules permit; a confirm
gate is what they forbid) and posting one `addMilestoneMember` per selected card.

**Prefer the feature over its subtasks.** When a selected card is a subtask whose
parent feature exists, add the **feature** and say so in the status message. That
enforces the parent plan's dedupe rule at the point of entry — cheaper than
deduping forever afterwards — and it is what a user means when they select three
subtasks of one feature and add them to a goal.

### 3. `src/services/KanbanProvider.ts` — verb arms

Eight arms beside the existing mission arms, each thin over the DB methods the
parent plan adds: `getMilestones`, `createMilestone`, `updateMilestone`,
`setMilestoneComplete`, `deleteMilestone`, `addMilestoneMember`,
`removeMilestoneMember`, `reorderMilestones`. Each resolves the workspace root the
way the mission and `setPriorityStarred` arms do (`:12557`), returns
`{ success, … }`, and posts `showStatusMessage` on failure — the pattern at
`:12539`.

`reorderMilestones` takes the full ordered list and delegates to
`setMilestoneOrders`, mirroring `reorderColumn` (`:8664`) **including** the
validation that plan adds: refuse a list whose ids are not all milestones of this
workspace rather than writing positions for rows that do not exist.

Then `npm run catalog:generate` (`package.json:942`) to add the verbs to
`src/generated/verbAllowlist.ts` and the catalog; `catalog:check` is the gate.

### Host parity (extension + standalone)

`kanban.html` is served by **both** hosts, and unmatched verbs fall through
`bootstrap.ts`'s `default:` arm to the provider — so verb reachability will look
correct in both whether or not this works. That is the trap the project rules
describe, so parity is verified by **using the tab in both hosts**, not by
auditing verbs:

- open the Milestones tab in the VS Code extension and in the standalone browser
  host;
- create a milestone, add a member from a board selection, reorder, complete,
  reopen, delete;
- confirm the counts match `GET /kanban/milestones` in both.

No new composition-root seam is introduced: the arms reach the DB through the
provider's existing `_getKanbanDb`, and the routes are the parent plan's. If a
seam turns out to be needed, it is wired in both roots in the same diff.

## Verification Plan

1. **Tab mechanics** — the button switches to `#milestones-tab-content`;
   activating posts `getMilestones` once per activation; the tab is hidden under
   `body[data-view="agent-control"]`.
2. **Render** — open, completed, and zero-member milestones all render; completed
   sort after open; the empty state appears with no milestones; a milestone whose
   cards span three columns shows all three counts.
3. **Renamed column** — rename a board column, reopen the tab, assert the new name
   appears and no card is dropped from the counts.
4. **Counts come from the payload** — assert the webview does no arithmetic over a
   card list to produce them. A source-text assertion is right here: this is the
   invariant that silently rots.
5. **Add from board** — select three subtasks of one feature, add to a milestone,
   assert **one** member (the feature) was added and the status message says so. A
   standalone plan is added as a plan.
6. **Complete / reopen** — complete a milestone with outstanding cards: succeeds,
   no card changes column, the row renders as settled; reopen restores it.
7. **No auto-complete** — complete every card in a milestone; assert the milestone
   stays open until someone marks it.
8. **Reorder** — drag a row, assert the full ordered list is posted and the order
   survives a tab switch and a board refresh.
9. **Delete** — no confirm dialog in the path (assert no `confirm(` in the added
   code, per project rule), the milestone disappears, **every card is still on the
   board**.
10. **Not a second board** — assert the tab renders no dispatch, no column-move and
    no "start" control, and that no code path from this tab posts a dispatch or
    move verb.
11. **Both hosts** — the hand-run checklist above, in the extension and in the
    standalone browser host.

### Goal Invariants

- The tab answers "what are the goals, and where is the work for each" at a
  glance.
- The tab is the only new surface, and it moves nothing and runs nothing.
- One implementation of the counts, in the backend.
- One ordering idiom, shared with the board's drop handler.
- Completing a goal never completes work; deleting a goal never deletes work.
