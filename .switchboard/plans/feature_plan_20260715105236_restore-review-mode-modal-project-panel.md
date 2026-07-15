# Restore & Generalize the Plan Review Modal Across project.html Tabs

## Goal

When the Kanban plans tab was migrated from `planning.html` (Planning panel) into `project.html` (Project panel), the **plan review modal** was left behind. In the old Planning panel, a `REVIEW` button in the kanban meta bar toggled a "review mode": with review mode on, selecting text in the rendered plan preview popped up a floating comment popup (`#kanban-comment-popup`) showing the selected text plus a textarea, with a **Submit Comment** button that sent `selectedText + comment` to the planner terminal via the `switchboard.sendReviewComment` command. None of this was ported to `project.html` — the `state.reviewMode` object exists in `project.js` (line 61, `{ kanban: false }`) but is never read or written anywhere else in the file, and there is no popup DOM, no CSS, no selection handler, and no REVIEW button.

The user wants this capability restored **and generalized**: a **Review Mode** button should appear in **every tab of `project.html` except the Tuning tab** (i.e. Kanban, Features, Projects, Constitution, System). Toggling it on lets the user highlight text in that tab's rendered doc preview; a modal opens with the selected text, a comment textarea, and two actions — **Copy Prompt** (copies `selectedText + comment` to the clipboard) and **Send to Planner** (dispatches `selectedText + comment` to the planner terminal). This mirrors the per-tab "Inspect Mode" toggle button pattern used in `design.html`'s HTML tabs.

### Problem Analysis & Root Cause

- **Root cause:** The Project panel (`project.html` + `project.js`, served by `PlanningPanelProvider.ts`) was built by migrating tabs out of `planning.html` + `planning.js`. The review-mode feature — which in `planning.js` spans `enterReviewMode`/`exitReviewMode` (lines 7022–7047), `showKanbanCommentPopup`/`hideKanbanCommentPopup` (7049–7072), the `mouseup`/`mousedown` selection listeners on `#kanban-preview-content` (7076–7107), the submit/cancel wiring (7109–7142), the REVIEW button in `renderKanbanMetaBar` (7457, 7519–7528), and the `commentResult` message handler (5031) — was **not** ported. Only the dead `reviewMode: { kanban: false }` state stub survived.
- **Backend is already present:** `PlanningPanelProvider.ts` already handles `case 'submitComment'` (line 2910), resolving the plan path against workspace roots and calling `switchboard.sendReviewComment`. The `switchboard.sendReviewComment` command (`extension.ts` line 2655) resolves a target terminal by role priority and sends `> [selectedText] — Comment: "comment"\nPlan: <relativePath>`. It requires a non-empty `planFileAbsolute` that resolves to a path inside a workspace root. **No backend changes are required** for tabs whose viewed content maps to a file path.
- **Per-tab file context:** Each eligible tab has a distinct way to resolve the "current doc" path:
  - Kanban: `_kanbanSelectedPlan.planFile` (relative) + `.sessionId` + `.topic`
  - Features: `_featurePreviewFilePath || _featureSelectedPlan?.planFile` (relative) + sessionId/topic
  - Constitution: `_constitutionSelectedFile` (absolute) + `_constitutionSelectedWorkspace.workspaceRoot`
  - System: `_systemSelectedFile` (absolute) + `_systemSelectedWorkspace.workspaceRoot`
  - Projects: **no file** — the PRD is DB-backed (edited in `#projects-editor`, rendered in `#projects-preview-content`). For this tab, "Send to Planner" passes the workspace root as `planFileAbsolute` and the project name as `topic` so the planner still receives project-scoped context; "Copy Prompt" works identically to other tabs.
- **Tuning tab is excluded** by user requirement.

## Metadata

- **Tags:** project-panel, review-mode, ux, webview, kanban, features, constitution, system, projects
- **Complexity:** 6
- **Workspace:** switchboard

## Complexity Audit

**Verdict: Complex/Risky** (not Routine).

- The feature touches a shared webview (`project.html` / `project.js`) with six tabs and per-tab state. Generalizing a single-tab feature (kanban-only in `planning.js`) to five tabs requires a per-tab context-resolver abstraction rather than copy-pasting the kanban logic five times.
- The `state.reviewMode` object must be expanded to all five tabs and kept mutually exclusive with `editMode` per tab (entering review mode must exit edit mode, and vice versa) — mirroring the `planning.js` guard at lines 7024–7025 and 7884–7886.
- The Projects tab has no backing file, so the `submitComment` payload construction needs a tab-aware path/topic resolver with a deliberate fallback (workspace root + project name) rather than a naive reuse of the plan path.
- New user-facing affordance (Copy Prompt in the modal) that did not exist in the original `planning.js` popup — needs its own clipboard behavior and button feedback.
- Risk of regressing the existing edit-mode flow if review-mode toggling is not wired into the same `enterEditMode`/`exitEditMode`/tab-switch guards.

## Edge-Case & Dependency Audit

- **Edit-mode interaction:** Entering review mode on a tab must exit edit mode on that tab (and discard/keep dirty state consistently with existing `exitEditMode` semantics). Entering edit mode must exit review mode. The tab-switch handler (project.js lines 10–52) should exit review mode on the previously-active tab to avoid a stale popup when switching tabs.
- **Popup positioning:** `showKanbanCommentPopup` clamps the popup within the viewport using `window.innerWidth`/`window.innerHeight`. This must be preserved; the popup is `position: fixed` so it works regardless of scroll.
- **Empty/collapsed selection:** `mouseup` handler must no-op (and hide any stale popup) when `getSelection().toString().trim()` is empty — exactly as `planning.js` lines 7081–7089 do.
- **No selected doc:** If a tab has no currently-selected doc (e.g. kanban with no plan selected, constitution with no file), the Review Mode button should be disabled or no-op, and the popup must not appear. The button's disabled state should track whether a doc is loaded, mirroring how Edit buttons are gated.
- **Projects tab has no file:** `submitComment` requires `planFileAbsolute`. Fallback: pass `getProjectsTabWorkspaceRoot()` as the path and `_selectedProjectName` as `topic`. The backend's `path.relative(workspaceRoot, workspaceRoot)` yields `.`; the planner payload becomes `Plan: .` with the project name in the topic field. This is acceptable but should be documented in code. (Alternative — extending `ReviewCommentRequest` with an optional `docLabel` — is out of scope to keep the change frontend-only.)
- **Tuning tab exclusion:** The Review Mode button must not be injected into `#tuning-content`. The tab list is data-driven (`shared-tab-btn[data-tab]`); gate on an explicit allowlist `['kanban','features','projects','constitution','system']`.
- **Re-render of meta bars:** `renderKanbanMetaBar` and `renderFeatureMetaBar` rebuild their innerHTML on every selection, which destroys the REVIEW button and its listener. The REVIEW button must be re-wired inside those render functions (as `planning.js` does at 7519), OR placed in the static controls-strip of each tab so it survives meta-bar re-renders. **Recommendation: place the Review Mode button in each tab's static `.controls-strip`** (which is not re-rendered) to avoid re-wiring churn, and reflect toggle state by updating the button label/class.
- **`commentResult` feedback:** The original shows a transient "Comment sent" span in `.kanban-controls-strip`. The Project panel uses `showToast(msg, type)` (project.js line 82) for feedback — use `showToast` instead of appending spans, for consistency with the rest of project.js.
- **Theme compatibility:** The popup CSS uses `var(--panel-bg)`, `var(--border-color)`, etc. These variables exist in `project.html` (it shares the cyber/claudify theme system). Copy the CSS block verbatim from `planning.html` lines 2500–2552.

## Proposed Changes

### 1. `src/webview/project.html` — add popup DOM + CSS, and Review Mode buttons

**A. Add the comment-popup CSS** (port from `planning.html` lines 2500–2552). Insert near the other shared popup/modal styles:

```css
.comment-popup {
    position: fixed;
    z-index: 999;
    width: min(420px, calc(100vw - 24px));
    background: var(--panel-bg, #000000);
    border: 1px solid var(--border-color, rgba(255,255,255,0.12));
    border-radius: 6px;
    padding: 10px;
    box-shadow: 0 4px 16px rgba(0,0,0,0.4);
    display: none;
}
.comment-popup.visible { display: block; }
.popup-label {
    font-size: 11px;
    color: var(--text-secondary, #888);
    margin-bottom: 6px;
    font-family: var(--font-mono, monospace);
}
.selected-preview {
    font-size: 12px;
    color: var(--text-primary, #ccc);
    background: color-mix(in srgb, var(--accent-primary) 8%, transparent);
    border: 1px solid color-mix(in srgb, var(--accent-primary) 22%, transparent);
    border-radius: 4px;
    padding: 8px;
    margin-bottom: 8px;
    max-height: 80px;
    overflow: auto;
}
.comment-popup textarea {
    width: 100%;
    min-height: 76px;
    resize: vertical;
    background: var(--input-bg, rgba(255,255,255,0.06));
    color: var(--text-primary, #ccc);
    border: 1px solid var(--border-color, rgba(255,255,255,0.12));
    border-radius: 4px;
    padding: 8px;
    font-family: var(--font-family, sans-serif);
    font-size: 13px;
    margin-bottom: 10px;
}
.popup-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
}
.popup-actions button {
    background: transparent;
    border: 1px solid var(--border-color, rgba(255,255,255,0.12));
    color: var(--text-secondary, #888);
    /* ...match planning.html popup-actions button styling... */
}
.review-mode-btn.active {
    border-color: var(--accent-teal, #00f0ff);
    color: var(--accent-teal, #00f0ff);
}
```

**B. Add the popup DOM** once (shared across tabs — the popup is `position: fixed` and repositioned per selection). Add near the end of `<body>`, mirroring `planning.html` lines 4008–4016 but with the two action buttons the user requested:

```html
<div class="comment-popup" id="review-comment-popup">
    <div class="popup-label">Comment on selection</div>
    <div class="selected-preview" id="review-selected-preview"></div>
    <textarea id="review-comment-input" placeholder="Add your contextual feedback..."></textarea>
    <div class="popup-actions">
        <button id="review-cancel-comment">Cancel</button>
        <button id="review-copy-prompt">Copy Prompt</button>
        <button class="primary" id="review-submit-comment">Send to Planner</button>
    </div>
</div>
```

**C. Add a Review Mode button to each eligible tab's `.controls-strip`.** For the Kanban tab, insert into the existing controls strip (after `#btn-chat-copy-prompt`, project.html line 1155):

```html
<button id="btn-review-kanban" class="strip-btn review-mode-btn" title="Toggle review mode: highlight text in the plan to comment">Review</button>
```

Repeat for the other four tabs, placing each inside its respective `.controls-strip` with ids `btn-review-features`, `btn-review-projects`, `btn-review-constitution`, `btn-review-system`. Do **not** add one to `#tuning-content`.

### 2. `src/webview/project.js` — review-mode state, functions, listeners, and per-tab context resolver

**A. Expand `state.reviewMode`** (line 61) to all eligible tabs:

```js
reviewMode: { kanban: false, features: false, projects: false, constitution: false, system: false },
reviewSelectedText: '',
```

**B. Add a per-tab review-context resolver** that returns `{ planFileAbsolute, sessionId, topic }` for the currently-viewed doc, used by both Send to Planner and Copy Prompt:

```js
function getReviewContext(tab) {
    switch (tab) {
        case 'kanban': {
            const p = _kanbanSelectedPlan;
            return p ? { planFileAbsolute: p.planFile || '', sessionId: p.sessionId || '', topic: p.topic || '' } : null;
        }
        case 'features': {
            const p = _featureSelectedPlan;
            const file = _featurePreviewFilePath || (p && p.planFile) || '';
            return file ? { planFileAbsolute: file, sessionId: (p && p.sessionId) || '', topic: (p && (p.topic || p.name)) || '' } : null;
        }
        case 'constitution': {
            return _constitutionSelectedFile ? { planFileAbsolute: _constitutionSelectedFile, sessionId: '', topic: 'constitution' } : null;
        }
        case 'system': {
            return _systemSelectedFile ? { planFileAbsolute: _systemSelectedFile, sessionId: '', topic: 'system' } : null;
        }
        case 'projects': {
            // PRD is DB-backed (no file). Use the workspace root as the path so the
            // backend's workspace resolution succeeds, and the project name as topic.
            const wsRoot = getProjectsTabWorkspaceRoot();
            return _selectedProjectName && wsRoot ? { planFileAbsolute: wsRoot, sessionId: '', topic: _selectedProjectName } : null;
        }
        default:
            return null;
    }
}
```

**C. Add enter/exit/show/hide functions** (port of `planning.js` 7022–7072, generalized to a tab argument):

```js
const REVIEWABLE_TABS = ['kanban', 'features', 'projects', 'constitution', 'system'];

function enterReviewMode(tab) {
    if (!REVIEWABLE_TABS.includes(tab)) return;
    if (state.editMode[tab]) { if (!exitEditMode(tab, true)) return; }
    state.reviewMode[tab] = true;
    const btn = document.getElementById(`btn-review-${tab}`);
    if (btn) { btn.classList.add('active'); btn.textContent = 'Exit Review'; }
}

function exitReviewMode(tab, clearPopup) {
    if (!REVIEWABLE_TABS.includes(tab)) return;
    state.reviewMode[tab] = false;
    state.reviewSelectedText = '';
    if (clearPopup) hideReviewPopup(true);
    const btn = document.getElementById(`btn-review-${tab}`);
    if (btn) { btn.classList.remove('active'); btn.textContent = 'Review'; }
}

function hideReviewPopup(clear) {
    const popup = document.getElementById('review-comment-popup');
    if (popup) popup.classList.remove('visible');
    if (clear) {
        const input = document.getElementById('review-comment-input');
        if (input) input.value = '';
        state.reviewSelectedText = '';
    }
}

function showReviewPopup(rect, selectedText) {
    const popup = document.getElementById('review-comment-popup');
    if (!popup) return;
    const maxLeft = window.innerWidth - popup.offsetWidth - 12;
    popup.style.left = `${Math.max(12, Math.min(rect.left, maxLeft > 12 ? maxLeft : rect.left))}px`;
    popup.style.top = `${Math.min(window.innerHeight - 12, rect.bottom + 10)}px`;
    const preview = document.getElementById('review-selected-preview');
    if (preview) preview.textContent = selectedText;
    popup.classList.add('visible');
    const input = document.getElementById('review-comment-input');
    if (input) input.focus();
}
```

**D. Wire selection listeners on each tab's preview-content element.** Use a single loop over the eligible tabs to attach `mouseup`/`mousedown` handlers (port of `planning.js` 7076–7106):

```js
REVIEWABLE_TABS.forEach(tab => {
    const previewEl = document.getElementById(`${tab}-preview-content`);
    if (!previewEl) return;
    previewEl.addEventListener('mouseup', () => {
        if (!state.reviewMode[tab]) return;
        setTimeout(() => {
            const sel = window.getSelection();
            if (!sel || sel.rangeCount === 0) { hideReviewPopup(false); return; }
            const text = sel.toString().trim();
            if (!text) { hideReviewPopup(false); return; }
            const rect = sel.getRangeAt(0).getBoundingClientRect();
            state.reviewSelectedText = text;
            showReviewPopup(rect, text);
        }, 0);
    });
    previewEl.addEventListener('mousedown', (event) => {
        if (!state.reviewMode[tab]) return;
        const popup = document.getElementById('review-comment-popup');
        if (popup && !popup.contains(event.target)) {
            const sel = window.getSelection();
            if (!sel || !sel.toString().trim()) hideReviewPopup(false);
        }
    });
});
```

**E. Wire the popup action buttons** (Cancel, Copy Prompt, Send to Planner). Place near the other top-level listener wiring:

```js
const reviewCancelBtn = document.getElementById('review-cancel-comment');
if (reviewCancelBtn) reviewCancelBtn.addEventListener('click', () => hideReviewPopup(true));

const reviewCopyPromptBtn = document.getElementById('review-copy-prompt');
if (reviewCopyPromptBtn) reviewCopyPromptBtn.addEventListener('click', () => {
    if (!state.reviewSelectedText) { flashPreviewError(); return; }
    const ctx = getReviewContext(activeTab);
    const comment = (document.getElementById('review-comment-input')?.value || '').trim();
    const prompt = `> [${state.reviewSelectedText.replace(/\s+/g, ' ').trim()}]${comment ? ` — Comment: "${comment}"` : ''}${ctx?.topic ? `\nContext: ${ctx.topic}` : ''}`;
    navigator.clipboard.writeText(prompt).then(() => {
        reviewCopyPromptBtn.textContent = 'Copied!';
        setTimeout(() => { reviewCopyPromptBtn.textContent = 'Copy Prompt'; }, 2000);
    });
});

const reviewSubmitBtn = document.getElementById('review-submit-comment');
if (reviewSubmitBtn) reviewSubmitBtn.addEventListener('click', () => {
    const comment = (document.getElementById('review-comment-input')?.value || '').trim();
    if (!state.reviewSelectedText) { flashPreviewError(); return; }
    if (!comment) { flashCommentError(); return; }
    const ctx = getReviewContext(activeTab);
    if (!ctx || !ctx.planFileAbsolute) { showToast('No document loaded to review.', 'error'); return; }
    vscode.postMessage({
        type: 'submitComment',
        sessionId: ctx.sessionId,
        topic: ctx.topic,
        planFileAbsolute: ctx.planFileAbsolute,
        selectedText: state.reviewSelectedText,
        comment
    });
});
```

(`flashPreviewError` / `flashCommentError` are small helpers that flash the preview/input border red for 2s, mirroring `planning.js` 7120–7130.)

**F. Wire each tab's Review Mode toggle button:**

```js
REVIEWABLE_TABS.forEach(tab => {
    const btn = document.getElementById(`btn-review-${tab}`);
    if (btn) btn.addEventListener('click', () => {
        if (state.reviewMode[tab]) exitReviewMode(tab, true);
        else enterReviewMode(tab);
    });
});
```

**G. Guard edit-mode and tab-switch.** In `enterEditMode` (or wherever edit mode is entered per tab), add: if `state.reviewMode[tab]` then `exitReviewMode(tab, true)` first (mirror `planning.js` 7884–7886). In the tab-switch handler (project.js lines 10–52), before setting `activeTab = targetTab`, exit review mode on the current `activeTab` if it is reviewable:

```js
if (REVIEWABLE_TABS.includes(activeTab) && state.reviewMode[activeTab]) {
    exitReviewMode(activeTab, true);
}
```

**H. Handle the `commentResult` message** in the webview message switch (port of `planning.js` 5031, adapted to use `showToast`):

```js
case 'commentResult': {
    const { ok, message } = msg;
    if (ok) {
        hideReviewPopup(true);
        showToast('Comment sent to planner', 'success');
    } else {
        const submitBtn = document.getElementById('review-submit-comment');
        if (submitBtn) { submitBtn.style.borderColor = '#ff6b6b'; setTimeout(() => { submitBtn.style.borderColor = ''; }, 2000); }
        showToast(message || 'Failed to send comment', 'error');
    }
    break;
}
```

### 3. No backend changes required

`PlanningPanelProvider.ts` already handles `case 'submitComment'` (line 2910) and `switchboard.sendReviewComment` (`extension.ts` line 2655) already resolves the target terminal and sends the payload. The Projects-tab fallback (workspace root as `planFileAbsolute`) is accepted by the backend because `isPathWithinRoot(workspaceRoot, workspaceRoot)` is true. Confirm this path works during verification.

### 4. Test — `src/test/project-panel-review-mode.test.js` (new file, follow existing convention)

Mirror `project-panel-kanban-create-button.test.js`: read `project.html` and `project.js` as text and assert structural presence:

```js
assert.ok(htmlSource.includes('id="review-comment-popup"'), 'popup DOM present');
assert.ok(htmlSource.includes('id="btn-review-kanban"'), 'kanban review button');
assert.ok(htmlSource.includes('id="btn-review-features"'), 'features review button');
assert.ok(htmlSource.includes('id="btn-review-projects"'), 'projects review button');
assert.ok(htmlSource.includes('id="btn-review-constitution"'), 'constitution review button');
assert.ok(htmlSource.includes('id="btn-review-system"'), 'system review button');
assert.ok(!htmlSource.includes('id="btn-review-tuning"'), 'tuning review button absent');
assert.ok(jsSource.includes('REVIEWABLE_TABS'), 'reviewable tab allowlist');
assert.ok(jsSource.includes('function enterReviewMode'), 'enterReviewMode');
assert.ok(jsSource.includes('function getReviewContext'), 'per-tab context resolver');
assert.ok(jsSource.includes("type: 'submitComment'"), 'submitComment posted');
assert.ok(jsSource.includes('commentResult'), 'commentResult handled');
```

## Verification Plan

1. **Build:** run the project's build/compile step (per `package.json`) and confirm no TypeScript or bundling errors.
2. **Structural test:** run `node src/test/project-panel-review-mode.test.js` and confirm it passes.
3. **Existing tests:** run the existing project-panel test suite (`node src/test/project-panel-kanban-create-button.test.js`) to confirm no regression.
4. **Manual — Kanban tab:** open the Project panel, select a plan, click **Review** in the kanban controls strip, highlight text in the rendered plan preview → confirm the popup appears with the selected text, type a comment, click **Send to Planner** → confirm a planner terminal receives the `> [text] — Comment: "..."` payload and a success toast shows. Click **Copy Prompt** → confirm clipboard contains the prompt. Click **Exit Review** → confirm the popup no longer appears on selection.
5. **Manual — Features / Constitution / System tabs:** repeat step 4 on each tab, confirming the popup appears and Send to Planner resolves the correct file path (constitution/system use absolute paths; features use the plan file).
6. **Manual — Projects tab:** select a project, toggle Review, highlight PRD text, Send to Planner → confirm the planner terminal receives the comment with the project name as context (no crash from the missing file path).
7. **Manual — Tuning tab:** confirm no Review button is present and text selection does nothing.
8. **Manual — edit-mode guard:** with Review on, click Edit on the same tab → confirm review mode exits and edit mode activates without a stale popup. With Edit on, click Review → confirm edit mode exits first.
9. **Manual — tab-switch guard:** enable Review on Kanban, switch to Features → confirm kanban review mode exits and no popup lingers.
10. **Manual — empty selection:** click Review on, click (without dragging) in the preview → confirm no popup appears; if a popup was open, confirm it hides.
