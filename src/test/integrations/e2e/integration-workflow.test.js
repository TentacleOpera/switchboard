'use strict';

const assert = require('assert');
const path = require('path');
const {
    withWorkspace,
    writeText,
    readText,
    loadOutModule
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot) {
    const installed = installVsCodeMock();
    const { NotionFetchService } = loadOutModule('services/NotionFetchService.js');
    const { ClickUpSyncService } = loadOutModule('services/ClickUpSyncService.js');
    const { LinearSyncService } = loadOutModule('services/LinearSyncService.js', ['services/ClickUpSyncService.js']);
    installed.restore();

    return {
        vscodeState: installed.state,
        notion: new NotionFetchService(workspaceRoot, new SecretStorageMock({
            'switchboard.notion.apiToken': 'secret_notion_token'
        })),
        clickup: new ClickUpSyncService(workspaceRoot, new SecretStorageMock({
            'switchboard.clickup.apiToken': 'pk_clickup_token'
        })),
        linear: new LinearSyncService(workspaceRoot, new SecretStorageMock({
            'switchboard.linear.apiToken': 'lin_api_token'
        }))
    };
}

async function run() {
    await withWorkspace('integration-e2e', async ({ workspaceRoot }) => {
        const { notion, clickup, linear, vscodeState } = createContext(workspaceRoot);
        const http = installHttpsMock();

        try {
            notion._delay = async () => {};
            http.queueJson(200, { bot: { owner: { type: 'user' } } }, (req) => req.path === '/v1/users/me');
            http.queueJson(200, {
                properties: {
                    Name: { type: 'title', title: [{ plain_text: 'End to End Spec' }] }
                }
            }, (req) => req.path === '/v1/pages/123456781234123412341234567890ab');
            http.queueJson(200, {
                results: [
                    {
                        type: 'paragraph',
                        paragraph: { rich_text: [{ type: 'text', plain_text: 'Spec body' }] },
                        has_children: false
                    }
                ],
                has_more: false,
                next_cursor: null
            }, (req) => req.path === '/v1/blocks/123456781234123412341234567890ab/children?page_size=100');

            const notionResult = await notion.fetchAndCache(
                'https://www.notion.so/acme/End-to-End-Spec-123456781234123412341234567890ab'
            );
            assert.strictEqual(notionResult.success, true);

            await clickup.saveConfig({
                workspaceId: 'team-1',
                folderId: 'folder-1',
                spaceId: 'space-1',
                columnMappings: {
                    CREATED: 'list-created',
                    BACKLOG: '',
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

            const planFile = path.join(workspaceRoot, '.switchboard', 'plans', 'imported.md');
            await writeText(planFile, readText(notion.cachePath));

            http.queueJson(200, { tasks: [] }, (req) => req.path.includes('/task?tags[]=switchboard%3Aplan-e2e'));
            http.queueJson(200, { id: 'task-e2e' }, (req) => req.path === '/api/v2/list/list-created/task');

            const clickupResult = await clickup.syncPlan({
                planId: 'plan-e2e',
                sessionId: 'session-e2e',
                topic: 'End to End plan',
                planFile,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: '6',
                tags: '',
                dependencies: '',
                createdAt: '2026-04-01T00:00:00.000Z',
                updatedAt: '2026-04-01T00:00:00.000Z',
                lastAction: 'created'
            });
            assert.deepStrictEqual(clickupResult, { success: true, taskId: 'task-e2e' });

            await linear.saveConfig({
                teamId: 'team-1',
                teamName: 'Engineering',
                projectId: undefined,
                columnToStateId: {
                    CREATED: 'state-created',
                    BACKLOG: 'state-backlog',
                    'PLAN REVIEWED': '',
                    'LEAD CODED': '',
                    'CODER CODED': '',
                    'CODE REVIEWED': '',
                    CODED: '',
                    COMPLETED: ''
                },
                switchboardLabelId: 'label-switchboard',
                setupComplete: true,
                lastSync: null,
                autoPullEnabled: false,
                pullIntervalMinutes: 60
            });
            http.queueJson(200, { data: { issueCreate: { success: true, issue: { id: 'issue-e2e', identifier: 'ENG-1' } } } });
            await linear.syncPlan({
                sessionId: 'session-linear',
                topic: 'Linear issue',
                planFile,
                complexity: '7'
            }, 'CREATED');

            assert.strictEqual(await linear.getIssueIdForPlan('session-linear'), 'issue-e2e');
            assert.strictEqual(vscodeState.warningMessageCalls.length, 0);
        } finally {
            http.restore();
        }
    });

    console.log('integration workflow test passed');
}

run().catch((error) => {
    console.error('integration workflow test failed:', error);
    process.exit(1);
});
