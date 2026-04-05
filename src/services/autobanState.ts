export type AutobanRuleState = {
    enabled: boolean;
    intervalMinutes: number;
};

export type AutobanComplexityFilter = 'all' | 'low_and_below' | 'medium_and_below' | 'medium_and_above' | 'high_and_above';
export type AutobanRoutingMode = 'dynamic' | 'all_coder' | 'all_lead';

export const AUTOBAN_SHARED_REVIEWER_COLUMNS = ['LEAD CODED', 'CODER CODED'] as const;

export const AUTOBAN_BATCH_SIZE_OPTIONS = [1, 2, 3, 4, 5] as const;
export const DEFAULT_AUTOBAN_BATCH_SIZE = 3;
export const DEFAULT_AUTOBAN_MAX_SENDS_PER_TERMINAL = 10;
export const DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP = 200;
export const MAX_AUTOBAN_TERMINALS_PER_ROLE = 5;

export type AutobanConfigState = {
    enabled: boolean;
    batchSize: number;
    complexityFilter: AutobanComplexityFilter;
    routingMode: AutobanRoutingMode;
    maxSendsPerTerminal: number;
    globalSessionCap: number;
    sessionSendCount: number;
    sendCounts: Record<string, number>;
    terminalPools: Record<string, string[]>;
    managedTerminalPools: Record<string, string[]>;
    poolCursor: Record<string, number>;
    rules: Record<string, AutobanRuleState>;
    lastTickAt?: Record<string, number>;
    pairProgrammingMode: 'off' | 'cli-cli' | 'cli-ide' | 'ide-cli' | 'ide-ide';
    aggressivePairProgramming: boolean;
};

const DEFAULT_AUTOBAN_RULES: Record<string, AutobanRuleState> = {
    CREATED: { enabled: true, intervalMinutes: 10 },
    'PLAN REVIEWED': { enabled: true, intervalMinutes: 20 },
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

function normalizeCountRecord(record?: Record<string, number> | null): Record<string, number> {
    if (!record || typeof record !== 'object') {
        return {};
    }
    return Object.fromEntries(
        Object.entries(record)
            .map(([key, value]) => [String(key).trim(), normalizeFiniteCount(value, 0, 0)] as const)
            .filter(([key]) => key.length > 0)
    );
}

function normalizeStringArrayRecord(record?: Record<string, string[]> | null): Record<string, string[]> {
    if (!record || typeof record !== 'object') {
        return {};
    }
    return Object.fromEntries(
        Object.entries(record)
            .map(([role, entries]) => {
                const normalizedEntries = Array.isArray(entries)
                    ? Array.from(new Set(
                        entries
                            .map(entry => String(entry || '').trim())
                            .filter(Boolean)
                    )).slice(0, MAX_AUTOBAN_TERMINALS_PER_ROLE)
                    : [];
                return [String(role).trim(), normalizedEntries] as const;
            })
            .filter(([role]) => role.length > 0)
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

export function normalizeAutobanConfigState(state?: Partial<AutobanConfigState> | null): AutobanConfigState {
    const rawRules = state?.rules ?? {};
    const legacyCodedRule = rawRules['CODED'];
    const mergedRules = {
        ...DEFAULT_AUTOBAN_RULES,
        ...rawRules,
        'LEAD CODED': rawRules['LEAD CODED'] ?? legacyCodedRule ?? DEFAULT_AUTOBAN_RULES['LEAD CODED'],
        'CODER CODED': rawRules['CODER CODED'] ?? legacyCodedRule ?? DEFAULT_AUTOBAN_RULES['CODER CODED']
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
                }];
            })
    );

    const normalizedTerminalPools = normalizeStringArrayRecord(state?.terminalPools);
    const normalizedManagedTerminalPools = normalizeStringArrayRecord(state?.managedTerminalPools);
    const normalizedPoolCursor = normalizeCountRecord(state?.poolCursor);

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
        maxSendsPerTerminal: normalizeFiniteCount(
            state?.maxSendsPerTerminal,
            DEFAULT_AUTOBAN_MAX_SENDS_PER_TERMINAL,
            1,
            100
        ),
        globalSessionCap: normalizeFiniteCount(
            typeof state?.globalSessionCap === 'number' && Number.isFinite(state.globalSessionCap) && state.globalSessionCap >= 1
                ? state.globalSessionCap
                : DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP,
            DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP,
            1
        ),
        sessionSendCount: normalizeFiniteCount(state?.sessionSendCount, 0, 0),
        sendCounts: normalizeCountRecord(state?.sendCounts),
        terminalPools: normalizedTerminalPools,
        managedTerminalPools: normalizedManagedTerminalPools,
        poolCursor: normalizedPoolCursor,
        rules: normalizedRules,
        lastTickAt: state?.lastTickAt ? { ...state.lastTickAt } : undefined,
        pairProgrammingMode: (function(m: any, legacyEnabled: any) {
            const valid = ['off', 'cli-cli', 'cli-ide', 'ide-cli', 'ide-ide'];
            if (valid.includes(m)) return m;
            // Legacy migration: boolean true → cli-cli
            if (legacyEnabled === true) return 'cli-cli';
            return 'off';
        })((state as any)?.pairProgrammingMode, (state as any)?.pairProgrammingEnabled),
        aggressivePairProgramming: state?.aggressivePairProgramming === true
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
