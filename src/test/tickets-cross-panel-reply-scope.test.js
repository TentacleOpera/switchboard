/**
 * Cross-panel Tickets reply contamination — regression test.
 *
 * `TicketsPanelProvider.postMessageToWebview` routes through BroadcastHub → wsHub,
 * which fans every push out to EVERY connected Tickets surface (the bound editor
 * webview plus all browser tabs). There is no addressing: a reply generated for
 * panel B is delivered verbatim to panel A. Verified 2026-08-05 with a probe socket —
 * a panel showing a 3-ticket list received a foreign 67-ticket `localTicketFilesListed`
 * with no `listId` and no `workspaceRoot`, i.e. nothing it could filter on. The
 * receiving handler consumed it and overwrote `clickUpProjectIssues`: the reported
 * "sidebar flashes with a lot of stuff and then disappears".
 *
 * The fix is stamp-and-filter: replies carry the identity of the request that produced
 * them (`workspaceRoot` + `scopeId`), and `_isForThisPanel` in tickets.js drops any
 * reply naming a scope other than the one this panel shows. This test pins BOTH
 * halves — the backend stamp and the frontend predicate. Dropping either half
 * reintroduces the exact same symptom, so neither may regress alone.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const TICKETS_JS = path.join(__dirname, '..', 'webview', 'tickets.js');
const PROVIDER_TS = path.join(__dirname, '..', 'services', 'TicketsPanelProvider.ts');

const ticketsJs = fs.readFileSync(TICKETS_JS, 'utf8');
const providerTs = fs.readFileSync(PROVIDER_TS, 'utf8');

let passed = 0;
const failures = [];

function check(name, fn) {
    try { fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (err) { failures.push({ name, err }); console.log(`  ❌ ${name}\n     ${err && err.message}`); }
}

/** Extract a top-level `function name(...) { ... }` body by brace matching. */
function extractFunction(src, signature) {
    const start = src.indexOf(signature);
    assert.notStrictEqual(start, -1, `${signature} must exist`);
    let i = src.indexOf('{', start);
    assert.notStrictEqual(i, -1, `${signature} must have a body`);
    let depth = 0;
    for (; i < src.length; i++) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '/') { i = src.indexOf('\n', i); continue; }
        if (ch === '{') { depth++; }
        else if (ch === '}') { depth--; if (depth === 0) { return src.slice(start, i + 1); } }
    }
    throw new Error(`unbalanced braces in ${signature}`);
}

/**
 * Instantiate the real `_isForThisPanel` source with the panel-state globals it closes
 * over supplied as parameters. Testing the shipped source (rather than a copy) is the
 * point: a predicate rewritten in the test would pass while the panel stayed broken.
 */
const predicateSrc = extractFunction(ticketsJs, 'function _isForThisPanel(message)');
const makePredicate = (state) => new Function(
    'lastIntegrationProvider', 'ticketsWorkspaceRoot', 'clickUpSelectedListId',
    `${predicateSrc}\nreturn _isForThisPanel;`
)(state.provider || '', state.workspaceRoot || '', state.listId || '');

const CLICKUP_PANEL = { provider: 'clickup', workspaceRoot: '/ws/a', listId: 'L1' };
const LINEAR_PANEL = { provider: 'linear', workspaceRoot: '/ws/a', listId: '' };

console.log('── _isForThisPanel: the predicate that rejects foreign replies ──');

check('matching scope → accept', () => {
    const p = makePredicate(CLICKUP_PANEL);
    assert.strictEqual(p({ type: 'localTicketFilesListed', provider: 'clickup', workspaceRoot: '/ws/a', scopeId: 'L1' }), true);
});

check('foreign scope → reject (the 67-ticket payload)', () => {
    const p = makePredicate(CLICKUP_PANEL);
    assert.strictEqual(p({ type: 'localTicketFilesListed', provider: 'clickup', workspaceRoot: '/ws/a', scopeId: 'L9' }), false);
});

check('unscopedPlaceholder → accept (locally synthesised, never crosses the wire)', () => {
    const p = makePredicate(CLICKUP_PANEL);
    assert.strictEqual(p({ type: 'localTicketFilesListed', provider: 'clickup', unscopedPlaceholder: true }), true);
});

check('no scope selected → accept (nothing to protect)', () => {
    const p = makePredicate({ ...CLICKUP_PANEL, listId: '' });
    assert.strictEqual(p({ type: 'localTicketFilesListed', provider: 'clickup', workspaceRoot: '/ws/a', scopeId: 'L9' }), true);
});

check('reply names no scope while this panel has one → reject', () => {
    // The early-return arms (no workspace / setup-required / no list) push status:'error'
    // with no resolvable listId. Accepting a foreign one replaces a healthy sidebar with
    // an error message, so "no scope id" must lose to "I have one selected".
    const p = makePredicate(CLICKUP_PANEL);
    assert.strictEqual(p({ type: 'clickupProjectLoaded', status: 'error', workspaceRoot: '/ws/a' }), false);
});

check('explicit provider mismatch → reject', () => {
    const p = makePredicate(CLICKUP_PANEL);
    assert.strictEqual(p({ type: 'localTicketFilesListed', provider: 'linear', workspaceRoot: '/ws/a' }), false);
});

check('provider inferred from the message TYPE → reject a clickup reply at a Linear panel', () => {
    // clickupProjectLoaded / clickupError / linearProjectLoaded carry no `provider`
    // field, so a predicate reading only message.provider is inert for exactly the arms
    // that need it — the reply would reach the Linear early-accept and be applied.
    const p = makePredicate(LINEAR_PANEL);
    assert.strictEqual(p({ type: 'clickupProjectLoaded', workspaceRoot: '/ws/a', scopeId: 'L1' }), false);
    assert.strictEqual(p({ type: 'clickupError', scope: 'project', workspaceRoot: '/ws/a', scopeId: 'L1' }), false);
});

check('workspaceRoot mismatch → reject (same list id in two workspaces)', () => {
    const p = makePredicate(CLICKUP_PANEL);
    assert.strictEqual(p({ type: 'localTicketFilesListed', provider: 'clickup', workspaceRoot: '/ws/b', scopeId: 'L1' }), false);
});

check('Linear, same workspace → accept (no server-side project scope exists)', () => {
    // linearLoadProject loads ALL team issues; projectName is a display string and
    // linearProjectPickerValue is a client-side filter. Comparing either against a
    // scopeId would make the panel reject its own reply and go blank.
    const p = makePredicate(LINEAR_PANEL);
    assert.strictEqual(p({ type: 'linearProjectLoaded', status: 'loaded', workspaceRoot: '/ws/a' }), true);
});

check('Linear, different workspace → reject', () => {
    const p = makePredicate(LINEAR_PANEL);
    assert.strictEqual(p({ type: 'linearProjectLoaded', status: 'loaded', workspaceRoot: '/ws/b' }), false);
});

check('listId / projectId are honoured when scopeId is absent', () => {
    // clickupListStatusesLoaded and importAllTicketsComplete already carried equivalent
    // fields and are deliberately NOT re-stamped, so the predicate must read them.
    const p = makePredicate(CLICKUP_PANEL);
    assert.strictEqual(p({ type: 'clickupListStatusesLoaded', workspaceRoot: '/ws/a', listId: 'L1' }), true);
    assert.strictEqual(p({ type: 'clickupListStatusesLoaded', workspaceRoot: '/ws/a', listId: 'L9' }), false);
    assert.strictEqual(p({ type: 'importAllTicketsComplete', provider: 'clickup', workspaceRoot: '/ws/a', listId: 'L1' }), true);
    assert.strictEqual(p({ type: 'importAllTicketsComplete', provider: 'clickup', workspaceRoot: '/ws/a', listId: 'L9' }), false);
});

check('numeric list ids compare by value, not identity', () => {
    const p = makePredicate(CLICKUP_PANEL);
    assert.strictEqual(p({ type: 'clickupListStatusesLoaded', workspaceRoot: '/ws/a', listId: 'L1' }), true);
    const numeric = makePredicate({ ...CLICKUP_PANEL, listId: '901615209243' });
    assert.strictEqual(numeric({ type: 'clickupListStatusesLoaded', workspaceRoot: '/ws/a', listId: 901615209243 }), true);
});

console.log('── every guarded arm actually calls the predicate ──');

for (const arm of [
    'localTicketFilesListed', 'clickupProjectLoaded', 'linearProjectLoaded',
    'ticketSyncStatusesLoaded', 'clickupListStatusesLoaded', 'importAllTicketsComplete'
]) {
    check(`case '${arm}' rejects foreign replies`, () => {
        const i = ticketsJs.indexOf(`case '${arm}':`);
        assert.notStrictEqual(i, -1, `case '${arm}' must exist in tickets.js`);
        assert.match(
            ticketsJs.slice(i, i + 200),
            /if\s*\(!_isForThisPanel\(message\)\)\s*\{\s*break;\s*\}/,
            `case '${arm}' must open with the _isForThisPanel guard — a missed arm is a live ` +
            `contamination path that reproduces the identical symptom`
        );
    });
}

for (const arm of ['clickupError', 'linearError']) {
    check(`case '${arm}' rejects foreign project-scope errors`, () => {
        const i = ticketsJs.indexOf(`case '${arm}':`);
        assert.notStrictEqual(i, -1, `case '${arm}' must exist in tickets.js`);
        assert.match(
            ticketsJs.slice(i, i + 400),
            /if\s*\(message\.scope\s*===\s*'project'\s*&&\s*!_isForThisPanel\(message\)\)\s*\{\s*break;\s*\}/,
            `case '${arm}' must reject foreign project-scope errors — an unstamped error from ` +
            `another panel replaces a healthy sidebar with an error message`
        );
    });
}

console.log('── backend: scope-bearing replies are stamped ──');

check('_scoped helper exists and stamps both fields', () => {
    assert.match(
        providerTs,
        /private _scoped\(res: any, workspaceRoot: string \| null, scopeId\?: string\): any \{\s*return \{ \.\.\.res, workspaceRoot: workspaceRoot \?\? undefined, scopeId: scopeId \?\? undefined \};/,
        'TicketsPanelProvider._scoped must stamp workspaceRoot and scopeId, coercing absent values to undefined'
    );
});

check('every clickupProjectLoaded arm is stamped, including the early returns', () => {
    const stamped = providerTs.match(/this\._scoped\(\{\s*\n?\s*type: 'clickupProjectLoaded'/g) || [];
    assert.strictEqual(
        stamped.length, 4,
        'all four clickupProjectLoaded arms (no workspace, setup incomplete, no list, success) must be stamped'
    );
});

check('localTicketFilesListed is stamped on both the early-return and success arms', () => {
    const stamped = providerTs.match(/this\._scoped\(\{ type: 'localTicketFilesListed'/g) || [];
    assert.strictEqual(stamped.length, 2, 'both localTicketFilesListed reply sites must be stamped');
});

check('ticketSyncStatusesLoaded is stamped and takes its scope id from the verb', () => {
    const stamped = providerTs.match(/this\._scoped\(\{ type: 'ticketSyncStatusesLoaded'/g) || [];
    assert.strictEqual(stamped.length, 3, 'all three ticketSyncStatusesLoaded return sites must be stamped');
    assert.match(
        providerTs,
        /const syncScopeId = provider === 'clickup'\s*\n\s*\? String\(\(msg\.listId as string\) \|\| ''\)\.trim\(\) \|\| undefined/,
        'getTicketSyncStatuses has no scope id of its own — it must read the one the frontend sends'
    );
    const requestFn = extractFunction(ticketsJs, 'function _requestTicketSyncStatuses()');
    assert.match(requestFn, /type: 'getTicketSyncStatuses'/, '_requestTicketSyncStatuses must post the verb');
    assert.match(
        requestFn,
        /listId: lastIntegrationProvider === 'clickup' \? \(clickUpSelectedListId \|\| undefined\) : undefined/,
        '_requestTicketSyncStatuses must pass listId so the backend can stamp the reply'
    );
    assert.match(
        requestFn,
        /projectId: lastIntegrationProvider === 'linear' \? \(linearProjectPickerValue \|\| undefined\) : undefined/,
        '_requestTicketSyncStatuses must pass projectId for the Linear stamp'
    );
});

check('clickupError scope:project is stamped with the listId', () => {
    assert.match(
        providerTs,
        /this\._scoped\(\{\s*\n?\s*type: 'clickupError',\s*\n?\s*scope: 'project'/,
        "the clickupError scope:'project' arm must be stamped"
    );
});

check('the getTicketSyncStatuses schema accepts the scope id (HTTP boundary)', () => {
    // Schemas are validated at the HTTP boundary; a field the frontend sends but the
    // schema omits is a rejected-payload regression on shipped installs.
    const schemas = fs.readFileSync(path.join(__dirname, '..', 'services', 'verbSchemas.ts'), 'utf8');
    const i = schemas.indexOf('    getTicketSyncStatuses: {');
    assert.notStrictEqual(i, -1, 'getTicketSyncStatuses must have a schema');
    const body = schemas.slice(i, schemas.indexOf('\n    },', i));
    assert.match(body, /listId:\s*\{/, 'the schema must accept listId');
    assert.match(body, /projectId:\s*\{/, 'the schema must accept projectId');
});

check('ticketFileChanged is neither stamped nor filtered', () => {
    // It is a file-watcher EVENT, not a reply to a verb, and it SHOULD reach every panel.
    assert.ok(
        !/this\._scoped\(\{[^}]*type: 'ticketFileChanged'/.test(providerTs),
        'ticketFileChanged must not be stamped — it is an event, not a reply'
    );
    const i = ticketsJs.indexOf("case 'ticketFileChanged':");
    assert.notStrictEqual(i, -1, "case 'ticketFileChanged' must exist");
    assert.ok(
        !/_isForThisPanel/.test(ticketsJs.slice(i, i + 200)),
        'ticketFileChanged must not be filtered — every panel should react to a file change'
    );
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
    for (const f of failures) { console.error(`\n--- ${f.name} ---\n`, f.err); }
    process.exit(1);
}
