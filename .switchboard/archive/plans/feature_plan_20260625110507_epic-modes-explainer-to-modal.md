# Move "How to Run an Epic" Explainer Into a Modal Opened by a Question-Mark Button

## Goal

Replace the always-visible `<details>` "How to run an epic (3 ways)" explainer in the Epics tab of `project.html` with a compact question-mark (?) button that opens a modal containing the same content. This declutters the Epics tab controls strip while keeping the three execution-mode instructions (Step / Orchestrate / Split) discoverable on demand.

### Problem analysis & root cause

The Epics tab currently renders a `<details class="epic-modes-explainer">` element (`project.html:1481-1488`) directly below the controls strip. It is always present in the DOM, occupies vertical space even when collapsed, and visually competes with the workspace filter / New Epic buttons above it. The content is reference material — the user only needs it occasionally when they forget how epic orchestration works — so it should be an on-demand affordance, not a permanent fixture.

The root cause is a design choice in the original epic-orchestration-onramp plan (Phase 2) that placed the explainer as an inline `<details>` for simplicity. A modal triggered by a small `?` button is the established pattern in this codebase (e.g. the New Epic modal at `project.html:1622` and the Epic Orchestration overlay at `project.html:1649` both use the `.kanban-log-overlay` / `.kanban-log-modal` pattern).

## Metadata

- **Tags:** `feature`, `ui`, `frontend`
- **Complexity:** 2/10 (pure HTML/CSS/JS — move existing content into an existing modal pattern, add a trigger button)

## User Review Required

No user review required. This is a self-contained UI refactor that moves existing content into an existing modal pattern. No backend, state, or data flow changes. The user should verify the modal renders correctly in their preferred theme after implementation.

## Complexity Audit

### Routine
- Adding a `?` button to the Epics tab controls strip and a new `.kanban-log-overlay` modal — both follow the established pattern (`project.html:1622-1646` for the New Epic modal, `project.html:1649-1664` for the orchestrate overlay).
- Moving the three-mode explainer text from the `<details>` into the modal body — copy-paste of existing HTML.
- Wiring the open/close handlers in `project.js` — follows the same `?.addEventListener` convention used by the epic orchestration handlers (`project.js:1528-1530`).

### Complex / Risky
- None. No backend changes, no state migration, no data flow changes.

## Edge-Case & Dependency Audit

- **Theme compatibility:** The modal reuses `.kanban-log-overlay` / `.kanban-log-modal` which are already theme-aware (styled for afterburner, claudify, cyber themes). No new CSS needed beyond a small `?` button style.
- **No confirmation dialogs** (project rule) — this is a read-only info modal, no confirm gate involved.
- **Mobile/narrow layouts:** The modal uses `max-width: 90vw` (matching the orchestrate overlay at `project.html:1650`), so it adapts to narrow viewports.
- **Accessibility:** The `?` button should have a `title` attribute ("How to run an epic") for hover tooltip.
- **Pre-existing latent bug (not introduced by this plan):** `showKanbanLogOverlay` (`project.js:2057-2059`) calls `document.querySelector('.kanban-log-overlay')` and `.remove()`s the first match. Since all static modals (New Epic, Orchestrate, Add Subtask, and now this help modal) share `class="kanban-log-overlay"`, opening a Kanban plan log could remove a static modal from the DOM. This is a pre-existing issue affecting 3 existing modals — this plan follows the same convention and does not worsen the risk. A separate fix should give `showKanbanLogOverlay` a more specific selector (e.g., `.kanban-log-overlay.dynamic-log`).
- **No Escape-key close:** No modal in `project.js` handles `Escape` keydown. This plan follows the existing convention (backdrop click + Close button only). Adding Escape handling would be scope creep.

## Dependencies

None — this plan is self-contained and has no dependencies on other plans or sessions.

## Adversarial Synthesis

Key risks: (1) The new modal shares `class="kanban-log-overlay"` with static modals and the dynamic `showKanbanLogOverlay` function removes the first matching element — a pre-existing latent bug, but this plan follows the same convention as 3 existing static modals so it introduces no new risk. (2) Minor JS style inconsistency — the proposed handlers should use `?.addEventListener` to match the codebase convention at `project.js:1528-1530`. Mitigations: adopt the `?.addEventListener` pattern; track the `showKanbanLogOverlay` selector issue as a separate fix.

## Proposed Changes

### `src/webview/project.html`

**1. Remove the `<details>` explainer (lines 1481-1488):**

```html
<!-- DELETE this block -->
<details class="epic-modes-explainer" style="margin: 0 8px 6px; font-size: 11px; color: var(--text-secondary);">
    <summary style="cursor: pointer;">How to run an epic (3 ways)</summary>
    <div style="padding: 6px 4px 2px; line-height: 1.5;">
        <div><b>Step</b> — drag the epic column-to-column on the board; each column's agent batch-processes every subtask.</div>
        <div><b>Orchestrate</b> — click <b>Orchestrate</b> below; one orchestrator agent runs the whole epic end-to-end with native subagents.</div>
        <div><b>Split (recommended)</b> — drag the epic to the <b>Planner</b> column to improve every subtask plan, <i>then</i> click <b>Orchestrate</b> here to hand the improved epic to the orchestrator to implement.</div>
    </div>
</details>
```

**2. Add a `?` button to the controls strip (after the `+ New Epic` button, line 1479):**

```html
<button id="btn-new-epic" class="strip-btn">+ New Epic</button>
<button id="btn-epic-modes-help" class="strip-btn" title="How to run an epic (3 ways)" style="font-weight: bold; min-width: 28px; padding: 2px 8px;">?</button>
```

**3. Add the modal overlay (after the Epic Orchestration overlay, ~line 1664):**

```html
<!-- Epic Modes Help Modal -->
<div id="epic-modes-help-overlay" class="kanban-log-overlay" style="display: none;">
    <div class="kanban-log-modal" style="width: 480px; max-width: 90vw;">
        <div style="padding: 12px 16px; font-weight: bold; border-bottom: 1px solid var(--border-color);">
            How to Run an Epic (3 Ways)
        </div>
        <div style="padding: 16px; line-height: 1.6; font-size: 12px;">
            <div style="margin-bottom: 10px;"><b>Step</b> — drag the epic column-to-column on the board; each column's agent batch-processes every subtask.</div>
            <div style="margin-bottom: 10px;"><b>Orchestrate</b> — click <b>Orchestrate</b> on an epic; one orchestrator agent runs the whole epic end-to-end with native subagents.</div>
            <div><b>Split (recommended)</b> — drag the epic to the <b>Planner</b> column to improve every subtask plan, <i>then</i> click <b>Orchestrate</b> in the Epics tab to hand the improved epic to the orchestrator to implement.</div>
        </div>
        <div class="kanban-log-close" style="display: flex; justify-content: flex-end; padding: 12px 16px;">
            <button id="btn-epic-modes-help-close" class="strip-btn">Close</button>
        </div>
    </div>
</div>
```

### `src/webview/project.js`

**4. Add open/close handlers (near the epic orchestration handlers, after line 1530):**

Use the `?.addEventListener` pattern to match the existing convention at `project.js:1528-1530`:

```javascript
// ---- Epic modes help modal ----
document.getElementById('btn-epic-modes-help')?.addEventListener('click', () => {
    const ov = document.getElementById('epic-modes-help-overlay');
    if (ov) ov.style.display = 'flex';
});
document.getElementById('btn-epic-modes-help-close')?.addEventListener('click', () => {
    const ov = document.getElementById('epic-modes-help-overlay');
    if (ov) ov.style.display = 'none';
});
// Close on overlay backdrop click
document.getElementById('epic-modes-help-overlay')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) e.currentTarget.style.display = 'none';
});
```

### `src/webview/project.html` — CSS cleanup (confirmed no-op)

**5. No CSS cleanup needed.** Verified: there is no CSS rule referencing `.epic-modes-explainer` anywhere in `src/webview/` — the `<details>` element used only inline styles. The class name appears exclusively in the HTML block being deleted in step 1. No further action required.

## Verification Plan

> Manual verification against an installed VSIX (per project norm).
> Compilation and automated tests are skipped per session directives.

### Automated Tests

No automated tests required — this is a pure UI refactor with no backend logic, state changes, or data flow. The change moves existing HTML content into an existing modal pattern. Verification is manual (see below).

### Manual Verification

1. **Modal opens:** Click the `?` button in the Epics tab controls strip → the "How to Run an Epic (3 Ways)" modal appears with all three modes described.
2. **Modal closes:** Click "Close" or click the overlay backdrop → modal disappears.
3. **No inline explainer:** The old `<details>` "How to run an epic" block is gone from the Epics tab — the controls strip is cleaner.
4. **Tooltip:** Hover the `?` button → "How to run an epic (3 ways)" tooltip appears.
5. **Theme check:** Open in afterburner, claudify, and cyber themes → modal renders correctly (reuses `.kanban-log-overlay` / `.kanban-log-modal` which are already theme-aware).
6. **No regression:** The Orchestrate button, + Subtask, Delete Epic, and New Epic buttons all still work as before.
7. **No DOM conflict:** Open the help modal, then close it. Open a Kanban plan log from the Kanban tab. Confirm the help modal and other static modals still open correctly afterwards (verifies the pre-existing `showKanbanLogOverlay` issue is not triggered by normal usage flow).

---

**Recommendation:** Complexity 2/10 → **Send to Intern**. This is a routine, single-pass UI change that follows an established pattern with no backend or state implications.

---

## Review Pass (2026-06-25)

### Stage 1 — Grumpy Principal Engineer (adversarial)

Severity-tagged findings against the actual implementation:

- **CRITICAL:** None.
- **MAJOR:** None.
- **NIT:** The pre-existing `showKanbanLogOverlay` selector bug (`project.js:2153`) remains unfixed — pre-existing, correctly documented in plan, deferred. Verified: `document.querySelector('.kanban-log-overlay')` first-match is always `#new-epic-modal` (project.html:1584); the new help modal at line 1629 is never the first match, so this change introduces no new risk. The New Epic modal gets nuked when a Kanban plan log opens — real bug, but not THIS plan's bug.

Implementation faithfulness verified:
- `<details class="epic-modes-explainer">` fully removed — zero matches across `src/`. No orphaned CSS or JS references. ✓
- `?` button at project.html:1449 — uses `strip-btn` class, `title` tooltip present, compact inline styles. ✓
- Modal at project.html:1628-1643 — reuses `.kanban-log-overlay`/`.kanban-log-modal`, placed after Orchestrate overlay, before Add Subtask overlay. ✓
- JS handlers at project.js:1627-1638 — `?.addEventListener` pattern, correct `display: 'flex'`/`'none'` toggling, backdrop click guard. ✓
- Text adapted correctly: "below"→"on an epic", "here"→"in the Epics tab" — proper contextual adaptation for modal (vs. inline) placement. ✓

### Stage 2 — Balanced Synthesis

**Keep as-is:** All HTML and JS changes — faithful to plan, follow established patterns.
**Fix now:** Nothing — no CRITICAL/MAJOR findings.
**Defer:** `showKanbanLogOverlay` selector bug (project.js:2153) → separate plan; give dynamic log overlay a distinct class (e.g. `.dynamic-log`) and update selector.

### Code Fixes Applied

None required.

### Validation Results

- Compilation: skipped per session directives.
- Automated tests: skipped per session directives.
- Static verification: all checks passed (see Stage 1 checklist above).

### Files Changed (Actual)

- `src/webview/project.html` — removed `<details>` explainer (was ~line 1481); added `?` button at line 1449; added help modal at lines 1628-1643.
- `src/webview/project.js` — added open/close/backdrop handlers at lines 1627-1638.

### Remaining Risks

1. **Pre-existing `showKanbanLogOverlay` selector bug** (project.js:2153) — not introduced by this plan, but still latent. Opening a Kanban plan log removes `#new-epic-modal` from the DOM. Fix: separate plan with a more specific selector.
2. **No Escape-key close** — follows existing convention (no modal in project.js handles Escape). Scope creep to add.
