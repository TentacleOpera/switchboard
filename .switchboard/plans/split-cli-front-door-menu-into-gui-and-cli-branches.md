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

## Metadata
**Topic:** Split the CLI Front-Door Menu into GUI and CLI Branches
**Tags:** [cli, ui, ux, refactor]
**Complexity:** 4

## User Review Required
Yes — the GUI sub-menu behavior when a server is already running is a UX decision (see Superseded callout in Proposed Changes). The plan proceeds on the assumption that "Open Browser / show URL" is the correct online-GUI action, but the operator may prefer to be told the server is running and sent to CLI Mode instead.

## Complexity Audit

### Routine
- Restructuring `cmdMainMenu` (cli.ts:1666) from adaptive online/offline to a fixed two-branch top level — single function, reuses existing `openPrompter` (cli.ts:767), `banner` (cli.ts:913), `findRunningInstance`, and the re-spawn-with-subcommand pattern already used by the offline branch (cli.ts:1760).
- Adding `[s] Setup` and `[a] About` as top-level options — both re-spawn existing subcommands (`setup`, `about`) via the same `spawn(process.execPath, [__filename, sub], { stdio: 'inherit' })` pattern.
- Non-TTY guard (cli.ts:1668) and direct-subcommand bypass (cli.ts:2776 `!firstArg` routing) are unchanged.

### Complex / Risky
- **GUI sub-menu state-awareness:** the GUI branch must probe `findRunningInstance` and branch on online/offline — otherwise "Start Local" when a server is already running hits the existing-instance guard (cli.ts:2782) and exits 1, a dead-end regression.
- **`[b] Back` control flow:** `cmdBoardConsole` (cli.ts:1808) and all board commands (`cmdReady`, `cmdFleet`) call `exitFlushed()` and never return. Supporting Back requires either re-spawning `cmdBoardConsole` as a child (parent loops after child exit) or refactoring it to return. The re-spawn approach is lower-risk and matches the existing pattern.

## Edge-Case & Dependency Audit

**Race Conditions:**
- Server state can change between `cmdMainMenu`'s probe and the operator's selection. The existing adaptive menu handles this by probing once per loop iteration (cli.ts:1683) and trusting the result for both render and action. The fixed bifurcation must do the same — probe once per loop, do NOT re-probe between render and selection (that races a state change and ships a mismatched menu/action).

**Security:**
- No new attack surface. The menu re-uses existing subcommand handlers; no new network calls, no new file writes, no new secret handling.

**Side Effects:**
- The bare `switchboard` path (cli.ts:2776) currently falls through to the serve path if `cmdMainMenu` returns. The restructured `cmdMainMenu` must still `exitFlushed()` on every terminal branch (as it does today) so it never falls through to the server-start path at cli.ts:2781. The re-spawn pattern (child inherits stdio, parent `exitFlushed(code)` on child exit) preserves this.

**Dependencies & Conflicts:**
- `cmdBoardConsole`'s `[5] Setup & Scaffolding Wizard` option (cli.ts:1957) becomes redundant once Setup is top-level (`[s]`). It must be removed from `cmdBoardConsole`'s menu to avoid a duplicate entry. This is a deletion of a menu line + its case branch, not a behavioral change — Setup remains reachable via `switchboard setup` and the new top-level `[s]`.
- The plan's ASCII banner mockup (with "Autonomous Agent Fleet Console" subtitle) must NOT be introduced as a new string. Reuse the existing `banner(version)` function (cli.ts:913), which renders the tested UFO art with the "Agent Fleet Command" subtitle, GitHub URL, and host line.

## Dependencies
- None — this is a self-contained refactor of `src/standalone/cli.ts`. No other plan must complete first.

## Adversarial Synthesis

**Key risks:** (1) GUI sub-menu when a server is already online → "Start Local" hits the existing-instance guard and exits 1, a dead-end regression of the adaptive menu's correct online behavior. (2) `[b] Back` is unimplementable without a control-flow decision because `cmdBoardConsole` and all board commands `exitFlushed()` and never return. (3) Introducing a second banner string fragments the product identity. **Mitigations:** (1) GUI sub-menu probes `findRunningInstance` and offers "Open Browser / show URL" when online. (2) CLI Mode re-spawns `cmdBoardConsole` as a child; `cmdMainMenu` loops after the child exits, enabling Back without refactoring exit semantics. (3) Reuse `banner(version)`; explicitly trim `cmdBoardConsole`'s `[5] Setup` option.

## Proposed Changes

### Standalone CLI Entrypoint (`src/standalone/cli.ts`)

#### [MODIFY] `cmdMainMenu` (cli.ts:1666) — restructure to fixed GUI/CLI bifurcation

**Context:** The current `cmdMainMenu` is adaptive — it renders a 4-option menu when online (Board Console, Setup, Help, Status) and a 5-option menu when offline (Local, Tailnet, Setup, Help, Status). The plan replaces this with a fixed two-branch top level that does not change shape based on server state.

**Logic:**

1. **Non-TTY guard (unchanged, cli.ts:1668):** When `!process.stdin.isTTY`, print the "No subcommand given and stdin is not a TTY" message and `exitFlushed(0)`. No behavioral change.

2. **Top-level loop:** Keep the existing `for (;;)` loop (cli.ts:1677). Probe `findRunningInstance(workspaceRoot)` once per iteration (cli.ts:1683) — the result drives the GUI sub-menu's state-aware branch (see below) but does NOT change the top-level menu shape.

3. **Top-level render:** Print `banner(version)` (reuse existing function — do NOT hardcode the plan's mockup ASCII). Print workspace + server status line (as today, cli.ts:1687-1688). Then print the fixed menu:
   ```text
   MAIN MENU:
     [1] GUI Mode  — Start Local or Remote Browser Board
     [2] CLI Mode  — Interactive Terminal Board Navigator
     [s] Setup     — Workspace & Multi-Repo Scaffolding Wizard
     [a] About     — System Info & Version
     [q] Exit

   Select mode [1/2/s/a] (or Enter / q to exit):
   ```

4. **`[1]` GUI sub-menu — state-aware:**

   > **Superseded:** The original plan's GUI sub-menu offered only `[1] Start Local Board` and `[2] Start Remote Server Board` regardless of server state.
   > **Reason:** When a server is already running, "Start Local" hits the existing-instance guard at cli.ts:2782 (`Another Switchboard instance is already running on port ${existing}`) and exits 1. The operator picked GUI to *use* the browser board, not to start a second server — a dead-end regression of the adaptive menu's correct online behavior (which omitted serve options when online).
   > **Replaced with:** The GUI sub-menu probes `findRunningInstance` first and branches:
   > - **Online:** print `Server already running at http://127.0.0.1:${port}` and offer `[1] Open in Browser` (prints the URL; if `--no-open` was not passed, attempts to open it via the existing serve-path browser-open logic or `open`/`xdg-open`), `[b] Back`. Do NOT offer "Start Local" — starting a second server is a hard error.
   > - **Offline:** offer `[1] Start Local Board (127.0.0.1 loopback)`, `[2] Start Remote Server Board (Tailscale mesh)`, `[b] Back`. Selecting `1` re-spawns `switchboard local`; selecting `2` re-spawns `switchboard tailnet` — both via the existing `spawn(process.execPath, [__filename, serveSub], { stdio: 'inherit' })` pattern (cli.ts:1760), closing the prompter before spawn and `exitFlushed(code)` on child exit.

5. **`[2]` CLI Mode — re-spawn `cmdBoardConsole` as a child to enable Back:**

   > **Superseded:** The original plan implied `cmdMainMenu` calls `cmdBoardConsole` in-process (as the current online `[1]` does at cli.ts:1727) and that the CLI sub-menu offers `[b] Back to Main Menu`.
   > **Reason:** `cmdBoardConsole` (cli.ts:1808) and every board command it delegates to (`cmdReady`, `cmdFleet`) call `exitFlushed()` and never return. An in-process call cannot yield control back to `cmdMainMenu` for a Back action — the process dies inside `cmdBoardConsole`. The `[b] Back` button is unimplementable without either refactoring `cmdBoardConsole` to return (high-risk: touches every `exitFlushed` in the function and its callees) or re-spawning it as a child.
   > **Replaced with:** Re-spawn `cmdBoardConsole` as a child process via a new internal routing token (e.g. `switchboard __board-console`) or by re-spawning with a recognized bare-board-console argv shape that `main()` routes to `cmdBoardConsole` directly. The child inherits the TTY (`stdio: 'inherit'`), runs the full board console, and exits. `cmdMainMenu` awaits the child's exit code and **loops** (continues the `for (;;)`), returning to the top-level menu render. This enables Back without refactoring any `exitFlushed` semantics, and matches the existing re-spawn pattern used by the offline serve branches. When the server is offline, `cmdBoardConsole` calls `emitOfflineGuidance(false)` and the child exits 1 — the parent loops and the operator is back at the main menu, where they can pick GUI Mode to start a server. This resolves the offline-CLI dead-end automatically.

   **Implementation note:** `main()` (cli.ts:1994) currently routes bare `switchboard` (`!firstArg`) to `cmdMainMenu` at cli.ts:2776. To support re-spawning the board console, add a hidden internal token (e.g. `__board-console`) to `KNOWN_SUBCOMMANDS` (cli.ts:2007) and route it to `cmdBoardConsole(workspaceRoot)` above the bare-`switchboard` check. The child is spawned as `spawn(process.execPath, [__filename, '__board-console'], { stdio: 'inherit' })`. This token is NOT documented in `usage()` — it is an internal routing detail, not a user-facing subcommand.

6. **`[s]` Setup:** Re-spawn `switchboard setup` via the existing pattern (cli.ts:1783). `exitFlushed(code)` on child exit. Identical to the current offline `[3]` / online `[2]` behavior.

7. **`[a]` About:** Re-spawn `switchboard about` via the same pattern. `exitFlushed(code)` on child exit.

8. **`[q]` / Enter / EOF:** `exitFlushed(0)`. Unchanged.

9. **Invalid input:** `prompter.close()` and `continue` (re-loop). Unchanged from current behavior (cli.ts:1744).

#### [MODIFY] `cmdBoardConsole` (cli.ts:1808) — trim redundant Setup option

**Context:** `cmdBoardConsole` currently renders a 5-option menu including `[5] Setup & Scaffolding Wizard` (cli.ts:1856, case at cli.ts:1957). Once Setup is top-level (`[s]` in `cmdMainMenu`), this entry is redundant and confusing (the operator reaches the board console *from* the main menu, where Setup is already visible).

**Logic:**
- Remove the `[5] Setup & Scaffolding Wizard` line from the menu render (cli.ts:1856).
- Remove the `case '5'` branch (cli.ts:1957-1970).
- Change the prompt from `Select an option [1-5]` to `Select an option [1-4]` (cli.ts:1865).
- Change the numeric validation from `/^[1-5]$/` to `/^[1-4]$/` (cli.ts:1871).
- The remaining four options (Browse by Column, Search, Filter by Project, Fleet) are unchanged. The plan-prefix direct-dispatch path (cli.ts:1975-1988) is unchanged.

**Edge Cases:**
- `cmdBoardConsole` is also reachable if any future caller invokes it directly. Removing `[5]` does not break the function — it simply no longer offers Setup, which remains reachable via `switchboard setup` and the top-level `[s]`.
- The `exitFlushed()` after the switch block (cli.ts:1972) is preserved — `cmdBoardConsole` still exits after one action. The Back behavior is provided by the parent `cmdMainMenu` looping after the re-spawned child exits, NOT by `cmdBoardConsole` itself.

#### [PRESERVE] Non-TTY & subcommand bypass — no changes

- Non-interactive environments (pipes, scripts, agent shells) never block on stdin; the non-TTY guard at cli.ts:1668 exits 0. Unchanged.
- All explicit subcommands (`local`, `tailnet`, `plans`, `ready`, `dispatch`, `fleet`, `setup`, `stop`, `status`, `logs`, `secrets`, `token`, `export`, `import`, `verb`, `help`, `about`, `version`) continue to route directly in `main()` (cli.ts:2007-2766) without showing the interactive front-door menu. Unchanged.
- The bare-`switchboard` routing (`!firstArg` → `cmdMainMenu`, cli.ts:2776) is unchanged — only the body of `cmdMainMenu` changes.

## Verification Plan

### Automated Tests
1. **Non-interactive safety:** Assert `node ./out/standalone/cli.js < /dev/null` does not hang and exits cleanly (exit 0, no menu rendered).
2. **Direct subcommand bypass:** Assert `switchboard local --help`, `switchboard plans --json`, `switchboard fleet --json`, `switchboard about --json`, and `switchboard setup --help` execute directly without prompting.
3. **Menu input routing:** Feed mocked readline inputs and assert correct handler activation:
   - `1\n1\n` (offline) → re-spawns `switchboard local`.
   - `1\n2\n` (offline) → re-spawns `switchboard tailnet`.
   - `1\n` (online, server running) → prints server URL, does NOT attempt to start a second server.
   - `2\n` → re-spawns board console child; on child exit, parent re-loops to main menu.
   - `s\n` → re-spawns `switchboard setup`.
   - `a\n` → re-spawns `switchboard about`.
   - `q\n` or EOF → exits 0.
4. **Board console trim:** Assert `cmdBoardConsole` no longer renders a `[5] Setup` line and rejects input `5` as invalid.

### Manual Verification
1. Run `switchboard` in an interactive terminal over SSH with no server running.
2. Verify the top-level menu shows fixed `[1] GUI Mode` / `[2] CLI Mode` / `[s] Setup` / `[a] About` / `[q] Exit` — same shape regardless of server state.
3. Select `1` (GUI Mode) → verify the sub-menu offers Start Local / Start Remote / Back (offline) or shows the running server URL with Open-in-Browser / Back (online).
4. Start a server in another pane (`switchboard local --detach`), then run `switchboard` again and select `1` → verify it shows the running URL and does NOT offer "Start Local" (which would error).
5. Select `2` (CLI Mode) → verify the board console opens, shows 4 options (no `[5] Setup`), and after any action the parent returns to the main menu (Back).
6. Select `2` with no server running → verify offline guidance prints and the parent returns to the main menu (not a hard exit to shell).

### Goal Invariants
- Bare `switchboard` on a TTY prompts with the fixed top-level GUI/CLI branch menu — the menu shape is identical whether a server is online or offline.
- Direct subcommands (`local`, `tailnet`, `plans`, `dispatch`, `fleet`, `setup`, `about`, etc.) bypass the menu completely.
- Non-TTY invocations never hang waiting for input (exit 0).
- The GUI sub-menu, when a server is already running, does NOT offer "Start Local Board" (negative invariant) — it shows the running server URL instead (positive invariant).
- `cmdBoardConsole` no longer contains a `[5] Setup` menu entry (negative invariant) — Setup is reachable via the top-level `[s]` and `switchboard setup` (positive invariant).
- `src/standalone/cli.ts` maintains parity with all existing `LocalApiServer` HTTP endpoints — no endpoint is added, removed, or renamed by this refactor.
- `banner(version)` is the single banner function used by both `cmdMainMenu` and `cmdAbout` — no second banner string is introduced (negative invariant: no string literal containing "Autonomous Agent Fleet Console" exists in `cli.ts`).

## Outstanding Questions
- **[user]** When a server is already running and the operator picks GUI Mode, should the sub-menu (a) print the URL and attempt to open a browser, or (b) print the URL and also offer a "Switch to CLI Board Console" shortcut? — proceeding on the assumption that (a) is sufficient; the operator can back out and pick CLI Mode from the top level.
