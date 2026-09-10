'use strict';

/**
 * Imported ticket metadata as first-class shared board state.
 *
 * Pins `.switchboard/plans/ticket-metadata-as-first-class-board-state.md`.
 *
 * The bug this closes: a plan imported from Linear or ClickUp carried two opaque id
 * strings on its `plans` row, and everything else the provider said lived in
 * `.switchboard/tickets/`, which `.gitignore` excludes. A fresh clone kept the plan
 * and lost the ticket; a teammate never had it; a shared Board store could not carry
 * it. `plan_tickets` is the board's own record of what the provider said.
 *
 * The Goal Invariants from the plan, each asserted here:
 *  1. `plan_tickets` exists and is registered shared tier.
 *  2. An imported ticket's assignee/state/labels resolve from the Board store ALONE,
 *     with `.switchboard/tickets/` absent — clone survival, tested directly.
 *  3. `plans.linear_issue_id` / `plans.clickup_task_id` remain present and populated.
 *  4. Badge/drilldown logic for imported tickets reads the board-record accessor.
 *  5. A backfilled link that cannot be resolved yields a row with the id and NULLs —
 *     never an invented field.
 *
 * Plus the mapping, policy and size assertions the plan's Verification Plan names.
 *
 * Harness notes (mirrored from feature-file-subtask-link-contract.test.js — do not
 * "simplify" these):
 *  - KanbanDatabase never auto-creates kanban.db, so the file is touched first.
 *  - ONE temp workspace and ONE database for the whole suite; per-test databases
 *    exhaust the shared sql.js WASM heap and present as "disk I/O error".
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// `vscode` → the standalone shim, installed BEFORE any out/services require.
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
{
    const originalLoad = Module._load;
    Module._load = function (request) {
        if (request === 'vscode') return require(shimPath);
        return originalLoad.apply(this, arguments);
    };
}

const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const {
    DEFAULT_TICKET_CONTENT_POLICY,
    mapClickUpTaskToSnapshot,
    mapLinearIssueToSnapshot,
    projectSharedTicket,
    resolveTicketContentPolicy,
    ticketStaleness,
} = require('../../out/services/planTickets');
const { SHARED_TABLES, isSharedTable, projectSharedCard } = require('../../out/services/storageTiers');
const { SCHEMA_TABLES_SQL } = require('../../out/services/KanbanDatabase');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 6).join('\n     ') : e}`);
        failed++;
    }
}

/** A Linear issue with every field the typed core reads populated. */
const LINEAR_ISSUE = {
    id: 'linear-issue-uuid-1',
    identifier: 'ENG-421',
    title: 'Seat pacing never armed in the standalone host',
    description: 'The queue seams were wired in extension.ts only.\n\nSee the precedent note.',
    state: { id: 'state-1', name: 'In Progress', type: 'started' },
    priority: 1,
    assignee: { id: 'user-1', name: 'Robin Vega', email: 'robin@example.com' },
    project: { id: 'proj-1', name: 'Storage layer overhaul' },
    labels: [{ id: 'l1', name: 'reliability' }, { id: 'l2', name: 'database' }],
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-09-01T10:00:00.000Z',
    url: 'https://linear.app/acme/issue/ENG-421',
    parentId: null,
};

/** A ClickUp task with the concepts that must NOT be force-fitted onto Linear's. */
const CLICKUP_TASK = {
    id: 'cu-86abc',
    name: 'Ticket bodies are gitignored',
    markdownDescription: '# Body\n\nClickUp markdown body.',
    url: 'https://app.clickup.com/t/86abc',
    parentId: null,
    status: { status: 'in progress', color: '#ff0', type: 'custom' },
    priority: { id: '2', priority: 'high', color: '#f00', orderindex: '2' },
    list: { id: 'list-9', name: 'Engineering Backlog' },
    assignees: [
        { id: 'u1', username: 'sam', email: 'sam@example.com' },
        { id: 'u2', username: 'ali', email: 'ali@example.com' },
    ],
    tags: [{ name: 'infra' }],
    dateCreated: '1754035200000',
    dateUpdated: '1756713600000',
};

async function run() {
    console.log('\nImported ticket metadata as first-class shared board state\n');

    const tmpRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sb-plantickets-')));
    fs.mkdirSync(path.join(tmpRoot, '.switchboard', 'plans'), { recursive: true });

    const db = KanbanDatabase.forWorkspace(tmpRoot);
    {
        const dbDir = path.dirname(db.dbPath);
        if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
        if (!fs.existsSync(db.dbPath)) fs.writeFileSync(db.dbPath, Buffer.alloc(0));
        assert.ok(await db.ensureReady(), 'seeded kanban.db must initialise');
    }
    const wsId = (await db.getWorkspaceId()) || (await db.getDominantWorkspaceId()) || 'plantickets-ws';

    /** Seed a plan row + file, returning { planId, rel, abs }. */
    async function seedPlan(slug, planId) {
        const rel = `.switchboard/plans/${slug}.md`;
        const abs = path.join(tmpRoot, rel);
        fs.writeFileSync(abs, `# ${slug}\n\n## Goal\n${slug}\n`, 'utf8');
        const now = new Date().toISOString();
        assert.ok(await db.insertFileDerivedPlan({
            planId, sessionId: planId, topic: slug, planFile: rel, kanbanColumn: 'CREATED',
            status: 'active', complexity: '3', tags: '', project: '', workspaceId: wsId,
            createdAt: now, updatedAt: now, sourceType: 'local', workspaceName: 'plantickets',
            isFeature: 0,
        }), `seedPlan(${slug}) must insert`);
        return { planId, rel, abs };
    }

    /** Read raw plan_tickets columns — the assertions are about NULL vs '' vs a value. */
    function rawTicketRow(planId, provider, externalId) {
        const stmt = db._db.prepare(
            'SELECT * FROM plan_tickets WHERE plan_id = ? AND provider = ? AND external_id = ? LIMIT 1',
            [planId, provider, externalId]
        );
        try {
            return stmt.step() ? stmt.getAsObject() : null;
        } finally {
            stmt.free();
        }
    }

    // ── Invariant 1: the table exists and is shared tier ──────────────────────

    console.log('── the table exists and is shared tier ──');

    await test('plan_tickets is declared in the schema DDL', () => {
        assert.ok(
            /CREATE TABLE IF NOT EXISTS plan_tickets\s*\(/.test(SCHEMA_TABLES_SQL),
            'SCHEMA_TABLES_SQL must create plan_tickets so a FRESH database has it without a migration'
        );
    });

    await test('plan_tickets exists in an initialised database', () => {
        const stmt = db._db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'plan_tickets'"
        );
        try {
            assert.ok(stmt.step(), 'plan_tickets table must exist after ensureReady()');
        } finally {
            stmt.free();
        }
    });

    await test('plan_tickets is registered SHARED tier, not local', () => {
        assert.ok(SHARED_TABLES.includes('plan_tickets'), 'plan_tickets must be in SHARED_TABLES');
        assert.strictEqual(isSharedTable('plan_tickets'), true);
    });

    await test('the primary key admits many plans per ticket AND many tickets per plan', () => {
        const stmt = db._db.prepare("SELECT sql FROM sqlite_master WHERE name = 'plan_tickets'");
        let ddl = '';
        try { if (stmt.step()) { ddl = String(stmt.getAsObject().sql || ''); } } finally { stmt.free(); }
        assert.ok(
            /PRIMARY KEY\s*\(\s*plan_id\s*,\s*provider\s*,\s*external_id\s*\)/i.test(ddl),
            'PK must be (plan_id, provider, external_id) — two machines importing one ticket as two ' +
            'plans is legitimate, and so is one plan carrying tickets from two providers'
        );
    });

    // ── Invariant 3: the shipped id columns are untouched ────────────────────

    console.log('\n── the shipped id columns survive ──');

    const linearPlan = await seedPlan('imported-linear', 'aaaa0000-0000-4000-8000-00000000aaaa');
    const clickupPlan = await seedPlan('imported-clickup', 'bbbb0000-0000-4000-8000-00000000bbbb');

    await test('plans still carries linear_issue_id and clickup_task_id, and they still populate', async () => {
        const cols = new Set();
        const stmt = db._db.prepare('PRAGMA table_info(plans)');
        try { while (stmt.step()) { cols.add(String(stmt.getAsObject().name)); } } finally { stmt.free(); }
        assert.ok(cols.has('linear_issue_id'), 'plans.linear_issue_id must remain — this plan is additive');
        assert.ok(cols.has('clickup_task_id'), 'plans.clickup_task_id must remain — this plan is additive');

        assert.ok(await db.updateLinearIssueIdByPlanFile(linearPlan.abs, wsId, LINEAR_ISSUE.id));
        assert.ok(await db.updateClickUpTaskIdByPlanFile(clickupPlan.abs, wsId, CLICKUP_TASK.id));

        const linked = await db.findPlanByLinearIssueId(wsId, LINEAR_ISSUE.id);
        assert.ok(linked, 'the legacy id column must still resolve a plan');
        assert.strictEqual(linked.planId, linearPlan.planId);
    });

    // ── Provider mapping: a typed core with no false equivalence ─────────────

    console.log('\n── provider mapping asserts no equivalence that is not there ──');

    const fetchedAt = '2026-09-02T09:00:00.000Z';
    const linearSnapshot = mapLinearIssueToSnapshot(
        { issue: LINEAR_ISSUE, comments: [{ body: 'first', createdAt: '2026-08-02T00:00:00.000Z', user: { name: 'Robin Vega' } }], attachments: [{ title: 'spec', url: 'https://example.com/spec.pdf' }] },
        fetchedAt
    );
    const clickupSnapshot = mapClickUpTaskToSnapshot(
        { task: CLICKUP_TASK, comments: [{ comment_text: 'ping', date: '1756713600000', user: { username: 'sam' } }], attachments: null },
        fetchedAt
    );

    await test('a Linear project and a ClickUp list land in the SAME columns under DIFFERENT kinds', () => {
        assert.strictEqual(linearSnapshot.containerKind, 'linear.project');
        assert.strictEqual(linearSnapshot.containerName, 'Storage layer overhaul');
        assert.strictEqual(clickupSnapshot.containerKind, 'clickup.list');
        assert.strictEqual(clickupSnapshot.containerName, 'Engineering Backlog');
        assert.notStrictEqual(
            linearSnapshot.containerKind, clickupSnapshot.containerKind,
            'the kind is what keeps a list from being read as a project'
        );
    });

    await test('priority keeps each provider\'s own scale and is never normalised', () => {
        assert.strictEqual(linearSnapshot.priorityRaw, '1');
        assert.strictEqual(linearSnapshot.priorityScheme, 'linear.0-4');
        assert.strictEqual(clickupSnapshot.priorityRaw, 'high');
        assert.strictEqual(clickupSnapshot.priorityScheme, 'clickup.label');
    });

    await test('a field neither provider fetches stays NULL rather than becoming 0', () => {
        assert.strictEqual(linearSnapshot.estimate, null, 'Linear estimate is not fetched — unknown, not zero');
        assert.strictEqual(clickupSnapshot.estimate, null, 'ClickUp estimate is not fetched — unknown, not zero');
    });

    await test('ClickUp has no human-facing key, so externalKey is NULL rather than the opaque id', () => {
        assert.strictEqual(linearSnapshot.externalKey, 'ENG-421');
        assert.strictEqual(clickupSnapshot.externalKey, null);
    });

    await test('every ClickUp assignee is kept; only the first fills the single typed column', () => {
        assert.strictEqual(clickupSnapshot.assigneeName, 'sam');
        assert.strictEqual(clickupSnapshot.payload.assignees.length, 2, 'the full list must survive in the payload');
    });

    await test('ClickUp epoch-ms timestamps are converted so staleness is comparable with Linear\'s', () => {
        assert.strictEqual(clickupSnapshot.sourceUpdatedAt, new Date(1756713600000).toISOString());
    });

    await test('attachments are URL references, never blobs', () => {
        assert.deepStrictEqual(linearSnapshot.attachments, [
            { title: 'spec', url: 'https://example.com/spec.pdf', filename: null },
        ]);
        assert.strictEqual(
            clickupSnapshot.attachments, null,
            'not fetched on this path — NULL means "never told", not "none"'
        );
    });

    // ── Invariant 2: resolvable from the store alone, no files ───────────────

    console.log('\n── clone survival: the store answers with no ticket files present ──');

    await test('an imported ticket\'s assignee, state and labels round-trip through the board store', async () => {
        assert.ok(await db.upsertPlanTicket(linearPlan.planId, wsId, linearSnapshot));
        assert.ok(await db.upsertPlanTicket(clickupPlan.planId, wsId, clickupSnapshot));

        const rows = await db.getPlanTickets(linearPlan.planId);
        assert.strictEqual(rows.length, 1);
        const r = rows[0];
        assert.strictEqual(r.assigneeName, 'Robin Vega');
        assert.strictEqual(r.assigneeEmail, 'robin@example.com');
        assert.strictEqual(r.stateName, 'In Progress');
        assert.deepStrictEqual(r.labels, ['reliability', 'database']);
        assert.strictEqual(r.externalKey, 'ENG-421');
        assert.strictEqual(r.url, 'https://linear.app/acme/issue/ENG-421');
    });

    await test('the ticket body reaches the store, and .switchboard/tickets/ is not consulted', async () => {
        // The whole point: this directory is gitignored, so on a fresh clone it does
        // not exist. Assert the read works with it absent.
        assert.ok(
            !fs.existsSync(path.join(tmpRoot, '.switchboard', 'tickets')),
            'the harness must never create the file cache — the assertion below is about its absence'
        );
        const rows = await db.getPlanTickets(linearPlan.planId);
        assert.ok(rows[0].body && rows[0].body.includes('queue seams were wired'));
        assert.ok(rows[0].bodyHash, 'a stored body carries a content hash for staleness');
        assert.strictEqual(rows[0].bodyExcluded, false);
        assert.strictEqual(rows[0].comments.length, 1);
    });

    await test('a body-omitting read says so, rather than handing back a null that reads as "no body"', async () => {
        const light = (await db.getPlanTicketsForWorkspace(wsId)).find((r) => r.planId === linearPlan.planId);
        assert.strictEqual(light.body, null, 'the default read drops the body for size');
        assert.strictEqual(light.bodyOmittedFromRead, true, 'and must SAY the read dropped it');
        assert.strictEqual(light.bodyExcluded, false, 'which is not the same as policy having excluded it');

        const full = (await db.getPlanTicketsForWorkspace(wsId, true)).find((r) => r.planId === linearPlan.planId);
        assert.ok(full.body && full.body.includes('queue seams were wired'));
        assert.strictEqual(full.bodyOmittedFromRead, undefined);
    });

    await test('the same ticket imported on two plans yields two rows, not a silent winner', async () => {
        const second = await seedPlan('imported-linear-twin', 'cccc0000-0000-4000-8000-00000000cccc');
        assert.ok(await db.upsertPlanTicket(second.planId, wsId, linearSnapshot));
        const both = await db.getPlansForTicket(wsId, 'linear', LINEAR_ISSUE.id);
        assert.strictEqual(both.length, 2, 'two machines importing one ticket as two plans is legitimate');
        assert.deepStrictEqual(
            both.map((r) => r.planId).sort(),
            [linearPlan.planId, second.planId].sort()
        );
    });

    // ── Staleness ────────────────────────────────────────────────────────────

    console.log('\n── staleness is visible, and "unknown" is not "fresh" ──');

    await test('a ticket changed upstream after the last fetch reads as stale', () => {
        assert.strictEqual(ticketStaleness('2026-09-01T10:00:00.000Z', '2026-09-02T09:00:00.000Z'), 'fresh');
        assert.strictEqual(ticketStaleness('2026-09-03T10:00:00.000Z', '2026-09-02T09:00:00.000Z'), 'stale');
    });

    await test('a row with no source timestamp is "unknown", never "fresh"', () => {
        assert.strictEqual(ticketStaleness(null, '2026-09-02T09:00:00.000Z'), 'unknown');
        assert.strictEqual(ticketStaleness('2026-09-01T10:00:00.000Z', null), 'unknown');
    });

    await test('a refetch bumps fetched_at and clears an orphan mark', async () => {
        assert.ok(await db.markPlanTicketOrphaned(clickupPlan.planId, 'clickup', CLICKUP_TASK.id, 'deleted-upstream'));
        let row = (await db.getPlanTickets(clickupPlan.planId))[0];
        assert.ok(row.orphanedAt, 'the orphan mark must land');
        assert.strictEqual(row.orphanReason, 'deleted-upstream');
        assert.ok(row.title, 'the snapshot is RETAINED on orphaning — somebody may have worked from it');

        const refetched = mapClickUpTaskToSnapshot(
            { task: CLICKUP_TASK, comments: null, attachments: null },
            '2026-09-05T09:00:00.000Z',
            DEFAULT_TICKET_CONTENT_POLICY,
            'refetch'
        );
        assert.ok(await db.upsertPlanTicket(clickupPlan.planId, wsId, refetched));
        row = (await db.getPlanTickets(clickupPlan.planId))[0];
        assert.strictEqual(row.fetchedAt, '2026-09-05T09:00:00.000Z');
        assert.strictEqual(row.orphanedAt, null, 'a ticket that answers a fetch is not deleted upstream');
        assert.strictEqual(row.metadataSource, 'refetch');
    });

    // ── Body exclusion ───────────────────────────────────────────────────────

    console.log('\n── body exclusion is a recorded decision, not an absence ──');

    await test('with bodies excluded, no body reaches the store — and the exclusion is recorded', async () => {
        const excludedPolicy = { ...DEFAULT_TICKET_CONTENT_POLICY, storeBody: false, storeComments: false };
        const snap = mapLinearIssueToSnapshot(
            { issue: LINEAR_ISSUE, comments: [{ body: 'secret', createdAt: null, user: { name: 'x' } }], attachments: null },
            fetchedAt,
            excludedPolicy
        );
        assert.strictEqual(snap.body, null);
        assert.strictEqual(snap.bodyExcluded, true, 'the POLICY decision is recorded on the row');
        assert.ok(snap.bodyHash, 'the hash survives exclusion so a refetch can still detect upstream change');
        assert.strictEqual(snap.comments, null);
        assert.strictEqual(snap.commentsExcluded, true);

        const p = await seedPlan('imported-nobody', 'dddd0000-0000-4000-8000-00000000dddd');
        assert.ok(await db.upsertPlanTicket(p.planId, wsId, snap));
        const raw = rawTicketRow(p.planId, 'linear', LINEAR_ISSUE.id);
        assert.strictEqual(raw.body, null, 'the body must not be in the store at all');
        assert.strictEqual(Number(raw.body_excluded), 1);
        assert.ok(
            !JSON.stringify(raw).includes('queue seams were wired'),
            'no fragment of the excluded body may survive anywhere on the row'
        );
    });

    await test('an excluded body is distinguishable from a ticket that simply has none', async () => {
        const emptyBodyIssue = { ...LINEAR_ISSUE, id: 'linear-issue-uuid-empty', description: '' };
        const snap = mapLinearIssueToSnapshot({ issue: emptyBodyIssue, comments: null, attachments: null }, fetchedAt);
        assert.strictEqual(snap.body, null, 'no body to store');
        assert.strictEqual(snap.bodyExcluded, false, 'and NOT because policy excluded it');
    });

    await test('an oversized body is truncated with a visible marker, never silently cut', () => {
        const huge = 'x'.repeat(500);
        const snap = mapLinearIssueToSnapshot(
            { issue: { ...LINEAR_ISSUE, description: huge }, comments: null, attachments: null },
            fetchedAt,
            { ...DEFAULT_TICKET_CONTENT_POLICY, maxBodyChars: 100 }
        );
        assert.ok(snap.body.startsWith('x'.repeat(100)));
        assert.ok(snap.body.includes('truncated by Switchboard'), 'a cut body must say it was cut');
        assert.strictEqual(
            snap.bodyHash,
            mapLinearIssueToSnapshot({ issue: { ...LINEAR_ISSUE, description: huge }, comments: null, attachments: null }, fetchedAt).bodyHash,
            'the hash is of the ORIGINAL text — truncation is our doing, not the ticket\'s'
        );
    });

    // ── Configuration provenance ─────────────────────────────────────────────

    console.log('\n── the content policy is tagged with the layer that answered ──');

    await test('an unset policy reports built-in-default, not a configured value', () => {
        const resolved = resolveTicketContentPolicy(null);
        assert.strictEqual(resolved.policy.storeBody, true);
        assert.strictEqual(resolved.sources.storeBody, 'built-in-default');
    });

    await test('an explicit VS Code setting names its layer', () => {
        const cfg = {
            get: (_k, d) => d,
            inspect: (key) => (key === 'tickets.storeBodyInBoardStore'
                ? { key, defaultValue: true, workspaceValue: false }
                : { key, defaultValue: undefined }),
        };
        const resolved = resolveTicketContentPolicy(cfg);
        assert.strictEqual(resolved.policy.storeBody, false);
        assert.strictEqual(resolved.sources.storeBody, 'workspace-setting');
    });

    await test('a standalone config.json value is distinguishable from the built-in default', () => {
        // The standalone shim returns all-undefined inspect layers, so provenance
        // comes from the sentinel probe: an unset key hands the sentinel back.
        const cfg = {
            get: (key, d) => (key === 'tickets.storeCommentsInBoardStore' ? false : d),
            inspect: (key) => ({ key, defaultValue: undefined, globalValue: undefined, workspaceValue: undefined, workspaceFolderValue: undefined }),
        };
        const resolved = resolveTicketContentPolicy(cfg);
        assert.strictEqual(resolved.policy.storeComments, false);
        assert.strictEqual(resolved.sources.storeComments, 'standalone-config');
        assert.strictEqual(resolved.sources.storeBody, 'built-in-default', 'an unset sibling key stays tagged as default');
    });

    // ── The bounded snapshot projection ──────────────────────────────────────

    console.log('\n── board.json carries a bounded subset, never the body ──');

    await test('projectSharedTicket omits body, comments and attachments', () => {
        const stored = (Object.assign({}, linearSnapshot, { orphanedAt: null }));
        const projected = projectSharedTicket(stored);
        const keys = Object.keys(projected);
        for (const forbidden of ['body', 'bodyHash', 'comments', 'commentsHash', 'attachments', 'payload']) {
            assert.ok(!keys.includes(forbidden), `board.json must not carry ${forbidden}`);
        }
        assert.strictEqual(projected.external_key, 'ENG-421');
        assert.strictEqual(projected.assignee, 'Robin Vega');
        assert.strictEqual(projected.metadata_source, 'import', 'a reader must be able to tell a fetch from a backfill');
        assert.ok(
            !JSON.stringify(projected).includes('queue seams were wired'),
            'no body text may leak into the snapshot by any route'
        );
    });

    await test('a card with no ticket carries no `tickets` key at all', () => {
        const plan = { planId: 'p', topic: 't', kanbanColumn: 'CREATED', featureId: '', project: '', complexity: '3' };
        const bare = projectSharedCard(plan, 'x.md');
        assert.ok(!('tickets' in bare), 'an empty array would read as "checked, none"');
        const withTicket = projectSharedCard(plan, 'x.md', undefined, [projectSharedTicket(linearSnapshot)]);
        assert.strictEqual(withTicket.tickets.length, 1);
    });

    // ── Invariant 5: the backfill invents nothing ────────────────────────────

    console.log('\n── the backfill invents nothing ──');

    await test('a link with no resolvable metadata yields a row with the id and NULLs', async () => {
        // An install whose plans carry ids and whose ticket file cache is absent —
        // exactly the shape of every pre-V75 install on a machine that never browsed
        // tickets, and of every fresh clone.
        const legacy = await seedPlan('legacy-linked', 'eeee0000-0000-4000-8000-00000000eeee');
        assert.ok(await db.updateLinearIssueIdByPlanFile(legacy.abs, wsId, 'legacy-issue-id-42'));

        // Rewind to the pre-V75 world for this row and re-run the migration.
        db._db.run('DELETE FROM plan_tickets WHERE plan_id = ?', [legacy.planId]);
        await db._runMigrationV75();

        const raw = rawTicketRow(legacy.planId, 'linear', 'legacy-issue-id-42');
        assert.ok(raw, 'the backfill must create a row for a shipped id column');
        assert.strictEqual(raw.metadata_source, 'backfill-plan-column', 'the row must say where it came from');
        assert.strictEqual(raw.fetched_at, null, 'no fetch happened — stamping a time would report it fresh');
        for (const col of ['title', 'state_name', 'assignee_name', 'assignee_email', 'labels', 'url', 'external_key', 'source_updated_at']) {
            assert.strictEqual(raw[col], null, `${col} must stay NULL — unknown is not blank, and never invented`);
        }
        const record = (await db.getPlanTickets(legacy.planId))[0];
        assert.strictEqual(
            ticketStaleness(record.sourceUpdatedAt, record.fetchedAt), 'unknown',
            'a backfilled row must never render as freshly checked'
        );
    });

    await test('the backfill is idempotent and never clobbers a fetched row', async () => {
        const before = (await db.getPlanTickets(linearPlan.planId))[0];
        await db._runMigrationV75();
        const after = (await db.getPlanTickets(linearPlan.planId))[0];
        assert.strictEqual(after.title, before.title, 'a re-run must not overwrite a real snapshot with a bare id');
        assert.strictEqual(after.metadataSource, 'import');
    });

    await test('the backfill resolves linear_issue_links rows by plan path', async () => {
        const linked = await seedPlan('link-table-plan', 'ffff0000-0000-4000-8000-00000000ffff');
        await db.setLinearIssueLink('issue-from-link-table', linked.rel);
        db._db.run('DELETE FROM plan_tickets WHERE plan_id = ?', [linked.planId]);
        await db._runMigrationV75();
        const raw = rawTicketRow(linked.planId, 'linear', 'issue-from-link-table');
        assert.ok(raw, 'a link that only linear_issue_links knows about must still be backfilled');
        assert.strictEqual(raw.metadata_source, 'backfill-issue-link');
        assert.strictEqual(raw.title, null, 'and it must still invent nothing');
    });

    // ── Invariant 4: the badge reads the board record ────────────────────────

    console.log('\n── the badge reads the board record, and says so ──');

    await test('the tickets panel resolves imported tickets through the board-record accessor', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'services', 'TicketsPanelProvider.ts'), 'utf8'
        );
        assert.ok(
            /_boardTicketIndex\s*\(/.test(src),
            'a board-record accessor must exist — the file cache is the panel\'s cache, not the board\'s truth'
        );
        // getTicketSyncStatuses must consult the board record BEFORE falling back to
        // the file-mtime comparison. That ordering IS the fix for the documented
        // cross-read bugs; reversing it silently restores them.
        const handler = src.slice(src.indexOf("case 'getTicketSyncStatuses'"));
        const boardAt = handler.indexOf('_boardTicketIndex');
        const fileAt = handler.indexOf('_ticketSyncStatusFromTimestamps');
        assert.ok(boardAt > -1, 'getTicketSyncStatuses must consult the board record');
        assert.ok(fileAt > -1, 'and must still answer un-imported tickets from the file cache');
        assert.ok(boardAt < fileAt, 'the board record must be consulted FIRST for imported tickets');
        assert.ok(
            /statusSources/.test(handler),
            'every status must say which truth answered it — the ambiguity is the documented bug'
        );
    });

    await test('the ticket list overlays board records and tags the source of each row', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'services', 'TicketsPanelProvider.ts'), 'utf8'
        );
        assert.ok(/_applyBoardTicketRecords\(workspaceRoot, provider, tickets\)/.test(src));
        assert.ok(/syncSource = 'board-record'/.test(src) || /syncSource: 'board-record'/.test(src));
        assert.ok(/syncSource = 'file-cache'/.test(src));
    });

    await test('the webview renders the board-record badges it is now sent', () => {
        for (const rel of ['webview/tickets.js', 'webview/planning.js']) {
            const src = fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
            for (const status of ['board-orphaned', 'board-stale', 'board-fresh', 'board-unknown']) {
                assert.ok(src.includes(status), `${rel} must render the ${status} badge, not fall through to "checking"`);
            }
        }
    });

    // ── Composition-root parity ──────────────────────────────────────────────

    console.log('\n── both hosts wire the seams these reads land on ──');

    await test('both composition roots give the tickets panel its adapter factories', () => {
        // Without them `_adapterFactories.getCacheService` is the throwing default,
        // so `_kanbanDbFor` returns null and every board-record read falls back to
        // the gitignored file cache — silently, because a missing board record is
        // indistinguishable from a ticket that was never imported.
        const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');
        const std = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8');
        for (const [label, src] of [['extension.ts', ext], ['standalone/bootstrap.ts', std]]) {
            const ctor = src.slice(src.indexOf('new TicketsPanelProvider('));
            const body = ctor.slice(0, ctor.indexOf(');') + 2);
            assert.ok(body.includes('getCacheService'), `${label} must pass getCacheService to TicketsPanelProvider`);
            assert.ok(body.includes('getLinearSyncService'), `${label} must pass getLinearSyncService`);
            assert.ok(body.includes('getClickUpSyncService'), `${label} must pass getClickUpSyncService`);
        }
    });

    await test('both composition roots hand the cache service a KanbanDatabase', () => {
        // A cache service built without one has `_kanbanDb === undefined`, so a wired
        // factory still yields no board store — "never wired" and "working" would
        // again be the same value.
        const std = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8');
        assert.ok(
            /new PlanningPanelCacheService\([^)]*KanbanDatabase\.forWorkspace/.test(std),
            'standalone/bootstrap.ts must construct PlanningPanelCacheService WITH its KanbanDatabase'
        );
        assert.ok(
            !/new PlanningPanelCacheService\(root\)\s*[,)]/.test(std),
            'no db-less PlanningPanelCacheService may remain in the standalone root'
        );
    });

    await test('both composition roots answer the ticket-import commands', () => {
        // The standalone command seam is registry-first and falls through to a
        // resolving no-op, so an unregistered import command reports success while
        // creating nothing — and nothing to write a plan_tickets row for.
        const ext = fs.readFileSync(path.join(__dirname, '..', 'extension.ts'), 'utf8');
        const std = fs.readFileSync(path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8');
        for (const cmd of [
            'switchboard.importLinearTask',
            'switchboard.importClickUpTask',
            'switchboard.importTaskAsDocument',
            'switchboard.importAllTasks',
            'switchboard.removeLocalTicket',
        ]) {
            assert.ok(ext.includes(`'${cmd}'`), `extension.ts must register ${cmd}`);
            assert.ok(std.includes(`'${cmd}'`), `standalone/bootstrap.ts must register ${cmd}`);
        }
    });

    // ── Size, against the shared-store budget ────────────────────────────────

    console.log('\n── size, measured rather than assumed ──');

    await test('bytes per ticket with and without a body (reported, and capped)', () => {
        const withBody = Buffer.byteLength(JSON.stringify(linearSnapshot), 'utf8');
        const withoutBody = Buffer.byteLength(JSON.stringify(
            mapLinearIssueToSnapshot(
                { issue: LINEAR_ISSUE, comments: null, attachments: null },
                fetchedAt,
                { ...DEFAULT_TICKET_CONTENT_POLICY, storeBody: false, storeComments: false }
            )
        ), 'utf8');
        const projected = Buffer.byteLength(JSON.stringify(projectSharedTicket(linearSnapshot)), 'utf8');
        console.log(`     size: full row ${withBody}B · bodies excluded ${withoutBody}B · board.json projection ${projected}B`);
        assert.ok(withoutBody < withBody, 'excluding the body must actually shrink the row');
        assert.ok(
            projected < withBody,
            'the snapshot projection must be smaller than the stored row — that is what makes it safe to git-carry'
        );
        // The caps are the actual budget guarantee: one runaway ticket cannot make a
        // replica sync expensive on its own.
        assert.strictEqual(DEFAULT_TICKET_CONTENT_POLICY.maxBodyChars, 64000);
        assert.strictEqual(DEFAULT_TICKET_CONTENT_POLICY.maxComments, 100);
    });

    try { db.close?.(); } catch { /* best-effort */ }
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best-effort */ }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
