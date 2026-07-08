export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'tester' | 'planner' | 'analyst' | 'ticket_updater' | 'researcher';

export interface CustomAgentAddons {
    // Core
    gitProhibitionEnabled?: boolean;
    // Granular git policy (Branch / Commit / Push). The guardrail (gitProhibitionEnabled)
    // is independent; these three compile into the composed `GIT POLICY:` block by
    // buildGitPolicyBlock. `'notSpecified'` and `undefined` both mean "emit no clause".
    gitBranchStrategy?: 'current' | 'newBranch' | 'notSpecified';
    gitCommitStrategy?: 'whenDone' | 'dontCommit' | 'notSpecified';
    gitPushStrategy?: 'noPush' | 'pushWhenDone' | 'notSpecified';
    workspaceTypeDetection?: boolean;
    switchboardSafeguards?: boolean;

    // Role-style add-ons
    includeInlineChallenge?: boolean;
    accurateCodingEnabled?: boolean;
    pairProgrammingEnabled?: boolean;
    aggressivePairProgramming?: boolean;
    advancedReviewerEnabled?: boolean;
    reviewerConciseModeEnabled?: boolean;
    reviewerCompactPlanUpdateEnabled?: boolean;
    researchEnabled?: boolean; // NEW: enable deep research mode
    complexityScoringSkill?: boolean; // NEW: invoke complexity scoring before split
    ticketUpdateMode?: 'disabled' | 'comment-only' | 'refine-ticket' | 'research-and-refine';
    suppressWalkthrough?: boolean;
    staggeredImplementation?: boolean;
    cavemanOutput?: boolean;
    useSubagents?: boolean;
    subagentPolicy?: 'default' | 'noSubagents' | 'useSubagents' | 'customSubagent';
    customSubagentName?: string;
    useWorktreesPerPlan?: boolean;

    // Phone-a-Friend — when true, the coder/lead/intern prompt includes a directive
    // to POST a notification to the LocalApiServer when the batch is done, which
    // triggers a second-pass dispatch to the Phone-a-Friend terminal.
    phoneAFriend?: boolean;

    // Design doc (planning feature)


    // Design System Doc
    designSystemDoc?: boolean;
    designSystemDocLink?: string;
    designSystemDocContent?: string;

    // Constitution
    constitutionContent?: string;
    constitutionLink?: string;

    // Per-project PRD (project-context toggle; resolved at dispatch, not a saved per-agent flag)
    prdLink?: string;
    prdContent?: string;
    /** Per-project PRD links resolved from the plans' own project fields (link-only). */
    prdReferences?: Array<{ projectName: string; prdLink: string }>;

    // Workflow
    workflowFilePathEnabled?: boolean;
    workflowFilePath?: string;

    // Feature ultracode/goal directive opt-in (built-in lead/coder/intern get this
    // automatically; custom roles must opt in)
    applyFeatureDirectives?: boolean;

    // Prompt override (applied LAST, after all directives)
    defaultPromptOverride?: DefaultPromptOverride;

    /** Destination kanban column the card is dispatched to (drives the Stage Complete marker directive). */
    destinationColumn?: string;
}

export interface CustomAgentConfig {
    id: string;
    role: string;
    name: string;
    startupCommand: string;
    promptInstructions?: string;
    includeInKanban: boolean;
    kanbanOrder: number;
    dragDropMode: 'cli' | 'prompt' | 'disabled';
    addons?: CustomAgentAddons;
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
    kind: 'created' | 'review' | 'gather' | 'coded' | 'reviewed' | 'merge' | 'custom-agent' | 'custom-user' | 'completed';
    source: 'built-in' | 'custom-agent' | 'custom-user';
    autobanEnabled: boolean;
    dragDropMode: 'cli' | 'prompt' | 'disabled';
    hideWhenNoAgent?: boolean;
    triggerPrompt?: string;
    featureOnly?: boolean;
}

export interface KanbanColumnBuildOverrides {
    orderOverrides?: Record<string, number>;
}

export const BUILT_IN_AGENT_LABELS: Record<BuiltInAgentRole, string> = {
    planner: 'Planner',
    lead: 'Lead Coder',
    coder: 'Coder',
    intern: 'Intern',
    reviewer: 'Reviewer',
    tester: 'Acceptance Tester',
    analyst: 'Analyst',
    ticket_updater: 'Ticket Updater',
    researcher: 'Researcher',
};

export const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
    { id: 'CREATED', label: 'New', order: 0, kind: 'created', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'RESEARCHER', label: 'Researcher', role: 'researcher', order: 90, kind: 'review', source: 'built-in', autobanEnabled: false, dragDropMode: 'prompt', hideWhenNoAgent: true },
    { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 180, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli' },
    { id: 'INTERN CODED', label: 'Intern', role: 'intern', order: 200, kind: 'coded', source: 'built-in', autobanEnabled: true, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli' },
    { id: 'ACCEPTANCE TESTED', label: 'Acceptance Tested', role: 'tester', order: 350, kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'cli', hideWhenNoAgent: true },
    { id: 'TICKET UPDATER', label: 'Ticket Updater', role: 'ticket_updater', order: 9000, kind: 'reviewed', source: 'built-in', autobanEnabled: false, dragDropMode: 'prompt', hideWhenNoAgent: true },
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

export function parseCustomAgentAddons(raw: unknown): CustomAgentAddons | undefined {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) { return undefined; }
    const s = raw as Record<string, unknown>;
    const a: CustomAgentAddons = {};
    if (s.gitProhibitionEnabled === true) a.gitProhibitionEnabled = true;
    if (s.workspaceTypeDetection === true) a.workspaceTypeDetection = true;
    if (s.switchboardSafeguards === true) a.switchboardSafeguards = true;
    if (s.includeInlineChallenge === true) a.includeInlineChallenge = true;
    if (s.accurateCodingEnabled === true) a.accurateCodingEnabled = true;
    if (s.pairProgrammingEnabled === true) a.pairProgrammingEnabled = true;
    if (s.aggressivePairProgramming === true) a.aggressivePairProgramming = true;
    if (s.advancedReviewerEnabled === true) a.advancedReviewerEnabled = true;
    if (s.reviewerConciseModeEnabled === true) a.reviewerConciseModeEnabled = true;
    if (s.reviewerCompactPlanUpdateEnabled === true) a.reviewerCompactPlanUpdateEnabled = true;
    if (s.researchEnabled === true) a.researchEnabled = true;
    if (s.complexityScoringSkill === true) a.complexityScoringSkill = true;
    if (s.ticketUpdateMode && ['disabled', 'comment-only', 'refine-ticket', 'research-and-refine'].includes(s.ticketUpdateMode as string)) {
        a.ticketUpdateMode = s.ticketUpdateMode as any;
    } else if (s.ticketUpdateEnabled === true) {
        // Migration: map old boolean to new enum
        a.ticketUpdateMode = 'comment-only';
    } else if (s.ticketUpdateEnabled === false) {
        a.ticketUpdateMode = 'disabled';
    }
    if (s.suppressWalkthrough === true) a.suppressWalkthrough = true;
    if (s.staggeredImplementation === true) a.staggeredImplementation = true;
    if (s.cavemanOutput === true) a.cavemanOutput = true;
    if (s.useSubagents === false) a.useSubagents = false;
    if (s.subagentPolicy && ['default', 'noSubagents', 'useSubagents', 'customSubagent'].includes(s.subagentPolicy as string)) {
        a.subagentPolicy = s.subagentPolicy as 'default' | 'noSubagents' | 'useSubagents' | 'customSubagent';
    }
    if (s.customSubagentName && typeof s.customSubagentName === 'string') {
        const sanitized = String(s.customSubagentName).replace(/[^a-zA-Z0-9_]/g, '').trim();
        if (sanitized) a.customSubagentName = sanitized;
    }
    if (s.useWorktreesPerPlan === true) a.useWorktreesPerPlan = true;
    if (s.phoneAFriend === true) a.phoneAFriend = true;

    // Granular git policy — allowlist the enum values so custom-agent definitions
    // persist the user's selection across reloads (mirrors subagentPolicy above).
    if (s.gitBranchStrategy && ['current', 'newBranch', 'notSpecified'].includes(s.gitBranchStrategy as string)) {
        a.gitBranchStrategy = s.gitBranchStrategy as 'current' | 'newBranch' | 'notSpecified';
    }
    if (s.gitCommitStrategy && ['whenDone', 'dontCommit', 'notSpecified'].includes(s.gitCommitStrategy as string)) {
        a.gitCommitStrategy = s.gitCommitStrategy as 'whenDone' | 'dontCommit' | 'notSpecified';
    }
    if (s.gitPushStrategy && ['noPush', 'pushWhenDone', 'notSpecified'].includes(s.gitPushStrategy as string)) {
        a.gitPushStrategy = s.gitPushStrategy as 'noPush' | 'pushWhenDone' | 'notSpecified';
    }

    if (s.designSystemDoc === true) a.designSystemDoc = true;
    if (s.designSystemDocLink) a.designSystemDocLink = String(s.designSystemDocLink).trim();
    if (!a.designSystemDoc && s.designSystemDocLink) a.designSystemDoc = true;
    if (s.designSystemDocContent) {
        const content = String(s.designSystemDocContent).trim();
        a.designSystemDocContent = content.length > 50000 ? content.slice(0, 50000) + '\n[TRUNCATED]' : content;
    }
    if (s.constitutionLink && typeof s.constitutionLink === 'string') a.constitutionLink = s.constitutionLink.trim();
    if (s.constitutionContent && typeof s.constitutionContent === 'string') {
        const content = s.constitutionContent.trim();
        a.constitutionContent = content.length > 50000 ? content.slice(0, 50000) + '\n[TRUNCATED]' : content;
    }
    if (s.workflowFilePathEnabled === true) a.workflowFilePathEnabled = true;
    if (typeof s.workflowFilePath === 'string' && s.workflowFilePath.trim()) a.workflowFilePath = s.workflowFilePath.trim();
    if (s.applyFeatureDirectives === true) a.applyFeatureDirectives = true;
    if (s.defaultPromptOverride && typeof s.defaultPromptOverride === 'object') {
        const o = s.defaultPromptOverride as Record<string, unknown>;
        const mode = String(o.mode || '');
        const text = String(o.text || '').trim();
        if (text && ['append', 'prepend', 'replace'].includes(mode)) {
            a.defaultPromptOverride = { mode: mode as PromptOverrideMode, text };
        }
    }
    return Object.keys(a).length > 0 ? a : undefined;
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
            addons: parseCustomAgentAddons(source.addons)
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

    return [...defaultColumns, ...userColumns].sort((a, b) => a.order - b.order || a.label.localeCompare(b.label));
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
    const VALID_ROLES: BuiltInAgentRole[] = ['planner', 'lead', 'coder', 'reviewer', 'tester', 'intern', 'analyst', 'ticket_updater', 'researcher'];
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
