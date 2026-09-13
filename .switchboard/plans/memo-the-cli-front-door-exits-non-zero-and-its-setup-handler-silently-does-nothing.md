# The CLI Front Door Exits Non-Zero, Its Setup Handler Silently Does Nothing, and Its Only Gate Cannot Run It

## Goal

The CLI must behave as a front door: returning to its own menu rather than exiting, running the wizard choice it was given rather than falling through, reporting a missing server the same way everywhere, and being covered by something that can actually execute it.

### Problem analysis

Seven reviewer findings from `.switchboard/memo.md`, triaged 2026-09-04 and verified against HEAD. They are one file, `src/standalone/cli.ts`, and one theme: the CLI's structure assumes it is invoked once and exits, while the front door added later assumes it loops.

The last is why the rest survived — the only automated gate over the CLI is a regex over its source and cannot run a single command.

## Metadata

- **Complexity:** 5
- **Feature:** 50c93771-8835-4b23-9a4b-db626416a6d9
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

### 4. Port discovery costs about two seconds and can miss a live server

`cli.ts:425-434` loops `PORT_SPAN` ports calling `getHealthJson(port, '127.0.0.1', 500)` **before** consulting the port file at `:436`.

Two consequences from one cause: a fixed ~2 s penalty on every command when no server is running, and a silent miss when a live server is loaded enough to exceed 500 ms. Read the port file first.

### 5. `SWITCHBOARD_CLI_PATH` has a reader and no writer

`cli-call.js:67` reads the variable; a repo-wide grep finds no writer outside a test fixture. Meanwhile 129 bare `switchboard api` invocations across 25 files under `.agents/` assume the binary is on PATH, which it is not on an extension-only install — and unlike `cli-call.js`, a shell snippet has no fallback.

Export the variable from both PTY spawn environments, and settle on one invocation form across the snippets.

### 6. The only gate over the CLI cannot execute the CLI

`cli-board-commands-contract.test.js` is pure regex over `readSource(...)`: no SIGINT assertion, no EOF assertion, no pty. It is CI-wired at `integration-tests.yml:517` and it shipped red once (`b61c9780`) without anything catching it.

Add a PTY-driven smoke test covering the `ready` picker's EOF and SIGINT exits, and a `switchboard local` boot. That is the gate that would have caught changes 1 and 3. (Front-door menu looping is covered by the fleet-command card's verification, not here.)

## Verification Plan

1. Calling `cmdSetup` from below the routing point fails visibly; no wizard choice is silently discarded.
2. `switchboard ready` does not offer New-column cards, or does not dispatch them with `auto`.
3. All six no-server sites emit the same guidance; `grep` finds one helper and no terse duplicates.
4. With no server running, a command returns in well under two seconds; with a loaded server, discovery still finds it.
5. `SWITCHBOARD_CLI_PATH` is set in both spawn environments, and the `.agents` snippets use one form.
6. The PTY smoke test runs in CI and fails if the `ready` picker stops handling EOF/SIGINT correctly.

### Goal Invariants

- **No wizard choice is silently discarded** (negative — `cmdSetup` fails loudly when reached out of order, not returns silently).
- **`switchboard ready` does not dispatch `CREATED`-column cards with `auto`** (negative — unreviewed work is not sent straight to a coder).
- **Exactly one no-server helper exists** (positive — `emitOfflineGuidance` is the sole vocabulary; `grep` finds no terse duplicates).
- **Port discovery reads the port file before scanning** (positive — the fast path is first, the ~2 s scan is the fallback).
- **`SWITCHBOARD_CLI_PATH` is exported from both PTY spawn environments** (positive — the variable has a writer, not just a reader).

## Complexity Audit

### Routine
- Fix 1 (cmdSetup fall-through): one function, fail-loudly guard.
- Fix 2 (ready columns): remove `CREATED` from `READY_COLUMNS` or exclude it from `auto` dispatch.
- Fix 3 (no-server vocabulary): extract one helper, replace six terse duplicates.
- Fix 4 (port discovery order): swap two code blocks — read port file before scanning.

### Complex / Risky
- **Fix 5 (`SWITCHBOARD_CLI_PATH`):** exporting from both PTY spawn environments touches the pty host and the extension's terminal creation path. The 129 bare `switchboard api` invocations across 25 files under `.agents/` must settle on one form — a repo-wide sweep.
- **Fix 6 (PTY smoke test):** a new CI step that actually executes the CLI, not regex over its source. Must cover the `ready` picker's EOF and SIGINT exits and a `switchboard local` boot. This is the gate that would have caught fixes 1 and 3.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. All fixes are sequential code paths with no concurrent state.
- **Security:** Fix 5 (`SWITCHBOARD_CLI_PATH`) exports a path variable into spawn environments — the value is the resolved CLI binary path, not a secret. No new attack surface.
- **Side Effects:** Fix 2 changes which cards `switchboard ready` offers — removing `CREATED` from the ready picker is a behaviour change that affects any operator using `switchboard ready` today.
- **Dependencies & Conflicts:** Fix 4 (front-door return-to-menu) has been moved to the fleet-command card (`5f72cba2`) which restructures the same `cmdMainMenu` loop. The remaining fixes are independent of each other and of the fleet-command card.

## Dependencies

- **Fix 4 (front-door return-to-menu) has been moved to `5f72cba2`** (the fleet-command card), which restructures `cmdMainMenu` and must make every branch loop. This card keeps fixes 1, 2, 3, 5, 6, 7 — all independent of the menu restructure.
- No other plan dependency. All fixes are in `src/standalone/cli.ts` and `.agents/skills/_lib/cli-call.js`.

## Adversarial Synthesis

Key risks: (1) fix 5's repo-wide sweep of 129 `switchboard api` invocations could miss a file or introduce a second invocation form alongside the first; (2) fix 6's PTY smoke test could become another "green while incomplete" gate if it asserts too little; (3) fix 2's removal of `CREATED` from the ready picker could break an operator's workflow that depends on dispatching from the New column. Mitigations: the sweep is grep-verified; the smoke test covers EOF, SIGINT, and a boot (not just "does it start"); fix 2 is a deliberate behaviour change documented in the verification plan.

## Recommendation

Complexity 5 → **Send to Coder.** Six independent fixes in one file, plus a repo-wide sweep and a new CI step. The risk is concentrated in fix 5 (the `SWITCHBOARD_CLI_PATH` sweep) and fix 6 (the PTY smoke test that actually executes the CLI).
