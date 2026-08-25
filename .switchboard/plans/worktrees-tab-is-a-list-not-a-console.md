# The WORKTREES tab is a list, not a console

## Goal

Reduce the WORKTREES tab from a five-section console to **one list plus one
creation row**. The tab keeps the ability to create a project worktree and an
unbound one — the strip button is convenient but the tab is where a user who
thinks in worktrees will look, and two ways to reach one verb is the existing
pattern, not a duplication to remove. What goes is the *chrome*: three sections
that differ only by a filter, each with its own "Manual Creation" header above
its own form above its own "Active …" header, and 140 words of prose explaining
what the rows already show.

**Feature creation does not come back.** It was removed deliberately: cutting a
worktree for any feature at any time, off whatever the default branch happened to
be, for work that may never be staged, is how two features end up on branches
that cannot see each other with nothing recording that one needed the other.
Feature worktrees are provisioned at STAGING time by the Worktrees toggle, which
is the moment the work is actually about to run. Project and unbound worktrees
have no such ordering problem — they are long-lived trees a user picks
deliberately, not per-unit-of-work — which is exactly why they keep their
buttons.

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

**1. Each creator is wrapped in its own section.** The two surviving creators —
a project dropdown + button posting `createWorktreeForProject`, and an "Unbound"
button posting `createWorktree` — are not the problem; the packaging is. Each sits
inside a `createSubsection` with a "Manual Creation" sub-header above it and an
"Active …" sub-header below it, so two controls that would fit on one row cost
four headers and two sections. The feature form that used to make a third has
already been removed.

**2. Three lists that differ only by a filter.** `FEATURES`, `PROJECTS` and
`UNBOUND` each end in `renderWorktreeList(subset, …)`, and the only difference is
which of `featureWTs` / `projectWTs` / `unboundWTs` they pass — three sibling
filters at `:13010-13013` on `w.featureTopic` and `w.project`. The rows inside
are identical, produced by the same `renderWorktreeRow`. Three near-identical
wrappers is the shape that lets one drift from the other two, and the `FEATURES`
section is now a header over a list with no control of its own at all.

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

- **Settled: both creators stay — project and unbound.** An earlier revision of
  this plan proposed deleting them, on the grounds that the strip button already
  covers project scope and that an unbound worktree is unreachable by plan
  routing. The user rejected both: the strip button is fine, but some users will
  go to the tab, and an unbound tree is a legitimate scratch checkout reached by
  the per-row *Agent terminals* checkbox. Two callers of one verb is the pattern
  the codebase already uses (`/kanban/move` is the API path a human's click
  takes), not a defect. **This plan removes chrome, not capability.**
- **Settled: feature creation does not return.** See the Goal. The
  `createWorktreeForFeature` verb stays in the allowlist and the provider as the
  programmatic path; no UI in this tab may post it.
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
- Moving the project form and the unbound button into one creation row above it.
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
  create button.** That gate is the no-dead-click rule (PRD contract #6), and
  because both creators survive it must survive on both of them. Moving a button
  is exactly the edit that drops the disabled state and its `title`, and the
  symptom — a button that does nothing when no repo is detected — is invisible
  until someone is in that state.
- **No confirm gates.** Project rule, and `confirm()` is a silent no-op in a VS
  Code webview. Abandon and cleanup already execute immediately; keep them that
  way.

## Edge-Case & Dependency Audit

**Migration.** None. This is a rendering change over `getWorktrees()` rows; no
schema, no config key, no stored state. No worktree is created or destroyed.

**Security.** None. No new path resolution, no new verb.

**Side effects.** None to capability: both creators survive, the row is untouched,
and both settings stay. The only visible change is layout — two buttons on one row
instead of two sections — so there is nothing to migrate and nothing to warn about
in a release note beyond "the WORKTREES tab is tidier".

**Ordering.** After `worktree-models-consolidate-and-a-staging-toggle.md`, which
narrowed the strip button and moved feature provisioning to staging. That plan's
review removed the tab's feature creation form; this plan finishes the tab.

## Dependencies

- **Requires** `worktree-models-consolidate-and-a-staging-toggle.md` (landed) —
  it removed the tab's feature-creation form and moved feature provisioning to
  STAGING time, which is what leaves the `FEATURES` section as a bare header over
  a list and makes the collapse possible.
- **Must not break** `worktree-strategy-control-contract.test.js`, which pins the
  strategy radio's markup shape and its broadcast-derived checked state.
- Independent of the mission and dependency-edge work.

## Adversarial Synthesis

**"The tab is the canonical worktree surface — do not take capability out of
it."** It stays canonical. Canonical means it is where you go to *see and act on*
worktrees, which is exactly what a single list with per-row merge, cleanup,
abandon and agent-terminals gives you. Creation was never what made it canonical;
it was the only surface, so it accumulated creation too.

**"Three sections make scope obvious at a glance."** The row's scope chip already
does that, in less space, and one list sorts. Three sections make scope obvious
*and* make an empty scope occupy three lines of chrome saying nothing.

**"If the tab keeps creating worktrees, what has actually improved?"** The tab
stops repeating itself. Two controls replace two sections and four sub-headers;
one list replaces three; one line replaces 140 words. Nothing a user could do
before becomes impossible, which is the point — the previous revision of this
plan tried to fix over-complication by removing capability, and removing
capability is not the same as removing complication.

**"Then delete the strip button instead, so there is one control."** No. The
strip button is on the board, where you are when you decide you want a project
tree; the tab is where you are when you are looking at trees. Same verb, two
entry points, matching the `/kanban/move` precedent. The consolidation this
follows was about collapsing four *models* to two, not about collapsing every
model to a single button.

### Risk Summary

Key risks: (1) a rewrite of `renderWorktreesTab` silently drops the
optimistic-removal guard or the no-dead-click gate, both invisible until an
abandon flickers or a button does nothing in a repo-less control plane;
(2) touching the strategy radio's markup breaks a contract test that exists
because a crash once left a forced value in place; (3) collapsing sections tempts
a rewrite of `renderWorktreeRow`, which owns the surviving merge caller and the
scope chip; (4) a coder reading "simplify the tab" re-derives the deleted
feature-creation form as part of "restoring" creation to the tab. Mitigations:
name all three as do-not-touch, assert the guard and the gate rather than
trusting the rewrite, and assert `createWorktreeForFeature` is absent from the
tab as its own named test.

## Proposed Changes

### 1. One list, not three — `src/webview/kanban.html`

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

### 2. One creation row, above the list — `src/webview/kanban.html`

**Context:** The two surviving creators live in separate sections. The project
form is at `:13052-13109` — a "Manual Creation" header, a project `<select>` and
a button posting `createWorktreeForProject`. The unbound button is at
`:13125-13140`, posting `createWorktree`. Between and around them sit four
sub-headers and two `createSubsection` wrappers.

**Logic:** Keep both controls, exactly as they behave. Put them on one row above
the list: the project selector with its **Create project worktree** button, and a
**Create unbound worktree** button beside it. No headers, no sections — a single
`flex` row, the same shape the STAGING column header uses for its own controls.

**Implementation:**
- Move the project `<select>` and its button, and the unbound button, into one
  container appended before the list.
- **Carry the disabled state and its `title` on BOTH buttons**
  (`config.controlPlaneMode === 'explicit' && repos.length === 0`). This is the
  edit most likely to lose it.
- Keep the project select's option-building and its "Please select a project
  first" guard, and keep the 5-second re-enable timeout on each button — they
  exist so a double-click cannot fire two creates.
- Delete only the wrapper chrome: `manualProjHeader`, the "Manual Creation" and
  "Active …" sub-headers, `unboundCreationContainer`, and the three
  `createSubsection` calls.

**Edge Cases:** With no projects defined, the project select is empty — the
existing "select a project first" guard already covers the click, so the button
stays enabled and says so rather than being mysteriously dead. The unbound button
never depends on projects.

### 3. No feature creation in this tab — `src/webview/kanban.html`

**Context:** The feature dropdown and "Create Feature Worktree" button were
removed when the STAGING toggle landed; a comment at `:13020-13032` records why.

**Logic:** It stays removed. Feature worktrees are cut at STAGING time by the
toggle, off the default branch as it is *then*.

**Implementation:** No code change. The comment is the deliverable — it is what
stops a coder "restoring creation to the tab" from putting three buttons on the
new creation row instead of two. Keep it, and keep it next to the row.

**Edge Cases:** The `createWorktreeForFeature` verb remains in the allowlist,
`verbSchemas` and the `KanbanProvider` arm as the programmatic path. Narrowing is
UI-only.

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

- The tab creates **project and unbound** worktrees, and never a feature one.
- Every worktree that exists is listed exactly once, with its scope visible.
- Both create buttons carry the no-dead-click disabled state.
- The strategy radio and the suppress checkbox are unchanged in id, markup shape
  and broadcast-derived state.
- Merge and cleanup remain reachable per row.
- An in-flight abandon does not flicker its row back.
- No capability the tab had before this plan is missing after it.

### Automated Tests

- **Both creators survive, and only those two:** assert `renderWorktreesTab`
  posts `createWorktreeForProject` exactly once and `createWorktree` exactly
  once. Three separate assertions, named — this is the test that catches a
  "simplification" that quietly drops a button the user asked to keep.
- **Feature creation stays out:** assert `renderWorktreesTab` contains no
  `createWorktreeForFeature` post. Its own named assertion, because the failure
  mode is a coder re-adding it while restoring the other two.
- **Neither create button is a dead click:** assert both buttons read the
  `controlPlaneMode === 'explicit' && repos.length === 0` gate. Moving a button
  is what loses this, and nothing else can see it.
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
  `copyWorktreeMergePrompt` — it and `POST /worktree/merge` are the only two
  callers, so losing it loses the UI path entirely.
- **The chrome is actually gone:** assert `renderWorktreesTab` contains no
  "Manual Creation" string and at most one `createSubsection(` call. Without this
  the plan can be "done" with every section intact and two buttons moved.

### Manual Verification

- Open the tab with a feature worktree, a project worktree and an unbound one;
  confirm three rows in one list with correct scopes.
- Create a project worktree from the tab, and one from the strip button; confirm
  both land identically.
- Create an unbound worktree from the tab; confirm it lists with the `Unbound`
  chip and can be cleaned up.
- Confirm merge and cleanup work from a row.
- Confirm the strategy radio and the STAGING toggle still agree after toggling
  either one.
- Confirm no control in the tab creates a *feature* worktree, and that staging a
  feature with the toggle on still cuts one.

## Outstanding Questions

None.
