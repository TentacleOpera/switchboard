'use strict';
/**
 * Contract: the memo panel binds to the CURRENT workspace, and a generated
 * planner prompt's plansDir and PROJECT PIN come from the SAME workspace.
 *
 * The regression this locks down: with the board on `switchboard`, the browser
 * memo panel wrote Gitlab's .switchboard/memo.md and emitted a prompt whose
 * plansDir was Gitlab while its PROJECT PIN named a switchboard-only project.
 *
 * The generated prompt is read from the CLIPBOARD SEAM RECORDER, not from the
 * response body: the extension arm deliberately does not echo `prompt` back to
 * the browser (it writes the system clipboard host-side), so the seam is the
 * only place the emitted prompt is observable.
 *
 * Run with: npm run compile-tests && npm run test:contract:memo-workspace-binding
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
    installPermissiveVscodeStub,
    createHeadlessTestSeams,
} = require('./helpers/verbEngineTestSeams');

// Recording stub rather than the strict trap — TaskViewerProvider's instance
// fields reach vscode.window.createOutputChannel() in the ctor (a known,
// separately-planned unmigrated surface). Per-arm vscode access is asserted below.
const vscodeStub = installPermissiveVscodeStub();

const { TaskViewerProvider } = require('../../out/services/TaskViewerProvider');
const { KanbanProvider } = require('../../out/services/KanbanProvider');
const { KanbanDatabase } = require('../../out/services/KanbanDatabase');
const { BroadcastHub } = require('../../out/services/broadcastHub');
const { getMemoHtml } = require('../../out/services/headlessPanelHtml');

// The ctor fires _startLocalApiServer(), which binds a real TCP port. This suite
// asserts on the memo arm, the project guard, and the serveStatic SOURCE — not on
// server startup. Test isolation only.
TaskViewerProvider.prototype._startLocalApiServer = async function () { /* no port binding in tests */ };

const REPO_ROOT = path.join(__dirname, '..', '..');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

function buildHeadlessTaskViewer(roots) {
    // _getWorkspaceRoots() reads vscode.workspace.workspaceFolders DIRECTLY, and
    // _getAllowedRoots()/_resolveWorkspaceRoot() gate on it — so an explicit
    // `workspaceRoot` is only honoured when it is listed here. This is also what
    // makes the multi-root case (the reported bug's shape) reproducible.
    vscodeStub.setWorkspaceFolders(roots);
    const { seams, recorders } = createHeadlessTestSeams({ roots });
    const pushes = [];
    const provider = new TaskViewerProvider(
        { fsPath: path.join(roots[0], 'ext') },
        {
            globalState: { get: () => undefined, update: async () => {} },
            workspaceState: { get: () => undefined, update: async () => {} },
            subscriptions: [],
            extensionUri: { fsPath: path.join(__dirname, '..', '..') },
            secrets: null,
        },
        false
    );
    provider.initHeadlessVerbServing(seams, new BroadcastHub({
        webview: { postMessage: (m) => { pushes.push(m); return Promise.resolve(true); } },
        apiServer: null,
    }));
    vscodeStub.reset();
    return { provider, seams, recorders, pushes };
}

/**
 * `resolveAuthoringProject` on the REAL KanbanProvider prototype, with only the
 * three fields it touches. Constructing a full KanbanProvider needs the vscode
 * host; the prototype call exercises the actual shipped method body.
 */
function makeProjectResolver({ currentWorkspaceRoot, projectFilter, dbConfig }) {
    const resolver = Object.create(KanbanProvider.prototype);
    resolver._currentWorkspaceRoot = currentWorkspaceRoot;
    resolver._projectFilter = projectFilter;
    resolver._getKanbanDb = () => (dbConfig
        ? { getConfig: async (k) => dbConfig[k] }
        : undefined);
    return resolver;
}

async function main() {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-memo-ws-'));
    const wsA = path.join(tmpBase, 'ws-a');
    const wsB = path.join(tmpBase, 'ws-b');
    for (const r of [wsA, wsB]) {
        fs.mkdirSync(path.join(r, '.switchboard'), { recursive: true });
    }
    // KanbanDatabase refuses to auto-create (scaffold-litter protection).
    await KanbanDatabase.forWorkspace(wsB).createIfMissing();

    console.log('\n=== Memo panel workspace binding + cross-workspace PROJECT PIN guard ===\n');

    // ── 1. The panel's served root is per-render, not frozen at server start ──

    await test('the served panel HTML bakes whichever root it is handed (per-render input)', async () => {
        const a = getMemoHtml(REPO_ROOT, wsA, undefined, 'cyber-theme-enabled').html;
        const b = getMemoHtml(REPO_ROOT, wsB, undefined, 'cyber-theme-enabled').html;
        assert.ok(a.includes(`data-initial-workspace-root="${encodeURIComponent(wsA)}"`), 'ws-a root not baked');
        assert.ok(b.includes(`data-initial-workspace-root="${encodeURIComponent(wsB)}"`), 'ws-b root not baked');
        assert.ok(!b.includes(encodeURIComponent(wsA)), 'ws-b render leaked the ws-a root');
    });

    await test('_getWorkspaceRoot() follows the board, so currentWsRoot()\'s input is live', async () => {
        const { provider } = buildHeadlessTaskViewer([wsA, wsB]);
        // No kanban provider yet → falls back to roots[0].
        assert.strictEqual(provider._getWorkspaceRoot(), wsA);
        // Board switches workspace.
        provider._kanbanProvider = { getCurrentWorkspaceRoot: () => wsB };
        assert.strictEqual(provider._getWorkspaceRoot(), wsB,
            '_getWorkspaceRoot() does not follow the board selection');
    });

    await test('the panel-HTML call sites use the per-render getter, not a captured constant', async () => {
        // Source-level guard: the unfreeze lives inside _startLocalApiServer's
        // serveStatic closure, which cannot be constructed without binding a real
        // port. Restoring `const wsRoot = effectiveRoot` and re-pointing the
        // getters at it fails this assertion — that IS the frozen-closure
        // regression.
        const src = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
        assert.ok(!/const\s+wsRoot\s*=\s*effectiveRoot\s*;/.test(src),
            'the workspace root is captured once again — frozen-closure regression');
        assert.match(src, /const currentWsRoot = \(\) =>\s*\n?\s*resolveEffectiveWorkspaceRootFromMappings\(this\._getWorkspaceRoot\(\) \|\| effectiveRoot\)/,
            'currentWsRoot() getter missing or no longer routes through the mapping collapse');
        for (const call of [
            /sharedGetBoardHtml\(repoRoot, currentWsRoot\(\)/,
            /sharedGetProjectHtml\(repoRoot, currentWsRoot\(\)/,
            /sharedGetPanelHtmlById\(id, repoRoot, currentWsRoot\(\)/,
        ]) {
            assert.match(src, call, `a panel-HTML call site still passes a frozen root: ${call}`);
        }
        // staticRoutes.stitch deliberately keeps the frozen root — it is an object
        // literal evaluated once and it already unions every mapped root.
        assert.match(src, /stitch: Array\.from\(new Set\(\[effectiveRoot, \.\.\.allRoots\]/,
            'staticRoutes.stitch no longer uses the deliberately-frozen effectiveRoot');
    });

    // ── 2. The destination-workspace PROJECT PIN guard ──

    // NOTE on the discriminator: the memo prompt template ALWAYS contains the
    // literal string "PROJECT PIN" — the **Project:** instruction reads "include
    // this line ONLY if a PROJECT PIN directive is present below"
    // (TaskViewerProvider.ts, _buildMemoPlannerPrompt). So a bare /PROJECT PIN/
    // test cannot distinguish pinned from unpinned and would fail even on a
    // correctly-dropped pin. The only sound signal is PROJECT_LINE_DIRECTIVE's
    // own opening sentence (agentPromptBuilder.ts:972), appended solely when a
    // projectName survives the guard.
    const PIN_EMITTED = /PROJECT PIN: The user had the project "([^"]+)" active/;

    await test('a project that does NOT exist in the destination workspace is NOT pinned', async () => {
        const { provider, recorders } = buildHeadlessTaskViewer([wsA, wsB]);
        provider._kanbanProvider = {
            getCurrentWorkspaceRoot: () => wsA,   // board is on ws-a
            resolveEffectiveWorkspaceRoot: (r) => r,
            // The cross-workspace leak, reproduced: the other board's selection.
            resolveAuthoringProject: async () => 'Browser Switchboard',
        };
        await provider.handleServiceVerb('memoGeneratePrompt', {
            content: 'Bug: one', action: 'copy', workspaceRoot: wsB,
        });
        const prompt = recorders.clipboardWrites[recorders.clipboardWrites.length - 1] || '';
        assert.ok(prompt.includes(path.join(wsB, '.switchboard', 'plans')),
            'plansDir did not come from the destination workspace');
        assert.ok(!PIN_EMITTED.test(prompt),
            'emitted a PROJECT PIN for a project that does not exist in the destination workspace');
    });

    await test('a project that DOES exist is still pinned (the guard must not become never-pin)', async () => {
        const db = KanbanDatabase.forWorkspace(wsB);
        await db.ensureReady();
        const wsId = (await db.getWorkspaceId?.()) || (await db.getDominantWorkspaceId?.()) || '';
        assert.ok(wsId, 'destination workspace has no workspace id — harness precondition failed');
        await db.addProject(wsId, 'Real Project');

        const { provider, recorders } = buildHeadlessTaskViewer([wsA, wsB]);
        provider._kanbanProvider = {
            getCurrentWorkspaceRoot: () => wsB,
            resolveEffectiveWorkspaceRoot: (r) => r,
            resolveAuthoringProject: async () => 'Real Project',
        };
        await provider.handleServiceVerb('memoGeneratePrompt', {
            content: 'Bug: one', action: 'copy', workspaceRoot: wsB,
        });
        const prompt = recorders.clipboardWrites[recorders.clipboardWrites.length - 1] || '';
        const m = prompt.match(PIN_EMITTED);
        assert.ok(m, 'the guard dropped a VALID pin — it has degraded into never-pin');
        assert.strictEqual(m[1], 'Real Project', `pinned the wrong project: ${m[1]}`);
        assert.ok(prompt.includes('**Project:** Real Project'),
            'the directive carries no concrete **Project:** line for the importer to read');
    });

    // ── 3. The in-memory _projectFilter singleton is workspace-scoped ──
    // Assertion 3b of the plan: this is what distinguishes the fix from a plain
    // name lookup. Without it, a project that exists in BOTH workspaces would
    // still be pinned from the wrong board's selection.

    await test('_projectFilter is used when the board IS on the asked-about workspace', async () => {
        const resolver = makeProjectResolver({
            currentWorkspaceRoot: wsB, projectFilter: 'Real Project', dbConfig: null,
        });
        assert.strictEqual(await resolver.resolveAuthoringProject(wsB), 'Real Project');
    });

    await test('_projectFilter does NOT leak when the board is on ANOTHER workspace', async () => {
        const resolver = makeProjectResolver({
            currentWorkspaceRoot: wsA, projectFilter: 'Real Project', dbConfig: null,
        });
        assert.strictEqual(await resolver.resolveAuthoringProject(wsB), undefined,
            'in-memory _projectFilter leaked across workspaces');
    });

    await test('a trailing-slash / unnormalised root still counts as the SAME workspace', async () => {
        // The superseded raw-string comparison would have taken the
        // "different workspace" branch here and silently dropped a valid pin.
        const resolver = makeProjectResolver({
            currentWorkspaceRoot: wsB + path.sep, projectFilter: 'Real Project', dbConfig: null,
        });
        assert.strictEqual(await resolver.resolveAuthoringProject(wsB), 'Real Project',
            'path comparison is not normalised — a valid pin is dropped');
    });

    await test('an unopened board (_currentWorkspaceRoot === null) never matches', async () => {
        const resolver = makeProjectResolver({
            currentWorkspaceRoot: null, projectFilter: 'Real Project', dbConfig: null,
        });
        assert.strictEqual(await resolver.resolveAuthoringProject(wsB), undefined);
    });

    await test('the per-workspace DB value still wins over the in-memory singleton', async () => {
        const resolver = makeProjectResolver({
            currentWorkspaceRoot: wsB,
            projectFilter: 'Real Project',
            dbConfig: { 'kanban.activeProjectFilter': 'From DB' },
        });
        assert.strictEqual(await resolver.resolveAuthoringProject(wsB), 'From DB');
    });

    // ── 4. memo.js posts the LIVE root ──

    await test('memo.js sends the live root, not the load-time constant', async () => {
        const memoJs = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'memo.js'), 'utf8');
        assert.match(memoJs, /case 'workspaceChanged'/, 'memo.js does not handle workspaceChanged');
        assert.ok(!/workspaceRoot:\s*WS_ROOT/.test(memoJs),
            'memo.js still posts the load-time WS_ROOT after a workspace switch');
        // All five payload sites must read the mutable owner.
        const liveSites = (memoJs.match(/workspaceRoot:\s*_wsRoot/g) || []).length;
        assert.ok(liveSites >= 5, `only ${liveSites} of 5 postMessage sites read _wsRoot`);
        // The clear-timer-then-reassign order is load-bearing: reassigning first
        // lets a pending 800ms debounce write the OLD workspace's text to the NEW
        // root. Assert the clear precedes the reassignment inside the handler.
        const handler = memoJs.slice(memoJs.indexOf("case 'workspaceChanged'"));
        const body = handler.slice(0, handler.indexOf('break;'));
        const clearIdx = body.indexOf('clearTimeout(_memoSaveTimer)');
        const assignIdx = body.indexOf('_wsRoot = msg.workspaceRoot');
        assert.ok(clearIdx !== -1 && assignIdx !== -1, 'workspaceChanged handler is missing its guard or its reassignment');
        assert.ok(clearIdx < assignIdx,
            'the pending save is cancelled AFTER the root is reassigned — the debounce data-loss window is open');
        assert.match(body, /_submittedContent = null/,
            'an in-flight memoPromptResult from the previous workspace can still clear the new memo');
    });

    // Cleanup: close the DB handle before removing the tree.
    try { await KanbanDatabase.forWorkspace(wsB).close?.(); } catch { /* best effort */ }
    try { fs.rmSync(tmpBase, { recursive: true, force: true }); } catch { /* best effort */ }

    console.log(`\n${passed} passed, ${failed} failed\n`);
    if (failed === 0) console.log('memo-panel-workspace-binding-contract: OK');
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
