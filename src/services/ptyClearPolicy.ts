import type * as vscode from 'vscode';

export type PtyClearPolicy =
    | { mode: 'auto'; unknownDelayMs: number; source: 'mode-explicit' | 'default' }
    | { mode: 'manual'; delayMs: number; source: 'mode-explicit' | 'pty-explicit' | 'legacy-explicit' };

export function explicitScopeValue<T>(i: { globalValue?: T; workspaceValue?: T; workspaceFolderValue?: T } | undefined): T | undefined {
    return i?.workspaceFolderValue ?? i?.workspaceValue ?? i?.globalValue;
}

function clampDelay(val: number | undefined, defaultVal: number): number {
    if (val === undefined || Number.isNaN(val)) return defaultVal;
    return Math.min(Math.max(val, 0), 10000);
}

/**
 * PTY clear timing policy resolution for VS Code extension host.
 *
 * Precedence:
 * 1. Explicit mode 'auto' -> Auto mode; unknown/custom fallback uses explicit PTY delay or 600ms.
 * 2. Explicit mode 'manual' -> Manual mode; uses explicit PTY delay, else explicit legacy VS Code delay, else 600ms.
 * 3. Unset mode + explicit PTY delay -> Compatibility Manual mode using explicit PTY delay.
 * 4. Unset mode + explicit legacy VS Code delay -> Compatibility Manual mode using explicit legacy delay.
 * 5. Unset mode + no explicit delay -> Auto mode with default 600ms unknown fallback.
 */
export function resolvePtyClearPolicy(cfg: vscode.WorkspaceConfiguration): PtyClearPolicy {
    const rawMode = explicitScopeValue(cfg.inspect<string>('terminal.ptyClearReadinessMode'));
    const explicitMode = rawMode === 'auto' || rawMode === 'manual' ? rawMode : undefined;

    const explicitPtyDelayRaw = explicitScopeValue(cfg.inspect<number>('terminal.ptyClearBeforePromptDelay'));
    const explicitPtyDelay = explicitPtyDelayRaw !== undefined ? clampDelay(explicitPtyDelayRaw, 600) : undefined;

    const explicitLegacyDelayRaw = explicitScopeValue(cfg.inspect<number>('terminal.clearBeforePromptDelay'));
    const explicitLegacyDelay = explicitLegacyDelayRaw !== undefined ? clampDelay(explicitLegacyDelayRaw, 2000) : undefined;

    if (explicitMode === 'auto') {
        return {
            mode: 'auto',
            unknownDelayMs: explicitPtyDelay !== undefined ? explicitPtyDelay : 600,
            source: 'mode-explicit',
        };
    }

    if (explicitMode === 'manual') {
        const delayMs = explicitPtyDelay !== undefined
            ? explicitPtyDelay
            : (explicitLegacyDelay !== undefined ? explicitLegacyDelay : 600);
        return {
            mode: 'manual',
            delayMs,
            source: 'mode-explicit',
        };
    }

    if (explicitPtyDelay !== undefined) {
        return {
            mode: 'manual',
            delayMs: explicitPtyDelay,
            source: 'pty-explicit',
        };
    }

    if (explicitLegacyDelay !== undefined) {
        return {
            mode: 'manual',
            delayMs: explicitLegacyDelay,
            source: 'legacy-explicit',
        };
    }

    return {
        mode: 'auto',
        unknownDelayMs: 600,
        source: 'default',
    };
}

export function resolvePtyClearDelay(cfg: vscode.WorkspaceConfiguration): number {
    const policy = resolvePtyClearPolicy(cfg);
    return policy.mode === 'manual' ? policy.delayMs : policy.unknownDelayMs;
}

export interface StandaloneConfigProviderLike {
    getConfigString(key: string, defaultValue?: string): string;
    getConfigNumber(key: string, defaultValue?: number): number;
}

/**
 * PTY clear timing policy resolution for Standalone host.
 */
export function resolveStandalonePtyClearPolicy(configProvider: StandaloneConfigProviderLike): PtyClearPolicy {
    const rawMode = configProvider.getConfigString('terminal.ptyClearReadinessMode', '');
    const explicitMode = rawMode === 'auto' || rawMode === 'manual' ? rawMode : undefined;

    const ptyDelayRaw = configProvider.getConfigNumber('terminal.ptyClearBeforePromptDelay', Number.NaN);
    const explicitPtyDelay = !Number.isNaN(ptyDelayRaw) ? clampDelay(ptyDelayRaw, 600) : undefined;

    const legacyDelayRaw = configProvider.getConfigNumber('terminal.clearBeforePromptDelay', Number.NaN);
    const explicitLegacyDelay = !Number.isNaN(legacyDelayRaw) ? clampDelay(legacyDelayRaw, 2000) : undefined;

    if (explicitMode === 'auto') {
        return {
            mode: 'auto',
            unknownDelayMs: explicitPtyDelay !== undefined ? explicitPtyDelay : 600,
            source: 'mode-explicit',
        };
    }

    if (explicitMode === 'manual') {
        const delayMs = explicitPtyDelay !== undefined
            ? explicitPtyDelay
            : (explicitLegacyDelay !== undefined ? explicitLegacyDelay : 600);
        return {
            mode: 'manual',
            delayMs,
            source: 'mode-explicit',
        };
    }

    if (explicitPtyDelay !== undefined) {
        return {
            mode: 'manual',
            delayMs: explicitPtyDelay,
            source: 'pty-explicit',
        };
    }

    if (explicitLegacyDelay !== undefined) {
        return {
            mode: 'manual',
            delayMs: explicitLegacyDelay,
            source: 'legacy-explicit',
        };
    }

    return {
        mode: 'auto',
        unknownDelayMs: 600,
        source: 'default',
    };
}

export function resolveStandalonePtyClearDelay(configProvider: StandaloneConfigProviderLike): number {
    const policy = resolveStandalonePtyClearPolicy(configProvider);
    return policy.mode === 'manual' ? policy.delayMs : policy.unknownDelayMs;
}
