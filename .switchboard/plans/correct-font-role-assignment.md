# Correct the Font-Role Assignment: Monospace Only Where It Earns It

## Goal

Stop using the monospace face as the extension's default UI typeface. Monospace is a **functional** choice — it exists so characters align by column — so it should be confined to content where alignment matters: code, file paths, raw payloads, log output, shell commands, and stacked numerics. Everything else — tabs, buttons, headers, labels, selects, modals, toasts, empty states — inherits Hanken Grotesk from `body`, as ordinary UI chrome.

End state: `--font-mono` is **deleted**, `--font-code` (the platform monospace) is applied to an explicit allowlist of **29 rules**, and every other site simply carries no `font-family` declaration at all.

### Problem

The extension uses monospace as its house UI font, not as a functional typeface. Measured across `src/webview/*.html` and `*.css`:

- **132 CSS rules** apply `font-family: var(--font-mono)` inside `<style>` blocks
- **135 uses in JS-generated markup** — inline `style="…"` attributes and `cssText` assignments (82 in `kanban.html`, 41 in `setup.html`, 9 in `implementation.html`, 3 in `design.html`)
- **1 more** in the (dead) `shared-tabs.css`
- **268 sites total**

> **Superseded:** "**136 CSS rules** apply `font-family: var(--font-mono)`" and "**129 inline `style="…"` uses** … (76 in `kanban.html`, 41 in `setup.html`, 9 in `implementation.html`, 3 in `design.html`)" — total 265.
> **Reason:** Re-measured programmatically this session by classifying every `var(--font-mono)` occurrence as inside or outside a `<style>` block. The true split is 132 / 135 / 268, and the per-file numbers drift by up to 6 (kanban's JS-side count is 82, not 76). The original figures came from a manual sweep.
> **Replaced with:** 132 CSS + 135 JS/inline + 1 in `shared-tabs.css` = **268**. These counts are **informational only** — the completeness gate is the grep returning zero, not the arithmetic. Do not spend time reconciling a count that shifts as the working tree changes.

Of the 132 CSS rules, the overwhelming majority have no alignment requirement whatsoever. `.shared-tab-btn` is monospace in **six** separate files (`kanban`, `setup`, `project`, `design`, `planning`, and `shared-tabs.css`) — tab labels have nothing to align with. So are `.action-btn`, `.icon-btn`, `.card-btn`, `.strip-btn`, `.secondary-btn`, `.mini-action-btn`, `.recover-selected-btn`, `.column-name`, `.column-agent`, `.kanban-title`, `.section-label`, `.subsection-header`, `.modal-title`, `.modal-label`, `.popup-label`, `.plan-select`, `.agent-name`, `.toast-notification`, `.empty-state`, `.hint-text`, and `.card-meta`. None of these are traditionally set in a monospace face, and none of them gain anything from it.

The practical consequence on the board: Hanken is doing exactly one visible job — the card titles (`.plan-title` declares no `font-family`, so it inherits `body`). The tab bar, column headers, agent labels, count badges, `Complexity: …`, every button, and `No plans` are all monospace. Two typefaces, with the split falling along no principle.

### Relationship to the prior decision

`.switchboard/plans/consolidate-afterburner-theme.md:34` records *"Mono elements (`--font-mono`) stay mono in both themes per explicit user decision"*, and line 10 describes the mono design language as applying to *"labels/inputs/buttons/statuses"*.

This plan does **not** contradict that. Mono elements stay mono. What this plan corrects is the **definition of a mono element** — the prior wording assumed labels, buttons and statuses were mono elements by nature, which is the assumption being rejected. A tab is not a mono element. A button is not a mono element. A file path is. `docs/visual_theme_differences_audit.md:233` already states the intended model — *"Hanken is the **body** font"* — and this plan is what makes the code match it.

### Sizing

One plan, one rubric, phased by file. It is a single deliverable (correct the font-role assignment) applied uniformly; splitting per panel would mean re-deriving the classification rubric eight times, and a half-applied rubric is worse than either end state — it leaves two typefaces split along no principle, which is the bug. Each phase is independently verifiable and can be reviewed on its own.

## Metadata

**Tags:** frontend, ui, ux, refactor

**Complexity:** 6

## User Review Required

**None.** Both previously-open questions have been decided and are recorded in *Decisions Already Made*:

1. **Tabular numerics stay on `--font-code`** (Tier 2 survives, 8 rules).
2. **Glyph coverage** is handled by the fallback tail, which `decouple-webview-fonts-from-host.md` owns and this plan must not shorten.

## Complexity Audit

### Routine

- The rubric is decided; per-site work is mechanical classification against an explicit allowlist.
- Every CSS edit is either "swap the token" (29 rules) or "delete the declaration" (everything else).
- Completeness is a grep, not a judgement call — that is the whole point of the allowlist design.
- No selectors are added or renamed; no HTML structure changes.

### Complex / Risky

- **135 of the 268 sites live inside JS template strings and `cssText` assignments.** A careless regex sweep produces broken markup or dropped sibling properties — a rendering failure, not a font regression. `kanban.html` alone holds 128 sites.
- **Silent tofu.** Deleting a `font-family` moves an element onto the proportional stack, which lacks 24 of the symbols the webviews use. Invisible to lint, compile, and grep.
- **One rule must be split, not swapped.** `setup.html:161` bundles `.startup-row input` (Tier 1 — paths, tokens, URLs) with `.startup-row select` (Tier 3 — dropdowns) in a single rule.
- **Two existing tests assert on `--font-mono` and will fail.** Both are in scope for this plan (see *Dependencies & Conflicts*).
- **One deliberate exception must be preserved.** `memo.html:87` is a documented live GeistPixel use whose mono token is a *fallback tail*, not a tier assignment.
- Metrics/spacing fallout across 7 panels once proportional advance widths replace monospace ones.

## Edge-Case & Dependency Audit

### Race Conditions

- None. All edits are static CSS or static style strings evaluated at element-creation time. No async ordering, no message passing.
- Runtime theme swapping (`applyThemeToAll` in `shell.js`) changes `body.theme-*` classes only; neither Afterburner nor Claudify redeclares a font token, so no theme can reintroduce mono after the sweep. Confirm during the manual pass.

### Security

- No security surface. No network origin, asset, CSP directive, or data path changes. `font-src` is already satisfied because no font URL changes.

### Side Effects

- **Every panel's chrome changes typeface.** That is the deliverable, not a regression.
- **Layout reflow is expected.** Proportional advance widths and a different x-height mean fixed-width chrome tuned against a monospace character count may wrap or clip. Phase 10 exists for this.
- **Unresolvable-`var()` trap.** After `--font-mono` is deleted, any surviving `var(--font-mono)` reference does **not** fall back to the rest of its stack — an unresolvable custom property makes the whole declaration invalid at computed-value time, so the element inherits instead. `memo.html:87` (`font-family: 'GeistPixel', var(--font-mono)`) is the one place this bites, and it would silently drop the pixel face's fallback tail. The zero-grep gate catches it; the fix is specified in Phase 8.
- **`--font-code` is unused in `shell.html`.** `shell.html` has only Tier 3 mono sites (`.strip-icon`, `#strip-error`), so its `--font-code` token ends up declared-but-unreferenced. Keep it for parity across the 8 panels; do not "tidy" it away.
- **`.strip-icon`'s font declaration is already vestigial.** Uncommitted work replaced the rail's text glyphs with masked SVGs (`.strip-glyph` uses `mask-image` + `background-color: currentColor`), so `font-size: 18px; font-family: var(--font-mono)` on `.strip-icon` no longer paints anything. Deleting it is provably zero-risk.

### Dependencies & Conflicts

- **Blocked by `decouple-webview-fonts-from-host.md`** — see *Dependencies*.
- **Two existing tests fail and must be updated by this plan:**
  - `src/test/memo-panel-style-contract.test.js:20` — `assert.match(html, /--font-mono:/)` against the headless memo HTML. This plan deletes that token. **Fix:** change the assertion to `/--font-code:/`.
  - `src/test/agent-cli-input-background-regression.test.js:15` — a sequence-sensitive regex over `src/webview/implementation.html` requiring `.startup-row input[type="text"] { … font-family: var(--font-mono); font-size: 11px; … }`. **Fix:** change `var\(--font-mono\)` to `var\(--font-code\)` in the regex. The declaration stays (this selector is Tier 1), so only the token name changes.
- **Dirty working tree.** `src/webview/kanban.html` and `src/webview/shell.html` have uncommitted changes (a `body.theme-claudify` block and the `.strip-glyph` mask rule in `shell.html`). Edit around them.
- **`shared-tabs.css` is dead.** Its `{{SHARED_TABS_CSS_URI}}` placeholder appears in no HTML file — only `PlanningPanelProvider.ts:708–710` substitutes it, and `src/test/browser-panel-scrollbar-contract.test.js:8` documents it as dead. Its one edit is required for the grep gate but **will produce no visible change**; do not hunt for one.
- **`.plan-id` appears 17 times in `kanban.html`** but only once as a mono-declaring CSS rule. Allowlist counts are per-**rule**, not per-occurrence-of-the-class-name.
- `npm run lint` is `eslint src` — it does not cover HTML/CSS. Per session directive, compilation and automated test runs are excluded from the verification plan; the test-file edits above are still required so the suite is correct when next run.

## Dependencies

No prior session IDs apply — this plan's dependencies are plan-file relationships, recorded here in place of `sess_*` references:

- **Blocked by** `.switchboard/plans/decouple-webview-fonts-from-host.md`. That plan removes `var(--vscode-*)` from the font tokens, establishes `--font-code` as a fixed `Menlo, Consolas, monospace` stack in all 8 `:root` blocks, and puts the symbol tail on the proportional token. This plan assumes all of that is already true. **No font family is bundled** — the Geist family was removed from the extension deliberately and is not a candidate here.
- **Supersedes** `collapse-mono-chrome-to-hanken.md`, which proposed flipping the `--font-mono` token wholesale to Hanken. That approach was wrong: it would have made genuinely-mono content proportional, because a single token serves both roles. That plan file has already been deleted; if a card for it reached the board, remove it there too.
- **Defers to** the GeistPixel cleanup described in `decouple-webview-fonts-from-host.md`'s *Adjacent Finding* for the fate of `memo.html:87`'s pixel header. This plan preserves it.

## Adversarial Synthesis

**Risk Summary.** The dangerous 135 sites are the JS-embedded ones, where a bad edit breaks rendering rather than styling; the second risk is silent tofu from deleting a `font-family` and moving text onto a stack missing 24 of the symbols in use; the third is the deleted `--font-mono` token turning a surviving reference into an invalid declaration that inherits rather than falling back. Mitigations: edit per-file and reload after each; keep the `Menlo, Consolas` tail intact (owned by the dependency plan) and run an explicit glyph sweep; rely on the zero-grep gate to prove no reference survives, with `memo.html:87` handled by name. The allowlist-not-blocklist design is what makes completeness mechanically checkable instead of a matter of reviewer diligence.

## The Rubric

Monospace is justified only by **alignment**. Apply in this order:

1. **Tier 1 — code, paths, raw output, commands.** Content where a human reads structure out of column position: fenced code, markdown source, file paths, IDs/hashes/tokens, URLs, shell commands, JSON payloads, log output. → `--font-code`.
2. **Tier 2 — stacked numerics.** Numbers in a vertical list that change in place or align down a column. → `--font-code`.
3. **Tier 3 — everything else.** No `font-family` declaration at all; inherits Hanken from `body`.

This is an **allowlist, not a blocklist** — the 135 JS-side uses cannot all be enumerated in a plan, so the executable rule is: *strip every `var(--font-mono)`, then apply `--font-code` to exactly the rules listed below.* Anything not listed is Tier 3 by construction.

### Tier 1 allowlist (21 rules)

| file | selectors |
|---|---|
| `implementation.html` | `.markdown-body code`, `.markdown-body pre`, `.activity-payload`, **`.startup-row input[type="text"]`** |
| `kanban.html` | `#promptPreview`, `.example-paths code`, `.plan-id`, `.agents-tab-custom-agent-item-command`, **`.startup-row input[type="text"]`** |
| `setup.html` | `.db-path-display`, `.db-custom-path-input`, **`.startup-row input`** (split from `.startup-row select`) |
| `project.html` | `.active-path-btn`, `.markdown-editor` |
| `planning.html` | `.kanban-log-modal`, `#kanban-preview-meta-bar`, `.markdown-editor`, `.cp-textarea` |
| `design.html` | `.kanban-log-modal`, `#kanban-preview-meta-bar`, `.markdown-editor` |

> **Superseded:** "### Tier 1 allowlist (14)" — the same table without the three `.startup-row` entries, and a stated total of "~21 selectors" across both tiers.
> **Reason:** Two errors. (a) **Arithmetic:** the original table listed 18 selectors, not 14, and Tier 2 listed 8, not 7 — so the combined figure was 26, not ~21. Since the count is an automated gate, a wrong count means the gate either never passes or passes while incomplete. (b) **A genuine rubric miss:** three `.startup-row` rules hold shell commands and file paths — Tier 1 content by this plan's own rubric — and were absent from the allowlist. `kanban.html:1198` and `implementation.html:1232` style the agent startup-command fields (`placeholder="e.g. agy --approval-mode auto_edit"`); `setup.html:161` styles 21 non-checkbox fields dominated by paths, API tokens and URLs (`plan-ingestion-folder-input`, `clickup-ticket-import-folder`, `control-plane-parent-input`, `multi-repo-parent-dir`, `board-state-export-remote-url`, the three `*-token-input` fields). The `implementation.html` one is additionally pinned by an existing regression test, so stripping it would have failed the suite.
> **Replaced with:** **Tier 1 = 21 rules**, Tier 2 = 8, **total 29** — verified programmatically: each of the 26 original allowlist selectors declares mono in exactly one rule, plus the three `.startup-row` rules.

**Judgement notes** (decided — do not re-litigate per site):
- `.markdown-editor` is a raw-markdown source editor — fences and tables need alignment → Tier 1.
- `.kanban-log-close` is a close **button** on the log modal, not log content → Tier 3 despite the name.
- `.activity-payload` is raw JSON → Tier 1; `.activity-type` beside it is a label → Tier 3.
- `.startup-row input` in `setup.html` covers checkboxes too. `font-family` is inert on a checkbox, so including them costs nothing.
- `.modal-input, .modal-textarea` (`implementation.html:958`, `kanban.html:1752`, `setup.html:420`, `memo.html:125`) → **Tier 3**. These are generic free-text fields; every modal field that genuinely holds structured content already has its own selector (`.db-custom-path-input`, `.cp-textarea`, `.markdown-editor`).
- `.agent-input` (`implementation.html:731`, the standby message box) → **Tier 3**. It carries prose to a running agent, not commands.
- All `select` elements → **Tier 3**, including `.plan-select`, `.column-select`, `.workspace-filter-select`, `.workspace-project-select`, `.tickets-hierarchy-nav select`, `.controls-strip select`, `.startup-row select`.
- Single-value number fields (`.orchestrator-interval input`, `.remote-number-input`) → **Tier 3**. Nothing stacks under them.

### Tier 2 allowlist (8 rules)

`.activity-time`, `.orchestrator-timer` (`implementation`) · `.tickets-comment-date`, `.cm-thread-date`, `.cm-reply-date` (`planning`) · `.tickets-comment-date` (`design`) · `.column-count`, `.autoban-timer-badge` (`kanban`)

**Decided: these stay on `--font-code`.** `font-variant-numeric: tabular-nums` is not an option — verified against Hanken's GSUB table, which contains `ccmp dnom frac liga locl numr` and **no `tnum`** — so proportional figures cannot be aligned by a feature flag. `.orchestrator-timer` and `.autoban-timer-badge` tick live, so proportional digits would visibly jitter every second; `.column-count` sits in a fixed header where a `9 → 10` transition would nudge the layout; the three date selectors align down vertical comment lists. The cost is a small monospace island inside otherwise-Hanken chrome, which is exactly what Tier 2 authorises.

> **Superseded:** "**Tabular numerics have no clean answer — decide before Phase 1.** … Two options: (a) Keep them on `--font-code` … (b) Move them to Hanken … Pick one."
> **Reason:** Left as an open question, this blocks Phase 1 on a decision that the plan already had the evidence to make. Hanken's missing `tnum` is now confirmed by direct inspection of the font binary, and the affected elements include two live-ticking counters — which settles it.
> **Replaced with:** Option (a), stated as a decision above. The allowlist is final at 8 Tier 2 rules; no pre-Phase-1 gate remains.

## Files to Change

| file | CSS rules | JS/inline uses | total |
|---|---|---|---|
| `src/webview/kanban.html` | 46 | 82 | 128 |
| `src/webview/setup.html` | 11 | 41 | 52 |
| `src/webview/implementation.html` | 30 | 9 | 39 |
| `src/webview/planning.html` | 17 | 0 | 17 |
| `src/webview/design.html` | 11 | 3 | 14 |
| `src/webview/project.html` | 11 | 0 | 11 |
| `src/webview/memo.html` | 4 | 0 | 4 |
| `src/webview/shell.html` | 2 | 0 | 2 |
| `src/webview/shared-tabs.css` | 1 | 0 | 1 |
| **total** | **133** | **135** | **268** |

Plus two test files:

| file | change |
|---|---|
| `src/test/memo-panel-style-contract.test.js` | line 20: `/--font-mono:/` → `/--font-code:/` |
| `src/test/agent-cli-input-background-regression.test.js` | line 15: `var\(--font-mono\)` → `var\(--font-code\)` |

## Proposed Changes

### Phase 0 — Preconditions (verify, do not edit)

`decouple-webview-fonts-from-host.md` owns the `:root` blocks. Do not edit them in this phase — assert them:

1. All 8 `:root` blocks declare `--font-code: Menlo, Consolas, monospace;`.
2. All 8 declare the proportional token with its symbol tail — `--font-family: 'Hanken Grotesk', Menlo, Consolas, sans-serif;` (named `--font` in `shell.html`).
3. `grep -rn "vscode-editor-font-family\|vscode-font-family" src/webview/` returns nothing.

If any assertion fails, stop: the dependency has not landed.

> **Superseded:** "**Phase 0 — Preparation.** 1. In all 8 panel `:root` blocks, add the symbol tail to the proportional token so Tier 3 text keeps its glyphs: `--font-family: 'Hanken Grotesk', Menlo, sans-serif;` … 2. Resolve the Tier 2 decision above and fix the allowlist before touching any file."
> **Reason:** Step 1 duplicated an edit that `decouple-webview-fonts-from-host.md` already makes to the same 8 `:root` blocks — two plans writing the same declaration, which is a merge conflict waiting to happen and leaves ownership of the shared surface ambiguous. Step 2 is now moot: the Tier 2 decision is made and the allowlist is final.
> **Replaced with:** Phase 0 is a **precondition check**, not an edit. The dependency plan owns every `:root` font declaration; this plan touches `:root` exactly once, in Phase 9, to delete `--font-mono` after nothing references it.

### Phases 1–9 — One phase per file, in this order

Order is by exposure, so the riskiest file is done first while attention is highest:
**1.** `kanban.html` (46 + 82) · **2.** `setup.html` (11 + 41) · **3.** `implementation.html` (30 + 9) · **4.** `planning.html` (17) · **5.** `design.html` (11 + 3) · **6.** `project.html` (11) · **7.** `memo.html` (4) · **8.** `shell.html` (2) · **9.** `shared-tabs.css` (1)

For each file:

1. **Tier 1/2 rules** (per the allowlists): change `font-family: var(--font-mono)` → `font-family: var(--font-code)`.
2. **Every other CSS rule**: **delete** the `font-family: var(--font-mono);` declaration outright. Do not replace it with `var(--font-family)` — the correct end state is no declaration, inheriting `body`. A rule whose only declaration was `font-family` should be removed entirely.
3. **JS/inline uses**: strip `font-family: var(--font-mono);` from the `style="…"` / `cssText = '…'` fragment, leaving the other properties intact. Remove the whole `style` attribute if `font-family` was its only property. All are Tier 3 unless the element carries a Tier 1/2 class — inspect each rather than blind-replacing, since these are JS template strings and a botched edit breaks rendering rather than styling. Reload the panel after finishing each file.

**Per-file specifics that are not a plain swap-or-strip:**

- **Phase 2 — `setup.html:161` must be split.** The rule is `.startup-row input, .startup-row select { … font-family: var(--font-mono); font-size: 11px; }`. Split it so the input keeps a monospace face and the select does not:
  ```css
  .startup-row input,
  .startup-row select {
      width: 100%;
      background: #0a0a0a;
      color: var(--text-primary);
      border: 1px solid var(--border-color);
      padding: 6px 8px;
      font-size: 11px;
  }
  .startup-row input {
      font-family: var(--font-code);
  }
  ```
  Leave the `:focus, :hover` rule at `setup.html:172–175` untouched — it declares no font.
- **Phase 3 — `implementation.html:1232`** (`.startup-row input[type="text"]`) is Tier 1 **and** is pinned by `src/test/agent-cli-input-background-regression.test.js:15`, whose regex requires the declarations in order: `background` → `color` → `border` → `font-family` → `font-size`. Keep that order when swapping the token, and update the test's regex in the same commit.
- **Phase 7 — `memo.html:87` is a preserved exception.** `.memo-header .section-label { font-family: 'GeistPixel', var(--font-mono); }` is a deliberate, in-file-documented pixel-display use. Do **not** strip it and do **not** treat it as Tier 3. Change only the fallback tail:
  ```css
  .memo-header .section-label { font-family: 'GeistPixel', var(--font-code); }
  ```
  Here `--font-code` is a *fallback*, not a tier assignment: it renders only for glyphs GeistPixel lacks. Whether the pixel header should exist at all belongs to the GeistPixel cleanup (see the dependency plan's *Adjacent Finding*), not to this plan. Leaving `var(--font-mono)` here would be worse than a font regression — once `--font-mono` is deleted the declaration becomes invalid at computed-value time and the element inherits, silently dropping the pixel face's fallback entirely.
- **Phase 8 — `shell.html`** has two Tier 3 sites: `.strip-icon` (line 81) and `#strip-error` (line 149). Both get the declaration deleted. `.strip-icon`'s is already inert — the rail now renders masked SVG glyphs via `.strip-glyph`, not text — so this is a pure cleanup. `shell.html` ends up with `--font-code` declared but unreferenced; keep it for parity with the other panels.
- **Phase 9 — `shared-tabs.css`** is dead (nothing loads it). Strip its one `.shared-tab-btn` mono declaration for the grep gate and expect **no visible change**.

### Phase 10 — Delete the token and update the tests

1. Delete the `--font-mono` declaration from all 8 `:root` blocks. Nothing may reference it.
2. `src/test/memo-panel-style-contract.test.js:20` — `assert.match(html, /--font-mono:/)` → `assert.match(html, /--font-code:/)`.
3. `src/test/agent-cli-input-background-regression.test.js:15` — `font-family: var\(--font-mono\);` → `font-family: var\(--font-code\);`.

### Phase 11 — Spacing and metrics audit

Hanken is proportional, with different advance widths and x-height than the monospace face it replaces. Walk all 7 panels and fix anything that now wraps, clips, or sits wrong. Expected hotspots: `.plan-status-tag` (9px uppercase with `letter-spacing: 0.5px`), `.column-name`, `.card-meta`, fixed-width buttons in the Completed column (`RECOVER`, `✓ Done`), and any `width`/`min-width` tuned against a monospace character count.

## Verification Plan

Per session directive, compilation and automated test execution are excluded. The greps below are the mechanical gates; the manual pass is the real one, since no webview rendering harness exists.

### Automated Tests

- `grep -rn -- "var(--font-mono)" src/webview/ src/test/` returns **zero results**. This is the primary gate — the allowlist design makes completeness a grep, not a judgement call. Including `src/test/` is what catches the two test files.
- `grep -rn -- "--font-mono:" src/webview/` returns **zero results** — the token itself is gone.
- `grep -rn -- "var(--font-code)" src/webview/` returns exactly **33**: the 29 allowlist rules, the 3 markdown-preview `code` groups converted by the dependency plan, and `memo.html:87`'s GeistPixel fallback tail.
- `grep -rn -- "--font-code:" src/webview/` returns exactly **8** — one per `:root` block, `shell.html` included.
- All 8 `:root` blocks declare the proportional token with `Menlo, Consolas` in the tail. A shortened tail is the tofu regression.
- `grep -rn -- "var(--font-family)" src/webview/` has not grown — Tier 3's end state is *no declaration*, not an explicit proportional token.

### Manual — every panel, both themes

The browser cockpit serves `shell` + `kanban`, `project`, `planning`, `design`, `setup`, `memo`, so **6 panels can be compared side by side across hosts**. `shell.html` is browser-only; `implementation.html` is webview-only (no headless route). Check both single-host panels in their own host.

- [ ] Tabs, buttons, column headers, labels, selects, modals, toasts, `Complexity: …`, `No plans` all render **Hanken** — the same face as the card titles. One typeface for chrome.
- [ ] Code blocks and markdown tables in the Implementation sidebar are **still monospace and still aligned**.
- [ ] `#promptPreview`, `.db-path-display`, `.db-custom-path-input`, `.active-path-btn`, `.plan-id`, `.example-paths` entries, the markdown source editors, and the log modal are still monospace.
- [ ] **The agent startup-command fields are still monospace** — Agents tab in `kanban`, onboarding and CLI rows in `implementation`, and the path/token/URL fields in `setup`'s startup rows. The `select` beside them in `setup` is now Hanken.
- [ ] The Tier 2 timers, dates and counts are monospace and do not jitter as digits change. Watch `.orchestrator-timer` and `.autoban-timer-badge` tick for at least 10 seconds.
- [ ] **The memo panel header still renders in GeistPixel**, not Hanken and not a fallback.
- [ ] **Glyph sweep — no tofu boxes anywhere.** Explicitly hunt `▸ ▾ ● ─ └ ✓ ✕ ✗ ⚙ ⚠ ⚡ → ↳ ⇨ ⤢ ⋮ ⋯ ↻ ⟲ ⎇ ✥` across expand controls, status dots, tree views, tick marks, warning badges and overflow menus. Confirm each falls through to Menlo (or OS fallback for `⋮ ⎇ ⟲ ⤢`) rather than rendering as a box. **This is the most likely failure of this plan** — Hanken contains none of these 24 symbols (verified).
- [ ] Emoji still render in colour (`✅ ❌ ⏳ 🔒 🔴 🟢 📋 📄 💡 🌐 🖼`).
- [ ] Nothing wraps, clips or overflows that did not before — especially the count badges (`2`, `1063`, `100`) and Completed-column buttons.
- [ ] Browser cockpit and VS Code webview remain typographically **identical to each other** on the 6 dual-host panels (the dependency plan's guarantee must survive this change).
- [ ] The nav rail icons still render (they are masked SVGs now, so they must be unaffected by `.strip-icon` losing its font declaration).
- [ ] Both Afterburner and Claudify correct. Neither theme redefines these tokens, so both should follow — confirm rather than assume.
- [ ] Fonts render with networking disconnected.

## Risks / Sequencing Notes

- **The 135 JS-side uses are the real risk**, not the CSS. They live inside JS template strings and `cssText` assignments; a careless regex sweep produces broken markup or dropped sibling properties rather than a font regression. Edit them per-file, per-site, and reload the panel after each file.
- **Silent tofu** is the second risk — invisible to lint, compile and grep. The dependency plan's fallback tail is what prevents it; do not let a later reviewer remove `Menlo, Consolas` as dead cruft.
- **Do not batch-replace `var(--font-mono)` → `var(--font-family)`.** The end state for Tier 3 is *no declaration*. A blanket replace leaves 250+ redundant declarations that will be re-litigated forever.
- **Delete the token last.** Until Phase 10, `--font-mono` still resolves, so a missed site renders wrong-but-readable. After deletion a missed site produces an invalid declaration that inherits — harder to spot. Run the zero-grep gate before deleting.
- `kanban.html` alone carries 128 of the 268 sites. If the change needs to be abandoned partway, it is the file to have finished.
- `kanban.html` and `shell.html` carry uncommitted work; land these edits alongside it, not over it.

## Resolved Assumptions

Settled by direct measurement this session. Do not re-open or re-research these.

- **Site counts:** 268 total `var(--font-mono)` occurrences — 133 in `<style>` blocks (incl. `shared-tabs.css`), 135 in JS/inline. Per-file figures in the table above.
- **All 26 originally-listed allowlist selectors exist**, and each declares mono in exactly **one** rule. No selector needed disambiguation.
- **Tier 1/2 totals:** 21 + 8 = **29 rules** after adding the three `.startup-row` rules.
- **Hanken Grotesk has no `tnum` feature** — GSUB contains `ccmp dnom frac liga locl numr`; `kern mark mkmk` are GPOS. `tabular-nums` is a no-op on it.
- **Hanken contains none of the 24 symbols** `→ ↳ ↻ ⇨ ⋮ ⋯ ⎇ ─ └ ▲ ▶ ▸ ▼ ▾ ● ⚙ ⚠ ⚡ ✓ ✕ ✗ ✥ ⟲ ⤢` — verified 24/24 absent from its `cmap`.
- **Two tests assert on `--font-mono`**, and no test asserts a token's *value*.
- **`shared-tabs.css` is dead** — `{{SHARED_TABS_CSS_URI}}` appears in no HTML file.
- **`implementation.html` has no browser route**; the cockpit serves 7 files, giving 6 dual-host panels.
- **`.startup-row` means different things per file** — CLI command fields in `kanban`/`implementation`, and a settings row of paths, tokens, URLs and checkboxes in `setup`. All three are Tier 1; `setup`'s bundled `select` is not.
- **`.strip-icon`'s font declaration is inert** — the rail renders masked SVGs via `.strip-glyph`.

## Uncertain Assumptions

The following are external platform/standards behaviours that cannot be settled by reading this repository. The user has been advised to run web research to confirm them before implementation; a ready-to-run research prompt was supplied in chat.

1. **An unresolvable `var()` in `font-family` makes the declaration invalid at computed-value time** (so the element inherits) rather than falling back to the remaining families in the list. This is the basis for treating `memo.html:87` as a must-fix rather than a cosmetic tidy.
2. **`font-variant-numeric: tabular-nums` is a no-op when the font ships no `tnum` feature** — i.e. no browser synthesises tabular figures. This is what forecloses the "move Tier 2 to Hanken and add `tabular-nums`" option.
3. **`Consolas` is present on Windows and covers the symbol set** that `Menlo` covers on macOS, so Tier 3 text keeps its glyphs there.
4. **The four symbols `⋮ ⎇ ⟲ ⤢` resolve via OS-level font fallback** rather than rendering as tofu, given that neither Hanken nor Menlo contains them.

## Decisions Already Made (do not re-litigate)

- **Monospace is functional, not decorative.** The only justification is column alignment. "It looks technical" is not a justification, and it is the assumption this plan exists to remove.
- **Allowlist, not blocklist.** Strip everything, then re-apply to an explicit list of 29 rules. This makes completeness verifiable by grep and prevents the 135 JS-side uses from being silently missed.
- **Tier 3 gets no `font-family` declaration**, inheriting `body`, rather than an explicit `var(--font-family)`.
- **`--font-mono` is deleted, not repurposed.** Leaving the name alive with a proportional value is how this bug returns.
- **Tier 2 stays monospace** — 8 rules on `--font-code`. Hanken has no `tnum`, and two of the affected elements tick live.
- **`memo.html:87`'s GeistPixel header is preserved**, tail swapped to `--font-code`. Its fate belongs to the GeistPixel cleanup plan.
- **`:root` is the dependency plan's surface.** This plan reads it in Phase 0 and touches it only in Phase 10, to delete `--font-mono`.
- **Selects, generic modal inputs, single-value number fields and the agent message box are Tier 3.** Decided per the judgement notes; do not re-triage them site by site.

---

**Recommendation:** Complexity 6 → **Send to Coder.** The rubric and allowlist are final, so no design work remains — but 268 edit sites across 9 files, 135 of them inside JS template strings, need someone who will reload each panel as they go rather than running one sweeping regex. Do not start until `decouple-webview-fonts-from-host.md` has landed.
