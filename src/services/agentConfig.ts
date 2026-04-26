export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'tester' | 'planner' | 'analyst' | 'team-lead';

export interface CustomAgentConfig {
    id: string;
    role: string;
    name: string;
    startupCommand: string;
    promptInstructions: string;
    includeInKanban: boolean;
    kanbanOrder: number;
    dragDropMode: 'cli' | 'prompt' | 'disabled';
}

export interface CustomKanbanColumnConfig {
    id: string;
    label: string;
    role: string;
    triggerPrompt: string;
    order: number;
    dragDropMode: 'cli' | 'prompt' | 'disabled';
}

export interface KanbanColumnDefinition {
    id: string;
    label: string;
    role?: string;
    order: number;
    kind: 'created' | 'review' | 'gather' | 'coded' | 'reviewed' | 'custom-agent' | 'custom-user' | 'completed';
    source: 'built-in' | 'custom-agent' | 'custom-user';
    autobanEnabled: boolean;
    dragDropMode: 'cli' | 'prompt' | 'disabled';
    hideWhenNoAgent?: boolean;
    triggerPrompt?: string;
}

export interface KanbanColumnBuildOverrides {
    orderOverrides?: Record<string, number>;
}

export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    tester: 'Acceptance Tester',
    planner: 'Planner',
    analyst: 'Analyst',
    'team-lead': 'Team Lead'
};

const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
    { id: 'CREATED', label: 'New', order: 0, kind: 'created', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'CONTEXT GATHERER', label: 'Context Gatherer', role: 'gatherer', order: 150, kind: 'gather', source: 'built-in', autobanEnabled: false, dragDropMode: 'disabled', hideWhenNoAgent: true },
    { id: 'TEAM LEAD CODED', label: 'Team Lead', role: 'team-lead', order: 170, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 180, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'INTERN CODED', label: 'Intern', role: 'intern', order: 200, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli' },
    { id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', order: 350, kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'COMPLETED', label: 'Completed', order: 9999, kind: 'completed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli' },
];

const DEFAULT_CUSTOM_AGENT_KANBAN_ORDER = Math.max(300, ...DEFAULT_KANBAN_COLUMNS.filter(c => c.kind !== 'completed').map(c => c.order)) + 100;
const DEFAULT_CUSTOM_USER_KANBAN_ORDER = DEFAULT_CUSTOM_AGENT_KANBAN_ORDER + 100;
const KANBAN_REWEIGHT_STEP = 100;

function sanitizeId(raw: unknown): string {
    const normalized = String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return normalized || `agent_${Date.now().toString(36)}`;
}

function sanitizeRole(raw: unknown): string {
    const normalized = String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
    return normalized || `custom_agent_${Date.now().toString(36)}`;
}

function sanitizeColumnRole(raw: unknown): string {
    return String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
}

function sanitizeKanbanColumnId(raw: unknown): string {
    const baseId = sanitizeId(raw);
    return baseId.startsWith('custom_column_') ? baseId : `custom_column_${baseId}`;
}

export function toCustomAgentRole(id: string): string {
    return `custom_agent_${sanitizeId(id)}`;
}

export function isCustomAgentRole(role: string | undefined | null): boolean {
    return typeof role === 'string' && role.startsWith('custom_agent_');
}

export function parseCustomAgents(raw: unknown): CustomAgentConfig[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const seenRoles = new Set<string>();
    const result: CustomAgentConfig[] = [];

    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const source = item as Record<string, unknown>;
        const name = String(source.name || '').trim();
        const startupCommand = String(source.startupCommand || '').trim();
        if (!name || !startupCommand) {
            continue;
        }

        const rawId = String(source.id || name).trim();
        const id = sanitizeId(rawId);
        const role = sanitizeRole(source.role || toCustomAgentRole(id));
        if (seenRoles.has(role)) {
            continue;
        }

        const kanbanOrder = Number.isFinite(Number(source.kanbanOrder)) ? Number(source.kanbanOrder) : DEFAULT_CUSTOM_AGENT_KANBAN_ORDER;
        result.push({
            id,
            role,
            name,
            startupCommand,
            promptInstructions: String(source.promptInstructions || '').trim(),
            includeInKanban: source.includeInKanban === true,
            kanbanOrder,
            dragDropMode: (source.dragDropMode === 'prompt' ? 'prompt' : 'cli') as 'cli' | 'prompt',
        });
        seenRoles.add(role);
    }

    return result.sort((a, b) => a.kanbanOrder - b.kanbanOrder || a.name.localeCompare(b.name));
}

export function findCustomAgentByRole(customAgents: CustomAgentConfig[], role: string | undefined | null): CustomAgentConfig | undefined {
    if (!role) {
        return undefined;
    }
    return customAgents.find(agent => agent.role === role);
}

export function parseCustomKanbanColumns(raw: unknown): CustomKanbanColumnConfig[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const seenIds = new Set<string>();
    const result: CustomKanbanColumnConfig[] = [];

    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const source = item as Record<string, unknown>;
        const label = String(source.label || '').trim();
        const role = sanitizeColumnRole(source.role || source.assignedAgent);
        if (!label || !role) {
            continue;
        }

        const rawId = String(source.id || label).trim();
        const id = sanitizeKanbanColumnId(rawId);
        if (seenIds.has(id)) {
            continue;
        }

        result.push({
            id,
            label,
            role,
            triggerPrompt: String(source.triggerPrompt || '').trim(),
            order: Number.isFinite(Number(source.order)) ? Number(source.order) : DEFAULT_CUSTOM_USER_KANBAN_ORDER,
            dragDropMode: source.dragDropMode === 'prompt' ? 'prompt' : 'cli'
        });
        seenIds.add(id);
    }

    return result.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

export function reweightSequence(orderedIds: string[]): Record<string, number> {
    const seen = new Set<string>();
    const weights: Record<string, number> = {};

    for (const id of orderedIds) {
        const normalized = String(id || '').trim();
        if (!normalized || normalized === 'CREATED' || normalized === 'COMPLETED' || seen.has(normalized)) {
            continue;
        }
        seen.add(normalized);
        weights[normalized] = seen.size * KANBAN_REWEIGHT_STEP;
    }

    return weights;
}

export function buildKanbanColumns(
    customAgents: CustomAgentConfig[],
    customKanbanColumnsOrOverrides: CustomKanbanColumnConfig[] | KanbanColumnBuildOverrides = [],
    overrides: KanbanColumnBuildOverrides = {}
): KanbanColumnDefinition[] {
    const customKanbanColumns = Array.isArray(customKanbanColumnsOrOverrides)
        ? customKanbanColumnsOrOverrides
        : [];
    const resolvedOverrides = Array.isArray(customKanbanColumnsOrOverrides)
        ? overrides
        : customKanbanColumnsOrOverrides;

    const defaultColumns = DEFAULT_KANBAN_COLUMNS.map(column => {
        const override = resolvedOverrides.orderOverrides?.[column.id];
        return {
            ...column,
            order: typeof override === 'number' ? override : column.order
        };
    });

    const customColumns = customAgents
        .filter(agent => agent.includeInKanban)
        .map(agent => ({
            id: agent.role,
            label: agent.name,
            role: agent.role,
            order: agent.kanbanOrder,
            kind: 'custom-agent' as const,
            source: 'custom-agent' as const,
            autobanEnabled: false,
            dragDropMode: agent.dragDropMode,
        }));

    const userColumns = customKanbanColumns.map(column => ({
        id: column.id,
        label: column.label,
        role: column.role,
        order: column.order,
        kind: 'custom-user' as const,
        source: 'custom-user' as const,
        autobanEnabled: false,
        dragDropMode: column.dragDropMode,
        triggerPrompt: column.triggerPrompt
    }));

    return [...defaultColumns, ...customColumns, ...userColumns].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

export function getBuiltInAgentLabels(): Record<BuiltInAgentRole, string> {
    return { ...BUILT_IN_AGENT_LABELS };
}

export function getReservedAgentNames(): string[] {
    return [...Object.values(BUILT_IN_AGENT_LABELS), 'Jules', 'Jules Monitor', 'Team'];
}

export type PromptOverrideMode = 'append' | 'prepend' | 'replace';

export interface DefaultPromptOverride {
    mode: PromptOverrideMode;
    text: string;
}

/**
 * Parses the `defaultPromptOverrides` field from state.json.
 * Returns a record keyed by BuiltInAgentRole.
 * Invalid or empty entries are omitted so callers can check truthiness.
 */
export function parseDefaultPromptOverrides(
    raw: unknown
): Partial<Record<BuiltInAgentRole, DefaultPromptOverride>> {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const result: Partial<Record<BuiltInAgentRole, DefaultPromptOverride>> = {};
    const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'team-lead'];
    const VALID_MODES: PromptOverrideMode[] = ['append', 'prepend', 'replace'];
    for (const role of VALID_ROLES) {
        const entry = (raw as Record<string, unknown>)[role];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
        const src = entry as Record<string, unknown>;
        const mode = String(src.mode || '');
        const text = String(src.text || '').trim();
        if (!VALID_MODES.includes(mode as PromptOverrideMode) || !text) continue;
        result[role] = { mode: mode as PromptOverrideMode, text };
    }
    return result;
}
