# Shrink the agent protocol payload

**Complexity:** 5

## Goal

Cut what every agent prompt has to carry. The injected protocol block runs to nearly fifteen thousand characters, and skills do not say what they need in order to run. Shrinking the injected block and having each skill declare its preconditions are two halves of the same reduction. A third half — flattening the 30 non-user-facing protocols out of the skill shape — was merged into the external *protocols-as-db-rows-not-scaffolded-files* plan and removed from this feature; see Dependencies & sequencing.

## How the Subtasks Achieve This

- **Cut the injected agent protocol block from 14,826 chars to ~740**: cuts the block itself, which is the largest single fixed cost in every prompt.
- **Every skill declares its preconditions and what to do when they are unmet**: makes each skill state what it needs, so a skill that cannot run says so instead of being carried and half-executed.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Cut the injected agent protocol block from 14,826 chars to ~740](../plans/shrink-the-injected-agent-protocol-block.md) — **PLAN REVIEWED**
- [ ] [Every skill declares its preconditions and what to do when they are unmet](../plans/skills-declare-preconditions-and-degrade.md) — **PLAN REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**An external prerequisite subsumes the removed flatten subtask.** *Protocols become database rows injected into prompts, not files scaffolded into every repo* (`protocols-as-db-rows-not-scaffolded-files.md`, a subtask of the **Storage layer overhaul** feature) removes the scaffolded protocol files entirely rather than relocating them. The flatten subtask was merged into that plan — its work (rewriting reference sites, the shape convention) happens once there, against resolver calls rather than flat paths. That plan should land before the shrink plan: it removes ~996 chars of protocol-list text the shrink plan also counts, so whichever lands second re-measures the baseline rather than trusting the figure written in the plan.

**Within this feature:** **Every skill declares its preconditions** should land before or alongside **Cut the injected block**. The shrink plan's resident rule tells agents to use the `query-kanban` skill and warns that hand-written SQL silently returns nothing; the preconditions plan inverts `query-kanban` to use endpoints as the primary method. If preconditions lands first, the resident rule is accurate from the start. If shrink lands first, the rule needs a one-line update (generalize the SQL-specific warning) when preconditions lands. The two subtasks are otherwise independent — they touch different sections of `ClaudeCodeMirrorService.ts` (managed-block helpers vs MIRROR_MANIFEST descriptions) and do not conflict.

