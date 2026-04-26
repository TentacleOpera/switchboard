'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const {
    withWorkspace,
    flushPromises,
    loadOutModule
} = require('./integrations/shared/test-harness');
const { installVsCodeMock } = require('./integrations/shared/vscode-mock');
const { SecretStorageMock } = require('./integrations/shared/secret-storage-mock');
const { installHttpsMock } = require('./integrations/shared/http-mock-helpers');

// ── NotionBrowseService Contract Tests ──────────────────────────────

async function testNotion404PermissionError() {
    await withWorkspace('notion-contract-404', async ({ workspaceRoot }) => {
        const installed = installVsCodeMock();
        const { NotionFetchService } = loadOutModule('services/NotionFetchService.js');
        const { NotionBrowseService } = loadOutModule('services/NotionBrowseService.js');
        installed.restore();

        const mockSecretStorage = new SecretStorageMock({
            'switchboard.notion.apiToken': 'secret_test_token'
        });
        const notionFetchService = new NotionFetchService(workspaceRoot, mockSecretStorage);
        const notionBrowseService = new NotionBrowseService(workspaceRoot, notionFetchService);
        const http = installHttpsMock();

        try {
            // Mock 404 response for search
            http.queueJson(404, { code: 'object_not_found', message: 'Not found' }, (req) => 
                req.path === '/v1/search'
            );

            const result = await notionBrowseService.searchPages('test query');

            assert.strictEqual(result.success, false, 'Search should fail on 404');
            // Assert the full distinctive user-facing hint, not just "Share" + "Switchboard"
            // which could match far weaker error strings.
            assert.ok(
                result.error?.includes('Add connections'),
                `Error should contain the "Add connections" hint (got: ${result.error})`
            );
            assert.ok(
                result.error?.includes('Share'),
                'Error should mention sharing via Notion menu'
            );
            assert.ok(
                result.error?.includes('Switchboard'),
                'Error should mention Switchboard integration'
            );
            // Sanity: the user-facing hint must reference a page, not the generic phrasing.
            assert.ok(
                result.error?.includes('page'),
                'Error should identify the object kind as a page'
            );
            assert.strictEqual(http.requests.length, 1, 'Should make exactly one HTTP request');
            assert.strictEqual(http.requests[0].path, '/v1/search');
        } finally {
            http.restore();
        }
    });
}

async function testNotionDatabase404PermissionError() {
    await withWorkspace('notion-contract-db-404', async ({ workspaceRoot }) => {
        const installed = installVsCodeMock();
        const { NotionFetchService } = loadOutModule('services/NotionFetchService.js');
        const { NotionBrowseService } = loadOutModule('services/NotionBrowseService.js');
        installed.restore();

        const mockSecretStorage = new SecretStorageMock({
            'switchboard.notion.apiToken': 'secret_test_token'
        });
        const notionFetchService = new NotionFetchService(workspaceRoot, mockSecretStorage);
        const notionBrowseService = new NotionBrowseService(workspaceRoot, notionFetchService);
        const http = installHttpsMock();

        try {
            // Mock 404 response for database query
            http.queueJson(404, { code: 'object_not_found', message: 'Database not found' }, (req) => 
                req.path.includes('/databases/') && req.path.includes('/query')
            );

            const result = await notionBrowseService.listDatabasePages('db_123');

            assert.strictEqual(result.success, false, 'Database query should fail on 404');
            assert.ok(result.error?.includes('database'), 'Error should identify the object kind as database');
            assert.ok(result.error?.includes('Share'), 'Error should mention sharing');
            assert.ok(
                result.error?.includes('Add connections'),
                `Error should contain the "Add connections" hint (got: ${result.error})`
            );
            assert.ok(
                result.error?.includes('Switchboard'),
                'Error should mention Switchboard integration'
            );
            assert.strictEqual(http.requests.length, 1, 'Should make exactly one HTTP request');
        } finally {
            http.restore();
        }
    });
}

async function testNotionSuccessfulSearchResponseParsing() {
    await withWorkspace('notion-contract-success', async ({ workspaceRoot }) => {
        const installed = installVsCodeMock();
        const { NotionFetchService } = loadOutModule('services/NotionFetchService.js');
        const { NotionBrowseService } = loadOutModule('services/NotionBrowseService.js');
        installed.restore();

        const mockSecretStorage = new SecretStorageMock({
            'switchboard.notion.apiToken': 'secret_test_token'
        });
        const notionFetchService = new NotionFetchService(workspaceRoot, mockSecretStorage);
        const notionBrowseService = new NotionBrowseService(workspaceRoot, notionFetchService);
        const http = installHttpsMock();

        try {
            // Mock successful search response with realistic payload
            http.queueJson(200, {
                results: [
                    {
                        id: 'page-123',
                        url: 'https://notion.so/page-123',
                        properties: {
                            title: {
                                type: 'title',
                                title: [{ plain_text: 'Test Page' }]
                            }
                        },
                        parent: {
                            page_id: 'parent-456'
                        }
                    },
                    {
                        id: 'page-789',
                        url: 'https://notion.so/page-789',
                        properties: {
                            Name: {
                                type: 'title',
                                title: [{ plain_text: 'Another Page' }]
                            }
                        },
                        parent: {
                            database_id: 'db-abc'
                        }
                    }
                ]
            }, (req) => req.path === '/v1/search');

            const result = await notionBrowseService.searchPages('test');

            assert.strictEqual(result.success, true, 'Search should succeed');
            assert.strictEqual(result.result?.pages.length, 2, 'Should return 2 pages');
            assert.strictEqual(result.result.pages[0].id, 'page-123');
            assert.strictEqual(result.result.pages[0].title, 'Test Page');
            assert.strictEqual(result.result.pages[0].parentId, 'parent-456');
            assert.strictEqual(result.result.pages[1].id, 'page-789');
            assert.strictEqual(result.result.pages[1].title, 'Another Page');
            assert.strictEqual(result.result.pages[1].parentId, 'db-abc');
        } finally {
            http.restore();
        }
    });
}

// ── ClickUpDocsAdapter Contract Tests ───────────────────────────────

async function testClickUpDocsListDocuments() {
    await withWorkspace('clickup-contract-list', async ({ workspaceRoot }) => {
        const installed = installVsCodeMock();
        const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService.js');
        const { ClickUpDocsAdapter } = loadOutModule('services/ClickUpDocsAdapter.js');
        installed.restore();

        const mockSecretStorage = new SecretStorageMock({
            'switchboard.clickup.apiToken': 'pk_test_token'
        });
        const clickUpService = new ClickUpSyncService(workspaceRoot, mockSecretStorage);
        const adapter = new ClickUpDocsAdapter(workspaceRoot, clickUpService);
        
        // Save config with workspace ID
        await clickUpService.saveConfig({
            workspaceId: 'ws-123',
            folderId: '',
            spaceId: '',
            columnMappings: {},
            customFields: { sessionId: '', planId: '', syncTimestamp: '' },
            setupComplete: true,
            lastSync: null,
            realTimeSyncEnabled: false,
            autoPullEnabled: false,
            pullIntervalMinutes: 60,
            automationRules: []
        });

        const http = installHttpsMock();

        try {
            // Mock successful docs list response
            http.queueJson(200, {
                docs: [
                    { id: 'doc-1', name: 'Design Doc', url: 'https://clickup.com/doc-1' },
                    { id: 'doc-2', title: 'Requirements', url: 'https://clickup.com/doc-2' },
                    { id: 'doc-3', url: 'https://clickup.com/doc-3' }
                ]
            }, (req) => req.path === '/api/v3/workspaces/ws-123/docs');

            const docs = await adapter.listDocuments();
            
            assert.strictEqual(docs.length, 3, 'Should return 3 docs');
            assert.strictEqual(docs[0].id, 'doc-1');
            assert.strictEqual(docs[0].title, 'Design Doc');
            assert.strictEqual(docs[1].id, 'doc-2');
            assert.strictEqual(docs[1].title, 'Requirements');
            assert.strictEqual(docs[2].id, 'doc-3');
            assert.strictEqual(docs[2].title, 'Untitled', 'Should default to Untitled when no name/title');
        } finally {
            http.restore();
        }
    });
}

async function testClickUpDocsFetchContent404() {
    await withWorkspace('clickup-contract-fetch-404', async ({ workspaceRoot }) => {
        const installed = installVsCodeMock();
        const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService.js');
        const { ClickUpDocsAdapter } = loadOutModule('services/ClickUpDocsAdapter.js');
        installed.restore();

        const mockSecretStorage = new SecretStorageMock({
            'switchboard.clickup.apiToken': 'pk_test_token'
        });
        const clickUpService = new ClickUpSyncService(workspaceRoot, mockSecretStorage);
        const adapter = new ClickUpDocsAdapter(workspaceRoot, clickUpService);
        
        await clickUpService.saveConfig({
            workspaceId: 'ws-123',
            folderId: '',
            spaceId: '',
            columnMappings: {},
            customFields: { sessionId: '', planId: '', syncTimestamp: '' },
            setupComplete: true,
            lastSync: null,
            realTimeSyncEnabled: false,
            autoPullEnabled: false,
            pullIntervalMinutes: 60,
            automationRules: []
        });

        const http = installHttpsMock();

        try {
            // Mock 404 response for doc fetch
            http.queueJson(404, { error: 'Document not found' }, (req) => 
                req.path === '/api/v3/workspaces/ws-123/docs/doc-999'
            );

            const result = await adapter.fetchDocContent('doc-999');
            
            assert.strictEqual(result.success, false, 'Doc fetch should fail on 404');
            assert.ok(result.error?.includes('404'), 'Error should mention HTTP 404');
            assert.ok(result.error?.includes('ClickUp'), 'Error should mention ClickUp');
        } finally {
            http.restore();
        }
    });
}

async function testClickUpDocsFetchContentSuccess() {
    await withWorkspace('clickup-contract-fetch-success', async ({ workspaceRoot }) => {
        const installed = installVsCodeMock();
        const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService.js');
        const { ClickUpDocsAdapter } = loadOutModule('services/ClickUpDocsAdapter.js');
        installed.restore();

        const mockSecretStorage = new SecretStorageMock({
            'switchboard.clickup.apiToken': 'pk_test_token'
        });
        const clickUpService = new ClickUpSyncService(workspaceRoot, mockSecretStorage);
        const adapter = new ClickUpDocsAdapter(workspaceRoot, clickUpService);
        
        await clickUpService.saveConfig({
            workspaceId: 'ws-123',
            folderId: '',
            spaceId: '',
            columnMappings: {},
            customFields: { sessionId: '', planId: '', syncTimestamp: '' },
            setupComplete: true,
            lastSync: null,
            realTimeSyncEnabled: false,
            autoPullEnabled: false,
            pullIntervalMinutes: 60,
            automationRules: []
        });

        const http = installHttpsMock();

        try {
            // Mock doc metadata response
            http.queueJson(200, {
                doc: {
                    id: 'doc-1',
                    name: 'Test Document',
                    url: 'https://clickup.com/doc-1'
                }
            }, (req) => req.path === '/api/v3/workspaces/ws-123/docs/doc-1');

            // Mock page listing response
            http.queueJson(200, {
                pages: [
                    {
                        id: 'page-1',
                        name: 'Introduction',
                        content: '# Introduction\n\nThis is the intro.'
                    },
                    {
                        id: 'page-2',
                        name: 'Methods',
                        content: '# Methods\n\nMethodology here.'
                    }
                ]
            }, (req) => req.path.includes('/docs/doc-1/pages'));

            const result = await adapter.fetchDocContent('doc-1');
            
            assert.strictEqual(result.success, true, 'Doc fetch should succeed');
            assert.strictEqual(result.docTitle, 'Test Document');
            assert.ok(result.content?.includes('# Test Document'), 'Should include doc title as header');
            assert.ok(result.content?.includes('# Introduction'), 'Should include first page');
            assert.ok(result.content?.includes('# Methods'), 'Should include second page');
            assert.ok(result.content?.includes('ClickUp Docs'), 'Should include source attribution');
        } finally {
            http.restore();
        }
    });
}

// ── LocalFolderService Contract Tests ───────────────────────────────

async function testLocalFolderListFiles() {
    await withWorkspace('local-contract-list', async ({ workspaceRoot }) => {
        // Mock VS Code with workspace configuration support
        const Module = require('module');
        const originalLoad = Module._load;
        const mockConfig = new Map();
        mockConfig.set('switchboard.research.localFolderPath', 'test-research');

        const vscodeMock = {
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, defaultValue) => mockConfig.get(`${section}.${key}`) ?? defaultValue,
                    update: async (key, value, target) => {
                        mockConfig.set(`${section}.${key}`, value);
                    }
                })
            }
        };

        Module._load = function patchedLoad(request, parent, isMain) {
            if (request === 'vscode') {
                return vscodeMock;
            }
            return originalLoad.call(this, request, parent, isMain);
        };

        try {
            const { LocalFolderService } = loadOutModule('services/LocalFolderService.js');
            const service = new LocalFolderService(workspaceRoot);

            // Create test folder structure
            const testFolder = path.join(workspaceRoot, 'test-research');
            await fs.promises.mkdir(testFolder, { recursive: true });
            await fs.promises.mkdir(path.join(testFolder, 'subfolder'), { recursive: true });
            
            await fs.promises.writeFile(path.join(testFolder, 'doc1.md'), '# Doc 1');
            await fs.promises.writeFile(path.join(testFolder, 'doc2.txt'), 'Doc 2');
            await fs.promises.writeFile(path.join(testFolder, 'subfolder', 'doc3.md'), '# Doc 3');
            await fs.promises.writeFile(path.join(testFolder, '.hidden.md'), '# Hidden');
            await fs.promises.writeFile(path.join(testFolder, 'image.png'), 'fake image');

            const files = await service.listFiles();
            
            assert.strictEqual(files.length, 3, 'Should return 3 files (excluding hidden and non-text)');
            assert.ok(files.some(f => f.name === 'doc1.md'), 'Should include doc1.md');
            assert.ok(files.some(f => f.name === 'doc2.txt'), 'Should include doc2.txt');
            assert.ok(files.some(f => f.name === 'doc3.md'), 'Should include subfolder/doc3.md');
            assert.ok(!files.some(f => f.name === '.hidden.md'), 'Should exclude hidden files');
            assert.ok(!files.some(f => f.name === 'image.png'), 'Should exclude non-text files');
        } finally {
            Module._load = originalLoad;
            // Cleanup
            const testFolder = path.join(workspaceRoot, 'test-research');
            await fs.promises.rm(testFolder, { recursive: true, force: true });
        }
    });
}

async function testLocalFolderFetchContentSuccess() {
    await withWorkspace('local-contract-fetch', async ({ workspaceRoot }) => {
        // Mock VS Code with workspace configuration support
        const Module = require('module');
        const originalLoad = Module._load;
        const mockConfig = new Map();
        mockConfig.set('switchboard.research.localFolderPath', 'test-research');

        const vscodeMock = {
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, defaultValue) => mockConfig.get(`${section}.${key}`) ?? defaultValue,
                    update: async (key, value, target) => {
                        mockConfig.set(`${section}.${key}`, value);
                    }
                })
            }
        };

        Module._load = function patchedLoad(request, parent, isMain) {
            if (request === 'vscode') {
                return vscodeMock;
            }
            return originalLoad.call(this, request, parent, isMain);
        };

        try {
            const { LocalFolderService } = loadOutModule('services/LocalFolderService.js');
            const service = new LocalFolderService(workspaceRoot);

            // Create test file
            const testFolder = path.join(workspaceRoot, 'test-research');
            await fs.promises.mkdir(testFolder, { recursive: true });
            const testFile = path.join(testFolder, 'test.md');
            const testContent = '# Test Document\n\nThis is test content.';
            await fs.promises.writeFile(testFile, testContent);

            const result = await service.fetchDocContent('test.md');
            
            assert.strictEqual(result.success, true, 'Fetch should succeed');
            assert.strictEqual(result.docTitle, 'test', 'Should extract title from filename');
            assert.strictEqual(result.content, testContent, 'Should return file content');
            
            // Verify config was saved
            const config = await service.loadConfig();
            assert.strictEqual(config?.selectedFile, 'test.md');
            assert.strictEqual(config?.docTitle, 'test');
            assert.strictEqual(config?.setupComplete, true);
        } finally {
            Module._load = originalLoad;
            await fs.promises.rm(path.join(workspaceRoot, 'test-research'), { recursive: true, force: true });
        }
    });
}

async function testLocalFolderPathTraversalProtection() {
    await withWorkspace('local-contract-traversal', async ({ workspaceRoot }) => {
        // Mock VS Code with workspace configuration support
        const Module = require('module');
        const originalLoad = Module._load;
        const mockConfig = new Map();
        mockConfig.set('switchboard.research.localFolderPath', 'test-research');

        const vscodeMock = {
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, defaultValue) => mockConfig.get(`${section}.${key}`) ?? defaultValue,
                    update: async (key, value, target) => {
                        mockConfig.set(`${section}.${key}`, value);
                    }
                })
            }
        };

        Module._load = function patchedLoad(request, parent, isMain) {
            if (request === 'vscode') {
                return vscodeMock;
            }
            return originalLoad.call(this, request, parent, isMain);
        };

        try {
            const { LocalFolderService } = loadOutModule('services/LocalFolderService.js');
            const service = new LocalFolderService(workspaceRoot);

            // Create test folder with a legitimate file inside it.
            const testFolder = path.join(workspaceRoot, 'test-research');
            await fs.promises.mkdir(testFolder, { recursive: true });
            await fs.promises.writeFile(path.join(testFolder, 'safe.md'), '# Safe');

            // Plant a "sensitive" readable file OUTSIDE the configured folder so that
            // removal of the guard would successfully exfiltrate data.
            const sensitiveContent = 'TOP_SECRET_ETC_PASSWD_SUBSTITUTE';
            const sensiblePath = path.join(workspaceRoot, 'outside-secret.md');
            await fs.promises.writeFile(sensiblePath, sensitiveContent);

            // Traversal that resolves to the planted outside file.
            const result = await service.fetchDocContent('../outside-secret.md');

            assert.strictEqual(result.success, false, 'Path traversal should be blocked');
            assert.ok(
                result.error?.includes('Invalid'),
                `Error should mention invalid path (got: ${result.error})`
            );
            // Defence-in-depth: if the guard were silently bypassed, success might still
            // be false (e.g. ENOENT), but the secret content would leak via result.content.
            assert.ok(
                !result.content || !result.content.includes(sensitiveContent),
                'Traversal must not return content from outside the configured folder'
            );

            // Also attempt a deeper traversal pattern to exercise the check.
            const deeperResult = await service.fetchDocContent('../../../../etc/passwd');
            assert.strictEqual(deeperResult.success, false, 'Deep traversal should be blocked');
            assert.ok(
                deeperResult.error?.includes('Invalid'),
                `Deep traversal error should mention invalid path (got: ${deeperResult.error})`
            );
        } finally {
            Module._load = originalLoad;
            await fs.promises.rm(path.join(workspaceRoot, 'test-research'), { recursive: true, force: true });
            await fs.promises.rm(path.join(workspaceRoot, 'outside-secret.md'), { force: true });
        }
    });
}

async function testLocalFolderNotConfigured() {
    await withWorkspace('local-contract-unconfigured', async ({ workspaceRoot }) => {
        // Mock VS Code with workspace configuration support
        const Module = require('module');
        const originalLoad = Module._load;
        const mockConfig = new Map();

        const vscodeMock = {
            workspace: {
                getConfiguration: (section) => ({
                    get: (key, defaultValue) => mockConfig.get(`${section}.${key}`) ?? defaultValue,
                    update: async (key, value, target) => {
                        mockConfig.set(`${section}.${key}`, value);
                    }
                })
            }
        };

        Module._load = function patchedLoad(request, parent, isMain) {
            if (request === 'vscode') {
                return vscodeMock;
            }
            return originalLoad.call(this, request, parent, isMain);
        };

        try {
            const { LocalFolderService } = loadOutModule('services/LocalFolderService.js');
            const service = new LocalFolderService(workspaceRoot);

            const result = await service.fetchDocContent('test.md');
            
            assert.strictEqual(result.success, false, 'Fetch should fail when folder not configured');
            assert.ok(result.error?.includes('not configured'), 'Error should mention configuration');
        } finally {
            Module._load = originalLoad;
        }
    });
}

// ── Test Runner ─────────────────────────────────────────────────────

async function run() {
    console.log('Running Planning Modal Contract Tests...');
    
    // NotionBrowseService tests
    await testNotion404PermissionError();
    console.log('  ✓ Notion 404 permission error handling');
    
    await testNotionDatabase404PermissionError();
    console.log('  ✓ Notion database 404 permission error handling');
    
    await testNotionSuccessfulSearchResponseParsing();
    console.log('  ✓ Notion successful search response parsing');
    
    // ClickUpDocsAdapter tests
    await testClickUpDocsListDocuments();
    console.log('  ✓ ClickUp docs list documents');
    
    await testClickUpDocsFetchContent404();
    console.log('  ✓ ClickUp docs fetch content 404 handling');
    
    await testClickUpDocsFetchContentSuccess();
    console.log('  ✓ ClickUp docs fetch content success');
    
    // LocalFolderService tests
    await testLocalFolderListFiles();
    console.log('  ✓ Local folder list files');
    
    await testLocalFolderFetchContentSuccess();
    console.log('  ✓ Local folder fetch content success');
    
    await testLocalFolderPathTraversalProtection();
    console.log('  ✓ Local folder path traversal protection');
    
    await testLocalFolderNotConfigured();
    console.log('  ✓ Local folder not configured error');
    
    console.log('\nPlanning Modal Contract Tests Passed!');
}

run().catch((error) => {
    console.error('Planning Modal Contract Tests Failed:', error);
    process.exit(1);
});
