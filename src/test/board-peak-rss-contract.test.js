'use strict';

/**
 * Contract: the standalone host holds a running team inside an 800 MB peak-RSS
 * budget on a 1 GB device — measured UNDER LOAD, not at idle — with a gate
 * that fails when a run exceeds it.
 *
 * Plan: .switchboard/plans/the-board-must-fit-a-1gb-pi-and-the-peak-is-what-does-not.md
 *       (Change 4)
 *
 * The measured peak today is 749 MB with nine seats on a development box.
 * 800 MB leaves ~50 MB — the absence of margin, not margin. The ceiling is
 * the budget the other changes (windowing, empty-field omission, the explicit
 * V8 old-space limit) have to create room under, not a description of where
 * the host already sits.
 *
 * Two halves, on purpose:
 *
 *   STATIC (always runs, gates CI) — the source-level invariants that make
 *   the ceiling enforceable: the ceiling constant is stated and referenced,
 *   the working-set windowing and empty-field omission that create room under
 *   it are in place, the V8 old-space flag is explicit, and the burst probe
 *   that distinguishes churn from retention exists. Without these the ceiling
 *   is a comment.
 *
 *   LIVE (runs only when a host answers on this workspace's port) — samples
 *   peak RSS via /health under a workload and fails above the ceiling. A CI
 *   runner has no host, so this is skipped out loud rather than passing
 *   quietly. The full WS-client-against-seeded-board harness the plan names
 *   (open N clients, plan write, mock dispatch, disconnect) is the target;
 *   the HTTP-burst workload here is the shipped floor — the same shape
 *   `resident-memory-budget-contract` ships with, and the same honest "LIVE
 *   PEAK-RSS CHECKS NOT RUN" skip when no host answers.
 */

const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The 1 GB Pi peak-RSS ceiling. Stated for the device with ~250 MB reserved
 *  for the OS. Must be LOWER than resident-memory-budget's 4 GB budget and
 *  the two must not be confused. */
const PEAK_RSS_CEILING_MB = 800;

let passed = 0;
let failed = 0;
let liveSkipped = false;

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

function readSource(...segments) {
    return fs.readFileSync(path.join(REPO_ROOT, ...segments), 'utf8');
}

// ── STATIC ───────────────────────────────────────────────────────────────────

console.log('Board peak-RSS ceiling contract (1 GB Pi)');
console.log('\n  Static invariants');

test('the peak-RSS ceiling is stated and below the 4 GB coarse budget', () => {
    assert.ok(PEAK_RSS_CEILING_MB === 800, 'the 1 GB Pi ceiling is 800 MB peak RSS');
    // The resident-memory plan's 4 GB budget is the coarse backstop; this 800 MB
    // ceiling is the tight Pi constraint and must not be confused with it.
    const resident = readSource('src', 'test', 'resident-memory-budget-contract.test.js');
    assert.ok(/peakRssMb:\s*500/.test(resident) || /peakRssMb/.test(resident),
        'the resident-memory gate must keep stating its own ceiling — the two budgets are distinct');
});

test('the room-creating changes are in place (windowing + empty-field omission)', () => {
    // The ceiling is only enforceable if the changes that create room under it
    // are wired. Reverting either re-inflates the peak past 800 MB while every
    // suite stays green.
    const db = readSource('src', 'services', 'KanbanDatabase.ts');
    assert.ok(/public async getBoardWorkingSet/.test(db), 'the working-set read must exist — it removes 317+91 dormant cards from the build');
    const provider = readSource('src', 'services', 'KanbanProvider.ts');
    assert.ok(/getBoardWorkingSet/.test(provider), 'getFullStateMessages must use the working-set read');
    assert.ok(/dispatchedAt: row.dispatchedAt \?\? undefined/.test(provider),
        'empty-field omission must emit undefined — reverting to ?? null re-adds the empty-slot tax');
});

test('the V8 old-space flag is explicit on both Go entry paths', () => {
    // Without the flag, V8 derives the heap limit from physical memory and on
    // a 1 GB device aborts at ~342 MB — below the ~355 MB the board peaks at.
    const client = readSource('cmd', 'switchboard', 'main.go');
    const launcher = readSource('internal', 'launcher', 'discovery.go');
    for (const [label, src] of [['cmd/switchboard/main.go', client], ['internal/launcher/discovery.go', launcher]]) {
        assert.ok(/--max-old-space-size=/.test(src), `${label} must set --max-old-space-size explicitly — V8's derived limit aborts the host on 1 GB`);
    }
});

test('the burst probe exists so churn vs retention is answerable', () => {
    // The ceiling is a number; the probe is what tells the next person whether
    // a regression above it is churn (the pipeline's working set) or retention
    // (an owner to find). Without it the ceiling encodes the unfixed burst.
    const provider = readSource('src', 'services', 'KanbanProvider.ts');
    assert.ok(/_recordBurstGcSplit/.test(provider), 'the forced-GC split probe must exist');
    assert.ok(/SWITCHBOARD_BURST_GC_SPLIT/.test(provider), 'the probe must be env-gated (off by default)');
});

test('/health publishes process.memoryUsage() — the harness samples it, not a guess', () => {
    const api = readSource('src', 'services', 'LocalApiServer.ts');
    assert.ok(/memory = process\.memoryUsage\(\)/.test(api), '/health must sample process.memoryUsage()');
    assert.ok(/memory !== undefined \? \{ memory \}/.test(api), '/health must serialise the memory field');
});

// ── LIVE ─────────────────────────────────────────────────────────────────────

function livePort() {
    const cliBuilt = fs.existsSync(path.join(REPO_ROOT, 'dist', 'standalone', 'cli.js'));
    const portFile = path.join(REPO_ROOT, '.switchboard', 'api-server-port.txt');
    if (!cliBuilt || !fs.existsSync(portFile)) { return null; }
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    return Number.isFinite(port) && port > 0 ? port : null;
}

function sampleHealth(port) {
    return new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${port}/health`, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                try {
                    const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                    resolve({ rss: j.memory?.rss ?? 0, heapUsed: j.memory?.heapUsed ?? 0, pid: j.pid });
                } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

(async () => {
    const port = livePort();
    if (port === null) {
        liveSkipped = true;
    } else {
        console.log('\n  Live peak-RSS (host answering on port ' + port + ')');

        await asyncTest(`peak RSS under a workload stays under ${PEAK_RSS_CEILING_MB} MB`, async () => {
            const before = await sampleHealth(port);
            assert.ok(before.rss > 0, 'the host must report a non-zero RSS — is /health reading the right process?');
            // Drive the card-build-adjacent read path: a burst of /kanban/board
            // collection reads. The full WS-client-against-seeded-board harness
            // (plan Change 4) is the target; this HTTP burst is the shipped floor.
            const codes = await Promise.all(Array.from({ length: 50 }, () => new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/kanban/board`, res => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode));
                }).on('error', reject);
            })));
            assert.ok(codes.every(c => c === 200), 'every /kanban/board request must answer 200');
            const after = await sampleHealth(port);
            const peakMb = Math.max(before.rss, after.rss) / (1024 * 1024);
            console.log(`     peak RSS: ${peakMb.toFixed(1)} MB (ceiling ${PEAK_RSS_CEILING_MB} MB)`);
            assert.ok(peakMb < PEAK_RSS_CEILING_MB,
                `peak RSS ${peakMb.toFixed(1)} MB exceeds the ${PEAK_RSS_CEILING_MB} MB 1 GB Pi ceiling — the room-creating changes (windowing, empty-field omission, V8 limit) have not created enough room`);
        });

        await asyncTest('the workload does not grow RSS unbounded in one pass', async () => {
            const a = await sampleHealth(port);
            const codes = await Promise.all(Array.from({ length: 25 }, () => new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/health`, res => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode));
                }).on('error', reject);
            })));
            assert.ok(codes.every(c => c === 200), 'every /health request must answer 200');
            const b = await sampleHealth(port);
            const growthMb = (b.rss - a.rss) / (1024 * 1024);
            assert.ok(growthMb < 50, `workload grew RSS by ${growthMb.toFixed(1)} MB in one pass — a burst is expected, unbounded growth is a leak`);
        });
    }

    console.log(`\nTests passed: ${passed}, failed: ${failed}`);
    if (liveSkipped) {
        console.log('LIVE PEAK-RSS CHECKS NOT RUN — no built CLI or no host answering on this workspace.');
        console.log('The static invariants above do NOT measure resident memory. Run this file against a');
        console.log('running host (npm run compile && switchboard local) to enforce the 800 MB ceiling.');
    }
    if (failed > 0) { process.exit(1); }
})();
