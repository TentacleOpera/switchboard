'use strict';

/**
 * Contract: seat safeguards (subagent policy, git policy, skip-compilation,
 * skip-tests, caveman output, suppress-walkthrough, accurate-coding) are
 * appended by the pty delivery layer on every `ptySendPrompt` the seat
 * receives — not only on board-composed prompts. This is the regression test
 * for the incident where a lead drove a coder via `ptySendPrompt` and the
 * coder's configured `noSubagents` safeguard was silently absent.
 *
 * Two kinds of assertion, and the distinction is load-bearing:
 *
 *  - BEHAVIOURAL (section 1a) — `buildSeatDirectiveBlock` is a pure, vscode-free
 *    composer, so it is loaded from `out/` and its OUTPUT is asserted
 *    string-equal to the shared constants. Plan constraint 4 is explicit that a
 *    containment assertion is the wrong assertion here: form is the mechanism,
 *    and a paraphrased directive is the failing case reproduced by the fix meant
 *    to remove it. A source-text grep for the identifier is weaker still — it
 *    passes on `NO_SUBAGENTS_DIRECTIVE.slice(0, 20)`.
 *  - SOURCE-LEVEL (everything else) — the house pattern for pinning TypeScript
 *    call-site and ordering facts that cannot be reached without a live host.
 *
 * Requires `npm run compile-tests` to have produced out/services/*.js.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/seat-safeguards-fleet-prompt-path.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const {
    buildSeatDirectiveBlock,
    NO_SUBAGENTS_DIRECTIVE,
    CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE,
    SKIP_COMPILATION_DIRECTIVE,
    SKIP_TESTS_DIRECTIVE,
    CAVEMAN_OUTPUT_DIRECTIVE,
    SUPPRESS_WALKTHROUGH_DIRECTIVE,
    ACCURATE_CODING_DIRECTIVE,
    FOCUS_DIRECTIVE,
    buildGitPolicyBlock,
    ensureDispatchProtocolDirectives,
    validateDispatchPayload,
    DISPATCH_ROLES,
} = require('../../out/services/agentPromptBuilder');

const AGENT_PROMPT_BUILDER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'agentPromptBuilder.ts'), 'utf8'
);
const STANDING_ORDERS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'standingOrders.ts'), 'utf8'
);
const TASK_VIEWER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8'
);
const BOOTSTRAP_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8'
);
const KANBAN_PROVIDER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'KanbanProvider.ts'), 'utf8'
);
const SKILL_SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', '.agents', 'skills', 'terminal-coder-dispatch', 'SKILL.md'), 'utf8'
);
const CLAUDE_SKILL_SRC = fs.readFileSync(
    path.join(__dirname, '..', '..', '.claude', 'skills', 'terminal-coder-dispatch', 'SKILL.md'), 'utf8'
);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        const result = fn();
        if (result && typeof result.then === 'function') {
            result.then(() => { console.log(`  ✅ ${name}`); passed++; })
                  .catch((e) => { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; });
        } else {
            console.log(`  ✅ ${name}`); passed++;
        }
    } catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

// ── 1a. BEHAVIOURAL: the emitted block is byte-identical to the constants ─
//
// Constraint 4 of the plan: "assert the emitted seat block is string-equal to
// the corresponding constant, not merely that it contains the phrase." These
// run against the compiled composer, so a paraphrase, a re-title, a trim or a
// re-wrap fails them.

test('BEHAVIOUR: noSubagents emits NO_SUBAGENTS_DIRECTIVE string-equal (not a paraphrase)', () => {
    const block = buildSeatDirectiveBlock({ subagentPolicy: 'noSubagents' });
    assert.strictEqual(block, NO_SUBAGENTS_DIRECTIVE,
        'The seat block for a noSubagents seat must be byte-identical to NO_SUBAGENTS_DIRECTIVE. ' +
        'This is the incident regression: a reworded directive is the failing case.');
});

test('BEHAVIOUR: customSubagent emits CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE string-equal', () => {
    const block = buildSeatDirectiveBlock({ subagentPolicy: 'customSubagent', customSubagentName: 'planner_bot' });
    assert.strictEqual(block, CUSTOM_SUBAGENT_DIRECTIVE_TEMPLATE('planner_bot'),
        'The custom-subagent seat block must be byte-identical to the shared template.');
});

test('BEHAVIOUR: skip directives emit string-equal and carry the precedence clause', () => {
    assert.strictEqual(buildSeatDirectiveBlock({ skipCompilation: true }), SKIP_COMPILATION_DIRECTIVE);
    assert.strictEqual(buildSeatDirectiveBlock({ skipTests: true }), SKIP_TESTS_DIRECTIVE);
    // Incident #2: the directive arrived and lost to the plan file's Verification
    // Plan. The clause has to travel WITH the constant, on both paths.
    for (const d of [SKIP_COMPILATION_DIRECTIVE, SKIP_TESTS_DIRECTIVE]) {
        assert.ok(d.includes("overrides the plan file's Verification Plan"),
            `Skip directive must carry the precedence clause. Got: "${d}"`);
    }
});

test('BEHAVIOUR: output-shaping directives emit string-equal', () => {
    assert.strictEqual(buildSeatDirectiveBlock({ cavemanOutput: true }), CAVEMAN_OUTPUT_DIRECTIVE);
    assert.strictEqual(buildSeatDirectiveBlock({ suppressWalkthrough: true }), SUPPRESS_WALKTHROUGH_DIRECTIVE);
    assert.strictEqual(buildSeatDirectiveBlock({ accurateCoding: true }), ACCURATE_CODING_DIRECTIVE);
});

test('BEHAVIOUR: the git block is buildGitPolicyBlock output verbatim', () => {
    const opts = {
        gitProhibitionEnabled: true,
        gitBranchStrategy: 'current',
        gitCommitStrategy: 'whenDone',
        gitPushStrategy: 'noPush',
    };
    assert.strictEqual(
        buildSeatDirectiveBlock(opts),
        buildGitPolicyBlock({
            branch: opts.gitBranchStrategy,
            commit: opts.gitCommitStrategy,
            push: opts.gitPushStrategy,
            guardrail: opts.gitProhibitionEnabled,
            worktreeActive: undefined,
            worktreePerPlanActive: undefined,
        }),
        'The seat git block must be the shared builder\'s output verbatim, not a re-composition.'
    );
});

test('BEHAVIOUR: every addon at its no-op value emits the empty string', () => {
    assert.strictEqual(buildSeatDirectiveBlock({}), '');
    assert.strictEqual(buildSeatDirectiveBlock({
        subagentPolicy: 'default',
        gitProhibitionEnabled: false,
        gitBranchStrategy: 'notSpecified',
        gitCommitStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
        skipCompilation: false,
        skipTests: false,
        cavemanOutput: false,
        suppressWalkthrough: false,
        accurateCoding: false,
    }), '', 'A fully-disabled seat must append nothing at all.');
});

test('BEHAVIOUR: a fully-loaded block carries each directive EXACTLY ONCE', () => {
    const block = buildSeatDirectiveBlock({
        subagentPolicy: 'noSubagents',
        gitProhibitionEnabled: true,
        gitBranchStrategy: 'current',
        gitCommitStrategy: 'whenDone',
        gitPushStrategy: 'noPush',
        skipCompilation: true,
        skipTests: true,
        cavemanOutput: true,
        suppressWalkthrough: true,
        accurateCoding: true,
    });
    const countOf = (needle) => block.split(needle).length - 1;
    for (const [label, needle] of [
        ['NO_SUBAGENTS_DIRECTIVE', NO_SUBAGENTS_DIRECTIVE],
        ['SKIP_COMPILATION_DIRECTIVE', SKIP_COMPILATION_DIRECTIVE],
        ['SKIP_TESTS_DIRECTIVE', SKIP_TESTS_DIRECTIVE],
        ['CAVEMAN_OUTPUT_DIRECTIVE', CAVEMAN_OUTPUT_DIRECTIVE],
        ['SUPPRESS_WALKTHROUGH_DIRECTIVE', SUPPRESS_WALKTHROUGH_DIRECTIVE],
        ['ACCURATE_CODING_DIRECTIVE', ACCURATE_CODING_DIRECTIVE],
        ['GIT POLICY: ', 'GIT POLICY: '],
    ]) {
        assert.strictEqual(countOf(needle), 1,
            `${label} must appear exactly once in the seat block, found ${countOf(needle)}.`);
    }
});

test('BEHAVIOUR: no dispatch-scoped directive leaks into the seat block', () => {
    const block = buildSeatDirectiveBlock({
        subagentPolicy: 'noSubagents',
        gitProhibitionEnabled: true,
        gitBranchStrategy: 'current',
        gitCommitStrategy: 'whenDone',
        gitPushStrategy: 'noPush',
        skipCompilation: true,
        skipTests: true,
        cavemanOutput: true,
        suppressWalkthrough: true,
        accurateCoding: true,
    });
    // Asserted on ABSENCE so widening the seat set later fails loudly.
    assert.ok(!block.includes(FOCUS_DIRECTIVE),
        'FOCUS_DIRECTIVE is dispatch-scoped — it references "the plan file paths below", which are not there on a relay.');
    for (const forbidden of ['PLANS TO PROCESS', 'PROJECT REQUIREMENTS', 'Project:', 'BATCH']) {
        assert.ok(!block.includes(forbidden),
            `Seat block must not carry dispatch-scoped text "${forbidden}".`);
    }
});

test('BEHAVIOUR: the block is separated from the task text by a blank line, and is not wrapped around it', () => {
    // The delivery layer composes `<task> \n\n <seat block>`. The composer must
    // return a bare block with no leading/trailing whitespace of its own, so the
    // three regions stay visually distinct and the seat block never interpolates
    // into the sender's prose.
    const block = buildSeatDirectiveBlock({ subagentPolicy: 'noSubagents', skipTests: true });
    assert.strictEqual(block, block.trim(), 'The seat block must not carry its own leading/trailing whitespace.');
    assert.ok(block.includes('\n\n'), 'Multiple directives must be joined by a blank line, as buildKanbanBatchPrompt joins them.');
});

// ── 1. buildSeatDirectiveBlock exists and is a pure composer ─────────────

test('agentPromptBuilder.ts exports buildSeatDirectiveBlock', () => {
    assert.ok(
        /export\s+function\s+buildSeatDirectiveBlock/.test(AGENT_PROMPT_BUILDER_SRC),
        'buildSeatDirectiveBlock must be exported from agentPromptBuilder.ts'
    );
});

test('agentPromptBuilder.ts exports SeatDirectiveOptions interface', () => {
    assert.ok(
        /export\s+interface\s+SeatDirectiveOptions/.test(AGENT_PROMPT_BUILDER_SRC),
        'SeatDirectiveOptions interface must be exported from agentPromptBuilder.ts'
    );
});

test('buildSeatDirectiveBlock emits NO_SUBAGENTS_DIRECTIVE verbatim for noSubagents', () => {
    // Source-level: the function body must reference NO_SUBAGENTS_DIRECTIVE
    // (not a paraphrase) when subagentPolicy === 'noSubagents'.
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildSeatDirectiveBlock');
    assert.ok(fnStart >= 0, 'buildSeatDirectiveBlock not found');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('NO_SUBAGENTS_DIRECTIVE'),
        'buildSeatDirectiveBlock must emit NO_SUBAGENTS_DIRECTIVE verbatim (not a paraphrase)'
    );
});

test('buildSeatDirectiveBlock emits buildGitPolicyBlock (not a reworded git block)', () => {
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildSeatDirectiveBlock');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('buildGitPolicyBlock'),
        'buildSeatDirectiveBlock must call buildGitPolicyBlock (the same builder the board path uses)'
    );
});

test('buildSeatDirectiveBlock emits SKIP_COMPILATION_DIRECTIVE and SKIP_TESTS_DIRECTIVE verbatim', () => {
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildSeatDirectiveBlock');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('SKIP_COMPILATION_DIRECTIVE') && fnBody.includes('SKIP_TESTS_DIRECTIVE'),
        'buildSeatDirectiveBlock must emit the verbatim skip directives (not paraphrased)'
    );
});

test('buildSeatDirectiveBlock emits CAVEMAN_OUTPUT_DIRECTIVE and SUPPRESS_WALKTHROUGH_DIRECTIVE verbatim', () => {
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildSeatDirectiveBlock');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('CAVEMAN_OUTPUT_DIRECTIVE') && fnBody.includes('SUPPRESS_WALKTHROUGH_DIRECTIVE'),
        'buildSeatDirectiveBlock must emit the verbatim output-shaping directives'
    );
});

test('buildSeatDirectiveBlock emits ACCURATE_CODING_DIRECTIVE verbatim', () => {
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildSeatDirectiveBlock');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('ACCURATE_CODING_DIRECTIVE'),
        'buildSeatDirectiveBlock must emit ACCURATE_CODING_DIRECTIVE verbatim'
    );
});

test('buildSeatDirectiveBlock does NOT emit FOCUS_DIRECTIVE (dispatch-scoped)', () => {
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildSeatDirectiveBlock');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        !fnBody.includes('FOCUS_DIRECTIVE'),
        'buildSeatDirectiveBlock must NOT emit FOCUS_DIRECTIVE — it is dispatch-scoped and references plan files'
    );
});

test('buildSeatDirectiveBlock does NOT emit BATCH_EXECUTION_RULES (dispatch-scoped)', () => {
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildSeatDirectiveBlock');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        !fnBody.includes('BATCH_EXECUTION_RULES'),
        'buildSeatDirectiveBlock must NOT emit BATCH_EXECUTION_RULES — it is dispatch-scoped'
    );
});

test('buildSeatDirectiveBlock returns empty string when all addons are no-op', () => {
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildSeatDirectiveBlock');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        /parts\.length\s*===\s*0.*return\s+''/.test(fnBody),
        'buildSeatDirectiveBlock must return empty string when no parts are emitted'
    );
});

// ── 2. ACCURATE_CODING_DIRECTIVE is extracted as a shared constant ───────

test('ACCURATE_CODING_DIRECTIVE is exported and byte-identical to withCoderAccuracyInstruction text', () => {
    const constMatch = AGENT_PROMPT_BUILDER_SRC.match(
        /export\s+const\s+ACCURATE_CODING_DIRECTIVE\s*=\s*`([^`]*)`/
    );
    assert.ok(constMatch, 'ACCURATE_CODING_DIRECTIVE must be exported as a backtick template literal');
    const constValue = constMatch[1];
    // withCoderAccuracyInstruction must reference the constant, not inline text
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('function withCoderAccuracyInstruction');
    const fnEnd = AGENT_PROMPT_BUILDER_SRC.indexOf('\n}', fnStart);
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('ACCURATE_CODING_DIRECTIVE'),
        'withCoderAccuracyInstruction must reference ACCURATE_CODING_DIRECTIVE (not inline text)'
    );
});

// ── 3. stripStandingOrdersBlock is exported ──────────────────────────────

test('standingOrders.ts exports stripStandingOrdersBlock', () => {
    assert.ok(
        /export\s+function\s+stripStandingOrdersBlock/.test(STANDING_ORDERS_SRC),
        'stripStandingOrdersBlock must be exported from standingOrders.ts so the chokepoint can order the two blocks correctly'
    );
});

// ── 4. KanbanProvider.resolveSeatPromptOptions exists ────────────────────

test('KanbanProvider exports resolveSeatPromptOptions as a public method', () => {
    assert.ok(
        /public\s+async\s+resolveSeatPromptOptions/.test(KANBAN_PROVIDER_SRC),
        'resolveSeatPromptOptions must be a public async method on KanbanProvider'
    );
});

test('resolveSeatPromptOptions sources _getPromptsConfig (same maps as the board path)', () => {
    const fnStart = KANBAN_PROVIDER_SRC.indexOf('resolveSeatPromptOptions');
    const fnEnd = KANBAN_PROVIDER_SRC.indexOf('\n    private async _getPromptsConfig', fnStart);
    const fnBody = KANBAN_PROVIDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('_getPromptsConfig'),
        'resolveSeatPromptOptions must call _getPromptsConfig (the same config maps the board path uses)'
    );
});

test('resolveSeatPromptOptions defaults gitProhibitionEnabled to true (fail-safe, not fail-open)', () => {
    const fnStart = KANBAN_PROVIDER_SRC.indexOf('resolveSeatPromptOptions');
    const fnEnd = KANBAN_PROVIDER_SRC.indexOf('\n    private async _getPromptsConfig', fnStart);
    const fnBody = KANBAN_PROVIDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        /gitProhibitionByRole.*\?\.\[role\]\s*\?\?\s*true/.test(fnBody),
        'resolveSeatPromptOptions must default gitProhibitionEnabled to true for unresolved roles (fail-safe)'
    );
});

// ── 5. Precedence clause on skip directives ──────────────────────────────

test('SKIP_TESTS_DIRECTIVE contains the precedence clause overriding the plan file Verification Plan', () => {
    const m = AGENT_PROMPT_BUILDER_SRC.match(
        /export\s+const\s+SKIP_TESTS_DIRECTIVE\s*=\s*`([^`]*)`/
    );
    assert.ok(m, 'SKIP_TESTS_DIRECTIVE not found');
    assert.ok(
        m[1].includes('overrides the plan file') && m[1].includes('Verification Plan'),
        `SKIP_TESTS_DIRECTIVE must contain a precedence clause overriding the plan file's Verification Plan. Got: "${m[1]}"`
    );
});

test('SKIP_COMPILATION_DIRECTIVE contains the precedence clause overriding the plan file Verification Plan', () => {
    const m = AGENT_PROMPT_BUILDER_SRC.match(
        /export\s+const\s+SKIP_COMPILATION_DIRECTIVE\s*=\s*`([^`]*)`/
    );
    assert.ok(m, 'SKIP_COMPILATION_DIRECTIVE not found');
    assert.ok(
        m[1].includes('overrides the plan file') && m[1].includes('Verification Plan'),
        `SKIP_COMPILATION_DIRECTIVE must contain a precedence clause overriding the plan file's Verification Plan. Got: "${m[1]}"`
    );
});

// ── 6. Extension chokepoint (_ptyHostVerb) ───────────────────────────────

test('_ptyHostVerb appends the seat block via buildSeatDirectiveBlock', () => {
    assert.ok(
        /_ptyHostVerb[\s\S]*buildSeatDirectiveBlock/.test(TASK_VIEWER_SRC),
        '_ptyHostVerb must call buildSeatDirectiveBlock to compose the seat block'
    );
});

test('_ptyHostVerb calls stripStandingOrdersBlock before appending the seat block', () => {
    // The ordering: strip SO → append seat block → applyStandingOrders.
    // Verify stripStandingOrdersBlock is called in _ptyHostVerb.
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        verbBody.includes('stripStandingOrdersBlock'),
        '_ptyHostVerb must call stripStandingOrdersBlock before appending the seat block (constraint 1: ordering)'
    );
});

test('_ptyHostVerb applies standing orders AFTER the seat block (ordering)', () => {
    // The seat block append must come before the applyStandingOrders CALL in
    // the source. Search for the call pattern (with opening paren) to
    // distinguish from comment mentions.
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    const seatIdx = verbBody.indexOf('buildSeatDirectiveBlock');
    const soIdx = verbBody.indexOf('applyStandingOrders(');
    assert.ok(seatIdx >= 0 && soIdx >= 0, 'Both buildSeatDirectiveBlock and applyStandingOrders call must be present in _ptyHostVerb');
    assert.ok(
        seatIdx < soIdx,
        'The seat block must be composed BEFORE applyStandingOrders (constraint 1: seat block first, standing orders last)'
    );
});

test('_ptyHostVerb skips the seat block when addonsComposed is true', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        /addonsComposed\s*!==\s*true/.test(verbBody),
        '_ptyHostVerb must skip the seat block when addonsComposed === true (double-application prevention)'
    );
});

test('_ptyHostVerb skips the seat block when seatBlock is false (host-only opt-out)', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        /seatBlock\s*!==\s*false/.test(verbBody),
        '_ptyHostVerb must skip the seat block when seatBlock === false (turn-end opt-out)'
    );
});

test('_ptyHostVerb calls ptyListTerminals exactly once (reused for both SO and seat block)', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    // Count actual INVOCATIONS, not textual mentions — the earlier form counted
    // comment prose and would have tolerated a second real round-trip while
    // failing on a clarifying comment.
    const listCalls = (verbBody.match(/_ptyHostVerb\(\s*'ptyListTerminals'/g) || []).length;
    assert.strictEqual(
        listCalls, 1,
        `_ptyHostVerb must call ptyListTerminals exactly once per send and reuse the result for the ` +
        `live set and the seat role, found ${listCalls}. The plan forbids adding a second round-trip.`
    );
});

// ── 7. HTTP boundary strips host-only fields ─────────────────────────────

test('handlePtyVerb strips addonsComposed from caller payloads', () => {
    const stripIdx = TASK_VIEWER_SRC.indexOf('delete payload.addonsComposed');
    assert.ok(
        stripIdx >= 0,
        'handlePtyVerb must strip addonsComposed from caller payloads (host-only field)'
    );
});

test('handlePtyVerb strips seatBlock from caller payloads', () => {
    const stripIdx = TASK_VIEWER_SRC.indexOf('delete payload.seatBlock');
    assert.ok(
        stripIdx >= 0,
        'handlePtyVerb must strip seatBlock from caller payloads (host-only field)'
    );
});

// ── 8. notifyTurnEnd passes the host-only seat-block opt-out ─────────────

test('notifyTurnEnd passes seatBlock: false (machine-origin notice, no task to constrain)', () => {
    const fnStart = TASK_VIEWER_SRC.indexOf('public notifyTurnEnd');
    const fnEnd = TASK_VIEWER_SRC.indexOf('\n    }', fnStart);
    const fnBody = TASK_VIEWER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('seatBlock: false'),
        'notifyTurnEnd must pass seatBlock: false — a machine notice has no task to constrain'
    );
});

// ── 9. promptComposed threaded through dispatch funnel ───────────────────

test('_dispatchExecuteMessage accepts a promptComposed parameter defaulting to false', () => {
    const fnStart = TASK_VIEWER_SRC.indexOf('private async _dispatchExecuteMessage');
    const fnEnd = TASK_VIEWER_SRC.indexOf('): Promise<boolean> {', fnStart);
    const fnSig = TASK_VIEWER_SRC.slice(fnStart, fnEnd + 1);
    assert.ok(
        /promptComposed.*=\s*false/.test(fnSig),
        '_dispatchExecuteMessage must accept promptComposed: boolean = false (default false so new call sites get the safeguard)'
    );
});

test('_attemptDirectTerminalPush accepts promptComposed and sets addonsComposed on the payload', () => {
    const fnStart = TASK_VIEWER_SRC.indexOf('private async _attemptDirectTerminalPush');
    const fnEnd = TASK_VIEWER_SRC.indexOf('): Promise<boolean> {', fnStart);
    const fnSig = TASK_VIEWER_SRC.slice(fnStart, fnEnd + 1);
    assert.ok(
        /promptComposed.*=\s*false/.test(fnSig),
        '_attemptDirectTerminalPush must accept promptComposed: boolean = false'
    );
    // Verify addonsComposed is set on the ptySendPrompt payload
    const fnBodyStart = TASK_VIEWER_SRC.indexOf('): Promise<boolean> {', fnStart);
    const fnBodyEnd = TASK_VIEWER_SRC.indexOf('\n    }', fnBodyStart);
    const fnBody = TASK_VIEWER_SRC.slice(fnBodyStart, fnBodyEnd);
    assert.ok(
        fnBody.includes('addonsComposed: promptComposed'),
        '_attemptDirectTerminalPush must set addonsComposed: promptComposed on the ptySendPrompt payload'
    );
});

/**
 * Enumerate every `_dispatchExecuteMessage` call site and classify it by whether
 * it passes the composition marker. Returns { composed, uncomposed } as arrays of
 * 1-based source line numbers.
 *
 * The plan is explicit that this must be enumerated, not aggregated: "the
 * aggregate assertion is what a branch-level marker would pass." Marking inside
 * `_attemptDirectTerminalPush` (the shared funnel) instead of threading from the
 * two composing callers would silently exempt five uncomposed dispatch paths,
 * and a presence-only assertion cannot see the difference.
 */
function classifyDispatchCallSites() {
    const lines = TASK_VIEWER_SRC.split('\n');
    const composed = [];
    const uncomposed = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/(?:await\s+)?this\._dispatchExecuteMessage\(/.test(lines[i])) { continue; }
        // The call may span several lines; take up to the first `);` after it.
        const chunk = lines.slice(i, i + 12).join('\n');
        const end = chunk.indexOf(');');
        const call = end >= 0 ? chunk.slice(0, end) : chunk;
        // The 6th positional argument is promptComposed. It is only ever passed
        // as a bare literal after the sender string.
        (/'[a-z]+',\s*true\s*$/m.test(call.trimEnd()) || /,\s*true\s*$/.test(call.trimEnd()))
            ? composed.push(i + 1)
            : uncomposed.push(i + 1);
    }
    return { composed, uncomposed };
}

test('exactly 7 _dispatchExecuteMessage call sites exist, and exactly 2 pass promptComposed: true', () => {
    const { composed, uncomposed } = classifyDispatchCallSites();
    assert.strictEqual(
        composed.length + uncomposed.length, 7,
        `Expected 7 _dispatchExecuteMessage call sites (the audited set), found ${composed.length + uncomposed.length}. ` +
        'A new call site must be classified deliberately: it defaults to promptComposed=false and therefore ' +
        'GAINS the seat block, which is the safe direction — but the audit must be re-run.'
    );
    assert.strictEqual(
        composed.length, 2,
        `Exactly 2 call sites may pass promptComposed: true (batch-group dispatch and single-card dispatch — ` +
        `the only two whose prompt came out of generateUnifiedPrompt/buildKanbanBatchPrompt). ` +
        `Found ${composed.length} at lines [${composed.join(', ')}]. ` +
        'Marking a third exempts an uncomposed path from its seat safeguards, silently.'
    );
});

test('each of the 5 uncomposed dispatch call sites is enumerated and unmarked', () => {
    const { uncomposed } = classifyDispatchCallSites();
    assert.strictEqual(
        uncomposed.length, 5,
        `Expected 5 uncomposed dispatch call sites — dispatchCustomPromptToRole, the orchestrator kickoff, ` +
        `the pair-programming send, _tryFleetDeliveryForRole and the Airlock patch hand-off. ` +
        `Found ${uncomposed.length} at lines [${uncomposed.join(', ')}].`
    );
    // Each must reach the funnel WITHOUT the marker, so the delivery layer
    // appends the seat block. Assert per site, not in aggregate.
    for (const line of uncomposed) {
        const call = TASK_VIEWER_SRC.split('\n').slice(line - 1, line + 11).join('\n');
        const end = call.indexOf(');');
        const sliced = end >= 0 ? call.slice(0, end) : call;
        assert.ok(
            !/,\s*true\s*$/.test(sliced.trimEnd()),
            `Uncomposed dispatch call site at line ${line} must NOT pass promptComposed: true — ` +
            'its prompt was never composed by agentPromptBuilder, so suppressing the seat block ' +
            'would reproduce the incident on that path.'
        );
    }
});

test('_ptyHostVerb resolves the seat role from hidden terminals too (relay targets them)', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        verbBody.includes('hiddenTerminals'),
        '_ptyHostVerb must search hiddenTerminals as well as terminals when resolving the seat role. ' +
        'ptyListTerminals returns hidden seats in a SIBLING array, and /terminals/relay validates its ' +
        'recipient against both — so a terminals-only lookup delivers to a hidden seat while resolving ' +
        'its role to \'\', dropping that seat\'s configured safeguards.'
    );
    assert.ok(
        /roleRows\.find\(/.test(verbBody),
        'The seat-role lookup must run over the combined rows (roleRows), not the render-only terminals array.'
    );
});

// ── 10. Standalone chokepoint (deliverPrompt) ────────────────────────────

test('standalone deliverPrompt accepts applySeatBlock as a 5th parameter defaulting to true', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('): Promise<void> =>', fnStart);
    const fnSig = BOOTSTRAP_SRC.slice(fnStart, fnEnd + 1);
    assert.ok(
        /applySeatBlock\s*=\s*true/.test(fnSig),
        'deliverPrompt must accept applySeatBlock = true as a 5th parameter'
    );
});

test('standalone deliverPrompt calls buildSeatDirectiveBlock', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('await sendPromptToPty', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('buildSeatDirectiveBlock'),
        'deliverPrompt must call buildSeatDirectiveBlock to compose the seat block'
    );
});

test('standalone deliverPrompt calls stripStandingOrdersBlock before the seat block', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('await sendPromptToPty', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('stripStandingOrdersBlock'),
        'deliverPrompt must call stripStandingOrdersBlock before appending the seat block (constraint 1)'
    );
});

test('standalone deliverPrompt applies standing orders AFTER the seat block (ordering)', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('await sendPromptToPty', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    const seatIdx = fnBody.indexOf('buildSeatDirectiveBlock');
    const soIdx = fnBody.indexOf('applyStandingOrders');
    assert.ok(seatIdx >= 0 && soIdx >= 0, 'Both buildSeatDirectiveBlock and applyStandingOrders must be present in deliverPrompt');
    assert.ok(
        seatIdx < soIdx,
        'The seat block must be composed BEFORE applyStandingOrders in deliverPrompt (constraint 1)'
    );
});

test('standalone deliverPrompt reads role from handle.role (no IPC)', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('await sendPromptToPty', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('handle.role'),
        'deliverPrompt must read the role from handle.role (no ptyListTerminals IPC needed in standalone)'
    );
});

test('standalone deliverPrompt calls resolveSeatPromptOptions on kanbanProvider', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('await sendPromptToPty', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('resolveSeatPromptOptions'),
        'deliverPrompt must call kanbanProvider.resolveSeatPromptOptions (shared resolver with the board path)'
    );
});

// ── 11. Standalone buildPromptForCards cleanup ───────────────────────────

test('standalone buildPromptForCards no longer hardcodes GIT_SAFETY_DIRECTIVE', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('async function buildPromptForCards');
    const fnEnd = BOOTSTRAP_SRC.indexOf('return blocks.join', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        !fnBody.includes('GIT_SAFETY_DIRECTIVE'),
        'buildPromptForCards must NOT hardcode GIT_SAFETY_DIRECTIVE — the seat block supplies it from config'
    );
});

test('standalone buildPromptForCards no longer hardcodes SKIP_COMPILATION_DIRECTIVE', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('async function buildPromptForCards');
    const fnEnd = BOOTSTRAP_SRC.indexOf('return blocks.join', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        !fnBody.includes('SKIP_COMPILATION_DIRECTIVE'),
        'buildPromptForCards must NOT hardcode SKIP_COMPILATION_DIRECTIVE — the seat block supplies it from config'
    );
});

test('standalone buildPromptForCards no longer hardcodes SKIP_TESTS_DIRECTIVE', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('async function buildPromptForCards');
    const fnEnd = BOOTSTRAP_SRC.indexOf('return blocks.join', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        !fnBody.includes('SKIP_TESTS_DIRECTIVE'),
        'buildPromptForCards must NOT hardcode SKIP_TESTS_DIRECTIVE — the seat block supplies it from config'
    );
});

test('standalone buildPromptForCards keeps FOCUS_DIRECTIVE (dispatch-scoped)', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('async function buildPromptForCards');
    const fnEnd = BOOTSTRAP_SRC.indexOf('return blocks.join', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('FOCUS_DIRECTIVE'),
        'buildPromptForCards must keep FOCUS_DIRECTIVE — it is dispatch-scoped (references the plan list below it)'
    );
});

// ── 12. Standalone ptySendPrompt strips host-only fields ─────────────────

test('standalone ptySendPrompt case strips addonsComposed from caller payloads', () => {
    assert.ok(
        /delete payload\.addonsComposed/.test(BOOTSTRAP_SRC),
        'standalone ptySendPrompt case must strip addonsComposed from caller payloads (host-only)'
    );
});

test('standalone ptySendPrompt case strips seatBlock from caller payloads', () => {
    assert.ok(
        /delete payload\.seatBlock/.test(BOOTSTRAP_SRC),
        'standalone ptySendPrompt case must strip seatBlock from caller payloads (host-only)'
    );
});

// ── 13. Standalone turn-end opts out of seat block ───────────────────────

test('standalone turn-end passes applySeatBlock = false', () => {
    // The turn-end send calls deliverPrompt with 5th arg false.
    const turnEndIdx = BOOTSTRAP_SRC.indexOf('turn-end delivery to');
    assert.ok(turnEndIdx >= 0, 'turn-end send not found');
    const sendIdx = BOOTSTRAP_SRC.indexOf('deliverPrompt(handle, message', turnEndIdx - 200);
    const sendEnd = BOOTSTRAP_SRC.indexOf(');', sendIdx);
    const sendCall = BOOTSTRAP_SRC.slice(sendIdx, sendEnd + 2);
    assert.ok(
        /false,\s*false\)/.test(sendCall),
        'standalone turn-end must pass both applyOrders=false and applySeatBlock=false to deliverPrompt'
    );
});

// ── 14. Skill file has the seat-safeguards paragraph ─────────────────────

test('terminal-coder-dispatch SKILL.md has the seat-safeguards paragraph', () => {
    assert.ok(
        SKILL_SRC.includes('Seat safeguards ride the delivery layer'),
        'terminal-coder-dispatch/SKILL.md must have the seat-safeguards paragraph'
    );
    assert.ok(
        SKILL_SRC.includes('do not hand-copy'),
        'The paragraph must state that a driving agent does not hand-copy seat safeguards'
    );
    assert.ok(
        SKILL_SRC.includes('hand-typed') && SKILL_SRC.includes('can lose an') && SKILL_SRC.includes('argument to it'),
        'The paragraph must state that hand-typed prose can lose an argument to the plan file'
    );
});

test('.claude/skills mirror has the same seat-safeguards paragraph', () => {
    assert.ok(
        CLAUDE_SKILL_SRC.includes('Seat safeguards ride the delivery layer'),
        '.claude/skills/terminal-coder-dispatch/SKILL.md mirror must have the same seat-safeguards paragraph'
    );
});

// ── 15. Standing-orders regex and mirror are unchanged ───────────────────

test('STANDING_ORDERS_BLOCK_RE is still $-anchored (not relaxed)', () => {
    // The regex ends with `\n$/` — anchored to end-of-string so a mid-text
    // marker quote is not silently truncated from that point to end-of-string.
    assert.ok(
        /STANDING_ORDERS_BLOCK_RE\s*=\s*\/.*\\n\$\/[gimsuy]*/.test(STANDING_ORDERS_SRC),
        'STANDING_ORDERS_BLOCK_RE must remain $-anchored (ends with \\n$/) — relaxing it re-opens the quoted-marker truncation bug'
    );
});

test('applyStandingOrders and STANDING_ORDERS_BLOCK_RE are unchanged (no new logic added)', () => {
    // The standing-orders module should only have gained the export keyword on
    // stripStandingOrdersBlock — applyStandingOrders and the regex are unchanged.
    assert.ok(
        /export\s+function\s+applyStandingOrders/.test(STANDING_ORDERS_SRC),
        'applyStandingOrders must still be exported'
    );
    assert.ok(
        /export\s+function\s+stripStandingOrdersBlock/.test(STANDING_ORDERS_SRC),
        'stripStandingOrdersBlock must now be exported (was module-private)'
    );
});

// ── 16. Seat Directive Block Memoization & Cache Invalidation ───────────

test('TaskViewerProvider declares private _seatBlockCache Map', () => {
    assert.ok(
        TASK_VIEWER_SRC.includes('private _seatBlockCache = new Map<string, { name: string; block: string }>();'),
        'TaskViewerProvider must declare _seatBlockCache Map<string, { name: string; block: string }>'
    );
});

test('TaskViewerProvider keys seat block cache on agentInstanceId and not friendlyName', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        verbBody.includes('this._seatBlockCache.get(instanceId)') || verbBody.includes('this._seatBlockCache.set(instanceId'),
        '_ptyHostVerb must key _seatBlockCache on agentInstanceId'
    );
    assert.ok(
        !verbBody.includes('this._seatBlockCache.get(payload.name)') && !verbBody.includes('this._seatBlockCache.set(payload.name'),
        '_ptyHostVerb must NOT key _seatBlockCache on friendlyName (avoids terminal recreation trap)'
    );
});

test('TaskViewerProvider invalidates seat block cache on ptyClearTerminal and ptyClearAllTerminals', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        verbBody.includes("verb === 'ptyClearTerminal'") && verbBody.includes('this._seatBlockCache.delete('),
        '_ptyHostVerb must delete from _seatBlockCache on ptyClearTerminal'
    );
    assert.ok(
        verbBody.includes("verb === 'ptyClearAllTerminals'") && verbBody.includes('this._seatBlockCache.clear()'),
        '_ptyHostVerb must clear _seatBlockCache on ptyClearAllTerminals'
    );
});

test('TaskViewerProvider delivers seat block when clearBeforePrompt is true (board dispatch shape)', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        verbBody.includes('payload?.clearBeforePrompt === true'),
        '_ptyHostVerb must bypass suppression when clearBeforePrompt is true'
    );
});

test('TaskViewerProvider prunes _seatBlockCache against live roleRows', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        verbBody.includes('liveInstanceIds') && verbBody.includes('this._seatBlockCache.delete('),
        '_ptyHostVerb must prune _seatBlockCache against live instance IDs'
    );
});

test('standalone bootstrap declares seatBlockCache Map and keys on handle.agentInstanceId', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('await sendPromptToPty', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        BOOTSTRAP_SRC.includes('const seatBlockCache = new Map<string, string>();'),
        'bootstrap must declare seatBlockCache Map<string, string>'
    );
    assert.ok(
        fnBody.includes('seatBlockCache.get(instanceId)') || fnBody.includes('seatBlockCache.set(instanceId, seatBlock)'),
        'deliverPrompt must key seatBlockCache on handle.agentInstanceId'
    );
    assert.ok(
        !fnBody.includes('seatBlockCache.get(handle.friendlyName)') && !fnBody.includes('seatBlockCache.set(handle.friendlyName'),
        'deliverPrompt must NOT key seatBlockCache on friendlyName'
    );
});

test('standalone bootstrap invalidates seatBlockCache on ptyClearTerminal and ptyClearAllTerminals', () => {
    assert.ok(
        /case\s+'ptyClearTerminal':[\s\S]*?seatBlockCache\.delete\(handle\.agentInstanceId\)/.test(BOOTSTRAP_SRC),
        'bootstrap ptyClearTerminal must delete handle.agentInstanceId from seatBlockCache'
    );
    assert.ok(
        /case\s+'ptyClearAllTerminals':[\s\S]*?seatBlockCache\.clear\(\)/.test(BOOTSTRAP_SRC),
        'bootstrap ptyClearAllTerminals must clear seatBlockCache'
    );
});

test('standalone deliverPrompt delivers seat block when opts.clearBeforePrompt is true', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('await sendPromptToPty', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('opts?.clearBeforePrompt === true'),
        'deliverPrompt must bypass suppression when opts.clearBeforePrompt is true'
    );
});

test('standalone deliverPrompt prunes seatBlockCache against live active fleet', () => {
    const fnStart = BOOTSTRAP_SRC.indexOf('const deliverPrompt = async');
    const fnEnd = BOOTSTRAP_SRC.indexOf('await sendPromptToPty', fnStart);
    const fnBody = BOOTSTRAP_SRC.slice(fnStart, fnEnd);
    assert.ok(
        fnBody.includes('ptyFleetService.listActive()') && fnBody.includes('seatBlockCache.delete('),
        'deliverPrompt must prune seatBlockCache against live active fleet instance IDs'
    );
});

test('TaskViewerProvider invalidates seat block cache on a bare /clear ptyWrite (sidebar clear buttons)', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        verbBody.includes("verb === 'ptyWrite'") && verbBody.includes("=== '/clear'"),
        "_ptyHostVerb must invalidate _seatBlockCache on a bare '/clear' ptyWrite — sendToTerminal routes the sidebar clear buttons down the raw-write branch, never through ptyClearTerminal"
    );
});

test('TaskViewerProvider invalidates seat block cache on ptyRenameTerminal (stale-name trap)', () => {
    const verbStart = TASK_VIEWER_SRC.indexOf('private async _ptyHostVerb');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(
        verbBody.includes("verb === 'ptyRenameTerminal'"),
        '_ptyHostVerb must drop the seat entry on ptyRenameTerminal — the cache is found by name here while rename() mutates friendlyName under an unchanged agentInstanceId, so a surviving entry defeats every later ptyClearTerminal'
    );
});

test('standalone sendToTerminal drops the seat block memo on a bare /clear write', () => {
    const caseStart = BOOTSTRAP_SRC.indexOf("case 'sendToTerminal': {", BOOTSTRAP_SRC.indexOf('const handlePtyVerb'));
    assert.ok(caseStart > 0, "bootstrap must have a sendToTerminal case in handlePtyVerb");
    const caseEnd = BOOTSTRAP_SRC.indexOf('return { success: true, ...(created', caseStart);
    const caseBody = BOOTSTRAP_SRC.slice(caseStart, caseEnd);
    assert.ok(
        caseBody.includes("text.trim() === '/clear'") && caseBody.includes('seatBlockCache.delete(handle.agentInstanceId)'),
        "standalone sendToTerminal must drop the seat's seatBlockCache entry on a bare '/clear' write — that branch wipes the seat's context without reaching ptyClearTerminal"
    );
});

// ── 7. Dispatch protocol & folded attribution ──────────────────────────────

test('BEHAVIOUR: ensureDispatchProtocolDirectives attaches both completion and report directives idempotently', () => {
    const raw = 'Please write the code according to the plan.';
    const formatted = ensureDispatchProtocolDirectives(raw);
    assert.ok(formatted.includes('COMPLETION REPORT:'), 'must attach completion directive');
    assert.ok(formatted.includes('ORCHESTRATOR REPORT:'), 'must attach orchestrator report directive');

    const doubleFormatted = ensureDispatchProtocolDirectives(formatted);
    assert.strictEqual(doubleFormatted, formatted, 'ensureDispatchProtocolDirectives must be idempotent');
});

test('TaskViewerProvider _ptyHostVerb handles dispatch payload and folded attribution', () => {
    assert.ok(
        TASK_VIEWER_SRC.includes('ensureDispatchProtocolDirectives(payload.data)'),
        'TaskViewerProvider must apply ensureDispatchProtocolDirectives when dispatch payload is present'
    );
    assert.ok(
        TASK_VIEWER_SRC.includes("handleServiceVerb('attributePastedPrompt'"),
        'TaskViewerProvider must invoke attributePastedPrompt for folded attribution'
    );
    assert.ok(
        TASK_VIEWER_SRC.includes("directivesAttached = ['COMPLETION REPORT', 'ORCHESTRATOR REPORT']"),
        'TaskViewerProvider must record directivesAttached on dispatch'
    );
    assert.ok(
        TASK_VIEWER_SRC.includes('attrRes.attributed === 0'),
        'TaskViewerProvider must fail-closed if attribution yields 0 attributed plans'
    );
});

test('standalone bootstrap handlePtyVerb and deliverPrompt handle dispatch payload', () => {
    assert.ok(
        BOOTSTRAP_SRC.includes('ensureDispatchProtocolDirectives(out)'),
        'bootstrap deliverPrompt must apply ensureDispatchProtocolDirectives on dispatch'
    );
    assert.ok(
        BOOTSTRAP_SRC.includes("kanbanProvider.handleServiceVerb('attributePastedPrompt'"),
        'bootstrap ptySendPrompt must fold attribution via kanbanProvider'
    );
    assert.ok(
        BOOTSTRAP_SRC.includes('attrRes.attributed === 0'),
        'bootstrap ptySendPrompt must fail-closed if attribution yields 0 attributed plans'
    );
});

// `dispatch` is the first caller-settable prompt-composition field, and
// `dispatch.planId` / `planFile` reach a DB UPDATE. `/terminals/verb/*` has no
// per-field schema, so the reject-don't-coerce rule is the whole guard.
test('BEHAVIOUR: validateDispatchPayload rejects bad shapes instead of coercing them', () => {
    const good = validateDispatchPayload({ planId: '  abc  ', planFile: ' p.md ', role: ' coder ' });
    assert.ok(good.ok, 'a well-formed dispatch must validate');
    assert.deepStrictEqual(good.value, { planId: 'abc', planFile: 'p.md', role: 'coder' });

    for (const bad of [[], 'x', 7, null, undefined]) {
        assert.strictEqual(validateDispatchPayload(bad).ok, false, `dispatch=${JSON.stringify(bad)} must be rejected`);
    }
    for (const field of ['planId', 'planFile', 'role']) {
        const res = validateDispatchPayload({ [field]: 42 });
        assert.strictEqual(res.ok, false, `non-string dispatch.${field} must be rejected, not coerced to ''`);
        assert.ok(res.error.includes(field), `the error must name the offending field: ${res.error}`);
    }
    const badRole = validateDispatchPayload({ planFile: 'p.md', role: 'wizard' });
    assert.strictEqual(badRole.ok, false, 'an unknown role must be rejected — it is written to dispatched_agent');
    for (const role of DISPATCH_ROLES) {
        assert.ok(validateDispatchPayload({ role }).ok, `known seat role rejected: ${role}`);
    }
});

// A schema entry that no route invokes is decoration. `/terminals/verb/*` had no
// per-field validation at all, so the declared ptySendPrompt shape only bites if
// the route calls the validator.
test('the ptySendPrompt schema is declared AND invoked on the /terminals/verb rail', () => {
    const schemas = fs.readFileSync(path.join(__dirname, '..', 'services', 'verbSchemas.ts'), 'utf8');
    const api = fs.readFileSync(path.join(__dirname, '..', 'services', 'LocalApiServer.ts'), 'utf8');
    const taskViewerBlock = schemas.slice(schemas.indexOf('export const TASK_VIEWER_VERB_SCHEMAS'));
    assert.ok(
        /ptySendPrompt: \{[\s\S]*?dispatch: \{ type: 'object' \}/.test(taskViewerBlock),
        'TASK_VIEWER_VERB_SCHEMAS.ptySendPrompt must declare the dispatch field'
    );
    const handler = api.slice(api.indexOf('private async _handleTerminalVerb'));
    const handlerBody = handler.slice(0, handler.indexOf('private async _handleTerminalsRelay'));
    assert.ok(
        /validateVerbPayload\('taskViewer', verb, body\)/.test(handlerBody),
        '_handleTerminalVerb does not invoke validateVerbPayload — the declared ptySendPrompt schema is dead on the route the lead actually calls'
    );
    assert.ok(
        /verb\.startsWith\('pty'\)/.test(handlerBody),
        'the validation must stay scoped to the pty rail — sendToTerminal rides this route with a different payload per host'
    );
});

test('both hosts validate the dispatch payload before it reaches the DB', () => {
    for (const [name, src] of [['TaskViewerProvider', TASK_VIEWER_SRC], ['bootstrap', BOOTSTRAP_SRC]]) {
        assert.ok(
            src.includes('validateDispatchPayload(payload.dispatch)'),
            `${name} must shape-validate dispatch — an unvalidated planId reaches attributePasteDispatch`
        );
    }
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}, 1000);

