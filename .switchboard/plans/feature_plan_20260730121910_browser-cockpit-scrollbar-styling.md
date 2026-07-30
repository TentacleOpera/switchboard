# Style Scrollbars in the Browser Cockpit Panels (memo, project, setup, shell)

## Goal

Give every browser-cockpit surface the same dark, thin scrollbar the board already has, so scrolling the cockpit in a plain browser stops rendering wide light-grey OS scrollbars over black panels.

### Problem

Opening the Switchboard cockpit in a browser (`http://127.0.0.1:<port>/`, served by `LocalApiServer` — either the extension host or the standalone `npx` host) shows native, unstyled scrollbars. They read as light-grey/white tracks on the panels' near-black backgrounds — wider than the 6px thumb the styled panels use, and visually foreign to the panel chrome.

### Root cause

Scrollbar styling in this repo is **per-panel inline CSS**, and only four of the eight webview HTML files carry it:

| Panel HTML | `::-webkit-scrollbar` rules | Scroll containers in browser mode |
| :--- | :--- | :--- |
| `src/webview/kanban.html` | yes — [kanban.html:1142-1159](../../src/webview/kanban.html#L1142-L1159) | column bodies, modals |
| `src/webview/planning.html` | yes — planning.html:1032-1047 | sidebars, doc preview |
| `src/webview/design.html` | yes — design.html:1004-1019 | sidebars, thumb strip |
| `src/webview/implementation.html` | yes — implementation.html:755-770 | sidebar (not a browser route) |
| `src/webview/memo.html` | **none** | `body { overflow-y: auto }` (memo.html:52) + the textarea |
| `src/webview/project.html` | **none** | 24 `overflow` declarations (sidebars, doc preview, lists) |
| `src/webview/setup.html` | **none** | 7 `overflow` declarations |
| `src/webview/shell.html` | **none** | `#strip { overflow-y: auto }` (shell.html:56) |

Two independent factors make the gap visible **only** in browser mode:

1. **No `::-webkit-scrollbar` rules at all** in `memo.html`, `project.html`, `setup.html`, `shell.html` — verified: `grep -c webkit-scrollbar` returns 0 for each. Those four panels therefore paint Chromium's default scrollbar.
2. **Nothing declares a dark colour scheme.** `grep -rn "color-scheme" src/webview/*.html` returns zero hits repo-wide. Chromium picks the *light* native scrollbar/form-control palette unless a page opts into `color-scheme: dark`. Inside the VS Code webview the host supplies its own dark chrome, so the same markup looks correct there and wrong in a browser tab.

The already-styled panels are fine in a browser because their thumb colour is written defensively — `var(--vscode-scrollbarSlider-background, var(--border-bright))` — so the missing `--vscode-*` variable falls through to the panel's own token. That is the pattern to reuse verbatim.

Scope note: this plan is CSS-only and touches the four HTML files that lack the rules. It does not restyle any panel's palette, layout, or components.

### Verified during the improve pass (re-confirmed against source, 2026-07-30)

Every claim above was re-checked; all hold. Additional facts established that the execution steps depend on:

- **`::-webkit-scrollbar` counts:** design 8, planning 6, kanban 4, implementation 4; memo / project / setup / shell **0**. `color-scheme` appears **nowhere** in `src/webview/`.
- **Token availability per file** (the invisible-thumb trap): `memo.html` → `--text-secondary` (24), `--border-color` (25), no `--border-bright`. `project.html` → `--border-color` (28), `--border-bright` (29), `--text-secondary` (45), all redeclared in `body.theme-claudify` (71-73). `setup.html` → `--border-color` (19), `--border-bright` (20), `--text-secondary` (24), redeclared at 46-48. `shell.html` → `--border` (29), `--text-dim` (31) only, and **no theme block at all**.
- **Style-block anchors:** memo `<style>` 7 → `</style>` **71**; project 8 → **1222**; setup **two** blocks (8→**540**, 541→**610**); shell 18 → **129**.
- **Theme class is injected, not authored.** `headlessPanelHtml.applyThemeClass()` ([headlessPanelHtml.ts:82-88](../../src/services/headlessPanelHtml.ts#L82-L88)) rewrites `<body class="…">`. The extension host passes `getTheme()` ([TaskViewerProvider.ts:1873](../../src/services/TaskViewerProvider.ts#L1873)); the **standalone host passes nothing** ([bootstrap.ts:422](../../src/standalone/bootstrap.ts#L422)) — so under `npx` only the `:root` (afterburner) token values are ever live.
- **These panels never render light.** `switchboard.theme.name` has exactly two values, `afterburner` and `claudify` (package.json:727-735), and both are dark. `grep -rn "vscode-light\|vscode-dark\|vscode-high-contrast" src/webview/` returns **zero hits** — no panel has any editor-light-theme styling at all. Backgrounds are hard-coded near-black in every theme: `project.html` `--panel-bg: #000000`, `setup.html` `--bg-color: #0d0d0d`, `memo.html` `--bg-color: #0e0e10` (claudify `#18181b`), `shell.html` `--bg: #0a0a0f`. This fact decides the `color-scheme` design (see Resolved Assumptions #3).
- **Build resolution:** `staticRoutes.webview = [dist/webview, src/webview]` in **both** hosts ([LocalApiServer options at TaskViewerProvider.ts:1876](../../src/services/TaskViewerProvider.ts#L1876), [bootstrap.ts:427](../../src/standalone/bootstrap.ts#L427)), and every `findFile` candidate list in `headlessPanelHtml.ts` puts `dist` first. `dist/webview/*.html` **exists on disk today**, so an edit to `src/` is invisible until the file is copied to `dist/`.
- **`webpack.config.js` CopyPlugin** copies `src/webview/*.html` → `webview/[name][ext]` **verbatim** (no transform). That is what makes the no-compile sync in the verification plan exact rather than approximate.
- **Routes:** `/` serves the shell ([LocalApiServer.ts:3381](../../src/services/LocalApiServer.ts#L3381)); `/board`, `/project`, `/memo`, `/planning`, `/design`, `/setup` serve panels (3387-3402). `implementation.html` has **no** browser route — confirming the table's note.
- **Native form controls in scope of `color-scheme: dark`:** memo 0 selects / 0 inputs / 1 textarea; project 14 / 1 / 8; setup 8 / 83 / 5. Memo's blast radius is effectively nil; setup's is the widest.

## Metadata

- **Complexity:** 4
- **Tags:** frontend, ui, bugfix
- **Project:** Browser Switchboard

> **Superseded:** **Complexity:** 2
> **Reason:** 2 is the "trivial config/copy" band. This change spans six files (four HTML + a new contract test + `package.json`), adds a `color-scheme: dark` declaration that repaints native form controls on two **shipped** editor webviews (~4,000 installs — 22 selects and 84 inputs between `project.html` and `setup.html`), and the new test must follow this repo's non-obvious source-not-`dist` test convention to avoid a false green. Still routine and fully revertible, but not trivial.
> **Replaced with:** **Complexity:** 4 → routes to a Coder, which is the correct handler for a change with one named shipped-surface risk.

## User Review Required

Web research has closed every open platform question (see **Resolved Assumptions**), so nothing here blocks a start. Two items are worth a glance and one is a scope offer:

1. **`color-scheme: dark` is written unscoped on `:root`, against the generic industry advice.** The standard recommendation is to scope it to `body.vscode-dark` / `body.vscode-light` so a webview follows the editor theme. That advice presumes the panel *has* a light presentation — these do not: two themes, both dark, zero `vscode-light` rules anywhere in `src/webview/`, and backgrounds hard-coded to `#000000`/`#0d0d0d`. Scoping to `body.vscode-light { color-scheme: light }` would reintroduce light dropdowns on a black panel, i.e. re-create the bug for light-theme editor users. Unscoped `dark` is correct here. Flagged because it is a deliberate departure from the generic rule, not an oversight.
2. **The change is still a visible delta on the shipped editor webview** for `project.html` and `setup.html` (22 selects, 84 inputs). Direction is confirmed correct — native popups stop rendering light on black — but PRD contract #2 asks for behaviour-preserving edits to shipped providers, so this is your sign-off, not the plan's.
3. **Out-of-scope adjacents, flagged not fixed:** `kanban.html` / `planning.html` / `design.html` still lack `color-scheme: dark`, `::-webkit-scrollbar-corner`, and the Firefox `@supports` block. Research confirms all three gaps are real there (light native dropdowns, a light corner square, no Firefox styling). Each is a few lines in a shipped file. This plan's Goal is the four *unstyled* panels, so they are left alone; say the word and they become a follow-up plan that brings all seven panels to one standard.

## Complexity Audit

### Routine

- Four additive CSS blocks. No JS, no host code, no message contracts, no build-graph changes, no data, no persistence, no dispatch.
- No CSP change — every rule is inline in an existing `<style>`, already permitted by each panel's `style-src 'unsafe-inline'`.
- The block being added is the existing `kanban.html` block plus one `-corner` line and one `@supports`-gated Firefox block, so there is no new pattern to invent.
- One new plain-node contract test plus one `package.json` script line, matching an established convention (`src/test/*-contract.test.js`, 9 siblings; `test:contract:*`, 20 siblings).

### Complex / Risky

- **Token names differ per panel.** `project.html` / `setup.html` define `--border-bright: #444444` and `--text-secondary: #8C8C8C`; `shell.html` defines neither (its tokens are `--border: #1f1f2e`, `--text-dim: #7a7a8c`); `memo.html` currently defines only `--border-color` / `--text-secondary`. Each block must reference tokens that exist **in that file**, otherwise the thumb resolves to nothing and renders transparent (invisible scrollbar — worse than an ugly one). The new contract test asserts this statically rather than leaving it to review.
- **The standard scrollbar properties are a loaded gun and must stay behind the `@supports` gate.** Confirmed by research: in Chromium 121+ and Safari 17.4+, declaring `scrollbar-width` or `scrollbar-color` on a scroller **disables every `::-webkit-scrollbar-*` rule on that scroller**. An ungated `* { scrollbar-width: thin }` anywhere in one of these files silently destroys the 6px styling it sits next to. This is the single highest-consequence line in the change, it fails *invisibly* to any test that only greps for rule presence, and it is the specific reason the new contract test asserts the gate rather than the rule.
- **`color-scheme: dark` also affects native form controls** (select dropdowns, date pickers, the textarea's inner scrollbar) in the same document. That is the desired direction — every one of these panels is hard-dark (`#000`/`#0d0d0d` backgrounds) in both themes, verified — but it is a wider blast radius than the scrollbar selectors alone, so the verification plan checks the panels' inputs and selects explicitly. It also lands on the **shipped editor webview** for `project.html` / `setup.html`, which is the largest remaining risk in this change.
- **Two `<style>` blocks in `setup.html`** (first closes at line 540, second at 610). The rules belong in the **first** block, with the tokens.
- **`dist/` shadows `src/`.** `dist/webview/*.html` exists today and wins in both resolvers, and the *installed* extension serves from its own install folder. A "done" edit to `src/` changes nothing on screen until the file is copied. This is the most likely way this change gets reported complete while the reporter is looking at the old CSS.

## Edge-Case & Dependency Audit

### Race Conditions

- **None inherent.** No async work, no shared state, no ordering. The only ordering hazard is human: editing `src/` while looking at a browser tab served from `dist/` (see the sync step in the Verification Plan).
- **Concurrent-edit idempotency.** If another change has already added a scrollbar block to one of these four files, do not add a second one — merge into the existing block. Duplicate `::-webkit-scrollbar` rules are not a CSS error but make the next edit ambiguous; the new contract test asserts **exactly one** bare `::-webkit-scrollbar` rule per file, so a double-add fails loudly.

### Security

- Nothing. No new network origin, no new script, no new asset, no CSP relaxation. `style-src 'unsafe-inline'` is already granted in every one of these panels' CSP strings (verified in `headlessPanelHtml.ts` for memo/project/setup and in `shell.html`'s own `<meta>` tag), so no policy edit is required and none should be made.

### Side Effects

- **`color-scheme: dark` is the side-effect surface, not the scrollbar selectors.** Research enumerates the full blast radius: classic scrollbars, OS-rendered `<select>` popups, checkbox/radio/progress fills, date-time-number pickers and spinners, unstyled inner scrollbars, the text caret, spellcheck underlines, autofill background, and the default canvas colour where no background is set. Counted here: setup 8 selects + 83 inputs, project 14 selects + 1 input + 8 textareas, memo 1 textarea only, shell none. Direction is correct for all of them (verified: these panels are `#000000`/`#0d0d0d`/`#0e0e10`/`#0a0a0f` in every theme) but it must be looked at, not assumed. The canvas-default repaint is a no-op here because every panel sets an explicit background.
- **Editor webview must not regress.** `project.html` and `setup.html` are served to the VS Code webview too (`PlanningPanelProvider` / `SetupPanelProvider`). Keeping `var(--vscode-scrollbarSlider-background, …)` first in the fallback chain means the editor keeps host-tinted thumbs and only the browser uses the local token.
- **`color-scheme: dark` under a light VS Code theme.** These panels do not follow the editor's light/dark theme — they are always dark-surfaced — so declaring `dark` is consistent, not a mismatch. It is scoped to `:root` in each panel, never to a shared file that a light surface could inherit. *(Now verified rather than asserted: zero `vscode-light`/`vscode-dark` rules exist in `src/webview/`, and both `switchboard.theme.name` values are dark. This is also why the generic "scope `color-scheme` to the host theme class" advice is deliberately not followed — see User Review item 1.)*
- **Theme-token resolution differs between the page scroller and inner scrollers.** `--border-bright` / `--border-color` are declared on `:root` *and* redeclared on `body.theme-claudify` / `body.cyber-theme-enabled`. Research confirms the viewport scrollbar is attached to the `LayoutView`/`html` root box **before** `body` rules cascade, so custom properties declared on a `body` class are invisible to it — the page scrollbar always resolves the `:root` value while inner containers pick up the theme override. This asymmetry already exists in `kanban.html` / `planning.html` / `design.html`, so the change inherits it rather than introducing it, and it is benign: every fallback resolves to a defined dark token either way, so no theme can produce an invisible thumb.
  > **Superseded:** "Note `memo.html` is unaffected either way — its page scroller *is* `body` (`overflow-y: auto`), so it picks up the theme override."
  > **Reason:** Wrong mechanism. `memo.html` sets no `overflow` on `html`, so `body`'s `overflow-y: auto` **propagates to the viewport** per the standard overflow-propagation rule — the body box itself never becomes the scroll container. The resulting scrollbar is therefore the viewport scrollbar, which resolves custom properties against `html`, not `body`.
  > **Replaced with:** `memo.html` follows the same rule as every other panel: its page scrollbar resolves `--border-color` from `:root` (`#333333`) in all themes, including claudify and cyber. Still dark, still visible, so the outcome is unchanged — but do not expect the memo page scrollbar to shift colour with the theme, and do not file it as a bug when it does not.
- **Firefox / non-Chromium.**
  > **Superseded (first pass):** `::-webkit-scrollbar` is ignored there; the paired `scrollbar-width: thin` + `scrollbar-color` declarations cover it. Both are cheap and harmless in Chromium (Chromium honours `scrollbar-color` too — the `::-webkit-*` rules win where both apply).
  > **Reason:** The final clause is false. Research confirms the opposite: Chromium 121+ (Jan 2024) and Safari 17.4+ (Mar 2024) treat the two mechanisms as mutually exclusive per scroller, with the **standard** properties taking precedence and disabling all `::-webkit-scrollbar-*` rules on that scroller. Writing both unguarded would have suppressed the 6px webkit styling on exactly the four panels being fixed, leaving an ~8-11px UA "thin" scrollbar next to the board's 6px one — the change would have passed its own grep-based test while visibly failing its stated goal.
  > **Superseded (second pass):** Do not write the standard properties at all; ship the `::-webkit-*` block plus `color-scheme: dark`, and treat Firefox sizing parity as a separate plan.
  > **Reason:** That was the right call while the precedence question was open, because it is correct under either answer — but it dropped the original plan's Firefox intent as collateral. Research also confirms the clean way to keep it: `@supports selector(::-webkit-scrollbar)` evaluates **true** in Chromium and Safari and **false** in Firefox (Gecko 102+), making it a reliable engine gate. Wrapping the standard properties in `@supports not selector(::-webkit-scrollbar)` means Blink and WebKit never see them — so the precedence switch can never fire — while Gecko gets thin dark scrollbars. Zero Chromium delta, Firefox intent restored.
  > **Replaced with:** Ship all three layers per file: `:root { color-scheme: dark; }`, the `::-webkit-*` block (6px, the exact board parity), and the standard properties **only** inside `@supports not selector(::-webkit-scrollbar)`. The standard properties must never appear at top level in any of these files — the new contract test enforces that, because an ungated re-add is a silent, total regression of the webkit styling.
  > *Note on Firefox fidelity:* `scrollbar-width` accepts no `<length>`, and `thin` measures ~8px (Gecko, all platforms) against Chromium's 6px webkit thumb. Firefox therefore gets *dark and thin*, not *pixel-identical*. That is the ceiling the standard properties allow, not a shortfall in the implementation.
- **`scrollbar-corner`.** Where a container scrolls in both axes (project.html doc preview, kanban board), the unset corner paints a light square in browser mode. Include `::-webkit-scrollbar-corner { background: transparent; }` in each block. *(Confirmed by research: with `::-webkit-scrollbar` rules present but the corner unstyled, Chromium paints a solid white/light-grey box; `color-scheme: dark` alone only repaints it to native dark `#1e1e1e`, which is dark but still not the transparent track. The explicit declaration is load-bearing, not belt-and-braces.)* The same one-line gap remains in `kanban.html` / `planning.html` / `design.html` and is deliberately out of scope — see User Review item 3.
- **Shell iframes do not inherit.** `shell.html` hosts each panel in a same-origin `<iframe>` (`.panel-frame`). CSS does not cross the iframe boundary, which is exactly why each panel file needs its own copy — styling only the shell would fix the 48px icon strip and nothing else. `shell.html` also sets `html, body { overflow: hidden }`, so its **only** scroll container is `#strip`; a scrollbar block there is doing exactly one job.

### Dependencies & Conflicts

- **A shared stylesheet was considered and rejected — and the improve pass strengthens that call.** A single `browser-chrome.css` served at `/static/webview/` would need a new URI placeholder substituted at three injection sites (`headlessPanelHtml.ts`, `PlanningPanelProvider`, `SetupPanelProvider`) and a `<link>` that resolves in both hosts. `webview-shim-injection-contract.test.js` documents what happens when a single per-panel injection marker goes missing (a dead Setup panel shipped in 1.7.13). For ~20 lines of CSS, four inline copies matching the existing precedent is the lower-risk trade.
  *Corroborating evidence found during the improve pass:* the repo already tried this and the wiring rotted. `src/webview/shared-tabs.css` exists and is copied to `dist/` by webpack, and `PlanningPanelProvider.ts:710` still substitutes `{{SHARED_TABS_CSS_URI}}` — but **no HTML file references that placeholder any more**, and `headlessPanelHtml.ts` never substituted it, so the browser host would have served a literal unresolved placeholder. A shared stylesheet here would be re-treading a path whose only prior instance is dead code.
- **Build/deploy dependency.** `dist/` wins over `src/` in both resolvers, and the *installed* extension serves from its own install folder — not this repo's `dist/`. The live install is `~/.devin/extensions/turnzero.switchboard-1.7.13`. Verification must sync the edited HTML to `dist/webview/` **and** to the installed extension's `dist/webview/`, then reload, before judging the result.
- **No plan/session dependencies.** No verb, schema, seam, allowlist, catalog, or ratchet is touched, so `verb-returns:check`, `parity:check`, and `push-routing:check` are all unaffected by construction.

## Dependencies

- None. This plan depends on no other session or plan; it touches no shared file that another in-flight plan is expected to hold (PRD orchestration rule "one agent stream per provider file" does not bind — no provider file is edited).

## Adversarial Synthesis

**Risk summary.** Two risks carry this plan. (1) The standard scrollbar properties are now known to *disable* all `::-webkit-scrollbar-*` rules on any scroller that declares them (Chromium 121+, Safari 17.4+), so an ungated `scrollbar-width`/`scrollbar-color` line silently destroys the 6px styling beside it — mitigated by confining them to an `@supports not selector(::-webkit-scrollbar)` block and by a contract test that fails on any top-level occurrence. (2) `color-scheme: dark` repaints native form controls on two **shipped** editor webviews (22 selects, 84 inputs); direction is verified correct — these panels have two themes, both dark, and no light presentation at all — but it needs sign-off and targeted inspection rather than assumption. A third hazard is procedural: `dist/` shadows `src/` in both resolvers and the installed extension serves from its own folder, which is the likeliest route to this change being reported complete while nothing on screen has moved — mitigated by an explicit no-compile file-copy sync step before any visual judgement. The invisible-thumb failure mode (a `var()` chain ending in a token the file does not define) is closed statically by the new test rather than left to review.

## Proposed Changes

The same three-layer block goes into all four files, differing only in the token names and — for `shell.html` — the absence of a `--vscode-*` fallback. Insert it at the **end** of the file's existing `<style>` block so it wins any earlier declaration and sits where the precedent files put it.

The three layers, and why each is present:

| Layer | Purpose | Engines affected |
| :--- | :--- | :--- |
| `:root { color-scheme: dark; }` | Stops the browser painting the light native scrollbar and form-control palette on a black panel. This is factor #2 of the root cause. | All |
| `::-webkit-scrollbar-*` block | The exact 6px thumb the board has. Standard properties cannot express 6px (no `<length>` accepted). | Chromium, Safari |
| `@supports not selector(::-webkit-scrollbar) { … }` | Thin dark scrollbars for Gecko. Gated because these properties would otherwise disable the whole webkit block in Chromium and Safari. | Firefox only |

> **Superseded:** `* { scrollbar-width: thin; scrollbar-color: var(--…) transparent; }` written at top level as the first line of each block.
> **Reason:** Confirmed regression vector, not a style preference. In Chromium 121+ and Safari 17.4+ a scroller with `scrollbar-width` or `scrollbar-color` set has **all** its `::-webkit-scrollbar-*` rules ignored, so a top-level universal declaration would suppress the 6px block immediately below it on all four panels — leaving an ~8-11px UA scrollbar beside the board's 6px one, with every grep-based test still green. Secondary problem: both properties are inherited, so the universal selector adds nothing over declaring them once at the gate's root.
> **Replaced with:** The same two properties, unchanged in value, moved inside `@supports not selector(::-webkit-scrollbar) { … }`. Chromium and Safari report that selector as supported and never enter the block; Firefox reports it unsupported and does. Same Firefox outcome the original plan wanted, with the Chromium precedence switch made unreachable.

### 1. `src/webview/memo.html`

- **Context.** `<style>` opens at line 7 and closes at line **71**. Tokens live in `:root` (22-28): `--text-secondary: #888888` (24), `--border-color: #333333` (25). There is **no** `--border-bright`. Scroll containers: `body { overflow-y: auto }` (line 52, which propagates to the viewport) and the single `<textarea>`. Zero `<select>`/`<input>` elements, so `color-scheme: dark` has the smallest blast radius of the four. Browser-only surface in practice, but the `--vscode-*` fallback is kept for consistency with the precedent block and costs nothing.
- **Logic.** The page scrollbar is the viewport scrollbar (body's overflow propagates), so it resolves `--border-color` from `:root` — `#333333` in every theme. The textarea's inner scrollbar sits inside `body` and does follow the theme override (`#27272a` claudify, `#00f0ff` cyber). Both are visible against their backgrounds.
- **Implementation.** Insert immediately before `</style>` (line 71):

```css
        /* Browser cockpit: opt this document into the dark native palette so a
           plain browser stops painting light scrollbars and light form controls
           on a black surface. The VS Code webview host supplies its own dark
           chrome, which is why the gap is browser-only. Unscoped on purpose —
           this panel has no light presentation in any theme. */
        :root { color-scheme: dark; }

        /* Scrollbar styling — the kanban.html/planning.html/design.html block
           plus -corner. The --vscode-* var is absent in a browser and falls
           through to this panel's own token, so one declaration serves both
           hosts. */
        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-corner {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: var(--vscode-scrollbarSlider-background, var(--border-color));
            border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--vscode-scrollbarSlider-hoverBackground, var(--text-secondary));
        }

        /* Firefox only. DO NOT hoist these two properties out of the @supports
           gate: Chromium 121+ and Safari 17.4+ ignore EVERY ::-webkit-scrollbar
           rule on a scroller that declares scrollbar-width or scrollbar-color,
           so an ungated copy silently deletes the 6px styling above. Chromium
           and Safari report this selector as supported and skip the block;
           Gecko reports it unsupported and enters it. */
        @supports not selector(::-webkit-scrollbar) {
            :root {
                scrollbar-width: thin;
                scrollbar-color: var(--border-color) transparent;
            }
        }
```

- **Edge cases.** Do not reach for `--border-bright` here — it does not exist in this file and would render the thumb transparent. `scrollbar-color` is inherited, so declaring it on `:root` inside the gate covers the textarea too; no universal selector is needed.

### 2. `src/webview/project.html`

- **Context.** `<style>` opens at line 8 and closes at line **1222**. `:root` begins at 24 with `--border-color: #333333` (28), `--border-bright: #444444` (29), `--text-secondary: #8C8C8C` (45); `body.theme-claudify` redeclares all three (71-73), so both themes resolve. 24 `overflow` declarations. Served to **both** hosts (`PlanningPanelProvider._getProjectHtml` and `getProjectHtml` in `headlessPanelHtml.ts`).
- **Logic.** Identical to memo, with `--border-bright` as the thumb token (matching kanban/planning/design exactly).
- **Implementation.** Insert the same three-layer block before `</style>` (line 1222), substituting `var(--border-bright)` for `var(--border-color)` in both the thumb rule and the gated `scrollbar-color`. Keep `border-radius: 3px;` and add `border: none;` to the thumb to match `planning.html:1043` — `project.html` shares planning's card/sidebar styling lineage.
- **Edge cases.** This is the file where the doc-preview pane can scroll in both axes, so `::-webkit-scrollbar-corner` is load-bearing rather than defensive (confirmed: an unstyled corner paints a solid light box, and `color-scheme: dark` only darkens it to `#1e1e1e` rather than making it transparent). It is also the widest `color-scheme: dark` surface after setup (14 selects, 8 textareas) — inspect a `<select>` popup in **both** hosts.

### 3. `src/webview/setup.html`

- **Context.** **Two** `<style>` blocks: 8→**540** and 541→**610**. `:root` starts at 15 with `--border-color` (19), `--border-bright` (20), `--text-secondary` (24); `body.theme-claudify` redeclares them at 46-48. `--bg-color: #0d0d0d`. 7 `overflow` declarations. Served to both hosts (`SetupPanelProvider` and `getSetupHtml`).
- **Logic.** Same block as `project.html`.
- **Implementation.** Insert at the end of the **first** `<style>` block, before `</style>` on line **540** — the block that owns the tokens. Do not put it in the second block.
- **Edge cases.** Largest `color-scheme: dark` surface in the change: 8 selects and **83** inputs, including number spinners and checkboxes that research confirms will repaint. Walk the settings body in both hosts. Also note `setup.html` is one of the two files that carries the `<!-- SHARED_DEFAULTS_SCRIPT -->` marker whose accidental deletion shipped a dead panel in 1.7.13 — the marker sits immediately above the inline `<script>`, nowhere near `</style>` on 540, so this edit cannot disturb it. Leave it untouched and let `test:contract:shim-injection` confirm.

### 4. `src/webview/shell.html`

- **Context.** `<style>` opens at 18, closes at **129**. `:root` (25-36) defines `--border: #1f1f2e` (29) and `--text-dim: #7a7a8c` (31) — **no** `--border-bright`, **no** `--text-secondary`, and **no theme block whatsoever**. `html, body { overflow: hidden }` (38), so the only scroll container in the document is `#strip { overflow-y: auto }` (56). Browser-only (`getShellHtml`; there is no editor equivalent).
- **Logic.** No `--vscode-*` fallback is needed — this file is never rendered inside a VS Code webview, so the fallback branch could never fire.
- **Implementation.** Insert before `</style>` (line 129):

```css
        /* Browser-only shell: dark native palette + a 6px strip scrollbar to
           match the panels it frames. #strip is the document's only scroller
           (html, body are overflow:hidden). No --vscode-* fallback — the shell
           has no VS Code webview equivalent. */
        :root { color-scheme: dark; }

        ::-webkit-scrollbar {
            width: 6px;
            height: 6px;
        }
        ::-webkit-scrollbar-track {
            background: transparent;
        }
        ::-webkit-scrollbar-corner {
            background: transparent;
        }
        ::-webkit-scrollbar-thumb {
            background: var(--border);
            border-radius: 3px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: var(--text-dim);
        }

        /* Firefox only — see the note in memo.html. Never hoist these out of
           the gate: they would disable the ::-webkit-* rules above in
           Chromium 121+ / Safari 17.4+. */
        @supports not selector(::-webkit-scrollbar) {
            :root {
                scrollbar-width: thin;
                scrollbar-color: var(--border) transparent;
            }
        }
```

- **Edge cases.** `applyThemeClass` still stamps a theme class on `<body>` here in the extension host, but `shell.html` declares no theme rules, so the class is inert and `--border` always resolves to `#1f1f2e`. The strip only overflows on a short viewport — the manual check has to shrink the window to see anything.

### 5. `src/test/browser-panel-scrollbar-contract.test.js` — new contract test

- **Context.** Follows the convention of the nine `src/test/*-contract.test.js` siblings: a plain-node script, no test framework, `test(name, fn)` + tally + `process.exit(1)`.

> **Superseded:** Render each panel through `headlessPanelHtml` with the real repo root and assert on the served HTML:
> ```js
> const { getPanelHtmlById, getShellHtml } = require('../../out/services/headlessPanelHtml');
> const REPO_ROOT = /* resolved as in webview-shim-injection-contract.test.js */;
> const PANELS = ['board', 'project', 'memo', 'planning', 'design', 'setup'];
> for (const id of PANELS) {
>     const { html } = getPanelHtmlById(id, REPO_ROOT, '/tmp/ws');
>     assert.match(html, /color-scheme:\s*dark/, `${id}: no dark color-scheme`);
>     …
> }
> ```
> **Reason:** Three concrete defects. (a) **It reads `dist/`, not `src/`.** Every `findFile` candidate list puts `dist/webview/…` first and `dist/webview/*.html` exists on disk, so with the real repo root this test asserts on the *last build* — it goes green on a stale `dist` that still contains the old CSS, and red on a correctly-edited `src` that has not been copied yet. Both directions are wrong. The sibling test it claims to follow explicitly avoids this: `tempRepoWith()` is commented *"it deliberately sidesteps dist/, which is not the source of truth in this project."* (b) **It asserts `color-scheme: dark` on `board`, `planning`, and `design`, which this plan does not change** — the test as written fails on day one. (c) It requires `out/services/headlessPanelHtml` (hence a `tsc` run) to check CSS that no renderer function touches, and `getPanelHtmlById` returns `null` for an unknown id, so the destructure would throw rather than assert.
> **Replaced with:** A pure static assertion over the **source** HTML, with the panel list *parsed* from `headlessPanelHtml.ts` so a panel added tomorrow is covered the day it lands. No `out/` require, no build, no `dist`. Two assertions are added beyond the original intent, both closing holes the original could not see: the thumb's fallback token must actually be defined in the same file (the invisible-scrollbar mode), and the standard scrollbar properties must **never** appear outside the `@supports` gate (the silent total-regression mode).
- **Logic.** Derive the file list from the `path.join(repoRoot, 'src', 'webview', '<name>.html')` candidates in `headlessPanelHtml.ts` (7 today: shell, kanban, project, planning, design, setup, memo — `implementation.html` is correctly excluded because it has no browser route). For each file assert: exactly one bare `::-webkit-scrollbar` rule; a bare `::-webkit-scrollbar-thumb` rule; the innermost `var(--token)` of the thumb's `background` chain is defined in that same file; and no `scrollbar-width`/`scrollbar-color` declaration outside an `@supports not selector(::-webkit-scrollbar)` block. Assert `color-scheme: dark` and the `@supports` gate only on the four files this plan changes, with the other three listed in a `PENDING` set so the omission is documented in code rather than silent.
- **Implementation.**

```js
'use strict';
/**
 * Contract: every browser-served panel styles its own scrollbars, the token its
 * thumb points at actually exists in that file, and the standard scrollbar
 * properties stay behind their @supports gate.
 *
 * Scrollbar CSS in this repo is per-panel inline CSS — there is no shared
 * stylesheet to inherit from (the one attempt, {{SHARED_TABS_CSS_URI}}, is dead
 * wiring) and CSS does not cross the shell's iframe boundary. A new panel route
 * that forgets the block ships light OS scrollbars on a black surface, which is
 * invisible to every other test.
 *
 * The gate assertion is the important one. In Chromium 121+ and Safari 17.4+, a
 * scroller that declares `scrollbar-width` or `scrollbar-color` has ALL of its
 * ::-webkit-scrollbar-* rules ignored. So a well-meaning future edit that hoists
 * `scrollbar-width: thin` to top level — a one-line "cross-browser improvement" —
 * silently deletes the 6px styling on every panel at once, with no error, no
 * warning, and no other test noticing.
 *
 * Reads src/, never dist/ — same reasoning as tempRepoWith() in
 * webview-shim-injection-contract.test.js: dist is a build artefact, and a stale
 * copy would make this test green against source that was never changed.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const WEBVIEW_SRC = path.join(repoRoot, 'src', 'webview');
const HTML_MODULE = path.join(repoRoot, 'src', 'services', 'headlessPanelHtml.ts');

/** Files this plan brings up to standard. The rest are a known, tracked gap. */
const PENDING = new Set(['kanban.html', 'planning.html', 'design.html']);

let passed = 0, failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

/** Browser-served panel HTML, parsed from the module that serves it. */
function browserServedHtmlFiles() {
    const src = fs.readFileSync(HTML_MODULE, 'utf8');
    const re = /path\.join\(repoRoot, 'src', 'webview', '([^']+\.html)'\)/g;
    const files = new Set();
    let m;
    while ((m = re.exec(src)) !== null) { files.add(m[1]); }
    return [...files];
}

/** Innermost custom property in a `var(--a, var(--b))` chain. */
function innermostToken(decl) {
    const all = [...decl.matchAll(/var\(\s*(--[\w-]+)/g)].map(x => x[1]);
    return all.length ? all[all.length - 1] : null;
}

/** Strip every `@supports not selector(::-webkit-scrollbar) { … }` block (brace-matched). */
function withoutWebkitGate(css) {
    const OPEN = /@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)\s*\{/g;
    let out = css, m;
    while ((m = OPEN.exec(out)) !== null) {
        let i = m.index + m[0].length, depth = 1;
        while (i < out.length && depth > 0) {
            if (out[i] === '{') { depth++; }
            else if (out[i] === '}') { depth--; }
            i++;
        }
        out = out.slice(0, m.index) + out.slice(i);
        OPEN.lastIndex = 0;
    }
    return out;
}

const FILES = browserServedHtmlFiles();

test('the panel list parsed from headlessPanelHtml.ts is plausible', () => {
    assert.ok(FILES.length >= 7, `expected >= 7 browser-served HTML files, parsed ${FILES.length}: ${FILES.join(', ')}`);
    assert.ok(!FILES.includes('implementation.html'), 'implementation.html has no browser route — the parse is picking up the wrong thing');
});

for (const file of FILES) {
    const content = fs.readFileSync(path.join(WEBVIEW_SRC, file), 'utf8');

    test(`${file}: exactly one bare ::-webkit-scrollbar rule`, () => {
        const count = (content.match(/^\s*::-webkit-scrollbar\s*\{/gm) || []).length;
        assert.strictEqual(count, 1, `expected exactly 1 (a second block makes the next edit ambiguous), found ${count}`);
    });

    test(`${file}: the thumb's fallback token is defined in this file`, () => {
        const m = content.match(/^\s*::-webkit-scrollbar-thumb\s*\{([^}]*)\}/m);
        assert.ok(m, 'no bare ::-webkit-scrollbar-thumb rule');
        const token = innermostToken(m[1]);
        assert.ok(token, `thumb background declares no var(): ${m[1].trim()}`);
        assert.ok(new RegExp(`${token}\\s*:`).test(content),
            `thumb falls back to ${token}, which this file never defines — the thumb renders transparent, i.e. an invisible scrollbar`);
    });

    test(`${file}: no standard scrollbar property outside the @supports gate`, () => {
        const ungated = withoutWebkitGate(content);
        const leaks = (ungated.match(/scrollbar-(?:width|color)\s*:/g) || []);
        assert.deepStrictEqual(leaks, [],
            'scrollbar-width/scrollbar-color at top level makes Chromium 121+ and Safari 17.4+ ignore EVERY ' +
            '::-webkit-scrollbar rule on that scroller — it silently deletes the 6px styling. Keep them inside ' +
            '@supports not selector(::-webkit-scrollbar).');
    });

    if (!PENDING.has(file)) {
        test(`${file}: declares color-scheme: dark`, () => {
            assert.match(content, /color-scheme:\s*dark/,
                'without it a plain browser paints the light native scrollbar and form-control palette on a black panel');
        });

        test(`${file}: carries the Firefox @supports block`, () => {
            assert.match(content, /@supports\s+not\s+selector\(\s*::-webkit-scrollbar\s*\)/,
                'Gecko ignores ::-webkit-scrollbar entirely and needs the standard properties');
        });
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
```

- **Edge cases.** The `^\s*::-webkit-scrollbar\s*\{` anchor deliberately excludes prefixed selectors, so `design.html`'s `.strip-thumbs-wrapper::-webkit-scrollbar` (3229) and planning/design's `.cyber-theme-enabled ::-webkit-scrollbar-thumb` do not trip the exactly-once check. `shell.html`'s thumb chain is a single `var(--border)`, so `innermostToken` returns `--border` and the definition check works without a `--vscode-*` outer layer. `withoutWebkitGate` brace-matches rather than regex-matching the block body, so a nested rule inside the gate cannot end the strip early. The three `PENDING` files currently declare no standard properties at all, so the gate-leak assertion passes for them today and starts guarding them the moment someone adds a block.

### 6. `package.json` — register the test

Insert alongside the other `test:contract:*` entries (immediately after `test:contract:shim-injection`, line 791):

```json
    "test:contract:panel-scrollbars": "node src/test/browser-panel-scrollbar-contract.test.js",
```

## Verification Plan

### Automated Tests

Per this session's directives, **no compilation step and no automated test run is part of this verification pass.** The tests are authored, registered, and left for the user or CI to run:

1. `npm run test:contract:panel-scrollbars` — the new contract test. It requires **no build**: it reads `src/webview/*.html` and `src/services/headlessPanelHtml.ts` from disk directly.
2. **Load-bearing checks when it is run** — an assertion that cannot fail is not a test. Two mutations, each restored afterwards: (a) delete the block from `src/webview/setup.html` and confirm the test fails naming `setup.html`; (b) hoist `scrollbar-width: thin` out of the `@supports` gate in any one file and confirm the gate-leak assertion fails. Mutation (b) is the one that matters most — it is the regression the gate exists to prevent.
3. `npm run test:contract:shim-injection` — should stay green; the same four files are re-read and no injection marker or script anchor is near a `</style>`.
4. `npm run lint` — `eslint src` covers `src/test/*.js`, so the new file must be lint-clean.
5. Not affected by construction, listed so nobody re-runs them looking for a signal: `verb-returns:check`, `parity:check`, `push-routing:check`. No verb, schema, seam, or allowlist is touched.

### Manual — sync first (no compile)

6. **Make the edit visible without building.** `dist/webview/*.html` exists and wins over `src/` in both resolvers, and the running extension serves from its **install** folder, not this repo. `webpack.config.js` copies `src/webview/*.html` to `dist/webview/[name][ext]` **verbatim**, so a plain file copy reproduces exactly what a build would do for these files:
   - copy the four edited HTML files to `<repo>/dist/webview/`
   - copy the same four to `~/.devin/extensions/turnzero.switchboard-1.7.13/dist/webview/`
   - reload the editor window
   Do not judge anything on screen before this step — a `src`-only edit changes nothing.

### Manual — browser mode (the reported surface)

7. Read `.switchboard/api-server-port.txt` and open `http://127.0.0.1:<port>/` (the shell) in a **Chromium-based** browser.
8. **Memo panel** (`/memo`): paste enough text to overflow the textarea and shrink the window until the panel body scrolls. Both scrollbars are 6px, dark, transparent-tracked. No white gutter.
9. **Project panel** (`/project`): scroll the plan list, the sidebar, and a doc preview. Where a container scrolls both axes, the bottom-right corner is transparent, not a white or dark-grey square. Open one of its 14 `<select>` popups and confirm it renders dark.
10. **Setup panel** (`/setup`): scroll the settings body; open a `<select>` and confirm the dropdown renders dark, then spot-check a handful of its 83 inputs (any number spinner, date field, or checkbox). This is the `color-scheme: dark` side effect on its widest surface — confirm it is an improvement, not a regression.
11. **Shell strip**: shrink the window vertically until the 48px icon strip overflows; its scrollbar is dark and 6px.
12. **Board panel** (`/board`): unchanged from before the change (regression check on an already-styled panel). Its scrollbar must be **indistinguishable in width** from the four fixed panels'. If the fixed panels look wider, a standard property has escaped the `@supports` gate and Chromium has dropped the webkit block — go straight to the gate, not to the token values.
13. **Firefox pass** (new — the `@supports` branch is otherwise never exercised): open the same four panels in Firefox. Scrollbars are dark and thin (~8px, not pixel-matched to Chromium's 6px — that is the documented ceiling of `scrollbar-width`, not a defect). Confirm they are not the default light grey, which would mean the gate is not being entered.

### Manual — editor webview (no regression)

14. In VS Code, open the Project panel and the Setup panel. Scrollbars still follow the editor theme's slider colour (the `--vscode-scrollbarSlider-background` branch). Panel backgrounds, layout, and custom-styled components are unchanged.
    > **Superseded:** "…and no input, dropdown, or panel background changed appearance."
    > **Reason:** Self-contradictory. `color-scheme: dark` is added to `project.html` and `setup.html`, which are served to the editor webview too, so native inputs and dropdowns there **will** repaint. Asking a verifier to confirm "nothing changed" guarantees either a false pass or a false failure on the one item that most needs a judgement call.
    > **Replaced with:** Expect native `<select>` popups and `<input>` widgets in the editor's Project/Setup panels to render dark. Check this under a **light** VS Code theme specifically — that is where a light popup on a black panel was previously most visible, and where the unscoped `color-scheme: dark` is doing its most useful work. Dark controls on these panels are correct under every editor theme, because the panels themselves are `#000000`/`#0d0d0d` under every editor theme.
15. Switch theme (`switchboard.theme.name`: `afterburner` → `claudify`) with the cockpit open in both hosts; no thumb renders invisible in any theme.
    > **Superseded:** "…the thumb colour follows each theme's `--border-bright` / `--border-color` and never renders invisible."
    > **Reason:** Only half true, and the false half would be logged as a bug. Theme tokens are redeclared on `body.theme-claudify` / `body.cyber-theme-enabled`, not on `:root`, and the viewport scrollbar is attached to the `html` root box before `body` rules cascade — so page-level scrollbars keep the `:root` value while inner containers pick up the theme override. `memo.html` is **not** an exception (its `body` overflow propagates to the viewport).
    > **Replaced with:** Verify the invariant that actually matters: **no theme produces an invisible thumb.** Inner containers may shift colour with the theme while page-level scrollbars stay on the `:root` value; both are dark and both are visible, so either is a pass. Under `npx` no theme class is injected at all, so only `:root` values apply there.

## Resolved Assumptions

Web research (2026-07-30) closed every platform question this plan had open. **These are settled — do not re-open them or re-research them during implementation.**

1. **Standard-vs-`-webkit-` precedence: the standard properties win and disable the pseudo-elements.** Chromium 121+ (Jan 2024) and Safari 17.4+ (Mar 2024) treat the two mechanisms as mutually exclusive *per scroller*: if `scrollbar-width` or `scrollbar-color` is set, **all** `::-webkit-scrollbar-*` rules on that scroller are ignored and rendering falls back to the standard/native path. Hybrid styling (6px from the pseudo-element, colour from the standard property) is impossible. The precedence flip is Chromium's deliberate migration mechanism for the legacy pseudo-elements. → This is why the standard properties are confined to the `@supports` gate and why the contract test fails on any top-level occurrence.
2. **`scrollbar-width: thin` cannot reach 6px.** The property accepts no `<length>` by specification; `thin` delegates to UA/platform metrics — ~8px in Gecko across platforms, ~9-10px Chromium on Windows, ~11px on macOS classic, varying further with device pixel ratio. → Firefox gets *dark and thin*, not pixel parity with the board's 6px. Documented as the ceiling, not a shortfall.
3. **VS Code webviews do set a `color-scheme` on the content document**, and they inject `body.vscode-dark` / `body.vscode-light` / `body.vscode-high-contrast` plus the `--vscode-*` variable set. An author declaring `:root { color-scheme: dark }` **does** override the host, and under a light editor theme that forces dark OS popups. The standard mitigation is to scope `color-scheme` to those host classes. → **Deliberately not followed here**, for a verified repo-specific reason: these panels have no light presentation to protect. `switchboard.theme.name` has two values, both dark; `grep -rn "vscode-light\|vscode-dark\|vscode-high-contrast" src/webview/` returns zero hits; backgrounds are `#000000` (project), `#0d0d0d` (setup), `#0e0e10`/`#18181b` (memo), `#0a0a0f` (shell). Scoping to `body.vscode-light { color-scheme: light }` would put light dropdowns back on a black panel for light-theme users — re-creating the bug. Unscoped `dark` is correct; see User Review item 1.
4. **An unstyled `::-webkit-scrollbar-corner` does paint a light box.** With `::-webkit-scrollbar` rules present and the corner omitted, Chromium paints a solid white/light-grey square at the two-axis intersection. `color-scheme: dark` alone only repaints it to native dark `#1e1e1e` — dark, but still not the transparent track. → The explicit `::-webkit-scrollbar-corner { background: transparent; }` line is load-bearing.
5. **The viewport scrollbar resolves custom properties against `html`, not `body`.** Viewport scrollbars attach to the `LayoutView`/root box before `body` rules cascade, so custom properties declared on a `body` class are invisible to them; only scrollbars of elements inside `body` see the override. → Page-level scrollbars always use `:root` values. Every `:root` value here is a defined dark token, so the "no invisible thumb" invariant holds in every theme; verification step 15 is written to that invariant rather than to a colour-follows-theme expectation.
6. **`@supports not selector(::-webkit-scrollbar)` is a reliable Gecko-only gate.** `@supports selector(::-webkit-scrollbar)` evaluates **true** in Chromium 121+ and Safari 17.4+ and **false** in Firefox (Gecko 102+, which does not recognise the vendor pseudo-element). No known false positives. → This is the mechanism that lets the Firefox properties coexist with the webkit block without ever triggering finding #1.

---

**Recommendation: Send to Coder** (Complexity 4).

## Completion Report

Implemented dark scrollbar styling and native dark color scheme across all browser cockpit panels (`memo.html`, `project.html`, `setup.html`, `shell.html`) to eliminate wide light-grey OS scrollbars over dark surfaces. Added standard scrollbar properties gated under `@supports not selector(::-webkit-scrollbar)` for Firefox compatibility while preventing Chromium 121+ / Safari 17.4+ rule suppression. Created contract test `src/test/browser-panel-scrollbar-contract.test.js` and registered `test:contract:panel-scrollbars` in `package.json` to statically verify token definition and gate isolation.

Files changed:
- `src/webview/memo.html`
- `src/webview/project.html`
- `src/webview/setup.html`
- `src/webview/shell.html`
- `src/test/browser-panel-scrollbar-contract.test.js` (NEW)
- `package.json`

No issues encountered during implementation.
