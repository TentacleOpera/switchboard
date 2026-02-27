import * as vscode from 'vscode';

/**
 * Default stage sequence for auto-orchestration.
 * Each entry maps to a role used by _handleTriggerAgentAction.
 */
const DEFAULT_STAGE_SEQUENCE: ReadonlyArray<{ role: string; instruction?: string; label: string }> = [
    { role: 'planner', instruction: 'enhance', label: 'Planner' },
    { role: 'lead', label: 'Lead Coder' },
    { role: 'reviewer', label: 'Reviewer' },
];

const DEFAULT_STAGE_TIMEOUT_SECONDS = 420; // 7 minutes - Estimate for complex task completion + buffer
const DEFAULT_INTERVAL_SECONDS = DEFAULT_STAGE_TIMEOUT_SECONDS;
const MIN_INTERVAL_SECONDS = 10;
const MAX_INTERVAL_SECONDS = 3600;

export interface OrchestratorState {
    running: boolean;
    paused: boolean;
    secondsRemaining: number;
    intervalSeconds: number;
    currentStageIndex: number;
    stages: ReadonlyArray<{ role: string; instruction?: string; label: string }>;
    sessionId: string | null;
}

export type DispatchCallback = (role: string, sessionId: string, instruction?: string) => Promise<void>;

const PERSISTENCE_KEY = 'orchestrator.paused';

export class InteractiveOrchestrator {
    private _timer: NodeJS.Timeout | undefined;
    private _secondsRemaining: number = 0;
    private _intervalSeconds: number = DEFAULT_INTERVAL_SECONDS;
    private _currentStageIndex: number = 0;
    private _running: boolean = false;
    private _paused: boolean = false;
    private _sessionId: string | null = null;
    private _stages: ReadonlyArray<{ role: string; instruction?: string; label: string }> = DEFAULT_STAGE_SEQUENCE;
    private _onStateChange: (() => void) | undefined;
    private _dispatchCallback: DispatchCallback | undefined;
    private _isAdvancing: boolean = false;
    private _startNonce: number = 0;
    private _globalState: vscode.Memento | undefined;

    constructor(
        onStateChange?: () => void,
        dispatchCallback?: DispatchCallback,
        globalState?: vscode.Memento
    ) {
        this._onStateChange = onStateChange;
        this._dispatchCallback = dispatchCallback;
        this._globalState = globalState;
        // Restore paused state from persistence
        this._paused = this._globalState?.get(PERSISTENCE_KEY, false) ?? false;
    }

    /** Start or restart the countdown for a given session. */
    start(sessionId: string, intervalSeconds?: number): void {
        this.stop();
        this._sessionId = sessionId;
        this._intervalSeconds = this._normalizeInterval(intervalSeconds);
        this._secondsRemaining = this._intervalSeconds;
        this._currentStageIndex = 0;
        this._running = true;
        this._paused = false;
        this._clearPausedState();
        const startNonce = ++this._startNonce;
        this._emitChange();

        // Use setImmediate to prevent race conditions during initialization
        setImmediate(() => {
            // Start was cancelled or replaced before this callback ran.
            if (!this._running || this._sessionId !== sessionId || this._startNonce !== startNonce) return;
            this._startTick();
            // Trigger first stage immediately after timer starts
            this.advance().catch((error) => {
                console.error('[InteractiveOrchestrator] Initial stage dispatch failed:', error);
            });
        });
    }

    /** Stop the countdown. */
    stop(): void {
        this._clearTimer();
        this._startNonce++;
        this._running = false;
        this._paused = false;
        this._clearPausedState();
        this._secondsRemaining = 0;
        this._emitChange();
    }

    /** Immediately advance to the next stage and restart the timer. */
    async advance(): Promise<void> {
        if (!this._sessionId || this._isAdvancing) return;
        const stage = this._stages[this._currentStageIndex];
        if (!stage) return;

        this._isAdvancing = true;
        try {
            // Dispatch the current stage
            if (this._dispatchCallback) {
                await this._dispatchCallback(stage.role, this._sessionId, stage.instruction);
            }

            // Move to next stage
            this._currentStageIndex++;

            // Check if workflow is complete (no more stages)
            if (this._currentStageIndex >= this._stages.length) {
                // Workflow completed - stop execution
                this._clearTimer();
                this._running = false;
                this._secondsRemaining = 0;
                console.log('[InteractiveOrchestrator] Workflow completed successfully.');
            } else {
                // Restart timer for next stage
                this._secondsRemaining = this._intervalSeconds;
                // Manual advance while paused should resume execution
                if (this._paused) {
                    this._paused = false;
                    this._savePausedState(false);
                    this._startTick();
                }
            }
        } finally {
            this._isAdvancing = false;
            this._emitChange();
        }
    }

    /** Update the session without resetting stage index (e.g., on dropdown change). */
    setSession(sessionId: string | null): void {
        if (this._sessionId === sessionId) return;
        if (this._running) return; // Do not interrupt a running orchestration
        this._sessionId = sessionId;
        this._currentStageIndex = 0;
        this._emitChange();
    }

    /** Restore a previously running orchestration (e.g., after window reload). */
    restore(sessionId: string, secondsRemaining: number, stageIndex: number): void {
        this.stop();
        this._sessionId = sessionId;
        this._secondsRemaining = Math.max(secondsRemaining, MIN_INTERVAL_SECONDS);
        this._currentStageIndex = stageIndex;
        this._running = true;
        this._paused = false;
        this._clearPausedState();
        this._startTick();
        this._emitChange();
    }

    /** Set a custom interval in seconds. */
    setInterval(seconds: number): void {
        this._intervalSeconds = this._normalizeInterval(seconds);
        if (this._running) {
            this._secondsRemaining = Math.min(this._secondsRemaining, this._intervalSeconds);
        }
        this._emitChange();
    }

    getState(): OrchestratorState {
        return {
            running: this._running,
            paused: this._paused,
            secondsRemaining: this._secondsRemaining,
            intervalSeconds: this._intervalSeconds,
            currentStageIndex: this._currentStageIndex,
            stages: this._stages,
            sessionId: this._sessionId,
        };
    }

    /** Pause the countdown (persists across sessions). */
    pause(): void {
        if (!this._running || this._paused) return;
        this._paused = true;
        this._savePausedState(true);
        this._clearTimer();
        this._emitChange();
    }

    /** Resume the countdown (with grace period if needed). */
    unpause(): void {
        if (!this._running || !this._paused) return;
        this._paused = false;
        this._savePausedState(false);
        
        // Grace period: ensure at least 10 seconds remaining
        if (this._secondsRemaining < MIN_INTERVAL_SECONDS) {
            this._secondsRemaining = MIN_INTERVAL_SECONDS;
        }
        
        this._startTick();
        this._emitChange();
    }

    /** Toggle pause state. */
    togglePause(): void {
        if (this._paused) {
            this.unpause();
        } else {
            this.pause();
        }
    }

    dispose(): void {
        this.stop();
        this._onStateChange = undefined;
        this._dispatchCallback = undefined;
    }

    // --- Private ---

    private _startTick(): void {
        this._clearTimer();
        this._timer = setInterval(() => {
            if (!this._running || this._isAdvancing || this._paused) return;
            this._secondsRemaining--;
            if (this._secondsRemaining <= 0) {
                void this.advance().catch((error) => {
                    // Keep timer alive even if one dispatch fails.
                    console.error('[InteractiveOrchestrator] Auto-advance failed:', error);
                });
            } else {
                this._emitChange();
            }
        }, 1000);
    }

    private _normalizeInterval(seconds?: number): number {
        if (!Number.isFinite(seconds)) return DEFAULT_INTERVAL_SECONDS;
        const normalized = Math.floor(Number(seconds));
        if (!Number.isFinite(normalized)) return DEFAULT_INTERVAL_SECONDS;
        return Math.min(MAX_INTERVAL_SECONDS, Math.max(MIN_INTERVAL_SECONDS, normalized));
    }

    private _clearTimer(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
    }

    private _savePausedState(paused: boolean): void {
        if (this._globalState) {
            void this._globalState.update(PERSISTENCE_KEY, paused).then(undefined, (err: Error) => {
                console.error('[InteractiveOrchestrator] Failed to persist paused state:', err);
            });
        }
    }

    private _clearPausedState(): void {
        if (this._globalState) {
            void this._globalState.update(PERSISTENCE_KEY, undefined).then(undefined, (err: Error) => {
                console.error('[InteractiveOrchestrator] Failed to clear paused state:', err);
            });
        }
    }

    private _emitChange(): void {
        this._persistState();
        this._onStateChange?.();
    }

    private _persistState(): void {
        if (!this._globalState) return;
        const save = (key: string, value: any) => {
            void this._globalState!.update(key, value).then(undefined, (err: Error) => {
                console.error(`[InteractiveOrchestrator] Failed to persist ${key}:`, err);
            });
        };
        save('orchestrator.running', this._running);
        save('orchestrator.sessionId', this._running ? this._sessionId : undefined);
        save('orchestrator.secondsRemaining', this._running ? this._secondsRemaining : undefined);
        save('orchestrator.stageIndex', this._running ? this._currentStageIndex : undefined);
    }
}
