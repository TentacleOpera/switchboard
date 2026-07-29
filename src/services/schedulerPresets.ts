/**
 * Shared prompt builder presets for Scheduled Jobs.
 *
 * Module-level exported functions (not provider methods) so that BOTH scheduler
 * prompt paths call one copy of the text:
 *   - COPY PROMPT / external targets → `KanbanProvider._buildSchedulerPrompt`
 *   - local-terminal tick            → `TaskViewerProvider._schedulerTick`
 */

/**
 * The `fetch-plans` source preset: pull plan files authored on remote branches
 * (typically by a cloud VM) into the local `.switchboard/plans/` directory.
 *
 * `job.id` is load-bearing — the summary path it emits must match the file
 * `TaskViewerProvider._startSchedulerOutputCapture` watches
 * (`.switchboard/scheduler-<job.id>-latest.md`), or the run produces no visible
 * output in the panel.
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
