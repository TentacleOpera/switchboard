/**
 * Per-column rule state. The triggerMode axis is deleted — the schedule
 * calls the queue pop, and a self-pacing lead calls it directly. There is
 * no completion-driven dispatch and no watch mode.
 */
export type AutobanRuleState = {
    enabled: boolean;
    intervalMinutes: number;
};

export type AutobanComplexityFilter = 'all' | 'low_and_below' | 'medium_and_below' | 'medium_and_above' | 'high_and_above';
export type AutobanRoutingMode = 'dynamic' | 'all_coder' | 'all_lead';

export const AUTOBAN_SHARED_REVIEWER_COLUMNS = ['LEAD CODED', 'CODER CODED', 'INTERN CODED'] as const;

export const AUTOBAN_BATCH_SIZE_OPTIONS = [1, 2, 3, 4, 5] as const;
export const DEFAULT_AUTOBAN_BATCH_SIZE = 1;
export const MAX_AUTOBAN_TERMINALS_PER_ROLE = 5;

export const MISSION_CONTROL_TERMINAL_NAME = 'Mission Control';

export const AUTOBAN_SOURCE_COLUMN = 'PLAN REVIEWED';

/**
 * The automation axis is retained as a synthetic read-only value for
 * backward compatibility with callers that still read it. The real state
 * is two independent switches: `enabled` (schedule) and `missionControlArmed`.
 *
 * `agent-managed` — Mission Control is armed.
 * `scheduled` — the schedule is enabled.
 * `external` — neither switch is on.
 *
 * Both switches can be on simultaneously. `getAutomationMode()` in
 * TaskViewerProvider derives the synthetic value from the switches.
 */
export type AutobanAutomationMode = 'agent-managed' | 'scheduled' | 'external';

/**
 * Tick key for the schedule clock. Not a real column name, so it can
 * never collide with a `rules` entry or a source column.
 */
export const AUTOBAN_RUN_SHEET_TICK_KEY = '__RUN_SHEET__';

export type SingleColumnAutobanConfig = {
    enabled: boolean;
    intervalMinutes: number;
    batchSize: number;
    complexityFilter: AutobanComplexityFilter;
    /**
     * The WHEN control — a single schedule for the queue pop.
     * null/undefined = OFF (default): the schedule runs on a fixed interval.
     * A 5-field cron string = ON: the schedule fires on the cron line.
     */
    whenSchedule?: string | null;
};

export type MissionControlConfig = {
    intervalMinutes: number;   // wake interval for Mission Control
};

export const DEFAULT_MISSION_CONTROL_CONFIG: MissionControlConfig = {
    intervalMinutes: 10
};

export function normalizeMissionControlConfig(state?: Partial<MissionControlConfig> | null): MissionControlConfig {
    return {
        // Floor of 1 minute, no ceiling — "once every few hours" and "overnight"
        // are valid wake intervals, same reasoning as the schedule interval.
        // Reads through the persisted value rather than defaulting past it.
        intervalMinutes: Math.max(1, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 10)
    };
}

export const DEFAULT_SINGLE_COLUMN_CONFIG: SingleColumnAutobanConfig = {
    enabled: false,
    intervalMinutes: 10,
    batchSize: 1,
    complexityFilter: 'all',
    whenSchedule: null
};

export function normalizeSingleColumnConfig(state?: Partial<SingleColumnAutobanConfig> | null): SingleColumnAutobanConfig {
    const rawSchedule = state?.whenSchedule;
    const whenSchedule = typeof rawSchedule === 'string' && rawSchedule.trim() ? rawSchedule.trim() : null;
    return {
        enabled: state?.enabled === true,
        // Floor of 1 minute only — no ceiling. The schedule interval is how often
        // the board advances, and "once every few hours" or "overnight" are valid
        // answers. A 60-minute cap was an arbitrary bound, not a constraint.
        intervalMinutes: Math.max(1, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 10),
        batchSize: normalizeAutobanBatchSize(state?.batchSize),
        complexityFilter: (['all', 'low_and_below', 'medium_and_below', 'medium_and_above', 'high_and_above'] as const).includes(state?.complexityFilter as any)
            ? state!.complexityFilter!
            : 'all',
        whenSchedule
    };
}

/**
 * Mission Control seat when a session adopted the role in place (POST
 * /mission-control/adopt) rather than the host seating a terminal named
 * 'Mission Control'. `terminalName` is the pty friendlyName when the caller could
 * name itself (SWITCHBOARD_TERMINAL) — omitted when it could not, in which case
 * the seat is real but has no live delivery channel and reads the reports inbox.
 * Absent (the shipped default) = no adopted seat = pre-adopt behaviour.
 */
export interface MissionControlSeat {
    terminalName?: string;
    adoptedAt: string;
}

export type ScheduleSelector = 'oldest';

export interface ScheduleRule {
    timeWindow?: string | { start: string; end: string } | null;
    sourceColumn: string;
    selector: ScheduleSelector;
    targetColumn: string;
}

export type MissionRunFlavour = 'unattended' | 'operations';

export interface MissionRunConfig {
    missionId: string;
    flavour: MissionRunFlavour;
}

export function normalizeScheduleRule(rule: unknown): ScheduleRule | null {
    if (!rule || typeof rule !== 'object') return null;
    const r = rule as any;
    if (typeof r.sourceColumn !== 'string' || !r.sourceColumn.trim()) return null;
    if (typeof r.targetColumn !== 'string' || !r.targetColumn.trim()) return null;

    let timeWindow = r.timeWindow;
    if (typeof timeWindow === 'string') {
        timeWindow = timeWindow.trim() || undefined;
    } else if (timeWindow && typeof timeWindow === 'object') {
        const start = typeof timeWindow.start === 'string' ? timeWindow.start.trim() : '';
        const end = typeof timeWindow.end === 'string' ? timeWindow.end.trim() : '';
        timeWindow = (start || end) ? { start, end } : undefined;
    } else {
        timeWindow = undefined;
    }

    return {
        timeWindow,
        sourceColumn: r.sourceColumn.trim(),
        selector: 'oldest',
        targetColumn: r.targetColumn.trim()
    };
}

export function normalizeMissionRunConfig(config: unknown): MissionRunConfig | null {
    if (!config || typeof config !== 'object') return null;
    const c = config as any;
    if (typeof c.missionId !== 'string' || !c.missionId.trim()) return null;
    const flavour: MissionRunFlavour = c.flavour === 'operations' ? 'operations' : 'unattended';
    return {
        missionId: c.missionId.trim(),
        flavour
    };
}

export type AutobanConfigState = {
    enabled: boolean;
    /** Mission Control switch — independent of the schedule. Both can be on. */
    missionControlArmed?: boolean;
    /** Mission Control seat when adopted in place via POST /mission-control/adopt. */
    missionControlSeat?: MissionControlSeat;
    batchSize: number;
    complexityFilter: AutobanComplexityFilter;
    routingMode: AutobanRoutingMode;
    rules: Record<string, AutobanRuleState>;
    lastTickAt?: Record<string, number>;
    paused: boolean;
    pausedRemainingMs?: Record<string, number>;
    pairProgrammingMode: 'off' | 'cli-cli' | 'cli-ide' | 'ide-cli' | 'ide-ide';
    aggressivePairProgramming: boolean;
    /** Synthetic read-only value derived from the two switches. Not authoritative. */
    automationMode?: AutobanAutomationMode;
    singleColumnConfig?: SingleColumnAutobanConfig;
    missionControlConfig?: MissionControlConfig;
    /** One-time notice shown in the Internal panel when a board-batch job is migrated. */
    migratedBoardBatchNotice?: string;
    /** One-time notice shown when custom scheduler jobs are dropped on read. */
    droppedCustomJobsNotice?: string;
    /** One-time notice shown when a retired automationMode is detected on load.
     * The schedule is forced off — the user must explicitly re-arm it. */
    retiredAutomationModeNotice?: string;
    /** One-time notice shown when recurring jobs resume after external mode retirement. */
    recurringJobsResumedNotice?: string;
    /** Reason recorded whenever automation switches itself off. Absent reads as
     *  "no recorded reason". Set by _stopAutobanEngine and every self-stop path.
     *  Survives persistence because _autobanState is workspace-state-persisted. */
    stopReason?: string;
};

/**
 * Every `automationMode` value that has ever shipped. ALL of them are retired —
 * the exclusive mode axis is deleted and replaced by two independent switches
 * (`enabled` = queue schedule, `missionControlArmed` = Mission Control wake), so a
 * shipped install carrying ANY of these must not keep its clock running. The
 * guard in `normalizeAutobanConfigState` does not test membership of this set
 * (a state can carry an unrecognised value too); the set exists so the disarm
 * notice can name the values a reader will actually find in `autoban.state`,
 * and so the migration's blast radius is documented in one place.
 *
 * `agent-managed` / `orchestration` / `internal` never installed a schedule
 * timer at all, which is why carrying `enabled: true` across the upgrade is a
 * behaviour change on those installs and not merely a continuation.
 */
export const RETIRED_AUTOMATION_MODES = new Set([
    'scheduled',
    'agent-managed',
    'external',
    'run-sheet',
    'scheduler',
    'single-column',
    'orchestration',
    'internal'
]);

const DEFAULT_AUTOBAN_RULES: Record<string, AutobanRuleState> = {
    CREATED: { enabled: true, intervalMinutes: 10 },
    'PLAN REVIEWED': { enabled: true, intervalMinutes: 20 },
    'INTERN CODED': { enabled: true, intervalMinutes: 15 },
    'LEAD CODED': { enabled: true, intervalMinutes: 15 },
    'CODER CODED': { enabled: true, intervalMinutes: 15 }
};

function normalizeFiniteCount(value: unknown, fallback: number, minimum: number, maximum?: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    if (value < minimum) {
        return fallback;
    }
    const normalized = Math.floor(value);
    return typeof maximum === 'number' ? Math.min(normalized, maximum) : normalized;
}

export function normalizeAutobanBatchSize(value: unknown): number {
    return normalizeFiniteCount(
        value,
        DEFAULT_AUTOBAN_BATCH_SIZE,
        AUTOBAN_BATCH_SIZE_OPTIONS[0],
        AUTOBAN_BATCH_SIZE_OPTIONS[AUTOBAN_BATCH_SIZE_OPTIONS.length - 1]
    );
}

export function isSharedReviewerAutobanColumn(column: string): column is typeof AUTOBAN_SHARED_REVIEWER_COLUMNS[number] {
    return AUTOBAN_SHARED_REVIEWER_COLUMNS.includes(column as typeof AUTOBAN_SHARED_REVIEWER_COLUMNS[number]);
}

export function getEnabledSharedReviewerAutobanColumns(
    rules?: Record<string, AutobanRuleState> | null
): string[] {
    return AUTOBAN_SHARED_REVIEWER_COLUMNS.filter(column => rules?.[column]?.enabled !== false);
}

export function shouldSkipSharedReviewerAutobanDispatch(
    lastDispatchAt: number | undefined,
    lastTickAt: Map<string, number> | Record<string, number> | undefined,
    sourceColumns: readonly string[]
): boolean {
    if (!lastDispatchAt || sourceColumns.length === 0) {
        return false;
    }

    let latestTickAt = 0;
    for (const sourceColumn of sourceColumns) {
        const value = lastTickAt instanceof Map
            ? lastTickAt.get(sourceColumn)
            : lastTickAt?.[sourceColumn];
        if (typeof value === 'number' && Number.isFinite(value)) {
            latestTickAt = Math.max(latestTickAt, value);
        }
    }

    return latestTickAt > 0 && lastDispatchAt >= latestTickAt;
}

export function getNextAutobanTerminalName(
    roleLabel: string,
    usedNames: Iterable<string>,
    requestedName?: string
): string {
    const normalizedUsedNames = new Set(
        Array.from(usedNames)
            .map(name => String(name || '').trim())
            .filter(Boolean)
    );
    const trimmedRequestedName = typeof requestedName === 'string' ? requestedName.trim() : '';

    if (trimmedRequestedName) {
        let uniqueName = trimmedRequestedName;
        let counter = 2;
        while (normalizedUsedNames.has(uniqueName)) {
            uniqueName = `${trimmedRequestedName} ${counter++}`;
        }
        return uniqueName;
    }

    let counter = 2;
    let uniqueName = `${roleLabel} ${counter}`;
    while (normalizedUsedNames.has(uniqueName)) {
        counter += 1;
        uniqueName = `${roleLabel} ${counter}`;
    }
    return uniqueName;
}

/**
 * The automation axis is retained as a synthetic read-only value for
 * backward compatibility. The INVERTED default is `external` — a fresh
 * install or an unrecognised persisted value does NOT auto-start a clock.
 * This is the safe default: nothing runs until the user explicitly arms
 * a switch.
 *
 * Retired values MAP for the synthetic field only — the GUARD in
 * normalizeAutobanConfigState forces enabled: false regardless:
 *  - `scheduled`, `run-sheet`, `scheduler`, `single-column` → `scheduled` (synthetic)
 *  - `agent-managed`, `orchestration`, `internal` (with orchEnabled) → `agent-managed` (synthetic)
 *  - `external` → `external`
 *  - undefined / unrecognised → `external` (the inverted default)
 *
 * The mapping is for display only. A shipped install carrying a retired
 * mode will show the mapped mode in the UI but will NOT dispatch — the
 * guard sees the original retired value and forces enabled: false.
 */
export function normalizeAutomationMode(value: unknown, orchEnabled?: boolean): AutobanAutomationMode {
    if (value === 'external') { return 'external'; }
    if (value === 'agent-managed') { return 'agent-managed'; }
    if (value === 'orchestration' || (value === 'internal' && orchEnabled === true)) { return 'agent-managed'; }
    if (value === 'scheduled' || value === 'run-sheet' || value === 'scheduler' || value === 'single-column') { return 'scheduled'; }
    // Inverted default: external, not scheduled. A fresh install runs nothing
    // until the user explicitly arms a switch.
    return 'external';
}

export function normalizeAutobanConfigState(state?: Partial<AutobanConfigState> | null): AutobanConfigState {
    const rawRules = state?.rules ?? {};
    const legacyCodedRule = rawRules['CODED'];
    const mergedRules = {
        ...DEFAULT_AUTOBAN_RULES,
        ...rawRules,
        'LEAD CODED': rawRules['LEAD CODED'] ?? legacyCodedRule ?? DEFAULT_AUTOBAN_RULES['LEAD CODED'],
        'CODER CODED': rawRules['CODER CODED'] ?? legacyCodedRule ?? DEFAULT_AUTOBAN_RULES['CODER CODED'],
        'INTERN CODED': rawRules['INTERN CODED'] ?? DEFAULT_AUTOBAN_RULES['INTERN CODED']
    };
    const normalizedRules = Object.fromEntries(
        Object.entries(mergedRules)
            .filter(([column]) => column !== 'CODED')
            .map(([column, rule]) => {
                const fallback = DEFAULT_AUTOBAN_RULES[column] ?? { enabled: true, intervalMinutes: 10 };
                const intervalMinutes = normalizeFiniteCount(rule?.intervalMinutes, fallback.intervalMinutes, 1);
                return [column, {
                    enabled: typeof rule?.enabled === 'boolean' ? rule.enabled : fallback.enabled,
                    intervalMinutes
                }] as [string, AutobanRuleState];
            })
    );

    // Detect a pre-two-switch persisted state. THE WHOLE MODE AXIS is retired,
    // not just the five older aliases: `scheduled` was the common running mode
    // on shipped installs, and under the old engine `enabled: true` meant "walk
    // the run sheet over CREATED / PLAN REVIEWED". Under the new engine the same
    // flag means "pop the STAGING queue on a timer" — so carrying `enabled`
    // across the upgrade starts dispatching from a queue the user never staged.
    // `agent-managed` is worse: it never installed a schedule timer at all, and
    // a naive carry-over gives that install one it never had.
    //
    // The discriminator is therefore the ABSENCE of the new switch, not the
    // value of the old one. `missionControlArmed` is always written by this
    // normaliser, so any state that has an `automationMode` but no
    // `missionControlArmed` predates the collapse and is disarmed exactly once;
    // every state written after that carries the flag and is left alone. This
    // is the inversion the plan calls for — under the old shape an unrecognised
    // value meant "keep ticking the board", and there is no board tick left.
    // ── Renamed-key compat read ────────────────────────────────────────────
    // The orchestrator→Mission Control rename changed four PERSISTED keys in
    // `workspaceState['autoban.state']`: orchestratorArmed, orchestratorSeat,
    // orchestrationConfig and (as a legacy-only probe) orchestrationConfig.enabled.
    // The rename plan assumed there was no persisted state to migrate; there is,
    // on every install that has ever opened the Automation panel.
    //
    // This coalescing MUST happen before the retired-mode discriminator below,
    // and it is the load-bearing half of this block. That discriminator fires on
    // "has an automationMode but no armed flag" — and `automationMode` is ALWAYS
    // written by this normaliser. So without the coalesce, every install that had
    // already completed the two-switch collapse reads as pre-collapse on the
    // first launch after the rename: `enabled` forced false (a working schedule
    // silently disarmed) plus a "your automation mode is retired" notice nobody
    // earned. Reading the old key first makes the upgrade a no-op, which is what
    // it should be.
    const legacyState = (state ?? {}) as any;
    const rawArmed = state?.missionControlArmed !== undefined
        ? state.missionControlArmed
        : legacyState.orchestratorArmed;
    const rawSeat = legacyState.missionControlSeat ?? legacyState.orchestratorSeat;
    const rawMissionControlConfig = legacyState.missionControlConfig ?? legacyState.orchestrationConfig;

    const rawAutomationMode = typeof state?.automationMode === 'string' ? state.automationMode : undefined;
    const isRetiredMode = rawAutomationMode !== undefined
        && rawArmed === undefined;

    // Derive the two switches from the legacy mode if the new flags are absent.
    // The second argument is a LEGACY-ONLY probe: `.enabled` was never a field on
    // MissionControlConfig/OrchestrationConfig, it only ever appeared on the
    // persisted `orchestrationConfig` blob of old installs. The rename sweep
    // renamed it, which killed the internal→agent-managed mapping it exists for;
    // reading the coalesced value restores it.
    const legacyMode = normalizeAutomationMode(state?.automationMode, rawMissionControlConfig?.enabled);
    const missionControlArmed = rawArmed === true
        || (rawArmed === undefined && legacyMode === 'agent-managed' && state?.enabled === true);
    // `enabled` is the schedule switch. If the new flag is absent, derive from
    // the legacy mode: scheduled → enabled, agent-managed/external → disabled.
    // A retired mode ALWAYS forces enabled: false — the guard that prevents
    // a shipped install from auto-dispatching after the mode axis is deleted.
    let enabled = state?.enabled === true
        || (state?.enabled === undefined && legacyMode === 'scheduled');
    if (isRetiredMode) {
        enabled = false;
    }

    // The notice is set in the normalized state so it reaches the broadcast.
    // TaskViewerProvider latches the DISPLAY behind a workspaceState flag so it
    // shows on exactly one activation — the same pattern as migratedBoardBatchNotice.
    const retiredAutomationModeNotice = isRetiredMode
        ? `Automation mode '${rawAutomationMode}'${RETIRED_AUTOMATION_MODES.has(rawAutomationMode!) ? '' : ' (unrecognised)'} is retired — the schedule and Mission Control are now independent switches. The schedule has been turned off so nothing dispatches from a queue you did not stage; re-arm it explicitly from the Mission Control panel to resume.`
        : undefined;

    const recurringJobsResumedNotice = (isRetiredMode && rawAutomationMode === 'external')
        ? 'Recurring jobs (fetch-plans, reconcile) have resumed. External scheduling is now a prompt generator that runs independently and no longer pauses local background jobs.'
        : undefined;

    // Preserve unknown/legacy keys from the input state rather than dropping
    // them. Deleted fields (triggerMode, runSheet) are stripped so they do not
    // leak back into the persisted state. The normalized fields below override
    // anything from the input.
    // The four renamed keys are stripped alongside them: their values were
    // imported into the new names above (import before deleting), so leaving the
    // originals in would persist a stale duplicate that drifts from the live one.
    const {
        triggerMode: _strippedTriggerMode,
        runSheet: _strippedRunSheet,
        orchestratorArmed: _strippedOrchestratorArmed,
        orchestratorSeat: _strippedOrchestratorSeat,
        orchestrationConfig: _strippedOrchestrationConfig,
        ...preservedUnknownKeys
    } = (state ?? {}) as any;

    return {
        ...preservedUnknownKeys,
        enabled,
        missionControlArmed,
        batchSize: normalizeAutobanBatchSize(state?.batchSize),
        complexityFilter: (function(f: any) {
            if (f === 'low_only') return 'low_and_below';
            if (f === 'high_only') return 'high_and_above';
            const valid: AutobanComplexityFilter[] = ['all', 'low_and_below', 'medium_and_below', 'medium_and_above', 'high_and_above'];
            return valid.includes(f) ? (f as AutobanComplexityFilter) : 'all';
        })(state?.complexityFilter),
        routingMode: state?.routingMode === 'all_coder' || state?.routingMode === 'all_lead'
            ? state.routingMode
            : 'dynamic',
        rules: normalizedRules,
        lastTickAt: state?.lastTickAt ? { ...state.lastTickAt } : undefined,
        paused: state?.paused === true,
        pausedRemainingMs: (typeof state?.pausedRemainingMs === 'object' && state!.pausedRemainingMs !== null)
            ? Object.fromEntries(
                Object.entries(state!.pausedRemainingMs)
                    .filter(([, v]) => typeof v === 'number' && Number.isFinite(v) && v > 0)
                    .map(([k, v]) => [String(k).trim(), v])
              )
            : undefined,
        pairProgrammingMode: (function(m: any, legacyEnabled: any) {
            const valid = ['off', 'cli-cli', 'cli-ide', 'ide-cli', 'ide-ide'];
            if (valid.includes(m)) return m;
            // Legacy migration: boolean true → cli-cli
            if (legacyEnabled === true) return 'cli-cli';
            return 'off';
        })((state as any)?.pairProgrammingMode, (state as any)?.pairProgrammingEnabled),
        aggressivePairProgramming: state?.aggressivePairProgramming === true,
        automationMode: legacyMode,
        singleColumnConfig: normalizeSingleColumnConfig(state?.singleColumnConfig),
        missionControlConfig: normalizeMissionControlConfig(rawMissionControlConfig),
        missionControlSeat: (function (s: any) {
            if (!s || typeof s !== 'object') return undefined;
            const adoptedAt = typeof s.adoptedAt === 'string' ? s.adoptedAt : '';
            if (!adoptedAt) return undefined;
            const terminalName = typeof s.terminalName === 'string' && s.terminalName.trim()
                ? s.terminalName.trim() : undefined;
            return { terminalName, adoptedAt };
        })(rawSeat),
        migratedBoardBatchNotice: typeof state?.migratedBoardBatchNotice === 'string' ? state.migratedBoardBatchNotice : undefined,
        droppedCustomJobsNotice: typeof state?.droppedCustomJobsNotice === 'string' ? state.droppedCustomJobsNotice : undefined,
        retiredAutomationModeNotice,
        recurringJobsResumedNotice,
        stopReason: typeof (state as any)?.stopReason === 'string' && (state as any).stopReason.trim()
            ? (state as any).stopReason : undefined
    };
}

export function buildAutobanBroadcastState(
    state: AutobanConfigState,
    lastTickEntries: Iterable<[string, number]>
): AutobanConfigState {
    return {
        ...normalizeAutobanConfigState(state),
        lastTickAt: Object.fromEntries(lastTickEntries)
    };
}
