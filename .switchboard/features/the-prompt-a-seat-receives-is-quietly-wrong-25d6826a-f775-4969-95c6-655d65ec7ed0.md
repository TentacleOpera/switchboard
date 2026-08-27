# The Prompt A Seat Receives Is Quietly Wrong

**Complexity:** 3

## Goal

Close two defects on the dispatch path where a seat is handed a prompt that is silently missing what it needs, with no error raised anywhere and no gate that catches it.

The first selects the wrong workflow. Feature-subtask expansion is gated on the selected record having isFeature true, and a subtask record has isFeature 0 with featureId set to its parent. So a subtask selected from the sidebar Plans view is treated as a standalone plan: no siblings are appended, the feature group never forms, feature mode stays false, and the builder picks improve-plan instead of improve-feature. The board does not show this because it filters subtask cards out at render time, so only the feature card is visible and its copy button always carries the feature id - the sidebar renders subtasks individually, each with its own button keyed by its own id.

The second strips the seat safeguards. The promptComposed argument means the payload already came out of the prompt builder, so do not append the seat directive block. Two reviewer-to-coder relays pass it for a payload that is hand-built prose, and because they push directly to the terminal they bypass the HTTP-boundary strip, so the marker survives and the whole seat block is skipped - git policy, skip directives, subagent policy and output shaping all silently absent from a fix-these-findings instruction. The audit gate meant to catch exactly this must then be re-pinned to the true site inventory.


## How the Subtasks Achieve This

- **Fix Subtask Prompt Dispatch Loses Feature Context**: fixes the feature-expansion gate, which keys on the selected record having `isFeature` true while a subtask record carries `isFeature: 0` and a `featureId`. So no siblings are appended, the feature group never forms, and the builder selects `improve-plan` where `improve-feature` was intended. Also corrects the run-sheet instruction so the recorded workflow matches the prompt actually delivered.
- **Two Reviewer-To-Coder Relays Pass promptComposed True**: stops two call sites claiming that hand-built prose came out of the prompt builder. Because they push straight to the terminal they bypass the HTTP-boundary strip, so the marker survives and the whole seat directive block is skipped — git policy, skip directives, subagent policy and output shaping absent from a fix-these-findings instruction. Re-pins the audit gate to the true site inventory and repairs its classifier.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Two reviewer→coder relays pass `promptComposed: true` and strip the coder's seat safeguards](../plans/feature_plan_20260821120000_promptcomposed-true-strips-seat-safeguards-on-reviewer-to-coder-relays.md) — **CREATED** — ID: 24413b34-7971-47be-b3b9-3b5687818107
- [ ] [Fix Subtask Prompt Dispatch Loses Feature Context](../plans/fix-subtask-prompt-dispatch-loses-feature-context.md) — **CREATED** — ID: 28ca24bb-f2a1-4469-88a0-fd6a9f56c0ce
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; independent call sites, both on the dispatch path, both currently in CREATED so they can be plan-reviewed together.

They are one capability because they share a failure mode rather than a code path: in both, a composition gate is consulted, answers wrongly, and the resulting prompt is quietly deficient with nothing raised anywhere. No test, no log line, and no gate catches either — which is why both survived. That shared property is the thing to fix, and it is why each subtask carries a gate or assertion, not only a code change.

One inherited trap worth naming for whoever codes them. The board does not exhibit the first bug because it filters subtask cards out at render time, so only the feature card is visible and its copy button always carries the feature's own id. Verifying the fix from the board therefore proves nothing — it must be exercised from the sidebar Plans view, where subtasks render individually with their own buttons. A green board check is the false negative that hid this.

For the second: the audit gate that should have caught it exists and was passing. Re-pinning it is not optional cleanup — an unrepaired classifier mis-bins a third site, so the gate would go green again over the same defect class.
