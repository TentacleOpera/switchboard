/**
 * Agent directive constants — a LEAF module: it imports nothing, so anything may
 * import it at module-evaluation time.
 *
 * These four strings lived in `agentPromptBuilder.ts` and were imported from there
 * by `standingOrderFragments.ts`, which builds its bundled-fragment table (and
 * hashes each body) at module scope. That import closed a cycle:
 *
 *     agentPromptBuilder → protocolDirectives → KanbanDatabase
 *                        → standingOrderFragments → agentPromptBuilder
 *
 * so whenever `agentPromptBuilder` was the entry point, `standingOrderFragments`
 * ran its table build against a half-initialised builder, read `undefined` for
 * GIT_SAFETY_DIRECTIVE, and threw out of `crypto.createHash().update(undefined)`
 * before any test or host code got a chance to run. The strings have no
 * dependencies of their own, so moving them here breaks the cycle at its only
 * load-order-sensitive edge rather than papering over it with a default body —
 * a fabricated git-safety directive is precisely the fallback this codebase bans.
 *
 * `agentPromptBuilder` re-exports all four, so every existing import path still
 * works. New code should import from here.
 */

/**
 * §Git — Granular git policy.
 *
 * The old single `GIT_PROHIBITION_DIRECTIVE` string conflated a safety guardrail
 * (forbid destructive ops) with permission to branch/commit and a shared-branch
 * push ban. That binary string caused two symptoms: agents refused legitimate
 * commits to `main` (a "shared branch") AND created defensive branches to have
 * somewhere "allowed" to commit. It is replaced by a composed `GIT POLICY:` block
 * assembled from four independent, prescriptive clauses (Branch → Commit → Push →
 * Safety) by `buildGitPolicyBlock`. The Safety guardrail below is the salvaged
 * half of the original string and remains byte-for-byte as strong — do not soften.
 */
export const GIT_SAFETY_DIRECTIVE = `Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout \`<path>\` / git restore, git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — commit first, then correct forward. Stage by explicit path only the files belonging to the work you are committing — never \`git add -A\` or \`git add .\` — other agents may be working the same tree.`;

/**
 * Worktree-mode guardrail — for dispatches where agents are told to self-provision
 * worktrees (useWorktreesPerPlanEnabled). Permits `git worktree remove`
 * for cleanup after merge (removes the working copy, commits survive) while keeping the
 * ban on branch deletion (loses commits) and all other destructive ops. The standard
 * guardrail above forbids worktree deletion because agents don't own the lifecycle in
 * the pre-assigned-worktree path; here they do. A host-provisioned worktree
 * (feature_worktree_mode = 'per-feature') is owned and removed by the host, so the
 * agent keeps the standard guardrail — removal permission is granted iff the agent
 * was told to create worktrees, not merely because it is standing inside one.
 */
export const GIT_SAFETY_DIRECTIVE_WORKTREE_MODE = `Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout \`<path>\` / git restore, git clean, git stash drop/clear, force pushes, or branch deletion. You may remove git worktrees you created with \`git worktree remove\` to clean up after merging — this removes the working copy, not commits. Do not use \`git worktree remove --force\` (would discard uncommitted work). If you make a mistake, do not discard — commit first, then correct forward.`;

export const NO_SUBAGENTS_DIRECTIVE = "SUBAGENT POLICY: You are strictly forbidden from spawning or invoking any subagents. Handle all tasks yourself.";
export const CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE = (name: string) =>
    `SUBAGENT POLICY: You are authorized to use the "${name}" subagent for this task. Do not spawn or invoke any other subagents.`;
