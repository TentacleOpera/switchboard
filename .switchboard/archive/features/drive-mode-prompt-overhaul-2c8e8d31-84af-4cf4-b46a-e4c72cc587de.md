# Drive-Mode Prompt Overhaul

**Complexity:** 6

## Goal

The team lead agent wastes a full turn on discovery work the extension already has at dispatch time — querying the DB, enumerating terminals, checking standing orders, grepping the codebase. The dispatch prompt is a pointer to a 631-line skill file instead of a payload with the roster, plan IDs, and operational rules. The skill file interleaves war stories with operational rules. And the prompt carries implementation addons (Accuracy Mode, SKIP COMPILATION/TESTS) that are irrelevant to a drive-mode head that dispatches to coders. This feature fixes all three: inject context into the prompt, trim the skill, exclude irrelevant addons, and auto-arm the feature watch with the correct stop column.

## How the Subtasks Achieve This

- **Inject Context Into Drive-Mode Prompt, Trim Skill File**: Replaces the one-line `DRIVE_FEATURE_PREFIX` pointer with a dynamically built operational block that injects the team roster (with per-member roles resolved via `ptyListTerminals` or `_liveTerminalsProvider`, not `getFleetLiveness()` which carries no role field), plan IDs, API port, and standing order status directly into the prompt. Trims the 631-line skill file by adding a Quick Start section, moving war stories to an appendix, and adding explicit Do NOT prohibitions (no DB queries, no pre-dispatch grep, no terminal enumeration).
- **Drive-Mode Addon Cleanup + Auto-Arm Feature Watch**: Excludes implementation-oriented addons (Accuracy Mode, SKIP COMPILATION, SKIP TESTS, SUPPRESS WALKTHROUGH) from drive-mode lead AND feature-mode coder prompts — the coders get their own seat-scoped directives, so the lead's and dispatching coder's copies are noise. Moves feature watch arming from the agent to the extension (fired at the `triggerAction` post-dispatch hook when a drive-mode feature card is dispatched to a lead), hardcoding `stopColumns: ["CODE REVIEWED"]` (the deterministic correct value for drive-mode leads) to eliminate false stall notices during the review phase.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Inject Context Into Drive-Mode Prompt, Trim Skill File](../plans/inject-context-trim-skill-drive-mode-prompt-payload.md) — **CODE REVIEWED** — ID: b97d86d8-7627-497e-8e09-856242a97cfa
- [ ] [Drive-Mode Addon Cleanup + Auto-Arm Feature Watch](../plans/drive-mode-addon-cleanup-auto-arm-watch.md) — **CODE REVIEWED** — ID: 0a879cf3-0269-4637-9280-81805033e399
<!-- END SUBTASKS -->

## Dependencies & sequencing

- **Plan A (Inject Context)** must land first — it replaces the static prefix with the enriched prompt and trims the skill file.
- **Plan B (Addon Cleanup + Auto-Arm)** depends on Plan A's enriched prompt being in place (it should not include the `watchFeature` arming call since the system arms it). Plan B's addon exclusion is independent and could land in parallel, but the auto-arm watch change should wait for Plan A.
- Recommended order: Plan A → Plan B.

## Completion Summary

Both subtasks implemented and committed. **Plan A** (inject-context-trim-skill): replaced static `DRIVE_FEATURE_PREFIX` with `_buildDrivePrefix` building an enriched operational block (team roster with roles+liveness, plan IDs, API port, compact rules); added `_resolveTeamRosterForPrompt` (roles via `_liveTerminalsProvider` then `listFleetTerminals`, liveness via `getFleetLiveness`) and public `listFleetTerminals` wrapper on TaskViewerProvider; trimmed SKILL.md with Quick Start §0, Do NOT §0.1, war stories moved to Appendix with back-references, §3.5 auto-arming note. Falls back to static prefix when no team found. **Plan B** (addon-cleanup-auto-arm): suppressed implementation addons (SKIP COMPILATION, SKIP TESTS, SUPPRESS WALKTHROUGH, Accuracy Mode) from drive-mode lead and feature-mode coder prompts gated on `driveMode && featureMode`; added `_autoArmDriveModeFeatureWatch` in KanbanProvider triggerAction handler arming feature watch with `stopColumns: ['CODE REVIEWED']` on drive-mode feature dispatch to lead. Files changed: `src/services/KanbanProvider.ts`, `src/services/TaskViewerProvider.ts`, `src/services/agentPromptBuilder.ts`, `.agents/skills/terminal-coder-dispatch/SKILL.md`. No issues encountered.

## Review Findings

The combined review kept the prompt-context and addon behavior, synchronized the Claude skill mirror, repaired feature-watch mutation races, and added/wired focused regression contracts. Changed review files include `src/services/KanbanDatabase.ts`, `src/services/KanbanProvider.ts`, `src/services/PlanIngestionEngine.ts`, both terminal/drive contract tests, `package.json`, `.github/workflows/integration-tests.yml`, and `.claude/skills/terminal-coder-dispatch/SKILL.md`. TypeScript test compilation and all focused contracts passed; the exact VS Code grep suites compiled and linted cleanly but the local downloaded Electron executable was unavailable, so CI now runs both under `xvfb-run`. Remaining risk is external-process config contention beyond the in-process serialization boundary and unrelated mirror drift in three other skills.
