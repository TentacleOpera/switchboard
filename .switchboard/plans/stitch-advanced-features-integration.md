# Stitch SDK Advanced Features Integration

## Goal
Add support for Stitch SDK advanced features to the Switchboard Design Panel: model selection (GEMINI_3_1_PRO vs GEMINI_3_FLASH), creative range for variants (EXPLORE, REFINE, REIMAGINE), and aspect targeting (LAYOUT, COLOR_SCHEME, IMAGES, TEXT_FONT, TEXT_CONTENT).

## Problem Analysis
The current Stitch integration in Switchboard uses basic SDK methods with default parameters. Users cannot control:
- Which AI model powers generation/editing (speed vs quality tradeoff)
- How creative the variant generation should be (exploration vs refinement)
- Which design aspects to target when generating variants

The Stitch SDK v0.3.5 exposes these parameters, but they are not wired up in the Switchboard UI or backend message handlers. This limits the power of the integration compared to the web Stitch interface.

## Background Context
- Current implementation: `DesignPanelProvider.ts` handles Stitch operations via message handlers
- Web UI reference: Stitch web interface has mode presets (Ideate, Flash, Thinking, Redesign) that combine these parameters
- SDK capabilities: Documented in GitHub repo showing `modelId`, `creativeRange`, and `aspects` parameters
- User expectation: Designers want fine-grained control over generation behavior

## Metadata
**Tags:** ui, backend, feature, api
**Complexity:** 5

## User Review Required
None — this plan is fully self-contained and ready for execution. The scope is additive only.

## Complexity Audit

### Routine
- Adding HTML dropdowns and checkboxes to existing Stitch controls section
- Wiring input values into `vscode.postMessage()` payloads
- Adding `package.json` configuration properties
- Reading persisted state from `vscode.getState()`

### Complex / Risky
- SDK `edit()` has positional parameters: `edit(prompt, deviceType?, modelId?)`. Current UI never sends `deviceType` for edits. Must pass `undefined` explicitly for `deviceType` to position `modelId` correctly.
- SDK `variants()` takes `VariantOptions` object; `aspects` field is an enum array. Behavior of empty array `[]` vs `undefined` is untested. Must normalize "no aspects checked" to `undefined`, not `[]`.
- `modelId` and `creativeRange` values must match SDK enums exactly. No runtime enum map exists in the codebase.

## Edge-Case & Dependency Audit

**Race Conditions**
- None introduced. All state is per-webview; no shared mutable state across instances.

**Security**
- No new secrets. `modelId` and `creativeRange` are client-side choices passed to the SDK. No exposure of API keys or tokens.

**Side Effects**
- None beyond existing Stitch network calls.

**Dependencies & Conflicts**
- Depends on `@google/stitch-sdk` v0.3.5. Parameter signatures verified from `node_modules` types:
  - `project.generate(prompt, deviceType?, modelId?)` — `@/Users/patrickvuleta/Documents/GitHub/switchboard/node_modules/@google/stitch-sdk/dist/generated/src/project.d.ts:25`
  - `screen.edit(prompt, deviceType?, modelId?)` — `@/Users/patrickvuleta/Documents/GitHub/switchboard/node_modules/@google/stitch-sdk/dist/generated/src/screen.d.ts:24`
  - `screen.variants(prompt, variantOptions, deviceType?, modelId?)` — `@/Users/patrickvuleta/Documents/GitHub/switchboard/node_modules/@google/stitch-sdk/dist/generated/src/screen.d.ts:29`
  - `VariantOptions` has `aspects?: Enum[]` and `creativeRange?: Enum` — `@/Users/patrickvuleta/Documents/GitHub/switchboard/node_modules/@google/stitch-sdk/dist/generated/src/types.generated.d.ts:209-212`
- No other workspace dependencies. No ClickUp/Linear/external service coupling.

## Dependencies
None — standalone feature enhancement within the existing Stitch integration.

## Adversarial Synthesis
Key risks: (1) Positional parameter trap in `screen.edit()` where `modelId` could be misaligned with `deviceType`, (2) Empty `aspects` array causing SDK rejection versus graceful fallback to all aspects, (3) Enum string drift if SDK updates rename values, (4) `GEMINI_3_PRO` is deprecated in SDK v0.3.5 enum descriptions — offering it would ship a deprecated model to users. Mitigations: explicit `undefined` pass-through for optional positional args, normalize unchecked aspects to `undefined`, pin enum strings to SDK v0.3.5 definitions, and substitute `GEMINI_3_1_PRO` for the deprecated `GEMINI_3_PRO` in UI and config.

## Proposed Changes

### `src/services/DesignPanelProvider.ts`
- **Context:** Message handlers at lines 613 (`stitchGenerate`), 630 (`stitchEdit`), 642 (`stitchVariants`).
- **Logic:** Extract optional `modelId`, `creativeRange`, and `aspects` from the message payload and pass through to SDK methods. Normalize `aspects`: if empty array, pass `undefined`.
- **Implementation:**
  1. `stitchGenerate` (line 622): Change `projectInstance.generate(message.prompt, message.deviceType)` to `projectInstance.generate(message.prompt, message.deviceType, message.modelId)`.
  2. `stitchEdit` (line 634): Change `screen.edit(message.prompt)` to `screen.edit(message.prompt, undefined, message.modelId)`. **Critical:** `deviceType` is not sent by UI for edits; pass `undefined` explicitly so `modelId` lands in the third slot.
  3. `stitchVariants` (line 646): Change `screen.variants(message.prompt, { variantCount: message.count || 3 })` to:
     ```ts
     const aspects = message.aspects?.length ? message.aspects : undefined;
     const variantOptions = {
       variantCount: message.count || 3,
       creativeRange: message.creativeRange,
       aspects
     };
     const list = await screen.variants(message.prompt, variantOptions, undefined, message.modelId);
     ```
     **Critical:** Pass `undefined` for `deviceType` (fourth positional arg is `modelId`).
- **Edge Cases:**
  - If `message.modelId` is missing/undefined, SDK uses default — acceptable.
  - If `message.creativeRange` is missing, SDK uses default — acceptable.
  - If `message.aspects` is `[]`, normalize to `undefined` to avoid SDK rejection.

### `src/webview/design.html`
- **Context:** Generation controls strip starts at line 3329. Preview refine controls at line 3362.
- **Logic:** Add model selector to generation strip; add creative range dropdown and aspect checkboxes to preview refine panel.
- **Implementation:**
  1. In generation strip (after `stitch-device-select`):
     ```html
     <select id="stitch-model-select" class="workspace-filter-select" style="max-width: 150px;">
         <option value="GEMINI_3_FLASH">Flash (Fast)</option>
         <option value="GEMINI_3_1_PRO">Pro (Quality)</option>
     </select>
     ```
  2. In preview refine panel (before variant buttons):
     ```html
     <select id="stitch-creative-range-select" class="workspace-filter-select" style="max-width: 140px;">
         <option value="EXPLORE">Explore</option>
         <option value="REFINE">Refine</option>
         <option value="REIMAGINE">Reimagine</option>
     </select>
     <div id="stitch-aspects-checkboxes" style="display: flex; gap: 8px; flex-wrap: wrap;">
         <label><input type="checkbox" value="LAYOUT" checked> Layout</label>
         <label><input type="checkbox" value="COLOR_SCHEME" checked> Color</label>
         <label><input type="checkbox" value="IMAGES" checked> Images</label>
         <label><input type="checkbox" value="TEXT_FONT" checked> Font</label>
         <label><input type="checkbox" value="TEXT_CONTENT" checked> Text</label>
     </div>
     ```
- **Edge Cases:** Responsive wrapping in controls strip. Ensure checkboxes don't overflow narrow panel.

### `src/webview/design.js`
- **Context:** State object at line 7. `btnGenerateStitch` click handler at line 1093. `previewBtnEdit` at line 980. `previewBtnVariants` at line 993.
- **Logic:** Read new control values, include in message payloads, persist in `vscode.getState()`.
- **Implementation:**
  1. Add to state initialization:
     ```js
     stitchModelId: persistedState.stitchModelId || 'GEMINI_3_FLASH',
     stitchCreativeRange: persistedState.stitchCreativeRange || 'EXPLORE',
     stitchAspects: persistedState.stitchAspects || ['LAYOUT','COLOR_SCHEME','IMAGES','TEXT_FONT','TEXT_CONTENT']
     ```
  2. On `stitchGenerate` click (line 1104), add `modelId: state.stitchModelId` to the payload.
  3. On `stitchEdit` (line 987), add `modelId: state.stitchModelId` to the payload.
  4. On `stitchVariants` (line 1002), add:
     ```js
     creativeRange: state.stitchCreativeRange,
     aspects: state.stitchAspects.filter(a => /* checked */)
     ```
     Build aspects array from checked boxes each time. If none checked, send `undefined` (or omit key).
  5. On control change, update `state` and call `vscode.setState(state)`.
  6. On panel init, restore control values from `state`.
- **Edge Cases:**
  - If persisted state contains invalid enum strings, fall back to defaults.
  - If `stitchAspects` is corrupted (not an array), reset to all-checked defaults.

### `package.json`
- **Context:** Configuration block at line 168. Existing Stitch settings at lines 180-197.
- **Logic:** Add two optional workspace-level defaults.
- **Implementation:** After `switchboard.stitch.defaultOutputFolder` (line 197), insert:
  ```json
  "switchboard.stitch.defaultModelId": {
      "type": "string",
      "enum": ["GEMINI_3_FLASH", "GEMINI_3_1_PRO"],
      "default": "GEMINI_3_FLASH",
      "description": "Default AI model for Stitch generation.",
      "scope": "resource"
  },
  "switchboard.stitch.defaultCreativeRange": {
      "type": "string",
      "enum": ["EXPLORE", "REFINE", "REIMAGINE"],
      "default": "EXPLORE",
      "description": "Default creative range for Stitch variant generation.",
      "scope": "resource"
  }
  ```
- **Edge Cases:** If config is absent, UI defaults handle it. No breaking change.

## Verification Plan

### Automated Tests
- Parameter-passing unit tests for `DesignPanelProvider.ts` message handlers (mock `loadStitch` and assert called with correct positional args).
- UI state persistence test: simulate control changes, verify `vscode.setState` payload includes new fields.
- Validation: `aspects` normalization — input `[]` produces `undefined` in SDK call.

### Manual / Integration Testing
- Generate screen with GEMINI_3_1_PRO vs GEMINI_3_FLASH — observe quality/speed difference.
- Generate variants with each creative range — verify behavior differences.
- Generate variants with specific aspects selected — verify only targeted aspects change.
- Test UI controls visible and functional after panel reopen.
- Test edge cases: no aspects checked (should behave as all aspects), all aspects checked (should behave as all aspects).

## Edge Cases (Consolidated)
1. **No aspects selected:** UI normalizes to `undefined` (all aspects). Never pass empty array `[]` to SDK.
2. **Invalid modelId:** SDK rejects with error message. Backend passes error through `stitchError` message; UI displays it.
3. **Invalid creativeRange:** Same as above — SDK rejection bubbles to user.
4. **State corruption:** If `vscode.getState()` returns invalid enum strings or malformed arrays, fall back to hard-coded defaults on init.
5. **Positional parameter misalignment in `edit()`:** Without explicit `undefined` for `deviceType`, `modelId` would be swallowed. Implementation uses `screen.edit(prompt, undefined, modelId)`.
6. **All aspects checked:** Equivalent to `undefined` — UI may send `undefined` or the full array; both are valid per SDK types.

## Remaining Risks
1. **SDK version compatibility:** If `@google/stitch-sdk` updates and renames enum values, integration breaks. Mitigation: pin to `^0.3.5` in `package.json` and test on SDK bumps.
2. **UI clutter:** Adding more controls may overwhelm the Stitch tab. Mitigation: place new controls in the existing generation strip and preview panel; no new sections.
3. **Performance:** GEMINI_3_1_PRO may be significantly slower. No new loading indicators needed; existing `stitchBusy` flag already blocks concurrent operations.
4. **Cost:** Pro model may have different pricing. No visibility from SDK. Acceptable — user makes explicit model choice.

## Success Criteria
- Users can select between GEMINI_3_FLASH and GEMINI_3_1_PRO for generation/editing.
- Users can select creative range (EXPLORE/REFINE/REIMAGINE) for variant generation.
- Users can target specific aspects when generating variants.
- UI controls persist across panel close/reopen.
- Error handling provides clear feedback for invalid parameters.

**Recommendation:** Send to Coder
