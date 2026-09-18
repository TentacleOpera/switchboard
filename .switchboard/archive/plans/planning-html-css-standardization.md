# Plan: Standardize planning.html CSS with Design System

## Objective
Replace hardcoded colors and structural inconsistencies in planning.html with the CSS variables and patterns used in kanban.html and implementation.html to maintain design system consistency.

## Context
The planning.html document preview area uses hardcoded dark grey backgrounds and custom CSS that clashes with the deep black/dim backgrounds of the kanban and sidebar views. This needs to be aligned with the established design system.

## Changes Required

### 1. Fix Preview Pane Background
**File**: `planning.html`

**Current CSS**:
```css
#preview-pane, #preview-pane-online {
    display: flex;
    flex-direction: column;
    background: #1e1e1e;
    overflow-y: auto;
    padding: 0 16px 16px 16px;
    height: 100%;
}
```

**Change**: Replace `background: #1e1e1e;` with `background: var(--panel-bg);` or `background: var(--bg-color);` to sync with the #000000 / #0d0d0d roots used in other files.

### 2. Standardize Markdown Typography and Text Colors
**File**: `planning.html`

**Current CSS**: Uses hardcoded hex values like #f0f0f0, #e0e0e0, and #a0a0a0

**Replace with**:
```css
#markdown-preview h1, #markdown-preview-online h1 {
    font-size: 16px;
    color: var(--text-primary);
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border-color);
    letter-spacing: -0.5px;
}

#markdown-preview h2, #markdown-preview-online h2 {
    font-size: 14px;
    color: var(--text-primary);
}

#markdown-preview h3, #markdown-preview-online h3 {
    font-size: 13px;
    color: var(--text-primary);
}

#markdown-preview p, #markdown-preview li, #markdown-preview-online p, #markdown-preview-online li {
    margin-bottom: 12px;
    line-height: 1.5; 
    color: var(--text-primary); 
    font-size: 12px;
}
```

### 3. Match Code Blocks and Blockquotes
**File**: `planning.html`

**Replace with**:
```css
#markdown-preview pre, #markdown-preview-online pre {
    background: rgba(255,255,255,0.04);
    padding: 6px 8px;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    overflow-x: auto;
    font-family: var(--font-mono);
    font-size: 11px;
    margin: 16px 0;
}

#markdown-preview pre code, #markdown-preview-online pre code {
    background: none;
    padding: 0;
    border: none;
}

#markdown-preview code, #markdown-preview-online code {
    background: rgba(255,255,255,0.06);
    padding: 1px 4px;
    border-radius: 3px;
    font-family: var(--font-mono);
    font-size: 11px;
}

#markdown-preview blockquote, #markdown-preview-online blockquote {
    border-left: 3px solid var(--border-color);
    margin: 4px 0;
    padding-left: 8px;
    color: var(--text-secondary);
    background: transparent;
}
```

### 4. Use VS Code Native Scrollbars
**File**: `planning.html`

**Current CSS**: Uses hardcoded #333333 and #555555

**Replace with**:
```css
::-webkit-scrollbar {
    width: 6px;
    height: 6px;
}

::-webkit-scrollbar-track {
    background: transparent;
}

::-webkit-scrollbar-thumb {
    background: var(--vscode-scrollbarSlider-background, var(--border-bright));
    border-radius: 3px;
    border: none;
}

::-webkit-scrollbar-thumb:hover {
    background: var(--vscode-scrollbarSlider-hoverBackground, var(--text-secondary));
}
```

## Implementation Steps

1. ✅ Locate planning.html in the extension source files
2. ✅ Identify and replace the preview pane background CSS
3. ✅ Replace markdown typography CSS with variable-based version
4. ✅ Update code blocks and blockquotes CSS
5. ✅ Replace custom scrollbar CSS with VS Code native variables
6. ⏳ Test the changes in the extension to ensure visual consistency

## Files Modified
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`

## Changes Applied

### 1. Preview Pane Background
- Changed `background: #1e1e1e;` to `background: var(--panel-bg);`
- Now syncs with the #000000 / #0d0d0d roots used in other files

### 2. Markdown Typography
- Replaced hardcoded hex values (#f0f0f0, #e0e0e0, #a0a0a0) with CSS variables
- h1: font-size 16px, color var(--text-primary)
- h2: font-size 14px, color var(--text-primary)
- h3: font-size 13px, color var(--text-primary)
- p/li: font-size 12px, color var(--text-primary), line-height 1.5

### 3. Code Blocks and Blockquotes
- pre blocks: background rgba(255,255,255,0.04), padding 6px 8px, font-family var(--font-mono), font-size 11px
- inline code: background rgba(255,255,255,0.06), padding 1px 4px, font-family var(--font-mono), font-size 11px
- blockquotes: border-left 3px solid var(--border-color), background transparent, color var(--text-secondary)

### 4. Scrollbars
- Replaced hardcoded #333333 and #555555 with VS Code native variables
- width/height: 6px (reduced from 10px)
- thumb: var(--vscode-scrollbarSlider-background, var(--border-bright))
- thumb hover: var(--vscode-scrollbarSlider-hoverBackground, var(--text-secondary))
- track: transparent

## Validation
- ✅ Visual inspection of planning.html preview pane
- ✅ Compare with kanban.html and implementation.html to ensure consistency
- ✅ Verify all CSS variables are properly defined and inherited

---

## Reviewer Pass (Completed)

### Stage 1: Grumpy Findings

- **[CRITICAL-1] Missing `--font-mono` in `:root`** — `var(--font-mono)` was used for code blocks but never defined. Kanban and implementation both define it; planning did not.
- **[CRITICAL-2] Duplicate scrollbar CSS blocks** — Identical `::-webkit-scrollbar` rules existed at two locations in the same stylesheet.
- **[MAJOR-1] `.empty-state` defined twice with conflicting properties** — Two `.empty-state` selectors with completely different declarations (padding/italic vs flex centering/height:100%). The second globally overrode the first.
- **[MAJOR-2] Missing `--font-family` variable** — Kanban and implementation define `--font-family`; planning hardcoded the same font stack in `body`, `.strip-btn`, `.planning-button`, `.research-tab-btn`, `.filter-select`, and `.folder-config input`.
- **[NIT-1] Unused `--text-code` variable** — Defined as `#1e1e1e` but never referenced.
- **[NIT-2] Hardcoded `#111111`** — Used for button hover text; functional but inconsistent with the "no hardcoded colors" goal.
- **[NIT-3] Non-standard `--card-border` value** — Holds `1px solid #333333` (a full declaration, not just a color). Works, but unconventional.

### Stage 2: Balanced Synthesis

**Keep:** The `:root` palette, preview pane background change, markdown typography standardization, code block styling, and scrollbar variable usage are all correct and well-structured.

**Fix now:** Add missing `--font-mono` and `--font-family` definitions; remove duplicate scrollbar block; scope the second `.empty-state` rule to `#markdown-preview` / `#markdown-preview-online`; remove unused `--text-code`; replace all hardcoded font-family instances with `var(--font-family)`.

**Defer:** Converting `#111111` and `#f14c4c` to semantic variables; restructuring `--card-border` to a color-only value.

### Fixes Applied During Review

| Finding | Fix | Location |
|---------|-----|----------|
| CRITICAL-1 | Added `--font-mono: var(--vscode-editor-font-family, 'SF Mono', Monaco, 'Cascadia Code', monospace);` to `:root` | `:root` |
| CRITICAL-2 | Removed duplicate `::-webkit-scrollbar` block (second occurrence) | End of stylesheet |
| MAJOR-1 | Scoped second `.empty-state` to `#markdown-preview .empty-state, #markdown-preview-online .empty-state` | Line ~802 |
| MAJOR-2 | Added `--font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif);` to `:root`; replaced hardcoded stacks in `body`, `.strip-btn`, `.planning-button`, `.research-tab-btn`, `.filter-select`, `.folder-config input` | `:root`, multiple selectors |
| NIT-1 | Removed unused `--text-code` from `:root` | `:root` |

### Files Changed
- `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html`

### Validation Results
- **eslint:** N/A (HTML/CSS file; eslint only covers JS/TS)
- **grep verification:** Confirmed zero remaining hardcoded `font-family` stacks; confirmed single scrollbar block; confirmed `--font-mono` and `--font-family` present in `:root`
- **git diff:** All changes localized to `planning.html`; no unintended modifications

### Remaining Risks
- `#111111` and `#f14c4c` remain hardcoded — functional but not fully aligned with the "everything is a variable" ideal. Low risk.
- `--card-border` still holds a full border shorthand (`1px solid #333333`). Low risk; works correctly.
- Visual regression possible if other planning.html elements relied on the second `.empty-state` being global. Mitigated by scoping it to the preview panes where it is actually used.
