'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { attributePlansToTerminals } = require('../../out/services/terminalPlanAttribution');

const kanbanDbTs = fs.readFileSync(path.join(__dirname, '../services/KanbanDatabase.ts'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');
const ptyHostTs = fs.readFileSync(path.join(__dirname, '../standalone/ptyHost.ts'), 'utf8');
const taskViewerTs = fs.readFileSync(path.join(__dirname, '../services/TaskViewerProvider.ts'), 'utf8');
const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const planIngestionTs = fs.readFileSync(path.join(__dirname, '../services/PlanIngestionEngine.ts'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

function makeWt(id, p, feature, project) {
    return {
        id,
        branch: 'main',
        path: p,
        feature_id: feature || null,
        created_at: '2026-01-01T00:00:00Z',
        status: 'active',
        project: project || null,
        agentsOpenWithGrid: false,
        subtask_plan_id: null,
        base_branch: null,
        tier: null
    };
}

function makeRow(opts) {
    return {
        planId: opts.planId || 'plan-1',
        topic: opts.topic || 'Test plan',
        dispatchedTerminal: opts.dispatchedTerminal || '',
        dispatchedAt: opts.dispatchedAt || '2026-08-11T00:00:00Z',
        featureId: opts.featureId || null,
        project: opts.project || null
    };
}

function makeTerm(opts) {
    return {
        friendlyName: opts.friendlyName || 'coder-1',
        worktreePath: opts.worktreePath || '',
        status: opts.status || 'active'
    };
}

const FEAT_WT = makeWt(1, '/tmp/sb-fixture/feature-worktree', 'feature-9', 'Acme');
// Distinct project on purpose. matchWorktreePath's project tier is a plain
// `find(w => w.project === plan.project)` over ALL active worktrees — a feature
// worktree that also carries the project would win it on array order. That is the
// shared resolver's pre-existing behaviour and not this module's to change, so the
// fixture exercises the project tier honestly instead of asserting a property the
// resolver does not have.
const PROJ_WT = makeWt(2, '/tmp/sb-fixture/project-worktree', null, 'Zenith');
const OTHER_WT = makeWt(3, '/tmp/sb-fixture/other-worktree', 'feature-other', 'Other');

console.log('\n--- attributePlansToTerminals: name tier ---');

test('name tier wins over path tier for the same terminal', () => {
    const rows = [
        makeRow({ planId: 'plan-named', topic: 'Named', dispatchedTerminal: 'coder-1' }),
        makeRow({ planId: 'plan-path', topic: 'Path', featureId: 'feature-9', project: 'Acme' }),
    ];
    const terminals = [makeTerm({ friendlyName: 'coder-1', worktreePath: '/tmp/sb-fixture/feature-worktree' })];
    const result = attributePlansToTerminals(rows, [FEAT_WT], terminals);
    assert.strictEqual(result.get('coder-1')?.planId, 'plan-named');
});

test('a row naming terminal A is not path-matched onto terminal B in the same worktree', () => {
    // ONE row, and it names coder-A while also carrying the worktree's featureId.
    // The fixture previously added a SECOND, unnamed row — a legitimate path-tier
    // candidate — which made this case identical to the "one candidate, two seats,
    // one already name-matched ⇒ the other resolves" test below while asserting the
    // opposite. The property under test is that a NAMED row stays name-tier only.
    const rows = [
        makeRow({ planId: 'plan-A', topic: 'A', dispatchedTerminal: 'coder-A', featureId: 'feature-9', project: 'Acme' }),
    ];
    const terminals = [
        makeTerm({ friendlyName: 'coder-A', worktreePath: '/tmp/sb-fixture/feature-worktree' }),
        makeTerm({ friendlyName: 'coder-B', worktreePath: '/tmp/sb-fixture/feature-worktree' })
    ];
    const result = attributePlansToTerminals(rows, [FEAT_WT], terminals);
    assert.strictEqual(result.get('coder-A')?.planId, 'plan-A');
    assert.ok(!result.has('coder-B'), 'terminal B must not inherit terminal A\'s path match');
});

console.log('\n--- attributePlansToTerminals: feature / project path tiers ---');

test('an unattributed row whose featureId matches a worktree resolves with one seat there', () => {
    const rows = [makeRow({ planId: 'plan-feat', topic: 'Feature', featureId: 'feature-9', project: 'Acme' })];
    const terminals = [makeTerm({ friendlyName: 'coder-1', worktreePath: '/tmp/sb-fixture/feature-worktree' })];
    const result = attributePlansToTerminals(rows, [FEAT_WT, PROJ_WT], terminals);
    assert.strictEqual(result.get('coder-1')?.planId, 'plan-feat');
});

test('an unattributed row whose project matches a worktree resolves with one seat there', () => {
    const rows = [makeRow({ planId: 'plan-proj', topic: 'Project', project: 'Zenith' })];
    const terminals = [makeTerm({ friendlyName: 'coder-1', worktreePath: '/tmp/sb-fixture/project-worktree' })];
    const result = attributePlansToTerminals(rows, [FEAT_WT, PROJ_WT], terminals);
    assert.strictEqual(result.get('coder-1')?.planId, 'plan-proj');
});

test('ambiguity: two candidate rows, one seat in a shared feature worktree ⇒ no entry', () => {
    const rows = [
        makeRow({ planId: 'plan-1', topic: 'One', featureId: 'feature-9', project: 'Acme' }),
        makeRow({ planId: 'plan-2', topic: 'Two', featureId: 'feature-9', project: 'Acme' }),
    ];
    const terminals = [makeTerm({ friendlyName: 'coder-1', worktreePath: '/tmp/sb-fixture/feature-worktree' })];
    const result = attributePlansToTerminals(rows, [FEAT_WT], terminals);
    assert.ok(!result.has('coder-1'), 'two candidate rows for one seat must yield no attribution');
});

test('ambiguity: one candidate row, two seats at the same path ⇒ no entry', () => {
    const rows = [makeRow({ planId: 'plan-1', topic: 'One', featureId: 'feature-9', project: 'Acme' })];
    const terminals = [
        makeTerm({ friendlyName: 'coder-1', worktreePath: '/tmp/sb-fixture/feature-worktree' }),
        makeTerm({ friendlyName: 'coder-2', worktreePath: '/tmp/sb-fixture/feature-worktree' })
    ];
    const result = attributePlansToTerminals(rows, [FEAT_WT], terminals);
    assert.ok(!result.has('coder-1'));
    assert.ok(!result.has('coder-2'), 'two seats at the same path must yield no attribution');
});

test('one candidate row, two seats where one is already name-matched ⇒ the other seat resolves', () => {
    const rows = [
        makeRow({ planId: 'plan-named', topic: 'Named', dispatchedTerminal: 'coder-1' }),
        makeRow({ planId: 'plan-path', topic: 'Path', featureId: 'feature-9', project: 'Acme' }),
    ];
    const terminals = [
        makeTerm({ friendlyName: 'coder-1', worktreePath: '/tmp/sb-fixture/feature-worktree' }),
        makeTerm({ friendlyName: 'coder-2', worktreePath: '/tmp/sb-fixture/feature-worktree' })
    ];
    const result = attributePlansToTerminals(rows, [FEAT_WT], terminals);
    assert.strictEqual(result.get('coder-1')?.planId, 'plan-named');
    assert.strictEqual(result.get('coder-2')?.planId, 'plan-path');
});

console.log('\n--- attributePlansToTerminals: edge cases ---');

test('empty topic yields no entry', () => {
    const rows = [makeRow({ planId: 'plan-empty', topic: '   ', dispatchedTerminal: 'coder-1' })];
    const terminals = [makeTerm({ friendlyName: 'coder-1' })];
    const result = attributePlansToTerminals(rows, [], terminals);
    assert.ok(!result.has('coder-1'));
});

test('exited terminal yields no entry', () => {
    const rows = [makeRow({ planId: 'plan-1', topic: 'One', dispatchedTerminal: 'coder-1' })];
    const terminals = [makeTerm({ friendlyName: 'coder-1', status: 'exited' })];
    const result = attributePlansToTerminals(rows, [], terminals);
    assert.ok(!result.has('coder-1'));
});

test('terminal with no status field is treated as live', () => {
    const rows = [makeRow({ planId: 'plan-1', topic: 'One', dispatchedTerminal: 'coder-1' })];
    const terminals = [{ friendlyName: 'coder-1' }];
    const result = attributePlansToTerminals(rows, [], terminals);
    assert.strictEqual(result.get('coder-1')?.planId, 'plan-1');
});

test('worktrees empty or undefined does not throw and yields name-tier results only', () => {
    const rows = [
        makeRow({ planId: 'plan-name', topic: 'Name', dispatchedTerminal: 'coder-1' }),
        makeRow({ planId: 'plan-path', topic: 'Path', featureId: 'feature-9', project: 'Acme' }),
    ];
    const terminals = [makeTerm({ friendlyName: 'coder-1', worktreePath: '/tmp/sb-fixture/feature-worktree' })];
    const result1 = attributePlansToTerminals(rows, undefined, terminals);
    const result2 = attributePlansToTerminals(rows, [], terminals);
    assert.strictEqual(result1.get('coder-1')?.planId, 'plan-name');
    assert.strictEqual(result2.get('coder-1')?.planId, 'plan-name');
});

test('a feature row shape (is_feature upstream, not in module) is attributable by name', () => {
    const rows = [makeRow({ planId: 'plan-feat', topic: 'Feature', dispatchedTerminal: 'coder-1' })];
    const terminals = [makeTerm({ friendlyName: 'coder-1' })];
    const result = attributePlansToTerminals(rows, [], terminals);
    assert.strictEqual(result.get('coder-1')?.planId, 'plan-feat');
});

console.log('\n--- source-text parity ---');

test('bootstrap.ts ptyListTerminals arm calls attributePlansToTerminals and attaches planTitle', () => {
    const arm = bootstrapTs.substring(
        bootstrapTs.indexOf("case 'ptyListTerminals': {"),
        bootstrapTs.indexOf("case 'ptyRenameTerminal':")
    );
    assert.ok(arm.includes('attributePlansToTerminals'), 'bootstrap.ts must call attributePlansToTerminals');
    assert.ok(arm.includes('planTitle'), 'bootstrap.ts must attach planTitle per terminal');
    assert.ok(arm.includes('planId'), 'bootstrap.ts must attach planId per terminal');
});

test('TaskViewerProvider.ts ptyListTerminals block calls attributePlansToTerminals and attaches planTitle', () => {
    // Anchor on the HTTP-seam block specifically. TaskViewerProvider has TWO
    // `if (verb === 'ptyListTerminals'` sites: the earlier one is _ptyHostVerb, the
    // internal path that deliberately pays NO DB cost (plan Change 4). Slicing from
    // the first occurrence spanned the wrong region entirely and failed a correct
    // implementation. lastIndexOf pins the enrichment block; the guard below keeps
    // the two from being confused if a third ever appears.
    const armStart = taskViewerTs.lastIndexOf("if (verb === 'ptyListTerminals'");
    const arm = taskViewerTs.substring(armStart, taskViewerTs.indexOf('this._localApiServer = new LocalApiServer('));
    assert.ok(armStart > taskViewerTs.indexOf("if (verb === 'ptyListTerminals'"), 'the internal _ptyHostVerb site must still exist and must not be the enriched one');
    assert.ok(arm.includes('attributePlansToTerminals'), 'TaskViewerProvider.ts must call attributePlansToTerminals');
    assert.ok(arm.includes('planTitle'), 'TaskViewerProvider.ts must attach planTitle per terminal');
    assert.ok(arm.includes('planId'), 'TaskViewerProvider.ts must attach planId per terminal');
});

test('ptyHost.ts ptyListTerminals arm does not attach planTitle', () => {
    const arm = ptyHostTs.substring(
        ptyHostTs.indexOf("case 'ptyListTerminals':"),
        ptyHostTs.indexOf("case 'ptyRenameTerminal':")
    );
    assert.ok(!arm.includes('planTitle'), 'ptyHost.ts must not enrich with planTitle (no DB)');
    assert.ok(!arm.includes('planId'), 'ptyHost.ts must not enrich with planId (no DB)');
});

test('KanbanDatabase getLiveDispatchAttribution body references neither worktree_id nor is_feature', () => {
    const body = kanbanDbTs.substring(
        kanbanDbTs.indexOf('public async getLiveDispatchAttribution'),
        kanbanDbTs.indexOf('public async clearStaleWorkingState')
    );
    assert.ok(!body.includes('worktree_id'), 'getLiveDispatchAttribution must not read worktree_id');
    assert.ok(!body.includes('is_feature'), 'getLiveDispatchAttribution must not filter is_feature');
});

test('terminals.js postFleetStateToShell payload does not gain the plan title', () => {
    const fn = terminalsJs.substring(
        terminalsJs.indexOf('function postFleetStateToShell'),
        terminalsJs.indexOf('const LAYOUTS =')
    );
    assert.ok(!fn.includes('planTitle'), 'postFleetStateToShell must not carry planTitle');
    assert.ok(!fn.includes('planId'), 'postFleetStateToShell must not carry planId');
});

test('the internal _ptyHostVerb ptyListTerminals site pays no DB cost', () => {
    // Plan Change 4: the enrichment sits on the HTTP seam only, so the completion
    // broadcast and the liveness sweep keep reading an un-enriched payload.
    const internal = taskViewerTs.substring(
        taskViewerTs.indexOf("if (verb === 'ptyListTerminals'"),
        taskViewerTs.lastIndexOf("if (verb === 'ptyListTerminals'")
    );
    assert.ok(!internal.includes('attributePlansToTerminals'), '_ptyHostVerb must not run plan attribution');
    assert.ok(!internal.includes('getLiveDispatchAttribution'), '_ptyHostVerb must not query live dispatch rows');
});

test('terminals.js drop handler POSTs attributePastedPrompt', () => {
    // Scope is wireTerminalDropTarget, not the drop listener alone: attributeDropDispatch
    // is declared ABOVE the listener (it serves both drop branches), so a slice starting
    // at addEventListener('drop' cannot see the fetch and failed a correct implementation.
    const wiring = terminalsJs.substring(
        terminalsJs.indexOf('function wireTerminalDropTarget'),
        terminalsJs.indexOf('    function createPaneElement')
    );
    assert.ok(wiring.includes("/kanban/verb/attributePastedPrompt"), 'drop wiring must POST attributePastedPrompt');
    const handler = wiring.substring(wiring.indexOf("paneEl.addEventListener('drop'"));
    assert.ok(handler.includes('attributeDropDispatch('), 'the drop handler must call attributeDropDispatch');
    // The strip reads straight off the fleet list, so the write must be followed by a
    // pull or the pane stays blank until the next 5s poll.
    assert.ok(wiring.includes('fetchTerminalList()'), 'drop attribution must refetch the terminal list');
});

test('the turn-end silence branch resolves the plan root with matchWorktreePath, not worktree_id alone', () => {
    // The sibling subtask established that plans.worktree_id has no live writer, so a
    // root resolved only from it collapses to the main checkout — and the completion
    // arm is ONLY load-bearing for worktree dispatches (the plan watcher wins every
    // other race). Keying on worktree_id alone therefore reads every worktree
    // completion as blocked while every unit test stays green. Silent and total.
    const branch = planIngestionTs.substring(
        planIngestionTs.indexOf('if (silentTerminals.length > 0)'),
        planIngestionTs.indexOf('const cleared = await db.clearStaleWorkingState(')
    );
    assert.ok(branch.length > 0, 'the silence branch must exist');
    assert.ok(branch.includes('matchWorktreePath('), 'the mtime discriminator must resolve the worktree via matchWorktreePath');
    assert.ok(branch.includes('fs.promises.stat('), 'the discriminator must stat the plan file, never read updated_at');
    assert.ok(!branch.includes('updated_at') && !branch.includes('updatedAt'), 'updated_at advances AFTER this sweep — it can never detect a completion');
    assert.ok(branch.includes('if (!record.blockedAt)'), 'setBlockedState must be gated once per turn, not re-stamped per tick');
});

test('the silence branch cannot fire on a missing lastDataAt', () => {
    const loop = planIngestionTs.substring(
        planIngestionTs.indexOf('const silentTerminals: string[] = [];'),
        planIngestionTs.indexOf('let recordedLiveness = 0;')
    );
    assert.ok(loop.includes('entry.lastDataAt > 0'), 'a zero/absent lastDataAt is no evidence, not evidence of silence');
    const exitedAt = loop.indexOf("entry.status === 'exited'");
    const silentAt = loop.indexOf('turnEndSilenceMs');
    assert.ok(exitedAt >= 0 && silentAt > exitedAt, 'the exited branch must precede the silence branch — branch ORDER is what keeps dead seats out of it');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
