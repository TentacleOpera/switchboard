export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'planner' | 'analyst';

export interface CustomAgentConfig {
    id: string;
    role: string;
    name: string;
    startupCommand: string;
    promptInstructions: string;
    includeInKanban: boolean;
    kanbanOrder: number;
    dragDropMode: 'cli' | 'prompt';
}

export interface KanbanColumnDefinition {
    id: string;
    label: string;
    role?: string;
    order: number;
    kind: 'created' | 'review' | 'coded' | 'reviewed' | 'custom' | 'completed';
    autobanEnabled: boolean;
    dragDropMode: 'cli' | 'prompt';
    hideWhenNoAgent?: boolean;
}

const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    planner: 'Planner',
    analyst: 'Analyst'
};

const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
    { id: 'CREATED', label: 'New', order: 0, kind: 'created', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 180, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'INTERN CODED', label: 'Intern', role: 'intern', order: 200, kind: 'coded', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', autobanEnabled: false, dragDropMode: 'cli' },
    { id: 'COMPLETED', label: 'Completed', order: 9999, kind: 'completed', autobanEnabled: false, dragDropMode: 'cli' },
];

const DEFAULT_CUSTOM_AGENT_KANBAN_ORDER = Math.max(300, ...DEFAULT_KANBAN_COLUMNS.filter(c => c.kind !== 'completed').map(c => c.order)) + 100;

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

export function buildKanbanColumns(customAgents: CustomAgentConfig[]): KanbanColumnDefinition[] {
    const customColumns = customAgents
        .filter(agent => agent.includeInKanban)
        .map(agent => ({
            id: agent.role,
            label: agent.name,
            role: agent.role,
            order: agent.kanbanOrder,
            kind: 'custom' as const,
            autobanEnabled: false,
            dragDropMode: agent.dragDropMode,
        }));

    return [...DEFAULT_KANBAN_COLUMNS, ...customColumns].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}

export function getBuiltInAgentLabels(): Record<BuiltInAgentRole, string> {
    return { ...BUILT_IN_AGENT_LABELS };
}

export function getReservedAgentNames(): string[] {
    return [...Object.values(BUILT_IN_AGENT_LABELS), 'Jules', 'Jules Monitor', 'Team'];
}
