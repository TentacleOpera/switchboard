# The DISPATCH toggle on the Planned column shows how many plans are staged

## Goal

Put a count on the **DISPATCH** toggle in the Planned column header, so the number of staged plans is legible without switching views.

### Problem

The Dispatch view is a display mode of the Planned column, reached by a toggle button that reads `DISPATCH` (`src/webview/kanban.html:5600-5602`). The button says nothing about what is in there. After pressing Analyze — which stages a parallel-safe subset and leaves the rest behind — the only way to learn how many plans were staged is to press the toggle and count, then press it again to get back. The number the user most wants immediately after an analysis run is the one number the UI does not show.

The same gap makes a failed or partial analysis invisible: a run that staged nothing looks identical to a run that staged eight.

### Root cause

Not a defect — an affordance that was never built. The toggle was added as a mirror of the Backlog toggle on the New column (`:5593-5595`), which also carries no count, and neither inherited the `column-count` badge that every column header has (`:5609`, `:5614`, rendered as `count-<columnId>`).

### Verified against the tree (improve pass, 2026-08-08)

Every line reference in this plan was re-read on `main`. The following facts were established during the improve pass and the implementation now depends on them:

- **`filterCardsByProject` does not exist.** The board's project filter helper is `applyBoardProjectFilter(cards)` (`:4423-4429`). A repo-wide search for `filterCardsByProject` returns zero hits. The original draft of Change 1 named the non-existent function.
- **`currentCards` is already project-filtered; `allCards` is the unfiltered cache.** `updateBoard` caches `msg.cards` verbatim into `allCards` (`:7886`), derives `nextCards = applyBoardProjectFilter(allCards)` (`:7887`), and every assignment of `currentCards` is downstream of that filter (`:6427` inside `renderBoard`, `:8962` on a project-dropdown change). So `currentCards` needs **no** further project filtering.
- **The column headers are NOT re-rendered on a board refresh.** `renderColumns()` (`:5546`) rebuilds the whole board shell via `kanbanBoard.innerHTML = …` and is called from exactly six places: the drag-drop mode toggle (`:5792`), `backlogViewState` (`:8178`), `dispatchViewState` (`:8184`), `updateColumns` (`:8196`), first paint (`:9065`), and the collapse-coders toggle (`:9348`). It is **not** called from `updateBoard`, and **not** called on a project-filter change (`:8962-8964` calls `renderBoard` only). This is deliberate — a full shell rebuild would destroy every column body and rebind every listener on each refresh.
- **Counts stay live through two lighter paths instead.** `renderBoard` writes `count-<col>` from `computeColumnOccupancy` (`:6503`, written at `:6547`), and `refreshColumnCounts()` (`:6403`, sole caller `:7996`) patches the same spans by id without touching card DOM. Any header value that must stay current has to be reachable from these paths, not from the `renderColumns()` template alone.
- **Five sites patch count badges directly during an optimistic move**, bypassing both paths above: `moveCardElements` (`:5307-5311`, `:5314-5318`) and the drop/confirm handlers at `:7345-7347`, `:7477-7481`, `:7561-7562`, `:8470-8472`.
- **`computeColumnOccupancy` can never produce a DISPATCH count.** It strips DISPATCH cards outright when `!showingDispatch` (`:6382-6383`) and remaps DISPATCH → PLAN REVIEWED when showing (`:6391`). Neither state yields a standalone DISPATCH figure.
- **Tooltips read `data-tooltip` live.** `showTooltip` calls `el.getAttribute('data-tooltip')` at hover time (`:4175-4177`), so patching the attribute after render is sufficient — no rebind needed.

## Metadata

**Complexity:** 4
**Tags:** frontend, ui, ux
**Project:** Browser Switchboard

> **Superseded:** **Complexity:** 3 · **Tags:** frontend, ui, ux, dispatch
> **Reason:** Two corrections. (1) `dispatch` is not in the allowed tag vocabulary, so it silently drops on import. (2) The work is no longer one template string: the count must be reachable from four independent update paths (`renderColumns`, `renderBoard`, `refreshColumnCounts`, `moveCardsOptimistically`) because the column header is not re-rendered on a board refresh. That is a small multi-site change in the most contended file in the repo, and its correctness condition is "every count-updating path calls the helper" — squarely a 4, not a 3.
> **Replaced with:** **Complexity:** 4 · **Tags:** frontend, ui, ux

## User Review Required

None.

## Complexity Audit

### Routine

- Rendering a number inside the existing `backlog-toggle-btn` markup at `:5600-5602`.
- Deriving the count: one `.filter().length` over an array already in scope.
- Patching the button's text and `data-tooltip` by id — the same DOM-patch shape `refreshColumnCounts` already uses for `count-<col>` (`:6413-6415`).

> **Superseded:** "Recomputing it on the same board refresh that already re-renders the column headers."
> **Reason:** Factually wrong, and it was the assumption that made this plan look like a one-liner. `renderColumns()` — the only thing that re-renders the column headers — is never called from `updateBoard`. A board refresh calls `renderBoard()` (and sometimes `refreshColumnCounts()`), neither of which touches the header shell. A count baked into the `renderColumns()` template would therefore be correct at first paint and after a view toggle, and stale from the moment Analyze stages anything.
> **Replaced with:** The count must be patched from every path that can change it — see Change 1. Recomputation is cheap (one filter over an in-memory array), but its *placement* is the whole problem.

### Complex / Risky

- **Four update paths, one number.** The header shell renders on a different cadence than the card bodies. A count that lives only in the `renderColumns()` template is stale in exactly the state it exists to inform. See Change 1.
- **The count must obey the same filters the board obeys, or it repeats a known bug.** `feature_plan_20260803075219_kanban-column-counts-ignore-project-filter.md` exists because the column-count badges ignore the active project filter. A new badge computed from the raw `allCards` list would ship that same defect on day one.
- **DISPATCH cards are stripped from `displayCards` in the default view.** `:6382-6383` and `:6471-6472` filter `card.column !== 'DISPATCH'` whenever `showingDispatch` is false — which is precisely when the count needs rendering. The count must be computed *before* that strip, from the pre-filter card list.
- **Subtask exclusion.** The board's display contract is `displayCards.filter(card => !card.featureId)` (`:6388`, `:6481`). A count that includes subtasks would report a number the user can never see in the column, and would disagree with the Dispatch view's own card count.
- **Optimistic-move window.** Five sites adjust badge text arithmetically instead of re-deriving it (`:5307`, `:5314`, `:7345`, `:7477`, `:7561`, `:8470`). A drag into or out of the Dispatch view inside the optimistic guard window updates `currentCards` in place (`:5354-5357`) but fires no full render, so the toggle count needs an explicit call there too.

## Edge-Case & Dependency Audit

### Race Conditions

> **Superseded:** "None meaningful. The count is derived from the same card array the header render already consumes, in the same synchronous pass — it cannot drift from the rendered board."
> **Reason:** The premise is false. The header render (`renderColumns`) and the card render (`renderBoard`) are separate functions on separate cadences; the header is not part of the refresh pass. Drift is not a race here — it is the *default* behaviour unless the count is patched from the refresh paths.
> **Replaced with:** the analysis below.

- **Header-vs-body drift (the real hazard, and it is not a race).** `renderBoard` runs on every board refresh; `renderColumns` does not. Mitigated structurally: the count lives in a helper called from both, plus `refreshColumnCounts` and `moveCardsOptimistically`.
- **Optimistic guard window.** `refreshColumnCounts`'s only caller is already gated on `!optimisticActive` (`:7995`), and `moveCardsOptimistically` mutates `currentCards` before arming the guard (`:5354-5359`). Calling the helper at the end of `moveCardsOptimistically` therefore reads post-mutation state and cannot be stomped by a suppressed refresh.
- **Pre-first-refresh.** `renderColumns()` runs at `:9065` before `renderBoard([])` and before any `updateBoard`, so `currentCards`/`allCards` are `[]`. The count is `0` and nothing renders — the intended resting state.

### Security

- None. Display-only, no new message, no new state.

### Side Effects

- The Planned header grows slightly wider. Column headers already accommodate a `column-count` span plus up to three icon buttons on this column (`:5688` analyze, `:5695` send-to-coder, `:5650` copy-prompt), so the row is tight — the count must be compact (`DISPATCH 4`, not `DISPATCH (4 plans)`).
- When the view is toggled on, the button reads `PLANNED` and shows no count (see Change 1). Showing a stale DISPATCH number next to a `PLANNED` label is the one visibly wrong state.
- `refreshColumnCounts` currently only ever changes numbers for hidden-project cards. Adding the toggle-count call gives it a second, always-relevant job; its comment (`:6398-6401`) should be updated so the next reader does not assume it is still narrow.

### Dependencies & Conflicts

- **`src/webview/kanban.html` is heavily contended** — five other Planned plans edit it, including the sibling `feature_plan_20260808120000_dispatch-analyze-candidate-set-scope-and-features.md` and `feature_plan_20260803075219_kanban-column-counts-ignore-project-filter.md`. Serialise; do not run this beside any of them (PRD: one agent stream per file).
- The four insertion points (`renderColumns` ~`:5600`, `renderBoard` ~`:6547`, `refreshColumnCounts` ~`:6416`, `moveCardsOptimistically` ~`:5366`) do not overlap the sibling plans' edit sites, but they are in the same file, so the constraint is the file, not the hunk.

## Dependencies

- **Soft, ordering only: `feature_plan_20260803075219_kanban-column-counts-ignore-project-filter.md`.** That plan moves `applyBoardProjectFilter` inside `computeColumnOccupancy` so the `count-<col>` badges respect the active project. Either order works; this plan derives its own filtered count regardless.

> **Superseded:** "If it lands first, this badge can reuse the corrected helper instead of hand-rolling a filtered count."
> **Reason:** Impossible in either order. `computeColumnOccupancy` removes DISPATCH from its input when `!showingDispatch` (`:6382-6383`) and folds it into PLAN REVIEWED when `showingDispatch` (`:6391`), so it never emits a DISPATCH figure — before or after that plan lands. The only shared benefit is consistency of *intent* (both counts respect the project filter), not code reuse.
> **Replaced with:** This plan derives its own count from the project-filtered card list in both orderings. If the sibling lands first, no change here; if this lands first, note to that plan's author that a second filtered count now exists in the file so the two stay consistent.

- **`dispatcher-column-and-bounce-analysis.md` (`CODE REVIEWED`)** shipped the toggle this plan decorates. Already landed.
- No session (`sess_…`) dependencies.

## Adversarial Synthesis

Key risks: (1) the column header is not re-rendered on a board refresh, so a count baked into the `renderColumns()` template is stale in exactly the state it exists to inform — the moment after Analyze stages cards; (2) the count must apply the board's three display filters (project, DISPATCH column, `!featureId`) or it disagrees with the cards the Dispatch view actually renders, repeating the known column-count filter bug and over-reporting staged features by their subtask count; (3) the original draft named a non-existent helper (`filterCardsByProject`) and double-filtered an already-filtered array. Mitigations: one `dispatchToggleLabel()` + `updateDispatchToggleCount()` pair called from all four count-changing paths; derive from `currentCards` (already project-filtered) with `column === 'DISPATCH' && !featureId`; a source-text contract test pinning both the filter predicate and the four call sites.

## Proposed Changes

### 1. `src/webview/kanban.html` — one label builder, one DOM patcher, four call sites

> **Superseded:** Compute `const dispatchStagedCount = filterCardsByProject(currentCards).filter(c => c.column === 'DISPATCH' && !c.featureId).length;` at `:5597-5602` and interpolate it into the `dispatchToggleBtn` template string.
> **Reason:** Three defects. (a) `filterCardsByProject` does not exist — the helper is `applyBoardProjectFilter` (`:4423`); the code as written throws `ReferenceError` on first paint and blanks the board. (b) `currentCards` is already project-filtered at every assignment (`:6427`, `:7887`→`:6427`, `:8962`), so filtering it again is redundant. (c) Most importantly, a value that lives only inside the `renderColumns()` template is only recomputed when `renderColumns()` runs — never on a board refresh (`:8178`/`:8184`/`:8196`/`:5792`/`:9065`/`:9348` are its only callers). The badge would read `DISPATCH` while four plans sat staged.
> **Replaced with:** the label builder + DOM patcher below, called from every path that can change the number.

**Logic:** The count is a derived display value with four independent triggers. Express the label in one place and patch it in one place, then call that patcher from each trigger — the same shape `refreshColumnCounts` already uses for `count-<col>`.

**Implementation:**

**(a) Two helpers**, placed next to `refreshColumnCounts` (after `:6416`) so they sit with the other count logic:

```js
// Staged-plan count for the DISPATCH toggle on the Planned column header.
// Derived from currentCards, which is ALREADY project-filtered at every
// assignment (:6427, :7887, :8962) — do not re-apply applyBoardProjectFilter.
// Read BEFORE renderBoard's `card.column !== 'DISPATCH'` strip (:6383, :6472),
// which is why this cannot come from displayCards or computeColumnOccupancy.
// `!card.featureId` mirrors the board's subtask roll-up contract (:6388, :6481):
// a staged feature is ONE card in the Dispatch view, not one-plus-its-subtasks.
function dispatchStagedCount() {
    if (!Array.isArray(currentCards)) return 0;
    return currentCards.filter(c => c.column === 'DISPATCH' && !c.featureId).length;
}

// The header shell (renderColumns) is NOT rebuilt on a board refresh, so the
// toggle's label has to be patchable in place. Both the template at :5600 and
// every refresh path go through this.
function updateDispatchToggleCount() {
    const btn = document.getElementById('btn-toggle-dispatch');
    if (!btn) return;                       // Planned column not rendered (or collapsed away)
    const n = showingDispatch ? 0 : dispatchStagedCount();
    btn.textContent = showingDispatch ? 'PLANNED' : (n ? `DISPATCH ${n}` : 'DISPATCH');
    btn.setAttribute('data-tooltip', showingDispatch
        ? 'Switch to Planned view'
        : (n ? `Switch to Dispatch view — ${n} plan${n === 1 ? '' : 's'} staged` : 'Switch to Dispatch view'));
}
```

**(b) First paint** — leave the `dispatchToggleBtn` template at `:5600-5602` structurally unchanged (label and tooltip in their current form), and call `updateDispatchToggleCount()` immediately after the `btn-toggle-dispatch` click listener is bound (`:5734-5736`). The template stays the resting state; the patcher owns the number. This keeps one authority for the label instead of duplicating the ternary in a template string and a helper.

**(c) Board refresh** — call `updateDispatchToggleCount()` in `renderBoard`, alongside the existing occupancy write-back (after the `columns.forEach` count loop that ends around `:6560`).

**(d) Lightweight refresh** — call it at the end of `refreshColumnCounts()` (after `:6416`), and widen that function's comment (`:6398-6401`): it is no longer only about hidden-project occupancy.

**(e) Optimistic move** — call it at the end of `moveCardsOptimistically()` (after `:5366`), which has already mutated `currentCards` in place (`:5354-5357`) by that point.

**Decisions, stated rather than left open:**

- **Zero renders no number**, not ` 0` — an empty Dispatch set is the resting state and a persistent `0` is noise.
- **When the view is active the button reads `PLANNED` with no count.** The staged cards are on screen; the number is redundant, and pairing a DISPATCH count with a `PLANNED` label is the one actively misleading combination.
- **The count sits inside the button, not in a separate `column-count` span.** The header's `count-<columnId>` badge is owned by the occupancy path and means "cards in this column"; a second free-floating number in the same row would be ambiguous. Patching `btn.textContent` needs no extra element.
- **No project re-filter.** `currentCards` is the project-filtered set. This is the one place a well-meaning "be safe, filter again" edit would introduce a bug (double-filtering is harmless for a named project but `applyBoardProjectFilter` is not idempotent-safe to reason about across future edits) — and it is why the helper carries the comment.

**Edge cases:**

- `currentCards` empty or not yet an array mid-load → `0`, nothing renders.
- Planned column absent from `renderDefs` (custom column sets) → `getElementById` returns null, helper returns early. No throw.
- `collapseCodersEnabled` does not affect the Planned column (`:5553-5567` only synthesises the coder columns), so no interaction.
- Unassigned board: `currentCards` already reflects `applyBoardProjectFilter`'s `'__unassigned__'` branch (`:4425-4426`, `cards.filter(c => !c.project)`) — no sentinel handling needed here.

### 2. `src/webview/kanban.html` — tooltip states the number too

**Logic:** The tooltip is where a number can be spelled out without crowding the header.

**Implementation:** Folded into `updateDispatchToggleCount()` above — `Switch to Dispatch view — N plan(s) staged` when inactive, `Switch to Planned view` when active. Singular/plural on `n === 1`. `showTooltip` reads `data-tooltip` at hover time (`:4175-4177`), so patching the attribute is sufficient.

> **Superseded:** "Extend the existing `data-tooltip` at `:5601`."
> **Reason:** Splitting the label and the tooltip across two owners (a template string and a helper) is how they drift. Both derive from the same `n`; both belong in the same function.
> **Replaced with:** tooltip set inside `updateDispatchToggleCount()`, from the same `n` as the label.

**Edge cases:** With zero staged, the tooltip reads `Switch to Dispatch view` with no clause — matching the badge's zero-renders-nothing rule.

## Verification Plan

### Automated Tests

A source-text contract test in the manner of `src/test/kanban-render-guard-contract.test.js` (same read-the-file-and-assert style), asserting:

1. `dispatchStagedCount` filters on **both** `column === 'DISPATCH'` and `!` … `featureId` — the two display filters the count must honour.
2. `dispatchStagedCount` derives from `currentCards` and does **not** call `applyBoardProjectFilter` (guards the double-filter regression) and does not reference `displayCards` or `computeColumnOccupancy` (guards deriving it after the DISPATCH strip).
3. `updateDispatchToggleCount(` appears in the bodies of all four of `renderBoard`, `refreshColumnCounts`, `moveCardsOptimistically`, and `renderColumns` — the staleness guard. This is the assertion that would have failed against the original draft.
4. `filterCardsByProject` appears nowhere in the file (the non-existent helper the first draft named).

### Manual

1. **Baseline:** empty Dispatch set — the toggle reads `DISPATCH` with no number and the plain tooltip.
2. **After a stage:** drag one plan to Dispatch (or run Analyze) — the toggle reads `DISPATCH 1`, tooltip `… — 1 plan staged`.
3. **Several:** stage four — reads `DISPATCH 4`, tooltip pluralised.
4. **Toggled on:** press it — the label reads `PLANNED` with no count; press again to confirm the count returns.
5. **Project filter:** with plans staged under two projects, switch the board filter — the count changes to match the visible project, and equals the number of cards the Dispatch view then renders. *(This step exercises `:8962-8964`, which calls `renderBoard` but not `renderColumns` — it is the check that fails if the count lives only in the header template.)*
6. **Feature staged:** stage a feature with 3 subtasks — the count increments by **1**, not 4, and matches the single card the Dispatch view shows.
7. **Live update:** stage a plan from another surface (or `POST /kanban/move` via the API) and let the board refresh **without touching the toggle** — the count updates. *(Exercises the `updateBoard` → `renderBoard` path. The second check that the original design would fail.)*
8. **Optimistic move:** in Dispatch view, drag a card out to a coder column and watch the toggle during the guard window — the count decrements immediately, and still reads correctly after the backend confirm lands.
9. **Standalone:** repeat 1-3 under `npx switchboard` — the webview is shared (`src/services/headlessPanelHtml.ts`), so the badge appears identically.

## Rejected Alternatives

- **A separate badge element beside the toggle.** Rejected: the Planned header already carries up to three icon buttons plus the column count; a fourth element makes the row wrap at narrow widths, and two adjacent numbers with different meanings is worse than one. *(Note: patching `btn.textContent` from a helper is not this — it is still one number inside one control.)*
- **Computing the count backend-side and pushing it in the board payload.** Rejected: the project filter is webview-owned (`boardProjectFilter`, `:4404`), so the backend cannot compute the user-visible number. The cards are already local and the filter is a synchronous array op.
- **Reusing `computeColumnOccupancy`.** Rejected on the code: it strips DISPATCH when `!showingDispatch` (`:6382-6383`) and remaps it when `showingDispatch` (`:6391`), so it structurally cannot report a DISPATCH count.
- **Baking the count into the `renderColumns()` template only.** Rejected: `renderColumns()` is not on the board-refresh path, so the value would be stale from the first stage until the next view toggle — correct in a demo, wrong in use.
- **Calling `renderColumns()` from `updateBoard` so the template stays authoritative.** Rejected: it does `kanbanBoard.innerHTML = …`, destroying every column body and listener on every refresh. That is precisely why the codebase has the lightweight `refreshColumnCounts` path.
- **Always showing `0`.** Rejected: the resting state of this control is empty, and a permanent zero trains the eye to ignore the number.

## Agent Recommendation

Complexity 4 → **Send to Coder.** Two small helpers plus four one-line call sites in a single file. It is no longer intern work: the whole correctness of the feature rests on knowing that the column header is not re-rendered on a board refresh, which is not visible from the edit site.
