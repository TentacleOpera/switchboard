# Plan: Fix Image Attachments Not Showing in Edit Preview

## Problem
When editing a ticket, attached images (referenced via relative paths like `attachments/image.png`) do not render in the live markdown preview. They show as broken images.

## Root Cause
- The `renderMarkdownLive` handler in `PlanningPanelProvider.ts` (line ~2548) calls `markdown.api.render` on the raw markdown content but does NOT call `_rewriteLocalImagePaths` first.
- The non-edit preview flow (line ~6458) does call `_rewriteLocalImagePaths` to convert local paths to webview URIs.
- Without rewriting, the webview cannot resolve relative paths like `attachments/image.png` — they need to be converted to `vscode-webview-resource:` URIs.

## Fix
Call `_rewriteLocalImagePaths` on the markdown content before passing it to `markdown.api.render` in the `renderMarkdownLive` handler.

### Files to Change
1. **`src/services/PlanningPanelProvider.ts`** — `renderMarkdownLive` case (~line 2548)

### Change
```typescript
// Before
const html = await vscode.commands.executeCommand<string>('markdown.api.render', msg.content || '');

// After
const baseDir = msg.baseDir || msg.workspaceRoot || '';
const rewrittenContent = baseDir ? this._rewriteLocalImagePaths(msg.content || '', baseDir) : (msg.content || '');
const html = await vscode.commands.executeCommand<string>('markdown.api.render', rewrittenContent);
```

### Prerequisite
The webview must send `baseDir` (or `workspaceRoot`) in the `renderMarkdownLive` message so the provider knows where to resolve relative paths from. Check `planning.js` / `markdownEditor.js` to ensure the message includes the ticket's directory path.

### Files to Change (webview side)
2. **`src/webview/markdownEditor.js`** or **`src/webview/planning.js`** — Ensure the `renderMarkdownLive` postMessage includes `baseDir` (the ticket file's directory).

## Verification
- Attach an image to a ticket, save, then enter edit mode.
- Verify the image renders in the live preview pane.
- Verify remote images (http URLs) still work.
- Verify markdown without images still renders correctly.
