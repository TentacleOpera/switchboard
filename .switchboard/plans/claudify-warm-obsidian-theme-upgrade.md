# Claudify Theme: Warm Obsidian Upgrade

## Goal

Upgrade the claudify theme from a lightweight accent-color overlay to a full "Warm Obsidian" design system matching Claude Code's aesthetic: warm charcoal backgrounds, warm cream text, warm borders, suppressed cyber effects (keep grid, kill scanlines/glow), and terracotta-only-for-h1 headings.

### Problem & Background

The claudify theme was built as a lightweight overlay on the afterburner (cyberpunk) theme — it swaps the accent color to terracotta `#D97757` and changes the display font, but inherits everything else (pure black backgrounds, cool grey text, scanlines, neon glow effects, cold borders). The goal is to bring it closer to the "Warm Obsidian" design system used by Claude Code: warm charcoal backgrounds, warm cream text, warm borders, reduced cyber effects (keep grid, kill scanlines/glow), and terracotta-only-for-h1 headings.

**Root cause:** The claudify theme's `body.theme-claudify` block only overrides 3-4 CSS variables (`--accent-primary`, `--display-font`, `--display-letter-spacing`, `--display-font-stretch`). All other theme variables (backgrounds, text colors, borders, panel colors) inherit from the base `:root` which uses pure black and cool grey. Additionally, the `cyber-theme-enabled` class is applied alongside `theme-claudify`, so all cyber visual effects (scanlines, glow, grid) remain active. The fix requires expanding the variable overrides and adding claudify-specific CSS suppression rules.

### Scope Boundaries (per user)
- **Fonts:** Keep existing font stack (Hanken Grotesk + Poppins + GeistPixel). No new font bundles.
- **Status colors:** Leave existing `--accent-red`, `--accent-green`, `--accent-orange` as-is.
- **Backdrop blur:** Keep the blur effects on strips/panes.
- **Background grid:** Keep the subtle grid lines.
- **Cyber effects to remove:** Scanlines, sweep animation, neon text-shadow glow, neon box-shadow glow on code/blocks/items.
- **Heading colors:** Terracotta for h1 only; h2-h6 use warm cream `#F0EBE6`.
- **Terracotta color:** Must be `#D97757` (already correct — this is the Claude/Anthropic brand coral).

## Metadata
**Complexity:** 5
**Tags:** ui, ux, refactor, frontend

## User Review Required

Yes — visual theme changes require manual verification across 6 webview panels. The implementer should switch to claudify theme and confirm the Warm Obsidian aesthetic is achieved before marking complete.

## Complexity Audit

### Routine
- Expanding `body.theme-claudify` CSS variable override blocks (6 files, mechanical additions)
- Adding `box-shadow: none` / `text-shadow: none` suppression rules (copy-paste CSS)
- Warm background color override for `body.theme-claudify.cyber-theme-enabled` (3 files)
- Heading color override for h2-h6 (3 files, different selector lists per file)
- Shared CSS additions to `shared-tabs.css` (2 rules)
- No JS changes needed — theme-switching logic already applies both `cyber-theme-enabled` and `theme-claudify` classes

### Complex / Risky
- Per-file selector scoping: each of the 3 main webviews has different preview pane IDs, tree pane IDs, and list pane IDs. Suppression and glass tint rules must use only the IDs that exist in each file. Including non-existent IDs is harmless but adds dead CSS.
- CSS specificity: claudify overrides must win over `.cyber-theme-enabled` rules. Verified: `body.theme-claudify .selector` (0,2,1) always beats `.cyber-theme-enabled .selector` (0,2,0) because the `body` element selector adds to the element count. For cyber rules using `body.cyber-theme-enabled` (0,1,1), `body.theme-claudify.cyber-theme-enabled` (0,2,1) wins. No tie cases exist in the codebase.
- `--accent-primary` missing from 3 files: kanban.html, implementation.html, and setup.html override `--accent-teal` but NOT `--accent-primary`, leaving `--accent-primary` as cyan `#00e5ff`. Any CSS referencing `var(--accent-primary)` directly in those files will show cyan instead of terracotta.

## Edge-Case & Dependency Audit

**Race Conditions:** None — CSS is static; theme classes applied synchronously by JS.

**Security:** No security implications. CSS-only changes within webview HTML files.

**Side Effects:**
- Afterburner theme must remain unaffected — claudify overrides use `body.theme-claudify` prefix, so they only apply when that class is present on `body`.
- Default theme (no cyber, no claudify) must remain unaffected — claudify overrides require `body.theme-claudify` class.
- `--accent-teal-bright: #5ce8e6` is hardcoded in `:root` and NOT overridden by claudify. Pre-existing issue — not a regression. If visible, it will show teal instead of terracotta. Low risk (rarely referenced).

**Dependencies & Conflicts:**
- `--accent-teal-dim` and `--glow-teal` are computed via `color-mix(in srgb, var(--accent-teal) ...)` — automatically inherit terracotta when `--accent-teal` is overridden. No conflict.
- `--accent-neon` is set to `var(--accent-teal)` in planning.html — inherits terracotta automatically. Glow suppressed by Part 2 rules.
- `--accent-cyan` in implementation.html is overridden to `#D97757` by existing claudify block. ✓
- Parts 3 and 8 in the original plan were redundant (both override `body.theme-claudify.cyber-theme-enabled` background). Merged into Part 3 — Part 8 removed.

## Dependencies

None — this is a self-contained CSS-only change with no cross-plan dependencies.

## Adversarial Synthesis

Key risks: (1) `--accent-primary` left as cyan in kanban.html/implementation.html/setup.html causing inconsistent accent color, (2) per-file selector lists could include non-existent IDs creating dead CSS, (3) `#stitch-preview-pane` in design.html was missing from the original plan's preview pane override lists. Mitigations: add `--accent-primary: #D97757` to all 3 files, provide explicit per-file ID lists, and include `#stitch-preview-pane` for design.html.

## Proposed Changes

### `src/webview/planning.html` (lines 93-98 for var block; cyber rules at lines 1927-2310)

**Context:** Primary planning webview with cyber theme support. Has preview panes `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#kanban-preview-pane`, `#markdown-preview-tickets`. Tree panes: `#tree-pane`, `#tree-pane-online`, `#tree-pane-tickets`. Has `kanban-column-badge[data-column]` glow, `tree-node` glow, `planning-card`/`planning-button`/`planning-select`/`planning-input` glow, `duplicate-modal`/`folder-modal` glow, `sidebar-folders-btn` glow, `strip-btn` glow, alert glow. `body.cyber-theme-enabled` background at line 2117.

**Logic:** Expand the `body.theme-claudify` block at lines 93-98 with warm variable overrides. Add suppression rules after the last cyber rule (~line 2310). Add warm background override, heading color override, warm glass tints, warm preview pane backgrounds.

**Implementation:**

Part 1 — Expand `body.theme-claudify` at line 93:
```css
body.theme-claudify {
    --accent-primary: #D97757;
    --kanban-bg: #1A1816;
    --panel-bg: #24211E;
    --panel-bg2: #2D2925;
    --border-color: #38332E;
    --border-bright: #5C544A;
    --card-bg: #24211E;
    --card-bg-hover: #2D2925;
    --text-primary: #F0EBE6;
    --text-secondary: #A8A095;
    --display-font: 'Poppins';
    --display-letter-spacing: normal;
    --display-font-stretch: 100%;
}
```

Part 2 — Suppression rules (append after cyber rules, ~line 2310). Use ONLY these preview pane IDs: `#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-design`, `#kanban-preview-pane`, `#markdown-preview-tickets` (NO `#markdown-preview-briefs` — does not exist in this file):
```css
/* Claudify: suppress scanlines */
body.theme-claudify .cyber-scanlines { display: none !important; }
body.theme-claudify:not(.cyber-animation-disabled) .cyber-scanlines::before { display: none !important; }

/* Claudify: suppress neon text-shadow glow on headings */
body.theme-claudify .preview-panel-wrapper h1,
body.theme-claudify .preview-panel-wrapper h2,
body.theme-claudify .preview-panel-wrapper h3 { text-shadow: none; }

/* Claudify: suppress neon box-shadow glow on inline code */
body.theme-claudify #markdown-preview code,
body.theme-claudify #markdown-preview-online code,
body.theme-claudify #markdown-preview-design code,
body.theme-claudify #kanban-preview-pane code,
body.theme-claudify #markdown-preview-tickets code { box-shadow: none; }

/* Claudify: suppress neon box-shadow glow on code blocks */
body.theme-claudify #markdown-preview pre,
body.theme-claudify #markdown-preview-online pre,
body.theme-claudify #markdown-preview-design pre,
body.theme-claudify #kanban-preview-pane pre,
body.theme-claudify #markdown-preview-tickets pre { box-shadow: none; }

/* Claudify: suppress neon box-shadow glow on blockquotes */
body.theme-claudify #markdown-preview blockquote,
body.theme-claudify #markdown-preview-online blockquote,
body.theme-claudify #markdown-preview-design blockquote,
body.theme-claudify #kanban-preview-pane blockquote,
body.theme-claudify #markdown-preview-tickets blockquote { box-shadow: none; }

/* Claudify: suppress neon glow on alert boxes */
body.theme-claudify .alert-note,
body.theme-claudify .alert-tip,
body.theme-claudify .alert-important,
body.theme-claudify .alert-warning,
body.theme-claudify .alert-caution { box-shadow: none; }

/* Claudify: suppress neon glow on selected/hovered items */
body.theme-claudify .kanban-plan-item.selected,
body.theme-claudify .kanban-plan-item:hover,
body.theme-claudify .tree-node.selected,
body.theme-claudify .tree-node:hover { box-shadow: none; }

/* Claudify: suppress neon glow on column badges */
body.theme-claudify .kanban-column-badge[data-column="CREATED"],
body.theme-claudify .kanban-column-badge[data-column="PLAN_REVIEWED"],
body.theme-claudify .kanban-column-badge[data-column="CODED"],
body.theme-claudify .kanban-column-badge[data-column="CODE_REVIEWED"],
body.theme-claudify .kanban-column-badge[data-column="COMPLETED"] { box-shadow: none; }

/* Claudify: suppress neon glow on strip buttons */
body.theme-claudify .strip-btn:hover:not(:disabled) { box-shadow: none; }

/* Claudify: suppress neon glow on planning buttons */
body.theme-claudify .planning-button { box-shadow: none; }
body.theme-claudify .planning-button:hover:not(:disabled) { box-shadow: none; }

/* Claudify: suppress neon glow on preview panel wrapper */
body.theme-claudify .preview-panel-wrapper { box-shadow: none; }

/* Claudify: suppress neon glow on sidebar folder buttons */
body.theme-claudify .sidebar-folders-btn:hover { box-shadow: none; }

/* Claudify: suppress neon glow on planning inputs */
body.theme-claudify .planning-select:focus,
body.theme-claudify .planning-input:focus { box-shadow: none; }

/* Claudify: suppress neon glow on modals */
body.theme-claudify .duplicate-modal .modal-content,
body.theme-claudify .folder-modal .modal-content { box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5); }

/* Claudify: suppress neon glow on planning cards */
body.theme-claudify .planning-card { box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4); }
```

Part 3 — Warm background for cyber grid (append after suppression rules):
```css
body.theme-claudify.cyber-theme-enabled {
    background-color: #1A1816;
    background-image:
        linear-gradient(color-mix(in srgb, var(--accent-primary) 4%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 4%, transparent) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}
```

Part 4 — Heading color override (h2-h6 → warm cream). Use ONLY the 5 preview pane IDs that exist in this file:
```css
body.theme-claudify #markdown-preview h2,
body.theme-claudify #markdown-preview-online h2,
body.theme-claudify #markdown-preview-design h2,
body.theme-claudify #kanban-preview-pane h2,
body.theme-claudify #markdown-preview-tickets h2,
body.theme-claudify #markdown-preview h3,
body.theme-claudify #markdown-preview-online h3,
body.theme-claudify #markdown-preview-design h3,
body.theme-claudify #kanban-preview-pane h3,
body.theme-claudify #markdown-preview-tickets h3,
body.theme-claudify #markdown-preview h4,
body.theme-claudify #markdown-preview-online h4,
body.theme-claudify #markdown-preview-design h4,
body.theme-claudify #kanban-preview-pane h4,
body.theme-claudify #markdown-preview-tickets h4,
body.theme-claudify #markdown-preview h5,
body.theme-claudify #markdown-preview-online h5,
body.theme-claudify #markdown-preview-design h5,
body.theme-claudify #kanban-preview-pane h5,
body.theme-claudify #markdown-preview-tickets h5,
body.theme-claudify #markdown-preview h6,
body.theme-claudify #markdown-preview-online h6,
body.theme-claudify #markdown-preview-design h6,
body.theme-claudify #kanban-preview-pane h6,
body.theme-claudify #markdown-preview-tickets h6 {
    color: #F0EBE6;
}
```

Part 5 — Warm glass tints. Use ONLY tree pane IDs that exist in this file (`#tree-pane`, `#tree-pane-online`, `#tree-pane-tickets`, `#kanban-list-pane`):
```css
body.theme-claudify .controls-strip,
body.theme-claudify .kanban-controls-strip {
    background: rgba(36, 33, 30, 0.65);
}
body.theme-claudify #tree-pane,
body.theme-claudify #tree-pane-online,
body.theme-claudify #tree-pane-tickets,
body.theme-claudify #kanban-list-pane {
    background: rgba(36, 33, 30, 0.70);
}
body.theme-claudify .planning-card {
    background: rgba(36, 33, 30, 0.60);
}
body.theme-claudify .planning-select,
body.theme-claudify .planning-input {
    background: rgba(36, 33, 30, 0.70);
}
body.theme-claudify .planning-button.secondary {
    background: rgba(36, 33, 30, 0.50);
}
body.theme-claudify .duplicate-modal .modal-content,
body.theme-claudify .folder-modal .modal-content {
    background: rgba(26, 24, 22, 0.88);
}
```

Part 6 — Warm preview pane backgrounds. Use ONLY preview pane IDs that exist in this file (`#preview-pane`, `#preview-pane-online`, `#preview-pane-tickets`, `#kanban-preview-pane`):
```css
body.theme-claudify #preview-pane,
body.theme-claudify #preview-pane-online,
body.theme-claudify #preview-pane-tickets,
body.theme-claudify #kanban-preview-pane {
    background-color: rgba(240, 235, 230, 0.015);
    background-image:
        linear-gradient(color-mix(in srgb, var(--accent-primary) 8%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 8%, transparent) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
}
```

**Edge Cases:** `#markdown-preview-briefs` does NOT exist in planning.html — must not be included in any selector list for this file. `epic-plan-item` and `constitution-file-item` do NOT exist in this file — must not be included in item suppression rules.

---

### `src/webview/design.html` (lines 94-99 for var block; cyber rules at lines 1929-2360)

**Context:** Design panel webview. Similar to planning.html but has additional tree panes and preview panes. Has `#markdown-preview-briefs` and `#stitch-preview-pane` which planning.html does NOT have. Tree panes: `#tree-pane`, `#tree-pane-online`, `#tree-pane-design`, `#tree-pane-briefs`, `#tree-pane-html`, `#tree-pane-images`, `#tree-pane-tickets`. Preview panes: `#preview-pane`, `#preview-pane-online`, `#preview-pane-design`, `#preview-pane-html`, `#preview-pane-images`, `#preview-pane-tickets`, `#stitch-preview-pane`, `#kanban-preview-pane`. `body.cyber-theme-enabled` background at line 2140.

**Logic:** Same structure as planning.html but with expanded selector lists. Must include `#markdown-preview-briefs` in code/pre/blockquote/heading suppression. Must include `#stitch-preview-pane` in preview pane warm background override.

**Implementation:** Same as planning.html with these additions:
- Part 2 suppression: add `#markdown-preview-briefs` to code, pre, and blockquote selector lists
- Part 4 heading override: add `#markdown-preview-briefs` to h2-h6 selector lists
- Part 5 glass tints: use all 7 tree pane IDs + `#kanban-list-pane`
- Part 6 warm preview: use all 8 preview pane IDs including `#preview-pane-design`, `#preview-pane-html`, `#preview-pane-images`, `#stitch-preview-pane`

**Edge Cases:** `#stitch-preview-pane` was missing from the original plan — must be included. `epic-plan-item`, `constitution-file-item`, `kanban-column-badge[data-column]` do NOT exist in this file — exclude from suppression rules.

---

### `src/webview/project.html` (lines 72-77 for var block; cyber rules at lines 280-730)

**Context:** Project panel webview with 4 tabs (Kanban, Epics, Constitution, Tuning). Uses `#kanban-preview-content`, `#epics-preview-content`, `#constitution-preview-content`, `#tuning-preview-content` for markdown preview IDs. List panes: `#kanban-list-pane`, `#epics-list-pane`, `#constitution-list-pane`, `#tuning-list-pane`. Preview panes: `#kanban-preview-pane`, `#epics-preview-pane`, `#constitution-preview-pane`, `#tuning-preview-pane`. Has `epic-plan-item` and `constitution-file-item` glow rules. Has `shared-tab-btn.active` glow. `body.cyber-theme-enabled` background at line 643. Does NOT have: `tree-node`, `planning-card`, `planning-select`, `planning-input`, `planning-button`, `duplicate-modal`, `folder-modal`, `sidebar-folders-btn`, `kanban-column-badge[data-column]` glow.

**Logic:** Same variable expansion. Suppression rules scoped to selectors that exist in this file. Heading color override uses `*-preview-content` IDs instead of `#markdown-preview-*` IDs.

**Implementation:**

Part 1 — Expand `body.theme-claudify` at line 72 (same variable set as planning.html).

Part 2 — Suppression rules (append after cyber rules, ~line 730). Use project.html-specific selectors:
```css
/* Claudify: suppress scanlines */
body.theme-claudify .cyber-scanlines { display: none !important; }
body.theme-claudify:not(.cyber-animation-disabled) .cyber-scanlines::before { display: none !important; }

/* Claudify: suppress neon text-shadow glow on headings */
body.theme-claudify .preview-panel-wrapper h1,
body.theme-claudify .preview-panel-wrapper h2,
body.theme-claudify .preview-panel-wrapper h3 { text-shadow: none; }

/* Claudify: suppress neon box-shadow glow on inline code */
body.theme-claudify #kanban-preview-content code,
body.theme-claudify #epics-preview-content code,
body.theme-claudify #constitution-preview-content code,
body.theme-claudify #tuning-preview-content code { box-shadow: none; }

/* Claudify: suppress neon box-shadow glow on code blocks */
body.theme-claudify #kanban-preview-content pre,
body.theme-claudify #epics-preview-content pre,
body.theme-claudify #constitution-preview-content pre,
body.theme-claudify #tuning-preview-content pre { box-shadow: none; }

/* Claudify: suppress neon box-shadow glow on blockquotes */
body.theme-claudify #kanban-preview-content blockquote,
body.theme-claudify #epics-preview-content blockquote,
body.theme-claudify #constitution-preview-content blockquote,
body.theme-claudify #tuning-preview-content blockquote { box-shadow: none; }

/* Claudify: suppress neon glow on selected/hovered items */
body.theme-claudify .kanban-plan-item.selected,
body.theme-claudify .kanban-plan-item:hover,
body.theme-claudify .epic-plan-item.selected,
body.theme-claudify .epic-plan-item:hover,
body.theme-claudify .constitution-file-item.selected,
body.theme-claudify .constitution-file-item:hover { box-shadow: none; }

/* Claudify: suppress neon glow on strip buttons */
body.theme-claudify .strip-btn:hover:not(:disabled) { box-shadow: none; }

/* Claudify: suppress neon glow on preview panel wrapper */
body.theme-claudify .preview-panel-wrapper { box-shadow: none; }

/* Claudify: suppress neon glow on tab buttons */
body.theme-claudify .shared-tab-btn.active { box-shadow: none; }
```

Part 3 — Warm background (same as planning.html).

Part 4 — Heading color override using `*-preview-content` IDs:
```css
body.theme-claudify #kanban-preview-content h2,
body.theme-claudify #epics-preview-content h2,
body.theme-claudify #constitution-preview-content h2,
body.theme-claudify #tuning-preview-content h2,
body.theme-claudify #kanban-preview-content h3,
body.theme-claudify #epics-preview-content h3,
body.theme-claudify #constitution-preview-content h3,
body.theme-claudify #tuning-preview-content h3,
body.theme-claudify #kanban-preview-content h4,
body.theme-claudify #epics-preview-content h4,
body.theme-claudify #constitution-preview-content h4,
body.theme-claudify #tuning-preview-content h4,
body.theme-claudify #kanban-preview-content h5,
body.theme-claudify #epics-preview-content h5,
body.theme-claudify #constitution-preview-content h5,
body.theme-claudify #tuning-preview-content h5,
body.theme-claudify #kanban-preview-content h6,
body.theme-claudify #epics-preview-content h6,
body.theme-claudify #constitution-preview-content h6,
body.theme-claudify #tuning-preview-content h6 {
    color: #F0EBE6;
}
```

Part 5 — Warm glass tints using project.html list pane IDs:
```css
body.theme-claudify .controls-strip,
body.theme-claudify .kanban-controls-strip {
    background: rgba(36, 33, 30, 0.65);
}
body.theme-claudify #kanban-list-pane,
body.theme-claudify #epics-list-pane,
body.theme-claudify #constitution-list-pane,
body.theme-claudify #tuning-list-pane {
    background: rgba(36, 33, 30, 0.70);
}
```

Part 6 — Warm preview pane backgrounds using project.html preview pane IDs:
```css
body.theme-claudify #kanban-preview-pane,
body.theme-claudify #epics-preview-pane,
body.theme-claudify #constitution-preview-pane,
body.theme-claudify #tuning-preview-pane {
    background-color: rgba(240, 235, 230, 0.015);
    background-image:
        linear-gradient(color-mix(in srgb, var(--accent-primary) 8%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 8%, transparent) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
}
```

**Edge Cases:** `tree-node`, `planning-card`, `planning-button`, `planning-select`, `planning-input`, `duplicate-modal`, `folder-modal`, `sidebar-folders-btn`, `kanban-column-badge[data-column]` do NOT exist in this file — must not be included in suppression rules. `#markdown-preview-*` IDs do NOT exist in this file — use `#kanban-preview-content` etc. instead.

---

### `src/webview/kanban.html` (lines 34-36 for var block)

**Context:** Standalone kanban board webview. No cyber-theme-enabled rules. Only needs variable overrides.

**Logic:** Expand `body.theme-claudify` block with warm variables. Must add `--accent-primary: #D97757` (currently missing — only `--accent-teal` is overridden, leaving `--accent-primary` as cyan).

**Implementation:**
```css
body.theme-claudify {
    --accent-primary: #D97757;
    --accent-teal: #D97757;
    --bg-color: #1A1816;
    --panel-bg: #24211E;
    --panel-bg2: #2D2925;
    --border-color: #38332E;
    --border-bright: #5C544A;
    --text-primary: #F0EBE6;
    --text-secondary: #A8A095;
}
```

**Edge Cases:** `--accent-primary` was missing from the original plan — added here. Without it, any CSS using `var(--accent-primary)` directly would show cyan instead of terracotta.

---

### `src/webview/implementation.html` (lines 46-49 for var block)

**Context:** Implementation webview. No cyber-theme-enabled rules. Only needs variable overrides.

**Logic:** Expand `body.theme-claudify` block with warm variables. Must add `--accent-primary: #D97757` (currently missing — only `--accent-teal` and `--accent-cyan` are overridden).

**Implementation:**
```css
body.theme-claudify {
    --accent-primary: #D97757;
    --accent-teal: #D97757;
    --accent-cyan: #D97757;
    --bg-color: #1A1816;
    --panel-bg: #24211E;
    --panel-bg2: #2D2925;
    --border-color: #38332E;
    --border-bright: #5C544A;
    --bg-dim: #24211E;
    --text-primary: #F0EBE6;
    --text-secondary: #A8A095;
}
```

**Edge Cases:** `--accent-primary` was missing from the original plan — added here.

---

### `src/webview/setup.html` (lines 37-39 for var block)

**Context:** Setup webview. No cyber-theme-enabled rules. Only needs variable overrides.

**Logic:** Expand `body.theme-claudify` block with warm variables. Must add `--accent-primary: #D97757` (currently missing — only `--accent-teal` is overridden).

**Implementation:**
```css
body.theme-claudify {
    --accent-primary: #D97757;
    --accent-teal: #D97757;
    --bg-color: #1A1816;
    --panel-bg: #24211E;
    --panel-bg2: #2D2925;
    --border-color: #38332E;
    --border-bright: #5C544A;
    --bg-dim: #24211E;
    --text-primary: #F0EBE6;
    --text-secondary: #A8A095;
}
```

**Edge Cases:** `--accent-primary` was missing from the original plan — added here.

---

### `src/webview/shared-tabs.css` (64 lines total)

**Context:** Shared CSS file for tab components used across webviews. Has cyber-theme-enabled rules for `.shared-tab-btn.active` (box-shadow glow, line 55) and `.shared-tab-bar` (background, line 59).

**Logic:** Append claudify-specific overrides at end of file (after line 64).

**Implementation:**
```css
body.theme-claudify .shared-tab-btn.active {
    box-shadow: none;
}

body.theme-claudify .shared-tab-bar {
    background: rgba(36, 33, 30, 0.65);
}
```

**Edge Cases:** These overrides apply globally to any webview that loads `shared-tabs.css`. The `body.theme-claudify` prefix ensures they only activate when claudify theme is active.

## File Change Summary

| File | Changes |
|---|---|
| `src/webview/planning.html` | Expand `body.theme-claudify` vars (Part 1), add suppression rules (Part 2), warm background override (Part 3), heading color override (Part 4), warm glass tints (Part 5), warm preview pane (Part 6) |
| `src/webview/design.html` | Same as planning.html with additional pane IDs (`#markdown-preview-briefs`, `#stitch-preview-pane`, extra tree/preview panes) |
| `src/webview/project.html` | Variable expansion + suppression rules (scoped to `*-preview-content` IDs, `epic-plan-item`, `constitution-file-item`), warm background, heading override, glass tints, preview pane |
| `src/webview/kanban.html` | Expand `body.theme-claudify` vars only — add `--accent-primary` (was missing) + warm background/text/border vars |
| `src/webview/implementation.html` | Expand `body.theme-claudify` vars only — add `--accent-primary` (was missing) + warm background/text/border vars |
| `src/webview/setup.html` | Expand `body.theme-claudify` vars only — add `--accent-primary` (was missing) + warm background/text/border vars |
| `src/webview/shared-tabs.css` | Add claudify tab overrides (2 rules at end of file) |

## Additional Notes

1. **CSS specificity:** `body.theme-claudify .selector` (0,2,1) always beats `.cyber-theme-enabled .selector` (0,2,0) because the `body` element selector adds 1 to the element count. For cyber rules using `body.cyber-theme-enabled` (0,1,1), `body.theme-claudify.cyber-theme-enabled` (0,2,1) wins. No tie cases exist in the codebase — all cyber rules either use `.cyber-theme-enabled .selector` or `body.cyber-theme-enabled` (for background/heading rules).

2. **Inline code color:** The base CSS in project.html sets inline `code` color to `var(--accent-teal)`. With claudify, `--accent-teal` is `#D97757`, so inline code will be terracotta — matches Warm Obsidian spec.

3. **Heading text-transform:** Base CSS in project.html applies `text-transform: uppercase` to h1-h6. **Decision: Leave as-is** — changing heading transforms is a deeper structural change for a follow-up.

4. **`--accent-teal-dim` and `--glow-teal`:** Computed from `--accent-teal` via `color-mix()` — automatically inherit terracotta. No additional overrides needed.

5. **`--accent-neon`:** Set to `var(--accent-teal)` in planning.html — inherits terracotta. Glow suppressed by Part 2 rules.

6. **`--accent-teal-bright: #5ce8e6`:** Hardcoded in `:root`, NOT overridden by claudify. Pre-existing issue, not a regression. Rarely referenced.

7. **Bundled fonts:** No changes needed. Hanken Grotesk = body, Poppins = display, GeistPixel = afterburner only.

8. **No JS changes needed:** Theme-switching logic already adds both `cyber-theme-enabled` and `theme-claudify` classes to `body`.

9. **Parts 3 and 8 merged:** Original plan had redundant `body.theme-claudify.cyber-theme-enabled` overrides in Parts 3 and 8. Merged into Part 3 only.

## Verification Plan

### Automated Tests
No automated tests applicable — CSS-only visual theme changes require manual verification.

### Manual Verification

1. Open VS Code with the Switchboard extension loaded
2. Switch to the claudify theme via the design panel or settings
3. Verify across all 6 webview panels:
   - Backgrounds are warm charcoal (not pure black)
   - Text is warm cream (not cool grey)
   - Borders are warm brown (not cold grey)
   - No scanlines visible
   - No sweep animation
   - No neon glow on headings, code, blockquotes, items
   - Background grid is visible with warm tint
   - Backdrop blur is preserved on strips and panes
   - h1 is terracotta, h2-h6 are warm cream
   - Accent color (buttons, active states) is terracotta `#D97757`
4. Switch back to afterburner theme — verify cyber effects are restored
5. Switch to default theme — verify no claudify overrides leak

## Recommendation

Complexity 5 → **Send to Coder**
