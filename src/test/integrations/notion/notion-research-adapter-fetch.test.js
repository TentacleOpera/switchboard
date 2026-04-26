'use strict';

const assert = require('assert');
const { loadOutModule } = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');

describe('NotionResearchAdapter - Content Fetching', function() {
    let mockNotionService;
    let mockBrowseService;
    let adapter;

    function createAdapter() {
        const installed = installVsCodeMock();
        const module = loadOutModule('services/ResearchImportService.js');
        installed.restore();
        const NotionResearchAdapter = module.NotionResearchAdapter;
        return new NotionResearchAdapter(mockNotionService, mockBrowseService);
    }

    beforeEach(function() {
        mockNotionService = {
            loadConfig: async () => ({ pageId: 'config-page', pageUrl: 'https://notion.so/config', pageTitle: 'Config Page' }),
            loadCachedContent: async () => '# Legacy Cache\n\nThis is from the legacy cache.'
        };

        mockBrowseService = {
            searchPages: async () => ({ success: true, result: { pages: [], databases: [], hasMore: false } }),
            fetchPageContent: async () => ({ success: true, content: '', title: '' })
        };

        adapter = createAdapter();
    });

    describe('fetchContent with page: prefix', function() {
        it('should fetch page content when prefixed with page:', async function() {
            mockBrowseService.fetchPageContent = async (pageId) => {
                assert.strictEqual(pageId, 'page-123', 'Should call with stripped pageId');
                return { success: true, content: '# Hello\n\nThis is page content.', title: 'Hello' };
            };

            const content = await adapter.fetchContent('page:page-123');

            assert.strictEqual(content, '# Hello\n\nThis is page content.', 'Should return fetched content');
        });
    });

    describe('fetchContent without prefix', function() {
        it('should fetch page content when using bare ID (legacy format)', async function() {
            mockBrowseService.fetchPageContent = async (pageId) => {
                assert.strictEqual(pageId, 'page-123', 'Should call with bare pageId');
                return { success: true, content: '# Hello\n\nThis is page content.', title: 'Hello' };
            };

            const content = await adapter.fetchContent('page-123');

            assert.strictEqual(content, '# Hello\n\nThis is page content.', 'Should return fetched content');
        });
    });

    describe('fetchContent with database: prefix', function() {
        it('should return empty string for database folders', async function() {
            const content = await adapter.fetchContent('database:db1');
            assert.strictEqual(content, '', 'Database folders have no preview content');
        });
    });

    describe('fetchContent fallback on error', function() {
        it('should fall back to legacy cache when fetch fails', async function() {
            mockBrowseService.fetchPageContent = async () => {
                return { success: false, error: 'not found' };
            };

            const content = await adapter.fetchContent('page:missing');

            assert.strictEqual(content, '# Legacy Cache\n\nThis is from the legacy cache.', 'Should return legacy cache on error');
        });
    });

    describe('fetchContent empty/invalid ID', function() {
        it('should fall through to legacy cache for empty ID', async function() {
            const content = await adapter.fetchContent('');

            assert.strictEqual(content, '# Legacy Cache\n\nThis is from the legacy cache.', 'Should return legacy cache for empty ID');
        });

        it('should fall through to legacy cache for page: prefix only', async function() {
            const content = await adapter.fetchContent('page:');

            assert.strictEqual(content, '# Legacy Cache\n\nThis is from the legacy cache.', 'Should return legacy cache for page: prefix only');
        });
    });

    describe('single-flight guard', function() {
        it('should collapse duplicate fetchContent calls for the same page', async function() {
            let fetchCount = 0;
            mockBrowseService.fetchPageContent = async (pageId) => {
                fetchCount++;
                // Simulate slow fetch
                await new Promise(resolve => setTimeout(resolve, 50));
                return { success: true, content: '# Slow Content', title: 'Slow' };
            };

            const promise1 = adapter.fetchContent('page:slow');
            const promise2 = adapter.fetchContent('page:slow');

            const [content1, content2] = await Promise.all([promise1, promise2]);

            assert.strictEqual(fetchCount, 1, 'Should call fetchPageContent exactly once');
            assert.strictEqual(content1, '# Slow Content', 'First promise should resolve');
            assert.strictEqual(content2, '# Slow Content', 'Second promise should resolve to same content');
        });
    });
});
