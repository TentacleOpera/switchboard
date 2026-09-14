/**
 * Event-loop lag detector with an out-of-loop stack dump.
 *
 * Plan: attribute-switchboards-cpu-before-optimising-it (step 2 — "catch the
 * wedge in the act").
 *
 * THE MECHANISM, AND WHY IT IS THIS ONE:
 *
 * A blocked event loop starves every in-loop mechanism simultaneously — timers,
 * signal handlers registered through libuv (`process.on('SIGUSR2', …)`), and
 * Node's own `--report-on-signal` (upstream nodejs/node#56879 confirms the
 * report trigger is loop-fed and never fires under an infinite loop; verified
 * empirically on Node v24: an armed reportOnSignal produced nothing while the
 * loop was blocked). So the detector MUST NOT live on the loop it watches.
 *
 * This implementation is a worker thread plus a gdb attach:
 *
 *   1. The main thread bumps a heartbeat counter in a SharedArrayBuffer on a
 *      250 ms timer. Cheap: one Atomics add per tick.
 *   2. A worker thread — which has its own event loop, unblocked by anything
 *      the main loop does — polls the counter every 500 ms.
 *   3. When the counter has not moved for `thresholdMs`, the worker spawns
 *      `gdb -p <main pid> -batch -ex "thread apply all bt"`, which ATTACHES to
 *      the blocked process, prints every thread's stack (the V8 runtime frame
 *      the loop is spinning in is named — e.g. `v8::internal::Runtime_*`), and
 *      detaches. The process keeps running exactly as it was. Verified under a
 *      deliberately-induced busy loop: the dump lands on disk WHILE the loop
 *      is still spinning, which is the test that distinguishes a real watchdog
 *      from a same-loop timer.
 *
 * NO SIGNAL HANDLERS ARE USED. SIGUSR2 is claimed by the heap-snapshot hook
 * (the heap/inotify subtask of the same feature) and the signal route is
 * loop-starved anyway; the worker-plus-attach route claims nothing and needs
 * nothing from the loop under observation.
 *
 * The dump goes to `<diagnosticsDir>/eventloop-stall-<timestamp>.txt`, mode
 * 0600, never served over HTTP (a blocked loop cannot serve; the file is the
 * only surface). A pointer file `last-eventloop-stall.txt` names the newest
 * dump, and a bounded `stall-history.log` records every episode so repeated
 * wedges are countable. If gdb is not installed, the dump still records the
 * stall with each thread's kernel wait-channel from /proc (a weaker but
 * non-empty answer — never a silent no).
 */

import { Worker } from 'worker_threads';
import * as fs from 'fs';
import * as path from 'path';

export interface EventLoopWatchdogOptions {
    /** Stall duration before a dump fires. Default 10_000 ms. */
    thresholdMs?: number;
    /** Directory for dump files. Created 0700 if absent. */
    diagnosticsDir: string;
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
}

export interface EventLoopWatchdogHandle {
    stop(): void;
}

const HEARTBEAT_INTERVAL_MS = 250;
const WORKER_POLL_MS = 500;
const HISTORY_CAP_BYTES = 32 * 1024;

// The worker source is inlined (eval: true) so the watchdog does not depend on
// a second compiled artifact being present next to the host bundle.
const WORKER_SOURCE = `
const { parentPort, workerData } = require('worker_threads');
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const hb = new Int32Array(workerData.sab);
const status = new Int32Array(workerData.statusSab);
const threshold = workerData.thresholdMs;
const pid = workerData.pid;
const dir = workerData.dir;
const historyCap = workerData.historyCapBytes;
let lastVal = Atomics.load(hb, 0);
let lastChange = Date.now();
let fired = false;

function appendHistory(line) {
    try {
        const file = path.join(dir, 'stall-history.log');
        let body = '';
        try { body = fs.readFileSync(file, 'utf8'); } catch { /* first line */ }
        body += line + '\\n';
        if (body.length > historyCap) { body = body.slice(-historyCap); }
        fs.writeFileSync(file, body, { mode: 0o600 });
    } catch { /* history is best-effort */ }
}

setInterval(() => {
    const v = Atomics.load(hb, 0);
    if (v !== lastVal) {
        lastVal = v;
        lastChange = Date.now();
        if (fired) {
            // Episode over: tell the (now recovered) main thread it wedged.
            fired = false;
        }
        Atomics.store(status, 0, 0);
        return;
    }
    const stalledFor = Date.now() - lastChange;
    if (!fired && stalledFor > threshold) {
        fired = true;
        Atomics.store(status, 0, 1);
        const iso = new Date().toISOString();
        const ts = iso.replace(/[:.]/g, '-');
        const file = path.join(dir, 'eventloop-stall-' + ts + '.txt');
        let body = 'event loop stall: no heartbeat for ' + Math.round(stalledFor / 1000)
            + 's at ' + iso + ' (pid ' + pid + ')\\n'
            + 'captured by the out-of-loop watchdog worker; gdb attach below ran while the loop was still blocked\\n';
        let gdbNote = '';
        try {
            const r = spawnSync('gdb', ['-p', String(pid), '-batch', '-ex', 'thread apply all bt'], { timeout: 30000 });
            if (r.error && r.error.code === 'ENOENT') {
                gdbNote = 'gdb not installed — kernel wait-channel fallback follows; install gdb for JS-stack-level dumps\\n';
                try {
                    const tasks = fs.readdirSync('/proc/' + pid + '/task');
                    for (const tid of tasks.slice(0, 32)) {
                        try {
                            const stat = fs.readFileSync('/proc/' + pid + '/task/' + tid + '/stat', 'utf8');
                            const wchan = fs.readFileSync('/proc/' + pid + '/task/' + tid + '/wchan', 'utf8').trim();
                            body += 'tid ' + tid + ' wchan=' + wchan + ' ' + stat.split(') ')[1] + '\\n';
                        } catch { /* thread gone */ }
                    }
                } catch { /* proc unavailable */ }
            } else {
                body += '\\n=== gdb thread apply all bt (captured while blocked) ===\\n' + (r.stdout || '') + (r.stderr || '');
            }
        } catch (e) {
            gdbNote = 'gdb attach failed: ' + (e && e.message ? e.message : String(e)) + '\\n';
        }
        if (gdbNote) { body += '\\n' + gdbNote; }
        try {
            fs.writeFileSync(file, body, { mode: 0o600 });
            fs.writeFileSync(path.join(dir, 'last-eventloop-stall.txt'), file, { mode: 0o600 });
            appendHistory(iso + ' stall=' + Math.round(stalledFor / 1000) + 's dump=' + file);
        } catch (e2) {
            appendHistory(iso + ' stall=' + Math.round(stalledFor / 1000) + 's DUMP WRITE FAILED: ' + (e2 && e2.message ? e2.message : String(e2)));
        }
        try { parentPort.postMessage({ file, stalledFor }); } catch { /* main loop may be blocked; the file is the record */ }
    }
}, ${WORKER_POLL_MS});
`;

export function startEventLoopWatchdog(opts: EventLoopWatchdogOptions): EventLoopWatchdogHandle {
    const thresholdMs = opts.thresholdMs ?? 10_000;
    const log = opts.log ?? ((m: string) => console.log(`[eventloop-watchdog] ${m}`));
    const warn = opts.warn ?? ((m: string) => console.warn(`[eventloop-watchdog] ${m}`));

    try {
        fs.mkdirSync(opts.diagnosticsDir, { recursive: true, mode: 0o700 });
    } catch { /* may already exist */ }

    const sab = new SharedArrayBuffer(4);
    const statusSab = new SharedArrayBuffer(4);
    const hb = new Int32Array(sab);
    const status = new Int32Array(statusSab);

    const worker = new Worker(WORKER_SOURCE, {
        eval: true,
        workerData: {
            sab,
            statusSab,
            thresholdMs,
            pid: process.pid,
            dir: opts.diagnosticsDir,
            historyCapBytes: HISTORY_CAP_BYTES,
        },
    });
    worker.on('error', (err) => warn(`worker failed: ${err.message}`));
    worker.on('message', (m: { file: string; stalledFor: number }) => {
        warn(`event loop stalled ${Math.round(m.stalledFor / 1000)}s; stack dump written to ${m.file}`);
    });

    const heartbeat = setInterval(() => { Atomics.add(hb, 0, 1); }, HEARTBEAT_INTERVAL_MS);
    heartbeat.unref?.();

    let stopped = false;
    return {
        stop(): void {
            if (stopped) { return; }
            stopped = true;
            clearInterval(heartbeat);
            void worker.terminate();
            log('stopped');
        },
    };
}
