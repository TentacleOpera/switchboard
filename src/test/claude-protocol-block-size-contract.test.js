'use strict';

/**
 * Contract: the CLAUDE.md managed block Switchboard writes into every user's
 * file stays small and free of dead/host-only/hidden-capability content.
 *
 * This is the durability gate for the shrink-the-injected-agent-protocol-block
 * plan: the resident block was cut from 14,826 chars (~3,706 tokens) to a
 * three-rule body. The size gate stops the next individually-justified addition
 * silently undoing the cut, and the content gates stop the dead references
 * (send_message, view_file, the protocol catalogue) and hidden-capability
 * advertising (no-model skills) from creeping back in.
 *
 * The card-move rule was relocated from the resident block into
 * agentPromptBuilder's per-role suffix (it is role-scoped). This test pins the
 * placement: present for the five execution seats, absent for lead, and the
 * orchestrator is not routed through buildKanbanBatchPrompt at all.
 *
 * Requires `npm run compile-tests` to have produced out/services/*.js.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/claude-protocol-block-size-contract.test.js
 */

const assert = require('assert');

const {
    buildManagedInner,
    CLAUDE_BLOCK_START,
    CLAUDE_BLOCK_END,
    CLAUDE_PROTOCOL_BODY,
    DOCS_POINTER_RULE,
} = require('../../out/services/ClaudeCodeMirrorService.js');
const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder.js');

const SIZE_GATE = 800; // under 800 chars, with headroom for the docs pointer (DOCS_POINTER_RULE)

// A bundled-AGENTS.md-like source carrying its own agents-protocol marker pair,
// used to exercise stripProtocolMarkers through buildManagedInner.
const SOURCE_WITH_MARKERS = `<!-- switchboard:agents-protocol:start -->
# AGENTS.md - Switchboard Protocol

Some body that must not leak into the CLAUDE.md block.
<!-- switchboard:agents-protocol:end -->
`;

function emittedClaudeBlock() {
    // Mirrors ensureProtocolFile's construction: markers wrap buildManagedInner
    // with the CLAUDE per-host body override and no preamble.
    const inner = buildManagedInner(SOURCE_WITH_MARKERS, undefined, CLAUDE_PROTOCOL_BODY);
    return `${CLAUDE_BLOCK_START}\n${inner}\n${CLAUDE_BLOCK_END}`;
}

let passed = 0;
let failed = 0;
function test(name, fn) {
    try { fn(); console.log(`  \u2705 ${name}`); passed++; }
    catch (e) { console.error(`  \u274c ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

test('emitted CLAUDE.md block is under the size gate', () => {
    const block = emittedClaudeBlock();
    assert.ok(block.length < SIZE_GATE,
        `emitted block is ${block.length} chars, gate is ${SIZE_GATE}. ` +
        `Body alone: ${CLAUDE_PROTOCOL_BODY.length}; markers: ${CLAUDE_BLOCK_START.length + CLAUDE_BLOCK_END.length}.`);
});

test('size gate has headroom for the gated docs pointer', () => {
    // DOCS_POINTER_RULE is not yet emitted (URL not live). When it ships, the
    // body grows by ~its length; the gate must still hold.
    const futureBody = `${CLAUDE_PROTOCOL_BODY}\n${DOCS_POINTER_RULE}`;
    const futureInner = buildManagedInner(SOURCE_WITH_MARKERS, undefined, futureBody);
    const futureBlock = `${CLAUDE_BLOCK_START}\n${futureInner}\n${CLAUDE_BLOCK_END}`;
    assert.ok(futureBlock.length < SIZE_GATE,
        `emitted block WITH the docs pointer would be ${futureBlock.length} chars — the gate leaves no room for the planned fourth rule.`);
});

test('no dead references in the emitted block', () => {
    const block = emittedClaudeBlock();
    const dead = ['send_message', 'view_file', 'IsArtifact', '// turbo', 'persona adoption',
        '.agents/', '.switchboard/', 'CLAUDE.md - Switchboard Protocol'];
    for (const token of dead) {
        assert.ok(!block.includes(token),
            `emitted block contains dead/host-only reference "${token}"`);
    }
});

test('no skill or protocol name list in the emitted block', () => {
    const block = emittedClaudeBlock();
    // The old block shipped a hand-maintained catalogue of 31+ protocol names
    // and a skills table. None of those names belong in the resident block.
    const catalogue = ['improve-plan', 'improve-feature', 'complexity-scoring', 'deep-planning',
        'constitution-builder', 'clickup-api', 'linear-api', 'notion-api',
        'manage-features', 'kanban_operations', 'worktree-cleanup'];
    for (const name of catalogue) {
        assert.ok(!block.includes(name),
            `emitted block names "${name}" — the resident block carries no skill/protocol catalogue`);
    }
});

test('no hidden-capability advertising (no-model skills absent)', () => {
    const block = emittedClaudeBlock();
    // kanban-operations and worktree-cleanup are invocation: 'no-model' —
    // deliberately hidden from the model. Naming them in the resident block
    // invites an agent to claim a capability it cannot invoke.
    assert.ok(!block.includes('kanban-operations') && !block.includes('kanban_operations'),
        'resident block advertises the no-model kanban-operations skill');
    assert.ok(!block.includes('worktree-cleanup'),
        'resident block advertises the no-model worktree-cleanup skill');
});

test('import rule names no filesystem path', () => {
    const body = CLAUDE_PROTOCOL_BODY;
    assert.ok(/designated plans directory/i.test(body),
        'import rule must describe a "designated plans directory", not a hardcoded path');
    assert.ok(!body.includes('.switchboard/plans/'),
        'import rule hardcodes .switchboard/plans/ — the scanned location is user-configurable via switchboard.planScanner.customSources');
});

test('import rule states the git-independence', () => {
    const body = CLAUDE_PROTOCOL_BODY;
    assert.ok(/irrelevant/i.test(body) && /untracked/i.test(body),
        'import rule must say committing is irrelevant and untracked files import too — the common wrong assumption is that a commit is required');
});

test('memo suppression and marker survive', () => {
    const body = CLAUDE_PROTOCOL_BODY;
    assert.ok(body.includes('[MEMO CAPTURE ACTIVE]'),
        'memo rule must require the [MEMO CAPTURE ACTIVE] marker every turn');
    assert.ok(/verbatim/i.test(body),
        'memo rule must say to append verbatim');
    assert.ok(/do not\s+analyse/i.test(body),
        'memo rule must suppress analysis/planning/code');
});

test('query-kanban line names the label/ID trap', () => {
    const body = CLAUDE_PROTOCOL_BODY;
    assert.ok(/query-kanban/.test(body),
        'resident block must redirect kanban questions to the query-kanban skill');
    assert.ok(/differ\s+from the stored IDs/i.test(body) && /silently returns nothing/i.test(body),
        'query-kanban line must name the label/ID mismatch — a line that only names the skill does not prevent the silent-empty-column failure');
});

test('marker integrity: exactly one clean marker pair, no agents-protocol markers leak', () => {
    const block = emittedClaudeBlock();
    const startCount = block.split(CLAUDE_BLOCK_START).length - 1;
    const endCount = block.split(CLAUDE_BLOCK_END).length - 1;
    assert.strictEqual(startCount, 1, 'emitted block must have exactly one CLAUDE_BLOCK_START');
    assert.strictEqual(endCount, 1, 'emitted block must have exactly one CLAUDE_BLOCK_END');
    assert.ok(!block.includes('switchboard:agents-protocol:'),
        'agents-protocol source markers must be stripped from the CLAUDE.md block');
});

test('card-move rule is present for the five execution seats', () => {
    const plan = [{ topic: 'p', absolutePath: '/abs/p.md' }];
    for (const role of ['planner', 'coder', 'intern', 'reviewer', 'tester']) {
        const opts = role === 'planner'
            ? { plannerWorkflowPath: '.agents/protocols/improve-plan/SKILL.md', gitProhibitionEnabled: false }
            : { gitProhibitionEnabled: true, switchboardSafeguardsEnabled: true };
        const prompt = buildKanbanBatchPrompt(role, plan, opts);
        assert.ok(/KANBAN COLUMN TRANSITIONS/.test(prompt),
            `card-move rule must be present for role '${role}'`);
    }
});

test('card-move rule is absent for lead', () => {
    const plan = [{ topic: 'p', absolutePath: '/abs/p.md' }];
    const prompt = buildKanbanBatchPrompt('lead', plan, { gitProhibitionEnabled: true, switchboardSafeguardsEnabled: true });
    assert.ok(!/KANBAN COLUMN TRANSITIONS/.test(prompt),
        'card-move rule must be absent for lead — leads legitimately move cards when dispatching');
});

test('card-move rule is absent for orchestrator (not routed through buildKanbanBatchPrompt)', () => {
    // The orchestrator is launched by path, not via the prompt builder. Asserting
    // it is not a recognized role here is the structural guarantee the rule can
    // never leak into the orchestrator's prompt.
    let threw = false;
    try {
        buildKanbanBatchPrompt('orchestrator', [{ topic: 'p', absolutePath: '/abs/p.md' }], {});
    } catch (e) {
        threw = true;
        assert.ok(/Unknown role 'orchestrator'/.test(String(e)),
            `expected Unknown role error for orchestrator, got: ${e}`);
    }
    assert.ok(threw, 'buildKanbanBatchPrompt must reject the orchestrator role');
});

test('planner default base instruction is intact (minimal-prompt regression guard)', () => {
    const plan = [{ topic: 'p', absolutePath: '/abs/p.md' }];
    const prompt = buildKanbanBatchPrompt('planner', plan, {
        plannerWorkflowPath: '.agents/protocols/improve-plan/SKILL.md',
        gitProhibitionEnabled: false
    });
    assert.ok(prompt.includes('Read .agents/protocols/improve-plan/SKILL.md and follow it step-by-step'),
        'planner base instruction line must be intact');
    assert.ok(!prompt.includes('\n\n\n'),
        'planner prompt must not contain triple newlines after the card-move relocation');
});

if (failed > 0) {
    console.error(`\n\u274c ${failed} test(s) failed, ${passed} passed.`);
    process.exit(1);
}
console.log(`\n\u2705 All ${passed} test(s) passed.`);
