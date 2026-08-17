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

This is the monochrome silhouette of the arch — the **mask shape** the colour version clips through. It was likely copied from a monochrome icon set (Lobe Icons `Mono.tsx` uses this exact path with `fill="currentColor"`). The actual Antigravity brand icon is the **colour** variant: the same arch silhouette rendered as rainbow pixel art — a grid of 12×12 `<rect>` elements with `shape-rendering="crispEdges"`, colours transitioning from orange/red on the right through yellow/green on the left to blue/purple in the centre and base.

The asset is the single source of truth — `headlessPanelHtml.ts:410` stamps `data-brand-icon-antigravity="/static/icons/brand-antigravity.svg"` onto the panel body, and every rendering surface reads that URI into an `<img src>`. No code resolves the icon any other way. Replacing the file contents fixes all surfaces at once.

### What was verified

1. **The asset** (`icons/brand-antigravity.svg`): 1 line, `viewBox="0 0 16 15"`, `fill="#4285F4"`, single `<path>`. Confirmed the mono arch.
2. **The serving path**: `headlessPanelHtml.ts:410` writes `data-brand-icon-antigravity="/static/icons/brand-antigravity.svg"`. The file is served as-is.
3. **The rendering surfaces** — all four use `<img src=uri>` (which preserves embedded SVG fill colours, unlike a CSS mask that would flatten to `currentColor`):
   - Sidebar row: `renderTerminalRow` (`terminals.js:2193-2208`) — `brandIconForCliLabel` → `brandIconUri` → `<img class="item-role-icon">`.
   - Pane header: `updatePaneElement` (`terminals.js:4792-4796`) — `<img class="pane-brand-icon">`.
   - Startup curtain: `renderStartupCurtain` (`terminals.js:1937-1946`) — `<img class="startup-curtain-icon">`.
   - Shell rail: `postFleetStateToShell` (`terminals.js:1367-1368`) sends `iconUri` via `postMessage`; `shell.js:550-553` renders `<img class="strip-term-icon">`.
4. **The CSS**: `.item-role-icon` (`terminals.html:423-432`) and `.pane-brand-icon` (`terminals.html:1167-1175`) both set `width:14px; height:14px; object-fit:contain;` (dense layouts shrink to 12px). `object-fit:contain` means the new `viewBox="0 0 177 159"` aspect ratio scales to fit without distortion.
5. **The official pixel-art icon**: sourced from the open-source `zerx-lab/zap` repo (commit `df699c1`, `app/assets/bundled/svg/antigravity.svg`) which explicitly documents it as "icon (rainbow pixel-art SVG)" for the Antigravity CLI agent. It is a 177×159 viewBox SVG with 48 `<rect>` elements (12×12 each) and `shape-rendering="crispEdges"`.

## Metadata

- **Complexity:** 1
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

## Complexity Audit

### Routine

- Replacing the contents of one static SVG asset file. No logic, no branching, no state.
- No code changes in `terminals.js`, `shell.js`, `headlessPanelHtml.ts`, or `terminals.html` — the data-attribute path, the `<img>` rendering, and the CSS sizing are all already correct for a multi-colour SVG.
- The `shape-rendering="crispEdges"` attribute on the new SVG ensures the pixel rectangles stay sharp at the 14px render size rather than being anti-aliased into a blur.

### Complex / Risky

- **None.** The icon is rendered via `<img src>`, not via CSS `mask` or `background-image` with `currentColor`. The existing code comment at `terminals.js:2197` ("`<img>` renders the SVG with its embedded brand colours") and `shell.js:546` ("these are multi-hue brand marks whose baked-in fill IS the identity") confirm the rendering pipeline was designed for exactly this kind of multi-colour asset. The current mono icon is the anomaly, not the pipeline.
- **File size**: the pixel-art SVG is ~2 KB (48 `<rect>` elements with short attribute strings) vs the current 378 bytes. Negligible — it is a static asset served once and cached by the browser.

## Edge-Case & Dependency Audit

### Rendering at small sizes

1. **14px and 12px render size.** The pixel-art icon is a 177×159 grid of 12×12 cells (roughly 15 columns × 13 rows). At 14px wide, each cell renders at ~0.9px — sub-pixel. `shape-rendering="crispEdges"` tells the browser to use nearest-neighbour rather than anti-aliasing, which keeps the pixel boundaries legible at small sizes. At 12px (dense `1x3`/`2x3`/`3x3` layouts) the cells are ~0.8px. This is the intended look for a pixel-art icon — it reads as a small coloured rainbow arch, not a smooth gradient. If it appears too muddy at 12px in practice, the fallback is the Lobe Icons blurred-colour version (mask + `feGaussianBlur` blobs), but the pixel-art version is what the user asked for and what the official CLI uses.

### Theme contrast

2. **Dark vs light theme.** The pixel-art icon has no background — it is transparent everywhere except the coloured rectangles. On a dark theme the colours (orange `#f2922e`, green `#9ec345`, blue `#3186ff`, purple `#8f64b4`, etc.) are all sufficiently bright to be visible. On a light theme the lighter colours (yellow `#dbb131`, light green `#86c64e`) may have lower contrast against a white panel background, but the icon is the same one the official CLI renders and the `opacity: 0.9` on both CSS rules applies uniformly. No theme-specific override is needed.

### Exited terminals

3. **`is-exited` dimming.** `.pane-brand-icon.is-exited { opacity: 0.45; }` and the sidebar row's exited state will dim the icon to 45% / reduce opacity. This applies to the `<img>` element, not the SVG internals, so it works identically for a multi-colour icon.

### Startup curtain animation

4. **`is-starting` pulse.** `body:not(.cyber-animation-disabled) .item-role-icon.is-starting` runs a `curtain-breathe` animation (opacity pulse). This animates the `<img>` opacity, not the SVG content — works the same for any icon.

### No confirm dialogs

5. Per repo rule — no confirmation gates. Not applicable here (no destructive action), but noted for completeness.

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
6. The **pane header** shows the same rainbow pixel-art icon in a `1` layout and a `3x3` layout (12px size) without distortion.
7. While the terminal boots, the **startup curtain** shows the rainbow icon (the `is-starting` pulse animates opacity, not colour).
8. The **shell rail** button (left strip) shows the same rainbow icon.
9. Switch between dark and light themes — the rainbow colours are visible in both.
10. Confirm at least one other brand (e.g. Claude) still renders its own icon correctly, proving the change is isolated to the Antigravity asset.

---

**Recommendation:** Complexity 1 — **Send to Intern.**
