/**
 * Shared prompt builder for Kanban batch operations.
 * All prompt-generation paths (card copy, batch buttons, autoban dispatch,
 * ticket-view "Send to Agent") MUST route through this module to guarantee
 * prompt text is identical for the same role regardless of UI entry point.
 */

export interface BatchPromptPlan {
    topic: string;
    absolutePath: string;
    complexity?: string;
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
    /** When present, appends a Design Doc / PRD link to planner prompts. */
    designDocLink?: string;
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

    const focusDirective = `FOCUS DIRECTIVE: Each plan file path below is the single source of truth for that plan. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.`;
    const parallelInstruction = plans.length > 1
        ? `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.\n\n`
        : '';

    const batchExecutionRules = `${parallelInstruction}CRITICAL INSTRUCTIONS:
1. Treat each plan file path below as a completely isolated context. Do not mix requirements between plans.
2. Execute each plan fully before moving to the next (if sequential).
3. If one plan hits an issue, report it clearly but continue processing the remaining plans when safe to do so.`;
    const inlineChallengeDirective = `For each plan, before implementation:
- perform a concise adversarial review of that specific plan,
- list at least 2 concrete flaws/edge cases and how you'll address them,
- then execute using those corrections,
- do NOT start \`/challenge\` or any auxiliary workflow for this step.`;
    const challengeBlock = includeInlineChallenge ? `\n\n${inlineChallengeDirective}` : '';
    const planList = plans.map(plan => `- [${plan.topic}] Plan File: ${plan.absolutePath}`).join('\n');

    const chatCritiqueDirective =
        `When you output the adversarial critique (Grumpy and Balanced sections), include them verbatim in your chat response as formatted markdown — do not only write them to the plan file. The user must be able to read the critique directly in chat without opening the plan.`;

    const executionDirective = `AUTHORIZATION TO EXECUTE: The plans provided are already authorized. You MUST enter EXECUTION mode immediately. Do NOT enter PLANNING mode or generate an implementation_plan.md. Proceed directly to implementing the changes.`;

    if (role === 'planner') {
        const plannerVerb = baseInstruction === 'enhance' ? 'enhance' : 'improve';
        const aggressiveDirective = aggressivePairProgramming
            ? `\n\nPAIR PROGRAMMING OPTIMISATION: Aggressive mode is enabled. Assume the Coder agent is highly competent and can handle most implementation tasks independently, including multi-file changes, test updates, and straightforward refactors. Only classify tasks as Complex / Risky if they involve: (a) new architectural patterns or framework integrations the codebase hasn't used before, (b) security-sensitive logic (auth, crypto, permissions), (c) complex state machines or concurrency, or (d) changes that could silently break existing behaviour without obvious test failures. Everything else — even if it touches multiple files or requires careful reading — should be Routine.\n`
            : '';
        const ALLOWED_TAGS = "frontend, backend, authentication, database, UI, devops, infrastructure, bugfix";
        const designDocLink = options?.designDocLink?.trim();
        let plannerPrompt = `Please ${plannerVerb} the following ${plans.length} plans. Break each down into distinct steps grouped by high complexity and low complexity. Add extra detail.${aggressiveDirective}
MANDATORY: You MUST read and strictly adhere to \`.agent/rules/how_to_plan.md\` to format your output and ensure sufficient technical detail. Do not make assumptions about which files need to be changed; provide exact file paths and explicit implementation steps as required by the guide.
Do not add net-new product requirements or scope.
You may add clarifying implementation detail only if strictly implied by existing requirements; label it as "Clarification", not a new requirement.

${batchExecutionRules}

For each plan:
1. Read the plan file before editing.
2. Fill out 'TODO' sections or underspecified parts. Scan the Kanban board/plans folder for potential cross-plan conflicts and document them.
3. Ensure the plan has a "## Complexity Audit" section with "### Routine" and "### Complex / Risky" subsections. If missing, create it. If present, update it. If Complex / Risky is empty, write "- None" explicitly.
4. Ensure the plan has a "## Metadata" section immediately after the "## Goal" section. You MUST explicitly assign metadata using EXACTLY this format:
## Metadata
**Tags:** [comma-separated list chosen ONLY from: ${ALLOWED_TAGS}]
**Complexity:** [Low | High]

Use 'High' for complex logic, new frameworks, or risky state mutations. Use 'Low' for routine changes. Do NOT invent tags outside the allowed list. If no tags apply, write **Tags:** none
5. Perform adversarial review: post a Grumpy critique (dramatic "Grumpy Principal Engineer" voice: incisive, specific, theatrical) then a Balanced synthesis.
6. ${chatCritiqueDirective}
7. Update the original plan with the enhancement findings. Do NOT truncate, summarize, or delete existing implementation steps, code blocks, or goal statements.
8. Recommend agent: if the plan is simple (routine changes, only Routine tasks), say "Send to Coder". If complex (Complex tasks, new frameworks), say "Send to Lead Coder".

${focusDirective}

PLANS TO PROCESS:
${planList}`;

        if (designDocLink) {
            plannerPrompt += `\n\nDESIGN DOC REFERENCE:\nThe following design document provides the project's product requirements and specifications. Use it as foundational context for all planning decisions:\n${designDocLink}`;
        }

        return plannerPrompt;
    }

    if (role === 'reviewer') {
        const planTarget = plans.length <= 1 ? 'this plan' : 'each listed plan';
        const reviewerExecutionIntro = buildReviewerExecutionIntro(plans.length);
        const reviewerExecutionMode = buildReviewerExecutionModeLine(`For ${planTarget}, assess the actual code changes against the plan requirements, fix valid material issues in code when needed, then verify.`);
        const advancedReviewerBlock = advancedReviewerEnabled ? `

ADVANCED REGRESSION ANALYSIS (enabled):
1. Trace all callers and consumers of every modified function. Check whether changes to its signature, return value, side effects, or timing could break callers.
2. Check for double-trigger bugs: if you add a UI refresh, verify no caller already triggers one.
3. Check for race conditions: if the change involves async state (DB writes, file watchers, mtime checks), verify it doesn't conflict with concurrent systems (autoban polling, cross-IDE sync, write serialization chains).
4. Check for orphaned references: if dead code was removed, grep for any remaining references to the removed identifiers.
5. Audit the full execution path from UI entry point to final state change, not just the changed lines.
This analysis is token-intensive but catches regressions that plan-compliance-only reviews miss.` : '';

        return `${reviewerExecutionIntro}

${batchExecutionRules}

${reviewerExecutionMode}${advancedReviewerBlock}

For each plan:
1. Use the plan file as the source of truth for the review criteria.
2. Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
3. Stage 2 (Balanced): synthesize Stage 1 into actionable fixes — what to keep, what to fix now, what can defer.
4. Apply code fixes for valid CRITICAL/MAJOR findings.
5. Run verification checks (typecheck/tests as applicable) and include results.
6. Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps.

CRITICAL: Do not stop after Stage 1. Complete the Grumpy review, the Balanced synthesis, the code fixes, and the plan update all in one continuous response.

${chatCritiqueDirective}

${focusDirective}

PLANS TO PROCESS:
${planList}`;
    }

    if (role === 'lead') {
        let leadPrompt = `Please execute the following ${plans.length} plans.

${executionDirective}

${batchExecutionRules}${challengeBlock}

${focusDirective}

PLANS TO PROCESS:
${planList}`;
        if (pairProgrammingEnabled) {
            leadPrompt += `\n\nNote: A Coder agent is concurrently handling the Routine tasks for these plans. You only need to do Complex (Band B) work. IMPORTANT: The Coder has JUST started and will NOT be finished yet — do NOT attempt to check or read their work at the start. Begin your Complex implementation immediately. Only check and integrate the Coder's Routine work as a final step before declaring completion, by which time they will have finished.`;
            if (aggressivePairProgramming) {
                leadPrompt += ` Routine scope has been expanded in aggressive pair programming mode. During your final integration check, pay extra attention to any Routine changes that touch files you also modified.`;
            }
        }
        return leadPrompt;
    }

    if (role === 'coder') {
        const intro = baseInstruction === 'low-complexity'
            ? `Please execute the following ${plans.length} low-complexity plans from PLAN REVIEWED.`
            : `Please execute the following ${plans.length} plans.`;
        let coderPrompt = withCoderAccuracyInstruction(`${intro}

${executionDirective}

${batchExecutionRules}${challengeBlock}

${focusDirective}

PLANS TO PROCESS:
${planList}`, accurateCodingEnabled);
        if (pairProgrammingEnabled) {
            coderPrompt += `\n\nAdditional Instructions: only do Routine (Band A) work.`;
        }
        return coderPrompt;
    }

    return `Please process the following ${plans.length} plans.

${batchExecutionRules}

${focusDirective}

PLANS TO PROCESS:
${planList}`;
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
            return 'reviewer';
        default:
            return column.startsWith('custom_agent_') ? column : null;
    }
}
