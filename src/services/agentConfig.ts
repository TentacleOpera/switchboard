export type BuiltInAgentRole = 'lead' | 'coder' | 'intern' | 'reviewer' | 'tester' | 'planner' | 'analyst' | 'ticket_updater' | 'researcher';

export interface DelegateDefinition {
    role: string;
    count?: number;
    label?: string;
    startupCommand?: string;
    /** Whether this member is one-per-team ('per-team', default) or shared across heads of the same team ('shared'). */
    scope?: 'per-team' | 'shared';
    /** Relationship preset id — see src/services/linkPresets.ts. Defaults to 'reports-to-head'. */
    relationship?: string;
}

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
    noSeparateReviewArtifactsEnabled?: boolean; // Default ON: prohibit creating separate .md review artifacts
    reviewerRisksToMemoEnabled?: boolean; // Default ON for the built-in reviewer; opt-in for custom agents
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
    /** Per-originating-terminal target overrides for Phone-a-Friend. */
    phoneAFriendTargets?: Record<string, string | null>;
    /** Cost-routed delegate terminals spawned when this head agent opens. */
    delegates?: DelegateDefinition[];

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
    /** Per-project Design System links resolved from the plans' own project fields. */
    designSystemReferences?: Array<{ projectName: string; designSystemLink: string }>;

    // Workflow
    workflowFilePathEnabled?: boolean;
    workflowFilePath?: string;

    // Feature-scoped levers (role-config-carried via the Prompts tab; the
    // definition-level parser parseCustomAgentAddons deliberately does not copy these)
    featureSubagentPolicy?: 'default' | 'noSubagents' | 'useSubagents' | 'customSubagent';
    featureCustomSubagentName?: string;
    featureWorkflowFilePathEnabled?: boolean;
    featureWorkflowFilePath?: string;
    /** When true, the Drive toggle is active — reframe feature execution to dispatch to team seats. */
    driveMode?: boolean;

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

export const MAX_TERMINALS_PER_ROLE = 5;

export function getNextTerminalName(
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

export interface KanbanColumnDefinition {
    id: string;
    label: string;
    role?: string;
    order: number;
    kind: 'created' | 'review' | 'gather' | 'coded' | 'reviewed' | 'merge' | 'custom-agent' | 'custom-user' | 'completed' | 'staging';
    source: 'built-in' | 'custom-agent' | 'custom-user';
    dragDropMode: 'cli' | 'prompt' | 'disabled';
    triggerPrompt?: string;
    featureOnly?: boolean;
    enabled?: boolean;
    enabledSource?: 'config' | 'legacy-db-config' | 'default' | 'structural' | 'unknown';
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

export const DEFAULT_VISIBLE_AGENTS: Record<string, boolean> = {
    lead: true,
    coder: true,
    intern: true,
    reviewer: true,
    tester: false,
    planner: true,
    analyst: true,
    jules: false,
    ticket_updater: false,
    researcher: false,
    claude_designer: false,
    phone_a_friend: false,
    project_manager: true
};

export const DEFAULT_KANBAN_COLUMNS: KanbanColumnDefinition[] = [
    { id: 'CREATED', label: 'New', order: 0, kind: 'created', source: 'built-in', dragDropMode: 'cli' },
    { id: 'RESEARCHER', label: 'Researcher', role: 'researcher', order: 110, kind: 'review', source: 'built-in', dragDropMode: 'prompt' },
    { id: 'PLAN REVIEWED', label: 'Planned', role: 'planner', order: 100, kind: 'review', source: 'built-in', dragDropMode: 'cli' },
    { id: 'STAGING', label: 'Staging', order: 115, kind: 'staging', source: 'built-in', dragDropMode: 'cli' },
    { id: 'LEAD CODED', label: 'Lead Coder', role: 'lead', order: 180, kind: 'coded', source: 'built-in', dragDropMode: 'cli' },
    { id: 'CODER CODED', label: 'Coder', role: 'coder', order: 190, kind: 'coded', source: 'built-in', dragDropMode: 'cli' },
    { id: 'INTERN CODED', label: 'Intern', role: 'intern', order: 200, kind: 'coded', source: 'built-in', dragDropMode: 'cli' },
    { id: 'CODE REVIEWED', label: 'Reviewed', role: 'reviewer', order: 300, kind: 'reviewed', source: 'built-in', dragDropMode: 'cli' },
    { id: 'ACCEPTANCE TESTED', label: 'Completion Tested', role: 'tester', order: 350, kind: 'reviewed', source: 'built-in', dragDropMode: 'cli' },
    { id: 'TICKET UPDATER', label: 'Ticket Updater', role: 'ticket_updater', order: 9000, kind: 'reviewed', source: 'built-in', dragDropMode: 'prompt' },
    { id: 'COMPLETED', label: 'Completed', order: 9999, kind: 'completed', source: 'built-in', dragDropMode: 'cli' },
];

/** Display-mode columns: stored column IDs that are NOT peer columns and MUST NOT
 *  appear in DEFAULT_KANBAN_COLUMNS (the webview renders one column per entry).
 *  Each renders inside another column's slot, toggled by a header button:
 *  - BACKLOG:  display mode of CREATED (kanban.html backlog toggle). */
export const DISPLAY_MODE_COLUMNS: Record<string, { label: string; displayModeOf: string }> = {
    'BACKLOG':  { label: 'Backlog',  displayModeOf: 'CREATED' },
};

/** Display labels for legacy stored column IDs that are NOT peer columns and MUST NOT
 *  appear in DEFAULT_KANBAN_COLUMNS (the webview renders one column per entry).
 *  - CODED: legacy alias normalized to LEAD CODED (KanbanProvider et al).
 *  BACKLOG formerly lived here; it is a display mode and has moved to
 *  DISPLAY_MODE_COLUMNS. */
export const LEGACY_COLUMN_LABELS: Record<string, { label: string; displayModeOf?: string; legacyAliasOf?: string }> = {
    'CODED':   { label: 'Coded',   legacyAliasOf: 'LEAD CODED' },
};

/** Display-only labels with no stored column ID — an agent may be asked about
 *  these by name but can never write to them. Keyed by the canonical uppercase
 *  form of the label. */
export const DISPLAY_ONLY_COLUMN_LABELS: Record<string, { aliasOf: string[] }> = {
    'AUTOCODE': { aliasOf: ['LEAD CODED', 'CODER CODED', 'INTERN CODED'] },
};

export interface ResolvedColumnLabel {
    label: string;
    labelSource: 'built-in' | 'custom' | 'legacy' | 'display-mode' | 'fallback';
}

/**
 * The ONE column-ID → UI-label resolver. Every agent-facing surface (state-file
 * export, GET /kanban/columns, write-path canonicalization) consumes this so the
 * mapping cannot drift. Fallback emits the ID itself as the label so the shape is
 * uniform for parsers — callers can distinguish a real label from a stand-in via
 * labelSource.
 */
export function resolveColumnLabel(
    id: string,
    customKanbanColumns: CustomKanbanColumnConfig[] = []
): ResolvedColumnLabel {
    const builtIn = DEFAULT_KANBAN_COLUMNS.find(c => c.id === id);
    if (builtIn) { return { label: builtIn.label, labelSource: 'built-in' }; }
    const custom = customKanbanColumns.find(c => c.id === id);
    if (custom) { return { label: custom.label, labelSource: 'custom' }; }
    const displayMode = DISPLAY_MODE_COLUMNS[id];
    if (displayMode) { return { label: displayMode.label, labelSource: 'display-mode' }; }
    const legacy = LEGACY_COLUMN_LABELS[id];
    if (legacy) { return { label: legacy.label, labelSource: 'legacy' }; }
    return { label: id, labelSource: 'fallback' };
}

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
    if (s.noSeparateReviewArtifactsEnabled === false) a.noSeparateReviewArtifactsEnabled = false;
    if (s.reviewerRisksToMemoEnabled === true) a.reviewerRisksToMemoEnabled = true;
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
    if (s.phoneAFriendTargets && typeof s.phoneAFriendTargets === 'object' && !Array.isArray(s.phoneAFriendTargets)) {
        const map: Record<string, string | null> = {};
        for (const [key, value] of Object.entries(s.phoneAFriendTargets)) {
            if (typeof key !== 'string' || !key.trim()) { continue; }
            const k = key.trim();
            if (value === null) {
                map[k] = null;
            } else if (typeof value === 'string' && value.trim()) {
                const v = value.trim();
                const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9_]/g, '');
                if (norm(k).length > 0 && norm(k) === norm(v)) { continue; }
                map[k] = v;
            }
        }
        if (Object.keys(map).length > 0) { a.phoneAFriendTargets = map; }
    }
    if (Array.isArray(s.delegates)) {
        const defs: DelegateDefinition[] = [];
        for (const d of s.delegates) {
            if (!d || typeof d !== 'object') { continue; }
            const role = String((d as any).role || '').trim();
            const startupCommand = (d as any).startupCommand ? String((d as any).startupCommand).trim() : undefined;
            const label = (d as any).label ? String((d as any).label).trim() : undefined;
            const count = typeof (d as any).count === 'number' ? Math.max(1, Math.min((d as any).count, 16)) : 1;
            if (!role) { continue; }
            defs.push({
                role,
                count,
                ...(startupCommand ? { startupCommand } : {}),
                ...(label ? { label } : {}),
            });
        }
        if (defs.length > 0) { a.delegates = defs; }
    }

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
