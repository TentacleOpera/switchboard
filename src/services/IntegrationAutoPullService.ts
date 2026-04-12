export type AutoPullIntervalMinutes = 5 | 15 | 30 | 60;
export type AutoPullIntegration = 'clickup' | 'linear';

interface AutoPullState {
    timeout: NodeJS.Timeout | null;
    inFlight: boolean;
    enabled: boolean;
    intervalMinutes: AutoPullIntervalMinutes;
    runner: (() => Promise<void>) | null;
}

export class IntegrationAutoPullService {
    private readonly _states = new Map<string, AutoPullState>();

    public configure(
        workspaceRoot: string,
        integration: AutoPullIntegration,
        enabled: boolean,
        intervalMinutes: AutoPullIntervalMinutes,
        runner: () => Promise<void>
    ): void {
        const key = this._stateKey(workspaceRoot, integration);
        let state = this._states.get(key);

        if (!state) {
            state = {
                timeout: null,
                inFlight: false,
                enabled,
                intervalMinutes,
                runner
            };
            this._states.set(key, state);
        } else {
            this._clearTimeout(state);
            state.enabled = enabled;
            state.intervalMinutes = intervalMinutes;
            state.runner = runner;
        }

        if (!enabled) {
            if (!state.inFlight) {
                this._states.delete(key);
            }
            return;
        }

        if (!state.inFlight) {
            this._scheduleNext(key, state);
        }
    }

    public stop(workspaceRoot: string, integration: AutoPullIntegration): void {
        const key = this._stateKey(workspaceRoot, integration);
        const state = this._states.get(key);
        if (!state) {
            return;
        }

        this._clearTimeout(state);
        state.enabled = false;
        state.runner = null;
        if (!state.inFlight) {
            this._states.delete(key);
        }
    }

    public stopWorkspace(workspaceRoot: string): void {
        for (const [key, state] of this._states.entries()) {
            if (!key.startsWith(`${workspaceRoot}::`)) {
                continue;
            }
            this._clearTimeout(state);
            state.enabled = false;
            state.runner = null;
            if (!state.inFlight) {
                this._states.delete(key);
            }
        }
    }

    public dispose(): void {
        for (const state of this._states.values()) {
            this._clearTimeout(state);
            state.enabled = false;
            state.runner = null;
        }
        this._states.clear();
    }

    private _scheduleNext(key: string, stateOverride?: AutoPullState): void {
        const state = stateOverride ?? this._states.get(key);
        if (!state || !state.enabled || !state.runner || state.inFlight) {
            return;
        }

        this._clearTimeout(state);
        state.timeout = setTimeout(async () => {
            const latest = this._states.get(key);
            if (!latest || !latest.enabled || !latest.runner) {
                return;
            }

            latest.timeout = null;
            latest.inFlight = true;
            try {
                await latest.runner();
            } catch (error) {
                console.error(`[IntegrationAutoPull] Scheduled run failed for ${key}:`, error);
            } finally {
                const finalState = this._states.get(key);
                if (!finalState) {
                    return;
                }
                finalState.inFlight = false;
                if (finalState.enabled && finalState.runner) {
                    this._scheduleNext(key, finalState);
                } else {
                    this._states.delete(key);
                }
            }
        }, state.intervalMinutes * 60 * 1000);
    }

    private _clearTimeout(state: AutoPullState): void {
        if (!state.timeout) {
            return;
        }
        clearTimeout(state.timeout);
        state.timeout = null;
    }

    private _stateKey(workspaceRoot: string, integration: AutoPullIntegration): string {
        return `${workspaceRoot}::${integration}`;
    }
}
