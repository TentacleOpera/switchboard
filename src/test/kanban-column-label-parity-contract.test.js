'use strict';

/**
 * Column label parity — resolver, canonicaliser, and definition guard
 * ==================================================================
 *
 * Rescued from `kanban-auto-export.test.ts`, which was deleted with the
 * `.switchboard/kanban-state-*.md` board mirror it existed to test. These
 * assertions never depended on the mirror: they pin the LABEL layer, which is
 * live and agent-facing through `GET /kanban/columns` and every write-path
 * canonicalisation.
 *
 * Why this matters more than it looks: operators say the board LABEL
 * ("Planned", "Reviewed"), while storage uses the ID (`PLAN REVIEWED`,
 * `CODE REVIEWED`). Every agent surface has to translate, and a label that
 * silently resolves to `fallback` — or a display-only column that answers a
 * write as though it were a real one — routes work to the wrong column with no
 * error anywhere.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:kanban-column-labels
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

if (!process.env.SWITCHBOARD_STATE_HOME) {
    try { require('./bootstrap/sandboxStateHome'); } catch { /* already sandboxed */ }
}

const {
    DEFAULT_KANBAN_COLUMNS,
    DISPLAY_MODE_COLUMNS,
    DISPLAY_ONLY_COLUMN_LABELS,
    LEGACY_COLUMN_LABELS,
    resolveColumnLabel,
} = require('../../out/services/agentConfig');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { LocalApiServer } = require('../../out/services/LocalApiServer');

let passed = 0;
const failures = [];
// AWAITS fn. A sync wrapper around an async body swallows every rejection and
// reports PASS for a test that never ran its assertions — the vacuous green this
// whole suite exists to prevent elsewhere.
async function check(name, fn) {
    try { await fn(); console.log(`  PASS ${name}`); passed++; }
    catch (e) { console.log(`  FAIL ${name}\n       ${e && e.message}`); failures.push(name); }
}

async function run() {
    console.log('Column label parity contract\n');

    // ── Definition guard ────────────────────────────────────────────────
    // The webview renders one column per DEFAULT_KANBAN_COLUMNS entry, so a
    // legacy or display-mode id joining that list renders a spurious peer
    // column AND enters _getNextColumnId's ordered walk — silently rerouting
    // the pipeline. Their labels belong in LEGACY_COLUMN_LABELS instead.
    await check('DEFAULT_KANBAN_COLUMNS stays at exactly eleven entries', () => {
        assert.strictEqual(DEFAULT_KANBAN_COLUMNS.length, 11);
    });
    await check('legacy ids never join DEFAULT_KANBAN_COLUMNS', () => {
        assert.ok(!DEFAULT_KANBAN_COLUMNS.some(c => c.id === 'BACKLOG' || c.id === 'CODED'));
    });
    await check('display modes never join DEFAULT_KANBAN_COLUMNS', () => {
        for (const id of Object.keys(DISPLAY_MODE_COLUMNS)) {
            assert.ok(!DEFAULT_KANBAN_COLUMNS.some(c => c.id === id), `${id} is a display mode`);
        }
    });

    // ── Resolver ────────────────────────────────────────────────────────
    await check('every column id the board can hold resolves to a real label', () => {
        const ids = [
            ...DEFAULT_KANBAN_COLUMNS.map(c => c.id),
            ...Object.keys(LEGACY_COLUMN_LABELS),
            ...Object.keys(DISPLAY_MODE_COLUMNS),
        ];
        for (const id of ids) {
            const r = resolveColumnLabel(id);
            assert.notStrictEqual(r.labelSource, 'fallback', `${id} should resolve to a real label`);
            assert.ok(r.label.length > 0, `${id} label should be non-empty`);
        }
    });
    await check('the labels no string transform would produce', () => {
        assert.strictEqual(resolveColumnLabel('CREATED').label, 'New');
        assert.strictEqual(resolveColumnLabel('PLAN REVIEWED').label, 'Planned');
        assert.strictEqual(resolveColumnLabel('CODE REVIEWED').label, 'Reviewed');
        assert.strictEqual(resolveColumnLabel('BACKLOG').label, 'Backlog');
        assert.strictEqual(resolveColumnLabel('CODED').label, 'Coded');
    });
    await check('labelSource distinguishes built-in, display-mode, legacy and fallback', () => {
        // A display-mode id reporting 'legacy' would mislabel a current feature as
        // a deprecated alias to every agent-facing surface.
        assert.deepStrictEqual(resolveColumnLabel('STAGING'), { label: 'Staging', labelSource: 'built-in' });
        assert.deepStrictEqual(resolveColumnLabel('BACKLOG'), { label: 'Backlog', labelSource: 'display-mode' });
        assert.strictEqual(resolveColumnLabel('CODED').labelSource, 'legacy');
        // DISPATCH is gone — it must fall back, not resolve to a stale display mode.
        assert.deepStrictEqual(resolveColumnLabel('DISPATCH'), { label: 'DISPATCH', labelSource: 'fallback' });
        assert.deepStrictEqual(resolveColumnLabel('NO SUCH COLUMN'), { label: 'NO SUCH COLUMN', labelSource: 'fallback' });
    });

    // ── Write-path canonicalisation ─────────────────────────────────────
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-col-labels-'));
    fs.mkdirSync(path.join(tempDir, '.switchboard'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, '.switchboard', 'workspace-id'), 'collabelws1234');
    const db = KanbanDatabase.forWorkspace(tempDir);
    await db.createIfMissing();
    await db.ensureReady();
    await db.setWorkspaceId('collabelws1234');

    const server = new LocalApiServer({ workspaceRoot: tempDir, getKanbanDatabase: async () => db });
    const canon = raw => server._canonicalColumnId(raw, tempDir);

    await check('labels canonicalise back to ids, case-insensitively', async () => {
        assert.strictEqual(await canon('New'), 'CREATED');
        assert.strictEqual(await canon('new'), 'CREATED');
        assert.strictEqual(await canon('Planned'), 'PLAN REVIEWED');
        assert.strictEqual(await canon('Reviewed'), 'CODE REVIEWED');
        assert.strictEqual(await canon('Backlog'), 'BACKLOG');
        assert.strictEqual(await canon('Coded'), 'CODED');
        assert.strictEqual(await canon('Coder'), 'CODER CODED');
        assert.strictEqual(await canon('lead-coded'), 'LEAD CODED');
        assert.strictEqual(await canon('CREATED'), 'CREATED', 'ID pass must keep precedence over labels');
    });

    await check('AUTOCODE refuses rather than picking one of its backing columns', async () => {
        // Silently picking one of three coder columns is the failure this guards.
        assert.strictEqual(await canon('AUTOCODE'), null);
        assert.strictEqual(await canon('Nonsense'), null);
        const msg = server._unknownColumnError('AUTOCODE');
        for (const id of DISPLAY_ONLY_COLUMN_LABELS['AUTOCODE'].aliasOf) {
            assert.ok(msg.includes(id), `AUTOCODE refusal should name ${id}`);
        }
    });

    await check('the unknown-column message lists ID (Label) pairs', () => {
        assert.ok(server._unknownColumnError('Nonsense').includes('CREATED (New)'));
    });

    try { await KanbanDatabase.disposeAll(); } catch { /* best effort */ }
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }

    console.log(`\n${passed} passed, ${failures.length} failed`);
    if (failures.length) { process.exit(1); }
}

run().catch(err => { console.error('Test failed:', err && err.stack ? err.stack : err); process.exit(1); });
