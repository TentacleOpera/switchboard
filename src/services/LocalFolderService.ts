import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { KanbanDatabase } from './KanbanDatabase';

export interface LocalFolderConfig {
    selectedFile: string;       // relative path within the configured folder
    docTitle: string;
    setupComplete: boolean;
    lastFetchAt: string | null;
}

export interface LocalFolderPathsConfig {
    localFolderPaths: string[];
    htmlFolderPaths: string[];
    designFolderPaths: string[];
    ticketsFolderPaths: string[];
    imagesFolderPaths: string[];
    stitchFolderPaths: string[];
    briefsFolderPaths: string[];
    ticketsAutoSync?: boolean;
}

export class LocalFolderService {
    private _rawWorkspaceRoot: string;
    private _effectiveWorkspaceRoot: string;
    private _configPath: string;
    private _cachePath: string;
    private _folderPathsCache: LocalFolderPathsConfig | null = null;

    private static readonly _EXCLUDED_DIRS = new Set(['node_modules', '.git', '.switchboard']);
    private static readonly _MAX_DEPTH = 10;
    private static readonly _TITLE_EXTRACTION_FILE_LIMIT = 200;
    private static readonly _ANTIGRAVITY_BRAIN_PATHS = [
        path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
        path.join(os.homedir(), '.gemini', 'antigravity-ide', 'brain'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    ];

    constructor(workspaceRoot: string) {
        this._rawWorkspaceRoot = workspaceRoot;
        let effective = workspaceRoot;
        try {
            const { resolveEffectiveWorkspaceRootFromMappings } = require('../services/WorkspaceIdentityService');
            effective = resolveEffectiveWorkspaceRootFromMappings(workspaceRoot);
        } catch { /* outside extension host or module unavailable */ }
        this._effectiveWorkspaceRoot = effective;
        this._configPath = path.join(effective, '.switchboard', 'local-folder-config.json');
        this._cachePath = path.join(effective, '.switchboard', 'local-folder-cache.md');
        this.loadFolderPathsConfig().then(cfg => {
            this._folderPathsCache = cfg;
        }).catch(() => {});
    }

    private _assertAllowedWrite(): void {
        try {
            const { isAllowedSwitchboardLocation } = require('../utils/switchboardLocationGuard');
            if (!isAllowedSwitchboardLocation(this._effectiveWorkspaceRoot, this._rawWorkspaceRoot)) {
                throw new Error('Blocked: attempted to write .switchboard data to a child workspace folder');
            }
        } catch (err) {
            if (err instanceof Error && err.message.startsWith('Blocked:')) {
                throw err;
            }
            // Guard unavailable — log warning but allow write to proceed
            console.warn('[LocalFolderService] isAllowedSwitchboardLocation guard unavailable, allowing write to', this._effectiveWorkspaceRoot);
        }
    }

    // ── Config ──────────────────────────────────────────────────

    async loadConfig(): Promise<LocalFolderConfig | null> {
        try {
            const db = KanbanDatabase.forWorkspace(this._effectiveWorkspaceRoot);
            return await db.getConfigJson<LocalFolderConfig | null>('folders.config', null);
        } catch { return null; }
    }

    async saveConfig(config: LocalFolderConfig): Promise<void> {
        this._assertAllowedWrite();
        const db = KanbanDatabase.forWorkspace(this._effectiveWorkspaceRoot);
        let existing = await this.loadConfig() || {};
        const merged = { ...existing, ...config };
        await db.setConfigJson('folders.config', merged);
    }

    async loadFolderPathsConfig(): Promise<LocalFolderPathsConfig> {
        try {
            const db = KanbanDatabase.forWorkspace(this._effectiveWorkspaceRoot);
            const parsed = await db.getConfigJson<any>('folders.paths', null);
            if (!parsed) return {
                localFolderPaths: [],
                htmlFolderPaths: [],
                designFolderPaths: [],
                ticketsFolderPaths: [],
                imagesFolderPaths: [],
                stitchFolderPaths: [],
                briefsFolderPaths: [],
                ticketsAutoSync: false
            };
            return {
                localFolderPaths: parsed.localFolderPaths || [],
                htmlFolderPaths: parsed.htmlFolderPaths || [],
                designFolderPaths: parsed.designFolderPaths || [],
                ticketsFolderPaths: parsed.ticketsFolderPaths || [],
                imagesFolderPaths: parsed.imagesFolderPaths || [],
                stitchFolderPaths: parsed.stitchFolderPaths || [],
                briefsFolderPaths: parsed.briefsFolderPaths || [],
                ticketsAutoSync: parsed.ticketsAutoSync === true
            };
        } catch {
            return {
                localFolderPaths: [],
                htmlFolderPaths: [],
                designFolderPaths: [],
                ticketsFolderPaths: [],
                imagesFolderPaths: [],
                stitchFolderPaths: [],
                briefsFolderPaths: [],
                ticketsAutoSync: false
            };
        }
    }

    async saveFolderPathsConfig(config: LocalFolderPathsConfig): Promise<void> {
        this._assertAllowedWrite();
        const db = KanbanDatabase.forWorkspace(this._effectiveWorkspaceRoot);
        const { _migratedLocal, _migratedHtml, _migratedDesign, _migratedTickets, _migratedImages, _migratedStitch, _migratedBriefs, ...cleanConfig } = config as any;
        await db.setConfigJson('folders.paths', cleanConfig);
        this._folderPathsCache = cleanConfig;
    }

    async loadCachedContent(): Promise<string | null> {
        try {
            return await fs.promises.readFile(this._cachePath, 'utf8');
        } catch { return null; }
    }

    async saveCachedContent(markdown: string): Promise<void> {
        this._assertAllowedWrite();
        await fs.promises.mkdir(path.dirname(this._cachePath), { recursive: true });
        await fs.promises.writeFile(this._cachePath, markdown, 'utf8');
    }

    /** Read the legacy singular setting; returns the raw string or empty string. */
    private _getLegacyFolderPath(): string {
        const config = vscode.workspace.getConfiguration('switchboard');
        return config.get<string>('research.localFolderPath', '');
    }

    private _getOrLoadCachedConfig(): LocalFolderPathsConfig {
        if (this._folderPathsCache) {
            return this._folderPathsCache;
        }
        // Async constructor init hasn't resolved yet — try sync db read
        try {
            const db = KanbanDatabase.forWorkspace(this._effectiveWorkspaceRoot);
            const parsed = db.getConfigJsonSync<any>('folders.paths', null);
            if (parsed) {
                const cfg: LocalFolderPathsConfig = {
                    localFolderPaths: parsed.localFolderPaths || [],
                    htmlFolderPaths: parsed.htmlFolderPaths || [],
                    designFolderPaths: parsed.designFolderPaths || [],
                    ticketsFolderPaths: parsed.ticketsFolderPaths || [],
                    imagesFolderPaths: parsed.imagesFolderPaths || [],
                    stitchFolderPaths: parsed.stitchFolderPaths || [],
                    briefsFolderPaths: parsed.briefsFolderPaths || [],
                    ticketsAutoSync: parsed.ticketsAutoSync === true
                };
                this._folderPathsCache = cfg;
                return cfg;
            }
        } catch { /* db not ready yet */ }
        return {
            localFolderPaths: [],
            htmlFolderPaths: [],
            designFolderPaths: [],
            ticketsFolderPaths: [],
            imagesFolderPaths: [],
            stitchFolderPaths: [],
            briefsFolderPaths: [],
            ticketsAutoSync: false
        };
    }

    // ── Folder Path Resolution (matches kanban.dbPath pattern) ──

    resolveFolderPath(folderPath: string): string {
        const trimmed = (folderPath || '').trim();
        if (!trimmed) { return ''; }
        const expanded = trimmed.startsWith('~')
            ? path.join(os.homedir(), trimmed.slice(1))
            : trimmed;
        return path.isAbsolute(expanded) ? expanded : path.join(this._rawWorkspaceRoot, expanded);
    }

    getFolderPaths(): string[] {
        const cfg = this._getOrLoadCachedConfig();


        const seen = new Set<string>();
        return (cfg.localFolderPaths || [])
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getFolderPath(): string {
        const paths = this.getFolderPaths();
        return paths[0] ?? '';
    }

    async addFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.localFolderPaths || [];

        const resolvedInput = this.resolveFolderPath(folderPath);
        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            cfg.localFolderPaths = [...currentPaths, folderPath];
            await this.saveFolderPathsConfig(cfg);
        }
    }

    async removeFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.localFolderPaths || [];

        const resolvedToRemove = this.resolveFolderPath(folderPath);
        cfg.localFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await this.saveFolderPathsConfig(cfg);
    }

    // ── File Listing ────────────────────────────────────────────

    async listFiles(): Promise<Array<{
        id: string;
        name: string;
        relativePath: string;
        isFolder?: boolean;
        parentId?: string;
        sourceFolder: string;
        title?: string;
        createdMs?: number;
        mtimeMs?: number;
    }>> {
        const folderPaths = this.getFolderPaths();
        if (folderPaths.length === 0) { return []; }

        const items: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
            createdMs?: number;
            mtimeMs?: number;
        }> = [];

        const seenAbsolutePaths = new Set<string>();

        for (let i = 0; i < folderPaths.length; i++) {
            const folderPath = folderPaths[i];
            try {
                const stat = await fs.promises.stat(folderPath);
                if (!stat.isDirectory()) { continue; }
            } catch { continue; }

            await this._scanFolder(folderPath, folderPath, items, null, i, seenAbsolutePaths, 0);
        }

        return items;
    }

    private async _scanFolder(
        root: string,
        current: string,
        results: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
            createdMs?: number;
            mtimeMs?: number;
        }>,
        parentId: string | null,
        folderIndex: number,
        seenAbsolutePaths: Set<string>,
        depth: number = 0
    ): Promise<void> {
        if (depth >= LocalFolderService._MAX_DEPTH) { return; }

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch { return; }

        const subfolderScans: Promise<void>[] = [];

        for (const entry of entries) {
            if (entry.name.startsWith('.')) { continue; }
            if (entry.isSymbolicLink()) { continue; }
            if (entry.isDirectory() && LocalFolderService._EXCLUDED_DIRS.has(entry.name)) { continue; }

            const fullPath = path.join(current, entry.name);
            const resolvedPath = path.resolve(fullPath);

            if (seenAbsolutePaths.has(resolvedPath)) { continue; }
            seenAbsolutePaths.add(resolvedPath);

            const relativePath = path.relative(root, fullPath);
            const id = `${folderIndex}:${relativePath}`;
            const parentIdVal = parentId ? `${folderIndex}:${parentId}` : undefined;

            if (entry.isDirectory()) {
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: true,
                    parentId: parentIdVal,
                    sourceFolder: root
                });
                subfolderScans.push(
                    this._scanFolder(root, fullPath, results, relativePath, folderIndex, seenAbsolutePaths, depth + 1)
                );
            } else if (entry.isFile() && this._isTextFile(entry.name)) {
                // Capture creation time for descending-creation-date sorting in the docs tree.
                // birthtime is reliable on macOS (APFS) / Windows; where it's unavailable (0 or
                // older Linux filesystems) fall back to mtime so ordering is still sensible.
                let createdMs = 0;
                let mtimeMs = 0;
                try {
                    const st = await fs.promises.stat(fullPath);
                    mtimeMs = st.mtimeMs;
                    createdMs = (st.birthtimeMs && st.birthtimeMs > 0) ? st.birthtimeMs : st.mtimeMs;
                } catch { /* stat failure is non-critical */ }
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: false,
                    parentId: parentIdVal,
                    sourceFolder: root,
                    createdMs,
                    mtimeMs
                });
                if (results.length <= LocalFolderService._TITLE_EXTRACTION_FILE_LIMIT) {
                    try {
                        const buf = Buffer.alloc(1000);
                        const fd = await fs.promises.open(fullPath, 'r');
                        const { bytesRead } = await fd.read(buf, 0, 1000, 0);
                        await fd.close();
                        const head = buf.toString('utf8', 0, bytesRead);
                        // Extract first # Heading or frontmatter title/topic
                        const fmMatch = head.match(/^---\s*\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m) ||
                                        head.match(/^---\s*\n[\s\S]*?^topic:\s*["']?(.+?)["']?\s*$/m);
                        const h1Match = head.match(/^#\s+(.+)$/m);
                        const extractedTitle = fmMatch ? fmMatch[1].trim() : h1Match ? h1Match[1].trim() : undefined;
                        if (extractedTitle) {
                            results[results.length - 1].title = extractedTitle;
                        }
                    } catch { /* title extraction failure is non-critical */ }
                }
            }
        }

        await Promise.all(subfolderScans);
    }

    private _isTextFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.md', '.txt', '.markdown', '.rst', '.adoc'].includes(ext);
    }

    getHtmlFolderPaths(): string[] {
        const cfg = this._getOrLoadCachedConfig();


        const seen = new Set<string>();
        return (cfg.htmlFolderPaths || [])
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getHtmlFolderPath(): string {
        const paths = this.getHtmlFolderPaths();
        return paths[0] ?? '';
    }

    async addHtmlFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.htmlFolderPaths || [];
        const resolvedInput = this.resolveFolderPath(folderPath);

        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            cfg.htmlFolderPaths = [...currentPaths, folderPath];
            await this.saveFolderPathsConfig(cfg);
        }
    }

    async removeHtmlFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.htmlFolderPaths || [];
        const resolvedToRemove = this.resolveFolderPath(folderPath);

        cfg.htmlFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await this.saveFolderPathsConfig(cfg);
    }

    async listHtmlFiles(): Promise<Array<{
        id: string;
        name: string;
        relativePath: string;
        isFolder?: boolean;
        parentId?: string;
        sourceFolder: string;
        title?: string;
    }>> {
        const folderPaths = this.getHtmlFolderPaths();
        if (folderPaths.length === 0) { return []; }

        const items: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
        }> = [];

        const seenAbsolutePaths = new Set<string>();

        for (let i = 0; i < folderPaths.length; i++) {
            const folderPath = folderPaths[i];
            try {
                const stat = await fs.promises.stat(folderPath);
                if (!stat.isDirectory()) { continue; }
            } catch { continue; }

            await this._scanHtmlFolder(folderPath, folderPath, items, null, i, seenAbsolutePaths, 0);
        }

        return items;
    }

    private async _scanHtmlFolder(
        root: string,
        current: string,
        results: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
        }>,
        parentId: string | null,
        folderIndex: number,
        seenAbsolutePaths: Set<string>,
        depth: number = 0
    ): Promise<void> {
        if (depth >= LocalFolderService._MAX_DEPTH) { return; }

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch { return; }

        const subfolderScans: Promise<void>[] = [];

        for (const entry of entries) {
            if (entry.name.startsWith('.')) { continue; }
            if (entry.isSymbolicLink()) { continue; }
            if (entry.isDirectory() && LocalFolderService._EXCLUDED_DIRS.has(entry.name)) { continue; }

            const fullPath = path.join(current, entry.name);
            const resolvedPath = path.resolve(fullPath);

            if (seenAbsolutePaths.has(resolvedPath)) { continue; }
            seenAbsolutePaths.add(resolvedPath);

            const relativePath = path.relative(root, fullPath);
            const id = `${folderIndex}:${relativePath}`;
            const parentIdVal = parentId ? `${folderIndex}:${parentId}` : undefined;

            if (entry.isDirectory()) {
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: true,
                    parentId: parentIdVal,
                    sourceFolder: root
                });
                subfolderScans.push(
                    this._scanHtmlFolder(root, fullPath, results, relativePath, folderIndex, seenAbsolutePaths, depth + 1)
                );
            } else if (entry.isFile() && this._isHtmlOrImageFile(entry.name)) {
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: false,
                    parentId: parentIdVal,
                    sourceFolder: root
                });
                const ext = path.extname(entry.name).toLowerCase();
                if (['.html', '.htm'].includes(ext)) {
                    try {
                        const buf = Buffer.alloc(1000);
                        const fd = await fs.promises.open(fullPath, 'r');
                        const { bytesRead } = await fd.read(buf, 0, 1000, 0);
                        await fd.close();
                        const head = buf.toString('utf8', 0, bytesRead);
                        const titleMatch = head.match(/<title[^>]*>([^<]+)<\/title>/i);
                        if (titleMatch && titleMatch[1].trim()) {
                            results[results.length - 1].title = titleMatch[1].trim();
                        }
                    } catch { /* title extraction failure is non-critical */ }
                }
            }
        }

        await Promise.all(subfolderScans);
    }

    private _isHtmlOrImageFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.html', '.htm', '.png', '.jpg', '.jpeg', '.gif', '.svg'].includes(ext);
    }

    private _isImageFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico'].includes(ext);
    }

    async listImagesFiles(): Promise<Array<{
        id: string;
        name: string;
        relativePath: string;
        isFolder?: boolean;
        parentId?: string;
        sourceFolder: string;
        title?: string;
    }>> {
        const folderPaths = this.getImagesFolderPaths();
        if (folderPaths.length === 0) { return []; }

        const items: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
        }> = [];

        const seenAbsolutePaths = new Set<string>();

        for (let i = 0; i < folderPaths.length; i++) {
            const folderPath = folderPaths[i];
            try {
                const stat = await fs.promises.stat(folderPath);
                if (!stat.isDirectory()) { continue; }
            } catch { continue; }

            await this._scanImagesFolder(folderPath, folderPath, items, null, i, seenAbsolutePaths, 0);
        }

        return items;
    }

    private async _scanImagesFolder(
        root: string,
        current: string,
        results: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
        }>,
        parentId: string | null,
        folderIndex: number,
        seenAbsolutePaths: Set<string>,
        depth: number = 0
    ): Promise<void> {
        if (depth >= LocalFolderService._MAX_DEPTH) { return; }

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch { return; }

        const subfolderScans: Promise<void>[] = [];

        for (const entry of entries) {
            if (entry.name.startsWith('.')) { continue; }
            if (entry.isSymbolicLink()) { continue; }
            if (entry.isDirectory() && LocalFolderService._EXCLUDED_DIRS.has(entry.name)) { continue; }

            const fullPath = path.join(current, entry.name);
            const resolvedPath = path.resolve(fullPath);

            if (seenAbsolutePaths.has(resolvedPath)) { continue; }
            seenAbsolutePaths.add(resolvedPath);

            const relativePath = path.relative(root, fullPath);
            const id = `${folderIndex}:${relativePath}`;
            const parentIdVal = parentId ? `${folderIndex}:${parentId}` : undefined;

            if (entry.isDirectory()) {
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: true,
                    parentId: parentIdVal,
                    sourceFolder: root
                });
                subfolderScans.push(
                    this._scanImagesFolder(root, fullPath, results, relativePath, folderIndex, seenAbsolutePaths, depth + 1)
                );
            } else if (entry.isFile() && this._isImageFile(entry.name)) {
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: false,
                    parentId: parentIdVal,
                    sourceFolder: root
                });
            }
        }

        await Promise.all(subfolderScans);
    }

    getDesignFolderPaths(): string[] {
        const cfg = this._getOrLoadCachedConfig();


        const seen = new Set<string>();
        return (cfg.designFolderPaths || [])
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getDesignFolderPath(): string {
        const paths = this.getDesignFolderPaths();
        return paths[0] ?? '';
    }

    async addDesignFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.designFolderPaths || [];
        const resolvedInput = this.resolveFolderPath(folderPath);

        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            cfg.designFolderPaths = [...currentPaths, folderPath];
            await this.saveFolderPathsConfig(cfg);
        }
    }

    async removeDesignFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.designFolderPaths || [];
        const resolvedToRemove = this.resolveFolderPath(folderPath);

        cfg.designFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await this.saveFolderPathsConfig(cfg);
    }

    getTicketsFolderPaths(): string[] {
        const cfg = this._getOrLoadCachedConfig();


        const seen = new Set<string>();
        return (cfg.ticketsFolderPaths || [])
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getTicketsFolderPath(): string {
        const paths = this.getTicketsFolderPaths();
        return paths[0] ?? '';
    }

    async addTicketsFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.ticketsFolderPaths || [];
        const resolvedInput = this.resolveFolderPath(folderPath);

        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            cfg.ticketsFolderPaths = [...currentPaths, folderPath];
            await this.saveFolderPathsConfig(cfg);
        }
    }

    async removeTicketsFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.ticketsFolderPaths || [];
        const resolvedToRemove = this.resolveFolderPath(folderPath);

        cfg.ticketsFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await this.saveFolderPathsConfig(cfg);
    }

    getTicketsAutoSync(): boolean {
        return this._getOrLoadCachedConfig().ticketsAutoSync === true;
    }

    async setTicketsAutoSync(value: boolean): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        cfg.ticketsAutoSync = value;
        await this.saveFolderPathsConfig(cfg);
    }

    getImagesFolderPaths(): string[] {
        const cfg = this._getOrLoadCachedConfig();


        const seen = new Set<string>();
        return (cfg.imagesFolderPaths || [])
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getImagesFolderPath(): string {
        const paths = this.getImagesFolderPaths();
        return paths[0] ?? '';
    }

    async addImagesFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.imagesFolderPaths || [];
        const resolvedInput = this.resolveFolderPath(folderPath);

        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            cfg.imagesFolderPaths = [...currentPaths, folderPath];
            await this.saveFolderPathsConfig(cfg);
        }
    }

    async removeImagesFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.imagesFolderPaths || [];
        const resolvedToRemove = this.resolveFolderPath(folderPath);

        cfg.imagesFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await this.saveFolderPathsConfig(cfg);
    }

    getStitchFolderPaths(): string[] {
        const cfg = this._getOrLoadCachedConfig();


        const seen = new Set<string>();
        return (cfg.stitchFolderPaths || [])
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getStitchFolderPath(): string {
        const paths = this.getStitchFolderPaths();
        return paths[0] ?? '';
    }

    async addStitchFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.stitchFolderPaths || [];
        const resolvedInput = this.resolveFolderPath(folderPath);

        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            cfg.stitchFolderPaths = [...currentPaths, folderPath];
            await this.saveFolderPathsConfig(cfg);
        }
    }

    async removeStitchFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.stitchFolderPaths || [];
        const resolvedToRemove = this.resolveFolderPath(folderPath);

        cfg.stitchFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await this.saveFolderPathsConfig(cfg);
    }

    getBriefsFolderPaths(): string[] {
        const cfg = this._getOrLoadCachedConfig();


        const seen = new Set<string>();
        return (cfg.briefsFolderPaths || [])
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getBriefsFolderPath(): string {
        const paths = this.getBriefsFolderPaths();
        return paths[0] ?? '';
    }

    async addBriefsFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.briefsFolderPaths || [];
        const resolvedInput = this.resolveFolderPath(folderPath);

        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            cfg.briefsFolderPaths = [...currentPaths, folderPath];
            await this.saveFolderPathsConfig(cfg);
        }
    }

    async removeBriefsFolderPath(folderPath: string): Promise<void> {
        const cfg = await this.loadFolderPathsConfig();
        const currentPaths = cfg.briefsFolderPaths || [];
        const resolvedToRemove = this.resolveFolderPath(folderPath);

        cfg.briefsFolderPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await this.saveFolderPathsConfig(cfg);
    }

    async listBriefsFiles(): Promise<Array<{
        id: string;
        name: string;
        relativePath: string;
        isFolder?: boolean;
        parentId?: string;
        sourceFolder: string;
        title?: string;
    }>> {
        const folderPaths = this.getBriefsFolderPaths();
        if (folderPaths.length === 0) { return []; }

        const items: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
        }> = [];

        const seenAbsolutePaths = new Set<string>();

        for (let i = 0; i < folderPaths.length; i++) {
            const folderPath = folderPaths[i];
            try {
                const stat = await fs.promises.stat(folderPath);
                if (!stat.isDirectory()) { continue; }
            } catch { continue; }

            await this._scanFolder(folderPath, folderPath, items, null, i, seenAbsolutePaths, 0);
        }

        return items;
    }

    async listDesignFiles(): Promise<Array<{
        id: string;
        name: string;
        relativePath: string;
        isFolder?: boolean;
        parentId?: string;
        sourceFolder: string;
        title?: string;
    }>> {
        const folderPaths = this.getDesignFolderPaths();
        if (folderPaths.length === 0) { return []; }

        const items: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
        }> = [];

        const seenAbsolutePaths = new Set<string>();

        for (let i = 0; i < folderPaths.length; i++) {
            const folderPath = folderPaths[i];
            try {
                const stat = await fs.promises.stat(folderPath);
                if (!stat.isDirectory()) { continue; }
            } catch { continue; }

            await this._scanDesignFolder(folderPath, folderPath, items, null, i, seenAbsolutePaths, 0);
        }

        return items;
    }

    private async _scanDesignFolder(
        root: string,
        current: string,
        results: Array<{
            id: string;
            name: string;
            relativePath: string;
            isFolder?: boolean;
            parentId?: string;
            sourceFolder: string;
            title?: string;
        }>,
        parentId: string | null,
        folderIndex: number,
        seenAbsolutePaths: Set<string>,
        depth: number = 0
    ): Promise<void> {
        if (depth >= LocalFolderService._MAX_DEPTH) { return; }

        let entries: fs.Dirent[];
        try {
            entries = await fs.promises.readdir(current, { withFileTypes: true });
        } catch { return; }

        const subfolderScans: Promise<void>[] = [];

        for (const entry of entries) {
            if (entry.name.startsWith('.')) { continue; }
            if (entry.isSymbolicLink()) { continue; }
            if (entry.isDirectory() && LocalFolderService._EXCLUDED_DIRS.has(entry.name)) { continue; }

            const fullPath = path.join(current, entry.name);
            const resolvedPath = path.resolve(fullPath);

            if (seenAbsolutePaths.has(resolvedPath)) { continue; }
            seenAbsolutePaths.add(resolvedPath);

            const relativePath = path.relative(root, fullPath);
            const id = `${folderIndex}:${relativePath}`;
            const parentIdVal = parentId ? `${folderIndex}:${parentId}` : undefined;

            if (entry.isDirectory()) {
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: true,
                    parentId: parentIdVal,
                    sourceFolder: root
                });
                subfolderScans.push(
                    this._scanDesignFolder(root, fullPath, results, relativePath, folderIndex, seenAbsolutePaths, depth + 1)
                );
            } else if (entry.isFile() && this._isDesignOrImageFile(entry.name)) {
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: false,
                    parentId: parentIdVal,
                    sourceFolder: root
                });
                // Extract title for markdown if applicable
                const ext = path.extname(entry.name).toLowerCase();
                if (['.md', '.txt', '.markdown', '.rst', '.adoc'].includes(ext)) {
                    if (results.length <= LocalFolderService._TITLE_EXTRACTION_FILE_LIMIT) {
                        try {
                            const buf = Buffer.alloc(1000);
                            const fd = await fs.promises.open(fullPath, 'r');
                            const { bytesRead } = await fd.read(buf, 0, 1000, 0);
                            await fd.close();
                            const head = buf.toString('utf8', 0, bytesRead);
                            const fmMatch = head.match(/^---\s*\n[\s\S]*?^title:\s*["']?(.+?)["']?\s*$/m) ||
                                            head.match(/^---\s*\n[\s\S]*?^topic:\s*["']?(.+?)["']?\s*$/m);
                            const h1Match = head.match(/^#\s+(.+)$/m);
                            const extractedTitle = fmMatch ? fmMatch[1].trim() : h1Match ? h1Match[1].trim() : undefined;
                            if (extractedTitle) {
                                results[results.length - 1].title = extractedTitle;
                            }
                        } catch { /* title extraction failure is non-critical */ }
                    }
                }
            }
        }

        await Promise.all(subfolderScans);
    }

    private _isDesignOrImageFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return [
            // Documents
            '.md', '.txt', '.markdown', '.rst', '.adoc',
            // Images
            '.png', '.jpg', '.jpeg', '.gif', '.svg',
            // Structured data & design tokens
            '.json',
            // Stylesheets
            '.css', '.scss', '.less', '.sass',
            // Config / markup
            '.yaml', '.yml', '.xml'
        ].includes(ext);
    }

    // ── Delete ──────────────────────────────────────────────────

    async deleteFile(relativePath: string, sourceFolder?: string): Promise<{ success: boolean; error?: string }> {
        if (!sourceFolder) {
            return { success: false, error: 'sourceFolder is required' };
        }
        const resolvedSourceFolder = this.resolveFolderPath(sourceFolder);
        if (!this.getFolderPaths().includes(resolvedSourceFolder)) {
            return { success: false, error: 'sourceFolder is not a configured folder path' };
        }

        const fullPath = path.join(resolvedSourceFolder, relativePath);
        // Prevent path traversal
        const resolved = path.resolve(fullPath);
        if (!resolved.startsWith(path.resolve(resolvedSourceFolder))) {
            return { success: false, error: 'Invalid file path' };
        }

        try {
            await vscode.workspace.fs.delete(vscode.Uri.file(resolved), { useTrash: true, recursive: false });
            return { success: true };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }

    // ── Fetch ───────────────────────────────────────────────────

    async fetchDocContent(relativePath: string, sourceFolder?: string): Promise<{ success: boolean; docTitle?: string; content?: string; error?: string }> {
        if (!sourceFolder) {
            return { success: false, error: 'sourceFolder is required' };
        }
        const resolvedSourceFolder = this.resolveFolderPath(sourceFolder);
        if (!this.getFolderPaths().includes(resolvedSourceFolder)) {
            return { success: false, error: 'sourceFolder is not a configured folder path' };
        }

        const fullPath = path.join(resolvedSourceFolder, relativePath);
        // Prevent path traversal
        const resolved = path.resolve(fullPath);
        if (!resolved.startsWith(path.resolve(resolvedSourceFolder))) {
            return { success: false, error: 'Invalid file path' };
        }

        try {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            const docTitle = path.basename(relativePath, path.extname(relativePath));

            await this.saveConfig({
                selectedFile: relativePath,
                docTitle,
                setupComplete: true,
                lastFetchAt: new Date().toISOString()
            });
            await this.saveCachedContent(content);

            return { success: true, docTitle, content };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }

    detectAntigravityBrainPaths(): string[] {
        return LocalFolderService._ANTIGRAVITY_BRAIN_PATHS.filter(candidate => {
            try {
                const stat = fs.statSync(candidate);
                return stat.isDirectory();
            } catch { return false; }
        });
    }

    detectAntigravityBrainPath(): string | null {
        return this.detectAntigravityBrainPaths()[0] ?? null;
    }

    async listAntigravitySessions(): Promise<Array<{
        id: string;         // UUID folder name
        name: string;       // Display: first 8 chars of UUID
        timestamp: string;  // ISO string from folder mtime
        artifacts: Array<{ id: string; name: string; relativePath: string }>;
    }>> {
        const brainPaths = this.detectAntigravityBrainPaths();
        if (brainPaths.length === 0) { return []; }

        const seenIds = new Set<string>();
        const sessions = [];

        for (const brainPath of brainPaths) {
            let sessionDirs: fs.Dirent[];
            try {
                sessionDirs = await fs.promises.readdir(brainPath, { withFileTypes: true });
            } catch { continue; }

            for (const entry of sessionDirs) {
                if (!entry.isDirectory()) { continue; }
                if (seenIds.has(entry.name)) { continue; }
                // UUID pattern: 8-4-4-4-12 hex chars
                if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.name)) { continue; }

                const sessionDir = path.join(brainPath, entry.name);
                let mtime = new Date();
                try {
                    const stat = await fs.promises.stat(sessionDir);
                    mtime = stat.mtime;
                } catch { /* use default */ }

                // Enumerate .md artifacts within the session (skip .metadata.json sidecars)
                let artifacts: Array<{ id: string; name: string; relativePath: string }> = [];
                try {
                    const files = await fs.promises.readdir(sessionDir);
                    artifacts = files
                        .filter(f => f.endsWith('.md') && !f.includes('.metadata'))
                        .map(f => ({
                            id: path.join(sessionDir, f),    // absolute path used as id for fetchDocContent
                            name: f.replace(/\.md$/, ''),     // e.g. "task", "walkthrough"
                            relativePath: path.join(entry.name, f)
                        }));
                } catch { /* skip */ }

                if (artifacts.length === 0) { continue; } // Skip sessions with no displayable artifacts

                seenIds.add(entry.name);
                sessions.push({
                    id: entry.name,
                    name: entry.name.slice(0, 8),
                    timestamp: mtime.toISOString(),
                    artifacts
                });
            }
        }

        // Newest first
        sessions.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
        return sessions;
    }

    async fetchAntigravityArtifact(absolutePath: string): Promise<{ success: boolean; content?: string; error?: string }> {
        const brainPaths = this.detectAntigravityBrainPaths();
        if (brainPaths.length === 0) { return { success: false, error: 'Antigravity brain not detected' }; }

        // Security: validate path stays within brain directory (use separator to prevent prefix bypass)
        const resolved = path.resolve(absolutePath);
        const isValid = brainPaths.some(brainPath => {
            const brainResolved = path.resolve(brainPath);
            return resolved === brainResolved || resolved.startsWith(brainResolved + path.sep);
        });
        if (!isValid) {
            return { success: false, error: 'Invalid path' };
        }

        try {
            const content = await fs.promises.readFile(resolved, 'utf8');
            return { success: true, content };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }
}
