# A Team Seat Is Cleared on Every Dispatch, Because the Team Branch Never Compares the Work Context

kanbanColumn: CREATED

## Goal

A team seat must be cleared when it is handed new work and at no other time — the rule every non-team terminal already follows. Redispatching work a seat already holds must not wipe it.

### Problem analysis

**Observed 2026-09-04, and it halted the project.**

1. The operator dispatched the feature *Storage layer overhaul* (`830a28a3`) from the mobile command surface. It **succeeded** — `plan_events` records the move to LEAD CODED at `04:35:38Z` — but the surface reported an unknown outcome and re-enabled the button. That half is `f824db44` change 1: *"the operator is told the outcome is unknown and simultaneously invited to try again."*
2. Believing it had failed, the operator had an agent redispatch: `switchboard dispatch 830a28a3 "LEAD CODED"`.
3. The card was already in LEAD CODED, so nothing moved — `plan_events` shows one move, not two — but the prompt was delivered to the lead, and the delivery cleared it.
4. The lead lost its orchestration state **mid-feature, on the feature it was already running.**

**The defect.** Two branches decide the destination's clear, twenty lines apart:

```js
// TaskViewerProvider.ts:988   — team branch
if (clearEnabled) {
    payload = { ...payload, clearBeforePrompt: true };
}

// TaskViewerProvider.ts:1008  — non-team branch
const lastWorkKey = this._lastWorkContextByTerminal.get(payload.name);
if (clearEnabled && lastWorkKey && lastWorkKey !== workContextKey) {
    payload = { ...payload, clearBeforePrompt: true };
}
```

The non-team branch implements the rule, and its own comment says why the comparison is on the work-context key rather than the plan id: *"two subtasks of one feature are one work context, and OR-ing a planId compare back in here would clear between them — the per-subtask reset this feature exists to remove."*

The team branch has no comparison at all. It clears on every dispatch, so the work context key is computed, stored, and never consulted for this decision.

It is not missing the data. `workContextKey` is resolved at `:823` and the team's previous value is already compared at `:839` to decide the roster barrier. The one place it is not applied is the destination's own clear.

Both hosts: `bootstrap.ts:2350` carries the identical unconditional shape, with the identical correct sibling at `:2364`.

**Why it surfaced now.** The `dispatch` CLI verb shipped 2026-09-03 in `c0ea0b26`. The branches are older, but a redispatch of work a seat already holds is the case that makes the missing comparison destructive, and the CLI verb is what made that easy to do.

**Scope note.** Two earlier framings of this card were wrong and are recorded so they are not re-derived: it is not a routing defect (dispatching a feature to the lead is the correct gesture — the lead allocates it), and it is not a role-identity defect (the coding team's head *is* the lead coder, by design). The rule was always right; only the team branch failed to implement it.

## Metadata

- **Complexity:** 2
- **Tags:** teams, dispatch, both-hosts, bugfix

## User Review Required

None.

## Proposed Changes

### 1. Compare the work context before clearing a team seat

Apply the `:1008` condition at `:988`, and the `:2364` condition at `:2350`. The team's previous key is already tracked in `_lastWorkContextByTeam` / `lastWorkContextByTeam` and already read at `:839` / `:2225`.

Clear when the key changed. Do not clear when it is the same. That is the whole change.

### 2. Keep the comparison on the work-context key, never the plan id

`workContextKey` is `featureId ?? planId` so that two subtasks of one feature compare equal. A plan-id comparison here would clear a lead between subtasks of the feature it is running — the exact reset the key exists to prevent, and a worse version of the reported bug.

## Edge-Case & Dependency Audit

1. **A genuinely new feature must still clear.** The point is not to stop clearing leads; it is to clear them only on new work. Handing the lead a different feature changes the key and must clear.
2. **First dispatch to a seat has no previous key.** The non-team branch requires a truthy `lastWorkKey` before clearing, so a first delivery does not clear. Match that.
3. **Both hosts, or the divergence widens.** The correct sibling already sits twenty lines from the defect in each root, which is how it went unnoticed.
4. **This pairs with `f824db44`.** The clear is what caused the damage; the mobile surface reporting a succeeded dispatch as unknown is what caused the redispatch. Fixing either alone leaves the incident half-possible.
5. **A busy destination is still not deferred.** The barrier excludes the destination before its busy check, so a mid-turn destination is cleared immediately rather than deferred. Not this card — but it is the remaining way a legitimate new-feature dispatch can still interrupt a working lead.

## Verification Plan

1. Redispatching a feature a lead is already running does not clear it.
2. Dispatching a different feature to that lead does clear it.
3. A lead is not cleared between two subtasks of one feature.
4. A first dispatch to a seat with no recorded work context does not clear it.
5. Both hosts produce the same clear decision for the same dispatch.

## Implementation Summary

Implemented work-context comparison before clearing team destination seats in both hosts (`TaskViewerProvider.ts` and `bootstrap.ts`). The team destination clear now requires `clearEnabled && lastTeamWorkKey && lastTeamWorkKey !== workContextKey`, matching the non-team branch logic. Redispatching a feature or subtask to a team seat that already holds the work context will no longer trigger an unconditional terminal clear. Updated `host-auto-clear-on-plan-change.test.js` contract tests to verify that both hosts gate team seat clearing on work-context change and truthy previous key.

## Review Findings

Reviewed 2026-09-04. Goal achieved: both hosts now gate the team destination clear on `clearEnabled && lastTeamWorkKey && lastTeamWorkKey !== workContextKey`, matching the non-team sibling, and the comparison is on the work-context key rather than the plan id in both. One correction to the plan's model: the `lastTeamWorkKey !== workContextKey` half is unreachable-false at that site — the branch is only entered when the two differ, so only the truthiness check (verification step 4, first dispatch does not clear) actually discriminates. The reported 2026-09-04 incident was not caused by the missing comparison alone: the previous dispatch's barrier never *recorded* the team key, because the old `toClear.length > 0 || deferred.length === 0` gate skipped the record when the only idle seat was the head, so the redispatch re-entered the new-context branch. `01e5bcef` finding 1 (now unconditional recording) is the load-bearing fix; this plan's gate is defence in depth. Files changed: none beyond the coder's diff — no defects found in this subtask's own change. Verification: `test:contract:host-auto-clear` passes with the extended `lastTeamWorkKey` assertions the coder added, plus new ones pinning the per-terminal key the barrier's already-clean filter depends on.

## Deferred Findings

- NIT `src/services/TaskViewerProvider.ts:989` — `lastTeamWorkKey !== workContextKey` cannot be false at that site; a reader will assume it discriminates. Harmless, but the truthiness check is the whole behaviour.
- MAJOR `src/services/TaskViewerProvider.ts:989` — verification steps 1-5 have no automated discriminator beyond the source-text patterns; nothing exercises a real redispatch and asserts no clear ran. Passing `host-auto-clear` is not evidence the runtime decision is right.
- NIT `src/services/TaskViewerProvider.ts:989` — edge case 5 of this plan is still live: the barrier excludes the destination *before* its busy check, so a legitimate new-feature dispatch still clears a mid-turn lead immediately rather than deferring it.
