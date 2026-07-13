# Fix Prompts Tab Restricted Content Width in Kanban Webview

## Goal

The **Prompts** tab in the Kanban webview has a much more restricted content width than every other tab. The vertical scrollbar renders in the middle of the content area instead of at the right edge of the viewport, leaving a large empty band of dead space on the right side of the panel.

### Problem Analysis

The Kanban webview (`kanban.html`) hosts a tabbed interface: KANBAN, AGENTS, PROMPTS, AUTOMATION, WORKTREES, UAT, COMMS, SETUP. Every tab's content container is a `.shared-tab-content` element that uses `flex: 1` (from `shared-tabs.css`) to fill the full available width. The inner wrapper of each tab then uses an inline `style="padding:12px; overflow-y:auto; height:100%;"` — no width constraint — so content flows edge-to-edge and the scrollbar sits at the viewport's right edge.

The Prompts tab is the lone exception. Its inner wrapper carries the class `.prompts-tab`, which sets `max-width: 800px`. On any viewport wider than 800px the wrapper is clamped to 800px and the scrollbar lands at the 800px boundary — visually in the middle of the panel. The remainder of the panel (from 800px to the right edge) is empty, wasted space.

> **Superseded:** "...(because the parent is a flex container that centers the child by default in this layout) the scrollbar lands at the 800px boundary... The other ~half of the panel is empty, wasted space."
> **Reason:** The mechanism claim is factually wrong. `.shared-tab-content` is `display: flex; flex-direction: column` with **no `align-items` declared** (verified in `shared-tabs.css` line 43 and `kanban.html` line 2560). The flex default is `align-items: stretch`, **not `center`**. When `max-width: 800px` prevents the stretch, the item aligns to the **start** (left edge) of the cross axis — it is left-aligned, not centered. The original symptom description itself confirms this: it reports "a large empty band of dead space on the **right** side" (singular, right only). A centered child would leave dead space on **both** sides. The fix (remove `max-width`) is unaffected by this correction — removing the cap lets the child stretch to full width regardless of alignment.
> **Replaced with:** The wrapper is clamped to 800px and, because the flex parent's default `align-items: stretch` cannot stretch past the `max-width` cap (so the item falls back to start/left alignment), the 800px-wide child sits at the left of the panel. The scrollbar lands at the 800px boundary and the space from 800px to the right edge is empty.

### Root Cause

`src/webview/kanban.html` line 2267 — the `.prompts-tab` rule:

```css
/* Role-based Prompts Tab UI */
.prompts-tab {
    padding: 20px;
    max-width: 800px;   /* ← clamps width, pushes scrollbar into the middle */
    overflow-y: auto;
    height: 100%;
}
```

No other tab in `kanban.html` sets a `max-width` on its content wrapper. The `800px` cap was likely added for readability on very wide monitors but has the unintended side effect of producing a mid-panel scrollbar and a half-empty panel on normal-width webview frames.

## Metadata

- **Tags:** ui, bugfix, frontend
- **Complexity:** 2

## User Review Required

Yes — visual verification only. User should confirm the Prompts tab content fills the full panel width, the vertical scrollbar (when present) sits at the right edge of the panel (not at ~800px), and that the other tabs render unchanged. No code-level review needed beyond the one-line CSS removal.

## Complexity Audit

### Routine
- Single-line CSS change in one file (`src/webview/kanban.html` line 2267): remove `max-width: 800px` from `.prompts-tab`.
- No logic, no JS, no data flow, no cross-file coordination. Risk surface is limited to the visual layout of one tab.
- Reversible by re-adding the one line.

### Complex / Risky
- None. No state, no persistence, no async, no API surface.

> *Adversarial concern (preserved from original):* Could removing `max-width` hurt readability on ultra-wide monitors? Possibly — content lines could get very long. This is a cosmetic trade-off the user can revisit, but it matches the behavior of every other tab in the same webview, so consistency wins. If a readability cap is desired later, it should be applied uniformly across all tabs via `.shared-tab-content`, not singled out on the Prompts tab.

## Edge-Case & Dependency Audit

- **Narrow viewports (<800px):** Already fine — `max-width` only clamps when the viewport exceeds it, so narrow viewports are unaffected by removing the rule.
- **Other tabs within `kanban.html` (per-tab confirmation, not just a claim):** Verified by grepping `max-width` across `kanban.html` — the only occurrence on a tab content wrapper is line 2267 (`.prompts-tab`). The other 7 tabs (KANBAN `#kanban-tab-content`, AGENTS `#agents-tab-content`, AUTOMATION `#automation-tab-content`, WORKTREES `#worktrees-tab-content`, UAT `#uat-tab-content`, COMMS `#comms-tab-content`, SETUP `#setup-tab-content`) use `.shared-tab-content` with inner wrappers carrying inline `style="padding:12px; overflow-y:auto; height:100%"` and **no** `max-width`. All other `max-width` uses in `kanban.html` (lines 679, 1524, 1862, 1968, 2151, 3331, 10637) are on modals, chips, or small UI elements — not tab content wrappers. The "consistency with sibling tabs" premise is therefore verified, not assumed.
- **Other webviews:** Checked `planning.html`, `project.html`, `setup.html`, `implementation.html`, `design.html`. None apply a `max-width` to a main content container (only to modals/selects, which is intentional). No spillover risk.
- **JS dependencies:** None. `.prompts-tab` is a pure layout class; no JS reads its computed width or relies on the 800px cap.
- **Shared CSS (`shared-tabs.css`):** The `.shared-tab-content` parent already provides `flex: 1` and full-width behavior; the fix simply lets the child inherit that width instead of clamping it.

## Dependencies

- None. Standalone one-line CSS fix; no prerequisite plans or sessions.

## Adversarial Synthesis

Key risks: (1) the original mechanism explanation ("parent centers the child by default") was factually wrong — corrected via Superseded callout; the actual behavior is left-alignment (flex `stretch` capped by `max-width` falls back to start), which the right-only empty-band symptom confirms. The fix is unaffected. (2) The "consistency with sibling tabs" premise was unverified in the original — now confirmed by grepping: line 2267 is the only tab-wrapper `max-width` in `kanban.html`. (3) Residual cosmetic risk: very long lines on ultra-wide monitors — accepted as matching sibling behavior; a uniform readability cap is a separate future decision. No race, security, or data-flow surface.

## Proposed Changes

### File: `src/webview/kanban.html`

**Change 1 — Remove the `max-width` clamp on `.prompts-tab` (line 2267).**

Before (lines 2264–2270):
```css
/* Role-based Prompts Tab UI */
.prompts-tab {
    padding: 20px;
    max-width: 800px;
    overflow-y: auto;
    height: 100%;
}
```

After:
```css
/* Role-based Prompts Tab UI */
.prompts-tab {
    padding: 20px;
    overflow-y: auto;
    height: 100%;
}
```

That's the entire fix. The wrapper now fills the full `.shared-tab-content` width, the scrollbar moves to the right edge of the panel, and the Prompts tab visually matches the other tabs.

**Optional (not required) — align padding with sibling tabs.** The other tabs use `padding:12px`; the Prompts tab uses `padding:20px`. This is an observed spacing difference (not a verified intent) for the prompts form and does not cause the bug, so it is left as-is. Only change it if the user requests visual parity.

## Verification Plan

> Per session directives: **skip compilation** (no build/compile step required) and **skip automated tests**. This is a pure CSS layout fix; visual verification is the correct gate.

1. **Open the Kanban webview** in VS Code (Switchboard sidebar → Kanban).
2. **Click the PROMPTS tab.**
   - Confirm the content fills the full width of the panel.
   - Confirm the vertical scrollbar (if present) sits at the right edge of the panel, not at the ~800px boundary.
   - Confirm there is no large empty band on the right side.
3. **Resize the webview panel** wider and narrower:
   - Wide: content scales with the panel; no 800px cap.
   - Narrow (<800px): no regression — content was already full-width below the cap.
4. **Compare against sibling tabs** (AGENTS, UAT, SETUP): the Prompts tab should now match their edge-to-edge layout behavior.
5. **Sanity-check the other tabs** still render correctly (no shared-CSS regression).

### Automated Tests

Skip automated tests (per session directive). Pure CSS layout fix with no logic surface; visual verification is the correct gate.

## Completion Summary

Removed the `max-width: 800px` declaration from the `.prompts-tab` rule in `src/webview/kanban.html` (was line 2267). The Prompts tab content wrapper now stretches to the full `.shared-tab-content` width, matching the layout behavior of every other tab in the Kanban webview; the vertical scrollbar will sit at the right edge of the panel instead of at the 800px boundary. No other files were touched. No issues encountered — single-line CSS removal, verified by reading the modified region back.

## Review Findings

**Reviewer pass (in-place, 2026-07-13).** The `src/webview/kanban.html` change matches the plan's "After" exactly; no JS depends on the 800px cap (the only `.prompts-tab` JS ref at line 4329 touches `scrollTop`, not width); sibling-tab consistency and `shared-tabs.css` flex-stretch claims verified. **CRITICAL finding:** the runtime loads `dist/webview/kanban.html` first (`KanbanProvider.ts:10238`), and that gitignored build artifact still carried `max-width: 800px` — the fix was invisible at runtime. **Fix applied:** removed the same line from `dist/webview/kanban.html:2267`; both copies now match. Files changed: `dist/webview/kanban.html`. Verification: read-back of both copies confirms the rule is identical and no `max-width: 800px` remains on `.prompts-tab` in either; compilation/tests skipped per session directive. **Remaining risk:** `dist/` will re-stale if webpack runs from a dirty `src/` — but on next clean build the CopyWebpackPlugin (`webpack.config.js:76`) syncs correctly; the manual sync bridges the gap until then.
