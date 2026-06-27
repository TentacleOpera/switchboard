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

---

## Proposed Changes

### `src/webview/kanban.html`

#### 1. JS — Remove the epic pill badge from `.card-topic` (line ~5350)

**Current:**
```js
const epicBadge = card.isEpic
    ? `<span class="epic-badge">EPIC · ${card.subtaskCount || 0} subtask${(card.subtaskCount || 0) !== 1 ? 's' : ''}</span>`
    : '';
```

**Change to:**
```js
const epicBadge = ''; // Badge removed; epic identity shown via purple border + meta line
```

The `epicBadge` variable is only ever interpolated into the `.card-topic` div on line 5371 (`${epicBadge}${escapeHtml(shortTopic)}`), so clearing it here is the complete removal.

#### 2. JS — Swap the `.card-meta` content for epic cards (line ~5372)

**Current:**
```html
<div class="card-meta">Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}</div>
```

**Change to a conditional:**
```js
const cardMetaContent = card.isEpic
    ? `<span class="epic-subtask-label">EPIC: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · ${timeAgo}`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span> · ${timeAgo}`;
```

Then in the template:
```html
<div class="card-meta">${cardMetaContent}</div>
```

#### 3. CSS — Add `.epic-subtask-label` style (near `.epic-badge` at line ~921)

```css
.epic-subtask-label {
    color: #7c3aed;
    font-weight: 700;
}
```

This inherits the existing `.card-meta` font-family (monospace) and font-size, so it slots in without layout impact.

#### 4. CSS — `.epic-badge` rule (line ~921)

The `.epic-badge` CSS rule can be **deleted** since no card will render it anymore. This avoids dead CSS.

---

## Verification Plan

### Manual Verification
- Open the Kanban board and confirm epic cards show `EPIC: X SUBTASKS · <time>` on the meta line in purple, with no badge next to the title.
- Confirm non-epic cards are unchanged (still show `Complexity: HIGH · <time>`).
- Confirm card height does not increase — the meta row should remain a single line.
- Confirm singular/plural: `EPIC: 1 SUBTASK` vs `EPIC: 4 SUBTASKS`.
- Confirm the purple left border on epic cards is still present (unchanged).
