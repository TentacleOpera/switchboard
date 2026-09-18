# The command surface's workspace row is labelled "unassigned" and implemented as "all projects"

## Goal

Make `/command`'s project scoping mean what its label says. Selecting the bare workspace row must show the plans that have **no** project, not every plan in every project. One sentinel value is currently doing three incompatible jobs; split it.

### Problem Analysis

`extractWorkspaceProjects` (`src/webview/command.js:400-410`) builds one option per workspace root plus one per project found on the pushed cards. The bare workspace option is constructed as:

```js
baseOpt.value = `${root}|__unassigned__`;
baseOpt.textContent = label;              // just the folder name
baseOpt.dataset.project = '__unassigned__';
```

Selecting it sets `currentProject = '__unassigned__'` (`:219`, `:426`). Every consumer then reads:

```js
if (currentProject && currentProject !== '__unassigned__') {
    cards = cards.filter(c => c.project === currentProject);
}
```

at three sites — `renderDispatchView` (`:559-561`), `renderMoveView` (`:650-652`), and the mission candidate picker (`:896-898`). The guard treats `__unassigned__` as *"apply no filter"*.

### Root Cause

`__unassigned__` is overloaded. It is simultaneously:

1. the **storage value** a plan carries when it has no project (the DB column defaults to `''`, and the board's own filter vocabulary uses `__unassigned__` for this),
2. the **dataset value** on an option whose visible label is a workspace name, and
3. the **control-flow sentinel** meaning "no project filter is active".

Meanings 1 and 3 are opposites — "cards with no project" versus "all cards regardless of project" — and the code implements 3 while the UI labels it 1. On a board with plans spread across several projects, picking the workspace row therefore produces the largest possible list, which is the exact opposite of a scoping control.

**This is not a filter bug in the three render functions.** They faithfully implement the sentinel they were given. The defect is that the option constructor and the filter disagree about what the value means, and nothing in between asserts a contract.

### Why it was invisible

There is no "All projects" option today, so no test or reviewer had a reason to ask which of the two meanings the sentinel carried — with only one unscoped row on screen, "shows everything" and "shows the unassigned ones" are indistinguishable until a second project exists on the board.

## Metadata

**Topic:** Command surface project scoping means unassigned, not unfiltered
**Complexity:** 2
**Tags:** webview, ui, mobile, command-surface, bug

## User Review Required

None. The label already promises the narrow meaning; the fix makes the code match it.

## Complexity Audit

### Routine
- Replacing the three identical guard blocks with a single shared `filterByProject(cards)` helper.
- Adding an explicit "All projects" option to the workspace select.

### Complex / Risky
- **Choosing the unassigned predicate.** Cards arrive from the WS push projection, where a project-less plan may present as `''`, `null`, `undefined`, or the literal `'__unassigned__'` depending on which writer last touched the row. The predicate must accept all four, or the unassigned view renders empty and looks like a regression of this very fix.
- **The default selection.** `extractWorkspaceProjects` falls back to `wsSelect.selectedIndex = 0` (`:420-427`) on every board push where the previous value is gone. If index 0 becomes "All projects", the surface silently widens its scope on reconnect; if it stays the workspace row, the first render after a reconnect narrows to unassigned. Pick one deliberately and state it in a comment — this is the field the push path resets most often.

## Edge-Case & Dependency Audit

**Race conditions:** `extractWorkspaceProjects` runs on every `updateBoard` push and rebuilds `wsSelect.innerHTML` wholesale. A selection made between two pushes is preserved only by the `currentVal` round-trip at `:420`. Adding a new option changes what `currentVal` can match, so the round-trip must be re-verified, not assumed.

**Security:** None. No new data reaches the client; this narrows a client-side filter.

**Side effects:** The mission candidate picker (`:896`) shares the guard. Narrowing it means a mission staged from the workspace row can no longer pull candidates from arbitrary projects — that is the intended behaviour, but it is a behaviour change to the mission flow and belongs in that plan's verification too.

**Dependencies & conflicts:** Touches the same three render functions as the mission and dispatch plans in this feature. Land this one first — it is the smallest diff and the other two build on the helper it extracts.

## Dependencies

None blocking. Sequencing preference only: land before the mission-composer plan, which edits `renderMissionView`'s candidate block.

## Adversarial Synthesis

Key risks: (1) the unassigned predicate matching only one of the four possible empty representations, producing a permanently blank view — mitigation: accept `''`, `null`, `undefined` and `'__unassigned__'`, and verify against a real board that has project-less cards; (2) the default-selection change silently widening scope on every reconnect — mitigation: pin the default explicitly and comment why; (3) treating this as three separate filter fixes and leaving the option constructor's meaning unchanged, which would re-introduce the drift the moment a fourth consumer is added — mitigation: extract one helper, delete all three inline guards.

## Proposed Changes

**1. One helper, three call sites (`src/webview/command.js`).**

Add `filterByProject(cards)` near `getEffectiveCard` and call it from `renderDispatchView`, `renderMoveView` and the mission candidate block. Delete the three inline guards. The helper's contract:

- `currentProject === '__all__'` → return `cards` unchanged.
- `currentProject === '__unassigned__'` → return cards whose project is empty in any representation (`!c.project || c.project === '__unassigned__'`).
- otherwise → `c.project === currentProject`.

**2. An explicit All-projects option (`extractWorkspaceProjects`).**

Per workspace root emit, in order: `${root}|__all__` labelled `<folder>` (all), then `${root}|__unassigned__` labelled `<folder>` (unassigned), then one row per project as today. The workspace name alone stops being a selectable value, which removes the ambiguity at the source.

**3. Pin the default.**

When the previous selection cannot be restored, select the `__all__` row for that root — the widest view is the right cold-start default for a surface whose first job is to show you the board. Comment the choice, naming the reconnect path that reaches it.

## Verification Plan

1. On a board with plans in at least two projects plus at least one project-less plan, open `/command` on a phone. Select `<folder> (unassigned)` — only the project-less plans appear in Dispatch and Move.
2. Select `<folder> (all)` — every plan appears, matching the board's own unfiltered count.
3. Select a named project — only that project's plans appear (unchanged behaviour, regression gate).
4. With `(unassigned)` selected, force a board push (move a card on the desktop board). The selection survives and the list does not silently widen.
5. Confirm the mission candidate dropdown honours the same scope in all three states.
6. Both hosts: repeat 1-3 against the VS Code extension and the standalone host. `/command` is served by the shared `LocalApiServer` route and is not host-gated, but the board push path differs, so exercise both.

### Goal Invariants

- Assert `filterByProject` exists as a named function in `src/webview/command.js` and is called from `renderDispatchView`, `renderMoveView`, and the mission candidate block (three call sites, zero inline `currentProject !== '__unassigned__'` guards remaining).
- Assert `extractWorkspaceProjects` emits an option with `dataset.project === '__all__'` (the "all projects" row) — this value must not have existed in the option constructor before this change.
- Assert `extractWorkspaceProjects` emits a separate option with `dataset.project === '__unassigned__'` labelled with "(unassigned)" — distinct from the `__all__` option.
- Assert selecting the `(unassigned)` option produces a card list that is a **subset** of the `(all)` list (narrower, not wider) on a board with both project-less and project-assigned plans.

## Implementation Summary

Split the overloaded `__unassigned__` sentinel in `src/webview/command.js`. Added `filterByProject(cards)` helper near `getEffectiveCard` with a three-way contract: `__all__` returns cards unchanged, `__unassigned__` returns only empty-project cards (accepting `''`/`null`/`undefined`/`'__unassigned__'`), otherwise exact project match. Replaced the three inline `currentProject !== '__unassigned__'` guards in `renderDispatchView`, `renderMoveView`, and the mission candidate picker with calls to the helper. `extractWorkspaceProjects` now emits an explicit `__all__` option labelled `<folder> (all)` plus a separate `__unassigned__` option labelled `<folder> (unassigned)` per root, so the workspace name alone is no longer a selectable value. Cold-start default pinned to the `__all__` row with a comment naming the reconnect path that reaches it. Initial `currentProject` and both fallback sites updated from `__unassigned__` to `__all__`. No standalone divergence — command.js is a static webview asset served by the shared LocalApiServer route.

## Verification Note

Re-verified on 2026-09-02: all goal invariants hold. `filterByProject` exists (line 682) and is called from `renderDispatchView` (line 721) and `renderMoveView` (line 810). Zero inline `currentProject !== '__unassigned__'` guards remain. `extractWorkspaceProjects` emits both `__all__` and `__unassigned__` options. The third call site (mission candidate picker) no longer exists — the mission-composer plan restructured the Mission view and removed it. Updated the `filterByProject` comment from "three call sites" to "two call sites" to reflect this.

## Review Findings

Reviewed at HEAD + the fixes in this pass; no changes were needed to this subtask. All four goal invariants hold: `filterByProject` exists as a named function in `src/webview/command.js` and is called from `renderDispatchView` and `renderMoveView`, with zero inline `currentProject !== '__unassigned__'` guards remaining in code (the one textual hit is inside the explanatory comment). `extractWorkspaceProjects` emits distinct `__all__` and `__unassigned__` options per root, the workspace name alone is no longer selectable, and the cold-start default is pinned to `__all__` with the reconnect path named. The four-representation unassigned predicate (`''`/`null`/`undefined`/`'__unassigned__'`) is correct against the WS push projection. Verification: `tsc -p tsconfig.test.json` clean, `eslint` 0 errors, `npm test` (standalone-parity, catalog, icons:parity, banner) green.

## Deferred Findings

- NIT — when `currentVal` round-trips successfully, `extractWorkspaceProjects` sets `wsSelect.value` but does not re-sync `currentProject`/`currentWorkspaceRoot`; benign today because they already agree, but it makes the two the only source of truth in different branches (`src/webview/command.js:544`).
