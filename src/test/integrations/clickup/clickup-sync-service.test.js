'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const {
    withWorkspace,
    writeJson,
    writeText,
    readJson,
    loadOutModule,
    createPlanRecord
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot, secretSeed = {}) {
    const installed = installVsCodeMock();
    const { ClickUpSyncService, CANONICAL_COLUMNS } = loadOutModule('services/ClickUpSyncService.js');
    installed.restore();
    const secretStorage = new SecretStorageMock(secretSeed);
    return {
        service: new ClickUpSyncService(workspaceRoot, secretStorage),
        secretStorage,
        vscodeState: installed.state,
        CANONICAL_COLUMNS
    };
}

function buildConfig(columnMappings) {
    return {
        workspaceId: 'team-1',
        folderId: 'folder-1',
        spaceId: 'space-1',
        columnMappings,
        customFields: {
            sessionId: 'field-session',
            planId: 'field-plan',
            syncTimestamp: 'field-time'
        },
        setupComplete: true,
        lastSync: null,
        realTimeSyncEnabled: false,
        autoPullEnabled: false,
        pullIntervalMinutes: 60,
        automationRules: []
    };
}

function createClickUpTask(overrides = {}) {
    return {
        id: 'task-1',
        name: 'Analytics migration',
        description: 'Move analytics pipeline.',
        markdown_description: '## Analytics migration',
        text_content: 'Move analytics pipeline.',
        url: 'https://app.clickup.com/t/task-1',
        parent: null,
        archived: false,
        status: {
            status: 'in progress',
            color: '#123456',
            type: 'custom',
            orderindex: '1'
        },
        priority: {
            id: '2',
            priority: 'high',
            color: '#ff0000',
            orderindex: '2'
        },
        list: {
            id: 'list-sprint',
            name: 'Sprint 113'
        },
        creator: {
            id: 'user-1',
            username: 'patrick',
            email: 'patrick@example.com'
        },
        assignees: [],
        tags: [],
        date_created: '1710000000000',
        date_updated: '1710000001000',
        ...overrides
    };
}

async function testConfigNormalizationAndSetupFlow() {
    await withWorkspace('clickup-setup', async ({ workspaceRoot }) => {
        const { service, secretStorage, vscodeState, CANONICAL_COLUMNS } = createContext(workspaceRoot);
        await writeJson(service.configPath, {
            workspaceId: 'legacy-team',
            folderId: 'legacy-folder',
            spaceId: 'legacy-space',
            setupComplete: true,
            autoPullEnabled: true,
            pullIntervalMinutes: 999
        });

        const normalized = await service.loadConfig();
        assert.strictEqual(normalized.pullIntervalMinutes, 60);
        assert.strictEqual(normalized.realTimeSyncEnabled, true);
        assert.strictEqual(normalized.autoPullEnabled, true);
        assert.deepStrictEqual(normalized.columnMappings, {});
        await fs.promises.unlink(service.configPath);

        const http = installHttpsMock();
        try {
            vscodeState.inputBoxResponses.push('pk_live_clickup_token');
            vscodeState.quickPickResponses.push('Engineering');

            http.queueJson(200, { teams: [{ id: 'team-1' }] }, (req) => req.path === '/api/v2/team');
            http.queueJson(200, { spaces: [{ id: 'space-1', name: 'Engineering' }] }, (req) => req.path === '/api/v2/team/team-1/space?archived=false');
            http.queueJson(200, { folders: [] }, (req) => req.path === '/api/v2/space/space-1/folder?archived=false');
            http.queueJson(200, { id: 'folder-1' }, (req) => req.method === 'POST' && req.path === '/api/v2/space/space-1/folder');
            http.queueJson(200, { lists: [] }, (req) => req.method === 'GET' && req.path === '/api/v2/folder/folder-1/list?archived=false');
            http.queueResponse(() => ({
                statusCode: 200,
                json: { id: 'list-created' }
            }), (req) => req.method === 'POST' && req.path === '/api/v2/folder/folder-1/list');
            http.queueResponse(() => ({
                statusCode: 200,
                json: { id: 'list-custom-agent-column' }
            }), (req) => req.method === 'POST' && req.path === '/api/v2/folder/folder-1/list');
            http.queueJson(200, { id: 'field-session' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/field');
            http.queueJson(200, { id: 'field-plan' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/field');
            http.queueJson(200, { id: 'field-time' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/field');

            const result = await service.applyConfig({
                createFolder: true,
                createLists: true,
                createCustomFields: true,
                enableRealtimeSync: true,
                enableAutoPull: false,
                columns: ['CREATED', 'Custom Agent Column']
            });
            assert.deepStrictEqual(result, { success: true });
            assert.strictEqual(await secretStorage.get('switchboard.clickup.apiToken'), 'pk_live_clickup_token');

            const saved = readJson(service.configPath);
            assert.strictEqual(saved.folderId, 'folder-1');
            assert.strictEqual(saved.columnMappings.CREATED, 'list-created');
            assert.strictEqual(saved.columnMappings['Custom Agent Column'], 'list-custom-agent-column');
            assert.strictEqual(saved.customFields.planId, 'field-plan');
            assert.strictEqual(saved.realTimeSyncEnabled, true);
            assert.strictEqual(saved.autoPullEnabled, false);
            assert.strictEqual(vscodeState.inputBoxCalls[0].password, true);
            assert.strictEqual(vscodeState.quickPickCalls[0].options.placeHolder, 'Select a ClickUp space for the AI Agents folder');

            http.queueJson(200, {
                lists: [
                    { id: 'list-created', name: 'CREATED' },
                    { id: 'list-custom-agent-column', name: 'Custom Agent Column' }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/folder/folder-1/list?archived=false');
            http.queueJson(200, { id: 'list-backlog' }, (req) => req.method === 'POST' && req.path === '/api/v2/folder/folder-1/list');
            http.queueJson(200, {
                lists: [
                    { id: 'list-created', name: 'CREATED' },
                    { id: 'list-custom-agent-column', name: 'Custom Agent Column' },
                    { id: 'list-backlog', name: 'BACKLOG' }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/folder/folder-1/list?archived=false');

            const mappingState = await service.saveColumnMappings([
                { columnId: 'CREATED', strategy: 'existing', listId: 'list-created' },
                { columnId: 'Custom Agent Column', strategy: 'exclude' },
                { columnId: 'BACKLOG', strategy: 'create' }
            ], ['CREATED', 'Custom Agent Column', 'BACKLOG']);

            assert.strictEqual(mappingState.mappedCount, 2);
            assert.strictEqual(mappingState.excludedCount, 1);
            assert.strictEqual(mappingState.unmappedCount, 0);

            const updatedConfig = readJson(service.configPath);
            assert.strictEqual(updatedConfig.columnMappings.BACKLOG, 'list-backlog');
            assert.strictEqual(updatedConfig.columnMappings['Custom Agent Column'], '');
        } finally {
            http.restore();
        }
    });
}

async function testApplyConfigOptionsAndValidation() {
    await withWorkspace('clickup-apply', async ({ workspaceRoot }) => {
        const { service, vscodeState, CANONICAL_COLUMNS } = createContext(workspaceRoot, {
            'switchboard.clickup.apiToken': 'pk_apply_token'
        });

        const http = installHttpsMock();
        try {
            vscodeState.quickPickResponses.push('Engineering');

            http.queueJson(200, { teams: [{ id: 'team-1' }] }, (req) => req.path === '/api/v2/team');
            http.queueJson(200, { spaces: [{ id: 'space-1', name: 'Engineering' }] }, (req) => req.path === '/api/v2/team/team-1/space?archived=false');
            http.queueJson(200, { folders: [] }, (req) => req.path === '/api/v2/space/space-1/folder?archived=false');
            http.queueJson(200, { id: 'folder-1' }, (req) => req.method === 'POST' && req.path === '/api/v2/space/space-1/folder');

            const folderOnly = await service.applyConfig({
                createFolder: true,
                createLists: false,
                createCustomFields: false,
                enableRealtimeSync: false,
                enableAutoPull: false,
                columns: ['CREATED']
            });
            assert.deepStrictEqual(folderOnly, { success: true });

            const folderOnlyConfig = readJson(service.configPath);
            assert.strictEqual(folderOnlyConfig.folderId, 'folder-1');
            assert.deepStrictEqual(folderOnlyConfig.columnMappings, {});
            assert.strictEqual(folderOnlyConfig.realTimeSyncEnabled, false);
            assert.strictEqual(folderOnlyConfig.autoPullEnabled, false);

            http.queueJson(200, { lists: [] }, (req) => req.method === 'GET' && req.path === '/api/v2/folder/folder-1/list?archived=false');
            const folderOnlyMappingState = await service.getColumnMappingState(['CREATED']);
            assert.strictEqual(folderOnlyMappingState.mappings[0].status, 'unmapped');
        } finally {
            http.restore();
        }

        await service.saveConfig(buildConfig(
            CANONICAL_COLUMNS.reduce((mappings, column) => ({
                ...mappings,
                [column]: column === 'CREATED' ? 'list-created' : ''
            }), {})
        ));

        const enabled = await service.applyConfig({
            createFolder: false,
            createLists: false,
            createCustomFields: false,
            enableRealtimeSync: true,
            enableAutoPull: true
        });
        assert.deepStrictEqual(enabled, { success: true });

        const enabledConfig = readJson(service.configPath);
        assert.strictEqual(enabledConfig.folderId, 'folder-1');
        assert.strictEqual(enabledConfig.columnMappings.CREATED, 'list-created');
        assert.strictEqual(enabledConfig.realTimeSyncEnabled, true);
        assert.strictEqual(enabledConfig.autoPullEnabled, true);

        await service.saveConfig(buildConfig(
            CANONICAL_COLUMNS.reduce((mappings, column) => ({
                ...mappings,
                [column]: ''
            }), {})
        ));
        const missingMappedList = await service.applyConfig({
            createFolder: false,
            createLists: false,
            createCustomFields: true,
            enableRealtimeSync: false,
            enableAutoPull: false
        });
        assert.strictEqual(missingMappedList.success, false);
        assert.match(missingMappedList.error, /mapped ClickUp list/i);

        await fs.promises.unlink(service.configPath);

        const realtimeHttp = installHttpsMock();
        try {
            vscodeState.quickPickResponses.push('Engineering');

            realtimeHttp.queueJson(200, { teams: [{ id: 'team-1' }] }, (req) => req.path === '/api/v2/team');
            realtimeHttp.queueJson(200, { spaces: [{ id: 'space-1', name: 'Engineering' }] }, (req) => req.path === '/api/v2/team/team-1/space?archived=false');
            realtimeHttp.queueJson(200, { folders: [] }, (req) => req.path === '/api/v2/space/space-1/folder?archived=false');

            const realtimeFailure = await service.applyConfig({
                createFolder: false,
                createLists: false,
                createCustomFields: false,
                enableRealtimeSync: true,
                enableAutoPull: false
            });
            assert.strictEqual(realtimeFailure.success, false);
            assert.match(realtimeFailure.error, /AI Agents folder|folder/i);
        } finally {
            realtimeHttp.restore();
        }
    });
}

async function testSyncPlanCreateAndUpdateFlows() {
    await withWorkspace('clickup-sync', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.clickup.apiToken': 'pk_sync_token'
        });

        const columnMappings = {
            CREATED: 'list-created',
            BACKLOG: 'list-backlog',
            'QA REVIEW': 'list-qa',
            'PLAN REVIEWED': '',
            'LEAD CODED': '',
            'CODER CODED': '',
            'CODE REVIEWED': '',
            CODED: '',
            COMPLETED: ''
        };
        await service.saveConfig(buildConfig(columnMappings));

        const planFile = path.join(workspaceRoot, 'plans', 'plan.md');
        await writeText(planFile, '# Example plan\n\nShip it.');

        const http = installHttpsMock();
        try {
            http.queueJson(200, { tasks: [] }, (req) => req.method === 'GET' && req.path.includes('/task?custom_fields='));
            http.queueJson(200, { id: 'task-created' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/task');

            const created = await service.syncPlan(createPlanRecord({
                planId: 'plan-created',
                sessionId: 'session-created',
                topic: 'Create task',
                planFile,
                complexity: '8',
                kanbanColumn: 'CREATED'
            }));
            assert.deepStrictEqual(created, { success: true, taskId: 'task-created' });

            const createRequest = http.requests.find((req) => req.path === '/api/v2/list/list-created/task');
            assert.strictEqual(createRequest.jsonBody.priority, 2);
            assert.ok(createRequest.jsonBody.tags.includes('switchboard:plan-created'));
            assert.ok(createRequest.jsonBody.description.includes('Ship it.'));
            assert.ok(createRequest.jsonBody.description.includes('[Switchboard] PlanFile:') && createRequest.jsonBody.description.includes('| Plan: plan-created'));
            assert.strictEqual(createRequest.jsonBody.custom_fields.length, 3);

            http.queueJson(200, { tasks: [{ id: 'task-existing' }] }, (req) => req.method === 'GET' && req.path.includes('/task?custom_fields='));
            http.queueJson(200, { id: 'task-existing', list: { id: 'list-created' } }, (req) => req.method === 'PUT' && req.path === '/api/v2/task/task-existing');
            http.queueJson(200, { id: 'task-existing', status: { status: 'open', id: 'status-open' }, locations: [{ id: 'list-created' }] }, (req) => req.method === 'GET' && req.path === '/api/v2/task/task-existing');
            http.queueJson(200, { id: 'list-backlog', statuses: [{ id: 'status-open', status: 'open' }] }, (req) => req.method === 'GET' && req.path === '/api/v2/list/list-backlog');
            http.queueJson(200, { success: true }, (req) => req.method === 'PUT' && req.path === '/api/v3/workspaces/team-1/tasks/task-existing/home_list/list-backlog');

            const updated = await service.syncPlan(createPlanRecord({
                planId: 'plan-updated',
                sessionId: 'session-updated',
                topic: 'Update task',
                planFile,
                kanbanColumn: 'BACKLOG'
            }));
            assert.deepStrictEqual(updated, { success: true, taskId: 'task-existing' });

            const updateRequest = http.requests.find((req) => req.method === 'PUT' && req.path === '/api/v2/task/task-existing');
            assert.strictEqual(updateRequest.jsonBody.name, 'Update task');
            assert.strictEqual(updateRequest.jsonBody.custom_fields.length, 3);

            const lookupCountBeforeLinked = http.requests.filter((req) => req.method === 'GET' && req.path.includes('/task?custom_fields=')).length;
            const createdTaskCountBeforeLinked = http.requests.filter((req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/task').length;
            http.queueJson(200, { id: 'task-linked', list: { id: 'list-created' } }, (req) => req.method === 'PUT' && req.path === '/api/v2/task/task-linked');

            const linked = await service.syncPlan(createPlanRecord({
                planId: 'plan-linked',
                sessionId: 'session-linked',
                topic: 'Linked task',
                planFile,
                kanbanColumn: 'CREATED',
                clickupTaskId: 'task-linked'
            }));
            assert.deepStrictEqual(linked, { success: true, taskId: 'task-linked' });
            assert.strictEqual(
                http.requests.filter((req) => req.method === 'GET' && req.path.includes('/task?custom_fields=')).length,
                lookupCountBeforeLinked,
                'Expected clickupTaskId to be used before falling back to a plan-id lookup.'
            );
            assert.strictEqual(
                http.requests.filter((req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/task').length,
                createdTaskCountBeforeLinked,
                'Expected linked plans to update the originating ClickUp task instead of creating a duplicate.'
            );

            http.queueJson(200, { tasks: [] }, (req) => req.method === 'GET' && req.path.includes('/task?custom_fields='));
            http.queueJson(200, { id: 'task-qa' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-qa/task');

            const customColumn = await service.syncPlan(createPlanRecord({
                planId: 'plan-qa',
                sessionId: 'session-qa',
                topic: 'Custom lane task',
                planFile,
                kanbanColumn: 'QA REVIEW'
            }));
            assert.deepStrictEqual(customColumn, { success: true, taskId: 'task-qa' });
        } finally {
            http.restore();
        }
    });
}

async function testLoopGuardAndUnmappedColumns() {
    await withWorkspace('clickup-guards', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.clickup.apiToken': 'pk_guard_token'
        });
        await service.saveConfig(buildConfig({
            CREATED: '',
            BACKLOG: '',
            'PLAN REVIEWED': '',
            'LEAD CODED': '',
            'CODER CODED': '',
            'CODE REVIEWED': '',
            CODED: '',
            COMPLETED: ''
        }));

        const unmapped = await service.syncPlan(createPlanRecord({
            kanbanColumn: 'CREATED'
        }));
        assert.strictEqual(unmapped.success, true);
        assert.strictEqual(unmapped.skippedReason, 'excluded-column');
        assert.match(unmapped.warning, /excluded/i);

        const missingMapping = await service.syncPlan(createPlanRecord({
            kanbanColumn: 'CUSTOM AGENT COLUMN'
        }));
        assert.strictEqual(missingMapping.success, true);
        assert.strictEqual(missingMapping.skippedReason, 'unmapped-column');
        assert.match(missingMapping.warning, /not mapped/i);

        service.isSyncInProgress = true;
        const guarded = await service.syncPlan(createPlanRecord());
        assert.strictEqual(guarded.success, false);
        assert.match(guarded.error, /loop guard/);
    });
}

async function testNativeTaskQueryAndMutationHelpers() {
    await withWorkspace('clickup-native-api', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.clickup.apiToken': 'pk_native_clickup'
        });
        await service.saveConfig(buildConfig({ CREATED: 'list-created' }));

        const http = installHttpsMock();
        try {
            http.queueJson(200, {
                spaces: [
                    { id: 'space-1', name: 'Engineering' }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/team/team-1/space?archived=false');
            http.queueJson(200, {
                lists: [
                    { id: 'list-created', name: 'Created List', archived: false, task_count: 2 }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/space/space-1/list?archived=false');
            http.queueJson(200, {
                folders: [
                    { id: 'folder-1', name: 'Sprint Folder' }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/space/space-1/folder?archived=false');
            http.queueJson(200, {
                lists: [
                    { id: 'list-sprint', name: 'Sprint 113', archived: false, task_count: 3 }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/folder/folder-1/list?archived=false');

            const matchingLists = await service.findList('sprint');
            assert.deepStrictEqual(matchingLists.map((list) => list.id), ['list-sprint']);
            assert.strictEqual(matchingLists[0].space?.id, 'space-1');
            assert.strictEqual(matchingLists[0].folder?.id, 'folder-1');

            http.queueJson(200, {
                tasks: [
                    createClickUpTask(),
                    createClickUpTask({ id: 'task-2', name: 'Docs cleanup' })
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/list/list-sprint/task?page=0&subtasks=true&include_closed=true&include_markdown_description=true');
            const matchingTasks = await service.findTask('list-sprint', 'analytics');
            assert.deepStrictEqual(matchingTasks.map((task) => task.id), ['task-1']);

            const allTasksPageOne = Array.from({ length: 100 }, (_, index) => createClickUpTask({
                id: `task-page1-${index}`,
                name: `Page one task ${index}`,
                list: { id: 'list-created', name: 'Created List' }
            }));
            const allTasksPageTwo = [
                createClickUpTask({
                    id: 'task-page2-0',
                    name: 'Page two task',
                    list: { id: 'list-created', name: 'Created List' }
                })
            ];
            http.queueJson(200, { tasks: allTasksPageOne }, (req) =>
                req.method === 'GET'
                && req.path === '/api/v2/team/team-1/task?subtasks=true&include_closed=true&include_markdown_description=true&page=0'
            );
            http.queueJson(200, { tasks: allTasksPageTwo }, (req) =>
                req.method === 'GET'
                && req.path === '/api/v2/team/team-1/task?subtasks=true&include_closed=true&include_markdown_description=true&page=1'
            );
            const allTasks = await service.searchTasks('');
            assert.strictEqual(allTasks.length, 101, 'Expected blank native ClickUp search to return all paginated team tasks.');

            http.queueJson(200, {
                tasks: [
                    createClickUpTask({
                        id: 'subtask-1',
                        name: 'Analytics migration / backfill',
                        parent: 'task-1'
                    })
                ]
            }, (req) =>
                req.method === 'GET'
                && req.path === '/api/v2/team/team-1/task?parent=task-1&subtasks=true&include_markdown_description=true'
            );
            const subtasks = await service.getSubtasks('task-1');
            assert.deepStrictEqual(subtasks.map((task) => task.id), ['subtask-1']);

            http.queueJson(201, { id: 'task-created' }, (req) =>
                req.method === 'POST'
                && req.path === '/api/v2/list/list-created/task'
                && req.jsonBody?.name === 'Created task'
            );
            http.queueJson(503, {}, (req) => req.method === 'GET' && req.path === '/api/v2/task/task-created');
            const createdTask = await service.createTask({
                listId: 'list-created',
                name: 'Created task',
                description: 'Created description',
                status: 'to do'
            });
            assert.ok(createdTask, 'Expected createTask to return a task even when the readback request fails.');
            assert.strictEqual(createdTask.id, 'task-created');
            assert.strictEqual(createdTask.name, 'Created task');
            assert.strictEqual(createdTask.description, 'Created description');

            http.queueJson(200, { id: 'task-created' }, (req) =>
                req.method === 'PUT'
                && req.path === '/api/v2/task/task-created'
                && req.jsonBody?.status === 'in progress'
            );
            await service.updateTask('task-created', { status: 'in progress' });

            http.queueJson(200, { id: 'comment-1' }, (req) =>
                req.method === 'POST'
                && req.path === '/api/v2/task/task-created/comment'
                && req.jsonBody?.comment_text === 'Looks good'
            );
            await service.addTaskComment('task-created', 'Looks good');

            // Test getCommentThreads and structured comment normalization
            http.queueJson(200, {
                comments: [
                    {
                        id: 'comment-struct-1',
                        comment_text: 'Hello John Doe',
                        comment: [
                            { text: 'Hello ' },
                            { type: 'tag', user: { id: '123', username: 'John Doe', email: 'john@example.com' } }
                        ],
                        user: { id: 'author-1', username: 'Author One', email: 'author@example.com' },
                        date: '1710000000000'
                    },
                    {
                        id: 'comment-plain-1',
                        comment_text: 'Looks good',
                        user: { id: 'author-2', username: 'Author Two', email: 'author2@example.com' },
                        date: '1710000001000'
                    },
                    {
                        id: 'comment-media-1',
                        comment_text: '',
                        comment: [
                            { text: 'Check this out' }
                        ],
                        user: { id: 'author-3', username: 'Author Three', email: 'author3@example.com' },
                        date: '1710000002000'
                    },
                    {
                        // 4. Structured comment with empty comment array:
                        //    comment_text is populated but the array is empty.
                        //    The decoder must fall back to comment_text, not blank.
                        id: 'comment-empty-array-1',
                        comment_text: 'Fallback text here',
                        comment: [],
                        user: { id: 'author-4', username: 'Author Four', email: 'author4@example.com' },
                        date: '1710000003000'
                    },
                    {
                        // 5. Emoji-only comment (single codepoint):
                        id: 'comment-emoji-1',
                        comment_text: '',
                        comment: [
                            { text: 'U0001F60A', type: 'emoticon', emoticon: { code: '1f60a' } }
                        ],
                        user: { id: 'author-5', username: 'Author Five', email: 'author5@example.com' },
                        date: '1710000004000'
                    },
                    {
                        // 6. Image attachment comment (defensive — undocumented shape):
                        id: 'comment-image-1',
                        comment_text: '',
                        comment: [
                            { type: 'image', url: 'https://example.com/screenshot.png', title: 'screenshot.png' }
                        ],
                        user: { id: 'author-6', username: 'Author Six', email: 'author6@example.com' },
                        date: '1710000005000'
                    },
                    {
                        // 7. Multi-codepoint emoji (ZWJ family sequence):
                        id: 'comment-emoji-multi-1',
                        comment_text: '',
                        comment: [
                            { type: 'emoticon', emoticon: { code: '1f468-200d-1f469-200d-1f467' } }
                        ],
                        user: { id: 'author-7', username: 'Author Seven', email: 'author7@example.com' },
                        date: '1710000006000'
                    },
                    {
                        // 8. Media-only comment with empty array + empty comment_text:
                        //    Should hit the [media comment] last-resort placeholder.
                        id: 'comment-media-empty-1',
                        comment_text: '',
                        comment: [],
                        user: { id: 'author-8', username: 'Author Eight', email: 'author8@example.com' },
                        date: '1710000007000'
                    }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/task/task-created/comment');

            const { threads } = await service.getCommentThreads('task-created');
            assert.strictEqual(threads.length, 8);
            
            // 1. Structured comment:
            assert.strictEqual(threads[0].id, 'comment-struct-1');
            assert.strictEqual(threads[0].body, 'Hello @John Doe');
            assert.strictEqual(threads[0].mentions.length, 1);
            assert.strictEqual(threads[0].mentions[0].id, '123');
            assert.strictEqual(threads[0].mentions[0].name, 'John Doe');
            assert.strictEqual(threads[0].author.name, 'Author One');

            // 2. Plain comment:
            assert.strictEqual(threads[1].id, 'comment-plain-1');
            assert.strictEqual(threads[1].body, 'Looks good');
            assert.strictEqual(threads[1].author.name, 'Author Two');

            // 3. Structured comment with empty comment_text:
            assert.strictEqual(threads[2].id, 'comment-media-1');
            assert.strictEqual(threads[2].body, 'Check this out');
            assert.strictEqual(threads[2].author.name, 'Author Three');

            // 4. Structured comment with empty comment array (fallback to comment_text):
            assert.strictEqual(threads[3].id, 'comment-empty-array-1');
            assert.strictEqual(threads[3].body, 'Fallback text here');
            assert.strictEqual(threads[3].author.name, 'Author Four');

            // 5. Emoji-only comment (single codepoint):
            assert.strictEqual(threads[4].id, 'comment-emoji-1');
            assert.strictEqual(threads[4].body, '😊');  // U+1F60A = 😊
            assert.strictEqual(threads[4].bodyParts[0].type, 'emoji');
            assert.strictEqual(threads[4].bodyParts[0].text, '😊');

            // 6. Image attachment comment:
            assert.strictEqual(threads[5].id, 'comment-image-1');
            assert.strictEqual(threads[5].body, '[screenshot.png]');
            assert.strictEqual(threads[5].bodyParts[0].type, 'image');
            assert.strictEqual(threads[5].bodyParts[0].url, 'https://example.com/screenshot.png');
            assert.strictEqual(threads[5].bodyParts[0].alt, 'screenshot.png');

            // 7. Multi-codepoint emoji (ZWJ family: U+1F468 U+200D U+1F469 U+200D U+1F467 = 👨‍👩‍👧):
            assert.strictEqual(threads[6].id, 'comment-emoji-multi-1');
            assert.strictEqual(threads[6].body, '👨‍👩‍👧');
            assert.strictEqual(threads[6].bodyParts[0].type, 'emoji');
            assert.strictEqual(threads[6].bodyParts[0].text, '👨‍👩‍👧');

            // 8. Media-only comment with empty array + empty comment_text:
            assert.strictEqual(threads[7].id, 'comment-media-empty-1');
            assert.strictEqual(threads[7].body, '[media comment]');
            assert.strictEqual(threads[7].bodyParts[0].type, 'text');
            assert.strictEqual(threads[7].bodyParts[0].text, '[media comment]');
        } finally {
            http.restore();
        }
    });
}

async function testSyncBailsSilentlyWithoutToken() {
    await withWorkspace('clickup-no-token', async ({ workspaceRoot }) => {
        // No token seeded — simulates token lost from keychain while config
        // still says setupComplete: true + realTimeSyncEnabled: true.
        const { service, secretStorage } = createContext(workspaceRoot, {});
        await service.saveConfig(buildConfig({
            CREATED: 'list-created',
            BACKLOG: 'list-backlog',
            'PLAN REVIEWED': '',
            'LEAD CODED': '',
            'CODER CODED': '',
            'CODE REVIEWED': '',
            CODED: '',
            COMPLETED: ''
        }));

        const http = installHttpsMock();
        try {
            // syncPlan must bail with { success: false } — no throw, no network call.
            const requestCountBefore = http.requests.length;
            const result = await service.syncPlan(createPlanRecord({
                planId: 'plan-no-token',
                sessionId: 'session-no-token',
                topic: 'No token',
                kanbanColumn: 'CREATED'
            }));
            assert.strictEqual(result.success, false);
            assert.ok(/token not configured/i.test(result.error || ''), `Expected token-not-configured error, got: ${result.error}`);
            assert.strictEqual(http.requests.length, requestCountBefore, 'syncPlan with no token must not make any network call');

            // syncPlanContent must return { success: false } without calling httpRequest.
            const contentResult = await service.syncPlanContent('task-1', '# Plan\n\n## Goal\n- x\n');
            assert.strictEqual(contentResult.success, false);
            assert.ok(/token not configured/i.test(contentResult.error || ''), `Expected token-not-configured error, got: ${contentResult.error}`);
            assert.strictEqual(http.requests.length, requestCountBefore, 'syncPlanContent with no token must not make any network call');

            // hasApiToken() must report false and be cached.
            assert.strictEqual(await service.hasApiToken(), false);

            // completeSetup-style invalidation: storing a token then clearing the cache
            // must flip hasApiToken() to true.
            await secretStorage.store('switchboard.clickup.apiToken', 'pk_token');
            service.clearApiTokenCache();
            assert.strictEqual(await service.hasApiToken(), true);
        } finally {
            http.restore();
        }
    });
}

async function run() {
    await testConfigNormalizationAndSetupFlow();
    await testApplyConfigOptionsAndValidation();
    await testSyncPlanCreateAndUpdateFlows();
    await testLoopGuardAndUnmappedColumns();
    await testSyncBailsSilentlyWithoutToken();
    await testNativeTaskQueryAndMutationHelpers();
    console.log('clickup sync service test passed');
}

run().catch((error) => {
    console.error('clickup sync service test failed:', error);
    process.exit(1);
});
