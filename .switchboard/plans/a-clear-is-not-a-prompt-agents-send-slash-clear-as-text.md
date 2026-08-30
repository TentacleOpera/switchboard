# Clearing a terminal needs a dedicated endpoint: today it is a verb-tunnel call, a lesser clear, and a silent failure when done wrong

## Goal

Give clearing a terminal a first-class endpoint that is *the* canonical clear — scope-aware
(one seat or a whole team), never clears the caller, defers a seat mid-turn, returns what it
actually did, and performs the same clear the system performs for itself. Then make the wrong
way fail loudly instead of silently succeeding.

### The problem

Asked to clear team terminals, an agent — a Mission Controller, or the `/switchboard` console
agent — sends the clear through `POST /terminals/verb/ptySendPrompt` with `data: "/clear"`. The
terminal is not cleared. The call returns success.

### Root cause 1 — "/clear" as prompt data cannot work, for two independent reasons

`ptyPromptDelivery.ts` implements two deliberately separate mechanisms:

- **`writeSlashCommand` / `writeSlashCommandLocked` (`:53`, `:64`)** — writes `CLEAR_INPUT_LINE`
  (`\x15`, Ctrl+U) to empty the CLI's persistent input buffer, waits `CLEAR_INPUT_SETTLE_MS`,
  writes the command, then the submitting CR as its own separate write. A slash command is a
  **keypress sequence**.
- **`sendPromptToPty`** — bracketed-paste framing (`\x1b[200~`), chunked writes. A prompt is a
  **paste**.

The file states the incompatibility itself, at `:38-41`:

> *"It MUST land OUTSIDE any bracketed-paste block — i.e. before `\x1b[200~`, never after it.
> **Inside the block it is absorbed as literal text** and silently prefixes the payload."*

and at `:33-36` describes exactly the failure the agent hits:

> *"Agent CLIs keep a persistent input buffer: anything already sitting in it concatenates with
> the next write, so `/clear` lands as `…text/clear` — a prompt, not a command, and the context
> is never reset."*

Second, independent reason: `ptySendPrompt` appends the standing-orders block and the seat
directive block by default, so the payload is not `/clear` — it is `/clear` followed by hundreds
of words of orders.

### Root cause 2 — there are TWO clear implementations, and agents are pointed at the lesser one

This is the finding that decides the design. `ptyClearTerminal` and the host's
`clearTerminalContext` are not the same operation:

| | `ptyClearTerminal` (`bootstrap.ts:1848`) — what agents are told to call | `clearTerminalContext` (`TaskViewerProvider.ts:10886`) — what the system calls |
|---|---|---|
| Honours `terminal.clearBeforePrompt` | **no** | yes (returns `cleared:false` when disabled) |
| Honours the clear delay / pty clear policy | no | yes (`clearBeforePromptDelay`, `resolvePtyClearPolicy`) |
| Delivers standing orders after the clear | **no** | yes (`_deliverStandingOrdersAfterClear`) |
| Rolls the terminal log session boundary | no | yes (`onTerminalContextCleared`) |
| Drops `seatBlockCache` / deferred-clear record | yes | no |
| Drops the work-context key | yes | yes |

So an agent that does everything right — finds the documented verb, calls it correctly — still
produces a **different and lesser clear than the system's own**. The seat loses its standing
orders and, because nothing delivers them back on this path, never regains them until its next
dispatch. Two clears that disagree about what clearing means is the underlying defect; the
`/clear`-as-text bug is what surfaced it.

### Root cause 3 — the operation has no endpoint, only a verb tunnel

`/terminals/verb/<verb>` is a generic host-verb tunnel. Every other operation that matters has a
real route — `/kanban/task/complete`, `/kanban/queue/next`, `/kanban/move`, `/kanban/dispatch`,
`/phone-a-friend`, `/worktree/cleanup`, `/mission-control/*`. Clearing sits in the tunnel
alongside `ptyRenameTerminal` and `ptyPasteImage`, and reaching it requires knowing both that
the tunnel exists and the exact verb name. The tunnel is explicitly host plumbing: the code
notes that `sendToTerminal` rides the same rail with *"a DIFFERENT payload per host"*
(`LocalApiServer.ts` verb-route comment).

**And the actual request has no call at all.** The operator asked to clear *team terminals* —
plural. There is no single call for that. An agent must list terminals, filter by
`parentInstanceId`, exclude itself, avoid `ptyClearAllTerminals`, and loop — a five-step
composition, undocumented as a whole, which is precisely the kind of thing the agent got wrong.
The instruction it is given for the plural case is a warning (*"never use
`ptyClearAllTerminals`"*), not a method.

Documentation cannot close this. `ptyClearTerminal` **is** documented, at
`.agents/skills/switchboard-orchestration/SKILL.md:216`. The agent still reached for
`ptySendPrompt`, because that is the verb every surface teaches it — the drive prefix's staging
example, the coder's standing orders, the callback contract — and because nothing failed.

## Implementation

### 1. Add `POST /terminals/clear` as the canonical clear

A real route on `LocalApiServer`, beside the other first-class endpoints, behind the same auth.

**Scope — one of, never combined:**
- `{ "name": "<seat>" }` — one terminal.
- `{ "team": "<head terminal name or teamId>" }` — that team's roster.
- `{ "seats": ["a","b"] }` — an explicit set.

There is deliberately no "everything" scope. `ptyClearAllTerminals` exists and clears the
caller too; the guidance agents get today is a warning against it, and an endpoint that cannot
express it is a better guarantee than a warning.

**Invariants, enforced server-side rather than asked of the caller:**
- **Never clear the caller.** Take `from` and exclude it. Today this is a rule in prose
  (*"Never send it to your own terminal"*) that an agent must remember; make it impossible.
- **Never clear a head as part of a team scope** unless explicitly named in `seats`. Clearing a
  lead triggers the task-less orders delivery that
  `after-clear-standing-orders-block-is-a-taskless-prompt.md` covers, and a plural "clear the
  team" request almost never means the lead.
- **Defer a seat that is mid-turn.** Reuse `computeRosterClearTargets` and the `lastDataAt`
  `busySet` the roster barrier already uses (`TaskViewerProvider.ts:765-800`) — do not write a
  second liveness policy. A deferred seat is recorded the way the barrier records it, so it
  clears when it goes quiet.
- **Return what happened**: `{ cleared: [...], deferred: [...], skipped: [{name, reason}] }`.
  A caller must be able to tell a clear from a no-op — the failure mode this whole plan exists
  to remove.

**It must perform the canonical clear**, i.e. route to `clearTerminalContext`, so an
agent-initiated clear and a system-initiated clear are the same operation: config honoured,
standing orders redelivered, log boundary rolled.

> **Dependency.** `clearTerminalContext` reaches `LocalApiServer` through
> `this._options.clearTerminalContext`, which is wired in `TaskViewerProvider.ts:3800` and
> **not wired in `bootstrap.ts`** — see `lead-acceptance-post-silently-releases-no-seat.md`
> step 1. Without that fix this endpoint is inert in the standalone host, in exactly the same
> silent way. Land that step first, or land it as part of this plan; do not ship this endpoint
> believing it works in standalone until the seam is wired.

Also reconcile the two implementations: `ptyClearTerminal`'s `seatBlockCache` /
deferred-clear cleanup is real work the host method does not do, so the canonical path must do
both. `ptyClearTerminal` remains as the low-level host verb the endpoint uses; it stops being
the thing agents are told to call.

### 2. Make the wrong call fail loudly

In the `ptySendPrompt` path, reject a payload whose `data`, trimmed, is a bare slash command,
with an error naming `POST /terminals/clear`.

- Reject, never silently redirect — a caller that believes it sent a prompt and actually reset a
  context is worse than the bug being fixed. The error is what teaches the agent.
- Only when the payload is **exactly** the slash command; prose quoting `/clear` must still send.
- Put it with the existing `validateVerbPayload('taskViewer', verb, body)` check on the `pty*`
  rail so both hosts inherit one rule.

### 3. Document the endpoint where agents actually look

- **`.agents/workflows/switchboard.md`** — the console agent's front door has no clear guidance
  and defers wholesale to the orchestration skill. Add the endpoint, including the team scope,
  since "clear the team's terminals" is the request that arrives.
- **`.agents/protocols/switchboard-mission-control/SKILL.md`** — its `## Messaging Leads`
  section gives a `ptySendPrompt` curl recipe and has no clear recipe at all. Add the
  counterpart.
- **`switchboard-orchestration` / `switchboard-mission-control-http`** — make `POST
  /terminals/clear` the documented clear and demote the `ptyClearTerminal` row to a note. State
  the negative explicitly: `/clear` sent through `ptySendPrompt` is delivered as literal text
  and does nothing. Documenting the right call has not been enough; the wrong call has to be
  named.

### Related, not owned here

- `feature_plan_20260817091718_clear-the-cli-input-line-before-every-slash-command.md` owns the
  Ctrl+U reset that makes `writeSlashCommand` reliable. Depended on, not changed.
- `feature_plan_20260815140920_proactive-clear-when-a-lead-rests-a-coder-terminal.md` owns
  teaching the lead *when* to clear. This plan owns *how* any agent clears at all.
- `after-clear-standing-orders-block-is-a-taskless-prompt.md` owns what the post-clear orders
  delivery says. This endpoint routes through that delivery, so the two compose.

## Verification Plan

1. `POST /terminals/clear` with `{name}` clears one seat, in **both** hosts, and the result
   lists it under `cleared`.
2. `{team}` clears the team's non-head seats, excludes the caller, defers a seat made busy
   (recent `lastDataAt`), and the result reports all three sets accurately.
3. The caller is never cleared even when named in `seats` alongside others, and there is no
   scope that clears everything.
4. An agent-initiated clear and a system-initiated clear are indistinguishable at the terminal:
   config honoured, standing orders redelivered, log session boundary rolled, `seatBlockCache`
   and deferred-clear records dropped.
5. With `terminal.clearBeforePrompt` disabled, the endpoint reports `cleared: []` with a reason
   rather than claiming success.
6. **Standalone seam:** confirm the endpoint actually clears under the standalone host. On
   current `main` `clearTerminalContext` is unwired there — capture that failure first as proof
   the dependency is real.
7. `POST /terminals/verb/ptySendPrompt` with `{"data":"/clear"}` is rejected with an error naming
   the endpoint, and the terminal receives nothing; `{"data":"Explain what /clear does."}` still
   sends.
8. Reproduce the original bug on the pre-fix build: `/clear` as `data`, terminal showing literal
   text plus the appended orders block, response `success: true`.
9. Live: ask a `/switchboard` agent to clear a team's terminals and confirm it makes one call.
10. `npx tsc --noEmit -p tsconfig.json`, plus the verb-payload validation and seat-safeguard
    contract suites.

## Metadata

**Feature:** 25e6a03f-26a5-444d-8089-43368af27bcd
**Complexity:** 6
**Tags:** backend, api, reliability, bugfix
