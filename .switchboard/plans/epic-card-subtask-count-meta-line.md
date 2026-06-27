# Epic Card Layout: Replace Complexity with Subtask Count

Epic cards currently show redundant/misleading information. The complexity metadata row always reads "HIGH" for epics (it's implied), and the inline `EPIC ·` pill badge next to the title is visually noisy. This plan replaces both with a clean `EPIC: X SUBTASKS` label in purple on the meta line.

## Metadata
**Complexity:** 2  
**Tags:** frontend, ui, ux

---

## Goal

Clean up the epic card layout in `kanban.html` by:

1. **Removing the purple `EPIC ·` pill badge** that sits inline next to the card title in `.card-topic`.
2. **Replacing the complexity meta line** with `EPIC: X SUBTASKS · <timestamp>` for epic cards — same line position, no height increase.

The result for epic cards:
```
Topic text                        ← .card-topic (no badge prefix)
EPIC: 4 SUBTASKS · 2d ago         ← .card-meta (purple, replaces complexity)
[Copy Prompt] [Review] [✓]        ← .card-actions (unchanged)
```

### Problem Analysis & Root Cause

**Core problem:** Epic cards display two redundant signals — a purple pill badge (`EPIC · N subtasks`) inline with the title, and a complexity meta line that always reads "HIGH" (since epics are inherently high-complexity). This creates visual noise without adding information.

**Root cause:** The `epicBadge` variable (line 5399) injects a styled `<span class="epic-badge">` into `.card-topic`, while the `.card-meta` line (line 5424) unconditionally renders `Complexity: <span class="complexity-indicator">HIGH</span> · <timeAgo>` for all cards regardless of epic status. There is no conditional branch for epic cards in the meta line.

**Background:** The `subtaskCount` field is already reliably populated on epic card objects by `KanbanProvider.ts` (lines 1242, 1259, 2161, 2180) via a `subtaskCountMap` that counts rows matching each epic's `planId`. The `isEpic` boolean is set as `!!row.isEpic`. Both fields are serialized into the webview card data. No new data plumbing is needed — this is purely a presentation change.

---

## User Review Required

This is a low-risk, single-file visual change. No user review gate is required before implementation, but the implementer should visually confirm the result per the Verification Plan.

---

## Complexity Audit

### Routine
- Single-file change (`src/webview/kanban.html`) — all edits are in one file.
- Removing one JS variable's content (set `epicBadge = ''`).
- Adding one conditional branch for the `.card-meta` content string.
- Adding one small CSS class (`.epic-subtask-label`, 2 properties).
- Deleting one dead CSS rule (`.epic-badge`).
- No new data fields, no backend changes, no state mutations.

### Complex / Risky
- None

---

## Edge-Case & Dependency Audit

**Race Conditions:** None — this is a pure rendering change in `createCardHtml()`, which runs synchronously per card during board render. No async state involved.

**Security:** None — no new user input is interpolated. `card.subtaskCount` is a number from the kanban DB, already sanitized upstream. `escapeHtml` is not needed for a numeric field.

**Side Effects:**
- The `.epic-badge` CSS rule (lines 921–931) becomes dead CSS after removal. The plan deletes it to avoid dead code.
- The `wtButton` (worktree chip) is also rendered in `.card-topic` (line 5423: `${epicBadge}${escapeHtml(shortTopic)}${wtButton}`). Removing `epicBadge` does not affect `wtButton` — it remains after the topic text.
- The claudify theme override `body.theme-claudify .card-meta { color: #8a8a8a !important; }` (line 193) sets grey on the meta line. The new `.epic-subtask-label` sets `color: #7c3aed` directly on the child span, which takes precedence over the inherited parent color regardless of `!important` (the `!important` only governs the parent's own declaration, not forced inheritance). The `· <timeAgo>` text node remains grey in claudify — matching the current behavior where "Complexity:" text is grey and only the indicator span is colored.

**Dependencies & Conflicts:** None — no other files reference `.epic-badge` (verified via grep: only `kanban.html` lines 921 and 5399). No other webview files (`planning.js`, `project.js`) use this class.

---

## Dependencies

None — this plan is self-contained.

---

## Adversarial Synthesis

Key risks: (1) dead `.epic-badge` CSS if not deleted, (2) incorrect line numbers leading an implementer to edit the wrong code. Mitigations: explicitly delete the dead CSS rule; corrected line numbers are 5399 (epicBadge), 5424 (card-meta), 921–931 (.epic-badge CSS). No data-plumbing or theme-compatibility risks found.

---

## Proposed Changes

### `src/webview/kanban.html`

#### 1. JS — Remove the epic pill badge from `.card-topic` (line 5399)

**Current (line 5399):**
```js
const epicBadge = card.isEpic ? `<span class="epic-badge">EPIC · ${card.subtaskCount || 0} subtask${(card.subtaskCount || 0) !== 1 ? 's' : ''}</span>` : '';
```

**Change to:**
```js
const epicBadge = ''; // Badge removed; epic identity shown via purple border + meta line
```

The `epicBadge` variable is only ever interpolated into the `.card-topic` div on line 5423 (`${epicBadge}${escapeHtml(shortTopic)}${wtButton}`), so clearing it here is the complete removal. The `wtButton` (worktree chip) remains unaffected.

#### 2. JS — Swap the `.card-meta` content for epic cards (line 5424)

**Current (line 5424):**
```html
<div class="card-meta">Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}</div>
```

**Add a conditional before the template literal (insert after line 5399, near the `epicBadge` declaration):**
```js
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · ${timeAgo}`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}`;
```

**Then update the template (line 5424):**
```html
<div class="card-meta">${cardMetaContent}</div>
```

Note: The `.card-meta` element uses `display: flex; gap: 4px` (lines 949–957). Both the epic and non-epic variants produce flex items (text nodes + spans) separated by the 4px gap — identical rendering pattern to the current code. No layout shift.

#### 3. CSS — Add `.epic-subtask-label` style (insert after `.epic-badge` block, ~line 931)

```css
.epic-subtask-label {
    color: #7c3aed;
    font-weight: 700;
}
```

This inherits the existing `.card-meta` font-family (monospace) and font-size (9px), so it slots in without layout impact. The explicit `color` on this child span wins over the inherited `.card-meta` color in all themes, including claudify's `!important` grey override.

#### 4. CSS — Delete `.epic-badge` rule (lines 921–931)

The `.epic-badge` CSS rule can be **deleted** since no card will render it anymore (verified: only references are this CSS rule and the JS on line 5399, both being removed). This avoids dead CSS.

---

## Verification Plan

### Automated Tests
No automated tests required — this is a pure visual/CSS change in a webview HTML file. The test suite is run separately by the user.

### Manual Verification
- Open the Kanban board and confirm epic cards show `EPIC: X SUBTASKS · <time>` on the meta line in purple, with no badge next to the title.
- Confirm non-epic cards are unchanged (still show `Complexity: HIGH · <time>`).
- Confirm card height does not increase — the meta row should remain a single line.
- Confirm singular/plural: `EPIC: 1 SUBTASK` vs `EPIC: 4 SUBTASKS`.
- Confirm the purple left border on epic cards is still present (unchanged).
- Confirm the claudify theme renders `EPIC: X SUBTASKS` in purple while the `· <time>` portion remains grey.
- Confirm the worktree chip (`wtButton`) still appears next to the topic text for epics with linked worktrees.

---

**Recommendation:** Complexity 2 → Send to Intern
