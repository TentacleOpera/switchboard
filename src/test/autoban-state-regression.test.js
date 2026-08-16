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

    // --- The mode axis is exactly internal|external, and it MAPS, never whitelists ---
    // A whitelist that fell through would silently disarm a shipped install's
    // clock. Everything unrecognised must land on `internal`.
    for (const legacy of ['single-column', 'multi-column', 'orchestration', 'run-sheet', 'scheduler', '', 'nonsense', undefined, null]) {
        assert.strictEqual(
            normalizeAutobanConfigState({ automationMode: legacy }).automationMode,
            'internal',
            `a persisted automationMode of ${JSON.stringify(legacy)} must normalise to 'internal' — falling through a whitelist disarms shipped installs`
        );
    }
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'external' }).automationMode,
        'external',
        "'external' is the only value that normalises to external"
    );

    // --- Oversight is a FLAG, not a mode (plan: oversight-stops-being-a-mode) ---
    // The already-landed state migration: an install persisted in the retired
    // `orchestration` mode keeps its oversight armed rather than losing it.
    const migratedOversight = normalizeAutobanConfigState({ automationMode: 'orchestration' });
    assert.strictEqual(migratedOversight.automationMode, 'internal', 'the retired orchestration mode migrates onto internal');
    assert.strictEqual(
        migratedOversight.orchestrationConfig.enabled,
        true,
        'a persisted orchestration mode must carry its intent across into orchestrationConfig.enabled'
    );
    assert.strictEqual(
        normalizeAutobanConfigState({ automationMode: 'internal' }).orchestrationConfig.enabled,
        false,
        'oversight is off by default — the migration must not arm every install'
    );

    // isAutomationArmed is the OversightPassService 409 guard. Arming oversight
    // no longer sets autobanState.enabled, so without the OR the 409 stops
    // firing and an oversight pass double-dispatches against a live orchestrator.
    // It is NOT a mode branch — grepping for a mode comparison finds nothing.
    assert.ok(
        /isAutomationArmed:\s*\(\)\s*=>\s*this\._autobanState\.enabled === true \|\| this\._autobanState\.orchestrationConfig\?\.enabled === true/.test(providerSource),
        'isAutomationArmed must OR on orchestrationConfig.enabled — otherwise arming oversight stops tripping the double-dispatch 409'
    );
    // Arming and enabling are two independent writes.
    assert.ok(
        !/startOrchestratorFromKanban[\s\S]{0,3000}?automationMode:\s*'orchestration'/.test(providerSource),
        'startOrchestratorFromKanban must not write automationMode — arming oversight is not a mode change'
    );
    assert.ok(
        !/public async stopOrchestratorFromKanban[\s\S]{0,900}?_stopAutobanEngine\(\)/.test(providerSource),
        'stopOrchestratorFromKanban must not stop the autoban engine — unticking oversight must leave board progression running'
    );
    assert.ok(
        providerSource.includes('public isOversightAgentRunning(): boolean'),
        'callers meaning "is the orchestrator supervising" need an explicit accessor, not an overloaded mode read'
    );
    // Worktree topology rides the ARMING transition, not the mode transition.
    // Both halves must move: a left-behind `else` arm fires on every ordinary
    // mode switch and eats a prior that oversight stashed.
    assert.ok(
        kanbanProviderSource.includes('public async applyOversightWorktreeTopology(workspaceRoot: string, armed: boolean)'),
        'the worktree stash/restore pair must live on one oversight-arming entry point reachable from HTTP and the webview alike'
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
    // The only surviving `orchestration` mode literals are the state migration.
    for (const file of ['TaskViewerProvider.ts', 'KanbanProvider.ts']) {
        const src = fs.readFileSync(path.join(process.cwd(), 'src', 'services', file), 'utf8');
        assert.ok(
            !/(automationMode|msg\.mode|mode)\s*===\s*'orchestration'/.test(src),
            `${file} must not compare a mode against 'orchestration' — oversight is a flag now`
        );
    }

    // --- External mode runs NO clock, and the gate has more than one door ---
    // Asserted on the source because the failure is a live setInterval, and a
    // test that reads the mode back is exactly the test that passes while the
    // clock runs.
    const engineBody = providerSource.slice(providerSource.indexOf('private _startAutobanEngine(): void {'));
    assert.ok(
        /automationMode === 'external'[\s\S]{0,400}?return;/.test(engineBody.slice(0, 800)),
        '_startAutobanEngine must refuse in external mode, at the top, after stopping any surviving timer'
    );
    const resetBody = providerSource.slice(providerSource.indexOf('public async resetAutobanTimersFromKanban()'));
    assert.ok(
        /automationMode === 'external'[\s\S]{0,300}?return;/.test(resetBody.slice(0, 1200)),
        'resetAutobanTimersFromKanban installs its OWN setInterval — it needs its own external gate, beside and independent of the !enabled return'
    );
    const pausedBody = providerSource.slice(providerSource.indexOf('public async setAutobanPausedFromKanban('));
    assert.ok(
        /automationMode === 'external'[\s\S]{0,400}?return;/.test(pausedBody.slice(0, 2600)),
        'resume-from-pause is a THIRD timer-install path — `paused` survives the switch into external, so it needs its own gate too'
    );
    assert.ok(
        /const isExternal = this\._autobanState\.automationMode === 'external';/.test(providerSource) &&
        providerSource.includes("job.target === 'local-terminal' && !isExternal"),
        'scheduler job loops are a further clock — local-terminal jobs must not start in external mode'
    );
    assert.ok(
        /await this\._startAllSchedulerLoops\(\);/.test(providerSource.slice(
            providerSource.indexOf('public async setAutomationModeFromKanban(')
        ).slice(0, 4000)),
        'scheduler loops must be re-run on every mode transition so switching back to internal re-arms them'
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
    const externalPromptBody = kanbanProviderSource.slice(
        kanbanProviderSource.indexOf('private _buildExternalAutomationPrompt('),
        kanbanProviderSource.indexOf('private _buildCustomPrompt(')
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
    assert.ok(
        externalPromptBody.includes('KanbanProvider.BOARD_DRIVING_CONTRACT') &&
        kanbanProviderSource.split('KanbanProvider.BOARD_DRIVING_CONTRACT').length >= 3,
        'the board-driving paragraph must be ONE shared constant referenced by both the reconcile prompt and the external prompt, not two copies'
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
        /DROPPED_SOURCES = new Set\(\['comms', 'board-batch'\]\)/.test(configServiceSource),
        'comms and board-batch jobs are dropped on READ — never by a destructive pass over integration-config.json'
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
    // still backs the Antigravity copy button and the schedulerPrompt verb.
    assert.ok(
        kanbanProviderSource.includes('private async _buildBoardBatchPromptCore('),
        '_buildBoardBatchPromptCore must survive the board-batch job-source deletion — it has other callers'
    );

    console.log('autoban state regression test passed');
}

run().catch((error) => {
    console.error('autoban state regression test failed:', error);
    process.exit(1);
});
