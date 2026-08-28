# Every panel styles its scrollbars for Chrome only, and the board has no Firefox rules at all

## Goal

Give every `::-webkit-scrollbar` rule in the webviews a Firefox equivalent (`scrollbar-width` + `scrollbar-color`) on the same selector, so the cockpit renders as one themed surface in Firefox instead of a dark UI framed by default OS scrollbars. Add a source-text contract test so a new panel cannot ship Chrome-only scrollbar styling again.

### The problem, and the root cause

**Firefox implements none of the `::-webkit-scrollbar` pseudo-elements.** It styles scrollbars through two standard properties, `scrollbar-width` and `scrollbar-color`. The webviews carry **84 `::-webkit-scrollbar` rules** and only **15** `scrollbar-width` declarations, so most scrollbars in Firefox fall back to the platform default: chunky, light, square-cornered, and completely off-theme against a dark cockpit.

This is not evenly spread. Measured per file:

| File | `::-webkit-scrollbar` | `scrollbar-width` | `scrollbar-color` |
|---|---|---|---|
| `terminals.html` | 13 | 3 | 3 |
| `tickets.html` | 9 | 2 | 2 |
| **`design.html`** | 8 | **0** | **0** |
| `connections.html` | 7 | 2 | 2 |
| `memo.html` | 7 | 2 | 2 |
| `project.html` | 7 | 2 | 2 |
| `setup.html` | 7 | 2 | 2 |
| `shell.html` | 6 | 1 | 1 |
| `mission-control.html` | 6 | 1 | 1 |
| **`planning.html`** | 6 | **0** | **0** |
| **`kanban.html`** | 4 | **0** | **0** |
| **`implementation.html`** | 4 | **0** | **0** |

**Four files have zero Firefox coverage, and one of them is `kanban.html` — the board.** That is the surface an operator looks at most, it has a scrollbar per column, and in Firefox every one of them is unstyled. `design.html` is the worst by count at 8-to-0. This is the bulk of the "Firefox looks ugly" report: it is not one broken widget, it is the chrome around every scrollable region on the primary surface.

**The root cause is that scrollbar styling was written webkit-first and the Firefox properties were added ad hoc.** The eight files that do have some coverage average two declarations against seven webkit rules — enough for the outermost pane, nothing for the panes inside it. No gate checks the pairing, so a panel extraction copies the webkit block and silently drops the standard one. The uneven distribution is the signature of that: the files with zero are the ones nobody happened to open in Firefox.

### Two related things that are NOT in scope

- **`-webkit-font-smoothing: antialiased`** (8 files). Chrome-only and Firefox has no equivalent — the property thins glyphs on macOS, and without it Firefox renders heavier. This is an accepted cross-engine difference, not a defect, and there is nothing to add. Leave it.
- **`-webkit-text-security: disc`** on token fields (`setup.html`, `design.html`, `tickets.html`). Firefox does not implement it, but this is **already correctly handled** and must not be touched: `transport.js:711` `restoreTokenMaskingFallback()` feature-detects via `CSS.supports('-webkit-text-security','disc')` and restores `type="password"` where unsupported. Verified live — it is invoked on both the `DOMContentLoaded` and already-loaded branches (`:727`, `:730`), all three pages that use the class load `transport.js`, and every masked field is static in the HTML so the load-time pass covers it. Do **not** "fix" this by adding `input-security`: `none` means *reveal*, the opposite, as both call sites' comments warn.

## Metadata

- **Complexity:** 3
- **Tags:** frontend, ui, bugfix, css

## User Review Required

None. Two decisions made and recorded:

1. **`scrollbar-width: thin`**, not `auto`. The webkit rules already set narrow explicit widths, so `thin` is the closer match; `auto` would render wider in Firefox than in Chrome and break the layout's spacing assumptions.
2. **Pair every rule, do not centralise.** A shared stylesheet would be cleaner, but `shared-tabs.css` is already dead in this codebase and panels inline their own CSS by convention. Adding the two properties beside each existing webkit block matches how these files are actually written and keeps the diff reviewable.

## Complexity Audit

### Routine

- Adding two declarations next to each of 84 existing rules. Mechanical, no logic.

### Complex / Risky

- **Nothing structural.** The only care needed is mapping each webkit block's `thumb` and `track` colours onto `scrollbar-color: <thumb> <track>` in the right order — Firefox takes thumb first. Getting it backwards renders an inverted scrollbar that looks deliberate, which is why the verification step is visual rather than only a source check.

## Edge-Case & Dependency Audit

- **Nested scrollable regions.** `scrollbar-color` inherits; `::-webkit-scrollbar` does not. Setting it on a container silently restyles descendants in Firefox. Apply it on the same selector as the webkit rule, never on a broad ancestor, or inner panes pick up the outer pane's colours.
- **`scrollbar-width` affects layout.** Unlike the webkit pseudo-element, it changes the content box width in Firefox. Panes computing widths in JS should be checked for off-by-a-scrollbar errors after the change.
- **The eight partially-covered files.** Do not assume the existing declarations are correct — they were added ad hoc. Re-derive each from its adjacent webkit block rather than trusting it.
- **The browser board serves the built bundle, not `src/`.** These are `.html` files served from `dist/` by the standalone host, so verification requires a `npm run compile` (or an installed VSIX) — reading `src/` proves nothing about what the browser renders.

## Dependencies

None. Self-contained CSS, no shared module, no migration, no schema. Can land at any time and conflicts with nothing.

## Adversarial Synthesis

Key risks. (1) `scrollbar-color` inheriting into nested panes and restyling regions that were deliberately different — mitigation: same-selector only, and check the nested cases in `terminals.html` (13 rules, the most nested file). (2) Thumb/track colour order reversed, which looks intentional and passes any source-text test — mitigation: visual check in Firefox is a required step, not optional. (3) A source-text contract test that counts occurrences rather than pairing them would pass on a file that has 8 webkit rules and 8 unrelated `scrollbar-width` declarations — mitigation: the test asserts per-selector pairing, not totals. (4) Verifying against `src/` while the browser serves `dist/` — mitigation: compile before checking.

## Proposed Changes

### The four zero-coverage files — `kanban.html`, `design.html`, `planning.html`, `implementation.html`

For each `::-webkit-scrollbar` / `-thumb` / `-track` group, add to the same selector:

```css
scrollbar-width: thin;
scrollbar-color: <thumb-colour> <track-colour>;
```

taking the colours from the adjacent webkit rules. `kanban.html` first — it is the board and the most-seen surface.

### The eight partially-covered files

Audit each existing `scrollbar-width`/`scrollbar-color` pair against its webkit block, correct any mismatch, and add the missing ones. `terminals.html` (13 rules, 3 covered) and `tickets.html` (9 / 2) are the largest gaps.

### `src/test/` — a new source-text contract test

Assert that in every `src/webview/*.html`, each selector carrying a `::-webkit-scrollbar` rule also carries `scrollbar-width` and `scrollbar-color`. Pairing per selector, not a file-level count. This is the gate that stops the next panel extraction reintroducing the divergence.

## Files Changed

- `src/webview/kanban.html`, `design.html`, `planning.html`, `implementation.html` — add the pairs
- `src/webview/terminals.html`, `tickets.html`, `connections.html`, `memo.html`, `project.html`, `setup.html`, `shell.html`, `mission-control.html` — complete and verify the pairs
- `src/test/webview-scrollbar-parity-contract.test.js` — new gate

## Verification Plan

### Automated

1. **Pairing contract.** Every `::-webkit-scrollbar` selector in every webview also declares `scrollbar-width` and `scrollbar-color`. Assert per selector.
2. **The contract fails before the fix.** Run it against the current tree and confirm it reports the four zero-coverage files — a gate that passes on a broken tree is not a gate.
3. **No `input-security` anywhere.** Guards the token-masking note above against a well-meaning future edit.

### Manual

4. **Compile, then open the board in Firefox.** Confirm column scrollbars are thin and themed, not OS default.
5. **Same in Chrome** — confirm no regression; the webkit rules are untouched so this is a check that nothing was displaced.
6. **Nested panes in `terminals.html`** — confirm inner panes did not inherit the outer pane's colours.
7. **Layout.** Check no pane gained or lost a scrollbar's width in Firefox.
