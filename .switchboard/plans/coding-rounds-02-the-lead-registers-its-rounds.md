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
- **Tags:** teams, api, both-hosts

## User Review Required

None.

## Proposed Changes

### 1. `POST /kanban/rounds/register`

The lead posts its plan: the feature, and an ordered list of rounds, each naming its subtask planIds.

```json
{ "from": "<lead terminal>", "featureId": "<planId>",
  "rounds": [ ["<planId>", "<planId>"], ["<planId>"] ] }
```

The system writes the rows and returns what it registered. **It does not evaluate the plan.** Not whether the split is sensible, not whether the subtasks could run in parallel, not whether there are too many for the seat count. The lead decided; the system records.

### 2. Validate identity, never judgment

Reject only what makes the record unusable: a planId that is not a subtask of that feature, a subtask named in two rounds, an empty round, a feature that already has registered rounds. These are malformed input, not disagreement with the lead's plan.

### 3. Re-registration replaces, and says so

A lead that re-registers after a round has already been dispatched is changing a plan mid-flight. Replace the not-yet-dispatched rounds, leave dispatched ones alone, and report exactly what changed. Do not silently merge.

## Edge-Case & Dependency Audit

1. **Depends on subtask 01** for the table.
2. **One round is valid.** A feature the lead wants done in a single pass registers one round; nothing about the flow should require more.
3. **A subtask left out of every round** is the lead's choice — it is not dispatched, and the response says which subtasks are unrouted so the lead can see an accidental omission.
4. **The poster must be the team's own lead.** Resolve the team from the poster, never from the body.
5. **Both hosts** need the route.

## Verification Plan

1. A lead registers three rounds and reads back three rounds in order.
2. A subtask named twice is rejected with the duplicate named.
3. A subtask belonging to another feature is rejected.
4. A subtask omitted from all rounds is reported as unrouted, not rejected.
5. Re-registering replaces pending rounds, leaves dispatched ones, and reports the difference.
6. Both hosts accept the same payload with the same result.
