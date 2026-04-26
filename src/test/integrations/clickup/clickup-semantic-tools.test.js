'use strict';

// Unit tests for the ClickUp semantic-tool helper layer added by
// improve_clickup_api_tool.md. Exercises the exported `_testing` helpers
// directly against a scratch workspace so the assertions are on real
// behavior, not on JSON-write/JSON-read round trips.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

function withScratchWorkspace(name, run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), `clickup-semantic-${name}-`));
    const realRoot = fs.realpathSync(root);
    const prevWs = process.env.SWITCHBOARD_WORKSPACE_ROOT;
    const prevState = process.env.SWITCHBOARD_STATE_ROOT;
    process.env.SWITCHBOARD_WORKSPACE_ROOT = realRoot;
    process.env.SWITCHBOARD_STATE_ROOT = realRoot;
    // Invalidate the cached require so register-tools.js re-reads env when
    // its state-root resolution runs.
    const registerToolsPath = require.resolve('../../../mcp-server/register-tools.js');
    delete require.cache[registerToolsPath];
    try {
        return run(realRoot);
    } finally {
        if (prevWs === undefined) { delete process.env.SWITCHBOARD_WORKSPACE_ROOT; }
        else { process.env.SWITCHBOARD_WORKSPACE_ROOT = prevWs; }
        if (prevState === undefined) { delete process.env.SWITCHBOARD_STATE_ROOT; }
        else { process.env.SWITCHBOARD_STATE_ROOT = prevState; }
        fs.rmSync(realRoot, { recursive: true, force: true });
    }
}

function loadTesting() {
    return require('../../../mcp-server/register-tools.js')._testing;
}

// ── Cache writes populate byName ─────────────────────────────────
function testCacheExtractsNestedListsFromFolder() {
    withScratchWorkspace('cache-folder', (root) => {
        const t = loadTesting();
        t.cacheClickUpState({
            id: 'folder-1',
            name: 'Engineering',
            lists: [
                { id: 'list-1', name: 'Bugs' },
                { id: 'list-2', name: 'Features' }
            ]
        });
        const raw = JSON.parse(fs.readFileSync(path.join(root, 'api_state.json'), 'utf8'));
        assert.strictEqual(raw.clickup.byName.folders['engineering'].id, 'folder-1');
        assert.strictEqual(raw.clickup.byName.lists['bugs'].id, 'list-1');
        assert.strictEqual(raw.clickup.byName.lists['features'].id, 'list-2');
        assert.ok(raw.clickup.byName.lists['bugs'].cachedAt);
    });
}

// ── TTL boundary: stale entries excluded from resolution ─────────
function testTtlBoundary() {
    withScratchWorkspace('ttl', (root) => {
        const t = loadTesting();
        const stale = Date.now() - (t.CLICKUP_NAME_CACHE_TTL_LIST_DOC_MS + 60_000);
        const fresh = Date.now();
        fs.mkdirSync(root, { recursive: true });
        fs.writeFileSync(path.join(root, 'api_state.json'), JSON.stringify({
            linear: {},
            clickup: {
                byName: {
                    lists:   { 'stale-list': { id: 'L-stale', cachedAt: stale }, 'fresh-list': { id: 'L-fresh', cachedAt: fresh } },
                    spaces:  {}, folders: {}, docs: {}, tasks: {}
                }
            }
        }));
        const staleEntry = { id: 'x', cachedAt: stale };
        const freshEntry = { id: 'x', cachedAt: fresh };
        assert.strictEqual(t.isCacheEntryFresh(staleEntry, 'lists'), false);
        assert.strictEqual(t.isCacheEntryFresh(freshEntry, 'lists'), true);

        const resolved = t.resolveClickUpIdByName('lists', 'stale-list');
        assert.strictEqual(resolved.source, 'miss', 'stale entries must not resolve as cache-exact');
        const resolvedFresh = t.resolveClickUpIdByName('lists', 'fresh-list');
        assert.strictEqual(resolvedFresh.source, 'cache-exact');
        assert.strictEqual(resolvedFresh.id, 'L-fresh');
    });
}

// ── Fuzzy matching: exact, fuzzy, substring, miss ────────────────
function testFuzzyMatching() {
    withScratchWorkspace('fuzzy', (root) => {
        const t = loadTesting();
        const now = Date.now();
        fs.writeFileSync(path.join(root, 'api_state.json'), JSON.stringify({
            linear: {}, clickup: {
                byName: {
                    lists: {
                        'bugs':        { id: 'L-bugs',       cachedAt: now },
                        'bug reports': { id: 'L-reports',    cachedAt: now },
                        'features':    { id: 'L-features',   cachedAt: now }
                    },
                    spaces: {}, folders: {}, docs: {}, tasks: {}
                }
            }
        }));
        // Exact, case-insensitive
        assert.strictEqual(t.resolveClickUpIdByName('lists', 'Bugs').source, 'cache-exact');
        // Fuzzy: "Bugz" → "bugs" (distance 1)
        const fuzzy = t.resolveClickUpIdByName('lists', 'Bugz');
        assert.strictEqual(fuzzy.source, 'cache-fuzzy');
        assert.ok(fuzzy.candidates.some((c) => c.name === 'bugs'), 'candidates must include bugs');
        // Miss: "Quxx" has no fresh match
        const miss = t.resolveClickUpIdByName('lists', 'Quxx');
        assert.strictEqual(miss.source, 'miss');
    });
}

// ── enhanceClickUpError: regex escape and 401 suggestion ─────────
function testEnhanceErrorRegexEscape() {
    withScratchWorkspace('enhance', (root) => {
        const t = loadTesting();
        fs.writeFileSync(path.join(root, 'api_state.json'), JSON.stringify({
            linear: {}, clickup: { byName: { lists: { 'list.1': { id: 'L-1', cachedAt: Date.now() } }, spaces: {}, folders: {}, docs: {}, tasks: {} } }
        }));
        // Name contains regex metacharacters — before the fix this threw or
        // mis-matched. Must now produce a clean quoted substitution and include
        // the cached candidate.
        const msg = t.enhanceClickUpError({
            status: 404,
            body: 'resource list.1 not found',
            attemptedName: 'list.1',
            kind: 'lists'
        });
        assert.ok(msg.includes('"list.1"'), 'attemptedName must be quoted via JSON.stringify');
        assert.ok(msg.includes('list-1') || msg.includes('L-1'), 'must surface cached candidate id');

        // 401 recovery hint
        const auth = t.enhanceClickUpError({ status: 401, body: 'Unauthorized' });
        assert.ok(auth.includes('Set ClickUp Token'));
    });
}

// ── validateAttachmentPath: all the security gates ───────────────
function testValidateAttachmentPathGates() {
    withScratchWorkspace('attach', (root) => {
        const t = loadTesting();
        // Valid small file
        fs.writeFileSync(path.join(root, 'small.txt'), 'hello');
        const ok = t.validateAttachmentPath('small.txt');
        assert.ok(ok.endsWith('small.txt'));

        // Path outside workspace
        assert.throws(
            () => t.validateAttachmentPath('../../../etc/passwd'),
            (err) => /path_outside_workspace|file_not_found/.test(err.message)
        );

        // Not a file
        fs.mkdirSync(path.join(root, 'sub'), { recursive: true });
        assert.throws(() => t.validateAttachmentPath('sub'), /not_a_file/);

        // File too large (11 MB)
        const large = path.join(root, 'big.bin');
        const fd = fs.openSync(large, 'w');
        fs.writeSync(fd, Buffer.alloc(1024 * 1024), 0, 1024 * 1024, 11 * 1024 * 1024 - 1024 * 1024);
        fs.closeSync(fd);
        // Pad to 11 MB
        fs.truncateSync(large, 11 * 1024 * 1024);
        assert.throws(() => t.validateAttachmentPath('big.bin'), /file_too_large/);

        // Symlink escaping the workspace — must be rejected
        const outside = path.join(os.tmpdir(), `semantic-test-outside-${Date.now()}.txt`);
        fs.writeFileSync(outside, 'outside');
        try {
            fs.symlinkSync(outside, path.join(root, 'link.txt'));
            assert.throws(
                () => t.validateAttachmentPath('link.txt'),
                (err) => /symlink_rejected|path_outside_workspace/.test(err.message),
                'symlink escaping workspace must be rejected'
            );
        } finally {
            fs.rmSync(outside, { force: true });
        }
    });
}

// ── Backward compatibility: call_clickup_api still present ──────
function testCallClickupApiStillRegistered() {
    const src = fs.readFileSync(
        path.join(__dirname, '../../../mcp-server/register-tools.js'),
        'utf8'
    );
    assert.ok(src.includes('"call_clickup_api"'), 'call_clickup_api must remain registered');
    assert.ok(src.includes('Prefer the dedicated'), 'description must hint at new tools');
    // Five new tools registered
    for (const name of ['clickup_fetch', 'clickup_modify_task', 'clickup_create_task', 'clickup_create_subpage', 'clickup_attach']) {
        assert.ok(src.includes(`"${name}"`), `missing tool registration: ${name}`);
    }
}

async function run() {
    testCacheExtractsNestedListsFromFolder();
    testTtlBoundary();
    testFuzzyMatching();
    testEnhanceErrorRegexEscape();
    testValidateAttachmentPathGates();
    testCallClickupApiStillRegistered();
    console.log('clickup semantic tools test passed');
}

run().catch((error) => {
    console.error('clickup semantic tools test failed:', error);
    process.exit(1);
});
