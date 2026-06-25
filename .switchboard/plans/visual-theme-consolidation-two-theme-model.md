# Consolidate Switchboard Visual Themes: Merge Afterburner Professional into Afterburner and Refine Claudify

## Goal

Collapse Switchboard's three webview themes into **two** and standardize the drift that accumulated from per-panel re-implementation, per the fully-resolved decision set **D1–D14** in `docs/visual_theme_differences_audit.md` (that audit is the source of truth; this plan sequences its execution).

**Core problem / background.** The themes (Afterburner, Claudify, Afterburner Professional) are not independent stylesheets — they are one base `:root` layer plus body-class overrides, re-inlined across **seven** webview files. This produced: (a) two near-identical cyan themes (Afterburner and Pro), (b) value drift of the *same* theme between panels, (c) redundant declarations, and (d) two latent animation defects.

**Root causes.**
1. **Afterburner Professional = Claudify structure + cyan repaint.** Pro's body class is `theme-claudify theme-afterburner-pro`, so it inherits every Claudify rule and only re-overrides the accent. It is therefore redundant as a separate theme — the user's decision is to merge it into Afterburner (D13).
2. **Per-panel re-inlining** caused `--text-secondary`, border, and grid-opacity drift across files.
3. **Commit `6e9e08c`** renamed `@keyframes success-glow` → `pulse-green`, colliding with an existing `pulse-green` (silently overriding it) and leaving `.action-btn.success` referencing a now-missing keyframe — killing the status-dot pulse and success-button glow (D11).

**Target state.** Two themes — **Afterburner** (cyan, immersive: scanlines + glass always on, CRT sweep toggleable) and **Claudify** (terracotta accent on a neutral/grey-grid flat surface).

**Clean break — no migration.** The theme system is **unreleased dev work** (confirmed: no installs have the theme options yet; see memory `switchboard-dev-only-no-migrations`). The `afterburner-professional` enum value and its body-class path can be removed outright — no import-before-delete, no `*.migrated.bak`, no compat shim.

**Current baseline (prior art — verified against the kanban DB).** Today's 3-theme code is the result of several already-implemented plans, not a fresh design:
- `consolidate-afterburner-theme.md` (**Completed**) already reduced the system to two themes once and introduced the `--accent-primary` / `--display-font` variable conventions and bundled **Hanken + Poppins** woff2 fonts.
- `add-afterburner-professional-theme.md` (**CODE REVIEWED**) then *re-added* the third theme (Afterburner Professional). **Phase 1 of this plan effectively reverses that.**
- `claudify-warm-obsidian-theme-*` (**CODE REVIEWED**) gave Claudify its own warm `#1F1C1A` surfaces — which is why Phase 3 neutralizes them.
- The implemented `…afterburner-tab-bar-lighter-grey-background` plan fixed **Afterburner's** tab nav; D14 here addresses **Claudify's** tabs (different theme — not a duplicate).

Implications for execution: **leverage the existing `--accent-primary` / `--display-font` variables** (do not re-introduce them); the fonts are already bundled (so Poppins removal in Phase 3 means deleting `@font-face` + the bundled woff2 if confirmed unused).

## Metadata
**Tags:** frontend, ui, refactor, bugfix
**Complexity:** 7

## User Review Required

None. Every visual decision is pre-resolved in the D1–D14 Decisions Log of `docs/visual_theme_differences_audit.md` and must not be re-litigated. Specific neutral values to apply (already decided, listed here so the implementer does not re-decide them): body grid `rgba(255,255,255,0.04)`, preview-pane grid `rgba(255,255,255,0.08)`, Claudify grid `rgba(255,255,255,0.05)`, Claudify surface `#1C1C1C`, muted text `#8C8C8C`, terracotta `#D97757`. The only judgement call left to the implementer is the one flagged in the Edge-Case audit (line-885 secondary-button animation), and the audit already states the intended outcome there.

## Complexity Audit

### Routine
- The bulk of the work is **value swaps** in inline CSS (colours, opacities, font stacks) — mechanical and low-risk per edit.
- `package.json` enum/description edits are trivial config changes.
- The `themeBodyClass.ts` edits delete two well-isolated branches.
- Poppins removal is a delete after a grep-confirmed no-references check.

### Complex / Risky
- **Breadth, not depth.** ~9 files touched (6 HTML + shared-tabs.css + themeBodyClass.ts + 3 JS handlers + package.json), with the *same* logical change re-applied per panel. The risk is **omission/drift** — missing one panel's `theme-afterburner-pro` block or one heading-glow rule — not algorithmic difficulty. Mitigation: work the exit-check greps in Phase 1, and verify panel-by-panel.
- **Phase ordering is load-bearing.** Phase 1 (delete Pro) must precede every other phase or later edits will touch rules about to be deleted.
- **The animation rename (Phase 6) has a non-obvious side effect** on a second consumer (`.secondary-btn.success.feedback`, `implementation.html:885`) — see Edge-Case audit. This is the single subtle correctness risk in the plan.
- **No automated test coverage** for webview CSS — verification is manual via an installed VSIX.

## Edge-Case & Dependency Audit

**Race Conditions** — None. All changes are static CSS / config / first-paint body-class resolution. The only dynamic path (`handleThemeChanged` in the JS handlers) is edited only to *remove* the dead `afterburner-pro` branch; no new async ordering is introduced.

**Security** — None. No data flow, no user input, no eval, no network. Pure presentation.

**Side Effects** — ⚠ **The Phase 6 keyframe rename changes a second, un-named-in-the-original-plan consumer.** Verified in source:
- `.status-dot.green-pulse` (`implementation.html:554`) → `animation: pulse-green 2s infinite ease-in-out`.
- `.secondary-btn.success.feedback` (`implementation.html:885`) → `animation: pulse-green 1.2s ease-out, sweep 1s ease-out`.
- `.action-btn.success` (`implementation.html:1093/1096/1099`) → `animation: success-glow …` (currently **undefined**).
- Two `@keyframes pulse-green` exist: line **568** (breathing pulse: opacity+scale+green glow, the intended status-dot animation) and line **1046** (one-shot box-shadow ring, originally `success-glow`). CSS resolves a duplicate keyframe name to the **last** definition globally, so today *both* line 554 and line 885 silently get the line-1046 ring, and `success-glow` resolves to nothing.
- After Phase 6 renames the line-1046 keyframe back to `success-glow`: `pulse-green` resolves only to line 568, so **line 554 AND line 885 both switch to the breathing-pulse keyframe**, and `.action-btn.success` (line 1099) gets its ring back. Per D11 this is the **intended** outcome ("restores the status-dot + secondary-button breathing pulse"). The plan's Phase 6 originally named only lines 1046 and 1096; line 885 is now called out explicitly so the implementer does not treat its changed rendering as a regression. **Do not** "fix" line 885 by pointing it at `success-glow` unless the user explicitly says the secondary button should ring rather than breathe — D11 wants it breathing.

**Dependencies & Conflicts** — `planning.html`, `design.html`, `project.html` are parallel clones (D4) that have already hand-diverged (e.g. `.ticket-status-light`); apply each value change to all three and diff them after. `shared-tabs.css` is shared across panels — the Claudify tab override (Phase 3.4) must not regress the Afterburner `.cyber-theme-enabled .shared-tab-btn.active` glow (lines 55–57). The `getEffectiveColourKanbanIcons()` default (`themeBodyClass.ts:31–42`) currently keys off `afterburner-professional` — it must drop that case when the branch is removed, or Claudify's icon-colour default is unaffected but a dead string lingers.

## Dependencies

None blocking. This plan **supersedes** prior theme plans (`add-afterburner-professional-theme.md`, `claudify-warm-obsidian-theme-*`) and builds on the completed `consolidate-afterburner-theme.md` (variable conventions + bundled fonts). The authoritative input is `docs/visual_theme_differences_audit.md` (D1–D14), not a prior session. No `sess_*` hand-off required.

## Adversarial Synthesis

Key risks: (1) **omission drift** — the same delete/value-swap is repeated across ~9 files, so the failure mode is missing a panel, not getting the logic wrong (mitigated by the Phase 1 exit-check greps and panel-by-panel re-test); (2) **the Phase 6 keyframe rename silently re-targets a second consumer** at `implementation.html:885`, whose post-rename behavior (breathing pulse) is intended per D11 but was unstated — now explicitly documented; (3) **phase ordering is load-bearing** — Phase 1 must run first or later edits touch soon-deleted Pro rules. Mitigations: grep-gated exit checks, manual VSIX verification of each theme on each panel, and an explicit Poppins-unused grep before deletion.

---

## Proposed Changes

> The work is sequenced as seven phases. Phase ordering is a hard constraint (see Risks). Per-file inline CSS is edited *in place* across the parallel clones — **no shared partial** (D4). Value changes only; keep all variable *declarations* (the user explicitly rejected "simplify/reduce CSS").

### Ground rules / constraints

- `src/` is the source of truth. **`dist/` is irrelevant** — do not audit or rebuild it except when producing a release VSIX.
- **Keep `planning.html` / `design.html` / `project.html` as parallel files (D4).** A shared partial was attempted before and caused many bugs. Reconcile values *in place* across all three; do **not** extract a shared partial or otherwise consolidate the CSS structure.
- Keep all explicit CSS variable declarations — these changes are **value** changes, not declaration removals (the user explicitly rejected "simplify/reduce CSS").
- No confirmation dialogs (project rule) — not applicable to this work, noted for completeness.

### Affected files

- `package.json` — `switchboard.theme.name` enum + enumDescriptions (`package.json:690–705`).
- `src/services/themeBodyClass.ts` — theme → body-class resolution (`getThemeBodyClass()` line 44–60; `getEffectiveColourKanbanIcons()` line 31–42).
- `src/webview/kanban.html`, `implementation.html`, `planning.html`, `design.html`, `project.html`, `setup.html` — inline theme CSS.
- `src/webview/shared-tabs.css` — shared tab styling.
- `src/webview/planning.js`, `design.js`, `project.js` (and the setup.html inline handler) — `handleThemeChanged` body-class toggling.

### Phase 1 — Merge Afterburner Professional into Afterburner (D13, foundational)

Do this first so later phases never touch soon-deleted Pro rules.

1. **`package.json`** — remove `afterburner-professional` from the `switchboard.theme.name` `enum` (`package.json:695`) and its matching `enumDescriptions` entry (`package.json:697–700`). Leave `afterburner` and `claudify`. (Descriptions get re-derived in Phase 7.)
2. **`themeBodyClass.ts`** — delete the `afterburner-professional` branch in `getThemeBodyClass()` (lines 56–58). Result: `afterburner` → `cyber-theme-enabled` (+ `cyber-animation-disabled` when set); `claudify` → `theme-claudify` (+ `kanban-icons-colour`). Also revisit `getEffectiveColourKanbanIcons()` (line 41) — drop the `|| theme === 'afterburner-professional'` case.
3. **All theme-class JS handlers** (`handleThemeChanged` in `planning.js`, `design.js`, `project.js`; the setup.html message handler): remove `theme-afterburner-pro` from the managed-class lists and delete the `afterburner-professional` branch.
4. **All inline CSS** (kanban, implementation, planning, design, project, setup): delete every `body.theme-afterburner-pro { … }` variable block and every `body.theme-afterburner-pro …` rule (worktree button, icon-flash, H1 colour, kanban-icons-colour variants, etc.). These existed only to re-paint Pro cyan; with Pro gone they are dead.

**Exit check:** `grep -rn "afterburner-pro\|afterburner-professional" src/ package.json` returns **zero** matches; only two selectable themes remain.

### Phase 2 — Restyle the merged Afterburner (D13)

Applies to the immersive panels (`planning`, `design`, `project`) plus shared rules.

1. **Headings → Hanken, no glow.** In the `body.cyber-theme-enabled #markdown-preview h1…h6` rules (`planning.html:1058–1073` and clone equivalents), replace the GeistPixel display-font stack with the Hanken body stack (drop `--display-font`, `--display-letter-spacing`, `--display-font-stretch` from headings). Remove the heading glow rules (`.cyber-theme-enabled .preview-panel-wrapper h1/h2/h3…` `text-shadow`, `planning.html:2104–2112` and clone equivalents). Set **H1 white**, **H2–H6 cyan** (`var(--accent-primary)`).
2. **Ambient grid → grey.** Change the cyber body grid (`body.cyber-theme-enabled` background-image, ~4% accent) and the cyber preview-pane grid (~8% accent) from `color-mix(… var(--accent-primary) …)` to a **neutral grey** at the same opacities (`rgba(255,255,255,0.04)` body / `0.08` pane). Keep the `#101414` ground and the glass/blur + scanlines.
3. **Keep cyan glow on accent elements** — leave intact the `.cyber-theme-enabled` glows on kanban column badges/plan numbers, selected cards/tree nodes, strip buttons, etc. Only *headings* lose their glow.
4. **CRT sweep** — no change; the `cyber-animation-disabled` setup toggle stays.

### Phase 3 — Refine Claudify (D12 + D14)

1. **Headings** (planning/design/project `body.theme-claudify` heading rules): **H1 unchanged** (GeistPixel · terracotta). **H2–H6**: font Poppins → **Hanken**; colour cream `#F0EBE6` → **terracotta `#D97757`**.
2. **Flat surface** — change the Claudify `#…content` / `#preview-pane` `background-color` from warm `#1F1C1A` to **neutral `#1C1C1C`**.
3. **Background grid → grey** — change the Claudify grid from `color-mix(… var(--accent-primary) 5% …)` to neutral grey (`rgba(255,255,255,0.05)`).
4. **Tabs (D14)** — in `shared-tabs.css`, add a Claudify override so the **active** tab's `background` and `border-bottom-color` match the bar (`var(--panel-bg)` / transparent), eliminating the faint `var(--panel-bg2)` `#0a0a0a` rectangle. Today Claudify overrides only `border-color` (`shared-tabs.css:68`), not the fill. Keep terracotta active text + grey inactive text. (Afterburner's `.cyber-theme-enabled .shared-tab-btn.active` glow at `shared-tabs.css:55–57` stays untouched.)
5. **Poppins** — now unused by Claudify (its only other user was Pro, removed in Phase 1). Grep `src/` to confirm no remaining `'Poppins'` usage in webview CSS, then remove the Poppins `@font-face` blocks and font URIs from `planning.html`/`design.html`/`project.html`. **Note (verified):** `Poppins` also appears in `src/services/DesignPanelProvider.ts` and `src/services/PlanningPanelProvider.ts` — inspect those references before deleting any shared `@font-face`/woff2 asset; if a provider still emits or references Poppins, leave the bundled font in place and note where. Only delete the woff2 asset if **all** references are gone.

### Phase 4 — Cross-cutting standardizations (D8, D7/D9, D1)

1. **Muted text (D8)** — set base `:root --text-secondary` to `#8C8C8C` in all six panels (from `#888888` in kanban/planning/design/project and `#777777` in implementation/setup). Claudify already uses `#8C8C8C`.
2. **Borders (D7/D9)** — neutral, dim, per-panel values kept, applied across both themes; change Claudify's warm `--border-color`/`--border-bright` to the neutral per-panel values:
   - `--border-color`: `#222222` on **implementation** (sidebar — intentionally darker, D9), `#333333` everywhere else. **setup** base moves `#222222` → `#333333`.
   - `--border-bright`: `#555555` on **kanban** (kept), `#444444` everywhere else.
   - Keep all declarations — value changes only.
3. **Kanban cards black (D1)** — change base `.kanban-card` (`kanban.html:921`) from the teal-tinted gradient to the dark/grey gradient; **remove the teal `border-left` edge** (`border-left: 3px solid var(--accent-teal-dim)`). **Keep** the cyan hover bloom (`kanban.html:939–946`) and selected glow (`kanban.html:1395–1400`) — Afterburner alone still lights up on interaction.
4. **Tidy (optional)** — drop the redundant `--text-primary: #E0E0E0` redeclarations (identical to base `#e0e0e0`).

### Phase 5 — setup.html immersive parity (D2/D3)

Bring `setup.html` up to the planning/design/project family: add the `.cyber-theme-enabled` scanline overlay + accent(now-grey) grid + glass treatment for Afterburner, and the Claudify flat-grid surface. **`implementation.html` stays plain** (intentionally excluded). (setup has no markdown-preview headings, so the heading-font work does not apply there.)

### Phase 6 — Fix implementation.html animation defects (D11)

1. Rename the second `@keyframes pulse-green` (`implementation.html:1046`) back to `@keyframes success-glow`. This de-collides `pulse-green` (restoring the status-dot/secondary-button breathing pulse from the line-568 keyframe) and makes `.action-btn.success`'s `success-glow` reference (line 1099) resolve again.
2. Remove the redundant `animation:` declaration at line **1096** (keep line **1099**, which carries `success-glow, sweep`).
3. **Verify the second consumer (clarification — see Edge-Case audit).** `.secondary-btn.success.feedback` (`implementation.html:885`) references `pulse-green`. After the rename it resolves to the line-568 **breathing pulse** instead of the line-1046 ring it currently gets. This is the **intended** D11 outcome ("secondary-button breathing pulse"). Confirm it visually during verification; do **not** redirect line 885 to `success-glow` unless the user explicitly asks for the ring.

### Phase 7 — package.json descriptions (D5)

Re-derive the `theme.name` `enumDescriptions` (`package.json:697–700`) from the final CSS:
- **Afterburner** — cyan, Hanken headings, scanline/immersive (CRT toggle).
- **Claudify** — Claude terracotta accent, Hanken headings, flat neutral surface.

---

## Verification Plan

### Automated Tests

**None apply.** The change is entirely inline webview CSS, `package.json` config, and two isolated TypeScript branch deletions. There is no automated test harness for webview presentation in this repo, and per the session directives the test suite is run separately by the user. No new automated tests are warranted (a snapshot test of inline CSS would be brittle and is not an existing pattern). Per the build note, `dist/` is **not** rebuilt or audited for this work; `src/` is canonical.

### Manual verification (build a VSIX, install, check **each theme on each panel**)

- **Afterburner:** black kanban cards with cyan hover/selected glow; headings Hanken, no glow, H1 white / H2–H6 cyan; grey ambient grid; scanlines on; CRT toggle works; column plan numbers/badges still glow cyan; tab bar keeps active glow.
- **Claudify:** H2–H6 Hanken terracotta; H1 unchanged; neutral `#1C1C1C` surface; grey grid; tabs invisible (black-on-black) with terracotta active text; neutral borders.
- **Cross-cutting:** muted text legible (`#8C8C8C`) on every panel (esp. implementation/setup); setup shows the immersive grid; implementation stays plain; implementation status-dot pulse + success-button glow both animate again; **secondary-button success feedback (`.secondary-btn.success.feedback`) animates the breathing pulse** (D11 / Phase 6.3).
- **Removal checks:** `grep -rn "afterburner-pro\|afterburner-professional" src/ package.json` → zero matches; only two themes appear in Setup and selecting them persists/repaints correctly; if Poppins was removed, `grep -rn "Poppins" src/webview` → zero matches.

## Decisions already made (do not re-litigate)

- Two-theme model; Pro removed via clean break, **no migration** (D13).
- Parallel clone files retained — **no shared partial** (D4).
- Base Afterburner `--panel-bg2` / ground / `--accent-teal-bright` drift **left as-is** — not bugs (D6).
- Border identity: **neutral + dim**, per-panel values kept (D7/D9).
- Afterburner card keeps glow; only resting teal chrome removed (D1).
- Secondary-button success feedback uses the breathing pulse, not the ring (D11).

## Risks / sequencing notes

- Phase 1 **must** run first so subsequent edits don't touch Pro rules that are about to be deleted.
- `shared-tabs.css` and the inline theme blocks are edited across all panels — work panel-by-panel and re-test per panel; diff the three parallel clones (`planning`/`design`/`project`) after editing to catch drift.
- Verify Poppins is truly unused (including the two `src/services/*Provider.ts` references) before removing its `@font-face` / woff2 (Phase 3.5).
- The Phase 6 rename re-targets `implementation.html:885` — intended, but verify visually (Phase 6.3).
- `dist/` staleness is **not** a concern (testing is via installed VSIX).

## Uncertain Assumptions

None requiring external research. All claims are about this repo's CSS/config and standard, well-established CSS behavior (duplicate `@keyframes` name → last definition wins globally; `color-mix`, `backdrop-filter`, `rgba` grids). Every file/line reference in this plan was spot-checked against the working tree during planning (line numbers may still shift as edits land — re-grep before editing). No third-party API, library version, or external behavior is in question, so no web research is needed.

---

**Recommendation: Send to Lead Coder** (complexity 7 — multi-file cross-cutting refactor with a clean-break enum removal, a non-obvious animation-rename side effect, and manual-only verification).

---

## Reviewer Pass (2026-06-25)

Direct in-place reviewer-executor pass. Assessed the committed implementation (commit `239a82d "many fixes"`, working tree clean) against this plan's D1–D14 end-state. Per session directives: no compilation, no automated tests, no subagents, read-only git only.

### Stage 1 — Grumpy Principal Engineer

> *Right. Seven phases, nine-ish files, the same delete-and-repaint smeared across three parallel clones that have a documented habit of drifting apart the moment you look away. This is exactly the kind of change that compiles green and ships a black-on-black tab into production because somebody edited five panels and forgot the sixth. So I went hunting for the corpse.*
>
> **The Pro carcass.** `grep -rn "afterburner-pro\|afterburner-professional" src/ package.json` — **zero**. Not one stray `theme-afterburner-pro` body block, not a limp `|| theme === 'afterburner-professional'` clinging on in `getEffectiveColourKanbanIcons()`, not a dead enum string in `package.json`. The JS handlers all collapsed to a clean `['theme-claudify', 'cyber-theme-enabled']` managed list. Fine. *Fine.* I wanted a survivor and there isn't one.
>
> **The animation landmine (Phase 6).** This was supposed to be where it all fell apart — duplicate `@keyframes pulse-green`, last-definition-wins, a second consumer at line 880 nobody named in the original plan. I counted the keyframes: **one** `pulse-green` (now line 559), the collider renamed back to `success-glow` (line 1045). `.status-dot` (545) and `.secondary-btn.success.feedback` (880) both resolve to the breathing pulse — *which is the D11 intent*, and there's a comment block at 1042–1044 admitting it on the record so the next reviewer doesn't "fix" it. `.action-btn.success` carries exactly **one** `animation: success-glow, sweep` (1097); the redundant twin from old line 1096 is gone. I hate that it's correct.
>
> **The dead-file trap (Phase 3.4).** Here's where I expected blood. `shared-tabs.css` is a *ghost* — `{{SHARED_TABS_CSS_URI}}` appears nowhere in any panel HTML, so `PlanningPanelProvider.ts:400` is shouting the URI into a void. If the Claudify tab fix lived *only* there, the `#0a0a0a` rectangle would still be sitting on every active tab in production and nobody would know. But no — the live `body.theme-claudify .shared-tab-btn.active { background: var(--panel-bg); border-bottom-color: transparent; }` is inlined in **all six** panels, and the base active rule still hands terracotta text via `color: var(--accent-teal)` → `#D97757`. They *also* edited the dead file. Belt and braces on a corpse. Wasteful, not wrong.
>
> **What I actually found**, after all that: a `var(--text-secondary, #888888)` at `kanban.html:1364` and four `var(--text-secondary, #888)` fallbacks in planning/design — stale fallbacks that never fire because the variable is *always* defined as `#8C8C8C`. Dead pixels. A **NIT**, and a pre-existing one. The optional Phase 4.4 tidy of the `--text-primary: #E0E0E0` redeclarations wasn't done — but the plan said *optional*, so I can't even be angry about it. I came for a CRITICAL and I'm leaving with lint.

### Stage 2 — Balanced synthesis

The implementation is **complete and faithful to D1–D14**. Every load-bearing risk the plan flagged was handled correctly:

- **Keep** (verified, no action): clean-break Pro removal (Phase 1 exit-check zero); Afterburner headings Hanken/no-glow with H1 white + H2–H6 `--accent-primary`, accent-element glows preserved (Phase 2); Claudify H1 GeistPixel/terracotta + H2–H6 Hanken/terracotta, `#1C1C1C` surface, `0.05` grid, **live inline** tab fix (Phase 3); cross-cutting `#8C8C8C` / border / black-card values (Phase 4); setup immersive parity with the `.cyber-scanlines` element actually present (Phase 5); the animation de-collision (Phase 6); enumDescriptions (Phase 7).
- **Fix now:** nothing. No CRITICAL or MAJOR findings.
- **Defer / leave:** the dead `#888`/`#888888` `--text-secondary` fallbacks (NIT, never render, pre-existing); can ride along with any future tab-CSS touch.

### Follow-up tidy (applied after the review, on user request)

The optional **Phase 4.4** tidy was performed: removed the redundant `--text-primary: #E0E0E0;` redeclaration from the `body.theme-claudify` block in all 6 panels (`kanban`, `implementation`, `planning`, `design`, `project`, `setup`). Each was a no-op re-set of the base `:root --text-primary: #e0e0e0`; Claudify now inherits it from `:root`. Verified: exactly one `--text-primary` decl per panel, zero uppercase `#E0E0E0` left, `--text-secondary`/`--border-*` Claudify redeclarations deliberately untouched (per the "keep all declarations" rule — only the genuinely-never-themed `--text-primary` was dropped).

### Code fixes applied

**During the review pass: none** — no valid CRITICAL/MAJOR finding surfaced. **After the review (user request):** the optional Phase 4.4 `--text-primary` redeclaration tidy across all 6 panels (see above).

### Verification performed (grep/structural; compile & tests skipped per directive)

- `grep -rn "afterburner-pro\|afterburner-professional" src/ package.json` → **0 matches** (Phase 1 exit check ✓).
- `grep -rn "Poppins" src/` → **0 matches** (Phase 3.5 ✓; provider refs in `DesignPanelProvider.ts`/`PlanningPanelProvider.ts` also cleaned. Loose `Poppins-*.woff2` remain only under `designs/` — prototype dir, out of scope).
- `themeBodyClass.ts`: `getThemeBodyClass()` + `getEffectiveColourKanbanIcons()` key off `afterburner`/`claudify` only ✓.
- `--text-secondary: #8C8C8C` in all 6 panels ✓; `--border-color` (`#222222` impl / `#333333` else) + `--border-bright` (`#555555` kanban / `#444444` else) ✓.
- `.kanban-card` black/grey gradient, teal `border-left` removed, hover bloom (`kanban.html:890`) + selected glow (`1345`) intact ✓.
- Grids neutral grey across the 3 immersive clones + setup (body `0.04`, pane `0.08`, Claudify `0.05`) ✓; CRT sweep accent wash intentionally retained ✓.
- `implementation.html`: one `@keyframes pulse-green` (559), `success-glow` restored (1045), single `animation: success-glow, sweep` (1097); `.secondary-btn.success.feedback` (880) → breathing pulse (D11 intent) ✓. `implementation.html` has no `.cyber-scanlines` (stays plain) ✓.
- Phase 3.4 tab fix present in the **live inline** CSS of all 6 panels (not just the dead `shared-tabs.css`) ✓.

### Findings summary

| Severity | Finding | Location | Disposition |
| :--- | :--- | :--- | :--- |
| NIT | Stale `var(--text-secondary, #888888)` fallback (never renders; var always defined) | `kanban.html:1364` | Leave — dead, pre-existing |
| NIT | Stale `var(--text-secondary, #888)` fallbacks | `planning.html:2476,2512`; `design.html:2514,2550` | Leave — dead, pre-existing |
| NIT | Optional Phase 4.4 tidy (`--text-primary: #E0E0E0` redeclarations) | all 6 panels | **Done** — removed on user request post-review |
| OBS | Dead `shared-tabs.css` edited in parallel with live inline copies | `shared-tabs.css:67–76` | No action — harmless; defensive if ever wired up |

### Remaining risks

- **Manual-only verification.** No automated coverage for webview CSS; the per-theme/per-panel visual checks in the Verification Plan still need a VSIX install run by the user (compile & tests were skipped this pass per directive). Structural/grep verification is green; pixel-level confirmation (e.g. Claudify tab truly black-on-black, breathing pulse vs ring on the secondary button) remains a human eyeball check.
- **Drift dormant, not eliminated.** The three parallel clones were reconciled correctly *this time*, but D4 keeps them as copies — the next per-panel edit reintroduces the same omission-drift risk. Not a defect of this change.
