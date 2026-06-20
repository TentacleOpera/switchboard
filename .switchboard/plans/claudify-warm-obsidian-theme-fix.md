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
**Complexity:** 5
**Tags:** ui, ux, refactor, frontend, bugfix

## User Review Required

Yes — visual theme changes require manual verification across all panels and all three themes (claudify, afterburner, default). No automated visual regression tests exist. The grid intensity (`5%` terracotta) and h1 uppercase behaviour in project.html are aesthetic judgement calls that the user must confirm.

## Scope Boundaries
- **Background:** Do **not** lift the base to a grey (the rejected `#24211E`). Keep it near-black. A near-black warm value (`#14110F`) is used only as the solid base under the grid (see Grid), so the surface stays dark, not hazy.
- **No translucent glass tints, no backdrop-blur** added by claudify — these caused the haze. Panes stay **solid and opaque**.
- **Effects:** No scanlines, no sweep, no neon glow — achieved by *not enabling* `cyber-theme-enabled`, not by suppression.
- **Grid: KEPT (required).** A subtle warm grid on a solid near-black surface — opaque, so no haze. Implemented on the content/preview surfaces directly, not via translucent panels. **Restricted to markdown-rendering surfaces only** — do NOT apply the grid to non-markdown surfaces (HTML preview, image gallery).
- **Accent:** Terracotta `#D97757`. Also override `--accent-teal-bright` (was the un-fixed cyan) in **all** variable blocks, including kanban/implementation/setup.
- **Text/borders:** Keep warm cream text + warm borders — these were not the problem and aid integration.
- **Headings:** **h1 uses the pixel font (GeistPixel)** with terracotta colour; h2–h6 use Poppins in warm cream `#F0EBE6`.
- **Fonts:** No new bundles. GeistPixel + Poppins + Hanken Grotesk already present.
- **Afterburner & default themes:** Must be byte-for-byte unchanged in behaviour.

## Complexity Audit

### Routine
- Deleting the prior claudify suppression/glass/translucent CSS blocks in planning.html, design.html, project.html (pure deletion, no logic).
- Replacing variable blocks in 6 HTML files (remove background vars, remove `--display-font` override, add `--accent-teal-bright`).
- Removing two inert overrides from shared-tabs.css.
- The one-line condition change in planning.js and design.js (drop `|| 'claudify'` from the cyber-enable condition).

### Complex / Risky
- **Adding a net-new theme handler to project.js** — this file currently has zero theme handling. The handler must mirror planning.js's pattern, be wired into the message switch, and track theme state. Getting the message type names wrong (`switchboardThemeChanged` vs `switchboardThemeNameSetting`) or the state variable wrong means the Project panel stays broken.
- **CSS selector ID accuracy** — the prior plan's selector lists referenced element IDs that don't exist in the target files (inherited from duplicated CSS). The corrected lists below use only verified element IDs, but the coder must not re-introduce the ghost IDs. A single wrong ID means the grid or heading style silently doesn't apply.
- **One-frame flash of cyberpunk on Project panel open** — the hardcoded `<body class="cyber-theme-enabled">` in project.html causes a visible cyber flash before the async theme message arrives. Removing the hardcoded class is recommended (see project.html step 5).

## Edge-Case & Dependency Audit

**Race Conditions:**
- The Project panel's theme handler depends on the provider sending `switchboardThemeChanged` on panel init ([PlanningPanelProvider.ts:319](../../src/services/PlanningPanelProvider.ts#L319)). If the message arrives before the `message` event listener is registered, the handler never fires and the panel stays in its hardcoded state. The current code posts `fetchKanbanPlans` on init ([project.js:184](../../src/webview/project.js#L184)) and registers the listener at [project.js:187](../../src/webview/project.js#L187)) — the listener is registered synchronously at script load, before any async messages can arrive, so this is safe. Verify the handler is added inside the same synchronous execution.

**Security:**
- No security implications. CSS/JS theme changes only. No user input handling, no external data.

**Side Effects:**
- Removing `cyber-theme-enabled` from claudify means the cyber heading rules (lines 991–1009 in planning.html/design.html) no longer apply to claudify. Claudify must provide its own heading styles (Step 4 in each CSS section). If the heading re-add is skipped, claudify headings fall back to base styling (no GeistPixel, no Poppins, no terracotta h1).
- Removing the hardcoded `<body class="cyber-theme-enabled">` from project.html affects the default theme too — under default, the Project panel was previously stuck cyber. This is a pre-existing bug fix, not a regression.
- The `--accent-teal-dim` cascade: the base defines `--accent-teal: var(--accent-primary)` and `--accent-teal-dim: color-mix(in srgb, var(--accent-teal) 40%, transparent)`. Claudify sets `--accent-primary: #D97757` but does NOT override `--accent-teal`, so `--accent-teal` stays `var(--accent-primary)` → terracotta, and `--accent-teal-dim` → terracotta dim. This works today but depends on the base keeping `--accent-teal` derived (not hardcoded). Add a verification checklist item.

**Dependencies & Conflicts:**
- The three JS handlers (planning.js, design.js, project.js) must all agree: cyber enabled for afterburner ONLY, claudify gets `theme-claudify` only. If any one file keeps the old `|| 'claudify'` condition, that panel will show cyber effects under claudify.
- shared-tabs.css is loaded by multiple webviews. Removing the two claudify overrides is safe because with cyber disabled for claudify, the cyber tab glow no longer applies (the `box-shadow: none` was inert) and the translucent tab-bar override caused the haze.
- No dependency on other plans or sessions.

## Dependencies
- None — this plan is self-contained.

## Adversarial Synthesis

Key risks: (1) CSS selector lists in the prior plan referenced element IDs that don't exist in the target files — corrected lists below use only verified IDs, but the coder must not re-introduce ghost IDs. (2) The net-new project.js theme handler must be wired correctly or the Project panel stays broken. (3) `--accent-teal-bright` must be added to all variable blocks or cyan leaks in secondary panels. Mitigations: verified ID lists written into the plan, handler mirrors the proven planning.js pattern, and a manual verification checklist covering all three themes across all panels.

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

**Note on the hardcoded body class:** the provider sends `switchboardThemeChanged` on panel init ([PlanningPanelProvider.ts:319](../../src/services/PlanningPanelProvider.ts#L319)), so the handler corrects the class on load. However, because the message is async, there is a one-frame flash of cyber styling before it arrives. **Recommended:** remove the hardcoded `cyber-theme-enabled` class from [project.html:1173](../../src/webview/project.html#L1173) (change `<body class="cyber-theme-enabled">` to `<body>`) to eliminate the flash. The handler will add the class back if the active theme is afterburner.

## CSS changes

> **CRITICAL — Verified element IDs only.** The prior plan's selector lists referenced IDs that don't exist as elements in the target files (e.g. `#local-content`, `#online-content`, `#kanban-content`, `#preview-pane-online`, `#kanban-preview-pane` in planning.html). These are dead CSS selectors from duplicated CSS blocks. The lists below have been verified against the actual HTML elements in each file. Do NOT re-introduce ghost IDs.

### `src/webview/planning.html`

**Verified element IDs in this file:**
- Content containers: `#docs-content`, `#notebook-content`, `#research-content`, `#tickets-content`
- Preview panes: `#preview-pane`, `#preview-pane-tickets`
- Markdown preview: `#markdown-preview`, `#markdown-preview-tickets`

**1. Replace the variable block (lines 93–107)** — drop all background variables, add the missing `--accent-teal-bright`. Do **not** override the display-font vars: leaving them at the base keeps GeistPixel (the pixel font) for appchrome and the h1 header.
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
body.theme-claudify #docs-content,
body.theme-claudify #notebook-content,
body.theme-claudify #research-content,
body.theme-claudify #tickets-content,
body.theme-claudify #preview-pane,
body.theme-claudify #preview-pane-tickets {
    background-color: #14110F;
    background-image:
        linear-gradient(color-mix(in srgb, var(--accent-primary) 5%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 5%, transparent) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}
```
The grid lines are ~5% terracotta on `#14110F` (near-black) — clearly a grid, but dark and haze-free because the surface underneath is fully opaque. Tune the `5%` up/down to taste during verification.

**3. Delete the entire prior claudify addition block (lines ~2288–2430)** — every `/* Claudify: … */` rule: scanline suppression, all `box-shadow: none` suppression, the `body.theme-claudify.cyber-theme-enabled` grid override, the glass tints (Part 5), and the **translucent** preview-pane backgrounds with blur (Part 6). The Part 6 idea (grid on preview panes) is correct; the execution was wrong — it used a near-transparent light tint + blur, which is the haze. Step 2 above replaces it with a solid dark version.

**4. Re-add the heading styling** (previously inherited from the cyber-gated rules at lines 991–1009; claudify must now provide it). **h1 = GeistPixel pixel font + terracotta; h2–h6 = Poppins + warm cream.** Append:
```css
/* Claudify: h1 — pixel font, terracotta */
body.theme-claudify #markdown-preview h1,
body.theme-claudify #markdown-preview-tickets h1 {
    font-family: 'GeistPixel', var(--font-family);
    letter-spacing: -0.05em;
    font-stretch: 90%;
    color: #D97757;
}

/* Claudify: h2-h6 — Poppins, warm cream */
body.theme-claudify #markdown-preview h2, body.theme-claudify #markdown-preview h3, body.theme-claudify #markdown-preview h4, body.theme-claudify #markdown-preview h5, body.theme-claudify #markdown-preview h6,
body.theme-claudify #markdown-preview-tickets h2, body.theme-claudify #markdown-preview-tickets h3, body.theme-claudify #markdown-preview-tickets h4, body.theme-claudify #markdown-preview-tickets h5, body.theme-claudify #markdown-preview-tickets h6 {
    font-family: 'Poppins', var(--font-family);
    letter-spacing: normal;
    font-stretch: 100%;
    color: #F0EBE6;
}
```
Specificity check: `body.theme-claudify #id h1` = (0,2,1), beats the base `#id h1` (0,1,1). The cyber heading rules (lines 991–1009) no longer apply because claudify doesn't set `cyber-theme-enabled`, so there is no tie to resolve.

> The h1 border-left/border-bottom use `var(--accent-teal-dim)`, which resolves through `--accent-teal` → `--accent-primary` → terracotta. No change needed. (Verified: base `--accent-teal: var(--accent-primary)` at line 59, `--accent-teal-dim` derived at line 60.)

### `src/webview/design.html`

**Verified element IDs in this file:**
- Content containers: `#briefs-content`, `#design-content`, `#html-preview-content`, `#images-content`, `#stitch-content`
- Preview panes: `#preview-pane-design`, `#preview-pane-html`, `#preview-pane-images`, `#stitch-preview-pane`
- Markdown preview: `#markdown-preview-briefs`, `#markdown-preview-design`
- **Note:** `#html-preview-content` and `#images-content` are non-markdown surfaces — EXCLUDE from grid.

Identical treatment:
1. Replace variable block (lines 94–108) with the block above.
2. Add the grid (Step 2) using **only these verified IDs** — markdown-rendering surfaces only:
```css
body.theme-claudify #briefs-content,
body.theme-claudify #design-content,
body.theme-claudify #stitch-content,
body.theme-claudify #preview-pane-design,
body.theme-claudify #stitch-preview-pane {
    background-color: #14110F;
    background-image:
        linear-gradient(color-mix(in srgb, var(--accent-primary) 5%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 5%, transparent) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}
```
   Do NOT include `#html-preview-content` or `#images-content` — the grid behind an HTML iframe or image gallery looks wrong.
3. Delete the prior claudify addition block (lines ~2324–2475).
4. Re-add the heading styling (h1 GeistPixel/terracotta; h2–h6 Poppins/cream), using **only these verified markdown preview IDs**:
```css
/* Claudify: h1 — pixel font, terracotta */
body.theme-claudify #markdown-preview-briefs h1,
body.theme-claudify #markdown-preview-design h1 {
    font-family: 'GeistPixel', var(--font-family);
    letter-spacing: -0.05em;
    font-stretch: 90%;
    color: #D97757;
}

/* Claudify: h2-h6 — Poppins, warm cream */
body.theme-claudify #markdown-preview-briefs h2, body.theme-claudify #markdown-preview-briefs h3, body.theme-claudify #markdown-preview-briefs h4, body.theme-claudify #markdown-preview-briefs h5, body.theme-claudify #markdown-preview-briefs h6,
body.theme-claudify #markdown-preview-design h2, body.theme-claudify #markdown-preview-design h3, body.theme-claudify #markdown-preview-design h4, body.theme-claudify #markdown-preview-design h5, body.theme-claudify #markdown-preview-design h6 {
    font-family: 'Poppins', var(--font-family);
    letter-spacing: normal;
    font-stretch: 100%;
    color: #F0EBE6;
}
```

### `src/webview/project.html`

**Verified element IDs in this file:**
- Content containers: `#kanban-content`, `#epics-content`, `#constitution-content`, `#tuning-content`
- Preview panes: `#kanban-preview-pane`, `#epics-preview-pane`, `#constitution-preview-pane`, `#tuning-preview-pane`
- Preview content (markdown render targets): `#kanban-preview-content`, `#epics-preview-content`, `#constitution-preview-content`, `#tuning-preview-content`

1. Replace the variable block (lines 72–86) with the block above.
2. Add the grid (Step 2) using these verified IDs:
```css
body.theme-claudify #kanban-content,
body.theme-claudify #epics-content,
body.theme-claudify #constitution-content,
body.theme-claudify #tuning-content,
body.theme-claudify #kanban-preview-pane,
body.theme-claudify #epics-preview-pane,
body.theme-claudify #constitution-preview-pane,
body.theme-claudify #tuning-preview-pane {
    background-color: #14110F;
    background-image:
        linear-gradient(color-mix(in srgb, var(--accent-primary) 5%, transparent) 1px, transparent 1px),
        linear-gradient(90deg, color-mix(in srgb, var(--accent-primary) 5%, transparent) 1px, transparent 1px);
    background-size: 40px 40px, 40px 40px;
}
```
3. Delete the prior claudify addition block (lines ~743–880): scanline suppression, all `box-shadow: none` rules, the `body.theme-claudify.cyber-theme-enabled` grid override, the list-pane glass tints, the translucent preview-pane backgrounds, **and** the relocated h2–h6 cream override.
4. Re-add the heading styling using these verified `*-preview-content` IDs — h1 GeistPixel/terracotta; h2–h6 Poppins/cream:
```css
/* Claudify: h1 — pixel font, terracotta */
body.theme-claudify #kanban-preview-content h1,
body.theme-claudify #epics-preview-content h1,
body.theme-claudify #constitution-preview-content h1,
body.theme-claudify #tuning-preview-content h1 {
    font-family: 'GeistPixel', var(--font-family);
    letter-spacing: -0.05em;
    font-stretch: 90%;
    color: #D97757;
}

/* Claudify: h2-h6 — Poppins, warm cream */
body.theme-claudify #kanban-preview-content h2, body.theme-claudify #kanban-preview-content h3, body.theme-claudify #kanban-preview-content h4, body.theme-claudify #kanban-preview-content h5, body.theme-claudify #kanban-preview-content h6,
body.theme-claudify #epics-preview-content h2, body.theme-claudify #epics-preview-content h3, body.theme-claudify #epics-preview-content h4, body.theme-claudify #epics-preview-content h5, body.theme-claudify #epics-preview-content h6,
body.theme-claudify #constitution-preview-content h2, body.theme-claudify #constitution-preview-content h3, body.theme-claudify #constitution-preview-content h4, body.theme-claudify #constitution-preview-content h5, body.theme-claudify #constitution-preview-content h6,
body.theme-claudify #tuning-preview-content h2, body.theme-claudify #tuning-preview-content h3, body.theme-claudify #tuning-preview-content h4, body.theme-claudify #tuning-preview-content h5, body.theme-claudify #tuning-preview-content h6 {
    font-family: 'Poppins', var(--font-family);
    letter-spacing: normal;
    font-stretch: 100%;
    color: #F0EBE6;
}
```
5. **Recommended:** Remove the hardcoded `cyber-theme-enabled` class from the `<body>` tag at [project.html:1173](../../src/webview/project.html#L1173) (change `<body class="cyber-theme-enabled">` to `<body>`) to eliminate the one-frame cyber flash on panel open. The JS handler will add the class back if afterburner is active.

> **Note on uppercase headings:** project.html applies `text-transform: uppercase` to preview headings in its base CSS. With GeistPixel on h1 this reads as a pixel-art header — confirm it looks right during verification; if not, add `text-transform: none` to the claudify h1 rule.

### `src/webview/kanban.html`, `implementation.html`, `setup.html`
These have no cyber rules — only variable overrides matter. Edit each `body.theme-claudify` block to **remove the background variables** added previously (`--bg-color`, `--bg-dim`, `--panel-bg`, `--panel-bg2`, `--kanban-bg`) while **keeping** the accent/text/border fixes **and adding `--accent-teal-bright`**:
```css
body.theme-claudify {
    --accent-primary: #D97757;
    --accent-teal: #D97757;       /* keep where present */
    --accent-cyan: #D97757;       /* implementation.html only */
    --accent-teal-bright: #E2A188;  /* NEW — was #5ce8e6 cyan in base :root */
    --text-primary: #F0EBE6;
    --text-secondary: #A8A095;
    --border-color: #38332E;
    --border-bright: #5C544A;
}
```

### `src/webview/shared-tabs.css`
The prior plan added `body.theme-claudify .shared-tab-btn.active { box-shadow: none }` (line 65) and a translucent `.shared-tab-bar` background (line 69). With cyber disabled for claudify, the cyber tab glow no longer applies, so the `box-shadow: none` is inert — remove it. Remove the translucent `.shared-tab-bar` override too (it can re-introduce a faint film); let the tab bar inherit its solid base background.

## Proposed Changes

### `src/webview/planning.js`
- **Context:** The `handleThemeChanged` function (lines 2192–2208) currently enables `cyber-theme-enabled` for both afterburner and claudify, which entangles the two themes.
- **Logic:** Drop `|| state.switchboardTheme === 'claudify'` from the cyber-enable condition. Claudify gets only `theme-claudify`.
- **Implementation:** One-line edit to the `if` condition at line 2199.
- **Edge Cases:** If the theme message arrives with an unknown theme name, both classes are removed — falls back to base. Safe.

### `src/webview/design.js`
- **Context:** Inline theme handler at lines 3030–3044, mirrors planning.js.
- **Logic:** Same one-line condition change.
- **Implementation:** Edit the `if` at line 3036.
- **Edge Cases:** Same as planning.js.

### `src/webview/project.js`
- **Context:** No theme handler exists. The provider posts `switchboardThemeChanged` but nothing listens. The body is hardcoded `cyber-theme-enabled`.
- **Logic:** Add `handleThemeChanged(theme)` mirroring planning.js, using a module-level `let switchboardTheme`. Wire `switchboardThemeNameSetting` and `switchboardThemeChanged` cases into the message switch.
- **Implementation:** Add the function near the top of the script (after state declarations, before the message listener at line 187). Add the two cases to the `switch` at line 189.
- **Edge Cases:** The listener is registered synchronously at script load, before async messages arrive — no race. If `msg.theme` is undefined, the handler keeps the current `switchboardTheme` and just re-applies classes. Safe.

### `src/webview/planning.html`
- **Context:** Variable block at lines 93–107 overrides backgrounds and display font. Prior claudify block at lines ~2288–2430 contains suppression/glass/translucent rules.
- **Logic:** Replace variable block (drop bg vars, drop display-font override, add `--accent-teal-bright`). Delete prior claudify block. Add solid-dark grid on verified content/preview IDs. Re-add heading styles on verified markdown preview IDs.
- **Implementation:** Four edits as described in the CSS section above.
- **Edge Cases:** Ghost IDs from the prior plan (`#local-content`, `#online-content`, `#kanban-content`, `#preview-pane-online`, `#kanban-preview-pane`, `#markdown-preview-online`, `#markdown-preview-design`) must NOT be used — they don't exist as elements in this file.

### `src/webview/design.html`
- **Context:** Same structure as planning.html. Variable block at lines 94–108. Prior claudify block at lines ~2324–2475.
- **Logic:** Same four edits, using this file's verified IDs. Grid excludes `#html-preview-content` and `#images-content` (non-markdown).
- **Implementation:** Four edits as described above.
- **Edge Cases:** Ghost IDs (`#markdown-preview`, `#markdown-preview-online`, `#markdown-preview-tickets`, `#kanban-preview-pane`) must NOT be used — they don't exist as elements in this file.

### `src/webview/project.html`
- **Context:** Variable block at lines 72–86. Prior claudify block at lines ~743–880. Hardcoded `<body class="cyber-theme-enabled">` at line 1173.
- **Logic:** Same four edits plus recommended removal of hardcoded body class.
- **Implementation:** Five edits as described above.
- **Edge Cases:** This file's `*-preview-content` IDs are the markdown render targets (not `*-preview-pane` which are wrappers). Use `*-preview-content` for headings, `*-preview-pane` + `*-content` for grid.

### `src/webview/kanban.html`, `implementation.html`, `setup.html`
- **Context:** Variable blocks at lines 34/46/37 respectively. No cyber rules.
- **Logic:** Remove background vars, keep accent/text/border, add `--accent-teal-bright`.
- **Implementation:** Replace each variable block with the corrected block.
- **Edge Cases:** implementation.html keeps `--accent-cyan: #D97757`. kanban.html and setup.html do not have `--accent-cyan`.

### `src/webview/shared-tabs.css`
- **Context:** Two claudify overrides at lines 65 and 69.
- **Logic:** Remove both — one is inert (cyber disabled), one causes haze.
- **Implementation:** Delete lines 65–70 (both rules).
- **Edge Cases:** None — shared-tabs.css is loaded by multiple webviews but the overrides only applied under claudify.

## Tuning knobs (during verification)
- **Grid intensity:** the `5%` terracotta in the grid gradients. Drop toward `3%` if too busy, raise toward `8%` if invisible.
- **Grid surface darkness:** `#14110F`. Pure black `#0a0a0a` is also fine if the warm tint reads as "not black enough."
- **h1 uppercase in project.html:** add `text-transform: none` to the claudify h1 rule if the pixel font + uppercase looks wrong.
- **`--accent-teal-dim` cascade:** verify that h1 borders render terracotta, not cyan. The base defines `--accent-teal: var(--accent-primary)` (line 59) so the cascade holds, but confirm visually.

## File Change Summary

| File | Change |
|---|---|
| `src/webview/planning.js` | `handleThemeChanged`: enable cyber for afterburner only (drop claudify from the condition) |
| `src/webview/design.js` | Inline theme handler: same one-line condition change |
| `src/webview/project.js` | ADD a theme handler + wire `switchboardThemeChanged` / `switchboardThemeNameSetting` cases (was entirely missing) |
| `src/webview/planning.html` | Slim variable block (no bg, add teal-bright, keep pixel display font); add solid-dark warm grid on verified IDs; delete prior suppression/glass/translucent block; re-add headings (h1 GeistPixel/terracotta, h2-h6 Poppins/cream) on verified IDs |
| `src/webview/design.html` | Same as planning.html, with this file's verified preview IDs in grid + heading selectors; grid excludes non-markdown surfaces |
| `src/webview/project.html` | Same as planning.html, using `*-preview-content` heading IDs and this file's pane IDs for the grid; recommended: remove hardcoded `cyber-theme-enabled` from `<body>` |
| `src/webview/kanban.html` | Variable block: remove background vars, keep accent/text/border + add teal-bright |
| `src/webview/implementation.html` | Same (keep `--accent-cyan` override, add teal-bright) |
| `src/webview/setup.html` | Same (add teal-bright) |
| `src/webview/shared-tabs.css` | Remove the two inert/haze-causing claudify overrides |

## Verification Plan

### Automated Tests
No automated tests apply — this is a CSS/JS visual theme change with no unit-testable logic. The project's test suite does not cover webview rendering. Manual verification is required (see below). Per session directives, compilation and automated tests are skipped; the user will run the build and test suite separately.

### Manual Verification
Manual, across **all** panels — Planning (docs/notebook/research/tickets), Design (briefs/design/html/images/stitch), and **Project (kanban/epics/constitution/tuning)** — and crucially toggling between all three themes:

**Claudify:**
- Background is near-black (NOT grey, NOT milky/hazy); panes are solid and opaque.
- The warm grid is visible across content/preview areas and reads as a crisp grid, not a film.
- No scanlines, no sweep, no glow anywhere (headings, code, blocks, items, buttons, tabs).
- No cyan/teal anywhere — accents, active tabs, links, item borders are terracotta `#D97757`. Check `--accent-teal-bright` surfaces (link-active) are warm, not cyan.
- Preview **h1 is the pixel font (GeistPixel) in terracotta**; h2–h6 are Poppins in warm cream.
- The **Project panel** actually changes (it did not before) and matches the others.
- No one-frame cyber flash when opening the Project panel.

**Afterburner:** full cyberpunk restored and pixel-identical to before this change (scanlines, grid, neon glow, cyan).

**Default theme:** no claudify leakage; and confirm the Project panel is now NON-cyber under default (previously it was stuck cyber).

## Recommendation

Complexity 5 → **Send to Coder.** The JS handler in `project.js` is the highest-value fix and must not be skipped; the CSS is mostly deletion plus one re-added heading block per file. The corrected selector ID lists are essential — the coder must use only the verified IDs listed in each CSS section and must not re-introduce the ghost IDs from the prior plan.
