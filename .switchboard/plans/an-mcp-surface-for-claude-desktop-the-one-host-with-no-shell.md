# An MCP surface for Claude Desktop — the one host that has no shell, and the one the last attempt never actually tested

## Goal

Mount a small MCP surface on `LocalApiServer` so Claude Desktop can drive the board. Desktop is the
only host in use with no shell, so it is the only one that cannot use the CLI, `curl`, or the skill
layer — while still reading plan content directly from a connected workspace folder. Every other host has a terminal and is better
served by `board-commands-in-the-switchboard-cli.md`.

### Problem Analysis

**The previous attempt failed for two reasons that had nothing to do with Claude Desktop.**
`remove-claude-desktop-mcp-bridge-and-cowork-skill.md` records them:

| # | what happened | consequence |
| :--- | :--- | :--- |
| 1 | the config told Desktop to run `npx -y @switchboard/mcp`, and *"`@switchboard/mcp` does not exist on the npm registry (404)"* — the source lived in `src/mcp/` and was never published | **every entry failed to start.** The integration was never once exercised against a running server |
| 2 | `ClaudeDesktopConnector.ts:114-123` wrote one `switchboard-mcp-<slug>` entry **per VS Code workspace folder**, with no cleanup — *"Each click of 'Connect Claude Desktop' adds more entries monotonically"* — reaching 12 | the user's `claude_desktop_config.json` filled with dead entries |

Neither is a Desktop defect. The first is an unpublished package; the second is a connector writing
config without cleanup. "It was extremely buggy" is an accurate memory of debugging a client pointed at
a server that could not exist.

**Both are structurally impossible in the transport the parked bridge plan already settled on.**
`feature_plan_20260805_112400_switchboard_mcp_bridge_server.md` superseded stdio for **Streamable HTTP
mounted as a `/mcp` route on the existing `LocalApiServer`**, on the grounds that a second process
*"buys nothing and costs plenty."* That change alone removes both failures: there is no npm package to
publish, so cause 1 cannot recur; and there is one endpoint at one URL rather than one stdio entry per
folder, so cause 2 has nothing to iterate over.

**And the third root cause names Desktop as its own exception.** The removal plan's cause 3 is *"The
MCP bridge was designed for MCP-only hosts (Claude Desktop) that lack shell/filesystem access. The
user's actual hosts (Claude Code, Antigravity, Devin) all have shell access."* That reasoning is
correct and still holds — it is an argument against MCP for every host **except** the one it names.

**Withdrawn: the permission-prompt justification.** An earlier revision of this plan led with *"in a
host that gates Bash per command, N curls is N prompts, while N MCP tools is one grant."* That argument
is dead twice over. This repository's own `.claude/settings.json` already carries `Bash(curl *)`, so
board calls raise no prompt today; and `Bash(switchboard:*)` would be a *narrower* grant than that once
the CLI ships. MCP is not the cheap way to avoid prompts for a host that has a shell. It is the only
way in for a host that does not.

**Who this is actually for.** A cloud-hosted assistant cannot reach a private address at all — its MCP
fetch originates from the vendor's servers, which is why Gemini Spark was parked and why a tailnet does
not rescue that case either. The audience is an MCP-capable application running as a process on the
user's own machine, without a shell. Claude Desktop is that, and the user reports it as a significant
surface.

**It is not, however, cut off from the workspace.** Desktop reads local files through connected
folders — a grant separate from MCP. So the gap this plan fills is narrower and cleaner than "Desktop
can see nothing": it has the *files* and lacks the *board*. Column, membership, `dispatched_at` and the
terminal roster live in `kanban.db`, and dispatch is an action, not a file. That is precisely the
MCP-shaped remainder.

### Root Cause

The integration was judged on an experience that never included a working server. The verdict "buggy"
attached to Claude Desktop, when the defects were an unpublished dependency and a connector with no
cleanup — both on the Switchboard side, and both already designed away.

### Non-goals

- **Not for hosts with a shell.** Claude Code, Antigravity, Devin, Cursor and a terminal on the box all
  use the CLI. Registering this for them would be a second vocabulary for no gain.
- **Not a remote surface.** No tunnel, no OAuth, no public exposure. The parked plan's analysis of what
  a tunnel exposes stands and is not revisited here.
- **Not a generic passthrough.** A `{method, path}` tool converts a curated list into the entire private
  API.
- **Not a revival of `@switchboard/mcp` or the Cowork skill.** Both were removed correctly.

## Metadata

**Complexity:** 6
**Tags:** infrastructure, backend, feature

## Design constraints inherited from the failure

These are not suggestions; they are the two defects restated as rules, so an implementer cannot
reintroduce them.

1. **No separate package, ever.** The tool handlers call the same in-process paths the HTTP routes call
   — `performKanbanDispatch()`, `_options.moveCard`, `_resolveBoard()`, the verb routers — and never
   HTTP-call the server from within itself (`LocalApiServer.ts:1141-1144`). Nothing to publish means
   nothing to 404.
2. **One config entry, ever, and it is cleaned up.** One URL for the whole installation, not one entry
   per workspace folder. Connecting twice must be idempotent, and disconnecting must remove what it
   wrote. Verification asserts both.

## Proposed Changes

1. **Mount `/mcp` on `LocalApiServer`** using Streamable HTTP; the parked plan records its transport
   mount as accurate for the installed SDK (1.25.3). Start from it.

2. **Seven tools, use-case shaped.** Settled with the user; not endpoint-shaped, and not the parked
   plan's twelve.

   | tool | covers |
   | :--- | :--- |
   | `switchboard_status` | board state **and** terminal roster in one call |
   | `switchboard_dispatch` | move cards to a column **with triggers on** |
   | `message_terminal` | `ptySendPrompt` — never `ptyWrite` |
   | `mission_create` | a named goal plus member cards |
   | `mission_update` | name, goal, `type`, `team`, `maxExtraWorktrees`, `ready` |
   | `mission_members` | add/remove member cards |
   | `mission_delete` | remove a mission |

   No `mission_start` and no status setter: starting is dispatching the member cards, and `runState` is
   derived from them (`KanbanDatabase.ts:11306`). A tool that wrote a run state would invent the
   self-report the system is built to distrust.

3. **The file/state line applies here too — via connected folders.** Claude Desktop reads local files
   when the user grants a folder, through a mechanism separate from MCP (the parked bridge plan records
   the same split for Spark: *"local disk access is a separate, unrelated mechanism (Settings →
   Connected Folders, native macOS permissions)"*). So the rule that governs every other host governs
   this one unchanged:

   | lives in | reached by |
   | :--- | :--- |
   | plan `.md` bodies, `.switchboard/mission-control/reports/*`, `session.md`, feature files | **the connected folder** |
   | column, feature membership, `dispatched_at`, terminal roster | **MCP** |
   | dispatch, mission mutation, messaging a seat | **MCP** |

   `plan_read` therefore stays out for the same reason it stays out everywhere — not as a limitation
   accepted, but because the workspace already answers it. MCP is for what is not a file.

   **Setup is two grants, both one-time:** the `/mcp` endpoint, and the workspace folder. Document them
   together — an endpoint without the folder gives an assistant that can dispatch work it cannot read,
   which is the shape that would read as "buggy" all over again.

4. **Dispatch means what dragging a card means.** The board's drop path (`KanbanProvider.ts:11604`) is
   the reference implementation: complexity-route, visible-agent check, move, fire. `_cliTriggersEnabled`
   / `dragDropMode` decide triggers-on versus reposition-only, and this tool is the triggers-on case.

5. **Register conditionally.** Where a backing callback is absent, do not register that tool. An absent
   tool is honest; a registered tool that 503s is a dead button.

6. **Auth: nothing, once the boundary plan lands.** Desktop runs on the same machine, so
   `auth-belongs-at-a-boundary-and-a-local-cli-is-not-one.md` covers it — a local process needs no
   credential. Until that ships, standalone's unconditional mint applies and Desktop needs a token like
   everything else.

## Verification Plan

1. **It starts.** Connect Claude Desktop and assert `tools/list` returns the seven. This is the
   assertion the previous attempt could never have passed, and it must be run against a real Desktop
   install rather than a protocol harness.
2. **One entry, idempotent, cleaned up.** Connect from a multi-root workspace; assert exactly **one**
   config entry. Connect again; assert still one. Disconnect; assert zero. This is design constraint 2
   made executable, against the exact scenario that produced twelve.
3. **No package resolution anywhere.** Assert the config references a URL and that no code path invokes
   `npx`, `@switchboard/mcp`, or any unpublished dependency. Constraint 1 made executable.
4. **In-process, not loopback-recursive.** Assert the handlers call `performKanbanDispatch` /
   `_options.moveCard` directly, with no HTTP request from the server to itself.
5. **Dispatch matches the board.** Same card, same column, once by drag and once by tool; assert
   identical resulting state — column, `dispatched_at`, and which seat received it.
6. **No passthrough, no status setter.** Assert `tools/list` is exactly the seven, that none accepts a
   free-form path or method, and that no tool writes `runState`.
7. **Conditional registration.** With `_options.terminalVerb` absent, assert `message_terminal` is
   absent from `tools/list` rather than present-and-failing.
8. **Shell hosts are unaffected.** Assert the CLI, `sb_api_call.sh` and the `kanban_operations` scripts
   behave identically with `/mcp` mounted. This plan adds a route and removes none.
9. **Both hosts.** `/mcp` mounts on the shared `LocalApiServer`, so assert it is reachable under the
   extension host and under `npx switchboard` — the composition-root check `CLAUDE.md` requires, since a
   route wired in one root only is the documented failure mode here.

## Outstanding Questions

- **[user] Does the connector UI come back?** The old *"Connect Claude Desktop"* button is what wrote the
  twelve entries. A one-URL config could equally be copy-paste from the Setup panel, which has no
  cleanup problem because it writes nothing.
