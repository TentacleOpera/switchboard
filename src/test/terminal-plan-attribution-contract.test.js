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
const kanbanProviderTs = fs.readFileSync(path.join(__dirname, '../services/KanbanProvider.ts'), 'utf8');
const verbSchemasTs = fs.readFileSync(path.join(__dirname, '../services/verbSchemas.ts'), 'utf8');
const verbAllowlistTs = fs.readFileSync(path.join(__dirname, '../generated/verbAllowlist.ts'), 'utf8');
const protocolCatalog = fs.readFileSync(path.join(__dirname, '../../protocol-catalog.json'), 'utf8');

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

// ── Head-agent wake safeguard ───────────────────────────────────────────────
// The 2026-08-16 failure: a head dispatched via ptySendPrompt, its coder wrote a
// completion report, and NOTHING woke the head. Two independent gates had to fall
// for that, and both are asserted here.

test('the plan-file edit clear fires the turn-end notifier on the same transitioned gate', () => {
    // Gate two of the 2026-08-16 blind spot. `clearWorkingState` on the watcher's
    // import NULLs dispatched_at milliseconds after the coder writes its report —
    // ~90s BEFORE the seat is silent enough to be swept — so the sweep's `completed`
    // arm is unreachable for any plan file this watcher imports. The completion
    // transition is observed HERE; if the notifier does not fire here, registration
    // alone reproduces the observed failure verbatim with a green suite.
    const clearPath = planIngestionTs.substring(
        planIngestionTs.indexOf('if (updatedRecord.dispatchedAt) {'),
        planIngestionTs.indexOf('plan = updatedRecord;')
    );
    assert.ok(clearPath.length > 0, 'the plan-file edit clear path must exist');
    assert.ok(clearPath.includes('this._turnEndNotifier('), 'the file-edit clear must fire the turn-end notifier');
    assert.ok(
        /transitioned && this\._turnEndNotifier && clearedRecord\.dispatchedTerminal/.test(clearPath),
        'the notifier must hang off the SAME `transitioned` boolean as the broadcast (re-deriving it re-opens the double-fire) and skip an empty dispatchedTerminal'
    );
    assert.ok(
        clearPath.includes("outcome: 'completed'"),
        'a plan-file mtime advance is a completed turn, never blocked'
    );
    assert.ok(
        clearPath.includes('seatName: clearedRecord.dispatchedTerminal'),
        'seatName must come from the CLEARED record — updatedRecord.dispatchedAt is nulled in place before this point'
    );
});

test('the self-recipient skip is scoped to parent resolution in BOTH hosts', () => {
    // The nudge addresses the head about the head: seatName === recipientSeat === the
    // head terminal. An unscoped "recipient is the seat itself" guard therefore
    // swallows EVERY nudge in both hosts while every other assertion stays green —
    // the feature ships wired, catalogued, schema'd and dead.
    for (const [host, src] of [['TaskViewerProvider', taskViewerTs], ['bootstrap', bootstrapTs]]) {
        assert.ok(
            /!info\.recipientSeat && recipientName && recipientName === seatName/.test(src),
            `${host}: the malformed-parent-chain skip must be gated on !info.recipientSeat or the feature nudge can never be delivered`
        );
        assert.ok(
            /if \(info\.recipientSeat\) \{\s*\n\s*recipientName = info\.recipientSeat;/.test(src),
            `${host}: recipientSeat must bypass parent resolution — resolving the head's parent addresses the orchestrator instead`
        );
        assert.ok(src.includes('info.body ??'), `${host}: a pre-composed evidence body must win over the host's fallback message`);
    }
});

test('the feature nudge sweep treats an empty liveness snapshot as no evidence', () => {
    // getFleetLiveness() returns [] whenever the fleet is unavailable (extension
    // reload, ptyHost still booting, fleet-less host). Without an early return the
    // next tick reads every armed head as "absent" and permanently drops every
    // watch for heads that are still running. Same contract as `lastDataAt > 0`.
    const sweep = planIngestionTs.substring(
        planIngestionTs.indexOf('private async _runFeatureNudgeSweep('),
        planIngestionTs.indexOf('private async _retryPendingFeatureLinks(')
    );
    assert.ok(sweep.length > 0, '_runFeatureNudgeSweep must exist');
    assert.ok(sweep.includes('if (liveness.length === 0) return;'), 'an empty liveness snapshot must abort the tick, never drop watches');
    const emptyGuardAt = sweep.indexOf('liveness.length === 0');
    const dropAt = sweep.indexOf("headLive.status === 'exited'");
    assert.ok(emptyGuardAt >= 0 && dropAt > emptyGuardAt, 'the no-evidence guard must precede the absent/exited drop');
    // Gate 3: never inject a prompt into a running turn.
    assert.ok(sweep.includes('nowMs - headLive.lastDataAt < turnEndSilenceMs'), 'the nudge must gate on the HEAD\'s own silence');
    assert.ok(sweep.includes('headLive.lastDataAt <= 0'), 'a zero/absent head lastDataAt is no evidence of silence');
    // Gate 4: no double-wake.
    assert.ok(sweep.includes('notifiedSeatsThisTick.has('), 'a seat notified this tick must suppress the nudge');
    assert.ok(sweep.includes('!!s.dispatchedAt'), 'an outstanding dispatch must suppress the nudge — the per-dispatch backstop owns that window');
    // Cancellation + pacing.
    assert.ok(sweep.includes('nowMs - watch.lastNudgedAt < turnEndSilenceMs'), 'the nudge must be paced by lastNudgedAt');
    assert.ok(sweep.includes('recipientSeat: watch.headTerminal'), 'the head IS the recipient — parent resolution must be skipped');
    // Evidence, not a poke (the PRD "done" definition for this payload).
    assert.ok(sweep.includes('s.dispatchedTerminal') && sweep.includes('s.kanbanColumn') && sweep.includes('s.planFile'),
        'the nudge body must name the remaining subtasks, their columns and their seats');
});

test("handleAutobanTurnEnd ignores outcome 'stalled'", () => {
    const arm = taskViewerTs.substring(
        taskViewerTs.indexOf('public handleAutobanTurnEnd('),
        taskViewerTs.indexOf('private _autobanPlanFileKey(')
    );
    assert.ok(arm.length > 0, 'handleAutobanTurnEnd must exist');
    assert.ok(arm.includes("if (info.outcome === 'stalled') { return; }"), 'a feature stall is never a completion signal to advance on');
    const stalledAt = arm.indexOf("'stalled'");
    const enabledAt = arm.indexOf('this._autobanState.enabled');
    assert.ok(stalledAt >= 0 && enabledAt > stalledAt, 'the stalled early-return must precede the engine-state guards');
});

test('watchFeature / unwatchFeature are catalogued, allowlisted, schema\'d and return their state', () => {
    for (const verb of ['watchFeature', 'unwatchFeature']) {
        assert.ok(verbAllowlistTs.includes(`'${verb}'`), `${verb} must be in KANBAN_VERBS`);
        assert.ok(protocolCatalog.includes(`"${verb}"`), `${verb} must be in protocol-catalog.json`);
        assert.ok(new RegExp(`\\n    ${verb}: \\{`).test(verbSchemasTs), `${verb} must have a schema block`);
        assert.ok(kanbanProviderTs.includes(`case '${verb}': {`), `${verb} must have a KanbanProvider arm (standalone serves it via the default: delegation)`);
    }
    // Permissive per contract #5: only featureId is required. A schema that also
    // required headTerminal/workspaceRoot would reject valid callers at the boundary.
    const watchSchema = verbSchemasTs.substring(
        verbSchemasTs.indexOf('    watchFeature: {'),
        verbSchemasTs.indexOf('    // Plan lifecycle')
    );
    assert.ok(watchSchema.length > 0, 'the watch schemas must be readable');
    assert.strictEqual((watchSchema.match(/required: true/g) || []).length, 2, 'exactly featureId is required on each of the two watch verbs');
    // Contract #4: the body carries data, not a bare ack.
    const arms = kanbanProviderTs.substring(
        kanbanProviderTs.indexOf("case 'watchFeature': {"),
        kanbanProviderTs.indexOf("case 'julesSelected': {")
    );
    assert.ok(arms.includes('return { success: true, watch: next, watches: filtered };'), 'watchFeature must return the armed watch in the body');
    assert.ok(arms.includes('return { success: true, removed, watches: filtered };'), 'unwatchFeature must return the resulting state in the body');
    assert.ok(!/vscode\./.test(arms), 'the watch arms must touch only db + config (contract #3) so standalone serves them unchanged');
    assert.ok(arms.includes("db.getConfigJson<FeatureWatchRecord[]>('kanban.featureWatches'".replace('(', '(')) || arms.includes('kanban.featureWatches'),
        'watch state lives in the config table, not state.json and not a new table');
});

test('the shipped attributePastedPrompt paste/drop path is not hardened by this change', () => {
    // The registration path reuses the SHIPPED verb. A future "reject a second
    // attribution for a busy terminal" pass would break a user re-attributing a card
    // by drag on ~4,000 installs (PRD contract #2). Break this test to regress it.
    const arm = kanbanProviderTs.substring(
        kanbanProviderTs.indexOf("case 'attributePastedPrompt': {"),
        kanbanProviderTs.indexOf("case 'watchFeature': {")
    );
    assert.ok(arm.length > 0, 'attributePastedPrompt must exist');
    assert.ok(!arm.includes('getActiveDispatchedByTerminal'), 'the shared paste/drop verb must NOT reject a second attribution for a busy terminal');
    assert.ok(arm.includes('attributePasteDispatch('), 'registration must stamp dispatched_terminal/dispatched_at through the shipped setter');
    assert.ok(/return \{ success: true, attributed: attributed\.length/.test(arm), 'the caller needs `attributed` in the body — a zero is a failed registration');
});

console.log('\n--- composeCompletedTurnEndBody & turn-end notices ---');

const { composeCompletedTurnEndBody } = require('../../out/services/PlanIngestionEngine');

test('composeCompletedTurnEndBody renders all clauses when present', () => {
    const record = {
        topic: 'Implement Finished Seat Notice',
        kanbanColumn: 'In Progress',
        featureId: 'feat-123',
        dispatchedAt: '2026-08-17T00:00:00.000Z'
    };
    const nowMs = Date.parse('2026-08-17T00:00:45.000Z');
    const result = composeCompletedTurnEndBody(record, 'coder-1', '.switchboard/plans/test.md', nowMs);
    const lines = result.split('\n');
    assert.strictEqual(lines.length, 2, 'must be exactly 2 lines');
    assert.strictEqual(
        lines[0],
        `[switchboard:turn-end] Seat 'coder-1' finished its turn on '.switchboard/plans/test.md' — "Implement Finished Seat Notice" (column In Progress, feature feat-123, worked 45s).`
    );
    assert.strictEqual(
        lines[1],
        'Verify the diff (git diff) before you trust the report, then advance the card or register the next subtask (attributePastedPrompt) and dispatch it.'
    );
});

test('composeCompletedTurnEndBody drops missing clauses gracefully', () => {
    const record = {
        topic: '',
        kanbanColumn: '',
        featureId: null,
        dispatchedAt: null
    };
    const result = composeCompletedTurnEndBody(record, 'coder-2', 'plan.md', Date.now());
    const lines = result.split('\n');
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(
        lines[0],
        `[switchboard:turn-end] Seat 'coder-2' finished its turn on 'plan.md'.`
    );
    assert.strictEqual(
        lines[1],
        'Verify the diff (git diff) before you trust the report, then advance the card or register the next subtask (attributePastedPrompt) and dispatch it.'
    );
});

test('composeCompletedTurnEndBody formats minutes when worked >= 120s', () => {
    const record = {
        topic: 'Long task',
        kanbanColumn: 'Coded',
        featureId: '',
        dispatchedAt: new Date(1000000000000).toISOString()
    };
    const nowMs = 1000000000000 + 14 * 60 * 1000;
    const result = composeCompletedTurnEndBody(record, 'lead-1', 'long.md', nowMs);
    assert.ok(result.includes('column Coded, worked 14m'));
    assert.ok(!result.includes('feature '));
});

test('composeCompletedTurnEndBody flattens and truncates topic to 80 chars with ellipsis', () => {
    const longTopic = 'A'.repeat(50) + '\n' + 'B'.repeat(50);
    const record = {
        topic: longTopic,
        kanbanColumn: 'In Progress',
        featureId: 'f1',
        dispatchedAt: null
    };
    const result = composeCompletedTurnEndBody(record, 'c1', 'plan.md', Date.now());
    const lines = result.split('\n');
    assert.strictEqual(lines.length, 2, 'newlines in topic must be flattened to preserve 2-line shape');
    assert.ok(lines[0].includes('— "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA BBBBBBBBBBBBBBBBBBBBBBBBBBBBB…" (column In Progress, feature f1).'));
});

test('both completed turnEndNotifier call sites in PlanIngestionEngine pass a body', () => {
    const matches = planIngestionTs.match(/_turnEndNotifier\(\{[^}]*outcome:\s*'completed'[^}]*\}\)/g) || [];
    assert.strictEqual(matches.length, 2, 'both completed notifier calls must exist');
    for (const m of matches) {
        assert.ok(m.includes('body'), `completed notifier call must pass body: ${m}`);
    }
});

test('both hosts honour info.body for completed turn-end notices', () => {
    assert.ok(
        taskViewerTs.includes("const message = info.body ?? (info.outcome === 'completed'"),
        'TaskViewerProvider must honour info.body ?? fallback'
    );
    assert.ok(
        bootstrapTs.includes("const message = info.body ?? (info.outcome === 'completed'"),
        'bootstrap.ts must honour info.body ?? fallback'
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }

