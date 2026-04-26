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

export class LocalFolderService {
    private _workspaceRoot: string;
    private _configPath: string;
    private _cachePath: string;

    private static readonly _EXCLUDED_DIRS = new Set(['node_modules', '.git', '.switchboard']);
    private static readonly _MAX_DEPTH = 10;

    constructor(workspaceRoot: string) {
        this._workspaceRoot = workspaceRoot;
        this._configPath = path.join(workspaceRoot, '.switchboard', 'local-folder-config.json');
        this._cachePath = path.join(workspaceRoot, '.switchboard', 'local-folder-cache.md');
    }

    // ── Config ──────────────────────────────────────────────────

    async loadConfig(): Promise<LocalFolderConfig | null> {
        try {
            const content = await fs.promises.readFile(this._configPath, 'utf8');
            return JSON.parse(content);
        } catch { return null; }
    }

    async saveConfig(config: LocalFolderConfig): Promise<void> {
        await fs.promises.mkdir(path.dirname(this._configPath), { recursive: true });
        await fs.promises.writeFile(this._configPath, JSON.stringify(config, null, 2));
    }

    async loadCachedContent(): Promise<string | null> {
        try {
            return await fs.promises.readFile(this._cachePath, 'utf8');
        } catch { return null; }
    }

    async saveCachedContent(markdown: string): Promise<void> {
        await fs.promises.mkdir(path.dirname(this._cachePath), { recursive: true });
        await fs.promises.writeFile(this._cachePath, markdown, 'utf8');
    }

    // ── Folder Path Resolution (matches kanban.dbPath pattern) ──

    resolveFolderPath(folderPath: string): string {
        const trimmed = (folderPath || '').trim();
        if (!trimmed) { return ''; }
        const expanded = trimmed.startsWith('~')
            ? path.join(os.homedir(), trimmed.slice(1))
            : trimmed;
        return path.isAbsolute(expanded) ? expanded : path.join(this._workspaceRoot, expanded);
    }

    getFolderPath(): string {
        const config = vscode.workspace.getConfiguration('switchboard');
        const raw = config.get<string>('research.localFolderPath', '');
        return this.resolveFolderPath(raw);
    }

    async setFolderPath(folderPath: string): Promise<string> {
        const config = vscode.workspace.getConfiguration('switchboard');
        await config.update('research.localFolderPath', folderPath, vscode.ConfigurationTarget.Workspace);
        // Return the resolved path directly — config.get() may return stale value
        // immediately after update, especially for unregistered settings.
        return this.resolveFolderPath(folderPath);
    }

    // ── File Listing ────────────────────────────────────────────

    async listFiles(): Promise<Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string }>> {
        const folderPath = this.getFolderPath();
        if (!folderPath) { return []; }

        try {
            const stat = await fs.promises.stat(folderPath);
            if (!stat.isDirectory()) { return []; }
        } catch { return []; }

        const items: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string }> = [];
        await this._scanFolder(folderPath, folderPath, items, null, 0);
        return items;
    }

    private async _scanFolder(
        root: string,
        current: string,
        results: Array<{ id: string; name: string; relativePath: string; isFolder?: boolean; parentId?: string }>,
        parentId: string | null,
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
            const relativePath = path.relative(root, fullPath);

            if (entry.isDirectory()) {
                results.push({
                    id: relativePath,
                    name: entry.name,
                    relativePath,
                    isFolder: true,
                    parentId: parentId || undefined
                });
                subfolderScans.push(this._scanFolder(root, fullPath, results, relativePath, depth + 1));
            } else if (entry.isFile() && this._isTextFile(entry.name)) {
                results.push({
                    id: relativePath,
                    name: entry.name,
                    relativePath,
                    isFolder: false,
                    parentId: parentId || undefined
                });
            }
        }

        await Promise.all(subfolderScans);
    }

    private _isTextFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.md', '.txt', '.markdown', '.rst', '.adoc'].includes(ext);
    }

    // ── Fetch ───────────────────────────────────────────────────

    async fetchDocContent(relativePath: string): Promise<{ success: boolean; docTitle?: string; content?: string; error?: string }> {
        const folderPath = this.getFolderPath();
        if (!folderPath) {
            return { success: false, error: 'Local folder path not configured. Enter the folder path containing your research files.' };
        }

        const fullPath = path.join(folderPath, relativePath);
        // Prevent path traversal
        const resolved = path.resolve(fullPath);
        if (!resolved.startsWith(path.resolve(folderPath))) {
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
}
