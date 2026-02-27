import * as fs from 'fs';
import * as path from 'path';

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
    private readonly sessionsDir: string;
    private readonly activityLogPath: string;
    private readonly queue: QueueItem[] = [];
    private isFlushing = false;
    private flushScheduled = false;
    private static readonly MAX_RETRIES = 4;
    private static readonly BASE_BACKOFF_MS = 200;
    private static readonly MAX_STRING_LEN = 800;
    private static readonly SENSITIVE_KEY_RE = /(api[_-]?key|password|passwd|secret|token|authorization|cookie|private[_-]?key)/i;
    private static readonly AGGREGATION_WINDOW_MS = 1000;

    constructor(workspaceRoot: string) {
        this.sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
        this.activityLogPath = path.join(this.sessionsDir, 'activity.jsonl');
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
            if (!fs.existsSync(this.activityLogPath)) {
                return [];
            }

            const content = await fs.promises.readFile(this.activityLogPath, 'utf8');
            return content
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    try {
                        return JSON.parse(line) as ActivityEvent;
                    } catch {
                        return null;
                    }
                })
                .filter((event): event is ActivityEvent => !!event)
                .filter(event => event.type === 'dispatch' && String(event.payload?.dispatchId || '') === dispatchId)
                .map(event => event.payload as SessionEvent);
        } catch (error) {
            console.error(`[SessionActionLog] Failed to read log for ${dispatchId}:`, error);
            return [];
        }
    }

    async getRecentActivity(limit: number, beforeTimestamp?: string): Promise<{ events: ActivityEvent[]; hasMore: boolean; nextCursor?: string }> {
        const effectiveLimit = Math.max(1, Math.min(Number(limit) || 50, 200));
        try {
            if (!fs.existsSync(this.activityLogPath)) {
                return { events: [], hasMore: false };
            }

            const beforeMs = this._toTimestamp(beforeTimestamp);
            const parsed = (await fs.promises.readFile(this.activityLogPath, 'utf8'))
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    try {
                        return JSON.parse(line) as ActivityEvent;
                    } catch {
                        return null;
                    }
                })
                .filter((event): event is ActivityEvent => !!event)
                .filter(event => {
                    if (beforeMs === null) return true;
                    const eventMs = this._toTimestamp(event.timestamp);
                    return eventMs !== null && eventMs < beforeMs;
                })
                .sort((a, b) => (this._toTimestamp(a.timestamp) || 0) - (this._toTimestamp(b.timestamp) || 0));

            const sessionTitles = await this._readSessionTitleMap();
            // REMOVE AGGRESSIVE FILTERING: We want all events to be visible in the feed.
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
            const isUiTrigger = sourceType === 'ui_action'
                && sourcePayload.action === 'triggerAgentAction'
                && sourceSessionId.length > 0;

            if (!isUiTrigger) {
                const role = sourcePayload.role || '';
                const planTitle = sessionTitles.get(sourceSessionId) || sourceSessionId || 'System';
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
                const planTitle = sessionTitles.get(sourceSessionId) || sourceSessionId || 'System';
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
            const planTitle = sessionTitles.get(sourceSessionId) || sourceSessionId;

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
        const map = new Map<string, string>();
        try {
            if (!fs.existsSync(this.sessionsDir)) return map;
            const files = await fs.promises.readdir(this.sessionsDir);
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf8');
                    const sheet = JSON.parse(content) as Record<string, any>;
                    const sessionId = typeof sheet.sessionId === 'string' ? sheet.sessionId : '';
                    if (!sessionId) continue;
                    const title = this._derivePlanTitle(sheet);
                    if (title) map.set(sessionId, title);
                } catch {
                    // Ignore malformed run sheets.
                }
            }
        } catch {
            // Ignore title map loading failures; fallback will use session IDs.
        }
        return map;
    }

    private _derivePlanTitle(runSheet: Record<string, any>): string {
        const title = typeof runSheet.title === 'string' ? runSheet.title.trim() : '';
        if (title) return title;
        const planName = typeof runSheet.planName === 'string' ? runSheet.planName.trim() : '';
        if (planName) return planName;
        const topic = typeof runSheet.topic === 'string' ? runSheet.topic.trim() : '';
        if (topic) return topic;
        const planFile = typeof runSheet.planFile === 'string' ? runSheet.planFile.trim() : '';
        if (!planFile) return '';
        return path.basename(planFile).replace(/\.md$/i, '');
    }

    private _toTimestamp(value?: string): number | null {
        if (typeof value !== 'string' || !value) return null;
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }

    // --- Session Run Sheet Management (Decoupled from TaskViewerProvider) ---

    async createRunSheet(sessionId: string, data: any): Promise<void> {
        try {
            await fs.promises.mkdir(this.sessionsDir, { recursive: true });
            const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
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
            await fs.promises.writeFile(filePath, JSON.stringify(normalized, null, 2));
        } catch (error) {
            console.error(`[SessionActionLog] Failed to create run sheet ${sessionId}:`, error);
        }
    }

    async updateRunSheet(sessionId: string, updater: (current: any) => any): Promise<void> {
        try {
            const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
            if (!fs.existsSync(filePath)) return;

            const content = await fs.promises.readFile(filePath, 'utf8');
            const current = JSON.parse(content);
            const next = updater(current);
            if (next) {
                await fs.promises.writeFile(filePath, JSON.stringify(next, null, 2));
            }
        } catch (error) {
            console.error(`[SessionActionLog] Failed to update run sheet ${sessionId}:`, error);
        }
    }

    async getRunSheets(): Promise<any[]> {
        try {
            if (!fs.existsSync(this.sessionsDir)) return [];
            const files = await fs.promises.readdir(this.sessionsDir);
            const sheets = [];
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf8');
                    const sheet = JSON.parse(content);
                    if (sheet.completed === true) continue;
                    if (sheet.sessionId && sheet.events) {
                        sheets.push(sheet);
                    }
                } catch { }
            }
            return sheets;
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
            if (!fs.existsSync(this.sessionsDir)) return null;
            const normalizedTarget = this._normalizePlanFilePath(planFile);
            const includeCompleted = options?.includeCompleted === true;
            const files = await fs.promises.readdir(this.sessionsDir);

            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf8');
                    const sheet = JSON.parse(content);
                    if (!includeCompleted && sheet?.completed === true) continue;
                    if (typeof sheet?.planFile !== 'string') continue;
                    if (this._normalizePlanFilePath(sheet.planFile) === normalizedTarget) {
                        return sheet;
                    }
                } catch {
                    // Ignore malformed runsheets while searching.
                }
            }
        } catch (error) {
            console.error('[SessionActionLog] Failed to find runsheet by plan file:', error);
        }
        return null;
    }

    async deleteRunSheet(sessionId: string): Promise<void> {
        try {
            const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
        } catch (error) {
            console.error(`[SessionActionLog] Failed to delete run sheet ${sessionId}:`, error);
        }
    }

    async getRunSheet(sessionId: string): Promise<any | null> {
        try {
            const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
            if (fs.existsSync(filePath)) {
                const content = await fs.promises.readFile(filePath, 'utf8');
                return JSON.parse(content);
            }
        } catch (error) {
            console.error(`[SessionActionLog] Failed to get run sheet ${sessionId}:`, error);
        }
        return null;
    }

    async deleteFile(relativePath: string): Promise<void> {
        try {
            if (path.isAbsolute(relativePath) || relativePath.includes('..')) return;
            const fullPath = path.join(this.sessionsDir, relativePath);
            if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
            }
        } catch { }
    }

    async getCompletedRunSheets(): Promise<any[]> {
        try {
            if (!fs.existsSync(this.sessionsDir)) return [];
            const files = await fs.promises.readdir(this.sessionsDir);
            const sheets = [];
            for (const file of files) {
                if (!file.endsWith('.json')) continue;
                try {
                    const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf8');
                    const sheet = JSON.parse(content);
                    if (sheet.completed === true && sheet.sessionId && sheet.events) {
                        sheets.push(sheet);
                    }
                } catch { }
            }
            return sheets;
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

    async deleteDispatchLog(dispatchId: string): Promise<void> {
        try {
            const legacyPath = path.join(this.sessionsDir, `${dispatchId}.jsonl`);
            if (fs.existsSync(legacyPath)) {
                await fs.promises.unlink(legacyPath);
            }
        } catch (error) {
            console.error(`[SessionActionLog] Failed to delete dispatch log for ${dispatchId}:`, error);
        }
    }

    /**
     * Clean up old session logs based on retention policy
     */
    async cleanup(retentionHours: number): Promise<void> {
        try {
            if (!fs.existsSync(this.sessionsDir)) {
                return;
            }

            const now = Date.now();
            const cutoff = now - (retentionHours * 60 * 60 * 1000);

            const files = await fs.promises.readdir(this.sessionsDir);
            for (const file of files) {
                if (!file.endsWith('.jsonl') || file === 'activity.jsonl') continue;

                const filePath = path.join(this.sessionsDir, file);
                try {
                    const stats = await fs.promises.stat(filePath);
                    if (stats.mtimeMs < cutoff) {
                        await fs.promises.unlink(filePath);
                        console.log(`[SessionActionLog] Cleaned up old log: ${file}`);
                    }
                } catch {
                    // Ignore errors for individual files
                }
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
            await fs.promises.mkdir(this.sessionsDir, { recursive: true });

            // Log Rotation Check (5MB limit)
            try {
                if (fs.existsSync(this.activityLogPath)) {
                    const stats = await fs.promises.stat(this.activityLogPath);
                    if (stats.size > 5 * 1024 * 1024) {
                        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                        const archivePath = path.join(this.sessionsDir, `activity-${timestamp}.jsonl`);
                        await fs.promises.rename(this.activityLogPath, archivePath);
                    }
                }
            } catch (e) {
                console.error('[SessionActionLog] Log rotation failed:', e);
            }

            while (this.queue.length > 0) {
                const item = this.queue[0];
                try {
                    await fs.promises.appendFile(this.activityLogPath, `${JSON.stringify(item.event)}\n`, 'utf8');
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
