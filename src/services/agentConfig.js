"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.toCustomAgentRole = toCustomAgentRole;
exports.isCustomAgentRole = isCustomAgentRole;
exports.parseCustomAgents = parseCustomAgents;
exports.findCustomAgentByRole = findCustomAgentByRole;
exports.buildKanbanColumns = buildKanbanColumns;
exports.getBuiltInAgentLabels = getBuiltInAgentLabels;
exports.getReservedAgentNames = getReservedAgentNames;
const BUILT_IN_AGENT_LABELS = {
    lead: 'Lead Coder',
    coder: 'Coder',
    reviewer: 'Reviewer',
    planner: 'Planner',
    analyst: 'Analyst'
};
const DEFAULT_KANBAN_COLUMNS = [
    { id: 'CREATED', label: 'New', order: 0, kind: 'created', autobanEnabled: true },
    { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', autobanEnabled: true },
    { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 190, kind: 'coded', autobanEnabled: true },
    { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 200, kind: 'coded', autobanEnabled: true },
    { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', autobanEnabled: false },
];
const DEFAULT_CUSTOM_AGENT_KANBAN_ORDER = Math.max(300, ...DEFAULT_KANBAN_COLUMNS.map(c => c.order)) + 100;
function sanitizeId(raw) {
    const normalized = String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 48);
    return normalized || `agent_${Date.now().toString(36)}`;
}
function sanitizeRole(raw) {
    const normalized = String(raw || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64);
    return normalized || `custom_agent_${Date.now().toString(36)}`;
}
function toCustomAgentRole(id) {
    return `custom_agent_${sanitizeId(id)}`;
}
function isCustomAgentRole(role) {
    return typeof role === 'string' && role.startsWith('custom_agent_');
}
function parseCustomAgents(raw) {
    if (!Array.isArray(raw)) {
        return [];
    }
    const seenRoles = new Set();
    const result = [];
    for (const item of raw) {
        if (!item || typeof item !== 'object') {
            continue;
        }
        const source = item;
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
        });
        seenRoles.add(role);
    }
    return result.sort((a, b) => a.kanbanOrder - b.kanbanOrder || a.name.localeCompare(b.name));
}
function findCustomAgentByRole(customAgents, role) {
    if (!role) {
        return undefined;
    }
    return customAgents.find(agent => agent.role === role);
}
function buildKanbanColumns(customAgents) {
    const customColumns = customAgents
        .filter(agent => agent.includeInKanban)
        .map(agent => ({
        id: agent.role,
        label: agent.name,
        role: agent.role,
        order: agent.kanbanOrder,
        kind: 'custom',
        autobanEnabled: false
    }));
    return [...DEFAULT_KANBAN_COLUMNS, ...customColumns].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
}
function getBuiltInAgentLabels() {
    return { ...BUILT_IN_AGENT_LABELS };
}
function getReservedAgentNames() {
    return [...Object.values(BUILT_IN_AGENT_LABELS), 'Jules', 'Jules Monitor', 'Team'];
}
//# sourceMappingURL=agentConfig.js.map