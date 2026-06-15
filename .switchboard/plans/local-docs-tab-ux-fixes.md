# Local Docs Tab UX Fixes

## Goal
Fix specific UX issues in the Local Docs tab to improve clarity and consistency.

## Problem Analysis
The Local Docs tab has several UX issues that confuse users and create inconsistent behavior:
1. Import button appears on local-folder doc cards when it shouldn't - local docs are already in the filesystem
2. "Sync to Online" and "Export to Source" buttons are confusing - they do the same thing (push to external) but with different UX flows
3. Folder names in sidebar are ambiguous when multiple "docs" folders exist - no indication of which folder is which
4. Status message constantly shows "loading..." in top right, providing no helpful information
5. Buttons at folder subheader levels are not right-justified (link, + should be next to import)
6. Subfolder header buttons are teal instead of grey, inconsistent with subfolder header styling
7. No import button exists for subfolders, only for top-level source folders

## Implementation Plan

### 1. Remove Import Button from Local Doc Cards
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`
- **Change**: Line 926 - change actions from `['Import', 'Link Doc', 'Delete']` to `['Link Doc', 'Delete']` for `sourceId === 'local-folder'`
- **Rationale**: Local docs are already in the filesystem, import makes no sense

### 2. Consolidate Sync Buttons
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
- **Change**: Remove "Export to Source" button from controls-strip-local (line 2922)
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`
- **Change**: Update "Sync to Online" button logic to:
  - If sync location is known (doc was imported from external system), sync directly without modal
  - If sync location is unknown (purely local doc), open the sync modal to select destination
- **Rationale**: One button with context-aware behavior is clearer than two buttons doing the same thing

### 3. Display Relative Path for Folder Names
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`
- **Change**: In the renderTree function, when rendering source-folder headers, add a small text element below the folder name showing the relative path
- **Location**: Around line 1277-1302 where source headers are created
- **Rationale**: When multiple "docs" folders exist, users need to know which is which

### 4. Remove Loading Status Message
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
- **Change**: Remove or hide the status span at line 2928 (`<span id="status" style="margin-left: 0;"></span>`)
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`
- **Change**: Remove any code that sets this status span to "loading..." or other static messages
- **Rationale**: Constant "loading..." message provides no actionable information

### 5. Right-Justify Folder Subheader Buttons
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`
- **Change**: Update the CSS or flex layout for folder subheader buttons to ensure link, +, and import buttons are right-justified
- **Location**: Around line 1277-1302 where source headers are created
- **Rationale**: Consistent button alignment improves visual hierarchy

### 6. Change Subfolder Header Buttons to Grey
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
- **Change**: Update CSS for subfolder header buttons to use grey color instead of teal
- **Target**: CSS classes for folder-subheader buttons (need to identify specific class)
- **Rationale**: Subfolder headers are grey, so their buttons should match

### 7. Add Import Button to Subfolders
- **File**: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`
- **Change**: Add import button to subfolder headers, similar to how import button exists for top-level source folders
- **Location**: In the folder hierarchy rendering logic (around line 1305-1388)
- **Rationale**: Users should be able to import to specific subfolders, not just top-level folders

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`

## Validation
- **Manual testing**: Open Local Docs tab and verify all 7 fixes are working
- **Button behavior**: Test sync button with both imported docs (should sync directly) and local-only docs (should open modal)
- **Visual inspection**: Verify folder paths are displayed, buttons are right-justified and correctly colored
- **Regression testing**: Ensure existing functionality (link, delete, edit, save) still works

## Risks
- **Sync logic complexity**: Consolidating sync buttons requires careful handling of the context-aware logic
- **CSS specificity**: Changing button colors may affect other elements if not scoped correctly
- **Folder path display**: Adding relative paths may clutter the UI if not styled carefully

## Metadata
**Complexity:** 3
**Tags:** ui, ux, local-docs, frontend
