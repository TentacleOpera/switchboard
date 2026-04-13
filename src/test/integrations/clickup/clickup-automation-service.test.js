'use strict';

const assert = require('assert');
const path = require('path');
const {
    withWorkspace,
    loadOutModule,
    readText
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot, secretSeed = {}) {
    const installed = installVsCodeMock();
    const { KanbanDatabase } = loadOutModule('services/KanbanDatabase.js');
    const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService.js');
    const { ClickUpAutomationService } = loadOutModule('services/ClickUpAutomationService.js');
    const { importPlanFiles } = loadOutModule('services/PlanFileImporter.js');
    installed.restore();

    const service = new ClickUpSyncService(workspaceRoot, new SecretStorageMock(secretSeed));
    const automation = new ClickUpAutomationService(
        workspaceRoot,
        service,
        async () => path.join(workspaceRoot, '.switchboard', 'plans')
    );
    return { service, automation, KanbanDatabase, importPlanFiles };
}

function createRule(name, targetColumn, finalColumn, writeBackOnComplete = true, options = {}) {
    const triggerLists = Array.isArray(options.triggerLists) ? options.triggerLists : ['list-created'];
    return {
        name,
        triggerTag: options.triggerTag || 'bug',
        triggerLists,
        targetColumn,
        finalColumn,
        writeBackOnComplete,
        enabled: true
    };
}

async function testMixedScopedAndUnscopedRulePolling() {
    await withWorkspace('clickup-automation-unscoped', async ({ workspaceRoot }) => {
        const { service, automation } = createContext(workspaceRoot, {
            'switchboard.clickup.apiToken': 'pk_automation_token'
        });
        service.delay = async () => {};

        const createdOnlyRule = createRule('Created Bug', 'CREATED', 'COMPLETED', true, {
            triggerLists: ['list-created']
        });
        const anyListBugRule = createRule('Any Bug', 'BACKLOG', 'COMPLETED', true, {
            triggerLists: []
        });

        await service.saveConfig({
            workspaceId: 'team-1',
            folderId: 'folder-1',
            spaceId: 'space-1',
            columnMappings: {
                CREATED: 'list-created',
                BACKLOG: 'list-backlog',
                COMPLETED: 'list-completed'
            },
            customFields: { sessionId: '', planId: '', syncTimestamp: '' },
            setupComplete: true,
            lastSync: null,
            autoPullEnabled: false,
            pullIntervalMinutes: 60,
            automationRules: [createdOnlyRule, anyListBugRule]
        });

        const http = installHttpsMock();
        try {
            http.queueJson(200, {
                lists: [
                    { id: 'list-created', name: 'CREATED' },
                    { id: 'list-backlog', name: 'BACKLOG' },
                    { id: 'list-completed', name: 'COMPLETED' }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/folder/folder-1/list?archived=false');
            http.queueJson(200, {
                tasks: []
            }, (req) => req.method === 'GET' && req.path === '/api/v2/list/list-created/task?page=0&subtasks=true&include_closed=false');
            http.queueJson(200, {
                tasks: [
                    {
                        id: 'task-backlog-bug',
                        name: 'Investigate backlog bug',
                        description: 'Backlog issue.',
                        url: 'https://clickup.local/task-backlog-bug',
                        status: { status: 'open' },
                        tags: [{ name: 'bug' }]
                    }
                ]
            }, (req) => req.method === 'GET' && req.path === '/api/v2/list/list-backlog/task?page=0&subtasks=true&include_closed=false');
            http.queueJson(200, {
                tasks: []
            }, (req) => req.method === 'GET' && req.path === '/api/v2/list/list-completed/task?page=0&subtasks=true&include_closed=false');

            const pollResult = await automation.poll();
            assert.strictEqual(
                pollResult.created,
                1,
                'Expected the unscoped rule to create a plan from a mapped backlog list task.'
            );
            assert.strictEqual(pollResult.errors.length, 0);
            assert.ok(
                http.requests.some((req) => req.method === 'GET' && req.path === '/api/v2/list/list-backlog/task?page=0&subtasks=true&include_closed=false'),
                'Expected automation polling to include mapped backlog lists when any enabled rule is unscoped.'
            );
        } finally {
            http.restore();
        }
    });
}

async function run() {
    await testMixedScopedAndUnscopedRulePolling();
    await withWorkspace('clickup-automation', async ({ workspaceRoot }) => {
        const { service, automation, KanbanDatabase, importPlanFiles } = createContext(workspaceRoot, {
            'switchboard.clickup.apiToken': 'pk_automation_token'
        });
        service.delay = async () => {};

        const bugSummaryRule = createRule('Bug Summary', 'CREATED', 'COMPLETED', true);
        const bugFallbackRule = createRule('Bug Fallback', 'BACKLOG', 'CODED', true);

        await service.saveConfig({
            workspaceId: 'team-1',
            folderId: 'folder-1',
            spaceId: 'space-1',
            columnMappings: {
                CREATED: 'list-created',
                BACKLOG: 'list-backlog',
                COMPLETED: 'list-completed'
            },
            customFields: { sessionId: '', planId: '', syncTimestamp: '' },
            setupComplete: true,
            lastSync: null,
            autoPullEnabled: false,
            pullIntervalMinutes: 60,
            automationRules: [bugSummaryRule, bugFallbackRule]
        });

        const http = installHttpsMock();
        try {
            const queuePollingResponses = () => {
                http.queueJson(200, {
                    lists: [{ id: 'list-created', name: 'CREATED' }]
                }, (req) => req.method === 'GET' && req.path === '/api/v2/folder/folder-1/list?archived=false');
                http.queueJson(200, {
                    tasks: [
                        {
                            id: 'task-bug',
                            name: 'Investigate bug',
                            description: 'The app crashes on launch.',
                            url: 'https://clickup.local/task-bug',
                            status: { status: 'open' },
                            tags: [{ name: 'bug' }]
                        },
                        {
                            id: 'task-docs',
                            name: 'Update docs',
                            description: 'Refresh onboarding copy.',
                            status: { status: 'open' },
                            tags: [{ name: 'docs' }]
                        }
                    ]
                }, (req) => req.method === 'GET' && req.path === '/api/v2/list/list-created/task?page=0&subtasks=true&include_closed=false');
            };

            queuePollingResponses();
            const firstPoll = await automation.poll();
            assert.strictEqual(firstPoll.created, 1);
            assert.strictEqual(firstPoll.writeBacks, 0);
            assert.strictEqual(firstPoll.errors.length, 0);

            const importedCount = await importPlanFiles(workspaceRoot);
            assert.strictEqual(importedCount, 1, 'Expected the generated ClickUp automation plan file to import cleanly.');

            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            const workspaceId = await db.getWorkspaceId();
            assert.ok(workspaceId, 'Expected automation polling to initialize a workspace ID.');

            const visibleBoard = await db.getBoard(workspaceId);
            assert.strictEqual(visibleBoard.length, 1, 'Expected one visible automation-created plan.');

            const createdPlan = await db.findPlanByClickUpTaskId(workspaceId, 'task-bug');
            assert.ok(createdPlan, 'Expected the visible automation-created plan to be persisted.');
            assert.strictEqual(createdPlan.sourceType, 'clickup-automation');
            assert.ok(!Object.prototype.hasOwnProperty.call(createdPlan, 'isInternal'));
            assert.ok(!Object.prototype.hasOwnProperty.call(createdPlan, 'pipelineId'));
            assert.strictEqual(createdPlan.clickupTaskId, 'task-bug');
            assert.strictEqual(createdPlan.kanbanColumn, 'CREATED');

            const planContent = readText(createdPlan.planFile);
            assert.ok(planContent.includes('**ClickUp Task ID:** task-bug'));
            assert.ok(planContent.includes('**Automation Rule:** Bug Summary'));
            assert.ok(planContent.includes('**Kanban Column:** CREATED'));
            assert.ok(!planContent.includes('**Internal Plan:** true'));
            assert.ok(!planContent.includes('**Pipeline ID:**'));

            http.queueJson(200, { id: 'task-bug' }, (req) => req.method === 'PUT' && req.path === '/api/v2/task/task-bug');
            http.queueJson(200, { id: 'task-bug' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-backlog/task/task-bug');

            const syncResult = await service.syncPlan(Object.assign({}, createdPlan, {
                kanbanColumn: 'BACKLOG',
                updatedAt: new Date().toISOString()
            }));
            assert.deepStrictEqual(syncResult, { success: true, taskId: 'task-bug' });
            assert.strictEqual(
                http.requests.filter((req) => req.method === 'GET' && req.path.includes('/task?custom_fields=')).length,
                0,
                'Expected clickupTaskId to be used before any plan-id lookup.'
            );
            assert.strictEqual(
                http.requests.filter((req) => req.method === 'POST' && req.path === '/api/v2/list/list-backlog/task').length,
                0,
                'Expected sync-on-move to update the originating ClickUp task instead of creating a duplicate.'
            );

            await db.updateColumn(createdPlan.sessionId, 'COMPLETED');

            queuePollingResponses();
            const requestCountBeforeWriteBack = http.requests.length;
            http.queueJson(200, {
                id: 'task-bug',
                description: 'Existing task body'
            }, (req) => req.method === 'GET' && req.path === '/api/v2/task/task-bug');
            http.queueJson(200, {
                id: 'task-bug'
            }, (req) => req.method === 'PUT' && req.path === '/api/v2/task/task-bug');

            const secondPoll = await automation.poll();
            assert.strictEqual(secondPoll.created, 0);
            assert.strictEqual(secondPoll.writeBacks, 1);
            assert.strictEqual(secondPoll.errors.length, 0);

            const writeBackRequests = http.requests.slice(requestCountBeforeWriteBack);
            const updateRequest = writeBackRequests.find((req) => req.method === 'PUT' && req.path === '/api/v2/task/task-bug');
            assert.ok(updateRequest, 'Expected ClickUp automation write-back to update the originating task.');
            assert.strictEqual(
                writeBackRequests.filter((req) => req.method === 'POST' && req.path === '/api/v2/task/task-bug/comment').length,
                0,
                'Expected simplified automation write-back to reuse the default description update path.'
            );
            assert.match(updateRequest.jsonBody.description, /Switchboard Automation Result/);
            assert.match(updateRequest.jsonBody.description, /Automation Rule:\*\* Bug Summary/);
            assert.match(updateRequest.jsonBody.description, /Investigate bug/);
            assert.doesNotMatch(updateRequest.jsonBody.description, /Pipeline:/);

            const updatedPlan = await db.getPlanBySessionId(createdPlan.sessionId);
            assert.strictEqual(updatedPlan.lastAction, 'clickup_writeback_complete');

            queuePollingResponses();
            const requestCountBeforeThirdPoll = http.requests.length;
            const thirdPoll = await automation.poll();
            assert.strictEqual(thirdPoll.created, 0);
            assert.strictEqual(thirdPoll.writeBacks, 0);
            assert.strictEqual(thirdPoll.errors.length, 0);
            assert.strictEqual(
                http.requests.slice(requestCountBeforeThirdPoll).filter((req) => req.method === 'PUT' && req.path === '/api/v2/task/task-bug').length,
                0,
                'Expected write-back to be idempotent once the completion marker is set.'
            );
        } finally {
            http.restore();
        }
    });

    console.log('clickup automation service test passed');
}

run().catch((error) => {
    console.error('clickup automation service test failed:', error);
    process.exit(1);
});
