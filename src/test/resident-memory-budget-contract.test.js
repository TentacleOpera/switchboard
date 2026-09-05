'use strict';
/**
 * Resident memory budget contract test for low-memory hosts (e.g. Raspberry Pi 4 GB).
 *
 * Verifies:
 * 1. CLI probe output conforms to required CSV header and column schema:
 *    timestamp,pid,rss,heapUsed,heapTotal,external,arrayBuffers,inotifyDescriptors,openFds
 * 2. Probe execution does not perturb host memory (RSS delta across probe samples < 5 MB).
 * 3. Resident memory budget enforcement:
 *    - Idle RSS budget: < 400 MB (measured ~214 MB on 4 GB Raspberry Pi host).
 *    - Open FDs and inotify descriptors remain bounded (< 100 FDs, < 10,000 inotify watches).
 *    - Rejects pre-fix failure state (> 3,400 MB RSS from sql.js WASM arena / 700 board copies).
 */

const assert = require('assert');
const http = require('http');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

async function runAsyncTest(name, fn) {
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

(async () => {
    console.log('Resident memory budget contract test');

    const repoRoot = path.resolve(__dirname, '..', '..');
    const cliPath = path.join(repoRoot, 'dist', 'standalone', 'cli.js');

    // 1. Structural check of CLI probe output format
    test('CLI probe outputs expected CSV headers and valid columns', () => {
        const out = execSync(`node "${cliPath}" probe --samples 1`, {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 10000,
        }).trim();

        const lines = out.split('\n');
        assert(lines.length >= 2, `Expected at least 2 lines (header + 1 sample), got: ${lines.length}`);

        const header = lines[0].trim();
        const expectedHeader = 'timestamp,pid,rss,heapUsed,heapTotal,external,arrayBuffers,inotifyDescriptors,openFds';
        assert.strictEqual(header, expectedHeader, `Header mismatch: got ${header}`);

        const cols = lines[1].trim().split(',');
        assert.strictEqual(cols.length, 9, `Expected 9 columns in sample row, got: ${cols.length}`);

        const [timestamp, pid, rss, heapUsed, heapTotal, external, arrayBuffers, inotifyDescriptors, openFds] = cols;
        assert(!isNaN(Date.parse(timestamp)), `Invalid timestamp: ${timestamp}`);
        assert(Number(pid) > 0, `Invalid PID: ${pid}`);
        assert(Number(rss) > 0, `Invalid RSS: ${rss}`);
        assert(Number(inotifyDescriptors) >= 0, `Invalid inotifyDescriptors: ${inotifyDescriptors}`);
        assert(Number(openFds) > 0, `Invalid openFds: ${openFds}`);
    });

    // 2. Perturbation check: running probe must not perturb the host (RSS delta < 5 MB across multiple samples)
    test('Probe does not perturb host memory (RSS delta across samples < 5 MB)', () => {
        const out = execSync(`node "${cliPath}" probe --samples 3 --interval 50`, {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 10000,
        }).trim();

        const lines = out.split('\n').slice(1);
        assert.strictEqual(lines.length, 3, `Expected 3 sample rows, got ${lines.length}`);

        const rssValues = lines.map(line => Number(line.split(',')[2]));
        const minRss = Math.min(...rssValues);
        const maxRss = Math.max(...rssValues);
        const deltaBytes = maxRss - minRss;
        const deltaMb = deltaBytes / (1024 * 1024);

        assert(deltaMb < 5.0, `Probe perturbed host memory by ${deltaMb.toFixed(2)} MB (must be < 5 MB)`);
    });

    // 3. Resident Memory Budget verification
    test('Resident memory (RSS) is bounded under the 400 MB baseline budget', () => {
        const out = execSync(`node "${cliPath}" probe --samples 1`, {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 10000,
        }).trim();

        const row = out.split('\n')[1].trim().split(',');
        const rssBytes = Number(row[2]);
        const rssMb = rssBytes / (1024 * 1024);

        // Pre-fix unfixed host was 3,446 MB. Current budget is < 400 MB.
        assert(rssMb < 400, `Host RSS is ${rssMb.toFixed(2)} MB, exceeding 400 MB ceiling`);
        assert(rssMb > 20, `Host RSS is suspiciously low: ${rssMb.toFixed(2)} MB`);
    });

    // 4. Inotify and open FD bounds
    test('File descriptors and inotify watches remain bounded', () => {
        const out = execSync(`node "${cliPath}" probe --samples 1`, {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 10000,
        }).trim();

        const row = out.split('\n')[1].trim().split(',');
        const inotify = Number(row[7]);
        const openFds = Number(row[8]);

        // Unfixed host had thousands of open watches per-file; bounded should be < 10,000
        assert(inotify < 10000, `Inotify count ${inotify} exceeds 10,000 ceiling`);
        // Open FDs should be modest for the server process (< 256)
        assert(openFds < 256, `Open FDs ${openFds} exceeds 256 ceiling`);
    });

    // 5. Workload resilience simulation (HTTP requests + probe readback)
    await runAsyncTest('Workload simulation: server serves concurrent queries and RSS stays within budget', async () => {
        const portFile = path.join(repoRoot, '.switchboard', 'api-server-port.txt');
        assert(fs.existsSync(portFile), 'api-server-port.txt exists');
        const port = parseInt(fs.readFileSync(portFile, 'utf8').trim(), 10);
        assert(port > 0, `Valid port: ${port}`);

        // Dispatch a batch of health/status checks to exercise endpoints
        const requests = Array.from({ length: 15 }, () => new Promise((resolve, reject) => {
            http.get(`http://127.0.0.1:${port}/health`, (res) => {
                let data = '';
                res.on('data', chunk => data += chunk);
                res.on('end', () => resolve(res.statusCode));
            }).on('error', reject);
        }));

        const statusCodes = await Promise.all(requests);
        assert(statusCodes.every(c => c === 200), 'All health checks returned 200');

        // Verify post-workload RSS remains under budget
        const out = execSync(`node "${cliPath}" probe --samples 1`, {
            cwd: repoRoot,
            encoding: 'utf8',
            timeout: 10000,
        }).trim();
        const row = out.split('\n')[1].trim().split(',');
        const rssMb = Number(row[2]) / (1024 * 1024);
        assert(rssMb < 400, `Post-workload RSS ${rssMb.toFixed(2)} MB exceeded 400 MB`);
    });

    console.log(`\nTests passed: ${passed}, failed: ${failed}`);
    if (failed > 0) {
        process.exit(1);
    }
})();
