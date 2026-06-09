'use strict';

const assert = require('assert');
const { loadOutModule } = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');

describe('NotionResearchAdapter - Tree Operations', function() {
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
            loadCachedContent: async () => '# Cached Content\n\nThis is from the legacy cache.'
        };

        mockBrowseService = {
            searchPages: async () => ({ success: true, result: { pages: [], databases: [], hasMore: false } }),
            searchDatabases: async () => ({ success: true, result: { pages: [], databases: [], hasMore: false } }),
            listDatabasePages: async () => ({ success: true, result: { pages: [], databases: [], hasMore: false } }),
            getChildPages: async () => ({ success: true, pages: [] })
        };

        adapter = createAdapter();
    });

    describe('fetchChildren at root', function() {
        it('should return pages from search when parentId is undefined', async function() {
            mockBrowseService.searchPages = async () => ({
                success: true,
                result: {
                    pages: [
                        { id: 'a', title: 'Page A', url: 'https://notion.so/a' },
                        { id: 'b', title: 'Page B', url: 'https://notion.so/b' },
                        { id: 'c', title: 'Page C', url: 'https://notion.so/c' }
                    ],
                    databases: [],
                    hasMore: false
                }
            });

            const nodes = await adapter.fetchChildren(undefined);

            assert.strictEqual(nodes.length, 3, 'Should return 3 pages');
            assert.strictEqual(nodes[0].id, 'page:a', 'First node ID should be prefixed with page:');
            assert.strictEqual(nodes[0].name, 'Page A', 'First node name should match');
            assert.strictEqual(nodes[0].kind, 'document', 'Node kind should be document');
            assert.strictEqual(nodes[0].hasChildren, false, 'Pages are leaves (flat tree; discovery via search)');
            assert.strictEqual(nodes[0].url, 'https://notion.so/a', 'URL should be carried through');

            assert.strictEqual(nodes[1].id, 'page:b');
            assert.strictEqual(nodes[2].id, 'page:c');
        });

        it('should return database folders at root', async function() {
            mockBrowseService.searchDatabases = async () => ({
                success: true,
                result: {
                    pages: [],
                    databases: [
                        { id: 'db1', title: 'Database 1', url: 'https://notion.so/db1' },
                        { id: 'db2', title: 'Database 2', url: 'https://notion.so/db2' }
                    ],
                    hasMore: false
                }
            });

            const nodes = await adapter.fetchChildren(undefined);

            const dbNodes = nodes.filter(n => n.kind === 'folder');
            assert.strictEqual(dbNodes.length, 2, 'Should return 2 database folders');
            assert.strictEqual(dbNodes[0].id, 'database:db1', 'Database ID should be prefixed with database:');
            assert.strictEqual(dbNodes[0].kind, 'folder', 'Database nodes should be folders');
            assert.strictEqual(dbNodes[0].hasChildren, true, 'Databases contain pages');
        });

        it('should return empty array on search failure', async function() {
            mockBrowseService.searchPages = async () => ({
                success: false,
                error: 'Search failed'
            });

            const nodes = await adapter.fetchChildren(undefined);

            assert.strictEqual(nodes.length, 0, 'Should return empty array on search failure');
        });

        it('should return empty array when search returns no pages', async function() {
            mockBrowseService.searchPages = async () => ({
                success: true,
                result: { pages: [], databases: [], hasMore: false }
            });

            const nodes = await adapter.fetchChildren(undefined);

            assert.strictEqual(nodes.length, 0, 'Should return empty array when no pages');
        });
    });

    describe('fetchChildren with parentId', function() {
        it('should return database pages when parentId is database: prefix', async function() {
            mockBrowseService.listDatabasePages = async (dbId) => {
                assert.strictEqual(dbId, 'db1', 'Should call with stripped database ID');
                return {
                    success: true,
                    result: {
                        pages: [
                            { id: 'p1', title: 'Page 1', url: 'https://notion.so/p1', parentId: 'db1' },
                            { id: 'p2', title: 'Page 2', url: 'https://notion.so/p2', parentId: 'db1' }
                        ],
                        databases: [],
                        hasMore: false
                    }
                };
            };

            const nodes = await adapter.fetchChildren('database:db1');

            assert.strictEqual(nodes.length, 2, 'Should return 2 pages from database');
            assert.strictEqual(nodes[0].id, 'page:p1', 'Page ID should be prefixed with page:');
            assert.strictEqual(nodes[0].kind, 'document', 'Database pages are documents');
            assert.strictEqual(nodes[0].hasChildren, false, 'Database pages are leaves');
        });

        it('should return child pages when parentId is page: prefix', async function() {
            mockBrowseService.getChildPages = async (pageId) => {
                assert.strictEqual(pageId, 'page-a', 'Should call with stripped page ID');
                return {
                    success: true,
                    pages: [
                        { id: 'child1', title: 'Child 1', url: 'https://notion.so/child1', parentId: 'page-a' },
                        { id: 'child2', title: 'Child 2', url: 'https://notion.so/child2', parentId: 'page-a' }
                    ]
                };
            };

            const nodes = await adapter.fetchChildren('page:page-a');

            assert.strictEqual(nodes.length, 2, 'Should return 2 child pages');
            assert.strictEqual(nodes[0].id, 'page:child1', 'Child page ID should be prefixed with page:');
            assert.strictEqual(nodes[0].kind, 'document', 'Child pages are documents');
            assert.strictEqual(nodes[0].hasChildren, false, 'Child pages are leaves (flat tree)');
        });

        it('should return empty array for unknown parentId format', async function() {
            const nodes = await adapter.fetchChildren('unknown:xyz');
            assert.strictEqual(nodes.length, 0, 'Should return empty array for unknown format');
        });

        it('should allow re-expanding the same page across calls', async function() {
            // Regression test: instance-level visited set bug would cause second call to return empty
            let callCount = 0;
            mockBrowseService.getChildPages = async (pageId) => {
                callCount++;
                return {
                    success: true,
                    pages: [{ id: 'child1', title: 'Child 1', url: 'https://notion.so/child1', parentId: pageId }]
                };
            };

            const nodes1 = await adapter.fetchChildren('page:page-a');
            const nodes2 = await adapter.fetchChildren('page:page-a');

            assert.strictEqual(callCount, 2, 'Should call getChildPages on each invocation');
            assert.strictEqual(nodes1.length, 1, 'First call should return child');
            assert.strictEqual(nodes2.length, 1, 'Second call should also return child (no stale state)');
        });
    });
});
