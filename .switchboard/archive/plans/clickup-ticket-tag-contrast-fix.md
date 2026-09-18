# Fix Unreadable ClickUp Ticket Tags in planning.html Tickets Tab

## Goal

Make ClickUp ticket tag labels readable in the **Tickets** tab of `planning.html` by replacing ClickUp's supplied foreground color with an automatically computed high-contrast text color derived from each tag's background, while preserving the original tag background colors for recognizability.

## Metadata
- **Tags:** frontend, ui, bugfix
- **Complexity:** 3

## User Review Required

- **Threshold choice:** YIQ luminance cutoff of `128` selects black vs. light text. This is a standard heuristic, not perceptual (no gamma correction). Acceptable for small uppercase pills — confirm you don't want WCAG relative-luminance instead.
- **Guard change (behavior change):** The original `renderTicketTags()` guard requires *both* `tag.tagFg` and `tag.tagBg` before styling. This plan changes the guard to require only `tag.tagBg`, because the foreground is now derived. This means tags that ClickUp returns with a `tag_bg` but an empty `tag_fg` will now be styled (previously they fell through to the unreadable grey default). Confirm this is desired (it is the whole point of the fix, but it is a behavior change worth flagging).
- **Out-of-scope sibling (investigated — NOT a bug):** `TaskViewerProvider._mapClickUpTaskToSidebar` at `TaskViewerProvider.ts:5161-5165` (the earlier `5198-5199` reference was stale — that location is `PlanningPanelCacheService` construction) maps ClickUp `tagFg`/`tagBg` into its task objects, identical in shape to `ClickUpSyncService.ts:775-776`. However, this is data-mapping only: that provider renders into `implementation.html` (`TaskViewerProvider.ts:17263`, tasks posted at 8279/8489-8490), and `implementation.html` has **no tag-pill rendering at all** (no `tagFg`/`tagBg`/`--tag-fg`/`tag-pill` references). The colors are carried but never drawn as styled pills, so there is **no live contrast bug** on this path. No follow-up plan needed. The only ClickUp-tag rendering surface is `planning.js`, which this plan fixes.

## Problem Statement

In the **Tickets** tab of `planning.html`, ClickUp ticket tags are rendered with pastel background colors paired with grey text (`var(--text-secondary)`). On Switchboard's dark theme, this combination produces extremely low contrast, making the tag labels effectively unreadable.

### Root Cause

ClickUp provides its own `tagFg` (foreground) and `tagBg` (background) color values per tag. The current implementation in `renderTicketTags()` applies both colors directly as CSS custom properties without any contrast adjustment. Many ClickUp workspaces use light/pastel tag backgrounds with mid-grey text, which disappears against the dark UI.

### Evidence

- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js:222-246` — `renderTicketTags()` blindly applies `tag.tagFg` and `tag.tagBg`.
- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.html:2940-2944` — `.ticket-tag-pill.clickup` uses `var(--tag-fg)` and `var(--tag-bg)` with fallback to `--text-secondary` and `--panel-bg2`.
- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/services/ClickUpSyncService.ts:775-776` — `tagFg`/`tagBg` originate from ClickUp's `tag_fg` / `tag_bg`, `.trim()`'d (so they can be **empty strings**, not just hex).

## Proposed Solution

Override ClickUp's `tagFg` with an automatically computed high-contrast text color derived from `tagBg`. Preserve the original ClickUp background colors so tag color coding remains recognizable. Style any tag that has a usable `tagBg`, regardless of whether `tagFg` is present.

### Implementation Details

1. **Add a `getContrastColor(bgColor)` helper** in `planning.js` near `renderTicketTags()`.
   - Parse hex (`#RGB`, `#RRGGBB`) and `rgb()` / `rgba()` formats into `R, G, B`.
   - **If parsing fails or yields `NaN`, return `null`** (caller must treat falsy as "skip `--tag-fg`, let CSS default apply"). Do **not** return a color when the input could not be parsed — a wrong-confident color is worse than the existing default.
   - Compute YIQ luminance: `Y = (R*299 + G*587 + B*114) / 1000`.
   - Return `#111111` for light backgrounds (`Y >= 128`) and `#e0e0e0` for dark backgrounds (`Y < 128`). `128` is a standard YIQ heuristic, not a perceptual/gamma-corrected value — adequate for small pills.

2. **Update `renderTicketTags()`** for `provider === 'clickup'`:
   - Change the guard from `tag.tagFg && tag.tagBg` to **`tag.tagBg`** only (foreground is now derived, so a missing `tagFg` must no longer block styling — this was the case that left the bug visible).
   - Continue setting `--tag-bg` from `tag.tagBg`.
   - Compute `const fg = getContrastColor(tag.tagBg);` and set `--tag-fg` **only if `fg` is truthy** (NaN/parse-fail → leave unset → CSS falls back to `--text-secondary`, unchanged old behavior for unparseable values).

### No CSS Changes Required

The `.ticket-tag-pill.clickup` rule already consumes `--tag-fg` and `--tag-bg` via CSS variables. Only the JS that sets those variables needs to change. (Note: `border-color: var(--tag-bg)` keeps a pastel-on-pastel border — this is intentional fill styling, not a contrast defect.)

## Complexity Audit

### Routine
- Add a small, pure `getContrastColor()` helper (string parse + arithmetic).
- Adjust one guard and one property assignment in `renderTicketTags()`.
- Single file (`planning.js`), reuses existing CSS-variable plumbing. No new patterns, no state, no message-passing.

### Complex / Risky
- None.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. `renderTicketTags()` is synchronous DOM rendering off already-resolved tag data; no async ordering involved.
- **Security:** None new. Tag values are still passed through `pill.textContent` (not `innerHTML`), so no XSS surface is introduced. Color strings are written to `style.setProperty` for known CSS custom properties only.
- **Side Effects:** Only the Tickets-tab detail tag pills change appearance. Linear pills (`.ticket-tag-pill.linear`) use `--accent-teal-dim`/`--accent-teal` and are untouched. Tags with unparseable `tagBg` render exactly as before.
- **Dependencies & Conflicts:** Depends on the existing CSS rule at `planning.html:2940-2944` continuing to read `--tag-fg`/`--tag-bg`. No conflict with `TaskViewerProvider.ts` (separate webview, separate render path; explicitly out of scope).

| Scenario | Handling |
|---|---|
| `tagBg` is missing or empty string | Guard (`tag.tagBg`) skips styling → existing CSS default (`var(--panel-bg2)` / `var(--text-secondary)`), unchanged behavior. |
| `tagBg` present, `tagFg` empty | **Now styled** with computed contrast fg (previously skipped and left unreadable — this is the core fix). |
| `tagBg` malformed / unparseable | `getContrastColor` returns `null`; `--tag-fg` left unset → CSS default fg. Background var may still be set to the raw string but text remains readable via default. |
| `tagBg` near threshold (Y ≈ 128) | Either `#111111` or `#e0e0e0` is highly readable on a mid-tone pill; threshold chosen for broad safety. |
| ClickUp changes color format (e.g. HSL) | Parse fails → `null` → CSS default fg. Extendable later. |
| Linear tags | Unchanged. Linear uses `--accent-teal-dim`, already good contrast. |

## Dependencies

- `sess_XXXXXXXXXXXXX — none` (no upstream session work required; self-contained single-file change).

## Adversarial Synthesis

Key risks: (1) the original `tag.tagFg && tag.tagBg` guard would have left the bug intact for tags with an empty `tag_fg` — fixed by guarding on `tag.tagBg` alone; (2) unparseable color strings producing a confidently-wrong text color — fixed by returning `null` from `getContrastColor` on parse/NaN failure so the CSS default applies. Mitigations keep the change strictly additive: any tag that cannot be safely recolored falls back to today's exact behavior, so the change cannot regress currently-working pills.

## Proposed Changes

### `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js`

- **Context:** `renderTicketTags(tags, provider)` at lines 222-246 builds `.ticket-tag-pill` spans into `#tickets-tags-display`. For ClickUp it currently sets `--tag-fg`/`--tag-bg` from raw ClickUp colors behind a `tag.tagFg && tag.tagBg` guard.
- **Logic:** Derive foreground contrast from background instead of trusting ClickUp's foreground. Only require a usable background to style. Fail safe to the CSS default when the background cannot be parsed.
- **Implementation:**
  - Add `getContrastColor(bgColor)` immediately above `renderTicketTags()`: parse `#RGB` / `#RRGGBB` / `rgb()` / `rgba()` to integer `R,G,B`; if parse fails or any channel is `NaN`, `return null`; else compute `Y = (R*299 + G*587 + B*114)/1000` and return `Y >= 128 ? '#111111' : '#e0e0e0'`.
  - In the `provider === 'clickup'` branch, change the guard to `if (provider === 'clickup' && tag.tagBg)`.
  - Inside: `pill.style.setProperty('--tag-bg', tag.tagBg);` then `const fg = getContrastColor(tag.tagBg); if (fg) pill.style.setProperty('--tag-fg', fg);`
- **Edge Cases:** Empty/missing `tagBg` → not styled (CSS default). Empty `tagFg` with valid `tagBg` → now correctly styled. Unparseable `tagBg` → `--tag-fg` left unset, CSS default fg. Linear provider branch untouched.

### No other files change

CSS at `planning.html:2940-2944` already consumes the variables. `TaskViewerProvider.ts` is explicitly out of scope.

## Verification Plan

> Per session directive, the test suite is run separately by the user. This section specifies what those tests should cover.

### Automated Tests
- Unit-test `getContrastColor` (pure function):
  - Light hex (`#FFFFFF`, `#FFE0E0`, pastel) → `#111111`.
  - Dark hex (`#000000`, `#222222`, `#1a3b5c`) → `#e0e0e0`.
  - Shorthand hex (`#FFF`, `#000`) parsed correctly.
  - `rgb(255,255,255)` / `rgba(0,0,0,0.5)` parsed correctly.
  - Malformed / empty / `undefined` / `hsl(...)` → returns `null` (no NaN-derived color).
  - Threshold boundary (`Y` just above/below 128) returns the expected branch.

### Manual Validation
- Open the Tickets tab in Switchboard.
- Select a ClickUp ticket with pastel-colored tags → confirm tag text is readable (dark text on light tags, light text on dark tags).
- Select a ClickUp ticket whose tags have a `tag_bg` but empty `tag_fg` → confirm now readable (the regression class the guard change targets).
- Verify Linear tickets are unaffected.

## Files to Change

- `@/Users/patrickvuleta/Documents/GitHub/switchboard/src/webview/planning.js` — add `getContrastColor` helper, update guard and `--tag-fg` assignment in `renderTicketTags()`.

---

**Recommendation:** Complexity 3 (≤ 6) → **Send to Coder.**

---

## Reviewer Pass (2026-06-19)

**Outcome: Implementation complete and faithful to the plan. No code changes required.**

### Implementation verified
- `getContrastColor(bgColor)` added at `src/webview/planning.js:222-258` — front guard `if (!bgColor) return null`, hex-3 / hex-6 / `rgb*` parsing, explicit `return null` for unknown formats, trailing `isNaN(r)||isNaN(g)||isNaN(b) → null`, then `Y = (R*299+G*587+B*114)/1000` returning `#111111` (Y≥128) or `#e0e0e0` (Y<128). Matches plan §Implementation Details exactly.
- `renderTicketTags()` guard at `src/webview/planning.js:276` changed to `provider === 'clickup' && tag.tagBg` (was `tagFg && tagBg`). `--tag-bg` set from `tag.tagBg`; `--tag-fg` set **only if** `getContrastColor` returns truthy (`planning.js:277-281`). Linear branch untouched.
- CSS at `src/webview/planning.html:2958-2962` already consumes `var(--tag-fg, var(--text-secondary))` / `var(--tag-bg, ...)` — no CSS change, as planned.

### Findings by severity
- **CRITICAL:** none.
- **MAJOR:** none.
- **NIT — `--tag-bg` set before parse-failure check** (`planning.js:277`): on unparseable `tagBg`, the raw value is still written to `--tag-bg` while `--tag-fg` is left unset. Documented in the plan's scenario table; harmless in practice (CSS treats invalid custom-property substitution as invalid-at-computed-value → falls back near default, text stays readable via `--text-secondary`). Not fixed — accepted to avoid churn.
- **NIT — `rgb()` percentage syntax** (`planning.js:240`): `/\d+/g` would treat `rgb(100%,50%,0%)` as `100,50,0` (0-255). Theoretical only — ClickUp emits hex (`ClickUpSyncService.ts:775-776`). Not fixed.
- **NIT (pre-existing, out of scope) — `pill.textContent = tag.name || tag`** (`planning.js:284`): renders `[object Object]` for a nameless object tag; shared with the Linear branch. Not touched.

### Files changed by this reviewer pass
- None. No CRITICAL/MAJOR findings required code fixes.

### Validation results
- Per session directives: compilation and automated tests skipped (run separately by the user).
- **Build currency confirmed (read-only):** the webpack bundle `dist/webview/planning.js` contains the live, minified fix — guard `"clickup"===t&&e.tagBg`, helper `…isNaN…?null:(299*n+587*o+114*a)/1e3>=128?"#111111":"#e0e0e0"`, and `--tag-fg` set only when truthy. The shipped webview reflects the source change.

### Remaining risks (carry-over from "User Review Required" — product decisions, not code defects)
- **Threshold:** YIQ-128 heuristic vs WCAG relative-luminance. Acceptable for small uppercase pills; confirm if WCAG is preferred.
- **Guard behavior change:** tags with `tag_bg` but empty `tag_fg` are now styled (the core fix, but a behavior change).
- **Out-of-scope twin bug — investigated, NOT a defect:** `TaskViewerProvider._mapClickUpTaskToSidebar` (`TaskViewerProvider.ts:5161-5165`; the plan's original `5198-5199` reference was stale) maps `tagFg`/`tagBg` but its only render target, `implementation.html`, has no tag-pill rendering. Colors are carried, never drawn — no live contrast bug. No follow-up plan needed. `planning.js` is the sole ClickUp-tag rendering surface and is fixed by this plan.
