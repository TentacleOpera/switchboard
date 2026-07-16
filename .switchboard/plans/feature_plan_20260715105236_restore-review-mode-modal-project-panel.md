# Restore & Generalize the Plan Review Modal Across project.html Tabs

## Goal

When the Kanban plans tab was migrated from `planning.html` (Planning panel) into `project.html` (Project panel), the **plan review modal** was left behind. In the old Planning panel, a `REVIEW` button in the kanban meta bar toggled a "review mode": with review mode on, selecting text in the rendered plan preview popped up a floating comment popup (`#kanban-comment-popup`) showing the selected text plus a textarea, with a **Submit Comment** button that sent `selectedText + comment` to the planner terminal via the `switchboard.sendReviewComment` command. None of this was ported to `project.html` — the `state.reviewMode` object exists in `project.js` (line 61, `{ kanban: false }`) but is never read or written anywhere else in the file, and there is no popup DOM, no CSS, no selection handler, and no REVIEW button.

The user wants this capability restored **and generalized**: a **Review Mode** button should appear in **every tab of `project.html` except the Tuning tab** (i.e. Kanban, Features, Projects, Constitution, System). Toggling it on lets the user highlight text in that tab's rendered doc preview; a modal opens with the selected text, a comment textarea, and two actions — **Copy Prompt** (copies `selectedText + comment` to the clipboard) and **Send to Planner** (dispatches `selectedText + comment` to the planner terminal). This mirrors the per-tab "Inspect Mode" toggle button pattern used in `design.html`'s HTML tabs.

### Problem Analysis & Root Cause

- **Root cause:** The Project panel (`project.html` + `project.js`, served by `PlanningPanelProvider.ts`) was built by migrating tabs out of `planning.html` + `planning.js`. The review-mode feature — which in `planning.js` spans `enterReviewMode`/`exitReviewMode` (lines 7022–7047), `showKanbanCommentPopup`/`hideKanbanCommentPopup` (7049–7072), the `mouseup`/`mousedown` selection listeners on `#kanban-preview-content` (7076–7107), the submit/cancel wiring (7109–7142), the REVIEW button in `renderKanbanMetaBar` (7457, 7519–7528), and the `commentResult` message handler (5031) — was **not** ported. Only the dead `reviewMode: { kanban: false }` state stub survived. (All line references confirmed against source during review.)
- **Backend is already present:** `PlanningPanelProvider.ts` already handles `case 'submitComment'` (line 2910), resolving the plan path against workspace roots and calling `switchboard.sendReviewComment`. The `switchboard.sendReviewComment` command (`extension.ts` line 2655) resolves a target terminal by role priority and sends `> [selectedText] — Comment: "comment"\nPlan: <relativePath>`. It requires a non-empty `planFileAbsolute` that resolves to a path inside a workspace root. **No backend changes are required** for tabs whose viewed content maps to a file path.
- **Per-tab file context:** Each eligible tab has a distinct way to resolve the "current doc" path:
  - Kanban: `_kanbanSelectedPlan.planFile` (relative) + `.sessionId` + `.topic`
  - Features: `_featurePreviewFilePath || _featureSelectedPlan?.planFile` (relative) + sessionId/topic
  - Constitution: `_constitutionSelectedFile` (absolute) + `_constitutionSelectedWorkspace.workspaceRoot`
  - System: `_systemSelectedFile` (absolute) + `_systemSelectedWorkspace.workspaceRoot`
  - Projects: **no file** — the PRD is DB-backed (edited in `#projects-editor`, rendered in `#projects-preview-content`). For this tab, "Send to Planner" passes the workspace root as `planFileAbsolute` so the backend's workspace-boundary check passes. See the **Projects-tab context caveat** in the Edge-Case audit — the backend does **not** forward the `topic` field, so the project name must be folded into the outgoing `comment` to actually reach the planner.
- **Tuning tab is excluded** by user requirement.

## Metadata

- **Tags:** frontend, ui, ux, feature
- **Complexity:** 6
- **Workspace:** switchboard

> **Superseded:** `**Tags:** project-panel, review-mode, ux, webview, kanban, features, constitution, system, projects`
> **Reason:** The `improve-plan` schema forbids tags outside the allowed list ([frontend, backend, auth, authentication, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library]). Only `ux` was valid; the rest were invented.
> **Replaced with:** `**Tags:** frontend, ui, ux, feature`

## User Review Required

- **Projects-tab context path (decision made):** the backend `sendReviewComment` payload builder ignores `request.topic`, so "Send to Planner" on the file-less Projects tab is fixed by prefixing `[Project: <name>]` into the outgoing `comment` (frontend-only). The alternative — extending `ReviewCommentRequest`/the payload builder with a `docLabel` — was rejected to keep the change frontend-only. Confirm you accept the comment-prefix approach.
- **Review-button disabled-state gating** is treated as a nice-to-have, not a blocker (Send degrades gracefully with an error toast when no doc is loaded). Confirm this is acceptable, or request strict `disabled` gating.

## Complexity Audit

### Routine
- Porting the popup DOM, CSS, and the `mouseup`/`mousedown`/`show`/`hide` selection logic from `planning.js`/`planning.html` — well-understood, sibling code exists to copy.
- Adding one toggle button per eligible tab into an existing static controls-strip.
- Reusing the existing, unchanged `submitComment` → `sendReviewComment` backend.

### Complex / Risky
- Generalizing a single-tab (kanban-only) feature to five tabs requires a per-tab context-resolver abstraction (`getReviewContext(tab)`) rather than copy-pasting kanban logic five times.
- `state.reviewMode` must expand to five tabs and stay **mutually exclusive with `editMode`** per tab (enter review ⇒ exit edit, and vice versa), plus exit-on-tab-switch — mirroring `planning.js` guards at 2290 and 7884–7886.
- The Projects tab has no backing file **and** the backend drops `topic`, so project context must be folded into the `comment` deliberately (see Edge-Case audit) rather than relying on a naive path/topic reuse.
- New user-facing affordance (Copy Prompt) that did not exist in the original `planning.js` popup — needs its own clipboard behavior and button feedback.
- Risk of regressing the existing edit-mode flow if review-mode toggling is not wired into the same enter/exit/tab-switch guards.

**Verdict: Mixed → Complexity 6.** Frontend-only, two source files plus one test, porting proven logic, but with real cross-tab state-coordination and a backend-limitation workaround.

## Edge-Case & Dependency Audit

### Race Conditions
- **Selection timing:** the `mouseup` handler defers reading the selection with `setTimeout(..., 0)` (as `planning.js` 7079 does) so the browser has committed the selection before `getSelection()` is read. Preserve this.
- **Meta-bar re-render churn:** `renderKanbanMetaBar` / `renderFeatureMetaBar` rebuild their innerHTML on every selection, destroying any button placed inside them. **Mitigation:** place each Review Mode button in the tab's **static `.controls-strip`** (kanban uses `.kanban-controls-strip`), which is not re-rendered, so no re-wiring is needed. Toggle state is reflected by updating the button's label/class.

### Security
- The backend enforces the workspace boundary: `sendReviewComment` rejects any `planFileAbsolute` that resolves outside a workspace root (`isPathWithinRoot`, extension.ts 445–465) and returns an error result. No new trust surface is introduced — the webview only supplies a path the backend re-validates.

### Side Effects
- **Edit-mode interaction:** entering review mode on a tab must exit edit mode on that tab; entering edit mode must exit review mode. The tab-switch handler (project.js lines 9–53) must exit review mode on the previously-active tab so no stale popup lingers across tabs.
- **Popup positioning:** `showReviewPopup` clamps the popup within the viewport using `window.innerWidth`/`window.innerHeight`; the popup is `position: fixed` so it works regardless of scroll. Preserve the clamp.
- **`commentResult` feedback:** use `showToast(msg, type)` (project.js line 82) for success/failure feedback instead of appending transient spans (the `planning.js` approach), for consistency with the rest of `project.js`.

### Dependencies & Conflicts
- **Empty/collapsed selection:** the `mouseup` handler must no-op (and hide any stale popup) when `getSelection().toString().trim()` is empty — as `planning.js` 7081–7089 do.
- **No selected doc:** if a tab has no currently-selected doc (kanban with no plan, constitution with no file, projects with no project), `getReviewContext(tab)` returns `null` and Send-to-Planner shows an error toast (`showToast('No document loaded to review.', 'error')`). Disabling the Review button in this state is a nice-to-have (see User Review Required), not a blocker.
- **Tuning tab exclusion:** the Review Mode button must not be injected into `#tuning-content` (which also has a `.controls-strip`, line 1328). Gate on the explicit allowlist `['kanban','features','projects','constitution','system']`.
- **Projects-tab context caveat (corrected):**

  > **Superseded:** "Fallback: pass `getProjectsTabWorkspaceRoot()` as the path and `_selectedProjectName` as `topic`. The backend's `path.relative(workspaceRoot, workspaceRoot)` yields `.`; the planner payload becomes `Plan: .` with the project name in the topic field. This is acceptable…"
  > **Reason:** Two errors, both verified against source. (1) `switchboard.sendReviewComment` (extension.ts 2733–2737) builds the terminal payload from `selectedText`, `comment`, `planContext`, and `sessionContext` — it **never references `request.topic`** (grep confirmed zero uses). So the project name passed as `topic` is silently dropped and never reaches the planner. For Projects, `sessionId` is `''` too, so the planner would receive `Plan: ` with no project identifier at all. (2) `path.relative('/x','/x')` returns `''` (empty string) in Node, not `'.'` — so the Plan line is blank, not `Plan: .`.
  > **Replaced with:** Pass the workspace root as `planFileAbsolute` **and** fold the project name into the outgoing `comment` for the Projects tab (e.g. `[Project: <name>] <comment>`) so the context survives the backend payload builder. The workspace-root path still satisfies the backend boundary check — verified: `isPathWithinRoot(root, root)` returns `true` (`path.relative(root, root) === ''`, which does not start with `..` and is not absolute → `true`), and `findWorkspaceRootForPath(root)` returns `root`. Copy Prompt is unaffected — it builds its own string including `Context: <topic>`.

- **Theme compatibility:** the popup CSS uses `var(--panel-bg)`, `var(--border-color)`, `var(--text-secondary)`, `var(--text-primary)`, `var(--accent-primary)`, `var(--font-mono)` — all present in `project.html` (verified ref counts: panel-bg 38, border-color 45, text-secondary 27, text-primary 31, accent-primary 13, accent-teal 100, font-mono 11). Note `--input-bg` is **not** defined in `project.html` (0 refs), so the textarea's `var(--input-bg, rgba(255,255,255,0.06))` uses its literal fallback — cosmetically fine and identical to `planning.html`'s behavior. Copy the CSS block verbatim from `planning.html` lines 2500–2552 (it uses `color-mix(in srgb, …)`, which the VS Code webview's Chromium already supports and which `planning.html` already relies on).

## Dependencies

- None

## Adversarial Synthesis

**Key risks:** (1) the ported `enterReviewMode` guard `if (!exitEditMode(tab, true)) return;` was copied from `planning.js` where `exitEditMode` returns `true`, but `project.js`'s `exitEditMode(tab)` takes one arg and returns `undefined` — so entering review while editing would bail before setting review mode (a two-click toggle bug); (2) the Projects tab's `topic` is dropped by the backend, so project context must be folded into the `comment` or it never reaches the planner. **Mitigations:** call `exitEditMode(tab)` without a return-value check (project.js discards silently, no confirm); prefix `[Project: <name>]` into the outgoing comment on the Projects tab. Residual risks (button disabled-state gating, blank Plan line for Projects) are cosmetic and non-blocking.

## Proposed Changes

### 1. `src/webview/project.html` — add popup DOM + CSS, and Review Mode buttons

**A. Add the comment-popup CSS** — copy verbatim from `planning.html` lines 2500–2552 (the full block, including the `.popup-actions button` rules). Insert near the other shared popup/modal styles. Add one extra rule for the toggle-button active state:

```css
.review-mode-btn.active {
    border-color: var(--accent-teal, #00f0ff);
    color: var(--accent-teal, #00f0ff);
}
```

(The `.comment-popup`, `.popup-label`, `.selected-preview`, `.comment-popup textarea`, `.popup-actions`, and `.popup-actions button` rules come straight from `planning.html` 2500–2552 — do not hand-retype them.)

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

(Verified: none of these IDs collide with existing IDs in `project.html`.)

**C. Add a Review Mode button to each eligible tab's controls-strip.** For the Kanban tab, insert into the existing **`.kanban-controls-strip`** (after `#btn-chat-copy-prompt`, project.html line 1155):

```html
<button id="btn-review-kanban" class="strip-btn review-mode-btn" title="Toggle review mode: highlight text in the plan to comment">Review</button>
```

Repeat for the other four tabs, placing each inside its respective **`.controls-strip`** (Projects line 1178, Features line 1215, Constitution line 1256, System line 1294) with ids `btn-review-features`, `btn-review-projects`, `btn-review-constitution`, `btn-review-system`. Do **not** add one to `#tuning-content` (its `.controls-strip` is at line 1328).

### 2. `src/webview/project.js` — review-mode state, functions, listeners, and per-tab context resolver

**A. Expand `state.reviewMode`** (line 61) to all eligible tabs, and add the selected-text holder:

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
            // backend's workspace resolution + boundary check succeed. The project name
            // is carried in `topic`, but note the backend DROPS topic (see submit handler).
            const wsRoot = getProjectsTabWorkspaceRoot();
            return _selectedProjectName && wsRoot ? { planFileAbsolute: wsRoot, sessionId: '', topic: _selectedProjectName } : null;
        }
        default:
            return null;
    }
}
```

**C. Add enter/exit/show/hide functions** (port of `planning.js` 7022–7072, generalized to a tab argument):

> **Superseded:** `enterReviewMode` with `if (state.editMode[tab]) { if (!exitEditMode(tab, true)) return; }`
> **Reason:** This guard was copied from `planning.js`, where `exitEditMode(tab, discard)` returns `true` at its end (line ~8017). But in `project.js`, `exitEditMode(tab)` (line 3024) takes a **single** argument and has **no return statement** (returns `undefined`). So `!undefined` is `true`, the `return` fires, and `state.reviewMode[tab] = true` never runs when edit mode was active — clicking Review while editing would exit edit mode but silently fail to enter review mode (a two-click bug). `project.js`'s `exitEditMode` also discards edit state silently (no confirm/abort), so there is no boolean to check.
> **Replaced with:** call `exitEditMode(tab)` unconditionally, with no return-value check:

```js
const REVIEWABLE_TABS = ['kanban', 'features', 'projects', 'constitution', 'system'];

function enterReviewMode(tab) {
    if (!REVIEWABLE_TABS.includes(tab)) return;
    if (state.editMode[tab]) exitEditMode(tab); // project.js exitEditMode: 1 arg, discards silently, returns undefined
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

**D. Wire selection listeners on each tab's preview-content element.** Use a single loop over the eligible tabs to attach `mouseup`/`mousedown` handlers (port of `planning.js` 7076–7106). All five `${tab}-preview-content` elements exist in `project.html` (verified):

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

**E. Wire the popup action buttons** (Cancel, Copy Prompt, Send to Planner). Place near the other top-level listener wiring. Note the Projects-tab comment prefix in the Send handler:

```js
const reviewCancelBtn = document.getElementById('review-cancel-comment');
if (reviewCancelBtn) reviewCancelBtn.addEventListener('click', () => hideReviewPopup(true));

const reviewCopyPromptBtn = document.getElementById('review-copy-prompt');
if (reviewCopyPromptBtn) reviewCopyPromptBtn.addEventListener('click', () => {
    if (!state.reviewSelectedText) { flashSelectedPreviewError(); return; }
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
    if (!state.reviewSelectedText) { flashSelectedPreviewError(); return; }
    if (!comment) { flashCommentInputError(); return; }
    const ctx = getReviewContext(activeTab);
    if (!ctx || !ctx.planFileAbsolute) { showToast('No document loaded to review.', 'error'); return; }
    // The backend payload builder ignores `topic`; for the file-less Projects tab, fold the
    // project name into the comment so the planner actually receives the project context.
    const outgoingComment = (activeTab === 'projects' && ctx.topic)
        ? `[Project: ${ctx.topic}] ${comment}`
        : comment;
    vscode.postMessage({
        type: 'submitComment',
        sessionId: ctx.sessionId,
        topic: ctx.topic,
        planFileAbsolute: ctx.planFileAbsolute,
        selectedText: state.reviewSelectedText,
        comment: outgoingComment
    });
});
```

`flashSelectedPreviewError` / `flashCommentInputError` are small helpers that flash the `#review-selected-preview` / `#review-comment-input` border red for 2s, mirroring `planning.js` 7120–7130. (These helpers do not exist yet in `project.js` — add them.)

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

**G. Guard edit-mode and tab-switch.**
- In `enterEditMode(tab)` (project.js line 2977), add at the top: `if (state.reviewMode[tab]) exitReviewMode(tab, true);` (mirror `planning.js` 7884–7886).
- In the tab-switch click handler (project.js lines 9–53), **before** `activeTab = targetTab` (line 18), exit review mode on the current `activeTab` if it is reviewable:

```js
if (REVIEWABLE_TABS.includes(activeTab) && state.reviewMode[activeTab]) {
    exitReviewMode(activeTab, true);
}
```

**H. Handle the `commentResult` message** in the webview message switch (port of `planning.js` 5031, adapted to use `showToast`; not currently present in project.js — verified):

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

`PlanningPanelProvider.ts` already handles `case 'submitComment'` (line 2910) and `switchboard.sendReviewComment` (`extension.ts` line 2655) already resolves the target terminal and sends the payload. The Projects-tab workspace-root path is accepted by the backend because `isPathWithinRoot(root, root)` is `true` and `findWorkspaceRootForPath(root)` returns `root` (both verified against source). The one backend limitation — `topic` is not forwarded into the terminal payload — is worked around entirely in the frontend (Change 2E, Projects comment prefix); **the backend is not modified.**

### 4. Test — `src/test/project-panel-review-mode.test.js` (new file, follow existing convention)

Mirror `project-panel-kanban-create-button.test.js`: read `project.html` and `project.js` as text and assert structural presence.

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

> Per session directives, compilation and automated-test **execution** are out of scope for this planning pass. The automated test below is authored as a deliverable; the implementer/user runs it (and the build) at implementation time.

### Automated Tests
- **New:** `src/test/project-panel-review-mode.test.js` (Change 4) — structural assertions on `project.html`/`project.js` (popup DOM, five review buttons, tuning button absent, `REVIEWABLE_TABS`, `enterReviewMode`, `getReviewContext`, `submitComment`, `commentResult`).
- **Regression guard:** existing `src/test/project-panel-kanban-create-button.test.js` should still pass unchanged.

### Manual Verification
1. **Kanban tab:** open the Project panel, select a plan, click **Review** in the kanban controls strip, highlight text in the rendered plan preview → popup appears with the selected text; type a comment, click **Send to Planner** → a planner terminal receives the `> [text] — Comment: "…"` payload and a success toast shows. Click **Copy Prompt** → clipboard contains the prompt. Click **Exit Review** → popup no longer appears on selection.
2. **Features / Constitution / System tabs:** repeat step 1 on each; confirm Send to Planner resolves the correct file path (constitution/system use absolute paths; features use the plan file).
3. **Projects tab:** select a project, toggle Review, highlight PRD text, Send to Planner → confirm the planner terminal receives the comment **prefixed with `[Project: <name>]`** (no crash from the missing file path; the Plan line will be blank, which is expected).
4. **Tuning tab:** confirm no Review button is present and text selection does nothing.
5. **Edit-mode guard:** with Review on, click Edit on the same tab → review mode exits and edit mode activates without a stale popup. With Edit on, click Review → edit mode exits **and** review mode turns on in a single click (regression guard for the superseded `exitEditMode` bug).
6. **Tab-switch guard:** enable Review on Kanban, switch to Features → kanban review mode exits and no popup lingers.
7. **Empty selection:** click Review on, then click (without dragging) in the preview → no popup appears; if a popup was open, it hides.

## Recommendation

**Send to Coder** (Complexity 6 — mixed frontend work with real cross-tab state coordination and a backend-limitation workaround). Two corrections in this plan are load-bearing and must be honored: (1) call `exitEditMode(tab)` without a return-value check; (2) prefix `[Project: <name>]` into the Projects-tab outgoing comment.

## Completion Summary

Implemented the generalized Review Mode modal across all five eligible `project.html` tabs (Kanban, Features, Projects, Constitution, System); Tuning excluded per spec. **Files changed:** `src/webview/project.html` (added comment-popup CSS verbatim from `planning.html` 2500–2563 plus `.review-mode-btn.active` rule, the shared `#review-comment-popup` DOM with Cancel/Copy Prompt/Send to Planner actions, and one `btn-review-*` button in each eligible tab's static controls-strip), `src/webview/project.js` (expanded `state.reviewMode` to five tabs + `reviewSelectedText`, added `REVIEWABLE_TABS` allowlist, `getReviewContext(tab)` per-tab resolver, `enterReviewMode`/`exitReviewMode`/`showReviewPopup`/`hideReviewPopup`/`flashSelectedPreviewError`/`flashCommentInputError`, per-tab `mouseup`/`mousedown` selection listeners, popup action wiring with the Projects-tab `[Project: <name>]` comment prefix workaround, toggle-button wiring, edit-mode guard in `enterEditMode`, tab-switch guard before `activeTab` reassignment, and a `commentResult` message case using `showToast`), and new `src/test/project-panel-review-mode.test.js` (structural assertions on HTML/JS/provider). **No backend changes** — reused the existing `submitComment` → `sendReviewComment` path; the load-bearing `exitEditMode(tab)` no-return-check fix and the Projects comment-prefix workaround were both honored. Both the new test and the existing `project-panel-kanban-create-button.test.js` pass; `node -c` confirms project.js syntax. No issues encountered.

**Re-verification (2026-07-16):** re-dispatched card. Confirmed implementation is present in committed code (commit d91202b): `project.js` has `REVIEWABLE_TABS`, `getReviewContext`, `enterReviewMode`/`exitReviewMode`/`showReviewPopup`/`hideReviewPopup`, per-tab `mouseup`/`mousedown` listeners, popup action wiring with `[Project: <name>]` prefix, toggle wiring, `enterEditMode` guard at line 3002, tab-switch guard at line 18, and `commentResult` case at line 1155. `project.html` has all five `btn-review-*` buttons (kanban/projects/features/constitution/system), no tuning button, the `#review-comment-popup` DOM, and `.review-mode-btn.active` CSS. Test file `src/test/project-panel-review-mode.test.js` present. No code changes needed this pass — task already complete.

