# Stitch Design Prompt Generator — Inspiration-to-Text Bridge

## Goal

Add a "Design Prompt Generator" modal to the Stitch tab in `design.html` that lets users describe a design intent and attach inspiration images. The generator composes a meta-prompt (base template + user instruction + image references), copies it to the clipboard. The user then pastes the agent's refined design prompt into the existing Stitch prompt input and generates the screen.

**Core Problem:** The Google Stitch SDK's `Project.generate()` method accepts only a text `prompt` and `deviceType`. There is no native `inspirationImage`, `referenceFile`, or `upload` parameter for screen generation. This means users who have visual inspiration (screenshots, mockups, competitor UI) cannot feed that directly into Stitch.

**Background:** The existing workaround in the codebase is `Project.upload()`, which creates a *new screen canvas* from an image file — not a *new screen generated from* an image. These are semantically different operations.

**Root Cause:** Stitch's API is text-prompt-only. The only way to incorporate visual inspiration is to have an intermediate agent inspect the images and distill them into a detailed text prompt that `generate()` can consume.

**Pattern Precedent:** The planning panel already solves a similar problem with its "Research Prompt Generator": a meta-prompt workflow where the user describes a topic, clicks a button to generate a structured prompt template, copies it to an IDE agent, and pastes the agent's refined output back. This same pattern can be adapted for the Design panel's Stitch tab.

## Metadata

- **Tags:** frontend, ui, ux, feature
- **Complexity:** 5

## User Review Required

- None. Scope is purely additive UI within the Stitch tab.

## Complexity Audit

### Routine
- Adding a button and modal markup to existing HTML structure.
- Composing a static string template with user input interpolation.
- Clipboard copy with try/catch feedback (already used in `planning.js`).
- Event listener wiring for open/close/copy.

### Complex / Risky
- Modal CSS must be inlined in `design.html` because each webview is self-contained; `planning.html` styles do not share.
- Local file thumbnails in VS Code webview require `URL.createObjectURL()` from a `<input type="file">` FileList — needs explicit implementation detail.
- `setStitchBusy()` must be extended to disable the new generator button; missing this creates a race-condition where a user can open the generator while Stitch is busy.
- Modal open/close state is not persisted via `vscode.setState()`; acceptable for MVP but means modal closes on webview hide.

## Requirements

### Functional

1. **Generator Button**: Add a "Prompt Generator" button next to the existing "Generate Screen" button in the Stitch tab's controls strip.
2. **Modal UI**: Clicking the button opens a modal with:
   - A textarea for the user's design description/intent (e.g. "A cyberpunk dashboard with neon teal accents").
   - An image attachment area supporting:
     - Local file picker (PNG, JPG, WEBP).
     - Optional URL input for remote images.
   - A preview/thumbnail strip of attached images.
   - A "Copy Prompt" button.
   - A close button.
3. **Prompt Composition**: The generated meta-prompt must include:
   - A base template instructing the agent to act as a UI/UX design prompt engineer.
   - The user's design description verbatim.
   - References to attached images (file paths or URLs) so the agent can inspect them.
   - Instructions to output a single, detailed text prompt suitable for Stitch's `generate()` API.
4. **Clipboard Copy**: Clicking "Copy Prompt" copies the composed meta-prompt to the system clipboard and shows temporary "COPIED" feedback.
5. **Auto-fill**: After copying the prompt and running it through an IDE agent, the user manually pastes the agent's refined output into the existing `#stitch-prompt-input`.

### Non-Functional

- Reuse existing modal CSS patterns from `planning.html` (e.g. `.folder-modal`, `.duplicate-modal`) to maintain visual consistency.
- Keep all new UI scoped to the Stitch tab (`#stitch-content`).
- No external dependencies beyond what's already in the webview.
- The feature must work entirely within the VS Code webview sandbox (no direct filesystem access from the frontend; image paths/URLs are referenced textually in the prompt).

## Edge-Case & Dependency Audit

- **Race Conditions:** If the user clicks "Copy Prompt" while `stitchBusy` is true, the generator button must be disabled. `setStitchBusy()` is the single source of truth for this gating.
- **Security:** No user input is executed; it is only interpolated into a static meta-prompt string. File paths are referenced textually, not read by the webview. No XSS vector beyond existing DOM text insertion (which already uses `.textContent` or template literals).
- **Side Effects:** Clipboard write only. No state mutation in the extension host. Modal state is ephemeral (not persisted to `vscode.setState()`).
- **Dependencies & Conflicts:** None. Purely additive to `design.html` and `design.js`. No shared CSS file exists between webviews, so modal styles must be duplicated/ adapted into `design.html`.

## Dependencies

- None

## Adversarial Synthesis

Key risks: (1) `setStitchBusy()` omits the new generator button, enabling a race condition; (2) self-contained webview means modal CSS from `planning.html` must be physically copied into `design.html`; (3) local file thumbnails require `URL.createObjectURL()` which the plan originally omitted. Mitigations: extend `setStitchBusy()` with the new button selector, add a `.stitch-prompt-modal` CSS block to `design.html`, and implement thumbnail rendering with `URL.createObjectURL()` paired with cleanup on modal close.

## Proposed Changes

### `src/webview/design.html`
- **Context:** The Stitch tab currently has a controls strip with `#btn-generate-stitch`. The new button sits immediately before it.
- **Logic:**
  1. Add `<button id="btn-stitch-prompt-generator" class="strip-btn">Prompt Generator</button>` inside the generation strip (next to `#btn-generate-stitch`).
  2. Add modal markup at the end of `#stitch-content` (after the gallery):
     ```html
     <div id="stitch-prompt-modal" class="stitch-prompt-modal" style="display: none;">
       <div class="modal-content">
         <div class="modal-header">
           <h3>Design Prompt Generator</h3>
           <button class="modal-close-btn" id="btn-close-stitch-generator">&times;</button>
         </div>
         <div class="modal-body">
           <textarea id="stitch-generator-input" rows="4" placeholder="Describe the UI you want..."></textarea>
           <input type="file" id="stitch-generator-image-input" accept="image/png,image/jpeg,image/webp" multiple />
           <div id="stitch-generator-thumbnails"></div>
           <button id="btn-copy-stitch-prompt" class="strip-btn stitch-btn-primary">Copy Prompt</button>
         </div>
       </div>
     </div>
     ```
  3. Add `.stitch-prompt-modal` CSS in the `<style>` block (adapted from `planning.html` `.folder-modal`):
     - `position: fixed; inset: 0; background: rgba(0,0,0,0.6); display: flex; align-items: center; justify-content: center; z-index: 1000;`
     - `.modal-content`: `background: var(--panel-bg); border: 1px solid var(--border-color); border-radius: 8px; max-width: 520px; width: 90%; max-height: 80vh; display: flex; flex-direction: column; box-shadow: var(--shadow-md);`
     - `.modal-header`, `.modal-body`, `.modal-close-btn` matching existing modal patterns.
     - Thumbnail strip: flex row, gap 8px, max-height 80px, overflow-x auto.
     - Add `.cyber-theme-enabled .stitch-prompt-modal .modal-content` with `backdrop-filter: blur(12px)` and semi-transparent background to match cyber theme.
- **Edge Cases:** Modal markup is hidden by default (`display: none`) so it does not affect layout. CSS names are prefixed with `stitch-` to avoid collision with any future shared modal classes.

### `src/webview/design.js`
- **Context:** `design.js` owns Stitch tab state and event wiring. `setStitchBusy()` gates all Stitch actions.
- **Logic:**
  1. Add state keys: `stitchGeneratorOpen: false`, `stitchGeneratorImages: []` (ephemeral, not persisted).
  2. Add DOM references:
     ```js
     const btnStitchPromptGenerator = document.getElementById('btn-stitch-prompt-generator');
     const stitchPromptModal = document.getElementById('stitch-prompt-modal');
     const btnCloseStitchGenerator = document.getElementById('btn-close-stitch-generator');
     const stitchGeneratorInput = document.getElementById('stitch-generator-input');
     const stitchGeneratorImageInput = document.getElementById('stitch-generator-image-input');
     const stitchGeneratorThumbnails = document.getElementById('stitch-generator-thumbnails');
     const btnCopyStitchPrompt = document.getElementById('btn-copy-stitch-prompt');
     ```
  3. Extend `setStitchBusy(busy)`:
     ```js
     if (btnStitchPromptGenerator) btnStitchPromptGenerator.disabled = busy;
     if (btnCopyStitchPrompt) btnCopyStitchPrompt.disabled = busy || state.stitchGeneratorImages.length === 0 && !stitchGeneratorInput?.value.trim();
     ```
     *(Clarification: disable Copy Prompt when busy OR when both description and images are empty.)*
  4. Implement `openStitchGenerator()` / `closeStitchGenerator()`:
     - Toggle `stitchPromptModal.style.display` between `flex` and `none`.
     - On close: clear `stitchGeneratorImages`, revoke object URLs (`URL.revokeObjectURL`), clear thumbnail container, clear textarea.
  5. Implement file picker handler:
     - On `change` of `stitchGeneratorImageInput`, iterate `files`, create object URLs (`URL.createObjectURL(file)`), push to `stitchGeneratorImages`, render `<img>` thumbnails in `stitchGeneratorThumbnails`.
  6. Implement `generateStitchMetaPrompt(userDescription, imageRefs)`:
     - Returns the base template string with `{{USER_DESCRIPTION}}` replaced by `userDescription` and `{{IMAGE_REFS}}` replaced by a bulleted list of image refs (file names for local files, URLs for remote input — remote URL input is out of scope for MVP but the template accepts it).
  7. Implement `copyStitchPromptToClipboard()`:
     - Compose prompt via `generateStitchMetaPrompt()`.
     - `await navigator.clipboard.writeText(prompt)`.
     - Set `btnCopyStitchPrompt.innerText = 'COPIED'`, revert after 2000ms.
     - Catch block sets `innerText = 'FAILED'`, reverts after 2000ms.
  8. Wire listeners:
     - `btnStitchPromptGenerator` -> `openStitchGenerator()`
     - `btnCloseStitchGenerator` / click on modal overlay -> `closeStitchGenerator()`
     - `btnCopyStitchPrompt` -> `copyStitchPromptToClipboard()`
     - `stitchGeneratorImageInput` -> file picker handler
- **Edge Cases:** If modal is open and webview is hidden, state is lost — acceptable for MVP. If clipboard API throws, user sees "FAILED". Object URLs are revoked on modal close to prevent memory leaks.

## Implementation Steps

### Phase 1 — Clipboard-Only Workflow (MVP)

1. **HTML** (`src/webview/design.html`):
   - Add a "Prompt Generator" button (`#btn-stitch-prompt-generator`) to the Stitch controls strip, next to `#btn-generate-stitch`.
   - Add a modal section within or alongside `#stitch-content`:
     - Overlay div with `.stitch-prompt-modal` class.
     - Modal content with textarea (`#stitch-generator-input`), image attachment input (`#stitch-generator-image-input`), thumbnail strip, and action buttons.
   - Reuse CSS variables and modal structure from `planning.html`.

2. **CSS** (`src/webview/design.html` `<style>`):
   - Add `.stitch-prompt-modal` styles (overlay, backdrop blur, modal card layout).
   - Add `.stitch-generator-thumb` styles for image thumbnails.
   - Ensure styles respect the existing cyber-theme CSS variables.

3. **JavaScript** (`src/webview/design.js`):
   - Add state keys: `stitchGeneratorOpen`, `stitchGeneratorImages: []`.
   - Add DOM element references for the new modal controls.
   - Implement `openStitchGenerator()` / `closeStitchGenerator()`.
   - Implement `generateStitchMetaPrompt(userDescription, imageRefs)`:
     - Composes a meta-prompt string with a static base template + user description + image references.
   - Implement `copyStitchPromptToClipboard()` using `navigator.clipboard.writeText()` with feedback animation (same pattern as `planning.js`).
   - Wire event listeners for the generator button, close button, file picker change, and copy button.
   - Respect `state.stitchBusy` — disable generator button when busy.

4. **Base Prompt Template** (hardcoded in `design.js`; not user-editable):
   ```
   You are a UI/UX design prompt engineer. Your job is to transform a rough design idea and reference images into a single, detailed, high-quality text prompt suitable for an AI screen generator (Stitch by Google).

   User's design intent:
   ---
   {{USER_DESCRIPTION}}
   ---

   Reference images (inspect these for style, layout, colour palette, typography, and mood):
   {{IMAGE_REFS}}

   Output a single paragraph prompt (150-400 words) that describes:
   - The overall layout and visual hierarchy
   - Colour palette and mood
   - Typography style
   - Specific UI components and their arrangement
   - Any animations, interactions, or micro-copy
   - Device type considerations

   Do not output markdown headers, bullet lists, or explanations. Output only the final prompt text.
   ```

## Files to Change

| File | Change Type | Description |
|------|-------------|-------------|
| `src/webview/design.html` | Add | Generator button, modal markup, CSS styles |
| `src/webview/design.js` | Add | Modal logic, prompt composition, clipboard copy, event wiring |

## Verification Plan

### Automated Tests
- None required. The feature is pure webview UI with no extractable logic functions exposed to Node/Jest. All behavior is DOM-event driven inside a VS Code webview. Manual validation checklist below serves as the acceptance criteria.

### Manual Validation
- [ ] Generator button appears in Stitch tab controls strip, left of "Generate Screen".
- [ ] Modal opens on button click; closes on X or overlay click.
- [ ] File picker allows selecting local images (PNG, JPG, WEBP); thumbnails display in a horizontal strip.
- [ ] "Copy Prompt" copies a composed meta-prompt containing the user description and image file names.
- [ ] Clipboard feedback shows "COPIED" for ~2s then reverts to "Copy Prompt".
- [ ] Generator button is disabled when a Stitch generation/edit/variant/sync is in progress (`stitchBusy === true`).
- [ ] Modal does not interfere with existing Stitch generate/edit/variant flows.
- [ ] Cyber theme (`theme-claudify`) renders modal with glass backdrop and correct border/accent colours.

## Out of Scope (Future Considerations)

- Drag-and-drop from the Design/HTML preview panes.
- Auto-dispatch to a Switchboard agent (Phase 2 agent integration).
- User-editable prompt template via settings.

## Review Findings

Implementation is materially complete and matches all functional requirements. Two issues were found and fixed in-place: (1) `updateCopyButtonState()` was never called on initialization, leaving the "Copy Prompt" button enabled when the modal was empty — fixed by adding an immediate call after event listener wiring in `design.js:1222`; (2) the cyber-theme `backdrop-filter` was `blur(10px)` instead of the plan-specified `blur(12px)` — fixed in `design.html:3313`. Files changed: `src/webview/design.js`, `src/webview/design.html`. No compilation or test step required. Remaining risk: modal state is still ephemeral (not persisted via `vscode.setState()`), which is explicitly acceptable per the plan's MVP scope.

## Recommendation

**Send to Coder**
