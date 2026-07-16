# Unify Markdown Previewer Styling With switchboard-site

## Goal

Make the Switchboard extension's in-panel markdown previewer (afterburner / `cyber-theme-enabled`) read like the `switchboard-site` docs pages, which the user finds far easier to read. CSS-only; no behavioural change.

### Problem analysis — verified against the actual code

The two surfaces are already much closer than a first read suggests: both use Hanken Grotesk, the same cyan accent `#00e5ff`, `#101414` as the base background, **uppercase headings, and left-bar + bottom-rule heading ornament**. The real divergences are narrow and specific:

| # | Aspect | switchboard-site (target) | Switchboard afterburner previewer | Actual delta |
| :--- | :--- | :--- | :--- | :--- |
| 1 | Preview surface | Solid `#101414` (`global.css` `--background`) | `body.cyber-theme-enabled` is **already `#101414`** (planning.html:2200), BUT the scroll panes add a **glass overlay**: `background-color: rgba(255,255,255,0.015)` + `backdrop-filter: blur(6px)` (planning.html:2248-2254, 2259-2265) | The glass film + blur lightens the preview. **Remove the glass** to expose the true `#101414`. |
| 2 | Grid | Cyan lines `rgba(0,229,255,0.03)`, 32px (`global.css` `.bg-grid`) | Grey lines — body `rgba(255,255,255,0.04)` 40px (planning.html:2204), panes `rgba(255,255,255,0.08)` 40px (2250) | Grid exists but is **grey at 40px** (cyan deliberately removed "per D13"). Site is **cyan at 32px**. See Open Decision. |
| 3 | H1 colour | Cyan (`--primary-fixed-dim`), uppercase, cyan bottom border + 3px cyan left bar (global.css:197-212) | **White `#ffffff`** (planning.html:1062 + cyber override :1080), otherwise same borders/uppercase | H1 text **white → cyan**. Everything else already matches. |
| 4 | H2 bottom border | **Grey `#1d2323`** (docs.css override) + 2px cyan left bar + uppercase | **Cyan** `accent-teal-dim` bottom border (planning.html:1112) + 2px cyan left bar + uppercase | H2 bottom border **cyan → grey**. Left bar + uppercase already match. |
| 5 | Body text | Fixed token (`--on-surface`) — does not follow the editor theme | `color: var(--vscode-editor-foreground, #cccccc)` (planning.html:1050) — **follows the user's VS Code theme** | Pin preview text to a fixed value so brightness stops tracking the VS Code theme. |
| 6 | Background sweep | Grid-lighting mask sweep: top→bottom, `ease-in-out`, **occasional** (16s cycle, ~5s crossing + ~11s rest), parks off-screen, reduced-motion gated | `.cyber-scanlines::before` CRT beam: 80px cyan band, `8s linear infinite` (constant, mechanical), over a static scanline texture (planning.html:2018-2041) | Replace the CRT beam with the site's grid-lighting sweep **over the grid that already exists** (Option A). |

### Corrections to the earlier draft of this plan (for the record)
- Headings are **uppercase on the site** and keep **left bars on both H1 and H2** — do NOT remove uppercase or the left bars. The only heading changes are H1 white→cyan and H2 bottom-rule cyan→grey.
- The afterburner body is **already `#101414`**; it only *looks* lighter because of the glass overlay. The fix is removing the glass, not changing the base background.
- The previewer **does** have a grid; the sweep can light it directly.

### Theme scope
Target the afterburner / `cyber-theme-enabled` (cyan) theme, which the site matches. Per the user: apply the **structural** changes (glass removal, text pinning, sweep) to **claudify** too. Route colour changes through `var(--accent-primary)` so claudify stays terracotta and cyan stays cyan. (Note: claudify preview panes are already flat with no glass — planning.html:2364 — so glass removal is a no-op there.)

### Scope note — duplication across webviews
The previewer CSS is duplicated in `planning.html`, `design.html`, and `project.html` (all three carry `vscode-editor-foreground` text + `:root` tokens; planning and project carry the sweep). Apply every change to all three preview-bearing webviews. A shared stylesheet is an optional follow-up (Step 6), not a prerequisite.

---

## Metadata
- **Tags:** frontend, ui, ux
- **Complexity:** 5

> **Superseded:** Complexity: 4
> **Reason:** The plan touches three webview files with three *different* selector sets for the glass panes and headings, plus a non-trivial `mask-position` sweep port into two of them. That is multi-file coordination with one moderate, well-scoped risk (the sweep port + grid-stacking moiré) — the definition of Mixed (5-6), not Low (3-4).
> **Replaced with:** Complexity: 5

---

## User Review Required

Yes — visual review in a live VS Code webview is mandatory before merge. This is a CSS-only readability change; the user (the readability arbiter) must confirm the afterburner preview now "reads like the site" and that claudify still looks correct. Specifically confirm:
- The preview surface is solid dark with no moiré / no glass film.
- Body text is the muted site value (not pure white, not tracking the editor theme).
- The sweep lights the grid in place, rests between passes, and fully stops under reduced-motion / disable toggles.
- Claudify headings remain terracotta with the pixel-font H1 intact.

---

## Complexity Audit

### Routine
- Removing the glass overlay (`background-color` + `backdrop-filter`) from the preview pane rules — value deletions, three files.
- H1 colour `#ffffff` → `var(--accent-primary)` in two rules per file (base + cyber override).
- H2 bottom border `var(--accent-teal-dim)` → `var(--doc-border)` in one rule per file.
- Pinning the single preview body-text line to `var(--doc-text)` per file.
- Adding four `--doc-*` tokens to each file's `:root`.
- Restoring the cyan body grid `rgba(0,229,255,0.03)` at 32px under `body.cyber-theme-enabled` (reversing the D13 grey-grid).

### Complex / Risky
- Porting the site's `mask-image` grid-lighting sweep into `.cyber-scanlines::before` (planning.html + project.html only): a `mask-position`-animated silver-grid reveal replacing a `transform`-animated CRT band. New animation mechanism for this codebase; `mask-position` repaints the masked layer per frame (heavier than the GPU-composited `transform` beam it replaces). Must preserve all existing gating classes verbatim.
- Three *different* pane-selector sets across the three files — missing one leaves a half-glassed preview.
- Resolving `--doc-text` to the *muted* site value (`#a0a6a6`) rather than the bright `--on-surface` (`#ffffff`); pinning to white would regress readability.

---

## Edge-Case & Dependency Audit

**Race Conditions**
- None. Pure CSS; no JS state, no async, no shared mutable data. The theme class on `document.body` is set before the webview renders and is stable for the panel lifetime.

**Security**
- None. No user input, no HTML injection surface, no external resources. CSS values are literal tokens.

**Side Effects**
- **`vscode-editor-foreground` over-replacement:** the variable appears **six times per file** (planning.html:1050,1190,1224,1252,1294,1365; design.html:1040,1193,1230,1260,1306,1384; project.html:696,748,764,780,798,827). Only the `#cccccc`-fallback occurrence (the preview-content body text) must change. The other five carry `--text-secondary` / `--text-primary` fallbacks and belong to editor panes / trees / lists that MUST keep tracking the VS Code editor theme. A blanket find-and-replace would rip theming out of the editor surface.
- **Grid stacking / moiré:** if the per-pane grey grid (`rgba(255,255,255,0.08)` 40px) is kept while the body cyan grid (`rgba(0,229,255,0.03)` 32px) is restored, the two pitches (40px vs 32px) and colours stack into a visible moiré. Resolution: panes go `transparent` with NO `background-image` — exactly one grid (the body grid) shows through.
- **`project.html` wrapper inset glow:** `project.html:635` applies `box-shadow: inset 0 0 30px color-mix(in srgb, var(--accent-teal) 6%, transparent)` to `.preview-panel-wrapper`. This is a frame glow, not glass/blur. When panes go transparent it becomes the sole frame decoration. Decision: **keep** — it is not a glass film and does not lighten the surface; it is consistent with the afterburner aesthetic.
- **Claudify H1:** `planning.html:2372-2378` sets claudify H1 to an *explicit* `#D97757` with the `GeistPixel` display font. It does NOT use `var(--accent-primary)`. Routing the cyan-theme H1 through `var(--accent-primary)` does not touch claudify H1 — claudify's explicit rule still wins and keeps its pixel font. No claudify H1 change is required or desired.
- **Claudify H2 border:** the shared H2 border rule (e.g. planning.html:1112) is inherited by claudify (claudify does not override H2 border). Changing it to `var(--doc-border)` (`#1d2323` grey) gives claudify a grey H2 rule too — neutral and consistent with the structural-changes-apply-to-claudify scope.
- **`mask-position` paint cost:** replacing a `transform`-animated beam with a `mask-position`-animated reveal moves work from the compositor to the paint stage. On a very long preview document this is a heavier per-frame paint. Mitigation: the sweep is occasional (16s cycle, ~5s active), honours `prefers-reduced-motion`, and is gated by `.cyber-animation-disabled` / `.cyber-scanlines-disabled` / `.scanlines-suppressed`. Verify on a long doc.

**Dependencies & Conflicts**
- Depends on `--accent-primary` resolving to cyan on `:root` (planning.html:46, design.html:47, project.html:30) and to terracotta under `body.theme-claudify` (planning.html:84, design.html:85, project.html:57). Verified.
- Depends on `--accent-teal-dim` being defined (`color-mix(in srgb, var(--accent-teal) 40%, transparent)`) — used by the H1/H2 left bars which are deliberately retained. Verified in all three files.
- No external dependency changes. No package additions. The `mask-image` / `-webkit-mask-image` / `mask-position` features are standard Chromium CSS, already used by the site and supported in the VS Code webview (Electron/Chromium).

---

## Dependencies
- None — CSS-only change, no prerequisite plans or sessions.

---

## Adversarial Synthesis

Key risks: (1) pinning `--doc-text` to the bright `--on-surface` (`#ffffff`) instead of the muted `--on-surface-variant` (`#a0a6a6`) would pass the "fixed value" acceptance check while regressing readability — the single most important correction; (2) keeping the per-pane grey grid alongside the restored cyan body grid produces a 32px/40px moiré that violates the "solid surface" goal; (3) three different pane-selector sets across the three files mean a prose "apply to equivalents" instruction can leave a half-glassed preview. Mitigations: resolve `--doc-text` to `#a0a6a6`, drop the per-pane grid entirely (panes `transparent`, no `background-image`), and enumerate the exact selector set + line numbers per file in Proposed Changes.

---

## Proposed Changes

### `src/webview/planning.html`

**Context:** Primary preview-bearing webview. Carries the glass panes, the heading rules, the body grid, and the CRT sweep. `:root` at line 37; claudify override block at line 81.

**Logic / Implementation:**

1. **Doc tokens** — add to `:root` (after line 78, inside the block):
   ```css
   --doc-bg: #101414;
   --doc-border: #1d2323;   /* site --outline-variant — grey H2 rule + code borders */
   --doc-text: #a0a6a6;     /* site --on-surface-variant — the muted value <p> actually renders */
   --doc-heading: var(--accent-primary);
   ```
   > **Superseded:** `--doc-text: /* site body text token */;` (unresolved placeholder)
   > **Reason:** The site's readable body text is NOT `--on-surface` (`#ffffff`). `global.css:238` sets `p { color: var(--on-surface-variant) }` = `#a0a6a6`, and `.docs-article` (docs.css:146) sets `#ffffff` only on the container — every `p` overrides it to the muted value. Pinning to `#ffffff` would make the preview brighter and *less* like the site, regressing the exact readability goal.
   > **Replaced with:** `--doc-text: #a0a6a6;` (site `--on-surface-variant`).

2. **Pin preview body text** — line 1050 only:
   `color: var(--vscode-editor-foreground, #cccccc);` → `color: var(--doc-text);`
   Do NOT touch lines 1190, 1224, 1252, 1294, 1365 (editor/tree/list text — must keep tracking the VS Code theme).

3. **H1 colour** — two edits:
   - Line 1062 (base heading rule): `color: #ffffff;` → `color: var(--doc-heading);`
   - Line 1080 (`.cyber-theme-enabled … h1` override): `color: #ffffff;` → `color: var(--doc-heading);`

4. **H2 bottom border** — line 1112: `border-bottom: 1px solid var(--accent-teal-dim);` → `border-bottom: 1px solid var(--doc-border);`
   Leave line 1113 (`border-left: 2px solid var(--accent-teal-dim)`) and line 1115 (`text-transform: uppercase`) untouched.

5. **Restore cyan body grid** — lines 2202-2206 (`body.cyber-theme-enabled`):
   ```css
   background-image:
       linear-gradient(rgba(0, 229, 255, 0.03) 1px, transparent 1px),
       linear-gradient(90deg, rgba(0, 229, 255, 0.03) 1px, transparent 1px);
   background-size: 32px 32px, 32px 32px;
   ```

6. **Remove glass + pane grid** — lines 2245-2266 (`#preview-pane`, `#preview-pane-online`, `#preview-pane-tickets`, `#kanban-preview-pane`):
   Replace each pane's `background-color` / `background-image` / `background-size` / `backdrop-filter` / `-webkit-backdrop-filter` block with:
   ```css
   background: transparent;
   ```
   > **Superseded:** "Set the pane background to `transparent` … the per-pane grey grid (0.08) can be dropped in favour of the body grid, or kept — resolve alongside the grid-colour decision."
   > **Reason:** Keeping the per-pane grey grid (40px) alongside the restored cyan body grid (32px) stacks two different pitches/colours into a moiré — the opposite of the "solid `#101414` document surface" the acceptance criteria require. "Drop or keep" was an unresolved deferral, not a decision.
   > **Replaced with:** Panes are `transparent` with NO `background-image`. Exactly one grid (the body cyan grid) shows through; the sweep has one grid to light.

7. **Sweep — replace CRT beam with grid-lighting mask sweep** — lines 2018-2041 (`.cyber-theme-enabled:not(.cyber-animation-disabled) .cyber-scanlines::before` + `@keyframes scanline-sweep`):
   Replace the 80px gradient band + `transform`-translate animation with the site's technique (ported from `switchboard-site/src/styles/global.css` `.bg-grid::after` + `@keyframes grid-sweep`):
   ```css
   .cyber-theme-enabled:not(.cyber-animation-disabled) .cyber-scanlines::before {
       content: "";
       position: absolute;
       inset: 0;
       pointer-events: none;
       background-image:
           linear-gradient(180deg, transparent, rgba(214, 232, 238, 0.02), transparent),
           linear-gradient(to right, rgba(214, 232, 238, 0.11) 1px, transparent 1px),
           linear-gradient(to bottom, rgba(214, 232, 238, 0.11) 1px, transparent 1px);
       background-size: 100% 100%, 32px 32px, 32px 32px;
       -webkit-mask-image: linear-gradient(180deg, transparent, #000 45%, #000 55%, transparent);
       mask-image: linear-gradient(180deg, transparent, #000 45%, #000 55%, transparent);
       -webkit-mask-size: 100% 40vh;
       mask-size: 100% 40vh;
       -webkit-mask-repeat: no-repeat;
       mask-repeat: no-repeat;
       -webkit-mask-position: 0 -50vh;
       mask-position: 0 -50vh;
       animation: grid-sweep 16s ease-in-out infinite;
   }
   @keyframes grid-sweep {
       0%   { mask-position: 0 -50vh; -webkit-mask-position: 0 -50vh; }
       30%  { mask-position: 0 110vh; -webkit-mask-position: 0 110vh; }
       100% { mask-position: 0 110vh; -webkit-mask-position: 0 110vh; }
   }
   ```
   The silver grid lines (`rgba(214,232,238,0.11)`) brighten in place as the mask band descends, then park off-screen for ~11s. The 32px pitch matches the restored body grid so the silver copy aligns with the cyan grid beneath it.
   > **Superseded:** "Decide whether the static scanline texture stays or the grid-lighting sweep fully replaces it."
   > **Reason:** The site keeps BOTH a static `.scanline` texture (global.css:157) and the `.bg-grid::after` sweep. The static `.cyber-scanlines` base texture (planning.html:2006-2015) is the equivalent and should be retained; only the `::before` CRT *beam* is replaced by the grid-lighting sweep. Removing the static texture would diverge from the site.
   > **Replaced with:** Keep the static `.cyber-scanlines` scanline texture; replace only the `::before` CRT beam with the `mask-image` grid-lighting sweep.

   **Preserve all existing gating verbatim:** the `@media (prefers-reduced-motion: reduce)` block (lines 2043-2050) must continue to set `animation: none; display: none;` on the `::before`; the class-based suppression rules (lines 2077-2084: `.scanlines-suppressed` and `.cyber-scanlines-disabled`) are on the parent `.cyber-scanlines` element and apply unchanged.

**Edge Cases:** the `mask-position` animation repaints the masked layer per frame (heavier than the old `transform` beam) — verify on a long preview document; gating already limits it to occasional sweeps and honours reduced-motion + both disable toggles.

---

### `src/webview/design.html`

**Context:** Second preview-bearing webview. Carries glass panes and heading rules. **Does NOT carry the sweep** — sweep changes do not apply here.

**Logic / Implementation:**

1. **Doc tokens** — add to `:root` (line 38 block), same four tokens as planning.html (`--doc-bg`, `--doc-border: #1d2323`, `--doc-text: #a0a6a6`, `--doc-heading: var(--accent-primary)`).

2. **Pin preview body text** — line 1040 only:
   `color: var(--vscode-editor-foreground, #cccccc);` → `color: var(--doc-text);`
   Do NOT touch lines 1193, 1230, 1260, 1306, 1384.

3. **H1 colour** — line 1053 (base) and line 1073 (cyber override): `color: #ffffff;` → `color: var(--doc-heading);`

4. **H2 bottom border** — line 1108: `border-bottom: 1px solid var(--accent-teal-dim);` → `border-bottom: 1px solid var(--doc-border);` (leave line 1109 left bar, 1111 uppercase).

5. **Restore cyan body grid** — find the `body.cyber-theme-enabled` background-image block (the grey 40px grid) and set it to cyan `rgba(0,229,255,0.03)` at 32px, matching planning.html.

6. **Remove glass + pane grid** — lines 2195-2217. **Note the different selector set:** `#preview-pane-html`, `#preview-pane-images`, `#preview-pane-tickets`, `#stitch-preview-pane` (2195-2206) and `#kanban-preview-pane` (2209-2217). Replace each pane's `background-color` / `background-image` / `background-size` / `backdrop-filter` / `-webkit-backdrop-filter` with `background: transparent;` (no `background-image` — single body grid only).

7. **Sweep — NONE.** design.html has no `.cyber-scanlines::before` / `scanline-sweep`. Do not invent one.

**Edge Cases:** `#stitch-preview-pane` and `#preview-pane-images` are design.html-specific selectors absent from planning.html — they must not be missed.

---

### `src/webview/project.html`

**Context:** Third preview-bearing webview. Minified-style single-line CSS. Carries glass panes, heading rules, AND the sweep. `:root` accent at line 30; claudify at line 57.

**Logic / Implementation:**

1. **Doc tokens** — add to the `:root` block, same four tokens.

2. **Pin preview body text** — line 696 only:
   `color: var(--vscode-editor-foreground, #cccccc);` → `color: var(--doc-text);`
   Do NOT touch lines 748, 764, 780, 798, 827.

3. **H1 colour** — line 702 (base) and line 709 (cyber override): `color: #ffffff;` → `color: var(--doc-heading);`

4. **H2 bottom border** — line 724: `border-bottom: 1px solid var(--accent-teal-dim);` → `border-bottom: 1px solid var(--doc-border);` (leave line 725 left bar, 727 uppercase).

5. **Restore cyan body grid** — find the `body.cyber-theme-enabled` grey 40px grid block and set cyan `rgba(0,229,255,0.03)` at 32px.

6. **Remove glass + pane grid** — lines 636-643. **Note the different selector set:** `#kanban-preview-pane`, `#features-preview-pane`, `#constitution-preview-pane`, `#tuning-preview-pane`, `#projects-preview-pane`. Replace the `background-color` / `background-image` / `background-size` / `backdrop-filter` / `-webkit-backdrop-filter` with `background: transparent;` (no `background-image`).

7. **Wrapper inset glow — KEEP.** Line 635 `.cyber-theme-enabled .preview-panel-wrapper` retains its `box-shadow: inset 0 0 30px color-mix(in srgb, var(--accent-teal) 6%, transparent)`. It is a frame glow, not glass; it does not lighten the surface. (Clarification: this is the only file with this wrapper glow; it is intentionally retained.)

8. **Sweep — replace CRT beam with grid-lighting mask sweep** — lines 580-602 (`.cyber-scanlines::before` + `@keyframes scanline-sweep`). Same replacement as planning.html Step 7 (silver grid + `mask-image` band + `grid-sweep 16s ease-in-out`). Preserve the `@media (prefers-reduced-motion: reduce)` block at line 602 and the class-based suppression rules.

**Edge Cases:** project.html's heading selectors are `#kanban-preview-content`, `#features-preview-content`, `#constitution-preview-content`, `#system-preview-content`, `#tuning-preview-content`, `#projects-preview-content` — different from planning/design's `#markdown-preview*`. The H1/H2 edits at lines 702/709/724 target these selectors; confirm the edit lands on the `*-preview-content` heading rules, not any other `#ffffff` occurrence.

---

### `src/webview/planning.html` — claudify carve-out (no edit needed, documented)

- Claudify preview panes (lines 2359-2369) are already flat `#0a0a0a` with a grey `rgba(255,255,255,0.05)` 40px grid and no glass — glass removal is a no-op.
- Claudify H1 (lines 2372-2378) is explicit `#D97757` + `GeistPixel`; it does not use `var(--accent-primary)` and is not affected by the H1 change. Keep untouched.
- **Do NOT apply the cyan grid to claudify.** The cyan-grid change is scoped to `body.cyber-theme-enabled` selectors only and must not leak into `body.theme-claudify`. Claudify keeps its existing grey grid.

---

### (Optional follow-up, not part of this plan) De-duplicate

Extract the `--doc-*` tokens + preview-content rules + sweep into one shared stylesheet linked by planning/design/project, so future style edits touch one file. Flagged because the three-way duplication is why past tweaks drifted between panels. Out of scope here; this plan stays CSS-only and per-file.

---

## Resolved decisions
- **Grid colour → cyan for the afterburner theme only.** Restore the cyan grid `rgba(0,229,255,0.03)` at 32px pitch under `body.cyber-theme-enabled` (planning.html:2204-2206), matching the site and reversing the "D13" grey-grid decision. The afterburner sweep therefore lights **cyan → silver** (as on the site). Per Step 6 the panes go transparent and inherit the single cyan body grid.
- **Do NOT apply the cyan grid to claudify.** Claudify is terracotta — a cyan grid would clash. Claudify keeps its existing grid (grey `rgba(255,255,255,0.05)`, planning.html:2367) untouched. The cyan-grid change must be scoped to `body.cyber-theme-enabled` selectors and must not leak into `body.theme-claudify`. (The structural changes — glass removal, text pinning, sweep behaviour, heading colour via the accent var — still apply to claudify; only the grid colour is carved out.)
- **`--doc-text` = `#a0a6a6`** (site `--on-surface-variant`), the muted value `<p>` actually renders — not the bright `--on-surface` (`#ffffff`).
- **Per-pane grid dropped** — panes are `transparent` with no `background-image`; one body grid only, no moiré.
- **Static scanline texture kept** — only the `::before` CRT beam is replaced by the grid-lighting sweep.
- **`project.html` wrapper inset glow kept** — frame glow, not glass.

---

## Acceptance criteria
- The afterburner preview shows the solid `#101414` surface with no glass film / blur and no moiré; it no longer looks washed-out/lighter than the site.
- Preview H1 is cyan (accent), uppercase, with the cyan bottom + 3px cyan left bar retained; H2 has a **grey** bottom rule with its 2px cyan left bar retained — matching the site.
- Preview body text renders at the fixed muted value `#a0a6a6` regardless of the user's VS Code colour theme (not pure white, not tracking the editor theme).
- The afterburner grid is cyan at 32px (lit cyan→silver by the sweep); claudify's grid stays grey and untouched.
- The sweep rests between passes, eases, parks off-screen, lights the grid in place, and honours reduced-motion + the existing disable toggles (`.cyber-animation-disabled`, `.cyber-scanlines-disabled`, `.scanlines-suppressed`).
- Applied consistently across `planning.html`, `design.html`, `project.html` using each file's actual selector sets; structural changes also apply to claudify (headings terracotta via claudify's explicit rule, pixel-font H1 intact), but the cyan grid is NOT applied to claudify.
- The five non-preview `vscode-editor-foreground` rules per file (editor/tree/list text) remain unchanged and continue to track the VS Code theme.

---

## Verification Plan

### Automated Tests
None. This is a CSS-only visual/readability change with no logic surface; automated tests would not exercise the rendering. (Compilation and automated test runs are explicitly skipped per session directives.)

### Manual Visual Verification (in a live VS Code webview)
1. **Afterburner, planning panel:** open a long markdown plan. Confirm the preview surface is solid dark `#101414` with no glass film and no 32px/40px moiré. Confirm body text is muted (`#a0a6a6`-ish), not pure white, and does NOT change when switching VS Code colour themes. Confirm H1 is cyan (uppercase, cyan bottom + 3px cyan left bar) and H2 has a grey bottom rule (2px cyan left bar, uppercase).
2. **Afterburner sweep:** confirm a silver grid-lighting band descends occasionally (~every 16s, ~5s crossing), lights the cyan grid lines in place, then parks off-screen for ~11s. Toggle the Setup "scanlines" checkbox OFF → sweep + texture disappear. Toggle OS reduced-motion → sweep stops. Confirm the static scanline texture remains when the sweep is suppressed.
3. **Afterburner, design panel:** confirm the same surface/heading/text result, including the design-specific panes (`#stitch-preview-pane`, `#preview-pane-images`, `#preview-pane-html`). Confirm there is NO sweep (design.html is sweep-exempt) and no broken/missing sweep element.
4. **Afterburner, project panel:** confirm the same result across `#kanban-preview-pane`, `#features-preview-pane`, `#constitution-preview-pane`, `#tuning-preview-pane`, `#projects-preview-pane`. Confirm the sweep runs. Confirm the `.preview-panel-wrapper` inset glow is still present as a subtle frame.
5. **Claudify theme:** switch to claudify. Confirm preview H1 is terracotta with the `GeistPixel` display font intact (not cyan, not changed). Confirm H2 has a grey bottom rule. Confirm body text is the muted pinned value. Confirm the grid is still grey (NOT cyan). Confirm glass removal was a no-op (panes were already flat).
6. **Editor surface regression check:** confirm the editor pane, tree, and list text still follow the VS Code colour theme (switch themes and watch them adapt) — proves the five non-preview `vscode-editor-foreground` rules were not touched.
7. **Long-document paint check:** open a very long preview document under afterburner and confirm the `mask-position` sweep is smooth (no jank beyond the old CRT beam).

---

## Uncertain Assumptions

No web research is required. Every factual claim in this plan was verified by reading the actual source: the three webview HTML files (`planning.html`, `design.html`, `project.html`) and the two site stylesheets (`switchboard-site/src/styles/global.css`, `docs.css`). The one value the original draft left unresolved (`--doc-text`) was resolved by tracing the site's CSS cascade (`p { color: var(--on-surface-variant) }` = `#a0a6a6`, overriding `.docs-article`'s container `#ffffff`). The `mask-image` / `mask-position` animation is standard Chromium CSS already shipped on the site and supported in the VS Code webview; it is covered by manual verification step 7 rather than research.

---

## Completion Report

Implemented the CSS-only markdown-previewer unification across all three preview-bearing webviews (`planning.html`, `design.html`, `project.html`): added `--doc-bg` / `--doc-border` / `--doc-text` / `--doc-heading` tokens to each `:root`; pinned the preview container body text and the `#markdown-preview p` / `#kanban-preview-content p` colour to `var(--doc-text)` (`#a0a6a6`); routed H1 colour through `var(--doc-heading)` (base + cyber override) so it reads cyan in afterburner and terracotta in claudify; switched the H2 bottom rule to `var(--doc-border)` (grey) while keeping the cyan left bar; restored the cyan `rgba(0,229,255,0.03)` body grid at 32px under `body.cyber-theme-enabled`; replaced the glass overlay + per-pane grey grid on every preview scroll pane with `background: transparent` (single body grid, no moiré); and ported the site's `mask-image` grid-lighting sweep (`grid-sweep 16s ease-in-out`) into `.cyber-scanlines::before` for planning + project (design is sweep-exempt), preserving the reduced-motion + `.cyber-animation-disabled` / `.cyber-scanlines-disabled` / `.scanlines-suppressed` gating verbatim. Claudify carve-out honoured: cyan grid scoped to `body.cyber-theme-enabled` only, claudify H1 explicit `#D97757` + `GeistPixel` untouched, `project.html` wrapper inset glow retained.

One deviation from the written plan, made to satisfy its own acceptance criterion: the plan listed only the preview container body-text line for the `--doc-text` pin, but a separate `p { color: var(--text-primary, #e0e0e0) }` rule (planning:1179, design:1181, project:743) overrides the container for paragraphs and would have left body text bright `#e0e0e0` — regressing the readability goal. I pinned that `p` colour to `var(--doc-text)` as well. The five non-preview `vscode-editor-foreground` rules per file (editor/tree/list text, including `li`) were left untouched and continue to track the VS Code theme, per the plan's explicit instruction. No compilation or automated tests were run per session directives; verification is manual-visual per the plan's Verification Plan.

## Review Findings

**Reviewer pass (UAT fix):** The user reported the viewer looked "incredible green" vs the docs site. Root cause: the implementation pinned the `#markdown-preview` *container* colour to `var(--doc-text)` (`#a0a6a6` — the muted `--on-surface-variant` value), but the site's `.docs-article` container is `#e2e8f0` (bright `--on-surface`). Only `<p>` should be `#a0a6a6`. By flattening the container to the muted value, all non-`<p>` text (`li`, `td`, `div` text) inherited the greenish-grey, making the entire preview uniformly muted/cyan-green. Additionally, `li` and `blockquote` colours still tracked `var(--vscode-editor-foreground)` — the plan's own edge-case audit flagged these `#cccccc`-fallback occurrences but the implementation missed them.

**Files changed:** `src/webview/planning.html`, `src/webview/design.html`, `src/webview/project.html` — 4 edits each: (1) added `--doc-text-bright: #e2e8f0` token to `:root`; (2) container colour `var(--doc-text)` → `var(--doc-text-bright)`; (3) `li` colour `var(--vscode-editor-foreground, #cccccc)` → `var(--doc-text-bright)`; (4) `blockquote` colour `var(--vscode-editor-foreground, var(--text-secondary))` → `var(--doc-text)`.

**Validation:** No compilation/tests run per session directives. `pre code` still tracks `vscode-editor-foreground` (deferred — code syntax highlighting, lower priority). Remaining risk: visual confirmation in a live webview still required to confirm the green tint is gone and the text hierarchy now matches the site (bright container text + muted `<p>`).

