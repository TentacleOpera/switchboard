'use strict';
/**
 * Contract: the SINGLE-ISSUE Linear importer produces the same shape as the bulk
 * importer — a parent with sub-issues becomes a FEATURE, its sub-issues become
 * that feature's subtasks, and a childless issue stays an ordinary plan.
 *
 * The regression this locks down: `_createImportedLinearPlan` threaded a
 * `parentPlanFile` argument down its recursion that NOTHING read. The call that
 * consumed it (`db.updateDependenciesByPlanFile`) was removed in b28edff8 and
 * never replaced, so every sub-issue imported through `linearImportTask` /
 * `linearImportAndSendToPlanner` landed flat and unparented while
 * `LinearSyncService.importIssuesFromLinear` — reached from the very same board —
 * built the parent/child structure correctly. Two importers, one board, two
 * different answers.
 *
 * Why the feature's planId is asserted against its FILENAME: a feature's id has
 * to survive a re-import, and the importer recovers it from the trailing uuid in
 * `.switchboard/features/<...>_<uuid>.md`. `_createInitiatedPlan` keys a local
 * plan by its file PATH, which cannot go in a filename — so the feature mints its
 * own uuid. If that ever regresses to a path-keyed id, the subtask links do not
 * survive and this assertion is what says so.
 *
 * Run with: npm run compile-tests && npm run test:contract:linear-import-feature-shape
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installPermissiveVscodeStub } = require('./helpers/verbEngineTestSeams');

const vscodeStub = installPermissiveVscodeStub();

const { TaskViewerProvider } = require('../../out/services/TaskViewerProvider');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');

// The ctor binds a real TCP port; this suite asserts on the import, not startup.
TaskViewerProvider.prototype._startLocalApiServer = async function () { /* no port binding in tests */ };

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ok  ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL  ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

function issue(id, identifier, title, extra = {}) {
    return {
        id,
        identifier,
        title,
        description: `Body of ${identifier}`,
        url: `https://linear.app/acme/issue/${identifier}`,
        priority: 3,
        state: { name: 'Backlog', type: 'backlog' },
        labels: { nodes: [] },
        createdAt: '2026-04-01T00:00:00.000Z',
        ...extra,
    };
}

/**
 * A Linear service stubbed at the four seams _loadLinearImportNode actually uses,
 * plus the link write. No HTTP: this suite is about the SHAPE the importer writes
 * to the board, not about the wire.
 */
function makeLinearStub(tree) {
    const issuesById = new Map();
    const childrenById = new Map();
    const walk = (node) => {
        issuesById.set(node.issue.id, node.issue);
        childrenById.set(node.issue.id, node.children.map((c) => c.issue));
        node.children.forEach(walk);
    };
    walk(tree);
    return {
        issueIdWrites: [],
        getIssue: async (id) => issuesById.get(id) || null,
        getSubtasks: async (id) => childrenById.get(id) || [],
        getComments: async () => [],
        getAttachments: async () => [],
        setIssueIdForPlan: async function (planFile, issueId) {
            this.issueIdWrites.push({ planFile, issueId });
        },
    };
}

function buildProvider(root, linearStub) {
    vscodeStub.setWorkspaceFolders([root]);
    const provider = new TaskViewerProvider(
        { fsPath: path.join(root, 'ext') },
        {
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
            subscriptions: [],
            extensionUri: { fsPath: path.join(__dirname, '..', '..') },
            secrets: null,
        },
        false
    );
    provider._getLinearService = () => linearStub;
    // The import's follow-up sync is not this contract's subject. The two root
    // resolvers are what _activateWorkspaceContext/_resolveWorkspaceRoot call.
    provider._kanbanProvider = {
        queueIntegrationSyncForPlanFile: async () => {},
        resolveAuthoringProject: async () => null,
        resolveEffectiveWorkspaceRoot: (r) => r || root,   // SYNCHRONOUS in the real provider
        getCurrentWorkspaceRoot: () => root,
    };
    provider._syncFilesAndRefreshRunSheets = async () => {};
    provider.postMessage = () => {};
    return provider;
}

async function main() {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-linear-import-shape-'));

    console.log('\n=== Linear single-issue import: feature shape ===\n');

    await test('a parent with sub-issues imports as a feature, and its sub-issues are that feature\'s subtasks', async () => {
        const root = path.join(tmpBase, 'ws-parent');
        fs.mkdirSync(path.join(root, '.switchboard'), { recursive: true });
        const db = KanbanDatabase.forWorkspace(root);
        await db.createIfMissing();
        await db.ensureReady();

        const tree = {
            issue: issue('ISSUE_PARENT', 'ENG-201', 'Parent Issue'),
            children: [
                { issue: issue('ISSUE_CHILD_A', 'ENG-202', 'Child A', { parent: { id: 'ISSUE_PARENT' } }), children: [] },
                { issue: issue('ISSUE_CHILD_B', 'ENG-203', 'Child B', { parent: { id: 'ISSUE_PARENT' } }), children: [] },
            ],
        };
        const provider = buildProvider(root, makeLinearStub(tree));
        const result = await provider.importLinearTask(root, 'ISSUE_PARENT', true, true);
        assert.strictEqual(result.success, true, `import failed: ${result.error}`);

        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();

        // The parent is a feature, and it lives where a feature lives. Both halves
        // matter: KanbanDatabase treats a file under .switchboard/features/ as
        // structurally a feature, so an is_feature row whose file sits in plans/ is
        // a state the guards in updateFeatureStatus do not expect.
        const featureFiles = fs.readdirSync(path.join(root, '.switchboard', 'features'));
        assert.strictEqual(featureFiles.length, 1, `expected one feature file, got ${JSON.stringify(featureFiles)}`);
        const featureRel = path.join('.switchboard', 'features', featureFiles[0]).replace(/\\/g, '/');
        const featureRow = await db.getPlanByPlanFile(featureRel, workspaceId);
        assert.ok(featureRow, `no plan row for the feature file ${featureRel}`);
        assert.strictEqual(featureRow.isFeature, 1, 'the parent issue must be marked is_feature');
        assert.strictEqual(featureRow.linearIssueId, 'ISSUE_PARENT', 'the feature must carry the parent issue id');

        // The planId is recoverable from the filename — that is what survives a
        // re-import, and it must not be the plan's file path.
        assert.ok(
            featureFiles[0].endsWith(`_${featureRow.planId}.md`),
            `feature filename ${featureFiles[0]} must end with its planId ${featureRow.planId}`
        );
        assert.ok(
            !featureRow.planId.includes('/'),
            `a feature planId must not be a file path, got "${featureRow.planId}"`
        );

        // Both sub-issues point at that feature.
        for (const childIssueId of ['ISSUE_CHILD_A', 'ISSUE_CHILD_B']) {
            const childRow = await db.findPlanByLinearIssueId(workspaceId, childIssueId);
            assert.ok(childRow, `no plan row for ${childIssueId}`);
            assert.strictEqual(
                childRow.featureId,
                featureRow.planId,
                `${childIssueId} must be a subtask of the imported feature`
            );
            assert.strictEqual(childRow.isFeature ? 1 : 0, 0, `${childIssueId} must not itself be a feature`);
            assert.ok(
                !childRow.planFile.startsWith('.switchboard/features/'),
                `${childIssueId} is a subtask and must stay out of the features directory`
            );
        }
    });

    await test('a childless issue imports as an ordinary plan, not a feature', async () => {
        const root = path.join(tmpBase, 'ws-standalone');
        fs.mkdirSync(path.join(root, '.switchboard'), { recursive: true });
        const db = KanbanDatabase.forWorkspace(root);
        await db.createIfMissing();
        await db.ensureReady();

        const tree = { issue: issue('ISSUE_ALONE', 'ENG-301', 'Standalone Issue'), children: [] };
        const provider = buildProvider(root, makeLinearStub(tree));
        const result = await provider.importLinearTask(root, 'ISSUE_ALONE', true, true);
        assert.strictEqual(result.success, true, `import failed: ${result.error}`);

        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
        const row = await db.findPlanByLinearIssueId(workspaceId, 'ISSUE_ALONE');
        assert.ok(row, 'no plan row for the standalone issue');
        assert.strictEqual(row.isFeature ? 1 : 0, 0, 'an issue with no sub-issues must not become a feature');
        assert.strictEqual(row.featureId || '', '', 'an issue with no parent must not be a subtask');

        const featuresDir = path.join(root, '.switchboard', 'features');
        const featureFiles = fs.existsSync(featuresDir) ? fs.readdirSync(featuresDir) : [];
        assert.deepStrictEqual(featureFiles, [], 'a childless import must write no feature file');
    });

    await test('a nested grandchild links to the top feature, not to its immediate parent', async () => {
        // Linear nesting is flattened to one level — the same rule
        // importIssuesFromLinear applies by walking the parent chain to the
        // top-level parent. An intermediate parent is a subtask, never a second
        // feature.
        const root = path.join(tmpBase, 'ws-nested');
        fs.mkdirSync(path.join(root, '.switchboard'), { recursive: true });
        const db = KanbanDatabase.forWorkspace(root);
        await db.createIfMissing();
        await db.ensureReady();

        const tree = {
            issue: issue('N_ROOT', 'ENG-401', 'Root'),
            children: [{
                issue: issue('N_MID', 'ENG-402', 'Middle', { parent: { id: 'N_ROOT' } }),
                children: [{ issue: issue('N_LEAF', 'ENG-403', 'Leaf', { parent: { id: 'N_MID' } }), children: [] }],
            }],
        };
        const provider = buildProvider(root, makeLinearStub(tree));
        const result = await provider.importLinearTask(root, 'N_ROOT', true, true);
        assert.strictEqual(result.success, true, `import failed: ${result.error}`);

        const workspaceId = await db.getWorkspaceId() || await db.getDominantWorkspaceId();
        const featureFiles = fs.readdirSync(path.join(root, '.switchboard', 'features'));
        assert.strictEqual(featureFiles.length, 1, `expected exactly one feature, got ${JSON.stringify(featureFiles)}`);
        const featureRel = path.join('.switchboard', 'features', featureFiles[0]).replace(/\\/g, '/');
        const featureRow = await db.getPlanByPlanFile(featureRel, workspaceId);

        const mid = await db.findPlanByLinearIssueId(workspaceId, 'N_MID');
        const leaf = await db.findPlanByLinearIssueId(workspaceId, 'N_LEAF');
        assert.ok(mid && leaf, 'nested rows missing');
        assert.strictEqual(mid.featureId, featureRow.planId, 'the intermediate issue must link to the top feature');
        assert.strictEqual(leaf.featureId, featureRow.planId, 'the grandchild must link to the TOP feature, flattened');
        assert.strictEqual(mid.isFeature ? 1 : 0, 0, 'an intermediate parent is a subtask, not a second feature');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
    console.log('linear import feature shape contract passed');
}

main().catch((e) => {
    console.error('linear import feature shape contract failed:', e);
    process.exit(1);
});
