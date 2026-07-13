'use strict';

// Sync test: verifies all FIVE plan-writing prompt surfaces carry the same
// Plan Sizing (auto-split) signals and that the old reactive-only "Feature
// Grouping:" header is gone from the chat base instructions. Guards against
// drift across:
//   1. DEFAULT_CHAT_BASE_INSTRUCTIONS  (src/services/agentPromptBuilder.ts)
//   2. .agents/workflows/switchboard-cloud.md
//   3. .agents/workflows/switchboard-memo.md
//   4. _buildMemoPlannerPrompt          (src/services/TaskViewerProvider.ts)
//   5. .agents/workflows/switchboard-remote.md
//
// Also guards the memo step-4/step-5 split-timing invariant: splitting must
// happen in step 4 (before any plan file is written), never in step 5 (which
// would orphan plan files inside the "no memos lost on failure" workflow).

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

    const promptBuilderSource = fs.readFileSync(promptBuilderPath, 'utf8');
    const taskViewerSource = fs.readFileSync(taskViewerPath, 'utf8');
    const cloudWorkflow = fs.readFileSync(cloudWorkflowPath, 'utf8');
    const memoWorkflow = fs.readFileSync(memoWorkflowPath, 'utf8');
    const remoteWorkflow = fs.readFileSync(remoteWorkflowPath, 'utf8');

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

    console.log('prompt split-guidance sync test passed (5 surfaces in sync)');
}

try {
    run();
} catch (error) {
    console.error('prompt split-guidance sync test failed:', error);
    process.exit(1);
}
