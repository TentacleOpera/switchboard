'use strict';

/**
 * Contract: "A Finished Stage Is a Fact, Not an Inference".
 *
 * The feature's whole value is that a commit trailer can be READ instead of
 * inferred. Every property below is one where the emitted text looks correct
 * to a human reader and produces nothing a machine can query — which is
 * exactly the failure a plan-compliance review does not catch:
 *
 *  - Git only parses trailers in the message's FINAL paragraph. A clause that
 *    says "after the subject line" without demanding a blank line produces
 *    commits whose markers are ordinary body text; the orchestrator's
 *    `git log --format='%(trailers:key=Switchboard-Stage,valueonly)'` returns
 *    EMPTY (verified against git 2.50.1). Total, silent loss of the signal.
 *  - `dontCommit` is a key in GIT_COMMIT_CLAUSES, so a `commit !== 'notSpecified'`
 *    guard admits it and emits "Do NOT commit. … End the commit message with a
 *    git trailer block" — self-contradiction in one clause.
 *  - `assembleSuffix` drops the gitBlock for roles outside CODE_TOUCHING_ROLES.
 *    A role can hold a commit radio, a default, a resolved strategy and a stage
 *    mapping and still emit no policy at all — three green layers, dead control.
 *  - The Coding-team migration is exact-value matched. One drifted byte between
 *    `kanban.html`, `teamWiring.ts` and the `terminals.js` mirror and it silently
 *    never fires, leaving every existing install on the bypass permanently.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/stage-marker-commit-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');
const os = require('os');

const {
    buildGitPolicyBlock,
    buildKanbanBatchPrompt,
    STAGE_BY_ROLE,
    GIT_SAFETY_DIRECTIVE
} = require('../../out/services/agentPromptBuilder');
const {
    migrateAgentGroups,
    migrateCodingTeamOrders,
    migrateTeamPairOrders,
    loadEffectiveStandingOrders,
    describeStandingOrderMigrations,
    OLD_CODING_HEAD_PROMPT,
    NEW_CODING_HEAD_PROMPT,
    CURRENT_BUGGY_CODING_HEAD_PROMPT,
    PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT,
    PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT,
    BUGGY_HEADPROMPT_FRAGMENT,
    PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT,
    PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT,
    PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT,
    PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT,
    COMMIT_INSTRUCTION_MARKER,
    TEAM_HEAD_COMMIT_INSTRUCTION,
    NEW_REVIEW_TEAM_HEAD_PROMPT,
    PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT,
    PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT,
    PRE_REWRITE_CALLBACK_INSTRUCTION,
    STANDING_ORDERS_PREMIGRATION_BAK_KEY,
    TEAM_CODER_QUEUE_DONE_INSTRUCTION,
    PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT,
    QUEUE_DONE_MARKER,
    AGENT_GROUP_CALLBACK_INSTRUCTION,
    SEAT_QUEUE_DONE_ORDER_BODY
} = require('../../out/services/teamWiring');
const { resolvePreset } = require('../../out/services/linkPresets');
const { STANDING_ORDERS_CONFIG_KEY } = require('../../out/services/standingOrders');

const SRC = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const AGENT_PROMPT_BUILDER_SRC = SRC('services', 'agentPromptBuilder.ts');
const KANBAN_PROVIDER_SRC = SRC('services', 'KanbanProvider.ts');
const SHARED_DEFAULTS_SRC = SRC('webview', 'sharedDefaults.js');
const TERMINALS_JS_SRC = SRC('webview', 'terminals.js');
const KANBAN_HTML_SRC = SRC('webview', 'kanban.html');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try { fn(); console.log(`  ✅ ${name}`); passed++; }
    catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
}

// Async cases are queued and drained before the summary, so the pass/fail tally
// can never print ahead of a still-running assertion.
const _asyncCases = [];
function testAsync(name, fn) { _asyncCases.push([name, fn]); }
async function _drainAsyncCases() {
    for (const [name, fn] of _asyncCases) {
        try { await fn(); console.log(`  ✅ ${name}`); passed++; }
        catch (e) { console.error(`  ❌ ${name}`); console.error(e && e.stack ? e.stack : e); failed++; }
    }
}

const PLAN_A = '5f3e165f-d7ce-46e3-8291-f41d07380d38';
const PLAN_B = 'a3adf9f1-7ad7-4eb9-bcea-cead13c8362d';

// ── 1. The role → stage vocabulary ────────────────────────────────────

console.log('\n── STAGE_BY_ROLE ──');

test('STAGE_BY_ROLE is pinned exactly — a new committing role cannot ship unmarked', () => {
    assert.deepStrictEqual({ ...STAGE_BY_ROLE }, {
        planner: 'planned',
        lead: 'coded',
        coder: 'coded',
        intern: 'coded',
        claude_designer: 'coded',
        reviewer: 'reviewed'
    });
});

test('an unmapped role yields undefined — no default, no "unknown" sentinel', () => {
    for (const role of ['tester', 'analyst', 'researcher', 'ticket_updater', 'not_a_role']) {
        assert.strictEqual(STAGE_BY_ROLE[role], undefined, `${role} must not map to a stage`);
    }
});

test('every role holding a commit strategy in KanbanProvider has a stage', () => {
    // gitCommitStrategyByRole resolves these from role config rather than
    // hardcoding 'notSpecified'; each is therefore able to commit, and a
    // commit with no stage is the "orchestrator still has to infer it" hole.
    const block = KANBAN_PROVIDER_SRC.slice(
        KANBAN_PROVIDER_SRC.indexOf('gitCommitStrategyByRole: {'),
        KANBAN_PROVIDER_SRC.indexOf('gitPushStrategyByRole: {')
    );
    assert.ok(block.length > 0, 'gitCommitStrategyByRole block not found');
    const configured = [...block.matchAll(/^\s{16}(\w+):\s*\(/gm)].map(m => m[1]);
    assert.ok(configured.length >= 6, `expected >= 6 config-resolved roles, got ${configured.length}`);
    for (const role of configured) {
        assert.ok(STAGE_BY_ROLE[role], `role '${role}' can commit but has no STAGE_BY_ROLE entry`);
    }
});

// ── 2. The trailer instruction ────────────────────────────────────────

console.log('\n── buildGitPolicyBlock: trailer emission ──');

test('a staged commit clause demands the BLANK line — git parses no other form', () => {
    const out = buildGitPolicyBlock({ commit: 'whenDone', stage: 'reviewed', planIds: [PLAN_A] });
    assert.ok(/blank line/i.test(out),
        'the clause must require a blank line before the trailer block; without it '
        + "`git log --format='%(trailers:...)'` returns nothing and the marker is invisible");
    assert.ok(out.includes(`Switchboard-Stage: reviewed`));
    assert.ok(out.includes(`Switchboard-Plan: ${PLAN_A}`));
});

test('a batch emits one Switchboard-Plan per plan (repeated key, membership not equality)', () => {
    const out = buildGitPolicyBlock({ commit: 'whenDone', stage: 'coded', planIds: [PLAN_A, PLAN_B, 'third'] });
    assert.strictEqual((out.match(/Switchboard-Plan:/g) || []).length, 3);
    assert.strictEqual((out.match(/Switchboard-Stage:/g) || []).length, 1);
});

test('planIds empty or undefined → stage trailer only', () => {
    for (const planIds of [[], undefined, [undefined, '']]) {
        const out = buildGitPolicyBlock({ commit: 'whenDone', stage: 'planned', planIds });
        assert.ok(out.includes('Switchboard-Stage: planned'));
        assert.ok(!out.includes('Switchboard-Plan:'), `planIds=${JSON.stringify(planIds)} leaked a plan line`);
    }
});

test('dontCommit + a mapped stage emits NO trailer — the clause cannot contradict itself', () => {
    const withStage = buildGitPolicyBlock({ commit: 'dontCommit', stage: 'coded', planIds: [PLAN_A] });
    const bare = buildGitPolicyBlock({ commit: 'dontCommit' });
    assert.strictEqual(withStage, bare,
        'dontCommit must be byte-identical with and without a stage — `dontCommit` is a key in '
        + 'GIT_COMMIT_CLAUSES, so a `commit !== notSpecified` guard admits it and emits '
        + '"Do NOT commit. … End the commit message with a git trailer block"');
    assert.ok(!withStage.includes('Switchboard-Stage'));
});

test('notSpecified emits no block at all, stage or no stage', () => {
    assert.strictEqual(buildGitPolicyBlock({ commit: 'notSpecified', stage: 'coded', planIds: [PLAN_A] }), '');
    assert.strictEqual(buildGitPolicyBlock({}), '');
});

test('stage absent → byte-identical to before markers (AgentSkillExporter / custom agents)', () => {
    assert.strictEqual(
        buildGitPolicyBlock({ commit: 'whenDone', planIds: [PLAN_A] }),
        buildGitPolicyBlock({ commit: 'whenDone' })
    );
    assert.ok(!buildGitPolicyBlock({ commit: 'whenDone' }).includes('Switchboard-'));
});

test('an unmapped role passes stage: undefined and emits no trailer', () => {
    const out = buildGitPolicyBlock({ commit: 'whenDone', stage: STAGE_BY_ROLE['tester'], planIds: [PLAN_A] });
    assert.ok(!out.includes('Switchboard-'));
});

test('the worktree suffix composes after the trailer text, both readable', () => {
    const out = buildGitPolicyBlock({ commit: 'whenDone', stage: 'coded', planIds: [PLAN_A], worktreeActive: true });
    assert.ok(out.includes('Commit inside your assigned worktree.'));
    assert.ok(out.indexOf('Switchboard-Stage') < out.indexOf('Commit inside your assigned worktree.'));
});

test('the GIT POLICY: literal prefix survives (substring assertions elsewhere depend on it)', () => {
    assert.ok(buildGitPolicyBlock({ commit: 'whenDone', stage: 'coded' }).startsWith('GIT POLICY: '));
});

// ── 3. whenDone stages by path, never greedily ────────────────────────

console.log('\n── whenDone: stage by path ──');

test('no emitted policy text prescribes `git add -A` or `git add .`, for any strategy', () => {
    for (const commit of ['whenDone', 'dontCommit', 'notSpecified', undefined]) {
        for (const stage of [undefined, 'planned', 'coded', 'reviewed']) {
            const out = buildGitPolicyBlock({ commit, stage, planIds: [PLAN_A], guardrail: true });
            assert.ok(!/(?<!never `)git add -A/.test(out.replace(/never `git add -A`/g, '')),
                `git add -A prescribed for commit=${commit}`);
            assert.ok(!out.includes('stage all your changes'),
                `the retired greedy instruction survives for commit=${commit}`);
        }
    }
});

test('whenDone excludes .switchboard/ except the plan\'s own file', () => {
    const out = buildGitPolicyBlock({ commit: 'whenDone' });
    assert.ok(out.includes('.switchboard/'));
    assert.ok(/never `git add -A`/.test(out));
});

// ── 4. The gitBlock actually reaches the prompt ───────────────────────

console.log('\n── assembleSuffix: no dead controls ──');

const plans = [{ sessionId: 's1', planId: PLAN_A, title: 'P1', topic: 'P1', absolutePath: '/p1.md' }];

test('every role with a stage AND a config-resolved commit strategy emits its GIT POLICY block', () => {
    // A role outside CODE_TOUCHING_ROLES has its gitBlock dropped by
    // assembleSuffix. It can then carry a radio, a default, a resolved
    // strategy and a stage mapping and still emit nothing — the three-layer
    // wiring is green and the control is dead.
    for (const role of ['planner', 'lead', 'coder', 'intern', 'reviewer']) {
        const prompt = buildKanbanBatchPrompt(role, plans, {
            gitCommitStrategy: 'whenDone',
            gitProhibitionEnabled: false
        });
        assert.ok(prompt.includes('GIT POLICY:'), `role '${role}' emits no GIT POLICY block`);
        assert.ok(prompt.includes(`Switchboard-Stage: ${STAGE_BY_ROLE[role]}`),
            `role '${role}' emits no stage trailer`);
        assert.ok(prompt.includes(`Switchboard-Plan: ${PLAN_A}`),
            `role '${role}' emits no plan trailer`);
    }
});

test('shipped defaults change no prompt — planner and reviewer emit no commit clause', () => {
    for (const role of ['planner', 'reviewer']) {
        const prompt = buildKanbanBatchPrompt(role, plans, {
            gitCommitStrategy: 'notSpecified',
            gitProhibitionEnabled: false
        });
        assert.ok(!prompt.includes('Switchboard-Stage'),
            `role '${role}' emits a marker at its shipped default — new capability must ship OFF`);
    }
});

test('planner and reviewer gain commit only — no branch, no push control', () => {
    for (const role of ['planner', 'reviewer']) {
        const addons = SHARED_DEFAULTS_SRC.slice(
            SHARED_DEFAULTS_SRC.indexOf(`    ${role}: [`),
            SHARED_DEFAULTS_SRC.indexOf(`    ${role}: [`) + 3000
        );
        const upTo = addons.slice(0, addons.indexOf('\n    ],'));
        assert.ok(upTo.includes('GIT_COMMIT_STRATEGY_RADIO'), `${role} is missing the commit radio`);
        assert.ok(!upTo.includes('GIT_BRANCH_STRATEGY_RADIO'), `${role} gained a branch radio (dead control)`);
        assert.ok(!upTo.includes('GIT_PUSH_STRATEGY_RADIO'), `${role} gained a push radio (dead control)`);
    }
});

test('gitBranchStrategyByRole/gitPushStrategyByRole keep planner and reviewer hardcoded', () => {
    for (const map of ['gitBranchStrategyByRole', 'gitPushStrategyByRole']) {
        const start = KANBAN_PROVIDER_SRC.indexOf(`${map}: {`);
        const block = KANBAN_PROVIDER_SRC.slice(start, KANBAN_PROVIDER_SRC.indexOf('},', start));
        for (const role of ['planner', 'reviewer']) {
            assert.ok(new RegExp(`${role}:\\s*'notSpecified'`).test(block),
                `${map}.${role} must stay hardcoded 'notSpecified' — commit-only is deliberate`);
        }
    }
});

// ── 5. Auto-commit is gone ────────────────────────────────────────────

console.log('\n── auto-commit retirement ──');

test('no retired auto-commit symbol survives anywhere in src/', () => {
    const RETIRED = [
        'autoCommitForCodeReview',
        'handleGetAutoCommitOnCodeReviewSetting',
        'getAutoCommitOnCodeReview',
        '_autoCommitIfCodeReviewTransition',
        'autoCommitOnCodeReview',
        'auto-commit-code-review-toggle'
    ];
    const root = path.join(__dirname, '..');
    const hits = [];
    (function walk(dir) {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, e.name);
            if (e.isDirectory()) { walk(p); continue; }
            if (!/\.(ts|js|html)$/.test(e.name)) { continue; }
            if (p === __filename) { continue; }
            const body = fs.readFileSync(p, 'utf8');
            for (const sym of RETIRED) {
                if (body.includes(sym)) { hits.push(`${path.relative(root, p)}: ${sym}`); }
            }
        }
    })(root);
    assert.deepStrictEqual(hits, [],
        'a half-removal leaves a dead Setup toggle or a startup-commands body one consumer still reads');
});

// ── 6. Trailers are readable by the query the skill prescribes ────────

console.log('\n── end-to-end: git actually parses what the clause asks for ──');

test('a commit written as the clause instructs is queryable, single and batch', () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-trailer-'));
    const git = (...args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    try {
        git('init', '-q', '.');
        git('config', 'user.email', 'contract@test');
        git('config', 'user.name', 'contract');
        fs.writeFileSync(path.join(repo, 'a.txt'), 'a');
        git('add', 'a.txt');
        // Exactly the shape the emitted clause dictates: body, blank line,
        // trailer lines last, one per line.
        git('commit', '-q', '-m',
            'reviewer: fix the null guard\n\nSome body prose.\n\n'
            + `Switchboard-Stage: reviewed\nSwitchboard-Plan: ${PLAN_A}\nSwitchboard-Plan: ${PLAN_B}`);

        const stages = git('log', '-1', "--format=%(trailers:key=Switchboard-Stage,valueonly)")
            .split('\n').filter(Boolean);
        const plansOut = git('log', '-1', "--format=%(trailers:key=Switchboard-Plan,valueonly)")
            .split('\n').filter(Boolean);
        assert.deepStrictEqual(stages, ['reviewed']);
        assert.deepStrictEqual(plansOut, [PLAN_A, PLAN_B],
            'both plan trailers must come back from ONE query — a reader does a membership test');

        // The counter-case the clause exists to prevent: no blank line.
        fs.writeFileSync(path.join(repo, 'b.txt'), 'b');
        git('add', 'b.txt');
        git('commit', '-q', '-m', `coder: no blank line\nSwitchboard-Stage: coded\nSwitchboard-Plan: ${PLAN_A}`);
        const none = git('log', '-1', "--format=%(trailers:key=Switchboard-Stage,valueonly)")
            .split('\n').filter(Boolean);
        assert.deepStrictEqual(none, [],
            'sanity: git must NOT parse trailers without the blank line — if this ever passes, '
            + 'the blank-line requirement in the clause is no longer load-bearing');
    } finally {
        fs.rmSync(repo, { recursive: true, force: true });
    }
});

// ── 7. Coding-team migration: exact-value matching across three files ─

console.log('\n── Coding team review handoff ──');

/** Read a `name = '…' + '…'` single-quoted concatenation chain out of source. */
function readConcat(src, decl) {
    const i = src.indexOf(decl);
    assert.ok(i >= 0, `declaration not found: ${decl}`);
    const seg = src.slice(i + decl.length);
    // eslint-disable-next-line no-eval
    return eval('(' + seg.slice(0, seg.indexOf(';\n')) + ')');
}

test('OLD/NEW headPrompt constants are byte-identical across host and webview mirror', () => {
    const oldClient = readConcat(TERMINALS_JS_SRC, 'var OLD_CODING_HEAD_PROMPT_CLIENT =');
    const newClient = readConcat(TERMINALS_JS_SRC, 'var NEW_CODING_HEAD_PROMPT_CLIENT =');
    assert.strictEqual(oldClient, OLD_CODING_HEAD_PROMPT,
        'terminals.js OLD constant drifted — the client converter then recognises nothing the host drops');
    assert.strictEqual(newClient, NEW_CODING_HEAD_PROMPT,
        'terminals.js NEW constant drifted — the webview renders different order text than the host delivers');
});

test('the shipped kanban.html headPrompt is byte-identical to NEW_CODING_HEAD_PROMPT', () => {
    // kanban.html's copy lives inside an object literal, so it ends at the
    // first line that is not a `+ '…'` continuation, not at a `;`.
    const lines = KANBAN_HTML_SRC.split('\n');
    const start = lines.findIndex(l => l.includes("headPrompt: 'You lead this team."));
    assert.ok(start >= 0, 'Coding team headPrompt not found in kanban.html');
    const chain = [lines[start].replace(/^\s*headPrompt:\s*/, '')];
    for (let i = start + 1; i < lines.length && /^\s*\+\s*'/.test(lines[i]); i++) {
        chain.push(lines[i].trim());
    }
    // eslint-disable-next-line no-eval
    const shipped = eval('(' + chain.join('\n') + ')');
    assert.strictEqual(shipped, NEW_CODING_HEAD_PROMPT,
        'the migration writes NEW_CODING_HEAD_PROMPT while the gallery forks kanban.html\'s copy — '
        + 'a drift means migrated and freshly-adopted teams carry different text');
});

test('the shipped Coding reviewer is reports-to-head, and no shipped member is a `reviewer` pair', () => {
    assert.ok(/role: 'reviewer',[^}]*relationship: 'reports-to-head'/.test(KANBAN_HTML_SRC),
        'the Coding reviewer must be reports-to-head — `reviewer` reinstates the board bypass');
    assert.ok(!/relationship: 'reviewer'/.test(KANBAN_HTML_SRC),
        'a shipped member declaring relationship: \'reviewer\' installs the hand-to-reviewer order on the lead');
});

test('NEW_CODING_HEAD_PROMPT keeps every load-bearing literal', () => {
    for (const lit of ['/kanban/dispatch', 'CODE REVIEWED', '"from":"{head}"', 'Do NOT use /kanban/move',
        'GET /kanban/plans?featureId=', 'FEATURE planId', 'intern → coder → lead', 'seat fails review on the same subtask twice',
        'stop and report to the human instead of dispatching again', 'PLAN FILES ARE THE SOURCE OF TRUTH',
        'If your team has NO reviewer seat', 'Never move a card backwards',
        'Never move a card to a new column yourself', 'triggers review by dispatching',
        // The prohibition MUST name its one exception. The dispatch payload
        // carries `targetColumn`, so an unqualified "never move a card to a new
        // column" reads as "do not make that call" and the lead stops handing
        // features to review at all — the same literal-reading failure the
        // card-movement-rule migration exists to fix.
        'your only card action is the POST /kanban/dispatch call below']) {
        assert.ok(NEW_CODING_HEAD_PROMPT.includes(lit), `missing load-bearing literal: ${lit}`);
    }
    assert.ok(!NEW_CODING_HEAD_PROMPT.includes('satisfied with it, hand it to review yourself'),
        'the new text must not contain the fragment the order converter matches on, or it re-converts forever');
    assert.ok(!NEW_CODING_HEAD_PROMPT.includes('Only advance the feature your team worked'),
        'the new text must not contain the fragment the card-movement-rule rewriter matches on');
    // Plan verification items 4-5, automated: the whole point of the migration
    // is that "advance" and "moves the card" taught the lead card movement was
    // its job. A future wording pass must not reintroduce either.
    assert.ok(!/advanc/i.test(NEW_CODING_HEAD_PROMPT),
        'the new text must not contain any form of "advance" — the word the lead misread as "move the card"');
    assert.ok(!NEW_CODING_HEAD_PROMPT.includes('moves the card'),
        '/kanban/dispatch must be described as triggering review, never as moving the card');
    assert.ok(!/advanc/i.test(NEW_REVIEW_TEAM_HEAD_PROMPT) && !NEW_REVIEW_TEAM_HEAD_PROMPT.includes('moves the card'),
        'the Review headPrompt must carry no card-movement language either');
});

const oldCodingGroup = () => ({
    id: 'g1',
    name: 'Coding',
    headRole: 'lead',
    headPrompt: OLD_CODING_HEAD_PROMPT,
    someUnknownKey: 'preserve me',
    members: [
        { role: 'coder', count: 3, scope: 'per-team', label: 'C', startupCommand: 'x' },
        { role: 'reviewer', count: 1, scope: 'shared', relationship: 'reviewer', label: 'R' }
    ]
});

test('migrateAgentGroups converts an untouched old Coding team and preserves unknown keys', () => {
    const out = migrateAgentGroups([oldCodingGroup()]);
    assert.ok(out, 'converter returned null on a group that needed converting');
    const g = out[0];
    assert.strictEqual(g.headPrompt, NEW_CODING_HEAD_PROMPT);
    assert.strictEqual(g.members[1].relationship, 'reports-to-head');
    assert.strictEqual(g.someUnknownKey, 'preserve me');
    assert.strictEqual(g.members[0].startupCommand, 'x');
    assert.strictEqual(g.members[1].label, 'R');
    assert.strictEqual(g.members[1].scope, 'shared');
});

test('an operator-edited headPrompt is left exactly as written', () => {
    const edited = oldCodingGroup();
    edited.headPrompt = OLD_CODING_HEAD_PROMPT + ' Also water the plants.';
    const out = migrateAgentGroups([edited]);
    const g = (out || [edited])[0];
    assert.strictEqual(g.headPrompt, edited.headPrompt, 'exact-value matching is the whole safety story');
    assert.strictEqual(g.members[1].relationship, 'reviewer', 'a non-matching group must not be half-converted');
});

test('migrateAgentGroups is idempotent — second pass returns null', () => {
    const once = migrateAgentGroups([oldCodingGroup()]);
    assert.strictEqual(migrateAgentGroups(once), null, 'a converted group must not be re-flagged as changed');
});

const order = (o) => ({ id: o.id, parent: o.parent, child: o.child, instruction: o.instruction, createdAt: 1, scope: o.scope, teamId: o.teamId });

test('migrateCodingTeamOrders drops the reviewer pair row and rewrites the team-head row', () => {
    const orders = [
        order({ id: 'p1', parent: 'lead-1', child: 'reviewer-1', instruction: resolvePreset('reviewer', 'lead-1', 'reviewer-1'), scope: 'pair' }),
        order({ id: 'h1', parent: 'lead-1', child: '', instruction: OLD_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'), scope: 'team-head', teamId: 't1' }),
        order({ id: 'x1', parent: 'lead-1', child: 'coder-1', instruction: 'hand-written ad-hoc link-up', scope: 'pair' })
    ];
    const out = migrateCodingTeamOrders(orders);
    assert.ok(!out.some(o => o.id === 'p1'), 'the stale reviewer pair row must be dropped');
    assert.ok(out.some(o => o.id === 'x1' && o.instruction === 'hand-written ad-hoc link-up'),
        'an unrecognised operator row must pass through untouched');
    const head = out.find(o => o.id === 'h1');
    assert.ok(head, 'the team-head row must survive, rewritten');
    assert.strictEqual(head.instruction, NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'));
    assert.strictEqual(head.teamId, 't1', 'teamId must survive the rewrite or selectOrders drops the row');
    assert.strictEqual(head.scope, 'team-head');
});

test('migrateCodingTeamOrders is idempotent and pure', () => {
    const orders = [
        order({ id: 'p1', parent: 'lead-1', child: 'reviewer-1', instruction: resolvePreset('reviewer', 'lead-1', 'reviewer-1'), scope: 'pair' }),
        order({ id: 'h1', parent: 'lead-1', child: '', instruction: OLD_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'), scope: 'team-head', teamId: 't1' })
    ];
    const snapshot = JSON.stringify(orders);
    const once = migrateCodingTeamOrders(orders);
    assert.strictEqual(JSON.stringify(orders), snapshot, 'the converter must not mutate its input');
    assert.deepStrictEqual(migrateCodingTeamOrders(once), once, 'second pass must be a no-op');
});

test('a head name containing regex metacharacters does not break the rewrite', () => {
    const head = 'lead(1)[$]';
    const out = migrateCodingTeamOrders([
        order({ id: 'h1', parent: head, child: '', instruction: OLD_CODING_HEAD_PROMPT.replace(/\{head\}/g, head), scope: 'team-head', teamId: 't1' })
    ]);
    assert.strictEqual(out[0].instruction, NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, head));
});

test('every host read site uses loadEffectiveStandingOrders and client mirror composes converters', () => {
    const sites = [
        // Three in TaskViewerProvider (prompt composition, delivery, and the
        // turn-end/standing-orders read) plus one in the standalone bootstrap.
        // Exact counts, not an allowlist: a NEW raw read added inside an
        // already-permitted file is exactly the drift this catches.
        ['services/TaskViewerProvider.ts', 3],
        ['standalone/bootstrap.ts', 1]
    ];
    for (const [file, count] of sites) {
        const body = SRC(...file.split('/'));
        const n = (body.match(/loadEffectiveStandingOrders\(db\)/g) || []).length;
        assert.strictEqual(n, count,
            `${file}: expected ${count} loadEffectiveStandingOrders call site(s), found ${n}`);
    }
    assert.ok(TERMINALS_JS_SRC.includes('migrateCodingTeamOrdersClient(migrateTeamPairOrdersClient(orders))'),
        'terminals.js must mirror the composition or the webview renders orders the host no longer delivers');
});

/** Every .ts/.js file under src/, excluding the test tree and build output. */
function walkSrc() {
    const srcDir = path.join(__dirname, '..');
    const out = [];
    (function walk(dir) {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isDirectory()) {
                if (entry.name === 'test' || entry.name === 'out' || entry.name === 'node_modules') { continue; }
                walk(path.join(dir, entry.name));
            } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.js'))) {
                out.push(path.join(dir, entry.name));
            }
        }
    })(srcDir);
    return out.map(f => ({ rel: path.normalize(path.relative(srcDir, f)), body: fs.readFileSync(f, 'utf8') }));
}

// A stale standing order is only fixable if EVERY server-side reader migrates.
// That invariant used to be maintained by convention across four sites, and a
// fifth added later would have reintroduced the bug silently. Asserting exact
// per-file OCCURRENCE counts (not just an allowlist of filenames) is what makes
// a fourth raw read fail — including one added inside an already-permitted file,
// which a filename allowlist waves straight through. The counts also assert
// PRESENCE: delete the loader's own read and this test goes red instead of green.
test('getConfigJson(STANDING_ORDERS_CONFIG_KEY) occurs exactly once in each of exactly three files', () => {
    const EXPECTED = new Map([
        // loadEffectiveStandingOrders — the only delivery-path reader.
        [path.normalize('services/teamWiring.ts'), 1],
        // mutateStandingOrders — the serialising read-modify-write primitive.
        [path.normalize('services/standingOrders.ts'), 1],
        // _handleStandingOrdersList — needs the RAW rows by design (identity-stable ids).
        [path.normalize('services/LocalApiServer.ts'), 1],
    ]);
    const RAW_READ = /getConfigJson\s*(?:<[^>]*>)?\s*\(\s*STANDING_ORDERS_CONFIG_KEY/g;

    const actual = new Map();
    for (const { rel, body } of walkSrc()) {
        const n = (body.match(RAW_READ) || []).length;
        if (n > 0) { actual.set(rel, n); }
    }

    assert.deepStrictEqual(
        [...actual.entries()].sort(),
        [...EXPECTED.entries()].sort(),
        'raw reads of terminals.standingOrders drifted. Every server-side reader must go '
        + 'through loadEffectiveStandingOrders, or a stale order reaches a live agent again. '
        + `Found: ${JSON.stringify([...actual.entries()])}`
    );
});

// OLD_HEADPROMPT_FRAGMENT is the recogniser key. It cannot be imported by the
// webview, so exactly TWO copies are legitimate: the exported host const and the
// terminals.js mirror. A third copy is precisely how the diagnostic endpoint
// drifted out of agreement with delivered behaviour — LocalApiServer carried one
// and its staleness markers would have gone silently dead on the next text edit.
test('OLD_HEADPROMPT_FRAGMENT exists in exactly two files and is byte-identical', () => {
    const hostWiringSrc = SRC('services', 'teamWiring.ts');
    const hostFragmentMatch = hostWiringSrc.match(/const OLD_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(hostFragmentMatch, 'OLD_HEADPROMPT_FRAGMENT not found in teamWiring.ts');
    const hostFragment = hostFragmentMatch[1];

    const clientFragmentMatch = TERMINALS_JS_SRC.match(/var OLD_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(clientFragmentMatch, 'OLD_HEADPROMPT_FRAGMENT not found in terminals.js');
    const clientFragment = clientFragmentMatch[1];

    assert.strictEqual(clientFragment, hostFragment,
        'OLD_HEADPROMPT_FRAGMENT drifted between teamWiring.ts and terminals.js');

    const carriers = walkSrc()
        .filter(({ body }) => body.includes(hostFragment))
        .map(({ rel }) => rel)
        .sort();
    assert.deepStrictEqual(carriers,
        [path.normalize('services/teamWiring.ts'), path.normalize('webview/terminals.js')].sort(),
        'the old-headPrompt recogniser fragment must live in exactly two files — the exported '
        + 'host const and the terminals.js mirror. A third copy is an ungated drift site; import '
        + 'describeStandingOrderMigrations (or OLD_HEADPROMPT_FRAGMENT) instead. '
        + `Found: ${carriers.join(', ')}`);
});

// The second recogniser key. Same two-copy rule and same reason: the webview
// cannot import, so teamWiring.ts and terminals.js each carry the literal.
test('BUGGY_HEADPROMPT_FRAGMENT exists in exactly two files and is byte-identical', () => {
    const hostWiringSrc = SRC('services', 'teamWiring.ts');
    const hostMatch = hostWiringSrc.match(/const BUGGY_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(hostMatch, 'BUGGY_HEADPROMPT_FRAGMENT not found in teamWiring.ts');
    const clientMatch = TERMINALS_JS_SRC.match(/var BUGGY_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(clientMatch, 'BUGGY_HEADPROMPT_FRAGMENT not found in terminals.js');
    assert.strictEqual(clientMatch[1], hostMatch[1],
        'BUGGY_HEADPROMPT_FRAGMENT drifted between teamWiring.ts and terminals.js — the two hosts '
        + 'would migrate different sets of installs');
    assert.ok(CURRENT_BUGGY_CODING_HEAD_PROMPT.includes(BUGGY_HEADPROMPT_FRAGMENT),
        'the fragment must appear in the frozen on-disk snapshot it is meant to recognise');
});

test('PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT exists in exactly two files and is byte-identical', () => {
    const hostWiringSrc = SRC('services', 'teamWiring.ts');
    const hostMatch = hostWiringSrc.match(/const PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(hostMatch, 'PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT not found in teamWiring.ts');
    const clientMatch = TERMINALS_JS_SRC.match(/var PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(clientMatch, 'PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT not found in terminals.js');
    assert.strictEqual(clientMatch[1], hostMatch[1],
        'PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT drifted between teamWiring.ts and terminals.js');
    assert.ok(PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT.includes(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT),
        'the fragment must appear in the frozen snapshot it is meant to recognise');
    assert.ok(!NEW_CODING_HEAD_PROMPT.includes(PRE_ROLE_BOUNDARY_HEADPROMPT_FRAGMENT),
        'the corrected text must not contain the fragment — a rewritten row would re-match forever');
});

// The card-movement-rule recogniser key. Same two-copy rule: the webview
// cannot import, so teamWiring.ts and terminals.js each carry the literal.
// The fragment is REMOVED from the new text (traditional positive match),
// but GATED on COMMIT_INSTRUCTION_MARKER being present — without the gate,
// pre-commit-instruction rows (which also contain the fragment but lack the
// marker) would be replaced instead of appended.
test('PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT exists in exactly two files and is byte-identical', () => {
    const hostWiringSrc = SRC('services', 'teamWiring.ts');
    const hostMatch = hostWiringSrc.match(/const PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(hostMatch, 'PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT not found in teamWiring.ts');
    const hostFragment = hostMatch[1];

    const clientMatch = TERMINALS_JS_SRC.match(/var PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(clientMatch, 'PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT not found in terminals.js');
    const clientFragment = clientMatch[1];

    assert.strictEqual(clientFragment, hostFragment,
        'PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT drifted between teamWiring.ts and terminals.js');

    const carriers = walkSrc()
        .filter(({ body }) => body.includes(hostFragment))
        .map(({ rel }) => rel)
        .sort();
    assert.deepStrictEqual(carriers,
        [path.normalize('services/teamWiring.ts'), path.normalize('webview/terminals.js')].sort(),
        'the card-movement-rule fragment must live in exactly two files — the exported '
        + 'host const and the terminals.js mirror. '
        + `Found: ${carriers.join(', ')}`);

    assert.ok(PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT.includes(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT),
        'the fragment must appear in the frozen snapshot it is meant to recognise');
    assert.ok(!NEW_CODING_HEAD_PROMPT.includes(PRE_CARD_MOVEMENT_RULE_HEADPROMPT_FRAGMENT),
        'the new text must not contain the fragment — a rewritten row would re-match forever');
});

// The group headPrompt and the persisted team-head standing order are two
// different stores. migrateAgentGroups fixes the first; wireSpawnedTeam skips
// the head order when one already exists (`if (!headExists)`), so only this
// read-path recogniser reaches an install that already ran a Coding team on the
// first-generation text. Without it the endpoint/workspaceRoot/rotation fixes
// land on new teams only.
test('a persisted team-head order carrying the first-generation headPrompt is rewritten to the corrected text', () => {
    const installed = CURRENT_BUGGY_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1');
    const raw = [{ id: 'o1', parent: 'lead-1', child: '', scope: 'team-head', teamId: 't1', instruction: installed }];
    const out = migrateCodingTeamOrders(raw);
    assert.notStrictEqual(out, raw, 'the recogniser did not fire — an already-migrated install keeps the buggy text forever');
    const row = out.find(o => o.id === 'o1');
    assert.ok(row, 'the rewritten row lost its id — the Link-up editor deletes by id');
    assert.strictEqual(row.instruction, NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'),
        'the rewritten instruction is not the corrected text with {head} substituted');
    assert.ok(!row.instruction.includes('GET /kanban/feature'), 'the 404 read survived the migration');
    assert.ok(row.instruction.includes('workspaceRoot'), 'the dispatch body still omits workspaceRoot');
    // Idempotent: a second pass recognises nothing (reference short-circuit).
    assert.strictEqual(migrateCodingTeamOrders(out), out, 'the migration is not idempotent — it would rewrite forever');
});

test('a persisted team-head order carrying the pre-role-boundary headPrompt is rewritten to the corrected text', () => {
    const installed = PRE_ROLE_BOUNDARY_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1');
    const raw = [{ id: 'o2', parent: 'lead-1', child: '', scope: 'team-head', teamId: 't1', instruction: installed }];
    const out = migrateCodingTeamOrders(raw);
    assert.notStrictEqual(out, raw, 'the recogniser did not fire for pre-role-boundary order');
    const row = out.find(o => o.id === 'o2');
    assert.ok(row, 'the rewritten row lost its id');
    assert.strictEqual(row.instruction, NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'));
    assert.ok(row.instruction.includes('PLAN FILES ARE THE SOURCE OF TRUTH'));
    assert.strictEqual(migrateCodingTeamOrders(out), out, 'the migration is not idempotent');
});

// ── Commit-instruction fragment + marker: two-copy rule and migration ──

test('PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT exists in exactly two files and is byte-identical', () => {
    const hostWiringSrc = SRC('services', 'teamWiring.ts');
    const hostMatch = hostWiringSrc.match(/const PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(hostMatch, 'PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT not found in teamWiring.ts');
    const hostFragment = hostMatch[1];

    const clientMatch = TERMINALS_JS_SRC.match(/var PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(clientMatch, 'PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT not found in terminals.js');
    const clientFragment = clientMatch[1];

    assert.strictEqual(clientFragment, hostFragment,
        'PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT drifted between teamWiring.ts and terminals.js');

    const carriers = walkSrc()
        .filter(({ body }) => body.includes(hostFragment))
        .map(({ rel }) => rel)
        .sort();
    assert.deepStrictEqual(carriers,
        [path.normalize('services/teamWiring.ts'), path.normalize('webview/terminals.js')].sort(),
        'the pre-commit-instruction fragment must live in exactly two files — the exported '
        + 'host const and the terminals.js mirror. '
        + `Found: ${carriers.join(', ')}`);
});

test('COMMIT_INSTRUCTION_MARKER exists in exactly two files and is byte-identical', () => {
    const hostWiringSrc = SRC('services', 'teamWiring.ts');
    const hostMatch = hostWiringSrc.match(/const COMMIT_INSTRUCTION_MARKER\s*=\s*'([^']+)'/);
    assert.ok(hostMatch, 'COMMIT_INSTRUCTION_MARKER not found in teamWiring.ts');
    const hostMarker = hostMatch[1];

    const clientMatch = TERMINALS_JS_SRC.match(/var COMMIT_INSTRUCTION_MARKER\s*=\s*'([^']+)'/);
    assert.ok(clientMatch, 'COMMIT_INSTRUCTION_MARKER not found in terminals.js');
    const clientMarker = clientMatch[1];

    assert.strictEqual(clientMarker, hostMarker,
        'COMMIT_INSTRUCTION_MARKER drifted between teamWiring.ts and terminals.js');

    // The marker text appears in the prompt constants too (it is a substring
    // of the commit instruction), so the two-copy rule applies to the
    // DECLARATION sites, not every substring occurrence. Verify the
    // declarations exist in exactly two files.
    const hostDecl = /const COMMIT_INSTRUCTION_MARKER\s*=/.test(hostWiringSrc);
    const clientDecl = /var COMMIT_INSTRUCTION_MARKER\s*=/.test(TERMINALS_JS_SRC);
    assert.ok(hostDecl && clientDecl,
        'COMMIT_INSTRUCTION_MARKER must be declared in both teamWiring.ts and terminals.js');
});

test('PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT includes the fragment but NOT the marker', () => {
    assert.ok(PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT.includes(PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT),
        'the fragment must appear in the frozen snapshot it is meant to recognise');
    assert.ok(!PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT.includes(COMMIT_INSTRUCTION_MARKER),
        'the frozen snapshot must NOT contain the commit marker — it is pre-commit-instruction text');
});

test('NEW_CODING_HEAD_PROMPT includes the marker (commit instruction was appended)', () => {
    assert.ok(NEW_CODING_HEAD_PROMPT.includes(COMMIT_INSTRUCTION_MARKER),
        'NEW_CODING_HEAD_PROMPT must include the commit instruction marker');
    assert.ok(NEW_CODING_HEAD_PROMPT.includes(PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT),
        'NEW_CODING_HEAD_PROMPT must still include the fragment (it is a prefix of the new text)');
});

test('a persisted team-head order carrying the pre-commit-instruction headPrompt is rewritten via two-pass migration', () => {
    const installed = PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1');
    const raw = [{ id: 'o3', parent: 'lead-1', child: '', scope: 'team-head', teamId: 't1', instruction: installed }];
    // Pass 1: APPEND (pre-commit-instruction row has no marker → append path fires).
    // The append produces PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT (the OLD
    // NEW_CODING_HEAD_PROMPT), NOT the new text — the body edit broke the
    // append-only invariant.
    const out = migrateCodingTeamOrders(raw);
    assert.notStrictEqual(out, raw, 'the recogniser did not fire for pre-commit-instruction order');
    const row = out.find(o => o.id === 'o3');
    assert.ok(row, 'the rewritten row lost its id');
    assert.strictEqual(row.instruction, PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'),
        'pass 1 must produce the intermediate text (frozen snapshot + commit instruction), not the new text');
    assert.ok(row.instruction.includes(COMMIT_INSTRUCTION_MARKER),
        'the appended instruction must carry the commit marker');
    // Pass 2: REPLACE (appended row now has marker + "Only advance..." → replace block fires).
    const out2 = migrateCodingTeamOrders(out);
    const row2 = out2.find(o => o.id === 'o3');
    assert.ok(row2, 'the rewritten row lost its id on pass 2');
    assert.strictEqual(row2.instruction, NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'),
        'pass 2 must produce the new text with restructured card-movement language');
    assert.ok(!row2.instruction.includes('Only advance the feature your team worked'),
        'the fragment must be absent after the replace pass');
    // Pass 3 (idempotency): no recogniser matches (fragment absent, marker present).
    assert.strictEqual(migrateCodingTeamOrders(out2), out2, 'the migration is not idempotent after pass 2');
});

// The pre-commit-instruction recogniser APPENDS rather than replaces. The
// append-only invariant (frozen snapshot + TEAM_HEAD_COMMIT_INSTRUCTION ===
// NEW_*) held for the commit-instruction migration because that change was
// additive. The card-movement-rule migration is a body edit (supersession),
// so the invariant NO LONGER HOLDS: NEW_CODING_HEAD_PROMPT is restructured
// (not just appended to), and NEW_REVIEW_TEAM_HEAD_PROMPT has rules
// prepended. The append path now produces intermediate text
// (PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT) that is replaced on the next
// pass — two-pass migration. Pin the snapshot integrity instead: the frozen
// snapshot IS the old append relation, which pins the snapshot without
// constraining the new text.
test('the frozen snapshots are exactly their pre-commit-instruction snapshot plus TEAM_HEAD_COMMIT_INSTRUCTION', () => {
    assert.strictEqual(
        PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION,
        PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT,
        'PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT is not the pre-commit-instruction '
        + 'snapshot plus the commit instruction — the frozen snapshot is corrupt');
    assert.strictEqual(
        PRE_COMMIT_INSTRUCTION_REVIEW_HEAD_PROMPT + TEAM_HEAD_COMMIT_INSTRUCTION,
        PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT,
        'PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT is not the pre-commit-instruction '
        + 'snapshot plus the commit instruction — the frozen snapshot is corrupt');
    assert.ok(TEAM_HEAD_COMMIT_INSTRUCTION.includes(COMMIT_INSTRUCTION_MARKER),
        'the marker must be a substring of the appended clause, or the negative '
        + 'idempotence check never sees it and every read re-appends');
});

// The clobber this guards: the fragment sits in the CURRENT shipped prompt, so a
// fragment-only REPLACE matched an operator-edited row too — and
// loadEffectiveStandingOrders persists the transform, so the operator's wording
// was destroyed on disk (backupOnce may already have been spent by an earlier
// generation). Appending upgrades the row without touching what they wrote.
test('an operator-edited pre-commit-instruction head order keeps its wording on pass 1, replaced on pass 2', () => {
    const houseRule = ' HOUSE RULE: never touch src/legacy/ without asking me first.';
    const edited = PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1') + houseRule;
    const raw = [{ id: 'op1', parent: 'lead-1', child: '', scope: 'team-head', teamId: 't1', instruction: edited }];
    // Pass 1: APPEND preserves the operator's wording (no marker → append path).
    const out = migrateCodingTeamOrders(raw);
    const row = out.find(o => o.id === 'op1');
    assert.ok(row, 'the operator row lost its id');
    assert.ok(row.instruction.includes(houseRule),
        'the operator\'s own wording was discarded — the recogniser replaced instead of appending');
    assert.ok(row.instruction.includes(COMMIT_INSTRUCTION_MARKER),
        'the edited row must still gain the durable commit instruction');
    assert.strictEqual(row.instruction, edited + TEAM_HEAD_COMMIT_INSTRUCTION,
        'the append must be the only change to an operator-edited row');
    // Pass 2: REPLACE — the appended row now has the marker AND "Only advance..."
    // → the replace block fires and replaces with the new text. The operator's
    // wording is lost. This is consistent with all prior supersessions: operator
    // edits that retain a removed fragment are replaced. The card-movement-rule
    // migration is a supersession (text removed), not an addition.
    const out2 = migrateCodingTeamOrders(out);
    const row2 = out2.find(o => o.id === 'op1');
    assert.ok(row2, 'the operator row lost its id on pass 2');
    assert.strictEqual(row2.instruction, NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'),
        'pass 2 must replace with the new text');
    assert.ok(!row2.instruction.includes(houseRule),
        'the operator\'s wording is lost on pass 2 — consistent with all prior supersessions');
    // Pass 3 (idempotency): no recogniser matches (fragment absent, marker present).
    assert.strictEqual(migrateCodingTeamOrders(out2), out2,
        'the operator row re-matched after pass 2 — the migration is not idempotent');
});

test('the client mirror APPENDS the commit clause instead of replacing the row', () => {
    const clientClause = readConcat(TERMINALS_JS_SRC, 'var TEAM_HEAD_COMMIT_INSTRUCTION =');
    assert.strictEqual(clientClause, TEAM_HEAD_COMMIT_INSTRUCTION,
        'terminals.js TEAM_HEAD_COMMIT_INSTRUCTION drifted — the webview would render a '
        + 'different clause than the host delivers');
    assert.ok(TERMINALS_JS_SRC.includes('o.instruction + TEAM_HEAD_COMMIT_INSTRUCTION'),
        'the client mirror must append, not replace: a replace here renders the shipped '
        + 'prompt over an operator-edited row and diverges from the host transform');
    // The three superseded fragments still replace; only the additive one appends.
    assert.ok(!/PRE_COMMIT_INSTRUCTION_HEADPROMPT_FRAGMENT\) !== -1\s*\n\s*&& o\.instruction\.indexOf\(COMMIT_INSTRUCTION_MARKER\) === -1\)\)/.test(TERMINALS_JS_SRC),
        'the pre-commit fragment must not sit inside the replace condition');
});

test('migrateAgentGroups converts an untouched pre-commit-instruction Coding team', () => {
    const group = {
        id: 'g-pci',
        name: 'Coding',
        headRole: 'lead',
        headPrompt: PRE_COMMIT_INSTRUCTION_CODING_HEAD_PROMPT,
        members: [
            { role: 'coder', count: 3, scope: 'per-team', relationship: 'reports-to-head' }
        ]
    };
    const out = migrateAgentGroups([group]);
    assert.ok(out, 'converter returned null on a group that needed converting');
    assert.strictEqual(out[0].headPrompt, NEW_CODING_HEAD_PROMPT,
        'the pre-commit-instruction group must be rewritten to the new text');
    // Idempotent: second pass returns null.
    assert.strictEqual(migrateAgentGroups(out), null, 'a converted group must not be re-flagged as changed');
});

test('a persisted team-head order carrying the pre-card-movement-rule headPrompt is rewritten to the corrected text', () => {
    const installed = PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1');
    const raw = [{ id: 'o4', parent: 'lead-1', child: '', scope: 'team-head', teamId: 't1', instruction: installed }];
    const out = migrateCodingTeamOrders(raw);
    assert.notStrictEqual(out, raw, 'the recogniser did not fire for pre-card-movement-rule order');
    const row = out.find(o => o.id === 'o4');
    assert.ok(row, 'the rewritten row lost its id');
    assert.strictEqual(row.instruction, NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'),
        'the rewritten instruction is not the corrected text with {head} substituted');
    assert.ok(!row.instruction.includes('Only advance the feature your team worked'),
        'the fragment must be absent after the replace');
    assert.ok(row.instruction.includes('Never move a card backwards'),
        'the new text must contain the card-movement rule');
    // Idempotent: the fragment is absent, so the row does not re-match.
    assert.strictEqual(migrateCodingTeamOrders(out), out, 'the migration is not idempotent');
});

test('migrateAgentGroups converts an untouched pre-card-movement-rule Coding team', () => {
    const group = {
        id: 'g-pcmr',
        name: 'Coding',
        headRole: 'lead',
        headPrompt: PRE_CARD_MOVEMENT_RULE_CODING_HEAD_PROMPT,
        members: [
            { role: 'coder', count: 3, scope: 'per-team', relationship: 'reports-to-head' }
        ]
    };
    const out = migrateAgentGroups([group]);
    assert.ok(out, 'converter returned null on a group that needed converting');
    assert.strictEqual(out[0].headPrompt, NEW_CODING_HEAD_PROMPT,
        'the pre-card-movement-rule group must be rewritten to the new text');
    assert.strictEqual(migrateAgentGroups(out), null, 'a converted group must not be re-flagged as changed');
});

test('migrateAgentGroups converts an untouched pre-card-movement-rule Review team', () => {
    const group = {
        id: 'g-pcmr-r',
        name: 'Review',
        headRole: 'reviewer',
        headPrompt: PRE_CARD_MOVEMENT_RULE_REVIEW_HEAD_PROMPT,
        members: [
            { role: 'coder', count: 1, scope: 'per-team', relationship: 'reports-to-head' }
        ]
    };
    const out = migrateAgentGroups([group]);
    assert.ok(out, 'converter returned null on a group that needed converting');
    assert.strictEqual(out[0].headPrompt, NEW_REVIEW_TEAM_HEAD_PROMPT,
        'the pre-card-movement-rule Review group must be rewritten to the new text');
    assert.ok(out[0].headPrompt.includes('Never move a card backwards'),
        'the new Review headPrompt must contain the card-movement rule');
    assert.strictEqual(migrateAgentGroups(out), null, 'a converted group must not be re-flagged as changed');
});

// An operator-edited head order must survive untouched. Neither fragment is
// present, so neither recogniser may fire.
test('a team-head order carrying neither recogniser fragment is left alone', () => {
    const raw = [{ id: 'o9', parent: 'lead-1', child: '', scope: 'team-head', teamId: 't1', instruction: 'My own rules. Do what I say.' }];
    assert.strictEqual(migrateCodingTeamOrders(raw), raw, 'an operator-edited head order was rewritten');
});

// ── loadEffectiveStandingOrders: migrate on WRITE, once ────────────────────
// The pure transforms were correct and still the stale text reached a live
// agent, because nothing rewrote the persisted row: correctness depended on
// every present and future render path remembering to call them. These assert
// the row stops existing rather than being re-neutralised forever.

/** Minimal in-memory stand-in for KanbanDatabase's config-JSON surface. */
function fakeDb(seed = {}) {
    const store = new Map(Object.entries(seed).map(([k, v]) => [k, JSON.stringify(v)]));
    return {
        store,
        writes: [],
        failSet: false,
        async getConfigJson(key, defaultValue) {
            if (!store.has(key)) { return defaultValue; }
            try { return JSON.parse(store.get(key)); } catch { return defaultValue; }
        },
        async setConfigJson(key, value) {
            this.writes.push(key);
            if (this.failSet) { throw new Error('simulated setConfigJson failure'); }
            store.set(key, JSON.stringify(value));
            return true;
        },
    };
}

const staleRows = (head = 'lead-1') => [
    order({
        id: 'p1', parent: head, child: 'Coding-reviewer', scope: 'pair',
        instruction: resolvePreset('reviewer', head, 'Coding-reviewer')
    }),
    order({
        id: 'h1', parent: head, child: '', scope: 'team-head', teamId: 't1',
        instruction: OLD_CODING_HEAD_PROMPT.replace(/\{head\}/g, head)
    }),
    order({ id: 'x1', parent: 'a', child: 'b', scope: 'pair', instruction: 'operator wrote this by hand' }),
];

testAsync('loadEffectiveStandingOrders rewrites the config key once and backs it up once', async () => {
    const before = staleRows();
    const db = fakeDb({ [STANDING_ORDERS_CONFIG_KEY]: before });

    const first = await loadEffectiveStandingOrders(db);
    assert.ok(!first.some(o => o.instruction.includes('hand it to review yourself')),
        'first delivery must carry the feature-level text');
    assert.ok(!first.some(o => o.id === 'p1'), 'the stale reviewer pair row must be absent from delivery');
    assert.ok(first.some(o => o.id === 'x1'), 'an operator-authored ad-hoc order must survive untouched');

    // Persisted: the stale fragment is gone from DISK, not just from the render.
    const persisted = await db.getConfigJson(STANDING_ORDERS_CONFIG_KEY, []);
    assert.ok(!JSON.stringify(persisted).includes('hand it to review yourself'),
        'the persisted row must no longer contain the old fragment');

    // Backup holds the pre-migration array verbatim. Compared through the same
    // JSON round-trip the config table applies, so an absent optional field is
    // not mistaken for data loss.
    const onDisk = (v) => JSON.parse(JSON.stringify(v));
    assert.deepStrictEqual(await db.getConfigJson(STANDING_ORDERS_PREMIGRATION_BAK_KEY, null), onDisk(before),
        'the premigration backup must hold the pre-migration array verbatim');

    // Second pass: reference short-circuit, no write-chain entry at all.
    const writesAfterFirst = db.writes.length;
    const second = await loadEffectiveStandingOrders(db);
    assert.strictEqual(db.writes.length, writesAfterFirst,
        'a second pass must recognise nothing and never enter the write chain');
    assert.deepStrictEqual(await db.getConfigJson(STANDING_ORDERS_PREMIGRATION_BAK_KEY, null), onDisk(before),
        'the backup must never be overwritten by a later persist');
    assert.deepStrictEqual(second.map(o => o.id).sort(), first.map(o => o.id).sort(),
        'the effective set must be stable across passes');
});

testAsync('a failed persist still delivers a migrated prompt', async () => {
    const db = fakeDb({ [STANDING_ORDERS_CONFIG_KEY]: staleRows() });
    db.failSet = true;
    const effective = await loadEffectiveStandingOrders(db);
    assert.ok(!effective.some(o => o.instruction.includes('hand it to review yourself')),
        'a failed write must fall back to the in-memory transform, never block or degrade delivery');
    assert.ok(!effective.some(o => o.id === 'p1'), 'the stale pair row must still be filtered');
});

testAsync('an install with nothing stale is never written to', async () => {
    const clean = [order({ id: 'x1', parent: 'a', child: 'b', scope: 'pair', instruction: 'hand-written' })];
    const db = fakeDb({ [STANDING_ORDERS_CONFIG_KEY]: clean });
    const out = await loadEffectiveStandingOrders(db);
    assert.deepStrictEqual(out, JSON.parse(JSON.stringify(clean)));
    assert.deepStrictEqual(db.writes, [], 'no recogniser fired, so nothing may be written — not even a backup');
});

// ── The read endpoint's markers: derived, additive, identity-stable ────────
test('describeStandingOrderMigrations marks stale/dropped/effective without minting an id', () => {
    const raw = staleRows();
    const notes = describeStandingOrderMigrations(raw);

    assert.deepStrictEqual(notes.get('p1'), { stale: true, dropped: true },
        'the reviewer pair row exists on disk and contributes nothing — it must read as dropped');
    const h1 = notes.get('h1');
    assert.strictEqual(h1.stale, true);
    assert.strictEqual(h1.effectiveInstruction, NEW_CODING_HEAD_PROMPT.replace(/\{head\}/g, 'lead-1'),
        'effectiveInstruction must be the text actually delivered');
    assert.strictEqual(notes.has('x1'), false, 'an untouched operator order carries no marker');

    // Identity stability: two calls, same keys — no crypto.randomUUID() leaks out.
    assert.deepStrictEqual(
        [...describeStandingOrderMigrations(raw).keys()].sort(),
        [...notes.keys()].sort(),
        'markers must be keyed on ON-DISK ids only, or the endpoint churns ids and breaks delete-by-id');
});

test('describeStandingOrderMigrations covers the pair-fold drop, not just the Coding rows', () => {
    // The endpoint originally re-implemented only the Coding recognisers, so
    // pre-rewrite per-member pair rows were dropped from every delivered prompt
    // while the diagnostic surface reported them as ordinary live rows.
    const instruction = PRE_REWRITE_CALLBACK_INSTRUCTION;
    assert.ok(typeof instruction === 'string' && instruction.length > 0,
        'PRE_REWRITE_CALLBACK_INSTRUCTION must be exported from teamWiring');

    const raw = [order({ id: 'm1', parent: 'coder-1', child: 'lead-1', scope: 'pair', instruction })];
    const notes = describeStandingOrderMigrations(raw);
    assert.deepStrictEqual(notes.get('m1'), { stale: true, dropped: true },
        'a folded per-member pair row must read as dropped — it is filtered from every delivered prompt');
});

test('describeStandingOrderMigrations is empty once the persist has run', () => {
    const migrated = migrateCodingTeamOrders(migrateTeamPairOrders(staleRows()));
    assert.strictEqual(describeStandingOrderMigrations(migrated).size, 0,
        'no recogniser fires post-persist — permanently absent markers are the correct end state');
});

// ── 8. Team-coder queue/done instruction: two-copy rule and migration ──
//
// Head-paced team coders need an explicit POST /kanban/queue/done signal to
// replace the unreliable mtime-based file-watcher detection. Seat-paced and
// standalone coders already carry the instruction; this adds the team-coder
// equivalent and migrates existing team-scoped orders that predate it.

test('PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT exists in exactly two files and is byte-identical', () => {
    const hostWiringSrc = SRC('services', 'teamWiring.ts');
    const hostMatch = hostWiringSrc.match(/const PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(hostMatch, 'PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT not found in teamWiring.ts');
    const hostFragment = hostMatch[1];

    const clientMatch = TERMINALS_JS_SRC.match(/var PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT\s*=\s*'([^']+)'/);
    assert.ok(clientMatch, 'PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT not found in terminals.js');
    const clientFragment = clientMatch[1];

    assert.strictEqual(clientFragment, hostFragment,
        'PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT drifted between teamWiring.ts and terminals.js');

    // The fragment text ('is your head agent') appears in the callback
    // instruction constants in linkPresets.ts and kanban.html too, so the
    // two-copy rule applies to the DECLARATION sites, not every substring
    // occurrence. Verify the declarations exist in exactly two files.
    const hostDecl = /const PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT\s*=/.test(hostWiringSrc);
    const clientDecl = /var PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT\s*=/.test(TERMINALS_JS_SRC);
    assert.ok(hostDecl && clientDecl,
        'PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT must be declared in both teamWiring.ts and terminals.js');
});

test('QUEUE_DONE_MARKER exists in exactly two files and is byte-identical', () => {
    const hostWiringSrc = SRC('services', 'teamWiring.ts');
    const hostMatch = hostWiringSrc.match(/const QUEUE_DONE_MARKER\s*=\s*'([^']+)'/);
    assert.ok(hostMatch, 'QUEUE_DONE_MARKER not found in teamWiring.ts');
    const hostMarker = hostMatch[1];

    const clientMatch = TERMINALS_JS_SRC.match(/var QUEUE_DONE_MARKER\s*=\s*'([^']+)'/);
    assert.ok(clientMatch, 'QUEUE_DONE_MARKER not found in terminals.js');
    const clientMarker = clientMatch[1];

    assert.strictEqual(clientMarker, hostMarker,
        'QUEUE_DONE_MARKER drifted between teamWiring.ts and terminals.js');

    // The marker text appears in the prompt constants too (it is a substring
    // of SEAT_QUEUE_DONE_ORDER_BODY and GLOBAL_QUEUE_DONE_ORDER_BODY), so the
    // two-copy rule applies to the DECLARATION sites, not every substring
    // occurrence. Verify the declarations exist in exactly two files.
    const hostDecl = /const QUEUE_DONE_MARKER\s*=/.test(hostWiringSrc);
    const clientDecl = /var QUEUE_DONE_MARKER\s*=/.test(TERMINALS_JS_SRC);
    assert.ok(hostDecl && clientDecl,
        'QUEUE_DONE_MARKER must be declared in both teamWiring.ts and terminals.js');
});

test('TEAM_CODER_QUEUE_DONE_INSTRUCTION is byte-identical across host and webview mirror', () => {
    const clientInstruction = readConcat(TERMINALS_JS_SRC, 'var TEAM_CODER_QUEUE_DONE_INSTRUCTION =');
    assert.strictEqual(clientInstruction, TEAM_CODER_QUEUE_DONE_INSTRUCTION,
        'terminals.js TEAM_CODER_QUEUE_DONE_INSTRUCTION drifted — the webview would render a '
        + 'different queue/done instruction than the host delivers');
});

test('TEAM_CODER_QUEUE_DONE_INSTRUCTION contains the QUEUE_DONE_MARKER but NOT the PRE_QUEUE_DONE fragment', () => {
    assert.ok(TEAM_CODER_QUEUE_DONE_INSTRUCTION.includes(QUEUE_DONE_MARKER),
        'the instruction must contain the marker — a rewritten row carries it for idempotency');
    assert.ok(!TEAM_CODER_QUEUE_DONE_INSTRUCTION.includes(PRE_QUEUE_DONE_TEAM_PROMPT_FRAGMENT),
        'the instruction must not contain the pre-queue-done fragment — it is not a callback prompt');
});

test('migrateCodingTeamOrders appends TEAM_CODER_QUEUE_DONE_INSTRUCTION to a pre-queue-done team order', () => {
    // A team-scoped order carrying the callback instruction (contains
    // 'is your head agent') but NOT the queue/done marker — the shape every
    // head-paced team coder had before this subtask.
    const callbackText = AGENT_GROUP_CALLBACK_INSTRUCTION.replace(/\{child\}/g, 'lead-1')
        + '\n' + GIT_SAFETY_DIRECTIVE;
    const raw = [order({
        id: 't1', parent: 'lead-1', child: '', scope: 'team', teamId: 'team-1',
        instruction: callbackText
    })];
    const out = migrateCodingTeamOrders(raw);
    assert.notStrictEqual(out, raw, 'the recogniser did not fire for a pre-queue-done team order');
    const row = out.find(o => o.id === 't1');
    assert.ok(row, 'the rewritten row lost its id');
    assert.strictEqual(row.instruction, callbackText + '\n' + TEAM_CODER_QUEUE_DONE_INSTRUCTION,
        'the append must be the only change — instruction + newline + TEAM_CODER_QUEUE_DONE_INSTRUCTION');
    assert.ok(row.instruction.includes(QUEUE_DONE_MARKER),
        'the rewritten row must carry the marker for idempotency');
    // Idempotent: second pass finds the marker, does not re-match.
    assert.strictEqual(migrateCodingTeamOrders(out), out,
        'the migration is not idempotent — it would re-append forever');
});

test('migrateCodingTeamOrders does NOT match a seat-paced team order (no callback fragment)', () => {
    // SEAT_QUEUE_DONE_ORDER_BODY is installed at 'team' scope but does NOT
    // contain 'is your head agent', so the recogniser must skip it.
    const raw = [order({
        id: 's1', parent: 'lead-1', child: '', scope: 'team', teamId: 'team-1',
        instruction: SEAT_QUEUE_DONE_ORDER_BODY
    })];
    assert.strictEqual(migrateCodingTeamOrders(raw), raw,
        'a seat-paced team order must not be matched — it already carries the queue/done instruction');
});

test('migrateCodingTeamOrders does NOT match a team order that already has the marker', () => {
    const callbackText = AGENT_GROUP_CALLBACK_INSTRUCTION.replace(/\{child\}/g, 'lead-1')
        + '\n' + GIT_SAFETY_DIRECTIVE
        + '\n' + TEAM_CODER_QUEUE_DONE_INSTRUCTION;
    const raw = [order({
        id: 't2', parent: 'lead-1', child: '', scope: 'team', teamId: 'team-1',
        instruction: callbackText
    })];
    assert.strictEqual(migrateCodingTeamOrders(raw), raw,
        'a team order that already carries the marker must not be re-matched');
});

test('an operator-edited pre-queue-done team order keeps its wording on append', () => {
    const houseRule = ' HOUSE RULE: always run prettier before posting done.';
    const callbackText = AGENT_GROUP_CALLBACK_INSTRUCTION.replace(/\{child\}/g, 'lead-1')
        + '\n' + GIT_SAFETY_DIRECTIVE + houseRule;
    const raw = [order({
        id: 'op2', parent: 'lead-1', child: '', scope: 'team', teamId: 'team-1',
        instruction: callbackText
    })];
    const out = migrateCodingTeamOrders(raw);
    const row = out.find(o => o.id === 'op2');
    assert.ok(row, 'the operator row lost its id');
    assert.ok(row.instruction.includes(houseRule),
        'the operator\'s own wording was discarded — the recogniser replaced instead of appending');
    assert.strictEqual(row.instruction, callbackText + '\n' + TEAM_CODER_QUEUE_DONE_INSTRUCTION,
        'the append must be the only change to an operator-edited row');
});

// ── 9. REVIEW UNIT: the reviewer is told what to review ───────────────
// The reviewer prompt used to hand over plan FILE PATHS and nothing else —
// it inferred the change set from a shared dirty tree that might hold several
// seats' in-flight work. The fix resolves the coded commit carrying each plan
// id (most-recent-wins) at the CALLER and passes the shas in for the builder
// to render. These pin the consumer side of that contract.

console.log('\n── REVIEW UNIT: the reviewer is handed a bounded diff ──');

const reviewerPlans = [{ sessionId: 's1', planId: PLAN_A, title: 'P1', topic: 'P1', absolutePath: '/p1.md' }];

test('reviewCommits with one sha renders "review commit <sha>" and the do-not-infer sentence', () => {
    const prompt = buildKanbanBatchPrompt('reviewer', reviewerPlans, { reviewCommits: ['abc123'] });
    assert.ok(prompt.includes('REVIEW UNIT:'), 'a non-empty reviewCommits array must emit a REVIEW UNIT block');
    assert.ok(prompt.includes('review commit abc123'),
        'singular form must read "review commit <sha>"');
    assert.ok(/Do not infer the change set from the working tree/.test(prompt),
        'the do-not-infer sentence must be present — it is the whole point of the block');
    assert.ok(prompt.includes('`git show abc123`'),
        'the block must name the git show command for the sha');
});

test('reviewCommits empty or undefined is byte-identical to omitting the option — absent means absent', () => {
    const base = buildKanbanBatchPrompt('reviewer', reviewerPlans, {});
    // No placeholder, no empty ref, no dangling range — a reviewer confidently
    // reviewing nothing is worse than the problem this fixes. Asserted, not assumed.
    for (const reviewCommits of [[], undefined]) {
        const prompt = buildKanbanBatchPrompt('reviewer', reviewerPlans, { reviewCommits });
        assert.strictEqual(prompt, base,
            `reviewCommits=${JSON.stringify(reviewCommits)} must not alter the prompt — `
            + 'absent means absent, never a stub that fakes success');
        assert.ok(!prompt.includes('REVIEW UNIT:'),
            `reviewCommits=${JSON.stringify(reviewCommits)} leaked a REVIEW UNIT block`);
    }
});

test('two distinct shas render both, deduplicated; a repeated sha is emitted once', () => {
    const prompt = buildKanbanBatchPrompt('reviewer', reviewerPlans, {
        reviewCommits: ['abc123', 'abc123', 'def456']
    });
    assert.ok(prompt.includes('abc123'), 'first sha must appear');
    assert.ok(prompt.includes('def456'), 'second sha must appear');
    // Deduplicated: the repeated sha contributes one occurrence in the REVIEW UNIT head.
    const head = prompt.match(/REVIEW UNIT:[^\n]*/);
    assert.ok(head, 'REVIEW UNIT head line not found');
    assert.strictEqual((head[0].match(/abc123/g) || []).length, 1,
        'a repeated sha must be deduplicated to a single mention in the REVIEW UNIT head');
    assert.ok(/review commits/.test(head[0]),
        'plural form must read "review commits" when more than one sha resolves');
});

test('agentPromptBuilder.ts contains no child_process, execFile, or require("child_process") — the purity guard', () => {
    // The builder must NOT shell out. Two sibling plans depend on this module
    // staying free of node's process-spawning builtins; the CALLER resolves the
    // sha and passes it in. A blanket "no node builtins" assertion would FAIL on
    // the existing `fs` import, so this names the forbidden tokens specifically.
    for (const forbidden of ['child_process', 'execFile', "require('child_process')"]) {
        assert.ok(!AGENT_PROMPT_BUILDER_SRC.includes(forbidden),
            `agentPromptBuilder.ts must not contain '${forbidden}' — the builder renders shas, `
            + 'it never resolves them; resolution lives in the KanbanProvider caller');
    }
});

test('REVIEW UNIT sits above PLANS TO PROCESS: — the plan list is context for the diff, not the target', () => {
    const prompt = buildKanbanBatchPrompt('reviewer', reviewerPlans, { reviewCommits: ['abc123'] });
    const reviewIdx = prompt.indexOf('REVIEW UNIT:');
    const plansIdx = prompt.indexOf('PLANS TO PROCESS:');
    assert.ok(reviewIdx >= 0 && plansIdx >= 0, 'both blocks must be present');
    assert.ok(reviewIdx < plansIdx,
        'REVIEW UNIT must precede PLANS TO PROCESS: so the plan list reads as context for the diff');
});

_drainAsyncCases().then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
});

