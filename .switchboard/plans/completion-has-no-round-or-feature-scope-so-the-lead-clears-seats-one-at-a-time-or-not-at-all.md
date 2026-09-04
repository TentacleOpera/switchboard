# Completion Has No Round or Feature Scope, So the Lead Clears Seats One at a Time — or Not at All

kanbanColumn: CREATED

## Goal

A lead that has finished a round clears its coders in one call. A lead that has finished a feature resets the whole team, itself included. Neither gesture exists today.

### Problem analysis

Coding runs in **rounds**. A round is a barrier: round 2 does not begin until round 1 is finished, so at a round boundary no seat is mid-work. The lead knows the round is done — it is the one that decided.

Completion does not have that shape. `POST /kanban/task/complete` takes one `planId` (`LocalApiServer.ts:3305`) and there is no batch form. So a lead closing a three-subtask round makes three independent calls with three independent outcomes.

**Observed 2026-09-04.** A lead posted all three. One cleared:

```
cc0e2653  {"success":true,"cleared":true,"acceptedCodingSeat":"Coding-coder-1", …}
ed40b1f1  {"success":true,"completed_at":"…07:05","idempotent":true}
e780ad93  {"success":true,"completed_at":"…05:57","idempotent":true}
```

All three returned `success: true`. Two cleared nothing and said so only by omitting fields.

The lead was right about all three — those subtasks were finished, two of them by a previous team whose completion posts had already stamped the rows. The lead's judgment was never the problem. The stale `completed_at` silently discarding two of its three posts was.

The operator's current workaround is a manual nuclear clear of every terminal at the round boundary. That workaround is the correct design — it is just not available as a gesture, so it is done by hand, outside the system, with nothing recorded.

**There is no feature-scoped completion either.** The `/kanban/feature/*` routes are all structural — assign, remove, delete, split, reconcile. Nothing marks a feature's work finished. `completeCardInternal` has no `is_feature` handling at all, so posting a feature's planId to `task/complete` treats it as an ordinary card: it stamps `completed_at` on the feature row and tries to clear whatever seat that row names. The head's standing order forbids this (*"Post per subtask, with that subtask's planId — never the feature's"*), and nothing enforces it.

**Two scopes are missing, and they clear different sets.**

| | completes | clears | lead |
|---|---|---|---|
| **round** | every incomplete card dispatched to the team | every coder seat | **kept** — it is orchestrating the next round |
| **feature** | every incomplete subtask of the feature | every roster seat | **cleared** — the work is over |

Feature-complete subsumes the final round. Round-complete is the intermediate barrier.

## Metadata

- **Complexity:** 5
- **Tags:** teams, completion, dispatch, api, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. `POST /kanban/round/complete { from, workspaceRoot }`

Completes every outstanding card dispatched to the poster's team, clears those seats, runs the release check once, and returns one response naming what was completed and what was cleared.

**The lead's post is the authority.** It decided the round was over; the system's job is to execute that, not to adjudicate it. The head's own standing order already says so — *"Your POST is the only fact the system acts on."* Do not add a check that re-derives whether the round is really finished.

The lead does not enumerate subtask ids. The host already knows which cards are dispatched to which seats, and deriving them server-side removes the chance of the lead naming the wrong set — including naming the feature, which its standing order already forbids and nothing currently prevents.

The clear is unconditional across the coder seats. A round is a barrier, so nothing is mid-work — no busy check, no activity sampling, no filtering. The operator already does exactly this by hand and it is the right behaviour.

### 2. `POST /kanban/feature/complete { from, planId, workspaceRoot }`

Same, at feature scope: completes the feature's outstanding subtasks, clears **every** roster seat including the lead, and releases the team.

Clearing the lead here is correct and is the one place it is. The lead holds context across a feature by design; when the feature ends that context is spent, and carrying it into the next feature is the stale-orchestration-state problem from the other direction.

### 3. Reject a feature planId at `task/complete`

With change 2 in place, a feature id posted to the per-subtask endpoint is a caller error, not a completion. Reject it and name the endpoint that does what the caller meant. Today it silently stamps the feature row.

### 4. Teach the lead the new gestures, or they are dead code

The lead knows `/kanban/task/complete` exists for exactly one reason: `buildHeadCompletionFragment()` (`standingOrderFragments.ts:77-86`) spells out the verb, the path and the payload. It reaches the head as standing-order fragment `headCompletion` (`:146`), and `teamWiring.ts:192` pairs it with the next-item fragment.

An endpoint the standing orders do not name will never be called. Rewrite that fragment so the lead's default close-out is the round post, with the per-subtask post kept for accepting a single subtask mid-round, and the feature post named as the end-of-work gesture.

Two things to get right while editing it:

- **The fragment is gated on `ctx.inTeam && ctx.isHead && ctx.headRole === 'lead'`.** A planning head (`headRole: 'planner'`) and a review head (`'reviewer'`) never receive it. Decide whether feature-complete belongs to them too; if it does, the gate has to widen, and that is a separate decision from adding the endpoints.
- **Keep the existing contract sentence.** *"Your POST is the only fact that releases a seat"* is what stops a lead inferring completion from board position, and it stays true for all three gestures.

### 5. One response, and it says what did not happen

Both endpoints return the set completed and the set cleared. A seat that was not cleared appears with a reason. This is the whole reason the 2026-09-04 failure went unnoticed for a feature run — three `success: true` responses that differed only in which fields were absent.

## Edge-Case & Dependency Audit

1. **The latch blocks this.** A card re-dispatched into the round still carries a stale `completed_at`, so it is skipped inside the batch exactly as it was individually. `711fa15e` change 1 — reset on dispatch — is a **prerequisite**, not a companion. Without it, round-complete inherits the same silent skip and merely reports it better.
2. **Per-subtask completion stays.** These are additional gestures for the boundaries that actually exist, not a replacement. A lead accepting one subtask mid-round still posts for that subtask.
3. **The poster is never cleared by change 1.** `:3353` already drops `acceptedCodingSeat === from`. Round-complete keeps that. Feature-complete deliberately overrides it.
4. **A round with no incomplete cards** is a no-op that must say so, not a `success: true` that looks like it cleared a team.
4b. **Scope is the team's own outstanding cards, nothing wider.** A seat working a card that is not part of this team's round is not in the set and is not cleared.
5. **Roster resolution is the sole source.** Both endpoints clear from the resolved roster, never from a caller-supplied list. A caller must not be able to name a seat outside its own team.
6. **Both hosts** need the routes and the seams wired in their own composition root.
7. **Supersedes the manual workaround.** Once change 1 lands, the operator should not need to clear terminals by hand at a round boundary. That is the acceptance test.

## Verification Plan

1. A lead posting round-complete after a three-subtask round clears three coder seats in one call.
2. That call leaves the lead holding its context.
3. A lead posting feature-complete clears every roster seat including itself, and the team is released.
4. A round containing a re-dispatched card completes it, once `711fa15e` change 1 has landed.
5. A feature planId posted to `task/complete` is rejected and names the right endpoint.
6. Both responses list what was completed and what was cleared, with a reason for anything skipped.
7. A round with nothing outstanding reports a no-op rather than success.
8. The operator no longer clears terminals by hand between rounds.
9. A lead's standing orders name the round and feature gestures, and a real lead uses the round post to close a round without being told to.
10. A planning head and a review head receive whatever the `headRole` decision settled on — not silently nothing.
