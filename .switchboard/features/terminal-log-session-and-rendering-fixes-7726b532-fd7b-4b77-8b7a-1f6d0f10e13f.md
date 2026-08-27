# Terminal log session and rendering fixes

**Complexity:** 4

## Goal

Fixes two defects in the terminal session log system: (1) session boundaries are not created when the clear button is clicked or a new prompt is dispatched with clearBeforePrompt, and (2) the log viewer uses divergent monospace/minimal CSS styling instead of the project panel's unified markdown preview styling.

## How the Subtasks Achieve This

- **Terminal log session boundaries not created on clear button or copy-prompt dispatch**: Wires `terminalLogWriter.onSessionBoundary()` into the `ptyClearTerminal` and `ptyClearAllTerminals` verb handlers in both hosts (`bootstrap.ts` and `ptyHost.ts`), and into the `deliverPrompt`/`ptySendPrompt` path when `clearBeforePrompt` is true. This ensures a cleared terminal or a context-resetting prompt dispatch rolls the log file to a new session document, matching the mental model that "a cleared terminal starting fresh work is a new session."
- **Terminal log viewer does not use the project panel's markdown preview styling**: Replaces the divergent minimal CSS ruleset (`.log-view-detail-content` in `terminals.html`) with the project panel's unified markdown preview styling, and adds the 5 missing CSS variables to `terminals.html`'s `:root`. This makes the log viewer render markdown with the same proportional font, colors, heading styles, code block styles, and element coverage (h1-h6, blockquotes, lists, tables, links, hr) as the project panel.

## Dependencies & sequencing

- Subtasks are independent and can land in any order. Subtask 1 touches backend verb handlers (`bootstrap.ts`, `ptyHost.ts`) and the contract test file; Subtask 2 touches frontend CSS (`terminals.html`). No shared files, no shared symbols, no ordering constraint.
- No prerequisites or guards beyond the standard both-host parity requirement (Subtask 1 must wire `onSessionBoundary` in both `bootstrap.ts` and `ptyHost.ts`).

## Team Dispatch Instructions

### Terminal log session boundaries not created on clear button or copy-prompt dispatch

- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - `onSessionBoundary` call is present in the `ptyClearTerminal` handler source in both `bootstrap.ts` and `ptyHost.ts`
  - `onSessionBoundary` call is present in the `ptyClearAllTerminals` handler source in both hosts, inside the per-terminal loop
  - `onSessionBoundary` call in `ptySendPrompt`/`deliverPrompt` is gated on `clearBeforePrompt === true`, not unconditional
  - Source-text contract tests pass (5 new tests in `terminal-session-log-contract.test.js`)
  - Both hosts roll sessions on the same triggers
- **Must not touch:** `terminals.html` (CSS is owned by the other subtask), `terminalLogWriter.ts` (the writer already has `onSessionBoundary` — no changes needed to the writer itself)

### Terminal log viewer does not use the project panel's markdown preview styling

- **Seat:** Intern (complexity 3)
- **Acceptance:**
  - `.log-view-detail-content` CSS in `terminals.html` uses `var(--font-family)` (proportional), not `var(--font-mono)` (monospace)
  - All markdown elements (h1-h6, pre, code, blockquote, ul/ol, table, a, hr) are styled in `.log-view-detail-content`
  - 5 missing CSS variables (`--doc-text-bright`, `--doc-heading`, `--doc-text`, `--accent-teal-dim`, `--accent-teal-bright`) are added to `:root` with values matching `project.html`
  - `.log-view-detail` container padding is zeroed (padding moved to `.log-view-detail-content`)
  - No CSS variable references are broken (no undefined variables without fallbacks)
- **Must not touch:** `bootstrap.ts`, `ptyHost.ts`, `terminals.js` (backend logic is owned by the other subtask), `project.html` (the reference styling — copy from it, do not modify it)

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Terminal log session boundaries not created on clear button or copy-prompt dispatch](../plans/feature_plan_20260827144509_terminal-log-session-boundaries-on-clear-and-prompt.md) — **PLAN REVIEWED** — ID: 3f5e79ee-ec5c-4b6c-8b3e-a44aaa77aa41
- [ ] [Terminal log viewer does not use the project panel's markdown preview styling](../plans/feature_plan_20260827144510_terminal-log-viewer-matches-project-panel-markdown-styling.md) — **PLAN REVIEWED** — ID: 759aae22-5f51-4208-836b-05624d07c9ea
<!-- END SUBTASKS -->

