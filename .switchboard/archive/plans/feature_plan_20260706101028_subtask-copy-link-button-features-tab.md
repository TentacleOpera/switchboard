# Add Copy Link button to subtask meta bar in Features tab

**Plan ID:** 51B9F9AE-6B55-4AB8-99F2-A33B4F920F21

## Goal

Add a Copy Link button to the subtask preview meta bar (`renderFeatureSubtaskMetaBar`) in the Features tab of `project.html`, so that every plan-viewing surface in the project panel webview offers the same copy-plan-link action. This closes a UI consistency gap found during testing — the subtask meta bar is currently the only plan preview surface without a Copy Link button.

### Problem
In the Features tab of `project.html`, when a user clicks on an individual subtask (a plan that belongs to a feature), the preview meta bar ("functions bar") is rendered by `renderFeatureSubtaskMetaBar()`. This bar shows a "Subtask" label, a Complexity indicator, and Edit / Save / Cancel / Delete buttons — but it is **missing a Copy Link button**.

Every other plan-viewing surface in the same webview already has a Copy Link button:
- The Kanban tab meta bar (`kanban-meta-copy-link-btn`, project.js:1807)
- The Kanban sidebar list items (`.kanban-plan-copy-link`, project.js:1570)
- The Features tab feature-card list items (`.kanban-plan-copy-link.feature-card-action`, project.js:2179)

The subtask meta bar is the only plan preview surface without one, so users must back out to the feature card list to copy a subtask's plan-file link — an inconsistency discovered during testing.

### Root Cause
`renderFeatureSubtaskMetaBar(plan)` (project.js:2400–2488) builds its innerHTML without emitting a Copy Link button, and has no click-listener wiring for one. The `plan` object it receives already carries `planFile` (set at project.js:2515 from the cache or the link's `data-plan-file`), so all data needed for the button is present — it was simply never added.

## Metadata
- **Tags:** ui, frontend, feature
- **Complexity:** 2

## User Review Required

No. This is a pure UI additive change that mirrors an already-established pattern (the Kanban meta bar Copy Link button at project.js:1807–1840). No backend, no data model, no state-machine, no migration. Safe to proceed directly to implementation.

## Complexity Audit

### Routine
- Pure UI additive change in a single file (`src/webview/project.js`).
- Mirrors an existing, well-established pattern: the Kanban meta bar Copy Link button at project.js:1807–1840 (HTML emission + listener wiring). No new architectural pattern introduced.
- No backend changes, no extension-side changes, no state-machine changes, no data-model changes, no migrations.
- The CSS class used by the button (`.strip-btn`) is already defined at project.html:136 and is the same class used by the sibling Edit / Save / Cancel / Delete buttons in this same meta bar — visual consistency is automatic.
- The `toAgentRef()` helper is already in scope (defined in `src/webview/sharedUtils.js:7`, bundled with `project.js`, and already called at 4 existing sites in project.js: 1516, 1591, 1834, 2235). It is a passthrough that returns the path as-is.
- All data needed by the button (`plan.planFile`) is already present on the `plan` object passed into `renderFeatureSubtaskMetaBar` (set at project.js:2515).
- Every line number cited in this plan has been verified against the current source (project.js total 3332 lines; project.html total lines unchanged).

### Complex / Risky
- None. The only residual risk is a duplicate-element-id collision, avoided by using a dedicated subtask id (see Edge-Case audit item 3). A cosmetic micro-issue around the "Copied" timeout firing on a detached node exists but is harmless and matches the existing Kanban button's behavior — documented as accepted-consistency, not a risk.

## Edge-Case & Dependency Audit

1. **Subtask with no `planFile`** — Some subtask previews are loaded from a `data-plan-file` attribute that could be empty (project.js:2499 guards with `st.planFile || ''`). The button must be conditionally rendered only when `plan.planFile` is truthy, exactly as the Kanban meta bar does (`${plan.planFile ? ... : ''}`). ✅ handled by conditional emission.

2. **Subtask with no `planId`** — `renderFeatureSubtaskMetaBar` already gates the Complexity and Delete controls behind `hasPlanId`. Copy Link only needs `planFile`, not `planId`, so it should be gated on `plan.planFile` independently — not on `hasPlanId`. This means a subtask resolved purely from a file path (the fallback object at project.js:2515) still gets a Copy Link button. ✅ correct behavior.

3. **Element ID collision** — The Kanban meta bar uses `kanban-meta-copy-link-btn`. The feature-card list uses a class-based selector. The subtask meta bar must use a **distinct id** (e.g. `feature-subtask-meta-copy-link-btn`) because `renderFeatureSubtaskMetaBar` and `renderFeatureMetaBar` render into the **same** `#feature-preview-meta-bar` container. Reusing the kanban id would not collide (different tabs), but reusing a feature-level id would. A dedicated subtask id is safest. ✅ handled.

4. **Edit-mode visibility** — Copy Link is a read-only action; it should remain visible in both view and edit modes (unlike Edit/Save/Cancel which toggle). The Kanban meta bar keeps Copy Link always visible, so we mirror that. ✅ **Verified:** `enterEditMode('features')` (project.js:2915) and `exitEditMode('features')` (project.js:2962) only toggle the `btn-edit/save/cancel` inline `display` styles and the preview-pane `edit-mode` class — they do **not** re-render the meta bar or call `renderFeatureSubtaskMetaBar`. Therefore the Copy Link button, once rendered, persists across edit-mode toggles. No special toggling needed.

5. **Clipboard API in VS Code webview** — `navigator.clipboard.writeText` is already used successfully by the other Copy Link buttons in this same webview (project.js:1591, 1834, 2235), so no sandbox concern. ✅ verified by existing working buttons.

6. **No confirm dialog** — Per project rule (CLAUDE.md), Copy Link is non-destructive and needs no confirm gate. ✅ compliant. (Also: `window.confirm()` is a silent no-op in VS Code webviews, so a confirm gate would break the button regardless.)

7. **Stale button after switching render paths** — Clicking the feature card itself (not a subtask) calls `renderFeatureMetaBar`, which overwrites `#feature-preview-meta-bar.innerHTML` (full replace). Any previously-rendered subtask Copy Link button DOM is destroyed and its listener GC'd — no stale button remains. ✅ no special cleanup needed.

8. **"Copied" timeout firing on a detached node** — If the user clicks Copy Link then immediately selects another subtask, `metaBar.innerHTML = ...` destroys the old button while the 2-second `setTimeout` is still pending. The callback fires on a garbage node and sets `textContent` harmlessly. This is the **exact same behavior** as the Kanban meta bar button (project.js:1837). Accepted as consistency; not a bug. ✅ documented.

### Race Conditions
- None. The click handler is synchronous up to the async `navigator.clipboard.writeText` promise; the only async continuation is the cosmetic "Copied" text revert, which is benign even if the button is detached (see item 8).

### Security
- None. The button writes `toAgentRef(plan.planFile)` to the clipboard. `toAgentRef` (sharedUtils.js:7) is a passthrough returning the path as-is — no interpolation, no eval, no HTML injection (the path is not re-inserted into the DOM; it goes to the clipboard). The button's own HTML is a static string with no user-controlled attribute interpolation.

### Side Effects
- Clipboard write (intended). A transient 2-second label change to "Copied" on the button. No state mutation, no messages to the extension host, no plan/column/feature changes.

### Dependencies & Conflicts
- Depends on: `toAgentRef` (sharedUtils.js:7, already in scope), `navigator.clipboard.writeText` (already used by 3 sibling buttons), the `.strip-btn` CSS class (project.html:136, already defined).
- Conflicts: None. No other in-flight change targets `renderFeatureSubtaskMetaBar`. The new element id `feature-subtask-meta-copy-link-btn` is unique across the webview.

## Dependencies
- None.

## Adversarial Synthesis

Key risks: (1) wrong CSS class citation and non-allowed tags would mislead the implementer and break plan parsing; (2) a duplicate element id would collide with `renderFeatureMetaBar` in the shared `#feature-preview-meta-bar` container. Mitigations: cite `.strip-btn` (project.html:136) — the class actually used — and use a dedicated subtask id `feature-subtask-meta-copy-link-btn`; gate the button on `plan.planFile` (not `hasPlanId`) so the fallback-object subtask still gets it; tags restricted to the allowed list (`ui, frontend, feature`). Residual micro-issue (detached "Copied" timeout) is harmless and matches the existing Kanban button's behavior — accepted as consistency.

## Proposed Changes

### File: `src/webview/project.js`

**Change 1 — Add the Copy Link button to the subtask meta bar HTML (in `renderFeatureSubtaskMetaBar`).**

Insert the button into the complexity group (or as a standalone next to it), gated on `plan.planFile`. Place it inside the `complexityGroup` block so it sits next to the complexity indicator, mirroring the Kanban meta bar layout.

At project.js:2409–2418, the `complexityGroup` is built. Add a `copyLinkBtn` constant and emit it:

```js
const copyLinkBtn = plan && plan.planFile
    ? `<button class="strip-btn" id="feature-subtask-meta-copy-link-btn" title="Copy plan link to clipboard">Copy Link</button>`
    : '';
```

Then in the `metaBar.innerHTML` template (project.js:2422–2433), insert `${copyLinkBtn}` after the complexity group and before the right-aligned action group:

```js
metaBar.innerHTML = `
    <div class="kanban-meta-group">
        <span class="kanban-meta-label" style="color: var(--text-secondary); font-style: italic;">Subtask</span>
    </div>
    ${complexityGroup}
    ${copyLinkBtn}
    <div class="kanban-meta-group" style="margin-left: auto;">
        <button class="strip-btn" id="btn-edit-features" style="${state.editMode.features ? 'display:none;' : ''}">Edit</button>
        <button class="strip-btn" id="btn-save-features" style="${state.editMode.features ? '' : 'display:none;'}">Save</button>
        <button class="strip-btn" id="btn-cancel-features" style="${state.editMode.features ? '' : 'display:none;'}">Cancel</button>
        ${deleteBtn}
    </div>
`;
```

**Clarification (styling choice):** The button uses the `strip-btn` class — the **same class** used by the sibling Edit / Save / Cancel / Delete buttons in this meta bar — so it visually matches the other meta-bar buttons. The `.kanban-plan-copy-link` class (project.html:386) is intentionally **not** used: that class is sized for the small transparent inline actions in the feature-card list and Kanban sidebar, not for meta-bar buttons. No `project.html` CSS changes are required either way.

**Change 2 — Wire the click listener (in `renderFeatureSubtaskMetaBar`).**

After the existing listener-wiring block (project.js:2435–2456 area), add the Copy Link handler. This mirrors the Kanban meta bar handler at project.js:1830–1840:

```js
// Copy Link — mirror kanban meta bar pattern (project.js:1830-1840)
const subtaskCopyLinkBtn = document.getElementById('feature-subtask-meta-copy-link-btn');
if (subtaskCopyLinkBtn) {
    subtaskCopyLinkBtn.addEventListener('click', () => {
        const path = plan.planFile;
        navigator.clipboard.writeText(toAgentRef(path)).then(() => {
            const oldText = subtaskCopyLinkBtn.textContent;
            subtaskCopyLinkBtn.textContent = 'Copied';
            setTimeout(() => { subtaskCopyLinkBtn.textContent = oldText; }, 2000);
        });
    });
}
```

This block should be placed **outside** the `if (hasPlanId)` guard (project.js:2459) since Copy Link only requires `planFile`, not `planId`.

### No other files need changes
- `project.html` — the `.strip-btn` CSS class used by the button is already defined (project.html:136), and is the same class used by the other subtask meta-bar buttons (Edit/Save/Cancel/Delete). The `.kanban-plan-copy-link` class (project.html:386) exists but is intentionally not used here (see Clarification above).
- No backend/extension-side changes — Copy Link is a pure client-side clipboard operation using the already-available `toAgentRef()` helper (sharedUtils.js:7, already in scope at 4 existing call sites in project.js).

## Verification Plan

### Automated Tests
None. Per session directive, automated tests and project compilation (`npm run compile`) are skipped. Verification is manual webview inspection only.

### Manual Verification
1. **Manual (webview):** Open the project panel → Features tab → click a feature card to expand it → click a subtask link in the Subtasks accordion. Confirm the preview meta bar now shows a "Copy Link" button between the complexity indicator and the Edit/Save/Cancel group.
2. **Click Copy Link** → paste into a text field → confirm the clipboard contains the agent-ref link (same format as the Kanban tab's Copy Link produces — i.e. the raw `planFile` path, since `toAgentRef` is a passthrough).
3. **Visual feedback:** Confirm the button text temporarily changes to "Copied" for ~2 seconds then reverts.
4. **Edge case — subtask with no planId:** Click a subtask whose plan isn't in the kanban cache (fallback object at project.js:2515). Confirm Copy Link still appears (gated on `planFile`, not `planId`) and works, while Delete and Complexity correctly stay hidden.
5. **Edge case — subtask with no planFile:** If a subtask link has an empty `data-plan-file`, confirm no Copy Link button renders (no broken empty button). (Note: project.js:2509 already shows a toast and aborts the preview for empty `planFile`, so this case is largely unreachable in practice — verify the toast still fires.)
6. **Edit-mode persistence:** Click a subtask → click Edit → confirm the Copy Link button remains visible during edit mode (enterEditMode/exitEditMode do not re-render the meta bar). Click Save/Cancel → confirm Copy Link still visible.
7. **No regression:** Switch back to the feature-level view (click the feature card itself, not a subtask). Confirm `renderFeatureMetaBar` still renders correctly and is not affected by the new code (different render path, same container — verify no stale subtask Copy Link button remains after the full innerHTML replace).

## Recommendation

Complexity 2 → **Send to Intern.** Single-file, pure UI additive change mirroring an established pattern; all line numbers verified; no backend, no state, no migrations.

> Note: This is the fourth Copy Link button in the project panel webview, each with its own unique id and direct listener. A future tech-debt cleanup could consolidate these via a `data-action="copy-link"` attribute and a single delegated listener on a shared ancestor — out of scope for this routine change.

## Review Findings

Files changed: `src/webview/project.js` only — `copyLinkBtn` const gated on `plan.planFile` (not `hasPlanId`), emitted between the complexity group and the right-aligned action group, with a click handler wired **outside** the `hasPlanId` guard mirroring the kanban Copy Link pattern (project.js:1830). Validation: `node --check src/webview/project.js` passes; the dedicated id `feature-subtask-meta-copy-link-btn` is unique (no collision with `renderFeatureMetaBar` in the shared `#feature-preview-meta-bar`); `toAgentRef` confirmed in scope (sharedUtils.js:7, 5 call sites in project.js); no `project.html` CSS change needed since it reuses the existing `.strip-btn` class. This change coexists cleanly with the co-landed Remove-consolidation change to the same meta bar (distinct ids/placement, no conflict). Remaining risk: the detached-node "Copied" `setTimeout` is harmless and identical to the existing kanban button — accepted as consistency. No CRITICAL/MAJOR issues found; no code fixes applied.
