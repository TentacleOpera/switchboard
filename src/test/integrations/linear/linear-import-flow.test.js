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
    const { LinearSyncService } = loadOutModule('services/LinearSyncService.js', ['services/ClickUpSyncService.js']);
    installed.restore();
    return {
        service: new LinearSyncService(workspaceRoot, new SecretStorageMock(secretSeed))
    };
}

async function run() {
    await withWorkspace('linear-import', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_import'
        });
        await service.saveConfig({
            teamId: 'team-1',
            teamName: 'Engineering',
            projectId: 'project-1',
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
        await service.saveSyncMap({ 'session-synced': 'issue-synced' });

        const sampleIssue = loadFixtureJson('linear', 'issue-sample.json');
        const syncedIssue = {
            ...sampleIssue,
            id: 'issue-synced',
            identifier: 'ENG-103',
            title: 'Already synced',
            children: { nodes: [] },
            comments: { nodes: [] },
            attachments: { nodes: [] }
        };
        const completedIssue = {
            ...sampleIssue,
            id: 'issue-complete',
            identifier: 'ENG-104',
            title: 'Done issue',
            state: { name: 'Done', type: 'completed' },
            children: { nodes: [] },
            comments: { nodes: [] },
            attachments: { nodes: [] }
        };
        const backlogIssue = {
            ...sampleIssue,
            id: 'issue-backlog',
            identifier: 'ENG-105',
            title: 'Backlog issue',
            state: { name: 'Backlog', type: 'backlog' },
            children: { nodes: [] },
            comments: { nodes: [] },
            attachments: { nodes: [] }
        };

        const http = installHttpsMock();
        try {
            service.delay = async () => {};
            http.queueJson(200, {
                data: {
                    issues: {
                        nodes: [sampleIssue, syncedIssue, completedIssue],
                        pageInfo: { hasNextPage: true, endCursor: 'cursor-1' }
                    }
                }
            });
            http.queueJson(200, {
                data: {
                    issues: {
                        nodes: [backlogIssue],
                        pageInfo: { hasNextPage: false, endCursor: null }
                    }
                }
            });

            const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
            const result = await service.importIssuesFromLinear(plansDir);
            assert.deepStrictEqual(result, { success: true, imported: 3, skipped: 2 });

            const parentContent = readText(path.join(plansDir, 'linear_import_issue-parent.md'));
            const childContent = readText(path.join(plansDir, 'linear_import_issue-child.md'));
            const backlogContent = readText(path.join(plansDir, 'linear_import_issue-backlog.md'));

            assert.ok(parentContent.includes('## Linear Issue Notes'));
            assert.ok(parentContent.includes('**Sub-issues (each imported as a separate plan):**'));
            assert.ok(parentContent.includes('**Comments:**'));
            assert.ok(parentContent.includes('**Attachments:**'));
            assert.ok(parentContent.includes('**Kanban Column:** CREATED'));

            assert.ok(childContent.includes('> **Parent Issue:** Parent Issue (ENG-101)'));
            assert.ok(childContent.includes('## Goal'));
            assert.ok(backlogContent.includes('**Kanban Column:** BACKLOG'));
        } finally {
            http.restore();
        }
    });

    console.log('linear import flow test passed');
}

run().catch((error) => {
    console.error('linear import flow test failed:', error);
    process.exit(1);
});
