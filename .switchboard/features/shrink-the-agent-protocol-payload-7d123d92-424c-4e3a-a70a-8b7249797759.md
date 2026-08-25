# Shrink the agent protocol payload

**Complexity:** 5

## Goal

Cut what every agent prompt has to carry. The injected protocol block runs to nearly fifteen thousand characters, and skills do not say what they need in order to run. Shrinking the injected block and having each skill declare its preconditions are two halves of the same reduction. A third half — flattening the 30 non-user-facing protocols out of the skill shape — was merged into the external *protocols-as-db-rows-not-scaffolded-files* plan and removed from this feature; see Dependencies & sequencing.

## How the Subtasks Achieve This

- **Cut the injected agent protocol block from 14,826 chars to ~740**: cuts the block itself, which is the largest single fixed cost in every prompt.
- **Every skill declares its preconditions and what to do when they are unmet**: makes each skill state what it needs, so a skill that cannot run says so instead of being carried and half-executed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Cut the injected agent protocol block from 14,826 chars to ~740](../plans/shrink-the-injected-agent-protocol-block.md) — **CODE REVIEWED**
- [ ] [Every skill declares its preconditions and what to do when they are unmet](../plans/skills-declare-preconditions-and-degrade.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**An external prerequisite subsumes the removed flatten subtask.** *Protocols become database rows injected into prompts, not files scaffolded into every repo* (`protocols-as-db-rows-not-scaffolded-files.md`, a subtask of the **Storage layer overhaul** feature) removes the scaffolded protocol files entirely rather than relocating them. The flatten subtask was merged into that plan — its work (rewriting reference sites, the shape convention) happens once there, against resolver calls rather than flat paths. That plan should land before the shrink plan: it removes ~996 chars of protocol-list text the shrink plan also counts, so whichever lands second re-measures the baseline rather than trusting the figure written in the plan.

**Within this feature:** **Every skill declares its preconditions** should land before or alongside **Cut the injected block**. The shrink plan's resident rule tells agents to use the `query-kanban` skill and warns that hand-written SQL silently returns nothing; the preconditions plan inverts `query-kanban` to use endpoints as the primary method. If preconditions lands first, the resident rule is accurate from the start. If shrink lands first, the rule needs a one-line update (generalize the SQL-specific warning) when preconditions lands. The two subtasks are otherwise independent — they touch different sections of `ClaudeCodeMirrorService.ts` (managed-block helpers vs MIRROR_MANIFEST descriptions) and do not conflict.

## Completion Report

Both subtasks implemented and reviewed. **Shrink plan:** CLAUDE.md managed block cut from 14,826 chars to 611 chars (94.8% reduction, gate <800). New `CLAUDE_PROTOCOL_BODY` constant with three resident rules (import/watcher, memo suppression, query-kanban label/ID trap); `CLAUDE_PREAMBLE` deleted, `CLAUDE_PROTOCOL_HEADER` kept as legacy detector only. `buildManagedInner` gained per-host `bodyOverride` param. Card-move rule relocated to `agentPromptBuilder.assembleSuffix` (present for planner/coder/intern/reviewer/tester, absent for lead/orchestrator). Docs pointer gated out as `DOCS_POINTER_RULE` (prereq `switchboard.dev` not live). Contract test + CI wiring added. **Preconditions plan:** `query-kanban` inverted to endpoints-primary/SQL-fallback with `## Preconditions`. Protocol scope widened to include team members, pointed at `GET /catalog`. Preconditions added to `kanban_operations` and `worktree-cleanup`. All four `MIRROR_MANIFEST` descriptions updated. Files changed: `src/services/ClaudeCodeMirrorService.ts`, `src/extension.ts`, `src/services/ControlPlaneMigrationService.ts`, `src/services/agentPromptBuilder.ts`, `.agents/skills/query-kanban/SKILL.md`, `.agents/skills/kanban_operations/SKILL.md`, `.agents/skills/worktree-cleanup/SKILL.md`, `.agents/protocols/switchboard-orchestration/SKILL.md`, `.agents/workflows/switchboard-memo.md`, `.claude/skills/` mirror (regenerated), `src/test/claude-protocol-block-size-contract.test.js`, `package.json`, `.github/workflows/integration-tests.yml`. No issues encountered; compilation and tests skipped per run directives.

## Review Findings

Both subtasks reviewed together; per-plan detail is in each subtask file. The TypeScript half shipped correctly, but the markdown half of the preconditions subtask had been **entirely reverted in the working tree** by a concurrent stale-tree write — restored from `843bae45`, with the `switchboard-orchestration` → `switchboard-mission-control-http` pointer repaired. Three gates were red and are now green: the shrink plan's own size/content contract (a regex that could not match its hard-wrapped body), `mirror:check` (the commit changed `manage-features`' description without regenerating its mirror), and the total absence of any gate over the preconditions work — closed with a new `test:contract:skill-preconditions` wired into CI. A second pass then closed the half the first one wrongly deferred: `AGENTS.md` went **14,296 → 616 chars** and now emits the same body as CLAUDE.md, so both hosts get the cut the plan asked for. Spark was not a real blocker — it was the only consumer of that 14 KB and wanted just four sections, which moved verbatim to `.agents/plan-authoring-protocol.md` (never scaffolded, never injected), with `AGENTS.md` kept as a fallback for workspaces older releases scaffolded. Validation: tsc clean, `mirror:check` green, claude-protocol-block 17/17, skill-preconditions 8/8, minimal-prompt green, reviewer-prompt-behaviour 68/68, spark-context-exporter 9/9, vsix-packaging green. Remaining risk: both targets still hard-fail scaffolding if the bundled `AGENTS.md` is unreadable, despite neither using its content (`extension.ts:3882`).
