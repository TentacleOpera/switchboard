# Decouple Webview Fonts from the VS Code Host

## Goal

Make every Switchboard panel render **the same fonts in the browser cockpit and the VS Code webview**. Today they don't, because the font tokens are derived from CSS variables that only the VS Code webview host injects.

No new font is bundled and no new family is introduced. The fix is to stop reading host settings and name a fixed stack instead — 8 `:root` blocks, plus 4 stragglers that reach for the same host variables outside `:root`.

### Problem

The board renders visibly worse in the browser cockpit (`127.0.0.1:<port>/#board`) than in the VS Code webview. Column headers, agent labels, count badges, "Complexity: …" lines, every card and toolbar button, and the tab bar all render in a different, mushier typeface in the browser. Card titles look fine in both, which is what makes the bug read as "the browser fonts are broken" rather than "one token resolves differently".

### Root Cause

Two independent defects stack:

1. **The font tokens are derived from host-injected CSS variables that do not exist in a browser.** Every panel defines:
   ```css
   --font-mono: var(--vscode-editor-font-family, 'SF Mono', Monaco, 'Cascadia Code', 'Consolas', monospace);
   ```
   The VS Code webview host injects `--vscode-editor-font-family`, so the webview uses it. The headless HTTP path (`src/services/headlessPanelHtml.ts`) substitutes the font *URIs* but injects **no `--vscode-*` variables at all** — verified: the string `vscode-` appears exactly once in that file, in a comment. So in a browser the variable is undefined and the fallback chain is consulted instead. The two hosts were never rendering the same rule.

   > **Superseded:** "The defect is confined to the mono token." / "Hanken Grotesk itself was never broken."
   > **Reason:** Half right, and the half that is wrong changes the scope. Hanken *loads* fine in both hosts — that part stands. But the **proportional** token is built the same broken way: all 7 webview panels declare `--font-family: 'Hanken Grotesk', var(--vscode-font-family, …)`. It reads a host setting too. It merely doesn't *show*, because `'Hanken Grotesk'` sits ahead of it and resolves, so the host-derived segment only ever supplies fallback glyphs — which is exactly the load-bearing role called out below. Framing this as a mono-only defect makes the `--font-family` line in the replacement block look like scope creep when it is the same bug.
   > **Replaced with:** *Both* font tokens are host-derived in all 7 webview panels. The mono token is where the defect is **visible**; the proportional token has the identical construction defect and is fixed by the same edit. Hanken itself was never broken (verified `HTTP 200`, 34,664 bytes, valid `wOF2` magic, served from `/static/designs/`).

2. **The fallback chain names three faces that do not resolve on macOS/Chrome.** Measured by rendering the same string at 13px in Chrome and comparing widths against a known-failed lookup (`serif` = 159.22px):

   | family | width | resolves? |
   |---|---|---|
   | `'SF Mono'` | 159.22 | **no** |
   | `'Cascadia Code'` | 159.22 | **no** |
   | `'Consolas'` | 159.22 | **no** |
   | `Monaco` | 210.64 | yes |
   | `Menlo` | 211.33 | yes |
   | `var(--font-mono)` as served | **210.64** | → **Monaco** |

   `SF Mono` ships as `/System/Library/Fonts/SFNSMono.ttf` but is not in the enumerable family list, so Chrome cannot reach it by name (`system_profiler SPFontsDataType` does not list it). `Cascadia Code` and `Consolas` are Windows faces. So the chain skips three dead names and lands on **Monaco** — a bitmap-era face with no small-size hinting, which is what turns to mush at the 9–11px the chrome uses. The webview meanwhile resolved `--vscode-editor-font-family` to VS Code's macOS default (`Menlo, Monaco, 'Courier New', monospace`) → **Menlo**.

   The two hosts match *today* only because `editor.fontFamily` is unset. Setting it to anything reintroduces the divergence with a different font — so pinning the fallback to Menlo-first is a coincidence, not a fix. **The defect is that a font token reads a host setting at all.**

### The host-variable stragglers outside `:root`

The `:root` blocks are not the only place a font reaches for a host variable. Four more live sites exist, and they matter because they are the reason this plan's primary automated gate could not previously pass:

| site | declaration | classification |
|---|---|---|
| `src/webview/design.html:1231` | `#markdown-preview code` (+ 4 sibling preview panes) → `var(--vscode-editor-font-family, 'SF Mono', Monaco, Menlo, Consolas, monospace)` | inline code in rendered markdown — monospace is correct, the *host coupling* is the bug |
| `src/webview/planning.html:1259` | same 5-selector group | same |
| `src/webview/project.html:799` | `#kanban-preview-content code` (+ 5 sibling preview panes) | same |
| `src/webview/transport.js:211` | `font:12px/1.4 var(--vscode-font-family,system-ui,sans-serif)` in the transport-error toast's `cssText` | proportional UI text — should follow the panel's own token |

These are the same defect as the `:root` tokens: a font that reads an editor setting, so the two hosts diverge whenever that setting is set. They are in scope.

> **Superseded:** "**Files to Change** — Eight `:root` blocks. Nothing else." and "`headlessPanelHtml.ts` and the 5 panel providers — no new URI placeholder is introduced, so the 12 substitution sites are untouched."
> **Reason:** The first clause is contradicted by this plan's own automated gate. `grep -rn "vscode-editor-font-family\|vscode-font-family" src/webview/` cannot return nothing while the four sites above remain, so as written the plan shipped a gate it was guaranteed to fail. The second clause is still true and is retained.
> **Replaced with:** Eight `:root` blocks **plus** the four host-variable stragglers listed above (3 markdown-preview `code` rule groups + 1 `cssText` in `transport.js`). The provider substitution sites remain untouched.

### Why a fixed system stack rather than a bundled mono face

The requirement is that the two hosts agree **on one machine** — that is the observed bug. A fixed stack (`Menlo, Consolas, monospace`) reads no setting from anywhere, so both hosts resolve it identically. Cross-machine identity (a bundled webfont) was never asked for, and bundling a new family would reintroduce exactly the kind of third-party font dependency that was deliberately removed with the Geist/GeistPixel feature (`feature_plan_20260716151401_remove-claudify-pixel-font-option.md`). Zero bundle weight, zero new family, and it fixes the reported problem completely.

### Sizing

One plan: single root cause, single deliverable, 12 edit sites, verified in one pass. Correcting *which elements* should be monospace at all is a separate concern — see `correct-font-role-assignment.md`, which depends on this plan.

## Metadata

**Tags:** frontend, ui, bugfix

**Complexity:** 3

> **Superseded:** **Complexity:** 2
> **Reason:** The scope grew from 8 `:root` blocks to 12 edit sites across 8 HTML files and one JS file, and the acceptance criterion requires a two-host side-by-side comparison with a settings mutation (`editor.fontFamily`) — more coordination than a pure token swap.
> **Replaced with:** **Complexity:** 3. Still routine: no logic, no state, no new pattern, and every edit is a declaration replacement.

## User Review Required

**None.** Both previously-open questions have been decided and moved to *Decisions Already Made*:

1. The mono face is `Menlo, Consolas, monospace` — the platform monospace, no bundled asset.
2. The fallback tails stay, and now include `Consolas` in the proportional stack for Windows symbol coverage.

## Complexity Audit

### Routine

- Replacing three CSS custom-property declarations in each of 8 `:root` blocks. No logic, no state, no new pattern.
- Converting 3 markdown-preview `code` rule groups from a host variable to `var(--font-code)`.
- One `cssText` string edit in `src/webview/transport.js`.
- Every edit is a declaration replacement inside an existing rule; no selector is added, moved, or removed.
- Completeness is grep-verifiable rather than judgement-based.

### Complex / Risky

- **Silent glyph loss.** The fallback tails are the per-glyph supplier for the 24 non-ASCII symbols Hanken lacks (verified below). A tail that is shortened — now or by a later reviewer "tidying dead cruft" — produces tofu boxes that no lint, compile, or grep detects.
- **The one edit that must not be treated as already done.** `kanban.html:38–39` carries an uncommitted hand-edited Menlo-first stopgap that still reads `var(--vscode-editor-font-family, …)`, so it still has the bug while looking fixed.
- **Cross-host verification cannot be automated.** There is no webview rendering harness; the acceptance criterion is a human side-by-side comparison with `editor.fontFamily` mutated.

## Edge-Case & Dependency Audit

### Race Conditions

- None. These are static CSS declarations parsed once at document load. No async path, no message, no ordering dependency.
- Theme switching (`applyThemeToAll` in `shell.js`, the server-stamped body class) swaps `body.theme-*` classes at runtime, but **neither Afterburner nor Claudify redeclares any font token** — so a live theme swap cannot reintroduce a host-derived font. Confirm rather than assume during the manual pass.

### Security

- No new network origin, no new asset, no new CSP directive. `font-src 'self'` (headless) and `font-src ${webview.cspSource}` (`KanbanProvider.ts:11133`) already cover every font this plan touches, because no font URL changes. **Verified: no CSP change required.**
- Removing `var(--vscode-*)` reads *reduces* the surface: panel rendering no longer varies with user editor settings.

### Side Effects

- **Every panel's chrome changes face in the browser** (Monaco → Menlo), and `implementation.html`'s chrome changes in the webview only if `editor.fontFamily` was set. This is the intended effect, not a regression.
- **Metrics shift slightly.** Menlo and Monaco have different advance widths; anything tuned against Monaco's metrics in the browser may reflow by a pixel or two. No fixed-width chrome is known to be that tight, but the manual pass should watch the count badges.
- `--font-code` is introduced **dead on arrival** — nothing references it until `correct-font-role-assignment.md` lands, except the 3 markdown-preview `code` rules this plan converts. That is deliberate (see *Decisions Already Made*).
- `transport.js`'s toast is a fixed-position error overlay shared across panels; using a nested `var()` fallback keeps it correct in both token-naming schemes (`--font-family` in panels, `--font` in `shell.html`).

### Dependencies & Conflicts

- **Blocks** `correct-font-role-assignment.md`. That plan assumes `--font-code` exists and resolves to a real monospace face in all 8 panel files, and that the proportional token already carries its symbol tail.
- **Dirty working tree on two of the eight files.** `src/webview/kanban.html` and `src/webview/shell.html` both have uncommitted changes at or adjacent to the `:root` block (`shell.html` gained a `body.theme-claudify` block immediately after `:root`, and a `.strip-glyph` rule). Edit around them; do not revert them.
- **No test asserts on the token values.** `src/test/memo-panel-style-contract.test.js:20` asserts only that `--font-mono:` is *declared* in the headless memo HTML — this plan keeps the token and changes its value, so the test still passes. (It is `correct-font-role-assignment.md` that breaks it, and that plan owns the fix.)
- `src/webview/shared-tabs.css` has one `var(--font-mono)` use and no `:root`; unchanged by this plan.
- `npm run lint` is `eslint src`, which covers `src/webview/transport.js` but not HTML/CSS. Per session directive, compilation and automated test runs are excluded from this plan's verification.

## Dependencies

No prior session IDs apply — this plan's dependencies are plan-file relationships, recorded here in place of `sess_*` references:

- **Blocks** `.switchboard/plans/correct-font-role-assignment.md` — that plan must not start until this one has landed.
- **Related (not blocking):** the GeistPixel cleanup implied by *Adjacent Finding* below. Not yet written as a plan.

## Adversarial Synthesis

**Risk Summary.** The mechanical risk is near zero — 12 declaration replacements with a grep gate — but two failure modes survive automation: silently losing the 24 symbols Hanken lacks if any fallback tail is shortened, and the uncommitted Menlo-first stopgap at `kanban.html:38–39` looking already-fixed while still reading the host variable. Mitigations: keep `Menlo, Consolas` in the proportional stack as a documented per-glyph supplier (not defensive cruft), replace the stopgap lines outright, and treat the `editor.fontFamily` mutation test as the real acceptance criterion rather than a visual "looks the same" check.

## Files to Change

Eight `:root` blocks plus four host-variable stragglers.

| file | lines | note |
|---|---|---|
| `src/webview/kanban.html` | 38–39 | carries an **uncommitted** hand-edited Menlo-first stopgap made while diagnosing — replace outright, do not edit around it |
| `src/webview/setup.html` | 34–35 | |
| `src/webview/planning.html` | 66–67 | |
| `src/webview/design.html` | 66–67 | |
| `src/webview/project.html` | 46–47 | |
| `src/webview/memo.html` | 35–36 | |
| `src/webview/implementation.html` | 43–44 | mono fallback is `'Consolas', 'Courier New'` — the only panel whose chain has no macOS-resolvable monospace before `Courier New` |
| `src/webview/shell.html` | 34–35 | browser-only; proportional token is `--font`, not `--font-family`. Has uncommitted changes immediately below `:root` |
| `src/webview/design.html` | 1231 | `#markdown-preview code` group → `var(--font-code)` |
| `src/webview/planning.html` | 1259 | `#markdown-preview code` group → `var(--font-code)` |
| `src/webview/project.html` | 799 | `#kanban-preview-content code` group → `var(--font-code)` |
| `src/webview/transport.js` | 211 | toast `cssText` → panel-token font |

**Not changed**
- `src/webview/shared-tabs.css` — has 1 `var(--font-mono)` use (line 19) but no `:root` definition. Also **dead**: its `{{SHARED_TABS_CSS_URI}}` placeholder appears in no HTML file (only `PlanningPanelProvider.ts:708–710` substitutes it), so nothing loads it. Panels inline their own `.shared-tab-btn` CSS.
- CSP — every path already permits fonts (`font-src 'self'` headless; `font-src ${webview.cspSource}` at `KanbanProvider.ts:11133`). **Verified: no CSP change required.**
- `headlessPanelHtml.ts` and the 5 panel providers — no new URI placeholder is introduced, so the 12 substitution sites are untouched.
- Packaging — no new asset, so no `webpack.config.js` or `.vscodeignore` change.
- `var(--vscode-*)` **colour** variables (e.g. `project.html:797`'s `var(--vscode-editor-foreground, #cccccc)`) — out of scope. This plan is about fonts only.

## Proposed Changes

### Step 1 — replace the font tokens in all 8 `:root` blocks

```css
--font-family: 'Hanken Grotesk', Menlo, Consolas, sans-serif;
--font-mono:   Menlo, Consolas, monospace;
--font-code:   Menlo, Consolas, monospace;
```

> **Superseded:** `--font-family: 'Hanken Grotesk', Menlo, sans-serif;`
> **Reason:** `Menlo` does not exist on Windows, so on Windows the proportional stack collapses to `'Hanken Grotesk', sans-serif` and all 24 symbols Hanken lacks fall through to whatever the OS picks. This plan already applies exactly this reasoning to the mono stacks ("`Consolas` is retained … as the Windows equivalent — it is genuinely reachable there"); the proportional stack needs it for the same reason, because it holds the same per-glyph-supplier role.
> **Replaced with:** `--font-family: 'Hanken Grotesk', Menlo, Consolas, sans-serif;` — `Menlo` supplies the symbols on macOS, `Consolas` on Windows, `sans-serif` terminates the chain.

- `Menlo, Consolas` in the **proportional** stack is the per-glyph supplier for the 24 symbols Hanken lacks. It is not a "in case the woff2 fails" entry.
- `Consolas` is retained in the mono stacks as the Windows equivalent — it is genuinely reachable there, unlike on macOS.
- `--font-mono` and `--font-code` are intentionally identical here. They exist as two names so that `correct-font-role-assignment.md` can move the chrome off monospace with a one-line edit instead of a re-audit.
- In `shell.html` the proportional token is named `--font`; keep its name and change only its value.

No `var(--vscode-*)` may remain in any font token in any panel.

### Step 2 — convert the 3 markdown-preview `code` rule groups

`design.html:1231`, `planning.html:1259`, `project.html:799`:

```css
/* was: font-family: var(--vscode-editor-font-family, 'SF Mono', Monaco, Menlo, Consolas, monospace); */
font-family: var(--font-code);
```

Leave `font-size: 1em` and `line-height: 1.357em` untouched — the accompanying comment ("Match VS Code: inline code is same size as surrounding text") describes sizing, not family, and remains true.

Rendered inline code is monospace-by-alignment content, so `--font-code` is the correct token under the rubric in `correct-font-role-assignment.md`. This plan converts them because the *host coupling* is this plan's defect; their tier assignment is not in question.

### Step 3 — `src/webview/transport.js:211`

```js
// was: 'font:12px/1.4 var(--vscode-font-family,system-ui,sans-serif);' +
'font:12px/1.4 var(--font-family, var(--font, system-ui, sans-serif));' +
```

The nested fallback covers both naming schemes: panels define `--font-family`, `shell.html` defines `--font`. If neither is in scope (the toast is a `position: fixed` overlay appended to `document.body`, so one of them always is), it degrades to `system-ui, sans-serif`.

**Edge case:** if `var()` substitution inside the `font` shorthand behaves unexpectedly in any target browser, split the shorthand into `font-size`/`line-height`/`font-family` longhands rather than reverting to a host variable. See *Uncertain Assumptions*.

## Verification Plan

Per session directive, compilation and automated test execution are excluded. The gates below are the greps (each independently runnable) plus the manual pass, which is the real gate — there is no webview rendering harness.

### Automated Tests

- `grep -rn "vscode-editor-font-family\|vscode-font-family" src/webview/` returns **nothing** — no font declaration anywhere under `src/webview/` still reaches for a host variable. This is the primary gate, and it now covers the 4 stragglers as well as the 8 `:root` blocks.
- `grep -rn "SF Mono\|Cascadia Code" src/webview/` returns **nothing** — the unresolvable faces are gone.
- `grep -rn -- "--font-code:" src/webview/` returns exactly **8** — one per `:root` block.
- `grep -rn -- "var(--font-code)" src/webview/` returns exactly **3** — the markdown-preview `code` groups. (This count rises to 33 after `correct-font-role-assignment.md` lands; see that plan.)
- All 8 files declare `--font-family` (or `--font` in `shell.html`), `--font-mono` and `--font-code`, and every stack ends in a generic (`sans-serif` or `monospace`).
- `grep -rn "Menlo" src/webview/*.html | wc -l` — every proportional and mono stack retains its `Menlo, Consolas` tail. A drop here is the tofu regression.
- Existing test `src/test/memo-panel-style-contract.test.js:20` (`assert.match(html, /--font-mono:/)`) must still pass unchanged — this plan keeps the token and changes only its value.

### Manual — the whole point is that both hosts agree

Run the extension and the browser cockpit **side by side on the same display** (this is how the bug was found).

**Which panels are comparable:** the browser cockpit serves `shell` + `kanban`, `project`, `planning`, `design`, `setup`, `memo` (`headlessPanelHtml.ts:106–318`). So **6 panels have both hosts and can be compared directly**. `shell.html` is browser-only (no webview counterpart) and `implementation.html` is webview-only — it is served solely by `TaskViewerProvider.ts:20618–20620` and has no headless route.

- [ ] **The two windows are typographically identical** across all 6 dual-host panels. Column headers, agent labels, count badges, "Complexity: …", card buttons, tab bar — same face, same weight, same widths in both.
- [ ] The browser no longer renders Monaco. Confirm via *Developer: Open Webview Developer Tools* → inspect a `.column-name` → computed `font-family`, and compare against the same element in the browser's own devtools.
- [ ] **Set `editor.fontFamily` to something distinctive (e.g. `"Courier New"`) and reload both. Neither window changes.** This is the regression the Menlo-first stopgap would have passed, and it is the actual acceptance criterion for this plan. Check `implementation.html` (webview) here too — it is the panel this test exists for.
- [ ] Rendered inline code in the markdown preview panes (`design`, `planning`, `project`) is still monospace and still sized to match surrounding text.
- [ ] Trigger a transport error (e.g. stop the API server and interact) and confirm the toast at the bottom of the viewport renders in Hanken, not a fallback serif.
- [ ] Symbol glyphs still render — no tofu boxes. Eyeball `▸ ▾ ● ─ └ ✓ ✕ ✗ ⚙ ⚠ ⚡ → ↳ ⇨ ⋮ ⋯ ↻ ⟲ ⎇ ⤢` across expand chevrons, status dots, tree views, tick marks, warning badges and overflow menus.
- [ ] Emoji still render in colour (`✅ ❌ ⏳ 🔒 🔴 🟢 📋 📄 💡 🌐 🖼`).
- [ ] Hanken still loads and applies to card titles in both hosts (this plan must not regress it) — Network/Fonts tab shows `HankenGrotesk-Variable.woff2` loaded, not a fallback.
- [ ] Fonts render with **networking disconnected**.
- [ ] Both themes (Afterburner, Claudify) look correct. Neither redefines these tokens, so both should follow automatically — confirm rather than assume.

> **Superseded:** "`implementation.html` in the browser no longer renders Courier New." (listed as a verification item, and "worst case today" in the file table)
> **Reason:** Unverifiable as written, because `implementation.html` has no browser host. It is served only by `TaskViewerProvider.ts:20618–20620`; `headlessPanelHtml.ts` has no route for it (verified). Its `'Consolas', 'Courier New'` fallback therefore only fires where `--vscode-editor-font-family` is absent — which never happens for this panel, since its only host is the VS Code webview that injects it. The Courier New rendering was inferred from the fallback chain, not observed.
> **Replaced with:** `implementation.html`'s token is still wrong and is still fixed by this plan — it is the panel with the weakest fallback chain, so it is the one that degrades worst *if* it ever gains a headless route, and it is the panel most affected by an `editor.fontFamily` change today. Verify it via the `editor.fontFamily` mutation test in the webview, not via a browser comparison that cannot be performed.

## Risks / Sequencing Notes

- **The stopgap on disk.** `src/webview/kanban.html:38–39` currently carries an **uncommitted** hand-edited Menlo-first fallback made while diagnosing this. It still reads `var(--vscode-editor-font-family, …)` and therefore still has the bug. Replace those two lines; do not treat them as already done.
- **Do not "tidy" the fallback tails.** They look like dead defensive cruft and are not. A reviewer removing `Menlo, Consolas` from the proportional stack will silently tofu 24 symbols.
- **`kanban.html` and `shell.html` are dirty.** Both have uncommitted work adjacent to `:root` (a Claudify accent block and a `.strip-glyph` mask rule in `shell.html`). Land this plan's edits alongside that work, not over it.
- Cross-machine consistency is explicitly *not* delivered: a Windows user gets Consolas where a macOS user gets Menlo. Both hosts agree on any given machine, which is the requirement.
- This plan must land **before** `correct-font-role-assignment.md`. That plan deletes `--font-mono` and depends on `--font-code` existing everywhere.

## Resolved Assumptions

Settled by direct measurement this session. Do not re-open or re-research these.

- **`headlessPanelHtml.ts` injects no `--vscode-*` variables.** The substring `vscode-` occurs exactly once in the file, inside a comment.
- **Hanken Grotesk contains none of the 24 claimed symbols.** Checked its `cmap` via fontTools: all of `→ ↳ ↻ ⇨ ⋮ ⋯ ⎇ ─ └ ▲ ▶ ▸ ▼ ▾ ● ⚙ ⚠ ⚡ ✓ ✕ ✗ ✥ ⟲ ⤢` are absent (24/24). The fallback tail is load-bearing, exactly as claimed.
- **Hanken is a single-axis variable font** (`fvar`: `wght` 100–900, default 400) with GSUB features `ccmp dnom frac liga locl` + `numr` and GPOS `kern mark mkmk`. (The earlier feature list conflated GSUB and GPOS; `kern`/`mark`/`mkmk` are GPOS.)
- **`implementation.html` has no headless/browser route** — served only by `TaskViewerProvider`.
- **The browser cockpit serves 7 files** — `shell`, `kanban`, `project`, `planning`, `design`, `setup`, `memo` — so 6 panels are directly comparable across hosts.
- **`shared-tabs.css` is dead** — its `{{SHARED_TABS_CSS_URI}}` placeholder exists in no HTML file.
- **No test asserts a font token's *value*.** Only `memo-panel-style-contract.test.js:20` asserts a token's *existence* (`--font-mono:`), which this plan preserves.
- **`kanban.html:38–39` still reads the host variable** in the working tree — confirmed against `git diff`.

## Uncertain Assumptions

The following are external platform/standards behaviours that cannot be settled by reading this repository. The user has been advised to run web research to confirm them before implementation; a ready-to-run research prompt was supplied in chat.

1. **`Consolas` is present on Windows and covers the symbol set** that `Menlo` covers on macOS — the basis for adding it to the proportional stack. Untestable from a macOS dev machine.
2. **The four symbols `⋮ ⎇ ⟲ ⤢` resolve via OS-level font fallback** on macOS (and have some resolution on Windows) rather than rendering as tofu, given that neither Hanken nor Menlo contains them.
3. **`var()` substitution inside the `font` shorthand, with a nested `var()` fallback**, is reliably supported in the browsers that host these panels (Electron/Chromium for VS Code webviews; the user's browser for the cockpit).
4. **VS Code injects `--vscode-editor-font-family` into every webview**, and its macOS default resolves to `Menlo, Monaco, 'Courier New', monospace` — the basis for the claim that the two hosts coincidentally agree today.

## Adjacent Finding (not in scope)

The Geist/GeistPixel family was removed as a feature but its plumbing remains, and a future agent reading the repo will wrongly conclude the family is available:

- Dead `@font-face { font-family: 'GeistPixel'; … }` blocks in `kanban.html:17`, `memo.html:16`, `design.html:27`, `project.html:14`, `planning.html:26`
- `--display-font: 'GeistPixel'` in `design.html:54`, `project.html:38`, `planning.html:54` — each annotated in-file as *"unused; H1 inherits Hanken Grotesk (pixel-font H1 feature removed)"*
- One remaining live use: `memo.html:87` — `.memo-header .section-label { font-family: 'GeistPixel', var(--font-mono); }`, with an in-file comment explaining it was applied deliberately "so the panel is not shipping a font that no selector can match"
- 10 `GEIST_PIXEL_FONT_URI` substitution sites across `headlessPanelHtml.ts` (×6), `DesignPanelProvider.ts:1025`, `PlanningPanelProvider.ts:725` and `:1807`, `KanbanProvider.ts:11193`
- 5 shipped-but-unused assets: `designs/GeistPixel-{Circle,Grid,Line,Square,Triangle}.woff2`

Worth its own cleanup plan; deliberately left out of this one. Note that `correct-font-role-assignment.md` must preserve `memo.html:87` rather than strip it, because deciding the pixel header's fate belongs to that cleanup, not to a font-role pass.

## Decisions Already Made (do not re-litigate)

- **No font token reads a host setting.** This is the defect; a fixed stack is the fix. Reintroducing `var(--vscode-editor-font-family, …)` "so code matches the user's editor" recreates the bug.
- **No new font family is bundled.** The Geist family was removed deliberately; this plan does not add a replacement.
- **The mono face is `Menlo, Consolas, monospace`** — the platform monospace. Overruling this means picking a family, licensing it, converting to `woff2`, adding an `@font-face` to 8 files, and wiring a new `{{…_FONT_URI}}` placeholder through **12** substitution sites (6 in `headlessPanelHtml.ts` at lines 175/201/242/280/306/329, plus `KanbanProvider.ts:11188`, `SetupPanelProvider.ts:1606`, `PlanningPanelProvider.ts:730` and `:1812`, `DesignPanelProvider.ts:1030`, `TaskViewerProvider.ts:20657`) — roughly the difference between complexity 3 and complexity 6. The escape hatch is one line per file if a brand monospace is later wanted; the rest of this plan stands unaltered.
- **The fallback tails are load-bearing — do not strip them.** Font fallback is per-glyph, so the tail of each stack renders the 24 symbols Hanken lacks (verified). `Menlo` supplies them on macOS, `Consolas` on Windows.
- **`--font-code` is created now even though it is identical to `--font-mono`**, so the follow-on plan is a one-line change per file. It is deliberately dead on arrival apart from the 3 markdown-preview `code` rules.
- **Colour host variables are out of scope.** Only font declarations are decoupled here.

---

**Recommendation:** Complexity 3 → **Send to Intern.** Twelve mechanical declaration replacements with a hard grep gate. The one instruction that must not be skipped is the manual two-host pass with `editor.fontFamily` mutated — that, not the greps, is what proves the decoupling.
