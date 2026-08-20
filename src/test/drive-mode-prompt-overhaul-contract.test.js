'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
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
    const prefix = await teamProvider._buildDrivePrefix('/missing-workspace', [{ planId: 'feature-1' }, { planId: 'subtask-1' }]);
    for (const required of ['YOUR TEAM:', 'Coding-coder-1 (coder) — active', 'Coding-intern (intern) — exited', 'feature-1', 'subtask-1', 'Do NOT query kanban.db directly', 'FEATURE WATCH: Armed by the system']) {
        assert.ok(prefix.includes(required), `enriched prefix must contain ${required}`);
    }
    assert.ok(!prefix.includes('watchFeature'), 'enriched prefix must not tell the lead to arm a second watch');

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
        assert.deepStrictEqual(watch.stopColumns, ['CODE REVIEWED']);
        assert.strictEqual(watch.headTerminal, 'Coding-lead');
    }

    const nonDriveDb = makeDb({ drive: false, groups });
    await makeProvider(nonDriveDb, liveness, fleet)._autoArmDriveModeFeatureWatch(card, '/missing-workspace');
    assert.deepStrictEqual(nonDriveDb.store['kanban.featureWatches'].map(watch => watch.featureId), ['existing']);

    const source = fs.readFileSync(path.join(__dirname, '..', 'services', 'KanbanProvider.ts'), 'utf8');
    const triggerArmCalls = (source.match(/await this\._autoArmDriveModeFeatureWatch\(card, workspaceRoot\);/g) || []).length;
    assert.strictEqual(triggerArmCalls, 2, 'both successful triggerAction dispatch branches must auto-arm exactly once');
    console.log('Drive-mode prompt overhaul contract PASSED');
}

main().catch(error => {
    console.error(error.stack || error);
    process.exit(1);
});
