/**
 * Shared prompt builder for Kanban batch operations.
 * All prompt-generation paths (card copy, batch buttons, autoban dispatch,
 * ticket-view "Send to Agent") MUST route through this module to guarantee
 * prompt text is identical for the same role regardless of UI entry point.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DefaultPromptOverride, CustomAgentAddons } from './agentConfig';

// One-time diagnostic for the ticket_updater mode collapse. Users who configured
// 'refine-ticket' or 'research-and-refine' (modes that rewrote ticket descriptions)
// silently lose that behavior — the role now always performs triage-only verdicts.
// This is a console log, not a UI dialog (per the no-confirm-dialogs rule).
let _ticketUpdateModeWarned = false;
export function warnOnLegacyTicketUpdateMode(mode: string | undefined): void {
    if (_ticketUpdateModeWarned) return;
    if (mode && mode !== 'disabled' && mode !== 'comment-only') {
        _ticketUpdateModeWarned = true;
        console.warn(
            `[Switchboard] ticketUpdateMode '${mode}' is no longer supported — ` +
            `the ticket_updater role now always performs triage-only verdicts.`
        );
    }
}

export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
    workingDir?: string;
    sessionId?: string;
    worktreePath?: string;
    featureId?: string;
    isSubtask?: boolean;
    featureTopic?: string;
    isFeature?: boolean;
    // True when worktreePath is THIS subtask's own dedicated worktree (per-subtask mode),
    // as opposed to an inherited feature-level/project-level worktree shared by all subtasks.
    // Distinguishes the two so prompt selection doesn't mistake a shared fallback worktree
    // for per-subtask isolation.
    hasOwnWorktree?: boolean;
    /** The plan's assigned project name (from KanbanCard.project / KanbanPlanRecord.project). Drives per-plan PRD resolution. */
    project?: string;
}

/**
 * Resolve a safe working directory from a repoScope value.
 * Validates that the resolved path exists on disk; falls back to
 * workspaceRoot if it does not. Logs a warning on fallback.
 */
export function resolveWorkingDir(workspaceRoot: string, repoScope: string): string {
    if (!repoScope || !repoScope.trim()) return '';
    const candidate = path.join(workspaceRoot, repoScope.trim());
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
        return candidate;
    }
    console.warn(
        `[resolveWorkingDir] repoScope "${repoScope}" resolved to non-existent directory: ${candidate}. ` +
        `Falling back to workspace root.`
    );
    return workspaceRoot;
}

/**
 * When a worktree is active, re-resolve the plan file path to point inside the
 * worktree (where the plan exists as a git-tracked file). Falls back to the
 * original workspace-root path if the file doesn't exist in the worktree yet
 * (e.g. plan was created after the worktree was branched and not committed).
 */
export function resolvePlanPathForWorktree(
    absolutePath: string,
    workspaceRoot: string,
    worktreePath?: string
): string {
    if (!worktreePath || !absolutePath) return absolutePath;
    const rel = path.relative(workspaceRoot, absolutePath);
    if (!rel || rel.startsWith('..')) return absolutePath; // plan is outside workspace root — can't re-resolve
    const worktreeCandidate = path.resolve(worktreePath, rel);
    if (fs.existsSync(worktreeCandidate)) {
        return worktreeCandidate;
    }
    // Plan file not in worktree (uncommitted) — fall back to workspace-root path
    console.warn(
        `[resolvePlanPathForWorktree] Plan file not found in worktree: ${worktreeCandidate}. ` +
        `Falling back to workspace-root path: ${absolutePath}`
    );
    return absolutePath;
}

/**
 * When a worktree is active, the effective working directory is the worktree
 * path (overriding the repoScope-based workingDir). The worktree is a fully
 * isolated working copy — the agent should operate entirely inside it.
 */
export function resolveWorkingDirForWorktree(
    workingDir: string,
    worktreePath?: string
): string {
    if (!worktreePath) return workingDir;
    if (!fs.existsSync(worktreePath) || !fs.statSync(worktreePath).isDirectory()) {
        console.warn(
            `[resolveWorkingDirForWorktree] worktreePath does not exist or is not a directory: ${worktreePath}. ` +
            `Falling back to repoScope-based workingDir.`
        );
        return workingDir;
    }
    return worktreePath;
}


/**
 * Collapse 3+ consecutive newlines down to 2, preserving intentional
 * paragraph breaks while eliminating excessive blank lines.
 */
export function normalizeNewlines(text: string): string {
    return text.replace(/\n{3,}/g, '\n\n');
}

/**
 * Detect if a workspace is single-repo or multi-repo based on the presence
 * of project markers in subdirectories.
 */
export function detectWorkspaceType(workspaceRoot: string): { isMultiRepo: boolean; subRepoNames: string[] } {
    const PROJECT_MARKERS = ['package.json', 'tsconfig.json', 'Cargo.toml', 'go.mod', 'pyproject.toml'];
    try {
        const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
        const subRepoNames: string[] = [];
        for (const entry of entries) {
            if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
            const subDir = path.join(workspaceRoot, entry.name);
            if (PROJECT_MARKERS.some(marker => fs.existsSync(path.join(subDir, marker)))) {
                subRepoNames.push(entry.name);
            }
        }
        return { isMultiRepo: subRepoNames.length > 1, subRepoNames };
    } catch {
        return { isMultiRepo: false, subRepoNames: [] };
    }
}

interface PromptDispatchContext {
    planList: string;
    dispatchContextBlock: string;
}

export interface PromptBuilderOptions {
    /** Base instruction hint (e.g. 'enhance', 'low-complexity', 'implement-all'). */
    instruction?: string;
    /** Whether to include an inline adversarial challenge block (lead role). */
    includeInlineChallenge?: boolean;
    /** Whether accuracy-mode workflow hint is appended (coder role). */
    accurateCodingEnabled?: boolean;
    /** When true, lead is told a coder agent is handling Routine tasks concurrently. Coder is told to do Routine work only. */
    pairProgrammingEnabled?: boolean;
    /** When true, planner classifies more tasks as Routine, assuming a competent Coder. */
    aggressivePairProgramming?: boolean;
    /** Whether advanced regression analysis block is appended (reviewer role). */
    advancedReviewerEnabled?: boolean;
    /** When true, replaces theatrical reviewer voice with terse bullet-point findings. */
    reviewerConciseModeEnabled?: boolean;
    /** When true, reviewer appends a brief summary to the plan file instead of reproducing full sections. */
    reviewerCompactPlanUpdateEnabled?: boolean;

    /** Path to the workflow file for the planner role. Defaults to .agents/workflows/improve-plan.md */
    plannerWorkflowPath?: string;

    /** Path/link to the project constitution. */
    constitutionLink?: string;
    /** Full content of the project constitution. */
    constitutionContent?: string;
    /** Whether constitution injection is enabled. */
    constitutionEnabled?: boolean;
    /** When present, appends a Design System Doc link to planner prompts. */
    designSystemDocLink?: string;
    /** When present, the full pre-fetched content of the design system doc. */
    designSystemDocContent?: string;
    /** Per-role prompt customisations loaded from state.json. */
    defaultPromptOverrides?: Partial<Record<string, DefaultPromptOverride>>;
    /** The absolute path to the workspace root. Used for workspace type detection and working directory resolution. */
    workspaceRoot?: string;
    /** When true, the git safety guardrail directive is included (permits worktrees/commits, forbids destructive undo). Default: true. */
    gitProhibitionEnabled?: boolean;
    /** Granular git policy — Branch strategy. `'notSpecified'`/`undefined` = emit no branch clause. */
    gitBranchStrategy?: 'current' | 'newBranch' | 'notSpecified';
    /** Granular git policy — Commit strategy. `'notSpecified'`/`undefined` = emit no commit clause. */
    gitCommitStrategy?: 'whenDone' | 'incremental' | 'dontCommit' | 'notSpecified';
    /** Granular git policy — Push strategy. `'notSpecified'`/`undefined` = emit no push clause. */
    gitPushStrategy?: 'noPush' | 'pushWhenDone' | 'notSpecified';
    /** When true, the coder/lead/intern prompt includes a Phone-a-Friend directive telling the agent to POST a notification to the LocalApiServer when the batch is done. */
    phoneAFriendEnabled?: boolean;
    /** The LocalApiServer port, interpolated into the Phone-a-Friend directive's curl URL. Plumbed at build time (Option A) so worktree CWDs don't need to read the port file. */
    apiPort?: number;
    /** When true (default), include batchExecutionRules and FOCUS_DIRECTIVE. When false, omit them. */
    switchboardSafeguardsEnabled?: boolean;
    /**
     * @deprecated No longer consumed by the prompt builder. Callers still pass it
     * harmlessly; retained to avoid widening the blast radius of the intro cleanup.
     */
    sourceColumnLabel?: string;
    /** The research depth to use for the deep research protocol (e.g. 'quick', 'standard', 'deep', 'academic'). */
    researchDepth?: string;
    /** The user's custom routing map configuration for agent complexities. */
    routingMapConfig?: { lead: number[]; coder: number[]; intern: number[] } | null;
    /** When true, instructs agents to ignore previous checkpoint summaries. */
    clearAntigravityContext?: boolean;
    /** When true, instructs planner agent to skip project compilation in its verification steps. */
    skipCompilation?: boolean;
    /** When true, instructs planner agent to skip automated test execution in its verification steps. */
    skipTests?: boolean;
    /** When true, instructs the planner to emit a research prompt for any assumption it is not 100% sure about. */
    adviseResearchIfUnsure?: boolean;
    /** When true, instructs the planner to backfill Goal, How the Subtasks Achieve This, and Dependencies & sequencing sections in feature files if missing. */
    writeFeatureDescriptionIfEmpty?: boolean;
    /** When true, instructs the agent to skip walkthrough.md artifact generation at task completion. */
    suppressWalkthroughEnabled?: boolean;
    /** When true, injects caveman communication style directive to reduce token usage. */
    cavemanOutputEnabled?: boolean;
    /** When true (default), uses parallel sub-agent instruction for multi-plan batches. When false, uses sequential-only instruction. */
    useSubagentsEnabled?: boolean;
    /** When true, injects strict no-subagent prohibition directive. Overrides useSubagentsEnabled. */
    noSubagentsEnabled?: boolean;
    /** When present and non-empty, injects directive authorizing use of this specific custom subagent. Overrides useSubagentsEnabled. */
    customSubagentName?: string;
    /** When true, instructs the agent to use native subagent/worktree capabilities to isolate each plan. */
    useWorktreesPerPlanEnabled?: boolean;
    /** The feature doc's path/link. */
    featureDocLink?: string;

    /** Controls ticket update behavior: disabled, comment-only, refine-ticket, or research-and-refine */
    ticketUpdateMode?: 'disabled' | 'comment-only' | 'refine-ticket' | 'research-and-refine';
    /** When false (explicitly), omits the complexity-scoring step. Defaults to enabled (undefined). */
    complexityScoringSkill?: boolean;
    /** When true, researcher prompt includes instruction to save results to local docs folder (.switchboard/docs/). */
    saveToLocalDocs?: boolean;
    /** The local docs folder path for the save-to-local-docs instruction. */
    localDocsPath?: string;
    /** When true, a non-planner role should prepend a workflow file instruction. */
    workflowFilePathEnabled?: boolean;
    /** Path to the workflow file for non-planner roles. */
    workflowFilePath?: string;
    /** Resolved chat-plan write destination(s) for the chat role. One path per entry; the agent picks one. */
    chatPlanDestinations?: string[];
    /** When true, the batch includes a feature and its subtasks. */
    featureMode?: boolean;
    /** The feature's topic/title for directive injection. */
    featureTopic?: string;
    /** Number of subtasks included in the feature batch. */
    subtaskCount?: number;
    /** User-configured feature prompt template, injected after the feature directive. */
    featurePromptTemplate?: string;
    /** §11 — when true, the dispatched card's board is under remote control; inject REMOTE_MODE_DIRECTIVE into all role prompts. */
    remoteControlActive?: boolean;
    /**
     * Per-project PRD (project-context toggle). When true, the active project's
     * PRD is injected into EVERY dispatched prompt via the shared dispatch prefix
     * (all roles) — it is NOT a per-role add-on. Gated solely by the project-context
     * toggle + an active-project PRD.
     */
    prdEnabled?: boolean;
    /** Path/link to the active project's PRD file. */
    prdLink?: string;
    /** Full content of the active project's PRD, embedded verbatim. [DEPRECATED — link-only as of PRD-link-only plan; no longer populated.] */
    prdContent?: string;
    /**
     * Per-project PRD links resolved from the plans' own project fields (not the board filter).
     * Link-only — the agent reads the PRD file itself (per feature_plan_20260702073858).
     * When empty/absent, no PRD block is emitted.
     */
    prdReferences?: Array<{ projectName: string; prdLink: string }>;
    /**
     * The feature's `feature_worktree_mode` snapshot ('none' | 'per-subtask' | 'high-low').
     * Only meaningful when featureMode is true. Selection between the base/per-subtask/high-low
     * orchestration directives is a NO-OP for 'none' and unset — those keep existing behavior.
     */
    featureWorktreeMode?: string;
    /** The feature's planId. Required for the high-low planner consolidation directive (assign-to-feature.js target) and the high-low executor directive. */
    featurePlanId?: string;
    /** Pre-provisioned tier worktrees for a `high-low`-mode feature, resolved from the worktrees table's `tier` column. Drives FEATURE_ORCHESTRATION_DIRECTIVE_HIGH_LOW. */
    tierWorktrees?: Array<{ tier: 'high' | 'low'; worktreePath: string }>;
    /** The feature's subtask plans (planId/topic/complexity), for the planner high-low consolidation directive. Only injected when featureWorktreeMode === 'high-low' and role === 'planner'. */
    subtaskPlansForConsolidation?: Array<{ planId: string; topic: string; complexity?: string }>;
    /** The active project name to pin into generated plan files. When set, emits a PROJECT PIN directive instructing the agent to write `**Project:** <name>` into each plan's metadata. */
    manifestProject?: string;
    /** The destination kanban column the card is being dispatched to. Drives the `**Stage Complete: <COLUMN>**` directive so the agent writes a matchable marker. */
    destinationColumn?: string;
}

export function resolveBaseInstructions(
    role: string,
    defaultBase: string,
    options?: PromptBuilderOptions
): string {
    const override = options?.defaultPromptOverrides?.[role];
    let base = defaultBase;
    if (override?.text) {
        switch (override.mode) {
            case 'replace': base = override.text; break;
            case 'prepend': base = `${override.text}\n\n${base}`; break;
            case 'append': base = `${base}\n\n${override.text}`; break;
        }
    }
    // NOTE: Custom agents handle workflow prepend separately in buildCustomAgentPrompt.
    // If you change the workflow instruction format here, update buildCustomAgentPrompt too.
    // Chat role is excluded because its instructions are already inlined via DEFAULT_CHAT_BASE_INSTRUCTIONS.
    if (role !== 'planner' && role !== 'chat' && options?.workflowFilePathEnabled && options?.workflowFilePath) {
        base = `Read ${options.workflowFilePath} and follow it step-by-step.\n\n${base}`;
    }
    return base;
}

function buildReviewerExecutionIntro(planCount: number): string {
    if (planCount <= 1) {
        return 'The implementation for this plan is complete. Execute a direct reviewer pass in-place.';
    }

    return `The implementation for each of the following ${planCount} plans is complete. Execute a direct reviewer pass in-place for each plan.`;
}

/** Build a plan-count-aware intro sentence. Fixes "1 plans" → "1 plan". */
function buildExecutionIntro(verb: string, plans: BatchPromptPlan[], featureMode?: boolean): string {
    if (featureMode) {
        return `Please ${verb} the feature described below.`;
    }
    if (plans.length <= 1) {
        return `Please ${verb} the plan below.`;
    }
    return `Please ${verb} the ${plans.length} plans below.`;
}

function withCoderAccuracyInstruction(basePayload: string, enabled: boolean): string {
    if (!enabled) {
        return basePayload;
    }

    const accuracyInstruction = `\n\nAccuracy Mode: Before coding, read and follow the workflow at .agents/workflows/accuracy.md step-by-step while implementing this task.`;
    return `${basePayload}${accuracyInstruction}`;
}

export function buildPromptDispatchContext(plans: BatchPromptPlan[]): PromptDispatchContext {
    const normalizedPlans = plans.map(plan => ({
        ...plan,
        workingDir: (plan.workingDir || '').trim()
    }));
    const planList = normalizedPlans.map(plan => {
        if (plan.isSubtask && plan.featureTopic) {
            return `  - [SUBTASK] ${plan.topic} Plan File: ${plan.absolutePath}`;
        }
        if (plan.featureTopic && !plan.isSubtask) {
            return `- [FEATURE: ${plan.featureTopic}] Plan File: ${plan.absolutePath}`;
        }
        return `- [${plan.topic}] Plan File: ${plan.absolutePath}`;
    }).join('\n');
    const distinctWorkingDirs = [...new Set(normalizedPlans.map(plan => plan.workingDir).filter(Boolean))];
    const allPlansShareDir =
        normalizedPlans.length > 0
        && distinctWorkingDirs.length === 1
        && normalizedPlans.every(plan => !!plan.workingDir && plan.workingDir === distinctWorkingDirs[0]);

    if (allPlansShareDir) {
        return {
            planList,
            dispatchContextBlock: `WORKING DIRECTORY: ${distinctWorkingDirs[0]}
All file reads and writes must be relative to this directory unless the plan explicitly states otherwise.`
        };
    }

    const anyWorkingDirSet = normalizedPlans.some(plan => !!plan.workingDir);
    if (!anyWorkingDirSet) {
        return { planList, dispatchContextBlock: '' };
    }

    const perPlanDirectories = normalizedPlans.map(plan =>
        `- [${plan.topic}] Working Directory: ${plan.workingDir
            ? plan.workingDir
            : '[not set — add **Repo:** to the plan metadata before dispatching from a control plane]'}`
    ).join('\n');

    return {
        planList,
        dispatchContextBlock: `MULTI-REPO BATCH:
Do NOT assume a single working directory for every plan in this prompt.
${perPlanDirectories}`
    };
}

/**
 * §Git — Granular git policy.
 *
 * The old single `GIT_PROHIBITION_DIRECTIVE` string conflated a safety guardrail
 * (forbid destructive ops) with permission to branch/commit and a shared-branch
 * push ban. That binary string caused two symptoms: agents refused legitimate
 * commits to `main` (a "shared branch") AND created defensive branches to have
 * somewhere "allowed" to commit. It is replaced by a composed `GIT POLICY:` block
 * assembled from four independent, prescriptive clauses (Branch → Commit → Push →
 * Safety) by `buildGitPolicyBlock`. The Safety guardrail below is the salvaged
 * half of the original string and remains byte-for-byte as strong — do not soften.
 */
export const GIT_SAFETY_DIRECTIVE = `Never run work-discarding or history-rewriting commands: git reset (--hard/--mixed), git checkout \`<path>\` / git restore, git clean, git stash drop/clear, force pushes, or branch/worktree deletion. If you make a mistake, do not discard — commit first, then correct forward.`;

/** Branch clause vocabulary. */
const GIT_BRANCH_CLAUSES: Record<string, string> = {
    current: 'Do all work on the current branch. Do NOT create new branches or worktrees.',
    newBranch: 'Before making any changes, create ONE new git branch named descriptively for this task, and do all work on that single branch. Do not create additional branches.'
};

/** Commit clause vocabulary. */
const GIT_COMMIT_CLAUSES: Record<string, string> = {
    whenDone: 'When you have finished the task, stage all your changes and create a single descriptive commit.',
    incremental: 'Commit at each logical checkpoint with a clear message so progress is captured incrementally.',
    dontCommit: 'Do NOT commit. Leave all changes in the working tree for the user to review.'
};

/** Push clause vocabulary. */
const GIT_PUSH_CLAUSES: Record<string, string> = {
    noPush: 'Do NOT push to any remote.',
    pushWhenDone: 'After committing, push the working branch to its remote. Do not force-push.'
};

/**
 * Compose the `GIT POLICY:` block from the four independent clauses.
 *
 * Pure: `undefined` and `'notSpecified'` both mean "emit no clause for that
 * dimension". `guardrail` emits only when truthy. Returns `''` when nothing is
 * enabled. The `GIT POLICY:` literal marker is kept as the block prefix so any
 * existing substring-based tests/assertions remain valid.
 *
 * Feature-worktree interaction (read-only — never creates anything): when
 * `worktreeActive` is true a feature orchestration directive already owns the
 * branch/worktree language for the assigned worktree, so the Branch clause is
 * suppressed to avoid contradicting it. The Commit clause is anchored to the
 * assigned worktree. Push/Safety still emit normally. Mixed-batch edge case:
 * if any plan in the batch carries a worktree, the Branch clause is suppressed
 * globally (the feature directive owns worktree/branch language for those plans;
 * non-worktree plans sharing a batch with worktree plans is an accepted rarity).
 */
export function buildGitPolicyBlock(opts: {
    branch?: string;
    commit?: string;
    push?: string;
    guardrail?: boolean;
    worktreeActive?: boolean;
}): string {
    const { branch, commit, push, guardrail, worktreeActive } = opts;
    const clauses: string[] = [];

    // Branch clause — suppressed when a feature worktree is already assigned
    // (the feature orchestration directive owns branch/worktree language).
    if (!worktreeActive && branch && branch !== 'notSpecified' && GIT_BRANCH_CLAUSES[branch]) {
        clauses.push(GIT_BRANCH_CLAUSES[branch]);
    }

    // Commit clause — anchor to the assigned worktree when one is active.
    if (commit && commit !== 'notSpecified' && GIT_COMMIT_CLAUSES[commit]) {
        const commitText = GIT_COMMIT_CLAUSES[commit];
        clauses.push(worktreeActive ? `${commitText} Commit inside your assigned worktree.` : commitText);
    }

    // Push clause.
    if (push && push !== 'notSpecified' && GIT_PUSH_CLAUSES[push]) {
        clauses.push(GIT_PUSH_CLAUSES[push]);
    }

    // Safety guardrail — independent checkbox; emits only when truthy.
    if (guardrail) {
        clauses.push(GIT_SAFETY_DIRECTIVE);
    }

    if (clauses.length === 0) return '';
    return `GIT POLICY: ${clauses.join(' ')}`;
}

/**
 * Phone-a-Friend directive — appended to coder/lead/intern prompts when the
 * `phoneAFriend` addon is enabled. Tells the agent to POST a notification to the
 * LocalApiServer ONCE per batch (with the last completed plan file) when it has
 * finished coding. The port is interpolated at build time (Option A) so worktree
 * CWDs don't need to read the port file (which lives only in the main workspace
 * root's .switchboard/). The directive is mandatory for the agent, but a missing
 * Phone-a-Friend terminal is silently dropped by the host (non-fatal).
 */
export const PHONE_A_FRIEND_DIRECTIVE = (port: number) =>
  `PHONE-A-FRIEND: When you have finished coding ALL plans in this batch, you MUST notify the Phone-a-Friend agent ONCE by running:\ncurl -s -X POST http://127.0.0.1:${port}/phone-a-friend -H "Content-Type: application/json" -d '{"planFile":"<PLAN_FILE_PATH>","originRole":"coder"}'\nReplace <PLAN_FILE_PATH> with the relative path of the LAST plan file you completed. Send exactly one request per batch (not one per plan). This is a required step — if the Phone-a-Friend agent is not running, the request will still succeed silently, but you must send it regardless. (Requires the Phone-a-Friend agent configured in the Agents tab.)`;

export const FOCUS_DIRECTIVE = `FOCUS: Each plan file path below is the single source of truth for that plan; ignore any mirrored or 'brain'-directory copies of it.`;

// §11 — injected for ALL roles when the dispatched card's board is under remote control.
// The user is on their phone, not the terminal, so questions must go to the linked issue
// as a comment (posted host-side through the LocalApiServer bridge via linear_api/clickup_api),
// not to terminal input.
export const REMOTE_MODE_DIRECTIVE = `REMOTE MODE: You are running under remote control — the user is NOT at the terminal. If you need to ask the user anything or report a blocker, post it as a comment on the linked issue using the linear_api skill (or clickup_api). Do NOT wait on terminal input. Continue with any work you can do without the answer.`;

/** §8 — Shared batch execution rules constant, used by both buildKanbanBatchPrompt and buildCustomAgentPrompt. */
export const BATCH_EXECUTION_RULES = `CRITICAL INSTRUCTIONS:
1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans.
2. Execute each plan fully before moving to the next (if sequential).
3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so.`;

/**
 * Activity-light OFF-switch. The exact label the agent appends to a plan file when it
 * finishes a stage; the watcher (planMetadataUtils) parses this same constant to clear the
 * card's `working` state. Shared so the emitter and parser cannot drift.
 */
export const STAGE_COMPLETE_LABEL = 'Stage Complete';

/**
 * Builds the mandatory "append `**Stage Complete:** <COLUMN>` when done" directive.
 * Folded into the shared dispatch prefix so every role (and custom agents) receive it.
 * The marker shape (`**Label:** value`, value outside the bold) matches the
 * extractEmbeddedMetadata convention used for ClickUp/Linear IDs so the watcher's
 * parser (planMetadataUtils) reads it cleanly. When `destinationColumn` is empty, the
 * directive tells the agent to echo the column it was dispatched for (never emits a
 * literal `undefined`).
 */
function buildStageCompleteDirective(destinationColumn?: string): string {
    const column = destinationColumn && destinationColumn.trim() ? destinationColumn.trim() : '<the column you were dispatched for>';
    return `STAGE COMPLETE (MANDATORY): When you have finished the stage for a plan, append a single line to that plan's .md file:\n**Stage Complete:** ${column}\nThis is the ONLY signal the board uses to turn off your card's activity light — the board cannot tell you have finished otherwise. Append it to EACH plan file you complete (one marker per file, not one for the whole batch).`;
}

/** §8 — Shared PRD reference block builder from raw refs. Used by both buildPrdReferenceBlock and buildCustomAgentPrompt. */
function buildPrdReferenceBlockFromRefs(refs: Array<{ projectName: string; prdLink: string }> | undefined): string {
    if (!refs || refs.length === 0) return '';
    if (refs.length === 1) {
        const r = refs[0];
        return `PROJECT REQUIREMENTS (PRD):\nRead the following product requirements document and respect it throughout this work:\n${r.prdLink}`;
    }
    const sections = refs.map(r =>
        `PROJECT REQUIREMENTS (PRD) — project "${r.projectName}":\nRead ${r.prdLink} and respect it for plans belonging to this project.`
    );
    return `PROJECT REQUIREMENTS (PRD) — multiple projects in this batch:\n${sections.join('\n\n')}`;
}

/**
 * Build the per-project PRD reference block folded into the shared dispatch
 * prefix (`dispatchPrefixCore`) so it reaches EVERY role — mirroring the §11
 * remote-mode prefix injection, NOT the planner-only constitution block.
 * Gated by `options.prdReferences` presence (the project-context toggle + resolved PRD links).
 */
export function buildPrdReferenceBlock(options: PromptBuilderOptions | undefined, role: string): string {
    if (role === 'tester') return '';
    return buildPrdReferenceBlockFromRefs(options?.prdReferences);
}

export const INLINE_CHALLENGE_DIRECTIVE = `For each plan, before implementation:
- perform a concise adversarial review of that specific plan,
- list at least 2 concrete flaws/edge cases and how you'll address them,
- then execute using those corrections,
- do NOT start any auxiliary workflow for this step.`;

export const SPLIT_PLAN_DIRECTIVE = `SPLIT PLAN MODE: Produce TWO files per plan. Original file = Complex / Risky only. Companion file (\`<stem>_routine.md\`) = Routine only. Both files must include full shared context (Goal, Metadata, Current State, Edge-Case audit, Dependencies). Original file notes: "Assume Routine items implemented by Coder agent." Read the full original file before writing either output. Create both files in the same directory as the original.`;
export const SKIP_COMPILATION_DIRECTIVE = `SKIP COMPILATION: Do not run any project compilation step as part of the verification plan.`;
export const SKIP_TESTS_DIRECTIVE = `SKIP TESTS: Do not run automated tests as part of the verification plan.`;
// The full research-prompt template now lives in .agents/skills/advise_research/SKILL.md (the
// canonical source). The generateResearchPrompt() function in src/webview/planning.js is a separate
// UI-driven code path (Research tab) and remains independent — it embeds the same structure for the
// webview and cannot read the extension-side skill file at runtime. Both share the template structure
// via the skill file as canonical source.
export const ADVISE_RESEARCH_DIRECTIVE = `RESEARCH WHEN UNSURE: As you plan, track every assumption, factual claim, API/behavior, or library detail you are NOT 100% certain about. If any exist, read the skill file .agents/skills/advise_research/SKILL.md and follow it. In the plan file, add a brief "## Uncertain Assumptions" section that lists ONLY those uncertainties and notes that the user was advised to run web research to confirm them before implementation — do NOT put the research prompt itself in the plan. Then, at the very end of your chat summary to the user (after everything else), supply the ready-to-run research prompt so they can trigger web research. If you are confident about everything, state that no research is needed and omit both the section and the prompt.`;

export const WRITE_FEATURE_DESCRIPTION_IF_EMPTY_DIRECTIVE = `FEATURE DESCRIPTION BACKFILL: The feature file path is included in the plan list above (the entry tagged [FEATURE: ...]). Read that file. If it is missing any of these three sections, write them now following this format:
- ## Goal: 2-4 sentences describing what the feature achieves, what problem it solves, and why these plans are grouped together.
- ## How the Subtasks Achieve This: one bullet per member plan (subtask) explaining what it does and how it contributes to the feature's goal. Format: "- **<Plan Name>**: <what it does and how it contributes>"
- ## Dependencies & sequencing: bullet list covering (a) cross-feature dependencies — what must land first from other features, if any; (b) shipping order within this feature — which subtask should be coded/merged before which, and why; (c) prerequisites or guards that must be in place. If there are no cross-feature dependencies and the subtasks are independent, state that explicitly (e.g. "No cross-feature dependencies; subtasks are independent and can land in any order"). If there is only one subtask, note "Single subtask — no internal ordering."
If all three sections already exist with substantive content, leave them untouched. If only some are missing, backfill only the missing ones. Treat a section titled "## Dependencies" (without "& sequencing") as present — do not duplicate it. Do NOT modify the auto-generated "<!-- BEGIN SUBTASKS -->" block or the "<!-- BEGIN WORKTREES -->" block — write your sections between the title/complexity and the BEGIN SUBTASKS marker. Read each subtask plan file to ground the Goal, How bullets, and dependency analysis in the actual plan content, not just titles.`;
export const CAVEMAN_OUTPUT_DIRECTIVE = `CAVEMAN MODE: Talk like caveman. Drop filler, keep substance. Use fragments. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].`;
export const SUPPRESS_WALKTHROUGH_DIRECTIVE = `SUPPRESS WALKTHROUGH: Do NOT generate a walkthrough.md artifact at the end of this task. Omit the walkthrough creation step entirely.`;

export const NO_SUBAGENTS_DIRECTIVE = "SUBAGENT POLICY: You are strictly forbidden from spawning or invoking any subagents. Handle all tasks yourself.";
export const CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE = (name: string) =>
    `SUBAGENT POLICY: You are authorized to use the "${name}" subagent for this task. Do not spawn or invoke any other subagents.`;
export const WORKTREES_PER_PLAN_DIRECTIVE = 'Where possible, process each plan as an isolated unit using your native subagent or orchestration capabilities, creating a dedicated git worktree per plan to prevent file conflicts between concurrent tasks.';

export const FEATURE_ORCHESTRATION_DIRECTIVE = (featureTopic: string, count: number) =>
    `FEATURE MODE: You are implementing the feature "${featureTopic}" which consists of ${count} subtask(s).\n` +
    `Use your native subagent or orchestration capabilities to handle each subtask. ` +
    `If your tool supports worktree-per-plan isolation, activate it now. ` +
    `If you do not support subagents, handle each subtask sequentially in the order listed below. ` +
    `All subtasks are part of a single delivery unit — do not treat them as independent tickets.\n` +
    `Before starting, briefly tell the user how you are using the workflow to handle these subtasks (e.g. parallel vs sequential and why, how they are grouped, and any review/verification pass you plan to run).`;

/**
 * `per-subtask` worktree mode variant: the extension has ALREADY pre-provisioned one
 * worktree per subtask off the shared feature integration branch — this replaces the
 * "create your own worktree" guidance from the base directive with "dispatch into the
 * path already assigned to you." Falls back to the base directive at the call site when
 * no subtask worktree paths resolved (mode mismatch / lazy-create failed) so the agent
 * always gets usable orchestration guidance either way.
 */
export const FEATURE_ORCHESTRATION_DIRECTIVE_PER_SUBTASK = (featureTopic: string, subtaskWorktrees: Array<{ topic: string; worktreePath: string }>) =>
    `FEATURE MODE (worktree-per-subtask): You are implementing the feature "${featureTopic}" which consists of ${subtaskWorktrees.length} subtask(s).\n` +
    `Each subtask has ALREADY been assigned its own isolated git worktree, pre-created off the shared feature integration branch. Do NOT create your own worktrees for these subtasks. ` +
    `Use your native subagent or orchestration capabilities to dispatch one subagent per subtask into its assigned worktree path below, so subagents cannot collide on files:\n` +
    subtaskWorktrees.map(sw => `  - [SUBTASK] ${sw.topic} → Worktree: ${sw.worktreePath}`).join('\n') + '\n' +
    `If you do not support subagents, handle each subtask sequentially, running each one's changes from inside its assigned worktree path. ` +
    `All subtasks are part of a single delivery unit — do not treat them as independent tickets. Do not merge branches yourself; the extension owns convergence into the feature integration branch and, later, into main.\n` +
    `Before starting, briefly tell the user how you are using the workflow to handle these subtasks (e.g. parallel vs sequential and why, how they are grouped, and any review/verification pass you plan to run).`;

/**
 * `high-low` worktree mode variant: the extension has ALREADY pre-provisioned exactly two
 * tier worktrees (high/low complexity) off the shared feature integration branch. The planner
 * (dispatched separately, see PLANNER_HIGH_LOW_CONSOLIDATION_DIRECTIVE) is expected to have
 * consolidated the feature's subtask plans into two new plan files, but may not have produced
 * exactly two (a broken/partial planner run) — so this directive references the tier
 * worktrees by their `tier` column/label, not by an assumed count or order of plan files.
 */
export const FEATURE_ORCHESTRATION_DIRECTIVE_HIGH_LOW = (featureTopic: string, tierWorktrees: Array<{ tier: 'high' | 'low'; worktreePath: string }>) =>
    `FEATURE MODE (high/low complexity split): You are implementing the feature "${featureTopic}".\n` +
    `The feature's subtask plans have been consolidated into complexity tiers (high-complexity, low-complexity). Each tier has ALREADY been assigned its own isolated git worktree, pre-created off the shared feature integration branch. Do NOT create your own worktrees for these tiers.\n` +
    `Use your native subagent or orchestration capabilities to dispatch one subagent per tier below, running IN PARALLEL, each from inside its assigned worktree path:\n` +
    tierWorktrees.map(tw => `  - [${tw.tier.toUpperCase()} TIER] Worktree: ${tw.worktreePath}`).join('\n') + '\n' +
    `Match each tier's subagent to the consolidated plan file(s) intended for that tier (check each plan's "Consolidated From" / tier marker in its metadata) — do not assume plan file order or count; a partial planner run may not have produced exactly one plan per tier. ` +
    `If you do not support subagents, process the high tier first, then the low tier, each fully from inside its assigned worktree path. ` +
    `Do not merge branches yourself; the extension owns convergence into the feature integration branch and, later, into main.\n` +
    `Before starting, briefly tell the user how you are using the workflow to handle these tiers (parallel subagent assignment, which plan(s) map to which tier, and any review/verification pass you plan to run).`;

/**
 * Injected into the PLANNER role's prompt only, only for `high-low`-mode features. Additive to
 * improve-plan.md, not a replacement — the planner still runs the full planning workflow, this
 * just adds a consolidation pass on top of it.
 *
 * LOAD-BEARING DETAIL: `GlobalPlanWatcherService._handlePlanFile` (src/services/GlobalPlanWatcherService.ts)
 * imports new/changed `.switchboard/plans/*.md` files via `KanbanDatabase.insertFileDerivedPlan`
 * (src/services/KanbanDatabase.ts:1387). That INSERT statement does NOT reference `feature_id` at
 * all — there is no `**Feature ID:**`-style marker the watcher parses to link a file-derived plan to
 * a feature. `feature_id` is a DB-owned column, only ever set imperatively via
 * `KanbanDatabase.updateFeatureStatus(planId, isFeature, featureId)` — see `KanbanProvider.createFeatureFromPlanIds`'s
 * subtask-linking loop, and `PlanFileImporter.ts`'s explicit comment that file-derived imports
 * have "no business setting DB-owned columns (is_feature, feature_id, ...)". So the two new consolidated
 * plans CANNOT be linked to the feature by embedding a marker in their file content — they must be
 * linked via the `assign-to-feature.js` script (routes through the running extension's
 * `/kanban/feature/assign` endpoint, which calls updateFeatureStatus + regenerates the feature file). The
 * directive below instructs the planner to write the files first (so they get a planId from the
 * watcher import) and then explicitly run assign-to-feature.js — this is the only correct linkage
 * path; a content marker would silently produce orphan CREATED cards.
 */
export const PLANNER_HIGH_LOW_CONSOLIDATION_DIRECTIVE = (featureTopic: string, featurePlanId: string, subtaskPlans: Array<{ planId: string; topic: string; complexity?: string }>) =>
    `HIGH/LOW COMPLEXITY CONSOLIDATION (additive to the planning workflow above — run this AFTER completing the normal planning steps, not instead of them):\n` +
    `This dispatch is for the feature "${featureTopic}" (feature planId: ${featurePlanId}), which has ${subtaskPlans.length} existing subtask plan(s):\n` +
    subtaskPlans.map(sp => `  - [${sp.complexity ?? 'Unknown'}] ${sp.topic} — planId: ${sp.planId}`).join('\n') + '\n' +
    `1. Read all ${subtaskPlans.length} subtask plan files listed above in full.\n` +
    `2. Consolidate them into EXACTLY TWO new plan files, following the same section structure as the subtask plans (Goal, Metadata, Complexity Audit, Proposed Changes, Verification Plan, etc.):\n` +
    `   - One HIGH-complexity plan combining every subtask scoring 5 or above.\n` +
    `   - One LOW-complexity plan combining every subtask scoring 4 or below.\n` +
    `   - If every subtask lands in only one tier, still write both files — the low/high plan for the empty tier should state there is no work for that tier (do not skip writing it; the executor dispatch depends on both existing).\n` +
    `3. Write the two new files to .switchboard/plans/ with descriptive filenames. Give each a "**Complexity:**" metadata line reflecting its tier (>=5 for the high plan, <=4 for the low plan) and a "**Consolidated From:**" metadata line listing the original subtask planIds, for human traceability.\n` +
    `4. Do NOT delete, edit, or replace the ${subtaskPlans.length} original subtask plan files — keep them as-is; the new files are additional, not replacements.\n` +
    `5. After writing both files, wait a few seconds for the file watcher to import them (they need to be picked up and assigned a planId before they can be linked), then run:\n` +
    `   node .agents/skills/kanban_operations/assign-to-feature.js ${featurePlanId} '["<new-high-plan-planId>","<new-low-plan-planId>"]'\n` +
    `   Look up each new plan's planId via .agents/skills/kanban_operations/get-state.js (matched by plan_file/topic) before running assign-to-feature.js — do not guess the planId.\n` +
    `6. Report the two new plan file paths and their planIds at the end of your response so the executor dispatch can find them.`;

/**
 * Context bundle for `resolveFeatureOrchestrationDirective` — carries whatever the
 * three variants each need. `subtaskWorktrees`/`tierWorktrees` are independent;
 * only the one matching the resolved mode is consulted.
 */
interface FeatureOrchestrationDirectiveContext {
    subtaskWorktrees?: Array<{ topic: string; worktreePath: string }>;
    tierWorktrees?: Array<{ tier: 'high' | 'low'; worktreePath: string }>;
}

/**
 * Single selector for the three orchestration-directive variants, keyed on the
 * feature's `feature_worktree_mode`. Preserves the exact fallback semantics that
 * previously lived inline in `buildKanbanBatchPrompt`:
 * - `high-low` tier worktrees are only consulted when mode === 'high-low' (gated).
 * - Subtask-own worktrees (per-subtask variant) are consulted whenever any resolved
 *   — independent of the live mode value, matching the pre-refactor `else` branch,
 *   which kept selecting the per-subtask variant off `hasOwnWorktree` data alone.
 *   This intentionally covers the case where worktree rows outlive a mode change
 *   (e.g. feature switched from `per-subtask` to `none`/`high-low` mid-lifecycle
 *   without deprovisioning existing per-subtask worktree rows).
 * - Otherwise falls back to the base directive.
 * Unknown mode values (not `none`/`per-subtask`/`high-low`) that don't resolve to
 * either variant above log a warning and fall back to the base directive.
 */
export function resolveFeatureOrchestrationDirective(
    mode: string | undefined,
    featureTopic: string,
    subtaskCount: number,
    context?: FeatureOrchestrationDirectiveContext
): string {
    const tierWorktrees = mode === 'high-low' ? (context?.tierWorktrees || []) : [];
    if (tierWorktrees.length > 0) {
        return FEATURE_ORCHESTRATION_DIRECTIVE_HIGH_LOW(featureTopic, tierWorktrees);
    }

    const subtaskWorktrees = context?.subtaskWorktrees || [];
    if (subtaskWorktrees.length > 0) {
        return FEATURE_ORCHESTRATION_DIRECTIVE_PER_SUBTASK(featureTopic, subtaskWorktrees);
    }

    if (mode !== undefined && mode !== 'none' && mode !== 'per-subtask' && mode !== 'high-low') {
        console.warn(`[agentPromptBuilder] Unknown feature_worktree_mode "${mode}" — falling back to base orchestration directive.`);
    }
    return FEATURE_ORCHESTRATION_DIRECTIVE(featureTopic, subtaskCount);
}

export const COMPLEXITY_SCORING_DIRECTIVE =
    `COMPLEXITY SCORING: Before proceeding, invoke the complexity_scoring skill ` +
    `(skill: "complexity_scoring") to add a ## Complexity Audit section with ` +
    `### Routine and ### Complex / Risky subsections. ` +
    `Classify each implementation step by complexity before splitting.`;

export const TICKET_UPDATE_DIRECTIVE =
    `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
    `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
    `Analyze the plan, then use the clickup_api or linear_api skill to add an "AI Analysis" comment to the ticket. ` +
    `Do not modify the ticket description. Only add a comment. ` +
    `If no ticket number is found, skip the ticket update and notify the user.`;

export const TICKET_REFINE_DIRECTIVE =
    `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
    `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
    `Analyze the plan, then use the clickup_api or linear_api skill to refine the ticket description. ` +
    `Update the description to reflect the plan's current state, implementation details, and any changes from the original request. ` +
    `If no ticket number is found, skip the ticket update and notify the user.`;

export const TICKET_RESEARCH_REFINE_DIRECTIVE =
    `RESEARCH MODE: Before updating the ticket, use the web_research skill to gather additional context. ` +
    `Research the technical approach, dependencies, best practices, and any relevant recent developments. ` +
    `If the web_research skill is unavailable, proceed with codebase-only analysis and note the gap.\n\n` +
    `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
    `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
    `After completing research, use the clickup_api or linear_api skill to refine the ticket description. ` +
    `Update the description to reflect the plan's current state, implementation details, research findings, and any changes from the original request. ` +
    `If no ticket number is found, skip the ticket update and notify the user.`;


export const ADVANCED_REVIEWER_DIRECTIVE = `ADVANCED REGRESSION ANALYSIS (enabled):
1. Trace all callers and consumers of every modified function. Check whether changes to its signature, return value, side effects, or timing could break callers.
2. Check for double-trigger bugs: if you add a UI refresh, verify no caller already triggers one.
3. Check for race conditions: if the change involves async state (DB writes, file watchers, mtime checks), verify it doesn't conflict with concurrent systems (autoban polling, cross-IDE sync, write serialization chains).
4. Check for orphaned references: if dead code was removed, grep for any remaining references to the removed identifiers.
5. Audit the full execution path from UI entry point to final state change, not just the changed lines.
This analysis is token-intensive but catches regressions that plan-compliance-only reviews miss.`;

export const AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE = `PAIR PROGRAMMING OPTIMISATION: Aggressive mode is enabled. Assume the Coder agent is highly competent and can handle most implementation tasks independently, including multi-file changes, test updates, and straightforward refactors. Only classify tasks as Complex / Risky if they involve: (a) new architectural patterns or framework integrations the codebase hasn't used before, (b) security-sensitive logic (auth, crypto, permissions), (c) complex state machines or concurrency, or (d) changes that could silently break existing behaviour without obvious test failures. Everything else — even if it touches multiple files or requires careful reading — should be Routine.`;

export const DEEP_RESEARCH_DIRECTIVE =
    `DEEP RESEARCH MODE: You are authorized to perform comprehensive deep research ` +
    `on the provided plan using the deep_planning skill protocol with depth set to "deep" (50-100 sources). ` +
    `\n\nSKIP PHASE 0 (Planning Proposal): Research depth is pre-configured. Proceed directly to Phase 1.` +
    `\n\nEXECUTE FULL DEEP PLANNING PROTOCOL:\n` +
    `PHASE 1: Codebase Exploration — run parallel searches (find_by_name, grep, list_dir); read key implementation, config, test, and doc files.\n` +
    `PHASE 2: External Research — use search_web with dynamic date ranges. ` +
    `IF search_web is unavailable: complete with codebase-only analysis, note gap in "Knowledge Gaps" section, continue to Phase 3.\n` +
    `PHASE 3: Cross-Reference — compare internal and external findings; identify gaps, anti-patterns, security issues.\n` +
    `PHASE 4: Synthesis — produce output following this structure:\n` +
    `1) Executive summary (≤ 1 page)\n` +
    `2) Tiered findings: required vs recommended vs optional — clearly distinguish compliance levels\n` +
    `3) Focused trade-off evaluation (e.g. searchability vs confidentiality, cost vs coverage)\n` +
    `4) Defence-in-Depth controls checklist\n` +
    `5) Plain-English glossary of domain-specific terms\n` +
    `6) Full source list with direct links and retrieval dates\n` +
    `7) Current State Analysis\n` +
    `8) External Research Findings\n` +
    `9) Proposed Implementation Plan\n` +
    `10) Impact Analysis\n` +
    `11) Source Credibility Assessment\n` +
    `12) Knowledge Gaps\n` +
    `13) Recommended Next Steps\n` +
    `SOURCE GUIDANCE: Prefer official documentation, standards bodies, and peer-reviewed sources; distrust vendor marketing claims. Date-check all sources — flag anything older than 2 years. Separate "required" from "recommended" from "opinion" in every finding. Where law or standards are silent or ambiguous, say so rather than assuming applicability.\n` +
    `DECISION THIS FEEDS: End with a recommended default for a platform of typical scale — do not just survey the field.\n` +
    `TARGET SOURCE COUNT: 50-100 sources (soft target — prioritize quality over quantity).`;

/**
 * DEFAULT_CHAT_BASE_INSTRUCTIONS must be kept in sync with .agents/workflows/switchboard-chat.md.
 * If you update the workflow file, ensure this constant is updated to match.
 */
export const DEFAULT_CHAT_BASE_INSTRUCTIONS = `You are in Consultation & Planning Mode. Your role is Product Manager and Architect: gather requirements, challenge assumptions, and draft implementation plans. You do not write or edit code.

Hard Rules:
1. **No implementation until explicit approval.** You may not write, modify, or suggest code changes. The only exception is if the user has (a) reviewed a detailed \`implementation_plan.md\` you wrote, and (b) explicitly instructed you to proceed, implement, or execute.
2. **No eager context.** Discard automatically injected active documents from IDE metadata unless the user explicitly or implicitly references a file path (e.g., "look at file X," "in file Y this needs changing"). In that case, read it immediately without requiring a directive verb.
3. **No eager research.** On the first turn, your only action is to respond with a brief greeting and wait for input — do not plan, research, or run any tool. Do not run codebase searches, file views, or directory listings during general onboarding or until the user specifies a problem.
4. **Orchestrate, don't develop.** Your task is to clarify the "What" and "Why," identify edge cases, define constraints, and produce a complete, user-approved plan before any code is written.
5. **Plan artifact & quality gate.** Write the plan to one of the paths listed in the PLAN DESTINATION directive below (configured by the user in Switchboard Setup), using a unique filename — only those locations; do not write or copy the plan anywhere else, including any session/brain directory. Every plan must have a descriptive H1 title (never generic), and a \`## Metadata\` section with \`**Complexity:**\` (1–10), \`**Tags:**\` (comma-separated, from: frontend, backend, auth, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library), and \`**Project:**\` (if the PROJECT PIN directive is present, write the exact project name specified).
6. **No self-editing of system files.** If workflow configurations or persona files need changes, notify the user and ask for explicit permission.
7. **Stay in chat.** Do not pivot to execution or delegation unless the user explicitly requests it.
8. **Project Pinning:** When the dispatch prompt carries a PROJECT PIN directive, write the \`**Project:\` line into each plan file's metadata block.

Process:
1. **Onboard:** Greet the user. Identify the core problem or opportunity. Focus on ideation.
2. **Iterate:** Ask "Why" before "How." Challenge assumptions. Document requirements, edge cases, and risks the user may have missed.
3. **Plan:** When the "What" and "Why" are clear, draft the implementation plan.
4. **Gate:** Only suggest moving forward once the plan is complete and the user has explicitly approved it.

Feature Grouping:
When the work spans 3 or more plan files on a related topic (sharing a common feature area or root cause), flag it during scoping — "This looks like it will produce 3+ related plans — want me to group them under a feature once they're drafted?" — and offer again at the closing gate once all plans are written (or once the user signals scoping is complete). Only create the feature if the user confirms. When the user says yes, invoke the \`create-feature-from-plans\` skill — it handles the mechanics (plan ID resolution, \`create-feature.js\` execution, verification, and narrative section writing). Do NOT write feature files by hand or reverse-engineer the creation script. If the extension is not running, the skill will fall back to the \`create-feature\` remote path automatically.`;

export function PROJECT_LINE_DIRECTIVE(project: string): string {
    return `PROJECT PIN: The user had the project "${project}" active when they copied this prompt. Write this line into each plan file's metadata section (alongside **Complexity:** and **Tags:**):\n**Project:** ${project}\nThis pins the plan to that project regardless of what project is active when the file is imported. Omit the line only if no project name is given above.`;
}

const DEFAULT_PLANNER_WORKFLOW = '.agents/workflows/improve-plan.md';

/** Roles that touch code and should receive the git safety guardrail. */
const CODE_TOUCHING_ROLES = new Set(['lead', 'coder', 'intern', 'reviewer', 'tester']);

/**
 * Shared suffix-block assembler. Canonicalises inclusion rules so they can't
 * drift per-branch. `gitBlock` is included only for code-touching roles.
 */
function assembleSuffix(role: string, parts: {
    dispatchContextPrefix?: string;
    focusBlock?: string;
    gitBlock?: string;
    antigravityBlock?: string;
    skipBlock?: string;
    subagentBlock?: string;
}): string {
    return [
        parts.dispatchContextPrefix,
        parts.focusBlock,
        CODE_TOUCHING_ROLES.has(role) ? parts.gitBlock : '',
        parts.antigravityBlock,
        parts.skipBlock,
        parts.subagentBlock
    ].filter(Boolean).join('\n\n');
}

/**
 * Canonical prompt builder.  Every UI surface that produces a prompt for an
 * agent role MUST call this function so that "Copy Prompt", "Advance",
 * autoban, and ticket-view dispatch all emit identical text.
 */
export function buildKanbanBatchPrompt(
    role: string,
    plans: BatchPromptPlan[],
    options?: PromptBuilderOptions
): string {
    const includeInlineChallenge = options?.includeInlineChallenge ?? false;
    const accurateCodingEnabled = options?.accurateCodingEnabled ?? false;
    const pairProgrammingEnabled = options?.pairProgrammingEnabled ?? false;
    const aggressivePairProgramming = options?.aggressivePairProgramming ?? false;
    const advancedReviewerEnabled = options?.advancedReviewerEnabled ?? false;
    const reviewerConciseModeEnabled = options?.reviewerConciseModeEnabled ?? false;
    const reviewerCompactPlanUpdateEnabled = options?.reviewerCompactPlanUpdateEnabled ?? false;
    const gitProhibitionEnabled = options?.gitProhibitionEnabled ?? true;
    // Granular git policy strategies. The config layer (KanbanProvider._getPromptsConfig)
    // owns the work-on-main defaults for built-in code roles; `undefined` here means
    // "emit no clause for this dimension" — buildGitPolicyBlock treats `undefined` and
    // `'notSpecified'` identically. Non-code roles receive `'notSpecified'` from the
    // config maps, so only the guardrail clause fires for them.
    const gitBranchStrategy = options?.gitBranchStrategy;
    const gitCommitStrategy = options?.gitCommitStrategy;
    const gitPushStrategy = options?.gitPushStrategy;
    const switchboardSafeguardsEnabled = options?.switchboardSafeguardsEnabled ?? true;
    const clearAntigravityContext = options?.clearAntigravityContext ?? false;
    const skipCompilation = options?.skipCompilation ?? false;
    const skipTests = options?.skipTests ?? false;
    const adviseResearchIfUnsure = options?.adviseResearchIfUnsure ?? true;
    const writeFeatureDescriptionIfEmpty = options?.writeFeatureDescriptionIfEmpty ?? true;
    const suppressWalkthroughEnabled = options?.suppressWalkthroughEnabled ?? false;
    const cavemanOutputEnabled = options?.cavemanOutputEnabled ?? false;
    const useSubagentsEnabled = options?.useSubagentsEnabled ?? false;
    const noSubagentsEnabled = options?.noSubagentsEnabled ?? false;
    const customSubagentName = options?.customSubagentName?.replace(/[^a-zA-Z0-9_]/g, '').trim() || undefined;
    const useWorktreesPerPlanEnabled = options?.useWorktreesPerPlanEnabled ?? false;
    const featureDocLink = options?.featureDocLink;

    let subagentBlock = '';
    if (noSubagentsEnabled) {
        subagentBlock = NO_SUBAGENTS_DIRECTIVE;
    } else if (customSubagentName) {
        subagentBlock = CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE(customSubagentName);
        if (plans.length > 1) {
            subagentBlock += '\n\n' + `If your platform supports parallel sub-agents, dispatch one "${customSubagentName}" sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
        }
    } else if (plans.length > 1 && useSubagentsEnabled) {
        subagentBlock = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
    }

    if (useWorktreesPerPlanEnabled) {
        subagentBlock = subagentBlock ? subagentBlock + '\n\n' + WORKTREES_PER_PLAN_DIRECTIVE : WORKTREES_PER_PLAN_DIRECTIVE;
    }

    const batchExecutionRules = BATCH_EXECUTION_RULES;
    const inlineChallengeDirective = INLINE_CHALLENGE_DIRECTIVE;
    const challengeBlock = includeInlineChallenge ? inlineChallengeDirective : '';
    const antigravityBlock = clearAntigravityContext
        ? 'Ignore any previous checkpoint summaries or context carried over from prior agent sessions. Do NOT ignore workspace-level context such as AGENTS.md, existing code conventions, or project configuration.'
        : '';
    const skipBlock = [
        skipCompilation ? SKIP_COMPILATION_DIRECTIVE : '',
        skipTests ? SKIP_TESTS_DIRECTIVE : '',
    ].filter(Boolean).join('\n\n');
    const dispatchContext = buildPromptDispatchContext(plans);
    let planList = dispatchContext.planList;
    let dispatchContextBlock = dispatchContext.dispatchContextBlock;
    // §1 — Build a shared worktree block from deduped plan worktree paths.
    // Replaces the four per-branch safetySessionBlock loops with one shared
    // line emitted via dispatchPrefixCore so every role gets it identically.
    const worktreePaths = [...new Set(plans.map(p => p.worktreePath).filter((p): p is string => !!p))];
    // §Git — worktree-active signal for buildGitPolicyBlock. Derived from the per-plan
    // aggregation above (NOT options.worktreePath, which KanbanProvider.resolvedOptions
    // never sets). When any plan in the batch carries a worktree, the feature orchestration
    // directive owns branch/worktree language — buildGitPolicyBlock suppresses the Branch
    // clause globally (mixed-batch: non-worktree plans sharing a batch with worktree plans
    // is an accepted rarity).
    const worktreeActive = worktreePaths.length > 0;
    // Phone-a-Friend directive — emitted only for coder/lead/intern branches below.
    // The port is plumbed at build time (Option A) so worktree CWDs don't read the
    // port file (which lives only in the main workspace root's .switchboard/).
    const phoneAFriendBlock = (options?.phoneAFriendEnabled && options?.apiPort) ? PHONE_A_FRIEND_DIRECTIVE(options.apiPort) : '';
    // In feature mode, the per-subtask/high-low directive variants already list
    // worktree assignments — skip the generic worktree line to avoid duplication.
    const featureDirectiveListsWorktrees = options?.featureMode === true
        && (options?.featureWorktreeMode === 'per-subtask' || options?.featureWorktreeMode === 'high-low')
        && worktreePaths.length > 0;
    let worktreeBlock = '';
    if (worktreePaths.length > 0 && !featureDirectiveListsWorktrees) {
        worktreeBlock = worktreePaths
            .map(wt => `WORKTREE: You are working in a git worktree at ${wt} — an isolated sibling checkout of the main repository. Do all work inside it; the plan file paths below already point inside it.`)
            .join('\n');
    }
    // Suppress the WORKING DIRECTORY block when its path equals an emitted
    // worktree path (it is the same path stated twice today).
    if (worktreeBlock && dispatchContextBlock.startsWith('WORKING DIRECTORY:')) {
        const wdPath = dispatchContextBlock.split('\n')[0].replace('WORKING DIRECTORY:', '').trim();
        if (worktreePaths.includes(wdPath)) {
            dispatchContextBlock = '';
        }
    }
    // §11 — fold the remote-mode directive into the shared dispatch prefix so it reaches
    // every role's suffixBlock without touching each role branch individually.
    const remoteModeBlock = options?.remoteControlActive ? REMOTE_MODE_DIRECTIVE : '';
    // Per-project PRD: fold into the shared prefix so it reaches every role's
    // suffixBlock (planner, lead, coder, reviewer, tester, …) without
    // touching each role branch — same pattern as the §11 remote-mode block.
    const prdBlock = buildPrdReferenceBlock(options, role);
    // Activity-light OFF-switch directive — reaches every role via the shared prefix.
    const stageCompleteBlock = buildStageCompleteDirective(options?.destinationColumn);
    const dispatchPrefixCore = [dispatchContextBlock, worktreeBlock, remoteModeBlock, prdBlock, stageCompleteBlock].filter(Boolean).join('\n\n');
    const dispatchContextPrefix = dispatchPrefixCore ? `${dispatchPrefixCore}\n\n` : '';
    // §3 — Feature directive is separated from planList so it can be placed
    // before the PLANS TO PROCESS heading rather than under it.
    let featureDirectiveBlock = '';
    if (options?.featureMode && options?.featureTopic) {
        // hasOwnWorktree distinguishes a subtask's OWN dedicated worktree (set by
        // expandFeatureSubtaskPlans only when a subtask_plan_id-bound row exists) from an
        // inherited feature-level/project-level worktree shared by every subtask (the
        // `none`-mode fallback, where worktreePath is set but not owned).
        const subtaskWorktrees = plans
            .filter(p => p.isSubtask && p.hasOwnWorktree && p.worktreePath)
            .map(p => ({ topic: p.topic, worktreePath: p.worktreePath as string }));
        const directive = resolveFeatureOrchestrationDirective(
            options.featureWorktreeMode,
            options.featureTopic,
            options.subtaskCount || 0,
            { subtaskWorktrees, tierWorktrees: options.tierWorktrees }
        );
        featureDirectiveBlock = directive;
        if (options?.featurePromptTemplate) {
            featureDirectiveBlock = `${options.featurePromptTemplate}\n\n${featureDirectiveBlock}`;
        }
    }

    // §3 — In feature mode, suppress batchExecutionRules (the feature directive owns
    // grouping/sequencing and says the opposite), and suppress subagentBlock +
    // WORKTREES_PER_PLAN_DIRECTIVE (the feature directive owns orchestration).
    const effectiveBatchExecutionRules = (options?.featureMode === true) ? '' : batchExecutionRules;
    const effectiveSubagentBlock = (options?.featureMode === true) ? '' : subagentBlock;

    const executionDirective = `AUTHORIZATION: These plans are pre-approved — begin implementation immediately; do not produce a separate planning document first.`;

    if (role === 'planner') {
        const workflowPath = options?.plannerWorkflowPath || DEFAULT_PLANNER_WORKFLOW;
        const gitProhibitionEnabled = options?.gitProhibitionEnabled ?? false;
        // §Git — planner is non-code-touching; strategies resolve to `undefined`/`notSpecified`
        // so only the guardrail clause can fire. Resolved here for symmetry with the outer
        // scope (the planner branch re-declares gitProhibitionEnabled with its own default).
        const gitBranchStrategy = options?.gitBranchStrategy;
        const gitCommitStrategy = options?.gitCommitStrategy;
        const gitPushStrategy = options?.gitPushStrategy;

        let workspaceTypeBlock = '';
        if (options?.workspaceRoot) {
            const { isMultiRepo, subRepoNames } = detectWorkspaceType(options.workspaceRoot);
            if (isMultiRepo) {
                workspaceTypeBlock = `WORKSPACE TYPE: This workspace is multi-repo. Valid sub-repo folder names are: ${subRepoNames.join(', ')}. Set **Repo:** to the appropriate sub-repo folder name.`;
            } else {
                workspaceTypeBlock = `WORKSPACE TYPE: This workspace is single-repo. Do NOT include a **Repo:** line in the plan metadata.`;
            }
        }

        // Build default base instructions
        let plannerBase = '';
        if (options?.workflowFilePathEnabled !== false) {
            plannerBase = `Read ${workflowPath} and follow it step-by-step.\n\n`;
        }

        if (options?.routingMapConfig) {
            plannerBase += `ROUTING MAP CONFIGURATION:\nThe user has configured the following custom routing map for complexity scores. When recommending an agent at the end of the plan, you MUST use these exact thresholds instead of any default thresholds:\n- Intern: Complexity ${options.routingMapConfig.intern.join(', ')}\n- Coder: Complexity ${options.routingMapConfig.coder.join(', ')}\n- Lead Coder: Complexity ${options.routingMapConfig.lead.join(', ')}\n\n`;
        }

        // Include batch execution rules for multi-plan dispatches (§3: suppressed in feature mode)
        if (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules) {
            plannerBase += `${effectiveBatchExecutionRules}\n\n`;
        }

        if (aggressivePairProgramming) {
            plannerBase += '\n\n' + AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE;
        }

        if (skipCompilation) {
            plannerBase += '\n\n' + SKIP_COMPILATION_DIRECTIVE;
        }
        if (skipTests) {
            plannerBase += '\n\n' + SKIP_TESTS_DIRECTIVE;
        }
        if (adviseResearchIfUnsure) {
            plannerBase += '\n\n' + ADVISE_RESEARCH_DIRECTIVE;
        }
        if (writeFeatureDescriptionIfEmpty && options?.featureMode) {
            plannerBase += '\n\n' + WRITE_FEATURE_DESCRIPTION_IF_EMPTY_DIRECTIVE;
        }
        if (cavemanOutputEnabled) {
            plannerBase += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE + '\nNote: Caveman style applies to reasoning and discussion only. Preserve the theatrical Grumpy Architect voice defined in the workflow for adversarial critique sections. The generated plan artifact (.md file) must remain fully detailed, well-structured, and complete.';
        }
        if (workspaceTypeBlock) {
            plannerBase += '\n\n' + workspaceTypeBlock;
        }

        const baseInstructions = resolveBaseInstructions('planner', plannerBase, options);

        let plannerPrompt = baseInstructions;

        // Add dispatch context and plan list
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        const suffixBlock = assembleSuffix('planner', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock: effectiveSubagentBlock
        });

        if (suffixBlock) {
            plannerPrompt += '\n\n' + suffixBlock;
        }

        if (featureDirectiveBlock) {
            plannerPrompt += `\n\n${featureDirectiveBlock}`;
        }
        plannerPrompt += `\n\nPLANS TO PROCESS:\n${planList}`;

        // `high-low` mode: additive consolidation pass, injected only for the planner role
        // dispatched against a high-low-mode feature with subtask plans to consolidate. No-op
        // for 'none'/'per-subtask' modes and for non-feature dispatches (subtaskPlansForConsolidation
        // is only populated by the caller for this exact case).
        if (options?.featureWorktreeMode === 'high-low' && options?.featureTopic && options?.featurePlanId
            && options.subtaskPlansForConsolidation && options.subtaskPlansForConsolidation.length > 0) {
            plannerPrompt += '\n\n' + PLANNER_HIGH_LOW_CONSOLIDATION_DIRECTIVE(options.featureTopic, options.featurePlanId, options.subtaskPlansForConsolidation);
        }

        const constitutionContent = options?.constitutionContent?.trim();
        if (constitutionContent) {
            plannerPrompt += `\n\nPROJECT CONSTITUTION:\nThe following are inviolate rules and invariants for this project:\n\n${constitutionContent}`;
        }

        const designSystemDocLink = options?.designSystemDocLink?.trim();
        if (designSystemDocLink) {
            plannerPrompt += `\n\nPROJECT PRD REFERENCE:\nThe following project PRD provides the product requirements and design specifications. Use it as context for implementation decisions:\n${designSystemDocLink}`;
        }

        const designSystemDocContent = options?.designSystemDocContent?.trim();
        if (designSystemDocContent) {
            plannerPrompt += `\n\nPROJECT PRD REFERENCE (pre-fetched):\nThe following is the full content of the project's PRD. Use it as context for implementation decisions:\n\n${designSystemDocContent}`;
        }

        return normalizeNewlines(plannerPrompt);
    }

    if (role === 'reviewer') {
        const DEFAULT_REVIEWER_BASE_INSTRUCTIONS = `For each plan:
1. Use the plan file as the source of truth for the review criteria.
2. Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
3. Stage 2 (Balanced): synthesize Stage 1 into actionable fixes — what to keep, what to fix now, what can defer.
4. Apply code fixes for valid CRITICAL/MAJOR findings.
5. Run verification checks (typecheck/tests as applicable) and include results, unless specified otherwise in this prompt.
6. Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps.
7. End with a brief structured summary: list findings by severity with file:line references, fixes applied, and remaining risks. No prose re-encapsulation of what Stage 2 already covered.

CRITICAL: Do not stop after Stage 1. Complete the Grumpy review, the Balanced synthesis, the code fixes, and the plan update all in one continuous response.`;

        const planTarget = plans.length <= 1 ? 'this plan' : 'each listed plan';
        // §7 — Merged reviewer framing: intro + short directive in one block.
        const reviewerExecutionBlock = `${buildReviewerExecutionIntro(plans.length)} Do not start any auxiliary workflow — assess the actual code changes against the plan requirements inline, fix valid material issues, then verify.`;
        const advancedReviewerBlock = advancedReviewerEnabled ? ADVANCED_REVIEWER_DIRECTIVE : '';
        // §3/§4 — Gate batch rules on actual batches; suppress in feature mode.
        const safeguardsBlock = (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules)
            ? `${effectiveBatchExecutionRules}`
            : '';

        // WARNING: The string replacements below are coupled to the exact text of
        // DEFAULT_REVIEWER_BASE_INSTRUCTIONS. If that text changes, these replacements
        // will silently fail. Update them in tandem.
        let reviewerBaseInstructions = DEFAULT_REVIEWER_BASE_INSTRUCTIONS;
        if (reviewerConciseModeEnabled) {
            reviewerBaseInstructions = reviewerBaseInstructions
                .replace('in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical)', 'in a dramatic "Grumpy Principal Engineer" voice — brief theatrical intro welcome, then keep each finding to one terse bullet');
        }
        if (reviewerCompactPlanUpdateEnabled) {
            reviewerBaseInstructions = reviewerBaseInstructions
                .replace(
                    /Update the original plan file with fixed items, files changed, validation results, and remaining risks\. Do NOT truncate, summarize, or delete existing implementation steps\./,
                    'Update the original plan file by appending a brief summary (≤ 5 sentences) under `## Review Findings` — list files changed, validation results, and remaining risks. Do NOT reproduce the full implementation steps or copy large blocks of the original plan.'
                );
        } else if (reviewerConciseModeEnabled) {
            reviewerBaseInstructions = reviewerBaseInstructions
                .replace('Do NOT truncate, summarize, or delete existing implementation steps.', 'You may keep both review stages internally but compress the final output: Stage 2 should be a single tight paragraph, not a lengthy essay.');
        }

        if (reviewerConciseModeEnabled) {
            reviewerBaseInstructions += '\n\nOVERRIDE: When Concise Review Mode is active, the persona rule "Explain why something is a problem" is modified: give a one-sentence reason per finding instead of explanatory prose. Theatrical tone is welcome; verbosity is not.';
        }

        let baseInstructions = resolveBaseInstructions('reviewer', reviewerBaseInstructions, options);
        if (cavemanOutputEnabled) {
            if (reviewerConciseModeEnabled) {
                baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE + '\nNote: Caveman style applies to code-fix and verification steps only; review stages use Concise Mode.';
            } else {
                baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
            }
        }

        // §1 — safetySessionBlock loop deleted; worktree info now in shared dispatchPrefixCore.

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        const suffixBlock = assembleSuffix('reviewer', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock: effectiveSubagentBlock
        });

        const promptParts = [
            reviewerExecutionBlock,
            safeguardsBlock,
            advancedReviewerBlock,
            baseInstructions,
            suffixBlock,
            featureDirectiveBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'tester') {
        const planTarget = plans.length <= 1 ? 'this plan' : 'each listed plan';
        // §3/§4 — Gate batch rules on actual batches; suppress in feature mode.
        const safeguardsBlock = (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules)
            ? `${effectiveBatchExecutionRules}`
            : '';

        const testerBase = `Mode:
- You are the Product Acceptance / Intent Reviewer for this task.
- Do not start any auxiliary workflow; execute this task directly.
- The reviewer already checked code-vs-plan; you check code-vs-intent.
- Treat the PRD as the primary intent baseline, the constitution as inviolate invariants, and the plan as the implementation record (not the yardstick).
- For ${planTarget}, judge whether the change delivers the product intent and the spirit of the plan, as experienced by the end user — not whether it matches the plan line-by-line.
- Flag both directions: requirements/intent not met, and code that satisfies the plan's letter but misses the product's intent.
- Permit implementation deviations from the plan that still satisfy intent (do not "fix" these); before accepting a deviation as intent-satisfying, verify it still meets the plan's stated acceptance criteria. Fix only genuine intent/requirement gaps; then verify.
- If the PRD and constitution conflict, the constitution's invariants take precedence; flag the conflict to the user in the review summary.

For each plan:
1. Use the PRD, constitution, and plan file to assess intent conformance and acceptance criteria.
2. Identify any missing, incomplete, or incorrect implementation of product requirements.
3. Apply code fixes for valid requirement gaps.
4. Run verification checks as applicable and include results.
5. Update the original plan with files changed, validation results, and remaining requirement gaps.`;

        let baseInstructions = resolveBaseInstructions('tester', testerBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        const intro = plans.length <= 1
            ? 'The implementation for this plan passed code review. Execute a direct product acceptance / intent review against the product requirements document in-place.'
            : `The implementation for each of the following ${plans.length} plans passed code review. Execute a direct product acceptance / intent review against the product requirements document in-place for each plan.`;

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        const suffixBlock = assembleSuffix('tester', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock: effectiveSubagentBlock
        });

        // Precedence-ordered acceptance-baseline block builder
        const blocks: string[] = [];

        if (options?.prdReferences && options.prdReferences.length > 0) {
            for (const r of options.prdReferences) {
                blocks.push(`PRODUCT REQUIREMENTS (PRD) — project "${r.projectName}" — primary acceptance baseline:\nRead ${r.prdLink.trim()} and accept against it.`);
            }
        }

        if (options?.constitutionContent) {
            blocks.push(`PROJECT CONSTITUTION — inviolate invariants:\n\n${options.constitutionContent.trim()}`);
        } else if (options?.constitutionLink) {
            blocks.push(`PROJECT CONSTITUTION — inviolate invariants:\n${options.constitutionLink.trim()}`);
        }

        const acceptanceBaselineBlock = blocks.join('\n\n');

        const promptParts = [
            intro,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            featureDirectiveBlock,
            `PLANS TO PROCESS:\n${planList}`,
            acceptanceBaselineBlock
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'lead') {
        // §3/§4 — Gate batch rules on actual batches; suppress in feature mode.
        const batchRulesForLead = (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules)
            ? `${effectiveBatchExecutionRules}\n\n${challengeBlock}`.trim()
            : challengeBlock.trim();

        let leadBase = '';
        if (pairProgrammingEnabled) {
            leadBase += `Note: A Coder agent is concurrently handling the Routine tasks for these plans. You only need to do Complex (Band B) work. IMPORTANT: The Coder has JUST started and will NOT be finished yet — do NOT attempt to check or read their work at the start. Begin your Complex implementation immediately. Only check and integrate the Coder's Routine work as a final step before declaring completion, by which time they will have finished.`;
            if (aggressivePairProgramming) {
                leadBase += `\n\nRoutine scope has been expanded in aggressive pair programming mode. During your final integration check, pay extra attention to any Routine changes that touch files you also modified.`;
            }
        }

        let baseInstructions = resolveBaseInstructions('lead', leadBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        // §1 — safetySessionBlock loop deleted; worktree info now in shared dispatchPrefixCore.

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        const suffixBlock = assembleSuffix('lead', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock: effectiveSubagentBlock
        });

        const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
        const promptParts = [
            buildExecutionIntro('execute', plans, options?.featureMode),
            executionDirective,
            batchRulesForLead,
            baseInstructions,
            suffixBlock,
            featureDirectiveBlock,
            `PLANS TO PROCESS:\n${planList}`,
            phoneAFriendBlock,
            suppressWalkthroughBlock
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'coder') {
        // §10 — Feature-mode coder dispatch: single feature-file reference instead of
        // per-subtask enumeration. The feature file's auto-generated SUBTASKS block
        // already lists every subtask plan link, and its WORKTREES block lists
        // per-subtask/per-tier worktree assignments — the prompt's per-subtask
        // enumeration is pure duplication.
        if (options?.featureMode) {
            const featurePlan = plans.find(p => !p.isSubtask);
            const featureFilePath = featurePlan?.absolutePath || '';
            const featureFileBlock = featureFilePath
                ? `FEATURE FILE:\n${featureFilePath}\n\nRead the feature file above. Its Subtasks section lists all subtask plan files (relative paths resolve inside this worktree). Its Worktrees section lists any per-subtask or per-tier worktree assignments. Execute each subtask plan in full.`
                : '';
            const featureExecutionBlock = `EXECUTION MODE: The feature below is pre-approved — begin implementation immediately; do not produce a separate planning document. Execute each subtask plan in full before moving to the next; if a subtask hits an issue, report it clearly and continue with the remaining subtasks when safe. All subtasks are one delivery unit.`;

            let coderBase = '';
            if (pairProgrammingEnabled) {
                coderBase += `Additional Instructions: only do Routine (Band A) work.`;
            }

            let baseInstructions = resolveBaseInstructions('coder', coderBase, options);
            if (cavemanOutputEnabled) {
                baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
            }

            // §10 — No FOCUS (single file path, no ambiguity), no batch rules,
            // no subagent block, no feature directive (replaced by featureExecutionBlock).
            // gitBlock still included via assembleSuffix.
            const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
            const suffixBlock = assembleSuffix('coder', {
                dispatchContextPrefix, gitBlock, antigravityBlock, skipBlock
            });

            const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
            const promptParts = [
                buildExecutionIntro('execute', plans, options?.featureMode),
                featureExecutionBlock,
                baseInstructions,
                suffixBlock,
                featureFileBlock,
                phoneAFriendBlock,
                suppressWalkthroughBlock
            ].filter(Boolean).join('\n\n');

            const coderPrompt = withCoderAccuracyInstruction(normalizeNewlines(promptParts), accurateCodingEnabled);
            return normalizeNewlines(coderPrompt);
        }

        // Non-feature coder dispatch — standard per-plan enumeration path.
        const intro = buildExecutionIntro('execute', plans, options?.featureMode);
        // §3/§4 — Gate batch rules on actual batches; suppress in feature mode (handled above).
        const safeguardsBlock = (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules)
            ? `${effectiveBatchExecutionRules}\n\n${challengeBlock}`.trim()
            : challengeBlock.trim();

        let coderBase = '';
        if (pairProgrammingEnabled) {
            coderBase += `Additional Instructions: only do Routine (Band A) work.`;
        }

        let baseInstructions = resolveBaseInstructions('coder', coderBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        // §1 — safetySessionBlock loop deleted; worktree info now in shared dispatchPrefixCore.

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        const suffixBlock = assembleSuffix('coder', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock: effectiveSubagentBlock
        });

        const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
        const promptParts = [
            intro,
            executionDirective,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            featureDirectiveBlock,
            `PLANS TO PROCESS:\n${planList}`,
            phoneAFriendBlock,
            suppressWalkthroughBlock
        ].filter(Boolean).join('\n\n');

        const coderPrompt = withCoderAccuracyInstruction(normalizeNewlines(promptParts), accurateCodingEnabled);
        return normalizeNewlines(coderPrompt);
    }

    if (role === 'intern') {
        let internBase = '';
        if (pairProgrammingEnabled) {
            internBase += `Additional Instructions: only do Routine (Band A) work.`;
        }

        let baseInstructions = resolveBaseInstructions('intern', internBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        // §1 — safetySessionBlock loop deleted; worktree info now in shared dispatchPrefixCore.

        // §3/§4 — Gate batch rules on actual batches; suppress in feature mode.
        const safeguardsBlock = (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules)
            ? effectiveBatchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        const suffixBlock = assembleSuffix('intern', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock: effectiveSubagentBlock
        });

        const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
        const promptParts = [
            buildExecutionIntro('process', plans, options?.featureMode),
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            featureDirectiveBlock,
            `PLANS TO PROCESS:\n${planList}`,
            phoneAFriendBlock,
            suppressWalkthroughBlock
        ].filter(Boolean).join('\n\n');

        const internPrompt = withCoderAccuracyInstruction(normalizeNewlines(promptParts), accurateCodingEnabled);
        return normalizeNewlines(internPrompt);
    }

    if (role === 'analyst') {
        let baseInstructions = resolveBaseInstructions('analyst', '', options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        // §3/§4 — Gate batch rules on actual batches; suppress in feature mode.
        const safeguardsBlock = (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules)
            ? effectiveBatchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        // §6 — analyst is NOT code-touching; gitBlock excluded by assembleSuffix.
        const suffixBlock = assembleSuffix('analyst', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock: effectiveSubagentBlock
        });

        const promptParts = [
            buildExecutionIntro('process', plans, options?.featureMode),
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            featureDirectiveBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'ticket_updater') {
        // The role used to carry a 4-mode selector (disabled/comment-only/refine-ticket/
        // research-and-refine). It is collapsed to a single triage-only behavior. The
        // stored ticketUpdateMode config key is still read (so old configs don't error)
        // but its value is ignored — see the one-time migration warning emitted by
        // warnOnLegacyTicketUpdateMode().
        warnOnLegacyTicketUpdateMode(options?.ticketUpdateMode);

        const updaterBase = `You are a Ticket Triager Agent.

You read ONE imported ticket (its title, description, and any captured comments in the plan
file) and post a single short triage verdict back to the source ticket as a comment.

Resolve the provider ticket ID from the plan metadata: the "**ClickUp Task ID:**" line
(ClickUp), the "**Linear Issue ID:**" line (Linear), or the "**Notion Page ID:**" line
(Notion). Use that ID — not the legacy "**Ticket:**" field. If none is present, skip posting
and notify the user.

Post the verdict as a comment using the clickup_api skill (ClickUp), the linear_api skill
(Linear), or the notion_api skill (Notion). These post through the Switchboard local API
bridge — never call the provider API directly and never touch tokens. NEVER overwrite the
ticket description — comment only.

Your verdict MUST be a single short comment, target ≤ 120 words, in exactly this shape:

**Severity:** blocker / high / normal / low
**Area:** one or two tags
**Assessment:** 1–2 sentence root-cause hypothesis or restatement of the real problem
**Recommended action:** the concrete next step
**Routing:** auto (simple enough to action directly) OR needs-human (complex/ambiguous/
cross-cutting → move to the planning.html Tickets tab)

Rules: no preamble, no restating the whole ticket, no markdown section dumps beyond the five
fields above, no speculative implementation detail. Comment only.`;

        let baseInstructions = resolveBaseInstructions('ticket_updater', updaterBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        // §3/§4 — Gate batch rules on actual batches; suppress in feature mode.
        const safeguardsBlock = (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules)
            ? effectiveBatchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        // §6 — ticket_updater is NOT code-touching; gitBlock excluded by assembleSuffix.
        const suffixBlock = assembleSuffix('ticket_updater', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock: effectiveSubagentBlock
        });

        const promptParts = [
            baseInstructions,
            safeguardsBlock,
            suffixBlock,
            featureDirectiveBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'researcher') {
        const researchDepth = options?.researchDepth || 'deep';

        const depthLabels: Record<string, string> = {
            quick: 'Quick (5-10 sources)',
            standard: 'Standard (15-30 sources)',
            deep: 'Deep (50-100+ sources)',
            academic: 'Academic (100-200+ sources)'
        };
        const label = depthLabels[researchDepth] || researchDepth;

        // Parameterize the research directive with the selected depth
        const customDeepDirective = DEEP_RESEARCH_DIRECTIVE
            .replace('depth set to "deep" (50-100 sources)', `depth set to "${researchDepth}" (${label})`)
            .replace('TARGET SOURCE COUNT: 50-100 sources', `TARGET SOURCE COUNT: ${label}`);

        let researcherBase = `You are a Researcher Agent.\n\n${customDeepDirective}`;

        // Add save-to-local-docs instruction if enabled (matches planning.html import-toggle behavior)
        const saveToLocalDocs = options?.saveToLocalDocs ?? false;
        if (saveToLocalDocs) {
            const savePath = options?.localDocsPath || '.switchboard/docs/';
            researcherBase += `\n\nIMPORTANT: After completing the research, save the results to ${savePath} using the write_to_file tool so I can review them later.`;
        }

        let baseInstructions = resolveBaseInstructions('researcher', researcherBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        // §3/§4 — Gate batch rules on actual batches; suppress in feature mode.
        const safeguardsBlock = (plans.length > 1 && switchboardSafeguardsEnabled && effectiveBatchExecutionRules)
            ? effectiveBatchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = buildGitPolicyBlock({ branch: gitBranchStrategy, commit: gitCommitStrategy, push: gitPushStrategy, guardrail: gitProhibitionEnabled, worktreeActive });
        // §6 — researcher is NOT code-touching; gitBlock excluded by assembleSuffix.
        const suffixBlock = assembleSuffix('researcher', {
            dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock: effectiveSubagentBlock
        });

        const promptParts = [
            baseInstructions,
            safeguardsBlock,
            suffixBlock,
            featureDirectiveBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'chat') {
        const chatBase = DEFAULT_CHAT_BASE_INSTRUCTIONS;
        let baseInstructions = resolveBaseInstructions('chat', chatBase, options);

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const destDirs = (options?.chatPlanDestinations && options.chatPlanDestinations.length > 0)
            ? options.chatPlanDestinations
            : ['.switchboard/plans/'];
        const planDestinationBlock = destDirs.length === 1
            ? `PLAN DESTINATION: Write the plan to \`${destDirs[0]}\` (this location only; do not also copy it to a session/brain directory).`
            : `PLAN DESTINATION: Write the plan into one of these directories (this location only; do not also copy it elsewhere):\n${destDirs.map(d => `- ${d}`).join('\n')}`;
        
        let projectPinBlock = '';
        if (options?.manifestProject) {
            projectPinBlock = PROJECT_LINE_DIRECTIVE(options.manifestProject);
        }

        const suffixBlock = [dispatchContextPrefix, focusBlock, planDestinationBlock, projectPinBlock, antigravityBlock]
            .filter(Boolean)
            .join('\n\n');

        let chatPrompt = baseInstructions;
        if (suffixBlock) {
            chatPrompt += '\n\n' + suffixBlock;
        }

        if (plans.length > 0) {
            chatPrompt += `\n\nPLANS TO DISCUSS:\n${planList}`;
        } else {
            chatPrompt += `\n\nPLANS TO DISCUSS:\nNone. General consultation.`;
        }

        return normalizeNewlines(chatPrompt);
    }

    // No fallback — every built-in role must have an explicit template.
    // Custom agents are NOT routed through this function; they use plan-file-link-only prompts built at call sites.
    throw new Error(`Unknown role '${role}' in buildKanbanBatchPrompt. Built-in roles: planner, reviewer, tester, lead, coder, intern, analyst, ticket_updater, researcher, chat. Custom agents should be handled at the call site, not here.`);
}

/**
 * Map a kanban column to the agent role that should PROCESS plans from it.
 * This is the autoban-compatible mapping used for all prompt generation.
 */
export function columnToPromptRole(column: string): string | null {
    const normalized = column === 'CODED' ? 'LEAD CODED' : column;
    switch (normalized) {
        case 'CREATED': return 'planner';
        case 'PLAN REVIEWED': return 'lead';
        case 'LEAD CODED':
        case 'CODER CODED':
        case 'INTERN CODED':
            return 'reviewer';
        case 'CODE REVIEWED':
            return 'tester';
        case 'RESEARCHER': return 'researcher';
        case 'TICKET UPDATER': return 'ticket_updater';
        default:
            return column.startsWith('custom_agent_') ? column : null;
    }
}

export function buildCustomAgentPrompt(
    plans: BatchPromptPlan[],
    promptInstructions?: string,
    addons?: CustomAgentAddons,
    workspaceRoot?: string
): string {
    const { planList, dispatchContextBlock } = buildPromptDispatchContext(plans);
    const dispatchContextPrefix = dispatchContextBlock ? `${dispatchContextBlock}\n\n` : '';

    // §Git — worktree-active signal for the custom-agent path's buildGitPolicyBlock.
    // Same derivation as buildKanbanBatchPrompt: from the per-plan aggregation, not
    // options.worktreePath. Mixed-batch suppresses the Branch clause globally.
    const customWorktreeActive = [...new Set(plans.map(p => p.worktreePath).filter((p): p is string => !!p))].length > 0;

    // Custom workflow: prepend read-workflow instruction.
    // NOTE: Built-in roles handle workflow prepend in resolveBaseInstructions.
    // If you change the workflow instruction format here, update resolveBaseInstructions too.
    if (addons?.workflowFilePathEnabled && addons?.workflowFilePath) {
        return `Read ${addons.workflowFilePath} and follow it step-by-step.\n\n` +
            buildCustomAgentPrompt(plans, promptInstructions,
                { ...addons, workflowFilePathEnabled: undefined, workflowFilePath: undefined }, workspaceRoot);
    }

    const noSubagentsEnabled = addons?.subagentPolicy === 'noSubagents';
    const customSubagentName = addons?.subagentPolicy === 'customSubagent' ? addons?.customSubagentName?.trim() : undefined;
    const useSubagentsEnabled = addons?.subagentPolicy === 'useSubagents'
        || (addons?.subagentPolicy === undefined && addons?.useSubagents === true);

    let subagentBlock = '';
    if (noSubagentsEnabled) {
        subagentBlock = NO_SUBAGENTS_DIRECTIVE;
    } else if (customSubagentName) {
        subagentBlock = CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE(customSubagentName);
        if (plans.length > 1) {
            subagentBlock += '\n\n' + `If your platform supports parallel sub-agents, dispatch one "${customSubagentName}" sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
        }
    } else if (plans.length > 1 && useSubagentsEnabled) {
        subagentBlock = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.`;
    }

    if (addons?.useWorktreesPerPlan) {
        subagentBlock = subagentBlock ? subagentBlock + '\n\n' + WORKTREES_PER_PLAN_DIRECTIVE : WORKTREES_PER_PLAN_DIRECTIVE;
    }

    // §8 — Use shared BATCH_EXECUTION_RULES constant instead of inline copy.
    const safeguardsBlock = addons?.switchboardSafeguards
        ? `${BATCH_EXECUTION_RULES}\n\n${FOCUS_DIRECTIVE}`
        : `${FOCUS_DIRECTIVE}`;

    let prompt = `${dispatchContextPrefix}${safeguardsBlock}\n\nPLANS TO PROCESS:\n${planList}`;
    if (subagentBlock) {
        prompt += '\n\n' + subagentBlock;
    }

    // Activity-light OFF-switch — custom agents get the same Stage Complete directive as
    // built-in roles so their cards clear `working` on completion, not just on timeout.
    prompt += '\n\n' + buildStageCompleteDirective(addons?.destinationColumn);

    // Apply directives in defined order
    // §Git — composed GIT POLICY block. Reads the UI keys (gitProhibition — the
    // role-config toggle persisted by the Prompts tab) plus the three granular
    // strategy fields. This also fixes the pre-existing gitProhibitionEnabled-vs-
    // gitProhibition key mismatch: the role-config toggle now actually flows into
    // the custom-agent prompt. `mergedAddons` (KanbanProvider.generateUnifiedPrompt)
    // carries these from roleConfigAddons; the agent-definition key
    // (gitProhibitionEnabled) is superseded by the UI key when both are present.
    const customGitBlock = buildGitPolicyBlock({
        branch: (addons as any)?.gitBranchStrategy,
        commit: (addons as any)?.gitCommitStrategy,
        push: (addons as any)?.gitPushStrategy,
        guardrail: (addons as any)?.gitProhibition ?? addons?.gitProhibitionEnabled,
        worktreeActive: customWorktreeActive
    });
    if (customGitBlock) prompt += '\n\n' + customGitBlock;
    if (addons?.workspaceTypeDetection && workspaceRoot) {
        const { isMultiRepo, subRepoNames } = detectWorkspaceType(workspaceRoot);
        prompt += isMultiRepo
            ? '\n\nWORKSPACE TYPE: multi-repo. Sub-repos: ' + subRepoNames.join(', ') + '.'
            : '\n\nWORKSPACE TYPE: single-repo. Do NOT include a **Repo:** line.';
    }
    if (addons?.includeInlineChallenge) prompt += `\n\n${INLINE_CHALLENGE_DIRECTIVE}`;
    if (addons?.accurateCodingEnabled) prompt += `\n\nAccuracy Mode: Before coding, read and follow .agents/workflows/accuracy.md step-by-step.`;
    if (addons?.pairProgrammingEnabled) prompt += `\n\nPAIR PROGRAMMING NOTE: Focus only on Complex / Risky (Band B) implementation steps. A separate Coder agent is handling Routine (Band A) tasks.`;
    if (addons?.aggressivePairProgramming) prompt += '\n\n' + AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE;
    if (addons?.advancedReviewerEnabled) prompt += '\n\n' + ADVANCED_REVIEWER_DIRECTIVE;

    if (addons?.ticketUpdateMode && addons.ticketUpdateMode !== 'disabled') {
        const directive = addons.ticketUpdateMode === 'refine-ticket'
            ? TICKET_REFINE_DIRECTIVE
            : addons.ticketUpdateMode === 'research-and-refine'
                ? TICKET_RESEARCH_REFINE_DIRECTIVE
                : TICKET_UPDATE_DIRECTIVE;
        prompt += `\n\n${directive}`;
    }
    if (addons?.complexityScoringSkill) {
        prompt += `\n\n${COMPLEXITY_SCORING_DIRECTIVE}`;
    }

    if (addons?.researchEnabled) prompt += `\n\n${DEEP_RESEARCH_DIRECTIVE}`;

    if (addons?.designSystemDocContent) {
        prompt += `\n\nPROJECT PRD REFERENCE (pre-fetched):\n${addons.designSystemDocContent}`;
    } else if (addons?.designSystemDocLink) {
        prompt += `\n\nPROJECT PRD REFERENCE:\n${addons.designSystemDocLink}`;
    }

    if (addons?.constitutionContent) {
        prompt += `\n\nPROJECT CONSTITUTION (pre-fetched):\n${addons.constitutionContent}`;
    } else if (addons?.constitutionLink) {
        prompt += `\n\nPROJECT CONSTITUTION:\n${addons.constitutionLink}`;
    }

    // §8 — Use shared buildPrdReferenceBlockFromRefs instead of inline copy.
    // Per-project PRD (project-context toggle) — custom agents are a separate prompt
    // path and must carry the PRD too, otherwise they silently miss it.
    const customPrdBlock = buildPrdReferenceBlockFromRefs(addons?.prdReferences);
    if (customPrdBlock) {
        prompt += `\n\n${customPrdBlock}`;
    }

    if (promptInstructions) prompt += `\n\nAdditional Instructions: ${promptInstructions}`;

    // Prompt override applied LAST
    if (addons?.defaultPromptOverride) {
        const { mode, text } = addons.defaultPromptOverride;
        if (mode === 'prepend') prompt = `${text}\n\n${prompt}`;
        else if (mode === 'append') prompt = `${prompt}\n\n${text}`;
        else if (mode === 'replace') prompt = `${text}\n\nPLANS TO PROCESS:\n${planList}`;
    }

    return normalizeNewlines(prompt);
}
