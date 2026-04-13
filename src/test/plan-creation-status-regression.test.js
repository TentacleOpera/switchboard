'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { KanbanMigration } = require(path.join(process.cwd(), 'out', 'services', 'KanbanMigration.js'));

const providerPath = path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts');
const providerSource = fs.readFileSync(providerPath, 'utf8');
const migrationPath = path.join(process.cwd(), 'src', 'services', 'KanbanMigration.ts');
const migrationSource = fs.readFileSync(migrationPath, 'utf8');
const dbPath = path.join(process.cwd(), 'src', 'services', 'KanbanDatabase.ts');
const dbSource = fs.readFileSync(dbPath, 'utf8');

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
        const transientPlanFile = path.join('.switchboard', 'plans', 'transient-rewrite.md').replace(/\\/g, '/');
        const upsertRevivedPlanFile = path.join('.switchboard', 'plans', 'upsert-revived.md').replace(/\\/g, '/');

        await fs.promises.writeFile(path.join(workspaceRoot, relativePlanFile), '# Active Relative\n');
        await fs.promises.writeFile(absolutePlanFile, '# Active Absolute\n');
        await fs.promises.writeFile(path.join(workspaceRoot, revivedPlanFile), '# Revived\n');
        await fs.promises.writeFile(path.join(workspaceRoot, transientPlanFile), '# Transient Rewrite\n');
        await fs.promises.writeFile(path.join(workspaceRoot, upsertRevivedPlanFile), '# Upsert Revived\n');

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
            },
            {
                planId: 'sess-transient',
                sessionId: 'sess-transient',
                topic: 'Transient Rewrite',
                planFile: transientPlanFile,
                kanbanColumn: 'PLAN REVIEWED',
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
                planId: 'sess-transient-deleted',
                sessionId: 'sess-transient-deleted',
                topic: 'Transient Rewrite Deleted Duplicate',
                planFile: transientPlanFile,
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
            },
            {
                planId: 'sess-upsert-revive',
                sessionId: 'sess-upsert-revive',
                topic: 'Upsert Revive',
                planFile: upsertRevivedPlanFile,
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
        const preferredTransientPlan = await db.getPlanByPlanFile(transientPlanFile, workspaceId);

        assert.strictEqual(relativePlan?.status, 'active', 'Expected relative plan file to remain active after orphan purge.');
        assert.strictEqual(absolutePlan?.status, 'active', 'Expected absolute plan file to remain active after orphan purge.');
        assert.strictEqual(missingPlan?.status, 'deleted', 'Expected missing plan file to be tombstoned by orphan purge.');
        assert.strictEqual(
            preferredTransientPlan?.sessionId,
            'sess-transient',
            'Expected getPlanByPlanFile to prefer active plan rows over deleted duplicates for the same file.'
        );

        const upsertRevived = await db.upsertPlans([{
            planId: 'sess-upsert-revive',
            sessionId: 'sess-upsert-revive',
            topic: 'Upsert Revive',
            planFile: upsertRevivedPlanFile,
            kanbanColumn: 'BACKLOG',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            dependencies: '',
            workspaceId,
            createdAt: now,
            updatedAt: new Date(Date.now() + 500).toISOString(),
            lastAction: 'created',
            sourceType: 'local',
            brainSourcePath: '',
            mirrorPath: '',
            routedTo: '',
            dispatchedAgent: '',
            dispatchedIde: ''
        }]);
        assert.strictEqual(upsertRevived, true, 'Expected upsertPlans to succeed when reviving a deleted local row.');
        const upsertRevivedPlan = await db.getPlanBySessionId('sess-upsert-revive');
        assert.strictEqual(
            upsertRevivedPlan?.status,
            'active',
            'Expected active upserts for the same local plan to revive falsely deleted rows.'
        );

        await fs.promises.unlink(path.join(workspaceRoot, transientPlanFile));
        setTimeout(() => {
            void fs.promises.writeFile(path.join(workspaceRoot, transientPlanFile), '# Transient Rewrite Restored\n');
        }, 50);
        const transientPurged = await db.purgeOrphanedPlans(workspaceId, (planFile) => path.resolve(workspaceRoot, planFile));
        assert.strictEqual(transientPurged, 0, 'Expected confirmation delay to ignore a save-time transient disappearance.');
        const transientPlan = await db.getPlanBySessionId('sess-transient');
        assert.strictEqual(transientPlan?.status, 'active', 'Expected transiently missing plan to remain active after confirmation recheck.');

        const revived = await KanbanMigration.syncPlansMetadata(
            db,
            workspaceId,
            [{
                ...seedRecords[3],
                kanbanColumn: 'PLAN REVIEWED',
                updatedAt: new Date(Date.now() + 1000).toISOString(),
                lastAction: 'created'
            }]
        );
        assert.strictEqual(revived, true, 'Expected snapshot sync to revive tombstoned plans whose files reappear.');

        const revivedPlan = await db.getPlanBySessionId('sess-revived');
        assert.strictEqual(revivedPlan?.status, 'active', 'Expected snapshot sync to revive the tombstoned plan back to active.');
        assert.strictEqual(revivedPlan?.kanbanColumn, 'BACKLOG', 'Expected snapshot sync to preserve the existing kanban column while reviving status.');

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

        assert.match(
            providerSource,
            /await this\._reconcileOnDiskLocalPlanFiles\(workspaceRoot\);[\s\S]*const allSheets = await this\._getSessionLog\(workspaceRoot\)\.getRunSheets\(\);/s,
            'Expected full snapshot sync to reconcile on-disk local plan files before DB-backed run-sheet hydration.'
        );

        assert.match(
            providerSource,
            /private async _reviveDeletedLocalPlanForPath\([\s\S]*await db\.reviveDeletedPlans\(\[deletedEntry\.sessionId\]\);[\s\S]*await this\._registerPlan\(workspaceRoot, \{[\s\S]*planId: deletedEntry\.sessionId,[\s\S]*status: 'active'/s,
            'Expected deleted local plan repair to revive the DB row and restore active registry ownership for the same session.'
        );

        assert.match(
            providerSource,
            /await this\._reviveDeletedLocalPlanForPath\(resolvedWorkspaceRoot, relPath, uri\.fsPath\);[\s\S]*const plan = await db\.getPlanByPlanFile\(relPath, workspaceId\);/s,
            'Expected normal file-change sync to repair deleted local plan rows before title or metadata updates.'
        );

        assert.match(
            migrationSource,
            /if \(existingRow\?\.status === 'deleted'\) \{[\s\S]*deletedRowsToRevive\.add\(row\.sessionId\);[\s\S]*db\.reviveDeletedPlans\(\[\.\.\.deletedRowsToRevive\]\)/,
            'Expected snapshot sync to revive deleted rows when the same session reappears.'
        );

        assert.match(
            dbSource,
            /status = CASE[\s\S]*WHEN status = 'deleted' AND excluded\.status = 'active' THEN excluded\.status[\s\S]*ELSE status[\s\S]*END,/,
            'Expected plan upserts to heal false deleted->active local plan transitions when the same file is re-imported.'
        );

        assert.match(
            dbSource,
            /await delay\(ORPHAN_PURGE_CONFIRMATION_DELAY_MS\);[\s\S]*if \(!fs\.existsSync\(candidate\.absPath\)\) \{/,
            'Expected orphan purge to confirm missing files after a short delay before tombstoning.'
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
