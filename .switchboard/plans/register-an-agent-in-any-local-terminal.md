# Register an Agent Running in Any Local Terminal, by Letting It Pull Instead of Being Pushed

## Goal

Let a user register an agent already running in **any** locally-run terminal — a plain shell, iTerm, Windows Terminal, Ghostty, a tmux pane, an editor's chat pane — as an addressable Switchboard seat that can receive dispatches. Achieved by inverting the delivery direction for those seats: Switchboard cannot write into them, so they ask Switchboard for work.

### Problem Analysis

Registration today is VS Code-only. `_registerAllTerminals` (`TaskViewerProvider.ts:21120`) iterates `vscode.window.terminals`, resolves each pid, and writes rows into `state.terminals`. Anything the editor did not spawn is invisible and unreachable.

**The reason is real, not a stub.** `tmux-bridge-1-transport-layer.md` states it precisely: *"`vscode.Terminal.sendText` works in the extension host because the extension host owns the pty behind the integrated terminal — it holds a writable handle to a child process's stdin. Standalone holds no such handle on an external terminal emulator, and there is no portable OS mechanism to write into an unrelated process's stdin. This is a genuine capability gap, not an unimplemented stub."*

So the four transports, honestly:

| Terminal | How Switchboard writes to it | Status |
| :--- | :--- | :--- |
| VS Code integrated | `vscode.Terminal.sendText` | ships |
| pty fleet seat | `ptySendPrompt` | ships |
| tmux pane | `send-keys` / `load-buffer` → `paste-buffer` | specced (`tmux-bridge-1`, `-2`) |
| **anything else** | **nothing can** | **this plan** |

### The direction that does work — and the codebase already leans this way

Switchboard cannot push into an arbitrary terminal, but an agent inside one can pull. Three things already point here:

1. **The completion signal is already agent-initiated HTTP.** Turn-end arrives through `LocalApiServer`'s `onTurnEndNotify` callback (`TaskViewerProvider.ts:3519`) because the agent POSTs it — not because anything read its output. `tmux-bridge-1` puts the principle plainly: *"Switchboard's completion signal is plan-file mtime advance, not terminal output."*
2. **Standing orders are the carrier for telling an agent to do that.** `TEAM_CODER_QUEUE_DONE_INSTRUCTION` and `AGENT_GROUP_CALLBACK_INSTRUCTION` (`teamWiring.ts`) already install "when you finish, call this" instructions. "Poll for work" is the same shape.
3. **The registry already accepts heartbeat-only liveness.** `_getAliveAutobanTerminalRegistry` computes `heartbeatAlive = lastSeen within 60_000` and `alive = isLocal || (heartbeatAlive && ideMatches)`, where `ideMatches` is true when the row carries no `ideName` at all (`!termIdeName`, `:10818-10824`). A row with no `ideName` and a fresh heartbeat is therefore already alive **with no schema change.**

**But the heartbeat has no sender.** `lastSeen` is written only at registration — `:11172`, `:11516`, `:21158`, `:21243` — and never refreshed by anything running. The field and the check exist; the pulse does not. A self-registering agent supplies exactly the missing half, which is why this fits the existing model instead of bolting onto it.

**Dual heartbeat threshold discrepancy.** There are TWO heartbeat thresholds in the codebase: `_getAliveAutobanTerminalRegistry` (line 11940) uses `60_000` ms (60s) for dispatch-routing liveness, while the sidebar enrichment (line 24655) uses `HEARTBEAT_THRESHOLD_MS = 120_000` ms (120s) for display liveness. A self-registering agent heartbeating at a 90-second interval would be ALIVE in the sidebar but DEAD to dispatch routing. The contract for external seats must specify the stricter (60s) threshold as the binding one, since dispatch routing is the functional path and the sidebar is display-only. The heartbeat interval in the standing-order template must be ≤ 60s.

## Metadata

**Complexity:** 7
**Tags:** backend, api, feature, security, reliability

## User Review Required

**One decision, and it changes the dispatch contract.** `_attemptDirectTerminalPush` returns a boolean meaning *delivered* — it wrote to a pty or a `vscode.Terminal` and knows it landed. A pull seat can only promise *queued*: the prompt sits until the agent next polls. Pick one:

- **(a) Queue-only, honest.** External seats are queue targets; the dispatch result says `queued`, not `delivered`, and every caller that renders "sent" learns the difference. More call sites touched, no lying.
- **(b) Block on an ack with a timeout.** The inbox response is a claim, and delivery resolves when the agent acks. Preserves the boolean at the cost of a timeout that will sometimes be wrong.

Recommendation: **(a)**. This codebase repeatedly calls out the failure mode option (b) invites — *"the same hollow success in a different costume"* (`notifyTurnEnd`), and the `orchestratorStartResult` note about a result that "does not read as 'kickoff sent' when nothing was sent". A queue that says queued is the shape that cannot lie.

Also worth confirming: whether an external seat may be a **team member**. Membership and role routing are already surface-agnostic (`resolveTeamRoleTerminal` unions the registries), so it would mostly work — but team *creation* goes through `ptyCreateTerminal`/`spawnDelegates`, so an external seat can join a team it did not spawn into. Proposed: allow membership, disallow being a head, until the notification hop is proven.

## Complexity Audit

### Routine

- Three routes on `LocalApiServer`, composed like the existing `/terminals/*` handlers:
  - `POST /agents/register` → `{ seat, role, workspaceRoot?, cwd? }`, writes a `state.terminals` row with `purpose: 'external'`, no `ideName`, `lastSeen` now. Returns a per-seat token.
  - `POST /agents/heartbeat` → refresh `lastSeen`.
  - `GET /agents/inbox?seat=` → return and dequeue pending items for that seat.
- A standing-order template telling the agent to register, heartbeat, poll, and report done — reusing the `teamWiring` install path, not a new mechanism.
- Deregistration falls out of the existing staleness sweep (`:23355`, `STALE_THRESHOLD_MS`).

### Complex / Risky

- **This is the first route that lets a local caller *create* an addressable seat and *read* prompts for it.** Prompts carry plan bodies. `_checkAuth` short-circuits to loopback trust when `getAuthToken()` is empty — always the case under the extension host — so a token must be **enforced by these routes**, not inherited from the rail. Without it, any local process can register a seat named `coder` and start receiving work.
- **Seat hijack via name collision.** Registering a name that already resolves in the VS Code registry or the fleet would let a local process shadow a real seat and absorb its dispatches. Registration must **reject** a name resolving in either existing registry — never merge into an existing row.
- **`_pickTerminalCandidate` needs a defined position for external rows.** Its precedence is live-fleet → live-vscode → dead-fleet → first-candidate (`:10266`), and its docblock exists because an undefined position resolves by `state.json` JSON key order — *"a silent, nondeterministic precedence"* that differs per install and changes on every state rewrite. Adding a fourth row type without stating its rank reintroduces exactly that bug. Proposed rank: below live-vscode, above dead-fleet.
- **`_isFleetTerminalInfo` must not classify these as fleet.** It tests `purpose === 'pty' || ideName === PTY_IDE_NAME` (`:10247`). `purpose: 'external'` with no `ideName` passes neither, which is correct — but every other consumer switching on `purpose` needs checking, because a row type that some code paths treat as fleet and others do not is the divergence pattern this codebase already pays for.
- **`/terminals/relay` will not reach these seats.** It validates `to` against `ptyListTerminals` and delivers via `ptySendPrompt` (`LocalApiServer.ts:3228-3246`) — fleet-only by construction. Either widen it or document relay as fleet-only. Do not leave it silently half-working.
- **No read side, by definition.** Same as VS Code and tmux: no output stream, so no activity lights, no answerback, no paste attribution. Completion is the POST. This is a constraint to state, not a gap to close — reintroducing output-derived features as a requirement here would sink the plan for no benefit the team loop needs.
- **`state.terminals` is shipped state on ~4,000 installs.** A new row type must be ignored gracefully by every existing reader, and an unknown `purpose` must never be dropped on a state rewrite. Per the project rule, preserve unknown keys rather than normalising them away.

## Edge-Case & Dependency Audit

**Race Conditions**
- Two processes registering the same seat name concurrently: registration must be a single locked read-modify-write through `updateState`, matching `_registerAllTerminals`'s "re-read used names inside lock" (`:21138`).
- An agent that polls, receives an item, then dies before acting on it loses that dispatch. Whether the inbox dequeues on read or on ack is part of decision (a)/(b) above and must be settled with it.

**Security**
- Per-seat token, enforced route-side (see above).
- Loopback-only, matching the existing `_handleRequest` guard (`:6207`).
- The inbox is a read channel for plan content — treat its authorization as the security boundary of the whole plan, not a detail.

**Side Effects**
- The Status section gains a third transport value (`external` alongside `pty` / `vscode`), which is additive to `sidebar-read-only-status-section.md`'s transport-per-row.
- A registered-but-silent external seat looks identical to a wedged one. The heartbeat is the only discriminator, which is an argument for a short heartbeat interval and for surfacing "last seen" per seat rather than a binary light.
- **"Last polled" alongside "last seen".** A seat that heartbeats (proving the process is running) but never polls its inbox is indistinguishable from a working one — dispatches queue silently. The inbox endpoint should record a `lastPolled` timestamp (updated on each `GET /agents/inbox` call) alongside `lastSeen`, so a heartbeating-but-not-polling seat is visible. This is the "alive but idle" gap that `lastSeen` alone cannot surface.

**Dependencies & Conflicts**
- **Complements `tmux-bridge-1/-2` rather than competing.** tmux is the push path where a multiplexer owns the pty; this is the pull path where nothing does. A tmux user should get the push path — it needs no cooperation from the agent.
- **Independent of** the sidebar plans, except the additive Status value above.
- Touches `src/services/LocalApiServer.ts`, `src/services/TaskViewerProvider.ts` (registry row handling, candidate ranking), `src/services/teamWiring.ts` (one standing-order template), and the standalone host's matching route wiring.

## Dependencies

- **Complements** `tmux-bridge-1/-2` — tmux is the push path where a multiplexer owns the pty; this is the pull path where nothing does.
- **Independent of** the sidebar plans, except the additive Status transport value.
- **Both hosts must wire the routes.** Per the project rule, the extension (`extension.ts`) and the standalone host (`bootstrap.ts`) must not diverge. The three routes (`POST /agents/register`, `POST /agents/heartbeat`, `GET /agents/inbox`) must be wired in both composition roots — the trap is not verbs (the default arm delegates) but service seams and options objects.

## Adversarial Synthesis

**"Just use tmux for everything."** tmux requires the multiplexer to own the pty and the user to run inside it. A plain shell, an iTerm tab, a Ghostty window, an editor chat pane — none of those have a tmux pty. The pull path exists for the terminals that have no push path at all, not as a competitor to tmux.

**"The boolean return on `_attemptDirectTerminalPush` is fine — just return true for queued."** No — that is the "hollow success in a different costume" this codebase has rejected repeatedly. A queue that says `delivered` lies. The dispatch result must say `queued` for external seats, and every caller that renders "sent" must learn the difference. This is decision (a), and it is the correct one.

**"A per-seat token is overkill for loopback."** Loopback trust is the default when `getAuthToken()` is empty — always the case on the extension host. Without a per-seat token enforced by these routes, any local process can register a seat named `coder` and start receiving plan bodies. The inbox is a read channel for plan content; its authorization is the security boundary of the whole plan.

**Risk Summary:** Key risks: (1) the per-seat token must be enforced route-side, not inherited from loopback trust — without it, any local process can read plan bodies; (2) the dual heartbeat threshold (60s routing vs 120s display) means a seat can be alive in the sidebar but dead to dispatch — the 60s threshold is binding; (3) a heartbeating-but-not-polling seat is indistinguishable from a working one — `lastPolled` alongside `lastSeen` closes this gap; (4) `state.terminals` is shipped state on ~4,000 installs — an unknown `purpose` must survive a state round-trip. Mitigations: token enforcement is in the route handlers; the standing-order template specifies ≤60s heartbeat; `lastPolled` is recorded on each inbox poll; the state round-trip test pins unknown-key preservation.

## Proposed Changes

### `src/services/LocalApiServer.ts`
- **Three routes:** `POST /agents/register` (writes `state.terminals` row with `purpose: 'external'`, no `ideName`, `lastSeen` now, returns per-seat token), `POST /agents/heartbeat` (refreshes `lastSeen`), `GET /agents/inbox?seat=` (returns and dequeues pending items, records `lastPolled`).
- **Per-seat token enforcement.** These routes must enforce a per-seat token even when `getAuthToken()` is empty (loopback trust). Without it, any local process can register a seat and read plan bodies.
- **Seat name collision rejection.** Registration must reject a name that already resolves in the VS Code registry or the fleet — never merge into an existing row.
- **Widen or document `/terminals/relay`.** It validates `to` against `ptyListTerminals` (fleet-only). Either widen it to reach external seats or document it as fleet-only. Do not leave it silently half-working.

### `src/services/TaskViewerProvider.ts`
- **`_isFleetTerminalInfo` must return false** for `purpose: 'external'` rows — confirmed: it tests `purpose === 'pty' || ideName === PTY_IDE_NAME`, and `purpose: 'external'` with no `ideName` passes neither.
- **`_pickTerminalCandidate` needs a defined position** for external rows. Proposed rank: below live-vscode, above dead-fleet. The test must pin this with a synthetic collision of all four types.
- **Every consumer switching on `purpose`** needs checking — a row type that some code paths treat as fleet and others do not is the divergence pattern this codebase already pays for.
- **Staleness sweep** (`housekeepStaleTerminals`, `STALE_THRESHOLD_MS = 24h`) handles deregistration — a row with no heartbeat for 24h is pruned. No new sweep needed.

### `src/services/teamWiring.ts`
- **One standing-order template** telling the agent to register, heartbeat (≤60s), poll, and report done — reusing the `teamWiring` install path, not a new mechanism.

### Both composition roots
- **`extension.ts` and `bootstrap.ts`** must both wire the three routes. The trap is composition-root wiring, not verb reachability.

## Verification Plan

### Goal Invariants

- A `purpose: 'external'` row in `state.terminals` is not classified as fleet by `_isFleetTerminalInfo` (returns false).
- `_pickTerminalCandidate` places an external row at its stated rank (below live-vscode, above dead-fleet) given a synthetic collision of all four types.
- An inbox request with a missing or wrong per-seat token is rejected, and that rejection is not reachable via loopback trust (the token is enforced route-side, not inherited).
- Registration of a name that already resolves in the VS Code registry or the fleet is refused, and the existing row is untouched.
- A state round-trip preserves an unknown `purpose` value rather than dropping it.
- The dispatch result for an external seat reads `queued`, not `delivered`.

### Automated
- Route tests: register → heartbeat → inbox → done, against a stubbed registry. Assert an inbox request with a missing or wrong token is rejected, and that rejection is not reachable via loopback trust.
- Assert registration of a name that already resolves in the VS Code registry or the fleet is refused, and that the existing row is untouched.
- Assert `_isFleetTerminalInfo` returns false for a `purpose: 'external'` row, and that `_pickTerminalCandidate` places one at its stated rank given a synthetic collision of all four types — the test that pins the precedence the docblock demands.
- Assert a state round-trip preserves an unknown `purpose` value rather than dropping it.

### Manual
1. Run an agent CLI in a plain terminal outside VS Code. Register it via the documented curl. It appears as a seat with a transport of `external`.
2. Dispatch a card to it. The prompt arrives on the next poll; the dispatch result reads `queued`, not `delivered`.
3. Kill the agent. Within the staleness window the seat reads not-live, and its "last seen" is visible rather than a bare light.
4. Attempt to register a seat name that already exists as a VS Code terminal: refused, with a reason.
5. Attempt an inbox read with no token: refused.
