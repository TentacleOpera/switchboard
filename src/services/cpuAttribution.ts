/**
 * Per-process CPU attribution.
 *
 * Plan: attribute-switchboards-cpu-before-optimising-it (step 1 — the
 * load-bearing step). Makes "Switchboard is at 90%" resolvable into a named
 * list: the board process, the Go pty host child, each named CLI seat, and —
 * separately, because it is a different process tree — the browser, plus the
 * machine's OS-reported total so the attributed sum can be checked against it.
 *
 * DESIGN CONSTRAINTS (from the plan's Complexity Audit):
 * - The sampler must not become a measurable load — a sampler that costs CPU
 *   corrupts the measurement. Sampling is one /proc read per process at a low
 *   cadence (default 5 s), and the snapshot records `samplerSelfMs`, the wall
 *   time the last sample took, so its own cost is visible in its own output.
 * - CPU percent per process is jiffies-delta'd between consecutive samples
 *   (/proc/<pid>/stat utime+stime), NOT instantaneous — a single read cannot
 *   produce a rate.
 * - Browser attribution is by process-name match over /proc, which is a
 *   heuristic: the snapshot tags it `matchedBy: 'process-name'` rather than
 *   presenting it as a parent-child fact. A wrong guess must be readable as
 *   one, per the fallback rule.
 *
 * HOST SCOPE (plan verification 7): the service runs in whichever host process
 * wires it — the standalone board (bootstrap.ts) and the extension host
 * (TaskViewerProvider.ts) each construct their own. The snapshot's
 * `hostScope` says which. Output-volume counters come from the board's
 * /ws/terminal proxy splice, which both hosts serve; an absent
 * `volumeStats` means "not measured on this host", never "zero".
 */

import * as fs from 'fs';

export interface SeatPidEntry {
    name: string;
    pid: number;
}

export interface CpuAttributionOptions {
    /** PID of the Go pty host child. Polled each sample; may be absent. */
    getPtyHostPid?: () => number | undefined;
    /** Named CLI seat pids. Polled each sample; may be async in the extension host. */
    getSeats?: () => SeatPidEntry[] | Promise<SeatPidEntry[]>;
    /**
     * Per-terminal output volume stats, measured on the board's /ws/terminal
     * proxy splice (the path the bytes actually take — the retired
     * terminalWsGateway is not constructed by any host). Both hosts serve the
     * proxy, so both can wire this.
     */
    getVolumeStats?: () => Record<string, TerminalVolumeStats> | undefined;
    /** Sample cadence. Default 5000 ms. */
    intervalMs?: number;
    /** 'standalone' | 'extension' — recorded on every snapshot. */
    hostScope: 'standalone' | 'extension';
    log?: (msg: string) => void;
}

export interface TerminalVolumeStats {
    bytesOutPerSec: number;
    bytesInPerSec: number;
    peakBytesPerSec: number;
    /** True when the seat is over the pathological-output ceiling RIGHT NOW. */
    overCeiling: boolean;
}

export interface ProcessCpuSample {
    role: 'board' | 'pty-host' | 'seat' | 'browser';
    name?: string;
    pid: number;
    cpuPercent: number;
    rssBytes: number;
}

export interface CpuAttributionSnapshot {
    timestamp: string;
    hostScope: 'standalone' | 'extension';
    processes: ProcessCpuSample[];
    /** Browser processes are matched by name over /proc — a heuristic, tagged as such. */
    browserMatchedBy: 'process-name' | null;
    osCpuPercent: number;
    /** Sum of every attributed process (including browser, when matched). */
    attributedPercent: number;
    /** OS total minus attributed — everything the surface did not name. */
    residualPercent: number;
    /** Wall time the last sample took — the sampler's own visible cost. */
    samplerSelfMs: number;
    /** Per-terminal wire volume from the /ws/terminal proxy splice. */
    volumeStats?: Record<string, TerminalVolumeStats>;
}

interface PrevSample {
    jiffies: number;
    at: number;
}

const CLK_TCK = 100; // universal on Linux userspace; /proc jiffies are clk_tck-sized
const BROWSER_COMM_PATTERNS = [
    'chromium', 'chrome', 'firefox', 'epiphany', 'webview', 'WebKitWebProcess',
    'msedge', 'vivaldi', 'brave', 'opera',
];

function readStatJiffiesAndRss(pid: number): { jiffies: number; rssBytes: number } | null {
    try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        // Field 2 (comm) can contain spaces and parens — split after the LAST ')'.
        const close = stat.lastIndexOf(')');
        if (close < 0) { return null; }
        const fields = stat.slice(close + 2).split(' ');
        // After ')' the next field is state (field 3). utime is field 14,
        // stime field 15 → indices 11 and 12 in this slice.
        const utime = parseInt(fields[11], 10);
        const stime = parseInt(fields[12], 10);
        // rss is field 24 → index 21; expressed in pages.
        const rssPages = parseInt(fields[21], 10);
        if (isNaN(utime) || isNaN(stime)) { return null; }
        return {
            jiffies: utime + stime,
            rssBytes: isNaN(rssPages) ? 0 : rssPages * 4096,
        };
    } catch {
        return null;
    }
}

function readOsCpuTotals(): { total: number; idle: number } | null {
    try {
        const line = fs.readFileSync('/proc/stat', 'utf8').split('\n')[0];
        const parts = line.trim().split(/\s+/).slice(1).map(v => parseInt(v, 10));
        if (parts.length < 5 || parts.some(isNaN)) { return null; }
        const idle = parts[3] + (parts[4] || 0); // idle + iowait
        const total = parts.reduce((a, b) => a + b, 0);
        return { total, idle };
    } catch {
        return null;
    }
}

function scanBrowserPids(): number[] {
    const out: number[] = [];
    try {
        const entries = fs.readdirSync('/proc').filter(d => /^\d+$/.test(d));
        for (const pidStr of entries) {
            try {
                const comm = fs.readFileSync(`/proc/${pidStr}/comm`, 'utf8').trim().toLowerCase();
                if (comm && BROWSER_COMM_PATTERNS.some(p => comm.includes(p.toLowerCase()))) {
                    out.push(parseInt(pidStr, 10));
                }
            } catch { /* process gone or unreadable */ }
        }
    } catch { /* /proc unavailable */ }
    return out;
}

export class CpuAttributionService {
    private readonly _opts: CpuAttributionOptions;
    private readonly _prev = new Map<number, PrevSample>();
    private _prevOs: { total: number; idle: number; at: number } | null = null;
    private _timer?: NodeJS.Timeout;
    private _latest?: CpuAttributionSnapshot;
    private readonly _log: (msg: string) => void;

    constructor(opts: CpuAttributionOptions) {
        this._opts = opts;
        this._log = opts.log ?? ((m: string) => console.log(`[cpuAttribution] ${m}`));
    }

    public start(): void {
        if (this._timer || process.platform !== 'linux') { return; }
        this.sample(); // first sample seeds the deltas
        this._timer = setInterval(() => {
            try { void this.sample(); } catch { /* a failed sample never takes the host down */ }
        }, this._opts.intervalMs ?? 5000);
        this._timer.unref?.();
    }

    public stop(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
    }

    public getLatest(): CpuAttributionSnapshot | undefined {
        return this._latest;
    }

    public async sample(): Promise<CpuAttributionSnapshot> {
        const t0 = process.hrtime.bigint();
        const now = Date.now();
        const processes: ProcessCpuSample[] = [];
        const seen = new Set<number>();

        const measure = (role: ProcessCpuSample['role'], pid: number, name?: string): void => {
            if (!pid || pid <= 0 || seen.has(pid)) { return; }
            const cur = readStatJiffiesAndRss(pid);
            if (!cur) { return; }
            seen.add(pid);
            const prev = this._prev.get(pid);
            this._prev.set(pid, { jiffies: cur.jiffies, at: now });
            let cpuPercent = 0;
            if (prev) {
                const elapsed = (now - prev.at) / 1000;
                if (elapsed > 0) {
                    cpuPercent = ((cur.jiffies - prev.jiffies) / CLK_TCK) / elapsed * 100;
                }
            }
            processes.push({ role, name, pid, cpuPercent: Math.round(cpuPercent * 10) / 10, rssBytes: cur.rssBytes });
        };

        measure('board', process.pid);
        const ptyHostPid = this._opts.getPtyHostPid?.();
        if (ptyHostPid) { measure('pty-host', ptyHostPid); }
        try {
            const seats = await this._opts.getSeats?.();
            for (const seat of seats ?? []) { measure('seat', seat.pid, seat.name); }
        } catch { /* seat list unreadable this tick — board and pty host still attribute */ }
        for (const pid of scanBrowserPids()) { measure('browser', pid); }

        // OS total.
        let osCpuPercent = 0;
        const osTotals = readOsCpuTotals();
        if (osTotals && this._prevOs) {
            const dTotal = osTotals.total - this._prevOs.total;
            const dIdle = osTotals.idle - this._prevOs.idle;
            if (dTotal > 0) {
                osCpuPercent = Math.max(0, (1 - dIdle / dTotal)) * 100;
            }
        }
        if (osTotals) { this._prevOs = { ...osTotals, at: now }; }

        // Drop dead pids from the delta table so it cannot grow unbounded.
        for (const pid of Array.from(this._prev.keys())) {
            if (!seen.has(pid)) { this._prev.delete(pid); }
        }

        const attributedPercent = Math.round(processes.reduce((a, p) => a + p.cpuPercent, 0) * 10) / 10;
        const browserCount = processes.filter(p => p.role === 'browser').length;
        const samplerSelfMs = Number(process.hrtime.bigint() - t0) / 1e6;

        const snapshot: CpuAttributionSnapshot = {
            timestamp: new Date().toISOString(),
            hostScope: this._opts.hostScope,
            processes,
            browserMatchedBy: browserCount > 0 ? 'process-name' : null,
            osCpuPercent: Math.round(osCpuPercent * 10) / 10,
            attributedPercent,
            residualPercent: Math.round((osCpuPercent - attributedPercent) * 10) / 10,
            samplerSelfMs: Math.round(samplerSelfMs * 1000) / 1000,
        };
        if (this._opts.getVolumeStats) {
            const volume = this._opts.getVolumeStats();
            if (volume) { snapshot.volumeStats = volume; }
        }
        this._latest = snapshot;
        return snapshot;
    }
}
