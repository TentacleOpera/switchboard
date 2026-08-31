# Context-Aware Offline Front Door and Triage in the Switchboard CLI

## Goal

Replace the single-track "start local server now? [Y/n]" offline prompt in `switchboard` with a comprehensive, neutral front-door triage experience that properly addresses all real-world operator scenarios: first-time workspace setup, remote tailnet server crashes, remote headless installations, and local development, and update the CLI banner tagline from "Autonomous Agent Fleet Console" to "Agent Fleet Command".

### Problem Analysis & Root Cause

**The Core Defect:**
The previous offline handling in `src/standalone/cli.ts` assumed that whenever `switchboard` is run in a terminal and no local server instance is detected on port 7777, the operator exclusively wants to start a local loopback server on the current machine. It hardcoded an auto-prompt:
```text
[switchboard] The board server is currently offline.
Start local board server now? [Y/n]: 
```

> **Superseded:** The plan originally framed this as the *current* state of `cmdMainMenu` — a bare front door that hardcodes the single-track prompt on every offline invocation.
> **Reason:** The front door has already been refactored. `cmdMainMenu` (cli.ts:1513) now renders a 3-option Main Menu (GUI Mode / CLI Mode / Setup) regardless of server status, showing an "Active Server: Online/Offline" line. The single-track `Server is offline. Start local server now? [Y/n]` prompt survives ONLY inside option `[2]` CLI Mode's offline branch (cli.ts:1593). The defect is real but narrower than the plan described: it is a biased offline sub-branch, not the entire front door.
> **Replaced with:** The plan targets the *remaining* single-track prompt inside CLI Mode's offline branch AND the broader UX gap: the current menu still biases toward local-loopback when offline (CLI Mode only offers "start local"), gives no tailnet/setup/help/diagnostics entries at the top level, and the board subcommands (`plans`, `ready`, `dispatch`, `clear`, `fleet`) emit a terse one-line offline message with no multi-scenario guidance.

**Why This Is Broken in Practice:**
1. **First-Time Users & Fresh Workspaces:**
   A user running `switchboard` for the first time in a repository needs orientation, initialization (`switchboard setup init`), and documentation (`switchboard help`). Blindly prompting to start an unconfigured server creates a broken first impression.
2. **Remote / Tailnet Server Disconnects & Crashes:**
   When an operator uses Switchboard remotely (e.g. from an iPad, phone, or laptop connecting to a server over Tailscale), a missing server often means the remote host process crashed or the tailnet connection dropped. Promoting a local loopback server is completely ineffective and misleading because the operator expects to reach the remote board.
3. **Headless / Remote VM Deployments:**
   Users deploying Switchboard on a headless remote server or cloud VM need to bind the Tailscale mesh (`switchboard tailnet`) or specific ports. Defaulting or biasing toward `switchboard local` (loopback only) is useless in headless environments where loopback cannot be reached externally.
4. **Lack of Diagnostics & Setup Access:**
   When offline, the operator must have immediate, equal access to all diagnostic and setup facilities without being forced into a narrow "local server" pipeline.

**Solution Architecture:**

1. **Neutral, Comprehensive Front-Door Menu (adaptive — offline and online):**
   When bare `switchboard` is run on an interactive TTY, present a clear, un-biased status display and action menu. The menu is **adaptive**: the option set changes based on whether a server is online.

   **Offline** (no active Switchboard instance detected) — 5-option triage menu:
   ```text
          .---.
    _...-'     '-..._       SWITCHBOARD v1.7.13
   .-~  ●   ●   ●   ●  ~-.   Agent Fleet Command
   (________________________)
         \   :    :   /       https://github.com/TentacleOpera/switchboard
          \  :    :  /        Host: Standalone (linux x64)

   Workspace:        /home/patrick/switchboard
   Server Status:    Offline (No active Switchboard instance detected)

   OPTIONS:
     [1] Start Local Board (127.0.0.1 loopback — this machine only)
     [2] Start Remote Tailnet Board (Tailscale mesh — iPad/phone/remote access)
     [3] Setup & Scaffolding Wizard (init, multi-repo scaffold, secrets)
     [4] Help & Command Documentation (view CLI command manual)
     [5] Server Status & Diagnostics (inspect ports, tokens, logs)
     [q] Exit (or Enter)

   Select an option [1-5/q]: 
   ```

   **Online** (a Switchboard instance is answering `/health`) — board-access menu. The serve options ([1]/[2]) are replaced by a board-console entry, because starting another server is not the online operator's need; setup/help/diagnostics remain useful:
   ```text
   Workspace:        /home/patrick/switchboard
   Server Status:    Online: http://127.0.0.1:7777

   OPTIONS:
     [1] Open Board Console (CLI navigator — browse columns, search, dispatch)
     [2] Setup & Scaffolding Wizard (init, multi-repo scaffold, secrets)
     [3] Help & Command Documentation (view CLI command manual)
     [4] Server Status & Diagnostics (inspect ports, tokens, logs)
     [q] Exit (or Enter)

   Select an option [1-4/q]: 
   ```

   > **Superseded:** The plan originally specified a single static 5-option menu shown only when "no server is active," with no description of the online path.
   > **Reason:** `cmdMainMenu` runs on EVERY bare invocation regardless of server status. A static offline-only menu would drop the board-console path (`cmdBoardConsole`) that the current menu's CLI Mode provides — regressing the "local development" scenario named in the Goal. An operator with a running server would be forced to pick "Start Local Board" when one is already running.
   > **Replaced with:** An adaptive menu with two render branches keyed on `findRunningInstance`: offline shows the 5-option triage (local, tailnet, setup, help, diagnostics); online shows a 4-option menu (board console, setup, help, diagnostics) with serve options omitted. One `cmdMainMenu`, two branches.

2. **Context-Aware Offline Guidance in Subcommands:**
   When a user attempts a board action that requires a live server (e.g. `switchboard plans`, `switchboard ready`, `switchboard dispatch`, `switchboard clear`, `switchboard fleet`) while offline, output clear, multi-scenario diagnostics rather than a single assumption:
   ```text
   [switchboard] No running Switchboard instance found for this workspace.

   How to resolve:
     • Local use:    Run `switchboard local` to serve the board on this machine.
     • Remote use:   Run `switchboard tailnet` to serve across your Tailscale network.
     • First run:    Run `switchboard setup` to initialize this repository.
     • Help & info:  Run `switchboard help` to see all commands and options.
   ```
   Extract a shared `emitOfflineGuidance(jsonFlag)` helper so all six board commands (`cmdPlans`, `cmdReady`, `cmdDispatch`, `cmdClear`, `cmdFleet`, `cmdBoardConsole`) emit the identical guidance from one source. The machine-readable `--json` form becomes `{ success: false, error: "No running Switchboard instance", hints: ["switchboard local", "switchboard tailnet", "switchboard setup", "switchboard help"] }`.

   > **Superseded:** The plan originally named only `cmdPlans`, `cmdDispatch`, `cmdFleet`, and `cmdBoardConsole` for the offline guidance refactor.
   > **Reason:** `cmdReady` (cli.ts:1037) and `cmdClear` (cli.ts:1224) hit the same `findRunningInstance → null → one-liner` path. `cmdReady` is the dispatch picker — the most likely command to be run offline by someone expecting a board. Leaving it terse while `cmdPlans` gets the 4-line guidance is inconsistent and contradicts the Goal's "all real-world operator scenarios."
   > **Replaced with:** All six board commands call the shared `emitOfflineGuidance(jsonFlag)` helper: `cmdPlans`, `cmdReady`, `cmdDispatch`, `cmdClear`, `cmdFleet`, `cmdBoardConsole`.

3. **Elimination of Single-Track Prompts (consequence of #1, not a separate step):**
   The `Server is offline. Start local server now? [Y/n]` prompt at cli.ts:1593 lives inside the current menu's CLI Mode offline branch. Replacing `cmdMainMenu` with the adaptive menu removes that branch entirely, so the prompt disappears as a consequence of the menu refactor — no separate deletion step is needed. The plan calls this out for auditability: there must be NO surviving `Start local server now?` or `Start local board server now?` confirmation prompt anywhere in `cli.ts` after the change.

## Metadata
**Tags:** cli, ux, refactor
**Complexity:** 5
**Topic:** Context-Aware Offline Front Door and Triage in the Switchboard CLI

## User Review Required
- **Adaptive online menu shape.** The plan proposes that when a server is online, the front door shows a 4-option menu (board console, setup, help, diagnostics) with serve options omitted. An alternative is to keep serve options visible but annotated "(already running)". The adaptive-omit approach is recommended (cleaner, no dead choices); confirm before implementation if you prefer the annotated variant.

## Complexity Audit

### Routine
- Extracting `emitOfflineGuidance(jsonFlag)` helper and calling it from six board commands — mechanical, single-file.
- Adding `hints: [...]` to the `--json` offline payloads — additive, no schema break for existing `success`/`error` consumers.
- Re-spawning `setup`, `help`, `status` from menu options — reuses the existing `spawn(process.execPath, [__filename, <sub>], { stdio: 'inherit' })` pattern already proven for `setup` at cli.ts:1654.
- Removing the `Start local server now? [Y/n]` prompt — a consequence of the menu refactor, no standalone change.

### Complex / Risky
- **Adaptive `cmdMainMenu` with two render branches** — the offline/online option sets differ (5 vs 4), the prompt label differs (`[1-5/q]` vs `[1-4/q]`), and the online `[1]` must hand off to `cmdBoardConsole` while the offline `[1]`/`[2]` must re-spawn `local`/`tailnet`. Getting the branch keying wrong (e.g. probing once then rendering the wrong set) ships a confusing menu.
- **Contract test overhaul** — `src/test/cli-board-commands-contract.test.js` has 10 assertions pinning the current `cmdMainMenu` shape (see Edge-Case audit). At least 4 break (`serveSub`, `'local', '--detach'` respawn, `respawns.length >= 3` composition, the `serveSub = sub === '1' ? 'local' : 'tailnet'` literal). The replacement assertions must pin the NEW adaptive contract without weakening the invariants the old ones protected (re-spawn-not-in-process, non-TTY exit 0, no no-server error in the menu).
- **Probe→select race on online branch** — if the menu probes "online" and the server stops before the user picks `[1] Open Board Console`, `cmdBoardConsole`'s own `findRunningInstance → null → exitFlushed(1)` backstop (cli.ts:1681) must remain intact. Do not remove it.

## Edge-Case & Dependency Audit

**Race Conditions:**
- `cmdMainMenu` probes `findRunningInstance` once per loop iteration (cli.ts:1527). A server that starts/stops between render and selection is reflected on the next loop. The adaptive menu must re-probe (or trust the already-probed `port`) consistently — do not probe once for the branch decision and again for the action, or a state change between the two ships a mismatched menu/action.
- Online `[1] Open Board Console` → `cmdBoardConsole` re-probes internally (cli.ts:1681). If the server died in between, `cmdBoardConsole` exits 1 with the offline guidance. This backstop MUST survive the refactor.

**Security:**
- No new network surface. The menu re-spawns existing subcommands (`local`, `tailnet`, `setup`, `help`, `status`) that already enforce their own hostname/port/token guards (`resolveHostname` at cli.ts:170, tailnet binding rules in the usage string). No new input parsing.

**Side Effects:**
- Re-spawning `local`/`tailnet` replaces the menu process with the server process (cli.ts:1568 pattern: `stdio: 'inherit'`, then `exitFlushed(code)`). The online `[1]` path calls `cmdBoardConsole` in-process (no spawn) — matches the current CLI Mode behavior at cli.ts:1589.
- `emitOfflineGuidance` calls `exitFlushed(1)` — same exit code as the current one-liner path. No behavior change for `--json` consumers that check `success === false`; they gain a `hints` field.

**Dependencies & Conflicts:**
- The contract test (`src/test/cli-board-commands-contract.test.js`) is a hard dependency — it WILL break on the menu refactor and must be updated in the same change. Specifically these assertions break and need replacement:
  - Line 258: `serveSub = sub === '1' ? 'local' : 'tailnet'` — the offline menu maps `[1]`→`local`, `[2]`→`tailnet` directly; no `serveSub` variable. Replace with an assertion that the offline branch re-spawns `[__filename, 'local']` for option 1 and `[__filename, 'tailnet']` for option 2.
  - Line 262: `'local', '--detach'` respawn — the CLI-mode offline auto-start branch is removed (the adaptive menu offers explicit `[1] Start Local Board` which re-spawns `local` in the foreground, inheriting the TTY, NOT `--detach`). Replace with an assertion that the offline `[1]` re-spawns `[__filename, 'local']` (foreground, `stdio: 'inherit'`).
  - Lines 247-250: `respawns.length >= 3` with `serveSub` / `local+detach` / `setup` — the new menu re-spawns `local`, `tailnet`, `setup`, `help`, `status` (offline) and `setup`, `help`, `status` (online; `[1]` calls `cmdBoardConsole` in-process, not a spawn). Replace with: offline branch has ≥5 respawns covering `local`, `tailnet`, `setup`, `help`, `status`; online branch has ≥3 respawns covering `setup`, `help`, `status` plus an in-process `cmdBoardConsole` call.
  - Line 273-277: `autoStart` prompter-close-before-spawn check — the `Server is offline. Start local server now?` branch is gone. Remove this assertion; add an equivalent if any new spawn inherits stdin after a prompt (the offline `[1]`/`[2]` re-spawns do — assert `prompter.close()` precedes them).
- These assertions STAY valid and must be preserved:
  - Line 217-220: bare `switchboard` routes to `cmdMainMenu`.
  - Line 222: `cmdMainMenu` must NOT emit `No running Switchboard instance for this workspace.` (the menu renders regardless of status).
  - Line 225-229: non-TTY exit 0.
  - Line 232-236: `cmdBoardConsole` keeps its `findRunningInstance → null → exitFlushed(1)` backstop.
  - Line 280-284: `cmdMainMenu` must NOT call `cmdSetup()` in-process.
  - Lines 289-298: `init`/`scaffold`/`control-plane` handlers stay above the bare-routing point.

## Dependencies
- None. This plan is self-contained within `src/standalone/cli.ts` and `src/test/cli-board-commands-contract.test.js`.

## Adversarial Synthesis
Key risks: (1) the adaptive menu's online branch could drop the `cmdBoardConsole` board-navigator path, regressing the local-development scenario named in the Goal; (2) the contract test has 10 pinning assertions, 4 of which break on the menu refactor — under-specifying the replacements invites an implementer to gut the test instead of rewriting it; (3) `cmdReady` and `cmdClear` were omitted from the offline-guidance refactor despite hitting the same one-liner path. Mitigations: adaptive menu with an explicit online `[1] Open Board Console` entry; enumerate every breaking assertion and its replacement; extract a shared `emitOfflineGuidance` helper called from all six board commands.

## Proposed Changes

### `src/standalone/cli.ts`

#### Context
`cmdMainMenu` (cli.ts:1513) is the bare-`switchboard` front door. It currently renders a 3-option menu (GUI/CLI/Setup) regardless of server status, with the single-track `Start local server now? [Y/n]` prompt buried in CLI Mode's offline branch (cli.ts:1593). Six board commands (`cmdPlans`, `cmdReady`, `cmdDispatch`, `cmdClear`, `cmdFleet`, `cmdBoardConsole`) each emit a terse one-line offline message with no multi-scenario guidance.

#### Logic
1. **Refactor `cmdMainMenu` into an adaptive menu** keyed on `findRunningInstance`:
   - **Offline branch** (`port === null`): render the 5-option triage menu (local, tailnet, setup, help, diagnostics). Options `[1]`/`[2]` re-spawn `[__filename, 'local']` / `[__filename, 'tailnet']` with `stdio: 'inherit'` (foreground — the child runs the full serve path including first-run DB menu, port fallback, browser open). Options `[3]`/`[4]`/`[5]` re-spawn `[__filename, 'setup']` / `[__filename, 'help']` / `[__filename, 'status']`. Close `prompter` BEFORE every spawn that inherits stdin (the child may render its own prompts on the same TTY).
   - **Online branch** (`port !== null`): render the 4-option menu (board console, setup, help, diagnostics). Option `[1]` calls `cmdBoardConsole(workspaceRoot)` in-process (no spawn — matches the current CLI Mode handoff at cli.ts:1589). Options `[2]`/`[3]`/`[4]` re-spawn `setup`/`help`/`status`.
   - Keep the existing `for(;;)` loop, non-TTY guard (cli.ts:1515), SIGINT handler, and `banner(version)` rendering.
   - The "Active Server" status line becomes "Server Status: Offline (No active Switchboard instance detected)" / "Server Status: Online: http://127.0.0.1:${port}".

2. **Extract `emitOfflineGuidance(jsonFlag: boolean): void`** — a shared helper that emits the 4-line multi-scenario message (or the `--json` `{ success: false, error: "No running Switchboard instance", hints: [...] }` payload) and calls `exitFlushed(1)`. Place it near the other shared helpers (`emitJson`, `exitFlushed`).

3. **Replace the one-liner offline path in all six board commands** with `emitOfflineGuidance(jsonFlag)`:
   - `cmdPlans` (cli.ts:967-971)
   - `cmdReady` (cli.ts:1048-1052)
   - `cmdDispatch` (cli.ts:1175-1179)
   - `cmdClear` (cli.ts:1242-1246)
   - `cmdFleet` (cli.ts:1293-1297)
   - `cmdBoardConsole` (cli.ts:1682-1686) — note this already has a 2-line message; replace with the shared 4-line helper for consistency.

4. **Remove the `Start local server now? [Y/n]` prompt** (cli.ts:1593) — a consequence of step 1. After the refactor, grep `cli.ts` for `Start local` and `Start local board server now?` must return zero matches.


5. **Update CLI Banner Tagline:**
   - In `banner(version)` (cli.ts:875), change `Autonomous Agent Fleet Console` to `Agent Fleet Command`.
   - In `cmdSetup` (cli.ts:1465), update `.replace('Agent Fleet Command', 'Workspace & Scaffolding Wizard')`.

#### Implementation
- The adaptive branch is the only structural change to `cmdMainMenu`'s control flow. The re-spawn mechanism (`spawn(process.execPath, [__filename, <sub>], { stdio: 'inherit' })` → await exit → `exitFlushed(code)`) is copied verbatim from the existing GUI Mode (cli.ts:1568) and Setup (cli.ts:1654) branches.
- `emitOfflineGuidance` is a ~15-line function: branch on `jsonFlag`, emit either the 4-line `console.error` block or `emitJson(...)`, then `exitFlushed(1)`. The `hints` array is `['switchboard local', 'switchboard tailnet', 'switchboard setup', 'switchboard help']`.
- No changes to `parseArgs`, `resolveHostname`, `findRunningInstance`, `probeHealth`, `getHealthJson`, `cmdBoardConsole`'s backstop, or any serve path.

#### Edge Cases
- **Probe→select race (online):** user sees "Online", server dies before `[1]` is pressed. `cmdBoardConsole` re-probes (cli.ts:1681) and calls `emitOfflineGuidance` (after step 3) → exits 1 with the 4-line guidance. Correct.
- **Probe→select race (offline):** user sees "Offline", server starts before `[1]` is pressed. The re-spawn of `local` hits port 7777 in use → the serve path's port-fallback handles it (the existing `--port 0` ephemeral fallback or a clear "port in use" error). No new logic needed.
- **Non-TTY:** unchanged — `cmdMainMenu` exits 0 with the subcommand hint (cli.ts:1515-1520). The adaptive branches are never reached.
- **`--json` consumers:** the `hints` field is additive. Existing consumers checking `success === false` are unaffected; new consumers can read `hints` for programmatic recovery suggestions.
- **`cmdBoardConsole` called directly (not via menu):** `switchboard` bare with a running server → online `[1]` → `cmdBoardConsole`. If the server died between probe and call, the backstop fires. Identical to current behavior.

### `src/test/cli-board-commands-contract.test.js`

#### Context
The contract test pins the current `cmdMainMenu` shape with 10 assertions (lines 207-299). Four break on the adaptive menu refactor; six stay valid.

#### Logic
Update the breaking assertions to pin the NEW adaptive contract:
1. **Replace** the `serveSub = sub === '1' ? 'local' : 'tailnet'` assertion (line 258) with: the offline menu branch re-spawns `[__filename, 'local']` for option 1 and `[__filename, 'tailnet']` for option 2.
2. **Replace** the `'local', '--detach'` respawn assertion (line 262) with: the offline `[1]` re-spawns `[__filename, 'local']` (foreground, `stdio: 'inherit'`) — NOT `--detach`, because the operator explicitly chose to start a board and the child should run in the foreground inheriting the TTY.
3. **Replace** the `respawns.length >= 3` composition check (lines 247-250) with: the offline branch has ≥5 respawns (`local`, `tailnet`, `setup`, `help`, `status`); the online branch has ≥3 respawns (`setup`, `help`, `status`) plus an in-process `cmdBoardConsole` call.
4. **Replace** the `autoStart` prompter-close-before-spawn check (lines 273-277) with: every spawn in `cmdMainMenu` that inherits stdin is preceded by `prompter.close()` (the offline `[1]`/`[2]` re-spawns do this).
5. **Add** an assertion that `cmdMainMenu` does NOT contain `Start local server now?` or `Start local board server now?` — the single-track prompt is gone.
6. **Add** an assertion that the offline branch renders all five triage labels (`Start Local Board`, `Start Remote Tailnet Board`, `Setup & Scaffolding Wizard`, `Help & Command Documentation`, `Server Status & Diagnostics`).
7. **Preserve** unchanged: bare-routing-to-`cmdMainMenu` (line 217), no no-server error in menu (line 222), non-TTY exit 0 (line 225-229), `cmdBoardConsole` backstop (line 232-236), no in-process `cmdSetup` (line 280-284), handler ordering (lines 289-298).

#### Edge Cases
- The test is static (reads source, regexes it) — no running server needed. The adaptive branch means the test must assert BOTH the offline and online render branches exist in the source. A regex that only checks the offline 5-option labels would pass if the online branch were accidentally deleted; add a positive assertion for the online `[1] Open Board Console` label too.

## Verification Plan

### Automated Tests
- Run `node src/test/cli-board-commands-contract.test.js` to verify:
  - Offline `cmdMainMenu` branch renders all 5 triage options (local, tailnet, setup, help, diagnostics) and does NOT push a single-track local prompt.
  - Online `cmdMainMenu` branch renders the board-console entry plus setup/help/diagnostics.
  - `switchboard plans`, `switchboard ready`, `switchboard dispatch`, `switchboard clear`, and `switchboard fleet` emit the comprehensive multi-scenario guidance when offline (assert the 4 hint lines appear in the source via the shared helper).
  - `--json` offline output includes `hints: [...]`.
  - Non-TTY invocations exit cleanly without hanging.
  - No `Start local server now?` or `Start local board server now?` string survives in `cli.ts`.
  - `cmdBoardConsole` keeps its `findRunningInstance → null → exitFlushed(1)` backstop.

### Goal Invariants
- `banner()` in `cli.ts` emits `Agent Fleet Command` instead of `Autonomous Agent Fleet Console`.
- Assert `cli.ts` contains zero matches for the regex `/Start local (board )?server now\?/` — the single-track prompt is eliminated.
- Assert `cmdMainMenu` in `cli.ts` contains the string `Open Board Console` — the online board-navigator path is present (the local-development scenario is served).
- Assert `cmdMainMenu` in `cli.ts` contains the strings `Start Local Board`, `Start Remote Tailnet Board`, `Setup & Scaffolding Wizard`, `Help & Command Documentation`, and `Server Status & Diagnostics` — all 5 offline triage branches are rendered.
- Assert a shared `emitOfflineGuidance` function exists in `cli.ts` and is called from `cmdPlans`, `cmdReady`, `cmdDispatch`, `cmdClear`, `cmdFleet`, and `cmdBoardConsole` — all six board commands emit uniform multi-scenario guidance, not a one-liner.
- Assert the `--json` offline payload in `emitOfflineGuidance` includes a `hints` array of length 4 — machine-readable recovery suggestions are present.

### Manual Verification
1. Ensure the Switchboard server is stopped (`switchboard stop`).
2. Run `switchboard` in a terminal.
3. Verify that the 5-option neutral triage menu appears with no single-track prompt.
4. Verify choosing `[3]` launches the setup wizard, `[4]` displays help, `[2]` launches the tailnet server, `[5]` shows diagnostics.
5. Start a server (`switchboard local --detach`), then run bare `switchboard` again.
6. Verify the online 4-option menu appears with `[1] Open Board Console` and that selecting it launches the board navigator.
7. Stop the server, then run `switchboard plans` and `switchboard ready` — verify the 4-line multi-scenario guidance appears (not the old one-liner).

## Outstanding Questions
- **[user]** Online menu shape: omit serve options (recommended) or keep them annotated "(already running)"? — proceeding on the assumption that serve options are omitted when online, since starting a second server is not the online operator's need and a dead choice is worse than an absent one.
