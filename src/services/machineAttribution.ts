import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
// NOT a static `import * as vscode`. KanbanDatabase imports this module, and
// KanbanDatabase is loaded from out/ by headless contract tests and by any
// plain-node consumer. webpack aliases `vscode` to a shim for the standalone
// BUNDLE, but tsc's out/ has no such alias, so a top-level import here makes
// `require('out/services/KanbanDatabase.js')` throw "Cannot find module
// 'vscode'" — which is exactly what it did to
// test:contract:workspace-root-write-path. Resolved lazily inside the try/catch
// that already exists to tolerate a missing host.
import { stateFile } from '../utils/stateHome';
import { getGlobalStoreDir } from './globalStore';

interface MachineIdentity {
    machineId: string;
    hostLabel: string;
    userId?: string;
}

interface ResolvedAttribution {
    value: string;
    source: 'setting' | 'git-config' | 'unknown';
}

let _identityCache: MachineIdentity | null = null;
let _userAttributionCache: ResolvedAttribution | null = null;

/**
 * Load or create a stable, persisted machine identity for board attribution.
 * The id is generated once per machine and lives in the home store so rebuilt
 * laptops or cloned home directories that reuse a hostname still get a distinct
 * value. The hostname is retained only as a human-readable label.
 */
export function getMachineIdentity(): MachineIdentity {
    if (_identityCache) { return _identityCache; }

    const identityPath = stateFile('machine-identity.json');
    try {
        if (fs.existsSync(identityPath)) {
            const parsed = JSON.parse(fs.readFileSync(identityPath, 'utf8')) as MachineIdentity;
            if (parsed && typeof parsed.machineId === 'string' && parsed.machineId.trim() !== '') {
                _identityCache = {
                    machineId: parsed.machineId.trim(),
                    hostLabel: typeof parsed.hostLabel === 'string' ? parsed.hostLabel : os.hostname(),
                    userId: typeof parsed.userId === 'string' ? parsed.userId : undefined,
                };
                return _identityCache;
            }
        }
    } catch (e) {
        console.warn('[MachineAttribution] Failed to read machine-identity.json:', e);
    }

    const generated: MachineIdentity = {
        machineId: crypto.randomUUID(),
        hostLabel: os.hostname(),
    };

    try {
        fs.mkdirSync(getGlobalStoreDir(), { recursive: true });
        const tmp = `${identityPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(generated, null, 2), 'utf8');
        fs.renameSync(tmp, identityPath);
    } catch (e) {
        console.warn('[MachineAttribution] Failed to persist machine identity:', e);
    }

    _identityCache = generated;
    return _identityCache;
}

export function getMachineId(): string {
    return getMachineIdentity().machineId;
}

export function getMachineLabel(): string {
    return getMachineIdentity().hostLabel;
}

/**
 * Resolve the human operator id for board attribution.
 * Priority: explicit VS Code setting, then git config user.email, then 'unknown'.
 * This is attribution only — a missing value degrades, it never blocks the write.
 * Returns the source so callers can log which store answered.
 */
export function resolveUserId(): ResolvedAttribution {
    // Cached for the life of the process. This is called on EVERY plan_events
    // append — a column move, a workflow start, a completion — and the git branch
    // below spawns a synchronous subprocess that blocks the event loop. Resolving
    // it once per process is the difference between an attribution lookup and a
    // fork per board event on a 4 GB Pi.
    if (_userAttributionCache) { return _userAttributionCache; }

    const resolved = _resolveUserIdUncached();
    _userAttributionCache = resolved;
    if (resolved.source === 'unknown') {
        // Logged ONCE, here, rather than on every event: the callers' per-event
        // warning turned an unresolved attribution into log spam proportional to
        // board activity.
        console.log('[MachineAttribution] No user id resolved (no switchboard.attribution.userId setting, no git user.email) — plan_events attribution will show \'unknown\'.');
    }
    return resolved;
}

/** Test seam: drop the cached attribution so a changed setting is re-read. */
export function resetUserAttributionCache(): void {
    _userAttributionCache = null;
}

function _resolveUserIdUncached(): ResolvedAttribution {
    const identity = getMachineIdentity();
    if (identity.userId && identity.userId.trim() !== '') {
        return { value: identity.userId.trim(), source: 'setting' };
    }

    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const vscode = require('vscode');
        const setting = vscode?.workspace?.getConfiguration?.('switchboard')?.get?.('attribution.userId');
        if (typeof setting === 'string' && setting.trim() !== '') {
            return { value: setting.trim(), source: 'setting' };
        }
    } catch {
        // No VS Code host (standalone, a contract test, a plain-node consumer) —
        // fall through to git config. Attribution degrades; it never blocks.
    }

    try {
        const email = execFileSync('git', ['config', '--global', 'user.email'], { encoding: 'utf8', timeout: 5000 }).trim();
        if (email) {
            return { value: email, source: 'git-config' };
        }
    } catch {
        // git missing or no user.email — fall through to unknown.
    }

    return { value: 'unknown', source: 'unknown' };
}
