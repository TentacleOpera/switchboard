import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { KanbanDatabase, ImportedDocEntry, DuplicateCheckResult } from './KanbanDatabase';

export interface ImportRegistryEntry {
  sourceId: string;       // 'clickup' | 'notion' | 'linear' | 'local-folder'
  docId: string;          // original doc ID in the source system
  docName: string;        // human-readable doc title
  slugPrefix: string;     // filename prefix used in .switchboard/docs/ (e.g., 'my_doc_')
  importedAt: string;     // ISO timestamp
  lastSyncedAt?: string;  // ISO timestamp of last successful sync
  remoteContentHash?: string;  // SHA-256 hash of content at last sync, for conflict detection
}

export interface TaskCacheEntry<T> {
  data: T[];
  timestamp: number;
  sourceId: string;
  key: string;
}

/**
 * PlanningPanelCacheService manages local caching of Planning Panel documents.
 * Documents are cached in .switchboard/planning-cache/{sourceId}/{docId}.md
 * for AI collaboration and offline access.
 */
export class PlanningPanelCacheService {
    private readonly _workspaceRoot: string;
    private readonly _cacheBaseDir: string;
    private _registryWriteQueue = new Map<string, Promise<void>>();
    private _kanbanDb: KanbanDatabase | undefined;

    // Task/Issue caching with LRU eviction
    private _taskCache = new Map<string, TaskCacheEntry<any>>();
    private _taskCacheLruList: string[] = []; // Most recent at end
    private readonly _taskCacheMaxSize = 100;
    private readonly _taskCacheTtlMs = 5 * 60 * 1000; // 5 minutes

    // File paths for persisted metadata
    private readonly _clickupMetadataPath: string;
    private readonly _linearMetadataPath: string;
    private _metadataWriteTimer: NodeJS.Timeout | null = null;
    private readonly _metadataWriteDebounceMs = 500;

    constructor(workspaceRoot: string, kanbanDb?: KanbanDatabase) {
        this._workspaceRoot = workspaceRoot;
        this._cacheBaseDir = path.join(workspaceRoot, '.switchboard', 'planning-cache');
        this._clickupMetadataPath = path.join(this._cacheBaseDir, 'clickup-tasks.json');
        this._linearMetadataPath = path.join(this._cacheBaseDir, 'linear-tasks.json');
        this._kanbanDb = kanbanDb;
    }

    private async _getEffectiveWorkspaceId(workspaceId?: string): Promise<string> {
        if (workspaceId) return workspaceId;
        if (this._kanbanDb) {
            const wsId = await this._kanbanDb.getWorkspaceId();
            if (wsId) return wsId;
            
            // If we have a DB but no workspace ID, it's a configuration issue
            throw new Error(
                `[PlanningPanelCacheService] No workspace_id configured in database. ` +
                `Please run "Switchboard: Reset Kanban Database" to recreate.`
            );
        }
        throw new Error('[PlanningPanelCacheService] KanbanDatabase not available');
    }

    /**
     * Sanitize a document ID to a safe filename.
     * Handles ClickUp doc: prefix and other special characters.
     */
    public static sanitizeFilename(docId: string): string {
        // Remove doc: prefix if present (ClickUp uses this)
        let sanitized = docId.replace(/^doc:/, '');
        
        // Replace unsafe characters with underscores
        sanitized = sanitized.replace(/[^a-zA-Z0-9\-_]/g, '_');
        
        // Ensure the filename doesn't start with a dot or dash
        sanitized = sanitized.replace(/^[\.\-]/, '');
        
        // Limit length to reasonable filename length
        if (sanitized.length > 200) {
            sanitized = sanitized.substring(0, 200);
        }
        
        return sanitized;
    }

    /**
     * Get the cache path for a specific document.
     * @param sourceId - The source identifier (e.g., 'notion', 'clickup', 'linear')
     * @param docId - The document ID
     * @returns Full path to the cached document
     */
    public getCachePath(sourceId: string, docId: string): string {
        const sanitizedFilename = PlanningPanelCacheService.sanitizeFilename(docId);
        const sourceCacheDir = path.join(this._cacheBaseDir, sourceId);
        return path.join(sourceCacheDir, `${sanitizedFilename}.md`);
    }

    /**
     * Cache a document locally.
     * @param sourceId - The source identifier (e.g., 'notion', 'clickup', 'linear')
     * @param docId - The document ID
     * @param content - The document content (markdown)
     * @param docName - The document name (optional)
     */
    public async cacheDocument(sourceId: string, docId: string, content: string, docName?: string): Promise<void> {
        // Skip cache write if document has been imported — prevent overwriting local edits
        if (await this.isDocumentImported(sourceId, docId)) {
            return;
        }

        const cachePath = this.getCachePath(sourceId, docId);
        const cacheDir = path.dirname(cachePath);
        
        // Ensure cache directory exists
        await fs.promises.mkdir(cacheDir, { recursive: true });
        
        // Write document to cache with YAML front-matter
        const header = `---
sourceId: ${sourceId}
docId: ${docId}
docName: ${docName || docId}
cachedAt: ${new Date().toISOString()}
---

`;
        await fs.promises.writeFile(cachePath, header + content, 'utf8');
    }

    /**
     * Cache document titles for a source (for instant sidebar display).
     * Stored at .switchboard/planning-cache/{sourceId}/documentTitles.json
     */
    public async cacheDocumentTitles(sourceId: string, titles: Array<{ docId: string; title: string }>): Promise<void> {
        const titlesPath = path.join(this._cacheBaseDir, sourceId, 'documentTitles.json');
        await fs.promises.mkdir(path.dirname(titlesPath), { recursive: true });
        const data = {
            sourceId,
            titles: titles.map(t => ({ docId: t.docId, title: t.title, lastUpdated: new Date().toISOString() })),
            updatedAt: new Date().toISOString()
        };
        await fs.promises.writeFile(titlesPath, JSON.stringify(data, null, 2), 'utf8');
    }

    /**
     * Get cached document titles for a source.
     * Returns null if no title cache exists.
     */
    public async getCachedDocumentTitles(sourceId: string): Promise<Array<{ docId: string; title: string; lastUpdated: string }> | null> {
        const titlesPath = path.join(this._cacheBaseDir, sourceId, 'documentTitles.json');
        try {
            const raw = await fs.promises.readFile(titlesPath, 'utf8');
            const data = JSON.parse(raw);
            return data.titles || null;
        } catch {
            return null;
        }
    }

    /**
     * Get the path to the cache metadata file for a source.
     */
    private _getMetadataPath(sourceId: string): string {
        return path.join(this._cacheBaseDir, sourceId, 'cache-metadata.json');
    }

    /**
     * Read import metadata for a source.
     * Returns a map of docId → { isImported, importedAt }.
     */
    private async _readMetadata(sourceId: string): Promise<Record<string, { isImported: boolean; importedAt?: string }>> {
        const metaPath = this._getMetadataPath(sourceId);
        try {
            const raw = await fs.promises.readFile(metaPath, 'utf8');
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    /**
     * Write import metadata for a source.
     */
    private async _writeMetadata(sourceId: string, metadata: Record<string, { isImported: boolean; importedAt?: string }>): Promise<void> {
        const metaPath = this._getMetadataPath(sourceId);
        await fs.promises.mkdir(path.dirname(metaPath), { recursive: true });
        await fs.promises.writeFile(metaPath, JSON.stringify(metadata, null, 2), 'utf8');
    }

    /**
     * Mark a document as imported (called when user clicks import buttons).
     */
    public async setDocumentImported(sourceId: string, docId: string, workspaceId?: string): Promise<void> {
        if (!this._kanbanDb) return;
        
        const wsId = await this._getEffectiveWorkspaceId(workspaceId);
        
        // We register it as a minimal entry if it's just being marked as imported
        // but not fully registered via registerImport (which provides more metadata)
        const entry = await this._kanbanDb.getImportBySlug(docId, wsId);
        if (!entry) {
            const docsDir = path.join(this._workspaceRoot, '.switchboard', 'docs');
            const filePath = path.join(docsDir, `${docId}.md`);
            await this._kanbanDb.registerImport({
                slugPrefix: docId,
                sourceId,
                remoteDocId: docId,
                docName: docId,
                filePath,
                importedAt: new Date().toISOString(),
                workspaceId: wsId
            });
        }
    }

    /**
     * Check if a document has been imported.
     */
    public async isDocumentImported(sourceId: string, docId: string, workspaceId?: string): Promise<boolean> {
        if (!this._kanbanDb) return false;
        
        const wsId = await this._getEffectiveWorkspaceId(workspaceId);
        const entry = await this._kanbanDb.getImportBySlug(docId, wsId);
        return !!entry;
    }

    /**
     * Cache a document ID map for a source (ClickUp traversal optimization).
     * Stored at .switchboard/planning-cache/{sourceId}/documentIdMap.json
     */
    public async cacheDocumentIdMap(sourceId: string, idMap: Array<{ docId: string; title: string; url?: string }>, lastTraversalAt: string): Promise<void> {
        const mapPath = path.join(this._cacheBaseDir, sourceId, 'documentIdMap.json');
        await fs.promises.mkdir(path.dirname(mapPath), { recursive: true });
        const data = { sourceId, idMap, lastTraversalAt, cachedAt: new Date().toISOString() };
        await fs.promises.writeFile(mapPath, JSON.stringify(data, null, 2), 'utf8');
    }

    /**
     * Get cached document ID map for a source.
     * Returns null if no map exists. Cache is valid until explicitly
     * overwritten by cacheDocumentIdMap() or cleared by clearSourceCache().
     */
    public async getCachedDocumentIdMap(sourceId: string): Promise<Array<{ docId: string; title: string; url?: string }> | null> {
        const mapPath = path.join(this._cacheBaseDir, sourceId, 'documentIdMap.json');
        try {
            const raw = await fs.promises.readFile(mapPath, 'utf8');
            const data = JSON.parse(raw);
            return data.idMap || null;
        } catch {
            return null;
        }
    }

    /**
     * Get a cached document.
     * @param sourceId - The source identifier
     * @param docId - The document ID
     * @returns Document content if cached, null otherwise
     */
    public async getCachedDocument(sourceId: string, docId: string): Promise<string | null> {
        const cachePath = this.getCachePath(sourceId, docId);
        try {
            await fs.promises.access(cachePath, fs.constants.R_OK);
            return await fs.promises.readFile(cachePath, 'utf8');
        } catch {
            return null;
        }
    }

    /**
     * List all cached documents for a source.
     * @param sourceId - The source identifier (optional, lists all sources if omitted)
     * @returns Array of cached document metadata
     */
    public async listCachedDocuments(sourceId?: string): Promise<Array<{ sourceId: string; docId: string; docName: string; path: string }>> {
        const results: Array<{ sourceId: string; docId: string; docName: string; path: string }> = [];
        
        try {
            await fs.promises.access(this._cacheBaseDir, fs.constants.R_OK);
        } catch {
            return results;
        }

        const sourcesToScan = sourceId ? [sourceId] : await fs.promises.readdir(this._cacheBaseDir);
        
        for (const source of sourcesToScan) {
            const sourceCacheDir = path.join(this._cacheBaseDir, source);
            try {
                const files = await fs.promises.readdir(sourceCacheDir);
                for (const file of files) {
                    if (file.endsWith('.md')) {
                        const filePath = path.join(sourceCacheDir, file);
                        const content = await fs.promises.readFile(filePath, 'utf8');
                        
                        // Parse YAML front-matter
                        const frontMatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
                        if (frontMatterMatch) {
                            const docIdMatch = frontMatterMatch[1].match(/^docId: (.+)$/m);
                            const docNameMatch = frontMatterMatch[1].match(/^docName: (.+)$/m);
                            if (docIdMatch && docNameMatch) {
                                results.push({
                                    sourceId: source,
                                    docId: docIdMatch[1].trim(),
                                    docName: docNameMatch[1].trim(),
                                    path: filePath
                                });
                            }
                        }
                    }
                }
            } catch {
                // Source directory may not exist or be inaccessible
                continue;
            }
        }
        
        return results;
    }

    /**
     * Clear all cached documents for a specific source.
     * @param sourceId - The source identifier
     */
    public async clearSourceCache(sourceId: string): Promise<void> {
        const sourceCacheDir = path.join(this._cacheBaseDir, sourceId);
        try {
            await fs.promises.rm(sourceCacheDir, { recursive: true, force: true });
        } catch {
            // Directory may not exist - that's fine
        }
    }

    /**
     * Clear all cached documents for all sources.
     */
    public async clearAllCache(): Promise<void> {
        try {
            await fs.promises.rm(this._cacheBaseDir, { recursive: true, force: true });
        } catch {
            // Cache directory may not exist - that's fine
        }
    }

    // ── Import Registry Methods ─────────────────────────────────────

    public async registerImport(
        sourceId: string,
        docId: string,
        docName: string,
        slugPrefix: string,
        options: { remoteContentHash?: string; workspaceId?: string; filePath?: string }
    ): Promise<void> {
        if (!this._kanbanDb) {
            const msg = 'Database not available. Please ensure Switchboard setup is complete.';
            console.error(`[PlanningPanelCacheService] ${msg}`);
            
            try {
                const vscode = require('vscode');
                vscode.window.showErrorMessage(
                    `${msg} Run "Switchboard: Reset Kanban Database" to recreate.`,
                    'Reset Database'
                ).then((selection: string) => {
                    if (selection === 'Reset Database') {
                        vscode.commands.executeCommand('switchboard.resetKanbanDb');
                    }
                });
            } catch { /* outside extension host */ }
            return;
        }
        
        // Ensure DB is ready, or warn user
        const ready = await this._kanbanDb.ensureReady();
        if (!ready) {
            const msg = 'Database failed to initialize. Registry will not persist.';
            console.error(`[PlanningPanelCacheService] ${msg}`);
            try {
                const vscode = require('vscode');
                vscode.window.showErrorMessage(
                    `${msg} Run "Switchboard: Reset Kanban Database" to recreate.`,
                    'Reset Database'
                ).then((selection: string) => {
                    if (selection === 'Reset Database') {
                        vscode.commands.executeCommand('switchboard.resetKanbanDb');
                    }
                });
            } catch { /* outside extension host */ }
            return;
        }
        
        try {
            const docsDir = path.join(this._workspaceRoot, '.switchboard', 'docs');
            const shortHash = options.remoteContentHash ? options.remoteContentHash.slice(0, 8) : '';
            const fileName = shortHash ? `${slugPrefix}_${shortHash}.md` : `${slugPrefix}.md`;
            const filePath = options.filePath || path.join(docsDir, fileName);
            const workspaceId = await this._getEffectiveWorkspaceId(options.workspaceId);
            
            await this._kanbanDb.registerImport({
                slugPrefix,
                sourceId,
                remoteDocId: docId,
                docName,
                parentDocName: docName,
                filePath,
                importedAt: new Date().toISOString(),
                lastSyncedAt: new Date().toISOString(),
                contentHash: options.remoteContentHash,
                workspaceId
            });
        } catch (err: any) {
            console.error(`[PlanningPanelCacheService] Import registration failed: ${err.message}`);
            try {
                const vscode = require('vscode');
                vscode.window.showErrorMessage(
                    `Import failed: ${err.message} Run "Switchboard: Reset Kanban Database" to recreate.`,
                    'Reset Database'
                ).then((selection: string) => {
                    if (selection === 'Reset Database') {
                        vscode.commands.executeCommand('switchboard.resetKanbanDb');
                    }
                });
            } catch { /* outside extension host */ }
        }
    }

    public async getImportedDocs(workspaceId?: string): Promise<ImportedDocEntry[]> {
        if (!this._kanbanDb) return [];
        const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
        return this._kanbanDb.getImportedDocs(effectiveWsId);
    }

    public async getImportBySlugPrefix(slugPrefix: string, workspaceId?: string): Promise<ImportedDocEntry | null> {
        if (!this._kanbanDb) return null;
        const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
        return this._kanbanDb.getImportBySlug(slugPrefix, effectiveWsId);
    }

    public async updateLastSynced(slugPrefix: string, remoteContentHash: string, workspaceId?: string): Promise<void> {
        if (!this._kanbanDb) return;
        const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
        const entry = await this._kanbanDb.getImportBySlug(slugPrefix, effectiveWsId);
        if (entry) {
            entry.lastSyncedAt = new Date().toISOString();
            entry.contentHash = remoteContentHash;
            await this._kanbanDb.registerImport(entry); // INSERT OR REPLACE
        }
    }

    public async removeImport(slugPrefix: string, workspaceId?: string): Promise<void> {
        if (!this._kanbanDb) return;
        const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
        await this._kanbanDb.removeImport(slugPrefix, effectiveWsId);
    }

    public async registerImportedTicket(
        sourceId: string,
        docId: string,
        docName: string,
        slugPrefix: string,
        filePath: string,
        contentHash: string,
        workspaceId?: string
    ): Promise<void> {
        if (!this._kanbanDb) return;
        const ready = await this._kanbanDb.ensureReady();
        if (!ready) return;
        try {
            const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
            await this._kanbanDb.upsertImportedTicket(
                effectiveWsId,
                slugPrefix,
                sourceId,
                docId,
                docName,
                filePath,
                contentHash
            );
        } catch (err: any) {
            console.error(`[PlanningPanelCacheService] Ticket import registration failed: ${err.message}`);
        }
    }

    public async getImportedTickets(workspaceId?: string): Promise<ImportedDocEntry[]> {
        if (!this._kanbanDb) return [];
        const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
        return this._kanbanDb.listImportedTickets(effectiveWsId);
    }

    public async deleteImportedTicket(slugPrefix: string, workspaceId?: string): Promise<void> {
        if (!this._kanbanDb) return;
        const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
        await this._kanbanDb.deleteImportedTicket(effectiveWsId, slugPrefix);
    }

    /**
     * Check if a document would be a duplicate of an existing import.
     * Scans the registry for name or ID collisions across sources.
     * Same source + same docId is treated as idempotent (not a duplicate).
     */
    public async checkForDuplicate(
        docName: string,
        sourceId: string,
        docId?: string,
        workspaceId?: string
    ): Promise<DuplicateCheckResult> {
        if (!this._kanbanDb) return { isDuplicate: false };
        const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
        return this._kanbanDb.checkForDuplicate(docName, sourceId, effectiveWsId, docId);
    }

    /**
     * Find an import registry entry by document name (case-insensitive).
     * Returns the first match, or null if not found.
     */
    public async getImportByDocName(docName: string, workspaceId?: string): Promise<ImportedDocEntry | null> {
        if (!this._kanbanDb) return null;
        const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
        const entries = await this._kanbanDb.getImportedDocs(effectiveWsId);
        const lowerName = docName.toLowerCase();
        for (const entry of entries) {
            if (entry.docName.toLowerCase() === lowerName) {
                return entry;
            }
        }
        return null;
    }

    /**
     * Resolve the actual file path for an imported doc by scanning .switchboard/docs/
     * for files matching the slug prefix. Handles content-hash changes in filenames.
     */
    public async resolveImportedDocPath(slugPrefix: string, workspaceId?: string): Promise<string | null> {
        // Try DB first
        if (this._kanbanDb) {
            const effectiveWsId = await this._getEffectiveWorkspaceId(workspaceId);
            const entry = await this._kanbanDb.getImportBySlug(slugPrefix, effectiveWsId);
            if (entry && fs.existsSync(entry.filePath)) {
                return entry.filePath;
            }
        }
        
        // Fallback: scan directory for files starting with slugPrefix (backward compatibility)
        const docsDir = path.join(this._workspaceRoot, '.switchboard', 'docs');
        try {
            const files = await fs.promises.readdir(docsDir);
            const matches = files.filter(f => f.startsWith(slugPrefix) && f.endsWith('.md'));
            if (matches.length === 0) { return null; }
            // If multiple matches (different content hashes), use the most recently modified
            let latest = matches[0];
            let latestMtime = 0;
            for (const match of matches) {
                const stat = await fs.promises.stat(path.join(docsDir, match));
                if (stat.mtimeMs > latestMtime) {
                    latestMtime = stat.mtimeMs;
                    latest = match;
                }
            }
            return path.join(docsDir, latest);
        } catch {
            return null;
        }
    }

    // ==================== Task/Issue Caching ====================

    /**
     * Cache tasks/issues with LRU eviction.
     * @param sourceId - 'clickup' or 'linear'
     * @param key - cache key (e.g., listId or projectId with fingerprint)
     * @param data - array of tasks/issues to cache
     */
    public cacheTasks<T>(sourceId: string, key: string, data: T[]): void {
        const fullKey = `${sourceId}:${key}`;

        // Update cache
        this._taskCache.set(fullKey, {
            data,
            timestamp: Date.now(),
            sourceId,
            key
        });

        // Update LRU list: remove if exists, then push to end (most recent)
        const lruIndex = this._taskCacheLruList.indexOf(fullKey);
        if (lruIndex !== -1) {
            this._taskCacheLruList.splice(lruIndex, 1);
        }
        this._taskCacheLruList.push(fullKey);

        // Evict oldest if over max size
        if (this._taskCacheLruList.length > this._taskCacheMaxSize) {
            const oldestKey = this._taskCacheLruList.shift();
            if (oldestKey) {
                this._taskCache.delete(oldestKey);
            }
        }

        // Trigger debounced metadata write
        void this._writeMetadataToJson();
    }

    /**
     * Get cached tasks/issues if present and not expired.
     * @param sourceId - 'clickup' or 'linear'
     * @param key - cache key
     * @returns cached data or null if miss or expired
     */
    public getCachedTasks<T>(sourceId: string, key: string): T[] | null {
        const fullKey = `${sourceId}:${key}`;
        const entry = this._taskCache.get(fullKey);

        if (!entry) {
            return null;
        }

        // Check TTL
        const now = Date.now();
        if (now - entry.timestamp > this._taskCacheTtlMs) {
            // Treat stale as miss: remove from cache
            this._taskCache.delete(fullKey);
            const lruIndex = this._taskCacheLruList.indexOf(fullKey);
            if (lruIndex !== -1) {
                this._taskCacheLruList.splice(lruIndex, 1);
            }
            return null;
        }

        // Update LRU: move to end (most recent)
        const lruIndex = this._taskCacheLruList.indexOf(fullKey);
        if (lruIndex !== -1) {
            this._taskCacheLruList.splice(lruIndex, 1);
        }
        this._taskCacheLruList.push(fullKey);

        return entry.data as T[];
    }

    /**
     * Invalidate cache entries for a specific source/key pattern.
     * @param sourceId - 'clickup' or 'linear'
     * @param keyPattern - optional key pattern to match (e.g., listId)
     */
    public invalidateTaskCache(sourceId: string, keyPattern?: string): void {
        const prefix = `${sourceId}:`;

        for (const fullKey of this._taskCacheLruList.slice()) {
            if (!fullKey.startsWith(prefix)) {
                continue;
            }

            // If no keyPattern provided, invalidate all for this source
            // If keyPattern provided, invalidate only matching keys
            if (!keyPattern || fullKey === `${sourceId}:${keyPattern}` || fullKey.startsWith(`${sourceId}:${keyPattern}:`)) {
                this._taskCache.delete(fullKey);
                const lruIndex = this._taskCacheLruList.indexOf(fullKey);
                if (lruIndex !== -1) {
                    this._taskCacheLruList.splice(lruIndex, 1);
                }
            }
        }
    }

    /**
     * Clear all task cache entries.
     */
    public async clearAllTaskCache(): Promise<void> {
        this._taskCache.clear();
        this._taskCacheLruList.length = 0;

        // Write empty metadata immediately (no debounce)
        try {
            await this._writeMetadataFile(this._clickupMetadataPath, 'clickup');
            await this._writeMetadataFile(this._linearMetadataPath, 'linear');
        } catch (err) {
            console.warn('[PlanningPanelCache] Failed to write empty metadata to JSON:', err);
        }
    }

    /**
     * Write minimal task metadata to JSON files for agent access.
     * Uses atomic write pattern (temp file + rename) to avoid corruption.
     */
    private async _writeMetadataToJson(): Promise<void> {
        if (this._metadataWriteTimer) {
            clearTimeout(this._metadataWriteTimer);
        }
        this._metadataWriteTimer = setTimeout(async () => {
            try {
                await this._writeMetadataFile(this._clickupMetadataPath, 'clickup');
                await this._writeMetadataFile(this._linearMetadataPath, 'linear');
            } catch (err) {
                console.warn('[PlanningPanelCache] Failed to write metadata to JSON:', err);
            }
        }, this._metadataWriteDebounceMs);
    }

    /**
     * Extract minimal metadata from cache entries for a specific source.
     */
    private async _writeMetadataFile(filePath: string, sourceId: string): Promise<void> {
        const metadata: Array<{ id: string; name: string; status: string; listId?: string; projectId?: string; sprint?: string; lastUpdated: number }> = [];
        const prefix = `${sourceId}:`;

        for (const [fullKey, entry] of this._taskCache.entries()) {
            if (fullKey.startsWith(prefix)) {
                // Extract listId/projectId from cache key (format: "source:listId:..." or "source:projectId:...")
                const keyParts = fullKey.split(':');
                const listId = sourceId === 'clickup' ? keyParts[1] : undefined;
                const projectId = sourceId === 'linear' ? keyParts[1] : undefined;

                for (const task of entry.data) {
                    metadata.push({
                        id: task.id,
                        name: task.name || '',
                        status: task.status || '',
                        listId,
                        projectId,
                        sprint: task.sprint || undefined,  // if available
                        lastUpdated: entry.timestamp
                    });
                }
            }
        }

        const metadataObject = {
            version: 1,
            sourceId,
            metadata,
            writtenAt: Date.now()
        };

        const tmpPath = `${filePath}.tmp`;
        await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
        await fs.promises.writeFile(tmpPath, JSON.stringify(metadataObject, null, 2), 'utf8');
        await fs.promises.rename(tmpPath, filePath);
    }
}
