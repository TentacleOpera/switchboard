"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionActionLog = void 0;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
class SessionActionLog {
    sessionsDir;
    activityLogPath;
    queue = [];
    isFlushing = false;
    flushScheduled = false;
    _writeLocks = new Map();
    _titleCache = null;
    _titleCacheTimestamp = 0;
    _archiveTitleCache = new Map();
    _archiveTitleCacheLoaded = false;
    static TITLE_CACHE_TTL_MS = 5_000;
    static MAX_RETRIES = 4;
    static BASE_BACKOFF_MS = 200;
    static MAX_STRING_LEN = 800;
    static SENSITIVE_KEY_RE = /(api[_-]?key|password|passwd|secret|token|authorization|cookie|private[_-]?key)/i;
    static AGGREGATION_WINDOW_MS = 1000;
    constructor(workspaceRoot) {
        this.sessionsDir = path.join(workspaceRoot, '.switchboard', 'sessions');
        this.activityLogPath = path.join(this.sessionsDir, 'activity.jsonl');
    }
    async logEvent(type, payload, correlationId) {
        const event = {
            timestamp: new Date().toISOString(),
            type,
            payload: this._sanitizePayload(type, payload),
            ...(correlationId ? { correlationId } : {})
        };
        await new Promise((resolve) => {
            this.queue.push({ event, retries: 0, resolve });
            this._scheduleFlush();
        });
    }
    // Backward-compatible adapter for existing dispatch event calls.
    async append(event) {
        await this.logEvent('dispatch', event);
    }
    /**
     * Read all events for a dispatch
     */
    async read(dispatchId) {
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
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            })
                .filter((event) => !!event)
                .filter(event => event.type === 'dispatch' && String(event.payload?.dispatchId || '') === dispatchId)
                .map(event => event.payload);
        }
        catch (error) {
            console.error(`[SessionActionLog] Failed to read log for ${dispatchId}:`, error);
            return [];
        }
    }
    async getRecentActivity(limit, beforeTimestamp) {
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
                    return JSON.parse(line);
                }
                catch {
                    return null;
                }
            })
                .filter((event) => !!event)
                .filter(event => {
                if (beforeMs === null)
                    return true;
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
        }
        catch (error) {
            console.error('[SessionActionLog] Failed to read recent activity:', error);
            return { events: [], hasMore: false };
        }
    }
    _aggregateEvents(events, sessionTitles) {
        const output = [];
        const consumed = new Set();
        for (let i = 0; i < events.length; i += 1) {
            if (consumed.has(i))
                continue;
            const source = events[i];
            const sourceMs = this._toTimestamp(source.timestamp);
            if (sourceMs === null) {
                output.push(source);
                continue;
            }
            const sourcePayload = (source.payload || {});
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
                if (consumed.has(j))
                    continue;
                const candidate = events[j];
                const candidateMs = this._toTimestamp(candidate.timestamp);
                if (candidateMs === null)
                    continue;
                if (candidateMs - sourceMs > SessionActionLog.AGGREGATION_WINDOW_MS)
                    break;
                const candidateType = String(candidate.type || '').toLowerCase();
                const candidatePayload = (candidate.payload || {});
                const candidateSessionId = typeof candidatePayload.sessionId === 'string' ? candidatePayload.sessionId : '';
                const candidateRole = typeof candidatePayload.role === 'string' ? candidatePayload.role : '';
                const candidateEvent = String(candidatePayload.event || '').toLowerCase();
                if (candidateSessionId !== sourceSessionId)
                    continue;
                if (sourceRole && candidateRole && sourceRole !== candidateRole)
                    continue;
                const isDispatchLike = candidateType === 'dispatch' || candidateEvent.includes('dispatch');
                const isSentLike = candidateType === 'sent' || candidateEvent.includes('sent') || candidateEvent === 'received';
                if (!isDispatchLike && !isSentLike)
                    continue;
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
                    if (consumed.has(j) || j === i)
                        continue;
                    const candidate = events[j];
                    if (candidate.correlationId !== source.correlationId)
                        continue;
                    const candidateType = String(candidate.type || '').toLowerCase();
                    const candidatePayload = (candidate.payload || {});
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
            const primaryPayload = (primary.payload || {});
            consumed.add(i);
            if (dispatchIndex !== -1)
                consumed.add(dispatchIndex);
            if (sentIndex !== -1)
                consumed.add(sentIndex);
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
        return output.filter(event => event.type !== 'summary' || event.payload.message);
    }
    _buildSummaryMessage(role, eventName, planTitle, payload = {}) {
        const roleLabelMap = {
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
            if (action === 'delegate_task')
                descriptiveAction = 'STARTED HANDOFF';
            if (action === 'start_workflow')
                descriptiveAction = 'STARTED WORKFLOW';
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
    async _readSessionTitleMap() {
        // Return cached map if still fresh (active titles only need refresh)
        if (this._titleCache && (Date.now() - this._titleCacheTimestamp) < SessionActionLog.TITLE_CACHE_TTL_MS) {
            return this._titleCache;
        }
        // Start with the indefinite archive cache as the base
        const map = new Map(this._archiveTitleCache);
        // Load newly archived session titles dynamically
        const archiveDir = path.join(path.dirname(this.sessionsDir), 'archive', 'sessions');
        try {
            if (fs.existsSync(archiveDir)) {
                const archiveFiles = await fs.promises.readdir(archiveDir);
                for (const file of archiveFiles) {
                    if (!file.endsWith('.json'))
                        continue;
                    const sessionId = file.slice(0, -5);
                    if (this._archiveTitleCache.has(sessionId))
                        continue;
                    try {
                        const content = await fs.promises.readFile(path.join(archiveDir, file), 'utf8');
                        const sheet = JSON.parse(content);
                        const derivedId = typeof sheet.sessionId === 'string' ? sheet.sessionId : sessionId;
                        if (!derivedId)
                            continue;
                        const title = this._derivePlanTitle(sheet);
                        if (title) {
                            this._archiveTitleCache.set(derivedId, title);
                            map.set(derivedId, title);
                        }
                        else {
                            this._archiveTitleCache.set(derivedId, derivedId); // Cache missing titles too so we don't re-read
                        }
                    }
                    catch {
                        // Ignore malformed archived run sheets, but mark as processed so we don't retry forever
                        this._archiveTitleCache.set(sessionId, sessionId);
                    }
                }
            }
        }
        catch {
            // Ignore archive directory read failures.
        }
        // Always re-read active sessions (5-second TTL)
        try {
            if (fs.existsSync(this.sessionsDir)) {
                const files = await fs.promises.readdir(this.sessionsDir);
                for (const file of files) {
                    if (!file.endsWith('.json'))
                        continue;
                    try {
                        const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf8');
                        const sheet = JSON.parse(content);
                        const sessionId = typeof sheet.sessionId === 'string' ? sheet.sessionId : '';
                        if (!sessionId)
                            continue;
                        const title = this._derivePlanTitle(sheet);
                        // Active sessions override archived ones (prioritize active)
                        if (title)
                            map.set(sessionId, title);
                    }
                    catch {
                        // Ignore malformed run sheets.
                    }
                }
            }
        }
        catch {
            // Ignore title map loading failures; fallback will use session IDs.
        }
        this._titleCache = map;
        this._titleCacheTimestamp = Date.now();
        return map;
    }
    _derivePlanTitle(runSheet) {
        const title = typeof runSheet.title === 'string' ? runSheet.title.trim() : '';
        if (title)
            return title;
        const planName = typeof runSheet.planName === 'string' ? runSheet.planName.trim() : '';
        if (planName)
            return planName;
        const topic = typeof runSheet.topic === 'string' ? runSheet.topic.trim() : '';
        if (topic)
            return topic;
        // For brain-sourced plans, extract a readable name from the source path
        const brainSourcePath = typeof runSheet.brainSourcePath === 'string' ? runSheet.brainSourcePath.trim() : '';
        if (brainSourcePath) {
            const baseName = path.basename(brainSourcePath).replace(/\.md$/i, '').replace(/\.brain$/i, '');
            if (baseName)
                return baseName;
        }
        const planFile = typeof runSheet.planFile === 'string' ? runSheet.planFile.trim() : '';
        if (!planFile)
            return '';
        return path.basename(planFile).replace(/\.md$/i, '');
    }
    _toTimestamp(value) {
        if (typeof value !== 'string' || !value)
            return null;
        const ms = Date.parse(value);
        return Number.isFinite(ms) ? ms : null;
    }
    // --- Session Run Sheet Management (Decoupled from TaskViewerProvider) ---
    async createRunSheet(sessionId, data) {
        const tail = this._writeLocks.get(sessionId) ?? Promise.resolve();
        const next = tail.then(() => this._doCreateRunSheet(sessionId, data));
        this._writeLocks.set(sessionId, next.catch(() => { }).finally(() => {
            if (this._writeLocks.get(sessionId) === next) {
                this._writeLocks.delete(sessionId);
            }
        }));
        return next;
    }
    async _doCreateRunSheet(sessionId, data) {
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
        }
        catch (error) {
            console.error(`[SessionActionLog] Failed to create run sheet ${sessionId}:`, error);
        }
    }
    async updateRunSheet(sessionId, updater) {
        const tail = this._writeLocks.get(sessionId) ?? Promise.resolve();
        const next = tail.then(() => this._doUpdateRunSheet(sessionId, updater));
        this._writeLocks.set(sessionId, next.catch(() => { }).finally(() => {
            if (this._writeLocks.get(sessionId) === next) {
                this._writeLocks.delete(sessionId);
            }
        }));
        return next;
    }
    async _doUpdateRunSheet(sessionId, updater) {
        try {
            const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
            if (!fs.existsSync(filePath))
                return;
            const content = await fs.promises.readFile(filePath, 'utf8');
            const current = JSON.parse(content);
            const next = updater(current);
            if (next) {
                await fs.promises.writeFile(filePath, JSON.stringify(next, null, 2));
            }
        }
        catch (error) {
            console.error(`[SessionActionLog] Failed to update run sheet ${sessionId}:`, error);
        }
    }
    async getRunSheets() {
        try {
            if (!fs.existsSync(this.sessionsDir))
                return [];
            const files = await fs.promises.readdir(this.sessionsDir);
            const sheets = [];
            for (const file of files) {
                if (!file.endsWith('.json'))
                    continue;
                try {
                    const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf8');
                    const sheet = JSON.parse(content);
                    if (sheet.completed === true)
                        continue;
                    if (sheet.sessionId && sheet.events) {
                        sheets.push(sheet);
                    }
                }
                catch { }
            }
            return sheets;
        }
        catch (error) {
            console.error('[SessionActionLog] Failed to list run sheets:', error);
            return [];
        }
    }
    /**
     * Find a runsheet by plan file path, optionally including completed runsheets.
     * Path matching is normalized for separators and Windows casing.
     */
    async findRunSheetByPlanFile(planFile, options) {
        try {
            if (!fs.existsSync(this.sessionsDir))
                return null;
            const normalizedTarget = this._normalizePlanFilePath(planFile);
            const includeCompleted = options?.includeCompleted === true;
            const files = await fs.promises.readdir(this.sessionsDir);
            for (const file of files) {
                if (!file.endsWith('.json'))
                    continue;
                try {
                    const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf8');
                    const sheet = JSON.parse(content);
                    if (!includeCompleted && sheet?.completed === true)
                        continue;
                    if (typeof sheet?.planFile !== 'string')
                        continue;
                    if (this._normalizePlanFilePath(sheet.planFile) === normalizedTarget) {
                        return sheet;
                    }
                }
                catch {
                    // Ignore malformed runsheets while searching.
                }
            }
        }
        catch (error) {
            console.error('[SessionActionLog] Failed to find runsheet by plan file:', error);
        }
        return null;
    }
    async deleteRunSheet(sessionId) {
        try {
            const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
            if (fs.existsSync(filePath)) {
                await fs.promises.unlink(filePath);
            }
        }
        catch (error) {
            console.error(`[SessionActionLog] Failed to delete run sheet ${sessionId}:`, error);
        }
    }
    async getRunSheet(sessionId) {
        try {
            const filePath = path.join(this.sessionsDir, `${sessionId}.json`);
            if (fs.existsSync(filePath)) {
                const content = await fs.promises.readFile(filePath, 'utf8');
                return JSON.parse(content);
            }
        }
        catch (error) {
            console.error(`[SessionActionLog] Failed to get run sheet ${sessionId}:`, error);
        }
        return null;
    }
    async deleteFile(relativePath) {
        try {
            if (path.isAbsolute(relativePath) || relativePath.includes('..'))
                return;
            const fullPath = path.join(this.sessionsDir, relativePath);
            if (fs.existsSync(fullPath)) {
                await fs.promises.unlink(fullPath);
            }
        }
        catch { }
    }
    async getCompletedRunSheets() {
        try {
            if (!fs.existsSync(this.sessionsDir))
                return [];
            const files = await fs.promises.readdir(this.sessionsDir);
            const sheets = [];
            for (const file of files) {
                if (!file.endsWith('.json'))
                    continue;
                try {
                    const content = await fs.promises.readFile(path.join(this.sessionsDir, file), 'utf8');
                    const sheet = JSON.parse(content);
                    if (sheet.completed === true && sheet.sessionId && sheet.events) {
                        sheets.push(sheet);
                    }
                }
                catch { }
            }
            return sheets;
        }
        catch (error) {
            console.error('[SessionActionLog] Failed to list completed run sheets:', error);
            return [];
        }
    }
    async archiveFiles(files) {
        const results = [];
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
                }
                catch (e) {
                    if (e?.code === 'EXDEV') {
                        await fs.promises.copyFile(spec.sourcePath, finalDest);
                        await fs.promises.unlink(spec.sourcePath);
                    }
                    else {
                        throw e;
                    }
                }
                results.push({ sourcePath: spec.sourcePath, success: true });
            }
            catch (e) {
                results.push({ sourcePath: spec.sourcePath, success: false, error: e?.message || String(e) });
            }
        }
        return results;
    }
    // --- End Session Run Sheet Management ---
    _normalizePlanFilePath(planFile) {
        const normalized = String(planFile || '').replace(/\\/g, '/').trim();
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    }
    async deleteDispatchLog(dispatchId) {
        try {
            const legacyPath = path.join(this.sessionsDir, `${dispatchId}.jsonl`);
            if (fs.existsSync(legacyPath)) {
                await fs.promises.unlink(legacyPath);
            }
        }
        catch (error) {
            console.error(`[SessionActionLog] Failed to delete dispatch log for ${dispatchId}:`, error);
        }
    }
    /**
     * Clean up old session logs based on retention policy
     */
    async cleanup(retentionHours) {
        try {
            if (!fs.existsSync(this.sessionsDir)) {
                return;
            }
            const now = Date.now();
            const cutoff = now - (retentionHours * 60 * 60 * 1000);
            const files = await fs.promises.readdir(this.sessionsDir);
            for (const file of files) {
                if (!file.endsWith('.jsonl') || file === 'activity.jsonl')
                    continue;
                const filePath = path.join(this.sessionsDir, file);
                try {
                    const stats = await fs.promises.stat(filePath);
                    if (stats.mtimeMs < cutoff) {
                        await fs.promises.unlink(filePath);
                        console.log(`[SessionActionLog] Cleaned up old log: ${file}`);
                    }
                }
                catch {
                    // Ignore errors for individual files
                }
            }
        }
        catch (error) {
            console.error('[SessionActionLog] Cleanup failed:', error);
        }
    }
    _scheduleFlush() {
        if (this.flushScheduled || this.isFlushing)
            return;
        this.flushScheduled = true;
        setTimeout(() => {
            this.flushScheduled = false;
            void this._flushQueue();
        }, 0);
    }
    async _flushQueue() {
        if (this.isFlushing)
            return;
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
            }
            catch (e) {
                console.error('[SessionActionLog] Log rotation failed:', e);
            }
            while (this.queue.length > 0) {
                const item = this.queue[0];
                try {
                    await fs.promises.appendFile(this.activityLogPath, `${JSON.stringify(item.event)}\n`, 'utf8');
                    this.queue.shift();
                    item.resolve();
                }
                catch (error) {
                    if (item.retries >= SessionActionLog.MAX_RETRIES) {
                        console.error('[SessionActionLog] Dropping event after retries exhausted:', error);
                        this.queue.shift();
                        item.resolve();
                        continue;
                    }
                    item.retries += 1;
                    const backoffMs = Math.min(SessionActionLog.BASE_BACKOFF_MS * Math.pow(2, item.retries - 1), 5000);
                    await new Promise(resolve => setTimeout(resolve, backoffMs));
                }
            }
        }
        finally {
            this.isFlushing = false;
            if (this.queue.length > 0) {
                this._scheduleFlush();
            }
        }
    }
    _sanitizePayload(type, payload) {
        const sanitized = this._sanitizeValue(payload, 'root');
        if (type !== 'plan_management') {
            return sanitized;
        }
        const summary = {
            operation: sanitized.operation || sanitized.action || 'update'
        };
        if (sanitized.sessionId)
            summary.sessionId = sanitized.sessionId;
        if (sanitized.planFile)
            summary.planFile = sanitized.planFile;
        if (sanitized.topic)
            summary.topic = sanitized.topic;
        const lineCountOf = (value) => {
            if (typeof value !== 'string')
                return undefined;
            return value.length === 0 ? 0 : value.split(/\r?\n/).length;
        };
        const contentLineCount = lineCountOf(payload?.content ?? payload?.planContent);
        if (typeof contentLineCount === 'number') {
            summary.contentLineCount = contentLineCount;
        }
        const beforeLineCount = lineCountOf(payload?.beforeContent);
        const afterLineCount = lineCountOf(payload?.afterContent);
        if (typeof beforeLineCount === 'number')
            summary.beforeLineCount = beforeLineCount;
        if (typeof afterLineCount === 'number')
            summary.afterLineCount = afterLineCount;
        return summary;
    }
    _sanitizeValue(value, key) {
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
            const out = {};
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
exports.SessionActionLog = SessionActionLog;
//# sourceMappingURL=SessionActionLog.js.map