# Sidebar Card Styling Consistency Fix

## Goal
Fix styling inconsistency between left sidebar cards in project.html — Epics and Constitution tabs currently display pure black cards without gradient backgrounds, while Kanban plans tab has the correct gradient styling.

**Core Problem:** The `.epic-plan-item` and `.constitution-file-item` classes in project.html only share a generic selector with `.kanban-plan-item` that doesn't set a background. This causes them to default to pure black instead of the teal gradient background that `.kanban-plan-item` has via its specific CSS rule.

**Background:**
- File: `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.html`
- The `.kanban-plan-item` class (lines 238-262) has specific gradient background styling
- The generic selector `.kanban-plan-item, .epic-plan-item, .constitution-file-item` (lines 225-237) only sets padding, border, and cursor properties
- `.epic-plan-item` and `.constitution-file-item` lack their own specific gradient rules

## Metadata
- **Tags:** ui, frontend
- **Complexity:** 2

## User Review Required
No — this is a pure CSS styling fix with no functional or API changes.

## Complexity Audit

### Routine
- Single-file CSS additions in `project.html`
- Mirrors existing `.kanban-plan-item` styling patterns exactly
- No new architectural patterns or logic
- No data model or API surface changes

### Complex / Risky
- None

## Edge-Case & Dependency Audit

**Race Conditions:** None — this is static CSS.

**Security:** None — no user input or dynamic content injection.

**Side Effects:**
- The new rules re-declare `padding`, `border-bottom`, `cursor`, and `transition` already set by the generic selector (lines 225-230). This is redundant but harmless.
- The generic selector sets `border-bottom: 1px solid var(--border-color)` while the new specific rules use shorthand `border: 1px solid var(--border-color)`. The shorthand will override and render consistently, but this is a specificity interaction worth noting.
- The generic `.selected` rule (lines 234-236) sets `border-left: 3px solid var(--accent-teal)`. The new specific `.selected` rules set `border-left-color: var(--accent-teal)`. These target the same property and the more specific selector wins. Verified: no conflict.

**Dependencies & Conflicts:** None. No other files reference these class names for styling. The VS Code webview CSP allows inline styles. The `--accent-teal` and related custom properties are defined in the same file's `:root` (lines 41-71).

## Dependencies
None.

## Adversarial Synthesis
Key risks: CSS rule duplication across 12 near-identical blocks creates maintenance burden; generic selector shorthand `border` vs specific `border-bottom` interaction needs visual verification; theme-claudify gradient quality should be spot-checked since `--accent-teal` aliases `--accent-primary` which changes to orange. Mitigations: add a CSS comment documenting the mirroring relationship; verify border consistency and theme-claudify rendering in manual testing.

## Proposed Changes

### `/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/project.html`

**Context:** After the existing `.kanban-plan-item` CSS block (ending at line 262), add matching blocks for `.epic-plan-item` and `.constitution-file-item`.

**Logic:** These classes currently inherit only the generic shared styling (padding, cursor, basic hover/selected states). They need the full gradient card treatment that `.kanban-plan-item` has to maintain visual consistency across all sidebar tabs.

**Implementation:**

1. **Add `.epic-plan-item` base styling** (after line 262):
```css
/* .epic-plan-item and .constitution-file-item mirror .kanban-plan-item styling */
.epic-plan-item {
    padding: 12px;
    border-bottom: 1px solid var(--border-color);
    cursor: pointer;
    transition: background 0.15s;
    border: 1px solid var(--border-color);
    border-radius: 4px;
    margin: 3px 0;
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2)) 0%, color-mix(in srgb, var(--accent-teal) 4%, var(--panel-bg)) 100%);
    border-left: 3px solid var(--accent-teal-dim);
}
```

2. **Add `.epic-plan-item:hover`:**
```css
.epic-plan-item:hover {
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2)) 0%, color-mix(in srgb, var(--accent-teal) 4%, var(--panel-bg)) 100%);
    border-color: color-mix(in srgb, var(--accent-teal) 50%, transparent);
    border-left-color: var(--accent-teal);
    box-shadow: 0 4px 12px color-mix(in srgb, var(--accent-teal) 20%, transparent);
}
```

3. **Add `.epic-plan-item.selected`:**
```css
.epic-plan-item.selected {
    background: linear-gradient(180deg, color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2)) 0%, color-mix(in srgb, var(--accent-teal) 4%, var(--panel-bg)) 100%);
    border-color: var(--accent-teal);
    border-left-color: var(--accent-teal);
    box-shadow: 0 0 8px color-mix(in srgb, var(--accent-teal) 35%, transparent),
                inset 0 0 4px color-mix(in srgb, var(--accent-teal) 10%, transparent);
    color: var(--accent-teal);
}
```

4. **Add cyber theme variants for `.epic-plan-item`:**
```css
.cyber-theme-enabled .epic-plan-item:hover {
    box-shadow: 0 0 10px color-mix(in srgb, var(--accent-teal) 30%, transparent);
}
.cyber-theme-enabled .epic-plan-item.selected {
    box-shadow: 0 0 12px color-mix(in srgb, var(--accent-teal) 40%, transparent),
                inset 0 0 6px color-mix(in srgb, var(--accent-teal) 15%, transparent);
}
```

5. **Repeat steps 1-4 for `.constitution-file-item`** by replacing `.epic-plan-item` with `.constitution-file-item` in all selectors and pasting the identical rule bodies.

**Edge Cases:**
- **Border override:** The generic selector sets `border-bottom` but the new rules use `border` shorthand. The shorthand wins and renders a uniform 1px border on all sides. Verified acceptable.
- **Theme-claudify:** When `body.theme-claudify` is active, `--accent-primary` becomes `#D97757` (orange), and since `--accent-teal` aliases it, gradients become orange-tinted. This is the same behavior `.kanban-plan-item` already has and is acceptable.
- **High item count:** Sidebar may hold 50+ cards. CSS gradients are GPU-composited and performant at this scale. No performance concern.

## Verification Plan

### Automated Tests
None required — this is a visual CSS change with no testable logic. The project has no visual regression testing infrastructure for webview CSS.

### Manual Verification
- Open project.html in the Switchboard extension
- Navigate to the Epics tab — cards should have teal gradient background
- Navigate to the Constitution tab — cards should have teal gradient background
- Hover over cards in both tabs — should show enhanced border and glow
- Select cards in both tabs — should show enhanced glow and teal text color
- Enable cyber theme — should show enhanced glow effects
- **Border consistency check:** Verify no double borders or missing bottom borders on cards (check that `border` shorthand from new rules interacts cleanly with generic `border-bottom`)
- **Theme-claudify check:** Switch to Claudify theme, verify gradients look acceptable (orange-tinted, not muddy)

---

**Recommendation:** Send to Intern

## Review Findings
Files changed: `src/webview/project.html` only. `.epic-plan-item` (272-303) and `.constitution-file-item` (305-336) blocks added after `.kanban-plan-item`, byte-for-byte mirroring its base/hover/selected and cyber-theme variants, with the documenting comment at line 271. Specificity is correct — the new single-class rules override the generic `.kanban-plan-item, .epic-plan-item, .constitution-file-item` block (225-237), so the `border` shorthand cleanly supersedes the generic `border-bottom` and the `.selected` border-left resolves without conflict. Validation: static review only (compile/tests skipped); manual gradient/theme-claudify check still required. Remaining risk: none material; duplication is the accepted maintenance trade-off noted in the plan.
