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
const PROJ_WT = makeWt(2, '/tmp/sb-fixture/project-worktree', null, 'Acme');
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
    const rows = [
        makeRow({ planId: 'plan-A', topic: 'A', dispatchedTerminal: 'coder-A' }),
        makeRow({ planId: 'plan-B', topic: 'B', featureId: 'feature-9', project: 'Acme' }),
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
    const rows = [makeRow({ planId: 'plan-proj', topic: 'Project', project: 'Acme' })];
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
    const arm = taskViewerTs.substring(
        taskViewerTs.indexOf("if (verb === 'ptyListTerminals'"),
        taskViewerTs.indexOf("if (['ptyCreateTerminal'")
    );
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

test('terminals.js drop handler POSTs attributePastedPrompt', () => {
    const handler = terminalsJs.substring(
        terminalsJs.indexOf("paneEl.addEventListener('drop'"),
        terminalsJs.indexOf('    function createPaneElement')
    );
    assert.ok(handler.includes("/kanban/verb/attributePastedPrompt"), 'drop handler must POST attributePastedPrompt');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
