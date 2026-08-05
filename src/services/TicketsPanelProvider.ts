import { HostSeams, createVscodeHostSeams, HostWatchHandle } from './hostSeams';
import { BroadcastHub } from './broadcastHub';
import { TICKETS_VERBS } from '../generated/verbAllowlist';
import { validateVerbPayload } from './verbSchemas';
import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath, pathToFileURL } from 'url';
import { applyThemeBodyClass } from './themeBodyClass';
import { PanelStateStore } from './PanelStateStore';
import { buildWorkspaceItems } from './workspaceUtils';
import { reviveWithRetention, injectInitialWebviewState } from '../utils/reviveWithRetention';
import { getTicketsHtml } from './headlessPanelHtml';
import { LocalFolderService } from './LocalFolderService';
import { GlobalIntegrationConfigService } from './GlobalIntegrationConfigService';
import {
    SharedUtilityVerbDeps,
    handleOpenExternalUrl,
    handleCopyDiagramPrompt,
    handleRenderMarkdownLive,
    handleCopyToClipboard,
    handleLinearLoadAutomationCatalog
} from './sharedUtilityVerbs';
import { classifyHttpError } from './errorMessages';
import type { TaskViewerProvider } from './TaskViewerProvider';

// Adapter factories for the Tickets panel. Only the sync services and cache
// service are needed for 2b's verb handlers; the docs adapters (Notion, Linear
// docs, ClickUp docs) stay on PlanningPanelProvider. The interface is a subset
// of PlanningPanelAdapterFactories so the same factory map can be passed in.
export interface TicketsPanelAdapterFactories {
    getLinearSyncService: (root: string) => any;
    getClickUpSyncService: (root: string) => any;
    getCacheService: (root: string) => any;
}

export class TicketsPanelProvider {
    public static readonly viewType = 'switchboard.ticketsPanel';

    private _panel?: vscode.WebviewPanel;
    private readonly _extensionUri: vscode.Uri;
    private _disposables: vscode.Disposable[] = [];
    private _context: vscode.ExtensionContext;
    private _stateStore: PanelStateStore;
    private _apiServer?: any;
    private _broadcaster?: BroadcastHub;
    private _hostSeams?: HostSeams;
    private _workspaceRoot?: string;
    private _adapterFactories: TicketsPanelAdapterFactories;
    private _activeTicketsProvider: 'clickup' | 'linear' | null = null;
    // ── 2c: ticket file watcher + cache + delta-pull state ──
    private _ticketsViewWatcher: HostWatchHandle | undefined;
    private _ticketsViewWatcherDebounces: Map<string, NodeJS.Timeout> = new Map();
    private _cacheService: any | undefined;
    private _ticketsCurrentSelection: Map<string, { provider: string; listId?: string; projectId?: string }> = new Map();
    // ── 2d: move-targets cache for fetchMoveTargets (TTL-bounded, per provider) ──
    private _moveTargetsCache = new Map<string, { at: number; targets: Array<{ id: string; name: string; path: string }> }>();
    private static readonly MOVE_TARGETS_TTL_MS = 60_000;
    // ── Plan 4: TaskViewerProvider reference for the ClickUp/Linear config verb
    //    handlers moved out of SetupPanelProvider. The handlers delegate to the
    //    same TaskViewerProvider methods Setup did — the integration config is a
    //    machine-global store addressed by provider name, not by panel.
    private _taskViewerProvider?: TaskViewerProvider;

    constructor(
        extensionUri: vscode.Uri,
        context: vscode.ExtensionContext,
        stateStore: PanelStateStore,
        apiServer?: any,
        adapterFactories?: TicketsPanelAdapterFactories
    ) {
        this._extensionUri = extensionUri;
        this._context = context;
        this._stateStore = stateStore;
        this._apiServer = apiServer;
        this._adapterFactories = adapterFactories || {
            getLinearSyncService: (_root: string) => { throw new Error('Linear sync service not configured for Tickets panel'); },
            getClickUpSyncService: (_root: string) => { throw new Error('ClickUp sync service not configured for Tickets panel'); },
            getCacheService: (_root: string) => { throw new Error('Cache service not configured for Tickets panel'); }
        };
    }

    // ── Plan 4: wired in extension.ts so the moved ClickUp/Linear config verbs
    //    can delegate to the same TaskViewerProvider methods Setup used. ──
    public setTaskViewerProvider(provider: TaskViewerProvider): void {
        this._taskViewerProvider = provider;
    }

    /**
     * Hand this panel the LocalApiServer, which is what makes its pushes reach a
     * BROWSER as well as the editor webview.
     *
     * This method did not exist, and extension.ts constructs the provider with the
     * `apiServer` argument as a literal `undefined` — so `_apiServer` stayed unset for
     * the whole session. BroadcastHub was therefore built with `apiServer: null`, and
     * every `postMessageToWebview` went to the editor webview only. In the browser
     * cockpit that silently deleted every push-shaped reply this panel makes:
     * `ticketsDefaultRoot`, `integrationProviderStates`, the ClickUp hierarchy loads,
     * the ticket listings. Verbs that answer in the HTTP body (fetchRoots) worked,
     * which is exactly why the panel looked alive while reaching no source at all.
     *
     * The sibling panels (Design, Planning, Setup, Kanban) all get this handshake from
     * TaskViewerProvider in two places — when the provider is registered and when the
     * server is created, because either can happen first. Tickets was missing from
     * both. `_apiServer` also feeds the local-asset port (see _buildLocalAssetUrl), so
     * ticket screenshots were losing their origin for the same reason.
     */
    public setApiServer(server: any): void {
        this._apiServer = server;
        this._broadcaster?.setApiServer(server);
    }

    public async handleServiceVerb(verb: string, payload: any): Promise<any> {
        if (!this._broadcaster) {
            this._initTicketsService();
        }
        if (!TICKETS_VERBS.has(verb)) {
            throw new Error(`Unknown Tickets verb: '${verb}'`);
        }
        const validation = validateVerbPayload('tickets', verb, payload);
        if (!validation.ok) {
            throw new Error(`Invalid payload for Tickets verb '${verb}': ${validation.error}`);
        }
        return await this._handleMessage({ ...(payload ?? {}), type: verb });
    }

    private _initTicketsService(): void {
        const workspaceRoot = this._getWorkspaceRoot() || '';
        // The broadcaster is created unconditionally: `scripts/check-push-routing.js`
        // ratchets this file at ZERO raw `webview.postMessage` sends, so there is no
        // fallback path to fall back to. A missing workspace root may leave the host
        // seams unavailable, but it must never leave pushes without a transport.
        if (!this._broadcaster) {
            this._broadcaster = new BroadcastHub({ webview: this._panel?.webview, apiServer: this._apiServer ?? null });
        } else {
            this._broadcaster.setWebview(this._panel?.webview);
        }
        this._hostSeams = workspaceRoot
            ? createVscodeHostSeams(workspaceRoot, this._context.secrets)
            : undefined;
        this._workspaceRoot = workspaceRoot;
    }

    private _getWorkspaceRoots(): string[] {
        return (vscode.workspace.workspaceFolders || []).map(f => f.uri.fsPath);
    }

    private _getWorkspaceRoot(): string | null {
        const folders = vscode.workspace.workspaceFolders;
        if (!folders || folders.length === 0) return null;
        return folders[0].uri.fsPath;
    }

    private _resolveWorkspaceRoot(givenRoot?: string): string | null {
        if (givenRoot) {
            const norm = path.normalize(givenRoot);
            const folders = this._getWorkspaceRoots();
            for (const f of folders) {
                if (path.normalize(f) === norm) {
                    return f;
                }
            }
            return givenRoot;
        }
        return this._getWorkspaceRoot();
    }

    private _pushTo(_panel: vscode.WebviewPanel | undefined, surface: string, message: any): void {
        this._broadcaster?.push(message, surface);
    }

    // Alias matching PlanningPanelProvider's naming so the moved 2c verb handlers
    // can post responses without a rewrite.
    private postMessageToWebview(message: any): void {
        this._pushTo(this._panel, 'tickets', message);
    }

    /**
     * Stamp a reply with the identity of the request that produced it.
     *
     * Every push from this panel is BROADCAST (BroadcastHub → wsHub) to every
     * connected Tickets surface — editor webview and all browser tabs. A reply
     * that does not say which workspace + list/project it answers for is
     * indistinguishable from the receiving panel's own reply, and tickets.js
     * will render it over the top of the correct one. Verified 2026-08-05: a
     * panel showing a 3-ticket list received a foreign 67-ticket payload.
     *
     * `workspaceRoot`/`scopeId` are forced to `undefined` (omitted from JSON)
     * when absent so the frontend predicate can distinguish "reply names no
     * scope" from "reply names a different scope".
     */
    private _scoped(res: any, workspaceRoot: string | null, scopeId?: string): any {
        return { ...res, workspaceRoot: workspaceRoot ?? undefined, scopeId: scopeId ?? undefined };
    }

    /**
     * Public entry point for host-wide broadcasts (theme / scanline / animation
     * changes) that are not replies to a verb. Routes through the broadcaster like
     * every other push, so the browser panel gets them over WS too.
     *
     * Named `postMessage` to match KanbanProvider / DesignPanelProvider /
     * PlanningPanelProvider, which is what `TaskViewerProvider.broadcastToWebviews`
     * calls on each panel it fans out to.
     */
    public postMessage(message: any): void {
        this._pushTo(this._panel, 'tickets', message);
    }

    // ── 2c: Helper methods copied from PlanningPanelProvider (verbatim) ──
    // These support the 8 ticket-file/sync verb handlers moved in this slice.
    // They stay verbatim with PlanningPanelProvider's copies until that panel's
    // ticket code is fully removed in a later cleanup slice.

    private _getAllowedRoots(): Set<string> {
        const roots = this._getWorkspaceRoots();
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
        return allowedRoots;
    }

    private _slugify(text: string): string {
        return text.toString().toLowerCase()
            .replace(/\s+/g, '-')
            .replace(/[^\w\-]+/g, '')
            .replace(/\-\-+/g, '-')
            .replace(/^-+/, '')
            .replace(/-+$/, '');
    }

    private _getTicketDocumentDirs(resolvedRoot: string, provider?: 'clickup' | 'linear'): string[] {
        const dirs: string[] = [];
        const providerDir = provider === 'clickup' ? 'clickup' : 'linear';

        let globalBaseDir = '';
        if (provider) {
            try {
                const config = GlobalIntegrationConfigService.loadConfigSync(provider);
                if (config && config.ticketSaveLocation) {
                    globalBaseDir = config.ticketSaveLocation;
                }
            } catch {}
        }

        if (globalBaseDir) {
            try {
                if (provider === 'clickup') {
                    const clickUp = this._adapterFactories.getClickUpSyncService(resolvedRoot);
                    const h = clickUp.getSelectedHierarchy();
                    const parts = [globalBaseDir, 'clickup', this._slugify(h.spaceName).slice(0, 60)];
                    if (h.folderName) {
                        parts.push(this._slugify(h.folderName).slice(0, 60));
                    }
                    parts.push(this._slugify(h.listName).slice(0, 60));
                    dirs.push(path.join(...parts));
                } else if (provider === 'linear') {
                    const linear = this._adapterFactories.getLinearSyncService(resolvedRoot);
                    const teamName = linear.getTeamName();
                    const projectName = linear.getSelectedProjectName() || '_no-project';
                    dirs.push(path.join(
                        globalBaseDir,
                        'linear',
                        this._slugify(teamName).slice(0, 60),
                        this._slugify(projectName).slice(0, 60)
                    ));
                }
            } catch {
                dirs.push(path.join(globalBaseDir, providerDir));
            }
        }

        let fallbackBaseDir = path.join(resolvedRoot, '.switchboard', 'tickets');
        try {
            if (provider === 'clickup') {
                const clickUp = this._adapterFactories.getClickUpSyncService(resolvedRoot);
                const h = clickUp.getSelectedHierarchy();
                const parts = [fallbackBaseDir, 'clickup', this._slugify(h.spaceName).slice(0, 60)];
                if (h.folderName) {
                    parts.push(this._slugify(h.folderName).slice(0, 60));
                }
                parts.push(this._slugify(h.listName).slice(0, 60));
                dirs.push(path.join(...parts));
            } else if (provider === 'linear') {
                const linear = this._adapterFactories.getLinearSyncService(resolvedRoot);
                const teamName = linear.getTeamName();
                const projectName = linear.getSelectedProjectName() || '_no-project';
                dirs.push(path.join(
                    fallbackBaseDir,
                    'linear',
                    this._slugify(teamName).slice(0, 60),
                    this._slugify(projectName).slice(0, 60)
                ));
            }
        } catch {
            dirs.push(path.join(fallbackBaseDir, providerDir));
        }

        return dirs;
    }

    private async _findTicketFilePath(resolvedRoot: string, provider: string, id: string): Promise<string | null> {
        try {
            if (!this._cacheService) {
                this._cacheService = this._adapterFactories.getCacheService(resolvedRoot);
            }
            const entry = await this._cacheService.getImportBySlugPrefix(`${provider}_${id}`);
            if (entry && entry.filePath && fs.existsSync(entry.filePath)) {
                return entry.filePath;
            }
        } catch { /* fall through to filesystem scan */ }

        const prefix = `${provider}_${id}_`;
        const baseDirs: string[] = [];
        try {
            const config = GlobalIntegrationConfigService.loadConfigSync(provider as any);
            if (config && config.ticketSaveLocation) {
                baseDirs.push(path.join(config.ticketSaveLocation, provider));
            }
        } catch { /* ignore */ }
        const roots = new Set<string>([resolvedRoot, ...this._getAllowedRoots()]);
        for (const root of roots) {
            baseDirs.push(path.join(root, '.switchboard', 'tickets', provider));
        }
        for (const dir of baseDirs) {
            const found = this._scanForTicketFile(dir, prefix);
            if (found) { return found; }
        }
        return null;
    }

    private _scanForTicketFile(dir: string, prefix: string): string | null {
        let entries: import('fs').Dirent[];
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return null; }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                const found = this._scanForTicketFile(full, prefix);
                if (found) { return found; }
            } else if (entry.isFile() && entry.name.startsWith(prefix) && entry.name.endsWith('.md')) {
                return full;
            }
        }
        return null;
    }

    private _ticketSyncStatusFromTimestamps(filePath: string, lastSyncedAt?: string): 'synced' | 'modified' | 'local-only' {
        if (!lastSyncedAt) { return 'local-only'; }
        try {
            const nfs = require('fs') as typeof import('fs');
            const mtimeMs = nfs.statSync(filePath).mtimeMs;
            const lastSyncedMs = Date.parse(lastSyncedAt);
            if (!Number.isFinite(lastSyncedMs)) { return 'local-only'; }
            return mtimeMs > lastSyncedMs + 1000 ? 'modified' : 'synced';
        } catch {
            return 'local-only';
        }
    }

    private _scanLocalTicketFiles(dir: string, provider: string, out: any[], options?: { scopeId?: string; skipSubtasks?: boolean }): void {
        const nfs = require('fs') as typeof import('fs');
        let entries: import('fs').Dirent[];
        try { entries = nfs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                this._scanLocalTicketFiles(fullPath, provider, out, options);
            } else if (entry.isFile() && entry.name.endsWith('.md')) {
                const match = entry.name.match(/^(?:clickup|linear)_([^_]+)_(.+)\.md$/);
                if (!match) { continue; }
                const id = match[1];
                let title = match[2].replace(/-/g, ' ');
                let kanbanColumn = '';
                let dateCreated: string | undefined;
                let assignees: string[] = [];
                let priority: { priority: string; color: string; orderindex: string } | null = null;
                let parentId = '';
                let fileScopeId = '';
                try {
                    const content = nfs.readFileSync(fullPath, 'utf8');
                    const fm = content.match(/^---\n([\s\S]*?)\n---/);
                    if (fm) {
                        const km = fm[1].match(/kanbanColumn:\s*(.+)/); if (km) { kanbanColumn = km[1].trim(); }
                        const cm = fm[1].match(/^created:\s*(.+)$/m); if (cm) { dateCreated = cm[1].trim(); }
                        const am = fm[1].match(/^assignees:\s*(.+)$/m); if (am) { assignees = am[1].split(',').map(s => s.trim()).filter(Boolean); }
                        const pm = fm[1].match(/^parentId:\s*(.+)$/m); if (pm) { parentId = pm[1].trim(); }
                        const idm = fm[1].match(provider === 'clickup' ? /^listId:\s*(.+)$/m : /^projectName:\s*(.+)$/m);
                        if (idm) { fileScopeId = idm[1].trim(); }
                        const prm = fm[1].match(/^priority:\s*(.+)$/m);
                        const prcm = fm[1].match(/^priorityColor:\s*(.+)$/m);
                        const prom = fm[1].match(/^priorityOrderIndex:\s*(.+)$/m);
                        if (prm || prom) {
                            priority = {
                                priority: prm ? prm[1].trim() : '',
                                color: prcm ? prcm[1].trim() : '',
                                orderindex: prom ? prom[1].trim() : ''
                            };
                        }
                    }
                    const h1 = content.match(/^#\s+(.+)$/m);
                    if (h1) { title = h1[1].trim(); }
                } catch { }

                if (options?.skipSubtasks && parentId) { continue; }
                if (options?.scopeId && fileScopeId !== options.scopeId) { continue; }

                if (!dateCreated) {
                    try { dateCreated = nfs.statSync(fullPath).mtime.toISOString(); } catch {}
                }
                out.push({ id, title, status: kanbanColumn || '', filePath: fullPath, url: '', dateCreated, assignees, priority });
            }
        }
    }

    public getTicketsAssetRoots(workspaceRoot: string): string[] {
        const roots: string[] = [];
        try {
            const service = this._getLocalFolderService(workspaceRoot);
            roots.push(...service.getTicketsFolderPaths());
            roots.push(...service.getFolderPaths());
        } catch { /* config unreadable — fall through to the default tickets dir */ }
        if (workspaceRoot) {
            roots.push(path.join(workspaceRoot, '.switchboard', 'tickets'));
        }
        return roots.filter(Boolean);
    }

    private _buildLocalAssetUrl(absPath: string): string | undefined {
        const port: number | undefined = this._apiServer?.getPort?.();
        if (!port) { return undefined; }
        const realOf = (p: string): string | null => {
            try { return fs.realpathSync(p); } catch { return null; }
        };
        const realTarget = realOf(absPath);
        if (!realTarget) { return undefined; }
        const allowed = this._getWorkspaceRoots()
            .flatMap(root => this.getTicketsAssetRoots(root))
            .map(folder => realOf(path.resolve(folder)))
            .filter((f): f is string => !!f);
        const isAllowed = allowed.some(folder =>
            realTarget === folder || realTarget.startsWith(folder + path.sep)
        );
        if (!isAllowed) { return undefined; }
        const root = this._getWorkspaceRoot() || '';
        return `http://127.0.0.1:${port}/design/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(realTarget)}`;
    }

    private _rewriteLocalImagePaths(markdown: string, baseDir: string): string {
        return markdown.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
            const trimmed = url.trim();
            if (/^(https?:|data:|vscode-resource:|vscode-webview-resource:|vscode-webview:)/i.test(trimmed)) {
                return match;
            }
            try {
                let absPath: string;
                if (/^file:\/\/\//i.test(trimmed)) {
                    absPath = fileURLToPath(trimmed);
                } else {
                    absPath = path.resolve(baseDir, trimmed);
                }
                if (!fs.existsSync(absPath)) { return match; }
                const assetUrl = this._buildLocalAssetUrl(absPath);
                if (assetUrl) { return `![${alt}](${assetUrl})`; }
                if (!this._panel) { return match; }
                const webviewUri = this._panel.webview.asWebviewUri(vscode.Uri.file(absPath));
                if (!webviewUri) { return match; }
                return `![${alt}](${webviewUri.toString()})`;
            } catch {
                return match;
            }
        });
    }

    private _setupTicketsViewWatcher(workspaceRoot: string): void {
        if (this._ticketsViewWatcher) {
            try { this._ticketsViewWatcher.dispose(); } catch { }
            this._ticketsViewWatcher = undefined;
        }
        for (const t of this._ticketsViewWatcherDebounces.values()) { clearTimeout(t); }
        this._ticketsViewWatcherDebounces.clear();

        const watchFolders: string[] = [];
        const clickup = GlobalIntegrationConfigService.loadConfigSync('clickup');
        if (clickup?.ticketSaveLocation) {
            watchFolders.push(clickup.ticketSaveLocation);
        }
        const linear = GlobalIntegrationConfigService.loadConfigSync('linear');
        if (linear?.ticketSaveLocation) {
            watchFolders.push(linear.ticketSaveLocation);
        }
        watchFolders.push(path.join(workspaceRoot, '.switchboard/tickets'));

        const handleTicketFileEvent = (filePath: string) => {
            const fileName = path.basename(filePath);
            const match = fileName.match(/^(linear|clickup)_([^_]+)_.*\.md$/);
            if (!match) { return; }
            const [, provider, id] = match;

            const key = filePath;
            const existing = this._ticketsViewWatcherDebounces.get(key);
            if (existing) { clearTimeout(existing); }
            this._ticketsViewWatcherDebounces.set(key, setTimeout(() => {
                this._ticketsViewWatcherDebounces.delete(key);
                try {
                    const nfs = require('fs') as typeof import('fs');
                    const raw = nfs.readFileSync(filePath, 'utf8');
                    const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
                    const h1 = content.match(/^#\s+(.+)$/m);
                    const title = h1 ? h1[1].trim() : id;
                    const displayContent = this._rewriteLocalImagePaths(content, path.dirname(filePath));
                    this.postMessageToWebview({ type: 'ticketFileChanged', provider, id, title, content: displayContent, rawContent: content });
                } catch { }
            }, 300));
        };

        const watchers: HostWatchHandle[] = [];
        for (const folder of watchFolders) {
            if (!fs.existsSync(folder)) { continue; }
            const watcher = this._seams().watcher.watchFolder(folder, (event, filePath) => {
                if (!filePath.endsWith('.md')) { return; }
                handleTicketFileEvent(filePath);
            });
            watchers.push(watcher);
        }

        this._ticketsViewWatcher = {
            dispose: () => watchers.forEach(w => { try { w.dispose(); } catch { } })
        };
        this._disposables.push(this._ticketsViewWatcher);
    }

    // ── 2b infrastructure: host seams, local folder service, auto-sync ──

    private _seams(): HostSeams {
        if (!this._hostSeams) {
            const root = this._getWorkspaceRoot() || '';
            this._hostSeams = root
                ? createVscodeHostSeams(root, this._context.secrets)
                : undefined as unknown as HostSeams;
        }
        return this._hostSeams!;
    }

    private _getLocalFolderService(workspaceRoot: string): LocalFolderService {
        return new LocalFolderService(workspaceRoot);
    }

    private _mapClickUpTaskToSidebar(task: any): any {
        return {
            id: task.id,
            title: task.name,
            identifier: task.id,
            status: task.status?.status || 'Unknown',
            statusColor: task.status?.color || '',
            assignees: task.assignees || [],
            description: task.description?.trim() || 'No description provided.',
            markdownDescription: task.markdownDescription || '',
            list: task.list,
            url: task.url,
            parentId: task.parentId || task.parent || null,
            priority: task.priority || null,
            tags: Array.isArray(task.tags) ? task.tags.map((t: any) => ({
                name: String(t?.name || '').trim(),
                tagFg: String(t?.tag_fg || t?.tagFg || '').trim(),
                tagBg: String(t?.tag_bg || t?.tagBg || '').trim()
            })) : []
        };
    }

    // ── 2d: ClickUp comment/attachment mappers (verbatim from PlanningPanelProvider) ──
    private _mapClickUpComment(comment: any): any {
        // ClickUp returns `date` as a unix-ms timestamp string. The webview renders
        // dates from `createdAt` (ISO) via `.slice(0, 10)`, so convert here — otherwise
        // the date column stays blank (or shows raw timestamp digits).
        let createdAt = '';
        const rawDate = comment.date;
        if (rawDate) {
            const ms = Number(rawDate);
            createdAt = Number.isFinite(ms) ? new Date(ms).toISOString() : String(rawDate);
        }
        return {
            id: comment.id,
            body: comment.comment_text,
            // Webview reads user.name first (Linear shape); ClickUp gives username.
            user: { ...comment.user, name: comment.user?.username || comment.user?.email || '' },
            date: comment.date,
            createdAt
        };
    }

    private _mapClickUpAttachment(attachment: any): any {
        return {
            id: attachment.id,
            url: attachment.url,
            title: attachment.title,
            filename: attachment.filename
        };
    }

    // `column` / `restoredState` are supplied only by `reviveWithRetention`.
    public show(column?: vscode.ViewColumn, restoredState?: any): void {
        const targetColumn = column ?? (vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined);

        if (this._panel) {
            this._panel.reveal(targetColumn);
            return;
        }

        this._panel = vscode.window.createWebviewPanel(
            TicketsPanelProvider.viewType,
            'Tickets',
            column || vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [
                    vscode.Uri.file(path.join(this._context.extensionPath, 'dist')),
                    vscode.Uri.file(path.join(this._context.extensionPath, 'src', 'webview')),
                    vscode.Uri.file(path.join(this._context.extensionPath, 'static')),
                    // The stylesheet's @font-face sources live here. Without this root
                    // asWebviewUri still returns a URL, but the webview refuses to load
                    // it — a silent fall back to the generic sans stack, which is not
                    // distinguishable from "the font-face rule is missing".
                    vscode.Uri.file(path.join(this._context.extensionPath, 'designs'))
                ]
            }
        );

        this._initTicketsService();
        this._panel.webview.html = this._getHtmlForWebview(this._panel.webview);

        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

        this._panel.webview.onDidReceiveMessage(
            async message => {
                try {
                    await this._handleMessage(message);
                } catch (err: any) {
                    console.error('[TicketsPanelProvider] Error handling message:', err);
                }
            },
            null,
            this._disposables
        );

        this._panel.webview.html = injectInitialWebviewState(
            this._getHtmlForWebview(this._panel.webview),
            restoredState
        );
    }

    public async revive(panel: vscode.WebviewPanel, state?: any): Promise<void> {
        // Re-create rather than adopt, so the panel is guaranteed to carry
        // retainContextWhenHidden from creation. The serialized state is forwarded
        // into the new panel's initial HTML.
        await reviveWithRetention(panel, async (col, restoredState) => {
            this.show(col, restoredState);
        }, state);
    }

    private _getHtmlForWebview(webview: vscode.Webview): string {
        // The editor host builds its own HTML: script sources must be `asWebviewUri`
        // values, not the `/static/...` paths the standalone builder emits.
        const nonce = Array.from({ length: 32 }, () =>
            'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(Math.random() * 62)]
        ).join('');
        const cspSource = webview.cspSource;

        const candidates = [
            path.join(this._context.extensionPath, 'dist', 'webview', 'tickets.html'),
            path.join(this._context.extensionPath, 'src', 'webview', 'tickets.html'),
        ];
        let htmlContent = '';
        for (const candidate of candidates) {
            try {
                if (fs.existsSync(candidate)) {
                    htmlContent = fs.readFileSync(candidate, 'utf8');
                    break;
                }
            } catch {
                // Continue to next path
            }
        }
        if (!htmlContent) {
            return '<html><body><h1>Tickets panel HTML not found</h1></body></html>';
        }

        htmlContent = htmlContent.replace(/\{\{NONCE\}\}/g, nonce);
        htmlContent = htmlContent.replace(/\{\{WEBVIEW_CSP_SOURCE\}\}/g, cspSource);

        const asUri = (...segments: string[]) =>
            webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, ...segments)).toString();

        htmlContent = htmlContent.replace(/\{\{SHARED_UTILS_URI\}\}/g, asUri('dist', 'webview', 'sharedUtils.js'));
        htmlContent = htmlContent.replace(/\{\{TICKETS_JS_URI\}\}/g, asUri('dist', 'webview', 'tickets.js'));
        htmlContent = htmlContent.replace(/\{\{MARKDOWN_EDITOR_URI\}\}/g, asUri('dist', 'webview', 'markdownEditor.js'));

        // The stylesheet's @font-face rules. The standalone host already substitutes
        // both (headlessPanelHtml.ts getTicketsHtml), so the browser panel was never
        // affected — but the editor webview left them unreplaced, which resolves to a
        // literal `{{HANKEN_FONT_URI}}` request, no font, and a silent fall back to
        // the generic sans stack while every other panel renders Hanken Grotesk.
        // font-src in this panel's CSP is already {{WEBVIEW_CSP_SOURCE}}, so no CSP
        // change is needed here.
        htmlContent = htmlContent.replace(
            /\{\{GEIST_PIXEL_FONT_URI\}\}/g,
            asUri('designs', 'GeistPixel-Square.woff2')
        );
        htmlContent = htmlContent.replace(
            /\{\{HANKEN_FONT_URI\}\}/g,
            asUri('designs', 'HankenGrotesk-Variable.woff2')
        );

        return applyThemeBodyClass(htmlContent);
    }


    /**
     * Dependency bundle for `sharedUtilityVerbs`. Every push goes to the
     * `tickets` surface — routing these through Planning's push would deliver
     * ticket updates to the wrong panel.
     */
    private _sharedUtilityDeps(fallbackWorkspaceRoot?: string): SharedUtilityVerbDeps {
        return {
            seams: () => this._seams(),
            resolveWorkspaceRoot: (given?: string) => this._resolveWorkspaceRoot(given),
            push: (message: any) => this._pushTo(this._panel, 'tickets', message),
            findTicketFilePath: (root: string, provider: string, id: string) =>
                this._findTicketFilePath(root, provider, id),
            rewriteLocalImagePaths: (content: string, dir: string) =>
                this._rewriteLocalImagePaths(content, dir),
            getTicketDocumentDirs: (root: string, provider: any) =>
                this._getTicketDocumentDirs(root, provider),
            getLinearSyncService: (root: string) => this._adapterFactories.getLinearSyncService(root),
            fallbackWorkspaceRoot
        };
    }


    /**
     * One-time carry-over of `tickets.root` from the PLANNING panel state store.
     *
     * The key shipped in released versions under the planning panel, because the
     * planning panel owned the TICKETS tab. This provider reads its own ('tickets')
     * store, so without this bridge every existing install silently loses its ticket
     * workspace selection on upgrade — the failure the migration exists to prevent.
     *
     * Runs at most once: it writes a `tickets.root.migrated` marker and returns
     * undefined on every later call, so a user who deliberately clears the selection
     * is never re-seeded from the stale planning value.
     */
    private async _migrateTicketsRootFromPlanning(): Promise<string | undefined> {
        if (this._stateStore.getPanelState<boolean>('tickets.root.migrated')) {
            return undefined;
        }
        try {
            const planningStore = new PanelStateStore(this._context.globalState, 'planning');
            const legacyRoot = planningStore.getPanelState<string>('tickets.root');
            await this._stateStore.setPanelState('tickets.root.migrated', true);
            if (!legacyRoot) { return undefined; }
            // Only adopt it if it is still an open workspace folder — a stale path
            // from a workspace the user no longer has open must not win over the
            // first-allowed-root fallback.
            const allowed = buildWorkspaceItems(this._getWorkspaceRoots()).map(i => i.workspaceRoot);
            if (!allowed.includes(legacyRoot)) { return undefined; }
            await this._stateStore.setPanelState('tickets.root', legacyRoot);
            return legacyRoot;
        } catch {
            // A migration must never block the panel from opening.
            return undefined;
        }
    }

    private async _handleMessage(msg: any): Promise<any> {
        const targetPanel = this._panel;

        switch (msg.type) {
            case 'getStatusShowTicketsSetting': {
                const config = vscode.workspace.getConfiguration('switchboard');
                const val = config.get<boolean>('statusBar.showTicketsButton', true);
                const res = { type: 'statusShowTicketsSetting', enabled: val };
                this._pushTo(targetPanel, 'tickets', res);
                return { ...res, success: true };
            }
            case 'setStatusShowTicketsSetting': {
                const config = vscode.workspace.getConfiguration('switchboard');
                await config.update('statusBar.showTicketsButton', msg.enabled === true, vscode.ConfigurationTarget.Global);
                const res = { type: 'statusShowTicketsSetting', enabled: msg.enabled === true };
                this._pushTo(targetPanel, 'tickets', res);
                return { ...res, success: true };
            }
            case 'persistTabState': {
                if (msg.tabKey) {
                    this._stateStore.setPanelState(msg.tabKey, msg.state);
                }
                return { success: true };
            }
            case 'fetchRoots': {
                const items = buildWorkspaceItems(this._getWorkspaceRoots());
                const res = { type: 'rootsFetched', items };
                this._pushTo(targetPanel, 'tickets', res);
                return { ...res, success: true };
            }

            // ── 2b verb handlers: provider switching, ClickUp/Linear hierarchy,
            //    ticket folder management ──

            case 'switchTicketsProvider': {
                const { provider, workspaceRoot } = msg;
                if (workspaceRoot && (provider === 'clickup' || provider === 'linear')) {
                    this._activeTicketsProvider = provider;
                    try {
                        const [clickUpConfig, linearConfig] = await Promise.all([
                            this._adapterFactories.getClickUpSyncService(workspaceRoot).loadConfig(),
                            this._adapterFactories.getLinearSyncService(workspaceRoot).loadConfig()
                        ]);
                        const clickupSetupComplete = clickUpConfig?.setupComplete === true;
                        const linearSetupComplete = linearConfig?.setupComplete === true;
                        this._pushTo(targetPanel, 'tickets', {
                            type: 'integrationProviderStates',
                            clickupSetupComplete,
                            linearSetupComplete,
                            provider
                        });
                    } catch (err) {
                        console.warn('[TicketsPanel] Failed to switch ticket provider:', err);
                    }
                }
                break;
            }

            case 'addTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
                if (!root) break;
                const result = await this._seams().ui.showOpenDialog({
                    openLabel: 'Add Tickets Folder',
                    canSelectFiles: false,
                    canSelectFolders: true,
                    canSelectMany: false
                });
                if (result && result.length > 0) {
                    const service = this._getLocalFolderService(root);
                    await service.addTicketsFolderPath(result[0]);
                    this._pushTo(targetPanel, 'tickets', { type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                }
                break;
            }
            case 'removeTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
                if (!root) break;
                const service = this._getLocalFolderService(root);
                await service.removeTicketsFolderPath(msg.folderPath);
                this._pushTo(targetPanel, 'tickets', { type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'listTicketsFolders': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
                if (!root) break;
                const service = this._getLocalFolderService(root);
                const paths = service.getTicketsFolderPaths();
                const res = { type: 'ticketsFoldersListed', paths, workspaceRoot: root };
                this._pushTo(targetPanel, 'tickets', res);
                return { success: true, ...res };
            }
            case 'saveTicketsFolderPaths': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
                if (!root) break;
                const service = this._getLocalFolderService(root);
                const config = await service.loadFolderPathsConfig();
                config.ticketsFolderPaths = msg.paths || [];
                await service.saveFolderPathsConfig(config);
                this._pushTo(targetPanel, 'tickets', { type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }
            case 'browseTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
                if (!root) break;
                const result = await this._seams().ui.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    openLabel: 'Select Tickets Folder'
                });
                if (result && result.length > 0) {
                    const res = { type: 'browseTicketsFolderResult', path: result[0], workspaceRoot: root };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                }
                return { success: true, type: 'browseTicketsFolderResult', path: null, workspaceRoot: root };
            }
            case 'saveTicketsFolder': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
                if (!root) break;
                const service = this._getLocalFolderService(root);
                const config = await service.loadFolderPathsConfig();
                const folderPath = String(msg.folderPath || '').trim();
                if (folderPath) {
                    config.ticketsFolderPaths = [folderPath];
                } else {
                    config.ticketsFolderPaths = [];
                }
                await service.saveFolderPathsConfig(config);
                this._pushTo(targetPanel, 'tickets', { type: 'ticketsFoldersListed', paths: service.getTicketsFolderPaths(), workspaceRoot: root });
                break;
            }

            case 'linearLoadProject': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    const res = {
                        type: 'linearProjectLoaded',
                        status: 'error',
                        issues: [],
                        message: 'No workspace open.',
                        workspaceRoot: msg.workspaceRoot || undefined
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }

                const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                const config = await linear.loadConfig();
                if (!config?.setupComplete) {
                    const res = {
                        type: 'linearProjectLoaded',
                        status: 'setup-required',
                        issues: [],
                        message: 'Set up Linear in Setup before using the Project tab.',
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }

                try {
                    const issues = await linear.queryIssues({
                        search: typeof msg.search === 'string' ? msg.search : '',
                        stateId: typeof msg.stateId === 'string' ? msg.stateId : '',
                        limit: 100
                    });
                    const excludeNames = config.excludeProjectNames || [];
                    const includeNames = config.includeProjectNames || [];
                    const projectName = includeNames.length === 1 && excludeNames.length === 0
                        ? includeNames[0]
                        : includeNames.length > 0
                            ? `${includeNames.slice(0, 2).join(', ')}${includeNames.length > 2 ? '...' : ''}`
                            : `${config.teamName || 'Configured Linear Team'} (team-wide)`;
                    const res = {
                        type: 'linearProjectLoaded',
                        status: 'loaded',
                        issues,
                        projectName,
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'linearError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
            }
            case 'linearLoadProjects': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    const res = {
                        type: 'linearProjectsLoaded',
                        status: 'error',
                        projects: [],
                        message: 'No workspace open.',
                        workspaceRoot: msg.workspaceRoot || undefined
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }

                const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                const config = await linear.loadConfig();
                if (!config?.setupComplete) {
                    const res = {
                        type: 'linearProjectsLoaded',
                        status: 'setup-required',
                        projects: [],
                        message: 'Set up Linear in Setup before using the Project tab.',
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }

                try {
                    const projects = await linear.getAvailableProjects();
                    const res = {
                        type: 'linearProjectsLoaded',
                        status: 'loaded',
                        projects,
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'linearError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
            }
            case 'linearSaveProjectSelection': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);

                try {
                    const config = await linear.loadConfig();
                    if (config) {
                        config.selectedProjectName = String(msg.projectName || '').trim();
                        await linear.saveConfig(config);
                    }
                } catch (error) {
                    console.error('Failed to save Linear project selection:', error);
                }
                break;
            }

            case 'clickupLoadSpaces': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    const res = {
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const spaces = await clickUp.getSpaces();
                    const res = {
                        type: 'clickupSpacesLoaded',
                        spaces,
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Spaces',
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
            }
            case 'clickupLoadFolders': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    const res = {
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const folders = await clickUp.getFolders(msg.spaceId);
                    const directLists = await clickUp.getLists(msg.spaceId);
                    const res = {
                        type: 'clickupFoldersLoaded',
                        spaceId: msg.spaceId,
                        folders,
                        directLists,
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Folders',
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
            }
            case 'clickupLoadLists': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    const res = {
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const lists = await clickUp.getLists(msg.spaceId, msg.folderId);
                    const res = {
                        type: 'clickupListsLoaded',
                        spaceId: msg.spaceId,
                        folderId: msg.folderId,
                        lists,
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'clickupError',
                        scope: 'hierarchy',
                        error: error instanceof Error ? error.message : 'Failed to load Lists',
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
            }
            case 'invalidateClickUpCache': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) break;
                const cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                cacheService.invalidateTaskCache('clickup');
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                clickUp.clearTaskListIndex();
                break;
            }
            case 'clickupLoadProject': {
                const loadSeq = msg.loadSeq;
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    const res = this._scoped({
                        type: 'clickupProjectLoaded',
                        status: 'error',
                        message: 'No workspace open.',
                        loadSeq
                    }, msg.workspaceRoot || null, undefined);
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }

                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                const config = await clickUp.loadConfig();

                if (!config?.setupComplete) {
                    const res = this._scoped({
                        type: 'clickupProjectLoaded',
                        status: 'setup-required',
                        message: 'ClickUp setup is incomplete. Please complete setup in the Setup panel.',
                        loadSeq
                    }, workspaceRoot, undefined);
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }

                const listId = msg.listId || config.selectedListId;
                if (!listId) {
                    const res = this._scoped({
                        type: 'clickupProjectLoaded',
                        status: 'setup-required',
                        message: 'No list selected. Please select a Space, Folder, and List to view tasks.',
                        loadSeq
                    }, workspaceRoot, undefined);
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }

                try {
                    const cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                    cacheService.invalidateTaskCache('clickup', listId);

                    const tasks = await clickUp.getListTasks(listId, {
                        includeClosed: msg.includeClosed || false,
                        archived: false
                    });

                    const res = this._scoped({
                        type: 'clickupProjectLoaded',
                        status: 'loaded',
                        tasks: tasks.map((t: any) => this._mapClickUpTaskToSidebar(t)),
                        listName: config.selectedListName || 'Unknown List',
                        loadSeq
                    }, workspaceRoot, String(listId));
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = this._scoped({
                        type: 'clickupError',
                        scope: 'project',
                        error: error instanceof Error ? error.message : 'Failed to load ClickUp project',
                        loadSeq
                    }, workspaceRoot, String(listId || ''));
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
            }
            case 'clickupLoadSpaceTags': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const spaceId = String(msg.spaceId || '').trim();
                if (!workspaceRoot || !spaceId) { return { success: false, error: 'Invalid workspace or space id' }; }
                try {
                    const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    const tags = await clickUp.getSpaceTags(spaceId);
                    const res = {
                        type: 'clickupSpaceTagsLoaded',
                        tags,
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'clickupError',
                        scope: 'task',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
            }
            case 'clickupLoadListStatuses': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const listId = String(msg.listId || '').trim();
                if (!workspaceRoot || !listId) { return { success: false, error: 'Invalid workspace or list id' }; }
                try {
                    const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    const statuses = await clickUp.getListStatuses(listId);
                    const res = {
                        type: 'clickupListStatusesLoaded',
                        statuses,
                        listId,
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'clickupError',
                        scope: 'task',
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', res);
                    return { ...res, success: false };
                }
            }
            case 'clickupSaveSpaceSelection': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const config = await clickUp.loadConfig();
                    if (config) {
                        config.selectedSpaceId = String(msg.spaceId || '').trim();
                        config.selectedSpaceName = String(msg.spaceName || '').trim();
                        config.selectedFolderId = '';
                        config.selectedFolderName = '';
                        config.selectedListId = '';
                        config.selectedListName = '';
                        await clickUp.saveConfig(config);
                    }
                } catch (error) {
                    console.error('Failed to save ClickUp space selection:', error);
                }
                break;
            }
            case 'clickupSaveFolderSelection': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const config = await clickUp.loadConfig();
                    if (config) {
                        config.selectedFolderId = String(msg.folderId || '').trim();
                        config.selectedFolderName = String(msg.folderName || '').trim();
                        config.selectedListId = '';
                        config.selectedListName = '';
                        await clickUp.saveConfig(config);
                    }
                } catch (error) {
                    console.error('Failed to save ClickUp folder selection:', error);
                }
                break;
            }
            case 'clickupSaveListSelection': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    break;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const config = await clickUp.loadConfig();
                    if (config) {
                        config.selectedListId = String(msg.listId || '').trim();
                        config.selectedListName = String(msg.listName || '').trim();
                        config.selectedSpaceId = String(msg.spaceId || '').trim();
                        config.selectedSpaceName = String(msg.spaceName || '').trim();
                        config.selectedFolderId = String(msg.folderId || '').trim();
                        config.selectedFolderName = String(msg.folderName || '').trim();
                        await clickUp.saveConfig(config);
                    }
                } catch (error) {
                    console.error('Failed to save ClickUp list selection:', error);
                }
                break;
            }

            // ── 2c verb handlers: ticket file load, sync-status, file watcher, delta pull ──

            case 'setupTicketsWatcher': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (root) { this._setupTicketsViewWatcher(root); }
                break;
            }
            case 'ticketsDefaultRoot': {
                const allRoots = this._getWorkspaceRoots();
                const restoredRoot = await this._migrateTicketsRootFromPlanning()
                    ?? this._stateStore.getPanelState<string>('tickets.root');
                const allowedRoots = buildWorkspaceItems(allRoots).map(item => item.workspaceRoot);
                // 2c: _kanbanProvider fallback dropped — TicketsPanelProvider has no
                // kanban provider seam. The restored-root and first-allowed-root paths
                // cover every real case; the kanban fallback was a legacy bridge from
                // when the planning panel owned tickets.
                let defaultRoot: string | undefined;

                if (restoredRoot && allowedRoots.includes(restoredRoot)) {
                    defaultRoot = restoredRoot;
                } else if (allowedRoots.length > 0) {
                    defaultRoot = allowedRoots[0];
                } else {
                    defaultRoot = allRoots[0];
                }

                let defaultProvider: 'clickup' | 'linear' | null = null;
                try {
                    const probeRoot = defaultRoot || allRoots[0];
                    if (probeRoot) {
                        const [clickUpConfig, linearConfig] = await Promise.all([
                            this._adapterFactories.getClickUpSyncService(probeRoot).loadConfig(),
                            this._adapterFactories.getLinearSyncService(probeRoot).loadConfig()
                        ]);
                        defaultProvider = (clickUpConfig?.setupComplete) ? 'clickup'
                            : (linearConfig?.setupComplete) ? 'linear'
                            : null;
                    }
                } catch {}

                this.postMessageToWebview({
                    type: 'ticketsDefaultRoot',
                    workspaceRoot: defaultRoot,
                    provider: defaultProvider
                });
                break;
            }
            case 'ticketsRootChanged': {
                const allRoots = this._getWorkspaceRoots();
                const root = msg.workspaceRoot;
                if (root && allRoots.includes(root)) {
                    try {
                        const [clickUpConfig, linearConfig] = await Promise.all([
                            this._adapterFactories.getClickUpSyncService(root).loadConfig(),
                            this._adapterFactories.getLinearSyncService(root).loadConfig()
                        ]);
                        const clickupSetupComplete = clickUpConfig?.setupComplete === true;
                        const linearSetupComplete = linearConfig?.setupComplete === true;
                        let activeProvider = this._activeTicketsProvider;
                        if (!activeProvider) {
                            if (clickupSetupComplete && linearSetupComplete) {
                                activeProvider = 'clickup';
                            } else if (clickupSetupComplete) {
                                activeProvider = 'clickup';
                            } else if (linearSetupComplete) {
                                activeProvider = 'linear';
                            }
                            if (activeProvider) {
                                this._activeTicketsProvider = activeProvider;
                            }
                        }
                        const provider = activeProvider || null;
                        this._setupTicketsViewWatcher(root);
                        this.postMessageToWebview({
                            type: 'integrationProviderStates',
                            clickupSetupComplete,
                            linearSetupComplete,
                            provider
                        });
                    } catch (err) {
                        console.warn('[TicketsPanel] Failed to determine integration preference for root:', root, err);
                    }
                }
                break;
            }
            case 'refreshTicketsDelta': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, listId, projectId } = msg;
                if (!workspaceRoot) {
                    return { success: false, error: 'No workspace root resolved', type: 'importAllTicketsComplete', importMode: 'document', provider, listId, projectId };
                }
                this._ticketsCurrentSelection.set(workspaceRoot, { provider, listId, projectId });
                try {
                    if (!this._cacheService) {
                        this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                    }
                    const kanbanDb = (this._cacheService as any)?._kanbanDb;
                    const cursorKey = provider === 'clickup'
                        ? `last_delta_pull_clickup_${listId || ''}`
                        : `last_delta_pull_linear_${projectId || ''}`;

                    const includeClosed = !!msg.includeClosed;
                    const forceFull = includeClosed || !!msg.forceFull;
                    let lastPullIso: string | null = null;
                    if (!forceFull && kanbanDb) {
                        try { lastPullIso = await kanbanDb.getMeta(cursorKey); } catch { /* ignore */ }
                    }
                    const deltaSince = lastPullIso ? new Date(lastPullIso).getTime() : undefined;
                    const deltaSinceIso = lastPullIso || undefined;
                    const isDeltaRefresh = lastPullIso !== null && !forceFull;

                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.importAllTasks',
                        {
                            workspaceRoot,
                            provider,
                            listId,
                            projectId,
                            importMode: 'document',
                            includeClosed,
                            ...(deltaSince !== undefined ? { deltaSince } : {}),
                            ...(deltaSinceIso ? { deltaSinceIso } : {})
                        }
                    );

                    if (result?.success && kanbanDb) {
                        const nowIso = new Date().toISOString();
                        try { await kanbanDb.setMeta(cursorKey, nowIso); } catch { /* ignore */ }
                    }

                    const skippedModified = result?.skippedModified || 0;
                    const errDetail = (result?.errors || []).slice(0, 3)
                        .map((e: any) => `${e.id}: ${e.error}`).join('; ');
                    if (!result?.success) {
                        this._seams().ui.showErrorMessage(`Refresh failed: ${result?.error || 'unknown'}`);
                    } else if (skippedModified > 0) {
                        this._seams().ui.showWarningMessage(
                            `Refreshed ${result.successCount} ticket${result.successCount !== 1 ? 's' : ''}. ${skippedModified} skipped (locally modified — push or discard changes first).`
                        );
                    } else if ((result.failCount || 0) > 0) {
                        this._seams().ui.showWarningMessage(`Refresh: ${result.successCount} updated, ${result.failCount} failed — ${errDetail}`);
                    }

                    const res = {
                        type: 'importAllTicketsComplete',
                        successCount: result.successCount,
                        failCount: result.failCount,
                        deletedCount: result.deletedCount,
                        errors: result.errors,
                        importMode: 'document',
                        workspaceRoot,
                        provider,
                        listId,
                        projectId,
                        isDelta: isDeltaRefresh
                    };
                    this.postMessageToWebview({ ...res, success: result.success });
                    return { ...res, success: !!result.success };
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this._seams().ui.showErrorMessage(`Refresh failed: ${errMsg}`);
                    const res = {
                        type: 'importAllTicketsComplete',
                        error: errMsg,
                        importMode: 'document',
                        workspaceRoot,
                        provider,
                        listId,
                        projectId
                    };
                    this.postMessageToWebview({ ...res, success: false });
                    return { ...res, success: false };
                }
            }
            case 'saveLocalTicketFile': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, content } = msg;
                if (!workspaceRoot || !id || typeof content !== 'string') break;
                let filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                if (!filePath) {
                    try {
                        const importResult: any = await this._seams().commands.executeCommand(
                            'switchboard.importTaskAsDocument',
                            { workspaceRoot, provider, id, includeSubtasks: false }
                        );
                        if (importResult && importResult.success === false) {
                            const errMsg = importResult.error || 'Local document write failed.';
                            this._seams().ui.showErrorMessage(`Save failed: ${errMsg}`);
                            break;
                        }
                        filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                    } catch (importErr) {
                        const errMsg = importErr instanceof Error ? importErr.message : String(importErr);
                        this._seams().ui.showErrorMessage(`Save failed (could not create local file): ${errMsg}`);
                        break;
                    }
                }
                if (!filePath) {
                    this._seams().ui.showErrorMessage('Save failed: could not locate or create the local ticket file.');
                    break;
                }
                try {
                    const nfs = require('fs') as typeof import('fs');
                    const existing = nfs.readFileSync(filePath, 'utf8');
                    const frontmatterMatch = existing.match(/^(---\n[\s\S]*?\n---\n?)/);
                    const frontmatter = frontmatterMatch ? frontmatterMatch[1] : '';
                    nfs.writeFileSync(filePath, frontmatter + content, 'utf8');
                } catch (writeErr) {
                    const errMsg = writeErr instanceof Error ? writeErr.message : String(writeErr);
                    this._seams().ui.showErrorMessage(`Save failed: ${errMsg}`);
                }
                break;
            }
            case 'listLocalTicketFiles': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = (msg.provider as 'clickup' | 'linear') || 'clickup';
                if (!workspaceRoot) {
                    const earlyScopeId = provider === 'clickup'
                        ? String((msg.listId as string) || '').trim() || undefined
                        : String((msg.projectId as string) || '').trim() || undefined;
                    const res = this._scoped({ type: 'localTicketFilesListed', provider, tickets: [] }, msg.workspaceRoot || null, earlyScopeId);
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
                const ticketDirs = this._getTicketDocumentDirs(workspaceRoot, provider);
                const tickets: any[] = [];
                let scopeCoverage: { total: number; hiddenByScope: number; hiddenBySubtask: number } | undefined;

                const scopeId = provider === 'clickup'
                    ? String((msg.listId as string) || '').trim()
                    : String((msg.projectId as string) || '').trim();

                if (!this._cacheService && workspaceRoot) {
                    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                }

                if (this._cacheService) {
                    const kanbanDb = (this._cacheService as any)._kanbanDb;
                    if (kanbanDb) {
                        try {
                            const effectiveWsId = await (this._cacheService as any)._getEffectiveWorkspaceId(undefined);
                            const throttleKey = 'last_ticket_heal_scan_' + effectiveWsId;
                            const lastHealStr = await kanbanDb.getMeta(throttleKey);
                            const lastHeal = lastHealStr ? new Date(lastHealStr).getTime() : 0;
                            const now = Date.now();
                            const twentyFourHours = 24 * 60 * 60 * 1000;

                            let dbTickets = await this._cacheService.getImportedTickets();

                            if (dbTickets.length === 0 || (now - lastHeal > twentyFourHours)) {
                                const scannedTickets: any[] = [];
                                for (const dir of ticketDirs) {
                                    this._scanLocalTicketFiles(dir, provider, scannedTickets);
                                }

                                for (const t of scannedTickets) {
                                    const exists = dbTickets.find((dbT: any) => dbT.slugPrefix === `${provider}_${t.id}`);
                                    if (!exists) {
                                        try {
                                            await this._cacheService.registerImportedTicket(
                                                provider,
                                                t.id,
                                                t.title,
                                                `${provider}_${t.id}`,
                                                t.filePath,
                                                ''
                                            );
                                        } catch (err) {
                                            console.error('[TicketsPanelProvider] failed to backfill ticket:', err);
                                        }
                                    }
                                }
                                await kanbanDb.setMeta(throttleKey, new Date().toISOString());

                                dbTickets = await this._cacheService.getImportedTickets();
                            }

                            let totalCandidates = 0;
                            let hiddenBySubtask = 0;
                            let hiddenByScope = 0;

                            for (const dbT of dbTickets) {
                                if (dbT.sourceId === provider) {
                                    totalCandidates++;
                                    let kanbanColumn = '';
                                    let clickStatus = '';
                                    let parentId = '';
                                    let fileScopeId = '';
                                    let dateCreated: string | undefined;
                                    let syncStatus: 'synced' | 'modified' | 'local-only' = 'local-only';
                                    let assignees: string[] = [];
                                    let priority: { priority: string; color: string; orderindex: string } | null = null;
                                    if (fs.existsSync(dbT.filePath)) {
                                        try {
                                            const content = fs.readFileSync(dbT.filePath, 'utf8');
                                            const fm = content.match(/^---\n([\s\S]*?)\n---/);
                                            if (fm) {
                                                const km = fm[1].match(/kanbanColumn:\s*(.+)/);
                                                if (km) { kanbanColumn = km[1].trim(); }
                                                const sm = fm[1].match(/^status:\s*(.+)$/m);
                                                if (sm) { clickStatus = sm[1].trim(); }
                                                const pm = fm[1].match(/^parentId:\s*(.+)$/m);
                                                if (pm) { parentId = pm[1].trim(); }
                                                const idm = fm[1].match(provider === 'clickup' ? /^listId:\s*(.+)$/m : /^projectName:\s*(.+)$/m);
                                                if (idm) { fileScopeId = idm[1].trim(); }
                                                const cm = fm[1].match(/^created:\s*(.+)$/m);
                                                if (cm) { dateCreated = cm[1].trim(); }
                                                const am = fm[1].match(/^assignees:\s*(.+)$/m);
                                                if (am) { assignees = am[1].split(',').map((s: string) => s.trim()).filter(Boolean); }
                                                const prm = fm[1].match(/^priority:\s*(.+)$/m);
                                                const prcm = fm[1].match(/^priorityColor:\s*(.+)$/m);
                                                const prom = fm[1].match(/^priorityOrderIndex:\s*(.+)$/m);
                                                if (prm || prom) {
                                                    priority = {
                                                        priority: prm ? prm[1].trim() : '',
                                                        color: prcm ? prcm[1].trim() : '',
                                                        orderindex: prom ? prom[1].trim() : ''
                                                    };
                                                }
                                            }
                                            if (!dateCreated) {
                                                try { dateCreated = fs.statSync(dbT.filePath).mtime.toISOString(); } catch {}
                                            }
                                            syncStatus = this._ticketSyncStatusFromTimestamps(dbT.filePath, dbT.lastSyncedAt);
                                        } catch {}
                                    }
                                    if (parentId) {
                                        hiddenBySubtask++;
                                        continue;
                                    }
                                    if (scopeId && fileScopeId !== scopeId) {
                                        hiddenByScope++;
                                        continue;
                                    }
                                    tickets.push({
                                        id: dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, ''),
                                        title: dbT.docName,
                                        status: clickStatus || kanbanColumn || '',
                                        filePath: dbT.filePath,
                                        lastSyncedAt: dbT.lastSyncedAt,
                                        syncStatus,
                                        url: dbT.url || '',
                                        dateCreated,
                                        assignees,
                                        priority
                                    });
                                }
                            }
                            if (scopeId && totalCandidates > 0 && tickets.length === 0) {
                                console.warn(`[TicketsPanelProvider] listLocalTicketFiles scoping hid all candidate files for ${provider} (scopeId: ${scopeId}, total: ${totalCandidates}, hiddenByScope: ${hiddenByScope}, hiddenBySubtask: ${hiddenBySubtask})`);
                                scopeCoverage = { total: totalCandidates, hiddenByScope, hiddenBySubtask };
                            }
                        } catch (err) {
                            console.error('[TicketsPanelProvider] error listing tickets from cache DB:', err);
                        }
                    }
                }

                if (tickets.length === 0) {
                    for (const dir of ticketDirs) {
                        this._scanLocalTicketFiles(dir, provider, tickets, { scopeId, skipSubtasks: true });
                    }
                    if (scopeId && tickets.length === 0) {
                        const probe: any[] = [];
                        for (const dir of ticketDirs) {
                            this._scanLocalTicketFiles(dir, provider, probe, { skipSubtasks: true });
                        }
                        if (probe.length > 0) {
                            console.warn(`[TicketsPanelProvider] listLocalTicketFiles scoping hid all candidate files for ${provider} (scopeId: ${scopeId}, total: ${probe.length}, hiddenByScope: ${probe.length}, hiddenBySubtask: 0) [fallback scan]`);
                            scopeCoverage = { total: probe.length, hiddenByScope: probe.length, hiddenBySubtask: 0 };
                        }
                    }
                }

                const res = this._scoped({ type: 'localTicketFilesListed', provider, tickets, ...(scopeCoverage ? { scopeCoverage } : {}) }, workspaceRoot, scopeId || undefined);
                this.postMessageToWebview(res);
                return { success: true, ...res };
            }
            case 'getTicketSyncStatuses': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = (msg.provider as 'clickup' | 'linear') || 'clickup';
                const ids: string[] = msg.ids || [];
                const syncScopeId = provider === 'clickup'
                    ? String((msg.listId as string) || '').trim() || undefined
                    : String((msg.projectId as string) || '').trim() || undefined;
                if (!workspaceRoot || ids.length === 0) {
                    return { success: false, error: 'Missing workspaceRoot or ids', ...this._scoped({ type: 'ticketSyncStatusesLoaded', provider, statuses: {} }, workspaceRoot, syncScopeId) };
                }
                if (!this._cacheService && workspaceRoot) {
                    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                }
                if (!this._cacheService) {
                    return { success: false, error: 'No cache service', ...this._scoped({ type: 'ticketSyncStatusesLoaded', provider, statuses: {} }, workspaceRoot, syncScopeId) };
                }
                const statuses: Record<string, 'synced' | 'modified' | 'local-only'> = {};
                try {
                    const dbTickets = await this._cacheService.getImportedTickets();
                    for (const id of ids) {
                        const slugPrefix = `${provider}_${id}`;
                        const dbT = dbTickets.find((t: any) => t.slugPrefix === slugPrefix);
                        if (!dbT || !fs.existsSync(dbT.filePath)) { statuses[id] = 'local-only'; continue; }
                        statuses[id] = this._ticketSyncStatusFromTimestamps(dbT.filePath, dbT.lastSyncedAt);
                    }
                } catch (err) {
                    console.error('[TicketsPanelProvider] getTicketSyncStatuses error:', err);
                }
                const res = this._scoped({ type: 'ticketSyncStatusesLoaded', provider, statuses }, workspaceRoot, syncScopeId);
                this.postMessageToWebview(res);
                return { success: true, ...res };
            }
            case 'readLocalTicketFile': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider as 'clickup' | 'linear';
                const id = msg.id;
                if (!workspaceRoot || !provider || !id) {
                    const res = { type: 'localTicketFileRead', provider, id, success: false };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
                const filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                if (!filePath) {
                    const res = { type: 'localTicketFileRead', provider, id, success: false };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
                try {
                    const raw = fs.readFileSync(filePath, 'utf8');
                    const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
                    const h1 = content.match(/^#\s+(.+)$/m);
                    const title = h1 ? h1[1].trim() : id;
                    const displayContent = this._rewriteLocalImagePaths(content, path.dirname(filePath));
                    const res = { type: 'localTicketFileRead', provider, id, success: true, title, content: displayContent, rawContent: content };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                } catch {
                    const res = { type: 'localTicketFileRead', provider, id, success: false };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }

            // ── 2d: ticket detail + mutation verbs moved from PlanningPanelProvider ──

            case 'linearLoadTaskDetails': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                if (!workspaceRoot || !issueId) {
                    const res = {
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: 'Select a Linear issue first.',
                        workspaceRoot: workspaceRoot || msg.workspaceRoot || undefined
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }

                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    const issue = await linear.getIssue(issueId);
                    let subtasks: any[] = [];
                    let comments: any[] = [];
                    let attachments: any[] = [];
                    if (issue) {
                        try { subtasks = await linear.getSubtasks(issueId); } catch (e) {
                            console.warn('[TicketsPanel] Failed to load Linear subtasks:', e);
                        }
                        try { comments = await linear.getComments(issueId); } catch (e) {
                            console.warn('[TicketsPanel] Failed to load Linear comments:', e);
                        }
                        try { attachments = await linear.getAttachments(issueId); } catch (e) {
                            console.warn('[TicketsPanel] Failed to load Linear attachments:', e);
                        }
                    }

                    if (!issue) {
                        const res = {
                            type: 'linearError',
                            scope: 'task',
                            issueId,
                            error: `This Linear issue could not be found. It may have been deleted, or your token may lack access to it.`,
                            kind: 'deleted',
                            workspaceRoot
                        };
                        this.postMessageToWebview(res);
                        return { ...res, success: false };
                    }

                    let renderedDescriptionHtml = '';
                    const descriptionMd = (issue.description || '').trim() || 'No description provided.';
                    try {
                        renderedDescriptionHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
                    } catch {
                        renderedDescriptionHtml = '';
                    }

                    const res = {
                        type: 'linearTaskDetailsLoaded',
                        issue,
                        subtasks,
                        comments,
                        attachments,
                        renderedDescriptionHtml,
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                } catch (error: any) {
                    const errMsg = error?.message || String(error);
                    const statusMatch = errMsg.match(/HTTP (\d{3})/);
                    const statusCode = typeof error?.statusCode === 'number'
                        ? error.statusCode
                        : (statusMatch ? Number(statusMatch[1]) : null);
                    const kind = statusCode != null ? classifyHttpError(statusCode) : 'generic';
                    const res = {
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: errMsg,
                        kind,
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }

            case 'clickupLoadTaskDetails': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    const res = {
                        type: 'clickupError',
                        scope: 'task',
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);

                try {
                    const details = await clickUp.getTaskDetails(msg.taskId);

                    let renderedDescriptionHtml = '';
                    const descriptionMd = (details.task.markdownDescription || details.task.description || '').trim() || 'No description provided.';
                    try {
                        renderedDescriptionHtml = await this._seams().commands.executeCommand<string>('markdown.api.render', descriptionMd) || '';
                    } catch {
                        renderedDescriptionHtml = '';
                    }

                    const res = {
                        type: 'clickupTaskDetailsLoaded',
                        task: this._mapClickUpTaskToSidebar(details.task),
                        subtasks: details.subtasks.map((s: any) => this._mapClickUpTaskToSidebar(s)),
                        comments: details.comments.map((c: any) => this._mapClickUpComment(c)),
                        attachments: details.attachments.map((a: any) => this._mapClickUpAttachment(a)),
                        renderedDescriptionHtml,
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                } catch (error: any) {
                    const errMsg = error?.message || String(error);
                    const statusMatch = errMsg.match(/HTTP (\d{3})/);
                    const statusCode = typeof error?.statusCode === 'number'
                        ? error.statusCode
                        : (statusMatch ? Number(statusMatch[1]) : null);
                    const kind = statusCode != null ? classifyHttpError(statusCode) : 'generic';
                    const res = {
                        type: 'clickupError',
                        scope: 'task',
                        taskId: msg.taskId,
                        error: errMsg,
                        kind,
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }
            case 'linearUpdateIssueLabels': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const labelIds = Array.isArray(msg.labelIds) ? msg.labelIds : [];

                if (!workspaceRoot || !issueId) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: 'Invalid issue ID or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    await linear.updateIssueLabels(issueId, labelIds);
                    this.postMessageToWebview({
                        type: 'linearLabelsUpdated',
                        issueId,
                        labelIds,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupUpdateTaskTags': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const rawTags = Array.isArray(msg.tags) ? msg.tags : [];
                const tagNames = rawTags.map((t: any) => typeof t === 'string' ? t : String(t?.name || '')).filter(Boolean);

                if (!workspaceRoot || !taskId) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: 'Invalid task ID or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    await clickUp.updateTask(taskId, { tags: tagNames });
                    this.postMessageToWebview({
                        type: 'clickupTagsUpdated',
                        taskId,
                        tags: tagNames,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'loadTicketAssignees': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider;
                const id = String(msg.id || '').trim();
                let listId = msg.listId ? String(msg.listId).trim() : '';

                if (!workspaceRoot || !id || !provider) {
                    const res = {
                        type: 'ticketAssigneesError',
                        id,
                        provider,
                        error: 'Invalid request parameters.',
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }

                try {
                    let members: any[] = [];
                    if (provider === 'linear') {
                        const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        members = await linear.getTeamMembers();
                    } else if (provider === 'clickup') {
                        const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        if (!listId) {
                            const task = await clickup.getTaskDetails(id);
                            if (task?.list?.id) {
                                listId = task.list.id;
                            }
                        }
                        if (listId) {
                            members = await clickup.getListMembers(listId);
                        }
                    }
                    const res = {
                        type: 'ticketAssigneesLoaded',
                        provider,
                        id,
                        members,
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'ticketAssigneesError',
                        provider,
                        id,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }
            case 'loadTicketMembers': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider;
                let listId = msg.listId ? String(msg.listId).trim() : '';
                if (!workspaceRoot || !provider) {
                    const res = {
                        type: 'ticketMembersError',
                        provider,
                        error: 'Invalid request parameters.',
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
                try {
                    let members: any[] = [];
                    if (provider === 'linear') {
                        const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        members = await linear.getTeamMembers();
                    } else if (provider === 'clickup') {
                        const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        if (listId) {
                            members = await clickup.getListMembers(listId);
                        } else {
                            // No list selected yet — return empty; webview shows "No members available."
                            members = [];
                        }
                    }
                    const res = {
                        type: 'ticketMembersLoaded',
                        provider,
                        members,
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: true };
                } catch (error) {
                    const res = {
                        type: 'ticketMembersError',
                        provider,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }
            case 'linearUpdateIssueAssignee': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const assigneeId = msg.assigneeId === null ? null : String(msg.assigneeId || '').trim();

                if (!workspaceRoot || !issueId) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: 'Invalid issue ID or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    await linear.updateIssueAssignee(issueId, assigneeId);
                    this.postMessageToWebview({
                        type: 'linearAssigneeUpdated',
                        issueId,
                        assigneeId,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupUpdateTaskAssignees': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const currentAssigneeIds = Array.isArray(msg.currentAssigneeIds) ? msg.currentAssigneeIds.map(String) : [];
                const desiredAssigneeIds = Array.isArray(msg.desiredAssigneeIds) ? msg.desiredAssigneeIds.map(String) : [];

                if (!workspaceRoot || !taskId) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: 'Invalid task ID or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                const addIds = desiredAssigneeIds.filter((id: string) => !currentAssigneeIds.includes(id)).map(Number).filter((n: number) => !isNaN(n));
                const remIds = currentAssigneeIds.filter((id: string) => !desiredAssigneeIds.includes(id)).map(Number).filter((n: number) => !isNaN(n));

                if (addIds.length === 0 && remIds.length === 0) {
                    this.postMessageToWebview({
                        type: 'clickupAssigneesUpdated',
                        taskId,
                        assigneeIds: desiredAssigneeIds,
                        noChange: true,
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    await clickup.updateTaskAssignees(taskId, addIds, remIds);
                    this.postMessageToWebview({
                        type: 'clickupAssigneesUpdated',
                        taskId,
                        assigneeIds: desiredAssigneeIds,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'linearUpdateIssuePriority': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const priority = Number(msg.priority);

                if (!workspaceRoot || !issueId || isNaN(priority)) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: 'Invalid issue ID, priority, or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                    await linear.updateIssuePriority(issueId, priority);
                    this.postMessageToWebview({
                        type: 'linearPriorityUpdated',
                        issueId,
                        priority,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearError',
                        scope: 'task',
                        issueId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'clickupUpdateTaskPriority': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const priority = Number(msg.priority);

                if (!workspaceRoot || !taskId || isNaN(priority)) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: 'Invalid task ID, priority, or workspace.',
                        workspaceRoot
                    });
                    break;
                }

                try {
                    const clickup = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                    await clickup.updateTask(taskId, { priority });
                    this.postMessageToWebview({
                        type: 'clickupPriorityUpdated',
                        taskId,
                        priority,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupError',
                        scope: 'task',
                        taskId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'editTicket': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.importTaskAsDocument',
                        { workspaceRoot, provider, id, includeSubtasks: true }
                    );
                    this.postMessageToWebview({
                        type: 'editTicketResult',
                        success: result.success,
                        id,
                        filePath: result.filePath,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'editTicketResult',
                        success: false,
                        id,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'pushTicket': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.pushTicketEdits',
                        { workspaceRoot, provider, id }
                    );
                    if (!result?.success) {
                        // Webview status is silent; surface the real reason natively.
                        this._seams().ui.showErrorMessage(`Push to ${provider} failed: ${result?.error || 'unknown error'}`);
                    }
                    this.postMessageToWebview({
                        type: 'pushTicketResult',
                        success: result.success,
                        id,
                        error: result.error,
                        message: result.message,
                        workspaceRoot
                    });
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this._seams().ui.showErrorMessage(`Push to ${provider} failed: ${errMsg}`);
                    this.postMessageToWebview({
                        type: 'pushTicketResult',
                        success: false,
                        id,
                        error: errMsg,
                        workspaceRoot
                    });
                }
                break;
            }
            case 'deleteTicketConfirmed': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.deleteTicket',
                        { workspaceRoot, provider, id }
                    );
                    this.postMessageToWebview({
                        type: 'ticketDeleted',
                        success: result.success,
                        id,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'ticketDeleted',
                        success: false,
                        id,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'importTicketSubtasks': {
                // Progressive subtask import: when a parent is opened, embed its
                // subtasks into the parent's file (a `## Subtasks` checklist) so they
                // are persisted locally — rather than mass-importing every subtask as
                // its own file up front. Subtasks already render live in the detail
                // view, so this is a silent, best-effort file enrichment (no editor
                // refresh). Skipped when the file has unpushed local edits — never
                // clobber the user's work.
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider as 'clickup' | 'linear';
                const id = msg.id;
                if (!workspaceRoot || !provider || !id) { return { success: true, enriched: false, reason: 'missing-params' }; }
                const filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                if (!filePath) { return { success: true, enriched: false, reason: 'no-parent-file' }; } // parent isn't a local file yet — nothing to enrich
                try {
                    if (!this._cacheService) {
                        this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                    }
                    const dbTickets = await this._cacheService.getImportedTickets();
                    const entry = dbTickets.find((t: any) => t.slugPrefix === `${provider}_${id}`);
                    if (entry && this._ticketSyncStatusFromTimestamps(filePath, entry.lastSyncedAt) === 'modified') {
                        return { success: true, enriched: false, reason: 'locally-modified' }; // locally modified — leave it alone (subtasks still show in the live detail view)
                    }
                } catch { /* fall through and attempt the enrich */ }
                try {
                    await this._seams().commands.executeCommand(
                        'switchboard.importTaskAsDocument',
                        { workspaceRoot, provider, id, includeSubtasks: true }
                    );
                    return { success: true, enriched: true };
                } catch (e) {
                    console.warn('[TicketsPanel] importTicketSubtasks failed:', e);
                    return { success: false, enriched: false, error: e instanceof Error ? e.message : String(e) };
                }
            }
            case 'fetchMoveTargets': {
                try {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!workspaceRoot) {
                        throw new Error('Workspace root not resolved');
                    }
                    const { provider, ticketId, refresh } = msg;
                    const cached = this._moveTargetsCache.get(provider);
                    if (!refresh && cached && Date.now() - cached.at < TicketsPanelProvider.MOVE_TARGETS_TTL_MS) {
                        const res = { type: 'moveTargetsResult', provider, ticketId, targets: cached.targets };
                        this.postMessageToWebview(res);
                        return { ...res, success: true };
                    }
                    if (provider === 'clickup') {
                        const clickUpService = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        const spaces = await clickUpService.getSpaces();
                        const targets: Array<{ id: string; name: string; path: string }> = [];
                        for (const space of spaces) {
                            const lists = await clickUpService.getLists(space.id);
                            for (const list of lists) {
                                targets.push({ id: list.id, name: list.name, path: `${space.name} / ${list.name}` });
                            }
                            const folders = await clickUpService.getFolders(space.id);
                            for (const folder of folders) {
                                const folderLists = await clickUpService.getLists(space.id, folder.id);
                                for (const list of folderLists) {
                                    targets.push({ id: list.id, name: list.name, path: `${space.name} / ${folder.name} / ${list.name}` });
                                }
                            }
                        }
                        this._moveTargetsCache.set('clickup', { at: Date.now(), targets });
                        const res = { type: 'moveTargetsResult', provider, ticketId, targets };
                        this.postMessageToWebview(res);
                        return { ...res, success: true };
                    } else {
                        const linearService = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        const projects = await linearService.getAvailableProjects();
                        const targets = projects.map((p: { id: string; name: string }) => ({ id: p.id, name: p.name, path: p.name }));
                        this._moveTargetsCache.set('linear', { at: Date.now(), targets });
                        const res = { type: 'moveTargetsResult', provider, ticketId, targets };
                        this.postMessageToWebview(res);
                        return { ...res, success: true };
                    }
                } catch (err) {
                    console.error('[TicketsPanelProvider] Failed to fetch move targets:', err);
                    const res = { type: 'moveTargetsResult', provider: msg.provider, ticketId: msg.ticketId, targets: [], error: String(err) };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }
            case 'moveTicket': {
                try {
                    const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                    if (!workspaceRoot) {
                        throw new Error('Workspace root not resolved');
                    }
                    const { provider, ticketId, targetId } = msg;
                    if (provider === 'clickup') {
                        const clickUpService = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        const result = await clickUpService.moveTask(ticketId, targetId);
                        this.postMessageToWebview({
                            type: 'moveTicketResult',
                            success: true,
                            provider,
                            ticketId,
                            warning: result.warning ?? null,
                            remainsInLists: result.remainsInLists
                        });
                    } else {
                        const linearService = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        await linearService.updateIssueProject(ticketId, targetId);
                        this.postMessageToWebview({ type: 'moveTicketResult', success: true, provider, ticketId, targetId });
                    }
                } catch (err) {
                    console.error('[TicketsPanelProvider] Failed to move ticket:', err);
                    this.postMessageToWebview({ type: 'moveTicketResult', success: false, provider: msg.provider, ticketId: msg.ticketId, error: String(err) });
                }
                break;
            }
            case 'changeTicketStatus': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, statusId } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.changeTicketStatus',
                        { workspaceRoot, provider, id, statusId }
                    );
                    this.postMessageToWebview({
                        type: 'changeTicketStatusResult',
                        success: result.success,
                        id,
                        statusId,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'changeTicketStatusResult',
                        success: false,
                        id,
                        statusId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'convertToSubtask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'subtaskConverted',
                        success: false,
                        error: 'No workspace folder found',
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId
                    });
                    break;
                }
                try {
                    if (msg.provider === 'clickup') {
                        const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                        await clickUp.updateTask(msg.taskId, { parent: msg.parentId });
                    } else if (msg.provider === 'linear') {
                        const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                        await linear.updateIssueParent(msg.taskId, msg.parentId);
                    } else {
                        throw new Error(`Unknown provider: ${msg.provider}`);
                    }
                    this.postMessageToWebview({
                        type: 'subtaskConverted',
                        success: true,
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'subtaskConverted',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId
                    });
                }
                break;
            }

            // ── 2e: comment manager, mention autocomplete and attachment verbs
            //    moved from PlanningPanelProvider. ──
            //    NOTE: submitComment is NOT moved — it serves the live kanban +
            //    project review-comment sidebars (planning.js / project.js post it
            //    and handle commentResult), which route to PlanningPanelProvider.
            case 'ticketAttachImage': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider as 'clickup' | 'linear';
                const id = msg.id;
                const requestId = msg.requestId;
                if (!workspaceRoot || !provider || !id) {
                    this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false });
                    break;
                }
                try {
                    const filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                    if (!filePath) {
                        this._seams().ui.showErrorMessage('Save the ticket once before attaching images.');
                        this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false });
                        break;
                    }
                    const picked = await this._seams().ui.showOpenDialog({
                        canSelectMany: false,
                        openLabel: 'Attach image',
                        filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }
                    });
                    if (!picked || picked.length === 0) {
                        this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false });
                        break;
                    }
                    const srcPath = picked[0];
                    const attachmentsDir = path.join(path.dirname(filePath), 'attachments');
                    fs.mkdirSync(attachmentsDir, { recursive: true });
                    const ext = path.extname(srcPath);
                    const stem = path.basename(srcPath, ext);
                    let destName = `${stem}${ext}`;
                    let counter = 1;
                    while (fs.existsSync(path.join(attachmentsDir, destName))) {
                        destName = `${stem}-${counter}${ext}`;
                        counter++;
                    }
                    fs.copyFileSync(srcPath, path.join(attachmentsDir, destName));
                    this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: true, relativePath: `attachments/${destName}` });
                } catch (err: any) {
                    this._seams().ui.showErrorMessage('Failed to attach image: ' + err.message);
                    this.postMessageToWebview({ type: 'ticketImageAttached', requestId, success: false });
                }
                break;
            }
            case 'postTicketComment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, comment, mentions } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.postTicketComment',
                        { workspaceRoot, provider, id, comment, mentions }
                    );
                    this.postMessageToWebview({
                        type: 'postTicketCommentResult',
                        success: result.success,
                        id,
                        comment,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'postTicketCommentResult',
                        success: false,
                        id,
                        comment,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'loadTicketComments': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.loadTicketComments',
                        { workspaceRoot, provider, id }
                    );
                    const res = {
                        type: 'ticketCommentsLoaded',
                        id,
                        provider,
                        threads: result.threads || [],
                        members: result.members || [],
                        threadingSupported: result.threadingSupported,
                        error: result.error,
                        workspaceRoot
                    };
                    this.postMessageToWebview({ ...res, success: result.success });
                    return { ...res, success: !!result.success };
                } catch (error) {
                    const res = {
                        type: 'ticketCommentsLoaded',
                        success: false,
                        id,
                        provider,
                        threads: [],
                        members: [],
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }
            case 'postTicketReply': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id, commentId, commentText, mentions } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.postTicketReply',
                        { workspaceRoot, provider, id, commentId, commentText, mentions }
                    );
                    this.postMessageToWebview({
                        type: 'postTicketReplyResult',
                        success: result.success,
                        id,
                        commentId,
                        error: result.error,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'postTicketReplyResult',
                        success: false,
                        id,
                        commentId,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'downloadAttachment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, url, filename, ticketId, ticketTitle } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.downloadAttachment',
                        { workspaceRoot, provider, url, filename, ticketId, ticketTitle }
                    );
                    const res = {
                        type: 'attachmentDownloaded',
                        success: result.success,
                        url,
                        filePath: result.filePath,
                        error: result.error,
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: !!result.success };
                } catch (error) {
                    const res = {
                        type: 'attachmentDownloaded',
                        success: false,
                        url,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
            }
            case 'viewAttachments': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, ticketId, attachments } = msg;
                try {
                    let result: any = await this._seams().commands.executeCommand(
                        'switchboard.getAttachmentList',
                        { workspaceRoot, provider, ticketId, attachmentsArray: attachments }
                    );
                    const targetPanel = this._panel;
                    // The webviewUri rewrite requires a live webview (vscode.Uri + webview.asWebviewUri).
                    // Headless / HTTP callers have no webview — skip the rewrite and return the stored
                    // localPath ref shape so the arm stays host-agnostic (contract #3).
                    if (Array.isArray(result) && targetPanel && targetPanel.webview) {
                        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
                        result = result.map((att: any) => {
                            if (att.isDownloaded && att.localPath) {
                                const ext = path.extname(att.localPath).toLowerCase();
                                if (imageExts.includes(ext)) {
                                    const uri = vscode.Uri.file(att.localPath);
                                    att.webviewUri = targetPanel.webview.asWebviewUri(uri).toString();
                                }
                            }
                            return att;
                        });
                    }
                    const okRes = {
                        type: 'attachmentsListResult',
                        success: true,
                        ticketId,
                        attachments: result,
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', okRes);
                    return { ...okRes, success: true };
                } catch (error) {
                    const targetPanel = this._panel;
                    const errRes = {
                        type: 'attachmentsListResult',
                        success: false,
                        ticketId,
                        attachments: [],
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    };
                    this._pushTo(targetPanel, 'tickets', errRes);
                    return { ...errRes, success: false };
                }
            }
            case 'openAttachment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { localPath } = msg;
                try {
                    if (!localPath) {
                        throw new Error('No local path provided');
                    }
                    await this._seams().ui.openExternal(pathToFileURL(localPath).toString());
                    this.postMessageToWebview({
                        type: 'attachmentOpened',
                        success: true,
                        localPath,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'attachmentOpened',
                        success: false,
                        localPath,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                break;
            }
            case 'revealAttachment': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { localPath } = msg;
                try {
                    if (!localPath) {
                        throw new Error('No local path provided');
                    }
                    await this._seams().commands.executeCommand('revealInExplorer', localPath);
                    this.postMessageToWebview({
                        type: 'attachmentRevealed',
                        success: true,
                        localPath,
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'attachmentRevealed',
                        success: false,
                        localPath,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                return;
            }

            // ── 2f: sync / import / create / ask-agent verbs moved from
            //    PlanningPanelProvider. Each carries its handler, its allowlist
            //    entry (via catalog:generate) and its payload schema (moved in
            //    verbSchemas.ts). Bodies are verbatim except console tags. ──

            case 'linearImportTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const issueId = String(msg.issueId || '').trim();
                const includeSubtasks = Boolean(msg.includeSubtasks);
                const mode = msg.mode || 'plan';

                if (!workspaceRoot || !issueId) {
                    this.postMessageToWebview({
                        type: 'linearTaskImported',
                        success: false,
                        error: 'Missing workspace or issue ID',
                        workspaceRoot: workspaceRoot || msg.workspaceRoot || undefined
                    });
                    return;
                }

                try {
                    if (mode === 'document') {
                        await this._seams().commands.executeCommand(
                            'switchboard.importTaskAsDocument',
                            { workspaceRoot, provider: 'linear', id: issueId, includeSubtasks }
                        );
                    } else {
                        await this._seams().commands.executeCommand(
                            'switchboard.importLinearTask',
                            { workspaceRoot, issueId, includeSubtasks }
                        );
                    }
                    this.postMessageToWebview({
                        type: 'linearTaskImported',
                        success: true,
                        workspaceRoot
                    });
                } catch (error) {
                    console.error('[TicketsPanel] Failed to import Linear task:', error);
                    this.postMessageToWebview({
                        type: 'linearTaskImported',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                return;
            }
            case 'clickupImportTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const taskId = String(msg.taskId || '').trim();
                const includeSubtasks = Boolean(msg.includeSubtasks);
                const mode = msg.mode || 'plan';

                if (!workspaceRoot || !taskId) {
                    this.postMessageToWebview({
                        type: 'clickupTaskImported',
                        success: false,
                        error: 'Missing workspace or task ID',
                        workspaceRoot: workspaceRoot || msg.workspaceRoot || undefined
                    });
                    return;
                }

                try {
                    if (mode === 'document') {
                        await this._seams().commands.executeCommand(
                            'switchboard.importTaskAsDocument',
                            { workspaceRoot, provider: 'clickup', id: taskId, includeSubtasks }
                        );
                    } else {
                        await this._seams().commands.executeCommand(
                            'switchboard.importClickUpTask',
                            { workspaceRoot, taskId, includeSubtasks }
                        );
                    }
                    this.postMessageToWebview({
                        type: 'clickupTaskImported',
                        success: true,
                        workspaceRoot
                    });
                } catch (error) {
                    console.error('[TicketsPanel] Failed to import ClickUp task:', error);
                    this.postMessageToWebview({
                        type: 'clickupTaskImported',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                return;
            }
            case 'importAllTickets': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, ids, listId, projectId, workspaceId, page, append, importMode } = msg;
                if (!workspaceRoot) {
                    return { success: false, error: 'No workspace root resolved', type: 'importAllTicketsComplete', importMode, provider, listId, projectId, page };
                }
                // Track the current selection so the auto-sync delta-pull timer
                // knows what to poll.
                if (importMode === 'document' && !ids) {
                    this._ticketsCurrentSelection.set(workspaceRoot, { provider, listId, projectId });
                }
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.importAllTasks',
                        { workspaceRoot, provider, ids, listId, projectId, workspaceId, page, append, importMode }
                    );
                    // Set the per-list delta cursor after a successful full document
                    // import so the next Refresh can do a delta pull instead of
                    // re-fetching the entire list.
                    if (result?.success && importMode === 'document' && !ids) {
                        try {
                            if (!this._cacheService) {
                                this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                            }
                            const kanbanDb = (this._cacheService as any)?._kanbanDb;
                            if (kanbanDb) {
                                const cursorKey = provider === 'clickup'
                                    ? `last_delta_pull_clickup_${listId || ''}`
                                    : `last_delta_pull_linear_${projectId || ''}`;
                                await kanbanDb.setMeta(cursorKey, new Date().toISOString());
                            }
                        } catch { /* non-fatal — cursor is a perf optimization */ }
                    }
                    // Webview status is silent — surface the real outcome natively so
                    // failures aren't invisible (mirrors the ticket-push handler).
                    const errDetail = (result?.errors || []).slice(0, 3)
                        .map((e: any) => `${e.id}: ${e.error}`).join('; ');
                    if (!result?.success) {
                        this._seams().ui.showErrorMessage(`Import all (${importMode}) failed: ${result?.error || 'unknown'}`);
                    } else if ((result.successCount || 0) === 0) {
                        this._seams().ui.showWarningMessage(`Import all (${importMode}): nothing imported (${ids?.length ?? 0} requested${errDetail ? ' — ' + errDetail : ''}).`);
                    } else if ((result.failCount || 0) > 0) {
                        this._seams().ui.showWarningMessage(`Import all (${importMode}): ${result.successCount} imported, ${result.failCount} failed — ${errDetail}`);
                    }
                    const res = {
                        type: 'importAllTicketsComplete',
                        successCount: result.successCount,
                        failCount: result.failCount,
                        errors: result.errors,
                        importMode,
                        workspaceRoot,
                        provider,
                        listId,
                        projectId,
                        page
                    };
                    this.postMessageToWebview({ ...res, success: result.success });
                    return { ...res, success: !!result.success };
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this._seams().ui.showErrorMessage(`Import all (${importMode}) failed: ${errMsg}`);
                    const res = {
                        type: 'importAllTicketsComplete',
                        error: errMsg,
                        importMode,
                        workspaceRoot,
                        provider,
                        listId,
                        projectId,
                        page
                    };
                    this.postMessageToWebview({ ...res, success: false });
                    return { ...res, success: false };
                }
            }
            case 'syncAllTickets': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const provider = msg.provider;
                const results = { succeeded: 0, failed: 0, errors: [] as string[] };

                if (workspaceRoot) {
                    const tickets: any[] = [];
                    for (const dir of this._getTicketDocumentDirs(workspaceRoot, provider)) {
                        if (!fs.existsSync(dir)) { continue; }
                        let files: string[] = [];
                        try { files = fs.readdirSync(dir); } catch { continue; }
                        for (const fileName of files) {
                            const match = fileName.match(/^(linear|clickup)_([^_]+)_(.*)\.md$/);
                            if (!match || match[1] !== provider) { continue; }
                            const filePath = path.join(dir, fileName);
                            try {
                                const content = fs.readFileSync(filePath, 'utf8');
                                tickets.push({ id: match[2], content, filePath });
                            } catch {
                                // ignore read errors
                            }
                        }
                    }

                    // Deduplicate by ticket id — if the same id appears in multiple ticket
                    // document dirs, keep only the first. This prevents a concurrent
                    // hostInlineImages file-write race on the same sourceFilePath.
                    const seenIds = new Set<string>();
                    const uniqueTickets = tickets.filter(t => {
                        if (seenIds.has(t.id)) return false;
                        seenIds.add(t.id);
                        return true;
                    });

                    // Bounded concurrency: push up to 4 tickets at a time so total wall time
                    // is ~ceil(N/4) × per-ticket latency instead of N × per-ticket latency.
                    const CONCURRENCY = 4;
                    let done = 0;
                    const total = uniqueTickets.length;
                    for (let i = 0; i < uniqueTickets.length; i += CONCURRENCY) {
                        const batch = uniqueTickets.slice(i, i + CONCURRENCY);
                        const batchResults = await Promise.all(batch.map(async (ticket) => {
                            try {
                                const result: any = await this._seams().commands.executeCommand(
                                    'switchboard.pushTicketEdits',
                                    { workspaceRoot, provider, id: ticket.id }
                                );
                                return result?.success
                                    ? { ok: true }
                                    : { ok: false, error: `${ticket.id}: ${result?.error || 'Unknown error'}` };
                            } catch (err) {
                                return { ok: false, error: `${ticket.id}: ${err instanceof Error ? err.message : String(err)}` };
                            }
                        }));
                        for (const r of batchResults) {
                            if (r.ok) { results.succeeded++; }
                            else { results.failed++; results.errors.push(r.error ?? 'Unknown error'); }
                        }
                        done += batch.length;
                        this.postMessageToWebview({
                            type: 'syncAllTicketsProgress', done, total
                        });
                    }

                    this.postMessageToWebview({
                        type: 'syncAllTicketsResult',
                        success: results.failed === 0,
                        count: uniqueTickets.length,
                        succeeded: results.succeeded,
                        failed: results.failed,
                        errors: results.errors
                    });
                } else {
                    this.postMessageToWebview({
                        type: 'syncAllTicketsResult',
                        success: false,
                        count: 0,
                        succeeded: 0,
                        failed: 0,
                        errors: ['No workspace root resolved']
                    });
                }
                return;
            }
            case 'clickupCreateTask': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'clickupTaskCreated',
                        success: false,
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    return;
                }
                const clickUp = this._adapterFactories.getClickUpSyncService(workspaceRoot);
                try {
                    let listId = msg.listId;
                    if (msg.parentId) {
                        const parentListId = clickUp.getTaskListId(msg.parentId);
                        if (parentListId) listId = parentListId;
                    }
                    const task = await clickUp.createTask({
                        name: msg.title,
                        listId,
                        description: msg.description,
                        ...(msg.parentId ? { parent: msg.parentId } : {}),
                        ...(msg.status ? { status: String(msg.status) } : {}),
                        ...(typeof msg.priority === 'number' && !isNaN(msg.priority) ? { priority: msg.priority } : {}),
                        ...(Array.isArray(msg.assignees) ? { assignees: msg.assignees.map(Number).filter((n: number) => !isNaN(n)) } : {})
                    });
                    if (task) {
                        // A remote-only ticket diverges from every other ticket in the
                        // tab (which are both local + online). Import it immediately so
                        // the local file + DB entry exist, exactly like the Import button.
                        // Pass the createTask response as preFetchedTask to dodge the
                        // read-after-write lag where a fresh getTaskDetails() returns
                        // null for a just-created task.
                        let importOk = true;
                        let importError: string | undefined;
                        try {
                            const importResult: any = await this._seams().commands.executeCommand(
                                'switchboard.importTaskAsDocument',
                                { workspaceRoot, provider: 'clickup', id: task.id, includeSubtasks: false, preFetchedTask: task }
                            );
                            if (importResult && importResult.success === false) {
                                importOk = false;
                                importError = importResult.error || 'Local document write failed.';
                            }
                        } catch (importErr) {
                            importOk = false;
                            importError = importErr instanceof Error ? importErr.message : String(importErr);
                            console.error('[TicketsPanel] Created ClickUp task but local import failed:', importErr);
                        }
                        this.postMessageToWebview({
                            type: 'clickupTaskCreated',
                            success: importOk,
                            ...(importError ? { error: `Task created remotely, but local file write failed: ${importError}` } : {}),
                            workspaceRoot
                        });
                    } else {
                        this.postMessageToWebview({
                            type: 'clickupTaskCreated',
                            success: false,
                            error: 'Failed to create ClickUp task (empty result).',
                            workspaceRoot
                        });
                    }
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'clickupTaskCreated',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                return;
            }
            case 'linearCreateIssue': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                if (!workspaceRoot) {
                    this.postMessageToWebview({
                        type: 'linearIssueCreated',
                        success: false,
                        error: 'No workspace folder found',
                        workspaceRoot: msg.workspaceRoot || undefined
                    });
                    return;
                }
                const linear = this._adapterFactories.getLinearSyncService(workspaceRoot);
                try {
                    let projectId: string | undefined;
                    if (msg.projectName) {
                        const projects = await linear.getAvailableProjects();
                        const matching = projects.find((p: any) => p.name === msg.projectName || p.id === msg.projectName);
                        if (matching) {
                            projectId = matching.id;
                        } else {
                            projectId = msg.projectName;
                        }
                    }
                    const result = await linear.createIssueSimple({
                        title: msg.title,
                        description: msg.description,
                        projectId,
                        ...(msg.parentId ? { parentId: msg.parentId } : {}),
                        ...(msg.status ? { stateId: String(msg.status) } : {}),
                        ...(typeof msg.priority === 'number' && !isNaN(msg.priority) ? { priority: msg.priority } : {}),
                        ...(msg.assigneeId ? { assigneeId: String(msg.assigneeId) } : {})
                    });
                    // A remote-only ticket diverges from every other ticket in the tab
                    // (which are both local + online). Import it immediately so the local
                    // file + DB entry exist, exactly like the Import button. Pass the
                    // createIssueSimple response + the typed title/description/projectName
                    // as preFetchedTask to dodge the read-after-write lag where a fresh
                    // getIssue() returns null for a just-created issue.
                    let importOk = true;
                    let importError: string | undefined;
                    if (result?.id) {
                        try {
                            const importResult: any = await this._seams().commands.executeCommand(
                                'switchboard.importTaskAsDocument',
                                {
                                    workspaceRoot,
                                    provider: 'linear',
                                    id: result.id,
                                    includeSubtasks: false,
                                    preFetchedTask: {
                                        id: result.id,
                                        identifier: result.identifier,
                                        title: msg.title,
                                        description: msg.description,
                                        projectName: msg.projectName
                                    }
                                }
                            );
                            if (importResult && importResult.success === false) {
                                importOk = false;
                                importError = importResult.error || 'Local document write failed.';
                            }
                        } catch (importErr) {
                            importOk = false;
                            importError = importErr instanceof Error ? importErr.message : String(importErr);
                            console.error('[TicketsPanel] Created Linear issue but local import failed:', importErr);
                        }
                    }
                    this.postMessageToWebview({
                        type: 'linearIssueCreated',
                        success: importOk,
                        result,
                        ...(importError ? { error: `Issue created remotely, but local file write failed: ${importError}` } : {}),
                        workspaceRoot
                    });
                } catch (error) {
                    this.postMessageToWebview({
                        type: 'linearIssueCreated',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot
                    });
                }
                return;
            }
            case 'ticketsAskAgent': {
                const askWorkspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const ticketId = String(msg.id || '').trim();
                const provider = msg.provider === 'clickup' ? 'clickup' : 'linear';

                if (!askWorkspaceRoot || !ticketId) {
                    this.postMessageToWebview({
                        type: 'ticketsAskAgentResult',
                        success: false,
                        error: 'Missing workspace or ticket ID',
                        workspaceRoot: askWorkspaceRoot || msg.workspaceRoot || undefined
                    });
                    return;
                }

                try {
                    await this._seams().commands.executeCommand(
                        'switchboard.askAgentTask',
                        {
                            workspaceRoot: askWorkspaceRoot,
                            id: ticketId,
                            title: String(msg.title || '').trim(),
                            description: String(msg.description || '').trim(),
                            provider
                        }
                    );
                    this.postMessageToWebview({ type: 'ticketsAskAgentResult', success: true, workspaceRoot: askWorkspaceRoot });
                } catch (error) {
                    console.error('[TicketsPanel] Failed to send ticket to agent:', error);
                    this.postMessageToWebview({
                        type: 'ticketsAskAgentResult',
                        success: false,
                        error: error instanceof Error ? error.message : String(error),
                        workspaceRoot: askWorkspaceRoot
                    });
                }
                return;
            }

            // ── Plan 4: ClickUp/Linear config verb handlers moved out of
            //    SetupPanelProvider. The config UI now lives in this panel's
            //    CLICKUP/LINEAR tabs; the verbs gate on TICKETS_VERBS and delegate
            //    to the same TaskViewerProvider methods Setup used. Every push goes
            //    to the 'tickets' surface (push-routing ratchet is 0 raw sends). ──
            case 'applyClickUpConfig': {
                const result = await this._taskViewerProvider!.handleApplyClickUpConfig(
                    msg.token,
                    msg.options ?? {}
                );
                this._pushTo(targetPanel, 'tickets', { type: 'clickupApplyResult', ...result });
                await this._taskViewerProvider!.postSetupPanelState();
                await this._seams().commands.executeCommand('switchboard.refreshUI');
                return result;
            }
            case 'saveClickUpMappings': {
                const result = await this._taskViewerProvider!.handleSaveClickUpMappings(
                    Array.isArray(msg.mappings) ? msg.mappings : []
                );
                this._pushTo(targetPanel, 'tickets', { type: 'clickupMappingsSaved', ...result });
                await this._taskViewerProvider!.postSetupPanelState();
                await this._seams().commands.executeCommand('switchboard.refreshUI');
                return { success: true };
            }
            case 'saveClickUpAutomation': {
                const result = await this._taskViewerProvider!.handleSaveClickUpAutomation(
                    Array.isArray(msg.automationRules) ? msg.automationRules : []
                );
                this._pushTo(targetPanel, 'tickets', { type: 'clickupAutomationSaved', ...result });
                await this._taskViewerProvider!.postSetupPanelState();
                await this._seams().commands.executeCommand('switchboard.refreshUI');
                return { success: true };
            }
            case 'applyLinearConfig': {
                try {
                    const result = await this._taskViewerProvider!.handleApplyLinearConfig(
                        msg.token,
                        msg.options ?? {}
                    );
                    this._pushTo(targetPanel, 'tickets', { type: 'linearApplyResult', ...result });
                    await this._taskViewerProvider!.postSetupPanelState();
                    await this._seams().commands.executeCommand('switchboard.refreshUI');
                } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    this._pushTo(targetPanel, 'tickets', {
                        type: 'linearApplyResult',
                        success: false,
                        error: errorMessage
                    });
                }
                return { success: true };
            }
            case 'saveLinearAutomation': {
                const result = await this._taskViewerProvider!.handleSaveLinearAutomation(
                    Array.isArray(msg.automationRules) ? msg.automationRules : []
                );
                this._pushTo(targetPanel, 'tickets', { type: 'linearAutomationSaved', ...result });
                await this._taskViewerProvider!.postSetupPanelState();
                await this._seams().commands.executeCommand('switchboard.refreshUI');
                return { success: true };
            }
            case 'linearBrowseProjects': {
                const result = await this._taskViewerProvider!.handleLinearBrowseProjects();
                if (!result.success) {
                    this._pushTo(targetPanel, 'tickets', {
                        type: 'linearBrowseProjectsResult',
                        success: false,
                        error: result.error
                    });
                    return { success: true };
                }
                try {
                    const projectOptions = result.projects.map((p: { id: string; name: string }) => ({
                        label: p.name,
                        picked: false
                    }));
                    const selected = await this._seams().ui.showQuickPick(
                        projectOptions,
                        {
                            placeHolder: 'Select projects',
                            canPickMany: true
                        }
                    ) as Array<{ label: string }> | undefined;
                    if (selected) {
                        const selectedNames = selected.map((s) => s.label);
                        this._pushTo(targetPanel, 'tickets', {
                            type: 'linearBrowseProjectsResult',
                            success: true,
                            target: msg.target,
                            projects: selectedNames
                        });
                    }
                } catch (error) {
                    this._pushTo(targetPanel, 'tickets', {
                        type: 'linearBrowseProjectsResult',
                        success: false,
                        error: error instanceof Error ? error.message : String(error)
                    });
                }
                return { success: true };
            }
            case 'enableTriagePipeline': {
                const provider = msg.provider === 'linear' ? 'linear' : 'clickup';
                const result = await this._taskViewerProvider!.handleEnableTriagePipeline(
                    provider,
                    typeof msg.token === 'string' ? msg.token : ''
                );
                this._pushTo(targetPanel, 'tickets', { type: 'triagePipelineResult', provider, ...result });
                await this._taskViewerProvider!.postSetupPanelState();
                await this._seams().commands.executeCommand('switchboard.refreshUI');
                return { success: true };
            }
            case 'browseIntegrationTicketSaveLocation': {
                const provider = msg.provider;
                const folderUri = await this._seams().ui.showOpenDialog({
                    canSelectFolders: true,
                    canSelectFiles: false,
                    canSelectMany: false,
                    openLabel: 'Select Tickets Folder'
                });
                if (folderUri?.[0]) {
                    this._pushTo(targetPanel, 'tickets', {
                        type: 'integrationTicketSaveLocationBrowsed',
                        provider,
                        path: folderUri[0]
                    });
                }
                return { success: true };
            }
            case 'saveIntegrationTicketSaveLocation': {
                const provider = msg.provider;
                const folderPath = String(msg.folderPath || '').trim();
                if (provider === 'clickup' || provider === 'linear') {
                    const config = await GlobalIntegrationConfigService.loadConfig(provider) || {};
                    config.ticketSaveLocation = folderPath;
                    await GlobalIntegrationConfigService.saveConfig(provider, config);
                    this._pushTo(targetPanel, 'tickets', {
                        type: 'integrationTicketSaveLocations',
                        provider,
                        path: folderPath
                    });
                }
                return { success: true };
            }
            case 'getIntegrationTicketSaveLocations': {
                const clickupConfig = await GlobalIntegrationConfigService.loadConfig('clickup');
                const linearConfig = await GlobalIntegrationConfigService.loadConfig('linear');
                this._pushTo(targetPanel, 'tickets', {
                    type: 'integrationTicketSaveLocations',
                    provider: 'clickup',
                    path: clickupConfig?.ticketSaveLocation || ''
                });
                this._pushTo(targetPanel, 'tickets', {
                    type: 'integrationTicketSaveLocations',
                    provider: 'linear',
                    path: linearConfig?.ticketSaveLocation || ''
                });
                return { success: true };
            }
            // ── Plan 4: shared verbs registered in BOTH SETUP_VERBS and
            //    TICKETS_VERBS. getIntegrationSetupStates is a three-provider
            //    aggregate Notion (still in Setup) also consumes; the "Show docs
            //    in Artifacts Panel" trio splits two-to-one across panels, so
            //    getPlanningSources / savePlanningSources must be reachable from
            //    both rails. Same implementation, same call — a duplicated verb
            //    name is only a defect when the two bodies disagree (plan 3). ──
            case 'getIntegrationSetupStates': {
                const states = await this._taskViewerProvider!.getIntegrationSetupStates();
                this._pushTo(targetPanel, 'tickets', { type: 'integrationSetupStates', ...states });
                return { success: true, ...states };
            }
            case 'getPlanningSources': {
                // NOTE: intentionally folder-scoped — this setting is per-project, not shared across workspaces
                const pathConfig = this._seams().pathConfig;
                const enabledSources = pathConfig.getConfigJson('planning.enabledSources', {
                    clickup: true,
                    linear: true,
                    notion: true,
                    'local-folder': true
                });
                this._pushTo(targetPanel, 'tickets', {
                    type: 'planningSources',
                    sources: enabledSources
                });
                return { success: true };
            }
            case 'savePlanningSources': {
                const sources = {
                    clickup: msg.clickup === true,
                    linear: msg.linear === true,
                    notion: msg.notion === true,
                    'local-folder': msg.localFolder === true
                };
                // NOTE: intentionally folder-scoped — this setting is per-project, not shared across workspaces
                const pathConfig = this._seams().pathConfig;
                await pathConfig.updateConfigWorkspace('planning.enabledSources', sources);
                this._pushTo(targetPanel, 'tickets', { type: 'planningSourcesSaved', success: true });
                await this._seams().commands.executeCommand('switchboard.refreshUI');
                return { success: true };
            }

            // ── Shared utility verbs ────────────────────────────────────
            // Registered here so they land in TICKETS_VERBS (generated from this
            // switch), but implemented once in sharedUtilityVerbs.ts — Planning's
            // DOCS/HTML tabs need the same behaviour and a second copy would
            // diverge. All five RETURN their result, per the verb-return contract.
            case 'openExternalUrl': {
                return await handleOpenExternalUrl(this._sharedUtilityDeps(), msg);
            }
            case 'copyDiagramPrompt': {
                return await handleCopyDiagramPrompt(this._sharedUtilityDeps(), msg);
            }
            case 'copyToClipboard': {
                return await handleCopyToClipboard(this._sharedUtilityDeps(), msg);
            }
            case 'renderMarkdownLive': {
                return await handleRenderMarkdownLive(this._sharedUtilityDeps(this._workspaceRoot), msg);
            }
            case 'linearLoadAutomationCatalog': {
                return await handleLinearLoadAutomationCatalog(this._sharedUtilityDeps(), msg);
            }

            default: {
                // Unimplemented verb — must be loud rather than silently "fine".
                throw new Error(`Unhandled Tickets verb: '${msg.type}'`);
            }
        }
    }

    public dispose(): void {
        if (this._ticketsViewWatcher) {
            try { this._ticketsViewWatcher.dispose(); } catch { }
            this._ticketsViewWatcher = undefined;
        }
        for (const t of this._ticketsViewWatcherDebounces.values()) { clearTimeout(t); }
        this._ticketsViewWatcherDebounces.clear();
        if (this._panel) {
            this._panel.dispose();
            this._panel = undefined;
        }
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) x.dispose();
        }
    }
}
