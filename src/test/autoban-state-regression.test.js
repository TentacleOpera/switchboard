'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    getEnabledSharedReviewerAutobanColumns,
    getNextAutobanTerminalName,
    buildAutobanBroadcastState,
    normalizeAutobanConfigState,
    normalizeAutomationMode,
    normalizeMissionControlConfig,
    normalizeAutobanBatchSize,
    normalizeSingleColumnConfig,
    normalizeScheduleRule,
    normalizeMissionRunConfig,
    shouldSkipSharedReviewerAutobanDispatch
} = require(path.join(process.cwd(), 'out', 'services', 'autobanState.js'));

async function run() {
    const baseState = {
        enabled: true,
        batchSize: 3,
        complexityFilter: 'all',
        routingMode: 'dynamic',
        rules: {
            CREATED: { enabled: true, intervalMinutes: 10 },
            'INTERN CODED': { enabled: true, intervalMinutes: 15 },
            'LEAD CODED': { enabled: true, intervalMinutes: 15 },
            'CODER CODED': { enabled: true, intervalMinutes: 15 }
        }
    };

    const broadcast = buildAutobanBroadcastState(baseState, new Map([
        ['CREATED', 1000],
        ['INTERN CODED', 1500],
        ['LEAD CODED', 2000],
        ['CODER CODED', 3000]
    ]).entries());

    assert.strictEqual(broadcast.enabled, true, 'enabled flag should be preserved');
    assert.strictEqual(broadcast.batchSize, 3, 'batch size should be preserved');
    assert.strictEqual(broadcast.complexityFilter, 'all', 'complexity filter should be preserved');
    assert.strictEqual(broadcast.routingMode, 'dynamic', 'routing mode should be preserved');
    assert.deepStrictEqual(
        broadcast.lastTickAt,
        { CREATED: 1000, 'INTERN CODED': 1500, 'LEAD CODED': 2000, 'CODER CODED': 3000 },
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
    assert.strictEqual(normalizedLegacy.batchSize, 1, 'legacy states should fall back to the default batch size when persisted data is invalid');
    assert.strictEqual(normalizeAutobanBatchSize(2), 2, 'batch-size normalization should preserve 2');
    assert.strictEqual(normalizeAutobanBatchSize(4), 4, 'batch-size normalization should preserve 4');
    assert.strictEqual(normalizeAutobanBatchSize(9), 5, 'batch-size normalization should clamp oversized values to 5');
    assert.strictEqual(normalizedLegacy.complexityFilter, 'all', 'legacy states should default complexity filtering to all');
    assert.strictEqual(normalizedLegacy.routingMode, 'dynamic', 'legacy states should default routing mode to dynamic');
    assert.deepStrictEqual(
        normalizedLegacy.rules['PLAN REVIEWED'],
        { enabled: true, intervalMinutes: 20 },
        'legacy states should restore missing default column rules'
    );
    assert.deepStrictEqual(
        normalizedLegacy.rules['INTERN CODED'],
        { enabled: true, intervalMinutes: 15 },
        'legacy states should restore the intern coded autoban rule with default 15-minute interval'
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
    assert.deepStrictEqual(
        normalizedLegacyCodedRule.rules['INTERN CODED'],
        { enabled: true, intervalMinutes: 15 },
        'legacy CODED autoban rules should NOT remap onto INTERN CODED (intern column postdates the split)'
    );

    const normalizedNewConfig = normalizeAutobanConfigState({
        batchSize: 8
    });
    assert.strictEqual(normalizedNewConfig.batchSize, 5, 'batch size should clamp to the supported 1..5 contract');

    assert.deepStrictEqual(
        getEnabledSharedReviewerAutobanColumns({
            'LEAD CODED': { enabled: true, intervalMinutes: 15 },
            'CODER CODED': { enabled: true, intervalMinutes: 15 },
            'INTERN CODED': { enabled: true, intervalMinutes: 15 }
        }),
        ['LEAD CODED', 'CODER CODED', 'INTERN CODED'],
        'shared reviewer lane helpers should include all three enabled coded columns'
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
        providerSource.includes('_selectAutobanTerminal('),
        'TaskViewerProvider should keep the autoban terminal selection helper'
    );
    assert.ok(
        providerSource.includes('const batchSize = normalizeAutobanBatchSize(this._autobanState.batchSize);'),
        'TaskViewerProvider should reuse shared autoban batch-size normalization instead of a local numeric fallback'
    );
    // The run sheet's per-step terminal pick (`selection.terminalName`) went with
    // `_autobanTickColumn`. The seam it fed did NOT: the schedule now reaches the
    // same dispatch machinery through the queue pop, which forces the requesting
    // head as the target terminal. Pin the seam and its surviving caller — pinning
    // the deleted call site would just re-assert the run sheet.
    assert.ok(
        providerSource.includes('targetTerminalOverride?: string'),
        'TaskViewerProvider should preserve the terminal-override dispatch seam for autoban pools'
    );
    assert.ok(
        /dispatchNextFromQueue\(\{\s*workspaceRoot,\s*from:\s*headTerminal\s*\}\)/.test(providerSource),
        'the schedule must dispatch through the queue pop with the resolved head as `from` — not re-implement a pop or walk a run sheet'
    );
    // The schedule's own batch cap. `batchSize` bounds how many pops one tick
    // makes; each pop dispatches exactly one card, so the cap counts dispatches.
    assert.ok(
        /for \(let i = 0; i < batchSize; i\+\+\)/.test(providerSource),
        'autoban send/session caps should count dispatches, not individual plans inside a batch'
    );
    assert.ok(
        providerSource.includes('getNextAutobanTerminalName(roleLabel, usedNames, resolvedRequestedName || undefined)') &&
        !providerSource.includes('await vscode.window.showInputBox({') &&
        !implementationSource.includes('window.prompt('),
        'autoban add-terminal flow should auto-name backups in the extension instead of prompting in the webview or VS Code'
    );
    // "Strict column isolation" was a property of the per-column tick, which is
    // deleted — there is one clock and one pop now. What survives, and is still
    // worth pinning, is that column→role mapping is delegated rather than
    // re-derived locally.
    assert.ok(
        providerSource.includes('private _autobanColumnToRole(column: string): string | null') &&
        providerSource.includes('return columnToPromptRole(column);'),
        'TaskViewerProvider should delegate column-to-role mapping to columnToPromptRole'
    );

    // --- Completion-driven dispatch is DELETED ---
    // These three failure modes ("autoban dispatches exactly one card and the
    // board stops with no error") were all properties of inferring completion
    // from a plan-file mtime advance and feeding it back in as a dispatch
    // trigger. That whole hybrid is gone: the schedule pops on a clock, the
    // lead pops by asking, and the pop's own 409 is the only interlock. The
    // positive assertions that pinned `_autobanPlanFileKey` /
    // `_autobanDispatchedPlanFiles` are therefore replaced by the negative
    // assertions further down, which pin the deletion. What is kept here is
    // everything that guards the SURVIVING paths against re-acquiring a
    // completion gate.

    // 2. Tracking lifetime. handleKanbanBatchTrigger moves the card out of the
    //    source column BEFORE the prompt is sent, so _releaseSettledDispatchLocks
    //    drops the dispatch lock inside the same tick. Hanging the completion
    //    tracking (or the stall watchdog) off that lock means the gate is always
    //    shut by the time a turn-end arrives, minutes later.
    const releaseIdx = providerSource.indexOf('private _releaseSettledDispatchLocks(');
    assert.notStrictEqual(releaseIdx, -1, '_releaseSettledDispatchLocks must exist');
    // Strip `//` comment lines: these bodies carry explanatory comments that name
    // the very symbols the assertions forbid in CODE.
    const stripLineComments = (src) => src.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
    const releaseBody = stripLineComments(providerSource.slice(releaseIdx, providerSource.indexOf('\n    }', releaseIdx)));
    assert.ok(
        !releaseBody.includes('_autobanDispatchedPlanFiles') &&
        !releaseBody.includes('_clearAutobanStallWatchdog'),
        '_releaseSettledDispatchLocks must not clear completion tracking or stall watchdogs — that lock is released in the same tick as the dispatch'
    );
    const turnEndIdx = providerSource.indexOf('public handleAutobanTurnEnd(');
    assert.notStrictEqual(turnEndIdx, -1, 'handleAutobanTurnEnd must exist');
    const turnEndBody = stripLineComments(providerSource.slice(turnEndIdx, providerSource.indexOf('\n    }', turnEndIdx)));
    assert.ok(
        !turnEndBody.includes('_activeDispatchSessions'),
        'handleAutobanTurnEnd must not gate on (or mutate) _activeDispatchSessions — it is the tick path\'s short-lived re-dispatch lock, not a completion gate'
    );

    // 3. A tick that cannot dispatch must not kill the engine. The old routed
    //    tick expressed this as an intern->coder->lead fallback chain whose
    //    per-role helper (`dispatchWithAutobanTerminal`) had to avoid
    //    `_stopAutobanWithMessage`; that chain is deleted along with
    //    `_autobanTickColumn`. The same invariant now lives in
    //    `_scheduleQueuePop`: no live head, a 409, or an empty queue all end
    //    the loop and leave the schedule armed for the next tick. A tick that
    //    disarmed the schedule on a transient miss would be the same bug in a
    //    new place — one quiet minute and the night is over.
    const popIdx = providerSource.indexOf('private async _scheduleQueuePop(): Promise<void>');
    assert.notStrictEqual(popIdx, -1, '_scheduleQueuePop must exist');
    const popBody = stripLineComments(providerSource.slice(popIdx, providerSource.indexOf('\n    }', popIdx)));
    assert.ok(
        !popBody.includes('_stopAutobanWithMessage') && !popBody.includes('_stopAutobanEngine'),
        '_scheduleQueuePop must never stop the engine — no head, a 409, or an empty queue are normal outcomes for one tick'
    );
    assert.ok(
        /if \(status === 409\) \{ break; \}/.test(popBody),
        'the schedule must treat the pop\'s in-flight 409 as a normal loop-ending outcome — the pop is the only interlock'
    );

    // --- The schedule calls the queue pop ---
    // The run sheet, trigger modes, and completion hybrid are deleted.
    // The schedule calls _scheduleQueuePop, which resolves the live coding
    // head and calls dispatchNextFromQueue.
    assert.ok(
        /setInterval\(\(\) => \{\s*void this\._scheduleQueuePop\(\);\s*\}, intervalMinutes \* 60 \* 1000\)/.test(providerSource),
        '_startAutobanEngine must install the recurring schedule interval calling _scheduleQueuePop'
    );
    assert.ok(
        providerSource.includes('private async _scheduleQueuePop(): Promise<void>'),
        '_scheduleQueuePop must exist — the schedule dispatches via the queue pop, not the run sheet'
    );
    assert.ok(
        !providerSource.includes('private _enqueueRunSheetTick('),
        '_enqueueRunSheetTick must be deleted — the run sheet is no longer a decision structure'
    );
    assert.ok(
        !providerSource.includes('private _getAutobanRunSheet(): readonly AutobanRunSheetStep[]'),
        '_getAutobanRunSheet must be deleted — the run sheet accessor is removed'
    );
    assert.ok(
        !providerSource.includes('private _isCompletionTriggered('),
        '_isCompletionTriggered must be deleted — the trigger mode axis is removed'
    );
    assert.ok(
        !providerSource.includes('private _autobanTickColumn('),
        '_autobanTickColumn must be deleted — column ticks are replaced by the queue pop'
    );
    assert.ok(
        !providerSource.includes('private _armAutobanStallWatchdog('),
        '_armAutobanStallWatchdog must be deleted — completion tracking is removed'
    );
    assert.ok(
        !providerSource.includes('private _autobanLaneInFlight('),
        '_autobanLaneInFlight must be deleted — per-lane in-flight checks are removed'
    );
    assert.ok(
        !providerSource.includes('private _autobanDispatchedPlanFiles'),
        '_autobanDispatchedPlanFiles must be deleted — completion-driven dispatch tracking is removed'
    );

    // --- The empty-column sweep no longer checks in-flight tracking ---
    const stopIfEmptyIdx = providerSource.indexOf('private async _stopAutobanIfNoValidTicketsRemain(');
    assert.notStrictEqual(stopIfEmptyIdx, -1, '_stopAutobanIfNoValidTicketsRemain must exist');
    const stopIfEmptyBody = stripLineComments(
        providerSource.slice(stopIfEmptyIdx, providerSource.indexOf('\n    }', stopIfEmptyIdx))
    );
    assert.ok(
        !stopIfEmptyBody.includes('_autobanDispatchedPlanFiles'),
        'the empty-column sweep must not reference the deleted _autobanDispatchedPlanFiles'
    );

    // Trigger mode axis is deleted — the schedule calls the queue pop,
    // and a self-pacing lead calls it directly. No completion pacing.
    assert.ok(
        !turnEndBody.includes('_isCompletionTriggered'),
        'handleAutobanTurnEnd must not reference the deleted _isCompletionTriggered — completion pacing is removed'
    );

    // --- Both hosts can actually START it (PRD contracts #6 and #7) ---
    // The run-sheet engine is host-agnostic, but the UI reaches it through
    // `switchboard.*FromKanban` commands. Standalone's vscode shim makes
    // executeCommand a warn-once no-op, so a command registered only in
    // extension.ts leaves the browser cockpit's automation controls returning
    // success while the engine never starts. Every command the kanban arms invoke
    // must be registered in BOTH hosts.
    const extensionSource = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    const bootstrapSource = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
    for (const cmd of [
        'switchboard.setAutobanEnabledFromKanban',
        'switchboard.resetAutobanTimersFromKanban',
        'switchboard.setAutobanPausedFromKanban'
    ]) {
        assert.ok(
            extensionSource.includes(`'${cmd}'`),
            `${cmd} must be registered in the extension host`
        );
        assert.ok(
            bootstrapSource.includes(`switchboardCommandRegistry.register('${cmd}'`),
            `${cmd} must be registered in the standalone host too — otherwise the control fakes success under npx switchboard`
        );
    }
    assert.ok(
        providerSource.includes('public async restoreAutobanOnStartup()') &&
        bootstrapSource.includes('restoreAutobanOnStartup()'),
        'standalone must resume an armed board on startup — it has no sidebar `ready` handler to reach _tryRestoreAutoban'
    );

    // ─────────────────────────────────────────────────────────────────────────
    // Automation is a scheduler: internal/external modes + oversight as a flag.
    //
    // Every assertion below is one of the three plans' named "Automated" checks.
    // They exist because each of these failures is SILENT: no type error, no UI
    // symptom — just a clock running in the mode that is supposed to run none,
    // or two engines dispatching the same cards.
    // ─────────────────────────────────────────────────────────────────────────
    const kanbanProviderSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'KanbanProvider.ts'), 'utf8');

    // --- The mode axis default is INVERTED to `external` ---
    // The old default was `scheduled` (auto-start the clock). The inverted
    // default is `external` — a fresh install runs nothing until the user
    // explicitly arms a switch. Unknown/unrecognised values map to external.
    for (const legacy of ['multi-column', '', 'nonsense', undefined, null]) {
        assert.strictEqual(
            normalizeAutomationMode(legacy),
            'external',
            `an unrecognised automationMode of ${JSON.stringify(legacy)} must normalise to 'external' — the inverted default does NOT auto-start a clock`
        );
    }
    // Known legacy values still MAP for the synthetic field, but the guard
    // below forces enabled: false — they do NOT keep their clock running.
    for (const legacy of ['run-sheet', 'scheduler', 'single-column']) {
        assert.strictEqual(
            normalizeAutomationMode(legacy),
            'scheduled',
            `a persisted automationMode of ${JSON.stringify(legacy)} must MAP to 'scheduled' for the synthetic field — but the guard forces enabled: false`
        );
    }
    assert.strictEqual(
        normalizeAutomationMode('external'),
        'external',
        "'external' is the only value that normalises to external"
    );

    // --- Retired-mode guard: EVERY pre-two-switch state lands disabled ---
    // The whole mode axis is retired, not just the older aliases. `scheduled`
    // was the common running mode on shipped installs and `enabled: true` used
    // to mean "walk the run sheet over CREATED / PLAN REVIEWED"; under the new
    // engine the same flag means "pop the STAGING queue on a timer", so
    // carrying it across the upgrade starts dispatching from a queue the user
    // never staged. `agent-managed` is worse — it never installed a schedule
    // timer at all, so carrying `enabled` GIVES that install a clock it never
    // had. Both are the exact upgrade the plan's UAT forbids: "load a board
    // persisted with automationMode: 'scheduled', enabled: true. It must come
    // up disabled, with the notice, and dispatch nothing."
    const ALL_RETIRED_MODES = [
        'scheduled', 'agent-managed', 'external',
        'run-sheet', 'scheduler', 'single-column', 'orchestration', 'internal',
    ];
    for (const retired of ALL_RETIRED_MODES) {
        const normalized = normalizeAutobanConfigState({ automationMode: retired, enabled: true });
        assert.strictEqual(
            normalized.enabled, false,
            `a persisted automationMode of '${retired}' must force enabled: false — no pre-two-switch state may auto-dispatch after the upgrade`
        );
        assert.ok(
            typeof normalized.retiredAutomationModeNotice === 'string' && normalized.retiredAutomationModeNotice.length > 0,
            `a persisted automationMode of '${retired}' must set retiredAutomationModeNotice`
        );
    }
    // An unrecognised value is disarmed too — the discriminator is the ABSENCE
    // of the new switch, not membership of a value whitelist.
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'who-knows', enabled: true }).enabled, false,
        'an unrecognised persisted automationMode must also land disabled'
    );
    // ...and a state ALREADY written by the two-switch normaliser is left
    // alone, so the disarm is one-shot rather than a permanent lockout that
    // re-fires on every load and makes the schedule impossible to arm.
    const alreadyMigrated = normalizeAutobanConfigState({
        automationMode: 'scheduled', enabled: true, missionControlArmed: false,
    });
    assert.strictEqual(
        alreadyMigrated.enabled, true,
        'a state carrying missionControlArmed has already been migrated — the guard must not disarm it again'
    );
    assert.strictEqual(
        alreadyMigrated.retiredAutomationModeNotice, undefined,
        'an already-migrated state must NOT re-show the retired-mode notice'
    );
    // A state with no automationMode at all (a fresh install) is not a
    // migration and gets no notice.
    assert.strictEqual(
        normalizeAutobanConfigState({ enabled: true }).retiredAutomationModeNotice, undefined,
        'a state with no automationMode is a fresh install, not a migration'
    );
    // The guard fires even when enabled is absent (undefined) and the legacy
    // mode would otherwise derive enabled: true.
    const retiredNoEnabled = normalizeAutobanConfigState({ automationMode: 'run-sheet' });
    assert.strictEqual(
        retiredNoEnabled.enabled, false,
        "a retired mode with enabled absent must still force enabled: false — the guard is independent of the enabled flag"
    );

    // --- The migration table: three cohorts, all tested ---
    // `orchestration` → `agent-managed` (the retired peer mode)
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'orchestration' }).automationMode,
        'agent-managed',
        'the retired orchestration mode migrates to agent-managed'
    );
    // `internal` + `missionControlConfig.enabled === true` → `agent-managed` (the 150001 cohort)
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'internal', missionControlConfig: { enabled: true } }).automationMode,
        'agent-managed',
        'internal with oversight enabled migrates to agent-managed — the 150001 cohort must not lose its agent'
    );
    // bare `internal` → `external`. The old contract mapped it to `scheduled`
    // "so the majority cohort keeps ticking"; that is precisely the default
    // this feature inverts. There is no run sheet left to tick, and starting to
    // dispatch from a queue the user never staged is the worse failure.
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'internal' }).automationMode,
        'external',
        'bare internal migrates to external — the inverted default runs nothing until the user arms a switch'
    );

    // --- missionControlConfig.enabled is DELETED; intervalMinutes is RESTORED ---
    assert.strictEqual(
        normalizeMissionControlConfig({ intervalMinutes: 45 }).intervalMinutes,
        45,
        'normalizeMissionControlConfig must read through a persisted intervalMinutes, not hard-default past it'
    );
    assert.strictEqual(
        normalizeMissionControlConfig({ intervalMinutes: 0 }).intervalMinutes,
        1,
        'intervalMinutes floors at 1'
    );
    assert.strictEqual(
        normalizeMissionControlConfig({ intervalMinutes: 999 }).intervalMinutes,
        999,
        'intervalMinutes has no ceiling — "overnight" is a valid wake interval'
    );
    assert.strictEqual(
        normalizeMissionControlConfig(undefined).intervalMinutes,
        10,
        'intervalMinutes defaults to 10 when absent'
    );
    assert.ok(
        !('enabled' in normalizeMissionControlConfig({ enabled: true, intervalMinutes: 10 })),
        'normalizeMissionControlConfig must not return an enabled field — it is deleted'
    );
    assert.ok(
        !('maxConcurrentSubtasks' in normalizeMissionControlConfig({ maxConcurrentSubtasks: 5, intervalMinutes: 10 })),
        'normalizeMissionControlConfig must not return maxConcurrentSubtasks — it belongs to a fan-out model that is not part of this feature'
    );
    assert.ok(
        !('lastWakeAt' in normalizeMissionControlConfig({ lastWakeAt: '2026-01-01', intervalMinutes: 10 })),
        'normalizeMissionControlConfig must not return lastWakeAt — it is status the tab derives from the engine, not config'
    );

    // The attended oversight pass is DELETED, not flagged off.
    for (const dead of ['OversightPassService', 'isAutomationArmed', 'attachOversightWatcher']) {
        assert.ok(
            !providerSource.includes(dead),
            `TaskViewerProvider still references the deleted oversight pass (${dead})`
        );
    }
    // START DOES NOT ARM. Seating Mission Control opens a pre-flight interview;
    // arming is `POST /mission-control/confirm` → confirmMissionControlSession, after
    // the user has answered and the agent has written session.md. A Start that
    // arms is the original footgun — a click that silently begins an unattended
    // overnight run against a board that may have no coding team seated.
    //
    // Asserted on the source, not on a state read, because the failure mode is a
    // single surviving `enabled: true` line: the interview still runs, the agent
    // still waits, and the timer is already installed behind it. Every
    // behavioural check of the interview passes while the arm has already
    // happened. Scoped to the method BODY — the method is long enough that a
    // fixed char window runs past its closing brace.
    const startOrchStart = providerSource.indexOf('public async startMissionControlFromKanban');
    assert.ok(startOrchStart !== -1, 'startMissionControlFromKanban must exist');
    const startAfterSig = providerSource.slice(startOrchStart);
    const startNextDecl = startAfterSig.slice(1).search(/\n {4}(?:public|private|protected)\s/);
    const startOrchBody = startNextDecl === -1 ? startAfterSig : startAfterSig.slice(0, startNextDecl + 1);
    assert.ok(
        !/missionControlConfig:\s*\{[\s\S]*?enabled:\s*true/.test(startOrchBody),
        'startMissionControlFromKanban must not write missionControlConfig.enabled — the field is deleted'
    );
    assert.ok(
        !/enabled:\s*true/.test(startOrchBody),
        'startMissionControlFromKanban must NOT arm — it seats Mission Control and delivers the pre-flight; arming moved to confirmMissionControlSession'
    );
    assert.ok(
        !startOrchBody.includes('_stopAutobanEngine()'),
        'startMissionControlFromKanban must not tear down the schedule — the schedule and Mission Control are independent switches'
    );
    // The arming block sets the missionControlArmed switch. The mode axis is deleted
    // — no _stopAutobanEngine call, no exclusivity between schedule and Mission Control.
    const confirmStart = providerSource.indexOf('public async confirmMissionControlSession');
    assert.ok(confirmStart !== -1, 'confirmMissionControlSession must exist — it is the only path that arms');
    const confirmAfterSig = providerSource.slice(confirmStart);
    const confirmNextDecl = confirmAfterSig.slice(1).search(/\n {4}(?:public|private|protected)\s/);
    // Strip `//` lines before the negative assertions below, exactly as the
    // _releaseSettledDispatchLocks / handleAutobanTurnEnd checks do. The arming
    // block carries a comment that NAMES the call it is documenting the absence
    // of ("so no _stopAutobanEngine() call"), and an un-stripped body reads that
    // rationale as the very code it forbids.
    const confirmBody = stripLineComments(
        confirmNextDecl === -1 ? confirmAfterSig : confirmAfterSig.slice(0, confirmNextDecl + 1)
    );
    assert.ok(
        /missionControlArmed:\s*true/.test(confirmBody),
        'confirmMissionControlSession must set missionControlArmed = true — the mode axis is deleted, arming is a switch'
    );
    assert.ok(
        !/_stopAutobanEngine\(\)/.test(confirmBody),
        'confirmMissionControlSession must NOT call _stopAutobanEngine — the schedule and Mission Control are independent switches'
    );
    assert.ok(
        /session\.md/.test(confirmBody) && /success:\s*false/.test(confirmBody),
        'confirmMissionControlSession must refuse when session.md is absent — arming a session with no rules is the silent half-state'
    );
    // Scoped to the method BODY, not a fixed byte window. A character-count window
    // tracks the method's length: deleting the worktree-topology restore block shrank
    // this method enough that a 900-char window ran past its closing brace into
    // setAutomationModeFromKanban, whose _stopAutobanEngine() call is legitimate.
    const stopOrchStart = providerSource.indexOf('public async stopMissionControlFromKanban');
    assert.ok(stopOrchStart !== -1, 'stopMissionControlFromKanban must exist');
    const afterSig = providerSource.slice(stopOrchStart);
    const nextDeclOffset = afterSig.slice(1).search(/\n {4}(?:public|private|protected)\s/);
    const stopOrchBody = nextDeclOffset === -1 ? afterSig : afterSig.slice(0, nextDeclOffset + 1);
    assert.ok(
        !stopOrchBody.includes('_stopAutobanEngine()'),
        'stopMissionControlFromKanban must not stop the autoban engine — disarming Mission Control sets enabled=false, not _stopAutobanEngine()'
    );
    assert.ok(
        providerSource.includes('public isOversightAgentRunning(): boolean'),
        'callers meaning "is Mission Control supervising" need an explicit accessor, not an overloaded mode read'
    );
    // The forcing machinery is DELETED, not flagged off. Worktree strategy is the
    // user's; nothing outside the setFeatureWorktreeMode arm and the one-time
    // stash drain may write feature_worktree_mode.
    assert.ok(
        !kanbanProviderSource.includes('applyOversightWorktreeTopology'),
        'applyOversightWorktreeTopology must be deleted — no automation path may force the worktree topology'
    );
    assert.ok(
        !providerSource.includes('applyOversightWorktreeTopology'),
        'TaskViewerProvider must no longer call the worktree topology forcer'
    );
    const setAutomationModeArm = kanbanProviderSource.slice(
        kanbanProviderSource.indexOf("case 'setAutomationMode': {"),
        kanbanProviderSource.indexOf("case 'startOrchestrator': {")
    );
    assert.ok(setAutomationModeArm.length > 0, 'the setAutomationMode verb arm must still exist');
    assert.ok(
        !setAutomationModeArm.includes('mission-control_prior_feature_worktree_mode') &&
        !setAutomationModeArm.includes('feature_worktree_mode'),
        'a setAutomationMode call must not read, write or clear the stashed worktree prior — this is the left-behind else-arm regression'
    );
    // The only surviving `orchestration` mode literals are the state migration
    // in normalizeAutomationMode. No file under src/ compares a mode against
    // `'orchestration'` or `'internal'` — those values are retired.
    for (const file of ['TaskViewerProvider.ts', 'KanbanProvider.ts']) {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', file), 'utf8');
        assert.ok(
            !/(automationMode|msg\.mode|newMode|mode)\s*===\s*'orchestration'/.test(src),
            `${file} must not compare a mode against 'orchestration' — it is a retired value, carried only by the migration`
        );
        assert.ok(
            !/(automationMode|msg\.mode|newMode|mode)\s*===\s*'internal'/.test(src),
            `${file} must not compare a mode against 'internal' — it is a retired value, replaced by 'scheduled'`
        );
    }
    // The literal sweep extends to kanban.html — a stale branch there renders
    // the wrong half of the tab instead of throwing.
    const kanbanHtmlForSweep = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
    assert.ok(
        !kanbanHtmlForSweep.includes("=== 'internal'"),
        "kanban.html must not compare a mode against 'internal' — it is a retired value"
    );
    assert.ok(
        !kanbanHtmlForSweep.includes("=== 'orchestration'"),
        "kanban.html must not compare a mode against 'orchestration' — it is a retired value"
    );
    // missionControlConfig.enabled appears nowhere under src/ as a CONFIG READ.
    // autobanState.ts is excluded — it reads the raw persisted state for the
    // migration table, which is the intended carrier of the old field's intent.
    for (const file of ['services/TaskViewerProvider.ts', 'services/KanbanProvider.ts', 'webview/kanban.html']) {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8');
        assert.ok(
            !/missionControlConfig[\.\?]+enabled/.test(src),
            `${file} must not reference missionControlConfig.enabled — the field is deleted`
        );
    }

    // --- The mode axis is deleted — no mode gates anywhere ---
    // The schedule runs whenever `enabled` is true. Mission Control runs
    // whenever `missionControlArmed` is true. Both can be on simultaneously.
    // No method should gate on `automationMode !== 'scheduled'`.
    const methodBody = (marker) => {
        const start = providerSource.indexOf(marker);
        assert.ok(start !== -1, `${marker} must exist`);
        const after = providerSource.slice(start);
        const next = after.slice(1).search(/\n {4}(?:public|private|protected)\s/);
        return next === -1 ? after : after.slice(0, next + 1);
    };
    assert.ok(
        !/automationMode !== 'scheduled'/.test(methodBody('private _startAutobanEngine(): void {')),
        "_startAutobanEngine must NOT gate on automationMode — the mode axis is deleted"
    );
    assert.ok(
        !/automationMode !== 'scheduled'/.test(methodBody('public async resetAutobanTimersFromKanban()')),
        'resetAutobanTimersFromKanban must NOT gate on automationMode — the mode axis is deleted'
    );
    assert.ok(
        !/automationMode !== 'scheduled'/.test(methodBody('public async setAutobanPausedFromKanban(')),
        'setAutobanPausedFromKanban must NOT gate on automationMode — the mode axis is deleted'
    );
    // A FOURTH path: the updateAutobanState message arm. It must not force
    // `enabled` false in agent-managed (that would disarm Mission Control),
    // but must never install the run-sheet clock behind it either.
    const updateArm = providerSource.slice(providerSource.indexOf("case 'updateAutobanState': {"));
    assert.ok(
        !/automationMode !== 'scheduled'/.test(updateArm),
        'the updateAutobanState arm must not gate on automationMode — the mode axis is deleted'
    );
    // Arming Mission Control sets the missionControlArmed switch. The mode axis
    // is deleted — no _stopAutobanEngine call, no exclusivity.
    assert.ok(
        /missionControlArmed: true/.test(confirmBody),
        'confirmMissionControlSession must set missionControlArmed: true — the mode axis is deleted, arming is a switch'
    );
    assert.ok(
        !/_stopAutobanEngine\(\)/.test(confirmBody),
        'confirmMissionControlSession must NOT call _stopAutobanEngine — the schedule and Mission Control are independent switches'
    );
    // Survivor jobs run on their own activation-scoped timer, not the run-sheet tick.
    assert.ok(
        providerSource.includes('_startSurvivorJobsTimer'),
        'survivor jobs (fetch-plans, reconcile) must run on their own _startSurvivorJobsTimer — independent of the schedule'
    );
    // NOTE: `_tickSurvivorSchedulerJobs` itself is KEPT — it is the delivery
    // path for fetch-plans/reconcile and the plan's highest-consequence
    // silent-failure risk ("cloud-VM plans quietly stop arriving"). What
    // changed is only WHO calls it: the activation-scoped timer above, not the
    // deleted run-sheet tick. Asserting its deletion (an earlier draft of this
    // gate did) would demand the exact regression the plan warns about, and it
    // contradicted the survivor-tick assertions twenty lines below.
    assert.ok(
        !/_tickSurvivorSchedulerJobs\(\)\s*;?\s*\n?\s*\}\s*,\s*AUTOBAN_RUN_SHEET_TICK/.test(providerSource),
        'the survivor tick must not hang off the run-sheet tick key — it needs its own activation-scoped timer'
    );
    assert.ok(
        !providerSource.includes('_startAllSchedulerLoops'),
        'the per-job scheduler engine (_startAllSchedulerLoops) is deleted'
    );
    assert.ok(
        !providerSource.includes('_startSchedulerJobLoop') && !providerSource.includes('_stopSchedulerJobLoop'),
        'the per-job scheduler loop methods are deleted — no per-job intervals'
    );
    // BOTH survivors must reach a prompt. The survivor tick still exists,
    // now called from _startSurvivorJobsTimer instead of the run-sheet tick.
    const survivorTickStart = providerSource.indexOf('private async _tickSurvivorSchedulerJobs()');
    assert.ok(survivorTickStart !== -1, '_tickSurvivorSchedulerJobs must exist — called from the survivor timer');
    const survivorTickBody = providerSource.slice(survivorTickStart, providerSource.indexOf('\n    }\n', survivorTickStart));
    // The tick no longer builds the prompts inline — 4f2e1fc2 moved the build into
    // runSchedulerJob so scheduled team-automation shares the in-flight guard. Follow
    // the delegation instead of pinning the old shape: the tick must reach
    // runSchedulerJob, and runSchedulerJob must build BOTH survivors. Pinning only
    // "the tick mentions runSchedulerJob" would pass on a runSchedulerJob that lost
    // one of the two builders, which is the regression this gate exists to catch.
    assert.ok(
        survivorTickBody.includes('runSchedulerJob('),
        'the survivor tick must reach runSchedulerJob — otherwise no survivor job ever runs'
    );
    const runJobStart = providerSource.indexOf('public async runSchedulerJob(');
    assert.ok(runJobStart !== -1, 'runSchedulerJob must exist — the survivor tick delegates the prompt build to it');
    const runJobBody = providerSource.slice(runJobStart, providerSource.indexOf('\n    }\n', runJobStart));
    assert.ok(
        runJobBody.includes('buildFetchPlansPrompt(') && runJobBody.includes('buildReconcilePrompt('),
        'runSchedulerJob must build BOTH surviving prompts — a reconcile job with no promptOverride otherwise sends nothing'
    );
    // The checkbox is the start button now, so the run path owns terminal creation.
    // Resolve-only means the survivors never fire: launchSchedulerTerminal was
    // the only thing that ever created a `Scheduler: …` terminal, and it is gone.
    // Same delegation as the prompt build above — runSchedulerJob absorbed both.
    assert.ok(
        runJobBody.includes('_ensureSurvivorTerminal('),
        'the survivor run path must ensure its terminal exists — nothing else creates one now that launchSchedulerTerminal is deleted'
    );
    const ensureStart = providerSource.indexOf('private async _ensureSurvivorTerminal(');
    assert.ok(ensureStart !== -1, '_ensureSurvivorTerminal must exist');
    const ensureBody = providerSource.slice(ensureStart, providerSource.indexOf('\n    }\n', ensureStart));
    assert.ok(
        ensureBody.includes('vscode.window.createTerminal(') && /if \(this\._ptyHostPort\)\s*\{\s*return undefined; \}/.test(ensureBody),
        'terminal creation must be gated on the pty fleet — when a fleet owns the terminal set, this host must not spawn behind it'
    );
    // The in-flight guard must be claimed BEFORE the first await, or a second tick
    // enters while the terminal is still booting and spawns a duplicate.
    assert.ok(
        runJobBody.includes('_schedulerInFlight.set('),
        'runSchedulerJob must claim the in-flight guard — without it two ticks both enter'
    );
    assert.ok(
        runJobBody.indexOf('_schedulerInFlight.set(') < runJobBody.indexOf('_ensureSurvivorTerminal('),
        'the in-flight guard must be claimed before the terminal is ensured — ensuring awaits for seconds'
    );

    // --- The WHEN cron evaluator must return a STRICTLY FUTURE time ---
    // Returning the current (matching) minute makes the caller clamp a negative
    // delay to 1s, re-fire, recompute the same past minute, and dispatch once a
    // second for the whole minute — the hot loop the ceiling clamp exists to stop.
    const cronBody = providerSource.slice(providerSource.indexOf('private static _nextCronTime('));
    assert.ok(
        /start\.setSeconds\(0, 0\);\s*start\.setMinutes\(start\.getMinutes\(\) \+ 1\);/.test(cronBody.slice(0, 6000)),
        '_nextCronTime must start its search at the NEXT minute boundary — matching the current minute returns a time in the past'
    );

    // --- The external prompt is EVERGREEN: no DB read, no plan IDs, no local paths ---
    // Anchored on the builder's own closing brace, not on the next method's name:
    // the scheduler retirement deleted _buildCustomPrompt, and a missing end anchor
    // makes indexOf return -1, which silently slices to the end of the file.
    const externalPromptStart = kanbanProviderSource.indexOf('private _buildExternalAutomationPrompt(');
    assert.ok(externalPromptStart !== -1, 'the external-mode prompt builder must exist');
    const externalPromptBody = kanbanProviderSource.slice(
        externalPromptStart,
        kanbanProviderSource.indexOf('\n    }\n', externalPromptStart)
    );
    assert.ok(externalPromptBody.length > 0, 'the external-mode prompt builder must exist');
    assert.ok(
        !/getPlansByColumn|_buildBoardBatchPromptCore|kanban\.db|await /.test(externalPromptBody),
        'the external prompt must build with an empty board — no DB read, no snapshot builder, no absolute sqlite path'
    );
    assert.ok(
        !externalPromptBody.includes('getAutobanRunSheet()') && !externalPromptBody.includes('DEFAULT_AUTOBAN_RUN_SHEET'),
        'the external prompt must not reference the deleted run sheet APIs — pipeline steps are hard-coded inline'
    );
    assert.ok(
        externalPromptBody.includes('CREATED') && externalPromptBody.includes('planner') && externalPromptBody.includes('PLAN REVIEWED') && externalPromptBody.includes('coder'),
        'the external prompt must include the pipeline steps (CREATED→planner, PLAN REVIEWED→coder) inline'
    );
    // The board-driving paragraph is ONE constant, not two copies. It now lives in
    // schedulerPresets (a dependency-free module both the reconcile preset and this
    // provider can import) and KanbanProvider aliases it. Assert on the literal text,
    // not the identifier — a second copy is the failure, wherever it is pasted.
    const presetsSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'schedulerPresets.ts'), 'utf8');
    assert.ok(
        externalPromptBody.includes('KanbanProvider.BOARD_DRIVING_CONTRACT'),
        'the external prompt must reference the shared board-driving constant, not inline its own copy'
    );
    assert.ok(
        /export const BOARD_DRIVING_CONTRACT = /.test(presetsSource) &&
        /BOARD_DRIVING_CONTRACT = SHARED_BOARD_DRIVING_CONTRACT;/.test(kanbanProviderSource),
        'the board-driving paragraph lives in schedulerPresets and KanbanProvider aliases it — one text, two consumers'
    );
    const contractLiteral = 'Raw SQL strands cards and bypasses the move-card.js side-effects';
    const literalCopies = [presetsSource, kanbanProviderSource, providerSource]
        .reduce((n, src) => n + (src.split(contractLiteral).length - 1), 0);
    assert.strictEqual(
        literalCopies, 1,
        'the board-driving paragraph must exist as exactly ONE literal across the providers and the presets module'
    );
    // The run sheet constant is deleted — pipeline steps are hard-coded inline
    // in the external prompt builder. No assertion needed on a deleted export.

    // --- comms is DELETED, not flagged off ---
    for (const rel of [
        path.join('services', 'TaskViewerProvider.ts'),
        path.join('services', 'KanbanProvider.ts'),
        path.join('services', 'GlobalIntegrationConfigService.ts'),
        path.join('webview', 'kanban.html')
    ]) {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', rel), 'utf8');
        for (const dead of ['mcpMonitorConfig', 'McpMonitorConfig', 'COMMS_JOB_ID', 'sourceIntervals', 'isCommsPanelInteracting']) {
            assert.ok(
                !src.includes(dead),
                `${rel} still references the deleted comms surface (${dead})`
            );
        }
    }
    // The residual job list is load-bearing: fetch-plans / reconcile jobs are
    // persisted, start from activation, and are editable nowhere else.
    const configServiceSource = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'GlobalIntegrationConfigService.ts'), 'utf8');
    assert.ok(
        /DROPPED_SOURCES = new Set\(\['comms', 'board-batch', 'custom'\]\)/.test(configServiceSource),
        'comms, board-batch, and custom jobs are dropped on READ — never by a destructive pass over integration-config.json'
    );
    for (const survivor of ['_ensureSchedulerMigration', '_persistMigratedSchedulerIfAbsent', 'getSchedulerConfigSync', 'getSchedulerConfig']) {
        assert.ok(
            configServiceSource.includes(survivor),
            `${survivor} sits in the same span as the comms migration and every scheduler read depends on it — it must survive the cut`
        );
    }
    assert.ok(
        /source: 'reconcile' \| 'custom' \| 'fetch-plans'/.test(configServiceSource),
        'the surviving job sources are exactly reconcile | custom | fetch-plans'
    );
    // _buildBoardBatchPromptCore survives the board-batch SOURCE deletion — it
    // still backs the Antigravity copy button.
    assert.ok(
        kanbanProviderSource.includes('private async _buildBoardBatchPromptCore('),
        '_buildBoardBatchPromptCore must survive the board-batch job-source deletion — it has other callers'
    );

    // --- The per-job scheduler surface is deleted ---
    // The six per-job verbs are gone from KanbanProvider (getSchedulerConfig
    // and setSchedulerConfig survive for the survivor checkboxes; the other
    // four are deleted).
    for (const deadVerb of ['startSchedulerJob', 'stopSchedulerJob', 'schedulerPrompt', 'getSchedulerTargetContracts']) {
        assert.ok(
            !kanbanProviderSource.includes(`case '${deadVerb}'`),
            `KanbanProvider must not contain the deleted scheduler verb arm: ${deadVerb}`
        );
    }
    assert.ok(
        !kanbanProviderSource.includes('SCHEDULER_TARGET_CONTRACTS'),
        'SCHEDULER_TARGET_CONTRACTS is deleted with the scheduler surface'
    );
    assert.ok(
        !kanbanProviderSource.includes('_buildSchedulerPrompt'),
        '_buildSchedulerPrompt is deleted with the scheduler surface'
    );
    // The per-job engine methods are gone from TaskViewerProvider.
    for (const deadMethod of ['_startSchedulerJobLoop', '_stopSchedulerJobLoop', '_enqueueSchedulerTick', '_schedulerTick', 'launchSchedulerTerminal', 'stopSchedulerTerminal', '_startSchedulerOutputCapture', '_captureSchedulerOutput', '_disposeSchedulerOutputCapture', '_jobIdForTerminalName']) {
        assert.ok(
            !providerSource.includes(deadMethod),
            `TaskViewerProvider must not contain the deleted scheduler engine method: ${deadMethod}`
        );
    }
    // The in-flight guard survives — the survivor tick carries it forward.
    assert.ok(
        providerSource.includes('_schedulerInFlight'),
        'the per-job in-flight guard (_schedulerInFlight) survives — the survivor tick carries it forward'
    );
    // The SCHEDULER section header is gone from the UI.
    const kanbanHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'kanban.html'), 'utf8');
    assert.ok(
        !kanbanHtml.includes("'SCHEDULER'"),
        'the SCHEDULER section header is deleted from the AUTOMATION tab UI'
    );
    assert.ok(
        !kanbanHtml.includes("'KANBAN AUTOMATION RULES'"),
        'the KANBAN AUTOMATION RULES section header is deleted — controls remain without the box'
    );
    // The survivor checkboxes moved with the AUTOMATION tab: their home is now the
    // Mission Control panel's Schedules tab. Assert them THERE, and assert they are
    // gone from the board — a presence check against kanban.html would have passed
    // for a whole release while the only UI for two recurring jobs sat in a deleted
    // function no code could reach.
    const missionControlHtml = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'mission-control.html'), 'utf8');
    const missionControlJs = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'mission-control.js'), 'utf8');
    assert.ok(
        missionControlHtml.includes('FETCH CLOUD PLANS') && missionControlHtml.includes('RECONCILE CLOUD WORK'),
        'the two survivor checkboxes (fetch-plans, reconcile) must be present in the Mission Control panel'
    );
    assert.ok(
        !kanbanHtml.includes('FETCH CLOUD PLANS') && !kanbanHtml.includes('RECONCILE CLOUD WORK'),
        'the survivor checkboxes must NOT remain on the board — two homes is two sources of truth'
    );
    assert.ok(
        /setSchedulerConfig/.test(missionControlJs) && /getSchedulerConfig/.test(missionControlJs),
        'the panel must read AND write the scheduler config, or the checkboxes are decoration'
    );
    // The checkbox must UPSERT. '+ ADD JOB' died with the scheduler surface, so a
    // map-only toggle persists nothing on a config with no job of that source —
    // which is every fresh install — and the box snaps back on the next broadcast.
    assert.ok(
        /if \(!found\) \{[\s\S]{0,400}?source: sv\.source/.test(missionControlJs),
        'the survivor checkbox must create the job record when none exists — nothing else can, now that + ADD JOB is deleted'
    );
    // The dropped-custom-jobs notice is wired — in the panel now, beside the jobs it
    // is about. Its only prior render site was inside the deleted AUTOMATION tab
    // builder, so asserting kanban.html here would keep passing on an unreachable one.
    assert.ok(
        missionControlJs.includes('droppedCustomJobsNotice'),
        'the dropped-custom-jobs notice must be wired in the Mission Control panel'
    );

    // --- Three exclusive modes: the OVERSIGHT AGENT block is gone, three radios replace the select ---
    assert.ok(
        !kanbanHtml.includes("'OVERSIGHT AGENT'"),
        "the OVERSIGHT AGENT section header is deleted — the mode replaces it, leaving both is the defect this plan exists to remove"
    );
    assert.ok(
        !kanbanHtml.includes('oversight-agent-toggle'),
        'the oversight-agent-toggle checkbox is deleted — the ON/OFF is the single armed flag'
    );
    // --- The mode axis is DELETED, not orphaned ---
    // These assertions used to require the three radios, the status line, the
    // external-mode copy and the agent-managed boot-command field to be PRESENT in
    // kanban.html. That is the axis the four-thing plan exists to remove, so pinning
    // its presence pinned the defect. It is now asserted absent — from the markup AND
    // from the script, because the first delivery removed only the container div and
    // left ~720 lines of radio machinery behind an early `return`, which reads to any
    // later maintainer as a live mode selector.
    // Matched in CODE positions only — the file keeps prose explaining what was
    // removed and why, and a substring check would flag its own tombstone.
    for (const [label, re] of [
        ["getElementById('automation-status-line')", /getElementById\(\s*['"]automation-status-line['"]\s*\)/],
        ["id=\"agent-managed-boot-command\"", /id=["']agent-managed-boot-command["']/],
        ['currentAutomationMode (read or write)', /currentAutomationMode\s*(===|!==|=[^=]|\.)/],
        ['createAutobanPanel()', /createAutobanPanel\s*\(/],
        ['renderAutobanPanel()', /renderAutobanPanel\s*\(/],
        ["postKanbanMessage({ type: 'setAutomationMode'", /type:\s*['"]setAutomationMode['"]/],
    ]) {
        assert.ok(!re.test(kanbanHtml),
            `kanban.html still carries mode-axis machinery: ${label}`);
    }
    // Neither badge filter may key on a mode value any more. Both follow the SCHEDULE
    // switch, so a schedule keeps its countdown badges while Mission Control is armed
    // — the residual exclusivity that survived the container's removal.
    assert.strictEqual(
        (kanbanHtml.match(/if \(autobanConfig\.enabled === true\) \{\s*\n\s*const sourceIdx/g) || []).length, 2,
        'both timer-badge filters must key on the schedule switch — one per render path'
    );
    // The command-palette entry stays registered under its SHIPPED id (renaming a
    // command id breaks user keybindings); only the user-visible title is renamed.
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    const startCmd = packageJson.contributes.commands.find(c => c.command === 'switchboard.startOrchestrator');
    assert.ok(startCmd, 'switchboard.startOrchestrator must remain in package.json contributes.commands (shipped id, user keybindings)');
    assert.ok(!/Orchestrator/.test(startCmd.title),
        `the command TITLE is user-visible and must not say Orchestrator (got: ${startCmd.title})`);
    const extensionSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.ok(
        extensionSrc.includes("registerCommand('switchboard.startOrchestrator'"),
        'switchboard.startOrchestrator must be registered in extension.ts'
    );
    // External scheduling pauses nothing local. The copy moved to the panel with the
    // rest of the external surface.
    assert.ok(
        missionControlHtml.includes('External') || missionControlJs.includes('External'),
        'the external schedule type must exist in the Mission Control panel'
    );

    // --- The automation model: four things, not a mode axis ---
    // 1. Schedule rules stay small: window, source, selector ('oldest'), target.
    // Must NOT admit role, batch size, or complexity filter.
    if (typeof normalizeScheduleRule === 'function') {
        const validSchedule = normalizeScheduleRule({
            timeWindow: 'midnight-7am',
            sourceColumn: 'CODED',
            selector: 'oldest',
            targetColumn: 'CODE REVIEWED',
            role: 'lead',
            batchSize: 5,
            complexityFilter: 'high_and_above'
        });
        assert.deepStrictEqual(validSchedule, {
            timeWindow: 'midnight-7am',
            sourceColumn: 'CODED',
            selector: 'oldest',
            targetColumn: 'CODE REVIEWED'
        }, 'schedule rules must admit only timeWindow, sourceColumn, selector, and targetColumn — no role, batchSize, or complexity');
    }

    // 2. Mission run flavours: unattended vs operations is per run.
    if (typeof normalizeMissionRunConfig === 'function') {
        const unattendedRun = normalizeMissionRunConfig({ missionId: 'm-1', flavour: 'unattended' });
        const operationsRun = normalizeMissionRunConfig({ missionId: 'm-2', flavour: 'operations' });
        assert.strictEqual(unattendedRun.flavour, 'unattended');
        assert.strictEqual(operationsRun.flavour, 'operations');
    }

    // 3. Migration from external mode sets recurringJobsResumedNotice.
    const externalMigrated = normalizeAutobanConfigState({ automationMode: 'external', enabled: false });
    assert.strictEqual(externalMigrated.enabled, false);
    assert.ok(
        typeof externalMigrated.recurringJobsResumedNotice === 'string' && externalMigrated.recurringJobsResumedNotice.includes('resumed'),
        'migrating retired external mode must set recurringJobsResumedNotice'
    );

    // 4. No credentials in generated external prompt.
    assert.ok(
        !/ghp_|api[_-]?key|bearer|token|secret/i.test(externalPromptBody),
        'the external prompt must not contain any credentials or secrets'
    );

    console.log('autoban state regression test passed');
}

run().catch((error) => {
    console.error('autoban state regression test failed:', error);
    process.exit(1);
});
