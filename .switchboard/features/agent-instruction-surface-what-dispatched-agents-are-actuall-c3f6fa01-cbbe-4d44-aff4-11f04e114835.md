# Agent Instruction Surface - What Dispatched Agents Are Actually Told

**Complexity:** 4

## Goal

Correct the text the system hands to agents, on all three surfaces where it is currently wrong. A feature dispatch tells a coder two opposite things about git worktrees in one message and silently swaps the git guardrail to the variant that permits worktree removal - on exactly the dispatches where the host, not the agent, owns the worktree. A lead driving coder terminals is never told the one verb that resets a coder's context, so a coder carries subtask 1's conversation into subtask 7 forever. And two skills deliberately hidden from one host's menu are still advertised as doors on the other. These are three instances of one defect class: the instruction surface diverges from what the system actually does, and nothing validates it.

## How the Subtasks Achieve This

- **Two skills hidden from Claude Code's slash menu are still exposed to Antigravity — strip their source frontmatter**: Deletes the frontmatter blocks from `terminal-coder-dispatch` and `rearrange-feature` so both hosts agree on which skills are user-facing, and aligns one stale `descriptionFallback`. A verified zero-diff change — the generated `.claude/` mirror is byte-identical before and after.
- **Proactive /clear when a lead rests a coder terminal**: Documents `ptyClearTerminal` and the rest-and-clear step in the two lead-facing skill contracts, with its precondition (completion received **and** next work assigned elsewhere) and the self-clear / clear-all prohibitions — closing the unpaid cost of the mandatory `clearBeforePrompt: false` rule, which means a lead-driven coder is never cleared at all. Corrects two stale factual claims in the same files that the new source-text gate would otherwise freeze in place.
- **Fix the Worktree Self-Contradiction, Retire Inert `featureWorktreeMode`**: Deletes the `|| options?.featureMode === true` disjunct at all ten `buildGitPolicyBlock` call sites so the git block and the feature directive read one flag, restoring the standard guardrail on the default feature path; removes the `featureWorktreeMode` prompt plumbing that made the contradiction invisible, while keeping its live orchestration half.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Two skills deliberately hidden from Claude Code's slash menu are still exposed to Antigravity's discovery — strip their source frontmatter](../plans/frontmatter-host-drift-no-user-skills-exposed-on-antigravity.md) — **CODE REVIEWED**
- [ ] [Proactive /clear when a lead rests a coder terminal](../plans/feature_plan_20260815140920_proactive-clear-when-a-lead-rests-a-coder-terminal.md) — **CODE REVIEWED**
- [ ] [Feature Prompt — Fix the Worktree Self-Contradiction, Retire Inert `featureWorktreeMode`](../plans/feature-prompt-worktree-contradiction.md) — **CODE REVIEWED**
<!-- END SUBTASKS -->

## Dependencies & sequencing

**The frontmatter-strip subtask must land first. This ordering is load-bearing, not stylistic.**

Both it and the proactive-clear subtask edit `.agents/skills/terminal-coder-dispatch/SKILL.md`, and they make **opposite demands on the generated `.claude/` mirror**:

- The frontmatter-strip subtask's decisive verification is that `git diff --name-only` lists exactly three paths and **nothing under `.claude/`**, with `mirror:check` reporting the pinned per-file sha256 hashes and a count of 47.
- The proactive-clear subtask legitimately **regenerates and commits** two mirror files (`.claude/skills/terminal-coder-dispatch/SKILL.md`, `.claude/skills/switchboard-orchestration/SKILL.md`), because `mirror:check` fails CI on any drift.

Run them in the other order and the frontmatter subtask's pinned hashes are stale and its zero-diff property becomes unverifiable — the one check that catches a deletion taking a byte it should not have.

The worktree subtask is **fully independent**: it touches `src/services/agentPromptBuilder.ts` and `src/services/KanbanProvider.ts` only, shares no file with the other two, and may run in parallel with either.

Note for the implementer of the proactive-clear subtask: after the frontmatter strip lands, `terminal-coder-dispatch/SKILL.md` begins at its `# Skill: Terminal Coder Dispatch` heading with no frontmatter block — re-resolve line references before editing, and capture `git status` for `.claude/skills/**` before starting so the regeneration is separable from whatever the working tree already carries.
