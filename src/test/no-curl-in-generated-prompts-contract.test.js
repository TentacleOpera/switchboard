'use strict';

/**
 * Contract: No generated agent prompt contains `curl`, `$BASE`, or
 * `api-server-port.txt`.
 *
 * The earlier curl-to-CLI migration swept the 38 agent-facing FILES (`.agents`,
 * `.claude`, `CLAUDE.md`) and passed, while seven `curl` strings sat in `src/`
 * as runtime-generated prompt text the host typed into agent terminals. This
 * test ratchets the fix: it asserts the property over GENERATED PROMPT TEXT,
 * not over a file list, so a future regression that reintroduces curl into a
 * template literal is caught regardless of which file it lands in.
 *
 * Covered surfaces (per the plan):
 *  - agentPromptBuilder.ts  — buildKanbanBatchPrompt, PHONE_A_FRIEND_DIRECTIVE,
 *                             PHONE_A_FRIEND_DONE_DIRECTIVE
 *  - KanbanProvider.ts      — _buildBatchDrivePrefix, _buildDrivePrefix
 *                             (private; tested via source-text extraction of the
 *                             prompt-building region, since the output is
 *                             assembled from string literals in that region)
 *  - teamWiring.ts          — NEW_CODING_HEAD_PROMPT, NEW_REVIEW_TEAM_HEAD_PROMPT
 *  - standingOrders.ts      — reviewer callback order instruction
 *  - standingOrderFragments.ts — buildMemberCompletionFragment,
 *                             buildHeadCompletionFragment, buildHeadNextFragment,
 *                             GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY
 *  - linkPresets.ts         — LINK_PRESETS templates (via resolvePreset)
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/no-curl-in-generated-prompts-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');

const FORBIDDEN = ['curl', '$BASE', 'api-server-port.txt'];

function assertNoForbidden(text, label) {
    for (const token of FORBIDDEN) {
        assert.ok(
            !text.includes(token),
            `${label}: generated prompt text must not contain "${token}" but did.\n---\n${text.slice(0, 500)}\n---`
        );
    }
}

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message.split('\n')[0] : err}`);
    }
}

function run() {
    console.log('\nno-curl-in-generated-prompts-contract\n');

    // ── 1. agentPromptBuilder.ts ────────────────────────────────────────

    const {
        buildKanbanBatchPrompt,
        PHONE_A_FRIEND_DIRECTIVE,
        PHONE_A_FRIEND_DONE_DIRECTIVE,
    } = require('../../out/services/agentPromptBuilder');

    const samplePlans = [
        {
            planId: 'plan-test-1',
            absolutePath: path.join(ROOT, '.switchboard', 'plans', 'plan-test-1.md'),
            topic: 'Test Plan Topic',
            isFeature: false,
            isSubtask: false,
        }
    ];

    const BUILTIN_ROLES = [
        'planner', 'reviewer', 'tester', 'lead', 'coder',
        'intern', 'analyst', 'ticket_updater', 'researcher', 'chat'
    ];

    check('buildKanbanBatchPrompt: no curl/$BASE/api-server-port.txt for any role (apiPort > 0)', () => {
        for (const role of BUILTIN_ROLES) {
            const prompt = buildKanbanBatchPrompt(role, samplePlans, {
                apiPort: 58312,
                workspaceRoot: ROOT,
                phoneAFriendEnabled: true,
            });
            assertNoForbidden(prompt, `buildKanbanBatchPrompt(${role})`);
        }
    });

    check('buildKanbanBatchPrompt: no curl/$BASE/api-server-port.txt for any role (apiPort = 0)', () => {
        for (const role of BUILTIN_ROLES) {
            const prompt = buildKanbanBatchPrompt(role, samplePlans, {
                apiPort: 0,
                workspaceRoot: ROOT,
            });
            assertNoForbidden(prompt, `buildKanbanBatchPrompt(${role}, apiPort=0)`);
        }
    });

    check('PHONE_A_FRIEND_DIRECTIVE: no curl/$BASE/api-server-port.txt', () => {
        const directive = PHONE_A_FRIEND_DIRECTIVE(58312, 'coder', 'Coder-1', 'dispatch-1');
        assertNoForbidden(directive, 'PHONE_A_FRIEND_DIRECTIVE');
    });

    check('PHONE_A_FRIEND_DONE_DIRECTIVE: no curl/$BASE/api-server-port.txt (post-batch)', () => {
        const directive = PHONE_A_FRIEND_DONE_DIRECTIVE(58312, 'friend', 'plan.md');
        assertNoForbidden(directive, 'PHONE_A_FRIEND_DONE_DIRECTIVE(post-batch)');
    });

    check('PHONE_A_FRIEND_DONE_DIRECTIVE: no curl/$BASE/api-server-port.txt (pre-review)', () => {
        const directive = PHONE_A_FRIEND_DONE_DIRECTIVE(58312, 'friend', 'plan.md', 'pre-review');
        assertNoForbidden(directive, 'PHONE_A_FRIEND_DONE_DIRECTIVE(pre-review)');
    });

    // ── 2. KanbanProvider.ts drive prefix source ────────────────────────

    const KANBAN_PROVIDER_SRC = fs.readFileSync(
        path.join(ROOT, 'src', 'services', 'KanbanProvider.ts'), 'utf8'
    );

    check('KanbanProvider _buildBatchDrivePrefix + _buildDrivePrefix source: no curl/$BASE/api-server-port.txt', () => {
        // Extract the source region from the `private async _buildBatchDrivePrefix`
        // declaration through the `private async _buildFeatureDirectivePrefix`
        // declaration. These functions assemble the drive prefix from string
        // literals — if the source contains a forbidden token in a string
        // literal, the generated output will too. Anchoring on the `private async`
        // declaration (not the bare name) avoids matching doc comments that
        // mention the function by name before the actual definition.
        const startMatch = KANBAN_PROVIDER_SRC.match(/private async _buildBatchDrivePrefix\(/);
        const endMatch = KANBAN_PROVIDER_SRC.match(/private async _buildFeatureDirectivePrefix\(/);
        assert.ok(startMatch && endMatch && endMatch.index > startMatch.index, 'could not locate drive prefix region');
        const region = KANBAN_PROVIDER_SRC.slice(startMatch.index, endMatch.index);
        // Mask out comments (lines starting with // or inside /* */) so a
        // comment referencing the migration history does not trip the test.
        const masked = region
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .replace(/\/\/[^\n]*/g, '');
        assertNoForbidden(masked, 'KanbanProvider drive prefix source');
    });

    // ── 3. teamWiring.ts ─────────────────────────────────────────────────

    const {
        NEW_CODING_HEAD_PROMPT,
        NEW_REVIEW_TEAM_HEAD_PROMPT,
    } = require('../../out/services/teamWiring');

    check('NEW_CODING_HEAD_PROMPT: no curl/$BASE/api-server-port.txt', () => {
        assertNoForbidden(NEW_CODING_HEAD_PROMPT, 'NEW_CODING_HEAD_PROMPT');
    });

    check('NEW_REVIEW_TEAM_HEAD_PROMPT: no curl/$BASE/api-server-port.txt', () => {
        assertNoForbidden(NEW_REVIEW_TEAM_HEAD_PROMPT, 'NEW_REVIEW_TEAM_HEAD_PROMPT');
    });

    // ── 4. standingOrderFragments.ts ────────────────────────────────────

    const {
        buildMemberCompletionFragment,
        buildHeadCompletionFragment,
        buildHeadNextFragment,
        GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY,
    } = require('../../out/services/standingOrderFragments');

    check('buildMemberCompletionFragment: no curl/$BASE/api-server-port.txt', () => {
        const text = buildMemberCompletionFragment({ teamId: 'team_test', headName: 'Lead' });
        assertNoForbidden(text, 'buildMemberCompletionFragment');
    });

    check('buildHeadCompletionFragment: no curl/$BASE/api-server-port.txt', () => {
        const text = buildHeadCompletionFragment();
        assertNoForbidden(text, 'buildHeadCompletionFragment');
    });

    check('buildHeadNextFragment: no curl/$BASE/api-server-port.txt', () => {
        const text = buildHeadNextFragment({ teamId: 'team_test' });
        assertNoForbidden(text, 'buildHeadNextFragment');
    });

    check('GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY: no curl/$BASE/api-server-port.txt', () => {
        assertNoForbidden(GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY, 'GLOBAL_QUEUE_COMPLETION_FRAGMENT_BODY');
    });

    // ── 5. linkPresets.ts ────────────────────────────────────────────────

    const {
        LINK_PRESETS,
        resolvePreset,
    } = require('../../out/services/linkPresets');

    check('LINK_PRESETS templates (resolved): no curl/$BASE/api-server-port.txt', () => {
        for (const preset of LINK_PRESETS) {
            if (!preset.template) { continue; }
            const resolved = resolvePreset(preset.id, 'parent-seat', 'child-seat');
            assertNoForbidden(resolved, `resolvePreset(${preset.id})`);
        }
    });

    // ── 6. standingOrders.ts reviewer callback ──────────────────────────

    // The reviewer callback order is built by upsertReviewerCallbackOrder,
    // which composes a CLI-based instruction. We test the source text of the
    // instruction template to ensure no curl/$BASE/api-server-port.txt.
    const STANDING_ORDERS_SRC = fs.readFileSync(
        path.join(ROOT, 'src', 'services', 'standingOrders.ts'), 'utf8'
    );

    check('standingOrders.ts reviewer callback instruction: no curl/$BASE/api-server-port.txt', () => {
        // Extract the instruction template from upsertReviewerCallbackOrder.
        // It is a template literal starting with `${reviewerName} is your reviewer`.
        const match = STANDING_ORDERS_SRC.match(
            /instruction\s*=\s*`[\s\S]*?`/
        );
        assert.ok(match, 'reviewer callback instruction not found in standingOrders.ts');
        // The template uses ${reviewerName} — substitute a sample value.
        const template = match[0].replace(/instruction\s*=\s*`/, '').replace(/`$/, '');
        const resolved = template.replace(/\$\{reviewerName\}/g, 'Reviewer-1');
        assertNoForbidden(resolved, 'reviewer callback instruction');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
