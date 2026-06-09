'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Mirror of KanbanProvider.AGGREGATE_CACHE_SOURCES. If the source of truth in
// src/services/KanbanProvider.ts changes, this allowlist MUST be updated too.
const AGGREGATE_CACHE_SOURCES = {
    'notion':       { file: 'notion-cache.md',        label: 'Notion' },
    'local-folder': { file: 'local-folder-cache.md',  label: 'Local Folder' },
    'linear':       { file: 'linear-docs-cache.md',   label: 'Linear Docs' },
    'clickup':      { file: 'clickup-docs-cache.md',  label: 'ClickUp Docs' },
};

async function buildAggregateCache(workspaceRoot, activeSources) {
    const switchboardDir = path.resolve(workspaceRoot, '.switchboard');
    const aggregatePath = path.join(switchboardDir, 'planning-aggregate-cache.md');
    let aggregatedContent = '# Aggregated Planning Context\n\n';

    for (const source of activeSources) {
        const entry = AGGREGATE_CACHE_SOURCES[source];
        if (!entry) { continue; }
        const cachePath = path.join(switchboardDir, entry.file);
        const resolved = path.resolve(cachePath);
        if (!resolved.startsWith(switchboardDir + path.sep) && resolved !== switchboardDir) { continue; }
        if (fs.existsSync(resolved)) {
            const content = await fs.promises.readFile(resolved, 'utf8');
            aggregatedContent += `## Source: ${entry.label}\n\n${content}\n\n`;
        }
    }

    await fs.promises.writeFile(aggregatePath, aggregatedContent, 'utf8');
    return aggregatePath;
}

async function run() {
    const workspaceRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-planning-aggregate-'));
    const switchboardDir = path.join(workspaceRoot, '.switchboard');

    try {
        await fs.promises.mkdir(switchboardDir, { recursive: true });

        // Create cache files using the REAL on-disk names that each adapter writes.
        await fs.promises.writeFile(path.join(switchboardDir, 'notion-cache.md'),       '# Notion Content\n\nThis is from Notion.',   'utf8');
        await fs.promises.writeFile(path.join(switchboardDir, 'linear-docs-cache.md'),  '# Linear Docs\n\nThis is from Linear.',      'utf8');
        await fs.promises.writeFile(path.join(switchboardDir, 'clickup-docs-cache.md'), '# ClickUp Docs\n\nThis is from ClickUp.',    'utf8');
        await fs.promises.writeFile(path.join(switchboardDir, 'local-folder-cache.md'), '# Local Folder\n\nThis is from local disk.', 'utf8');

        // --- happy path: all four known sources aggregate correctly
        const aggregatePath = await buildAggregateCache(workspaceRoot, ['notion', 'linear', 'clickup', 'local-folder']);
        assert.strictEqual(fs.existsSync(aggregatePath), true, 'aggregate cache file should exist');

        const content = await fs.promises.readFile(aggregatePath, 'utf8');
        assert.ok(content.includes('# Aggregated Planning Context'), 'should have main header');
        assert.ok(content.includes('## Source: Notion'),             'should have Notion source header (label, not key)');
        assert.ok(content.includes('## Source: Linear Docs'),        'should have Linear Docs source header');
        assert.ok(content.includes('## Source: ClickUp Docs'),       'should have ClickUp Docs source header');
        assert.ok(content.includes('## Source: Local Folder'),       'should have Local Folder source header');
        assert.ok(content.includes('This is from Notion.'),          'should include notion body');
        assert.ok(content.includes('This is from Linear.'),          'should include linear body');
        assert.ok(content.includes('This is from ClickUp.'),         'should include clickup body');
        assert.ok(content.includes('This is from local disk.'),      'should include local-folder body');

        // --- missing source file: should skip without throwing
        await fs.promises.unlink(path.join(switchboardDir, 'linear-docs-cache.md'));
        await buildAggregateCache(workspaceRoot, ['notion', 'linear', 'clickup']);
        const contentAfterMissing = await fs.promises.readFile(aggregatePath, 'utf8');
        assert.ok(!contentAfterMissing.includes('## Source: Linear Docs'), 'should not include Linear when its cache is missing');
        assert.ok(contentAfterMissing.includes('## Source: Notion'),       'should still include Notion');
        assert.ok(contentAfterMissing.includes('## Source: ClickUp Docs'), 'should still include ClickUp');

        // --- unknown source: ignored, does NOT appear in output
        await buildAggregateCache(workspaceRoot, ['notion', 'unknown-source']);
        const contentAfterUnknown = await fs.promises.readFile(aggregatePath, 'utf8');
        assert.ok(!contentAfterUnknown.includes('unknown-source'),          'unknown source key should not leak into output');

        // --- Single-source vs multi-source dispatch.
        // KanbanProvider._syncDesignDocLinkForActiveSources can't be loaded under Node
        // because KanbanProvider imports `vscode`. Mirror its dispatch logic inline here
        // and assert it matches the same semantics: 0 or 1 existing cache => no aggregate
        // rebuild (single-source designDocLink is left intact); 2+ existing caches =>
        // aggregate rebuild + designDocLink redirect.
        function detectActiveSources(dir) {
            const active = [];
            for (const [key, entry] of Object.entries(AGGREGATE_CACHE_SOURCES)) {
                if (fs.existsSync(path.join(dir, entry.file))) { active.push(key); }
            }
            return active;
        }

        async function syncDispatch(wsRoot) {
            const dir = path.join(wsRoot, '.switchboard');
            const active = detectActiveSources(dir);
            if (active.length < 2) { return null; }
            return await buildAggregateCache(wsRoot, active);
        }

        // Recreate a clean per-source cache set for this test phase.
        const dispatchRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'switchboard-dispatch-'));
        const dispatchDir = path.join(dispatchRoot, '.switchboard');
        try {
            await fs.promises.mkdir(dispatchDir, { recursive: true });

            // 0 caches → no aggregate rebuild.
            assert.strictEqual(await syncDispatch(dispatchRoot), null, 'no caches => no aggregate rebuild');
            assert.strictEqual(
                fs.existsSync(path.join(dispatchDir, 'planning-aggregate-cache.md')),
                false,
                'no caches => no aggregate file on disk'
            );

            // 1 cache → single-source flow, no aggregate rebuild.
            await fs.promises.writeFile(path.join(dispatchDir, 'notion-cache.md'), '# Notion\nbody', 'utf8');
            assert.strictEqual(await syncDispatch(dispatchRoot), null, '1 cache => no aggregate rebuild');
            assert.strictEqual(
                fs.existsSync(path.join(dispatchDir, 'planning-aggregate-cache.md')),
                false,
                '1 cache => no aggregate file on disk'
            );

            // 2 caches → aggregate is built.
            await fs.promises.writeFile(path.join(dispatchDir, 'linear-docs-cache.md'), '# Linear\nbody', 'utf8');
            const aggPath = await syncDispatch(dispatchRoot);
            assert.ok(aggPath, '2 caches => aggregate path returned');
            assert.strictEqual(fs.existsSync(aggPath), true, '2 caches => aggregate file exists');
            const aggContent = await fs.promises.readFile(aggPath, 'utf8');
            assert.ok(aggContent.includes('## Source: Notion'),      '2 caches => aggregate contains Notion');
            assert.ok(aggContent.includes('## Source: Linear Docs'), '2 caches => aggregate contains Linear Docs');

            // 3 caches → aggregate rebuilt with all.
            await fs.promises.writeFile(path.join(dispatchDir, 'clickup-docs-cache.md'), '# ClickUp\nbody', 'utf8');
            const aggPath3 = await syncDispatch(dispatchRoot);
            assert.ok(aggPath3, '3 caches => aggregate path returned');
            const agg3Content = await fs.promises.readFile(aggPath3, 'utf8');
            assert.ok(agg3Content.includes('## Source: ClickUp Docs'), '3 caches => aggregate contains ClickUp Docs');
        } finally {
            await fs.promises.rm(dispatchRoot, { recursive: true, force: true });
        }

        // --- SECURITY: path-traversal attempt MUST NOT read files outside .switchboard/
        // Plant a sensitive file one directory above workspaceRoot.
        const sensitivePath = path.join(path.dirname(workspaceRoot), 'SECRET.md');
        await fs.promises.writeFile(sensitivePath, 'TOP-SECRET-DO-NOT-LEAK', 'utf8');
        try {
            const evilSources = [
                '../../etc/passwd',
                '../SECRET',                        // would resolve to sibling SECRET-cache.md — also outside .switchboard/
                '/etc/passwd',
                '..\\..\\windows\\system32\\config',
            ];
            await buildAggregateCache(workspaceRoot, evilSources);
            const afterEvil = await fs.promises.readFile(aggregatePath, 'utf8');
            assert.ok(!afterEvil.includes('TOP-SECRET-DO-NOT-LEAK'), 'path-traversal payload must not read sibling files');
            assert.ok(!afterEvil.includes('root:'),                   'path-traversal payload must not read /etc/passwd');
            for (const evil of evilSources) {
                assert.ok(!afterEvil.includes(evil), `raw untrusted source string "${evil}" must not be reflected in output`);
            }
        } finally {
            await fs.promises.unlink(sensitivePath).catch(() => {});
        }

        console.log('planning-aggregate-cache test passed');
    } finally {
        await fs.promises.rm(workspaceRoot, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('planning-aggregate-cache test failed:', error);
    process.exit(1);
});
