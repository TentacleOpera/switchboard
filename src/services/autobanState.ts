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

export const ORCHESTRATOR_TERMINAL_NAME = 'Orchestrator';

export const AUTOBAN_SOURCE_COLUMN = 'PLAN REVIEWED';

/**
 * The automation axis is retained as a synthetic read-only value for
 * backward compatibility with callers that still read it. The real state
 * is two independent switches: `enabled` (schedule) and `orchestratorArmed`.
 *
 * `agent-managed` — the orchestrator is armed.
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

export type OrchestrationConfig = {
    intervalMinutes: number;   // wake interval for the orchestrator
};

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
    intervalMinutes: 10
};

export function normalizeOrchestrationConfig(state?: Partial<OrchestrationConfig> | null): OrchestrationConfig {
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
 * The orchestrator seat when a session adopted the role in place (POST
 * /orchestration/adopt) rather than the host seating a terminal named
 * 'Orchestrator'. `terminalName` is the pty friendlyName when the caller could
 * name itself (SWITCHBOARD_TERMINAL) — omitted when it could not, in which case
 * the seat is real but has no live delivery channel and reads the reports inbox.
 * Absent (the shipped default) = no adopted seat = pre-adopt behaviour.
 */
export interface OrchestratorSeat {
    terminalName?: string;
    adoptedAt: string;
}

export type AutobanConfigState = {
    enabled: boolean;
    /** Orchestrator switch — independent of the schedule. Both can be on. */
    orchestratorArmed?: boolean;
    /** Orchestrator seat when adopted in place via POST /orchestration/adopt. */
    orchestratorSeat?: OrchestratorSeat;
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
    orchestrationConfig?: OrchestrationConfig;
    /** One-time notice shown in the Internal panel when a board-batch job is migrated. */
    migratedBoardBatchNotice?: string;
    /** One-time notice shown when custom scheduler jobs are dropped on read. */
    droppedCustomJobsNotice?: string;
    /** One-time notice shown when a retired automationMode is detected on load.
     * The schedule is forced off — the user must explicitly re-arm it. */
    retiredAutomationModeNotice?: string;
};

/**
 * Every `automationMode` value that has ever shipped. ALL of them are retired —
 * the exclusive mode axis is deleted and replaced by two independent switches
 * (`enabled` = queue schedule, `orchestratorArmed` = orchestrator wake), so a
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
    // value of the old one. `orchestratorArmed` is always written by this
    // normaliser, so any state that has an `automationMode` but no
    // `orchestratorArmed` predates the collapse and is disarmed exactly once;
    // every state written after that carries the flag and is left alone. This
    // is the inversion the plan calls for — under the old shape an unrecognised
    // value meant "keep ticking the board", and there is no board tick left.
    const rawAutomationMode = typeof state?.automationMode === 'string' ? state.automationMode : undefined;
    const isRetiredMode = rawAutomationMode !== undefined
        && state?.orchestratorArmed === undefined;

    // Derive the two switches from the legacy mode if the new flags are absent.
    const legacyMode = normalizeAutomationMode(state?.automationMode, (state as any)?.orchestrationConfig?.enabled);
    const orchestratorArmed = state?.orchestratorArmed === true
        || (state?.orchestratorArmed === undefined && legacyMode === 'agent-managed' && state?.enabled === true);
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
        ? `Automation mode '${rawAutomationMode}'${RETIRED_AUTOMATION_MODES.has(rawAutomationMode!) ? '' : ' (unrecognised)'} is retired — the schedule and the orchestrator are now independent switches. The schedule has been turned off so nothing dispatches from a queue you did not stage; re-arm it explicitly from the Automation panel to resume.`
        : undefined;

    // Preserve unknown/legacy keys from the input state rather than dropping
    // them. Deleted fields (triggerMode, runSheet) are stripped so they do not
    // leak back into the persisted state. The normalized fields below override
    // anything from the input.
    const { triggerMode: _strippedTriggerMode, runSheet: _strippedRunSheet, ...preservedUnknownKeys } = (state ?? {}) as any;

    return {
        ...preservedUnknownKeys,
        enabled,
        orchestratorArmed,
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
        orchestrationConfig: normalizeOrchestrationConfig(state?.orchestrationConfig),
        orchestratorSeat: (function (s: any) {
            if (!s || typeof s !== 'object') return undefined;
            const adoptedAt = typeof s.adoptedAt === 'string' ? s.adoptedAt : '';
            if (!adoptedAt) return undefined;
            const terminalName = typeof s.terminalName === 'string' && s.terminalName.trim()
                ? s.terminalName.trim() : undefined;
            return { terminalName, adoptedAt };
        })((state as any)?.orchestratorSeat),
        migratedBoardBatchNotice: typeof state?.migratedBoardBatchNotice === 'string' ? state.migratedBoardBatchNotice : undefined,
        droppedCustomJobsNotice: typeof state?.droppedCustomJobsNotice === 'string' ? state.droppedCustomJobsNotice : undefined,
        retiredAutomationModeNotice
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
