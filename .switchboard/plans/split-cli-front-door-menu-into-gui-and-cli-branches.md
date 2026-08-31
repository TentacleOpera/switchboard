# Split the CLI Front-Door Menu into GUI and CLI Branches

## Goal

Provide a clean top-level bifurcation when `npx switchboard` is run interactively without subcommands, giving the operator an immediate two-way front door:
1. **[G] GUI Mode / Server Launch:** Start local loopback board (`switchboard local`) or remote tailnet server (`switchboard tailnet`).
2. **[C] CLI Mode / Terminal Board Console:** Launch the interactive terminal board navigator to browse columns, search cards, and dispatch without opening a browser.

### Problem Analysis

**A user invoking `switchboard` in a terminal has one of two distinct intents:**
1. **They want to run the Switchboard host/server** so they (or their remote devices) can access the browser board GUI (`localhost:7777` or `100.x.y.z:7777`).
2. **They want to drive the board directly inside their terminal** (over SSH, on an iPad/phone terminal, or in a tmux pane) to view cards, inspect fleet status, or dispatch tasks without needing a browser.

Previously, running bare `switchboard` either forced server startup (ignoring terminal navigation) or forced terminal board navigation (ignoring server startup). Attempting to merge both into a single flat list created a cluttered interface where server lifecycle controls were mixed with day-to-day card dispatch actions.

By presenting a clean top-level branch:
- **`[1] GUI Mode`** offers:
  - `[1] Start Local Board` (127.0.0.1 loopback)
  - `[2] Start Remote Server Board` (Tailscale mesh binding)
- **`[2] CLI Mode`** opens the full terminal board navigator (browse columns, search plans/features, project filters, fleet inspection, setup wizard).
- Direct CLI subcommands (`switchboard local`, `switchboard tailnet`, `switchboard plans`, `switchboard dispatch`, `switchboard fleet`, `switchboard setup`) bypass the top-level menu entirely for automation and fast non-interactive use.

## Proposed Changes

### Standalone CLI Entrypoint (`src/standalone/cli.ts`)

#### [MODIFY] [cli.ts](file:///home/patrick/switchboard/src/standalone/cli.ts)
1. **Top-Level Interactive Front-Door:**
   When `process.argv.length <= 2` on an interactive TTY, render the UFO ANSI art banner and present the main dual-branch selector:
   ```text
          .---.
    _...-'     '-..._       SWITCHBOARD v1.7.13
   .-~  ●   ●   ●   ●  ~-.   Autonomous Agent Fleet Console
  (________________________)
        \   :    :   /
         \  :    :  /

   MAIN MENU:
     [1] GUI Mode  — Start Local or Remote Browser Board
     [2] CLI Mode  — Interactive Terminal Board Navigator
     [s] Setup     — Workspace & Multi-Repo Scaffolding Wizard
     [a] About     — System Info & Version
     [q] Exit

   Select mode [1/2/s/a] (or Enter to exit): 
   ```

2. **GUI Sub-Menu (`[1]` selected):**
   ```text
   GUI / SERVER LAUNCHER:
     [1] Start Local Board (127.0.0.1 loopback — this machine only)
     [2] Start Remote Server Board (Tailscale mesh — iPad/phone/remote access)
     [b] Back to Main Menu
   ```
   - Selecting `1` delegates directly to `switchboard local`.
   - Selecting `2` delegates directly to `switchboard tailnet`.

3. **CLI Sub-Menu (`[2]` selected):**
   - Connects to the active local server instance (or displays offline notification with quick-launch shortcuts).
   - Presents the interactive Plan & Feature Navigator:
     - `[1] Browse & Dispatch by Column (STAGING, CREATED, PLAN REVIEWED, etc.)`
     - `[2] Search Plans & Features (instant keyword / UUID prefix search)`
     - `[3] Filter by Project`
     - `[4] Inspect Fleet Status (live tasks & seats)`
     - `[b] Back to Main Menu`

4. **Non-TTY & Flag Preservation:**
   - Non-interactive environments (pipes, scripts, agent shells) never block on stdin; they exit 0 or emit help/json according to passed flags.
   - All explicit subcommands (`local`, `tailnet`, `plans`, `ready`, `dispatch`, `fleet`, `setup`, `stop`, `status`, `logs`) continue to run directly without showing the interactive front-door menu.

## Verification Plan

### Automated Tests
1. **Non-interactive safety:** Assert `node ./out/standalone/cli.js < /dev/null` does not hang and exits cleanly.
2. **Direct subcommand bypass:** Assert `switchboard local --help`, `switchboard plans --json`, and `switchboard fleet --json` execute directly without prompting.
3. **Menu input routing:** Feed mocked readline inputs (`1\n1\n` for local GUI, `1\n2\n` for remote GUI, `2\n` for CLI mode) and assert correct handler activation.

### Manual Verification
1. Run `switchboard` in an interactive terminal over SSH.
2. Verify selecting `1` opens the GUI launcher and prompts for Local vs Remote server.
3. Verify selecting `2` opens the terminal board navigator with full column browsing and search.

## Goal Invariants

- Bare `switchboard` on a TTY prompts with the top-level GUI vs CLI branch menu.
- Direct subcommands (`local`, `tailnet`, `plans`, `dispatch`, etc.) bypass the menu completely.
- Non-TTY invocations never hang waiting for input.
- `src/standalone/cli.ts` maintains parity with all existing `LocalApiServer` HTTP endpoints.

## Metadata
**Topic:** Split the CLI Front-Door Menu into GUI and CLI Branches
