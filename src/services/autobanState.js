"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_AUTOBAN_TERMINALS_PER_ROLE = exports.DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP = exports.DEFAULT_AUTOBAN_MAX_SENDS_PER_TERMINAL = exports.DEFAULT_AUTOBAN_BATCH_SIZE = exports.AUTOBAN_BATCH_SIZE_OPTIONS = exports.AUTOBAN_SHARED_REVIEWER_COLUMNS = void 0;
exports.normalizeAutobanBatchSize = normalizeAutobanBatchSize;
exports.isSharedReviewerAutobanColumn = isSharedReviewerAutobanColumn;
exports.getEnabledSharedReviewerAutobanColumns = getEnabledSharedReviewerAutobanColumns;
exports.shouldSkipSharedReviewerAutobanDispatch = shouldSkipSharedReviewerAutobanDispatch;
exports.getNextAutobanTerminalName = getNextAutobanTerminalName;
exports.normalizeAutobanConfigState = normalizeAutobanConfigState;
exports.buildAutobanBroadcastState = buildAutobanBroadcastState;
exports.AUTOBAN_SHARED_REVIEWER_COLUMNS = ['LEAD CODED', 'CODER CODED'];
exports.AUTOBAN_BATCH_SIZE_OPTIONS = [1, 2, 3, 4, 5];
exports.DEFAULT_AUTOBAN_BATCH_SIZE = 3;
exports.DEFAULT_AUTOBAN_MAX_SENDS_PER_TERMINAL = 10;
exports.DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP = 200;
exports.MAX_AUTOBAN_TERMINALS_PER_ROLE = 5;
const DEFAULT_AUTOBAN_RULES = {
    CREATED: { enabled: true, intervalMinutes: 10 },
    'PLAN REVIEWED': { enabled: true, intervalMinutes: 20 },
    'LEAD CODED': { enabled: true, intervalMinutes: 15 },
    'CODER CODED': { enabled: true, intervalMinutes: 15 }
};
function normalizeFiniteCount(value, fallback, minimum, maximum) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    if (value < minimum) {
        return fallback;
    }
    const normalized = Math.floor(value);
    return typeof maximum === 'number' ? Math.min(normalized, maximum) : normalized;
}
function normalizeAutobanBatchSize(value) {
    return normalizeFiniteCount(value, exports.DEFAULT_AUTOBAN_BATCH_SIZE, exports.AUTOBAN_BATCH_SIZE_OPTIONS[0], exports.AUTOBAN_BATCH_SIZE_OPTIONS[exports.AUTOBAN_BATCH_SIZE_OPTIONS.length - 1]);
}
function normalizeCountRecord(record) {
    if (!record || typeof record !== 'object') {
        return {};
    }
    return Object.fromEntries(Object.entries(record)
        .map(([key, value]) => [String(key).trim(), normalizeFiniteCount(value, 0, 0)])
        .filter(([key]) => key.length > 0));
}
function normalizeStringArrayRecord(record) {
    if (!record || typeof record !== 'object') {
        return {};
    }
    return Object.fromEntries(Object.entries(record)
        .map(([role, entries]) => {
        const normalizedEntries = Array.isArray(entries)
            ? Array.from(new Set(entries
                .map(entry => String(entry || '').trim())
                .filter(Boolean))).slice(0, exports.MAX_AUTOBAN_TERMINALS_PER_ROLE)
            : [];
        return [String(role).trim(), normalizedEntries];
    })
        .filter(([role]) => role.length > 0));
}
function isSharedReviewerAutobanColumn(column) {
    return exports.AUTOBAN_SHARED_REVIEWER_COLUMNS.includes(column);
}
function getEnabledSharedReviewerAutobanColumns(rules) {
    return exports.AUTOBAN_SHARED_REVIEWER_COLUMNS.filter(column => rules?.[column]?.enabled !== false);
}
function shouldSkipSharedReviewerAutobanDispatch(lastDispatchAt, lastTickAt, sourceColumns) {
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
function getNextAutobanTerminalName(roleLabel, usedNames, requestedName) {
    const normalizedUsedNames = new Set(Array.from(usedNames)
        .map(name => String(name || '').trim())
        .filter(Boolean));
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
function normalizeAutobanConfigState(state) {
    const rawRules = state?.rules ?? {};
    const legacyCodedRule = rawRules['CODED'];
    const mergedRules = {
        ...DEFAULT_AUTOBAN_RULES,
        ...rawRules,
        'LEAD CODED': rawRules['LEAD CODED'] ?? legacyCodedRule ?? DEFAULT_AUTOBAN_RULES['LEAD CODED'],
        'CODER CODED': rawRules['CODER CODED'] ?? legacyCodedRule ?? DEFAULT_AUTOBAN_RULES['CODER CODED']
    };
    const normalizedRules = Object.fromEntries(Object.entries(mergedRules)
        .filter(([column]) => column !== 'CODED')
        .map(([column, rule]) => {
        const fallback = DEFAULT_AUTOBAN_RULES[column] ?? { enabled: true, intervalMinutes: 10 };
        const intervalMinutes = normalizeFiniteCount(rule?.intervalMinutes, fallback.intervalMinutes, 1);
        return [column, {
                enabled: typeof rule?.enabled === 'boolean' ? rule.enabled : fallback.enabled,
                intervalMinutes
            }];
    }));
    const normalizedTerminalPools = normalizeStringArrayRecord(state?.terminalPools);
    const normalizedManagedTerminalPools = normalizeStringArrayRecord(state?.managedTerminalPools);
    const normalizedPoolCursor = normalizeCountRecord(state?.poolCursor);
    return {
        enabled: state?.enabled === true,
        batchSize: normalizeAutobanBatchSize(state?.batchSize),
        complexityFilter: state?.complexityFilter === 'low_only' || state?.complexityFilter === 'high_only'
            ? state.complexityFilter
            : 'all',
        routingMode: state?.routingMode === 'all_coder' || state?.routingMode === 'all_lead'
            ? state.routingMode
            : 'dynamic',
        maxSendsPerTerminal: normalizeFiniteCount(state?.maxSendsPerTerminal, exports.DEFAULT_AUTOBAN_MAX_SENDS_PER_TERMINAL, 1, 100),
        globalSessionCap: normalizeFiniteCount(typeof state?.globalSessionCap === 'number' && Number.isFinite(state.globalSessionCap) && state.globalSessionCap >= 1
            ? state.globalSessionCap
            : exports.DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP, exports.DEFAULT_AUTOBAN_GLOBAL_SESSION_CAP, 1),
        sessionSendCount: normalizeFiniteCount(state?.sessionSendCount, 0, 0),
        sendCounts: normalizeCountRecord(state?.sendCounts),
        terminalPools: normalizedTerminalPools,
        managedTerminalPools: normalizedManagedTerminalPools,
        poolCursor: normalizedPoolCursor,
        rules: normalizedRules,
        lastTickAt: state?.lastTickAt ? { ...state.lastTickAt } : undefined
    };
}
function buildAutobanBroadcastState(state, lastTickEntries) {
    return {
        ...normalizeAutobanConfigState(state),
        lastTickAt: Object.fromEntries(lastTickEntries)
    };
}
//# sourceMappingURL=autobanState.js.map