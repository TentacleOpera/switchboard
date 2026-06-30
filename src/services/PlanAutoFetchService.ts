import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(cp.execFile);

export interface PlanAutoFetchStatus {
    enabled: boolean;
    lastOutcome: 'success' | 'skipped' | 'failed' | 'idle';
    lastReason: string;
    lastTimestamp?: number;
    resolvedBranch?: string;
}

export class PlanAutoFetchService implements vscode.Disposable {
    private _disposables: vscode.Disposable[] = [];
    private _timer?: NodeJS.Timeout;
    private _inFlight = false;
    private _statusMap = new Map<string, PlanAutoFetchStatus>();
    private _failuresMap = new Map<string, { count: number; lastTime: number }>();

    constructor(
        private readonly _getKanbanProvider: () => any,
        private readonly _outputChannel: vscode.OutputChannel
    ) {}

    public getStatus(workspaceRoot: string): PlanAutoFetchStatus {
        const resolved = path.resolve(workspaceRoot);
        const config = vscode.workspace.getConfiguration('switchboard.planAutoFetch', vscode.Uri.file(resolved));
        const enabled = config.get<boolean>('enabled', false);
        const current = this._statusMap.get(resolved);
        return current ? { ...current, enabled } : { enabled, lastOutcome: 'idle', lastReason: 'Never run' };
    }

    public async initialize(): Promise<void> {
        this._outputChannel.appendLine('[PlanAutoFetch] Initializing service...');
        
        // Listen for configuration changes
        const configListener = vscode.workspace.onDidChangeConfiguration(async (e) => {
            if (
                e.affectsConfiguration('switchboard.planAutoFetch.enabled') ||
                e.affectsConfiguration('switchboard.planAutoFetch.intervalSeconds')
            ) {
                this._outputChannel.appendLine('[PlanAutoFetch] Config changed, restarting cycle timer...');
                this._startTimer();
            }
        });
        this._disposables.push(configListener);

        this._startTimer();

        // Run one cycle on startup (asynchronously, do not block activation)
        this.runCycle().catch(err => {
            this._outputChannel.appendLine(`[PlanAutoFetch] Startup cycle failed: ${err}`);
        });
    }

    private _startTimer(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }

        // We check across all workspace folders' settings to see if auto-fetch is enabled anywhere
        const anyEnabled = this._getAllowedRoots().some(root => {
            const config = vscode.workspace.getConfiguration('switchboard.planAutoFetch', vscode.Uri.file(root));
            return config.get<boolean>('enabled', false);
        });

        if (!anyEnabled) {
            this._outputChannel.appendLine('[PlanAutoFetch] Auto-fetch disabled across all workspaces. Timer not started.');
            return;
        }

        // Get interval (default 300s, min 60s)
        let intervalSeconds = 300;
        for (const root of this._getAllowedRoots()) {
            const config = vscode.workspace.getConfiguration('switchboard.planAutoFetch', vscode.Uri.file(root));
            if (config.get<boolean>('enabled', false)) {
                const val = config.get<number>('intervalSeconds', 300);
                if (val && val > 0) {
                    intervalSeconds = Math.max(60, val);
                    break; // use the first found
                }
            }
        }

        this._outputChannel.appendLine(`[PlanAutoFetch] Starting periodic cycle timer. Interval: ${intervalSeconds} seconds.`);
        this._timer = setInterval(() => {
            this.runCycle().catch(err => {
                this._outputChannel.appendLine(`[PlanAutoFetch] Periodic cycle failed: ${err}`);
            });
        }, intervalSeconds * 1000);
    }

    public async runCycle(): Promise<void> {
        if (this._inFlight) {
            this._outputChannel.appendLine('[PlanAutoFetch] Cycle already in progress, skipping overlap.');
            return;
        }
        this._inFlight = true;

        try {
            const allRoots = this._getAllowedRoots();
            for (const root of allRoots) {
                const config = vscode.workspace.getConfiguration('switchboard.planAutoFetch', vscode.Uri.file(root));
                const enabled = config.get<boolean>('enabled', false);
                if (!enabled) {
                    continue;
                }

                if (!fs.existsSync(path.join(root, '.switchboard'))) {
                    continue;
                }

                await this._runCycleForRoot(root, config);
            }
        } finally {
            this._inFlight = false;
        }
    }

    private async _runCycleForRoot(root: string, config: vscode.WorkspaceConfiguration): Promise<void> {
        const resolvedRoot = path.resolve(root);
        
        // Resolve git root
        let effectiveGitRoot = resolvedRoot;
        try {
            const kanbanProvider = this._getKanbanProvider();
            if (kanbanProvider && typeof kanbanProvider.getControlPlaneSelectionStatus === 'function') {
                const cpStatus = kanbanProvider.getControlPlaneSelectionStatus(resolvedRoot);
                if (cpStatus.isRepoScoped && cpStatus.repoScopeFilter && cpStatus.controlPlaneRoot) {
                    effectiveGitRoot = path.join(cpStatus.controlPlaneRoot, cpStatus.repoScopeFilter);
                }
            }
        } catch (err) {
            this._outputChannel.appendLine(`[PlanAutoFetch] [${path.basename(resolvedRoot)}] Error resolving control-plane root: ${err}`);
        }

        if (!fs.existsSync(path.join(effectiveGitRoot, '.git'))) {
            this._updateStatus(resolvedRoot, 'skipped', 'Not a git repository');
            return;
        }

        // Settings
        const remote = config.get<string>('remote', 'origin') || 'origin';
        const defaultBranchSetting = config.get<string>('defaultBranch', '');
        const trustedAuthors = config.get<string[]>('trustedAuthors', []) || [];
        const intervalSeconds = Math.max(60, config.get<number>('intervalSeconds', 300));

        // Backoff check
        const failureInfo = this._failuresMap.get(resolvedRoot);
        if (failureInfo && failureInfo.count > 0) {
            const backoffMultiplier = Math.min(8, Math.pow(2, failureInfo.count - 1));
            const waitTimeMs = backoffMultiplier * intervalSeconds * 1000;
            if (Date.now() - failureInfo.lastTime < waitTimeMs) {
                this._outputChannel.appendLine(`[PlanAutoFetch] [${path.basename(resolvedRoot)}] Skipping fetch due to backoff (${failureInfo.count} failures).`);
                this._updateStatus(resolvedRoot, 'skipped', `Backoff (${failureInfo.count} consecutive fetch failures)`);
                return;
            }
        }

        this._outputChannel.appendLine(`[PlanAutoFetch] [${path.basename(resolvedRoot)}] Running auto-fetch cycle in ${effectiveGitRoot}`);

        let fetchSucceeded = false;
        try {
            // Resolve default branch
            let defaultBranch = defaultBranchSetting;
            if (!defaultBranch) {
                try {
                    const { stdout } = await execFileAsync('git', ['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`], { cwd: effectiveGitRoot, timeout: 5000 });
                    const prefix = `refs/remotes/${remote}/`;
                    const trimmed = stdout.trim();
                    if (trimmed.startsWith(prefix)) {
                        defaultBranch = trimmed.substring(prefix.length);
                    }
                } catch (err) {
                    // fall through
                }
            }

            if (!defaultBranch) {
                this._updateStatus(resolvedRoot, 'skipped', `Could not resolve default branch for remote '${remote}'`);
                return;
            }

            this._updateStatus(resolvedRoot, 'idle', 'Checking remote...', defaultBranch);

            // Fetch default branch
            this._outputChannel.appendLine(`[PlanAutoFetch] [${path.basename(resolvedRoot)}] Fetching ${remote}/${defaultBranch}...`);
            await execFileAsync('git', ['fetch', remote, defaultBranch], { cwd: effectiveGitRoot, timeout: 15000 });
            fetchSucceeded = true;

            // Fetch succeeded, reset backoff
            this._failuresMap.delete(resolvedRoot);

            // Guard checks
            // 1. Current branch is default branch
            const { stdout: curBranchRaw } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: effectiveGitRoot, timeout: 5000 });
            const currentBranch = curBranchRaw.trim();
            if (currentBranch !== defaultBranch) {
                this._updateStatus(resolvedRoot, 'skipped', `On feature branch '${currentBranch}' (not default '${defaultBranch}')`, defaultBranch);
                return;
            }

            // 2. Working tree is clean
            const { stdout: statusRaw } = await execFileAsync('git', ['status', '--porcelain'], { cwd: effectiveGitRoot, timeout: 5000 });
            if (statusRaw.trim() !== '') {
                this._updateStatus(resolvedRoot, 'skipped', 'Working tree is dirty', defaultBranch);
                return;
            }

            // 3. Local is behind and fast-forwardable
            const remoteRef = `${remote}/${defaultBranch}`;
            let isAncestor = false;
            try {
                await execFileAsync('git', ['merge-base', '--is-ancestor', 'HEAD', remoteRef], { cwd: effectiveGitRoot, timeout: 5000 });
                isAncestor = true;
            } catch {
                isAncestor = false;
            }

            if (!isAncestor) {
                this._updateStatus(resolvedRoot, 'skipped', 'Local branch is not behind remote, or has diverged', defaultBranch);
                return;
            }

            const { stdout: localHeadSha } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: effectiveGitRoot, timeout: 5000 });
            const { stdout: remoteHeadSha } = await execFileAsync('git', ['rev-parse', remoteRef], { cwd: effectiveGitRoot, timeout: 5000 });

            if (localHeadSha.trim() === remoteHeadSha.trim()) {
                this._updateStatus(resolvedRoot, 'skipped', 'Up to date', defaultBranch);
                return;
            }

            // 4. Every new commit is trusted
            const { stdout: userEmailRaw } = await execFileAsync('git', ['config', 'user.email'], { cwd: effectiveGitRoot, timeout: 5000 });
            const userEmail = userEmailRaw.trim().toLowerCase();
            const allowedEmails = new Set([userEmail, ...trustedAuthors.map(e => e.trim().toLowerCase())]);

            const { stdout: logRaw } = await execFileAsync('git', ['log', '--format=%ae', `HEAD..${remoteRef}`], { cwd: effectiveGitRoot, timeout: 5000 });
            const commitEmails = logRaw.split('\n').map(l => l.trim().toLowerCase()).filter(l => l !== '');

            const untrusted = commitEmails.filter(email => !allowedEmails.has(email));
            if (untrusted.length > 0) {
                const uniqueUntrusted = [...new Set(untrusted)];
                this._updateStatus(resolvedRoot, 'skipped', `Untrusted author commit(s) skipped: ${uniqueUntrusted.join(', ')}`, defaultBranch);
                return;
            }

            // All guards passed -> merge --ff-only
            this._outputChannel.appendLine(`[PlanAutoFetch] [${path.basename(resolvedRoot)}] Merging ${remoteRef} fast-forward...`);
            await execFileAsync('git', ['merge', '--ff-only', remoteRef], { cwd: effectiveGitRoot, timeout: 15000 });

            // count commits fast-forwarded
            const count = commitEmails.length;
            this._updateStatus(resolvedRoot, 'success', `Fast-forwarded ${count} commit${count === 1 ? '' : 's'}`, defaultBranch);
            this._outputChannel.appendLine(`[PlanAutoFetch] [${path.basename(resolvedRoot)}] Successfully fast-forwarded ${count} commits.`);
            
        } catch (err: any) {
            // Only increment backoff on fetch failures (not post-fetch guard/merge errors).
            // Re-read from the map to avoid stale local references after delete().
            if (!fetchSucceeded) {
                const currentFailures = this._failuresMap.get(resolvedRoot);
                const count = (currentFailures?.count || 0) + 1;
                this._failuresMap.set(resolvedRoot, { count, lastTime: Date.now() });
            }
            
            const errMsg = err?.message || String(err);
            this._outputChannel.appendLine(`[PlanAutoFetch] [${path.basename(resolvedRoot)}] Error running auto-fetch: ${errMsg}`);
            this._updateStatus(resolvedRoot, 'failed', `Fetch/git error: ${errMsg}`);
        }
    }

    private _updateStatus(workspaceRoot: string, outcome: 'success' | 'skipped' | 'failed' | 'idle', reason: string, defaultBranch?: string): void {
        const resolved = path.resolve(workspaceRoot);
        const oldStatus = this._statusMap.get(resolved);
        this._statusMap.set(resolved, {
            enabled: this.getStatus(resolved).enabled,
            lastOutcome: outcome,
            lastReason: reason,
            lastTimestamp: Date.now(),
            resolvedBranch: defaultBranch || oldStatus?.resolvedBranch
        });
    }

    private _getAllowedRoots(): string[] {
        const roots = (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
        const allowedRoots = new Set<string>(roots);
        try {
            const { getMappingsFromIndex } = require('./WorkspaceIdentityService');
            const cfg = getMappingsFromIndex();
            if (cfg?.enabled && Array.isArray(cfg.mappings)) {
                for (const m of cfg.mappings) {
                    const parent = m.parentFolder || (m as any).parentWorkspaceFolder;
                    if (typeof parent === 'string') {
                        const p = parent.trim();
                        const expanded = p.startsWith('~')
                            ? path.join(require('os').homedir(), p.slice(1))
                            : p;
                        allowedRoots.add(path.resolve(expanded));
                    }
                    for (const wf of m.workspaceFolders ?? []) {
                        const expanded = wf.startsWith('~')
                            ? path.join(require('os').homedir(), wf.slice(1))
                            : wf;
                        allowedRoots.add(path.resolve(expanded));
                    }
                }
            }
        } catch { /* fall through */ }
        return Array.from(allowedRoots);
    }

    public dispose(): void {
        if (this._timer) {
            clearInterval(this._timer);
        }
        for (const d of this._disposables) {
            d.dispose();
        }
        this._disposables = [];
    }
}
