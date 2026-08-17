'use strict';

/**
 * Contract: the git worktree-removal guardrail follows worktree OWNERSHIP.
 *
 * `buildGitPolicyBlock` picks between two guardrail constants. The narrowed one
 * permits `git worktree remove`; the standard one forbids worktree deletion
 * outright. That permission is correct only for an agent that was told to create
 * its own worktrees (`useWorktreesPerPlan`). A feature dispatch does NOT qualify:
 * under `feature_worktree_mode = 'none'` no worktree exists, and under
 * `'per-feature'` the HOST provisions it and the host removes it.
 *
 * A `|| options?.featureMode === true` disjunct once rode along in the selector
 * argument at all ten call sites, so every feature dispatch on default settings
 * silently handed `git worktree remove` permission to an agent standing inside a
 * worktree it neither created nor owns.
 *
 * Two layers, because neither is sufficient alone:
 *  - behavioural, against the compiled builder: pins WHICH constant each flag
 *    selects and pins both constant bodies. "No contradictory sentences" is a
 *    property a grep can satisfy by deleting the wrong sentence; which guardrail
 *    shipped is not.
 *  - source-text, against the call sites: pins that all ten pass the bare flag.
 *    A re-added disjunct is invisible to the behavioural layer, which only ever
 *    sees the already-resolved boolean.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILDER_SRC = path.join(REPO_ROOT, 'src', 'services', 'agentPromptBuilder.ts');
const BUILDER_OUT = path.join(REPO_ROOT, 'out', 'services', 'agentPromptBuilder.js');

let buildGitPolicyBlock;
try {
    ({ buildGitPolicyBlock } = require(BUILDER_OUT));
} catch (e) {
    console.error(`Cannot load ${path.relative(REPO_ROOT, BUILDER_OUT)} — run \`npm run compile-tests\` first.\n${e.message}`);
    process.exit(1);
}

const src = () => fs.readFileSync(BUILDER_SRC, 'utf8');

let failures = 0;
function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); }
    catch (e) { failures++; console.error(`  ❌ ${name}\n     ${e.message}`); }
}

test('an agent told to self-provision worktrees may remove them', () => {
    const block = buildGitPolicyBlock({ guardrail: true, worktreePerPlanActive: true });
    assert.ok(
        /You may remove git worktrees you created with `git worktree remove`/.test(block),
        'the worktree-mode guardrail no longer permits `git worktree remove` for a self-provisioning agent'
    );
    assert.ok(
        !/branch\/worktree deletion/.test(block),
        'the worktree-mode guardrail now bans worktree deletion — the two constants have been collapsed'
    );
});

test('an agent that provisions nothing keeps the standard guardrail', () => {
    const block = buildGitPolicyBlock({ guardrail: true, worktreePerPlanActive: false });
    assert.ok(
        /branch\/worktree deletion/.test(block),
        'the standard guardrail no longer forbids worktree deletion'
    );
    assert.ok(
        !/git worktree remove/.test(block),
        'the standard guardrail now mentions `git worktree remove` — removal permission has leaked into the default path'
    );
});

test('a HOST-provisioned worktree does not widen the guardrail', () => {
    // feature_worktree_mode = 'per-feature': a worktree IS assigned (worktreeActive),
    // but the host provisioned it and the host removes it. Standing inside a worktree
    // is not ownership of one.
    const block = buildGitPolicyBlock({ guardrail: true, worktreeActive: true, worktreePerPlanActive: false });
    assert.ok(
        /branch\/worktree deletion/.test(block),
        'a host-provisioned worktree now selects the narrowed guardrail — the featureMode disjunct is back in some form'
    );
    assert.ok(
        !/git worktree remove/.test(block),
        'an agent inside a host-owned worktree was granted removal permission'
    );
});

test('the guardrail is opt-in — no guardrail flag, no safety clause', () => {
    assert.strictEqual(
        buildGitPolicyBlock({ worktreePerPlanActive: true }),
        '',
        'buildGitPolicyBlock emits a guardrail clause without the guardrail flag'
    );
});

test('all ten call sites select the guardrail on the worktree-per-plan flag alone', () => {
    const text = src();
    const withDisjunct = text.split('worktreePerPlanActive: useWorktreesPerPlanEnabled ||').length - 1;
    assert.strictEqual(
        withDisjunct, 0,
        `${withDisjunct} call site(s) widen the guardrail with a disjunct — the guardrail must read useWorktreesPerPlan alone`
    );
    const bare = text.split('worktreePerPlanActive: useWorktreesPerPlanEnabled').length - 1;
    assert.strictEqual(
        bare, 10,
        `expected 10 role call sites passing the bare flag, found ${bare} — a call site was added, removed, or rewritten`
    );
});

test('the custom-agent path reads its own addon flag', () => {
    assert.ok(
        /worktreePerPlanActive: addons\?\.useWorktreesPerPlan === true/.test(src()),
        'buildCustomAgentPrompt no longer gates the guardrail on its useWorktreesPerPlan addon'
    );
});

test('the inert featureWorktreeMode prompt plumbing stays out', () => {
    const text = src();
    assert.ok(
        !/featureWorktreeMode/.test(text),
        'featureWorktreeMode is back in the prompt builder — it governs worktree CREATION, never prompt text'
    );
    assert.ok(
        !/FeatureOrchestrationDirectiveContext/.test(text),
        'the empty FeatureOrchestrationDirectiveContext interface is back'
    );
});

if (failures > 0) { console.error(`\n${failures} contract failure(s)`); process.exit(1); }
console.log('\nAll feature-worktree guardrail contract assertions passed.');
