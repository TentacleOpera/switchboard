# The WORKTREES tab is a list, not a console

## Goal

Reduce the WORKTREES tab from a five-section console with three creation forms,
two settings blocks and 140 words of prose to one list of worktrees with per-row
actions. Creation belongs to the two controls the consolidation settled on — the
STAGING toggle for features, the strip button for projects — and the tab's job is
to show what exists and let you merge or clean it up.

### Problem Analysis

`renderWorktreesTab` builds the pane imperatively with `document.createElement`,
around 330 lines, in this order:

| Block | What it is | Lines (approx) |
|---|---|---|
| `configSection` | A `WORKTREES` header plus a 90-word prose paragraph explaining routing order | `kanban.html:12862-12880` |
| `settingsSection` → suppress | "Suppress main repo agent terminals" checkbox + a 50-word explanation | `:12882-12911` |
| `settingsSection` → strategy | The `feature_worktree_mode` radio pair (`none` / `per-feature`) | `:12913-12960` |
| `FEATURES` | Was: a feature dropdown + "Create Feature Worktree". Now: an active-worktree list only | `:13016-13045` |
| `PROJECTS` | "Manual Creation" header + project dropdown + create button, then an active list | `:13050-13120` |
| `UNBOUND` | "Create Worktree (Unbound)" button, then an active list | `:13123-13158` |

**Three problems, in order of how much they cost the user.**

**1. The tab has three ways to create a worktree and the board has two more.**
The feature form has just been removed (feature worktrees are cut by the STAGING
toggle at staging time). What remains is a project dropdown + button that
duplicates the strip button's project scope exactly, and an "Unbound" button that
creates a worktree bound to nothing — a scope no other surface offers, no plan
routes work into, and nothing in `_resolveWorktreeForPlan` can select. So of the
three creation affordances the tab still shows, one is a duplicate and one is a
dead end.

**2. Three sections that differ only by a filter.** `FEATURES`, `PROJECTS` and
`UNBOUND` each render `createSubsection(...)` + a "Manual Creation" sub-header +
a creation form + an "Active …" sub-header + `renderWorktreeList(subset, …)`.
The only real difference is which of `featureWTs` / `projectWTs` / `unboundWTs`
they pass. The subsets are computed by three sibling filters at `:13010-13013`
on `w.featureTopic` and `w.project`. Three near-identical 35-line blocks is the
shape that lets one drift from the other two — the per-row Merge prompt button
exists in `renderWorktreeRow`, so it is shared, but everything wrapping it is
triplicated.

**3. Prose where the row already answers it.** The tab opens with a paragraph explaining
"Routing order: feature worktree → project worktree → main repo", and the
suppress checkbox carries a second 50-word paragraph. Both describe behaviour the
list could simply show: a worktree's scope is a fact about the row, and routing
order is a property of the set, not an essay.

### Root Cause

The tab was the only worktree surface for most of its life, so every capability
that needed a home landed in it — a creation form per scope, the strategy radio,
the suppress setting, and prose explaining the whole model because there was
nowhere else to put it. Nothing was ever removed when a second surface appeared.
The strip button took project creation, the STAGING toggle took feature creation,
and the tab kept its copies of both.

## Metadata

**Complexity:** 2
**Tags:** ui, frontend, cleanup

## User Review Required

- **The `UNBOUND` scope is proposed for deletion, not preservation.** A worktree
  with neither `feature_id` nor `project` is unreachable by plan routing: it can
  only be reached by the per-row "Agent terminals" checkbox, which opens
  terminals in it manually. If that manual-checkout case is wanted, it is a
  *checkout*, not a worktree the dispatch model knows about, and it should be
  said so rather than presented as a third peer scope. Existing unbound rows are
  listed and cleanable either way — deletion removes the *create* button, never a
  row.
- **Settled: the strategy radio stays in this tab.** It is pinned by
  `worktree-strategy-control-contract.test.js` ("the control renders exactly the
  two modes the verb arm accepts", "checked state derives from the broadcast").
  The STAGING toggle is a second surface for the same key, and both must keep
  reflecting the broadcast. Do not move it, do not duplicate it a third time, and
  do not add a mode.
- **Settled: the suppress checkbox stays.** `worktree_suppress_main_terminals` is
  the reason the feature-worktree model is worth anything for a supervising user
  — the main checkout stays usable while a team works. Its 50-word explanation
  can go; the control cannot.

## Complexity Audit

### Routine

- Collapsing three list sections into one list (the rows already carry a scope chip).
- Deleting the project creation form and the unbound create button.
- Cutting the two prose paragraphs down to one line each.

### Complex / Risky

- **`renderWorktreeRow` is shared and must not be touched.** It owns the scope
  chip, the status badge, the branch, the created date, four buttons — Open
  terminals, Merge prompt, Clean up, Abandon — and the Agent-terminals checkbox
  (`toggleWorktreeAgentsOpenWithGrid`). The Merge prompt button is now one of only
  two callers of the merge endpoint (the other being `POST /worktree/merge`).
  Collapse the *sections*; the row is already the finished article.
- **The optimistic-removal guard is in `renderWorktreeList`.** `:12855-12857`
  skips rows in `window._removingWorktreeIds` during an in-flight abandon. A
  rewrite that drops this makes an abandoned worktree flicker back into the list
  until the next broadcast. Carry it over verbatim.
- **`config.controlPlaneMode === 'explicit' && repos.length === 0` disables every
  create button.** That gate is the no-dead-click rule (PRD contract #6) and it
  is duplicated per form. Deleting the forms deletes the duplication; do not
  delete the gate from the one create path that remains reachable elsewhere.
- **No confirm gates.** Project rule, and `confirm()` is a silent no-op in a VS
  Code webview. Abandon and cleanup already execute immediately; keep them that
  way.

## Edge-Case & Dependency Audit

**Migration.** None. This is a rendering change over `getWorktrees()` rows; no
schema, no config key, no stored state. No worktree is created or destroyed.

**Security.** None. No new path resolution, no new verb.

**Side effects.** Removing the project creation form changes a shipped
affordance. The strip button already covers it with the same verb
(`createWorktreeForProject`), so the capability does not disappear — worth a
release note line, not a migration.

**Ordering.** After `worktree-models-consolidate-and-a-staging-toggle.md`, which
narrowed the strip button and moved feature provisioning to staging. That plan's
review removed the tab's feature creation form; this plan finishes the tab.

## Dependencies

- **Requires** `worktree-models-consolidate-and-a-staging-toggle.md` (landed) —
  the two-control model is what makes the tab's forms redundant rather than
  load-bearing.
- **Must not break** `worktree-strategy-control-contract.test.js`, which pins the
  strategy radio's markup shape and its broadcast-derived checked state.
- Independent of the mission and dependency-edge work.

## Adversarial Synthesis

**"The tab is the canonical worktree surface — do not take capability out of
it."** It stays canonical. Canonical means it is where you go to *see and act on*
worktrees, which is exactly what a single list with per-row merge, cleanup,
abandon and agent-terminals gives you. Creation was never what made it canonical;
it was the only surface, so it accumulated creation too.

**"Three sections make scope obvious at a glance."** A scope column makes it
obvious in less space, and it sorts. Three sections make scope obvious *and*
make an empty scope occupy three lines of chrome saying nothing.

**"Keep the unbound button — someone might want a scratch worktree."** Then it is
a scratch checkout and should be labelled as one. Presenting it as a third peer
scope implies the dispatch model routes work into it, and it does not.

### Risk Summary

Key risks: (1) a rewrite of `renderWorktreesTab` silently drops the
optimistic-removal guard or the no-dead-click gate, both of which are invisible
until an abandon flickers or a button does nothing; (2) touching the strategy
radio's markup breaks a contract test that exists because a crash once left a
forced value in place; (3) collapsing sections tempts a rewrite of
`renderWorktreeRow`, which owns the surviving merge caller. Mitigations: name all
three as do-not-touch, and assert the guard and the gate in the plan's tests
rather than trusting the rewrite.

## Proposed Changes

### 1. One list, with a scope column — `src/webview/kanban.html`

**Context:** `renderWorktreesTab` currently builds `FEATURES`, `PROJECTS` and
`UNBOUND` as three `createSubsection` blocks, each ending in
`renderWorktreeList(subset, emptyMessage)`.

**Logic:** Replace the three sections with one `WORKTREES` list rendered from the
full `worktrees` array. **The row already states its own scope** —
`renderWorktreeRow` builds a chip reading `Feature: <topic>`, `Project: <name>`
or `Unbound` (`kanban.html:12704-12718`), with a `title` giving the long form.
That is the entire justification for the three sections, already present on every
row, which makes them redundancy rather than the only place scope is visible.
Sort by scope then branch so features still group, without a section to group
them.

**Implementation:**
- Delete the `featureWTs` / `projectWTs` / `unboundWTs` filters (`:13010-13013`)
  and the three section blocks that consume them.
- Render one `createSubsection('WORKTREES')` containing
  `renderWorktreeList(worktrees, 'No worktrees.')`.
- **Do not touch `renderWorktreeRow` at all.** The scope chip, the four action
  buttons and the Agent-terminals checkbox are already correct; this change lives
  entirely above the row renderer.
- Carry the `window._removingWorktreeIds` skip into the single list unchanged.

**Edge Cases:** An empty list renders one "No worktrees." line, not three. The
scope sort must be stable, so a re-render does not reshuffle equal-scope rows
under the pointer.

### 2. Delete the project creation form — `src/webview/kanban.html`

**Context:** `:13052-13109` renders a "Manual Creation" header, a project
dropdown and a create button posting `createWorktreeForProject` — the same verb
the strip button posts for the same scope.

**Logic:** Remove the form. The strip button is the project creation control.

**Implementation:** Delete the block and its locals (`manualProjHeader`,
`projForm`, `projLabel`, the select, the button). Leave the verb, its schema and
its `KanbanProvider` arm — the strip button and the API still use them.

**Edge Cases:** The strip button's project scope must stay reachable with nothing
selected, which is what its narrowing already established.

### 3. Delete the unbound create button, keep unbound rows — `src/webview/kanban.html`

**Context:** `:13125-13140` renders "Create Worktree (Unbound)" posting
`createWorktree`.

**Logic:** Remove the button. Rows with neither scope still list, with `—` in the
scope cell, and remain mergeable and cleanable.

**Implementation:** Delete `unboundCreationContainer` and `createUnboundBtn`.
Check whether `createWorktree` retains any other caller; if it does not, leave
the verb in place (the API path) and say so in a comment rather than deleting a
catalogued verb.

**Edge Cases:** Existing unbound worktrees are untouched — this removes a way to
make more, never a way to see or remove the ones that exist.

### 4. Cut the prose to one line each — `src/webview/kanban.html`

**Context:** `descriptionDiv` (`:12873-12879`) is 90 words; `suppressDesc`
(`:12905-12910`) is 50.

**Logic:** Replace the routing paragraph with one line — `Routing: feature
worktree → project worktree → main repo.` — and drop `suppressDesc` entirely;
the checkbox label already says what it does.

**Implementation:** Replace `descriptionDiv.innerHTML` with the single line.
Delete `suppressDesc` and its `appendChild`.

**Edge Cases:** None — text only.

### 5. Keep the settings block as-is — `src/webview/kanban.html`

The suppress checkbox and the strategy radio stay exactly where they are, with
the same ids, markup shape and broadcast-derived state.
`worktree-strategy-control-contract.test.js` slices the strategy block by the
`// ── Worktree strategy` marker and the `settingsSection.appendChild(modeRow);`
line — both must survive the edit verbatim.

### Migration

None.

## Verification Plan

### Goal Invariants

- The WORKTREES tab creates nothing. Every create affordance in it is gone.
- Every worktree that exists is listed exactly once, with its scope visible.
- The strategy radio and the suppress checkbox are unchanged in id, markup shape
  and broadcast-derived state.
- Merge and cleanup remain reachable per row.
- An in-flight abandon does not flicker its row back.

### Automated Tests

- **The tab creates nothing:** assert `renderWorktreesTab`'s source contains no
  `createWorktreeForFeature`, `createWorktreeForProject` or `createWorktree`
  post. Three separate assertions, named, so removing two and missing one fails.
- **One list, not three:** assert exactly one `renderWorktreeList(` call inside
  `renderWorktreesTab`, and that it is passed the unfiltered array.
- **The row renderer is untouched:** assert `renderWorktreeRow` still emits the
  scope chip for all three cases (`Feature:`, `Project:`, `Unbound`) and still
  wires all four action buttons plus the Agent-terminals checkbox. The chip is
  what makes one list sufficient, so a rewrite that "tidies" it away removes the
  only thing replacing the three section headers.
- **The optimistic-removal guard survives:** assert `renderWorktreeList` still
  consults `window._removingWorktreeIds`. This is the assertion that catches the
  rewrite regression, and nothing else can see it.
- **The strategy contract still passes unchanged:** run
  `worktree-strategy-control-contract.test.js` as-is. If it needed editing, the
  edit is the bug.
- **The suppress checkbox keeps its id and its broadcast state:** assert
  `suppress-main-terminals-chk` exists and is checked from
  `config.suppressMainTerminals`, not from a click assumption.
- **No confirm gate:** assert the tab's source contains no `confirm(` call.
- **Merge stays reachable:** assert the per-row merge button still posts
  `copyWorktreeMergePrompt` — after this plan it and `POST /worktree/merge` are
  the only two callers, so losing it loses the UI path entirely.

### Manual Verification

- Open the tab with a feature worktree, a project worktree and an unbound one;
  confirm three rows in one list with correct scopes.
- Confirm merge and cleanup work from a row.
- Confirm the strategy radio and the STAGING toggle still agree after toggling
  either one.
- Confirm no button in the tab creates a worktree, and the strip button still
  creates a project one.

## Outstanding Questions

None.
