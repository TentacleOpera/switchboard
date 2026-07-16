# Plan: Fix Image Attachments Not Showing in Edit Preview

## Goal
Make locally-attached ticket images (relative paths like `attachments/image.png`) render in the markdown editor's **live preview** while editing a ticket, instead of showing as broken images.

**Problem.** When editing a ticket, attached images referenced via relative paths do not render in the live markdown preview — they appear broken.

**Root cause (confirmed against the code).** The live-preview render path does not rewrite local image paths to webview URIs:
- The `renderMarkdownLive` handler in `PlanningPanelProvider.ts` (line ~2546) calls `markdown.api.render` directly on `msg.content` and does **not** call `_rewriteLocalImagePaths` first.
- A VS Code webview cannot load a relative path like `attachments/image.png`; such paths must be converted to `vscode-webview-resource:` URIs via `webview.asWebviewUri` — which is exactly what `_rewriteLocalImagePaths` (line ~2431) does.
- The edit-mode textarea is seeded from `issue.descriptionMarkdown`, which for a locally-saved ticket is the **raw** file content with original relative paths (`enterTicketsEditMode`, `planning.js` ~line 10051; raw paths come from `localTicketFileRead`'s `rawContent`, server line ~6459). So the live preview receives raw relative paths and renders them unresolved.

**Scope clarification (corrects the original root-cause framing).** The original plan implied the whole non-edit flow was the reference "good" path via line ~6458. Precisely: **view mode is already correct** — `localTicketFileRead` (server line 6458) rewrites paths into `content`, and the webview renders that rewritten `content` (`planning.js` lines ~5617-5619, `previewMarkdown = msg.content`). Only the **edit-mode live preview** is broken. This plan is therefore correctly scoped to the `renderMarkdownLive` path only.

> **Note (related, out of scope):** The server-side API-fetch render `renderedDescriptionHtml` (lines ~5089-5095 Linear, ~5329-5335 ClickUp) also does not rewrite, but it is only used for remote-only tickets that have no local file (and thus no local images); locally-saved tickets are superseded by the rewritten `localTicketFileRead` content via `localDescription: true`. No change needed here for this feature.

## Metadata
- **Tags:** frontend, backend, ui, bugfix
- **Complexity:** 6

## User Review Required
- None. The fix is a mechanical extension of the existing `_rewriteLocalImagePaths` + `_findTicketFilePath` machinery to the live-preview path, backward-compatible with the non-ticket editor mounts.

## Complexity Audit

### Routine
- Reuses two existing, proven helpers unchanged: `_rewriteLocalImagePaths(markdown, baseDir)` (line ~2431) and `_findTicketFilePath(workspaceRoot, provider, id)` (used at lines ~6446, ~6475).
- Mirrors the already-correct view-mode rewrite behaviour into the edit-preview path.

### Complex / Risky
- **Two-surface change (provider handler + webview message).** The webview must send enough to identify the ticket; the handler must resolve the correct base directory server-side.
- **The base directory is not the workspace root.** Images live at `<ticketFileDir>/attachments/` where `ticketFileDir = path.dirname(_findTicketFilePath(...))` — resolvable only server-side. The naive `msg.workspaceRoot` base is wrong (see Superseded below).
- **Shared handler.** `renderMarkdownLive` also serves the docs/design/kanban editor mounts (`planning.js` ~line 7936), which send no ticket identity — the change must be a no-op for them.

## Edge-Case & Dependency Audit
- **Race Conditions:** Live preview is debounced (~200ms) and already uses a `requestId` to discard stale responses; resolving `baseDir` per render adds an `await` but the `requestId` guard still applies. Resolving the ticket dir on each keystroke is acceptable at that cadence; if it ever shows up as costly, cache the resolved dir per edit session (see alternative in Adversarial Synthesis).
- **Security:** `_rewriteLocalImagePaths` already restricts to existing local files (`fs.existsSync`) and leaves remote/`data:`/webview URIs untouched — no new surface. `_findTicketFilePath` resolves within the workspace.
- **Side Effects:** For non-ticket mounts (no `provider`/`id`), `baseDir` stays empty → no rewrite → identical current behaviour. Remote-only tickets (no local file) → `_findTicketFilePath` returns falsy → no rewrite → images that were never local stay as-is (unchanged).
- **Dependencies & Conflicts:** Touches `PlanningPanelProvider.ts` (handler) and `planning.js` (webview message) — **files not touched by any sibling subtask.** No overlap with the icon/blue-bg/scrollbar plans.

## Dependencies
- Independent of all sibling subtasks. Can land in any order.

## Adversarial Synthesis
Key risks: getting the base directory wrong (workspace root ≠ ticket dir) would silently leave images broken while looking "fixed"; mitigated by resolving `baseDir` server-side from `_findTicketFilePath` and by `_rewriteLocalImagePaths`'s `existsSync` guard (a wrong base simply no-ops rather than emitting bad URIs). The shared-handler no-op path protects docs/design/kanban editors. Optional optimisation: resolve the ticket dir once at edit-entry and pass a cached `baseDir` with each render instead of re-resolving per keystroke — deferred as unnecessary at the 200ms debounce.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts` — `renderMarkdownLive` handler (~line 2546)
Resolve the ticket base directory server-side (only when the message carries ticket identity), rewrite local image paths, then render.

```typescript
case 'renderMarkdownLive': {
    try {
        let content = msg.content || '';
        // Tickets edit-preview: resolve the ticket file's directory and rewrite
        // relative image paths to webview URIs (mirrors the view-mode path).
        // Non-ticket editor mounts send no provider/id → no rewrite (unchanged).
        if (msg.provider && msg.id) {
            const wsRoot = this._resolveWorkspaceRoot(msg.workspaceRoot) || workspaceRoot;
            const ticketFilePath = await this._findTicketFilePath(wsRoot, msg.provider, msg.id);
            if (ticketFilePath) {
                content = this._rewriteLocalImagePaths(content, path.dirname(ticketFilePath));
            }
        }
        const html = await vscode.commands.executeCommand<string>('markdown.api.render', content);
        const targetPanel = isProject ? this._projectPanel : this._panel;
        this._pushTo(targetPanel, 'planning', {
            type: 'markdownLiveRendered',
            requestId: msg.requestId,
            html: html,
            htmlContent: html
        });
    } catch (err) {
        const targetPanel = isProject ? this._projectPanel : this._panel;
        this._pushTo(targetPanel, 'planning', {
            type: 'markdownLiveRendered',
            requestId: msg.requestId,
            html: '',
            htmlContent: '',
            error: String(err)
        });
    }
    break;
}
```
- **Context:** `workspaceRoot` is already in scope in `_handleMessage` (line ~2540); `_resolveWorkspaceRoot`, `_findTicketFilePath`, and `_rewriteLocalImagePaths` all already exist.
- **Edge Cases:** falsy `ticketFilePath` (remote-only or unsaved ticket) → skip rewrite; no `provider`/`id` (docs mounts) → skip rewrite.

### `src/webview/planning.js` — `enterTicketsEditMode` renderPreview (~line 10104)
Include the ticket identity in the live-preview message so the handler can resolve the base directory. `provider`, `task.id`, and `ticketsWorkspaceRoot` are all already in scope here (the same values are already passed to `ticketAttachImage` at lines ~10116-10121).

```javascript
// Before
vscode.postMessage({ type: 'renderMarkdownLive', requestId, content: markdown });

// After
vscode.postMessage({
    type: 'renderMarkdownLive',
    requestId,
    content: markdown,
    provider,
    id: task.id,
    workspaceRoot: ticketsWorkspaceRoot
});
```
- **Edge Cases:** `ticketsWorkspaceRoot` may be undefined (the Tickets tab has no workspace assignment) — pass it through unchanged; the backend resolves via `_resolveWorkspaceRoot(...) || workspaceRoot`. Do **not** guard the message on a truthy `ticketsWorkspaceRoot`.
- **Leave the docs/design/kanban renderPreview site (`planning.js` ~line 7936) unchanged** — it deliberately sends no `provider`/`id`, keeping the handler a no-op for those mounts.

### Superseded: the original base-directory approach
> **Superseded:** `const baseDir = msg.baseDir || msg.workspaceRoot || ''; const rewritten = baseDir ? this._rewriteLocalImagePaths(msg.content||'', baseDir) : msg.content||'';` with "ensure the webview sends `baseDir` (the ticket file's directory)."
> **Reason:** (1) The webview does **not** know the ticket file's directory — `_findTicketFilePath` runs server-side and `localTicketFileRead` never returns the path to the webview, so it cannot send an accurate `baseDir`. (2) `msg.workspaceRoot` is the **wrong** base: attachments live at `<ticketFileDir>/attachments/` (see `ticketAttachImage`, server line ~6491), and `ticketFileDir` is not the workspace root — resolving `attachments/foo.png` against the workspace root fails `existsSync` and the image stays broken while the code appears "fixed."
> **Replaced with:** Send ticket identity (`provider` + `id` + `workspaceRoot`) from the webview and resolve `baseDir = path.dirname(_findTicketFilePath(...))` **server-side** (above). This uses the same resolution the attach flow already uses, so the preview base always matches where images are actually written.

## Verification Plan

### Automated Tests
- None. Per session directive, no automated tests are run; the round-trip (webview URI resolution + `markdown.api.render`) is only meaningfully verifiable in the running webview.

### Manual / Observational
1. Attach an image to a ticket (toolbar image button), save, then enter edit mode.
2. Confirm the image renders in the **live preview** pane (not a broken-image icon).
3. Confirm remote images (`http(s)://…`) still render (untouched by the rewrite).
4. Confirm a ticket with no images still renders normally.
5. Confirm the docs/design/kanban markdown editors still preview correctly (no `provider`/`id` → unchanged path).

## Recommendation
Complexity 6 → **Send to Coder.** Two coordinated surfaces (provider handler + webview message) and a base-directory subtlety, but built entirely from existing, proven helpers.

## Completion Report (2026-07-16)
Implemented the superseding server-side approach: `renderMarkdownLive` handler in `src/services/PlanningPanelProvider.ts` (~line 2546) now resolves the ticket file via `_findTicketFilePath` and rewrites relative image paths with `_rewriteLocalImagePaths(content, path.dirname(ticketFilePath))` — only when the message carries `provider` + `id`. `enterTicketsEditMode`'s renderPreview in `src/webview/planning.js` (~line 10104) now sends `provider`, `task.id`, and `workspaceRoot: ticketsWorkspaceRoot` (no truthy guard, per convention). Docs/design/kanban mounts (planning.js ~7937) untouched → handler no-ops for them. TS parse and JS syntax checks pass; no issues encountered.
