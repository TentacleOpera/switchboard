# Clarify the Complexity Routing Toggle Tooltip in kanban.html

## Goal

Clarify the `data-tooltip` on the complexity routing toggle button (`#complexity-routing-toggle`) so it describes both the ON and OFF states, instead of only the ON-state routing behavior.

### Problem
The complexity routing toggle button in `kanban.html` (the `#complexity-routing-toggle` element, rendered on the **`PLAN REVIEWED`** column header — not `CODED_AUTO` as previously stated) has a `data-tooltip` that reads:

> "Toggle complexity routing (low→coder, high→lead)"

This describes what routing does when the toggle is **ON**, but gives the user no idea what happens when it is turned **OFF**. A user reading the tooltip cannot predict the off-state behavior, which is non-obvious: when disabled, `resolveCodedAutoTarget()` short-circuits and returns `'LEAD CODED'` unconditionally — meaning every card dropped onto `CODED_AUTO` lands in the Lead column regardless of its complexity score. The current tooltip does not communicate this fallback, so users disabling routing may expect cards to stay put or route to a default coder column, not all funnel to Lead.

> **Correction note (improve-plan pass):** The original plan incorrectly stated the toggle is "shown on the `CODED_AUTO` column header." It is actually rendered on the **`PLAN REVIEWED`** column header (gated by `isPlanReviewed = def.id === 'PLAN REVIEWED'` at line 4503; the toggle template literal is at line 4520–4524). `CODED_AUTO` is a synthetic collapse-mode column (line 4486) that only exists when `collapseCodersEnabled` is true. The toggle *controls* routing behavior for drops onto `CODED_AUTO`, but it is *displayed* on `PLAN REVIEWED`. All line numbers in the original plan were stale (off by ~28 lines); they have been corrected throughout.

### Root Cause
The tooltip string was written to describe the feature's purpose (on-state routing) but not its disabled-state semantics. The off-state logic lives in `resolveCodedAutoTarget()` at line 5591 (`if (!dynamicComplexityRoutingEnabled) return 'LEAD CODED';`) and is not surfaced to the user anywhere in the UI.

### Desired Outcome
Rewrite the `data-tooltip` so it concisely describes both states: what routing does when ON, and the explicit fallback (all cards → Lead Coded) when OFF.

## Metadata
- **Tags:** ui, ux
- **Complexity:** 2

## User Review Required
No — this is a single tooltip string change with no logic, state, or structural impact. The change is self-explanatory and low-risk. Proceed directly to implementation.

## Complexity Audit

### Routine
- Single tooltip string replacement in one file (`src/webview/kanban.html`).
- No logic, state, or structural changes — purely a `data-tooltip` attribute value swap.
- The tooltip is rendered via the existing `data-tooltip` → `showTooltip()` → `textContent` + `white-space: pre-line` CSS pipeline (lines 3670–3703, 1901–1918). Multi-line tooltips using `&#10;` entities are already proven in this file (see `btn-import-clipboard` at line 4534).
- The `→` Unicode arrow is already used in the current tooltip string and renders correctly.
- The tooltip is static (set once at render, never regenerated on toggle). `updateComplexityRoutingToggleUi()` (line 4192) only updates CSS classes (`is-active`/`is-off`), not the tooltip text. This is the intended design — the tooltip describes both states in one persistent hint.

### Complex / Risky
- None

## Edge-Case & Dependency Audit
- **Tooltip rendering mechanism:** The `data-tooltip` attribute is read by `showTooltip()` at line 3672 via `el.getAttribute('data-tooltip')`. The browser automatically decodes HTML entities in attribute values, so `&#10;` becomes `\n` (newline). The value is then assigned via `tooltipOverlay.textContent = text` (line 3676). The `#tooltip-overlay` element has `white-space: pre-line` (line 1911), which renders `\n` characters as line breaks. Multi-line tooltips are already in use in this file (see `btn-import-clipboard` at line 4534 using `&#10;`), so line breaks are safe and proven.
- **String escaping:** The tooltip is emitted inside a template literal at line 4521. It does not pass through `escapeAttr()` (the surrounding literals do for dynamic values like `def.id`). The new string must avoid double-quotes and backticks; use `&#10;` for line breaks and avoid any `"` characters so the attribute remains valid inside the double-quoted `data-tooltip="..."` attribute.
- **State-dependent tooltip?** The tooltip is static (set once at render). It is not regenerated on toggle — `updateComplexityRoutingToggleUi()` (line 4192) only toggles CSS classes. This is acceptable — the goal is to describe both states in one persistent hint, not to swap text per state. No JS change is needed.
- **Other references to the old tooltip text:** None — the string literal at line 4521 is the only source. Grep for `Toggle complexity routing` returns exactly one match.
- **ON-state simplification:** The proposed tooltip says "ON: auto-routes by score (low→coder, high→lead)." The actual `resolveCodedAutoTarget()` logic (lines 5590–5606) also handles `INTERN CODED` routing and falls back to `CODER CODED` for unknown/NaN scores (line 5593). The tooltip's "low→coder, high→lead" is an intentional simplification matching the original tooltip's wording. This is acceptable for a concise UI hint — documenting every routing edge case would make the tooltip unreadable.

## Dependencies
- None — this is a self-contained single-string change with no prerequisites.

## Adversarial Synthesis
Key risks: (1) the original plan had stale line numbers (off by ~28) and a wrong column reference (`CODED_AUTO` instead of `PLAN REVIEWED`) that would mislead an implementer; (2) the tooltip is static and won't dynamically reflect the current toggle state. Mitigations: (1) all line numbers and column references have been corrected in this improved plan; (2) the static tooltip intentionally describes both ON and OFF states in one persistent hint, which is the desired behavior per the plan's goal — no dynamic text swapping is needed.

## Proposed Changes

### File: `src/webview/kanban.html`

**1. Rewrite the `data-tooltip` on the complexity routing toggle (line 4521).**

Current (line 4520–4524):
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
    ? `<div id="complexity-routing-toggle" class="complexity-routing-btn ${dynamicComplexityRoutingEnabled ? 'is-active' : 'is-off'}" data-tooltip="Complexity routing&#10;&#10;ON: auto-routes by score (low→Coder, high→Lead)&#10;OFF: all cards drop to Lead Coder">
           <img src="${ICON_DYNAMIC_ROUTING}" alt="Dynamic Routing">
       </div>`
    : '';
```

This keeps the string free of double-quotes (using `→` and `&#10;` entities) so it remains valid inside the double-quoted attribute and renders as a multi-line tooltip consistent with the import-clipboard button's style.

> **Reviewer correction (2026-06-25):** The original proposed tooltip said "Lead Coded," but the column is labeled "Lead Coder" (line 3741: `{ id: 'LEAD CODED', label: 'Lead Coder', ... }`). The wrong label would have defeated the plan's goal — users couldn't match the tooltip's destination to a visible column. Fixed to "Lead Coder." Also normalized ON-state casing to title-case ("low→Coder, high→Lead") for internal consistency with the OFF-state and the board labels.

**Context:** The toggle is rendered only on the `PLAN REVIEWED` column (gated by `isPlanReviewed` at line 4503). It controls routing behavior for cards dropped onto the synthetic `CODED_AUTO` column. The `resolveCodedAutoTarget()` function at line 5590 contains the off-state fallback (`return 'LEAD CODED'` at line 5591).

**Edge Cases:** The `&#10;` entities are decoded to `\n` by `getAttribute()` and rendered as line breaks by the `white-space: pre-line` CSS on `#tooltip-overlay` (line 1911). No double-quotes or backticks appear inside the attribute value. The `→` character is already proven to render correctly in the existing tooltip.

## Verification Plan
- [ ] Open the Kanban board with at least one reviewed plan so the `PLAN REVIEWED` column renders the complexity routing toggle.
- [ ] Hover the toggle and confirm the tooltip displays as multiple lines: a title line ("Complexity routing"), then `ON:` and `OFF:` state descriptions.
- [ ] Confirm the tooltip text contains no raw `&#10;` literals (they should render as line breaks) and no broken/truncated characters.
- [ ] Toggle routing on and off and confirm the tooltip text remains readable and accurate to the observed drop behavior (cards route by score when ON; all go to Lead Coded when OFF).
- [ ] Grep `kanban.html` for the old tooltip string `Toggle complexity routing (low→coder, high→lead)` and confirm zero matches.

### Automated Tests
No automated tests required — this is a static tooltip string change with no logic impact. Verification is manual (hover inspection). Per session directives, compilation and test suite execution are skipped.

---

## Review Results (2026-06-25)

### Findings
| Severity | Finding | Location |
|---|---|---|
| MAJOR | Tooltip said "Lead Coded" but the column is labeled "Lead Coder" — destination name mismatch defeats the plan's goal of making off-state behavior predictable | `src/webview/kanban.html:4521` (tooltip) vs `src/webview/kanban.html:3741` (column label) |
| NIT | Inconsistent casing: ON-state used lowercase "coder"/"lead" while OFF-state used title-case "Lead Coded" | `src/webview/kanban.html:4521` |
| NIT (deferred) | ON-state omits INTERN CODED routing and NaN→CODER CODED fallback — intentional simplification per plan | `src/webview/kanban.html:5590-5606` |

### Fixes Applied
1. **MAJOR:** Changed "Lead Coded" → "Lead Coder" in the tooltip OFF-state description (`kanban.html:4521`) to match the actual column label (`Lead Coder`, line 3741).
2. **NIT:** Normalized ON-state casing to "low→Coder, high→Lead" for internal consistency with the OFF-state and board labels.

### Files Changed
- `src/webview/kanban.html` — line 4521 (tooltip string correction)

### Validation
- Grep `Lead Coded` → 0 matches (eliminated).
- Grep `Toggle complexity routing` (old tooltip) → 0 matches (eliminated).
- Grep `complexity-routing-toggle` → 3 matches intact (render, UI update, click handler) — no structural breakage.
- Tooltip now reads: `Complexity routing` / `ON: auto-routes by score (low→Coder, high→Lead)` / `OFF: all cards drop to Lead Coder`.
- No double-quotes or backticks inside the attribute value; `&#10;` entities and `→` arrow preserved.
- Compilation and test suite skipped per session directives.

### Remaining Risks
- **None material.** The ON-state simplification ("low→Coder, high→Lead") intentionally omits the INTERN CODED routing path and NaN-score fallback to CODER CODED. This is acceptable for a concise UI hint and was explicitly sanctioned by the plan. Documenting every routing edge case would make the tooltip unreadable.
- Manual hover verification (per the Verification Plan checklist above) is still recommended before release to confirm multi-line rendering in the actual webview.

---

**Recommendation:** Complexity 2 → Send to Intern
