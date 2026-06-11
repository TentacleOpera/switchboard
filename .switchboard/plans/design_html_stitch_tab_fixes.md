# Plan: design.html Stitch Tab Fixes

## Goal
Fix two UI inconsistencies in the Stitch tab of the Switchboard Design Panel (`src/webview/design.html`).

## Background
The Stitch tab is missing the cyber-theme glass overlay background grid that all other tabs have. Additionally, the empty-state message contains a paint palette emoji (🎨) that does not match the clean, minimal aesthetic of the rest of the panel.

## Root Cause Analysis
- **Glass overlay missing:** The cyber-theme CSS rules that apply `backdrop-filter: blur(6px)` and the accent grid background image explicitly list `#preview-pane`, `#preview-pane-online`, `#preview-pane-design`, `#preview-pane-html`, and `#preview-pane-tickets`, but omit `#stitch-preview-pane`. The transparent background rule for tab content wrappers also omits `#stitch-content`.
- **Emoji present:** The `#stitch-gallery-empty` HTML block includes a `<span>` with the `🎨` emoji, which was likely added during early prototyping and never removed.

## Metadata
- **Tags:** frontend, ui, bugfix
- **Complexity:** 2

## User Review Required
No

## Complexity Audit

### Routine
- Append one CSS selector to an existing glassmorphism rule block.
- Append one CSS selector to an existing transparent-background rule block.
- Delete a single `<span>` element from an empty-state HTML block.

### Complex / Risky
- None

## Edge-Case & Dependency Audit

- **Race Conditions:** None. Changes are static CSS and HTML with no runtime state transitions.
- **Security:** None. No user input processing, no script injection surfaces.
- **Side Effects:** Adding `background: transparent` to `#stitch-content` may reveal the body grid through child containers. If child elements (e.g., `.stitch-empty-state`, `.stitch-gallery`, `.stitch-screen-card`) retain opaque fills, the visual effect will be partially blocked. Verification must inspect child backgrounds with cyber theme enabled.
- **Dependencies & Conflicts:** None. No other plans or branches modify the same CSS selectors.

## Dependencies
- None

## Adversarial Synthesis
Key risks: child containers with opaque backgrounds may partially block the new glass effect, and verification is purely manual. Mitigations: inspect `.stitch-empty-state` and `.stitch-gallery` backgrounds during visual verification; if blocked, append a targeted transparent override as a follow-up rather than speculating now.

## Proposed Changes

### `src/webview/design.html`

#### Glass overlay rule (~line 2215)
- **Context:** The `.cyber-theme-enabled` glassmorphism block lists all preview pane IDs except `#stitch-preview-pane`. The `#stitch-preview-pane` element exists at line 2969 with base styles (`display: flex; flex-direction: column; gap: 12px;`).
- **Logic:** Glass overlay requires `backdrop-filter` and the accent-grid `background-image` so the Stitch tab matches Research, Kanban, etc.
- **Implementation:** Append `.cyber-theme-enabled #stitch-preview-pane` to the comma-separated selector list starting at line 2215.
- **Edge Cases:** If the element already has a solid `background-color` from base styles, the `background-color: rgba(255, 255, 255, 0.015)` in the cyber rule will override it due to equal specificity and source order. Verified: base styles do not set `background-color` on `#stitch-preview-pane`.

#### Transparent background rule (~line 2252)
- **Context:** The block that forces tab content wrappers to `background: transparent` omits `#stitch-content`. The `#stitch-content` element exists at line 2942 with `display: flex; flex-direction: column;` when active.
- **Logic:** Without transparency, the content wrapper blocks the body grid even if the preview pane above it has glass styling.
- **Implementation:** Append `.cyber-theme-enabled #stitch-content` to the comma-separated selector list starting at line 2252.
- **Edge Cases:** Child containers inside `#stitch-content` may still be opaque. This is acceptable scope; only the wrapper transparency is required here.

#### Empty-state emoji removal (~line 3537)
- **Context:** The `#stitch-gallery-empty` block contains a decorative emoji `<span>` inconsistent with the panel's minimal aesthetic.
- **Logic:** Removing the element simplifies the empty state and aligns it with other tabs.
- **Implementation:** Delete the line `<span style="font-size: 48px; opacity: 0.5;">🎨</span>`.
- **Edge Cases:** None. No JavaScript references this span by index or selector.

## Verification Plan

### Automated Tests
- None applicable. Visual/CSS-only change; existing test suite does not cover theme rendering.

### Manual Verification
1. Open the Design Panel in VS Code with the cyber theme enabled.
2. Switch to the **Stitch** tab.
3. Confirm the background shows the subtle accent grid with the frosted glass overlay (same as Research, Kanban, etc.).
4. Confirm the empty-state message reads "Stitch Screen Generator" without any emoji above it.
5. (Defensive) Open DevTools in the webview and verify that `#stitch-content > .stitch-empty-state` does not have an unexpected opaque background overriding the grid.

## Files Changed
- `src/webview/design.html`

## Risk Assessment
- **Low risk.** Changes are purely additive (CSS selectors) and subtractive (one HTML element). No JavaScript logic is touched. The worst-case failure is that the Stitch tab continues to look as it does now.

## Recommendation
Send to Intern
