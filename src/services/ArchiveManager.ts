import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveArchiveDbPath, validateGlobalDbPath } from './globalStore';
import { resolveCanonicalWorkspaceIdSync } from './WorkspaceIdentityService';

const execFileAsync = promisify(execFile);

export interface PlanRecord {
    planId: string;
    sessionId: string;
    topic: string;
    planFile: string;
    kanbanColumn: string;
    status: string;
    complexity: string;
    workspaceId: string;
    createdAt: string;
    updatedAt: string;
    lastAction: string;
    sourceType: string;
    tags: string;
    routedTo: string;
    dispatchedAgent: string;
    dispatchedIde: string;
}

export interface ReviewOutcome {
    reviewId: string;
    planId: string;
    sessionId: string;
    complexityAtRouting: string;
    routedTo: string;
    dispatchedAgent: string;
    dispatchedIde: string;
    criticalCount: number;
    majorCount: number;
    nitCount: number;
    reviewPass: boolean;
    parserConfidence: 'high' | 'low';
}

export class ArchiveManager {
    private _archivePath: string | null;
    private _outputChannel?: vscode.OutputChannel;

    constructor(workspaceRoot?: string, outputChannel?: vscode.OutputChannel, explicitArchivePath?: string) {
        if (explicitArchivePath && explicitArchivePath.trim()) {
            this._archivePath = path.resolve(explicitArchivePath.trim());
        } else {
            let configuredPath = '';
            try {
                const config = vscode.workspace.getConfiguration('switchboard');
                configuredPath = config.get<string>('archive.dbPath', '') || '';
            } catch {
                // Standalone / headless mode outside VS Code
                configuredPath = process.env.SWITCHBOARD_ARCHIVE_DB_PATH || '';
            }
            this._archivePath = this._resolveArchivePath(configuredPath, workspaceRoot || process.cwd()) || resolveArchiveDbPath(resolveCanonicalWorkspaceIdSync(workspaceRoot || process.cwd()).value);
        }
        this._outputChannel = outputChannel;
    }

    public get archivePath(): string | null {
        return this._archivePath;
    }

    public get isConfigured(): boolean {
        return this._archivePath !== null && this._archivePath.length > 0;
    }

    /**
     * Check if DuckDB CLI is installed and return version
     */
    public async checkDuckDbCli(): Promise<{ installed: boolean; version?: string }> {
        try {
            const { stdout } = await execFileAsync('duckdb', ['--version']);
            return { installed: true, version: stdout.trim() };
        } catch {
            return { installed: false };
        }
    }

    /**
     * Initialize the archive database with schema
     */
    public async ensureArchiveSchema(): Promise<boolean> {
        if (!this._archivePath) { return false; }

        const cli = await this.checkDuckDbCli();
        if (!cli.installed) {
            this._log('DuckDB CLI not installed. Archive operations unavailable.');
            return false;
        }

        // Ensure directory exists
        const dir = path.dirname(this._archivePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        // Read and execute schema
        const schemaPath = path.join(__dirname, 'archiveSchema.sql');
        if (!fs.existsSync(schemaPath)) {
            this._log(`Archive schema not found at ${schemaPath}`);
            return false;
        }

        try {
            const schema = fs.readFileSync(schemaPath, 'utf8');
            await execFileAsync('duckdb', [this._archivePath, '-c', schema]);
            this._log(`Archive schema initialized at ${this._archivePath}`);
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this._log(`Failed to initialize archive schema: ${msg}`);
            return false;
        }

        // Ensure new columns exist on legacy archives
        const newDispatchCols = [
            { name: 'routed_to', default: "''" },
            { name: 'dispatched_agent', default: "''" },
            { name: 'dispatched_ide', default: "''" },
        ];
        for (const col of newDispatchCols) {
            try {
                const checkCol = `SELECT column_name FROM information_schema.columns WHERE table_name = 'plans' AND column_name = '${col.name}'`;
                const { stdout } = await execFileAsync('duckdb', [this._archivePath, '-c', checkCol, '-csv', '-noheader']);
                if (!stdout.trim()) {
                    await execFileAsync('duckdb', [this._archivePath, '-c',
                        `ALTER TABLE plans ADD COLUMN ${col.name} VARCHAR DEFAULT ${col.default}`
                    ]);
                    this._log(`Archive migration: added ${col.name} column`);
                }
            } catch { /* Non-critical */ }
        }

        // Backfill routed_to from kanban_column for existing rows
        try {
            await execFileAsync('duckdb', [this._archivePath, '-c',
                `UPDATE plans SET routed_to = CASE
                    WHEN kanban_column = 'CODER CODED' THEN 'coder'
                    WHEN kanban_column = 'LEAD CODED' THEN 'lead'
                    WHEN kanban_column = 'INTERN CODED' THEN 'intern'
                    ELSE '' END
                WHERE (routed_to IS NULL OR routed_to = '') AND kanban_column IS NOT NULL`
            ]);
        } catch { /* Non-critical — backfill is best-effort */ }

        return true;
    }

    /**
     * Archive a completed plan to DuckDB
     */
    public async archivePlan(plan: PlanRecord): Promise<boolean> {
        if (!this._archivePath) { return false; }

        const cli = await this.checkDuckDbCli();
        if (!cli.installed) { return false; }

        await this.ensureArchiveSchema();

        const daysToCompletion = this._computeDaysToCompletion(plan.createdAt, plan.updatedAt);

        const sql = `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, complexity, workspace_id, created_at, updated_at, last_action, source_type, tags, routed_to, dispatched_agent, dispatched_ide, archived_at, days_to_completion)
VALUES (${this._escapeDuckDb(plan.planId)}, ${this._escapeDuckDb(plan.sessionId)}, ${this._escapeDuckDb(plan.topic)}, ${this._escapeDuckDb(plan.planFile)}, ${this._escapeDuckDb(plan.kanbanColumn)}, ${this._escapeDuckDb(plan.status)}, ${this._escapeDuckDb(plan.complexity)}, ${this._escapeDuckDb(plan.workspaceId)}, ${this._escapeDuckDb(plan.createdAt)}, ${this._escapeDuckDb(plan.updatedAt)}, ${this._escapeDuckDb(plan.lastAction)}, ${this._escapeDuckDb(plan.sourceType)}, ${this._escapeDuckDb(plan.tags)}, ${this._escapeDuckDb(plan.routedTo || '')}, ${this._escapeDuckDb(plan.dispatchedAgent || '')}, ${this._escapeDuckDb(plan.dispatchedIde || '')}, CURRENT_TIMESTAMP, ${daysToCompletion})
ON CONFLICT (plan_id) DO UPDATE SET
    status = EXCLUDED.status,
    kanban_column = EXCLUDED.kanban_column,
    updated_at = EXCLUDED.updated_at,
    last_action = EXCLUDED.last_action,
    routed_to = EXCLUDED.routed_to,
    dispatched_agent = EXCLUDED.dispatched_agent,
    dispatched_ide = EXCLUDED.dispatched_ide,
    archived_at = CURRENT_TIMESTAMP,
    days_to_completion = EXCLUDED.days_to_completion,
    revision_count = plans.revision_count + 1`;

        try {
            // Use execFile with arguments array to prevent shell injection
            await execFileAsync('duckdb', [this._archivePath, '-c', sql]);
            this._log(`Archived plan: ${plan.topic} (${plan.planId})`);
            return true;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this._log(`Failed to archive plan ${plan.planId}: ${msg}`);
            return false;
        }
    }

    /**
     * Query the archive database (read-only, SELECT only)
     */
    public async queryArchive(sql: string, limit: number = 100): Promise<unknown[]> {
        if (!this._archivePath) {
            throw new Error('Archive not configured. Set switchboard.archive.dbPath in settings.');
        }

        if (!fs.existsSync(this._archivePath)) {
            throw new Error('Archive database not found. Complete some plans first.');
        }

        // Security: only allow SELECT statements
        const trimmed = sql.trim().toUpperCase();
        if (!trimmed.startsWith('SELECT')) {
            throw new Error('Only SELECT queries are allowed on the archive.');
        }

        // Security: block dangerous keywords (word-boundary match to avoid
        // false positives on column names like updated_at, created_at, etc.)
        const blocked = ['COPY', 'ATTACH', 'DETACH', 'EXPORT', 'IMPORT', 'INSTALL', 'LOAD', 'CALL', 'PRAGMA', 'CREATE', 'DROP', 'ALTER', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE'];
        for (const keyword of blocked) {
            if (new RegExp(`\\b${keyword}\\b`).test(trimmed)) {
                throw new Error(`Blocked keyword "${keyword}" detected in query.`);
            }
        }

        // Strip semicolons (defense-in-depth against statement chaining)
        const cleaned = sql.replace(/;/g, '');
        // Strip any existing LIMIT clause to avoid double-LIMIT syntax errors
        const withoutLimit = cleaned.replace(/\bLIMIT\s+\d+\s*$/i, '').trim();
        const limitedSql = `${withoutLimit} LIMIT ${limit}`;

        try {
            // Use -readonly flag and execFile (not exec) for security
            const { stdout } = await execFileAsync('duckdb', [
                '-readonly',
                '-json',
                this._archivePath,
                limitedSql
            ]);
            return JSON.parse(stdout || '[]');
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            throw new Error(`Query failed: ${msg}`);
        }
    }

    public static parseReviewSeverity(planContent: string): {
        criticalCount: number;
        majorCount: number;
        nitCount: number;
        reviewPass: boolean;
        parserConfidence: 'high' | 'low';
    } {
        // Try to find a bounded review section first
        const reviewSectionPattern = /^#{1,4}\s+(?:Review Results|Stage 1|Grumpy.*?Review|Adversarial.*?Review|Code Review)/im;
        const reviewMatch = planContent.match(reviewSectionPattern);

        let searchContent: string;
        let confidence: 'high' | 'low';

        if (reviewMatch && reviewMatch.index !== undefined) {
            const start = reviewMatch.index;
            const rest = planContent.slice(start + reviewMatch[0].length);
            const nextHeading = rest.match(/^#{1,2}\s+/m);
            searchContent = nextHeading && nextHeading.index !== undefined
                ? rest.slice(0, nextHeading.index)
                : rest;
            confidence = 'high';
        } else {
            searchContent = planContent;
            confidence = 'low';
        }

        const criticalCount = (searchContent.match(/\bCRITICAL\b/gi) || []).length;
        const majorCount = (searchContent.match(/\bMAJOR\b/gi) || []).length;
        const nitCount = (searchContent.match(/\bNIT\b/gi) || []).length;

        const fixPattern = /\b(?:FIXED|Applied fix|Fixed:|fix applied)\b/gi;
        const fixCount = (searchContent.match(fixPattern) || []).length;
        const reviewPass = criticalCount === 0 && majorCount === 0 && fixCount === 0;

        return { criticalCount, majorCount, nitCount, reviewPass, parserConfidence: confidence };
    }

    public async archiveReviewOutcome(outcome: ReviewOutcome): Promise<boolean> {
        if (!this._archivePath) { return false; }

        const cli = await this.checkDuckDbCli();
        if (!cli.installed) { return false; }

        await this.ensureArchiveSchema();

        const sql = `INSERT INTO review_outcomes (review_id, plan_id, session_id, complexity_at_routing, routed_to, dispatched_agent, dispatched_ide, critical_count, major_count, nit_count, review_pass, parser_confidence, reviewed_at)
VALUES (${this._escapeDuckDb(outcome.reviewId)}, ${this._escapeDuckDb(outcome.planId)}, ${this._escapeDuckDb(outcome.sessionId)}, ${this._escapeDuckDb(outcome.complexityAtRouting)}, ${this._escapeDuckDb(outcome.routedTo)}, ${this._escapeDuckDb(outcome.dispatchedAgent)}, ${this._escapeDuckDb(outcome.dispatchedIde)}, ${outcome.criticalCount}, ${outcome.majorCount}, ${outcome.nitCount}, ${outcome.reviewPass}, ${this._escapeDuckDb(outcome.parserConfidence)}, CURRENT_TIMESTAMP)
ON CONFLICT (review_id) DO UPDATE SET
    critical_count = EXCLUDED.critical_count,
    major_count = EXCLUDED.major_count,
    nit_count = EXCLUDED.nit_count,
    review_pass = EXCLUDED.review_pass,
    parser_confidence = EXCLUDED.parser_confidence,
    reviewed_at = CURRENT_TIMESTAMP`;

        try {
            await execFileAsync('duckdb', [this._archivePath, '-c', sql]);
            this._log(`Archived review outcome: ${outcome.planId} (C:${outcome.criticalCount} M:${outcome.majorCount} N:${outcome.nitCount})`);
            return true;
        } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this._log(`Failed to archive review outcome ${outcome.reviewId}: ${msg}`);
            return false;
        }
    }

    /**
     * Archive event/log rows in batches to DuckDB.
     */
    public async archivePlanEvents(events: any[]): Promise<number> {
        if (!this._archivePath || events.length === 0) return 0;
        const cli = await this.checkDuckDbCli();
        if (!cli.installed) return 0;
        await this.ensureArchiveSchema();

        let inserted = 0;
        const BATCH = 100;
        for (let i = 0; i < events.length; i += BATCH) {
            const batch = events.slice(i, i + BATCH);
            const valStrings = batch.map(e => `(
                ${Number(e.event_id)},
                ${this._escapeDuckDb(e.plan_id)},
                ${this._escapeDuckDb(e.event_type || 'workflow_event')},
                ${this._escapeDuckDb(e.workflow || '')},
                ${this._escapeDuckDb(e.action || '')},
                ${this._escapeDuckDb(e.timestamp)},
                ${this._escapeDuckDb(e.device_id || '')},
                ${this._escapeDuckDb(e.vector_clock || '')},
                ${this._escapeDuckDb(e.payload || '{}')},
                ${this._escapeDuckDb(e.workspace_id || '')},
                CURRENT_TIMESTAMP
            )`).join(',\n');

            const sql = `INSERT INTO plan_events (event_id, plan_id, event_type, workflow, action, timestamp, device_id, vector_clock, payload, workspace_id, archived_at)
            VALUES ${valStrings}
            ON CONFLICT (event_id) DO NOTHING;`;

            try {
                await execFileAsync('duckdb', [this._archivePath, '-c', sql]);
                inserted += batch.length;
            } catch (err: any) {
                this._log(`archivePlanEvents batch error: ${err?.message || err}`);
            }
        }
        return inserted;
    }

    public async archiveActivityLogs(logs: any[]): Promise<number> {
        if (!this._archivePath || logs.length === 0) return 0;
        const cli = await this.checkDuckDbCli();
        if (!cli.installed) return 0;
        await this.ensureArchiveSchema();

        let inserted = 0;
        const BATCH = 100;
        for (let i = 0; i < logs.length; i += BATCH) {
            const batch = logs.slice(i, i + BATCH);
            const valStrings = batch.map(l => `(
                ${Number(l.id)},
                ${this._escapeDuckDb(l.timestamp)},
                ${this._escapeDuckDb(l.event_type)},
                ${this._escapeDuckDb(l.payload || '{}')},
                ${this._escapeDuckDb(l.correlation_id || null)},
                ${this._escapeDuckDb(l.session_id || null)},
                ${this._escapeDuckDb(l.workspace_id || null)},
                CURRENT_TIMESTAMP
            )`).join(',\n');

            const sql = `INSERT INTO activity_log (id, timestamp, event_type, payload, correlation_id, session_id, workspace_id, archived_at)
            VALUES ${valStrings}
            ON CONFLICT (id) DO NOTHING;`;

            try {
                await execFileAsync('duckdb', [this._archivePath, '-c', sql]);
                inserted += batch.length;
            } catch (err: any) {
                this._log(`archiveActivityLogs batch error: ${err?.message || err}`);
            }
        }
        return inserted;
    }

    public async archiveJobRuns(runs: any[]): Promise<number> {
        if (!this._archivePath || runs.length === 0) return 0;
        const cli = await this.checkDuckDbCli();
        if (!cli.installed) return 0;
        await this.ensureArchiveSchema();

        let inserted = 0;
        const BATCH = 100;
        for (let i = 0; i < runs.length; i += BATCH) {
            const batch = runs.slice(i, i + BATCH);
            const valStrings = batch.map(r => `(
                ${Number(r.id)},
                ${this._escapeDuckDb(r.timestamp)},
                ${this._escapeDuckDb(r.job)},
                ${this._escapeDuckDb(r.summary)},
                ${this._escapeDuckDb(r.source || '')},
                ${this._escapeDuckDb(r.workspace_id || '')},
                CURRENT_TIMESTAMP
            )`).join(',\n');

            const sql = `INSERT INTO job_runs (id, timestamp, job, summary, source, workspace_id, archived_at)
            VALUES ${valStrings}
            ON CONFLICT (id) DO NOTHING;`;

            try {
                await execFileAsync('duckdb', [this._archivePath, '-c', sql]);
                inserted += batch.length;
            } catch (err: any) {
                this._log(`archiveJobRuns batch error: ${err?.message || err}`);
            }
        }
        return inserted;
    }

    public async archiveBoardMoveRequests(moves: any[]): Promise<number> {
        if (!this._archivePath || moves.length === 0) return 0;
        const cli = await this.checkDuckDbCli();
        if (!cli.installed) return 0;
        await this.ensureArchiveSchema();

        let inserted = 0;
        const BATCH = 100;
        for (let i = 0; i < moves.length; i += BATCH) {
            const batch = moves.slice(i, i + BATCH);
            const valStrings = batch.map(m => `(
                ${Number(m.id)},
                ${this._escapeDuckDb(m.file)},
                ${this._escapeDuckDb(m.plan_id)},
                ${this._escapeDuckDb(m.to_column)},
                ${this._escapeDuckDb(m.status)},
                ${this._escapeDuckDb(m.reason || '')},
                ${this._escapeDuckDb(m.timestamp)},
                ${this._escapeDuckDb(m.workspace_id || '')},
                CURRENT_TIMESTAMP
            )`).join(',\n');

            const sql = `INSERT INTO board_move_requests (id, file, plan_id, to_column, status, reason, timestamp, workspace_id, archived_at)
            VALUES ${valStrings}
            ON CONFLICT (id) DO NOTHING;`;

            try {
                await execFileAsync('duckdb', [this._archivePath, '-c', sql]);
                inserted += batch.length;
            } catch (err: any) {
                this._log(`archiveBoardMoveRequests batch error: ${err?.message || err}`);
            }
        }
        return inserted;
    }

    public async archiveDormantWorkspace(record: {
        workspaceId: string;
        name?: string;
        exportPath: string;
        lastActivityAt?: string;
        metadata?: any;
    }): Promise<boolean> {
        if (!this._archivePath) return false;
        const cli = await this.checkDuckDbCli();
        if (!cli.installed) return false;
        await this.ensureArchiveSchema();

        const metaJson = JSON.stringify(record.metadata || {});
        const sql = `INSERT INTO dormant_workspaces (workspace_id, name, archived_at, export_path, last_activity_at, metadata)
        VALUES (
            ${this._escapeDuckDb(record.workspaceId)},
            ${this._escapeDuckDb(record.name || '')},
            CURRENT_TIMESTAMP,
            ${this._escapeDuckDb(record.exportPath)},
            ${this._escapeDuckDb(record.lastActivityAt || null)},
            ${this._escapeDuckDb(metaJson)}
        )
        ON CONFLICT (workspace_id) DO UPDATE SET
            export_path = EXCLUDED.export_path,
            archived_at = CURRENT_TIMESTAMP,
            metadata = EXCLUDED.metadata;`;

        try {
            await execFileAsync('duckdb', [this._archivePath, '-c', sql]);
            this._log(`Archived dormant workspace: ${record.workspaceId} (${record.exportPath})`);
            return true;
        } catch (err: any) {
            this._log(`Failed to archive dormant workspace: ${err?.message || err}`);
            return false;
        }
    }

    /**
     * Verify presence of IDs in DuckDB archive table. Key to copy-verify-delete transaction.
     */
    public async verifyArchivedIds(table: string, idColumn: string, ids: (number | string)[]): Promise<(number | string)[]> {
        if (!this._archivePath || ids.length === 0) return [];
        const cli = await this.checkDuckDbCli();
        if (!cli.installed) return [];

        const verified: (number | string)[] = [];
        const isNumeric = typeof ids[0] === 'number';
        const BATCH = 200;

        for (let i = 0; i < ids.length; i += BATCH) {
            const chunk = ids.slice(i, i + BATCH);
            const idList = chunk.map(id => isNumeric ? id : this._escapeDuckDb(String(id))).join(',');
            const sql = `SELECT ${idColumn} FROM ${table} WHERE ${idColumn} IN (${idList})`;
            try {
                const { stdout } = await execFileAsync('duckdb', [
                    '-readonly',
                    '-json',
                    this._archivePath,
                    sql
                ]);
                const rows = JSON.parse(stdout || '[]');
                for (const r of rows) {
                    const val = r[idColumn];
                    if (val !== undefined && val !== null) {
                        verified.push(isNumeric ? Number(val) : String(val));
                    }
                }
            } catch (err) {
                this._log(`Failed to verify IDs in ${table}: ${err}`);
            }
        }
        return verified;
    }

    /**
     * Retrieve archived plan events for history views (opt-in archive join).
     */
    public async getArchivedPlanEvents(planId: string): Promise<any[]> {
        if (!this._archivePath || !planId) return [];
        const cli = await this.checkDuckDbCli();
        if (!cli.installed || !fs.existsSync(this._archivePath)) return [];

        const sql = `SELECT * FROM plan_events WHERE plan_id = ${this._escapeDuckDb(planId)} ORDER BY timestamp ASC`;
        try {
            const { stdout } = await execFileAsync('duckdb', [
                '-readonly',
                '-json',
                this._archivePath,
                sql
            ]);
            return JSON.parse(stdout || '[]');
        } catch (err) {
            this._log(`getArchivedPlanEvents failed: ${err}`);
            return [];
        }
    }

    /**
     * Retrieve list of dormant workspaces recorded in DuckDB archive.
     */
    public async getArchivedDormantWorkspaces(): Promise<any[]> {
        if (!this._archivePath) return [];
        const cli = await this.checkDuckDbCli();
        if (!cli.installed || !fs.existsSync(this._archivePath)) return [];

        const sql = `SELECT * FROM dormant_workspaces ORDER BY archived_at DESC`;
        try {
            const { stdout } = await execFileAsync('duckdb', [
                '-readonly',
                '-json',
                this._archivePath,
                sql
            ]);
            return JSON.parse(stdout || '[]');
        } catch (err) {
            this._log(`getArchivedDormantWorkspaces failed: ${err}`);
            return [];
        }
    }

    private _resolveArchivePath(configured: string, workspaceRoot: string): string | null {
        if (!configured || !configured.trim()) { return null; }
        let expanded = configured.trim();
        if (expanded.startsWith('~')) {
            expanded = path.join(os.homedir(), expanded.slice(1));
        }
        if (expanded.includes('{workspace}')) {
            const workspaceName = path.basename(workspaceRoot);
            expanded = expanded.replace(/\{workspace\}/g, workspaceName);
        }
        return path.isAbsolute(expanded) ? expanded : path.join(workspaceRoot, expanded);
    }

    private _escapeDuckDb(value: string | null | undefined): string {
        if (value === null || value === undefined) { return 'NULL'; }
        return `'${String(value).replace(/'/g, "''")}'`;
    }

    private _computeDaysToCompletion(createdAt: string, updatedAt: string): number {
        try {
            const start = new Date(createdAt).getTime();
            const end = new Date(updatedAt).getTime();
            if (isNaN(start) || isNaN(end)) { return 0; }
            return Math.max(0, Math.round((end - start) / (1000 * 60 * 60 * 24)));
        } catch {
            return 0;
        }
    }

    private _log(message: string): void {
        const line = `[ArchiveManager] ${message}`;
        console.log(line);
        this._outputChannel?.appendLine(line);
    }
}
