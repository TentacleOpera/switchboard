'use strict';

// Sync test: verifies all NINE plan-writing prompt surfaces carry the same
// Plan Sizing (auto-split) signals and that the old reactive-only "Feature
// Grouping:" header is gone from the chat base instructions. Guards against
// drift across:
//   1. DEFAULT_CHAT_BASE_INSTRUCTIONS  (src/services/agentPromptBuilder.ts)
//   2. .agents/workflows/switchboard-cloud.md
//   3. .agents/workflows/switchboard-memo.md
//   4. _buildMemoPlannerPrompt          (src/services/TaskViewerProvider.ts)
//   5. .agents/workflows/switchboard-remote.md
//   6. AGENTS.md                         (always-on protocol file)
//   7. CLAUDE.md                         (always-on protocol file, managed block)
//   8. .agents/skills/deep-planning/SKILL.md   (authoring skill — Phase 0 body)
//   9. .agents/skills/improve-plan/SKILL.md    (authoring skill — ## Steps body)
//
// Also guards the memo step-4/step-5 split-timing invariant: splitting must
// happen in step 4 (before any plan file is written), never in step 5 (which
// would orphan plan files inside the "no memos lost on failure" workflow).
//
// Skill assertions are section-scoped (Phase 0 for deep-planning, ## Steps
// body for improve-plan) so a green test cannot coexist with a rule buried
// in a section the agent never executes.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
    const root = process.cwd();
    const promptBuilderPath = path.join(root, 'src', 'services', 'agentPromptBuilder.ts');
    const taskViewerPath = path.join(root, 'src', 'services', 'TaskViewerProvider.ts');
    const cloudWorkflowPath = path.join(root, '.agents', 'workflows', 'switchboard-cloud.md');
    const memoWorkflowPath = path.join(root, '.agents', 'workflows', 'switchboard-memo.md');
    const remoteWorkflowPath = path.join(root, '.agents', 'workflows', 'switchboard-remote.md');
    const agentsMdPath = path.join(root, 'AGENTS.md');
    const claudeMdPath = path.join(root, 'CLAUDE.md');
    const deepPlanningSkillPath = path.join(root, '.agents', 'skills', 'deep-planning', 'SKILL.md');
    const improvePlanSkillPath = path.join(root, '.agents', 'skills', 'improve-plan', 'SKILL.md');

    const promptBuilderSource = fs.readFileSync(promptBuilderPath, 'utf8');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
    const cloudWorkflow = fs.readFileSync(cloudWorkflowPath, 'utf8');
    const memoWorkflow = fs.readFileSync(memoWorkflowPath, 'utf8');
    const remoteWorkflow = fs.readFileSync(remoteWorkflowPath, 'utf8');
    const agentsMd = fs.readFileSync(agentsMdPath, 'utf8');
    const claudeMd = fs.readFileSync(claudeMdPath, 'utf8');
    const deepPlanningSkill = fs.readFileSync(deepPlanningSkillPath, 'utf8');
    const improvePlanSkill = fs.readFileSync(improvePlanSkillPath, 'utf8');

    // --- Shared splitting-signal anchors (must appear in every surface) ---
    const DISTINCT_DELIVERABLES = '3+ distinct deliverables';
    const SHIPPABLE_PHASES = '2+ independently-shippable phases';

    // ============================================================
    // 1. DEFAULT_CHAT_BASE_INSTRUCTIONS
    // ============================================================

    // Extract the DEFAULT_CHAT_BASE_INSTRUCTIONS constant body so assertions
    // are scoped to the prompt text, not the rest of the file.
    const chatBaseMatch = promptBuilderSource.match(
        /export const DEFAULT_CHAT_BASE_INSTRUCTIONS = `([\s\S]*?)`;\n/
    );
    assert.ok(
        chatBaseMatch,
        'Expected DEFAULT_CHAT_BASE_INSTRUCTIONS template literal to be found in agentPromptBuilder.ts.'
    );
    const chatBase = chatBaseMatch[1];

    assert.ok(
        chatBase.includes('Assess scope'),
        'DEFAULT_CHAT_BASE_INSTRUCTIONS must include the "Assess scope" step (step 3).'
    );
    assert.ok(
        chatBase.includes(DISTINCT_DELIVERABLES),
        'DEFAULT_CHAT_BASE_INSTRUCTIONS must include the "3+ distinct deliverables" splitting signal.'
    );
    assert.ok(
        chatBase.includes(SHIPPABLE_PHASES),
        'DEFAULT_CHAT_BASE_INSTRUCTIONS must include the "2+ independently-shippable phases" splitting signal.'
    );
    assert.ok(
        !/^Feature Grouping:$/m.test(chatBase),
        'DEFAULT_CHAT_BASE_INSTRUCTIONS must NOT contain the old "Feature Grouping:" header (folded into step 5).'
    );
    assert.ok(
        chatBase.includes('If the user explicitly asks for a single plan, respect that and write one.'),
        'DEFAULT_CHAT_BASE_INSTRUCTIONS must include the single-plan carve-out.'
    );
    // Step 1b: conditional-on-initiator gate wording. The feature-creation
    // gate must branch on who initiated grouping — user-asked = auto-create,
    // agent-proposed = offer-and-wait. Guards against the double-confirm bug.
    assert.ok(
        /User already asked for grouping or a feature/.test(chatBase),
        'DEFAULT_CHAT_BASE_INSTRUCTIONS step 5 must include the conditional-on-initiator gate (user-asked → auto-create).'
    );
    assert.ok(
        /You are proposing grouping the user did not request/.test(chatBase),
        'DEFAULT_CHAT_BASE_INSTRUCTIONS step 5 must include the conditional-on-initiator gate (agent-proposed → offer-and-wait).'
    );

    // ============================================================
    // 2. switchboard-cloud.md  (sync with chat base + forward pointer fix)
    // ============================================================

    assert.ok(
        cloudWorkflow.includes('Assess scope'),
        'switchboard-cloud.md must include the "Assess scope" step (sync with chat base instructions).'
    );
    assert.ok(
        cloudWorkflow.includes(DISTINCT_DELIVERABLES),
        'switchboard-cloud.md must include the "3+ distinct deliverables" splitting signal.'
    );
    assert.ok(
        cloudWorkflow.includes(SHIPPABLE_PHASES),
        'switchboard-cloud.md must include the "2+ independently-shippable phases" splitting signal.'
    );
    // The old forward pointer "refer to the **Feature Grouping** section below"
    // must be gone — replaced by a pointer to step 5 (Gate) of the Process.
    assert.ok(
        !/refer to the \*\*Feature Grouping\*\* section below/.test(cloudWorkflow),
        'switchboard-cloud.md must NOT contain the dangling "Feature Grouping section below" forward pointer.'
    );
    assert.ok(
        /see step 5 \(Gate\) of the Process above/.test(cloudWorkflow),
        'switchboard-cloud.md Feature Relationships pointer must reference "step 5 (Gate) of the Process above".'
    );
    assert.ok(
        !/^## Feature Grouping$/m.test(cloudWorkflow),
        'switchboard-cloud.md must NOT contain the old standalone "## Feature Grouping" section header.'
    );

    // ============================================================
    // 3. switchboard-memo.md  (split in step 4, NOT step 5)
    // ============================================================

    // Step 4 must mention splitting (before-write invariant).
    const memoStep4Match = memoWorkflow.match(/^4\. \*\*Create one plan per entry\.\*\*([\s\S]*?)(?=\n5\. )/m);
    assert.ok(
        memoStep4Match,
        'switchboard-memo.md must have a step 4 starting with "Create one plan per entry."'
    );
    const memoStep4 = memoStep4Match[1];
    assert.ok(
        memoStep4.includes('Before writing'),
        'switchboard-memo.md step 4 must mention "Before writing" (split decision before any file is written).'
    );
    assert.ok(
        memoStep4.includes(DISTINCT_DELIVERABLES) && memoStep4.includes(SHIPPABLE_PHASES),
        'switchboard-memo.md step 4 must include both splitting signals.'
    );
    assert.ok(
        memoStep4.includes('no orphan plans are created'),
        'switchboard-memo.md step 4 must state the no-orphan-plans guarantee.'
    );

    // Step 5 must NOT mention splitting (regression guard against the
    // post-write split that orphans plan files).
    const memoStep5Match = memoWorkflow.match(/^5\. \*\*Offer feature grouping\.\*\*([\s\S]*?)(?=\n6\. )/m);
    assert.ok(
        memoStep5Match,
        'switchboard-memo.md must have a step 5 starting with "Offer feature grouping."'
    );
    const memoStep5 = memoStep5Match[1];
    assert.ok(
        !/split/i.test(memoStep5),
        'switchboard-memo.md step 5 must NOT mention splitting (regression guard against orphan-plan timing bug).'
    );

    // ============================================================
    // 4. _buildMemoPlannerPrompt  (TaskViewerProvider.ts source)
    // ============================================================
    // _buildMemoPlannerPrompt is private; assert the splitting guidance is
    // present in the source template literal that builds the prompt.

    assert.ok(
        taskViewerSource.includes(DISTINCT_DELIVERABLES),
        'TaskViewerProvider _buildMemoPlannerPrompt must include the "3+ distinct deliverables" splitting signal.'
    );
    assert.ok(
        taskViewerSource.includes(SHIPPABLE_PHASES),
        'TaskViewerProvider _buildMemoPlannerPrompt must include the "2+ independently-shippable phases" splitting signal.'
    );
    assert.ok(
        /5\. If a single issue covers 3\+ distinct deliverables/.test(taskViewerSource),
        'TaskViewerProvider _buildMemoPlannerPrompt Instructions must include step 5 with the splitting rule.'
    );
    assert.ok(
        /more if any issue is split per the splitting rule above/.test(taskViewerSource),
        'TaskViewerProvider _buildMemoPlannerPrompt Important section must reference the splitting rule.'
    );

    // ============================================================
    // 5. switchboard-remote.md
    // ============================================================

    assert.ok(
        remoteWorkflow.includes('Plan Sizing — split before drafting'),
        'switchboard-remote.md must include the "Plan Sizing — split before drafting" directive.'
    );
    assert.ok(
        remoteWorkflow.includes(DISTINCT_DELIVERABLES),
        'switchboard-remote.md must include the "3+ distinct deliverables" splitting signal.'
    );
    assert.ok(
        remoteWorkflow.includes(SHIPPABLE_PHASES),
        'switchboard-remote.md must include the "2+ independently-shippable phases" splitting signal.'
    );
    assert.ok(
        !/^## Feature Grouping$/m.test(remoteWorkflow),
        'switchboard-remote.md must NOT contain the old standalone "## Feature Grouping" section header (replaced by "## Plan Sizing & Feature Grouping").'
    );
    assert.ok(
        /^## Plan Sizing & Feature Grouping$/m.test(remoteWorkflow),
        'switchboard-remote.md must contain the new "## Plan Sizing & Feature Grouping" section header.'
    );

    // ============================================================
    // 6. AGENTS.md  (always-on protocol file — file-wide includes)
    // ============================================================

    assert.ok(
        agentsMd.includes('Plan Sizing — split before drafting'),
        'AGENTS.md must include the "Plan Sizing — split before drafting" directive in the Plan Authoring protocol section.'
    );
    assert.ok(
        agentsMd.includes(DISTINCT_DELIVERABLES),
        'AGENTS.md must include the "3+ distinct deliverables" splitting signal.'
    );
    assert.ok(
        agentsMd.includes(SHIPPABLE_PHASES),
        'AGENTS.md must include the "2+ independently-shippable phases" splitting signal.'
    );
    assert.ok(
        agentsMd.includes('If the user explicitly asks for a single plan, respect that and write one.'),
        'AGENTS.md must include the single-plan carve-out.'
    );

    // ============================================================
    // 7. CLAUDE.md  (always-on protocol file — managed block mirror)
    // ============================================================

    assert.ok(
        claudeMd.includes('Plan Sizing — split before drafting'),
        'CLAUDE.md managed block must include the "Plan Sizing — split before drafting" directive (mirrored from AGENTS.md).'
    );
    assert.ok(
        claudeMd.includes(DISTINCT_DELIVERABLES),
        'CLAUDE.md must include the "3+ distinct deliverables" splitting signal.'
    );
    assert.ok(
        claudeMd.includes(SHIPPABLE_PHASES),
        'CLAUDE.md must include the "2+ independently-shippable phases" splitting signal.'
    );
    assert.ok(
        claudeMd.includes('If the user explicitly asks for a single plan, respect that and write one.'),
        'CLAUDE.md must include the single-plan carve-out.'
    );

    // ============================================================
    // 8. deep-planning/SKILL.md  (section-scoped to Phase 0 body)
    // ============================================================
    // The signals must appear inside the executable Phase 0 section, not
    // just anywhere in the file — otherwise a green test can coexist with
    // a rule the agent never reaches.

    const deepPlanningPhase0Match = deepPlanningSkill.match(
        /### Phase 0: Planning Proposal([\s\S]*?)(?=### Phase 1)/
    );
    assert.ok(
        deepPlanningPhase0Match,
        'deep-planning/SKILL.md must have a Phase 0 section bounded by "### Phase 0: Planning Proposal" and "### Phase 1".'
    );
    const deepPlanningPhase0 = deepPlanningPhase0Match[1];
    assert.ok(
        deepPlanningPhase0.includes(DISTINCT_DELIVERABLES),
        'deep-planning/SKILL.md Phase 0 must include the "3+ distinct deliverables" splitting signal.'
    );
    assert.ok(
        deepPlanningPhase0.includes(SHIPPABLE_PHASES),
        'deep-planning/SKILL.md Phase 0 must include the "2+ independently-shippable phases" splitting signal.'
    );
    assert.ok(
        deepPlanningPhase0.includes('If the user explicitly asks for a single plan, respect that and write one.'),
        'deep-planning/SKILL.md Phase 0 must include the single-plan carve-out.'
    );

    // ============================================================
    // 9. improve-plan/SKILL.md  (section-scoped to ## Steps body)
    // ============================================================
    // improve-plan carries the flag-and-recommend variant (it cannot write
    // new plan files mid-improve), so we assert the signals + the
    // flag-and-recommend framing inside the ## Steps body — NOT the
    // auto-split framing. Also must NOT name the retired switchboard-split.

    const improvePlanStepsMatch = improvePlanSkill.match(
        /## Steps([\s\S]*?)(?=\n## )/
    );
    assert.ok(
        improvePlanStepsMatch,
        'improve-plan/SKILL.md must have a ## Steps section bounded by the next ## heading.'
    );
    const improvePlanSteps = improvePlanStepsMatch[1];
    assert.ok(
        improvePlanSteps.includes(DISTINCT_DELIVERABLES),
        'improve-plan/SKILL.md ## Steps must include the "3+ distinct deliverables" splitting signal.'
    );
    assert.ok(
        improvePlanSteps.includes(SHIPPABLE_PHASES),
        'improve-plan/SKILL.md ## Steps must include the "2+ independently-shippable phases" splitting signal.'
    );
    assert.ok(
        /recommend splitting/.test(improvePlanSteps),
        'improve-plan/SKILL.md ## Steps must include the flag-and-recommend framing ("recommend splitting").'
    );
    assert.ok(
        /do not silently strengthen/.test(improvePlanSteps),
        'improve-plan/SKILL.md ## Steps must include the "do not silently strengthen a mega-plan" framing.'
    );
    assert.ok(
        !/switchboard-split/.test(improvePlanSteps),
        'improve-plan/SKILL.md ## Steps must NOT name the retired switchboard-split workflow.'
    );

    console.log('prompt split-guidance sync test passed (9 surfaces in sync)');
}

try {
    run();
} catch (error) {
    console.error('prompt split-guidance sync test failed:', error);
    process.exit(1);
}
