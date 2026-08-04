# Fix the `terminals.js` parse error that is keeping CI lint red

## Goal

Repair the syntax error at `src/webview/terminals.js:1013` so `npm run lint` exits 0 again. It is currently the **only** error in the repo, and while it stands every future lint error is invisible.

### Problem and background

`node --check src/webview/terminals.js` fails:

```
src/webview/terminals.js:1013
    function setLayoutMode(mode) {
    ^^^^^^^^
SyntaxError: Unexpected token 'function'
```

The file is unparseable, so the Terminals panel webview **does not load at all** — this is not a lint nit. `npm run lint` exits 1 on it, and CI invokes lint (`.github/workflows/integration-tests.yml`, "Lint (TypeScript only — see limitation above)"), so the whole workflow is red.

This belongs to the **Terminals pane-resize** feature, not the Tickets Panel Extraction. It was introduced by the same auto-commit (`7c9a688`) that carried the tickets work, which is why it surfaced during that feature's review. It was flagged in every one of those review passes and left alone deliberately: editing another feature's in-flight file risks colliding with work in progress. It needs its owner.

### Root cause — narrowed, not guessed

`7aebaf5:src/webview/terminals.js` parses cleanly, so the break came from the pane-resize changes in `7c9a688` (which touched `terminals.js` by +754 lines).

Diagnosis so far, to save the owner the first hour:

- **Braces are balanced** to line 1013. Depth entering `setLayoutMode` is exactly 1 (its own opening brace), which is correct — so this is *not* a missing `}`.
- **Backticks are even** (38 before line 1013), so it is not an unterminated template literal.
- **Square brackets are balanced.**
- **Parentheses are `+1`** across lines 1–1012 — one unclosed `(`. That is the defect: an unclosed call or grouping expression before line 1013 makes the following `function` keyword appear in expression position, which is exactly the error V8 reports.

The region immediately above is a `renderTerminalRow` / worktree-group DOM builder (`:995–1011`) — nested `appendChild` / `createElement` calls and a `for…of`, which is the shape where a dropped `)` is easy to introduce and hard to see.

### Why it stayed hidden

`eslint.config.js` scopes its rule blocks to `**/*.ts`, and the CI step is even named "Lint (TypeScript only)". A parse error in a `.js` file still surfaces through the default parser and still exits 1, but the step's own comment tells a reader that `.js` is not covered — so a red lint step reads as someone else's problem.

## Metadata

**Tags:** bugfix, frontend, ci

**Complexity:** 2

## Approach

1. Bisect the parenthesis imbalance in lines 1–1012. Running a paren-depth counter per line and printing where the running delta first fails to return to 0 at a statement boundary will land on it directly.
2. Prefer restoring the intended expression over adding a `)` wherever the counter happens to point — an inserted paren can balance the file while silently changing what the expression evaluates to. Compare against `7aebaf5:src/webview/terminals.js` for the pre-change shape of whatever block it lands in.
3. Confirm with `node --check`, then confirm the panel actually loads — a parsing file is necessary, not sufficient.

## Verification Plan

### Automated

- `node --check src/webview/terminals.js` — must pass.
- `npm run lint` — must exit **0**. Verify the exit code, not the absence of text in the output.
- Paren, brace, bracket and backtick counts across the whole file should each balance.
- `npm run compile-tests`.
- `npm run test:contract:terminal-flow-control`, `terminal-input-path`, `terminal-solo-popout`, `shell-terminal-strip`, `pty-host-gating`, `pty-route-surface`, `terminal-token-transport` — the Terminals suites CI already runs.
- `npm run icons:parity`, `npm run mirror:check`.

### Manual

- Open the Terminals panel in the editor host and confirm it renders — the file currently does not parse, so nothing in it has executed since `7c9a688`.
- Exercise the pane-resize behaviour the originating feature added, and `setLayoutMode` specifically, since the error sits at its declaration.
- Confirm the worktree-grouped terminal list at `:995–1011` renders its rows and headers.
- Repeat in the standalone browser host.

### Follow-up worth considering, not required here

`eslint.config.js` covering only `**/*.ts` means `src/webview/*.js` — roughly 40,000 lines including `planning.js`, `tickets.js`, `terminals.js` and `sharedUtils.js` — gets no rule coverage beyond parse errors. Widening it would surface an unmeasured warning backlog, so it needs its own plan rather than being bolted on here. Worth raising: a syntax error that makes an entire panel fail to load should be caught by something louder than a step whose name says it does not check that language.
