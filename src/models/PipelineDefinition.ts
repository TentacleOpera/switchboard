export interface ClickUpAutomationRule {
    name: string;
    enabled?: boolean;
    triggerTag: string;
    triggerLists: string[];
    targetColumn: string;
    finalColumn: string;
    writeBackOnComplete: boolean;
}

export interface LinearAutomationRule {
    name: string;
    enabled?: boolean;
    triggerLabel: string;
    triggerStates: string[];
    targetColumn: string;
    finalColumn: string;
    writeBackOnComplete: boolean;
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
        const targetColumn = _normalizeString(source.targetColumn);
        const finalColumn = _normalizeString(source.finalColumn);

        if (!name || !triggerLabel || triggerStates.length === 0 || !targetColumn || !finalColumn) {
            continue;
        }

        normalized.push({
            name,
            enabled: source.enabled !== false,
            triggerLabel,
            triggerStates,
            targetColumn,
            finalColumn,
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
