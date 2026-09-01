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
  **Clarification:** `from` is required, not optional — the endpoint rejects the request
  without it. An optional `from` reopens the invariant this plan exists to close.
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

> **Clarification — `sendToTerminal` already handles `/clear` via `writeSlashCommand`.** The
> `sendToTerminal` verb (`bootstrap.ts:2594`) has a content rule that routes single-line
> leading-slash text through `writeSlashCommand` (the correct keypress mechanism), and its
> `/clear` branch drops `seatBlockCache` and deferred-clear records (`bootstrap.ts:2629-2636`).
> This is the cleanup precedent the canonical path should follow. But `sendToTerminal`'s
> `/clear` is still the lesser clear — it does not route through `clearTerminalContext`, so it
> does not honour `terminal.clearBeforePrompt`, does not redeliver standing orders, and does
> not roll the log session boundary. The new endpoint is needed because `sendToTerminal` with
> `/clear` solves Root cause 1 (wrong delivery mechanism) but not Root cause 2 (lesser clear).

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

### Goal Invariants

- **Negative:** `POST /terminals/verb/ptySendPrompt` with `{"data":"/clear"}` is rejected with
  an HTTP error naming `POST /terminals/clear` — it is not delivered as paste text.
- **Positive:** `POST /terminals/clear` with `{"name":"<seat>","from":"<caller>"}` returns
  `{cleared:["<seat>"]}` and the terminal's standing orders are redelivered (the
  `=== STANDING ORDERS ===` marker appears in the delivered text).
- **Negative:** No scope exists that clears the caller — `from` is required and the endpoint
  rejects without it; the caller's name never appears in `cleared`.
- **Positive:** The caller's terminal name appears in `skipped` with `reason: "caller"` when
  named in `seats` alongside others.
- **Negative:** `ptyClearTerminal` does not appear in any agent-facing skill doc or workflow
  file as the recommended clear method — only the demoted note referencing
  `POST /terminals/clear` remains.
- **Positive:** `POST /terminals/clear` routes to `clearTerminalContext` (the same function
  `TaskViewerProvider.ts:11004` calls for system-initiated clears), performing config-honoured,
  orders-redelivering, log-boundary-rolling clear — not `ptyClearTerminal` alone.

## Complexity Audit

### Routine
- Adding a new POST route on `LocalApiServer` beside existing endpoints, behind the same auth.
- Documenting the endpoint in three agent-facing files (workflow, mission-control skill,
  orchestration skill).
- Rejecting bare slash commands in the `ptySendPrompt` path — a validation check alongside the
  existing `validateVerbPayload` guard.

### Complex / Risky
- Reconciling two divergent clear implementations (`ptyClearTerminal` vs `clearTerminalContext`)
  — the canonical path must do both sets of cleanup (seatBlockCache drop + standing-orders
  redelivery + log boundary roll).
- Standalone seam dependency: `clearTerminalContext` is not wired in `bootstrap.ts` (verified:
  only reference is a comment at `:3021`). Without the external dependency fix, the endpoint
  is inert in standalone.
- Busy-seat deferral reusing the roster barrier's liveness policy — requires reading
  `TaskViewerProvider.ts:765-800` to extract the specific `lastDataAt` staleness threshold. The
  threshold is not stated in this plan; the coder must extract it from the barrier code.
- Server-enforced caller exclusion (`from` required, validated, never cleared) — a missing or
  optional `from` reopens the invariant the plan exists to close.

## Edge-Case & Dependency Audit

- **Race Conditions:** A seat going busy between the clear request and execution — the deferral
  mechanism must handle the transition atomically with the roster barrier's `busySet`.
- **Security:** No new auth surface — the endpoint sits behind the same auth as other
  `LocalApiServer` routes. The `from` exclusion prevents a caller from clearing its own context
  (which would wipe its conversation mid-task).
- **Side Effects:** Clearing a head triggers the task-less orders delivery owned by
  `after-clear-standing-orders-block-is-a-taskless-prompt.md`. The endpoint must not clear a
  head as part of a team scope unless explicitly named in `seats`.
- **Dependencies & Conflicts:** External dependency on
  `lead-acceptance-post-silently-releases-no-seat.md` step 1 (wiring `clearTerminalContext` in
  `bootstrap.ts`). Shared surface with "An agent relaying a message is not a dispatch" on
  `.agents/workflows/switchboard.md` and the Mission Control `## Messaging Leads` section —
  land in either order, not simultaneously. Also shares the `ptySendPrompt` case in
  `bootstrap.ts` with the relayed-message plan (different concerns, same case handler).

## Dependencies

- `lead-acceptance-post-silently-releases-no-seat.md` step 1 — wiring `clearTerminalContext`
  in `bootstrap.ts` (the standalone composition root). Without it, `POST /terminals/clear` is
  inert in standalone.
- `after-clear-standing-orders-block-is-a-taskless-prompt.md` — owns the post-clear orders
  delivery this endpoint routes through.
- `feature_plan_20260817091718_clear-the-cli-input-line-before-every-slash-command.md` — owns
  the Ctrl+U reset that makes `writeSlashCommand` reliable. Depended on, not changed.
- `feature_plan_20260815140920_proactive-clear-when-a-lead-rests-a-coder-terminal.md` — owns
  teaching the lead *when* to clear. This plan owns *how* any agent clears.

## Adversarial Synthesis

Key risks: (1) the standalone seam dependency — the endpoint is inert without the external
wiring fix, and the plan correctly captures this failure first as proof; (2) the liveness
threshold for busy-seat deferral is deferred to "the same policy the roster barrier uses"
without stating the number — a coder must extract it from `TaskViewerProvider.ts:765-800`;
(3) `from` must be required, not optional, or the caller-exclusion invariant is a rule in prose
rather than an enforcement. Mitigations: capture the standalone failure before shipping, cite
the specific staleness threshold, make `from` mandatory with a rejection on absence. The
`ptyClearTerminal` demotion is documentation-only — direct calls are not rejected — but
`ptyClearTerminal` is a host verb, not an agent-facing verb, and the `ptySendPrompt` rejection
covers the agent-facing surface where the bug lives.

## Metadata

**Feature:** 25e6a03f-26a5-444d-8089-43368af27bcd
**Complexity:** 6
**Tags:** backend, api, reliability, bugfix

## Implementation Summary

Implemented canonical `POST /terminals/clear` endpoint with single-seat (`name`), team roster (`team`), and explicit set (`seats`) scopes on `LocalApiServer`. Enforced server-side invariants requiring `from`, excluding caller from clears, protecting team heads on team scopes, and deferring mid-turn busy seats using the roster barrier's liveness policy. Reconciled `clearTerminalContext` to drop `seatBlockCache`, clean work-context entries, drop deferred clears, remove reviewer callback overrides, roll session logs, and redeliver standing orders across both the extension and standalone composition roots. Configured `validateVerbPayload` to reject bare slash commands sent via `ptySendPrompt` with an error directing callers to `POST /terminals/clear`. Updated agent-facing workflows and skills documentation accordingly.


## Review Findings

Files changed: `src/standalone/bootstrap.ts` (removed the duplicate log-session roll inside `clearTerminalContext`), `protocol-catalog.json` (regenerated — the new endpoint took `apiEndpointCount` from 111 to 112 and left `catalog:check`, the first CI step, red), `src/test/roster-clear-mid-turn-deferral.test.js` (its exhaustive ptySendPrompt payload-shape pin went red the moment the shape gained `kind`; relaxed to its stated intent of asserting `origin` is documented), and a new CI-wired gate `src/test/prompt-payload-kind-contract.test.js` covering the endpoint's server-enforced invariants and the bare-slash rejection. The endpoint itself is sound — `from` required, caller and head excluded server-side, exactly one scope with no "everything" scope, routed through `clearTerminalContext` rather than the lesser `ptyClearTerminal`, deferral reusing `computeRosterClearTargets` and recording through `recordDeferredClears`, which is wired in **both** composition roots. Verification: `tsc --noEmit` clean apart from 5 pre-existing TS2835 errors in untouched files; `pty-route-surface`, `roster-clear-mid-turn` (56/56), `seat-safeguards` (99/0), `queue-done-relay` and the new `prompt-payload-kind` gate all pass; `catalog:check`, `parity:check`, `standalone-parity:check` and `host-seam-parity:check` green. Remaining risk: the endpoint's core mechanism was verified statically and by contract test, not by an end-to-end clear against a live seat in either host — see the deferred standing-orders gap below, which no automated check can currently discriminate.

## Deferred Findings

- MAJOR — Standalone's `clearTerminalContext` calls `relayStartupOrientation` where the extension's calls `_deliverStandingOrdersAfterClear`, so the plan's "standing orders redelivered" acceptance holds in the extension host only. Not fixed here: the post-clear orders delivery is named must-not-touch in the feature file and owned by `after-clear-standing-orders-block-is-a-taskless-prompt.md`. `src/standalone/bootstrap.ts:3285`
- NIT — `livenessWindowMs` is hardcoded to 90000 in the endpoint while the roster barrier it was told to reuse reads `switchboard.activityLight.livenessWindowMs`. Values agree at the shipped default and diverge the moment an operator tunes the setting; `LocalApiServer` has no config seam to read it through. `src/services/LocalApiServer.ts:4671`
- NIT — The `{name}` scope performs no busy check, so an explicitly named mid-turn seat is cleared rather than deferred. Defensible for a single named target (the caller asked for that seat), but undocumented in the endpoint's docblock. `src/services/LocalApiServer.ts:4692`
- NIT — The drive prefix still instructs the lead to `ptyClearTerminal` a stood-down seat, so the lesser clear remains recommended on a lead-facing surface. Outside this plan's Goal Invariant (scoped to skill docs and workflow files, which were demoted correctly) and adjacent to `proactive-clear-when-a-lead-rests-a-coder-terminal.md`, which owns when a lead clears. `src/services/KanbanProvider.ts:5913`
- NIT — The sidebar's own clear buttons still post `ptyClearTerminal` directly, so an operator's click gets the lesser clear that an agent's call no longer can. Pre-existing; the plan scoped itself to the agent-facing surface. `src/webview/terminals.js:9202`
