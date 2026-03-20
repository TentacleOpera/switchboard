"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PipelineOrchestrator = void 0;
const DEFAULT_INTERVAL_SECONDS = 600; // 10 minutes
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 3600;
function getNextStage(sheet) {
    const events = Array.isArray(sheet.events) ? sheet.events : [];
    const startEvents = events.filter((e) => e.action === 'start');
    const lastWorkflow = startEvents.length > 0
        ? startEvents[startEvents.length - 1].workflow
        : undefined;
    if (!lastWorkflow) {
        return { role: 'planner', instruction: 'improve-plan', label: 'Planner' };
    }
    else if (lastWorkflow === 'sidebar-review' || lastWorkflow === 'Enhanced plan' || lastWorkflow === 'Improved plan') {
        return { role: 'lead', label: 'Lead Coder' };
    }
    else if (lastWorkflow === 'handoff-lead' || lastWorkflow === 'handoff') {
        return { role: 'reviewer', label: 'Reviewer' };
    }
    else if (lastWorkflow === 'challenge' || lastWorkflow === 'reviewer-pass') {
        return 'done';
    }
    else {
        // Unknown last workflow — fall back to planner
        return { role: 'planner', instruction: 'improve-plan', label: 'Planner' };
    }
}
class PipelineOrchestrator {
    _timer;
    _secondsRemaining = 0;
    _intervalSeconds = DEFAULT_INTERVAL_SECONDS;
    _running = false;
    _paused = false;
    _isAdvancing = false;
    _lastAction;
    _pendingCount = 0;
    _onStateChange;
    _dispatchCallback;
    _getRunSheetsCallback;
    _globalState;
    constructor(onStateChange, dispatchCallback, getRunSheetsCallback, globalState) {
        this._onStateChange = onStateChange;
        this._dispatchCallback = dispatchCallback;
        this._getRunSheetsCallback = getRunSheetsCallback;
        this._globalState = globalState;
        this._intervalSeconds = this._normalizeInterval(this._globalState.get('pipeline.intervalSeconds'));
    }
    start(intervalSeconds) {
        this.stop();
        if (intervalSeconds !== undefined) {
            this._intervalSeconds = this._normalizeInterval(intervalSeconds);
        }
        this._secondsRemaining = this._intervalSeconds;
        this._running = true;
        this._paused = false;
        this._emitChange();
        this._startTick();
        // Trigger first advance immediately
        setImmediate(() => {
            if (!this._running) {
                return;
            }
            void this._advance().catch(err => console.error('[PipelineOrchestrator] Initial advance failed:', err));
        });
    }
    stop() {
        this._clearTimer();
        this._running = false;
        this._paused = false;
        this._secondsRemaining = 0;
        this._pendingCount = 0;
        this._emitChange();
    }
    pause() {
        if (!this._running || this._paused) {
            return;
        }
        this._paused = true;
        this._clearTimer();
        this._emitChange();
    }
    unpause() {
        if (!this._running || !this._paused) {
            return;
        }
        this._paused = false;
        if (this._secondsRemaining < MIN_INTERVAL_SECONDS) {
            this._secondsRemaining = MIN_INTERVAL_SECONDS;
        }
        this._startTick();
        this._emitChange();
    }
    setInterval(seconds) {
        this._intervalSeconds = this._normalizeInterval(seconds);
        if (this._running) {
            this._secondsRemaining = Math.min(this._secondsRemaining, this._intervalSeconds);
        }
        this._emitChange();
    }
    getState() {
        return {
            running: this._running,
            paused: this._paused,
            secondsRemaining: this._secondsRemaining,
            intervalSeconds: this._intervalSeconds,
            lastAction: this._lastAction,
            pendingCount: this._pendingCount,
        };
    }
    /** Restore pipeline from persisted state after webview reload. */
    async restore() {
        const wasRunning = this._globalState?.get('pipeline.running', false) ?? false;
        if (!wasRunning) {
            return;
        }
        // Verify at least one non-completed runsheet still exists.
        const sheets = await (this._getRunSheetsCallback?.() ?? Promise.resolve([]));
        const nonCompletedSheets = sheets.filter((sheet) => sheet?.completed !== true);
        if (nonCompletedSheets.length === 0) {
            this._clearPersisted();
            return;
        }
        const storedInterval = this._globalState?.get('pipeline.intervalSeconds');
        this._intervalSeconds = this._normalizeInterval(storedInterval);
        const storedRemaining = this._globalState?.get('pipeline.secondsRemaining');
        this._secondsRemaining = storedRemaining !== undefined
            ? Math.max(storedRemaining, MIN_INTERVAL_SECONDS)
            : this._intervalSeconds;
        this._running = true;
        this._paused = this._globalState?.get('pipeline.paused', false) ?? false;
        if (!this._paused) {
            this._startTick();
        }
        this._emitChange();
    }
    dispose() {
        this._clearTimer();
        this._onStateChange = undefined;
        this._dispatchCallback = undefined;
        this._getRunSheetsCallback = undefined;
    }
    // --- Private ---
    async _advance() {
        if (this._isAdvancing) {
            return;
        }
        this._isAdvancing = true;
        try {
            const sheets = await (this._getRunSheetsCallback?.() ?? Promise.resolve([]));
            const activeSheets = sheets.filter((sheet) => sheet?.completed !== true);
            // Keep running idle when there are no active plans.
            if (activeSheets.length === 0) {
                this._pendingCount = 0;
                this._secondsRemaining = this._intervalSeconds;
                return;
            }
            // Compute next stage for each active sheet, filter to pending.
            const pending = activeSheets
                .map(s => ({ sheet: s, stage: getNextStage(s) }))
                .filter(({ stage }) => stage !== 'done');
            this._pendingCount = pending.length;
            if (pending.length === 0) {
                // All active plans done — auto-stop.
                this._clearTimer();
                this._running = false;
                this._secondsRemaining = 0;
                this._emitChange();
                return;
            }
            // Pick oldest plan first
            pending.sort((a, b) => {
                const ta = new Date(a.sheet.createdAt).getTime() || 0;
                const tb = new Date(b.sheet.createdAt).getTime() || 0;
                return ta - tb;
            });
            const { sheet, stage } = pending[0];
            if (stage === 'done') {
                return;
            } // safety guard
            const sessionId = sheet.sessionId;
            const planTitle = sheet.topic || sheet.planName || sheet.title || sessionId;
            if (this._dispatchCallback) {
                await this._dispatchCallback(stage.role, sessionId, stage.instruction);
            }
            this._lastAction = { planTitle, role: stage.label, timestamp: new Date().toISOString() };
            this._secondsRemaining = this._intervalSeconds;
        }
        catch (err) {
            console.error('[PipelineOrchestrator] _advance failed:', err);
        }
        finally {
            this._isAdvancing = false;
            this._emitChange();
        }
    }
    _startTick() {
        this._clearTimer();
        this._timer = setInterval(() => {
            if (!this._running || this._isAdvancing || this._paused) {
                return;
            }
            this._secondsRemaining--;
            if (this._secondsRemaining <= 0) {
                void this._advance().catch(err => console.error('[PipelineOrchestrator] Tick advance failed:', err));
            }
            else {
                this._emitChange();
            }
        }, 1000);
    }
    _normalizeInterval(seconds) {
        if (seconds === undefined || !Number.isFinite(Number(seconds))) {
            return DEFAULT_INTERVAL_SECONDS;
        }
        return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.floor(Number(seconds))));
    }
    _clearTimer() {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
    }
    _emitChange() {
        this._persistState();
        this._onStateChange?.();
    }
    _persistState() {
        if (!this._globalState) {
            return;
        }
        const save = (key, value) => void this._globalState.update(key, value).then(undefined, (err) => console.error(`[PipelineOrchestrator] Failed to persist ${key}:`, err));
        save('pipeline.running', this._running);
        save('pipeline.paused', this._paused);
        save('pipeline.intervalSeconds', this._intervalSeconds);
        save('pipeline.secondsRemaining', this._running ? this._secondsRemaining : undefined);
    }
    _clearPersisted() {
        if (!this._globalState) {
            return;
        }
        const clear = (key) => void this._globalState.update(key, undefined).then(undefined, () => { });
        clear('pipeline.running');
        clear('pipeline.paused');
        clear('pipeline.intervalSeconds');
        clear('pipeline.secondsRemaining');
    }
}
exports.PipelineOrchestrator = PipelineOrchestrator;
//# sourceMappingURL=PipelineOrchestrator.js.map