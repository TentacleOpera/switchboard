/**
 * Shared prompt builder for Kanban batch operations.
 * All prompt-generation paths (card copy, batch buttons, autoban dispatch,
 * ticket-view "Send to Agent") MUST route through this module to guarantee
 * prompt text is identical for the same role regardless of UI entry point.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DefaultPromptOverride } from './agentConfig';

export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
    dependencies?: string;
    workingDir?: string;
    sessionId?: string;
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
    /** Whether dependency check instructions are injected (planner role). */
    dependencyCheckEnabled?: boolean;
    /** Path to the workflow file for the planner role. Defaults to .agent/workflows/improve-plan.md */
    plannerWorkflowPath?: string;
    /** When present, appends a Design Doc / PRD link to planner prompts. */
    designDocLink?: string;
    /** When present, the full pre-fetched Notion page content to embed verbatim. Takes precedence over designDocLink. */
    designDocContent?: string;
    /** When true, planner produces separate Routine and Complex plan files. */
    splitPlan?: boolean;
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
    /** When true, the research_planner role triggers the full deep research protocol. */
    enableDeepPlanning?: boolean;
    /** The research depth to use for the deep research protocol (e.g. 'quick', 'standard', 'deep', 'academic'). */
    researchDepth?: string;
    /** The user's custom routing map configuration for agent complexities. */
    routingMapConfig?: { lead: number[]; coder: number[]; intern: number[] } | null;
    /** When true, instructs agents to ignore previous checkpoint summaries. */
    clearAntigravityContext?: boolean;
}

export function resolveBaseInstructions(
    role: string,
    defaultBase: string,
    options?: PromptBuilderOptions
): string {
    const override = options?.defaultPromptOverrides?.[role];
    const base = defaultBase;
    if (override?.text) {
        switch (override.mode) {
            case 'replace': return override.text;
            case 'prepend': return `${override.text}\n\n${base}`;
            case 'append': return `${base}\n\n${override.text}`;
        }
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
- Treat the challenge stage as inline analysis in this same prompt (no \`/challenge\` workflow).
- ${expectation}`;
}

function withCoderAccuracyInstruction(basePayload: string, enabled: boolean): string {
    if (!enabled) {
        return basePayload;
    }

    const accuracyInstruction = `\n\nAccuracy Mode: Before coding, read and follow the workflow at .agent/workflows/accuracy.md step-by-step while implementing this task.`;
    return `${basePayload}${accuracyInstruction}`;
}

export function buildPromptDispatchContext(plans: BatchPromptPlan[]): PromptDispatchContext {
    const normalizedPlans = plans.map(plan => ({
        ...plan,
        workingDir: (plan.workingDir || '').trim()
    }));
    const planList = normalizedPlans.map(plan => `- [${plan.topic}] Plan File: ${plan.absolutePath}`).join('\n');
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

export const INLINE_CHALLENGE_DIRECTIVE = `For each plan, before implementation:
- perform a concise adversarial review of that specific plan,
- list at least 2 concrete flaws/edge cases and how you'll address them,
- then execute using those corrections,
- do NOT start \`/challenge\` or any auxiliary workflow for this step.`;

export const SPLIT_PLAN_DIRECTIVE = `SPLIT PLAN MODE: Produce TWO files per plan. Original file = Complex / Risky only. Companion file (\`<stem>_routine.md\`) = Routine only. Both files must include full shared context (Goal, Metadata, Current State, Edge-Case audit, Dependencies). Original file notes: "Assume Routine items implemented by Coder agent." Read the full original file before writing either output. Create both files in the same directory as the original.`;

export const DEPENDENCY_CHECK_DIRECTIVE = `[DEPENDENCY CHECK ENABLED]\nWhen loading the plan, also query active Kanban plans for dependencies using kanban_operations skill: run \`node .agent/skills/kanban_operations/get-state.js <workspace_id>\`. Inspect New and Planned columns for conflicts; exclude Completed, Intern, Lead Coder, Coder, and Reviewed columns. If query fails, note uncertainty in Edge-Case & Dependency Audit. Emit dependencies in plan's \`## Dependencies\` section as \`sess_XXXXXXXXXXXXX — <topic>\` lines, or \`None\` if none.`;

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
    `PHASE 4: Synthesis — produce output with: Executive Summary, Current State Analysis, External Research Findings, ` +
    `Proposed Implementation Plan, Impact Analysis, Source Credibility Assessment, Knowledge Gaps, Recommended Next Steps.\n` +
    `TARGET SOURCE COUNT: 50-100 sources (soft target — prioritize quality over quantity).`;

const DEFAULT_PLANNER_WORKFLOW = '.agent/workflows/improve-plan.md';

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
    const dependencyCheckEnabled = options?.dependencyCheckEnabled ?? false;
    const splitPlan = options?.splitPlan ?? false;
    const gitProhibitionEnabled = options?.gitProhibitionEnabled ?? true;
    const switchboardSafeguardsEnabled = options?.switchboardSafeguardsEnabled ?? true;
    const sourceColumnLabel = options?.sourceColumnLabel;
    const clearAntigravityContext = options?.clearAntigravityContext ?? false;

    const parallelInstruction = plans.length > 1
        ? `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.\n\n`
        : '';

    const batchExecutionRules = `${parallelInstruction}CRITICAL INSTRUCTIONS:
1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans.
2. Execute each plan fully before moving to the next (if sequential).
3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so.`;
    const inlineChallengeDirective = INLINE_CHALLENGE_DIRECTIVE;
    const challengeBlock = includeInlineChallenge ? inlineChallengeDirective : '';
    const antigravityBlock = clearAntigravityContext
        ? 'Ignore any previous checkpoint summaries or context carried over from prior agent sessions. Do NOT ignore workspace-level context such as AGENTS.md, existing code conventions, or project configuration.'
        : '';
    const { planList, dispatchContextBlock } = buildPromptDispatchContext(plans);
    const dispatchContextPrefix = dispatchContextBlock ? `${dispatchContextBlock}\n\n` : '';

    // Build sessionId → topic resolution map for dependency display
    const sessionIdToTopic = new Map<string, string>();
    plans.forEach(p => {
        if (p.sessionId) sessionIdToTopic.set(p.sessionId, p.topic);
    });

    const plansWithDeps = plans.filter(p => p.dependencies);
    const depSection = plansWithDeps.length > 0
        ? `\n\nDEPENDENCY ORDER: Execute in order; do not start a plan until its dependencies are implemented:\n${
            plansWithDeps.map((p, i) => {
                const depIds = (p.dependencies || '').split(',').map(d => d.trim()).filter(Boolean);
                const resolvedDeps = depIds.map(depId => {
                    const resolved = sessionIdToTopic.get(depId);
                    return resolved || depId;
                });
                return `${i + 1}. [${p.topic}] depends on: ${resolvedDeps.join(', ')}`;
            }).join('\n')}\n`
        : '';

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
        let plannerBase = `Read ${workflowPath} and follow it step-by-step.\n\n`;

        if (options?.routingMapConfig) {
            plannerBase += `ROUTING MAP CONFIGURATION:\nThe user has configured the following custom routing map for complexity scores. When recommending an agent at the end of the plan, you MUST use these exact thresholds instead of any default thresholds:\n- Intern: Complexity ${options.routingMapConfig.intern.join(', ')}\n- Coder: Complexity ${options.routingMapConfig.coder.join(', ')}\n- Lead Coder: Complexity ${options.routingMapConfig.lead.join(', ')}\n\n`;
        }

        // Include batch execution rules for multi-plan dispatches
        if (plans.length > 1 && switchboardSafeguardsEnabled) {
            plannerBase += `${batchExecutionRules}\n\n`;
        }

        const designDocLink = options?.designDocLink?.trim();
        if (designDocLink) {
            plannerBase += `DESIGN DOC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as foundational context for all planning decisions:\n${designDocLink}\n\n`;
        }

        if (aggressivePairProgramming) {
            plannerBase += '\n\n' + AGGRESSIVE_PAIR_PROGRAMMING_DIRECTIVE;
        }
        if (dependencyCheckEnabled) {
            plannerBase += '\n\n' + DEPENDENCY_CHECK_DIRECTIVE;
        }
        if (splitPlan) {
            plannerBase += '\n\n' + SPLIT_PLAN_DIRECTIVE;
        }
        if (workspaceTypeBlock) {
            plannerBase += '\n\n' + workspaceTypeBlock;
        }

        const baseInstructions = resolveBaseInstructions('planner', plannerBase, options);

        let plannerPrompt = baseInstructions;

        // Add dispatch context and plan list
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
            .filter(Boolean)
            .join('\n\n');

        if (suffixBlock) {
            plannerPrompt += '\n\n' + suffixBlock;
        }

        plannerPrompt += `\n\nPLANS TO PROCESS:\n${planList}`;

        // Append design doc content (pre-fetched Notion)
        const designDocContent = options?.designDocContent?.trim();
        if (designDocContent) {
            plannerPrompt += `\n\nDESIGN DOC REFERENCE (pre-fetched from Notion):\nThe following is the full content of the project's design document / PRD. Use it as foundational context for all planning decisions:\n\n${designDocContent}`;
        }

        return normalizeNewlines(plannerPrompt);
    }

    if (role === 'reviewer') {
        const DEFAULT_REVIEWER_BASE_INSTRUCTIONS = `For each plan:
1. Use the plan file as the source of truth for the review criteria.
2. Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
3. Stage 2 (Balanced): synthesize Stage 1 into actionable fixes — what to keep, what to fix now, what can defer.
4. Apply code fixes for valid CRITICAL/MAJOR findings.
5. Run verification checks (typecheck/tests as applicable) and include results.
6. Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps.

CRITICAL: Do not stop after Stage 1. Complete the Grumpy review, the Balanced synthesis, the code fixes, and the plan update all in one continuous response.`;

        const planTarget = plans.length <= 1 ? 'this plan' : 'each listed plan';
        const reviewerExecutionIntro = buildReviewerExecutionIntro(plans.length);
        const reviewerExecutionMode = buildReviewerExecutionModeLine(`For ${planTarget}, assess the actual code changes against the plan requirements, fix valid material issues in code when needed, then verify.`);
        const advancedReviewerBlock = advancedReviewerEnabled ? ADVANCED_REVIEWER_DIRECTIVE : '';
        const safeguardsBlock = switchboardSafeguardsEnabled
            ? `${batchExecutionRules}`
            : '';

        const baseInstructions = resolveBaseInstructions('reviewer', DEFAULT_REVIEWER_BASE_INSTRUCTIONS, options);

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
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

        const baseInstructions = resolveBaseInstructions('tester', testerBase, options);

        const intro = plans.length <= 1
            ? 'The implementation for this plan passed code review. Execute a direct acceptance test against the product requirements document in-place.'
            : `The implementation for each of the following ${plans.length} plans passed code review. Execute a direct acceptance test against the product requirements document in-place for each plan.`;

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
            .filter(Boolean)
            .join('\n\n');

        let designDocBlock = '';
        if (designDocContent) {
            designDocBlock = `DESIGN DOC REFERENCE (pre-fetched from Notion):\nThe following is the full content of the project's design document / PRD. Use it as the authoritative requirements baseline for acceptance testing:\n\n${designDocContent}`;
        } else if (designDocLink) {
            designDocBlock = `DESIGN DOC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as the authoritative requirements baseline for acceptance testing:\n${designDocLink}`;
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

        const baseInstructions = resolveBaseInstructions('lead', leadBase, options);

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            `Please execute the following ${plans.length} plans${sourceSuffix}.`,
            executionDirective,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`,
            depSection.trim()
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

        const baseInstructions = resolveBaseInstructions('coder', coderBase, options);

        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
            .filter(Boolean)
            .join('\n\n');

        const promptParts = [
            intro,
            executionDirective,
            safeguardsBlock,
            baseInstructions,
            suffixBlock,
            `PLANS TO PROCESS:\n${planList}`,
            depSection.trim()
        ].filter(Boolean).join('\n\n');

        const coderPrompt = withCoderAccuracyInstruction(normalizeNewlines(promptParts), accurateCodingEnabled);
        return normalizeNewlines(coderPrompt);
    }

    if (role === 'intern') {
        const baseInstructions = resolveBaseInstructions('intern', '', options);

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
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

    if (role === 'analyst') {
        const baseInstructions = resolveBaseInstructions('analyst', '', options);

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
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
        const ticketUpdateDirective =
            `TICKET UPDATE MODE: You are authorized to update the associated ticket. ` +
            `Extract the ticket number from the plan metadata field "**Ticket:**" (format: CU-XXXXX or LIN-XXXXX). ` +
            `Analyze the plan, then use the clickup_api or linear_api skill to add an "AI Analysis" comment to the ticket. ` +
            `Do not modify the ticket description. Only add a comment. ` +
            `If no ticket number is found, skip the ticket update and notify the user.`;

        const updaterBase = `You are a Ticket Updater Agent.

STEP 1: Analyze the Plan
Generate a concise analysis covering:
- **Goal Summary**: Brief overview of what the plan aims to achieve
- **Complexity Assessment**: Overall complexity (Low/Medium/High) and key risk areas
- **Key Dependencies**: Major dependencies or blockers
- **Implementation Notes**: Any notable implementation considerations
- **Estimated Effort**: Rough effort estimate (if discernible from complexity)

Keep the analysis under 500 words for readability in the ticket.

STEP 2: Update the Ticket
${ticketUpdateDirective}

Format the analysis as:
## AI Analysis

[Your analysis content here]`;

        const baseInstructions = resolveBaseInstructions('ticket_updater', updaterBase, options);

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
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
        const researcherBase = `You are a Researcher Agent.

${DEEP_RESEARCH_DIRECTIVE}`;

        const baseInstructions = resolveBaseInstructions('researcher', researcherBase, options);

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
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

    if (role === 'research_planner') {
        const enableDeepPlanning = options?.enableDeepPlanning ?? false;
        const depth = options?.researchDepth || 'deep';

        const depthLabels: Record<string, string> = {
            quick: 'Quick (5-10 sources)',
            standard: 'Standard (15-30 sources)',
            deep: 'Deep (50-100+ sources)',
            academic: 'Academic (100-200+ sources)'
        };
        const label = depthLabels[depth] || depth;

        let rpBase = `You are a Research Planner Agent.`;

        if (enableDeepPlanning) {
            // Replace depth in DEEP_RESEARCH_DIRECTIVE
            const customDeepDirective = DEEP_RESEARCH_DIRECTIVE.replace('depth set to "deep" (50-100 sources)', `depth set to "${depth}" (${label})`)
                .replace('TARGET SOURCE COUNT: 50-100 sources', `TARGET SOURCE COUNT: ${label}`);
            rpBase += `\n\n${customDeepDirective}`;
        } else {
            rpBase += `\n\nUse the web_research skill to conduct comprehensive research on the following topic.\n\nResearch depth: ${label}\n\nPlease begin by proposing a research plan for my approval, following the web_research skill protocol.`;
        }

        const baseInstructions = resolveBaseInstructions('research_planner', rpBase, options);

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
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

        const splitterBase = `You are a Plan Splitter Agent.

STEP 1: Check for Complexity Audit
Read the provided plan file. If it lacks a "## Complexity Audit" section with "### Routine" and "### Complex / Risky" subsections, apply the following directive:
${complexityScoringDirective}

STEP 2: Apply Split Plan Directive
After ensuring the plan has a Complexity Audit, apply the following directive:
\n\n${SPLIT_PLAN_DIRECTIVE}

STEP 3: Dispatch Instructions (for the USER, not automated)
After creating both files:
- Manually drag the original file (Complex) to the Lead Coder column
- Manually drag the _routine.md file to the Coder column

Create both files in the same directory as the original plan.`;

        const baseInstructions = resolveBaseInstructions('splitter', splitterBase, options);

        const safeguardsBlock = switchboardSafeguardsEnabled ? batchExecutionRules : '';
        const focusBlock = switchboardSafeguardsEnabled ? FOCUS_DIRECTIVE : '';
        const gitBlock = gitProhibitionEnabled ? GIT_PROHIBITION_DIRECTIVE : '';
        const suffixBlock = [dispatchContextPrefix, focusBlock, gitBlock, antigravityBlock]
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

    // No fallback — every built-in role must have an explicit template.
    // Custom agents are NOT routed through this function; they use plan-file-link-only prompts built at call sites.
    throw new Error(`Unknown role '${role}' in buildKanbanBatchPrompt. Built-in roles: planner, reviewer, tester, lead, coder, intern, analyst, ticket_updater, researcher, splitter. Custom agents should be handled at the call site, not here.`);
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
        case 'SPLITTER': return 'splitter';
        case 'TICKET UPDATER': return 'ticket_updater';
        default:
            return column.startsWith('custom_agent_') ? column : null;
    }
}
