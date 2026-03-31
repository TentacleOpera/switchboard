# Remove Confusing Archive Tooltips in Reviewed Column

The tooltips for "Complete selected plans" and "Complete all plans" in the Reviewed column currently have "(archive)" appended to them. This is confusing because those actions only move plans to the "Completed" column (local storage), while the "Archive" button in the Completed column sends them to the external DuckDB archive.

## Proposed Changes

### Kanban Webview

#### [MODIFY] [kanban.html](file:///Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html)
- Clean up the tooltips for the completion buttons in the `isLastWorkingColumn` logic (Reviewed column).

```html
<!-- Line 1346 -->
- <button class="column-icon-btn" data-action="completeSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Complete selected plans (archive)">
+ <button class="column-icon-btn" data-action="completeSelected" data-column="${escapeAttr(def.id)}" data-tooltip="Complete selected plans">

<!-- Line 1349 -->
- <button class="column-icon-btn" data-action="completeAll" data-column="${escapeAttr(def.id)}" data-tooltip="Complete all plans in this column (archive)">
+ <button class="column-icon-btn" data-action="completeAll" data-column="${escapeAttr(def.id)}" data-tooltip="Complete all plans in this column">
```

## Verification Plan

### Manual Verification
1. Open the Kanban board.
2. Locate the **Reviewed** column.
3. Hover over the "Complete Selected" button (check-mark icon).
4. Verify the tooltip correctly reads **"Complete selected plans"** (without the archive suffix).
5. Hover over the "Complete All" button (double check-mark icon).
6. Verify the tooltip correctly reads **"Complete all plans in this column"** (without the archive suffix).

## 🛡️ Verification Phase

### Stage 1: Grumpy Principal Engineer Review
- **[NIT] Missing Code Work:** Wait, I looked at the actual `src/webview/kanban.html` files, and I'm seeing that lines 1346 and 1349 ALREADY do not have the "(archive)" suffix. The developer who wrote this plan actually submitted a diff that was either already merged or never needed to be written. The `data-tooltip="Complete selected plans"` and `data-tooltip="Complete all plans in this column"` are perfectly intact in the source code.
- **[NIT] Accidental Duplication / Drift:** The tooltip strings in the file match exactly what the plan requested. This feels like an over-specified fix for a non-existent problem in the current HEAD, but the intent was good.

### Stage 2: Balanced Synthesis
- **Actionable Fixes:** None required. The codebase already reflects the desired state. 
- **Verification:** I ran `npm run compile` to verify the build isn't broken. The typecheck and build succeeded. The UI strings in `src/webview/kanban.html` have been visually inspected and contain no confusing "(archive)" strings.

**Files Changed:** None required (`src/webview/kanban.html` is already correct).
**Validation Results:** Webpack compilation successful.

**ACCURACY VERIFICATION COMPLETE**
