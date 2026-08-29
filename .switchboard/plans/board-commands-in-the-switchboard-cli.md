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
implements `secrets`, `scaffold`, `control-plane`, `stop`, `status`, `logs`, `init`, `migrate`,
`import`, `export`, `agents`. More precisely, it already has the exact category these commands belong
to: `stop`, `status` and `logs` are excluded from `subcommandTargetsCwd` because they are *"read-only
queries against an existing `.switchboard/` — they must not create one in a directory that has none"*
(`cli.ts:605-611`). Board commands join that list unchanged.

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
actively hostile on glass. Accepting a unique short prefix (the listing already prints one) removes
that cost for every device at once.

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

## Metadata

**Complexity:** 4
**Tags:** cli, ux, backend

## Three consumers, one vocabulary

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

## Auth: nothing to do locally, one token remotely

`_checkAuth` (`LocalApiServer.ts:881`) returns `true` when no token is configured — *"keep the
historical loopback-trust behavior"* — so on the machine running the board the CLI needs no
credentials at all. When a token **is** set, it accepts `Authorization: Bearer <token>` or the
`sb_session` cookie, constant-time compared.

`switchboard secrets set apiToken <value>` already exists, so the CLI can read the token from the
secrets store and attach the header itself. The user authenticates once; every later command is a bare
verb. That is what makes the over-Tailscale case (an iPad against a homelab board) as terse as the
local one — and it means the token never appears in shell history or in a command an agent printed for
someone to paste.

## One implementation, three doors

Dispatch already has two doors — the board's drop path (`KanbanProvider.ts:11604`) and
`performKanbanDispatch` (`LocalApiServer.ts:1141-1180`) — running the same three steps
(complexity-route, move, fire) in two files. That duplication is why the agent-facing side drifted
from the board's, and it is not to be extended.

**The CLI is a third door onto `performKanbanDispatch`, reached over HTTP like any other client.** It
must not reimplement routing, the visible-agent check, or the column move; it must not write
`kanban.db`; and it must not grow its own idea of what dispatch means. If the CLI and the MCP tool ever
disagree about an outcome, that is the bug this section exists to prevent.

## Proposed Changes

1. **`switchboard ready [column]`** — the primary command. With no argument it lists the dispatchable
   set: `PLAN REVIEWED` (coding) and `CREATED` (planning), subtasks excluded, honouring the active
   project filter — the same definition the Mission Control protocol's `## What Is Ready To Go` already
   uses, so there is one answer to "what is ready" rather than two. Output is a numbered list of
   `type · title · short id`.

   Then it **prompts for a number and dispatches that card.** Enter alone exits without acting — one
   command, one keystroke, on any device.

   Naming is the user's call — `ready` matches the existing protocol vocabulary, but the request was
   phrased as `switchboard planned`. Pick one name and use it in both the CLI and the MCP tool.

2. **`switchboard dispatch <planId|prefix> [column]`** — the direct form, for when the card is already
   known. Accepts a unique short id prefix as well as a full planId; an ambiguous prefix lists the
   matches and exits non-zero rather than picking one. Omitted column means `auto`, which is `performKanbanDispatch`'s existing
   complexity routing. Surface the `400` from `_canonicalColumnId` verbatim on a bad column: it lists
   the valid ids and is the caller's self-correction signal.

3. **`--json` on both**, following `status` exactly: `routeLogsToStderr()` then `emitJson(...)`, so
   stdout is parseable. `--json` also **suppresses the prompt** — a non-interactive invocation must
   never block waiting on stdin.

4. **Never prompt when stdin is not a TTY.** Print the list and exit 0. A piped or `nohup`-ed
   invocation that blocks forever on a hidden prompt is the worst failure mode this command has.

5. **Reuse the existing preconditions.** `findRunningInstance` → if null, print the same *"No running
   Switchboard instance for this workspace"* message `status` prints, and `exitFlushed(1)`. Add these
   commands to the `subcommandTargetsCwd` exclusion list so they never create a `.switchboard/`.

6. **Exit codes that mean something.** `0` dispatched or listed; `1` no running instance; `2` nothing
   ready; `3` dispatch refused by the server (no live terminal, no coding agent enabled), with the
   server's own error text printed rather than a paraphrase.

## Verification Plan

1. **The phone path end to end.** With a running instance and cards in `PLAN REVIEWED`, run
   `switchboard ready`, enter `2`, assert the second listed card is dispatched — verified by asking the
   API, not by trusting the command's own output.
2. **It calls the shared entry point.** Assert the CLI reaches `performKanbanDispatch` over HTTP and
   does not implement routing, the agent-visibility check, or the column move itself. This is the
   *One implementation* rule made testable, and it is the assertion that stops the third door becoming
   a third implementation.
3. **Never blocks without a TTY.** Run with stdin piped from `/dev/null` and assert it lists and exits
   0 rather than waiting. Repeat with `--json`.
4. **`--json` is parseable.** Assert stdout is valid JSON with logs on stderr, matching `status`'s
   contract.
5. **The ready set matches the protocol's.** Assert the command's output equals what
   `## What Is Ready To Go` defines — subtasks excluded, only the two columns, project filter honoured.
   A card listed here that an agent would not consider ready is two definitions of one question.
6. **No instance, no side effects.** In a directory with no `.switchboard/`, assert the command exits 1
   with the standard message and **creates no directory** — the `subcommandTargetsCwd` guarantee.
7. **Refusals surface verbatim.** With no live coding terminal, assert exit 3 and the server's own
   error text, not a rewrite of it.
8. **Empty board.** Assert exit 2 and a plain "nothing ready" line, not an empty list that reads like a
   failure.
9. **Both hosts.** The CLI is the standalone host's entry point, so this ships there by construction —
   but assert the extension host is unaffected: the same `LocalApiServer` serves both, and adding a CLI
   caller must not change any behaviour the extension sees.

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
