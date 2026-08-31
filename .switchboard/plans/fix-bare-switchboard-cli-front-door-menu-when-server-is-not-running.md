# Fix bare switchboard CLI menu when no server is currently running

## Goal

Ensure that running `switchboard` in an interactive terminal always displays the main front-door menu (offering GUI server startup, CLI board console, and Setup wizard), even when no Switchboard server instance is currently running, instead of exiting immediately with an error `[switchboard] No running Switchboard instance for this workspace`.

### Problem Analysis & Root Cause

**Current Symptom:**
When the operator types `switchboard` in their terminal without an already-active background server instance, the CLI immediately exits with:
```text
[switchboard] No running Switchboard instance for this workspace.
[switchboard] Start one with `switchboard local` (this machine) or `switchboard tailnet` (your tailnet).
```
The operator never sees any interactive menu, making it impossible to use the front door to start the local or remote board or access setup options interactively.

**Root Cause:**
In `src/standalone/cli.ts`, bare `switchboard` routes directly to `cmdBoardConsole()`. At the top of `cmdBoardConsole()`, the function immediately calls:
```ts
const port = await findRunningInstance(workspaceRoot);
if (port === null) {
    console.error('[switchboard] No running Switchboard instance for this workspace.');
    console.error('[switchboard] Start one with \`switchboard local\` (this machine) or \`switchboard tailnet\` (your tailnet).');
    exitFlushed(1);
}
```
This design assumes that bare `switchboard` is strictly an attached board inspector for an already-running server. However, the user expects bare `switchboard` to be the primary interactive front door to the entire tool suite.

**Solution Architecture:**
1. **Interactive Front-Door Menu (`cmdMainMenu`):**
   When `switchboard` is invoked without subcommands on an interactive TTY, always present the top-level Main Menu first:
   ```text
          .---.
    _...-'     '-..._       SWITCHBOARD v1.7.13
   .-~  ●   ●   ●   ●  ~-.   Autonomous Agent Fleet Console
   (________________________)
         \   :    :   /
          \  :    :  /

   Active Server:    <Online: http://127.0.0.1:7777 / Offline>
   Workspace:        /home/patrick/switchboard

   MAIN MENU:
     [1] GUI Mode  — Start Local (127.0.0.1) or Remote Tailnet Board
     [2] CLI Mode  — Interactive Terminal Board Navigator (Plans, Fleet, Dispatch)
     [3] Setup     — Workspace & Multi-Repo Scaffolding Wizard
     [q] Exit (or Enter)

   Select an option [1-3/q]:
   ```
2. **Graceful Sub-Branch Navigation:**
   - **`[1] GUI Mode`**: Prompts the user to start `[1] switchboard local` or `[2] switchboard tailnet`. Does not require an existing server.
   - **`[2] CLI Mode`**:
     - If a server is running: Launches the live board console (browse columns, search plans, dispatch cards, inspect fleet).
     - If no server is running: Displays an informative notice (`Server is offline`) with an immediate prompt: `Start local server now? [Y/n]`, seamlessly booting the server on demand.
   - **`[3] Setup`**: Opens the interactive `switchboard setup` wizard (init, scaffold, control-plane, secrets).
3. **Non-TTY & Direct Subcommand Safety:**
   - If not a TTY (stdin closed/piped), exit cleanly without blocking.
   - Direct subcommands (`switchboard local`, `switchboard tailnet`, `switchboard plans`, `switchboard dispatch`, `switchboard fleet`, etc.) continue to run directly and bypass the interactive menu entirely.

> **Superseded:** Connect GUI launcher options directly to `cmdLocal` and `cmdTailnet`.
> **Reason:** `cmdLocal` and `cmdTailnet` do not exist in `src/standalone/cli.ts`. The serve path is a ~200-line inline slab inside `main()` (lines 2466–2699) that reads module-scope state (`serveMode`, `args`, `tailnetAddress`, `pendingBundlePath`, `args.detach`). There is no function to "connect" to. Naming non-existent symbols is an implementation dead-end — a coder following this instruction verbatim would fail to compile.
> **Replaced with:** GUI mode re-spawns the current process with the `local`/`tailnet` subcommand via `spawn(process.execPath, [__filename, sub, ...opts], { stdio: 'inherit' })` and replaces the menu process with the server process. This reuses the *entire* existing serve path (first-run DB menu, port fallback, detach fork, tailnet detection, file logging) with zero extraction. See **Proposed Changes → cmdMainMenu → GUI Mode** for the exact mechanism.

## Metadata
**Topic:** Fix bare switchboard CLI menu when no server is currently running
**Tags:** cli, ui, ux, bugfix
**Complexity:** 4

## User Review Required
- The menu design (3-way GUI/CLI/Setup) and the re-spawn mechanism for GUI mode are the core design choices. Review the **Proposed Changes** section before dispatch — the implementation hinges on re-spawning the process rather than calling non-existent serve functions.

## Complexity Audit

### Routine
- Reusing the existing `banner(version)` helper (line 871) for the menu header.
- Reusing the existing `openPrompter()` helper (line 725) for menu input.
- Reusing `findRunningInstance(workspaceRoot)` (line 382) for the Active Server status probe.
- Delegating `[3] Setup` to the existing `cmdSetup(workspaceRoot, [])` (line 1440).
- Delegating `[2] CLI Mode` (online branch) to the existing `cmdBoardConsole(workspaceRoot)` (line 1510), unchanged.
- The single routing edit at line 2462 (`if (!firstArg) { await cmdMainMenu(workspaceRoot); }`).

### Complex / Risky
- **GUI mode re-spawn coordination.** The menu process must replace itself with the server process cleanly (stdio inherited, exit code propagated). A botched spawn leaves the user staring at a dead menu or a server with no terminal.
- **CLI mode offline auto-start.** Must spawn `switchboard local --detach`, poll `findRunningInstance` for health (mirroring the existing detach poll loop at lines 2563–2572), and only then call `cmdBoardConsole`. A foreground spawn would turn the menu process into the server and the board console would never appear.
- **Decline-path completeness.** When the user declines the auto-start prompt, the menu must loop back to the main menu (not exit, not hang).
- **First-run DB menu interaction.** A detached re-spawn sets `SWITCHBOARD_DETACHED=1`, so `isDetachedChildProcess()` (line 2507 guard) is true and `firstRunDatabaseMenu` is skipped — safe. A foreground GUI re-spawn re-triggers the first-run menu on the same TTY, which is the desired behavior (the user is now starting a server). No double-prompt, because the main menu process has already exited before the child's first-run menu fires.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Server could come online between the `findRunningInstance` probe in `cmdMainMenu` and the user's menu selection. The CLI-mode online branch re-probes inside `cmdBoardConsole` (line 1511), so a server that started after the menu rendered is still detected. No stale-status bug.
- Server could stop between the menu's "Online" display and the user selecting CLI mode. `cmdBoardConsole` re-probes and exits 1 with advice — the main menu's "Online" label is informational, not a promise. Acceptable; the offline auto-start prompt is the recovery path.

**Security:**
- No new secret handling. Re-spawn passes `process.execPath` and `__filename` (both controlled, not user input). No shell invocation (`spawn` without `shell: true`), so no command injection surface from the menu choice.

**Side Effects:**
- GUI mode re-spawn replaces the menu process — the menu does not return. This is intended (the user chose to start a server).
- CLI mode detached auto-start leaves a background server running after the board console exits. This matches existing `switchboard local --detach` behavior; the user is advised via the existing "Server started in background" output.

**Dependencies & Conflicts:**
- Depends on the existing inline serve path remaining in `main()`. If a future refactor extracts it into `cmdServe`, the GUI re-spawn should switch to calling it directly (simpler than re-spawning). The re-spawn approach is chosen now precisely because no such function exists.
- No dependency on other plans or sessions.

## Dependencies
- None

## Adversarial Synthesis
Key risks: (1) the original plan named `cmdLocal`/`cmdTailnet` functions that do not exist — GUI mode had no implementable start mechanism; (2) CLI auto-start mechanism and decline-path were unspecified, risking a hang or a silent no-op; (3) flag-only invocations (`switchboard --hostname foo`) could be accidentally rerouted to the menu, breaking the legacy serve shortcut. Mitigations: GUI mode re-spawns the process with the `local`/`tailnet` subcommand (reuses the entire existing serve path); CLI auto-start uses a detached spawn + health poll before handing off to `cmdBoardConsole`, and loops back to the main menu on decline; the routing edit is gated by `!firstArg` exactly as today, so flag-only invocations still fall through to serve untouched.

## Proposed Changes

### Standalone CLI Entrypoint (`src/standalone/cli.ts`)

#### [MODIFY] Bare-command routing (line 2462)
**Context:** Today the bare-command dispatch is:
```ts
if (!firstArg) {
    await cmdBoardConsole(workspaceRoot);
}
```
**Logic:** Replace `cmdBoardConsole(workspaceRoot)` with `cmdMainMenu(workspaceRoot)`. The `!firstArg` guard is preserved verbatim — flag-only invocations (`switchboard --hostname foo`) still fall through to the inline serve path below, because `firstArg` is a flag and `!firstArg` is false. Direct subcommands are handled earlier in `main()` and never reach this line.

**Implementation:**
```ts
if (!firstArg) {
    await cmdMainMenu(workspaceRoot);
}
```

#### [ADD] `cmdMainMenu(workspaceRoot)` function (insert near `cmdBoardConsole`, ~line 1509)
**Context:** New top-level front-door menu. Reuses `banner()`, `openPrompter()`, `findRunningInstance()`, and delegates to `cmdBoardConsole` / `cmdSetup`. Server start is done by re-spawning the process with the `local`/`tailnet` subcommand.

**Logic:**
1. **Non-TTY guard.** If `!process.stdin.isTTY`, print usage to stderr and `exitFlushed(0)` — a non-interactive bare invocation has no menu to show and must not hang.
2. **Probe server status once.** `const port = await findRunningInstance(workspaceRoot);` Render `banner(version)`, then `Active Server: <Online: http://127.0.0.1:${port} / Offline>` and `Workspace: ${workspaceRoot}`.
3. **Render the 3-way MAIN MENU** (GUI / CLI / Setup / Exit) and prompt via `openPrompter()`.
4. **`[1] GUI Mode`** — sub-prompt `[1] switchboard local  [2] switchboard tailnet`:
   - On `1`: `spawn(process.execPath, [__filename, 'local'], { stdio: 'inherit' })`, wait for the child to exit, `exitFlushed(child.exitCode ?? 0)`.
   - On `2`: same with `'tailnet'`.
   - On empty/`q`: return to the main menu loop.
   - The child inherits the TTY and runs the full existing serve path (first-run DB menu, port fallback, browser open, detach). The menu process is replaced by the server process — exactly as if the user had typed `switchboard local`.
5. **`[2] CLI Mode`**:
   - If `port !== null` (server online): `prompter.close(); await cmdBoardConsole(workspaceRoot);` (unchanged behavior — the existing board console menu renders).
   - If `port === null` (offline): print `Server is offline.` and prompt `Start local server now? [Y/n] `:
     - On `Y`/`y`/empty: spawn `switchboard local --detach` (`spawn(process.execPath, [__filename, 'local', '--detach'], { stdio: 'inherit' })`), then poll `findRunningInstance(workspaceRoot)` every 250ms up to 15s (mirroring the existing detach poll at lines 2563–2572). On success, `prompter.close(); await cmdBoardConsole(workspaceRoot);`. On timeout, print the existing "Detached server failed to start" error and `exitFlushed(1)`.
     - On `n`/`N`/anything else: loop back to the main menu (re-render and re-prompt). Do not exit.
6. **`[3] Setup`** — `prompter.close(); await cmdSetup(workspaceRoot, []);` (delegates to the existing setup wizard, line 1440).
7. **`q`/empty** — `prompter.close(); exitFlushed(0);`.
8. **Invalid input** — re-prompt without exiting.
9. Wrap the whole body in a loop so declined sub-branches return to the main menu rather than exiting. The loop terminates only on `q`/empty, on a GUI re-spawn (process replaced), or on delegation to `cmdBoardConsole`/`cmdSetup` (which exit themselves).

**Edge Cases:**
- **Server stops between probe and CLI selection:** `cmdBoardConsole` re-probes at line 1511 and exits 1 with advice. The main menu's "Online" label is informational; the user re-runs `switchboard`. Acceptable.
- **Detached auto-start child exits early (bad port, missing workspace):** the poll loop checks `child.exitCode !== null` and bails (mirrors line 2570).
- **First-run DB menu in the detached child:** skipped because `SWITCHBOARD_DETACHED=1` makes `isDetachedChildProcess()` true (line 2507 guard). Safe.
- **First-run DB menu in a foreground GUI re-spawn:** fires on the inherited TTY — desired, since the user is starting a server. The main menu process has already exited before the child's first-run menu renders, so no double-prompt.

#### [UNCHANGED] `cmdBoardConsole(workspaceRoot)` (line 1510)
No changes. The online branch of CLI mode delegates here. Its existing no-server `exitFlushed(1)` path (lines 1512–1516) is now only reachable if a server stops between the main menu's probe and the user's selection — a rare race that the main menu's offline auto-start prompt is the intended recovery for. Leaving it as a defensive backstop is correct.

#### [UNCHANGED] `cmdSetup(workspaceRoot, argv)` (line 1440)
No changes. Setup mode delegates here with an empty argv, which lands in the interactive setup menu (line 1455+).

## Verification Plan

### Automated Tests
- Assert `switchboard` runs without arguments in a mocked interactive readline environment and outputs the Main Menu options (GUI / CLI / Setup) without crashing or exiting with code 1.
- Assert `switchboard` with `process.stdin.isTTY = false` exits 0 with usage on stderr instead of hanging.
- Assert `switchboard local --help` and other direct subcommands still bypass the menu (they never reach the `!firstArg` routing line).
- Assert `switchboard --hostname foo` (flag-only, no subcommand) still falls through to the serve path, not the main menu.
- Assert selecting CLI mode with a running server calls `cmdBoardConsole` (mock `findRunningInstance` to return a port).
- Assert selecting CLI mode with no server and declining the auto-start loops back to the main menu (does not exit, does not hang).

### Manual Verification
1. Kill any active Switchboard server instances (`switchboard stop`).
2. Run `switchboard` in an interactive terminal.
3. Verify that the Main Menu displays with server status indicated as `Offline`.
4. Select `[1]` → verify GUI sub-menu offers local or tailnet; select local → verify the server boots and the menu process is replaced by the server.
5. Repeat from step 1; select `[2]` → verify the offline auto-start prompt appears; decline → verify the main menu re-renders; accept → verify a detached server boots and the board console opens.
6. Select `[3]` → verify the setup wizard opens.
7. Run `switchboard --hostname foo` → verify it still starts a server (legacy serve shortcut intact).

### Goal Invariants
- Assert `cmdMainMenu` is defined in `src/standalone/cli.ts` and is called from the `if (!firstArg)` block at line ~2462 (positive: present and wired).
- Assert the string `No running Switchboard instance for this workspace.` is absent from `cmdMainMenu` (negative: the new front-door path never emits the old error).
- Assert `cmdBoardConsole` still contains the `findRunningInstance` + `exitFlushed(1)` backstop at line ~1512 (positive: the defensive race backstop is preserved).
- Assert `cmdMainMenu` calls `spawn(process.execPath, [__filename, ...])` with `'local'` or `'tailnet'` as the subcommand for GUI mode (positive: the re-spawn mechanism is the chosen start path, not a call to non-existent functions).
- Assert the `!firstArg` guard at the routing point is unchanged (positive: flag-only invocations still fall through to serve).
- Assert `cmdMainMenu` gates on `process.stdin.isTTY` and calls `exitFlushed(0)` in the non-TTY branch (positive: non-interactive invocations do not hang).

## Outstanding Questions
- None

## Implementation Summary

Implemented `cmdMainMenu(workspaceRoot)` in `src/standalone/cli.ts` (inserted before `cmdBoardConsole`) and swapped the bare-command routing at the `!firstArg` block from `cmdBoardConsole` to `cmdMainMenu`. The new function presents a 3-way Main Menu (GUI / CLI / Setup / Exit) on interactive TTYs, with a non-TTY guard that exits 0 with usage. GUI mode re-spawns the process via `spawn(process.execPath, [__filename, 'local'|'tailnet'], { stdio: 'inherit' })` and propagates the child exit code. CLI mode delegates to `cmdBoardConsole` when a server is online, or offers a detached auto-start (spawn `local --detach`, poll `findRunningInstance` up to 15s) with a decline-to-loop-back path. `cmdBoardConsole`'s no-server `exitFlushed(1)` backstop is preserved as a defensive race backstop. All goal invariants verified: `cmdMainMenu` is wired, contains no old error string, uses the re-spawn mechanism, and gates on `process.stdin.isTTY`.

## Review Findings

Files changed this pass: `src/standalone/cli.ts` (Setup branch now re-spawns `[__filename, 'setup']` instead of calling `cmdSetup()` in-process; the offline auto-start closes its readline before the stdin-inheriting child and bails on a non-zero intermediate; one stale rationale comment corrected) and `src/test/cli-board-commands-contract.test.js` (new section 10 covering the front-door invariants — the plan named six automated tests and none existed). One CRITICAL: `[3] Setup` was a no-op that fell through to the serve path, because `cmdSetup` only rewrites `process.argv` and returns while the `init`/`scaffold`/`control-plane` handlers sit *above* the bare-routing point and a bare argv carries no `setup` token to rewrite — reproduced at runtime on a pty (choosing "Initialize Switchboard in this repository" produced the board server's first-run DB prompt instead), and fixed. Validation: `npm run compile-tests` clean; `npm test` (standalone push-parity, catalog, icon parity) green; `test:contract:cli-board-commands` (CI-wired at `.github/workflows/integration-tests.yml:488`) plus goal-invariant, standalone-pwa-install, mobile-command-route, loopback-hostname, tailscale-bind and transfer-bundle contracts all pass; eslint 0 errors. Manual pty verification covered the offline menu render, non-TTY exit 0, the Setup re-spawn, the decline-to-loop-back path and the GUI back-out (MAIN MENU rendered three times, exit 0, no `.switchboard/` created).

## Deferred Findings

- MAJOR (pre-existing, outside this plan's scope) `src/standalone/cli.ts:382` — `findRunningInstance` probes `/health` on the port read from `.switchboard/api-server-port.txt` without asserting the server belongs to this workspace; every workspace's port file holds the same port, so the menu's `Active Server: Online` (and `about`/`status`/`cmdBoardConsole`) can reflect another workspace's server. Pre-dates this change and is relied on by shipped commands; a fix belongs in its own plan.
- NIT `src/standalone/cli.ts:1547` — uppercase `Q` is not accepted as the exit key; it falls to the invalid-input branch and re-renders the menu.
- NIT `src/standalone/cli.ts:1630` — the auto-start failure message hardcodes the relative path `.switchboard/logs/server.log`, while the serve path prints the absolute `logFile` it actually wrote.
- NIT `src/standalone/cli.ts:1543` — `process.once('SIGINT', onSigInt)` is largely decorative: on a TTY, readline intercepts Ctrl-C in `_ttyWrite` before a process-level SIGINT is delivered. Kept because it mirrors the existing `cmdBoardConsole` pattern at line 1737; changing both is a separate cleanup.
- NIT (verification gap, not a defect) — the GUI `local`/`tailnet` re-spawn actually booting a server was not manually executed, as it would start a real server against this repo. The re-spawn *mechanism* is proven end-to-end by the Setup branch, which uses the identical `spawn(process.execPath, [__filename, sub], { stdio: 'inherit' })` shape and successfully re-entered the CLI as `switchboard setup`.
