'use strict';
/**
 * Contract: the event-loop lag detector fires from OUTSIDE the blocked loop
 * and writes a stack dump naming the loop, while the loop is still spinning
 * (plan: attribute-switchboards-cpu-before-optimising-it, verification 3+4).
 *
 * LIVE test — spawns a child process that arms the watchdog, starts an HTTP
 * server (the "/health already failing" condition), then blocks its event
 * loop in a named busy loop. The parent asserts:
 *   1. the dump file lands on disk while the child is STILL spinning
 *      (the child outlives the dump by seconds, checked by pid liveness),
 *   2. the dump names what the loop was executing (a V8 Runtime_ frame when
 *      gdb is installed; the wchan fallback otherwise records the stall),
 *   3. the dump file is not world-readable,
 *   4. the child's HTTP server cannot answer while the loop is blocked —
 *      the exact wedge condition the dump path must survive.
 *
 * Requires `npm run compile-tests` first (the test loads
 * out/services/eventLoopWatchdog.js, per the repo's contract-test rule).
 */

const assert = require('assert');
const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WATCHDOG = path.join(REPO_ROOT, 'out', 'services', 'eventLoopWatchdog.js');

let passed = 0;
let failed = 0;
function test(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') { throw new Error('use asyncTest for async bodies'); }
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}
async function asyncTest(name, fn) {
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

const CHILD_SRC = `
const fs = require('fs');
const http = require('http');
const { startEventLoopWatchdog } = require(${JSON.stringify(WATCHDOG)});
const dir = __DIR__;
const server = http.createServer((req, res) => { res.end('ok'); });
server.listen(0, '127.0.0.1', () => {
    fs.writeFileSync(dir + '/child-port.txt', String(server.address().port));
    startEventLoopWatchdog({ thresholdMs: 2000, diagnosticsDir: dir,
        log: () => {}, warn: () => {} });
    // Named busy loop: blocks the event loop (starves the HTTP server and
    // every in-loop watchdog) for 12s while the out-of-loop worker dumps.
    function wedgeContractNamedLoop() {
        let x = 0;
        const deadline = Date.now() + 12000;
        while (Date.now() < deadline) { x = (x + 1) | 0; }
        return x;
    }
    const r = wedgeContractNamedLoop();
    fs.writeFileSync(dir + '/loop-ended.txt', String(r));
    process.exit(0);
});
`;

async function main() {
    console.log('Event-loop watchdog contract');
    if (!fs.existsSync(WATCHDOG)) {
        console.error('  ❌ out/services/eventLoopWatchdog.js missing — run `npm run compile-tests` first');
        process.exit(1);
    }

    const dir = fs.mkdtempSync('/tmp/eventloop-watchdog-contract-');
    const src = CHILD_SRC.replace('__DIR__', JSON.stringify(dir));
    const child = spawn(process.execPath, ['-e', src], { stdio: ['ignore', 'pipe', 'pipe'] });
    let childErr = '';
    child.stderr.on('data', (d) => { childErr += d; });

    // Wait for the child's HTTP port file.
    let port = -1;
    for (let i = 0; i < 50; i++) {
        try { port = parseInt(fs.readFileSync(path.join(dir, 'child-port.txt'), 'utf8').trim(), 10); if (port > 0) break; } catch { /* not yet */ }
        await new Promise(r => setTimeout(r, 100));
    }
    test('child armed its HTTP server before blocking', () => assert.ok(port > 0, `child port file never appeared (stderr: ${childErr})`));

    await asyncTest('dump lands on disk while the loop is still spinning', async () => {
        let dumpFile = null;
        for (let i = 0; i < 80; i++) {
            try {
                const last = fs.readFileSync(path.join(dir, 'last-eventloop-stall.txt'), 'utf8').trim();
                if (last && fs.existsSync(last)) { dumpFile = last; break; }
            } catch { /* not yet */ }
            await new Promise(r => setTimeout(r, 250));
        }
        assert.ok(dumpFile, 'no dump file appeared within 20s of a 2s threshold');
        // STILL SPINNING: the loop runs 12s; the dump fires at ~2.5s. The
        // child must still be alive and the loop-end marker must NOT exist.
        assert.equal(fs.existsSync(path.join(dir, 'loop-ended.txt')), false,
            'dump arrived only after the loop ended — the detector is same-loop, not out-of-loop');
        assert.ok(child.exitCode === null, 'child exited before the dump landed');
        const dump = fs.readFileSync(dumpFile, 'utf8');
        assert.ok(dump.includes('event loop stall'), 'dump does not record the stall header');
        const hasGdb = require('child_process').spawnSync('which', ['gdb']).status === 0;
        if (hasGdb) {
            assert.ok(/Runtime_|thread apply all bt/.test(dump),
                'dump does not name the blocked loop (no V8 Runtime frame, no gdb backtrace)');
        }
        const mode = fs.statSync(dumpFile).mode;
        assert.equal(mode & 0o004, 0, `dump file is world-readable (mode ${mode.toString(8)})`);
    });

    await asyncTest('HTTP cannot answer while the loop is blocked (the /health-failing condition)', async () => {
        assert.ok(port > 0);
        await new Promise((resolve) => {
            const req = http.get({ host: '127.0.0.1', port, path: '/health', timeout: 800 }, (res) => {
                res.resume();
                resolve(new Error(`HTTP answered during a blocked loop (status ${res.statusCode}) — the dump path was not proven under the wedge condition`));
            });
            req.on('timeout', () => { req.destroy(); resolve(null); });
            req.on('error', () => resolve(null));
        }).then((err) => { assert.ok(!err, err && err.message); });
    });

    await asyncTest('child exits cleanly after the loop ends', async () => {
        const code = await new Promise((resolve) => {
            child.on('exit', (c) => resolve(c));
            child.on('error', (e) => resolve(-1));
        });
        assert.strictEqual(code, 0, `child exited ${code} (stderr: ${childErr})`);
    });

    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp cleanup */ }
    console.log(`\n  ${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

void main();
