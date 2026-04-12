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
        autoPullEnabled: false,
        pullIntervalMinutes: 60
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
        assert.strictEqual(normalized.autoPullEnabled, true);
        assert.strictEqual(Object.keys(normalized.columnMappings).length, CANONICAL_COLUMNS.length);

        const http = installHttpsMock();
        try {
            vscodeState.inputBoxResponses.push('pk_live_clickup_token');
            vscodeState.quickPickResponses.push('Engineering');

            http.queueJson(200, { teams: [{ id: 'team-1' }] }, (req) => req.path === '/api/v2/team');
            http.queueJson(200, { spaces: [{ id: 'space-1', name: 'Engineering' }] }, (req) => req.path === '/api/v2/team/team-1/space?archived=false');
            http.queueJson(200, { folders: [] }, (req) => req.path === '/api/v2/space/space-1/folder?archived=false');
            http.queueJson(200, { id: 'folder-1' }, (req) => req.method === 'POST' && req.path === '/api/v2/space/space-1/folder');
            for (const column of CANONICAL_COLUMNS) {
                http.queueResponse((req) => ({
                    statusCode: 200,
                    json: { id: `list-${column.toLowerCase().replace(/[^a-z0-9]+/g, '-')}` }
                }), (req) => req.method === 'POST' && req.path === '/api/v2/folder/folder-1/list');
            }
            http.queueJson(200, { id: 'field-session' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/field');
            http.queueJson(200, { id: 'field-plan' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/field');
            http.queueJson(200, { id: 'field-time' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-created/field');

            const result = await service.setup();
            assert.deepStrictEqual(result, { success: true });
            assert.strictEqual(await secretStorage.get('switchboard.clickup.apiToken'), 'pk_live_clickup_token');

            const saved = readJson(service.configPath);
            assert.strictEqual(saved.folderId, 'folder-1');
            assert.strictEqual(saved.columnMappings.CREATED, 'list-created');
            assert.strictEqual(saved.customFields.planId, 'field-plan');
            assert.strictEqual(vscodeState.inputBoxCalls[0].password, true);
            assert.strictEqual(vscodeState.quickPickCalls[0].options.placeHolder, 'Select a ClickUp space for the AI Agents folder');
        } finally {
            http.restore();
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
            assert.ok(createRequest.jsonBody.description.includes('[Switchboard] Session: session-created | Plan: plan-created'));
            assert.strictEqual(createRequest.jsonBody.custom_fields.length, 3);

            http.queueJson(200, { tasks: [{ id: 'task-existing' }] }, (req) => req.method === 'GET' && req.path.includes('/task?custom_fields='));
            http.queueJson(200, { id: 'task-existing' }, (req) => req.method === 'PUT' && req.path === '/api/v2/task/task-existing');
            http.queueJson(200, { id: 'task-existing' }, (req) => req.method === 'POST' && req.path === '/api/v2/list/list-backlog/task/task-existing');

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
            assert.strictEqual(updateRequest.jsonBody.custom_fields.length, 1);
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
        assert.deepStrictEqual(unmapped, { success: true });

        service.isSyncInProgress = true;
        const guarded = await service.syncPlan(createPlanRecord());
        assert.strictEqual(guarded.success, false);
        assert.match(guarded.error, /loop guard/);
    });
}

async function run() {
    await testConfigNormalizationAndSetupFlow();
    await testSyncPlanCreateAndUpdateFlows();
    await testLoopGuardAndUnmappedColumns();
    console.log('clickup sync service test passed');
}

run().catch((error) => {
    console.error('clickup sync service test failed:', error);
    process.exit(1);
});
