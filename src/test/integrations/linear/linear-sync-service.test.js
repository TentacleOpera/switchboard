'use strict';

const assert = require('assert');
const path = require('path');
const {
    withWorkspace,
    writeJson,
    writeText,
    readJson,
    loadOutModule,
    withFakeTimers
} = require('../shared/test-harness');
const { installVsCodeMock } = require('../shared/vscode-mock');
const { SecretStorageMock } = require('../shared/secret-storage-mock');
const { installHttpsMock } = require('../shared/http-mock-helpers');

function createContext(workspaceRoot, secretSeed = {}) {
    const installed = installVsCodeMock();
    const { LinearSyncService, CANONICAL_COLUMNS } = loadOutModule('services/LinearSyncService.js', ['services/ClickUpSyncService.js']);
    const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
    const { DEFAULT_LIVE_SYNC_CONFIG } = loadOutModule('models/LiveSyncTypes.js');
    installed.restore();
    return {
        service: new LinearSyncService(workspaceRoot, new SecretStorageMock(secretSeed)),
        vscodeState: installed.state,
        CANONICAL_COLUMNS,
        KanbanDatabase,
        DEFAULT_LIVE_SYNC_CONFIG
    };
}

function baseConfig(overrides = {}) {
    return {
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
        realTimeSyncEnabled: false,
        autoPullEnabled: false,
        pullIntervalMinutes: 60,
        automationRules: [],
        ...overrides
    };
}

function createPlanRecord(overrides = {}) {
    const sessionId = overrides.sessionId || 'session';
    return {
        planId: overrides.planId || sessionId,
        sessionId,
        topic: 'Linear issue',
        planFile: 'plan.md',
        kanbanColumn: 'CREATED',
        status: 'active',
        complexity: '5',
        tags: '',
        dependencies: '',
        repoScope: '',
        workspaceId: 'workspace-1',
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-01T00:00:00.000Z',
        lastAction: 'created',
        sourceType: 'local',
        brainSourcePath: '',
        mirrorPath: '',
        routedTo: '',
        dispatchedAgent: '',
        dispatchedIde: '',
        clickupTaskId: '',
        linearIssueId: '',
        ...overrides,
        planId: overrides.planId || sessionId,
        sessionId
    };
}

function createLinearIssueNode(overrides = {}) {
    return {
        id: 'issue-1',
        identifier: 'ENG-101',
        title: 'Alpha issue',
        description: 'Alpha details',
        state: {
            id: 'state-started',
            name: 'In Progress',
            type: 'started'
        },
        priority: 2,
        assignee: {
            id: 'assignee-1',
            name: 'Pat',
            email: 'pat@example.com'
        },
        project: {
            id: 'project-1',
            name: 'Project One'
        },
        labels: {
            nodes: [
                { id: 'label-bug', name: 'bug' }
            ]
        },
        createdAt: '2026-04-01T00:00:00.000Z',
        updatedAt: '2026-04-02T00:00:00.000Z',
        url: 'https://linear.app/acme/issue/ENG-101',
        ...overrides
    };
}

async function testConfigAndSyncMapPersistence() {
    await withWorkspace('linear-config', async ({ workspaceRoot }) => {
        const { service, KanbanDatabase } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_token'
        });

        await writeJson(service.configPath, {
            teamId: 'legacy-team',
            teamName: 'Legacy',
            setupComplete: true,
            pullIntervalMinutes: 999
        });
        const config = await service.loadConfig();
        assert.strictEqual(config.pullIntervalMinutes, 60);
        assert.strictEqual(config.realTimeSyncEnabled, true);
        assert.deepStrictEqual(config.automationRules, []);

        await service.setIssueIdForPlan('session-1', 'issue-1');
        assert.strictEqual(await service.getIssueIdForPlan('session-1'), 'issue-1');

        const db = KanbanDatabase.forWorkspace(workspaceRoot);
        await db.ensureReady();
        assert.strictEqual(
            await db.updateLinearIssueId('missing-session', 'issue-missing'),
            false,
            'Expected updateLinearIssueId() to fail loudly when the target plan row does not exist.'
        );
    });
}

async function testSetupAndSyncFallback() {
    await withWorkspace('linear-setup', async ({ workspaceRoot }) => {
        const {
            service,
            vscodeState,
            CANONICAL_COLUMNS,
            KanbanDatabase,
            DEFAULT_LIVE_SYNC_CONFIG
        } = createContext(workspaceRoot);
        const http = installHttpsMock();

        try {
            vscodeState.inputBoxResponses.push('lin_api_live_token');
            vscodeState.quickPickResponses.push(
                (items) => items[0],
                (items) => items[1],
                ...CANONICAL_COLUMNS.map(() => (items) => items[1])
            );

            http.queueJson(200, { data: { viewer: { id: 'viewer-1' } } });
            http.queueJson(200, { data: { teams: { nodes: [{ id: 'team-1', name: 'Engineering' }] } } });
            http.queueJson(200, { data: { team: { projects: { nodes: [{ id: 'project-1', name: 'Project One' }] } } } });
            http.queueJson(200, {
                data: {
                    team: {
                        states: {
                            nodes: [
                                { id: 'state-created', name: 'Todo', type: 'backlog' },
                                { id: 'state-started', name: 'In Progress', type: 'started' }
                            ]
                        }
                    }
                }
            });
            http.queueJson(200, { data: { team: { labels: { nodes: [] } } } });
            http.queueJson(200, { data: { issueLabelCreate: { issueLabel: { id: 'label-switchboard' } } } });

            const result = await service.applyConfig({
                mapColumns: true,
                createLabel: true,
                scopeProject: true,
                enableRealtimeSync: true,
                enableAutoPull: false
            });
            assert.deepStrictEqual(result, { success: true });

            const saved = readJson(service.configPath);
            assert.strictEqual(saved.teamId, 'team-1');
            assert.strictEqual(saved.projectId, 'project-1');
            assert.strictEqual(saved.switchboardLabelId, 'label-switchboard');
            assert.strictEqual(saved.realTimeSyncEnabled, true);
            assert.deepStrictEqual(saved.automationRules, []);
            assert.strictEqual(vscodeState.inputBoxCalls[0].password, true);

            await service.saveAutomationSettings([{
                name: 'Bug Intake',
                triggerLabel: 'bug',
                triggerStates: ['state-started', 'state-started'],
                targetColumn: 'CREATED',
                finalColumn: 'COMPLETED',
                writeBackOnComplete: true
            }]);
            const automationConfig = await service.loadConfig();
            assert.deepStrictEqual(automationConfig.automationRules, [{
                name: 'Bug Intake',
                enabled: true,
                triggerLabel: 'bug',
                triggerStates: ['state-started'],
                targetColumn: 'CREATED',
                finalColumn: 'COMPLETED',
                writeBackOnComplete: true
            }]);

            http.queueJson(200, {
                data: {
                    team: {
                        states: {
                            nodes: [
                                { id: 'state-created', name: 'Todo', type: 'backlog' },
                                { id: 'state-started', name: 'In Progress', type: 'started' }
                            ]
                        },
                        labels: {
                            nodes: [
                                { id: 'label-bug', name: 'bug' },
                                { id: 'label-docs', name: 'docs' }
                            ]
                        }
                    }
                }
            }, (req) => req.method === 'POST' && req.path === '/graphql' && req.jsonBody?.query.includes('states { nodes { id name type } }') && req.jsonBody?.query.includes('labels { nodes { id name } }'));
            const catalog = await service.getAutomationCatalog();
            assert.deepStrictEqual(catalog, {
                labels: [
                    { id: 'label-bug', name: 'bug' },
                    { id: 'label-docs', name: 'docs' }
                ],
                states: [
                    { id: 'state-created', name: 'Todo', type: 'backlog' },
                    { id: 'state-started', name: 'In Progress', type: 'started' }
                ]
            });

            await service.saveConfig(baseConfig());
            const db = KanbanDatabase.forWorkspace(workspaceRoot);
            await db.ensureReady();
            await db.setWorkspaceId('workspace-1');

            await writeText(path.join(workspaceRoot, 'plan.md'), '# Create Linear issue\n\n## Goal\n- Sync actual markdown.\n');
            await db.upsertPlans([createPlanRecord({
                sessionId: 'session-create',
                topic: 'Create Linear issue',
                planFile: 'plan.md',
                complexity: '9'
            })]);
            http.queueJson(200, { data: { issueCreate: { success: true, issue: { id: 'issue-created', identifier: 'ENG-1' } } } });
            await service.syncPlan({
                sessionId: 'session-create',
                topic: 'Create Linear issue',
                planFile: 'plan.md',
                complexity: '9'
            }, 'CREATED');
            assert.strictEqual(await service.getIssueIdForPlan('session-create'), 'issue-created');
            const refreshedCreateDb = loadOutModule('services/KanbanDatabase.js').KanbanDatabase.forWorkspace(workspaceRoot);
            await refreshedCreateDb.ensureReady();
            assert.strictEqual((await refreshedCreateDb.getPlanBySessionId('session-create')).linearIssueId, 'issue-created');

            const createRequest = http.requests.find((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issueCreate')
                && req.jsonBody?.variables?.input?.title === 'Create Linear issue'
            );
            assert.ok(createRequest, 'Expected the initial Linear issue create mutation to be sent.');
            assert.strictEqual(
                createRequest.jsonBody?.variables?.input?.description,
                '# Create Linear issue\n\n## Goal\n- Sync actual markdown.\n',
                'Expected new Linear issues to start with actual plan markdown.'
            );

            const truncationSuffix = '\n\n... (truncated by Switchboard before Linear issue creation)';
            const oversizedPlanPath = path.join(workspaceRoot, 'oversized-plan.md');
            const oversizedPlanContent = '# Oversized issue\n\n' + '😀'.repeat(30000);
            await writeText(oversizedPlanPath, oversizedPlanContent);
            await db.upsertPlans([createPlanRecord({
                sessionId: 'session-oversized',
                topic: 'Oversized issue',
                planFile: oversizedPlanPath,
                complexity: '7'
            })]);
            http.queueJson(200, { data: { issueCreate: { success: true, issue: { id: 'issue-oversized', identifier: 'ENG-OVERSIZED' } } } });
            await service.syncPlan({
                sessionId: 'session-oversized',
                topic: 'Oversized issue',
                planFile: oversizedPlanPath,
                complexity: '7'
            }, 'CREATED');
            const oversizedRequest = http.requests.find((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issueCreate')
                && req.jsonBody?.variables?.input?.title === 'Oversized issue'
            );
            assert.ok(oversizedRequest, 'Expected the oversized Linear issue create mutation to be sent.');
            const oversizedDescription = oversizedRequest.jsonBody?.variables?.input?.description;
            assert.ok(
                Buffer.byteLength(oversizedDescription, 'utf8') <= DEFAULT_LIVE_SYNC_CONFIG.maxContentSizeBytes,
                'Expected oversized Linear descriptions to respect the live-sync byte ceiling.'
            );
            assert.ok(
                oversizedDescription.endsWith(truncationSuffix),
                'Expected oversized Linear descriptions to end with the truncation suffix.'
            );
            assert.ok(
                oversizedDescription.startsWith('# Oversized issue\n\n'),
                'Expected truncation to preserve the beginning of the plan markdown.'
            );

            await writeText(path.join(workspaceRoot, 'recreate-plan.md'), '# Recreated issue\n\n## Proposed Changes\n- Preserve readable markdown on recreate.\n');
            await service.setIssueIdForPlan('session-recreate', 'issue-existing-readable');
            await db.upsertPlans([createPlanRecord({
                sessionId: 'session-recreate',
                topic: 'Recreated issue',
                planFile: 'recreate-plan.md'
            })]);
            http.queueJson(200, { data: { issueUpdate: { success: false } } });
            http.queueJson(200, { data: { issueCreate: { success: true, issue: { id: 'issue-recreated-readable', identifier: 'ENG-2A' } } } });
            await service.syncPlan({
                sessionId: 'session-recreate',
                topic: 'Recreated issue',
                planFile: 'recreate-plan.md',
                complexity: '5'
            }, 'CREATED');
            assert.strictEqual(await service.getIssueIdForPlan('session-recreate'), 'issue-recreated-readable');
            const recreateMarkdownRequest = http.requests.find((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issueCreate')
                && req.jsonBody?.variables?.input?.title === 'Recreated issue'
            );
            assert.ok(recreateMarkdownRequest, 'Expected the recreate Linear issue mutation to be sent for readable plan content.');
            assert.strictEqual(
                recreateMarkdownRequest.jsonBody?.variables?.input?.description,
                '# Recreated issue\n\n## Proposed Changes\n- Preserve readable markdown on recreate.\n',
                'Expected recreated Linear issues to preserve actual plan markdown when the file is readable.'
            );

            await service.setIssueIdForPlan('session-update', 'issue-existing');
            await db.upsertPlans([createPlanRecord({
                sessionId: 'session-update',
                topic: 'Fallback issue',
                planFile: 'missing-plan.md'
            })]);
            http.queueJson(200, { data: { issueUpdate: { success: false } } });
            http.queueJson(200, { data: { issueCreate: { success: true, issue: { id: 'issue-recreated', identifier: 'ENG-2B' } } } });
            await service.syncPlan({
                sessionId: 'session-update',
                topic: 'Fallback issue',
                planFile: 'missing-plan.md',
                complexity: '5'
            }, 'CREATED');
            assert.strictEqual(await service.getIssueIdForPlan('session-update'), 'issue-recreated');
            const refreshedUpdateDb = loadOutModule('services/KanbanDatabase.js').KanbanDatabase.forWorkspace(workspaceRoot);
            await refreshedUpdateDb.ensureReady();
            assert.strictEqual((await refreshedUpdateDb.getPlanBySessionId('session-update')).linearIssueId, 'issue-recreated');

            const fallbackRequest = http.requests.find((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issueCreate')
                && req.jsonBody?.variables?.input?.title === 'Fallback issue'
            );
            assert.ok(fallbackRequest, 'Expected the fallback Linear issue create mutation to be sent.');
            assert.strictEqual(
                fallbackRequest.jsonBody?.variables?.input?.description,
                'Managed by Switchboard.\n\nPlan file: `missing-plan.md`\n\nDo not edit the title — it is synced from Switchboard.',
                'Expected unreadable plan files to fall back to the stub Linear description.'
            );
        } finally {
            http.restore();
        }
    });
}

async function testApplyConfigOptionsAndValidation() {
    await withWorkspace('linear-apply', async ({ workspaceRoot }) => {
        const { service, vscodeState, CANONICAL_COLUMNS } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_apply_token'
        });

        let http = installHttpsMock();
        try {
            vscodeState.quickPickResponses.push(
                (items) => items[0],
                ...CANONICAL_COLUMNS.map(() => (items) => items[1])
            );

            http.queueJson(200, { data: { viewer: { id: 'viewer-1' } } });
            http.queueJson(200, { data: { teams: { nodes: [{ id: 'team-1', name: 'Engineering' }] } } });
            http.queueJson(200, {
                data: {
                    team: {
                        states: {
                            nodes: [
                                { id: 'state-created', name: 'Todo', type: 'backlog' },
                                { id: 'state-started', name: 'In Progress', type: 'started' }
                            ]
                        }
                    }
                }
            });

            const mappedOnly = await service.applyConfig({
                mapColumns: true,
                createLabel: false,
                scopeProject: false,
                enableRealtimeSync: false,
                enableAutoPull: false
            });
            assert.deepStrictEqual(mappedOnly, { success: true });

            const mappedConfig = readJson(service.configPath);
            assert.strictEqual(mappedConfig.teamId, 'team-1');
            assert.strictEqual(mappedConfig.switchboardLabelId, '');
            assert.strictEqual(mappedConfig.projectId, undefined);
            assert.strictEqual(mappedConfig.realTimeSyncEnabled, false);
            assert.ok(mappedConfig.columnToStateId.CREATED);
        } finally {
            http.restore();
        }

        await service.saveConfig(baseConfig({ switchboardLabelId: '', projectId: undefined, columnToStateId: {} }));
        http = installHttpsMock();
        try {
            http.queueJson(200, { data: { viewer: { id: 'viewer-1' } } });
            http.queueJson(200, { data: { team: { labels: { nodes: [] } } } });
            http.queueJson(200, { data: { issueLabelCreate: { issueLabel: { id: 'label-switchboard' } } } });

            const labelOnly = await service.applyConfig({
                mapColumns: false,
                createLabel: true,
                scopeProject: false,
                enableRealtimeSync: false,
                enableAutoPull: false
            });
            assert.deepStrictEqual(labelOnly, { success: true });
            assert.strictEqual(readJson(service.configPath).switchboardLabelId, 'label-switchboard');
        } finally {
            http.restore();
        }

        await service.saveConfig(baseConfig({ projectId: undefined }));
        http = installHttpsMock();
        try {
            http.queueJson(200, { data: { viewer: { id: 'viewer-1' } } });

            const realtimeEnabled = await service.applyConfig({
                mapColumns: false,
                createLabel: false,
                scopeProject: false,
                enableRealtimeSync: true,
                enableAutoPull: false
            });
            assert.deepStrictEqual(realtimeEnabled, { success: true });
            const realtimeConfig = readJson(service.configPath);
            assert.strictEqual(realtimeConfig.realTimeSyncEnabled, true);
            assert.strictEqual(realtimeConfig.columnToStateId.CREATED, 'state-created');
        } finally {
            http.restore();
        }

        await service.saveConfig(baseConfig({ projectId: undefined }));
        http = installHttpsMock();
        try {
            http.queueJson(200, { data: { viewer: { id: 'viewer-1' } } });

            const autoPullEnabled = await service.applyConfig({
                mapColumns: false,
                createLabel: false,
                scopeProject: false,
                enableRealtimeSync: false,
                enableAutoPull: true
            });
            assert.deepStrictEqual(autoPullEnabled, { success: true });
            const autoPullConfig = readJson(service.configPath);
            assert.strictEqual(autoPullConfig.autoPullEnabled, true);
            assert.strictEqual(autoPullConfig.columnToStateId.CREATED, 'state-created');
        } finally {
            http.restore();
        }

        await service.saveConfig(baseConfig({ projectId: 'project-1' }));
        http = installHttpsMock();
        try {
            http.queueJson(200, { data: { viewer: { id: 'viewer-1' } } });

            const projectCleared = await service.applyConfig({
                mapColumns: false,
                createLabel: false,
                scopeProject: false,
                enableRealtimeSync: false,
                enableAutoPull: false
            });
            assert.deepStrictEqual(projectCleared, { success: true });
            assert.strictEqual(readJson(service.configPath).projectId, undefined);
        } finally {
            http.restore();
        }
    });
}

async function testNativeQueryAndMutationHelpers() {
    await withWorkspace('linear-native-api', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_native'
        });
        await service.saveConfig(baseConfig());

        const http = installHttpsMock();
        try {
            http.queueJson(200, {
                data: {
                    issues: {
                        nodes: [
                            createLinearIssueNode(),
                            createLinearIssueNode({
                                id: 'issue-2',
                                identifier: 'ENG-102',
                                title: 'Beta issue',
                                description: 'Does not match search text',
                                assignee: {
                                    id: 'assignee-2',
                                    name: 'Taylor',
                                    email: 'taylor@example.com'
                                }
                            }),
                            createLinearIssueNode({
                                id: 'issue-3',
                                identifier: 'ENG-103',
                                title: 'Alpha follow-up',
                                description: 'Alpha sequel'
                            })
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null }
                    }
                }
            });
            const issues = await service.queryIssues({
                search: 'alpha',
                stateId: 'state-started',
                assigneeId: 'assignee-1',
                limit: 2
            });
            assert.deepStrictEqual(
                issues.map((issue) => issue.identifier),
                ['ENG-101', 'ENG-103'],
                'Expected queryIssues to apply search, assignee, and state filters before returning normalized issues.'
            );
            const issueListRequests = http.requests.filter((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
            );
            const queryRequest = issueListRequests[0];
            assert.ok(queryRequest, 'Expected queryIssues to issue a Linear issues query.');
            assert.strictEqual(queryRequest.jsonBody?.variables?.first, 2);
            assert.match(
                String(queryRequest.jsonBody?.query || ''),
                /query\(\$filter: IssueFilter!, \$after: String, \$first: Int!\)/,
                'Expected project-scoped queryIssues requests to use a single IssueFilter GraphQL variable.'
            );
            assert.doesNotMatch(
                String(queryRequest.jsonBody?.query || ''),
                /\$teamId|\$projectId/,
                'Expected project-scoped queryIssues requests not to declare separate teamId/projectId variables.'
            );
            assert.deepStrictEqual(queryRequest.jsonBody?.variables?.filter, {
                team: { id: { eq: 'team-1' } },
                project: { id: { eq: 'project-1' } }
            });

            http.queueJson(200, {
                data: {
                    issue: createLinearIssueNode({
                        id: 'issue-direct',
                        identifier: 'ENG-200',
                        title: 'Direct lookup issue'
                    })
                }
            }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issue(id: $issueId)')
                && req.jsonBody?.variables?.issueId === 'issue-direct');
            const directIssue = await service.getIssue('issue-direct');
            assert.strictEqual(directIssue?.identifier, 'ENG-200');
            assert.strictEqual(directIssue?.title, 'Direct lookup issue');

            http.queueJson(200, {
                data: {
                    issues: {
                        nodes: [
                            createLinearIssueNode({
                                id: 'issue-identifier',
                                identifier: 'ENG-201',
                                title: 'Identifier lookup issue'
                            })
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null }
                    }
                }
            }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
                && req.jsonBody?.variables?.filter?.team?.id?.eq === 'team-1'
                && req.jsonBody?.variables?.filter?.project?.id?.eq === 'project-1'
                && req.jsonBody?.variables?.first === 50);
            const identifierIssue = await service.getIssue('ENG-201');
            assert.strictEqual(identifierIssue?.id, 'issue-identifier');
            assert.strictEqual(identifierIssue?.title, 'Identifier lookup issue');
            const refreshedIssueListRequests = http.requests.filter((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
            );
            const identifierLookupRequest = refreshedIssueListRequests[1];
            assert.ok(identifierLookupRequest, 'Expected identifier-based getIssue to reuse the issue-list query helper.');
            assert.match(
                String(identifierLookupRequest.jsonBody?.query || ''),
                /query\(\$filter: IssueFilter!, \$after: String, \$first: Int!\)/,
                'Expected identifier-based getIssue lookups to use the shared IssueFilter GraphQL variable.'
            );
            assert.doesNotMatch(
                String(identifierLookupRequest.jsonBody?.query || ''),
                /\$teamId|\$projectId/,
                'Expected identifier-based getIssue lookups not to declare separate teamId/projectId variables.'
            );
            assert.deepStrictEqual(identifierLookupRequest.jsonBody?.variables?.filter, {
                team: { id: { eq: 'team-1' } },
                project: { id: { eq: 'project-1' } }
            });

            http.queueJson(200, { data: { issueUpdate: { success: true } } }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('stateId: $stateId')
                && req.jsonBody?.variables?.id === 'issue-direct'
                && req.jsonBody?.variables?.stateId === 'state-done');
            await service.updateIssueState('issue-direct', 'state-done');

            http.queueJson(200, { data: { commentCreate: { success: true } } }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('commentCreate')
                && req.jsonBody?.variables?.issueId === 'issue-direct'
                && req.jsonBody?.variables?.body === 'Looks good');
            await service.addIssueComment('issue-direct', 'Looks good');

            http.queueJson(200, { data: { issueUpdate: { success: true } } }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('description: $description')
                && req.jsonBody?.variables?.id === 'issue-direct'
                && req.jsonBody?.variables?.description === 'Updated description');
            await service.updateIssueDescription('issue-direct', 'Updated description');

            http.queueJson(200, { data: { issueUpdate: { success: false } } });
            await assert.rejects(
                () => service.updateIssueState('issue-direct', 'state-fail'),
                /rejected the requested state update/
            );

            http.queueJson(200, { data: { commentCreate: { success: false } } });
            await assert.rejects(
                () => service.addIssueComment('issue-direct', 'Will fail'),
                /rejected the requested comment/
            );

            http.queueJson(200, { data: { issueUpdate: { success: false } } });
            await assert.rejects(
                () => service.updateIssueDescription('issue-direct', 'Will fail'),
                /rejected the requested description update/
            );
        } finally {
            http.restore();
        }
    });
}

async function testDetailQueryHelpers() {
    await withWorkspace('linear-detail-helpers', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_details'
        });
        await service.saveConfig(baseConfig());

        const http = installHttpsMock();
        try {
            http.queueJson(200, {
                data: {
                    issue: {
                        children: {
                            nodes: [
                                createLinearIssueNode({
                                    id: 'issue-child',
                                    identifier: 'ENG-102',
                                    title: 'Child issue'
                                })
                            ]
                        }
                    }
                }
            }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('children')
                && req.jsonBody?.variables?.issueId === 'issue-parent');
            const subtasks = await service.getSubtasks('issue-parent');
            assert.deepStrictEqual(
                subtasks.map((issue) => issue.identifier),
                ['ENG-102'],
                'Expected getSubtasks to normalize child issues from Linear.'
            );

            http.queueJson(200, {
                data: {
                    issue: {
                        comments: {
                            nodes: [
                                {
                                    id: 'comment-1',
                                    body: 'Looks good',
                                    createdAt: '2026-04-02T12:00:00.000Z',
                                    user: {
                                        name: 'Pat',
                                        email: 'pat@example.com'
                                    }
                                }
                            ]
                        }
                    }
                }
            }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('comments')
                && req.jsonBody?.variables?.issueId === 'issue-parent');
            const comments = await service.getComments('issue-parent');
            assert.deepStrictEqual(comments, [{
                id: 'comment-1',
                body: 'Looks good',
                user: {
                    name: 'Pat',
                    email: 'pat@example.com'
                },
                createdAt: '2026-04-02T12:00:00.000Z'
            }]);

            http.queueJson(200, {
                data: {
                    issue: {
                        attachments: {
                            nodes: [
                                {
                                    id: 'attachment-1',
                                    title: 'Spec Doc',
                                    url: 'https://files.example/spec.md'
                                }
                            ]
                        }
                    }
                }
            }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('attachments')
                && req.jsonBody?.variables?.issueId === 'issue-parent');
            const attachments = await service.getAttachments('issue-parent');
            assert.deepStrictEqual(attachments, [{
                id: 'attachment-1',
                title: 'Spec Doc',
                url: 'https://files.example/spec.md',
                filename: 'Spec Doc',
                filesize: undefined,
                mimeType: undefined
            }]);

            http.queueJson(200, {
                data: {
                    issue: {
                        comments: {
                            nodes: []
                        }
                    }
                }
            }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('comments')
                && req.jsonBody?.variables?.issueId === 'issue-empty');
            const emptyComments = await service.getComments('issue-empty');
            assert.deepStrictEqual(emptyComments, [], 'Expected empty detail collections to normalize to [].');

            await assert.rejects(
                () => service.getAttachments(''),
                /requires an issue ID/i,
                'Expected detail lookup helpers to validate required issue IDs.'
            );
        } finally {
            http.restore();
        }
    });
}

async function testTeamWideIssueListQueriesUseFilterVariable() {
    await withWorkspace('linear-teamwide-query-shape', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_teamwide'
        });
        await service.saveConfig(baseConfig({ projectId: undefined }));

        const http = installHttpsMock();
        try {
            http.queueJson(200, {
                data: {
                    issues: {
                        nodes: [
                            createLinearIssueNode({
                                id: 'issue-teamwide',
                                identifier: 'ENG-300',
                                title: 'Team-wide issue',
                                project: null
                            })
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null }
                    }
                }
            });
            const issues = await service.queryIssues({ limit: 1 });
            assert.strictEqual(issues.length, 1);
            assert.strictEqual(issues[0].identifier, 'ENG-300');

            const initialIssueListRequests = http.requests.filter((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
            );
            const teamWideQueryRequest = initialIssueListRequests[0];
            assert.ok(teamWideQueryRequest, 'Expected team-wide queryIssues to issue a Linear issues query.');
            assert.match(
                String(teamWideQueryRequest.jsonBody?.query || ''),
                /query\(\$filter: IssueFilter!, \$after: String, \$first: Int!\)/,
                'Expected team-wide queryIssues requests to use a single IssueFilter GraphQL variable.'
            );
            assert.doesNotMatch(
                String(teamWideQueryRequest.jsonBody?.query || ''),
                /\$teamId|\$projectId/,
                'Expected team-wide queryIssues requests not to declare separate teamId/projectId variables.'
            );
            assert.deepStrictEqual(teamWideQueryRequest.jsonBody?.variables?.filter, {
                team: { id: { eq: 'team-1' } }
            });
            assert.strictEqual(
                Object.prototype.hasOwnProperty.call(teamWideQueryRequest.jsonBody?.variables?.filter || {}, 'project'),
                false,
                'Expected team-wide queryIssues requests to omit project filters entirely.'
            );

            http.queueJson(200, {
                data: {
                    issues: {
                        nodes: [
                            createLinearIssueNode({
                                id: 'issue-teamwide-lookup',
                                identifier: 'ENG-301',
                                title: 'Team-wide lookup issue',
                                project: null
                            })
                        ],
                        pageInfo: { hasNextPage: false, endCursor: null }
                    }
                }
            }, (req) => req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
                && req.jsonBody?.variables?.filter?.team?.id?.eq === 'team-1'
                && req.jsonBody?.variables?.first === 50);
            const identifierIssue = await service.getIssue('ENG-301');
            assert.strictEqual(identifierIssue?.id, 'issue-teamwide-lookup');
            assert.strictEqual(identifierIssue?.title, 'Team-wide lookup issue');

            const refreshedIssueListRequests = http.requests.filter((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
            );
            const identifierLookupRequest = refreshedIssueListRequests[1];
            assert.ok(identifierLookupRequest, 'Expected team-wide identifier lookups to reuse the issue-list query helper.');
            assert.match(
                String(identifierLookupRequest.jsonBody?.query || ''),
                /query\(\$filter: IssueFilter!, \$after: String, \$first: Int!\)/,
                'Expected team-wide identifier lookups to use the shared IssueFilter GraphQL variable.'
            );
            assert.doesNotMatch(
                String(identifierLookupRequest.jsonBody?.query || ''),
                /\$teamId|\$projectId/,
                'Expected team-wide identifier lookups not to declare separate teamId/projectId variables.'
            );
            assert.deepStrictEqual(identifierLookupRequest.jsonBody?.variables?.filter, {
                team: { id: { eq: 'team-1' } }
            });
            assert.strictEqual(
                Object.prototype.hasOwnProperty.call(identifierLookupRequest.jsonBody?.variables?.filter || {}, 'project'),
                false,
                'Expected team-wide identifier lookups to omit project filters entirely.'
            );
        } finally {
            http.restore();
        }
    });
}

async function testDebouncedSyncAndUnmappedColumn() {
    await withWorkspace('linear-debounce', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_token'
        });
        await service.saveConfig(baseConfig());

        const http = installHttpsMock();
        try {
            const requestCountBefore = http.requests.length;
            await service.syncPlan({
                sessionId: 'session-unmapped',
                topic: 'Unmapped',
                planFile: 'plan.md',
                complexity: '3'
            }, 'PLAN REVIEWED');
            assert.strictEqual(http.requests.length, requestCountBefore, 'unmapped columns should not call Linear');
        } finally {
            http.restore();
        }

        await withFakeTimers(async ({ active, fire }) => {
            const synced = [];
            service.syncPlan = async (plan, column) => {
                synced.push(`${plan.sessionId}:${column}`);
            };

            service.debouncedSync('session-a', { sessionId: 'session-a' }, 'CREATED');
            const firstTimer = [...active.values()][0];
            service.debouncedSync('session-a', { sessionId: 'session-a' }, 'BACKLOG');

            assert.strictEqual(active.size, 1);
            assert.ok(firstTimer.cleared);
            await fire([...active.values()][0]);
            assert.deepStrictEqual(synced, ['session-a:BACKLOG']);
        });
    });
}

async function testRateLimitingAndRetry() {
    await withWorkspace('linear-rate-limiting', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'valid_token'
        });
        
        await writeJson(service._configPath, baseConfig());
        service._config = await service.loadConfig();
        
        // Test throttle enforcement
        let delayCalls = [];
        service.delay = async (ms) => { delayCalls.push(ms); };
        
        installHttpsMock((options, callback, resolve, reject) => {
            callback(200, JSON.stringify({ data: { issue: { id: '1' } } }));
        });
        
        // First call should not be delayed (elapsed > 50)
        await service.graphqlRequest('{ query }');
        assert.strictEqual(delayCalls.length, 0);
        
        // Second call should be delayed
        await service.graphqlRequest('{ query }');
        assert.strictEqual(delayCalls.length, 1);
        assert.ok(delayCalls[0] > 0 && delayCalls[0] <= 50, `Delay should be <= 50, got ${delayCalls[0]}`);

        // Test transient error retry
        let graphqlCalls = 0;
        service.graphqlRequest = async () => {
            graphqlCalls++;
            if (graphqlCalls === 1) throw new Error('socket hang up');
            return { data: 'success' };
        };
        
        delayCalls = [];
        const result = await service.retry(() => service.graphqlRequest());
        assert.deepStrictEqual(result, { data: 'success' });
        assert.strictEqual(graphqlCalls, 2);
        assert.strictEqual(delayCalls.length, 1);
        assert.ok(delayCalls[0] >= 1000 && delayCalls[0] <= 1400, `Backoff with jitter for first retry, got ${delayCalls[0]}`);

        // Test fast-fail on permanent error
        graphqlCalls = 0;
        service.graphqlRequest = async () => {
            graphqlCalls++;
            throw new Error('Linear API token not configured');
        };
        delayCalls = [];
        let errorCaught = false;
        try {
            await service.retry(() => service.graphqlRequest());
        } catch (e) {
            errorCaught = true;
            assert.strictEqual(e.message, 'Linear API token not configured');
        }
        assert.ok(errorCaught);
        assert.strictEqual(graphqlCalls, 1);
        assert.strictEqual(delayCalls.length, 0);
        
        // Test backoff cap
        graphqlCalls = 0;
        service.graphqlRequest = async () => {
            graphqlCalls++;
            throw new Error('ETIMEDOUT');
        };
        delayCalls = [];
        try {
            await service.retry(() => service.graphqlRequest(), 5);
        } catch (e) {}
        
        assert.strictEqual(graphqlCalls, 5);
        assert.strictEqual(delayCalls.length, 4);
        assert.ok(delayCalls[3] >= 5000 && delayCalls[3] <= 5400, `Backoff capped at 5000 + jitter, got ${delayCalls[3]}`);
    });
}

async function run() {
    await testConfigAndSyncMapPersistence();
    await testSetupAndSyncFallback();
    await testApplyConfigOptionsAndValidation();
    await testNativeQueryAndMutationHelpers();
    await testTeamWideIssueListQueriesUseFilterVariable();
    await testDetailQueryHelpers();
    await testDebouncedSyncAndUnmappedColumn();
    await testRateLimitingAndRetry();
    console.log('linear sync service test passed');
}

run().catch((error) => {
    console.error('linear sync service test failed:', error);
    process.exit(1);
});
