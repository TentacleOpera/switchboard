# Doc Import Does Not Refresh in planning.html Docs Tab

## Goal

When a user imports a doc (from an online source like ClickUp, Linear, or Notion) into the planning.html **Docs tab**, the imported doc should appear immediately in the sidebar. Currently it does not — the user has to manually re-trigger a fetch to see it. The import should trigger an immediate refresh of the imported-docs list.

### Core problem & background

The Docs tab in planning.html has two doc sources: **local docs** (files on disk) and **imported docs** (online sources synced into a local SQLite store). When a user clicks "Import" on an online doc, the backend (`PlanningPanelProvider.ts`) correctly writes the doc to the database and sends two messages back to the webview: `importFullDocResult` (success confirmation) and `importedDocsReady` (the refreshed imported-docs list).

The webview handler `handleImportedDocsReady` (`planning.js:3420`) receives the `importedDocsReady` message and tries to render the docs into a container element with id `imported-docs-list`. **However, no element with id `imported-docs-list` exists anywhere in `planning.html`.** The function hits an early return at line 3428 (`if (!importedDocsContainer) return;`) and the docs are silently discarded — they never render.

The local docs tree *does* refresh because the backend also calls `_sendLocalDocsReady()` (`PlanningPanelProvider.ts:7767`), which triggers `handleLocalDocsReady` → `rerenderUnifiedDocs()` (`planning.js:2785-2796`). But the imported-docs section (for online sources) is a separate UI section that never appears because its container element is missing.

### Root cause

The `#imported-docs-list` container element was never added to the `planning.html` DOM. The `handleImportedDocsReady` function in `planning.js` was written to populate this element, but the corresponding HTML element was never created — a wiring gap between the JS handler and the HTML markup.

The existing pattern in the same file (`renderAntigravitySessions` at `planning.js:2712`) dynamically creates its container element (`#antigravity-section`) and appends it to `#tree-pane` from **within** `renderUnifiedDocs` (called at `planning.js:2639`). This is the critical distinction: `renderAntigravitySessions` survives `renderUnifiedDocs`'s `treePane.innerHTML = ''` wipe (line 2252) because it is re-invoked as part of the unified render cycle. The imported-docs handler, by contrast, runs as a **separate message handler outside the render cycle** — any container it creates would be destroyed on the next `rerenderUnifiedDocs()` call (workspace filter change, local docs update, online docs update, etc.).

**The fix must integrate imported-docs rendering into `renderUnifiedDocs`**, following the same pattern as `renderAntigravitySessions`, rather than relying on a static or dynamically-created HTML element that lives outside the render cycle.

## Metadata

- **Tags:** [frontend, bugfix, ui, docs]
- **Complexity:** 4

## User Review Required

No — this is a straightforward bugfix with a clear root cause. The fix follows an established pattern (`renderAntigravitySessions`) already in the same file. No product-level decisions or trade-offs need user input.

## Complexity Audit

### Routine
- Storing the imported docs payload in `state._lastImportedDocs` when `handleImportedDocsReady` receives it, so it can be re-rendered on subsequent `rerenderUnifiedDocs()` calls.
- Populating `state.importedDocs` Map (existing logic at `planning.js:3497-3522`) — this is already correct and used by `renderUnifiedDocs` for local-doc dedup (lines 2493-2495, 2502-2504).
- Adding a call to `renderImportedDocsSection()` inside `renderUnifiedDocs`, after the online docs section and before the Antigravity section (around line 2637), mirroring the `renderAntigravitySessions` call at line 2639.
- Adding a minimal CSS rule for `.imported-docs-section` spacing (optional, only if not already defined).

### Complex / Risky
- **Extracting the rendering logic** (lines 3432-3607 of `handleImportedDocsReady`) into a standalone `renderImportedDocsSection(docs)` function. This is ~175 lines of rendering code with grouping, sorting, and card creation. The extraction must preserve all existing behavior: source grouping, parent-doc subheaders, recency sorting, dedup label logic, action buttons (Set Context, Link Doc, Sync, Delete), and the inline Edit gate at the end (lines 3601-3607).
- **Ensuring `state.importedDocs` Map is populated before `rerenderUnifiedDocs` runs.** The Map is used for local-doc dedup during `renderUnifiedDocs`. If `handleImportedDocsReady` clears and repopulates the Map, then calls `rerenderUnifiedDocs()`, the dedup will work correctly. But if a `localDocsReady` message arrives before `importedDocsReady` (which is the normal backend ordering during import), the first `rerenderUnifiedDocs()` call will use stale Map data. This is the **existing behavior** and is not a regression — the Map is only used to skip local docs that have already been imported, and stale data means a just-imported doc might briefly appear in both the local tree and the imported section until `importedDocsReady` arrives.

## Edge-Case & Dependency Audit

- **`renderUnifiedDocs` wipes `#tree-pane` (CRITICAL):** `renderUnifiedDocs` does `treePane.innerHTML = ''` at line 2252. Any element appended to `#tree-pane` by an external handler (like `handleImportedDocsReady`) will be destroyed on the next unified re-render. This is why the fix must integrate into `renderUnifiedDocs` rather than appending from outside. The `renderAntigravitySessions` function survives because it is called from *within* `renderUnifiedDocs` (line 2639).
- **Container already exists (future-proofing):** If a future change adds `#imported-docs-list` to the HTML, the `renderImportedDocsSection` function should check for an existing element and clear/reuse it rather than creating a duplicate. The `renderAntigravitySessions` pattern (remove existing, then create fresh) at lines 2715-2716 is the proven approach.
- **Empty docs list:** When `docs` is empty or null, the function should show "No imported documents" in the container. This logic already exists at `planning.js:3432-3435` and will work once the container is created within the render cycle.
- **Container ordering in `#tree-pane`:** The imported-docs section should appear after the local docs section and online docs section, and before the Antigravity sessions section. Place the `renderImportedDocsSection()` call in `renderUnifiedDocs` after the online docs block (ends ~line 2636) and before the Antigravity block (line 2638-2640).
- **`state.importedDocs` Map lifecycle:** `handleImportedDocsReady` currently calls `state.importedDocs.clear()` at line 3425 before repopulating. This must be preserved when refactoring — clear the Map, repopulate from the new docs payload, store the raw docs in `state._lastImportedDocs`, then call `rerenderUnifiedDocs()`.
- **Delete flow:** The backend delete handler (`PlanningPanelProvider.ts:2761`) calls `_handleFetchImportedDocs` (sends `importedDocsReady`) but does NOT call `_sendLocalDocsReady`. So after a delete, only `importedDocsReady` arrives. With the integrated fix, `handleImportedDocsReady` will store the updated docs and call `rerenderUnifiedDocs()`, which will correctly re-render the imported section (and the rest of the tree from cached state). No separate `localDocsReady` is needed.
- **File watcher refresh:** The docs folder watcher (`PlanningPanelProvider.ts:732-742`) calls `_handleFetchImportedDocs` on file create/delete/change (with a 2-second debounce guard). This sends `importedDocsReady` without a paired `localDocsReady`. With the integrated fix, this will correctly trigger a re-render of the imported docs section.
- **No confirmation dialogs** (house rule, `CLAUDE.md`): No confirm gates involved — this is a rendering fix.
- **Dependencies:** None. No other plan blocks or is blocked by this.

## Dependencies

None — this is a self-contained frontend rendering fix.

## Adversarial Synthesis

Key risks: (1) The original plan's approach of dynamically creating `#imported-docs-list` and appending to `#tree-pane` from outside the render cycle would be wiped by `renderUnifiedDocs`'s `treePane.innerHTML = ''` on any subsequent re-render, causing imported docs to vanish on workspace filter changes, search, or local-doc updates. (2) Extracting ~175 lines of rendering logic into a standalone function risks subtle behavior changes if not done carefully. Mitigations: integrate rendering into `renderUnifiedDocs` following the proven `renderAntigravitySessions` pattern; preserve all existing rendering logic verbatim during extraction; the `state.importedDocs` Map lifecycle (clear → repopulate → re-render) must be maintained.

## Proposed Changes

### Approach A (Original plan — insufficient, kept for reference)

> **Note:** This approach was the original proposal. It fixes the immediate bug but introduces a fragility issue: the dynamically-created `#imported-docs-list` container would be destroyed by `renderUnifiedDocs`'s `treePane.innerHTML = ''` (line 2252) on any subsequent re-render. **Approach B below is the recommended fix.**

### 1. `src/webview/planning.js` — store imported docs in state and trigger unified re-render

In `handleImportedDocsReady` (line 3420), replace the direct-rendering approach with a store-and-re-render approach:

**Current code** (`planning.js:3420-3430`):
```javascript
function handleImportedDocsReady(msg) {
    const { docs } = msg;

    console.log('[handleImportedDocsReady] Received docs:', docs);

    state.importedDocs.clear();

    const importedDocsContainer = document.getElementById('imported-docs-list');
    if (!importedDocsContainer) return;

    importedDocsContainer.innerHTML = '';
```

**Replace with:**
```javascript
function handleImportedDocsReady(msg) {
    const { docs } = msg;

    console.log('[handleImportedDocsReady] Received docs:', docs);

    state.importedDocs.clear();

    // Store the raw docs payload so renderUnifiedDocs can re-render
    // the imported-docs section on every unified re-render cycle.
    state._lastImportedDocs = docs || [];

    // Trigger a unified re-render, which will call renderImportedDocsSection()
    // as part of the render cycle (same pattern as renderAntigravitySessions).
    rerenderUnifiedDocs();
```

The `state.importedDocs` Map population logic (lines 3497-3522 in the current function) and the inline Edit gate (lines 3601-3607) must be preserved — they should move into `renderImportedDocsSection` or remain in `handleImportedDocsReady` before the `rerenderUnifiedDocs()` call. See step 3 for details.

### 2. `src/webview/planning.js` — extract rendering logic into `renderImportedDocsSection(docs)`

Extract the rendering logic from `handleImportedDocsReady` (current lines 3432-3607) into a new standalone function `renderImportedDocsSection(docs)` that:

1. Creates (or reuses) a `#imported-docs-list` container div with class `imported-docs-section`.
2. Appends it to `#tree-pane` (the closure-scoped `treePane` variable from line 1568).
3. Renders the docs grouped by source and parent doc, with all existing logic preserved:
   - Empty state: "No imported documents" (current lines 3432-3435)
   - Recency sorting helpers (current lines 3438-3446)
   - Source/parent grouping (current lines 3448-3467)
   - Source recency sort (current line 3470)
   - Source header rendering with `SOURCE_DISPLAY_NAMES` (current lines 3479-3483)
   - Parent doc subheader for multi-page groups (current lines 3489-3494)
   - `state.importedDocs` Map population (current lines 3497-3522) — **must remain**
   - Display label dedup logic (current lines 3524-3539)
   - Action buttons: Set Context, Link Doc, Sync, Delete (current lines 3541-3545)
   - `renderDocCard` call with click/delete/sync handlers (current lines 3547-3596)
   - Inline Edit gate for active doc (current lines 3601-3607)

**Function signature:**
```javascript
function renderImportedDocsSection(docs) {
    if (!treePane) return;

    // Remove existing section if present (same pattern as renderAntigravitySessions)
    const existing = document.getElementById('imported-docs-list');
    if (existing) { existing.remove(); }

    const importedDocsContainer = document.createElement('div');
    importedDocsContainer.id = 'imported-docs-list';
    importedDocsContainer.className = 'imported-docs-section';
    treePane.appendChild(importedDocsContainer);

    // ... all rendering logic from current lines 3432-3607 ...
    // (empty state, grouping, sorting, card rendering, state.importedDocs population)
}
```

**Important:** The `state.importedDocs.clear()` call must NOT be inside `renderImportedDocsSection` — it should remain in `handleImportedDocsReady` before `rerenderUnifiedDocs()` is called. This is because `renderUnifiedDocs` uses `state.importedDocs` for local-doc dedup (lines 2493-2495, 2502-2504), and the Map must be freshly populated from the new payload before the unified render begins. The Map population (current lines 3497-3522) should happen inside `renderImportedDocsSection` as part of the render, which is safe because `renderImportedDocsSection` is called during the `renderUnifiedDocs` cycle after local docs have already been rendered.

**Wait — correction:** The Map population at lines 3497-3522 happens *during* doc card rendering, which is after the local docs section has already been rendered in `renderUnifiedDocs`. This means the dedup check at lines 2493-2495 (which runs during local docs rendering) would use the *previous* Map state. This is the **existing behavior** and is acceptable — the Map is populated from the previous `importedDocsReady` message, and the current message's data populates it for the *next* render. The sequence is:
1. `handleImportedDocsReady` clears Map, stores docs in `state._lastImportedDocs`, calls `rerenderUnifiedDocs()`
2. `renderUnifiedDocs` renders local docs (uses stale Map for dedup — same as today)
3. `renderUnifiedDocs` calls `renderImportedDocsSection(state._lastImportedDocs)` which populates the Map with fresh data
4. Next `rerenderUnifiedDocs()` call will use the fresh Map

To avoid this staleness, the Map population can be moved to `handleImportedDocsReady` before `rerenderUnifiedDocs()`:

```javascript
function handleImportedDocsReady(msg) {
    const { docs } = msg;
    state.importedDocs.clear();
    state._lastImportedDocs = docs || [];

    // Pre-populate the dedup Map so renderUnifiedDocs uses fresh data
    if (docs && docs.length > 0) {
        docs.forEach(doc => {
            if (doc.sourceId === 'local-folder') return; // Skip local-folder
            state.importedDocs.set(doc.docName, { sourceId: doc.sourceId, docId: doc.docId, docName: doc.docName, slugPrefix: doc.slugPrefix, canSync: doc.canSync });
            state.importedDocs.set(doc.slugPrefix, { sourceId: doc.sourceId, docId: doc.docId, docName: doc.docName, slugPrefix: doc.slugPrefix, canSync: doc.canSync });
            if (doc.docId) {
                state.importedDocs.set(doc.docId, { sourceId: doc.sourceId, docId: doc.docId, docName: doc.docName, slugPrefix: doc.slugPrefix, canSync: doc.canSync });
            }
        });
    }

    rerenderUnifiedDocs();
}
```

Then `renderImportedDocsSection` would NOT re-populate the Map (it's already populated). This is the cleaner approach — it ensures the dedup Map is fresh before the unified render begins.

### 3. `src/webview/planning.js` — call `renderImportedDocsSection` from within `renderUnifiedDocs`

In `renderUnifiedDocs` (line 2249), add a call to `renderImportedDocsSection` after the online docs section and before the Antigravity section. Insert around line 2637 (after the online docs `forEach` block ends at line 2635, before the Antigravity check at line 2638):

**Current code** (`planning.js:2636-2640`):
```javascript
        });
        
        if (filterSet.has('antigravity') && state._lastLocalDocsMsg) {
            renderAntigravitySessions(state._lastLocalDocsMsg.antigravitySessions || [], state._lastLocalDocsMsg.antigravityEnabled || false);
        }
```

**Insert before the Antigravity check:**
```javascript
        });

        // Render imported docs section (online docs that have been imported to local store)
        if (state._lastImportedDocs) {
            renderImportedDocsSection(state._lastImportedDocs);
        }
        
        if (filterSet.has('antigravity') && state._lastLocalDocsMsg) {
            renderAntigravitySessions(state._lastLocalDocsMsg.antigravitySessions || [], state._lastLocalDocsMsg.antigravityEnabled || false);
        }
```

This mirrors the `renderAntigravitySessions` pattern exactly — both are called from within `renderUnifiedDocs` after the main content sections, and both create/append their containers to `treePane`.

### 4. `src/webview/planning.js` — add `state._lastImportedDocs` initialization

Add `_lastImportedDocs: null` to the `state` object initialization (near line 17 where `importedDocs: new Map()` is declared):

```javascript
importedDocs: new Map(), // slugPrefix -> { sourceId, docId, docName }
_lastImportedDocs: null, // raw docs array from last importedDocsReady message
```

### 5. `src/webview/planning.html` — add CSS for `.imported-docs-section` (optional)

If the `.imported-docs-section` class is not already defined in the CSS, add a minimal style rule near the existing docs-tab styles to ensure the section has proper spacing:

```css
.imported-docs-section {
    margin-top: 8px;
}
```

If the class is already defined or the section renders acceptably without it, this step can be skipped.

## Verification Plan

### Automated Tests

No automated tests required — this is a webview rendering fix verified through manual UI testing.

### Manual Verification

1. Open the planning panel in VS Code (Switchboard extension).
2. Navigate to the Docs tab.
3. Import a doc from an online source (ClickUp, Linear, or Notion).
4. **Verify:** The imported doc appears immediately in the sidebar after the import completes — no manual refresh required.
5. Import a second doc from a different source.
6. **Verify:** Both docs appear, grouped by source.
7. Delete an imported doc (if the UI supports it) or clear the docs.
8. **Verify:** The list updates to show "No imported documents" or removes the deleted doc.
9. Switch away from the Docs tab and back.
10. **Verify:** The imported docs list persists and re-renders correctly.
11. **Re-render survival test (critical):** With imported docs visible, change the workspace filter dropdown.
12. **Verify:** The imported docs section survives the re-render and remains visible.
13. **Re-render survival test 2:** With imported docs visible, type in the docs search box.
14. **Verify:** The imported docs section survives the search filter re-render.
15. **Re-render survival test 3:** With imported docs visible, click "Manage Folders" then close the modal (triggers a local docs refresh).
16. **Verify:** The imported docs section survives the local docs refresh.

### Recommendation

Complexity 4 → **Send to Coder**

## Review Results (2026-06-29)

### Stage 1: Adversarial Findings

| # | Severity | Finding | Location |
|---|----------|---------|----------|
| 1 | NIT | Lost explanatory comment during Map population move — the `// Online docs are selected from the online tree by their remote docId...` comment was dropped when the Map population logic was moved from `renderImportedDocsSection` to `handleImportedDocsReady`. House rule violation (CLAUDE.md: do not remove comments). | `planning.js:3443-3445` (was at old lines 3497-3522) |
| 2 | NIT | No filter gating on imported docs section — renders unconditionally when `state._lastImportedDocs` is truthy, ignoring `filterSet`. All other sections in `renderUnifiedDocs` respect the source filter. Plan does not require filter gating, so not a plan violation. Deferrable. | `planning.js:2640` |
| 3 | NIT | Redundant `treePane` null check in `renderImportedDocsSection` — `renderUnifiedDocs` already guards at line 2251. Harmless; matches `renderAntigravitySessions` pattern. Kept for consistency. | `planning.js:3455` |

### Stage 2: Balanced Synthesis

- **Fix now:** Finding #1 — restored the lost comment at the new Map population site in `handleImportedDocsReady`.
- **Defer:** Finding #2 — filter gating is a future enhancement, not a plan requirement.
- **Keep:** Finding #3 — redundant check matches the established `renderAntigravitySessions` pattern.

No CRITICAL or MAJOR findings. The implementation is a faithful execution of the plan's "cleaner approach."

### Code Fixes Applied

1. **`src/webview/planning.js:3443-3445`** — Restored the explanatory comment for the `docId` Map key that was lost during the Map population move from `renderImportedDocsSection` to `handleImportedDocsReady`.

### Files Changed (by implementation)

- `src/webview/planning.js` — Added `state._lastImportedDocs` initialization (line 18); added `renderImportedDocsSection` call in `renderUnifiedDocs` (lines 2639-2642); refactored `handleImportedDocsReady` to store-and-re-render pattern with pre-populated dedup Map (lines 3426-3452); extracted `renderImportedDocsSection` standalone function (lines 3456-3617); removed Map population from card rendering loop.
- `src/webview/planning.html` — No changes needed; `.imported-docs-section` CSS already existed at line 1465.

### Files Changed (by review)

- `src/webview/planning.js` — Restored lost comment at lines 3443-3445.

### Verification Results

- **Syntax check:** `node -c src/webview/planning.js` — passed (exit 0).
- **Compilation:** Skipped per session instructions.
- **Tests:** Skipped per session instructions; manual UI verification steps remain in the Verification Plan above.
- **Plan conformance:** All 5 proposed changes verified against actual code:
  1. ✅ `state._lastImportedDocs` initialization (line 18)
  2. ✅ `handleImportedDocsReady` store-and-re-render with pre-populated Map (lines 3426-3452)
  3. ✅ `renderImportedDocsSection` extracted as standalone function (lines 3456-3617)
  4. ✅ Called from within `renderUnifiedDocs` after online docs, before Antigravity (lines 2639-2642)
  5. ✅ CSS for `.imported-docs-section` already present in `planning.html:1465`

### Remaining Risks

1. **Filter inconsistency (deferred):** The imported docs section ignores `filterSet` and always renders when `state._lastImportedDocs` is truthy. If a user filters to a single source, imported docs from all sources still appear. This is consistent with the plan's intent but inconsistent with the filter pattern used by all other sections. Low impact — file as a future enhancement.
2. **Manual verification pending:** The 16-step manual verification checklist has not been executed in this session. The user should run through it to confirm the UI behavior.
