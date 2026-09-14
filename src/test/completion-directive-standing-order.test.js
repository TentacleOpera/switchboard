'use strict';

/**
 * Completion-directive standing order contract.
 *
 * Verifies the completion directive migrated from prompt-injected text to a
 * role-scoped standing order:
 *   - COMPLETION_REPORT: absent from buildKanbanBatchPrompt output for all
 *     code-touching roles.
 *   - COMPLETION_REPORT: present in applyStandingOrders output when a
 *     role-scoped coder order exists.
 *   - CLI form (switchboard done --from), not the old POST /kanban/queue/done.
 *   - No "against the port in .switchboard/api-server-port.txt" wording.
 *   - No literal "<your terminal name>" when interpolation receives a name.
 *   - installCompletionDirectiveOrder(db, 'coder') is idempotent: exactly one
 *     order with id === 'completion-directive:role:coder', parent: '', scope: 'role'.
 *
 * Run: node --require ./src/test/bootstrap/sandboxStateHome.js src/test/completion-directive-standing-order.test.js
 */

const assert = require('assert');
const path = require('path');

require(path.join(process.cwd(), 'src', 'test', 'bootstrap', 'sandboxStateHome.js'));

const {
    applyStandingOrders,
    renderStandaloneOrdersBlock,
    installCompletionDirectiveOrder,
    COMPLETION_DIRECTIVE_ORDER_INSTRUCTION,
    COMPLETION_DIRECTIVE_ROLES,
    STANDING_ORDERS_CONFIG_KEY,
} = require(path.join(process.cwd(), 'out', 'services', 'standingOrders.js'));

const {
    buildKanbanBatchPrompt,
    CODING_COMPLETION_REPORT_DIRECTIVE,
} = require(path.join(process.cwd(), 'out', 'services', 'agentPromptBuilder.js'));

let passed = 0;
let failed = 0;

async function check(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failed++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
    }
}

function makePlans(n) {
    const plans = [];
    for (let i = 0; i < n; i++) {
        plans.push({
            planId: `plan-${i}`,
            title: `Plan ${i}`,
            planFile: `.switchboard/plans/plan-${i}.md`,
            kanbanColumn: 'LEAD CODED',
        });
    }
    return plans;
}

function makeDb(initialOrders) {
    let orders = initialOrders || [];
    return {
        getConfigJson: async () => orders,
        setConfigJson: async (_key, value) => { orders = value; },
    };
}

(async () => {
    console.log('completion-directive standing order contract\n');

    // 1. COMPLETION_REPORT: absent from buildKanbanBatchPrompt for all code-touching roles.
    for (const role of ['reviewer', 'lead', 'coder', 'intern']) {
        await check(`COMPLETION_REPORT: absent from buildKanbanBatchPrompt for role '${role}'`, () => {
            const prompt = buildKanbanBatchPrompt(role, makePlans(1), {
                switchboardSafeguardsEnabled: false,
                gitProhibitionEnabled: false,
            });
            assert.ok(!prompt.includes('COMPLETION REPORT:'),
                `COMPLETION REPORT: must be absent from buildKanbanBatchPrompt output for role '${role}'`);
        });
    }

    // 2. COMPLETION_REPORT: present in applyStandingOrders when coder order exists.
    await check('COMPLETION_REPORT: present in applyStandingOrders when coder order exists', () => {
        const orders = [{
            id: 'completion-directive:role:coder',
            parent: '',
            child: '',
            instruction: COMPLETION_DIRECTIVE_ORDER_INSTRUCTION,
            createdAt: Date.now(),
            scope: 'role',
            role: 'coder',
        }];
        const roleMap = new Map([['Coding-coder-1', 'coder']]);
        const live = new Set(['Coding-coder-1']);
        const rendered = applyStandingOrders('task', 'Coding-coder-1', orders, live, [], roleMap, {}, { terminalName: 'Coding-coder-1' });
        assert.ok(rendered.includes('COMPLETION REPORT:'),
            'COMPLETION REPORT: must be present in applyStandingOrders output when a coder order exists');
    });

    // 3. CLI form (switchboard done --from), not POST /kanban/queue/done.
    await check('standing order uses CLI form (switchboard done --from)', () => {
        assert.ok(COMPLETION_DIRECTIVE_ORDER_INSTRUCTION.includes('switchboard done --from'),
            'COMPLETION_DIRECTIVE_ORDER_INSTRUCTION must use the CLI form (switchboard done --from)');
        assert.ok(!COMPLETION_DIRECTIVE_ORDER_INSTRUCTION.includes('POST /kanban/queue/done'),
            'COMPLETION_DIRECTIVE_ORDER_INSTRUCTION must NOT reference the old POST /kanban/queue/done form');
    });

    // 4. No "against the port in .switchboard/api-server-port.txt" wording.
    await check('no "against the port in .switchboard/api-server-port.txt" wording', () => {
        assert.ok(!COMPLETION_DIRECTIVE_ORDER_INSTRUCTION.includes('against the port in .switchboard/api-server-port.txt'),
            'COMPLETION_DIRECTIVE_ORDER_INSTRUCTION must not reference the port file');
        const orders = [{
            id: 'completion-directive:role:coder',
            parent: '',
            child: '',
            instruction: COMPLETION_DIRECTIVE_ORDER_INSTRUCTION,
            createdAt: Date.now(),
            scope: 'role',
            role: 'coder',
        }];
        const roleMap = new Map([['Coding-coder-1', 'coder']]);
        const live = new Set(['Coding-coder-1']);
        const rendered = applyStandingOrders('task', 'Coding-coder-1', orders, live, [], roleMap, {}, { terminalName: 'Coding-coder-1' });
        assert.ok(!rendered.includes('against the port in .switchboard/api-server-port.txt'),
            'applyStandingOrders output must not reference the port file');
    });

    // 5. No literal "<your terminal name>" when interpolation receives a name.
    await check('no literal "<your terminal name>" when interpolation receives a name', () => {
        const orders = [{
            id: 'completion-directive:role:coder',
            parent: '',
            child: '',
            instruction: COMPLETION_DIRECTIVE_ORDER_INSTRUCTION,
            createdAt: Date.now(),
            scope: 'role',
            role: 'coder',
        }];
        const roleMap = new Map([['Coding-coder-1', 'coder']]);
        const live = new Set(['Coding-coder-1']);
        const rendered = applyStandingOrders('task', 'Coding-coder-1', orders, live, [], roleMap, {}, { terminalName: 'Coding-coder-1' });
        assert.ok(!rendered.includes('<your terminal name>'),
            'applyStandingOrders output must not contain the literal "<your terminal name>" when interpolation receives a name');
        assert.ok(rendered.includes('Coding-coder-1'),
            'applyStandingOrders output must contain the interpolated terminal name');
    });

    // 6. installCompletionDirectiveOrder(db, 'coder') is idempotent.
    await check('installCompletionDirectiveOrder(db, "coder") is idempotent', async () => {
        const db = makeDb();
        await installCompletionDirectiveOrder(db, 'coder');
        await installCompletionDirectiveOrder(db, 'coder');
        const orders = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY);
        const matching = orders.filter(o => o.id === 'completion-directive:role:coder');
        assert.strictEqual(matching.length, 1,
            `Expected exactly 1 order with id 'completion-directive:role:coder', found ${matching.length}`);
        assert.strictEqual(matching[0].parent, '',
            'The installed order must have parent: "" (role-scoped, not terminal-scoped)');
        assert.strictEqual(matching[0].scope, 'role',
            'The installed order must have scope: "role"');
    });

    // 7. Placeholder ${terminalName} is interpolated at delivery time.
    await check('${terminalName} placeholder is interpolated at delivery time', () => {
        const orders = [{
            id: 'completion-directive:role:coder',
            parent: '',
            child: '',
            instruction: COMPLETION_DIRECTIVE_ORDER_INSTRUCTION,
            createdAt: Date.now(),
            scope: 'role',
            role: 'coder',
        }];
        const roleMap = new Map([['MyCoder', 'coder']]);
        const live = new Set(['MyCoder']);
        const rendered = applyStandingOrders('task', 'MyCoder', orders, live, [], roleMap, {}, { terminalName: 'MyCoder' });
        assert.ok(!rendered.includes('${terminalName}'),
            'The ${terminalName} placeholder must be interpolated at delivery time');
        assert.ok(rendered.includes('done --from "MyCoder"'),
            'The interpolated terminal name must appear in the done --from command');
    });

    // 8. Orders without placeholders are unchanged when no interpolation context.
    await check('orders without placeholders are unchanged without interpolation context', () => {
        const orders = [{
            id: 'test-order',
            parent: '',
            child: '',
            instruction: 'A plain instruction with no placeholders.',
            createdAt: Date.now(),
            scope: 'global',
        }];
        const rendered = renderStandaloneOrdersBlock(orders, 'Any', new Set(), [], undefined, {});
        assert.ok(rendered && rendered.includes('A plain instruction with no placeholders.'),
            'Orders without placeholders must render unchanged');
    });

    // 9. COMPLETION_DIRECTIVE_ROLES includes the coding roles.
    await check('COMPLETION_DIRECTIVE_ROLES includes coder, intern, lead, reviewer', () => {
        for (const role of ['coder', 'intern', 'lead', 'reviewer']) {
            assert.ok(COMPLETION_DIRECTIVE_ROLES.includes(role),
                `COMPLETION_DIRECTIVE_ROLES must include '${role}'`);
        }
    });

    // 10. Dispatch payload fallback (CODING_COMPLETION_REPORT_DIRECTIVE) still exists.
    await check('dispatch payload fallback (CODING_COMPLETION_REPORT_DIRECTIVE) still exists', () => {
        assert.ok(CODING_COMPLETION_REPORT_DIRECTIVE.includes('COMPLETION REPORT:'),
            'CODING_COMPLETION_REPORT_DIRECTIVE must still carry the COMPLETION REPORT: sentinel (dispatch payload fallback)');
        assert.ok(CODING_COMPLETION_REPORT_DIRECTIVE.includes('done'),
            'CODING_COMPLETION_REPORT_DIRECTIVE must reference the done command');
    });

    console.log(`\n${passed} passed, ${failed} failed.`);
    process.exit(failed > 0 ? 1 : 0);
})();
