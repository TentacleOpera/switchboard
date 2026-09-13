# The Prompt A Seat Receives Is Quietly Wrong

**Complexity:** 3

## Goal

Close two defects on the dispatch path where a seat is handed a prompt that is silently missing what it needs, with no error raised anywhere and no gate that catches it.

The first selects the wrong workflow. Feature-subtask expansion is gated on the selected record having isFeature true, and a subtask record has isFeature 0 with featureId set to its parent. So a subtask selected from the sidebar Plans view is treated as a standalone plan: no siblings are appended, the feature group never forms, feature mode stays false, and the builder picks improve-plan instead of improve-feature. The board does not show this because it filters subtask cards out at render time, so only the feature card is visible and its copy button always carries the feature id - the sidebar renders subtasks individually, each with its own button keyed by its own id.

The second strips the seat safeguards. The promptComposed argument means the payload already came out of the prompt builder, so do not append the seat directive block. Two reviewer-to-coder relays pass it for a payload that is hand-built prose, and because they push directly to the terminal they bypass the HTTP-boundary strip, so the marker survives and the whole seat block is skipped - git policy, skip directives, subagent policy and output shaping all silently absent from a fix-these-findings instruction. The audit gate meant to catch exactly this must then be re-pinned to the true site inventory.

## How the Subtasks Achieve This

- **Fix Subtask Prompt Dispatch Loses Feature Context**: fixes the feature-expansion gate, which keys on the selected record having `isFeature` true while a subtask record carries `isFeature: 0` and a `featureId`. So no siblings are appended, the feature group never forms, and the builder selects `improve-plan` where `improve-feature` was intended. Also corrects the run-sheet instruction so the recorded workflow matches the prompt actually delivered.
- **Two Reviewer-To-Coder Relays Pass promptComposed True**: stops two call sites claiming that hand-built prose came out of the prompt builder. Because they push straight to the terminal they bypass the HTTP-boundary strip, so the marker survives and the whole seat directive block is skipped — git policy, skip directives, subagent policy and output shaping absent from a fix-these-findings instruction. Re-pins the audit gate (composed 5 → 3, uncomposed 9 → 11) and rewrites its audit note so it no longer records the two relays as deliberate composed sites. The classifier was already repaired by the 2026-08-31 audit pass and is not touched.

## Team Dispatch Instructions

### Two reviewer→coder relays pass `promptComposed: true` and strip the coder's seat safeguards
- **Seat:** coder
- **Acceptance:**
  - The two reviewer-gate relays (`MECHANICAL GATE FAILED`, `PHONE-A-FRIEND PRE-REVIEW FAILED`) pass `promptComposed: false` (6th arg), with `ptyOnly` (8th arg) still `true`.
  - `seat-safeguards-fleet-prompt-path.test.js` reports exactly 3 composed sites (`:2915`, `:8827`, `:23535`) and 11 uncomposed (including the two relay lines); total 14.
  - The audit note no longer lists the two relays as deliberate composed sites.
  - The classifier (`dispatchCallArgs` / `classifyDispatchCallSites`) is unchanged.
  - The new behavioural pin (relays must not claim composition) fails when `, true` is re-added to a relay, then passes on revert.
- **Must not touch:** the classifier in `seat-safeguards-fleet-prompt-path.test.js`; the three legitimate composed sites (`:2915` standing-orders one-shot, `:8827` batch-group, `:23535` single-card); the 8th `ptyOnly` argument at the two relay sites.

### Fix Subtask Prompt Dispatch Loses Feature Context
- **Seat:** coder
- **Acceptance:**
  - `buildDispatchPlans` with a single subtask record (`isFeature: 0`, `featureId` set) returns an array whose first element has `isFeature: true` and length `1 + siblingSubtaskCount`; no duplicate when both feature and subtask are selected.
  - `generateUnifiedPrompt('planner', <subtask-only plans>)` contains the improve-feature workflow path, not improve-plan; loose-plan-only plans still produce improve-plan (regression).
  - `_plannerWorkflowNameForInstruction('improve-feature')` returns `'Improved feature'`; a feature planner CLI dispatch records `'Improved feature'` in the run-sheet; a non-feature dispatch still records `'Improved plan'`.
  - Sidebar subtask copy-prompt references improve-feature and all sibling subtasks; feature-card and loose-plan copy-prompts are unchanged (regression).
- **Must not touch:** the existing feature-card expansion path in `buildDispatchPlans` (the `isFeature` branch); the sidebar copy-prompt's complexity-routing advance path (records `move-to-<col>`, not a planner workflow).

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Two reviewer→coder relays pass `promptComposed: true` and strip the coder's seat safeguards](../plans/feature_plan_20260821120000_promptcomposed-true-strips-seat-safeguards-on-reviewer-to-coder-relays.md) — **PLAN REVIEWED** — ID: 24413b34-7971-47be-b3b9-3b5687818107
- [ ] [Fix Subtask Prompt Dispatch Loses Feature Context](../plans/fix-subtask-prompt-dispatch-loses-feature-context.md) — **PLAN REVIEWED** — ID: 28ca24bb-f2a1-4469-88a0-fd6a9f56c0ce
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; independent call sites, both on the dispatch path, both now in PLAN REVIEWED. They touch the same file (`TaskViewerProvider.ts`) but disjoint regions — subtask 1 edits the two reviewer relays (`:23350`, `:23402`); subtask 2 edits the run-sheet derivation sites (`:8451`, `:8207`, `:8609`, `:23513`). The single-card dispatch function contains both a subtask-2 edit (`:23513`) and a subtask-1 must-keep site (`:23535`), at different statements — a coder doing both should be aware they share that function.

They are one capability because they share a failure mode rather than a code path: in both, a composition gate is consulted, answers wrongly, and the resulting prompt is quietly deficient with nothing raised anywhere. No test, no log line, and no gate catches either — which is why both survived. That shared property is the thing to fix, and it is why each subtask carries a gate or assertion, not only a code change.

One inherited trap worth naming for whoever codes them. The board does not exhibit the first bug because it filters subtask cards out at render time, so only the feature card is visible and its copy button always carries the feature's own id. Verifying the fix from the board therefore proves nothing — it must be exercised from the sidebar Plans view, where subtasks render individually with their own buttons. A green board check is the false negative that hid this.

For the second: the audit gate that should have caught it exists and is GREEN at HEAD. The 2026-08-31 audit pass already repaired the classifier (paren-balanced `dispatchCallArgs`) and re-pinned to 14/5/9, deliberately keeping the two relays as composed and deferring the change to this plan. This plan overrules that deferral: drop the marker at the two relays, lower the composed count 5 → 3, raise the uncomposed count 9 → 11, and rewrite the audit note. The classifier is not touched — re-pinning against the current (correct) classifier's output is the work.
