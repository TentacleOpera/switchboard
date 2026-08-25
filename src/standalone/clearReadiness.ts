import type { CliFamily } from '../services/cliIdentity';

export type ClearReadinessMode = 'auto' | 'manual';
export type ClearReadinessReason = 'signal' | 'fallback' | 'manual' | 'exit';

export interface ClearReadinessResult {
    reason: ClearReadinessReason;
    elapsedMs: number;
}

export interface ClearReadinessTimeouts {
    devinTimeoutMs?: number;
    devinQuietMs?: number;
    claudeTimeoutMs?: number;
    claudeQuietMs?: number;
    antigravityTimeoutMs?: number;
    antigravityQuietMs?: number;
}

export interface ClearReadinessOptions {
    mode?: ClearReadinessMode;
    fallbackDelayMs?: number;
    cliFamily?: CliFamily;
    timeouts?: ClearReadinessTimeouts;
}

export interface ClearReadinessTerminalTarget {
    name?: string;
    status?: 'active' | 'exited' | string;
    cliFamily?: CliFamily;
    onData?: (cb: (chunk: string) => void) => { dispose?: () => void } | void | (() => void);
    onExit?: (cb: (code?: number) => void) => { dispose?: () => void } | void | (() => void);
}

export const DEVIN_DEFAULT_TIMEOUT_MS = 15000;
export const DEVIN_DEFAULT_QUIET_MS = 100;
export const CLAUDE_DEFAULT_TIMEOUT_MS = 3000;
export const CLAUDE_DEFAULT_QUIET_MS = 100;
export const ANTIGRAVITY_DEFAULT_TIMEOUT_MS = 3000;
export const ANTIGRAVITY_DEFAULT_QUIET_MS = 100;
export const DEFAULT_FALLBACK_DELAY_MS = 600;

export interface ClearReadinessTracker {
    readonly promise: Promise<ClearReadinessResult>;
    /**
     * Called by the delivery path the instant the clear command's submitting CR
     * is written. Everything before that point is the CLI ECHOING the typed
     * `/clear` back — for the output-settled profiles (Claude/Antigravity) that
     * echo is indistinguishable from the post-clear re-render, so a quiet window
     * measured from it resolves ready before the clear has even begun. Devin's
     * profile is unaffected: it matches on terminal-mode transitions and needs
     * the pre-submit bytes to see the OLD session's bracketed-paste disable.
     */
    markSubmitted(): void;
    /** Pure teardown: drops listeners and timers. Never resolves the promise. */
    dispose(): void;
}

/**
 * Creates a clear readiness tracker that attaches listeners immediately
 * (must be called BEFORE writing `/clear`) and resolves when the CLI is
 * ready to accept the subsequent prompt.
 */
export function createClearReadinessTracker(
    target: ClearReadinessTerminalTarget,
    options?: ClearReadinessOptions
): ClearReadinessTracker {
    let resolved = false;
    let resolvePromise: (value: ClearReadinessResult) => void;
    const promise = new Promise<ClearReadinessResult>((resolve) => {
        resolvePromise = resolve;
    });

    const startAt = Date.now();
    let dataSub: any = undefined;
    let exitSub: any = undefined;
    let mainTimer: NodeJS.Timeout | null = null;
    let quietTimer: NodeJS.Timeout | null = null;

    function cleanup(): void {
        if (mainTimer) {
            clearTimeout(mainTimer);
            mainTimer = null;
        }
        if (quietTimer) {
            clearTimeout(quietTimer);
            quietTimer = null;
        }
        if (dataSub) {
            if (typeof dataSub.dispose === 'function') {
                try { dataSub.dispose(); } catch {}
            } else if (typeof dataSub === 'function') {
                try { dataSub(); } catch {}
            }
            dataSub = undefined;
        }
        if (exitSub) {
            if (typeof exitSub.dispose === 'function') {
                try { exitSub.dispose(); } catch {}
            } else if (typeof exitSub === 'function') {
                try { exitSub(); } catch {}
            }
            exitSub = undefined;
        }
    }

    function finish(reason: ClearReadinessReason): void {
        if (resolved) return;
        resolved = true;
        cleanup();
        const elapsedMs = Math.max(0, Date.now() - startAt);
        resolvePromise({ reason, elapsedMs });
    }

    let submitted = false;
    const markSubmitted = (): void => { submitted = true; };

    // Check if already exited
    if (target.status === 'exited') {
        finish('exit');
        return { promise, markSubmitted, dispose: cleanup };
    }

    // Attach exit listener if available
    if (typeof target.onExit === 'function') {
        try {
            exitSub = target.onExit(() => finish('exit'));
        } catch {}
    }

    const mode = options?.mode || 'auto';
    const fallbackDelay = Math.max(0, options?.fallbackDelayMs ?? DEFAULT_FALLBACK_DELAY_MS);

    if (mode === 'manual') {
        mainTimer = setTimeout(() => finish('manual'), fallbackDelay);
        return { promise, markSubmitted, dispose: cleanup };
    }

    const family = options?.cliFamily || target.cliFamily || 'unknown';

    if (family === 'unknown') {
        mainTimer = setTimeout(() => finish('fallback'), fallbackDelay);
        return { promise, markSubmitted, dispose: cleanup };
    }

    if (family === 'devin') {
        const timeoutMs = options?.timeouts?.devinTimeoutMs ?? DEVIN_DEFAULT_TIMEOUT_MS;
        const quietMs = options?.timeouts?.devinQuietMs ?? DEVIN_DEFAULT_QUIET_MS;
        let buffer = '';

        mainTimer = setTimeout(() => finish('fallback'), timeoutMs);

        if (typeof target.onData === 'function') {
            try {
                dataSub = target.onData((chunk: string) => {
                    if (resolved) return;
                    buffer = (buffer + chunk).slice(-65536);

                    // Output received — always cancel pending quiet timer
                    if (quietTimer) {
                        clearTimeout(quietTimer);
                        quietTimer = null;
                    }

                    // Devin readiness state machine:
                    // 1. Observe \x1b[?2004l from the old session tear-down.
                    // 2. Latest bracketed paste transition must be \x1b[?2004h (enable) after the latest disable.
                    // 3. After that enable, observe \x1b[?25h (cursor visible) and \x1b[?2026l (sync output end).
                    // 4. Require quiet window.
                    const disabledAt = buffer.lastIndexOf('\x1b[?2004l');
                    const enabledAt = buffer.lastIndexOf('\x1b[?2004h');

                    if (disabledAt >= 0 && enabledAt > disabledAt) {
                        const afterEnable = buffer.slice(enabledAt);
                        if (afterEnable.includes('\x1b[?25h') && afterEnable.includes('\x1b[?2026l')) {
                            quietTimer = setTimeout(() => finish('signal'), quietMs);
                        }
                    }
                });
            } catch {
                // If subscription failed, fallback timer handles it
            }
        }
        return { promise, markSubmitted, dispose: cleanup };
    }

    if (family === 'claude' || family === 'antigravity') {
        const timeoutMs = family === 'claude'
            ? (options?.timeouts?.claudeTimeoutMs ?? CLAUDE_DEFAULT_TIMEOUT_MS)
            : (options?.timeouts?.antigravityTimeoutMs ?? ANTIGRAVITY_DEFAULT_TIMEOUT_MS);
        const quietMs = family === 'claude'
            ? (options?.timeouts?.claudeQuietMs ?? CLAUDE_DEFAULT_QUIET_MS)
            : (options?.timeouts?.antigravityQuietMs ?? ANTIGRAVITY_DEFAULT_QUIET_MS);

        mainTimer = setTimeout(() => finish('fallback'), timeoutMs);

        if (typeof target.onData === 'function') {
            try {
                dataSub = target.onData(() => {
                    if (resolved) return;
                    // Ignore the echo of the clear command itself — see markSubmitted().
                    if (!submitted) return;
                    if (quietTimer) {
                        clearTimeout(quietTimer);
                        quietTimer = null;
                    }
                    quietTimer = setTimeout(() => finish('signal'), quietMs);
                });
            } catch {
                // If subscription failed, fallback timer handles it
            }
        }
        return { promise, markSubmitted, dispose: cleanup };
    }

    // Default fallback
    mainTimer = setTimeout(() => finish('fallback'), fallbackDelay);
    return { promise, markSubmitted, dispose: cleanup };
}
