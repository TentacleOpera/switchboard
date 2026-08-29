import type { CliFamily } from '../services/cliIdentity';

export type ClearReadinessMode = 'auto' | 'manual';
export type ClearReadinessReason = 'signal' | 'fallback' | 'manual' | 'exit' | 'timeout';

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
/**
 * Quiet window for the POST-CLEAR readiness path (claude/antigravity profile).
 * Was 100 ms — uncalibrated, inherited from the initial bracketed-paste-submit
 * fix. 100 ms is shorter than the CLI's /clear re-render burst: the first
 * post-submit data chunk arms the timer, and a brief gap mid-re-render resolves
 * "ready" before the input editor has actually repainted. Raised to 300 ms to
 * cover the re-render gap observed on Claude Code.
 *
 * CALIBRATION SOURCE: scripts/capture-cli-modes.js boot/clear streams on the
 * target host. Re-measure when the CLI version changes — the repo carries a
 * memory that version-pinned CLI behaviour drifts.
 */
export const CLAUDE_DEFAULT_QUIET_MS = 300;
export const ANTIGRAVITY_DEFAULT_TIMEOUT_MS = 3000;
export const ANTIGRAVITY_DEFAULT_QUIET_MS = 300;
export const DEFAULT_FALLBACK_DELAY_MS = 600;

// ── First-readiness constants (cold-boot gate) ──────────────────────────
// These cover a COLD boot — a CLI that has never been prompted. The post-clear
// timeouts above (3 s / 15 s) are too short for a cold start: the
// terminals-curtain plan measured the CLI booting in silence for 1–4 s (node
// startup, config read, auth/model check). The ceilings below cover that gap.
//
// The quiet window is wider than the post-clear quiet because a cold boot's
// banner arrives in multiple bursts (alt-screen setup, mode sets, welcome text)
// with brief gaps between them — a 100 ms window resolves inside the banner
// paint, before the input editor is ready.
//
// CALIBRATION SOURCE: scripts/capture-cli-modes.js boot streams on the target
// host. Re-measure when the CLI version changes.
export const CLAUDE_FIRST_READINESS_TIMEOUT_MS = 8000;
export const CLAUDE_FIRST_READINESS_QUIET_MS = 250;
export const DEVIN_FIRST_READINESS_TIMEOUT_MS = 20000;
export const DEVIN_FIRST_READINESS_QUIET_MS = 250;
export const ANTIGRAVITY_FIRST_READINESS_TIMEOUT_MS = 8000;
export const ANTIGRAVITY_FIRST_READINESS_QUIET_MS = 250;

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

// ── First-readiness gate (cold boot) ────────────────────────────────────

export interface FirstReadinessOptions {
    cliFamily?: CliFamily;
    timeouts?: ClearReadinessTimeouts;
}

/**
 * Wait for a COLD-booting CLI to become ready to accept its first prompt.
 *
 * This is a DIFFERENT signal from `createClearReadinessTracker`, which answers
 * "is the CLI ready AFTER a /clear" — that presumes a running CLI whose state
 * transition can be observed. On a cold seat there is no transition to observe;
 * the detector would be measuring an event that has not started.
 *
 * Predicate: **floor + quiet + ceiling + exit**.
 * - **Floor**: never resolve before any `onData` chunk has been seen. A booting
 *   CLI is silent for 1–4 s (node startup, config read, auth/model check); a
 *   quiet timer armed on silence resolves "ready" inside the silent gap — the
 *   exact defect this gate exists to prevent.
 * - **Quiet**: after the FIRST output chunk, arm a quiet window. When it
 *   elapses with no further output, resolve `signal` — the banner has finished
 *   painting and the input editor is ready.
 * - **Ceiling**: a max timeout. When it fires, resolve `timeout` — proceed
 *   regardless. A CLI that prints continuously and never quiesces, or one that
 *   blocks on auth, must not hang the dispatch forever.
 * - **Exit**: if `onExit` fires, resolve `exit` — the CLI died during boot
 *   (auth failure, bad command). The caller aborts delivery.
 *
 * Known limitation: the predicate resolves on OUTPUT, not on input-editor-ready.
 * A CLI that paints a banner early then blocks on a network auth/model check can
 * false-positive in the post-banner quiet window. The ceiling ensures delivery
 * proceeds regardless; a per-CLI first-paint marker is the mitigation for CLIs
 * where this is observed.
 */
export async function awaitFirstReadiness(
    target: ClearReadinessTerminalTarget,
    options?: FirstReadinessOptions
): Promise<ClearReadinessResult> {
    return new Promise<ClearReadinessResult>((resolve) => {
        const startAt = Date.now();
        let resolved = false;
        let dataSub: any = undefined;
        let exitSub: any = undefined;
        let ceilingTimer: NodeJS.Timeout | null = null;
        let quietTimer: NodeJS.Timeout | null = null;
        let sawOutput = false;

        function cleanup(): void {
            if (ceilingTimer) { clearTimeout(ceilingTimer); ceilingTimer = null; }
            if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
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
            resolve({ reason, elapsedMs: Math.max(0, Date.now() - startAt) });
        }

        // Exit arm — CLI died during boot.
        if (target.status === 'exited') {
            finish('exit');
            return;
        }
        if (typeof target.onExit === 'function') {
            try { exitSub = target.onExit(() => finish('exit')); } catch {}
        }

        const family = options?.cliFamily || target.cliFamily || 'unknown';

        // Resolve per-family ceiling + quiet constants.
        let ceilingMs: number;
        let quietMs: number;
        if (family === 'devin') {
            ceilingMs = options?.timeouts?.devinTimeoutMs ?? DEVIN_FIRST_READINESS_TIMEOUT_MS;
            quietMs = options?.timeouts?.devinQuietMs ?? DEVIN_FIRST_READINESS_QUIET_MS;
        } else if (family === 'claude') {
            ceilingMs = options?.timeouts?.claudeTimeoutMs ?? CLAUDE_FIRST_READINESS_TIMEOUT_MS;
            quietMs = options?.timeouts?.claudeQuietMs ?? CLAUDE_FIRST_READINESS_QUIET_MS;
        } else if (family === 'antigravity') {
            ceilingMs = options?.timeouts?.antigravityTimeoutMs ?? ANTIGRAVITY_FIRST_READINESS_TIMEOUT_MS;
            quietMs = options?.timeouts?.antigravityQuietMs ?? ANTIGRAVITY_FIRST_READINESS_QUIET_MS;
        } else {
            // Unknown family — use the claude constants as a conservative default
            // (8 s ceiling, 250 ms quiet). The ceiling covers the silent boot gap
            // and the quiet window covers the banner burst.
            ceilingMs = CLAUDE_FIRST_READINESS_TIMEOUT_MS;
            quietMs = CLAUDE_FIRST_READINESS_QUIET_MS;
        }

        // Ceiling — proceed regardless after the max wait.
        ceilingTimer = setTimeout(() => finish('timeout'), ceilingMs);

        // Floor + quiet: wait for the FIRST output chunk, then arm the quiet
        // window. Subsequent chunks reset the quiet timer. When the quiet window
        // elapses with no further output, resolve 'signal'.
        if (typeof target.onData === 'function') {
            try {
                dataSub = target.onData(() => {
                    if (resolved) return;
                    if (!sawOutput) {
                        sawOutput = true; // Floor satisfied.
                    }
                    if (quietTimer) { clearTimeout(quietTimer); quietTimer = null; }
                    quietTimer = setTimeout(() => finish('signal'), quietMs);
                });
            } catch {
                // If subscription failed, the ceiling timer handles it.
            }
        } else {
            // No onData available — cannot observe output. Resolve on the ceiling
            // (timeout) so the dispatch does not hang forever.
        }
    });
}
