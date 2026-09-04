import * as fs from 'fs';
import * as path from 'path';
import { BetterSqliteDriver } from './sqliteDriver';
import { getGlobalDbPath } from './globalStore';
import { mergeDatabase, MergeResult } from './dbMerge';

/**
 * Heuristic check to detect if a file path is inside a known cloud-synced folder.
 * Matches: Google Drive, Dropbox, OneDrive, iCloud Drive, Library/Mobile Documents.
 * Heuristic is intentionally path-pattern based and English/canonical-folder focused.
 */
export function detectSyncFolder(filePath: string): string | null {
    if (!filePath || typeof filePath !== 'string') {
        return null;
    }
    const normalized = filePath.replace(/\\/g, '/');

    // Google Drive: Google Drive, GoogleDrive, Library/CloudStorage/GoogleDrive-
    if (/(^|\/)(Google Drive|GoogleDrive)(-[^/]+)?(\/|$)/i.test(normalized) ||
        /\/CloudStorage\/GoogleDrive-/i.test(normalized)) {
        return 'Google Drive';
    }
    // Dropbox
    if (/(^|\/)Dropbox(\/|$)/i.test(normalized)) {
        return 'Dropbox';
    }
    // OneDrive
    if (/(^|\/)OneDrive(\/|$)/i.test(normalized)) {
        return 'OneDrive';
    }
    // iCloud Drive / Mobile Documents
    if (/(^|\/)iCloud Drive(\/|$)/i.test(normalized) ||
        /\/Library\/Mobile Documents(\/|$)/i.test(normalized) ||
        /\/com~apple~CloudDocs(\/|$)/i.test(normalized)) {
        return 'iCloud Drive';
    }

    return null;
}

/**
 * Detects whether a path was constructed by Switchboard's retired cloud DB presets:
 * Google Drive, Dropbox, or iCloud Drive targeting Switchboard/kanban.db.
 */
export function isKnownPresetDbPath(filePath: string): boolean {
    if (!filePath || typeof filePath !== 'string') {
        return false;
    }
    const normalized = filePath.replace(/\\/g, '/');
    if (!/\/Switchboard\/kanban\.db$/i.test(normalized)) {
        return false;
    }
    // 1. Dropbox
    if (/(^|\/)Dropbox\/Switchboard\/kanban\.db$/i.test(normalized)) {
        return true;
    }
    // 2. Google Drive
    if (/(^|\/)Google Drive\/Switchboard\/kanban\.db$/i.test(normalized) ||
        /\/CloudStorage\/GoogleDrive-[^/]+\/My Drive\/Switchboard\/kanban\.db$/i.test(normalized) ||
        /(^|\/)My Drive\/Switchboard\/kanban\.db$/i.test(normalized)) {
        return true;
    }
    // 3. iCloud
    if (/\/Library\/Mobile Documents\/com~apple~CloudDocs\/Switchboard\/kanban\.db$/i.test(normalized) ||
        /(^|\/)iCloud Drive\/Switchboard\/kanban\.db$/i.test(normalized)) {
        return true;
    }
    return false;
}

export interface IntegrityCheckResult {
    ok: boolean;
    error?: string;
}

/**
 * Check if the directory containing the DB has sibling .tmp files (indicating mid-sync write).
 */
function hasTmpSibling(dbPath: string): boolean {
    try {
        const dir = path.dirname(dbPath);
        if (!fs.existsSync(dir)) return false;
        const entries = fs.readdirSync(dir);
        return entries.some(e => e.endsWith('.tmp') || e.endsWith('.part'));
    } catch {
        return false;
    }
}

/**
 * Check PRAGMA integrity_check using read-only sqlite connection.
 */
function checkSqliteIntegrity(dbPath: string): { ok: boolean; error?: string } {
    let driver: BetterSqliteDriver | null = null;
    try {
        driver = new BetterSqliteDriver(dbPath, { fileMustExist: true });
        const res = driver.get<{ integrity_check?: string }>('PRAGMA integrity_check');
        if (res?.integrity_check === 'ok') {
            return { ok: true };
        }
        return { ok: false, error: res?.integrity_check || 'integrity_check failed' };
    } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
    } finally {
        if (driver) {
            try { driver.close(); } catch {}
        }
    }
}

/**
 * Verify integrity of a database before adoption.
 * Checks for .tmp siblings and runs PRAGMA integrity_check.
 * Retries once if mid-download or .tmp sibling detected, then reports failure if still unresolved.
 */
export async function verifyPresetDbIntegrity(dbPath: string): Promise<IntegrityCheckResult> {
    const resolved = path.resolve(dbPath);
    if (!fs.existsSync(resolved)) {
        return { ok: false, error: `Database file does not exist: ${resolved}` };
    }
    try {
        const stat = fs.statSync(resolved);
        if (stat.size === 0) {
            return { ok: false, error: 'Database file is empty (0 bytes)' };
        }
    } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
    }

    // First attempt
    let tmpSibling = hasTmpSibling(resolved);
    let sqliteCheck = checkSqliteIntegrity(resolved);

    if (tmpSibling || !sqliteCheck.ok) {
        // Retry once after brief delay (500ms) to allow sync client to finish
        await new Promise(r => setTimeout(r, 500));
        tmpSibling = hasTmpSibling(resolved);
        sqliteCheck = checkSqliteIntegrity(resolved);

        if (tmpSibling) {
            return {
                ok: false,
                error: `Partially-synced source: detected .tmp sibling in directory for ${resolved}`,
            };
        }
        if (!sqliteCheck.ok) {
            return {
                ok: false,
                error: `Database integrity check failed for ${resolved}: ${sqliteCheck.error}`,
            };
        }
    }

    return { ok: true };
}

export interface DivergenceCheckResult {
    diverged: boolean;
    sourcePath?: string;
    targetPath?: string;
    workspaceId?: string;
    reason?: string;
    message?: string;
}

/**
 * Check if the source database and target global database have diverged on any workspace.
 * If target already has rows for workspace_id with differing updated_at values, reports divergence.
 */
export async function checkDatabaseDivergence(
    sourceDbPath: string,
    targetDbPath?: string
): Promise<DivergenceCheckResult> {
    const resolvedSource = path.resolve(sourceDbPath);
    const resolvedTarget = path.resolve(targetDbPath || getGlobalDbPath());

    if (resolvedSource === resolvedTarget) {
        return { diverged: false };
    }
    if (!fs.existsSync(resolvedSource) || !fs.existsSync(resolvedTarget)) {
        return { diverged: false };
    }

    let sourceDriver: BetterSqliteDriver | null = null;
    let targetDriver: BetterSqliteDriver | null = null;

    try {
        sourceDriver = new BetterSqliteDriver(resolvedSource, { fileMustExist: true });
        targetDriver = new BetterSqliteDriver(resolvedTarget, { fileMustExist: true });

        // Check if plans table exists in both
        const srcHasPlans = sourceDriver.get<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='plans'"
        );
        const tgtHasPlans = targetDriver.get<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='plans'"
        );

        if (!srcHasPlans || !tgtHasPlans) {
            return { diverged: false };
        }

        const sourceWsRows = sourceDriver.all<{ workspace_id: string }>(
            "SELECT DISTINCT workspace_id FROM plans WHERE workspace_id IS NOT NULL AND workspace_id != ''"
        );

        for (const wsRow of sourceWsRows) {
            const wsId = wsRow.workspace_id;
            const targetPlans = targetDriver.all<{ plan_id: string; updated_at: string }>(
                'SELECT plan_id, updated_at FROM plans WHERE workspace_id = ?',
                [wsId]
            );

            if (targetPlans.length > 0) {
                const sourcePlans = sourceDriver.all<{ plan_id: string; updated_at: string }>(
                    'SELECT plan_id, updated_at FROM plans WHERE workspace_id = ?',
                    [wsId]
                );

                const targetPlanMap = new Map<string, string>();
                for (const tp of targetPlans) {
                    targetPlanMap.set(tp.plan_id, tp.updated_at || '');
                }

                let divergenceReason = '';
                for (const sp of sourcePlans) {
                    const tgtUpdated = targetPlanMap.get(sp.plan_id);
                    if (tgtUpdated !== undefined && tgtUpdated !== (sp.updated_at || '')) {
                        divergenceReason = `Plan ${sp.plan_id} has conflicting updated_at ('${sp.updated_at}' in source vs '${tgtUpdated}' in target)`;
                        break;
                    }
                }

                if (!divergenceReason && sourcePlans.length > 0 && targetPlans.length > 0) {
                    const maxSrcUpdated = sourcePlans.reduce((max, p) => (p.updated_at > max ? p.updated_at : max), '');
                    const maxTgtUpdated = targetPlans.reduce((max, p) => (p.updated_at > max ? p.updated_at : max), '');
                    if (maxSrcUpdated !== maxTgtUpdated) {
                        divergenceReason = `Workspace '${wsId}' has conflicting timestamps ('${maxSrcUpdated}' in source vs '${maxTgtUpdated}' in target)`;
                    }
                }

                if (divergenceReason) {
                    return {
                        diverged: true,
                        sourcePath: resolvedSource,
                        targetPath: resolvedTarget,
                        workspaceId: wsId,
                        reason: divergenceReason,
                        message: `Database divergence detected between synced database at '${resolvedSource}' and global database at '${resolvedTarget}'. Both databases contain conflicting updates for workspace '${wsId}' (${divergenceReason}). Automatic merge was skipped to prevent data loss. Both file locations preserved.`,
                    };
                }
            }
        }

        return { diverged: false };
    } catch (err) {
        console.warn('[cloudSyncMigration] Error checking database divergence:', err);
        return { diverged: false };
    } finally {
        if (sourceDriver) {
            try { sourceDriver.close(); } catch {}
        }
        if (targetDriver) {
            try { targetDriver.close(); } catch {}
        }
    }
}

export interface AdoptionResult {
    success: boolean;
    migrated?: boolean;
    diverged?: boolean;
    divergence?: DivergenceCheckResult;
    skipped?: 'integrity_failed' | 'diverged' | 'source_not_found';
    error?: string;
    mergeResult?: MergeResult;
}

/**
 * Adopt a database at a preset location into the global store.
 * Verifies integrity, checks divergence, merges into global store, archives source as .migrated.bak.
 */
export async function adoptPresetDatabase(
    sourceDbPath: string,
    options?: {
        targetDbPath?: string;
        sourceWorkspaceRoot?: string;
        onNotify?: (msg: string) => void;
        onWarn?: (msg: string) => void;
        onError?: (msg: string) => void;
    }
): Promise<AdoptionResult> {
    const resolvedSource = path.resolve(sourceDbPath);
    const resolvedTarget = path.resolve(options?.targetDbPath || getGlobalDbPath());

    if (!fs.existsSync(resolvedSource)) {
        return { success: false, skipped: 'source_not_found', error: `File not found: ${resolvedSource}` };
    }

    // Step 1: Verify integrity
    const integrity = await verifyPresetDbIntegrity(resolvedSource);
    if (!integrity.ok) {
        const errMsg = integrity.error || 'Integrity check failed';
        options?.onError?.(`Preset database migration aborted: ${errMsg}`);
        return { success: false, skipped: 'integrity_failed', error: errMsg };
    }

    // Step 2: Check divergence
    const divergence = await checkDatabaseDivergence(resolvedSource, resolvedTarget);
    if (divergence.diverged) {
        const warnMsg = divergence.message || `Divergence detected between ${resolvedSource} and ${resolvedTarget}`;
        options?.onWarn?.(warnMsg);
        return { success: false, skipped: 'diverged', diverged: true, divergence, error: warnMsg };
    }

    // Step 3: Merge into global store (archives source to .migrated.bak automatically)
    try {
        const mergeResult = await mergeDatabase(resolvedSource, options?.sourceWorkspaceRoot, resolvedTarget);
        if (mergeResult.success) {
            options?.onNotify?.(
                `Migrated database from cloud preset (${resolvedSource}) to global store. Source preserved as kanban.db.migrated.bak.`
            );
            return { success: true, migrated: true, mergeResult };
        } else {
            const err = mergeResult.error || 'Merge failed';
            options?.onError?.(`Failed to merge preset database: ${err}`);
            return { success: false, error: err };
        }
    } catch (err: any) {
        const errStr = err?.message || String(err);
        options?.onError?.(`Failed to merge preset database: ${errStr}`);
        return { success: false, error: errStr };
    }
}

/**
 * High-level helper for launch-time adoption of configured DB path.
 */
export async function adoptPresetDbOnLaunch(
    configuredDbPath: string | undefined,
    callbacks: {
        clearDbPathConfig: () => Promise<void>;
        notify: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    },
    workspaceRoot?: string,
    targetDbPath?: string
): Promise<AdoptionResult | null> {
    if (!configuredDbPath || !isKnownPresetDbPath(configuredDbPath)) {
        return null;
    }

    if (!fs.existsSync(configuredDbPath)) {
        // If the preset file does not exist, clear the defunct config setting
        await callbacks.clearDbPathConfig();
        return null;
    }

    const result = await adoptPresetDatabase(configuredDbPath, {
        targetDbPath,
        sourceWorkspaceRoot: workspaceRoot,
        onNotify: callbacks.notify,
        onWarn: callbacks.warn,
        onError: callbacks.error,
    });

    if (result.success) {
        // Clear the setting on successful adoption
        await callbacks.clearDbPathConfig();
    }

    return result;
}
