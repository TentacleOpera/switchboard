# Trim Local Docs Sidebar Card Actions & Remove Duplicate Top-Strip Buttons

## Goal
Reduce visual clutter in the **Local Docs tab** sidebar by: (1) removing the duplicate top-of-view buttons whose functions already exist on every card, (2) removing the redundant "Copy Path" action ("Link Doc" already copies a validated path to clipboard), and (3) compacting the remaining card actions into icon buttons.

Scope is **Local Docs tab only**. Other tabs (Online Docs, Design System, HTML Previews) are not modified.

**Root cause analysis:** The sidebar card actions were originally designed as text buttons for clarity, but the narrow sidebar width (flex: 1 in a split-pane layout) causes 4 text buttons to overflow/wrap. The top-strip buttons were added as shortcuts before card actions existed, creating functional duplication. `Copy Path` was a convenience shortcut that predates the validated `Link Doc` backend path — both copy a file path, but `Link Doc` is strictly superior.

## Metadata
- **Tags:** ui, ux, refactor
- **Complexity:** 3

## User Review Required
- None. Mixed text+icon styles approved. Scope is Local Docs tab only.

## Complexity Audit

### Routine
- Removing 2 HTML button elements from `#controls-strip-local` (pure deletion)
- Removing `'Copy Path'` from `local-folder` action array and Antigravity artifact actions (string removal)
- Removing the `else if (action === 'Copy Path')` handler block (4 lines)
- Removing event listener blocks for 2 deleted Local Docs top-strip buttons (guarded by `if` checks, safe to remove)
- Removing enable/disable lines referencing deleted Local Docs button IDs (all guarded by null checks)
- Adding `.card-icon-btn` CSS class (follows existing `.doc-delete-btn` pattern exactly)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All UI changes are synchronous DOM manipulations. No async state races introduced.
- **Security:** Removing `Copy Path` eliminates an unvalidated clipboard write path (`navigator.clipboard.writeText` with raw metadata). `Link Doc` routes through backend validation — strictly safer.
- **Side Effects:**
  - Removing top-strip buttons may leave `#controls-strip-local` looking sparse (only workspace filter, hidden Import, Edit, Save, Cancel, status remain). Verify layout still looks balanced.
  - `activeContextSet` message handler (line 2831) does `const btnSAL = document.getElementById('btn-set-active-context-local'); if (btnSAL) btnSAL.disabled = false;` — after HTML removal, `getElementById` returns null, guarded by `if`. Safe but should be cleaned up.
  - `selectDoc` function (line 884) does `if (btnAppendToPrompts) btnAppendToPrompts.disabled = false;` — `btnAppendToPrompts` is cached at line 367 from `btn-set-active-context-local`. After HTML removal, this reference is null, guarded by `if`. Safe but should be cleaned up.
- **Dependencies & Conflicts:** No other plans or sessions depend on these button IDs. The `PlanningPanelProvider.ts` backend is not modified — it still handles `appendToPlannerPrompt` and `linkToDocument` messages from card actions.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Removing `Copy Path` from `renderDocCard` also removes it from `design-folder` and `html-folder` branches — those tabs lose Copy Path even though only Local Docs is in scope. Mitigation: `Copy Path` is redundant with `Link Doc` everywhere; removing it globally is correct. (2) Two button removals in Local Docs controls-strip require JS cleanup of cached references — missing one leaves dead code but no runtime errors (all null-guarded).

## Proposed Changes

### `src/webview/planning.html`

**Context:** Contains the HTML structure for all 7 tab content areas and all CSS styles. Only `#controls-strip-local` is modified. CSS already has `.doc-delete-btn` (hover-reveal icon pattern) and `.planning-card-btn` (text button style) that serve as templates.

**Logic:**
1. Remove 2 `<button>` elements from `#controls-strip-local`
2. Add `.card-icon-btn` CSS class following `.doc-delete-btn` pattern
3. Add `.card-icon-btn.card-delete-btn:hover` style matching `.doc-delete-btn:hover` red highlight

**Implementation:**

*HTML deletions (lines ~2300-2301):*
- `#controls-strip-local`: Remove `<button id="btn-set-active-context-local" ...>` and `<button id="btn-link-to-doc-local" ...>`

*CSS addition (after `.planning-card-btn:disabled` block, ~line 1616):*
```css
.card-icon-btn {
    flex-shrink: 0;
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid var(--border-color);
    border-radius: 3px;
    color: var(--text-secondary);
    font-size: 12px;
    line-height: 1;
    cursor: pointer;
    opacity: 0;
    transition: all 0.15s;
}
.tree-node:hover .card-icon-btn {
    opacity: 1;
}
.card-icon-btn:hover {
    color: var(--accent-teal);
    border-color: var(--accent-teal-dim);
    background: color-mix(in srgb, var(--accent-teal) 8%, transparent);
}
.card-icon-btn.card-delete-btn:hover {
    background: #f14c4c;
    border-color: #f14c4c;
    color: white;
}
.card-icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
}
```

**Edge Cases:**
- Collapsed sidebar: `.content-row.collapsed .card-actions { display: none !important; }` already hides the entire container — icon opacity pattern is irrelevant when container is hidden. No conflict.
- Theme compatibility: All colors use CSS variables (`var(--border-color)`, `var(--accent-teal)`, etc.) — compatible with cyber, terracotta, and darker-black themes.

### `src/webview/planning.js`

**Context:** Contains all webview logic including `renderDocCard` (line 564), action array definitions (line 724), event listener setup for Local Docs top-strip buttons (lines 3127-3158), and message handlers that reference deleted button IDs (lines 884, 1929-1963, 2831-2832).

**Logic:**
1. Remove `'Copy Path'` from `local-folder` and Antigravity action arrays (also remove from `design-folder`/`html-folder` since Copy Path is globally redundant)
2. Remove `Copy Path` handler from `renderDocCard` action loop
3. Refactor `renderDocCard` to render icon buttons for `Link Doc` and `Delete`, text buttons for `Set Context`/`Import`/`Sync`
4. Remove event listener blocks for 2 deleted Local Docs top-strip buttons
5. Clean up cached references and enable/disable lines for deleted Local Docs buttons

**Implementation:**

*Step 1 — Remove Copy Path from action arrays (line 724-733):*
```js
// Before:
if (sourceId === 'local-folder') {
    actions = ['Set Context', 'Link Doc', 'Copy Path', 'Delete'];
} else if (sourceId === 'design-folder') {
    actions = ['Set Context', 'Link Doc', 'Copy Path'];
} else if (sourceId === 'html-folder') {
    actions = ['Copy Path'];
} else {
    actions = ['Import', 'Link Doc'];
}

// After:
if (sourceId === 'local-folder') {
    actions = ['Set Context', 'Link Doc', 'Delete'];
} else if (sourceId === 'design-folder') {
    actions = ['Set Context', 'Link Doc'];
} else if (sourceId === 'html-folder') {
    actions = ['Link Doc'];
} else {
    actions = ['Import', 'Link Doc'];
}
```
Note: Copy Path is removed from all branches (not just `local-folder`) because it's globally redundant with `Link Doc`. The `html-folder` branch changes from `['Copy Path']` to `['Link Doc']` — this sends `linkToDocument` through backend validation instead of raw clipboard write.

*Step 1b — Remove Copy Path from Antigravity artifact actions (line 1621):*
```js
// Before:
actions: ['Set Context', 'Link Doc', 'Copy Path'],
// After:
actions: ['Set Context', 'Link Doc'],
```

*Step 2 — Remove Copy Path handler from renderDocCard (lines 631-634):*
Delete the `else if (action === 'Copy Path') { ... }` block entirely.

*Step 3 — Refactor renderDocCard action loop (lines 608-653):*
Replace the uniform `planning-card-btn` rendering with conditional icon/text rendering:
```js
actions.forEach(action => {
    const btn = document.createElement('button');

    if (action === 'Link Doc' || action === 'Delete') {
        // Icon button
        btn.className = 'card-icon-btn' + (action === 'Delete' ? ' card-delete-btn' : '');
        btn.textContent = action === 'Link Doc' ? '🔗' : '×';
        btn.title = action === 'Link Doc' ? 'Copy validated document path' : 'Delete';
        btn.setAttribute('aria-label', action === 'Link Doc' ? 'Link to document' : 'Delete document');
    } else {
        // Text button (Set Context, Import, Sync)
        btn.className = 'planning-card-btn';
        btn.textContent = action;
    }

    btn.addEventListener('click', (e) => {
        e.stopPropagation();
        // ... existing handler logic unchanged ...
    });

    cardActions.appendChild(btn);
});
```

*Step 4 — Remove Local Docs top-strip button event listeners:*
- Lines 3127-3143: Remove `btnSetActiveLocal.addEventListener('click', ...)` block
- Lines 3145-3158: Remove `btnLinkToLocal.addEventListener('click', ...)` block

*Step 5 — Clean up cached references and enable/disable lines for Local Docs buttons:*
- Line 367: Remove `const btnAppendToPrompts = document.getElementById('btn-set-active-context-local');`
- Line 884: Remove `if (btnAppendToPrompts) btnAppendToPrompts.disabled = false;`
- Lines 1929-1963: Remove `btnSetActiveLocal` / `btnLinkToLocal` enable/disable logic in the preview load handler
- Lines 2831-2832: Remove `const btnSAL = document.getElementById('btn-set-active-context-local'); if (btnSAL) btnSAL.disabled = false;` in `activeContextSet` handler

**Edge Cases:**
- All `getElementById` calls for removed buttons are null-guarded — removing the HTML elements won't cause runtime errors, but dead reference code should be cleaned up.
- The `selectDoc` function references `btnAppendToPrompts` — after removing the cached reference, this line becomes dead code and should be removed.
- Online Docs and Design System tabs are not modified. Their top-strip buttons and event listeners remain intact.

## Verification Plan

### Automated Tests
- No automated test coverage exists for webview UI. Verification is manual.

### Manual Verification Checklist
- [ ] Local Docs sidebar cards show only `Set Context` (text), `Link Doc` (icon 🔗), `Delete` (icon ×)
- [ ] Antigravity artifact cards show `Set Context` (text), `Link Doc` (icon 🔗)
- [ ] Local Docs `#controls-strip-local` no longer shows "Set as Active Planning Context" or "Link to Document" buttons
- [ ] Online Docs and Design System tabs are unchanged (top-strip buttons still present)
- [ ] All existing click handlers still fire correctly (`appendToPlannerPrompt`, `linkToDocument`, `deleteLocalDoc`, `importFullDoc`, `syncDoc`)
- [ ] Icon buttons appear on hover (opacity 0→1 transition) when sidebar is expanded
- [ ] Sidebar collapse toggle still hides card actions cleanly (`.content-row.collapsed .card-actions { display: none }`)
- [ ] No console errors from removed `getElementById` calls
- [ ] Controls-strip layout looks balanced after button removal (not oddly sparse)
- [ ] `.card-icon-btn` styles work across all 3 themes (default cyber, terracotta, darker-black)

## Recommendation
**Complexity: 3 → Send to Intern**
