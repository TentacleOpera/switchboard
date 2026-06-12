# Stitch Frame Viewer: Overlay Chrome Redesign

## Problem

The Stitch frame viewer currently stacks the header row, toolbar row, and image vertically. This means the chrome (controls) sits *outside* the image container and steals from the image's available space. The critical constraint is that `object-fit: contain` images are aspect-ratio locked — reducing width also reduces height proportionally, so any horizontal chrome (sidebar) double-penalises the image. Any vertical chrome (header/toolbar rows) directly subtracts from image height. The result is that the image occupies far less of the panel than it should.

The thumbnail strip at the bottom compounds this: 12 screens × 80px thumbnails is a fixed-height band that cannot shrink, further eating into the image.

## Core Principle: Overlay Chrome

**Controls must not live outside the image container.** Instead, two thin transparent bars are layered *on top of* the image using absolute positioning. The image container fills 100% of the available pane height (minus the thumbnail strip). Both overlay bars fade from a dark gradient into transparent, so only the edges of the image are obscured — the centre is always fully visible.

The thumbnail strip is the only element that genuinely lives outside the image; it is collapsible so the user can recover that height when needed.

---

## Layout Overview

```
┌──────────────────────────────────────────────────────────────────┐
│ TOP CHROME OVERLAY (absolute, ~48px tall, gradient top→transparent)│
│  Variant 2: Industrial Monotonic    [DL HTML] [DL PNG] [✕ Close] │
│  Device: DESKTOP                                                   │
├──────────────────────────────────────────────────────────────────┤
│                                                                    │
│                                                                    │
│                  IMAGE (fills 100% of container)                  │
│                    object-fit: contain                             │
│                     max freedom both axes                          │
│                                                                    │
│                                                                    │
├──────────────────────────────────────────────────────────────────┤
│ BOTTOM EDIT OVERLAY (absolute, ~52px tall, gradient bottom→trans) │
│  [Describe a change...............] [Explore▾] [Apply Edit]       │
│  [+3 Variants]  ☑Layout  ☑Color  ☑Images  ☑Font  ☑Text           │
└──────────────────────────────────────────────────────────────────┘
┌──────────────────────────────────────────────────────────────────┐
│ THUMBNAIL STRIP (outside pane, below image, collapsible)          │
│  [thumb][thumb][thumb][thumb][thumb][thumb]...  [▲ Collapse]      │
└──────────────────────────────────────────────────────────────────┘
```

---

## Zone-by-Zone Specification

### Zone 1: Image Container (the base layer)

- **Element:** `.preview-body` / `.preview-image-container`
- **Sizing:** `width: 100%; height: 100%; flex: 1; min-height: 0; position: relative`
- The container is `position: relative` so the overlay bars can be `position: absolute` children
- `#preview-image` uses `max-width: 100%; max-height: 100%; object-fit: contain`
- Background of the container: `var(--panel-bg2)` — a subtle dark tone so the image has a defined stage
- No padding. No border. The image fills its natural centred position within the container.

---

### Zone 2: Top Chrome Overlay

- **Position:** `position: absolute; top: 0; left: 0; right: 0; z-index: 10`
- **Height:** `~48px` (enough for two text lines on the left)
- **Background:** `linear-gradient(to bottom, rgba(10,10,10,0.82) 0%, rgba(10,10,10,0.60) 60%, transparent 100%)`
- **Padding:** `8px 12px`
- **Layout:** flex row, `justify-content: space-between; align-items: flex-start`

**Left side — Title Block**
- Line 1: Screen name in `13px / font-weight: 600 / color: #fff`
- Line 2: Device badge (e.g. "DESKTOP") in `10px / color: rgba(255,255,255,0.55) / letter-spacing: 0.08em / uppercase`

**Right side — Action Buttons**
- Three ghost buttons: `[DL HTML]` `[DL PNG]` `[✕ Close]`
- Button style: `border: 1px solid rgba(255,255,255,0.25); background: rgba(0,0,0,0.3); color: rgba(255,255,255,0.85); border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer`
- On hover: `background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.5)`
- `✕ Close` has a slightly higher-contrast border on hover to signal importance
- Buttons are in a flex row with `gap: 6px; align-items: center`

**Opacity behavior:**
- At rest: `opacity: 0.75`
- On hover of the top zone: `opacity: 1; transition: opacity 0.15s ease`
- The gradient background is always present; only the text/button opacity transitions

---

### Zone 3: Bottom Edit Overlay

- **Position:** `position: absolute; bottom: 0; left: 0; right: 0; z-index: 10`
- **Height:** `~56px` (two compact rows)
- **Background:** `linear-gradient(to top, rgba(10,10,10,0.88) 0%, rgba(10,10,10,0.65) 65%, transparent 100%)`
- **Padding:** `10px 12px 10px 12px`
- **Layout:** flex column, `gap: 5px`

**Row 1 — Edit Input Row**
- `[text input: flex 1, min-width 0]` `[Explore/Refine/Reimagine select, ~110px]` `[Apply Edit button]` `[+3 Variants button]`
- Text input style: `background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.20); color: #fff; border-radius: 4px; padding: 5px 10px; font-size: 12px`
- Input placeholder: `rgba(255,255,255,0.40)` 
- Input focus: `border-color: var(--accent-teal); outline: none`
- Select: same style as the input, `font-size: 12px`
- `Apply Edit`: teal-filled primary button `background: var(--accent-teal); color: #000; border: none; font-weight: 600; border-radius: 4px; padding: 5px 14px; font-size: 12px`
- `+3 Variants`: ghost button same style as top zone buttons

**Row 2 — Aspect Checkboxes**
- Five tiny toggle chips: `[☑ Layout]` `[☑ Color]` `[☑ Images]` `[☑ Font]` `[☑ Text]`
- Chip style when checked: `background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.30); color: rgba(255,255,255,0.80); border-radius: 3px; padding: 2px 7px; font-size: 10px; cursor: pointer`
- Chip style when unchecked: `background: transparent; border: 1px solid rgba(255,255,255,0.12); color: rgba(255,255,255,0.35)`
- The actual `<input type="checkbox">` is visually hidden; the chip itself is the click target (controlled by a label)
- Row is `display: flex; gap: 5px; align-items: center`

**Opacity behavior:**
- At rest: `opacity: 0.80`
- On hover of the bottom zone: `opacity: 1; transition: opacity 0.15s ease`

---

### Zone 4: Thumbnail Strip (Collapsible)

The strip lives **outside and below** the image container — it is a sibling, not a child. It can be collapsed.

**Expanded state (default):**
```
┌─────────────────────────────────────────────────────────────┬──────────┐
│  [thumb] [thumb] [thumb] [thumb] [thumb] [thumb] ...  (scroll)│ ▲ Collapse│
└─────────────────────────────────────────────────────────────┴──────────┘
```
- Fixed height `72px` (thumbnails 56px + 8px padding top/bottom)
- Background: `var(--panel-bg)` with `border-top: 1px solid var(--border-color)`
- Thumbnails: `width: 76px; height: 56px; object-fit: cover; border-radius: 3px; border: 2px solid transparent`
- Active thumbnail: `border-color: var(--accent-teal); opacity: 1`
- Inactive: `opacity: 0.55` → `0.85` on hover
- Overflow-x: auto (horizontal scroll if more than fit)
- **Collapse toggle:** a small right-aligned chip button `[▲ 12 screens]` in `font-size: 10px; color: var(--text-secondary); padding: 3px 8px; border: 1px solid var(--border-color); border-radius: 3px; background: var(--panel-bg2)`

**Collapsed state:**
```
┌─────────────────────────────────────────────────────────────┬──────────┐
│                                                             │ ▼ 12 scr │
└─────────────────────────────────────────────────────────────┴──────────┘
```
- Height collapses to `28px` — just enough to show the toggle chip
- The strip background and border remain so the toggle is discoverable
- Image container grows via flex to fill the reclaimed `44px`
- Toggle chip changes to `[▼ 12 screens]`
- **Transition:** `height 0.2s ease; overflow: hidden`

**Placeholder slots during generation:**
- Thumbnail placeholders (`Rendering...` text) maintain the same 76×56 box so the strip height does not change while screens generate

---

## Structural Changes to `#stitch-preview-pane`

Current structure (vertical stack with chrome eating space):
```
#stitch-preview-pane (flex column)
  ├── .preview-header        ← separate row, fixed height
  ├── .preview-toolbar       ← separate row, wraps, variable height
  └── .preview-body
       └── .preview-image-container
```

New structure (image fills all, chrome overlaid):
```
#stitch-preview-pane (flex column, flex: 1, min-height: 0)
  └── .preview-image-container (flex: 1, position: relative, min-height: 0)
       ├── .preview-top-overlay      (absolute, top 0)
       ├── img#preview-image         (max-width/height 100%, object-fit: contain)
       └── .preview-bottom-overlay   (absolute, bottom 0)

#stitch-thumbnail-strip (sibling to #stitch-preview-pane, NOT inside it)
  ├── .stitch-strip-thumb × N
  └── .strip-collapse-btn
```

The `#stitch-preview-pane` CSS removes `gap: 12px; padding: 12px` (which added external spacing) and becomes simply a flex column that fills its parent. The inner image container has `overflow: hidden` so absolute-positioned overlay children clip cleanly at the image area boundary.

---

## Visual Treatment Notes (for Stitch mockup generation)

The overlay bars should feel like a **cinema UI** — the kind you see on Apple TV or YouTube when you hover over a video. Key visual properties to convey:

- The image is the hero. The chrome is barely-there at rest, present on hover.
- The gradient fades are generous (spanning ~40% of the bar height) so there is no hard edge between control and image.
- Buttons and text in the overlays use white-on-dark rather than the VS Code theme accent colors — this keeps them readable regardless of the image content beneath.
- The bottom overlay background is slightly more opaque than the top, because the edit controls need to be readable when the user is actively typing.
- The thumbnail strip has a definite visual boundary (border-top, background match) so it reads as a separate navigation element, not part of the image stage.
- When the image is loading (placeholder state), the overlays are more opaque (0.95) and the image area shows a pulsing skeleton/shimmer.

---

## Interaction States

| State | Top overlay | Bottom overlay | Thumbnail strip |
|---|---|---|---|
| Image loaded, idle | opacity 0.75 | opacity 0.80 | Visible, 72px |
| Hovering top zone | opacity 1.0 | opacity 0.80 | — |
| Hovering bottom zone | opacity 0.75 | opacity 1.0 | — |
| Edit input focused | opacity 0.75 | opacity 1.0 | — |
| Image loading | opacity 0.95 | hidden | Placeholder slots visible |
| Strip collapsed | — | — | 28px, toggle chip only |
| Strip expanded | — | — | 72px, all thumbs |

---

## What This Solves

- **Image fills its full container** — no vertical chrome rows before it, no horizontal sidebar beside it.
- **Aspect ratio constraint no longer matters** — the image can use the full pane in both axes. A 16:9 desktop screenshot in a roughly 16:9 pane now fills nearly 100% of both.
- **All functionality preserved** — DL HTML, DL PNG, Apply Edit, +3 Variants, Close, refine text input, creative range select, all 5 aspect checkboxes, all thumbnail navigation. Nothing is hidden behind a toggle by default.
- **Thumbnail strip is now optional** — users who want maximum image space can collapse it; users who use it for navigation leave it expanded.
- **Graceful edge obscuring** — the gradient overlays cover only the top and bottom ~12–15% of the image, and those regions are typically decorative (browser chrome in a screenshot, background areas), not content-critical.

---

## Review Findings

Review completed with no material issues. All structural changes, overlay positioning, gradient styling, opacity behaviours, thumbnail strip collapse logic, and state persistence match the plan. No code changes were required. No compilation or test regressions. Remaining risks: select dropdown native styling in non-Chromium webviews; loading placeholder could benefit from a shimmer animation for visual polish.

## Metadata
- **Complexity:** 4
- **Tags:** frontend, ui, ux, stitch, layout
