import * as fs from 'fs';
import * as path from 'path';

export interface InstructionRequest {
    kind: string;
    body: string;
    from?: string;
    planId?: string;
    feature?: string;
}

export interface InstructionWriteResult {
    success: boolean;
    filePath?: string;
    error?: string;
}

export async function bootstrapInstructionsDirectory(workspaceRoot: string): Promise<string> {
    const baseDir = path.join(workspaceRoot, '.switchboard', 'instructions');
    const inboxDir = path.join(baseDir, 'inbox');
    const claimedDir = path.join(inboxDir, 'claimed');
    const standingDir = path.join(baseDir, 'standing');
    const movesDir = path.join(baseDir, 'moves');
    const appliedMovesDir = path.join(movesDir, 'applied');

    await fs.promises.mkdir(claimedDir, { recursive: true });
    await fs.promises.mkdir(standingDir, { recursive: true });
    await fs.promises.mkdir(appliedMovesDir, { recursive: true });

    // Seed default standing job definitions if absent
    await seedDefaultStandingJobs(standingDir);

    return baseDir;
}

export async function writeInstruction(workspaceRoot: string, req: InstructionRequest): Promise<InstructionWriteResult> {
    try {
        const baseDir = await bootstrapInstructionsDirectory(workspaceRoot);
        const inboxDir = path.join(baseDir, 'inbox');

        const flatten = (s: string) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
        const now = new Date();
        const iso = now.toISOString();
        const compact = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const rand = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
        const filename = `instr-${compact}-${flatten(req.kind)}-${rand}.md`;
        const filePath = path.join(inboxDir, filename);

        const fmLines: string[] = ['---'];
        if (req.from) fmLines.push(`from: ${flatten(req.from)}`);
        fmLines.push(`kind: ${flatten(req.kind)}`);
        if (req.planId) fmLines.push(`planId: ${flatten(req.planId)}`);
        if (req.feature) fmLines.push(`feature: ${flatten(req.feature)}`);
        fmLines.push(`created: ${iso}`);
        fmLines.push('---');
        fmLines.push('');
        fmLines.push(req.body);

        await fs.promises.writeFile(filePath, fmLines.join('\n'), 'utf8');
        return { success: true, filePath };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

async function seedDefaultStandingJobs(standingDir: string): Promise<void> {
    const jobs = [
        {
            filename: 'memo-to-plans.md',
            content: `---
job: memo-to-plans
schedule: daily
reads: .switchboard/memo.md
writes: .switchboard/plans/
---

Read .switchboard/memo.md. Process each entry into a distinct plan file in .switchboard/plans/ following Switchboard authoring conventions. Clear or truncate .switchboard/memo.md on completion. Omit **Project:** pin unless specified.`
        },
        {
            filename: 'nightly-code-review.md',
            content: `---
job: nightly-code-review
schedule: daily
reads: .switchboard/kanban-state-coded.md
writes: .switchboard/plans/
---

Parse plan paths from .switchboard/kanban-state-coded.md and mtime scan. Review each plan file for completeness and potential bugs. Append findings to the respective plan file. Do NOT move cards directly.`
        },
        {
            filename: 'research-unknowns.md',
            content: `---
job: research-unknowns
schedule: daily
reads: .switchboard/kanban-state-created.md
writes: .switchboard/plans/
---

Scan new plans in CREATED. Identify ## Uncertain Assumptions. Dispatch your own research sub-agents to resolve each unknown, then rewrite ## Uncertain Assumptions in place with findings.`
        },
        {
            filename: 'pipeline-manager.md',
            content: `---
job: pipeline-manager
schedule: daily
reads: all active columns
writes: .switchboard/instructions/moves/
---

Advance plans through workflow stages using subagents. Produce declared moves in .switchboard/instructions/moves/ specifying planId -> target column for Switchboard to validate and apply.`
        }
    ];

    for (const j of jobs) {
        const p = path.join(standingDir, j.filename);
        if (!fs.existsSync(p)) {
            await fs.promises.writeFile(p, j.content, 'utf8');
        }
    }
}
