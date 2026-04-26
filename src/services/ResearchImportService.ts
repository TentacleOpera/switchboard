import { NotionFetchService } from './NotionFetchService';
import { NotionBrowseService } from './NotionBrowseService';
import { LocalFolderService } from './LocalFolderService';
import { LinearDocsAdapter } from './LinearDocsAdapter';
import { ClickUpDocsAdapter } from './ClickUpDocsAdapter';

export interface ResearchFile {
    id: string;
    name: string;
    source: string;
    url?: string;
    lastModified?: string;
    isFolder?: boolean;
    parentId?: string;
}

export interface TreeNode {
    id: string;
    name: string;
    kind: 'folder' | 'document';
    parentId?: string;
    hasChildren: boolean;
    url?: string;
    spaceId?: string;                          // NEW: breadcrumb tracking
    metadata?: Record<string, string>;          // NEW: adapter-specific data (e.g. _pageId, _docId)
}

export interface ResearchSourceAdapter {
    readonly sourceId: string;
    listFiles(): Promise<ResearchFile[]>;
    fetchContent(fileId: string): Promise<string>;
    fetchChildren(parentId?: string): Promise<TreeNode[]>;
    listContainers(): Promise<TreeNode[]>;
    listDocumentsByContainer(containerId: string): Promise<TreeNode[]>;

    // NEW: Optional methods for hierarchical document support
    listDocPages?(docId: string): Promise<TreeNode[]>;
    fetchPageContent?(docId: string, pageId?: string): Promise<{ success: boolean; content?: string; docName?: string; error?: string }>;
    fetchFullDocContent?(docId: string): Promise<{ success: boolean; docTitle?: string; content?: string; error?: string }>;

    // Optional: write-back support for sync-to-source
    updateContent?(fileId: string, content: string): Promise<{ success: boolean; error?: string }>;
}

export class NotionResearchAdapter implements ResearchSourceAdapter {
    readonly sourceId = 'notion';
    private _service: NotionFetchService;
    private _browseService: NotionBrowseService;
    // Single-flight guard: collapse duplicate fetchContent() calls for the same page.
    private _inFlight = new Map<string, Promise<string>>();

    constructor(service: NotionFetchService, browseService: NotionBrowseService) {
        this._service = service;
        this._browseService = browseService;
    }

    async listFiles(): Promise<ResearchFile[]> {
        const config = await this._service.loadConfig();
        if (!config || !config.pageUrl) { return []; }
        return [{
            id: config.pageId || config.pageUrl,
            name: config.pageTitle || 'Untitled Notion Page',
            source: 'notion',
            url: config.pageUrl,
            lastModified: config.lastFetchAt || undefined
        }];
    }

    async fetchContent(fileId: string): Promise<string> {
        // Accept 'page:<id>', 'database:<id>', and legacy bare '<id>' formats
        let pageId = '';
        if (fileId.startsWith('page:')) {
            pageId = fileId.slice(5);
        } else if (fileId.startsWith('database:')) {
            // Database folders don't have preview content - return empty
            return '';
        } else {
            pageId = fileId; // Legacy format
        }

        if (!pageId) {
            // Empty/invalid id — fall through to legacy cache for backwards-compat.
            const cached = await this._service.loadCachedContent();
            return cached || '';
        }

        // Single-flight guard: return existing in-flight promise if one is pending for this pageId.
        const existing = this._inFlight.get(pageId);
        if (existing) { return existing; }

        const promise = (async () => {
            try {
                const result = await this._browseService.fetchPageContent(pageId);
                if (result.success && result.content) {
                    return result.content;
                }
                // Fallback to legacy cached content only on error so the modal's prior state
                // still provides a preview if the user hasn't reconfigured.
                const cached = await this._service.loadCachedContent();
                return cached || '';
            } finally {
                this._inFlight.delete(pageId);
            }
        })();

        this._inFlight.set(pageId, promise);
        return promise;
    }

    async fetchChildren(parentId?: string): Promise<TreeNode[]> {
        // Root: search for both pages and databases in workspace
        if (parentId === undefined) {
            const nodes: TreeNode[] = [];
            
            // Search for pages
            const pagesResult = await this._browseService.searchPages('');
            if (pagesResult.success && pagesResult.result) {
                nodes.push(...pagesResult.result.pages.map(p => ({
                    id: `page:${p.id}`,
                    name: p.title,
                    kind: 'document' as const,
                    // Flat leaf: Notion's /v1/search returns pages at any depth, so the tree
                    // does not also need to drill. Unconditional expansion chevrons caused
                    // "click → empty list" papercuts on every childless page.
                    hasChildren: false,
                    url: p.url
                })));
            }

            // Search for databases
            const dbResult = await this._browseService.searchDatabases('');
            if (dbResult.success && dbResult.result) {
                nodes.push(...dbResult.result.databases.map(db => ({
                    id: `database:${db.id}`,
                    name: db.title,
                    kind: 'folder' as const,
                    hasChildren: true,  // Databases contain pages
                    url: db.url
                })));
            }

            return nodes;
        }

        // Handle database children
        if (parentId.startsWith('database:')) {
            const dbId = parentId.slice(9);
            const dbResult = await this._browseService.listDatabasePages(dbId);
            if (dbResult.success && dbResult.result) {
                return dbResult.result.pages.map(p => ({
                    id: `page:${p.id}`,
                    name: p.title,
                    kind: 'document' as const,
                    hasChildren: false, // Leaf (see note on root page mapping above).
                    url: p.url
                }));
            }
            return [];
        }

        // Handle page children (child pages).
        // Currently unreachable from the UI since root/database pages are leaves, but kept
        // for programmatic callers and potential Phase 3 drill-down.
        if (parentId.startsWith('page:')) {
            const pageId = parentId.slice(5);
            const childResult = await this._browseService.getChildPages(pageId);
            if (childResult.success && childResult.pages) {
                return childResult.pages.map(p => ({
                    id: `page:${p.id}`,
                    name: p.title,
                    kind: 'document' as const,
                    hasChildren: false,
                    url: p.url
                }));
            }
            return [];
        }

        return [];
    }

    async listContainers(): Promise<TreeNode[]> {
        // Return databases as filterable containers
        const dbResult = await this._browseService.searchDatabases('');
        if (dbResult.success && dbResult.result) {
            return dbResult.result.databases.map(db => ({
                id: `database:${db.id}`,
                name: db.title,
                kind: 'folder' as const,
                hasChildren: true,
                url: db.url
            }));
        }
        return [];
    }

    async listDocumentsByContainer(containerId: string): Promise<TreeNode[]> {
        if (containerId.startsWith('database:')) {
            const dbId = containerId.slice(9);
            const dbResult = await this._browseService.listDatabasePages(dbId);
            if (dbResult.success && dbResult.result) {
                return dbResult.result.pages.map(p => ({
                    id: `page:${p.id}`,
                    name: p.title,
                    kind: 'document' as const,
                    hasChildren: false,
                    url: p.url
                }));
            }
        }
        return [];
    }

    async updateContent(fileId: string, content: string): Promise<{ success: boolean; error?: string }> {
        try {
            let pageId = fileId;
            if (fileId.startsWith('page:')) {
                pageId = fileId.slice(5);
            } else if (fileId.startsWith('database:')) {
                return { success: false, error: 'Cannot sync back to a Notion database' };
            }

            if (!pageId) {
                return { success: false, error: 'Invalid Notion page ID' };
            }

            // Size guard
            const MAX_CONTENT_SIZE = 1024 * 1024; // 1MB
            if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_SIZE) {
                return { success: false, error: 'Content exceeds 1MB size limit for sync' };
            }

            // Use the Notion service to update the page content
            const result = await this._service.updatePageContent(pageId, content);
            return result;
        } catch (err) {
            return { success: false, error: String(err) };
        }
    }
}

// New adapter wrapping LocalFolderService for the ResearchSourceAdapter interface
export class LocalFolderResearchAdapter implements ResearchSourceAdapter {
    readonly sourceId = 'local-folder';
    private _service: LocalFolderService;

    constructor(service: LocalFolderService) {
        this._service = service;
    }

    async listFiles(): Promise<ResearchFile[]> {
        const files = await this._service.listFiles();
        return files.map(f => ({
            id: f.relativePath || f.id,
            name: f.name,
            source: 'local-folder',
            url: undefined,
            lastModified: undefined,
            isFolder: f.isFolder,
            parentId: f.parentId
        }));
    }

    async fetchContent(fileId: string): Promise<string> {
        // Fetch the specific file so preview matches the clicked node AND
        // the on-disk cache is updated before PlannerPromptWriter reads it.
        // Falls back to cache on error (e.g. file missing) for graceful degradation.
        if (fileId) {
            const result = await this._service.fetchDocContent(fileId);
            if (result.success && typeof result.content === 'string') {
                return result.content;
            }
        }
        const cached = await this._service.loadCachedContent();
        return cached || '';
    }

    async fetchChildren(parentId?: string): Promise<TreeNode[]> {
        const files = await this._service.listFiles();

        return files.map(f => ({
            id: f.relativePath || f.id,
            name: f.name,
            kind: f.isFolder ? 'folder' : 'document',
            parentId: f.parentId,
            // Folders always show expand arrow — children resolved lazily.
            // Known trade-off: empty folders will show an expand arrow that resolves to [].
            hasChildren: f.isFolder === true,
            url: undefined
        }));
    }

    async listContainers(): Promise<TreeNode[]> {
        return [];  // No container hierarchy for local folders
    }

    async listDocumentsByContainer(containerId: string): Promise<TreeNode[]> {
        return [];  // Not applicable — files are listed flat
    }
}

export class ResearchImportService {
    private _adapters = new Map<string, ResearchSourceAdapter>();

    registerAdapter(adapter: ResearchSourceAdapter | undefined): void {
        if (!adapter) { return; }
        this._adapters.set(adapter.sourceId, adapter);
    }

    getAdapter(sourceId: string): ResearchSourceAdapter | undefined {
        return this._adapters.get(sourceId);
    }

    getAvailableSources(): string[] {
        return Array.from(this._adapters.keys());
    }
}
