# Visual Theme Differences — Audit & Standardization Backlog

**Status:** Analysis complete · decisions in progress (see Decisions Log) · standardization not yet started
**Last updated:** 2026-06-25
**Scope:** The three Switchboard webview themes — **Afterburner**, **Claudify**, **Afterburner Professional**
**Source of truth:** `src/webview/*.html`, `src/webview/shared-tabs.css`, `src/services/themeBodyClass.ts`, `package.json`. (`dist/` is intentionally excluded — `src/` is canonical.)

> **Why this document exists.** The three themes are not three independent stylesheets. They are **one base layer plus body-class overrides**, implemented separately inside each webview file. Most of what visually separates them lives in *rules gated on the body class* — CRT scanlines, card backgrounds, immersive grids, heading fonts — **not** in the `--accent-*` variable blocks. Because each panel re-implements the theme, the same theme drifts panel-to-panel. This document inventories every difference, separates the **intentional identity** of each theme from **needless drift/bugs**, and lists the open decisions needed before a standardization plan is written.

---

## 0. Decisions log (living)

Recorded as they are made. IDs are referenced throughout the backlog (§5) and open-decisions (§6).

> **Global principle (stated by the user):** every decision here applies across the themes, per-panel. A value living in only one theme today still gets standardized. Do not re-scope decisions per theme.

> **Target model (D13):** the theme list collapses from three to **two** — a single cyan **Afterburner** (Afterburner + Pro merged) and **Claudify** (terracotta). Sections §1–§4 below describe the *current 3-theme implementation* (the starting point for the work); the **Decisions Log here is the target spec**. The body sections get reconciled to the 2-theme model when the implementation plan is written.

| # | Topic | Decision | Status |
| :--- | :--- | :--- | :--- |
| **D1** | Kanban card background | **All three themes use black/grey cards.** The teal-tinted Afterburner card is being *removed* — "the black cards just look better," so Afterburner base adopts the black card too. | ✅ Decided |
| **D2** | Panel coverage — `setup.html` | The immersive/grid treatment is **meant to apply to `setup.html`** (like planning/design/project). It currently **misses the base grid** that Claudify and Pro have. Bring `setup.html` to parity across all themes. | ✅ Decided |
| **D3** | Panel coverage — `implementation.html` | **Intentionally excluded** from the immersive/grid/scanline treatment. Leave plain. | ✅ Decided |
| **D4** | Clone strategy (planning/design/project) | **Keep as parallel files.** A shared partial was attempted before and caused many bugs. Reconcile *values* across the files, but do not extract a partial. | ✅ Decided |
| **D5** | `package.json` theme descriptions | **Deferred** — don't touch until the CSS changes are done, then re-derive descriptions from the final CSS. | ⏸ Deferred |
| **D6** | Base drift — non-border remainder | ✅ **Leave as-is — none are bugs.** The per-panel `--panel-bg2` (`#0a0a0a`/`#050505`), ground bg (`#1a1a1a`/`#000`/`#0d0d0d`, incl. the `--bg-color`/`--kanban-bg` naming split), and `--accent-teal-bright` declaration placement are intentional/acceptable. No changes. | ✅ Decided |
| **D7** | Border standard — hue & brightness | ✅ **Neutral + dim — borders never introduce colour.** All themes use neutral, dim grey borders; the brighter warm-brown borders of Claudify/Pro read as "too grid-like." **Implementation shape:** keep the `--border-color` and `--border-bright` declarations in every theme block — **no deleting or consolidating CSS** — only change Claudify's warm browns (`#38332E`/`#5C544A`) to the neutral greys. Pro inherits Claudify's neutral values exactly as it does today. Exact neutral value → **D6**. | ✅ Decided |
| **D8** | Muted text colour (`--text-secondary`) | **Standardize to `#8C8C8C` across all themes/panels.** Afterburner runs darker (`#777777` on implementation/setup, `#888888` elsewhere) and reads as low-contrast; Claudify/Pro are already `#8C8C8C`. Raise Afterburner to match. User-observed legibility issue. | ✅ Decided |
| **D9** | Per-panel border values — **all three themes** | Borders neutral/dim (D7); per-panel values are **kept** as intentional distinctions and applied identically across Afterburner, Claudify and Pro. **`--border-color`** = `#222222` on **implementation** (the sidebar — deliberately darker than the board), `#333333` everywhere else (**setup** corrected `#222`→`#333`). **`--border-bright`** = `#555555` on **kanban** (kept), `#444444` everywhere else (kept). Claudify/Pro drop the warm browns and use these same neutral per-panel values. Keep all declarations. | ✅ Decided |
| **D10** | Afterburner Pro H1 heading | ⊘ **Moot — superseded by D13.** Afterburner Pro is merged away; the merged Afterburner uses Hanken / no-glow / white H1. | ⊘ Closed |
| **D11** | Fix `implementation.html` animations | ✅ **In scope — must fix** (user observed the success-button glow / status-dot pulse disappear). **Root cause:** commit `6e9e08c` renamed `@keyframes success-glow` → `pulse-green`, colliding with the existing `pulse-green` (overriding it) and leaving `.action-btn.success` referencing the now-gone `success-glow`. **Fix:** rename the line-1046 keyframe back to `success-glow` (fixes both at once); drop the redundant `animation:` at line 1096. | ✅ Decided |
| **D12** | Claudify refinements (from prototype) | ✅ Decided. **H1** unchanged (GeistPixel · terracotta). **H2–H6:** font Poppins→**Hanken**, colour cream→**terracotta `#D97757`**. **Flat surface:** warm `#1F1C1A`→**neutral `#1C1C1C`**. **Background grid:** terracotta→**grey**. Net: terracotta becomes a text/accent colour only — Claudify's chrome (surface + grid) goes neutral/grey, no warm tint. *Side effect:* Poppins is no longer used by Claudify. | ✅ Decided |
| **D14** | Tab navigation | ✅ Decided. **Afterburner:** keep the active-tab background glow (`.cyber-theme-enabled .shared-tab-btn.active` box-shadow, `shared-tabs.css:55–57`) + glassmorphic bar — no change. **Claudify:** tabs must be **invisible rectangles** (black-on-black) showing only text — terracotta on the active tab, grey on the rest. Today the active tab carries `background: var(--panel-bg2)` (`#0a0a0a`) over a `var(--panel-bg)` `#000` bar → the faint grey rectangle. **Fix:** add a Claudify override so the active tab's `background` (and `border-bottom-color`) match the bar (`var(--panel-bg)` / transparent); Claudify currently overrides only `border-color` (`shared-tabs.css:68`), not the fill. | ✅ Decided |
| **D13** | Merge Afterburner + Afterburner Pro → one cyan theme | ✅ Decided. Collapse to a single **Afterburner** (cyan); **remove** the `afterburner-professional` enum value + its body-class path (clean break — unreleased, no migration). **Spec:** Headings **Hanken, no glow** — H1 white, H2–H6 cyan. **Scanlines + glass always on**; **CRT sweep** stays user-toggleable via the existing setup setting (`disableCyberAnimation`). **Surface = glass retained** (prototype "Glass on"): translucent + blurred panes stay over the existing cool-neutral `#101414` ground; only the **ambient grid goes grey** (cyan pulled out of the background). The solid neutral `#1C1C1C` surface is Claudify's glass-off look, *not* Afterburner's. **Cyan glow retained on accent elements** (kanban column plan numbers/badges, selected cards) — only *headings* lose their glow. Theme list becomes **two**: Afterburner (cyan) + Claudify (terracotta). **Supersedes D10** and the Pro-Poppins item. | ✅ Decided |

> **D1 sub-detail (resolved 2026-06-25):** Afterburner's card body goes black with **no resting teal left edge** (remove the `border-left` stripe), but **keeps its cyan hover bloom and selected glow**. Net: all three themes share the black card body; Afterburner alone still lights up on hover/select — consistent with the glows-on-for-Afterburner rule.

---

## 1. Architecture — how a theme becomes a set of rules

### 1.1 Theme → body class mapping

Resolved in `src/services/themeBodyClass.ts:44–60`:

| `switchboard.theme.name` | Body class(es) applied |
| :--- | :--- |
| `afterburner` (default) | `cyber-theme-enabled` (+ `cyber-animation-disabled` if `theme.disableCyberAnimation`) |
| `claudify` | `theme-claudify` (+ `kanban-icons-colour` when colour icons enabled) |
| `afterburner-professional` | `theme-claudify theme-afterburner-pro` (+ `kanban-icons-colour`) |

`getEffectiveColourKanbanIcons()` (`themeBodyClass.ts:31–42`) defaults **on** for Claudify and Pro, **off** for Afterburner; overridable via `switchboard.theme.colourKanbanIcons` (workspace > global > theme default).

### 1.2 The three inheritance rules that explain everything

1. **`.cyber-theme-enabled` rules reach Afterburner ONLY.** Pro does *not* carry this class, so it never receives scanlines, immersive grids, glassmorphism, tab glow, or the GeistPixel display-heading treatment.
2. **`body.theme-claudify` rules reach BOTH Claudify and Pro.** Pro carries `theme-claudify`, so it inherits Claudify's grey cards, killed glows, warm borders, flat tabs, and Poppins sub-headings.
3. **`body.theme-afterburner-pro` rules reach Pro ONLY**, and exist only to repaint the accent cyan (+ a small number of H1/icon-flash overrides).

> **Key consequence:** *Afterburner Professional = Claudify's entire structure with the accent repainted cyan.* Anything Claudify sets that Pro doesn't explicitly re-override is inherited verbatim. This is the single most important fact for the standardization work, and the source of several bugs below.

### 1.3 Relevant settings

| Setting | Type | Effect |
| :--- | :--- | :--- |
| `switchboard.theme.name` | enum | Selects the theme (`package.json:690–705`). |
| `switchboard.theme.disableCyberAnimation` | bool | Adds `cyber-animation-disabled`; freezes the scanline sweep (Afterburner only). |
| `switchboard.theme.colourKanbanIcons` | bool | Kanban icons render in colour at rest instead of grey-with-click-flash (Claudify/Pro only). |

---

## 2. Defining differences (intentional identity)

These differences *should* exist — they are each theme's reason for being. Mechanism and owning body class noted.

| Dimension | Afterburner | Claudify | Afterburner Pro |
| :--- | :--- | :--- | :--- |
| **Accent** | `#00e5ff` cyan | `#D97757` terracotta | `#00e5ff` cyan |
| **Accent bright** | `#5ce8e6` | `#E2A188` | `#5ce8e6` |
| **Neon glows** (`--glow-*`) | On | Killed (`none` + rule-level `box-shadow:none`) | Killed (inherited from Claudify) |
| **CRT scanlines + sweep** | Yes — *planning/design/project only* | No | No (not `cyber-theme-enabled`) |
| **Immersive grid bg + glassmorphism** | Yes — accent grid + backdrop-blur | Flat — **neutral `#1C1C1C`** surface + **grey grid**, no blur (D12) | No (inherits Claudify's flat surface) |
| **Kanban cards** | Black/grey gradient; keeps cyan hover bloom + selected glow; no teal left edge (D1) | Black/grey gradient, no glow | Black/grey gradient (inherited), cyan select border |
| **Heading H1** (preview panels) | GeistPixel · default white | GeistPixel · terracotta `#D97757` | GeistPixel · cyan `#00e5ff` |
| **Heading H2–H6** (preview panels) | GeistPixel · cyan | **Hanken · terracotta `#D97757`** (D12) | Poppins · warm cream (intentional — GeistPixel needs a glow; D10 covers H1) |
| **Kanban icons at rest** | Cyan PNGs | Flat grey, terracotta click-flash | Flat grey, cyan click-flash |
| **Tab bar (active)** | Cyan glow + backdrop-blur (kept) | Invisible tab rectangles — bg matches bar, terracotta text (D14) | Grey, flat (inherited) |

### 2.1 The card model (verified)

The base `.kanban-card` rule is teal **by construction** and is *not* theme-gated (`kanban.html:921–933`):

```css
.kanban-card {
    background: linear-gradient(180deg,
        color-mix(in srgb, var(--accent-teal) 12%, var(--panel-bg2)) 0%,
        color-mix(in srgb, var(--accent-teal)  4%, var(--panel-bg))  100%);
    border-left: 3px solid var(--accent-teal-dim);   /* persistent teal edge */
}
```

- **Afterburner** → `--accent-teal` is cyan → teal cards, teal hover bloom (`kanban.html:939–946`), teal selected glow (`kanban.html:1395–1400`).
- **Claudify** *replaces* the whole background with a grey gradient (`kanban.html:203–232`): `color-mix(in srgb, #ffffff 5%, var(--panel-bg2))`, `border: var(--border-color)`, `box-shadow: none`. Selected border = terracotta (`var(--accent-primary)`). Feature cards get a `#7c3aed` purple edge.
- **Afterburner Pro** carries `theme-claudify`, so it matches the *same* grey override → grey cards too, with the selected border repainted cyan.

This is why "Afterburner = teal cards, the other two = black."

> **Decision (D1):** the teal card is being *removed*, not preserved — black cards look better, so Afterburner base adopts the black card and all three themes share it. This drops "cards" from the list of intended differences. See backlog §5 and the Decisions log.

### 2.2 The CRT / scanline mechanism (planning · design · project only)

```css
.cyber-theme-enabled .cyber-scanlines { display: block; }   /* repeating 2px/4px line texture, z-index 5 */
.cyber-theme-enabled:not(.cyber-animation-disabled) .cyber-scanlines::before {
    /* 80px accent-tinted gradient beam, z-index 6 */
    animation: scanline-sweep 8s linear infinite;            /* translateY(-80px) → 100vh */
}
@media (prefers-reduced-motion: reduce) { /* sweep disabled */ }
```

Plus the immersive surface: `body.cyber-theme-enabled` paints a `#101414` ground with a 40px accent grid at 4%; panes get `rgba(10,10,10,…)` fills with `backdrop-filter: blur()`; preview panes get an 8% accent grid + blur; `.planning-card`, modals, buttons and scrollbars get accent-tinted borders and glows. **None of this exists in `kanban.html`, `implementation.html`, or `setup.html`.**

---

## 3. Panel coverage matrix — the inconsistency engine

Each theme is implemented independently per webview file, so its experience changes by panel. This is where most "needless difference" originates.

| Panel | CRT scanlines + sweep | Immersive grid / glass | Display heading fonts | Claudify structure override | Minor cyber glow (tab/strip) |
| :--- | :---: | :---: | :---: | :---: | :---: |
| `planning.html` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `design.html` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `project.html` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `kanban.html` | — | — | — | ✓ (full card system) | partial (strip + tab glow) |
| `setup.html` | — | — | — | partial (labels, mode-btn, tabs) | partial (tab glow + blur) |
| `implementation.html` | — | — | — | ✓ (btn shadow + animation kills) | — (no cyber rules; glow via base vars only) |

**Reading this table:** Afterburner's signature look (scanlines, immersive grid, pixel headings) only exists in three of six panels. In `implementation.html` there are *no* `.cyber-theme-enabled` rules at all — its "Afterburner look" is just the base rules using cyan variables, which Claudify then strips via `box-shadow:none`/`animation:none`.

> **Decisions (D2 / D3):** the immersive/grid treatment is **meant** to apply to `setup.html` but **not** `implementation.html`. So this gap is *partly intended and partly a defect*:
> - `setup.html` currently **misses** the treatment it should have — including the base grid that Claudify and Pro carry on planning/design/project. **Fix:** bring `setup.html` to parity with the planning/design/project family across all three themes.
> - `implementation.html` is **correctly** plain — leave it.
> - `kanban.html` coverage is **not yet decided** (it's the card board, a different surface — TBD).

---

## 4. Per-theme variable reference (verified values)

### 4.1 Claudify variable block, by panel

| Variable | kanban | implementation | planning / design | setup |
| :--- | :--- | :--- | :--- | :--- |
| `--accent-primary` / `--accent-teal` | `#D97757` | `#D97757` | `#D97757` | `#D97757` |
| `--accent-teal-bright` | `#E2A188` | `#E2A188` | `#E2A188` | `#E2A188` |
| `--accent-neon` | — | — | `#D97757` | — |
| `--text-secondary` | `#8C8C8C` | `#8C8C8C` | `#8C8C8C` | `#8C8C8C` |
| `--text-primary` | `#E0E0E0` ¹ | `#E0E0E0` ¹ | `#E0E0E0` ¹ | `#E0E0E0` ¹ |
| **`--border-color`** | **`#333333`** ² | `#38332E` | `#38332E` | `#38332E` |
| **`--border-bright`** | **`#555555`** ² | `#5C544A` | `#5C544A` | `#5C544A` |
| Glows killed | `--glow-teal` | teal, cyan, green, red, green-btn | `--glow-teal` (+`--accent-neon`) | green, red ³ |

¹ Equals base `#e0e0e0` (case-only diff) → no-op redeclaration.
² Grey, and equal to the base values → both a no-op **and** the outlier vs. the warm browns used everywhere else.
³ `setup.html`'s base `:root` defines no `--glow-teal`, so omitting it is correct, not a bug.

### 4.2 Base Afterburner (`:root`) drift across panels

| Variable | kanban | planning / design | implementation / setup |
| :--- | :--- | :--- | :--- |
| `--border-color` | `#333333` | `#333333` | `#222222` |
| `--border-bright` | `#555555` | `#444444` | `#444444` |
| `--panel-bg2` | `#0a0a0a` | `#0a0a0a` | `#050505` |
| `--text-secondary` | `#888888` | `#888888` | `#777777` |
| `--accent-teal-bright` (@ `:root`) | *unset* | `#5ce8e6` | *unset* |
| ground bg | `#1a1a1a` | `#000000` (`--kanban-bg`) | `#0d0d0d` |

Two "families" exist (board-like vs. dense-panel), plus kanban alone at `--border-bright:#555555`, plus `--accent-teal-bright` only declared at `:root` in planning/design.

> **Decision (D8):** `--text-secondary` is standardized to `#8C8C8C` across all themes/panels — Afterburner's darker `#777777`/`#888888` is raised to match Claudify/Pro (already `#8C8C8C`). Fixes the legibility complaint and removes one drift axis. Once `:root` is `#8C8C8C`, the Claudify/Pro redeclarations of the same value become no-ops (like `--text-primary`). The *remaining* drift variables stay under D6.

> **Decision (D9):** border values are **kept** as intentional per-panel distinctions, applied across **all three themes**: `--border-color` = `#222222` on implementation (sidebar), `#333333` elsewhere (**setup** corrected `#222`→`#333`); `--border-bright` = `#555555` on kanban (kept), `#444444` elsewhere (kept). The *only* border-value change is setup's `--border-color`; everything else is a hue change (Claudify/Pro warm→neutral) holding the same per-panel values.

> **Decision (D6):** the remaining non-border drift (`--panel-bg2`, ground bg + its `--bg-color`/`--kanban-bg` naming, `--accent-teal-bright` placement) is **not buggy** — intentional/acceptable, left as-is.

---

## 5. Needless differences, drift & bugs (the standardization backlog)

Severity-tagged. None of these are part of any theme's intended identity. Items resolved in the Decisions log (§0) are marked ✅.

### ✅ DECIDED — Standardize all kanban cards to black (remove the teal Afterburner card)
- **Where:** base `.kanban-card` (`kanban.html:921–933`), hover (`939–946`), selected (`1395–1400`); Claudify override (`203–232`).
- **Decision (D1):** black/grey cards look better; Afterburner base adopts them. Remove the teal-tinted base gradient **and** the teal left edge (`border-left: …--accent-teal-dim`) so all three themes share the black card body.
- **Resolved (2026-06-25):** Afterburner **keeps** its cyan **hover bloom + selected glow**; only the resting teal chrome (fill + left edge) is removed. Claudify/Pro stay glow-free, so the card now follows the same glows-on/off split as the rest of each theme.

### ✅ DECIDED — `setup.html` is missing the immersive/base-grid treatment
- **Where:** `setup.html` — no `.cyber-theme-enabled` scanline/grid rules; no Claudify/Pro `#…-content` grid background.
- **Decision (D2 / D3):** the treatment is meant for `setup.html` (like planning/design/project) but not `implementation.html`. Bring `setup.html` to parity across all themes — Afterburner scanlines + accent grid + glass; Claudify/Pro solid `#1F1C1A` grid. Leave `implementation.html` plain.

### ✅ DECIDED — Standardize muted text (`--text-secondary`) to `#8C8C8C`
- **Where:** base `:root --text-secondary` in `kanban.html` / `planning.html` / `design.html` (`#888888`) and `implementation.html` / `setup.html` (`#777777`).
- **Decision (D8):** raise Afterburner to `#8C8C8C` to match Claudify/Pro everywhere. Fixes the user-observed low-contrast grey text (worst on implementation & setup) and removes one axis of the base-Afterburner drift (D6).

### ✅ INTENTIONAL — Afterburner Pro headings use Poppins (with one open call: H1)
- **Where:** `planning.html:2376–2387` (and equivalents in `design.html`, `project.html`).
- **What:** Pro's H2–H6 render in Poppins + warm-cream `#F0EBE6` (inherited via `theme-claudify`; Pro only overrides H1 colour to cyan).
- **Not a bug — deliberate:** GeistPixel only looks good *with* a glow. Pro has no glow, so Poppins H2–H6 is the intended treatment (same reason Claudify uses Poppins). This does mean the `package.json` "GeistPixel headings" copy is wrong for Pro → handled under **D5**.
- **Open (D10):** Pro's **H1** is GeistPixel + cyan/blue and reads weaker than Afterburner's white+glow or Claudify's orange. Candidate: switch Pro's H1 to Poppins as well. Undecided.

### 🐞 BUG — `implementation.html` animation defects (verified)
- **Duplicate `@keyframes pulse-green`** (lines **568** and **1046**) — two *different* animations share one name: #568 is a breathing pulse (`opacity` + `scale` + green glow), #1046 a one-shot box-shadow ring. CSS resolves a keyframe name to the **last** definition globally, so #1046 silently replaces #568 everywhere — the status dot's intended breathing pulse is dead code and it gets the ring instead.
- **Undefined `@keyframes success-glow`** — `.action-btn.success` (line **1093**) declares `animation: success-glow …` at lines **1096** *and* **1099**, but `success-glow` is never defined (only `spin`, `pulse-green`, `sweep`, `error-shake` exist). The rule also has two `animation:` properties, so #1099 overrides #1096. Net: the green success *glow* never plays; only the `sweep` shimmer runs.
- **Theme relevance:** both run under Afterburner/Pro only (Claudify kills them via `animation: none`, line 88). Theme-agnostic; surfaced during the sweep.
- **Root cause (git):** commit `6e9e08c` ("notebook lm and redesign") **renamed `@keyframes success-glow` → `pulse-green`**. That one rename (a) collided with the pre-existing `pulse-green` breathing pulse (line 568) — the later definition silently overrode it — and (b) left `.action-btn.success` pointing at the now-removed `success-glow`. Single root cause, both symptoms.
- **Decision (D11) — in scope, must fix. Fix:** rename the line-1046 keyframe back to `@keyframes success-glow`. This un-collides `pulse-green` (restores the status-dot + secondary-button breathing pulse) *and* makes `.action-btn.success`'s `success-glow` reference resolve (restores the success glow). Also drop the redundant `animation:` at line 1096 (keep line 1099, which carries `success-glow, sweep`).

### ⚠ INCONSISTENCY — kanban's Claudify borders are grey, not warm
- **Where:** `kanban.html:42–43`.
- **What:** Claudify on kanban uses `--border-color:#333333` / `--border-bright:#555555` (the cool base greys). Every other panel uses warm `#38332E` / `#5C544A`. These two kanban lines *also* just restate the base values, so they are simultaneously a no-op and the odd one out.
- **Resolved (D7/D9):** kanban's grey borders (`#333333`/`#555555`) are the *intended* neutral per-panel values — kept, no change. Declarations stay.

### ⚠ INCONSISTENCY — Afterburner Pro inherits Claudify's warm-brown borders
- **What:** Pro never re-sets `--border-color`/`--border-bright`, so a cyan theme gets terracotta-brown borders on 4 panels — and grey borders on kanban (because kanban's Claudify is grey). A cyan "professional" surface arguably wants neutral/cool borders.
- **Resolved (D7/D9):** Claudify's warm browns change to the neutral per-panel values (impl `#222`/`#444`, kanban `#333`/`#555`, others `#333`/`#444`); Pro inherits. Applies across all three themes. Keep declarations.

### ✅ RESOLVED — base Afterburner per-panel drift
- **What:** See §4.2. Settled: `--text-secondary` (D8), borders (D7 + D9 — per-panel values kept across all themes; only setup's `--border-color` `#222`→`#333`).
- **`--panel-bg2`, ground bg, `--accent-teal-bright` placement (D6):** confirmed **not bugs** — intentional/acceptable, left as-is. No changes.

### ⚠ INCONSISTENCY — `package.json` descriptions don't match the CSS
- **Where:** `package.json:697–700`.
- **What:** Afterburner is described as "Hanken Grotesk" but its headings render in GeistPixel (Hanken is the *body* font). Claudify is described as "Poppins headings" but its H1 is GeistPixel — only H2–H6 are Poppins.
- **Status:** **Deferred (D5)** — do not touch until the CSS changes are complete, then re-derive the descriptions from the final CSS.

### 🧹 TIDY-UP — redundant redeclarations
- `--text-primary:#E0E0E0` is re-declared in all five Claudify blocks but equals the base `#e0e0e0`. No-op everywhere. Zero-risk removal.

### 🧹 TIDY-UP — `planning.html` ↔ `design.html` clone divergence
- `design.html` is a superset of `planning.html`; their shared rules are hand-maintained in parallel and have already diverged (e.g. `.ticket-status-light` appears in planning's Claudify glow-removal but not design's). `project.html` is a third member of this family.
- **Decision (D4):** **keep them as parallel files** — a shared partial was attempted before and caused many bugs. Reconcile the *values* across all three files, but do **not** extract a shared partial.

---

## 6. Open decisions (still needed before a standardization plan)

**All decisions are resolved** — see the **Decisions Log (§0).** The merged-Afterburner surface (D13) is settled as **glass-retained**: the content/preview pane keeps its translucent glass + blur (the prototype's "Glass on" state) over the existing cool-neutral `#101414` ground, with a grey grid and ambient cyan removed. The solid neutral `#1C1C1C` surface belongs to Claudify (glass-off) only.

(Earlier open items are closed — **D6**: leave base drift as-is; **D7**: neutral/dim borders; **D10**: moot under the merge.)

**Next step:** turn D1–D13 into a sequenced implementation plan (the body sections §1–§4 also get reconciled from the 3-theme to the 2-theme model at that point).

---

## 7. File index

| File | Role in theming |
| :--- | :--- |
| `src/services/themeBodyClass.ts` | Resolves theme → body classes; first-paint injection; icon-colour default. |
| `src/webview/kanban.html` | Full card system; Claudify icon filters; minor cyber glow. No scanlines/fonts. |
| `src/webview/implementation.html` | Variable blocks + Claudify box-shadow/animation kills. No cyber rules. |
| `src/webview/planning.html` | Full immersive treatment: scanlines, grid, glassmorphism, GeistPixel/Poppins headings. |
| `src/webview/design.html` | Superset clone of planning. |
| `src/webview/project.html` | Third member of the planning/design family. |
| `src/webview/setup.html` | Variable blocks + label/tab tweaks + tab-bar blur. No scanlines/fonts. |
| `src/webview/shared-tabs.css` | Shared tab styling; cyber tab glow + Claudify grey tabs. |
| `package.json` | `theme.name` enum + enumDescriptions; `disableCyberAnimation`; `colourKanbanIcons`. |

---

*Verification note:* the layering model, card model, panel coverage, font split, and the Pro heading bug were read directly from source. The per-file rule-level inventory was swept file-by-file; spot-check any individual `file:line` before editing, as line numbers move with the working tree.
