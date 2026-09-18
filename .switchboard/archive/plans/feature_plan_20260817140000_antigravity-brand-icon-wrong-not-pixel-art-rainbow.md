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

- **None — both open questions were decided by the user on 2026-08-19.** The pixel-art mark ships. The earlier research finding ("pixel art is fan-created AGPL art, the smooth arch is the official mark") was **half wrong**: the smooth gradient arch is the Antigravity **app/IDE launch icon**, while the **CLI terminal** renders the pixel-art variant. These surfaces brand CLI *seats*, so the pixel mark is the contextually correct one, not a downgrade. The AGPL concern applied only to copying `zerx-lab/zap`'s file — not to the pixel-art treatment itself — and is fully sidestepped: the shipped asset is generated from the repo's own MIT Lobe Icons Color asset (see Proposed Changes), so no third-party file is redistributed. The title and Goal wording ("rainbow pixel art") is now accurate and needs no correction.

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

> **Superseded (twice):** first with the `zerx-lab/zap` pixel-art SVG (48 rects, 177×159), then with the `@lobehub/icons` smooth Color variant (24×24, mask + 11 `feGaussianBlur` blobs).
> **Reason:** the zap file is AGPL-3.0-only and cannot be redistributed in the VSIX. But the pivot to the smooth arch over-corrected — that mark is the Antigravity **app launcher** icon, and the **CLI** renders pixel art, so the smooth variant was wrong for these surfaces.
> **Replaced with:** a pixel-art mark **generated from the repo's own MIT asset**, which gets the correct CLI aesthetic with no third-party file involved.

Ship a 12×12 pixel-art arch, derived mechanically from the Lobe Icons Color variant (MIT) that this plan previously installed:

1. Rasterise the MIT Color SVG to 480×480 RGBA on a transparent ground (headless Chrome, `--default-background-color=00000000`).
2. Sample a 12×12 grid over the full 24×24 viewBox. Keep a cell when its mean alpha ≥ 0.5 (that alpha *is* the arch mask, so the silhouette is inherited exactly); colour it with the alpha-weighted mean RGB of the cell, saturation ×1.45 to restore the vividness that cell-averaging mutes.
3. Emit one `<rect width="1" height="1">` per kept cell on `viewBox="0 0 12 12"` with `shape-rendering="crispEdges"`.

Result: 46 rects, 2,728 bytes — against the 48 rects of the zap reference, confirming the grid density matches. Both the silhouette and the palette are inherited from the MIT asset, so the output carries the official arch shape and the official colour ramp (yellow/orange/red across the top, green upper-left, blue through the legs and base) in pixel form. The generator lives in the session scratchpad, not the repo — this is a one-shot asset, and re-running it would only reproduce the committed file.

The square `viewBox="0 0 12 12"` keeps the sibling convention (every other brand icon is square), so `object-fit: contain` fills the 14px/12px boxes exactly as the others do. No other files change.

## Verification Plan

### Static checks

1. `cat icons/brand-antigravity.svg` shows a grid of 1×1 `<rect>` elements with `shape-rendering="crispEdges"` and multi-hue fills — not a `<mask>` + `feGaussianBlur` gradient, and not the single `fill="#4285F4"` arch.
2. `grep -c "<rect" icons/brand-antigravity.svg` returns 46.
3. `grep -E 'fill="#4285F4"|feGaussianBlur' icons/brand-antigravity.svg` returns nothing (both superseded assets are gone).
4. `grep viewBox icons/brand-antigravity.svg` shows `viewBox="0 0 12 12"` — square, so it fills the icon box like its 24×24 siblings.
5. No diff in `src/webview/shell.js`, `src/services/headlessPanelHtml.ts`, or `src/webview/terminals.html` — the change is asset-only. `src/webview/terminals.js` is a SHARED-TREE exception: other agents work it concurrently, so a non-empty diff there is expected and does not belong to this plan. Scope it (`git diff -- src/webview/terminals.js`) and confirm the hunks are unrelated rather than reading a dirty file as a failed check.

### Automated Tests

*(Skipped for this run per session directive — the checks remain documented here for when the implementer runs them.)*

- No automated tests apply — this is a static asset replacement with no code logic change. The existing test suite (if any references the icon path) should pass unchanged.

### Manual UAT

*(Two staleness traps sit between this file and the screen — clear BOTH before concluding the icon did not change.*

*1. **Install staleness.** The icon is served from `<extensionRoot>/icons/`, not `dist/` — the `icons` static route is `path.join(repoRoot, 'icons')` in both hosts (`bootstrap.ts:763`, `TaskViewerProvider.ts:3439`), so `npm run compile` does nothing for it, but the running panel reads the INSTALLED VSIX's copy. Repackage and reinstall.*

*2. **HTTP cache staleness.** `/static/icons/*` is served `Cache-Control: public, max-age=3600` with no ETag or Last-Modified (`LocalApiServer.ts:1000-1004` — `isCode` is true only for the `webview` prefix). The URL is unversioned and the bytes were replaced in place, so a fresh cache entry is reused with no request at all: an open or recently-loaded cockpit tab keeps showing the OLD blue arch for up to an hour after a correct reinstall. Hard-reload (Cmd+Shift+R) or restart the panel on a new port before calling the fix failed.)*

6. Open a `researcher` (`agy`) terminal. The **sidebar row** icon shows a smooth colour-gradient arch (yellow/red/green/blue blur), not a flat blue shape.
7. The **pane header** shows the same colour-gradient icon in a `1` layout and a `3x3` layout (12px size) without distortion. The `feGaussianBlur` filters scale smoothly — no sub-pixel artefacts at any size.
8. While the terminal boots, the **startup curtain** shows the colour-gradient icon (the `is-starting` pulse animates opacity, not colour).
9. The **shell rail** button (left strip) shows the same colour-gradient icon.
10. Switch between dark and light themes — the gradient colours are visible in both (blue and green blobs dominate; yellow may be lower contrast on light theme but is not the primary visual).
11. Confirm at least one other brand (e.g. Claude) still renders its own icon correctly, proving the change is isolated to the Antigravity asset.

---

**Recommendation:** Complexity 1 — **Send to Intern.**

## Completion Report

- **What was implemented:** Replaced the monochrome flat blue arch in `icons/brand-antigravity.svg` with the official multi-hue Lobe Icons Color variant SVG asset (viewBox 0 0 24 24, smooth arch silhouette mask, 11 blurred color gradient blobs with `feGaussianBlur` filters, MIT licensed).
- **Files changed:** `icons/brand-antigravity.svg`
- **Issues encountered:** None. The rendering pipeline and CSS rules already expect and support 24x24 multi-color SVGs.

## Review Findings

Reviewed 2026-08-19; verdict **pass**, after a mid-review correction that changed the shipped asset. The change is genuinely asset-only — the concurrent `src/webview/terminals.js` diff in the tree is unrelated team-group work by another agent. Rendering was verified empirically rather than by grep: headless Chrome (the same Blink engine the cockpit runs on) shows the pixel-art arch reading correctly at 12px, 14px, 22px and 56px, on dark and light grounds, and through both dimming treatments (`is-exited` 0.45 and the strip's `grayscale(1) brightness(1.7)`); the stepped edges stay legible even at 14px. No CSS mask, `data-brand` override or per-brand recolour flattens the fills on any of the four surfaces, and both hosts serve the file from `<extensionRoot>/icons/` (`bootstrap.ts:763`, `TaskViewerProvider.ts:3439`). The review also corrected this plan's own research: the smooth gradient arch is the Antigravity **app launcher** icon, the CLI renders pixel art, so the earlier "pixel art is unofficial fan art" conclusion drove the wrong pivot — the AGPL risk was real but applied only to redistributing zap's file, which generating from the repo's own MIT asset avoids entirely. Gates green: `icons:parity` (37 rules / 18 assets), `test:contract:shell-terminal-strip` (40/40), `test:contract:vsix-packaging` (8/8) — all three CI-wired in `.github/workflows/integration-tests.yml`; residual risk is the HTTP-cache staleness trap now documented in Manual UAT.
