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
    roleTakesDispatchDirectives,
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

test('BEHAVIOUR: omits directives the composed prompt already carries', () => {
    const opts = { skipTests: true, cavemanOutput: true, gitProhibitionEnabled: true, gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush' };
    const full = buildSeatDirectiveBlock(opts);
    assert.strictEqual(
        buildSeatDirectiveBlock(opts, `some board prompt\n\n${full}`),
        '',
        'A board-composed prompt that already carries every part must yield an empty seat block.'
    );
});

test('BEHAVIOUR: still emits parts the composed prompt lacks', () => {
    const opts = { skipTests: true, cavemanOutput: true };
    const out = buildSeatDirectiveBlock(opts, `board prompt\n\n${SKIP_TESTS_DIRECTIVE}`);
    assert.ok(out.includes(CAVEMAN_OUTPUT_DIRECTIVE), 'Caveman directive must still be delivered when absent from the composed prompt.');
    assert.ok(!out.includes(SKIP_TESTS_DIRECTIVE), 'Skip-tests directive must NOT be re-delivered when already present.');
});

test('BEHAVIOUR: a divergent worktree git policy is NOT deduped against the board non-worktree policy', () => {
    const boardOpts = { gitProhibitionEnabled: true, gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush', worktreeActive: false };
    const seatOpts = { gitProhibitionEnabled: true, gitBranchStrategy: 'current', gitCommitStrategy: 'whenDone', gitPushStrategy: 'noPush', worktreeActive: true };
    const boardBlock = buildSeatDirectiveBlock(boardOpts);
    const seatBlock = buildSeatDirectiveBlock(seatOpts, `board prompt\n\n${boardBlock}`);
    // If the two git policy lines differ (worktree flag changes the output), the
    // seat's policy MUST still appear in the filtered block.
    const boardGit = buildGitPolicyBlock({ branch: 'current', commit: 'whenDone', push: 'noPush', guardrail: true, worktreeActive: false });
    const seatGit = buildGitPolicyBlock({ branch: 'current', commit: 'whenDone', push: 'noPush', guardrail: true, worktreeActive: true });
    if (boardGit !== seatGit) {
        assert.ok(seatBlock.includes(seatGit), 'A divergent worktree git policy must NOT be deduped — it is seat-scoped truth.');
    }
    // If they happen to be identical (worktree flag does not change the line for
    // this clause set), the seat block is empty — also correct.
});

// The dedupe above is INERT unless both hosts actually hand the prompt to the
// composer. That is link 2 of the chain and it is invisible to every behavioural
// assertion in this file: the composer keeps its old single-argument behaviour, so
// a host that drops the second argument re-duplicates every directive on the
// drag-to-terminal path while all 90+ cases here stay green. Pinned as source
// text because reaching either call site needs a live host. The standalone twin is
// the seam that goes silently un-wired, so both are asserted, not just the
// extension host.
test('SOURCE: both hosts pass the stripped prompt as buildSeatDirectiveBlock\'s second argument', () => {
    for (const [name, src, arg] of [
        ['TaskViewerProvider', TASK_VIEWER_SRC, 'data'],
        ['bootstrap', BOOTSTRAP_SRC, 'out'],
    ]) {
        assert.ok(
            new RegExp(`buildSeatDirectiveBlock\\(\\s*\\{[^}]*\\}\\s*,\\s*${arg}\\s*\\)`).test(src),
            `${name} must call buildSeatDirectiveBlock({ ... }, ${arg}) — without the prompt argument the `
            + 'seat block cannot dedupe against a board-composed prompt, and the drag-to-terminal path '
            + 'delivers every add-on directive twice'
        );
    }
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
    // The guard must exist; WHICH array it guards is not the contract. It was
    // `parts` before the composed-prompt dedupe landed and is `emitted` (the
    // post-filter array) after — pinning the identifier made this gate fail on a
    // rename while the behavioural assertion above (`buildSeatDirectiveBlock({})
    // === ''`) stayed green, which is the wrong way round.
    assert.ok(
        /(?:emitted|parts)\.length\s*===\s*0.*return\s+''/.test(fnBody),
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
    // SCOPED to the composition block, not the whole method. The contract is
    // "one round-trip serves both the live set and the seat role", and that is a
    // statement about THIS block. The team roster-clear barrier earlier in
    // _ptyHostVerb makes its own call, deliberately: it runs before this block,
    // only when a dispatch opens a NEW work context on a team, and it needs a
    // fresh lastDataAt snapshot to compute busy/deferred seats — it could not
    // reuse a result that has not been fetched yet. A whole-method count read
    // that legitimate second call as a violation and turned this gate into noise.
    const verbStart = TASK_VIEWER_SRC.indexOf('const applySO = payload?.standingOrders');
    const verbEnd = TASK_VIEWER_SRC.indexOf('const http = require', verbStart);
    const verbBody = TASK_VIEWER_SRC.slice(verbStart, verbEnd);
    assert.ok(verbStart > 0 && verbEnd > verbStart, 'composition block not found in _ptyHostVerb');
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
    // Standing orders are now ON: the explicit `standingOrders: false` opt-out
    // is gone, so `applySO` (payload?.standingOrders !== false) defaults to true.
    // The recipient acts on this notification and needs its durable orders fresh.
    assert.ok(
        !fnBody.includes('standingOrders: false'),
        'notifyTurnEnd must NOT pass standingOrders: false — the recipient acts on this notification and needs its standing orders'
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
/**
 * Read the 6th positional argument by BALANCING the call's parentheses and
 * splitting on top-level commas.
 *
 * The previous form took `lines.slice(i, i + 12)`, cut at the first `);`, and
 * tail-anchored `/,\s*true\s*$/`. That failed open on any site whose 7th
 * `delivery` argument follows the marker — the `true` was no longer last, so two
 * genuinely composed sites (the standing-orders one-shot and the single-card
 * board dispatch) were classified UNCOMPOSED and waved through by the per-site
 * "must NOT pass true" loop below. Cutting at the first `);` also truncated any
 * call containing a nested `)` before its own close. Parse the arguments.
 */
function dispatchCallArgs(lines, startIdx) {
    const text = lines.slice(startIdx, startIdx + 40).join('\n');
    let i = text.indexOf('_dispatchExecuteMessage(') + '_dispatchExecuteMessage('.length;
    const args = [];
    let cur = '';
    let depth = 1;
    let quote = null;
    for (; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') { cur += text[i] + (text[i + 1] || ''); i++; continue; }
            if (c === quote) { quote = null; }
            cur += c;
            continue;
        }
        if (c === '\'' || c === '"' || c === '`') { quote = c; cur += c; continue; }
        if (c === '(' || c === '[' || c === '{') { depth++; cur += c; continue; }
        if (c === ')' || c === ']' || c === '}') {
            depth--;
            if (depth === 0) { break; }
            cur += c;
            continue;
        }
        if (c === ',' && depth === 1) { args.push(cur); cur = ''; continue; }
        cur += c;
    }
    if (cur.trim()) { args.push(cur); }
    return args;
}

function classifyDispatchCallSites() {
    const lines = TASK_VIEWER_SRC.split('\n');
    const composed = [];
    const uncomposed = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/this\._dispatchExecuteMessage\(/.test(lines[i])) { continue; }
        const args = dispatchCallArgs(lines, i);
        // 6th positional argument is `promptComposed` (default false). Strip any
        // trailing line comment before comparing.
        const sixth = args.length >= 6 ? args[5].replace(/\/\/.*/g, '').trim() : '';
        (sixth === 'true' ? composed : uncomposed).push(i + 1);
    }
    return { composed, uncomposed };
}

// Audit re-run 2026-08-31 (reviewer pass). The counts moved 12/5/7 -> 14/5/9:
// the fleet-creation policy added `createFleetTerminalAndDeliver`, whose two
// `_dispatchExecuteMessage` sites (the pre-spawn re-check delivery and the
// post-spawn delivery) both pass the raw caller prompt UNCOMPOSED, so the
// delivery layer appends the seat block on both. That is the safe direction.
//
// The earlier 2026-08-30 re-run moved 7/2/5 -> 12/5/7 after a tail-anchored
// classifier hid two of the marked sites, so the gate was reporting the wrong
// shape in the UNSAFE direction. The five marked sites, each justified:
//   1. the standing-orders one-shot — the rendered orders block IS the payload,
//      so a seat directive block appended after it would be a second suffix;
//   2. batch-group dispatch — prompt from buildKanbanBatchPrompt;
//   3. mechanical-gate findings to the reviewer's coder;
//   4. phone-a-friend pre-review findings to the reviewer's coder;
//   5. single-card dispatch — prompt from generateUnifiedPrompt (it grew a 7th
//      `delivery` argument carrying originTerminal, which is what defeated the
//      old tail anchor).
// 3 and 4 are the debatable pair: their prompts are inline template literals,
// not agentPromptBuilder output, and they ask a coder to change code. Their
// recipient is mid-turn with its seat block already cached, so nothing is lost
// today — but the marker is doing semantic work it was not designed for. Left
// as-is deliberately and recorded, rather than changed by a reviewer on a path
// outside the plan under review.
test('exactly 14 _dispatchExecuteMessage call sites exist, and exactly 5 pass promptComposed: true', () => {
    const { composed, uncomposed } = classifyDispatchCallSites();
    assert.strictEqual(
        composed.length + uncomposed.length, 14,
        `Expected 14 _dispatchExecuteMessage call sites (the audited set), found ${composed.length + uncomposed.length}. ` +
        'A new call site must be classified deliberately: it defaults to promptComposed=false and therefore ' +
        'GAINS the seat block, which is the safe direction — but the audit must be re-run.'
    );
    assert.strictEqual(
        composed.length, 5,
        `Exactly 5 call sites may pass promptComposed: true (see the audit note above this test). ` +
        `Found ${composed.length} at lines [${composed.join(', ')}]. ` +
        'Marking a sixth exempts an uncomposed path from its seat safeguards, silently.'
    );
});

test('each of the 9 uncomposed dispatch call sites is enumerated and unmarked', () => {
    const { uncomposed } = classifyDispatchCallSites();
    assert.strictEqual(
        uncomposed.length, 9,
        `Expected 9 uncomposed dispatch call sites — dispatchCustomPromptToRole, the two Mission Control ` +
        `kickoffs, the pair-programming send, _tryFleetDeliveryForRole, createFleetTerminalAndDeliver's ` +
        `pre-spawn re-check and post-spawn delivery, the Airlock patch hand-off and the ` +
        `team-automation scheduler send. Found ${uncomposed.length} at lines [${uncomposed.join(', ')}].`
    );
    // Each must reach the funnel WITHOUT the marker, so the delivery layer
    // appends the seat block. Assert per site, not in aggregate.
    const srcLines = TASK_VIEWER_SRC.split('\n');
    for (const line of uncomposed) {
        // Same parser as the classifier — a tail anchor here missed a marker
        // followed by a 7th `delivery` argument, which is the whole reason two
        // marked sites were mis-filed into this list in the first place.
        const args = dispatchCallArgs(srcLines, line - 1);
        const sixth = args.length >= 6 ? args[5].replace(/\/\/.*/g, '').trim() : '';
        assert.notStrictEqual(
            sixth, 'true',
            `Uncomposed dispatch call site at line ${line} must NOT pass promptComposed: true — ` +
            'its prompt was never composed by agentPromptBuilder, so suppressing the seat block ' +
            'would reproduce the incident on that path.'
        );
    }
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

// ── 11. Standalone dispatch uses the shared prompt builder ──────────────
test('standalone triggerAction calls generateUnifiedPrompt, not a local builder', () => {
    assert.ok(!/function buildPromptForCards/.test(BOOTSTRAP_SRC),
        'buildPromptForCards must be gone — the standalone host builds prompts via KanbanProvider');
    assert.ok(/kanbanProvider\.buildDispatchPlans\(/.test(BOOTSTRAP_SRC),
        'standalone must funnel records through buildDispatchPlans (feature subtasks are dropped otherwise)');
    assert.ok(/kanbanProvider\.generateUnifiedPrompt\(/.test(BOOTSTRAP_SRC),
        'standalone must build its dispatch prompt with generateUnifiedPrompt');
});

test('standalone dispatch does not re-append the seat directive block', () => {
    const arm = BOOTSTRAP_SRC.slice(BOOTSTRAP_SRC.indexOf("case 'triggerAction'"));
    const call = arm.slice(0, arm.indexOf('updateDispatchInfoByPlanFile'));
    assert.ok(/deliverPrompt\(terminal, prompt, getPromptDeliveryOptions\(\), true, false\)/.test(call),
        'a composed prompt must pass applySeatBlock=false or the git policy block is delivered twice');
});

test('getLocalApiServerPort resolves the standalone-wired server', () => {
    const fn = TASK_VIEWER_SRC.slice(TASK_VIEWER_SRC.indexOf('public getLocalApiServerPort()'));
    assert.ok(/_apiServerForBroadcast/.test(fn.slice(0, 400)),
        'the accessor must fall back to the field setApiServer writes, or every headless prompt reads apiPort 0');
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

test('standalone turn-end passes applyOrders = true, applySeatBlock = false', () => {
    // The turn-end send calls deliverPrompt with 5th arg false.
    const turnEndIdx = BOOTSTRAP_SRC.indexOf('turn-end delivery to');
    assert.ok(turnEndIdx >= 0, 'turn-end send not found');
    const sendIdx = BOOTSTRAP_SRC.indexOf('deliverPrompt(handle, message', turnEndIdx - 200);
    const sendEnd = BOOTSTRAP_SRC.indexOf(');', sendIdx);
    const sendCall = BOOTSTRAP_SRC.slice(sendIdx, sendEnd + 2);
    assert.ok(
        /true,\s*false\)/.test(sendCall),
        'standalone turn-end must pass applyOrders=true and applySeatBlock=false to deliverPrompt'
    );
});

// ── 14. Skill file seat-safeguards paragraph — REMOVED ───────────────────
// The terminal-coder-dispatch skill file was deleted; its rules were inlined
// into _buildDrivePrefix in KanbanProvider.ts. The seat safeguards are enforced
// by the delivery layer (buildSeatDirectiveBlock), not by a skill file, so no
// retargeting is needed — the safeguards are system-enforced.

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
    assert.ok(formatted.includes('MISSION CONTROL REPORT:'), 'must attach Mission Control report directive');
    // The completion directive body must name the API POST as the completion
    // signal — the mtime-based file-watcher phrasing is gone. The sentinel
    // alone is not enough: a paraphrased body that drops the POST leaves the
    // agent with no instruction to signal completion.
    assert.ok(formatted.includes('POST /kanban/queue/done'), 'completion directive body must reference POST /kanban/queue/done');
    assert.ok(!formatted.includes('the file watcher detects it'), 'completion directive body must not reference the file watcher');

    const doubleFormatted = ensureDispatchProtocolDirectives(formatted);
    assert.strictEqual(doubleFormatted, formatted, 'ensureDispatchProtocolDirectives must be idempotent');
});

test('BEHAVIOUR: ensureDispatchProtocolDirectives suppresses Mission Control report when missionControlActive=false', () => {
    const raw = 'Please write the code according to the plan.';
    const formatted = ensureDispatchProtocolDirectives(raw, false);
    assert.ok(formatted.includes('COMPLETION REPORT:'), 'must still attach completion directive');
    assert.ok(!formatted.includes('MISSION CONTROL REPORT:'), 'must NOT attach Mission Control report directive when missionControlActive=false');

    // Default (no flag) still attaches both
    const defaultFormatted = ensureDispatchProtocolDirectives(raw);
    assert.ok(defaultFormatted.includes('MISSION CONTROL REPORT:'), 'must attach Mission Control report directive by default');
});

test('TaskViewerProvider _ptyHostVerb handles dispatch payload and folded attribution', () => {
    assert.ok(
        TASK_VIEWER_SRC.includes('ensureDispatchProtocolDirectives(payload.data, missionControlActive)'),
        'TaskViewerProvider must apply ensureDispatchProtocolDirectives when dispatch payload is present, '
        + 'gated on the live Mission Control state'
    );
    assert.ok(
        TASK_VIEWER_SRC.includes("handleServiceVerb('attributePastedPrompt'"),
        'TaskViewerProvider must invoke attributePastedPrompt for folded attribution'
    );
    assert.ok(
        TASK_VIEWER_SRC.includes('directivesAttached = missionControlActive')
        && TASK_VIEWER_SRC.includes("? ['COMPLETION REPORT', 'MISSION CONTROL REPORT']")
        && TASK_VIEWER_SRC.includes(": ['COMPLETION REPORT']"),
        'TaskViewerProvider must record directivesAttached on dispatch, and the record must track the '
        + 'gate — reporting MISSION CONTROL REPORT when it was suppressed is a lie the dispatch log carries'
    );
    assert.ok(
        TASK_VIEWER_SRC.includes('attrRes.attributed === 0'),
        'TaskViewerProvider must fail-closed if attribution yields 0 attributed plans'
    );
});

test('standalone bootstrap handlePtyVerb and deliverPrompt handle dispatch payload', () => {
    assert.ok(
        BOOTSTRAP_SRC.includes('ensureDispatchProtocolDirectives(out, missionControlActive)'),
        'bootstrap deliverPrompt must apply ensureDispatchProtocolDirectives on dispatch, '
        + 'gated on the live Mission Control state'
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

// ── 17. Team-commit gate: a team commits once, as its head ───────────────
//
// Plan: a-team-commits-once-as-its-head.md. A non-head member of a live team
// is forced to dontCommit; the head is forced to whenDone. The gate is
// symmetric, rides the delivery layer (not the board path), and survives
// standingOrders: false. resolveTeamStanding is the ONE predicate both
// selectOrders and both hosts call — no hand-rolled membership test.

// The compiled out/ module predates resolveTeamStanding (compilation is
// skipped in this run), so the predicate is extracted from the TypeScript
// source and evaluated in-process — same source-text fidelity as the
// dispatchIdentity tests, exercising real behaviour.
function loadResolveTeamStanding() {
    const src = STANDING_ORDERS_SRC;
    const fnStart = src.indexOf('export function resolveTeamStanding');
    assert.ok(fnStart >= 0, 'resolveTeamStanding must be exported from standingOrders.ts');
    // The function has a multi-line TS return type annotation `{ ... }`
    // between the closing `)` and the opening `{` of the body. The first `{`
    // after the signature opens the return type; its matching `}` closes it;
    // the NEXT `{` opens the body.
    const firstBrace = src.indexOf('{', fnStart);
    let depth = 0, returnTypeClosed = false, bodyStart = -1;
    for (let i = firstBrace; i < src.length; i++) {
        if (src[i] === '{') {
            depth++;
            if (returnTypeClosed) { bodyStart = i; break; }
        }
        if (src[i] === '}') {
            depth--;
            if (depth === 0) { returnTypeClosed = true; }
        }
    }
    assert.ok(bodyStart >= 0, 'resolveTeamStanding body opening brace not found');
    // Find the matching closing brace for the body.
    depth = 1;
    let bodyEnd = -1;
    for (let i = bodyStart + 1; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { bodyEnd = i; break; } }
    }
    assert.ok(bodyEnd > 0, 'resolveTeamStanding body closing brace not found');
    // The body is pure JS — no TS annotations inside the function. Wrap it
    // with the scopeOf helper (module-private, called by the body) and expose
    // it via new Function with the right parameter names.
    const body = src.substring(bodyStart + 1, bodyEnd);
    return new Function('targetName', 'orders', 'groups',
        'function scopeOf(o) { return o.scope || "pair"; }\n' + body
    );
}

// Extract the GIT_COMMIT_CLAUSES text from agentPromptBuilder.ts source so the
// behavioural tests can assert string-equal without an export.
function extractCommitClauses() {
    const src = AGENT_PROMPT_BUILDER_SRC;
    const start = src.indexOf('const GIT_COMMIT_CLAUSES');
    assert.ok(start >= 0, 'GIT_COMMIT_CLAUSES must exist in agentPromptBuilder.ts');
    const objStart = src.indexOf('{', start);
    let depth = 0, end = -1;
    for (let i = objStart; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    const objText = src.substring(objStart, end);
    // Parse the two string values: whenDone and dontCommit.
    const whenDoneMatch = objText.match(/whenDone:\s*'((?:[^'\\]|\\.)*)'/);
    const dontCommitMatch = objText.match(/dontCommit:\s*'((?:[^'\\]|\\.)*)'/);
    assert.ok(whenDoneMatch, 'whenDone clause must be parseable from GIT_COMMIT_CLAUSES');
    assert.ok(dontCommitMatch, 'dontCommit clause must be parseable from GIT_COMMIT_CLAUSES');
    // Unescape the single-quoted string values.
    const unescape = (s) => s.replace(/\\'/g, "'").replace(/\\n/g, '\n');
    return { whenDone: unescape(whenDoneMatch[1]), dontCommit: unescape(dontCommitMatch[1]) };
}

const COMMIT_CLAUSES = extractCommitClauses();

// 1. resolveTeamStanding returns {inTeam:true,isHead:false} for a roster member
//    that is not the order's parent, and {inTeam:true,isHead:true} for the parent.
test('resolveTeamStanding: a non-head member resolves isHead false; the head resolves isHead true', () => {
    const resolve = loadResolveTeamStanding();
    const teamId = 'team_lead_1';
    const headName = 'lead-1';
    const memberName = 'lead-1-coder-1';
    const groups = [{ id: teamId, name: 'lead-1', members: [headName, memberName, 'Coding-reviewer'] }];
    const orders = [
        { id: 'team-member', parent: headName, child: '', instruction: 'report to head', createdAt: 0, scope: 'team', teamId },
        { id: 'team-head', parent: headName, child: '', instruction: 'advance to reviewed', createdAt: 0, scope: 'team-head', teamId },
    ];
    const memberStanding = resolve(memberName, orders, groups);
    assert.ok(memberStanding.inTeam, 'member must be inTeam');
    assert.strictEqual(memberStanding.isHead, false, 'member must not be head');
    const headStanding = resolve(headName, orders, groups);
    assert.ok(headStanding.inTeam, 'head must be inTeam');
    assert.strictEqual(headStanding.isHead, true, 'head must be head');
});

// 1b. SYMMETRY REGRESSION: `wireSpawnedTeam` writes the `team-head` order ONLY
//     when the team was wired with a non-empty headPrompt — true for exactly one
//     of the three shipped team types, and for no operator-created team that left
//     the head-prompt box empty. Resolving headship from the `team-head` scope
//     ALONE therefore left such a head as inTeam:false, so the gate gagged its
//     members into dontCommit while the head kept the shipped notSpecified
//     default and received no commit clause at all — a completed body of work
//     with no committer, which is the exact asymmetry this gate exists to
//     prevent. The ALWAYS-written `team` order carries the head name in `parent`
//     (that is how selectOrders excludes the head from member delivery), so
//     headship resolves from it too.
test('resolveTeamStanding: a team wired with NO headPrompt still resolves its head as isHead', () => {
    const resolve = loadResolveTeamStanding();
    const teamId = 'team_res_lead';
    const headName = 'res-lead';
    const memberName = 'res-1';
    const groups = [{ id: teamId, name: headName, members: [headName, memberName] }];
    // Only the `team` order — no `team-head` row, because no headPrompt was supplied.
    const orders = [
        { id: 'team-member', parent: headName, child: '', instruction: 'report to head', createdAt: 0, scope: 'team', teamId },
    ];
    const headStanding = resolve(headName, orders, groups);
    assert.strictEqual(headStanding.inTeam, true,
        'a headPrompt-less team head must be inTeam, or the commit gate skips it entirely');
    assert.strictEqual(headStanding.isHead, true,
        'a headPrompt-less team head must resolve isHead, or its team is gagged with no committer');
    assert.deepStrictEqual(headStanding.members, [headName, memberName],
        'the head must carry its team roster verbatim, or its commit trailers resolve no plan ids');
    const memberStanding = resolve(memberName, orders, groups);
    assert.strictEqual(memberStanding.inTeam, true, 'the member is still gated');
    assert.strictEqual(memberStanding.isHead, false, 'the member is still not the head');
});

// 2. A seat with gitCommitStrategy 'whenDone' that is a non-head member composes
//    a block containing GIT_COMMIT_CLAUSES.dontCommit verbatim and NOT the
//    whenDone text.
test('BEHAVIOUR: a non-head member with role whenDone composes dontCommit, not whenDone', () => {
    // Simulate the delivery-layer override: seatOpts.whenDone → effectiveOpts.dontCommit.
    const block = buildSeatDirectiveBlock({
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'dontCommit',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
    });
    assert.ok(block.includes(COMMIT_CLAUSES.dontCommit),
        'a non-head member must receive the dontCommit clause verbatim');
    assert.ok(!block.includes(COMMIT_CLAUSES.whenDone),
        'a non-head member must NOT receive the whenDone clause — the gate overrides the role strategy');
});

// 3. A head whose role config carries no commit strategy (notSpecified, the
//    shipped default) composes the whenDone clause — the symmetry guard. A head
//    with an explicit dontCommit composes whenDone too.
test('BEHAVIOUR: a head with notSpecified composes whenDone; a head with explicit dontCommit also composes whenDone', () => {
    // notSpecified → gate forces whenDone
    const blockDefault = buildSeatDirectiveBlock({
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'whenDone',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
    });
    assert.ok(blockDefault.includes(COMMIT_CLAUSES.whenDone),
        'a head with no commit strategy must receive the whenDone clause — the symmetry guard. ' +
        'A head shipped notSpecified emits no commit clause at all, so gagging members without forcing the head ' +
        'produces a team whose completed work nobody is told to commit.');
    // Explicit dontCommit → gate still forces whenDone (the override wins)
    const blockExplicit = buildSeatDirectiveBlock({
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'whenDone',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
    });
    assert.ok(blockExplicit.includes(COMMIT_CLAUSES.whenDone),
        'a head with an explicit dontCommit must still receive whenDone — being the head of a live team ' +
        'is itself the statement that this seat closes the team\'s work.');
    assert.ok(!blockExplicit.includes(COMMIT_CLAUSES.dontCommit),
        'a head must NOT receive dontCommit — the gate overrides the explicit role strategy');
});

// 4. A seat in no group composes a block byte-identical to the same call before
//    this change — the no-team path is untouched.
test('BEHAVIOUR: a seat in no group composes a block byte-identical to the pre-change call', () => {
    // The gate is a no-op when standing.inTeam is false: effectiveOpts === seatOpts.
    // So a seat with no team gets exactly what resolveSeatPromptOptions produced.
    const opts = {
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'whenDone',
        gitBranchStrategy: 'current',
        gitPushStrategy: 'noPush',
    };
    const block = buildSeatDirectiveBlock(opts);
    assert.strictEqual(
        block,
        buildGitPolicyBlock({
            branch: opts.gitBranchStrategy,
            commit: opts.gitCommitStrategy,
            push: opts.gitPushStrategy,
            guardrail: opts.gitProhibitionEnabled,
            worktreeActive: undefined,
            worktreePerPlanActive: undefined,
        }),
        'a seat in no group must compose a block byte-identical to the shared builder — the gate is a no-op'
    );
});

// 5. Source-text: selectOrders calls resolveTeamStanding; neither host contains
//    its own g.members.includes( membership test.
test('selectOrders calls resolveTeamStanding and neither host hand-rolls a membership test', () => {
    const selectStart = STANDING_ORDERS_SRC.indexOf('function selectOrders(');
    assert.ok(selectStart >= 0, 'selectOrders must exist in standingOrders.ts');
    const selectEnd = STANDING_ORDERS_SRC.indexOf('\n}', selectStart);
    const selectBody = STANDING_ORDERS_SRC.slice(selectStart, selectEnd);
    assert.ok(
        selectBody.includes('resolveTeamStanding('),
        'selectOrders must call resolveTeamStanding so the two cannot diverge on team-scope semantics'
    );
    for (const [name, src] of [['TaskViewerProvider', TASK_VIEWER_SRC], ['bootstrap', BOOTSTRAP_SRC]]) {
        assert.ok(
            !/g\.members\.includes\(/.test(src) && !/groups\.find\([^)]*\)\.members\.includes\(/.test(src),
            `${name} must NOT hand-roll a g.members.includes( membership test — resolveTeamStanding is the one predicate`
        );
    }
});

// 6. Source-text: buildKanbanBatchPrompt contains no resolveTeamStanding call —
//    the board path is deliberately ungated.
test('buildKanbanBatchPrompt contains no resolveTeamStanding call (board path is ungated)', () => {
    const fnStart = AGENT_PROMPT_BUILDER_SRC.indexOf('export function buildKanbanBatchPrompt');
    assert.ok(fnStart >= 0, 'buildKanbanBatchPrompt must exist in agentPromptBuilder.ts');
    // Find the end of the function by brace matching.
    const braceStart = AGENT_PROMPT_BUILDER_SRC.indexOf('{', fnStart);
    let depth = 0, fnEnd = -1;
    for (let i = braceStart; i < AGENT_PROMPT_BUILDER_SRC.length; i++) {
        if (AGENT_PROMPT_BUILDER_SRC[i] === '{') depth++;
        else if (AGENT_PROMPT_BUILDER_SRC[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
    }
    const fnBody = AGENT_PROMPT_BUILDER_SRC.slice(fnStart, fnEnd);
    assert.ok(
        !fnBody.includes('resolveTeamStanding'),
        'buildKanbanBatchPrompt must NOT call resolveTeamStanding — a board dispatch bypasses the head ' +
        'entirely (the head receives no callback, never learns the work happened, and would never commit it). ' +
        'Gating the board path would produce work that nobody commits.'
    );
});

// 7. resolveTeamStanding returns members equal to the group's stored members
//    array verbatim (head included, order preserved) for both a member and the
//    head, and members: [] — not undefined — for a seat in no group, a teamId
//    matching no group, and an order with an empty parent.
test('resolveTeamStanding: members is the verbatim roster for member and head; [] never undefined for no-team cases', () => {
    const resolve = loadResolveTeamStanding();
    const teamId = 'team_lead_1';
    const headName = 'lead-1';
    const memberName = 'lead-1-coder-1';
    const reviewerName = 'Coding-reviewer';
    const roster = [headName, memberName, reviewerName];
    const groups = [{ id: teamId, name: 'lead-1', members: roster }];
    const orders = [
        { id: 'team-member', parent: headName, child: '', instruction: 'report to head', createdAt: 0, scope: 'team', teamId },
        { id: 'team-head', parent: headName, child: '', instruction: 'advance to reviewed', createdAt: 0, scope: 'team-head', teamId },
    ];
    // Member: members is the verbatim roster, head included, order preserved.
    const memberStanding = resolve(memberName, orders, groups);
    assert.deepStrictEqual(memberStanding.members, roster,
        'member: members must be the group\'s stored roster verbatim (head included, order preserved)');
    // Head: members is the verbatim roster of the team it heads.
    const headStanding = resolve(headName, orders, groups);
    assert.deepStrictEqual(headStanding.members, roster,
        'head: members must be the verbatim roster of the team it heads');
    // No group: members is [] not undefined.
    const noGroup = resolve('solo-coder', orders, groups);
    assert.deepStrictEqual(noGroup.members, [],
        'a seat in no group must get members: [] — never undefined (subtask 4 consumes this field)');
    assert.strictEqual(noGroup.inTeam, false, 'a seat in no group must get inTeam: false');
    // teamId matching no registered group: members is [] not undefined.
    const orphanOrders = [
        { id: 'orphan', parent: headName, child: '', instruction: 'x', createdAt: 0, scope: 'team', teamId: 'nonexistent' },
    ];
    const orphan = resolve(memberName, orphanOrders, groups);
    assert.deepStrictEqual(orphan.members, [],
        'a teamId matching no registered group must get members: [] — never undefined');
    // Order with an empty parent (team scope, no head name): a member still
    // resolves inTeam with the roster; an empty parent on team-head means no
    // head is identified, so a target that is only a member resolves via team.
    const emptyParentOrders = [
        { id: 'team-no-parent', parent: '', child: '', instruction: 'x', createdAt: 0, scope: 'team', teamId },
    ];
    const emptyParentMember = resolve(memberName, emptyParentOrders, groups);
    assert.deepStrictEqual(emptyParentMember.members, roster,
        'a team order with empty parent still resolves the member with the verbatim roster');
    // A target that is neither head nor member of any team: [] not undefined.
    const emptyParentOutsider = resolve('outsider', emptyParentOrders, groups);
    assert.deepStrictEqual(emptyParentOutsider.members, [],
        'an outsider to a team with empty parent must get members: [] — never undefined');
});

// 8. A send with standingOrders: false to a non-head member still composes the
//    dontCommit clause — suppressing the orders block must not restore commit
//    authority. The gate reads team membership, not the orders payload flag.
test('BEHAVIOUR: standingOrders: false to a non-head member still composes dontCommit', () => {
    // The gate override produces dontCommit regardless of the standingOrders
    // payload flag. buildSeatDirectiveBlock composes the clause from the
    // effective opts, which the delivery layer overrides before this call.
    // This test asserts the COMPOSITION is correct when the override is
    // dontCommit — the source-text assertion that the reads are hoisted
    // above the applySO gate is covered by the hoist comment in both hosts.
    const block = buildSeatDirectiveBlock({
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'dontCommit',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
    });
    assert.ok(block.includes(COMMIT_CLAUSES.dontCommit),
        'a non-head member with standingOrders: false must still receive the dontCommit clause — ' +
        'team standing is a fact about the seat, not an order delivered to it.');
    // Source-text: both hosts hoist the config reads ABOVE the applySeatBlock /
    // applySO branch, so they run unconditionally (even when standingOrders: false).
    for (const [name, src] of [['TaskViewerProvider', TASK_VIEWER_SRC], ['bootstrap', BOOTSTRAP_SRC]]) {
        // The hoisted reads must appear before the seat-block branch in both hosts.
        const hoistIdx = src.indexOf('loadEffectiveStandingOrders');
        const seatBlockIdx = src.indexOf('if (applySeatBlock)');
        assert.ok(hoistIdx >= 0 && seatBlockIdx >= 0 && hoistIdx < seatBlockIdx,
            `${name}: the standing-orders config reads must be hoisted ABOVE the if (applySeatBlock) branch ` +
            'so they run even when standingOrders: false');
        // The gate (resolveTeamStanding call) must appear inside the seat-block
        // branch, after the hoisted reads and before buildSeatDirectiveBlock.
        const gateIdx = src.indexOf('resolveTeamStanding(', hoistIdx);
        const buildIdx = src.indexOf('buildSeatDirectiveBlock', gateIdx);
        assert.ok(gateIdx > hoistIdx && buildIdx > gateIdx,
            `${name}: resolveTeamStanding must be called after the hoisted reads and before buildSeatDirectiveBlock`);
    }
});

// ── 18. Lead-dispatched commits carry stage/plan trailers (gate A) ───────
//
// Plan: lead-dispatched-commits-carry-no-stage-trailers.md. The seat path
// (buildSeatDirectiveBlock) now forwards `stage` and `planIds` into
// buildGitPolicyBlock so a lead-driven coder's commit carries the same
// Switchboard-Stage / Switchboard-Plan trailers a board-dispatched one does.
// `stage` is resolved ONCE in resolveSeatPromptOptions as STAGE_BY_ROLE[role];
// `planIds` is resolved at the CALLER (the composer stays pure, the resolver
// roots on the wrong workspace). Gate B (the notSpecified suppression inside
// buildGitPolicyBlock) is NOT opened here — stage-marker-commit-contract.test.js
// pins it unmodified.

// Helper: extract a function/method body (between matching braces) from TS
// source by name, so source-level assertions can be scoped to one function.
// Matches both `export function foo` / `function foo` and class methods like
// `public async foo(...)` by locating the name as a definition (followed by
// `(`) and then the first `{` after it (the body), skipping any return-type
// punctuation in between.
function sliceFnBody(src, fnName) {
    const defRe = new RegExp(`\\b${fnName}\\s*\\(`);
    const m = defRe.exec(src);
    assert.ok(m, `${fnName} must be defined in source`);
    const firstBrace = src.indexOf('{', m.index);
    assert.ok(firstBrace >= 0, `${fnName} body opening brace not found`);
    let depth = 0, bodyStart = -1;
    for (let i = firstBrace; i < src.length; i++) {
        if (src[i] === '{') { depth++; if (bodyStart < 0) bodyStart = i; }
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(bodyStart, i + 1); }
    }
    assert.ok(false, `${fnName} body closing brace not found`);
}

// 1. whenDone + stage + planIds emits both trailers inside the commit clause.
test('BEHAVIOUR: whenDone + stage + planIds emits Switchboard-Stage and Switchboard-Plan trailers', () => {
    const block = buildSeatDirectiveBlock({
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'whenDone',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
        stage: 'coded',
        planIds: ['p1'],
    });
    assert.ok(block.includes('Switchboard-Stage: coded'),
        'a whenDone seat with stage must carry the Switchboard-Stage trailer');
    assert.ok(block.includes('Switchboard-Plan: p1'),
        'a whenDone seat with planIds must carry one Switchboard-Plan line per id');
});

// 2. Gate A pin: stage omitted → no trailer instruction at all, even with
//    whenDone. This is the gate this plan opens; without it the seat path is dark.
test('BEHAVIOUR: whenDone with stage omitted emits no trailer (gate A pin)', () => {
    const block = buildSeatDirectiveBlock({
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'whenDone',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
        planIds: ['p1'],
    });
    assert.ok(!block.includes('Switchboard-Stage'),
        'no stage → no Switchboard-Stage trailer (gate A supplies stage, nothing else)');
    assert.ok(!block.includes('Switchboard-Plan'),
        'no stage → no Switchboard-Plan trailer (the trailer instruction is one unit)');
});

// 3. stage with empty planIds emits the stage trailer only — a head whose team
//    has no live dispatches still marks its commit's stage.
test('BEHAVIOUR: stage with empty planIds emits the stage trailer only', () => {
    const block = buildSeatDirectiveBlock({
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'whenDone',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
        stage: 'coded',
        planIds: [],
    });
    assert.ok(block.includes('Switchboard-Stage: coded'),
        'stage alone must still emit the Switchboard-Stage trailer');
    assert.ok(!block.includes('Switchboard-Plan'),
        'empty planIds must emit no Switchboard-Plan line');
});

// 4. dontCommit + stage emits no trailer — the instruction sits inside the
//    commit clause, and COMMITTING_STRATEGIES excludes dontCommit.
test('BEHAVIOUR: dontCommit + stage emits no trailer', () => {
    const block = buildSeatDirectiveBlock({
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'dontCommit',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
        stage: 'coded',
        planIds: ['p1'],
    });
    assert.ok(!block.includes('Switchboard-Stage'),
        'dontCommit must not emit a stage trailer — the instruction lives inside the commit clause');
    assert.ok(!block.includes('Switchboard-Plan'),
        'dontCommit must not emit a plan trailer');
});

// 5. Gate-B pin from the seat side: notSpecified + stage + planIds is
//    byte-identical to the same call with stage/planIds omitted. A new
//    capability ships default-OFF (~4000 installs); opening gate B here is
//    barred and belongs to the sibling plan. stage-marker-commit-contract.test.js
//    pins the same invariant from the builder side.
test('BEHAVIOUR: notSpecified + stage + planIds is byte-identical to notSpecified alone (gate B pin)', () => {
    const base = {
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'notSpecified',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
    };
    const without = buildSeatDirectiveBlock(base);
    const withStage = buildSeatDirectiveBlock({ ...base, stage: 'coded', planIds: ['p1'] });
    assert.strictEqual(withStage, without,
        'notSpecified + stage + planIds must be byte-identical to notSpecified alone — ' +
        'gate B is NOT opened by this plan; a new capability ships OFF across every install.');
});

// 6. Purity contract: buildSeatDirectiveBlock's body contains no DB reader and
//    no await. Moving the planIds lookup into the composer breaks the purity
//    its test suite asserts, and it cannot move into resolveSeatPromptOptions
//    because that roots on the board's ACTIVE workspace.
test('SOURCE: buildSeatDirectiveBlock body has no getActiveDispatchedByTerminal(s) and no await (purity)', () => {
    const body = sliceFnBody(AGENT_PROMPT_BUILDER_SRC, 'buildSeatDirectiveBlock');
    assert.ok(!body.includes('getActiveDispatchedByTerminal'),
        'buildSeatDirectiveBlock must not call getActiveDispatchedByTerminal — it is a pure composer');
    assert.ok(!body.includes('getActiveDispatchedByTerminals'),
        'buildSeatDirectiveBlock must not call getActiveDispatchedByTerminals — the caller resolves planIds');
    assert.ok(!/\bawait\b/.test(body),
        'buildSeatDirectiveBlock must be pure — no await inside its body');
});

// 7. Source-text: resolveSeatPromptOptions sets stage: STAGE_BY_ROLE[role], and
//    neither host contains a second STAGE_BY_ROLE read. stage is set ONCE, in
//    the shared resolver, so both hosts get it free.
test('SOURCE: resolveSeatPromptOptions sets stage: STAGE_BY_ROLE[role]; neither host re-reads STAGE_BY_ROLE', () => {
    const resolverBody = sliceFnBody(KANBAN_PROVIDER_SRC, 'resolveSeatPromptOptions');
    assert.ok(resolverBody.includes('STAGE_BY_ROLE[role]'),
        'resolveSeatPromptOptions must set stage: STAGE_BY_ROLE[role] — the one shared resolution');
    for (const [name, src] of [['TaskViewerProvider', TASK_VIEWER_SRC], ['bootstrap', BOOTSTRAP_SRC]]) {
        assert.ok(!src.includes('STAGE_BY_ROLE'),
            `${name} must NOT read STAGE_BY_ROLE — stage is resolved once in resolveSeatPromptOptions ` +
            'and a second hand-maintained read is how the vocabularies drift');
    }
});

// 8. Source-text: both hosts pass standing.members MINUS the head for a head,
//    and [targetName] otherwise — the head-resolves-its-members rule. Also
//    neither host hand-rolls a groups.find( or .members.includes( of its own:
//    the roster comes from resolveTeamStanding, never a second lookup.
test('SOURCE: both hosts resolve planIds from standing.members minus head (head) / [targetName] (other); no hand-rolled membership test', () => {
    for (const [name, src, target] of [
        ['TaskViewerProvider', TASK_VIEWER_SRC, 'payload.name'],
        ['bootstrap', BOOTSTRAP_SRC, 'handle.friendlyName'],
    ]) {
        // The head branch filters the head itself out of standing.members.
        assert.ok(src.includes('standing.members.filter') && src.includes(`!== ${target}`),
            `${name}: for a head, planIds names must be standing.members minus the head itself ` +
            '(nobody dispatches plans TO a head)');
        // The non-head branch is the seat's own name.
        assert.ok(src.includes(`[ ${target} ]`) || src.includes(`[${target}]`),
            `${name}: for a non-head, planIds names must be [targetName] — its own dispatch record`);
        // No hand-rolled membership test — the roster comes from resolveTeamStanding.
        // SCOPED to the prompt-delivery region, not the whole file: the contract is
        // about how THIS path resolves a roster, and a whole-file substring test
        // fires on any unrelated feature that legitimately looks a group up by id
        // (the team-automation work at TaskViewerProvider.ts:27839 is one). A gate
        // that goes red for correct code elsewhere stops being read.
        const regionStart = src.indexOf('if (applySeatBlock) {');
        assert.ok(regionStart > 0, `${name}: seat-block delivery region not found`);
        const regionEnd = src.indexOf('= applyStandingOrders(', regionStart);
        assert.ok(regionEnd > regionStart, `${name}: standing-orders application must follow the seat block`);
        const region = src.slice(regionStart, regionEnd);
        assert.ok(!region.includes('groups.find('),
            `${name} must NOT hand-roll groups.find( — resolveTeamStanding is the one roster source`);
        assert.ok(!region.includes('.members.includes('),
            `${name} must NOT hand-roll .members.includes( — resolveTeamStanding is the one predicate`);
    }
});

// 9. Source-text: both hosts .sort() the deduplicated ids. Pinned as source
//    text because no functional test can see it — the assertion is about
//    determinism across calls, and a single call is always self-consistent.
test('SOURCE: both hosts .sort() the deduplicated planIds (cache-key determinism)', () => {
    for (const [name, src] of [['TaskViewerProvider', TASK_VIEWER_SRC], ['bootstrap', BOOTSTRAP_SRC]]) {
        assert.ok(src.includes('[...new Set(ids)].sort()'),
            `${name}: planIds must be [...new Set(ids)].sort() — the seat block is memoised per ` +
            'agentInstanceId on its own string, so an unsorted id order re-sends the whole block on every message');
    }
});

// 10. Behavioural half of #9: two calls with the same plan set delivered in
//     reversed DB row order produce a byte-identical block, so the
//     delivery-layer cache suppresses the second. The caller sorts, so DB row
//     order cannot force a re-send.
test('BEHAVIOUR: reversed DB row order yields a byte-identical block (sort makes the cache key stable)', () => {
    // Simulate the caller's [...new Set(ids)].sort() for two row orders.
    const forwardRowOrder = ['p2', 'p1'];
    const reversedRowOrder = ['p1', 'p2'];
    const sortedForward = [...new Set(forwardRowOrder)].sort();
    const sortedReversed = [...new Set(reversedRowOrder)].sort();
    assert.deepStrictEqual(sortedForward, sortedReversed,
        'sorted ids must be equal regardless of DB row order');
    const base = {
        gitProhibitionEnabled: true,
        gitCommitStrategy: 'whenDone',
        gitBranchStrategy: 'notSpecified',
        gitPushStrategy: 'notSpecified',
        stage: 'coded',
    };
    const blockForward = buildSeatDirectiveBlock({ ...base, planIds: sortedForward });
    const blockReversed = buildSeatDirectiveBlock({ ...base, planIds: sortedReversed });
    assert.strictEqual(blockForward, blockReversed,
        'reversed DB row order must produce a byte-identical seat block — ' +
        'the content-keyed cache suppresses the second send only if the string is stable');
});

// ── 11. Dispatch protocol directives append on pty delivery path ─────────

test('pty delivery appends the dispatch-protocol bundle for code-touching roles', () => {
    for (const src of [TASK_VIEWER_SRC, BOOTSTRAP_SRC]) {
        assert.ok(/roleTakesDispatchDirectives\(/.test(src),
            'both hosts must gate the dispatch directives on the recipient role');
    }
});

test('the pty-path append uses the whole bundle, not the completion half', () => {
    for (const src of [TASK_VIEWER_SRC, BOOTSTRAP_SRC]) {
        const at = src.indexOf('roleTakesDispatchDirectives(');
        const window = src.slice(at, at + 240);
        assert.ok(/ensureDispatchProtocolDirectives\(/.test(window),
            'the role-gated append must use ensureDispatchProtocolDirectives — a bare ensureCompletionDirective forks the protocol');
    }
});

test('the dispatch directives are appended before standing orders', () => {
    for (const src of [TASK_VIEWER_SRC, BOOTSTRAP_SRC]) {
        const directivesAt = src.indexOf('roleTakesDispatchDirectives(');
        const soAt = src.indexOf('applyStandingOrders(', directivesAt);
        assert.ok(directivesAt > -1 && soAt > -1 && directivesAt < soAt,
            'STANDING_ORDERS_BLOCK_RE is $-anchored — the SO block must stay last');
    }
});

test('an unresolved role does not take the dispatch directives', () => {
    assert.strictEqual(roleTakesDispatchDirectives(''), false);
    assert.strictEqual(roleTakesDispatchDirectives('reviewer'), false);
    assert.strictEqual(roleTakesDispatchDirectives('Coder'), true, 'role comparison must normalise case');
    assert.strictEqual(roleTakesDispatchDirectives('custom_agent_x'), true);
});

// ── Summary ──────────────────────────────────────────────────────────────

setTimeout(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}, 1000);

