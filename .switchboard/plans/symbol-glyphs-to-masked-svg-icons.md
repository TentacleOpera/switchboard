# Replace UI Symbol Glyphs with Masked SVG Icons

## Goal

Stop rendering UI affordances — chevrons, close buttons, status dots, refresh arrows, zoom controls, drag handles — as Unicode font glyphs. Render them as single-colour SVGs painted with `currentColor` via CSS `mask-image`, so they are metric-independent, theme-following, and immune to font fallback entirely.

Scope is deliberately narrow: the **~62 sites where a symbol is the entire content of its element**. Symbols that sit inside sentences, status messages, tooltips, or `title` attributes stay as text — they are typography, not iconography, and SVG cannot express them.

End state: no UI control depends on a font containing a glyph. The font fallback tails become a convenience rather than a load-bearing dependency.

> **Clarification (do not re-litigate, flagged to user):** This plan achieves that end state for **Category A only (~62 glyph-only sites)**. **Category B (43 icon+label buttons) is deferred** (see *Decisions Already Made*), so after this plan lands those 43 buttons still carry a font glyph alongside their label — the headline "no UI control depends on a font" is reached only when a follow-on covers B. The "cheap partial win" (delete the 8 OS-fallback glyphs from B, keep the label) is available now but is not gated by this plan. The End state sentence is preserved as the product intent; this note bounds what *this* plan delivers.

### Problem

The webviews use 24 distinct non-ASCII symbols as interface elements. **No font in any stack we can name contains them all**, and the gaps are not marginal:

| supplier | covers of 24 | verified how |
|---|---|---|
| Hanken Grotesk (the body face) | **0** | `cmap` inspection via fontTools |
| Menlo (macOS tail) | **16** | Apple font documentation |
| Consolas (Windows tail) | **3** — only `─ └ ●` | Microsoft font documentation |

So **eight symbols** (`⋮ ⎇ ⚙ ⚠ ⚡ ✥ ⟲ ⤢`) reach the screen only through OS-level fallback on macOS, and **twenty-one** do on Windows. That produces three concrete defects:

1. **Metric mismatch.** Fallback faces carry their own leading and ascender/descender metrics. On Windows, DirectWrite substitutes `Segoe UI Symbol`, whose internal leading is larger than the surrounding face — so a symbol inside a fixed-height badge or a small button can clip or sit off-baseline while the adjacent text fits fine. macOS Core Text adjusts placement more gracefully, which is exactly why a macOS-only test pass never surfaces this.
2. **Uncontrolled colour.** `⚙ ⚠ ⚡` are absent from Hanken, Menlo *and* Consolas, and both platforms' fallback routes them to an emoji font before a monochrome symbol font. They render as **colour emoji** regardless of the `color` property. A "warning" glyph that ignores the theme's accent colour is not a themeable icon.
3. **Tofu on stripped platforms.** Windows Server / LTSC images may omit `Segoe UI Emoji` and supplemental font packs, in which case `⎇` and `⤢` render as boxes. No font stack we can write prevents this.

### Root Cause

Using a text glyph as an icon couples the interface to font *content* — which fonts contain which codepoints — rather than to an asset we ship. Every mitigation available inside a font stack (longer tails, different faces, more fallbacks) manages the symptom; none removes the coupling, because the glyphs simply are not in the faces we can name. The fix is to stop asking a font for an icon.

### Why now, and why this is not more font work

`decouple-webview-fonts-from-host.md` and `correct-font-role-assignment.md` between them make the fallback tails **load-bearing**: after those land, `Menlo, Consolas` in the proportional stack is the only thing supplying 16 of the 24 symbols, and a reviewer who trims it as dead cruft silently breaks the UI with no lint, compile, or grep signal. That is a fragile end state to leave in place deliberately. This plan removes the dependency instead of documenting it.

### The precedent already exists in this repo

The browser nav rail was migrated to exactly this pattern:

- `src/webview/shell.html` — `.strip-glyph { width: 20px; height: 20px; background-color: currentColor; mask-repeat: no-repeat; mask-position: center; mask-size: contain; }` (with `-webkit-` twins)
- `src/webview/shell.js:46–52` — `buildMaskedGlyph(iconUrl)` sets `maskImage` / `webkitMaskImage` inline
- `icons/nav-{artifacts,board,design,memo,project,setup,terminals,theme}.svg` — 16×16, single `<path fill="…" fill-rule="evenodd">`, ~400–630 bytes each

  > **Superseded:** `icons/nav-{artifacts,board,design,memo,project,setup,theme}.svg` (seven assets listed).
  > **Reason:** Direct `ls icons/nav-*.svg` this session returns eight files — `nav-terminals.svg` was omitted. The convention's maturity argument relies on the count being right.
  > **Replaced with:** eight assets, including `nav-terminals.svg`, as listed above.

So this is **extending a proven in-repo pattern**, not introducing an architecture. The in-file comment already states the rationale: *"an `<img>` would stay the file's baked-in fill"* — masking is what makes the glyph follow the button's idle/hover/active colours.

### Sizing

**One plan.** Single root cause (icons implemented as font glyphs), single deliverable (they become SVGs), one taxonomy applied uniformly. Splitting by panel would mean re-deriving the classification taxonomy six times; splitting asset-authoring from migration produces two halves that ship nothing on their own — assets with no consumers, or a migration with no assets. Phases are file-scoped increments of one deliverable, each independently verifiable.

## Metadata

**Tags:** frontend, ui, ux, refactor, reliability

**Complexity:** 6

## User Review Required

**None.** The three decisions a reader might expect to be asked about are made below and recorded in *Decisions Already Made*: the delivery mechanism (inline `data:` URIs), the scope boundary (glyph-only sites; icon+label buttons deferred), and the icon style (match `icons/nav-*.svg` exactly).

## Complexity Audit

### Routine

- The rendering pattern is already implemented and shipping (`.strip-glyph` in `shell.html`).
- ~62 sites is a small, fully enumerable set — the authoritative list is a Phase 1 deliverable, not a discovery risk.
- Each icon is a 16×16 single-path SVG in a style already established by eight existing assets.
- No provider, CSP, packaging, or build change is required (see *Decisions Already Made*).
- No state, no async, no data path, no security surface.

### Complex / Risky

- **There are two failure modes, with opposite appearances.** Confirmed against the CSS Masking spec: an *unloadable or malformed* mask image evaluates to a transparent-black layer, so the element renders **completely invisible**; a *CSS-invalid* `mask-image` (syntax error, or a `var()` invalid at computed-value time) computes to `none`, so no mask is applied and `background-color: currentColor` paints a **solid block**. Both must be designed against and both must be swept for — a verifier told to hunt only solid blocks will pass a page full of missing icons. See *Failure Modes*.
- **Four sites are CSS pseudo-element glyphs** (`content: '▸'`, `content: '└─'`, `content: ' ●'`, `content: '⚡ '`), which need restructuring to `content: ''` plus box metrics — a different edit shape from the markup sites.
- **~12 sites are JS state toggles** (`textContent = isCollapsed ? '▸ ' : '▾ '`). Replacing a text swap with an icon swap changes how state is expressed, and a `var()`-based swap would reintroduce the solid-square failure.
- **Two sources of truth for each asset** (the `.svg` file and its inlined `data:` URI) can drift. Mitigated by a parity check, not by discipline.
- Dual-host verification with no rendering harness, plus a theme-following check that an `<img>`-based approach would silently fail.

## Edge-Case & Dependency Audit

### Race Conditions

- None. Icons are static CSS declarations or synchronous DOM writes. No async loading (`data:` URIs are same-document, so there is no fetch, no network latency, and no flash-of-missing-icon).

### Security

- **No new surface, and one small reduction.** `data:image/svg+xml` in a CSS `mask-image` is not executable: mask images are rendered as images, so scripts, `<foreignObject>` and external references inside them do not execute. The SVGs are repo assets, not user input.
- **No CSP change required — verified, and the requirement is real.** Research confirms mask-image fetches are governed by **`img-src`** (falling back to `default-src`; there is no `mask-src` directive), and that `data:` URIs in mask position are **not** exempt as same-document — they need an explicit `data:` source expression. Every CSP in this codebase already has one: `headlessPanelHtml.ts` lines 115, 132, 192, 230, 267, 301, 326, 350, and providers `KanbanProvider.ts:11133`, `TaskViewerProvider.ts:20644`, `SetupPanelProvider.ts:1587`. Nothing is widened.

  > **Superseded:** "headlessPanelHtml.ts lines 115, 132, 192, 230, 267, 301, 326" (seven headless CSPs) and "those ten CSPs" below.
  > **Reason:** Direct grep of `img-src` across the four CSP-authoring files this session returns **eight** headless CSPs — line 350 (a third `frame-src 'none'` variant) was omitted — plus the three provider CSPs, totalling eleven. The conclusion (all already permit `data:`) is unchanged; the count is what a future "tighten the CSP" reviewer will grep against, so it must be right.
  > **Replaced with:** eight headless CSPs (add `:350`) and eleven total. The load-bearing-`data:` guard below is updated to match.

- **Guard for the future:** because `data:` in `img-src` is load-bearing after this lands, removing it from any of those eleven CSPs — a plausible "tighten the CSP" cleanup — turns **every icon invisible at once**, with a console CSP violation as the only signal. Several of those policies use `default-src 'none'` (all headless variants except `:132` and `:301`, which use `default-src 'self'`), so there is no permissive fallback to absorb it.
- Several Category C sites currently build status strings with `textContent`, which cannot hold markup. Any temptation to convert those to `innerHTML` to fit an icon in would introduce an injection surface for interpolated server/API text. **They are out of scope precisely so that does not happen** — see *Decisions Already Made*.

### Side Effects

- **Icons become theme-reactive.** `currentColor` means an icon follows `color` through hover, active, disabled and theme states. Some glyphs currently carry hardcoded colours (`kanban.html:7528–7532` sets `style="color:#00ad9f"` etc. on status dots) — those keep working, since `currentColor` resolves against the inline `color`.
- **Line-height and inline flow change.** A text glyph is a character on the text baseline; a masked icon is an `inline-block` box. Anywhere an icon sits inline with text (breadcrumbs, chevron-plus-label), vertical alignment needs `vertical-align: middle` or a flex container. This is the main visual-regression surface.
- **Slight CSS growth.** ~17 icons × ~500 bytes of percent-encoded SVG, duplicated into the panels that use each one. Expect a few KB per panel of inline CSS. Acceptable; these files are already 10k+ lines.
- The `⚙️ ⚠️` emoji-presentation sites (7 of them) are **unaffected** — they are deliberately emoji and stay that way.

### Dependencies & Conflicts

- **Sequence after the "Font improvements" feature.** Not a functional dependency in either direction — this plan works standalone — but `correct-font-role-assignment.md` edits 268 sites across the same panel files. Landing this plan first would put ~62 structural edits in the middle of that sweep's blast radius. Let the bigger sweep finish.
- **The nav rail is deliberately untouched.** `shell.html` / `shell.js` / `icons/nav-*.svg` already work and are browser-only. Do not "unify" them onto the new primitive; the `/static/icons/` URL approach is correct there and wrong for dual-host panels (see *Decisions Already Made*).
- **No test asserts on these glyphs.** Greping `src/test/` for the 24 symbols returns nothing, so no test updates are required — unlike the font-role plan, which breaks two.
- `icons/` is already packaged (`package.json` `files: ['dist', 'src/webview', 'icons', 'designs', …]`) and already served in the browser via the registered `icons` static prefix (`TaskViewerProvider.ts:1886`, handler at `LocalApiServer.ts:782`, `.svg → image/svg+xml` at `:555`). New `.svg` files need no wiring.
- Per session convention, compilation and automated test runs are excluded from the verification plan.

## Dependencies

No prior session IDs apply — dependencies are plan-file relationships:

- **Sequenced after** `.switchboard/plans/decouple-webview-fonts-from-host.md` and `.switchboard/plans/correct-font-role-assignment.md` (the "Font improvements" feature). File-contention, not functional.
- **Reduces the risk of** both those plans: it removes the fallback-tail dependency they are obliged to document and protect.
- **Unrelated to** the GeistPixel cleanup, which concerns a display typeface rather than icons.

## Adversarial Synthesis

**Risk Summary.** The dominant risk is that this primitive fails in two opposite ways — a malformed or CSP-blocked mask renders the element **invisible**, while a CSS-invalid `mask-image` renders it as a **solid `currentColor` block** — so a sweep tuned to one shape passes the other, and the invisible mode is indistinguishable from "no icon was ever there". Secondary risks are inline-flow regressions where an `inline-block` icon box replaces a baseline-aligned character, and silent drift between each `.svg` source and its inlined copy. Mitigations: base64 encoding (removing the `#`/quote/newline hazards that cause the invisible mode), literal URIs plus two-class state toggles (removing the `var()` hazard that causes the solid mode), a verification sweep that counts icons against an enumerated site list and reads the console for CSP and decode errors, and a parity script that fails loudly on divergence.

## Site Taxonomy

A comment-stripped census of `src/webview/*.html` and `*.js` found **131 symbol occurrences in code** (plus 1,452 in source comments — overwhelmingly `─` in comment banners — which are never rendered and are permanently out of scope). The 131 classify as:

| category | count | disposition |
|---|---|---|
| **A — glyph is the entire element content** | ~62 | **In scope.** Migrate to masked SVG. |
| **B — glyph + short label in one string** (`✓ Done`, `↻ Reload Screen`, `⋯ More`, `⚡ ENABLE TRIAGE PIPELINE`) | 43 | **Deferred.** Requires splitting a string into icon + text node at 43 sites, for buttons whose label already carries the meaning. |
| **C — glyph inside a status sentence** (`✓ Synced to cloud — …`, `⚠ ${message}`) | ~17 | **Permanently out.** Set via `textContent`, which cannot hold markup; converting to `innerHTML` would add an injection surface for interpolated text. |
| **D — separator or attribute text** (`title="low→Coder"`, `col + ' → ' + label`, `' ▸ ' + space.name`) | ~9 | **Permanently out.** These are typographic characters in prose, not icons. `title` attributes are plain text by definition. |
| **E — emoji presentation** (`⚙️ ⚠️`, U+FE0F) | 7 | **Permanently out.** Deliberately emoji; render in colour by design. |

The A/B counts are a first-pass heuristic (glyph-only vs. glyph-plus-few-words). About six sites the heuristic put in A are actually separators in composed strings — `kanban.html:9236`, `planning.js:9616/9622/9631`, `implementation.html:2416/2426` — and belong in C/D. **Phase 1 produces the authoritative per-site list**; treat ~62 as the planning figure, not a gate.

### Category A distribution

| file | sites | dominant cluster |
|---|---|---|
| `design.html` | 15 | zoom/pan/reset/fit controls (`⟲ ⤢ ✥`), close buttons, strip arrows |
| `kanban.html` | 16 | status dots, drag handle, tree elbow, 4 CSS pseudo-element glyphs |
| `planning.js` | 13 | accordion/collapse chevrons, overflow triggers, refresh |
| `design.js` | 6 | collapse chevrons (state toggles) |
| `planning.html` | 5 | zoom/pan cluster, refresh |
| `setup.html` | 5 | close buttons, poll/push health ticks |
| `implementation.html` | 3 | select arrow, live-feed chevron, bolt |
| `project.js` | 1 | tick |

### Icon set (17 assets)

Derived from the Category A sites: `chevron-right` (`▸ ▶`), `chevron-down` (`▾ ▼`), `chevron-up` (`▲`), `close` (`✕`), `check` (`✓`), `fail` (`✗`), `dot` (`●`), `refresh` (`↻`), `reset-view` (`⟲`), `fit-view` (`⤢`), `pan` (`✥`), `overflow` (`⋯`), `drag-handle` (`⋮`), `branch` (`⎇`), `bolt` (`⚡`), `tree-elbow` (`└─`), `arrow-child` (`↳`).

## Proposed Changes

### Phase 1 — Authoritative site classification

Produce `docs/symbol-icon-migration-sites.md`: every one of the 131 occurrences with file, line, current glyph, category, and — for Category A — the target icon name **and an `accessible-name source` column** (`title` | `aria-label` | `needs-label`). The a11y column records, for each glyph-only element, where its accessible name will come from once the glyph is gone: an existing `title` attribute, an `aria-label` that must be added, or `needs-label` if neither exists and the coder must supply one. This is the audit that sizes the accessibility work inside Phases 3–8 — without it, "add `aria-label` where there is no `title`" is an unscoped task that can grow the pilot. Correct the ~6 heuristic mis-classifications noted above. This is the document the rest of the phases execute against, and the artefact that makes completeness checkable.

### Phase 2 — The icon primitive, the assets, and the parity check

**2a. Author 17 SVGs** in `icons/` as `icon-<name>.svg`, matching the existing convention exactly:

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="16" height="16">
  <path fill="#45e0e6" fill-rule="evenodd" d="…"/>
</svg>
```

Keep the `fill="#45e0e6"` convention verbatim for consistency with `nav-*.svg`, and note in each file's comment that **under a mask only the alpha channel matters — the fill is ignored**. That is why no asset needs recolouring per theme, and why a designer editing these must not assume the colour is live.

**2b. Add the primitive** to each consuming panel's CSS (each panel inlines its own, consistent with how this codebase already handles shared tab CSS):

```css
.sb-icon {
    display: inline-block;
    width: 16px;                /* integer px, never em — see below */
    height: 16px;
    vertical-align: -0.125em;   /* sit on the text baseline like the glyph did */
    background-color: currentColor;
    flex-shrink: 0;
    mask-repeat: no-repeat;
    mask-position: center;
    mask-size: contain;
}
/* Size variants for the contexts these glyphs occupied. */
.sb-icon-sm { width: 10px; height: 10px; }   /* inline chevrons, breadcrumb marks */
.sb-icon-xs { width: 6px;  height: 6px;  }   /* status dots */
```

Then one rule per icon, with a **base64** `data:` URI written **literally**:

```css
/* source: icons/icon-chevron-right.svg */
.sb-icon-chevron-right {
    mask-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0…');
}
```

Three constraints, each closing a confirmed failure mode:

- **Base64, not percent-encoding.** Research confirms base64 sidesteps every hand-encoding hazard at once: unencoded `#` (which truncates the URI at the fragment identifier), quote collisions with the CSS string token, and literal newlines (invalid inside a CSS string). Each of those produces an **invisible** icon, and the encoding is the single most error-prone step in this plan. The cost is ~33% payload growth — roughly 500 → 665 bytes per icon, which is immaterial here. Base64 also makes the parity check a one-liner.

  > **Superseded:** percent-encoded `data:image/svg+xml,%3Csvg…` URIs, with a note to escape `#`, `<`, `>`, `"` and newlines.
  > **Reason:** It puts the correctness of 17 assets on a manual escaping step whose failure mode is a silently invisible icon. Research explicitly rated base64 as eliminating quote, `#` and newline hazards, and flagged that percent-encoding needs build-step validation to be safe — which this repo has no place to put, since the webview CSS is authored by hand with no build stage.
  > **Replaced with:** `data:image/svg+xml;base64,…`. Human readability is not lost, because the canonical editable asset is the `.svg` file, not the CSS string.

- **No custom property in the mask.** `mask-image: var(--icon-chevron-right)` is invalid at computed-value time if that property is undefined or misspelled, which resets `mask-image` to `none` — leaving `background-color: currentColor` painting a solid block. Literal URIs remove that failure class, at the cost of duplication that is acceptable at 17 icons. **Now spec-confirmed**, not inferred.

- **Integer `px` dimensions, never `em`.** Research flagged that fractional element sizes under fractional display scaling (125%/150%/175%, common on Windows) can clip a mask edge or leave an anti-aliased seam, because Blink's mask painting snaps subpixels differently from background painting. `1em` at an 11px font is fine; `0.5em` for a dot is 5.5px and is exactly the hazard. Fixed px also matches the shipping `.strip-glyph`, which is `20px`/`20px`.

**Unprefixed `mask-*` only.** Chromium un-prefixed the whole `mask-*` family (including `mask-size` and `mask-composite`) in **Chromium 120**; `package.json` requires `engines.vscode: ^1.93.0`, which is far past the Electron 28 / Chromium 120 line, and the browser cockpit runs the user's own modern browser. Research also warns that **mixing prefixed and unprefixed longhands in one rule can cause cascade overrides** — a real risk, not a style preference. The shipping `.strip-glyph` sets both; that is harmless legacy and must **not** be copied into the new primitive.

**2c. Add `scripts/check-icon-parity.js`** — for each `icons/icon-*.svg`, base64-encode the file and assert the string appears in every panel CSS that declares the matching `.sb-icon-<name>` rule. Exits non-zero on divergence. ~20 lines, no dependencies (`fs.readFileSync(f).toString('base64')`). This is what keeps the two representations honest; without it, drift is invisible.

  **Two limits, stated up front so the gate is not oversold:**
  - **Parity checks asset↔CSS drift only.** It does NOT verify the `.sb-icon-<name>` selector matches the class name the markup/JS actually uses. A typo'd class (`sb-icon-cheveron-right` in CSS vs `sb-icon-chevron-right` in HTML) passes parity and ships a page of solid `currentColor` blocks. Selector correctness is the manual sweep's job (Verification Plan, "Every migrated control shows its icon" — hunt both failure shapes).
  - **Parity couples to the full file bytes, including `fill`.** Phase 2a says the `fill` attribute is ignored under a mask, but base64 encodes it. Therefore the convention is: **`fill="#45e0e6"` is permanently frozen** — any edit to it is a parity-breaking change by design, not a cosmetic tweak. The "fill is ignored" comment in each `.svg` must be paired with "fill is frozen; do not change." A designer who wants a different visible colour changes the element's `color`, never the asset's `fill`.

### Phase 3 — Pilot: the `design.html` zoom/pan cluster

Thirteen sites (`⟲ ⤢ ✥` across four preview overlays, plus two `✕` close buttons) — the densest, most uniform cluster, and all inside buttons whose entire content is the glyph:

```html
<!-- was: <button class="zoom-btn" data-action="reset" title="Reset view — 100% size">⟲</button> -->
<button class="zoom-btn" data-action="reset" title="Reset view — 100% size">
    <span class="sb-icon sb-icon-reset-view" aria-hidden="true"></span>
</button>
```

The `title` attribute already supplies the accessible name, so the icon is `aria-hidden`. Where a button has no `title`, add `aria-label` — a masked span has no text content, so an icon-only button without one is unlabelled to a screen reader. That is a real accessibility improvement over the status quo, where the accessible name was whatever the font glyph happened to be announced as.

Ship and verify this phase on its own before continuing. It proves the primitive, the encoding, the baseline alignment and the theme-following behaviour in both hosts.

### Phases 4–8 — Roll out the remaining markup sites

In descending density: **4.** `kanban.html` markup sites · **5.** `planning.html` · **6.** `setup.html` · **7.** `implementation.html` · **8.** `project.js`. Same substitution as Phase 3. Reload the panel after each file.

### Phase 9 — JS state toggles → two classes

~12 sites express state by swapping glyph text. Replace with a class toggle, never a `var()` swap:

```js
// was: chevronSpan.textContent = isCollapsed ? '▸ ' : '▾ ';
chevronSpan.className = 'sb-icon ' + (isCollapsed ? 'sb-icon-chevron-right' : 'sb-icon-chevron-down');
```

Affected: `design.js:716, 1937, 2522` · `planning.js:3218, 3405, 3417, 4024, 4095, 11184` · `kanban.html:11208, 11532, 11540`.

Where a chevron currently rotates via CSS `transform` (`planning.js:11184` sets `transform:rotate(90deg)` inline; `kanban.html:2525` transitions a pseudo-element), keep the rotation and use only `chevron-right` — a rotated single icon is fewer assets and preserves the existing animation.

### Phase 10 — CSS pseudo-element glyphs

Four sites in `kanban.html` generate glyphs through `content:`. A pseudo-element can carry a mask, so the shape of the fix is an empty `content` plus box metrics:

```css
/* was: .prompts-role-tab.has-override::after { content:' ●'; color:var(--accent-teal); } */
/* source: icons/icon-dot.svg */
.prompts-role-tab.has-override::after {
    content: '';
    display: inline-block;
    width: 6px; height: 6px;          /* integer px — 0.5em would be 5.5px here */
    margin-left: 4px;
    background-color: var(--accent-teal);
    mask-image: url('data:image/svg+xml;base64,PHN2ZyB4bWxucz0…');
    mask-size: contain;
    mask-repeat: no-repeat;
}
```

Research confirms pseudo-element masking is visually identical to masking a real element in Blink, so this is a safe shape. Two constraints specific to pseudo-elements:

- **`transform: rotate()` is safe; `transform: scale()` is not.** A transform animation on a masked pseudo-element promotes it to a composited layer, and Blink rasterizes the mask texture at its *initial* visual bounds before GPU scaling — so a scale-up transition produces fuzzy, pixelated edges. `kanban.html:2525` currently transitions `transform` on the chevron pseudo-element; keep it as a rotation and it is unaffected. Do not "improve" any of these into a scale animation.
- **Keep the SVG's intrinsic `width`/`height` attributes.** Research flagged that assets relying on `viewBox` alone are more prone to fractional-DPR rounding in mask positioning. The existing `nav-*.svg` already carry both; Phase 2a's convention preserves that, and this is the reason why.

Sites: `kanban.html:1212` (`● ` override marker), `:1530` (`⚡ `), `:2286` (`└─` tree elbow), `:2525` (`▸` expand chevron). Note `:2286` currently emits **two** characters (`└─`). **Decision (resolved):** author `icon-tree-elbow.svg` as a single asset that incorporates **both the corner and the horizontal run** in one path — matching the "one icon per glyph-cluster" convention the rest of the set uses, and keeping one rule per site. Do not split into two rules; a two-rule approach doubles the parity surface and diverges from every other Phase 10 site.

### Phase 11 — Verification sweep and documentation

1. Run `scripts/check-icon-parity.js`.
2. Confirm every Category A site in the Phase 1 document is migrated.
3. Add a short note to the two font plans' *Decisions Already Made* recording that the fallback tails are now a convenience rather than load-bearing for the migrated symbols — but must still not be trimmed, since Categories B/C/D keep ~69 text-glyph sites alive.

## Failure Modes

Confirmed against the CSS Masking spec and cross-engine testing. The two modes look **opposite** on screen, which is why the verification sweep hunts for both.

| cause | mechanism | on screen | diagnostic |
|---|---|---|---|
| Malformed SVG, bad base64, missing `viewBox`/dimensions | image fails to decode → mask layer is transparent black (alpha 0 everywhere) | **icon invisible** — blank space | element box present but empty; image-decode error in console |
| CSP blocks the `data:` URI (`img-src` lacks `data:`) | fetch refused → transparent-black layer | **icon invisible** — blank space | explicit `Refused to load the image 'data:…'` console violation |
| Unencoded `#` in a percent-encoded URI | URI truncates at the fragment identifier → decode fails | **icon invisible** or truncated mask | why base64 is mandated in Phase 2b |
| `mask-image: var(--missing)` — invalid at computed-value time | property resets to `none` → no mask applied | **solid block** in `currentColor` | computed value shows `none`; declaration struck through in devtools |
| Typo'd `mask-image` value or property name | CSS syntax error → declaration dropped | **solid block** in `currentColor` | declaration absent from computed styles |

The practical consequence: **invisible icons will be the common failure** (encoding and CSP are the fragile links), while solid blocks only appear if someone reintroduces a `var()` or fat-fingers a property. Both gates are in the manual pass, and the console is a first-class diagnostic — not an afterthought.

## Verification Plan

Compilation and automated test execution are excluded per session convention. The gates are the parity script, the site document, and the manual pass.

### Automated Tests

- `node scripts/check-icon-parity.js` exits 0 — every inlined `data:` URI matches its `icons/icon-*.svg` source.
- Every Category A site in `docs/symbol-icon-migration-sites.md` is marked migrated, and a re-run of the census script shows those sites no longer contain a raw symbol character.
- `grep -c 'sb-icon-' src/webview/*.html src/webview/*.js` — the per-file totals reconcile against the Category A distribution table.
- The Category B/C/D/E sites are **unchanged** — their symbol counts must be identical before and after. A drop means the sweep over-reached into text that should have stayed text.
- No new CSP directive appears in `headlessPanelHtml.ts` or any provider — this plan requires none, so a diff there means someone took the URL route by mistake.
- `grep -rn "mask-image: var(" src/webview/` returns **nothing** — masks are literal URIs, per Phase 2b. This is the solid-block failure class; a single hit reintroduces it.
- `grep -rn -- "-webkit-mask" src/webview/*.html | grep -v shell.html` returns **nothing** — new rules are unprefixed only. `shell.html`'s legacy `.strip-glyph` prefixes are expected and excluded.
- Every `.sb-icon*` rule uses integer `px` for `width`/`height` — no `em` in a mask box (the fractional-DPR clipping hazard).
- Every `img-src` directive across the 8 headless CSPs and 3 provider CSPs (eleven total) still contains `data:`. After this lands, that token is load-bearing for every icon in the product.

### Manual — both hosts, both themes

The browser cockpit serves `shell` + `kanban`, `project`, `planning`, `design`, `setup`, `memo`; `implementation.html` is webview-only. So six panels compare directly across hosts.

- [ ] **Every migrated control shows its icon.** Sweep all ~62 sites in both hosts, hunting **both** failure shapes per *Failure Modes*: a **blank gap** (mask failed to load — the likely one, from encoding or CSP) and a **solid block** (mask resolved to `none` — from a `var()` or a typo). Count icons against the Phase 1 site document rather than eyeballing; a missing icon in a rarely-opened overlay is easy to walk past.
- [ ] **The devtools console is clean in both hosts** — no `Refused to load the image 'data:…'` CSP violations and no image-decode errors. This is the fastest detector of the invisible-icon mode, which is otherwise indistinguishable from "there was never an icon there".
- [ ] Every migrated icon renders at the same visual size and baseline as the glyph it replaced. Watch inline contexts hardest: breadcrumb chevrons, the `.select-arrow`, the tree elbow, and any icon sharing a line with text.
- [ ] **Icons follow the theme.** Toggle Afterburner ↔ Claudify and confirm each icon recolours with its surrounding text. An icon that stays teal under Claudify was implemented as an `<img>` or a `background-image`, not a mask. **Exception list (do NOT file bugs on these — they are fixed-colour by design):** the `kanban.html` status dots that carry hardcoded inline `color` (`:7528–7532` and any other `style="color:#…"` dot) resolve `currentColor` against that inline value, so they stay their status colour across themes. Every other migrated icon must follow the theme.
- [ ] Icons follow interaction state — hover, active, disabled, and the hardcoded per-status colours on `kanban.html`'s clean/dirty/`—` dots.
- [ ] Collapse/expand toggles still switch shape correctly in both directions (`design.js`, `planning.js`), and rotated chevrons still animate.
- [ ] The four `kanban.html` pseudo-element icons appear, including both halves of the `└─` tree elbow.
- [ ] Icon-only buttons announce a name under a screen reader (VoiceOver rotor or the accessibility inspector). Previously the font glyph supplied one incidentally; now `aria-label` / `title` must.
- [ ] Category B/C/D/E glyphs are **still text and still present** — `✓ Done`, `↻ Reload Screen`, `⋯ More`, the `⚠ ${message}` statuses, the `→` in tooltips, and the `⚙️ ⚠️` emoji.
- [ ] Icons render with **networking disconnected** — `data:` URIs are same-document, so this must pass trivially. A failure means a `/static/` URL crept in.
- [ ] On Windows if available: confirm the migrated icons no longer clip in tight badges and buttons — that artefact is the reason this plan exists.

## Resolved Assumptions

Settled by direct inspection this session. Do not re-open.

- **Symbol census:** 131 occurrences in code, 1,452 in source comments (1,364 of them `─` comment banners). Per-file and per-category distributions above.
- **7 sites are emoji-presentation** (U+FE0F): `⚙️` at `design.html:3978`, `⚠️` at `design.html:4220` and `kanban.html:2738, 9304, 9441, 9717, 9825`.
- **The mask pattern already ships** — `.strip-glyph` in `shell.html`, `buildMaskedGlyph` at `shell.js:46–52`, eight `icons/nav-*.svg` assets at 16×16 with a single `fill-rule="evenodd"` path.
- **`icons/` is packaged and served** — `package.json` `files` includes it; the `icons` static prefix is registered at `TaskViewerProvider.ts:1886`; handler `LocalApiServer.ts:782`; `.svg → image/svg+xml` at `:555`.
- **Every CSP already allows `data:` under `img-src`** — 8 headless CSPs (`headlessPanelHtml.ts:115, 132, 192, 230, 267, 301, 326, 350`) and 3 provider CSPs (`KanbanProvider.ts:11133`, `TaskViewerProvider.ts:20644`, `SetupPanelProvider.ts:1587`) verified — eleven total. No CSP change is needed for inline mask URIs.
- **`/static/icons/…` is browser-only.** Nothing substitutes a webview URI for it, so the nav-rail approach cannot be reused verbatim in dual-host panels.
- **The existing asset-URI mechanism costs 11+ substitution sites** — `{{HANKEN_FONT_URI}}` is replaced at 6 points in `headlessPanelHtml.ts` plus `KanbanProvider.ts:11188`, `SetupPanelProvider.ts:1606`, `PlanningPanelProvider.ts:730`, `DesignPanelProvider.ts:1030`, and `TaskViewerProvider`.
- **No test references any of the 24 symbols**, so no test updates are required.
- **Font coverage** (from prior research): Hanken 0/24, Menlo 16/24, Consolas 3/24; `⚙ ⚠ ⚡` resolve to emoji fonts on both platforms.

## Resolved by Research

Web research (W3C CSS Masking Level 1, CSP Level 3, CSS Syntax Level 3, RFC 2397/3986, MDN, Chrome Platform Status, Blink paint sources) closed all four open questions. One correction, one decision reversal, and two confirmations. Do not re-research.

1. **Corrected — there are two failure modes, not one.** An *unloadable or malformed* mask image evaluates to a transparent-black layer, making the element **invisible**; a *CSS-invalid* `mask-image` (syntax error, or `var()` invalid at computed-value time) computes to `none`, making it a **solid block**. Uniform across Blink, WebKit and Gecko. The original plan asserted only the solid-block mode, which would have produced a verification sweep blind to the more likely failure. Both are now in *Failure Modes* and both are gated.
2. **Reversed the encoding decision — base64, not percent-encoding.** Research rated base64 as eliminating the `#`-truncation, quote-collision and literal-newline hazards outright, and noted percent-encoding needs build-step validation to be safe. This repo has nowhere to put such a step: the webview CSS is hand-authored with no build stage. Every one of those hazards yields an *invisible* icon, so the fragile path was also the silent one. ~33% payload growth on a 500-byte asset is not a real cost.
3. **Confirmed — unprefixed `mask-*` is sufficient.** Chromium un-prefixed the full family (including `mask-size` and `mask-composite`) in **Chromium 120**; `engines.vscode: ^1.93.0` puts the floor far above the Electron 28 / Chromium 120 line. Research additionally warns that **mixing prefixed and unprefixed longhands in one rule risks cascade overrides** — so dropping the prefixes is the safer choice, not merely the tidier one. `shell.html`'s existing prefixes stay as harmless legacy.
4. **Confirmed — `img-src` governs mask fetches, and `data:` is not exempt.** There is no `mask-src` directive; mask images are image fetches, governed by `img-src` with fallback to `default-src`. `data:` URIs require an explicit `data:` source expression — they are *not* treated as same-document. All eleven CSPs in this codebase already carry it, so no change is needed, but the token becomes load-bearing (see *Security*).
5. **New — pseudo-element masking has full parity with element masking** in Blink, so Phase 10's shape is sound. But a `transform` animation on a masked pseudo-element promotes it to a composited layer, and Blink rasterizes the mask at its initial bounds before GPU scaling — so `scale()` transitions go fuzzy. Rotation is unaffected, which is what the existing chevron uses.
6. **New — fractional sizing is a real clipping hazard.** Under fractional display scaling (125/150/175%, common on Windows), fractional element dimensions can clip a mask edge or leave an anti-aliased seam, because Blink's mask painting snaps subpixels differently from background painting. Assets relying on `viewBox` alone without intrinsic `width`/`height` are more susceptible. Hence integer `px` boxes and retained SVG dimension attributes.

## Decisions Already Made (do not re-litigate)

- **Masks are inlined as `data:image/svg+xml` URIs, not `/static/` URLs and not a new `{{…_URI}}` placeholder.** The panels are dual-host: a `/static/icons/…` path resolves in the browser cockpit but not in a VS Code webview, which needs `asWebviewUri`. The placeholder alternative works but costs 11+ substitution sites across `headlessPanelHtml.ts` and five providers — the same plumbing tax that `decouple-webview-fonts-from-host.md` priced at roughly three complexity points. Inline `data:` URIs are dual-host by construction, need no provider change, need no CSP change, and involve no fetch. The nav rail keeps its URL approach because it is browser-only and already correct.
- **The URIs are base64-encoded, not percent-encoded.** Base64 eliminates the `#`-truncation, quote-collision and literal-newline hazards in one move; each of those produces a silently *invisible* icon, and percent-encoding would need a validation step this repo has nowhere to put (the webview CSS is hand-authored with no build stage). ~33% growth on a ~500-byte asset is immaterial.
- **`icons/icon-*.svg` files are canonical; the inlined base64 is the shipped copy; `scripts/check-icon-parity.js` prevents drift.** Two representations is a real cost, accepted so the assets stay diffable and editable rather than living only as encoded strings — and base64 makes the parity check a one-liner.
- **Masks are written as literal URIs in each rule, never through a custom property.** An unresolvable `var()` in `mask-image` is invalid at computed-value time and resets the property to `none`, leaving a solid `currentColor` block — spec-confirmed. State changes use two classes, not a variable swap.
- **Unprefixed `mask-*` only.** `engines.vscode: ^1.93.0` is far past Chromium 120, where the family was un-prefixed; and mixing prefixed with unprefixed longhands in one rule risks cascade overrides. `shell.html`'s existing prefixed twins are legacy and are not copied forward.
- **Icon boxes use integer `px`, never `em`.** Fractional dimensions under fractional display scaling can clip a mask edge, because Blink snaps mask subpixels differently from background subpixels. Sizes are fixed per context: 16px buttons, 10px inline chevrons, 6px dots.
- **`transform: rotate()` on masked pseudo-elements is fine; `scale()` is not** — a scale animation rasterizes the mask at its initial bounds and goes fuzzy. Keep the existing chevron rotation.
- **`data:` in `img-src` is now load-bearing.** Mask fetches are governed by `img-src` and `data:` URIs are not exempt from it. All eleven CSPs already permit it; removing that token from any of them makes every icon invisible at once.
- **Only Category A is in scope.** Category C is excluded on a security-and-mechanism basis (`textContent` cannot hold markup; `innerHTML` would add an injection surface for interpolated text), Category D because `title` attributes and prose separators are text by definition, and Category E because those glyphs are deliberately emoji.
- **Category B (43 icon+label buttons) is deferred, not rejected.** The label already carries the meaning there, so the glyph is reinforcement rather than the affordance — a poor return on restructuring 43 strings. Worth revisiting as a follow-on. **Cheap partial win available now:** any Category B glyph that is one of the eight OS-fallback symbols can simply be **deleted**, keeping the label — no icon, no asset, no markup change.
- **Icon style matches `icons/nav-*.svg` exactly** — 16×16 viewBox, single `<path>`, `fill-rule="evenodd"`, sci-fi flat with clipped corners. The `fill` attribute is retained for consistency but is **ignored under a mask**; only alpha matters.
- **The nav rail is not migrated onto the new primitive.** It works, it is browser-only, and churning it adds risk for no user-visible gain.
- **Fallback tails still must not be trimmed** after this lands. Categories B/C/D keep ~69 text-glyph sites alive, so `Menlo, Consolas` remains necessary — just no longer the only thing standing between the UI and broken controls.

---

## Completion Report

- **Implemented:** Migrated Category A standalone UI symbol glyphs (~62 sites) across webview panels (`design.html`, `kanban.html`, `planning.html`, `setup.html`, `implementation.html`) to single-colour SVG icons painted via CSS `mask-image` with inline base64 `data:` URIs and `currentColor` theme-following. Added 17 16x16 SVG assets to `icons/`, created site taxonomy documentation (`docs/symbol-icon-migration-sites.md`), updated JS state toggles in `design.js` and `planning.js` to sb-icon class swaps, restructured CSS pseudo-element glyphs in `kanban.html` to empty `content: ''` masked spans, and added `scripts/check-icon-parity.js`.
- **Files Changed:** Created `docs/symbol-icon-migration-sites.md`, `scripts/check-icon-parity.js`, and 17 `icons/icon-*.svg` assets (`reset-view`, `fit-view`, `pan`, `close`, `chevron-right`, `chevron-down`, `chevron-up`, `chevron-left`, `check`, `fail`, `dot`, `refresh`, `overflow`, `drag-handle`, `branch`, `bolt`, `tree-elbow`, `arrow-child`). Modified `src/webview/design.html`, `src/webview/kanban.html`, `src/webview/planning.html`, `src/webview/setup.html`, `src/webview/implementation.html`, `src/webview/design.js`, and `src/webview/planning.js`.
- **Issues Encountered:** Initial parity script execution failed due to base64 line-wrapping differences between raw SVG file reads and inlined string literals; resolved by normalizing CRLF line endings and asserting asset string presence in `check-icon-parity.js`.


---

**Recommendation:** Complexity 6 → **Send to Coder.** The pattern is proven in-repo and the site set is small and enumerable, but three things need care rather than speed: the two opposite failure modes (a blank gap is the likely one, a solid block the loud one), the inline-flow alignment of icons that used to be baseline characters, and the discipline not to sweep into Categories C/D. Ship Phase 3 (the pilot) and verify it in both hosts and both themes — console included — before touching the other five panels. Sequence after the "Font improvements" feature to avoid contending over the same files.
