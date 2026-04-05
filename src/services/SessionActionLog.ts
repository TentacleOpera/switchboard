import * as fs from 'fs';
import * as path from 'path';
import { KanbanDatabase } from './KanbanDatabase';
import { parseComplexityScore } from './complexityScale';

export interface ArchiveSpec { sourcePath: string; destPath: string; }
export interface ArchiveResult { sourcePath: string; success: boolean; error?: string; }

export interface SessionEvent {
    timestamp: string;
    dispatchId: string;
    event: 'received' | 'acknowledged' | 'heartbeat_started' | 'heartbeat_sent' | 'submit_result' | 'eta_exceeded' | 'eta_extended' | 'heartbeat_canceled';
    sender?: string;
    recipient?: string;
    action?: string;
    metadata?: Record<string, any>;
}

export interface ActivityEvent {
    timestamp: string;
    type: string;
    payload: Record<string, any>;
    correlationId?: string;
}

type QueueItem = {
    event: ActivityEvent;
    retries: number;
    resolve: () => void;
};

export class SessionActionLog {
    private readonly _workspaceRoot: string;
    private readonly queue: QueueItem[] = [];
    private isFlushing = false;
    private flushScheduled = false;
    private readonly _writeLocks = new Map<string, Promise<void>>();
    private _titleCache: Map<string, string> | null = null;
    private _titleCacheTimestamp = 0;
    private _kanbanDb: KanbanDatabase | null = null;
    private static readonly TITLE_CACHE_TTL_MS = 5_000;
    private static readonly MAX_RETRIES = 4;
    private static readonly BASE_BACKOFF_MS = 200;
    private static readonly MAX_STRING_LEN = 800;
    private static readonly SENSITIVE_KEY_RE = /(api[_-]?key|password|passwd|secret|token|authorization|cookie|private[_-]?key)/i;
    private static readonly AGGREGATION_WINDOW_MS = 1000;

    constructor(workspaceRoot: string) {
        this._workspaceRoot = workspaceRoot;
    }

    private _getDb(): KanbanDatabase {
        if (!this._kanbanDb) {
            this._kanbanDb = KanbanDatabase.forWorkspace(this._workspaceRoot);
        }
        return this._kanbanDb;
    }

    private async _ensureDbReady(): Promise<KanbanDatabase | null> {
        const db = this._getDb();
        const ready = await db.ensureReady();
        if (!ready) return null;
        return db;
    }

    async logEvent(type: string, payload: Record<string, any>, correlationId?: string): Promise<void> {
        const event: ActivityEvent = {
            timestamp: new Date().toISOString(),
            type,
            payload: this._sanitizePayload(type, payload),
            ...(correlationId ? { correlationId } : {})
        };

        await new Promise<void>((resolve) => {
            this.queue.push({ event, retries: 0, resolve });
            this._scheduleFlush();
        });
    }

    // Backward-compatible adapter for existing dispatch event calls.
    async append(event: SessionEvent): Promise<void> {
        await this.logEvent('dispatch', event as unknown as Record<string, any>);
    }

    /**
     * Read all events for a dispatch
     */
    async read(dispatchId: string): Promise<SessionEvent[]> {
        try {
            const db = await this._ensureDbReady();
            if (db) {
                const result = await db.getRecentActivity(1000);
                return result.events
                    .map((row: any) => {
                        try {
                            const parsed = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
                            return { type: row.event_type, payload: parsed };
                        } catch { return null; }
                    })
                    .filter((e: any): e is { type: string; payload: any } => !!e)
                    .filter((e: any) => e.type === 'dispatch' && String(e.payload?.dispatchId || '') === dispatchId)
                    .map((e: any) => e.payload as SessionEvent);
            }

            return [];
        } catch (error) {
            console.error(`[SessionActionLog] Failed to read log for ${dispatchId}:`, error);
            return [];
        }
    }

    async getRecentActivity(limit: number, beforeTimestamp?: string): Promise<{ events: ActivityEvent[]; hasMore: boolean; nextCursor?: string }> {
        const effectiveLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
        try {
            const db = await this._ensureDbReady();
            let parsed: ActivityEvent[];

            if (db) {
                // DB-first: fetch a generous batch of raw events, then aggregate in-memory
                const rawLimit = Math.max(effectiveLimit * 4, 400);
                const result = await db.getRecentActivity(rawLimit, beforeTimestamp);
                parsed = result.events.map((row: any) => {
                    let payload: Record<string, any> = {};
                    try { payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : (row.payload || {}); }
                    catch { /* malformed payload */ }
                    return {
                        timestamp: row.timestamp,
                        type: row.event_type,
                        payload,
                        ...(row.correlation_id ? { correlationId: row.correlation_id } : {})
                    } as ActivityEvent;
                }).sort((a: ActivityEvent, b: ActivityEvent) =>
                    (this._toTimestamp(a.timestamp) || 0) - (this._toTimestamp(b.timestamp) || 0)
                );
            } else {
                return { events: [], hasMore: false };
            }

            const sessionTitles = await this._readSessionTitleMap();
            const aggregated = this._aggregateEvents(parsed, sessionTitles)
                .sort((a, b) => (this._toTimestamp(b.timestamp) || 0) - (this._toTimestamp(a.timestamp) || 0));

            const events = aggregated.slice(0, effectiveLimit);
            const hasMore = aggregated.length > effectiveLimit;
            const nextCursor = hasMore ? events[events.length - 1]?.timestamp : undefined;
            return { events, hasMore, nextCursor };
        } catch (error) {
            console.error('[SessionActionLog] Failed to read recent activity:', error);
            return { events: [], hasMore: false };
        }
    }

    private _aggregateEvents(events: ActivityEvent[], sessionTitles: Map<string, string>): ActivityEvent[] {
        const output: ActivityEvent[] = [];
        const consumed = new Set<number>();

        for (let i = 0; i < events.length; i += 1) {
            if (consumed.has(i)) continue;
            const source = events[i];
            const sourceMs = this._toTimestamp(source.timestamp);
            if (sourceMs === null) {
                output.push(source);
                continue;
            }

            const sourcePayload = (source.payload || {}) as Record<string, any>;
            const sourceSessionId = typeof sourcePayload.sessionId === 'string' ? sourcePayload.sessionId : '';
            const sourceRole = typeof sourcePayload.role === 'string' ? sourcePayload.role : '';
            const sourceType = String(source.type || '').toLowerCase();
            if (sourceType === 'autoban_dispatch') {
                output.push(source);
                continue;
            }
            const isUiTrigger = sourceType === 'ui_action'
                && sourcePayload.action === 'triggerAgentAction'
                && sourceSessionId.length > 0;

            if (!isUiTrigger) {
                const role = sourcePayload.role || '';
                const planTitle = (typeof sourcePayload.title === 'string' && sourcePayload.title.trim())
                    || (typeof sourcePayload.topic === 'string' && sourcePayload.topic.trim())
                    || sessionTitles.get(sourceSessionId) || sourceSessionId || 'System';
                const eventName = sourcePayload.event || sourcePayload.action || sourceType;

                output.push({
                    timestamp: source.timestamp,
                    type: 'summary',
                    payload: {
                        sessionId: sourceSessionId,
                        role,
                        planTitle,
                        event: eventName,
                        message: this._buildSummaryMessage(role, eventName, planTitle, sourcePayload)
                    }
                });
                continue;
            }

            let dispatchIndex = -1;
            let sentIndex = -1;

            // Phase 1: search within the time window
            for (let j = i + 1; j < events.length; j += 1) {
                if (consumed.has(j)) continue;
                const candidate = events[j];
                const candidateMs = this._toTimestamp(candidate.timestamp);
                if (candidateMs === null) continue;
                if (candidateMs - sourceMs > SessionActionLog.AGGREGATION_WINDOW_MS) break;

                const candidateType = String(candidate.type || '').toLowerCase();
                const candidatePayload = (candidate.payload || {}) as Record<string, any>;
                const candidateSessionId = typeof candidatePayload.sessionId === 'string' ? candidatePayload.sessionId : '';
                const candidateRole = typeof candidatePayload.role === 'string' ? candidatePayload.role : '';
                const candidateEvent = String(candidatePayload.event || '').toLowerCase();
                if (candidateSessionId !== sourceSessionId) continue;
                if (sourceRole && candidateRole && sourceRole !== candidateRole) continue;
                const isDispatchLike = candidateType === 'dispatch' || candidateEvent.includes('dispatch');
                const isSentLike = candidateType === 'sent' || candidateEvent.includes('sent') || candidateEvent === 'received';
                if (!isDispatchLike && !isSentLike) continue;

                if (dispatchIndex === -1 && isDispatchLike) {
                    dispatchIndex = j;
                }
                if (sentIndex === -1 && isSentLike) {
                    sentIndex = j;
                }
                if (dispatchIndex !== -1 && sentIndex !== -1) {
                    break;
                }
            }

            // Phase 2: if still no match, use correlationId for deterministic linking (regardless of window)
            if ((dispatchIndex === -1 || sentIndex === -1) && source.correlationId) {
                for (let j = 0; j < events.length; j += 1) {
                    if (consumed.has(j) || j === i) continue;
                    const candidate = events[j];
                    if (candidate.correlationId !== source.correlationId) continue;
                    const candidateType = String(candidate.type || '').toLowerCase();
                    const candidatePayload = (candidate.payload || {}) as Record<string, any>;
                    const candidateEvent = String(candidatePayload.event || '').toLowerCase();
                    const isDispatchLike = candidateType === 'dispatch' || candidateEvent.includes('dispatch');
                    const isSentLike = candidateType === 'sent' || candidateEvent.includes('sent') || candidateEvent === 'received';
                    if (dispatchIndex === -1 && isDispatchLike) {
                        dispatchIndex = j;
                    }
                    if (sentIndex === -1 && isSentLike) {
                        sentIndex = j;
                    }
                    if (dispatchIndex !== -1 && sentIndex !== -1) {
                        break;
                    }
                }
            }

            if (dispatchIndex === -1 && sentIndex === -1) {
                const role = sourcePayload.role || '';
                const planTitle = (typeof sourcePayload.title === 'string' && sourcePayload.title.trim())
                    || (typeof sourcePayload.topic === 'string' && sourcePayload.topic.trim())
                    || sessionTitles.get(sourceSessionId) || sourceSessionId || 'System';
                const eventName = sourcePayload.event || sourcePayload.action || sourceType;

                output.push({
                    timestamp: source.timestamp,
                    type: 'summary',
                    payload: {
                        sessionId: sourceSessionId,
                        role,
                        planTitle,
                        event: eventName,
                        message: this._buildSummaryMessage(role, eventName, planTitle, sourcePayload)
                    }
                });
                continue;
            }

            const primaryIndex = sentIndex !== -1 ? sentIndex : dispatchIndex;
            const primary = events[primaryIndex];
            const primaryPayload = (primary.payload || {}) as Record<string, any>;
            consumed.add(i);
            if (dispatchIndex !== -1) consumed.add(dispatchIndex);
            if (sentIndex !== -1) consumed.add(sentIndex);
            const role = (typeof primaryPayload.role === 'string' && primaryPayload.role) || sourceRole;
            const planTitle = (typeof sourcePayload.title === 'string' && sourcePayload.title.trim())
                || (typeof sourcePayload.topic === 'string' && sourcePayload.topic.trim())
                || (typeof primaryPayload.title === 'string' && primaryPayload.title.trim())
                || (typeof primaryPayload.topic === 'string' && primaryPayload.topic.trim())
                || sessionTitles.get(sourceSessionId) || sourceSessionId;

            output.push({
                timestamp: primary.timestamp || source.timestamp,
                type: 'summary',
                payload: {
                    sessionId: sourceSessionId,
                    role,
                    planTitle,
                    event: primaryPayload.event || (sentIndex !== -1 ? 'sent' : 'dispatch'),
                    message: this._buildSummaryMessage(role, primaryPayload.event || (sentIndex !== -1 ? 'sent' : 'dispatch'), planTitle, primaryPayload)
                }
            });
        }

        return output.filter(event => event.type !== 'summary' || (event.payload as any).message);
    }

    private _buildSummaryMessage(role: string, eventName: any, planTitle: string, payload: Record<string, any> = {}): string {
        const roleLabelMap: Record<string, string> = {
            lead: 'LEAD CODER',
            coder: 'CODER',
            reviewer: 'REVIEWER',
            planner: 'PLANNER',
            team: 'TEAM',
            analyst: 'ANALYST',
            jules: 'JULES',
            system: 'SYSTEM'
        };
        const roleLabel = roleLabelMap[role] || role.toUpperCase() || 'AGENT';
        const eventValue = String(eventName || '').toLowerCase();

        let message = '';

        // Priority 1: Explicit message in payload
        if (payload.message && typeof payload.message === 'string' && payload.message.trim().length > 0) {
            message = payload.message.toUpperCase();
        }
        // Priority 2: Workflow events
        else if (eventName === 'workflow_event' || eventValue.includes('workflow')) {
            const workflow = payload.workflow || '';
            const action = (payload.action || '').toLowerCase();

            // USER REQUEST: Skip granular phase/execution events
            if (action === 'execute' || action === 'complete_workflow_phase') {
                return ''; // Return empty string to signal this event should be skipped
            }

            let descriptiveAction = action.toUpperCase().replace(/[_-]/g, ' ');
            if (action === 'delegate_task') descriptiveAction = 'STARTED HANDOFF';
            if (action === 'start_workflow') descriptiveAction = 'STARTED WORKFLOW';

            const workflowSuffix = workflow ? ` (${workflow.toUpperCase()})` : '';
            message = `${descriptiveAction}${workflowSuffix}`;
        }
        // Priority 3: Common dispatch/result events
        else if (eventValue === 'received') {
            return ''; // Suppress raw inbox delivery pings — no user value
        }
        else if (eventValue.includes('submit_result')) {
            message = `COMPLETED — ${roleLabel}`;
        }
        else if (eventValue.includes('fail')) {
            message = `FAILED — ${roleLabel}`;
        }
        else if (eventValue.includes('cancel')) {
            message = `CANCELED — ${roleLabel}`;
        }
        else if (eventValue.includes('sent') || eventValue.includes('dispatch') || eventValue.includes('trigger')) {
            message = `SENT TO ${roleLabel}`;
        }
        // Priority 4: Fallback
        else {
            message = `${eventValue.toUpperCase().replace(/[_-]/g, ' ')} — ${roleLabel}`;
        }

        // Prepend plan title if available
        const titlePrefix = planTitle && planTitle !== 'System' ? `${planTitle.toUpperCase()}: ` : '';
        return `${titlePrefix}${message}`;
    }

    private async _readSessionTitleMap(): Promise<Map<string, string>> {
        const now = Date.now();

        if (this._titleCache && (now - this._titleCacheTimestamp) < SessionActionLog.TITLE_CACHE_TTL_MS) {
            return this._titleCache;
        }

        const db = await this._ensureDbReady();
        if (db) {
            try {
                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
                if (workspaceId) {
                    const plans = await db.getAllPlans(workspaceId);
                    const titleMap = new Map<string, string>();
                    for (const plan of plans) {
                        if (plan.sessionId && plan.topic) {
                            titleMap.set(plan.sessionId, plan.topic);
                        }
                    }
                    this._titleCache = titleMap;
                    this._titleCacheTimestamp = now;
                    return titleMap;
                }
            } catch (e) {
                console.error('[SessionActionLog] Failed to read titles from DB:', e);
            }
        }

        // TECH-DEBT: DB unavailable — cache empty map to avoid repeated failures within TTL window.
        // If DB is persistently down, titles degrade to session IDs (handled by _aggregateEvents fallback).
        this._titleCache = new Map();
        this._titleCacheTimestamp = now;
        return this._titleCache;
    }

    private _derivePlanTitle(runSheet: Record<string, any>): string {
        const title = typeof runSheet.title === 'string' ? runSheet.title.trim() : '';
        if (title) return title;
        const planName = typeof runSheet.planName === 'string' ? runSheet.planName.trim() : '';
        if (planName) return planName;
        const topic = typeof runSheet.topic === 'string' ? runSheet.topic.trim() : '';
        if (topic) return topic;
        // For brain-sourced plans, extract a readable name from the source path
        const brainSourcePath = typeof runSheet.brainSourcePath === 'string' ? runSheet.brainSourcePath.trim() : '';
        if (brainSourcePath) {
            const baseName = path.basename(brainSourcePath).replace(/\.md$/i, '').replace(/\.brain$/i, '');
            if (baseName) return baseName;
        }
        const planFile = typeof runSheet.planFile === 'string' ? runSheet.planFile.trim() : '';
        if (!planFile) return '';
        return path.basename(planFile).replace(/\.md$/i, '');
    }

    private _toTimestamp(value?: string): number | null {
        if (typeof value !== 'string' || !value) return null;
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }

    // --- Session Run Sheet Management (DB-first, filesystem fallback during transition) ---

    /**
     * Hydrate a full run sheet from DB: merges plan_events + plans table metadata.
     * Returns the same shape callers historically expected from session .json files.
     */
    private async _hydrateRunSheet(sessionId: string): Promise<any | null> {
        const db = await this._ensureDbReady();
        if (!db) { return null; }

        const dbSheet = await db.getRunSheet(sessionId);
        const record = await db.getPlanBySessionId(sessionId);

        // If we have a plan record but no events yet (e.g., brain plans, custom folder plans),
        // return a minimal runsheet from the record with empty events
        if (!dbSheet) {
            if (!record) { return null; }
            return this._composeHydratedSheet(sessionId, [], record);
        }

        return this._composeHydratedSheet(sessionId, dbSheet.events, record);
    }

    private _composeHydratedSheet(sessionId: string, events: any[], record: any, fileSheet?: any): any {
        return {
            sessionId,
            events,
            planFile: record?.planFile || fileSheet?.planFile || '',
            topic: record?.topic || fileSheet?.topic || '',
            planName: record?.topic || fileSheet?.planName || fileSheet?.topic || '',
            completed: record?.status === 'completed' || fileSheet?.completed === true,
            createdAt: record?.createdAt || fileSheet?.createdAt || (events.length > 0 ? events[0].timestamp : ''),
            brainSourcePath: record?.brainSourcePath || fileSheet?.brainSourcePath || ''
        };
    }

    async createRunSheet(sessionId: string, data: any): Promise<void> {
        const tail = this._writeLocks.get(sessionId) ?? Promise.resolve();
        const next: Promise<void> = tail.then(() => this._doCreateRunSheet(sessionId, data));
        this._writeLocks.set(sessionId, next.catch(() => {}).finally(() => {
            if ((this._writeLocks.get(sessionId) as unknown) === next) {
                this._writeLocks.delete(sessionId);
            }
        }));
        return next;
    }

    private async _doCreateRunSheet(sessionId: string, data: any): Promise<void> {
        try {
            const normalized = (data && typeof data === 'object') ? { ...data } : {};
            if (typeof normalized.sessionId !== 'string' || !normalized.sessionId.trim()) {
                normalized.sessionId = sessionId;
            }
            if (!Array.isArray(normalized.events)) {
                normalized.events = [];
            }
            if (typeof normalized.createdAt !== 'string') {
                normalized.createdAt = new Date().toISOString();
            }

            const db = await this._ensureDbReady();
            if (db) {
                // Register plan record so completeMultiple / getPlanBySessionId work
                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                await db.upsertPlans([{
                    planId: sessionId,
                    sessionId,
                    topic: normalized.topic || normalized.planName || '',
                    planFile: normalized.planFile || '',
                    kanbanColumn: 'CREATED',
                    status: 'active' as const,
                    complexity: (function(c: any) {
                        const score = parseComplexityScore(String(c || ''));
                        return score > 0 ? String(score) : 'Unknown';
                    })(normalized.complexity),
                    tags: '',
                    dependencies: '',
                    workspaceId,
                    createdAt: normalized.createdAt,
                    updatedAt: normalized.createdAt,
                    lastAction: '',
                    sourceType: 'local',
                    brainSourcePath: normalized.brainSourcePath || '',
                    mirrorPath: '',
                    routedTo: '',
                    dispatchedAgent: '',
                    dispatchedIde: ''
                }]);
                if (normalized.events.length > 0) {
                    await db.migrateSessionEvents(sessionId, normalized.events);
                }
            }

        } catch (error) {
            console.error(`[SessionActionLog] Failed to create run sheet ${sessionId}:`, error);
        }
    }

    async updateRunSheet(sessionId: string, updater: (current: any) => any): Promise<void> {
        const tail = this._writeLocks.get(sessionId) ?? Promise.resolve();
        const next: Promise<void> = tail.then(() => this._doUpdateRunSheet(sessionId, updater));
        this._writeLocks.set(sessionId, next.catch(() => {}).finally(() => {
            if ((this._writeLocks.get(sessionId) as unknown) === next) {
                this._writeLocks.delete(sessionId);
            }
        }));
        return next;
    }

    private async _doUpdateRunSheet(sessionId: string, updater: (current: any) => any): Promise<void> {
        try {
            const current = await this._hydrateRunSheet(sessionId);
            if (!current) return;

            // Snapshot BEFORE calling updater — updater may mutate current in-place
            const prevEventLen = Array.isArray(current.events) ? current.events.length : 0;
            const prevCompleted = current.completed;
            const prevTopic = current.topic;

            const next = updater(current);
            if (!next) return;

            const db = await this._ensureDbReady();
            if (db) {
                // Diff events using pre-mutation snapshot
                const nextEvents = Array.isArray(next.events) ? next.events : [];
                const newEvents = nextEvents.slice(prevEventLen);
                for (const event of newEvents) {
                    await db.appendPlanEvent(sessionId, {
                        eventType: 'workflow_event',
                        workflow: event.workflow || '',
                        action: event.action || '',
                        timestamp: event.timestamp || new Date().toISOString(),
                        payload: JSON.stringify(event)
                    });
                }

                // Diff metadata using pre-mutation snapshot
                if (next.completed === true && prevCompleted !== true) {
                    await db.completeMultiple([sessionId]);
                }
                if (next.topic && next.topic !== prevTopic) {
                    await db.updateTopic(sessionId, next.topic);
                }
            }


        } catch (error) {
            console.error(`[SessionActionLog] Failed to update run sheet ${sessionId}:`, error);
        }
    }

    async getRunSheets(): Promise<any[]> {
        try {
            const db = await this._ensureDbReady();
            if (db) {
                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                if (workspaceId) {
                    const plans = await db.getActivePlans(workspaceId);
                    const results = await Promise.all(plans.map(p => this._hydrateRunSheet(p.sessionId)));
                    return results.filter(Boolean);
                }
            }

            return [];
        } catch (error) {
            console.error('[SessionActionLog] Failed to list run sheets:', error);
            return [];
        }
    }

    /**
     * Find a runsheet by plan file path, optionally including completed runsheets.
     * Path matching is normalized for separators and Windows casing.
     */
    async findRunSheetByPlanFile(planFile: string, options?: { includeCompleted?: boolean }): Promise<any | null> {
        try {
            const db = await this._ensureDbReady();
            if (db) {
                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                if (workspaceId) {
                    const record = await db.getPlanByPlanFile(planFile, workspaceId);
                    if (record) {
                        if (!options?.includeCompleted && record.status === 'completed') return null;
                        return this._hydrateRunSheet(record.sessionId);
                    }
                    return null;
                }
            }

            return null;
        } catch (error) {
            console.error('[SessionActionLog] Failed to find runsheet by plan file:', error);
        }
        return null;
    }

    async deleteRunSheet(sessionId: string): Promise<void> {
        try {
            const db = await this._ensureDbReady();
            if (db) {
                await db.deletePlanEvents(sessionId);
            }

        } catch (error) {
            console.error(`[SessionActionLog] Failed to delete run sheet ${sessionId}:`, error);
        }
    }

    async getRunSheet(sessionId: string): Promise<any | null> {
        return this._hydrateRunSheet(sessionId);
    }

    async getCompletedRunSheets(): Promise<any[]> {
        try {
            const db = await this._ensureDbReady();
            if (db) {
                const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId() || '';
                if (workspaceId) {
                    const plans = await db.getCompletedPlans(workspaceId);
                    const results = await Promise.all(plans.map(p => this._hydrateRunSheet(p.sessionId)));
                    return results.filter(Boolean);
                }
            }

            return [];
        } catch (error) {
            console.error('[SessionActionLog] Failed to list completed run sheets:', error);
            return [];
        }
    }

    async archiveFiles(files: ArchiveSpec[]): Promise<ArchiveResult[]> {
        const results: ArchiveResult[] = [];
        for (const spec of files) {
            try {
                const destDir = path.dirname(spec.destPath);
                if (!fs.existsSync(destDir)) {
                    await fs.promises.mkdir(destDir, { recursive: true });
                }
                // Handle destination collision
                let finalDest = spec.destPath;
                if (fs.existsSync(finalDest)) {
                    const ext = path.extname(finalDest);
                    const base = finalDest.slice(0, finalDest.length - ext.length);
                    const suffix = '_archived_' + new Date().toISOString().replace(/[:.]/g, '').replace('T', '').slice(0, 14);
                    finalDest = base + suffix + ext;
                }
                try {
                    await fs.promises.rename(spec.sourcePath, finalDest);
                } catch (e: any) {
                    if (e?.code === 'EXDEV') {
                        await fs.promises.copyFile(spec.sourcePath, finalDest);
                        await fs.promises.unlink(spec.sourcePath);
                    } else {
                        throw e;
                    }
                }
                results.push({ sourcePath: spec.sourcePath, success: true });
            } catch (e: any) {
                results.push({ sourcePath: spec.sourcePath, success: false, error: e?.message || String(e) });
            }
        }
        return results;
    }

    // --- End Session Run Sheet Management ---

    private _normalizePlanFilePath(planFile: string): string {
        const normalized = String(planFile || '').replace(/\\/g, '/').trim();
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }

    /**
     * Clean up old session logs based on retention policy
     */
    async cleanup(retentionHours: number): Promise<void> {
        try {
            const now = Date.now();
            const cutoffMs = now - (retentionHours * 60 * 60 * 1000);
            const cutoffIso = new Date(cutoffMs).toISOString();

            const db = await this._ensureDbReady();
            if (db) {
                await db.cleanupActivityLog(cutoffIso);
            }


        } catch (error) {
            console.error('[SessionActionLog] Cleanup failed:', error);
        }
    }

    private _scheduleFlush(): void {
        if (this.flushScheduled || this.isFlushing) return;
        this.flushScheduled = true;
        setTimeout(() => {
            this.flushScheduled = false;
            void this._flushQueue();
        }, 0);
    }

    private async _flushQueue(): Promise<void> {
        if (this.isFlushing) return;
        this.isFlushing = true;
        try {
            const db = await this._ensureDbReady();

            while (this.queue.length > 0) {
                const item = this.queue[0];
                try {
                    if (db) {
                        const success = await db.appendActivityEvent({
                            timestamp: item.event.timestamp,
                            eventType: item.event.type,
                            payload: JSON.stringify(item.event.payload),
                            correlationId: item.event.correlationId || undefined,
                            sessionId: (item.event.payload as any)?.sessionId || undefined
                        });
                        if (!success) throw new Error('DB appendActivityEvent returned false');
                    } else {
                        console.error('[SessionActionLog] DB not available, dropping event');
                    }
                    this.queue.shift();
                    item.resolve();
                } catch (error) {
                    if (item.retries >= SessionActionLog.MAX_RETRIES) {
                        console.error('[SessionActionLog] Dropping event after retries exhausted:', error);
                        this.queue.shift();
                        item.resolve();
                        continue;
                    }
                    item.retries += 1;
                    const backoffMs = Math.min(
                        SessionActionLog.BASE_BACKOFF_MS * Math.pow(2, item.retries - 1),
                        5000
                    );
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                }
            }
        } finally {
            this.isFlushing = false;
            if (this.queue.length > 0) {
                this._scheduleFlush();
            }
        }
    }

    private _sanitizePayload(type: string, payload: Record<string, any>): Record<string, any> {
        const sanitized = this._sanitizeValue(payload, 'root') as Record<string, any>;
        if (type !== 'plan_management') {
            return sanitized;
        }

        const summary: Record<string, any> = {
            operation: sanitized.operation || sanitized.action || 'update'
        };
        if (sanitized.sessionId) summary.sessionId = sanitized.sessionId;
        if (sanitized.planFile) summary.planFile = sanitized.planFile;
        if (sanitized.topic) summary.topic = sanitized.topic;

        const lineCountOf = (value: any): number | undefined => {
            if (typeof value !== 'string') return undefined;
            return value.length === 0 ? 0 : value.split(/\r?\n/).length;
        };

        const contentLineCount = lineCountOf((payload as any)?.content ?? (payload as any)?.planContent);
        if (typeof contentLineCount === 'number') {
            summary.contentLineCount = contentLineCount;
        }
        const beforeLineCount = lineCountOf((payload as any)?.beforeContent);
        const afterLineCount = lineCountOf((payload as any)?.afterContent);
        if (typeof beforeLineCount === 'number') summary.beforeLineCount = beforeLineCount;
        if (typeof afterLineCount === 'number') summary.afterLineCount = afterLineCount;

        return summary;
    }

    private _sanitizeValue(value: any, key: string): any {
        if (value === null || value === undefined) {
            return value;
        }
        if (SessionActionLog.SENSITIVE_KEY_RE.test(key)) {
            return '[REDACTED]';
        }
        if (Array.isArray(value)) {
            return value.map((entry, index) => this._sanitizeValue(entry, `${key}[${index}]`));
        }
        if (typeof value === 'object') {
            const out: Record<string, any> = {};
            for (const [childKey, childValue] of Object.entries(value)) {
                out[childKey] = this._sanitizeValue(childValue, childKey);
            }
            return out;
        }
        if (typeof value === 'string') {
            if (value.length > SessionActionLog.MAX_STRING_LEN) {
                return `${value.slice(0, SessionActionLog.MAX_STRING_LEN)}... [TRUNCATED]`;
            }
            return value;
        }
        return value;
    }
}
