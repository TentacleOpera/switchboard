'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const Module = require('module');

const shimPath = path.join(__dirname, '..', '..', 'out', 'standalone', 'vscodeShim.js');
const originalLoad = Module._load;
Module._load = function (request) {
    if (request === 'vscode') return require(shimPath);
    return originalLoad.apply(this, arguments);
};

const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { TERMINALS_GROUPS_KEY } = require('../../out/services/teamWiring');

function makeDb({ drive = true, groups = [], dispatchedAgent = 'Coding-lead' } = {}) {
    const store = {
        feature_drive_enabled: drive ? 'true' : 'false',
        [TERMINALS_GROUPS_KEY]: groups,
        'terminals.agentGroups': [],
        'kanban.featureWatches': [{ featureId: 'existing', headTerminal: 'other-lead', armedAt: 1, lastNudgedAt: 0 }],
    };
    let tail = Promise.resolve();
    return {
        ensureReady: async () => true,
        getConfig: async key => store[key] ?? null,
        getConfigJson: async (key, fallback) => key in store ? structuredClone(store[key]) : fallback,
        setConfigJson: async (key, value) => { store[key] = structuredClone(value); return true; },
        updateConfigJson: async (key, fallback, updater) => {
            let result;
            const update = tail.then(async () => {
                const current = key in store ? structuredClone(store[key]) : fallback;
                result = await updater(current);
                store[key] = structuredClone(result);
            });
            tail = update.catch(() => {});
            await update;
            return result;
        },
        getPlanBySessionId: async () => ({ dispatchedAgent }),
        store,
    };
}

function makeProvider(db, liveness = [], fleet = []) {
    const provider = Object.create(KanbanProvider.prototype);
    provider._getKanbanDb = () => db;
    provider._taskViewerProvider = {
        getFleetLiveness: () => liveness,
        listFleetTerminals: async () => fleet,
    };
    return provider;
}

async function main() {
    const noTeamDb = makeDb({ groups: [] });
    const noTeamProvider = makeProvider(noTeamDb);
    assert.strictEqual(await noTeamProvider._resolveTeamRosterForPrompt('/missing-workspace'), null);
    assert.strictEqual(await noTeamProvider._buildDrivePrefix('/missing-workspace', [{ planId: 'p1' }]), null);

    const groups = [{
        id: 'coding-team',
        name: 'Coding-lead',
        headRole: 'lead',
        teamGroup: true,
        members: ['Coding-lead', 'Coding-coder-1', 'Coding-intern'],
    }];
    const liveness = [
        { friendlyName: 'Coding-lead', status: 'active' },
        { friendlyName: 'Coding-coder-1', status: 'active' },
        { friendlyName: 'Coding-intern', status: 'exited' },
    ];
    const fleet = [
        { friendlyName: 'Coding-coder-1', role: 'coder' },
        { friendlyName: 'Coding-intern', role: 'intern' },
    ];
    const teamDb = makeDb({ groups });
    const teamProvider = makeProvider(teamDb, liveness, fleet);
    assert.deepStrictEqual(await teamProvider._resolveTeamRosterForPrompt('/missing-workspace'), [
        { name: 'Coding-coder-1', role: 'coder', active: true },
        { name: 'Coding-intern', role: 'intern', active: false },
    ]);
    const prefix = await teamProvider._buildDrivePrefix('/missing-workspace', [{ planId: 'feature-1', isFeature: true, absolutePath: '/ws/feature.md' }, { planId: 'subtask-1', isSubtask: true, absolutePath: '/ws/sub1.md' }]);
    for (const required of ['YOUR TEAM:', 'Coding-coder-1 (coder) — active', 'Coding-intern (intern) — exited', 'Do NOT query kanban.db directly', 'FEATURE WATCH: Armed by the system', 'FEATURE FILE:', 'Team Dispatch Instructions']) {
        assert.ok(prefix.includes(required), `enriched prefix must contain ${required}`);
    }
    // Plan IDs are no longer in the prefix's SUBTASKS section — they're in the feature file.
    assert.ok(!prefix.includes('SUBTASKS:'), 'enriched prefix must not contain a SUBTASKS section');
    // The skill file pointer has been removed.
    assert.ok(!prefix.includes('terminal-coder-dispatch/SKILL.md'), 'enriched prefix must not reference the deleted skill file');
    // The 7 inlined rules are present.
    for (const rule of ['Every finding cites a plan clause', 'Name the defect, never the mechanism', 'Never issue a git verb', 'You are unattended when no human is demonstrably reading', 'Subtask blocked after escalation']) {
        assert.ok(prefix.includes(rule), `enriched prefix must contain inlined rule: ${rule}`);
    }
    assert.ok(!prefix.includes('watchFeature'), 'enriched prefix must not tell the lead to arm a second watch');

    // --- Resolved-port case: temp workspace with a port file ---
    // The existing prefix (line 85) uses '/missing-workspace' which has no port file,
    // so portResolved is false and the "Do NOT read" directive is absent. To test the
    // resolved-port case, create a temp directory with a real port file.
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drive-test-'));
    fs.mkdirSync(path.join(tmpDir, '.switchboard'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, '.switchboard', 'api-server-port.txt'), '58312');
    const resolvedPrefix = await teamProvider._buildDrivePrefix(tmpDir, [{ planId: 'feature-1', isFeature: true, absolutePath: '/ws/feature.md' }, { planId: 'subtask-1', isSubtask: true, absolutePath: '/ws/sub1.md' }]);
    assert.ok(resolvedPrefix.includes('Do NOT read .switchboard/api-server-port.txt'), 'prefix must tell the lead not to re-read the port file when port is resolved');
    assert.ok(resolvedPrefix.includes('Do NOT check your own terminal name'), 'prefix must tell the lead not to check its terminal name');
    assert.ok(!resolvedPrefix.includes('Your terminal name is in $SWITCHBOARD_TERMINAL'), 'prefix must not surface the terminal-name line');
    assert.ok(!resolvedPrefix.includes('(also in .switchboard/api-server-port.txt)'), 'prefix must not point at the port file');
    fs.rmSync(tmpDir, { recursive: true, force: true });

    // --- Fallback case: no port file (existing prefix from line 85 uses '/missing-workspace') ---
    // The existing `prefix` variable already has no port file, so the "Do NOT read"
    // directive must NOT be present.
    assert.ok(!prefix.includes('Do NOT read .switchboard/api-server-port.txt'), 'prefix must not prohibit port-file reads when the port was not resolved');

    const noRoleProvider = makeProvider(makeDb({ groups }), liveness, []);
    assert.deepStrictEqual((await noRoleProvider._resolveTeamRosterForPrompt('/missing-workspace')).map(row => row.role), ['', '']);

    const card = { isFeature: true, planId: 'feature-1', sessionId: 'feature-session' };
    await Promise.all([
        teamProvider._autoArmDriveModeFeatureWatch(card, '/missing-workspace'),
        teamProvider._autoArmDriveModeFeatureWatch({ ...card, planId: 'feature-2', sessionId: 'feature-session-2' }, '/missing-workspace'),
    ]);
    const watches = teamDb.store['kanban.featureWatches'];
    assert.deepStrictEqual(watches.map(watch => watch.featureId).sort(), ['existing', 'feature-1', 'feature-2']);
    for (const watch of watches.filter(item => item.featureId.startsWith('feature-'))) {
        // NO stopColumns. The nudge keys on each subtask's completion post
        // (`completed_at`), never on kanbanColumn: a card enters a column when it
        // reaches the team and does not leave while the team works it, so the column
        // is CONSTANT for the whole run. Arming with ['CODE REVIEWED'] emptied the
        // watch's remaining-work set on the first tick for any feature whose subtasks
        // already sat there, so the one backstop for a lead that never posts deleted
        // itself before observing anything.
        assert.strictEqual(watch.stopColumns, undefined,
            'the auto-arm must not carry a column — acceptance is the lead\'s post, not a board position');
        assert.strictEqual(watch.headTerminal, 'Coding-lead');
    }

    const nonDriveDb = makeDb({ drive: false, groups });
    await makeProvider(nonDriveDb, liveness, fleet)._autoArmDriveModeFeatureWatch(card, '/missing-workspace');
    assert.deepStrictEqual(nonDriveDb.store['kanban.featureWatches'].map(watch => watch.featureId), ['existing']);

    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'KanbanProvider.ts'), 'utf8');
    const triggerArmCalls = (source.match(/await this\._autoArmDriveModeFeatureWatch\(card, workspaceRoot\);/g) || []).length;
    assert.strictEqual(triggerArmCalls, 2, 'both successful triggerAction dispatch branches must auto-arm exactly once');

    // --- The FEATURE FILE line's promise must be true ---
    // The prefix now tells the lead "its Subtasks section has plan IDs" and the SUBTASKS
    // section that used to carry them was deleted from the prompt. If _regenerateFeatureFile
    // stops emitting the ID, the lead has no plan ID for the `dispatch` field anywhere and
    // the only recovery is the kanban.db query the prefix forbids — with every other gate
    // green, because nothing else reads that line.
    const featureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'feature-regen-'));
    fs.mkdirSync(path.join(featureDir, '.switchboard', 'features'), { recursive: true });
    const featureRel = path.join('.switchboard', 'features', 'my-feature.md');
    fs.writeFileSync(path.join(featureDir, featureRel), '# My Feature\n\n## Goal\n\nDo the thing.\n');
    const regenDb = {
        getPlanByPlanId: async () => ({ planId: 'feat-uuid', planFile: featureRel, isFeature: true }),
        getSubtasksByFeatureId: async () => [
            { planId: 'sub-uuid-1', planFile: '.switchboard/plans/sub-one.md', topic: 'Sub One', kanbanColumn: 'CREATED', complexity: '3' },
            { planId: null, planFile: '.switchboard/plans/sub-two.md', topic: 'Sub Two', kanbanColumn: 'CREATED', complexity: '' },
        ],
        getWorktrees: async () => [],
    };
    await Object.create(KanbanProvider.prototype)._regenerateFeatureFile(featureDir, 'feat-uuid', regenDb);
    const regenerated = fs.readFileSync(path.join(featureDir, featureRel), 'utf8');
    assert.ok(
        regenerated.includes('- [ ] [Sub One](../plans/sub-one.md) — **CREATED** — ID: sub-uuid-1'),
        'the auto-generated Subtasks line must carry the subtask plan ID'
    );
    assert.ok(
        regenerated.includes('- [ ] [Sub Two](../plans/sub-two.md) — **CREATED**\n'),
        'a subtask with no planId must emit the line unchanged, not a dangling "— ID:"'
    );
    fs.rmSync(featureDir, { recursive: true, force: true });

    console.log('Drive-mode prompt overhaul contract PASSED');
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
