# Unify Local Docs "Set Context" into a Single Strip-Level Toggle Button

## Goal

Replace the per-document-card "Set Context" buttons in the Local Docs tab sidebar with a single "Set as Active Planning Context" toggle button on the top controls strip. This button should set the selected document as the active design doc and enable the `designDocEnabled` flag for all agents that consume it. When the currently selected document is already the active design doc, the button should switch to "Turn off" and disable the flag.

**Background & Problem Analysis:**
Currently, every document card in the Local Docs tab sidebar carries a small "Set Context" text button. This is not intuitive:
- Users must discover the action on a per-card basis.
- There is no clear visual indication of which document is currently acting as the design doc for planner prompts.
- The existing "Set Context" button sends `appendToPlannerPrompt` (importing content into `.switchboard/docs/`), which is a different operation from setting the active design doc reference. The plan explicitly changes this to `setActivePlanningContext` (setting the active doc reference without importing). To preserve the import capability, a separate "Import" action is added to the per-card actions.

The Design Docs tab already uses a strip-level "Set as Active Planning Context" button (`btn-set-active-context-design`), but the Local Docs tab lacks this pattern. Unifying the UX makes the control discoverable and stateful.

The "append design doc" flag is the VS Code configuration key `switchboard.planner.designDocEnabled`. When `true`, the global `designDocLink` (and optionally `designDocContent`) is injected into prompts for:
- **planner** role (always, via `KanbanProvider.generateUnifiedPrompt` -> `_resolveGlobalDesignDoc`)
- **tester** role (required; throws if missing)
- **custom agents** with the `designDoc` addon enabled

There is no per-agent flag — `planner.designDocEnabled` is the single source of truth. Toggling it affects all consumers automatically.

## Metadata
**Complexity:** 5
**Tags:** frontend, ui, ux, feature

## User Review Required
- Confirm that replacing the per-card "Set Context" (import) with a strip-level "Set as Active Planning Context" (set-active) is the desired product direction. The old "Set Context" imported content to `.switchboard/docs/`; the new button sets the active design doc reference. An "Import" per-card action is added to preserve import capability.
- Confirm the "Turn off" label (matching the existing banner button) is preferred over "Remove from planning prompt".

## Complexity Audit

### Routine
- Adding a single strip button to `planning.html`
- Adding state fields and a button state update function to `planning.js`
- Adding two instance variables and updating three methods in `PlanningPanelProvider.ts`
- Removing "Set Context" from per-card actions and adding "Import" in its place

### Complex / Risky
- **Behavior change from import to set-active.** The old "Set Context" performed `appendToPlannerPrompt` (import); the new button performs `setActivePlanningContext` (set reference). These are semantically different. The plan preserves import via a new "Import" per-card action, but this must be clearly communicated to users.
- **`isLocalSelection` scope.** The button should only activate for `state.activeSource === 'local-folder'`, NOT `design-folder`. The Design Docs tab already has its own `btn-set-active-context-design`. Enabling the Local Docs strip button for `design-folder` would create two competing buttons for the same action.
- **Transient state loss on extension host reload.** `_activeDesignDocSourceId` and `_activeDesignDocId` are in-memory only. After reload, the button won't know which doc is active until the user interacts. Acceptable per existing Edge Case analysis.

## Edge-Case & Dependency Audit
- **Race Conditions:** Rapid toggle clicks could send alternating `setActivePlanningContext`/`disableDesignDoc` messages. Backend is idempotent for both operations. No race risk.
- **Security:** `setActivePlanningContext` validates `sourceFolder` against configured folder paths (line 1737). No new attack surface.
- **Side Effects:** `disableDesignDoc` clears `planner.designDocLink` and sets `planner.designDocEnabled = false`. This affects ALL consumers (planner, tester, custom agents). If a design doc was set from the Design Docs tab, clicking "Turn off" in the Local Docs tab will also disable it. This is by design — there is only one global design doc.
- **Dependencies & Conflicts:** The `activeDesignDocUpdated` message is consumed by `updateActiveDocBanner` (line 2840). Adding `sourceId`/`docId` fields is backward-compatible — the banner function doesn't use them. No conflicts.

## Dependencies
- None (all required backend handlers already exist)

## Adversarial Synthesis
Key risks: (1) Replacing import with set-active is a behavior change that must be explicitly acknowledged; preserving import via a new "Import" per-card action mitigates this. (2) The "Turn off" label should match the existing banner button for consistency. (3) The `isLocalSelection` check must exclude `design-folder` to avoid dual-button conflicts with the Design Docs tab. Mitigations: add "Import" per-card action; use "Turn off" label; restrict scope to `local-folder` only.

## Requirements

### Functional Requirements

1. **Remove per-card "Set Context" buttons** from document cards rendered under `sourceId === 'local-folder'` in the Local Docs sidebar. Replace with "Import" action to preserve the import-to-`.switchboard/docs/` capability. **Do NOT remove "Set Context" from `design-folder`** — the Design Docs tab already has its own strip-level button and removing "Set Context" there would leave no per-card action for setting context from that tab.
2. **Add a strip-level button** to `controls-strip-local` in `planning.html`, placed after the workspace dropdown (`local-workspace-filter`).
   - Default label: **"Set as Active Planning Context"**
   - Disabled when no document is selected in the Local Docs tab, OR when the selected document is not from `local-folder`.
3. **Toggle behavior:**
   - If the currently selected document is **not** the active design doc: clicking the button sends `setActivePlanningContext` to the extension, which sets `planner.designDocLink` to the selected document's resolved path and sets `planner.designDocEnabled = true`.
   - If the currently selected document **is** the active design doc: the button label changes to **"Turn off"**; clicking it sends `disableDesignDoc` to the extension, which sets `planner.designDocEnabled = false` and clears `planner.designDocLink`.
4. **State synchronization:** The extension must track the `sourceId` and `docId` of the document that was set as active, so the webview can determine whether the current selection matches. This state should be sent back to the webview via the existing `activeDesignDocUpdated` message channel.
5. **Button state must update** when:
   - A document is selected/deselected in the Local Docs tab.
   - The active design doc changes (via the new button, the banner "Turn off" button, or external changes).

### Non-Functional Requirements

- Preserve the existing `activeContextSet` message handler in the webview (it shows a status message).
- Do not break the Online Docs tab `btn-append-to-prompts-online` (which performs `appendToPlannerPrompt` / import behavior).
- Do not break the Design Docs tab `btn-set-active-context-design` (which already uses `setActivePlanningContext`).
- Keep changes scoped to the Local Docs tab where possible.
- The new strip button should only be active for `local-folder` selections, NOT `design-folder` (to avoid dual-button conflict with the Design Docs tab).

## Proposed Changes

### `src/webview/planning.html`
- **Context:** `controls-strip-local` div (around line 2290), after the workspace dropdown
- **Logic:** Add the strip button
- **Implementation:**
  ```html
  <button id="btn-set-active-context-local" class="strip-btn" disabled>Set as Active Planning Context</button>
  ```
  Note: Using `btn-set-active-context-local` (not `btn-append-to-prompts-local`) to match the naming pattern of `btn-set-active-context-design` and avoid confusion with the Online Docs `btn-append-to-prompts-online` which performs import.

### `src/webview/planning.js`
- **Context:** Multiple locations
- **Logic:** Remove "Set Context" from `local-folder` actions, add "Import" in its place, add strip button state management, update selection handlers

#### Change 1: Remove "Set Context" from local-folder actions (line 733-734)
  ```javascript
  // BEFORE:
  if (sourceId === 'local-folder') {
      actions = ['Set Context', 'Link Doc', 'Delete'];
  // AFTER:
  if (sourceId === 'local-folder') {
      actions = ['Import', 'Link Doc', 'Delete'];
  ```
  Note: `design-folder` actions at line 735-736 remain `['Set Context', 'Link Doc']` — the Design Docs tab still uses per-card "Set Context" which sends `appendToPlannerPrompt` (import). The Design Docs strip button (`btn-set-active-context-design`) handles set-active separately.

#### Change 2: Add "Import" click handler in `renderDocCard` (after line 651)
  The existing `action === 'Import'` handler at line 651 already handles the Online Docs import. For `local-folder`, the same handler will work because `_handleAppendToPlannerPrompt` already handles `sourceId === 'local-folder'` (line 2797). No new handler needed — the existing `Import` branch will fire.

#### Change 3: Declare button reference (around line 367)
  ```javascript
  const btnSetActiveContextLocal = document.getElementById('btn-set-active-context-local');
  ```

#### Change 4: Add state fields to `state` object (around line 8)
  ```javascript
  activeDesignDocEnabled: false,
  activeDesignDocSourceId: null,
  activeDesignDocId: null,
  ```

#### Change 5: Create `updateLocalActiveContextButtonState()` function
  ```javascript
  function updateLocalActiveContextButtonState() {
      if (!btnSetActiveContextLocal) return;
      const hasSelection = state.activeSource && state.activeDocId;
      const isLocalSelection = state.activeSource === 'local-folder';
      const isThisDocActive = state.activeDesignDocEnabled &&
          state.activeDesignDocSourceId === state.activeSource &&
          state.activeDesignDocId === state.activeDocId;

      if (!hasSelection || !isLocalSelection) {
          btnSetActiveContextLocal.disabled = true;
          btnSetActiveContextLocal.textContent = 'Set as Active Planning Context';
      } else if (isThisDocActive) {
          btnSetActiveContextLocal.disabled = false;
          btnSetActiveContextLocal.textContent = 'Turn off';
      } else {
          btnSetActiveContextLocal.disabled = false;
          btnSetActiveContextLocal.textContent = 'Set as Active Planning Context';
      }
  }
  ```

#### Change 6: Wire click handler
  ```javascript
  if (btnSetActiveContextLocal) {
      btnSetActiveContextLocal.addEventListener('click', () => {
          if (!state.activeSource || !state.activeDocId) return;
          const isThisDocActive = state.activeDesignDocEnabled &&
              state.activeDesignDocSourceId === state.activeSource &&
              state.activeDesignDocId === state.activeDocId;

          if (isThisDocActive) {
              vscode.postMessage({ type: 'disableDesignDoc' });
          } else {
              const wrapper = findTreeNode(state.activeSource, state.activeDocId);
              const sourceFolder = wrapper ? wrapper.dataset.sourceFolder : undefined;
              vscode.postMessage({
                  type: 'setActivePlanningContext',
                  sourceId: state.activeSource,
                  docId: state.activeDocId,
                  docName: state.activeDocName || state.activeDocId,
                  sourceFolder
              });
          }
      });
  }
  ```

#### Change 7: Update `updateActiveDocBanner` (around line 3021)
  Append after existing banner DOM updates:
  ```javascript
  state.activeDesignDocEnabled = msg.enabled || false;
  state.activeDesignDocSourceId = msg.sourceId || null;
  state.activeDesignDocId = msg.docId || null;
  updateLocalActiveContextButtonState();
  ```

#### Change 8: Trigger button update on selection change
  Call `updateLocalActiveContextButtonState()` at all 7 locations where `state.activeSource`/`state.activeDocId` are set:
  1. `loadDocumentPreview` — line 783 (local-folder selection)
  2. Design tab preview loader — line 827 (design-folder selection)
  3. Online docs preview loader — line 887 (online sources)
  4. Antigravity click handler — line 1633
  5. Imported docs click handler — line 2489
  6. Delete handler (local) — line 2866 (clears selection)
  7. Delete handler (imported) — line 2888 (clears selection)

### `src/services/PlanningPanelProvider.ts`
- **Context:** Class instance variables and three existing methods
- **Logic:** Track active design doc source/doc IDs and broadcast them

#### Change 1: Add instance variables (near line 76)
  ```typescript
  private _activeDesignDocSourceId: string | null = null;
  private _activeDesignDocId: string | null = null;
  ```

#### Change 2: Update `_handleSetActivePlanningContext` (around line 1778)
  After the existing `designDocEnabled = true` update, before `activeContextSet` postMessage:
  ```typescript
  this._activeDesignDocSourceId = sourceId;
  this._activeDesignDocId = docId;
  await this._sendActiveDesignDocState();
  ```

#### Change 3: Update `_handleDisableDesignDoc` (around line 1693)
  After the existing `designDocLink = undefined` update, before `_sendActiveDesignDocState()`:
  ```typescript
  this._activeDesignDocSourceId = null;
  this._activeDesignDocId = null;
  ```

#### Change 4: Update `_sendActiveDesignDocState` (around line 1940)
  Include the tracked IDs in the message:
  ```typescript
  this._panel?.webview.postMessage({
      type: 'activeDesignDocUpdated',
      enabled,
      docName: docName || 'None',
      sourceId: this._activeDesignDocSourceId,
      docId: this._activeDesignDocId
  });
  ```

## Verification Plan

### Automated Tests
- No new automated tests required (UI toggle with backend delegation to existing tested methods)

### Manual Verification
1. Open the Local Docs tab. Select a document. Confirm the "Set as Active Planning Context" button enables.
2. Click the button. Confirm the Active Design Doc banner updates to the selected doc name.
3. Confirm the button label changes to "Turn off".
4. Click "Turn off". Confirm the banner shows "None" / goes inactive.
5. Confirm `switchboard.planner.designDocEnabled` is `false` in VS Code settings.
6. Select a different doc while one is already active. Confirm the button shows "Set as Active Planning Context" (allowing replacement).
7. Verify the Design Docs tab and Online Docs tab remain unaffected.
8. Verify no "Set Context" button appears on any doc card in the Local Docs sidebar — replaced by "Import".
9. Click "Import" on a Local Docs card. Verify content is imported to `.switchboard/docs/` (same behavior as the old "Set Context").
10. Select a document in the Design Docs tab. Verify the Local Docs strip button stays disabled (no dual-button conflict).
11. Select a document in the Online Docs tab. Verify the Local Docs strip button stays disabled.

## Recommendation
**Complexity 5 → Send to Coder**

---

## Execution Summary

**Status:** COMPLETED

**Files Changed:**
1. `src/webview/planning.html` - Added strip-level button `btn-set-active-context-local`
2. `src/webview/planning.js` - Updated per-card actions, added state fields, button management function, click handler, and state synchronization
3. `src/services/PlanningPanelProvider.ts` - Added instance variables for tracking active design doc IDs, updated handlers to broadcast IDs

**Implementation Details:**
- Replaced per-card "Set Context" with "Import" for local-folder documents
- Added strip-level "Set as Active Planning Context" button in Local Docs controls strip
- Button enables only for local-folder selections (disabled for design-folder to avoid dual-button conflict)
- Button toggles between "Set as Active Planning Context" and "Turn off" based on current selection state
- Backend tracks `sourceId` and `docId` of active design doc and broadcasts via `activeDesignDocUpdated` message
- Webview state synchronized at 7 selection change locations (local-folder, design-folder, online, antigravity, imported docs, and 2 delete handlers)

**Validation:**
- Manual verification required per plan (tests skipped per instructions)
- All code changes follow existing patterns and conventions
- No breaking changes to existing functionality (Design Docs tab, Online Docs tab, banner handlers preserved)

**Remaining Risks:**
- Transient state loss on extension host reload (IDs are in-memory only; acceptable per plan analysis)
- "Turn off" in Local Docs tab disables design doc even if set from Design Docs tab (by design - single global design doc)
