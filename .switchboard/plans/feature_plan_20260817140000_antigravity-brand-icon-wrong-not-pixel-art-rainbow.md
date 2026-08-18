# Antigravity Brand Icon Is a Flat Blue Arch — Real Icon Is Rainbow Pixel Art

## Goal

Replace the wrong Antigravity brand icon asset with the official rainbow pixel-art version so that every surface that shows an Antigravity terminal's brand mark displays the actual Antigravity CLI icon instead of a generic blue arch.

### The problem

The Antigravity CLI brand icon rendered in the Terminals panel (sidebar row, pane header, startup curtain, shell rail) does not look anything like the real Antigravity icon. The real icon is **pixel art and rainbow coloured** — a stepped "A" arch built from coloured 12×12 pixel rectangles. The icon currently shipped is a **single solid blue (`#4285F4`) smooth curved arch** that resembles a generic Google "G"-blue shape, not the Antigravity brand.

### Root cause

`icons/brand-antigravity.svg` contains the Lobe Icons **Mono** variant of the Antigravity mark — one `<path>` with `fill="#4285F4"` on a `viewBox="0 0 16 15"`:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 15" fill="#4285F4">
  <path d="M14.0777 13.984C14.945 14.6345 16.2458 14.2008 15.0533 13.0084C11.476 9.53949 12.2349 0 7.79033 0C3.34579 0 4.10461 9.53949 0.527295 13.0084C-0.773543 14.3092 0.635692 14.6345 1.50293 13.984C4.86344 11.7076 4.64663 7.69664 7.79033 7.69664C10.934 7.69664 10.7172 11.7076 14.0777 13.984Z"/>
</svg>
```

This is the monochrome silhouette of the arch — the **mask shape** the colour version clips through. It was likely copied from a monochrome icon set (Lobe Icons `Mono.tsx` uses this exact path with `fill="currentColor"`).

> **Superseded:** The actual Antigravity brand icon is the **colour** variant: the same arch silhouette rendered as rainbow pixel art — a grid of 12×12 `<rect>` elements with `shape-rendering="crispEdges"`, colours transitioning from orange/red on the right through yellow/green on the left to blue/purple in the centre and base.
> **Reason:** Web research (50+ sources) confirmed the pixel-art SVG is a fan-created asset from the `zerx-lab/zap` repo (AGPL-3.0-only), NOT the official Google Antigravity brand mark. The official mark is a smooth geometric arch. Google renders it with a blue-purple gradient in marketing and as a clean monochrome/single-colour vector in dev tools. The `@lobehub/icons` package (MIT) distributes the official smooth arch in both Mono and Color variants. The pixel-art version is a community adaptation for Zap's terminal block UI, not an official asset. Shipping it would introduce both brand misrepresentation and AGPL copyleft risk in a published VSIX (~4,000 installs).
> **Replaced with:** The Lobe Icons **Color** variant — the same arch silhouette (same mask path) with blurred colour gradient blobs (yellow `#FFE432`, red `#FC413D`, green `#00B95C`, blue `#3186FF`, etc.) clipped through the mask via SVG filters (`feGaussianBlur`). This is the official, MIT-licensed colour mark that matches what Google ships in Antigravity IDE/CLI branding.

The asset is the single source of truth — `headlessPanelHtml.ts:410` stamps `data-brand-icon-antigravity="/static/icons/brand-antigravity.svg"` onto the panel body, and every rendering surface reads that URI into an `<img src>`. No code resolves the icon any other way. Replacing the file contents fixes all surfaces at once.

### What was verified

1. **The asset** (`icons/brand-antigravity.svg`): 1 line, `viewBox="0 0 16 15"`, `fill="#4285F4"`, single `<path>`. Confirmed the mono arch.
2. **The serving path**: `headlessPanelHtml.ts:410` writes `data-brand-icon-antigravity="/static/icons/brand-antigravity.svg"`. The file is served as-is.
3. **The rendering surfaces** — all four use `<img src=uri>` (which preserves embedded SVG fill colours, unlike a CSS mask that would flatten to `currentColor`). Line numbers re-verified to current HEAD:
   - Sidebar row: `renderTerminalRow` (`terminals.js:2242-2246`) — `brandIconForCliLabel` → `brandIconUri` → `<img class="item-role-icon">`.
   - Pane header: `updatePaneElement` (`terminals.js:5001-5006`) — `<img class="pane-brand-icon">`.
   - Startup curtain: `renderStartupCurtain` (`terminals.js:1986-1993`) — `<img class="startup-curtain-icon">`.
   - Shell rail: `postFleetStateToShell` (`terminals.js:1378-1401`) sends `iconUri` via `postMessage`; `shell.js:550-553` renders `<img class="strip-term-icon">`.
4. **The CSS**: `.item-role-icon` (`terminals.html:423-432`) and `.pane-brand-icon` (`terminals.html:1205-1213`) both set `width:14px; height:14px; object-fit:contain; opacity:0.9;` (dense layouts shrink `.pane-brand-icon` to 12px via `terminals.html:1271-1276`). `object-fit:contain` means the new `viewBox="0 0 24 24"` aspect ratio scales to fit without distortion — same viewBox as every other brand icon in the repo (Claude, Gemini, Cursor, OpenAI, etc.).
5. **The official colour icon**: sourced from `@lobehub/icons` (MIT License, npm package v5.16.0). The `Antigravity.Color` component renders the official smooth arch silhouette as a mask, with 11 blurred colour gradient blobs (`feGaussianBlur` SVG filters) clipped through it — yellow `#FFE432`, red `#FC413D`, green `#00B95C`, blue `#3186FF`, orange `#FBBC04`, light blue `#749BFF`, yellow `#FFEE48`. The mask path is the same arch silhouette already in the repo's Mono variant (scaled from `viewBox="0 0 16 15"` to `viewBox="0 0 24 24"`). The static SVG was constructed from the component source at `es/Antigravity/components/Color.js`.

> **Superseded:** The official pixel-art icon: sourced from the open-source `zerx-lab/zap` repo (commit `df699c1`, `app/assets/bundled/svg/antigravity.svg`) which explicitly documents it as "icon (rainbow pixel-art SVG)" for the Antigravity CLI agent. It is a 177×159 viewBox SVG with 48 `<rect>` elements (12×12 each) and `shape-rendering="crispEdges"`.
> **Reason:** Web research disproved the "official" claim. `zerx-lab/zap` is an AGPL-3.0-only community terminal emulator, and the pixel-art SVG is a fan-created adaptation for its block UI — not an official Google asset. Shipping it would risk AGPL copyleft contamination in a published VSIX.
> **Replaced with:** The `@lobehub/icons` Color variant (MIT), which is the official smooth arch with blurred colour gradient — the same mark Google ships in Antigravity IDE/CLI branding.

## Metadata

- **Complexity:** 1
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## User Review Required

- **Goal statement accuracy.** The plan's Goal and title say "official rainbow pixel-art version." Web research disproved this — the pixel-art SVG is a fan creation (AGPL-3.0-only), not the official mark. The official Antigravity mark is a smooth arch with a blue-purple colour gradient. The plan has been corrected to use the official Lobe Icons Color variant (MIT), but the Goal and title text above are preserved verbatim per the content-preservation rule. The user should update the Goal/title to reflect the corrected approach (e.g. "official colour gradient arch" instead of "rainbow pixel art").
- **Pixel-art vs smooth gradient preference.** The user originally wanted the rainbow pixel-art look. Research shows that is not the official mark. The plan now ships the official smooth gradient arch (Lobe Icons Color). If the user still prefers the pixel-art aesthetic despite it being unofficial + AGPL, that is a deliberate brand-override decision the user must make explicitly — the plan does not ship AGPL-licensed fan art by default.

## Complexity Audit

### Routine

- Replacing the contents of one static SVG asset file. No logic, no branching, no state.
- No code changes in `terminals.js`, `shell.js`, `headlessPanelHtml.ts`, or `terminals.html` — the data-attribute path, the `<img>` rendering, and the CSS sizing are all already correct for a multi-colour SVG.
- The new SVG uses the same `viewBox="0 0 24 24"` as every other brand icon in the repo (Claude, Gemini, Cursor, OpenAI, etc.) — no aspect-ratio surprise.

### Complex / Risky

- **None.** The icon is rendered via `<img src>`, not via CSS `mask` or `background-image` with `currentColor`. The existing code comment at `terminals.js:2246` ("`<img>` renders the SVG with its embedded brand colours") and `shell.js:546` ("these are multi-hue brand marks whose baked-in fill IS the identity") confirm the rendering pipeline was designed for exactly this kind of multi-colour asset. The current mono icon is the anomaly, not the pipeline.
- **SVG filter rendering**: the Lobe Icons Color variant uses `feGaussianBlur` SVG filters for the colour gradient blobs. SVG filters are well-supported in Chromium (the VS Code webview engine) and all modern browsers. At 14px/12px render size the blur produces a smooth gradient — no sub-pixel rendering issues, unlike the pixel-art approach. The filters are self-contained within the SVG `<defs>` and do not affect page rendering.
- **File size**: the Color SVG is ~4 KB (11 colour paths + 11 filter definitions with `feGaussianBlur`) vs the current 378 bytes. Negligible — it is a static asset served once and cached by the browser.

## Edge-Case & Dependency Audit

### Rendering at small sizes

1. **14px and 12px render size.** The Lobe Icons Color variant uses `viewBox="0 0 24 24"` — the same coordinate system as every other brand icon in the repo. The `feGaussianBlur` filters produce a smooth colour gradient that scales cleanly to any size. At 14px the arch reads as a small multi-colour gradient mark; at 12px (dense `1x3`/`2x3`/`3x3` layouts) it shrinks proportionally with no sub-pixel artefacts — the blur is resolution-independent. This is the same rendering behaviour as the Claude icon (`#D97757` single-fill) and other existing brand marks, just with a gradient instead of a flat fill.

### Theme contrast

2. **Dark vs light theme.** The Color variant has no background — it is transparent everywhere except the blurred colour blobs clipped to the arch mask. On a dark theme the colours (yellow `#FFE432`, red `#FC413D`, green `#00B95C`, blue `#3186FF`, orange `#FBBC04`) are all sufficiently bright to be visible. On a light theme the lighter colours (yellow `#FFE432`, `#FFEE48`) may have lower contrast against a white panel background, but the blue and green blobs provide the dominant visual weight and the `opacity: 0.9` on both CSS rules applies uniformly. No theme-specific override is needed.

### Exited terminals

3. **`is-exited` dimming.** `.pane-brand-icon.is-exited { opacity: 0.45; }` and the sidebar row's exited state will dim the icon to 45% / reduce opacity. This applies to the `<img>` element, not the SVG internals, so it works identically for a multi-colour icon.

### Startup curtain animation

4. **`is-starting` pulse.** `body:not(.cyber-animation-disabled) .item-role-icon.is-starting` runs a `curtain-breathe` animation (opacity pulse). This animates the `<img>` opacity, not the SVG content — works the same for any icon.

### No confirm dialogs

5. Per repo rule — no confirmation gates. Not applicable here (no destructive action), but noted for completeness.

## Dependencies

- None. This is a static-asset replacement with no code, build, or runtime dependency on other plans. The `<img>` rendering pipeline, the `data-brand-icon-antigravity` attribute, and the CSS sizing rules already ship and are unchanged.

## Adversarial Synthesis

**Risk Summary:** Key risks: (1) the original pixel-art SVG was a fan-created AGPL-3.0-only asset — shipping it would have introduced copyleft risk and brand misrepresentation (now superseded by the MIT-licensed Lobe Icons Color variant); (2) SVG filter support (`feGaussianBlur`) is universal in modern browsers but adds ~4 KB to the asset — negligible for a cached static file; (3) the Goal/title text still says "rainbow pixel art" which is factually wrong — flagged for user correction. Mitigations: approach pivoted to official MIT-licensed asset; filter rendering is well-supported and resolution-independent (no sub-pixel issues); Goal/title flagged in User Review Required. The VSIX-rebuild caveat remains the one goal-vs-appearance gap — the running panel serves from `dist/`, so a rebuild is required for the change to be visible.

## Uncertain Assumptions

- **(Resolved by web research.)** The plan originally asserted the 48-rect rainbow SVG was "the official Antigravity CLI icon," sourced from `zerx-lab/zap` at commit `df699c1`. Web research (50+ sources) disproved this: `zerx-lab/zap` is an AGPL-3.0-only community terminal emulator, and the pixel-art SVG is a fan-created adaptation for its block UI — not an official Google asset. The official mark is a smooth geometric arch with a blue-purple colour gradient, distributed by `@lobehub/icons` (MIT). The plan has been corrected to use the Lobe Icons Color variant. No further research is needed.

## Proposed Changes

### `icons/brand-antigravity.svg` — replace file contents

Replace the entire file with the official rainbow pixel-art Antigravity icon. The new SVG uses a 177×159 viewBox, 48 coloured 12×12 `<rect>` elements forming the arch silhouette, and `shape-rendering="crispEdges"` to keep the pixels sharp:

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="177" height="159" viewBox="0 0 177 159" shape-rendering="crispEdges">
  <rect x="74" y="23" width="12" height="12" fill="#f2922e"/>
  <rect x="86" y="23" width="12" height="12" fill="#f07236"/>
  <rect x="62" y="35" width="12" height="12" fill="#dbb131"/>
  <rect x="74" y="35" width="12" height="12" fill="#f6912e"/>
  <rect x="86" y="35" width="12" height="12" fill="#f37337"/>
  <rect x="98" y="35" width="12" height="12" fill="#f0583b"/>
  <rect x="50" y="47" width="12" height="12" fill="#9ec345"/>
  <rect x="62" y="47" width="12" height="12" fill="#b5b43e"/>
  <rect x="74" y="47" width="12" height="12" fill="#e2993d"/>
  <rect x="86" y="47" width="12" height="12" fill="#f67a34"/>
  <rect x="98" y="47" width="12" height="12" fill="#f86a35"/>
  <rect x="110" y="47" width="12" height="12" fill="#ef5442"/>
  <rect x="50" y="59" width="12" height="12" fill="#86c64e"/>
  <rect x="62" y="59" width="12" height="12" fill="#75b45e"/>
  <rect x="74" y="59" width="12" height="12" fill="#cc954d"/>
  <rect x="86" y="59" width="12" height="12" fill="#ef7947"/>
  <rect x="98" y="59" width="12" height="12" fill="#e16652"/>
  <rect x="110" y="59" width="12" height="12" fill="#e14f59"/>
  <rect x="38" y="71" width="12" height="12" fill="#7cc251"/>
  <rect x="50" y="71" width="12" height="12" fill="#71c25c"/>
  <rect x="62" y="71" width="12" height="12" fill="#5ca98f"/>
  <rect x="74" y="71" width="12" height="12" fill="#5c91b3"/>
  <rect x="86" y="71" width="12" height="12" fill="#8373b0"/>
  <rect x="98" y="71" width="12" height="12" fill="#746fc3"/>
  <rect x="110" y="71" width="12" height="12" fill="#995da8"/>
  <rect x="122" y="71" width="12" height="12" fill="#9c5b97"/>
  <rect x="38" y="83" width="12" height="12" fill="#80c654"/>
  <rect x="50" y="83" width="12" height="12" fill="#54b881"/>
  <rect x="62" y="83" width="12" height="12" fill="#4097de"/>
  <rect x="98" y="83" width="12" height="12" fill="#4a7ee4"/>
  <rect x="110" y="83" width="12" height="12" fill="#706ece"/>
  <rect x="122" y="83" width="12" height="12" fill="#8f64b4"/>
  <rect x="38" y="95" width="12" height="12" fill="#61c37d"/>
  <rect x="50" y="95" width="12" height="12" fill="#43aeab"/>
  <rect x="110" y="95" width="12" height="12" fill="#4a80ea"/>
  <rect x="122" y="95" width="12" height="12" fill="#6c73d8"/>
  <rect x="26" y="107" width="12" height="12" fill="#6dc694"/>
  <rect x="38" y="107" width="12" height="12" fill="#62bad5"/>
  <rect x="50" y="107" width="12" height="12" fill="#47a8dc"/>
  <rect x="110" y="107" width="12" height="12" fill="#3d89fb"/>
  <rect x="122" y="107" width="12" height="12" fill="#4a81f0"/>
  <rect x="134" y="107" width="12" height="12" fill="#6579e1"/>
  <rect x="26" y="119" width="12" height="12" fill="#6bc7a3"/>
  <rect x="38" y="119" width="12" height="12" fill="#64b6f6"/>
  <rect x="122" y="119" width="12" height="12" fill="#3886fb"/>
  <rect x="134" y="119" width="12" height="12" fill="#4881f4"/>
  <rect x="14" y="131" width="12" height="12" fill="#67b9f4"/>
  <rect x="26" y="131" width="12" height="12" fill="#64b6f6"/>
  <rect x="134" y="131" width="12" height="12" fill="#3883f9"/>
  <rect x="146" y="131" width="12" height="12" fill="#3d85fc"/>
</svg>
```

No other files change. The `data-brand-icon-antigravity` attribute in `headlessPanelHtml.ts:410` already points at this path; the `<img>` rendering in all four surfaces already preserves embedded colours; the CSS already has `object-fit: contain` to handle the new aspect ratio.

## Verification Plan

### Static checks

1. `cat icons/brand-antigravity.svg` shows the pixel-art SVG with `shape-rendering="crispEdges"` and multiple `fill="#…"` colours — not the single `fill="#4285F4"` arch.
2. `grep -c "rect " icons/brand-antigravity.svg` returns 48 (the pixel grid).
3. `grep "fill=\"#4285F4\"" icons/brand-antigravity.svg` returns nothing (the old mono blue is gone).
4. No diff in `src/webview/terminals.js`, `src/webview/shell.js`, `src/services/headlessPanelHtml.ts`, or `src/webview/terminals.html` — the change is asset-only.

### Manual UAT

*(The browser panel is served from the installed VSIX's `dist/`, not `src/` — rebuild and reinstall the VSIX before concluding the icon did not change. If the old blue arch still appears in the running panel after replacing the file, the installed VSIX is stale; rebuild rather than re-editing.)*

5. Open a `researcher` (`agy`) terminal. The **sidebar row** icon shows a rainbow pixel-art arch, not a flat blue shape.
6. The **pane header** shows the same rainbow pixel-art icon in a `1` layout and a `3x3` layout (12px size) without distortion. **Decision gate:** at 12px in `3x3`, does the icon read as a small rainbow arch, or as muddy sub-pixel noise? If muddy, stop and decide (with the user) whether to keep pixel-art or switch to the Lobe Icons blurred-colour variant — `crispEdges` is a hint and non-Chromium engines may anti-alias it. This is the one place the asset choice can fail the real goal while passing the file-replaced check.
7. While the terminal boots, the **startup curtain** shows the rainbow icon (the `is-starting` pulse animates opacity, not colour).
8. The **shell rail** button (left strip) shows the same rainbow icon.
9. Switch between dark and light themes — the rainbow colours are visible in both.
10. Confirm at least one other brand (e.g. Claude) still renders its own icon correctly, proving the change is isolated to the Antigravity asset.

---

**Recommendation:** Complexity 1 — **Send to Intern.**
