'use strict';

const assert = require('assert');
const fs = require('fs');
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
    const { LinearSyncService } = loadOutModule('services/LinearSyncService.js', ['services/ClickUpSyncService.js']);
    const { LinearAutomationService } = loadOutModule('services/LinearAutomationService.js', ['services/LinearSyncService.js', 'services/KanbanDatabase.js', 'services/PlanFileImporter.js']);
    const { KanbanDatabase } = loadOutModule('services/KanbanDatabase.js');
    const { importPlanFiles } = loadOutModule('services/PlanFileImporter.js');
    installed.restore();

    const service = new LinearSyncService(workspaceRoot, new SecretStorageMock(secretSeed));
    const automation = new LinearAutomationService(
        workspaceRoot,
        service,
        async () => path.join(workspaceRoot, '.switchboard', 'plans')
    );
    return { service, automation, KanbanDatabase, importPlanFiles };
}

function createRule(name, triggerLabel, triggerStates, targetColumn, finalColumn, writeBackOnComplete = true) {
    return {
        name,
        enabled: true,
        triggerLabel,
        triggerStates,
        targetColumn,
        finalColumn,
        writeBackOnComplete
    };
}

function createIssue(overrides = {}) {
    return {
        id: 'issue-bug',
        identifier: 'ENG-200',
        title: 'Investigate bug',
        description: 'The app crashes on launch.',
        url: 'https://linear.app/acme/issue/ENG-200',
        parent: null,
        state: {
            id: 'state-started',
            name: 'In Progress',
            type: 'started'
        },
        labels: {
            nodes: [
                { id: 'label-bug', name: 'bug' }
            ]
        },
        ...overrides
    };
}

function queueIssuesPage(http, issues) {
    http.queueJson(200, {
        data: {
            issues: {
                nodes: issues,
                pageInfo: { hasNextPage: false, endCursor: null }
            }
        }
    }, (req) => req.method === 'POST' && req.path === '/graphql' && String(req.jsonBody?.query || '').includes('issues('));
}

function queueIssueLookup(http, issueId, description) {
    http.queueJson(200, {
        data: {
            issue: {
                id: issueId,
                description
            }
        }
    }, (req) => req.method === 'POST'
        && req.path === '/graphql'
        && String(req.jsonBody?.query || '').includes('issue(id: $issueId)')
        && req.jsonBody?.variables?.issueId === issueId);
}

function queueIssueUpdate(http, issueId) {
    http.queueJson(200, {
        data: {
            issueUpdate: {
                success: true
            }
        }
    }, (req) => req.method === 'POST'
        && req.path === '/graphql'
        && String(req.jsonBody?.query || '').includes('issueUpdate')
        && req.jsonBody?.variables?.issueId === issueId);
}

async function testTeamWidePollingOmitsProjectVariable() {
    await withWorkspace('linear-automation-no-project', async ({ workspaceRoot }) => {
        const { service, automation } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_teamwide'
        });
        service.delay = async () => {};

        await service.saveConfig({
            teamId: 'team-1',
            teamName: 'Engineering',
            columnToStateId: {
                CREATED: 'state-created',
                BACKLOG: 'state-backlog',
                'PLAN REVIEWED': '',
                'LEAD CODED': '',
                'CODER CODED': '',
                'CODE REVIEWED': '',
                CODED: '',
                COMPLETED: 'state-completed'
            },
            switchboardLabelId: 'label-switchboard',
            setupComplete: true,
            lastSync: null,
            autoPullEnabled: false,
            pullIntervalMinutes: 60,
            automationRules: [createRule('Bug Summary', 'bug', ['state-started'], 'CREATED', 'COMPLETED', true)]
        });

        const http = installHttpsMock();
        try {
            queueIssuesPage(http, [createIssue({ id: 'issue-teamwide', identifier: 'ENG-299' })]);

            const pollResult = await automation.poll();
            assert.strictEqual(pollResult.created, 1);
            assert.strictEqual(pollResult.errors.length, 0);

            const issuesRequest = http.requests.find((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
            );
            assert.ok(issuesRequest, 'Expected Linear automation polling to issue an issues query.');
            assert.doesNotMatch(
                String(issuesRequest.jsonBody?.query || ''),
                /\$projectId/,
                'Expected team-wide Linear automation polling not to declare an unused $projectId variable.'
            );
            assert.strictEqual(
                Object.prototype.hasOwnProperty.call(issuesRequest.jsonBody?.variables || {}, 'projectId'),
                false,
                'Expected team-wide Linear automation polling not to send a projectId variable.'
            );
        } finally {
            http.restore();
        }
    });
}

async function testMixedProviderMetadataImportsAsLocalWithoutDedupeIds() {
    await withWorkspace('linear-automation-mixed-metadata', async ({ workspaceRoot }) => {
        const { KanbanDatabase, importPlanFiles } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_mixed'
        });
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        fs.mkdirSync(plansDir, { recursive: true });
        fs.writeFileSync(path.join(plansDir, 'mixed-metadata.md'), [
            '# Mixed provider metadata fixture',
            '',
            '> **Plan ID:** mixed-metadata',
            '> **Session ID:** mixed-metadata',
            '> **Automation Rule:** Confused Rule',
            '> **ClickUp Task ID:** task-123',
            '> **Linear Issue ID:** issue-123',
            '',
            '## Goal',
            '',
            'Exercise invalid mixed provider metadata handling.',
            '',
            '## Switchboard State',
            '',
            '**Kanban Column:** CREATED',
            '**Status:** active',
            ''
        ].join('\n'), 'utf8');

        const imported = await importPlanFiles(workspaceRoot);
        assert.strictEqual(imported, 1);

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        await db.ensureReady();
        const record = await db.getPlanBySessionId('mixed-metadata');
        assert.ok(record, 'Expected mixed-metadata fixture to import.');
        assert.strictEqual(record.sourceType, 'local');
        assert.strictEqual(record.clickupTaskId, '');
        assert.strictEqual(record.linearIssueId, '');
    });
}

async function run() {
    await testTeamWidePollingOmitsProjectVariable();
    await testMixedProviderMetadataImportsAsLocalWithoutDedupeIds();
    await withWorkspace('linear-automation', async ({ workspaceRoot }) => {
        const { service, automation, KanbanDatabase, importPlanFiles } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_automation'
        });
        service.delay = async () => {};

        const bugRule = createRule('Bug Summary', 'bug', ['state-started'], 'CREATED', 'COMPLETED', true);
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
                COMPLETED: 'state-completed'
            },
            switchboardLabelId: 'label-switchboard',
            setupComplete: true,
            lastSync: null,
            autoPullEnabled: false,
            pullIntervalMinutes: 60,
            automationRules: [bugRule]
        });

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        await db.ensureReady();
        await db.setWorkspaceId('workspace-1');
        await db.upsertPlans([{
            planId: 'existing-linear-automation',
            sessionId: 'existing-linear-session',
            topic: 'Existing Linear automation issue',
            planFile: path.join(workspaceRoot, '.switchboard', 'plans', 'existing-linear-automation.md'),
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            dependencies: '',
            workspaceId: 'workspace-1',
            createdAt: '2026-04-01T00:00:00.000Z',
            updatedAt: '2026-04-01T00:00:00.000Z',
            lastAction: 'linear_writeback_complete',
            sourceType: 'linear-automation',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: '',
            clickupTaskId: '',
            linearIssueId: 'issue-existing'
        }]);

        const matchingIssue = createIssue();
        const ownedIssue = createIssue({
            id: 'issue-owned',
            identifier: 'ENG-201',
            title: 'Owned issue',
            labels: { nodes: [{ id: 'label-switchboard', name: 'switchboard' }] }
        });
        const existingIssue = createIssue({
            id: 'issue-existing',
            identifier: 'ENG-202',
            title: 'Already imported issue'
        });
        const childIssue = createIssue({
            id: 'issue-child',
            identifier: 'ENG-203',
            title: 'Child issue',
            parent: { id: 'issue-parent' }
        });
        const wrongStateIssue = createIssue({
            id: 'issue-backlog',
            identifier: 'ENG-204',
            title: 'Wrong state issue',
            state: {
                id: 'state-backlog',
                name: 'Backlog',
                type: 'backlog'
            }
        });

        const http = installHttpsMock();
        try {
            queueIssuesPage(http, [matchingIssue, ownedIssue, existingIssue, childIssue, wrongStateIssue]);

            const firstPoll = await automation.poll();
            assert.strictEqual(firstPoll.created, 1);
            assert.strictEqual(firstPoll.skipped, 4);
            assert.strictEqual(firstPoll.writeBacks, 0);
            assert.strictEqual(firstPoll.errors.length, 0);

            const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
            const generatedPlans = fs.readdirSync(plansDir).filter((file) => file.endsWith('.md'));
            assert.strictEqual(
                generatedPlans.length,
                1,
                'Expected only one Linear automation plan file for the matching issue.'
            );

            const importedCount = await importPlanFiles(workspaceRoot);
            assert.strictEqual(importedCount, 1, 'Expected the generated Linear automation plan to import cleanly.');

            const createdPlan = await db.findPlanByLinearIssueId('workspace-1', 'issue-bug');
            assert.ok(createdPlan, 'Expected the Linear automation-created plan to be persisted.');
            assert.strictEqual(createdPlan.sourceType, 'linear-automation');
            assert.strictEqual(createdPlan.linearIssueId, 'issue-bug');
            assert.strictEqual(createdPlan.kanbanColumn, 'CREATED');

            const planContent = readText(createdPlan.planFile);
            assert.ok(planContent.includes('**Linear Issue ID:** issue-bug'));
            assert.ok(planContent.includes('**Automation Rule:** Bug Summary'));
            assert.ok(planContent.includes('## Linear Issue Notes'));
            assert.ok(planContent.includes('**Kanban Column:** CREATED'));

            await db.updateColumn(createdPlan.sessionId, 'COMPLETED');
            const refreshedContext = createContext(workspaceRoot, {
                'switchboard.linear.apiToken': 'lin_api_automation'
            });
            refreshedContext.service.delay = async () => {};

            queueIssuesPage(http, [matchingIssue]);
            const requestCountBeforeWriteBack = http.requests.length;
            queueIssueLookup(http, 'issue-bug', 'Existing issue body');
            queueIssueUpdate(http, 'issue-bug');

            const secondPoll = await refreshedContext.automation.poll();
            assert.strictEqual(secondPoll.created, 0);
            assert.strictEqual(secondPoll.writeBacks, 1);
            assert.strictEqual(secondPoll.errors.length, 0);

            const writeBackRequests = http.requests.slice(requestCountBeforeWriteBack);
            const updateRequest = writeBackRequests.find((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issueUpdate')
            );
            assert.ok(updateRequest, 'Expected Linear automation write-back to update the originating issue.');
            assert.strictEqual(
                writeBackRequests.filter((req) => String(req.jsonBody?.query || '').includes('commentCreate')).length,
                0,
                'Expected the default Linear automation write-back path to append to the issue description.'
            );
            assert.match(updateRequest.jsonBody.variables.description, /Switchboard Automation Result/);
            assert.match(updateRequest.jsonBody.variables.description, /Automation Rule:\*\* Bug Summary/);
            assert.match(updateRequest.jsonBody.variables.description, /Investigate bug/);

            const refreshedDb = refreshedContext.KanbanDatabase.forWorkspace(workspaceRoot);
            await refreshedDb.ensureReady();
            const updatedPlan = await refreshedDb.getPlanBySessionId(createdPlan.sessionId);
            assert.strictEqual(updatedPlan.lastAction, 'linear_writeback_complete');

            queueIssuesPage(http, [matchingIssue]);
            const requestCountBeforeThirdPoll = http.requests.length;
            const thirdPoll = await refreshedContext.automation.poll();
            assert.strictEqual(thirdPoll.created, 0);
            assert.strictEqual(thirdPoll.writeBacks, 0);
            assert.strictEqual(thirdPoll.errors.length, 0);
            assert.strictEqual(
                http.requests.slice(requestCountBeforeThirdPoll).filter((req) => String(req.jsonBody?.query || '').includes('issueUpdate')).length,
                0,
                'Expected Linear write-back to be idempotent once the completion marker is set.'
            );
        } finally {
            http.restore();
        }
    });

    console.log('linear automation service test passed');
}

run().catch((error) => {
    console.error('linear automation service test failed:', error);
    process.exit(1);
});
