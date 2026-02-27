import * as vscode from 'vscode';

const DEFAULT_INTERVAL_SECONDS = 600; // 10 minutes
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 3600;

export interface PipelineState {
    running: boolean;
    paused: boolean;
    secondsRemaining: number;
    intervalSeconds: number;
    lastAction?: { planTitle: string; role: string; timestamp: string };
    pendingCount: number;
}

type GetRunSheetsCallback = () => Promise<any[]>;
type DispatchCallback = (role: string, sessionId: string, instruction?: string) => Promise<void>;

function getNextStage(sheet: any): { role: string; instruction?: string; label: string } | 'done' {
    const events = Array.isArray(sheet.events) ? sheet.events : [];
    const startEvents = events.filter((e: any) => e.action === 'start');
    const lastWorkflow: string | undefined = startEvents.length > 0
        ? startEvents[startEvents.length - 1].workflow
        : undefined;

    if (!lastWorkflow) {
        return { role: 'planner', instruction: 'enhance', label: 'Planner' };
    } else if (lastWorkflow === 'sidebar-review' || lastWorkflow === 'Enhanced plan') {
        return { role: 'lead', label: 'Lead Coder' };
    } else if (lastWorkflow === 'handoff-lead' || lastWorkflow === 'handoff') {
        return { role: 'reviewer', label: 'Reviewer' };
    } else if (lastWorkflow === 'challenge') {
        return 'done';
    } else {
        // Unknown last workflow — fall back to planner
        return { role: 'planner', instruction: 'enhance', label: 'Planner' };
    }
}

export class PipelineOrchestrator {
    private _timer: NodeJS.Timeout | undefined;
    private _secondsRemaining: number = 0;
    private _intervalSeconds: number = DEFAULT_INTERVAL_SECONDS;
    private _running: boolean = false;
    private _paused: boolean = false;
    private _isAdvancing: boolean = false;
    private _lastAction?: { planTitle: string; role: string; timestamp: string };
    private _pendingCount: number = 0;

    private _onStateChange: (() => void) | undefined;
    private _dispatchCallback: DispatchCallback | undefined;
    private _getRunSheetsCallback: GetRunSheetsCallback | undefined;
    private _globalState: vscode.Memento | undefined;

    constructor(
        onStateChange: () => void,
        dispatchCallback: DispatchCallback,
        getRunSheetsCallback: GetRunSheetsCallback,
        globalState: vscode.Memento
    ) {
        this._onStateChange = onStateChange;
        this._dispatchCallback = dispatchCallback;
        this._getRunSheetsCallback = getRunSheetsCallback;
        this._globalState = globalState;
        this._intervalSeconds = this._normalizeInterval(
            this._globalState.get<number>('pipeline.intervalSeconds')
        );
    }

    start(intervalSeconds?: number): void {
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
            if (!this._running) { return; }
            void this._advance().catch(err =>
                console.error('[PipelineOrchestrator] Initial advance failed:', err));
        });
    }

    stop(): void {
        this._clearTimer();
        this._running = false;
        this._paused = false;
        this._secondsRemaining = 0;
        this._pendingCount = 0;
        this._emitChange();
    }

    pause(): void {
        if (!this._running || this._paused) { return; }
        this._paused = true;
        this._clearTimer();
        this._emitChange();
    }

    unpause(): void {
        if (!this._running || !this._paused) { return; }
        this._paused = false;
        if (this._secondsRemaining < MIN_INTERVAL_SECONDS) {
            this._secondsRemaining = MIN_INTERVAL_SECONDS;
        }
        this._startTick();
        this._emitChange();
    }

    setInterval(seconds: number): void {
        this._intervalSeconds = this._normalizeInterval(seconds);
        if (this._running) {
            this._secondsRemaining = Math.min(this._secondsRemaining, this._intervalSeconds);
        }
        this._emitChange();
    }

    getState(): PipelineState {
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
    async restore(): Promise<void> {
        const wasRunning = this._globalState?.get<boolean>('pipeline.running', false) ?? false;
        if (!wasRunning) { return; }

        // Verify at least one non-completed runsheet still exists.
        const sheets = await (this._getRunSheetsCallback?.() ?? Promise.resolve([]));
        const nonCompletedSheets = sheets.filter((sheet: any) => sheet?.completed !== true);
        if (nonCompletedSheets.length === 0) {
            this._clearPersisted();
            return;
        }

        const storedInterval = this._globalState?.get<number>('pipeline.intervalSeconds');
        this._intervalSeconds = this._normalizeInterval(storedInterval);
        const storedRemaining = this._globalState?.get<number>('pipeline.secondsRemaining');
        this._secondsRemaining = storedRemaining !== undefined
            ? Math.max(storedRemaining, MIN_INTERVAL_SECONDS)
            : this._intervalSeconds;
        this._running = true;
        this._paused = this._globalState?.get<boolean>('pipeline.paused', false) ?? false;
        if (!this._paused) {
            this._startTick();
        }
        this._emitChange();
    }

    dispose(): void {
        this._clearTimer();
        this._onStateChange = undefined;
        this._dispatchCallback = undefined;
        this._getRunSheetsCallback = undefined;
    }

    // --- Private ---

    private async _advance(): Promise<void> {
        if (this._isAdvancing) { return; }
        this._isAdvancing = true;
        try {
            const sheets: any[] = await (this._getRunSheetsCallback?.() ?? Promise.resolve([]));
            const activeSheets = sheets.filter((sheet: any) => sheet?.completed !== true);

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
            if (stage === 'done') { return; } // safety guard

            const sessionId: string = sheet.sessionId;
            const planTitle: string = sheet.topic || sheet.planName || sheet.title || sessionId;

            if (this._dispatchCallback) {
                await this._dispatchCallback(stage.role, sessionId, stage.instruction);
            }

            this._lastAction = { planTitle, role: stage.label, timestamp: new Date().toISOString() };
            this._secondsRemaining = this._intervalSeconds;
        } catch (err) {
            console.error('[PipelineOrchestrator] _advance failed:', err);
        } finally {
            this._isAdvancing = false;
            this._emitChange();
        }
    }

    private _startTick(): void {
        this._clearTimer();
        this._timer = setInterval(() => {
            if (!this._running || this._isAdvancing || this._paused) { return; }
            this._secondsRemaining--;
            if (this._secondsRemaining <= 0) {
                void this._advance().catch(err =>
                    console.error('[PipelineOrchestrator] Tick advance failed:', err));
            } else {
                this._emitChange();
            }
        }, 1000);
    }

    private _normalizeInterval(seconds?: number): number {
        if (seconds === undefined || !Number.isFinite(Number(seconds))) {
            return DEFAULT_INTERVAL_SECONDS;
        }
        return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, Math.floor(Number(seconds))));
    }

    private _clearTimer(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
    }

    private _emitChange(): void {
        this._persistState();
        this._onStateChange?.();
    }

    private _persistState(): void {
        if (!this._globalState) { return; }
        const save = (key: string, value: any) =>
            void this._globalState!.update(key, value).then(undefined, (err: Error) =>
                console.error(`[PipelineOrchestrator] Failed to persist ${key}:`, err));
        save('pipeline.running', this._running);
        save('pipeline.paused', this._paused);
        save('pipeline.intervalSeconds', this._intervalSeconds);
        save('pipeline.secondsRemaining', this._running ? this._secondsRemaining : undefined);
    }

    private _clearPersisted(): void {
        if (!this._globalState) { return; }
        const clear = (key: string) =>
            void this._globalState!.update(key, undefined).then(undefined, () => {});
        clear('pipeline.running');
        clear('pipeline.paused');
        clear('pipeline.intervalSeconds');
        clear('pipeline.secondsRemaining');
    }
}
