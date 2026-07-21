/**
 * GlobalPlanWatcherService — VS Code adapter over the host-agnostic
 * `PlanIngestionEngine` (Headless Ingestion piece 1).
 *
 * The engine holds all ingestion logic; this class is a thin shell that:
 *   - constructs the engine with a VS Code-backed `PlanIngestionHost` seam,
 *   - preserves the pre-extraction public API (`initialize`,
 *     `setFeatureColumnRecomputer`, `setFeatureFileRegenerator`,
 *     `registerPendingCreation`, `registerRename`, `refreshWatchers`,
 *     `triggerScan`, `runPurgeSweep`, `isGitOpActive`, `onPlanDiscovered`,
 *     `dispose`) so `extension.ts` is essentially untouched,
 *   - re-exposes the `onPlanDiscovered` vscode.Event<{uri, workspaceRoot}>
 *     shape the extension consumers (KanbanProvider, ContinuousSyncService,
 *     OversightPassService) already depend on.
 *
 * Behaviour is byte-stable with the pre-extraction watcher — the engine does
 * the work, the adapter only supplies vscode watchers/config/logger/roots and
 * bridges the discovered-plan event back into a vscode.Uri shape.
 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
    PlanIngestionEngine,
    expandHome,
    type PlanIngestionHost,
    type PlanIngestionHostConfig,
    type PlanIngestionWatcher,
    type PlanIngestionWatchHandle,
    type PlanIngestionWatchEvent,
    type PlanIngestionEnvironmentChange,
} from './PlanIngestionEngine';
import type { ClickUpSyncService } from './ClickUpSyncService';
import type { LinearSyncService } from './LinearSyncService';
import type { NotionFetchService } from './NotionFetchService';

export class GlobalPlanWatcherService implements vscode.Disposable {
    private _engine: PlanIngestionEngine;
    private _outputChannel?: vscode.OutputChannel;
    private _disposables: vscode.Disposable[] = [];

    private _onPlanDiscovered = new vscode.EventEmitter<{
        uri: vscode.Uri;
        workspaceRoot: string;
    }>();
    public readonly onPlanDiscovered = this._onPlanDiscovered.event;

    constructor(
        getClickUpService: (workspaceRoot: string) => ClickUpSyncService,
        getLinearService: (workspaceRoot: string) => LinearSyncService,
        getNotionService?: (workspaceRoot: string) => NotionFetchService,
        outputChannel?: vscode.OutputChannel
    ) {
        this._outputChannel = outputChannel;
        const host = createVsCodePlanIngestionHost(outputChannel);
        this._engine = new PlanIngestionEngine(getClickUpService, getLinearService, host, getNotionService);

        // Bridge the engine's discovered-plan callback into the vscode.Uri event shape
        // the extension consumers expect. filePath is present for file-level events
        // (create/change/delete); absent for folder-level rediscovery (periodic sweep,
        // activity-light timeout) — fall back to the workspace root uri, matching the
        // pre-extraction watcher's folder-level fire shape.
        const bridge = this._engine.onPlanDiscovered((workspaceRoot, filePath) => {
            const uri = vscode.Uri.file(filePath || workspaceRoot);
            this._onPlanDiscovered.fire({ uri, workspaceRoot });
        });
        this._disposables.push(bridge);
    }

    public static registerPendingCreation(absolutePath: string): void {
        PlanIngestionEngine.registerPendingCreation(absolutePath);
    }

    public registerRename(oldRelativePath: string): void {
        this._engine.registerRename(oldRelativePath);
    }

    public setFeatureColumnRecomputer(fn: (featurePlanId: string, workspaceRoot: string) => Promise<void>): void {
        this._engine.setFeatureColumnRecomputer(fn);
    }

    public setFeatureFileRegenerator(cb: (workspaceRoot: string, featureId: string) => Promise<void>): void {
        this._engine.setFeatureFileRegenerator(cb);
    }

    public async refreshWatchers(): Promise<void> {
        await this._engine.refreshWatchers();
    }

    public async initialize(): Promise<void> {
        await this._engine.initialize();
    }

    public async triggerScan(workspaceRoot: string): Promise<void> {
        await this._engine.triggerScan(workspaceRoot);
    }

    public async runPurgeSweep(): Promise<void> {
        await this._engine.runPurgeSweep();
    }

    public isGitOpActive(workspaceRoot: string): boolean {
        return this._engine.isGitOpActive(workspaceRoot);
    }

    /** Expose the engine for consumers that need to drive ingestion directly (e.g. headless verbs). */
    public getEngine(): PlanIngestionEngine {
        return this._engine;
    }

    public dispose(): void {
        this._engine.dispose();
        for (const d of this._disposables) {
            try { d.dispose(); } catch {}
        }
        this._disposables = [];
        this._onPlanDiscovered.dispose();
    }
}

// ─── VS Code host seam ──────────────────────────────────────────────────────

function createVsCodePlanIngestionHost(outputChannel?: vscode.OutputChannel): PlanIngestionHost {
    const logger = {
        appendLine: (line: string) => { outputChannel?.appendLine(line); },
    };

    const watcher: PlanIngestionWatcher = {
        watchFolder(folder, onEvent) {
            // VS Code FileSystemWatcher for workspace folders (handles .switchboard/{plans,features}/ and nested .md)
            const workspaceFolderPaths = new Set(
                (vscode.workspace.workspaceFolders || []).map(f => path.resolve(f.uri.fsPath))
            );
            const handles: vscode.Disposable[] = [];
            let nativeWatcher: fs.FSWatcher | undefined;

            if (workspaceFolderPaths.has(folder)) {
                const pattern = new vscode.RelativePattern(folder, '.switchboard/{plans,features}/**/*.md');
                const vw = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
                vw.onDidCreate((uri) => onEvent('create', uri.fsPath));
                vw.onDidChange((uri) => onEvent('change', uri.fsPath));
                vw.onDidDelete((uri) => onEvent('delete', uri.fsPath));
                handles.push(vw);
                outputChannel?.appendLine(`[GlobalPlanWatcher] VS Code watcher active for: ${folder}`);
            } else {
                outputChannel?.appendLine(`[GlobalPlanWatcher] Folder ${folder} is not a VS Code workspace folder, relying on native fs.watch`);
            }

            // Native fs.watch fallback (handles non-workspace folders and .gitignore issues)
            const switchboardDir = path.join(folder, '.switchboard');
            const watchPath = fs.existsSync(switchboardDir) ? switchboardDir : folder;
            try {
                nativeWatcher = fs.watch(watchPath, { recursive: true }, (eventType, filename) => {
                    if (!filename || !filename.endsWith('.md')) return;
                    const fullPath = path.resolve(path.join(watchPath, filename));
                    const plansDir = path.resolve(path.join(folder, '.switchboard', 'plans'));
                    const featuresDir = path.resolve(path.join(folder, '.switchboard', 'features'));
                    if (!fullPath.startsWith(plansDir) && !fullPath.startsWith(featuresDir)) return;

                    if (eventType === 'rename' || !fs.existsSync(fullPath)) {
                        if (!fs.existsSync(fullPath)) {
                            onEvent('delete', fullPath);
                            return;
                        }
                    }
                    onEvent('change', fullPath);
                });
                outputChannel?.appendLine(`[GlobalPlanWatcher] Native watch active for: ${watchPath}`);
            } catch (e) {
                outputChannel?.appendLine(`[GlobalPlanWatcher] Native watch failed for ${watchPath}: ${e}`);
            }

            return {
                dispose: () => {
                    for (const h of handles) { try { h.dispose(); } catch {} }
                    if (nativeWatcher) { try { nativeWatcher.close(); } catch {} }
                },
            };
        },
        watchFile(filePath, onEvent) {
            const folder = path.dirname(filePath);
            const fileName = path.basename(filePath);
            const relativePattern = new vscode.RelativePattern(folder, fileName);
            const vw = vscode.workspace.createFileSystemWatcher(relativePattern, false, false, false);
            vw.onDidChange((uri) => onEvent('change', uri.fsPath));
            vw.onDidCreate((uri) => onEvent('create', uri.fsPath));
            vw.onDidDelete((uri) => onEvent('delete', uri.fsPath));
            return { dispose: () => { try { vw.dispose(); } catch {} } };
        },
    };

    const makeConfig = (section: 'planWatcher' | 'activityLight'): PlanIngestionHostConfig => ({
        getBoolean: (key, defaultValue) => {
            try {
                const v = vscode.workspace.getConfiguration(`switchboard.${section}`).get<boolean>(key);
                return v !== undefined ? v : defaultValue;
            } catch { return defaultValue; }
        },
        getNumber: (key, defaultValue) => {
            try {
                const v = vscode.workspace.getConfiguration(`switchboard.${section}`).get<number>(key);
                return v !== undefined ? v : defaultValue;
            } catch { return defaultValue; }
        },
    });

    const host: PlanIngestionHost = {
        watcher,
        getConfig: makeConfig,
        logger,
        async listWatchedRoots() {
            return resolveWatchedRoots(outputChannel);
        },
        onEnvironmentChanged(handler) {
            const disposables: vscode.Disposable[] = [];
            disposables.push(vscode.workspace.onDidChangeConfiguration((e) => {
                if (
                    e.affectsConfiguration('switchboard.planWatcher.periodicScanEnabled') ||
                    e.affectsConfiguration('switchboard.planWatcher.scanIntervalMs') ||
                    e.affectsConfiguration('switchboard.activityLight.timeoutMs') ||
                    e.affectsConfiguration('switchboard.workspaceDatabaseMappings')
                ) {
                    handler('config');
                }
            }));
            disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
                handler('roots');
            }));
            return {
                dispose: () => { for (const d of disposables) { try { d.dispose(); } catch {} } },
            };
        },
    };
    return host;
}

/**
 * Resolve the watched-roots list: the workspace-database mappings (parent +
 * child folders) when enabled, falling back to the VS Code workspace folders.
 * Mirrors the pre-extraction `_getAllMappedFolders` byte-for-byte.
 */
function resolveWatchedRoots(outputChannel?: vscode.OutputChannel): Promise<string[]> {
    return (async () => {
        const folders: string[] = [];
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();
            outputChannel?.appendLine(
                `[GlobalPlanWatcher] Config: enabled=${cfg?.enabled}, mappings=${cfg?.mappings?.length ?? 0}`
            );
            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const mapping of cfg.mappings) {
                    if (mapping.parentFolder) {
                        const resolved = path.resolve(expandHome(mapping.parentFolder));
                        if (fs.existsSync(resolved) && !folders.includes(resolved)) {
                            folders.push(resolved);
                        }
                    }
                    if (Array.isArray(mapping.workspaceFolders)) {
                        for (const wf of mapping.workspaceFolders) {
                            const resolved = path.resolve(expandHome(wf));
                            if (fs.existsSync(resolved) && !folders.includes(resolved)) {
                                folders.push(resolved);
                            }
                        }
                    }
                }
            }
            if (folders.length === 0) {
                const workspaceFolders = vscode.workspace.workspaceFolders || [];
                for (const wf of workspaceFolders) {
                    const resolved = path.resolve(wf.uri.fsPath);
                    if (!folders.includes(resolved)) {
                        folders.push(resolved);
                    }
                }
            }
        } catch (err) {
            outputChannel?.appendLine(`[GlobalPlanWatcher] Error resolving mapped folders: ${err}`);
        }
        outputChannel?.appendLine(
            `[GlobalPlanWatcher] Mapped folders: [${folders.map(f => path.basename(f)).join(', ')}] (total: ${folders.length})`
        );
        return folders;
    })();
}

// Re-export the engine types for consumers that import from this module.
export {
    PlanIngestionEngine,
    type PlanIngestionHost,
    type PlanIngestionHostConfig,
    type PlanIngestionWatcher,
    type PlanIngestionWatchHandle,
    type PlanIngestionWatchEvent,
    type PlanIngestionEnvironmentChange,
};
