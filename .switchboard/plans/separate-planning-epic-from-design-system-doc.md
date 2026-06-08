# Separate Planning Epic from Design System Doc

## Metadata

**Complexity:** 6
**Tags:** frontend, backend, refactor, ui, feature

---

## Problem Statement

Switchboard currently uses the term "design doc" for two semantically different documents:

1. **Planning Epic** — a product requirements document or epic-level plan set via the *Local Docs*, *Online Docs*, or *Kanban Plans* tabs in `planning.html`. This document provides foundational context for planning and is consumed by the planner, lead, coder, intern, reviewer, and acceptance tester roles.
2. **Design System Doc** — an actual design-system document (e.g. a design.md, component library spec, or visual design reference) set via the *Design System* tab in `planning.html`. This document describes the overall visual and interaction design of the project and is relevant to implementation roles but is **not** a product requirements document.

These two concepts are currently conflated under a single `planner.designDocLink` VS Code setting, a single `designDoc` addon flag in `state.json`, and a single `activeDesignDoc` UI state. The acceptance tester even enforces that a "Design Doc / PRD" is configured, when what it really needs is the planning epic. This conflation prevents users from attaching both a planning epic and a design system doc to the same prompt.

### Root Cause

When the "Design System" tab was added to `planning.html`, it reused the existing `_handleSetActivePlanningContext` path and the `planner.designDocLink` setting rather than creating a parallel setting. The prompt builder, kanban provider, and task viewer provider all grew single-doc-resolution logic (`_resolveGlobalDesignDoc`, `_getDesignDocContent`, etc.) that assumed only one active document existed.

### Goal

- Rename all **existing** "design doc" internal references, UI labels, and prompt text to **"planning epic"** (while keeping the persisted setting keys unchanged to avoid migration risk).
- Introduce a **new** first-class "design system doc" setting, addon, and prompt block that is set exclusively from the *Design System* tab.
- Allow both documents to be optionally attached to the same prompt via independent checkboxes in the Kanban prompts tab.
- Keep the acceptance tester requiring only the **planning epic**.

---

## Affected Files & Changes

### 1. `package.json` — Add new VS Code configuration keys

- Add `planner.designSystemDocEnabled` (`boolean`, default `false`)
- Add `planner.designSystemDocLink` (`string`, default `""`)
- Keep existing `planner.designDocEnabled` and `planner.designDocLink` unchanged (they continue to represent the planning epic)

### 2. `src/services/agentConfig.ts` — Extend addon schema

- Add to `CustomAgentAddons`:
  ```typescript
  // Design System Doc (from Design System tab)
  designSystemDoc?: boolean;
  designSystemDocLink?: string;
  designSystemDocContent?: string;
  ```
- Update `parseCustomAgentAddons` to parse the three new fields (with caps and truncate logic matching existing `designDocContent`)
- Keep existing `designDoc`, `designDocLink`, `designDocContent` fields for the planning epic

### 3. `src/services/agentPromptBuilder.ts` — Split prompt blocks

- Add to `PromptBuilderOptions`:
  ```typescript
  designSystemDocLink?: string;
  designSystemDocContent?: string;
  ```
- In `buildKanbanBatchPrompt`:
  - **Planner role**: rename existing `DESIGN DOC REFERENCE` block heading to `PLANNING EPIC REFERENCE`. Append a new optional `DESIGN SYSTEM DOC REFERENCE` block using `designSystemDocLink`/`designSystemDocContent`.
  - **Tester role**: keep using `designDocLink`/`designDocContent` (planning epic) but rename the block heading in prompt text to `PLANNING EPIC REFERENCE`. Do **not** require or inject the design system doc.
  - **All other roles**: rename any existing "Design Doc" text to "Planning Epic" in generated prompts.

### 4. `src/services/KanbanProvider.ts` — Dual doc resolution

- Keep `_resolveGlobalDesignDoc` (it resolves the **planning epic** from existing settings)
- Add `_resolveDesignSystemDoc` (resolves the new **design system doc** from `planner.designSystemDocLink`)
- In `generateUnifiedPrompt`:
  - For the **planner** role: resolve both docs. If the planner's addons include `designDoc`, set `designDocLink`/`designDocContent`. If addons include `designSystemDoc`, set `designSystemDocLink`/`designSystemDocContent`.
  - For the **tester** role: continue resolving only the planning epic (existing `designDocLink`/`designDocContent`)
- In `_buildPromptsConfigState`:
  - Rename the returned `designDocEnabled`/`designDocLink` fields conceptually to planning epic (keep the key names for backward compat in the webview state contract)
  - Add new `designSystemDocEnabled`/`designSystemDocLink` fields

### 5. `src/services/PlanningPanelProvider.ts` — Split active-doc tracking

- Add new instance variables:
  ```typescript
  private _activeDesignSystemDocSourceId: string | null = null;
  private _activeDesignSystemDocId: string | null = null;
  ```
- Update `_handleSetActivePlanningContext`:
  - If `sourceId === 'design-folder'` (Design System tab): write to `planner.designSystemDocLink` and `planner.designSystemDocEnabled`; update `_activeDesignSystemDocSourceId/Id`
  - For all other source IDs: write to existing `planner.designDocLink` and `planner.designDocEnabled`; update `_activeDesignDocSourceId/Id` (existing behavior)
- Update `_handleDisableDesignDoc`:
  - Accept a `docType` parameter (`'planning-epic' | 'design-system'`)
  - Disable the appropriate VS Code setting and clear the appropriate instance variables
- Rename `_getDesignDocName` to `_getPlanningEpicName` (reads `planner.designDocLink`)
- Add `_getDesignSystemDocName` (reads `planner.designSystemDocLink`)
- Update `_sendActiveDesignDocState`:
  - Send a single message with **both** states so the webview can update the correct banners:
    ```typescript
    type: 'activeDesignDocUpdated',
    planningEpic: { enabled, docName, sourceId, docId },
    designSystemDoc: { enabled, docName, sourceId, docId }
    ```

### 6. `src/services/TaskViewerProvider.ts` — Add design-system accessors, keep tester on planning epic

- Add `_getDesignSystemDocLink()` and `_isDesignSystemDocEnabled()` helpers (mirroring existing design-doc helpers)
- Keep `_isAcceptanceTesterDesignDocConfigured()` and `_ensureAcceptanceTesterDispatchEligible()` checking only the **planning epic** (existing `planner.designDocLink`)
- Keep `handleGetDesignDocSetting()` returning the planning epic (for backward compat with setup.html)
- Add `handleGetDesignSystemDocSetting()` returning the new design system doc state
- Post both settings when refreshing setup panel state

### 7. `src/services/PlannerPromptWriter.ts` — Update comments and labels only

- Update the JSDoc comment for `skipDesignDocLink` to clarify it means "skip setting the planning epic link"
- Update user-facing strings in return messages (`Design doc imported and activated...` → `Planning epic imported and activated...`)
- Keep the functional write to `planner.designDocLink`/`planner.designDocEnabled` unchanged (it is still the planning epic)

### 8. `src/services/SetupPanelProvider.ts` — Update labels only

- Update `getDesignDocSetting` message handler to return the planning epic (unchanged functional behavior, but comment/label clarity)

### 9. `src/webview/planning.html` — Rename banners per tab

- **Local Docs tab** (`#active-doc-banner-local` / `#active-doc-name-local`): rename label from "Active Design Doc:" to **"Active Planning Epic:"**
- **Online Docs tab** (`#active-doc-banner-online` / `#active-doc-name-online`): same rename
- **Kanban Plans tab** (if it has a banner): same rename
- **Design System tab** (`#active-doc-banner-design` / `#active-doc-name-design`): keep label as **"Active Design Doc:"** (now representing the actual design system doc)
- Update the JavaScript `activeDesignDocUpdated` message handler to apply `planningEpic` state to Local/Online/Kanban banners and `designSystemDoc` state to the Design System banner
- Update the "Turn off" button click handlers to send `docType` so the backend knows which doc to disable
- Update the "Set as Active Planning Context" button in the Design System tab to set the design system doc (it currently sets the planning epic because it shares the same handler)

### 10. `src/webview/kanban.html` — Prompts tab: two independent checkboxes

- Rename the existing checkbox:
  - `id="plannerAddonDesignDoc"` → `id="plannerAddonPlanningEpic"`
  - Label text "Design Doc Reference" → **"Planning Epic Reference"**
  - Tooltip "Include design doc as planning context" → "Include planning epic as context"
- Add a new checkbox:
  - `id="plannerAddonDesignSystemDoc"`
  - Label **"Design Doc Reference"**
  - Tooltip "Include design system doc as context"
- Update the checkbox event-listener array to include the new ID
- Update `loadPromptsTab` logic to populate both checkboxes from `roleConfigs.planner.addons`
- Update the config save logic so that `plannerAddonPlanningEpic` still maps to the persisted key `designDoc` (backward compat) and `plannerAddonDesignSystemDoc` maps to `designSystemDoc`

### 11. `src/webview/setup.html` — Update labels

- Update the Notion setup summary text and status labels that mention "planner design doc" to say "planner planning epic" or equivalent
- Keep `lastDesignDocLink` variable name (it is webview-local JS state, not persisted)

### 12. Test files — Update terminology

- `src/services/__tests__/KanbanProvider.test.ts` — update any assertions on `designDocLink`/`designDocContent` to reflect the renamed internal terminology (actual field names stay the same)
- `src/services/__tests__/agentConfig.addons.test.js` — add test cases for the new `designSystemDoc`, `designSystemDocLink`, `designSystemDocContent` fields
- `src/services/__tests__/PlanningPanelCacheService.duplicate.test.ts` — update if it references design doc terminology
- `src/test/prompts-tab-move-regression.test.js` — update selectors and assertions for renamed checkbox ID
- `src/test/minimal-prompt.test.js` — update any assertions on prompt text containing "Design Doc" to "Planning Epic"
- `src/test/agent-config-drag-drop-mode.test.js` — update references
- `src/test/planning-aggregate-cache.test.js` — update references

---

## Edge Cases & Risks

| Risk | Mitigation |
|------|------------|
| **Breaking existing user state** | Do not rename persisted keys (`planner.designDocLink`, `designDoc` in state.json). Only rename UI labels, prompt text, and internal variable names. |
| **Webview message contract change** | The `activeDesignDocUpdated` message payload gains a nested shape instead of flat fields. Update the webview handler before the backend starts sending the new shape. Consider a grace period where the handler accepts both old and new formats. |
| **Two "Design Doc Reference" labels in Kanban prompts** | The old checkbox becomes "Planning Epic Reference" and the new one is "Design Doc Reference". This is intentional per the user's request — the label "Design Doc Reference" now correctly refers to the actual design system doc. |
| **Acceptance tester regression** | The tester currently throws if `designDocLink` is missing. After the rename, it should still throw if the planning epic is missing. No functional change — only label updates in error messages. |
| **Notion pre-fetching** | Notion pre-fetching (`designDocContent`) stays tied to the planning epic only. The design system doc does not support Notion pre-fetching in this iteration. Document this limitation. |
| **Both checkboxes unchecked** | If both `designDoc` and `designSystemDoc` addons are unchecked, the planner prompt contains neither reference. This is valid — no regression. |
| **Both checkboxes checked** | If both are checked, the planner prompt contains both a `PLANNING EPIC REFERENCE` and a `DESIGN SYSTEM DOC REFERENCE` block. Ensure the prompt builder concatenates them correctly without duplicating headers. |

---

## Testing Strategy

1. **Unit tests for `agentConfig.ts`** — verify `parseCustomAgentAddons` correctly parses the three new `designSystemDoc*` fields and caps content at 50K chars.
2. **Unit tests for `agentPromptBuilder.ts`** — verify that:
   - When `designSystemDocLink` is provided, the planner prompt contains a `DESIGN SYSTEM DOC REFERENCE` block.
   - When `designDocLink` is provided, the planner prompt contains a `PLANNING EPIC REFERENCE` block (not the old `DESIGN DOC REFERENCE` text).
   - When both are provided, both blocks appear.
   - The tester prompt still references the planning epic and does not mention the design system doc.
3. **Unit tests for `KanbanProvider.ts`** — verify `_resolveDesignSystemDoc` reads from the new setting and `generateUnifiedPrompt` wires it into `PromptBuilderOptions`.
4. **Integration test for `PlanningPanelProvider.ts`** — verify that clicking "Set as Active Planning Context" in the Design System tab writes to `planner.designSystemDocLink`, while clicking it in Local Docs writes to `planner.designDocLink`.
5. **Regression test for `kanban.html`** — verify the prompts tab loads both checkboxes correctly, saves the correct addon keys to state.json, and the preview reflects both selections.

---

## Migration Notes

- **No data migration is required.** Existing `planner.designDocLink` values automatically become the planning epic.
- **No setting key changes.** All persisted VS Code settings and `state.json` keys remain compatible.
- Users who previously used the Design System tab's "Set as Active Planning Context" button will find that their old selection is now stored as the **planning epic** (because it was written to `planner.designDocLink`). They will need to re-select it in the Design System tab to store it as the **design system doc**.
