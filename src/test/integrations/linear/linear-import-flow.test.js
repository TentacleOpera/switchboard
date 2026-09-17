'use strict';

const assert = require('assert');
const fs = require('fs');
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
            pullIntervalMinutes: 60,
            excludeBacklog: false
        });
        const normalizedConfig = await service.loadConfig();
        assert.deepStrictEqual(normalizedConfig.automationRules, []);
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

            const issuesRequest = http.requests.find((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
            );
            assert.ok(issuesRequest, 'Expected Linear import flow to query issues.');
            assert.match(
                String(issuesRequest.jsonBody?.query || ''),
                /query\(\$filter: IssueFilter!, \$after: String\)/,
                'Expected team-wide Linear import flow to use a single IssueFilter GraphQL variable.'
            );
            assert.doesNotMatch(
                String(issuesRequest.jsonBody?.query || ''),
                /\$teamId|\$projectId/,
                'Expected team-wide Linear import flow not to declare separate teamId/projectId variables.'
            );
            assert.deepStrictEqual(issuesRequest.jsonBody?.variables?.filter, {
                team: { id: { eq: 'team-1' } }
            });
            assert.strictEqual(
                Object.prototype.hasOwnProperty.call(issuesRequest.jsonBody?.variables?.filter || {}, 'project'),
                false,
                'Expected team-wide Linear import flow not to send a project filter.'
            );

            // A top-level parent with sub-issues imports as a FEATURE, not a plan:
            // it lands in .switchboard/features/ as
            // linear_import_<issueId>_<uuid>.md, where the uuid is the feature's
            // planId — minted per import, so it cannot be spelled out here. Its
            // sub-issues stay in plansDir as ordinary plans, and an issue with no
            // children imports as a normal plan too. This test used to look for
            // the parent in plansDir, which is the pre-feature layout.
            const featuresDir = path.join(workspaceRoot, '.switchboard', 'features');
            const featureFiles = fs.readdirSync(featuresDir)
                .filter((name) => /^linear_import_issue-parent_.+\.md$/.test(name));
            assert.strictEqual(
                featureFiles.length,
                1,
                `Expected the parent issue to import as exactly one feature file, got ${JSON.stringify(featureFiles)}.`
            );
            assert.ok(
                !fs.existsSync(path.join(plansDir, 'linear_import_issue-parent.md')),
                'Expected a parent with sub-issues NOT to be written to the plans directory — it is a feature.'
            );
            // Only the parent becomes a feature: a childless issue is a normal plan.
            assert.deepStrictEqual(
                fs.readdirSync(featuresDir).filter((name) => name.endsWith('.md')).sort(),
                featureFiles.sort(),
                'Expected only the parent issue to be imported as a feature.'
            );

            const parentContent = readText(path.join(featuresDir, featureFiles[0]));
            const childContent = readText(path.join(plansDir, 'linear_import_issue-child.md'));
            const backlogContent = readText(path.join(plansDir, 'linear_import_issue-backlog.md'));

            // The subtask is bound to that feature by planId, and the feature's
            // planId is the uuid in its filename. Asserting they match is what
            // pins "parents become features, their sub-issues become subtasks" —
            // two files existing in the right directories does not.
            const featureUuid = featureFiles[0].replace(/^linear_import_issue-parent_/, '').replace(/\.md$/, '');
            assert.match(
                childContent,
                new RegExp(`> \\*\\*Feature Plan ID:\\*\\* ${featureUuid}\\b`),
                'Expected the sub-issue to carry its parent feature\'s plan ID.'
            );

            assert.ok(!parentContent.includes('## Linear Issue Notes'));
            assert.ok(!parentContent.includes('**Sub-issues (each imported as a separate plan):**'));
            assert.ok(!parentContent.includes('**Comments:**'));
            assert.ok(!parentContent.includes('**Attachments:**'));
            assert.ok(!parentContent.includes('## Goal'));
            assert.ok(!parentContent.includes('## Proposed Changes'));
            assert.ok(!parentContent.includes('TODO'));

            assert.ok(childContent.includes('> **Parent Issue:** Parent Issue (ENG-101)'));
            assert.ok(!childContent.includes('## Goal'));
            assert.ok(!childContent.includes('## Proposed Changes'));
            assert.ok(!childContent.includes('TODO'));
        } finally {
            http.restore();
        }
    });

    await withWorkspace('linear-import-project-scoped', async ({ workspaceRoot }) => {
        const { service } = createContext(workspaceRoot, {
            'switchboard.linear.apiToken': 'lin_api_import_project'
        });
        await service.saveConfig({
            teamId: 'team-1',
            teamName: 'Engineering',
            includeProjectNames: ['Acme Project'],
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

        const scopedIssue = {
            ...loadFixtureJson('linear', 'issue-sample.json'),
            children: { nodes: [] },
            comments: { nodes: [] },
            attachments: { nodes: [] }
        };

        const http = installHttpsMock();
        try {
            service.delay = async () => {};
            // Queue projects list resolution first
            http.queueJson(200, {
                data: {
                    team: {
                        projects: {
                            nodes: [
                                { id: 'project-1', name: 'Acme Project' }
                            ]
                        }
                    }
                }
            });
            // Queue issues response second
            http.queueJson(200, {
                data: {
                    issues: {
                        nodes: [scopedIssue],
                        pageInfo: { hasNextPage: false, endCursor: null }
                    }
                }
            });

            const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
            const result = await service.importIssuesFromLinear(plansDir);
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.imported, 1);

            const issuesRequest = http.requests.find((req) =>
                req.method === 'POST'
                && req.path === '/graphql'
                && String(req.jsonBody?.query || '').includes('issues(')
            );
            assert.ok(issuesRequest, 'Expected project-scoped Linear import flow to query issues.');
            assert.match(
                String(issuesRequest.jsonBody?.query || ''),
                /query\(\$filter: IssueFilter!, \$after: String\)/,
                'Expected project-scoped Linear import flow to use a single IssueFilter GraphQL variable.'
            );
            assert.doesNotMatch(
                String(issuesRequest.jsonBody?.query || ''),
                /\$teamId|\$projectId/,
                'Expected project-scoped Linear import flow not to declare separate teamId/projectId variables.'
            );
            assert.deepStrictEqual(issuesRequest.jsonBody?.variables?.filter, {
                team: { id: { eq: 'team-1' } },
                project: { id: { eq: 'project-1' } }
            });
        } finally {
            http.restore();
        }
    });

    const providerSource = fs.readFileSync(
        path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'),
        'utf8'
    );
    assert.match(
        providerSource,
        /private async _createInitiatedPlan\(\s*title: string,\s*idea: string,\s*isAirlock: boolean,\s*options: \{\s*skipBrainPromotion\?: boolean;\s*suppressIntegrationSync\?: boolean;[\s\S]*?\} = \{\}\s*\)/s,
        'Expected _createInitiatedPlan() to support suppressIntegrationSync for imported Linear tasks.'
    );
    assert.match(
        providerSource,
        /await this\._createInitiatedPlan\([\s\S]*?suppressIntegrationSync: true[\s\S]*?await linearService\.setIssueIdForPlan\(planFileRelative, node\.issue\.id\);[\s\S]*?await db\.updateLinearIssueIdByPlanFile\(planFileAbsolute, workspaceId, node\.issue\.id\);/s,
        'Expected imported Linear plans to link both the sync map and DB before follow-up sync runs.'
    );
    // Imported sub-issues link to their feature through `feature_id` — the same
    // mechanism importIssuesFromLinear uses, so one board does not get two answers.
    // This replaces an assertion on `db.updateDependenciesByPlanFile(...)`, a method
    // removed in b28edff8 and never replaced; while it was missing, every sub-issue
    // imported through linearImportTask landed flat and unparented. The BEHAVIOUR is
    // covered by `npm run test:contract:linear-import-feature-shape`; this only pins
    // that the single-issue importer still links at all.
    assert.match(
        providerSource,
        /updateFeatureStatus\(planId, 0, featurePlanId\)/s,
        'Expected imported Linear sub-issues to be linked to their feature via feature_id.'
    );
    assert.match(
        providerSource,
        /await this\._kanbanProvider\?\.queueIntegrationSyncForPlanFile\(effectiveRoot, planFile, 'CREATED'\);/s,
        'Expected Linear imports to defer outbound sync until every imported session is linked locally.'
    );

    console.log('linear import flow test passed');
}

run().catch((error) => {
    console.error('linear import flow test failed:', error);
    process.exit(1);
});
