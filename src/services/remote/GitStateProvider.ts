import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import { promisify } from 'util';
import type { KanbanDatabase, KanbanPlanRecord } from '../KanbanDatabase';
import { hasMarker, stampMarker } from '../commentMarker';
import type { RemoteProvider, RemoteStateDelta, RemoteCommentDelta } from './RemoteProvider';
import { PlanAutoFetchService } from '../PlanAutoFetchService';

const execFileAsync = promisify(cp.execFile);

export type GitProviderKind = 'control-plane' | 'wiki';

interface GitStateProviderDeps {
    db?: KanbanDatabase;
    getWorkspaceId?: () => Promise<string>;
    getPlansDir?: () => Promise<string>;
    getExportRoot: () => string | null;
    log?: (msg: string) => void;
}

const COLUMN_LINE_RE = /^\*\*Column:\*\*\s*(.+)$/m;

export class GitStateProvider implements RemoteProvider {
    public readonly kind: 'control-plane' | 'wiki';
    public readonly gitKind: GitProviderKind;
    private _deps: GitStateProviderDeps;
    private _pushInFlight = false;
    private _pushPending = false;
    private _trustedEmails: Set<string> | null = null;

    constructor(gitKind: GitProviderKind, deps: GitStateProviderDeps) {
        this.gitKind = gitKind;
        this.kind = gitKind;
        this._deps = deps;
    }

    private _log(msg: string): void {
        (this._deps.log || (() => {}))(`[GitStateProvider:${this.gitKind}] ${msg}`);
    }

    /** Public accessor for the export root path (used by RemoteControlService for cursor seeding). */
    public getExportRoot(): string | null {
        return this._deps.getExportRoot();
    }

    private _getRoot(): string | null {
        return this._deps.getExportRoot();
    }

    private async _git(args: string[], opts?: { cwd?: string; timeout?: number }): Promise<{ stdout: string; stderr: string }> {
        const root = opts?.cwd || this._getRoot();
        if (!root) { throw new Error('No export root configured'); }
        return execFileAsync('git', args, { cwd: root, timeout: opts?.timeout || 15000 });
    }

    public async fetchStateDeltas(sinceCursor: string): Promise<{ deltas: RemoteStateDelta[]; nextCursor: string }> {
        const root = this._getRoot();
        if (!root) { return { deltas: [], nextCursor: sinceCursor }; }

        try {
            await this._git(['fetch', 'origin'], { cwd: root });
        } catch (e) {
            this._log(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
            return { deltas: [], nextCursor: sinceCursor };
        }

        if (!sinceCursor) {
            try {
                const { stdout } = await this._git(['rev-parse', 'HEAD'], { cwd: root });
                return { deltas: [], nextCursor: stdout.trim() };
            } catch {
                return { deltas: [], nextCursor: sinceCursor };
            }
        }

        let remoteHead = '';
        try {
            const { stdout } = await this._git(['rev-parse', 'origin/HEAD'], { cwd: root });
            remoteHead = stdout.trim();
        } catch {
            try {
                const { stdout } = await this._git(['rev-parse', 'origin/main'], { cwd: root });
                remoteHead = stdout.trim();
            } catch (e) {
                this._log(`Cannot resolve remote HEAD: ${e instanceof Error ? e.message : String(e)}`);
                return { deltas: [], nextCursor: sinceCursor };
            }
        }

        if (remoteHead === sinceCursor) {
            return { deltas: [], nextCursor: sinceCursor };
        }

        let logOutput = '';
        try {
            const { stdout } = await this._git([
                'log', '--format=%H%x00%ae%x00', `${sinceCursor}..${remoteHead}`, '--',
                '.switchboard/'
            ], { cwd: root });
            logOutput = stdout;
        } catch (e) {
            this._log(`git log failed: ${e instanceof Error ? e.message : String(e)}`);
            return { deltas: [], nextCursor: sinceCursor };
        }

        const deltas: RemoteStateDelta[] = [];
        const trusted = await this._getTrustedEmails(root);

        for (const entry of logOutput.split('\n').filter(l => l.trim())) {
            const parts = entry.split('\0');
            const sha = (parts[0] || '').trim();
            const authorEmail = (parts[1] || '').trim().toLowerCase();

            if (!sha) { continue; }

            if (!trusted.has(authorEmail)) {
                this._log(`Untrusted author ${authorEmail} on commit ${sha} — dropping state delta`);
                continue;
            }

            try {
                const { stdout: diffOutput } = await this._git([
                    'diff', `${sinceCursor}..${sha}`, '--', '.switchboard/'
                ], { cwd: root });

                const planDeltas = this._parseColumnDeltasFromDiff(diffOutput);
                for (const d of planDeltas) {
                    deltas.push(d);
                }
            } catch (e) {
                this._log(`diff parse failed for ${sha}: ${e instanceof Error ? e.message : String(e)}`);
            }
        }

        return { deltas, nextCursor: remoteHead || sinceCursor };
    }

    public async fetchCommentDeltas(sinceCursor: string): Promise<{ deltas: RemoteCommentDelta[]; nextCursor: string }> {
        const root = this._getRoot();
        if (!root) { return { deltas: [], nextCursor: sinceCursor }; }

        try {
            await this._git(['fetch', 'origin'], { cwd: root });
        } catch (e) {
            this._log(`fetch failed: ${e instanceof Error ? e.message : String(e)}`);
            return { deltas: [], nextCursor: sinceCursor };
        }

        if (!sinceCursor) {
            try {
                const { stdout } = await this._git(['rev-parse', 'HEAD'], { cwd: root });
                return { deltas: [], nextCursor: stdout.trim() };
            } catch {
                return { deltas: [], nextCursor: sinceCursor };
            }
        }

        let remoteHead = '';
        try {
            const { stdout } = await this._git(['rev-parse', 'origin/HEAD'], { cwd: root });
            remoteHead = stdout.trim();
        } catch {
            try {
                const { stdout } = await this._git(['rev-parse', 'origin/main'], { cwd: root });
                remoteHead = stdout.trim();
            } catch {
                return { deltas: [], nextCursor: sinceCursor };
            }
        }

        if (remoteHead === sinceCursor) {
            return { deltas: [], nextCursor: sinceCursor };
        }

        const deltas: RemoteCommentDelta[] = [];
        const trusted = await this._getTrustedEmails(root);

        try {
            const { stdout: logOutput } = await this._git([
                'log', '--format=%H%x00%ae%x00', `${sinceCursor}..${remoteHead}`, '--',
                '.switchboard/'
            ], { cwd: root });

            for (const entry of logOutput.split('\n').filter(l => l.trim())) {
                const parts = entry.split('\0');
                const sha = (parts[0] || '').trim();
                const authorEmail = (parts[1] || '').trim().toLowerCase();

                if (!sha) { continue; }

                if (!trusted.has(authorEmail)) {
                    this._log(`Untrusted author ${authorEmail} on commit ${sha} — dropping comment delta`);
                    continue;
                }

                try {
                    const { stdout: diffOutput } = await this._git([
                        'diff', `${sinceCursor}..${sha}`, '--', '.switchboard/'
                    ], { cwd: root });

                    const commentDeltas = this._parseCommentDeltasFromDiff(diffOutput, sha);
                    for (const d of commentDeltas) {
                        deltas.push(d);
                    }
                } catch (e) {
                    this._log(`comment diff parse failed for ${sha}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
        } catch (e) {
            this._log(`comment log failed: ${e instanceof Error ? e.message : String(e)}`);
        }

        return { deltas, nextCursor: remoteHead || sinceCursor };
    }

    public stateKeyToColumn(stateKey: string): string | undefined {
        const name = String(stateKey || '').trim();
        return name || undefined;
    }

    public async refreshLocalPlanFromRemote(remoteId: string): Promise<void> {
        // For git providers, the plan file is already local — the control-plane
        // pull (PlanAutoFetchService §5) lands new files on disk. No refresh needed.
    }

    public async importRemotePlan(remoteId: string): Promise<KanbanPlanRecord | null> {
        // A new plan file landed via §5's pull cycle; the existing plan-file-import-watcher
        // already handles inserting it into the DB. Return null to let that path handle it.
        return null;
    }

    public async postComment(remoteId: string, body: string): Promise<void> {
        const root = this._getRoot();
        if (!root) { return; }

        const planPath = this._resolvePlanPathFromRemoteId(root, remoteId);
        if (!planPath || !fs.existsSync(planPath)) {
            this._log(`postComment: plan file not found for ${remoteId}`);
            return;
        }

        const stamp = new Date().toISOString();
        const markedBody = stampMarker(body);
        const appendBlock = `\n\n## Inbound Comment (${stamp})\n\n${markedBody}\n`;

        try {
            await fs.promises.appendFile(planPath, appendBlock, 'utf8');
            await this._git(['add', path.relative(root, planPath)], { cwd: root });
            await this._git(['commit', '-m', `switchboard: comment on ${path.basename(planPath)}`], { cwd: root });
            await this._git(['push', 'origin', 'HEAD'], { cwd: root });
        } catch (e) {
            this._log(`postComment commit/push failed: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    // ── Outbound push (net-new, NOT an interface method) ──────────

    public async pushExportedState(): Promise<void> {
        if (this._pushInFlight) {
            this._pushPending = true;
            return;
        }
        this._pushInFlight = true;

        try {
            const root = this._getRoot();
            if (!root) { return; }
            if (!fs.existsSync(path.join(root, '.git'))) { return; }

            // Fetch first and reconcile to avoid non-fast-forward
            try {
                await this._git(['fetch', 'origin'], { cwd: root });
            } catch {
                // remote may not exist yet on first push
            }

            // Rebase/merge remote changes before pushing
            try {
                const { stdout: currentBranch } = await this._git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
                const branch = currentBranch.trim();
                if (branch && branch !== 'HEAD') {
                    try {
                        await this._git(['rebase', `origin/${branch}`], { cwd: root });
                    } catch {
                        try {
                            await this._git(['merge', '--ff-only', `origin/${branch}`], { cwd: root });
                        } catch (mergeErr) {
                            this._log(`Cannot reconcile with remote — skipping push: ${mergeErr instanceof Error ? mergeErr.message : String(mergeErr)}`);
                            return;
                        }
                    }
                }
            } catch {
                // No remote branch yet — first push, that's fine
            }

            // Stage mirror files
            try {
                await this._git(['add', '.switchboard/kanban-board.md'], { cwd: root });
                await this._git(['add', '.switchboard/kanban-state-*.md'], { cwd: root });
            } catch {
                // No mirror files to add yet
            }

            // Check if there's anything to commit (only mirror files)
            try {
                const { stdout: statusOutput } = await this._git(['status', '--porcelain'], { cwd: root });
                const mirrorLines = statusOutput.split('\n').filter(line => {
                    const normalized = line.trim().replace(/\\/g, '/');
                    return PlanAutoFetchService.MIRROR_FILE_RE.test(normalized);
                });
                if (mirrorLines.length === 0) {
                    return;
                }
            } catch {
                return;
            }

            try {
                await this._git(['commit', '-m', 'switchboard: update board state mirror'], { cwd: root });
            } catch {
                return;
            }

            try {
                const { stdout: currentBranch } = await this._git(['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root });
                const branch = currentBranch.trim();
                await this._git(['push', 'origin', branch || 'HEAD'], { cwd: root });
                this._log('Pushed board state mirror');
            } catch (e) {
                this._log(`push failed: ${e instanceof Error ? e.message : String(e)}`);
            }
        } catch (e) {
            this._log(`pushExportedState error: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
            this._pushInFlight = false;
            if (this._pushPending) {
                this._pushPending = false;
                void this.pushExportedState();
            }
        }
    }

    // ── Internal helpers ──────────────────────────────────────────

    private _parseColumnDeltasFromDiff(diffOutput: string): RemoteStateDelta[] {
        const deltas: RemoteStateDelta[] = [];
        const fileSections = diffOutput.split(/^diff --git /m);

        for (const section of fileSections) {
            if (!section.trim()) { continue; }

            const pathMatch = section.match(/^b\/(.+\.md)/m);
            if (!pathMatch) { continue; }
            const filePath = pathMatch[1];

            const addedLines = section.split('\n')
                .filter(l => l.startsWith('+') && !l.startsWith('++'))
                .map(l => l.slice(1));

            for (const line of addedLines) {
                const match = line.match(COLUMN_LINE_RE);
                if (match) {
                    const columnName = match[1].trim();
                    const remoteId = path.basename(filePath, '.md');
                    deltas.push({ remoteId, stateKey: columnName });
                }
            }
        }

        return deltas;
    }

    private _parseCommentDeltasFromDiff(diffOutput: string, commitSha: string): RemoteCommentDelta[] {
        const deltas: RemoteCommentDelta[] = [];
        const fileSections = diffOutput.split(/^diff --git /m);

        for (const section of fileSections) {
            if (!section.trim()) { continue; }

            const pathMatch = section.match(/^b\/(.+\.md)/m);
            if (!pathMatch) { continue; }
            const filePath = pathMatch[1];
            const remoteId = path.basename(filePath, '.md');

            const addedLines = section.split('\n')
                .filter(l => l.startsWith('+') && !l.startsWith('++'))
                .map(l => l.slice(1))
                .join('\n');

            const commentHeaderRe = /^## Inbound Comment \(([^)]+)\)/gm;
            let cm;
            while ((cm = commentHeaderRe.exec(addedLines)) !== null) {
                const createdAt = cm[1];
                const bodyStart = cm.index + cm[0].length;
                const afterHeader = addedLines.slice(bodyStart);
                const nextSection = afterHeader.search(/^## /m);
                const body = (nextSection >= 0 ? afterHeader.slice(0, nextSection) : afterHeader).trim();

                deltas.push({
                    remoteId,
                    commentId: `${commitSha}:${remoteId}:${createdAt}`,
                    body,
                    createdAt,
                    authoredBySelf: hasMarker(body),
                });
            }
        }

        return deltas;
    }

    private _resolvePlanPathFromRemoteId(root: string, remoteId: string): string | null {
        const plansDir = path.join(root, '.switchboard', 'plans');
        if (!fs.existsSync(plansDir)) { return null; }

        const directPath = path.join(plansDir, `${remoteId}.md`);
        if (fs.existsSync(directPath)) { return directPath; }

        try {
            const entries = fs.readdirSync(plansDir);
            for (const entry of entries) {
                if (entry.endsWith('.md') && entry.includes(remoteId)) {
                    return path.join(plansDir, entry);
                }
            }
        } catch { /* fall through */ }

        return null;
    }

    private async _getTrustedEmails(root: string): Promise<Set<string>> {
        if (this._trustedEmails) { return this._trustedEmails; }

        const emails = new Set<string>();

        try {
            const { stdout } = await this._git(['config', 'user.email'], { cwd: root });
            const localEmail = stdout.trim().toLowerCase();
            if (localEmail) { emails.add(localEmail); }
        } catch { /* no local git config */ }

        try {
            const vscode = require('vscode');
            const config = vscode.workspace.getConfiguration('switchboard.planAutoFetch', vscode.Uri.file(root));
            const trustedAuthors: string[] = config.get('trustedAuthors', []) || [];
            for (const email of trustedAuthors) {
                const trimmed = email.trim().toLowerCase();
                if (trimmed) { emails.add(trimmed); }
            }
        } catch { /* outside extension host */ }

        this._trustedEmails = emails;
        return emails;
    }
}
