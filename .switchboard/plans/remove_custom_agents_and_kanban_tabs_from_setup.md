# Remove Custom Agents and Kanban Tabs from setup.html

## Goal

Remove the redundant "Custom Agents" and "Kanban" tabs from `setup.html` since both configuration surfaces now exist in `kanban.html`, eliminating dual-source-of-truth confusion and maintenance overhead while preserving autosave data round-tripping.

## Metadata

- **Tags:** [frontend, UI, UX]
- **Complexity:** 4

## User Review Required

- Confirm that no external code paths call `openSetupPanel('custom-agents')` or `openSetupPanel('kanban')` — verified: no such calls exist in the TypeScript codebase.
- Confirm the regression test update strategy: redirect DOM assertions to `kanban.html` rather than removing them entirely, to maintain coverage.

## Complexity Audit

### Routine
- Remove two tab buttons from `.tab-nav` (lines 536-537)
- Remove `#custom-agents-fields` tab content block (lines 589-652)
- Remove `#kanban-structure-fields` tab content block (lines 655-664)
- Remove `#kanban-column-modal` modal overlay (lines 1190-1210)
- Remove dead CSS rules (lines 46-68, 187-236)
- Remove dead DOM element references (lines 1251-1264)
- Remove dead event listeners (lines 3522-3535)
- Remove dead variable declarations (`editingCustomAgentId`, `editingKanbanColumnId`, `draggedKanbanStructureId`)
- Remove `tabIdMap` entries for removed tabs (lines 1420-1421)
- Remove tab load callbacks for removed tabs (lines 1508-1516)
- Update regression test assertions
- Rebuild dist

### Complex / Risky
- Hydration handler cleanup: `case 'customAgents'` (line 4179) and `case 'kanbanStructure'` (line 4195) currently call render functions that will be deleted. Must trim handlers to only update state variables while preserving round-trip data integrity.
- Autosave clobbering: if `collectSetupSavePayload()` stops sending `customAgents` or `customKanbanColumns`, the next autosave from `setup.html` will erase data edited in `kanban.html`.

## Edge-Case & Dependency Audit

- **Race Conditions:** If `setup.html` autosave fires while `kanban.html` is editing custom agents, the setup panel will round-trip the last-hydrated values (not the in-progress edit). This is existing behavior and unchanged by this plan.
- **Security:** No security implications — removing UI tabs does not expose new attack surface.
- **Side Effects:** The `getCustomVisibleAgentsPatch()` function (line 2573) reads `lastCustomAgents` to build the `visibleAgents` patch in `collectSetupSavePayload()`. This must continue to work after removing the render functions. The state variable `lastCustomAgents` is preserved, so this is safe.
- **Dependencies & Conflicts:** `kanban.html` has its own independent implementation of custom agent management and kanban structure editing. No shared code between the two webviews — they communicate only through the extension backend (`SetupPanelProvider.ts` / `TaskViewerProvider.ts`).

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) Hydration handlers call soon-to-be-deleted render functions — must trim handlers to state-only updates. (2) Autosave clobbering if `collectSetupSavePayload` drops round-trip fields. (3) Dead code left behind (`BUILT_IN_KANBAN_ASSIGNABLE_AGENTS`, `reorderVisibleKanbanStructure`) if not explicitly listed for removal. Mitigations: explicit handler cleanup in Step 6, preserved state variables and payload fields, comprehensive dead-code removal list.

## Context

The `setup.html` webview currently contains redundant "Custom Agents" and "Kanban" tabs. Both of these configuration surfaces now exist in `kanban.html` (under the Agents and Setup tabs respectively). Keeping them in `setup.html` creates maintenance overhead and a confusing dual-source-of-truth for users.

## Files to Modify

- `src/webview/setup.html`
- `src/test/kanban-custom-column-management-regression.test.js`
- `dist/webview/setup.html` (rebuild via webpack)

## Proposed Changes

### src/webview/setup.html

#### Step 1. Remove Tab Buttons from Navigation

Remove the two tab buttons from the `.tab-nav` container (lines 536-537):

```html
<button class="tab-btn" data-tab="custom-agents" role="tab" aria-selected="false">Custom Agents</button>
<button class="tab-btn" data-tab="kanban" role="tab" aria-selected="false">Kanban</button>
```

#### Step 2. Remove Custom Agents Tab Content

Remove the entire `#custom-agents-fields` `.tab-content` block (lines 589-652). This includes:
- `#custom-agent-list`
- `#custom-agent-form` inline form with all inputs (name, command, prompt, drag-drop mode, kanban checkbox, prompt add-ons)
- `#btn-add-custom-agent` button

#### Step 3. Remove Kanban Tab Content

Remove the entire `#kanban-structure-fields` `.tab-content` block (lines 655-664). This includes:
- `#btn-add-kanban-column` and `#btn-restore-kanban-defaults` buttons
- `#kanban-structure-list`
- Hint text about dragging columns

#### Step 4. Remove Kanban Column Modal

Remove the `#kanban-column-modal` modal overlay HTML block (lines 1190-1210). This modal is only opened from the Kanban tab in `setup.html` and is not used by any other tab.

#### Step 5. Remove Dead CSS

Remove CSS rules that are only used by the deleted tabs (lines 46-68, 187-236):
- `.setup-inline-form` and `.setup-inline-form-title` (lines 46-68, only used by custom agent inline form)
- `.kanban-structure-list` (line 187)
- `.kanban-structure-item` and variants (`.is-fixed`, `.drag-over`) (lines 193-210)
- `.kanban-structure-handle`, `.kanban-structure-lock` (lines 212-220)
- `.kanban-structure-item-label` (lines 222-227)
- `.kanban-structure-item-kind` (lines 229-236)

> **Note:** Do NOT remove `.modal-overlay`, `.modal-card`, `.modal-title`, `.modal-label`, `.modal-input`, `.modal-textarea`, or `.checkbox-label` — these are reused by other tabs (e.g., custom prompts modal, integration modals).

#### Step 6. Remove Dead JavaScript

In the `<script>` block of `setup.html`, remove all code that is exclusively used by the deleted tabs. **Keep** the state variables and hydration logic that support `collectSetupSavePayload()` round-tripping.

**Keep (required for autosave round-tripping):**
- `let lastCustomAgents = []` (line 1281)
- `let lastCustomKanbanColumns = []` (line 1282)
- `let lastKanbanStructure = []` (line 1283)
- `syncDerivedKanbanOrdersFromStructure()` (line 1948) — called from `collectSetupSavePayload()`
- `getPersistedCustomKanbanColumns()` (line 1963) — called from `collectSetupSavePayload()`
- Hydration handlers for `message.type === 'customAgents'` and `message.type === 'kanbanStructure'` (lines 4179-4213) — but **trim render calls** (see below)

**Remove — DOM element references (lines 1251-1264):**
- `customAgentList`, `customAgentNameInput`, `customAgentCommandInput`, `customAgentPromptInput`, `customAgentDragDropModeInput`, `customAgentKanbanInput`, `customAgentError`
- `kanbanColumnModal`, `kanbanColumnLabelInput`, `kanbanColumnAssignedAgentInput`, `kanbanColumnTriggerPromptInput`, `kanbanColumnDragDropModeInput`, `kanbanColumnError`
- `kanbanStructureList`

**Remove — Functions:**
- `openKanbanColumnModal()` (line 2019)
- `closeKanbanColumnModal()` (line 2030)
- `saveKanbanColumnDraft()` (line 2036)
- `saveCustomAgentDraft()` (line 2083)
- `syncLocalKanbanStructureWithCustomAgents()` (line 2165)
- `getRenderableKanbanStructure()` (line 2225)
- `reorderVisibleKanbanStructure()` (line 2262) — only called from drag handler inside `renderKanbanStructureList()`
- `renderKanbanStructureList()` (line 2303)
- `renderKanbanAssignedAgentOptions()` (line 1932)
- `renderCustomAgentConfigList()` (line 2440)
- `showInlineCustomAgentForm()` (line 1978)
- `hideInlineCustomAgentForm()` (line 2013)

**Remove — Constants:**
- `BUILT_IN_KANBAN_ASSIGNABLE_AGENTS` (line 1387) — only used by `renderKanbanAssignedAgentOptions()` which is being removed

**Remove — Variables:**
- `editingCustomAgentId` (line 1276)
- `editingKanbanColumnId` (line 1277)
- `draggedKanbanStructureId` (line 1373)

**Remove — Tab activation entries (lines 1508-1516):**
- `'custom-agents'` callback in `tabLoadCallbacks` (posts `getCustomAgents`, `getVisibleAgents`)
- `'kanban'` callback in `tabLoadCallbacks` (posts `getVisibleAgents`, `getCustomAgents`, `getKanbanStructure`)

**Remove — `tabIdMap` entries (lines 1420-1421):**
- `'custom-agents-fields': 'custom-agents'`
- `'kanban-structure-fields': 'kanban'`

**Remove — Event listeners (lines 3522-3535):**
- `btn-add-custom-agent` click → `showInlineCustomAgentForm(null)`
- `btn-save-custom-agent` click → `saveCustomAgentDraft`
- `btn-cancel-custom-agent` click → `hideInlineCustomAgentForm`
- `btn-add-kanban-column` click → `openKanbanColumnModal()`
- `btn-save-kanban-column` click → `saveKanbanColumnDraft`
- `btn-cancel-kanban-column` click → `closeKanbanColumnModal`
- `btn-restore-kanban-defaults` click → confirm + `restoreKanbanDefaults` message

**Remove — Modal click-outside handler (line 3694-3696):**
- `kanbanColumnModal.addEventListener('click', ...)` block

**Remove — Escape key handling (lines 3702-3703):**
- Remove `hideInlineCustomAgentForm()` call from the Escape handler
- Remove `closeKanbanColumnModal()` call from the Escape handler
- **Keep** `closeCustomPromptsModal()` call

**Update — Hydration handlers (CRITICAL):**

The `case 'customAgents'` handler (line 4179) currently calls:
```js
renderKanbanAssignedAgentOptions(kanbanColumnAssignedAgentInput.value);
syncLocalKanbanStructureWithCustomAgents();
renderCustomAgentConfigList();
renderKanbanStructureList();
```
After removing the render functions, trim this handler to:
```js
case 'customAgents':
    if (Array.isArray(message.customAgents)) {
        if (message.workspaceRoot) {
            currentWorkspaceRoot = message.workspaceRoot;
        }
        runSetupHydration(() => {
            lastCustomAgents = message.customAgents;
            syncDerivedKanbanOrdersFromStructure();
        });
    }
    break;
```

The `case 'kanbanStructure'` handler (line 4195) currently calls:
```js
syncLocalKanbanStructureWithCustomAgents();
renderKanbanStructureList();
```
After removing the render functions, trim this handler to:
```js
case 'kanbanStructure':
    if (Array.isArray(message.items)) {
        runSetupHydration(() => {
            lastKanbanStructure = message.items;
            lastCustomKanbanColumns = message.items
                .filter(item => item?.source === 'custom-user')
                .map(item => ({
                    id: item.id,
                    label: item.label,
                    role: item.assignedAgent || item.role || '',
                    triggerPrompt: item.triggerPrompt || '',
                    order: Number(item.order) || 0,
                    dragDropMode: item.dragDropMode === 'prompt' ? 'prompt' : 'cli'
                }));
            syncDerivedKanbanOrdersFromStructure();
        });
    }
    break;
```

> **Caution:** Verify that `collectSetupSavePayload()` still correctly includes `customAgents: lastCustomAgents` and `customKanbanColumns: getPersistedCustomKanbanColumns()` after cleanup. The setup panel must continue to round-trip this data even though it no longer edits it locally. The `syncDerivedKanbanOrdersFromStructure()` call at line 2627 inside `collectSetupSavePayload()` must also remain.

### src/test/kanban-custom-column-management-regression.test.js

#### Step 7. Update Regression Test

Update assertions that verify the presence of Kanban controls inside `setup.html`:

1. **Lines 56-60** — Assertion checking `id="btn-add-kanban-column"` and `id="btn-restore-kanban-defaults"` in `setup.html`:
   - These elements no longer exist in `setup.html` after removal.
   - **Redirect:** Change `setupHtmlSource` to read `kanban.html` instead and assert the controls exist there. Add a new `kanbanHtmlPath` constant and `kanbanHtmlSource` read:
   ```js
   const kanbanHtmlPath = path.join(process.cwd(), 'src', 'webview', 'kanban.html');
   const kanbanHtmlSource = fs.readFileSync(kanbanHtmlPath, 'utf8');
   ```
   Then update the assertion to check `kanbanHtmlSource` instead of `setupHtmlSource`.

2. **Lines 61-65** — Assertion checking `id="kanban-column-modal"` and its child fields in `setup.html`:
   - Same approach: redirect to `kanbanHtmlSource`.

3. **Lines 66-70** — Assertion checking `customKanbanColumns: getPersistedCustomKanbanColumns()` in `setup.html`:
   - This assertion should still PASS after cleanup because `collectSetupSavePayload()` still includes that exact expression. **No change needed.**

Do NOT remove assertions for `SetupKanbanStructureItem` type, `CustomKanbanColumnConfig` interface, `handleSaveStartupCommands`, `handleRestoreKanbanDefaults`, or `_getCustomKanbanColumns` — those are backend contracts that remain valid.

### dist/webview/setup.html

#### Step 8. Rebuild Dist

Run the webpack build to regenerate `dist/webview/setup.html`:

```bash
npm run compile
```

Or, if releasing:

```bash
npm run package
```

## Verification Plan

### Automated Tests

1. Run `node src/test/kanban-custom-column-management-regression.test.js` and confirm it passes after the test updates.
2. Run `npm run compile` and confirm the build succeeds with no errors.

### Manual Verification

1. Open the Switchboard Setup panel.
2. Confirm the "Custom Agents" and "Kanban" tab buttons are gone.
3. Confirm remaining tabs (Setup, Database, Workspace, Integrations, Sources, Control Plane, Sync) still render and function.
4. Open the Kanban panel.
5. Confirm the "Agents" tab still allows creating, editing, and deleting custom agents.
6. Confirm the "Setup" tab in Kanban still allows adding, editing, reordering, and deleting kanban columns.
7. Make a change in Kanban Agents, then open Setup and trigger an autosave (e.g., toggle a checkbox). Verify the custom agent changes are NOT lost.
8. Verify no console errors appear in the Setup panel webview developer tools.

## Risks

- **Autosave clobbering:** If `collectSetupSavePayload()` stops sending `customAgents` or `customKanbanColumns`, the next autosave from `setup.html` will erase data edited in `kanban.html`. The plan explicitly preserves these fields in the payload to prevent this.
- **Shared CSS accidental deletion:** Some modal/form styles are reused by other tabs. The plan identifies which styles are safe to remove.
- **Test failure:** The regression test will fail until updated. The plan includes test updates.
- **Hydration handler crash:** If render function calls are not removed from the `customAgents`/`kanbanStructure` handlers, the handlers will call deleted functions and throw. The plan explicitly specifies the trimmed handler code.

---

**Recommendation:** Send to Coder (Complexity ≤ 6)

## Review Pass — 2026-05-15

### Stage 1: Grumpy Principal Engineer Findings

| ID | Severity | Description |
|---|---|---|
| CRITICAL-1 | CRITICAL | `visibleAgents` handler (lines 3273-3274) still called deleted `renderCustomAgentConfigList()` and `renderKanbanStructureList()` — runtime `ReferenceError` + autosave lockout (hydration flag stuck at `true`) |
| CRITICAL-2 | CRITICAL | `currentWorkspaceRoot` assigned at line 3398 but never declared — `ReferenceError` or implicit global |
| MAJOR-1 | MAJOR | `dist/webview/setup.html` not rebuilt — timestamp 14:35 vs source 21:15, shipped artifact stale |
| NIT-1 | NIT | `sanitizeCustomAgentId`, `toCustomAgentRole`, `sanitizeKanbanColumnId` are dead code (only self-referencing, no surviving call sites) |

### Stage 2: Balanced Synthesis & Fixes Applied

- **CRITICAL-1 FIX:** Removed `renderCustomAgentConfigList()` and `renderKanbanStructureList()` calls from `visibleAgents` handler. Handler now only updates `lastVisibleAgents` state for autosave round-tripping — no rendering needed since the UI elements no longer exist.
- **CRITICAL-2 FIX:** Removed the `currentWorkspaceRoot = message.workspaceRoot;` assignment from the `customAgents` handler. The variable was never declared (declaration was removed with other custom-agent variables) and is not used by any surviving code. The assignment was dead code that would throw `ReferenceError` at runtime.
- **MAJOR-1 FIX:** Rebuilt dist via `npm run compile`. Dist timestamp now 23:25, after source changes.
- **NIT-1 FIX:** Removed `sanitizeCustomAgentId()`, `toCustomAgentRole()`, and `sanitizeKanbanColumnId()` functions. These were only called by deleted `saveCustomAgentDraft()` and `saveKanbanColumnDraft()` functions and have no surviving call sites.

### Files Changed by Review

- `src/webview/setup.html` — 3 edits: (1) trimmed `visibleAgents` handler, (2) removed `currentWorkspaceRoot` assignment, (3) removed 3 dead utility functions
- `dist/webview/setup.html` — rebuilt via `npm run compile`

### Validation Results

- `node src/test/kanban-custom-column-management-regression.test.js` — **PASSED**
- `npm run compile` — **compiled successfully** (webpack 5.105.4, 4163ms)
- Dist grep for deleted references (`renderCustomAgentConfigList`, `renderKanbanStructureList`, `currentWorkspaceRoot`, `sanitizeCustomAgentId`, `toCustomAgentRole`, `sanitizeKanbanColumnId`, `custom-agents-fields`, `kanban-structure-fields`, `kanban-column-modal`, `btn-add-custom-agent`, `btn-add-kanban-column`) — **0 matches** (clean)
- Dist grep for preserved round-trip fields (`customAgents: lastCustomAgents`, `customKanbanColumns: getPersistedCustomKanbanColumns()`) — **2 matches** (preserved correctly)

### Remaining Risks

- The `visibleAgents` handler no longer renders anything, which is correct since the UI is gone. However, if a future feature adds a new UI element that depends on `visibleAgents` state, a render call will need to be added back.
- The `currentWorkspaceRoot` variable was removed entirely. If any future code needs the workspace root in the setup panel, it should be declared explicitly and sourced from the appropriate hydration message.
