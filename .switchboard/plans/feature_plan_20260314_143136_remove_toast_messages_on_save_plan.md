# remove toast messages on save plan

## Notebook Plan

when i save a plan, even when i don't create it via airlock, i always get vs code message 'airlock plan saved'. this is pointless and annoying.

## Goal
- Remove the redundant "Airlock: Plan saved." VS Code toast notification that fires on `mode === 'local'`.
- Preserve the webview `airlock_planSaved` message (which updates the UI) and all error/warning toasts.

## Source Code Verification (2026-03-15)
- **Target line:** `src/services/TaskViewerProvider.ts:5341` — `vscode.window.showInformationMessage('Airlock: Plan saved.');`
- **Context:** Inside `_handleInitiatePlan` method (line 5327), within the `if (mode === 'local')` block (line 5339).
- **Kept intact:** Line 5340 `this._view?.webview.postMessage({ type: 'airlock_planSaved' });` — this handles the webview UI update and must remain.
- **Other toasts preserved:**
  - Line 5332: `showWarningMessage` for missing title/idea — **keep**.
  - Line 5358: `showInformationMessage('Plan created and prompt copied to clipboard.')` for `mode === 'copy'` — **keep** (provides clipboard confirmation).
  - Line 5364: `showErrorMessage` in catch block — **keep**.

## Proposed Changes

### Step 1 — Delete the toast line (Routine, single line removal)
- **File:** `src/services/TaskViewerProvider.ts`
- **Line 5341:** Delete `vscode.window.showInformationMessage('Airlock: Plan saved.');`
- **Exact change:**
  ```typescript
  // OLD (lines 5339-5343):
  if (mode === 'local') {
      this._view?.webview.postMessage({ type: 'airlock_planSaved' });
      vscode.window.showInformationMessage('Airlock: Plan saved.');
      return;
  }

  // NEW:
  if (mode === 'local') {
      this._view?.webview.postMessage({ type: 'airlock_planSaved' });
      return;
  }
  ```

### Step 2 — Update compiled JS (Routine)
- **File:** `src/services/TaskViewerProvider.js` — the compiled output will need to be regenerated. Run `npm run compile` or the project build command.

### No other files need changes.

## Verification Plan
1. Run the extension in development mode (`F5` launch).
2. Open the Switchboard sidebar → Airlock tab.
3. Create a new plan with title and idea, save with "Save Plan" (local mode).
4. **Verify:** Plan saves, modal closes, Airlock status text updates — but **NO** VS Code toast appears.
5. Create another plan with "Copy" mode → **Verify** the clipboard toast still fires ("Plan created and prompt copied to clipboard.").
6. Try saving with empty fields → **Verify** the warning toast still fires.

## Open Questions
- None.

---

## Internal Adversarial Review

### Grumpy-style Critique
"Removing the toast might leave users confused if the webview UI doesn't clearly reflect the saved state. What about the 'copy' mode toast? And what if the save silently fails before the catch block?"

### Balanced Synthesis
- The webview `airlock_planSaved` message already updates the UI, making the toast redundant.
- The 'copy' mode toast provides actual utility (clipboard confirmation) and should stay.
- Error handling is fully preserved — `showErrorMessage` in the catch block (line 5364) and `showWarningMessage` for validation (line 5332) are untouched.
- This is a surgical single-line deletion.

**Recommendation:** This is a simple plan. Send it to the **Coder agent**.
