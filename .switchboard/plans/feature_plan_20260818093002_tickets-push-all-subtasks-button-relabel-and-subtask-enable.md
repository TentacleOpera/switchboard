# Relabel and Enable 'Push All Subtasks' Button from Subtask Views

## Goal
In `tickets.html`, the action button currently labeled `Push + subtasks` is confusing in nomenclature and is disabled whenever a subtask is selected (`disabled = !!(parentId) || localSubtaskCount === 0` at `tickets.js` line 1612). Users working on a subtask or parent ticket should be able to push the entire hierarchy (the parent and all associated subtasks) seamlessly.

The button must be relabeled to `Push all subtasks` and be enabled and actionable whether the user is currently viewing the parent ticket or any of its subtasks.

### Problem & Root Cause Analysis
1. **Button Label**: The label `Push + subtasks` (in `tickets.html` line 4065) is ambiguous. Renaming it to `Push all subtasks` clearly communicates that the entire family of subtasks (and parent) is pushed.
2. **Artificial Subtask Gating**: In `src/webview/tickets.js`, `_toggleSubtaskMetaButtons` explicitly enforces `btnPushSubtasks.disabled = !!(parentId) || localSubtaskCount === 0;` (line 1612). This prevents users from clicking the button while focused on a subtask, even though pushing from a subtask is a legitimate operation.
3. **Backend ID Resolution**: When invoked from a subtask, `TaskViewerProvider.pushTicketEditsWithSubtasks` (line 24093) receives the subtask's ID and uses it directly as the parent (`_localSubtaskIdsFor(resolvedRoot, provider, id)` at 24105), so only the subtask itself is pushed. It should resolve the parent ticket ID (via frontmatter) to push the parent and all sister subtasks, making the operation idempotent and symmetric.

## Metadata
- **Complexity:** 3
- **Tags:** frontend, ui, ux, bugfix
- **Project:** Browser Switchboard
- **Feature:** 820d1f5b-f9aa-4e26-84ec-b64a198d3d5c

## User Review Required
No user decision required. The relabel and enable-from-subtask behaviour are unambiguous UX fixes; the backend parent-resolution reuses existing frontmatter/`_findTicketDocument` machinery.

## Complexity Audit
### Routine
- Updating button HTML markup in `tickets.html` (line 4065): `Push + subtasks` → `Push all subtasks`.
- Modifying the enable/disable logic in `_toggleSubtaskMetaButtons` (`tickets.js` line 1604-1613) so a subtask selection enables the button when the family has locally-imported subtasks.
- Resolving the parent ID in `pushTicketEditsWithSubtasks` (`TaskViewerProvider.ts` line 24093) when the supplied id is a subtask.
- Relabelling the backend message string (24131) and frontend fallback strings (7467, 7476) to `Push all subtasks`.

### Complex / Risky
- None. Reuses the existing `pushTicketWithSubtasks` backend command and `_findTicketDocument` resolver; no new API surface.

## Edge-Case & Dependency Audit
- **Parent card absent from the current list view**: when a subtask is selected and its parent is NOT in `linearProjectIssues`/`clickUpProjectIssues` (drilled in from another list, or not paginated into view), `list.find(t => t.id === parentId)` returns null. The enable condition must NOT collapse to `count === 0` in this case — resolve the family's local subtask count from the local-files source (`listLocalTicketFiles` → `subtaskCount`, keyed by `parentId`), the same source the comment at `tickets.js` line 1601 cites, rather than only the in-memory card list.
- **Standalone Subtasks (No local siblings)**: If a subtask has no siblings and the parent is not imported, the family has 0 local subtasks → button stays disabled. Correct: there is nothing beyond the subtask itself to push, and the plain `Push` button covers the single-ticket case.
- **Parent vs Subtask Selection**: When a subtask is selected, `parentId` is known via `_getSelectedParentId()`. The backend resolves the parent ID from the file's `parentId:` frontmatter and triggers the push for the parent + all child subtasks.
- **UI State Indicators**: Loading spinner and status toast must say `Push all subtasks: X pushed...` — the backend message (24131) and both frontend fallback strings (7467, 7476) must be relabelled in the same change so button label and feedback agree.
- **Regex consistency**: the parent-resolution regex MUST match the existing `_localSubtaskIdsFor` pattern (`/^parentId:\s*(.+)$/m` + `.trim()`, line 24163), not a new `\S+` variant, so there is one source of truth for parsing `parentId` in this provider.

## Dependencies
- None. This plan touches `tickets.html`, `tickets.js` (`_toggleSubtaskMetaButtons` + click handler + status strings), and `TaskViewerProvider.pushTicketEditsWithSubtasks` — all stable, independently-shippable surfaces.

## Adversarial Synthesis
Key risks: (1) the enable condition silently re-disables the button when the parent card isn't in the current list view — the exact scenario a subtask-focused user hits; (2) relabeling the button but missing the backend/frontend status strings leaves the feedback disagreeing with the label. Mitigations: resolve the family's local subtask count from local files keyed by `parentId` (not just the card list), and relabel all three status-string sites (backend 24131, frontend 7467/7476) in the same change.

## Proposed Changes

### `src/webview/tickets.html`
- Relabel `#btn-push-ticket-subtasks` (line 4064-4065):
```html
<button id="btn-push-ticket-subtasks" class="strip-btn" disabled
        title="Push this ticket AND every locally-imported subtask — each one's own title and description. The generated Subtasks checklist is never pushed.">Push all subtasks</button>
```

### `src/webview/tickets.js`
- In `_toggleSubtaskMetaButtons` (line 1604-1613):
  - Update enable condition so a subtask selection enables the button when the family has locally-imported subtasks. Resolve the count from the parent card if present, otherwise from the local-files count keyed by `parentId` so a parent absent from the current list view does not collapse the button to disabled.
```javascript
const btnPushSubtasks = document.getElementById('btn-push-ticket-subtasks');
if (btnPushSubtasks) {
    const id = lastIntegrationProvider === 'linear'
        ? selectedLinearIssue?.issue?.id
        : selectedClickUpIssue?.task?.id;
    const list = lastIntegrationProvider === 'linear' ? linearProjectIssues : clickUpProjectIssues;
    const currentTicket = id ? list.find(t => t.id === id) : null;
    // When a subtask is selected, the family's count comes from the PARENT.
    // The parent may not be in the current card list (drilled in from another
    // list / not paginated) — fall back to the local-files subtask count keyed
    // by parentId (same source as card.subtaskCount, per comment at line 1601).
    let count;
    if (parentId) {
        const parentTicket = list.find(t => t.id === parentId);
        count = parentTicket ? (parentTicket.subtaskCount || 0)
            : (_localSubtaskCountForParent ? _localSubtaskCountForParent(parentId) : 0);
    } else {
        count = currentTicket ? (currentTicket.subtaskCount || 0) : 0;
    }
    btnPushSubtasks.disabled = count === 0;
}
```
  - **Clarification (implied):** if no `_localSubtaskCountForParent(parentId)` helper exists, add a thin lookup over the already-loaded local ticket files (the same `listLocalTicketFiles` result that populates `card.subtaskCount`), counting files whose `parentId` frontmatter equals `parentId` plus one for the parent itself. This is not new product scope — it is the local-count source the existing comment already references, extended to the parent-absent case.

- In the click handler for `#btn-push-ticket-subtasks` (line 5254-5262):
  - No frontend change needed — the handler already sends the selected `id` (which may be a subtask id) to `pushTicketWithSubtasks`; the backend now resolves the parent. Keep the existing `setTicketsLoadingState(true)` + `postMessage`.

- In the `pushTicketResult` handler (lines 7467, 7476):
  - Relabel both fallback strings from `Push + subtasks: ...` to `Push all subtasks: ...` so the toast agrees with the button label.

### `src/services/TaskViewerProvider.ts`
- In `pushTicketEditsWithSubtasks` (line 24093):
  - If the provided `id` is a subtask (its local document has `parentId:` frontmatter), resolve `effectiveParentId = parentId || id` before calling `_localSubtaskIdsFor`. Reuse the SAME regex as `_localSubtaskIdsFor` (line 24163: `/^parentId:\s*(.+)$/m` + `.trim()`) — do not introduce a second `parentId` parse pattern in this class.

```typescript
const { provider, id } = data;
// Resolve the parent: if `id` is a subtask, push its parent + all sister
// subtasks. Reuses the _findTicketDocument resolver and the SAME parentId
// regex as _localSubtaskIdsFor (24163) — one parse pattern per class.
let effectiveParentId = id;
const doc = await this._findTicketDocument(resolvedRoot, provider, id);
if (doc && fs.existsSync(doc)) {
    try {
        const content = fs.readFileSync(doc, 'utf8');
        const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        if (fm) {
            const pm = fm[1].match(/^parentId:\s*(.+)$/m);
            if (pm && pm[1].trim()) {
                effectiveParentId = pm[1].trim();
            }
        }
    } catch { /* unreadable — treat id as the parent */ }
}
const childIds = await this._localSubtaskIdsFor(resolvedRoot, provider, effectiveParentId);
const ids = Array.from(new Set([effectiveParentId, ...childIds]));
```
  - Relabel the success message at line 24131 from `Push + subtasks: ...` to `Push all subtasks: ...`.

## Verification Plan

### Automated Tests
- Run ticket subtask contract and push routing tests:
  - `npm test src/test/tickets-subtasks.test.js`
  - `npm test src/test/tickets-subtask-embedding.test.js`
  - `npm run push-routing:check`
- Add a test asserting `pushTicketEditsWithSubtasks` resolves a subtask id to its parent and pushes the parent + all sister subtasks (not just the subtask itself).

### Manual Verification
1. Open the Tickets panel with a parent ticket that has 2 subtasks.
2. Select the parent ticket: verify button says "Push all subtasks" and is enabled.
3. Click to view one of the subtasks: verify "Push all subtasks" remains enabled (parent present in list).
4. Drill into a subtask whose parent is NOT in the current list view: verify "Push all subtasks" is still enabled (count resolved from local files).
5. Click "Push all subtasks" from within the subtask view: verify all 3 tickets (parent + 2 subtasks) are pushed and the toast says "Push all subtasks: 3 pushed."
