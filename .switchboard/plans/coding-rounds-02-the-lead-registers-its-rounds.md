# Coding Rounds 02 — The Lead Registers Its Rounds

kanbanColumn: CREATED

## Goal

A lead handed a feature decides how to split it into rounds and posts that plan once. The system holds it.

### Problem analysis

Determining the rounds is judgment: which subtasks can run in parallel, which must follow which, how many seats to use. The lead has read the feature and is the only party that knows. Nothing should second-guess it, and there is no dependency graph to derive it from — most features do not have one.

What the lead should **not** be doing is the mechanics that follow, which is where every defect reported on 2026-09-04 lived.

## Metadata

- **Complexity:** 3
- **Feature:** Coding Rounds
- **Tags:** teams, api, database

## User Review Required

None.

## Complexity Audit

### Routine
- One new POST route in the shared `LocalApiServer` — both hosts get it through the shared server, no composition-root wiring needed beyond the route registration.
- Validation is identity-only (planId belongs to feature, no duplicates) — straightforward set logic.

### Complex / Risky
- Re-registration mid-flight (rounds already dispatched) must replace pending rounds without touching dispatched ones — partial-state mutation that must report the diff precisely.
- Null-roster handling diverges in semantics from the existing `round/complete` (no-op there, error here) — must not copy the pattern blindly.

## Proposed Changes

### 1. `POST /kanban/round/register`

> **Superseded:** `POST /kanban/rounds/register` (plural).
> **Reason:** The shipped round endpoint family uses the singular noun: `POST /kanban/round/complete` (`LocalApiServer.ts:4190`, routed at `:10697`). A plural `rounds/register` creates a naming split within the same route family — the standing orders already tell leads to call `/kanban/round/complete` (singular), so a plural register endpoint is inconsistent and looks like a different service.
> **Replaced with:** `POST /kanban/round/register` (singular) — consistent with the existing `/kanban/round/complete` route.

The lead posts its plan: the feature, and an ordered list of rounds, each naming its subtask planIds.

```json
{ "from": "<lead terminal>", "featureId": "<planId>",
  "rounds": [ ["<planId>", "<planId>"], ["<planId>"] ] }
```

The system writes the rows into `coding_rounds` (subtask 01) and returns what it registered. **It does not evaluate the plan.** Not whether the split is sensible, not whether the subtasks could run in parallel, not whether there are too many for the seat count. The lead decided; the system records.

### 2. Validate identity, never judgment

Reject only what makes the record unusable:

- a planId that is not a subtask of that feature
- a subtask named in two rounds (cross-round duplicate)
- a subtask named twice within the same round's array (within-round duplicate)
- an empty round (a round array with zero subtasks)
- a feature that already has registered rounds (see change 3 for re-registration)

These are malformed input, not disagreement with the lead's plan.

### 3. Re-registration replaces, and says so

A lead that re-registers after a round has already been dispatched is changing a plan mid-flight. Replace the not-yet-dispatched rounds, leave dispatched ones alone, and report exactly what changed — which rounds were added, which were dropped, which were modified. Do not silently merge. The response must carry a `diff` field the lead can read, not just the final state.

### 4. Null roster is a 400, not a no-op

The existing `round/complete` handler returns a 200 with "No team roster resolved" when `resolveTeamMembers` returns null (`LocalApiServer.ts:4223`). That is correct for completion (nothing to complete is a no-op). For **register**, a null roster means the poster has no team — the post is malformed, not empty. Return 400 with an error naming the unresolved poster. Do not copy the complete handler's null-roster pattern.

### 5. Both hosts

The route lives in the shared `LocalApiServer`. Both hosts register it through the same server instance. The `resolveTeamMembers` seam is wired in both (`extension.ts` and `standalone/bootstrap.ts:3778`). No composition-root divergence — but diff the two roots by hand per the CLAUDE.md rule, because the seam's wiring is where divergence hides.

## Edge-Case & Dependency Audit

1. **Depends on subtask 01** for the `coding_rounds` table.
2. **One round is valid.** A feature the lead wants done in a single pass registers one round; nothing about the flow should require more.
3. **A subtask left out of every round** is the lead's choice — it is not dispatched, and the response says which subtasks are unrouted so the lead can see an accidental omission.
4. **The poster must be the team's own lead.** Resolve the team from the poster, never from the body.
5. **Both hosts** need the route.
6. **Null roster** is a 400 (change 4), not a 200 no-op.

## Dependencies

- **Hard prerequisite:** subtask 01 (`coding-rounds-01-the-round-record.md`) — the `coding_rounds` table must exist before register can write to it.

## Adversarial Synthesis

Key risks: (1) null-roster semantics copied from `round/complete` (no-op) when register requires an error — mitigated by change 4. (2) within-round duplicate not validated (only cross-round was) — mitigated by adding it to the validation list. (3) re-registration diff not machine-readable — mitigated by requiring a `diff` field, not just final state.

## Verification Plan

1. A lead registers three rounds and reads back three rounds in order.
2. A subtask named twice (cross-round) is rejected with the duplicate named.
3. A subtask named twice within one round's array is rejected with the duplicate named.
4. A subtask belonging to another feature is rejected.
5. A subtask omitted from all rounds is reported as unrouted, not rejected.
6. Re-registering replaces pending rounds, leaves dispatched ones, and reports the diff.
7. A post with no resolvable team roster returns 400, not a 200 no-op.
8. Both hosts accept the same payload with the same result.

### Goal Invariants
- `POST /kanban/round/register` (singular) is routed in `LocalApiServer` and absent as a plural `rounds/register` variant.
- A registered round row exists in `coding_rounds` with state `registered` after a successful post.
- A within-round duplicate planId is rejected (not just cross-round).
- A null-roster register post returns HTTP 400 (not 200).

## Implementation Summary

Added `POST /kanban/round/register` (singular) to the shared `LocalApiServer`, routed right after `/kanban/round/complete` — both hosts get it through the same server instance, no composition-root wiring needed beyond the route registration (the `resolveTeamMembers` seam is already wired in both `TaskViewerProvider.ts` and `bootstrap.ts`). Added three `KanbanDatabase` methods: `insertCodingRound` (writes a row with `subtask_seats` JSON keyed by planId, each holding `{ seat: '', delivered: false, delivered_at: null }`), `getCodingRoundsByFeature` (reads rounds ordered by ordinal, parses the JSON back), and `deleteCodingRoundsByFeatureInStates` (deletes rounds in given states, used by re-registration to clear pending rounds without touching dispatched/closed ones). Validation is identity-only: each planId must be a subtask of the feature, no cross-round duplicates, no within-round duplicates, no empty rounds. A null roster returns 400 (not a 200 no-op like `round/complete`). Re-registration deletes pending (`state='registered'`) rounds, leaves dispatched/closed ones untouched, and returns a machine-readable `diff` with `added`/`dropped`/`kept` arrays plus an `unrouted` list of subtasks not in any round. New rounds get ordinals continuing after the highest kept ordinal, and `total_registered` reflects the total round count (kept + new).


## Review Findings

Reviewed `bb868d8e`; two fixes applied to `src/services/LocalApiServer.ts`. CRITICAL: registering rounds left the team inert — nothing dispatched round 1. `round/register` only wrote rows, `round/complete` advances only a round already in flight, and `POST /kanban/round/dispatch` is named in no prompt, CLI or automation, while the lead's rounds-variant orders forbid it from dispatching seats; the handler now starts the first pending round through `_dispatchRoundCore` when the feature has no round in flight, and reports it as `dispatched` in the response. CRITICAL: eight of the nine implicit-`any` errors that made `npm run compile-tests` (a CI step, clean at the pre-feature baseline `67cf7216`) red were in this handler's reads over the untyped `db` handle — fixed with a local `CodingRoundRow` type and two annotations. Verified: `tsc -p tsconfig.test.json` clean, `npm run compile` clean, all ten static gates pass. Everything else in the plan holds — the route is singular with no plural variant, validation is identity-only including the within-round duplicate, unrouted subtasks are reported not rejected, re-registration replaces only `state='registered'` rows and returns `added`/`dropped`/`kept`, and a null roster is a 400.

## Deferred Findings

- MAJOR — the three new round routes are missing from `protocol-catalog.json`'s `apiEndpoints`, so `npm run catalog:check` (CI) reports drift; not regenerated here because that file is mid-edit by another agent. `protocol-catalog.json:1`
- MAJOR — registration now delivers round 1's prompts inside the HTTP request, so the register call's latency is N paced pastes rather than a database write (`round/complete`'s auto-advance already had this shape). `src/services/LocalApiServer.ts:4744`
- NIT — `teamId` is derived from the poster's terminal name, so a lead rename orphans the rounds it registered. `src/services/LocalApiServer.ts:4666`
