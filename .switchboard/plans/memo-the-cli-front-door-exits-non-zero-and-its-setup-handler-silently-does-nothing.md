# The CLI Front Door Exits Non-Zero, Its Setup Handler Silently Does Nothing, and Its Only Gate Cannot Run It

## Goal

The CLI must behave as a front door: returning to its own menu rather than exiting, running the wizard choice it was given rather than falling through, reporting a missing server the same way everywhere, and being covered by something that can actually execute it.

### Problem analysis

Seven reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They are one file, `src/standalone/cli.ts`, and one theme: the CLI's structure assumes it is invoked once and exits, while the front door added later assumes it loops.

The last is why the rest survived — the only automated gate over the CLI is a regex over its source and cannot run a single command.

## Metadata

- **Complexity:** 5
- **Tags:** cli, standalone, ux, bugfix

## User Review Required

None.

## Proposed Changes

### 1. `cmdSetup` is a fall-through handler that looks like a normal one

`cli.ts:1886-1899` splices `setup` out of `process.argv` and returns; `:1930-1945` overwrites `argv[setupIdx]` and returns. Neither executes the wizard choice — they rewrite arguments and rely on a handler further down to pick them up.

Any caller below the init, scaffold and control-plane handlers therefore turns **every wizard choice into a silent no-op**. The front door at `:2075-2082` documents the trap in a comment instead of the function guarding against it.

Make the function fail loudly when reached out of order.

### 2. `switchboard ready` dispatches unplanned cards to a coder

`cli.ts:671` defines `const READY_COLUMNS = ['PLAN REVIEWED', 'CREATED']`, and the picker at `:1276` calls `doDispatch(port, workspaceRoot, planId, 'auto')`.

New is the planning lane. Offering its cards in a ready picker that dispatches with `auto` sends unreviewed work straight to a coder.

### 3. Two vocabularies for "no server", across six sites

The terse one-liner survives at `cli.ts:1461`, `:2460` and `:3214` (the `getHealthJson` catch paths), and — wider than the memo entry reported — `done`, `next` and `api` at `:1551`, `:1776` and `:1847` never route through `emitOfflineGuidance` on `port === null` at all.

Six sites, not four. One helper, used everywhere.

### 4. The front door never returns to its own menu

`cli.ts:2033-2043` (online options 2 to 4) and `:2087-2100` (offline options 3 to 5) both end in `exitFlushed(code)` inside the `for(;;)` loop. A bare `switchboard` used for help or diagnostics therefore **exits with the child's code**, non-zero on any failure, instead of looping back.

This belongs with the active card *Split the CLI Front-Door Menu into GUI and CLI Branches*; record it there rather than as a separate change, since that card is already restructuring the same loop.

### 5. Port discovery costs about two seconds and can miss a live server

`cli.ts:425-434` loops `PORT_SPAN` ports calling `getHealthJson(port, '127.0.0.1', 500)` **before** consulting the port file at `:436`.

Two consequences from one cause: a fixed ~2 s penalty on every command when no server is running, and a silent miss when a live server is loaded enough to exceed 500 ms. Read the port file first.

### 6. `SWITCHBOARD_CLI_PATH` has a reader and no writer

`cli-call.js:67` reads the variable; a repo-wide grep finds no writer outside a test fixture. Meanwhile 129 bare `switchboard api` invocations across 25 files under `.agents/` assume the binary is on PATH, which it is not on an extension-only install — and unlike `cli-call.js`, a shell snippet has no fallback.

Export the variable from both PTY spawn environments, and settle on one invocation form across the snippets.

### 7. The only gate over the CLI cannot execute the CLI

`cli-board-commands-contract.test.js` is pure regex over `readSource(...)`: no SIGINT assertion, no EOF assertion, no pty. It is CI-wired at `integration-tests.yml:517` and it shipped red once (`b61c9780`) without anything catching it.

Add a PTY-driven smoke test covering the front door menu, the `ready` picker's EOF and SIGINT exits, and a `switchboard local` boot. That is the gate that would have caught changes 1, 3 and 4.

## Verification Plan

1. Calling `cmdSetup` from below the routing point fails visibly; no wizard choice is silently discarded.
2. `switchboard ready` does not offer New-column cards, or does not dispatch them with `auto`.
3. All six no-server sites emit the same guidance; `grep` finds one helper and no terse duplicates.
4. A bare `switchboard`, used for help then quit, exits zero and returns to the menu in between. Recorded on the front-door card.
5. With no server running, a command returns in well under two seconds; with a loaded server, discovery still finds it.
6. `SWITCHBOARD_CLI_PATH` is set in both spawn environments, and the `.agents` snippets use one form.
7. The PTY smoke test runs in CI and fails if the front door stops looping.
