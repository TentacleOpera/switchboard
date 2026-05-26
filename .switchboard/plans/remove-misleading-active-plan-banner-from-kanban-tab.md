# Remove Misleading Active Plan Banner from Kanban Tab

## Goal

Remove the "Active Plan" banner from the kanban plans tab, as it is misleading (shows a design doc URL, not a kanban plan) and has no functional purpose on that tab.

## Metadata
- **Created:** 2026-05-26
- **Priority:** Medium
- **Complexity:** 2
- **Type:** UI Cleanup
- **Status:** Created
- **Tags:** [UI, UX, bugfix]

## User Review Required

- Confirm that no users rely on the kanban banner as a visual indicator of the active design doc while reviewing kanban cards.

## Description

The "Active Plan" banner on the kanban plans tab is redundant, misleading, and serves no functional purpose. This banner shows the currently active design document (set via VS Code config `planner.designDocLink`), but on the kanban tab it has no utility because:

1. **No functional purpose on kanban tab** - The active design doc feature is for setting a planning context when working with local/online docs. Users cannot set an active plan from the kanban tab itself.

2. **Wrong context** - The kanban tab is for viewing/managing kanban cards and their workflow status (Created → Coded → Reviewed → Completed), not for selecting a design document as planning context.

3. **Misleading label** - The banner says "Active Plan" but it actually shows "Active Design Doc" (a design document URL set in VS Code config), not a kanban plan. This creates confusion about what "active" means in this context.

4. **Inconsistent UX** - The "Set as Active Planning Context" button only exists on the LOCAL DOCS and ONLINE DOCS tabs, not on the kanban tab. The banner appears on all tabs but is only functional on two of them.

The banner makes sense on the LOCAL DOCS and ONLINE DOCS tabs where users can actually set an active design doc, but on the kanban tab it serves no purpose and adds clutter.

## Complexity Audit

### Routine
- Remove HTML elements (banner div + comment) from a single section of planning.html
- Remove 3 `getElementById` references from planning.js
- Remove 1 conditional block (4 lines) from `updateActiveDocBanner` function
- Remove 1 click event listener binding (3 lines)
- No CSS changes needed (`.active-doc-banner` styles at lines 241-300 are shared across local/online/kanban banners)
- No TypeScript/extension-side changes needed (no TS files reference `active-doc-banner`; the `activeDesignDocUpdated` message is broadcast uniformly)

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The banner is a static UI element with no async state.
- **Security:** None. Pure UI removal.
- **Side Effects:** The `handleDisableDesignDoc` function (line 1849) sends a generic `disableDesignDoc` message and is called by local, online, and kanban buttons. After removing the kanban button listener, the function remains unchanged and is still used by the local and online buttons. No side effects.
- **Dependencies & Conflicts:** The CSS styles for `.active-doc-banner` (lines 241-300 in planning.html) are shared across all three tab banners. They must NOT be removed. No other files depend on the kanban banner elements.

## Dependencies

None.

## Adversarial Synthesis

Key risks: orphan HTML comment left behind after banner removal; someone might later wonder if CSS cleanup is needed. Mitigations: explicitly include the comment line in the removal range; document that CSS is shared and must be preserved. Overall risk is negligible — this is a pure UI removal in two files with no functional or data impact.

## Proposed Changes

### `src/webview/planning.html`

- **Context:** The kanban content section starts at line 1597. The active doc banner (lines 1598-1605) sits between the section opening and the controls strip (line 1606).
- **Logic:** Remove the HTML comment and the entire banner div. The local (line 1374) and online (line 1418) banners remain untouched.
- **Implementation:**
  - **Remove lines 1598-1605** (the `<!-- Active context banner -->` comment + the `<div class="active-doc-banner inactive" id="active-doc-banner-kanban">...</div>` block)
  - **Do NOT modify** the CSS styles at lines 241-300 — they are shared across all three tab banners
- **Edge Cases:** None. The kanban-content div continues directly to the controls strip after removal.

### `src/webview/planning.js`

- **Context:** The `updateActiveDocBanner` function (lines 1824-1847) and the click event listener bindings (lines 1853-1861) handle all three tab banners.
- **Logic:** Remove kanban-specific element references and the conditional block that updates the kanban banner. The function still updates local and online banners.
- **Implementation:**
  - **Line 1822:** Remove `const btnDisableDocKanban = document.getElementById('btn-disable-doc-kanban');`
  - **Line 1827:** Remove `const bannerKanban = document.getElementById('active-doc-banner-kanban');`
  - **Line 1830:** Remove `const nameKanban = document.getElementById('active-doc-name-kanban');`
  - **Lines 1843-1846:** Remove the `if (bannerKanban) { ... }` block
  - **Lines 1859-1861:** Remove the `if (btnDisableDocKanban) { ... }` block
  - **Do NOT modify** `handleDisableDesignDoc` (line 1849) — it remains used by local and online buttons
- **Edge Cases:** After removal, `updateActiveDocBanner` still correctly handles `activeDesignDocUpdated` messages for local and online tabs. The `handleDisableDesignDoc` function is unaffected.

## Verification Plan

### Automated Tests
- No automated tests required (pure UI removal, no logic changes).

### Manual Verification
1. Open the kanban plans tab in the webview — verify the "Active Plan" banner is no longer visible
2. Open the LOCAL DOCS tab — verify the "Active Design Doc" banner still appears and functions correctly
3. Open the ONLINE DOCS tab — verify the "Active Design Doc" banner still appears and functions correctly
4. Set a design doc as active planning context from LOCAL DOCS or ONLINE DOCS — verify the banner updates on both tabs
5. Click "Turn off" on LOCAL DOCS or ONLINE DOCS — verify the banner correctly deactivates
6. Switch between tabs after setting an active doc — verify no errors in the developer console

## Impact Assessment

- **Breaking changes:** None - this removes unused UI elements on a single tab
- **User impact:** Positive - reduces UI clutter and eliminates confusion about what "active" means on the kanban tab
- **Code complexity:** Reduced - removes ~10 lines of unnecessary code
- **Performance:** Negligible - minor reduction in DOM operations

## Risks

- **Low risk:** The active doc banner has no functional purpose on the kanban tab
- **Mitigation:** The banner remains fully functional on LOCAL DOCS and ONLINE DOCS tabs where it's actually useful

## Notes

- The underlying `planner.designDocLink` configuration and active design doc feature remain intact
- Only the UI display on the kanban tab is being removed
- The feature continues to work as intended on LOCAL DOCS and ONLINE DOCS tabs
- This change improves UX by removing misleading UI elements that don't match the tab's purpose
- CSS styles for `.active-doc-banner` are shared and must NOT be removed

**Recommendation:** Send to Intern (Complexity 2)
