# Plan: Justify Ticket Card Buttons Left

## Goal
Align ticket card action buttons to the left (`justify-content: flex-start`) so they match tree/plan node cards, which default to left alignment. Currently `.ticket-node .card-actions` is set to `justify-content: flex-end`, making ticket cards visually inconsistent with the rest of the sidebar.

**Problem / Root cause:** In `src/webview/planning.html`, the `.ticket-node .card-actions` rule sets `justify-content: flex-end`, right-aligning the button row. Tree node card actions (`.tree-node .card-actions`) set no `justify-content`, so they fall back to `flex-start` (left). The mismatch is purely cosmetic but makes ticket cards read as "different" from plan cards in the same sidebar.

## Metadata
- **Tags:** ui, ux
- **Complexity:** 1

## User Review Required
None. This is a one-line cosmetic alignment change with no product decision.

## Complexity Audit
### Routine
- Single-property CSS change in one rule in one file.
- Reuses the existing left-alignment convention already used by tree/plan node cards.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit
- **Race Conditions:** None — static CSS.
- **Security:** None.
- **Side Effects:** Buttons re-flow to the left. `flex-wrap: wrap` is already present on the rule, so wrapping on narrow cards is preserved; wrapped rows now start from the left edge instead of the right. This is the intended behavior.
- **Dependencies & Conflicts:** Edits the same `.ticket-node { ... }` CSS block in `planning.html` that sibling subtask "Fix Status/Assignees Clickable Area" edits — but a *different* rule (`.card-actions` at 2862–2868 vs `.tickets-issue-meta[data-edit-*]` at 2852–2855). No line overlap; land order does not matter, but both should be applied in one coordinated edit to avoid a trivial merge conflict in the shared block.

## Dependencies
- None.

## Adversarial Synthesis
Key risk: negligible. The only observable effect is button alignment flipping left; `flex-wrap` already handles narrow cards. Mitigation: visually confirm buttons left-align and still wrap. No functional or data risk.

## Proposed Changes
### src/webview/planning.html
- **Context:** The `.ticket-node .card-actions` rule at lines ~2862–2868 (the `justify-content` property is on line 2867).
- **Logic:** Change `justify-content: flex-end` to `justify-content: flex-start` so the button row aligns left, matching `.tree-node .card-actions`.
- **Implementation:**
  ```css
  /* Before (lines ~2862–2868) */
  .ticket-node .card-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
      flex-wrap: wrap;
      justify-content: flex-end;
  }

  /* After */
  .ticket-node .card-actions {
      display: flex;
      gap: 4px;
      margin-top: 4px;
      flex-wrap: wrap;
      justify-content: flex-start;
  }
  ```
  > **Superseded:** The original plan cited the rule at "~line 2857" and showed a "Before" block missing the `flex-wrap: wrap;` declaration.
  > **Reason:** The actual rule lives at lines 2862–2868 (`justify-content` on 2867) and already contains `flex-wrap: wrap;`. An inaccurate line number / snippet risks the coder editing the wrong rule or dropping `flex-wrap`.
  > **Replaced with:** Corrected line reference (2862–2868) and a "Before" snippet that preserves the existing `flex-wrap: wrap;` line.
- **Edge Cases:** Removing the property entirely would also work (flex-start is the default), but explicitly setting `flex-start` is clearer and self-documenting. Keep the explicit value.

## Verification Plan
### Automated Tests
- None. Per session directive, skip automated tests and compilation.

**Manual verification:**
1. Open the Tickets sidebar; confirm ticket card action buttons align to the left, matching tree/plan node cards.
2. Narrow the sidebar and confirm buttons still wrap onto a second line, starting from the left.

## Recommendation
Complexity 1 → **Send to Intern.**

## Completion Report (2026-07-16)
Implemented as planned: changed `justify-content: flex-end` to `justify-content: flex-start` in the `.ticket-node .card-actions` rule in `src/webview/planning.html` (line ~2870 after sibling edit). `flex-wrap: wrap` preserved, so buttons still wrap on narrow cards, now starting from the left edge to match tree/plan node cards. Applied in the same coordinated pass as the sibling clickable-area CSS edit in the same block, per the feature's coordination note. No issues encountered.
