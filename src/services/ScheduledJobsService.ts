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

/**
 * Directory-parameterised core of `writeInstruction`. Holds the
 * frontmatter-flatten + timestamped-filename + write-body mechanics, with
 * `dirAbs` in place of a hardcoded inbox path and `prefix` in place of the
 * literal `instr`. Writes with `{ flag: 'wx' }` (exclusive-create) and retries
 * with a fresh random up to 5 times on a same-second collision — the shipped
 * plain `writeFile` silently clobbers a collision, losing a report. Keeps
 * `flatten()` on every frontmatter value so a multi-line body cannot forge a
 * `kind:` or `from:` key.
 */
export async function writeInboxFile(dirAbs: string, req: InstructionRequest, prefix = 'instr'): Promise<InstructionWriteResult> {
    try {
        const flatten = (s: string) => String(s || '').replace(/[\r\n]+/g, ' ').trim();
        const now = new Date();
        const iso = now.toISOString();
        const compact = iso.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

        const fmLines: string[] = ['---'];
        if (req.from) fmLines.push(`from: ${flatten(req.from)}`);
        fmLines.push(`kind: ${flatten(req.kind)}`);
        if (req.planId) fmLines.push(`planId: ${flatten(req.planId)}`);
        if (req.feature) fmLines.push(`feature: ${flatten(req.feature)}`);
        fmLines.push(`created: ${iso}`);
        fmLines.push('---');
        fmLines.push('');
        fmLines.push(req.body);
        const content = fmLines.join('\n');

        for (let attempt = 0; attempt < 5; attempt++) {
            const rand = Math.floor(Math.random() * 100000).toString().padStart(5, '0');
            const filename = `${prefix}-${compact}-${flatten(req.kind)}-${rand}.md`;
            const filePath = path.join(dirAbs, filename);
            try {
                await fs.promises.writeFile(filePath, content, { encoding: 'utf8', flag: 'wx' });
                return { success: true, filePath };
            } catch (err: any) {
                if (err?.code === 'EEXIST') { continue; }
                return { success: false, error: err instanceof Error ? err.message : String(err) };
            }
        }
        return { success: false, error: 'Failed to write inbox file after 5 collision retries' };
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

export async function writeInstruction(workspaceRoot: string, req: InstructionRequest): Promise<InstructionWriteResult> {
    try {
        const baseDir = await bootstrapInstructionsDirectory(workspaceRoot);
        if (!baseDir) {
            return { success: false, error: '.switchboard directory does not exist' };
        }
        const inboxDir = path.join(baseDir, 'inbox');
        return writeInboxFile(inboxDir, req, 'instr');
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Directory-parameterised core of `isInboxItemClaimed`. Rejects a `filename`
 * containing `/`, `\`, or `..` before joining — the persona documents the call
 * to agents, so a machine-supplied name is still validated.
 */
export async function isInboxItemClaimedIn(inboxDirAbs: string, filename: string, stalenessHours = 24): Promise<boolean> {
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return false;
    }
    const claimPath = path.join(inboxDirAbs, 'claimed', `${filename}.claim`);
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

export async function isInboxItemClaimed(workspaceRoot: string, filename: string, stalenessHours = 24): Promise<boolean> {
    const inboxDir = path.join(workspaceRoot, '.switchboard', 'instructions', 'inbox');
    return isInboxItemClaimedIn(inboxDir, filename, stalenessHours);
}

/**
 * Directory-parameterised core of `claimInboxItem`. Same path-traversal guard
 * as `isInboxItemClaimedIn`.
 */
export async function claimInboxItemIn(inboxDirAbs: string, filename: string, agentId = 'external-agent'): Promise<void> {
    if (filename.includes('/') || filename.includes('\\') || filename.includes('..')) {
        return;
    }
    const claimPath = path.join(inboxDirAbs, 'claimed', `${filename}.claim`);
    const dir = path.dirname(claimPath);
    await fs.promises.mkdir(dir, { recursive: true });
    const content = `claimed_ts: ${new Date().toISOString()}\nagent: ${agentId}\n`;
    await fs.promises.writeFile(claimPath, content, 'utf8');
}

export async function claimInboxItem(workspaceRoot: string, filename: string, agentId = 'external-agent'): Promise<void> {
    const inboxDir = path.join(workspaceRoot, '.switchboard', 'instructions', 'inbox');
    return claimInboxItemIn(inboxDir, filename, agentId);
}

/**
 * One-time migration of the pre-rename `.switchboard/orchestrator/` tree to
 * `.switchboard/mission-control/`.
 *
 * The orchestrator→Mission Control rename moved this directory with no
 * migration, on the plan's premise that the feature "has not shipped" and there
 * were "no on-disk reports". Both halves were wrong: a live workspace carries
 * hundreds of `report-*.md` files here, plus `claimed/`, `inbox/` and
 * `sessions/`. Orphaning them means Mission Control never sees a finished
 * feature it was waiting on — the report is on disk, in a directory nothing
 * reads any more.
 *
 * Merge semantics, per CLAUDE.md's migration rule (import before deleting,
 * never unlink): every legacy entry that has no counterpart under the new path
 * is MOVED across; anything already present under the new name wins and its
 * legacy twin is left where it is. When the legacy tree ends up empty it is
 * removed; when entries survive (a genuine collision) the directory is renamed
 * to `orchestrator.migrated.bak` so it is out of the way but recoverable.
 *
 * Idempotent and best-effort: a missing legacy tree is a no-op, and any error
 * leaves both trees untouched rather than half-moved. Runs at most once per
 * workspace root per process — the reports bootstrap is on a hot path.
 */
const _legacyMissionControlMigrated = new Set<string>();

export function migrateLegacyOrchestratorDir(workspaceRoot: string): void {
    if (_legacyMissionControlMigrated.has(workspaceRoot)) { return; }
    _legacyMissionControlMigrated.add(workspaceRoot);
    try {
        const sbDir = path.join(workspaceRoot, '.switchboard');
        const legacyDir = path.join(sbDir, 'orchestrator');
        if (!fs.existsSync(legacyDir) || !fs.statSync(legacyDir).isDirectory()) { return; }
        const newDir = path.join(sbDir, 'mission-control');
        fs.mkdirSync(newDir, { recursive: true });
        _mergeDirInto(legacyDir, newDir);
        // Empty after the merge → remove. Otherwise park it under a .bak name so
        // a collision is recoverable rather than silently shadowed forever.
        try {
            if (fs.readdirSync(legacyDir).length === 0) {
                fs.rmdirSync(legacyDir);
            } else {
                const bak = path.join(sbDir, 'orchestrator.migrated.bak');
                if (!fs.existsSync(bak)) { fs.renameSync(legacyDir, bak); }
            }
        } catch { /* leaving the legacy dir in place is safe */ }
    } catch (err) {
        console.warn('[ScheduledJobsService] legacy orchestrator dir migration skipped:', err);
    }
}

/** Recursive move-if-absent. Directories are descended into so a partially
 *  populated destination (e.g. a `reports/` that already exists) merges rather
 *  than being skipped wholesale. */
function _mergeDirInto(fromDir: string, toDir: string): void {
    for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
        const src = path.join(fromDir, entry.name);
        const dst = path.join(toDir, entry.name);
        try {
            if (entry.isDirectory()) {
                fs.mkdirSync(dst, { recursive: true });
                _mergeDirInto(src, dst);
                try { if (fs.readdirSync(src).length === 0) { fs.rmdirSync(src); } } catch { /* keep */ }
            } else if (!fs.existsSync(dst)) {
                fs.renameSync(src, dst);
            }
        } catch { /* per-entry best effort — one bad file must not abort the rest */ }
    }
}

/**
 * Lazily creates `.switchboard/teams/<teamId>/reports/claimed/` and returns the
 * reports directory. Returns `null` when `.switchboard` is absent — same lazy
 * guard as `bootstrapInstructionsDirectory`.
 */
export async function bootstrapTeamReportsDirectory(workspaceRoot: string, teamId: string): Promise<string | null> {
    const sbDir = path.join(workspaceRoot, '.switchboard');
    if (!fs.existsSync(sbDir)) {
        // Lazy creation: do not eagerly pollute non-Switchboard workspaces
        return null;
    }
    const reportsDir = path.join(sbDir, 'teams', teamId, 'reports');
    const claimedDir = path.join(reportsDir, 'claimed');
    await fs.promises.mkdir(claimedDir, { recursive: true });
    return reportsDir;
}

/**
 * Writes a report file to `.switchboard/teams/<teamId>/reports/` using the same
 * `writeInboxFile` mechanics as Mission Control reports.
 */
export async function writeTeamReport(workspaceRoot: string, teamId: string, req: InstructionRequest): Promise<InstructionWriteResult> {
    try {
        const reportsDir = await bootstrapTeamReportsDirectory(workspaceRoot, teamId);
        if (!reportsDir) {
            return { success: false, error: '.switchboard directory does not exist' };
        }
        return writeInboxFile(reportsDir, req, 'report');
    } catch (err) {
        return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
}

/**
 * Record a host turn-end as a `plan_events` row (event_type `turn_end`,
 * action `finished` | `blocked`). Replaces the file mirror that wrote to
 * `.switchboard/mission-control/reports/` — a gitignored directory no reader
 * could reach (the box that can read it also has the API and the DB). The row
 * is indexed, joined to `plans` by `plan_id`, and pruned by
 * `RetentionService`, so the accumulation that 190 files became cannot recur.
 *
 * `planFile` is the plan's relative path (the board's stored shape); empty for
 * the queue-stall nudges that carry no card. It is resolved to the plan's UUID
 * (`plan_id`) before insert, so the `plan_events.plan_id` column stays
 * consistent with every other caller and the JOIN to `plans` works. An
 * unresolvable `planFile` (deleted card, stale path) is stored as-is — the row
 * survives its card, with `kanbanColumn: null` on read.
 *
 * `outcome` maps the same way the deleted file mirror did: `completed` →
 * `finished`, everything else → `blocked`.
 *
 * No existence gate: the row is cheap and the question a Mission Control asks
 * ("is a blocked card still blocked?") is answered by joining `plan_events`
 * to live board state, which a file could never do. Write it always.
 */
export async function recordTurnEndEvent(db: any, info: {
    planFile: string;
    outcome: 'completed' | 'blocked' | 'stalled';
    body: string;
    workspaceId?: string;
}): Promise<void> {
    if (!db || typeof db.appendPlanEventByPlanId !== 'function') return;
    const action = info.outcome === 'completed' ? 'finished' : 'blocked';
    try {
        // Resolve the relative planFile to the plan's UUID (plan_id) so the
        // plan_events.plan_id column stays consistent with every other caller
        // and the JOIN to plans works. If the card is gone (deleted/archived),
        // store the planFile as-is — the row survives with kanbanColumn: null.
        let resolvedPlanId = info.planFile || '';
        if (resolvedPlanId && typeof db.getPlanByPlanFile === 'function') {
            try {
                const wsId = info.workspaceId || (await db.getWorkspaceId?.()) || db._getWorkspaceIdFallback?.() || '';
                if (wsId) {
                    const plan = await db.getPlanByPlanFile(resolvedPlanId, wsId);
                    if (plan?.planId) { resolvedPlanId = plan.planId; }
                }
            } catch { /* resolution is best-effort — store the planFile as-is */ }
        }
        await db.appendPlanEventByPlanId(resolvedPlanId, {
            eventType: 'turn_end',
            action,
            payload: JSON.stringify({ message: info.body }),
            ...(info.workspaceId ? { workspaceId: info.workspaceId } : {}),
        });
    } catch (err) {
        // A failed record must never abort the pty send that follows. The row
        // is best-effort durable state; the live delivery is the primary channel.
        console.warn('[ScheduledJobsService] recordTurnEndEvent failed:', err);
    }
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
writes: .switchboard/plans/intake/
---

Read uncollected note files in .switchboard/instructions/inbox/. Transform notes and raw briefs into complete plan files in .switchboard/plans/intake/ following Switchboard authoring conventions.`
        },
        {
            filename: 'memo-to-plans.md',
            content: `---
job: memo-to-plans
schedule: daily
reads: .switchboard/memo.md
writes: .switchboard/plans/intake/
---

Read .switchboard/memo.md. Process each entry into a distinct plan file in .switchboard/plans/intake/ following Switchboard authoring conventions. Clear or truncate .switchboard/memo.md on completion. Omit **Project:** pin unless specified.`
        },
        {
            filename: 'nightly-code-review.md',
            content: `---
job: nightly-code-review
schedule: daily
reads: .switchboard/plans/**/*.md
writes: .switchboard/plans/intake/
---

BLOCKED on a column source. This job needs the CODED column, and the per-column
exports it used to read were deleted on 2026-09-11 with the board mirrors. The
board is now read over HTTP, which this runner cannot call — it reads the
filesystem only. Report that and stop; do not guess a column, and do not fall
back to a stale file. The plans-repo work restores a filesystem source, and this
job is repointed at it when that lands. Review each plan file for completeness and potential bugs. Append findings to the respective plan file. Do NOT move cards directly.`
        },
        {
            filename: 'research-unknowns.md',
            content: `---
job: research-unknowns
schedule: daily
reads: .switchboard/plans/**/*.md
writes: .switchboard/plans/intake/
---

BLOCKED on a column source — see nightly-code-review. This job needs the CREATED
column and no filesystem source for column state currently exists. Report that
and stop.

When a source exists again: scan new plans in CREATED. Identify ## Uncertain Assumptions. Dispatch your own research sub-agents to resolve each unknown, then rewrite ## Uncertain Assumptions in place with findings.`
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
