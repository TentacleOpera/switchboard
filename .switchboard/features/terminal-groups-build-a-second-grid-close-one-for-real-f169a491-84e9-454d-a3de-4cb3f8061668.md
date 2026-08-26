# Terminal Groups — Build a Second Grid, Close One for Real

**Complexity:** 5

## Goal

Make the group machinery in the Terminals panel support the two gestures an operator needs at the start and end of a run. FILL GRID currently refuses to build a second grid of a role it has already used, because the count is fleet-wide, so four planners make the role permanently spent. The group tab's close button deletes the label while leaving every terminal running, so ending a nine-terminal group is ten clicks, the first of which changes nothing.

## How the Subtasks Achieve This

- **FILL GRID Must Build a Second Grid of a Role It Has Already Used**: gives FILL GRID an explicit destination (new group / current grid) and scopes the terminal count to that destination's **empty seats** instead of the whole fleet, so a role is no longer single-use. Also fixes the two defects riding on the same function — the silent group-lock drop, and created terminals never being registered as group members. Introduces `createManualGroup` as the single creation site of the manual-group record.
- **The Group Tab's × Leaves Every Terminal Running**: adds `closeGroup(id)` — sequential closes sharing one fleet refetch, with the refetch ahead of the re-seat — retargets the tab `×` to it with an honest member count in the tooltip and aria-label, and moves the non-destructive verb to an explicit **Hide** entry in the `»` menu, which becomes permanent whenever a group exists so that verb is reachable on a strip that does not overflow.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [The Group Tab's × Deletes the Group Label and Leaves Every Terminal Running](../plans/feature_plan_20260813100000_group-tab-close-leaves-every-terminal-running.md) — **PLAN REVIEWED** — ID: cba0ac6f-48c5-4a01-b486-0b3dd0b60445
- [ ] [FILL GRID must build a second grid of a role it has already used](../plans/feature_plan_20260814100824_fill-grid-refuses-a-second-grid-of-the-same-role.md) — **PLAN REVIEWED** — ID: 6d972b6d-40f3-41b6-8f00-67dd8da4d0c0
<!-- END SUBTASKS -->

## Dependencies & sequencing

**Shared surfaces (verified against source, not inferred from titles).**

| Surface | FILL GRID | Group `×` | Contention |
| :-- | :-- | :-- | :-- |
| `src/webview/terminals.js` — group region (2238-2400) | inserts `createManualGroup` above `saveCurrentAsGroup`; rewrites `saveCurrentAsGroup` / `saveSelectionAsGroup`; adds `persist` to `addTerminalToActiveGroup` | inserts `closeGroup` after `saveSelectionAsGroup`; rewrites `deleteGroup`'s doc comment | **Ordering** — adjacent edits in one region, no logical conflict |
| `src/webview/terminals.js` — `fillGrid` (6474) / `closeTerminal` (6665) / `renderGroupTabStrip` (2770) | `fillGrid` only | `closeTerminal` + `renderGroupTabStrip` only | None — disjoint |
| `src/webview/terminals.html` | fill form + `.fill-grid-form` CSS | `.group-tab-overflow-hide` CSS | None — disjoint |
| `src/test/terminal-sidebar-groupings-contract.test.js` | rewrites `:668-680` (`saveCurrentAsGroup`) | rewrites `:272-275`, `:600-602`; adds a `closeGroup` test | **Ordering** — same file, different tests |
| `src/test/terminal-open-all-seating-contract.test.js` | rewrites `:135-159`; adds the single-creation-site test | untouched | None |
| `src/test/terminal-pane-pinning-contract.test.js` | untouched | untouched (the pin edit that would have broken `:89-93` was superseded) | None |

**Sequencing.**

- **Land FILL GRID first.** Not because of a data-shape dependency — `closeGroup` removes a manual record and prunes `groupPrefs`, it never constructs one, so it does not need `createManualGroup` to exist. The reason is mechanical: FILL GRID is the larger rewrite of the same region of `terminals.js` and of the same contract file, so it is cheaper to rebase the smaller change onto it than the reverse.

  > **Superseded:** "Land FILL GRID first. It introduces `createManualGroup` as the single writer of the `{ id, name, source:'manual', layout, members, order }` shape … The close-group subtask removes a manual group record and prunes its `groupPrefs` entries — it has to agree with that shape, not race it into existence."
  > **Reason:** the stated dependency does not exist. `closeGroup`'s manual arm is `terminalGroups.filter(g => g.id !== id)` plus two `groupPrefs` prunes — it reads an `id` and writes nothing shaped. Either order is functionally safe; the real constraint is same-file collision, which is a merge concern, not a contract one. Recording a false hard dependency invites a coder to block on it.
  > **Replaced with:** the mechanical rebase-cost argument above.

- **Serialise the two; do not dispatch concurrently.** Both edit `src/webview/terminals.js` and both amend `src/test/terminal-sidebar-groupings-contract.test.js`. Concurrent edits collide in both files.

  > **Superseded:** "Both edit the same group region of `src/webview/terminals.js` (`getGroupMembers`, `deleteGroup` / `switchToGroup` / `clearGroupLock`, `renderGroupTabStrip`), and both amend `src/test/terminal-open-all-seating-contract.test.js`."
  > **Reason:** both halves are wrong on the specifics. Neither plan modifies `getGroupMembers`, `switchToGroup` or `clearGroupLock` — they only call them; only the close subtask touches `renderGroupTabStrip`; and only the FILL GRID subtask touches `terminal-open-all-seating-contract.test.js`. The genuinely shared test file is `terminal-sidebar-groupings-contract.test.js`, which the original analysis did not name and neither plan originally claimed — yet both break assertions in it.
  > **Replaced with:** the shared-surface table above. The conclusion (serialise) is unchanged; the evidence for it is now correct.

- **`src/test/terminal-sidebar-groupings-contract.test.js` is the file to watch.** Each subtask breaks assertions in it that the other does not touch, and each now owns its own rewrites: FILL GRID owns `:668-680`, the close subtask owns `:272-275` and `:600-602`. A coder who runs only the contract file named in their own plan will miss the breakage.

- **Source-text block markers are a real constraint on where new functions may be declared.** That contract file brackets the group region with `deleteGroup → clearGroupLock`, `clearGroupLock → saveSelectionAsGroup`, and `saveCurrentAsGroup → deleteGroup`. `createManualGroup` goes **above** `saveCurrentAsGroup`; `closeGroup` goes **after** `saveSelectionAsGroup`. Both plans state this; do not relocate them for tidiness.

- Neither subtask needs a backend change, a new verb, or a schema change, so there is no cross-host ordering constraint inside this feature.

- **Note on the close subtask's derived-group behaviour:** closing a derived tab (`Coders`, `Planners`) must *not* write `groupPrefs.hidden` — that is the single behavioural difference between the destructive and non-destructive verbs, and it is what lets the tab legitimately reappear when new terminals of that role are opened.

- **Note on the derived tab after a second grid exists:** with eight planners live, the strip shows a derived `Planners` (8) alongside `Planner 1` (4) and `Planner 2` (4). That is correct — the derived tab is a role filter, not a grid. Neither subtask may suppress it, and the close subtask's `×` on that derived tab legitimately ends all eight.
