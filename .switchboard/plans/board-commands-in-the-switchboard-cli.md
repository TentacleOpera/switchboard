# Give the CLI board commands, so the board can be driven from a terminal without a GUI or an agent

## Goal

Add read-and-dispatch board commands to `npx switchboard`, so the common lifecycle — see what is ready,
pick one, dispatch it — is a terminal command rather than a conversation. The work is mechanical: an
agent is an expensive way to make an HTTP call.

**The audience is anyone at a terminal**, not a mobile edge case: an iPad with a keyboard over SSH, a
laptop user who would rather type than reach for a browser tab, a tmux session on the machine itself,
and a phone. The GUI is one way to drive the board and should not be the only one.

### Problem Analysis

**The only way to drive the board today is an agent or a browser.** Every board operation goes through
`curl` against `LocalApiServer`, and the surfaces that wrap it are the browser board, the VS Code
panels, and agent skills. For anyone working in a terminal, none of those fit: the board is a desktop
GUI, and an agent session costs a model round trip, a permission prompt per shell call, and
non-determinism, for an operation that is a `GET` and a `POST`.

That gap is widest away from a desktop — an SSH session from an iPad or a phone has no browser board
worth using — but it is not created by the small screen. A keyboard user on the same machine as the
board has the same objection: a GUI and a chat loop are both slower than a command they already know.

**The CLI already has the shape.** `src/standalone/cli.ts` dispatches on `process.argv[2]` and already
implements `secrets`, `scaffold`, `control-plane`, `stop`, `status`, `logs`, `init`, `import`,
`export`, and `token`.

> **Superseded:** "already implements `secrets`, `scaffold`, `control-plane`, `stop`, `status`, `logs`,
> `init`, `migrate`, `import`, `export`, `agents`."
> **Reason:** `agents` is not a subcommand — it is a `--target` value for `init` (`cli.ts:911`).
> `migrate` is not a subcommand — it is a sub-verb of `control-plane`. The `KNOWN_SUBCOMMANDS` set
> (`cli.ts:628-631`) contains neither. The inflated list made "board commands join an existing
> category" sound inevitable; the real category — the `subcommandTargetsCwd` exclusion list — is
> `stop`, `status`, `logs` (three commands), and that is the precedent board commands join.
> **Replaced with:** the corrected list above. The argument does not need the inflation: `stop`,
> `status`, and `logs` are the exact category these commands join, and that category is real.

More precisely, `stop`, `status` and `logs` are excluded from `subcommandTargetsCwd` because they are
*"read-only queries against an existing `.switchboard/` — they must not create one in a directory that
has none"* (`cli.ts:675-680`). Board commands join that list unchanged.

**And the plumbing is built.** `status` (`cli.ts`) is the template: `findRunningInstance(workspaceRoot)`
returns a port or null; `getHealthJson(port)` fetches health; a `--json` flag calls
`routeLogsToStderr()` then `emitJson(...)` so stdout is machine-readable; `exitFlushed(n)` sets the
code. Every piece a new command needs already exists and is already used this way.

**Both affordances are first-class.** A numbered picker is the fastest way to act on something you are
looking at, on any device — no id to read, copy or retype. A direct `dispatch <id>` is the fastest way
to act on something you already know, which is the common case for a keyboard user returning to a card
they just planned. Neither is a concession to the other, and the plan ships both rather than treating
one as a fallback.

What the small screen does change is id entry: a full UUID is unreasonable to type anywhere and
actively hostile on glass. Accepting a unique short prefix (the listing prints one, computed by the
CLI from the full `planId` the API returns) removes that cost for every device at once.

### Root Cause

The CLI was built to run and manage the *server*. Nothing was built to drive the *board* from a
terminal, because until there was a phone in the loop the browser board was always at hand.

### Non-goals

- **Not a replacement for the MCP surface, but a partial substitute — see *Three consumers* below.**
  An earlier revision of this plan said a CLI command "costs the same permission prompt `curl` does".
  That is wrong in the way that matters: a stable command prefix is **safely allowlistable** where
  `curl` is not, so the CLI narrows the gap MCP exists to close.
- **Not a TUI.** A numbered list and a prompt, not a full-screen interface. It must work over a flaky
  phone connection and in a scrollback buffer.
- **Not board mutation beyond dispatch.** No renaming, no feature editing, no column administration.
  Those have surfaces already.

### Three consumers, one vocabulary

The commands serve three callers, and the second and third were missing from an earlier revision:

1. **A human at a terminal** — the case the plan opens with.
2. **An agent, shelling out.** `Bash(switchboard:*)` is a **narrow** allowlist: it grants the board
   verbs and nothing else. Compare this repository's own `.claude/settings.json`, which allowlists
   `Bash(curl *)` — one line that also grants curl to anywhere on the internet. A user who wants an
   agent to drive the board without a prompt per call currently has to choose between broad curl access
   and answering prompts; a `switchboard` prefix is the narrow option that does not exist yet. The
   agent also stops hand-assembling JSON, resolving a dynamic port, and parsing prose errors — it reads
   exit codes (change 6).
3. **An agent advising a human**, side by side. The agent prints `switchboard dispatch a1b2c3` and the
   user pastes it. This needs no permissions, no auth on the agent's side, and no board reachability
   from wherever the agent runs — which makes it the only one of the three that works from a cloud
   session. It is also the house idiom already: `refine_ticket` and `refine_feature` are described in
   `CLAUDE.md` as skills fired when the user clicks Refine *"to copy a prompt"*, and the retired
   `external` automation mode was literally *"Copy a prompt for your external scheduler."*

Consumer 3 is why the commands must be **short, memorable and stable**. A command a human retypes from
a chat window is a different contract from one a script generates: renaming a verb breaks muscle memory
and every transcript that ever suggested it.

### Auth: nothing to do locally, one token remotely

`_checkAuth` (`LocalApiServer.ts:1134`) returns `true` when no token is configured — *"keep the
historical loopback-trust behavior"* — so on the machine running the board the CLI needs no
credentials at all. When a token **is** set, it accepts `Authorization: Bearer <token>` or the
`sb_session` cookie, constant-time compared.

**Two sibling plans own the credential path, and this one must not solve it a third time.**
`switchboard-clients-send-api-auth-header.md` opens with the fact that decides it: *"Not one shipped
client sends an `Authorization` header."* A new client that invents its own token lookup makes that
worse. That plan adds *"one shared discovery routine per language (bash, Node)"* — the CLI is Node and
uses that routine.
`publish-agent-api-token-for-out-of-process-agents.md` supplies what the routine discovers: an agent
token minted at boot and published to `.switchboard/api-server-token.txt` at `0600`, **beside the port
file this CLI already reads**. Same directory, same pattern, one extra read.

Between them the user authenticates once and attaches nothing by hand. The user authenticates once; every later command is a bare
verb. That is what makes the over-Tailscale case (an iPad against a homelab board) as terse as the
local one — and it means the token never appears in shell history or in a command an agent printed for
someone to paste.

### One implementation, three doors

Dispatch already has two doors — the board's drop path and `performKanbanDispatch`
(`LocalApiServer.ts:1853`) — running the same three steps (complexity-route, move, fire) in two files.
The board's drop path is `promptOnDrop` (`KanbanProvider.ts:11039`): it resolves the dispatch spec,
calls `moveCardToColumn`, then `dispatchConfiguredKanbanColumnAction`. `performKanbanDispatch` does the
same three steps server-side. That duplication is why the agent-facing side drifted from the board's,
and it is not to be extended.

> **Superseded:** "the board's drop path (`KanbanProvider.ts:11604`)"
> **Reason:** Line 11604 is inside `promptSelected` (a click handler that resolves `CODED_AUTO` to its
> backing column), not the drop path. The actual drag-drop dispatch path is the `promptOnDrop` case arm
> at `KanbanProvider.ts:11039`. Citing the wrong line undermined the "I read the code" claim behind the
> two-doors argument.
> **Replaced with:** `promptOnDrop` at `KanbanProvider.ts:11039` — the case arm that does
> move-then-fire on a drop, the genuine second door alongside `performKanbanDispatch`.

**The CLI is a third door onto `performKanbanDispatch`, reached over HTTP like any other client.** It
must not reimplement routing, the visible-agent check, or the column move; it must not write
`kanban.db`; and it must not grow its own idea of what dispatch means. If the CLI and the MCP tool ever
disagree about an outcome, that is the bug this section exists to prevent.

## Metadata

**Complexity:** 4
**Tags:** cli, ux, backend

## User Review Required

**No.** This plan adds two read/query subcommands to `src/standalone/cli.ts` that call existing HTTP
endpoints (`GET /kanban/plans`, `POST /kanban/dispatch`) over loopback. It does not modify the
authentication gate, the dispatch machinery, or the kanban database. The one behavior worth a human
eyeball — that an EOF or dropped connection during the interactive `ready` prompt must NOT dispatch a
card — is specified explicitly in change 4 and asserted by verification step 4b. No gate is required
before implementation; a reviewer should confirm the readline EOF/SIGINT handling on read.

## Complexity Audit

### Routine
- Adding two subcommands (`ready`, `dispatch`) to the `process.argv[2]` dispatch in `cli.ts`, modelled on the existing `status` command.
- Reusing `findRunningInstance`, `getHealthJson`, `routeLogsToStderr`, `emitJson`, `exitFlushed` — all already present and already used this way by `status`/`logs`.
- Adding the two verbs to the `subcommandTargetsCwd` exclusion condition (`cli.ts:679`) so they never create a `.switchboard/`.
- Calling `GET /kanban/plans?column=...` and filtering subtasks (`featureId === ''`) and project client-side, exactly as the Mission Control protocol's `ready()` jq does.
- Calling `POST /kanban/dispatch` with `{ plan, targetColumn }` and mapping the response to an exit code.
- Computing a short id prefix from the full `planId` for display, and resolving a prefix back to a full id by fetching the candidate set and matching.

### Complex / Risky
- **The active project filter is not exposed over HTTP.** `GET /kanban/plans` has no `project` param (`LocalApiServer.ts:6428-6445`), and no endpoint exposes the `kanban.activeProjectFilter` config value the board reads via `getConfigSync`. The Mission Control protocol gets the filter *injected into its prompt by the host*; the CLI has no equivalent. Without a `--project` flag the `ready` command lists every project's cards and silently breaks the parity claim. See change 1a and Outstanding Questions.
- **Interactive prompt over a flaky connection.** The `ready` picker reads a number from stdin. An EOF (Ctrl-D) or SIGINT or dropped SSH pipe mid-prompt must exit 0 without dispatching — over the stated audience (iPad over SSH, phone) a dropped connection is the common case, not an edge case. A readline that dispatches on EOF sends a card to a coder with no one at the keyboard.
- **Exit-code completeness.** The server returns 400 (bad column / `KanbanDispatchError`), 404 (plan not found), 409 (no terminal live), 502 (move persisted, no dispatch observed), 503 (dispatch unavailable), and 500. The exit-code table must map all of them, or an agent reading an exit code cannot distinguish "you typed the column wrong" from "no terminal is live" from "that prefix matches nothing."

## Edge-Case & Dependency Audit

- **Race Conditions:** None owned by this plan. Dispatch serialization is `performKanbanDispatch`'s concern; the CLI is an HTTP client and inherits whatever ordering the server enforces. The CLI must not retry a dispatch on a transient failure — a retry could double-dispatch if the first call moved the card but the response was lost. One call, one result, map the exit code.
- **Security:** The CLI must never print a resolved token value (logs, error messages, debug output). It reports only the token *source* (env / file / none), matching the sibling auth-header plan's invariant. The `--project` flag value is user input echoed in listings — not sensitive.
- **Side Effects:** `ready` (no selection) and `--json ready` are read-only. `ready` (with a selection) and `dispatch` fire `POST /kanban/dispatch`, which moves a card and may launch an agent — the intended side effect. No `.switchboard/` creation (the `subcommandTargetsCwd` guarantee). No kanban.db writes.
- **Dependencies & Conflicts:**
  - **`switchboard-clients-send-api-auth-header.md`** — the shared Node token-discovery routine (`.agents/skills/_lib/sb_http.js`). The CLI should `require` it rather than adding a fourth lookup. If that plan has not landed, the CLI falls back to loopback-trust (no token) and the remote case is simply unavailable — not broken.
  - **`publish-agent-api-token-for-out-of-process-agents.md`** — publishes `api-server-token.txt` beside the port file. The CLI reads both from the same `.switchboard/` directory.
  - **`GET /kanban/plans` has no `project` query param.** The CLI filters project client-side (like the protocol's jq), using the `--project` flag value. This is not a conflict — it is the same client-side filter the protocol already does — but it means the CLI cannot *default* to the board's active filter without a future endpoint that exposes it.
  - **`performKanbanDispatch` returns a status-code space, not just success/failure.** The CLI's exit-code mapping must cover the full set (see change 6), not just the happy path and the two cases the original plan named.

## Dependencies

- **`switchboard-clients-send-api-auth-header.md`** — the shared per-language token discovery routine.
  The CLI consumes it rather than adding a fourth lookup.
- **`publish-agent-api-token-for-out-of-process-agents.md`** — publishes `api-server-token.txt` beside
  the port file, which is what that routine discovers.

Neither blocks shipping: with no token configured, `_checkAuth` returns `true` and the CLI works
unauthenticated on loopback today. They block the **remote** case — an iPad against a homelab board —
so the ordering is: commands first, credentials when the surface leaves loopback.

## Adversarial Synthesis

Key risks: (1) the active project filter is undiscoverable over HTTP — `GET /kanban/plans` has no
`project` param and no endpoint exposes `kanban.activeProjectFilter`, so without a `--project` flag the
`ready` command lists every project's cards and silently breaks the protocol-parity claim; (2) an
EOF/SIGINT/dropped-pipe during the interactive `ready` prompt could dispatch a card with no one at the
keyboard — over the stated SSH/phone audience a dropped connection is the common case; (3) the
exit-code table left 400/404/502/503 unmapped, so an agent reading an exit code could not distinguish
a caller error from a server refusal. Mitigations: a `--project <name>` flag (empty = no filter,
matching the protocol's empty-filter semantics) as the v1 mechanism; readline EOF/SIGINT handlers that
exit 0 without dispatching; a complete exit-code table covering the full `performKanbanDispatch` status
space.

## Proposed Changes

1. **`switchboard` (bare command) / `switchboard ready [column] [--project <name>] [--json]`** — the primary interactive terminal interface.
   - **`switchboard`** with no subcommand is the front door: it connects to the running Switchboard server and presents the interactive board console.
   - **UFO ANSI Art Banner:** On TTY interactive launch, renders a compact, glowing cyan UFO ANSI art banner (matching the webview's `switchboard-ufo.svg` brand asset and theme-accent palette). Suppressed when `--no-ansi` is given, under `--json`, or when stdout is not a TTY.
     ```text
            .---.
      _...-'     '-..._       SWITCHBOARD
    .-~  ●   ●   ●   ●  ~-.   Autonomous Agent Fleet Console
   (________________________)
         \   :    :   /
          \  :    :  /
     ```
   - If no server is running, it exits cleanly (code 1) with:
     ```text
     No running Switchboard server for this workspace.
       Start local server:   switchboard local
       Start remote tailnet: switchboard tailnet
     ```
   - **Server startup separation:** `switchboard local` and `switchboard tailnet` are the explicit server start commands (local loopback vs tailnet remote access). Bare `switchboard` never silently launches a server in the background; it drives the board.
   - Output is a numbered list of `type · title · short id`. Then it **prompts for a number and dispatches that card.** Enter alone exits without acting — one command, one keystroke, on any device.

   **1a. `--project <name>` (the filter-discovery fix).** `GET /kanban/plans` accepts `column` and
   `featureId` but **not** `project` (`LocalApiServer.ts:6428-6445`), and no endpoint exposes
   `kanban.activeProjectFilter` (the config-table value the board reads via `getConfigSync`). The
   Mission Control protocol gets the filter injected into its prompt by the host; the CLI has no
   equivalent injection. Therefore the CLI takes the filter explicitly: `--project <name>` filters
   client-side (keep only rows whose `project` equals the value exactly, matching the protocol's jq).
   Omitted/empty `--project` = no filter (matches the protocol's empty-filter behavior — keep
   everything). A future `GET` endpoint exposing `kanban.activeProjectFilter` would let the CLI default
   to the board's active filter; until then the flag is the explicit mechanism and the parity claim
   holds only when the user passes it.

2. **`switchboard dispatch <planId|prefix> [column] [--project <name>] [--json]`** — the direct form,
   for when the card is already known. Accepts a unique short id prefix as well as a full planId; an
   ambiguous prefix lists the matches and exits non-zero (exit 5) rather than picking one.

   **Prefix search scope = all columns.** The resolver fetches the full board (`GET /kanban/plans`
   without a column filter, or `GET /kanban/board`) and matches the prefix against every card's
   `planId`, not just the two ready columns — a card sitting in `STAGING` that someone wants to
   re-dispatch must be findable. `--project`, when given, narrows the search set the same way it
   narrows `ready`.

   Omitted column means `auto`, which is `performKanbanDispatch`'s existing complexity routing. Surface
   the `400` from `_canonicalColumnId` verbatim on a bad column: it lists the valid ids and is the
   caller's self-correction signal.

3. **`--json` on both, following `status` exactly: `routeLogsToStderr()` then `emitJson(...)`, so
   stdout is parseable.** `--json` also **suppresses the prompt** — a non-interactive invocation must
   never block waiting on stdin.

   **`--json ready` is list-only.** The non-JSON `ready` is list+pick+dispatch in one command; the
   `--json` form lists and exits (no dispatch path), because a machine consumer cannot answer a
   prompt. A machine consumer does list-then-dispatch as two calls: `switchboard ready --json` then
   `switchboard dispatch <id> --json`. The `--json` flag is a *behavior* flag on `ready`, not just a
   format flag — state this in `--help`.

4. **Never prompt when stdin is not a TTY.** Print the list and exit 0. A piped or `nohup`-ed
   invocation that blocks forever on a hidden prompt is the worst failure mode this command has.

   **EOF / SIGINT / dropped pipe during the interactive prompt = exit 0, no dispatch.** Over a flaky
   phone connection or a dropped SSH session (the stated audience), a readline that dispatches the
   highlighted card when the pipe breaks sends a card to a coder with no one at the keyboard. The
   prompt handler must treat EOF, SIGINT, and any read error as "user left" — exit 0, print nothing
   was dispatched. Only a valid numeric line that resolves to a listed card dispatches.

5. **Reuse the existing preconditions.** `findRunningInstance` → if null, print the same *"No running
   Switchboard instance for this workspace"* message `status` prints, and `exitFlushed(1)`. Add these
   commands to the `subcommandTargetsCwd` exclusion list so they never create a `.switchboard/`.

6. **Exit codes that mean something — the full table.** `0` dispatched or listed; `1` no running
   instance; `2` nothing ready; `3` dispatch refused by the server (HTTP `409` no terminal live, or
   `502` move persisted but no dispatch observed), with the server's own error text printed rather than
   a paraphrase; **`4` authentication failed** (HTTP `401`); **`5` caller error** (HTTP `400` bad
   column / `KanbanDispatchError`, `404` plan not found, or an ambiguous prefix) — retryable with
   different input, with the server's error text printed verbatim; **`6` dispatch unavailable**
   (HTTP `503` — extension callbacks missing); **`1`** is also used for an uncaught `500` (the board is
   reachable but broke — indistinguishable from "no instance" from the caller's perspective without the
   printed text, which names the difference).

   `4` is separate from `1` deliberately. `switchboard-clients-send-api-auth-header.md` names the
   failure it prevents: a 401 reported as *"the extension isn't running"* sends the user to restart a
   board that is running fine. A board answering `401` is reachable — say so, and name the remedy.

7. **`switchboard clear <terminal|--all> [--json]`** — clean terminal reset. Executes an unbracketed
   `/clear\r` (preceded by `\x15` / Ctrl+U to clear pending input line) outside of bracketed-paste escape
   framing, resets terminal work-context, and drops seat block caches. Reaches `POST /terminals/verb/ptyClearTerminal`
   or `POST /terminals/clear`.
   - `switchboard clear Coding` clears the specified seat.
   - `switchboard clear --all` clears all active seats in the fleet.
   - Outputs a concise confirmation: `Cleared Coding (OK)`.

8. **`switchboard fleet [--json]` (or `switchboard status --fleet`)** — concise live terminal inspection.
   Queries active seats, roles, liveness, and assigned plans from `POST /terminals/verb/ptyListTerminals` /
   `GET /health`, formatting a compact table on stdout:
   ```text
   SEAT            ROLE      STATUS    CURRENT PLAN / TASK
   Coding          lead      active    Shell Cockpit Restructure (4c1323fb)
   Coding-coder-1  coder     idle      -
   Coding-coder-2  coder     idle      -
   Coding-intern   intern    idle      -
   reviewer-1      reviewer  active    Reviewing 2213b3a1
   ```
9. **`switchboard verb <verbName> [jsonPayload]` (Universal Verb Dispatcher)** — direct CLI access to the
   entire Switchboard protocol catalog (550+ verbs). Reaches `POST /terminals/verb/<verbName>` or `POST /kanban/verb/<verbName>`:
   ```bash
   # Call any protocol verb directly with JSON payload or args
   switchboard verb ptyClearTerminal '{"name":"Coding"}'
   switchboard verb moveCard '{"planId":"5589139b...","column":"CODER CODED"}'
   switchboard verb addStandingOrder '{"parent":"Coding","instruction":"..."}'
   ```
   - Automatically handles local authentication headers, port discovery, and response error formatting.
   - Emits clean JSON on stdout with `--json` or human-readable status on stdout.
   - This ensures **100% of Switchboard's verbs** are instantly callable from the CLI without needing specialized subcommands written for each one.

10. **`switchboard help [command]`** — top-level help command. Aliased to `--help` and `-h`, displaying the
    full command list, serve modes, verb runner syntax, and exit-code semantics.

11. **`switchboard about` / `switchboard version`** — system info & identity banner. Aliased to `--version`
    and `-v`. Displays the styled UFO ANSI banner, version number (from `package.json`), repo commit,
    runtime host type, active server URL (loopback + Tailscale IP if active), current workspace root,
    and a summary of live fleet seats:
    ```text
           .---.
     _...-'     '-..._       SWITCHBOARD v1.7.13
    .-~  ●   ●   ●   ●  ~-.   Autonomous Agent Fleet Console
   (________________________)
         \   :    :   /       https://github.com/TentacleOpera/switchboard
          \  :    :  /        Host: Standalone (Linux x86_64)

    Active Server:    http://127.0.0.1:7777 (Local)
    Tailscale Mesh:   http://100.110.206.86:7777 (Connected)
    Workspace:        switchboard (/home/patrick/switchboard)
    Active Fleet:     6 seats (1 lead, 2 coders, 1 intern, 1 reviewer, 1 analyst)
    ```
    Under `--json`, outputs `{ version: "1.7.13", service: "switchboard", host: "standalone", ... }`.

    > **Superseded:** the original six-code table that left `400` (bad column), `404` (plan not found),
   > `502` (move persisted, no dispatch), and `503` (dispatch unavailable) unmapped.
   > **Reason:** An agent reading exit `3` could not distinguish "no terminal live" from "you typed the
   > column wrong" from "that prefix matches nothing." The principle "exit codes that mean something"
   > only holds if *all* exits mean something; half the failure space forcing a script to parse prose
   > defeats the purpose.
   > **Replaced with:** the complete table above — `5` for caller errors (retryable), `3` for server
   > refusals (card did not dispatch), `6` for dispatch-unavailable, with `1` retaining the
   > unreachable/broke case and `4` the auth case.

## Verification Plan

### Automated Tests

1. **A 401 is not reported as a dead board.** With auth enabled and no credential, assert exit `4` and
   a message naming authentication and its remedy — never the "No running Switchboard instance"
   message. This is the specific misdiagnosis the sibling plan exists to prevent, and a new client is
   the most likely place to reintroduce it.
2. **The terminal path end to end.** With a running instance and cards in `PLAN REVIEWED`, run
   `switchboard ready`, enter `2`, assert the second listed card is dispatched — verified by asking the
   API, not by trusting the command's own output.
3. **It calls the shared entry point.** Assert the CLI reaches `performKanbanDispatch` over HTTP and
   does not implement routing, the agent-visibility check, or the column move itself. This is the
   *One implementation* rule made testable, and it is the assertion that stops the third door becoming
   a third implementation.
4. **Never blocks without a TTY.** Run with stdin piped from `/dev/null` and assert it lists and exits
   0 rather than waiting. Repeat with `--json`.
   **4b. EOF/SIGINT during the interactive prompt does not dispatch.** With a TTY, pipe an EOF
   (Ctrl-D) and a SIGINT to the prompt after the list prints; assert exit 0 and that **no card was
   dispatched** (verify via the API, not the command's output). Repeat with a closed pipe mid-prompt.
5. **`--json` is parseable.** Assert stdout is valid JSON with logs on stderr, matching `status`'s
   contract. Assert `--json ready` is list-only — it does not dispatch even if a card is selected by
   index in a non-interactive way (there is no selection path under `--json`).
6. **The ready set matches the protocol's.** Assert the command's output equals what
   `## What Is Ready To Go` defines — subtasks excluded, only the two columns, `--project` filter
   honoured when passed and no filter when omitted. A card listed here that an agent would not consider
   ready is two definitions of one question.
   **6b. `--project` filters correctly.** With a board holding cards in two projects, assert
   `--project A` lists only project A's ready cards and `--project` omitted lists both. Assert a
   non-existent project name lists nothing (exit 2), not an error.
7. **No instance, no side effects.** In a directory with no `.switchboard/`, assert the command exits 1
   with the standard message and **creates no directory** — the `subcommandTargetsCwd` guarantee.
8. **Refusals surface verbatim.** With no live coding terminal, assert exit 3 and the server's own
   error text, not a rewrite of it. With a bad column name, assert exit 5 and the server's `400` text
   (which lists valid columns). With a plan-not-found id, assert exit 5 and the `404` text.
9. **Empty board.** Assert exit 2 and a plain "nothing ready" line, not an empty list that reads like a
   failure.
10. **Prefix resolution.** Assert `dispatch <unique-prefix>` dispatches the matching card. Assert an
    ambiguous prefix lists the matches and exits 5. Assert the prefix search spans all columns (a card
    in `STAGING` is findable), not just the two ready columns.
11. **Both hosts.** The CLI is the standalone host's entry point, so this ships there by construction —
    but assert the extension host is unaffected: the same `LocalApiServer` serves both, and adding a CLI
    caller must not change any behaviour the extension sees.
12. **Terminal clear protocol.** Assert `switchboard clear <terminal>` executes unbracketed `\x15` + `/clear\r`
    keypresses against `POST /terminals/verb/ptyClearTerminal` (or `POST /terminals/clear`), wipes work context,
    and reports success. Assert `switchboard clear --all` iterates all active fleet seats.
13. **Fleet inspection.** Assert `switchboard fleet` outputs a clean status table of all active terminals,
    roles, liveness, and assigned plan IDs without downloading raw log files. Assert `--json` outputs parseable JSON.
14. **Universal verb runner.** Assert `switchboard verb <verbName> <jsonPayload>` invokes `POST /terminals/verb/<verbName>`
    or `POST /kanban/verb/<verbName>` and routes responses cleanly with auth and error mapping.
15. **Help subcommand.** Assert `switchboard help` and `switchboard --help` produce identical help output.
16. **About & version display.** Assert `switchboard about`, `switchboard version`, and `switchboard --version`
    render the UFO ANSI art banner, version number, host environment, and active server/fleet connection details.

*(Compilation and automated tests skipped this run per dispatch directive — the checks remain written
for the implementing coder.)*

### Goal Invariants

- `src/standalone/cli.ts` dispatches `process.argv[2] === 'ready'`, `process.argv[2] === 'dispatch'`, `process.argv[2] === 'clear'`, `process.argv[2] === 'fleet'`, `process.argv[2] === 'verb'`, `process.argv[2] === 'help'`, and `process.argv[2] === 'about'`, and all are present in the `subcommandTargetsCwd` exclusion condition (`cli.ts:679`) so none create a `.switchboard/` in a directory that has none.
- `switchboard ready` calls `GET /kanban/plans` (not the kanban DB directly) and filters `featureId === ''` and the `--project` value client-side — it does not open `kanban.db`.
- `switchboard dispatch` calls `POST /kanban/dispatch` with `{ plan, targetColumn }` — it does not call `move-card.js`, does not write `kanban.db`, and does not reimplement complexity routing, the visible-agent check, or the column move.
- `switchboard clear` calls `POST /terminals/verb/ptyClearTerminal` or `POST /terminals/clear` — never `ptySendPrompt` with bracketed paste.
- `switchboard fleet` calls `POST /terminals/verb/ptyListTerminals` or `GET /health` and prints compact output.
- `switchboard verb <name> <payload>` tunnels directly to the verb router on `LocalApiServer`.
- `switchboard help` aliases to `--help`.
- `switchboard about` aliases to `version`, `--version`, and `-v`.
- The exit-code mapping covers every status `performKanbanDispatch` can return: 200→0, 401→4, 409/502→3, 400/404→5, 503→6, 500→1; an ambiguous prefix→5.
- An EOF or SIGINT delivered to the `ready` interactive prompt exits 0 and dispatches no card (assertable via the API: no card's `dispatchedAt` changes).
- `switchboard ready --json` produces JSON on stdout with logs on stderr and exits without dispatching (no selection path under `--json`).
- **Negative invariant:** `switchboard ready` and `switchboard dispatch` do not appear in any code path that writes `kanban.db` or calls `move-card.js`. **Paired positive:** all verbs are reachable in `cli.ts`'s `process.argv[2]` dispatch and route through `LocalApiServer` HTTP endpoints.

## Outstanding Questions

- **[user] Command name: `ready` or `planned`?** The request said `switchboard planned`; the protocol's
  existing vocabulary is "ready to go", and there is no column literally named `PLANNED` (the columns
  are `CREATED`, `PLAN REVIEWED`, `STAGING`, the three coding columns, `CODE REVIEWED`,
  `ACCEPTANCE TESTED`, `COMPLETED`). Whichever is chosen should be used in the MCP tool too — one
  vocabulary, not two names for one operation.
- **[user] Should the MCP tools simply be these verbs?** `switchboard_status` and
  `switchboard_dispatch` in the MCP plan are the same two operations. Making them one vocabulary means
  one thing to learn and one thing to document; keeping them separate lets each surface phrase things
  for its own consumer. Worth settling before either ships.
- **[user] `--project` flag vs. a future config endpoint.** The CLI cannot discover the board's active
  project filter over HTTP today (`GET /kanban/plans` has no `project` param; no endpoint exposes
  `kanban.activeProjectFilter`). Proceeding on the assumption that a `--project <name>` flag (empty =
  no filter) is the v1 mechanism — it preserves the protocol-parity claim when the user passes it
  explicitly. A future `GET` endpoint exposing the active filter would let the CLI default to the
  board's selection without a flag; that is a separate, additive change and not required to ship.
