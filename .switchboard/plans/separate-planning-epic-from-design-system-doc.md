# Separate Planning Epic from Design System Doc

## Goal

Rename all existing "design doc" internal references, UI labels, and prompt text to "planning epic", and introduce a parallel first-class "design system doc" setting/addon/prompt-block so both documents can be optionally attached to the same prompt via independent checkboxes.

### Problem Statement & Root Cause

Switchboard currently uses the term "design doc" for two semantically different documents:

1. **Planning Epic** — a product requirements document or epic-level plan set via the *Local Docs*, *Online Docs*, or *Kanban Plans* tabs in `planning.html`. This document provides foundational context for planning and is consumed by the planner, lead, coder, intern, reviewer, and acceptance tester roles.
2. **Design System Doc** — an actual design-system document (e.g. a design.md, component library spec, or visual design reference) set via the *Design System* tab in `planning.html`. This document describes the overall visual and interaction design of the project and is relevant to implementation roles but is **not** a product requirements document.

These two concepts are currently conflated under a single `planner.designDocLink` VS Code setting, a single `designDoc` addon flag in `state.json`, and a single `activeDesignDoc` UI state. The acceptance tester even enforces that a "Design Doc / PRD" is configured, when what it really needs is the planning epic. This conflation prevents users from attaching both a planning epic and a design system doc to the same prompt.

**Root Cause:** When the "Design System" tab was added to `planning.html`, it reused the existing `_handleSetActivePlanningContext` path and the `planner.designDocLink` setting rather than creating a parallel setting. The prompt builder, kanban provider, and task viewer provider all grew single-doc-resolution logic (`_resolveGlobalDesignDoc`, `_getDesignDocContent`, etc.) that assumed only one active document existed.

---

## Metadata

**Tags:** frontend, backend, refactor, ui, feature
**Complexity:** 6

---

## User Review Required

- Confirm that the kanban prompts tab checkbox label "Planning Epic Reference" (renamed from "Design Doc Reference") is acceptable.
- Confirm that the new second checkbox labeled "Design Doc Reference" (for the design system doc) is the desired UX.
- Confirm that Notion pre-fetching will NOT be supported for design system docs in this iteration.

---

## Complexity Audit

### Routine
- Adding two new VS Code configuration keys to `package.json` (lines 261-269 area)
- Adding three new fields to `CustomAgentAddons` interface and parser in `agentConfig.ts`
- Adding two new fields to `PromptBuilderOptions` interface in `agentPromptBuilder.ts`
- Adding `_resolveDesignSystemDoc` method to `KanbanProvider.ts` (mirrors existing `_resolveGlobalDesignDoc`)
- Adding `_getDesignSystemDocLink()` and `_isDesignSystemDocEnabled()` helpers to `TaskViewerProvider.ts`
- Adding `handleGetDesignSystemDocSetting()` to `TaskViewerProvider.ts`
- Adding `_getDesignSystemDocName` helper to `PlanningPanelProvider.ts`
- Renaming UI labels in `planning.html` banners (lines 2870, 2919, 3081)
- Renaming checkbox label/tooltip in `kanban.html` (line 2547-2549)
- Updating `sharedDefaults.js` ROLE_ADDONS entry (line 65)
- Updating error messages and JSDoc comments in `PlannerPromptWriter.ts`
- Updating label text in `setup.html` (lines 2494-2495)
- Updating test assertions for renamed terminology

### Complex / Risky
- Splitting `_handleSetActivePlanningContext` (PlanningPanelProvider line 2543) to write to different VS Code settings based on `sourceId` — must not break existing Local/Online/Kanban tab behavior
- Changing `activeDesignDocUpdated` message payload from flat fields to nested `{ planningEpic, designSystemDoc }` shape — webview JS must be updated in lockstep with backend
- Adding `docType` parameter to `_handleDisableDesignDoc` (PlanningPanelProvider line 2515) — existing call site at line 1442 must continue working
- Checkbox ID rename in `kanban.html` (line 2547) breaks the generic addon-key derivation logic at line 3607 — requires explicit mapping table
- Custom-agent branch in `generateUnifiedPrompt` (KanbanProvider line 2310) currently only resolves `designDoc` — must also resolve `designSystemDoc` for custom agents

---

## Edge-Case & Dependency Audit

**Race Conditions:**
- If both the planning epic and design system doc point to the same Notion page, `_resolveGlobalDesignDoc` and `_resolveDesignSystemDoc` will both call `notionService.loadCachedContent()`. The cache service is idempotent, but two concurrent reads could race. Mitigation: both methods are called sequentially in `generateUnifiedPrompt`, not in parallel.

**Security:**
- The new `planner.designSystemDocLink` setting accepts an arbitrary string. If a user sets it to a file:// URL pointing outside the workspace, the prompt builder will embed the path verbatim. This matches existing behavior for `planner.designDocLink` — no new risk, but worth noting.

**Side Effects:**
- Writing to `planner.designSystemDocLink` via `_handleSetActivePlanningContext` triggers VS Code's `onDidChangeConfiguration` event. Any listener that reacts to `switchboard.planner` configuration changes will fire. Currently no such listener exists outside the providers themselves.

**Dependencies & Conflicts:**
- The `activeDesignDocUpdated` message contract change must land in the same commit as the `planning.js` handler update. Splitting across commits will break the planning panel.
- The `kanban.html` checkbox rename and the `sharedDefaults.js` update must land together — the dynamic addon UI generator reads from `ROLE_ADDONS`.
- The `agentConfig.ts` parser changes and the `kanban.html` save-logic mapping must land together — otherwise the new `designSystemDoc` addon key is written to state.json but never parsed back.

---

## Dependencies

- `sess_design_system_split` — This plan is self-contained; no external session dependencies.

---

## Adversarial Synthesis

Key risks: (1) Custom-agent branch silently loses design system doc context — must add resolution logic. (2) Checkbox ID rename breaks generic addon-key derivation — must add explicit mapping. (3) `sharedDefaults.js` ROLE_ADDONS not mentioned in original plan — must update. (4) Message contract change requires lockstep deployment. Mitigations: explicit mapping table in save logic, add `_resolveDesignSystemDoc` call in custom-agent branch, update `sharedDefaults.js`, ship all webview+backend changes in one commit.

---

## Proposed Changes

### 1. `package.json` — Add new VS Code configuration keys

- **Lines ~261-269** (after existing `planner.designDocLink`): Add:
  ```json
  "switchboard.planner.designSystemDocEnabled": {
      "type": "boolean",
      "default": false,
      "description": "When enabled, appends a Design System Doc link to planner prompts for visual/interaction design context."
  },
  "switchboard.planner.designSystemDocLink": {
      "type": "string",
      "default": "",
      "description": "URL or path to the Design System Doc to append to planner prompts. Only used when designSystemDocEnabled is true."
  }
  ```
- Keep existing `planner.designDocEnabled` (line 261) and `planner.designDocLink` (line 266) unchanged.

### 2. `src/services/agentConfig.ts` — Extend addon schema

- **Lines 27-30** (after existing `designDoc*` fields in `CustomAgentAddons`): Add:
  ```typescript
  // Design System Doc (from Design System tab)
  designSystemDoc?: boolean;
  designSystemDocLink?: string;
  designSystemDocContent?: string;
  ```
- **Lines 185-191** (in `parseCustomAgentAddons`, after the existing `designDoc*` parsing): Add:
  ```typescript
  if (s.designSystemDoc === true) a.designSystemDoc = true;
  if (s.designSystemDocLink) a.designSystemDocLink = String(s.designSystemDocLink).trim();
  if (!a.designSystemDoc && s.designSystemDocLink) a.designSystemDoc = true;
  if (s.designSystemDocContent) {
      const content = String(s.designSystemDocContent).trim();
      a.designSystemDocContent = content.length > 50000 ? content.slice(0, 50000) + '\n[TRUNCATED]' : content;
  }
  ```

### 3. `src/services/agentPromptBuilder.ts` — Split prompt blocks

- **Lines 96-98** (in `PromptBuilderOptions`): Add after `designDocContent`:
  ```typescript
  /** When present, appends a Design System Doc link to planner prompts. */
  designSystemDocLink?: string;
  /** When present, the full pre-fetched content of the design system doc. */
  designSystemDocContent?: string;
  ```
- **Line 456** (planner role, `DESIGN DOC REFERENCE` block): Rename heading to `PLANNING EPIC REFERENCE`. After line 457, add:
  ```typescript
  const designSystemDocLink = options?.designSystemDocLink?.trim();
  if (designSystemDocLink) {
      plannerBase += `DESIGN SYSTEM DOC REFERENCE:\nThe following design system document provides the project's visual and interaction design specifications. Use it as context for implementation decisions:\n${designSystemDocLink}\n\n`;
  }
  ```
- **Line 496** (planner role, `DESIGN DOC REFERENCE (pre-fetched from Notion)` block): Rename heading to `PLANNING EPIC REFERENCE (pre-fetched from Notion)`. After line 497, add:
  ```typescript
  const designSystemDocContent = options?.designSystemDocContent?.trim();
  if (designSystemDocContent) {
      plannerPrompt += `\n\nDESIGN SYSTEM DOC REFERENCE (pre-fetched):\nThe following is the full content of the project's design system document. Use it as context for implementation decisions:\n\n${designSystemDocContent}`;
  }
  ```
- **Lines 622-627** (tester role): Rename both `DESIGN DOC REFERENCE` headings to `PLANNING EPIC REFERENCE`. Do NOT add design system doc block to tester.
- **Lines 1303-1307** (custom agent `buildCustomAgentPrompt`): Rename `DESIGN DOC REFERENCE` to `PLANNING EPIC REFERENCE`. Add parallel block for `designSystemDocContent`/`designSystemDocLink`:
  ```typescript
  if (addons?.designSystemDocContent) {
      prompt += `\n\nDESIGN SYSTEM DOC REFERENCE (pre-fetched):\n${addons.designSystemDocContent}`;
  } else if (addons?.designSystemDocLink) {
      prompt += `\n\nDESIGN SYSTEM DOC REFERENCE:\n${addons.designSystemDocLink}`;
  }
  ```

### 4. `src/services/KanbanProvider.ts` — Dual doc resolution

- **After line 2293** (after `_resolveGlobalDesignDoc`): Add:
  ```typescript
  private async _resolveDesignSystemDoc(workspaceRoot: string): Promise<{ designSystemDocLink?: string; designSystemDocContent?: string }> {
      const config = vscode.workspace.getConfiguration('switchboard');
      const designSystemDocEnabled = config.get<boolean>('planner.designSystemDocEnabled', false);
      const designSystemDocLink = designSystemDocEnabled ? (config.get<string>('planner.designSystemDocLink', '') || '').trim() : undefined;
      if (!designSystemDocLink) return {};
      // Design system doc does NOT support Notion pre-fetching in this iteration
      return { designSystemDocLink };
  }
  ```
- **Lines 2310-2313** (custom-agent branch): After resolving `designDoc*`, add:
  ```typescript
  if (mergedAddons.designSystemDoc) {
      const { designSystemDocLink } = await this._resolveDesignSystemDoc(workspaceRoot);
      mergedAddons.designSystemDocLink = designSystemDocLink;
  }
  ```
- **Lines 2348-2355** (planner role): After resolving `designDoc*`, add:
  ```typescript
  const { designSystemDocLink } = await this._resolveDesignSystemDoc(workspaceRoot);
  resolvedOptions.designSystemDocLink = designSystemDocLink;
  ```
- **Line 2371** (tester error message): Change `"Acceptance Tester requires a Design Doc / PRD to be enabled and attached in Setup."` to `"Acceptance Tester requires a Planning Epic to be enabled and attached in Setup."`
- **Lines 2457-2458** (in `_getPromptsConfig`): Add after `designDocLink`:
  ```typescript
  designSystemDocEnabled: plannerConfig?.addons?.designSystemDoc ?? config.get<boolean>('planner.designSystemDocEnabled', false),
  designSystemDocLink: config.get<string>('planner.designSystemDocLink', ''),
  ```

### 5. `src/services/PlanningPanelProvider.ts` — Split active-doc tracking

- **After line 82** (after `_activeDesignDocId`): Add:
  ```typescript
  private _activeDesignSystemDocSourceId: string | null = null;
  private _activeDesignSystemDocId: string | null = null;
  ```
- **Lines 2543-2617** (`_handleSetActivePlanningContext`): Split the VS Code setting writes based on `sourceId`:
  - If `sourceId === 'design-folder'`: write to `planner.designSystemDocLink` and `planner.designSystemDocEnabled`; update `_activeDesignSystemDocSourceId/Id`
  - For all other source IDs: write to existing `planner.designDocLink` and `planner.designDocEnabled`; update `_activeDesignDocSourceId/Id` (existing behavior)
- **Lines 2515-2541** (`_handleDisableDesignDoc`): Add `docType` parameter with default `'planning-epic'`:
  ```typescript
  private async _handleDisableDesignDoc(docType: 'planning-epic' | 'design-system' = 'planning-epic'): Promise<void> {
  ```
  - If `docType === 'planning-epic'`: disable `planner.designDocEnabled`, clear `planner.designDocLink`, clear `_activeDesignDocSourceId/Id`
  - If `docType === 'design-system'`: disable `planner.designSystemDocEnabled`, clear `planner.designSystemDocLink`, clear `_activeDesignSystemDocSourceId/Id`
- **Line 2761** (`_getDesignDocName`): Rename to `_getPlanningEpicName` (reads `planner.designDocLink`). Add `_getDesignSystemDocName` (reads `planner.designSystemDocLink`).
- **Lines 2768-2779** (`_sendActiveDesignDocState`): Send a single message with both states:
  ```typescript
  type: 'activeDesignDocUpdated',
  planningEpic: { enabled, docName, sourceId: this._activeDesignDocSourceId, docId: this._activeDesignDocId },
  designSystemDoc: { enabled: dsEnabled, docName: dsDocName, sourceId: this._activeDesignSystemDocSourceId, docId: this._activeDesignSystemDocId }
  ```
  **Grace period note:** The webview JS handler should accept both the old flat format (`msg.enabled`, `msg.docName`) and the new nested format (`msg.planningEpic`, `msg.designSystemDoc`) for one release cycle, then remove the old-format path.

### 6. `src/services/TaskViewerProvider.ts` — Add design-system accessors, keep tester on planning epic

- **After line 14875** (after `_getDesignDocLink`): Add:
  ```typescript
  private _isDesignSystemDocEnabled(): boolean {
      const plannerConfig: any = this.getSetting('switchboard.prompts.roleConfig_planner', undefined);
      if (plannerConfig?.addons?.designSystemDoc !== undefined) return plannerConfig.addons.designSystemDoc;
      return vscode.workspace.getConfiguration('switchboard').get<boolean>('planner.designSystemDocEnabled', false);
  }

  private _getDesignSystemDocLink(): string {
      return vscode.workspace.getConfiguration('switchboard').get<string>('planner.designSystemDocLink', '') || '';
  }
  ```
- **Lines 2895-2896** (`_isAcceptanceTesterDesignDocConfigured`): Keep checking only `planner.designDocLink` (planning epic). Update error message at line 2911 from `"Acceptance Tester requires a Design Doc / PRD to be enabled and attached in Setup."` to `"Acceptance Tester requires a Planning Epic to be enabled and attached in Setup."`
- **Lines 3406-3411** (`handleGetDesignDocSetting`): Keep returning the planning epic. Add new method:
  ```typescript
  public handleGetDesignSystemDocSetting(): { enabled: boolean; link: string } {
      return {
          enabled: this._isDesignSystemDocEnabled(),
          link: this._getDesignSystemDocLink()
      };
  }
  ```
- **Lines 3692-3697** (sidebar state post): Add after the existing `designDocSetting` post:
  ```typescript
  const designSystemDocSetting = this.handleGetDesignSystemDocSetting();
  this._view.webview.postMessage({
      type: 'designSystemDocSetting',
      enabled: designSystemDocSetting.enabled,
      link: designSystemDocSetting.link
  });
  ```

### 7. `src/services/PlannerPromptWriter.ts` — Update comments and labels only

- **Line 51** (JSDoc for `skipDesignDocLink`): Update to clarify it means "skip setting the planning epic link"
- **Lines 131-132** (return messages): Change `"Design doc imported and activated"` to `"Planning epic imported and activated"`
- Keep the functional write to `planner.designDocLink`/`planner.designDocEnabled` unchanged (it is still the planning epic)

### 8. `src/services/SetupPanelProvider.ts` — Update labels only

- **Lines 617-624** (`getDesignDocSetting` handler): Add comment clarifying this returns the planning epic. Add parallel handler for `getDesignSystemDocSetting`:
  ```typescript
  case 'getDesignSystemDocSetting': {
      const setting = this._taskViewerProvider.handleGetDesignSystemDocSetting();
      this._panel.webview.postMessage({
          type: 'designSystemDocSetting',
          enabled: setting.enabled,
          link: setting.link
      });
      break;
  }
  ```

### 9. `src/webview/planning.html` — Rename banners per tab

- **Line 2870** (`#active-doc-banner-local`): Change `<span class="active-doc-label">Active Design Doc:</span>` to `<span class="active-doc-label">Active Planning Epic:</span>`
- **Line 2919** (`#active-doc-banner-online`): Same rename
- **Line 3081** (`#active-doc-banner-design`): Keep label as `<span class="active-doc-label">Active Design Doc:</span>` (now representing the actual design system doc)
- Update the "Turn off" button click handlers to send `docType` so the backend knows which doc to disable

### 10. `src/webview/planning.js` — Update message handler

- **Lines 3754-3774** (`updateActiveDocBanner`): Update to handle new nested message format:
  ```javascript
  function updateActiveDocBanner(msg) {
      // Support both old flat format and new nested format
      const planningEpic = msg.planningEpic || { enabled: msg.enabled, docName: msg.docName, sourceId: msg.sourceId, docId: msg.docId };
      const designSystemDoc = msg.designSystemDoc || { enabled: false, docName: null };

      // Update Local/Online banners from planningEpic
      const isEpicActive = planningEpic.enabled && planningEpic.docName;
      const epicName = planningEpic.docName || 'None';
      // ... apply to bannerLocal, bannerOnline ...

      // Update Design System banner from designSystemDoc
      const isDsActive = designSystemDoc.enabled && designSystemDoc.docName;
      const dsName = designSystemDoc.docName || 'None';
      // ... apply to bannerDesign, nameDesign ...
  }
  ```

### 11. `src/webview/kanban.html` — Prompts tab: two independent checkboxes

- **Lines 2546-2550**: Rename existing checkbox:
  - `id="plannerAddonDesignDoc"` → `id="plannerAddonPlanningEpic"`
  - Label text "Design Doc Reference" → **"Planning Epic Reference"**
  - Tooltip "Include design doc as planning context" → "Include planning epic as context"
- Add a new checkbox after it:
  ```html
  <label class="checkbox-item" title="Append design system doc as context for planning">
    <input type="checkbox" id="plannerAddonDesignSystemDoc">
    <span>Design Doc Reference</span>
    <span class="tooltip">Include design system doc as context</span>
  </label>
  ```
- **Line 2875**: Update `loadPromptsTab` to populate both checkboxes:
  ```javascript
  document.getElementById('plannerAddonPlanningEpic').checked = !!config.addons?.designDoc;
  document.getElementById('plannerAddonDesignSystemDoc').checked = !!config.addons?.designSystemDoc;
  ```
- **Line 3603**: Update the checkbox event-listener array to include both IDs:
  ```javascript
  ['plannerAddonSwitchboardSafeguards', 'plannerAddonPlanningEpic', 'plannerAddonDesignSystemDoc', 'plannerAddonAggressivePairProgramming', ...]
  ```
- **Lines 3607-3611** (save logic): Add explicit mapping so `plannerAddonPlanningEpic` maps to the persisted key `designDoc` and `plannerAddonDesignSystemDoc` maps to `designSystemDoc`:
  ```javascript
  el.addEventListener('change', (e) => {
      const addonIdMap = {
          'plannerAddonPlanningEpic': 'designDoc',
          'plannerAddonDesignSystemDoc': 'designSystemDoc'
      };
      const finalAddonId = addonIdMap[id] || (id.replace('plannerAddon', '').charAt(0).toLowerCase() + id.replace('plannerAddon', '').slice(1));
      if (!roleConfigs.planner) roleConfigs.planner = { workflowFilePath: '', addons: {} };
      if (!roleConfigs.planner.addons) roleConfigs.planner.addons = {};
      roleConfigs.planner.addons[finalAddonId] = e.target.checked;
      saveRoleConfig('planner');
      refreshPreview();
  });
  ```

### 12. `src/webview/sharedDefaults.js` — Update ROLE_ADDONS

- **Line 65**: Update the existing entry and add new entry:
  ```javascript
  { id: 'designDoc', label: 'Planning Epic Reference', tooltip: 'Include planning epic as context', default: false },
  { id: 'designSystemDoc', label: 'Design Doc Reference', tooltip: 'Include design system doc as context', default: false },
  ```

### 13. `src/webview/setup.html` — Update labels

- **Lines 2494-2495**: Update text from `"Planner design doc"` to `"Planner planning epic"`. Keep `lastDesignDocLink` variable name (it is webview-local JS state, not persisted).

### 14. Test files — Update terminology

- `src/services/__tests__/KanbanProvider.test.ts` — update assertions on `designDocLink`/`designDocContent` to reflect renamed internal terminology (actual field names stay the same). Add test for `_isAcceptanceTesterDesignDocConfigured` still checking `planner.designDocLink` (not the new setting).
- `src/services/__tests__/agentConfig.addons.test.js` — add test cases for the new `designSystemDoc`, `designSystemDocLink`, `designSystemDocContent` fields. Verify `designSystemDocContent` caps at 50K chars.
- `src/services/__tests__/PlanningPanelCacheService.duplicate.test.ts` — update if it references design doc terminology.
- `src/test/prompts-tab-move-regression.test.js` — update selectors and assertions for renamed checkbox ID (`plannerAddonPlanningEpic` instead of `plannerAddonDesignDoc`).
- `src/test/minimal-prompt.test.js` — update assertions on prompt text containing "DESIGN DOC REFERENCE" to "PLANNING EPIC REFERENCE".
- `src/test/agent-config-drag-drop-mode.test.js` — update references.
- `src/test/planning-aggregate-cache.test.js` — update references.

---

## Verification Plan

### Automated Tests

1. **Unit tests for `agentConfig.ts`** — verify `parseCustomAgentAddons` correctly parses the three new `designSystemDoc*` fields and caps content at 50K chars.
2. **Unit tests for `agentPromptBuilder.ts`** — verify that:
   - When `designSystemDocLink` is provided, the planner prompt contains a `DESIGN SYSTEM DOC REFERENCE` block.
   - When `designDocLink` is provided, the planner prompt contains a `PLANNING EPIC REFERENCE` block (not the old `DESIGN DOC REFERENCE` text).
   - When both are provided, both blocks appear.
   - The tester prompt still references the planning epic and does not mention the design system doc.
   - Custom agent prompts include both blocks when both addons are enabled.
3. **Unit tests for `KanbanProvider.ts`** — verify `_resolveDesignSystemDoc` reads from the new setting and `generateUnifiedPrompt` wires it into `PromptBuilderOptions` for both built-in and custom-agent paths.
4. **Integration test for `PlanningPanelProvider.ts`** — verify that clicking "Set as Active Planning Context" in the Design System tab writes to `planner.designSystemDocLink`, while clicking it in Local Docs writes to `planner.designDocLink`.
5. **Regression test for `kanban.html`** — verify the prompts tab loads both checkboxes correctly, saves the correct addon keys to state.json (`designDoc` for Planning Epic, `designSystemDoc` for Design System Doc), and the preview reflects both selections.
6. **Manual smoke test** — verify the `activeDesignDocUpdated` message handler works with both old flat format and new nested format in `planning.js`.

---

## Migration Notes

- **No data migration is required.** Existing `planner.designDocLink` values automatically become the planning epic.
- **No setting key changes.** All persisted VS Code settings and `state.json` keys remain compatible.
- The Design System tab is unreleased, so no user data migration is needed for it.
- **Deployment constraint:** The `activeDesignDocUpdated` message contract change and the `planning.js` handler update must ship in the same commit. The kanban.html checkbox rename and sharedDefaults.js update must also ship together.

**Recommendation:** Complexity 6 → Send to Coder
