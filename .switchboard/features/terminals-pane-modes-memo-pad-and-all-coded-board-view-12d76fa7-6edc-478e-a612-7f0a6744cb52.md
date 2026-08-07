# Terminals Pane Modes — Memo Pad and All-Coded Board View

**Complexity:** 6

## Goal

Extend the Terminals grid's non-terminal pane modes. Adds a memo pane mode alongside kanban mode (widening paneModes from two values to three and reclassifying its hardcoded call sites into board-specific vs unavailable-for-a-terminal predicates), and adds an ALL CODED aggregate option to the kanban pane's column picker that unions the coder columns client-side because the server deliberately refuses AUTOCODE as a column ref.

Both subtasks make an empty pane in the Terminals cockpit more useful without leaving the grid: today a dead slot can only ever become a single-column board viewer. The problem they share is that the pane grid's two most useful surfaces are both under-expressive — the mode dimension has exactly two values, and the column picker can show exactly one column — so the operator has to navigate away from the terminals to capture a thought, and can only watch a third of the work that is out for coding. Both are confined to `src/webview/terminals.js` + `src/webview/terminals.html`, with no `.ts` change, no verb-catalog regeneration and no migration.

## How the Subtasks Achieve This

- **Add an "All Coded" Aggregate Option to the Terminals Kanban-Pane Column Picker**: Appends a synthetic `CODED_AUTO` / "ALL CODED" entry to the kanban pane's column picker, derived from the live structure's `kind === 'coded'` columns rather than hardcoded ids, so a custom coded column joins the union automatically. Because `CODED_AUTO` exists nowhere server-side and `getBoardCards` filters columns with a literal `===` compare, the aggregate fetch omits `column` entirely and filters client-side — sending the synthetic id would silently return an empty list that reads as "nothing is out for coding". Adds a per-row column chip (and `c.column` to the body signature so the chip stays fresh) to keep the merged list legible. This is the "see all the coding work at once" half of the feature.
- **Add a Memo Pane Mode to the Terminals Grid, Alongside Kanban Mode**: Widens `paneModes` from `'terminal' | 'kanban'` to include `'memo'`, replacing every hardcoded `=== 'kanban'` comparison with one of two intent-named predicates — `isBoardMode` (poll, board fetch, post-response re-render, column picker) and `isNonTerminalMode` (seating, `isFree`, `fillEmptyPanes`, drag-drop target, displacement scan). On top of that it adds `renderMemoPane`: a debounced-autosave textarea wired to the already-live `memoLoad` / `memoSave` / `memoClear` / `memoGeneratePrompt` / `memoListWorkspaces` verbs, with a Send-to-Planner button and flush-on-every-teardown-path discipline. This is the "capture an observation without leaving the cockpit" half.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. Nothing from another feature must land first. Both subtasks are additive within two webview files and touch no `.ts` file, so the PRD's return-contract ratchet, parity and push-routing gates are unaffected by construction.
- **Shipping order within this feature — strict, and it is a merge-order constraint, not a functional one:**
  1. **ALL CODED aggregate column** (complexity 4) — small and local to `buildColumnList`, `renderKanbanPane`'s picker/body/rows, and `fetchBoardCardsForPane`.
  2. **Memo pane mode** (complexity 6) — structural, rewriting the mode predicates plus `updatePaneElement`, the empty-slot placeholder, `toggleFocusedPaneKanban` and the persistence arrays.

  Rationale: both edit `src/webview/terminals.js` and `src/webview/terminals.html`, and the PRD's orchestration rule is one agent stream per file — they must **serialise**, never run in parallel. The smaller, lower-risk plan goes first so the risky predicate reclassification rebases onto a settled `renderKanbanPane` rather than the reverse. The memo plan also extracts a shared `showOnlyPaneModeButton(actionsEl)` helper out of `renderKanbanPane`, which is cleaner to do against that function's final shape.
- **Reconciled shared surfaces (no contradictions found):** the two plans touch disjoint regions of the same file. ALL CODED owns `buildColumnList`, the column picker, `bodySig`, the row meta block and `fetchBoardCardsForPane`; memo mode owns the `paneModes` predicates, `loadLayoutSettings`/`saveLayoutSettings`/`renderPaneGrid` padding, `updatePaneElement`'s branch and stale-sweep, the empty-slot placeholder and its delegated click handler. Three deliberate reconciliations: (a) `fetchBoardCardsForPane`'s post-response `paneModes[index] === 'kanban'` re-check stays **board-specific** after the memo widening — widening it would call `renderKanbanPane` on a memo pane; (b) the 5 s poll start and slot collection likewise stay board-specific, so a memo pane never starts the board poll; (c) the `actionsEl.children[4]` mode-button hide loop is **extracted once** by the memo plan instead of copied, so the two render functions cannot drift when the header button order changes.
- **Prerequisites / guards:** the extension (or `npx switchboard`) must be running so the pane can reach `/kanban/verb/*` and `/memo/verb/*`; both are already-wired verbs. No new setting, no default-OFF flag. Both plans' verification is manual — this session runs no compile and no tests.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Add a Memo Pane Mode to the Terminals Grid, Alongside Kanban Mode](../plans/feature_plan_20260807090100_terminals-pane-memo-mode.md) — **PLAN REVIEWED**
- [ ] [Add an "All Coded" Aggregate Option to the Terminals Kanban-Pane Column Picker](../plans/feature_plan_20260807090200_terminals-kanban-pane-all-coded-aggregate-column.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

