import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

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
    _migratedLocal?: boolean;
    _migratedHtml?: boolean;
    _migratedDesign?: boolean;
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
    }

    private _assertAllowedWrite(targetDir: string): void {
        try {
            const { isAllowedSwitchboardLocation } = require('../utils/switchboardLocationGuard');
            if (!isAllowedSwitchboardLocation(targetDir, this._rawWorkspaceRoot)) {
                throw new Error('Blocked: attempted to write .switchboard data to a child workspace folder');
            }
        } catch (err) {
            if (err instanceof Error && err.message.startsWith('Blocked:')) {
                throw err;
            }
            // Guard unavailable — log warning but allow write to proceed
            console.warn('[LocalFolderService] isAllowedSwitchboardLocation guard unavailable, allowing write to', targetDir);
        }
    }

    // ── Config ──────────────────────────────────────────────────

    async loadConfig(): Promise<LocalFolderConfig | null> {
        try {
            const content = await fs.promises.readFile(this._configPath, 'utf8');
            const parsed = JSON.parse(content);
            // Strip folder-path and migration fields so they don't leak into LocalFolderConfig consumers
            const { localFolderPaths, htmlFolderPaths, designFolderPaths, _migrated, _migratedLocal, _migratedHtml, _migratedDesign, ...rest } = parsed;
            return rest;
        } catch { return null; }
    }

    async saveConfig(config: LocalFolderConfig): Promise<void> {
        this._assertAllowedWrite(path.dirname(this._configPath));
        await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
        let existing: any = {};
        try {
            existing = JSON.parse(await fs.promises.readFile(this._configPath, 'utf8'));
        } catch { /* file may not exist yet */ }
        const merged = { ...existing, ...config };
        await fs.promises.writeFile(this._configPath, JSON.stringify(merged, null, 2));
    }

    async loadFolderPathsConfig(): Promise<LocalFolderPathsConfig> {
        try {
            const content = await fs.promises.readFile(this._configPath, 'utf8');
            const parsed = JSON.parse(content);
            return {
                localFolderPaths: parsed.localFolderPaths || [],
                htmlFolderPaths: parsed.htmlFolderPaths || [],
                designFolderPaths: parsed.designFolderPaths || [],
                _migratedLocal: parsed._migratedLocal || false,
                _migratedHtml: parsed._migratedHtml || false,
                _migratedDesign: parsed._migratedDesign || false
            };
        } catch {
            return { localFolderPaths: [], htmlFolderPaths: [], designFolderPaths: [], _migratedLocal: false, _migratedHtml: false, _migratedDesign: false };
        }
    }

    async saveFolderPathsConfig(config: LocalFolderPathsConfig): Promise<void> {
        this._assertAllowedWrite(path.dirname(this._configPath));
        await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
        let existing: any = {};
        try {
            existing = JSON.parse(await fs.promises.readFile(this._configPath, 'utf8'));
        } catch { /* file may not exist yet */ }
        const merged = { ...existing, ...config };
        await fs.promises.writeFile(this._configPath, JSON.stringify(merged, null, 2));
        this._folderPathsCache = config;
    }

    async loadCachedContent(): Promise<string | null> {
        try {
            return await fs.promises.readFile(this._cachePath, 'utf8');
        } catch { return null; }
    }

    async saveCachedContent(markdown: string): Promise<void> {
        this._assertAllowedWrite(path.dirname(this._cachePath));
        await fs.promises.mkdir(path.dirname(this._cachePath), { recursive: true });
        await fs.promises.writeFile(this._cachePath, markdown, 'utf8');
    }

    /** Read the legacy singular setting; returns the raw string or empty string. */
    private _getLegacyFolderPath(): string {
        const config = vscode.workspace.getConfiguration('switchboard');
        return config.get<string>('research.localFolderPath', '');
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
        let cfg = this._folderPathsCache;
        if (!cfg) {
            try {
                const content = fs.readFileSync(this._configPath, 'utf8');
                const parsed = JSON.parse(content);
                cfg = {
                    localFolderPaths: parsed.localFolderPaths || [],
                    htmlFolderPaths: parsed.htmlFolderPaths || [],
                    designFolderPaths: parsed.designFolderPaths || [],
                    _migratedLocal: parsed._migratedLocal || false,
                    _migratedHtml: parsed._migratedHtml || false,
                    _migratedDesign: parsed._migratedDesign || false
                };
            } catch {
                cfg = { localFolderPaths: [], htmlFolderPaths: [], designFolderPaths: [], _migratedLocal: false, _migratedHtml: false, _migratedDesign: false };
            }
            this._folderPathsCache = cfg;
        }

        // One-time migration from global settings
        if (!cfg._migratedLocal) {
            const config = vscode.workspace.getConfiguration('switchboard');
            const globalPaths = config.get<string[]>('research.localFolderPaths', []);
            const legacyPath = config.get<string>('research.localFolderPath', '');
            const merged = [...globalPaths];
            if (legacyPath && !merged.includes(legacyPath)) {
                merged.push(legacyPath);
            }
            cfg.localFolderPaths = merged;
            cfg._migratedLocal = true;
            this._folderPathsCache = cfg;
            // Persist and clear global settings asynchronously
            this.saveFolderPathsConfig(cfg).then(() => {
                config.update('research.localFolderPaths', undefined, vscode.ConfigurationTarget.Global);
                config.update('research.localFolderPath', undefined, vscode.ConfigurationTarget.Global);
            }).catch(() => {});
        }

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
                results.push({
                    id,
                    name: entry.name,
                    relativePath,
                    isFolder: false,
                    parentId: parentIdVal,
                    sourceFolder: root
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
        let cfg = this._folderPathsCache;
        if (!cfg) {
            try {
                const content = fs.readFileSync(this._configPath, 'utf8');
                const parsed = JSON.parse(content);
                cfg = {
                    localFolderPaths: parsed.localFolderPaths || [],
                    htmlFolderPaths: parsed.htmlFolderPaths || [],
                    designFolderPaths: parsed.designFolderPaths || [],
                    _migratedLocal: parsed._migratedLocal || false,
                    _migratedHtml: parsed._migratedHtml || false,
                    _migratedDesign: parsed._migratedDesign || false
                };
            } catch {
                cfg = { localFolderPaths: [], htmlFolderPaths: [], designFolderPaths: [], _migratedLocal: false, _migratedHtml: false, _migratedDesign: false };
            }
            this._folderPathsCache = cfg;
        }

        if (!cfg._migratedHtml) {
            const config = vscode.workspace.getConfiguration('switchboard');
            const globalPaths = config.get<string[]>('research.htmlFolderPaths', []);
            cfg.htmlFolderPaths = globalPaths;
            cfg._migratedHtml = true;
            this._folderPathsCache = cfg;
            this.saveFolderPathsConfig(cfg).then(() => {
                config.update('research.htmlFolderPaths', undefined, vscode.ConfigurationTarget.Global);
            }).catch(() => {});
        }

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

    getDesignFolderPaths(): string[] {
        let cfg = this._folderPathsCache;
        if (!cfg) {
            try {
                const content = fs.readFileSync(this._configPath, 'utf8');
                const parsed = JSON.parse(content);
                cfg = {
                    localFolderPaths: parsed.localFolderPaths || [],
                    htmlFolderPaths: parsed.htmlFolderPaths || [],
                    designFolderPaths: parsed.designFolderPaths || [],
                    _migratedLocal: parsed._migratedLocal || false,
                    _migratedHtml: parsed._migratedHtml || false,
                    _migratedDesign: parsed._migratedDesign || false
                };
            } catch {
                cfg = { localFolderPaths: [], htmlFolderPaths: [], designFolderPaths: [], _migratedLocal: false, _migratedHtml: false, _migratedDesign: false };
            }
            this._folderPathsCache = cfg;
        }

        if (!cfg._migratedDesign) {
            const config = vscode.workspace.getConfiguration('switchboard');
            const globalPaths = config.get<string[]>('research.designFolderPaths', []);
            cfg.designFolderPaths = globalPaths;
            cfg._migratedDesign = true;
            this._folderPathsCache = cfg;
            this.saveFolderPathsConfig(cfg).then(() => {
                config.update('research.designFolderPaths', undefined, vscode.ConfigurationTarget.Global);
            }).catch(() => {});
        }

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
