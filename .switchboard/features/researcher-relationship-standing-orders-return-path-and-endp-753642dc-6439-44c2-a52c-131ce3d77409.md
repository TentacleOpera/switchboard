# Researcher Relationship: Standing Orders, Return Path and Endpoint Retirement

**Complexity:** 4

## Goal

Make the researcher relationship work as a durable standing order with a closed loop, and delete the parallel HTTP mechanism that duplicates it. Today the Link-up modal's default preset-plus-mode pairing relays a parent-addressed instruction to the child, inverting every pronoun; a researcher that does receive a question has no instruction to save its findings or reply; and the /research/dispatch endpoint resolves researchers against VS Code-only terminal pools, reporting not-live for a live pty-fleet researcher. These three plans converge on one mechanism: a preset carrying a direction IS a standing order, a round-trip relationship needs a member-side companion order, and once both exist the endpoint is redundant surface that can be deleted rather than repaired.

## How the Subtasks Achieve This

- **The Researcher Relationship Has No Return Path**: adds an optional `memberTemplate` to the preset shape and installs it on the researcher once at spawn, carrying the concrete `/terminals/relay` reply call and the `.switchboard/docs/` save instruction — the two halves nothing else in the system supplies. This is what makes "fold its answer in when it comes back" mean something.
- **Link-Up Role Presets Fire Through The Relay Path**: derives the Link-up modal's Mode from the preset's existing `direction` field, so role presets install as standing orders instead of being relayed verbatim to an audience they were not written for. Derived rather than stored as a second field, so the two encodings cannot drift.
- **Retire /research/dispatch And The Researcher Hand-Off Prompt Directive**: deletes the route, its handler, the callback, the VS Code-only resolution method and the injected `RESEARCHER HAND-OFF` prompt block, once the standing-order replacement carries the save instruction the endpoint used to append host-side.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Retire /research/dispatch And The Researcher Hand-Off Prompt Directive](../plans/feature_plan_20260812170000_research-dispatch-blind-to-pty-fleet.md) — **CREATED**
- [ ] [Link-Up Role Presets Fire Through The Relay Path, Inverting Who The Instruction Is Addressed To](../plans/feature_plan_20260812171500_link-up-presets-fire-through-relay-not-standing-orders.md) — **CREATED**
- [ ] [The Researcher Relationship Has No Return Path](../plans/feature_plan_20260813060000_researcher-relationship-has-no-return-path.md) — **CREATED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

Hard chain, stated in the plans themselves: **return path → preset delivery → retirement.**

1. **The Researcher Relationship Has No Return Path** must land first. It relocates the save instruction and adds the return address that the retirement's replacement needs.
2. **Link-Up Role Presets Fire Through The Relay Path** reads `direction` and is independent of the retirement; it can land any time after the shared preset surface exists.
3. **Retire /research/dispatch** must land **last**. It names the return-path plan as a hard prerequisite — deleting the endpoint first leaves an interval in which nothing closes the research loop, because that endpoint is currently the only thing appending the save instruction.

**⚠ External blocker — none of these can start yet.** All three declare a hard dependency on **teams subtask 4** (`feature_plan_20260812190005_team-member-scope-and-relationship.md`), which creates `src/services/linkPresets.ts` as the canonical preset list, introduces the `direction` field, and adds the `linkPresets.ts` ↔ `terminals.js` mirror contract test. That plan is **not part of this feature** — it belongs to the teams work. Landing any subtask here before it means inventing the field these plans are written to read.

**File contention:** the two webview-side subtasks share `src/webview/terminals.js` (different regions) with each other and with the teams subtasks — one stream per file. The retirement touches `LocalApiServer.ts`, `TaskViewerProvider.ts` and `agentPromptBuilder.ts` only, so it does not conflict with the other two. The return-path plan must extend the mirror contract test in the same change that adds `memberTemplate`, or the test either fails or silently stops covering the new field.
