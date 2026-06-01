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
    private static readonly _ANTIGRAVITY_BRAIN_PATHS = [
        path.join(os.homedir(), '.gemini', 'antigravity-cli', 'brain'),
        path.join(os.homedir(), '.gemini', 'antigravity', 'brain'),
    ];

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

    private _getConfigurationTarget(): vscode.ConfigurationTarget {
        const folder = vscode.workspace.getWorkspaceFolder(vscode.Uri.file(this._workspaceRoot));
        return folder ? vscode.ConfigurationTarget.WorkspaceFolder : vscode.ConfigurationTarget.Workspace;
    }

    /** Read the legacy singular setting; returns the raw string or empty string. */
    private _getLegacyFolderPath(): string {
        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
        return config.get<string>('research.localFolderPath', '');
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

    getFolderPaths(): string[] {
        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
        const paths = config.get<string[]>('research.localFolderPaths', []);

        // Legacy fallback: read singular setting if array is empty
        if (paths.length === 0) {
            const legacyPath = config.get<string>('research.localFolderPath', '');
            if (legacyPath) {
                paths.push(legacyPath);
            }
        }

        const seen = new Set<string>();
        return paths
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getFolderPath(): string {
        const paths = this.getFolderPaths();
        return paths[0] ?? '';
    }

    async addFolderPath(folderPath: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
        let currentPaths = config.get<string[]>('research.localFolderPaths', []);

        // Migrate legacy singular setting into the array before adding
        if (currentPaths.length === 0) {
            const legacyPath = this._getLegacyFolderPath();
            if (legacyPath) {
                currentPaths = [legacyPath];
            }
        }

        const resolvedInput = this.resolveFolderPath(folderPath);
        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            const newPaths = [...currentPaths, folderPath];
            await config.update('research.localFolderPaths', newPaths, this._getConfigurationTarget());
        }
    }

    async removeFolderPath(folderPath: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
        let currentPaths = config.get<string[]>('research.localFolderPaths', []);

        // Migrate legacy singular setting into the array before removing
        if (currentPaths.length === 0) {
            const legacyPath = this._getLegacyFolderPath();
            if (legacyPath) {
                currentPaths = [legacyPath];
            }
        }

        const resolvedToRemove = this.resolveFolderPath(folderPath);
        const newPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await config.update('research.localFolderPaths', newPaths, this._getConfigurationTarget());

        // If the array is now empty, clear the legacy setting too so the
        // fallback in getFolderPaths() doesn't re-add the removed folder.
        if (newPaths.length === 0) {
            const legacyPath = this._getLegacyFolderPath();
            if (legacyPath) {
                await config.update('research.localFolderPath', undefined, this._getConfigurationTarget());
            }
        }
    }

    // ── File Listing ────────────────────────────────────────────

    async listFiles(): Promise<Array<{
        id: string;
        name: string;
        relativePath: string;
        isFolder?: boolean;
        parentId?: string;
        sourceFolder: string;
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
            }
        }

        await Promise.all(subfolderScans);
    }

    private _isTextFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.md', '.txt', '.markdown', '.rst', '.adoc'].includes(ext);
    }

    getHtmlFolderPaths(): string[] {
        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
        const paths = config.get<string[]>('research.htmlFolderPaths', []);
        const seen = new Set<string>();
        return paths
            .map(p => this.resolveFolderPath(p))
            .filter(p => p && !seen.has(p) && seen.add(p) as unknown as boolean);
    }

    getHtmlFolderPath(): string {
        const paths = this.getHtmlFolderPaths();
        return paths[0] ?? '';
    }

    async addHtmlFolderPath(folderPath: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
        const currentPaths = config.get<string[]>('research.htmlFolderPaths', []);
        const resolvedInput = this.resolveFolderPath(folderPath);
        
        const isDuplicate = currentPaths.some(p => this.resolveFolderPath(p) === resolvedInput);
        if (!isDuplicate) {
            const newPaths = [...currentPaths, folderPath];
            await config.update('research.htmlFolderPaths', newPaths, this._getConfigurationTarget());
        }
    }

    async removeHtmlFolderPath(folderPath: string): Promise<void> {
        const config = vscode.workspace.getConfiguration('switchboard', vscode.Uri.file(this._workspaceRoot));
        const currentPaths = config.get<string[]>('research.htmlFolderPaths', []);
        const resolvedToRemove = this.resolveFolderPath(folderPath);
        
        const newPaths = currentPaths.filter(p => this.resolveFolderPath(p) !== resolvedToRemove);
        await config.update('research.htmlFolderPaths', newPaths, this._getConfigurationTarget());
    }

    async listHtmlFiles(): Promise<Array<{
        id: string;
        name: string;
        relativePath: string;
        isFolder?: boolean;
        parentId?: string;
        sourceFolder: string;
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
            } else if (entry.isFile() && this._isHtmlFile(entry.name)) {
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

    private _isHtmlFile(filename: string): boolean {
        const ext = path.extname(filename).toLowerCase();
        return ['.html', '.htm'].includes(ext);
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
