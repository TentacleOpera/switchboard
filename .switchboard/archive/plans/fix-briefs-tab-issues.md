# Fix Briefs Tab Issues in Design Panel

## Metadata
**Complexity:** 3
**Tags:** ui, bugfix, frontend

## Goal
Fix three bugs in the design.html briefs tab:
1. Briefs tab appears first in the tab bar instead of after stitch
2. 'New brief' button does nothing when clicked
3. When adding a briefs folder via manage folders modal, closing the modal unexpectedly switches to the stitch tab

## Background & Root Cause Analysis

### Issue 1: Tab Order
**Root Cause:** In `src/webview/design.html` line 3491, the briefs tab button is rendered before the stitch tab button in the DOM. The tab order should be: STITCH, BRIEFS, HTML PREVIEWS, IMAGES, DESIGN SYSTEM.

**Current HTML structure (lines 3490-3496):**
```html
<div id="research-tab-bar" class="research-tab-bar">
    <button class="research-tab-btn" data-tab="briefs">BRIEFS</button>
    <button class="research-tab-btn active" data-tab="stitch">STITCH</button>
    <button class="research-tab-btn" data-tab="html-preview">HTML PREVIEWS</button>
    <button class="research-tab-btn" data-tab="images">IMAGES</button>
    <button class="research-tab-btn" data-tab="design">DESIGN SYSTEM</button>
</div>
```

### Issue 2: New Brief Button
**Root Cause:** VS Code webviews do not support native browser dialogs like `prompt()`, `alert()`, or `confirm()`. The new brief button uses `prompt('Enter a title for the new design brief:')` (design.js line 1348), which is silently swallowed by the webview environment.

**The problematic code:**
```javascript
if (btnNew) {
    btnNew.addEventListener('click', () => {
        const title = prompt('Enter a title for the new design brief:');
        if (!title) return;
        // ... rest of creation logic
    });
}
```

**Fix:** Remove the `prompt()` entirely and create the brief with a default title (e.g. `untitled-brief`). The file content is created as `# untitled-brief\n\n` (DesignPanelProvider.ts line 1526), so the user can immediately click **Edit** and change the H1 header to rename the brief. This avoids all inline-input complexity.

**Rationale:** The backend already writes the title as the markdown H1. The existing Edit button and markdown editor let the user change that H1 at any time. Asking for a title at creation is unnecessary friction in a webview that cannot display native dialogs.

### Issue 3: Unwanted Tab Switch on Modal Close
**Root Cause:** When the manage folders modal is closed after adding a briefs folder, the backend sends a `briefsFoldersListed` message (DesignPanelProvider.ts line 1483). The frontend handler (design.js lines 2474-2483) incorrectly calls `updateDestinationDropdowns()` in addition to `updateBriefDocControls()`.

The `updateDestinationDropdowns()` function (design.js lines 3005-3042) populates the stitch tab's destination dropdown with paths from design, html, images, and stitch folders. However, briefs folders are NOT used in the stitch destination dropdown (see line 3032 - it only adds `state.designFolderPathsByRoot`, not `state.briefsFolderPathsByRoot`).

The bug is that `briefsFoldersListed` calls `updateDestinationDropdowns()` unnecessarily. Other folder handlers (design, html, images, stitch) correctly call this function because their folders ARE used in the stitch destination. Briefs folders are not, so calling this function is incorrect and causes the unwanted tab switch behavior.

## User Review Required
- Confirm default brief title (`untitled-brief`) is acceptable, or if another default (e.g. `new-brief`, `brief-${Date.now()}`) is preferred.
- Confirm whether modal overlay click-through is a contributing factor for Issue 3, or if removing `updateDestinationDropdowns()` alone fully resolves the symptom.

## Complexity Audit

### Routine
- Reordering tab buttons in HTML (single DOM reorder).
- Removing one spurious function call from a message handler.
- Replacing `prompt()` with a hardcoded default title in the button handler.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** `briefsFoldersListed` may arrive while the manage-folders modal is still open. `renderFolderListModal()` updates the list in place; no race.
- **Security:** No security implications; all file operations are mediated by the VS Code extension host.
- **Side Effects:** `updateDestinationDropdowns()` modifies the stitch tab's `<select>` DOM. Removing the call from `briefsFoldersListed` is safe because briefs folders are not referenced inside that function. Other folder-type handlers (design, html, images, stitch) still correctly call it.
- **Dependencies & Conflicts:** No known plan dependencies. No conflicts with active plans.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) Default title may collide with existing files if the user creates multiple briefs in quick succession — backend already handles this with a numeric counter (`untitled-1.md`, `untitled-2.md`, etc.); (2) Native `alert()` calls for missing folders remain unaddressed and are also swallowed by VS Code webviews; (3) The root cause mechanism linking `updateDestinationDropdowns()` to the tab switch is under-specified. Mitigations: Accept backend deduplication; replace or audit remaining `alert()` calls; validate the fix during manual testing.

## Proposed Changes

### `src/webview/design.html`
**Context:** Tab button order places BRIEFS before STITCH, contradicting the intended UX order.
**Logic:** Reorder the buttons so STITCH is first and retains the `active` class.
**Implementation:** Swap the first two `<button>` elements inside `#research-tab-bar` (lines 3490-3496) so STITCH precedes BRIEFS.
**Edge Cases:** None; this is a pure DOM-order change with no JS dependencies on sibling order.

### `src/webview/design.js` (New Brief Button Handler)
**Context:** Lines 1346-1359 use `prompt()`, which is silently swallowed by VS Code webviews, preventing brief creation entirely.
**Logic:** Remove the `prompt()` call. Always create the brief with a default title (e.g. `untitled-brief`). The backend writes this title as the markdown H1 (`# untitled-brief\n\n`), and the user can rename via the existing Edit button and markdown editor.
**Implementation:**
1. In the `btnNew` click handler (line 1347), replace the `prompt()` line with `const title = 'untitled-brief';`.
2. Remove the `if (!title) return;` early-return (line 1349) since the title is now always present.
3. Keep the existing folder validation (`alert()` calls at lines 1352, 1357) as-is for now; they are a separate pre-existing issue. Alternatively, replace them with `status-briefs` text feedback.
**Edge Cases:**
- Backend deduplication: if `untitled-brief.md` already exists, DesignPanelProvider.ts lines 1520-1524 append a counter (`untitled-1.md`, etc.).
- Multiple rapid clicks: each click posts a `createBrief` message; backend handles each independently.

### `src/webview/design.js` (Briefs Folders Listed Handler)
**Context:** The `briefsFoldersListed` handler (lines 2474-2483) calls `updateDestinationDropdowns()` unnecessarily.
**Logic:** Briefs folders are not consumed by `updateDestinationDropdowns()` (the function only reads `design`, `html`, `images`, and `stitch` folder paths). Other folder-type handlers correctly call it because their folders populate the stitch destination dropdown.
**Implementation:** Remove line 2481 (`updateDestinationDropdowns();`) from the `briefsFoldersListed` case. Keep `updateBriefDocControls();`.
**Edge Cases:** None; this is a removal of dead code.

## Verification Plan

### Automated Tests
- None applicable; these are webview UI interactions requiring manual verification in the VS Code extension host.

### Manual Testing Checklist
- [ ] Briefs tab appears after stitch tab in the tab bar
- [ ] Stitch tab remains as the default active tab on page load
- [ ] Clicking 'New brief' creates a brief with default title without any dialog
- [ ] After creating a brief, it appears in the briefs sidebar
- [ ] Clicking Edit on the new brief opens the markdown editor with `# untitled-brief` as the H1
- [ ] Opening manage folders modal from briefs tab works correctly
- [ ] Adding a briefs folder and closing the modal keeps the user on the briefs tab
- [ ] Briefs list refreshes after folder addition
- [ ] No visual artifacts or unexpected tab switches occur

## Recommendation
Send to Intern

## Review Findings

All three planned changes verified in code. Additionally fixed 4 swallowed `alert()` calls (2 in `btnNew` handler for missing-folder validation, 2 in `briefCreated`/`briefDeleted` failure handlers) by replacing them with visible `status-briefs` text feedback in `#ff6b6b`, since VS Code webviews silently discard native dialogs.

**Files changed:** `src/webview/design.js` (lines 1350-1367, 2501-2507, 2530-2536)

**Validation:** Manual syntax review passed; no compilation or test execution per session policy.

**Remaining risks:** Default title `untitled-brief` does not update when backend deduplicates filename to `untitled-1.md`, so the markdown H1 may mismatch the actual filename. Minor UX inconsistency; user can rename via Edit.
