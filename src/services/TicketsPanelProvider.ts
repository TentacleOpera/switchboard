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
import { stripImportedSubtasksBlock } from './ticketDisplayContent';
import type { TaskViewerProvider } from './TaskViewerProvider';

// Imported ticket filename shape: `<provider>_<id>_<slug>.md`. Shared by the display
// watcher's change and delete paths so the two cannot drift apart on what counts as a
// ticket file. No /g flag — this is matched against many names and must stay stateless.
const TICKET_FILE_NAME_RE = /^(linear|clickup)_([^_]+)_.*\.md$/;

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
    /** Root the display watcher is currently armed for, and the folders it actually attached to. */
    private _ticketsViewWatcherRoot: string | undefined;
    private _ticketsViewWatcherFolders: string[] = [];
    private _ticketsViewNativeWatchers: fs.FSWatcher[] = [];
    private _cacheService: any | undefined;
    private _ticketsCurrentSelection: Map<string, { provider: string; listId?: string; projectId?: string }> = new Map();
    // ── Tickets auto-sync engine (moved from PlanningPanelProvider). The 45s
    //    delta-pull timer and the auto-push file watcher live here now — the
    //    panel extraction left them behind in Planning with no writer, so users
    //    who enabled auto-sync in a shipped build had a running engine they
    //    could not see or turn off. See plan
    //    feature_plan_20260807103000_tickets-autosync-migration-regression.md. ──
    private _ticketsAutoSyncWatchers: Map<string, HostWatchHandle> = new Map();
    private _ticketsAutoSyncDebounces: Map<string, NodeJS.Timeout> = new Map();
    // Delta-pull timer (auto-sync ON only). Runs the delta pull on a 45s
    // interval for the currently-selected list/project. Torn down on
    // toggle-off or dispose. Rate-limit aware: exponential backoff on
    // consecutive failures, cap at 5 then pause until next toggle cycle.
    private _ticketsAutoSyncTimers: Map<string, NodeJS.Timeout> = new Map();
    private _ticketsAutoSyncFailures: Map<string, number> = new Map();
    // Exponential backoff: after N consecutive failures, the next eligible
    // tick time is set to now + INTERVAL * 2^N. Reset to 0 on success.
    private _ticketsAutoSyncNextEligible: Map<string, number> = new Map();
    // ── 2d: move-targets cache for fetchMoveTargets (TTL-bounded, per provider) ──
    private _moveTargetsCache = new Map<string, { at: number; targets: Array<{ id: string; name: string; path: string }> }>();
    private static readonly MOVE_TARGETS_TTL_MS = 60_000;
    /** Exactly LocalApiServer.DESIGN_ASSET_EXTENSIONS — anything outside it cannot be served, so
     *  watching it produces an event that can never change what is rendered. */
    private static readonly TICKET_ASSET_EXTENSIONS =
        new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico', '.avif']);
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
                out.push({ id, title, status: kanbanColumn || '', filePath: fullPath, url: '', dateCreated, assignees, priority, parentId });
            }
        }
    }

    /**
     * Writes/updates the `parentId:` frontmatter key on a ticket's local .md file.
     *
     * The Tickets sidebar is file-backed and hides any ticket whose file carries a
     * `parentId:` (listLocalTicketFiles / _scanLocalTicketFiles). convertToSubtask only
     * mutates the remote, so without this the converted ticket stays visible as a
     * top-level card forever.
     *
     * Splices a single line — never re-serialises the body — because the file may hold
     * unpushed user edits.
     *
     * Returns false when there was no local file to update (not an error).
     */
    private _stampTicketParentIdInFile(filePath: string, parentId: string): boolean {
        if (!filePath || !fs.existsSync(filePath)) { return false; }
        const content = fs.readFileSync(filePath, 'utf8');
        // `\r?\n` on the fences: a CRLF-normalised file misses an LF-only match, falls
        // to the no-frontmatter branch below and gets a SECOND `---` block prepended
        // above its real one. The readers use a non-global match, so every other key
        // (listId, status, priority) would then be invisible behind the new block.
        const fm = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
        // Splice by slice, never String.replace(string, string): the replacement is
        // user file content and replace() expands `$&` / `$'` / `` $` `` / `$1` inside
        // it, silently corrupting any ticket whose frontmatter contains a `$`.
        const body = fm ? content.slice(fm[0].length) : content;
        let block: string;
        if (!fm) {
            // Legacy import with no frontmatter block — create one.
            block = `---\nparentId: ${parentId}\n---\n`;
        } else if (/^parentId:\s*.+$/m.test(fm[1])) {
            // Re-parenting an existing subtask: replace in place, never append a
            // second key. Function replacer, same `$`-expansion reason as above.
            const patched = fm[1].replace(/^parentId:\s*.+$/m, () => `parentId: ${parentId}`);
            block = `---\n${patched}\n---`;
        } else {
            block = `---\n${fm[1]}\nparentId: ${parentId}\n---`;
        }
        fs.writeFileSync(filePath, block + body, 'utf8');
        return true;
    }

    public getTicketsAssetRoots(workspaceRoot: string): string[] {
        const roots: string[] = [];
        try {
            const service = this._getLocalFolderService(workspaceRoot);
            roots.push(...service.getTicketsFolderPaths());
            roots.push(...service.getFolderPaths());
        } catch { /* config unreadable — fall through to the default tickets dir */ }
        // The integration config's ticketSaveLocation is where _buildTicketDir actually
        // writes ticket documents (TaskViewerProvider.ts:21960-21971). It is a DIFFERENT
        // setting from LocalFolderService's ticketsFolderPaths, so a custom save location
        // was absent from the allow-list and every asset under it failed the guard.
        for (const p of ['linear', 'clickup'] as const) {
            try {
                const cfg = GlobalIntegrationConfigService.loadConfigSync(p);
                if (cfg?.ticketSaveLocation) { roots.push(path.join(cfg.ticketSaveLocation, p)); }
            } catch { /* config unreadable — the defaults below still apply */ }
        }
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
        // Cache-busting version token. Without it the URL is byte-identical after an
        // image is overwritten in place, so every downstream equality check (the
        // ticketFileChanged hasChanged guard, the _lastTickets*DetailContentHtml memo)
        // concludes "nothing changed" and the live <img> node is never recreated.
        // The route ignores unknown query params, so this is inert server-side.
        // stat on realTarget, not absPath — the allow-list already realpathed, and a
        // symlinked tickets tree would ENOENT on the pre-realpath path.
        let version = '';
        try { version = `&v=${Math.floor(fs.statSync(realTarget).mtimeMs)}`; } catch { /* best effort */ }
        const relativePath = `/design/asset?root=${encodeURIComponent(root)}&path=${encodeURIComponent(realTarget)}${version}`;
        // When the editor webview is active, the same markdown string is fanned out
        // to both the webview and the browser (BroadcastHub two-target send). A
        // root-relative URL is unresolvable in the webview (origin is
        // vscode-webview://), so the absolute loopback form is required. When no
        // webview is active (standalone browser board), the relative URL is correct
        // under every access method — direct launch, SSH tunnel (port-shifted or
        // not), reverse proxy, HTTPS — and the absolute form breaks under a
        // port-shifted tunnel because it pins the server's real listening port.
        if (this._panel) {
            return `http://127.0.0.1:${port}${relativePath}`;
        }
        return relativePath;
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
                const uri = webviewUri.toString();
                let v = '';
                try { v = `${uri.includes('?') ? '&' : '?'}v=${Math.floor(fs.statSync(absPath).mtimeMs)}`; } catch { /* best effort */ }
                return `![${alt}](${uri}${v})`;
            } catch {
                return match;
            }
        });
    }

    /**
     * Candidate folders the display watcher should attach to, in priority order.
     * Both configured save locations are global, so this varies with the integration
     * config as well as with the root — see _rearmTicketsViewWatcherIfFoldersChanged.
     */
    private _resolveTicketsWatchFolders(workspaceRoot: string): string[] {
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
        return watchFolders;
    }

    /** First `<prefix>*.md` under any of `folders` other than `excludePath`, if one exists. */
    private _findTicketFileById(folders: string[], prefix: string, excludePath: string): string | undefined {
        const excluded = path.resolve(excludePath);
        const seen = new Set<string>();
        for (const folder of folders) {
            const resolvedFolder = path.resolve(folder);
            if (seen.has(resolvedFolder)) { continue; }
            seen.add(resolvedFolder);
            let entries: string[];
            try { entries = fs.readdirSync(resolvedFolder); } catch { continue; }
            for (const entry of entries) {
                if (!entry.startsWith(prefix) || !entry.endsWith('.md')) { continue; }
                const full = path.join(resolvedFolder, entry);
                if (path.resolve(full) === excluded) { continue; }
                if (fs.existsSync(full)) { return full; }
            }
        }
        return undefined;
    }

    /**
     * The webview arms the watcher once per workspace root and then suppresses repeats.
     * But the folder set is not a function of the root alone: `_setupTicketsViewWatcher`
     * skips folders that do not exist yet, so arming before the first ticket import
     * attaches ZERO watchers and the root-keyed guard then blocks re-arming for the rest
     * of the session — the same "watcher never armed" failure this plan set out to kill.
     * Changing `ticketSaveLocation` in Setup has the same effect. Cheap existsSync sweep
     * on the sidebar-load path; re-arms only when the attached set actually differs.
     */
    private _rearmTicketsViewWatcherIfFoldersChanged(workspaceRoot: string): void {
        if (!this._ticketsViewWatcher || this._ticketsViewWatcherRoot !== workspaceRoot) { return; }
        const current = this._resolveTicketsWatchFolders(workspaceRoot).filter(f => fs.existsSync(f));
        const armed = this._ticketsViewWatcherFolders;
        if (current.length === armed.length && current.every((f, i) => f === armed[i])) { return; }
        this._setupTicketsViewWatcher(workspaceRoot);
    }

    private _setupTicketsViewWatcher(workspaceRoot: string): void {
        if (this._ticketsViewWatcher) {
            try { this._ticketsViewWatcher.dispose(); } catch { }
            this._ticketsViewWatcher = undefined;
        }
        for (const w of this._ticketsViewNativeWatchers) { try { w.close(); } catch { } }
        this._ticketsViewNativeWatchers = [];
        for (const t of this._ticketsViewWatcherDebounces.values()) { clearTimeout(t); }
        this._ticketsViewWatcherDebounces.clear();

        const watchFolders = this._resolveTicketsWatchFolders(workspaceRoot);

        const handleTicketFileEvent = (filePath: string) => {
            this._emitTicketFileChanged(filePath);
        };

        // A rename arrives as delete(old) + create(new), and ticket files ARE renamed
        // whenever the title changes (importTaskAsDocument re-slugs the filename). Taking
        // that delete at face value would drop a card — and blank the detail pane — for a
        // ticket that still exists. So: debounce on the same per-file key as the change
        // path (which also cancels any read still queued for the vanished path), then look
        // for a surviving `<provider>_<id>_*.md` before declaring a real deletion.
        const handleTicketFileDelete = (filePath: string) => {
            const fileName = path.basename(filePath);
            const match = fileName.match(TICKET_FILE_NAME_RE);
            if (!match) { return; }
            const [, provider, id] = match;

            const key = filePath;
            const existing = this._ticketsViewWatcherDebounces.get(key);
            if (existing) { clearTimeout(existing); }
            this._ticketsViewWatcherDebounces.set(key, setTimeout(() => {
                this._ticketsViewWatcherDebounces.delete(key);
                const survivor = this._findTicketFileById(
                    [...watchFolders, path.dirname(filePath)], `${provider}_${id}_`, filePath
                );
                if (survivor) {
                    handleTicketFileEvent(survivor);   // renamed, not deleted
                    return;
                }
                this.postMessageToWebview({ type: 'ticketFileDeleted', provider, id });
            }, 300));
        };

        const watchers: HostWatchHandle[] = [];
        const attachedFolders: string[] = [];
        for (const folder of watchFolders) {
            if (!fs.existsSync(folder)) { continue; }
            const watcher = this._seams().watcher.watchFolder(folder, (event, filePath) => {
                if (!filePath.endsWith('.md')) {
                    this._handleTicketAssetEvent(filePath);
                    return;
                }
                if (event === 'delete') {
                    handleTicketFileDelete(filePath);
                    return;
                }
                handleTicketFileEvent(filePath);   // create + change both read the file
            });
            watchers.push(watcher);
            attachedFolders.push(folder);
            this._setupNativeFolderWatchFallback(folder, this._ticketsViewNativeWatchers, (filePath) => {
                if (filePath === null) { this._handleTicketsViewRescan(folder); return; }
                if (!filePath.endsWith('.md')) { this._handleTicketAssetEvent(filePath); return; }
                if (!fs.existsSync(filePath)) { handleTicketFileDelete(filePath); return; }
                handleTicketFileEvent(filePath);
            });
        }
        this._ticketsViewWatcherRoot = workspaceRoot;
        this._ticketsViewWatcherFolders = attachedFolders;

        this._ticketsViewWatcher = {
            dispose: () => watchers.forEach(w => { try { w.dispose(); } catch { } })
        };
        this._disposables.push(this._ticketsViewWatcher);
    }

    private _readTicketFilePayload(filePath: string, provider: string, id: string): { title: string; content: string; rawContent: string } | null {
        try {
            const raw = fs.readFileSync(filePath, 'utf8');
            const content = raw.replace(/^---\n[\s\S]*?\n---\n?/, '').trim();
            const h1 = content.match(/^#\s+(.+)$/m);
            const title = h1 ? h1[1].trim() : id;
            const displayContent = this._rewriteLocalImagePaths(
                stripImportedSubtasksBlock(content), path.dirname(filePath)
            );
            return { title, content: displayContent, rawContent: content };
        } catch { return null; }
    }

    private _emitTicketFileChanged(filePath: string): void {
        const fileName = path.basename(filePath);
        const match = fileName.match(TICKET_FILE_NAME_RE);
        if (!match) { return; }
        const [, provider, id] = match;
        const payload = this._readTicketFilePayload(filePath, provider, id);
        if (!payload) { return; }
        this.postMessageToWebview({ type: 'ticketFileChanged', provider, id, ...payload });
    }

    /** An image overwritten in place changes no .md byte, so the ticket that embeds it
     *  would never refresh. Map the asset back to the ticket files that actually reference
     *  it and replay the normal change path for each — that regenerates displayContent with
     *  a fresh &v= token.
     *
     *  Reference-filtered, NOT directory-wide: _buildTicketDir groups a whole list into one
     *  directory sharing one attachments/ folder, so a directory-wide replay would emit one
     *  push per ticket in the list on every image write.
     *
     *  Debounce key is prefixed so an asset write can never cancel a queued rename
     *  resolution keyed on the same .md path. */
    private _handleTicketAssetEvent(assetPath: string): void {
        if (!TicketsPanelProvider.TICKET_ASSET_EXTENSIONS.has(path.extname(assetPath).toLowerCase())) { return; }
        const assetDir = path.dirname(assetPath);
        if (path.basename(assetDir).toLowerCase() !== 'attachments') { return; }
        const ticketDir = path.dirname(assetDir);
        const assetName = path.basename(assetPath);
        const key = `asset:${assetPath}`;
        const existing = this._ticketsViewWatcherDebounces.get(key);
        if (existing) { clearTimeout(existing); }
        this._ticketsViewWatcherDebounces.set(key, setTimeout(() => {
            this._ticketsViewWatcherDebounces.delete(key);
            let entries: string[] = [];
            try { entries = fs.readdirSync(ticketDir); } catch { return; }
            for (const entry of entries) {
                if (!TICKET_FILE_NAME_RE.test(entry)) { continue; }
                const full = path.join(ticketDir, entry);
                let raw = '';
                try { raw = fs.readFileSync(full, 'utf8'); } catch { continue; }
                if (!raw.includes(assetName)) { continue; }
                this._emitTicketFileChanged(full);
            }
        }, 300));
    }

    /** macOS FSEvents can drop filenames under burst I/O. Rescan the folder tree for
     *  ticket .md files and emit a normal change for each. */
    private _handleTicketsViewRescan(folder: string): void {
        const key = `rescan:${folder}`;
        const existing = this._ticketsViewWatcherDebounces.get(key);
        if (existing) { clearTimeout(existing); }
        this._ticketsViewWatcherDebounces.set(key, setTimeout(() => {
            this._ticketsViewWatcherDebounces.delete(key);
            const queue: string[] = [folder];
            while (queue.length) {
                const dir = queue.pop()!;
                if (path.basename(dir).toLowerCase() === 'attachments') { continue; }
                let entries: string[] = [];
                try { entries = fs.readdirSync(dir); } catch { continue; }
                for (const entry of entries) {
                    const full = path.join(dir, entry);
                    try {
                        const stat = fs.statSync(full);
                        if (stat.isDirectory()) {
                            queue.push(full);
                        } else if (TICKET_FILE_NAME_RE.test(entry)) {
                            this._emitTicketFileChanged(full);
                        }
                    } catch {}
                }
            }
        }, 300));
    }

    /** Ported in shape from DesignPanelProvider's native fallback, scoped to Tickets.
     *  Passes `null` through to the consumer for FSEvents-dropped bursts so the provider
     *  can rescan. Skips in-workspace folders and warns on Linux for parity with other
     *  fallbacks pending a repo-wide re-qualification. */
    private _setupNativeFolderWatchFallback(
        folderPath: string,
        watchersArray: fs.FSWatcher[],
        onFile: (filePath: string | null) => void
    ): void {
        const roots = this._getWorkspaceRoots();
        const insideWorkspace = roots.some(r => folderPath === r || folderPath.startsWith(r + path.sep));
        if (insideWorkspace) return;

        if (process.platform === 'linux') {
            console.warn(
                `[TicketsPanelProvider] fs.watch recursive fallback skipped on Linux for '${folderPath}' — out-of-workspace external writes may not refresh. Kept for parity with other fallbacks pending a repo-wide re-qualification.`
            );
            return;
        }

        try {
            const watcher = fs.watch(folderPath, { recursive: true }, (_eventType, filename) => {
                if (!filename) {
                    onFile(null);
                    return;
                }
                const fullPath = path.join(folderPath, filename.toString());
                try {
                    onFile(fullPath);
                } catch (e) {
                    console.error('[TicketsPanelProvider] native folder watch callback failed:', e);
                }
            });
            watcher.on('error', (err) => {
                console.error(`[TicketsPanelProvider] fs.watch error for '${folderPath}':`, err);
            });
            watchersArray.push(watcher);
        } catch (e) {
            console.error(`[TicketsPanelProvider] fs.watch fallback failed for '${folderPath}':`, e);
        }
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

    /**
     * Resolve the tickets-auto-sync setting for a root. Reads the global config
     * first; if the global value is unset, falls back to the per-folder config
     * and PROMOTES it to the global config. That promotion branch is the
     * migration path for installs that only ever wrote the per-folder value in
     * a shipped build — keep it exactly as-is.
     */
    private async _getTicketsAutoSync(root: string): Promise<boolean> {
        const globalConfig = await GlobalIntegrationConfigService.loadGlobal();
        if (globalConfig.ticketsAutoSync === undefined) {
            const localService = this._getLocalFolderService(root);
            const localValue = localService.getTicketsAutoSync();
            if (localValue) {
                await GlobalIntegrationConfigService.setTicketsAutoSync(true);
                return true;
            }
            return false;
        }
        return globalConfig.ticketsAutoSync === true;
    }

    /**
     * Arm/tear down the tickets auto-sync engine for a workspace root: a file
     * watcher that pushes local `.md` edits to the provider, and a 45s
     * delta-pull timer that polls for remote changes. Idempotent — the
     * `if (existing) { return; }` guard makes arming from several hooks safe.
     * Moved verbatim from PlanningPanelProvider; only the log prefix changed.
     */
    private _updateTicketsAutoSyncWatcher(workspaceRoot: string, enabled: boolean): void {
        const existing = this._ticketsAutoSyncWatchers.get(workspaceRoot);
        if (!enabled) {
            if (existing) {
                try { existing.dispose(); } catch (e) {}
                this._ticketsAutoSyncWatchers.delete(workspaceRoot);
            }
            // Tear down the delta-pull timer as well — auto-sync OFF means
            // no background network activity (manual Refresh still works).
            const timer = this._ticketsAutoSyncTimers.get(workspaceRoot);
            if (timer) {
                clearInterval(timer);
                this._ticketsAutoSyncTimers.delete(workspaceRoot);
            }
            this._ticketsAutoSyncFailures.delete(workspaceRoot);
            this._ticketsAutoSyncNextEligible.delete(workspaceRoot);
            return;
        }
        if (existing) { return; } // already watching

        const watchFolders: string[] = [];
        const clickup = GlobalIntegrationConfigService.loadConfigSync('clickup');
        const linear = GlobalIntegrationConfigService.loadConfigSync('linear');
        if (clickup?.ticketSaveLocation) { watchFolders.push(clickup.ticketSaveLocation); }
        if (linear?.ticketSaveLocation) { watchFolders.push(linear.ticketSaveLocation); }
        watchFolders.push(path.join(workspaceRoot, '.switchboard/tickets'));

        const watchers: HostWatchHandle[] = [];
        for (const folder of watchFolders) {
            if (!fs.existsSync(folder)) { continue; }
            const watcher = this._seams().watcher.watchFolder(folder, (event, filePath) => {
                if (event !== 'change' || !filePath.endsWith('.md')) { return; }
                const fileName = path.basename(filePath);
                const match = fileName.match(/^(linear|clickup)_([^_]+)_.*\.md$/);
                if (!match) { return; }
                const [, provider, id] = match;

                const debounceKey = filePath;
                const existing = this._ticketsAutoSyncDebounces.get(debounceKey);
                if (existing) { clearTimeout(existing); }
                this._ticketsAutoSyncDebounces.set(debounceKey, setTimeout(async () => {
                    this._ticketsAutoSyncDebounces.delete(debounceKey);
                    try {
                        const result: any = await this._seams().commands.executeCommand(
                            'switchboard.pushTicketEdits',
                            { workspaceRoot, provider: provider as 'linear' | 'clickup', id }
                        );
                        this.postMessageToWebview({
                            type: 'pushTicketResult',
                            success: result?.success ?? false,
                            id,
                            error: result?.error,
                            autoSync: true
                        });
                    } catch (e) {
                        this.postMessageToWebview({
                            type: 'pushTicketResult',
                            success: false,
                            id,
                            error: e instanceof Error ? e.message : String(e),
                            autoSync: true
                        });
                    }
                }, 2000));
            });
            watchers.push(watcher);
        }

        this._ticketsAutoSyncWatchers.set(workspaceRoot, {
            dispose: () => watchers.forEach(w => { try { w.dispose(); } catch { } })
        });

        // Start the delta-pull timer (auto-sync ON only). Runs every 45s —
        // safe for both ClickUp (100 req/min) and Linear (5,000 req/hour).
        // The callback wraps API calls in try/catch with exponential backoff
        // on consecutive failures (cap at 5, then pause until next toggle).
        // Errors are logged silently — no user toast spam on every failed poll.
        const POLL_INTERVAL_MS = 45000;
        const MAX_CONSECUTIVE_FAILURES = 5;
        const timer = setInterval(async () => {
            const failures = this._ticketsAutoSyncFailures.get(workspaceRoot) || 0;
            if (failures >= MAX_CONSECUTIVE_FAILURES) {
                // Paused — wait for toggle cycle to reset. Log once.
                return;
            }
            // Exponential backoff: after N consecutive failures, skip ticks
            // until the next eligible time (now + INTERVAL * 2^N at the time
            // of the failure). This spaces out retries: 45s → 90s → 180s → …
            const now = Date.now();
            const nextEligible = this._ticketsAutoSyncNextEligible.get(workspaceRoot) || 0;
            if (nextEligible > now) { return; }
            const selection = this._ticketsCurrentSelection.get(workspaceRoot);
            if (!selection || !selection.provider) { return; }
            try {
                // Reuse the same delta-pull path as the manual Refresh button.
                // The cursor is read/updated inside importAllTasks; here we
                // just trigger it silently (no user toast on success).
                if (!this._cacheService) {
                    this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                }
                const kanbanDb = (this._cacheService as any)?._kanbanDb;
                const cursorKey = selection.provider === 'clickup'
                    ? `last_delta_pull_clickup_${selection.listId || ''}`
                    : `last_delta_pull_linear_${selection.projectId || ''}`;
                let lastPullIso: string | null = null;
                if (kanbanDb) {
                    try { lastPullIso = await kanbanDb.getMeta(cursorKey); } catch { /* ignore */ }
                }
                const deltaSince = lastPullIso ? new Date(lastPullIso).getTime() : undefined;
                const deltaSinceIso = lastPullIso || undefined;

                const result: any = await this._seams().commands.executeCommand(
                    'switchboard.importAllTasks',
                    {
                        workspaceRoot,
                        provider: selection.provider,
                        listId: selection.listId,
                        projectId: selection.projectId,
                        importMode: 'document',
                        ...(deltaSince !== undefined ? { deltaSince } : {}),
                        ...(deltaSinceIso ? { deltaSinceIso } : {})
                    }
                );

                if (result?.success && kanbanDb) {
                    try { await kanbanDb.setMeta(cursorKey, new Date().toISOString()); } catch { /* ignore */ }
                }

                if (result?.success) {
                    this._ticketsAutoSyncFailures.set(workspaceRoot, 0);
                    this._ticketsAutoSyncNextEligible.set(workspaceRoot, 0);
                    // If any tickets were updated OR deleted, refresh the sidebar
                    // silently. Without the deletedCount check, a tick where only
                    // deletions occurred (no updates) would not refresh the sidebar
                    // and the deleted ticket's card would linger until the next
                    // update-bearing tick.
                    if ((result.successCount || 0) > 0 || (result.deletedCount || 0) > 0) {
                        this.postMessageToWebview({
                            type: 'importAllTicketsComplete',
                            success: true,
                            successCount: result.successCount,
                            failCount: result.failCount,
                            deletedCount: result.deletedCount,
                            errors: result.errors,
                            importMode: 'document',
                            workspaceRoot,
                            provider: selection.provider,
                            listId: selection.listId,
                            projectId: selection.projectId,
                            isDelta: lastPullIso !== null,
                            autoSync: true
                        });
                    }
                } else {
                    const f = (this._ticketsAutoSyncFailures.get(workspaceRoot) || 0) + 1;
                    this._ticketsAutoSyncFailures.set(workspaceRoot, f);
                    // Exponential backoff: next eligible = now + INTERVAL * 2^f
                    this._ticketsAutoSyncNextEligible.set(workspaceRoot, Date.now() + POLL_INTERVAL_MS * Math.pow(2, f));
                    console.warn(`[TicketsPanel] Auto-sync delta pull failed (${f}/${MAX_CONSECUTIVE_FAILURES}):`, result?.error);
                }
            } catch (e) {
                const f = (this._ticketsAutoSyncFailures.get(workspaceRoot) || 0) + 1;
                this._ticketsAutoSyncFailures.set(workspaceRoot, f);
                this._ticketsAutoSyncNextEligible.set(workspaceRoot, Date.now() + POLL_INTERVAL_MS * Math.pow(2, f));
                console.warn(`[TicketsPanel] Auto-sync delta pull error (${f}/${MAX_CONSECUTIVE_FAILURES}):`, e);
            }
        }, POLL_INTERVAL_MS);
        this._ticketsAutoSyncTimers.set(workspaceRoot, timer);
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
                    vscode.Uri.file(path.join(this._context.extensionPath, 'designs')),
                    // Ticket asset folders. Exactly the same trap as `designs` above, one
                    // asset class over: _rewriteLocalImagePaths' SECOND route is
                    // `webview.asWebviewUri(<local image>)`, and without these roots that
                    // route returns a perfectly well-formed URI the webview then refuses
                    // to load — a broken <img>, no error anywhere.
                    //
                    // That fallback is not cold code. The FIRST route
                    // (_buildLocalAssetUrl → http://127.0.0.1:<port>/design/asset) is
                    // gated on `this._apiServer?.getPort?.()`, and setApiServer's own
                    // docstring records that the provider-registration and server-created
                    // handshakes race ("either can happen first"). Open a ticket inside
                    // that window and route 1 returns undefined, route 2 is dead, and the
                    // images stay broken until something triggers a re-read. Carrying
                    // these roots makes route 2 work, so the race stops being visible.
                    //
                    // Reuses getTicketsAssetRoots — the SAME allow-list the loopback route
                    // enforces — so the two routes can never disagree about which folders
                    // are legitimate. PlanningPanelProvider carries the equivalent roots;
                    // extracting this panel dropped them.
                    ...this._getWorkspaceRoots()
                        .flatMap(root => this.getTicketsAssetRoots(root))
                        .filter((v, i, a) => a.indexOf(v) === i)
                        .map(folder => vscode.Uri.file(folder))
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
                        // Carry the auto-sync toggle on the provider-switch
                        // push so the checkbox stays in step with the engine
                        // when the user changes provider. Guard on presence in
                        // the frontend so an omit never silently unticks it.
                        //
                        // `workspaceRoot` is stamped because this push now
                        // carries ROOT-scoped state and _pushTo broadcasts to
                        // every connected tickets surface: without it, a
                        // provider switch on root A rewrites root B's checkbox
                        // (the cross-talk class recorded in _stampReply).
                        const ticketsAutoSync = await this._getTicketsAutoSync(workspaceRoot);
                        this._updateTicketsAutoSyncWatcher(workspaceRoot, ticketsAutoSync);
                        this._pushTo(targetPanel, 'tickets', {
                            type: 'integrationProviderStates',
                            clickupSetupComplete,
                            linearSetupComplete,
                            provider,
                            ticketsAutoSync,
                            workspaceRoot
                        });
                    } catch (err) {
                        console.warn('[TicketsPanel] Failed to switch ticket provider:', err);
                    }
                }
                break;
            }

            case 'setTicketsAutoSync': {
                const root = this._resolveWorkspaceRoot(msg.workspaceRoot) || this._getWorkspaceRoot() || '';
                const enabled = msg.enabled === true;
                await GlobalIntegrationConfigService.setTicketsAutoSync(enabled);
                // Keep the per-folder value in step so a downgrade to an older
                // build still sees the user's choice — the folder config is
                // what shipped versions read. This also gives
                // LocalFolderService.setTicketsAutoSync a caller again (it
                // currently has zero).
                if (root) { await this._getLocalFolderService(root).setTicketsAutoSync(enabled); }
                if (root) { this._updateTicketsAutoSyncWatcher(root, enabled); }
                // Writing the global value unconditionally closes the
                // `=== undefined` migration branch for this install — once the
                // user has made an explicit choice, the per-folder fallback
                // must stop overriding it. Correct.
                this._pushTo(targetPanel, 'tickets', {
                    type: 'ticketsAutoSyncChanged',
                    ticketsAutoSync: enabled,
                    workspaceRoot: root || undefined
                });
                return { success: true, ticketsAutoSync: enabled };
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
                if (!root) { return { success: false, error: 'No workspace root resolved' }; }
                this._setupTicketsViewWatcher(root);
                // Arm the auto-sync engine and carry its state to the webview.
                // This is the load-bearing carrier for the toggle on open: an
                // affected user whose on-disk config has ticketsAutoSync: true
                // must see the box already ticked on a cold open, with no
                // provider-dropdown interaction. setupTicketsWatcher is posted
                // from every path that resolves or changes the root
                // (tickets.js ensureTicketsWatcherArmed), so it always runs.
                const ticketsAutoSync = await this._getTicketsAutoSync(root);
                this._updateTicketsAutoSyncWatcher(root, ticketsAutoSync);
                const res = { type: 'ticketsAutoSyncChanged', ticketsAutoSync, workspaceRoot: root };
                this._pushTo(targetPanel, 'tickets', res);
                return { ...res, success: true };
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

                // Secondary carrier for the auto-sync toggle: arm the engine
                // and carry the value in the reply. This arm does NOT run on
                // every open (restoreTicketsState gates it on
                // !lastIntegrationProvider), so setupTicketsWatcher remains the
                // primary carrier — but when this arm does fire it must bring
                // the toggle state with it.
                let ticketsAutoSync = false;
                const armRoot = defaultRoot || allRoots[0];
                if (armRoot) {
                    try {
                        ticketsAutoSync = await this._getTicketsAutoSync(armRoot);
                        this._updateTicketsAutoSyncWatcher(armRoot, ticketsAutoSync);
                    } catch { /* keep default false */ }
                }
                this.postMessageToWebview({
                    type: 'ticketsDefaultRoot',
                    workspaceRoot: defaultRoot,
                    provider: defaultProvider,
                    ticketsAutoSync
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
                // Re-arm the auto-sync engine now that the timer's
                // precondition (a known selection) is satisfied. Idempotent.
                try { this._updateTicketsAutoSyncWatcher(workspaceRoot, await this._getTicketsAutoSync(workspaceRoot)); } catch { /* keep */ }
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
                    // `authoritative` is true ONLY for an explicit Refetch click (forceFull).
                    // includeClosed must bypass the delta CURSOR (a ticket closed before the
                    // cursor never appears in a delta payload) but it must NOT bypass the
                    // conflict guard — only an explicit Refetch means "discard my local
                    // edits and take the remote".
                    const authoritative = !!msg.forceFull;
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
                            authoritative,
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
                    // A ticket deleted remotely only leaves the sidebar when its local
                    // file goes, so a refresh that could not verify some candidates has
                    // NOT finished reconciling. Say so — the previous behaviour logged a
                    // console.warn and looked identical to "nothing to do", which is why
                    // deleted tickets appeared to survive refresh forever.
                    const unresolved = result?.deletionChecksUnresolved || 0;
                    const deferred = result?.deletionChecksSkipped || 0;
                    if (!result?.success) {
                        this._seams().ui.showErrorMessage(`Refresh failed: ${result?.error || 'unknown'}`);
                    } else if (skippedModified > 0) {
                        this._seams().ui.showWarningMessage(
                            `Refreshed ${result.successCount} ticket${result.successCount !== 1 ? 's' : ''}. ${skippedModified} skipped (local file has unpushed edits). Push them, or hit Refetch to take the remote version and discard local changes.`
                        );
                    } else if ((result.failCount || 0) > 0) {
                        this._seams().ui.showWarningMessage(`Refresh: ${result.successCount} updated, ${result.failCount} failed — ${errDetail}`);
                    } else if (unresolved > 0 || deferred > 0) {
                        const parts: string[] = [];
                        if (unresolved > 0) { parts.push(`${unresolved} could not be verified against ${provider === 'clickup' ? 'ClickUp' : 'Linear'}`); }
                        if (deferred > 0) { parts.push(`${deferred} deferred to the next refresh`); }
                        this._seams().ui.showWarningMessage(
                            `Refreshed ${result.successCount} ticket${result.successCount !== 1 ? 's' : ''}. Deletion check incomplete: ${parts.join(', ')} — those tickets are kept.`
                        );
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
                // The sidebar-load path is also the moment the tickets folder most likely
                // came into existence (first import) or moved (Setup change). Re-attach the
                // display watcher if its folder set drifted; no-op otherwise.
                this._rearmTicketsViewWatcherIfFoldersChanged(workspaceRoot);
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

                            // First pass: tally children per parent. Must complete before any
                            // ticket is pushed — the main loop emits parents as it walks, so a
                            // parent seen before its children would ship a count of zero.
                            // Runs before BOTH the subtask filter and the scope filter so an
                            // out-of-scope child still counts toward its parent.
                            const subtaskCounts = new Map<string, number>();
                            for (const dbT of dbTickets) {
                                if (dbT.sourceId !== provider) { continue; }
                                if (!fs.existsSync(dbT.filePath)) { continue; }
                                try {
                                    const content = fs.readFileSync(dbT.filePath, 'utf8');
                                    const fm = content.match(/^---\n([\s\S]*?)\n---/);
                                    if (!fm) { continue; }
                                    const pm = fm[1].match(/^parentId:\s*(.+)$/m);
                                    if (!pm) { continue; }
                                    const pid = pm[1].trim();
                                    if (pid) {
                                        subtaskCounts.set(pid, (subtaskCounts.get(pid) || 0) + 1);
                                    }
                                } catch { /* unreadable file contributes nothing */ }
                            }

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
                                    const ticketId = dbT.remoteDocId || dbT.slugPrefix.replace(`${provider}_`, '');
                                    tickets.push({
                                        id: ticketId,
                                        title: dbT.docName,
                                        status: clickStatus || kanbanColumn || '',
                                        filePath: dbT.filePath,
                                        lastSyncedAt: dbT.lastSyncedAt,
                                        syncStatus,
                                        url: dbT.url || '',
                                        dateCreated,
                                        assignees,
                                        priority,
                                        // Locally-imported children only. 0 is meaningful ("no
                                        // subtasks"); the webview renders nothing for 0.
                                        subtaskCount: subtaskCounts.get(ticketId) || 0
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
                    // Unfiltered scan first, purely to tally children per parent — the
                    // filtered scan below drops them before they can be counted.
                    const allForCounting: any[] = [];
                    for (const dir of ticketDirs) {
                        this._scanLocalTicketFiles(dir, provider, allForCounting);
                    }
                    const fallbackCounts = new Map<string, number>();
                    for (const t of allForCounting) {
                        if (t.parentId) { fallbackCounts.set(t.parentId, (fallbackCounts.get(t.parentId) || 0) + 1); }
                    }
                    for (const dir of ticketDirs) {
                        this._scanLocalTicketFiles(dir, provider, tickets, { scopeId, skipSubtasks: true });
                    }
                    for (const t of tickets) { t.subtaskCount = fallbackCounts.get(t.id) || 0; }
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
                    // Genuine caller/programming error — NOT 'not-imported'. A missing id
                    // warrants a visible toast, so this arm carries a plain error and no
                    // quiet-listed reason.
                    const res = { type: 'localTicketFileRead', provider, id, success: false, error: 'readLocalTicketFile: missing workspaceRoot, provider, or id' };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
                const filePath = await this._findTicketFilePath(workspaceRoot, provider, id);
                if (!filePath) {
                    const res = { type: 'localTicketFileRead', provider, id, success: false, reason: 'not-imported', error: `No local file for ${id} yet — showing the live view. Refetch the list to download it.` };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
                const payload = this._readTicketFilePayload(filePath, provider, id);
                if (!payload) {
                    const res = { type: 'localTicketFileRead', provider, id, success: false, reason: 'not-imported', error: `Local file for ${id} exists but could not be read — showing the live view. Refetch the list to restore it.` };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
                const res = { type: 'localTicketFileRead', provider, id, success: true, ...payload };
                this.postMessageToWebview(res);
                return { ...res, success: true };
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
                        // markdown.api.render is a VS Code built-in and is unavailable on hosts
                        // without it (e.g. standalone). The webview renders the source markdown itself.
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
                    if (kind === 'deleted') {
                        try {
                            await this._seams().commands.executeCommand(
                                'switchboard.removeLocalTicket',
                                { workspaceRoot, provider: 'linear', id: issueId }
                            );
                        } catch { /* best-effort cleanup */ }
                    }
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
                        // markdown.api.render is a VS Code built-in and is unavailable on hosts
                        // without it (e.g. standalone). The webview renders the source markdown itself.
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
                    // When the ticket is gone from the remote (404), reconcile locally:
                    // delete the local file + DB entry so the sidebar drops it, instead
                    // of leaving a ghost that shows "may have been deleted" on every click.
                    if (kind === 'deleted') {
                        try {
                            await this._seams().commands.executeCommand(
                                'switchboard.removeLocalTicket',
                                { workspaceRoot, provider: 'clickup', id: msg.taskId }
                            );
                        } catch { /* best-effort cleanup */ }
                    }
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
            case 'pushTicketWithSubtasks': {
                const workspaceRoot = this._resolveWorkspaceRoot(msg.workspaceRoot);
                const { provider, id } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.pushTicketEditsWithSubtasks',
                        { workspaceRoot, provider, id }
                    );
                    // The command seam swallows exceptions and returns undefined on a
                    // miss (hostSeams.ts:327-336), which is indistinguishable from
                    // "not registered". Default every count and treat a wholly-absent
                    // result as a failure with a distinct message — otherwise a
                    // mis-registration reads to the user as "0 pushed, 0 failed".
                    if (!result?.success) {
                        this._seams().ui.showErrorMessage(
                            `Push to ${provider} incomplete: ${result?.error || 'unknown error'}`
                        );
                    }
                    const res = {
                        type: 'pushTicketResult' as const,
                        id,
                        workspaceRoot,
                        success: !!result?.success,
                        pushed: result?.pushed ?? 0,
                        skippedStale: result?.skippedStale ?? 0,
                        failed: result?.failed ?? 0,
                        message: result?.message,
                        error: result?.error
                    };
                    this.postMessageToWebview(res);
                    // Return the body (PRD contract #4): an HTTP caller gets the
                    // counts, not just the webview. Unlike the pushTicket arm above,
                    // which ends in `break`, this arm returns.
                    return { ...res, success: !!result?.success };
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    this._seams().ui.showErrorMessage(`Push to ${provider} failed: ${errMsg}`);
                    const res = {
                        type: 'pushTicketResult' as const,
                        id,
                        workspaceRoot,
                        success: false,
                        pushed: 0,
                        skippedStale: 0,
                        failed: 0,
                        message: '',
                        error: errMsg
                    };
                    this.postMessageToWebview(res);
                    return { ...res, success: false };
                }
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
                    try {
                        if (!this._cacheService) {
                            this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                        }
                        // Re-read the entry: importTaskAsDocument may have renamed the file if the
                        // title changed. Resolve by id, not by the pre-write path.
                        const refreshed = (await this._cacheService.getImportedTickets())
                            .find((t: any) => t.slugPrefix === `${provider}_${id}`);
                        if (refreshed) {
                            await this._cacheService.registerImportedTicket(
                                provider, id, refreshed.docName, refreshed.slugPrefix,
                                refreshed.filePath, '', undefined, refreshed.url
                            );
                        }
                    } catch (regErr) {
                        console.warn('[TicketsPanel] importTicketSubtasks: failed to restamp last_synced_at:', regErr);
                    }
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
                    // The remote is now correct. Mirror the parent into the local .md so the
                    // file-backed sidebar hides it as a subtask on the next list. Without this
                    // the sidebar refreshes but reads unchanged data — the reported bug.
                    let localFileUpdated = false;
                    // Distinct from `!localFileUpdated`: that also means "this ticket was
                    // never imported locally", which is normal. A throw here is a real
                    // failure (read-only FS, permissions) and the sidebar IS now stale —
                    // the webview must say so instead of claiming there was no file.
                    let localFileStampFailed = false;
                    try {
                        if (!this._cacheService) {
                            this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                        }
                        const imported = await this._cacheService.getImportedTickets();
                        const row = imported.find((t: any) => t.slugPrefix === `${msg.provider}_${msg.taskId}`);
                        if (row?.filePath) {
                            localFileUpdated = this._stampTicketParentIdInFile(row.filePath, msg.parentId);
                            if (localFileUpdated) {
                                // The rewrite bumps mtime. syncStatus is derived from
                                // mtime vs lastSyncedAt, so without this the ticket would
                                // falsely badge as `modified` — it has no unpushed edits.
                                await this._cacheService.registerImportedTicket(
                                    msg.provider, msg.taskId, row.docName,
                                    row.slugPrefix, row.filePath,
                                    row.contentHash || '',
                                    undefined,
                                    row.url || undefined
                                );
                            }
                        }
                    } catch (err) {
                        localFileStampFailed = true;
                        console.error('[TicketsPanelProvider] convertToSubtask: local file stamp failed:', err);
                    }
                    this.postMessageToWebview({
                        type: 'subtaskConverted',
                        success: true,
                        provider: msg.provider,
                        taskId: msg.taskId,
                        parentId: msg.parentId,
                        localFileUpdated,
                        localFileStampFailed,
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
                const { provider, url, filename, ticketId, ticketTitle, attachmentId } = msg;
                try {
                    const result: any = await this._seams().commands.executeCommand(
                        'switchboard.downloadAttachment',
                        { workspaceRoot, provider, url, filename, ticketId, ticketTitle, attachmentId }
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
                    // webviewUri prefers the loopback asset route: `_buildLocalAssetUrl`
                    // emits an allow-listed http://127.0.0.1:<port>/design/asset URL that
                    // satisfies BOTH hosts (tickets.html's meta CSP already permits
                    // http://127.0.0.1:*), so the browser cockpit can finally preview a
                    // downloaded image. asWebviewUri stays as the fallback for a VS Code
                    // panel with no API server running. Headless with no port and no panel
                    // still yields no webviewUri — the preview branch just stays off.
                    if (Array.isArray(result)) {
                        const imageExts = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp'];
                        result = result.map((att: any) => {
                            if (!att.isDownloaded || !att.localPath) { return att; }
                            if (!imageExts.includes(path.extname(att.localPath).toLowerCase())) { return att; }
                            const uri = this._buildLocalAssetUrl(att.localPath)
                                || (targetPanel?.webview
                                    ? targetPanel.webview.asWebviewUri(vscode.Uri.file(att.localPath)).toString()
                                    : undefined);
                            if (uri) { att.webviewUri = uri; }
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
                    // Re-arm the auto-sync engine now that the timer's
                    // precondition (a known selection) is satisfied. Idempotent.
                    try { this._updateTicketsAutoSyncWatcher(workspaceRoot, await this._getTicketsAutoSync(workspaceRoot)); } catch { /* keep */ }
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

                    // Only push tickets that actually differ from what we last pulled. Pushing an
                    // unmodified file is not a no-op: push is a FULL description replacement, so a
                    // stale file overwrites newer remote work — ~250 overwrites per click here.
                    let dbTickets: any[] = [];
                    try {
                        if (!this._cacheService) {
                            this._cacheService = this._adapterFactories.getCacheService(workspaceRoot);
                        }
                        dbTickets = await this._cacheService.getImportedTickets();
                    } catch (e) {
                        // If the cache is unreachable, fall back to pushing everything —
                        // Sync All is a deliberate user action, not a background timer.
                        console.warn('[TicketsPanelProvider] syncAllTickets: could not load cache for sync-status filter, pushing all:', e);
                    }
                    const bySlug = new Map(dbTickets.map((t: any) => [t.slugPrefix, t]));
                    const pushable = uniqueTickets.filter(t => {
                        const e: any = bySlug.get(`${provider}_${t.id}`);
                        if (!e) { return true; }   // never pulled — local-only, push it
                        return this._ticketSyncStatusFromTimestamps(t.filePath, e.lastSyncedAt) !== 'synced';
                    });
                    const skippedCount = uniqueTickets.length - pushable.length;

                    // Bounded concurrency: push up to 4 tickets at a time so total wall time
                    // is ~ceil(N/4) × per-ticket latency instead of N × per-ticket latency.
                    const CONCURRENCY = 4;
                    let done = 0;
                    const total = pushable.length;
                    for (let i = 0; i < pushable.length; i += CONCURRENCY) {
                        const batch = pushable.slice(i, i + CONCURRENCY);
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
                        skipped: skippedCount,
                        errors: results.errors
                    });
                } else {
                    this.postMessageToWebview({
                        type: 'syncAllTicketsResult',
                        success: false,
                        count: 0,
                        succeeded: 0,
                        failed: 0,
                        skipped: 0,
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
            case 'linearStartOAuth': {
                const result = await this._taskViewerProvider!.handleLinearStartOAuth(
                    msg.workspaceRoot,
                    msg.redirectUri
                );
                this._pushTo(targetPanel, 'tickets', { type: 'linearStartOAuthResult', ...result });
                return result;
            }
            case 'linearExchangeOAuth': {
                const result = await this._taskViewerProvider!.handleLinearExchangeOAuth(
                    msg.code,
                    msg.codeVerifier,
                    msg.redirectUri,
                    msg.workspaceRoot
                );
                this._pushTo(targetPanel, 'tickets', { type: 'linearExchangeOAuthResult', ...result });
                await this._taskViewerProvider!.postSetupPanelState();
                await this._seams().commands.executeCommand('switchboard.refreshUI');
                return result;
            }
            case 'linearDisconnectOAuth': {
                const result = await this._taskViewerProvider!.handleLinearDisconnectOAuth(
                    msg.workspaceRoot
                );
                this._pushTo(targetPanel, 'tickets', { type: 'linearDisconnectOAuthResult', ...result });
                await this._taskViewerProvider!.postSetupPanelState();
                await this._seams().commands.executeCommand('switchboard.refreshUI');
                return result;
            }
            case 'linearCheckAdmin': {
                const result = await this._taskViewerProvider!.handleLinearCheckAdmin(
                    msg.workspaceRoot
                );
                this._pushTo(targetPanel, 'tickets', { type: 'linearCheckAdminResult', ...result });
                return result;
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
        for (const w of this._ticketsViewNativeWatchers) { try { w.close(); } catch { } }
        this._ticketsViewNativeWatchers = [];
        for (const t of this._ticketsViewWatcherDebounces.values()) { clearTimeout(t); }
        this._ticketsViewWatcherDebounces.clear();
        this._ticketsViewWatcherRoot = undefined;
        this._ticketsViewWatcherFolders = [];
        // Auto-sync engine teardown (moved from PlanningPanelProvider.dispose).
        for (const watcher of this._ticketsAutoSyncWatchers.values()) {
            try { watcher.dispose(); } catch (e) {}
        }
        this._ticketsAutoSyncWatchers.clear();
        for (const t of this._ticketsAutoSyncDebounces.values()) { clearTimeout(t); }
        this._ticketsAutoSyncDebounces.clear();
        // Tear down delta-pull timers.
        for (const t of this._ticketsAutoSyncTimers.values()) { clearInterval(t); }
        this._ticketsAutoSyncTimers.clear();
        this._ticketsAutoSyncFailures.clear();
        this._ticketsAutoSyncNextEligible.clear();
        this._ticketsCurrentSelection.clear();
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
