# A Milestones tab on the board — the roadmap as a view over the cards

## Goal

Add a **MILESTONES** tab to `kanban.html` where the roadmap is visible and
editable: every target with its date and progress, its members grouped by where
they currently sit on the board, drag-to-reorder for the roadmap sequence, and
"add selected cards to a milestone" from the board itself.

### Problem Analysis

**`milestones-long-term-targets-on-the-board.md` makes the roadmap real but
invisible.** It adds the tables, the derived progress, and eight HTTP routes. A
human's only access would be `curl`. The tab is where the feature becomes
usable, and it is also the honesty check on the model: a progress number nobody
looks at is never discovered to be wrong.

**The board panel is the right home, with one inconsistency worth naming.** The
closest sibling concept, FEATURES, lives in `project.html:1273`, not in the board
panel — so putting milestones in `kanban.html` splits two related views across
two panels. It is still the right call: a milestone is a view over *these cards*,
the ones the board is showing, and adding members starts from a board selection.
Mission Control likewise has its own panel (`mission-control.html`) without that
being a problem. The FEATURES placement is pre-existing and is **not** relitigated
here.

**The tab's real risk is becoming a second board.** Every affordance that would
make it feel complete — a dispatch button, a column dropdown, a "start this
milestone" action — converts a target into an execution vehicle and duplicates
Mission Control. The parent plan's inertness commitment has to be enforced in the
UI, where the pressure to add one more button is strongest.

### Non-goals

- **Dispatching, queueing, or moving cards from this tab.** Members are shown
  with their column; changing it is the board's job.
- **Notifications or reminders on target dates.** Overdue is rendered; nothing is
  sent.
- **Gantt bars or a timeline canvas.** A dated, ordered list with progress is the
  deliverable; a timeline is a separate plan if wanted.
- **Confirm gates.** Per project rule, none. `window.confirm()` is additionally a
  silent no-op in VS Code webviews, so a gate here would make the button do
  literally nothing.
- **Editing feature or plan content.** The tab links to cards; it does not author
  them.

## Metadata

**Complexity:** 5
**Tags:** feature, frontend, ui, ux

## Dependencies

Blocked on `milestones-long-term-targets-on-the-board.md` — tables, derived
progress, and the routes. This plan adds no state of its own.

## Proposed Changes

### 1. `src/webview/kanban.html` — the tab

**Seams, all existing and all conventional:**

- **Button** — add `<button class="shared-tab-btn" data-tab="milestones">MILESTONES</button>`
  to the `.shared-tab-bar` at `:2979-2987`. Place it directly after `KANBAN`: it is
  a board-level view, not a configuration surface, and the tail of that bar
  (`UAT`, `SETUP`) is where configuration lives.
- **Content** — `<div id="milestones-tab-content" class="shared-tab-content">`,
  matching the `#<tab>-tab-content` convention the switch handler derives from
  (`:6598`).
- **Hydrate on activate** — the click handler at `:6581-6605` already has
  per-tab hydration branches (`agents` at `:6608`, `teams` at `:6615`). Add a
  `milestones` branch posting `getMilestones`. Do **not** load milestones on
  board refresh: the board refreshes constantly and this tab is usually not
  visible.
- **Agent Control view** — `body[data-view="agent-control"]` hides all non-agent
  tabs by explicit selector list (`:2930-2934`). Add
  `#milestones-tab-content` to that hidden set, or it leaks into a view it does
  not belong to. This is the kind of omission that ships looking fine because the
  default view is correct.

**Render — `renderMilestonesTab()`**, following `renderWorktreesTab()`
(`:12651`): a root element, rebuilt from the last payload, no partial DOM
surgery.

Each milestone row shows:

- name, and description on expand;
- **target date**, or `No date` — undated is a legitimate "someday" target;
- **overdue marker** when `targetDate` is past and `achievedAt` is null;
- **progress** — `done / total` plus a bar, with the by-column breakdown on
  expand (`3 created · 2 coded · 1 done`), read from the payload's derived
  numbers. **Never computed in the webview from a card list**: a second
  implementation of the dedupe rule is a second answer, and the discrepancy would
  surface as the screen and the API disagreeing about how far along a target is.
- **members on expand**, grouped by their current column, each linking to the
  card (reuse the existing plan-open path);
- **remove member** inline; **delete milestone** on the row.

Ordering: **drag to reorder milestone rows**, posting the full ordered id list —
the same post-drop-full-list shape the board's own drop handler uses
(`:10128`), so there is one idiom for ordering in this codebase, not two.
Grouping: undated milestones sort after dated ones regardless of `sort_order`, so
the roadmap reads as a sequence and the someday pile does not interleave with it.

**Empty state** must teach: what a milestone is, that it groups features and
plans toward a dated target, and that members are added by selecting cards on the
board. A blank tab is where this feature gets misread as broken.

**Create** — a name field plus optional date and project, inline at the top. No
modal.

**Delete** — immediate, no confirm, and labelled so the destructive reading is
impossible to hold: it removes the **target**, not the work. The parent plan
guarantees the cards survive; the label is what stops a user believing otherwise.

### 2. `src/webview/kanban.html` — add to a milestone from the board

The board already maintains a `selectedCards` Map (`:6454`) driving the
controls-strip actions (`ASSIGN` at `:3059` and neighbours). Add one strip
button — `ADD TO MILESTONE` — enabled when the selection is non-empty, opening a
milestone picker (the existing multi-choice picker pattern; a decision dialog is
permitted, a confirm gate is not) and posting one `addMilestoneMember` per
selected card.

**Prefer the feature over its subtasks.** When a selected card is a subtask whose
parent feature exists, add the **feature** and say so in the status message. This
is the parent plan's double-count rule enforced at the point of entry, which is
cheaper than deduping forever afterwards, and it is what a user means when they
select three subtasks of one feature and add them to a target.

### 3. `src/services/KanbanProvider.ts` — verb arms

Seven arms beside the existing mission arms, each thin over the DB methods the
parent plan adds: `getMilestones`, `createMilestone`, `updateMilestone`,
`deleteMilestone`, `addMilestoneMember`, `removeMilestoneMember`,
`reorderMilestones`. Each resolves the workspace root the way the mission and
`setPriorityStarred` arms do (`:12557`), returns `{ success, … }`, and posts a
`showStatusMessage` on failure — the pattern at `:12539`.

`reorderMilestones` takes the full ordered list and delegates to
`setMilestoneOrders`, mirroring `reorderColumn` (`:8664`) **including** the
validation that plan adds: refuse a list whose ids are not all milestones of this
workspace, rather than writing positions for rows that do not exist.

Then `npm run catalog:generate` (`package.json:942`) to add the verbs to
`src/generated/verbAllowlist.ts` and the catalog; `catalog:check` is the gate.

### Host parity (extension + standalone)

`kanban.html` is served by **both** hosts, and unmatched verbs fall through
`bootstrap.ts`'s `default:` arm to the provider — so verb reachability will look
correct in both regardless of whether this works. That is precisely the trap the
project rules describe, so parity is verified by **using the tab in both hosts**,
not by auditing verbs:

- open the Milestones tab in the VS Code extension and in the standalone browser
  host;
- create a milestone, add a member from the board selection, reorder, delete;
- confirm the progress numbers match `GET /kanban/milestones` in both.

No new composition-root seam is introduced: the arms reach the DB through the
provider's existing `_getKanbanDb`, and the routes are the parent plan's. If a
seam turns out to be needed, it must be wired in both roots in the same diff.

## Verification Plan

1. **Tab mechanics** — the button switches to `#milestones-tab-content`;
   activating posts `getMilestones` exactly once per activation; the tab is hidden
   under `body[data-view="agent-control"]`.
2. **Render** — dated, undated, overdue, achieved, and zero-member milestones all
   render; undated sort after dated; the empty state appears with no milestones.
3. **Progress comes from the payload** — assert the webview does no arithmetic
   over a card list to produce `done`/`total`. A source-text assertion is
   appropriate here: this is the invariant that silently rots.
4. **Add from board** — select three subtasks of one feature, add to a milestone,
   assert **one** member (the feature) was added and the status message says so.
   Select a standalone plan, assert it is added as a plan.
5. **Reorder** — drag a row, assert the full ordered list is posted and the order
   survives a tab switch and a board refresh.
6. **Delete** — no confirm dialog anywhere in the path (assert no `confirm(` in
   the added code, per project rule), the milestone disappears, and **every card
   is still on the board**.
7. **Not a second board** — assert the tab renders no dispatch, no column-move,
   and no "start" control; assert no code path from this tab posts a dispatch or
   move verb.
8. **Both hosts** — the hand-run checklist above, in the extension and in the
   standalone browser host.

### Goal Invariants

- The roadmap is readable at a glance: what the targets are, in what order, how
  far along, and what is overdue.
- The tab is the only new surface, and it moves nothing and runs nothing.
- One implementation of progress, in the backend.
- One ordering idiom, shared with the board's drop handler.
- Deleting a target never deletes work.
