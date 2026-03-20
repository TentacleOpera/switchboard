# Fix open docs button link

## Notebook Plan

The open docs button link needs to go to the plugin readme, not the current random doc that i dobn't know what is or why it exists

## Goal
- Make the "Open Docs" button open the **plugin's README.md** (at the extension root), not the current `.switchboard/WORKFLOW_REFERENCE.md` file.
- There are **two** `openDocs` handlers in `TaskViewerProvider.ts` — one in the sidebar webview (line ~1250) and one in the KanbanProvider (line ~1450). Both need to be fixed.

## Dependencies
- **No blocking dependencies.** The plugin `README.md` already exists at the extension root.

## Proposed Changes

### Step 1 — Fix the sidebar openDocs handler (Routine)
- **File**: `src/services/TaskViewerProvider.ts`
- **Lines 1250-1268**: The current handler tries to open `.switchboard/WORKFLOW_REFERENCE.md` with a fallback to `.switchboard/README.md`. Replace the entire logic:
  ```ts
  case 'openDocs': {
      const readmePath = vscode.Uri.joinPath(this._context.extensionUri, 'README.md');
      try {
          await vscode.workspace.fs.stat(readmePath);
          vscode.commands.executeCommand('markdown.showPreview', readmePath);
      } catch {
          vscode.window.showErrorMessage('Plugin README.md not found.');
      }
      break;
  }
  ```
- Key change: use `this._context.extensionUri` (the extension's install directory) instead of the workspace folder. This ensures we open the **plugin's** README, not any workspace README.

### Step 2 — Verify the KanbanProvider openDocs handler (Routine)
- **File**: `src/services/KanbanProvider.ts` (if the kanban panel also has an openDocs handler)
- The second `openDocs` handler (TaskViewerProvider.ts line ~1450) already uses `this._context.extensionUri` and opens `README.md` — this is correct. Verify it matches the pattern above and leave it unchanged if so.

### Step 3 — Verify no other openDocs references (Routine)
- Search for `openDocs` across the codebase to ensure no other handlers exist that still point to the wrong file.
- Search for `WORKFLOW_REFERENCE.md` — if no other code references it, consider whether the file itself should be removed or kept for other purposes.

## Verification Plan
1. `npm run compile` — no build errors.
2. Open Switchboard sidebar → click "Open Docs" button → verify the **plugin README.md** opens in a markdown preview panel.
3. Verify the content is the actual plugin README (not WORKFLOW_REFERENCE.md or a workspace README).
4. If kanban also has an "Open Docs" button, verify it opens the same README.
5. `grep -r "WORKFLOW_REFERENCE" src/` — confirm no remaining references (or document why they exist if they do).

## Complexity Audit

### Band A — Routine
- Change the URI in the sidebar `openDocs` handler from workspace `.switchboard/WORKFLOW_REFERENCE.md` to `extensionUri/README.md`
- Grep verification

### Band B — Complex / Risky
- None

**Recommendation**: Send it to the **Coder agent** — single URI change in one handler.
