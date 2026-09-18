# Show Feature Subtask Count in Terminal Kanban Mode Card Rows

## Goal

In the Terminals panel's kanban mode (where an empty pane shows a live kanban column viewer), feature cards are rendered as rows but do not display how many subtasks the feature contains. The main kanban board (`kanban.html`) shows this as a `FEATURE: N SUBTASKS` label in the card meta line. The terminal kanban pane omits it entirely, leaving the operator unable to distinguish a feature with 8 subtasks from a single plan at a glance.

### Problem Analysis & Root Cause

**Symptom:** When a kanban-mode pane in `terminals.html` shows a feature card, the row displays the title, a complexity badge, a working indicator, and a project name — but no subtask count. The operator has no way to know the feature's scope without switching to the full kanban board.

**Root Cause:** The card rendering loop in `terminals.js` (`renderKanbanPane`, row meta construction at lines 2643-2667) builds a `.kanban-pane-row-meta` div with three optional children: a complexity badge, a working indicator, and a project label. It never reads `card.subtaskCount` or `card.isFeature` for the meta line — `card.isFeature` is only used to add the `.is-feature` CSS class (line 2610), which applies a purple left border. The subtask count data is already present in the card object: the `getBoardCards` verb response includes `subtaskCount` for feature cards (set in `KanbanProvider._buildBoardCards` at line 1841 via `subtaskCountMap.get(row.planId)`). The main board uses this exact field at `kanban.html` line 6811:

```js
const cardMetaContent = card.isFeature
    ? `<span class="feature-subtask-label">FEATURE: ${card.subtaskCount || 0} SUBTASK${(card.subtaskCount || 0) !== 1 ? 'S' : ''}</span> · <span class="complexity-indicator ${complexityClass}">${category}</span>`
    : `Complexity: <span class="complexity-indicator ${complexityClass}">${category}</span>`;
```

The terminal kanban pane simply never renders this information.

## Metadata

**Complexity:** 2
**Tags:** frontend, ui, bugfix
**Project:** Browser Switchboard

## User Review Required

No — this is a pure additive display change with no design decisions. The data field already exists, the rendering pattern is copied from the main board, and the CSS mirrors an existing class. Proceed directly to implementation.

## Complexity Audit (Routine vs Complex/Risky)

### Routine
- The `card.subtaskCount` field is already populated by the backend (`KanbanProvider._buildBoardCards` line 1841) and already arrives in the `getBoardCards` response consumed by `fetchBoardCardsForPane` (line 2838: `kanbanPaneCards[index] = data.cards`).
- The rendering site is a single location: the meta div construction in `renderKanbanPane` (lines 2643-2667). Adding a conditional child element follows the exact same pattern as the existing complexity badge and working indicator.
- The `.feature-subtask-label` CSS class already exists in `kanban.html` (line 968) with purple styling. A matching class needs to be added to `terminals.html` for the terminal pane's compact row layout.
- The `bodySig` change-detection string (line 2581) already includes `c.isFeature ? 'f' : ''` but does NOT include `c.subtaskCount`. Adding subtaskCount to the sig is necessary so a count change triggers a re-render.

### Complex / Risky
- None. This is a pure additive display change. No backend, no data flow, no state mutation.

## Edge-Case & Dependency Audit

**Data availability:** `subtaskCount` is `undefined` for non-feature cards and a number (0+) for feature cards. The rendering code must guard with `card.isFeature && card.subtaskCount !== undefined` to avoid showing "0 SUBTASKS" on non-feature cards.

**Sig staleness:** The `bodySig` at line 2581 must include `c.subtaskCount` so that a subtask being added/removed from a feature triggers a re-render of the pane. Without this, the count would be stale until the next full poll cycle (5s) — and even then, only if another field in the sig also changed. Current sig:
```
${c.isFeature ? 'f' : ''}
```
Must become:
```
${c.isFeature ? 'f' : ''} ${c.subtaskCount || 0}
```

**Pluralization:** "1 SUBTASK" vs "N SUBTASKS" — the main board handles this with a ternary on the count. Replicate the same logic.

**Layout:** The `.kanban-pane-row-meta` is a flex row with `gap: 6px`. Adding a label before the complexity badge is consistent with the board's layout. The terminal pane row is narrower (220px sidebar + pane width), so the label should use the same compact `font-size: 9px` as the existing meta children.

## Dependencies

None — this subtask is independent of the other two subtasks in the feature. The `subtaskCount` field is already populated by the backend; no backend or data-flow changes are required.

## Adversarial Synthesis

Key risks: (1) line numbers in the original plan were off by ~10 lines — corrected to match actual code (bodySig=2581, meta=2643-2667). (2) The Claudify CSS fallback used `#D97757` (terracotta) but `--feature-accent` is not defined in `terminals.html`; the correct fix defines it as `#D4A017` (gold) in the Claudify block, matching `kanban.html` line 67 and also fixing the existing feature border at line 924. Mitigations: line numbers verified against live code; CSS variable approach ensures both the new label and the existing border use the correct Claudify gold.

## Proposed Changes

### File 1: `src/webview/terminals.js` — Add subtask count to row meta and change-detection sig

**1a. Update `bodySig` to include `subtaskCount` (line 2581):**

Current:
```js
+ cards.map(c => `${c.planId || c.sessionId || ''} ${c.topic || c.title || ''} ${c.complexity || ''} ${c.working ? 'w' : ''} ${c.project || ''} ${c.isFeature ? 'f' : ''}`).join('');
```

New:
```js
+ cards.map(c => `${c.planId || c.sessionId || ''} ${c.topic || c.title || ''} ${c.complexity || ''} ${c.working ? 'w' : ''} ${c.project || ''} ${c.isFeature ? 'f' : ''} ${c.subtaskCount || 0}`).join('');
```

**1b. Add feature subtask label to the meta div (after line 2654, after the complexity value is appended):**

```js
            if (card.isFeature) {
                const featureLabel = document.createElement('span');
                featureLabel.className = 'kanban-pane-feature-label';
                const count = card.subtaskCount || 0;
                featureLabel.textContent = `FEATURE: ${count} SUBTASK${count !== 1 ? 'S' : ''}`;
                // Insert BEFORE the complexity badge to match the board's meta order
                meta.insertBefore(featureLabel, meta.firstChild);
            }
```

### File 2: `src/webview/terminals.html` — Add CSS for the feature subtask label

Add after the `.kanban-pane-complexity.unknown` rule (around line 960):

```css
        .kanban-pane-feature-label {
            color: #7c3aed;
            font-size: 9px;
            font-weight: 700;
            white-space: nowrap;
            letter-spacing: 0.3px;
        }
```

Also add the Claudify theme override. The `--feature-accent` CSS variable is NOT defined in `terminals.html` (unlike `kanban.html` line 67 which defines it as `#D4A017` gold). Define it in the `body.theme-claudify` block so both the new feature label AND the existing feature border at line 924 (`var(--feature-accent, #7c3aed)`) use gold in Claudify — matching kanban.html parity:

```css
        body.theme-claudify {
            --feature-accent: #D4A017;   /* gold: matches kanban.html Claudify feature accent */
        }
        body.theme-claudify .kanban-pane-feature-label {
            color: var(--feature-accent);
        }
```

## Verification Plan

### Automated Tests

No automated tests required — this is a pure CSS/DOM display change. Verification is manual (see below). Skip compilation and automated test steps per session directives.

### Manual Verification

1. Open the browser cockpit (`/shell` or standalone `/terminals`).
2. Switch an empty pane to kanban mode (click the "KANBAN MODE" sidebar button or the pane-mode toggle).
3. Select a column that contains a feature card (a card with a purple left border).
4. **Verify:** The feature card row shows "FEATURE: N SUBTASK(S)" in purple text before the complexity badge.
5. **Verify:** Non-feature cards do NOT show the feature label — only the complexity badge appears.
6. **Verify:** The singular form "1 SUBTASK" is used when count is 1; "N SUBTASKS" otherwise.
7. **Verify:** Adding a subtask to a feature (via the board or API) causes the terminal kanban pane to update the count on the next poll cycle (within 5s).
8. **Verify:** In Claudify theme, the feature label uses the gold accent color (`#D4A017`) instead of purple, and the feature card's left border is also gold (the `--feature-accent` variable now resolves in Claudify).

## Review Findings

**Stage 1 (Grumpy):** Welcome, mortal. I've seen cleaner code in a dumpster behind a startup. Let's see what we have.
- NIT: `meta.insertBefore(featureLabel, meta.firstChild)` puts the label before "Complexity: " text, not before the complexity *badge* — the board uses a `·` separator. Visually fine for the compact row, but the ordering comment is slightly misleading.
- NIT: `bodySig` adds `${c.subtaskCount || 0}` for every card including non-features (always `0`). Harmless — stable sig, no re-render churn — but slightly noisy.

**Stage 2 (Balanced):** Both findings are NITs — keep as-is. The implementation correctly mirrors the board's `FEATURE: N SUBTASK(S)` pattern, pluralization logic, and Claudify gold accent. The `bodySig` change is necessary and correct (count changes trigger re-render). CSS parity with `kanban.html` confirmed. No fixes needed.

**Verification:** `tsc --noEmit` clean for plan-touched files (5 pre-existing TS2835 errors in unrelated files). `test:contract:browser-kanban-pane-order` and `test:contract:terminal-flow-control` pass (16/16). No automated checks named in the plan's `### Automated Tests` subsection — gate-wiring audit vacuously satisfied.

**Files changed:** `src/webview/terminals.js` (bodySig + feature label), `src/webview/terminals.html` (CSS + Claudify `--feature-accent`).
**Remaining risks:** None material. Manual verification (visual layout in dense grids) not run in this pass.
