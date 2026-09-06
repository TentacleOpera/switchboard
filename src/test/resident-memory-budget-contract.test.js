'use strict';
/**
 * Contract: the standalone host has a STATED, ENFORCED resident-memory and
 * kernel-descriptor budget, and the seams that blew it stay closed.
 *
 * Plan: .switchboard/plans/resident-memory-budget-for-low-memory-hosts.md
 *       (feature: run-the-standalone-host-on-a-4-gb-device)
 *
 * Two halves, on purpose:
 *
 *   STATIC (always runs, gates CI) — the source-level invariants a regression
 *   would have to break to bring the 3.4 GB host back. These discriminate
 *   without a board, a Pi, or 24 hours: the probe's column schema, /health
 *   publishing `process.memoryUsage()`, the watch roots being narrowed rather
 *   than the whole tree, the brain watcher being depth-bounded rather than
 *   recursive, and no watcher creating `.switchboard` directories it merely
 *   wanted to observe.
 *
 *   LIVE (runs only when a host answers on this workspace's port) — the actual
 *   RSS / descriptor ceilings. A CI runner has no host, so these cannot gate
 *   CI; when they are skipped the run says so in as many words. Passing this
 *   file with the live half skipped is NOT evidence that the budget holds — it
 *   is evidence that the code paths which enforce it are still in place.
 */

const assert = require('assert');
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** The published budget. Must match docs/LOW_MEMORY_HOSTS.md. */
const BUDGET = {
    idleRssMb: 350,
    peakRssMb: 500,
    openFds: 100,
    // Raspberry Pi OS ships fs.inotify.max_user_watches=8192. The host must fit
    // inside that WITHOUT the operator raising the kernel limit — that is the
    // entire point of the two watcher subtasks in this feature.
    inotifyDescriptors: 8192,
};

const PROBE_HEADER = 'timestamp,pid,rss,heapUsed,heapTotal,external,arrayBuffers,inotifyDescriptors,openFds';

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

console.log('Resident memory budget contract');
console.log('\n  Static invariants');

test('the probe emits every column the budget is stated in', () => {
    const cli = readSource('src', 'standalone', 'cli.ts');
    assert(cli.includes(`const CSV_HEADER = '${PROBE_HEADER}'`),
        'cli.ts CSV_HEADER must be exactly the published probe schema');
    for (const col of ['rss', 'heapUsed', 'external', 'inotifyDescriptors', 'openFds']) {
        assert(PROBE_HEADER.split(',').includes(col), `probe schema is missing ${col}`);
    }
    assert(/'probe'/.test(cli) && /cmdProbe/.test(cli), 'probe subcommand must be registered and dispatched');
});

test('/health publishes process.memoryUsage() — the probe reads it, not a guess', () => {
    const api = readSource('src', 'services', 'LocalApiServer.ts');
    assert(/memory = process\.memoryUsage\(\)/.test(api), 'LocalApiServer /health must sample process.memoryUsage()');
    assert(/memory !== undefined \? \{ memory \}/.test(api), '/health must serialise the memory field it sampled');
});

test('the plan watcher watches plans/ and features/, never the whole .switchboard tree', () => {
    const host = readSource('src', 'standalone', 'planIngestionHost.ts');
    assert(!/const watchPath = fs\.existsSync\(switchboardDir\)/.test(host),
        'the watch root must not fall back to .switchboard (or the workspace) wholesale');
    assert(/armSubtree\(d\)/.test(host), 'plans/ and features/ must each be armed on their own');
    for (const excluded of ['logs', 'dbbackup', 'mission-control']) {
        assert(new RegExp(`EXCLUDED_DIR_NAMES[\\s\\S]{0,240}'${excluded}'`).test(host),
            `EXCLUDED_DIR_NAMES must contain '${excluded}' so the fallback walk never descends into it`);
    }
});

test('no watcher creates the .switchboard directories it only wanted to observe', () => {
    for (const [rel, label] of [
        [['src', 'standalone', 'planIngestionHost.ts'], 'standalone host'],
        [['src', 'services', 'GlobalPlanWatcherService.ts'], 'extension host'],
    ]) {
        const src = readSource(...rel);
        assert(!/mkdirSync/.test(src),
            `${label}: watchFolder is called for roots that are not Switchboard workspaces — it must never mkdir into them`);
    }
});

test('the Antigravity brain watch is depth-bounded, not recursive over the IDE root', () => {
    const tvp = readSource('src', 'services', 'TaskViewerProvider.ts');
    assert(!/fs\.watch\(antigravityRoot, \{ recursive: true \}/.test(tvp),
        'the brain fs.watch must not be recursive over the whole Antigravity root');
    assert(!/'\*\*\/\*\.md\{,\.\*\}'/.test(tvp),
        'the brain FileSystemWatcher glob must not be an unbounded ** over the Antigravity root');
    assert(/armBrainDirWatch/.test(tvp), 'the brain watch set must be armed per-directory and capped');
    assert(/brainWatchCap/.test(tvp), 'the brain watch set must honour a cap');
});

test('the recursion seam only recurses for **, and the cap is a real setting', () => {
    const shim = readSource('src', 'standalone', 'vscodeShim.ts');
    assert(/const isUnboundedRecursive = globPattern\.includes\('\*\*'\)/.test(shim),
        'vscodeShim must derive recursion from ** alone, never from the presence of a "/"');
    const pkg = JSON.parse(readSource('package.json'));
    const props = pkg.contributes.configuration.properties;
    assert(props['switchboard.planScanner.maxWatchesPerPreset'],
        'the watch cap must be a contributed setting, not an unreachable literal');
});

test('the published budget and this gate state the same numbers', () => {
    const doc = readSource('docs', 'LOW_MEMORY_HOSTS.md');
    assert(doc.includes(`< ${BUDGET.idleRssMb} MB`), `docs must publish the ${BUDGET.idleRssMb} MB idle ceiling`);
    assert(doc.includes(`< ${BUDGET.peakRssMb} MB`), `docs must publish the ${BUDGET.peakRssMb} MB peak ceiling`);
    assert(doc.includes(String(BUDGET.inotifyDescriptors)),
        'docs must state the 8,192 Pi inotify ceiling the host has to fit inside');
    assert(!/sysctl\s+fs\.inotify\.max_user_watches=/.test(doc),
        'the budget must be met by watching less, not by telling the operator to raise the kernel limit');
});

// ── LIVE ─────────────────────────────────────────────────────────────────────

function probeRows(args) {
    const out = execSync(`node "${path.join(REPO_ROOT, 'dist', 'standalone', 'cli.js')}" probe ${args}`, {
        cwd: REPO_ROOT, encoding: 'utf8', timeout: 15000,
    }).trim().split('\n');
    assert.strictEqual(out[0].trim(), PROBE_HEADER, `probe header mismatch: ${out[0]}`);
    return out.slice(1).map(line => {
        const c = line.trim().split(',');
        assert.strictEqual(c.length, 9, `expected 9 columns, got ${c.length}`);
        return {
            timestamp: c[0], pid: Number(c[1]), rss: Number(c[2]), heapUsed: Number(c[3]),
            heapTotal: Number(c[4]), external: Number(c[5]), arrayBuffers: Number(c[6]),
            inotify: Number(c[7]), openFds: Number(c[8]),
        };
    });
}

function livePort() {
    const cliBuilt = fs.existsSync(path.join(REPO_ROOT, 'dist', 'standalone', 'cli.js'));
    const portFile = path.join(REPO_ROOT, '.switchboard', 'api-server-port.txt');
    if (!cliBuilt || !fs.existsSync(portFile)) { return null; }
    const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
    return Number.isFinite(port) && port > 0 ? port : null;
}

(async () => {
    const port = livePort();
    if (port === null) {
        liveSkipped = true;
    } else {
        console.log('\n  Live budget (host answering on port ' + port + ')');

        await asyncTest('the probe reports a plausible sample without perturbing the host', () => {
            const rows = probeRows('--samples 3 --interval 50');
            assert.strictEqual(rows.length, 3, `expected 3 samples, got ${rows.length}`);
            for (const r of rows) {
                assert(r.pid > 0 && r.rss > 0 && r.openFds > 0, `implausible sample: ${JSON.stringify(r)}`);
                assert(!isNaN(Date.parse(r.timestamp)), `invalid timestamp ${r.timestamp}`);
            }
            const deltaMb = (Math.max(...rows.map(r => r.rss)) - Math.min(...rows.map(r => r.rss))) / (1024 * 1024);
            assert(deltaMb < 5, `probing moved host RSS by ${deltaMb.toFixed(2)} MB (ceiling 5 MB)`);
        });

        await asyncTest(`idle RSS is under the published ${BUDGET.idleRssMb} MB ceiling`, () => {
            const [row] = probeRows('--samples 1');
            const rssMb = row.rss / (1024 * 1024);
            assert(rssMb < BUDGET.idleRssMb, `host RSS ${rssMb.toFixed(1)} MB exceeds ${BUDGET.idleRssMb} MB`);
            assert(rssMb > 20, `host RSS ${rssMb.toFixed(1)} MB is implausibly low — is the probe reading the right process?`);
        });

        await asyncTest(`descriptors fit inside a Raspberry Pi's ${BUDGET.inotifyDescriptors} inotify budget`, () => {
            const [row] = probeRows('--samples 1');
            assert(row.inotify < BUDGET.inotifyDescriptors,
                `${row.inotify} inotify watches exceeds the Pi ceiling of ${BUDGET.inotifyDescriptors}`);
            assert(row.openFds < BUDGET.openFds, `${row.openFds} open FDs exceeds ${BUDGET.openFds}`);
        });

        await asyncTest(`RSS stays under ${BUDGET.peakRssMb} MB across a workload`, async () => {
            const before = probeRows('--samples 1')[0];
            const codes = await Promise.all(Array.from({ length: 25 }, () => new Promise((resolve, reject) => {
                http.get(`http://127.0.0.1:${port}/health`, res => {
                    res.resume();
                    res.on('end', () => resolve(res.statusCode));
                }).on('error', reject);
            })));
            assert(codes.every(c => c === 200), 'every /health request must answer 200');
            const after = probeRows('--samples 1')[0];
            const rssMb = after.rss / (1024 * 1024);
            assert(rssMb < BUDGET.peakRssMb, `post-workload RSS ${rssMb.toFixed(1)} MB exceeds ${BUDGET.peakRssMb} MB`);
            const growthMb = (after.rss - before.rss) / (1024 * 1024);
            assert(growthMb < 25, `workload grew RSS by ${growthMb.toFixed(1)} MB in one pass`);
        });
    }

    console.log(`\nTests passed: ${passed}, failed: ${failed}`);
    if (liveSkipped) {
        console.log('LIVE BUDGET CHECKS NOT RUN — no built CLI or no host answering on this workspace.');
        console.log('The static invariants above do NOT measure resident memory. Run this file against a');
        console.log('running host (npm run compile && switchboard local) to enforce the RSS ceiling.');
    }
    if (failed > 0) { process.exit(1); }
})();
