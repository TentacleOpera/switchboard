/**
 * Contract: a team can declare itself out of AUTOMATED board dispatch, and the
 * declaration is honoured at the two places dispatch resolves a terminal.
 *
 * The shipped set has two `planner`-headed teams that are meant to run AT THE
 * SAME TIME — `planning-team` for bulk planning, `multi-agent-planning` for
 * harder work the operator drives by hand. Before this contract, the planner
 * pool filtered on ROLE ALONE (`getRoleTerminalSet`), so with both live the bulk
 * fan-out pooled every planner terminal on the board: the peer drafters received
 * unrelated queue items, and the batch size — which is `terminals.length` — was
 * inflated by seats that must never be targets.
 *
 * Operator decision, 2026-09-19:
 *   - both live                → every dispatch verb goes to Planning only
 *   - only multi-agent live    → plans go one at a time to ITS HEAD
 *   - its member seats         → NEVER receive a dispatch, under any condition
 *   - copy-prompt buttons      → unaffected; they reach any head via clipboard
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const tw = require(path.join(REPO_ROOT, 'out/services/teamWiring.js'));
const TVP_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src/services/TaskViewerProvider.ts'), 'utf8');

let passed = 0, failed = 0;
async function test(name, fn) {
    try { await fn(); console.log('  ✅ ' + name); passed++; }
    catch (e) { console.log('  ❌ ' + name + '\n     ' + e.message); failed++; }
}

/** A `terminals.groups` row shaped exactly as `wireSpawnedTeam` writes one. */
const liveGroup = (id, definitionId, head, seats) => ({
    id, definitionId, name: head, head,
    source: 'manual', teamGroup: true, teamKind: 'spawned',
    members: [head, ...seats], order: [head, ...seats],
});
const mkDb = (groups, defs) => ({
    getConfigJson: async (key) =>
        key === 'terminals.agentGroups' ? defs : (String(key).includes('groups') ? groups : []),
});

const defOf = (id) => tw.DEFAULT_TEAM_DEFINITIONS.find(d => d && d.id === id);

(async () => {
    console.log('\n--- The shipped defaults declare their dispatch policy ---');

    await test('every default states automatedDispatch explicitly, with a source', () => {
        for (const d of tw.DEFAULT_TEAM_DEFINITIONS) {
            const r = tw.readTeamAutomatedDispatch(d);
            assert.ok(['pool', 'head-only-when-sole', 'never'].indexOf(r.value) >= 0,
                `${d.id} must declare a valid automatedDispatch, got ${JSON.stringify(d.automatedDispatch)}`);
            assert.strictEqual(r.source, 'default',
                `${d.id} must tag its policy source — an untagged policy reads like a configured one`);
        }
    });

    await test('multi-agent-planning is head-only-when-sole; the other four are pooled', () => {
        assert.strictEqual(tw.readTeamAutomatedDispatch(defOf('multi-agent-planning')).value, 'head-only-when-sole');
        for (const id of ['planning-team', 'feature-implementation', 'coding-team', 'review-team']) {
            assert.strictEqual(tw.readTeamAutomatedDispatch(defOf(id)).value, 'pool', `${id} must stay pooled`);
        }
    });

    await test('an absent field reads as pool tagged unknown, never as configured', () => {
        const r = tw.readTeamAutomatedDispatch({ id: 'operator-built' });
        assert.strictEqual(r.value, 'pool', 'absence must not take a team out of play');
        assert.strictEqual(r.source, 'unknown', '"nobody set it" must not read as "set to pool"');
        const bogus = tw.readTeamAutomatedDispatch({ automatedDispatch: 'sometimes' });
        assert.strictEqual(bogus.value, 'pool');
        assert.strictEqual(bogus.source, 'unknown', 'an unrecognised value must not borrow a real source');
    });

    console.log('\n--- The three operator-stated cases ---');

    const PLANNING = defOf('planning-team');
    const MAP = defOf('multi-agent-planning');
    const MAP_SEATS = ['MAP-planner-1', 'MAP-planner-2', 'MAP-planner-3'];
    const PLAN_SEATS = ['Planning-planner-1', 'Planning-planner-2'];

    await test('both live: Planning takes everything, the multi-agent team takes nothing', async () => {
        const db = mkDb([
            liveGroup('team_Planning', 'planning-team', 'Planning', PLAN_SEATS),
            liveGroup('team_MAP', 'multi-agent-planning', 'Multi-agent planning', MAP_SEATS),
        ], [PLANNING, MAP]);
        const live = new Set(['Planning', ...PLAN_SEATS, 'Multi-agent planning', ...MAP_SEATS]);
        const { excluded, reasons } = await tw.resolveAutomatedDispatchExclusions({ db, liveNames: live });

        assert.ok(excluded.has('Multi-agent planning'), 'its head must be excluded while Planning is live');
        for (const s of MAP_SEATS) { assert.ok(excluded.has(s), `${s} must be excluded`); }
        for (const p of ['Planning', ...PLAN_SEATS]) {
            assert.ok(!excluded.has(p), `${p} must remain a target — it is the team that takes the work`);
        }
        // The batch size the operator asked for is exactly the eligible seat count.
        assert.strictEqual([...live].filter(n => !excluded.has(n)).length, 3,
            'the pool must be Planning head + 2 seats — that count is what sizes an advance-batch');
        assert.ok(/pooled 'planner'-headed team is live/.test(reasons.get('Multi-agent planning') || ''),
            'the exclusion must record WHICH rule answered, not just that it did');
    });

    await test('only the multi-agent team live: its head becomes eligible, its seats do not', async () => {
        const db = mkDb([liveGroup('team_MAP', 'multi-agent-planning', 'Multi-agent planning', MAP_SEATS)],
            [PLANNING, MAP]);
        const live = new Set(['Multi-agent planning', ...MAP_SEATS]);
        const { excluded, reasons } = await tw.resolveAutomatedDispatchExclusions({ db, liveNames: live });

        assert.ok(!excluded.has('Multi-agent planning'),
            'with no pooled planner team live, plans go one at a time to its head rather than failing');
        for (const s of MAP_SEATS) {
            assert.ok(excluded.has(s), `${s} must STILL be excluded — seats never receive a dispatch, ever`);
        }
        assert.ok(/never receive automated dispatch/.test(reasons.get(MAP_SEATS[0]) || ''));
    });

    await test('a dormant multi-agent team excludes nothing', async () => {
        const db = mkDb([liveGroup('team_Planning', 'planning-team', 'Planning', PLAN_SEATS)], [PLANNING, MAP]);
        const { excluded } = await tw.resolveAutomatedDispatchExclusions({
            db, liveNames: new Set(['Planning', ...PLAN_SEATS]),
        });
        assert.strictEqual(excluded.size, 0, 'a team that is not live is not an exclusion');
    });

    await test('an ordinary pooled team is never touched', async () => {
        const CODING = defOf('coding-team');
        const db = mkDb([liveGroup('team_Coding', 'coding-team', 'Coding', ['Coding-intern'])], [CODING]);
        const { excluded } = await tw.resolveAutomatedDispatchExclusions({
            db, liveNames: new Set(['Coding', 'Coding-intern']),
        });
        assert.strictEqual(excluded.size, 0);
    });

    await test('a legacy row carrying only `name` still resolves its head', async () => {
        // `wireSpawnedTeam` writes `head` AND `name`, but only `head` is declared.
        // A row from before that must not skip the team — skipping reads exactly
        // like "this team was allowed to dispatch".
        const legacy = liveGroup('team_MAP', 'multi-agent-planning', 'Multi-agent planning', MAP_SEATS);
        delete legacy.head;
        const db = mkDb([
            liveGroup('team_Planning', 'planning-team', 'Planning', PLAN_SEATS), legacy,
        ], [PLANNING, MAP]);
        const { excluded } = await tw.resolveAutomatedDispatchExclusions({
            db, liveNames: new Set(['Planning', ...PLAN_SEATS, 'Multi-agent planning', ...MAP_SEATS]),
        });
        assert.ok(excluded.has('Multi-agent planning'), 'a legacy row must still be read, not silently skipped');
        for (const s of MAP_SEATS) { assert.ok(excluded.has(s)); }
    });

    console.log('\n--- Both dispatch resolvers consult the exclusions ---');

    await test('getRoleTerminalSet filters the pool — it is what sizes an advance-batch', () => {
        const body = TVP_SRC.slice(TVP_SRC.indexOf('public async getRoleTerminalSet('));
        const fn = body.slice(0, body.indexOf('\n    public ', 10));
        assert.ok(/_automatedDispatchExclusions\(workspaceRoot\)/.test(fn),
            'getRoleTerminalSet must consult the exclusions: it is the ONLY place the bulk fan-out '
            + 'learns its terminal set, and plans.slice(0, terminals.length) sizes the batch from it');
        assert.ok(/excluded\.has\(name\)/.test(fn), 'and must actually filter on them');
    });

    await test('the team-blind fleet first-match filters BEFORE matching', () => {
        const body = TVP_SRC.slice(TVP_SRC.indexOf('private async _resolveExactAgentTerminalForPlan('));
        const fn = body.slice(0, body.indexOf('\n    private async _resolveAgentTerminalForPlan('));
        assert.ok(/_automatedDispatchExclusions\(workspaceRoot\)/.test(fn),
            'the single-card resolver takes whichever terminal of the role appears first, which can be '
            + 'a seat of a hands-on-only team');
        const filterAt = fn.indexOf('excluded.has(t.friendlyName)');
        const findAt = fn.indexOf('.find((t: any) => this._normalizeAgentKey(t.role) === normalizedRole)');
        assert.ok(filterAt > 0 && findAt > 0 && filterAt < findAt,
            'the exclusion filter must run BEFORE .find(), or an excluded first match makes the resolver '
            + 'give up instead of taking the next eligible terminal');
    });

    await test('the exclusion resolver fails OPEN, never closed', () => {
        const body = TVP_SRC.slice(TVP_SRC.indexOf('private async _automatedDispatchExclusions('));
        const fn = body.slice(0, body.indexOf('\n    public async getRoleTerminalSet('));
        assert.ok(/catch\s*\(err\)/.test(fn) && /excluded: new Set\(\), reasons: new Map\(\)/.test(fn),
            'a roster read failure must degrade to today\'s behaviour, not stop the board dispatching');
    });

    console.log('\n--- The seat cap is automatic ---');

    const KP_SRC = fs.readFileSync(path.join(REPO_ROOT, 'src/services/KanbanProvider.ts'), 'utf8');
    const fanOut = (() => {
        const i = KP_SRC.indexOf('private async _distributePlannerDispatch(');
        return KP_SRC.slice(i, KP_SRC.indexOf('\n    private async ', i + 10));
    })();

    await test('the batch is capped at one plan per seat, unconditionally', () => {
        assert.ok(/const plans = ordered\.slice\(0, terminals\.length\);/.test(fanOut),
            'the fan-out must take the oldest terminals.length plans with no condition — a fan-out that '
            + 'can be switched off silently stacks several plans on one seat, which is a queue, not a fan-out');
        assert.ok(!/\bskipLimit\b/.test(fanOut),
            'no escape hatch: every caller gets one plan per seat');
    });

    await test('no toggle survives anywhere — not the reader, the state field, or the UI', () => {
        const TVP = fs.readFileSync(path.join(REPO_ROOT, 'src/services/TaskViewerProvider.ts'), 'utf8');
        const AC_HTML = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/agent-control.html'), 'utf8');
        const AC_JS = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/agent-control.js'), 'utf8');
        assert.ok(!/getLimitDispatchToTerminals/.test(TVP + KP_SRC),
            'the reader must be gone, not merely unread');
        assert.ok(!/plannerLimitDispatchToTerminals/.test(TVP),
            'the state field must be gone from the reader side');
        assert.ok(!/agents-tab-planner-limit-dispatch|agents-tab-planner-terminal-count/.test(AC_HTML + AC_JS),
            'the AGENTS tab must carry neither the limit checkbox nor the duplicate terminal-count selector — '
            + 'opening a grid is the TERMINALS tab\'s gesture and the roster sizes the fan-out');
    });

    await test('the held-plans message names no setting, because there is none', () => {
        assert.ok(!/limit ON/.test(fanOut),
            'the status suffix must not name a toggle the operator cannot find');
        assert.ok(/one plan per planner seat/.test(fanOut),
            'it must explain the rule instead');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
})().catch(e => { console.error(e); process.exit(1); });
