# Drive-Mode Prompt Overhaul

**Complexity:** 6

## Goal

The team lead agent wastes a full turn on discovery work the extension already has at dispatch time — querying the DB, enumerating terminals, checking standing orders, grepping the codebase. The dispatch prompt is a pointer to a 631-line skill file instead of a payload with the roster, plan IDs, and operational rules. The skill file interleaves war stories with operational rules. And the prompt carries implementation addons (Accuracy Mode, SKIP COMPILATION/TESTS) that are irrelevant to a drive-mode head that dispatches to coders. This feature fixes all three: inject context into the prompt, trim the skill, exclude irrelevant addons, and auto-arm the feature watch with the correct stop column.

## How the Subtasks Achieve This

- **Inject Context Into Drive-Mode Prompt, Trim Skill File**: Replaces the one-line `DRIVE_FEATURE_PREFIX` pointer with a dynamically built operational block that injects the team roster (with per-member roles resolved via `ptyListTerminals` or `_liveTerminalsProvider`, not `getFleetLiveness()` which carries no role field), plan IDs, API port, and standing order status directly into the prompt. Trims the 631-line skill file by adding a Quick Start section, moving war stories to an appendix, and adding explicit Do NOT prohibitions (no DB queries, no pre-dispatch grep, no terminal enumeration).
- **Drive-Mode Addon Cleanup + Auto-Arm Feature Watch**: Excludes implementation-oriented addons (Accuracy Mode, SKIP COMPILATION, SKIP TESTS, SUPPRESS WALKTHROUGH) from drive-mode lead AND feature-mode coder prompts — the coders get their own seat-scoped directives, so the lead's and dispatching coder's copies are noise. Moves feature watch arming from the agent to the extension (fired at the `triggerAction` post-dispatch hook when a drive-mode feature card is dispatched to a lead), hardcoding `stopColumns: ["CODE REVIEWED"]` (the deterministic correct value for drive-mode leads) to eliminate false stall notices during the review phase.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Inject Context Into Drive-Mode Prompt, Trim Skill File](../plans/inject-context-trim-skill-drive-mode-prompt-payload.md) — **PLAN REVIEWED**
- [ ] [Drive-Mode Addon Cleanup + Auto-Arm Feature Watch](../plans/drive-mode-addon-cleanup-auto-arm-watch.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Plan A (Inject Context)** must land first — it replaces the static prefix with the enriched prompt and trims the skill file.
- **Plan B (Addon Cleanup + Auto-Arm)** depends on Plan A's enriched prompt being in place (it should not include the `watchFeature` arming call since the system arms it). Plan B's addon exclusion is independent and could land in parallel, but the auto-arm watch change should wait for Plan A.
- Recommended order: Plan A → Plan B.
