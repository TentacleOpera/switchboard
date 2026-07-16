# Plan: Fix Blue Background on Markdown Editor Panel

## Problem
The markdown editor panel shows an ugly blue-ish background (`#0d1117`) instead of matching the theme's black background.

## Root Cause
- `markdownEditor.js` CSS uses undefined CSS variables with blue-ish fallbacks:
  - `md-editor-shell`: `background: var(--bg-color, #0d1117)` — `--bg-color` is NOT defined in `:root`.
  - `md-live-preview`: `background: var(--preview-bg, #0d1117)` — `--preview-bg` may not be defined or may also fall back to `#0d1117`.
  - `md-toolbar`: `background: var(--toolbar-bg, #161b22)` — `--toolbar-bg` is NOT defined.
- The fallback `#0d1117` is GitHub's dark theme blue-black, which looks blue against the pure black `--panel-bg: #000000`.
- `#161b22` is similarly a blue-ish dark gray.

## Fix
Either:
1. **Define the missing variables** in `:root` to match the theme, OR
2. **Replace the undefined variables** with existing theme variables (`--panel-bg`, `--panel-bg2`).

Option 2 is cleaner since `--panel-bg` and `--panel-bg2` already exist.

### Files to Change
1. **`src/webview/markdownEditor.js`** — CSS in the injected stylesheet
   - `md-editor-shell`: `background: var(--panel-bg, #000000)` (was `var(--bg-color, #0d1117)`)
   - `md-live-preview`: `background: var(--panel-bg2, #0a0a0a)` (was `var(--preview-bg, #0d1117)`)
   - `md-toolbar`: `background: var(--panel-bg2, #0a0a0a)` (was `var(--toolbar-bg, #161b22)`)

## Verification
- Open ticket edit mode → editor background should be black, matching the rest of the panel.
- Verify toolbar and preview pane also match the theme.
- Switch themes (if applicable) → editor should follow theme changes.
