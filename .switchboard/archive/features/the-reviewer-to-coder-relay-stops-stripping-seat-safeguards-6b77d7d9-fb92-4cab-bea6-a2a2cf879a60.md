# The Reviewer-to-Coder Relay Stops Stripping Seat Safeguards

**Complexity:** 3

## Goal

Fix three defects on one path - the relay that sends a reviewer's fixes back to a coder. A delegation template falsely claims its payload was already composed and so suppresses the coder's seat directive block; the report-back terminal is resolved without checking team membership, so a reviewer can be pointed at a seat on another team entirely; and the reviewer prompt has structural holes that let an inbound field-existence bug pass every gate.

## How the Subtasks Achieve This

- **Delegation fixStep suppresses seat block** — stops the reviewer's fixStep template and its two mirror copies from claiming a composed payload, so the pty delivery layer resumes appending the coder's seat directive block.
- **originLead cross-team guard** — verifies the resolved report-back terminal shares a registered team with the reviewer, and drops it when it does not.
- **Reviewer prompt: inbound field-existence check and plan-authority split** — closes the three structural holes in the reviewer prompt that let an inbound field-existence bug pass every gate.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Delegation fixStep suppresses seat block — coder stops receiving SKIP TESTS / dontCommit from the delivery layer](../plans/delegation-fixstep-suppresses-seat-block.md) — **PLAN REVIEWED** — ID: 6a1e2e24-3fd3-4c37-a137-87806c7c7667
- [ ] [originLead cross-team guard — drop last-dispatch target when it's not on the reviewer's team](../plans/originlead-cross-team-guard.md) — **PLAN REVIEWED** — ID: 1a380d6c-6ef9-4ca9-8579-ab33785e732f
- [ ] [Reviewer Prompt: Inbound Field-Existence Check & Plan-Authority Split](../plans/reviewer-prompt-inbound-field-existence-check.md) — **PLAN REVIEWED** — ID: a79560b9-871f-4d37-a217-60335e272718
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering; three independent defects on one path.

**Related plan left standalone.** *Two reviewer-to-coder relays pass promptComposed true and strip the coder's seat safeguards* is in CREATED and so is not a subtask here, but it is the same suppression decision at two further call sites, and it also re-pins the audit gate meant to catch exactly this class of bug. Coding the fixStep subtask without it means two passes at the same logic and a gate re-pinned against a partial site inventory. Consider sequencing them together.


## Review Findings

All three subtasks reviewed in one pass against commit `efdd104f`. The feature's goal — the reviewer-to-coder relay stops stripping seat safeguards — is achieved: the delegation `fixStep` payload now carries `"seatBlock":false`, `originLead` is dropped when it shares no registered team with the reviewer on both the single-card and batch paths, and the reviewer prompt carries the plan-authority split, the inbound field-existence check (base + advanced) and the provisional-verdict clause. Two defects were found and fixed: a CRITICAL invented `{"name":"{coder}"}` payload in both Review-team head-prompt mirrors (the preset has no coder seat, so the placeholder could never substitute and the head would have POSTed to a terminal literally named `{coder}`), and a MAJOR regression where `reviewerCoderTerminal` was moved under the delegation gate, silently unwiring the mechanical pre-check gate and the Phone-a-Friend pre-review that also route to it. Two CI gates were left red by the coder or by unrelated refactors and are now green, and the plan-named `kanban-default-prompt-previews.test.js` was defined-but-never-invoked and is now wired into `.github/workflows/integration-tests.yml`. Full per-subtask findings and deferred items are in the three subtask plan files.

## Deferred Findings

- MAJOR — `src/services/teamWiring.ts:2385` `terminalsShareTeam` drops `originLead` when groups exist but no roster parses to strings (object-shaped legacy members); the conservative-keep only covers the no-groups case.
- MAJOR — `src/services/TaskViewerProvider.ts:21941` `installReviewerCallbackOrder` is now gated on `coder && originLead`; a coder receiving mechanical-gate findings with delegation off reports to its lead rather than the reviewer.
- MAJOR (external) — `src/test/standing-orders-marker-contract.test.js:753` cannot run against the current working tree, so the byte-identity gate for the two Review head-prompt mirrors could not be executed this pass; identity was verified by hand instead (1613 chars, identical). Caused by the uncommitted standing-orders-library WIP.
- MAJOR (external) — `src/services/teamWiring.ts:1782` TS2345 and the `stage-marker-commit-contract` / `standing-orders-definitions-contract` failures are all owned by that same uncommitted WIP, not by this feature.
- NIT — the cross-team guard drops the lead rather than resolving the reviewer's actual team lead; the plan's own Outstanding Question on that remains open.
