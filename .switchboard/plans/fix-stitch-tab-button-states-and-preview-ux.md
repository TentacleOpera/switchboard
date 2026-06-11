# Stitch Tab UX Hardening: Button State Guards and Inline Screen Preview

## Goal
Fix three UX issues in the Switchboard Design Panel's Stitch tab:
1. Generate Screen button briefly starts enabled before the project list loads
2. Open DESIGN.md button is clickable without a selected project
3. Screen thumbnail click opens a blurry lightbox instead of a crisp inline preview

### Problem Analysis

#### Issue 1: Generate Screen Button Race Window
- `btn-generate-stitch` has no `disabled` attribute in the HTML template
- `setStitchBusy(false)` is only called after the async `stitchProjectsReady` message arrives from the extension host
- Between tab switch and project list response, the button is active and clickable
- A user can click Generate before a project is selected, which triggers a backend error toast

#### Issue 2: Open DESIGN.md Unguarded
- `btn-open-design-md` has no `disabled` attribute in the HTML template
- `setStitchBusy()` does not manage this button's disabled state
- The click handler unconditionally fires `stitchOpenManifest` even when no project is selected
- While the backend handler shows an info toast if the file does not exist, the button should be proactively disabled when no project is selected — consistent with the Sync Project to Workspace button behavior

#### Issue 3: Blurry Lightbox Preview
- Clicking a screen thumbnail opens the `#stitch-lightbox` modal overlay
- The lightbox reuses the same `imageUrl` returned for thumbnails, which is typically a moderate-resolution preview from the Stitch API
- Scaling this to `92vw`/`92vh` causes visible pixelation and blur
- The lightbox is a modal context switch; the user wants an inline "active screen" experience where the selected screen becomes the focal point
- Stitch image URLs are Google FIFE (Fast Image Fetch Engine) URLs, which support `=w<width>` and `=h<height>` suffixes for on-demand resolution scaling

## Metadata
**Complexity:** 5
**Tags:** frontend, ui, ux, bugfix

## User Review Required
- Confirm whether auto-previewing the most recent screen on every project load is desirable, or if it should be opt-in via a persisted setting (default off).

## Complexity Audit

### Routine
- Add `disabled` attributes to `#btn-generate-stitch` and `#btn-open-design-md` in `design.html`.
- Extend `setStitchBusy()` in `design.js` to guard `#btn-open-design-md`.

### Complex / Risky
- Replace modal `#stitch-lightbox` with an inline `#stitch-preview-pane` plus thumbnail strip.
- FIFE URL suffix logic must not break non-FIFE image URLs.
- Auto-preview on `stitchScreensReady` interacts with project switch, empty states, and manual close; state coordination is required.
- CSS transitions and layout shift when toggling between gallery and preview pane.
- Escape key handler now has dual responsibility (close preview pane or fall through).

## Edge-Case & Dependency Audit

### Race Conditions
- `stitchProjectsReady` sets `setStitchBusy(false)` after populating the dropdown; rapid tab switching may re-post `stitchListProjects`, but `setStitchBusy` is idempotent.
- `stitchProjectSelect.change` directly sets `btnSyncStitchProject.disabled = !projectId` outside `setStitchBusy`, creating an inconsistent guard path that should be consolidated.

### Security
- FIFE URL suffix must be gated by a domain/path check (e.g., `googleusercontent.com` or `/fife/`) to avoid appending `=w1200` to URLs that already contain query strings.
- The preview pane sets `img.src` to external URLs; this is acceptable because the CSP already permits `img-src https:`.

### Side Effects
- Removing the global Escape key listener for the lightbox reduces clutter, but the new preview-pane Escape handler must not block other overlays or modals that may be added later.
- Auto-preview on project load will hide the gallery by default, changing the user’s default context from a passive grid to an active preview.

### Dependencies & Conflicts
- No backend changes required.
- `design.html` and `design.js` are tightly coupled; changes must be deployed together.
- No conflicts with other tabs or panels.

## Dependencies
- None — self-contained frontend change.

## Adversarial Synthesis
Key risks: FIFE URL fragility (appending `=w1200` to non-FIFE URLs breaks images), layout shift from the new preview pane, and auto-preview potentially disorienting users who expect the gallery. Mitigations: gate the suffix with a regex that matches known FIFE domains/paths and falls back to the raw URL, use CSS transitions on `max-height` and `opacity`, and respect the user’s explicit close state when switching projects.

## Proposed Changes

### `src/webview/design.html`
- **Context:** Stitch tab markup and styles.
- **Logic:** Default-disable Generate and Open DESIGN.md buttons; remove `#stitch-lightbox` markup and styles; add `#stitch-preview-pane` and `#stitch-thumbnail-strip` markup and styles.
- **Implementation:**
  - Add `disabled` to `#btn-generate-stitch` (line ~3256) and `#btn-open-design-md` (line ~3241).
  - Remove `#stitch-lightbox` element (lines ~3274-3277) and its CSS rules (lines ~2954-2981).
  - Add `#stitch-preview-pane` (hidden by default) inside `#stitch-content` after the generation strip, containing:
    - Large image container (`flex: 1`, `max-height: 60vh`, `object-fit: contain`)
    - Close preview button
    - Screen title and device type label
    - Download HTML and Download PNG action buttons
    - Refinement input + Apply Edit button
  - Add `#stitch-thumbnail-strip` below the preview pane (hidden by default):
    - Horizontal scrollable row of compact screen thumbnails
    - Active thumbnail highlighted with an accent border
    - Each thumbnail clickable to swap the active preview
  - Retain `#stitch-gallery` as the default grid view.
- **Edge Cases:**
  - Buttons remain disabled when no project is selected.
  - Non-FIFE image URLs must not receive an invalid `=w1200` suffix.
  - Single-screen projects should either show a one-item strip or skip the strip for consistency.
  - Project switch must close any open preview before loading new screens.

### `src/webview/design.js`
- **Context:** Stitch UI controls and screen rendering.
- **Logic:** Extend `setStitchBusy`; remove lightbox functions; add preview pane open/close logic; update `renderStitchScreens` click handlers; auto-preview on `stitchScreensReady`; handle Escape and project switch.
- **Implementation:**
  - In `setStitchBusy(busy)` (line ~857), add `btnOpenDesignMd.disabled = busy || !hasProject`.
  - Remove `openStitchLightbox()`, `closeStitchLightbox()`, and all lightbox event listeners (lines ~873-891).
  - Add `makeFifeHighResUrl(imageUrl)`:
    - Only process if URL contains `/fife/` or `lh3.googleusercontent.com`.
    - Strip existing `=w\d+` or `=h\d+` suffixes via regex, then append `=w1200`.
    - Return raw URL unchanged if not a recognized FIFE pattern.
  - Add `activePreviewScreenId` to state (default `null`).
  - Add `openStitchPreview(screen)`:
    - Set `state.activePreviewScreenId = screen.id`.
    - Compute high-resolution URL via `makeFifeHighResUrl(screen.imageUrl)`.
    - Set the preview pane image `src` to the high-res URL.
    - Show `#stitch-preview-pane` and `#stitch-thumbnail-strip`; hide `#stitch-gallery`.
    - Populate the thumbnail strip with all screens, marking the active one.
    - Bind the refinement input and download buttons to the active screen.
  - Add `closeStitchPreview()`:
    - Hide the preview pane and thumbnail strip; restore `#stitch-gallery`.
  - Update `renderStitchScreens()` (line ~977):
    - Change the thumbnail click handler to call `openStitchPreview(screen)` instead of `openStitchLightbox(...)`.
    - Remove per-card refinement panels entirely; the single preview-pane input replaces them.
    - Keep existing card action buttons (DL HTML, DL PNG) functional.
    - If `state.activePreviewScreenId` matches a screen in the new list, refresh the preview pane image/src so it does not go stale.
  - Update the `stitchScreensReady` message handler (line ~1264):
    - Call `setStitchBusy(false)` to clear the busy gate set before `stitchGetProjectScreens`.
    - After `renderStitchScreens(msg.screens)`, if screens exist and `state.activePreviewScreenId` is null, call `openStitchPreview(screens[0])`.
  - Update the Escape key handler: if the preview pane is open, call `closeStitchPreview()` and `e.stopPropagation()`; otherwise preserve existing Escape behavior.
  - On `stitchProjectSelect.change` (line ~950):
    - Call `setStitchBusy(true)` before posting `stitchGetProjectScreens`.
    - If a preview is open, call `closeStitchPreview()` before posting.
- **Edge Cases:**
  - Screen with no `imageUrl` (still rendering): show the existing placeholder in the preview pane with the reload affordance; in the strip, show a compact text placeholder (e.g. "Rendering…").
  - Single screen: show the thumbnail strip with one item for consistency.
  - Project switch: automatically close any open preview, load new screens, then auto-preview the first screen of the new project.
  - No screens: the preview pane never opens; the empty state message remains visible.
  - User manually closes preview then switches project: the auto-preview should still fire for the new project (close-then-load is the same as a fresh load).
  - FIFE suffix on non-FIFE URLs: gate with a URL-pattern check and fall back to raw URL.

### `src/services/DesignPanelProvider.ts`
- **Context:** Backend screen formatting.
- **Logic:** No changes required.
- **Implementation:** None.
- **Edge Cases:** N/A

## Verification Plan

### Automated Tests
- **Button state tests:**
  - Simulate `stitchProjectsReady` with no projects; assert `#btn-generate-stitch` and `#btn-open-design-md` are `disabled`.
  - Simulate selecting a project; assert both buttons become `enabled`.
  - Simulate deselecting the project; assert both buttons return to `disabled`.
- **Preview pane tests:**
  - Post `stitchScreensReady` with mock screens; assert `#stitch-preview-pane` is visible, `#stitch-gallery` is hidden, and the first screen’s image `src` includes the high-res FIFE suffix (`=w1200` or `=w1600`).
  - Click a different thumbnail in the strip; assert the preview image `src` changes to the corresponding screen.
  - Press Escape; assert the preview pane and strip are hidden and the gallery is restored.
- **Project switch tests:**
  - Switch projects while a preview is open; assert the old preview closes, new screens load, and the first screen of the new project auto-previews.
  - Switch to a project with zero screens; assert the empty state remains and no preview pane appears.
- **Busy gate test:**
  - Simulate selecting a project; assert `setStitchBusy(true)` is called before `stitchGetProjectScreens` is posted, and buttons remain disabled during the flight.
- **Active preview refresh test:**
  - Post `stitchScreenReady` for a screen whose `id` matches `state.activePreviewScreenId`; assert the preview pane image `src` refreshes.
- **FIFE URL guard tests:**
  - Pass a FIFE-style URL to the helper; assert `=w1200` is appended.
  - Pass a non-FIFE URL (e.g., with query parameters or a different domain); assert the raw URL is returned unchanged.

> **Note:** Automated tests are not run in this session; they are provided as the verification specification for the user to execute separately.

**Recommendation:** Send to Coder
