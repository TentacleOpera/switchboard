# Claudify Theme: Warm Obsidian — Corrected Plan (Decouple from Afterburner)

## Goal

Make the **claudify** theme a calm, self-contained palette that visually integrates with the Claude Code VS Code extension: terracotta `#D97757` accent, warm cream text, Poppins display headings — **with no cyberpunk effects** (no scanlines, no neon glow, no teal) and **without changing the panel background**. Afterburner (cyberpunk) must be left exactly as-is.

## Why the first attempt failed

The original plan (`claudify-warm-obsidian-theme-upgrade.md`) was implemented faithfully but had three structural defects. All three trace back to one decision: **claudify was built as an additive overlay that keeps the cyberpunk theme switched on (`cyber-theme-enabled`) and then tries to neutralize each cyber effect individually.**

1. **The background became a grey haze.** The plan deliberately changed the background in three places — `--panel-bg` `#000` → `#24211E`, `--kanban-bg` → `#1A1816`, plus an added `body.theme-claudify.cyber-theme-enabled` grid layer — and then stacked translucent glass tints (`rgba(36,33,30,0.6–0.7)`) + `backdrop-filter: blur()` on the panes (Parts 5 & 6). Pure black lifted to a flat desaturated grey, then covered with blurred translucent panels = a uniform milky film. The user never wanted the background touched.

2. **The Project panel got nothing.** [project.js](../../src/webview/project.js) has **no theme handler at all** — it never applies `theme-claudify`. The provider does post the theme to it ([PlanningPanelProvider.ts:319](../../src/services/PlanningPanelProvider.ts#L319)) but nothing listens. [project.html:1173](../../src/webview/project.html#L1173) hardcodes `<body class="cyber-theme-enabled">` and it never changes. So every `body.theme-claudify …` rule added to project.html is **dead CSS**, and the panel is permanently stuck in full cyberpunk (cyan + glow + scanlines) for *every* theme, not just claudify. The original plan's Note #8 ("No JS changes needed — theme logic already adds both classes") was simply false for this panel.

3. **Teal and glow still leak.** Because `cyber-theme-enabled` stays on, teal isn't removed — it's *recolored* (`--accent-teal: var(--accent-primary)` → terracotta) and glow isn't removed — it's *recolored* to a terracotta glow, except where a hand-written `box-shadow: none` suppression rule happens to land. With 93 / 112 / 51 cyber rules across the three main webviews vs hand-maintained suppression lists, coverage is incomplete by construction. Additionally `--accent-teal-bright: #5ce8e6` was never overridden, so genuine cyan still shows on link-active colours.

### The architectural fix (addresses the user's concern directly)

The user is right that the current design is dangerous: claudify perpetually *fights* afterburner's hardcoded `.cyber-theme-enabled …` rules via specificity, so the two themes are entangled and any afterburner rule not explicitly suppressed bleeds into claudify.

**Decouple them.** Claudify stops enabling `cyber-theme-enabled` entirely. It becomes a palette overlay on the plain base theme (the same base the default/no-cyber theme uses), and re-adds *only* the handful of visual pieces it actually wants (Poppins headings, h1 terracotta / h2–h6 cream). Result:

- Afterburner is untouched — claudify simply never turns its effects on, rather than turning them on and fighting them off.
- No glow, no scanlines, no teal *by default* — they live behind `cyber-theme-enabled`, which claudify no longer sets. Nothing to suppress.
- Background stays at the base near-black — claudify no longer overrides it.
- Claudify is self-describing: everything it does lives in `body.theme-claudify` blocks; nothing leaks either direction.

## Metadata
**Complexity:** 4
**Tags:** ui, ux, refactor, frontend, bugfix

## Scope Boundaries
- **Background:** Do **not** lift the base to a grey (the rejected `#24211E`). Keep it near-black. A near-black warm value (`#14110F`) is used only as the solid base under the grid (see Grid), so the surface stays dark, not hazy.
- **No translucent glass tints, no backdrop-blur** added by claudify — these caused the haze. Panes stay **solid and opaque**.
- **Effects:** No scanlines, no sweep, no neon glow — achieved by *not enabling* `cyber-theme-enabled`, not by suppression.
- **Grid: KEPT (required).** A subtle warm grid on a solid near-black surface — opaque, so no haze. Implemented on the content/preview surfaces directly, not via translucent panels.
- **Accent:** Terracotta `#D97757`. Also override `--accent-teal-bright` (was the un-fixed cyan).
- **Text/borders:** Keep warm cream text + warm borders — these were not the problem and aid integration.
- **Headings:** **h1 uses the pixel font (GeistPixel)** with terracotta colour; h2–h6 use Poppins in warm cream `#F0EBE6`.
- **Fonts:** No new bundles. GeistPixel + Poppins + Hanken Grotesk already present.
- **Afterburner & default themes:** Must be byte-for-byte unchanged in behaviour.

## The critical change: JavaScript (this is what was missing)

Three handlers must agree on one rule: **`cyber-theme-enabled` is added for afterburner ONLY. Claudify gets `theme-claudify` and nothing else.**

### `src/webview/planning.js` — `handleThemeChanged` (lines 2192–2208)
Change the condition so claudify no longer enables cyber:
```js
function handleThemeChanged(theme) {
    if (theme) { state.switchboardTheme = theme; }
    document.body.classList.remove('theme-claudify');
    // Cyber CRT effects (scanlines, grid, glow, sweep) belong to Afterburner ONLY.
    if (state.switchboardTheme === 'afterburner') {
        document.body.classList.add('cyber-theme-enabled');
    } else {
        document.body.classList.remove('cyber-theme-enabled');
    }
    // Claudify is a standalone palette overlay on the plain base theme.
    if (state.switchboardTheme === 'claudify') {
        document.body.classList.add('theme-claudify');
    }
}
```
Only change: drop `|| state.switchboardTheme === 'claudify'` from the cyber-enable condition.

### `src/webview/design.js` — inline handler (lines 3030–3044)
Same one-line change: the `cyber-theme-enabled` add condition becomes `=== 'afterburner'` only. Leave the `theme-claudify` add as-is.

### `src/webview/project.js` — ADD a handler (currently has none)
Add a `handleThemeChanged(theme)` function mirroring planning.js, and wire it into the message switch at [project.js:189](../../src/webview/project.js#L189). Track the active theme on whatever state object project.js uses (or a module-level `let switchboardTheme = 'afterburner'`).

```js
function handleThemeChanged(theme) {
    if (theme) { switchboardTheme = theme; }
    document.body.classList.remove('theme-claudify');
    if (switchboardTheme === 'afterburner') {
        document.body.classList.add('cyber-theme-enabled');
    } else {
        document.body.classList.remove('cyber-theme-enabled');
    }
    if (switchboardTheme === 'claudify') {
        document.body.classList.add('theme-claudify');
    }
}
```
Add to the `switch (msg.type)`:
```js
case 'switchboardThemeNameSetting':
case 'switchboardThemeChanged':
    handleThemeChanged(msg.theme);
    break;
```

**Side benefit:** this also fixes a pre-existing bug — the Project panel currently shows cyberpunk effects under the default (non-cyber) theme too, because its body is hardcoded `cyber-theme-enabled` and nothing ever removes it.

**Note on the hardcoded body class:** leaving `<body class="cyber-theme-enabled">` in [project.html:1173](../../src/webview/project.html#L1173) is acceptable because the provider sends `switchboardThemeChanged` on panel init ([PlanningPanelProvider.ts:319](../../src/services/PlanningPanelProvider.ts#L319)), so the handler corrects the class on load. To avoid a one-frame flash of cyber styling before the message arrives, optionally remove the hardcoded class (or set it from the injected initial theme).

## CSS changes

### `src/webview/planning.html`

**1. Replace the variable block (lines 93–107)** — drop all background variables, add the missing `--accent-teal-bright`. Do **not** override the display-font vars: leaving them at the base keeps GeistPixel (the pixel font) for app chrome and the h1 header.
```css
body.theme-claudify {
    --accent-primary: #D97757;
    --accent-teal-bright: #E2A188;   /* was #5ce8e6 cyan — warm terracotta-tint */
    --text-primary: #F0EBE6;
    --text-secondary: #A8A095;
    --border-color: #38332E;
    --border-bright: #5C544A;
    /* Backgrounds NOT set here — the grid block below provides a solid near-black surface. */
    /* Display-font vars NOT overridden — keep base GeistPixel (pixel font). */
}
```

**2. Add the grid (required).** Apply a faint warm grid on a **solid, opaque** near-black surface to the content containers and preview panes — opaque means no haze. No `backdrop-filter`. Append:
```css
/* Claudify: solid near-black surface + subtle warm grid (no translucency, no blur) */
body.theme-claudify #local-content,
body.theme-claudify #online-content,
body.theme-claudify #kanban-content,
body.theme-claudify #tickets-content,
body.theme-claudify #preview-pane,
body.theme-claudify #preview-pane-online,
body.theme-claudify #preview-pane-tickets,
body.theme-claudify #kanban-preview-pane {
    background-color: #14110F;
    background-image:
        linear-gradient(color-mix(in srgb, var(--accent-primary) 5%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 5%, transparent) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}
```
Use only the IDs that exist in this file. The grid lines are ~5% terracotta on `#14110F` (near-black) — clearly a grid, but dark and haze-free because the surface underneath is fully opaque. Tune the `5%` up/down to taste during verification.

**3. Delete the entire prior claudify addition block (lines ~2288–2430)** — every `/* Claudify: … */` rule: scanline suppression, all `box-shadow: none` suppression, the `body.theme-claudify.cyber-theme-enabled` grid override, the glass tints (Part 5), and the **translucent** preview-pane backgrounds with blur (Part 6). The Part 6 idea (grid on preview panes) is correct; the execution was wrong — it used a near-transparent light tint + blur, which is the haze. Step 2 above replaces it with a solid dark version.

**4. Re-add the heading styling** (previously inherited from the cyber-gated rules at lines 991–1009; claudify must now provide it). **h1 = GeistPixel pixel font + terracotta; h2–h6 = Poppins + warm cream.** Append:
```css
/* Claudify: h1 — pixel font, terracotta */
body.theme-claudify #markdown-preview h1,
body.theme-claudify #markdown-preview-online h1,
body.theme-claudify #markdown-preview-design h1,
body.theme-claudify #kanban-preview-pane h1,
body.theme-claudify #markdown-preview-tickets h1 {
    font-family: 'GeistPixel', var(--font-family);
    letter-spacing: -0.05em;
    font-stretch: 90%;
    color: #D97757;
}

/* Claudify: h2-h6 — Poppins, warm cream */
body.theme-claudify #markdown-preview h2, body.theme-claudify #markdown-preview h3, body.theme-claudify #markdown-preview h4, body.theme-claudify #markdown-preview h5, body.theme-claudify #markdown-preview h6,
body.theme-claudify #markdown-preview-online h2, body.theme-claudify #markdown-preview-online h3, body.theme-claudify #markdown-preview-online h4, body.theme-claudify #markdown-preview-online h5, body.theme-claudify #markdown-preview-online h6,
body.theme-claudify #markdown-preview-design h2, body.theme-claudify #markdown-preview-design h3, body.theme-claudify #markdown-preview-design h4, body.theme-claudify #markdown-preview-design h5, body.theme-claudify #markdown-preview-design h6,
body.theme-claudify #kanban-preview-pane h2, body.theme-claudify #kanban-preview-pane h3, body.theme-claudify #kanban-preview-pane h4, body.theme-claudify #kanban-preview-pane h5, body.theme-claudify #kanban-preview-pane h6,
body.theme-claudify #markdown-preview-tickets h2, body.theme-claudify #markdown-preview-tickets h3, body.theme-claudify #markdown-preview-tickets h4, body.theme-claudify #markdown-preview-tickets h5, body.theme-claudify #markdown-preview-tickets h6 {
    font-family: 'Poppins', var(--font-family);
    letter-spacing: normal;
    font-stretch: 100%;
    color: #F0EBE6;
}
```
Specificity check: `body.theme-claudify #id h1` = (0,2,1), beats the base `#id h1` (0,1,1). The cyber heading rules (lines 991–1009) no longer apply because claudify doesn't set `cyber-theme-enabled`, so there is no tie to resolve.

> The h1 border-left/border-bottom use `var(--accent-teal-dim)`, which resolves through `--accent-teal` → `--accent-primary` → terracotta. No change needed.

### `src/webview/design.html`
Identical treatment:
1. Replace variable block (lines 94–108) with the block above.
2. Add the grid (Step 2) using this file's content/preview IDs — include the extra preview panes this file has (`#preview-pane-design`, `#preview-pane-html`, `#preview-pane-images`, `#stitch-preview-pane`). Use only IDs that exist here.
3. Delete the prior claudify addition block (lines ~2324–2475).
4. Re-add the heading styling (h1 GeistPixel/terracotta; h2–h6 Poppins/cream), extending each selector list with this file's extra preview IDs: `#markdown-preview-briefs`, and any others present (`#stitch-preview-pane` if it renders markdown headings — verify before including).

### `src/webview/project.html`
1. Replace the variable block (lines 72–86) with the block above.
2. Add the grid (Step 2) using this file's content/preview IDs: the tab content containers plus `#kanban-preview-pane`, `#epics-preview-pane`, `#constitution-preview-pane`, `#tuning-preview-pane`. Use only IDs that exist here.
3. Delete the prior claudify addition block (lines ~743–880): scanline suppression, all `box-shadow: none` rules, the `body.theme-claudify.cyber-theme-enabled` grid override, the list-pane glass tints, the translucent preview-pane backgrounds, **and** the relocated h2–h6 cream override.
4. Re-add the heading styling using this file's `*-preview-content` IDs (`#kanban-preview-content`, `#epics-preview-content`, `#constitution-preview-content`, `#tuning-preview-content`) — h1 GeistPixel/terracotta; h2–h6 Poppins/cream.

> **Note on uppercase headings:** project.html applies `text-transform: uppercase` to preview headings in its base CSS. With GeistPixel on h1 this reads as a pixel-art header — confirm it looks right during verification; if not, add `text-transform: none` to the claudify h1 rule.

### `src/webview/kanban.html`, `implementation.html`, `setup.html`
These have no cyber rules — only variable overrides matter. Edit each `body.theme-claudify` block to **remove the background variables** added previously (`--bg-color`, `--bg-dim`, `--panel-bg`, `--panel-bg2`, `--kanban-bg`) while **keeping** the accent/text/border fixes:
```css
body.theme-claudify {
    --accent-primary: #D97757;
    --accent-teal: #D97757;       /* keep where present */
    --accent-cyan: #D97757;       /* implementation.html only */
    --accent-teal-bright: #E2A188;
    --text-primary: #F0EBE6;
    --text-secondary: #A8A095;
    --border-color: #38332E;
    --border-bright: #5C544A;
}
```

### `src/webview/shared-tabs.css`
The prior plan added `body.theme-claudify .shared-tab-btn.active { box-shadow: none }` and a translucent `.shared-tab-bar` background. With cyber disabled for claudify, the cyber tab glow no longer applies, so the `box-shadow: none` is inert — remove it. Remove the translucent `.shared-tab-bar` override too (it can re-introduce a faint film); let the tab bar inherit its solid base background.

## Tuning knobs (during verification)
- **Grid intensity:** the `5%` terracotta in the grid gradients. Drop toward `3%` if too busy, raise toward `8%` if invisible.
- **Grid surface darkness:** `#14110F`. Pure black `#0a0a0a` is also fine if the warm tint reads as "not black enough."
- **h1 uppercase in project.html:** add `text-transform: none` to the claudify h1 rule if the pixel font + uppercase looks wrong.

## File Change Summary

| File | Change |
|---|---|
| `src/webview/planning.js` | `handleThemeChanged`: enable cyber for afterburner only (drop claudify from the condition) |
| `src/webview/design.js` | Inline theme handler: same one-line condition change |
| `src/webview/project.js` | ADD a theme handler + wire `switchboardThemeChanged` / `switchboardThemeNameSetting` cases (was entirely missing) |
| `src/webview/planning.html` | Slim variable block (no bg, add teal-bright, keep pixel display font); add solid-dark warm grid; delete prior suppression/glass/translucent block; re-add headings (h1 GeistPixel/terracotta, h2-h6 Poppins/cream) |
| `src/webview/design.html` | Same as planning.html, with this file's extra preview IDs in grid + heading selectors |
| `src/webview/project.html` | Same as planning.html, using `*-preview-content` heading IDs and this file's pane IDs for the grid |
| `src/webview/kanban.html` | Variable block: remove background vars, keep accent/text/border + add teal-bright |
| `src/webview/implementation.html` | Same (keep `--accent-cyan` override) |
| `src/webview/setup.html` | Same |
| `src/webview/shared-tabs.css` | Remove the two inert/haze-causing claudify overrides |

## Verification Plan

No automated tests (CSS/JS visual change). Manual, across **all** panels — Planning (local/online/kanban/tickets), Design, and **Project (kanban/epics/constitution/tuning)** — and crucially toggling between all three themes:

**Claudify:**
- Background is near-black (NOT grey, NOT milky/hazy); panes are solid and opaque.
- The warm grid is visible across content/preview areas and reads as a crisp grid, not a film.
- No scanlines, no sweep, no glow anywhere (headings, code, blocks, items, buttons, tabs).
- No cyan/teal anywhere — accents, active tabs, links, item borders are terracotta `#D97757`.
- Preview **h1 is the pixel font (GeistPixel) in terracotta**; h2–h6 are Poppins in warm cream.
- The **Project panel** actually changes (it did not before) and matches the others.

**Afterburner:** full cyberpunk restored and pixel-identical to before this change (scanlines, grid, neon glow, cyan).

**Default theme:** no claudify leakage; and confirm the Project panel is now NON-cyber under default (previously it was stuck cyber).

## Recommendation

Complexity 4 → **Send to Coder.** The JS handler in `project.js` is the highest-value fix and must not be skipped; the CSS is mostly deletion plus one re-added heading block per file.
