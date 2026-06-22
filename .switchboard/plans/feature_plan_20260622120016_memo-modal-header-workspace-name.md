# Include the Workspace Name in the Memo Modal Header (e.g. "MEMO — SWITCHBOARD")

## Goal

The Memo modal header reads only "Memo". It should include the active workspace name, e.g. **MEMO — SWITCHBOARD**, so it is clear which workspace's memo is being edited.

### Problem Analysis

The modal title is a static literal in [kanban.html:2999](src/webview/kanban.html#L2999):
```html
<h3 class="modal-title">Memo</h3>
```
The memo content is loaded per workspace: the webview posts `memoLoad` and the backend `memoLoad` handler ([KanbanProvider.ts:6942-6951](src/services/KanbanProvider.ts#L6942)) reads `${workspaceRoot}/.switchboard/memo.md` and replies with `{ type: 'memoContent', content }` — but the reply carries **no workspace name**, so the webview has nothing to put in the header. The memo is workspace-scoped while the header is not, which is exactly the ambiguity the user is hitting.

### Root Cause

The title is hardcoded and the `memoContent` message does not include a workspace display name, so the webview can't render a workspace-qualified header.

## Metadata

**Complexity:** 3
**Tags:** frontend, backend, ui, ux

## User Review Required

No — this is a display-only enhancement with no data migration or breaking changes. Proceed directly to implementation.

## Complexity Audit

### Routine
- Adding a `workspaceName` field to the `memoContent` payload and updating the modal title element's text when it arrives.
- Giving the existing `<h3 class="modal-title">` element a stable `id` so it can be targeted from the message handler.
- Both `memoContent` emission sites (initial load and post-clear) are in the same file, within ~50 lines of each other.

### Complex / Risky
- Choosing the workspace name source. The backend resolves a `workspaceRoot` via `_resolveWorkspaceRoot`. The display name **must** be consistent with how the Kanban panel labels workspaces elsewhere. The Kanban workspace dropdown uses `_getWorkspaceItems()` ([KanbanProvider.ts:753-826](src/services/KanbanProvider.ts#L753)), which resolves labels through mapped workspace names (`m.name`) or VS Code folder names (`folder.name`), falling back to `path.basename` only when neither is available. Using bare `path.basename(workspaceRoot)` would be **inconsistent** with the dropdown labels in multi-root / mapped setups — see Adversarial Synthesis.

## Edge-Case & Dependency Audit

- **Race Conditions:** The title must update on the `memoContent` message (which fires on every open via `openMemoModal` → `memoLoad` at [kanban.html:3669](src/webview/kanban.html#L3669)), so it stays correct when switching workspaces. The `memoContent` message is async; the modal is shown immediately by `openMemoModal` before the response arrives, so the title will briefly show the default ("MEMO") and then update — this is acceptable and matches how the textarea content loads.
- **Security:** None — the workspace name is derived from the resolved root path, not user input. The webview handler sanitizes via `String(...).toUpperCase()` and template-literal interpolation (no `innerHTML`).
- **Side Effects:** None — display only. The title element id/class (`.modal-title`) is preserved so the theme-color CSS still applies.
- **Dependencies & Conflicts:** Pairs with the memo-modal intro-text change and the theme-aware header change; all three touch the memo modal. Keep the title element's `class="modal-title"` so the theme-color fix still applies. Adding an `id` attribute does not conflict.

## Dependencies

None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) Using `path.basename(workspaceRoot)` for the display name is inconsistent with the Kanban dropdown labels in multi-root/mapped setups — the dropdown uses mapped `m.name` or VS Code `folder.name`, not basename. (2) The post-clear `memoContent` at line 6993 must also carry `workspaceName` or the header reverts to bare "MEMO" after Send/Copy. Mitigations: derive `workspaceName` from `_getWorkspaceItems()` to match the dropdown; include `workspaceName` on both `memoContent` emission sites.

## Proposed Changes

### 1. `src/webview/kanban.html` — give the title a stable id and a default
At [2999](src/webview/kanban.html#L2999):
```html
<h3 class="modal-title" id="memo-modal-title">MEMO</h3>
```
The `class="modal-title"` is preserved for theme-color CSS. The `id="memo-modal-title"` allows the message handler to update the text. The default text is "MEMO" (uppercase, matching the target format) so the brief pre-response window shows the correct style.

### 2. `src/services/KanbanProvider.ts` — include the workspace name in `memoContent`
In the `memoLoad` handler ([6942-6951](src/services/KanbanProvider.ts#L6942)), derive a display name that is **consistent with the Kanban workspace dropdown** by looking up the resolved root in `_getWorkspaceItems()`:
```ts
case 'memoLoad': {
    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
    if (!workspaceRoot) break;
    const memoPath = this._getMemoPath(workspaceRoot);
    let content = '';
    try {
        content = await fs.promises.readFile(memoPath, 'utf8');
    } catch { /* file doesn't exist yet — that's fine */ }
    const workspaceName = this._getWorkspaceItems()
        .find(item => item.workspaceRoot === workspaceRoot)?.label
        || path.basename(workspaceRoot);
    this._panel?.webview.postMessage({ type: 'memoContent', content, workspaceName });
    break;
}
```
This mirrors the dropdown's label resolution: mapped `m.name` → VS Code `folder.name` → `path.basename` fallback.

### 3. `src/services/KanbanProvider.ts` — include `workspaceName` on the post-clear `memoContent`
At [6993](src/services/KanbanProvider.ts#L6993), the `memoGeneratePrompt` handler emits a `memoContent` with empty content after a successful Send/Copy. This must also carry `workspaceName` so the header stays populated:
```ts
if (sendSucceeded) {
    const memoPath = this._getMemoPath(workspaceRoot);
    await fs.promises.writeFile(memoPath, '', 'utf8');
    const workspaceName = this._getWorkspaceItems()
        .find(item => item.workspaceRoot === workspaceRoot)?.label
        || path.basename(workspaceRoot);
    this._panel?.webview.postMessage({ type: 'memoContent', content: '', workspaceName });
}
```
**Clarification:** `workspaceRoot` is already resolved at the top of the `memoGeneratePrompt` case ([6970](src/services/KanbanProvider.ts#L6970)), so it is in scope here.

### 4. `src/webview/kanban.html` — set the title from the payload
In the `memoContent` message handler ([6414-6418](src/webview/kanban.html#L6414)):
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
Uses `textContent` (not `innerHTML`) to prevent any injection. Falls back to bare "MEMO" if `workspaceName` is absent (defensive — should not happen with the backend changes above, but guards against older cached messages).

## Verification Plan

### Automated Tests
Skipped per session directives — the user will run the test suite separately.

### Manual Verification
1. Open Kanban in the `switchboard` workspace → open the Memo modal → confirm the header reads `MEMO — SWITCHBOARD`.
2. Switch to a different workspace and open the Memo modal → confirm the header shows that workspace's name (matching the Kanban workspace dropdown label, not just the basename).
3. Press Send to Planner / Copy → confirm the header still shows the workspace name (not reverting to bare "MEMO") after the memo is cleared.
4. Confirm the title color still follows the active theme (the `.modal-title` class is preserved).
5. In a multi-root / mapped workspace setup, confirm the memo header shows the mapped workspace name (e.g. `m.name`), consistent with the Kanban workspace dropdown — not the raw folder basename.

---

**Recommendation:** Complexity 3 → **Send to Intern** (single-file frontend change + one backend payload addition, all following existing patterns with no architectural risk).
