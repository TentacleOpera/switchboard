
import * as vscode from 'vscode';
import * as path from 'path';
import { stateFs as fs } from './services/stateConfigBridge';
import type { Dirent } from 'fs';

import * as os from 'os';
import { TaskViewerProvider } from './services/TaskViewerProvider';
import { SessionActionLog } from './services/SessionActionLog';
import { KanbanProvider } from './services/KanbanProvider';
import { GlobalPlanWatcherService } from './services/GlobalPlanWatcherService';
import { KanbanDatabase, type WorkspaceDatabaseMapping } from './services/KanbanDatabase';
import { resolveEffectiveWorkspaceRootFromMappings, getMappingsFromIndex } from './services/WorkspaceIdentityService';
import { SetupPanelProvider } from './services/SetupPanelProvider';
import { ReviewCommentRequest, ReviewCommentResult } from './services/reviewTypes';
import { sendRobustText } from './services/terminalUtils';
import { importPlanFiles } from './services/PlanFileImporter';
import { ClickUpSyncService } from './services/ClickUpSyncService';
import { LinearSyncService } from './services/LinearSyncService';
import { NotionFetchService } from './services/NotionFetchService';
import { NotionBrowseService } from './services/NotionBrowseService';
import { LocalFolderService } from './services/LocalFolderService';
import { ControlPlaneMigrationService } from './services/ControlPlaneMigrationService';
import {
    CLAUDE_PROTOCOL_HEADER,
    CLAUDE_BLOCK_START,
    CLAUDE_BLOCK_END,
    CLAUDE_PREAMBLE,
    buildManagedInner,
    generateClaudeMirror,
} from './services/ClaudeCodeMirrorService';
import { WorkspaceExcludeService } from './services/WorkspaceExcludeService';
import { cleanWorkspace, pruneZombieTerminalEntries } from './lifecycle/cleanWorkspace';
import { PlanningPanelProvider } from './services/PlanningPanelProvider';
import { DesignPanelProvider, invalidateStitchSdkCache } from './services/DesignPanelProvider';
import { PanelStateStore } from './services/PanelStateStore';
import { PlannerPromptWriter } from './services/PlannerPromptWriter';
import { PlanningPanelCacheService } from './services/PlanningPanelCacheService';
import { ResearchImportService } from './services/ResearchImportService';
import { showTemporaryNotification } from './utils/showTemporaryNotification';
import { PlanAutoFetchService } from './services/PlanAutoFetchService';
import { MigrationService } from './services/MigrationService';
import { switchboardCommandRegistry } from './services/commandRegistry';

/**
 * Verb Engine · 1 — register a `switchboard.*` command in BOTH the host-agnostic
 * command registry (so seam-routed _handleMessage arms dispatch it in-process,
 * with no vscode command infrastructure on the path) AND with vscode (palette,
 * keybindings, other extensions). The vscode registration is the thin caller;
 * the registry holds the body. Use this for every command a provider arm invokes.
 */
function registerSwitchboardCommand(name: string, handler: (...args: any[]) => any): vscode.Disposable {
    switchboardCommandRegistry.register(name, handler);
    return vscode.commands.registerCommand(name, handler);
}

// Status bar item for setup notification
let setupStatusBarItem: vscode.StatusBarItem;
let terminalOpenStatusBarItem: vscode.StatusBarItem;
let terminalClearStatusBarItem: vscode.StatusBarItem;
let terminalResetStatusBarItem: vscode.StatusBarItem;
let kanbanStatusBarItem: vscode.StatusBarItem;
let artifactsStatusBarItem: vscode.StatusBarItem;
let projectStatusBarItem: vscode.StatusBarItem;
let designStatusBarItem: vscode.StatusBarItem;
let switchboardHubStatusBarItem: vscode.StatusBarItem;
let memoStatusBarItem: vscode.StatusBarItem;

// Global references
let outputChannel: vscode.OutputChannel | null = null;
let kanbanProvider: KanbanProvider | null = null;
let activeTaskViewerProvider: TaskViewerProvider | null = null;



function getWorkspaceSourceServicesDirectory(workspaceRoot: string): string {
    return path.join(workspaceRoot, 'src', 'services');
}

// Intentionally uses synchronous I/O: called infrequently (once per activation),
// reads a tiny JSON file from local disk — negligible event-loop impact.
function getExtensionVersion(extensionPath: string): string | undefined {
    const packageJsonPath = path.join(extensionPath, 'package.json');
    try {
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
        return packageJson.version;
    } catch (e) {
        console.error('Failed to read extension version from package.json:', e);
        return undefined;
    }
}

function getEnforcedSwitchboardBooleanSetting(key: string, defaultValue: boolean): { value: boolean; ignoredWorkspaceOverride: boolean } {
    const config = vscode.workspace.getConfiguration('switchboard');
    const inspected = config.inspect<boolean>(key);
    const globalValue = inspected?.globalValue;
    const defaultConfigValue = inspected?.defaultValue;
    const workspaceValueDefined = inspected?.workspaceValue !== undefined || inspected?.workspaceFolderValue !== undefined;

    const value = typeof globalValue === 'boolean'
        ? globalValue
        : (typeof defaultConfigValue === 'boolean' ? defaultConfigValue : defaultValue);

    return {
        value,
        ignoredWorkspaceOverride: workspaceValueDefined
    };
}

// --- Agent version tracking ---

function getAgentVersionFilePath(workspaceRoot: string): string {
    return path.join(workspaceRoot, '.switchboard', '.agent_version.json');
}

// Intentionally uses synchronous I/O: called infrequently (once per activation),
// reads a tiny JSON file from local disk — negligible event-loop impact.
function getLastCopiedAgentVersion(workspaceRoot: string): string | undefined {
    const versionFilePath = getAgentVersionFilePath(workspaceRoot);
    try {
        if (fs.existsSync(versionFilePath)) {
            const versionData = JSON.parse(fs.readFileSync(versionFilePath, 'utf-8'));
            return versionData.version;
        }
    } catch (e) {
        console.error('Failed to read last agent version:', e);
    }
    return undefined;
}

function setLastCopiedAgentVersion(workspaceRoot: string, version: string): void {
    const versionFilePath = getAgentVersionFilePath(workspaceRoot);
    try {
        const versionData = { version, lastUpdated: new Date().toISOString() };
        fs.writeFileSync(versionFilePath, JSON.stringify(versionData, null, 2));
    } catch (e) {
        console.error('Failed to write agent version:', e);
    }
}

/**
 * One-shot bootstrap: if VS Code config has mappings but DB doesn't yet,
 * copy them into the DB and write pointer files. Runs once, then sets a
 * globalState flag so it never runs again. This is NOT a migration period —
 * it's a single bridge for existing config → DB on first activation.
 */
async function bootstrapMappingsToDb(context: vscode.ExtensionContext): Promise<void> {
    const bootstrapped = context.globalState.get<boolean>('mappings_db_bootstrapped', false);
    if (bootstrapped) {
        return;
    }

    try {
        const workspaceCfg = vscode.workspace.getConfiguration('switchboard');
        const configValue = workspaceCfg.get<{ enabled?: boolean; mappings?: WorkspaceDatabaseMapping[] }>('workspaceDatabaseMappings');
        if (!configValue || !configValue.enabled || !Array.isArray(configValue.mappings) || configValue.mappings.length === 0) {
            // Nothing to bootstrap
            await context.globalState.update('mappings_db_bootstrapped', true);
            return;
        }

        // If any DB already has workspace_mappings, skip — user has already saved from setup.html
        for (const mapping of configValue.mappings) {
            if (mapping.parentFolder && mapping.dbPath) {
                try {
                    const db = KanbanDatabase.forWorkspace(mapping.parentFolder, mapping.dbPath);
                    const existing = await db.getWorkspaceMappings();
                    if (existing.enabled && Array.isArray(existing.mappings) && existing.mappings.length > 0) {
                        // DB already has mappings — bootstrap not needed
                        await context.globalState.update('mappings_db_bootstrapped', true);
                        return;
                    }
                } catch {}
            }
        }

        console.log('[Switchboard] Bootstrapping workspaceDatabaseMappings from VS Code config to database...');

        for (const mapping of configValue.mappings) {
            if (mapping.parentFolder && mapping.dbPath) {
                KanbanDatabase.writeDbPointer(mapping.parentFolder, mapping.dbPath);
                const db = KanbanDatabase.forWorkspace(mapping.parentFolder, mapping.dbPath);
                await db.setWorkspaceMappings({
                    enabled: configValue.enabled ?? false,
                    mappings: configValue.mappings
                });
            }
        }

        await context.globalState.update('mappings_db_bootstrapped', true);
        console.log('[Switchboard] Bootstrap complete. Mappings now live in DB.');
    } catch (err) {
        console.error('[Switchboard] Error during one-time mapping bootstrap:', err);
    }
}

async function initializeMappingIndex(outputChannel?: vscode.OutputChannel): Promise<void> {
    const dbs = new Map<string, KanbanDatabase>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        const folderPath = path.resolve(folder.uri.fsPath);
        // Check for pointer file, then kanban.dbPath setting, then default path
        let dbPath: string = KanbanDatabase.readDbPointer(folderPath) ?? '';
        if (!dbPath) {
            let settingValue = '';
            try {
                settingValue = String(vscode.workspace.getConfiguration('switchboard', folder.uri).get('kanban.dbPath') || '').trim();
            } catch {}
            if (settingValue) {
                const expanded = (KanbanDatabase as any)._expandHome(settingValue);
                dbPath = path.isAbsolute(expanded) ? expanded : path.join(folderPath, expanded);
            } else {
                dbPath = path.join(folderPath, '.switchboard', 'kanban.db');
            }
        }

        // If the database file exists, open it and read mappings
        if (dbPath && fs.existsSync(dbPath)) {
            const db = KanbanDatabase.forWorkspace(folderPath, dbPath);
            dbs.set(folderPath, db);
            outputChannel?.appendLine(`[initializeMappingIndex] Found DB for ${path.basename(folderPath)} at ${dbPath}`);
        } else {
            outputChannel?.appendLine(`[initializeMappingIndex] No DB for ${path.basename(folderPath)} (dbPath=${dbPath}, exists=${dbPath ? fs.existsSync(dbPath) : false})`);
        }
    }
    outputChannel?.appendLine(`[initializeMappingIndex] Found ${dbs.size} DB(s), calling buildMappingIndexFromDbs`);
    const { buildMappingIndexFromDbs } = require('./services/WorkspaceIdentityService');
    await buildMappingIndexFromDbs(dbs, outputChannel);
    const { getMappingsFromIndex } = require('./services/WorkspaceIdentityService');
    const result = getMappingsFromIndex();
    outputChannel?.appendLine(`[initializeMappingIndex] After build: enabled=${result.enabled}, mappings=${result.mappings?.length ?? 0}`);
}

function shouldRefreshAgentWorkspaceFiles(extensionPath: string, workspaceRoot: string): boolean {
    const currentVersion = getExtensionVersion(extensionPath);
    const lastVersion = getLastCopiedAgentVersion(workspaceRoot);

    // Refresh if we can't determine versions (defensive: always copy)
    if (!currentVersion || !lastVersion) {
        return true;
    }

    // Refresh if versions differ
    if (currentVersion !== lastVersion) {
        return true;
    }

    return false;
}

/**
 * Predicate: a folder is Switchboard-managed for the control-plane refresh loop.
 * Consults workspace mappings first, then falls back to on-disk markers of a
 * deliberate setup (`kanban.db`, `db-pointer`, or `workspace-id`). The previous
 * "`.switchboard/` exists" test was self-defeating because board-mirror and
 * identity writers auto-created that directory; this tiered gate prevents that.
 */
function isSwitchboardManagedFolder(root: string): boolean {
    const resolvedRoot = path.resolve(root);
    try {
        // Tier 1: mapped child workspaceFolders belong to the parent and are never scaffolded here.
        const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(resolvedRoot);
        if (effectiveRoot !== resolvedRoot) {
            return false;
        }

        // Tier 2: configured mapping parents are explicit user opt-in.
        const cfg = getMappingsFromIndex();
        if (cfg?.enabled && Array.isArray(cfg.mappings)) {
            for (const mapping of cfg.mappings) {
                if (mapping.parentFolder) {
                    const expanded = mapping.parentFolder.startsWith('~')
                        ? path.join(os.homedir(), mapping.parentFolder.slice(1))
                        : mapping.parentFolder;
                    if (path.resolve(expanded) === resolvedRoot) {
                        return true;
                    }
                }
            }
        }

        // Tier 3: unclaimed by config — fall back to evidence of deliberate setup.
        const dir = path.join(resolvedRoot, '.switchboard');
        if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
            return false;
        }
        // NOTE: workspace-id is deliberately NOT a marker. It was mass-planted into
        // unrelated repos by the identity writers before they got their existence
        // bail (WorkspaceIdentityService), so it proves nothing about deliberate
        // setup and kept re-arming littered roots for full scaffold refreshes
        // (UAT 2026-07-13: analytics-dashboard). A genuine workspace always has
        // kanban.db (standalone) or db-pointer (redirected parent); a root with
        // only workspace-id self-heals into managed the moment its board is used.
        const markers = [
            path.join(dir, 'kanban.db'),
            path.join(dir, 'db-pointer'),
        ];
        return markers.some(p => fs.existsSync(p));
    } catch {
        return false;
    }
}

/**
 * Per-folder control-plane refresh: content-hash skill **and workflow** seed +
 * conditional protocol scaffold + per-folder version stamp. Extracted from the
 * old single-root activation block. Workflow files use the same content-hash
 * self-heal as skills (not a version gate) so a rename/door-change lands on
 * same-version installs — fixes the delete-without-replace asymmetry where
 * `cleanupLegacyAgentFiles` (unconditional) removed retired workflow files
 * while delivery was gated on a version bump.
 *
 * Ordering contract (preserved from the original :477-479 block):
 *   1. Capture `needsAgentRefresh` BEFORE seeding (seeding must not pre-stamp).
 *   2. Content-hash skill seed loop.
 *   3. Content-hash workflow seed loop (same semantics, must set agentsChanged
 *      so the same-pass scaffold regenerates the .claude mirror against freshly
 *      delivered doors).
 *   4. Scaffold + stamp iff `needsAgentRefresh || agentsChanged`.
 */
async function refreshWorkspaceControlPlane(
    root: string,
    context: vscode.ExtensionContext
): Promise<void> {
    // 1. Capture refresh decision BEFORE seeding stamps the version.
    const needsAgentRefresh = shouldRefreshAgentWorkspaceFiles(context.extensionUri.fsPath, root);

    // 2. Content-hash skill seed loop (per-file fault tolerance).
    let agentsChanged = false;
    try {
        const bundledSkillsUri = vscode.Uri.joinPath(context.extensionUri, '.agents', 'skills');
        const skillFiles = await crawlDirectory(bundledSkillsUri);
        for (const relativePath of skillFiles) {
            const srcUri = vscode.Uri.joinPath(bundledSkillsUri, relativePath);
            const destUri = vscode.Uri.joinPath(vscode.Uri.file(root), '.agents', 'skills', relativePath);
            try {
                await vscode.workspace.fs.stat(destUri);
                // dest exists → overwrite iff bundle content differs (content-hash refresh)
                try {
                    const [srcHash, destHash] = await Promise.all([
                        ControlPlaneMigrationService.hashFile(srcUri.fsPath),
                        ControlPlaneMigrationService.hashFile(destUri.fsPath),
                    ]);
                    if (srcHash !== destHash) {
                        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));
                        await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: true });
                        agentsChanged = true;
                    }
                } catch (hashErr) {
                    console.warn(`[Switchboard] Skill content-hash refresh failed for ${relativePath}, skipping:`, hashErr);
                }
            } catch {
                // dest absent → copy new file.
                try {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));
                    await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
                    agentsChanged = true;
                } catch (copyErr) {
                    console.warn(`[Switchboard] Skill seed copy failed for ${relativePath}, skipping:`, copyErr);
                }
            }
        }
    } catch (err) {
        console.error(`[Switchboard] Skill-file seed failed for ${root}, continuing:`, err);
    }

    // 2b. Content-hash workflow seed loop (same per-file semantics as skills).
    // Workflow files are Switchboard-managed canonical definitions — user edits
    // are not preserved across activations when the bundle differs (same contract
    // as cleanupLegacyAgentFiles). Hash-seeding (not a version gate) ensures a
    // door rename or new door lands on same-version installs; without this the
    // unconditional cleanupLegacyAgentFiles delete becomes delete-without-replace.
    // Must set agentsChanged so the same-pass scaffold regenerates the .claude
    // mirror against freshly delivered door sources.
    try {
        const bundledWorkflowsUri = vscode.Uri.joinPath(context.extensionUri, '.agents', 'workflows');
        const workflowFiles = await crawlDirectory(bundledWorkflowsUri);
        for (const relativePath of workflowFiles) {
            const srcUri = vscode.Uri.joinPath(bundledWorkflowsUri, relativePath);
            const destUri = vscode.Uri.joinPath(vscode.Uri.file(root), '.agents', 'workflows', relativePath);
            try {
                await vscode.workspace.fs.stat(destUri);
                // dest exists → overwrite iff bundle content differs (content-hash refresh)
                try {
                    const [srcHash, destHash] = await Promise.all([
                        ControlPlaneMigrationService.hashFile(srcUri.fsPath),
                        ControlPlaneMigrationService.hashFile(destUri.fsPath),
                    ]);
                    if (srcHash !== destHash) {
                        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));
                        await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: true });
                        agentsChanged = true;
                    }
                } catch (hashErr) {
                    console.warn(`[Switchboard] Workflow content-hash refresh failed for ${relativePath}, skipping:`, hashErr);
                }
            } catch {
                // dest absent → copy new file.
                try {
                    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));
                    await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
                    agentsChanged = true;
                } catch (copyErr) {
                    console.warn(`[Switchboard] Workflow seed copy failed for ${relativePath}, skipping:`, copyErr);
                }
            }
        }
    } catch (err) {
        // Missing bundle workflows dir (or unreadable) → no-op; never fail activation.
        console.error(`[Switchboard] Workflow-file seed failed for ${root}, continuing:`, err);
    }

    // 3. Scaffold protocol layers + stamp version iff refresh needed.
    if (needsAgentRefresh || agentsChanged) {
        try {
            await scaffoldProtocolLayers(
                vscode.Uri.file(root),
                context.extensionUri,
                'Migration'
            );
            const currentVersion = getExtensionVersion(context.extensionUri.fsPath);
            if (currentVersion) {
                setLastCopiedAgentVersion(root, currentVersion);
            }
        } catch (err) {
            console.error(`[Switchboard] Protocol-file migration failed for ${root}, continuing:`, err);
        }
    }
}

// Terminal Registry: Store terminal references for input forwarding
const registeredTerminals = new Map<string, vscode.Terminal>();
const recentBridgeInputBySource = new Map<string, { target: string; at: number }>();

function normalizeAgentKey(value: string | undefined | null): string {
    return (value || '')
        .toLowerCase()
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function suffixedName(baseName: string): string {
    const suffix = `-${vscode.env.appName}`;
    return baseName.endsWith(suffix) ? baseName : `${baseName}${suffix}`;
}

function stripIdeSuffix(name: string): string {
    const suffix = `-${vscode.env.appName}`;
    return name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
}

function isPathWithin(parentDir: string, filePath: string): boolean {
    const normalizedParent = path.resolve(parentDir);
    const normalizedFile = path.resolve(filePath);
    return normalizedFile === normalizedParent || normalizedFile.startsWith(normalizedParent + path.sep);
}

function isPathWithinRoot(candidate: string, root: string): boolean {
    // Allow Antigravity brain directory (~/.gemini/antigravity/brain)
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    if (isPathWithin(brainDir, candidate)) return true;

    // Allow configured custom plan folder (switchboard.kanban.plansFolder)
    try {
        const config = vscode.workspace.getConfiguration('switchboard');
        const customFolder = config.get<string>('kanban.plansFolder')?.trim();
        if (customFolder) {
            const expanded = customFolder.startsWith('~')
                ? path.join(os.homedir(), customFolder.slice(1))
                : customFolder;
            const resolved = path.resolve(expanded);
            if (isPathWithin(resolved, candidate)) return true;
        }
    } catch { /* ignore config errors */ }

    const rel = path.relative(root, candidate);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
}

function findWorkspaceRootForPath(candidate: string): string | null {
    const absoluteCandidate = path.resolve(candidate);

    // First: check if it's directly inside one of the VS Code workspace folders.
    // Use a direct path.relative check — NOT isPathWithinRoot — so the brain/custom-folder
    // allow-list in isPathWithinRoot doesn't short-circuit before the fallback below.
    for (const folder of vscode.workspace.workspaceFolders || []) {
        const workspaceRoot = folder.uri.fsPath;
        const rel = path.relative(workspaceRoot, absoluteCandidate);
        if (!rel.startsWith('..') && !path.isAbsolute(rel)) {
            return workspaceRoot;
        }
    }

    // Second: if the path is in an allowed external directory (brain or custom folder),
    // fall back to the kanban selection so the command has a root to operate against.
    const brainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    if (isPathWithin(brainDir, absoluteCandidate)) {
        return kanbanProvider?.getCurrentWorkspaceRoot() || null;
    }

    try {
        const config = vscode.workspace.getConfiguration('switchboard');
        const customFolder = config.get<string>('kanban.plansFolder')?.trim();
        if (customFolder) {
            const expanded = customFolder.startsWith('~')
                ? path.join(os.homedir(), customFolder.slice(1))
                : customFolder;
            const resolved = path.resolve(expanded);
            if (isPathWithin(resolved, absoluteCandidate)) {
                return kanbanProvider?.getCurrentWorkspaceRoot() || null;
            }
        }
    } catch { /* ignore */ }

    return null;
}

function isCompatibleIdeName(termIdeName: string | undefined, currentIdeName: string): boolean {
    const normalizedTermIde = (termIdeName || '').toLowerCase();
    const normalizedCurrentIde = (currentIdeName || '').toLowerCase();
    if (!normalizedTermIde) return true;
    if (normalizedTermIde === normalizedCurrentIde) return true;
    if (normalizedTermIde === 'antigravity' && normalizedCurrentIde.includes('visual studio code')) return true;
    if (normalizedTermIde.includes('visual studio code') && normalizedCurrentIde === 'antigravity') return true;
    return false;
}

function resolvePreferredReviewRole(state: any): string {
    const validRoles = new Set(['planner', 'reviewer', 'lead', 'coder', 'analyst']);
    const candidates = [
        state?.review?.preferredRole,
        state?.context?.review?.preferredRole,
        state?.context?.preferredRole,
        state?.session?.activePersona
    ];
    for (const candidate of candidates) {
        const normalized = normalizeAgentKey(typeof candidate === 'string' ? candidate : '').replace(/\s+/g, '_');
        const role = normalized.replace(/^lead_coder$/, 'lead');
        if (validRoles.has(role)) return role;
    }
    return 'planner';
}

function resolveTerminalByName(terminalName: string): vscode.Terminal | undefined {
    // 1. Exact match (suffixed or bare)
    const exact = registeredTerminals.get(terminalName);
    if (exact && exact.exitStatus === undefined) {
        return exact;
    }

    // 2. Try suffixed name (bare name → suffixed key)
    const suffixed = suffixedName(terminalName);
    if (suffixed !== terminalName) {
        const bySuffix = registeredTerminals.get(suffixed);
        if (bySuffix && bySuffix.exitStatus === undefined) {
            return bySuffix;
        }
    }

    // 3. Normalized fuzzy match (strip suffix before normalizing to avoid
    //    hyphen-separated IDE name polluting the normalized form)
    const normalizedTarget = normalizeAgentKey(stripIdeSuffix(terminalName));
    for (const [name, terminal] of registeredTerminals.entries()) {
        if (terminal.exitStatus !== undefined) continue;
        if (normalizeAgentKey(stripIdeSuffix(name)) === normalizedTarget) {
            return terminal;
        }
    }

    // 4. Live VS Code terminal fallback (terminal.name is always unsuffixed)
    return (vscode.window.terminals || []).find((terminal) => {
        if (terminal.exitStatus !== undefined) return false;
        const liveName = normalizeAgentKey(terminal.name);
        const creationName = normalizeAgentKey((terminal.creationOptions as vscode.TerminalOptions | undefined)?.name || '');
        return liveName === normalizedTarget || creationName === normalizedTarget;
    });
}

/**
 * Helper to wrap a promise with a timeout.
 */
async function waitWithTimeout<T>(promise: Thenable<T> | Promise<T>, timeoutMs: number, defaultValue: T): Promise<T> {
    let timeoutId: NodeJS.Timeout;
    const timeoutPromise = new Promise<T>((resolve) => {
        timeoutId = setTimeout(() => resolve(defaultValue), timeoutMs);
    });
    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}


export async function activate(context: vscode.ExtensionContext) {
    console.time('switchboard.activate');
    


    if (!outputChannel) {
        outputChannel = vscode.window.createOutputChannel('Switchboard');
    }

    // One-shot bootstrap: copy VS Code config mappings to DB if DB is empty, then build index
    try {
        await bootstrapMappingsToDb(context);
        await initializeMappingIndex(outputChannel ?? undefined);
        outputChannel?.appendLine('[Switchboard] Mapping index initialization completed successfully');
        await MigrationService.runMigration();
        outputChannel?.appendLine('[Switchboard] Global integration config migration completed');
    } catch (err) {
        console.error('[Switchboard] Mapping index initialization or migration failed, continuing activation:', err);
        outputChannel?.appendLine(`[Switchboard] Mapping index/migration FAILED: ${err}`);
    }

    kanbanProvider = new KanbanProvider(context.extensionUri, context, outputChannel);
    const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();

    // Phase 1 Workstream A: start the idle-eviction sweep + apply the resident-DB budget
    // from settings. The sweep evicts cached KanbanDatabase instances idle > 10 min
    // (except the active workspace) and aggressively evicts when summed resident size
    // crosses the budget — the primary defense against sql.js WASM heap exhaustion.
    KanbanDatabase.startEvictionSweep();
    const budgetMb = vscode.workspace.getConfiguration('switchboard').get<number>('kanban.residentDbBudgetMb', 500) ?? 500;
    KanbanDatabase.setResidentDbBudgetMb(budgetMb);

    // Phase 1 Workstream D: one-time cleanup of stale diagnostic files left by the
    // removed per-persist feature-clobber probe.
    const allRoots = (kanbanProvider as any)._getWorkspaceRoots?.() as string[] | undefined;
    if (allRoots && allRoots.length > 0) {
        KanbanDatabase.cleanupDiagnosticFiles(allRoots);
    } else if (workspaceRoot) {
        KanbanDatabase.cleanupDiagnosticFiles([workspaceRoot]);
    }

    // Migrate any cards stranded in deprecated columns (CONTEXT GATHERER, CODE_RESEARCHER, SPLITTER)
    // to PLAN REVIEWED. Runs once at activation; idempotent (no-op once no cards remain).
    if (workspaceRoot) {
        try {
            const db = (kanbanProvider as any)._getKanbanDb(workspaceRoot);
            await db.ensureReady();
            const workspaceId = await (kanbanProvider as any)._readWorkspaceId(workspaceRoot);
            if (workspaceId) {
                await db.migrateDeprecatedColumns(workspaceId);
                // Phase 2: reconcile any transient double-home (hot+cold) from a prior
                // interrupted partition BEFORE the first board read, so no reader
                // observes a plan in both stores. Runs after migrations (V55 may have
                // just partitioned) and is a no-op when no archive exists.
                await db.reconcileHotCold().catch((e: unknown) => console.warn('[Switchboard] Hot/cold reconcile skipped:', e));
                // Phase 1 Workstream C: run telemetry retention on activation (daily
                // cadence; the periodic re-run is handled by the board refresh path).
                const peDays = vscode.workspace.getConfiguration('switchboard').get<number>('kanban.planEventsRetentionDays', 90) ?? 90;
                const alDays = vscode.workspace.getConfiguration('switchboard').get<number>('kanban.activityLogRetentionDays', 30) ?? 30;
                void db.runTelemetryRetention({
                    planEventsOlderThanDays: peDays,
                    activityLogOlderThanDays: alDays,
                }).catch((e: unknown) => console.warn('[Switchboard] Telemetry retention skipped:', e));
            }
        } catch (e) {
            console.warn('[Switchboard] Deprecated column migration skipped:', e);
        }
    }

    // Multi-root control-plane refresh: refresh every Switchboard-managed folder
    // (mapping parents ∪ open managed folders), not just the focused one. The
    // mappings list is the user-maintained distribution list; open folders cover
    // the normal single-folder install. Dedupe by resolved path. Per-folder
    // try/catch so one bad folder never aborts the others.
    // Ordering invariant: this loop must run after the initializeMappingIndex call
    // above so isSwitchboardManagedFolder's Tier-1 mapping check sees a populated index.
    const mappingCfg = getMappingsFromIndex();
    const refreshTargets = new Set<string>();
    for (const m of (mappingCfg.enabled ? mappingCfg.mappings : [])) {
        if (!m.parentFolder) continue;
        const expanded = m.parentFolder.startsWith('~')
            ? path.join(os.homedir(), m.parentFolder.slice(1))
            : m.parentFolder;
        refreshTargets.add(path.resolve(expanded));
    }
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
        refreshTargets.add(path.resolve(folder.uri.fsPath));
    }
    for (const root of refreshTargets) {
        if (!isSwitchboardManagedFolder(root)) continue;
        try {
            await refreshWorkspaceControlPlane(root, context);
        } catch (err) {
            console.error(`[Switchboard] Control-plane refresh failed for ${root}, continuing:`, err);
        }
    }

    const globalPlanWatcher = new GlobalPlanWatcherService(
        (workspaceRoot: string) => (kanbanProvider as any)._getClickUpService(workspaceRoot),
        (workspaceRoot: string) => (kanbanProvider as any)._getLinearService(workspaceRoot),
        outputChannel
    );
    await globalPlanWatcher.initialize();
    context.subscriptions.push(globalPlanWatcher);

    const planAutoFetchService = new PlanAutoFetchService(
        () => kanbanProvider,
        outputChannel
    );
    await planAutoFetchService.initialize();
    context.subscriptions.push(planAutoFetchService);

    // Wire the watcher into the already-created KanbanProvider
    await kanbanProvider!.setGlobalPlanWatcher(globalPlanWatcher);

    // NOTE: the watcher stamps a newly-imported plan with the board's active project by
    // reading the `kanban.activeProjectFilter` config key the board syncs into each
    // workspace's DB on every refresh (KanbanProvider._refreshBoardImpl) and on
    // constructor restore from workspaceState. No resolver wiring is needed — the DB is
    // the single source of truth, read back from the same DB the plan imports into.

    // Let the watcher re-derive a feature's kanban_column from its subtasks after
    // every feature-file import, self-healing the clobber where insertFileDerivedPlan
    // hardcodes 'CREATED' on fresh INSERT (re-import after the 3000ms suppression
    // window, or the atomic-write DELETE->re-INSERT race). Mirrors the is_feature
    // re-assert already in _handlePlanFile; "new file" must NOT imply "CREATED".
    globalPlanWatcher.setFeatureColumnRecomputer(
        (featurePlanId: string, watchedRoot: string) =>
            kanbanProvider?.recomputeFeatureColumnFromSubtasks(featurePlanId, watchedRoot) ?? Promise.resolve()
    );

    // Let the watcher regenerate a feature's ## Subtasks block after a subtask .md is
    // deleted directly on disk (agent, git, manual rm). The watcher captures feature_id
    // before deletePlanByPlanFile and invokes this callback after, so the parent feature
    // file drops the removed subtask without waiting for an extension restart. Mirrors
    // the setFeatureColumnRecomputer injection pattern above.
    globalPlanWatcher.setFeatureFileRegenerator(
        (ws: string, fid: string) => kanbanProvider?.regenerateFeatureFile(ws, fid) ?? Promise.resolve()
    );

    const workspaceModeSetting = getEnforcedSwitchboardBooleanSetting('runtime.workspaceMode', false);

    // Workspace exclusion management (replaces legacy _runGitignoreMigrationV1)
    if (workspaceRoot) {
        const excludeService = new WorkspaceExcludeService(workspaceRoot);
        let pendingWorkspaceExcludeApply: ReturnType<typeof setTimeout> | undefined;
        const scheduleWorkspaceExcludeApply = () => {
            if (pendingWorkspaceExcludeApply) {
                clearTimeout(pendingWorkspaceExcludeApply);
            }
            pendingWorkspaceExcludeApply = setTimeout(() => {
                pendingWorkspaceExcludeApply = undefined;
                excludeService.apply().catch(err => {
                    console.warn('[Switchboard] Workspace exclusion re-evaluation error:', err);
                });
            }, 75);
        };
        excludeService.apply().catch(err => {
            console.warn('[Switchboard] Workspace exclusion setup error:', err);
        });

        context.subscriptions.push(
            vscode.workspace.onDidChangeConfiguration(e => {
                if (
                    e.affectsConfiguration('switchboard.workspace.ignoreStrategy')
                    || e.affectsConfiguration('switchboard.workspace.ignoreRules')
                ) {
                    scheduleWorkspaceExcludeApply();
                }
            })
        );
        context.subscriptions.push(new vscode.Disposable(() => {
            if (pendingWorkspaceExcludeApply) {
                clearTimeout(pendingWorkspaceExcludeApply);
            }
        }));
    }

    if (workspaceModeSetting.ignoredWorkspaceOverride) {
        console.warn('[Switchboard] Ignoring workspace-level overrides for security-critical settings; user-level values are enforced.');
    }

    // 0. LIFECYCLE CLEANUP: Scrub transient state before any subsystem initializes
    if (workspaceRoot) {
        const effectiveStateRoot = kanbanProvider!.resolveEffectiveWorkspaceRoot(workspaceRoot);
        // Scrub transient state before any subsystem initializes

        // Kill orphaned MCP server from a previous session that didn't shut down cleanly.
        // This is a one-time migration guard — the MCP server was removed, but a zombie
        // process from the old version may still be running if deactivate() never executed.
        try {
            const mcpPidPath = path.join(effectiveStateRoot, '.switchboard', '.mcp_server.pid');
            if (fs.existsSync(mcpPidPath)) {
                const pidStr = fs.readFileSync(mcpPidPath, 'utf8').trim();
                const pid = parseInt(pidStr, 10);
                if (Number.isFinite(pid) && pid > 0) {
                    try {
                        process.kill(pid, 0); // Check if process is still alive
                        // Process exists — kill it
                        try { process.kill(pid, 'SIGKILL'); } catch { }
                        outputChannel?.appendLine(`[Migration] Killed orphaned MCP server (PID: ${pid})`);
                    } catch {
                        // Process already dead — stale PID file, cleanWorkspace will remove it
                    }
                }
            }
        } catch {
            // PID file read failed — non-critical, continue activation
        }

        // Remove stale switchboard MCP entries from IDE config files.
        // The MCP server was removed — leftover entries cause IDEs to show
        // "MCP server not found" errors on every startup.
        try {
            const mcpConfigPaths = [
                { path: path.join(effectiveStateRoot, '.vscode', 'mcp.json'), key: 'servers' },
                { path: path.join(effectiveStateRoot, '.cursor', 'mcp.json'), key: 'mcpServers' },
                { path: path.join(effectiveStateRoot, '.mcp.json'), key: 'mcpServers' },
                { path: path.join(effectiveStateRoot, '.kiro', 'settings', 'mcp.json'), key: 'mcpServers' },
                { path: path.join(effectiveStateRoot, '.gemini', 'settings.json'), key: 'mcpServers' },
                { path: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'), key: 'mcpServers' }
            ];
            for (const { path: configPath, key } of mcpConfigPaths) {
                if (!fs.existsSync(configPath)) continue;
                try {
                    const raw = fs.readFileSync(configPath, 'utf8');
                    const config = JSON.parse(raw);
                    const section = config[key];
                    if (section && typeof section === 'object' && 'switchboard' in section) {
                        delete section['switchboard'];
                        // Remove empty section entirely
                        if (Object.keys(section).length === 0) {
                            delete config[key];
                        }
                        fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
                        outputChannel?.appendLine(`[Migration] Removed stale MCP entry from ${configPath}`);
                    }
                } catch {
                    // Config file corrupt or unreadable — skip
                }
            }
        } catch {
            // Non-critical — continue activation
        }

        // Warm the db before any state reads: the bridge's sync reads return
        // defaults on an unopened db, and ensureReady also runs the one-shot
        // legacy JSON → config-table migrations.
        try {
            await KanbanDatabase.forWorkspace(effectiveStateRoot).ensureReady();
        } catch {
            // db unavailable — bridge reads fall back to defaults
        }

        // Read old terminal names from state.json BEFORE cleanWorkspace resets it.
        // This lets us dispose orphaned terminals that survived a crash or restart
        // where deactivate() didn't run (or didn't finish).
        const oldTerminalNames = new Set<string>();
        try {
            const statePath = path.join(effectiveStateRoot, '.switchboard', 'state.json');
            if (fs.existsSync(statePath)) {
                const oldState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                if (oldState.terminals && typeof oldState.terminals === 'object') {
                    for (const name of Object.keys(oldState.terminals)) {
                        oldTerminalNames.add(name);
                    }
                }
            }
        } catch {
            // Corrupt or missing state — nothing to recover
        }

        await cleanWorkspace(effectiveStateRoot, outputChannel);
        console.timeLog('switchboard.activate', 'cleanWorkspace completed');

        // Remove legacy static rule files so the Kanban checkbox is the sole
        // control surface for git prohibition.
        const workspaceRoots = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
        for (const root of workspaceRoots) {
            await cleanupLegacyAgentFiles(root);
        }

        // Dispose orphaned Switchboard terminals from a previous session.
        // Prior logic only matched exact state.json names, which misses renamed/stale terminals.
        const knownAgentNames = new Set([
            'Lead Coder',
            'Coder',
            'Intern',
            'Reviewer',
            'Planner',
            'Analyst'
        ]);
        const switchboardPrefixPatterns = [
            /^Switchboard\b/i,
            /^mcp-agent/i,
            /^execution/i,
            /^verification/i,
            /^cortex/i
        ];

        const isLikelySwitchboardTerminal = (terminal: vscode.Terminal): boolean => {
            const creationName = ((terminal.creationOptions as vscode.TerminalOptions | undefined)?.name || '').trim();
            const terminalName = (terminal.name || '').trim();
            if (oldTerminalNames.has(terminalName) || oldTerminalNames.has(creationName)) return true;
            if (knownAgentNames.has(terminalName) || knownAgentNames.has(creationName)) return true;
            return switchboardPrefixPatterns.some(pattern => pattern.test(terminalName) || pattern.test(creationName));
        };

        for (const terminal of vscode.window.terminals) {
            if (terminal.exitStatus !== undefined) continue;
            if (!isLikelySwitchboardTerminal(terminal)) continue;
            outputChannel?.appendLine(`[CleanWorkspace] Disposing orphaned terminal: ${terminal.name}`);
            terminal.dispose();
        }

        // Clear in-memory terminal registry so stale references from a previous
        // activation don't leak into the new session.
        registeredTerminals.clear();
    }

    // 1. REGISTER SIDEBAR (Task Viewer)
    const taskViewerProvider = new TaskViewerProvider(context.extensionUri, context);
    activeTaskViewerProvider = taskViewerProvider;
    taskViewerProvider.setRegisteredTerminals(registeredTerminals);
    // Oversight-pass engine: completion signal = the watcher's plan-file mtime
    // advance (the activity-light OFF-switch). Also resumes a pass interrupted
    // by an extension reload from .switchboard/oversight-state.md.
    taskViewerProvider.attachOversightWatcher(globalPlanWatcher);
    context.subscriptions.push(taskViewerProvider);
    if (workspaceRoot) {
        void taskViewerProvider.deregisterAllTerminals(true).then(() => {
            outputChannel?.appendLine('[Startup] Auto-reset agent terminals completed.');
        }).catch((e) => {
            outputChannel?.appendLine(`[Startup] Auto-reset agent terminals failed: ${e}`);
        }).finally(() => {
            // Fire-and-forget terminal reclaim after deregistration completes/fails
            const runtimeStateRoot = kanbanProvider!.resolveEffectiveWorkspaceRoot(workspaceRoot) || workspaceRoot;
            void syncTerminalRegistryWithState(runtimeStateRoot);
        });
    }
    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(
            "switchboard-view",
            taskViewerProvider
        )
    );

    // Start the unified Plan Scanner at activation (not just on webview resolve) so it
    // claims newly generated IDE plans even when the Switchboard panel is minimised,
    // unfocused, or never opened this session, and on the first sweep after a restart.
    // It governs ONLY external IDE plan sources and never touches GlobalPlanWatcher.
    taskViewerProvider.startPlanScanner();

    // Register core commands immediately after primary dependencies are ready.
    // This prevents 'command not found' errors if the user interacts with the
    // sidebar (e.g. clicks "OPEN AGENT TERMINALS") before the rest of activation completes.
    const setupDisposable = registerSwitchboardCommand('switchboard.setup', async () => {
        await showSetupWizard(context, taskViewerProvider);
    });
    context.subscriptions.push(setupDisposable);

    const initiatePlanDisposable = registerSwitchboardCommand('switchboard.initiatePlan', async () => {
        await taskViewerProvider?.createDraftPlanTicket();
    });
    context.subscriptions.push(initiatePlanDisposable);

    const importFromClipboardDisposable = registerSwitchboardCommand('switchboard.importPlanFromClipboard', async (markdownText?: string) => {
        await taskViewerProvider?.importPlanFromClipboard(markdownText);
    });
    context.subscriptions.push(importFromClipboardDisposable);

    const importNotebookLMPlansDisposable = registerSwitchboardCommand('switchboard.importNotebookLMPlans', async (workspaceRoot?: string) => {
        return await taskViewerProvider?.importNotebookLMPlans(workspaceRoot);
    });
    context.subscriptions.push(importNotebookLMPlansDisposable);

    const selectSessionDisposable = registerSwitchboardCommand('switchboard.selectSession', (sessionId: string) => {
        if (typeof sessionId === 'string' && sessionId.trim()) {
            taskViewerProvider.selectSession(sessionId);
        }
    });
    context.subscriptions.push(selectSessionDisposable);

    const createAgentGridDisposable = registerSwitchboardCommand('switchboard.createAgentGrid', async (args?: any) => {
        await createAgentGrid(args);
    });
    const createAgentGridEditorDisposable = registerSwitchboardCommand('switchboard.createAgentGridEditor', async () => {
        await createAgentGrid();
    });
    const disposeAllGridTerminalsDisposable = vscode.commands.registerCommand('switchboard.disposeAllGridTerminals', async () => {
        await disposeAllGridTerminals();
    });
    context.subscriptions.push(createAgentGridDisposable);
    context.subscriptions.push(createAgentGridEditorDisposable);
    context.subscriptions.push(disposeAllGridTerminalsDisposable);

    // Kanban Board
    const setupPanelProvider = new SetupPanelProvider(context.extensionUri);
    context.subscriptions.push(kanbanProvider);
    context.subscriptions.push(setupPanelProvider);
    taskViewerProvider.setKanbanProvider(kanbanProvider);
    taskViewerProvider.setSetupPanelProvider(setupPanelProvider);
    kanbanProvider!.setTaskViewerProvider(taskViewerProvider);
    setupPanelProvider.setTaskViewerProvider(taskViewerProvider);
    setupPanelProvider.setKanbanProvider(kanbanProvider!);
    const resolveEffectiveStateRoot = (candidateWorkspaceRoot?: string): string | null => {
        const selectedWorkspaceRoot = candidateWorkspaceRoot || kanbanProvider!.getCurrentWorkspaceRoot();
        if (!selectedWorkspaceRoot) {
            return null;
        }
        return kanbanProvider!.resolveEffectiveWorkspaceRoot(selectedWorkspaceRoot);
    };

    const getStateJsonPath = (candidateWorkspaceRoot?: string): string | null => {
        const stateRoot = resolveEffectiveStateRoot(candidateWorkspaceRoot);
        if (!stateRoot) {
            return null;
        }
        return path.join(stateRoot, '.switchboard', 'state.json');
    };
    // Runs once per activation; idempotent — only rewrites rules still on the old defaults.
    const migrateTriageRuleDefaults = async (): Promise<void> => {
        if (!kanbanProvider || !activeTaskViewerProvider) {
            return;
        }
        const roots = kanbanProvider.getWorkspaceRoots();
        for (const root of roots) {
            // ClickUp
            try {
                const clickSvc = activeTaskViewerProvider.getClickUpService(root);
                const cfg = await clickSvc.loadConfig();
                if (cfg?.automationRules?.length) {
                    let changed = false;
                    cfg.automationRules = cfg.automationRules.map((rule) => {
                        if (/^Triage\s*—/i.test(rule.name)
                            && rule.targetColumn === 'CREATED'
                            && rule.finalColumn === 'DONE') {
                            changed = true;
                            return { ...rule, targetColumn: 'TICKET UPDATER', finalColumn: 'COMPLETED' };
                        }
                        return rule;
                    });
                    if (changed) { await clickSvc.saveConfig(cfg); }
                }
            } catch { /* ignore — provider not configured */ }

            // Linear
            try {
                const linSvc = activeTaskViewerProvider.getLinearService(root);
                const cfg = await linSvc.loadConfig();
                if (cfg?.automationRules?.length) {
                    let changed = false;
                    cfg.automationRules = cfg.automationRules.map((rule) => {
                        if (/^Triage\s*—/i.test(rule.name)
                            && rule.targetColumn === 'CREATED'
                            && rule.finalColumn === 'DONE') {
                            changed = true;
                            return { ...rule, targetColumn: 'TICKET UPDATER', finalColumn: 'COMPLETED' };
                        }
                        return rule;
                    });
                    if (changed) { await linSvc.saveConfig(cfg); }
                }
            } catch { /* ignore — provider not configured */ }
        }
    };

    void migrateTriageRuleDefaults().then(() => {
        void kanbanProvider!.initializeIntegrationAutoPull();
        void kanbanProvider!.startAutoArchiveForAll();
    }).catch(err => {
        console.error('[Switchboard] Error migrating triage rule defaults:', err);
        void kanbanProvider!.initializeIntegrationAutoPull();
        void kanbanProvider!.startAutoArchiveForAll();
    });
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void kanbanProvider!.initializeIntegrationAutoPull();
            void kanbanProvider!.startAutoArchiveForAll();
            // Deferred migration: if activation happened with no workspace folders,
            // run the global integration config migration now that a workspace is open.
            void MigrationService.runMigration();
        })
    );
    if (workspaceRoot) {
        await taskViewerProvider.initializeKanbanDbOnStartup();
    }
    const openKanbanDisposable = registerSwitchboardCommand('switchboard.openKanban', async (tab?: string) => {
        await kanbanProvider!.open(tab);
    });
    context.subscriptions.push(openKanbanDisposable);

    const openMemoDisposable = vscode.commands.registerCommand('switchboard.openMemo', async () => {
        await taskViewerProvider!.openMemoTab();
    });
    context.subscriptions.push(openMemoDisposable);

    // Shared cache service factory — one instance per workspace root
    const _cacheServiceInstances = new Map<string, PlanningPanelCacheService>();
    const getCacheService = (root: string): PlanningPanelCacheService => {
        const resolved = path.resolve(root);
        let service = _cacheServiceInstances.get(resolved);
        if (!service) {
            const kanbanDb = KanbanDatabase.forWorkspace(resolved);
            service = new PlanningPanelCacheService(resolved, kanbanDb);
            _cacheServiceInstances.set(resolved, service);
        }
        return service;
    };

    // Research Panel Setup
    const plannerPromptWriter = new PlannerPromptWriter({
        getNotionService: (root) => (kanbanProvider as any)._getNotionService(root),
        getLocalFolderService: (root) => new LocalFolderService(root),
        getLinearDocsAdapter: (root) => (kanbanProvider as any)._getLinearDocsAdapter(root),
        getClickUpDocsAdapter: (root) => (kanbanProvider as any)._getClickUpDocsAdapter(root),
        getCacheService
    });
    kanbanProvider!.setPlannerPromptWriter(plannerPromptWriter);

    const researchImportService = new ResearchImportService();
    // Adapters will be registered lazily when needed via KanbanProvider factory methods

    const planningStateStore = new PanelStateStore(context.globalState, 'planning');
    const designStateStore = new PanelStateStore(context.globalState, 'design');

    const planningPanelProvider = new PlanningPanelProvider(
        context.extensionUri,
        researchImportService,
        plannerPromptWriter,
        () => {
            return kanbanProvider!.getCurrentWorkspaceRoot()
                ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        },
        {
            getNotionService: (root) => (kanbanProvider as any)._getNotionService(root),
            getNotionBrowseService: (root) => new NotionBrowseService(root, (kanbanProvider as any)._getNotionService(root)),
            getLinearDocsAdapter: (root) => (kanbanProvider as any)._getLinearDocsAdapter(root),
            getClickUpDocsAdapter: (root) => (kanbanProvider as any)._getClickUpDocsAdapter(root),
            getCacheService,
            getLinearSyncService: (root) => (kanbanProvider as any)._getLinearService(root),
            getClickUpSyncService: (root) => (kanbanProvider as any)._getClickUpService(root)
        },
        context,
        planningStateStore
    );
    context.subscriptions.push(planningPanelProvider);
    kanbanProvider!.setPlanningPanelProvider(planningPanelProvider);
    planningPanelProvider.setKanbanProvider(kanbanProvider!);
    planningPanelProvider.setTaskViewerProvider(taskViewerProvider);
    planningPanelProvider.setPlanAutoFetchService(planAutoFetchService);

    const designPanelProvider = new DesignPanelProvider(
        context.extensionUri,
        () => {
            return kanbanProvider!.getCurrentWorkspaceRoot()
                ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        },
        context,
        designStateStore,
        taskViewerProvider
    );
    context.subscriptions.push(designPanelProvider);

    taskViewerProvider.setDesignPanelProvider(designPanelProvider);
    taskViewerProvider.setPlanningPanelProvider(planningPanelProvider);

    // Migration: Remove dead Stitch OAuth auth mode (shipped in prior releases).
    // Reset any stale 'oauth' authMode to 'apiKey' and delete the dead accessToken secret.
    {
        const stitchConfig = vscode.workspace.getConfiguration('switchboard');
        const staleAuthMode = stitchConfig.get<string>('stitch.authMode');
        if (staleAuthMode === 'oauth') {
            await stitchConfig.update('stitch.authMode', 'apiKey', vscode.ConfigurationTarget.Global);
        }
        await context.secrets.delete('switchboard.stitch.accessToken');
    }

    const openPlanningPanelDisposable = registerSwitchboardCommand(
        'switchboard.openPlanningPanel',
        async () => { await planningPanelProvider.open(); }
    );
    context.subscriptions.push(openPlanningPanelDisposable);

    const openProjectPanelDisposable = registerSwitchboardCommand(
        'switchboard.openProjectPanel',
        async () => { await planningPanelProvider.openProject(); }
    );
    context.subscriptions.push(openProjectPanelDisposable);

    const openDesignPanelDisposable = registerSwitchboardCommand(
        'switchboard.openDesignPanel',
        async () => { await designPanelProvider.open(); }
    );
    context.subscriptions.push(openDesignPanelDisposable);

    const openSetupPanelDisposable = registerSwitchboardCommand('switchboard.openSetupPanel', async (section?: string) => {
        await setupPanelProvider.open(typeof section === 'string' ? section : undefined);
    });
    context.subscriptions.push(openSetupPanelDisposable);
    const scaffoldMultiRepoDisposable = vscode.commands.registerCommand('switchboard.scaffoldMultiRepo', async () => {
        await vscode.commands.executeCommand('switchboard.openSetupPanel', 'control-plane:fresh-setup');
    });
    context.subscriptions.push(scaffoldMultiRepoDisposable);
    const setupControlPlaneDisposable = vscode.commands.registerCommand('switchboard.setupControlPlane', async () => {
        await setupPanelProvider.open('control-plane');
    });
    context.subscriptions.push(setupControlPlaneDisposable);
    const clearControlPlaneCacheDisposable = registerSwitchboardCommand('switchboard.clearControlPlaneCache', async () => {
        const selectedWorkspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!selectedWorkspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            'Clear cached control-plane trust/rejection decisions and re-run auto-detect?',
            { modal: true },
            'Clear Cache'
        );
        if (confirm !== 'Clear Cache') {
            return;
        }
        await kanbanProvider!.clearControlPlaneCache(selectedWorkspaceRoot);
        await vscode.commands.executeCommand('switchboard.refreshControlPlaneRuntime');
        await taskViewerProvider.postSetupPanelState(selectedWorkspaceRoot);
        await taskViewerProvider.refreshUI(selectedWorkspaceRoot);
        if (setupPanelProvider.isOpen) {
            await setupPanelProvider.open('control-plane');
        }
    });
    context.subscriptions.push(clearControlPlaneCacheDisposable);
    const refreshControlPlaneRuntimeDisposable = registerSwitchboardCommand('switchboard.refreshControlPlaneRuntime', async () => {
        const selectedWorkspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!selectedWorkspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }
        const stateRoot = resolveEffectiveStateRoot(selectedWorkspaceRoot) || selectedWorkspaceRoot;
        await syncTerminalRegistryWithState(stateRoot);
        taskViewerProvider.refresh();
    });
    context.subscriptions.push(refreshControlPlaneRuntimeDisposable);

    if (workspaceRoot) {
        void maybeOfferControlPlaneOnboarding(workspaceRoot);
    }

    // Full sync: file→DB sync + refresh both sidebar and kanban from DB
    const fullSyncDisposable = registerSwitchboardCommand('switchboard.fullSync', async () => {
        await taskViewerProvider.fullSync();
    });
    context.subscriptions.push(fullSyncDisposable);

    // Manual "Import plans" — list unclaimed plans across configured sources (any age)
    // and let the user pick which to add to the board.
    const importPlansDisposable = registerSwitchboardCommand('switchboard.importUnclaimedPlans', async () => {
        await taskViewerProvider.handleImportUnclaimedPlans();
    });
    context.subscriptions.push(importPlansDisposable);

    const copyChatPromptDisposable = vscode.commands.registerCommand('switchboard.copyChatPrompt', async (targetWorkspaceRoot?: string, projectName?: string) => {
        const workspaceRoot = targetWorkspaceRoot || kanbanProvider?.getCurrentWorkspaceRoot() || undefined;
        if (!kanbanProvider) {
            vscode.window.showErrorMessage('Switchboard extension not fully initialized.');
            return;
        }
        const prompt = await kanbanProvider.copyGeneralChatPrompt(workspaceRoot, projectName);
        if (!prompt) {
            vscode.window.showWarningMessage('No active workspace selected or found.');
            return;
        }
        return prompt;
    });
    context.subscriptions.push(copyChatPromptDisposable);

    // Reset Kanban Database command — deletes local DB and rebuilds from plan files
    const resetKanbanDbDisposable = registerSwitchboardCommand('switchboard.resetKanbanDb', async (targetWorkspaceRoot?: string) => {
        const workspaceRoot = targetWorkspaceRoot || kanbanProvider!.getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }

        const confirm = await vscode.window.showWarningMessage(
            'This will delete the local Kanban database and rebuild it. If a backup exists, column assignments will be restored first, then plan files will be re-imported. Continue?',
            { modal: true },
            'Reset'
        );
        if (confirm !== 'Reset') return;

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        const dbFilePath = db.dbPath;

        await KanbanDatabase.invalidateWorkspace(workspaceRoot);

        try {
            if (fs.existsSync(dbFilePath)) {
                await fs.promises.unlink(dbFilePath);
            }
        } catch (err) {
            vscode.window.showErrorMessage(`Failed to delete DB: ${err}`);
            return;
        }

        const backupPath = path.join(workspaceRoot, '.switchboard', 'kanban-state-backup.json');
        let restoreResult = { restored: 0, skipped: 0 };
        if (fs.existsSync(backupPath)) {
            try {
                await db.createIfMissing();
                restoreResult = await db.restoreFromBackup(backupPath);
            } catch (e) {
                console.error('[resetKanbanDb] Backup restore failed:', e);
            }
        }

        const importResult = await importPlanFiles(
            workspaceRoot,
            resolveEffectiveStateRoot(workspaceRoot) || workspaceRoot
        );
        await vscode.commands.executeCommand('switchboard.fullSync');

        // Trigger integration sync for imported plans (uses actual kanban column from DB)
        if (importResult.planFiles.length > 0) {
            await vscode.commands.executeCommand('switchboard.syncImportedPlans', workspaceRoot, importResult);
        }

        const restoredPart = restoreResult.restored > 0 ? `Restored ${restoreResult.restored} plan(s) from backup. ` : '';
        showTemporaryNotification(
            `Kanban database reset. ${restoredPart}Imported ${importResult.count} plan(s) from .switchboard/plans/.`
        );
    });
    context.subscriptions.push(resetKanbanDbDisposable);

    const syncImportedPlansDisposable = vscode.commands.registerCommand(
        'switchboard.syncImportedPlans',
        async (workspaceRoot: string, importResult: { planFiles: string[]; columns: Record<string, string> }) => {
            if (!kanbanProvider || !importResult.planFiles.length) return;
            for (const planFile of importResult.planFiles) {
                const targetColumn = importResult.columns[planFile] || 'CREATED';
                await kanbanProvider!.queueIntegrationSyncForPlanFile(workspaceRoot, planFile, targetColumn);
            }
        }
    );
    context.subscriptions.push(syncImportedPlansDisposable);

    // Reconcile Kanban Databases command — merge split databases
    const reconcileKanbanDisposable = registerSwitchboardCommand('switchboard.reconcileKanbanDbs', async () => {
        const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }
        const homedir = os.homedir();
        const candidates = [
            { label: 'Local', path: KanbanDatabase.defaultDbPath(workspaceRoot) },
            { label: 'Configured', path: KanbanDatabase.forWorkspace(workspaceRoot).dbPath },
            { label: 'iCloud', path: path.join(homedir, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'Switchboard', 'kanban.db') },
            { label: 'Dropbox', path: path.join(homedir, 'Dropbox', 'Switchboard', 'kanban.db') },
        ];

        // De-duplicate by resolved path and find existing DBs
        const seen = new Set<string>();
        const found: { label: string; dbPath: string; count: number }[] = [];
        for (const c of candidates) {
            const resolved = path.resolve(c.path);
            if (seen.has(resolved)) continue;
            seen.add(resolved);
            if (fs.existsSync(resolved)) {
                const count = await KanbanDatabase.countPlansInFile(resolved);
                found.push({ label: c.label, dbPath: resolved, count });
            }
        }

        if (found.length < 2) {
            showTemporaryNotification('Only one database found. Nothing to reconcile.');
            return;
        }

        const source = await vscode.window.showQuickPick(
            found.map(f => ({ label: `${f.label} (${f.count} plans)`, description: f.dbPath, detail: f.dbPath })),
            { placeHolder: 'Select SOURCE database (copy FROM)' }
        );
        if (!source) return;

        const target = await vscode.window.showQuickPick(
            found.filter(f => f.dbPath !== source.detail).map(f => ({ label: `${f.label} (${f.count} plans)`, description: f.dbPath, detail: f.dbPath })),
            { placeHolder: 'Select TARGET database (merge INTO)' }
        );
        if (!target) return;

        const confirmMerge = await vscode.window.showWarningMessage(
            `Merge ${source.label} → ${target.label}? Conflicts resolved by newest updated_at.`,
            { modal: true },
            'Merge'
        );
        if (confirmMerge !== 'Merge') return;

        try {
            const merged = await KanbanDatabase.reconcileDatabases(source.detail!, target.detail!);
            await KanbanDatabase.invalidateWorkspace(workspaceRoot);
            vscode.commands.executeCommand('switchboard.refreshUI');
            showTemporaryNotification(`✅ Reconciliation complete. ${merged} plans merged.`);
        } catch (err) {
            vscode.window.showErrorMessage(`Reconciliation failed: ${err instanceof Error ? err.message : String(err)}`);
        }
    });
    context.subscriptions.push(reconcileKanbanDisposable);

    // Invalidate DB cache when kanban.dbPath setting changes
    context.subscriptions.push(
        vscode.workspace.onDidChangeConfiguration(async e => {
            if (e.affectsConfiguration('switchboard.kanban.dbPath')) {
                const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
                if (workspaceRoot) {
                    await KanbanDatabase.invalidateWorkspace(workspaceRoot);
                    vscode.commands.executeCommand('switchboard.refreshUI');
                }
            }
        })
    );

    const refreshUIDisposable = registerSwitchboardCommand('switchboard.refreshUI', async (workspaceRoot?: string) => {
        await taskViewerProvider.refreshUI(workspaceRoot);
    });
    context.subscriptions.push(refreshUIDisposable);

    const mappingsChangedDisposable = registerSwitchboardCommand('switchboard.mappingsChanged', async () => {
        // Clear mapping cache
        const { clearMappingCache } = require('./services/WorkspaceIdentityService');
        clearMappingCache();
        // Rebuild index
        await initializeMappingIndex(outputChannel ?? undefined);
        // Refresh UI
        kanbanProvider!._scheduleBoardRefresh();
        // Tell watchers to refresh. The active project is no longer mirrored in the
        // watcher — it lives in each DB's `kanban.activeProjectFilter` config key and is
        // re-synced by the board refresh scheduled just above, so there is nothing to clear.
        if (globalPlanWatcher) {
            await globalPlanWatcher.refreshWatchers();
        }
    });
    context.subscriptions.push(mappingsChangedDisposable);

    // Helper commands for Kanban ↔ sidebar delegation
    const triggerFromKanbanDisposable = registerSwitchboardCommand('switchboard.triggerAgentFromKanban', async (role: string, sessionId: string, instruction?: string, workspaceRoot?: string, targetTerminalOverride?: string) => {
        return await taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot, { targetTerminalOverride, persistColumnOnError: true } as any);
    });
    context.subscriptions.push(triggerFromKanbanDisposable);

    const analystMapFromKanbanDisposable = registerSwitchboardCommand('switchboard.analystMapFromKanban', async (sessionId: string, workspaceRoot?: string) => {
        return await taskViewerProvider.handleAnalystContextMap(sessionId, workspaceRoot);
    });
    context.subscriptions.push(analystMapFromKanbanDisposable);

    const analystMapBatchFromKanbanDisposable = vscode.commands.registerCommand('switchboard.analystMapFromKanbanBatch', async (sessionIds: string[], workspaceRoot?: string) => {
        return await taskViewerProvider.handleAnalystContextMapBatch(sessionIds, workspaceRoot);
    });
    context.subscriptions.push(analystMapBatchFromKanbanDisposable);

    const triggerPlanScanDisposable = vscode.commands.registerCommand('switchboard.triggerPlanScan', async () => {
        await kanbanProvider!.triggerPlanScan();
    });
    context.subscriptions.push(triggerPlanScanDisposable);

    const batchTriggerFromKanbanDisposable = registerSwitchboardCommand('switchboard.triggerBatchAgentFromKanban', async (role: string, sessionIds: string[], instruction?: string, workspaceRoot?: string, targetTerminalOverride?: string) => {
        return taskViewerProvider.handleKanbanBatchTrigger(role, sessionIds, instruction, workspaceRoot, targetTerminalOverride);
    });
    context.subscriptions.push(batchTriggerFromKanbanDisposable);

    const batchDispatchLowDisposable = registerSwitchboardCommand('switchboard.batchDispatchLow', async (workspaceRoot?: string) => {
        return taskViewerProvider.handleBatchDispatchLow(workspaceRoot);
    });
    context.subscriptions.push(batchDispatchLowDisposable);

    const kanbanBackwardMoveDisposable = registerSwitchboardCommand('switchboard.kanbanBackwardMove', async (sessionIds: string[], targetColumn: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleKanbanBackwardMove(sessionIds, targetColumn, workspaceRoot);
    });
    context.subscriptions.push(kanbanBackwardMoveDisposable);

    const kanbanForwardMoveDisposable = registerSwitchboardCommand('switchboard.kanbanForwardMove', async (sessionIds: string[], targetColumn: string, workspaceRoot?: string, sourceColumn?: string) => {
        return taskViewerProvider.handleKanbanForwardMove(sessionIds, targetColumn, workspaceRoot, sourceColumn);
    });
    context.subscriptions.push(kanbanForwardMoveDisposable);

    const completePlanFromKanbanDisposable = registerSwitchboardCommand('switchboard.completePlanFromKanban', async (sessionId: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleKanbanCompletePlan(sessionId, workspaceRoot);
    });
    context.subscriptions.push(completePlanFromKanbanDisposable);

    const restorePlanFromKanbanDisposable = registerSwitchboardCommand('switchboard.restorePlanFromKanban', async (planId: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleKanbanRestorePlan(planId, workspaceRoot);
    });
    context.subscriptions.push(restorePlanFromKanbanDisposable);

    const deletePlanFromReviewDisposable = vscode.commands.registerCommand('switchboard.deletePlanFromReview', async (sessionId: string, workspaceRoot?: string, planFileAbsolute?: string) => {
        return taskViewerProvider.handleDeletePlanFromReview(sessionId, workspaceRoot, planFileAbsolute);
    });
    context.subscriptions.push(deletePlanFromReviewDisposable);

    const copyPlanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.copyPlanFromKanban', async (sessionId: string, column?: string, workspaceRoot?: string) => {
        return await taskViewerProvider.handleKanbanCopyPlan(sessionId, column, workspaceRoot);
    });
    context.subscriptions.push(copyPlanFromKanbanDisposable);

    const moveKanbanCardByPlanFileDisposable = vscode.commands.registerCommand(
        'switchboard.moveKanbanCardByPlanFile',
        async (workspaceRoot: string, planFile: string, targetColumn: string) => {
            return await kanbanProvider!.moveCardToColumnByPlanFile(workspaceRoot, planFile, targetColumn);
        }
    );
    context.subscriptions.push(moveKanbanCardByPlanFileDisposable);

    const setAutobanFromKanbanDisposable = registerSwitchboardCommand('switchboard.setAutobanEnabledFromKanban', async (enabled: boolean) => {
        await taskViewerProvider.setAutobanEnabledFromKanban(!!enabled);
    });
    context.subscriptions.push(setAutobanFromKanbanDisposable);

    const resetAutobanTimersDisposable = registerSwitchboardCommand('switchboard.resetAutobanTimersFromKanban', async () => {
        await taskViewerProvider.resetAutobanTimersFromKanban();
    });
    context.subscriptions.push(resetAutobanTimersDisposable);

    const setAutobanPausedDisposable = registerSwitchboardCommand('switchboard.setAutobanPausedFromKanban', async (paused: boolean) => {
        await taskViewerProvider.setAutobanPausedFromKanban(!!paused);
    });
    context.subscriptions.push(setAutobanPausedDisposable);

    const setPairProgrammingModeDisposable = registerSwitchboardCommand('switchboard.setPairProgrammingModeFromKanban', async (mode: string) => {
        await taskViewerProvider.setPairProgrammingMode(mode);
    });
    context.subscriptions.push(setPairProgrammingModeDisposable);

    const addAutobanTerminalDisposable = registerSwitchboardCommand('switchboard.addAutobanTerminalFromKanban', async (role: string, requestedName?: string, cwd?: string) => {
        await taskViewerProvider.addAutobanTerminalFromKanban(role, requestedName, cwd);
    });
    context.subscriptions.push(addAutobanTerminalDisposable);

    const revealWorktreeTerminalDisposable = vscode.commands.registerCommand('switchboard.revealWorktreeTerminal', async (worktreePath: string) => {
        await taskViewerProvider.revealWorktreeTerminal(worktreePath);
    });
    context.subscriptions.push(revealWorktreeTerminalDisposable);

    const removeAutobanTerminalDisposable = registerSwitchboardCommand('switchboard.removeAutobanTerminalFromKanban', async (role: string, terminalName: string) => {
        await taskViewerProvider.removeAutobanTerminalFromKanban(role, terminalName);
    });
    context.subscriptions.push(removeAutobanTerminalDisposable);

    const launchMcpMonitorTerminalDisposable = registerSwitchboardCommand('switchboard.launchMcpMonitorTerminal', async () => {
        await taskViewerProvider.launchMcpMonitorTerminal();
    });
    context.subscriptions.push(launchMcpMonitorTerminalDisposable);

    const stopMcpMonitorTerminalDisposable = registerSwitchboardCommand('switchboard.stopMcpMonitorTerminal', async () => {
        await taskViewerProvider.stopMcpMonitorTerminal();
    });
    context.subscriptions.push(stopMcpMonitorTerminalDisposable);

    const checkMcpMonitorAuthDisposable = registerSwitchboardCommand('switchboard.checkMcpMonitorAuth', async () => {
        await taskViewerProvider.checkMcpMonitorAuth();
    });
    context.subscriptions.push(checkMcpMonitorAuthDisposable);

    const startMcpMonitorPollingDisposable = registerSwitchboardCommand('switchboard.startMcpMonitorPolling', async () => {
        await taskViewerProvider.startMcpMonitorPolling();
    });
    context.subscriptions.push(startMcpMonitorPollingDisposable);

    const stopMcpMonitorPollingDisposable = registerSwitchboardCommand('switchboard.stopMcpMonitorPolling', async () => {
        await taskViewerProvider.stopMcpMonitorPolling();
    });
    context.subscriptions.push(stopMcpMonitorPollingDisposable);

    const resetAutobanPoolsDisposable = registerSwitchboardCommand('switchboard.resetAutobanPoolsFromKanban', async () => {
        await taskViewerProvider.resetAutobanPoolsFromKanban();
    });
    context.subscriptions.push(resetAutobanPoolsDisposable);

    const dispatchToCoderTerminalDisposable = registerSwitchboardCommand('switchboard.dispatchToCoderTerminal', async (prompt: string, worktreePath?: string) => {
        await taskViewerProvider.dispatchToCoderTerminal(prompt, worktreePath);
    });
    context.subscriptions.push(dispatchToCoderTerminalDisposable);

    const setClickUpTokenDisposable = vscode.commands.registerCommand('switchboard.setClickUpToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your ClickUp API token (starts with pk_)',
            password: true,
            placeHolder: 'pk_...',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim().length < 10) {
                    return 'Token appears too short. ClickUp tokens typically start with pk_';
                }
                return null;
            }
        });
        if (token) {
            await context.secrets.store('switchboard.clickup.apiToken', token.trim());
            const workspaceRoot = kanbanProvider?.getCurrentWorkspaceRoot();
            if (workspaceRoot) {
                (kanbanProvider as any)._getClickUpService(workspaceRoot)?.clearApiTokenCache();
            }
            showTemporaryNotification('ClickUp API token saved securely.');
        }
    });
    context.subscriptions.push(setClickUpTokenDisposable);

    const importFromClickUpDisposable = vscode.commands.registerCommand('switchboard.importFromClickUp', async () => {
        const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }

        const syncService = new ClickUpSyncService(workspaceRoot, context.secrets);
        const config = await syncService.loadConfig();

        if (!config?.setupComplete) {
            const choice = await vscode.window.showWarningMessage(
                'ClickUp is not configured. Open the Setup panel first.',
                'Open Setup Panel'
            );
            if (choice === 'Open Setup Panel') {
                await vscode.commands.executeCommand('switchboard.openSetupPanel', 'project-mgmt');
            }
            return;
        }

        const listOptions = Object.entries(config.columnMappings)
            .filter(([, listId]) => listId)
            .map(([column, listId]) => ({ label: column, description: `List ID: ${listId}`, listId }));

        if (listOptions.length === 0) {
            const choice = await vscode.window.showErrorMessage(
                'No ClickUp lists are mapped. Update ClickUp in the Setup panel first.',
                'Open Setup Panel'
            );
            if (choice === 'Open Setup Panel') {
                await vscode.commands.executeCommand('switchboard.openSetupPanel', 'project-mgmt');
            }
            return;
        }

        const selected = await vscode.window.showQuickPick(listOptions, { placeHolder: 'Select a ClickUp list to import tasks from' });
        if (!selected) {
            return;
        }

        const plansDir = await taskViewerProvider.getPlanIngestionFolder(workspaceRoot) || path.join(workspaceRoot, '.switchboard', 'plans');

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Importing from ClickUp...', cancellable: false },
            async () => {
                const result = await syncService.importTasksFromClickUp(selected.listId, plansDir);
                if (!result.success) {
                    vscode.window.showErrorMessage(`Import failed: ${result.error}`);
                    return;
                }

                const msg = result.imported === 0
                    ? `No new tasks to import (${result.skipped} already tracked).`
                    : `Imported ${result.imported} task${result.imported !== 1 ? 's' : ''} as plan files.${result.skipped ? ` (${result.skipped} skipped)` : ''}`;
                showTemporaryNotification(msg);
            }
        );
    });
    context.subscriptions.push(importFromClickUpDisposable);

    const clickupFindListDisposable = vscode.commands.registerCommand('switchboard.clickupFindList', async (listName: string) => {
        return taskViewerProvider.handleClickupFindList(listName);
    });
    context.subscriptions.push(clickupFindListDisposable);

    const clickupFindTaskDisposable = vscode.commands.registerCommand('switchboard.clickupFindTask', async (listId: string, taskName: string) => {
        return taskViewerProvider.handleClickupFindTask(listId, taskName);
    });
    context.subscriptions.push(clickupFindTaskDisposable);

    const clickupSearchTasksDisposable = vscode.commands.registerCommand('switchboard.clickupSearchTasks', async (query: string, listId?: string) => {
        return taskViewerProvider.handleClickupSearchTasks(query, listId);
    });
    context.subscriptions.push(clickupSearchTasksDisposable);

    const clickupGetSubtasksDisposable = vscode.commands.registerCommand('switchboard.clickupGetSubtasks', async (parentId: string) => {
        return taskViewerProvider.handleClickupGetSubtasks(parentId);
    });
    context.subscriptions.push(clickupGetSubtasksDisposable);

    const clickupCreateTaskDisposable = vscode.commands.registerCommand(
        'switchboard.clickupCreateTask',
        async (
            listId: string,
            name: string,
            options?: { description?: string; status?: string; parentId?: string; priority?: number }
        ) => {
            return taskViewerProvider.handleClickupCreateTask(listId, name, options);
        }
    );
    context.subscriptions.push(clickupCreateTaskDisposable);

    const clickupUpdateTaskDisposable = vscode.commands.registerCommand(
        'switchboard.clickupUpdateTask',
        async (taskId: string, options: { name?: string; description?: string; status?: string }) => {
            return taskViewerProvider.handleClickupUpdateTask(taskId, options);
        }
    );
    context.subscriptions.push(clickupUpdateTaskDisposable);

    const clickupAddCommentDisposable = vscode.commands.registerCommand('switchboard.clickupAddComment', async (taskId: string, comment: string) => {
        return taskViewerProvider.handleClickupAddComment(taskId, comment);
    });
    context.subscriptions.push(clickupAddCommentDisposable);

    const setLinearTokenDisposable = vscode.commands.registerCommand('switchboard.setLinearToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your Linear API token',
            password: true,
            placeHolder: 'lin_api_...',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim().length < 10) {
                    return 'Token appears too short.';
                }
                return null;
            }
        });
        if (token) {
            await context.secrets.store('switchboard.linear.apiToken', token.trim());
            const workspaceRoot = kanbanProvider?.getCurrentWorkspaceRoot();
            if (workspaceRoot) {
                (kanbanProvider as any)._getLinearService(workspaceRoot)?.clearApiTokenCache();
            }
            showTemporaryNotification('Linear API token saved securely.');
        }
    });
    context.subscriptions.push(setLinearTokenDisposable);

    const setNotionTokenDisposable = vscode.commands.registerCommand('switchboard.setNotionToken', async () => {
        const token = await vscode.window.showInputBox({
            prompt: 'Enter your Notion integration token',
            password: true,
            placeHolder: 'secret_... or ntn_...',
            ignoreFocusOut: true,
            validateInput: (value) => {
                if (!value || value.trim().length < 10) {
                    return 'Token appears too short.';
                }
                const t = value.trim();
                if (!t.startsWith('secret_') && !t.startsWith('ntn_')) {
                    return 'Notion tokens typically start with "secret_" or "ntn_"';
                }
                return null;
            }
        });
        if (token) {
            await context.secrets.store('switchboard.notion.apiToken', token.trim());
            showTemporaryNotification('Notion API token saved securely.');
        }
    });
    context.subscriptions.push(setNotionTokenDisposable);



    const importFromLinearDisposable = vscode.commands.registerCommand('switchboard.importFromLinear', async () => {
        const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }

        const service = new LinearSyncService(workspaceRoot, context.secrets);
        const config = await service.loadConfig();

        if (!config?.setupComplete) {
            const choice = await vscode.window.showWarningMessage(
                'Linear is not configured. Open the Setup panel first.',
                'Open Setup Panel'
            );
            if (choice === 'Open Setup Panel') {
                await vscode.commands.executeCommand('switchboard.openSetupPanel', 'project-mgmt');
            }
            return;
        }

        const plansDir = await taskViewerProvider.getPlanIngestionFolder(workspaceRoot) || path.join(workspaceRoot, '.switchboard', 'plans');

        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Importing from Linear...', cancellable: false },
            async () => {
                const result = await service.importIssuesFromLinear(plansDir);
                if (!result.success) { vscode.window.showErrorMessage(`Import failed: ${result.error}`); return; }

                const msg = result.imported === 0
                    ? `No new issues to import (${result.skipped} already tracked or closed).`
                    : `Imported ${result.imported} issue${result.imported !== 1 ? 's' : ''} as plan files.${result.skipped ? ` (${result.skipped} skipped)` : ''}`;
                showTemporaryNotification(msg);
            }
        );
    });
    context.subscriptions.push(importFromLinearDisposable);

    const linearQueryIssuesDisposable = vscode.commands.registerCommand(
        'switchboard.linearQueryIssues',
        async (options?: { search?: string; stateId?: string; assigneeId?: string; projectId?: string; limit?: number }) => {
            return taskViewerProvider.handleLinearQueryIssues(options);
        }
    );
    context.subscriptions.push(linearQueryIssuesDisposable);

    const linearGetIssueDisposable = vscode.commands.registerCommand('switchboard.linearGetIssue', async (issueId: string) => {
        return taskViewerProvider.handleLinearGetIssue(issueId);
    });
    context.subscriptions.push(linearGetIssueDisposable);

    const linearUpdateStateDisposable = vscode.commands.registerCommand('switchboard.linearUpdateState', async (issueId: string, stateId: string) => {
        return taskViewerProvider.handleLinearUpdateState(issueId, stateId);
    });
    context.subscriptions.push(linearUpdateStateDisposable);

    const linearAddCommentDisposable = vscode.commands.registerCommand('switchboard.linearAddComment', async (issueId: string, comment: string) => {
        return taskViewerProvider.handleLinearAddComment(issueId, comment);
    });
    context.subscriptions.push(linearAddCommentDisposable);

    const linearUpdateDescriptionDisposable = vscode.commands.registerCommand('switchboard.linearUpdateDescription', async (issueId: string, description: string) => {
        return taskViewerProvider.handleLinearUpdateDescription(issueId, description);
    });
    context.subscriptions.push(linearUpdateDescriptionDisposable);

    // Tickets tab import/refine commands
    const importLinearTaskDisposable = vscode.commands.registerCommand('switchboard.importLinearTask', async (data: { workspaceRoot: string; issueId: string; includeSubtasks: boolean }) => {
        return taskViewerProvider.importLinearTask(data.workspaceRoot, data.issueId, data.includeSubtasks);
    });
    context.subscriptions.push(importLinearTaskDisposable);

    const importClickUpTaskDisposable = vscode.commands.registerCommand('switchboard.importClickUpTask', async (data: { workspaceRoot: string; taskId: string; includeSubtasks: boolean }) => {
        return taskViewerProvider.importClickUpTask(data.workspaceRoot, data.taskId, data.includeSubtasks);
    });
    context.subscriptions.push(importClickUpTaskDisposable);

    const importTaskAsDocumentDisposable = vscode.commands.registerCommand('switchboard.importTaskAsDocument', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string; includeSubtasks?: boolean; preFetchedTask?: any }) => {
        return taskViewerProvider.importTaskAsDocument(data.workspaceRoot, data);
    });
    context.subscriptions.push(importTaskAsDocumentDisposable);

    const pushTicketEditsDisposable = vscode.commands.registerCommand('switchboard.pushTicketEdits', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string }) => {
        return taskViewerProvider.pushTicketEdits(data.workspaceRoot, data);
    });
    context.subscriptions.push(pushTicketEditsDisposable);

    const importAllTasksDisposable = vscode.commands.registerCommand('switchboard.importAllTasks', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; ids?: string[]; listId?: string; projectId?: string; workspaceId?: string; page?: number; append?: boolean; importMode: 'plan' | 'document'; deltaSince?: number; deltaSinceIso?: string; includeClosed?: boolean }) => {
        return taskViewerProvider.importAllTasks(data.workspaceRoot, data);
    });
    context.subscriptions.push(importAllTasksDisposable);

    const deleteTicketDisposable = vscode.commands.registerCommand('switchboard.deleteTicket', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string }) => {
        return taskViewerProvider.deleteTicket(data.workspaceRoot, data);
    });
    context.subscriptions.push(deleteTicketDisposable);

    const changeTicketStatusDisposable = vscode.commands.registerCommand('switchboard.changeTicketStatus', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string; statusId: string }) => {
        return taskViewerProvider.changeTicketStatus(data.workspaceRoot, data);
    });
    context.subscriptions.push(changeTicketStatusDisposable);

    const postTicketCommentDisposable = vscode.commands.registerCommand('switchboard.postTicketComment', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string; comment: string; mentions?: Array<{ id: string; name: string }> }) => {
        return taskViewerProvider.postTicketComment(data.workspaceRoot, data);
    });
    context.subscriptions.push(postTicketCommentDisposable);

    const loadTicketCommentsDisposable = vscode.commands.registerCommand('switchboard.loadTicketComments', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string }) => {
        return taskViewerProvider.loadTicketComments(data.workspaceRoot, data);
    });
    context.subscriptions.push(loadTicketCommentsDisposable);

    const postTicketReplyDisposable = vscode.commands.registerCommand('switchboard.postTicketReply', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string; commentId: string; commentText: string; mentions?: Array<{ id: string; name: string }> }) => {
        return taskViewerProvider.postTicketReply(data.workspaceRoot, data);
    });
    context.subscriptions.push(postTicketReplyDisposable);

    const downloadAttachmentDisposable = vscode.commands.registerCommand('switchboard.downloadAttachment', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; url: string; filename: string; ticketId: string; ticketTitle: string }) => {
        return taskViewerProvider.downloadAttachment(data.workspaceRoot, data);
    });
    context.subscriptions.push(downloadAttachmentDisposable);

    const getAttachmentListDisposable = vscode.commands.registerCommand('switchboard.getAttachmentList', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; ticketId: string; attachmentsArray: any[] }) => {
        return taskViewerProvider.getAttachmentList(data.workspaceRoot, data.provider, data.ticketId, data.attachmentsArray);
    });
    context.subscriptions.push(getAttachmentListDisposable);

    const askAgentTaskDisposable = vscode.commands.registerCommand('switchboard.askAgentTask', async (data: { workspaceRoot: string; id: string; title: string; description: string; provider: 'linear' | 'clickup' }) => {
        return taskViewerProvider.askAgentTask(data.workspaceRoot, { id: data.id, title: data.title, description: data.description, provider: data.provider });
    });
    context.subscriptions.push(askAgentTaskDisposable);

    // Terminal sync serialization state — MUST be declared before first call
    // (Control Plane Runtime init at line ~1395 calls syncTerminalRegistryWithState).
    // Previously these were declared ~120 lines later, causing a TDZ ReferenceError
    // in the webpack bundle where the call site preceded the let-declaration.
    let syncInFlight = false;
    let syncPending = false;
    const syncCompletionWaiters: Array<() => void> = [];
    function resolveSyncCompletionWaiters() {
        if (syncInFlight || syncPending || syncCompletionWaiters.length === 0) {
            return;
        }
        while (syncCompletionWaiters.length > 0) {
            const resolve = syncCompletionWaiters.shift();
            resolve?.();
        }
    }
    async function syncTerminalRegistryWithState(workspaceRoot: string): Promise<void> {
        if (syncInFlight) {
            syncPending = true;
            return new Promise<void>((resolve) => {
                syncCompletionWaiters.push(resolve);
            });
        }
        syncInFlight = true;
        try {
            await _syncTerminalRegistryWithStateImpl(workspaceRoot);
        } finally {
            syncInFlight = false;
            if (syncPending) {
                syncPending = false;
                await syncTerminalRegistryWithState(workspaceRoot);
            }
            resolveSyncCompletionWaiters();
        }
    }

    // Initialize Control Plane Runtime
    if (workspaceRoot) {
        const runtimeStateRoot = resolveEffectiveStateRoot(workspaceRoot) || workspaceRoot;
        try {
            // 1. PERSISTENCE SYNC: Re-claim terminals from state.json (moved to deregisterAllTerminals chain to run async/non-blocking)

            // 2. REACTIVITY: Listen for new terminals in real-time
            context.subscriptions.push(vscode.window.onDidOpenTerminal(() => {
                // Re-sync registry so locate works for terminals restored after a window reload
                const currentRoot = kanbanProvider!.getCurrentWorkspaceRoot();
                const currentStateRoot = currentRoot ? (resolveEffectiveStateRoot(currentRoot) || currentRoot) : runtimeStateRoot;
                void syncTerminalRegistryWithState(currentStateRoot);
            }));

            context.subscriptions.push(vscode.window.onDidCloseTerminal((terminal) => {
                // Remove the closed terminal from the in-memory registry (object-identity match).
                // handleTerminalClosed cleans up state.json by PID/name, but does not touch this Map —
                // without this, manually-closed terminals leave stale references that leak memory and
                // cause deactivate() to call .dispose() on already-closed terminals.
                for (const [name, ref] of Array.from(registeredTerminals.entries())) {
                    if (ref === terminal) {
                        registeredTerminals.delete(name);
                        break;
                    }
                }
                // Ensure state.json is updated when terminal is closed manually
                taskViewerProvider.handleTerminalClosed(terminal);
            }));

            // 3. STATE SYNC: Wire terminal registry sync into TaskViewerProvider's existing
            // state watcher so each state.json change triggers exactly one sync + one refresh.
            // Re-entry guard: while a sync is outstanding, skip instead of queueing — the
            // waiter queue in syncTerminalRegistryWithState only resolves at full quiescence,
            // which continuous agent state writes never reach.
            let hookSyncOutstanding = false;
            taskViewerProvider.setStateSyncHook(async () => {
                if (hookSyncOutstanding) return;
                hookSyncOutstanding = true;
                try {
                    const currentRoot = kanbanProvider!.getCurrentWorkspaceRoot();
                    const stateRoot = currentRoot ? (resolveEffectiveStateRoot(currentRoot) || currentRoot) : runtimeStateRoot;
                    await syncTerminalRegistryWithState(stateRoot);
                } finally {
                    hookSyncOutstanding = false;
                }
            });

        } catch (e) {
            console.error('[Extension] Failed to initialize Control Plane Runtime:', e);
            outputChannel?.appendLine(`[Extension] ERROR: Failed to initialize Control Plane Runtime: ${e}`);
        }

        // Initial health check / setup timer removed.
        context.subscriptions.push(vscode.window.onDidChangeWindowState((state) => {
            if (state.focused) {
                const currentRoot = kanbanProvider!.getCurrentWorkspaceRoot();
                if (currentRoot) {
                    const currentStateRoot = resolveEffectiveStateRoot(currentRoot) || currentRoot;
                    void syncTerminalRegistryWithState(currentStateRoot).finally(() => {
                        taskViewerProvider.refresh();
                    });
                } else {
                    taskViewerProvider.refresh();
                }
            }
        }));



        // 9. LEASE SYSTEM: Heartbeat removed (no longer needed).
    }



    async function _syncTerminalRegistryWithStateImpl(workspaceRoot: string) {
        outputChannel?.appendLine(`[Extension] syncTerminalRegistryWithState called for ${workspaceRoot}`);
        // NOTE: PID resolution retained for backward compatibility — name + ideName matching is preferred

        try {
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            const stateTerminals = await db.getConfigJson('runtime.terminals', {}) as Record<string, any>;
            if (Object.keys(stateTerminals).length === 0) return;

            const openTerminals = vscode.window.terminals;
            const currentIdeName = (vscode.env.appName || '').toLowerCase();

            // Build new registry in a temporary map so existing references stay
            // valid during async PID lookups. Only swap at the end (synchronously).
            const newRegistry = new Map<string, vscode.Terminal>();

            // CRITICAL perf fix: `vscode.Terminal.processId` is IPC-backed and each
            // stale terminal consumes the full 5-second timeout. The previous
            // implementation was a doubly-nested sequential await loop — with
            // M state terminals and N open terminals that's O(M*N*5s) worst
            // case. On startup this was awaited by `activate()` and could
            // hold the extension host event loop for tens of seconds, which
            // starved the sidebar's HTML-delivery IPC and caused the user's
            // "sidebar takes 30 seconds to show" UAT failure.
            //
            // New shape: resolve every open terminal's PID once, in parallel,
            // before scanning state.json. Match lookups become synchronous map
            // hits. Total PID-resolution wall time is bounded by the single
            // longest timeout (~1s), not O(M*N*1s).
            const openTerminalPids = await Promise.all(
                openTerminals.map(t =>
                    waitWithTimeout(t.processId, 1000, undefined).catch(() => undefined)
                )
            );
            const openTerminalsByPid = new Map<number, vscode.Terminal>();
            for (let i = 0; i < openTerminals.length; i++) {
                const pid = openTerminalPids[i];
                if (pid) { openTerminalsByPid.set(pid, openTerminals[i]); }
            }

            for (const [name, info] of Object.entries(stateTerminals)) {
                const terminalInfo = info as any;

                // CROSS-IDE GATE: Skip terminals registered by other IDEs.
                // Without this, Windsurf claims Antigravity's terminals by name match
                // (e.g. both have a "node" terminal but they're different processes).
                const termIdeName = (terminalInfo.ideName || '').toLowerCase();
                if (termIdeName && termIdeName !== currentIdeName) {
                    outputChannel?.appendLine(`[Extension] Skipping terminal '${name}' — belongs to '${terminalInfo.ideName}', not '${vscode.env.appName}'`);
                    continue;
                }

                let found = false;

                // Strategy 1: Match by PID (Preserves exact session identity)
                if (terminalInfo.pid) {
                    const matched = openTerminalsByPid.get(terminalInfo.pid);
                    if (matched) {
                        newRegistry.set(name, matched);
                        outputChannel?.appendLine(`[Extension] Re-claimed terminal '${name}' by PID match: ${terminalInfo.pid}`);
                        found = true;
                    }
                }

                // Strategy 2: Fallback to Name match (Resilient to restarts and shell renaming)
                if (!found) {
                    for (const t of openTerminals) {
                        const creationName = (t.creationOptions as vscode.TerminalOptions)?.name;
                        if (t.name === name || t.name === terminalInfo.friendlyName ||
                            creationName === name || creationName === terminalInfo.friendlyName) {
                            newRegistry.set(name, t);
                            outputChannel?.appendLine(`[Extension] Re-claimed terminal '${name}' by Name match: ${t.name}`);
                            found = true;
                            break;
                        }
                    }
                }
            }

            // Atomic swap: replace the registry contents synchronously so there is
            // no window where terminals appear offline between clear and re-claim.
            registeredTerminals.clear();
            for (const [k, v] of newRegistry) {
                registeredTerminals.set(k, v);
            }
        } catch (e) {
            outputChannel?.appendLine(`[Extension] Failed to sync terminal registry: ${e}`);
        }
    }

    // Check if setup is needed
    const needsSetup = workspaceRoot ? !(await hasSwitchboardConfigs(workspaceRoot)) : false;
    taskViewerProvider.setSetupStatus(needsSetup);

    if (needsSetup && workspaceRoot) {
        // Status Bar Item (toast suppressed — onboarding is now handled in the sidebar)
        setupStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
        setupStatusBarItem.text = "$(rocket) Switchboard: Setup Required";
        setupStatusBarItem.tooltip = "Click to configure Switchboard for your AI coding assistants";
        setupStatusBarItem.command = 'switchboard.setup';
        setupStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
        setupStatusBarItem.show();
        context.subscriptions.push(setupStatusBarItem);
    }


    // Initialize terminal grid status bar items
    terminalOpenStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    terminalOpenStatusBarItem.text = '$(hubot) Agents';
    terminalOpenStatusBarItem.tooltip = 'Open Agent Terminals';
    terminalOpenStatusBarItem.command = 'switchboard.createAgentGrid';
    context.subscriptions.push(terminalOpenStatusBarItem);

    terminalClearStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    terminalClearStatusBarItem.text = '$(clear-all) Clear';
    terminalClearStatusBarItem.tooltip = 'Clear Agent Terminals';
    terminalClearStatusBarItem.command = 'switchboard.clearAllTerminals';
    context.subscriptions.push(terminalClearStatusBarItem);

    terminalResetStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 96);
    terminalResetStatusBarItem.text = '$(stop-circle) Reset';
    terminalResetStatusBarItem.tooltip = 'Reset Agent Terminals';
    terminalResetStatusBarItem.command = 'switchboard.deregisterAllTerminals';
    context.subscriptions.push(terminalResetStatusBarItem);

    kanbanStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 101);
    kanbanStatusBarItem.text = '$(table) Kanban';
    kanbanStatusBarItem.tooltip = 'Open Kanban Board';
    kanbanStatusBarItem.command = 'switchboard.openKanban';
    context.subscriptions.push(kanbanStatusBarItem);

    artifactsStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    artifactsStatusBarItem.text = '$(notebook) Artifacts';
    artifactsStatusBarItem.tooltip = 'Open Artifacts Panel';
    artifactsStatusBarItem.command = 'switchboard.openPlanningPanel';
    context.subscriptions.push(artifactsStatusBarItem);

    projectStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    projectStatusBarItem.text = '$(project) Project';
    projectStatusBarItem.tooltip = 'Open Project Management Panel';
    projectStatusBarItem.command = 'switchboard.openProjectPanel';
    context.subscriptions.push(projectStatusBarItem);

    designStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    designStatusBarItem.text = '$(symbol-color) Design';
    designStatusBarItem.tooltip = 'Open Design Panel';
    designStatusBarItem.command = 'switchboard.openDesignPanel';
    context.subscriptions.push(designStatusBarItem);

    switchboardHubStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 95);
    switchboardHubStatusBarItem.text = '$(circuit-board)';
    switchboardHubStatusBarItem.tooltip = 'Switchboard: Actions Hub';
    switchboardHubStatusBarItem.command = 'switchboard.openHub';
    context.subscriptions.push(switchboardHubStatusBarItem);

    memoStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 94);
    memoStatusBarItem.command = 'switchboard.openMemo';
    memoStatusBarItem.text = '$(comment-discussion)';
    memoStatusBarItem.tooltip = 'Open Memo';
    memoStatusBarItem.show();
    context.subscriptions.push(memoStatusBarItem);

    function updateStatusBarVisibility() {
        const config = vscode.workspace.getConfiguration('switchboard');
        const showTerminalControls = config.get<boolean>('statusBar.showTerminalControls', true);
        const showKanbanButton = config.get<boolean>('statusBar.showKanbanButton', true);
        const showArtifactsButton = config.get<boolean>('statusBar.showArtifactsButton', true);
        const showDesignButton = config.get<boolean>('statusBar.showDesignButton', true);
        const showProjectButton = config.get<boolean>('statusBar.showProjectButton', true);
        const showMemoButton = config.get<boolean>('statusBar.showMemoButton', true);
        const compactMode = config.get<boolean>('statusBar.compactMode', true);

        if (compactMode) {
            terminalOpenStatusBarItem.hide();
            terminalClearStatusBarItem.hide();
            terminalResetStatusBarItem.hide();
            kanbanStatusBarItem.hide();
            projectStatusBarItem.hide();
            artifactsStatusBarItem.hide();
            designStatusBarItem.hide();
            memoStatusBarItem.hide();

            let enabledCount = 0;
            if (showTerminalControls) {
                enabledCount += 3;
            }
            if (showKanbanButton) {
                enabledCount++;
            }
            if (showArtifactsButton) {
                enabledCount++;
            }
            if (showProjectButton) {
                enabledCount++;
            }
            if (showDesignButton) {
                enabledCount++;
            }
            if (showMemoButton) {
                enabledCount++;
            }

            if (enabledCount > 0) {
                switchboardHubStatusBarItem.show();
            } else {
                switchboardHubStatusBarItem.hide();
            }
        } else {
            switchboardHubStatusBarItem.hide();

            if (showTerminalControls) {
                terminalOpenStatusBarItem.show();
                terminalClearStatusBarItem.show();
                terminalResetStatusBarItem.show();
            } else {
                terminalOpenStatusBarItem.hide();
                terminalClearStatusBarItem.hide();
                terminalResetStatusBarItem.hide();
            }

            if (showKanbanButton) {
                kanbanStatusBarItem.show();
            } else {
                kanbanStatusBarItem.hide();
            }

            if (showProjectButton) {
                projectStatusBarItem.show();
            } else {
                projectStatusBarItem.hide();
            }

            if (showArtifactsButton) {
                artifactsStatusBarItem.show();
            } else {
                artifactsStatusBarItem.hide();
            }

            if (showDesignButton) {
                designStatusBarItem.show();
            } else {
                designStatusBarItem.hide();
            }

            if (showMemoButton) {
                memoStatusBarItem.show();
            } else {
                memoStatusBarItem.hide();
            }
        }

        updateHubTooltip();
    }

    updateStatusBarVisibility();

    function updateHubTooltip() {
        const config = vscode.workspace.getConfiguration('switchboard');
        const compactMode = config.get<boolean>('statusBar.compactMode', true);
        if (!compactMode) return;

        const showTerminalControls = config.get<boolean>('statusBar.showTerminalControls', true);
        const showKanbanButton = config.get<boolean>('statusBar.showKanbanButton', true);
        const showArtifactsButton = config.get<boolean>('statusBar.showArtifactsButton', true);
        const showDesignButton = config.get<boolean>('statusBar.showDesignButton', true);
        const showProjectButton = config.get<boolean>('statusBar.showProjectButton', true);
        const showMemoButton = config.get<boolean>('statusBar.showMemoButton', true);

        const lines: string[] = ['**Switchboard Actions**', ''];

        if (showTerminalControls) {
            if (lines.length > 2) lines.push('---');
            lines.push(`[$(hubot) Agents](command:switchboard.createAgentGrid)`);
            lines.push(`[$(clear-all) Clear](command:switchboard.clearAllTerminals)`);
            lines.push(`[$(stop-circle) Reset](command:switchboard.deregisterAllTerminals)`);
        }

        const hasPanels = showKanbanButton || showArtifactsButton || showProjectButton || showDesignButton;
        if (hasPanels) {
            if (lines.length > 2) lines.push('---');
            if (showKanbanButton) lines.push(`[$(table) Kanban](command:switchboard.openKanban)`);
            if (showArtifactsButton) lines.push(`[$(notebook) Artifacts](command:switchboard.openPlanningPanel)`);
            if (showProjectButton) lines.push(`[$(project) Project](command:switchboard.openProjectPanel)`);
            if (showDesignButton) lines.push(`[$(symbol-color) Design](command:switchboard.openDesignPanel)`);
        }

        if (showMemoButton) {
            if (lines.length > 2) lines.push('---');
            lines.push(`[$(comment-discussion) Memo](command:switchboard.openMemo)`);
        }

        if (lines.length <= 2) {
            lines.push('*No actions enabled in settings.*');
        }

        const md = new vscode.MarkdownString(lines.join('\n\n'));
        md.isTrusted = true;
        md.supportThemeIcons = true;
        switchboardHubStatusBarItem.tooltip = md;
    }

    // Listen for configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async e => {
        if (
            e.affectsConfiguration('switchboard.statusBar.showTerminalControls') ||
            e.affectsConfiguration('switchboard.statusBar.showKanbanButton') ||
            e.affectsConfiguration('switchboard.statusBar.showArtifactsButton') ||
            e.affectsConfiguration('switchboard.statusBar.showDesignButton') ||
            e.affectsConfiguration('switchboard.statusBar.showProjectButton') ||
            e.affectsConfiguration('switchboard.statusBar.showMemoButton') ||
            e.affectsConfiguration('switchboard.statusBar.compactMode')
        ) {
            updateStatusBarVisibility();
            void taskViewerProvider.postSetupPanelState();
        }
    }));

    // Listen for out-of-band secret storage changes
    context.subscriptions.push(context.secrets.onDidChange(e => {
        if (e.key === 'switchboard.stitch.apiKey') {
            invalidateStitchSdkCache();
        }
    }));

    // Register refresh command
    const refreshDisposable = vscode.commands.registerCommand('switchboard.refresh', async () => {
        taskViewerProvider.refresh();
    });
    context.subscriptions.push(refreshDisposable);

    const openHubDisposable = vscode.commands.registerCommand('switchboard.openHub', async () => {
        const config = vscode.workspace.getConfiguration('switchboard');
        const showTerminalControls = config.get<boolean>('statusBar.showTerminalControls', true);
        const showKanbanButton = config.get<boolean>('statusBar.showKanbanButton', true);
        const showArtifactsButton = config.get<boolean>('statusBar.showArtifactsButton', true);
        const showDesignButton = config.get<boolean>('statusBar.showDesignButton', true);
        const showProjectButton = config.get<boolean>('statusBar.showProjectButton', true);
        const showMemoButton = config.get<boolean>('statusBar.showMemoButton', true);

        interface CommandQuickPickItem extends vscode.QuickPickItem {
            command?: string;
        }

        const items: CommandQuickPickItem[] = [];

        if (showTerminalControls) {
            if (items.length > 0) {
                items.push({ label: 'Terminal Controls', kind: vscode.QuickPickItemKind.Separator });
            }
            items.push({
                label: '$(hubot) Agents',
                description: 'Open agent terminals',
                command: 'switchboard.createAgentGrid'
            });
            items.push({
                label: '$(clear-all) Clear',
                description: 'Clear agent terminals',
                command: 'switchboard.clearAllTerminals'
            });
            items.push({
                label: '$(stop-circle) Reset',
                description: 'Reset agent terminals',
                command: 'switchboard.deregisterAllTerminals'
            });
        }

        const hasPanelItems = showKanbanButton || showArtifactsButton || showProjectButton || showDesignButton || showMemoButton;
        if (hasPanelItems) {
            if (items.length > 0) {
                items.push({ label: 'Panels', kind: vscode.QuickPickItemKind.Separator });
            }
            if (showKanbanButton) {
                items.push({
                    label: '$(table) Kanban',
                    description: 'Open Kanban Board',
                    command: 'switchboard.openKanban'
                });
            }
            if (showArtifactsButton) {
                items.push({
                    label: '$(notebook) Artifacts',
                    description: 'Open Artifacts Panel',
                    command: 'switchboard.openPlanningPanel'
                });
            }
            if (showProjectButton) {
                items.push({
                    label: '$(project) Project',
                    description: 'Open Project Management Panel',
                    command: 'switchboard.openProjectPanel'
                });
            }
            if (showDesignButton) {
                items.push({
                    label: '$(symbol-color) Design',
                    description: 'Open Design Panel',
                    command: 'switchboard.openDesignPanel'
                });
            }
            if (showMemoButton) {
                items.push({
                    label: '$(comment-discussion) Memo',
                    description: 'Open Memo',
                    command: 'switchboard.openMemo'
                });
            }
        }

        if (items.length === 0) {
            vscode.window.showInformationMessage('No status bar actions enabled in settings.');
            return;
        }

        const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Switchboard actions...'
        });

        if (selected && selected.command) {
            void vscode.commands.executeCommand(selected.command);
        }
    });
    context.subscriptions.push(openHubDisposable);

    // Manual refresh integration cache command
    const refreshIntegrationCacheDisposable = vscode.commands.registerCommand('switchboard.refreshIntegrationCache', async () => {
        const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }
        await taskViewerProvider.forceRefreshIntegrationCache(workspaceRoot);
    });
    context.subscriptions.push(refreshIntegrationCacheDisposable);

    // Trigger prefetch of last-accessed integration data after activation (with delay)
    if (workspaceRoot) {
        setTimeout(() => {
            taskViewerProvider.prefetchIntegrationData(workspaceRoot).catch((e) => {
                console.warn('[Extension] Prefetch failed:', e);
            });
        }, 2000);
    }

    const housekeepingDisposable = vscode.commands.registerCommand('switchboard.housekeepNow', async () => {
        const selectedWorkspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!selectedWorkspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }
        try {
            // 1. Archive old run sheets (>30 days) via SessionActionLog
            const sessionLog = new SessionActionLog(selectedWorkspaceRoot);
            await sessionLog.archiveOldSheets({ olderThanDays: 30 });

            // 2. Clean transient .switchboard/ subdirectories
            await cleanWorkspace(selectedWorkspaceRoot, outputChannel ?? undefined);

            showTemporaryNotification('Switchboard housekeeping complete.');
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            vscode.window.showErrorMessage(`Switchboard housekeeping failed: ${msg}`);
        }
    });
    context.subscriptions.push(housekeepingDisposable);

    // Register setup command — hoisted to top of activate; kept here as no-op placeholder for reference.


    const deregisterAllTerminalsDisposable = vscode.commands.registerCommand('switchboard.deregisterAllTerminals', async () => {
        await taskViewerProvider.deregisterAllTerminals();
    });
    context.subscriptions.push(deregisterAllTerminalsDisposable);

    const clearAllTerminalsDisposable = vscode.commands.registerCommand('switchboard.clearAllTerminals', async () => {
        const clearPromises: Promise<void>[] = [];
        for (const [, terminal] of registeredTerminals.entries()) {
            if (terminal.exitStatus === undefined) {
                clearPromises.push(sendRobustText(terminal, '/clear', false));
            }
        }
        await Promise.all(clearPromises);
        outputChannel?.appendLine(`[Extension] Cleared ${clearPromises.length} active terminals.`);
    });
    context.subscriptions.push(clearAllTerminalsDisposable);

    // Register Clean Working Memory command
    const cleanWorkspaceDisposable = vscode.commands.registerCommand('switchboard.cleanWorkspace', async () => {
        const selectedWorkspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!selectedWorkspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }
        const effectiveStateRoot = resolveEffectiveStateRoot(selectedWorkspaceRoot) || selectedWorkspaceRoot;
        await cleanWorkspace(effectiveStateRoot, outputChannel ?? undefined);
        showTemporaryNotification('Switchboard working memory cleaned.');
        taskViewerProvider.refresh();
    });
    context.subscriptions.push(cleanWorkspaceDisposable);

    // Background state.json pruner: remove zombie terminal entries every 15 minutes
    if (workspaceRoot) {
        const statePrunerInterval = setInterval(async () => {
            try {
                const currentRoot = kanbanProvider!.getCurrentWorkspaceRoot();
                if (!currentRoot) return;
                const statePath = getStateJsonPath(currentRoot);
                if (statePath) {
                    const pruned = await pruneZombieTerminalEntries(statePath);
                    if (pruned > 0) {
                        outputChannel?.appendLine(`[Extension] State pruner: removed ${pruned} zombie terminal entr${pruned === 1 ? 'y' : 'ies'}`);
                    }
                }
            } catch (e) {
                outputChannel?.appendLine(`[Extension] State pruner error: ${e}`);
            }
        }, 15 * 60 * 1000);
        context.subscriptions.push({ dispose: () => clearInterval(statePrunerInterval) });
    }

    // Register IDE setup command
    const ideSetupDisposable = registerSwitchboardCommand('switchboard.setupIDEs', async () => {
        await showSetupWizard(context, taskViewerProvider);
    });
    context.subscriptions.push(ideSetupDisposable);

// ... (rest of the code remains the same)
    // Register focus terminal command
    // NOTE: vscode.window.terminals[n].processId returns the HOST shell PID (e.g., powershell.exe),
    // not necessarily the child workers running inside it.
    const focusTerminalDisposable = registerSwitchboardCommand('switchboard.focusTerminal', async (pid: number) => {
        const terminals = vscode.window.terminals;
        try {
            const pidMap = await Promise.all(terminals.map(async t => ({ term: t, pid: await waitWithTimeout(t.processId, 1000, undefined) })));
            // NOTE: PID may come from webview as string due to JSON serialization, use loose equality
            let match = pidMap.find(item => item.pid == pid);

            // Child PID Fallback: If no host PID matches, check the registry for a childPid mapping
            if (!match && workspaceRoot) {
                const statePath = getStateJsonPath(workspaceRoot);
                if (statePath && fs.existsSync(statePath)) {
                    try {
                        const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
                        const registeredTerminals = state.terminals || {};
                        // Loose equality here too for the same reason
                        const entry: any = Object.values(registeredTerminals).find((t: any) => t.pid == pid);
                        if (entry && entry.childPid) {
                            match = pidMap.find(item => item.pid == entry.childPid);
                        }
                    } catch (e) {
                        console.error('[Extension] Failed to read state for childPid fallback:', e);
                    }
                }
            }

            if (match) {
                match.term.show();
            } else {
                vscode.window.showWarningMessage(`Terminal with PID ${pid} not found.`);
            }
        } catch (e) {
            console.error('Failed to focus terminal', e);
        }
    });
    context.subscriptions.push(focusTerminalDisposable);

    // Register focus terminal by name command (reliable — uses in-memory terminal map)
    const focusTerminalByNameDisposable = registerSwitchboardCommand('switchboard.focusTerminalByName', async (terminalName: string) => {
        const normalizeName = (value: string | undefined): string =>
            (value || '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();
        const target = normalizeName(terminalName);

        // 1. Check the in-memory registeredTerminals map first
        const registered = registeredTerminals.get(terminalName);
        if (registered && registered.exitStatus === undefined) {
            registered.show();
            return;
        }

        // 1a. Try suffixed name (keys are stored suffixed)
        const suffixed = suffixedName(terminalName);
        if (suffixed !== terminalName) {
            const bySuffix = registeredTerminals.get(suffixed);
            if (bySuffix && bySuffix.exitStatus === undefined) {
                bySuffix.show();
                return;
            }
        }

        // 1b. Case-insensitive lookup in registered map for renamed or normalized keys.
        for (const [name, terminal] of registeredTerminals.entries()) {
            if (terminal.exitStatus !== undefined) continue;
            if (normalizeName(stripIdeSuffix(name)) !== target) continue;
            terminal.show();
            return;
        }

        // 2. Fallback: scan VS Code terminals by name or original creation name
        const match = vscode.window.terminals.find(t =>
            t.exitStatus === undefined &&
            (normalizeName(t.name) === target ||
                normalizeName((t.creationOptions as vscode.TerminalOptions)?.name) === target)
        );
        if (match) {
            match.show();
            return;
        }

        // 3. creationOptions.name already checked above — warn if still not found

        vscode.window.showWarningMessage(`Terminal '${terminalName}' not found. It may have been closed.`);
    });
    context.subscriptions.push(focusTerminalByNameDisposable);

    // Register focus all terminals command
    const focusAllTerminalsDisposable = vscode.commands.registerCommand('switchboard.focusAllTerminals', async () => {
        if (!workspaceRoot) return;
        const statePath = getStateJsonPath(workspaceRoot);
        if (!statePath || !fs.existsSync(statePath)) {
            vscode.window.showWarningMessage('No active terminal sessions found.');
            return;
        }

        try {
            const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
            const terminals = state.terminals || {};
            const keys = Object.keys(terminals);

            if (keys.length === 0) {
                showTemporaryNotification('No registered terminals to focus.');
                return;
            }

            // Focus them sequentially by name (resilient to post-reload PID changes)
            for (const key of keys) {
                await vscode.commands.executeCommand('switchboard.focusTerminalByName', key);
            }
        } catch (e) {
            console.error('Failed to focus all terminals', e);
        }
    });
    context.subscriptions.push(focusAllTerminalsDisposable);

    // Register open plan command with configurable preview/edit mode
    const openPlanDisposable = registerSwitchboardCommand('switchboard.openPlan', async (uri: vscode.Uri | string) => {
        if (!uri) return;

        let targetUri: vscode.Uri;
        if (uri instanceof vscode.Uri) {
            targetUri = uri;
        } else if (typeof uri === 'string') {
            targetUri = vscode.Uri.file(uri);
        } else {
            try {
                targetUri = vscode.Uri.file(String(uri));
            } catch {
                return;
            }
        }

        const config = vscode.workspace.getConfiguration('switchboard');
        const defaultMode = config.get<string>('plans.defaultOpenMode', 'preview');

        try {
            const isMarkdown = targetUri.fsPath.toLowerCase().endsWith('.md');
            if (isMarkdown && defaultMode === 'preview') {
                await vscode.commands.executeCommand('markdown.showPreview', targetUri);
            } else {
                await vscode.commands.executeCommand('vscode.open', targetUri);
            }
        } catch (e) {
            console.error('Failed to open plan:', e);
            vscode.window.showErrorMessage(`Failed to open plan: ${e}`);
        }
    });
    context.subscriptions.push(openPlanDisposable);

    const sendReviewCommentDisposable = vscode.commands.registerCommand(
        'switchboard.sendReviewComment',
        async (request: ReviewCommentRequest): Promise<ReviewCommentResult> => {
            const selectedText = typeof request?.selectedText === 'string' ? request.selectedText.trim() : '';
            const comment = typeof request?.comment === 'string' ? request.comment.trim() : '';
            const planFileAbsolute = typeof request?.planFileAbsolute === 'string' ? request.planFileAbsolute.trim() : '';

            if (!selectedText) {
                return { ok: false, message: 'Selected text is required.' };
            }
            if (!comment) {
                return { ok: false, message: 'Comment text is required.' };
            }
            if (!planFileAbsolute) {
                return { ok: false, message: 'Plan path is required.' };
            }

            const absolutePlanPath = path.resolve(planFileAbsolute);
            const workspaceRoot = findWorkspaceRootForPath(absolutePlanPath);
            if (!workspaceRoot) {
                return { ok: false, message: 'No workspace folder found.' };
            }
            if (!isPathWithinRoot(absolutePlanPath, workspaceRoot)) {
                return { ok: false, message: 'Plan path is outside workspace boundary.' };
            }

            const statePath = getStateJsonPath(workspaceRoot);
            let state: any = {};
            if (statePath && fs.existsSync(statePath)) {
                try {
                    state = JSON.parse(await fs.promises.readFile(statePath, 'utf8'));
                } catch (e) {
                    const message = e instanceof Error ? e.message : String(e);
                    return { ok: false, message: `Failed to parse state.json: ${message}` };
                }
            }

            const preferredRole = resolvePreferredReviewRole(state);
            const rolePriority = Array.from(new Set([preferredRole, 'planner', 'reviewer', 'lead', 'coder', 'analyst']));
            const stateTerminals = state.terminals || {};
            const currentIdeName = vscode.env.appName || '';

            let selectedTerminalName: string | undefined;
            let selectedTerminal: vscode.Terminal | undefined;

            for (const role of rolePriority) {
                const roleCandidates = Object.entries(stateTerminals)
                    .filter(([, info]) => normalizeAgentKey((info as any)?.role) === role)
                    .filter(([, info]) => isCompatibleIdeName((info as any)?.ideName, currentIdeName))
                    .map(([name]) => name);

                for (const candidateName of roleCandidates) {
                    const terminal = resolveTerminalByName(candidateName);
                    if (terminal) {
                        selectedTerminalName = candidateName;
                        selectedTerminal = terminal;
                        break;
                    }
                }

                if (selectedTerminal) break;
            }

            if (!selectedTerminal) {
                for (const fallbackName of ['Planner', 'Reviewer', 'Lead Coder', 'Coder', 'Analyst']) {
                    const terminal = resolveTerminalByName(fallbackName);
                    if (terminal) {
                        selectedTerminalName = fallbackName;
                        selectedTerminal = terminal;
                        break;
                    }
                }
            }

            if (!selectedTerminal || !selectedTerminalName) {
                return { ok: false, message: 'No active target terminal found for review comments.' };
            }

            const compactSelectedText = selectedText.replace(/\s+/g, ' ').trim();
            const compactComment = comment.replace(/\s+/g, ' ').trim();
            const planContext = path.relative(workspaceRoot, absolutePlanPath).replace(/\\/g, '/');
            const sessionContext = request?.sessionId ? `\nSession: ${request.sessionId}` : '';
            const payload = `> [${compactSelectedText}] — Comment: "${compactComment}"\nPlan: ${planContext}${sessionContext}`;

            try {
                await sendRobustText(selectedTerminal, payload, true);
                return {
                    ok: true,
                    message: `Comment sent to ${selectedTerminalName}`,
                    targetAgent: selectedTerminalName,
                    preferredRole
                };
            } catch (e) {
                const message = e instanceof Error ? e.message : String(e);
                return { ok: false, message: `Failed to send review comment: ${message}` };
            }
        }
    );
    context.subscriptions.push(sendReviewCommentDisposable);

    async function disposeAllGridTerminals() {
        for (const [name, terminal] of Array.from(registeredTerminals.entries())) {
            if (terminal.exitStatus === undefined) {
                outputChannel?.appendLine(`[Extension] Disposing grid terminal '${name}' for worktreeReset`);
                terminal.dispose();
            }
            registeredTerminals.delete(name);
        }
        await taskViewerProvider.updateState(async (state: any) => {
            if (!state.terminals) state.terminals = {};
            const currentIde = vscode.env.appName || '';
            for (const key of Object.keys(state.terminals)) {
                const entry = state.terminals[key];
                if (entry?.purpose === 'agent-grid' && isCompatibleIdeName(entry.ideName, currentIde)) {
                    delete state.terminals[key];
                }
            }
        });
    }

    function postKanbanStatus(message: string, isError = false) {
        kanbanProvider?.postMessage({ type: 'showStatusMessage', message, isError });
    }

    async function createAgentGrid(options?: { cwdOverride?: string }) {
        const currentWorkspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot()
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!currentWorkspaceRoot) {
            vscode.window.showWarningMessage('No workspace folder found.');
            return;
        }
        const verifyWorkspace = () => kanbanProvider!.getCurrentWorkspaceRoot() === currentWorkspaceRoot;
        const effectiveWorkspaceRoot = kanbanProvider!.resolveEffectiveWorkspaceRoot(currentWorkspaceRoot);

        let suppressMain = false;
        let gridWorktrees: any[] = [];
        const kpAny = kanbanProvider as any;
        const db = kpAny && typeof kpAny._getKanbanDb === 'function' ? kpAny._getKanbanDb(currentWorkspaceRoot) : null;
        if (db) {
            try {
                const ready = await db.ensureReady();
                if (ready) {
                    suppressMain = (await db.getMeta('worktree_suppress_main_terminals')) === 'true';
                    gridWorktrees = (await db.getWorktrees()).filter((w: any) => w.status === 'active' && w.agentsOpenWithGrid);
                }
            } catch { /* ignore DB errors */ }
        }

        if (suppressMain && gridWorktrees.length === 0) {
            vscode.window.showWarningMessage('Suppress main is on but no worktree is set to open terminals — nothing to open.');
            return;
        }

        const gridTerminals = new Map<string, vscode.Terminal>();
        let effectiveCwd = effectiveWorkspaceRoot;
        if (options?.cwdOverride) {
            if (fs.existsSync(options.cwdOverride)) {
                effectiveCwd = options.cwdOverride;
            } else {
                vscode.window.showWarningMessage(`cwdOverride path does not exist: ${options.cwdOverride}. Using workspace root.`);
            }
        }

        const visibleAgents = await taskViewerProvider.getVisibleAgents(effectiveWorkspaceRoot);
        const includeJulesMonitor = visibleAgents.jules !== false;
        const customAgents = await taskViewerProvider.getCustomAgents(effectiveWorkspaceRoot);
        const startupCommands = await taskViewerProvider.getStartupCommands(effectiveWorkspaceRoot);
        const allBuiltInAgents = [
            { name: 'Planner', role: 'planner' },
            { name: 'Lead Coder', role: 'lead' },
            { name: 'Coder', role: 'coder' },
            { name: 'Intern', role: 'intern' },
            { name: 'Reviewer', role: 'reviewer' },
            { name: 'Acceptance Tester', role: 'tester' },
            { name: 'Analyst', role: 'analyst' },
            { name: 'Ticket Updater', role: 'ticket_updater' },
            { name: 'Researcher', role: 'researcher' },
            { name: 'Claude Artifacts', role: 'claude_artifacts' },
            { name: 'Phone-a-Friend', role: 'phone_a_friend' }
        ];
        const plannerCount = await taskViewerProvider.getPlannerTerminalCount(effectiveWorkspaceRoot);
        const agents: { name: string; role: string }[] = [];
        for (const builtIn of allBuiltInAgents) {
            if (visibleAgents[builtIn.role] !== false) {
                if (builtIn.role === 'planner' && plannerCount > 1) {
                    for (let n = 1; n <= plannerCount; n++) {
                        agents.push({ name: n === 1 ? 'Planner' : `Planner ${n}`, role: 'planner' });
                    }
                } else {
                    agents.push(builtIn);
                }
            }
        }
        const includeMcpMonitor = visibleAgents.mcp_monitor !== false;
        for (const agent of customAgents) {
            if (visibleAgents[agent.role] === false) { continue; }
            agents.push({ name: agent.name, role: agent.role });
        }
        if (includeJulesMonitor) {
            agents.push({ name: 'Jules Monitor', role: 'jules_monitor' });
        }
        if (includeMcpMonitor) {
            agents.push({ name: TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME, role: 'mcp_monitor' });
        }

        // Open worktree terminals if configured
        for (const w of gridWorktrees) {
            if (w.path) {
                // Note on dual subsystems: worktree terminals deliberately use the autoban registry
                // and are matched for routing by worktreePath, not name.
                const roles = agents.map(a => a.role);
                // User-initiated (AGENTS button / "OPEN AGENT TERMINALS"): isManual=true so the
                // autoban 5-per-role cap never blocks a human opening grid worktree terminals.
                await taskViewerProvider.ensureWorktreeTerminals(w.path, roles, true, true);
            }
        }

        if (!suppressMain) {
            const normalizeGridTerminalName = (value: string | undefined): string => (value || '').trim();
            const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            // Build a set of terminal names that are main repo terminals (not worktree).
            // Only needed when worktree terminals exist and could collide by name.
            const mainRepoTerminalNames = new Set<string>();
            if (gridWorktrees.length > 0) {
                try {
                    const terminalState = await taskViewerProvider.readTerminalRegistryState(effectiveWorkspaceRoot);
                    for (const [name, info] of Object.entries(terminalState || {})) {
                        const entry = info as any;
                        const termWtPath = entry.worktreePath ? path.resolve(entry.worktreePath) : '';
                        if (!termWtPath || termWtPath === path.resolve(effectiveCwd)) {
                            mainRepoTerminalNames.add(name);
                            mainRepoTerminalNames.add(entry.friendlyName || name);
                        }
                    }
                } catch {
                    // Fall back to name-only matching (pre-fix behavior) for safety.
                }
            }

            const matchesGridAgentName = (terminal: vscode.Terminal, agentName: string): boolean => {
                const creationName = (terminal.creationOptions as vscode.TerminalOptions | undefined)?.name;
                const terminalName = normalizeGridTerminalName(terminal.name);
                const createdName = normalizeGridTerminalName(creationName);
                const primaryPattern = new RegExp(`^${escapeRegex(agentName)}(?: \\(\\d+\\))?$`);
                if (!primaryPattern.test(terminalName) && !primaryPattern.test(createdName)) {
                    return false;
                }
                if (mainRepoTerminalNames.size === 0) {
                    return true;
                }
                const suffixedTerminalName = suffixedName(terminalName);
                const suffixedCreatedName = createdName ? suffixedName(createdName) : '';
                return mainRepoTerminalNames.has(terminalName) ||
                       mainRepoTerminalNames.has(suffixedTerminalName) ||
                       mainRepoTerminalNames.has(createdName) ||
                       mainRepoTerminalNames.has(suffixedCreatedName);
            };
            const clearGridBlockers = async () => {
                const agentNames = new Set(agents.map(a => a.name));
                if (!includeJulesMonitor) { agentNames.add('Jules Monitor'); }
                if (!includeMcpMonitor) { agentNames.add(TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME); }
                for (const [name, terminal] of Array.from(registeredTerminals.entries())) {
                    const bareName = stripIdeSuffix(name);
                    if ((agentNames.has(name) || agentNames.has(bareName)) && terminal.exitStatus !== undefined) {
                        registeredTerminals.delete(name);
                    }
                }
                if (!includeJulesMonitor) {
                    const julesMatches = vscode.window.terminals.filter(t => t.exitStatus === undefined && matchesGridAgentName(t, 'Jules Monitor'));
                    for (const terminal of julesMatches) {
                        outputChannel?.appendLine(`[Extension] Disposing hidden grid terminal '${terminal.name}' for agent 'Jules Monitor'`);
                        terminal.dispose();
                    }
                    registeredTerminals.delete('Jules Monitor');
                    registeredTerminals.delete(suffixedName('Jules Monitor'));
                }
                if (!includeMcpMonitor) {
                    const mcpMatches = vscode.window.terminals.filter(t => t.exitStatus === undefined && matchesGridAgentName(t, TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME));
                    for (const terminal of mcpMatches) {
                        outputChannel?.appendLine(`[Extension] Disposing hidden grid terminal '${terminal.name}' for agent '${TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME}'`);
                        terminal.dispose();
                    }
                    registeredTerminals.delete(TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME);
                    registeredTerminals.delete(suffixedName(TaskViewerProvider.MCP_MONITOR_TERMINAL_NAME));
                }
                for (const agent of agents) {
                    const matches = vscode.window.terminals.filter(t => t.exitStatus === undefined && matchesGridAgentName(t, agent.name));
                    if (matches.length === 0) continue;
                    const healthy: vscode.Terminal[] = [];
                    for (const term of matches) {
                        if (term.exitStatus !== undefined) {
                            outputChannel?.appendLine(`[Extension] Disposing exited grid terminal '${term.name}' for agent '${agent.name}'`);
                            term.dispose();
                            continue;
                        }
                        healthy.push(term);
                    }
                    if (healthy.length > 1) {
                        for (const extra of healthy.slice(1)) {
                            outputChannel?.appendLine(`[Extension] Disposing duplicate grid terminal '${extra.name}' for agent '${agent.name}'`);
                            extra.dispose();
                        }
                    }
                }
                await taskViewerProvider.updateState(async (state: any) => {
                    if (!state.terminals) state.terminals = {};
                    const currentIde = vscode.env.appName || '';
                    for (const name of agentNames) {
                        for (const key of [name, suffixedName(name)]) {
                            const entry = state.terminals[key];
                            if (!entry) continue;
                            if (isCompatibleIdeName(entry.ideName, currentIde)) {
                                delete state.terminals[key];
                            }
                        }
                    }
                });
            };
            // Pre-subscribe to shell execution events BEFORE creating terminals to avoid race:
            // If we subscribe after terminal.show(), fast shells may start and fire the event
            // before our listener is attached, causing an unnecessary 5s timeout fallback.
            const shellReadyTerminals = new Set<vscode.Terminal>();
            const preSubscription = vscode.window.onDidStartTerminalShellExecution((e) => {
                shellReadyTerminals.add(e.terminal);
            });
            taskViewerProvider.sendLoadingState(true);
            try {
                await clearGridBlockers();
                const createdTerminals: vscode.Terminal[] = [];
                const batchRegistrations: any[] = [];
                for (let i = 0; i < agents.length; i++) {
                    const agent = agents[i];
                    let terminal = vscode.window.terminals.find(t => t.exitStatus === undefined && matchesGridAgentName(t, agent.name));
                    const alreadyExisted = !!terminal;
                    if (!terminal) {
                        const gridTermOpts: vscode.TerminalOptions = {
                            name: agent.name,
                            location: vscode.TerminalLocation.Panel,
                            cwd: effectiveCwd
                        };
                        terminal = vscode.window.createTerminal(gridTermOpts);
                        createdTerminals.push(terminal);
                    }
                    batchRegistrations.push({
                        name: suffixedName(agent.name),
                        purpose: 'agent-grid',
                        role: agent.role,
                        pid: null,
                        friendlyName: agent.name,
                        skipParentResolution: true,
                        ideName: vscode.env.appName,
                        worktreePath: effectiveCwd !== effectiveWorkspaceRoot ? effectiveCwd : undefined
                    });
                    outputChannel?.appendLine(`[Extension] Queued grid terminal '${agent.name}' (PID: null — skipParentResolution) for batch registration`);
                    gridTerminals.set(suffixedName(agent.name), terminal);
                    registeredTerminals.set(suffixedName(agent.name), terminal);
                    terminal.show();
                    try {
                        await vscode.commands.executeCommand('workbench.action.terminal.moveToTerminalPanel');
                    } catch (e) {
                        outputChannel?.appendLine(`[Extension] Could not move terminal to panel: ${e}`);
                    }
                }
                if (batchRegistrations.length > 0) {
                    await taskViewerProvider.updateState(async (state: any) => {
                        if (!state.terminals) state.terminals = {};
                        for (const reg of batchRegistrations) {
                            if (!state.terminals[reg.name]) {
                                state.terminals[reg.name] = { purpose: reg.purpose };
                            }
                            state.terminals[reg.name].role = reg.role;
                            state.terminals[reg.name].friendlyName = reg.friendlyName;
                            state.terminals[reg.name].lastSeen = new Date().toISOString();
                            if (reg.pid) state.terminals[reg.name].pid = reg.pid;
                            if (reg.ideName) state.terminals[reg.name].ideName = reg.ideName;
                            if (reg.worktreePath) state.terminals[reg.name].worktreePath = reg.worktreePath;
                        }
                    });
                    taskViewerProvider.refresh();
                    outputChannel?.appendLine(`[Extension] Registrations for ${batchRegistrations.length} terminal(s) were persisted to state.json`);
                }

                const newlyCreatedTerminals = new Set(createdTerminals);
                if (newlyCreatedTerminals.size === 0) {
                    const firstAgent = agents[0];
                    if (firstAgent) {
                        await vscode.commands.executeCommand('switchboard.focusTerminalByName', firstAgent.name);
                        postKanbanStatus(`Agent terminals already open. Focused: ${firstAgent.name}`);
                    }
                    return;
                }

                try {
                    // Wait for all created terminals' shells to start before sending commands
                    const awaiting = createdTerminals.filter(t => !shellReadyTerminals.has(t));
                    if (awaiting.length > 0) {
                        await new Promise<void>((resolve) => {
                            const remaining = new Set(awaiting);
                            const disposable = vscode.window.onDidStartTerminalShellExecution((e) => {
                                if (remaining.has(e.terminal)) {
                                    remaining.delete(e.terminal);
                                    if (remaining.size === 0) {
                                        disposable.dispose();
                                        resolve();
                                    }
                                }
                            });
                            // Safety timeout: resolve after 5s even if some shells didn't report
                            setTimeout(() => {
                                disposable.dispose();
                                if (remaining.size > 0) {
                                    outputChannel?.appendLine(`[Extension] Shell init timeout — ${remaining.size} terminal(s) did not report ready, proceeding anyway`);
                                }
                                resolve();
                            }, 5000);
                        });
                    }

                    outputChannel?.appendLine(`[Extension] createAgentGrid: sending startup commands for ${agents.length} agent(s), effectiveWorkspaceRoot=${effectiveWorkspaceRoot}`);
                    for (const agent of agents) {
                        let cmd = await taskViewerProvider.getAgentStartupCommand(agent.role, effectiveWorkspaceRoot);
                        if (cmd && cmd.trim()) {
                            const terminal = gridTerminals.get(suffixedName(agent.name));
                            if (terminal && newlyCreatedTerminals.has(terminal)) {
                                terminal.sendText(cmd.trim(), true);
                                outputChannel?.appendLine(`[Extension] Sent startup command for '${agent.name}' (${agent.role}): ${cmd.trim()}`);

                                // NEW: Cache the binary-derived agent display name
                                const binary = cmd.trim().split(/\s+/)[0];
                                const displayName = path.basename(binary).replace(/\.(exe|cmd|bat)$/i, '').toUpperCase() + ' CLI';
                                taskViewerProvider.setTerminalAgentInfo(suffixedName(agent.name), agent.role, displayName);

                                if (!registeredTerminals.has(suffixedName(agent.name))) {
                                    outputChannel?.appendLine(`[Extension] Startup command sent via local reference (registeredTerminals missing for '${agent.name}')`);
                                }
                            } else if (terminal) {
                                outputChannel?.appendLine(`[Extension] Skipping startup command for already running '${agent.name}' (${agent.role})`);
                            } else {
                                outputChannel?.appendLine(`[Extension] WARNING: terminal not found in gridTerminals for '${agent.name}' (key=${suffixedName(agent.name)})`);
                            }
                        } else {
                            outputChannel?.appendLine(`[Extension] WARNING: empty startup command for '${agent.name}' (${agent.role}), cmd='${cmd || ''}'`);
                        }
                    }
                } catch (e) {
                    outputChannel?.appendLine(`[Extension] Startup command execution failed: ${e}`);
                }
                postKanbanStatus(`Agent Grid initialized: ${agents.map(a => a.name).join(', ')}`);
            } catch (e) {
                const msg = e instanceof Error ? e.message : String(e);
                outputChannel?.appendLine(`[Extension] createAgentGrid failed: ${msg}`);
                vscode.window.showErrorMessage(`Failed to open agent terminals: ${msg}`);
            } finally {
                preSubscription.dispose();
                taskViewerProvider.sendLoadingState(false);
            }
        }
    }

    // Register terminal status update command
    const updateSidebarTerminalsDisposable = vscode.commands.registerCommand('switchboard.updateSidebarTerminals', (terminals: any) => {
        taskViewerProvider.updateTerminalStatuses(terminals);
    });
    context.subscriptions.push(updateSidebarTerminalsDisposable);

    // Event-Driven UI Updates
    context.subscriptions.push(
        vscode.window.onDidOpenTerminal(() => taskViewerProvider.refresh()),
        vscode.window.onDidCloseTerminal(() => taskViewerProvider.refresh())
    );
    // Conditionally register panel serializers for persistence
    const persistPanels = vscode.workspace.getConfiguration('switchboard').get<boolean>('persistPanels', false);
    if (persistPanels) {
        vscode.window.registerWebviewPanelSerializer('switchboard-kanban', {
            deserializeWebviewPanel: async (panel, state) => {
                await kanbanProvider!.deserializeWebviewPanel(panel, state);
            }
        });
        vscode.window.registerWebviewPanelSerializer('switchboard-planning', {
            deserializeWebviewPanel: async (panel, state) => {
                await planningPanelProvider.deserializeWebviewPanel(panel, state);
            }
        });
        vscode.window.registerWebviewPanelSerializer('switchboard-project', {
            deserializeWebviewPanel: async (panel, state) => {
                await planningPanelProvider.deserializeProjectPanel(panel, state);
            }
        });

        // Only set the restore guard if a switchboard-project tab is actually
        // present in the editor layout (ghost tab from previous session).
        // This avoids a 1.5s wait penalty on first openProject() in sessions
        // that never had a PROJECT panel open.
        const hasProjectGhost = vscode.window.tabGroups.all.some(group =>
            group.tabs.some(tab =>
                tab.input instanceof vscode.TabInputWebview &&
                tab.input.viewType === 'switchboard-project'
            )
        );
        if (hasProjectGhost) {
            planningPanelProvider.markProjectPanelRestoring();
        }
        vscode.window.registerWebviewPanelSerializer('switchboard-design', {
            deserializeWebviewPanel: async (panel, state) => {
                await designPanelProvider.deserializeWebviewPanel(panel, state);
            }
        });
    }

    console.timeEnd('switchboard.activate');
}

async function fileExists(filePath: string): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(vscode.Uri.file(filePath));
        return true;
    } catch {
        return false;
    }
}

/**
 * Check if Switchboard configurations exist (Robust check)
 */
async function hasSwitchboardProtocolFiles(workspaceRoot: string): Promise<boolean> {
    const agentsDir = vscode.Uri.file(path.join(workspaceRoot, '.agents'));
    const agentsWorkflowsDir = vscode.Uri.file(path.join(workspaceRoot, '.agents', 'workflows'));
    // Backward-compatible fallback: a user who kept their old .agent/ folder.
    const legacyAgentDir = vscode.Uri.file(path.join(workspaceRoot, '.agent'));
    const legacyWorkflowsDir = vscode.Uri.file(path.join(workspaceRoot, '.agent', 'workflows'));
    const switchboardDir = vscode.Uri.file(path.join(workspaceRoot, '.switchboard'));

    try {
        // Core check: .agents/workflows must exist (contains workflow definitions)
        const workflowsExist = await vscode.workspace.fs.stat(agentsWorkflowsDir).then(() => true, () => false);
        if (workflowsExist) return true;

        // Legacy fallback: .agent/workflows exists (pre-rename workspace)
        const legacyWorkflowsExist = await vscode.workspace.fs.stat(legacyWorkflowsDir).then(() => true, () => false);
        if (legacyWorkflowsExist) return true;

        // Fallback: .agents dir + .switchboard runtime dir both exist
        const agentExists = await vscode.workspace.fs.stat(agentsDir).then(() => true, () => false);
        const legacyAgentExists = await vscode.workspace.fs.stat(legacyAgentDir).then(() => true, () => false);
        const runtimeExists = await vscode.workspace.fs.stat(switchboardDir).then(() => true, () => false);
        return (agentExists || legacyAgentExists) && runtimeExists;
    } catch {
        return false;
    }
}

/**
 * Check if Switchboard configurations exist (protocol)
 */
async function hasSwitchboardConfigs(workspaceRoot: string): Promise<boolean> {
    return hasSwitchboardProtocolFiles(workspaceRoot);
}



/**
 * Surgical setup of core workflow dependencies (Async & Production Safe)
 */
async function setupProtocolFilesSilent(workspaceRoot: string, extensionUri: vscode.Uri) {
    try {
        await performSetup(vscode.Uri.file(workspaceRoot), extensionUri, { silent: true });
    } catch (error) {
        console.error('Surgical setup failed:', error);
    }
}

// Boundary markers for managed Switchboard protocol block in AGENTS.md
const AGENTS_PROTOCOL_HEADER = '# AGENTS.md - Switchboard Protocol';
const AGENTS_BLOCK_START = '<!-- switchboard:agents-protocol:start -->';
const AGENTS_BLOCK_END = '<!-- switchboard:agents-protocol:end -->';

type AgentsProtocolStatus = 'created' | 'appended' | 'skipped' | 'updated' | 'failed';

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

function isFileNotFoundError(error: unknown): boolean {
    if (error instanceof vscode.FileSystemError) {
        return error.code === 'FileNotFound';
    }
    if (typeof error === 'object' && error !== null && 'code' in error) {
        return (error as { code?: unknown }).code === 'FileNotFound';
    }
    return false;
}

function hasProtocolHeaderLine(content: string, header: string): boolean {
    const escapedHeader = header.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedHeader}\\s*$`, 'm').test(content);
}

interface ProtocolFileOptions {
    /** Target filename in the workspace root, e.g. `AGENTS.md` or `CLAUDE.md`. */
    targetFileName: string;
    blockStart: string;
    blockEnd: string;
    /** Header line used by the legacy-markerless heuristic — MUST be unique per target. */
    header: string;
    /** Optional preamble injected ABOVE the bundled source inside the managed block (CLAUDE.md). */
    preamble?: string;
}

/**
 * Ensure a workspace protocol file (AGENTS.md / CLAUDE.md) contains the managed
 * Switchboard protocol block. The bundled source is always `AGENTS.md`; the
 * target filename, boundary markers, header heuristic, and optional preamble are
 * parameterized so AGENTS.md and CLAUDE.md share one code path.
 *
 * Preserves user content outside the boundary markers. For legacy markerless
 * files (per-target header present, no markers), replaces the entire file.
 * Idempotent: skips if the managed block is already up-to-date.
 */
async function ensureProtocolFile(
    workspaceUri: vscode.Uri,
    extensionUri: vscode.Uri,
    opts: ProtocolFileOptions
): Promise<{ status: AgentsProtocolStatus; reason: string }> {
    const { targetFileName, blockStart, blockEnd, header, preamble } = opts;
    const sourceUri = vscode.Uri.joinPath(extensionUri, 'AGENTS.md');
    const targetUri = vscode.Uri.joinPath(workspaceUri, targetFileName);

    // Read bundled source (always AGENTS.md — the single protocol source of truth)
    let sourceContent: string;
    try {
        const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
        sourceContent = Buffer.from(sourceBytes).toString('utf8');
    } catch (error) {
        return { status: 'failed', reason: `Bundled AGENTS.md source is missing or unreadable: ${getErrorMessage(error)}` };
    }

    // Build managed inner content (+ optional preamble) and the marker-wrapped block.
    const managedInner = buildManagedInner(sourceContent, preamble);
    const managedBlock = `${blockStart}\n${managedInner}\n${blockEnd}`;
    const sourceForCreate = `${sourceContent.trimEnd()}\n`;

    // Check if target exists
    let targetContent: string | null = null;
    try {
        const targetBytes = await vscode.workspace.fs.readFile(targetUri);
        targetContent = Buffer.from(targetBytes).toString('utf8');
    } catch (error) {
        if (!isFileNotFoundError(error)) {
            return { status: 'failed', reason: `Failed to read existing ${targetFileName}: ${getErrorMessage(error)}` };
        }
        // Target does not exist — will create.
    }

    if (targetContent === null) {
        // Create new file. CLAUDE.md (preamble present) MUST be created as the
        // managed block: a markerless create would let the legacy branch wipe the
        // preamble on the next run. AGENTS.md keeps the historical markerless
        // create (it self-heals to a managed block on the next pass).
        const createBody = preamble ? `${managedBlock}\n` : sourceForCreate;
        try {
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(createBody, 'utf8'));
            return { status: 'created', reason: `${targetFileName} created from bundled source` };
        } catch (e) {
            return { status: 'failed', reason: `Failed to write ${targetFileName}: ${getErrorMessage(e)}` };
        }
    }

    // Target exists — validate and check for existing protocol block.
    const hasBlockStart = targetContent.includes(blockStart);
    const hasBlockEnd = targetContent.includes(blockEnd);
    const blockStartIndex = targetContent.indexOf(blockStart);
    // Use the FIRST start marker and the LAST end marker so the managed region
    // spans any duplicated/stray markers an earlier buggy scaffold may have left
    // behind (e.g. tripled start/end pairs). Replacing that whole span collapses
    // them back to a single clean block instead of tripping the malformed guard
    // or leaving orphaned trailing markers.
    const blockEndIndex = targetContent.lastIndexOf(blockEnd);
    const startMarkerCount = targetContent.split(blockStart).length - 1;
    const endMarkerCount = targetContent.split(blockEnd).length - 1;
    const hasDuplicateMarkers = startMarkerCount > 1 || endMarkerCount > 1;

    if ((hasBlockStart && !hasBlockEnd) || (!hasBlockStart && hasBlockEnd) || (hasBlockStart && hasBlockEnd && blockStartIndex > blockEndIndex)) {
        return {
            status: 'failed',
            reason: `Detected malformed managed protocol markers in ${targetFileName}; fix markers before rerunning setup`
        };
    }

    if (hasBlockStart && hasBlockEnd) {
        // Extract existing block content. Spans from the first start marker to the
        // last end marker, so any duplicate inner markers are captured here and get
        // collapsed when the managed block is rewritten below.
        const existingBlockContent = targetContent.substring(
            blockStartIndex + blockStart.length,
            blockEndIndex
        ).trim();

        // Compare with the expected managed inner content (preamble + source for
        // CLAUDE.md, bare source for AGENTS.md). Duplicate markers always force an
        // update so the file heals to a single clean block.
        if (!hasDuplicateMarkers && existingBlockContent === managedInner.trim()) {
            return { status: 'skipped', reason: 'Switchboard protocol block already up-to-date' };
        }

        // Content differs (or duplicate markers need collapsing) — perform in-place update
        try {
            const before = targetContent.substring(0, blockStartIndex);
            const after = targetContent.substring(blockEndIndex + blockEnd.length);
            const updated = before + managedBlock + after;
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(updated, 'utf8'));
            return {
                status: 'updated',
                reason: hasDuplicateMarkers
                    ? 'Collapsed duplicate protocol markers and updated block to latest bundled version'
                    : 'Switchboard protocol block updated to latest bundled version'
            };
        } catch (e) {
            return { status: 'failed', reason: `Failed to update ${targetFileName}: ${getErrorMessage(e)}` };
        }
    }

    if (hasProtocolHeaderLine(targetContent, header)) {
        // Legacy markerless file — replace entire content with managed block.
        // The old file was fully scaffolded by the extension, so this is safe.
        // Keyed on the PER-TARGET header so a normal CLAUDE.md (or a CLAUDE.md
        // whose copied body still contains the AGENTS header) is not mis-detected.
        try {
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(managedBlock + '\n', 'utf8'));
            return { status: 'updated', reason: `Legacy markerless ${targetFileName} replaced with managed block` };
        } catch (e) {
            return { status: 'failed', reason: `Failed to replace legacy ${targetFileName}: ${getErrorMessage(e)}` };
        }
    }

    // Append protocol block, preserving existing content
    try {
        const separator = targetContent.endsWith('\n') ? '\n' : '\n\n';
        const merged = targetContent + separator + managedBlock + '\n';
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(merged, 'utf8'));
        return { status: 'appended', reason: `Switchboard protocol block appended to existing ${targetFileName}` };
    } catch (e) {
        return { status: 'failed', reason: `Failed to append to ${targetFileName}: ${getErrorMessage(e)}` };
    }
}

/** Thin wrapper: scaffold the AGENTS.md managed block (Antigravity host). */
async function ensureAgentsProtocol(
    workspaceUri: vscode.Uri,
    extensionUri: vscode.Uri
): Promise<{ status: AgentsProtocolStatus; reason: string }> {
    return ensureProtocolFile(workspaceUri, extensionUri, {
        targetFileName: 'AGENTS.md',
        blockStart: AGENTS_BLOCK_START,
        blockEnd: AGENTS_BLOCK_END,
        header: AGENTS_PROTOCOL_HEADER,
    });
}

/** Thin wrapper: scaffold the CLAUDE.md managed block (Claude Code host) with the Claude preamble. */
async function ensureClaudeProtocol(
    workspaceUri: vscode.Uri,
    extensionUri: vscode.Uri
): Promise<{ status: AgentsProtocolStatus; reason: string }> {
    return ensureProtocolFile(workspaceUri, extensionUri, {
        targetFileName: 'CLAUDE.md',
        blockStart: CLAUDE_BLOCK_START,
        blockEnd: CLAUDE_BLOCK_END,
        header: CLAUDE_PROTOCOL_HEADER,
        preamble: CLAUDE_PREAMBLE,
    });
}

/** Resolve which protocol layers to scaffold from the `switchboard.protocol.target` setting. */
function getProtocolTargets(workspaceUri?: vscode.Uri): { agents: boolean; claude: boolean } {
    let target = 'both';
    try {
        target = vscode.workspace
            .getConfiguration('switchboard', workspaceUri)
            .get<string>('protocol.target', 'both');
    } catch { /* default to both */ }
    return {
        agents: target === 'agents' || target === 'both',
        claude: target === 'claude' || target === 'both',
    };
}

/**
 * Scaffold the selected protocol layers (AGENTS.md / CLAUDE.md + `.claude/` mirror)
 * for a workspace root. Each target is independently marker-managed and the mirror
 * is independent of AGENTS.md, so running all selected targets is safe/idempotent.
 */
async function scaffoldProtocolLayers(
    workspaceUri: vscode.Uri,
    extensionUri: vscode.Uri,
    logPrefix: string
): Promise<void> {
    const targets = getProtocolTargets(workspaceUri);

    if (targets.agents) {
        try {
            const r = await ensureAgentsProtocol(workspaceUri, extensionUri);
            outputChannel?.appendLine(`[${logPrefix}] AGENTS.md: ${r.status} — ${r.reason}`);
        } catch (e) {
            outputChannel?.appendLine(`[${logPrefix}] AGENTS.md scaffolding error (non-fatal): ${e}`);
        }
    }

    if (targets.claude) {
        try {
            const r = await ensureClaudeProtocol(workspaceUri, extensionUri);
            outputChannel?.appendLine(`[${logPrefix}] CLAUDE.md: ${r.status} — ${r.reason}`);
        } catch (e) {
            outputChannel?.appendLine(`[${logPrefix}] CLAUDE.md scaffolding error (non-fatal): ${e}`);
        }
        try {
            const version = getExtensionVersion(extensionUri.fsPath);
            const m = generateClaudeMirror(workspaceUri.fsPath, version);
            outputChannel?.appendLine(`[${logPrefix}] .claude/skills mirror: ${m.status} — ${m.reason}`);
        } catch (e) {
            outputChannel?.appendLine(`[${logPrefix}] .claude/skills mirror error (non-fatal): ${e}`);
        }
    }
}

/**
 * Migrate legacy plan subdirectories (features/, antigravity_plans/) into the
 * unified .switchboard/plans/ root. Repo-scoped control-plane folders under
 * `.switchboard/plans/<repoName>/` are valid and must not be flattened here.
 * Collision-safe: appends a suffix on name clash. Backs up plan_registry.json
 * before mutating it.
 */
async function migrateLegacyPlans(workspaceRoot: string): Promise<void> {
    const plansRoot = path.join(workspaceRoot, '.switchboard', 'plans');
    const legacyDirs = [
        path.join(plansRoot, 'features'),
        path.join(plansRoot, 'antigravity_plans'),
    ];

    const collectLegacyFiles = async (dir: string): Promise<string[]> => {
        let entries: Dirent[];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return [];
        }

        const files: string[] = [];
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isFile()) {
                files.push(fullPath);
                continue;
            }
            if (entry.isDirectory()) {
                files.push(...await collectLegacyFiles(fullPath));
            }
        }
        return files;
    };

    const db = KanbanDatabase.forWorkspace(workspaceRoot);
    const dbReady = await db.ensureReady();

    for (const legacyDir of legacyDirs) {
        if (!fs.existsSync(legacyDir)) continue;
        const files = await collectLegacyFiles(legacyDir);
        if (files.length === 0) {
            try { await fs.promises.rm(legacyDir, { recursive: true, force: true }); } catch { }
            continue;
        }

        const subDirName = path.basename(legacyDir);
        const renamedFilesMap = new Map<string, string>();

        for (const srcPath of files) {
            const originalName = path.basename(srcPath);
            let destName = originalName;
            let destPath = path.join(plansRoot, destName);

            if (fs.existsSync(destPath)) {
                const ext = path.extname(destName);
                const base = path.basename(destName, ext);
                let suffix = 1;
                do {
                    destName = `${base}_migrated${suffix}${ext}`;
                    destPath = path.join(plansRoot, destName);
                    suffix++;
                } while (fs.existsSync(destPath));
            }

            try {
                await fs.promises.rename(srcPath, destPath);
                renamedFilesMap.set(originalName, destName);
            } catch {
                try {
                    await fs.promises.copyFile(srcPath, destPath);
                    await fs.promises.unlink(srcPath);
                    renamedFilesMap.set(originalName, destName);
                } catch { continue; }
            }

            // Update DB plan entries pointing to old paths
            if (dbReady) {
                const oldRelative = `.switchboard/plans/${subDirName}/${originalName}`;
                const newRelative = `.switchboard/plans/${destName}`;
                try {
                    const wsId = await db.getWorkspaceId() || '';
                    if (wsId) {
                        const plan = await db.getPlanByPlanFile(oldRelative, wsId);
                        if (plan) {
                            await db.updatePlanFile(plan.sessionId, newRelative);
                        }
                    }
                } catch { /* non-fatal */ }
            }
        }

        try { await fs.promises.rm(legacyDir, { recursive: true, force: true }); } catch { }
        try { await fs.promises.rmdir(legacyDir); } catch { }
    }
}

/**
 * Clean up obsolete agent files from user workspaces.
 * - no_git_for_agents.md: Git prohibition removed in favor of prompts tab
 * - switchboard_modes.md: Mode triggers superseded by prompts tab checkboxes
 * - handoff*.md: Delegation workflows superseded by prompts tab
 */
async function cleanupLegacyAgentFiles(workspaceRoot: string): Promise<void> {
    const legacyFiles = [
        'rules/no_git_for_agents.md',
        'rules/switchboard_modes.md',
        'workflows/handoff.md',
        'workflows/handoff-chat.md',
        'workflows/handoff-lead.md',
        'workflows/handoff-relay.md',
        'workflows/challenge.md',
        'workflows/chat.md', // Renamed to switchboard-chat.md (now switchboard-cloud.md)
        // 2026-07-12 four-front-doors refactor: retired workflow files relocated to
        // .agents/skills/ (internal) or .agents/workflows/switchboard-*.md (doors).
        // Without this cleanup, Antigravity keeps showing the old slash commands on
        // existing installs after the update (the copy step never deletes source-removed
        // files). Reload the window / start a fresh conversation before checking the
        // slash menu — Antigravity's picker registry is session-cached.
        'workflows/switchboard-index.md',
        'workflows/switchboard-manage.md',
        'workflows/switchboard-split.md',
        'workflows/switchboard-chat.md',
        'workflows/sw-remote.md',
        'workflows/memo.md',
        'workflows/improve-plan.md',
        'workflows/improve-feature.md',
        'workflows/accuracy.md',
        'workflows/switchboard-orchestrator.md',
        // The manage-console skill body was absorbed into workflows/switchboard.md;
        // the standalone skill dir is retired (its stale copy would drift from the door).
        'skills/switchboard-manage/SKILL.md',
    ];
    // Only operate on .agents/ (Switchboard's managed directory). A pre-existing
    // .agent/ belongs to the user and must be left byte-for-byte untouched — the
    // only sanctioned way to remove it is the guarded, opt-in Setup-tab cleanup
    // button (see SetupPanelProvider._performAgentDirCleanup).
    const agentDir = '.agents';
    for (const relativePath of legacyFiles) {
        const fullPath = path.join(workspaceRoot, agentDir, relativePath);
        try {
            await fs.promises.access(fullPath);
            await fs.promises.unlink(fullPath);
            outputChannel?.appendLine(`[Switchboard] Removed legacy file: ${path.join(agentDir, relativePath)}`);
        } catch {
            // File does not exist or cannot be removed — non-fatal
        }
    }
}

async function maybeOfferControlPlaneOnboarding(workspaceRoot: string): Promise<void> {
    const resolvedWorkspaceRoot = path.resolve(workspaceRoot || '');
    if (!resolvedWorkspaceRoot) {
        return;
    }

    if (fs.existsSync(path.join(resolvedWorkspaceRoot, '.switchboard', 'kanban.db'))) {
        return;
    }

    const switchboardConfig = vscode.workspace.getConfiguration('switchboard');
    const dismissed = switchboardConfig.get<boolean>('controlPlane.onboardingDismissed', false);
    if (dismissed) {
        return;
    }

    const candidate = await ControlPlaneMigrationService.detectCandidateParent(resolvedWorkspaceRoot);
    if (!candidate.suggestedParentDir || candidate.alreadyControlPlane) {
        return;
    }
    if (candidate.discoveredRepos.filter((repo) => repo.hasGit).length < 2) {
        return;
    }

    const selection = await vscode.window.showInformationMessage(
        'Switchboard: Set up a Control Plane in your GitHub folder? All config stays outside your repos — no .gitignore needed.',
        'Set Up Control Plane',
        'Not Now'
    );

    if (selection === 'Set Up Control Plane') {
        await vscode.commands.executeCommand('switchboard.setupControlPlane');
        return;
    }

    if (selection === 'Not Now') {
        await switchboardConfig.update('controlPlane.onboardingDismissed', true, vscode.ConfigurationTarget.Workspace);
    }
}

/**
 * Recursively list files under a URI using vscode.workspace.fs.
 * Returns relative paths (posix-style) suitable for Uri.joinPath.
 */
async function crawlDirectory(uri: vscode.Uri, depth: number = 0): Promise<string[]> {
    if (depth > 5) return [];
    let entries: [string, vscode.FileType][];
    try {
        entries = await vscode.workspace.fs.readDirectory(uri);
    } catch {
        return [];
    }
    const results: string[] = [];
    for (const [name, type] of entries) {
        if (type === vscode.FileType.File) {
            results.push(name);
        } else if (type === vscode.FileType.Directory) {
            const childPaths = await crawlDirectory(vscode.Uri.joinPath(uri, name), depth + 1);
            for (const rel of childPaths) {
                results.push(name + path.sep + rel);
            }
        }
    }
    return results;
}

/**
 * Perform actual setup logic (Unified)
 */
async function performSetup(workspaceUri: vscode.Uri, extensionUri: vscode.Uri, options: { silent: boolean }) {
    const workspaceRoot = workspaceUri.fsPath;
    // 1. Core directories (project docs + runtime messaging)
    const dirs = [
        '.agents',
        '.switchboard/plans',
        '.switchboard/archive'
    ];

    for (const dir of dirs) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceUri, dir));
    }

    // Migrate legacy plan subdirectories into unified .switchboard/plans/ root
    await migrateLegacyPlans(workspaceUri.fsPath);

    // 2. Discover and Copy .agents assets (Recursive & Depth-Limited)
    const agentSourceUri = vscode.Uri.joinPath(extensionUri, '.agents');
    const agentFiles = await crawlDirectory(agentSourceUri);

    // 2a. Version-gated workflow migration (retained as a redundant fast path for
    // any migration side effects, but no longer the sole delivery trigger —
    // workflow .md files now also flow through the content-hash path below so a
    // door rename lands on same-version installs).
    const needsWorkflowMigration = shouldRefreshAgentWorkspaceFiles(extensionUri.fsPath, workspaceUri.fsPath);

    for (const relativePath of agentFiles) {
        const srcUri = vscode.Uri.joinPath(agentSourceUri, relativePath);
        const destUri = vscode.Uri.joinPath(workspaceUri, '.agents', relativePath);

        // Ensure parent directory exists
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));

        const isWorkflowFile = relativePath.startsWith('workflows' + path.sep) && relativePath.endsWith('.md');

        if (isWorkflowFile && needsWorkflowMigration) {
            // Workflow files are canonical extension definitions — always overwrite on version change.
            // Per-file failure tolerance: one unwritable file must not abort setup for the rest.
            // (Content-hash path below also runs for workflows, so same-version installs self-heal too.)
            try {
                await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: true });
            } catch (copyErr) {
                console.warn(`[Setup] Workflow copy failed for ${relativePath}, skipping:`, copyErr);
            }
            continue;
        }

        // Content-hash self-healing for all agent files (skills AND workflows when
        // the version gate did not fire): copy if absent, overwrite iff bundle
        // content differs from workspace content. Fail-safe: skip on hash error,
        // never clobber blindly. User-authored (non-bundled) files are never
        // touched — the loop only iterates files present in the bundle. This is
        // the delivery guarantee for workflow door renames on same-version installs.
        try {
            await vscode.workspace.fs.stat(destUri);
            // dest exists → overwrite iff content differs
            try {
                const [srcHash, destHash] = await Promise.all([
                    ControlPlaneMigrationService.hashFile(srcUri.fsPath),
                    ControlPlaneMigrationService.hashFile(destUri.fsPath),
                ]);
                if (srcHash !== destHash) {
                    await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: true });
                }
            } catch (hashErr) {
                // Fail-safe: skip on hash error/write error, never clobber blindly,
                // never abort the loop — remaining files still refresh.
                console.warn(`[Setup] Agent file content-hash refresh failed for ${relativePath}, skipping:`, hashErr);
            }
        } catch {
            // dest absent → copy new file. Per-file failure tolerance as above.
            try {
                await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
            } catch (copyErr) {
                console.warn(`[Setup] Agent file copy failed for ${relativePath}, skipping:`, copyErr);
            }
        }
    }

    // Update agent version tracking after successful copy
    const currentVersion = getExtensionVersion(extensionUri.fsPath);
    if (currentVersion) {
        setLastCopiedAgentVersion(workspaceUri.fsPath, currentVersion);
    }

    // 2b. Blocklist: remove files that should never be distributed even if present in source
    const blocklist = [
        '.agents/rules/no_git_for_agents.md',
        '.agents/rules/switchboard_modes.md',
        '.agents/workflows/handoff.md',
        '.agents/workflows/handoff-chat.md',
        '.agents/workflows/handoff-lead.md',
        '.agents/workflows/handoff-relay.md',
        '.agents/workflows/challenge.md',
        '.agents/personas/switchboard_operator.md',
        // 2026-07-12 four-front-doors refactor: retired workflow files (relocated to
        // skills/ or renamed to switchboard-*.md doors). Remove from existing installs
        // so Antigravity's slash menu stops showing the old commands after update.
        '.agents/workflows/switchboard-index.md',
        '.agents/workflows/switchboard-manage.md',
        '.agents/workflows/switchboard-split.md',
        '.agents/workflows/switchboard-chat.md',
        '.agents/workflows/sw-remote.md',
        '.agents/workflows/memo.md',
        '.agents/workflows/improve-plan.md',
        '.agents/workflows/improve-feature.md',
        '.agents/workflows/accuracy.md',
        '.agents/workflows/switchboard-orchestrator.md',
        '.agents/skills/switchboard-manage/SKILL.md',
    ];
    for (const blockPath of blocklist) {
        const blockUri = vscode.Uri.joinPath(workspaceUri, blockPath);
        try {
            await vscode.workspace.fs.delete(blockUri, { useTrash: false });
        } catch { /* non-fatal */ }
    }

    // 2b. Protocol-file scaffolding (non-destructive, failure-isolated).
    // Scaffolds AGENTS.md / CLAUDE.md + the .claude/ mirror per the configured
    // target. `.agents/` is already copied above, so the mirror sees a populated
    // source. Targets the same active workspace root used by setup flow.
    await scaffoldProtocolLayers(workspaceUri, extensionUri, 'Setup');

    // 3. Create README Stub
    const readmeUri = vscode.Uri.joinPath(workspaceUri, '.switchboard', 'README.md');
    try {
        await vscode.workspace.fs.stat(readmeUri);
    } catch {
        const readmeContent = `# Switchboard\n\nThis folder contains workflow artifacts — review outputs, session logs, and audit reports.\n\nSee \`WORKFLOW_REFERENCE.md\` for full workflow documentation.\n\n### Quick Start\n- Terminal and messaging setup is handled automatically on extension activation.\n- Use the **Prompts tab** to inject delegation instructions for external agents.\n- Use \`/switchboard\` for the management console (plan, dispatch, track, automate).`;
        await vscode.workspace.fs.writeFile(readmeUri, Buffer.from(readmeContent, 'utf8'));
    }


}

/**
 * Show interactive setup wizard
 */
async function showSetupWizard(context: vscode.ExtensionContext, taskViewerProvider?: TaskViewerProvider) {
    const workspaceRoot = kanbanProvider?.getCurrentWorkspaceRoot() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
    }

    const switchboardConfig = vscode.workspace.getConfiguration('switchboard');

    // Persist Light-mode team prompt rigor (default for all setup flows)
    const persistTeamRigor = async () => {
        await switchboardConfig.update('team.strictPrompts', false, vscode.ConfigurationTarget.Workspace);
        await switchboardConfig.update('planner.strictPrompts', false, vscode.ConfigurationTarget.Workspace);
        await switchboardConfig.update('review.strictPrompts', false, vscode.ConfigurationTarget.Workspace);
        outputChannel?.appendLine(`[Setup] Team prompt rigor set to light (workspace).`);
    };

    // Show progress
    await vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: 'Setting up Switchboard configurations...',
        cancellable: true
    }, async (progress, token) => {
        progress.report({ increment: 0 });

        if (token.isCancellationRequested) return;
        await persistTeamRigor();

        // Run unified setup first (Project structure and .agents assets)
        if (token.isCancellationRequested) return;
        await performSetup(vscode.Uri.file(workspaceRoot), context.extensionUri, { silent: false });

        // LAZY CHANGE: Explicitly create database after setup
        if (token.isCancellationRequested) return;
        if (taskViewerProvider) {
            try {
                const db = await taskViewerProvider.getKanbanDbForRoot(workspaceRoot);
                if (db) {
                    const created = await db.createIfMissing();
                    if (created) {
                        console.log(`[SetupWizard] Database initialized for ${workspaceRoot}`);
                    }
                }
            } catch (dbErr) {
                console.error(`[SetupWizard] Database creation failed (non-fatal):`, dbErr);
            }
        }

        if (taskViewerProvider) {
            try {
                if (token.isCancellationRequested) return;
                await taskViewerProvider.seedBrainPlanBlacklistFromCurrentBrainSnapshot();
            } catch (e) {
                outputChannel?.appendLine(`[Setup] Brain blacklist seeding failed (non-fatal): ${e}`);
            }
        }

        progress.report({ increment: 100 });

        // Hide status bar item if it exists
        if (setupStatusBarItem) {
            setupStatusBarItem.hide();
        }

        // Refresh the webview to update UI
        vscode.commands.executeCommand('switchboard.refresh');
    });
}

export function deactivate() {
    // Dispose ALL Switchboard-managed terminals so they don't persist as orphans
    activeTaskViewerProvider?.clearAllTerminalAgentInfo();
    for (const [name, terminal] of registeredTerminals) {
        try {
            terminal.dispose();
        } catch {
            // Terminal may already be closed
        }
    }
    registeredTerminals.clear();

    // Phase 1 Workstream A: stop the idle-eviction sweep and evict ALL cached
    // KanbanDatabase instances (drain + flush + close) so the shared WASM heap is
    // released before the host process exits. Without this, sql.js MEMFS buffers
    // persist until the extension host process is torn down.
    KanbanDatabase.stopEvictionSweep();
    void KanbanDatabase.evictAll();

    // Cleanup other resources
    if (setupStatusBarItem) {
        setupStatusBarItem.dispose();
    }
    if (outputChannel) {
        outputChannel.dispose();
        outputChannel = null;
    }
}
