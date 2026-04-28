# Fix Hardcoded sourceId for Imported Docs

## Goal
Remove the hardcoded `'local-folder'` value for `dataset.sourceId` and `state.activeSource` when dealing with imported documents from online sources (ClickUp, Linear, Notion). Use the actual `doc.sourceId` from the imported doc data instead.

## Current Behavior
- In `handleImportedDocsReady`, imported doc wrappers always have `wrapper.dataset.sourceId = 'local-folder'` (line 1106)
- The click handler always sets `state.activeSource = 'local-folder'` (line 1133)
- This happens even for docs imported from ClickUp, Linear, or Notion
- Downstream operations (`fetchPreview`, `appendToPlannerPrompt`, `importFullDoc`, `setActivePlanningContext`, `fetchPageContent`) send the wrong `sourceId` to the backend

## Impact
- Backend receives `sourceId: 'local-folder'` when it should receive `sourceId: 'clickup'` (or `linear`, `notion`)
- This breaks source-specific operations like sync, preview refresh, and source-aware adapters
- The backend may try to use the local-folder adapter for online docs

## Desired Behavior
- `wrapper.dataset.sourceId` should be set to `doc.sourceId` (the actual source)
- `state.activeSource` should be set to `doc.sourceId` when clicking imported docs
- All downstream operations should use the correct source ID

## Changes Required

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`

#### MODIFY `handleImportedDocsReady` (around lines 1103-1148)

**Current code (line 1106):**
```javascript
wrapper.dataset.sourceId = 'local-folder';
```

**Change to:**
```javascript
wrapper.dataset.sourceId = doc.sourceId || 'local-folder';
```

**Current code (line 1133):**
```javascript
state.activeSource = 'local-folder';
```

**Change to:**
```javascript
state.activeSource = doc.sourceId || 'local-folder';
```

### Backward Compatibility
- The `|| 'local-folder'` fallback ensures that if `doc.sourceId` is somehow missing, the behavior remains as before
- Existing imported docs all have `sourceId` in their front-matter (extracted by `_handleFetchImportedDocs`), so this should be safe

## Edge Cases

1. **Legacy imported docs without sourceId:** The fallback to `'local-folder'` handles this gracefully
2. **Mixed selection:** When a user switches between local-folder docs and imported online docs, `state.activeSource` correctly reflects the actual source of the selected doc
3. **Sync operations:** The correct `sourceId` is now sent to `fetchPreview`, enabling proper sync behavior for imported online docs

## Verification

1. Import a doc from ClickUp
2. Click on the imported doc in the sidebar
3. Verify `state.activeSource` is `'clickup'` (can check via console.log or debugger)
4. Click "Export to ClickUp" button — should work correctly (uses correct adapter)
5. Click "Sync" — should sync with the correct remote source
6. Import a doc from local-folder
7. Click on it — `state.activeSource` should be `'local-folder'`
8. Verify no regressions for local-folder-only workflows

## Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js` — 2 lines changed (lines 1106 and 1133)

## Complexity
2 — Simple parameter change with clear fallback behavior
