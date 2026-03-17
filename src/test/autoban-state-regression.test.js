'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    getEnabledSharedReviewerAutobanColumns,
    getNextAutobanTerminalName,
    buildAutobanBroadcastState,
    normalizeAutobanConfigState,
    normalizeAutobanBatchSize,
    shouldSkipSharedReviewerAutobanDispatch
} = require(path.join(process.cwd(), 'out', 'services', 'autobanState.js'));

async function run() {
    const baseState = {
        enabled: true,
        batchSize: 3,
        complexityFilter: 'all',
        routingMode: 'dynamic',
        maxSendsPerTerminal: 7,
        globalSessionCap: 50,
        sessionSendCount: 9,
        sendCounts: { Reviewer: 4 },
        terminalPools: { reviewer: ['Reviewer', 'Reviewer Backup'] },
        managedTerminalPools: { reviewer: ['Reviewer Backup'] },
        poolCursor: { reviewer: 1 },
        rules: {
            CREATED: { enabled: true, intervalMinutes: 10 },
            'LEAD CODED': { enabled: true, intervalMinutes: 15 },
            'CODER CODED': { enabled: true, intervalMinutes: 15 }
        }
    };

    const broadcast = buildAutobanBroadcastState(baseState, new Map([
        ['CREATED', 1000],
        ['LEAD CODED', 2000],
        ['CODER CODED', 3000]
    ]).entries());

    assert.strictEqual(broadcast.enabled, true, 'enabled flag should be preserved');
    assert.strictEqual(broadcast.batchSize, 3, 'batch size should be preserved');
    assert.strictEqual(broadcast.complexityFilter, 'all', 'complexity filter should be preserved');
    assert.strictEqual(broadcast.routingMode, 'dynamic', 'routing mode should be preserved');
    assert.strictEqual(broadcast.maxSendsPerTerminal, 7, 'per-terminal send caps should be preserved');
    assert.strictEqual(broadcast.globalSessionCap, 50, 'global session cap should be preserved');
    assert.strictEqual(broadcast.sessionSendCount, 9, 'session send count should be preserved');
    assert.deepStrictEqual(broadcast.sendCounts, { Reviewer: 4 }, 'send counters should be preserved');
    assert.deepStrictEqual(broadcast.terminalPools, { reviewer: ['Reviewer', 'Reviewer Backup'] }, 'terminal pools should be preserved');
    assert.deepStrictEqual(broadcast.managedTerminalPools, { reviewer: ['Reviewer Backup'] }, 'managed pool membership should be preserved');
    assert.deepStrictEqual(broadcast.poolCursor, { reviewer: 1 }, 'pool cursor should be preserved');
    assert.deepStrictEqual(
        broadcast.lastTickAt,
        { CREATED: 1000, 'LEAD CODED': 2000, 'CODER CODED': 3000 },
        'lastTickAt should be merged into broadcast state'
    );

    const emptyBroadcast = buildAutobanBroadcastState(baseState, []);
    assert.deepStrictEqual(emptyBroadcast.lastTickAt, {}, 'lastTickAt should be present even when no tick timestamps are tracked yet');

    const normalizedTwo = normalizeAutobanConfigState({ batchSize: 2 });
    assert.strictEqual(normalizedTwo.batchSize, 2, 'state normalization should preserve a supported batch size of 2');

    const broadcastFour = buildAutobanBroadcastState({ ...baseState, batchSize: 4 }, []);
    assert.strictEqual(broadcastFour.batchSize, 4, 'broadcast state should preserve a supported batch size of 4');

    const normalizedLegacy = normalizeAutobanConfigState({
        enabled: true,
        batchSize: 0,
        rules: {
            CREATED: { enabled: false, intervalMinutes: 5 }
        }
    });
    assert.strictEqual(normalizedLegacy.batchSize, 3, 'legacy states should fall back to the default batch size when persisted data is invalid');
    assert.strictEqual(normalizeAutobanBatchSize(2), 2, 'batch-size normalization should preserve 2');
    assert.strictEqual(normalizeAutobanBatchSize(4), 4, 'batch-size normalization should preserve 4');
    assert.strictEqual(normalizeAutobanBatchSize(9), 5, 'batch-size normalization should clamp oversized values to 5');
    assert.strictEqual(normalizedLegacy.complexityFilter, 'all', 'legacy states should default complexity filtering to all');
    assert.strictEqual(normalizedLegacy.routingMode, 'dynamic', 'legacy states should default routing mode to dynamic');
    assert.strictEqual(normalizedLegacy.maxSendsPerTerminal, 10, 'legacy states should default per-terminal autoban caps to 10');
    assert.strictEqual(normalizedLegacy.globalSessionCap, 200, 'legacy states should default the global autoban session cap to 200');
    assert.strictEqual(normalizedLegacy.sessionSendCount, 0, 'legacy states should default the session send count to 0');
    assert.deepStrictEqual(normalizedLegacy.sendCounts, {}, 'legacy states should default send counters to an empty record');
    assert.deepStrictEqual(normalizedLegacy.terminalPools, {}, 'legacy states should default terminal pools to an empty record');
    assert.deepStrictEqual(normalizedLegacy.managedTerminalPools, {}, 'legacy states should default managed pools to an empty record');
    assert.deepStrictEqual(normalizedLegacy.poolCursor, {}, 'legacy states should default pool cursors to an empty record');
    assert.deepStrictEqual(
        normalizedLegacy.rules['PLAN REVIEWED'],
        { enabled: true, intervalMinutes: 20 },
        'legacy states should restore missing default column rules'
    );
    assert.deepStrictEqual(
        normalizedLegacy.rules['LEAD CODED'],
        { enabled: true, intervalMinutes: 15 },
        'legacy states should restore the lead coded autoban rule'
    );
    assert.deepStrictEqual(
        normalizedLegacy.rules['CODER CODED'],
        { enabled: true, intervalMinutes: 15 },
        'legacy states should restore the coder coded autoban rule'
    );

    const normalizedLegacyCodedRule = normalizeAutobanConfigState({
        rules: {
            CODED: { enabled: false, intervalMinutes: 9 }
        }
    });
    assert.deepStrictEqual(
        normalizedLegacyCodedRule.rules['LEAD CODED'],
        { enabled: false, intervalMinutes: 9 },
        'legacy CODED autoban rules should be remapped onto LEAD CODED'
    );
    assert.deepStrictEqual(
        normalizedLegacyCodedRule.rules['CODER CODED'],
        { enabled: false, intervalMinutes: 9 },
        'legacy CODED autoban rules should be remapped onto CODER CODED'
    );

    const normalizedNewConfig = normalizeAutobanConfigState({
        batchSize: 8,
        maxSendsPerTerminal: 999,
        globalSessionCap: 0,
        sendCounts: { Reviewer: 2.9, '': 4 },
        terminalPools: { reviewer: ['Reviewer', 'Reviewer Backup', 'Reviewer', '', 'Three', 'Four', 'Five', 'Six'] },
        managedTerminalPools: { reviewer: ['Reviewer Backup', ''] },
        poolCursor: { reviewer: 2.4 }
    });
    assert.strictEqual(normalizedNewConfig.batchSize, 5, 'batch size should clamp to the supported 1..5 contract');
    assert.strictEqual(normalizedNewConfig.maxSendsPerTerminal, 100, 'per-terminal caps should clamp to the supported UI range');
    assert.strictEqual(normalizedNewConfig.globalSessionCap, 200, 'invalid global caps should fall back to the default safety cap');
    assert.deepStrictEqual(normalizedNewConfig.sendCounts, { Reviewer: 2 }, 'send counts should be normalized to non-negative integers');
    assert.deepStrictEqual(
        normalizedNewConfig.terminalPools,
        { reviewer: ['Reviewer', 'Reviewer Backup', 'Three', 'Four', 'Five'] },
        'terminal pools should be deduped, trimmed, and capped at five terminals'
    );
    assert.deepStrictEqual(
        normalizedNewConfig.managedTerminalPools,
        { reviewer: ['Reviewer Backup'] },
        'managed pools should be normalized the same way as configured pools'
    );
    assert.deepStrictEqual(normalizedNewConfig.poolCursor, { reviewer: 2 }, 'pool cursors should normalize to integer counters');

    assert.deepStrictEqual(
        getEnabledSharedReviewerAutobanColumns({
            'LEAD CODED': { enabled: true, intervalMinutes: 15 },
            'CODER CODED': { enabled: false, intervalMinutes: 15 }
        }),
        ['LEAD CODED'],
        'shared reviewer lane helpers should only include enabled coded columns'
    );
    assert.strictEqual(
        shouldSkipSharedReviewerAutobanDispatch(
            2_000,
            new Map([
                ['LEAD CODED', 2_000],
                ['CODER CODED', 1_500]
            ]),
            ['LEAD CODED', 'CODER CODED']
        ),
        true,
        'shared reviewer ticks should skip when the lane already dispatched in the current window'
    );
    assert.strictEqual(
        shouldSkipSharedReviewerAutobanDispatch(
            1_000,
            { 'LEAD CODED': 1_500, 'CODER CODED': 1_200 },
            ['LEAD CODED', 'CODER CODED']
        ),
        false,
        'shared reviewer ticks should retry when the last success predates the latest coded tick'
    );
    assert.strictEqual(
        getNextAutobanTerminalName('Reviewer', ['Reviewer', 'Reviewer 2', 'Reviewer 4']),
        'Reviewer 3',
        'autoban backup terminals should use role-based sequential numbering and skip occupied names'
    );
    assert.strictEqual(
        getNextAutobanTerminalName('Coder', ['Coder', 'Coder 2']),
        'Coder 3',
        'autoban numbering should be role-specific instead of sharing a global suffix sequence'
    );
    assert.strictEqual(
        getNextAutobanTerminalName('Lead Coder', ['Reviewer Backup', 'Reviewer Backup 2'], 'Reviewer Backup'),
        'Reviewer Backup 3',
        'explicitly requested backup terminal names should still be deduped safely'
    );

    const providerSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
    const implementationSource = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'implementation.html'), 'utf8');

    assert.ok(
        providerSource.includes('_selectAutobanTerminal(') &&
        providerSource.includes('updateAutobanMaxSends') &&
        providerSource.includes('addAutobanTerminal') &&
        providerSource.includes('resetAutobanPools'),
        'TaskViewerProvider should keep the pooled-autoban selection helper and new pool-management message handlers'
    );
    assert.ok(
        providerSource.includes('const batchSize = normalizeAutobanBatchSize(this._autobanState.batchSize);'),
        'TaskViewerProvider should reuse shared autoban batch-size normalization instead of a local numeric fallback'
    );
    assert.ok(
        providerSource.includes('targetTerminalOverride?: string') &&
        providerSource.includes('selection.terminalName'),
        'TaskViewerProvider should preserve the terminal-override dispatch seam for autoban pools'
    );
    assert.ok(
        providerSource.includes('remainingDispatches: Math.min(selectedEntry.remaining, this._getAutobanRemainingSessionCapacity())') &&
        providerSource.includes('await this._recordAutobanDispatch(targetRole, selection.terminalName, 1, selection.effectivePool);') &&
        providerSource.includes('const batch = eligibleCards.slice(0, batchSize);'),
        'autoban send/session caps should count dispatches, not individual plans inside a batch'
    );
    assert.ok(
        providerSource.includes('getNextAutobanTerminalName(roleLabel, usedNames, resolvedRequestedName || undefined)') &&
        !providerSource.includes('await vscode.window.showInputBox({') &&
        !implementationSource.includes('window.prompt('),
        'autoban add-terminal flow should auto-name backups in the extension instead of prompting in the webview or VS Code'
    );
    assert.ok(
        providerSource.includes('private _getAutobanReviewerLaneColumns(sourceColumn: string): string[]') &&
        providerSource.includes("const reviewerLaneColumns = this._getAutobanReviewerLaneColumns(sourceColumn);") &&
        providerSource.includes("this._collectKanbanCardsInColumns(workspaceRoot, reviewerLaneColumns)") &&
        providerSource.includes("this._autobanLaneLastDispatchAt.set('coded-reviewer', Date.now());"),
        'TaskViewerProvider should coordinate LEAD CODED and CODER CODED as one shared reviewer autoban lane'
    );
    assert.ok(
        providerSource.includes('private async _reconcileAutobanPoolState(') &&
        providerSource.includes("const alivePrimaryRoleTerminals = await this._getAliveAutobanTerminalNames(role, workspaceRoot, false);") &&
        providerSource.includes("const effectivePool = reconciledConfiguredPool.length > 0 ? reconciledConfiguredPool : alivePrimaryRoleTerminals;") &&
        providerSource.includes("if (this._isAutobanBackupTerminalInfo(info) && !aliveTerminals[name])") &&
        providerSource.includes("await this._reconcileAutobanPoolState(workspaceRoot, { pruneStaleBackupRegistry: true });"),
        'TaskViewerProvider should reconcile autoban pools against alive terminals during restore/reset and prune stale autoban-backup registry entries'
    );
    assert.match(
        providerSource,
        /private\s+async\s+_tryRestoreAutoban\(\):\s*Promise<void>\s*\{[\s\S]*await\s+this\._reconcileAutobanPoolState\(workspaceRoot,\s*\{\s*pruneStaleBackupRegistry:\s*true\s*\}\);/s,
        'Autoban restore should reconcile pool state before rebroadcasting restored config'
    );
    assert.match(
        providerSource,
        /private\s+async\s+_resetAutobanPools\(\):\s*Promise<void>\s*\{[\s\S]*for\s*\(const\s+terminalName\s+of\s+managedTerminalNames\)[\s\S]*await\s+this\._reconcileAutobanPoolState\(workspaceRoot,\s*\{\s*pruneStaleBackupRegistry:\s*true\s*\}\);/s,
        'CLEAR & RESET should re-run autoban pool reconciliation after closing managed backup terminals'
    );
    assert.ok(
        implementationSource.includes('MAX SENDS / TERMINAL') &&
        implementationSource.includes('TERMINAL POOLS') &&
        implementationSource.includes('CLEAR & RESET') &&
        implementationSource.includes("type: 'addAutobanTerminal'"),
        'implementation.html should render the send-cap control and terminal-pool management actions'
    );
    assert.match(
        implementationSource,
        /const\s+aliveRoleTerminals\s*=\s*Object\.keys\(lastTerminals\)[\s\S]*resolveTerminalLiveness\(name\)\.alive[\s\S]*const\s+alivePrimaryRoleTerminals\s*=\s*aliveRoleTerminals[\s\S]*autoban-backup[\s\S]*const\s+effectivePool\s*=\s*\(\s*configuredPool\.length\s*>\s*0\s*\?\s*configuredPool\.filter\(name\s*=>\s*aliveRoleTerminals\.includes\(name\)\)\s*:\s*alivePrimaryRoleTerminals\s*\)\.slice\(0,\s*5\);/s,
        'Autoban webview should render configured pools through alive/effective-pool filtering and only fall back to confirmed-alive primary role terminals'
    );

    console.log('autoban state regression test passed');
}

run().catch((error) => {
    console.error('autoban state regression test failed:', error);
    process.exit(1);
});
