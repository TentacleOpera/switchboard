'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    getNextTerminalName,
    getNextAutobanTerminalName,
    MAX_TERMINALS_PER_ROLE,
    MAX_AUTOBAN_TERMINALS_PER_ROLE,
    MISSION_CONTROL_TERMINAL_NAME,
    buildAutobanBroadcastState,
    normalizeAutobanConfigState,
    normalizeMissionControlConfig,
    normalizeMissionRunConfig,
} = require(path.join(process.cwd(), 'out', 'services', 'autobanState.js'));

async function run() {
    // 1. Terminal naming and limits
    assert.strictEqual(MAX_TERMINALS_PER_ROLE, 5, 'MAX_TERMINALS_PER_ROLE must be 5');
    assert.strictEqual(MAX_AUTOBAN_TERMINALS_PER_ROLE, 5, 'MAX_AUTOBAN_TERMINALS_PER_ROLE compat alias must be 5');
    assert.strictEqual(MISSION_CONTROL_TERMINAL_NAME, 'Mission Control');

    assert.strictEqual(
        getNextTerminalName('Reviewer', ['Reviewer', 'Reviewer 2', 'Reviewer 4']),
        'Reviewer 3',
        'terminal naming should use role-based sequential numbering and skip occupied names'
    );
    assert.strictEqual(
        getNextAutobanTerminalName('Coder', ['Coder', 'Coder 2']),
        'Coder 3',
        'getNextAutobanTerminalName compat alias should work identically'
    );

    // 2. Survivor state normalization
    const baseState = {
        missionControlArmed: true,
        pairProgrammingMode: 'cli-cli',
        aggressivePairProgramming: true,
        missionControlSeat: {
            terminalName: 'Mission Control',
            adoptedAt: 12345,
            instanceId: 'inst-1',
            customPrompt: 'Prompt',
        },
        missionControlConfig: {
            intervalMinutes: 25,
        },
    };

    const normalized = normalizeAutobanConfigState(baseState);
    assert.strictEqual(normalized.missionControlArmed, true);
    assert.strictEqual(normalized.pairProgrammingMode, 'cli-cli');
    assert.strictEqual(normalized.aggressivePairProgramming, true);
    assert.deepStrictEqual(normalized.missionControlSeat, baseState.missionControlSeat);
    assert.strictEqual(normalized.missionControlConfig.intervalMinutes, 25);

    // Compat alias reads (orchestrator -> missionControl)
    const legacyState = {
        orchestratorArmed: true,
        orchestratorSeat: {
            terminalName: 'Orchestrator',
            adoptedAt: 54321,
            instanceId: 'inst-legacy',
        },
        orchestrationConfig: {
            intervalMinutes: 15,
        },
    };
    const normalizedLegacy = normalizeAutobanConfigState(legacyState);
    assert.strictEqual(normalizedLegacy.missionControlArmed, true);
    assert.strictEqual(normalizedLegacy.missionControlSeat.terminalName, 'Orchestrator');
    assert.strictEqual(normalizedLegacy.missionControlConfig.intervalMinutes, 15);

    // Deleted keys are ignored and dropped
    const dirtyState = {
        enabled: true,
        batchSize: 4,
        rules: { CREATED: { enabled: true } },
        automationMode: 'scheduled',
        missionControlArmed: false,
    };
    const cleaned = normalizeAutobanConfigState(dirtyState);
    assert.strictEqual('enabled' in cleaned, false, 'deleted enabled key must be dropped');
    assert.strictEqual('batchSize' in cleaned, false, 'deleted batchSize key must be dropped');
    assert.strictEqual('rules' in cleaned, false, 'deleted rules key must be dropped');
    assert.strictEqual('automationMode' in cleaned, false, 'deleted automationMode key must be dropped');

    // 3. Broadcast state
    const broadcast = buildAutobanBroadcastState(baseState);
    assert.strictEqual(broadcast.missionControlArmed, true);
    assert.strictEqual(broadcast.pairProgrammingMode, 'cli-cli');
    assert.strictEqual(broadcast.aggressivePairProgramming, true);
    assert.strictEqual('enabled' in broadcast, false);
    assert.strictEqual('batchSize' in broadcast, false);

    // 4. Mission Control Config normalization
    assert.strictEqual(
        normalizeMissionControlConfig({ intervalMinutes: 45 }).intervalMinutes,
        45,
        'normalizeMissionControlConfig must read through a persisted intervalMinutes'
    );
    assert.strictEqual(
        normalizeMissionControlConfig({ intervalMinutes: 0 }).intervalMinutes,
        1,
        'intervalMinutes floors at 1'
    );
    assert.strictEqual(
        normalizeMissionControlConfig({ intervalMinutes: 999 }).intervalMinutes,
        999,
        'intervalMinutes has no ceiling'
    );
    assert.strictEqual(
        normalizeMissionControlConfig(undefined).intervalMinutes,
        10,
        'intervalMinutes defaults to 10 when absent'
    );
    assert.ok(
        !('enabled' in normalizeMissionControlConfig({ enabled: true, intervalMinutes: 10 })),
        'normalizeMissionControlConfig must not return an enabled field'
    );

    // 5. Mission run flavours
    if (typeof normalizeMissionRunConfig === 'function') {
        const unattendedRun = normalizeMissionRunConfig({ missionId: 'm-1', flavour: 'unattended' });
        const operationsRun = normalizeMissionRunConfig({ missionId: 'm-2', flavour: 'operations' });
        assert.strictEqual(unattendedRun.flavour, 'unattended');
        assert.strictEqual(operationsRun.flavour, 'operations');
    }

    const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
    const kanbanProviderSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');

    // 6. Deleted verbs from KanbanProvider
    for (const deadVerb of [
        'getAutobanConfig',
        'updateAutobanConfig',
        'toggleAutoban',
        'resetAutobanTimers',
        'toggleAutobanPause',
        'setWhenSchedule',
        'setAutomationMode'
    ]) {
        assert.ok(
            !kanbanProviderSource.includes(`case '${deadVerb}':`),
            `KanbanProvider must not contain the deleted autoban verb arm: ${deadVerb}`
        );
    }

    // 7. Surviving Mission Control commands
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const startCmd = packageJson.contributes.commands.find(c => c.command === 'switchboard.startOrchestrator');
    assert.ok(startCmd, 'switchboard.startOrchestrator must remain in package.json contributes.commands');
    const extensionSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.ok(
        extensionSrc.includes("registerCommand('switchboard.startOrchestrator'"),
        'switchboard.startOrchestrator must be registered in extension.ts'
    );

    // 8. Survivor scheduler jobs
    assert.ok(
        providerSource.includes('_startSurvivorJobsTimer'),
        'survivor jobs (fetch-plans, reconcile) must run on their own _startSurvivorJobsTimer'
    );
    assert.ok(
        providerSource.includes('_schedulerInFlight'),
        'the per-job in-flight guard (_schedulerInFlight) survives'
    );

    // 9. External prompt and contract
    const presetsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'schedulerPresets.ts'), 'utf8');
    assert.ok(
        /export const BOARD_DRIVING_CONTRACT = /.test(presetsSource),
        'the board-driving paragraph lives in schedulerPresets'
    );

    console.log('autoban state regression test passed');
}

run().catch((error) => {
    console.error('autoban state regression test failed:', error);
    process.exit(1);
});
