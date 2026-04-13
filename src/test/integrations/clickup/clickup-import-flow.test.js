'use strict';

const assert = require('assert');
const path = require('path');
const {
    withWorkspace,
    readText,
    loadFixtureJson,
    loadOutModule
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot, secretSeed = {}) {
    const installed = installVsCodeMock();
    const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService.js');
    installed.restore();
    return {
        service: new ClickUpSyncService(workspaceRoot, new SecretStorageMock(secretSeed))
    };
}

async function run() {
    await withWorkspace('clickup-import', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.clickup.apiToken': 'pk_import_token'
        });
        await service.saveConfig({
            workspaceId: 'team-1',
            folderId: 'folder-1',
            spaceId: 'space-1',
            columnMappings: {
                CREATED: 'list-created',
                BACKLOG: 'list-backlog',
                'PLAN REVIEWED': '',
                'LEAD CODED': '',
                'CODER CODED': '',
                'CODE REVIEWED': '',
                CODED: '',
                COMPLETED: ''
            },
            customFields: { sessionId: '', planId: '', syncTimestamp: '' },
            setupComplete: true,
            lastSync: null,
            autoPullEnabled: false,
            pullIntervalMinutes: 60
        });

        const sampleParent = loadFixtureJson('clickup', 'task-sample.json');
        const sampleChild = {
            ...sampleParent,
            id: 'task-child',
            name: 'Child Task',
            parent: 'task-parent',
            tags: [{ name: 'docs' }],
            checklists: [],
            custom_fields: []
        };
        const backlogTask = {
            ...sampleParent,
            id: 'task-backlog',
            name: 'Backlog Task',
            status: { status: 'backlog' },
            tags: []
        };
        const filler = Array.from({ length: 98 }, (_, index) => ({
            id: `skip-${index}`,
            name: `Owned task ${index}`,
            status: { status: 'open' },
            tags: [{ name: `switchboard:skip-${index}` }]
        }));

        const http = installHttpsMock();
        try {
            service.delay = async () => {};
            http.queueJson(200, { tasks: [sampleParent, sampleChild, ...filler] }, (req) => req.path === '/api/v2/list/list-created/task?page=0&subtasks=true&include_closed=false');
            http.queueJson(200, { tasks: [backlogTask] }, (req) => req.path === '/api/v2/list/list-created/task?page=1&subtasks=true&include_closed=false');

            const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
            const result = await service.importTasksFromClickUp('list-created', plansDir);

            assert.deepStrictEqual(result, { success: true, imported: 3, skipped: 98 });

            const parentContent = readText(path.join(plansDir, 'clickup_import_task-parent.md'));
            const childContent = readText(path.join(plansDir, 'clickup_import_task-child.md'));
            const backlogContent = readText(path.join(plansDir, 'clickup_import_task-backlog.md'));

            assert.ok(parentContent.includes('## ClickUp Ticket Notes'));
            assert.ok(parentContent.includes('**ClickUp Task ID:** task-parent'));
            assert.ok(parentContent.includes('**Subtasks (each imported as a separate plan):**'));
            assert.ok(parentContent.includes('clickup_import_task-child.md'));
            assert.ok(parentContent.includes('**Custom Fields:**'));
            assert.ok(parentContent.includes('**Kanban Column:** CREATED'));

            assert.ok(childContent.includes('> **Parent Task:** Parent Task'));
            assert.ok(childContent.includes('## Goal'));
            assert.ok(backlogContent.includes('**Kanban Column:** BACKLOG'));
        } finally {
            http.restore();
        }
    });

    console.log('clickup import flow test passed');
}

run().catch((error) => {
    console.error('clickup import flow test failed:', error);
    process.exit(1);
});
