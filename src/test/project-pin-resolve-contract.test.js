'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-project-pin-resolve-'));
    const db = KanbanDatabase.forWorkspace(workspaceRoot);

    // KanbanDatabase deliberately never auto-creates kanban.db (scaffold-litter
    // policy) — seed an empty file exactly as bootstrap does.
    const dbDir = path.dirname(db.dbPath);
    if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
    if (!fs.existsSync(db.dbPath)) fs.writeFileSync(db.dbPath, Buffer.alloc(0));

    try {
        const ready = await db.ensureReady();
        assert.strictEqual(ready, true, 'kanban DB should initialize');

        const wsId = 'ws-resolve-test';
        const now = new Date().toISOString();

        await db.addProject(wsId, 'Contract Project');

        const rec = {
            planId: 'plan-1',
            sessionId: 'sess-1',
            topic: 'Plan 1',
            planFile: '.switchboard/plans/plan-1.md',
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            workspaceId: wsId,
            createdAt: now,
            updatedAt: now,
            lastAction: '',
            sourceType: 'local',
            project: 'Contract Project',
            projectId: null
        };

        // 1. Healthy path: TS lookup resolves, first insert lands assigned.
        await db.insertFileDerivedPlan(rec);
        let row1 = await db.getPlanByPlanId(rec.planId);
        assert.strictEqual(row1.project, 'Contract Project');
        assert.ok(row1.projectId != null, 'project name stored with null project_id — strands the card on both filter paths');

        // 2. Same-snapshot fallback: statement-level resolution with a null bound id.
        const originalResolve = db._resolveProjectForInsert;
        db._resolveProjectForInsert = async function(record, isExisting) {
            return { project: '', projectId: null };
        };

        const rec2 = {
            planId: 'plan-2',
            sessionId: 'sess-2',
            topic: 'Plan 2',
            planFile: '.switchboard/plans/plan-2.md',
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            workspaceId: wsId,
            createdAt: now,
            updatedAt: now,
            lastAction: '',
            sourceType: 'local',
            project: 'Contract Project',
            projectId: null
        };

        await db.insertFileDerivedPlan(rec2);
        let row2 = await db.getPlanByPlanId(rec2.planId);
        assert.strictEqual(row2.project, 'Contract Project', 'fallback statement-level resolution failed');
        assert.ok(row2.projectId != null, 'fallback project name stored with null project_id');

        // Restore original method
        db._resolveProjectForInsert = originalResolve;

        // 3. Resolve-only survives the fix: phantom project pin does not create projects.
        const rec3 = {
            planId: 'plan-3',
            sessionId: 'sess-3',
            topic: 'Plan 3',
            planFile: '.switchboard/plans/plan-3.md',
            kanbanColumn: 'CREATED',
            status: 'active',
            complexity: 'Unknown',
            tags: '',
            workspaceId: wsId,
            createdAt: now,
            updatedAt: now,
            lastAction: '',
            sourceType: 'local',
            project: 'Phantom Project',
            projectId: null
        };
        await db.insertFileDerivedPlan(rec3);
        let row3 = await db.getPlanByPlanId(rec3.planId);
        assert.strictEqual(row3.project, '');
        assert.strictEqual(await db.getProjectIdByName(wsId, 'Phantom Project'), null, 'resolve-only broken: pin minted a projects row');

        // 4. Stranded state is unrepresentable: non-empty name always has an id.
        const stmt = db._db.prepare('SELECT plan_id FROM plans WHERE project <> \'\' AND project_id IS NULL');
        const stranded = [];
        try {
            while (stmt.step()) {
                stranded.push(stmt.getAsObject().plan_id);
            }
        } finally {
            stmt.free();
        }
        assert.strictEqual(stranded.length, 0, `${stranded.length} plans have a project name with no project_id`);

        console.log('project-pin-resolve contract test passed');
    } finally {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('project-pin-resolve contract test failed:', error);
    process.exit(1);
});
