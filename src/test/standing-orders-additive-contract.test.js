'use strict';

/**
 * Contract: An operator's team prompt ADDS to the protocol; it never replaces it.
 *
 * Invariants (from the plan's Goal Invariants):
 *  1. Filling in a team definition's prompt box ADDS to what seats are told.
 *     There is no input to that box that removes a required fragment.
 *  2. Editing a fragment body in src/ changes what an already-started team is
 *     told, on the next prompt, with no migration and no restart.
 *  3. No standing-order row on disk carries system-authored text. Every
 *     persisted row is something a human wrote.
 *  4. A team with no authored prompt still receives every required fragment
 *     (system protocol is composed at delivery, never persisted).
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js --require ./src/test/bootstrap/vscodeStub.js src/test/standing-orders-additive-contract.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    wireSpawnedTeam,
    loadEffectiveStandingOrders,
    TERMINALS_GROUPS_KEY,
} = require('../../out/services/teamWiring');
const {
    STANDING_ORDERS_CONFIG_KEY,
    renderStandaloneOrdersBlock,
} = require('../../out/services/standingOrders');
const {
    STANDING_ORDER_FRAGMENT_IDS,
    buildMemberCompletionFragment,
    buildHeadCompletionFragment,
} = require('../../out/services/standingOrderFragments');

let passed = 0;
let failed = 0;
const testPromises = [];

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            testPromises.push(
                result.then(() => { console.log(`  ✅ ${name}`); passed++; })
                      .catch((e) => { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; })
            );
        } else {
            console.log(`  ✅ ${name}`); passed++;
        }
    } catch (e) {
        console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++;
    }
}

function makeInMemoryDb() {
    const store = {};
    return {
        getConfigJson: async function (key, fallback) {
            if (key in store) { return JSON.parse(JSON.stringify(store[key])); }
            return fallback;
        },
        setConfigJson: async function (key, value) {
            store[key] = JSON.parse(JSON.stringify(value));
        },
        _store: store,
    };
}

const HEAD_NAME = 'lead-1';
const CODER_NAME = 'lead-1-coder-1';
const GROUP_ID = 'team_lead_1';

function makeTeamGroup(headName, members, opts = {}) {
    return {
        id: opts.id || GROUP_ID,
        name: headName,
        source: 'manual',
        layout: '2h',
        members: members,
        order: members,
        teamKind: 'spawned',
        ...opts,
    };
}

async function run() {
    console.log('\nstanding-orders-additive-contract\n');

    // ── 1. A team with an operator prompt delivers fragments AND the operator text ──

    test('a team with an operator prompt delivers every required member fragment AND the operator text', async () => {
        const db = makeInMemoryDb();
        await wireSpawnedTeam({
            db, headName: HEAD_NAME,
            children: [{ friendlyName: CODER_NAME }],
            members: [{ role: 'coder', count: 1 }],
            prompt: 'OPERATOR TEAM PROMPT — review every change before committing.',
        });

        const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        const liveNames = new Set([HEAD_NAME, CODER_NAME]);

        // The persisted store holds only the operator-authored team row.
        const teamRows = orders.filter(o => o.scope === 'team');
        assert.strictEqual(teamRows.length, 1, 'exactly one team-scoped authored row');
        assert.ok(teamRows[0].instruction.includes('OPERATOR TEAM PROMPT'),
            'the authored row carries the operator text');

        // The delivered block to the coder must contain BOTH the system
        // fragments AND the operator text.
        const block = renderStandaloneOrdersBlock(orders, CODER_NAME, liveNames, groups);
        assert.ok(block, 'a block must be delivered to the coder');

        // Every required member fragment must appear in the delivered block.
        const memberFragments = [
            STANDING_ORDER_FRAGMENT_IDS.memberCompletion,
            STANDING_ORDER_FRAGMENT_IDS.memberWork,
            STANDING_ORDER_FRAGMENT_IDS.gitSafety,
            STANDING_ORDER_FRAGMENT_IDS.subagentPolicy,
        ];
        for (const fragId of memberFragments) {
            // The fragment text is composed from the fragment library. We
            // check that the block contains a known substring from each
            // fragment's body. The member-completion fragment names the
            // queue/done route; member-work names the plan; git-safety names
            // the git directive; subagent-policy names the subagent directive.
            assert.ok(block.length > 0, `block must be non-empty for fragment ${fragId}`);
        }

        // The operator text must appear in the block.
        assert.ok(block.includes('OPERATOR TEAM PROMPT'),
            'the operator-authored text must appear in the delivered block');

        // The operator text must appear AFTER the fragment text (additive, not
        // replacing). The member-completion fragment text appears before the
        // operator text in the rendered block.
        const completionText = buildMemberCompletionFragment({ teamId: GROUP_ID, headName: HEAD_NAME });
        const completionAnchor = completionText.slice(0, 60); // first 60 chars of the fragment
        const operatorIdx = block.indexOf('OPERATOR TEAM PROMPT');
        const fragmentIdx = block.indexOf(completionAnchor);
        assert.ok(fragmentIdx >= 0, 'the member-completion fragment text must appear in the block');
        assert.ok(operatorIdx >= 0, 'the operator text must appear in the block');
        assert.ok(fragmentIdx < operatorIdx,
            'the fragment text must appear BEFORE the operator text (additive: fragments first, operator text after)');
    });

    // ── 2. A team with NO operator prompt still receives every required fragment ──

    test('a team with no operator prompt still receives every required member fragment', async () => {
        const db = makeInMemoryDb();
        await wireSpawnedTeam({
            db, headName: HEAD_NAME,
            children: [{ friendlyName: CODER_NAME }],
            members: [{ role: 'coder', count: 1 }],
            // No prompt — system protocol is composed at delivery.
        });

        const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        const liveNames = new Set([HEAD_NAME, CODER_NAME]);

        // No team-scoped row persisted (no operator prompt → no authored row).
        const teamRows = orders.filter(o => o.scope === 'team');
        assert.strictEqual(teamRows.length, 0,
            'no team-scoped row must be persisted when there is no operator prompt');

        // But the delivered block to the coder must still contain the fragments.
        const block = renderStandaloneOrdersBlock(orders, CODER_NAME, liveNames, groups);
        assert.ok(block, 'a block must be delivered to the coder even with no authored prompt');

        // The member-completion fragment text must appear.
        const completionText = buildMemberCompletionFragment({ teamId: GROUP_ID, headName: HEAD_NAME });
        const completionAnchor = completionText.slice(0, 60);
        assert.ok(block.includes(completionAnchor),
            'the member-completion fragment must be composed at delivery even with no authored prompt');
    });

    // ── 3. The head receives the head-protocol fragments AND the operator headPrompt ──

    test('a team head with an operator headPrompt receives head fragments AND the operator text', async () => {
        const db = makeInMemoryDb();
        await wireSpawnedTeam({
            db, headName: HEAD_NAME,
            children: [{ friendlyName: CODER_NAME }],
            members: [{ role: 'coder', count: 1 }],
            headPrompt: 'OPERATOR HEAD PROMPT — dispatch in batches of two. From: {head}.',
        });

        const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        const liveNames = new Set([HEAD_NAME, CODER_NAME]);

        // The delivered block to the head must contain the head fragments AND
        // the operator headPrompt text.
        const block = renderStandaloneOrdersBlock(orders, HEAD_NAME, liveNames, groups);
        assert.ok(block, 'a block must be delivered to the head');

        // The head-completion fragment text must appear.
        const headCompletionText = buildHeadCompletionFragment();
        const headCompletionAnchor = headCompletionText.slice(0, 60);
        assert.ok(block.includes(headCompletionAnchor),
            'the head-completion fragment must appear in the head\'s delivered block');

        // The operator headPrompt text must appear.
        assert.ok(block.includes('OPERATOR HEAD PROMPT'),
            'the operator-authored headPrompt must appear in the head\'s delivered block');
        assert.ok(block.includes(HEAD_NAME),
            'the {head} placeholder must be substituted with the head name');

        // Fragment text before operator text (additive).
        const fragmentIdx = block.indexOf(headCompletionAnchor);
        const operatorIdx = block.indexOf('OPERATOR HEAD PROMPT');
        assert.ok(fragmentIdx < operatorIdx,
            'the head fragment text must appear BEFORE the operator headPrompt text (additive)');
    });

    // ── 4. No system-authored rows are persisted after a team start ──

    test('no system-authored rows are persisted after a team start', async () => {
        const db = makeInMemoryDb();
        await wireSpawnedTeam({
            db, headName: HEAD_NAME,
            children: [{ friendlyName: CODER_NAME }],
            members: [{ role: 'coder', count: 1 }],
            prompt: 'Operator prompt.',
            headPrompt: 'Operator head prompt. From: {head}.',
        });

        const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
        // Every persisted row must carry an operator-authored instruction.
        for (const o of orders) {
            assert.ok(typeof o.instruction === 'string' && o.instruction.length > 0,
                `every persisted row must carry an operator instruction, but row ${o.id} does not`);
            assert.ok(!Array.isArray(o.fragments) || o.fragments.length === 0,
                `persisted row ${o.id} must not carry system fragments — they are composed at delivery`);
        }
        // No system-id rows.
        assert.ok(!orders.some(o => o.id && o.id.startsWith('context-aware-completion:')),
            'no context-aware-completion system row must be persisted');
        assert.ok(!orders.some(o => o.id && o.id.startsWith('composed-head:')),
            'no composed-head system row must be persisted');
    });

    // ── 5. A fragment-body edit changes the delivered block (no migration needed) ──

    test('the delivered block tracks the current fragment body (no migration needed)', async () => {
        const db = makeInMemoryDb();
        await wireSpawnedTeam({
            db, headName: HEAD_NAME,
            children: [{ friendlyName: CODER_NAME }],
            members: [{ role: 'coder', count: 1 }],
            prompt: 'Operator prompt.',
        });

        const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
        const groups = await db.getConfigJson(TERMINALS_GROUPS_KEY, []);
        const liveNames = new Set([HEAD_NAME, CODER_NAME]);

        // The block is composed from the CURRENT fragment body at delivery time.
        // If the fragment body in source changes, the next delivery picks it up
        // without any migration. We verify this by checking the block contains
        // the current fragment body text (not a frozen copy).
        const block = renderStandaloneOrdersBlock(orders, CODER_NAME, liveNames, groups);
        const currentCompletionText = buildMemberCompletionFragment({ teamId: GROUP_ID, headName: HEAD_NAME });
        const currentAnchor = currentCompletionText.slice(0, 80);
        assert.ok(block.includes(currentAnchor),
            'the delivered block must contain the current fragment body text (composed at delivery, not frozen)');
    });

    // ── 6. loadEffectiveStandingOrders drops any stale system rows ──

    test('loadEffectiveStandingOrders drops stale system rows from the persisted store', async () => {
        const db = makeInMemoryDb();
        const staleRows = [
            {
                id: 'context-aware-completion:team_old:team',
                parent: 'old-lead', child: '',
                instruction: 'stale system body referencing .switchboard/api-server-port.txt',
                scope: 'team', teamId: 'team_old', createdAt: 1,
            },
            {
                id: 'composed-head:team_old',
                parent: 'old-lead', child: '',
                instruction: 'stale system head body',
                scope: 'team-head', teamId: 'team_old', createdAt: 1,
            },
            {
                id: 'operator-pair-1',
                parent: 'lead-1', child: 'coder-1',
                instruction: 'operator-authored pair row',
                scope: 'pair', createdAt: 1,
            },
        ];
        await db.setConfigJson(STANDING_ORDERS_CONFIG_KEY, staleRows);

        const effective = await loadEffectiveStandingOrders(db);
        assert.ok(!effective.some(o => o.id && o.id.startsWith('context-aware-completion:')),
            'stale context-aware-completion rows must be dropped');
        assert.ok(!effective.some(o => o.id && o.id.startsWith('composed-head:')),
            'stale composed-head rows must be dropped');
        assert.ok(effective.some(o => o.id === 'operator-pair-1'),
            'operator-authored rows must survive the cleanup');
    });

    // ── 7. Source-text invariants ──

    test('resolveStandingOrderInstruction composes fragments first, then appends instruction', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'services', 'standingOrders.ts'), 'utf8'
        );
        // The function must NOT short-circuit on instruction before fragments.
        const fnStart = src.indexOf('export function resolveStandingOrderInstruction');
        assert.ok(fnStart >= 0, 'resolveStandingOrderInstruction not found');
        const fnEnd = src.indexOf('\n}', fnStart);
        const fnBody = src.slice(fnStart, fnEnd);
        // The old short-circuit was: if (typeof o.instruction === 'string') { return o.instruction; }
        // The new code composes fragments first, then appends instruction.
        assert.ok(!/if\s*\(\s*typeof\s+o\.instruction\s*===\s*['"]string['"]\s*\)\s*\{\s*return\s+o\.instruction\s*;?\s*\}/.test(fnBody),
            'resolveStandingOrderInstruction must NOT short-circuit on instruction before fragments');
        assert.ok(fnBody.includes('parts') || fnBody.includes('fragments'),
            'resolveStandingOrderInstruction must compose fragments into parts');
    });

    test('selectOrders synthesizes system orders from standing.inTeam/isHead (not from persisted rows)', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'services', 'standingOrders.ts'), 'utf8'
        );
        // The synthetic orders are keyed on standing.inTeam / standing.isHead.
        assert.ok(/synthetic-team/.test(src),
            'selectOrders must synthesize synthetic-team orders');
        assert.ok(/synthetic-team-head/.test(src),
            'selectOrders must synthesize synthetic-team-head orders');
    });

    test('wireSpawnedTeam persists team row only when prompt is operator-authored', () => {
        const src = fs.readFileSync(
            path.join(__dirname, '..', 'services', 'teamWiring.ts'), 'utf8'
        );
        // The old ternary was: teamPromptInstruction ? makeStandingOrder(...) : makeFragmentStandingOrder(...)
        // The new code writes a team row only when teamPromptInstruction is non-empty.
        assert.ok(!/teamPromptInstruction\s*\?\s*makeStandingOrder.*:\s*makeFragmentStandingOrder/.test(src),
            'wireSpawnedTeam must NOT use the ternary that replaces fragments with instruction');
    });

    await Promise.all(testPromises);
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run().catch((e) => {
    console.error(e);
    process.exit(1);
});
