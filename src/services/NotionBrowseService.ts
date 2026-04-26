import { NotionFetchService } from './NotionFetchService';

export interface NotionPage {
    id: string;
    title: string;
    url: string;
    parentId?: string;
}

export interface NotionDatabase {
    id: string;
    title: string;
    url: string;
}

export interface SearchResult {
    pages: NotionPage[];
    databases: NotionDatabase[];
    hasMore: boolean;
    nextCursor?: string;
}

export class NotionBrowseService {
    private _workspaceRoot: string;
    private _notionService: NotionFetchService;

    constructor(workspaceRoot: string, notionService: NotionFetchService) {
        this._workspaceRoot = workspaceRoot;
        this._notionService = notionService;
    }

    private _extractTitle(properties: any): string {
        if (!properties) return 'Untitled';
        for (const key of Object.keys(properties)) {
            const prop = properties[key];
            if (prop && prop.type === 'title' && Array.isArray(prop.title) && prop.title.length > 0) {
                return prop.title.map((t: any) => t.plain_text).join('') || 'Untitled';
            }
        }
        return 'Untitled';
    }

    private _permissionError(kind: 'page' | 'database'): string {
        return `This ${kind} hasn't been shared with the Switchboard integration. Please share it via Notion's Share menu: Share → Add connections → Switchboard.`;
    }

    async searchPages(query: string, startCursor?: string): Promise<{ success: boolean; result?: SearchResult; error?: string }> {
        try {
            const requestBody: any = {
                query: query.trim().slice(0, 256),
                filter: { value: 'page', property: 'object' },
                page_size: 100
            };
            if (startCursor) {
                requestBody.start_cursor = startCursor;
            }

            const response = await this._notionService.httpRequest('POST', '/search', requestBody);

            // NotionFetchService.httpRequest resolves on all HTTP statuses — inspect status here
            if (response.status === 404 || response.data?.code === 'object_not_found') {
                return { success: false, error: this._permissionError('page') };
            }
            if (response.status !== 200) {
                return { success: false, error: response.data?.message || `Notion search failed (HTTP ${response.status})` };
            }

            const results = Array.isArray(response.data?.results) ? response.data.results : [];
            const pages = results.map((page: any) => ({
                id: page.id,
                title: this._extractTitle(page.properties),
                url: page.url,
                parentId: page.parent?.page_id || page.parent?.database_id
            }));

            return {
                success: true,
                result: {
                    pages,
                    databases: [],
                    hasMore: response.data?.has_more || false,
                    nextCursor: response.data?.next_cursor
                }
            };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }

    async searchDatabases(query: string, startCursor?: string): Promise<{ success: boolean; result?: SearchResult; error?: string }> {
        try {
            const requestBody: any = {
                query: query.trim().slice(0, 256),
                filter: { value: 'database', property: 'object' },
                page_size: 100
            };
            if (startCursor) {
                requestBody.start_cursor = startCursor;
            }

            const response = await this._notionService.httpRequest('POST', '/search', requestBody);

            if (response.status === 404 || response.data?.code === 'object_not_found') {
                return { success: false, error: this._permissionError('database') };
            }
            if (response.status !== 200) {
                return { success: false, error: response.data?.message || `Notion search failed (HTTP ${response.status})` };
            }

            const results = Array.isArray(response.data?.results) ? response.data.results : [];
            const databases = results.map((db: any) => ({
                id: db.id,
                title: this._extractTitle(db.properties),
                url: db.url
            }));

            return {
                success: true,
                result: {
                    pages: [],
                    databases,
                    hasMore: response.data?.has_more || false,
                    nextCursor: response.data?.next_cursor
                }
            };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }

    async listDatabasePages(databaseId: string, startCursor?: string): Promise<{ success: boolean; result?: SearchResult; error?: string }> {
        try {
            const requestBody: any = {
                page_size: 100
            };
            if (startCursor) {
                requestBody.start_cursor = startCursor;
            }

            const response = await this._notionService.httpRequest('POST', `/databases/${databaseId}/query`, requestBody);

            if (response.status === 404 || response.data?.code === 'object_not_found') {
                return { success: false, error: this._permissionError('database') };
            }
            if (response.status !== 200) {
                return { success: false, error: response.data?.message || `Notion database query failed (HTTP ${response.status})` };
            }

            const results = Array.isArray(response.data?.results) ? response.data.results : [];
            return {
                success: true,
                result: {
                    pages: results.map((page: any) => ({
                        id: page.id,
                        title: this._extractTitle(page.properties),
                        url: page.url,
                        parentId: databaseId
                    })),
                    databases: [],
                    hasMore: response.data?.has_more || false,
                    nextCursor: response.data?.next_cursor
                }
            };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }

    async getChildPages(pageId: string): Promise<{ success: boolean; pages?: NotionPage[]; error?: string }> {
        // Single-level enumeration of child_page blocks. Non-recursive by design:
        // the webview drives expansion one level at a time, so no traversal state
        // needs to be threaded. If a future revision introduces server-side recursion,
        // reintroduce a visited Set *and* actually propagate it across recursive calls.
        try {
            const response = await this._notionService.httpRequest('GET', `/blocks/${pageId}/children?page_size=100`);

            if (response.status === 404 || response.data?.code === 'object_not_found') {
                return { success: false, error: this._permissionError('page') };
            }
            if (response.status !== 200) {
                return { success: false, error: response.data?.message || `Notion block fetch failed (HTTP ${response.status})` };
            }

            const results = Array.isArray(response.data?.results) ? response.data.results : [];
            const childPages = results
                .filter((block: any) => block.type === 'child_page')
                .map((block: any) => ({
                    id: block.id,
                    title: block.child_page?.title || 'Untitled',
                    // child_page blocks don't expose a `url` field — synthesise the standard
                    // Notion URL from the block id so the webview's "Open in Notion" link works.
                    url: block.url || `https://www.notion.so/${String(block.id || '').replace(/-/g, '')}`,
                    parentId: pageId
                }));

            return { success: true, pages: childPages };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }

    async fetchPageContent(pageId: string): Promise<{ success: boolean; content?: string; title?: string; error?: string }> {
        try {
            // 1. Fetch page metadata for title
            const pageResponse = await this._notionService.httpRequest('GET', `/pages/${pageId}`);
            if (pageResponse.status === 404 || pageResponse.data?.code === 'object_not_found') {
                return { success: false, error: this._permissionError('page') };
            }
            if (pageResponse.status !== 200) {
                return { success: false, error: pageResponse.data?.message || `Page fetch failed (HTTP ${pageResponse.status})` };
            }
            const title = this._extractTitle(pageResponse.data?.properties);

            // 2. Fetch blocks recursively (reuses existing NotionFetchService logic)
            const blocks = await this._notionService.fetchBlocksRecursive(pageId);

            // 3. Convert using the existing PUBLIC converter — no placeholder, no duplication.
            const body = this._notionService.convertBlocksToMarkdown(blocks);
            const content = `# ${title}\n\n${body}`;

            return { success: true, content, title };
        } catch (err: any) {
            return { success: false, error: String(err) };
        }
    }
}
