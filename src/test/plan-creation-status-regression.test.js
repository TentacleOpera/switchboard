'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
const providerSource = fs.readFileSync(providerPath, 'utf8');

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-plan-status-'));
    const workspaceId = 'ws-plan-status';
    const db = KanbanDatabase.forWorkspace(workspaceRoot);

    try {
        const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');
        await fs.promises.mkdir(plansDir, { recursive: true });

        const relativePlanFile = path.join('.switchboard', 'plans', 'active-relative.md').replace(/\\/g, '/');
        const absolutePlanFile = path.join(plansDir, 'active-absolute.md').replace(/\\/g, '/');
        const revivedPlanFile = path.join('.switchboard', 'plans', 'revived.md').replace(/\\/g, '/');
        const missingPlanFile = path.join('.switchboard', 'plans', 'missing.md').replace(/\\/g, '/');

        await fs.promises.writeFile(path.join(workspaceRoot, relativePlanFile), '# Active Relative\n');
        await fs.promises.writeFile(absolutePlanFile, '# Active Absolute\n');
        await fs.promises.writeFile(path.join(workspaceRoot, revivedPlanFile), '# Revived\n');

        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'Expected kanban DB to initialize.');

        const now = new Date().toISOString();
        const seedRecords = [
            {
                planId: 'sess-existing-relative',
                sessionId: 'sess-existing-relative',
                topic: 'Existing Relative',
                planFile: relativePlanFile,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: 'Unknown',
                tags: '',
                dependencies: '',
                workspaceId,
                createdAt: now,
                updatedAt: now,
                lastAction: 'created',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            },
            {
                planId: 'sess-existing-absolute',
                sessionId: 'sess-existing-absolute',
                topic: 'Existing Absolute',
                planFile: absolutePlanFile,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: 'Unknown',
                tags: '',
                dependencies: '',
                workspaceId,
                createdAt: now,
                updatedAt: now,
                lastAction: 'created',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            },
            {
                planId: 'sess-missing',
                sessionId: 'sess-missing',
                topic: 'Missing Plan',
                planFile: missingPlanFile,
                kanbanColumn: 'CREATED',
                status: 'active',
                complexity: 'Unknown',
                tags: '',
                dependencies: '',
                workspaceId,
                createdAt: now,
                updatedAt: now,
                lastAction: 'created',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            },
            {
                planId: 'sess-revived',
                sessionId: 'sess-revived',
                topic: 'Revived Plan',
                planFile: revivedPlanFile,
                kanbanColumn: 'BACKLOG',
                status: 'deleted',
                complexity: 'Unknown',
                tags: '',
                dependencies: '',
                workspaceId,
                createdAt: now,
                updatedAt: now,
                lastAction: 'deleted',
                sourceType: 'local',
                brainSourcePath: '',
                mirrorPath: '',
                routedTo: '',
                dispatchedAgent: '',
                dispatchedIde: ''
            }
        ];

        const seeded = await db.upsertPlans(seedRecords);
        assert.strictEqual(seeded, true, 'Expected seed records to upsert successfully.');

        const purged = await db.purgeOrphanedPlans(workspaceId, (planFile) => path.resolve(workspaceRoot, planFile));
        assert.strictEqual(purged, 1, 'Expected only the genuinely missing plan file to be tombstoned.');

        const relativePlan = await db.getPlanBySessionId('sess-existing-relative');
        const absolutePlan = await db.getPlanBySessionId('sess-existing-absolute');
        const missingPlan = await db.getPlanBySessionId('sess-missing');

        assert.strictEqual(relativePlan?.status, 'active', 'Expected relative plan file to remain active after orphan purge.');
        assert.strictEqual(absolutePlan?.status, 'active', 'Expected absolute plan file to remain active after orphan purge.');
        assert.strictEqual(missingPlan?.status, 'deleted', 'Expected missing plan file to be tombstoned by orphan purge.');

        const revived = await db.upsertPlans([{
            ...seedRecords[3],
            kanbanColumn: 'PLAN REVIEWED',
            status: 'active',
            updatedAt: new Date(Date.now() + 1000).toISOString(),
            lastAction: 'created'
        }]);
        assert.strictEqual(revived, true, 'Expected re-imported tombstoned plan to upsert successfully.');

        const revivedPlan = await db.getPlanBySessionId('sess-revived');
        assert.strictEqual(revivedPlan?.status, 'active', 'Expected re-imported tombstoned plan to revive back to active.');
        assert.strictEqual(revivedPlan?.kanbanColumn, 'PLAN REVIEWED', 'Expected re-imported tombstoned plan to restore its kanban column.');

        assert.match(
            providerSource,
            /const existingDbRow = db \? await db\.getPlanBySessionId\(sessionId\) : null;[\s\S]*const existingDbPlanFile = typeof existingDbRow\?\.planFile === 'string'[\s\S]*existingDbPlanFile !== normalizedPlanFileRelative[\s\S]*existingDbPlanFile !== absolutePlanFile;/,
            'Expected _handlePlanCreation to allocate a fresh session id when state.json collides with a different DB plan file.'
        );

        assert.match(
            providerSource,
            /db\.purgeOrphanedPlans\(workspaceId, \(planFile: string\) => \{[\s\S]*return path\.resolve\(workspaceRoot, planFile\);[\s\S]*\}\);/,
            'Expected kanban sync to resolve plan paths from workspaceRoot before orphan purging.'
        );

        console.log('plan creation status regression test passed');
    } finally {
        await KanbanDatabase.invalidateWorkspace(workspaceRoot);
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('plan creation status regression test failed:', error);
    process.exit(1);
});
