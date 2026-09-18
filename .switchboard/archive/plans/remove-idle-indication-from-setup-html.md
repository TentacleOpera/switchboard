# Remove IDLE Indication from setup.html

## Goal
Remove the hardcoded "IDLE" text from the `#setup-save-status` element in setup.html so that the status area is empty by default and only displays text during active autosave operations.

## Metadata
- **Tags:** [frontend, UX, bugfix]
- **Complexity:** 1

## User Review Required
No — this is a trivial single-word removal with no functional impact.

## Complexity Audit

### Routine
- Remove a single hardcoded word ("IDLE") from an HTML div element
- The `setSetupSaveStatus()` JS function only ever writes "SAVING...", "SAVED", or "FAILED" — never "IDLE" — so no JS changes are needed
- The `min-height:14px` style on the div preserves layout stability when status text appears, so it should be kept as-is

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The status element is updated synchronously via `setSetupSaveStatus()`. Removing the initial text has no concurrency implications.
- **Security:** None. This is a display-only change with no data flow impact.
- **Side Effects:** The empty div with `min-height:14px` will occupy 14px of vertical space with no visible content. This is intentional — it prevents layout shift when "SAVING..." text appears during autosave. No other elements reference or depend on the "IDLE" text content.
- **Dependencies & Conflicts:** None. No other code reads the initial text content of `#setup-save-status`. No hydration code sets it to "IDLE" programmatically.

## Dependencies
- None

## Adversarial Synthesis
Key risks: None meaningful — this is a single-word HTML removal with no functional impact. The `min-height:14px` style correctly prevents layout shift when status text appears. The related UX issue of "SAVED" persisting indefinitely after save is real but out of scope. Mitigations: Keeping `min-height` preserves layout stability; verified no JS code re-sets "IDLE" programmatically.

## Proposed Changes

### `src/webview/setup.html`

**Line 490-492 — Remove hardcoded "IDLE" text**

Context: The `#setup-save-status` div is a status indicator below the git ignore configuration section. It currently shows "IDLE" by default, which is confusing because the panel uses autosave (no manual save button). The JavaScript `setSetupSaveStatus()` function (line 1838) only ever sets the text to "SAVING..." (line 1919), "SAVED" (lines 3450, 3523), or "FAILED" (lines 3446, 3523) — never "IDLE". No hydration code sets it to "IDLE" either.

Implementation: Remove the `IDLE` text content from between the div tags, making it a self-closing-style empty div. Keep all inline styles unchanged (especially `min-height:14px` which prevents layout shift).

**Before (lines 490-492):**
```html
<div id="setup-save-status" style="min-height:14px; margin-top:6px; font-size:10px; color:var(--text-secondary); font-family:var(--font-mono);">
    IDLE
</div>
```

**After:**
```html
<div id="setup-save-status" style="min-height:14px; margin-top:6px; font-size:10px; color:var(--text-secondary); font-family:var(--font-mono);"></div>
```

Edge Cases:
- On initial page load, the status area will be empty (correct behavior).
- When autosave fires, "SAVING..." will appear, then transition to "SAVED" or "FAILED" (unchanged behavior).
- The `min-height:14px` ensures no layout shift when text first appears.
- If the extension rehydrates the setup panel, no code resets the status to "IDLE" — it remains empty until the next autosave.

## Verification Plan

### Automated Tests
- Not applicable — this is a display-only HTML text change with no testable logic.

### Manual Verification
1. Open the Setup tab in the Switchboard webview
2. Verify the status area below the git ignore section is empty (no "IDLE" text)
3. Change the git ignore strategy dropdown
4. Verify "SAVING..." appears briefly, then transitions to "SAVED"
5. Verify no "IDLE" text appears at any point during the interaction
6. Reload the webview and verify the status area is still empty on fresh load

## Reviewer Notes (Grumpy Principal Engineer)
*   **setup.html `setup-save-status` Element**: "Bah, it looks like someone actually followed instructions for once! The `IDLE` text is gone and the `min-height:14px` style remains to prevent that infuriating layout shift. NIT: Would be nice if the div wasn't completely squished on one line, but it's HTML so it's fine." (Severity: NIT)

### Synthesis
*   The implementation in `src/webview/setup.html` is exactly as specified in the plan. The hardcoded "IDLE" text has been removed and all inline styles (importantly, `min-height:14px`) were preserved. No code changes were necessary.

### Status
- **Review**: COMPLETED
- **Fixes Applied**: NONE REQUIRED
- **Remaining Risks**: None.

## Impact
- The status element will be empty by default
- Users will only see status text when autosave is actively working
- Reduces UI confusion and clutter
- No functional changes to autosave behavior

## Recommendation
Complexity 1 → **Send to Intern**
