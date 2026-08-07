'use strict';

/**
 * Contract tests for "Fix STITCH HTML Tab — Stuck on Loading & Missing Auto-Cache".
 *
 * The three durable assertions the plan names in its Automated Tests subsection:
 *   1. `fetchPreview` for an unresolvable stitch project returns {success:false, error}
 *      in the BODY — not a false {success:true}. This is PRD contract #4 and the only
 *      way the browser cockpit can tell a broken preview from a working one.
 *   2. `stitchHtmlListDocs` returns its `docs` array in the BODY, with file /
 *      sourceFolder / absolutePath populated — a read arm that returns a bare ack
 *      violates PRD contract #4.
 *   3. Every sourceId that RAISES a loading spinner in design.js's
 *      `loadDocumentPreview` has a PREVIEW_ERROR_TARGETS entry that LOWERS it. The
 *      absence of that invariant is what caused the perpetual-spinner bug.
 *
 * Plus the regressions found in review of the fix itself:
 *   4. A superseded (stale) previewError lowers the spinner but does NOT tear down a
 *      newer preview that has already painted.
 *   5. The sweep is re-entrant-safe (four frontend paths post stitchHtmlListDocs).
 *   6. Sweep progress is tagged with its project and never rides another project's
 *      stitchHtmlDocsReady payload.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installVscodeTrap, createHeadlessTestSeams } = require('./helpers/verbEngineTestSeams');

installVscodeTrap();

const KanbanDatabaseModule = require('../../out/services/KanbanDatabase');
const { DesignPanelProvider } = require('../../out/services/DesignPanelProvider');

const DESIGN_JS = fs.readFileSync(path.join(__dirname, '..', 'webview', 'design.js'), 'utf8');

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

/**
 * Stub KanbanDatabase.forWorkspace for the duration of `fn`. DesignPanelProvider
 * resolves it per call (`KanbanDatabase.forWorkspace(root)`), so patching the static
 * on the cached module is enough — no real sql.js DB, no migrations.
 */
async function withStubbedDb(stub, fn) {
    const original = KanbanDatabaseModule.KanbanDatabase.forWorkspace;
    KanbanDatabaseModule.KanbanDatabase.forWorkspace = () => stub;
    try {
        return await fn();
    } finally {
        KanbanDatabaseModule.KanbanDatabase.forWorkspace = original;
    }
}

/** Every provider built by this run, so the html preview servers each one may spin up
 *  get closed. Their idle timeout is ten minutes — leaking one stalls CI for exactly
 *  that long after the last assertion passes. */
const builtProviders = [];

function buildHarness(tmpRoot) {
    const { seams } = createHeadlessTestSeams({ roots: [tmpRoot] });
    const dummyContext = {
        extensionUri: { fsPath: path.join(tmpRoot, 'ext') },
        extensionPath: tmpRoot,
        asAbsolutePath: (p) => path.join(tmpRoot, p),
        secrets: { get: async () => undefined, store: async () => {}, delete: async () => {} }
    };

    const provider = new DesignPanelProvider(dummyContext);
    provider._hostSeams = seams;

    const pushCalls = [];
    provider._broadcaster = {
        push: (msg) => pushCalls.push(msg),
        pushWebviewOnly: (msg) => pushCalls.push(msg),
        setWebview: () => {}
    };
    provider._getWorkspaceRoot = () => tmpRoot;
    provider._getWorkspaceRoots = () => [tmpRoot];
    provider._getLocalFolderService = () => ({
        getDesignFolderPaths: () => [],
        getHtmlFolderPaths: () => [],
        getClaudeFolderPaths: () => [],
        getBriefsFolderPaths: () => [],
        getImagesFolderPaths: () => []
    });
    // Never let a test touch the real watcher/name-resolution machinery.
    provider._resolveStitchProjectName = async () => {};
    provider._setupStitchHtmlFolderWatchers = async () => {};

    builtProviders.push(provider);
    return { provider, pushCalls };
}

/** Extract a balanced-brace block starting at the first occurrence of `needle`. */
function blockAt(source, needle) {
    const start = source.indexOf(needle);
    assert.ok(start !== -1, `source landmark not found: ${needle}`);
    let depth = 0;
    for (let i = source.indexOf('{', start); i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) return source.substring(start, i + 1);
        }
    }
    throw new Error(`unbalanced block for landmark: ${needle}`);
}

async function main() {
    console.log('STITCH HTML Tab — Contract Tests\n');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-html-tab-test-'));
    const PROJECT_ID = '6248498206992463926';
    const cacheDir = path.join(tmpDir, '.switchboard', 'stitch', 'test-project-62484982');
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(path.join(cacheDir, 'aaaa1111.html'), '<html><body>screen A</body></html>');
    fs.writeFileSync(path.join(cacheDir, 'bbbb2222.html'), '<html><body>screen B</body></html>');
    fs.writeFileSync(path.join(cacheDir, 'aaaa1111.png'), 'not-really-a-png');

    const dbStub = {
        ensureReady: async () => {},
        getStitchProjects: async () => [{ id: PROJECT_ID }],
        getStitchScreensForProject: async () => [
            { id: 'aaaa1111', name: 'Screen A' },
            { id: 'bbbb2222', name: 'Screen B' }
        ]
    };

    console.log('── PRD contract #4: data and failures reach the HTTP body ──');

    await test('1. fetchPreview on an unresolvable stitch project returns {success:false, error} in the body', async () => {
        const { provider } = buildHarness(tmpDir);
        // No stitch_projects row for this id => its cache dir is not in allowedFolders.
        await withStubbedDb({ ...dbStub, getStitchProjects: async () => [] }, async () => {
            provider._getImageCacheDir = () => cacheDir;
            const res = await provider.handleServiceVerb('fetchPreview', {
                sourceId: 'stitch-html-folder',
                docId: 'aaaa1111.html',
                projectId: 'no-such-project',
                workspaceRoot: tmpDir,
                requestId: 7
            });
            assert.strictEqual(res.success, false, 'a rejected folder must not report success');
            assert.strictEqual(res.type, 'previewError');
            assert.ok(res.error && res.error.length > 0, 'the failure must carry an error string');
        });
    });

    await test('2. fetchPreview on a configured stitch project returns the preview in the body', async () => {
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => cacheDir;
            const res = await provider.handleServiceVerb('fetchPreview', {
                sourceId: 'stitch-html-folder',
                docId: 'aaaa1111.html',
                projectId: PROJECT_ID,
                workspaceRoot: tmpDir,
                requestId: 8
            });
            assert.strictEqual(res.success, true);
            assert.strictEqual(res.type, 'previewReady');
            assert.strictEqual(res.docName, 'aaaa1111.html');
            assert.ok(res.htmlContent && res.htmlContent.includes('screen A'), 'body must carry the rendered HTML');
        });
    });

    await test('3. a missing stitch HTML file gets the Rebuild Cache hint, not an opaque ENOENT', async () => {
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => cacheDir;
            const res = await provider.handleServiceVerb('fetchPreview', {
                sourceId: 'stitch-html-folder',
                docId: 'deleted-since-listing.html',
                projectId: PROJECT_ID,
                workspaceRoot: tmpDir,
                requestId: 9
            });
            assert.strictEqual(res.success, false);
            assert.ok(/Rebuild Cache/.test(res.error), `expected the Rebuild Cache hint, got: ${res.error}`);
        });
    });

    await test('4. a missing NON-stitch file is not told to "Rebuild Cache" (a button that tab does not have)', async () => {
        const { provider } = buildHarness(tmpDir);
        const designDir = path.join(tmpDir, '.switchboard', 'design');
        fs.mkdirSync(designDir, { recursive: true });
        provider._getLocalFolderService = () => ({
            getDesignFolderPaths: () => [designDir],
            getHtmlFolderPaths: () => [],
            getClaudeFolderPaths: () => [],
            getBriefsFolderPaths: () => [],
            getImagesFolderPaths: () => []
        });
        await withStubbedDb(dbStub, async () => {
            const res = await provider.handleServiceVerb('fetchPreview', {
                sourceId: 'design-folder',
                sourceFolder: designDir,
                docId: 'never-existed.md',
                requestId: 10
            });
            assert.strictEqual(res.success, false);
            assert.ok(!/Rebuild Cache/.test(res.error), `design tab must not be told to Rebuild Cache: ${res.error}`);
            assert.ok(/not found on disk/.test(res.error), `expected a readable not-found message, got: ${res.error}`);
        });
    });

    await test('5. stitchHtmlListDocs returns the docs array in the body, not a bare ack', async () => {
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => cacheDir;
            const res = await provider.handleServiceVerb('stitchHtmlListDocs', {
                projectId: PROJECT_ID,
                workspaceRoot: tmpDir
            });
            assert.strictEqual(res.success, true);
            assert.strictEqual(res.type, 'stitchHtmlDocsReady');
            assert.ok(Array.isArray(res.docs), 'body must carry a docs array');
            assert.strictEqual(res.docs.length, 2, `expected the two .html files, got ${res.docs.length}`);
            const byFile = new Map(res.docs.map(d => [d.file, d]));
            assert.ok(byFile.has('aaaa1111.html') && byFile.has('bbbb2222.html'));
            const a = byFile.get('aaaa1111.html');
            assert.strictEqual(a.screenId, 'aaaa1111');
            assert.strictEqual(a.name, 'Screen A', 'display name resolves from the DB rows');
            assert.strictEqual(a.sourceFolder, cacheDir);
            assert.strictEqual(a.absolutePath, path.join(cacheDir, 'aaaa1111.html'));
            assert.ok(!res.docs.some(d => d.file.endsWith('.png')), '.png must not be listed as an HTML doc');
        });
    });

    console.log('\n── the auto-cache sweep ──');

    await test('6. a fully-cached project makes ZERO remote calls (missing.length === 0 exit)', async () => {
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => cacheDir;
            let sweepCalls = 0;
            provider._backfillStitchHtmlCache = async () => { sweepCalls++; };
            await provider._backfillStitchHtmlForProject(tmpDir, PROJECT_ID);
            assert.strictEqual(sweepCalls, 0, 'both screens already have HTML on disk — nothing to sweep');
        });
    });

    await test('7. the sweep is re-entrant-safe — a second concurrent entry is a no-op', async () => {
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => cacheDir;
            provider._activeStitchHtmlProjectId = PROJECT_ID;
            provider._activeStitchHtmlWorkspaceRoot = tmpDir;

            // Gate the missing-HTML probe. It runs BEFORE loadStitch (which cannot
            // resolve the real SDK under the test loader), so it is the observation
            // point for "has a second sweep started?".
            let probeCalls = 0;
            let release;
            const gate = new Promise(r => { release = r; });
            provider._getStitchHtmlPath = async () => {
                probeCalls++;
                await gate;
                return path.join(cacheDir, 'aaaa1111.html'); // already cached => clean exit
            };

            const first = provider._backfillStitchHtmlForProject(tmpDir, PROJECT_ID);
            await new Promise(r => setImmediate(r)); // let `first` reach the gated probe
            assert.strictEqual(probeCalls, 1, 'the first sweep should be parked in the probe');

            await provider._backfillStitchHtmlForProject(tmpDir, PROJECT_ID);
            assert.strictEqual(probeCalls, 1,
                're-entry while a sweep is in flight must not start a second one (it would double every getScreen/getHtml)');

            release();
            await first;

            // …and the guard must release, so a later entry can still sweep.
            await provider._backfillStitchHtmlForProject(tmpDir, PROJECT_ID);
            assert.ok(probeCalls > 1, 'the in-flight guard must be released in finally');
        });
    });

    await test('8. sweep progress is tagged and never rides another project\'s payload', async () => {
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => cacheDir;
            provider._stitchHtmlBackfill = { done: 3, total: 13, workspaceRoot: tmpDir, projectId: 'OTHER-PROJECT' };

            const other = await provider._sendStitchHtmlDocsReady(tmpDir, PROJECT_ID);
            assert.strictEqual(other.backfill, undefined,
                'a sweep on another project must not announce progress in this project');

            provider._stitchHtmlBackfill = { done: 3, total: 13, workspaceRoot: tmpDir, projectId: PROJECT_ID };
            const own = await provider._sendStitchHtmlDocsReady(tmpDir, PROJECT_ID);
            assert.deepStrictEqual(own.backfill, { done: 3, total: 13 },
                'its own project must see the progress counter');
        });
    });

    await test('9. an explicit send cancels the queued debounce (no redundant trailing push)', async () => {
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => cacheDir;
            provider._activeStitchHtmlProjectId = PROJECT_ID;
            provider._activeStitchHtmlWorkspaceRoot = tmpDir;
            provider._scheduleStitchHtmlDocsReady();
            assert.ok(provider._stitchHtmlDocsDebounce, 'a debounce should be pending');
            await provider._sendStitchHtmlDocsReady(tmpDir, PROJECT_ID);
            assert.strictEqual(provider._stitchHtmlDocsDebounce, undefined,
                'the explicit send supersedes the queued one — mirrors _sendHtmlDocsReady');
        });
    });

    console.log('\n── source contract: every raised spinner is lowered on error ──');

    await test('10. every sourceId that raises a spinner in loadDocumentPreview has a PREVIEW_ERROR_TARGETS entry that lowers it', () => {
        const loadFn = blockAt(DESIGN_JS, 'function loadDocumentPreview(');
        const errorBlock = blockAt(DESIGN_JS, 'const PREVIEW_ERROR_TARGETS = ');

        // Which loading-state elements does loadDocumentPreview raise? It only ever
        // touches them to show a spinner, so every id it names is one that must be
        // lowered again on error.
        const raised = new Set();
        const loadingIdRe = /getElementById\('([a-z-]*loading-state)'\)/g;
        let m;
        while ((m = loadingIdRe.exec(loadFn)) !== null) {
            raised.add(m[1]);
        }
        assert.ok(raised.size >= 3,
            `expected loadDocumentPreview to raise at least the html/stitch-html/images spinners, found: ${[...raised]}`);

        // Which does the error handler lower?
        const lowered = new Set();
        const loweredRe = /loading:\s*'([a-z-]*loading-state)'/g;
        while ((m = loweredRe.exec(errorBlock)) !== null) {
            lowered.add(m[1]);
        }

        const orphans = [...raised].filter(id => !lowered.has(id));
        assert.deepStrictEqual(orphans, [],
            `these spinners are raised but never lowered on previewError (perpetual-loading bug): ${orphans.join(', ')}`);
    });

    await test('11. a stale previewError lowers the spinner but does NOT tear down the newer preview', () => {
        // The whole handler, not just the table — the ordering is what is under test.
        const errorBlock = blockAt(DESIGN_JS, "case 'previewError': {");

        const loweringIdx = errorBlock.indexOf('if (target.loading)');
        const staleGuardIdx = errorBlock.indexOf('if (!isStale)');
        const hideIdx = errorBlock.indexOf('target.hide.forEach');
        const showIdx = errorBlock.indexOf('target.show.forEach');

        assert.ok(loweringIdx !== -1, 'the spinner must be lowered unconditionally');
        assert.ok(staleGuardIdx !== -1, 'a staleness guard must exist');
        assert.ok(loweringIdx < staleGuardIdx,
            'the spinner clear must precede the staleness guard — a stale error still ends THAT request');
        assert.ok(hideIdx > staleGuardIdx && showIdx > staleGuardIdx,
            'the preview teardown and initial-state restore must sit INSIDE the !isStale guard — a late error from '
            + 'a superseded request must not wipe a newer preview that has already painted');

        // The table must not re-list the loading state under `hide` (that would
        // reintroduce the unconditional teardown by the back door).
        assert.ok(!/hide:\s*\[[^\]]*loading-state/.test(errorBlock),
            'loading-state ids belong in `loading`, not `hide`');
    });

    console.log('\n── markdown files in the stitch cache dir are listable AND previewable ──');

    // The sidebar is this tab's ONLY way to open a file, so a listing filter that
    // drops .md makes the preview pane's markdown branch unreachable dead code —
    // exactly the state the markdown-rendering change originally shipped in.
    await test('12. a .md note in the cache dir IS listed, and its paired .png is NOT', async () => {
        const mdCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-md-'));
        fs.writeFileSync(path.join(mdCacheDir, 'aaaa1111.html'), '<html><body>A</body></html>');
        fs.writeFileSync(path.join(mdCacheDir, 'aaaa1111.png'), 'not-a-png');
        fs.writeFileSync(path.join(mdCacheDir, 'design-notes.md'), '# Notes\n');
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => mdCacheDir;
            const res = await provider.handleServiceVerb('stitchHtmlListDocs', {
                projectId: PROJECT_ID, workspaceRoot: tmpDir
            });
            const files = res.docs.map(d => d.file).sort();
            assert.ok(files.includes('design-notes.md'),
                `markdown must be listed or the preview pane can never receive it; got ${JSON.stringify(files)}`);
            assert.ok(files.includes('aaaa1111.html'), 'html screens must still be listed');
            assert.ok(!files.includes('aaaa1111.png'),
                'images must stay out — every screen caches an .html AND a .png, so listing images doubles every row');
            // A note has no `screens` row; it must not inherit a same-stem screen name.
            assert.strictEqual(res.docs.find(d => d.file === 'design-notes.md').name, 'design-notes.md');
            assert.strictEqual(res.docs.find(d => d.file === 'aaaa1111.html').name, 'Screen A');
        });
        fs.rmSync(mdCacheDir, { recursive: true, force: true });
    });

    await test('13. previewing a .md returns fileType "markdown" + content, and no iframe payload', async () => {
        const mdCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-md-'));
        fs.writeFileSync(path.join(mdCacheDir, 'design-notes.md'), '# Notes\n\nSome **bold** text.\n');
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => mdCacheDir;
            const res = await provider.handleServiceVerb('fetchPreview', {
                sourceId: 'stitch-html-folder', docId: 'design-notes.md',
                projectId: PROJECT_ID, workspaceRoot: tmpDir, requestId: 91
            });
            assert.strictEqual(res.success, true);
            assert.strictEqual(res.fileType, 'markdown', 'design.js dispatches the markdown branch off fileType');
            assert.ok(res.content.includes('**bold**'), 'the body must carry the markdown source (PRD contract #4)');
            assert.ok(!res.iframeSrc && !res.htmlContent,
                'a markdown payload must not carry iframe fields, or the HTML branch would win the dispatch');
        });
        fs.rmSync(mdCacheDir, { recursive: true, force: true });
    });

    await test('14. the "Rebuild Cache" hint is html-only — a missing .md note does not get it', async () => {
        const mdCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stitch-md-'));
        const { provider } = buildHarness(tmpDir);
        await withStubbedDb(dbStub, async () => {
            provider._getImageCacheDir = () => mdCacheDir;
            const note = await provider.handleServiceVerb('fetchPreview', {
                sourceId: 'stitch-html-folder', docId: 'missing-note.md',
                projectId: PROJECT_ID, workspaceRoot: tmpDir, requestId: 92
            });
            assert.ok(!/Rebuild Cache/.test(note.error),
                `Rebuild Cache re-downloads screens; a user-authored note is not restorable that way. Got: ${note.error}`);
            const screen = await provider.handleServiceVerb('fetchPreview', {
                sourceId: 'stitch-html-folder', docId: 'missing-screen.html',
                projectId: PROJECT_ID, workspaceRoot: tmpDir, requestId: 93
            });
            assert.ok(/Rebuild Cache/.test(screen.error), `got: ${screen.error}`);
        });
        fs.rmSync(mdCacheDir, { recursive: true, force: true });
    });

    await test('15. the stitch sidebar classifies its badge off the FILENAME, not the screen display name', () => {
        // A stitch doc's `name` is the DB display name ("Screen A") — extensionless, so
        // getDocType(doc) returns 'other' and every card badges "File". The subtitle must
        // be derived from doc.file.
        const renderFn = blockAt(DESIGN_JS, 'function renderStitchHtmlDocs(');
        assert.ok(/getDocType\(\s*\{\s*name:\s*doc\.file\s*\}\s*\)/.test(renderFn),
            'renderStitchHtmlDocs must call getDocType({ name: doc.file }) — passing the raw doc '
            + 'classifies the DB screen display name and badges every HTML screen as "File"');
    });

    for (const p of builtProviders) {
        try { p.dispose(); } catch {}
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('Unhandled error in test runner:', err);
    process.exit(1);
});
