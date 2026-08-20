/**
 * Shared prompt builder presets for Scheduled Jobs.
 *
 * Module-level exported functions (not provider methods) so that the
 * surviving scheduler tick path calls one copy of the text:
 *   - run-sheet survivor tick → `TaskViewerProvider._tickSurvivorSchedulerJobs`
 *
 * Both surviving sources (`fetch-plans`, `reconcile`) build here. The scheduler
 * SURFACE is retired; the two prompts it used to emit are not.
 */

/**
 * The board-driving contract every prompt that moves cards must carry. Lives
 * here (a dependency-free module) rather than on `KanbanProvider` so both the
 * reconcile preset and the Kanban-side builders share one copy —
 * `KanbanProvider.BOARD_DRIVING_CONTRACT` aliases this constant.
 */
export const BOARD_DRIVING_CONTRACT = `Move cards on this workspace's board via the sanctioned \`kanban_operations\` skill (\`move-card.js\` / \`POST /kanban/move\`), NEVER raw SQL. Raw SQL strands cards and bypasses the move-card.js side-effects (cascades, syncs). To reach the board's Local API Server, read the port from \`.switchboard/api-server-port.txt\` in the workspace root.`;

/**
 * The `fetch-plans` source preset: pull plan files authored on remote branches
 * (typically by a cloud VM) into the local `.switchboard/plans/` directory.
 *
 * `job.id` is load-bearing — the summary path it emits must match the file
 * `.switchboard/scheduler-<job.id>-latest.md`, which the deleted output-capture
 * watcher used to observe. The file is still written by the prompt; it is now
 * an inert markdown artifact with no panel consumer.
 */
export function buildFetchPlansPrompt(job: { id?: string; sourceConfig?: Record<string, unknown> }): string {
    const remote = String(job.sourceConfig?.remote || 'origin').trim() || 'origin';
    const branchGlob = String(job.sourceConfig?.branchGlob || '*').trim() || '*';
    const jobId = String(job.id || '').trim();
    const summaryPath = jobId
        ? `.switchboard/scheduler-${jobId}-latest.md`
        : '.switchboard/scheduler-latest.md';

    return `You are an automated plan fetch agent for Switchboard. Your task is to fetch remote branches and import any newly-authored plan files sitting on remote branches into local \`.switchboard/plans/\`.

Steps (do them in order):

1. Fetch and prune remote tracking references from '${remote}':
\`\`\`bash
git fetch '${remote}' --prune
\`\`\`

2. List remote branches matching '${branchGlob}' on remote '${remote}', sorted by recency:
\`\`\`bash
git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/remotes/${remote}/${branchGlob}'
\`\`\`

3. For each branch in the list:
   - Enumerate all plan files under \`.switchboard/plans/\` present on that branch:
     \`\`\`bash
     git ls-tree --name-only '${remote}/<branch>' -- .switchboard/plans/
     \`\`\`
   - For each plan file path (e.g. \`.switchboard/plans/some-plan.md\`), check if it exists locally in your working directory.
   - If the file **does NOT exist locally**, copy it in:
     \`\`\`bash
     git show '${remote}/<branch>:<path>' > '<path>'
     \`\`\`
   - If the file **already exists locally**, SKIP it. Never overwrite an existing local plan file.

4. Write a one-line summary of the run — branches scanned, files copied, files skipped and why — to \`${summaryPath}\`, relative to the workspace root. Write that file even when nothing was copied; it is the only channel by which this job's result reaches the Switchboard panel.

Constraints: read-only against git history, additive-only in the working tree, never switch branches, never run git checkout/switch/merge/reset/pull, never stage anything, never overwrite existing plan files, idempotent across runs.`;
}

/**
 * The `reconcile` source preset: pull recent remote branches, scan pulled plan
 * files for new `## Completion Report` / `## Review Findings` sections, and
 * advance cards **forward-only** via the sanctioned `kanban_operations` skill —
 * never raw SQL (which strands cards and bypasses the move-card.js
 * side-effects per CLAUDE.md).
 *
 * Forward-only + idempotent: skip cards a human already advanced. A wrong
 * prompt silently moves cards backward or double-advances, so the wording is
 * load-bearing — this text is unchanged from the retired scheduler surface.
 */
export function buildReconcilePrompt(): string {
    return `You are a reconciliation agent for Switchboard. Your job is to advance kanban cards whose work has already been completed off-machine (e.g. by a cloud routine on a \`claude/\`-prefixed branch) but whose card was not moved on the board.

Steps (do them in order):

1. Fetch and pull recent remote branches:
\`\`\`bash
git fetch --prune
git pull --all || true
\`\`\`

2. For each recently-merged or pushed branch, scan the plan files under \`.switchboard/plans/\` for a NEW \`## Completion Report\` or \`## Review Findings\` section that was not present on the previous reconcile pass. (Use \`git log --since="last reconcile"\` or compare against the last reconcile commit to scope this.)

3. For each plan file with a new completion/review section, move its card **forward-only** — and ONLY forward. ${BOARD_DRIVING_CONTRACT}

   - Determine the correct next column from the plan's current column and the workspace pipeline. If you cannot determine it, SKIP the card and report it — do not guess.
   - If a card has already been advanced by a human (its current column is already at or past the expected next column), SKIP it. Never move a card backward. Never double-advance.
   - Run: \`node .agents/skills/kanban_operations/move-card.js "<planId>" "<nextColumn>" "" "<workspaceRoot>"\` and verify the output is \`OK\`.

4. Report what you moved and what you skipped (and why). Do NOT take any other actions — this is a reconciliation pass, not a coding pass.

Constraint recap: forward-only, idempotent, skip-already-advanced, sanctioned-path-only (no SQL).`;
}

/**
 * The `team-automation` source preset: deliver a recurring or on-demand
 * automation prompt to a specific team lead (or named role).
 * Includes `BOARD_DRIVING_CONTRACT` when `canMoveCards` is true.
 */
export function buildTeamAutomationPrompt(job: {
    promptOverride?: string;
    teamTarget?: { groupId?: string; role?: string; canMoveCards?: boolean };
    sourceConfig?: Record<string, unknown>;
}): string {
    const customPrompt = typeof job.sourceConfig?.prompt === 'string' ? job.sourceConfig.prompt.trim() : '';
    const basePrompt = (job.promptOverride || '').trim() || customPrompt || 'Execute scheduled team automation tasks.';
    if (job.teamTarget?.canMoveCards) {
        return `${basePrompt}\n\n${BOARD_DRIVING_CONTRACT}`;
    }
    return basePrompt;
}
