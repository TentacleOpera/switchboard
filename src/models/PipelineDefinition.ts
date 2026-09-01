export interface ClickUpAutomationRule {
    name: string;
    enabled?: boolean;
    triggerTag: string;
    triggerLists: string[];
    targetColumn: string;
    finalColumn: string;
    writeBackOnComplete: boolean;
}

export type LinearAutomationDestination =
    | { kind: 'column'; column: string }
    | { kind: 'team'; team: string }
    | { kind: 'memo' };

export interface LinearAutomationRule {
    name: string;
    enabled?: boolean;
    triggerLabel: string;
    triggerStates: string[];
    destination?: LinearAutomationDestination;
    targetColumn?: string;
    targetTeam?: string;
    finalColumn?: string;
    writeBackOnComplete: boolean;
    [key: string]: unknown;
}

function _normalizeString(value: unknown): string {
    return String(value || '').trim();
}

function _normalizeStringArray(raw: unknown): string[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    return Array.from(new Set(
        raw
            .map((entry) => _normalizeString(entry))
            .filter(Boolean)
    ));
}

export function normalizeClickUpAutomationRules(raw: unknown): ClickUpAutomationRule[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const normalized: ClickUpAutomationRule[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }

        const source = item as Record<string, unknown>;
        const name = _normalizeString(source.name);
        const triggerTag = _normalizeString(source.triggerTag);
        const targetColumn = _normalizeString(source.targetColumn);
        const finalColumn = _normalizeString(source.finalColumn);

        if (!name || !triggerTag || !targetColumn || !finalColumn) {
            continue;
        }

        normalized.push({
            name,
            enabled: source.enabled !== false,
            triggerTag,
            triggerLists: _normalizeStringArray(source.triggerLists),
            targetColumn,
            finalColumn,
            writeBackOnComplete: source.writeBackOnComplete === true
        });
    }

    return normalized;
}

export function matchesClickUpAutomationRule(
    task: { tags?: Array<{ name?: string }> } | null | undefined,
    listId: string,
    rule: ClickUpAutomationRule
): boolean {
    if (!task || rule.enabled === false) {
        return false;
    }

    const expectedTag = _normalizeString(rule.triggerTag).toLowerCase();
    if (!expectedTag) {
        return false;
    }

    const normalizedListId = _normalizeString(listId);
    if (rule.triggerLists.length > 0 && (!normalizedListId || !rule.triggerLists.includes(normalizedListId))) {
        return false;
    }

    const tagNames = Array.isArray(task.tags)
        ? task.tags.map((tag) => String(tag?.name || '').trim().toLowerCase()).filter(Boolean)
        : [];
    return tagNames.includes(expectedTag);
}

export function normalizeLinearAutomationRules(raw: unknown): LinearAutomationRule[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const normalized: LinearAutomationRule[] = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue;
        }

        const source = item as Record<string, unknown>;
        const name = _normalizeString(source.name);
        const triggerLabel = _normalizeString(source.triggerLabel);
        const triggerStates = _normalizeStringArray(source.triggerStates);
        const rawTargetColumn = _normalizeString(source.targetColumn);
        const rawTargetTeam = _normalizeString(source.targetTeam);
        const finalColumn = _normalizeString(source.finalColumn);

        if (!name || !triggerLabel || triggerStates.length === 0) {
            continue;
        }

        let destination: LinearAutomationDestination | undefined;
        let resolvedTargetColumn: string | undefined = rawTargetColumn || undefined;
        let resolvedTargetTeam: string | undefined = rawTargetTeam || undefined;

        if (source.destination && typeof source.destination === 'object' && !Array.isArray(source.destination)) {
            const dest = source.destination as Record<string, unknown>;
            const kind = _normalizeString(dest.kind).toLowerCase();
            if (kind === 'column') {
                const column = _normalizeString(dest.column || rawTargetColumn);
                if (!column || rawTargetTeam) {
                    // Refuse rule if column empty or both column destination and targetTeam set
                    continue;
                }
                destination = { kind: 'column', column };
                resolvedTargetColumn = column;
                resolvedTargetTeam = undefined;
            } else if (kind === 'team') {
                const team = _normalizeString(dest.team || rawTargetTeam);
                if (!team || rawTargetColumn) {
                    // Refuse rule if team empty or both team destination and targetColumn set
                    continue;
                }
                destination = { kind: 'team', team };
                resolvedTargetTeam = team;
                resolvedTargetColumn = undefined;
            } else if (kind === 'memo') {
                destination = { kind: 'memo' };
                resolvedTargetColumn = undefined;
                resolvedTargetTeam = undefined;
            } else {
                // Refuse unknown destination kind
                continue;
            }
        } else {
            // Sibling field check: refuse if both targetColumn and targetTeam are set
            if (rawTargetColumn && rawTargetTeam) {
                continue;
            }
            if (rawTargetColumn) {
                destination = { kind: 'column', column: rawTargetColumn };
                resolvedTargetColumn = rawTargetColumn;
                resolvedTargetTeam = undefined;
            } else if (rawTargetTeam) {
                destination = { kind: 'team', team: rawTargetTeam };
                resolvedTargetTeam = rawTargetTeam;
                resolvedTargetColumn = undefined;
            } else {
                // Neither column nor team set
                continue;
            }
        }

        // For column destination, targetColumn and finalColumn are required
        if (destination.kind === 'column' && (!resolvedTargetColumn || !finalColumn)) {
            continue;
        }

        // Preserve unknown keys from source
        const {
            name: _n,
            enabled: _e,
            triggerLabel: _tl,
            triggerStates: _ts,
            targetColumn: _tc,
            targetTeam: _tt,
            destination: _d,
            finalColumn: _fc,
            writeBackOnComplete: _wb,
            ...unknownKeys
        } = source;

        normalized.push({
            ...unknownKeys,
            name,
            enabled: source.enabled !== false,
            triggerLabel,
            triggerStates,
            destination,
            targetColumn: resolvedTargetColumn,
            targetTeam: resolvedTargetTeam,
            finalColumn: finalColumn || undefined,
            writeBackOnComplete: source.writeBackOnComplete === true
        });
    }

    return normalized;
}

export function matchesLinearAutomationRule(
    issue: { labels?: { nodes?: Array<{ name?: string }> }; state?: { id?: string } } | null | undefined,
    rule: LinearAutomationRule
): boolean {
    if (!issue || rule.enabled === false) {
        return false;
    }

    const expectedLabel = _normalizeString(rule.triggerLabel).toLowerCase();
    if (!expectedLabel) {
        return false;
    }

    const normalizedStateId = _normalizeString(issue.state?.id);
    if (!normalizedStateId || rule.triggerStates.length === 0 || !rule.triggerStates.includes(normalizedStateId)) {
        return false;
    }

    const labelNames = Array.isArray(issue.labels?.nodes)
        ? issue.labels.nodes.map((label) => String(label?.name || '').trim().toLowerCase()).filter(Boolean)
        : [];
    return labelNames.includes(expectedLabel);
}
