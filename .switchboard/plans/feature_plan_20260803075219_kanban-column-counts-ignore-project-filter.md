# Kanban Column Plan Counts Ignore Project Filter

## Goal

When a project filter is active on the Switchboard kanban board, the plan count badges at the top of each column display cumulative counts across ALL projects instead of reflecting only the filtered project's plans. For example, creating a new project with 0 plans still shows the full cumulative count in every column.

### Root Cause

`computeColumnOccupancy` (kanban.html:6209) receives the **unfiltered** `allCards` cache from both of its call sites:

- `renderBoard` at line 6326: `computeColumnOccupancy(allCards.length ? allCards : cards)`
- `refreshColumnCounts` at line 6234: `computeColumnOccupancy(allCards.length ? allCards : currentCards)`

The function itself does NOT apply `boardProjectFilter` — it only filters out backlog/created cards and subtasks. The comments at lines 6205–6208 explicitly state this was intentional ("so columns that hold cards only in other (hidden) projects still show their true counts"), but this design means the count badges never respect the active project filter.

Meanwhile, the actual card DOM IS correctly filtered: `renderBoard` calls `applyBoardProjectFilter(allCards)` at line 7655 to produce the visible `nextCards` set. So there is a mismatch — the cards shown are project-scoped, but the count badges are global.

The fix is to apply `applyBoardProjectFilter` inside `computeColumnOccupancy` so counts match the filtered view when a project filter is active, while preserving the "show all" behavior when no filter is set (`boardProjectFilter === null`).

### Verified against the tree (improve pass, 2026-08-03)

Every line reference above was re-read on `main` @ `7aebaf5` and is accurate as written. Additional facts established during the improve pass, which the implementation depends on:

- **`allCards` really is unfiltered.** `updateBoard` (kanban.html:7649–7655) caches `msg.cards` verbatim: *"The backend now sends unfiltered cards; the board owns its view filter."* The `setPushScope` verb (kanban.html:4311–4318 → `KanbanProvider.ts:7723` → `BroadcastHub.setWebviewScope`) declares a **per-connection render scope for factory-form pushes** (routing map, CLI-trigger state, mount-time snapshots). It does **not** filter the `updateBoard` card payload. So the root cause is correctly located client-side; there is no server-side card filter to fight.
- **The counting rules already match `renderBoard`'s bucketing rules.** Backlog/CREATED swap, `!card.featureId` subtask exclusion, and the "column not in `columns`" drop are identical in both paths (kanban.html:6213–6225 vs 6292–6321). Adding the project filter is the one remaining divergence.
- **The regression introduced the current behaviour on 2026-07-23** in commit `6b042b0` ("Board Kanban: Client-Side Project Filter (Skip Refresh on Dropdown Change)"), which added `computeColumnOccupancy` and the unfiltered-by-design comment as part of moving the board to client-side filtering. This plan reverts the *count* half of that decision while keeping the client-side filtering architecture.
- **No test pins the current behaviour.** No file under `src/test/` references `computeColumnOccupancy`, `refreshColumnCounts`, or `count-CODED_AUTO`. There is no second board implementation to keep in sync — `src/webview/project.js` / `project.html` render no column count badges.
- **Optimistic count arithmetic stays correct.** The five sites that mutate badge text directly (kanban.html:5188–5199, 7121–7123, 7245–7249, 7327–7328) only adjust counts for cards that resolved to a **DOM element**, i.e. cards that survived the project filter. Today a cross-project batch move silently *understates* the global badge (moved hidden cards have no DOM element, so no increment fires); after this fix the badge and the arithmetic operate on the same population, so that latent inconsistency disappears rather than growing.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, bugfix, ui

## User Review Required

- **Confirm the information trade-off.** After this change, a project-filtered board can show `0` in a column that holds work in another project. That signal ("there is hidden work over there") is the thing commit `6b042b0` was deliberately buying, and this plan removes it. The reported bug says that trade is wanted. If you want both, the follow-up is a *second* affordance (e.g. `3 (7)` or a tooltip), **not** a global badge — do not accept a compromise that leaves the primary number disagreeing with the cards on screen.
- **Confirm the dead-code decision.** The fix makes `refreshColumnCounts` (kanban.html:6233) and its `nextAllCardsSignature` trigger branch (kanban.html:7750–7758) unreachable-in-effect — see Change 3. This plan keeps the code and tells the truth in its comment. Deleting it instead is a clean but wider diff; say so if you want that.

## Complexity Audit

### Routine

- One new line inside one function: `displayCards = applyBoardProjectFilter(displayCards);`.
- `applyBoardProjectFilter` (kanban.html:4322–4328) is a pure filter with an identity fast-path (`if (boardProjectFilter === null) return cards;`), declared in the same script scope, so no ordering or hoisting concern.
- Both call sites already pass `allCards`; the filter lands inside the function, so neither call site changes.
- No new state, no new data flow, no message-protocol change, no backend change, no persisted shape change.
- The remaining edits are comment corrections.

### Complex / Risky

- **Deliberate information loss** (not a defect): count badges stop reporting other-project work. This is the requested behaviour; it is listed here because it is the one user-visible consequence that is not a bug fix. See User Review Required.
- **A live code path becomes vestigial.** `refreshColumnCounts` exists only to resync badges when a *hidden-project* card changes; once counts are project-scoped, that resync can never change a number. Left unmarked, the next reader will assume it is load-bearing. Mitigated by Change 3 (comment tells the truth) rather than by deletion.

## Edge-Case & Dependency Audit

**Race Conditions**

- **Optimistic move window.** `renderBoard` computes occupancy from `allCards`, while the DOM may hold optimistically-moved cards. `applyPendingOptimisticMoves` (applied at kanban.html:7654 *before* `applyBoardProjectFilter`) stamps the overlay onto `allCards` first, so the count and the DOM read the same overlaid state. Unchanged by this fix — the filter runs downstream of the overlay in both paths.
- **`refreshColumnCounts` vs an in-flight optimistic move.** Its only caller is already gated on `!optimisticActive` (kanban.html:7754), so a stale recompute cannot stomp an optimistically-adjusted badge. Unchanged.
- **Filter switch mid-push.** `setBoardProjectFilter` mutates the module-scoped `boardProjectFilter` synchronously; JS single-threading means a filter change and a `updateBoard` handler can never interleave *within* a render. Counts and cards therefore always resolve against the same filter value in a given tick.

**Security**

- None. Pure client-side display arithmetic over data already resident in the webview; no new IPC, no new user input, no interpolation into HTML (badge text is set via `textContent`).

**Side Effects**

- Count badges change value for every user with an active project filter — this is the intended, user-visible effect.
- The collapsed-coders aggregate badge (`count-CODED_AUTO`, kanban.html:6342 and 6238) is derived from `occupancyCounts`, so it becomes project-scoped automatically. No separate change needed; only its comment (line 6340) is now wrong.
- `refreshColumnCounts` becomes an effective no-op. Proof: `buildBoardSignature` (kanban.html:5387–5393) keys on `workspaceRoot|id|column|topic|planFile|complexity|lastActivity|isFeature|subtaskCount|featureId|working`. With no filter, `nextCards === allCards`, so the two signatures move together and the `else if (nextAllCardsSignature !== lastAllCardsSignature)` branch (7750) never fires. With a filter, the branch fires only when a *hidden-project* card changed — and after this fix, recomputing filtered counts from that changed cache yields identical numbers. Harmless (O(n) over `allCards` plus same-value `textContent` writes), but no longer meaningful.
- No change to `selectedCards` pruning, cross-project selection, worktree indicators, or dispatch.

**Dependencies & Conflicts**

- Single file: `src/webview/kanban.html`. No build-config, package, or schema dependency.
- No test asserts the current unfiltered semantics (verified: zero references under `src/test/`), so nothing goes red.
- Conflicts only with anything else editing `computeColumnOccupancy` / `renderBoard` in the same window. `src/webview/kanban.html` is not currently modified in the working tree (`git status` on `main` @ `7aebaf5` shows `KanbanProvider.ts`, `shell-terminal-strip.test.js`, `terminals.html`, `terminals.js` dirty — not this file).
- Reminder for whoever verifies by hand: the running extension loads from the installed extension folder, not this repo's `dist/`. Rebuild + reload (or sync to the install folder) before believing a manual test result.

## Dependencies

- None — no prior session output is required to execute this plan.

## Adversarial Synthesis

**Risk Summary.** The change is one line in one pure function, with no test pinning the old behaviour and no server-side interaction, so the correctness risk is close to zero; the real risks are (1) accepting a deliberate loss of the "hidden work exists elsewhere" signal, which the user must confirm, and (2) leaving `refreshColumnCounts` in the tree as a now-meaningless resync whose comment claims it keeps counts accurate. Mitigations: get explicit sign-off on the trade-off (User Review Required), rewrite the three stale comments so the next reader is not misled, and pin the behaviour with a source-text contract test so a future refactor cannot silently pass `allCards` straight back into the counter.

## Proposed Changes

### `src/webview/kanban.html`

**Context.** `computeColumnOccupancy` (line 6209) is the sole producer of column count badges, for both the full render (`renderBoard`, line 6326 → written at 6370 and 6343) and the lightweight resync (`refreshColumnCounts`, line 6234). The visible cards come from a different pipeline (`applyBoardProjectFilter(allCards)` at line 7655), which is where the two diverge.

**Logic.** Make the counter consume the same population the renderer does, by applying the board's own project filter inside the counter — after the backlog/CREATED swap and the subtask exclusion, before the counting loop. `applyBoardProjectFilter` is identity when `boardProjectFilter === null`, so the no-filter path is bit-for-bit unchanged.

---

**Change 1 — apply the project filter inside `computeColumnOccupancy` (line ~6219)**

Current code at lines 6209–6227:
```js
function computeColumnOccupancy(cards) {
    const counts = {};
    [...columns, ...CODED_IDS].forEach(c => { counts[c] = 0; });
    if (!Array.isArray(cards) || cards.length === 0) return counts;
    let displayCards = cards;
    if (!showingBacklog) {
        displayCards = cards.filter(card => card.column !== 'BACKLOG');
    } else {
        displayCards = cards.filter(card => card.column !== 'CREATED');
    }
    displayCards = displayCards.filter(card => !card.featureId);
    displayCards.forEach(card => {
        const effectiveCol = (showingBacklog && card.column === 'BACKLOG') ? 'CREATED' : card.column;
        const col = columns.includes(effectiveCol) ? effectiveCol : (CODED_IDS.includes(effectiveCol) ? effectiveCol : null);
        if (!col) return;
        counts[col] = (counts[col] || 0) + 1;
    });
    return counts;
}
```

Changed code:
```js
function computeColumnOccupancy(cards) {
    const counts = {};
    [...columns, ...CODED_IDS].forEach(c => { counts[c] = 0; });
    if (!Array.isArray(cards) || cards.length === 0) return counts;
    let displayCards = cards;
    if (!showingBacklog) {
        displayCards = cards.filter(card => card.column !== 'BACKLOG');
    } else {
        displayCards = cards.filter(card => card.column !== 'CREATED');
    }
    displayCards = displayCards.filter(card => !card.featureId);
    displayCards = applyBoardProjectFilter(displayCards);
    displayCards.forEach(card => {
        const effectiveCol = (showingBacklog && card.column === 'BACKLOG') ? 'CREATED' : card.column;
        const col = columns.includes(effectiveCol) ? effectiveCol : (CODED_IDS.includes(effectiveCol) ? effectiveCol : null);
        if (!col) return;
        counts[col] = (counts[col] || 0) + 1;
    });
    return counts;
}
```

The single new line is `displayCards = applyBoardProjectFilter(displayCards);` inserted after the subtask filter and before the counting loop.

**Implementation notes.**
- Insert it after the `!card.featureId` filter, not before — order is irrelevant to the result (both are pure predicates), but this ordering mirrors `renderBoard` and keeps a future reader from wondering whether it matters.
- Do **not** change either call site. Passing pre-filtered cards from the call sites would work but duplicates the predicate in two places and reopens the same divergence class this fix closes.
- The `allCards.length ? allCards : cards` fallback at line 6326 stays. When it takes the `cards` branch (first render before `allCards` is populated), the input is already filtered and `applyBoardProjectFilter` is idempotent, so double-filtering is a no-op.

**Edge cases.**
- **No filter (`boardProjectFilter === null`):** `applyBoardProjectFilter` returns cards unchanged — behavior identical to current. No regression.
- **`__unassigned__` filter:** `applyBoardProjectFilter` filters to cards with `!c.project` — counts will correctly reflect only unassigned plans. Cards are built with `row.project || ''`, so unassigned is `''`, and the `!c.project` test is correct for both `''` and `undefined`.
- **Named project filter:** Counts will reflect only that project's plans. This is the fix.
- **Collapsed coder columns (CODED_AUTO):** The `coderOccupancy` sums at lines 6238 and 6342 derive from `occupancyCounts` / `counts`, so both aggregate badges respect the filter after this change. Comment at 6340 updated in Change 2.
- **`refreshColumnCounts` (line 6233):** Fixed by the same change, since the filter is applied inside the function. Its own comment is corrected in Change 3.
- **Backlog view toggle:** `computeColumnOccupancy` already handles backlog/created filtering. The project filter is orthogonal and composes correctly.
- **Subtask hiding:** `computeColumnOccupancy` already excludes feature subtasks (`!card.featureId`). Project filter composes with this correctly.
- **Cross-workspace cards:** unchanged — `allCards` is already the current workspace's set; `applyBoardProjectFilter` does not touch `workspaceRoot`.

---

**Change 2 — correct the stale comments that assert unfiltered counts**

Lines 6205–6208 (above `computeColumnOccupancy`):
```js
// Compute per-column occupancy from the allCards cache, applying the active
// project filter so count badges match the visible (filtered) board. When no
// project filter is set (boardProjectFilter === null), counts reflect all cards.
// Applies the same backlog-view + subtask-hiding display rules as renderBoard.
```

Lines 6323–6325 (above the `renderBoard` call site):
```js
// Column occupancy is computed from the allCards cache with the active project
// filter applied, so count badges match the filtered board. Falls back to the
// passed-in cards before the first updateBoard populates allCards.
```

Line 6340 (inside the collapsed-coders branch):
```js
// Count badge reflects project-filtered occupancy across the three coder columns,
// matching the cards actually rendered into the collapsed container.
```

---

**Change 3 — tell the truth about `refreshColumnCounts` (lines 6229–6232)**

> **Superseded:** Update the comment at lines 6229–6232 to *"Lightweight count-only refresh: updates column count badges from the allCards cache (with project filter applied) without rebuilding card DOM. Used when the filtered board signature is unchanged but allCards changed (e.g. a card added to a hidden project) so occupancy counts stay accurate."*
> **Reason:** That wording keeps claiming the function does useful work, which is exactly what stops being true. Once counts are project-scoped, a hidden-project change cannot move any badge: with no filter the two signatures move together so the trigger branch (line 7750) never fires, and with a filter the recompute yields identical numbers. A comment that describes a dead path as load-bearing is worse than no comment — the next reader will preserve it under a false premise.
> **Replaced with:** state plainly that the path is now defensive, and why it is kept rather than deleted.

```js
// Count-only badge refresh from the allCards cache, without rebuilding card DOM.
// Its trigger (updateBoard: filtered signature unchanged, allCards signature
// changed) fires only for hidden-project changes — and since computeColumnOccupancy
// now applies the project filter, such a change can no longer move a badge. Kept as
// a cheap, side-effect-free resync path (its one caller is already gated on
// !optimisticActive) rather than deleted, so the count pipeline keeps a single
// non-render entry point. Do not add work here expecting it to run.
```

Deleting `refreshColumnCounts`, its call site at line 7755, and the `lastAllCardsSignature` bookkeeping (lines 7686, 7719, 7736, 7749, 7757) is the alternative. It is a legitimate cleanup but touches render-suppression bookkeeping that is easy to get subtly wrong, for zero behavioural gain — **out of scope for this plan** unless the user asks (see User Review Required).

## Verification Plan

**Manual — the reported bug.** Rebuild and reload the extension (or sync to the installed extension folder) before testing; the running extension does not load this repo's `dist/`.

1. **No filter (default):** Open kanban with no project filter. Column counts should show total plans across all projects — same as before the fix. Compare against pre-fix screenshots to confirm byte-identical numbers.
2. **Named project filter:** Select a project with plans. Each column's badge should equal the number of cards visible in that column.
3. **Empty project:** Create a new project with 0 plans. Select it. All column counts should show 0. *(This is the exact reported symptom.)*
4. **`__unassigned__` filter:** Select "Unassigned" in the project filter. Counts should reflect only plans with no project assignment.
5. **Collapsed coder columns:** Enable coder collapse mode with a project filter active. The `CODED_AUTO` aggregate badge should equal the number of cards rendered in the collapsed container.
6. **Backlog view toggle:** Toggle backlog view on/off with a project filter active. Counts should remain project-filtered in both modes, and the BACKLOG→CREATED remap should still be reflected.
7. **Card move:** Move a card between columns with a project filter active. Badges should update correctly (decrement source, increment target) and still agree with the visible card counts after the next board push.
8. **Filter switch:** Switch between two projects with different plan distributions without refreshing. Badges must track each switch (this exercises the client-side, no-refetch path that commit `6b042b0` introduced).
9. **Cross-project batch move:** With a filter active, select cards spanning the filtered project and another project (selection survives filtering by design), then move them. Badges must remain equal to the visible card counts after the board settles.

### Automated Tests

10. **New source-text contract test** (recommended; follows the existing `src/test/kanban-render-guard-contract.test.js` pattern — read `src/webview/kanban.html` as text and assert structure):
    - `computeColumnOccupancy`'s body contains `applyBoardProjectFilter(` — pins the fix against a refactor that reverts to counting `allCards` raw.
    - The `applyBoardProjectFilter` call appears **after** the `!card.featureId` filter and **before** the `displayCards.forEach` counting loop.
    - Neither `computeColumnOccupancy` call site (lines ~6234, ~6326) wraps its argument in `applyBoardProjectFilter(` — pins the "filter lives inside the function, exactly once" decision.
    - Wire it into `package.json` as `test:contract:kanban-column-counts` **and** add a step to `.github/workflows/integration-tests.yml`; a script entry alone does not run in CI.
11. No existing automated test covers this code path (verified: no `src/test/` file references `computeColumnOccupancy`, `refreshColumnCounts`, or `count-CODED_AUTO`), so no suite needs updating.

---

**Recommendation: Send to Intern** (Complexity 3).
