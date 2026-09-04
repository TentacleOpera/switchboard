# Startup Orientation Is for Hand-Driven Seats — Standalone Sends It to Automated Ones

kanbanColumn: CREATED

## Goal

A startup orientation reaches a seat a human will prompt by hand. A dispatch-driven seat never receives one, in either host.

### Problem analysis

**The orientation exists for manually-driven seats.** A planner or controller terminal the operator types into has no dispatch to carry its standing orders, so it needs them at startup and needs to hold until prompted. That is what `ORIENTATION_PREAMBLE` says: *"Acknowledge them in one line and wait; do not begin any work until you are given a task."*

**An automated coder seat never needed it.** Every work dispatch attaches the standing orders by default (`bootstrap.ts:2462`, `standingOrders !== false && !isMessage`), and the only paths that suppress them are agent-to-agent relays — `LocalApiServer.ts:5872` states the principle: *"Relays are agent-to-agent notes — a question, an answer, a 'done' — not task dispatches... the recipient's context is never cleared here so there is nothing to re-establish."* And when context *is* wiped, the after-clear envelope restores the orders with an explicitly non-actionable wrapper (`TaskViewerProvider.ts:2505-2515`).

So for a dispatch-driven seat the orders arrive with the work, and are restored after a clear. The startup orientation adds only a hold instruction, in a window where the seat has no work to hold off from.

**The extension host already implements this. Standalone does not.**

```
TaskViewerProvider.ts:13635   team delegates created with suppressStartupOrientation: true
TaskViewerProvider.ts:3976    the relay honours the flag
bootstrap.ts                  zero occurrences of suppressStartupOrientation
```

The extension deliberately withholds the orientation from team member seats, for exactly the reason above. Standalone never passes the flag and its relay never checks one — the classic composition-root divergence where "never wired" and "working" produce the same green gates.

**And standalone arms it from a path the flag would not cover anyway.** `bootstrap.ts:3306`, inside `case 'sendToTerminal'`:

```js
if (result.success && Array.isArray(result.created)) {
    relayStartupOrientation(result.created);
}
```

`result.created` comes from `instantiateAgentGroupCore` and is built at `agentGroupInstantiation.ts:147` as the **entire roster**, unconditionally, with no test for whether anything was created:

```js
const created: string[] = [headName, ...workers.map((w: any) => w.friendlyName)];
```

So every lead-to-coder post re-orients every seat on the team, including seats running for hours.

**Observed 2026-09-04**, mid-feature, seats hours old. The lead reviewed a coder's work and posted to it; the coder received a startup orientation telling it to acknowledge and wait for a task it already had. Measured:

```
21:47:04.787   completion POST, coder-1 cleared
21:47:04.859   coder-1 log session rolls        (+72ms)
21:47:05.003   startup orientation delivered    (+216ms)
```

It landed while the CLI was still processing its clear — the log shows Devin's `/clear` picker open, with the paste arriving as literal `^[[200~` because a menu cannot consume bracketed paste.

## Metadata

- **Complexity:** 3
- **Tags:** teams, prompts, both-hosts, standalone-parity, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Standalone suppresses the orientation for team seats, as the extension does

Pass `suppressStartupOrientation: true` when creating team delegates in standalone, and have the standalone relay honour the flag. This is porting a decision the other host already made, not making a new one.

### 2. `sendToTerminal` must not arm the orientation at all

A lead posting to a coder is not a seat startup. Remove the relay from `bootstrap.ts:3306`, or gate it on seats this call genuinely created and that are not team members.

### 3. `created` must list what was created

`agentGroupInstantiation.ts:147` returns the roster under a name that reads as a creation list, and this consumer is not necessarily the only one to believe it. Return the seats actually created; audit the other consumers before changing the semantics, and give any caller that genuinely wants the roster its own field.

### 4. Even a hand-driven seat must not be oriented after work arrives

Scoping the relay to hand-driven seats leaves one case. A planner is hand-driven *and* dispatchable from the board, so it can receive work inside its orientation window. `ORIENTATION_MAX_WAIT_MS = 15000` is documented as *"hard cap: always relay eventually"*, and `waitForSeatQuiescence` cannot tell a booting CLI from a working agent — both are output. So a planner dispatched within 15 seconds of creation gets *"do not begin any work until you are given a task"* on top of a task.

Three parts, folded in from the card this replaces:

- Decide at **send** time, not schedule time: if the seat has been dispatched, drop the relay.
- The hard cap means "send if still idle", not "send regardless". On expiry with work outstanding, log the drop rather than delivering.
- Soften the imperative. Even correctly targeted, *"do not begin any work"* is a strong instruction to an agent that may already have one; the orders are the point, not the wait.

### 5. State the rule where the relay lives

The orientation is for a seat a human will prompt by hand. Write that at `relayStartupOrientation` so the next caller does not have to infer it from a flag defaulted the wrong way in one host.

## Edge-Case & Dependency Audit

1. **A manually created terminal must still get it.** A planner or controller the operator drives by hand is the case this exists for; do not remove the relay outright.
2. **The head is dispatch-driven too.** A feature dispatch goes to the lead, so the lead is not a hand-driven seat and should be suppressed alongside its members. Confirm before assuming the head is the exception.
3. **`1e2afcd8` is folded in and deleted.** Its team-seat case is covered by construction once the relay is scoped; its residual — a hand-driven seat dispatched inside the orientation window — is change 4 above.
4. **This is a parity defect, so audit both roots by hand.** The extension passes the flag from one call site; whether it covers every team-creation path there is worth checking too.
5. **Do not fix this by comparing seat age at the relay.** That hides both a return value that lies and a flag that was never wired.

## Verification Plan

1. A team coder never receives a startup orientation, in either host.
2. A manually created planner or controller terminal still does.
3. A lead posting to a coder produces no orientation for any seat.
4. A create-or-attach that creates one seat and attaches three returns one name in `created`.
5. Both hosts pass and honour `suppressStartupOrientation` identically.
6. A planner dispatched within 15 seconds of creation receives its task and no orientation.
7. A hard-cap expiry on a seat that has been dispatched logs a drop rather than delivering.
