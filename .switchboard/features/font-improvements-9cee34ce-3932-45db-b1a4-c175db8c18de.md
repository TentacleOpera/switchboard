# Font improvements

**Complexity:** 6

## Goal

Fontds are inconsistent across browser shell and vs code extension, and there are currently monospace fonts in places they shouldn't be, like tab headers.

## How the Subtasks Achieve This

- **Decouple Webview Fonts from the VS Code Host**: Fixes the browser-vs-webview inconsistency at its source. Every panel currently derives both font tokens from `var(--vscode-font-family)` / `var(--vscode-editor-font-family)`, which only the VS Code webview host injects — the headless HTTP path injects no `--vscode-*` variables at all, so the browser falls through a chain naming three faces (`SF Mono`, `Cascadia Code`, `Consolas`) that don't resolve on macOS and lands on Monaco, which turns to mush at the 9–11px the chrome uses. This subtask replaces the tokens with a fixed `Menlo, Consolas` stack in all 8 `:root` blocks plus 4 stragglers that reach for the same host variables outside `:root`, and introduces `--font-code` so the second subtask is a token swap rather than a re-audit. No new font is bundled.
- **Correct the Font-Role Assignment: Monospace Only Where It Earns It**: Fixes the "monospace where it shouldn't be" half. Monospace is currently the house UI typeface — 268 sites across 9 files, including `.shared-tab-btn` in six separate files, every button, every column header, and `No plans`. This subtask establishes that monospace is justified only by column alignment, strips every `var(--font-mono)`, re-applies `--font-code` to an explicit 29-rule allowlist (code, paths, shell commands, raw payloads, stacked numerics), and deletes the `--font-mono` token so the mistake cannot return. Everything else inherits Hanken Grotesk from `body`, giving the chrome one typeface.

Together they produce a single coherent type system: one proportional face for all chrome, identical in both hosts, with monospace confined to content that actually aligns.

## Dependencies & sequencing

- **Cross-feature dependencies:** none. Nothing outside this feature must land first.
- **Shipping order — strict, not preferential.** `Decouple Webview Fonts from the VS Code Host` **must** land before `Correct the Font-Role Assignment`. The second subtask assumes `--font-code` already exists and resolves to a real monospace face in all 8 `:root` blocks, and that the proportional token already carries its `Menlo, Consolas` symbol tail. Its Phase 0 is a precondition check that fails if the first subtask has not landed. The first subtask is independently shippable and independently valuable — it fixes the reported browser-renders-worse bug on its own.
- **Prerequisites and guards:**
  - The fallback tails (`Menlo, Consolas`) are load-bearing on macOS, not defensive cruft: Hanken Grotesk contains **none** of the 24 non-ASCII symbols the webviews use (verified against its `cmap`), and `Menlo` supplies **16** of them per-glyph. A reviewer "tidying" the tail silently drops those 16, and no lint, compile, or grep detects it. The other 8 (`⋮ ⎇ ⚙ ⚠ ⚡ ✥ ⟲ ⤢`) come from OS fallback in both hosts today; `⚙ ⚠ ⚡` render as colour emoji. On Windows the tail is nearly inert for symbols — `Consolas` covers only 3 — so OS fallback does the work there, with a known metric-mismatch artefact in tight containers.
  - `src/webview/kanban.html:38–39` carries an **uncommitted** hand-edited Menlo-first stopgap that still reads `var(--vscode-editor-font-family, …)`. It looks fixed and is not. `kanban.html` and `shell.html` both have uncommitted work adjacent to `:root` — edit around it.
  - Two existing tests assert on `--font-mono` and are owned by the second subtask: `src/test/memo-panel-style-contract.test.js:20` and `src/test/agent-cli-input-background-regression.test.js:15`.

### Reconciled end-state (implement to this, not to either plan in isolation)

Both subtasks touch the same 8 `:root` blocks, so ownership is assigned rather than shared:

| surface | owner | end state |
|---|---|---|
| `--font-family` / `--font` (proportional) | subtask 1 | `'Hanken Grotesk', Menlo, Consolas, sans-serif` — written once, by subtask 1 only |
| `--font-code` (declaration) | subtask 1 | `Menlo, Consolas, monospace` in all 8 `:root` blocks |
| `--font-mono` (declaration) | subtask 1 writes it, subtask 2 deletes it | gone at the end |
| `var(--font-code)` (uses) | subtask 1 converts 3, subtask 2 adds 29, +1 fallback tail | 33 occurrences |
| all other `font-family` declarations | subtask 2 | deleted; inherit `body` |

Subtask 2 does not edit `:root` except to delete `--font-mono` in its final phase. `--font-mono` and `--font-code` are deliberately identical while both exist — that is what makes subtask 2 a token swap instead of a second audit.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Correct the Font-Role Assignment: Monospace Only Where It Earns It](../plans/correct-font-role-assignment.md) — **PLAN REVIEWED**
- [ ] [Decouple Webview Fonts from the VS Code Host](../plans/decouple-webview-fonts-from-host.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

