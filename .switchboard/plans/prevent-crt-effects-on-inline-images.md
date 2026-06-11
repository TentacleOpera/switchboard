# Plan: Prevent CRT Scanline Effects on Inline Images in Preview Panes

## Metadata
- **Complexity:** 3
- **Tags:** ui, ux, bugfix, frontend

## Goal
The goal of this change is to ensure that inline images loaded inside the document preview panes (such as ClickUp or Linear tab content) do not have the Switchboard theme's CRT scanline overlays or sweep beam animations rendered on top of them.

### Core Problem & Root Cause Analysis
In `planning.html` and `design.html`, the cyber/Switchboard theme includes a retro CRT scanline overlay (`.cyber-scanlines`) and scanline sweep animation (`.cyber-scanlines::before`) set at `z-index: 5` and overlaying the entire preview pane wrapper. Because inline images (rendered inside markdown documents in `#markdown-preview`, `#markdown-preview-online`, etc.) do not have positioning and `z-index` set, they render below this overlay layer. Consequently, horizontal scanlines and colored sweep gradients are overlaid on top of images, rendering them distorted and aesthetically unappealing.

To fix this, inline images in the preview panes should be elevated above the `.cyber-scanlines` overlay (`z-index: 5`) and sweep beam context.

---

## User Review Required
- [ ] Confirm whether the `z-index: 7` value is acceptable or if a different stacking value is preferred.
- [ ] Confirm if any other media types (e.g., `<video>`, `<iframe>`, `<canvas>`) inside markdown previews should also be exempted from scanline overlays. *(Clarification: not in current scope; images are the primary affected element.)*

---

## Complexity Audit

### Routine
- Two-file CSS-only change.
- Identical selector blocks; copy-paste safe.
- No logic or state changes.
- No new dependencies.

### Complex / Risky
- None

---

## Edge-Case & Dependency Audit

### Race Conditions
- None. CSS is declarative; no runtime timing issues.

### Security
- None. `z-index` and `position` changes do not affect XSS, CSP, or content sanitization boundaries.

### Side Effects
- `position: relative` on images creates a new stacking context. This should not affect surrounding text or layout because no offset values (`top`, `left`, etc.) are applied.
- If any future overlay elements are introduced between `z-index: 5` and `z-index: 7`, images may inadvertently render above them. The current gap of two levels provides modest headroom.

### Dependencies & Conflicts
- No dependencies on other plans.
- No conflicting PRs expected.

---

## Dependencies
- None

---

## Adversarial Synthesis
Key risks: (1) The original plan only addressed `planning.html`, but `design.html` contains an identical CSS block and `.cyber-scanlines` overlay, so images in the Design view would remain distorted. (2) `z-index: 7` is arbitrary but safe given the scanlines layer is at `5`. (3) `position: relative` on previously static images is benign since no offsets are applied. Mitigations: Apply the fix to both `planning.html` and `design.html`, document the stacking rationale in a CSS comment, and verify no layout shifts occur.

---

## Proposed Changes

### Webview Styles (`planning.html`)
Update the preview container image CSS rule in `src/webview/planning.html` to set `position: relative` and a `z-index` of `7` to place them above the `.cyber-scanlines` overlay which has a `z-index` of `5` (and its nested `::before` content).

**File**: `src/webview/planning.html`

**Current CSS** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html:1299-1306`):
```css
        #markdown-preview img,
        #markdown-preview-online img,
        #markdown-preview-design img,
        #kanban-preview-pane img,
        #markdown-preview-tickets img {
            max-width: 100%;
            max-height: 100%;
        }
```

**Proposed CSS**:
```css
        #markdown-preview img,
        #markdown-preview-online img,
        #markdown-preview-design img,
        #kanban-preview-pane img,
        #markdown-preview-tickets img {
            max-width: 100%;
            max-height: 100%;
            position: relative;
            z-index: 7; /* Above .cyber-scanlines (z-index: 5) and sweep animation to prevent overlay distortion */
            box-shadow: 0 0 6px rgba(0, 0, 0, 0.4); /* Intentional elevation so the pop-out above scanlines looks designed */
        }
```

### Webview Styles (`design.html`)
`design.html` contains an identical CSS block and `.cyber-scanlines` overlay. Apply the same fix there.

**File**: `src/webview/design.html`

**Current CSS** (`@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/design.html:1314-1321`):
```css
        #markdown-preview img,
        #markdown-preview-online img,
        #markdown-preview-design img,
        #kanban-preview-pane img,
        #markdown-preview-tickets img {
            max-width: 100%;
            max-height: 100%;
        }
```

**Proposed CSS**:
```css
        #markdown-preview img,
        #markdown-preview-online img,
        #markdown-preview-design img,
        #kanban-preview-pane img,
        #markdown-preview-tickets img {
            max-width: 100%;
            max-height: 100%;
            position: relative;
            z-index: 7; /* Above .cyber-scanlines (z-index: 5) and sweep animation to prevent overlay distortion */
            box-shadow: 0 0 6px rgba(0, 0, 0, 0.4); /* Intentional elevation so the pop-out above scanlines looks designed */
        }
```

---

## Verification Plan

### Manual Verification
1. Open the Switchboard panel and select the **ClickUp** / **Linear** or **Online Docs** tab.
2. Enable the **Cyber Theme** (or a theme that activates `.cyber-theme-enabled`).
3. Load a document containing an inline image.
4. Verify that the image is rendered clearly without any horizontal scanlines or CRT gradient sweeps overlaid on top of it.
5. Verify that surrounding text and layout elements still receive the CRT scanline effects correctly.
6. Repeat steps 1-5 in the **Design** view tab to confirm the `design.html` fix.

### Automated Tests
- Not applicable for this session. Automated tests will be run separately by the user.

---

**Recommendation:** Send to Intern
