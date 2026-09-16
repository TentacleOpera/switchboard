'use strict';

/**
 * Contract tests for the no-refusal board (V81, "The Board Never Refuses a
 * Dispatch"):
 * - the release endpoints and the in-flight predicates are GONE
 * - no handler in LocalApiServer returns HTTP 409 for board-state reasons
 * - the dispatch write is unconditional (no owner_seat claim)
 * - a `checkpoint` event verb exists and is never read by a gate
 *
 * This file replaced the team-release control contract: release ceased to
 * exist as a concept — there is nothing to release from.
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const Database = require(path.join(process.cwd(), 'node_modules', 'better-sqlite3'));

const SRC = path.join(process.cwd(), 'src');
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8');

const localApiServer = read('services/LocalApiServer.ts');
const kanbanDatabase = read('services/KanbanDatabase.ts');
const kanbanProvider = read('services/KanbanProvider.ts');
const verbSchemas = read('services/verbSchemas.ts');

// The columns V81 drops. A database that has reached V81 does not carry them,
// so a migration test must re-add them and rewind the stamped version.
const V81_DOOMED_PLAN_COLS = ['routed_to', 'dispatched_agent', 'dispatched_ide',
    'dispatched_terminal', 'dispatched_at', 'queue_position', 'released_at',
    'outcome', 'workflow', 'last_liveness_at', 'blocked_at'];
const V81_DOOMED_RUNTIME_COLS = ['dispatched_terminal', 'dispatched_at', 'last_liveness_at', 'blocked_at'];

/**
 * Rewind a database file to a pre-V81 shape: re-add the doomed columns, seed
 * cards that carry doomed values, and stamp version 80 so V81 re-runs on the
 * next open.
 */
function rewindToV80(dbPath, wsId, { dropRuntime = false } = {}) {
    const raw = new Database(dbPath);
    try {
        for (const c of V81_DOOMED_PLAN_COLS) {
            try { raw.exec(`ALTER TABLE plans ADD COLUMN ${c} TEXT DEFAULT NULL`); } catch { /* already present */ }
        }
        if (dropRuntime) {
            raw.exec('DROP TABLE IF EXISTS plan_runtime_state');
        } else {
            for (const c of V81_DOOMED_RUNTIME_COLS) {
                try { raw.exec(`ALTER TABLE plan_runtime_state ADD COLUMN ${c} TEXT DEFAULT NULL`); } catch { /* already present */ }
            }
        }
        const now = '2026-01-01T00:00:00.000Z';
        const ins = raw.prepare(
            `INSERT INTO plans (plan_id, session_id, topic, plan_file, kanban_column, status, workspace_id, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`
        );
        for (const [id, col] of [['held', 'CODER CODED'], ['done', 'COMPLETED'], ['orphan', 'CREATED'], ['clean', 'CREATED']]) {
            ins.run(id, `${id}-sess`, id, `.switchboard/plans/${id}.md`, col, wsId, now, now);
        }
        raw.exec("UPDATE plans SET dispatched_terminal='Coder 1', released_at='2026-02-02', outcome='shipped', workflow='w', queue_position=5 WHERE plan_id='held'");
        raw.exec("UPDATE plans SET released_at='2026-03-03', outcome='done', completed_at='2026-03-03' WHERE plan_id='done'");
        raw.exec("UPDATE plans SET outcome='parked' WHERE plan_id='orphan'");
        if (!dropRuntime) {
            raw.prepare(
                `INSERT INTO plan_runtime_state (plan_id, device_id, workspace_id, dispatched_terminal, dispatched_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?)`
            ).run('held', 'dev-x', wsId, 'Coder 2', '2026-02-02T00:00:00Z', now);
        }
        raw.prepare("UPDATE migration_meta SET value='80' WHERE key='kanban_db_migration_version'").run();
    } finally {
        raw.close();
    }
}

function assertV81Applied(db, { expectedOwnerSeat, expectQueuePositionFolded }) {
    const cols = db.getDriver().all('PRAGMA table_info(plans)').map(c => c.name);
    for (const c of V81_DOOMED_PLAN_COLS) {
        assert.ok(!cols.includes(c), `${c} must be dropped from plans by V81`);
    }
    assert.ok(cols.includes('owner_seat') && cols.includes('owner_since'), 'owner_seat/owner_since must exist');
    assert.ok(cols.includes('column_order'), 'column_order is the single surviving ordering');

    const held = db.getDriver().all("SELECT owner_seat, column_order, completed_at FROM plans WHERE plan_id='held'")[0];
    assert.strictEqual(String(held.owner_seat), expectedOwnerSeat,
        'owner_seat must be backfilled from the dispatch record');
    if (expectQueuePositionFolded) {
        assert.strictEqual(Number(held.column_order), 5, 'queue_position must fold into column_order');
    }

    const events = db.getDriver().all("SELECT plan_id FROM plan_events WHERE event_type='state-migrated-v81'");
    const ids = new Set(events.map(e => String(e.plan_id)));
    assert.strictEqual(events.length, 3,
        'one state-migrated-v81 event per affected card (held, done, orphan — not the clean card)');
    for (const id of ['held', 'done', 'orphan']) {
        assert.ok(ids.has(id), `state-migrated-v81 must cover '${id}'`);
    }
    assert.ok(!ids.has('clean'), 'a card carrying no doomed field is not affected and gets no event');
}

let failures = 0;
async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

async function main() {
    console.log('team-release-control (now: no-refusal) contract tests');

    await check('heldByTeam and resolveTeamInFlight do not exist', () => {
        assert.strictEqual(/\bheldByTeam\b/.test(localApiServer), false, 'heldByTeam must be deleted');
        assert.strictEqual(/\bresolveTeamInFlight\b/.test(localApiServer), false, 'resolveTeamInFlight must be deleted');
    });

    await check('release endpoints and releaseCardInternal are deleted', () => {
        assert.strictEqual(localApiServer.includes('/kanban/card/release'), false, 'card/release route must be absent');
        assert.strictEqual(localApiServer.includes('/kanban/team/release'), false, 'team/release route must be absent');
        assert.strictEqual(/\breleaseCardInternal\b/.test(localApiServer), false, 'releaseCardInternal must be deleted');
        // `releasedAt` (the record field) is gone outright. `released_at`
        // (the SQL column) survives ONLY inside historical migration bodies —
        // the V77 ALTER that created it and the V81 backfill that reads it
        // before dropping. Assert every occurrence sits inside one of those.
        assert.strictEqual(/\breleasedAt\b/.test(kanbanDatabase), false, 'releasedAt record field must be gone');
        assert.strictEqual(/\breleasedAt\b/.test(localApiServer), false, 'releasedAt record field must be gone');
        const v81Start = kanbanDatabase.indexOf('_runMigrationV81');
        const lines = kanbanDatabase.split('\n');
        let offset = 0;
        lines.forEach((line, i) => {
            const lineStart = offset;
            offset += line.length + 1;
            if (!/\breleased_at\b/.test(line)) return;
            const inV81 = v81Start > 0 && lineStart >= v81Start;
            // A bare comment line is allowed only when it belongs to a comment
            // block headed by a migration marker (`// V77:`-style).
            let inMigrationComment = false;
            for (let j = i; j >= 0 && /^\s*\/\//.test(lines[j]); j--) {
                if (/^\s*\/\/\s*V\d{2}\b/.test(lines[j]) || /migrat/i.test(lines[j])) { inMigrationComment = true; break; }
            }
            const isMigrationContext = /migrat|V\d{2}|ALTER|INSERT INTO plan_events|SELECT|UPDATE|DROP COLUMN|state-migrated/i.test(line);
            assert.ok(inV81 || isMigrationContext || inMigrationComment, `released_at outside migration code at line ${i + 1}: ${line.trim()}`);
        });
    });

    await check('no handler returns HTTP 409', () => {
        // 409 is reserved for write-validation conflicts (version races,
        // ambiguous close sets, shutdown flush), which are allowed; assert none
        // of them sits inside the dispatch or queue-pop code paths.
        const releaseArm = /pathname\s*===?\s*'\/kanban\/(?:card|team)\/release'/.test(localApiServer);
        assert.strictEqual(releaseArm, false);
        for (const fn of ['performKanbanDispatch', '_runQueuePop', '_runQueueDone']) {
            const start = localApiServer.indexOf(fn);
            assert.notStrictEqual(start, -1, `${fn} must exist`);
            const next = localApiServer.indexOf('\n    private ', start + 1);
            const body = localApiServer.slice(start, next === -1 ? undefined : next);
            assert.strictEqual(/writeHead\(409/.test(body), false, `${fn} must not write 409`);
        }
    });

    await check('the dispatch write carries no owner_seat claim', () => {
        const fnStart = kanbanDatabase.indexOf('public async updateDispatchInfoByPlanFile(');
        assert.notStrictEqual(fnStart, -1, 'updateDispatchInfoByPlanFile must exist');
        const fnEnd = kanbanDatabase.indexOf('\n    /**', fnStart);
        const body = kanbanDatabase.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
        assert.strictEqual(/WHERE\s+[^;]*owner_seat\s+IS\s+NULL/i.test(body), false,
            'a conditional claim is a refusal wearing a different hat');
        assert.ok(/completed_at\s*=\s*NULL/i.test(body), 'dispatch must reset completed_at unconditionally');
        assert.ok(/owner_seat/.test(body) && /owner_since/.test(body), 'dispatch must stamp owner_seat + owner_since');
    });

    await check('checkpoint is a plan_events event type, never a column', () => {
        const freshPlansDdl = (kanbanDatabase.match(/CREATE TABLE IF NOT EXISTS plans \([\s\S]*?\)/) || [''])[0];
        assert.strictEqual(/\bcheckpoint\b/.test(freshPlansDdl), false, 'checkpoint must not be a plans column');
        assert.ok(/'checkpoint'/.test(verbSchemas) || /\bcheckpoint:\s*\{/.test(verbSchemas), 'checkpoint verb schema must exist');
        assert.ok(/case 'checkpoint'/.test(kanbanProvider), 'checkpoint provider arm must exist');
        assert.ok(/appendCheckpointEvent/.test(kanbanDatabase), 'checkpoint write must exist');
    });

    // ── The migration itself (V77/V80 → V81) ─────────────────────────────
    // The drops are only real for a database that SHIPPED with the columns. A
    // fresh DB never had them, so this rewinds a real file to a pre-V81 shape
    // and proves V81 backfills owner_seat, preserves the doomed values as
    // `state-migrated-v81` events (one per affected card, count asserted), and
    // then drops the columns.

    await check('V81 migrates a pre-V81 board: owner_seat backfilled, one event per affected card, columns dropped', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-v81-mig-'));
        try {
            await fs.promises.mkdir(path.join(root, '.switchboard'), { recursive: true });
            const db = KanbanDatabase.forWorkspace(root);
            await db.createIfMissing();
            const wsId = (await db.getWorkspaceId()) || '';
            const boardPath = db.dbPath;
            db.dispose();

            rewindToV80(boardPath, wsId, { dropRuntime: false });

            const migrated = KanbanDatabase.forWorkspace(root);
            assert.strictEqual(await migrated.ensureReady(), true, 'the rewound board must open');
            // The runtime dispatched_terminal wins over the plans copy (the
            // runtime row is the live record).
            assertV81Applied(migrated, { expectedOwnerSeat: 'Coder 2', expectQueuePositionFolded: true });
            await KanbanDatabase.invalidateWorkspace(root);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    await check('V81 migrates from plans directly when there is no runtime dispatch column (pre-V74 shape)', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-v81-mig-pre74-'));
        try {
            await fs.promises.mkdir(path.join(root, '.switchboard'), { recursive: true });
            const db = KanbanDatabase.forWorkspace(root);
            await db.createIfMissing();
            const wsId = (await db.getWorkspaceId()) || '';
            const boardPath = db.dbPath;
            db.dispose();

            rewindToV80(boardPath, wsId, { dropRuntime: true });

            const migrated = KanbanDatabase.forWorkspace(root);
            assert.strictEqual(await migrated.ensureReady(), true, 'the rewound board must open');
            assertV81Applied(migrated, { expectedOwnerSeat: 'Coder 1', expectQueuePositionFolded: true });
            await KanbanDatabase.invalidateWorkspace(root);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    await check('kanban-archive.db migrates to V81 and stays readable', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-v81-archive-'));
        try {
            await fs.promises.mkdir(path.join(root, '.switchboard'), { recursive: true });
            // A board must exist so the archive path resolves consistently.
            const board = KanbanDatabase.forWorkspace(root);
            await board.createIfMissing();
            const wsId = (await board.getWorkspaceId()) || '';
            board.dispose();

            const cold = KanbanDatabase.getArchiveInstance(root);
            await cold.createIfMissing();
            const archivePath = cold.dbPath;
            cold.dispose();

            rewindToV80(archivePath, wsId, { dropRuntime: false });

            const cold2 = KanbanDatabase.getArchiveInstance(root);
            assert.strictEqual(await cold2.ensureReady(), true, 'the rewound archive must open');
            assertV81Applied(cold2, { expectedOwnerSeat: 'Coder 2', expectQueuePositionFolded: true });
            // Stays readable: a plan read resolves the row after the drops.
            const rec = await cold2.getPlanByPlanId('held');
            assert.ok(rec, 'the archived row is still readable after V81');
            assert.strictEqual(rec.ownerSeat, 'Coder 2', 'the advisory owner survives on the archive');
            cold2.dispose();
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    // ── The dispatch write resets state and keeps history ────────────────

    await check('re-dispatching a completed card resets completed_at and appends history', async () => {
        const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-v81-reset-'));
        try {
            await fs.promises.mkdir(path.join(root, '.switchboard'), { recursive: true });
            const db = KanbanDatabase.forWorkspace(root);
            await db.createIfMissing();
            const wsId = (await db.getWorkspaceId()) || '';
            const planFile = '.switchboard/plans/re-dispatch.md';
            await db.upsertPlans([{
                planId: 're-dispatch', sessionId: 're-dispatch-sess', topic: 're-dispatch',
                planFile, kanbanColumn: 'CODER CODED', status: 'active', complexity: 'Unknown',
                tags: '', repoScope: '', project: '', workspaceId: wsId,
                createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
                lastAction: 'created', sourceType: 'local', brainSourcePath: '', mirrorPath: '',
                completedAt: '2026-01-02T00:00:00.000Z',
            }]);

            const ok = await db.updateDispatchInfoByPlanFile(planFile, wsId, {
                ownerSeat: 'Coder 1', dispatchedAgent: 'agent-x', dispatchedIde: 'ide-y',
            });
            assert.strictEqual(ok, true, 'the dispatch write must succeed');

            const row = db.getDriver().all(
                "SELECT owner_seat, completed_at FROM plans WHERE plan_id='re-dispatch'"
            )[0];
            assert.strictEqual(String(row.owner_seat), 'Coder 1', 'the dispatch stamps the advisory owner');
            assert.strictEqual(row.completed_at, null,
                'a new dispatch must reset completed_at so a prior completion cannot survive');
            const events = db.getDriver().all(
                "SELECT event_type FROM plan_events WHERE plan_id='re-dispatch' AND event_type='dispatched'"
            );
            assert.ok(events.length >= 1, 'the dispatch appends a dispatched event — history is never deleted');
            await KanbanDatabase.invalidateWorkspace(root);
        } finally {
            await fs.promises.rm(root, { recursive: true, force: true });
        }
    });

    if (failures > 0) {
        console.log(`\n${failures} check(s) failed`);
        process.exit(1);
    }
    console.log('\nAll checks passed');
}

main().catch(err => { console.error(err); process.exit(1); });
