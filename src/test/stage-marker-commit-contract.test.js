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
    STAGE_BY_ROLE
} = require('../../out/services/agentPromptBuilder');
const {
    migrateAgentGroups,
    migrateCodingTeamOrders,
    migrateTeamPairOrders,
    loadEffectiveStandingOrders,
    describeStandingOrderMigrations,
    OLD_CODING_HEAD_PROMPT,
    NEW_CODING_HEAD_PROMPT,
    PRE_REWRITE_CALLBACK_INSTRUCTION,
    STANDING_ORDERS_PREMIGRATION_BAK_KEY
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
        'GET /kanban/feature', 'FEATURE planId', 'intern → coder → lead', 'seat fails review on the same subtask twice',
        'stop and report to the human instead of dispatching again']) {
        assert.ok(NEW_CODING_HEAD_PROMPT.includes(lit), `missing load-bearing literal: ${lit}`);
    }
    assert.ok(!NEW_CODING_HEAD_PROMPT.includes('satisfied with it, hand it to review yourself'),
        'the new text must not contain the fragment the order converter matches on, or it re-converts forever');
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

test('all three host read sites use loadEffectiveStandingOrders and client mirror composes converters', () => {
    const sites = [
        ['services/TaskViewerProvider.ts', 2],
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

_drainAsyncCases().then(() => {
    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
});

