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
    complexity: string;
    planFile: string;
}

interface BoardSnapshot {
    schema: number;
    ordering: string;
    cards: BoardCardEntry[];
    features: Record<string, string>;
}

/**
 * One-directional, read-only board snapshot publisher.
 *
 * Writes `board.json` + `board.md` + `board.html` to the orphan branch `switchboard/board`
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
            const { json, md, hash, html } = this._serialize(plans);
            if (hash === this._lastPublishedHash) {
                return 'skipped';
            }

            const result = await this._pushSnapshot(root, json, md, html);
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

    private _serialize(plans: KanbanPlanRecord[]): { json: string; md: string; hash: string; html: string } {
        const root = this._deps.getWorkspaceRoot();

        const features: Record<string, string> = {};
        for (const p of plans) {
            if (p.isFeature) {
                features[p.planId] = p.topic;
            }
        }

        const entries: BoardCardEntry[] = plans.map(p => {
            const relPlanFile = p.planFile ? path.relative(root, p.planFile).replace(/\\/g, '/') : p.planFile;
            return {
                plan_id: p.planId,
                topic: p.topic,
                column: p.kanbanColumn,
                feature: p.featureId ?? null,
                project: p.project ?? null,
                complexity: p.complexity,
                planFile: relPlanFile,
            };
        });

        const snapshot: BoardSnapshot = {
            schema: 2,
            ordering: 'updated_at DESC',
            cards: entries,
            features,
        };

        const json = JSON.stringify(snapshot, null, 2);

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

        let asOf = '—';
        if (plans.length > 0) {
            const maxUpdatedAt = plans.reduce((max, p) => (p.updatedAt > max ? p.updatedAt : max), plans[0].updatedAt);
            asOf = new Date(maxUpdatedAt).toLocaleString('en-US', {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
                timeZoneName: 'short',
            });
        }

        const html = this._renderBoardHtml(snapshot, asOf);
        return { json, md, hash, html };
    }

    private _htmlEscape(text: string): string {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    private _cardHtml(card: BoardCardEntry, features: Record<string, string>): string {
        const featureLabel = card.feature ? (features[card.feature] || card.feature) : null;
        const badges: string[] = [];
        if (card.complexity && card.complexity !== 'Unknown') {
            badges.push(`<span class="badge complexity">${this._htmlEscape(card.complexity)}</span>`);
        }
        if (featureLabel) {
            badges.push(`<span class="badge feature">${this._htmlEscape(featureLabel)}</span>`);
        }
        if (card.project) {
            badges.push(`<span class="badge project">${this._htmlEscape(card.project)}</span>`);
        }

        const badgesHtml = badges.length ? `<div class="meta">\n${badges.join('\n')}\n</div>` : '';
        return `<article class="card">\n  <h3>${this._htmlEscape(card.topic)}</h3>\n  ${badgesHtml}\n  <div class="plan-file">${this._htmlEscape(card.planFile || '')}</div>\n</article>`;
    }

    private _renderBoardHtml(snapshot: BoardSnapshot, asOf: string): string {
        const columns = new Map<string, BoardCardEntry[]>();
        for (const card of snapshot.cards) {
            const list = columns.get(card.column);
            if (list) {
                list.push(card);
            } else {
                columns.set(card.column, [card]);
            }
        }

        const columnEls: string[] = [];
        for (const [column, cards] of columns) {
            const cardEls = cards.map(c => this._cardHtml(c, snapshot.features)).join('\n');
            columnEls.push(
                `<section class="column">\n<h2>${this._htmlEscape(column)} <span class="count">${cards.length}</span></h2>\n${cardEls}\n</section>`
            );
        }

        const boardContent = columnEls.length
            ? `<div class="board">\n${columnEls.join('\n')}\n</div>`
            : `<p class="empty">No active cards.</p>`;

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Switchboard Board Snapshot</title>
<style>
* { box-sizing: border-box; }
body { margin: 0; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f5f7; color: #172b4d; line-height: 1.5; }
header { padding: 1rem; background: #ffffff; border-bottom: 1px solid #dfe1e6; }
header h1 { margin: 0; font-size: 1.25rem; }
.as-of { color: #5e6c84; font-size: 0.875rem; margin-top: 0.25rem; }
.board { display: flex; gap: 1rem; padding: 1rem; align-items: flex-start; overflow-x: auto; min-height: calc(100vh - 8rem); }
.column { min-width: 280px; flex: 1 1 0; background: #ebecf0; border-radius: 8px; padding: 0.75rem; }
.column h2 { margin: 0 0 0.75rem; font-size: 0.875rem; text-transform: uppercase; color: #5e6c84; display: flex; justify-content: space-between; align-items: center; }
.count { background: #dfe1e6; color: #172b4d; border-radius: 999px; padding: 0.125rem 0.5rem; font-size: 0.75rem; }
.card { background: #ffffff; border-radius: 6px; padding: 0.75rem; margin-bottom: 0.75rem; box-shadow: 0 1px 0 rgba(9,30,66,0.08); word-break: break-word; }
.card h3 { margin: 0 0 0.5rem; font-size: 1rem; font-weight: 600; color: #172b4d; }
.meta { display: flex; flex-wrap: wrap; gap: 0.375rem; margin-bottom: 0.5rem; }
.badge { display: inline-block; font-size: 0.75rem; padding: 0.125rem 0.375rem; border-radius: 4px; background: #e3e9ff; color: #0747a6; }
.badge.complexity { background: #e3fcef; color: #006644; }
.badge.project { background: #fff0b3; color: #7f5f01; }
.plan-file { font-size: 0.75rem; color: #5e6c84; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; margin-top: 0.5rem; word-break: break-all; }
.empty { padding: 2rem 1rem; text-align: center; color: #5e6c84; }
@media (max-width: 640px) {
  .board { flex-direction: column; align-items: stretch; }
  .column { min-width: auto; width: 100%; flex: none; }
}
</style>
</head>
<body>
<header>
  <h1>Switchboard Board Snapshot</h1>
  <div class="as-of">As of ${this._htmlEscape(asOf)} · ${snapshot.cards.length} card${snapshot.cards.length === 1 ? '' : 's'}</div>
</header>
<main>
${boardContent}
</main>
</body>
</html>`;
    }

    private async _pushSnapshot(root: string, json: string, md: string, html: string): Promise<'pushed' | 'skipped' | 'failed'> {
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
            await fs.promises.writeFile(path.join(worktreePath, 'board.html'), html, 'utf8');

            // Stage + commit in the worktree.
            try {
                await git(['add', 'board.json', 'board.md', 'board.html'], worktreePath);
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
