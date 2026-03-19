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

    const focusDirective = `FOCUS DIRECTIVE: Each plan file path below is the single source of truth for that plan. Ignore any complexity regarding directory mirroring, 'brain' vs 'source' directories, or path hashing.`;
    const batchExecutionRules = `If your platform supports parallel sub-agents, dispatch one sub-agent per plan to execute them concurrently. If not, process them sequentially.

CRITICAL INSTRUCTIONS:
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

    if (role === 'planner') {
        const plannerVerb = baseInstruction === 'enhance' ? 'enhance' : 'improve';
        return `Please ${plannerVerb} the following ${plans.length} plans. Break each down into distinct steps grouped by high complexity and low complexity. Add extra detail.
MANDATORY: You MUST read and strictly adhere to \`.agent/rules/how_to_plan.md\` to format your output and ensure sufficient technical detail. Do not make assumptions about which files need to be changed; provide exact file paths and explicit implementation steps as required by the guide.
Do not add net-new product requirements or scope.
You may add clarifying implementation detail only if strictly implied by existing requirements; label it as "Clarification", not a new requirement.

${batchExecutionRules}

For each plan:
1. Read the plan file before editing.
2. Fill out 'TODO' sections or underspecified parts. Scan the Kanban board/plans folder for potential cross-plan conflicts and document them.
3. Ensure the plan has a "## Complexity Audit" section with "### Band A — Routine" and "### Band B — Complex / Risky" subsections. If missing, create it. If present, update it. If Band B is empty, write "- None" explicitly.
4. Perform adversarial review: post a Grumpy critique (dramatic "Grumpy Principal Engineer" voice: incisive, specific, theatrical) then a Balanced synthesis.
5. Update the original plan with the enhancement findings. Do NOT truncate, summarize, or delete existing implementation steps, code blocks, or goal statements.
6. Recommend agent: if the plan is simple (routine changes, only Band A), say "Send to Coder". If complex (Band B tasks, new frameworks), say "Send to Lead Coder".

${focusDirective}

PLANS TO PROCESS:
${planList}`;
    }

    if (role === 'reviewer') {
        const planTarget = plans.length <= 1 ? 'this plan' : 'each listed plan';
        const reviewerExecutionIntro = buildReviewerExecutionIntro(plans.length);
        const reviewerExecutionMode = buildReviewerExecutionModeLine(`For ${planTarget}, assess the actual code changes against the plan requirements, fix valid material issues in code when needed, then verify.`);
        return `${reviewerExecutionIntro}

${batchExecutionRules}

${reviewerExecutionMode}

For each plan:
1. Use the plan file as the source of truth for the review criteria.
2. Stage 1 (Grumpy): adversarial findings, severity-tagged (CRITICAL/MAJOR/NIT), in a dramatic "Grumpy Principal Engineer" voice (incisive, specific, theatrical).
3. Stage 2 (Balanced): synthesize Stage 1 into actionable fixes — what to keep, what to fix now, what can defer.
4. Apply code fixes for valid CRITICAL/MAJOR findings.
5. Run verification checks (typecheck/tests as applicable) and include results.
6. Update the original plan file with fixed items, files changed, validation results, and remaining risks. Do NOT truncate, summarize, or delete existing implementation steps.

CRITICAL: Do not stop after Stage 1. Complete the Grumpy review, the Balanced synthesis, the code fixes, and the plan update all in one continuous response.

${focusDirective}

PLANS TO PROCESS:
${planList}`;
    }

    if (role === 'lead') {
        return `Please execute the following ${plans.length} plans.

${batchExecutionRules}${challengeBlock}

${focusDirective}

PLANS TO PROCESS:
${planList}`;
    }

    if (role === 'coder') {
        const intro = baseInstruction === 'low-complexity'
            ? `Please execute the following ${plans.length} low-complexity plans from PLAN REVIEWED.`
            : `Please execute the following ${plans.length} plans.`;
        return withCoderAccuracyInstruction(`${intro}

${batchExecutionRules}${challengeBlock}

${focusDirective}

PLANS TO PROCESS:
${planList}`, accurateCodingEnabled);
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
