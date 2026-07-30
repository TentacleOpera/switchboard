# Replace UI Symbol Glyphs with Masked SVG Icons

## Goal

Stop rendering UI affordances — chevrons, close buttons, status dots, refresh arrows, zoom controls, drag handles — as Unicode font glyphs. Render them as single-colour SVGs painted with `currentColor` via CSS `mask-image`, so they are metric-independent, theme-following, and immune to font fallback entirely.

Scope is deliberately narrow: the **~62 sites where a symbol is the entire content of its element**. Symbols that sit inside sentences, status messages, tooltips, or `title` attributes stay as text — they are typography, not iconography, and SVG cannot express them.

End state: no UI control depends on a font containing a glyph. The font fallback tails become a convenience rather than a load-bearing dependency.

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
- `icons/nav-{artifacts,board,design,memo,project,setup,theme}.svg` — 16×16, single `<path fill="…" fill-rule="evenodd">`, ~400–630 bytes each

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
- Each icon is a 16×16 single-path SVG in a style already established by seven existing assets.
- No provider, CSP, packaging, or build change is required (see *Decisions Already Made*).
- No state, no async, no data path, no security surface.

### Complex / Risky

- **The failure mode is worse than the bug it fixes.** A `mask-image` that does not resolve leaves the element unmasked, so `background-color: currentColor` paints a **solid 16×16 block**. A missing font glyph is a small box in one place; a broken mask is a filled rectangle where a chevron used to be. The primitive must be designed so this cannot happen silently (Phase 2).
- **Four sites are CSS pseudo-element glyphs** (`content: '▸'`, `content: '└─'`, `content: ' ●'`, `content: '⚡ '`), which need restructuring to `content: ''` plus box metrics — a different edit shape from the markup sites.
- **~12 sites are JS state toggles** (`textContent = isCollapsed ? '▸ ' : '▾ '`). Replacing a text swap with an icon swap changes how state is expressed, and a `var()`-based swap would reintroduce the solid-square failure.
- **Two sources of truth for each asset** (the `.svg` file and its inlined `data:` URI) can drift. Mitigated by a parity check, not by discipline.
- Dual-host verification with no rendering harness, plus a theme-following check that an `<img>`-based approach would silently fail.

## Edge-Case & Dependency Audit

### Race Conditions

- None. Icons are static CSS declarations or synchronous DOM writes. No async loading (`data:` URIs are same-document, so there is no fetch, no network latency, and no flash-of-missing-icon).

### Security

- **No new surface, and one small reduction.** `data:image/svg+xml` in a CSS `mask-image` is not executable: mask images are rendered as images, so scripts, `<foreignObject>` and external references inside them do not execute. The SVGs are repo assets, not user input.
- **No CSP change required — verified.** Every CSP in the codebase already permits `data:` under `img-src`: `headlessPanelHtml.ts` lines 115, 132, 192, 230, 267, 301, 326, and providers `KanbanProvider.ts:11133`, `TaskViewerProvider.ts:20644`, `SetupPanelProvider.ts:1587`. Nothing is widened.
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

**Risk Summary.** The dominant risk is the primitive's failure mode: an unresolved `mask-image` renders a solid `currentColor` block, so a typo produces filled rectangles rather than missing icons — which is why masks are written as literal `data:` URIs in each rule instead of routed through a custom property that could be invalid at computed-value time. Secondary risks are inline-flow regressions where an `inline-block` icon box replaces a baseline-aligned character, and silent drift between each `.svg` source and its inlined copy. Mitigations: literal URIs plus two-class state toggles (no `var()` in a mask), an explicit "no solid squares" verification sweep in both hosts and both themes, and a parity script that fails loudly when a `.svg` and its inlined URI diverge.

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

Produce `docs/symbol-icon-migration-sites.md`: every one of the 131 occurrences with file, line, current glyph, category, and — for Category A — the target icon name. Correct the ~6 heuristic mis-classifications noted above. This is the document the rest of the phases execute against, and the artefact that makes completeness checkable.

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
    width: 1em;
    height: 1em;
    vertical-align: -0.125em;   /* sit on the text baseline like the glyph did */
    background-color: currentColor;
    flex-shrink: 0;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
    -webkit-mask-position: center; mask-position: center;
    -webkit-mask-size: contain;   mask-size: contain;
}
```

Then one rule per icon, with the `data:` URI written **literally**:

```css
/* source: icons/icon-chevron-right.svg */
.sb-icon-chevron-right {
    -webkit-mask-image: url('data:image/svg+xml,%3Csvg xmlns=…%3E');
            mask-image: url('data:image/svg+xml,%3Csvg xmlns=…%3E');
}
```

**Do not route the mask through a custom property.** `mask-image: var(--icon-chevron-right)` is invalid at computed-value time if the property is undefined or misspelled, which resets `mask-image` to `none` — leaving `background-color: currentColor` to paint a solid block. Literal URIs remove that failure class entirely, at the cost of duplication that is acceptable at 17 icons.

Percent-encode at minimum `#`, `<`, `>`, `"` and newlines. `#` is mandatory — an unencoded `#` truncates the URI at the fragment identifier.

**2c. Add `scripts/check-icon-parity.js`** — reads each `icons/icon-*.svg`, percent-encodes it, and asserts the result appears in every panel CSS that declares the matching `.sb-icon-<name>` rule. Exits non-zero on divergence. ~20 lines, no dependencies. This is what keeps the two sources of truth honest; without it, drift is invisible.

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
.prompts-role-tab.has-override::after {
    content: '';
    display: inline-block;
    width: 0.5em; height: 0.5em;
    margin-left: 0.35em;
    background-color: var(--accent-teal);
    -webkit-mask-image: url('data:image/svg+xml,…dot…'); mask-image: url('data:image/svg+xml,…dot…');
    -webkit-mask-size: contain; mask-size: contain;
    -webkit-mask-repeat: no-repeat; mask-repeat: no-repeat;
}
```

Sites: `kanban.html:1212` (`● ` override marker), `:1530` (`⚡ `), `:2286` (`└─` tree elbow), `:2525` (`▸` expand chevron). Note `:2286` currently emits **two** characters — the elbow icon must incorporate both the corner and the horizontal run, or the rule must keep a separate rule for the run.

### Phase 11 — Verification sweep and documentation

1. Run `scripts/check-icon-parity.js`.
2. Confirm every Category A site in the Phase 1 document is migrated.
3. Add a short note to the two font plans' *Decisions Already Made* recording that the fallback tails are now a convenience rather than load-bearing for the migrated symbols — but must still not be trimmed, since Categories B/C/D keep ~69 text-glyph sites alive.

## Verification Plan

Compilation and automated test execution are excluded per session convention. The gates are the parity script, the site document, and the manual pass.

### Automated Tests

- `node scripts/check-icon-parity.js` exits 0 — every inlined `data:` URI matches its `icons/icon-*.svg` source.
- Every Category A site in `docs/symbol-icon-migration-sites.md` is marked migrated, and a re-run of the census script shows those sites no longer contain a raw symbol character.
- `grep -c 'sb-icon-' src/webview/*.html src/webview/*.js` — the per-file totals reconcile against the Category A distribution table.
- The Category B/C/D/E sites are **unchanged** — their symbol counts must be identical before and after. A drop means the sweep over-reached into text that should have stayed text.
- No new CSP directive appears in `headlessPanelHtml.ts` or any provider — this plan requires none, so a diff there means someone took the URL route by mistake.
- `grep -rn "mask-image: var(" src/webview/` returns **nothing** — masks are literal URIs, per Phase 2b.

### Manual — both hosts, both themes

The browser cockpit serves `shell` + `kanban`, `project`, `planning`, `design`, `setup`, `memo`; `implementation.html` is webview-only. So six panels compare directly across hosts.

- [ ] **No solid squares anywhere.** This is the primary gate and the signature failure of this plan — a filled `currentColor` block where an icon should be means an unresolved mask. Sweep every migrated control in both hosts.
- [ ] Every migrated icon renders at the same visual size and baseline as the glyph it replaced. Watch inline contexts hardest: breadcrumb chevrons, the `.select-arrow`, the tree elbow, and any icon sharing a line with text.
- [ ] **Icons follow the theme.** Toggle Afterburner ↔ Claudify and confirm each icon recolours with its surrounding text. An icon that stays teal under Claudify was implemented as an `<img>` or a `background-image`, not a mask.
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
- **The mask pattern already ships** — `.strip-glyph` in `shell.html`, `buildMaskedGlyph` at `shell.js:46–52`, seven `icons/nav-*.svg` assets at 16×16 with a single `fill-rule="evenodd"` path.
- **`icons/` is packaged and served** — `package.json` `files` includes it; the `icons` static prefix is registered at `TaskViewerProvider.ts:1886`; handler `LocalApiServer.ts:782`; `.svg → image/svg+xml` at `:555`.
- **Every CSP already allows `data:` under `img-src`** — 7 headless CSPs and 3 provider CSPs verified. No CSP change is needed for inline mask URIs.
- **`/static/icons/…` is browser-only.** Nothing substitutes a webview URI for it, so the nav-rail approach cannot be reused verbatim in dual-host panels.
- **The existing asset-URI mechanism costs 11+ substitution sites** — `{{HANKEN_FONT_URI}}` is replaced at 6 points in `headlessPanelHtml.ts` plus `KanbanProvider.ts:11188`, `SetupPanelProvider.ts:1606`, `PlanningPanelProvider.ts:730`, `DesignPanelProvider.ts:1030`, and `TaskViewerProvider`.
- **No test references any of the 24 symbols**, so no test updates are required.
- **Font coverage** (from prior research): Hanken 0/24, Menlo 16/24, Consolas 3/24; `⚙ ⚠ ⚡` resolve to emoji fonts on both platforms.

## Uncertain Assumptions

External standards/engine behaviours that cannot be settled from this repository. The user has been advised to run web research to confirm them before implementation; a ready-to-run prompt was supplied in chat. Items 1 and 2 shape the primitive's design and the verification instructions, so they are worth confirming first.

1. **A `mask-image` that fails to resolve leaves the element unmasked** (painting a solid `currentColor` block) rather than fully masked (invisible). The entire "no solid squares" gate and the literal-URI decision rest on this. If the true behaviour is "invisible", the failure mode is a missing icon instead — still a bug, but it changes what the verifier looks for.
2. **Percent-encoding requirements for `data:image/svg+xml` inside a CSS `url()`** — which characters must be escaped for reliable parsing across Chromium/Electron, and whether single-quoted URIs with unencoded `<`/`>` are safe in practice.
3. **Whether `-webkit-mask-*` prefixes are still required** in the Electron/Chromium versions VS Code currently ships, or whether unprefixed `mask-*` alone suffices. The existing `.strip-glyph` sets both; this plan copies that, but the prefix may be removable.
4. **Whether CSP `img-src` governs `mask-image` fetches** (there is no `mask-src` directive). Moot while URIs are inline `data:`, but it decides whether a future move to `/static/` URLs would need a CSP change.

## Decisions Already Made (do not re-litigate)

- **Masks are inlined as `data:image/svg+xml` URIs, not `/static/` URLs and not a new `{{…_URI}}` placeholder.** The panels are dual-host: a `/static/icons/…` path resolves in the browser cockpit but not in a VS Code webview, which needs `asWebviewUri`. The placeholder alternative works but costs 11+ substitution sites across `headlessPanelHtml.ts` and five providers — the same plumbing tax that `decouple-webview-fonts-from-host.md` priced at roughly three complexity points. Inline `data:` URIs are dual-host by construction, need no provider change, need no CSP change, and involve no fetch. The nav rail keeps its URL approach because it is browser-only and already correct.
- **`icons/icon-*.svg` files are canonical; the inlined URI is the shipped copy; `scripts/check-icon-parity.js` prevents drift.** Two representations is a real cost, accepted so the assets stay diffable and editable rather than living only as percent-encoded strings.
- **Masks are written as literal URIs in each rule, never through a custom property.** An unresolvable `var()` in `mask-image` is invalid at computed-value time and resets the property to `none`, leaving a solid `currentColor` block. State changes use two classes, not a variable swap.
- **Only Category A is in scope.** Category C is excluded on a security-and-mechanism basis (`textContent` cannot hold markup; `innerHTML` would add an injection surface for interpolated text), Category D because `title` attributes and prose separators are text by definition, and Category E because those glyphs are deliberately emoji.
- **Category B (43 icon+label buttons) is deferred, not rejected.** The label already carries the meaning there, so the glyph is reinforcement rather than the affordance — a poor return on restructuring 43 strings. Worth revisiting as a follow-on. **Cheap partial win available now:** any Category B glyph that is one of the eight OS-fallback symbols can simply be **deleted**, keeping the label — no icon, no asset, no markup change.
- **Icon style matches `icons/nav-*.svg` exactly** — 16×16 viewBox, single `<path>`, `fill-rule="evenodd"`, sci-fi flat with clipped corners. The `fill` attribute is retained for consistency but is **ignored under a mask**; only alpha matters.
- **The nav rail is not migrated onto the new primitive.** It works, it is browser-only, and churning it adds risk for no user-visible gain.
- **Fallback tails still must not be trimmed** after this lands. Categories B/C/D keep ~69 text-glyph sites alive, so `Menlo, Consolas` remains necessary — just no longer the only thing standing between the UI and broken controls.

---

**Recommendation:** Complexity 6 → **Send to Coder.** The pattern is proven in-repo and the site set is small and enumerable, but three things need care rather than speed: the solid-square failure mode, the inline-flow alignment of icons that used to be baseline characters, and the discipline not to sweep into Categories C/D. Ship Phase 3 (the pilot) and verify it in both hosts and both themes before touching the other five panels. Sequence after the "Font improvements" feature to avoid contending over the same files.
