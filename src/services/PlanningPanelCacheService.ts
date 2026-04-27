import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

export interface ImportRegistryEntry {
  sourceId: string;       // 'clickup' | 'notion' | 'linear' | 'local-folder'
  docId: string;          // original doc ID in the source system
  docName: string;        // human-readable doc title
  slugPrefix: string;     // filename prefix used in .switchboard/docs/ (e.g., 'my_doc_')
  importedAt: string;     // ISO timestamp
  lastSyncedAt?: string;  // ISO timestamp of last successful sync
  remoteContentHash?: string;  // SHA-256 hash of content at last sync, for conflict detection
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

    constructor(workspaceRoot: string) {
        this._workspaceRoot = workspaceRoot;
        this._cacheBaseDir = path.join(workspaceRoot, '.switchboard', 'planning-cache');
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
    public async setDocumentImported(sourceId: string, docId: string): Promise<void> {
        const metadata = await this._readMetadata(sourceId);
        metadata[docId] = { isImported: true, importedAt: new Date().toISOString() };
        await this._writeMetadata(sourceId, metadata);
    }

    /**
     * Check if a document has been imported.
     */
    public async isDocumentImported(sourceId: string, docId: string): Promise<boolean> {
        const metadata = await this._readMetadata(sourceId);
        return metadata[docId]?.isImported === true;
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

    private _getRegistryPath(): string {
        return path.join(this._workspaceRoot, '.switchboard', 'imported-docs.json');
    }

    private async _readRegistry(): Promise<Record<string, ImportRegistryEntry>> {
        try {
            const raw = await fs.promises.readFile(this._getRegistryPath(), 'utf8');
            return JSON.parse(raw);
        } catch {
            return {};
        }
    }

    private async _writeRegistry(registry: Record<string, ImportRegistryEntry>): Promise<void> {
        const resolvedKey = this._getRegistryPath();
        const existing = this._registryWriteQueue.get(resolvedKey);
        const writePromise = (existing || Promise.resolve()).then(async () => {
            await fs.promises.mkdir(path.dirname(this._getRegistryPath()), { recursive: true });
            await fs.promises.writeFile(this._getRegistryPath(), JSON.stringify(registry, null, 2), 'utf8');
        });
        this._registryWriteQueue.set(resolvedKey, writePromise);
        await writePromise;
    }

    public async registerImport(
        sourceId: string,
        docId: string,
        docName: string,
        slugPrefix: string,
        options: { remoteContentHash?: string } = {}
    ): Promise<void> {
        const registry = await this._readRegistry();
        registry[slugPrefix] = {
            sourceId,
            docId,
            docName,
            slugPrefix,
            importedAt: new Date().toISOString(),
            remoteContentHash: options.remoteContentHash
        };
        await this._writeRegistry(registry);
    }

    public async getImportedDocs(): Promise<ImportRegistryEntry[]> {
        const registry = await this._readRegistry();
        return Object.values(registry);
    }

    public async getImportBySlugPrefix(slugPrefix: string): Promise<ImportRegistryEntry | null> {
        const registry = await this._readRegistry();
        return registry[slugPrefix] || null;
    }

    public async updateLastSynced(slugPrefix: string, remoteContentHash?: string): Promise<void> {
        const registry = await this._readRegistry();
        if (registry[slugPrefix]) {
            registry[slugPrefix].lastSyncedAt = new Date().toISOString();
            if (remoteContentHash) {
                registry[slugPrefix].remoteContentHash = remoteContentHash;
            }
            await this._writeRegistry(registry);
        }
    }

    public async removeImport(slugPrefix: string): Promise<void> {
        const registry = await this._readRegistry();
        delete registry[slugPrefix];
        await this._writeRegistry(registry);
    }

    /**
     * Check if a document would be a duplicate of an existing import.
     * Scans the registry for name or ID collisions across sources.
     * Same source + same docId is treated as idempotent (not a duplicate).
     */
    public async checkForDuplicate(
        docName: string,
        sourceId: string,
        docId?: string
    ): Promise<{
        isDuplicate: boolean;
        matchType?: 'exact_name' | 'case_insensitive_name' | 'same_doc_id';
        existingDoc?: ImportRegistryEntry;
    }> {
        const registry = await this._readRegistry();

        // Check for docName match (case-insensitive)
        for (const entry of Object.values(registry)) {
            if (entry.docName.toLowerCase() === docName.toLowerCase()) {
                // Same source + same docId = idempotent re-import, not a duplicate
                if (entry.sourceId === sourceId && entry.docId === docId) {
                    continue;
                }
                return {
                    isDuplicate: true,
                    matchType: entry.docName === docName ? 'exact_name' : 'case_insensitive_name',
                    existingDoc: entry
                };
            }
        }

        // Check for same docId from a different source
        if (docId) {
            for (const entry of Object.values(registry)) {
                if (entry.docId === docId && entry.sourceId !== sourceId) {
                    return {
                        isDuplicate: true,
                        matchType: 'same_doc_id',
                        existingDoc: entry
                    };
                }
            }
        }

        return { isDuplicate: false };
    }

    /**
     * Find an import registry entry by document name (case-insensitive).
     * Returns the first match, or null if not found.
     */
    public async getImportByDocName(docName: string): Promise<ImportRegistryEntry | null> {
        const registry = await this._readRegistry();
        const lowerName = docName.toLowerCase();
        for (const entry of Object.values(registry)) {
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
    public async resolveImportedDocPath(slugPrefix: string): Promise<string | null> {
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
}
