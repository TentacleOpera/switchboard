import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { KanbanDatabase } from '../services/KanbanDatabase';

suite('KanbanDatabase.resolvePlanByAnyId', () => {
    let tempDir: string;
    let db: KanbanDatabase;
    const workspaceId = 'resolve-test-ws';

    setup(async () => {
        tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-resolve-any-id-'));
        db = KanbanDatabase.forWorkspace(tempDir);
        await db.createIfMissing();
        await db.ensureReady();
        await db.setWorkspaceId(workspaceId);
    });

    teardown(async () => {
        db.dispose();
        await KanbanDatabase.invalidateWorkspace(tempDir);
        await fs.promises.rm(tempDir, { recursive: true, force: true });
    });

    const now = () => new Date().toISOString();

    const makeRecord = (opts: {
        planId: string;
        sessionId: string;
        topic: string;
        planFile: string;
    }) => ({
        planId: opts.planId,
        sessionId: opts.sessionId,
        topic: opts.topic,
        planFile: opts.planFile,
        kanbanColumn: 'CREATED' as any,
        status: 'active' as any,
        complexity: '1',
        tags: '',
        repoScope: '',
        workspaceId,
        createdAt: now(),
        updatedAt: now(),
        lastAction: 'created',
        sourceType: 'local' as any,
        brainSourcePath: '',
        mirrorPath: '',
        routedTo: '',
        dispatchedAgent: '',
        dispatchedIde: ''
    });

    test('resolves a modern row by plan_id', async function () {
        this.timeout(5000);
        await db.upsertPlans([makeRecord({
            planId: 'plan-modern-1',
            sessionId: '',
            topic: 'Modern Row',
            planFile: '.switchboard/plans/modern-1.md'
        })]);

        const plan = await db.resolvePlanByAnyId('plan-modern-1');
        assert.ok(plan, 'should resolve modern row by plan_id');
        assert.strictEqual(plan!.topic, 'Modern Row');
        assert.strictEqual(plan!.planId, 'plan-modern-1');
    });

    test('resolves a legacy row whose only match is session_id', async function () {
        this.timeout(5000);
        // Legacy row: empty plan_id, session_id is the only key that can match.
        await db.upsertPlans([makeRecord({
            planId: '',
            sessionId: 'sess_legacy_x',
            topic: 'Legacy Row',
            planFile: '.switchboard/plans/legacy-1.md'
        })]);

        const plan = await db.resolvePlanByAnyId('sess_legacy_x');
        assert.ok(plan, 'should resolve legacy row by session_id fallback');
        assert.strictEqual(plan!.topic, 'Legacy Row');
        assert.strictEqual(plan!.sessionId, 'sess_legacy_x');
    });

    test('plan_id wins over a colliding session_id', async function () {
        this.timeout(5000);
        // Two rows: row A has plan_id = 'shared', row B has session_id = 'shared'.
        // The resolver must return row A (plan_id-first precedence).
        await db.upsertPlans([makeRecord({
            planId: 'shared',
            sessionId: 'sess_a',
            topic: 'Plan-Id Row',
            planFile: '.switchboard/plans/shared-planid.md'
        })]);
        await db.upsertPlans([makeRecord({
            planId: '',
            sessionId: 'shared',
            topic: 'Session-Id Row',
            planFile: '.switchboard/plans/shared-sessionid.md'
        })]);

        const plan = await db.resolvePlanByAnyId('shared');
        assert.ok(plan, 'should resolve the collision');
        assert.strictEqual(plan!.topic, 'Plan-Id Row', 'plan_id match must win over session_id match');
    });

    test('returns null for empty string', async function () {
        this.timeout(5000);
        await db.upsertPlans([makeRecord({
            planId: '',
            sessionId: '',
            topic: 'Watcher Row',
            planFile: '.switchboard/plans/watcher-1.md'
        })]);

        const plan = await db.resolvePlanByAnyId('');
        assert.strictEqual(plan, null, "empty id must not match a watcher-imported row");
    });

    test('returns null for whitespace-only ids', async function () {
        this.timeout(5000);
        await db.upsertPlans([makeRecord({
            planId: '',
            sessionId: '',
            topic: 'Watcher Row',
            planFile: '.switchboard/plans/watcher-2.md'
        })]);

        for (const blank of [' ', '   ', '\t', '\n']) {
            const plan = await db.resolvePlanByAnyId(blank);
            assert.strictEqual(plan, null, `whitespace-only id ${JSON.stringify(blank)} must not match`);
        }
    });

    test('returns null for an unknown id', async function () {
        this.timeout(5000);
        const plan = await db.resolvePlanByAnyId('does-not-exist');
        assert.strictEqual(plan, null, 'unknown id should resolve to null');
    });
});
