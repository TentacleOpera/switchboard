import * as fs from 'fs';
import * as path from 'path';
import * as cp from 'child_process';
import * as crypto from 'crypto';
import { promisify } from 'util';
import type { KanbanDatabase, KanbanPlanRecord } from './KanbanDatabase';

const execFileAsync = promisify(cp.execFile);

export const BOARD_SNAPSHOT_REF = 'switchboard/board';
export const BOARD_SNAPSHOT_MODE = 'read-only-snapshot';
export const BOARD_SNAPSHOT_MODE_BIDIRECTIONAL = 'shared-board';

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
    device_id?: string;
    user_id?: string;
}

interface BoardSnapshot {
    schema: number;
    ordering: string;
    cards: BoardCardEntry[];
    features: Record<string, string>;
}

/**
 * A single local board mutation, recorded for replay against a fetched
 * remote snapshot in the CAS loop. Bounded by age: intents older than
 * INTENT_MAX_AGE_MS are surfaced (not replayed) because the local DB already
 * holds the resulting state and replaying a stale intent against a moved
 * target is a genuine conflict, not a catch-up.
 */
interface IntentEntry {
    planId: string;
    fromColumn: string;
    toColumn: string;
    timestamp: number;
}

/**
 * Board snapshot publisher — supports two modes:
 *
 * 1. `read-only-snapshot` (original): one-directional, always overwrite,
 *    content-stable via SHA256 hash skip + debounce + single-flight.
 *
 * 2. `shared-board` (bidirectional): CAS (compare-and-swap) publish loop with
 *    intent replay, inbound ingest, per-machine identity, and ref hygiene.
 *    A team that shares a git remote gets a shared board with no account, no
 *    token, no server and no database — git's own ref semantics provide
 *    arbitration.
 *
 * See `.switchboard/plans/git-carried-shared-board-state.md`.
 */
export class BoardSnapshotPublisher {
    private _deps: BoardSnapshotPublisherDeps;
    private _debounceTimer: NodeJS.Timeout | null = null;
    private _inFlight = false;
    private _pending = false;
    private _lastPublishedHash: string | null = null;
    private _intentLog: IntentEntry[] = [];
    private _deviceId: string;
    private _userId: string | null = null;
    private _hygieneTimer: NodeJS.Timeout | null = null;
    private static readonly DEBOUNCE_MS = 500;
    private static readonly INTENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
    private static readonly CAS_MAX_RETRIES = 3;
    private static readonly HYGIENE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours
    private static readonly HYGIENE_MAX_COMMITS = 500;

    constructor(deps: BoardSnapshotPublisherDeps) {
        this._deps = deps;
        this._deviceId = this._generateDeviceId();
    }

    private _generateDeviceId(): string {
        // Stable per-process device ID. Not persisted — a restart gets a new ID,
        // which is fine: the ID exists to distinguish concurrent writers, not to
        // track machines across sessions. A persisted ID would need a migration
        // and a storage location, and the value it adds (recognising your own
        // writes after a restart) is marginal against the cost.
        return crypto.randomBytes(6).toString('hex');
    }

    private _log(msg: string): void {
        (this._deps.log || (() => {}))(`[BoardSnapshotPublisher] ${msg}`);
    }

    /**
     * Set the user identity for snapshot attribution. Called when the
     * attribution system resolves a user. Null means unattributed.
     */
    public setUserId(userId: string | null): void {
        this._userId = userId;
    }

    /**
     * Record a local board mutation for replay in the CAS loop. Called by
     * KanbanDatabase when a card moves between columns. In read-only mode
     * this is a no-op (the intent log is never consulted).
     */
    public recordIntent(planId: string, fromColumn: string, toColumn: string): void {
        if (!this._isBidirectional()) { return; }
        this._intentLog.push({
            planId,
            fromColumn,
            toColumn,
            timestamp: Date.now(),
        });
        // Prune expired intents — they are surfaced, not replayed.
        const cutoff = Date.now() - BoardSnapshotPublisher.INTENT_MAX_AGE_MS;
        this._intentLog = this._intentLog.filter(i => i.timestamp > cutoff);
    }

    private _isBidirectional(): boolean {
        try {
            const KanbanDatabase = require('./KanbanDatabase');
            if (KanbanDatabase.KanbanDatabase._pathConfigProvider) {
                return KanbanDatabase.KanbanDatabase._pathConfigProvider.getConfigString('boardStateExport') === BOARD_SNAPSHOT_MODE_BIDIRECTIONAL;
            }
        } catch { /* outside extension host */ }
        try {
            const vscode = require('vscode');
            const config = vscode.workspace.getConfiguration('switchboard');
            return String(config.get('boardStateExport', 'none')) === BOARD_SNAPSHOT_MODE_BIDIRECTIONAL;
        } catch { /* outside extension host */ }
        return false;
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

            // In bidirectional mode, use the CAS (compare-and-swap) loop: fetch
            // the remote snapshot, replay local intents onto it, push with
            // bounded retries. In read-only mode, use the original force-push.
            const result = this._isBidirectional()
                ? await this._pushSnapshotCAS(root, json, md, html)
                : await this._pushSnapshot(root, json, md, html);
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
                // Identity fields (schema 3, additive). Present only in bidirectional
                // mode so read-only snapshots remain byte-identical to schema 2 for
                // backward compatibility — an old-mode client reading a new-mode ref
                // simply ignores the extra keys.
                ...(this._isBidirectional() ? {
                    device_id: this._deviceId,
                    ...(this._userId ? { user_id: this._userId } : {}),
                } : {}),
            };
        });

        const snapshot: BoardSnapshot = {
            schema: this._isBidirectional() ? 3 : 2,
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
            const maxUpdatedAtMs = plans.reduce((max, p) => {
                const t = p.updatedAt ? new Date(p.updatedAt).getTime() : NaN;
                return Number.isFinite(t) && t > max ? t : max;
            }, -Infinity);
            if (Number.isFinite(maxUpdatedAtMs)) {
                asOf = new Date(maxUpdatedAtMs).toLocaleString('en-US', {
                    timeZone: 'UTC',
                    month: 'short',
                    day: 'numeric',
                    year: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    timeZoneName: 'short',
                });
            }
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

    /**
     * CAS (compare-and-swap) publish loop for bidirectional mode.
     *
     * Fetch the remote ref, replay local intents onto the fetched snapshot,
     * push. On non-fast-forward rejection (someone else's write landed first),
     * re-fetch, re-replay, retry — bounded by CAS_MAX_RETRIES. On exhaustion,
     * surface the failure (the local change survives in the local DB) rather
     * than silently dropping it.
     *
     * The intent replay is the heart of the arbitration: diffing two full
     * snapshots cannot distinguish "I moved this card" from "I have a stale
     * copy of someone else's move", so we replay THIS machine's recorded
     * intents onto the fetched snapshot instead.
     */
    private async _pushSnapshotCAS(root: string, json: string, md: string, html: string): Promise<'pushed' | 'skipped' | 'failed'> {
        const git = (args: string[], cwd: string = root): Promise<{ stdout: string; stderr: string }> =>
            execFileAsync('git', args, { cwd, timeout: 30000 });

        // Check for origin remote first — without it, fall back to local-only.
        let hasOrigin = false;
        try {
            const { stdout } = await git(['remote']);
            hasOrigin = stdout.split('\n').map(r => r.trim()).includes('origin');
        } catch { /* no remotes */ }
        if (!hasOrigin) {
            // No remote — local-only bidirectional mode. Use the standard push
            // (which commits to the local ref) but without force, so a local
            // CAS is still honoured.
            return this._pushSnapshot(root, json, md, html);
        }

        // Fetch the remote ref so we have the latest snapshot to replay onto.
        try {
            await git(['fetch', 'origin', BOARD_SNAPSHOT_REF]);
        } catch (e) {
            this._log(`CAS: fetch failed (continuing with local ref): ${e instanceof Error ? e.message : String(e)}`);
            // Fetch failure is NOT fatal — we may be offline. Use the local ref
            // and attempt the push; if the push is rejected we'll retry.
        }

        for (let attempt = 0; attempt < BoardSnapshotPublisher.CAS_MAX_RETRIES; attempt++) {
            // Read the remote snapshot (if it exists) and replay intents onto it.
            const remoteJson = await this._readRemoteSnapshot(root, git);
            const replayedJson = this._replayIntents(remoteJson, json);

            // Use the standard worktree-based push, but WITHOUT --force.
            const result = await this._pushSnapshotToRef(root, replayedJson, md, html, false);
            if (result === 'pushed') {
                // Success — clear replayed intents.
                this._intentLog = [];
                this._log(`CAS: pushed on attempt ${attempt + 1}`);
                // Schedule ref hygiene after a successful push.
                this._scheduleHygiene();
                return 'pushed';
            }
            if (result === 'skipped') {
                return 'skipped';
            }
            // result === 'failed' — could be a non-fast-forward rejection.
            // Re-fetch and retry.
            this._log(`CAS: attempt ${attempt + 1} failed, retrying...`);
            try {
                await git(['fetch', 'origin', BOARD_SNAPSHOT_REF]);
            } catch { /* best-effort */ }
        }

        // Exhaustion: surface the failure. The local change survives in the
        // local DB; the next successful sync will carry it forward.
        this._log(`CAS: exhausted ${BoardSnapshotPublisher.CAS_MAX_RETRIES} retries — local change preserved, will sync on next successful publish`);
        return 'failed';
    }

    /**
     * Read board.json from the remote ref (or local ref if remote is absent).
     * Returns null if the ref doesn't exist or the file is unreadable.
     */
    private async _readRemoteSnapshot(root: string, git: (args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>): Promise<BoardSnapshot | null> {
        try {
            // Try to read from the remote-tracking ref first, then the local ref.
            let ref = `refs/remotes/origin/${BOARD_SNAPSHOT_REF}`;
            let sha: string | null = null;
            try {
                const { stdout } = await git(['rev-parse', '--verify', ref]);
                sha = stdout.trim();
            } catch {
                // Fall back to local ref.
                ref = `refs/heads/${BOARD_SNAPSHOT_REF}`;
                try {
                    const { stdout } = await git(['rev-parse', '--verify', ref]);
                    sha = stdout.trim();
                } catch { return null; } // ref doesn't exist — first publish
            }
            // Read board.json from the ref without checking out.
            const { stdout } = await git(['show', `${sha}:board.json`]);
            const parsed = JSON.parse(stdout);
            if (parsed && Array.isArray(parsed.cards) && typeof parsed.schema === 'number') {
                return parsed as BoardSnapshot;
            }
            return null;
        } catch {
            return null;
        }
    }

    /**
     * Replay local intents onto a fetched remote snapshot.
     *
     * For each intent (card X moved from column A to column B):
     * - If the card exists in the remote snapshot in column A (or any column),
     *   move it to column B (our change wins for our own card).
     * - If the card was deleted remotely, the deletion wins — drop the intent.
     * - If the card was moved to a third column remotely, last-writer-wins
     *   with our change (we move it to B), which is the honest resolution.
     *
     * If the remote snapshot is null (first publish or unreadable), return
     * the local snapshot as-is — there is nothing to replay onto.
     */
    private _replayIntents(remote: BoardSnapshot | null, localJson: string): string {
        if (!remote || !remote.cards || remote.cards.length === 0) {
            return localJson;
        }

        // Build a map of the remote cards for efficient lookup.
        const remoteCards = new Map<string, BoardCardEntry>();
        for (const c of remote.cards) {
            remoteCards.set(c.plan_id, { ...c });
        }

        // Replay each intent onto the remote snapshot.
        for (const intent of this._intentLog) {
            const card = remoteCards.get(intent.planId);
            if (!card) {
                // Card was deleted remotely — deletion wins. Drop the intent.
                continue;
            }
            // Move the card to our intended column. Last-writer-wins for
            // third-column conflicts — the honest resolution per the plan.
            card.column = intent.toColumn;
            card.device_id = this._deviceId;
            if (this._userId) { card.user_id = this._userId; }
        }

        // Also merge any local cards that are NOT in the remote snapshot
        // (newly created plans that haven't been synced yet).
        let localSnapshot: BoardSnapshot;
        try {
            localSnapshot = JSON.parse(localJson);
        } catch { return localJson; }

        for (const localCard of localSnapshot.cards) {
            if (!remoteCards.has(localCard.plan_id)) {
                remoteCards.set(localCard.plan_id, { ...localCard });
            }
        }

        // Merge features from both snapshots (local takes precedence for new features).
        const features = { ...remote.features, ...localSnapshot.features };

        const replayed: BoardSnapshot = {
            schema: Math.max(remote.schema || 2, localSnapshot.schema || 2),
            ordering: remote.ordering || localSnapshot.ordering || 'updated_at DESC',
            cards: Array.from(remoteCards.values()),
            features,
        };

        return JSON.stringify(replayed, null, 2);
    }

    /**
     * Push snapshot to the ref with configurable force flag. Shared by both
     * the CAS loop (force=false) and the local-only fallback (force=true).
     */
    private async _pushSnapshotToRef(root: string, json: string, md: string, html: string, force: boolean): Promise<'pushed' | 'skipped' | 'failed'> {
        const git = (args: string[], cwd: string = root): Promise<{ stdout: string; stderr: string }> =>
            execFileAsync('git', args, { cwd, timeout: 30000 });

        const tmpDir = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'sb-board-snapshot-'));
        let worktreePath = '';
        try {
            let refExists = false;
            try {
                await git(['rev-parse', '--verify', `refs/heads/${BOARD_SNAPSHOT_REF}`]);
                refExists = true;
            } catch { /* ref absent — first publish */ }

            try {
                if (refExists) {
                    await git(['worktree', 'add', '--detach', tmpDir, BOARD_SNAPSHOT_REF]);
                    worktreePath = tmpDir;
                } else {
                    try {
                        await git(['worktree', 'add', '--orphan', '-b', BOARD_SNAPSHOT_REF, tmpDir]);
                    } catch {
                        await git(['worktree', 'add', '--detach', tmpDir]);
                        await git(['rm', '-rf', '--cached', '.'], tmpDir);
                    }
                    worktreePath = tmpDir;
                }
            } catch (e) {
                this._log(`worktree add failed: ${e instanceof Error ? e.message : String(e)}`);
                return 'failed';
            }

            await fs.promises.writeFile(path.join(worktreePath, 'board.json'), json, 'utf8');
            await fs.promises.writeFile(path.join(worktreePath, 'board.md'), md, 'utf8');
            await fs.promises.writeFile(path.join(worktreePath, 'board.html'), html, 'utf8');

            try {
                await git(['add', 'board.json', 'board.md', 'board.html'], worktreePath);
            } catch (e) {
                this._log(`stage failed: ${e instanceof Error ? e.message : String(e)}`);
                return 'failed';
            }

            try {
                await git(['commit', '-m', 'switchboard: board snapshot', '--allow-empty'], worktreePath);
            } catch (e) {
                this._log(`commit skipped: ${e instanceof Error ? e.message : String(e)}`);
                return 'skipped';
            }

            if (!refExists) {
                try {
                    const { stdout } = await git(['rev-parse', 'HEAD'], worktreePath);
                    await git(['branch', '-f', BOARD_SNAPSHOT_REF, stdout.trim()]);
                } catch (e) {
                    this._log(`branch -f failed: ${e instanceof Error ? e.message : String(e)}`);
                }
            }

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
                const pushArgs = force
                    ? ['push', '--force', 'origin', BOARD_SNAPSHOT_REF]
                    : ['push', 'origin', BOARD_SNAPSHOT_REF];
                await git(pushArgs);
                this._log(`Pushed board snapshot to ${BOARD_SNAPSHOT_REF}${force ? ' (force)' : ''}`);
                return 'pushed';
            } catch (e) {
                this._log(`push failed: ${e instanceof Error ? e.message : String(e)}`);
                return 'failed';
            }
        } finally {
            if (worktreePath) {
                try {
                    await git(['worktree', 'remove', '--force', worktreePath]);
                } catch (e) {
                    this._log(`worktree remove failed: ${e instanceof Error ? e.message : String(e)}`);
                    try { await fs.promises.rm(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
                    try { await git(['worktree', 'prune']); } catch { /* best-effort */ }
                }
            }
            try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
    }

    /**
     * Ingest a board snapshot from the remote ref and apply the shared tier
     * to the local database. This is the inbound half of the bidirectional
     * mode — the one path allowed to move cards between columns (the
     * file-import path is explicitly forbidden from doing so).
     *
     * Called on focus / manual sync trigger. NOT called on auto-sync drip.
     */
    public async ingest(): Promise<'applied' | 'skipped' | 'failed'> {
        if (!this._isBidirectional()) { return 'skipped'; }
        try {
            const root = this._deps.getWorkspaceRoot();
            if (!root || !fs.existsSync(path.join(root, '.git'))) {
                return 'skipped';
            }

            const git = (args: string[], cwd: string = root): Promise<{ stdout: string; stderr: string }> =>
                execFileAsync('git', args, { cwd, timeout: 30000 });

            // Fetch the remote ref.
            let hasOrigin = false;
            try {
                const { stdout } = await git(['remote']);
                hasOrigin = stdout.split('\n').map(r => r.trim()).includes('origin');
            } catch { /* no remotes */ }
            if (hasOrigin) {
                try {
                    await git(['fetch', 'origin', BOARD_SNAPSHOT_REF]);
                } catch (e) {
                    this._log(`ingest: fetch failed: ${e instanceof Error ? e.message : String(e)}`);
                    return 'failed';
                }
            }

            const snapshot = await this._readRemoteSnapshot(root, git);
            if (!snapshot || !snapshot.cards || snapshot.cards.length === 0) {
                return 'skipped';
            }

            // Apply the shared tier to the local database through a dedicated
            // board-apply route, never the file-import route. The file-import
            // path is forbidden from moving cards between columns; the board
            // snapshot is the one input that legitimately may.
            const workspaceId = await this._deps.getWorkspaceId();
            if (!workspaceId) { return 'skipped'; }

            const db = this._deps.db;
            for (const card of snapshot.cards) {
                try {
                    // Apply the card's column from the shared snapshot. This is
                    // the board-apply path: it moves cards between columns, which
                    // is legitimate for an inbound board snapshot but forbidden
                    // for a file re-import.
                    await db.applyBoardSnapshotCard(workspaceId, card.plan_id, card.column);
                } catch (e) {
                    this._log(`ingest: failed to apply card ${card.plan_id}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }

            this._log(`ingest: applied ${snapshot.cards.length} cards from remote snapshot`);
            return 'applied';
        } catch (e) {
            this._log(`ingest error: ${e instanceof Error ? e.message : String(e)}`);
            return 'failed';
        }
    }

    /**
     * Schedule ref hygiene (periodic squash of the orphan branch). Called
     * after a successful CAS push. The squash collapses the ref's history
     * into a single commit when the commit count exceeds HYGIENE_MAX_COMMITS,
     * preventing unbounded history growth on a busy team.
     */
    private _scheduleHygiene(): void {
        if (this._hygieneTimer) { return; }
        this._hygieneTimer = setTimeout(() => {
            this._hygieneTimer = null;
            void this._runHygiene();
        }, BoardSnapshotPublisher.HYGIENE_INTERVAL_MS);
    }

    /**
     * Run ref hygiene: count commits on the orphan ref and squash if it
     * exceeds the threshold. Squashing replaces the ref's history with a
     * single commit containing the current snapshot — the board state is
     * preserved, the history is not (which is the point: history growth is
     * the cost, and the current snapshot is the authoritative state).
     */
    private async _runHygiene(): Promise<void> {
        try {
            const root = this._deps.getWorkspaceRoot();
            if (!root || !fs.existsSync(path.join(root, '.git'))) { return; }

            const git = (args: string[], cwd: string = root): Promise<{ stdout: string; stderr: string }> =>
                execFileAsync('git', args, { cwd, timeout: 30000 });

            // Count commits on the orphan ref.
            let commitCount = 0;
            try {
                const { stdout } = await git(['rev-list', '--count', BOARD_SNAPSHOT_REF]);
                commitCount = parseInt(stdout.trim(), 10) || 0;
            } catch { return; } // ref doesn't exist

            if (commitCount < BoardSnapshotPublisher.HYGIENE_MAX_COMMITS) { return; }

            this._log(`hygiene: squashing ${commitCount} commits on ${BOARD_SNAPSHOT_REF}`);

            // Squash by creating a new orphan commit with the current tree.
            const tmpDir = await fs.promises.mkdtemp(path.join(require('os').tmpdir(), 'sb-board-hygiene-'));
            let worktreePath = '';
            try {
                await git(['worktree', 'add', '--detach', tmpDir, BOARD_SNAPSHOT_REF]);
                worktreePath = tmpDir;

                // Soft reset to the root commit, then amend — collapses history
                // into one commit while preserving the tree.
                const { stdout: rootSha } = await git(['rev-list', '--max-parents=0', 'HEAD'], worktreePath);
                await git(['reset', '--soft', rootSha.trim()], worktreePath);
                await git(['commit', '--amend', '-m', 'switchboard: board snapshot (squashed for hygiene)'], worktreePath);

                // Force-push the squashed ref.
                let hasOrigin = false;
                try {
                    const { stdout } = await git(['remote']);
                    hasOrigin = stdout.split('\n').map(r => r.trim()).includes('origin');
                } catch { /* no remotes */ }
                if (hasOrigin) {
                    try {
                        await git(['push', '--force', 'origin', BOARD_SNAPSHOT_REF]);
                        this._log(`hygiene: squashed and pushed`);
                    } catch (e) {
                        this._log(`hygiene: push failed: ${e instanceof Error ? e.message : String(e)}`);
                    }
                }
            } finally {
                if (worktreePath) {
                    try { await git(['worktree', 'remove', '--force', worktreePath]); } catch { /* best-effort */ }
                }
                try { await fs.promises.rm(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
            }
        } catch (e) {
            this._log(`hygiene error: ${e instanceof Error ? e.message : String(e)}`);
        }
    }

    /** Clean up timers (called on dispose). */
    public dispose(): void {
        if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
        if (this._hygieneTimer) { clearTimeout(this._hygieneTimer); }
    }
}
