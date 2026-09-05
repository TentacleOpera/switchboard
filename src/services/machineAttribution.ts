import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
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
    const identity = getMachineIdentity();
    if (identity.userId && identity.userId.trim() !== '') {
        return { value: identity.userId.trim(), source: 'setting' };
    }

    try {
        const setting = vscode.workspace.getConfiguration('switchboard').get<string>('attribution.userId');
        if (setting && setting.trim() !== '') {
            return { value: setting.trim(), source: 'setting' };
        }
    } catch {
        // VS Code may not be available in some test harnesses — fall through.
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
