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
    normalizeOrchestrationConfig,
    normalizeAutobanBatchSize,
    normalizeSingleColumnConfig,
    DEFAULT_AUTOBAN_RUN_SHEET,
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
            'INTERN CODED': { enabled: true, intervalMinutes: 15, triggerMode: 'drain' },
            'LEAD CODED': { enabled: true, intervalMinutes: 15, triggerMode: 'drain' },
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
        { enabled: true, intervalMinutes: 20, triggerMode: 'drain' },
        'legacy states should restore missing default column rules'
    );
    assert.deepStrictEqual(
        normalizedLegacy.rules['INTERN CODED'],
        { enabled: true, intervalMinutes: 15, triggerMode: 'drain' },
        'legacy states should restore the intern coded autoban rule with default 15-minute interval'
    );
    assert.deepStrictEqual(
        normalizedLegacy.rules['LEAD CODED'],
        { enabled: true, intervalMinutes: 15, triggerMode: 'drain' },
        'legacy states should restore the lead coded autoban rule'
    );
    assert.deepStrictEqual(
        normalizedLegacy.rules['CODER CODED'],
        { enabled: true, intervalMinutes: 15, triggerMode: 'drain' },
        'legacy states should restore the coder coded autoban rule'
    );

    const normalizedLegacyCodedRule = normalizeAutobanConfigState({
        rules: {
            CODED: { enabled: false, intervalMinutes: 9 }
        }
    });
    assert.deepStrictEqual(
        normalizedLegacyCodedRule.rules['LEAD CODED'],
        { enabled: false, intervalMinutes: 9, triggerMode: 'drain' },
        'legacy CODED autoban rules should be remapped onto LEAD CODED'
    );
    assert.deepStrictEqual(
        normalizedLegacyCodedRule.rules['CODER CODED'],
        { enabled: false, intervalMinutes: 9, triggerMode: 'drain' },
        'legacy CODED autoban rules should be remapped onto CODER CODED'
    );
    assert.deepStrictEqual(
        normalizedLegacyCodedRule.rules['INTERN CODED'],
        { enabled: true, intervalMinutes: 15, triggerMode: 'drain' },
        'legacy CODED autoban rules should NOT remap onto INTERN CODED (intern column postdates the split)'
    );

    const normalizedNewConfig = normalizeAutobanConfigState({
        batchSize: 8
    });
    assert.strictEqual(normalizedNewConfig.batchSize, 5, 'batch size should clamp to the supported 1..5 contract');

    assert.deepStrictEqual(
        getEnabledSharedReviewerAutobanColumns({
            'LEAD CODED': { enabled: true, intervalMinutes: 15, triggerMode: 'drain' },
            'CODER CODED': { enabled: true, intervalMinutes: 15, triggerMode: 'drain' },
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
    assert.ok(
        providerSource.includes('targetTerminalOverride?: string') &&
        providerSource.includes('selection.terminalName'),
        'TaskViewerProvider should preserve the terminal-override dispatch seam for autoban pools'
    );
    assert.ok(
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
        providerSource.includes('private _autobanColumnToRole(column: string): string | null') &&
        providerSource.includes('return columnToPromptRole(column);') &&
        providerSource.includes('With strict column isolation, each column ticks independently'),
        'TaskViewerProvider should delegate column-to-role mapping to columnToPromptRole and use strict column isolation for autoban ticks'
    );

    // --- Completion-driven dispatch: the three ways it silently dies ---
    // Each of these shipped broken once. All three produce the same symptom:
    // autoban dispatches exactly one card and the board stops with no error.

    // 1. Key shape. The dispatch side reads an ABSOLUTE planFile
    //    (_collectKanbanCardsInColumns resolves it); the turn-end side receives the
    //    RELATIVE plan_file the DB stores. Both ends must normalise through the
    //    same helper or the map lookup never matches.
    assert.ok(
        providerSource.includes('private _autobanPlanFileKey(') &&
        /this\._autobanDispatchedPlanFiles\.set\(key, \{ cardId, sourceColumn \}\)/.test(providerSource) &&
        /const key = this\._autobanPlanFileKey\(info\.planFile, info\.workspaceRoot\)/.test(providerSource),
        'completion tracking must key both the dispatch side and the turn-end side through _autobanPlanFileKey'
    );

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

    // 3. Fallback chain. PLAN REVIEWED escalates intern -> coder -> lead. Stopping
    //    the engine inside the per-role dispatch helper kills autoban on the first
    //    missing role AND lets the escalation keep dispatching after every tracking
    //    map was cleared by _stopAutobanEngine().
    const dispatchHelperIdx = providerSource.indexOf('const dispatchWithAutobanTerminal = async (');
    assert.notStrictEqual(dispatchHelperIdx, -1, 'dispatchWithAutobanTerminal must exist');
    const dispatchHelperBody = stripLineComments(providerSource.slice(dispatchHelperIdx, providerSource.indexOf('\n        };', dispatchHelperIdx)));
    assert.ok(
        !dispatchHelperBody.includes('_stopAutobanWithMessage'),
        'dispatchWithAutobanTerminal must return false on no-target and let the intern->coder->lead fallback run; the loud stop belongs after the chain is exhausted'
    );
    assert.ok(
        /no eligible terminal available for \$\{lastNoTargetRole\}/.test(providerSource),
        'the routed tick must surface a loud "no target" stop once the whole fallback chain is exhausted'
    );

    // --- The clock is the default ---
    // Autoban's whole job is "every intervalMinutes, dispatch a card". A rework
    // once replaced that interval with completion-driven dispatch as the DEFAULT,
    // which is not what autoban is for: a board with no agent reporting back just
    // stops. Completion pacing is a per-column opt-in (triggerMode 'completion'),
    // never the default, and it must not run alongside the clock or every card
    // dispatches twice.
    assert.ok(
        /setInterval\(\(\) => \{\s*this\._enqueueRunSheetTick\(batchSize\);\s*\}, intervalMinutes \* 60 \* 1000\)/.test(providerSource),
        '_startAutobanEngine must install the recurring run-sheet interval — the clock is autoban\'s default pacing'
    );

    // --- The run sheet: one clock, ordered steps, availability is a condition ---
    assert.ok(
        providerSource.includes('private _getAutobanRunSheet(): readonly AutobanRunSheetStep[]'),
        'the run sheet must be reachable through one accessor — the seam a user-edited sheet plugs into'
    );
    const runSheetTickIdx = providerSource.indexOf('private _enqueueRunSheetTick(');
    assert.notStrictEqual(runSheetTickIdx, -1, '_enqueueRunSheetTick must exist');
    const runSheetBody = stripLineComments(providerSource.slice(runSheetTickIdx, providerSource.indexOf('\n    }', runSheetTickIdx)));
    assert.ok(
        /for \(const step of this\._getAutobanRunSheet\(\)\)/.test(runSheetBody),
        'a tick must walk every run-sheet step in order'
    );
    assert.ok(
        !/\breturn;\s*\}\s*catch/.test(runSheetBody) && runSheetBody.includes('catch'),
        'a failing step must not abort the remaining steps — an unavailable planner team cannot block the coder team'
    );
    // A run-sheet step SKIPS when its team is unavailable. Halting the engine there
    // would stop the board because one team happened to be busy.
    const tickIdx = providerSource.indexOf('private async _autobanTickColumn(');
    const tickBody = providerSource.slice(tickIdx, providerSource.indexOf('\n    private ', tickIdx + 10));
    const runSheetBranch = tickBody.slice(tickBody.indexOf('if (headRoleOverride) {'), tickBody.indexOf('// Complexity-aware routing'));
    assert.ok(
        runSheetBranch.includes('skipping this step') && !runSheetBranch.includes('_stopAutobanWithMessage'),
        'an unavailable team must skip its run-sheet step, never stop the engine'
    );
    assert.deepStrictEqual(
        DEFAULT_AUTOBAN_RUN_SHEET.map(s => [s.sourceColumn, s.headRole]),
        [['CREATED', 'planner'], ['PLAN REVIEWED', 'coder']],
        'the default run sheet is CREATED -> planner team, then PLAN REVIEWED -> coder team, in that order'
    );
    assert.ok(
        providerSource.includes('private _isCompletionTriggered(column: string): boolean'),
        'completion pacing must be gated behind an explicit per-column trigger-mode check'
    );

    // --- The run sheet is a PIPELINE, and that breaks two invariants if ignored ---

    // 4. Premature auto-stop. CREATED -> planner FEEDS PLAN REVIEWED -> coder, so
    //    dispatching the last CREATED card empties every enabled column while the
    //    planner is still working. Stopping there means its output lands in PLAN
    //    REVIEWED with the engine already off — the silent stop this feature exists
    //    to remove. In-flight work must veto the empty-column sweep.
    const stopIfEmptyIdx = providerSource.indexOf('private async _stopAutobanIfNoValidTicketsRemain(');
    assert.notStrictEqual(stopIfEmptyIdx, -1, '_stopAutobanIfNoValidTicketsRemain must exist');
    const stopIfEmptyBody = stripLineComments(
        providerSource.slice(stopIfEmptyIdx, providerSource.indexOf('\n    }', stopIfEmptyIdx))
    );
    assert.ok(
        /if \(this\._autobanDispatchedPlanFiles\.size > 0\) \{\s*return false;/.test(stopIfEmptyBody),
        'the empty-column sweep must not stop the engine while autoban still has a dispatched card in flight — the run sheet is a pipeline and a later step feeds on an earlier one\'s output'
    );
    // Which requires the tracking map to be populated in EVERY trigger mode, not
    // only under `completion`. If the set is re-gated on _isCompletionTriggered the
    // veto above silently becomes a no-op for the default clock mode.
    const dispatchTrackIdx = providerSource.indexOf('this._autobanDispatchedPlanFiles.set(key, { cardId, sourceColumn })');
    assert.notStrictEqual(dispatchTrackIdx, -1, 'the dispatch path must record in-flight cards');
    const trackingPrelude = stripLineComments(providerSource.slice(dispatchTrackIdx - 700, dispatchTrackIdx));
    assert.ok(
        !trackingPrelude.includes('_isCompletionTriggered'),
        'in-flight tracking must be recorded in every trigger mode — gating the set on _isCompletionTriggered leaves the clock mode with no in-flight record and re-arms the premature auto-stop'
    );
    // And the stall watchdog must retire a record whose seat never reports, or one
    // dead agent holds the veto open and the engine can never auto-stop again.
    const watchdogIdx = providerSource.indexOf('private _armAutobanStallWatchdog(');
    assert.notStrictEqual(watchdogIdx, -1, '_armAutobanStallWatchdog must exist');
    const watchdogBody = stripLineComments(
        providerSource.slice(watchdogIdx, providerSource.indexOf('\n    }', watchdogIdx))
    );
    assert.ok(
        watchdogBody.includes('this._autobanDispatchedPlanFiles.delete(key)') &&
        !watchdogBody.includes('_enqueueRunSheetTick') &&
        !watchdogBody.includes('_stopAutoban'),
        'the stall watchdog must drop the in-flight record (so a dead seat cannot wedge the veto open) while still never dispatching and never stopping the engine'
    );

    // 5. Fan-out. A turn-end triggers a pass over EVERY run-sheet step, so one
    //    completion in the planner lane also dispatches into the coder lane and the
    //    in-flight count compounds each generation. That directly contradicts the
    //    argument used to delete globalSessionCap ("report-paced dispatch is
    //    one-in-one-out and cannot outrun itself").
    assert.ok(
        providerSource.includes('private _autobanLaneInFlight(sourceColumn: string): boolean'),
        'ON DONE needs a per-lane in-flight check — one card at a time is per run-sheet step, not per board'
    );
    assert.ok(
        /_isCompletionTriggered\(step\.sourceColumn\) && this\._autobanLaneInFlight\(step\.sourceColumn\)/.test(runSheetBody),
        'a run-sheet pass must skip a step whose lane already has a card in flight under ON DONE, or one turn-end fans out into a dispatch per step'
    );
    const turnEndGate = stripLineComments(providerSource.slice(turnEndIdx, providerSource.indexOf('\n    }', turnEndIdx)));
    assert.ok(
        turnEndGate.includes('_isCompletionTriggered'),
        'handleAutobanTurnEnd must no-op unless the column opted into completion pacing — otherwise it double-dispatches against the clock'
    );
    assert.strictEqual(
        normalizeSingleColumnConfig({}).triggerMode,
        'drain',
        'the default trigger mode is drain (clock-driven), not completion'
    );
    assert.strictEqual(
        normalizeSingleColumnConfig({ triggerMode: 'completion' }).triggerMode,
        'completion',
        'completion is a valid opt-in trigger mode'
    );
    assert.strictEqual(
        normalizeSingleColumnConfig({ triggerMode: 'nonsense' }).triggerMode,
        'drain',
        'an unrecognised persisted trigger mode falls back to the clock-driven default'
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

    // --- The mode axis is exactly agent-managed|scheduled|external, and it MAPS, never whitelists ---
    // A whitelist that fell through would silently disarm a shipped install's
    // clock. Everything unrecognised must land on `scheduled`.
    for (const legacy of ['single-column', 'multi-column', 'run-sheet', 'scheduler', '', 'nonsense', undefined, null]) {
        assert.strictEqual(
            normalizeAutobanConfigState({ automationMode: legacy }).automationMode,
            'scheduled',
            `a persisted automationMode of ${JSON.stringify(legacy)} must normalise to 'scheduled' — falling through a whitelist disarms shipped installs`
        );
    }
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'external' }).automationMode,
        'external',
        "'external' is the only value that normalises to external"
    );

    // --- The migration table: three cohorts, all tested ---
    // `orchestration` → `agent-managed` (the retired peer mode)
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'orchestration' }).automationMode,
        'agent-managed',
        'the retired orchestration mode migrates to agent-managed'
    );
    // `internal` + `orchestrationConfig.enabled === true` → `agent-managed` (the 150001 cohort)
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'internal', orchestrationConfig: { enabled: true } }).automationMode,
        'agent-managed',
        'internal with oversight enabled migrates to agent-managed — the 150001 cohort must not lose its agent'
    );
    // bare `internal` → `scheduled` (the majority cohort)
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'internal' }).automationMode,
        'scheduled',
        'bare internal migrates to scheduled — the majority cohort keeps ticking'
    );

    // --- orchestrationConfig.enabled is DELETED; intervalMinutes is RESTORED ---
    assert.strictEqual(
        normalizeOrchestrationConfig({ intervalMinutes: 45 }).intervalMinutes,
        45,
        'normalizeOrchestrationConfig must read through a persisted intervalMinutes, not hard-default past it'
    );
    assert.strictEqual(
        normalizeOrchestrationConfig({ intervalMinutes: 0 }).intervalMinutes,
        1,
        'intervalMinutes floors at 1'
    );
    assert.strictEqual(
        normalizeOrchestrationConfig({ intervalMinutes: 999 }).intervalMinutes,
        999,
        'intervalMinutes has no ceiling — "overnight" is a valid wake interval'
    );
    assert.strictEqual(
        normalizeOrchestrationConfig(undefined).intervalMinutes,
        10,
        'intervalMinutes defaults to 10 when absent'
    );
    assert.ok(
        !('enabled' in normalizeOrchestrationConfig({ enabled: true, intervalMinutes: 10 })),
        'normalizeOrchestrationConfig must not return an enabled field — it is deleted'
    );
    assert.ok(
        !('maxConcurrentSubtasks' in normalizeOrchestrationConfig({ maxConcurrentSubtasks: 5, intervalMinutes: 10 })),
        'normalizeOrchestrationConfig must not return maxConcurrentSubtasks — it belongs to a fan-out model that is not part of this feature'
    );
    assert.ok(
        !('lastWakeAt' in normalizeOrchestrationConfig({ lastWakeAt: '2026-01-01', intervalMinutes: 10 })),
        'normalizeOrchestrationConfig must not return lastWakeAt — it is status the tab derives from the engine, not config'
    );

    // The attended oversight pass is DELETED, not flagged off.
    for (const dead of ['OversightPassService', 'isAutomationArmed', 'attachOversightWatcher']) {
        assert.ok(
            !providerSource.includes(dead),
            `TaskViewerProvider still references the deleted oversight pass (${dead})`
        );
    }
    // START DOES NOT ARM. Seating the orchestrator opens a pre-flight interview;
    // arming is `POST /orchestration/confirm` → confirmOrchestrationSession, after
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
    const startOrchStart = providerSource.indexOf('public async startOrchestratorFromKanban');
    assert.ok(startOrchStart !== -1, 'startOrchestratorFromKanban must exist');
    const startAfterSig = providerSource.slice(startOrchStart);
    const startNextDecl = startAfterSig.slice(1).search(/\n {4}(?:public|private|protected)\s/);
    const startOrchBody = startNextDecl === -1 ? startAfterSig : startAfterSig.slice(0, startNextDecl + 1);
    assert.ok(
        !/orchestrationConfig:\s*\{[\s\S]*?enabled:\s*true/.test(startOrchBody),
        'startOrchestratorFromKanban must not write orchestrationConfig.enabled — the field is deleted'
    );
    assert.ok(
        !/enabled:\s*true/.test(startOrchBody),
        'startOrchestratorFromKanban must NOT arm — it seats the orchestrator and delivers the pre-flight; arming moved to confirmOrchestrationSession'
    );
    assert.ok(
        !startOrchBody.includes('_stopAutobanEngine()'),
        'startOrchestratorFromKanban must not tear down the run-sheet engine — that rides the arming transition in confirmOrchestrationSession'
    );
    // The arming block landed in confirmOrchestrationSession, intact and in order:
    // engine down BEFORE the mode flips, so a `scheduled` run sheet cannot survive
    // the transition to `agent-managed` and leave two clocks on one board.
    const confirmStart = providerSource.indexOf('public async confirmOrchestrationSession');
    assert.ok(confirmStart !== -1, 'confirmOrchestrationSession must exist — it is the only path that arms');
    const confirmAfterSig = providerSource.slice(confirmStart);
    const confirmNextDecl = confirmAfterSig.slice(1).search(/\n {4}(?:public|private|protected)\s/);
    const confirmBody = confirmNextDecl === -1 ? confirmAfterSig : confirmAfterSig.slice(0, confirmNextDecl + 1);
    assert.ok(
        /enabled:\s*true/.test(confirmBody) && confirmBody.includes("automationMode: 'agent-managed'"),
        'confirmOrchestrationSession must set autobanState.enabled = true in agent-managed mode — this is the arm'
    );
    assert.ok(
        confirmBody.indexOf('_stopAutobanEngine()') !== -1 &&
        confirmBody.indexOf('_stopAutobanEngine()') < confirmBody.search(/enabled:\s*true/),
        'confirmOrchestrationSession must stop the run-sheet engine BEFORE flipping the mode — two clocks on one board is the hazard the exclusive-mode model removes'
    );
    assert.ok(
        /session\.md/.test(confirmBody) && /success:\s*false/.test(confirmBody),
        'confirmOrchestrationSession must refuse when session.md is absent — arming a session with no rules is the silent half-state'
    );
    // Scoped to the method BODY, not a fixed byte window. A character-count window
    // tracks the method's length: deleting the worktree-topology restore block shrank
    // this method enough that a 900-char window ran past its closing brace into
    // setAutomationModeFromKanban, whose _stopAutobanEngine() call is legitimate.
    const stopOrchStart = providerSource.indexOf('public async stopOrchestratorFromKanban');
    assert.ok(stopOrchStart !== -1, 'stopOrchestratorFromKanban must exist');
    const afterSig = providerSource.slice(stopOrchStart);
    const nextDeclOffset = afterSig.slice(1).search(/\n {4}(?:public|private|protected)\s/);
    const stopOrchBody = nextDeclOffset === -1 ? afterSig : afterSig.slice(0, nextDeclOffset + 1);
    assert.ok(
        !stopOrchBody.includes('_stopAutobanEngine()'),
        'stopOrchestratorFromKanban must not stop the autoban engine — disarming the orchestrator sets enabled=false, not _stopAutobanEngine()'
    );
    assert.ok(
        providerSource.includes('public isOversightAgentRunning(): boolean'),
        'callers meaning "is the orchestrator supervising" need an explicit accessor, not an overloaded mode read'
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
        !setAutomationModeArm.includes('orchestration_prior_feature_worktree_mode') &&
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
    // orchestrationConfig.enabled appears nowhere under src/ as a CONFIG READ.
    // autobanState.ts is excluded — it reads the raw persisted state for the
    // migration table, which is the intended carrier of the old field's intent.
    for (const file of ['services/TaskViewerProvider.ts', 'services/KanbanProvider.ts', 'webview/kanban.html']) {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', file), 'utf8');
        assert.ok(
            !/orchestrationConfig[\.\?]+enabled/.test(src),
            `${file} must not reference orchestrationConfig.enabled — the field is deleted`
        );
    }

    // --- External mode runs NO clock, and the gate has more than one door ---
    // Asserted on the source because the failure is a live setInterval, and a
    // test that reads the mode back is exactly the test that passes while the
    // clock runs.
    // Gate on the mode that RUNS the run sheet, never on `!== 'external'`.
    // `=== 'external'` was a correct proxy for "no run sheet here" while the
    // axis had two values; adding `agent-managed` turned every one of these
    // into a fall-through that installs the run-sheet clock in the mode where
    // the orchestrator IS the automation. That is the two-clocks hazard the
    // exclusive-mode model exists to remove, and it is SILENT — a live
    // setInterval, no type error, no UI symptom.
    // Scoped to each method BODY, never a fixed char window. A byte window
    // tracks comment length as well as code: the gates below each carry a
    // paragraph explaining why they exist, and a window sized to the code alone
    // silently stops covering the assertion it was written for.
    const methodBody = (marker) => {
        const start = providerSource.indexOf(marker);
        assert.ok(start !== -1, `${marker} must exist`);
        const after = providerSource.slice(start);
        const next = after.slice(1).search(/\n {4}(?:public|private|protected)\s/);
        return next === -1 ? after : after.slice(0, next + 1);
    };
    assert.ok(
        /automationMode !== 'scheduled'[\s\S]{0,300}?return;/.test(methodBody('private _startAutobanEngine(): void {')),
        "_startAutobanEngine must refuse in every non-scheduled mode, at the top, after stopping any surviving timer"
    );
    assert.ok(
        /automationMode !== 'scheduled'[\s\S]{0,300}?return;/.test(methodBody('public async resetAutobanTimersFromKanban()')),
        'resetAutobanTimersFromKanban installs its OWN setInterval — it needs its own non-scheduled gate, beside and independent of the !enabled return (in agent-managed, `enabled` means the ORCHESTRATOR is armed)'
    );
    assert.ok(
        /automationMode !== 'scheduled'[\s\S]{0,600}?return;/.test(methodBody('public async setAutobanPausedFromKanban(')),
        'resume-from-pause is a THIRD timer-install path — `paused` survives a switch into external OR agent-managed, so it needs its own gate too'
    );
    // A FOURTH path: the updateAutobanState message arm. It must not force
    // `enabled` false in agent-managed (that would disarm the orchestrator),
    // but must never install the run-sheet clock behind it either.
    const updateArm = providerSource.slice(providerSource.indexOf("case 'updateAutobanState': {"));
    assert.ok(
        /automationMode !== 'scheduled'[\s\S]{0,400}?_stopAutobanEngine\(\)/.test(updateArm.slice(0, 1800)),
        'the updateAutobanState arm must stop — never start — the run-sheet engine in a non-scheduled mode'
    );
    // Arming the orchestrator must tear the run-sheet engine down FIRST. The
    // arm now lives in confirmOrchestrationSession (Start only seats and
    // interviews), and its caller — POST /orchestration/confirm, reached by the
    // orchestrator agent itself — bypasses setAutomationModeFromKanban entirely,
    // so it can fire while `scheduled` is armed and ticking.
    assert.ok(
        /_stopAutobanEngine\(\)[\s\S]{0,400}?automationMode: 'agent-managed'/.test(confirmBody),
        'confirmOrchestrationSession must call _stopAutobanEngine() before switching the mode to agent-managed — its caller bypasses setAutomationModeFromKanban and would leave the run-sheet timers ticking'
    );
    assert.ok(
        providerSource.includes('_tickSurvivorSchedulerJobs'),
        'surviving scheduler jobs (fetch-plans, reconcile) must fire from the run-sheet tick — _tickSurvivorSchedulerJobs is the delivery method'
    );
    // Scoped to the tick BODY and asserted on ORDER, not on a byte window. A
    // fixed-width window tracks the length of the run-sheet loop above it; the
    // claim being made is positional, so test the positions.
    const runSheetTickStart = providerSource.indexOf('private _enqueueRunSheetTick(batchSize: number): void {');
    assert.ok(runSheetTickStart !== -1, '_enqueueRunSheetTick must exist');
    const runSheetTickBody = providerSource.slice(runSheetTickStart, providerSource.indexOf('\n    /**', runSheetTickStart));
    const stepsAt = runSheetTickBody.indexOf('_autobanTickColumn(');
    const survivorAt = runSheetTickBody.indexOf('_tickSurvivorSchedulerJobs(');
    const lastTickAt = runSheetTickBody.indexOf('_autobanLastTickAt.set(AUTOBAN_RUN_SHEET_TICK_KEY');
    assert.ok(
        stepsAt !== -1 && survivorAt !== -1 && lastTickAt !== -1 && stepsAt < survivorAt && survivorAt < lastTickAt,
        'survivor scheduler jobs must tick inside the run-sheet tick body — after the run-sheet steps, before the lastTickAt update'
    );
    assert.ok(
        !providerSource.includes('_startAllSchedulerLoops'),
        'the per-job scheduler engine (_startAllSchedulerLoops) is deleted — survivors ride the run-sheet tick'
    );
    assert.ok(
        !providerSource.includes('_startSchedulerJobLoop') && !providerSource.includes('_stopSchedulerJobLoop'),
        'the per-job scheduler loop methods are deleted — no per-job intervals, the run sheet is the one clock'
    );
    // BOTH survivors must reach a prompt. A tick that only builds fetch-plans
    // leaves the reconcile checkbox wired to nothing — enabled, ticking, silent.
    const survivorTickStart = providerSource.indexOf('private async _tickSurvivorSchedulerJobs()');
    assert.ok(survivorTickStart !== -1, '_tickSurvivorSchedulerJobs must exist');
    const survivorTickBody = providerSource.slice(survivorTickStart, providerSource.indexOf('\n    }\n', survivorTickStart));
    assert.ok(
        survivorTickBody.includes('buildFetchPlansPrompt(') && survivorTickBody.includes('buildReconcilePrompt('),
        'the survivor tick must build BOTH surviving prompts — a reconcile job with no promptOverride otherwise sends nothing'
    );
    // The checkbox is the start button now, so the tick owns terminal creation.
    // Resolve-only means the survivors never fire: launchSchedulerTerminal was
    // the only thing that ever created a `Scheduler: …` terminal, and it is gone.
    assert.ok(
        survivorTickBody.includes('_ensureSurvivorTerminal('),
        'the survivor tick must ensure its terminal exists — nothing else creates one now that launchSchedulerTerminal is deleted'
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
        survivorTickBody.indexOf('_schedulerInFlight.set(job.id, true)') < survivorTickBody.indexOf('_ensureSurvivorTerminal('),
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
        externalPromptBody.includes('getAutobanRunSheet()') && externalPromptBody.includes('DEFAULT_AUTOBAN_RUN_SHEET'),
        'the external prompt must render the run sheet as DATA so an edited sheet flows into the emitted text for free'
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
    assert.ok(
        DEFAULT_AUTOBAN_RUN_SHEET.length > 0 && DEFAULT_AUTOBAN_RUN_SHEET.every(s => s.sourceColumn && s.headRole),
        'the run sheet the external prompt renders must name a column and a role per step'
    );

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
    // The survivor checkboxes are present.
    assert.ok(
        kanbanHtml.includes('FETCH CLOUD PLANS') && kanbanHtml.includes('RECONCILE CLOUD WORK'),
        'the two survivor checkboxes (fetch-plans, reconcile) must be present in the AUTOMATION tab'
    );
    // The checkbox must UPSERT. '+ ADD JOB' died with the scheduler surface, so a
    // map-only toggle persists nothing on a config with no job of that source —
    // which is every fresh install — and the box snaps back on the next broadcast.
    assert.ok(
        /if \(!found\) \{[\s\S]{0,400}?source: sv\.source/.test(kanbanHtml),
        'the survivor checkbox must create the job record when none exists — nothing else can, now that + ADD JOB is deleted'
    );
    // The dropped-custom-jobs notice is wired.
    assert.ok(
        kanbanHtml.includes('droppedCustomJobsNotice'),
        'the dropped-custom-jobs notice must be wired in the AUTOMATION tab UI'
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
    assert.ok(
        kanbanHtml.includes("'agent-managed'") && kanbanHtml.includes("'scheduled'") && kanbanHtml.includes("'external'"),
        'the three mode radios (agent-managed, scheduled, external) must be present in the AUTOMATION tab'
    );
    assert.ok(
        kanbanHtml.includes('automation-status-line'),
        'the status line must be present in the AUTOMATION tab — always visible, even when nothing has happened'
    );
    // The command-palette entry is registered.
    const packageJson = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'package.json'), 'utf8'));
    assert.ok(
        packageJson.contributes.commands.some(c => c.command === 'switchboard.startOrchestrator'),
        'switchboard.startOrchestrator must be present in package.json contributes.commands'
    );
    const extensionSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
    assert.ok(
        extensionSrc.includes("registerCommand('switchboard.startOrchestrator'"),
        'switchboard.startOrchestrator must be registered in extension.ts'
    );
    // The external-mode paused-jobs line says "Scheduled", not "Internal".
    assert.ok(
        kanbanHtml.includes('Switch back to Scheduled to re-arm them'),
        'the external-mode paused-jobs line must say "Scheduled" (the new mode name), not "Internal"'
    );
    // The run-sheet timer badges are SCHEDULED-only. Both badge filters had an
    // `else if (mode === 'external')` arm, which on a three-value axis let
    // agent-managed fall through to the UNFILTERED set — a live countdown badge
    // per column for a clock that does not run in that mode.
    assert.ok(
        !/else if \(currentAutomationMode === 'external'\) \{\s*filteredBadgeData = \[\];/.test(kanbanHtml),
        "the timer-badge filter must not special-case 'external' — every non-scheduled mode shows no run-sheet badges, and an else-if lets agent-managed fall through to the unfiltered set"
    );
    assert.strictEqual(
        (kanbanHtml.match(/filteredBadgeData = \[\];/g) || []).length, 2,
        'both timer-badge filters must clear the badge set in their else arm — one per render path'
    );
    // Agent-managed carries the two things that define the mode: the wake
    // interval and the CLI that starts the agent. The boot command is SHOWN,
    // not edited — the orchestrator has no startup-command slot of its own.
    assert.ok(
        kanbanHtml.includes('agent-managed-boot-command'),
        'the agent-managed panel must name the CLI the orchestrator boots with — the mode is "a startup command and a wake interval"'
    );
    assert.ok(
        /lastStartupCommands\['lead'\] \|\| lastStartupCommands\['coder'\]/.test(kanbanHtml),
        "the displayed boot command must mirror startOrchestratorFromKanban's own resolution (lead, falling back to coder) — a divergent display lies about what will start"
    );

    console.log('autoban state regression test passed');
}

run().catch((error) => {
    console.error('autoban state regression test failed:', error);
    process.exit(1);
});
