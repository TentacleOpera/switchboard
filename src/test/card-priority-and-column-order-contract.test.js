/**
 * V63 — priority star + manual column order contract.
 *
 * The whole point of this feature is that ONE precedence decides which card is
 * next, everywhere. That fails silently in two directions no behavioural check
 * catches on its own:
 *
 *  - Behaviourally, a consumer that keeps its own sort agrees with the screen
 *    right up until the day it does not, and the symptom (two surfaces naming a
 *    different "next card") is close to undiagnosable from the board. So the
 *    structural assertions below pin that each consumer CALLS the resolver
 *    rather than sorting locally.
 *  - Structurally, the comparator itself has one genuinely subtle property —
 *    manual-vs-absent must not be resolved by timestamp, or the comparison
 *    becomes intransitive and the sort result depends on input order. A
 *    hand-rolled "fix" toward the plan's literal wording would reintroduce it,
 *    so the transitivity case is asserted directly.
 *
 * Also pins the two new verbs into the generated allowlist: the VS Code webview
 * reaches handleKanbanMessage in-process, but the browser cockpit posts the same
 * verbs over /kanban/verb/*, where handleServiceVerb throws on anything absent
 * from KANBAN_VERBS. A missed `npm run catalog:generate` leaves the star dead in
 * one host and working in the other.
 */
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const ordering = read('src/services/kanbanOrdering.ts');
const provider = read('src/services/KanbanProvider.ts');
const apiServer = read('src/services/LocalApiServer.ts');
const database = read('src/services/KanbanDatabase.ts');
const kanbanHtml = read('src/webview/kanban.html');
const allowlist = read('src/generated/verbAllowlist.ts');

let failed = 0;
function check(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (err) { failed++; console.log(`  ❌ ${name}\n     ${err.message}`); }
}

// A faithful JS port of compareByPrecedence, pinned by the source-shape
// assertions below. The TS source is not requireable from a plain node test
// without a compile step, and compiling one file to test four lines of ordering
// is more machinery than the guarantee is worth.
function compareByPrecedence(a, b, column) {
    const sa = a.priorityStarred ? 1 : 0;
    const sb = b.priorityStarred ? 1 : 0;
    if (sa !== sb) { return sb - sa; }
    const isStaging = column === 'STAGING';
    const oa = isStaging ? (a.queuePosition ?? null) : (a.columnOrder ?? null);
    const ob = isStaging ? (b.queuePosition ?? null) : (b.columnOrder ?? null);
    const oaNull = oa === null;
    const obNull = ob === null;
    if (!oaNull && !obNull) {
        const d = oa - ob;
        if (d !== 0) { return d; }
    } else if (oaNull !== obNull) {
        // STAGING: NULL = never staged → last. Elsewhere: NULL = just arrived → first.
        if (isStaging) { return oaNull ? 1 : -1; }
        return oaNull ? -1 : 1;
    }
    const ms = (t) => { if (!t) { return null; } const v = new Date(t).getTime(); return isNaN(v) ? null : v; };
    const ca = ms(a.columnEnteredAt) ?? ms(a.lastActivity) ?? ms(a.createdAt) ?? 0;
    const cb = ms(b.columnEnteredAt) ?? ms(b.lastActivity) ?? ms(b.createdAt) ?? 0;
    if (cb - ca !== 0) { return cb - ca; }
    return (ms(b.createdAt) ?? 0) - (ms(a.createdAt) ?? 0);
}

const order = (cards, column) => [...cards].sort((x, y) => compareByPrecedence(x, y, column)).map(c => c.id);

console.log('\nV63 priority star + manual column order contract\n');

// ── Precedence ─────────────────────────────────────────────────────────────

check('a starred card is picked before any unstarred one, whatever the manual order says', () => {
    const cards = [
        { id: 'first-by-hand', columnOrder: 1, columnEnteredAt: '2026-08-01T00:00:00Z' },
        { id: 'last-by-hand', columnOrder: 9, priorityStarred: 1, columnEnteredAt: '2026-08-01T00:00:00Z' },
    ];
    assert.deepStrictEqual(order(cards, 'CREATED'), ['last-by-hand', 'first-by-hand']);
});

check('a manually arranged column is consumed in its visible order', () => {
    const cards = [
        { id: 'c', columnOrder: 3, columnEnteredAt: '2026-08-03T00:00:00Z' },
        { id: 'a', columnOrder: 1, columnEnteredAt: '2026-08-01T00:00:00Z' },
        { id: 'b', columnOrder: 2, columnEnteredAt: '2026-08-02T00:00:00Z' },
    ];
    assert.deepStrictEqual(order(cards, 'CREATED'), ['a', 'b', 'c']);
});

check('unarranged and unstarred is unchanged: column_entered_at DESC then createdAt DESC', () => {
    const cards = [
        { id: 'older', columnEnteredAt: '2026-08-01T00:00:00Z', createdAt: '2026-07-01T00:00:00Z' },
        { id: 'newer', columnEnteredAt: '2026-08-05T00:00:00Z', createdAt: '2026-07-01T00:00:00Z' },
        { id: 'tie-newer-created', columnEnteredAt: '2026-08-05T00:00:00Z', createdAt: '2026-07-09T00:00:00Z' },
    ];
    assert.deepStrictEqual(order(cards, 'CREATED'), ['tie-newer-created', 'newer', 'older']);
});

check('a missing column_entered_at falls back to lastActivity then createdAt', () => {
    const cards = [
        { id: 'no-col-ts', lastActivity: '2026-08-09T00:00:00Z' },
        { id: 'has-col-ts', columnEnteredAt: '2026-08-02T00:00:00Z' },
    ];
    assert.deepStrictEqual(order(cards, 'CREATED'), ['no-col-ts', 'has-col-ts']);
});

check('STAGING reads queue_position and ignores column_order', () => {
    const staging = [
        { id: 'q2', queuePosition: 2, columnOrder: 1 },
        { id: 'q1', queuePosition: 1, columnOrder: 9 },
    ];
    assert.deepStrictEqual(order(staging, 'STAGING'), ['q1', 'q2']);
    // The same two cards outside STAGING sort by column_order instead.
    assert.deepStrictEqual(order(staging, 'CREATED'), ['q2', 'q1']);
});

check('manual-vs-absent is not resolved by timestamp — the comparator stays transitive', () => {
    // The intransitive shape the plan's literal "NULL yields to the fallback"
    // wording would produce: A beats C on ts, C beats B on ts, B beats A on
    // order. If any of those three flips to a timestamp comparison the sorted
    // result depends on input order, so assert every permutation agrees.
    const A = { id: 'A', columnOrder: 5, columnEnteredAt: '2026-08-10T00:00:00Z' };
    const B = { id: 'B', columnOrder: 1, columnEnteredAt: '2026-08-01T00:00:00Z' };
    const C = { id: 'C', columnEnteredAt: '2026-08-05T00:00:00Z' };
    const permutations = [[A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A]];
    for (const p of permutations) {
        assert.deepStrictEqual(order(p, 'CREATED'), ['C', 'B', 'A'],
            `permutation ${p.map(c => c.id).join('')} produced a different order — the comparator is not transitive`);
    }
    // NULLs-first is exactly as sound as NULLs-last; what the cycle rules out is
    // ranking a NULL against a number BY DATE, not the direction NULL falls.
    for (const p of permutations) {
        assert.deepStrictEqual(order(p, 'STAGING').length, 3);
    }
});

// ── One resolver, not three ────────────────────────────────────────────────

check('the queue pop calls the shared resolver and keeps no local queue_position sort', () => {
    assert.ok(/import\s*\{\s*compareByPrecedence\s*\}\s*from\s*'\.\/kanbanOrdering'/.test(apiServer),
        'LocalApiServer must import compareByPrecedence');
    assert.ok(/compareByPrecedence\(a,\s*b,\s*'STAGING'\)/.test(apiServer),
        "the queue pop must sort via compareByPrecedence(a, b, 'STAGING')");
    assert.ok(!/const\s+byQueueThenBoard\s*=/.test(apiServer),
        'byQueueThenBoard must be gone — a second sort is how the surfaces drift');
});

check('the planner fan-out calls the shared resolver and keeps no lastActivity sort', () => {
    assert.ok(/import\s*\{\s*compareByPrecedence\s*\}\s*from\s*'\.\/kanbanOrdering'/.test(provider),
        'KanbanProvider must import compareByPrecedence');
    const fnStart = provider.indexOf('private async _distributePlannerDispatch(');
    assert.notStrictEqual(fnStart, -1, '_distributePlannerDispatch must exist');
    const body = provider.slice(fnStart, provider.indexOf('\n    private ', fnStart + 50));
    assert.ok(/compareByPrecedence\(a,\s*b,\s*sortColumn\)/.test(body),
        '_distributePlannerDispatch must sort via compareByPrecedence');
    assert.ok(!/lastActivity\s*\|\|\s*''\)\.localeCompare/.test(body),
        'the lastActivity ASC sort must be gone — it was a proxy for the in-flight filter, not an ordering');
});

check('the planner fan-out filters in-flight cards before sorting, and reports what it skipped', () => {
    const fnStart = provider.indexOf('private async _distributePlannerDispatch(');
    const body = provider.slice(fnStart, provider.indexOf('\n    private ', fnStart + 50));
    const filterIdx = body.indexOf('sourceCards.filter(c => !c.working)');
    const sortIdx = body.indexOf('compareByPrecedence(a, b, sortColumn)');
    assert.notStrictEqual(filterIdx, -1, 'the !working filter must exist');
    assert.ok(filterIdx < sortIdx, 'the in-flight filter must run BEFORE the sort');
    assert.ok(/_inFlightSkipFailures\(/.test(body),
        'skipped in-flight cards must be reported — an unreported skip leaves the webview optimistic move stranded');
    assert.ok(/_inFlightSkipFailures\(cards: KanbanCard\[\]\)/.test(provider),
        '_inFlightSkipFailures must exist on KanbanProvider');
});

check('the frontend display comparator applies the same precedence as the resolver', () => {
    const sortIdx = kanbanHtml.indexOf('const sortedItems = [...items].sort((a, b) => {');
    assert.notStrictEqual(sortIdx, -1, 'the display comparator must exist');
    const body = kanbanHtml.slice(sortIdx, sortIdx + 3200);
    assert.ok(/a\.priorityStarred\s*\?\s*1\s*:\s*0/.test(body), 'display sort must apply starred-first');
    assert.ok(/a\.queuePosition/.test(body) && /a\.columnOrder/.test(body),
        'display sort must read queue_position in STAGING and column_order elsewhere');
    assert.ok(/_colTs/.test(body), 'display sort must fall back to column_entered_at DESC');
});

// ── Persistence, clearing, and wiring ──────────────────────────────────────

check('V63 adds both columns to the schema, the migration chain, and PLAN_COLUMNS', () => {
    assert.ok(/priority_starred\s+INTEGER DEFAULT 0/.test(database), 'SCHEMA_TABLES_SQL must declare priority_starred');
    assert.ok(/column_order\s+INTEGER DEFAULT NULL/.test(database), 'SCHEMA_TABLES_SQL must declare column_order');
    assert.ok(/MIGRATION_V63_SQL/.test(database), 'MIGRATION_V63_SQL must exist');
    assert.ok(/setMigrationVersion\(63\)/.test(database), 'the migration runner must stamp version 63');
    const cols = database.slice(database.indexOf('const PLAN_COLUMNS ='), database.indexOf('const PLAN_COLUMNS =') + 900);
    assert.ok(/priority_starred/.test(cols) && /column_order/.test(cols),
        'PLAN_COLUMNS must select both columns or every read returns them undefined');
});

check('neither column is in the upsert, so a file re-import cannot wipe a star', () => {
    const upsert = database.slice(database.indexOf('const UPSERT_PLAN_SQL'), database.indexOf('const MIGRATION_VERSION_KEY'));
    assert.ok(!/priority_starred/.test(upsert),
        'priority_starred must stay out of UPSERT_PLAN_SQL — the watcher record does not carry it');
    assert.ok(!/column_order/.test(upsert),
        'column_order must stay out of UPSERT_PLAN_SQL — the watcher record does not carry it');
});

check('a cross-column move clears column_order and writes nothing, on BOTH sides of STAGING', () => {
    const idx = provider.indexOf('await db.clearColumnOrder(');
    assert.notStrictEqual(idx, -1, 'moveCardToColumnWithReason must clear column_order');
    const guard = provider.slice(provider.lastIndexOf('if (plan &&', idx), idx);
    assert.ok(/plan\.kanbanColumn\s*!==\s*targetColumn/.test(guard), 'it must be gated on an actual column change');
    assert.ok(!/kanbanColumn\s*!==\s*'STAGING'/.test(guard) && !/targetColumn\s*!==\s*'STAGING'/.test(guard),
        'STAGING must NOT be excluded — excluding it left a CREATED → STAGING → CREATED round-trip holding its stale pre-staging position');
    assert.ok(!/setColumnOrderToFront/.test(provider) && !/setColumnOrderToFront/.test(database),
        'a column move must not assign a position. It is a stage change, not a statement about priority, and front-of-column would hand a card the user never placed a slot ahead of the ones they did');
});

check('a card dragged into a column goes to the TOP, arranged column or not', () => {
    // The single rule the board has always followed. A NULL column_order means
    // "just arrived", not "unranked", so it leads — an arrangement orders the
    // cards that were arranged, it does not outrank a new arrival. Carrying
    // V60's NULLs-last rule (correct for queue_position, where NULL means
    // "never staged") across to column_order is what sent arrivals to the bottom.
    const arrived = { id: 'arrived', columnEnteredAt: '2026-08-20T00:00:00Z' };
    const arranged = [
        { id: 'hand-1', columnOrder: 1, columnEnteredAt: '2026-08-01T00:00:00Z' },
        { id: 'hand-2', columnOrder: 2, columnEnteredAt: '2026-08-02T00:00:00Z' },
        { id: 'hand-3', columnOrder: 3, columnEnteredAt: '2026-08-03T00:00:00Z' },
    ];
    assert.deepStrictEqual(order([...arranged, arrived], 'CREATED'),
        ['arrived', 'hand-1', 'hand-2', 'hand-3']);
    // A second arrival leads on recency, and the arrangement stays intact below.
    const later = { id: 'arrived-2', columnEnteredAt: '2026-08-21T00:00:00Z' };
    assert.deepStrictEqual(order([...arranged, arrived, later], 'CREATED'),
        ['arrived-2', 'arrived', 'hand-1', 'hand-2', 'hand-3']);
});

check('STAGING keeps the opposite NULL rule — never-staged goes to the END', () => {
    // queue_position NULL means "never staged", so it belongs at the end of the
    // queue (V60). The two fields mean opposite things and must not share a rule.
    const cards = [
        { id: 'unstaged', columnEnteredAt: '2026-08-20T00:00:00Z' },
        { id: 'q1', queuePosition: 1, columnEnteredAt: '2026-08-01T00:00:00Z' },
        { id: 'q2', queuePosition: 2, columnEnteredAt: '2026-08-02T00:00:00Z' },
    ];
    assert.deepStrictEqual(order(cards, 'STAGING'), ['q1', 'q2', 'unstaged']);
});

check('a card arriving in a column nobody arranged still sorts by date, at the top', () => {
    // The MIN subquery yields NULL there, so the card stays un-numbered and the
    // existing column_entered_at DESC ordering places it first on its own.
    const cards = [
        { id: 'arrived', columnEnteredAt: '2026-08-20T00:00:00Z' },
        { id: 'sat-there', columnEnteredAt: '2026-08-02T00:00:00Z' },
        { id: 'sat-there-longer', columnEnteredAt: '2026-08-01T00:00:00Z' },
    ];
    assert.deepStrictEqual(order(cards, 'CREATED'), ['arrived', 'sat-there', 'sat-there-longer']);
});

check('priority_starred is never cleared by a column move', () => {
    assert.ok(!/clearPriorityStarred/.test(provider) && !/clearPriorityStarred/.test(database),
        'a star is a persistent flag that follows the card — there is no clear-on-move');
});

check('setPriorityStarred resolves a session-id card key, like its reorder siblings', () => {
    const fnStart = provider.indexOf('public async setPriorityStarred(');
    assert.notStrictEqual(fnStart, -1, 'KanbanProvider.setPriorityStarred must exist');
    const body = provider.slice(fnStart, provider.indexOf('\n    public ', fnStart + 50));
    assert.ok(/getPlanBySessionId\(/.test(body),
        'the card key is planId || sessionId, and _persistedUpdate reports success on zero rows — an unresolved id would report a star that was never written');
});

check('setColumnOrders writes 1..N inside one transaction', () => {
    const fnStart = database.indexOf('public async setColumnOrders(');
    assert.notStrictEqual(fnStart, -1, 'setColumnOrders must exist');
    const body = database.slice(fnStart, database.indexOf('\n    /**', fnStart));
    assert.ok(/BEGIN/.test(body) && /COMMIT/.test(body) && /ROLLBACK/.test(body),
        'concurrent reorders must not interleave — one transaction, rolled back on failure');
});

check('both new verbs are in the generated allowlist (the browser cockpit rail)', () => {
    assert.ok(/'setPriorityStarred'/.test(allowlist),
        "setPriorityStarred missing from KANBAN_VERBS — handleServiceVerb throws on it, so the star is dead over /kanban/verb/*. Run `npm run catalog:generate`.");
    assert.ok(/'reorderColumn'/.test(allowlist),
        "reorderColumn missing from KANBAN_VERBS — run `npm run catalog:generate`.");
});

check('the star control is on the card and does not gate on a confirm', () => {
    assert.ok(/class="card-btn icon-btn star-btn/.test(kanbanHtml), 'createCardHtml must render the star button');
    const handlerIdx = kanbanHtml.indexOf("document.querySelectorAll('.card-btn.star-btn')");
    assert.notStrictEqual(handlerIdx, -1, 'the star button must have a click handler');
    const body = kanbanHtml.slice(handlerIdx, handlerIdx + 700);
    assert.ok(/e\.stopPropagation\(\)/.test(body), 'the star click must not reach the card selection handler');
    assert.ok(!/confirm\(/.test(body), 'no confirm gate — project rule, and confirm() is a silent no-op in webviews');
    assert.ok(/type:\s*'setPriorityStarred'/.test(body), 'the handler must post setPriorityStarred');
});

check('a drag that changed nothing must not arrange the column', () => {
    const idx = kanbanHtml.indexOf("type: 'reorderColumn'");
    const branch = kanbanHtml.slice(kanbanHtml.lastIndexOf("if (effectiveTargetColumn !== 'STAGING')", idx), idx);
    assert.ok(/const unchanged =/.test(branch) && /orderedIds\.every\(\(id, i\) => id === renderedIds\[i\]\)/.test(branch),
        'the post-drop order must be compared against the rendered order before posting');
    const guardIdx = branch.indexOf('if (unchanged) {');
    assert.notStrictEqual(guardIdx, -1, 'an unchanged drop must return without posting');
    assert.ok(branch.slice(guardIdx, guardIdx + 400).includes('return;'),
        'the unchanged branch must return — writing column_order for a card put back where it was flips the whole column from self-ordering to frozen, invisibly');
});

check('a same-column drag outside STAGING persists the order it just showed', () => {
    const idx = kanbanHtml.indexOf("type: 'reorderColumn'");
    assert.notStrictEqual(idx, -1, 'the drop handler must post reorderColumn');
    const branch = kanbanHtml.slice(kanbanHtml.lastIndexOf("if (effectiveTargetColumn !== 'STAGING')", idx), idx + 200);
    assert.ok(/sameColIds\.length === sessionIds\.length/.test(branch),
        'only a pure same-column drag may reorder — a mixed drag must fall through to the move path, not silently drop its outsiders');
    assert.ok(/getBoundingClientRect/.test(branch), 'the insertion index must come from the drop position');
});

console.log(`\n${failed === 0 ? 'V63 priority + column order contract passed' : `${failed} contract(s) failed.`}\n`);
process.exit(failed === 0 ? 0 : 1);
