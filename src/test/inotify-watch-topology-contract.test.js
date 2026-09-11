'use strict';

/**
 * Watch topology contract — the behaviours the 16,776-watch leak fix turns on.
 *
 * The leak was `fs.watch({ recursive: true })`: on Linux that is a JavaScript
 * emulation which arms one ordinary `fs.watch()` per filesystem ENTRY — every
 * file and every directory — with no exclusion mechanism. A board watching a
 * 2,279-file plans directory therefore held 2,279 kernel watches where 1 would
 * have done, and each re-arm that dropped its predecessor without `.close()`
 * stranded the whole generation in libuv's handle table, immune to GC.
 *
 * `attachDirectoryWatcher` replaces it. This suite pins the four properties the
 * plan's verification asks for, measured against the real kernel counter
 * (`/proc/<pid>/fdinfo`) rather than against source text:
 *
 *   1. watch count scales with DIRECTORY count, not entry count
 *   2. nothing is armed under `node_modules` / `.git`
 *   3. `dispose()` returns the process to its baseline count — no stranded handles
 *   4. a subdirectory created after the arm still delivers its files' events
 *
 * Skips off-Linux, where `/proc` is unavailable and the leak does not exist.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { attachDirectoryWatcher } = require('../../out/services/directoryWatcher');
const { getInotifyWatchCount } = require('../../out/services/inotifyWatchCount');

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function makeTree(root) {
    // 4 real directories (root, docs, docs/nested, notes) + two excluded trees.
    // 30 files, so "one watch per file" and "one watch per directory" are far apart.
    fs.mkdirSync(path.join(root, 'docs', 'nested'), { recursive: true });
    fs.mkdirSync(path.join(root, 'notes'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'pkg', 'sub'), { recursive: true });
    fs.mkdirSync(path.join(root, '.git', 'objects'), { recursive: true });
    for (let i = 0; i < 10; i++) {
        fs.writeFileSync(path.join(root, `top-${i}.md`), '# top\n');
        fs.writeFileSync(path.join(root, 'docs', `doc-${i}.md`), '# doc\n');
        fs.writeFileSync(path.join(root, 'docs', 'nested', `deep-${i}.md`), '# deep\n');
        fs.writeFileSync(path.join(root, 'node_modules', 'pkg', 'sub', `m-${i}.js`), '');
        fs.writeFileSync(path.join(root, '.git', 'objects', `o-${i}`), '');
    }
}

async function run() {
    if (process.platform !== 'linux') {
        console.log('inotify-watch-topology-contract: skipped (Linux only)');
        return;
    }
    if (getInotifyWatchCount() === undefined) {
        console.log('inotify-watch-topology-contract: skipped (/proc unavailable)');
        return;
    }

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-watch-topology-'));
    try {
        makeTree(root);

        const baseline = getInotifyWatchCount();
        const events = [];
        const handle = attachDirectoryWatcher(root, (eventType, fullPath) => {
            events.push({ eventType, fullPath });
        }, { logTag: 'topology-test' });

        const armed = getInotifyWatchCount() - baseline;

        // 1. Directory count, not entry count. The tree holds 4 watchable
        //    directories and 30 watchable files; the recursive emulation would
        //    have armed 34+. Allow a small margin for concurrent activity in the
        //    process, but nowhere near the file count.
        assert.ok(
            armed >= 4 && armed <= 8,
            `expected ~4 watches (one per non-excluded directory), got ${armed} — a count near the file count means per-entry arming is back`
        );

        // 2. Nothing under node_modules/ or .git/. Proven by the count: if the
        //    walk had descended, node_modules/pkg, node_modules/pkg/sub and
        //    .git/objects would add at least 4 more directories.
        assert.ok(
            armed < 8,
            `the walk descended into an excluded tree — ${armed} watches is more than the 4 non-excluded directories`
        );

        // 4. A subdirectory created AFTER the arm still delivers events for the
        //    files inside it (this is what the rename-rescan exists for).
        const late = path.join(root, 'docs', 'late');
        fs.mkdirSync(late);
        await sleep(150);
        fs.writeFileSync(path.join(late, 'arrived.md'), '# arrived\n');
        await sleep(400);
        assert.ok(
            events.some(e => e.fullPath === path.join(late, 'arrived.md')),
            `a file written into a subdirectory created after the arm must fire an event; saw ${JSON.stringify(events.slice(-6))}`
        );

        // 3. dispose() returns the process to baseline. A watcher dropped without
        //    close() is retained by libuv's handle table with no JS reference and
        //    can never be reclaimed — that is the whole leak.
        handle.dispose();
        await sleep(100);
        const after = getInotifyWatchCount();
        assert.ok(
            after <= baseline + 1,
            `dispose() must close every armed watch: baseline ${baseline}, after dispose ${after}`
        );
    } finally {
        try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
    }

    console.log('inotify-watch-topology-contract.test.js passed.');
}

run().catch((e) => {
    console.error('inotify-watch-topology-contract.test.js failed:', e);
    process.exit(1);
});
