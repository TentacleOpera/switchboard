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

export interface PtyTimingPolicyInputs {
    mode?: string | null;
    explicitPtyDelay?: number | null;
    explicitLegacyDelay?: number | null;
}

export interface ResolvedPtyTimingPolicy {
    mode: ClearReadinessMode;
    delayMs: number;
}

export const DEVIN_DEFAULT_TIMEOUT_MS = 15000;
export const DEVIN_DEFAULT_QUIET_MS = 100;
export const CLAUDE_DEFAULT_TIMEOUT_MS = 3000;
export const CLAUDE_DEFAULT_QUIET_MS = 100;
export const ANTIGRAVITY_DEFAULT_TIMEOUT_MS = 3000;
export const ANTIGRAVITY_DEFAULT_QUIET_MS = 100;
export const DEFAULT_FALLBACK_DELAY_MS = 600;

/**
 * Resolves the effective PTY clear timing policy and delay.
 *
 * Rules:
 * 1. Explicit Auto -> mode 'auto', unknown fallback uses resolved PTY delay.
 * 2. Explicit Manual -> mode 'manual', delay is PTY explicit, else explicit legacy VS Code delay, else 600ms.
 * 3. No mode + explicit PTY delay -> compatibility mode 'manual', delay is explicit PTY delay.
 * 4. No mode/PTY value + explicit legacy delay -> compatibility mode 'manual', delay is explicit legacy delay.
 * 5. No explicit values -> mode 'auto', fallback delay is 600ms.
 */
export function resolvePtyTimingPolicy(inputs: PtyTimingPolicyInputs): ResolvedPtyTimingPolicy {
    const rawMode = (inputs.mode || '').trim().toLowerCase();
    const hasExplicitPty = inputs.explicitPtyDelay !== undefined && inputs.explicitPtyDelay !== null && !Number.isNaN(inputs.explicitPtyDelay);
    const hasExplicitLegacy = inputs.explicitLegacyDelay !== undefined && inputs.explicitLegacyDelay !== null && !Number.isNaN(inputs.explicitLegacyDelay);

    const explicitPty = hasExplicitPty ? inputs.explicitPtyDelay! : undefined;
    const explicitLegacy = hasExplicitLegacy ? inputs.explicitLegacyDelay! : undefined;

    const fallbackDelay = explicitPty !== undefined ? explicitPty : (explicitLegacy !== undefined ? explicitLegacy : DEFAULT_FALLBACK_DELAY_MS);

    if (rawMode === 'auto') {
        return { mode: 'auto', delayMs: fallbackDelay };
    }
    if (rawMode === 'manual') {
        return { mode: 'manual', delayMs: fallbackDelay };
    }

    // Compatibility inference when mode is unset
    if (explicitPty !== undefined || explicitLegacy !== undefined) {
        return { mode: 'manual', delayMs: fallbackDelay };
    }

    return { mode: 'auto', delayMs: DEFAULT_FALLBACK_DELAY_MS };
}

export interface ClearReadinessTracker {
    readonly promise: Promise<ClearReadinessResult>;
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

    // Check if already exited
    if (target.status === 'exited') {
        finish('exit');
        return { promise, dispose: cleanup };
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
        return { promise, dispose: () => finish('manual') };
    }

    const family = options?.cliFamily || target.cliFamily || 'unknown';

    if (family === 'unknown') {
        mainTimer = setTimeout(() => finish('fallback'), fallbackDelay);
        return { promise, dispose: () => finish('fallback') };
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
        return { promise, dispose: () => finish('fallback') };
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
        return { promise, dispose: () => finish('fallback') };
    }

    // Default fallback
    mainTimer = setTimeout(() => finish('fallback'), fallbackDelay);
    return { promise, dispose: () => finish('fallback') };
}
