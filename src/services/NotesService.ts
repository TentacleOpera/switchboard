import * as fs from 'fs';
import * as path from 'path';
import { v4 as uuidv4 } from 'uuid';

/**
 * NotesService — the file-based Notes store + verb engine.
 *
 * A faithful sibling of the `.switchboard/plans/` store: markdown files with
 * embedded `**Field:**` metadata parsed by regex (NO YAML front-matter, no
 * markdown lib), one file per note under a per-"kind" subdir. Reachable over
 * the LocalApiServer `/notes/verb/<name>` rail via `handleServiceVerb`, and
 * reusable from the standalone bootstrap.
 *
 * Deliberately vscode-free (pure fs/path/uuid) so it stays unit-testable and
 * host-agnostic, mirroring how planMetadataUtils avoids the vscode surface.
 */

/** Metadata for a single note (no body). */
export interface NoteMeta {
    id: string;
    kind: string;
    title: string;
    file: string;
    created: string;
    updated: string;
    tags: string[];
    when?: string;
}

/** A note including its full markdown content. */
export interface NoteFull extends NoteMeta {
    content: string;
}

/** Seeded kinds. Singular `kind` ⇄ plural subdir. Unknown subdirs are tolerated. */
const KIND_TO_DIR: Record<string, string> = { plan: 'plans', meeting: 'meetings', briefing: 'briefings' };
const DIR_TO_KIND: Record<string, string> = { plans: 'plan', meetings: 'meeting', briefings: 'briefing' };
const SEEDED_DIRS = ['plans', 'meetings', 'briefings'];

/** Notes whose `Updated` is older than this many days are flagged stale in the digest. */
const STALE_PLAN_DAYS = 7;
/** Digest bounds — keep the wake-prompt injection compact on a long-lived store. */
const STALE_DIGEST_MAX = 10;      // at most this many stale plan-notes listed
const DIGEST_TITLE_MAX = 120;     // per-title clamp (defensive against a giant title)
const DIGEST_MAX_CHARS = 4000;    // total digest-string clamp

export class NotesService {
    private _defaultWorkspaceRoot?: string;

    constructor(defaultWorkspaceRoot?: string) {
        this._defaultWorkspaceRoot = defaultWorkspaceRoot;
    }

    /**
     * Single dispatch entry point mirroring the plans/verb rail. Returns a
     * `{ success: true, ... }` envelope on success and `{ success: false, error }`
     * on a handled failure (the HTTP layer maps the latter to 502). Throws only
     * on truly unexpected errors, which the HTTP layer maps to 500.
     */
    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        const p = payload && typeof payload === 'object' ? payload : {};
        switch (verb) {
            case 'list':
                return { success: true, notes: await this.list(p) };
            case 'read': {
                const note = await this.read(p);
                if (!note) return { success: false, error: 'Note not found' };
                return { success: true, note };
            }
            case 'search':
                return { success: true, notes: await this.search(p) };
            case 'write':
                return { success: true, note: await this.write(p) };
            case 'append': {
                const note = await this.append(p);
                if (!note) return { success: false, error: 'Note not found' };
                return { success: true, note };
            }
            case 'delete': {
                const deleted = await this.delete(p);
                if (!deleted) return { success: false, error: 'Note not found' };
                return { success: true, deleted: true, id: String(p.id) };
            }
            case 'upcoming':
                return { success: true, meetings: await this.upcoming(p) };
            case 'digest': {
                const digest = await this.buildDigest(p);
                const upcoming = await this.upcoming({ withinMinutes: p.lookaheadMinutes ?? 1440, workspaceRoot: p.workspaceRoot });
                const recent = await this.list({ limit: p.recentLimit ?? 5, workspaceRoot: p.workspaceRoot });
                return { success: true, digest, upcomingCount: upcoming.length, recentCount: recent.length };
            }
            default:
                return { success: false, error: `Unknown notes verb: ${verb}` };
        }
    }

    // ── Verbs ────────────────────────────────────────────────────────────────

    public async list(payload: any = {}): Promise<NoteMeta[]> {
        const root = this._resolveRoot(payload);
        const dirs = payload.kind ? [this._subdirForKind(payload.kind)] : await this._listSubdirs(root);
        let metas: NoteMeta[] = [];
        for (const dir of dirs) {
            metas = metas.concat(await this._readDir(root, dir, false) as NoteMeta[]);
        }
        metas.sort((a, b) => b.updated.localeCompare(a.updated));
        const limit = this._toPositiveInt(payload.limit);
        return limit ? metas.slice(0, limit) : metas;
    }

    public async read(payload: any = {}): Promise<NoteFull | null> {
        const root = this._resolveRoot(payload);
        const id = String(payload.id || '').trim();
        if (!id) return null;
        const found = await this._findById(root, id);
        return found ? found.note : null;
    }

    public async search(payload: any = {}): Promise<NoteMeta[]> {
        const root = this._resolveRoot(payload);
        const query = String(payload.query || '').toLowerCase().trim();
        const dirs = payload.kind ? [this._subdirForKind(payload.kind)] : await this._listSubdirs(root);
        let hits: NoteFull[] = [];
        for (const dir of dirs) {
            hits = hits.concat(await this._readDir(root, dir, true) as NoteFull[]);
        }
        const matched = query
            ? hits.filter(n =>
                n.title.toLowerCase().includes(query) ||
                n.tags.join(',').toLowerCase().includes(query) ||
                n.content.toLowerCase().includes(query))
            : hits;
        matched.sort((a, b) => b.updated.localeCompare(a.updated));
        const limit = this._toPositiveInt(payload.limit);
        const capped = limit ? matched.slice(0, limit) : matched;
        return capped.map(this._stripContent);
    }

    public async write(payload: any = {}): Promise<NoteMeta> {
        const root = this._resolveRoot(payload);
        const title = String(payload.title || '').trim();
        if (!title) throw new Error('write requires a title');
        if (!payload.kind) throw new Error('write requires a kind');

        const subdir = this._subdirForKind(payload.kind);
        const kind = this._kindForSubdir(subdir);
        const now = new Date().toISOString();

        // SECURITY: the id is interpolated raw into the filename below, and
        // path.join normalizes `..`, so an unsanitized id (`../../../plans/x`)
        // would escape `.switchboard/notes/` — worst case landing a file where
        // the plan watcher ingests it (fake-plan injection). Reject anything that
        // is not a plain id token; a real uuid is a subset of [A-Za-z0-9_-].
        const rawId = String(payload.id || '').trim();
        if (rawId && !this._isSafeId(rawId)) {
            throw new Error(`Invalid note id (path traversal rejected): ${rawId}`);
        }
        const id = rawId || uuidv4();
        let created = now;
        let existing: { file: string; created: string } | undefined;
        if (rawId) {
            const found = await this._findById(root, id);
            if (found) {
                created = found.note.created || now;
                existing = { file: found.absPath, created };
            }
        }

        const tags = this._normalizeTags(payload.tags);
        const when = subdir === 'meetings' ? this._normalizeWhen(payload.when) : undefined;
        const body = typeof payload.body === 'string' ? payload.body : '';

        const meta: NoteMeta = {
            id, kind, title,
            file: '',
            created, updated: now,
            tags,
            ...(when ? { when } : {})
        };
        const notesRoot = this._notesRoot(root);
        const absPath = path.join(notesRoot, subdir, `${this._slug(title)}-${id}.md`);
        // Belt-and-suspenders: even with the id sanitized, assert the resolved
        // target is inside the notes store before touching the filesystem, so no
        // future gap in slug/subdir derivation can be turned into an escape.
        const resolved = path.resolve(absPath);
        if (resolved !== path.resolve(notesRoot) && !resolved.startsWith(path.resolve(notesRoot) + path.sep)) {
            throw new Error(`Refusing to write a note outside the notes store: ${resolved}`);
        }
        meta.file = path.relative(root, absPath);

        await fs.promises.mkdir(path.dirname(absPath), { recursive: true });
        await fs.promises.writeFile(absPath, this.serializeNote(meta, body), 'utf8');

        // A full-replace that moved subdir (kind change) or renamed (title change)
        // leaves the old file orphaned under the same id — remove it.
        if (existing && path.resolve(existing.file) !== resolved) {
            try {
                await fs.promises.unlink(existing.file);
            } catch (err: any) {
                // ENOENT just means the old file was already gone — benign. Any
                // other error (EACCES, EPERM, EISDIR…) leaves two files under one
                // id, and _findById would then return the stale first-in-
                // SEEDED_DIRS copy. The new (authoritative) file is already
                // written, so log the orphan rather than silently swallowing it.
                if (!err || err.code !== 'ENOENT') {
                    console.error('[NotesService] failed to remove replaced note file:', existing.file, err);
                }
            }
        }
        return meta;
    }

    public async append(payload: any = {}): Promise<NoteMeta | null> {
        const root = this._resolveRoot(payload);
        const id = String(payload.id || '').trim();
        const text = typeof payload.text === 'string' ? payload.text : '';
        if (!id) return null;
        const found = await this._findById(root, id);
        if (!found) return null;

        const now = new Date().toISOString();
        const meta: NoteMeta = { ...found.note, updated: now };
        const body = found.body ? `${found.body}\n\n${text}` : text;
        await fs.promises.writeFile(found.absPath, this.serializeNote(meta, body), 'utf8');
        return this._stripContent(meta as NoteFull);
    }

    public async delete(payload: any = {}): Promise<boolean> {
        const root = this._resolveRoot(payload);
        const id = String(payload.id || '').trim();
        if (!id) return false;
        const found = await this._findById(root, id);
        if (!found) return false;
        // Delete immediately — no confirmation gate anywhere (hard project rule).
        await fs.promises.unlink(found.absPath);
        return true;
    }

    public async upcoming(payload: any = {}): Promise<NoteMeta[]> {
        const root = this._resolveRoot(payload);
        const within = this._toPositiveInt(payload.withinMinutes) ?? 1440;
        const now = Date.now();
        const horizon = now + within * 60 * 1000;
        const meetings = await this._readDir(root, 'meetings', false) as NoteMeta[];
        return meetings
            .filter(m => {
                if (!m.when) return false;
                const t = Date.parse(m.when);
                return !Number.isNaN(t) && t >= now && t <= horizon;
            })
            .sort((a, b) => Date.parse(a.when as string) - Date.parse(b.when as string));
    }

    /**
     * The compact NOTES DIGEST block — single source of truth for the `digest`
     * verb and (future) orchestrator tick. Returns `''` for an empty/absent store
     * so callers can inject nothing without a special case.
     */
    public async buildDigest(payload: any = {}): Promise<string> {
        const lookahead = this._toPositiveInt(payload.lookaheadMinutes) ?? 1440;
        const recentLimit = this._toPositiveInt(payload.recentLimit) ?? 5;

        const all = await this.list({ workspaceRoot: payload.workspaceRoot });
        if (all.length === 0) return '';

        const upcoming = await this.upcoming({ withinMinutes: lookahead, workspaceRoot: payload.workspaceRoot });
        const recent = all.slice(0, recentLimit);
        const nowMs = Date.now();
        const staleCutoff = nowMs - STALE_PLAN_DAYS * 24 * 60 * 60 * 1000;
        // Oldest-Updated first, then cap — an unbounded list would bloat the wake
        // prompt on a long-lived workspace.
        const staleAll = all
            .filter(n => {
                if (n.kind !== 'plan') return false;
                const t = Date.parse(n.updated);
                return !Number.isNaN(t) && t < staleCutoff;
            })
            .sort((a, b) => Date.parse(a.updated) - Date.parse(b.updated));
        const stale = staleAll.slice(0, STALE_DIGEST_MAX);

        const lines: string[] = [];
        if (upcoming.length) {
            lines.push('Upcoming meetings:');
            for (const m of upcoming) {
                lines.push(`• ${this._formatWhen(m.when as string)} — ${this._clampTitle(m.title)} (id ${this._shortId(m.id)})`);
            }
        }
        if (recent.length) {
            lines.push('Recently changed notes:');
            for (const n of recent) {
                lines.push(`• ${n.kind}: ${this._clampTitle(n.title)} (id ${this._shortId(n.id)}, updated ${this._relTime(n.updated, nowMs)})`);
            }
        }
        if (stale.length) {
            const shown = staleAll.length > stale.length ? ` (showing ${stale.length} of ${staleAll.length})` : '';
            lines.push(`Stale plan-notes${shown} (untouched > ${STALE_PLAN_DAYS}d — consider summarize/reorganize):`);
            for (const n of stale) {
                lines.push(`• ${this._clampTitle(n.title)} (id ${this._shortId(n.id)})`);
            }
        }
        lines.push(`${upcoming.length} upcoming meeting(s), ${recent.length} recent note(s)`);

        // Total-output clamp: the digest is injected verbatim into the wake prompt,
        // so bound it regardless of note count/title length.
        const digest = lines.join('\n');
        if (digest.length > DIGEST_MAX_CHARS) {
            return digest.slice(0, DIGEST_MAX_CHARS).replace(/\s+$/, '') + '\n…(truncated)';
        }
        return digest;
    }

    /** Clamp a title so one giant note can't blow out the digest. */
    private _clampTitle(title: string): string {
        const t = String(title || '');
        return t.length > DIGEST_TITLE_MAX ? t.slice(0, DIGEST_TITLE_MAX - 1) + '…' : t;
    }

    // ── Parse / serialize (mirrors planMetadataUtils' regex style) ─────────────

    /**
     * Parse a note file's embedded `**Field:**` metadata + H1 title + body.
     * `subdir` supplies the authoritative kind (subdir wins over `**Kind:**`).
     */
    public parseNoteMetadata(content: string, subdir: string): Omit<NoteMeta, 'file'> & { body: string } {
        const titleMatch = content.match(/^#\s+(.+)$/m);
        const title = titleMatch ? titleMatch[1].trim() : '(untitled)';
        const id = this._field(content, 'Note ID') || '';
        const created = this._field(content, 'Created') || '';
        const updated = this._field(content, 'Updated') || created;
        const tagsRaw = this._field(content, 'Tags');
        const tags = tagsRaw ? tagsRaw.split(',').map(t => t.trim()).filter(Boolean) : [];
        const when = this._field(content, 'When') || undefined;
        const kind = this._kindForSubdir(subdir);

        const bodyMatch = content.match(/^##\s+Body\s*$/im);
        let body = '';
        if (bodyMatch && bodyMatch.index !== undefined) {
            body = content.slice(bodyMatch.index + bodyMatch[0].length).replace(/^\n+/, '').trimEnd();
        }

        return { id, kind, title, created, updated, tags, ...(when ? { when } : {}), body };
    }

    /** Serialize a note to the canonical `**Field:**` markdown form. */
    public serializeNote(meta: NoteMeta, body: string): string {
        const lines: string[] = [
            `# ${meta.title}`,
            '',
            `**Note ID:** ${meta.id}`,
            `**Kind:** ${meta.kind}`,
            `**Created:** ${meta.created}`,
            `**Updated:** ${meta.updated}`
        ];
        if (meta.tags && meta.tags.length) lines.push(`**Tags:** ${meta.tags.join(', ')}`);
        if (meta.when) lines.push(`**When:** ${meta.when}`);
        lines.push('', '## Body', '', body || '', '');
        return lines.join('\n');
    }

    // ── Internals ──────────────────────────────────────────────────────────────

    private _resolveRoot(payload: any): string {
        const root = String(payload?.workspaceRoot || this._defaultWorkspaceRoot || '').trim();
        if (!root) throw new Error('NotesService: workspaceRoot is required');
        return root;
    }

    private _notesRoot(workspaceRoot: string): string {
        return path.join(workspaceRoot, '.switchboard', 'notes');
    }

    private async _listSubdirs(workspaceRoot: string): Promise<string[]> {
        const root = this._notesRoot(workspaceRoot);
        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(root, { withFileTypes: true });
        } catch {
            // Absent store is tolerated (mirrors plans' absent-dir tolerance).
            return [...SEEDED_DIRS];
        }
        const found = entries.filter(e => e.isDirectory()).map(e => e.name);
        // Include seeded dirs even if not yet created, so a fixed order is stable.
        return Array.from(new Set([...SEEDED_DIRS, ...found]));
    }

    /** Read one subdir's notes. `withContent` includes the full markdown. */
    private async _readDir(workspaceRoot: string, subdir: string, withContent: boolean): Promise<NoteMeta[] | NoteFull[]> {
        const dir = path.join(this._notesRoot(workspaceRoot), subdir);
        let files: string[];
        try {
            files = await fs.promises.readdir(dir);
        } catch {
            return [];
        }
        const out: NoteFull[] = [];
        for (const name of files) {
            if (!name.endsWith('.md')) continue;
            const absPath = path.join(dir, name);
            let content: string;
            try {
                content = await fs.promises.readFile(absPath, 'utf8');
            } catch {
                continue;
            }
            const parsed = this.parseNoteMetadata(content, subdir);
            const meta: NoteFull = {
                id: parsed.id,
                kind: parsed.kind,
                title: parsed.title,
                file: path.relative(workspaceRoot, absPath),
                created: parsed.created,
                updated: parsed.updated,
                tags: parsed.tags,
                ...(parsed.when ? { when: parsed.when } : {}),
                content
            };
            out.push(meta);
        }
        return withContent ? out : out.map(this._stripContent);
    }

    private async _findById(workspaceRoot: string, id: string): Promise<{ note: NoteFull; body: string; absPath: string } | null> {
        const dirs = await this._listSubdirs(workspaceRoot);
        for (const subdir of dirs) {
            const dir = path.join(this._notesRoot(workspaceRoot), subdir);
            let files: string[];
            try {
                files = await fs.promises.readdir(dir);
            } catch {
                continue;
            }
            for (const name of files) {
                if (!name.endsWith('.md')) continue;
                // Fast path: id is encoded in the filename (<slug>-<uuid>.md).
                const filenameMatch = name.endsWith(`-${id}.md`);
                const absPath = path.join(dir, name);
                let content: string;
                try {
                    content = await fs.promises.readFile(absPath, 'utf8');
                } catch {
                    continue;
                }
                const parsed = this.parseNoteMetadata(content, subdir);
                if (filenameMatch || parsed.id === id) {
                    const note: NoteFull = {
                        id: parsed.id || id,
                        kind: parsed.kind,
                        title: parsed.title,
                        file: path.relative(workspaceRoot, absPath),
                        created: parsed.created,
                        updated: parsed.updated,
                        tags: parsed.tags,
                        ...(parsed.when ? { when: parsed.when } : {}),
                        content
                    };
                    return { note, body: parsed.body, absPath };
                }
            }
        }
        return null;
    }

    private _stripContent = (n: NoteFull): NoteMeta => {
        const { content, ...meta } = n;
        return meta;
    };

    private _field(content: string, label: string): string {
        const pattern = new RegExp(`^(?:>\\s+)?\\*\\*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:\\*\\*\\s*(.+)$`, 'im');
        const match = content.match(pattern);
        return match ? match[1].trim() : '';
    }

    private _subdirForKind(kind: string): string {
        const k = String(kind || '').toLowerCase().trim();
        if (KIND_TO_DIR[k]) return KIND_TO_DIR[k];
        // Already a subdir name (plural seeded or a custom kind's own dir).
        return k.replace(/[^a-z0-9_-]/g, '') || 'plans';
    }

    private _kindForSubdir(subdir: string): string {
        return DIR_TO_KIND[subdir] || subdir;
    }

    /** A note id is a plain token (uuids are a subset). No `/`, `\`, `.` — no traversal. */
    private _isSafeId(id: string): boolean {
        return /^[A-Za-z0-9_-]+$/.test(id);
    }

    private _slug(title: string): string {
        return (title || 'untitled').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 60) || 'note';
    }

    private _normalizeTags(raw: any): string[] {
        if (Array.isArray(raw)) return raw.map(t => String(t).trim()).filter(Boolean);
        if (typeof raw === 'string') return raw.split(',').map(t => t.trim()).filter(Boolean);
        return [];
    }

    private _normalizeWhen(raw: any): string | undefined {
        const s = String(raw || '').trim();
        if (!s) return undefined;
        const t = Date.parse(s);
        return Number.isNaN(t) ? undefined : new Date(t).toISOString();
    }

    private _toPositiveInt(raw: any): number | undefined {
        const n = Number(raw);
        return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    }

    private _shortId(id: string): string {
        return (id || '').slice(0, 8);
    }

    private _formatWhen(iso: string): string {
        const t = Date.parse(iso);
        return Number.isNaN(t) ? iso : new Date(t).toISOString().replace('T', ' ').replace(/:\d\d\.\d+Z$/, ' UTC');
    }

    private _relTime(iso: string, nowMs: number): string {
        const t = Date.parse(iso);
        if (Number.isNaN(t)) return iso;
        const mins = Math.max(0, Math.round((nowMs - t) / 60000));
        if (mins < 60) return `${mins}m ago`;
        const hours = Math.round(mins / 60);
        if (hours < 24) return `${hours}h ago`;
        return `${Math.round(hours / 24)}d ago`;
    }
}
