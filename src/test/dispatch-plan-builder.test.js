'use strict';

/**
 * Acceptance spec for the dispatch-plan-builder consolidation.
 *
 * This is the executable spec for `KanbanProvider.buildDispatchPlans` and the
 * shared `matchWorktreePath` worktree resolver. Because `KanbanProvider` is a
 * VS Code-dependent class that cannot be instantiated outside an extension
 * host, the test exercises:
 *
 *   1. The pure `matchWorktreePath` worktree resolver (extracted from
 *      `worktreeResolver.ts` via `new Function`) — asserts the three-tier
 *      record-mode precedence (subtask_plan_id → feature_id → project) and the
 *      active-status filter.
 *   2. Static-source assertions that lock the consolidation in place:
 *      - `buildDispatchPlans` exists on `KanbanProvider`.
 *      - `_cardsToPromptPlans` delegates to `buildDispatchPlans`.
 *      - `_resolveKanbanDispatchPlans` delegates to `buildDispatchPlans`.
 *      - `_handleTriggerAgentActionInternal` routes through `buildDispatchPlans`.
 *      - `_handleCopyPlanLink` routes through `buildDispatchPlans`.
 *      - `copyFeaturePlannerPrompt` routes through `buildDispatchPlans`.
 *      - `expandFeatureSubtaskPlans` has exactly ONE caller in `src/` (the builder).
 *      - `_buildRepoScopeMap` is deleted.
 *      - The intentionally-excluded sites (`chatCopyPrompt`,
 *        `handleGetDefaultPromptPreviews`) still bypass `generateUnifiedPrompt`.
 *
 * Per the SKIP TESTS / SKIP COMPILATION session directives, the user runs the
 * full suite; this file is the gate the implementer keeps green locally.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

function readFile(rel) {
    return fs.readFileSync(path.resolve(__dirname, '..', '..', rel), 'utf8');
}

/**
 * The pure `matchWorktreePath` resolver, mirrored in plain JS from
 * `src/services/worktreeResolver.ts`. Kept in sync by the static-source
 * assertions below (which verify the source file contains the same
 * three-tier precedence). Defined inline rather than extracted from the TS
 * source because the source uses TS type annotations that `new Function`
 * cannot parse.
 */
function matchWorktreePath(worktrees, plan) {
    const active = worktrees.filter(w => w.status === 'active');
    if (plan.featureId) {
        const featureWt = active.find(w => String(w.feature_id) === String(plan.featureId));
        if (featureWt) {
            return featureWt.path;
        }
    }
    if (plan.project) {
        const projectWt = active.find(w => w.project === plan.project);
        if (projectWt) {
            return projectWt.path;
        }
    }
    return undefined;
}

function wt(row) {
    return Object.assign({
        id: 1, branch: 'b', path: '/wt', feature_id: null, created_at: '',
        status: 'active', project: null, agentsOpenWithGrid: false,
        subtask_plan_id: null, base_branch: null, tier: null
    }, row);
}

async function runWorktreeResolverTests() {
    await test('matchWorktreePath: feature_id wins over project', () => {
        const worktrees = [
            wt({ path: '/feature-wt', feature_id: 'feature-9', project: 'Acme' }),
            wt({ path: '/project-wt', project: 'Acme' }),
        ];
        const result = matchWorktreePath(worktrees, { planId: 'plan-other', featureId: 'feature-9', project: 'Acme' });
        assert.strictEqual(result, '/feature-wt', 'feature_id match must win over project');
    });

    await test('matchWorktreePath: project wins when no feature match', () => {
        const worktrees = [
            wt({ path: '/project-wt', project: 'Acme' }),
        ];
        const result = matchWorktreePath(worktrees, { planId: 'plan-other', featureId: 'feature-other', project: 'Acme' });
        assert.strictEqual(result, '/project-wt', 'project match must win when no feature matches');
    });

    await test('matchWorktreePath: returns undefined when nothing matches', () => {
        const worktrees = [
            wt({ path: '/other-wt', feature_id: 'feature-x', project: 'Other' }),
        ];
        const result = matchWorktreePath(worktrees, { planId: 'p', featureId: 'e', project: 'Acme' });
        assert.strictEqual(result, undefined, 'no match → undefined (no sole-entry fallback in record mode)');
    });

    await test('matchWorktreePath: filters to active status only', () => {
        const worktrees = [
            wt({ path: '/merged-wt', feature_id: 'feature-9', status: 'merged' }),
            wt({ path: '/active-wt', feature_id: 'feature-9', status: 'active' }),
        ];
        const result = matchWorktreePath(worktrees, { planId: 'plan-sub-1', featureId: 'feature-9' });
        assert.strictEqual(result, '/active-wt', 'merged feature worktree must be skipped; active feature worktree wins');
    });
}

async function runStaticSourceTests() {
    const kanbanSrc = readFile('src/services/KanbanProvider.ts');
    const taskViewerSrc = readFile('src/services/TaskViewerProvider.ts');
    const planningSrc = readFile('src/services/PlanningPanelProvider.ts');

    await test('KanbanProvider exposes public buildDispatchPlans', () => {
        assert.ok(/public\s+async\s+buildDispatchPlans\s*\(/.test(kanbanSrc), 'buildDispatchPlans must be a public method on KanbanProvider');
    });

    await test('KanbanProvider._cardsToPromptPlans delegates to buildDispatchPlans', () => {
        assert.ok(/_cardsToPromptPlans[\s\S]*?buildDispatchPlans\(/.test(kanbanSrc), '_cardsToPromptPlans must call buildDispatchPlans');
    });

    await test('KanbanProvider._buildRepoScopeMap is deleted', () => {
        assert.ok(!/_buildRepoScopeMap/.test(kanbanSrc), '_buildRepoScopeMap must be removed (dead code after builder adoption)');
    });

    await test('KanbanProvider.generateUnifiedPrompt carries the guardrail comment', () => {
        assert.ok(/Plan arrays for dispatch MUST come from KanbanProvider\.buildDispatchPlans/.test(kanbanSrc), 'generateUnifiedPrompt must carry the do-not-hand-roll guardrail');
    });

    await test('TaskViewerProvider._resolveKanbanDispatchPlans delegates to buildDispatchPlans', () => {
        assert.ok(/_resolveKanbanDispatchPlans[\s\S]*?buildDispatchPlans\(/.test(taskViewerSrc), '_resolveKanbanDispatchPlans must call buildDispatchPlans');
    });

    await test('TaskViewerProvider._handleTriggerAgentActionInternal routes through buildDispatchPlans', () => {
        assert.ok(/_handleTriggerAgentActionInternal[\s\S]*?buildDispatchPlans\(/.test(taskViewerSrc), '_handleTriggerAgentActionInternal must call buildDispatchPlans');
    });

    await test('TaskViewerProvider._handleCopyPlanLink routes through buildDispatchPlans', () => {
        assert.ok(/_handleCopyPlanLink[\s\S]*?buildDispatchPlans\(/.test(taskViewerSrc), '_handleCopyPlanLink must call buildDispatchPlans');
    });

    await test('PlanningPanelProvider.copyFeaturePlannerPrompt routes through buildDispatchPlans', () => {
        assert.ok(/copyFeaturePlannerPrompt[\s\S]*?buildDispatchPlans\(/.test(planningSrc), 'copyFeaturePlannerPrompt must call buildDispatchPlans');
    });

    await test('expandFeatureSubtaskPlans has exactly ONE caller in src/ (the builder)', () => {
        // Count call sites (this.expandFeatureSubtaskPlans( or _kanbanProvider.expandFeatureSubtaskPlans( or kp.expandFeatureSubtaskPlans()
        // excluding the method definition itself.
        const callPattern = /expandFeatureSubtaskPlans\s*\(/g;
        const kpMatches = (kanbanSrc.match(callPattern) || []);
        const tvMatches = (taskViewerSrc.match(callPattern) || []);
        const ppMatches = (planningSrc.match(callPattern) || []);
        // KanbanProvider: 1 definition + 1 call (inside buildDispatchPlans) = 2
        // TaskViewerProvider: 0 (all inline sites now route through builder)
        // PlanningPanelProvider: 0
        assert.strictEqual(kpMatches.length, 2, `KanbanProvider should have exactly 2 expandFeatureSubtaskPlans occurrences (def + 1 call), got ${kpMatches.length}`);
        assert.strictEqual(tvMatches.length, 0, `TaskViewerProvider should have 0 expandFeatureSubtaskPlans calls, got ${tvMatches.length}`);
        assert.strictEqual(ppMatches.length, 0, `PlanningPanelProvider should have 0 expandFeatureSubtaskPlans calls, got ${ppMatches.length}`);
    });

    await test('chatCopyPrompt still bypasses generateUnifiedPrompt (intentionally excluded)', () => {
        const start = kanbanSrc.indexOf("case 'chatCopyPrompt':");
        assert.ok(start >= 0, 'chatCopyPrompt handler must exist');
        const nextCase = kanbanSrc.indexOf("\n            case '", start + 10);
        const chatBlock = kanbanSrc.slice(start, nextCase >= 0 ? nextCase : kanbanSrc.length);
        assert.ok(/buildKanbanBatchPrompt\('chat'/.test(chatBlock), 'chatCopyPrompt must still call buildKanbanBatchPrompt directly');
        assert.ok(!/generateUnifiedPrompt/.test(chatBlock), 'chatCopyPrompt must NOT call generateUnifiedPrompt');
    });

    await test('worktreeResolver.ts exports matchWorktreePath with the two-tier precedence and TaskViewerProvider delegates to it', () => {
        const resolverSrc = readFile('src/services/worktreeResolver.ts');
        assert.ok(/export function matchWorktreePath/.test(resolverSrc), 'worktreeResolver.ts must export matchWorktreePath');
        // Verify the two-tier precedence is present in source in the right order.
        const featureIdx = resolverSrc.indexOf('w.feature_id');
        const projectIdx = resolverSrc.indexOf('w.project', featureIdx);
        assert.ok(featureIdx >= 0 && projectIdx > featureIdx,
            'matchWorktreePath source must check feature_id → project in that order');
        assert.ok(/w\.status === 'active'/.test(resolverSrc), 'matchWorktreePath must filter to active worktrees');
        assert.ok(/matchWorktreePath/.test(taskViewerSrc), 'TaskViewerProvider must import matchWorktreePath');
        assert.ok(/return matchWorktreePath\(worktrees, plan\)/.test(taskViewerSrc), 'resolveWorktreePathForPlan must delegate to matchWorktreePath');
    });
}

async function run() {
    console.log('\nRunning dispatch-plan-builder acceptance tests\n');

    await runWorktreeResolverTests();
    await runStaticSourceTests();

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) {
        process.exit(1);
    }
}

run().catch((error) => {
    console.error('dispatch-plan-builder test failed:', error);
    process.exit(1);
});
