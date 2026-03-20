# Remove lightning icon from pair program mode

## Goal
Remove the lightning icon from the pair program button in the cards, as emojis do not match the aesthetic. The pair button will also be moved next to the copy prompt button to group similar functional actions. Furthermore, we will update tooltip texts in the Kanban board to use "high complexity" and "low complexity" instead of "Band B" and "Band A" for clarity.

## User Review Required
> [!NOTE]
> No breaking changes. UI aesthetic updates only.

## Complexity Audit
### Band A — Routine
- Remove `⚡` icon from the pair program button in `src/webview/kanban.html`.
- Move the pair program button next to the copy prompt button in the card actions layout.
- Update `title` attributes (tooltips) in the toggle and the button to use "high complexity" and "low complexity" terminology instead of "Band B" / "Band A".
### Band B — Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** None, UI only.
- **Security:** None.
- **Side Effects:** Changing DOM structure slightly (grouping copy and pair buttons in a flex container) may affect layout if there are implicit styles for `card-actions > button:first-child`. However, inline styles currently use `justify-content: space-between` on the container, so wrapping the left side in a flex group `div` is safe.
- **Dependencies & Conflicts:** Does not conflict with other planned features.

## Adversarial Synthesis
### Grumpy Critique
The plan to "move the button next to the copy prompt button" is vague. Just shoving a button next to another in a space-between flexbox will break the alignment unless you wrap them in a flex container. Also, what if `pairProgramBtn` is empty? You'll have an empty gap in the left flex container. And did you check if the `copyLabel` styling changes when placed inside a flex wrapper?

### Balanced Response
Grumpy is right to point out the flexbox layout details. We will wrap the 'copy' button and the `pairProgramBtn` inside a `div` with `display: flex; gap: 4px;` just like the right-side icons. If `pairProgramBtn` is empty, the gap won't visibly push anything out of place because there's only one child rendered, but to be absolutely pristine, the flex layout inherently handles single items gracefully. We will explicitly provide the layout change in the HTML block.

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### 1. `src/webview/kanban.html`
#### MODIFY `src/webview/kanban.html`
- **Context:** Update the tooltips to use complexity-based terminology, remove the emoji, and restructure the layout so the Pair button is visually adjacent to the Copy button.
- **Logic:**
  1. Update the title of the `pair-programming-toggle` label.
  2. Update the `pairProgramBtn` tooltip string and inner text.
  3. Wrap the left-side card action buttons (Copy and Pair) in a flex container `div` to keep them together.
- **Implementation:**

```html
<<<<
        <label class="cli-toggle-inline pair-programming-toggle" id="pair-programming-toggle" title="Pair Programming: Lead does Band B, Coder auto-starts Band A simultaneously">
====
        <label class="cli-toggle-inline pair-programming-toggle" id="pair-programming-toggle" title="Pair Programming: Lead does high complexity work, Coder auto-starts low complexity work simultaneously">
>>>>

<<<<
            const pairProgramBtn = card.column === 'PLAN REVIEWED'
                ? `<button class="card-btn pair-program-btn" data-session="${card.sessionId}" title="Pair Program: copy Band B prompt to clipboard, auto-send Band A to Coder terminal">⚡ Pair</button>`
                : '';
            return `
                <div class="kanban-card" draggable="true" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">
                    <div class="card-topic" title="${escapeHtml(card.topic)}">${escapeHtml(shortTopic)}</div>
                    <div class="card-meta">Complexity: <span class="complexity-indicator ${complexityClass}">${complexity}</span> · ${timeAgo}</div>
                    <div class="card-actions" style="display: flex; justify-content: space-between; align-items: center;">
                        <button class="card-btn copy" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">${copyLabel}</button>
                        <div style="display: flex; gap: 4px;">
                            ${pairProgramBtn}
                            <button class="card-btn icon-btn review" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" title="Review Plan Ticket">
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>
                            </button>
====
            const pairProgramBtn = card.column === 'PLAN REVIEWED'
                ? `<button class="card-btn pair-program-btn" data-session="${card.sessionId}" title="Pair Program: copy high complexity prompt to clipboard, auto-send low complexity to Coder terminal">Pair</button>`
                : '';
            return `
                <div class="kanban-card" draggable="true" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">
                    <div class="card-topic" title="${escapeHtml(card.topic)}">${escapeHtml(shortTopic)}</div>
                    <div class="card-meta">Complexity: <span class="complexity-indicator ${complexityClass}">${complexity}</span> · ${timeAgo}</div>
                    <div class="card-actions" style="display: flex; justify-content: space-between; align-items: center;">
                        <div style="display: flex; gap: 4px;">
                            <button class="card-btn copy" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}">${copyLabel}</button>
                            ${pairProgramBtn}
                        </div>
                        <div style="display: flex; gap: 4px;">
                            <button class="card-btn icon-btn review" data-session="${card.sessionId}" data-workspace-root="${escapeAttr(card.workspaceRoot)}" title="Review Plan Ticket">
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M11.5 1.5l3 3L5 14H2v-3L11.5 1.5z"/></svg>
                            </button>
>>>>
```

## Verification Plan
### Automated Tests
- N/A. Visual and tooltip changes only. Test manually by rendering the Kanban board and viewing the Plan Reviewed cards.

---

## Reviewer Pass — 2026-03-20

### Findings

| # | Severity | Finding | Verdict |
|---|----------|---------|---------|
| 1 | — | Lightning emoji (`⚡`) removed from Pair button — text is now just "Pair" | **Verified** |
| 2 | — | Header toggle tooltip updated to "high complexity work / low complexity work" | **Verified** |
| 3 | — | Per-card button tooltip updated to "high complexity prompt / low complexity" | **Verified** |
| 4 | — | Pair button and Copy button grouped in left flex `<div>` with `gap: 4px`; review/complete icons in right flex group | **Verified** |
| 5 | NIT | Pair button renders before Copy (plan proposed Copy first, then Pair) — no functional impact | **Keep** |

### Files Changed (Reviewer)
- None — no code fixes required

### Validation Results
- **TypeScript compile**: ✅ `npx tsc --noEmit` — clean
- **Visual verification**: Layout structure matches plan intent (left group: action buttons, right group: icon buttons)

### Remaining Risks
- None
