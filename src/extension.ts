
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
import { WorkspaceExcludeService } from './services/WorkspaceExcludeService';
import { cleanWorkspace, pruneZombieTerminalEntries } from './lifecycle/cleanWorkspace';
import { PlanningPanelProvider } from './services/PlanningPanelProvider';
import { DesignPanelProvider } from './services/DesignPanelProvider';
import { PanelStateStore } from './services/PanelStateStore';
import { PlannerPromptWriter } from './services/PlannerPromptWriter';
import { PlanningPanelCacheService } from './services/PlanningPanelCacheService';
import { ResearchImportService } from './services/ResearchImportService';

// Status bar item for setup notification
let setupStatusBarItem: vscode.StatusBarItem;

// Status bar item for file opening prevention toggle
let fileOpeningPreventionStatusBarItem: vscode.StatusBarItem;
let terminalOpenStatusBarItem: vscode.StatusBarItem;
let terminalClearStatusBarItem: vscode.StatusBarItem;
let terminalResetStatusBarItem: vscode.StatusBarItem;
let kanbanStatusBarItem: vscode.StatusBarItem;
let artifactsStatusBarItem: vscode.StatusBarItem;
let designStatusBarItem: vscode.StatusBarItem;

// Global references
let outputChannel: vscode.OutputChannel | null = null;
let kanbanProvider: KanbanProvider | null = null;
let activeTaskViewerProvider: TaskViewerProvider | null = null;

// Agent File Opening Prevention: URIs explicitly allowed to stay open
const allowedUrisToOpen = new Set<string>();

// Sync context key for menu visibility. The context key name uses an "Enabled" suffix
// to distinguish it from the configuration property "switchboard.preventAgentFileOpening".
const preventAgentFileOpening = vscode.workspace.getConfiguration('switchboard').get<boolean>('preventAgentFileOpening', false);
void vscode.commands.executeCommand('setContext', 'switchboard.preventAgentFileOpeningEnabled', preventAgentFileOpening);

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
    } catch (err) {
        console.error('[Switchboard] Mapping index initialization failed, continuing activation:', err);
        outputChannel?.appendLine(`[Switchboard] Mapping index initialization FAILED: ${err}`);
    }

    kanbanProvider = new KanbanProvider(context.extensionUri, context, outputChannel);
    const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();

    // Version-gated AGENTS.md migration: when the extension version changes,
    // ensure the workspace AGENTS.md is updated to the latest bundled version.
    // This handles the transition from full-protocol to skills-only AGENTS.md.
    if (workspaceRoot) {
        try {
            if (shouldRefreshAgentWorkspaceFiles(context.extensionUri.fsPath, workspaceRoot)) {
                const agentsResult = await ensureAgentsProtocol(
                    vscode.Uri.file(workspaceRoot),
                    context.extensionUri
                );
                outputChannel?.appendLine(
                    `[Migration] AGENTS.md: ${agentsResult.status} — ${agentsResult.reason}`
                );
                // Record the version so the migration doesn't re-run on every activation.
                const currentVersion = getExtensionVersion(context.extensionUri.fsPath);
                if (currentVersion) {
                    setLastCopiedAgentVersion(workspaceRoot, currentVersion);
                }
            }
        } catch (err) {
            console.error('[Switchboard] AGENTS.md migration failed, continuing activation:', err);
        }
    }

    const globalPlanWatcher = new GlobalPlanWatcherService(
        (workspaceRoot: string) => (kanbanProvider as any)._getClickUpService(workspaceRoot),
        outputChannel
    );
    await globalPlanWatcher.initialize();
    context.subscriptions.push(globalPlanWatcher);

    // Wire the watcher into the already-created KanbanProvider
    await kanbanProvider!.setGlobalPlanWatcher(globalPlanWatcher);

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
    const setupDisposable = vscode.commands.registerCommand('switchboard.setup', async () => {
        await showSetupWizard(context, taskViewerProvider);
    });
    context.subscriptions.push(setupDisposable);

    const initiatePlanDisposable = vscode.commands.registerCommand('switchboard.initiatePlan', async () => {
        await taskViewerProvider?.createDraftPlanTicket();
    });
    context.subscriptions.push(initiatePlanDisposable);

    const importFromClipboardDisposable = vscode.commands.registerCommand('switchboard.importPlanFromClipboard', async (markdownText?: string) => {
        await taskViewerProvider?.importPlanFromClipboard(markdownText);
    });
    context.subscriptions.push(importFromClipboardDisposable);

    const importNotebookLMPlansDisposable = vscode.commands.registerCommand('switchboard.importNotebookLMPlans', async (workspaceRoot?: string) => {
        return await taskViewerProvider?.importNotebookLMPlans(workspaceRoot);
    });
    context.subscriptions.push(importNotebookLMPlansDisposable);

    const selectSessionDisposable = vscode.commands.registerCommand('switchboard.selectSession', (sessionId: string) => {
        if (typeof sessionId === 'string' && sessionId.trim()) {
            taskViewerProvider.selectSession(sessionId);
        }
    });
    context.subscriptions.push(selectSessionDisposable);

    const createAgentGridDisposable = vscode.commands.registerCommand('switchboard.createAgentGrid', async (args?: any) => {
        await createAgentGrid(args);
    });
    const createAgentGridEditorDisposable = vscode.commands.registerCommand('switchboard.createAgentGridEditor', async () => {
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
    void kanbanProvider!.initializeIntegrationAutoPull();
    context.subscriptions.push(
        vscode.workspace.onDidChangeWorkspaceFolders(() => {
            void kanbanProvider!.initializeIntegrationAutoPull();
        })
    );
    if (workspaceRoot) {
        await taskViewerProvider.initializeKanbanDbOnStartup();
    }
    const openKanbanDisposable = vscode.commands.registerCommand('switchboard.openKanban', async (tab?: string) => {
        await kanbanProvider!.open(tab);
    });
    context.subscriptions.push(openKanbanDisposable);

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
        getCacheService,
        syncDesignDocLinkForActiveSources: (root) => (kanbanProvider as any)._syncDesignDocLinkForActiveSources(root)
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

    const openPlanningPanelDisposable = vscode.commands.registerCommand(
        'switchboard.openPlanningPanel',
        async () => { await planningPanelProvider.open(); }
    );
    context.subscriptions.push(openPlanningPanelDisposable);

    const openDesignPanelDisposable = vscode.commands.registerCommand(
        'switchboard.openDesignPanel',
        async () => { await designPanelProvider.open(); }
    );
    context.subscriptions.push(openDesignPanelDisposable);

    const rebuildStitchCacheDisposable = vscode.commands.registerCommand('switchboard.rebuildStitchCache', async () => {
        const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }
        const confirm = await vscode.window.showWarningMessage(
            'This will delete ALL cached Stitch projects and screens for the current workspace database and re-fetch from the API. Continue?',
            { modal: true },
            'Rebuild'
        );
        if (confirm !== 'Rebuild') return;
        await designPanelProvider.rebuildStitchCache(workspaceRoot);
    });
    context.subscriptions.push(rebuildStitchCacheDisposable);

    const triggerPlanningPanelSyncDisposable = vscode.commands.registerCommand(
        'switchboard.triggerPlanningPanelSync',
        async (mode?: string) => {
            const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
            if (workspaceRoot) {
                await planningPanelProvider.triggerSync(workspaceRoot, mode);
            } else {
                vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            }
        }
    );
    context.subscriptions.push(triggerPlanningPanelSyncDisposable);

    const openSetupPanelDisposable = vscode.commands.registerCommand('switchboard.openSetupPanel', async (section?: string) => {
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
    const clearControlPlaneCacheDisposable = vscode.commands.registerCommand('switchboard.clearControlPlaneCache', async () => {
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
    const refreshControlPlaneRuntimeDisposable = vscode.commands.registerCommand('switchboard.refreshControlPlaneRuntime', async () => {
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
    const fullSyncDisposable = vscode.commands.registerCommand('switchboard.fullSync', async () => {
        await taskViewerProvider.fullSync();
    });
    context.subscriptions.push(fullSyncDisposable);

    // Manual "Import plans" — list unclaimed plans across configured sources (any age)
    // and let the user pick which to add to the board.
    const importPlansDisposable = vscode.commands.registerCommand('switchboard.importUnclaimedPlans', async () => {
        await taskViewerProvider.handleImportUnclaimedPlans();
    });
    context.subscriptions.push(importPlansDisposable);

    // Reset Kanban Database command — deletes local DB and rebuilds from plan files
    const resetKanbanDbDisposable = vscode.commands.registerCommand('switchboard.resetKanbanDb', async (targetWorkspaceRoot?: string) => {
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
        vscode.window.showInformationMessage(
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
    const reconcileKanbanDisposable = vscode.commands.registerCommand('switchboard.reconcileKanbanDbs', async () => {
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
            vscode.window.showInformationMessage('Only one database found. Nothing to reconcile.');
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
            vscode.window.showInformationMessage(`✅ Reconciliation complete. ${merged} plans merged.`);
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

    const refreshUIDisposable = vscode.commands.registerCommand('switchboard.refreshUI', async (workspaceRoot?: string) => {
        await taskViewerProvider.refreshUI(workspaceRoot);
    });
    context.subscriptions.push(refreshUIDisposable);

    const mappingsChangedDisposable = vscode.commands.registerCommand('switchboard.mappingsChanged', async () => {
        // Clear mapping cache
        const { clearMappingCache } = require('./services/WorkspaceIdentityService');
        clearMappingCache();
        // Rebuild index
        await initializeMappingIndex(outputChannel ?? undefined);
        // Refresh UI
        kanbanProvider!._scheduleBoardRefresh();
        // Tell watchers to refresh
        if (globalPlanWatcher) {
            await globalPlanWatcher.refreshWatchers({ clearProjectFilters: true });
        }
    });
    context.subscriptions.push(mappingsChangedDisposable);

    // Helper commands for Kanban ↔ sidebar delegation
    const triggerFromKanbanDisposable = vscode.commands.registerCommand('switchboard.triggerAgentFromKanban', async (role: string, sessionId: string, instruction?: string, workspaceRoot?: string) => {
        return await taskViewerProvider.handleKanbanTrigger(role, sessionId, instruction, workspaceRoot);
    });
    context.subscriptions.push(triggerFromKanbanDisposable);

    const analystMapFromKanbanDisposable = vscode.commands.registerCommand('switchboard.analystMapFromKanban', async (sessionId: string, workspaceRoot?: string) => {
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

    const batchTriggerFromKanbanDisposable = vscode.commands.registerCommand('switchboard.triggerBatchAgentFromKanban', async (role: string, sessionIds: string[], instruction?: string, workspaceRoot?: string, targetTerminalOverride?: string) => {
        return taskViewerProvider.handleKanbanBatchTrigger(role, sessionIds, instruction, workspaceRoot, targetTerminalOverride);
    });
    context.subscriptions.push(batchTriggerFromKanbanDisposable);

    const batchDispatchLowDisposable = vscode.commands.registerCommand('switchboard.batchDispatchLow', async (workspaceRoot?: string) => {
        return taskViewerProvider.handleBatchDispatchLow(workspaceRoot);
    });
    context.subscriptions.push(batchDispatchLowDisposable);

    const kanbanBackwardMoveDisposable = vscode.commands.registerCommand('switchboard.kanbanBackwardMove', async (sessionIds: string[], targetColumn: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleKanbanBackwardMove(sessionIds, targetColumn, workspaceRoot);
    });
    context.subscriptions.push(kanbanBackwardMoveDisposable);

    const kanbanForwardMoveDisposable = vscode.commands.registerCommand('switchboard.kanbanForwardMove', async (sessionIds: string[], targetColumn: string, workspaceRoot?: string, sourceColumn?: string) => {
        return taskViewerProvider.handleKanbanForwardMove(sessionIds, targetColumn, workspaceRoot, sourceColumn);
    });
    context.subscriptions.push(kanbanForwardMoveDisposable);

    const completePlanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.completePlanFromKanban', async (sessionId: string, workspaceRoot?: string) => {
        return taskViewerProvider.handleKanbanCompletePlan(sessionId, workspaceRoot);
    });
    context.subscriptions.push(completePlanFromKanbanDisposable);

    const restorePlanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.restorePlanFromKanban', async (planId: string, workspaceRoot?: string) => {
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

    const setAutobanFromKanbanDisposable = vscode.commands.registerCommand('switchboard.setAutobanEnabledFromKanban', async (enabled: boolean) => {
        await taskViewerProvider.setAutobanEnabledFromKanban(!!enabled);
    });
    context.subscriptions.push(setAutobanFromKanbanDisposable);

    const resetAutobanTimersDisposable = vscode.commands.registerCommand('switchboard.resetAutobanTimersFromKanban', async () => {
        await taskViewerProvider.resetAutobanTimersFromKanban();
    });
    context.subscriptions.push(resetAutobanTimersDisposable);

    const setAutobanPausedDisposable = vscode.commands.registerCommand('switchboard.setAutobanPausedFromKanban', async (paused: boolean) => {
        await taskViewerProvider.setAutobanPausedFromKanban(!!paused);
    });
    context.subscriptions.push(setAutobanPausedDisposable);

    const setPairProgrammingModeDisposable = vscode.commands.registerCommand('switchboard.setPairProgrammingModeFromKanban', async (mode: string) => {
        await taskViewerProvider.setPairProgrammingMode(mode);
    });
    context.subscriptions.push(setPairProgrammingModeDisposable);

    const addAutobanTerminalDisposable = vscode.commands.registerCommand('switchboard.addAutobanTerminalFromKanban', async (role: string, requestedName?: string, cwd?: string) => {
        await taskViewerProvider.addAutobanTerminalFromKanban(role, requestedName, cwd);
    });
    context.subscriptions.push(addAutobanTerminalDisposable);

    const removeAutobanTerminalDisposable = vscode.commands.registerCommand('switchboard.removeAutobanTerminalFromKanban', async (role: string, terminalName: string) => {
        await taskViewerProvider.removeAutobanTerminalFromKanban(role, terminalName);
    });
    context.subscriptions.push(removeAutobanTerminalDisposable);

    const resetAutobanPoolsDisposable = vscode.commands.registerCommand('switchboard.resetAutobanPoolsFromKanban', async () => {
        await taskViewerProvider.resetAutobanPoolsFromKanban();
    });
    context.subscriptions.push(resetAutobanPoolsDisposable);

    const dispatchToCoderTerminalDisposable = vscode.commands.registerCommand('switchboard.dispatchToCoderTerminal', async (prompt: string, worktreePath?: string) => {
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
            vscode.window.showInformationMessage('ClickUp API token saved securely.');
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
                vscode.window.showInformationMessage(msg);
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
            vscode.window.showInformationMessage('Linear API token saved securely.');
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
            vscode.window.showInformationMessage('Notion API token saved securely.');
        }
    });
    context.subscriptions.push(setNotionTokenDisposable);

    const fetchNotionDesignDocDisposable = vscode.commands.registerCommand('switchboard.fetchNotionDesignDoc', async () => {
        const workspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot();
        if (!workspaceRoot) {
            vscode.window.showWarningMessage('Please select a workspace in the kanban board first.');
            return;
        }
        const service = new NotionFetchService(workspaceRoot, context.secrets);
        const config = await service.loadConfig();
        const url = config?.designDocUrl;
        if (!url) {
            vscode.window.showWarningMessage('No Notion design doc URL configured. Set one in Switchboard settings.');
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: 'Fetching Notion design doc...', cancellable: false },
            async () => {
                const result = await service.fetchAndCache(url);
                if (!result.success) {
                    vscode.window.showErrorMessage(`Notion fetch failed: ${result.error}`);
                } else {
                    vscode.window.showInformationMessage(`Notion design doc fetched (${result.charCount?.toLocaleString()} chars).`);
                }
            }
        );
    });
    context.subscriptions.push(fetchNotionDesignDocDisposable);

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
                vscode.window.showInformationMessage(msg);
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

    const importTaskAsDocumentDisposable = vscode.commands.registerCommand('switchboard.importTaskAsDocument', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string; includeSubtasks?: boolean }) => {
        return taskViewerProvider.importTaskAsDocument(data.workspaceRoot, data);
    });
    context.subscriptions.push(importTaskAsDocumentDisposable);

    const pushTicketEditsDisposable = vscode.commands.registerCommand('switchboard.pushTicketEdits', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string }) => {
        return taskViewerProvider.pushTicketEdits(data.workspaceRoot, data);
    });
    context.subscriptions.push(pushTicketEditsDisposable);

    const importAllTasksDisposable = vscode.commands.registerCommand('switchboard.importAllTasks', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; ids?: string[]; listId?: string; projectId?: string; workspaceId?: string; page?: number; append?: boolean; importMode: 'plan' | 'document' }) => {
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

    const postTicketCommentDisposable = vscode.commands.registerCommand('switchboard.postTicketComment', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; id: string; comment: string }) => {
        return taskViewerProvider.postTicketComment(data.workspaceRoot, data);
    });
    context.subscriptions.push(postTicketCommentDisposable);

    const downloadAttachmentDisposable = vscode.commands.registerCommand('switchboard.downloadAttachment', async (data: { workspaceRoot: string; provider: 'linear' | 'clickup'; url: string; filename: string; ticketId: string; ticketTitle: string }) => {
        return taskViewerProvider.downloadAttachment(data.workspaceRoot, data);
    });
    context.subscriptions.push(downloadAttachmentDisposable);

    const refineTaskDisposable = vscode.commands.registerCommand('switchboard.refineTask', async (data: { workspaceRoot: string; id: string; title: string; description: string; provider: 'linear' | 'clickup' }) => {
        return taskViewerProvider.refineTask(data.workspaceRoot, { id: data.id, title: data.title, description: data.description, provider: data.provider });
    });
    context.subscriptions.push(refineTaskDisposable);

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

        // Auto-close opened files (Agent File Opening Prevention)
        context.subscriptions.push(
            vscode.window.tabGroups.onDidChangeTabs((event) => {
                const config = vscode.workspace.getConfiguration('switchboard');
                if (!config.get<boolean>('preventAgentFileOpening')) {
                    return;
                }

                for (const tab of event.opened) {
                    if (tab.input instanceof vscode.TabInputText) {
                        const uriString = tab.input.uri.toString();
                        if (allowedUrisToOpen.has(uriString)) {
                            allowedUrisToOpen.delete(uriString);
                            continue;
                        }
                        vscode.window.tabGroups.close(tab);
                    }
                }
            })
        );

        // 9. LEASE SYSTEM: Heartbeat removed (no longer needed).
    }

    // Register file-opening commands unconditionally — they do not depend on workspaceRoot
    context.subscriptions.push(
        vscode.commands.registerCommand('switchboard.forceOpenFile', async (uri: vscode.Uri) => {
            if (!uri) {
                return;
            }
            allowedUrisToOpen.add(uri.toString());
            await vscode.commands.executeCommand('vscode.open', uri);
        })
    );

    context.subscriptions.push(
        vscode.commands.registerCommand('switchboard.togglePreventAgentFileOpening', async () => {
            const config = vscode.workspace.getConfiguration('switchboard');
            const current = config.get<boolean>('preventAgentFileOpening', false);
            await config.update('preventAgentFileOpening', !current, vscode.ConfigurationTarget.Workspace);
            // UI refresh is handled by the configuration change listener.
        })
    );

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



    // Initialize file opening prevention status bar item (visibility controlled by statusBar.showAgentOpenToggle)
    fileOpeningPreventionStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 102);
    const currentPreventAgentFileOpening = vscode.workspace.getConfiguration('switchboard').get<boolean>('preventAgentFileOpening', false);
    fileOpeningPreventionStatusBarItem.text = currentPreventAgentFileOpening ? '$(shield) Guard: On' : '$(shield) Guard: Off';
    fileOpeningPreventionStatusBarItem.tooltip = currentPreventAgentFileOpening
        ? 'Agent file opening is blocked. Click to allow agent file opening.'
        : 'Agent file opening is allowed. Click to block agent file opening.';
    fileOpeningPreventionStatusBarItem.command = 'switchboard.togglePreventAgentFileOpening';
    context.subscriptions.push(fileOpeningPreventionStatusBarItem);

    // Initialize terminal grid status bar items
    terminalOpenStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 98);
    terminalOpenStatusBarItem.text = '$(hubot) Agents';
    terminalOpenStatusBarItem.tooltip = 'Open Agent Terminals';
    terminalOpenStatusBarItem.command = 'switchboard.createAgentGrid';
    context.subscriptions.push(terminalOpenStatusBarItem);

    terminalClearStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 97);
    terminalClearStatusBarItem.text = '$(paintcan) Clear';
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

    designStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 99);
    designStatusBarItem.text = '$(paintcan) Design';
    designStatusBarItem.tooltip = 'Open Design Panel';
    designStatusBarItem.command = 'switchboard.openDesignPanel';
    context.subscriptions.push(designStatusBarItem);

    function updateStatusBarVisibility() {
        const config = vscode.workspace.getConfiguration('switchboard');
        const showAgentOpenToggle = config.get<boolean>('statusBar.showAgentOpenToggle', false);
        const showTerminalControls = config.get<boolean>('statusBar.showTerminalControls', false);
        const showKanbanButton = config.get<boolean>('statusBar.showKanbanButton', false);
        const showArtifactsButton = config.get<boolean>('statusBar.showArtifactsButton', false);
        const showDesignButton = config.get<boolean>('statusBar.showDesignButton', false);

        if (showAgentOpenToggle) {
            fileOpeningPreventionStatusBarItem.show();
        } else {
            fileOpeningPreventionStatusBarItem.hide();
        }

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

    }

    updateStatusBarVisibility();

    // Listen for configuration changes
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
        if (e.affectsConfiguration('switchboard.preventAgentFileOpening')) {
            const value = vscode.workspace.getConfiguration('switchboard').get<boolean>('preventAgentFileOpening', false);
            void vscode.commands.executeCommand('setContext', 'switchboard.preventAgentFileOpeningEnabled', value);
            if (fileOpeningPreventionStatusBarItem) {
                fileOpeningPreventionStatusBarItem.text = value ? '$(shield) Guard: On' : '$(shield) Guard: Off';
                fileOpeningPreventionStatusBarItem.tooltip = value
                    ? 'Agent file opening is blocked. Click to allow agent file opening.'
                    : 'Agent file opening is allowed. Click to block agent file opening.';
            }
            updateStatusBarVisibility();
        }
        if (
            e.affectsConfiguration('switchboard.statusBar.showAgentOpenToggle') ||
            e.affectsConfiguration('switchboard.statusBar.showTerminalControls') ||
            e.affectsConfiguration('switchboard.statusBar.showKanbanButton') ||
            e.affectsConfiguration('switchboard.statusBar.showArtifactsButton') ||
            e.affectsConfiguration('switchboard.statusBar.showDesignButton')
        ) {
            updateStatusBarVisibility();
            void taskViewerProvider.postSetupPanelState();
        }
        if (e.affectsConfiguration('switchboard.stitch.apiKey')) {
            const apiKey = vscode.workspace.getConfiguration('switchboard').get<string>('stitch.apiKey') || process.env.STITCH_API_KEY;
            if (designPanelProvider.isOpen) {
                designPanelProvider.postMessage({ type: 'stitchApiKeyStatus', configured: !!apiKey });
            }
        }
    }));

    // Register refresh command
    const refreshDisposable = vscode.commands.registerCommand('switchboard.refresh', async () => {
        taskViewerProvider.refresh();
    });
    context.subscriptions.push(refreshDisposable);

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

            vscode.window.showInformationMessage('Switchboard housekeeping complete.');
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
        vscode.window.showInformationMessage('Switchboard working memory cleaned.');
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
    const ideSetupDisposable = vscode.commands.registerCommand('switchboard.setupIDEs', async () => {
        await showSetupWizard(context, taskViewerProvider);
    });
    context.subscriptions.push(ideSetupDisposable);

// ... (rest of the code remains the same)
    // Register focus terminal command
    // NOTE: vscode.window.terminals[n].processId returns the HOST shell PID (e.g., powershell.exe),
    // not necessarily the child workers running inside it.
    const focusTerminalDisposable = vscode.commands.registerCommand('switchboard.focusTerminal', async (pid: number) => {
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
    const focusTerminalByNameDisposable = vscode.commands.registerCommand('switchboard.focusTerminalByName', async (terminalName: string) => {
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
                vscode.window.showInformationMessage('No registered terminals to focus.');
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
    const openPlanDisposable = vscode.commands.registerCommand('switchboard.openPlan', async (uri: vscode.Uri | string) => {
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

    async function createAgentGrid(options?: { cwdOverride?: string }) {
        const currentWorkspaceRoot = kanbanProvider!.getCurrentWorkspaceRoot()
            ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!currentWorkspaceRoot) {
            vscode.window.showWarningMessage('No workspace folder found.');
            return;
        }
        const verifyWorkspace = () => kanbanProvider!.getCurrentWorkspaceRoot() === currentWorkspaceRoot;
        const effectiveWorkspaceRoot = kanbanProvider!.resolveEffectiveWorkspaceRoot(currentWorkspaceRoot);
        const gridTerminals = new Map<string, vscode.Terminal>();
        let effectiveCwd = effectiveWorkspaceRoot;
        if (options?.cwdOverride) {
            if (fs.existsSync(options.cwdOverride)) {
                effectiveCwd = options.cwdOverride;
            } else {
                vscode.window.showWarningMessage(`cwdOverride path does not exist: ${options.cwdOverride}. Using workspace root.`);
            }
        } else {
            // Check for remembered worktree path
            const kpAny = kanbanProvider as any;
            const db = kpAny && typeof kpAny._getKanbanDb === 'function' ? kpAny._getKanbanDb(currentWorkspaceRoot) : null;
            if (db) {
                try {
                    const ready = await db.ensureReady();
                    if (ready) {
                        const rememberEnabled = await db.getMeta('worktree_remember_enabled');
                        if (rememberEnabled === 'true') {
                            const rememberedPath = await db.getMeta('worktree_remembered_path');
                            if (rememberedPath && fs.existsSync(rememberedPath)) {
                                effectiveCwd = rememberedPath;
                            } else if (rememberedPath) {
                                // Stale path — clear and notify
                                await db.setMeta('worktree_remember_enabled', '');
                                await db.setMeta('worktree_remembered_path', '');
                                vscode.window.showInformationMessage('Remembered worktree path no longer exists. Using workspace root instead.');
                            }
                        }
                    }
                } catch { /* ignore DB errors */ }
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
            { name: 'Analyst', role: 'analyst' }
        ];
        const agents: { name: string; role: string }[] = [];
        for (const builtIn of allBuiltInAgents) {
            if (visibleAgents[builtIn.role] !== false) {
                agents.push(builtIn);
            }
        }
        for (const agent of customAgents) {
            if (visibleAgents[agent.role] === false) { continue; }
            agents.push({ name: agent.name, role: agent.role });
        }
        if (includeJulesMonitor) {
            agents.push({ name: 'Jules Monitor', role: 'jules_monitor' });
        }
        const normalizeGridTerminalName = (value: string | undefined): string => (value || '').trim();
        const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const matchesGridAgentName = (terminal: vscode.Terminal, agentName: string): boolean => {
            const creationName = (terminal.creationOptions as vscode.TerminalOptions | undefined)?.name;
            const terminalName = normalizeGridTerminalName(terminal.name);
            const createdName = normalizeGridTerminalName(creationName);
            // Matches primary agent names (exact, or with VS Code duplicate suffix like " (2)")
            // but excludes pool terminals which use bare number suffix like " 2"
            const primaryPattern = new RegExp(`^${escapeRegex(agentName)}(?: \\(\\d+\\))?$`);
            return primaryPattern.test(terminalName) || primaryPattern.test(createdName);
        };
        const clearGridBlockers = async () => {
            const agentNames = new Set(agents.map(a => a.name));
            if (!includeJulesMonitor) { agentNames.add('Jules Monitor'); }
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
                    worktreePath: effectiveCwd
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
                    vscode.window.showInformationMessage(`Agent terminals already open. Focused: ${firstAgent.name}`);
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
            vscode.window.showInformationMessage(`Agent Grid initialized: ${agents.map(a => a.name).join(', ')}`);
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            outputChannel?.appendLine(`[Extension] createAgentGrid failed: ${msg}`);
            vscode.window.showErrorMessage(`Failed to open agent terminals: ${msg}`);
        } finally {
            preSubscription.dispose();
            taskViewerProvider.sendLoadingState(false);
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
    const agentDir = vscode.Uri.file(path.join(workspaceRoot, '.agent'));
    const workflowsDir = vscode.Uri.file(path.join(workspaceRoot, '.agent', 'workflows'));
    const switchboardDir = vscode.Uri.file(path.join(workspaceRoot, '.switchboard'));

    try {
        // Core check: .agent/workflows must exist (contains workflow definitions)
        const workflowsExist = await vscode.workspace.fs.stat(workflowsDir).then(() => true, () => false);
        if (workflowsExist) return true;

        // Fallback: .agent dir + .switchboard runtime dir both exist
        const agentExists = await vscode.workspace.fs.stat(agentDir).then(() => true, () => false);
        const runtimeExists = await vscode.workspace.fs.stat(switchboardDir).then(() => true, () => false);
        return agentExists && runtimeExists;
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

function hasProtocolHeaderLine(content: string): boolean {
    const escapedHeader = AGENTS_PROTOCOL_HEADER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`^${escapedHeader}\\s*$`, 'm').test(content);
}

/**
 * Ensure the workspace AGENTS.md contains the Switchboard protocol block.
 * Preserves user content outside boundary markers when markers are present.
 * For legacy markerless files (header only, no markers), replaces the entire
 * file content — see markerless branch below.
 * Idempotent: skips if protocol block is already up-to-date.
 */
async function ensureAgentsProtocol(
    workspaceUri: vscode.Uri,
    extensionUri: vscode.Uri
): Promise<{ status: AgentsProtocolStatus; reason: string }> {
    const sourceUri = vscode.Uri.joinPath(extensionUri, 'AGENTS.md');
    const targetUri = vscode.Uri.joinPath(workspaceUri, 'AGENTS.md');

    // Read bundled source
    let sourceContent: string;
    try {
        const sourceBytes = await vscode.workspace.fs.readFile(sourceUri);
        sourceContent = Buffer.from(sourceBytes).toString('utf8');
    } catch (error) {
        return { status: 'failed', reason: `Bundled AGENTS.md source is missing or unreadable: ${getErrorMessage(error)}` };
    }

    // Build managed block with boundary markers
    const managedBlock = `${AGENTS_BLOCK_START}\n${sourceContent.trimEnd()}\n${AGENTS_BLOCK_END}`;
    const sourceForCreate = `${sourceContent.trimEnd()}\n`;

    // Check if target exists
    let targetContent: string | null = null;
    try {
        const targetBytes = await vscode.workspace.fs.readFile(targetUri);
        targetContent = Buffer.from(targetBytes).toString('utf8');
    } catch (error) {
        if (!isFileNotFoundError(error)) {
            return { status: 'failed', reason: `Failed to read existing AGENTS.md: ${getErrorMessage(error)}` };
        }
        // Target does not exist — will create.
    }

    if (targetContent === null) {
        // Create new file from bundled source.
        try {
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(sourceForCreate, 'utf8'));
            return { status: 'created', reason: 'AGENTS.md created from bundled source' };
        } catch (e) {
            return { status: 'failed', reason: `Failed to write AGENTS.md: ${getErrorMessage(e)}` };
        }
    }

    // Target exists — validate and check for existing protocol block.
    const hasBlockStart = targetContent.includes(AGENTS_BLOCK_START);
    const hasBlockEnd = targetContent.includes(AGENTS_BLOCK_END);
    const blockStartIndex = targetContent.indexOf(AGENTS_BLOCK_START);
    const blockEndIndex = targetContent.indexOf(AGENTS_BLOCK_END);

    if ((hasBlockStart && !hasBlockEnd) || (!hasBlockStart && hasBlockEnd) || (hasBlockStart && hasBlockEnd && blockStartIndex > blockEndIndex)) {
        return {
            status: 'failed',
            reason: 'Detected malformed managed protocol markers in AGENTS.md; fix markers before rerunning setup'
        };
    }

    if (hasBlockStart && hasBlockEnd) {
        // Extract existing block content
        const existingBlockContent = targetContent.substring(
            blockStartIndex + AGENTS_BLOCK_START.length,
            blockEndIndex
        ).trim();

        // Compare with bundled source (trimmed to avoid whitespace differences)
        if (existingBlockContent === sourceContent.trim()) {
            return { status: 'skipped', reason: 'Switchboard protocol block already up-to-date' };
        }

        // Content differs — perform in-place update
        try {
            const before = targetContent.substring(0, blockStartIndex);
            const after = targetContent.substring(blockEndIndex + AGENTS_BLOCK_END.length);
            const updated = before + managedBlock + after;
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(updated, 'utf8'));
            return { status: 'updated', reason: 'Switchboard protocol block updated to latest bundled version' };
        } catch (e) {
            return { status: 'failed', reason: `Failed to update AGENTS.md: ${getErrorMessage(e)}` };
        }
    }

    if (hasProtocolHeaderLine(targetContent)) {
        // Legacy markerless AGENTS.md — replace entire content with managed block.
        // The old file was fully scaffolded by the extension, so this is safe.
        try {
            await vscode.workspace.fs.writeFile(targetUri, Buffer.from(managedBlock + '\n', 'utf8'));
            return { status: 'updated', reason: 'Legacy markerless AGENTS.md replaced with managed block' };
        } catch (e) {
            return { status: 'failed', reason: `Failed to replace legacy AGENTS.md: ${getErrorMessage(e)}` };
        }
    }

    // Append protocol block, preserving existing content
    try {
        const separator = targetContent.endsWith('\n') ? '\n' : '\n\n';
        const merged = targetContent + separator + managedBlock + '\n';
        await vscode.workspace.fs.writeFile(targetUri, Buffer.from(merged, 'utf8'));
        return { status: 'appended', reason: 'Switchboard protocol block appended to existing AGENTS.md' };
    } catch (e) {
        return { status: 'failed', reason: `Failed to append to AGENTS.md: ${getErrorMessage(e)}` };
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
        '.agent/rules/no_git_for_agents.md',
        '.agent/rules/switchboard_modes.md',
        '.agent/workflows/handoff.md',
        '.agent/workflows/handoff-chat.md',
        '.agent/workflows/handoff-lead.md',
        '.agent/workflows/handoff-relay.md',
        '.agent/workflows/challenge.md',
        '.agent/workflows/chat.md', // Renamed to switchboard-chat.md
    ];
    for (const relativePath of legacyFiles) {
        const fullPath = path.join(workspaceRoot, relativePath);
        try {
            await fs.promises.access(fullPath);
            await fs.promises.unlink(fullPath);
            outputChannel?.appendLine(`[Switchboard] Removed legacy file: ${relativePath}`);
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
        '.agent',
        '.switchboard/plans',
        '.switchboard/archive'
    ];

    for (const dir of dirs) {
        await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(workspaceUri, dir));
    }

    // Migrate legacy plan subdirectories into unified .switchboard/plans/ root
    await migrateLegacyPlans(workspaceUri.fsPath);

    // 2. Discover and Copy .agent assets (Recursive & Depth-Limited)
    const agentSourceUri = vscode.Uri.joinPath(extensionUri, '.agent');
    const agentFiles = await crawlDirectory(agentSourceUri);

    // 2a. Version-gated workflow migration
    const needsWorkflowMigration = shouldRefreshAgentWorkspaceFiles(extensionUri.fsPath, workspaceUri.fsPath);

    for (const relativePath of agentFiles) {
        const srcUri = vscode.Uri.joinPath(agentSourceUri, relativePath);
        const destUri = vscode.Uri.joinPath(workspaceUri, '.agent', relativePath);

        // Ensure parent directory exists
        await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));

        const isWorkflowFile = relativePath.startsWith('workflows' + path.sep) && relativePath.endsWith('.md');

        if (isWorkflowFile && needsWorkflowMigration) {
            // Workflow files are canonical extension definitions — always overwrite on version change
            await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: true });
            continue;
        }

        // Existing behavior: skip if file already exists (preserves user customizations)
        try {
            await vscode.workspace.fs.stat(destUri);
        } catch {
            await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
        }
    }

    // Update agent version tracking after successful copy
    const currentVersion = getExtensionVersion(extensionUri.fsPath);
    if (currentVersion) {
        setLastCopiedAgentVersion(workspaceUri.fsPath, currentVersion);
    }

    // 2b. Blocklist: remove files that should never be distributed even if present in source
    const blocklist = [
        '.agent/rules/no_git_for_agents.md',
        '.agent/rules/switchboard_modes.md',
        '.agent/workflows/handoff.md',
        '.agent/workflows/handoff-chat.md',
        '.agent/workflows/handoff-lead.md',
        '.agent/workflows/handoff-relay.md',
        '.agent/workflows/challenge.md',
        '.agent/personas/switchboard_operator.md',
    ];
    for (const blockPath of blocklist) {
        const blockUri = vscode.Uri.joinPath(workspaceUri, blockPath);
        try {
            await vscode.workspace.fs.delete(blockUri, { useTrash: false });
        } catch { /* non-fatal */ }
    }

    // 2b. AGENTS.md scaffolding (non-destructive, failure-isolated)
    // Targets the same active workspace root used by setup flow; no multi-root fan-out.
    try {
        const agentsResult = await ensureAgentsProtocol(workspaceUri, extensionUri);
        outputChannel?.appendLine(`[Setup] AGENTS.md scaffolding: ${agentsResult.status} — ${agentsResult.reason}`);
    } catch (e) {
        outputChannel?.appendLine(`[Setup] AGENTS.md scaffolding error (non-fatal): ${e}`);
    }

    // 3. Create README Stub
    const readmeUri = vscode.Uri.joinPath(workspaceUri, '.switchboard', 'README.md');
    try {
        await vscode.workspace.fs.stat(readmeUri);
    } catch {
        const readmeContent = `# Switchboard\n\nThis folder contains workflow artifacts — review outputs, session logs, and audit reports.\n\nSee \`WORKFLOW_REFERENCE.md\` for full workflow documentation.\n\n### Quick Start\n- Terminal and messaging setup is handled automatically on extension activation.\n- Use the **Prompts tab** to inject delegation instructions for external agents.\n- Use \`/improve-plan\` for plan hardening plus adversarial review.`;
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

        // Run unified setup first (Project structure and .agent assets)
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

    // Cleanup other resources
    if (setupStatusBarItem) {
        setupStatusBarItem.dispose();
    }
    if (outputChannel) {
        outputChannel.dispose();
        outputChannel = null;
    }
}
