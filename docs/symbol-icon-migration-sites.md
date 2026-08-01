# UI Symbol Glyph → Masked SVG Icon: Migration Sites

Tracking document for `.switchboard/plans/symbol-glyphs-to-masked-svg-icons.md`.

**Status: Category A complete except two reclassified sites.** 44 usage sites across 9 files
render as masked SVGs painted with `currentColor`. 29 `.sb-icon-*` mask rules across 6 panels;
33 inlined masks total (the extra four are `kanban.html`'s pseudo-element icons). `npm run
icons:parity` gates every one and is wired into CI. The remaining work is the Phase 11 manual
sweep, which no static check can stand in for.

## Migrated — Category A (44 sites)

| File | Line | Icon(s) |
|---|---|---|
| `src/webview/design.html` | 3678, 3829, 3897, 3943 | `reset-view` |
| `src/webview/design.html` | 3679, 3830, 3898, 3944 | `fit-view` |
| `src/webview/design.html` | 3826, 3894 | `pan` |
| `src/webview/design.html` | 3809, 3875 | `close` |
| `src/webview/design.html` | 3777, 4063 | `chevron-down` |
| `src/webview/design.html` | 4082 | `chevron-up` (`.strip-arrow`) |
| `src/webview/kanban.html` | 2774 | `branch` |
| `src/webview/kanban.html` | 7792, 7794, 7796 | `dot` (worktree clean/dirty/— status) |
| `src/webview/kanban.html` | 10480 | `close` |
| `src/webview/kanban.html` | 11471 | `drag-handle` |
| `src/webview/kanban.html` | 11796 | `arrow-child` |
| `src/webview/kanban.html` | 1222, 1543, 2297, 2539 | pseudo-elements: `dot`, `bolt`, `tree-elbow`, `chevron-right` |
| `src/webview/planning.html` | 3811 | `close` |
| `src/webview/planning.html` | 3827 | `pan` |
| `src/webview/planning.html` | 3830, 3831 | `reset-view`, `fit-view` |
| `src/webview/planning.html` | 4365 | `refresh` |
| `src/webview/setup.html` | 4481, 4511 | `close` |
| `src/webview/implementation.html` | 1362 | `bolt` (28px hero, `.sb-icon-lg`) |
| `src/webview/implementation.html` | 1554 | `chevron-down` (`.select-arrow`) |
| `src/webview/implementation.html` | 1609 | `chevron-right` (`.chevron`) |
| `src/webview/design.js` | 716, 1937, 2522 | chevron class toggles |
| `src/webview/planning.js` | 3227, 3413, 3426, 4104 | chevron class toggles |
| `src/webview/planning.js` | 4033 | `refresh` |
| `src/webview/planning.js` | 11205, 11238 | `overflow` |
| `src/webview/planning.js` | 11254 | `chevron-right` (rotated when open) |
| `src/webview/project.js` | 2783 | `check` |

### Class-preservation rule

Every JS site that swaps icon classes **keeps the class the DOM is queried or styled by**.
This is not cosmetic — `className =` clobbers, and several of these classes are load-bearing:

| Class kept | Why |
|---|---|
| `section-chevron` | supplies `color: var(--text-secondary)`, which a `currentColor` mask reads directly |
| `strip-arrow` | `design.js` finds the element with `querySelector('.strip-arrow')` in two places |
| `icon` | `.tree-node .icon` supplies the 16px box; `.tree-node .icon.sb-icon` sets `mask-size: 12px` to match the ink of the 12px glyph it replaced |
| `select-arrow` | absolute positioning plus the `spin` keyframe animation |
| `chevron` | `collapseAllAccordions()` toggles `.open` on it for the rotation |
| `accordion-arrow` | inline `transform: rotate(90deg)` on expand |
| `kanban-structure-handle` | 18px flex column; `.sb-icon` supplies the 16px height |

## Reclassified out of Category A (2 sites)

Both are a glyph **temporarily standing in for text** inside an element whose normal content
is text, set via `textContent`. That is Category C by the plan's own definition, and
converting either would need `innerHTML` surgery plus markup restore — the injection surface
Category C exists to avoid.

| Site | Why it stays text |
|---|---|
| `kanban.html:8213` | `countEl.textContent = '✓'` is a 1200 ms flash that saves and restores `origText`; the element normally holds a column count |
| `kanban.html:11805` | `statusBadge.textContent = '⋯'` is a loading placeholder, overwritten by `badge.innerHTML = '…● clean'` on the next `worktreeStatuses` push |

## Out of scope (per plan, verified unchanged)

Symbol-by-symbol diff against the pre-review tree confirms the only characters removed were
icon affordances — `⎇ ● ● ● ✕ ⋮⋮ ↳` in `kanban.html`, `✕✕` in `setup.html`, `▼▲▼▲` in
`design.js`, `▶▶▼↻⋯⋯▶` in `planning.js`. No prose, separator, or emoji glyph was touched.

- **Category B** — 43 icon+label buttons (`✓ Done`, `↻ Reload Screen`, `⋯ More`). Deferred.
- **Category C** — glyphs inside status sentences set via `textContent`, plus the two sites above.
- **Category D** — separators and `title`-attribute characters (`low→Coder`).
- **Category E** — 7 emoji-presentation sites (`⚙️ ⚠️`), plus the `🔒` branch of
  `kanban.html:11471`, whose `⋮⋮` sibling branch *did* migrate.

## Remaining work

**Phase 11 manual sweep only.** Six panels × two hosts (VS Code webview + browser cockpit) ×
two themes (Afterburner / Claudify), devtools console open. Hunt both failure shapes: a blank
gap (mask failed to load) and a solid `currentColor` block (mask resolved to `none`). Check
baseline alignment hardest where an icon shares a line with text — the tree chevron, the
`.select-arrow`, the breadcrumb marks, the 6px status dots.

Fixed-colour by design, do not file bugs: the `kanban.html` worktree dots at 7792/7794/7796
carry inline `color:#00ad9f` / `#e5c07b` / `#808080`, so they hold their status colour across
themes. Every other icon must follow the theme.

## Invariants

- `icons/icon-<name>.svg` is canonical. Never hand-edit an inlined base64 URI — re-encode from
  the asset and re-run `npm run icons:parity`. Hand-transcription is what produced 24 corrupt
  payloads on the first pass.
- `fill="#45e0e6"` is **frozen** in every asset. Ignored under a mask, but inside the bytes the
  gate compares. To change an icon's visible colour, change the element's `color`.
- Masks are literal URIs. `mask-image: var(…)` is invalid at computed-value time and resets to
  `none`, leaving a solid `currentColor` block.
- Icon boxes use integer `px`, never `em` — fractional sizes clip mask edges under fractional
  display scaling. Variants: `sb-icon` 16px, `sb-icon-sm` 10px, `sb-icon-xs` 6px, `sb-icon-lg` 28px.
- `rotate()` on a masked element is safe; `scale()` rasterizes the mask at initial bounds and
  goes fuzzy.
- `data:` in every `img-src` CSP directive (8 in `headlessPanelHtml.ts`, 3 in providers) is
  load-bearing. Removing it makes every icon invisible at once.
- A new panel adopting the primitive must be added to `PANELS` in `scripts/check-icon-parity.js`,
  or its rules go ungated.
