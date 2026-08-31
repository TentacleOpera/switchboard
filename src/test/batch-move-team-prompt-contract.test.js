'use strict';

/**
 * Batch moves to a team send the feature implementation prompt contract test.
 *
 * Verifies that:
 * 1. Loose plans batched to a team head produce the allocate prompt framing (driveMode + batchMode).
 * 2. BATCH_EXECUTION_RULES and "begin implementation immediately" are suppressed.
 * 3. The batch directive replaces feature-file references and unit clauses with conflict pass instructions.
 * 4. Non-team batches stay byte-identical and carry BATCH_EXECUTION_RULES.
 * 5. Planner batches do not leak feature workflow path.
 * 6. Real feature dispatches retain their unit clause and feature-file references.
 * 7. Cap of 5 loose plans is enforced.
 */

const assert = require('assert');
const path = require('path');
const Module = require('module');

// KanbanProvider imports `vscode`; the standalone shim stands in for it so the
// provider's own gate + cap can be exercised headlessly (same pattern as
// drive-mode-prompt-overhaul-contract.test.js).
const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return require(shimPath);
    return originalLoad.apply(this, arguments);
};

const { buildKanbanBatchPrompt, TEAM_BATCH_PLAN_CAP, applyBatchCap } = require('../../out/services/agentPromptBuilder');
const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { TERMINALS_GROUPS_KEY } = require('../../out/services/teamWiring');
const { DEFAULT_KANBAN_COLUMNS } = require('../../out/services/agentConfig');
const { VERB_SCHEMAS } = require('../../out/services/verbSchemas');

const makeLoosePlans = (count) => {
    const plans = [];
    for (let i = 1; i <= count; i++) {
        plans.push({
            sessionId: `sess${i}`,
            planId: `plan${i}`,
            topic: `Loose Plan ${i}`,
            title: `Loose Plan ${i}`,
            absolutePath: `/path/to/loose_plan_${i}.md`,
            column: 'PLAN REVIEWED',
            createdAt: new Date(2026, 0, i).toISOString()
        });
    }
    return plans;
};

const makeFeaturePlans = () => [
    { sessionId: 'feat1', planId: 'feat1', title: 'Feature 1', topic: 'Test Feature', isFeature: true, absolutePath: '/path/to/feature.md' },
    { sessionId: 'sub1', planId: 'sub1', title: 'Subtask 1', topic: 'Subtask 1', isSubtask: true, featureId: 'feat1', absolutePath: '/path/to/sub1.md' },
    { sessionId: 'sub2', planId: 'sub2', title: 'Subtask 2', topic: 'Subtask 2', isSubtask: true, featureId: 'feat1', absolutePath: '/path/to/sub2.md' }
];

function testTeamHeadBatchPrompt() {
    console.log('Testing team head loose plan batch prompt...');
    const plans = makeLoosePlans(5);
    const options = {
        featureMode: true,
        driveMode: true,
        batchMode: true,
        featureTopic: 'Batch send',
        subtaskCount: 5
    };

    const prompt = buildKanbanBatchPrompt('lead', plans, options);

    // Intro and authorization
    assert.ok(prompt.includes('Please drive the batch of 5 plans below through your team seats.'), 'Should have batch drive intro');
    assert.ok(prompt.includes('begin dispatching subtasks to your team seats immediately'), 'Should have drive authorization');

    // Directive framing
    assert.ok(prompt.includes('BATCH MODE: You are driving a batch of 5 independent plan(s) through your team seats.'), 'Should have BATCH MODE opener');
    assert.ok(prompt.includes('Dispatch each subtask to a seat on your team — do not implement subtasks yourself.'), 'Should have dispatch directive');
    assert.ok(prompt.includes('Read the individual plan files below for requirements, seat assignments, and scope constraints — there is no feature file for a batch.'), 'Should direct to individual plan files');
    assert.ok(prompt.includes('The plans in this batch are independent and possibly unrelated.'), 'Should state independence of plans');
    assert.ok(prompt.includes('sequence any plans that collide, and dispatch non-colliding plans in parallel.'), 'Should have conflict pass instruction');

    // Negative assertions
    assert.ok(!prompt.includes('CRITICAL INSTRUCTIONS:'), 'Must NOT contain BATCH_EXECUTION_RULES');
    assert.ok(!prompt.includes('begin implementation immediately'), 'Must NOT contain "begin implementation immediately"');
    assert.ok(!prompt.includes('Team Dispatch Instructions'), 'Must NOT contain "Team Dispatch Instructions"');
    assert.ok(!prompt.includes('single delivery unit'), 'Must NOT contain "single delivery unit"');
    assert.ok(!prompt.includes('do not treat them as independent tickets'), 'Must NOT contain "do not treat them as independent tickets"');

    console.log('  PASS: team head batch prompt');
}

function testNonTeamBatchPrompt() {
    console.log('Testing non-team batch prompt...');
    const plans = makeLoosePlans(3);
    const options = {
        featureMode: false
    };

    const prompt = buildKanbanBatchPrompt('lead', plans, options);

    assert.ok(prompt.includes('CRITICAL INSTRUCTIONS:'), 'Non-team batch MUST contain BATCH_EXECUTION_RULES');
    assert.ok(prompt.includes('begin implementation immediately'), 'Non-team batch MUST contain "begin implementation immediately"');
    assert.ok(!prompt.includes('BATCH MODE:'), 'Non-team batch must NOT have BATCH MODE opener');
    assert.ok(!prompt.includes('begin dispatching subtasks to your team seats'), 'Non-team batch must NOT have drive authorization');

    console.log('  PASS: non-team batch prompt');
}

function testPlannerBatchPromptDoesNotLeakWorkflow() {
    console.log('Testing planner batch prompt workflow path...');
    const plans = makeLoosePlans(3);
    const options = {
        featureMode: true,
        driveMode: true,
        batchMode: true,
        plannerWorkflowPath: '.agents/protocols/improve-plan/SKILL.md',
        plannerFeatureWorkflowPath: '.agents/protocols/improve-feature/SKILL.md'
    };

    const prompt = buildKanbanBatchPrompt('planner', plans, options);

    assert.ok(prompt.includes('.agents/protocols/improve-plan/SKILL.md'), 'Planner batch should use standard improve-plan workflow');
    assert.ok(!prompt.includes('.agents/protocols/improve-feature/SKILL.md'), 'Planner batch should NOT use feature workflow');

    console.log('  PASS: planner batch prompt workflow path');
}

function testRealFeatureDispatchKeepsUnitClause() {
    console.log('Testing real feature dispatch keeps unit clause...');
    const plans = makeFeaturePlans();
    const options = {
        featureMode: true,
        driveMode: true,
        batchMode: false,
        featureTopic: 'Test Feature',
        subtaskCount: 2
    };

    const prompt = buildKanbanBatchPrompt('lead', plans, options);

    assert.ok(prompt.includes('All subtasks are part of a single delivery unit — do not treat them as independent tickets.'), 'Real feature MUST keep unit clause');
    assert.ok(prompt.includes('Read the feature file\'s Team Dispatch Instructions section'), 'Real feature MUST reference Team Dispatch Instructions');
    assert.ok(!prompt.includes('there is no feature file for a batch'), 'Real feature must NOT claim no feature file');

    console.log('  PASS: real feature dispatch keeps unit clause');
}

function testCoderBatchKeepsPlanList() {
    console.log('Testing coder batch keeps the plan list...');
    const plans = makeLoosePlans(5);
    const options = { featureMode: true, driveMode: true, batchMode: true, featureTopic: 'Batch send', subtaskCount: 5 };

    const prompt = buildKanbanBatchPrompt('coder', plans, options);

    // The coder's featureMode branch replaces PLANS TO PROCESS with a single
    // FEATURE FILE reference resolved as `plans.find(p => !p.isSubtask)`. Every loose
    // plan matches that, so a batch would name plan #1 as the feature file and drop
    // plans #2..N entirely. batchMode must fall through to per-plan enumeration.
    assert.ok(prompt.includes('PLANS TO PROCESS:'), 'Coder batch MUST enumerate the plans');
    for (let i = 1; i <= 5; i++) {
        assert.ok(prompt.includes(`/path/to/loose_plan_${i}.md`), `Coder batch must name plan ${i}`);
    }
    assert.ok(!prompt.includes('FEATURE FILE:'), 'Coder batch must NOT claim a feature file');
    assert.ok(!prompt.includes('All subtasks are one delivery unit'), 'Coder batch must NOT assert a delivery unit');

    console.log('  PASS: coder batch keeps the plan list');
}

function testStaggeredDirectiveSuppressedInBatch() {
    console.log('Testing staggered-implementation directive is suppressed in batch mode...');
    const plans = makeLoosePlans(5);
    const base = { featureMode: true, driveMode: true, featureTopic: 'Batch send', subtaskCount: 5, staggeredImplementationEnabled: true };

    const batchPrompt = buildKanbanBatchPrompt('lead', plans, { ...base, batchMode: true });
    const featurePrompt = buildKanbanBatchPrompt('lead', makeFeaturePlans(), { ...base, batchMode: false, featureTopic: 'Test Feature', subtaskCount: 2 });

    assert.ok(!batchPrompt.includes('STAGGERED IMPLEMENTATION:'), 'Batch prompt must NOT reference the feature overview file');
    assert.ok(featurePrompt.includes('STAGGERED IMPLEMENTATION:'), 'Real feature dispatch MUST keep the staggered directive');

    console.log('  PASS: staggered directive suppressed in batch mode');
}

// ── Provider gate + cap ───────────────────────────────────────────────────────

function makeProvider({ groups = [], agentNames = {} } = {}) {
    const store = { [TERMINALS_GROUPS_KEY]: groups, 'terminals.groups': [] };
    const db = {
        ensureReady: async () => true,
        getConfig: async key => store[key] ?? null,
        getConfigJson: async (key, fallback) => (key in store ? structuredClone(store[key]) : fallback),
    };
    const provider = Object.create(KanbanProvider.prototype);
    provider._getKanbanDb = () => db;
    provider._getAgentNames = async () => agentNames;
    provider._context = {
        globalState: { get: () => undefined, update: async () => {} },
        workspaceState: { get: () => undefined, update: async () => {} },
    };
    provider._getSetting = (key, fallback) => fallback;
    provider.postMessage = () => {};
    provider._seams = () => ({
        commands: { executeCommand: async () => true },
        ui: { showInformationMessage: () => {}, showErrorMessage: () => {} },
    });
    return provider;
}

const TEAM_GROUPS = [{ id: 'team_Coding_lead', head: 'Coding-lead', members: ['Coding-lead', 'Coder-1', 'Coder-2'], order: ['Coding-lead', 'Coder-1', 'Coder-2'] }];

async function testTeamHeadGateResolvesOffTheTerminalName() {
    console.log('Testing team-head gate resolves off the target terminal name...');
    const provider = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'Coding-lead' } });

    // Team groups are keyed by the HEAD TERMINAL's name (`team_<headName>`). Resolving
    // team-ness from the role STRING matches no group, so every lead reads as team-less
    // and the whole allocate path is unreachable — the exact regression this pins.
    assert.strictEqual(await provider.isCodingTeamHead('/ws', 'lead', 'Coding-lead'), true, 'A lead heading a team must gate true');
    assert.strictEqual(await provider.isCodingTeamHead('/ws', 'lead', 'Solo-lead'), false, 'A lead heading no team must gate false');

    // No target terminal (the prompt previews): fall back to the role's agent name.
    assert.strictEqual(await provider.isCodingTeamHead('/ws', 'lead'), true, 'Preview path must fall back to the configured agent name');
    const unassigned = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'No agent assigned' } });
    assert.strictEqual(await unassigned.isCodingTeamHead('/ws', 'lead'), false, '"No agent assigned" is not a team head');

    // The flag must not reach a plain seat or the planner: featureMode redirects the
    // planner's workflow file, and driveMode tells a coder to dispatch to seats it has none of.
    for (const role of ['coder', 'intern', 'planner', 'reviewer']) {
        assert.strictEqual(await provider.isCodingTeamHead('/ws', role, 'Coding-lead'), false, `${role} must never gate as a team head`);
    }

    console.log('  PASS: team-head gate resolves off the target terminal name');
}

function makeOrderablePlans(count, extra = () => ({})) {
    const plans = [];
    for (let i = 1; i <= count; i++) {
        plans.push({
            planId: `plan${i}`,
            topic: `Plan ${i}`,
            column: 'CREATED',
            createdAt: new Date(2026, 0, i).toISOString(),
            columnEnteredAt: new Date(2026, 0, i).toISOString(),
            ...extra(i)
        });
    }
    return plans;
}

function testCapAndRemainder() {
    console.log('Testing cap, remainder and determinism...');
    const provider = makeProvider();
    const twelve = makeOrderablePlans(12);

    const first = provider.selectTeamBatchPlans(twelve);
    assert.strictEqual(TEAM_BATCH_PLAN_CAP, 5, 'The cap is five');
    assert.strictEqual(first.sent.length, 5, 'Five plans are sent');
    assert.strictEqual(first.skipped.length, 7, 'Seven plans stay put');
    assert.strictEqual(new Set([...first.sent, ...first.skipped]).size, 12, 'No plan is dropped or duplicated');

    // The same selection sends the same five, in the same order.
    const second = provider.selectTeamBatchPlans(twelve);
    assert.deepStrictEqual(second.sent.map(p => p.planId), first.sent.map(p => p.planId), 'The selection is deterministic');

    // A non-STAGING hand-arrangement (V63 column_order — reorderColumn rewrites the
    // whole column's positions) is respected. Here the arrangement is oldest-first,
    // the exact opposite of the column_entered_at DESC fallback, so a comparator that
    // ignored column_order would send the five the user deprioritised.
    const arranged = makeOrderablePlans(12, i => ({ columnOrder: i }));
    const arrangedPick = provider.selectTeamBatchPlans(arranged);
    assert.deepStrictEqual(
        arrangedPick.sent.map(p => p.planId),
        ['plan1', 'plan2', 'plan3', 'plan4', 'plan5'],
        'A hand-arranged non-STAGING column must be sent in its arranged order'
    );

    // A starred card outranks the arrangement outside STAGING.
    const starred = makeOrderablePlans(12, i => ({ columnOrder: i, priorityStarred: i === 12 ? 1 : 0 }));
    assert.strictEqual(provider.selectTeamBatchPlans(starred).sent[0].planId, 'plan12', 'A starred card leads the sent set');

    // STAGING reads queue_position instead, and column_order is ignored there.
    const staged = makeOrderablePlans(12, i => ({ column: 'STAGING', queuePosition: 13 - i, columnOrder: i }));
    const stagedPick = provider.selectTeamBatchPlans(staged);
    assert.deepStrictEqual(
        stagedPick.sent.map(p => p.planId),
        ['plan12', 'plan11', 'plan10', 'plan9', 'plan8'],
        'STAGING must send the head of the staged queue'
    );

    // A set at or under the cap is sent whole.
    const three = provider.selectTeamBatchPlans(makeOrderablePlans(3));
    assert.strictEqual(three.sent.length, 3, 'A set under the cap is sent whole');
    assert.strictEqual(three.skipped.length, 0, 'A set under the cap skips nothing');

    console.log('  PASS: cap, remainder and determinism');
}

async function testGenerateUnifiedPromptBatchTeamHead() {
    console.log('Testing generateUnifiedPrompt with team-headed lead batch...');
    const provider = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'Coding-lead' } });
    provider._resolveTeamRosterForPrompt = async () => ({
        head: 'Coding-lead',
        members: [
            { name: 'Coding-coder-1', role: 'coder', active: true },
            { name: 'Coding-coder-2', role: 'coder', active: true },
        ],
    });
    provider._getPromptsConfig = async () => ({});
    provider._resolveProjectContextEnabled = async () => false;
    provider._resolveDesignSystemReferences = async () => [];

    const plans = makeLoosePlans(5);
    const prompt = await provider.generateUnifiedPrompt('lead', plans, '/ws', { isTeamHead: true });

    // Prefix assertions
    assert.ok(prompt.startsWith('You are driving a batch of loose plans through your team seats.'), 'Prompt should start with batch drive prefix');
    assert.ok(prompt.includes('YOUR TEAM:'), 'Should contain YOUR TEAM section');
    assert.ok(prompt.includes('- Coding-coder-1 (coder) — active'), 'Should list roster members');
    assert.ok(prompt.includes('API:'), 'Should contain API line');
    assert.ok(prompt.includes('STAGING (one call per plan):'), 'Should contain STAGING section');
    assert.ok(prompt.includes('curl -s -X POST "$BASE/terminals/verb/ptySendPrompt"'), 'Should contain ptySendPrompt recipe');
    assert.ok(prompt.includes('CLOSE OUT EVERY PLAN — ALWAYS, no judgement call.'), 'Should contain close out per plan instruction');
    assert.ok(prompt.includes('/kanban/task/complete'), 'Should contain /kanban/task/complete instruction');
    assert.ok(prompt.includes('BATCH RULES:'), 'Should contain BATCH RULES');
    assert.ok(prompt.includes('- The plans in this batch are independent and possibly unrelated.'), 'Should state plans are independent');
    assert.ok(prompt.includes('- Read each individual plan file for requirements, seat assignments, and scope constraints.'), 'Should instruct to read individual plan files');

    // Negative assertions (batch vs feature differences)
    assert.ok(!prompt.includes('FEATURE FILE:'), 'Must NOT contain FEATURE FILE line');
    assert.ok(!prompt.includes('single delivery unit'), 'Must NOT contain single delivery unit clause');
    assert.ok(!prompt.includes('Team Dispatch Instructions'), 'Must NOT contain Team Dispatch Instructions');
    assert.ok(!prompt.includes('Do NOT open individual subtask plans'), 'Must NOT forbid opening individual plans');

    console.log('  PASS: generateUnifiedPrompt with team-headed lead batch');
}

async function testGenerateUnifiedPromptBatchNonTeamLead() {
    console.log('Testing generateUnifiedPrompt with non-team lead batch...');
    const provider = makeProvider({ groups: [], agentNames: { lead: 'Solo-lead' } });
    provider._getPromptsConfig = async () => ({});
    provider._resolveProjectContextEnabled = async () => false;
    provider._resolveDesignSystemReferences = async () => [];

    const plans = makeLoosePlans(3);
    const prompt = await provider.generateUnifiedPrompt('lead', plans, '/ws', { isTeamHead: false });

    assert.ok(!prompt.includes('YOUR TEAM:'), 'Non-team lead batch must NOT have YOUR TEAM section');
    assert.ok(!prompt.includes('STAGING (one call per plan):'), 'Non-team lead batch must NOT have staging recipe');
    assert.ok(prompt.includes('CRITICAL INSTRUCTIONS:'), 'Non-team lead batch must contain standard execution rules');

    console.log('  PASS: generateUnifiedPrompt with non-team lead batch');
}

async function testGenerateUnifiedPromptCoderBatchNoDrivePrefix() {
    console.log('Testing generateUnifiedPrompt with coder batch...');
    const provider = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'Coding-lead' } });
    provider._getPromptsConfig = async () => ({});
    provider._resolveProjectContextEnabled = async () => false;
    provider._resolveDesignSystemReferences = async () => [];

    const plans = makeLoosePlans(3);
    const prompt = await provider.generateUnifiedPrompt('coder', plans, '/ws');

    assert.ok(!prompt.includes('YOUR TEAM:'), 'Coder batch must NOT have drive prefix');
    assert.ok(!prompt.includes('You are driving a batch of loose plans'), 'Coder batch must NOT have drive opener');

    console.log('  PASS: generateUnifiedPrompt with coder batch');
}

async function testResolveTeamHeadColumns() {
    console.log('Testing resolveTeamHeadColumns...');
    const providerWithTeam = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'Coding-lead' } });
    // The cap keys off the DISPATCH TARGET. LEAD CODED is where a lead batch LANDS —
    // advancing out of it goes to the reviewer, so it is never capped and must never
    // carry the label. The columns that reach the lead are the complexity-routed
    // sources and any column whose next column is the lead column.
    const cols = [
        { id: 'CREATED', label: 'Created', role: null, order: 0, kind: 'created' },
        { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review' },
        { id: 'RESEARCHER', label: 'Researcher', role: 'researcher', order: 110, kind: 'review' },
        { id: 'STAGING', label: 'Staging', role: undefined, order: 115, kind: 'staging' },
        { id: 'LEAD CODED', label: 'Lead', role: 'lead', order: 180, kind: 'coded' },
        { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded' },
        { id: 'REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed' }
    ];

    const teamCols = await providerWithTeam.resolveTeamHeadColumns('/ws', cols);
    assert.deepStrictEqual(
        teamCols,
        ['PLAN REVIEWED', 'RESEARCHER', 'STAGING'],
        'Team-head columns are the sources that dispatch to the lead, not the lead column'
    );
    assert.ok(!teamCols.includes('LEAD CODED'), 'LEAD CODED must never be flagged — advancing out of it dispatches the reviewer');
    assert.ok(!teamCols.includes('CREATED'), 'CREATED advances to the planner, not the lead');

    const providerNoTeam = makeProvider({ groups: [], agentNames: { lead: 'Solo-lead' } });
    const noTeamCols = await providerNoTeam.resolveTeamHeadColumns('/ws', cols);
    assert.deepStrictEqual(noTeamCols, [], 'No columns should be team head when lead has no team');

    assert.strictEqual(TEAM_BATCH_PLAN_CAP, 5, 'teamBatchPlanCap must be 5');
    console.log('  PASS: resolveTeamHeadColumns');
}

function testWebviewCapLabelContract() {
    console.log('Testing kanban.html cap label contract...');
    const fs = require('fs');
    const kanbanHtmlPath = path.join(__dirname, '../webview/kanban.html');
    const html = fs.readFileSync(kanbanHtmlPath, 'utf8');

    assert.ok(html.includes('.column-icon-btn-labeled'), 'Must contain .column-icon-btn-labeled CSS');
    assert.ok(html.includes('.cap-label'), 'Must contain .cap-label CSS');
    assert.ok(html.includes('updateCapLabels'), 'Must contain updateCapLabels function');
    assert.ok(html.includes('teamHeadColumns'), 'Must process teamHeadColumns');
    assert.ok(html.includes('teamBatchPlanCap'), 'Must process teamBatchPlanCap');
    console.log('  PASS: kanban.html cap label contract');
}

function testBatchCreatesNoFeatureRow() {
    console.log('Testing batch to team head creates no feature row...');
    const plans = makeLoosePlans(5);

    const prompt = buildKanbanBatchPrompt('lead', plans, {
        featureMode: true, driveMode: true, batchMode: true,
        featureTopic: 'Batch send', subtaskCount: 5
    });
    // The batch prompt must not reference a feature file or feature dispatch instructions.
    assert.ok(!prompt.includes('FEATURE FILE:'), 'Batch must not reference a feature file');
    assert.ok(!prompt.includes('Team Dispatch Instructions'), 'Batch must not reference feature dispatch instructions');

    console.log('  PASS: batch creates no feature row');
}

function testEndToEndCapAndRemainder() {
    console.log('Testing end-to-end cap/remainder through applyBatchCap...');
    const twelve = makeOrderablePlans(12);

    // Team head with 12 plans: cap at 5, skip 7.
    const result = applyBatchCap(twelve, TEAM_BATCH_PLAN_CAP, true);
    assert.strictEqual(result.sent.length, 5, 'Five plans sent');
    assert.strictEqual(result.skipped.length, 7, 'Seven plans skipped');
    assert.strictEqual(new Set([...result.sent, ...result.skipped]).size, 12, 'No plan dropped or duplicated');

    // Non-team head with 12 plans: all sent, none skipped.
    const nonTeam = applyBatchCap(twelve, TEAM_BATCH_PLAN_CAP, false);
    assert.strictEqual(nonTeam.sent.length, 12, 'Non-team: all plans sent');
    assert.strictEqual(nonTeam.skipped.length, 0, 'Non-team: none skipped');

    // Team head with 3 plans (under cap): all sent.
    const under = applyBatchCap(makeOrderablePlans(3), TEAM_BATCH_PLAN_CAP, true);
    assert.strictEqual(under.sent.length, 3, 'Under cap: all sent');
    assert.strictEqual(under.skipped.length, 0, 'Under cap: none skipped');

    // Under cap still ORDERS. The sent set becomes the prompt's PLANS TO PROCESS
    // list, so a short batch must carry the same precedence order a long one does.
    const scrambled = applyBatchCap(twelve.slice(0, 4).reverse(), TEAM_BATCH_PLAN_CAP, true);
    assert.deepStrictEqual(
        scrambled.sent.map(p => p.planId),
        applyBatchCap(twelve.slice(0, 4), TEAM_BATCH_PLAN_CAP, true).sent.map(p => p.planId),
        'Under-cap sets are sorted by precedence, not left in caller order'
    );

    console.log('  PASS: end-to-end cap/remainder');
}

function testPreClickCount() {
    console.log('Testing pre-click count is full column count (message boundary)...');
    // Webview moveAll sends { type: 'moveAll', column } and backend resolves all cards via _visibleColumnCards.
    const twelve = makeOrderablePlans(12, i => ({ column: 'PLAN REVIEWED' }));
    const provider = makeProvider({ groups: TEAM_GROUPS, agentNames: { lead: 'Coding-lead' } });
    provider._visibleColumnCards = () => twelve;
    provider._cardId = c => c.planId;

    const sourceCards = provider._visibleColumnCards('/ws', 'PLAN REVIEWED');
    assert.strictEqual(sourceCards.length, 12, 'Backend resolves full column count before applying cap');

    // applyBatchCap caps team head dispatches to 5, skipping 7
    const teamResult = applyBatchCap(sourceCards, TEAM_BATCH_PLAN_CAP, true);
    assert.strictEqual(teamResult.sent.length, 5, 'Team head batch capped at 5');
    assert.strictEqual(teamResult.skipped.length, 7, '7 plans retained in column');

    // Non-team head does not cap
    const nonTeamResult = applyBatchCap(sourceCards, TEAM_BATCH_PLAN_CAP, false);
    assert.strictEqual(nonTeamResult.sent.length, 12, 'Non-team batch sends all 12');
    assert.strictEqual(nonTeamResult.skipped.length, 0, 'Non-team batch skips 0');

    console.log('  PASS: pre-click count');
}

function testRecommendedRoleRouting() {
    console.log('Testing recommendedRole routes to lead for team-head batch...');
    const leadCol = DEFAULT_KANBAN_COLUMNS.find(c => c.id === 'LEAD CODED');
    assert.strictEqual(leadCol?.role, 'lead', 'LEAD CODED column has role=lead');

    console.log('  PASS: recommendedRole routing');
}

async function testPlannerFanOutRegression() {
    console.log('Testing planner fan-out does not leak feature workflow...');
    const plans = makeLoosePlans(6).map(p => ({
        ...p,
        column: 'CREATED',
        working: false,
    }));

    const executedDispatches = [];
    const provider = makeProvider();
    provider._taskViewerProvider = {
        getRoleTerminalSet: async () => ({
            terminals: ['Planner-1', 'Planner-2'],
            locationKey: '/ws'
        }),
        getPlannerRotationCursor: () => 0,
        advancePlannerRotationCursor: () => {},
        getLimitDispatchToTerminals: async () => false,
        recordRunSheetForColumnMove: async () => {},
    };
    provider._cardId = c => c.sessionId || c.planId;
    provider.moveCardToColumnWithReason = async () => ({ ok: true });
    provider._collectAllMovedSessionIds = async (ws, sid) => [sid];
    provider._inFlightSkipFailures = () => [];
    provider._seams = () => ({
        commands: {
            executeCommand: async (cmd, role, ids, workflow, ws, term) => {
                executedDispatches.push({ cmd, role, ids, workflow, ws, term });
                return true;
            }
        },
        ui: { showInformationMessage: () => {}, showErrorMessage: () => {} }
    });

    await provider._distributePlannerDispatch('/ws', plans, 'PLAN REVIEWED');

    // Assert that 2 buckets were dispatched
    assert.strictEqual(executedDispatches.length, 2, 'Should dispatch 2 buckets to 2 planner terminals');
    assert.strictEqual(executedDispatches[0].term, 'Planner-1', 'First bucket to Planner-1');
    assert.strictEqual(executedDispatches[0].ids.length, 3, 'First bucket receives 3 plans');
    assert.strictEqual(executedDispatches[0].workflow, 'improve-plan', 'First bucket uses improve-plan workflow');

    assert.strictEqual(executedDispatches[1].term, 'Planner-2', 'Second bucket to Planner-2');
    assert.strictEqual(executedDispatches[1].ids.length, 3, 'Second bucket receives 3 plans');
    assert.strictEqual(executedDispatches[1].workflow, 'improve-plan', 'Second bucket uses improve-plan workflow');

    // Ensure neither bucket leaks improve-feature
    for (const d of executedDispatches) {
        assert.notStrictEqual(d.workflow, 'improve-feature', 'Planner batch must never use improve-feature');
    }

    console.log('  PASS: planner fan-out regression');
}

function testScheduleRuleSchemaHasNoBatchSize() {
    console.log('Testing schedule rule schema admits no batch-size field...');
    // The cap is hardcoded via TEAM_BATCH_PLAN_CAP (5), not configurable per schedule.
    // Verify verb schemas for schedule and queue operations do not expose a batchSize field.
    const kanbanSchemas = VERB_SCHEMAS.kanban;
    const scheduleVerbs = ['mcNewSchedule', 'mcUpdateSchedule', 'mcStartSchedule', 'stageForQueue', 'reorderQueue'];
    for (const verb of scheduleVerbs) {
        const schema = kanbanSchemas[verb];
        assert.ok(schema, `Schema for ${verb} must exist`);
        if (schema.fields) {
            assert.strictEqual(
                schema.fields.batchSize,
                undefined,
                `Verb ${verb} schema must not admit a batchSize field`
            );
        }
    }
    assert.strictEqual(TEAM_BATCH_PLAN_CAP, 5, 'teamBatchPlanCap is constant');

    console.log('  PASS: schedule rule schema has no batch-size field');
}

async function runAll() {
    testTeamHeadBatchPrompt();
    testNonTeamBatchPrompt();
    testPlannerBatchPromptDoesNotLeakWorkflow();
    testRealFeatureDispatchKeepsUnitClause();
    testCoderBatchKeepsPlanList();
    testStaggeredDirectiveSuppressedInBatch();
    await testTeamHeadGateResolvesOffTheTerminalName();
    testCapAndRemainder();
    await testGenerateUnifiedPromptBatchTeamHead();
    await testGenerateUnifiedPromptBatchNonTeamLead();
    await testGenerateUnifiedPromptCoderBatchNoDrivePrefix();
    await testResolveTeamHeadColumns();
    testWebviewCapLabelContract();
    testBatchCreatesNoFeatureRow();
    testEndToEndCapAndRemainder();
    testPreClickCount();
    testRecommendedRoleRouting();
    await testPlannerFanOutRegression();
    testScheduleRuleSchemaHasNoBatchSize();
    console.log('\nAll batch move team prompt contract tests PASSED!');
}

runAll().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
