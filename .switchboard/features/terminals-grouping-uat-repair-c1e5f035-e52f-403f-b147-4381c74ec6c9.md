# Terminals grouping UAT repair

**Complexity:** 6

## Goal

Repair the terminals grouping feature, which failed UAT on ten separate counts. The group model is the core damage: switching groups inherits the previous group layout, no group can be deleted, and a locked group leaves empty panes that no click can fill. Around it sit a peek mode that traps the grid, a link-up relay that can wipe the recipient context mid-task, unrelated repos rendering as workspaces, and two controls that cannot do anything useful. Each subtask fixes one root cause and states what it must not implement, so the set can be worked in parallel without collisions.

## How the Subtasks Achieve This

- **Groups Become A Tab Strip Above The Grid**: Moves group switching out of the sidebar onto a tab strip over the terminal view, and reduces the sidebar to one tree (Workspace → Terminal) with a group chip per row. Fixes the "weird state" report by giving groups the idiom for a view mode instead of a tree node that secretly re-seats the grid — and removes the need to partition cross-workspace role groups. Because it deletes `renderGroupSidebar()` outright, it also owns the removal of the `detach` button that lived inside it, and it relocates today's per-source group controls onto the tabs so the deletion subtask can redefine what they mean without also re-placing them.
- **Group Switching Inherits The Previous Group's Grid**: Gives every group its own persisted layout and splits the grow-only `layoutForFleetCount` resolver from the group-restore resolver, so a switch can shrink the grid as well as grow it. Also makes "All terminals" re-seat the pane grid instead of only repainting the sidebar.
- **You Can Never Delete A Group**: Puts one working `delete` on every group regardless of source, replacing the three-way split (delete / hide / nothing) that left this operator's all-derived board with no delete button at all. Retires the `Unassigned` pseudo-group and keeps derived deletions restorable.
- **Peek Mode Traps The Grid**: Cancels peek from the single choke point every seating path already runs through, so selecting any other terminal exits peek. Adds the invariant that `is-peeking` can never render with no visible pane, closing the blank-grid variant, and gives the peek button the styling it never had.
- **Link-Up Wipes The Recipient's Context**: Adds a real `POST /terminals/relay` endpoint that cannot clear, flips `ptySendPrompt`'s omitted-field default from `true` to `false` so a wipe requires explicit opt-in, and rewrites the relay prompt from an HTTP tutorial into an instruction.
- **Remove The `delegates` Button**: Deletes the permanently-disabled `delegates` control from every pane header, leaving the overlay machinery behind it intact. A pure single-file removal whose only real hazard is the positional `children[]` reads in `updatePaneElement`. Its sibling complaint, `detach`, moved to the tab-strip subtask, which deletes the function that button lives in — this is now the one subtask in the set with no ordering constraint at all.
- **Unrelated Repos Appear As Workspaces**: Puts a filter between "a `kanban.db` found beside a VS Code folder" and "a workspace this board owns", carries per-mapping provenance and enablement so one repo cannot switch mappings on for its siblings, and skips mappings whose folders no longer exist.
- **A Locked Group's Empty Panes Cannot Be Filled**: Makes a click on a non-member with a free pane seat it *and* add it to the group, backed by an additions overlay in `groupPrefs` so derived groups stay self-healing. This is the fix for the reported "2×2 will not accept new terminals" and for the operator having to fall back to free composition.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Groups Become A Tab Strip Above The Grid, Not A Slab In The Sidebar](../plans/feature_plan_20260811170000_terminals-sidebar-workspace-group-terminal-hierarchy.md) — **CODE REVIEWED**
- [ ] [Group Switching Inherits The Previous Group's Grid — Give Every Group Its Own Layout](../plans/feature_plan_20260811170001_terminal-group-layout-persistence-and-switching.md) — **CODE REVIEWED**
- [ ] [You Can Never Delete A Group — Give Every Group Source A Working Delete](../plans/feature_plan_20260811170002_terminal-group-deletion-every-source.md) — **CODE REVIEWED**
- [ ] [Peek Mode Traps The Grid — Selecting Another Terminal Must Cancel The Peek](../plans/feature_plan_20260811170003_peek-mode-traps-the-grid.md) — **CODE REVIEWED**
- [ ] [Link-Up Wipes The Recipient's Context And Reads Like An API Tutorial](../plans/feature_plan_20260811170004_link-up-relay-endpoint-and-safe-clear-default.md) — **CODE REVIEWED**
- [ ] [Remove The `delegates` Button — A Permanently Disabled Control In Every Pane Header](../plans/feature_plan_20260811170005_remove-dead-terminal-controls-detach-and-delegates.md) — **CODE REVIEWED**
- [ ] [Unrelated Repos Appear As Workspaces In The Terminals Sidebar](../plans/feature_plan_20260811170006_terminals-sidebar-foreign-workspace-rows.md) — **CODE REVIEWED**
- [ ] [A Locked Group's Empty Panes Cannot Be Filled — Every Sidebar Click Is Captured](../plans/feature_plan_20260811170007_locked-group-empty-panes-cannot-be-filled.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Revised after a cross-subtask reconciliation pass against the source. Two claims in the earlier version were wrong — one pair of "independent" subtasks edits the same function, and the prescribed order made one subtask discard another's work.

**Only one subtask is genuinely unconstrained: Remove The `delegates` Button.** Single file, single function pair, no shared symbol with anything else in the set. Start it any time, in parallel with anything.

### The group model — four subtasks, one chain

1. **Groups Become A Tab Strip** goes **first**, not last. It deletes `renderGroupSidebar()` wholesale, so anything else that edits that function is writing code destined for deletion. Putting it first removes the collision the earlier ordering existed to manage: `detach` dies with the function (no separate subtask), and the `hide`→`delete` handler is relocated once instead of being rewritten in the sidebar and then again on a tab.
2. **Group Switching Inherits The Previous Group's Grid** can run **in parallel with 1**. It owns `layoutForFleetCount`/`layoutForGroupSwitch`, the layout-picker call site and `clearGroupLock`'s internals; the tab strip owns the renderer and the strip markup. The one shared line is the `groupPrefs` initialiser. The tab strip routes its `All` tab at `clearGroupLock()` and this subtask rewrites that function's body — different concerns, no conflict.
3. **You Can Never Delete A Group** after 1. It is now semantics-only: what `delete` stores per source, retiring the `Unassigned` pseudo-group, the restore relabel, state hygiene. It benefits from 2's re-seating `clearGroupLock` for the delete-of-locked case, but has a stated interim fallback if 2 has not landed.
4. **A Locked Group's Empty Panes** last. It needs 1's `group:<id>` picker key for the empty-pane affordance and 3's retirement of `Unassigned` (which is what makes the `!group` branch it rewrites reachable at all).

### The three "independent" ones — one correction

- **Peek Mode Traps The Grid** is not file-independent of the group work. It adds a peek cancel to `assignToFocusedPane` — the same function the locked-panes subtask adds a `keepLock` option to — and it reasons about the full set of `paneAssignments` writers, one of which subtask 2 adds. Serialise it against those two on `terminals.js`, or land it first (it is the smallest of the three).
- **Link-Up** and **Unrelated Repos Appear As Workspaces** both edit `handlePtyVerb` in `TaskViewerProvider.ts`, thirteen lines apart (`:2094` vs `:2107`). The earlier version called them independent; they are not, under the project's one-stream-per-provider-file rule. Either order, but **not concurrently**.

### Shared surfaces — the reconciled end-state

- **`renderGroupSidebar()`** — one owner: the tab strip subtask, which deletes it. Nobody else edits it.
- **`groupPrefs`** — three subtasks, distinct keys (2 adds `layouts`, 3 reuses the shipped `hidden`, 4 adds `extras`), but **two shared code sites, not one**: the initialiser at `terminals.js:95` *and* the field-by-field loader whitelist at `:1351-1359`. The loader drops any key it does not name, so whoever lands second must add their key to both without dropping the first's. Getting this wrong is silent: the feature works all session and loses its state on reload.
- **`getGroupMembers`** — subtask 3 deletes its `unassigned` branch, subtask 4 adds the `extras` union, subtask 2 aligns its `role`/`worktree` branches onto the shared `live` set. Three edits to one function; the 2 → 3 → 4 order above resolves them.
- **`assignToFocusedPane`** — peek adds a cancel at the top, subtask 4 adds a `keepLock` opt to the unlock block immediately below it. Adjacent lines; serialise.
- **`Unassigned`** — retired in three call sites together (`getAllGroups`, `findGroupForTerminalName`, `getGroupMembers`), owned by subtask 3. Retiring it in only one produces a dead click for every ungrouped terminal under a lock.

### One durable caveat

Every plan in this set cites `terminals.js` line numbers, and that file has uncommitted working-tree changes. The function and symbol names in each plan are authoritative; the line numbers are a navigation aid that will drift. Locate by symbol first.

## Completion

All eight subtasks were implemented and reviewed against the diff. Work ran as three serialised streams in one shared worktree — the group-model chain (tab strip → layout persistence → deletion → locked panes) on one coder, the provider-file chain (link-up relay → foreign-workspace scoping) on a second per the one-stream-per-provider-file rule, and peek → delegates removal on a third. Files changed: `src/webview/terminals.js`, `src/webview/terminals.html`, `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts`, `src/services/WorkspaceIdentityService.ts`, `src/standalone/bootstrap.ts`, `protocol-catalog.json`.

Seven defects were caught in review and fixed before acceptance, three of them regressions created by earlier subtasks in this same set: peek's Rule 1 missed `handleLockedTerminalClick`'s focus-in-place branch (the UAT repro survived under a lock); the tab strip's picker guard defeated its own garbage-collect and mounted pickers for deleted groups; the `clearBeforePrompt` default flip silently stopped the kanban drag-drop dispatch from clearing, fixed with a `clearBeforePromptFromConfig` opt-in honoured in both hosts; widening the mapping-dedup pool let a disabled DB win provenance over the board's own; and the locked-pane affordance both stranded stale placeholder text and hijacked the kanban empty state's click. Per the dispatch waiver no compilation or automated tests were run, so every acceptance check here is source review, not execution — the contract tests the plans name (`terminal-sidebar-groupings-contract.test.js` and siblings) were not updated and will need reconciling, and `npm run parity:check` has not been run against the new `/terminals/relay` catalog entry.

## Review Findings

An independent reviewer pass **did** run compilation and the automated gates — the earlier waiver was a record of the coding dispatch, not an instruction to the review — and found four defects the source-only pass missed, two of them CRITICAL and both in code added by the plans' own post-review fixes. `renderGroupTabStrip` measured overflow on a still-detached `tabRow`, so every tab collapsed into the `»` menu and the tab strip — the feature's headline surface — rendered empty in every fleet shape; and the locked-pane placeholder re-derive used `existing.textContent`, which deleted the `kanban mode` toggle child on the first reconcile of any empty pane. Also fixed: the layout picker kept the lock without re-paging (grow `2h`→`2x2` revealed empty panes the group had members to fill), and `handleLockedTerminalClick`'s free-slot precondition ignored pins while the `assignToFocusedPane` it calls with `keepLock` does not — the exact mismatch that routes to displacement and evicts a group member under a lock. Files changed by the review: `src/webview/terminals.js`, `src/test/terminal-sidebar-groupings-contract.test.js`, `src/test/terminal-pane-grid-reconcile-contract.test.js`, `src/test/terminal-pane-pinning-contract.test.js`, `src/test/shell-terminal-strip.test.js`, `src/test/pty-route-surface-contract.test.js`.

Gate status after the pass: `npx tsc --noEmit` clean for this feature (5 pre-existing `TS2835` errors in untouched files/lines), `npm run compile` green, and `parity:check`, `verb-returns:check`, `standalone-parity:check`, `push-routing:check`, `mirror:check` all green. Nineteen contract-test failures across four CI-wired gates were attributable to this feature and are now fixed — `terminal-sidebar-groupings` was reconciled from the deleted design onto the tab strip (38/38), `terminal-pane-pinning` (15/15) and `shell-terminal-strip` had stale `assignToFocusedPane(terminalName)` markers, and `pty-route-surface` was red only because subtask 5's new comment block pushed its assertion target past a fixed 2000-char slice window. Two failures remain and are **not** this feature's: `terminal-focus-affordance`'s `inputDropNoticed` assertion is red at HEAD, and `shell-terminal-strip`'s refetch assertion was broken by the plan-attribution stream removing the `isKnown` guard in this shared tree. `npm run catalog:check` is also red, but regeneration to a scratch copy produced an identical endpoint path set and a byte-identical `/terminals/relay` entry, so subtask 5's manual catalog registration is correct and that drift belongs to other uncommitted work.
