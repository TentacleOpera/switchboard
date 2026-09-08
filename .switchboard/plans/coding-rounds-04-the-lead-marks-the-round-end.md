# Coding Rounds 04 — The Lead Marks the Round End, the System Advances

kanbanColumn: CREATED

## Goal

The lead's only remaining verb is "this round is done". The system closes the round, completes its subtasks, clears the seats and dispatches the next one.

### Problem analysis

Today closing a round is N separate completion posts with N independent outcomes. On 2026-09-04 a lead posted three and one took effect; the other two returned `success: true` having done nothing, and the difference was visible only as absent fields. The lead had no way to know, and the next round had to be dispatched by hand.

With rounds registered, closing one is a single unambiguous act against a record the system already holds.

> **Reconciliation note (supersedes the original framing):** A `POST /kanban/round/complete` endpoint **already exists** (`LocalApiServer.ts:4190`, routed at `:10697`) and already does the core: completes every outstanding card dispatched to the team, clears coder seats, runs the release check, returns one response. The standing orders already tell every lead to call it (`standingOrderFragments.ts:99`). This subtask does NOT create that endpoint — it **extends** it with the three things the existing handler does not do: (a) close the round row in `coding_rounds`, (b) auto-dispatch the next registered round, (c) when the closed round was the last, delegate to the existing `POST /kanban/feature/complete` handler (`LocalApiServer.ts:4311`) to clear the lead and release the team.

## Metadata

- **Complexity:** 4
- **Feature:** Coding Rounds
- **Tags:** teams, completion, dispatch, api

## User Review Required

None.

## Complexity Audit

### Routine
- The existing `_handleKanbanRoundComplete` (`LocalApiServer.ts:4190`) already completes outstanding cards and clears coder seats — that machinery is reused, not rebuilt.
- Closing a round row is one `UPDATE coding_rounds SET state = 'closed', closed_at = ?` — straightforward.

### Complex / Risky
- Auto-dispatching the next round calls into subtask 03's dispatch operation — a composition seam that must be wired in both hosts.
- Delegating last-round-close to `_handleKanbanFeatureComplete` without double-firing `onTeamReleased` — the existing round-complete handler already runs the release check (`:4283`), and feature-complete runs its own. The delegation must skip the round handler's release when it delegates, or the team is released twice.
- The `711fa15e` latch fix is a satisfied prerequisite, not an open defect — but its deferred findings (`clearCompletedAtByPlanFile` never called, `isStaleCompletedAt` requires truthy `dispatchedAt`) mean edge-case re-dispatch paths can still land on the latch. This subtask must not introduce a new such path.

## Proposed Changes

### 1. Extend the existing `POST /kanban/round/complete`

> **Superseded:** Create `POST /kanban/rounds/complete` (plural) that closes the team's in-flight round, completes subtasks, clears seats, and dispatches the next round.
> **Reason:** `POST /kanban/round/complete` (singular) already exists at `LocalApiServer.ts:4190`, is routed at `:10697`, and is already referenced in the standing orders at `standingOrderFragments.ts:99`. Creating a plural `rounds/complete` endpoint produces two round-completion routes — the standing orders point at the singular one, so the lead never calls the new one. This is a fork, not a feature.
> **Replaced with:** Extend the existing `POST /kanban/round/complete` (singular) with round-record awareness. When the team has registered rounds, the handler closes the current round row, auto-dispatches the next registered round, and — if the closed round was the last — delegates to the existing `_handleKanbanFeatureComplete` to clear the lead and release the team. When the team has NO registered rounds, the handler behaves exactly as it does today (stateless completion), so teams that never adopted rounds are unaffected.

The body stays `{ from, workspaceRoot? }` — unchanged. The lead's contract does not change; the handler gains intelligence behind the same verb.

### 2. The lead's post is the authority

It decided the round is over. Do not re-derive whether the work is really finished, do not sample activity, do not consult timestamps to second-guess it. The head's standing order already states the contract — *"Your POST is the only fact the system acts on."*

### 3. One response, naming what happened

What was completed, which seats were cleared, which round was closed, and which round was dispatched next — or that this was the last one and the feature is complete. A response that says `success: true` and nothing else is how the current failure hid for an entire feature run. The existing handler already returns `{ completed, cleared }` — extend it with `roundClosed` (ordinal) and `nextRound` (ordinal or null) or `featureComplete: true`.

### 4. Closing the last round delegates to feature-complete

The final round's close is the feature's end: every roster seat is cleared, the lead included, and the team is released. The existing `POST /kanban/feature/complete` (`LocalApiServer.ts:4311`) already does exactly this — completes the feature's outstanding subtasks, clears every roster seat including the lead, releases the team. **Delegate to it; do not reimplement.** Two release paths is how `onTeamReleased` gets double-fired and how the `completed_at` latch came back last time.

When delegating, the round-complete handler must NOT run its own release check (`:4283`) — the feature-complete handler runs its own. Skip the round handler's `onTeamReleased` call when the delegation path is taken.

### 5. Auto-dispatch the next registered round

When the closed round was not the last, the handler calls subtask 03's round-dispatch operation for the next registered round. This is the "system advances" half — the lead marks done, the system starts the next batch with no further lead action. If the next round's dispatch is partial (subtask 03's `partial` state), the response reports it so the lead knows recovery is needed.

### 6. Completion must not be blocked by a stale timestamp

`completed_at` is currently write-once and never reset — that defect was `711fa15e`, and it is **fixed**: `clearCompletedAt` is called in `performKanbanDispatch` at `:2875`, and `isStaleCompletedAt` at `:3925` treats a `completed_at` older than `dispatched_at` as a fresh run. This is a satisfied prerequisite, not an open defect. The round-complete handler inherits the fix through `completeCardInternal`, which it already calls (`:4259`).

> **Superseded:** That defect is `711fa15e` and it is a **prerequisite** — without it this endpoint inherits the same silent skip.
> **Reason:** The prerequisite has been satisfied since the `711fa15e` delivery. Describing it as an open prerequisite misleads the coder into re-fixing a closed defect.
> **Replaced with:** `711fa15e` is a satisfied dependency — `clearCompletedAt` and `isStaleCompletedAt` are in the dispatch and completion paths this handler uses. Record it as met; do not re-fix.

## Edge-Case & Dependency Audit

1. **Depends on 01, 02, 03.** The round row (01), registration (02), and the dispatch operation (03) must all exist before this handler can close a round and advance.
2. **Satisfied prerequisite:** `711fa15e` — the `completed_at` latch fix is in place.
3. **Closing with no round in flight** is a no-op that says so — the existing handler already returns "No outstanding cards for this team" (`:4247`). Preserve this.
4. **Closing round 2 while round 1 is open** should not be possible; there is one in-flight round per team. The round-record state (`dispatched` vs `closed`) makes this checkable — reject if the team's current round is not the one being closed.
5. **No next round registered** closes cleanly and reports that the queue is empty — not an error. If this was the last round, delegate to feature-complete (change 4).
6. **No registered rounds at all** — the handler falls back to today's stateless behavior. A team that never registered rounds is unaffected.
7. **Both hosts.** The handler is in the shared `LocalApiServer`; the seams (`resolveTeamMembers`, `clearTerminalContext`, `onTeamReleased`) are wired in both. The new round-dispatch delegation (to subtask 03) must be reachable from both — diff the roots.

## Dependencies

- **Hard prerequisite:** subtask 01 (`coding-rounds-01-the-round-record.md`) — the `coding_rounds` row to close.
- **Hard prerequisite:** subtask 02 (`coding-rounds-02-the-lead-registers-its-rounds.md`) — rounds must be registered to know which is current and which is next.
- **Hard prerequisite:** subtask 03 (`coding-rounds-03-the-system-dispatches-the-round.md`) — the round-dispatch operation that "advances" the team.
- **Satisfied prerequisite:** `711fa15e` (*A Lead's Completion Post Must Clear the Seat — `completed_at` Is a Latch That Is Never Reset*) — `clearCompletedAt` (`:2875`) and `isStaleCompletedAt` (`:3925`) are in the paths this handler uses.

## Adversarial Synthesis

Key risks: (1) double-firing `onTeamReleased` when last-round-close delegates to feature-complete — mitigated by skipping the round handler's release check on the delegation path. (2) creating a second round-completion endpoint that the standing orders don't reference — mitigated by extending the existing singular endpoint, not creating a plural one. (3) a team with no registered rounds breaking under the new logic — mitigated by a stateless fallback that preserves today's behavior. (4) re-fixing the `711fa15e` latch — mitigated by recording it as a satisfied dependency.

## Verification Plan

1. A lead posts round-complete once and three seats are cleared, three subtasks completed, the round row is closed.
2. The next registered round is dispatched automatically, with no further lead action.
3. Closing the last round delegates to feature-complete: every seat including the lead is cleared and the team is released. `onTeamReleased` fires once, not twice.
4. A close with nothing in flight reports a no-op.
5. A round containing a re-dispatched subtask completes it (the `711fa15e` fix is in the path).
6. The response names what was completed, cleared, the round closed, and the next round dispatched (or `featureComplete: true`).
7. A team with no registered rounds: round-complete behaves exactly as today (stateless completion, no round row touched).
8. Both hosts produce the same outcome for the same post.

### Goal Invariants
- `POST /kanban/round/complete` (singular) is the ONLY round-completion route; no plural `rounds/complete` variant exists.
- A closed round row in `coding_rounds` has state `closed` and a `closed_at` timestamp.
- When the last round closes, `onTeamReleased` fires exactly once (not once per handler).
- A team with zero registered rounds receives the same response from `round/complete` as before this subtask landed (stateless fallback).

## Implementation Summary

Extended the existing `POST /kanban/round/complete` (singular) handler in `src/services/LocalApiServer.ts` with round-record awareness: when the team has registered rounds it finds the single in-flight round (rejects on ambiguity, no-ops on none), completes outstanding cards, clears coder seats, closes the round row (`state='closed'`, `closed_at` stamped), and either delegates to the feature-complete core (last round → `featureComplete: true`, `onTeamReleased` fires once) or auto-dispatches the next registered round (`nextRound` with `partial: true` on partial delivery). A team with zero registered rounds falls back to the exact prior stateless behavior. Extracted two shared cores — `_dispatchRoundCore` (from `round/dispatch`) and `_completeFeatureCore` (from `feature/complete`) — so the round-complete handler delegates rather than reimplements, avoiding a second release path. Added `KanbanDatabase.getCodingRoundsByTeam(teamId)` and `closeCodingRound(roundId, closedAt)`; `teamId` is derived from the poster identically to `round/register`. The route is in the shared `LocalApiServer` and the dispatch delegation reuses the already-wired `performKanbanDispatch` path, so both hosts reach it with no new composition-root wiring. Compilation and tests were skipped per explicit instruction; verification was static inspection only.

### Round 1 fix — last-round-close must clear the lead

Defect: the last-round-close delegation path called `_completeFeatureCore` without clearing the lead, because the core excluded the caller (`from`) with the reason "Caller is never cleared — it is mid-turn." On the last-round-close path the feature is done — the lead is NOT mid-turn, and the acceptance clause requires "every seat including the lead cleared." Fixed by adding a `clearLead` option to `_completeFeatureCore` (default false): the `feature/complete` HTTP handler keeps its current behavior (passes nothing → lead not cleared, mid-turn invariant preserved), while the `round/complete` last-round delegation path passes `clearLead: true` so the lead is cleared as part of the roster teardown. `onTeamReleased` still fires exactly once — the round handler skips its own release check on this path, and the feature core fires it once. The clear loop's mid-turn comment was rewritten to document both paths.

## Review Findings

Reviewed `8dd191da` — one fix applied, in the shared core this handler calls (see subtask 03's empty-seat-pool guard; `round/complete` is the caller that validates the roster but not the seat pool before auto-advancing). The extension of the existing singular route is otherwise sound: no plural variant exists, the stateless fallback for a team with zero rows is byte-equivalent to the pre-commit handler, the round-aware path closes the row and auto-dispatches the next registered round, and the last-round path delegates to `_completeFeatureCore` while skipping its own release check so `onTeamReleased` fires once. The `_completeFeatureCore` extraction preserves the `feature/complete` HTTP handler's semantics exactly, including the `roster = [from]` fallback and the 400 on an unresolved feature, with `clearLead` defaulting to false so only the round delegation clears the lead. Verification: `tsc -p tsconfig.test.json` clean, `npm run compile` clean, all ten static gates pass; `task-complete`, `team-release-control`, `atomic-team-lifecycle` and `completion-asserted-never-inferred` fail identically at the pre-feature baseline (`Cannot find module 'vscode'` — those scripts lack the vscode stub), so they carry no signal either way.

## Deferred Findings

- MAJOR — `outstanding` is computed roster-wide (`dispatchedTerminal` in roster AND `!completedAt`), not scoped to the closing round's subtasks, and every coder seat is cleared unconditionally; on a team with two features in flight this completes the other feature's cards and clears its seats. Carried forward from the pre-existing stateless handler, not introduced here. `src/services/LocalApiServer.ts:4271`
- MAJOR — the auto-advance path clears each coder seat, then clears the same seats again through `_dispatchRoundCore`'s per-destination `clearBeforePrompt`: two `/clear` cycles per seat per round boundary. `_dispatchRoundCore` has no `clearBeforePrompt` option to collapse them. `src/services/LocalApiServer.ts:4497`
- MAJOR — no automated check exercises the round-close lifecycle (last-round delegation, single `onTeamReleased`, auto-advance); verification for this subtask is manual only and was not executed in this pass. `src/services/LocalApiServer.ts:4261`
- NIT — the `>1 in-flight rounds` 409 is unreachable through the shipped routes (registration allows one in-flight round per feature) but is correct as a backstop. `src/services/LocalApiServer.ts:4383`
