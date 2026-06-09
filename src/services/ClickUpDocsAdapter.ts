import { ClickUpSyncService } from './ClickUpSyncService';
import { ResearchSourceAdapter, ResearchFile, TreeNode } from './ResearchImportService';
import { PlanningPanelCacheService } from './PlanningPanelCacheService';
import * as path from 'path';
import * as fs from 'fs';

export interface ClickUpDocConfig {
    docId: string;
    docTitle: string;
    docUrl: string;
    setupComplete: boolean;
    lastFetchAt: string | null;
}

export class ClickUpDocsAdapter implements ResearchSourceAdapter {
    readonly sourceId = 'clickup';
    private _workspaceRoot: string;
    private _configPath: string;
    private _cachePath: string;
    private _clickUpService: ClickUpSyncService;
    private _cacheService: PlanningPanelCacheService | undefined;
    private readonly MAX_CHARS = 50000;
    private readonly MAX_PAGES = 200;

    constructor(workspaceRoot: string, clickUpService: ClickUpSyncService, cacheService?: PlanningPanelCacheService) {
        this._workspaceRoot = workspaceRoot;
        this._configPath = path.join(workspaceRoot, '.switchboard', 'clickup-docs-config.json');
        this._cachePath = path.join(workspaceRoot, '.switchboard', 'clickup-docs-cache.md');
        this._clickUpService = clickUpService;
        this._cacheService = cacheService;
    }

    async loadConfig(): Promise<ClickUpDocConfig | null> {
        try {
            const content = await fs.promises.readFile(this._configPath, 'utf8');
            return JSON.parse(content);
        } catch { return null; }
    }

    async saveConfig(config: ClickUpDocConfig): Promise<void> {
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

    private _localizeHttpError(status: number, context: string): string {
        const errorMessages: Record<number, string> = {
            400: 'Bad request - the request was invalid',
            401: 'Unauthorized - please check your API credentials',
            403: 'Forbidden - you do not have permission to access this resource',
            404: 'Not found - the requested resource does not exist',
            429: 'Too many requests - rate limit exceeded, please try again later',
            500: 'Internal server error - the ClickUp service is experiencing issues',
            502: 'Bad gateway - the ClickUp service is unavailable',
            503: 'Service unavailable - the ClickUp service is temporarily down',
            504: 'Gateway timeout - the request took too long to complete'
        };
        const message = errorMessages[status] || `HTTP error ${status}`;
        return `${context}: ${message}`;
    }

    /**
     * Update a single entry in the document ID map.
     * Used to keep the cache in sync when individual documents are fetched.
     */
    private async _updateDocumentIdMapEntry(docId: string, title: string, url?: string): Promise<void> {
        if (!this._cacheService) {
            return;
        }

        try {
            const currentMap = await this._cacheService.getCachedDocumentIdMap('clickup') || [];
            const existingIndex = currentMap.findIndex(entry => entry.docId === docId);

            if (existingIndex >= 0) {
                // Update existing entry
                currentMap[existingIndex] = { docId, title, url };
            } else {
                // Add new entry
                currentMap.push({ docId, title, url });
            }

            await this._cacheService.cacheDocumentIdMap('clickup', currentMap, new Date().toISOString());
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] Failed to update document ID map entry:', err);
        }
    }

    // ── ResearchSourceAdapter ────────────────────────────────────

    /**
     * Ensure the ClickUp config has a workspaceId loaded. If missing,
     * auto-load it from the API using the stored token. Returns the
     * workspace ID string, or null if unavailable (no token, API error).
     */
    private async _ensureWorkspaceId(): Promise<string | null> {
        const config = await this._clickUpService.loadConfig();
        if (config?.workspaceId) {
            return config.workspaceId;
        }
        // No workspaceId yet — try to auto-load via API token
        try {
            const workspaceId = await this._clickUpService.loadWorkspaceIdIfNeeded();
            return workspaceId || null;
        } catch (error) {
            console.warn('[ClickUpDocsAdapter] Failed to auto-load workspace ID:', error);
            return null;
        }
    }

    async listFiles(): Promise<ResearchFile[]> {
        const docs = await this.listDocuments();
        return docs.map(d => ({
            id: d.id,
            name: d.title,
            source: 'clickup',
            url: d.url
        }));
    }

    async fetchContent(fileId: string): Promise<string> {
        const docId = fileId.startsWith('doc:') ? fileId.slice(4) : fileId;
        const result = await this.fetchDocContent(docId);
        if (result.success && result.content) return result.content;
        return (await this.loadCachedContent()) || '';
    }

    async fetchChildren(parentId?: string): Promise<TreeNode[]> {
        const wsId = await this._ensureWorkspaceId();
        if (!wsId) { return []; }

        try {
            // Root → list spaces
            if (parentId === undefined) {
                const response = await this._clickUpService.httpRequest('GET', `/team/${wsId}/space?archived=false`);
                if (response.status < 200 || response.status >= 300) { return []; }
                const spaces = Array.isArray(response.data?.spaces) ? response.data.spaces : [];
                return spaces.map((space: any) => ({
                    id: `space:${space.id}`,
                    name: space.name || 'Untitled Space',
                    kind: 'folder' as const,
                    hasChildren: true
                }));
            }

            // space:<id> → list folders, folderless lists, and space-level docs
            if (parentId.startsWith('space:')) {
                const spaceId = parentId.slice(6);
                const [foldersResp, listsResp, docsResp] = await Promise.all([
                    this._clickUpService.httpRequest('GET', `/space/${spaceId}/folder?archived=false`),
                    this._clickUpService.httpRequest('GET', `/space/${spaceId}/list?archived=false`),
                    this._clickUpService.httpRequestV3('GET', `/workspaces/${wsId}/docs?parent_id=${spaceId}&parent_type=4`)
                ]);

                const nodes: TreeNode[] = [];

                // Add folders
                if (foldersResp.status >= 200 && foldersResp.status < 300 && Array.isArray(foldersResp.data?.folders)) {
                    nodes.push(...foldersResp.data.folders.map((folder: any) => ({
                        id: `folder:${folder.id}`,
                        name: folder.name || 'Untitled Folder',
                        kind: 'folder' as const,
                        parentId,
                        hasChildren: true
                    })));
                }

                // Add folderless lists
                if (listsResp.status >= 200 && listsResp.status < 300 && Array.isArray(listsResp.data?.lists)) {
                    nodes.push(...listsResp.data.lists
                        .filter((list: any) => !list.folder) // Only folderless lists
                        .map((list: any) => ({
                            id: `list:${list.id}`,
                            name: list.name || 'Untitled List',
                            kind: 'folder' as const,
                            parentId,
                            hasChildren: true
                        })));
                }

                // Add space-level docs
                if (docsResp.status >= 200 && docsResp.status < 300 && Array.isArray(docsResp.data?.docs)) {
                    nodes.push(...docsResp.data.docs.map((doc: any) => ({
                        id: `doc:${doc.id}`,
                        name: doc.name || doc.title || 'Untitled Doc',
                        kind: 'document' as const,
                        parentId,
                        hasChildren: true,  // Always true to allow expanding to fetch subpages
                        url: doc.url
                    })));
                }

                return nodes;
            }

            // folder:<id> → list lists
            if (parentId.startsWith('folder:')) {
                const folderId = parentId.slice(7);
                const response = await this._clickUpService.httpRequest('GET', `/folder/${folderId}/list?archived=false`);
                if (response.status < 200 || response.status >= 300) { return []; }
                const lists = Array.isArray(response.data?.lists) ? response.data.lists : [];
                return lists.map((list: any) => ({
                    id: `list:${list.id}`,
                    name: list.name || 'Untitled List',
                    kind: 'folder' as const,
                    parentId,
                    hasChildren: true
                }));
            }

            // list:<id> → list docs
            if (parentId.startsWith('list:')) {
                const listId = parentId.slice(5);
                const response = await this._clickUpService.httpRequestV3('GET', `/workspaces/${wsId}/docs?parent_id=${listId}&parent_type=6`);
                if (response.status < 200 || response.status >= 300) { return []; }
                const docs = Array.isArray(response.data?.docs) ? response.data.docs : [];
                return docs.map((doc: any) => ({
                    id: `doc:${doc.id}`,
                    name: doc.name || doc.title || 'Untitled Doc',
                    kind: 'document' as const,
                    parentId,
                    hasChildren: true,  // Always true to allow expanding to fetch subpages
                    url: doc.url
                }));
            }

            // doc:<id> → no children
            return [];
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] fetchChildren failed:', err);
            return [];
        }
    }

    async listContainers(): Promise<TreeNode[]> {
        const wsId = await this._ensureWorkspaceId();
        if (!wsId) { return []; }
        try {
            const response = await this._clickUpService.httpRequest('GET', `/team/${wsId}/space?archived=false`);
            if (response.status < 200 || response.status >= 300) { return []; }
            const spaces = Array.isArray(response.data?.spaces) ? response.data.spaces : [];
            return spaces.map((space: any) => ({
                id: `space:${space.id}`,
                name: space.name || 'Untitled Space',
                kind: 'folder' as const,
                hasChildren: true
            }));
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] listContainers failed:', err);
            return [];
        }
    }

    async listDocumentsByContainer(containerId: string): Promise<TreeNode[]> {
        const wsId = await this._ensureWorkspaceId();
        if (!wsId) { return []; }
        try {
            if (containerId.startsWith('space:')) {
                const spaceId = containerId.slice(6);
                return await this._fetchAllDocsInSpace(wsId, spaceId);
            }
            if (containerId.startsWith('folder:')) {
                const folderId = containerId.slice(7);
                return await this._fetchAllDocsInFolder(wsId, folderId);
            }
            if (containerId.startsWith('list:')) {
                const listId = containerId.slice(5);
                return await this._fetchDocsInList(wsId, listId);
            }
            return [];
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] listDocumentsByContainer failed:', err);
            return [];
        }
    }

    /**
     * Deep-fetch all docs within a space. Strategy 1 (unfiltered endpoint with
     * client-side space filtering) is tried first — it's one API call that
     * reliably returns docs with their space property. Strategies 2-4 (deep
     * traversal) only run as fallback if Strategy 1 returns zero matches, because
     * some ClickUp workspaces have docs that the unfiltered endpoint doesn't tag
     * with a space property.
     */
    private async _fetchAllDocsInSpace(wsId: string, spaceId: string): Promise<TreeNode[]> {
        const allDocs = new Map<string, TreeNode>();

        // Strategy 1: Fetch unfiltered docs and filter client-side by space property
        // This is the PRIMARY strategy — one API call covers most docs.
        let strategy1Hit = false;
        try {
            const unfilteredResp = await this._clickUpService.httpRequestV3(
                'GET', `/workspaces/${wsId}/docs`
            );
            if (unfilteredResp.status >= 200 && unfilteredResp.status < 300 && Array.isArray(unfilteredResp.data?.docs)) {
                for (const doc of unfilteredResp.data.docs) {
                    const docSpaceId = doc.space?.id || doc.space_id || doc.spaceId;
                    const docParentSpace = doc.parent?.space?.id;

                    if (String(docSpaceId) === String(spaceId) || String(docParentSpace) === String(spaceId)) {
                        strategy1Hit = true;
                        const nodeId = `doc:${doc.id}`;
                        if (!allDocs.has(nodeId)) {
                            allDocs.set(nodeId, {
                                id: nodeId,
                                name: doc.name || doc.title || 'Untitled Doc',
                                kind: 'document' as const,
                                hasChildren: !!(doc.pages_count) || !!(doc.pages?.length),
                                url: doc.url,
                                spaceId: spaceId
                            });
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] Strategy 1 (unfiltered) failed:', err);
            /* continue to fallback */ }

        // If Strategy 1 found docs, skip expensive deep traversal.
        if (strategy1Hit) {
            return Array.from(allDocs.values());
        }

        // Strategy 2: Space-level docs (direct parent = space)
        try {
            const docsResp = await this._clickUpService.httpRequestV3(
                'GET', `/workspaces/${wsId}/docs?parent_id=${spaceId}&parent_type=4`
            );
            if (docsResp.status >= 200 && docsResp.status < 300 && Array.isArray(docsResp.data?.docs)) {
                for (const doc of docsResp.data.docs) {
                    const nodeId = `doc:${doc.id}`;
                    if (!allDocs.has(nodeId)) {
                        allDocs.set(nodeId, {
                            id: nodeId,
                            name: doc.name || doc.title || 'Untitled Doc',
                            kind: 'document' as const,
                            hasChildren: !!(doc.pages_count) || !!(doc.pages?.length),
                            url: doc.url,
                            spaceId: spaceId
                        });
                    }
                }
            }
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] Strategy 2 (space-level docs) failed:', err);
            /* continue */
        }

        // Strategy 3: Folderless lists → their docs
        try {
            const listsResp = await this._clickUpService.httpRequest('GET', `/space/${spaceId}/list?archived=false`);
            if (listsResp.status >= 200 && listsResp.status < 300 && Array.isArray(listsResp.data?.lists)) {
                const folderlessLists = listsResp.data.lists.filter((l: any) => !l.folder);
                for (const list of folderlessLists) {
                    const listDocs = await this._fetchDocsInList(wsId, list.id);
                    for (const doc of listDocs) {
                        if (!allDocs.has(doc.id)) {
                            allDocs.set(doc.id, { ...doc, spaceId });
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] Strategy 3 (folderless lists) failed:', err);
            /* continue */
        }

        // Strategy 4: Folders → lists → their docs
        try {
            const foldersResp = await this._clickUpService.httpRequest('GET', `/space/${spaceId}/folder?archived=false`);
            if (foldersResp.status >= 200 && foldersResp.status < 300 && Array.isArray(foldersResp.data?.folders)) {
                for (const folder of foldersResp.data.folders) {
                    const folderDocs = await this._fetchAllDocsInFolder(wsId, folder.id);
                    for (const doc of folderDocs) {
                        if (!allDocs.has(doc.id)) {
                            allDocs.set(doc.id, { ...doc, spaceId });
                        }
                    }
                }
            }
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] Strategy 4 (folders) failed:', err);
            /* continue */
        }

        return Array.from(allDocs.values());
    }

    /**
     * Deep-fetch all docs within a folder: each list's docs.
     */
    private async _fetchAllDocsInFolder(wsId: string, folderId: string): Promise<TreeNode[]> {
        const allDocs = new Map<string, TreeNode>();
        try {
            const listsResp = await this._clickUpService.httpRequest('GET', `/folder/${folderId}/list?archived=false`);
            if (listsResp.status >= 200 && listsResp.status < 300 && Array.isArray(listsResp.data?.lists)) {
                for (const list of listsResp.data.lists) {
                    const listDocs = await this._fetchDocsInList(wsId, list.id);
                    for (const doc of listDocs) {
                        if (!allDocs.has(doc.id)) { allDocs.set(doc.id, doc); }
                    }
                }
            }
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] _fetchAllDocsInFolder failed:', err);
            /* continue */ }
        return Array.from(allDocs.values());
    }

    /**
     * Fetch docs whose direct parent is a list.
     */
    private async _fetchDocsInList(wsId: string, listId: string): Promise<TreeNode[]> {
        try {
            const response = await this._clickUpService.httpRequestV3(
                'GET', `/workspaces/${wsId}/docs?parent_id=${listId}&parent_type=6`
            );
            if (response.status < 200 || response.status >= 300) { return []; }
            const docs = Array.isArray(response.data?.docs) ? response.data.docs : [];
            return docs.map((doc: any) => ({
                id: `doc:${doc.id}`,
                name: doc.name || doc.title || 'Untitled Doc',
                kind: 'document' as const,
                hasChildren: !!(doc.pages_count) || !!(doc.pages?.length),  // CHANGED: was hardcoded false
                url: doc.url
            }));
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] _fetchDocsInList failed:', err);
            return [];
        }
    }

    // ── Extended API for dropdown + fetch ────────────────────────

    async listDocuments(): Promise<Array<{ id: string; title: string; url: string }>> {
        // Check cache FIRST — instant file read, no API needed
        // Try cache service first, then direct file read as fallback
        const cachedMap = await this._getCachedDocumentIdMapRobust();
        if (cachedMap && cachedMap.length > 0) {
            return cachedMap.map((doc: { docId: string; title: string; url?: string }) => ({ id: doc.docId, title: doc.title, url: doc.url || '' }));
        }

        // Cache miss — need workspace ID for API calls
        const wsId = await this._ensureWorkspaceId();
        if (!wsId) { return []; }

        try {
            // Proper v3 endpoint path anchored to the workspace
            const response = await this._clickUpService.httpRequestV3('GET', `/workspaces/${wsId}/docs`);
            // httpRequestV3 resolves on any HTTP status — throw on non-2xx so the
            // catch block below can attempt stale-cache fallback instead of returning []
            if (response.status < 200 || response.status >= 300) {
                throw new Error(this._localizeHttpError(response.status, 'ClickUp docs list failed'));
            }
            const docs = Array.isArray(response.data?.docs) ? response.data.docs : [];

            const allDocs = new Map<string, { id: string; title: string; url: string }>();

            // Add docs from unfiltered response
            docs.forEach((doc: any) => {
                allDocs.set(doc.id, {
                    id: doc.id,
                    title: doc.name || doc.title || 'Untitled',
                    url: doc.url
                });
            });

            // Conditional fan-out: only if unfiltered endpoint didn't return
            // docs with space properties (some ClickUp workspaces don't tag them)
            const hasSpaceProperty = docs.some((doc: any) =>
                doc.space?.id || doc.space_id || doc.spaceId || doc.parent?.space?.id
            );

            if (!hasSpaceProperty) {
                // Fan out across spaces to catch space-level docs the unfiltered
                // endpoint missed (also needed when docs.length === 0, as the
                // unfiltered endpoint may not return docs for some workspaces)
                const spaces = await this.listContainers();
                const spaceIds = spaces
                    .filter(s => s.id.startsWith('space:'))
                    .map(s => s.id.slice(6));

                for (const spaceId of spaceIds) {
                    try {
                        const spaceDocsResp = await this._clickUpService.httpRequestV3(
                            'GET',
                            `/workspaces/${wsId}/docs?parent_id=${spaceId}&parent_type=4`
                        );
                        if (spaceDocsResp.status >= 200 && spaceDocsResp.status < 300) {
                            const spaceDocs = Array.isArray(spaceDocsResp.data?.docs) ? spaceDocsResp.data.docs : [];
                            spaceDocs.forEach((doc: any) => {
                                if (!allDocs.has(doc.id)) {
                                    allDocs.set(doc.id, {
                                        id: doc.id,
                                        title: doc.name || doc.title || 'Untitled',
                                        url: doc.url
                                    });
                                }
                            });
                        }
                    } catch (err) {
                        console.warn('[ClickUpDocsAdapter] Failed to fetch docs for space:', spaceId, err);
                        // Continue on error for individual spaces
                    }
                }
            }
            
            const result = Array.from(allDocs.values());

            // Cache the result for future use
            if (this._cacheService) {
                try {
                    // Map from listDocuments format (id) to cache format (docId)
                    const cacheFormat = result.map(doc => ({ docId: doc.id, title: doc.title, url: doc.url }));
                    await this._cacheService.cacheDocumentIdMap('clickup', cacheFormat, new Date().toISOString());
                    
                    // Also cache document titles for sidebar instant-load
                    const titles = result.map(doc => ({ docId: doc.id, title: doc.title }));
                    await this._cacheService.cacheDocumentTitles('clickup', titles);
                } catch (cacheErr) {
                    // Cache write failure is non-blocking
                    console.warn('[ClickUpDocsAdapter] Failed to cache ID map:', cacheErr);
                }
            }
            
            return result;
        } catch (apiError) {
            console.warn('[ClickUpDocsAdapter] API fetch failed, attempting stale cache fallback:', apiError);
            // Last resort: return stale cached data even if we already checked it
            // (cache may have been populated between the initial check and now)
            const staleMap = await this._getCachedDocumentIdMapRobust();
            if (staleMap && staleMap.length > 0) {
                return staleMap.map((doc: { docId: string; title: string; url?: string }) => ({
                    id: doc.docId, title: doc.title, url: doc.url || ''
                }));
            }
            return [];
        }
    }

    /**
     * Robust cache reader that tries cache service first, then direct file read.
     * Includes error logging to diagnose cache issues.
     */
    private async _getCachedDocumentIdMapRobust(): Promise<Array<{ docId: string; title: string; url?: string }> | null> {
        // Try cache service first
        if (this._cacheService) {
            try {
                const map = await this._cacheService.getCachedDocumentIdMap('clickup');
                if (map && map.length > 0) {
                    return map;
                }
            } catch (err) {
                console.warn('[ClickUpDocsAdapter] Cache service read failed:', err);
            }
        }

        // Fallback: direct file read
        try {
            const mapPath = path.join(this._workspaceRoot, '.switchboard', 'planning-cache', 'clickup', 'documentIdMap.json');
            const raw = await fs.promises.readFile(mapPath, 'utf8');
            const data = JSON.parse(raw);
            if (data.idMap && Array.isArray(data.idMap) && data.idMap.length > 0) {
                return data.idMap;
            }
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] Direct cache file read failed:', err);
        }

        return null;
    }

    async fetchDocContent(docId: string, mode: 'summary' | 'full' = 'full'): Promise<{ success: boolean; docTitle?: string; content?: string; firstPageContent?: string; pages?: Array<{ id: string; name: string; parentId?: string }>; totalPages?: number; error?: string }> {
        const wsId = await this._ensureWorkspaceId();
        if (!wsId) { return { success: false, error: 'Missing ClickUp workspace ID' }; }

        try {
            // Get doc metadata with retry for rate limits (429)
            const endpoint = `/workspaces/${wsId}/docs/${docId}`;
            console.warn('[ClickUpDocsAdapter] Fetching doc:', { docId, wsId, endpoint });
            let docResponse = await this._clickUpService.httpRequestV3('GET', endpoint);
            let retries = 0;
            const maxRetries = 3;
            while (docResponse.status === 429 && retries < maxRetries) {
                retries++;
                const delayMs = Math.pow(2, retries) * 1000; // 1s, 2s, 4s
                console.warn(`[ClickUpDocsAdapter] Rate limited (429), retry ${retries}/${maxRetries} after ${delayMs}ms`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                docResponse = await this._clickUpService.httpRequestV3('GET', endpoint);
            }

            if (docResponse.status < 200 || docResponse.status >= 300) {
                console.error('[ClickUpDocsAdapter] Doc fetch failed:', { docId, wsId, endpoint, status: docResponse.status, body: docResponse.data });
                return { success: false, error: this._localizeHttpError(docResponse.status, 'ClickUp doc fetch failed') };
            }
            const doc = docResponse.data?.doc || docResponse.data;
            if (!doc) { return { success: false, error: 'Document not found' }; }

            const docTitle = doc.name || doc.title || 'Untitled Doc';

            // In summary mode, fetch page metadata + first page content to reduce API calls
            // Total: 3 calls (doc metadata + page listing + first page content)
            if (mode === 'summary') {
                const pageListingEndpoint = `/workspaces/${wsId}/docs/${docId}/pages?max_page_depth=-1`;
                let pageListing = await this._clickUpService.httpRequestV3('GET', pageListingEndpoint);
                retries = 0;
                while (pageListing.status === 429 && retries < maxRetries) {
                    retries++;
                    const delayMs = Math.pow(2, retries) * 1000;
                    console.warn(`[ClickUpDocsAdapter] Rate limited on page listing (429), retry ${retries}/${maxRetries} after ${delayMs}ms`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    pageListing = await this._clickUpService.httpRequestV3('GET', pageListingEndpoint);
                }
                if (pageListing.status < 200 || pageListing.status >= 300) {
                    return { success: false, error: this._localizeHttpError(pageListing.status, 'ClickUp page listing failed') };
                }
                const rawPages = Array.isArray(pageListing.data?.pages)
                    ? pageListing.data.pages
                    : (Array.isArray(pageListing.data) ? pageListing.data : []);

                const pages = rawPages.slice(0, this.MAX_PAGES).map((p: any) => ({
                    id: p.id,
                    name: p.name || p.title || 'Untitled',
                    parentId: p.parent_id || undefined
                }));

                // Fetch first page content for preview (1 additional API call)
                let firstPageContent = '';
                if (pages.length > 0) {
                    const firstPageId = pages[0].id;
                    const firstPageEndpoint = `/workspaces/${wsId}/docs/${docId}/pages/${firstPageId}?content_format=text%2Fmd`;
                    let firstPageResp = await this._clickUpService.httpRequestV3('GET', firstPageEndpoint);
                    let firstPageRetries = 0;
                    while (firstPageResp.status === 429 && firstPageRetries < maxRetries) {
                        firstPageRetries++;
                        const delayMs = Math.pow(2, firstPageRetries) * 1000;
                        console.warn(`[ClickUpDocsAdapter] Rate limited on first page fetch (429), retry ${firstPageRetries}/${maxRetries} after ${delayMs}ms`);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        firstPageResp = await this._clickUpService.httpRequestV3('GET', firstPageEndpoint);
                    }
                    if (firstPageResp.status >= 200 && firstPageResp.status < 300) {
                        const pageData = firstPageResp.data?.page || firstPageResp.data;
                        firstPageContent = pageData?.content || '';
                    }
                }

                const header = `# ${docTitle}\n\n${doc.url ? `> Fetched from ClickUp Docs: ${doc.url}\n\n` : '\n'}`;
                const content = firstPageContent ? header + `## ${pages[0]?.name || 'Page 1'}\n\n${firstPageContent}` : header;

                await this._updateDocumentIdMapEntry(docId, docTitle, doc.url);

                return { success: true, docTitle, content, firstPageContent, pages, totalPages: pages.length };
            }

            // Full mode: Get page bodies with content
            const pageListingEndpoint = `/workspaces/${wsId}/docs/${docId}/pages?content_format=text%2Fmd&max_page_depth=-1`;
            let pageListing = await this._clickUpService.httpRequestV3('GET', pageListingEndpoint);
            retries = 0;
            while (pageListing.status === 429 && retries < maxRetries) {
                retries++;
                const delayMs = Math.pow(2, retries) * 1000;
                console.warn(`[ClickUpDocsAdapter] Rate limited on page listing (429), retry ${retries}/${maxRetries} after ${delayMs}ms`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                pageListing = await this._clickUpService.httpRequestV3('GET', pageListingEndpoint);
            }
            if (pageListing.status < 200 || pageListing.status >= 300) {
                return { success: false, error: this._localizeHttpError(pageListing.status, 'ClickUp page listing failed') };
            }
            const rawPages = Array.isArray(pageListing.data?.pages)
                ? pageListing.data.pages
                : (Array.isArray(pageListing.data) ? pageListing.data : []);

            let content = '';
            let pageCount = 0;

            for (const page of rawPages) {
                if (pageCount >= this.MAX_PAGES) {
                    const remaining = rawPages.length - this.MAX_PAGES;
                    content += `\n\n*[Truncated: ${remaining} additional pages not included. View full doc: ${doc.url}]*\n\n`;
                    break;
                }
                // Page bodies can either come inline in the listing response (content field)
                // or require a per-page fetch. Prefer inline to minimize requests.
                let pageBody = page.content;
                if (!pageBody) {
                    const pageEndpoint = `/workspaces/${wsId}/docs/${docId}/pages/${page.id}?content_format=text%2Fmd`;
                    let pageResponse = await this._clickUpService.httpRequestV3('GET', pageEndpoint);
                    // Retry on rate limit for per-page fetch too
                    let pageRetries = 0;
                    while (pageResponse.status === 429 && pageRetries < maxRetries) {
                        pageRetries++;
                        const delayMs = Math.pow(2, pageRetries) * 1000;
                        console.warn(`[ClickUpDocsAdapter] Rate limited on per-page fetch (429), retry ${pageRetries}/${maxRetries} after ${delayMs}ms`);
                        await new Promise(resolve => setTimeout(resolve, delayMs));
                        pageResponse = await this._clickUpService.httpRequestV3('GET', pageEndpoint);
                    }
                    if (pageResponse.status >= 200 && pageResponse.status < 300) {
                        pageBody = pageResponse.data?.content || pageResponse.data?.page?.content || '';
                    } else {
                        pageBody = '';
                    }
                }
                content += `## ${page.name || page.title || 'Untitled'}\n\n${pageBody || ''}\n\n`;
                pageCount++;
            }

            const header = `# ${docTitle}\n\n${doc.url ? `> Fetched from ClickUp Docs: ${doc.url}\n\n` : '\n'}`;
            let fullContent = header + content;

            // Truncation parity with Notion
            if (fullContent.length > this.MAX_CHARS) {
                const truncated = fullContent.substring(0, this.MAX_CHARS);
                const lastHeading = truncated.lastIndexOf('\n#');
                if (lastHeading > 0) {
                    fullContent = truncated.substring(0, lastHeading) + '\n\n*[Truncated due to size limits]*';
                } else {
                    fullContent = truncated + '\n\n*[Truncated due to size limits]*';
                }
            }

            await this.saveConfig({
                docId,
                docTitle,
                docUrl: doc.url,
                setupComplete: true,
                lastFetchAt: new Date().toISOString()
            });
            await this.saveCachedContent(fullContent);

            // Update document ID map to keep cache in sync
            await this._updateDocumentIdMapEntry(docId, docTitle, doc.url);

            return { success: true, docTitle, content: fullContent };
        } catch (err: any) {
            console.warn('[ClickUpDocsAdapter] fetchDocContent failed:', err);
            return { success: false, error: String(err) };
        }
    }

    /**
     * Fetch full document content (all pages with content).
     * Used for on-demand full document import.
     */
    async fetchFullDocContent(docId: string): Promise<{ success: boolean; docTitle?: string; content?: string; error?: string }> {
        return this.fetchDocContent(docId, 'full');
    }

    /**
     * List pages in a document, returning hierarchical structure.
     * Used for showing subpages as expandable children in the tree.
     */
    async listDocPages(docId: string): Promise<TreeNode[]> {
        const wsId = await this._ensureWorkspaceId();
        if (!wsId) { return []; }
        const cleanDocId = docId.startsWith('doc:') ? docId.slice(4) : docId;

        try {
            // Fetch page metadata only (no content) to avoid burning API calls on tree expansion.
            // Content is fetched on demand via fetchPageContent when a page is clicked.
            const pageListingEndpoint = `/workspaces/${wsId}/docs/${cleanDocId}/pages?max_page_depth=-1`;
            let pageListing = await this._clickUpService.httpRequestV3('GET', pageListingEndpoint);
            let retries = 0;
            const maxRetries = 3;
            while (pageListing.status === 429 && retries < maxRetries) {
                retries++;
                const delayMs = Math.pow(2, retries) * 1000;
                console.warn(`[ClickUpDocsAdapter] Rate limited on page listing (429), retry ${retries}/${maxRetries} after ${delayMs}ms`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                pageListing = await this._clickUpService.httpRequestV3('GET', pageListingEndpoint);
            }

            if (pageListing.status < 200 || pageListing.status >= 300) {
                return [];
            }

            const rawPages = Array.isArray(pageListing.data?.pages)
                ? pageListing.data.pages
                : (Array.isArray(pageListing.data) ? pageListing.data : []);

            // Build hierarchy based on parent_id relationships
            const pageMap = new Map<string, TreeNode>();
            const rootPages: TreeNode[] = [];

            // First pass: create all page nodes
            rawPages.forEach((page: any) => {
                const pageId = `page:${cleanDocId}:${page.id}`;
                const node: TreeNode = {
                    id: pageId,
                    name: page.name || page.title || 'Untitled Page',
                    kind: 'document',
                    hasChildren: false,  // Will be updated in second pass
                    url: page.url,
                    parentId: page.parent_id ? `page:${cleanDocId}:${page.parent_id}` : undefined,
                    // Store content reference for fetching via metadata bag
                    metadata: { _pageId: page.id, _docId: cleanDocId }
                };
                pageMap.set(pageId, node);
            });

            // Second pass: establish parent-child relationships
            rawPages.forEach((page: any) => {
                if (page.parent_id) {
                    const parentId = `page:${cleanDocId}:${page.parent_id}`;
                    const parent = pageMap.get(parentId);
                    if (parent) {
                        parent.hasChildren = true;
                    }
                }
            });

            // Return ALL pages (not just roots) so the frontend can render the
            // full hierarchy in one shot.  Returning only roots required a second
            // fetchDocPages round-trip for nested subpages, but the backend's
            // listDocPages only accepts doc IDs — page: prefixed IDs would 404.
            return Array.from(pageMap.values());
        } catch (err) {
            console.warn('[ClickUpDocsAdapter] listDocPages failed:', err);
            return [];
        }
    }

    /**
     * Fetch content for a specific page (or full doc if no page specified).
     * Respects MAX_PAGES cap to avoid unbounded API calls.
     */
    async fetchPageContent(docId: string, pageId?: string): Promise<{ success: boolean; content?: string; docName?: string; error?: string }> {
        const wsId = await this._ensureWorkspaceId();
        if (!wsId) {
            return { success: false, error: 'Missing ClickUp workspace ID' };
        }
        const cleanDocId = docId.startsWith('doc:') ? docId.slice(4) : docId;

        try {
            // Get doc metadata with retry for rate limits
            const docEndpoint = `/workspaces/${wsId}/docs/${cleanDocId}`;
            let docResponse = await this._clickUpService.httpRequestV3('GET', docEndpoint);
            let retries = 0;
            const maxRetries = 3;
            while (docResponse.status === 429 && retries < maxRetries) {
                retries++;
                const delayMs = Math.pow(2, retries) * 1000;
                console.warn(`[ClickUpDocsAdapter] Rate limited on doc fetch (429), retry ${retries}/${maxRetries} after ${delayMs}ms`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
                docResponse = await this._clickUpService.httpRequestV3('GET', docEndpoint);
            }
            if (docResponse.status < 200 || docResponse.status >= 300) {
                return { success: false, error: this._localizeHttpError(docResponse.status, 'ClickUp doc fetch failed') };
            }
            const doc = docResponse.data?.doc || docResponse.data;
            if (!doc) { return { success: false, error: 'Document not found' }; }

            const docName = doc.name || doc.title || 'Untitled Doc';

            // If specific page requested — single API call
            if (pageId) {
                const cleanPageId = pageId.includes(':') ? pageId.split(':').pop()! : pageId;
                const pageEndpoint = `/workspaces/${wsId}/docs/${cleanDocId}/pages/${cleanPageId}?content_format=text%2Fmd`;
                let pageResponse = await this._clickUpService.httpRequestV3('GET', pageEndpoint);
                retries = 0;
                while (pageResponse.status === 429 && retries < maxRetries) {
                    retries++;
                    const delayMs = Math.pow(2, retries) * 1000;
                    console.warn(`[ClickUpDocsAdapter] Rate limited on page fetch (429), retry ${retries}/${maxRetries} after ${delayMs}ms`);
                    await new Promise(resolve => setTimeout(resolve, delayMs));
                    pageResponse = await this._clickUpService.httpRequestV3('GET', pageEndpoint);
                }
                if (pageResponse.status < 200 || pageResponse.status >= 300) {
                    return { success: false, error: this._localizeHttpError(pageResponse.status, 'Page fetch failed') };
                }
                const page = pageResponse.data?.page || pageResponse.data;
                const content = page?.content || '';
                const pageName = page?.name || page?.title || 'Untitled Page';

                // Update document ID map to keep cache in sync
                await this._updateDocumentIdMapEntry(cleanDocId, docName, doc.url);

                return {
                    success: true,
                    docName: pageName,
                    content: `# ${pageName}\n\n${content}`
                };
            }

            // Full doc - use fetchFullDocContent for consistency
            const fullDocResult = await this.fetchFullDocContent(cleanDocId);
            if (fullDocResult.success) {
                return { success: true, docName: fullDocResult.docTitle, content: fullDocResult.content };
            }
            return { success: false, error: fullDocResult.error || 'Failed to fetch full document' };
        } catch (err: any) {
            console.warn('[ClickUpDocsAdapter] fetchPageContent failed:', err);
            return { success: false, error: String(err) };
        }
    }

    async updateContent(docId: string, content: string): Promise<{ success: boolean; error?: string }> {
        try {
            const wsId = await this._ensureWorkspaceId();
            if (!wsId) {
                return { success: false, error: 'ClickUp workspace ID not available' };
            }

            // Size guard — prevent accidental large pushes
            const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB
            if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_SIZE) {
                return { success: false, error: 'Content exceeds 1MB size limit for sync' };
            }

            const cleanDocId = docId.startsWith('doc:') ? docId.slice(4) : docId;
            const response = await this._clickUpService.httpRequestV3(
                'PUT',
                `/workspaces/${wsId}/docs/${cleanDocId}`,
                { content }
            );

            if (response.status >= 200 && response.status < 300) {
                return { success: true };
            }
            return { success: false, error: `ClickUp API returned status ${response.status}` };
        } catch (err) {
            return { success: false, error: String(err) };
        }
    }
}
