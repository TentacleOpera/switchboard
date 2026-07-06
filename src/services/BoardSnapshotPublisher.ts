import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import { promisify } from 'util';
import type { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';

const execFileAsync = promisify(cp.execFile);

export const BOARD_SNAPSHOT_REF = 'switchboard/board';
export const BOARD_SNAPSHOT_MODE = 'read-only-snapshot';

interface BoardSnapshotPublisherDeps {
    db: KanbanDatabase;
    getWorkspaceRoot: () => string;
    getWorkspaceId: () => Promise<string | null>;
    log?: (msg: string) => void;
}

interface BoardCardEntry {
    plan_id: string;
    topic: string;
    column: string;
    feature: string | null;
    project: string | null;
}

/**
 * One-directional, read-only board snapshot publisher.
 *
 * Writes `board.json` + `board.md` to the orphan branch `switchboard/board`
 * (never the code branches). Sole writer is the extension; always overwrite;
 * no diff-ingest, no control, no per-persist timestamp. Content-stable via
 * SHA256 hash skip + debounce + single-flight.
 *
 * See `.switchboard/plans/feature_plan_20260704_224822_board_state_read_snapshot_isolated_ref_one_directional.md`.
 */
export class BoardSnapshotPublisher {
    private _deps: BoardSnapshotPublisherDeps;
    private _debounceTimer: NodeJS.Timeout | null = null;
    private _inFlight = false;
    private _pending = false;
    private _lastPublishedHash: string | null = null;
    private static readonly DEBOUNCE_MS = 500;

    constructor(deps: BoardSnapshotPublisherDeps) {
        this._deps = deps;
    }

    private _log(msg: string): void {
        (this._deps.log || (() => {}))(`[BoardSnapshotPublisher] ${msg}`);
    }

    /**
     * Debounced publish request. Coalesces rapid board mutations into a single
     * snapshot publish. Safe to call on every `_persist`.
     */
    public schedulePublish(): void {
        if (this._debounceTimer) {
            clearTimeout(this._debounceTimer);
        }
        this._debounceTimer = setTimeout(() => {
            this._debounceTimer = null;
            void this.publish();
        }, BoardSnapshotPublisher.DEBOUNCE_MS);
    }

    /**
     * Publish the snapshot immediately (skips debounce). Content-stable: if the
     * serialized board state hash matches the last published hash, the publish
     * is skipped. Single-flight: a concurrent publish while one is in flight is
     * collapsed into a single trailing run.
     */
    public async publish(): Promise<'pushed' | 'skipped' | 'failed'> {
        if (this._inFlight) {
            this._pending = true;
            return 'skipped';
        }
        this._inFlight = true;
        try {
            const root = this._deps.getWorkspaceRoot();
            if (!root || !fs.existsSync(path.join(root, '.git'))) {
                return 'skipped';
            }

            const workspaceId = await this._deps.getWorkspaceId();
            if (!workspaceId) {
                return 'skipped';
            }

            const plans = await this._deps.db.getBoard(workspaceId);
            const { json, md, hash } = this._serialize(plans);
            if (hash === this._lastPublishedHash) {
                return 'skipped';
            }

            const result = await this._pushSnapshot(root, json, md);
            if (result === 'pushed') {
                this._lastPublishedHash = hash;
            }
            return result;
        } catch (e) {
            this._log(`publish error: ${e instanceof Error ? e.message : String(e)}`);
            return 'failed';
        } finally {
            this._inFlight = false;
            if (this._pending) {
                this._pending = false;
                void this.publish();
            }
        }
    }

    /** Reset cached hash (e.g. on config change). */
    public reset(): void {
        this._lastPublishedHash = null;
    }

    private _serialize(plans: KanbanPlanRecord[]): { json: string; md: string; hash: string } {
        const entries: BoardCardEntry[] = plans.map(p => ({
            plan_id: p.planId,
            topic: p.topic,
            column: p.kanbanColumn,
            feature: p.featureId ?? null,
            project: p.project ?? null,
        }));

        const json = JSON.stringify(
            {
                schema: 1,
                ordering: 'updated_at DESC',
                cards: entries,
            },
            null,
            2,
        );

        const mdLines: string[] = [];
        mdLines.push(`# Switchboard Board Snapshot`);
        mdLines.push('');
        mdLines.push(`_Read-only snapshot. Ordering: updated_at DESC. Not a control channel._`);
        mdLines.push('');
        mdLines.push(`| plan_id | column | topic | feature | project |`);
        mdLines.push(`|---|---|---|---|---|`);
        for (const e of entries) {
            const topic = e.topic.replace(/\|/g, '\\|');
            const feature = e.feature ?? '';
            const project = e.project ?? '';
            mdLines.push(`| ${e.plan_id} | ${e.column} | ${topic} | ${feature} | ${project} |`);
        }
        mdLines.push('');
        const md = mdLines.join('\n');

        const hash = crypto.createHash('sha256').update(json).digest('hex');
        return { json, md, hash };
    }

    private async _pushSnapshot(root: string, json: string, md: string): Promise<'pushed' | 'skipped' | 'failed'> {
        const git = (args: string[], cwd: string = root): Promise<{ stdout: string; stderr: string }> =>
            execFileAsync('git', args, { cwd, timeout: 30000 });

        // Use an isolated git worktree so the user's working tree + HEAD are NEVER
        // touched. The worktree is created on the orphan ref (or detached if the ref
        // doesn't exist yet), the snapshot files are written + committed there, then
        // the worktree is removed. This avoids the hazard of `git checkout` switching
        // the user's branch mid-publish.
        const tmpDir = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'sb-board-snapshot-'));
        let worktreePath = '';
        try {
            // Determine if the orphan ref already exists locally.
            let refExists = false;
            try {
                await git(['rev-parse', '--verify', `refs/heads/${BOARD_SNAPSHOT_REF}`]);
                refExists = true;
            } catch { /* ref absent — first publish */ }

            // Create an isolated worktree on the orphan ref. For a first-publish
            // (ref absent), create an orphan worktree via `--orphan` (git 2.42+).
            // Fallback: if --orphan is unsupported, create on a detached HEAD and
            // we'll branch at commit time.
            try {
                if (refExists) {
                    const { stdout } = await git(['worktree', 'add', '--detach', tmpDir, BOARD_SNAPSHOT_REF]);
                    worktreePath = tmpDir;
                } else {
                    // --orphan requires git >= 2.42. Fall back to detached + empty tree.
                    try {
                        await git(['worktree', 'add', '--orphan', '-b', BOARD_SNAPSHOT_REF, tmpDir]);
                    } catch {
                        // Older git: create a detached worktree, clear its index, branch at commit.
                        await git(['worktree', 'add', '--detach', tmpDir]);
                        await git(['rm', '-rf', '--cached', '.'], tmpDir);
                    }
                    worktreePath = tmpDir;
                }
            } catch (e) {
                this._log(`worktree add failed: ${e instanceof Error ? e.message : String(e)}`);
                return 'failed';
            }

            // Write the snapshot files into the worktree.
            await fs.promises.writeFile(path.join(worktreePath, 'board.json'), json, 'utf8');
            await fs.promises.writeFile(path.join(worktreePath, 'board.md'), md, 'utf8');

            // Stage + commit in the worktree.
            try {
                await git(['add', 'board.json', 'board.md'], worktreePath);
            } catch (e) {
                this._log(`worktree add stage failed: ${e instanceof Error ? e.message : String(e)}`);
                return 'failed';
            }

            try {
                await git(['commit', '-m', 'switchboard: board snapshot', '--allow-empty'], worktreePath);
            } catch (e) {
                // Nothing to commit — content unchanged since last commit on this ref.
                this._log(`commit skipped: ${e instanceof Error ? e.message : String(e)}`);
                return 'skipped';
            }

            // If the worktree is detached (older-git fallback), create/update the branch ref.
            if (!refExists) {
                try {
                    const { stdout } = await git(['rev-parse', 'HEAD'], worktreePath);
                    const commitSha = stdout.trim();
                    await git(['branch', '-f', BOARD_SNAPSHOT_REF, commitSha]);
                } catch (e) {
                    this._log(`branch -f failed: ${e instanceof Error ? e.message : String(e)}`);
                    // continue — the commit exists in the worktree's HEAD; push may still work
                }
            }

            // Force-push: orphan branches don't fast-forward from main. If there's no
            // 'origin' remote, treat as 'skipped' (local-only snapshot is still valid).
            let hasOrigin = false;
            try {
                const { stdout } = await git(['remote']);
                hasOrigin = stdout.split('\n').map(r => r.trim()).includes('origin');
            } catch { /* no remotes */ }
            if (!hasOrigin) {
                this._log(`No 'origin' remote — snapshot committed locally to ${BOARD_SNAPSHOT_REF} only`);
                return 'pushed';
            }

            try {
                await git(['push', '--force', 'origin', BOARD_SNAPSHOT_REF]);
                this._log(`Pushed board snapshot to ${BOARD_SNAPSHOT_REF}`);
                return 'pushed';
            } catch (e) {
                this._log(`push failed: ${e instanceof Error ? e.message : String(e)}`);
                return 'failed';
            }
        } finally {
            // Remove the isolated worktree (prune). Never touch the user's branch.
            if (worktreePath) {
                try {
                    await git(['worktree', 'remove', '--force', worktreePath]);
                } catch (e) {
                    this._log(`worktree remove failed: ${e instanceof Error ? e.message : String(e)}`);
                    // Fallback: manual cleanup + prune.
                    try { await fs.promises.rm(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
                    try { await git(['worktree', 'prune']); } catch { /* best-effort */ }
                }
            }
            // Clean up the temp dir wrapper (worktree may have been inside it).
            try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }
}
