/**
 * Periodic probe sampler and memory / inotify drift monitor.
 *
 * Samples `process.memoryUsage()`, inotify watch count, and open fd count
 * at a regular interval. Keeps a small, bounded circular buffer in memory
 * (e.g. 20 samples) so monitoring itself never leaks memory.
 *
 * Emits warnings if:
 * 1. Idle RSS crosses the documented ceiling (350 MB) when no active terminals are live.
 * 2. inotifyDescriptors crosses a fraction of `max_user_watches` (or exceeds ceiling).
 */

import * as os from 'os';
import * as fs from 'fs';
import { getInotifyWatchCount, getInotifyCeiling } from './inotifyWatchCount';
import { getOpenFdCount } from '../standalone/planIngestionHost';

export interface ProbeSample {
    timestamp: string;
    pid: number;
    rss: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    arrayBuffers: number;
    inotifyDescriptors: number;
    openFds: number;
}

export interface ProbeSamplerOptions {
    intervalMs?: number;
    maxHistory?: number;
    idleRssCeilingMb?: number;
    getActiveTerminalCount?: () => number;
    log?: (msg: string) => void;
    warn?: (msg: string) => void;
}

export class ProbeSamplingService {
    private static _instance?: ProbeSamplingService;
    private _timer?: NodeJS.Timeout;
    private readonly _history: ProbeSample[] = [];
    private readonly _maxHistory: number;
    private readonly _intervalMs: number;
    private readonly _idleRssCeilingMb: number;
    private readonly _getActiveTerminalCount?: () => number;
    private readonly _log: (msg: string) => void;
    private readonly _warn: (msg: string) => void;

    constructor(options: ProbeSamplerOptions = {}) {
        this._maxHistory = options.maxHistory ?? 20;
        this._intervalMs = options.intervalMs ?? 60000; // 1 minute default
        this._idleRssCeilingMb = options.idleRssCeilingMb ?? 350;
        this._getActiveTerminalCount = options.getActiveTerminalCount;
        this._log = options.log ?? ((m: string) => console.log(`[ProbeSamplingService] ${m}`));
        this._warn = options.warn ?? ((m: string) => console.warn(`[ProbeSamplingService] ${m}`));
    }

    public static getInstance(options?: ProbeSamplerOptions): ProbeSamplingService {
        if (!ProbeSamplingService._instance) {
            ProbeSamplingService._instance = new ProbeSamplingService(options);
        }
        return ProbeSamplingService._instance;
    }

    public start(): void {
        if (this._timer) return;
        // Take initial sample immediately
        this.sample();
        this._timer = setInterval(() => {
            try {
                this.sample();
            } catch (e) {
                // Sampler must tolerate failures without crashing
            }
        }, this._intervalMs);
        if (typeof (this._timer as any).unref === 'function') {
            (this._timer as any).unref();
        }
    }

    public stop(): void {
        if (this._timer) {
            clearInterval(this._timer);
            this._timer = undefined;
        }
    }

    public sample(): ProbeSample {
        let mem: NodeJS.MemoryUsage;
        try {
            mem = process.memoryUsage();
        } catch {
            mem = { rss: 0, heapUsed: 0, heapTotal: 0, external: 0, arrayBuffers: 0 };
        }

        const pid = process.pid;
        let inotify = 0;
        try {
            inotify = getInotifyWatchCount(pid) ?? 0;
        } catch {}

        let openFds = 0;
        try {
            openFds = getOpenFdCount(pid) ?? 0;
        } catch {}

        const sample: ProbeSample = {
            timestamp: new Date().toISOString(),
            pid,
            rss: mem.rss,
            heapUsed: mem.heapUsed,
            heapTotal: mem.heapTotal,
            external: mem.external,
            arrayBuffers: mem.arrayBuffers,
            inotifyDescriptors: inotify,
            openFds,
        };

        this._history.push(sample);
        while (this._history.length > this._maxHistory) {
            this._history.shift();
        }

        this._checkDrift(sample);
        return sample;
    }

    public getHistory(): ProbeSample[] {
        return [...this._history];
    }

    public getLatestSample(): ProbeSample | undefined {
        return this._history[this._history.length - 1];
    }

    private _checkDrift(sample: ProbeSample): void {
        const terminalCount = this._getActiveTerminalCount ? this._getActiveTerminalCount() : 0;
        const rssMb = sample.rss / (1024 * 1024);

        if (terminalCount === 0 && rssMb > this._idleRssCeilingMb) {
            this._warn(`DRIFT WARNING: host RSS ${rssMb.toFixed(1)} MB exceeds idle ceiling of ${this._idleRssCeilingMb} MB with 0 terminals active`);
        }

        const watchCeiling = getInotifyCeiling();
        if (sample.inotifyDescriptors >= watchCeiling) {
            this._warn(`DRIFT WARNING: inotify watch count ${sample.inotifyDescriptors} has reached or exceeded ceiling of ${watchCeiling}`);
        }
    }
}
