# A local MCP surface, so driving Switchboard stops costing a permission prompt per curl

## Goal

Expose Switchboard's three common agent operations — read board state, dispatch a team, run the
Mission Control lifecycle — as a small MCP surface reachable by local coding hosts
(Claude Code, Cursor, Windsurf, Codex CLI), via a stdio shim that resolves the dynamic API port at
call time. The point is not transport — it is **approval surface**: MCP tools are granted once at
connect time, while every `curl` is a fresh Bash invocation a permission-gating host prompts for.

### Problem Analysis

**The regression was predicted, accepted, and has come due.** `replace-mcp-with-skills.md` migrated
agent invocation from MCP tools to skills that shell out, and listed the consequence in its own
*Complex / Risky* section: *"Agents with native MCP support (Devin, Cursor) lose direct function-call
access to API tools when switching to skills — they must construct curl commands instead. **This is a
UX/capability regression for MCP-native agents.**"* Its Security note concluded *"No new attack
surface"* — true, and beside the point. Attack surface and **approval** surface are different
properties, and only the first was weighed.

**"They would have to curl anyway" answers a transport question.** It is correct that MCP and curl
reach the same `LocalApiServer` endpoints. It is irrelevant to the cost being complained about: in a
host that gates Bash per command, N curls is N prompts, while N MCP tools is one grant. The parked
bridge plan's own Goal already contained this — *"bypassing shell command policies and socket
connection restrictions"* — and it was lost because the park was reasoned entirely about Gemini Spark.

**The friction, measured.** Across `.agents/`: **70 `curl` lines** and **31 `node .agents/…` call
sites**. Roughly 100 shell invocations in the agent-facing surface, each one a prompt. The four-line
port-resolve preamble alone is pasted six times (four in
`switchboard-mission-control/SKILL.md`, twice in `.agents/workflows/switchboard.md`).

**None of the four park reasons apply to a local host.**
`feature_plan_20260805_112400_switchboard_mcp_bridge_server.md` was parked on a Spark-specific
cost/benefit: (1) Spark cannot route to `127.0.0.1`; (2) the only route is a public HTTPS tunnel,
which would expose every path on the port; (3) Spark's *Connected Apps* dialog offers no header field,
implying a hand-rolled OAuth 2.1 server; (4) Spark is slow by design. Every one of those is about
reaching a **cloud** client. Claude Code and Cursor run on the same machine, reach loopback, and spawn
local stdio servers. No tunnel, no OAuth, no public exposure.

The park note pre-authorises exactly this: *"If a synchronous MCP surface is ever wanted — **for a
client that can reach localhost**, or once a hardened dedicated listener exists — start from this plan
rather than a blank file."* This plan does that. It is a **new plan** rather than an unpark because the
consumer, the transport, and the security envelope all differ; the parked document stays parked and
stays the reference for its own case.

**Why the port is the hard part.** `LocalApiServer.ts:703` is `this._port = options.port || 0`, and
`:736` is `listen(this._port || 0, '127.0.0.1')` — **port 0 means the OS assigns a random ephemeral
port per launch**, recovered at `:738`. Every host's MCP config, by contrast, is static: `.mcp.json`,
`.cursor/mcp.json`, `~/.codeium/windsurf/mcp_config.json`. A dynamic port and a static config do not
compose, and that mismatch — not the tool surface — is what makes or breaks reliability.

### Root Cause

Skills replaced MCP on the assumption that reaching the same endpoint by a different route is
equivalent. It is equivalent in capability and inequivalent in ergonomics, because the host charges
for shell access per invocation and for tool access per connection.

### Non-goals

- **Not a remote or tunnelled surface.** Loopback only. If a tunnel is ever wanted, the parked plan's
  analysis of what a tunnel exposes stands and must be satisfied first.
- **Not OAuth, not a dedicated listener with mandatory auth.** Both were driven by tunnel exposure
  that does not exist here; existing loopback trust applies unchanged.
- **Not a replacement for the skills.** Skills stay as the fallback for hosts without MCP and for
  anything outside the tool surface. This adds a path; it removes none.
- **Not a generic passthrough.** See change 4.

## Metadata

**Complexity:** 6
**Tags:** infrastructure, backend, ux, reliability

### Dispatch is the board's motion, not a parallel mechanism

`switchboard_dispatch` must mean **exactly what dragging a card into a column means** — the board is
the reference implementation, and an agent surface that invents its own dispatch concept is a second
mechanism to keep in sync. On a drop, `KanbanProvider.ts:11604` complexity-routes the dropped set,
checks which coding agents are visible (refusing with *"No coding agent is currently enabled"* when
none are), moves each card to its role's column, and fires. `performKanbanDispatch` is the same three
steps behind the API door.

Two consequences for this plan:

- **The tool takes a column, not a queue operation.** An earlier revision framed `switchboard_dispatch`
  as "stage the queue, then hand out the first card". That is one *use* of dispatch, not what dispatch
  is. Staging (`STAGING` is *"a queue, not a coding seat"*, `KanbanProvider.ts:7182`) remains available
  as a target column like any other.
- **Whether the two doors should share an implementation is a real question**, deliberately left
  open below. This plan aligns the tool's *semantics* to the board's; converging the code is a
  separate change.

### The file/state line

The tool surface follows one rule, and it is the rule that decides every future addition:

> **If it is a file in the workspace, the host reads it natively. MCP is for what is not a file.**

A local agent's Read/Write/Glob are not shell invocations, so they cost no permission prompt — the
friction this plan exists to remove simply does not apply to them. MCP earns its place only where the
answer lives somewhere the filesystem cannot show:

| lives in | examples | surface |
| :--- | :--- | :--- |
| workspace files | plan `.md` bodies, `.switchboard/mission-control/reports/*`, claim markers, `session.md` | **host's native tools** |
| `kanban.db` / runtime | column, feature membership, `dispatched_at`, terminal roster, worktrees | **MCP** |
| side effects | card moves, dispatch, queue verbs, terminal sends, lifecycle | **MCP** |

This is why `plans_list` and `features_list` belong and `plan_read` does not: the `.md` holds the
plan's **content**, the database holds **where it is**. And it removes the reports channel from the
candidate list — that directory is files, and claiming one is a file write.

A cloud agent cannot reach `127.0.0.1` (park reason 1 of the bridge plan), so a plan-read tool would
be redundant where it works and unreachable where it would help.

## Proposed Changes

1. **Mount a `/mcp` route on `LocalApiServer` using Streamable HTTP.** The parked plan's change 1
   transport mount is recorded as accurate for the installed SDK (1.25.3) — start from it. Tool
   handlers call the **same in-process paths** the HTTP routes call (`performKanbanDispatch()`,
   `_options.moveCard`, `_resolveBoard()`, the verb routers), never HTTP-calling the server from
   within itself (`LocalApiServer.ts:1141-1144`).

2. **Ship a stdio shim as the host-facing entry point.** A small script the host spawns
   (`command: node`, `args: [<shim>]`). Per call it reads `.switchboard/api-server-port.txt`, then
   proxies to `/mcp` on loopback. This is the reliability decision, and it is the reason for the whole
   shape:

   - **The config never contains a port.** Nothing to rewrite, nothing to go stale, no race. That
     deletes the failure class the alternatives merely manage.
   - **The port is resolved per call**, so a board restart on a new port is picked up with no agent
     restart and no config edit.
   - **Lifecycle belongs to the host** — it spawns, restarts and reaps the shim with the session.
     Switchboard supervises nothing.
   - **The config is valid before Switchboard has ever run.** Static from install; the shim reports
     "board not running" until there is one.

   *This is not the second process the parked plan argues against.* That objection was to a second
   **server** — own port, own lifecycle, own supervision, HTTP-calling the board. A stdio shim has no
   port and no independent lifecycle, and the "never HTTP-call the server from within itself" warning
   concerns in-server recursion, not an external client.

3. **Fail as a tool, not as a shell.** When no port file exists, or `/health` does not answer, the
   shim returns a structured MCP error naming the cause ("Switchboard board is not running"). Today
   the same condition surfaces as a raw connection-refused out of curl, which the agent then has to
   interpret — and `## Port Discovery` spends a paragraph telling it how.

4. **Keep the surface small and use-case shaped — not endpoint shaped.** The tool list is scoped to
   three things an agent actually comes to do, not to the API's shape. Four tools:

   | tool | covers | backing |
   | :--- | :--- | :--- |
   | `switchboard_status` | board state **and** the terminal roster in one call — what is ready, what is seated | `_resolveBoard(db)` filtered by column, features read (`:2397`), plus `/health`'s `terminals` / `roots` |
   | `switchboard_dispatch` | move one or more cards to a column **with triggers on** — the board's drag semantics, not a separate mechanism | `performKanbanDispatch(workspaceRoot, ref, rawColumn)`, the documented in-process entry; `auto` column ⇒ complexity routing |
   | `mission_control` | the session lifecycle: `adopt`, `confirm`, `handoff` | the three `/mission-control/*` handlers |
   | `message_terminal` | talk to a lead | `_options.terminalVerb('ptySendPrompt', {name, data, clearBeforePrompt?})` — **never `ptyWrite`** |

   `mission_control`'s `action` is a **closed enum of three named lifecycle steps**, not a mode string
   and not a passthrough: the set is fixed at registration and unknown values are rejected. A
   `{method, path}` passthrough remains forbidden — it converts a curated list into the entire private
   API.

   **What the parked twelve contained and this drops, with reasons:**

   - `card_move` (plain reposition) — **not the same thing as dispatch, and that distinction is the
     point.** Moving a card and dispatching are one motion with one flag: `_cliTriggersEnabled`
     globally, `dragDropMode` (`'cli' | 'prompt' | 'disabled'`) per column
     (`KanbanProvider.ts:120`, `:11280`, `:11424` — `if (dragDropMode === 'prompt' ||
     this._cliTriggersEnabled)`). Triggers **on** ⇒ reposition *and* fire; triggers **off** ⇒
     reposition only. `switchboard_dispatch` is the triggers-on case. The triggers-off case stays out
     of the MCP: it is the rare manual op, `kanban_operations` owns it, and it is exactly what
     `CLAUDE.md` restricts — an agent repositioning with triggers off makes the board claim work
     started when nothing did.
   - `features_assign`, `features_reconcile`, `feature_split`, `feature_delete` — owned by the
     `manage-features` skill. Restructuring a feature is deliberate, infrequent work done with a
     skill's guidance, not a common call worth a permanent tool slot.
   - `terminal_create`, `terminal_close` — fleet management, not a common use case. Seating and
     closing terminals is the board's job.
   - `features_list`, `plans_list`, `terminals_list` — not dropped, **merged** into
     `switchboard_status`. Three calls to answer "what is going on" is the endpoint shape leaking into
     the tool shape.

   **The tradeoff, stated plainly:** a four-tool surface leaves some curls in place. That is
   deliberate. Every tool costs context in every session that connects, and a tool list that grows
   toward the API becomes a second surface to maintain and a wider standing grant. Coverage is not
   the goal; the common path is. Anything outside it keeps working through the skills, unchanged.

5. **Register conditionally.** Where a backing callback is absent in this host (`_options.moveCard`,
   `reconcileFeatures`, `terminalVerb` are all optional), do **not** register that tool. An absent
   tool is honest; a registered tool that 503s is a dead button.

6. **Do not write host config files.** Ship the shim and document the one-line config per host, or add
   it to the existing *Setup MCP* push in `add-mcp-config-distribution.md`, which already maps every
   host's config path — but as an explicit user action, never as an activation side effect. Switchboard
   writing into `~/.cursor/mcp.json` and `~/.codeium/…` unprompted is the same failure class as the
   `.agents/` clobber; a static config that never needs rewriting is precisely what change 2 buys.

## Verification Plan

1. **A permission-gating host makes zero Bash calls for a covered operation.** Drive a board read, a
   card move and a terminal send through the MCP surface in Claude Code, and assert no Bash
   invocation occurs. This is the goal restated as a test; a passing tool call that still shells out
   has not fixed anything.
2. **Port change without reconfiguration.** Start the board, connect, call a tool. Restart the board
   so it binds a **different** ephemeral port. Call a tool again and assert it succeeds with no config
   edit and no agent restart. This is the reliability claim behind change 2 and must be tested
   directly.
3. **Board down is a tool error, not a crash.** With no board running, assert the shim returns a
   structured MCP error naming the cause, and that the agent can report it. Then start the board and
   assert the same tool succeeds — with no restart of the shim.
4. **Stale port file.** Point `api-server-port.txt` at a port nothing listens on; assert the same
   structured error, not a hang. Then at a port serving a *different* root; assert the shim detects
   the mismatch from `/health`'s `roots` rather than operating on the wrong board.
5. **Conditional registration.** In a host missing `_options.terminalVerb`, assert the four terminal
   tools are absent from `tools/list` — not present-and-failing.
6. **No passthrough.** Assert `tools/list` contains exactly the registered set and no tool accepting a
   free-form path or method.
7. **In-process, not loopback-recursive.** Assert the `/mcp` handlers call
   `performKanbanDispatch`/`_options.moveCard` directly, with no HTTP request originating from the
   server to itself.
8. **Skills still work.** Assert every existing curl path still functions unchanged — this plan adds a
   route and removes none, and hosts without MCP must be unaffected.
9. **Both hosts.** Produce the tool-by-tool table the parked plan asks for: confirm each backing
   callback (`terminalVerb`, `moveCard`, `getKanbanDatabase`, `resolveAutoDispatchColumn`,
   `reconcileFeatures`, `createFeature`, the feature assign/split/delete callbacks) is wired in the
   standalone bundle. Where one is not, decide deliberately — wire it, or accept that change 5 drops
   the tool — rather than discovering it at runtime.

## Outstanding Questions

- **[user] Should the two dispatch doors converge?** The board's drop path
  (`KanbanProvider.ts:11604`) and `performKanbanDispatch` (`LocalApiServer.ts`) run the same three
  steps — complexity-route, move, fire — in two files. This plan aligns the MCP tool's semantics to
  the board's without merging them, because converging them is a refactor with its own risk and
  belongs in its own plan. Worth deciding whether that plan should exist: two implementations of one
  concept is how the agent-facing side drifted from the board's in the first place.
- **Settled: four tools, use-case shaped.** An earlier revision of this plan recommended re-deriving
  the list from observed call frequency and adding the queue verbs, worktree reads and an orientation
  tool. **That recommendation is withdrawn.** Call frequency measures how repetitive the protocol is,
  not how many distinct things an agent does — the four-line port preamble alone appears six times.
  Scoping to use cases gives four tools; scoping to call sites gives twenty and a maintenance surface.
- **Settled: no `plan_read`, and no reports-channel tools.** The parked surface cut plan-content reads
  on network-exposure grounds. Those grounds are weaker on a loopback stdio surface, but the cut
  stands for a better reason — see *The file/state line* below. Recorded here so it is not
  reintroduced as a convenience.
