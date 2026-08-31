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

## Proposed Changes

### Standalone CLI Entrypoint (`src/standalone/cli.ts`)

#### [MODIFY] [cli.ts](file:///home/patrick/switchboard/src/standalone/cli.ts)
1. **Replace immediate server check in bare command handler with `cmdMainMenu(workspaceRoot)`:**
   - Detect TTY and running server status.
   - Present the top-level branch menu (GUI / CLI / Setup / Exit).
2. **Add Server Auto-Start Prompt in CLI Mode:**
   - When CLI mode (`[2]`) is selected without a running server, offer to launch the local server in detached mode or inline before opening the board navigator.
3. **Connect GUI launcher options directly to `cmdLocal` and `cmdTailnet`:**
   - Provide clean menu entries for loopback (`127.0.0.1`) and tailnet mesh (`100.x.y.z`).

## Verification Plan

### Automated Tests
- Assert `switchboard` runs without arguments in a mocked interactive readline environment and outputs the Main Menu options without crashing or exiting with code 1.
- Assert `switchboard` with `process.stdin.isTTY = false` exits gracefully with usage instructions instead of hanging.
- Assert `switchboard local --help` and other direct subcommands still bypass the menu.

### Manual Verification
1. Kill any active Switchboard server instances (`switchboard stop`).
2. Run `switchboard` in an interactive terminal.
3. Verify that the Main Menu displays with server status indicated as `Offline`.
4. Select `[1]` -> verify GUI options to start local or remote board work.
5. Select `[3]` -> verify setup wizard opens.

## Goal Invariants
- Running `switchboard` when no server is active NEVER exits with code 1 or an unhelpful error.
- The interactive menu is always presented on interactive TTYs.
- Direct subcommands are completely preserved and bypass the menu.

## Metadata
**Topic:** Fix bare switchboard CLI menu when no server is currently running
