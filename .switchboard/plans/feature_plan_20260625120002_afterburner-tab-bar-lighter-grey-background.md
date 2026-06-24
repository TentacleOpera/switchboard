# Fix: Afterburner Theme Tab-Navigation Background Is a Lighter Grey Than Other Themes

## Goal

In the **Afterburner** theme, the tab-navigation bar (the `.shared-tab-bar` across every webview) renders a **lighter grey** than in the other themes (**Claudify**, **Afterburner Professional**), whose tab bars are near-pure black. The user prefers the darker look and wants Afterburner's tab bar to match.

### Problem analysis & root cause

All webviews define the same base background tokens in `:root`:

- `--panel-bg: #000000;` (pure black) — e.g. `src/webview/kanban.html:18`.
- `--panel-bg2: #0a0a0a;` — `src/webview/kanban.html:19`.

The base `.shared-tab-bar` uses the fully-opaque token, so Claudify and Afterburner-Pro get pure black. **Afterburner alone** overrides the tab bar with a *semi-transparent* colour plus a backdrop blur:

```css
/* src/webview/kanban.html:2446-2450 */
.cyber-theme-enabled .shared-tab-bar {
  background: rgba(10, 10, 10, 0.65);   /* 65% opaque near-black */
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
```

**Root cause:** `rgba(10, 10, 10, 0.65)` is only 65% opaque. The remaining 35% lets whatever sits behind the bar bleed through, so the bar composites to a **lighter grey** instead of the intended near-black. The other themes use the opaque `var(--panel-bg)` (`#000000`), which is why they look darker. This is a "glassmorphism" effect (the blur) that came at the cost of darkness. There is exactly one such rule per webview file — there are no other Afterburner background overrides on the tab bar.

This exact override is duplicated verbatim across **five** webview files:

| File | Line |
| :-- | :-- |
| `src/webview/kanban.html` | 2446-2450 |
| `src/webview/planning.html` | ~3340-3343 |
| `src/webview/design.html` | ~3588-3591 |
| `src/webview/project.html` | ~659-662 |
| `src/webview/setup.html` | ~481-484 |

**Fix:** make Afterburner's `.shared-tab-bar` fully opaque (pure black), matching the other themes, while keeping the blur (now a no-op visually over an opaque fill but harmless). Apply identically to all five files.

## Metadata

- **Tags:** `theming`, `afterburner`, `css`, `webview`, `visual-polish`, `bugfix`
- **Complexity:** 2 / 10
- **Affected components:** the `.cyber-theme-enabled .shared-tab-bar` rule in five webview HTML files.
- **Migration required:** No (CSS-only; no persisted state).

## Complexity Audit

**Classification: Routine.**

- Pure CSS value change to one rule, replicated across five files. No JS, no state, no schema.
- The only diligence required is consistency: the rule is copy-pasted per file (as the in-file comment at `src/webview/kanban.html:2452-2453` notes — "kanban.html has its own inline copy of these tab styles"), so all five must be updated or the themes will diverge between panels.

## Edge-Case & Dependency Audit

- **All five files must change together.** Missing one leaves that panel's Afterburner tab bar lighter than the rest, producing an inconsistent look across kanban/planning/design/project/setup.
- **Keep vs drop the blur.** `backdrop-filter: blur(10px)` over a fully opaque background has no visible effect (nothing shows through to blur). Keeping it is harmless and minimizes the diff; dropping it is also fine. Recommendation: **keep** the blur lines to minimize churn and preserve intent if the design later reintroduces translucency — only the colour needs to change.
- **Do not touch the active-tab glow.** `.cyber-theme-enabled .shared-tab-btn.active` (`src/webview/kanban.html:2443-2445`) supplies the cyan glow accent — leave it untouched; it is unrelated to the bar darkness.
- **Token vs literal.** Use `var(--panel-bg)` rather than a hard-coded `#000000` so the bar tracks the theme's base background token (already `#000000` in `:root`) and stays consistent if that token is ever retuned. All five files define `--panel-bg` in `:root`, so the variable resolves everywhere.
- **No regression to other themes.** The change is scoped under the `.cyber-theme-enabled` selector, so Claudify (`body.theme-claudify`) and Afterburner-Pro (`body.theme-afterburner-pro`) — which already use the opaque base rule — are unaffected.

## Proposed Changes

In **each** of the five files, change the Afterburner tab-bar rule from the translucent fill to the opaque token. Example for `src/webview/kanban.html:2446-2450`:

```css
.cyber-theme-enabled .shared-tab-bar {
  background: var(--panel-bg);          /* was: rgba(10, 10, 10, 0.65) — opaque pure black to match other themes */
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
}
```

Apply the identical one-line change (`background: rgba(10, 10, 10, 0.65);` → `background: var(--panel-bg);`) to the matching rule in:

- `src/webview/planning.html` (~line 3340)
- `src/webview/design.html` (~line 3588)
- `src/webview/project.html` (~line 659)
- `src/webview/setup.html` (~line 481)

> During implementation, re-grep each file for `cyber-theme-enabled .shared-tab-bar` to confirm the exact line (line numbers drift) and that each contains the same `rgba(10, 10, 10, 0.65)` value before editing.

## Verification Plan

1. **Visual A/B across themes:** Open the kanban panel. Switch theme to **Claudify**, then **Afterburner Professional**, noting the near-black tab bar. Switch to **Afterburner** — the tab bar must now be visually identical in darkness (pure black), not lighter grey.
2. **All five panels:** Repeat the Afterburner check in the planning, design, project, and setup webviews. The tab bar must be uniformly dark in every panel.
3. **Active-tab accent intact:** Confirm the active tab still shows the cyan glow (`.shared-tab-btn.active`) in Afterburner — only the bar background changed.
4. **Other themes unchanged:** Confirm Claudify and Afterburner-Pro tab bars look exactly as before (no visible diff).
5. **Grep audit:** `grep -rn "rgba(10, 10, 10, 0.65)" src/webview` returns **zero** matches after the change (proves all five copies were updated).
6. **Build:** `npm run compile` succeeds.
