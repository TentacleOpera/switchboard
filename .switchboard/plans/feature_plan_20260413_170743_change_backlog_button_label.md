# change backlog button label

## Goal
At the top of the New kanban column, change the 'view backlog' button label to 'backlog' to better fit on smaller screens.

## Metadata
**Tags:** frontend, UI
**Complexity:** 2

## User Review Required
> [!NOTE]
> After build, verify the button displays correctly at viewport widths of 320px and above. The button text should now read "BACKLOG" (instead of "VIEW BACKLOG") and "NEW" (instead of "VIEW NEW") in its toggled state.

## Complexity Audit
### Routine
- Verify source file already contains the correct button text (`'BACKLOG'` and `'NEW'`)
- Run build process to regenerate `dist/webview/kanban.html`
- Verify compiled output contains the updated text

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Race Conditions:** N/A — This is a static string change in compiled output
- **Security:** N/A — No security implications for UI label changes
- **Side Effects:** The tooltip remains "Switch to Backlog view" which is semantically consistent with the shorter button label
- **Dependencies & Conflicts:** No conflicts with other active plans. The change is isolated to a single button label in the kanban webview.

**Clarification:** The source file `/src/webview/kanban.html:1740` already has the desired text (`'BACKLOG'`). The `dist/webview/kanban.html:1740` file contains the old text (`'VIEW BACKLOG'`) and must be regenerated via build.

## Adversarial Synthesis
### Grumpy Critique
*Stomps in, coffee in hand*

Oh, wonderful. A single string change. The epitome of software engineering excellence. Let me tell you what's ACTUALLY happening here:

1. **"Better fit on smaller screens"** — Did anyone MEASURE this? Or did someone just eyeball their 4K monitor and declare victory? Where are the breakpoint specs? The viewport width thresholds? The accessibility audit for screen readers that now hear "BACKLOG" instead of "VIEW BACKLOG" with potentially different context?

2. **The dist folder is stale** — The source already says "BACKLOG" but the dist still has "VIEW BACKLOG". So this plan is really about "run the build", not "change the code". But you wouldn't know that from reading it! The plan is treating symptoms, not diagnosing the disease.

3. **Zero regression testing** — What if some E2E test has a selector looking for "VIEW BACKLOG" text? What if the tooltip still says "Switch to Backlog view" while the button now says "BACKLOG" — is that consistent? Inconsistent? Who decided?

4. **No i18n consideration** — Not that this codebase has internationalization, but if it ever does, now we've got a shorter string that might be MORE ambiguous in translation. "VIEW BACKLOG" at least implied an action. "BACKLOG" is a noun. Is the button a label or a command?

5. **Build process is a black box** — The plan mentions NO verification that the build actually updates the dist file correctly. What if webpack is caching? What if there's a watch process that needs restarting?

### Balanced Response
Grumpy has valid points, especially about the stale `dist/` folder. Let me address them in the implementation:

1. **Stale dist issue**: The source file `/src/webview/kanban.html` already contains the fix (`'BACKLOG'`), but `dist/webview/kanban.html` still has `'VIEW BACKLOG'`. The implementation must include a build step to regenerate the distribution files.

2. **Testing for regressions**: We should grep for any test files that might reference the old "VIEW BACKLOG" text. E2E tests with Playwright or similar often use text selectors.

3. **Tooltip consistency**: The tooltip says "Switch to Backlog view" which remains consistent with the new button text "BACKLOG" — this is actually fine, but worth noting.

4. **Verification plan**: After the build, we must verify the dist file contains the new text and manually inspect the UI at smaller viewport widths to confirm the improvement.

This is indeed a simple change (complexity 2), but the plan must be explicit about the build requirement, not just assume "it will work."

## Proposed Changes
> [!IMPORTANT]
> **MAXIMUM DETAIL REQUIRED:** Provide complete, fully functioning code blocks. Break down the logic step-by-step before showing code.

### Kanban Webview — Rebuild Distribution File

#### MODIFY `dist/webview/kanban.html` (via build process)
- **Context:** The source file `/src/webview/kanban.html:1740` already contains the shortened button labels (`'BACKLOG'` and `'NEW'`). The compiled distribution file at `/dist/webview/kanban.html:1740` still contains the old labels (`'VIEW BACKLOG'` and `'VIEW NEW'`). This change requires rebuilding the extension to regenerate the distribution files.

- **Logic:**
  1. The button is conditionally rendered only for the "CREATED" column (isCreated check)
  2. The button text toggles based on `showingBacklog` state
  3. When `showingBacklog` is false (default), display "BACKLOG"
  4. When `showingBacklog` is true, display "NEW"
  5. The CSS class `.backlog-toggle-btn` applies `text-transform: uppercase`, so the rendered text will be "BACKLOG" / "NEW"

- **Source file state (already correct):**
```@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html:1739-1741
                const backlogToggleBtn = isCreated
                    ? `<button class="backlog-toggle-btn${showingBacklog ? ' is-active' : ''}" id="btn-toggle-backlog" style="${draggedSessionId !== null ? 'pointer-events:none;opacity:0.5;' : ''}" data-tooltip="${showingBacklog ? 'Switch to New view' : 'Switch to Backlog view'}">${showingBacklog ? 'NEW' : 'BACKLOG'}</button>`
                    : '';
```

- **Current dist file state (needs rebuild):**
```@/Users/patrickvuleta/Documents/GitHub/switchboard/dist/webview/kanban.html:1739-1741
                const backlogToggleBtn = isCreated
                    ? `<button class="backlog-toggle-btn${showingBacklog ? ' is-active' : ''}" id="btn-toggle-backlog" style="${draggedSessionId !== null ? 'pointer-events:none;opacity:0.5;' : ''}" data-tooltip="${showingBacklog ? 'Switch to New view' : 'Switch to Backlog view'}">${showingBacklog ? 'VIEW NEW' : 'VIEW BACKLOG'}</button>`
                    : '';
```

- **Build command:**
```bash
npm run build
# OR
npm run compile
# OR
npx webpack --mode production
```

- **Edge Cases Handled:**
  - The button is disabled during drag operations (`draggedSessionId !== null` check preserves this)
  - The tooltip remains informative despite shorter button text
  - CSS `text-transform: uppercase` ensures consistent styling

#### VERIFY `src/webview/kanban.html` CSS (no changes needed)
- **Context:** The `.backlog-toggle-btn` class already has appropriate styling for the shorter text.

- **Current CSS state (unchanged):**
```@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/kanban.html:232-254
        .backlog-toggle-btn {
            background: transparent;
            border: 1px solid var(--border-color);
            color: var(--text-secondary);
            padding: 2px 8px;
            border-radius: 4px;
            font-size: 11px;
            cursor: pointer;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 22px;
            line-height: 1;
            white-space: nowrap;
            font-family: var(--font-family);
            font-weight: 600;
            transition: all 0.15s;
            text-transform: uppercase;
        }
        .backlog-toggle-btn:hover {
            background: color-mix(in srgb, var(--accent-teal) 8%, transparent);
            border-color: var(--accent-teal-dim);
            color: var(--accent-teal);
        }
        .backlog-toggle-btn.is-active {
            color: var(--accent-orange);
            border-color: color-mix(in srgb, var(--accent-orange) 45%, transparent);
            background: color-mix(in srgb, var(--accent-orange) 10%, transparent);
        }
```

- **Edge Cases Handled:**
  - `white-space: nowrap` prevents text wrapping
  - `padding: 2px 8px` provides adequate spacing for shorter text
  - `min-width` is not set, allowing button to shrink naturally

## Verification Plan

### Pre-Build Verification
1. Confirm source file has correct text:
   ```bash
   grep -n "'BACKLOG'" src/webview/kanban.html
   # Expected: Line 1740 shows: ${showingBacklog ? 'NEW' : 'BACKLOG'}
   ```

2. Check for test files that might reference old text:
   ```bash
   grep -r "VIEW BACKLOG" --include="*.test.ts" --include="*.spec.ts" --include="*.js" src/
   grep -r "VIEW BACKLOG" --include="*.test.ts" --include="*.spec.ts" --include="*.js" dist/
   ```

### Build Verification
3. Run build command and check for errors:
   ```bash
   npm run build 2>&1 | tee build.log
   ```

4. Verify dist file was updated:
   ```bash
   grep -n "'BACKLOG'" dist/webview/kanban.html
   # Expected: Line 1740 shows: ${showingBacklog ? 'NEW' : 'BACKLOG'}
   ```

### Manual UI Verification
5. Load extension in VS Code dev mode
6. Open Switchboard Kanban panel
7. Verify the New column header shows "BACKLOG" button (not "VIEW BACKLOG")
8. Click the button to toggle to Backlog view
9. Verify button now shows "NEW" (not "VIEW NEW")
10. Resize VS Code window to narrow width (~320px sidebar)
11. Verify button remains fully visible without truncation

### Regression Testing
12. If tests exist, run them:
    ```bash
    npm test
    # OR
    npx playwright test
    ```

## Open Questions
- None

## Recommendation
**Send to Coder** — Complexity is 2 (trivial config/build change). The source code is already correct; only the build step is required.

## Execution Results

### Completed Actions
1. **Source file verification**: Confirmed `/src/webview/kanban.html:1740` contains correct text `'BACKLOG'` and `'NEW'`
2. **Test file check**: No test files reference old "VIEW BACKLOG" text
3. **Build execution**: Ran `npm run compile` successfully (webpack 5.105.4 compiled in 2057ms)
4. **Dist file verification**: Confirmed `/dist/webview/kanban.html:1740` now contains updated text:
   - Before: `${showingBacklog ? 'VIEW NEW' : 'VIEW BACKLOG'}`
   - After: `${showingBacklog ? 'NEW' : 'BACKLOG'}`

### Files Changed
- `dist/webview/kanban.html` (regenerated via webpack build)

### Validation
- Build completed without errors
- Dist file successfully updated with shortened button labels
- No test files require updates (no references to old text found)

### Remaining Risks
- Manual UI verification required: Load extension in VS Code dev mode and verify button displays correctly at 320px viewport width
- Tooltip consistency verified: "Switch to Backlog view" remains semantically consistent with "BACKLOG" button text

## Reviewer Pass
**Reviewed:** 2026-04-13

### Grumpy Critique
- [MAJOR] The code is fine, but the acceptance criterion that matters — "fits at 320px" — is still unproven from code inspection alone. Claiming success without that viewport check is optimism wearing a hard hat.
- [NIT] The plan text still advertises `npm run build`, which does not exist in this repo. `npm run compile` is the real command.

### Balanced Response
Keep the implementation. Both `src/webview/kanban.html` and generated `dist/webview/kanban.html` render `BACKLOG` / `NEW`, and there are no remaining `VIEW BACKLOG` or `VIEW NEW` strings. No code fix was required in reviewer pass; only the manual narrow-width UI check remains open.

### Reviewer Changes
- No code changes required.

### Validation Results
- `npm run compile` ✅
- `rg -n "VIEW BACKLOG|VIEW NEW|BACKLOG|NEW" src/webview/kanban.html dist/webview/kanban.html src/test` ✅ (only `BACKLOG` / `NEW` remain)

### Remaining Risks
- Manual VS Code webview validation at `>=320px` remains required to confirm the fit improvement.
- The plan's `npm run build` note is stale; use `npm run compile` in this repository.

## Switchboard State
**Kanban Column:** CODE REVIEWED
**Status:** active
**Last Updated:** 2026-04-13T12:30:33.907Z
**Format Version:** 1
