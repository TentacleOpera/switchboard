'use strict';

/**
 * Contract tests for "Analyze on the Planned column sends the wrong candidate set
 * — project scope and feature atomicity"
 * (.switchboard/plans/feature_plan_20260808120000_dispatch-analyze-candidate-set-scope-and-features.md).
 *
 * The two defects this pins shut:
 *   1. the dispatchAnalyze candidate set was never project-scoped, so pressing
 *      Analyze on a filtered board staged plans from projects the user was not
 *      looking at;
 *   2. the shared dispatch builder exploded features into subtasks, and a plan
 *      list that names subtasks individually reads as an invitation to promote
 *      them individually — which silently relocates the parent feature card.
 *
 * Plus the two mechanisms whose failure modes are silent:
 *   - the scope must ride the SEVENTH positional argument of
 *     switchboard.triggerBatchAgentFromKanban. The fifth is
 *     targetTerminalOverride; a project name there is read as a terminal NAME,
 *     fails _isValidAgentName, and Analyze stops working entirely.
 *   - `PROJECT=` has exactly four forms (absent / <all> / <unassigned> / a bare
 *     name) and both hosts must emit them from ONE resolver, because the skill's
 *     step-1 table dispatches on the exact spelling.
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

// Same pre-existing gap as verb-engine-kanban-headless.test.js: tsc does not
// emit hand-written .js sources, so copy the derivation impl into out/.
{
    const implSrc = path.join(__dirname, '..', 'services', 'kanbanColumnDerivationImpl.js');
    const implOut = path.join(__dirname, '..', '..', 'out', 'services', 'kanbanColumnDerivationImpl.js');
    if (fs.existsSync(implSrc) && !fs.existsSync(implOut)) {
        fs.copyFileSync(implSrc, implOut);
    }
}

const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { buildAnalysisScopeLine, buildFeatureWorktreeModeLine, UNASSIGNED_PROJECT_SENTINEL } = require('../../out/services/agentPromptBuilder');
const { VERB_SCHEMAS, validateVerbPayload } = require('../../out/services/verbSchemas');

const REPO_ROOT = path.join(__dirname, '..', '..');
const readSrc = (rel) => fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e}`);
        failed++;
    }
}

const ROOT = '/ws';

/**
 * A KanbanProvider stripped to exactly what `generateUnifiedPrompt`'s
 * dispatch-analysis arm touches.
 *
 * `Object.create` bypasses the class-field initializers, so the double must
 * restore the two things the arm's store reads depend on:
 *  - `_getKanbanDb` is overridden (the production one calls
 *    `resolveEffectiveWorkspaceRoot` → `this._context.workspaceState`, which a
 *    prototype-only instance does not have). The arm reads the board's
 *    `feature_worktree_mode` through it, so the stub answers that key.
 *  - `_context` / `_kanbanDbs` are still supplied for any other path a
 *    non-stubbed call takes.
 * The plan's prompt-layout assertions are the reason this file exists; a double
 * that aborts before the regex runs verifies nothing.
 */
function makePlannerProvider() {
    const kp = Object.create(KanbanProvider.prototype);
    kp._taskViewerProvider = { getLocalApiServerPort: () => 4711 };
    kp._kanbanDbs = new Map();
    kp._context = {
        globalState: { get: () => undefined, update: async () => {} },
        workspaceState: { get: () => undefined, update: async () => {} },
    };
    kp._getKanbanDb = () => ({
        ensureReady: async () => true,
        getConfig: async () => null,
        getConfigJson: async (_key, fallback) => fallback,
    });
    return kp;
}

function card(planId, project, extra) {
    return Object.assign({
        planId,
        sessionId: planId,
        topic: planId,
        column: 'PLAN REVIEWED',
        workspaceRoot: ROOT,
        project,
    }, extra || {});
}

/**
 * A KanbanProvider stripped to exactly what the dispatchAnalyze arm touches, with
 * the command seam recorded so the test can assert on the ARGUMENT LIST — the
 * observable the plan names (never by re-implementing the sentinel mapping).
 */
function makeAnalyzeProvider(cards) {
    const calls = [];
    const infos = [];
    const kp = Object.create(KanbanProvider.prototype);
    kp._lastCards = cards;
    kp._currentWorkspaceRoot = ROOT;
    kp._resolveWorkspaceRoot = (r) => (r || ROOT);
    kp._seams = () => ({
        ui: {
            showInformationMessage: async (m) => { infos.push(m); return undefined; },
            showErrorMessage: async (m) => { infos.push(m); return undefined; },
        },
        commands: {
            executeCommand: async (...args) => { calls.push(args); return true; },
        },
    });
    return { kp, calls, infos };
}

async function analyzeWith(cards, msg) {
    const { kp, calls, infos } = makeAnalyzeProvider(cards);
    const result = await kp._handleMessage(Object.assign({ type: 'dispatchAnalyze', workspaceRoot: ROOT }, msg));
    return { result, calls, infos };
}

/** The plan IDs the arm actually staged, in order. */
function stagedIds(calls) {
    assert.strictEqual(calls.length, 1, 'expected exactly one triggerBatchAgentFromKanban dispatch');
    return calls[0][2];
}

async function main() {
    console.log('\n── 1. the candidate set is scoped by msg.initiatorProject ──');

    // Deliberately mixed: two projects plus an unpinned plan, and a subtask that
    // _visibleColumnCards must exclude regardless of scope.
    const BOARD = [
        card('p-browser-1', 'Browser Switchboard'),
        card('p-browser-2', 'Browser Switchboard'),
        card('p-website-1', 'Website'),
        card('p-unpinned-1', ''),
        card('p-subtask-1', 'Browser Switchboard', { featureId: 'feat-1' }),
        card('p-other-column', 'Browser Switchboard', { column: 'CREATED' }),
        card('p-other-root', 'Browser Switchboard', { workspaceRoot: '/elsewhere' }),
    ];

    await test('named project: only that project\'s Planned cards are staged', async () => {
        const { calls } = await analyzeWith(BOARD, { initiatorProject: 'Browser Switchboard' });
        assert.deepStrictEqual(stagedIds(calls), ['p-browser-1', 'p-browser-2']);
    });

    await test('__unassigned__ stages only cards with an empty project — NOT every project', async () => {
        const { calls } = await analyzeWith(BOARD, { initiatorProject: KanbanDatabase.UNASSIGNED_PROJECT_FILTER });
        assert.deepStrictEqual(stagedIds(calls), ['p-unpinned-1'],
            'collapsing the unassigned sentinel into a falsy check inverts the filter');
    });

    await test('explicit null (unfiltered board) stages the whole Planned column', async () => {
        const { calls } = await analyzeWith(BOARD, { initiatorProject: null });
        assert.deepStrictEqual(stagedIds(calls), ['p-browser-1', 'p-browser-2', 'p-website-1', 'p-unpinned-1']);
    });

    await test('undefined (raw API caller, no filter sent) preserves the prior all-cards behaviour', async () => {
        const { calls } = await analyzeWith(BOARD, {});
        assert.deepStrictEqual(stagedIds(calls), ['p-browser-1', 'p-browser-2', 'p-website-1', 'p-unpinned-1']);
    });

    await test('an empty SCOPED column names the scope and dispatches nothing', async () => {
        const { result, calls, infos } = await analyzeWith(BOARD, { initiatorProject: 'Nonexistent Project' });
        assert.strictEqual(calls.length, 0, 'no agent may be dispatched for an empty scoped column');
        assert.strictEqual(result.success, false);
        assert.ok(/Nonexistent Project/.test(infos.join(' ')),
            'the message must distinguish an empty scoped column from an empty column');
    });

    console.log('\n── 2. the scope rides the SEVENTH argument, never the fifth ──');

    await test('the dispatch passes undefined in the 5th (targetTerminalOverride) and the scope in the 7th', async () => {
        const { calls } = await analyzeWith(BOARD, { initiatorProject: 'Browser Switchboard' });
        const args = calls[0];
        assert.strictEqual(args[0], 'switchboard.triggerBatchAgentFromKanban');
        assert.strictEqual(args[3], 'dispatch-analysis', 'arg 3 (instruction)');
        assert.strictEqual(args[5], undefined,
            'arg 5 is targetTerminalOverride — a project name here is read as a TERMINAL NAME and aborts the batch');
        assert.strictEqual(args[7], 'Browser Switchboard', 'arg 7 is analysisScope');
    });

    await test('both host registrations declare analysisScope as the 7th positional', () => {
        const ext = readSrc('src/extension.ts');
        const reg = ext.split('switchboard.triggerBatchAgentFromKanban')[1] || '';
        const sig = reg.slice(0, reg.indexOf('=>'));
        const order = ['instruction', 'workspaceRoot', 'targetTerminalOverride', 'apiOriginated', 'analysisScope'];
        let cursor = -1;
        for (const name of order) {
            const at = sig.indexOf(name);
            assert.ok(at > cursor, `extension.ts registration: '${name}' out of order`);
            cursor = at;
        }
        const boot = readSrc('src/standalone/bootstrap.ts');
        const bReg = boot.split("switchboardCommandRegistry.register('switchboard.triggerBatchAgentFromKanban'")[1] || '';
        const bSig = bReg.slice(0, bReg.indexOf('=>'));
        const bOrder = ['instruction', 'targetRoot', 'terminalName', 'apiOriginated', 'analysisScope'];
        let bCursor = -1;
        for (const name of bOrder) {
            const at = bSig.indexOf(name);
            assert.ok(at > bCursor, `bootstrap.ts registration: '${name}' out of order (positions must mirror the extension)`);
            bCursor = at;
        }
    });

    console.log('\n── 3. features are one unit — no [SUBTASK] lines in an analysis prompt ──');

    await test('the dispatch-analysis prompt keeps [FEATURE: …] and drops every [SUBTASK] line', async () => {
        const kp = makePlannerProvider();
        const plans = [
            { topic: 'Loose plan', absolutePath: '/ws/a.md', planId: 'a', sessionId: 'a' },
            { topic: 'The Feature', absolutePath: '/ws/f.md', planId: 'f', sessionId: 'f', isFeature: true, featureTopic: 'The Feature' },
            { topic: 'Sub one', absolutePath: '/ws/s1.md', planId: 's1', sessionId: 's1', isSubtask: true, featureTopic: 'The Feature' },
            { topic: 'Sub two', absolutePath: '/ws/s2.md', planId: 's2', sessionId: 's2', isSubtask: true, featureTopic: 'The Feature' },
            { topic: 'Sub three', absolutePath: '/ws/s3.md', planId: 's3', sessionId: 's3', isSubtask: true, featureTopic: 'The Feature' },
        ];
        const prompt = await kp.generateUnifiedPrompt('planner', plans, ROOT, { instruction: 'dispatch-analysis' });
        assert.ok(!/\[SUBTASK\]/.test(prompt), 'a subtask named individually reads as an invitation to promote it individually');
        assert.ok(/\[FEATURE: The Feature\]/.test(prompt), 'the feature parent must keep its label');
        assert.ok(/Loose plan/.test(prompt), 'loose plans must survive the filter');
    });

    console.log('\n── 4. PROJECT= parity: one resolver, four forms ──');

    await test('the sentinel mirrored into agentPromptBuilder still matches KanbanDatabase', () => {
        assert.strictEqual(UNASSIGNED_PROJECT_SENTINEL, KanbanDatabase.UNASSIGNED_PROJECT_FILTER);
    });

    await test('buildAnalysisScopeLine emits only the four forms the skill accepts', () => {
        assert.strictEqual(buildAnalysisScopeLine(undefined), '',
            'never threaded → NO line, which is the skill\'s "use PLANS TO PROCESS verbatim, do not widen" fallback');
        assert.strictEqual(buildAnalysisScopeLine(null), 'PROJECT=<all>\n');
        assert.strictEqual(buildAnalysisScopeLine(''), 'PROJECT=<all>\n');
        assert.strictEqual(buildAnalysisScopeLine(KanbanDatabase.UNASSIGNED_PROJECT_FILTER), 'PROJECT=<unassigned>\n');
        assert.strictEqual(buildAnalysisScopeLine('Browser Switchboard'), 'PROJECT=Browser Switchboard\n');
        assert.strictEqual(buildAnalysisScopeLine('Bad\nName'), 'PROJECT=BadName\n',
            'a newline in a user-authored project name would corrupt the prompt block');
    });

    await test('the dispatch-analysis prompt is built by ONE provider method, from the shared resolvers', () => {
        const kb = readSrc('src/services/KanbanProvider.ts');
        assert.ok(/buildAnalysisScopeLine\(/.test(kb), 'KanbanProvider must call buildAnalysisScopeLine');
        assert.ok(/buildFeatureWorktreeModeLine\(/.test(kb), 'KanbanProvider must call buildFeatureWorktreeModeLine');
        // The standalone host builds its prompts through this same provider method
        // (generateUnifiedPrompt), so neither host may hand-roll either line.
        for (const [label, src] of [['KanbanProvider.ts', kb], ['bootstrap.ts', readSrc('src/standalone/bootstrap.ts')]]) {
            assert.strictEqual((src.match(/['"`]PROJECT=<(all|unassigned)>/g) || []).length, 0,
                `${label} hand-rolls a PROJECT= form — the shared resolver exists so the hosts cannot drift`);
            assert.strictEqual((src.match(/['"`]FEATURE_WORKTREE_MODE=/g) || []).length, 0,
                `${label} hand-rolls a FEATURE_WORKTREE_MODE= form — route it through buildFeatureWorktreeModeLine`);
        }
    });

    await test('buildFeatureWorktreeModeLine emits the two spellings and defaults unknown to none', () => {
        assert.strictEqual(buildFeatureWorktreeModeLine('none'), 'FEATURE_WORKTREE_MODE=none\n');
        assert.strictEqual(buildFeatureWorktreeModeLine('per-feature'), 'FEATURE_WORKTREE_MODE=per-feature\n');
        for (const bad of [undefined, null, '', 'per-subtask', 'high-low', 'Bad\nMode']) {
            assert.strictEqual(buildFeatureWorktreeModeLine(bad), 'FEATURE_WORKTREE_MODE=none\n',
                `unknown mode ${JSON.stringify(bad)} must resolve to none — a wrongly-emitted per-feature would silently suppress the offer`);
        }
    });

    await test('the dispatch-analysis arm emits PROJECT= then FEATURE_WORKTREE_MODE= then a blank line', async () => {
        const kp = makePlannerProvider();
        const plans = [{ topic: 'A', absolutePath: '/ws/a.md', planId: 'a', sessionId: 'a' }];
        const scoped = await kp.generateUnifiedPrompt('planner', plans, ROOT, { instruction: 'dispatch-analysis', analysisScope: 'Browser Switchboard' });
        assert.ok(/API_PORT=4711\nPROJECT=Browser Switchboard\nFEATURE_WORKTREE_MODE=none\n\nPLANS TO PROCESS:/.test(scoped), scoped);

        const unfiltered = await kp.generateUnifiedPrompt('planner', plans, ROOT, { instruction: 'dispatch-analysis', analysisScope: null });
        assert.ok(/API_PORT=4711\nPROJECT=<all>\nFEATURE_WORKTREE_MODE=none\n\nPLANS TO PROCESS:/.test(unfiltered), unfiltered);

        // The single-plan planner path (TaskViewerProvider's dispatch-analysis
        // allowlist) threads no scope. It must emit NO PROJECT= line — PROJECT=<all>
        // there would be worse than the pre-scoping behaviour, actively telling the
        // agent to widen to every project. The mode line is still emitted; its
        // absence would read as "no topology".
        const unthreaded = await kp.generateUnifiedPrompt('planner', plans, ROOT, { instruction: 'dispatch-analysis' });
        assert.ok(!/PROJECT=/.test(unthreaded), unthreaded);
        assert.ok(/API_PORT=4711\nFEATURE_WORKTREE_MODE=none\n\nPLANS TO PROCESS:/.test(unthreaded), unthreaded);
    });

    await test('the skill and the orchestration surface document the mode line and the create route', () => {
        const bundle = readSrc('src/services/bundledProtocols.ts');
        const m = bundle.match(/"dispatch-analysis":\s*\{[^}]*"body":\s*"((?:[^"\\]|\\.)*)"/s);
        assert.ok(m, 'dispatch-analysis body must be present in the bundle');
        const skill = JSON.parse('"' + m[1] + '"');
        assert.ok(skill.includes('FEATURE_WORKTREE_MODE=none') && skill.includes('`per-feature`'),
            'step 4a must spell both mode values');
        assert.ok(/POST \/worktree\/feature/.test(skill), 'step 6b must name the create route');

        const orchestration = readSrc('.agents/skills/switchboard-orchestration/SKILL.md');
        assert.ok(/POST \/worktree\/feature/.test(orchestration),
            'fleet agents read the orchestration surface — the route must be listed there');
    });

    await test('POST /worktree/feature is a thin caller that never writes feature_worktree_mode', () => {
        const api = readSrc('src/services/LocalApiServer.ts');
        assert.ok(/pathname === '\/worktree\/feature' && req\.method === 'POST'/.test(api), 'the route must be registered');
        const start = api.indexOf('private async _handleCreateFeatureWorktree');
        assert.ok(start > 0, 'the handler must exist');
        const handler = api.slice(start, start + 4000);
        assert.ok(/this\._options\.createFeatureWorktree/.test(handler),
            'the route must delegate to the wired provider seam, never re-implement the create dance');
        assert.ok(!/setConfig\s*\(/.test(handler),
            'the handler must never write feature_worktree_mode — orchestration stashes a prior under that key');

        const kb = readSrc('src/services/KanbanProvider.ts');
        assert.ok(/public async createWorktreeForFeature\(/.test(kb), 'the ONE provider method must exist');
        assert.ok(/createFeatureWorktree:/.test(readSrc('src/services/TaskViewerProvider.ts')),
            'the extension host must wire the create seam');
        assert.ok(/createFeatureWorktree:/.test(readSrc('src/standalone/bootstrap.ts')),
            'the standalone host must wire the create seam — an unwired seam is invisible at runtime');
    });

    console.log('\n── 5. the HTTP boundary declares what the arm dereferences ──');

    await test('dispatchAnalyze declares initiatorProject, optional, and accepts an explicit null', () => {
        const schema = VERB_SCHEMAS.kanban.dispatchAnalyze;
        assert.ok(schema && schema.fields && schema.fields.initiatorProject,
            'the arm dereferences msg.initiatorProject — PRD contract #5 requires the schema to be field-accurate');
        assert.ok(!schema.fields.initiatorProject.required,
            'required would reject valid payloads from shipped webview builds');
        assert.deepStrictEqual(
            validateVerbPayload('kanban', 'dispatchAnalyze', { workspaceRoot: '/x', initiatorProject: null }),
            { ok: true },
            'null is a meaningful sentinel here and must pass the boundary'
        );
        assert.deepStrictEqual(
            validateVerbPayload('kanban', 'dispatchAnalyze', { workspaceRoot: '/x', initiatorProject: '__unassigned__' }),
            { ok: true }
        );
        assert.deepStrictEqual(validateVerbPayload('kanban', 'dispatchAnalyze', { workspaceRoot: '/x' }), { ok: true });
    });

    console.log('\n── 6. the skill reads the per-column endpoint, not the whole board ──');

    // The dispatch-analysis protocol body is a control-plane row (bodies in
    // bundledProtocols.ts), materialized on setup — so the bundle is the source
    // of truth. Reading an on-disk `.agents/...` path would make this red on
    // every checkout that has not run setup. Same pattern as
    // dependency-gate-contract.test.js and skill-preconditions-contract.test.js.
    await test('dispatch-analysis step 1 names the per-column read and demotes /kanban/board', () => {
        const bundle = readSrc('src/services/bundledProtocols.ts');
        const m = bundle.match(/"dispatch-analysis":\s*\{[^}]*"body":\s*"((?:[^"\\]|\\.)*)"/s);
        assert.ok(m, 'dispatch-analysis body must be present in the bundle');
        const skill = JSON.parse('"' + m[1] + '"');

        assert.ok(/\/kanban\/plans\?workspaceRoot=\{WORKSPACE_ROOT\}&column=PLAN%20REVIEWED/.test(skill),
            'step 1 must name the per-column plans read as the primary read');
        // /kanban/board may still appear as the discouraged form, but never as an instruction.
        assert.ok(!/GET\s+http:\/\/localhost:\{API_PORT\}\/kanban\/board/.test(skill),
            'a bare GET /kanban/board pulls every column; the pass needs one');
        assert.ok(/POST[\s\S]{0,120}\/kanban\/(move|dependencies)/.test(skill),
            'the write endpoints must survive — only the READ moved off the whole-board endpoint');
    });

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed > 0) { process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
