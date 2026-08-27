# Remove starred-count indicator from kanban control rail

## Goal

The kanban control rail displays a "number of plans starred" indicator (`#starred-count` element at `kanban.html:3063`) that shows the count of priority-starred cards (e.g., "3 starred" or "3 starred (all)"). This is pointless noise — the starring is already visible on the cards themselves (filled star icon), and the count adds no actionable information. The user has explicitly requested its removal.

The indicator is implemented in `kanban.html`:
- HTML: `#starred-count` div at line 3063–3066, with a star SVG and `#starred-count-text` span.
- CSS: `.card-btn.star-btn.starred` at line 1173 (this is the per-card star button styling, NOT the control rail indicator — should NOT be removed).
- JS: `updateStarredCount()` function at line 8830–8849, called from **two** sites: line 8822 (inside the column-count update path) and line 9119 (inside the board render path).

**Root cause:** The starred-count indicator was added in V63 as a "degenerate state" surfacing mechanism — to make an all-starred board visible. But the user considers it noise, not signal.

## Metadata

**Complexity:** 1
**Tags:** ui, refactor
**Project:** Browser Switchboard

## User Review Required

No user review required. This is a pure UI-element removal explicitly requested by the user. No behavior, data model, or contract is altered — only the count display and its update function are deleted. The per-card star toggle, sort precedence, and persistence are untouched.

## Complexity Audit

### Routine
- Remove the `#starred-count` HTML element from the control rail (`kanban.html:3063–3066`).
- Remove the `updateStarredCount()` function and its V63 comment block (`kanban.html:8825–8849`).
- Remove **both** call sites of `updateStarredCount()`: line 8822 (column-count update path) and line 9119 (board render path).
- The per-card star button (`.star-btn`) and its styling (`.star-btn.starred` at `kanban.html:1173–1175`) must NOT be removed — those are the actual star toggle buttons on each card.
- The `priorityStarred` card property, the `setPriorityStarred` message handler in `KanbanProvider.ts`, and the sort-precedence logic at `kanban.html:9021–9024` must NOT be removed — they implement the per-card star feature, which is independent of the count indicator.

### Complex / Risky
- None. This is a pure UI element removal. No backend changes, no data model changes, no API changes.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The indicator is a synchronous DOM update called from two deterministic points in the render/update pipeline. Removing both call sites and the function leaves no dangling references.
- **Security:** None. No auth, no input handling, no data flow affected.
- **Side Effects:** The only side effect is the loss of the "(all)" degenerate-state hint. The user has judged this acceptable. No other consumer reads `#starred-count` or `#starred-count-text`.
- **Dependencies & Conflicts:**
  - `kanban.html:3063–3066` — the `#starred-count` div in the control rail. Safe to remove.
  - `kanban.html:8825–8849` — the `updateStarredCount()` function plus its V63 comment. Safe to remove.
  - `kanban.html:8822` — call inside `updateCounts`-style path. Remove this call.
  - `kanban.html:9119` — call inside the board render path (after `updateStagingViewInfo()`). **Remove this call.** This is the second call site; leaving it after the function is deleted throws `ReferenceError: updateStarredCount is not defined` and breaks the entire board render.
  - `kanban.html:1173–1177` — `.card-btn.star-btn.starred` CSS. Styles the PER-CARD star button, NOT the indicator. Must NOT be removed.
  - `kanban.html:9585` — per-card `starBtn` rendering. Must NOT be removed.
  - `kanban.html:9241–9249` — star button click handler (`setPriorityStarred` message). Must NOT be removed.
  - `kanban.html:9021–9024` — star sort precedence (`priorityStarred` comparison). Must NOT be removed.
  - `KanbanProvider.ts:8694` / `:12558` — `setPriorityStarred` handler. Must NOT be removed.
  - `KanbanDatabase.ts:10464` — `setPriorityStarred` persistence. Must NOT be removed.
  - **No contract tests pin the starred-count indicator.** A grep for `starred-count` and `updateStarredCount` across `src/` returns matches only inside `kanban.html` itself (the element, the function, and the two call sites). The `priorityStarred` references in `src/test/batch-move-team-prompt-contract.test.js` and `src/test/transfer-bundle-contract.test.js` test the per-card star sort/transfer behavior, not the count indicator — they are unaffected.

## Dependencies

None. This plan has no prerequisite sessions or plans.

## Adversarial Synthesis

Key risk: the plan as originally written listed only one of the two `updateStarredCount()` call sites (line 8822) and omitted the second (line 9119, inside the board render path). Deleting the function while leaving the 9119 call in place throws a `ReferenceError` on every board render, breaking the entire Kanban panel — a far worse failure than the noise being removed. Mitigation: the Proposed Changes now enumerate both call sites explicitly, and the Verification Plan includes a grep asserting zero remaining references to either `starred-count` or `updateStarredCount`. Secondary risk: accidentally removing per-card star CSS/logic that shares the "starred" name. Mitigation: the Edge-Case audit lists every `starred`-named symbol that must survive, with line numbers.

## Proposed Changes

### 1. `src/webview/kanban.html` — remove the starred-count HTML element

Remove lines 3063–3066:

```html
<!-- REMOVE: -->
<div id="starred-count" style="display:none; font-size:10px; color:var(--vscode-editorWarning-foreground, #cca700); align-items:center; gap:3px;" data-tooltip="Number of priority-starred cards. Starring everything is the same as starring nothing — the count surfaces the degenerate state.">
    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"><path d="M8 1.5l2 4.5 5 .4-3.8 3.3 1.2 4.9L8 12l-4.4 2.6 1.2-4.9L1 6.4l5-.4z"/></svg>
    <span id="starred-count-text">0 starred</span>
</div>
```

### 2. `src/webview/kanban.html` — remove the `updateStarredCount()` function and its comment block

Remove lines 8825–8849 (the V63 comment block plus the `updateStarredCount` function body through its closing brace).

### 3. `src/webview/kanban.html` — remove the FIRST call site (column-count update path)

Remove the call at line 8822:

```javascript
// REMOVE this line:
updateStarredCount();
```

### 4. `src/webview/kanban.html` — remove the SECOND call site (board render path)

> **Superseded:** The original plan listed only the call at line 8822 and omitted the second call site.
> **Reason:** A grep of `src/` for `updateStarredCount` reveals a second call at `kanban.html:9119`, inside the board render path (immediately after `updateStagingViewInfo()` at line 9118). If the function is deleted but this call remains, every board render throws `ReferenceError: updateStarredCount is not defined`, breaking the entire Kanban panel.
> **Replaced with:** Remove the call at line 9119 as well, so that both call sites are deleted alongside the function.

Remove the call at line 9119:

```javascript
// REMOVE this line (inside the render function, after updateStagingViewInfo()):
updateStarredCount();
```

## Verification Plan

### Automated Tests
- Run `grep -n 'starred-count\|updateStarredCount' src/webview/kanban.html` — assert **zero** remaining references to the removed indicator or its function. (`starred` as a per-card class/property and `priorityStarred` should still appear — those are the per-card star feature, not the indicator.)
- Run the full contract suite — assert no regressions. (No contract test references `starred-count` or `updateStarredCount`; the `priorityStarred` tests cover the per-card star, which is untouched.)

### Goal Invariants
- **Negative:** `grep -c 'id="starred-count"' src/webview/kanban.html` returns `0` (the indicator element is gone from the control rail).
- **Negative:** `grep -c 'updateStarredCount' src/webview/kanban.html` returns `0` (the function and both call sites are gone — no dangling reference can break the render).
- **Positive:** `grep -c 'priorityStarred' src/webview/kanban.html` is `>= 1` (the per-card star sort precedence at line 9021–9024 still exists — the star feature itself was not collateral damage).
- **Positive:** `grep -c 'setPriorityStarred' src/webview/kanban.html` is `>= 1` (the per-card star toggle message handler is still wired).

### Manual Checks
1. Open the Kanban panel — assert the starred-count indicator is no longer visible in the control rail.
2. Star a card — assert the per-card star button still toggles (filled/outline star icon).
3. Verify the star precedence ordering still works (starred cards sort first in each column).
4. Trigger a board re-render (e.g., toggle a project filter) — assert the board renders without console errors, confirming no dangling `updateStarredCount()` reference remains.

## Outstanding Questions

None. All references were verified against the live source; the only correction (the second call site) is resolved within this plan.
