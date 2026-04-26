import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { importPlanFiles } from './PlanFileImporter';
import { KanbanDatabase } from './KanbanDatabase';
import { ensureWorkspaceIdentity } from './WorkspaceIdentityService';

export type DiscoveredRepo = {
    repoName: string;
    repoDir: string;
    hasGit: boolean;
    hasSwitchboard: boolean;
    dbPath: string;
    plansDir: string;
    agentDir: string;
    agentsFilePath: string;
    planCount: number;
    localPlanFileCount: number;
};

export type ControlPlaneCandidateResult = {
    workspaceRoot: string;
    suggestedParentDir: string | null;
    parentIsGitRepo: boolean;
    alreadyControlPlane: boolean;
    discoveredRepos: DiscoveredRepo[];
    warnings: string[];
};

export type MigrationPreviewSource = DiscoveredRepo & {
    dbWillMerge: boolean;
    plansWillCopy: number;
    agentConflictSummary: string;
    cleanupEligible: boolean;
};

export type MigrationPreview = {
    parentDir: string;
    sources: MigrationPreviewSource[];
    totalPlanCount: number;
    basenameCollisions: Array<{ fileName: string; repos: string[] }>;
    agentConflicts: Array<{ relativePath: string; repos: string[]; identical: boolean }>;
    rulesConflicts: Array<{ fileName: string; repos: string[] }>;
    warnings: string[];
};

export type MigrationResult = {
    success: boolean;
    workspaceFilePath?: string;
    reportPath?: string;
    migratedRepos: Array<{ repoName: string; mergedPlanRows: number; copiedPlanFiles: number; cleanupAction: string }>;
    warnings: string[];
    error?: string;
};

export type MigrationOptions = {
    currentWorkspaceRoot?: string;
    extensionPath?: string;
    generateWorkspaceFile?: boolean;
    cleanupConfirmed?: string[];
};

export type FreshSetupOptions = {
    currentWorkspaceRoot?: string;
    extensionPath?: string;
    generateWorkspaceFile?: boolean;
};

type AgentConflict = { relativePath: string; repos: string[]; identical: boolean };
type RuleConflict = { fileName: string; repos: string[] };
type SharedFileEntry = {
    repoName: string;
    absolutePath: string;
    relativePath: string;
    hash: string;
};

type SharedAgentMergeSummary = {
    agentConflicts: AgentConflict[];
    rulesConflicts: RuleConflict[];
    warnings: string[];
};

const BUNDLED_AGENT_DIR = '.agent';
const BUNDLED_AGENTS_FILE = 'AGENTS.md';
const MAX_AGENT_SCAN_DEPTH = 5;

export class ControlPlaneMigrationService {
    private static readonly SWITCHBOARD_RESERVED_DIRS = new Set([
        'planning-cache',
    ]);
    public static async detectCandidateParent(workspaceRoot: string): Promise<ControlPlaneCandidateResult> {
        const resolvedWorkspaceRoot = path.resolve(workspaceRoot || '');
        if (!resolvedWorkspaceRoot) {
            return {
                workspaceRoot: '',
                suggestedParentDir: null,
                parentIsGitRepo: false,
                alreadyControlPlane: false,
                discoveredRepos: [],
                warnings: ['Open a workspace folder before setting up a Control Plane.']
            };
        }

        const suggestedParentDir = path.dirname(resolvedWorkspaceRoot);
        return this._scanParentDirectory(resolvedWorkspaceRoot, suggestedParentDir);
    }

    public static async previewMigration(parentDir: string): Promise<MigrationPreview> {
        const normalizedParent = path.resolve(parentDir || '');
        const scan = await this._scanParentDirectory('', normalizedParent);
        const warnings = [...scan.warnings];

        if (!scan.suggestedParentDir) {
            return {
                parentDir: normalizedParent,
                sources: [],
                totalPlanCount: 0,
                basenameCollisions: [],
                agentConflicts: [],
                rulesConflicts: [],
                warnings
            };
        }

        const sources = scan.discoveredRepos.filter((repo) =>
            repo.hasGit || repo.hasSwitchboard || repo.localPlanFileCount > 0
        );
        const sharedAgentSummary = await this._analyzeSharedAgentContent(sources);
        const basenameCollisions = await this._findPlanBasenameCollisions(sources);
        const agentConflictCountByRepo = new Map<string, number>();

        for (const conflict of sharedAgentSummary.agentConflicts) {
            for (const repoName of conflict.repos) {
                agentConflictCountByRepo.set(repoName, (agentConflictCountByRepo.get(repoName) || 0) + 1);
            }
        }
        for (const conflict of sharedAgentSummary.rulesConflicts) {
            for (const repoName of conflict.repos) {
                agentConflictCountByRepo.set(repoName, (agentConflictCountByRepo.get(repoName) || 0) + 1);
            }
        }

        const previewSources: MigrationPreviewSource[] = sources.map((repo) => {
            const conflictCount = agentConflictCountByRepo.get(repo.repoName) || 0;
            let agentConflictSummary = 'No shared agent conflicts detected';
            if (conflictCount > 0) {
                agentConflictSummary = `${conflictCount} shared agent conflict${conflictCount === 1 ? '' : 's'}`;
            } else if (fs.existsSync(repo.agentDir) || fs.existsSync(repo.agentsFilePath)) {
                agentConflictSummary = 'Shared agent content can be copied cleanly';
            }

            return {
                ...repo,
                dbWillMerge: fs.existsSync(repo.dbPath),
                plansWillCopy: repo.localPlanFileCount,
                agentConflictSummary,
                cleanupEligible: fs.existsSync(path.join(repo.repoDir, '.switchboard'))
            };
        });

        return {
            parentDir: scan.suggestedParentDir,
            sources: previewSources,
            totalPlanCount: previewSources.reduce((sum, repo) => sum + repo.planCount, 0),
            basenameCollisions,
            agentConflicts: sharedAgentSummary.agentConflicts,
            rulesConflicts: sharedAgentSummary.rulesConflicts,
            warnings: [...warnings, ...sharedAgentSummary.warnings]
        };
    }

    public static async executeMigration(parentDir: string, options: MigrationOptions = {}): Promise<MigrationResult> {
        try {
            const preview = await this.previewMigration(parentDir);
            if (!this._isSafeParentDir(preview.parentDir)) {
                return {
                    success: false,
                    migratedRepos: [],
                    warnings: preview.warnings,
                    error: 'Choose a parent folder that is not your home directory or the filesystem root.'
                };
            }

            if (preview.sources.length === 0) {
                return {
                    success: false,
                    migratedRepos: [],
                    warnings: preview.warnings,
                    error: 'No child repositories were found to migrate from the selected parent folder.'
                };
            }

            await this.bootstrapControlPlaneLayout(preview.parentDir, options.extensionPath);

            const targetDb = KanbanDatabase.forWorkspace(preview.parentDir);
            const ready = await targetDb.ensureReady();
            if (!ready) {
                return {
                    success: false,
                    migratedRepos: [],
                    warnings: preview.warnings,
                    error: `Failed to initialize control-plane database at ${targetDb.dbPath}.`
                };
            }

            await ensureWorkspaceIdentity(preview.parentDir);

            const migratedRepos: MigrationResult['migratedRepos'] = [];
            for (const source of preview.sources) {
                let mergedPlanRows = 0;
                if (fs.existsSync(source.dbPath)) {
                    try {
                        mergedPlanRows = await KanbanDatabase.reconcileDatabases(source.dbPath, targetDb.dbPath);
                    } catch (error) {
                        preview.warnings.push(
                            `Failed to merge ${source.repoName} database: ${error instanceof Error ? error.message : String(error)}`
                        );
                    }
                }

                let copiedPlanFiles = 0;
                try {
                    copiedPlanFiles = await this._copyRepoPlanFiles(preview.parentDir, source);
                } catch (error) {
                    preview.warnings.push(
                        `Failed to copy plan files for ${source.repoName}: ${error instanceof Error ? error.message : String(error)}`
                    );
                }

                let cleanupAction = 'left in place';
                const cleanupConfirmed = new Set((options.cleanupConfirmed || []).map((value) => String(value)));
                if (cleanupConfirmed.has(source.repoName)) {
                    cleanupAction = await this._archiveSourceSwitchboard(source.repoDir);
                }

                migratedRepos.push({
                    repoName: source.repoName,
                    mergedPlanRows,
                    copiedPlanFiles,
                    cleanupAction
                });
            }

            await KanbanDatabase.invalidateWorkspace(preview.parentDir);
            const reopenedDb = KanbanDatabase.forWorkspace(preview.parentDir);
            const reopenedReady = await reopenedDb.ensureReady();
            if (!reopenedReady) {
                return {
                    success: false,
                    migratedRepos,
                    warnings: preview.warnings,
                    error: `Failed to reopen control-plane database at ${targetDb.dbPath} after migration.`
                };
            }

            await ensureWorkspaceIdentity(preview.parentDir);
            await this._mergeSharedAgentContent(preview.parentDir, preview.sources, options.extensionPath);
            const importResult = await importPlanFiles(preview.parentDir);

            // Trigger integration sync for imported plans via command
            // (ControlPlaneMigrationService is static and has no KanbanProvider reference)
            if (importResult.sessionIds.length > 0) {
                await vscode.commands.executeCommand('switchboard.syncImportedPlans', preview.parentDir, importResult);
            }

            const workspaceFilePath = options.generateWorkspaceFile === false
                ? undefined
                : await this._writeWorkspaceFile(preview.parentDir, preview.sources, options.currentWorkspaceRoot);
            const reportPath = await this.writeMigrationReport(preview.parentDir, preview, {
                success: true,
                migratedRepos,
                warnings: preview.warnings
            });

            if (workspaceFilePath) {
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.file(workspaceFilePath),
                    { forceNewWindow: false }
                );
            }

            return {
                success: true,
                workspaceFilePath,
                reportPath,
                migratedRepos,
                warnings: preview.warnings
            };
        } catch (error) {
            return {
                success: false,
                migratedRepos: [],
                warnings: [],
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public static async executeFreshSetup(parentDir: string, options: FreshSetupOptions = {}): Promise<MigrationResult> {
        try {
            const normalizedParent = path.resolve(parentDir || '');
            const warnings: string[] = [];
            if (!this._isSafeParentDir(normalizedParent)) {
                return {
                    success: false,
                    migratedRepos: [],
                    warnings,
                    error: 'Choose a parent folder that is not your home directory or the filesystem root.'
                };
            }

            await this.bootstrapControlPlaneLayout(normalizedParent, options.extensionPath);

            const targetDb = KanbanDatabase.forWorkspace(normalizedParent);
            const ready = await targetDb.ensureReady();
            if (!ready) {
                return {
                    success: false,
                    migratedRepos: [],
                    warnings,
                    error: `Failed to initialize control-plane database at ${targetDb.dbPath}.`
                };
            }

            await ensureWorkspaceIdentity(normalizedParent);

            const currentWorkspaceRoot = path.resolve(
                options.currentWorkspaceRoot
                || vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
                || ''
            );
            const migratedRepos: MigrationResult['migratedRepos'] = [];

            if (currentWorkspaceRoot && currentWorkspaceRoot !== normalizedParent && path.dirname(currentWorkspaceRoot) === normalizedParent) {
                const currentRepo = await this._describeRepo(currentWorkspaceRoot);
                await this._mergeSharedAgentContent(normalizedParent, [currentRepo], options.extensionPath);
                migratedRepos.push({
                    repoName: currentRepo.repoName,
                    mergedPlanRows: 0,
                    copiedPlanFiles: 0,
                    cleanupAction: 'not requested'
                });
            }

            const workspaceFilePath = options.generateWorkspaceFile === false
                ? undefined
                : await this._writeWorkspaceFile(
                    normalizedParent,
                    (await this.previewMigration(normalizedParent)).sources,
                    currentWorkspaceRoot
                );
            const reportPath = await this.writeMigrationReport(
                normalizedParent,
                await this.previewMigration(normalizedParent),
                {
                    success: true,
                    migratedRepos,
                    warnings
                }
            );

            if (workspaceFilePath) {
                await vscode.commands.executeCommand(
                    'vscode.openFolder',
                    vscode.Uri.file(workspaceFilePath),
                    { forceNewWindow: false }
                );
            }

            return {
                success: true,
                workspaceFilePath,
                reportPath,
                migratedRepos,
                warnings
            };
        } catch (error) {
            return {
                success: false,
                migratedRepos: [],
                warnings: [],
                error: error instanceof Error ? error.message : String(error)
            };
        }
    }

    public static injectRepoScope(content: string, repoName: string): string {
        const lines = content.replace(/\r\n/g, '\n').split('\n');
        const repoLine = `**Repo:** ${path.basename(repoName).trim()}`;
        const metadataIndex = lines.findIndex((line) => /^## Metadata\s*$/i.test(line.trim()));

        if (metadataIndex >= 0) {
            const nextSectionIndex = this._findNextSectionIndex(lines, metadataIndex + 1);
            const blockEnd = nextSectionIndex === -1 ? lines.length : nextSectionIndex;
            const repoIndex = lines.findIndex((line, index) =>
                index > metadataIndex
                && index < blockEnd
                && /^\*\*Repo:\*\*/i.test(line.trim())
            );

            if (repoIndex >= 0) {
                lines[repoIndex] = repoLine;
                return lines.join('\n');
            }

            const preferredInsertIndex = this._findMetadataInsertIndex(lines, metadataIndex, blockEnd);
            lines.splice(preferredInsertIndex, 0, repoLine);
            return lines.join('\n');
        }

        const goalIndex = lines.findIndex((line) => /^## Goal\s*$/i.test(line.trim()));
        if (goalIndex >= 0) {
            const nextSectionIndex = this._findNextSectionIndex(lines, goalIndex + 1);
            const insertionIndex = nextSectionIndex === -1 ? lines.length : nextSectionIndex;
            const metadataBlock = ['## Metadata', '', repoLine, ''];
            lines.splice(insertionIndex, 0, ...metadataBlock);
            return lines.join('\n');
        }

        const fallbackBlock = ['## Metadata', '', repoLine, ''];
        return [content.trimEnd(), '', ...fallbackBlock].join('\n');
    }

    public static async writeMigrationReport(
        parentDir: string,
        preview: MigrationPreview,
        result: Pick<MigrationResult, 'success' | 'migratedRepos' | 'warnings' | 'error'>
    ): Promise<string> {
        const reportPath = path.join(parentDir, '.switchboard', 'MIGRATION_REPORT.md');
        const lines: string[] = [
            '# Control Plane Migration Report',
            '',
            `**Parent Directory:** ${parentDir}`,
            `**Result:** ${result.success ? 'Success' : 'Failed'}`,
        ];

        if (result.error) {
            lines.push(`**Error:** ${result.error}`);
        }

        lines.push('', '## Repositories', '');
        if (result.migratedRepos.length === 0) {
            lines.push('- No repositories were migrated.');
        } else {
            for (const repo of result.migratedRepos) {
                lines.push(
                    `- **${repo.repoName}:** merged ${repo.mergedPlanRows} DB row(s), copied ${repo.copiedPlanFiles} plan file(s), cleanup ${repo.cleanupAction}`
                );
            }
        }

        lines.push('', '## Agent Conflicts', '');
        if (preview.agentConflicts.length === 0) {
            lines.push('- No shared agent conflicts detected.');
        } else {
            for (const conflict of preview.agentConflicts) {
                lines.push(
                    `- \`${conflict.relativePath}\` — repos: ${conflict.repos.join(', ')} (${conflict.identical ? 'identical' : 'divergent'})`
                );
            }
        }

        lines.push('', '## Rules Conflicts', '');
        if (preview.rulesConflicts.length === 0) {
            lines.push('- No divergent rules were detected.');
        } else {
            for (const conflict of preview.rulesConflicts) {
                lines.push(`- \`${conflict.fileName}\` — repos: ${conflict.repos.join(', ')}`);
            }
        }

        const warnings = [...preview.warnings, ...(result.warnings || [])];
        lines.push('', '## Warnings', '');
        if (warnings.length === 0) {
            lines.push('- No additional warnings.');
        } else {
            for (const warning of warnings) {
                lines.push(`- ${warning}`);
            }
        }

        await fs.promises.mkdir(path.dirname(reportPath), { recursive: true });
        await fs.promises.writeFile(reportPath, `${lines.join('\n').trimEnd()}\n`, 'utf8');
        return reportPath;
    }

    public static async generateCodeWorkspace(parentDir: string, repoDirs: string[], workspaceName?: string): Promise<string> {
        const normalizedParent = path.resolve(parentDir);
        const uniqueRepoDirs = Array.from(
            new Map(
                repoDirs
                    .map((repoDir) => path.resolve(repoDir))
                    .filter((repoDir) => path.dirname(repoDir) === normalizedParent)
                    .map((repoDir) => [path.basename(repoDir), repoDir] as const)
            ).values()
        );

        const filesExclude = Object.fromEntries(
            uniqueRepoDirs.map((repoDir) => [`${path.basename(repoDir)}/**`, true])
        );
        const workspaceJson = {
            folders: [
                { path: '.', name: '⚙️ Control Plane' },
                ...uniqueRepoDirs.map((repoDir) => ({ path: path.basename(repoDir) }))
            ],
            settings: {
                'files.exclude': filesExclude
            }
        };

        const baseName = (workspaceName || path.basename(normalizedParent) || 'control-plane').replace(/\.code-workspace$/i, '');
        const workspaceFilePath = path.join(normalizedParent, `${baseName}.code-workspace`);
        await fs.promises.writeFile(workspaceFilePath, `${JSON.stringify(workspaceJson, null, 2)}\n`, 'utf8');
        return workspaceFilePath;
    }

    public static async bootstrapControlPlaneLayout(parentDir: string, extensionPath?: string): Promise<void> {
        await this._bootstrapControlPlaneLayout(parentDir, extensionPath);
    }

    public static async listLocalPlanFiles(plansDir: string): Promise<string[]> {
        if (!fs.existsSync(plansDir)) {
            return [];
        }

        const entries = await fs.promises.readdir(plansDir, { withFileTypes: true });
        return entries
            .filter((entry) => entry.isFile())
            .map((entry) => entry.name)
            .filter((fileName) => /\.md$/i.test(fileName))
            .filter((fileName) => !/^brain_[0-9a-f]{64}\.md$/i.test(fileName))
            .filter((fileName) => !/^ingested_[0-9a-f]{64}\.md$/i.test(fileName))
            .sort((left, right) => left.localeCompare(right))
            .map((fileName) => path.join(plansDir, fileName));
    }

    private static async _scanParentDirectory(workspaceRoot: string, parentDir: string): Promise<ControlPlaneCandidateResult> {
        const normalizedParent = path.resolve(parentDir || '');
        const warnings: string[] = [];

        if (!normalizedParent || !this._isSafeParentDir(normalizedParent)) {
            warnings.push('Choose a parent folder that is not your home directory or the filesystem root.');
            return {
                workspaceRoot,
                suggestedParentDir: null,
                parentIsGitRepo: false,
                alreadyControlPlane: false,
                discoveredRepos: [],
                warnings
            };
        }

        const parentIsGitRepo = fs.existsSync(path.join(normalizedParent, '.git'));
        const alreadyControlPlane = fs.existsSync(path.join(normalizedParent, '.switchboard', 'kanban.db'));
        const discoveredRepos = await this._discoverRepos(normalizedParent);
        const gitRepoCount = discoveredRepos.filter((repo) => repo.hasGit).length;

        if (gitRepoCount < 2) {
            warnings.push('The detected parent folder does not contain at least two immediate child git repositories yet.');
        }
        if (parentIsGitRepo) {
            warnings.push('Your parent folder is a git repository. You may still need .gitignore entries for .switchboard/ here.');
        }
        if (alreadyControlPlane) {
            warnings.push('This parent folder already has a control-plane kanban database.');
        }

        return {
            workspaceRoot,
            suggestedParentDir: normalizedParent,
            parentIsGitRepo,
            alreadyControlPlane,
            discoveredRepos,
            warnings
        };
    }

    private static async _discoverRepos(parentDir: string): Promise<DiscoveredRepo[]> {
        let entries: fs.Dirent[] = [];
        try {
            entries = await fs.promises.readdir(parentDir, { withFileTypes: true });
        } catch {
            return [];
        }

        const repos: DiscoveredRepo[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (entry.name.startsWith('.')) continue;
            if (ControlPlaneMigrationService.SWITCHBOARD_RESERVED_DIRS.has(entry.name)) continue;
            const repoDir = path.join(parentDir, entry.name);
            const repo = await this._describeRepo(repoDir);
            if (repo.hasGit || repo.hasSwitchboard || repo.localPlanFileCount > 0) {
                repos.push(repo);
            }
        }

        return repos.sort((left, right) => left.repoName.localeCompare(right.repoName));
    }

    private static async _describeRepo(repoDir: string): Promise<DiscoveredRepo> {
        const repoName = path.basename(repoDir);
        const switchboardDir = path.join(repoDir, '.switchboard');
        const dbPath = path.join(switchboardDir, 'kanban.db');
        const plansDir = path.join(switchboardDir, 'plans');
        const agentDir = path.join(repoDir, '.agent');
        const agentsFilePath = path.join(repoDir, 'AGENTS.md');
        const localPlanFiles = await this.listLocalPlanFiles(plansDir);

        let planCount = localPlanFiles.length;
        if (fs.existsSync(dbPath)) {
            const dbPlanCount = await KanbanDatabase.countPlansInFile(dbPath);
            if (dbPlanCount > 0) {
                planCount = dbPlanCount;
            }
        }

        return {
            repoName,
            repoDir,
            hasGit: fs.existsSync(path.join(repoDir, '.git')),
            hasSwitchboard: fs.existsSync(switchboardDir) || fs.existsSync(agentDir) || fs.existsSync(agentsFilePath),
            dbPath,
            plansDir,
            agentDir,
            agentsFilePath,
            planCount,
            localPlanFileCount: localPlanFiles.length
        };
    }

    private static async _findPlanBasenameCollisions(repos: DiscoveredRepo[]): Promise<Array<{ fileName: string; repos: string[] }>> {
        const fileToRepos = new Map<string, Set<string>>();
        for (const repo of repos) {
            const planFiles = await this.listLocalPlanFiles(repo.plansDir);
            for (const planFile of planFiles) {
                const fileName = path.basename(planFile);
                if (!fileToRepos.has(fileName)) {
                    fileToRepos.set(fileName, new Set());
                }
                fileToRepos.get(fileName)?.add(repo.repoName);
            }
        }

        return [...fileToRepos.entries()]
            .filter(([, repoNames]) => repoNames.size > 1)
            .map(([fileName, repoNames]) => ({ fileName, repos: [...repoNames].sort() }))
            .sort((left, right) => left.fileName.localeCompare(right.fileName));
    }

    private static async _bootstrapControlPlaneLayout(parentDir: string, extensionPath?: string): Promise<void> {
        await Promise.all([
            fs.promises.mkdir(path.join(parentDir, '.agent'), { recursive: true }),
            fs.promises.mkdir(path.join(parentDir, '.switchboard', 'plans'), { recursive: true }),
            fs.promises.mkdir(path.join(parentDir, '.switchboard', 'inbox'), { recursive: true }),
            fs.promises.mkdir(path.join(parentDir, '.switchboard', 'handoff'), { recursive: true }),
            fs.promises.mkdir(path.join(parentDir, '.switchboard', 'archive'), { recursive: true }),
        ]);

        if (!extensionPath) {
            return;
        }

        const bundledAgentDir = path.join(extensionPath, BUNDLED_AGENT_DIR);
        if (fs.existsSync(bundledAgentDir)) {
            await this._copyDirectoryRecursive(bundledAgentDir, path.join(parentDir, '.agent'), { overwrite: false });
        }

        const bundledAgentsFile = path.join(extensionPath, BUNDLED_AGENTS_FILE);
        if (fs.existsSync(bundledAgentsFile)) {
            const targetAgentsFile = path.join(parentDir, 'AGENTS.md');
            if (!fs.existsSync(targetAgentsFile)) {
                await fs.promises.copyFile(bundledAgentsFile, targetAgentsFile);
            }
        }

        const bundledMcpDir = this._resolveBundledMcpDirectory(extensionPath);
        if (bundledMcpDir) {
            await this._copyDirectoryRecursive(
                bundledMcpDir,
                path.join(parentDir, '.switchboard', 'MCP'),
                { overwrite: false }
            );
        }
    }

    private static _resolveBundledMcpDirectory(extensionPath: string): string | null {
        const candidates = [
            path.join(extensionPath, 'dist', 'mcp-server'),
            path.join(extensionPath, 'src', 'mcp-server')
        ];
        return candidates.find((candidate) => fs.existsSync(path.join(candidate, 'mcp-server.js'))) || null;
    }

    private static async _copyRepoPlanFiles(parentDir: string, repo: DiscoveredRepo): Promise<number> {
        const planFiles = await this.listLocalPlanFiles(repo.plansDir);
        if (planFiles.length === 0) {
            return 0;
        }

        const targetDir = path.join(parentDir, '.switchboard', 'plans', repo.repoName);
        await fs.promises.mkdir(targetDir, { recursive: true });

        for (const planFile of planFiles) {
            const destPath = path.join(targetDir, path.basename(planFile));
            const content = await fs.promises.readFile(planFile, 'utf8');
            await fs.promises.writeFile(destPath, this.injectRepoScope(content, repo.repoName), 'utf8');
        }

        return planFiles.length;
    }

    private static async _archiveSourceSwitchboard(repoDir: string): Promise<string> {
        const switchboardDir = path.join(repoDir, '.switchboard');
        if (!fs.existsSync(switchboardDir)) {
            return 'source .switchboard not found';
        }

        const backupDir = await this._nextAvailableBackupPath(repoDir);
        try {
            await fs.promises.rename(switchboardDir, backupDir);
            return `renamed to ${path.basename(backupDir)}`;
        } catch (error) {
            return `failed (${error instanceof Error ? error.message : String(error)})`;
        }
    }

    private static async _nextAvailableBackupPath(repoDir: string): Promise<string> {
        let suffix = 0;
        while (true) {
            const candidate = path.join(
                repoDir,
                `.switchboard.migrated${suffix === 0 ? '' : `.${suffix}`}.bak`
            );
            if (!fs.existsSync(candidate)) {
                return candidate;
            }
            suffix += 1;
        }
    }

    private static async _mergeSharedAgentContent(
        parentDir: string,
        repos: Array<DiscoveredRepo | MigrationPreviewSource>,
        extensionPath?: string
    ): Promise<SharedAgentMergeSummary> {
        if (extensionPath) {
            await this._bootstrapControlPlaneLayout(parentDir, extensionPath);
        }

        const summary = await this._analyzeSharedAgentContent(repos);
        const sharedEntries = await this._collectSharedAgentEntries(repos, ['personas', 'workflows', 'skills']);

        for (const [relativePath, entries] of sharedEntries.entries()) {
            const uniqueHashes = new Set(entries.map((entry) => entry.hash));
            if (uniqueHashes.size > 1) {
                continue;
            }
            await this._copySharedFile(entries[0].absolutePath, path.join(parentDir, '.agent', relativePath));
        }

        const agentsEntries = await this._collectAgentsFileEntries(repos);
        if (agentsEntries.length > 0) {
            const uniqueHashes = new Set(agentsEntries.map((entry) => entry.hash));
            if (uniqueHashes.size === 1) {
                await this._copySharedFile(agentsEntries[0].absolutePath, path.join(parentDir, 'AGENTS.md'));
            }
        }

        const rulesEntries = await this._collectRulesEntries(repos);
        const contributingRuleRepos = new Set(rulesEntries.map((entry) => entry.repoName));
        const rulesGroups = this._groupEntriesByRelativePath(rulesEntries);
        for (const [relativePath, entries] of rulesGroups.entries()) {
            const uniqueHashes = new Set(entries.map((entry) => entry.hash));
            const repoNames = new Set(entries.map((entry) => entry.repoName));
            if (uniqueHashes.size === 1 && repoNames.size === contributingRuleRepos.size && contributingRuleRepos.size > 0) {
                await this._copySharedFile(entries[0].absolutePath, path.join(parentDir, '.agent', 'rules', relativePath));
            }
        }

        return summary;
    }

    private static async _analyzeSharedAgentContent(repos: Array<DiscoveredRepo | MigrationPreviewSource>): Promise<SharedAgentMergeSummary> {
        const warnings: string[] = [];
        const sharedEntries = await this._collectSharedAgentEntries(repos, ['personas', 'workflows', 'skills']);
        const agentConflicts: AgentConflict[] = [];
        for (const [relativePath, entries] of sharedEntries.entries()) {
            if (entries.length < 2) continue;
            agentConflicts.push({
                relativePath,
                repos: [...new Set(entries.map((entry) => entry.repoName))].sort(),
                identical: new Set(entries.map((entry) => entry.hash)).size === 1
            });
        }

        const agentsEntries = await this._collectAgentsFileEntries(repos);
        if (agentsEntries.length > 1) {
            agentConflicts.push({
                relativePath: 'AGENTS.md',
                repos: [...new Set(agentsEntries.map((entry) => entry.repoName))].sort(),
                identical: new Set(agentsEntries.map((entry) => entry.hash)).size === 1
            });
        }

        const rulesEntries = await this._collectRulesEntries(repos);
        const contributingRuleRepos = new Set(rulesEntries.map((entry) => entry.repoName));
        const rulesConflicts: RuleConflict[] = [];
        for (const [relativePath, entries] of this._groupEntriesByRelativePath(rulesEntries).entries()) {
            const uniqueHashes = new Set(entries.map((entry) => entry.hash));
            const repoNames = [...new Set(entries.map((entry) => entry.repoName))].sort();
            if (uniqueHashes.size > 1 || repoNames.length !== contributingRuleRepos.size) {
                rulesConflicts.push({
                    fileName: relativePath,
                    repos: repoNames
                });
            }
        }

        if (rulesConflicts.length > 0) {
            warnings.push('Divergent .agent/rules files were left in their source repositories and recorded in MIGRATION_REPORT.md.');
        }

        return { agentConflicts, rulesConflicts, warnings };
    }

    private static async _collectSharedAgentEntries(
        repos: Array<DiscoveredRepo | MigrationPreviewSource>,
        categories: Array<'personas' | 'workflows' | 'skills'>
    ): Promise<Map<string, SharedFileEntry[]>> {
        const grouped = new Map<string, SharedFileEntry[]>();
        for (const repo of repos) {
            for (const category of categories) {
                const rootDir = path.join(repo.agentDir, category);
                if (!fs.existsSync(rootDir)) continue;
                const files = await this._listFilesRecursive(rootDir);
                for (const filePath of files) {
                    const relativePath = path.join(category, path.relative(rootDir, filePath)).replace(/\\/g, '/');
                    const entry = {
                        repoName: repo.repoName,
                        absolutePath: filePath,
                        relativePath,
                        hash: await this.hashFile(filePath)
                    };
                    const bucket = grouped.get(relativePath) || [];
                    bucket.push(entry);
                    grouped.set(relativePath, bucket);
                }
            }
        }
        return grouped;
    }

    private static async _collectAgentsFileEntries(repos: Array<DiscoveredRepo | MigrationPreviewSource>): Promise<SharedFileEntry[]> {
        const entries: SharedFileEntry[] = [];
        for (const repo of repos) {
            if (!fs.existsSync(repo.agentsFilePath)) continue;
            entries.push({
                repoName: repo.repoName,
                absolutePath: repo.agentsFilePath,
                relativePath: 'AGENTS.md',
                hash: await this.hashFile(repo.agentsFilePath)
            });
        }
        return entries;
    }

    private static async _collectRulesEntries(repos: Array<DiscoveredRepo | MigrationPreviewSource>): Promise<SharedFileEntry[]> {
        const entries: SharedFileEntry[] = [];
        for (const repo of repos) {
            const rootDir = path.join(repo.agentDir, 'rules');
            if (!fs.existsSync(rootDir)) continue;
            const files = await this._listFilesRecursive(rootDir);
            for (const filePath of files) {
                entries.push({
                    repoName: repo.repoName,
                    absolutePath: filePath,
                    relativePath: path.relative(rootDir, filePath).replace(/\\/g, '/'),
                    hash: await this.hashFile(filePath)
                });
            }
        }
        return entries;
    }

    private static _groupEntriesByRelativePath(entries: SharedFileEntry[]): Map<string, SharedFileEntry[]> {
        const grouped = new Map<string, SharedFileEntry[]>();
        for (const entry of entries) {
            const bucket = grouped.get(entry.relativePath) || [];
            bucket.push(entry);
            grouped.set(entry.relativePath, bucket);
        }
        return grouped;
    }

    private static async _copySharedFile(sourcePath: string, targetPath: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
        await fs.promises.copyFile(sourcePath, targetPath);
    }

    private static async _writeWorkspaceFile(
        parentDir: string,
        repos: Array<DiscoveredRepo | MigrationPreviewSource>,
        currentWorkspaceRoot?: string
    ): Promise<string> {
        const repoDirs = repos.map((repo) => repo.repoDir);
        if (currentWorkspaceRoot) {
            const resolvedCurrentWorkspaceRoot = path.resolve(currentWorkspaceRoot);
            if (path.dirname(resolvedCurrentWorkspaceRoot) === path.resolve(parentDir)) {
                repoDirs.push(resolvedCurrentWorkspaceRoot);
            }
        }
        return this.generateCodeWorkspace(parentDir, repoDirs);
    }

    private static async _copyDirectoryRecursive(
        sourceDir: string,
        targetDir: string,
        options: { overwrite: boolean }
    ): Promise<void> {
        await fs.promises.mkdir(targetDir, { recursive: true });
        const entries = await fs.promises.readdir(sourceDir, { withFileTypes: true });
        for (const entry of entries) {
            const sourcePath = path.join(sourceDir, entry.name);
            const targetPath = path.join(targetDir, entry.name);
            if (entry.isDirectory()) {
                await this._copyDirectoryRecursive(sourcePath, targetPath, options);
                continue;
            }
            if (!options.overwrite && fs.existsSync(targetPath)) {
                continue;
            }
            await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.promises.copyFile(sourcePath, targetPath);
        }
    }

    private static async _listFilesRecursive(rootDir: string, depth: number = 0): Promise<string[]> {
        if (depth > MAX_AGENT_SCAN_DEPTH || !fs.existsSync(rootDir)) {
            return [];
        }

        const entries = await fs.promises.readdir(rootDir, { withFileTypes: true });
        const files: string[] = [];
        for (const entry of entries) {
            const absolutePath = path.join(rootDir, entry.name);
            if (entry.isDirectory()) {
                files.push(...await this._listFilesRecursive(absolutePath, depth + 1));
            } else if (entry.isFile()) {
                files.push(absolutePath);
            }
        }
        return files.sort((left, right) => left.localeCompare(right));
    }

    public static async hashFile(filePath: string): Promise<string> {
        const content = await fs.promises.readFile(filePath);
        return crypto.createHash('sha256').update(content).digest('hex');
    }

    private static _isSafeParentDir(parentDir: string): boolean {
        const normalized = path.resolve(parentDir || '');
        if (!normalized) {
            return false;
        }
        if (normalized === os.homedir()) {
            return false;
        }
        return normalized !== path.parse(normalized).root;
    }

    private static _findNextSectionIndex(lines: string[], startIndex: number): number {
        for (let index = startIndex; index < lines.length; index += 1) {
            if (/^##\s+/.test(lines[index].trim())) {
                return index;
            }
        }
        return -1;
    }

    private static _findMetadataInsertIndex(lines: string[], metadataIndex: number, blockEnd: number): number {
        let insertionIndex = metadataIndex + 1;
        while (insertionIndex < blockEnd && lines[insertionIndex].trim() === '') {
            insertionIndex += 1;
        }

        let lastPreferredIndex = -1;
        for (let index = metadataIndex + 1; index < blockEnd; index += 1) {
            if (/^\*\*(Tags|Complexity):\*\*/i.test(lines[index].trim())) {
                lastPreferredIndex = index;
            }
        }

        if (lastPreferredIndex >= 0) {
            return lastPreferredIndex + 1;
        }

        return insertionIndex;
    }
}
