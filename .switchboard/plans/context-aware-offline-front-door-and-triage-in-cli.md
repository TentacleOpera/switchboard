# Context-Aware Offline Front Door and Triage in the Switchboard CLI

## Goal

Replace the single-track "start local server now? [Y/n]" offline prompt in `switchboard` with a comprehensive, neutral front-door triage experience that properly addresses all real-world operator scenarios: first-time workspace setup, remote tailnet server crashes, remote headless installations, and local development.

### Problem Analysis & Root Cause

**The Core Defect:**
The previous offline handling in `src/standalone/cli.ts` assumed that whenever `switchboard` is run in a terminal and no local server instance is detected on port 7777, the operator exclusively wants to start a local loopback server on the current machine. It hardcoded an auto-prompt:
```text
[switchboard] The board server is currently offline.
Start local board server now? [Y/n]: 
```

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

1. **Neutral, Comprehensive Front-Door Menu:**
   When bare `switchboard` is run on an interactive TTY and no server is active, present a clear, un-biased status display and action menu:
   ```text
          .---.
    _...-'     '-..._       SWITCHBOARD v1.7.13
   .-~  ●   ●   ●   ●  ~-.   Autonomous Agent Fleet Console
   (________________________)
         \   :    :   /       https://github.com/TentacleOpera/switchboard
          \  :    :  /        Host: Standalone (linux x64)

   Workspace:        /home/patrick/switchboard
   Server Status:    Offline (No active Switchboard instance detected)

   OPTIONS:
     [1] Start Local Board (127.0.0.1 loopback — this machine only)
     [2] Start Remote / Tailnet Board (Tailscale mesh — iPad/phone/remote access)
     [3] Setup & Scaffolding Wizard (init, multi-repo scaffold, secrets)
     [4] Help & Command Documentation (view CLI command manual)
     [5] Server Status & Diagnostics (inspect ports, tokens, logs)
     [q] Exit (or Enter)

   Select an option [1-5/q]: 
   ```

2. **Context-Aware Offline Guidance in Subcommands:**
   When a user attempts a board action that requires a live server (e.g. `switchboard plans`, `switchboard dispatch`, `switchboard fleet`) while offline, output clear, multi-scenario diagnostics rather than a single assumption:
   ```text
   [switchboard] No running Switchboard instance found for this workspace.

   How to resolve:
     • Local use:    Run `switchboard local` to serve the board on this machine.
     • Remote use:   Run `switchboard tailnet` to serve across your Tailscale network.
     • First run:    Run `switchboard setup` to initialize this repository.
     • Help & info:  Run `switchboard help` to see all commands and options.
   ```

3. **Elimination of Single-Track Prompts:**
   Remove all hardcoded `Start local server now? [Y/n]` confirmation prompts that assume local-only intention.

## Proposed Changes

### Standalone CLI Entrypoint (`src/standalone/cli.ts`)

#### [MODIFY] [cli.ts](file:///home/patrick/switchboard/src/standalone/cli.ts)
1. **Refactor `cmdMainMenu`:**
   - Clearly delineate online state (board navigator, column browsing, dispatch) and offline state.
   - When offline, render the 5-option triage menu:
     - `[1] Start Local Board` -> re-spawns with `local`
     - `[2] Start Remote / Tailnet Board` -> re-spawns with `tailnet`
     - `[3] Setup & Scaffolding Wizard` -> re-spawns with `setup`
     - `[4] Help & Command Documentation` -> re-spawns with `help`
     - `[5] Server Status & Diagnostics` -> re-spawns with `status`
2. **Refactor Offline Message in Board Commands (`cmdPlans`, `cmdDispatch`, `cmdFleet`, `cmdBoardConsole`):**
   - Provide multi-scenario advice covering local start, remote tailnet start, setup initialization, and help.
   - Ensure machine-readable `--json` output includes `{ success: false, error: "No running Switchboard instance", hints: [...] }`.
3. **Automated Contract Tests:**
   - Update `src/test/cli-board-commands-contract.test.js` to assert that the offline front door renders all 5 triage options and does not push a single-track local prompt.

## Verification Plan

### Automated Tests
- Run `node src/test/cli-board-commands-contract.test.js` to verify:
  - Offline `cmdMainMenu` output includes local, tailnet, setup, help, and diagnostics options.
  - `switchboard plans`, `switchboard dispatch`, and `switchboard fleet` emit comprehensive multi-scenario guidance when offline.
  - Non-TTY invocations exit cleanly without hanging.

### Manual Verification
1. Ensure the Switchboard server is stopped (`switchboard stop`).
2. Run `switchboard` in a terminal.
3. Verify that the 5-option neutral triage menu appears with no single-track prompt.
4. Verify choosing `[3]` launches the setup wizard, `[4]` displays help, and `[2]` launches the tailnet server.

## Goal Invariants
- `switchboard` NEVER assumes the operator only wants a local loopback server.
- First-time users, remote tailnet operators, and local developers are given equal, explicit pathways from the front door.
- All 5 triage branches (local, tailnet, setup, help, diagnostics) are fully functional.

## Metadata
**Topic:** Context-Aware Offline Front Door and Triage in the Switchboard CLI
