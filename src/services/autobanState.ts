/**
 * How a column decides WHEN to dispatch.
 *
 * `drain` (default) and `watch` are clock-driven: the engine installs an
 * interval per enabled column and dispatches a card each tick. That is the
 * supported default and always has been.
 *
 * `completion` is the opt-in alternative: no interval, one card in flight, and
 * the next dispatch is triggered by the turn-end signal for the previous one.
 * It is a custom mode for people who want strict one-in-one-out pacing — it
 * does NOT replace the clock.
 */
export type AutobanTriggerMode = 'drain' | 'watch' | 'completion';
export type AutobanRuleState = {
    enabled: boolean;
    intervalMinutes: number;
    triggerMode?: AutobanTriggerMode;
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
 * The automation axis is *who runs the clock*.
 *
 * `internal` — Switchboard runs the run sheet on its own schedule, dispatching
 * to local terminals. Oversight agent optional. This is the only mode that
 * installs timers and dispatches.
 *
 * `external` — Switchboard emits a copyable prompt for a tool that runs agent
 * cron jobs (Antigravity, a Claude scheduled agent). Switchboard runs no clock
 * and dispatches nothing.
 *
 * Orchestration is NOT a mode — it is an optional oversight agent armed via
 * `orchestrationConfig.enabled` while the run sheet runs.
 */
export type AutobanAutomationMode = 'internal' | 'external';

/**
 * One step of the run sheet: "if this team's head is alive and this column has
 * cards, send one card to that head."
 *
 * `headRole` names a TEAM HEAD, not a pool slot. Resolution prefers the head of
 * a team defined for that role and falls back to any alive terminal carrying it;
 * the head then delegates to its own members, which is what team mode is for.
 * There is no complexity routing and no role fallback chain here — a step either
 * has its team or it is skipped this tick.
 */
/**
 * Tick key for the single run-sheet clock. Not a real column name, so it can
 * never collide with a `rules` entry or a source column.
 */
export const AUTOBAN_RUN_SHEET_TICK_KEY = '__RUN_SHEET__';

export type AutobanRunSheetStep = {
    sourceColumn: string;
    headRole: string;
};

/**
 * THE RUN SHEET. One clock, ordered steps, evaluated top to bottom every tick.
 *
 * Hard-coded for now and deliberately shaped as DATA rather than control flow,
 * so making it user-editable later is a config read plus an editor — not a
 * rewrite of the tick. Order matters: earlier steps feed later ones, so running
 * the planner step first lets a plan it produces be picked up by the coder step
 * on a subsequent tick rather than waiting a full extra interval.
 */
export const DEFAULT_AUTOBAN_RUN_SHEET: readonly AutobanRunSheetStep[] = [
    { sourceColumn: 'CREATED', headRole: 'planner' },
    { sourceColumn: AUTOBAN_SOURCE_COLUMN, headRole: 'coder' }
] as const;

export type SingleColumnAutobanConfig = {
    enabled: boolean;
    intervalMinutes: number;
    batchSize: number;
    complexityFilter: AutobanComplexityFilter;
    triggerMode?: AutobanTriggerMode;
    /**
     * The WHEN control — a single schedule for the run sheet.
     * null/undefined = OFF (default): the run sheet runs continuously,
     * paced by completion (today's behaviour).
     * A 5-field cron string = ON: the run sheet fires on the cron line.
     */
    whenSchedule?: string | null;
};

export type OrchestrationConfig = {
    enabled: boolean;          // orchestrator session armed (Start pressed, not yet stopped)
};

export const DEFAULT_ORCHESTRATION_CONFIG: OrchestrationConfig = {
    enabled: false
};

export function normalizeOrchestrationConfig(state?: Partial<OrchestrationConfig> | null): OrchestrationConfig {
    return {
        enabled: state?.enabled === true
    };
}

export const DEFAULT_SINGLE_COLUMN_CONFIG: SingleColumnAutobanConfig = {
    enabled: false,
    intervalMinutes: 10,
    batchSize: 1,
    complexityFilter: 'all',
    triggerMode: 'drain',
    whenSchedule: null
};

export function normalizeSingleColumnConfig(state?: Partial<SingleColumnAutobanConfig> | null): SingleColumnAutobanConfig {
    const rawSchedule = state?.whenSchedule;
    const whenSchedule = typeof rawSchedule === 'string' && rawSchedule.trim() ? rawSchedule.trim() : null;
    return {
        enabled: state?.enabled === true,
        // Floor of 1 minute only — no ceiling. The run-sheet interval is how often
        // the board advances, and "once every few hours" or "overnight" are valid
        // answers. A 60-minute cap was an arbitrary bound, not a constraint.
        intervalMinutes: Math.max(1, Number.isFinite(state?.intervalMinutes as number) ? Math.floor(state!.intervalMinutes!) : 10),
        batchSize: normalizeAutobanBatchSize(state?.batchSize),
        complexityFilter: (['all', 'low_and_below', 'medium_and_below', 'medium_and_above', 'high_and_above'] as const).includes(state?.complexityFilter as any)
            ? state!.complexityFilter!
            : 'all',
        triggerMode: normalizeAutobanTriggerMode(state?.triggerMode),
        whenSchedule
    };
}

/**
 * Unknown persisted values fall back to `drain` — the clock-driven default.
 * A config that predates `completion` normalises to the behaviour it already had.
 */
export function normalizeAutobanTriggerMode(value: unknown): AutobanTriggerMode {
    return value === 'watch' || value === 'completion' ? value : 'drain';
}

export type AutobanConfigState = {
    enabled: boolean;
    batchSize: number;
    complexityFilter: AutobanComplexityFilter;
    routingMode: AutobanRoutingMode;
    rules: Record<string, AutobanRuleState>;
    lastTickAt?: Record<string, number>;
    paused: boolean;
    pausedRemainingMs?: Record<string, number>;
    pairProgrammingMode: 'off' | 'cli-cli' | 'cli-ide' | 'ide-cli' | 'ide-ide';
    aggressivePairProgramming: boolean;
    automationMode?: AutobanAutomationMode;
    /** Broadcast-only: the active run sheet, so the panel renders what the engine runs. */
    runSheet?: AutobanRunSheetStep[];
    singleColumnConfig?: SingleColumnAutobanConfig;
    orchestrationConfig?: OrchestrationConfig;
    /** One-time notice shown in the Internal panel when a board-batch job is migrated. */
    migratedBoardBatchNotice?: string;
};

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

export function isWatchColumn(rule?: AutobanRuleState | null): boolean {
    return rule?.triggerMode === 'watch' && rule?.enabled === true;
}

/**
 * The automation axis is *who runs the clock*. `internal` is the only mode
 * that installs timers and dispatches; `external` emits a prompt and runs
 * nothing.
 *
 * This is shipped state on ~4,000 installs, so the retired values MAP rather
 * than fall through a whitelist: `run-sheet` and `scheduler` were the earlier
 * pair (board progression vs. arbitrary prompts on a timer — both are
 * Switchboard running the clock, so both map to `internal`); `single-column`
 * was the run sheet under an older name; `orchestration` was a peer mode that
 * is now an optional oversight agent (see the orchestrationConfig migration
 * below). A whitelist that fell through would silently disarm a shipped
 * install's clock — everything unrecognised lands on `internal`, the safe
 * default that keeps the board ticking.
 */
export function normalizeAutomationMode(value: unknown): AutobanAutomationMode {
    if (value === 'external') { return 'external'; }
    // 'run-sheet', 'scheduler', 'single-column', 'orchestration' and anything
    // unrecognised all land on internal — it is the only clock-running mode.
    return 'internal';
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
                    intervalMinutes,
                    triggerMode: normalizeAutobanTriggerMode(rule?.triggerMode)
                }] as [string, AutobanRuleState];
            })
    );

    return {
        enabled: state?.enabled === true,
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
        automationMode: normalizeAutomationMode(state?.automationMode),
        singleColumnConfig: normalizeSingleColumnConfig(state?.singleColumnConfig),
        // `orchestration` used to be a peer MODE; it is now an optional oversight
        // agent armed alongside the run sheet. An install persisted in that mode
        // keeps its oversight armed rather than silently losing it — the mode
        // value migrates to `internal` above, and this carries the intent across.
        orchestrationConfig: normalizeOrchestrationConfig(
            (state as any)?.automationMode === 'orchestration'
                ? { ...state?.orchestrationConfig, enabled: true }
                : state?.orchestrationConfig
        ),
        migratedBoardBatchNotice: typeof state?.migratedBoardBatchNotice === 'string' ? state.migratedBoardBatchNotice : undefined
    };
}

export function buildAutobanBroadcastState(
    state: AutobanConfigState,
    lastTickEntries: Iterable<[string, number]>
): AutobanConfigState {
    return {
        ...normalizeAutobanConfigState(state),
        lastTickAt: Object.fromEntries(lastTickEntries),
        // The panel renders the run sheet from this rather than hard-coding its own
        // copy of the steps — so a future editable sheet reaches the UI for free
        // instead of the two drifting apart.
        runSheet: DEFAULT_AUTOBAN_RUN_SHEET.map(s => ({ ...s }))
    };
}
