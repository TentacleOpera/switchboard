# Terminal log viewer does not use the project panel's markdown preview styling

## Goal

The terminal session log viewer must render markdown with the same visual styling as the project panel's markdown preview — same font family, font size, heading styles, code block styles, inline code styles, blockquote styles, list styles, table styles, and link styles. Today the log viewer uses a separate, minimal CSS ruleset with a monospace font and only basic h1/h2/pre/code styling, so the rendered log looks nothing like the markdown preview the user sees in the project panel.

### Problem Analysis

**The log viewer has its own CSS that diverges from the unified markdown preview styling.** The log viewer's detail content is styled by `.log-view-detail-content` in `terminals.html:2453-2482`:

```css
.log-view-detail-content {
    max-width: 900px;
    margin: 0 auto;
    font-size: 13px;
    line-height: 1.6;
    color: var(--text-primary, #ccc);
    font-family: var(--font-mono, 'Menlo', 'Monaco', monospace);  /* MONOSPACE */
}
.log-view-detail-content h1, .log-view-detail-content h2 {
    color: var(--accent-teal, #4ec9b0);
    margin-top: 1.5em;
    margin-bottom: 0.5em;
}
.log-view-detail-content h1 { font-size: 18px; }
.log-view-detail-content h2 { font-size: 15px; }
.log-view-detail-content pre {
    background: var(--bg-secondary, #252526);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
    font-size: 12px;
}
.log-view-detail-content code {
    font-family: var(--font-mono, monospace);
    font-size: 12px;
}
.log-view-detail-content p {
    margin: 0.5em 0;
}
```

The project panel's unified markdown preview styling is in `project.html:727-856`, covering `#kanban-preview-content`, `#features-preview-content`, `#constitution-preview-content`, `#system-preview-content`, `#tuning-preview-content`, and `#projects-preview-content`:

```css
#kanban-preview-content, #features-preview-content, ... {
    flex: 1;
    width: 100%;
    box-sizing: border-box;
    margin: 0;
    padding: 32px 24px 40px;
    font-family: var(--font-family);           /* PROPORTIONAL / SANS-SERIF */
    font-size: 14px;                            /* 14px, not 13px */
    line-height: 1.6;
    word-wrap: break-word;
    color: var(--doc-text-bright);              /* doc-text-bright, not text-primary */
}
```

**Key differences:**

| Property | Log viewer (`.log-view-detail-content`) | Project panel (`#kanban-preview-content`) |
|---|---|---|
| Font family | `var(--font-mono)` (monospace) | `var(--font-family)` (proportional) |
| Font size | 13px | 14px |
| Text color | `var(--text-primary, #ccc)` | `var(--doc-text-bright)` |
| Headings | Only h1, h2 styled | All h1–h6 styled with `var(--doc-heading)`, `font-weight: 600`, `line-height: 1.25` |
| Code blocks | Basic `background`, `padding`, `border-radius` | `background-color: var(--vscode-textCodeBlock-background)`, `border: 1px solid var(--vscode-widget-border)`, `border-radius: 3px`, `padding: 16px`, `margin: 16px 0` |
| Inline code | `font-family: monospace`, `font-size: 12px` | `font-family: var(--font-code)`, `font-size: 1em`, `color: var(--accent-teal)`, `background-color: color-mix(...)`, `border: 1px solid var(--accent-teal-dim)`, `padding: 2px 6px`, `border-radius: 3px` |
| Blockquotes | Not styled | `border-left: 5px solid`, `padding: 0 16px 0 10px`, `color: var(--doc-text)` |
| Lists | Not styled | `margin-bottom: 16px`, `padding-left: 2em` |
| Tables | Not styled | `border-collapse: collapse`, with th/td borders and padding |
| Links | Not styled | `color: var(--vscode-textLink-foreground)`, hover underline |
| HR | Not styled | `border: 0`, `height: 1px`, `background: var(--border-color)` |
| Theme support | None | Cyber theme, Claudify theme overrides |

**The original plan explicitly required this.** The terminal session log plan (`terminal-session-logs-as-readable-markdown.md:23`) states: *"Both halves of the presentation already exist. `renderMarkdown` is a shared renderer (`sharedUtils.js:122`) with its own contract test, and `tickets.html` implements the sidebar-list-plus-detail layout."* The plan assumed the log viewer would reuse the same rendering pipeline and visual styling as the existing markdown preview surfaces. The `renderMarkdown` function IS reused (the JS calls it at `terminals.js:12585-12586`), but the CSS styling was written from scratch with a different visual language.

### Root Cause

The log viewer's CSS was authored independently of the project panel's unified markdown preview styling, using a monospace font and a minimal subset of element styles. The `renderMarkdown` function produces the same HTML for both surfaces, but the CSS that styles that HTML diverges — the project panel has comprehensive rules for every markdown element, while the log viewer has rules for only h1, h2, pre, code, and p. The result is that the same markdown document renders with different typography, different colors, and missing styling for blockquotes, lists, tables, links, and hr in the log viewer.

## Metadata

**Complexity:** 3
**Tags:** bugfix, frontend, ui
**Project:** Browser Switchboard

## User Review Required

No — the fix is a CSS-only change that replaces a divergent minimal ruleset with the project panel's unified markdown preview styling. No data format, API, or logic change. The one risk (missing CSS variables) is resolved by the variable audit in the Proposed Changes.

## Complexity Audit

### Routine

- Replacing the `.log-view-detail-content` CSS ruleset in `terminals.html` with the same rules used by `#kanban-preview-content` in `project.html`.
- Adding the missing element styles (h3–h6, blockquotes, lists, tables, links, hr, inline code with accent color) to the log viewer.
- Changing the font family from `var(--font-mono)` to `var(--font-family)` and the font size from 13px to 14px.

### Complex / Risky

- **CSS variables may not be defined in `terminals.html`.** The project panel uses variables like `--doc-text-bright`, `--doc-heading`, `--font-family`, `--font-code`, `--vscode-textCodeBlock-background`, `--vscode-widget-border`, `--accent-teal-dim`, `--vscode-textLink-foreground`, `--vscode-textLink-activeForeground`, `--accent-teal-bright`, `--border-color`. Some of these may not be defined in `terminals.html`'s `:root` or may have different values. The fix must either import the same variable definitions or use fallback values that match the project panel's defaults.
- **Theme support.** The project panel has cyber-theme and claudify-theme overrides for markdown content. The log viewer is in `terminals.html`, which may or may not have the same theme classes on `body`. If themes are applied, the log viewer should respect them; if not, the base styling is sufficient. This is an enhancement, not a blocker — the base styling fix is the core deliverable.

## Edge-Case & Dependency Audit

**Migration.** None. CSS-only change; no data format or API change.

**Side effects.** The log viewer's appearance changes — monospace becomes proportional, colors shift to match the project panel. This is the intended behavior.

**Dependencies.** The `renderMarkdown` function (`sharedUtils.js`) is already shared and unchanged. The CSS variables must be available in `terminals.html`. A variable audit is needed before the change.

**Both-host parity.** This is a CSS-only change in `terminals.html`, which is served by both the standalone host and the extension. No host-specific logic.

**Verified CSS variable audit.** `terminals.html`'s `:root` (lines 23-50) already defines: `--font-family` (`'Hanken Grotesk', Menlo, Consolas, sans-serif'` — identical to `project.html:60`), `--font-code` (`Menlo, Consolas, monospace` — identical to `project.html:61`), `--border-color` (`#333333`), `--accent-teal` (`var(--accent-primary)`), `--accent-primary` (`#00e5ff`), `--text-primary` (`#e0e0e0`), `--text-secondary` (`#8C8C8C`). The following variables used by the project panel's markdown CSS are NOT defined in `terminals.html` and MUST be added: `--doc-text-bright` (`#e2e8f0` in `project.html:73`), `--doc-heading` (`var(--accent-primary)` in `project.html:74`), `--doc-text` (`#a0a6a6` in `project.html:72`), `--accent-teal-dim` (`color-mix(in srgb, var(--accent-teal) 40%, transparent)` in `project.html:46`), `--accent-teal-bright` (`#5ce8e6` in `project.html:47`). The `--vscode-textCodeBlock-background`, `--vscode-widget-border`, `--vscode-textLink-foreground`, `--vscode-textLink-activeForeground` variables are NOT defined in `project.html` either — they are VS Code theme variables that may or may not be present in the webview context. The CSS rules use fallback values for these, which is the correct approach.

**Theme support.** `terminals.html` has `body.theme-claudify` (lines 59-67) and `body.cyber-theme-enabled` (line 69+) blocks, but neither overrides `--doc-text-bright`, `--doc-heading`, `--doc-text`, `--accent-teal-dim`, or `--accent-teal-bright`. The `--accent-teal-dim` defined as `color-mix(in srgb, var(--accent-teal) 40%, transparent)` in `:root` will correctly resolve using the theme-active `--accent-teal` value (cyan in default, terracotta in claudify) because CSS custom properties with `var()` references resolve at use time. The `--accent-teal-bright` and `--doc-*` variables are static values that will be the same across themes — matching `project.html`, which also does not override them in its claudify block (lines 75-89). The project panel's cyber-theme and claudify-theme markdown overrides use `#kanban-preview-content` selectors, which do not match `.log-view-detail-content`. Adding theme-specific overrides for the log viewer is an enhancement, not a blocker — the base styling fix is the core deliverable.

## Dependencies

- None — this is a standalone CSS-only bugfix with no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the proposed variable additions use self-referential `var(--font-family, ...)` syntax for variables that are already defined — this is a no-op at best and could mask a missing variable; (2) the `--vscode-*` variables are not defined in either HTML file, so the fallback values in the CSS rules are the only styling — this is the same approach `project.html` uses, so it is consistent; (3) the `.log-view-detail` container's `padding: 16px 24px` must be zeroed to avoid double-padding with the new `.log-view-detail-content` padding. Mitigations: only add the 5 missing variables with direct values matching `project.html`; keep the `--vscode-*` fallbacks; zero the container padding.

## Proposed Changes

### `src/webview/terminals.html` — replace log viewer CSS with unified markdown preview styling

**Context.** The `.log-view-detail-content` ruleset at `:2453-2482` is a minimal, divergent style. The project panel's unified markdown preview styling at `project.html:727-856` is the reference.

**Step 1: Audit CSS variables.** Check which of the variables used by the project panel's markdown CSS are defined in `terminals.html`. The terminals page defines its own `:root` variables — verify `--font-family`, `--font-code`, `--doc-text-bright`, `--doc-heading`, `--accent-teal`, `--accent-teal-dim`, `--accent-teal-bright`, `--border-color`, `--vscode-textCodeBlock-background`, `--vscode-widget-border`, `--vscode-textLink-foreground`, `--vscode-textLink-activeForeground` are available. Add any missing variables with the same values used in `project.html`.

**Step 2: Replace the `.log-view-detail-content` ruleset.** Remove the current minimal rules and replace them with the project panel's unified markdown preview styling, scoped to `.log-view-detail-content`:

```css
/* ── Terminal session log viewer — markdown styling ─────────────── */
/* Mirrors the unified markdown preview styling from project.html
   (#kanban-preview-content et al.) so the log renders with the same
   typography, colors, and element styles as the project panel. */
.log-view-detail-content {
    max-width: 900px;
    margin: 0 auto;
    padding: 32px 24px 40px;
    font-family: var(--font-family);
    font-size: 14px;
    line-height: 1.6;
    word-wrap: break-word;
    color: var(--doc-text-bright, var(--text-primary, #ccc));
}
.log-view-detail-content h1,
.log-view-detail-content h2,
.log-view-detail-content h3,
.log-view-detail-content h4,
.log-view-detail-content h5,
.log-view-detail-content h6 {
    margin-top: 24px;
    margin-bottom: 12px;
    font-weight: 600;
    line-height: 1.25;
    color: var(--doc-heading, var(--accent-teal, #4ec9b0));
}
.log-view-detail-content h1 { font-size: 1.5em; }
.log-view-detail-content h2 { font-size: 1.3em; }
.log-view-detail-content h3 { font-size: 1.15em; }
.log-view-detail-content h4 { font-size: 1em; }
.log-view-detail-content h5 { font-size: 0.95em; }
.log-view-detail-content h6 { font-size: 0.9em; }
.log-view-detail-content p {
    margin: 0.5em 0;
}
.log-view-detail-content pre {
    background-color: var(--vscode-textCodeBlock-background, rgba(255,255,255,0.04));
    border: 1px solid var(--vscode-widget-border, rgba(127, 127, 127, 0.35));
    border-radius: 3px;
    overflow-x: auto;
    padding: 16px;
    margin: 16px 0;
}
.log-view-detail-content pre code {
    background: none;
    padding: 0;
    border: none;
    display: inline-block;
    color: var(--vscode-editor-foreground, #cccccc);
    tab-size: 4;
}
.log-view-detail-content code {
    font-family: var(--font-code, var(--font-mono, monospace));
    font-size: 1em;
    line-height: 1.357em;
    color: var(--accent-teal, #4ec9b0);
    background-color: color-mix(in srgb, var(--accent-teal, #4ec9b0) 12%, transparent);
    border: 1px solid var(--accent-teal-dim, rgba(78, 201, 176, 0.3));
    padding: 2px 6px;
    border-radius: 3px;
}
.log-view-detail-content blockquote {
    margin: 0;
    padding: 0 16px 0 10px;
    border-left: 5px solid var(--vscode-textBlockQuote-border, var(--border-color, rgba(127, 127, 127, 0.35)));
    border-radius: 2px;
    color: var(--doc-text, var(--text-secondary, #888));
    background: transparent;
}
.log-view-detail-content ul,
.log-view-detail-content ol {
    margin-bottom: 16px;
    padding-left: 2em;
}
.log-view-detail-content li {
    margin-bottom: 0.25em;
}
.log-view-detail-content li p {
    margin-bottom: 0;
}
.log-view-detail-content table {
    border-collapse: collapse;
    margin-bottom: 0.7em;
    font-size: inherit;
}
.log-view-detail-content th {
    text-align: left;
    border: 1px solid var(--border-color, rgba(127, 127, 127, 0.35));
    padding: 6px 12px;
    font-weight: 600;
}
.log-view-detail-content td {
    border: 1px solid var(--border-color, rgba(127, 127, 127, 0.35));
    padding: 6px 12px;
}
.log-view-detail-content .table-wrapper {
    overflow-x: auto;
    max-width: 100%;
    margin-bottom: 16px;
}
.log-view-detail-content a {
    color: var(--vscode-textLink-foreground, var(--accent-teal, #4ec9b0));
    text-decoration: none;
}
.log-view-detail-content a:hover {
    color: var(--vscode-textLink-activeForeground, var(--accent-teal-bright, #6fdcc4));
    text-decoration: underline;
}
.log-view-detail-content hr {
    border: 0;
    height: 1px;
    background: var(--border-color, rgba(127, 127, 127, 0.35));
    margin: 24px 0;
}
```

**Step 3: Remove the old rules.** Delete the previous `.log-view-detail-content` rules at `:2453-2482` (the monospace font, the h1/h2-only heading styles, the basic pre/code/p styles).

**Step 4: Keep the `.log-view-detail` container styling.** The `.log-view-detail` ruleset at `:2448-2452` (the flex container with `overflow-y: auto` and `padding: 16px 24px`) stays — but the `padding` on the container should be removed or set to `0` since the `.log-view-detail-content` now carries its own `padding: 32px 24px 40px` (matching the project panel). Otherwise the padding doubles:

```css
.log-view-detail {
    flex: 1;
    overflow-y: auto;
    padding: 0;  /* padding moved to .log-view-detail-content */
}
```

### `src/webview/terminals.html` — add missing CSS variables

**Context.** The verified variable audit (in Edge-Case & Dependency Audit above) found that 5 variables are missing from `terminals.html`'s `:root`. The variables `--font-family`, `--font-code`, `--border-color`, `--accent-teal`, `--accent-primary`, `--text-primary`, `--text-secondary` are already defined and identical to `project.html` — do NOT re-declare them.

> **Superseded:** Add all markdown variables using self-referential `var(--name, fallback)` syntax (e.g. `--font-family: var(--font-family, ...)`).
> **Reason:** Self-referential `var()` on a variable that is already defined in the same `:root` is a no-op (it resolves to the existing value). For variables that are NOT defined, `var(--name, fallback)` in a `:root` declaration is also a no-op because `:root` is where the variable would be defined — there is nothing to inherit from. The correct approach is to add direct values matching `project.html`.
> **Replaced with:** Add only the 5 missing variables with direct values from `project.html`.

**Change.** Add these 5 variables to the `:root` block in `terminals.html` (after the existing `--font-code` line at `:34`):

```css
:root {
    /* ... existing variables ... */
    /* Markdown preview variables — mirrored from project.html so the
       log viewer renders with the same typography as the project panel. */
    --doc-text-bright: #e2e8f0;
    --doc-heading: var(--accent-primary);
    --doc-text: #a0a6a6;
    --accent-teal-dim: color-mix(in srgb, var(--accent-teal) 40%, transparent);
    --accent-teal-bright: #5ce8e6;
}
```

These values match `project.html` exactly (`:46-47`, `:72-74`). The `--accent-teal-dim` uses `color-mix` with `var(--accent-teal)`, which resolves at use time — in the claudify theme, `--accent-teal` is overridden to `#D97757` (terracotta), so `--accent-teal-dim` correctly becomes a dimmed terracotta. The `--doc-heading` uses `var(--accent-primary)`, which is also theme-aware.

## Verification Plan

### Goal Invariants

- The log viewer renders markdown with the same font family, font size, and text color as the project panel's markdown preview.
- All markdown elements (h1–h6, pre, code, blockquote, ul/ol, table, a, hr) are styled in the log viewer.
- The log viewer's inline code uses the same accent color, background, and border as the project panel.
- The log viewer's code blocks use the same background, border, and padding as the project panel.
- No CSS variable references are broken (no `undefined` or fallback-to-default divergence).

### Automated Tests

No new automated tests — this is a CSS-only visual change. The existing `renderMarkdown` contract tests verify the HTML output is correct; the CSS change only affects how that HTML is styled.

### Manual Verification

- Open a terminal session log in the log viewer. Open a plan in the project panel. Compare them side by side: headings, code blocks, inline code, lists, blockquotes, and links should look the same.
- Verify the log viewer's font is proportional (sans-serif), not monospace.
- Verify inline code has the accent-teal color with the subtle background and border.
- Verify code blocks have the border and background matching the project panel.
- Verify headings h1–h6 all render with the correct sizes and colors.
- Test with a log that contains blockquotes, lists, and tables (if available; agent output may not produce these, but the styles must be present for any markdown the log contains).
- Verify in BOTH hosts: standalone and extension.
