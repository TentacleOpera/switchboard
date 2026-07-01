# Move Auto-Fetch Controls Into a Modal in project.html Kanban Plans Tab

**Plan ID:** 66adcf76-dc81-4491-9fef-a7a2e5b15809

## Goal

The auto-fetch controls in the Kanban Plans tab (`project.html`) sit on their own dedicated line — a full-width strip below the controls bar — just to hold a checkbox, a "Fetch now" button, and a status text. This wastes vertical space for a feature most users interact with once (to enable it) and then ignore. 

This plan removes the standalone auto-fetch strip, adds a compact **AutoFetch** button to the existing controls bar, and moves all auto-fetch controls + an explanation of what the feature does into a modal accessed via that button.

### Problem Analysis & Root Cause

The auto-fetch strip is defined at `project.html` lines 1447–1454:

```html
<div class="kanban-auto-fetch-strip" style="display: flex; align-items: center; gap: 10px; margin: 4px 0 10px 0; padding: 4px 10px; font-size: 11px; background: var(--vscode-editor-background); border: 1px solid var(--vscode-widget-border); border-radius: 4px;">
    <label style="display: flex; align-items: center; gap: 5px; cursor: pointer; user-select: none; margin: 0;">
        <input type="checkbox" id="kanban-auto-fetch-enabled" style="margin: 0; cursor: pointer;" />
        <span>Auto-fetch plans from <strong id="kanban-auto-fetch-branch">default branch</strong></span>
    </label>
    <button id="btn-plan-auto-fetch-now" class="strip-btn" style="padding: 2px 6px; font-size: 10px;" title="Fetch and fast-forward now">Fetch now</button>
    <span id="kanban-auto-fetch-status" style="opacity: 0.8; margin-left: auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></span>
</div>
```

It sits between the `kanban-controls-strip` (workspace/project/column/complexity filters + Import/Create/Chat Prompt/search) and the `content-row` (list pane + preview pane). It permanently consumes ≈30px of vertical space regardless of whether auto-fetch is enabled. There is also **no explanation anywhere** of what "auto-fetch plans from default branch" actually means — the user has to guess or read the source.

Root cause: the controls were added inline as a quick strip rather than behind a button + modal, and no explanatory copy was included.

**What auto-fetch actually does** (traced in `PlanAutoFetchService.ts`):
- On a configurable interval (default 300s, min 60s), fetches the default branch from the git remote (default `origin`).
- If the current branch IS the default branch AND the working tree is clean, it fast-forwards `.switchboard/plans/` to match the remote — pulling in new plan files authored by teammates.
- Only applies changes from **trusted authors** (defaults to the local git `user.email`; configurable via `switchboard.planAutoFetch.trustedAuthors`).
- Skips silently if on a feature branch or the working tree is dirty.
- Has exponential backoff on consecutive fetch failures.
- Runs one cycle on startup if enabled.

## Metadata

- **Tags:** `ui`, `project`, `kanban`, `auto-fetch`, `refactor`
- **Complexity:** 3/10
- **Files touched:** `src/webview/project.html`, `src/webview/project.js` (2 files)
- **Shipped-state impact:** UI reorganization of a released webview. The auto-fetch checkbox/button element IDs are preserved (moved into a modal, not renamed), so the JS handlers in `project.js` and the `planAutoFetchState` message handler continue to work unchanged. No data, no migration, no backend changes.

## User Review Required

No review gate required. This is a UI reorganization + copy addition with no logic or data impact.

## Complexity Audit

### Routine
- Remove the `.kanban-auto-fetch-strip` div from the Kanban tab markup.
- Add an **AutoFetch** button to the `kanban-controls-strip` (next to Import/Create/Chat Prompt).
- Add a new modal overlay (reusing the existing `.kanban-log-overlay` / `.kanban-log-modal` pattern already used by the New Epic modal at line 1654 and the Add Subtask modal at line 1677 in the same file — note: the Constitution Paths modal at line 1696 uses a DIFFERENT `.folder-modal` / `.modal-content` pattern and is NOT a reference for this modal) containing: the enable checkbox, the "Fetch now" button, the status text, the resolved branch label, and an explanation section.
- Add JS to show/hide the modal (open on AutoFetch button click, close on close button). **Clarification:** existing modals in this file (New Epic, Add Subtask) do NOT handle Escape key or backdrop click — they only close via explicit cancel/submit buttons. To match existing conventions, skip Escape and backdrop handling. If added, flag explicitly as a new interaction pattern.
- The existing `planAutoFetchState` message handler in `project.js` (lines 393–413) already updates the checkbox, branch label, and status text by element ID — these elements just move into the modal, so no handler changes needed.

### Complex / Risky
- None. All changes are confined to the two webview files. The element IDs (`kanban-auto-fetch-enabled`, `kanban-auto-fetch-branch`, `kanban-auto-fetch-status`, `btn-plan-auto-fetch-now`) are preserved. The existing event listeners in `project.js` (lines 1822–1836) attach by ID and will find the elements inside the modal.

## Edge-Case & Dependency Audit

- **Modal open state vs. auto-fetch status updates:** the `planAutoFetchState` message is pushed periodically and after a "Fetch now" click. If the modal is open, the status text inside it updates live — this is desirable. If the modal is closed, the status text element still exists in the DOM (just hidden), so the handler doesn't error. No issue.
- **"Fetch now" button inside modal:** clicking it posts `planAutoFetchRunNow`, which triggers a status push. The button should show a brief busy state ("Fetching…") while in flight. Add a simple text-swap + auto-restore on the next `planAutoFetchState` push.
- **Checkbox state persistence:** the checkbox toggles `switchboard.planAutoFetch.enabled` via `setPlanAutoFetchEnabled`. This is a workspace setting that persists across sessions. The modal should reflect the current setting on open — the `planAutoFetchState` handler already keeps the checkbox in sync, so opening the modal shows the current state.
- **Modal stacking:** the existing modals (New Epic, Add Subtask, Constitution Paths) all use `z-index: 1000`. The auto-fetch modal should use the same `kanban-log-overlay` class to inherit the z-index and backdrop. No stacking conflict since only one is open at a time.
- **Mobile/narrow viewports:** the controls strip has `overflow-x: auto`, so the new AutoFetch button scrolls horizontally on narrow widths. No layout breakage.
- **Element ID preservation:** the modal must use the same IDs for the checkbox, branch label, status span, and fetch-now button. If any ID changes, the `project.js` handlers break. Verified all four IDs are referenced by ID in `project.js` — keep them identical.
- **Escape key handling:** add an Escape key listener to close the modal, consistent with expected modal behavior. Check whether existing modals in this file handle Escape — if not, skip to match existing conventions (the New Epic modal doesn't appear to handle Escape, so matching that is acceptable, but adding it is a low-risk improvement).

## Proposed Changes

### File: `src/webview/project.html`

#### 1. Add the AutoFetch button to the controls strip (after the Chat Prompt button at line 1444, before the search input at line 1445)

The `kanban-controls-strip` starts at line 1425 and closes at line 1446. The CHAT PROMPT button is at line 1444. Insert the AutoFetch button after line 1444 and before line 1445 (the `kanban-search` input):

```html
<button id="btn-kanban-autofetch" class="strip-btn" title="Configure auto-fetch of plans from the default branch">⚙ AutoFetch</button>
```

#### 2. Remove the standalone auto-fetch strip (delete lines 1447–1454)

Remove the entire `<div class="kanban-auto-fetch-strip">…</div>` block.

#### 3. Add the auto-fetch modal (after the Add Subtask modal closes at line 1693, before the Constitution Paths modal at line 1695)

```html
<div id="autofetch-modal" class="kanban-log-overlay" style="display: none;">
    <div class="kanban-log-modal" style="width: 480px;">
        <div style="padding: 12px 16px; font-weight: bold; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
            <span>Auto-Fetch Plans</span>
            <button id="btn-close-autofetch-modal" class="strip-btn" style="padding: 2px 8px;" aria-label="Close">&times;</button>
        </div>
        <div style="padding: 16px; display: flex; flex-direction: column; gap: 14px;">
            <!-- Explanation -->
            <div style="font-size: 11px; color: var(--text-secondary); line-height: 1.6; background: var(--panel-bg2); border: 1px solid var(--border-color); border-radius: 4px; padding: 10px;">
                <strong style="color: var(--text-primary);">What this does:</strong><br/>
                Periodically fetches the default branch from the <code>origin</code> remote and fast-forwards your local <code>.switchboard/plans/</code> directory to pull in plan files authored by teammates. Only runs when you're on the default branch with a clean working tree. Only applies changes from <strong>trusted authors</strong> (defaults to your git <code>user.email</code>; configurable in VS Code settings under <code>switchboard.planAutoFetch.trustedAuthors</code>). Skips silently on feature branches or dirty trees. Uses exponential backoff on repeated fetch failures.
            </div>
            <!-- Enable toggle -->
            <label style="display: flex; align-items: center; gap: 8px; cursor: pointer; user-select: none; font-size: 12px;">
                <input type="checkbox" id="kanban-auto-fetch-enabled" style="margin: 0; cursor: pointer;" />
                <span>Enable auto-fetch from <strong id="kanban-auto-fetch-branch">default branch</strong></span>
            </label>
            <!-- Fetch now + status -->
            <div style="display: flex; align-items: center; gap: 10px;">
                <button id="btn-plan-auto-fetch-now" class="strip-btn" style="padding: 4px 12px; font-size: 11px;" title="Fetch and fast-forward now">Fetch now</button>
                <span id="kanban-auto-fetch-status" style="opacity: 0.8; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;"></span>
            </div>
            <!-- Settings hint -->
            <div style="font-size: 10px; color: var(--text-secondary); border-top: 1px solid var(--border-color); padding-top: 10px;">
                Interval (default 300s), remote, default branch, and trusted authors are configurable in VS Code Settings → Switchboard → Plan Auto Fetch.
            </div>
        </div>
    </div>
</div>
```

### File: `src/webview/project.js`

#### 4. Add modal open/close handlers (near the existing event listeners, ≈ line 1822)

```js
const btnKanbanAutofetch = document.getElementById('btn-kanban-autofetch');
const autofetchModal = document.getElementById('autofetch-modal');
const btnCloseAutofetchModal = document.getElementById('btn-close-autofetch-modal');

function openAutofetchModal() {
    if (autofetchModal) autofetchModal.style.display = 'flex';
}
function closeAutofetchModal() {
    if (autofetchModal) autofetchModal.style.display = 'none';
}

if (btnKanbanAutofetch) {
    btnKanbanAutofetch.addEventListener('click', openAutofetchModal);
}
if (btnCloseAutofetchModal) {
    btnCloseAutofetchModal.addEventListener('click', closeAutofetchModal);
}
// NOTE: No backdrop-click or Escape-key handling — matches existing modal conventions
// in this file (New Epic and Add Subtask modals only close via explicit buttons).
// If desired as a future enhancement, add backdrop + Escape handling to ALL modals
// consistently, not just this one.
```

#### 5. Add busy state to "Fetch now" button (ENHANCEMENT — the existing handler at line 1822 has no busy state; this is net-new UX, not preservation)

```js
const btnPlanAutoFetchNow = document.getElementById('btn-plan-auto-fetch-now');
if (btnPlanAutoFetchNow) {
    btnPlanAutoFetchNow.addEventListener('click', () => {
        btnPlanAutoFetchNow.disabled = true;
        btnPlanAutoFetchNow.textContent = 'Fetching…';
        vscode.postMessage({ type: 'planAutoFetchRunNow' });
    });
}
```

Then in the `planAutoFetchState` handler (line 393), restore the button after a status push:

```js
case 'planAutoFetchState': {
    // ... existing code ...
    if (btnPlanAutoFetchNow && msg.lastReason !== 'Fetching now...') {
        btnPlanAutoFetchNow.disabled = false;
        btnPlanAutoFetchNow.textContent = 'Fetch now';
    }
    break;
}
```

#### 6. No changes needed to the checkbox handler (line 1828–1836)

The `kanbanAutoFetchEnabled.addEventListener('change', …)` handler works unchanged — the checkbox just lives inside the modal now.

## Verification Plan

1. **Compile check:** `npm run compile`.
2. **Layout test:** Open the Project panel → Kanban Plans tab. Confirm:
   - The standalone auto-fetch strip is **gone** — the controls bar is followed directly by the content row.
   - A new **⚙ AutoFetch** button appears in the controls bar (after CHAT PROMPT, before the search input).
   - Vertical space is reclaimed (≈30px saved).
3. **Modal open/close test:** Click **⚙ AutoFetch**. Confirm the modal appears with: the explanation text, the enable checkbox, the "Fetch now" button, the status text, and the settings hint. Close via the × button, backdrop click, and Escape key — all three work.
4. **Enable toggle test:** Open the modal, check the enable checkbox. Confirm `setPlanAutoFetchEnabled` fires (check VS Code setting `switchboard.planAutoFetch.enabled` is now `true`). Uncheck — confirm it sets back to `false`.
5. **Fetch now test:** With auto-fetch enabled, click "Fetch now" in the modal. Confirm the button swaps to "Fetching…" and disables. On the next `planAutoFetchState` push, confirm it restores to "Fetch now" and the status text updates with the outcome.
6. **Live status test:** With the modal open, wait for a periodic auto-fetch cycle (or trigger one). Confirm the status text inside the modal updates live without reopening.
7. **Branch label test:** Confirm the `<strong id="kanban-auto-fetch-branch">` inside the modal shows the resolved branch name (e.g. "main") after a `planAutoFetchState` push.
8. **Theme test:** Verify the modal renders correctly in both cyber (default) and claudify themes — the `.kanban-log-overlay` / `.kanban-log-modal` classes are theme-agnostic.
9. **No-regression test:** Confirm the existing Import, Create, Chat Prompt, search, and all filter dropdowns in the controls bar still work — the AutoFetch button addition doesn't shift or break their layout.

## Dependencies

- None — this plan is self-contained within `project.html` and `project.js`.

## Adversarial Synthesis

Key risks: modal insertion point was originally specified inside the Constitution Paths modal (corrected to after line 1693); Escape/backdrop handling would introduce an inconsistent interaction pattern (corrected to match existing conventions); busy-state is net-new UX that must be labeled as enhancement. Mitigations: line numbers verified against source, modal pattern matched to the two `.kanban-log-overlay` modals only, element IDs preserved so existing handlers work unchanged.

## Recommendation

Complexity 3/10 → **Send to Coder**.
