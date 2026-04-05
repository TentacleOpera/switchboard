import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';

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
    dependencies: string;
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

    constructor(workspaceRoot: string, outputChannel?: vscode.OutputChannel) {
        const config = vscode.workspace.getConfiguration('switchboard');
        const configuredPath = config.get<string>('archive.dbPath', '');
        this._archivePath = this._resolveArchivePath(configuredPath, workspaceRoot);
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
            { name: 'dependencies', default: "''" },
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

        const sql = `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, complexity, workspace_id, created_at, updated_at, last_action, source_type, tags, dependencies, routed_to, dispatched_agent, dispatched_ide, archived_at, days_to_completion)
VALUES (${this._escapeDuckDb(plan.planId)}, ${this._escapeDuckDb(plan.sessionId)}, ${this._escapeDuckDb(plan.topic)}, ${this._escapeDuckDb(plan.planFile)}, ${this._escapeDuckDb(plan.kanbanColumn)}, ${this._escapeDuckDb(plan.status)}, ${this._escapeDuckDb(plan.complexity)}, ${this._escapeDuckDb(plan.workspaceId)}, ${this._escapeDuckDb(plan.createdAt)}, ${this._escapeDuckDb(plan.updatedAt)}, ${this._escapeDuckDb(plan.lastAction)}, ${this._escapeDuckDb(plan.sourceType)}, ${this._escapeDuckDb(plan.tags)}, ${this._escapeDuckDb(plan.dependencies || '')}, ${this._escapeDuckDb(plan.routedTo || '')}, ${this._escapeDuckDb(plan.dispatchedAgent || '')}, ${this._escapeDuckDb(plan.dispatchedIde || '')}, CURRENT_TIMESTAMP, ${daysToCompletion})
ON CONFLICT (plan_id) DO UPDATE SET
    status = EXCLUDED.status,
    kanban_column = EXCLUDED.kanban_column,
    updated_at = EXCLUDED.updated_at,
    last_action = EXCLUDED.last_action,
    dependencies = EXCLUDED.dependencies,
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
