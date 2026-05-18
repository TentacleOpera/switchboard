# Fix Prompts Tab UI

## Problem
The prompts tab in `kanban.html` has a confusing UX: a separate "Prompt Customization" textarea, a separate read-only "Preview" textarea below it, and a manual "Refresh Preview" button. Users want to edit the prompt directly where they see it.

## Goals
- Remove the separate prompt customization textarea
- Make the preview area editable and move it above the add-ons list (in place of the customization section)
- Remove the "Refresh Preview" button
- Auto-update the preview when role or add-ons change

## Files to Change
- `src/webview/kanban.html`

## Implementation Steps

### 1. HTML Structure Changes
In the prompts tab (`#prompts-tab-content`):
- **Remove** the entire `#promptCustomization` div (lines ~2206-2226) containing the "Prompt Customization" subsection and `#rolePromptTextarea`
- **Move** the Preview section (currently lines ~2228-2238) so it sits inside `#promptCustomization`'s former location — above the "Add-ons" subsection within the non-planner role config block
- **Remove** the `#refreshPreview` button from the preview section header
- **Remove** the `readonly` attribute from `#promptPreview`

The resulting structure for non-planner roles should be:
```
#promptCustomization (renamed or kept as container)
  ├─ Preview subsection (editable textarea)
  └─ Add-ons subsection (checkboxes)
```

### 2. CSS Changes
- Remove or repurpose the `#rolePromptTextarea` styles if no longer needed
- Ensure `#promptPreview` remains styled as a textarea (already has `#promptPreview` styles)

### 3. JavaScript Changes
- **Remove** the `rolePromptTextarea` change listener (currently saves to `roleConfigs[currentRole].prompt`)
- **Add** a `change` listener on `#promptPreview` that saves its value to `roleConfigs[currentRole].prompt` and calls `saveRoleConfig(currentRole)`
- **Update** `refreshPreview()`: remove the manual button wiring; keep the function so it can be called programmatically when the role changes or add-ons toggle
- **Ensure** `onRoleChange` still calls `refreshPreview()` after loading the role's config
- **Ensure** add-on toggles still call `refreshPreview()` after saving

### 4. Backend / Data Flow
No backend changes needed. The existing `getPromptPreview` / `promptPreviewResult` message flow remains:
- On role switch, frontend requests preview → backend composes and returns it → editable textarea is populated
- When user edits the preview textarea directly, the override text is saved to `roleConfigs[currentRole].prompt` via the existing `saveSetting` message path
- The next time that role's preview is generated, `buildKanbanBatchPrompt` will use the saved override text (via `defaultPromptOverrides` loaded from workspace state)

### 5. Testing
- Verify switching roles loads the correct preview into the editable area
- Verify editing the preview and switching away then back persists the edit
- Verify add-on toggles refresh the preview automatically
- Verify no "Refresh Preview" button exists
- Verify no separate "Prompt Customization" textarea exists
