/**
 * Store-backed remote provider — a fourth `RemoteProviderKind` whose fetch
 * is a SQL read of a queue table rather than an HTTP call.
 *
 * A cloud agent with no repository access authors a plan by writing a row to
 * the `plan_inbox` table in the shared store (Turso, self-hosted sqld). The
 * store-backed provider polls the table, materialises the row to a plan file
 * (reusing the existing `*_import_${id}.md` filename convention), and imports
 * it through the file-and-import path — inheriting every guard (column
 * canonicalisation, resolve-only project semantics, feature cascade, review
 * gate) for free.
 *
 * The transport differs from every existing kind in one way that matters: the
 * other providers are polled over HTTP with their own auth; this one reads the
 * same store the board already uses. So the poll is local (or replica-local)
 * and effectively free, but a malformed queue row is inside the board's own
 * database rather than behind an API boundary. Validation happens on read,
 * not on write, and cannot be assumed.
 *
 * See `.switchboard/plans/remote-authoring-over-the-shared-store-as-a-provider-kind.md`.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';
import type { RemoteProvider, RemoteProviderCapabilities } from './remote/RemoteProvider';
import type { RemoteStateDelta } from './RemoteControlService';

export const STORE_QUEUE_TABLE = 'plan_inbox';

export interface PlanInboxRow {
    id: string;
    idempotency_key: string;
    workspace_id: string;
    title: string;
    body: string;
    provenance: string;
    status: 'pending' | 'materialised' | 'error';
    materialised_path: string;
    error: string;
    created_at: string;
    updated_at: string;
}

/**
 * Ensure the plan_inbox queue table exists in the shared store. Called
 * before the first poll. Additive and opt-in — inert without a configured
 * store target.
 */
export function ensurePlanInboxTable(db: KanbanDatabase): void {
    try {
        db.execSql(`
            CREATE TABLE IF NOT EXISTS ${STORE_QUEUE_TABLE} (
                id TEXT PRIMARY KEY,
                idempotency_key TEXT NOT NULL,
                workspace_id TEXT NOT NULL,
                title TEXT NOT NULL,
                body TEXT NOT NULL,
                provenance TEXT DEFAULT '',
                status TEXT NOT NULL DEFAULT 'pending',
                materialised_path TEXT DEFAULT '',
                error TEXT DEFAULT '',
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )
        `);
        // Index for efficient pending-status polling.
        db.execSql(`CREATE INDEX IF NOT EXISTS idx_plan_inbox_status ON ${STORE_QUEUE_TABLE} (status, created_at)`);
        // Index for idempotency key lookup.
        db.execSql(`CREATE INDEX IF NOT EXISTS idx_plan_inbox_idempotency ON ${STORE_QUEUE_TABLE} (idempotency_key)`);
    } catch (e) {
        console.error('[StoreRemoteProvider] ensurePlanInboxTable failed:', e);
    }
}

/**
 * Store-backed remote provider. Implements the `RemoteProvider` interface
 * with a SQL-read fetch against the `plan_inbox` table.
 *
 * The provider is pull-only: it reads pending rows, materialises them to plan
 * files, and marks them as materialised. It does not push state or content
 * back to the queue (the queue is an inbox, not a two-way channel).
 */
export class StoreRemoteProvider implements RemoteProvider {
    readonly kind = 'store' as any;
    readonly capabilities: RemoteProviderCapabilities = {
        canPushState: false,
        canPushContent: false,
        canPostComments: false,
        canArchive: false,
        canFetchComments: false,
        canReconcileDeletes: false,
        descriptionFetchIsInline: true,
    } as any;

    private _db: KanbanDatabase;
    private _workspaceRoot: string;
    private _plansDir: string;

    constructor(deps: { db: KanbanDatabase; workspaceRoot: string }) {
        this._db = deps.db;
        this._workspaceRoot = deps.workspaceRoot;
        this._plansDir = path.join(deps.workspaceRoot, '.switchboard', 'plans');
    }

    /**
     * Fetch pending queue rows as state deltas. Each pending row becomes a
     * delta with the row's title as the topic and body as the description.
     * The cursor is the max created_at timestamp of the last fetched row.
     */
    public async fetchStateDeltas(sinceCursor: string): Promise<{ deltas: RemoteStateDelta[]; nextCursor: string }> {
        ensurePlanInboxTable(this._db);
        try {
            const rows = this._db.querySql(
                `SELECT id, workspace_id, title, body, provenance, created_at FROM ${STORE_QUEUE_TABLE} WHERE status = 'pending' AND created_at > ? ORDER BY created_at ASC LIMIT 100`,
                [sinceCursor]
            ) as PlanInboxRow[];

            if (!rows || rows.length === 0) {
                return { deltas: [], nextCursor: sinceCursor };
            }

            const deltas: RemoteStateDelta[] = rows.map(row => ({
                remoteId: row.id,
                stateKey: 'Created',
                title: row.title,
                description: row.body,
                updatedAt: row.created_at,
                selfEdited: false,
            } as any));

            const nextCursor = rows[rows.length - 1].created_at;
            return { deltas, nextCursor };
        } catch (e) {
            console.error('[StoreRemoteProvider] fetchStateDeltas failed:', e);
            return { deltas: [], nextCursor: sinceCursor };
        }
    }

    /**
     * No comment deltas — the store-backed provider does not support comments.
     */
    public async fetchCommentDeltas(_sinceCursor: string): Promise<{ deltas: any[]; nextCursor: string }> {
        return { deltas: [], nextCursor: _sinceCursor };
    }

    /**
     * Map a state key to a local Kanban column. The store-backed provider
     * always lands plans in 'CREATED' — the review gate governs triggering,
     * not the credential.
     */
    public stateKeyToColumn(stateKey: string): string | undefined {
        if (stateKey === 'Created') { return 'CREATED'; }
        return undefined;
    }

    /**
     * Materialise a pending queue row to a plan file. Reuses the
     * `store_import_${id}.md` filename convention (following the Linear
     * path's `linear_import_${id}.md`), so a retry rewrites the same path
     * rather than creating a duplicate.
     */
    public async importRemotePlan(remoteId: string): Promise<KanbanPlanRecord | null> {
        try {
            const rows = this._db.querySql(
                `SELECT id, workspace_id, title, body, provenance FROM ${STORE_QUEUE_TABLE} WHERE id = ? AND status = 'pending'`,
                [remoteId]
            ) as PlanInboxRow[];

            if (!rows || rows.length === 0) { return null; }
            const row = rows[0];

            // Validate on read — the queue sits inside the board's own database
            // rather than behind an API boundary, so validation happens here.
            if (!row.title || !row.title.trim()) {
                this._markError(remoteId, 'Queue row has empty title');
                return null;
            }
            if (!row.workspace_id || !row.workspace_id.trim()) {
                this._markError(remoteId, 'Queue row has empty workspace_id');
                return null;
            }
            // 100 KB size guard (same as the Linear path).
            if (row.body.length > 100 * 1024) {
                this._markError(remoteId, 'Queue row body exceeds 100 KB cap');
                return null;
            }
            // Empty-body guard — never clobber with empty.
            if (!row.body || !row.body.trim()) {
                this._markError(remoteId, 'Queue row has empty body');
                return null;
            }

            // Materialise to a plan file.
            const filename = `store_import_${remoteId}.md`;
            const planPath = path.join(this._plansDir, filename);
            const content = `# ${row.title}\n\n${row.body}\n`;
            fs.mkdirSync(this._plansDir, { recursive: true });
            fs.writeFileSync(planPath, content, 'utf8');

            // Mark the row as materialised.
            this._db.runSql(
                `UPDATE ${STORE_QUEUE_TABLE} SET status = 'materialised', materialised_path = ?, updated_at = datetime('now') WHERE id = ?`,
                [path.relative(this._workspaceRoot, planPath), remoteId]
            );

            console.log(`[StoreRemoteProvider] Materialised queue row ${remoteId} to ${planPath}`);
            return null; // The import path picks it up from the file.
        } catch (e) {
            console.error('[StoreRemoteProvider] importRemotePlan failed:', e);
            this._markError(remoteId, e instanceof Error ? e.message : String(e));
            return null;
        }
    }

    /**
     * Refresh the local plan file from the queue row. Re-reads the row
     * and rewrites the file if the body has changed.
     */
    public async refreshLocalPlanFromRemote(remoteId: string): Promise<void> {
        try {
            const rows = this._db.querySql(
                `SELECT title, body FROM ${STORE_QUEUE_TABLE} WHERE id = ?`,
                [remoteId]
            ) as PlanInboxRow[];

            if (!rows || rows.length === 0) { return; }
            const row = rows[0];
            if (!row.body || !row.body.trim()) { return; } // empty-body guard

            const filename = `store_import_${remoteId}.md`;
            const planPath = path.join(this._plansDir, filename);
            const content = `# ${row.title}\n\n${row.body}\n`;
            fs.writeFileSync(planPath, content, 'utf8');
        } catch (e) {
            console.error('[StoreRemoteProvider] refreshLocalPlanFromRemote failed:', e);
        }
    }

    // ── Pull-only stubs (the queue is an inbox, not a two-way channel) ────

    public async postComment(_remoteId: string, _body: string): Promise<void> { /* no-op */ }
    public async pushState(_remoteId: string, _column: string): Promise<void> { /* no-op */ }
    public async pushContent(_remoteId: string, _markdown: string): Promise<void> { /* no-op */ }
    public async archiveCard(_remoteId: string): Promise<any> { return { ok: false, reason: 'pull-only' }; }

    private _markError(id: string, error: string): void {
        try {
            this._db.runSql(
                `UPDATE ${STORE_QUEUE_TABLE} SET status = 'error', error = ?, updated_at = datetime('now') WHERE id = ?`,
                [error, id]
            );
        } catch { /* best-effort */ }
    }
}
