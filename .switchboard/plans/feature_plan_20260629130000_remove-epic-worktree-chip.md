# Remove the Worktree Chip from Epic Cards (Visual Noise)

## Metadata
**Complexity:** 1
**Tags:** frontend, ui, refactor

## Goal

Remove the small monospace "worktree chip" badge rendered on epic cards that have a linked git worktree. It is visual noise — display-only, non-interactive (`cursor:default`, no click handler), and duplicates information already visible in the Worktrees tab. The underlying worktree functionality (linking, the Worktrees-tab dropdown, the orchestrate guard) is **unchanged**.

### Problem Analysis

The worktree chip (`kanban.html:5388-5397`) appends a `<span class="wt-chip">` showing the linked worktree's branch name to the epic card's **topic line** (`:5410`). It is purely decorative:

- **Non-interactive.** Inline style sets `cursor:default`; no `onclick`, no event listener bound to `.wt-chip` anywhere in the file.
- **Duplicates the Worktrees tab.** The same `currentEpicWorktrees` state drives the Worktrees-tab management UI (`renderWorktreesTab`, `:9081`), where worktrees are listed and managed. The on-card chip is a second, read-only surface for the same fact.
- **Adds clutter to the topic line.** The topic line is meant for the plan title; appending a monospace branch badge crowds it, especially for long topics already truncated to 50 chars (`:5322`).

The `currentEpicWorktrees` state itself serves a real functional purpose elsewhere — the Worktrees-tab "Create Epic Worktree" dropdown excludes epics that already have a worktree (`:9297`). That gate stays. Only the on-card chip is removed.

### Root Cause

No bug — this is a deliberate cleanup of UI noise. The chip was added as a visual indicator of worktree linkage but is redundant with the Worktrees tab and adds no interactive value.

## Decision (no open product questions)

- **Remove the chip rendering block** (`:5388-5397`) and the `${wtButton}` interpolation in the topic line (`:5410`).
- **Keep `currentEpicWorktrees`** (the state map, populated at `:6176-6178`) and the **Worktrees-tab dropdown filter** at `:9297`. Worktree functionality is not changing.
- **No CSS cleanup.** The `wt-chip` class has no dedicated stylesheet entry — the chip is styled entirely inline, so removing the markup removes the styling with it. No orphaned CSS rules.

### Rejected Alternatives
- *Keep the chip but make it clickable (open the Worktrees tab)* — rejected: adds scope and interaction logic for a badge the user has judged noise. Pure removal is the ask.
- *Remove `currentEpicWorktrees` entirely* — rejected: it still drives the `:9297` dropdown guard. Out of scope; removing it would let users double-create worktrees for the same epic.

## User Review Required

- Confirm the chip should be removed from **all** epic cards (active and completed). The chip is epic-only and renders identically regardless of column; removal is uniform.

## Complexity Audit

### Routine
- Delete the `let wtButton = ''; if (card.isEpic) { … }` block at `:5388-5397` (10 lines).
- Remove `${wtButton}` from the topic-line template at `:5410`.
- Three total references to `wtButton` (`:5388`, `:5391`, `:5410`) — all removed; no dangling references remain.

### Complex / Risky
- None. Pure markup deletion; no state, no event handlers, no backend.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `wtButton` is a local string built synchronously per render; removing it changes only the rendered HTML.
- **Security:** None. No interpolation surface added or removed beyond deleting the chip; the topic line still HTML-escapes `shortTopic` (`:5410`).
- **Side Effects:** `currentEpicWorktrees` remains populated and used at `:9297` (Worktrees-tab dropdown) and `:6176-6178` (state sync). No backend, DB, or plan-file effects. No dead-state concern — the state map is still consumed.
- **Dependencies & Conflicts:**
  - **No dependency** on `feature_plan_20260629124815_epic-card-complexity-display.md` (the complexity-display plan). That plan edits the meta line (`:5384-5386`); this plan edits the topic line (`:5410`) and the block above it (`:5388-5397`). The two touch adjacent but non-overlapping code and can ship in any order or together.
  - **No conflict** with the Worktrees tab (`renderWorktreesTab`, `:9081`) — that UI reads `currentEpicWorktrees` directly, not the chip.

## Dependencies

- None.

## Adversarial Synthesis

Key risks: near-zero. The only substantive concern is collateral removal of `currentEpicWorktrees` state (`:6176-6178`) or the `:9297` dropdown guard by an over-eager "dead code" cleanup — the plan explicitly scopes deletion to the `wtButton` block and `${wtButton}` interpolation only, leaving the state map and its functional consumer intact. Secondary risk: line-number drift if a neighboring change (e.g. the complexity-display plan) lands first — mitigated by matching the included code blocks rather than line numbers alone. Mitigations: verification step #3 confirms the Worktrees-tab dropdown still excludes already-linked epics; code blocks are provided for exact matching.

## Proposed Changes

### `src/webview/kanban.html` — remove the worktree chip in `createCardHtml`

**1. Delete the `wtButton` block (`:5388-5397`):**

Current:
```js
let wtButton = '';
if (card.isEpic) {
    const linkedWorktree = currentEpicWorktrees[card.planId];
    wtButton = linkedWorktree
        ? ` <span class="wt-chip" title="Worktree: ${linkedWorktree.branch}"
               style="font-family:monospace; font-size:10px; cursor:default; padding:1px 5px; background:var(--badge-bg, #333); border-radius:3px; margin-left:5px;">
             ${escapeHtml(linkedWorktree.branch)}
           </span>`
        : '';
}
```

Remove the entire block above.

**2. Remove `${wtButton}` from the topic line (`:5410`):**

Current:
```js
<div class="card-topic">${epicBadge}${escapeHtml(shortTopic)}${wtButton}</div>
```

Change to:
```js
<div class="card-topic">${epicBadge}${escapeHtml(shortTopic)}</div>
```

**Context:** `wtButton` is referenced in exactly 3 places (`:5388`, `:5391`, `:5410`) — all removed by these two edits. No other references exist. (Verified by grep: `wt-chip` appears once, `wtButton` appears 3 times, all within this block.)
**Logic:** Pure markup deletion; no control-flow or state change.
**Implementation:** Two edits — delete the 10-line block, then remove the `${wtButton}` token from the template string. Match the code blocks above rather than line numbers, in case a neighboring change (e.g. the complexity-display plan editing `:5384-5386`) has shifted lines.
**Edge Cases:** Epic cards with a linked worktree now show only the topic (no branch badge). The Worktrees tab still shows the worktree and the dropdown still excludes linked epics — verified functionally, not visually on the card. Do NOT remove `currentEpicWorktrees` state (`:6176-6178`) or the `:9297` dropdown guard — they remain functional consumers of the worktree state map.

## Verification Plan

### Automated Tests
None — pure markup deletion with no logic. (Per session directive, automated tests are not run here; the suite will be run separately by the user.)

### Manual (installed VSIX — dev does not use `dist/`)
1. Create an epic and link a worktree via the Worktrees tab → the epic card on the board shows **no** monospace branch badge in the topic line (chip gone).
2. Confirm the epic card's topic line shows only the plan title (truncated as before at 50 chars).
3. Open the Worktrees tab → the linked worktree still appears in the management list; the "Epic:" dropdown still **excludes** the epic that now has a worktree (the `:9297` guard still works).
4. Confirm a normal (non-epic) plan card is unchanged — it never had the chip.
5. Confirm an epic with **no** linked worktree renders identically before and after (the chip was already absent in that case).

## Recommendation

Complexity 1 → **Send to Intern**. Two-edit markup deletion, no state or logic change, no dependencies. The only care needed is to not touch `currentEpicWorktrees` or the `:9297` dropdown guard — both explicitly out of scope.
