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
const localApiServerTs = fs.readFileSync(path.join(__dirname, '../services/LocalApiServer.ts'), 'utf8');
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

test('the turn-end silence branch marks blocked only — mtime-based completion is retired', () => {
    // mtime-based completion detection is GONE from both sweep and watcher: the
    // agent edits its plan file mid-work (partial reports, notes), so a file-time
    // advance can never distinguish finished from working, and the old
    // discriminator fired turn-end on the first mid-work save. POST
    // /kanban/queue/done is the explicit signal now. This test pins the removal:
    // a re-added stat/worktree-root discriminator would silently restore the
    // false positive, and no behavioural unit test covers the sweep's file I/O.
    const branch = planIngestionTs.substring(
        planIngestionTs.indexOf('if (silentTerminals.length > 0)'),
        planIngestionTs.indexOf('const cleared = await db.clearStaleWorkingState(')
    );
    assert.ok(branch.length > 0, 'the silence branch must exist');
    assert.ok(!branch.includes('fs.promises.stat('), 'the sweep must not stat plan files — mtime is not completion evidence');
    assert.ok(!branch.includes('matchWorktreePath('), 'no worktree-root resolution remains: nothing in the sweep reads plan files');
    assert.ok(!branch.includes('clearWorkingState('), 'the sweep must not clear working state — only clearStaleWorkingState (the timeout) may');
    assert.ok(!branch.includes('updated_at') && !branch.includes('updatedAt'), 'updated_at advances AFTER this sweep — it can never detect a completion');
    assert.ok(branch.includes('if (!record.blockedAt)'), 'setBlockedState must be gated once per turn, not re-stamped per tick');
    assert.ok(branch.includes("outcome: 'blocked'"), 'blocked is the only outcome the sweep may report');
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

test('the completed turn-end notifier fires from the queue/done API path, not the plan-file edit', () => {
    // Gate two of the 2026-08-16 blind spot ("a coder finished and NOTHING woke
    // the head") still has to hold — it just moved. The plan-file edit must NOT
    // clear or notify any more (that was the mid-work false positive), and
    // POST /kanban/queue/done must carry the guarantee instead: same
    // `transitioned` single-fire gate, outcome 'completed', a composed body, and
    // ONLY for a 'finished' report — a 'failed' report is a release plus the
    // escalation ladder, never a completion the lead should accept.
    const clearPath = planIngestionTs.substring(
        planIngestionTs.indexOf('if (updatedRecord.dispatchedAt) {'),
        planIngestionTs.indexOf('plan = updatedRecord;')
    );
    assert.ok(clearPath.length > 0, 'the plan-file edit path must still exist (it logs)');
    assert.ok(!clearPath.includes('clearWorkingState('), 'a plan-file edit must NOT clear working state — mid-work edits are not completions');
    assert.ok(!clearPath.includes('this._turnEndNotifier('), 'a plan-file edit must NOT fire the turn-end notifier');

    const donePath = localApiServerTs.substring(
        localApiServerTs.indexOf('private _runQueueDone('),
        localApiServerTs.indexOf('// ── Pop the next card')
    );
    assert.ok(donePath.length > 0, '_runQueueDone must exist');
    assert.ok(/if \(!transitioned\) \{/.test(donePath), 'the API path must gate on the clearWorkingState transition (the single-fire contract)');
    assert.ok(/if \(outcome === 'finished'\) \{/.test(donePath), "the completion callbacks must be gated on outcome === 'finished' — a failed report is not a completion");
    assert.ok(donePath.includes('onTurnEndNotify({'), 'the API path must fire the turn-end notifier');
    assert.ok(donePath.includes("outcome: 'completed'"), 'a queue/done report is a completed turn, never blocked');
    assert.ok(donePath.includes('composeCompletedTurnEndBody('), 'the API path must compose the same evidence body as the retired watcher path');
    assert.ok(donePath.includes('onWorkingStateCleared('), 'the API path must fire the completion broadcast too');
    // Both hosts must wire the option, or the seam is registration-only —
    // exactly the shape of the 2026-08-16 failure.
    assert.ok(/onTurnEndNotify:/.test(taskViewerTs), 'TaskViewerProvider must wire onTurnEndNotify on the LocalApiServer options');
    assert.ok(/onTurnEndNotify:/.test(bootstrapTs), 'bootstrap.ts must wire onTurnEndNotify on the LocalApiServer options');
    assert.ok(/onWorkingStateCleared:/.test(taskViewerTs), 'TaskViewerProvider must wire onWorkingStateCleared on the LocalApiServer options');
    assert.ok(/onWorkingStateCleared:/.test(bootstrapTs), 'bootstrap.ts must wire onWorkingStateCleared on the LocalApiServer options');
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

test("handleAutobanTurnEnd never advances the board — for any outcome", () => {
    // This used to be an early return on `outcome === 'stalled'`, guarding a
    // handler that DID dispatch on 'completed'. Completion-driven dispatch is
    // deleted: the schedule pops the queue on a clock and a self-pacing lead
    // pops by asking, so turn-end no longer triggers anything. The invariant is
    // unchanged and now stronger — a turn-end notice of ANY outcome must not
    // move a card or start an agent. Pinning the deleted `'stalled'` guard
    // instead would demand the hybrid back; pinning "dispatches nothing" is the
    // property that mattered all along.
    const start = taskViewerTs.indexOf('public handleAutobanTurnEnd(');
    assert.ok(start >= 0, 'handleAutobanTurnEnd must exist');
    const arm = taskViewerTs.slice(start, taskViewerTs.indexOf('\n    }', start));
    for (const forbidden of [
        'performKanbanDispatch',
        'dispatchNextFromQueue',
        '_autobanTickColumn',
        'moveCardToColumn',
        '_isCompletionTriggered',
    ]) {
        assert.ok(!arm.includes(forbidden),
            `handleAutobanTurnEnd must not call ${forbidden} — turn-end drives the activity light and the queue watch's silence signal, never a dispatch`);
    }
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
    assert.ok(arms.includes('return { success: true, watch: next, watches: updated };'), 'watchFeature must return the armed watch in the body');
    assert.ok(arms.includes('return { success: true, removed, watches: updated };'), 'unwatchFeature must return the resulting state in the body');
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

test('composeCompletedTurnEndBody drops the worked clause for an UNPARSEABLE dispatchedAt', () => {
    // Not the same branch as a null stamp: a non-empty garbage stamp passes the
    // truthiness gate and reaches Date.parse, which returns NaN. Without the
    // Number.isFinite guard the header ships `worked NaNs` — a number the lead
    // reads as evidence. This is the only test that can see that guard go.
    const record = {
        topic: 'Corrupt stamp',
        kanbanColumn: 'CODED',
        featureId: 'f9',
        dispatchedAt: 'not-a-timestamp'
    };
    const result = composeCompletedTurnEndBody(record, 'coder-9', 'plan.md', Date.now());
    assert.strictEqual(result.split('\n').length, 2);
    assert.ok(!/worked/.test(result), `the worked clause must be absent for an unparseable stamp: ${result}`);
    assert.ok(!/NaN|Infinity|undefined/.test(result), `no NaN/Infinity/undefined may reach the wire: ${result}`);
    assert.ok(result.includes('(column CODED, feature f9).'), 'the surviving clauses must still render cleanly');
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

test('the completed notifier call site lives in LocalApiServer and passes a body', () => {
    // The two PlanIngestionEngine call sites (watcher clear + sweep completion
    // arm) went with mtime-based detection. The engine may only report 'blocked'
    // and 'stalled' now; the single 'completed' producer is the queue/done API
    // path, and it must still pass the composed evidence body (a bare notice
    // names no plan, no duration and no topic — the head cannot act on it).
    const enginePleted = planIngestionTs.match(/_turnEndNotifier\(\{[^}]*outcome:\s*'completed'[^}]*\}\)/g) || [];
    assert.strictEqual(enginePleted.length, 0,
        'PlanIngestionEngine must not report completed — mtime-based completion is retired');
    const apiCompleted = localApiServerTs.match(/onTurnEndNotify\(\{[\s\S]{0,300}?outcome:\s*'completed'[\s\S]{0,200}?\}\)/g) || [];
    assert.strictEqual(apiCompleted.length, 1, 'exactly one completed notifier call site: _runQueueDone');
    assert.ok(apiCompleted[0].includes('body'), `completed notifier call must pass body: ${apiCompleted[0]}`);
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

console.log('\n--- parse-based dispatch backstop (lead-dispatched plan registration) ---');

// The shared parser lives in src/services/dispatchIdentity.ts. The compiled
// out/ module is not guaranteed to exist when this test runs in a
// skip-compilation context, so the parser is extracted from the TypeScript
// source and evaluated in-process — the same source-text fidelity as the
// mirror contract tests, but exercising real behaviour.
const dispatchIdentityTs = fs.readFileSync(path.join(__dirname, '../services/dispatchIdentity.ts'), 'utf8');

function loadExtractDispatchIdentity() {
    const minCharsMatch = dispatchIdentityTs.match(/export const PASTE_SCAN_MIN_CHARS = (\d+)/);
    assert.ok(minCharsMatch, 'PASTE_SCAN_MIN_CHARS must be exported from dispatchIdentity.ts');
    const PASTE_SCAN_MIN_CHARS = Number(minCharsMatch[1]);
    const fnStart = dispatchIdentityTs.indexOf('export function extractDispatchIdentity');
    assert.ok(fnStart >= 0, 'extractDispatchIdentity must be exported from dispatchIdentity.ts');
    const braceStart = dispatchIdentityTs.indexOf('{', fnStart);
    let depth = 0, end = -1;
    for (let i = braceStart; i < dispatchIdentityTs.length; i++) {
        if (dispatchIdentityTs[i] === '{') depth++;
        else if (dispatchIdentityTs[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    assert.ok(end > 0, 'extractDispatchIdentity function body must be balanced');
    let fn = dispatchIdentityTs.substring(fnStart, end);
    // Strip TS type annotations so V8 can parse the body.
    fn = fn.replace(/^export /, '');
    fn = fn.replace(/extractDispatchIdentity\(text: string\): DispatchIdentity \| null/, 'extractDispatchIdentity(text)');
    fn = fn.replace(/: string\[\]/g, '');
    fn = fn.replace(/: RegExpExecArray \| null/g, '');
    const factory = new Function('PASTE_SCAN_MIN_CHARS', fn + '\nreturn extractDispatchIdentity;');
    return factory(PASTE_SCAN_MIN_CHARS);
}

// 1. The shared parser returns the full UUID for a PLAN_ID — the regression
//    test for the shipped \d+ regex that captured "6" out of a UUID.
test('extractDispatchIdentity returns the full UUID for PLAN_ID, not a single digit', () => {
    const parse = loadExtractDispatchIdentity();
    const uuid = '6bef84f4-726d-437c-8ad2-dbc3f34af9d9';
    const prompt = [
        'PLANS TO PROCESS:',
        `PLAN_ID=${uuid}`,
        'Plan File: .switchboard/plans/example.md',
        'x'.repeat(220),
    ].join('\n');
    const result = parse(prompt);
    assert.ok(result, 'parser must return an identity for a genuine dispatch prompt');
    assert.ok(result.planIds.includes(uuid), `parser must capture the full UUID, got: ${JSON.stringify(result.planIds)}`);
    assert.ok(!result.planIds.includes('6'), 'the \\d+ regression ("6") must not survive');
});

// 2. A consultation prompt (PLANS TO DISCUSS:) is not a dispatch.
test('extractDispatchIdentity returns null for a PLANS TO DISCUSS: consultation prompt', () => {
    const parse = loadExtractDispatchIdentity();
    const prompt = [
        'PLANS TO DISCUSS:',
        'PLAN_ID=6bef84f4-726d-437c-8ad2-dbc3f34af9d9',
        'x'.repeat(220),
    ].join('\n');
    assert.strictEqual(parse(prompt), null, 'a consultation prompt must not be attributed as a dispatch');
});

// 3. A prompt with no PLANS TO PROCESS: marker is not a dispatch.
test('extractDispatchIdentity returns null for a prompt with no PLANS TO PROCESS: marker', () => {
    const parse = loadExtractDispatchIdentity();
    const prompt = [
        'PLAN_ID=6bef84f4-726d-437c-8ad2-dbc3f34af9d9',
        'x'.repeat(220),
    ].join('\n');
    assert.strictEqual(parse(prompt), null, 'a prompt without PLANS TO PROCESS: must not be attributed');
});

// 4. Byte-equality: the client mirror's parser body matches the shared module's.
//    The webview cannot import TypeScript, so its copy is hand-maintained; a
//    contract test is what keeps the two from drifting (same precedent as the
//    link-presets and standing-orders marker mirrors).
test('terminals.js extractPastedDispatchIdentity body is byte-equal to dispatchIdentity.ts extractDispatchIdentity', () => {
    function extractFnBody(src, fnName) {
        const start = src.indexOf('function ' + fnName);
        assert.ok(start >= 0, `${fnName} must exist`);
        const braceStart = src.indexOf('{', start);
        let depth = 0, end = -1;
        for (let i = braceStart; i < src.length; i++) {
            if (src[i] === '{') depth++;
            else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
        }
        return src.substring(braceStart + 1, end - 1);
    }
    // The shared module is TypeScript (typed annotations); the client is plain
    // JS. Strip the TS annotations so the comparison is over the logic, regex
    // and guards — the behaviour that must not drift.
    function stripTsAnnotations(body) {
        return body
            .replace(/: string\[\]/g, '')
            .replace(/: RegExpExecArray \| null/g, '')
            .replace(/: DispatchIdentity \| null/g, '')
            .replace(/\(text: string\)/g, '(text)');
    }
    const sharedBody = stripTsAnnotations(extractFnBody(dispatchIdentityTs, 'extractDispatchIdentity'));
    const clientBody = extractFnBody(terminalsJs, 'extractPastedDispatchIdentity');
    // The shared module references PASTE_SCAN_MIN_CHARS (module-scoped const);
    // the client references the same name (function-scoped const above it).
    // The logic, regex and guards must be identical.
    assert.strictEqual(
        sharedBody.replace(/\s+/g, ' ').trim(),
        clientBody.replace(/\s+/g, ' ').trim(),
        'the client mirror parser must be byte-equal to the shared module parser (whitespace-insensitive, TS annotations stripped)'
    );
});

// 5. Source-text: neither host awaits the registration call, and both capture
//    the stamp BEFORE the send.
test('both hosts capture the dispatchedAt stamp before the send and never await the registration', () => {
    // TaskViewerProvider: the stamp is captured before the proxied HTTP send,
    // and the registration is a void fire-and-forget after the send completes.
    const tvSendBlock = taskViewerTs.substring(
        taskViewerTs.indexOf('let parsedDispatchIdentity'),
        taskViewerTs.indexOf('if (verb === \'ptySendPrompt\' && result && typeof result === \'object\')')
    );
    assert.ok(tvSendBlock.includes('parsedDispatchedAt = new Date().toISOString()'), 'TaskViewerProvider must capture the stamp before the send');
    const tvRegBlock = taskViewerTs.substring(
        taskViewerTs.indexOf('if (verb === \'ptySendPrompt\' && result && typeof result === \'object\')'),
        taskViewerTs.indexOf('return {', taskViewerTs.indexOf('if (verb === \'ptySendPrompt\' && result && typeof result === \'object\')'))
    );
    assert.ok(/void this\._kanbanProvider\.handleServiceVerb\('attributePastedPrompt'/.test(tvRegBlock), 'TaskViewerProvider must fire-and-forget the registration via void');
    assert.ok(tvRegBlock.includes('.catch(() =>'), 'TaskViewerProvider registration must be swallowed, never able to fail the send');
    assert.ok(!/await this\._kanbanProvider\.handleServiceVerb\('attributePastedPrompt'/.test(tvRegBlock), 'TaskViewerProvider must NOT await the registration ahead of the send');

    // bootstrap.ts: the stamp is captured before sendPromptToPty, and the
    // registration is a void fire-and-forget after it.
    const bsBlock = bootstrapTs.substring(
        bootstrapTs.indexOf('const hasDispatch = dispatch !== undefined && dispatch !== null;'),
        bootstrapTs.indexOf('    };', bootstrapTs.indexOf('const hasDispatch = dispatch !== undefined && dispatch !== null;'))
    );
    assert.ok(bsBlock.indexOf('parsedDispatchedAt = new Date().toISOString()') < bsBlock.indexOf('await sendPromptToPty'),
        'bootstrap.ts must capture the stamp before sendPromptToPty');
    assert.ok(/void kanbanProvider\.handleServiceVerb\('attributePastedPrompt'/.test(bsBlock), 'bootstrap.ts must fire-and-forget the registration via void');
    assert.ok(bsBlock.includes('.catch(() =>'), 'bootstrap.ts registration must be swallowed, never able to fail the send');
    assert.ok(!/await kanbanProvider\.handleServiceVerb\('attributePastedPrompt'/.test(bsBlock), 'bootstrap.ts must NOT await the registration ahead of the send');
});

// 6. attributePasteDispatch with no dispatchedAt produces the same SQL
//    parameters as before this change (stamp defaults to now, updated_at stays
//    now-at-write-time). The SQL string itself is unchanged.
test('attributePasteDispatch defaults dispatchedAt to now and keeps the SQL string unchanged', () => {
    const body = kanbanDbTs.substring(
        kanbanDbTs.indexOf('public async attributePasteDispatch'),
        kanbanDbTs.indexOf('public async clearWorkingState')
    );
    assert.ok(body.includes('const stamp = info.dispatchedAt || new Date().toISOString();'),
        'attributePasteDispatch must default dispatchedAt to now when absent (byte-identical for existing callers)');
    // updated_at must remain now-at-write-time, NOT the passed-in stamp.
    assert.ok(/updated_at = \?[\s\S]*new Date\(\)\.toISOString\(\), normalized, workspaceId/.test(body),
        'updated_at must stay now-at-write-time — only dispatched_at honours the explicit stamp');
    // The SQL string must be the same UPDATE as before.
    assert.ok(body.includes('UPDATE plans SET dispatched_agent = ?, dispatched_terminal = ?, dispatched_at = ?, updated_at = ? WHERE plan_file = ? AND workspace_id = ?'),
        'the attributePasteDispatch SQL string must be unchanged');
});

// 7. Source-text: both hosts guard the registration on the absence of
//    payload.dispatch — the parse-based path is unreachable when the strict
//    branch has already run. Assert the GUARD, not merely that the call exists;
//    a missing guard is invisible in every functional test because both writers
//    produce a correct-looking row.
test('both hosts guard the parse-based registration on the absence of payload.dispatch', () => {
    // TaskViewerProvider: hasDispatch is computed, and the parse only runs
    // inside `if (!hasDispatch)`. The registration is gated on
    // parsedDispatchIdentity which is only populated in that branch.
    const tvParseBlock = taskViewerTs.substring(
        taskViewerTs.indexOf('const hasDispatch = payload?.dispatch !== undefined && payload?.dispatch !== null;'),
        taskViewerTs.indexOf('if (hasDispatch) {', taskViewerTs.indexOf('const hasDispatch = payload?.dispatch !== undefined && payload?.dispatch !== null;'))
    );
    assert.ok(/if \(!hasDispatch\) \{/.test(tvParseBlock), 'TaskViewerProvider must parse only when !hasDispatch');
    assert.ok(tvParseBlock.includes('extractDispatchIdentity(payload.data)'),
        'TaskViewerProvider must call extractDispatchIdentity inside the !hasDispatch guard');
    // The registration call must be gated on parsedDispatchIdentity (null when
    // hasDispatch, so the call is unreachable in the strict branch).
    const tvRegBlock = taskViewerTs.substring(
        taskViewerTs.indexOf('if (parsedDispatchIdentity && parsedDispatchedAt && this._kanbanProvider)'),
        taskViewerTs.indexOf('return {', taskViewerTs.indexOf('if (parsedDispatchIdentity && parsedDispatchedAt && this._kanbanProvider)'))
    );
    assert.ok(tvRegBlock.length > 0 && tvRegBlock.includes('handleServiceVerb(\'attributePastedPrompt\''),
        'TaskViewerProvider registration must be gated on parsedDispatchIdentity (null under hasDispatch)');

    // bootstrap.ts: hasDispatch is computed from the dispatch param, and the
    // parse only runs inside `if (!hasDispatch)`.
    const bsParseBlock = bootstrapTs.substring(
        bootstrapTs.indexOf('const hasDispatch = dispatch !== undefined && dispatch !== null;'),
        bootstrapTs.indexOf('await sendPromptToPty', bootstrapTs.indexOf('const hasDispatch = dispatch !== undefined && dispatch !== null;'))
    );
    assert.ok(/if \(!hasDispatch\) \{/.test(bsParseBlock), 'bootstrap.ts must parse only when !hasDispatch');
    assert.ok(bsParseBlock.includes('extractDispatchIdentity(text)'),
        'bootstrap.ts must call extractDispatchIdentity inside the !hasDispatch guard');
    const bsRegBlock = bootstrapTs.substring(
        bootstrapTs.indexOf('if (parsedDispatchIdentity && parsedDispatchedAt && kanbanProvider)'),
        bootstrapTs.indexOf('    };', bootstrapTs.indexOf('if (parsedDispatchIdentity && parsedDispatchedAt && kanbanProvider)'))
    );
    assert.ok(bsRegBlock.length > 0 && bsRegBlock.includes('handleServiceVerb(\'attributePastedPrompt\''),
        'bootstrap.ts registration must be gated on parsedDispatchIdentity (null under hasDispatch)');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }

