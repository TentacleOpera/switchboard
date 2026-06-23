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
    epicId?: string;
    isSubtask?: boolean;
    epicTopic?: string;
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
    /** When present, appends a Design Doc / PRD link to planner prompts. */
    designDocLink?: string;
    /** When present, the full pre-fetched Notion page content to embed verbatim. Takes precedence over designDocLink. */
    designDocContent?: string;
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
    /** When true, git prohibition directive is included in planner prompts (default: true). */
    gitProhibitionEnabled?: boolean;
    /** When true (default), include batchExecutionRules and FOCUS_DIRECTIVE. When false, omit them. */
    switchboardSafeguardsEnabled?: boolean;
    /** Optional display label of the column where the plans originated. */
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

    /** Controls ticket update behavior: disabled, comment-only, refine-ticket, or research-and-refine */
    ticketUpdateMode?: 'disabled' | 'comment-only' | 'refine-ticket' | 'research-and-refine';
    /** When false (explicitly), splitter omits the complexity-scoring step. Defaults to enabled (undefined). */
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
    /** When true, the batch includes an epic and its subtasks. */
    epicMode?: boolean;
    /** The epic's topic/title for directive injection. */
    epicTopic?: string;
    /** Number of subtasks included in the epic batch. */
    subtaskCount?: number;
    /** Max subtasks before truncation warning (default 20). */
    epicMaxSubtasks?: number;
    /** User-configured epic prompt template, injected after the epic directive. */
    epicPromptTemplate?: string;
    /** §11 — when true, the dispatched card's board is under remote control; inject REMOTE_MODE_DIRECTIVE into all role prompts. */
    remoteControlActive?: boolean;
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

function buildReviewerExecutionModeLine(expectation: string): string {
    return `Mode:
- You are the reviewer-executor for this task.
- Do not start any auxiliary workflow; execute this task directly.
- Treat adversarial review as inline analysis in this same prompt.
- ${expectation}`;
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
        if (plan.isSubtask && plan.epicTopic) {
            return `  - [SUBTASK] ${plan.topic} Plan File: ${plan.absolutePath}`;
        }
        if (plan.epicTopic && !plan.isSubtask) {
            return `- [EPIC: ${plan.epicTopic}] Plan File: ${plan.absolutePath}`;
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

export const GIT_PROHIBITION_DIRECTIVE = `GIT POLICY: Do NOT execute state-mutating git commands (commit, push, pull, fetch, merge, rebase, reset, checkout, branch, stash, cherry-pick, revert). Read-only commands (status, log, diff) are permitted. Return completed work to the parent agent or user for committing.`;
export const FOCUS_DIRECTIVE = `FOCUS DIRECTIVE: Each plan file path below is the single source of truth for that plan. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.`;

// §11 — injected for ALL roles when the dispatched card's board is under remote control.
// The user is on their phone, not the terminal, so questions must go to the linked issue
// as a comment (posted host-side through the LocalApiServer bridge via linear_api/clickup_api),
// not to terminal input.
export const REMOTE_MODE_DIRECTIVE = `REMOTE MODE: You are running under remote control — the user is NOT at the terminal. If you need to ask the user anything or report a blocker, post it as a comment on the linked issue using the linear_api skill (or clickup_api). Do NOT wait on terminal input. Continue with any work you can do without the answer.`;

export const INLINE_CHALLENGE_DIRECTIVE = `For each plan, before implementation:
- perform a concise adversarial review of that specific plan,
- list at least 2 concrete flaws/edge cases and how you'll address them,
- then execute using those corrections,
- do NOT start any auxiliary workflow for this step.`;

export const SPLIT_PLAN_DIRECTIVE = `SPLIT PLAN MODE: Produce TWO files per plan. Original file = Complex / Risky only. Companion file (\`<stem>_routine.md\`) = Routine only. Both files must include full shared context (Goal, Metadata, Current State, Edge-Case audit, Dependencies). Original file notes: "Assume Routine items implemented by Coder agent." Read the full original file before writing either output. Create both files in the same directory as the original.`;
export const SKIP_COMPILATION_DIRECTIVE = `SKIP COMPILATION: Do NOT run any project compilation step (e.g. tsc, mvn compile, gradle build, make) as part of the verification plan. The project is assumed to be in a pre-compiled or compilation-free state for this session.`;
export const SKIP_TESTS_DIRECTIVE = `SKIP TESTS: Do NOT run automated tests (unit, integration, or e2e) as part of the verification plan. The test suite will be run separately by the user.`;
export const CAVEMAN_OUTPUT_DIRECTIVE = `CAVEMAN MODE: Talk like caveman. Drop filler, keep substance. Use fragments. Technical terms exact. Code unchanged. Pattern: [thing] [action] [reason]. [next step].`;
export const SUPPRESS_WALKTHROUGH_DIRECTIVE = `SUPPRESS WALKTHROUGH: Do NOT generate a walkthrough.md artifact at the end of this task. Omit the walkthrough creation step entirely.`;

export const NO_SUBAGENTS_DIRECTIVE = "SUBAGENT POLICY: You are strictly forbidden from spawning or invoking any subagents. Handle all tasks yourself.";
export const CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE = (name: string) =>
    `SUBAGENT POLICY: You are authorized to use the "${name}" subagent for this task. Do not spawn or invoke any other subagents.`;
export const WORKTREES_PER_PLAN_DIRECTIVE = 'Where possible, process each plan as an isolated unit using your native subagent or orchestration capabilities, creating a dedicated git worktree per plan to prevent file conflicts between concurrent tasks.';

export const EPIC_ORCHESTRATION_DIRECTIVE = (epicTopic: string, count: number) =>
    `EPIC MODE: You are implementing the epic "${epicTopic}" which consists of ${count} subtask(s).\n` +
    `Use your native subagent or orchestration capabilities to handle each subtask. ` +
    `If your tool supports worktree-per-plan isolation, activate it now. ` +
    `If you do not support subagents, handle each subtask sequentially in the order listed below. ` +
    `All subtasks are part of a single delivery unit — do not treat them as independent tickets.`;

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
5. **Plan artifact & quality gate.** Write the plan to one of the paths listed in the PLAN DESTINATION directive below (configured by the user in Switchboard Setup), using a unique filename — only those locations; do not write or copy the plan anywhere else, including any session/brain directory. Every plan must have a descriptive H1 title (never generic), and a \`## Metadata\` section with \`**Complexity:**\` (1–10) and \`**Tags:**\` (comma-separated, from: frontend, backend, auth, database, api, ui, ux, bugfix, feature, refactor, test, docs, security, performance, reliability, mobile, devops, infrastructure, cli, library).
6. **No self-editing of system files.** If workflow configurations or persona files need changes, notify the user and ask for explicit permission.
7. **Stay in chat.** Do not pivot to execution or delegation unless the user explicitly requests it.

Process:
1. **Onboard:** Greet the user. Identify the core problem or opportunity. Focus on ideation.
2. **Iterate:** Ask "Why" before "How." Challenge assumptions. Document requirements, edge cases, and risks the user may have missed.
3. **Plan:** When the "What" and "Why" are clear, draft the implementation plan.
4. **Gate:** Only suggest moving forward once the plan is complete and the user has explicitly approved it.`;

const DEFAULT_PLANNER_WORKFLOW = '.agents/workflows/improve-plan.md';

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
    const baseInstruction = options?.instruction;
    const includeInlineChallenge = options?.includeInlineChallenge ?? false;
    const accurateCodingEnabled = options?.accurateCodingEnabled ?? false;
    const pairProgrammingEnabled = options?.pairProgrammingEnabled ?? false;
    const aggressivePairProgramming = options?.aggressivePairProgramming ?? false;
    const advancedReviewerEnabled = options?.advancedReviewerEnabled ?? false;
    const reviewerConciseModeEnabled = options?.reviewerConciseModeEnabled ?? false;
    const reviewerCompactPlanUpdateEnabled = options?.reviewerCompactPlanUpdateEnabled ?? false;
    const gitProhibitionEnabled = options?.gitProhibitionEnabled ?? true;
    const switchboardSafeguardsEnabled = options?.switchboardSafeguardsEnabled ?? true;
    const sourceColumnLabel = options?.sourceColumnLabel;
    const clearAntigravityContext = options?.clearAntigravityContext ?? false;
    const skipCompilation = options?.skipCompilation ?? false;
    const skipTests = options?.skipTests ?? false;
    const suppressWalkthroughEnabled = options?.suppressWalkthroughEnabled ?? false;
    const cavemanOutputEnabled = options?.cavemanOutputEnabled ?? false;
    const useSubagentsEnabled = options?.useSubagentsEnabled ?? false;
    const noSubagentsEnabled = options?.noSubagentsEnabled ?? false;
    const customSubagentName = options?.customSubagentName?.replace(/[^a-zA-Z0-9_]/g, '').trim() || undefined;
    const useWorktreesPerPlanEnabled = options?.useWorktreesPerPlanEnabled ?? false;

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

    const batchExecutionRules = `CRITICAL INSTRUCTIONS:
1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans.
2. Execute each plan fully before moving to the next (if sequential).
3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so.`;
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
    const dispatchContextBlock = dispatchContext.dispatchContextBlock;
    // §11 — fold the remote-mode directive into the shared dispatch prefix so it reaches
    // every role's suffixBlock without touching each role branch individually.
    const remoteModeBlock = options?.remoteControlActive ? REMOTE_MODE_DIRECTIVE : '';
    const dispatchPrefixCore = [dispatchContextBlock, remoteModeBlock].filter(Boolean).join('\n\n');
    const dispatchContextPrefix = dispatchPrefixCore ? `${dispatchPrefixCore}\n\n` : '';
    if (options?.epicMode && options?.epicTopic) {
        planList = `${EPIC_ORCHESTRATION_DIRECTIVE(options.epicTopic, options.subtaskCount || 0)}\n\n${planList}`;
        if (options?.epicPromptTemplate) {
            planList = `${options.epicPromptTemplate}\n\n${planList}`;
        }
    }

    const executionDirective = `AUTHORIZATION TO EXECUTE: The plans provided are already authorized. You MUST enter EXECUTION mode immediately. Do NOT enter PLANNING mode or generate an implementation_plan.md. Proceed directly to implementing the changes.`;

    if (role === 'planner') {
        const workflowPath = options?.plannerWorkflowPath || DEFAULT_PLANNER_WORKFLOW;
        const gitProhibitionEnabled = options?.gitProhibitionEnabled ?? false;

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

        // Include batch execution rules for multi-plan dispatches
        if (plans.length > 1 && switchboardSafeguardsEnabled) {
            plannerBase += `${batchExecutionRules}\n\n`;
        }

        const designDocLink = options?.designDocLink?.trim();
        if (designDocLink) {
            plannerBase += `PLANNING EPIC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as foundational context for all planning decisions:\n${designDocLink}\n\n`;
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
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        if (suffixBlock) {
            plannerPrompt += '\n\n' + suffixBlock;
        }

        plannerPrompt += `\n\nPLANS TO PROCESS:\n${planList}`;

        // Append design doc content (pre-fetched Notion)
        const designDocContent = options?.designDocContent?.trim();
        if (designDocContent) {
            plannerPrompt += `\n\nPLANNING EPIC REFERENCE (pre-fetched from Notion):\nThe following is the full content of the project's design document / PRD. Use it as foundational context for all planning decisions:\n\n${designDocContent}`;
        }

        const constitutionContent = options?.constitutionContent?.trim();
        if (constitutionContent) {
            plannerPrompt += `\n\nPROJECT CONSTITUTION:\nThe following are inviolate rules and invariants for this project:\n\n${constitutionContent}`;
        }

        const designSystemDocLink = options?.designSystemDocLink?.trim();
        if (designSystemDocLink) {
            plannerPrompt += `\n\nDESIGN SYSTEM DOC REFERENCE:\nThe following design system document provides the project's visual and interaction design specifications. Use it as context for implementation decisions:\n${designSystemDocLink}`;
        }

        const designSystemDocContent = options?.designSystemDocContent?.trim();
        if (designSystemDocContent) {
            plannerPrompt += `\n\nDESIGN SYSTEM DOC REFERENCE (pre-fetched):\nThe following is the full content of the project's design system document. Use it as context for implementation decisions:\n\n${designSystemDocContent}`;
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
        const reviewerExecutionIntro = buildReviewerExecutionIntro(plans.length);
        const reviewerExecutionMode = buildReviewerExecutionModeLine(`For ${planTarget}, assess the actual code changes against the plan requirements, fix valid material issues in code when needed, then verify.`);
        const advancedReviewerBlock = advancedReviewerEnabled ? ADVANCED_REVIEWER_DIRECTIVE : '';
        const safeguardsBlock = switchboardSafeguardsEnabled
            ? `${batchExecutionRules}`
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

        let safetySessionBlock = '';
        for (const plan of plans) {
            if (plan.worktreePath) {
                safetySessionBlock += `\nIMPORTANT: You are reviewing work done in a safety session. The worktree directory is: ${plan.worktreePath}\n` +
                    `Read the plan file and code changes from that location (not the main directory).\n`;
            }
        }
        if (safetySessionBlock) {
            baseInstructions += '\n\n' + safetySessionBlock.trim();
        }



        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            reviewerExecutionIntro,
            safeguardsBlock,
            reviewerExecutionMode,
            advancedReviewerBlock,
            baseInstructions,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'tester') {
        const planTarget = plans.length <= 1 ? 'this plan' : 'each listed plan';
        const designDocContent = options?.designDocContent?.trim();
        const designDocLink = options?.designDocLink?.trim();
        const safeguardsBlock = switchboardSafeguardsEnabled
            ? `${batchExecutionRules}`
            : '';

        const testerBase = `Mode:
- You are the acceptance-tester-executor for this task.
- Do not start any auxiliary workflow; execute this task directly.
- Use the attached Design Doc / PRD as the authoritative requirements baseline.
- For ${planTarget}, assess the actual code changes against the product requirements, fix material requirement gaps in code when needed, then verify.

For each plan:
1. Use the plan file and Design Doc / PRD as the source of truth for acceptance criteria.
2. Identify any missing, incomplete, or incorrect implementation of product requirements.
3. Apply code fixes for valid requirement gaps.
4. Run verification checks as applicable and include results.
5. Update the original plan with files changed, validation results, and remaining requirement gaps.`;

        let baseInstructions = resolveBaseInstructions('tester', testerBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        const intro = plans.length <= 1
            ? 'The implementation for this plan passed code review. Execute a direct acceptance test against the product requirements document in-place.'
            : `The implementation for each of the following ${plans.length} plans passed code review. Execute a direct acceptance test against the product requirements document in-place for each plan.`;

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        let designDocBlock = '';
        if (designDocContent) {
            designDocBlock = `PLANNING EPIC REFERENCE (pre-fetched from Notion):\nThe following is the full content of the project's design document / PRD. Use it as the authoritative requirements baseline for acceptance testing:\n\n${designDocContent}`;
        } else if (designDocLink) {
            designDocBlock = `PLANNING EPIC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as the authoritative requirements baseline for acceptance testing:\n${designDocLink}`;
        }

        const promptParts = [
            intro,
            executionDirective,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`,
            designDocBlock
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'lead') {
        const safeguardsBlock = switchboardSafeguardsEnabled
            ? `${batchExecutionRules}\n\n${challengeBlock}`.trim()
            : challengeBlock.trim();
        const sourceSuffix = sourceColumnLabel ? ` from the ${sourceColumnLabel} column` : '';

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

        let safetySessionBlock = '';
        for (const plan of plans) {
            if (plan.worktreePath) {
                safetySessionBlock += `\nIMPORTANT: You are working in a safety session. All file operations and git commands\n` +
                    `must be run from inside the worktree directory: ${plan.worktreePath}\n` +
                    `Navigate into this directory before making any changes. Do NOT run git commands\n` +
                    `from the parent directory — that is the main branch and will corrupt it.\n`;
            }
        }
        if (safetySessionBlock) {
            baseInstructions += '\n\n' + safetySessionBlock.trim();
        }

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
        const promptParts = [
            `Please execute the following ${plans.length} plans${sourceSuffix}.`,
            executionDirective,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`,
            suppressWalkthroughBlock
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'coder') {
        const sourceSuffix = sourceColumnLabel ? ` from the ${sourceColumnLabel} column` : '';
        const intro = baseInstruction === 'low-complexity'
            ? `Please execute the following ${plans.length} low-complexity plans${sourceSuffix}.`
            : `Please execute the following ${plans.length} plans${sourceSuffix}.`;
        const safeguardsBlock = switchboardSafeguardsEnabled
            ? `${batchExecutionRules}\n\n${challengeBlock}`.trim()
            : challengeBlock.trim();

        let coderBase = '';
        if (pairProgrammingEnabled) {
            coderBase += `Additional Instructions: only do Routine (Band A) work.`;
        }

        let baseInstructions = resolveBaseInstructions('coder', coderBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        let safetySessionBlock = '';
        for (const plan of plans) {
            if (plan.worktreePath) {
                safetySessionBlock += `\nIMPORTANT: You are working in a safety session. All file operations and git commands\n` +
                    `must be run from inside the worktree directory: ${plan.worktreePath}\n` +
                    `Navigate into this directory before making any changes. Do NOT run git commands\n` +
                    `from the parent directory — that is the main branch and will corrupt it.\n`;
            }
        }
        if (safetySessionBlock) {
            baseInstructions += '\n\n' + safetySessionBlock.trim();
        }

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
        const promptParts = [
            intro,
            executionDirective,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`,
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

        let safetySessionBlock = '';
        for (const plan of plans) {
            if (plan.worktreePath) {
                safetySessionBlock += `\nIMPORTANT: You are working in a safety session. All file operations and git commands\n` +
                    `must be run from inside the worktree directory: ${plan.worktreePath}\n` +
                    `Navigate into this directory before making any changes. Do NOT run git commands\n` +
                    `from the parent directory — that is the main branch and will corrupt it.\n`;
            }
        }
        if (safetySessionBlock) {
            baseInstructions += '\n\n' + safetySessionBlock.trim();
        }

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, skipBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const suppressWalkthroughBlock = suppressWalkthroughEnabled ? SUPPRESS_WALKTHROUGH_DIRECTIVE : '';
        const promptParts = [
            `Please process the following ${plans.length} plans.`,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`,
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

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            `Please process the following ${plans.length} plans.`,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
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
(ClickUp) or the "**Linear Issue ID:**" line (Linear). Use that ID — not the legacy
"**Ticket:**" field. If neither ID is present, skip posting and notify the user.

Post the verdict as a comment using the clickup_api skill (ClickUp) or the linear_api skill
(Linear). These post through the Switchboard local API bridge — never call the provider API
directly and never touch tokens. NEVER overwrite the ticket description — comment only.

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

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            baseInstructions,
            safeguardsBlock,
            suffixBlock,
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

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            baseInstructions,
            safeguardsBlock,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'code_researcher') {
        const depth = options?.researchDepth || 'deep';

        const depthLabels: Record<string, string> = {
            quick: 'Quick (5-10 sources)',
            standard: 'Standard (15-30 sources)',
            deep: 'Deep (50-100+ sources)',
            academic: 'Academic (100-200+ sources)'
        };
        const label = depthLabels[depth] || depth;

        // Parameterize the research directive with the selected depth
        const customDeepDirective = DEEP_RESEARCH_DIRECTIVE
            .replace('depth set to "deep" (50-100 sources)', `depth set to "${depth}" (${label})`)
            .replace('TARGET SOURCE COUNT: 50-100 sources', `TARGET SOURCE COUNT: ${label}`);

        let crBase = `You are a Code Researcher Agent.\n\n${customDeepDirective}` +
            `\n\nPHASE 5: Plan Update — After completing the research synthesis, you MUST update each plan file listed in PLANS TO PROCESS with your findings. ` +
            `Integrate your research into the plan's existing sections: ` +
            `add findings and analysis to relevant Proposed Changes subsections, ` +
            `update the Edge-Case & Dependency Audit with newly discovered risks, ` +
            `and append a "Knowledge Gaps" subsection under the Complexity Audit if gaps were identified. ` +
            `Do NOT truncate, summarize, or delete existing plan content. ` +
            `Do NOT add new top-level sections that duplicate or conflict with the plan's canonical structure.`;

        let baseInstructions = resolveBaseInstructions('code_researcher', crBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            baseInstructions,
            safeguardsBlock,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'splitter') {
        const complexityScoringDirective =
            `COMPLEXITY SCORING: Before proceeding, invoke the complexity_scoring skill ` +
            `(skill: "complexity_scoring") to add a ## Complexity Audit section with ` +
            `### Routine and ### Complex / Risky subsections. ` +
            `Classify each implementation step by complexity before splitting.`;

        const complexityScoringSkill = options?.complexityScoringSkill !== false;

        const splitterBase = complexityScoringSkill
            ? `You are a Plan Splitter Agent.

STEP 1: Check for Complexity Audit
Read the provided plan file. If it lacks a "## Complexity Audit" section with "### Routine" and "### Complex / Risky" subsections, apply the following directive:
${complexityScoringDirective}

STEP 2: Apply Split Plan Directive
After ensuring the plan has a Complexity Audit, apply the following directive:
\n\n${SPLIT_PLAN_DIRECTIVE}

STEP 3: Dispatch Instructions
After creating both files:

Automated actions (execute these yourself):
1. For each new file (both the complex original and the _routine.md companion), immediately after creation:
   a. Read workspace config:
      WORKSPACE_ID=$(head -n 1 .switchboard/workspace-id)
      DB_PATH=$(head -n 2 .switchboard/workspace-id | tail -n 1)
      [ -z "$DB_PATH" ] && DB_PATH=".switchboard/kanban.db"
   b. Run SQL UPDATE + verification in a single command (workspace-root-relative path, e.g. .switchboard/plans/my_plan_routine.md):
      sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = 'PLAN REVIEWED' WHERE plan_file = '<relative_path>' AND workspace_id = '$WORKSPACE_ID'; SELECT changes();"
      - If output is 1: success (card moved to Planned column)
      - If output is 0: the file may not be registered yet; notify the user to manually drag the card to the Planned column

Manual actions (instruct the USER to perform):
2. Manually drag the original file (Complex) to the Lead Coder column
3. Manually drag the _routine.md file to the Coder column

Create both files in the same directory as the original plan.`
            : `You are a Plan Splitter Agent.

STEP 1: Apply Split Plan Directive
Apply the following directive:
\n\n${SPLIT_PLAN_DIRECTIVE}

STEP 2: Dispatch Instructions
After creating both files:

Automated actions (execute these yourself):
1. For each new file (both the complex original and the _routine.md companion), immediately after creation:
   a. Read workspace config:
      WORKSPACE_ID=$(head -n 1 .switchboard/workspace-id)
      DB_PATH=$(head -n 2 .switchboard/workspace-id | tail -n 1)
      [ -z "$DB_PATH" ] && DB_PATH=".switchboard/kanban.db"
   b. Run SQL UPDATE + verification in a single command (workspace-root-relative path, e.g. .switchboard/plans/my_plan_routine.md):
      sqlite3 "$DB_PATH" "UPDATE plans SET kanban_column = 'PLAN REVIEWED' WHERE plan_file = '<relative_path>' AND workspace_id = '$WORKSPACE_ID'; SELECT changes();"
      - If output is 1: success (card moved to Planned column)
      - If output is 0: the file may not be registered yet; notify the user to manually drag the card to the Planned column

Manual actions (instruct the USER to perform):
2. Manually drag the original file (Complex) to the Lead Coder column
3. Manually drag the _routine.md file to the Coder column

Create both files in the same directory as the original plan.`;

        let baseInstructions = resolveBaseInstructions('splitter', splitterBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            baseInstructions,
            safeguardsBlock,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`
        ].filter(Boolean).join('\n\n');

        return normalizeNewlines(promptParts);
    }

    if (role === 'gatherer') {
        const gathererBase = `You are operating as the **Context Gatherer** — a pre-planning research specialist.

Read the persona at \`.agents/personas/gatherer.md\` and follow it step-by-step.`;

        let baseInstructions = resolveBaseInstructions('gatherer', gathererBase, options);
        if (cavemanOutputEnabled) {
            baseInstructions += '\n\n' + CAVEMAN_OUTPUT_DIRECTIVE;
        }

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock, subagentBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            baseInstructions,
            safeguardsBlock,
            suffixBlock,
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
        const suffixBlock = [dispatchContextPrefix, focusBlock, planDestinationBlock, antigravityBlock]
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
    throw new Error(`Unknown role '${role}' in buildKanbanBatchPrompt. Built-in roles: planner, reviewer, tester, lead, coder, intern, analyst, ticket_updater, researcher, splitter, gatherer, chat. Custom agents should be handled at the call site, not here.`);
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
        case 'CONTEXT GATHERER': return 'gatherer';
        case 'RESEARCHER': return 'researcher';
        case 'SPLITTER': return 'splitter';
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

    // Build safeguards block (batch rules + focus directive)
    const safeguardsBlock = addons?.switchboardSafeguards
        ? `CRITICAL INSTRUCTIONS:
1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans.
2. Execute each plan fully before moving to the next (if sequential).
3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so.\n\n${FOCUS_DIRECTIVE}`
        : `${FOCUS_DIRECTIVE}`;

    let prompt = `${dispatchContextPrefix}${safeguardsBlock}\n\nPLANS TO PROCESS:\n${planList}`;
    if (subagentBlock) {
        prompt += '\n\n' + subagentBlock;
    }

    // Apply directives in defined order
    if (addons?.gitProhibitionEnabled) prompt += '\n\n' + GIT_PROHIBITION_DIRECTIVE;
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

    if (addons?.designDocContent) {
        prompt += `\n\nPLANNING EPIC REFERENCE (pre-fetched):\n${addons.designDocContent}`;
    } else if (addons?.designDocLink) {
        prompt += `\n\nPLANNING EPIC REFERENCE:\n${addons.designDocLink}`;
    }

    if (addons?.designSystemDocContent) {
        prompt += `\n\nDESIGN SYSTEM DOC REFERENCE (pre-fetched):\n${addons.designSystemDocContent}`;
    } else if (addons?.designSystemDocLink) {
        prompt += `\n\nDESIGN SYSTEM DOC REFERENCE:\n${addons.designSystemDocLink}`;
    }

    if (addons?.constitutionContent) {
        prompt += `\n\nPROJECT CONSTITUTION (pre-fetched):\n${addons.constitutionContent}`;
    } else if (addons?.constitutionLink) {
        prompt += `\n\nPROJECT CONSTITUTION:\n${addons.constitutionLink}`;
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
