import * as fs from 'fs';
import * as path from 'path';
import { DEFAULT_KANBAN_COLUMNS } from './agentConfig';

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

/**
 * Canonical form for a column ref — 'lead-coded' / 'lead_coded' / 'Lead Coded'
 * all collapse to 'LEAD CODED'. Mirrors `LocalApiServer._canonColumnRef` so a
 * declared move and an HTTP move accept the same vocabulary.
 */
function canonColumnRef(s: string): string {
    return String(s || '').trim().toUpperCase().replace(/[-_]+/g, ' ').replace(/\s+/g, ' ');
}

/**
 * Built-in column IDs in canonical form, derived from `DEFAULT_KANBAN_COLUMNS`
 * rather than hand-listed. A literal set drifts the moment a column is added or
 * renamed, and the previous one mixed formats — 'CODE REVIEWED' alongside
 * 'coder-coded' — so a file declaring the canonical 'LEAD CODED' was rejected
 * while 'lead-coded' passed.
 *
 * Custom columns are validated per-workspace against the live board below; this
 * set is only the built-in floor.
 */
const BUILTIN_COLUMN_REFS: Set<string> = new Set(
    DEFAULT_KANBAN_COLUMNS.map((c: any) => canonColumnRef(String(c.id)))
);

export async function bootstrapInstructionsDirectory(workspaceRoot: string): Promise<string | null> {
    const sbDir = path.join(workspaceRoot, '.switchboard');
    if (!fs.existsSync(sbDir)) {
        // Lazy creation: do not eagerly pollute non-Switchboard workspaces
        return null;
    }
    const baseDir = path.join(sbDir, 'instructions');
    const inboxDir = path.join(baseDir, 'inbox');
    const claimedDir = path.join(inboxDir, 'claimed');
    const standingDir = path.join(baseDir, 'standing');
    const movesDir = path.join(baseDir, 'moves');
    const appliedMovesDir = path.join(movesDir, 'applied');

    await fs.promises.mkdir(claimedDir, { recursive: true });
    await fs.promises.mkdir(standingDir, { recursive: true });
    await fs.promises.mkdir(appliedMovesDir, { recursive: true });

    await seedDefaultStandingJobs(standingDir);
    await retireLegacyPipelineManager(standingDir);
    return baseDir;
}

export async function writeInstruction(workspaceRoot: string, req: InstructionRequest): Promise<InstructionWriteResult> {
    try {
        const baseDir = await bootstrapInstructionsDirectory(workspaceRoot);
        if (!baseDir) {
            return { success: false, error: '.switchboard directory does not exist' };
        }
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

export async function isInboxItemClaimed(workspaceRoot: string, filename: string, stalenessHours = 24): Promise<boolean> {
    const claimPath = path.join(workspaceRoot, '.switchboard', 'instructions', 'inbox', 'claimed', `${filename}.claim`);
    if (!fs.existsSync(claimPath)) return false;

    try {
        const content = await fs.promises.readFile(claimPath, 'utf8');
        const match = content.match(/claimed_ts:\s*([^\n]+)/);
        if (match) {
            const claimTime = new Date(match[1].trim()).getTime();
            const ageMs = Date.now() - claimTime;
            if (ageMs < stalenessHours * 3600 * 1000) {
                return true; // Active claim
            }
        }
    } catch { /* parse failure -> treat as unclaimed */ }
    return false;
}

export async function claimInboxItem(workspaceRoot: string, filename: string, agentId = 'external-agent'): Promise<void> {
    const claimPath = path.join(workspaceRoot, '.switchboard', 'instructions', 'inbox', 'claimed', `${filename}.claim`);
    const dir = path.dirname(claimPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const content = `claimed_ts: ${new Date().toISOString()}\nagent: ${agentId}\n`;
    await fs.promises.writeFile(claimPath, content, 'utf8');
}

export async function getLastRunCursor(workspaceRoot: string, jobName: string): Promise<string | null> {
    const runLogPath = path.join(workspaceRoot, '.switchboard', 'instructions', 'run-log.md');
    if (!fs.existsSync(runLogPath)) return null;

    try {
        const content = await fs.promises.readFile(runLogPath, 'utf8');
        const lines = content.split('\n').reverse();
        for (const line of lines) {
            const parts = line.split('|').map(s => s.trim());
            if (parts.length >= 2 && parts[1] === jobName) {
                return parts[0];
            }
        }
    } catch { /* ignore */ }
    return null;
}

export interface MoveDirective {
    planId: string;
    toColumn: string;
}

export async function processDeclaredMoves(workspaceRoot: string, kanbanProviderOrDb: any): Promise<{ processedCount: number; appliedCount: number; errors: string[] }> {
    const baseDir = path.join(workspaceRoot, '.switchboard', 'instructions');
    const movesDir = path.join(baseDir, 'moves');
    const appliedDir = path.join(movesDir, 'applied');

    if (!fs.existsSync(movesDir)) {
        return { processedCount: 0, appliedCount: 0, errors: [] };
    }

    let processedCount = 0;
    let appliedCount = 0;
    const errors: string[] = [];

    // Custom columns are per-workspace and live only on the board, so they are
    // resolved once here rather than baked into a literal set — otherwise a move
    // to a user-created column is rejected as invalid.
    const customColumnRefs = new Set<string>();
    try {
        const boardDb = typeof kanbanProviderOrDb?.getKanbanDb === 'function'
            ? kanbanProviderOrDb.getKanbanDb(workspaceRoot)
            : kanbanProviderOrDb?._kanbanDb ?? kanbanProviderOrDb;
        if (typeof boardDb?.getAllPlans === 'function') {
            for (const p of (await boardDb.getAllPlans()) || []) {
                const col = (p as any)?.kanbanColumn;
                if (col) { customColumnRefs.add(canonColumnRef(String(col))); }
            }
        }
    } catch { /* built-ins remain the floor */ }

    try {
        const entries = await fs.promises.readdir(movesDir, { withFileTypes: true });
        for (const entry of entries) {
            if (entry.isFile() && entry.name.endsWith('.md')) {
                const filePath = path.join(movesDir, entry.name);
                const content = await fs.promises.readFile(filePath, 'utf8');
                const lines = content.split('\n');

                const directives: MoveDirective[] = [];
                let fileHasError = false;
                let fileErrorMessage = '';

                // Strict validation pass: parse directives and check plan & column existence
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('---') || trimmed.startsWith('kind:')) {
                        continue;
                    }

                    const match = trimmed.match(/^[-*]?\s*planId:\s*([^\s]+)\s+to:\s*(.+)$/i);
                    if (!match) {
                        fileHasError = true;
                        fileErrorMessage = `Malformed move line syntax: "${trimmed}"`;
                        break;
                    }

                    const planId = match[1].trim();
                    const rawColumn = match[2].trim();

                    if (!BUILTIN_COLUMN_REFS.has(canonColumnRef(rawColumn)) && !customColumnRefs.has(canonColumnRef(rawColumn))) {
                        fileHasError = true;
                        fileErrorMessage = `Invalid target column "${rawColumn}" for plan ${planId}`;
                        break;
                    }

                    directives.push({ planId, toColumn: rawColumn });
                }

                if (fileHasError) {
                    errors.push(`File ${entry.name} rejected: ${fileErrorMessage}`);
                    continue; // Skip applying any moves for this file, do NOT move to applied/
                }

                // Apply moves through the human-click card-move path.
                //
                // planId → sessionId resolution is mandatory, not defensive.
                // `KanbanProvider.moveCardToColumn(workspaceRoot, sessionId, column)`
                // is keyed on `session_id` and looks the row up with
                // `getPlanBySessionId`; handing it a planId matches no row, so the
                // move silently returns false and records as skipped. The moves
                // grammar is planId-based by design (the agent has no sessionId, and
                // file-based plans carry `session_id = ''`), so the planId must be
                // resolved here via `getPlanByPlanId` before the move is attempted.
                const now = new Date().toISOString();
                const db = kanbanProviderOrDb?._kanbanDb
                    ?? (typeof kanbanProviderOrDb?.getPlanByPlanId === 'function' ? kanbanProviderOrDb : null);
                for (const d of directives) {
                    let ok = false;
                    let reason = '';
                    try {
                        const resolver = typeof kanbanProviderOrDb?.getKanbanDb === 'function'
                            ? kanbanProviderOrDb.getKanbanDb(workspaceRoot)
                            : db;
                        const plan = typeof resolver?.getPlanByPlanId === 'function'
                            ? await resolver.getPlanByPlanId(d.planId)
                            : null;
                        if (!plan) {
                            reason = `No plan with planId ${d.planId} in this workspace`;
                        } else if (plan.sessionId && typeof kanbanProviderOrDb?.moveCardToColumn === 'function') {
                            ok = await kanbanProviderOrDb.moveCardToColumn(workspaceRoot, plan.sessionId, d.toColumn);
                            if (!ok) { reason = 'moveCardToColumn returned false'; }
                        } else if (plan.planFile && typeof kanbanProviderOrDb?.moveCardToColumnByPlanFile === 'function') {
                            // File-based plans carry session_id = '' — the plan-file
                            // keyed path is the only one that can move them.
                            ok = await kanbanProviderOrDb.moveCardToColumnByPlanFile(workspaceRoot, plan.planFile, d.toColumn);
                            if (!ok) { reason = 'moveCardToColumnByPlanFile returned false'; }
                        } else {
                            reason = 'No card-move path available on the supplied provider';
                        }
                    } catch (e: any) {
                        reason = e?.message || String(e);
                    }

                    if (ok) { appliedCount++; } else { errors.push(`${entry.name}: ${d.planId} → ${d.toColumn}: ${reason}`); }

                    // Outcome row. `recordBoardMoveRequest` is the only sanctioned
                    // writer — KanbanDatabase exposes no generic `run`/`all`, so the
                    // previous `db.run(...)` call recorded nothing at all.
                    const recorder = typeof kanbanProviderOrDb?.getKanbanDb === 'function'
                        ? kanbanProviderOrDb.getKanbanDb(workspaceRoot)
                        : db;
                    if (typeof recorder?.recordBoardMoveRequest === 'function') {
                        try {
                            await recorder.recordBoardMoveRequest(
                                entry.name, d.planId, d.toColumn, ok ? 'applied' : 'skipped', reason, now
                            );
                        } catch { /* the outcome row is a record, never the gate */ }
                    }
                }

                processedCount++;
                await fs.promises.mkdir(appliedDir, { recursive: true });
                const targetPath = path.join(appliedDir, entry.name);
                await fs.promises.rename(filePath, targetPath);
            }
        }
    } catch (e: any) {
        errors.push(`Process moves error: ${e?.message || String(e)}`);
    }

    return { processedCount, appliedCount, errors };
}

export async function ingestJobActivity(workspaceRoot: string, db: any): Promise<void> {
    if (!db) return;

    // 1. Ingest run-log appended lines into `job_runs`. RecordJobRun owns dedup.
    const runLogPath = path.join(workspaceRoot, '.switchboard', 'instructions', 'run-log.md');
    if (fs.existsSync(runLogPath)) {
        try {
            const content = await fs.promises.readFile(runLogPath, 'utf8');
            const lines = content.split('\n').filter(l => l.trim().length > 0);
            for (const line of lines) {
                if (line.startsWith('#') || line.startsWith('---')) continue;
                const parts = line.split('|').map(s => s.trim());
                if (parts.length >= 3) {
                    const ts = parts[0];
                    const job = parts[1];
                    const summary = parts.slice(2).join(' | ');
                    if (typeof db.recordJobRun === 'function') {
                        try {
                            await db.recordJobRun(ts, job, summary, line);
                        } catch { /* one bad line must not abort the sweep */ }
                    }
                }
            }
        } catch { /* non-fatal */ }
    }

    // 2. Ingest the instruction-inbox lifecycle into `job_instructions`.
    const baseDir = path.join(workspaceRoot, '.switchboard', 'instructions');
    const inboxDir = path.join(baseDir, 'inbox');
    const claimedDir = path.join(inboxDir, 'claimed');
    if (!fs.existsSync(inboxDir) || typeof db.upsertJobInstruction !== 'function') {
        return;
    }

    try {
        const STALENESS_MS = 24 * 3600 * 1000;
        const entries = await fs.promises.readdir(inboxDir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith('.md')) { continue; }

            const fileKey = `inbox/${entry.name}`;
            const claimPath = path.join(claimedDir, `${entry.name}.claim`);
            if (!fs.existsSync(claimPath)) {
                try { await db.upsertJobInstruction(fileKey, 'pending'); } catch { /* non-fatal */ }
                continue;
            }

            const claimContent = await fs.promises.readFile(claimPath, 'utf8');
            const claimedTsMatch = claimContent.match(/^claimed_ts:\s*(.+)$/m);
            const agentMatch = claimContent.match(/^agent:\s*(.+)$/m);
            const hasResult = /^result:/m.test(claimContent);

            const claimedTs = claimedTsMatch ? claimedTsMatch[1].trim() : undefined;
            const agent = agentMatch ? agentMatch[1].trim() : undefined;
            const isActive = claimedTs ? (Date.now() - new Date(claimedTs).getTime()) < STALENESS_MS : false;

            let status: 'claimed' | 'done' | 'stuck';
            let result: string | undefined;
            if (hasResult) {
                status = 'done';
                const resultMatch = claimContent.match(/^result:\s*(.+)$/m);
                result = resultMatch ? resultMatch[1].trim() : undefined;
            } else if (isActive) {
                status = 'claimed';
            } else {
                status = 'stuck';
            }

            try {
                await db.upsertJobInstruction(fileKey, status, claimedTs, agent, result);
            } catch { /* one bad item must not abort the sweep */ }
        }
    } catch { /* non-fatal */ }
}

// Default seeded standing jobs produce markdown artifacts. Jobs whose work
// product is board-advancing moves are left for the user to author explicitly;
// Switchboard does not ship a default that declares column transitions.
const LEGACY_PIPELINE_MANAGER_BODY = `---
job: pipeline-manager
schedule: daily
reads: all active columns
writes: .switchboard/instructions/moves/
---

Advance plans through workflow stages using subagents. Produce declared moves in .switchboard/instructions/moves/ specifying planId -> target column for Switchboard to validate and apply.`;

async function seedDefaultStandingJobs(standingDir: string): Promise<void> {
    const jobs = [
        {
            filename: 'notes-to-plans.md',
            content: `---
job: notes-to-plans
schedule: daily
reads: .switchboard/instructions/inbox/
writes: .switchboard/plans/
---

Read uncollected note files in .switchboard/instructions/inbox/. Transform notes and raw briefs into complete plan files in .switchboard/plans/ following Switchboard authoring conventions.`
        },
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
        }
    ];

    for (const j of jobs) {
        const p = path.join(standingDir, j.filename);
        if (!fs.existsSync(p)) {
            await fs.promises.writeFile(p, j.content, 'utf8');
        }
    }
}

async function retireLegacyPipelineManager(standingDir: string): Promise<void> {
    const p = path.join(standingDir, 'pipeline-manager.md');
    if (!fs.existsSync(p)) return;

    try {
        const current = await fs.promises.readFile(p, 'utf8');
        if (current !== LEGACY_PIPELINE_MANAGER_BODY) return;

        const retired = path.join(standingDir, 'pipeline-manager.md.retired');
        await fs.promises.rename(p, retired);
    } catch (err) {
        console.warn(`[ScheduledJobsService] Failed to retire legacy pipeline-manager.md: ${err instanceof Error ? err.message : String(err)}`);
    }
}
