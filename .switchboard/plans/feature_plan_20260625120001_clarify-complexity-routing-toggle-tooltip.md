# Clarify the Complexity Routing Toggle Tooltip in kanban.html

## Goal

### Problem
The complexity routing toggle button in `kanban.html` (the `#complexity-routing-toggle` element, shown on the `CODED_AUTO` column header for reviewed plans) has a `data-tooltip` that reads:

> "Toggle complexity routing (low→coder, high→lead)"

This describes what routing does when the toggle is **ON**, but gives the user no idea what happens when it is turned **OFF**. A user reading the tooltip cannot predict the off-state behavior, which is non-obvious: when disabled, `resolveCodedAutoTarget()` short-circuits and returns `'LEAD CODED'` unconditionally — meaning every card dropped onto `CODED_AUTO` lands in the Lead column regardless of its complexity score. The current tooltip does not communicate this fallback, so users disabling routing may expect cards to stay put or route to a default coder column, not all funnel to Lead.

### Root Cause
The tooltip string was written to describe the feature's purpose (on-state routing) but not its disabled-state semantics. The off-state logic lives in `resolveCodedAutoTarget()` at line 5619 (`if (!dynamicComplexityRoutingEnabled) return 'LEAD CODED';`) and is not surfaced to the user anywhere in the UI.

### Desired Outcome
Rewrite the `data-tooltip` so it concisely describes both states: what routing does when ON, and the explicit fallback (all cards → Lead Coded) when OFF.

## Metadata
- **Tags:** ui, kanban, tooltips, complexity-routing, low-risk
- **Complexity:** 2

## Complexity Audit
**Routine.** A single tooltip string change in one file. No logic, state, or structural changes. The tooltip is rendered via the existing `data-tooltip` attribute mechanism and supports multi-line content using `&#10;` entities (already used elsewhere in the same view, e.g. the import-clipboard button tooltip at line 4562).

## Edge-Case & Dependency Audit
- **Tooltip rendering mechanism:** The `data-tooltip` attribute is consumed by the kanban's CSS tooltip styling. Multi-line tooltips are already in use in this file (see `btn-import-clipboard` at line 4562 using `&#10;`), so line breaks are safe.
- **String escaping:** The tooltip is emitted inside a template literal at line 4549. It does not currently pass through `escapeAttr()` (the surrounding literals do for dynamic values). The new string must avoid double-quotes and backticks; use `&#10;` for line breaks and avoid any `"` characters so the attribute remains valid.
- **State-dependent tooltip?** The tooltip is static (set once at render). It is not regenerated on toggle. This is acceptable — the goal is to describe both states in one persistent hint, not to swap text per state. No JS change is needed.
- **Other references to the old tooltip text:** None — the string literal at line 4549 is the only source.

## Proposed Changes

### File: `src/webview/kanban.html`

**1. Rewrite the `data-tooltip` on the complexity routing toggle (line 4549).**

Current:
```js
const complexityRoutingToggle = isPlanReviewed
    ? `<div id="complexity-routing-toggle" class="complexity-routing-btn ${dynamicComplexityRoutingEnabled ? 'is-active' : 'is-off'}" data-tooltip="Toggle complexity routing (low→coder, high→lead)">
           <img src="${ICON_DYNAMIC_ROUTING}" alt="Dynamic Routing">
       </div>`
    : '';
```

Replace the `data-tooltip` value with a two-state description:
```js
const complexityRoutingToggle = isPlanReviewed
    ? `<div id="complexity-routing-toggle" class="complexity-routing-btn ${dynamicComplexityRoutingEnabled ? 'is-active' : 'is-off'}" data-tooltip="Complexity routing&#10;&#10;ON: auto-routes by score (low→coder, high→lead)&#10;OFF: all cards drop to Lead Coded">
           <img src="${ICON_DYNAMIC_ROUTING}" alt="Dynamic Routing">
       </div>`
    : '';
```

This keeps the string free of double-quotes (using `→` and `&#10;` entities) so it remains valid inside the double-quoted attribute and renders as a multi-line tooltip consistent with the import-clipboard button's style.

## Verification Plan
- [ ] Open the Kanban board with at least one reviewed plan so the `CODED_AUTO` column renders the complexity routing toggle.
- [ ] Hover the toggle and confirm the tooltip displays as multiple lines: a title line, then `ON:` and `OFF:` state descriptions.
- [ ] Confirm the tooltip text contains no raw `&#10;` literals (they should render as line breaks) and no broken/truncated characters.
- [ ] Toggle routing on and off and confirm the tooltip text remains readable and accurate to the observed drop behavior (cards route by score when ON; all go to Lead Coded when OFF).
- [ ] Grep `kanban.html` for the old tooltip string `Toggle complexity routing (low→coder, high→lead)` and confirm zero matches.
