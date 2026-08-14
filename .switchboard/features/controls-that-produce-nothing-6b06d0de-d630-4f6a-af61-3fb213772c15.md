# Controls That Produce Nothing

**Complexity:** 7

## Goal

Remove two controls that exist, look actionable, and produce no result. The link button on every kanban-pane row dead-clicks in all three hosts, and returns success in standalone while doing nothing. Turning on the Researcher terminal forces a Researcher board column whose drop target reaches an agent with no question to answer, because the Researcher is reached by a hand-off, not by a card move.

## How the Subtasks Achieve This

- **Terminals Kanban Pane: the Per-Row `link` Button Is Inert**: replaces the `selectPlan` verb call — which only sets a sidebar dropdown value nothing reveals, usually misses because the dropdown is differently scoped, and has no `__viaHttp` or standalone arm — with a clipboard copy of the plan's absolute path plus a transient `Copied!` label. Pure client-side, so it works identically in all three hosts, and `link` comes to mean what it already means everywhere else in Switchboard.
- **Making an Agent Visible Also Forces a Kanban Column**: splits the one `visibleAgents` flag that currently drives two unrelated things into a separate per-role board-column flag, extracts one `isKanbanColumnEnabled` resolver to replace **four** divergent copies of the same predicate, and ships it unchecked for `researcher` only — so the upgrade is provably a no-op for every other role and for every user who deliberately hid a column. It also closes the two places where the column flag currently leaks back onto the terminal side it is supposed to be independent of: `recomputeRoleOrderMap` demoting a hidden role's *terminal* to the alphabetical tail of the sidebar, and a terminals pane pinned to a now-hidden column rendering a blank column picker.

Both are instances of the same project contract: a control with no wiring behind it is absent or disabled, never a button that dead-clicks and never a stub that fakes success.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminals kanban pane: the per-row `link` button is inert — make it copy the plan's absolute path](../plans/feature_plan_20260812084311_terminals-kanban-pane-link-button-is-inert.md) — **PLAN REVIEWED**
- [ ] [Making an Agent Visible Also Forces a Kanban Column — Split Them With an "Add as Board Column" Checkbox](../plans/feature_plan_20260813100600_separate-board-column-from-agent-visibility.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Plan Review Status

> **Superseded:** "Uniformly CREATED. Replan the whole feature before dragging it to a coder column." — the feature was created column-mixed and the `link` button subtask had been moved back to CREATED so the set could be replanned as one unit.
> **Reason:** That replan has since run. Both subtasks are now in PLAN REVIEWED (see the auto-generated Subtasks block), so the instruction to press **Replan** describes a state the feature is no longer in and would send a reviewed set back through planning.
> **Replaced with:** the status below.

**Both subtasks reviewed and reconciled. Ready to execute, in the order stated below.**

Both plans have been through a full `improve-plan` pass with sibling context in hand: every file/line anchor was re-verified against `src/` (the `link` button plan's anchors had drifted by roughly 680 lines and are now re-anchored), and the cross-subtask audit found one real shared surface, recorded under *Dependencies & sequencing*. The column-split plan's complexity was raised 6 → 7 during that pass — it turned out to have four copies of the predicate rather than three, four `_filterDynamicColumns` call sites rather than two, and two `terminals.js` couplings the earlier pass had not traced.

## Dependencies & sequencing

> **Superseded:** "No hard ordering constraints; the two subtasks can be executed in parallel. They share no file — one is `src/webview/terminals.js` plus `terminals.html` and one hand-rolled test harness, the other is `agentConfig.ts`, three column filters, the config plumbing and `kanban.html`." Plus the grouping note that scheduling them independently loses nothing.
> **Reason:** The "share no file" claim was written from the subtasks' stated file lists and does not survive a trace of the actual call chain. The column-split subtask changes `TaskViewerProvider._filterVisibleColumns`, which is what `handleGetKanbanStructure` filters through; `terminals.js:5536-5541` builds the kanban pane's column picker from exactly that structure. So the second subtask both **needs to edit `src/webview/terminals.js`** (two fixes) and **changes the behaviour of the function the first subtask edits**. Shipping them in parallel means two agent streams in one provider file, which the project PRD's orchestration discipline forbids.
> **Replaced with:** the ordering below.

**Ship order: `link` button first, column split second.** Both subtasks edit `src/webview/terminals.js`, and the PRD's orchestration discipline is *"one agent stream per provider file — same-file parallel edits collide."* The `link` button plan is the smaller, self-contained change (three files, no backend surface) and depends on nothing the sibling produces, so it goes first. The column-split plan's `terminals.js` edits sit in a different region of the same file and apply cleanly on top.

Prerequisites and guards:

- **Nothing blocks the first subtask.** It needs no prior change; its ordering position is purely to keep the shared file serialised.
- **The second subtask must not land before the first**, or the first has to be rebased onto a file the second has already moved — for no benefit, since the second is the larger change.
- **The shared surface, stated once so a coder implements to one design:** `terminals.js`'s kanban pane picker is fed by `getKanbanStructure` → `_buildSetupKanbanStructure` → `_filterVisibleColumns`. The **column-split subtask owns** every change to that chain and the pane's reaction to a column vanishing from it (its Proposed Change 6). The **`link` button subtask owns** only the per-row action buttons and must not pre-empt the picker fix; its plan records this explicitly under Dependencies & Conflicts #17.

Per-subtask traps, all already resolved in the plans and all easy to re-introduce:

- **The `link` button must never toggle `disabled`.** A disabled control suppresses the capture-phase `pointerdown` that disarms row-drag, which would leave the row draggable while the label is swapped — an accidental dispatch. Guard repeat clicks with a `clearTimeout` handle instead. Reserve the button width so the transient label does not shove the card-advancing `Copy Prompt` button under the cursor.
- **Do not reuse the `copyPlanLink` verb.** Its name reads like an exact match; it copies a full dispatch prompt and auto-advances the card.
- **The column-split default resolution is the migration.** `kanbanColumnAgents[role] ?? DEFAULT_KANBAN_COLUMN_AGENTS[role] ?? visibleAgents[role] ?? true`, with `researcher: false` as the only per-role override. Write it with explicit `!== undefined` checks, never `||` — under `||` a user's deliberate `false` falls through and un-hides every column they hid, across roughly 4,000 installs.
- **There are four copies of the column predicate, not three.** The fourth is an inline recomputation of the same expression inside `TaskViewerProvider._buildSetupKanbanStructure`, which populates each item's `visible` field — and that is the copy the Setup panel and the terminals pane picker actually read. Converting only the named filters leaves the board and the structure disagreeing. `_filterDynamicColumns` likewise has four call sites, not two.
- **The occupied-column escape hatch must survive in the extracted resolver**, and must be *added* to `TaskViewerProvider._filterVisibleColumns`, which lacks it today — otherwise turning a column off can strand cards sitting in it.
- **The Researcher hand-off must not read the new flag.** `researcherConfigured` in the planner prompt resolves through `_getAgentNameForRole`, which reads registered terminals / chat agents and never touches a visibility map — so a workspace with a Researcher terminal and no Researcher column still gets the `/research/dispatch` directive. That split is the entire point; do not "helpfully" route it through the new flag.
- **Switching a board column off must not move that agent's terminal.** `recomputeRoleOrderMap` rebuilds the terminal sort key from the *filtered* column structure and replaces rather than merges, so a role with no rendered column loses its weight and sorts to the alphabetical tail of the terminal sidebar. Merge over `KANBAN_ROLE_ORDER_FALLBACK` instead. Without this, the feature's headline promise — "the terminal is unaffected" — is false the first time anyone uses the new checkbox.
