'use strict';

/**
 * Contract: standing orders are written to, and read from, ONE root per
 * extension-host lifetime — the latched fleet root (`_apiServerWorkspaceRoot`).
 *
 * The defect this pins: the orders write followed the *spawn* root (or, on the
 * `ptyCreateTerminal` create path, a *caller-supplied* `workspaceRoot`) while
 * every delivery chokepoint read `_apiServerWorkspaceRoot`. In a multi-root
 * window those are different directories, so `selectOrders` matched nothing and
 * every team prompt reached its seat bare — with `wireSpawnedTeam` returning
 * `{ ok: true }`, because it *had* written successfully, just somewhere nothing
 * reads. Every gate stayed green.
 *
 * These are mostly source-shape assertions, and deliberately so: the divergence
 * is INVISIBLE at runtime in a single-root workspace, which is the only kind of
 * workspace CI has. A behavioural test on this path would pass on the broken
 * code. What can be executed for real is executed for real — the zero-match
 * diagnostic at the bottom is transpiled and run.
 *
 * Run with:
 *   node --require ./src/test/bootstrap/sandboxStateHome.js src/test/standing-orders-fleet-root-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const TASK_VIEWER_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'TaskViewerProvider.ts'), 'utf8'
);
const LOCAL_API_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'LocalApiServer.ts'), 'utf8'
);
const STANDING_ORDERS_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'standingOrders.ts'), 'utf8'
);
const AGENT_GROUP_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'services', 'agentGroupInstantiation.ts'), 'utf8'
);
const BOOTSTRAP_SRC = fs.readFileSync(
    path.join(__dirname, '..', 'standalone', 'bootstrap.ts'), 'utf8'
);

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`); passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

/**
 * Slice the body of a method declared as `<decl>` up to the next declaration at
 * the same brace depth. Cheap but sufficient: every assertion below anchors on a
 * literal that occurs once inside the slice.
 */
function methodBody(src, decl, span) {
    const i = src.indexOf(decl);
    assert.ok(i > 0, `declaration not found: ${decl}`);
    return src.slice(i, i + span);
}

console.log('\n--- the latch: one fleet root per extension-host lifetime ---');

// The field is a snapshot of the board's active selection at API-server-start
// time, and _startLocalApiServer is re-entrant BY DESIGN — the liveness watchdog
// calls it again on every failed health check. Unlatched, a watchdog restart
// after a workspace switch relocates the orders store out from under a running
// fleet, reproducing the wrong-DB defect with no team start involved.
test('_apiServerWorkspaceRoot has exactly ONE assignment site', () => {
    const assignments = TASK_VIEWER_SRC.match(/this\._apiServerWorkspaceRoot\s*=/g) || [];
    assert.strictEqual(
        assignments.length, 1,
        `Expected exactly 1 assignment to _apiServerWorkspaceRoot, found ${assignments.length}. `
        + 'A second writer (a reset path, a workspace-switch handler) un-pins the fleet root '
        + 'and re-opens the defect from a direction no team start passes through.'
    );
});

test('the assignment is guarded by a falsy check on the field itself (latched, not re-derived)', () => {
    const i = TASK_VIEWER_SRC.indexOf('this._apiServerWorkspaceRoot =');
    assert.ok(i > 0, 'assignment not found');
    // Look back far enough to catch the guard on the preceding line(s).
    const before = TASK_VIEWER_SRC.slice(Math.max(0, i - 400), i);
    assert.ok(
        /if\s*\(\s*!\s*this\._apiServerWorkspaceRoot\s*\)/.test(before),
        'The assignment must sit inside `if (!this._apiServerWorkspaceRoot)`. An unguarded '
        + 'assignment makes the "fleet root" follow the board wherever it has been switched '
        + 'to by the time the watchdog restarts the server.'
    );
});

test('the latch sits in _startLocalApiServer, after effectiveRoot is resolved', () => {
    const body = methodBody(TASK_VIEWER_SRC, 'private async _startLocalApiServer(', 2000);
    const rootIdx = body.indexOf('const effectiveRoot = resolveEffectiveWorkspaceRootFromMappings(');
    const latchIdx = body.indexOf('if (!this._apiServerWorkspaceRoot)');
    assert.ok(rootIdx > 0, 'effectiveRoot resolution not found in _startLocalApiServer');
    assert.ok(latchIdx > rootIdx, 'the latch must follow the effectiveRoot resolution it stores');
});

test('LocalApiServer still receives the PER-INSTANCE effectiveRoot as workspaceRoot', () => {
    const body = methodBody(TASK_VIEWER_SRC, 'this._localApiServer = new LocalApiServer({', 600);
    assert.ok(
        /workspaceRoot:\s*effectiveRoot,/.test(body),
        'Route DB resolution must keep following the board (`effectiveRoot`). Handing the '
        + 'latched field here would freeze every route to the first-started root, which is a '
        + 'much larger behaviour change than this plan owns.'
    );
});

console.log('\n--- instantiateAgentGroup: two roots, one function ---');

// Spawn cwd and fleet root are DIFFERENT concerns: the cwd may legitimately be a
// worktree or a sibling repo, the orders root may not vary at all.
test('instantiateAgentGroup resolves a distinct wiringDb from _apiServerWorkspaceRoot', () => {
    const body = methodBody(TASK_VIEWER_SRC, 'public async instantiateAgentGroup(group: any, workspaceRoot: string)', 4200);
    assert.ok(
        /const wiringDb = await this\._getKanbanDb\(this\._apiServerWorkspaceRoot \|\| resolvedRoot\);/.test(body),
        'instantiateAgentGroup must resolve `wiringDb` from `this._apiServerWorkspaceRoot || resolvedRoot`.'
    );
    // The `|| resolvedRoot` fallback is load-bearing: a host that never started
    // the API server (suppressLocalApiServer, standalone-in-extension) leaves the
    // field unset, and must keep today's behaviour rather than failing to wire.
    assert.ok(
        /_apiServerWorkspaceRoot \|\| resolvedRoot/.test(body),
        'the wiring DB must fall back to the spawn root when _apiServerWorkspaceRoot is unset'
    );
});

test('the spawn cwd still comes from the workspaceRoot ARGUMENT, not the fleet root', () => {
    const body = methodBody(TASK_VIEWER_SRC, 'public async instantiateAgentGroup(group: any, workspaceRoot: string)', 4200);
    assert.ok(
        /const resolvedRoot = this\._resolveWorkspaceRoot\(workspaceRoot\);/.test(body),
        'resolvedRoot must still derive from the workspaceRoot argument'
    );
    assert.ok(
        /cwd:\s*resolvedRoot,/.test(body),
        'the core must still be given `cwd: resolvedRoot` — repointing the cwd at the fleet '
        + 'root would spawn worktree teams in the wrong directory.'
    );
    assert.ok(
        !/cwd:\s*wiringDb/.test(body) && !/cwd:\s*this\._apiServerWorkspaceRoot/.test(body),
        'the spawn cwd must never be derived from the fleet root'
    );
});

test('a bad FLEET-root handle fails the start even when the spawn-root handle is fine', () => {
    const body = methodBody(TASK_VIEWER_SRC, 'public async instantiateAgentGroup(group: any, workspaceRoot: string)', 4200);
    const guard = /if\s*\(!wiringDb \|\| !\(await wiringDb\.ensureReady\(\)\)\)\s*\{\s*return \{ success: false, error: 'Kanban DB not ready' \};/;
    assert.ok(
        guard.test(body),
        "wiringDb must carry its own `Kanban DB not ready` guard. Without it a team whose orders "
        + 'cannot be installed reports a clean start — which is precisely how this defect survived '
        + 'a full feature cycle.'
    );
    const guardIdx = body.search(guard);
    const coreIdx = body.indexOf('return instantiateAgentGroupCore({');
    assert.ok(guardIdx > 0 && coreIdx > guardIdx, 'the guard must precede the core call');
});

test('the pre-existing db local is left alone for its mirror-registry consumer', () => {
    const body = methodBody(TASK_VIEWER_SRC, 'public async instantiateAgentGroup(group: any, workspaceRoot: string)', 4200);
    assert.ok(
        /const db = await this\._getKanbanDb\(resolvedRoot\);/.test(body),
        '`db` must still resolve from resolvedRoot'
    );
    assert.ok(
        /_updatePtyMirrorRegistry\?\.\(db\)/.test(body),
        'onCreated must still hand the SPAWN-root db to _updatePtyMirrorRegistry — the mirror '
        + 'registry is unrelated state and repointing it at the fleet root is out of scope.'
    );
    assert.ok(
        /db:\s*wiringDb,/.test(body),
        'instantiateAgentGroupCore must be given `db: wiringDb`'
    );
});

test('instantiateAgentGroupCore uses its db ONLY as the wiring handle', () => {
    // If the core ever grows a third consumer of `db`, the substitution above
    // stops being complete and silently relocates that consumer's state too.
    const start = AGENT_GROUP_SRC.indexOf('export async function instantiateAgentGroupCore(');
    assert.ok(start > 0, 'instantiateAgentGroupCore not found');
    const next = AGENT_GROUP_SRC.indexOf('\nexport ', start + 1);
    const body = AGENT_GROUP_SRC.slice(start, next > 0 ? next : undefined);
    const uses = body.match(/(?<![A-Za-z0-9_.$])db(?![A-Za-z0-9_$])/g) || [];
    assert.strictEqual(
        uses.length, 3,
        `instantiateAgentGroupCore references \`db\` ${uses.length} times; expected exactly 3 — the `
        + 'destructure, the `!db` guard, and the wireSpawnedTeam call. A new consumer means the '
        + 'fleet-root substitution is no longer complete: that consumer just moved roots too.'
    );
    assert.ok(/wireSpawnedTeam\(\{ db,/.test(body), 'the core must pass its db to wireSpawnedTeam');
});

console.log('\n--- both extension-host order writers agree on the fleet root ---');

// Changing one writer and not the other is STRICTLY WORSE than the original
// single wrong root: the fleet's orders then live in two DBs depending on how
// each team happened to be started, and it is invisible in a single-root window.
test('the ptyCreateTerminal create block wires through a fleet-root handle', () => {
    const i = TASK_VIEWER_SRC.indexOf("if (verb === 'ptyCreateTerminal' && result && result.success !== false");
    assert.ok(i > 0, 'ptyCreateTerminal wiring branch not found');
    const branch = TASK_VIEWER_SRC.slice(i, i + 2600);
    assert.ok(
        /const wiringDb = await this\._getKanbanDb\(this\._apiServerWorkspaceRoot \|\| effectiveRoot\);/.test(branch),
        'the create block must resolve `wiringDb` from `this._apiServerWorkspaceRoot || effectiveRoot`'
    );
    assert.ok(
        /wireSpawnedTeam\(\{ db: wiringDb,/.test(branch),
        'the create block must pass wiringDb into wireSpawnedTeam'
    );
});

test('NEITHER writer lets a caller-supplied root steer where orders land', () => {
    // `handlePtyVerb(verb, payload, root?, signal?)` — `root` is the wire caller's
    // workspaceRoot. The rename rewrite already refuses to let it steer a rewrite;
    // the wiring call three lines below it must refuse the same way.
    const sites = TASK_VIEWER_SRC.match(/const wiringDb = await this\._getKanbanDb\([^)]*\);/g) || [];
    assert.ok(sites.length >= 2, `expected at least 2 wiringDb resolutions, found ${sites.length}`);
    for (const site of sites) {
        assert.ok(
            /_apiServerWorkspaceRoot/.test(site),
            `a wiringDb resolution does not consult the fleet root: ${site}`
        );
        assert.ok(
            !/\|\|\s*root\b/.test(site),
            `a wiringDb resolution accepts a caller-supplied root: ${site}`
        );
    }
});

test('the rename rewrite still resolves against the fleet root first', () => {
    assert.ok(
        /const ordersDb = await this\._getKanbanDb\(this\._apiServerWorkspaceRoot \|\| root \|\| effectiveRoot\);/
            .test(TASK_VIEWER_SRC),
        'rewriteStandingOrdersForRename must keep reading the fleet root — a rewrite in the wrong '
        + 'DB orphans the order it was meant to re-key.'
    );
});

test('the standalone host stays single-root and says so at its wiring call', () => {
    const i = BOOTSTRAP_SRC.indexOf('const wired = await wireSpawnedTeam({ db,');
    assert.ok(i > 0, 'bootstrap wireSpawnedTeam call not found');
    const before = BOOTSTRAP_SRC.slice(Math.max(0, i - 600), i);
    assert.ok(
        /exactly one workspace root/.test(before),
        'the standalone wiring call must carry the one-root note. Without it a future multi-root '
        + 'standalone re-acquires this bug invisibly.'
    );
    assert.ok(
        !/_apiServerWorkspaceRoot\s*=/.test(BOOTSTRAP_SRC),
        'bootstrap must NOT invent a second root concept in a single-root host'
    );
});

console.log('\n--- the editor surface reads the same root delivery does ---');

// GET/POST /terminals/standing-orders are the fourth reader and the fifth and
// sixth writers of the orders store. `_options.workspaceRoot` is re-derived on
// every watchdog restart; the latched field is not. Left on the former, the
// editor lists orders that are not in force and writes orders never delivered.
test('both standing-orders handlers resolve the FLEET-root DB', () => {
    for (const decl of ['private async _handleStandingOrdersList(', 'private async _handleStandingOrdersWrite(']) {
        const body = methodBody(LOCAL_API_SRC, decl, 1200);
        assert.ok(
            /const db = await this\._resolveFleetOrdersDb\(\);/.test(body),
            `${decl} must resolve its DB via _resolveFleetOrdersDb(), not _resolveDbForRoot()`
        );
    }
});

test('_resolveFleetOrdersDb falls back to _resolveDbForRoot when no accessor is supplied', () => {
    const body = methodBody(LOCAL_API_SRC, 'private async _resolveFleetOrdersDb(', 600);
    assert.ok(/this\._options\.getFleetOrdersDatabase/.test(body), 'must consult the option');
    assert.ok(
        /return await this\._resolveDbForRoot\(\);/.test(body),
        'must fall back to _resolveDbForRoot() — the standalone host and headless harnesses '
        + 'supply no accessor and must keep working unchanged'
    );
});

test('the extension host supplies the accessor from the latched field', () => {
    const body = methodBody(TASK_VIEWER_SRC, 'this._localApiServer = new LocalApiServer({', 2000);
    assert.ok(
        /getFleetOrdersDatabase:\s*async \(\) => this\._getKanbanDb\(this\._apiServerWorkspaceRoot \|\| effectiveRoot\),/
            .test(body),
        'TaskViewerProvider must pass getFleetOrdersDatabase resolved from _apiServerWorkspaceRoot'
    );
});

test('every delivery chokepoint reader still consults the latched field first', () => {
    const readers = TASK_VIEWER_SRC.match(/this\._apiServerWorkspaceRoot \|\| /g) || [];
    assert.ok(
        readers.length >= 5,
        `Expected at least 5 fleet-root resolutions (PTY chokepoint, VS Code path, rename rewrite, `
        + `both wiring sites, the route accessor); found ${readers.length}.`
    );
});

console.log('\n--- zero-match diagnostic (executed, not scanned) ---');

const tsc = require('typescript');
const mod = { exports: {} };
new Function('exports', 'module', 'require', tsc.transpileModule(STANDING_ORDERS_SRC, {
    compilerOptions: { module: tsc.ModuleKind.CommonJS, target: tsc.ScriptTarget.ES2020 }
}).outputText)(mod.exports, mod, require);
const { applyStandingOrders } = mod.exports;

const SECRET = 'operator-authored prose that must never reach a log';
/** Capture console.warn for one call. */
function withWarn(fn) {
    const original = console.warn;
    const calls = [];
    console.warn = (...args) => { calls.push(args); };
    try { fn(); } finally { console.warn = original; }
    return calls;
}

test('a group member matching zero orders warns once', () => {
    const groups = [{ id: 'team_lead_1', name: 'Lead', members: ['lead-1', 'lead-1-intern'] }];
    // Orders naming terminals that do not exist — the wrong-DB signature.
    const orders = [
        { id: 'o1', parent: 'Phantom-coder-1', child: 'Phantom', instruction: SECRET, createdAt: 0 },
    ];
    const calls = withWarn(() => {
        applyStandingOrders('hello', 'lead-1-intern', orders, new Set(['lead-1', 'lead-1-intern']), groups);
    });
    assert.strictEqual(calls.length, 1, 'exactly one warn expected');
    const text = JSON.stringify(calls[0]);
    assert.ok(/lead-1-intern/.test(text), 'the warn must name the target');
    assert.ok(/\b1\b/.test(text), 'the warn must state how many orders were considered');
    assert.ok(/Phantom-coder-1/.test(text) && /Phantom/.test(text), 'the warn must name the rejected order');
    assert.ok(/pair/.test(text), 'the warn must state each rejected order scope');
});

test('the warn never contains an instruction body', () => {
    const groups = [{ id: 'g', name: 'g', members: ['seat-1'] }];
    const orders = [{ id: 'o1', parent: 'other', child: 'other-child', instruction: SECRET, createdAt: 0 }];
    const calls = withWarn(() => {
        applyStandingOrders('hello', 'seat-1', orders, new Set(['seat-1']), groups);
    });
    assert.strictEqual(calls.length, 1);
    assert.ok(
        !JSON.stringify(calls[0]).includes('operator-authored'),
        'instruction bodies carry operator prose and must never be logged'
    );
});

test('a terminal in NO group stays quiet', () => {
    const groups = [{ id: 'g', name: 'g', members: ['someone-else'] }];
    const orders = [{ id: 'o1', parent: 'other', child: 'other-child', instruction: SECRET, createdAt: 0 }];
    const calls = withWarn(() => {
        applyStandingOrders('hello', 'ungrouped-1', orders, new Set(['ungrouped-1']), groups);
    });
    assert.strictEqual(calls.length, 0, 'a standalone terminal with no orders is normal — no noise');
});

test('empty groups stay quiet', () => {
    const calls = withWarn(() => {
        applyStandingOrders('hello', 'seat-1', [], new Set(['seat-1']), []);
    });
    assert.strictEqual(calls.length, 0);
});

test('a member that DOES match an order does not warn', () => {
    const groups = [{ id: 'g', name: 'g', members: ['head', 'seat-1'] }];
    const orders = [{ id: 'o1', parent: 'seat-1', child: 'head', instruction: 'report to head', createdAt: 0 }];
    let out;
    const calls = withWarn(() => {
        out = applyStandingOrders('hello', 'seat-1', orders, new Set(['head', 'seat-1']), groups);
    });
    assert.strictEqual(calls.length, 0, 'a matched order must not warn');
    assert.ok(out.includes('report to head'), 'and the order must still be delivered');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
