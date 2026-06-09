# Afterburner Updated Theme

## Metadata

- **Complexity:** 5
- **Tags:** ui, frontend, feature

## Goal

Add a new `afterburner_updated` Switchboard theme alongside the existing `afterburner` default. This lets the user toggle to the brighter, more precise Afterburner palette (from the `afterburner_Design.md` spec) without breaking the current default. Once validated through iteration, it can be merged back into the main `afterburner` theme.

## Root Problem

The existing `:root` CSS palette in `planning.html`, `setup.html`, and `kanban.html` does not match the Afterburner design spec (`#101414` surface, `#00e5ff` accent, `Hanken Grotesk` font). The scanline/glow effects exist, but the underlying colors and typography are wrong. Rather than mutate the default theme in-place, we create a parallel `afterburner_updated` theme that can be switched to from the Setup panel.

## Scope of Changes

| File | Change |
|------|--------|
| `package.json` | Add `"afterburner_updated"` to `switchboard.theme.name` enum and description |
| `src/webview/planning.html` | Add `body.theme-afterburner-updated` CSS override block; inject `Hanken Grotesk` font link |
| `src/webview/planning.js` | Update `handleThemeChanged()` to apply `theme-afterburner-updated` class while preserving `cyber-theme-enabled` |
| `src/webview/setup.html` | Add radio button for new theme; add same CSS override block |
| `src/webview/setup.html` (inline JS) | Update theme tab init and change handler for new value |
| `src/webview/kanban.html` | Add same CSS override block |

## Implementation Details

### CSS Variable Overrides (all 3 HTML files)

```css
body.theme-afterburner-updated {
    --panel-bg: #101414;
    --panel-bg2: #0b0f0f;
    --border-color: #1d2323;
    --border-bright: #363a3a;
    --accent-teal: #00e5ff;
    --accent-teal-dim: rgba(0, 229, 255, 0.4);
    --accent-teal-bright: #00e5ff;
    --glow-teal: 0 0 10px rgba(0, 229, 255, 0.4);
    --accent-orange: #d18616;
    --card-bg: #0b0f0f;
    --card-bg-hover: #1a1a1a;
    --card-border: 1px solid #1d2323;
    --text-primary: #ffffff;
    --text-secondary: #a0a6a6;
    --font-family: 'Hanken Grotesk', var(--vscode-font-family), -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
```

### Font Loading

Inject in `<head>` of all three HTML files:

```html
<link href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@400;500;600;700&display=swap" rel="stylesheet">
```

### planning.js Logic Update

In `handleThemeChanged()`:
- Remove `theme-claude-terracotta`, `theme-slightly-darker-black`, `theme-afterburner-updated` classes
- If `afterburner` or `afterburner_updated`: add `cyber-theme-enabled`
- If `afterburner_updated`: also add `theme-afterburner-updated`
- If `claude-terracotta` or `slightly-darker-black`: add the respective class

### setup.html Inline JS

Update `currentSwitchboardTheme` default handling, theme tab init, and radio change listener to recognize `afterburner_updated`.

## Acceptance Criteria

1. User can select "Afterburner Updated" from the Theme tab in Setup.
2. All webviews (Setup, Planning, Kanban) reflect the new palette and font when selected.
3. Scanline/glow effects remain active for both `afterburner` and `afterburner_updated`.
4. Existing themes (`afterburner`, `claude-terracotta`, `slightly-darker-black`) continue to work.

## Completion Status

**Completed on:** 2026-06-08

**Files changed:**
- `package.json` — Added `afterburner_updated` to theme enum
- `src/webview/planning.html` — Added CSS override block + Hanken Grotesk font link
- `src/webview/planning.js` — Updated `handleThemeChanged()` for new theme
- `src/webview/setup.html` — Added CSS override block + font link + radio button + JS handlers
- `src/webview/kanban.html` — Added CSS override block + font link + JS handler

**Build:** `npm run compile` succeeded (2 pre-existing TS errors unrelated to this change). All `dist/webview/` files updated via CopyPlugin.

## Risks

- **Font loading:** Google Fonts require external network. VS Code webview CSP may block. Mitigation: include a fallback to `var(--vscode-font-family)`.
- **CSP:** The `<link>` tag must be explicitly allowed in the CSP header. Current CSP allows `https:` for `style-src` and `font-src`, so it should pass.
- **Testing needed:** Verify scanline/glow effects render correctly with the brighter `#00e5ff` accent against `#101414` surface.

## Review Findings

**Scope correction**: The original implementation over-spread CSS variable blocks to `setup.html` and `kanban.html` — these panels were not meant to receive visual changes. Removed the CSS blocks, Hanken Grotesk links, and special class handling from both files. The only legitimate change to setup.html is the radio button + JS handler for theme selection (kept).

**planning.html was under-implemented**: The original block only overrode CSS variables, but the cyber-theme-enabled rules use hardcoded `rgba(61, 219, 217, ...)` (old teal `#3ddbd9`) for scanlines, grid lines, glassmorphism borders, and sweep beam — these never picked up the new `#00e5ff` accent. Added: `--kanban-bg` and `--accent-neon` overrides, scanline opacity at spec 7% (was 15%), immersive background grid lines with spec-correct `rgba(0, 229, 255, 0.03)`, sweep beam with `#00e5ff`, and glassmorphism border overrides for tab bar, controls strip, tree panes, preview panes, and planning cards.

**Files changed by review**: `setup.html` (removed CSS block, font link, special class handler), `kanban.html` (removed CSS block, font link, special class handler), `planning.html` (expanded theme block with spec-aligned overrides).
