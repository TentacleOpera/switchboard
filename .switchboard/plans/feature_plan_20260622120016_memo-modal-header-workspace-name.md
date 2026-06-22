# Include the Workspace Name in the Memo Modal Header (e.g. "MEMO — SWITCHBOARD")

## Goal

The Memo modal header reads only "Memo". It should include the active workspace name, e.g. **MEMO — SWITCHBOARD**, so it is clear which workspace's memo is being edited.

### Problem Analysis

The modal title is a static literal in [kanban.html:2990](src/webview/kanban.html#L2990):
```html
<h3 class="modal-title">Memo</h3>
```
The memo content is loaded per workspace: the webview posts `memoLoad` and the backend `memoLoad` handler ([KanbanProvider.ts:6890-6900](src/services/KanbanProvider.ts#L6890)) reads `${workspaceRoot}/.switchboard/memo.md` and replies with `{ type: 'memoContent', content }` — but the reply carries **no workspace name**, so the webview has nothing to put in the header. The memo is workspace-scoped while the header is not, which is exactly the ambiguity the user is hitting.

### Root Cause

The title is hardcoded and the `memoContent` message does not include a workspace display name, so the webview can't render a workspace-qualified header.

## Metadata

**Complexity:** 2
**Tags:** frontend, backend, memo, ux

## Complexity Audit

### Routine
- Adding a `workspaceName` to the `memoContent` payload and updating the modal title when it arrives.

### Complex / Risky
- Choosing the workspace name source. The backend resolves a `workspaceRoot`; the display name should be the workspace folder's basename (or the VS Code workspace folder `name`). Keep it consistent with how the Kanban panel labels workspaces elsewhere.

## Edge-Case & Dependency Audit

- **Race Conditions:** The title must update on the `memoContent` message (which fires on every open via `openMemoModal` → `memoLoad`), so it stays correct when switching workspaces.
- **Security:** None.
- **Side Effects:** None — display only.
- **Dependencies & Conflicts:** Pairs with the memo-modal intro-text change and the theme-aware header change; all three touch the memo modal. Keep the title element id/class (`.modal-title`) so the theme-color fix still applies.

## Proposed Changes

### 1. `src/webview/kanban.html` — give the title a stable id and a default
At [2990](src/webview/kanban.html#L2990):
```html
<h3 class="modal-title" id="memo-modal-title">MEMO</h3>
```

### 2. `src/services/KanbanProvider.ts` — include the workspace name in `memoContent`
In the `memoLoad` handler ([6890-6899](src/services/KanbanProvider.ts#L6890)), derive a display name from the resolved root and include it:
```ts
const workspaceName = path.basename(workspaceRoot);
this._panel?.webview.postMessage({ type: 'memoContent', content, workspaceName });
```
Also include `workspaceName` on the post-clear `memoContent` ([6941](src/services/KanbanProvider.ts#L6941)) so the header stays populated after Send/Copy clears the memo.

### 3. `src/webview/kanban.html` — set the title from the payload
In the `memoContent` message handler ([6400-6404](src/webview/kanban.html#L6400)):
```js
case 'memoContent': {
    const textarea = document.getElementById('memo-textarea');
    if (textarea) textarea.value = msg.content || '';
    const titleEl = document.getElementById('memo-modal-title');
    if (titleEl) titleEl.textContent = msg.workspaceName
        ? `MEMO — ${String(msg.workspaceName).toUpperCase()}`
        : 'MEMO';
    break;
}
```

## Verification Plan

1. Build; open Kanban in the `switchboard` workspace → open the Memo modal → confirm the header reads `MEMO — SWITCHBOARD`.
2. Switch to a different workspace and open the Memo modal → confirm the header shows that workspace's name.
3. Press Send to Planner / Clear → confirm the header still shows the workspace name (not reverting to bare "MEMO").
4. Confirm the title color still follows the active theme (compatible with the theme-aware header fix).
