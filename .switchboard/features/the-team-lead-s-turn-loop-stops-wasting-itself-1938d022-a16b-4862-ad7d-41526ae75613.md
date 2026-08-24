# The Team Lead's Turn Loop Stops Wasting Itself

**Complexity:** 7

## Goal

Reclaim the work a team lead burns before it does anything useful. Today it re-reads every subtask plan file and a six-hundred-line skill on its first turn, re-checks an API port and its own terminal name that are both already injected into its prompt, re-verifies connectivity it necessarily has, commits after every subtask instead of once at the end, and gets nudged on a ninety-second cadence whether or not it is stalled. Five independent reductions, no behaviour change intended beyond the waste.

## How the Subtasks Achieve This

- **Make the feature file the lead's single source of truth and retire the dispatch skill** — kills the largest read: the feature file carries what dispatch and review need, so the lead stops opening every subtask plan and a six-hundred-line skill.
- **Team lead does redundant API port and terminal name checks** — drops a round-trip per dispatch for two facts the enriched drive prefix already injects.
- **Eliminate redundant Switchboard connectivity checks in dispatched agent prompts** — the same waste across every dispatched role: an agent that received its prompt from Switchboard does not need to verify Switchboard is running.
- **Team lead commits per-subtask instead of once at end** — removes the whenDone git policy clause forced onto the head by seat-safeguard symmetry.
- **Fix silent nudge noise to team lead in team coding mode** — stops the feature-level and queue-level stall sweeps injecting turn-end messages on a ninety-second cadence into a lead that is not stalled.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Eliminate Redundant Switchboard Connectivity Checks in Dispatched Agent Prompts](../plans/eliminate-redundant-switchboard-connectivity-checks-in-dispatched-agent-prompts.md) — **LEAD CODED**
- [ ] [Make the Feature File the Lead's Single Source of Truth and Retire the Dispatch Skill](../plans/feature_plan_20260820140000_drive-mode-stop-reverification-waste.md) — **LEAD CODED**
- [ ] [Fix Silent Nudge Noise to Team Lead in Team Coding Mode](../plans/fix-silent-nudge-noise-to-team-lead-in-team-coding-mode.md) — **LEAD CODED**
- [ ] [Fix: Team Lead Commits Per-Subtask Instead of Once at End](../plans/fix_team_lead_commit_timing_directive.md) — **LEAD CODED**
- [ ] [Team Lead Does Redundant API Port and Terminal Name Checks Despite Both Being in Its Prompt](../plans/feature_plan_20260821090653_team-lead-redundant-port-and-terminal-name-checks.md) — **LEAD CODED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

No hard ordering constraints; all five are independent reductions and can be executed in parallel. The two redundant-check subtasks overlap in intent — one cites the other — and are cheapest done in the same pass.

## Completion Summary

All five subtasks implemented and reviewed via git diff. The drive prefix now inlines 7 behavioral rules and points the lead at the feature file (with plan IDs and Team Dispatch Instructions) instead of a 689-line skill file, which is deleted. Redundant port/terminal-name checks are suppressed from the prefix. A SWITCHBOARD_LIVENESS_DIRECTIVE is folded into dispatchPrefixCore so all 7 roles skip port-discovery and health-check steps. Commit-timing disambiguation added to both the driveMode directive and head-prompt §7. Nudge noise fixed: nudgeSilenceMs (10min default) decouples nudge pacing from 90s turn-end detection, team-wide in-flight detection and team-liveness suppression stop false positives during active coding, feature nudge gets nudgeCount with gate-4a re-arm, and user escalation is stripped from both gate-8 blocks.

