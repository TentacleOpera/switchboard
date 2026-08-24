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
