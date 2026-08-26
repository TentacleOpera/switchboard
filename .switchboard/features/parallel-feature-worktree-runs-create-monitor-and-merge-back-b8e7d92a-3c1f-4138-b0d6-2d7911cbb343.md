# Parallel feature-worktree runs: create, monitor and merge back a batch

**Complexity:** 8

## Goal

Let an operator take a batch of features off the board, run each in its own worktree with a coder and a reviewer, monitor them all from the Terminals panel, and merge the batch back once reviewed.

Today none of that flow is usable end to end. Worktree creation is one feature at a time; the agent terminals it seats are created as VS Code terminals regardless of where the operator is working, so they never appear in the browser cockpit and cannot be grouped by worktree; and there is no batch merge path at all.

The blocking prerequisite is surface-aware terminal routing: creation and prompt delivery must target whichever surface the operator is actually on, in either host, guarded by a ratchet so the rule stops regressing. Bulk creation and bulk merge-back sit on top of it.

## How the Subtasks Achieve This

- **Agent Terminals Must Open on the Surface the Operator Is Actually Using**: makes terminal creation and prompt delivery resolve the operator's active surface instead of hardcoding `vscode.window.createTerminal`, so worktree agents appear where the operator is looking — the VS Code panel, the standalone cockpit, or the browser cockpit backed by the extension. Also adds the ratchet guard and a two-surface contract test, so the rule is enforced mechanically rather than restated. Because autoban terminals and worktree terminals both flow through `_createAutobanTerminal`, this single change fixes both. Nothing else in the feature is usable until this lands.
- **Split a Board Selection of Features into Worktrees in One Action**: turns the existing one-at-a-time worktree creation into a bulk action over a board multi-select, seating a coder and a reviewer per tree rather than the full agent set. This is the setup half of the workflow — the friction that currently makes the whole topology unattractive to use.
- **Merge a Batch of Reviewed Feature Worktrees Back in One Pass**: the closing half. Extends the existing single-worktree merge prompt to an ordered queue over N trees, in a verify mode (the agent reads each plan file's appended review outcome first) and a trusted mode (the operator asserts the batch is good). Reuses the existing hierarchy resolution so subtask branches still converge into their feature integration branch instead of landing on main.

## Reconciled Shared Surfaces

The cross-subtask audit found no overlap, contradiction or supersession — the three subtasks are genuinely distinct units. It did find contended files and one shared defect. Implement to the end-states below; do not re-decide them per subtask.

| Surface | Owner | Rule for the others |
| :--- | :--- | :--- |
| `_createAutobanTerminal`, `ensureWorktreeTerminals` (`TaskViewerProvider.ts`) | Surface routing | Sole editor of this file in the feature. Bulk creation consumes the routed behaviour and never branches on backend itself. |
| `MAX_AUTOBAN_TERMINALS_PER_ROLE` scoping (global → per worktree + backend) | Surface routing (§4a) | Bulk creation is **blocked** on it and must not implement a local workaround. At HEAD the cap is 5 workspace-wide per role, so a six-feature batch silently yields ten terminals instead of twelve. |
| Autoban rotation pool membership for worktree terminals | Surface routing (§4a) | Worktree-seated terminals stop joining `terminalPools`. Bulk creation asserts this rather than re-fixing it. |
| Per-feature worktree creation | Bulk creation | Consolidates onto the existing `_ensureFeatureIntegrationWorktree` (`KanbanProvider.ts:12458`) rather than extracting a fourth creator. |
| `KanbanProvider.ts` verb switch, `verbSchemas.ts`, `src/generated/verbAllowlist.ts`, the `kanban.html` multi-select bar | Shared by bulk creation and bulk merge-back | Serialise. Both add a verb case, both append a schema, both regenerate one generated line, both add a control to the same bar. |

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Split a Board Selection of Features into Worktrees in One Action](../plans/bulk-create-feature-worktrees-from-board-selection.md) — **PLAN REVIEWED** — ID: e6111769-7039-449f-85e1-1521053db495
- [ ] [Merge a Batch of Reviewed Feature Worktrees Back in One Pass](../plans/bulk-merge-back-reviewed-feature-worktrees.md) — **PLAN REVIEWED** — ID: 985591b6-25a5-4765-a61e-a82256d6e573
- [ ] [Agent Terminals Must Open on the Surface the Operator Is Actually Using](../plans/route-agent-terminals-to-the-active-surface.md) — **PLAN REVIEWED** — ID: 3fadf6c9-d458-4258-a4d3-d53515faebaf
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Surface routing is a hard blocker for bulk creation.** Built on today's behaviour, the bulk-create button would produce twelve VS Code terminals and an empty cockpit — the reported single-worktree failure, six times over. Bulk creation's own plan file declares this prerequisite explicitly; do not start it first. The block is now wider than terminal placement: surface routing also owns the fix for the workspace-global per-role terminal cap (`MAX_AUTOBAN_TERMINALS_PER_ROLE = 5`), without which a six-feature batch seats ten terminals rather than twelve and evicts the operator's main-tree terminals from the autoban rotation pool.

> **Superseded:** "**Bulk merge-back is not blocked by either of the others.** […] It can be built in parallel with the other two."
> **Reason:** correct about *logical* dependency, wrong about parallelisability. The reconciliation audit found bulk merge-back and bulk creation contend on four surfaces: both add a verb `case` to `src/services/KanbanProvider.ts`, both append to `src/services/verbSchemas.ts`, both regenerate the single `KANBAN_VERBS` line in `src/generated/verbAllowlist.ts`, and both add a control to the same multi-select action bar in `src/webview/kanban.html`. The project PRD's orchestration discipline is explicit — "one agent stream per provider file… the same file serialises" — and `verbSchemas.ts` is called out by name as shared. Running them concurrently buys nothing and costs a four-way merge.
> **Replaced with:** bulk merge-back is not *gated* by either sibling — it operates on worktrees that exist, however they were created, and does not depend on which surface their terminals live on. But it must **serialise** with bulk creation rather than run beside it. If a second coder is free, put them on surface routing (a different file) rather than on the second Kanban verb.

**Shared external dependency:** bulk creation needs a single callable per-feature worktree creator. That creator already exists as `_ensureFeatureIntegrationWorktree` (`KanbanProvider.ts:12458`) — idempotent, guarded, row-returning — so the work is to widen and repoint it, not to extract the `case` at `:11677` into a fourth implementation. The separate plan *"Dispatch analysis should recommend (and be able to create) per-feature worktrees when candidates are too entangled"* — which is **not** part of this feature — needs the same consolidation for its `POST /worktree/feature` route (that route does not exist yet; `LocalApiServer` currently serves only `/worktree/cleanup` and `/worktree/list`). Whichever lands first performs it; the second consumes it and skips its own step.

**Suggested order:** surface routing → bulk creation → bulk merge-back. The last two are sequential because they share `KanbanProvider.ts`, not because merge-back is gated.

