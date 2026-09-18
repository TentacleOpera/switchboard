# Create Worktree Button Has No Tooltip When Active

## Goal

Give the **CREATE WORKTREE** button in the kanban sub-bar (`#btn-create-worktree`) a tooltip in *every* state, including when it is enabled/clickable ("active"). Today the button only shows a tooltip when it is **disabled** (wrong selection); in its normal, clickable state it shows nothing, so a user hovering the active button gets no explanation of what clicking it will do.

### Problem analysis

The button ships with a helpful static `data-tooltip` in the HTML:

```html
<!-- src/webview/kanban.html:2658 -->
<button class="strip-btn" id="btn-create-worktree"
  data-tooltip="Create a worktree for the selected feature, or for the active project / workspace">CREATE WORKTREE</button>
```

Tooltips are rendered by the custom overlay system (`src/webview/kanban.html:3898-3960`), which reads the target element's `data-tooltip` attribute on `mouseover`. If the attribute is absent, `showTooltip()` returns early and nothing appears (`kanban.html:3904-3905`).

### Root cause

`updateCreateWorktreeButton()` (`src/webview/kanban.html:5566-5600`) **strips** the `data-tooltip` attribute in exactly the states where the button is *enabled*:

- **No cards selected** (`size === 0`) — the default state where the button creates a worktree for the active project/workspace. It runs `btn.removeAttribute('data-tooltip')` (`kanban.html:5573`).
- **One feature selected, no existing worktree** — the button is enabled to create that feature's worktree. It also runs `btn.removeAttribute('data-tooltip')` (`kanban.html:5588`).

The function is invoked on load and on every selection/board change (`kanban.html:4077, 5289, 5757, 5863, 6244, 6699, 6745, 6843, 7477`), so the static HTML tooltip is removed almost immediately after first paint. Tooltips are only *set* in the disabled branches (`kanban.html:5585, 5593, 5599`). Net effect: the button explains itself only when it can't be clicked, and stays silent when it can.

The fix is to **set** a descriptive `data-tooltip` in the two enabled branches instead of removing it, so an active button always describes the action it will perform.

## Metadata

- **Tags:** ui, bugfix, frontend
- **Complexity:** 2 / 10
- **Area:** `src/webview/kanban.html` (kanban webview, self-contained)

## User Review Required

- **None.** The two enabled-state tooltip strings are decided in Proposed Changes (`size === 0` → "Create a worktree for the active project / workspace"; single feature → "Create a worktree for this feature"), reusing the existing static-HTML phrasing. No open product decision.

## Complexity Audit

### Routine
- Two-line-per-branch change inside a single self-contained function (`updateCreateWorktreeButton`) in one webview file.
- No backend, no message protocol, no state, no migration.
- The tooltip overlay system already exists and requires only a populated `data-tooltip` attribute.
- The action semantics of each enabled branch are already known from the existing static tooltip and from `updateCreateWorktreeButton`'s own logic, so the copy can be written precisely.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `data-tooltip` on this button is only ever mutated inside `updateCreateWorktreeButton`, so there is no competing code path to keep in sync (single writer). `renderBoard()` calls `hideTooltip()` (`kanban.html:5605`), which clears the currently-shown overlay but does not touch attributes; re-adding the attribute in `updateCreateWorktreeButton` is safe and is picked up on the next hover.
- **Security:** None. Static, author-controlled copy strings — no user input, no injection surface.
- **Side Effects:**
  - **`.title` vs `data-tooltip`:** the enabled branches currently also set `btn.title = ''` (`kanban.html:5574, 5589`). The overlay reads `data-tooltip`, not `title`; `title` is cleared to avoid a *duplicate* native OS tooltip. Keep `btn.title = ''` so we don't get both the custom overlay and a native tooltip. Only the `data-tooltip` handling changes.
  - **Disabled branches unchanged:** the three disabled-state tooltips ("Feature already has a worktree", "Only feature cards can have worktrees", "Select a single feature to create its worktree") are correct and must stay.
- **Dependencies & Conflicts:**
  - No dependency on selection internals beyond what the function already reads (`selectedCards`, `currentFeatureWorktrees`, `lastWorktreeConfig`). No new globals.
  - **Wording for the two enabled states differs:** `size === 0` targets the active project/workspace → reuse the static-HTML phrasing; single feature, no worktree targets *that feature* → phrase it specifically ("Create a worktree for this feature").
  - **Shared-file coordination (intra-feature):** subtask *"Agents List Needs Core/Optional Subheaders"* also edits `kanban.html`, but in a disjoint region (AGENTS tab `~2834-2880` and the `<style>` block `~1168-1253`). No overlap with this function (`~5566-5600`) or the tooltip overlay (`~3898-3960`); edits are independent.

## Dependencies

- None (no cross-session dependencies). Intra-feature coordination with the Core/Optional-subheaders subtask is noted above — same file, disjoint regions, no ordering constraint.

## Adversarial Synthesis

Key risks: (1) accidentally altering a disabled-branch tooltip or the `btn.title = ''` clears, reintroducing a duplicate native tooltip; (2) editing the wrong branch so an enabled state still strips the attribute. Mitigations: change only the two `removeAttribute('data-tooltip')` calls in the enabled branches to `setAttribute` with the specified copy, leave `btn.title = ''` and all disabled branches untouched, and verify each of the five selection states by hover per the Verification Plan.

## Proposed Changes

### `src/webview/kanban.html` — `updateCreateWorktreeButton()` (lines 5566-5600)

Replace the two `removeAttribute('data-tooltip')` calls in the **enabled** branches with `setAttribute` calls carrying action-descriptive copy. Leave `btn.title = ''` and all disabled branches intact.

**Branch 1 — no selection (`size === 0`), lines 5571-5576:**

```js
if (size === 0) {
    btn.disabled = false;
    btn.setAttribute('data-tooltip', 'Create a worktree for the active project / workspace');
    btn.title = '';
    return;
}
```

**Branch 2 — single feature, no existing worktree, lines 5586-5590:**

```js
} else {
    btn.disabled = false;
    btn.setAttribute('data-tooltip', 'Create a worktree for this feature');
    btn.title = '';
}
```

(The `hasWorktree` disabled branch immediately above — `btn.setAttribute('data-tooltip', 'Feature already has a worktree')` at `kanban.html:5585` — is unchanged.)

No other files change. The static `data-tooltip` on the HTML button (`kanban.html:2658`) can stay as-is; it now matches the runtime value for the default state and covers the pre-first-`updateCreateWorktreeButton` window.

## Verification Plan

### Automated Tests
- None. Per session directive (SKIP TESTS) and because this is a hover-driven copy change in a self-contained webview with no unit-test harness for `kanban.html` DOM behaviour. Verification is manual (below).

### Manual verification
1. Load the change in an installed VSIX (the webview loads from the installed extension, not repo `dist/`; no project compilation step is part of this plan).
2. Open the kanban board with **no cards selected** → hover CREATE WORKTREE → overlay shows "Create a worktree for the active project / workspace". Button is enabled and still creates a worktree on click.
3. Select a **single feature card with no worktree** → hover → overlay shows "Create a worktree for this feature". Click still creates the feature worktree.
4. Select a **single feature card that already has a worktree** → button disabled, hover shows "Feature already has a worktree" (regression check).
5. Select a **single non-feature plan** → disabled, hover shows "Only feature cards can have worktrees".
6. Select **two or more cards** → disabled, hover shows "Select a single feature to create its worktree".
7. Confirm no *native* (OS) tooltip appears in addition to the overlay in any state (i.e. `title` stays empty).

## Recommendation

Complexity 2 → **Send to Intern.** Localized, single-function, behaviour-preserving copy change with a clear verification checklist.

## Review Findings

Files changed: `src/webview/kanban.html` (`updateCreateWorktreeButton`, ~5602-5636). Both enabled branches now `setAttribute('data-tooltip', …)` with the specified copy and retain `btn.title=''`; the three disabled tooltips are untouched. Caller trace: function is invoked on load/selection/board changes with no signature, return, or side-effect change — no double-refresh, no race. Verified by read + grep (SKIP TESTS/SKIP COMPILATION per directive). Remaining risk: NIT only — the disabled `hasWorktree` branch doesn't clear `btn.title`, but `title` is never set non-empty anywhere so no duplicate native tooltip can appear. No code fixes required.
