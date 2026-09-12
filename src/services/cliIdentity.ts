import * as path from 'path';

export type CliFamily = 'devin' | 'claude' | 'antigravity' | 'unknown';

export interface CliIdentity {
    displayName: string;
    family: CliFamily;
}

export const CLI_BRAND_NAMES: Readonly<Record<string, string>> = {
    agy: 'Antigravity CLI',
    antigravity: 'Antigravity CLI',
};

/**
 * Normalizes a startup command or binary name into a CLI brand display name
 * and a timing/readiness family.
 *
 * Families:
 * - 'devin'
 * - 'claude'
 * - 'antigravity' (for agy / antigravity)
 * - 'unknown' (fallback for unparseable / wrapper-heavy / unrecognized binaries)
 */
export function deriveCliIdentity(startupCommand?: string | null): CliIdentity {
    const cmd = (startupCommand || '').trim();
    if (!cmd) {
        return { displayName: '', family: 'unknown' };
    }
    if (cmd === 'No agent assigned') {
        return { displayName: 'No agent assigned', family: 'unknown' };
    }

    const binary = cmd.split(/\s+/)[0];
    if (!binary) {
        return { displayName: '', family: 'unknown' };
    }

    const base = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toLowerCase();

    let family: CliFamily = 'unknown';
    if (base === 'devin') {
        family = 'devin';
    } else if (base === 'claude') {
        family = 'claude';
    } else if (base === 'agy' || base === 'antigravity') {
        family = 'antigravity';
    }

    let displayName = CLI_BRAND_NAMES[base];
    if (!displayName) {
        const rawName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase();
        displayName = `${rawName} CLI`;
    }

    return { displayName, family };
}

export function deriveCliFamily(startupCommand?: string | null): CliFamily {
    return deriveCliIdentity(startupCommand).family;
}

export function deriveAgentDisplayName(startupCommand?: string | null): string {
    return deriveCliIdentity(startupCommand).displayName;
}

/**
 * The DECLARED per-family context-reset mechanism. Mirrors the Go host's
 * `clearStrategy` in cmd/switchboard-pty-host/prompt.go — the two MUST agree,
 * because the Go host owns the actual respawn and the Node side decides
 * whether to skip the in-process readiness tracker after a clear.
 *
 * - 'in-process': the CLI empties an input buffer on /clear (claude,
 *   antigravity). The slash path is cheap and correct.
 * - 'respawn': /clear restarts the CLI's session internally and never
 *   re-applies the startup command's --model, so the Go host kills the CLI
 *   and starts a fresh login shell, re-injecting the startup command
 *   (devin).
 *
 * Defaults to 'in-process': an unrecognised family keeps today's behaviour
 * rather than being respawned on a guessed argv shape. See
 * a-seats-clear-strategy-is-declared-per-cli-family-not-assumed.md.
 */
export type ClearStrategy = 'in-process' | 'respawn';

export function clearStrategyForFamily(family: CliFamily): ClearStrategy {
    switch (family) {
        case 'devin':
            return 'respawn';
        default:
            return 'in-process';
    }
}

export function clearStrategyForStartupCommand(startupCommand?: string | null): ClearStrategy {
    return clearStrategyForFamily(deriveCliFamily(startupCommand));
}
