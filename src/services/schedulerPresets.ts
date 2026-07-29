/**
 * Shared prompt builder presets for Scheduled Jobs.
 */

export function buildFetchPlansPrompt(job: { sourceConfig?: Record<string, unknown> }): string {
    const remote = String(job.sourceConfig?.remote || 'origin').trim() || 'origin';
    const branchGlob = String(job.sourceConfig?.branchGlob || '*').trim() || '*';

    return `You are an automated plan fetch agent for Switchboard. Your task is to fetch remote branches and import any newly-authored plan files sitting on remote branches into local \`.switchboard/plans/\`.

Steps (do them in order):

1. Fetch and prune remote tracking references from '${remote}':
\`\`\`bash
git fetch ${remote} --prune
\`\`\`

2. List remote branches matching '${branchGlob}' on remote '${remote}', sorted by recency:
\`\`\`bash
git for-each-ref --sort=-committerdate --format='%(refname:short)' 'refs/remotes/${remote}/${branchGlob}'
\`\`\`

3. For each branch in the list:
   - Enumerate all plan files under \`.switchboard/plans/\` present on that branch:
     \`\`\`bash
     git ls-tree --name-only ${remote}/<branch> -- .switchboard/plans/
     \`\`\`
   - For each plan file path (e.g. \`.switchboard/plans/some-plan.md\`), check if it exists locally in your working directory.
   - If the file **does NOT exist locally**, copy it in:
     \`\`\`bash
     git show ${remote}/<branch>:<path> > <path>
     \`\`\`
   - If the file **already exists locally**, SKIP it. Never overwrite an existing local plan file.

4. Summarize your actions (branches scanned, files copied, files skipped) and write a single summary block to \`.switchboard/scheduler-\${JOB_ID}-latest.md\` (or output it directly).

Constraints: read-only against git history, additive-only in the working tree, never switch branches, never run git checkout/switch/merge/reset/pull, never overwrite existing plan files, idempotent across runs.`;
}
