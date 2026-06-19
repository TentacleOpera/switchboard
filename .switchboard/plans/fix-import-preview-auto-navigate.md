# Fix Clipboard Import Preview Auto-Navigation

## Goal

After a successful clipboard import, automatically select and preview the newly imported doc instead of leaving the preview pane on the previously selected doc.

### Problem

After a successful clipboard import (sidebar "Import" button or the top-level clipboard import), the preview pane stays on whatever doc was previously selected. The newly imported doc is never selected or previewed. The user has to manually find and click it in the sidebar.

### Root Cause

`_handleImportResearchDoc` (PlanningPanelProvider.ts:6290–6294) sends the success postMessage without a `savedPath` field:

```typescript
this._panel?.webview.postMessage({
    type: 'importResearchDocResult',
    success: true,
    docTitle: finalDocTitle
    // ← savedPath missing
});
```

`savedPath` IS available at this point — `writeResult.savedPath` was populated by `writeContentToDocsDir`. The value is just not forwarded.

The webview's `importResearchDocResult` handler (`planning.js:3296–3316`) shows a success message but has no auto-navigation logic. It doesn't know where the new file landed, so it can't select it.

Compare with `importFullDocResult` (planning.js:3229–3259), which correctly uses `msg.savedPath` + `state._pendingImportDocName` to auto-select the newly imported doc once the tree re-renders.

The infrastructure already exists — `state._pendingImportDocName` is set in `importFullDocResult` (planning.js:3250), then consumed in `handleLocalDocsReady` (planning.js:1947–1961) after `rerenderUnifiedDocs()` runs. We just need to wire the same path for `importResearchDocResult`.

### Timing

The backend sends messages in this order:
1. `importResearchDocResult` (success) — `PlanningPanelProvider.ts:6290`
2. `importedDocsReady` (from `_handleFetchImportedDocs`) — `PlanningPanelProvider.ts:6296`
3. `localDocsReady` (from `_sendLocalDocsReady`) — `PlanningPanelProvider.ts:6297`

When `importResearchDocResult` arrives, the sidebar tree has NOT been re-rendered yet (that happens on step 3 via `handleLocalDocsReady` → `rerenderUnifiedDocs()`). So the node can't be found in the DOM at step 1 — we must set `_pendingImportDocName` and let `handleLocalDocsReady` resolve it after the rerender, exactly as `importFullDocResult` does.

## Metadata
**Complexity:** 3
**Tags:** frontend, backend, bugfix, ui

## User Review Required

None. This is a self-contained bugfix that reuses an existing, shipped auto-navigation pattern. No product decisions are open.

## Complexity Audit

### Routine
- Forward one already-computed field (`writeResult.savedPath`) on an existing postMessage.
- Reuse the proven `_pendingImportDocName` → `handleLocalDocsReady` mechanism verbatim from `importFullDocResult`.
- Localized: two files, ~10 added lines total, no new functions, no new state keys.
- Defensive `if (msg.savedPath)` guard means every failure mode degrades to current behavior (no regression).

### Complex / Risky
- None. (See Edge-Case audit for the low-severity timing/path considerations, all of which already exist and are tolerated in the sibling `importFullDocResult` path.)

## Edge-Case & Dependency Audit

### Race Conditions
- **Shared `_pendingImportDocName` slot:** Both `importFullDocResult` and (after this change) `importResearchDocResult` write the same single `state._pendingImportDocName` slot. If two imports are in flight within one render cycle, last-writer-wins — but both candidates are valid imported docs, so the user always lands on *a* freshly imported doc. Acceptable; rare in practice.
- **Pending slot not cleared on match failure:** `handleLocalDocsReady` only nulls `_pendingImportDocName` when the node is found (planning.js:1957–1959). If the absolute-path match fails, the slot persists until the next import overwrites it. This behavior already exists in the shipped `importFullDocResult` path and has not produced reported issues, so path matching is empirically reliable. No change required.

### Security
- No new input surface. `savedPath` is a backend-computed filesystem path, not user-controlled webview input. It is compared against `dataset.absolutePath` for DOM lookup only — never written, executed, or interpolated.

### Side Effects
- The new branch only calls `loadDocumentPreview(...)` or sets `state._pendingImportDocName`. Both are existing, idempotent operations. No tab switch is introduced (see Dependencies & Conflicts).

### Dependencies & Conflicts
- **Tab guard deliberately omitted:** `importFullDocResult` guards with `getActiveTabName() !== 'online'` and calls `switchToTab('local')` because it can fire from the online "Import Full Doc" button. The research clipboard import (`btn-import-research-doc-clipboard`) and folder `Import` buttons live in the local Docs view, so the user is already on the local tab. Decision: omit the tab switch — it would be a no-op or, worse, an unexpected tab jump. `handleLocalDocsReady` loads the preview regardless of active tab, so correctness is preserved either way.
- **`savedPath` availability:** The registry-write block (PlanningPanelProvider.ts:6270) itself guards on `writeResult.success && writeResult.savedPath`, signaling `savedPath` is not strictly guaranteed even on the non-error path. The webview-side `if (msg.savedPath)` guard handles a missing value gracefully (preview stays as-is, matching today's behavior).
- **macOS path equality:** Match uses exact string equality (`dataset.absolutePath === msg.savedPath`). Both sides originate from the same backend path-construction code, so they are byte-identical in practice — the working `importFullDocResult` sibling relies on the same assumption. No normalization added (would be speculative complexity).

## Dependencies

None. (`sess_` — no prior sessions block this work.)

## Adversarial Synthesis

**Key risks:** (1) `savedPath` is not strictly guaranteed on the success message; (2) the single `_pendingImportDocName` slot is shared with `importFullDocResult` and is not cleared on path-match failure. **Mitigations:** the `if (msg.savedPath)` guard degrades any missing/unmatched path to current behavior (no regression), and the shared-slot/path-match patterns are already shipped and proven in the sibling `importFullDocResult` handler, so no new logic risk is introduced. All identified failure modes degrade gracefully to "preview unchanged," never to data loss or a wrong-doc selection.

## Proposed Changes

### `src/services/PlanningPanelProvider.ts` — lines 6290–6294

**Context:** `_handleImportResearchDoc` success postMessage. `writeResult.savedPath` is in scope (populated by `writeContentToDocsDir` at line 6254, already referenced at 6283).

**Logic:** Forward the saved path so the webview can locate the new node.

**Implementation — Replace:**
```typescript
this._panel?.webview.postMessage({
    type: 'importResearchDocResult', 
    success: true, 
    docTitle: finalDocTitle 
});
```

**With:**
```typescript
this._panel?.webview.postMessage({
    type: 'importResearchDocResult',
    success: true,
    docTitle: finalDocTitle,
    savedPath: writeResult.savedPath
});
```

**Edge Cases:** If `writeResult.savedPath` is undefined, the field serializes to `undefined`/absent and the webview guard skips auto-nav. No throw, no regression.

### `src/webview/planning.js` — lines 3296–3316 (success branch of `importResearchDocResult`)

**Context:** The success branch currently flashes the button and sets status text but has no auto-navigation. The tree has NOT re-rendered yet when this handler fires (see Timing).

**Logic:** Mirror `importFullDocResult` (3237–3251): try to find the node now; if absent (the expected case), stash the path in `_pendingImportDocName` for `handleLocalDocsReady` to resolve post-rerender. Omit the tab switch (local-tab context only).

**Implementation:** After the existing success status/button logic (after the `researchStatusTimeout` block, before the closing `}` of `if (msg.success)`), add:

```javascript
if (msg.savedPath) {
    let found = null;
    const nodes = document.querySelectorAll('.tree-node');
    for (let i = 0; i < nodes.length; i++) {
        if (nodes[i].dataset.sourceId === 'local-folder' && nodes[i].dataset.absolutePath === msg.savedPath) {
            found = nodes[i];
            break;
        }
    }
    if (found) {
        loadDocumentPreview('local-folder', found.dataset.nodeId, found.dataset.name);
    } else {
        state._pendingImportDocName = msg.savedPath;
    }
}
```

**Edge Cases:**

| Scenario | Behaviour |
|----------|-----------|
| `writeResult.savedPath` is undefined (shouldn't happen given `writeResult.error` wasn't set, but the registry block at 6270 shows the codebase doesn't fully trust it) | `msg.savedPath` is falsy → the `if (msg.savedPath)` guard skips; preview stays as-is. No regression. |
| Import into a folder that is NOT the active workspace root | `_pendingImportDocName` is set; `handleLocalDocsReady` finds the node by absolute path regardless of workspace filter; preview loads correctly. |
| User imports a second doc before the first `localDocsReady` fires | Second import overwrites `_pendingImportDocName`; the most recently imported doc is auto-selected. Acceptable. |
| Cross-handler collision (full-doc import + research import in one render cycle) | Single shared slot, last-writer-wins; both candidates are valid imported docs. Acceptable, rare. |
| Duplicate content (same slug already exists, `writeContentToDocsDir` returns the existing path) | Same `savedPath` returned; the existing file is found and previewed. Correct. |
| Path-match failure (node never matches absolute path) | `_pendingImportDocName` persists until the next import overwrites it; preview stays as-is. Same tolerated behavior as shipped `importFullDocResult`. |

## Verification Plan

### Automated Tests

No automated test is added for this change (per session directive: tests run separately by the user). The logic is a thin reuse of the `importFullDocResult` pattern already exercised in practice. If regression coverage is desired later, a webview unit test could assert that an `importResearchDocResult` message with `savedPath` sets `state._pendingImportDocName` when no matching node exists.

### Manual Verification

1. Copy any markdown to clipboard.
2. Click "Import" on a folder in the Docs sidebar.
3. After the "Imported: …" flash, the preview pane should switch to the new doc without requiring a manual click.
4. Confirm the same behaviour from the top-level clipboard import button (if it also goes through `importResearchDocResult`).
5. Confirm no regression: previewing a doc, then importing, should not leave the preview on the old doc.

## Build Note

`dist/webview/planning.{html,js}` are webpack CopyPlugin outputs of `src/webview/`. Run `npm run compile` after editing `src/` for the change to take effect in the running extension.

---

**Recommendation:** Complexity 3 → **Send to Intern.**
