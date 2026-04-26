import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ControlPlaneMigrationService } from './ControlPlaneMigrationService';
import { KanbanDatabase } from './KanbanDatabase';
import { ensureWorkspaceIdentity } from './WorkspaceIdentityService';

export interface ScaffoldOptions {
    parentDir: string;
    workspaceName: string;
    repoUrls: string[];
    pat: string;
}

export interface RepoOutcome {
    url: string;
    dir: string;
    status: 'cloned' | 'skipped' | 'failed';
    existingSubRepoDb?: boolean;
    cleanupAction?: 'deleted' | 'kept';
    error?: string;
}

export interface ScaffoldResult {
    success: boolean;
    workspaceFilePath?: string;
    repos: RepoOutcome[];
    warnings?: string[];
    error?: string;
}

type RepoPreflight = {
    url: string;
    dirName: string;
    targetDir: string;
    skipExisting: boolean;
};

type NormalizedScaffoldOptions = {
    parentDir: string;
    workspaceName: string;
    repoUrls: string[];
    pat: string;
    repos: RepoPreflight[];
};

const DELETE_SUB_REPO_DB_ACTION = 'Delete sub-repo DB (Recommended)';
const KEEP_SUB_REPO_DB_ACTION = 'Keep DB and proceed';
const CANCEL_SUB_REPO_DB_ACTION = 'Cancel';

let _scaffolding = false;

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expandHome(input: string): string {
    if (input === '~') {
        return os.homedir();
    }
    if (input.startsWith('~/') || input.startsWith('~\\')) {
        return path.join(os.homedir(), input.slice(2));
    }
    return input;
}

function injectPat(rawUrl: string, pat: string): string {
    const url = new URL(rawUrl);
    url.username = 'oauth2';
    url.password = pat;
    return url.toString();
}

function stripSensitiveText(text: string, rawUrl: string, pat: string): string {
    if (!text) {
        return '';
    }

    const values = new Set<string>();
    if (pat) {
        values.add(pat);
        values.add(encodeURIComponent(pat));
    }
    if (rawUrl && pat) {
        try {
            const authenticatedUrl = injectPat(rawUrl, pat);
            values.add(authenticatedUrl);
            values.add(authenticatedUrl.replace(/\/$/, ''));
        } catch {
            // Ignore URL reconstruction errors and keep other scrubbers.
        }
    }

    let sanitized = String(text);
    for (const value of [...values].filter(Boolean).sort((left, right) => right.length - left.length)) {
        sanitized = sanitized.replace(new RegExp(escapeRegExp(value), 'g'), '***');
    }
    return sanitized;
}

function sanitizeErrorText(text: string, repoUrls: string[], pat: string): string {
    return repoUrls.reduce((sanitized, rawUrl) => stripSensitiveText(sanitized, rawUrl, pat), text);
}

function safeClone(rawUrl: string, pat: string, targetDir: string): void {
    try {
        execFileSync('git', ['clone', '--', injectPat(rawUrl, pat), targetDir], {
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });
    } catch (error: any) {
        const safeMessage = stripSensitiveText(error?.message ?? '', rawUrl, pat);
        const safeStdout = stripSensitiveText(error?.stdout?.toString('utf8') ?? '', rawUrl, pat);
        const safeStderr = stripSensitiveText(error?.stderr?.toString('utf8') ?? '', rawUrl, pat);
        throw new Error(
            [safeMessage, safeStdout, safeStderr]
                .filter(Boolean)
                .join('\n')
                .trim() || `Clone failed for ${rawUrl}`
        );
    }
}

function deriveRepoFolderName(rawUrl: string): string {
    if (!/^https:\/\//i.test(rawUrl)) {
        throw new Error(`Repository URLs must use HTTPS: ${rawUrl}`);
    }

    let parsed: URL;
    try {
        parsed = new URL(rawUrl);
    } catch {
        throw new Error(`Invalid repository URL: ${rawUrl}`);
    }

    if (parsed.protocol !== 'https:') {
        throw new Error(`Repository URLs must use HTTPS: ${rawUrl}`);
    }
    if (parsed.username || parsed.password) {
        throw new Error(`Repository URLs must not include embedded credentials: ${rawUrl}`);
    }

    const basename = path.posix.basename(parsed.pathname.replace(/\/+$/, ''));
    const decoded = decodeURIComponent(basename).replace(/\.git$/i, '').trim();
    if (!decoded || decoded === '.' || decoded === '..' || /[\\/]/.test(decoded)) {
        throw new Error(`Could not derive a valid target folder from ${rawUrl}`);
    }
    return decoded;
}

function isNonEmptyDirectory(targetDir: string): boolean {
    try {
        return fs.statSync(targetDir).isDirectory() && fs.readdirSync(targetDir).length > 0;
    } catch {
        return false;
    }
}

function getSubRepoDbPath(targetDir: string): string {
    return path.join(targetDir, '.switchboard', 'kanban.db');
}

export class MultiRepoScaffoldingService {
    public static async scaffold(options: ScaffoldOptions, extensionPath?: string): Promise<ScaffoldResult> {
        if (_scaffolding) {
            return {
                success: false,
                repos: [],
                error: 'A scaffold operation is already in progress.'
            };
        }

        _scaffolding = true;
        try {
            const normalized = this._normalizeOptions(options);
            return await this._doScaffold(normalized, extensionPath);
        } catch (error) {
            const repoUrls = Array.isArray(options.repoUrls)
                ? options.repoUrls.map((value) => String(value || '').trim()).filter(Boolean)
                : [];
            const safeError = sanitizeErrorText(
                error instanceof Error ? error.message : String(error),
                repoUrls,
                typeof options.pat === 'string' ? options.pat : ''
            );
            return {
                success: false,
                repos: [],
                error: safeError || 'Multi-repo scaffolding failed.'
            };
        } finally {
            _scaffolding = false;
        }
    }

    private static _normalizeOptions(options: ScaffoldOptions): NormalizedScaffoldOptions {
        const parentDirInput = expandHome(String(options.parentDir || '').trim());
        if (!parentDirInput) {
            throw new Error('A parent directory is required.');
        }

        const normalizedParentDir = path.resolve(parentDirInput);
        const repoUrls = Array.isArray(options.repoUrls)
            ? options.repoUrls.map((value) => String(value || '').trim()).filter(Boolean)
            : [];
        if (repoUrls.length === 0) {
            throw new Error('Add at least one HTTPS repository URL.');
        }

        const pat = String(options.pat || '');
        if (!pat) {
            throw new Error('A Personal Access Token is required.');
        }

        const workspaceName = String(options.workspaceName || '')
            .trim()
            .replace(/\.code-workspace$/i, '')
            .trim();
        if (workspaceName.includes('/') || workspaceName.includes('\\') || workspaceName === '.' || workspaceName === '..') {
            throw new Error('Workspace name must be a plain filename without path separators.');
        }

        const repoNames = new Set<string>();
        const repos: RepoPreflight[] = repoUrls.map((url) => {
            const dirName = deriveRepoFolderName(url);
            const normalizedName = dirName.toLowerCase();
            if (repoNames.has(normalizedName)) {
                throw new Error(`Multiple repository URLs would clone into the same folder: ${dirName}`);
            }
            repoNames.add(normalizedName);

            const targetDir = path.join(normalizedParentDir, dirName);
            if (fs.existsSync(targetDir) && !fs.statSync(targetDir).isDirectory()) {
                throw new Error(`Target path already exists and is not a directory: ${targetDir}`);
            }

            return {
                url,
                dirName,
                targetDir,
                skipExisting: isNonEmptyDirectory(targetDir)
            };
        });

        return {
            parentDir: normalizedParentDir,
            workspaceName,
            repoUrls,
            pat,
            repos
        };
    }

    private static async _doScaffold(options: NormalizedScaffoldOptions, extensionPath?: string): Promise<ScaffoldResult> {
        const repos: RepoOutcome[] = [];
        const warnings: string[] = [];
        const workspaceRepoDirs: string[] = [];

        await fs.promises.mkdir(options.parentDir, { recursive: true });
        await ControlPlaneMigrationService.bootstrapControlPlaneLayout(options.parentDir, extensionPath);

        const db = KanbanDatabase.forWorkspace(options.parentDir);
        const ready = await db.ensureReady();
        if (!ready) {
            return {
                success: false,
                repos,
                error: `Failed to initialize control-plane database at ${db.dbPath}.`
            };
        }

        await ensureWorkspaceIdentity(options.parentDir);

        for (const repo of options.repos) {
            if (repo.skipExisting) {
                const outcome: RepoOutcome = {
                    url: repo.url,
                    dir: repo.dirName,
                    status: 'skipped'
                };
                repos.push(outcome);

                const cleanup = await this._reviewSubRepoDb(repo.targetDir, outcome, warnings);
                if (cleanup.cancelled) {
                    return {
                        success: false,
                        repos,
                        warnings: warnings.length ? warnings : undefined,
                        error: 'Scaffold cancelled while reviewing sub-repo database cleanup.'
                    };
                }
                if (cleanup.error) {
                    outcome.status = 'failed';
                    outcome.error = cleanup.error;
                    continue;
                }

                workspaceRepoDirs.push(repo.targetDir);
                continue;
            }

            const outcome: RepoOutcome = {
                url: repo.url,
                dir: repo.dirName,
                status: 'cloned'
            };
            repos.push(outcome);

            try {
                safeClone(repo.url, options.pat, repo.targetDir);
            } catch (error) {
                outcome.status = 'failed';
                outcome.error = sanitizeErrorText(
                    error instanceof Error ? error.message : String(error),
                    options.repoUrls,
                    options.pat
                );
                continue;
            }

            const cleanup = await this._reviewSubRepoDb(repo.targetDir, outcome, warnings);
            if (cleanup.cancelled) {
                return {
                    success: false,
                    repos,
                    warnings: warnings.length ? warnings : undefined,
                    error: 'Scaffold cancelled while reviewing sub-repo database cleanup.'
                };
            }
            if (cleanup.error) {
                outcome.status = 'failed';
                outcome.error = cleanup.error;
                continue;
            }

            workspaceRepoDirs.push(repo.targetDir);
        }

        if (workspaceRepoDirs.length === 0) {
            return {
                success: false,
                repos,
                warnings: warnings.length ? warnings : undefined,
                error: 'No repositories were available to add to the Control Plane workspace.'
            };
        }

        const workspaceFilePath = await ControlPlaneMigrationService.generateCodeWorkspace(
            options.parentDir,
            workspaceRepoDirs,
            options.workspaceName
        );

        if (repos.some((repo) => repo.status === 'failed')) {
            warnings.push('Failed repositories were omitted from the generated workspace file.');
        }

        await this._offerReopenWorkspace(workspaceFilePath);

        return {
            success: true,
            workspaceFilePath,
            repos,
            warnings: warnings.length ? warnings : undefined
        };
    }

    private static async _reviewSubRepoDb(
        targetDir: string,
        outcome: RepoOutcome,
        warnings: string[]
    ): Promise<{ cancelled: boolean; error?: string }> {
        const dbPath = getSubRepoDbPath(targetDir);
        if (!fs.existsSync(dbPath)) {
            return { cancelled: false };
        }

        outcome.existingSubRepoDb = true;
        const selection = await vscode.window.showWarningMessage(
            `Switchboard found an existing sub-repo kanban.db in ${outcome.dir}. Delete it so the Control Plane parent stays authoritative, or keep it and proceed with a warning.`,
            { modal: true },
            DELETE_SUB_REPO_DB_ACTION,
            KEEP_SUB_REPO_DB_ACTION,
            CANCEL_SUB_REPO_DB_ACTION
        );

        if (selection === DELETE_SUB_REPO_DB_ACTION) {
            try {
                await Promise.all([
                    fs.promises.rm(dbPath, { force: true }),
                    fs.promises.rm(`${dbPath}-wal`, { force: true }),
                    fs.promises.rm(`${dbPath}-shm`, { force: true })
                ]);
                outcome.cleanupAction = 'deleted';
                return { cancelled: false };
            } catch (error) {
                return {
                    cancelled: false,
                    error: `Failed to delete the existing sub-repo kanban.db for ${outcome.dir}: ${error instanceof Error ? error.message : String(error)}`
                };
            }
        }

        if (selection === KEEP_SUB_REPO_DB_ACTION) {
            outcome.cleanupAction = 'kept';
            warnings.push(`Kept ${outcome.dir}/.switchboard/kanban.db with an explicit warning.`);
            return { cancelled: false };
        }

        return { cancelled: true };
    }

    private static async _offerReopenWorkspace(workspaceFilePath: string): Promise<void> {
        const reopenAction = 'Reopen in Control Plane';
        const selection = await vscode.window.showInformationMessage(
            `Control Plane workspace created at ${workspaceFilePath}.`,
            reopenAction
        );
        if (selection === reopenAction) {
            await vscode.commands.executeCommand(
                'vscode.openFolder',
                vscode.Uri.file(workspaceFilePath),
                { forceNewWindow: false }
            );
        }
    }
}
