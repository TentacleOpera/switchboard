/**
 * Host capability measurement and headroom reporting.
 *
 * Reads total memory, available memory, core count, and cgroup memory limits
 * once at startup. Tags every figure with its source ('cgroup' | 'os' | 'unavailable')
 * per the fallback rule: 'unavailable' must never resolve to a plausible number.
 * Consumers treat 'unavailable' / unknown as "do not constrain".
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/**
 * Sample RSS bytes for a given PID.
 * On Linux, reads /proc/<pid>/statm resident pages * page size.
 * Returns null if unavailable or unreadable.
 */
export function sampleProcessRss(pid: number | undefined): number | null {
    if (!pid || typeof pid !== 'number' || pid <= 0) return null;
    if (process.platform === 'linux') {
        try {
            const statm = fs.readFileSync(`/proc/${pid}/statm`, 'utf8');
            const parts = statm.trim().split(/\s+/);
            if (parts.length >= 2) {
                const pages = parseInt(parts[1], 10);
                if (!isNaN(pages) && pages > 0) {
                    return pages * 4096;
                }
            }
        } catch {
            return null;
        }
    }
    return null;
}

export type CapabilitySource = 'cgroup' | 'os' | 'unavailable';

export interface HostCapabilityReading<T> {
    value: T;
    source: CapabilitySource;
}

export interface HostCapabilitySummary {
    totalMemoryBytes: number | null;
    totalMemorySource: CapabilitySource;
    availableMemoryBytes: number | null;
    availableMemorySource: CapabilitySource;
    cores: number | null;
    coresSource: CapabilitySource;
    isConstrained: boolean;
    cgroupLimitBytes: number | null;
}

export interface HeadroomCheckResult {
    exceeded: boolean;
    runningSeats: number;
    memoryUsedBytes: number;
    memoryTotalBytes: number;
    estimatedPerSeatBytes: number;
    projectedTotalBytes: number;
    source: CapabilitySource;
}

export class HostCapabilityService {
    private readonly _totalMemory: HostCapabilityReading<number | null>;
    private readonly _cores: HostCapabilityReading<number | null>;
    private readonly _cgroupLimitBytes: number | null;
    private readonly _isConstrained: boolean;

    constructor() {
        // 1. Measure cores
        let coresVal: number | null = null;
        let coresSrc: CapabilitySource = 'unavailable';
        try {
            const cpus = os.cpus();
            if (cpus && cpus.length > 0) {
                coresVal = cpus.length;
                coresSrc = 'os';
            } else if (typeof (os as any).availableParallelism === 'function') {
                const p = (os as any).availableParallelism();
                if (typeof p === 'number' && p > 0) {
                    coresVal = p;
                    coresSrc = 'os';
                }
            }
        } catch (err) {
            console.warn('[HostCapability] Failed to read CPU count:', err);
        }
        this._cores = { value: coresVal, source: coresSrc };

        // 2. Measure cgroup limit
        const cgroupLimit = HostCapabilityService._readCgroupLimit();
        this._cgroupLimitBytes = cgroupLimit;

        // 3. Measure total memory
        let totalVal: number | null = null;
        let totalSrc: CapabilitySource = 'unavailable';
        try {
            const osTotal = os.totalmem();
            if (typeof osTotal === 'number' && osTotal > 0) {
                if (cgroupLimit !== null && cgroupLimit < osTotal) {
                    totalVal = cgroupLimit;
                    totalSrc = 'cgroup';
                } else {
                    totalVal = osTotal;
                    totalSrc = 'os';
                }
            } else if (cgroupLimit !== null) {
                totalVal = cgroupLimit;
                totalSrc = 'cgroup';
            }
        } catch (err) {
            console.warn('[HostCapability] Failed to read total memory:', err);
            if (cgroupLimit !== null) {
                totalVal = cgroupLimit;
                totalSrc = 'cgroup';
            }
        }
        this._totalMemory = { value: totalVal, source: totalSrc };

        // 4. Threshold determination
        // Constrained host threshold: <= 4.25 GB (covers 4GB machines / Pi 400 with 3.7GB) or <= 4 cores
        // If capability is unavailable / unknown -> treat as NOT constrained (never guess small or large).
        if (this._totalMemory.source !== 'unavailable' && this._totalMemory.value !== null) {
            const fourGiBPlusSlack = 4.25 * 1024 * 1024 * 1024;
            const isMemConstrained = this._totalMemory.value <= fourGiBPlusSlack;
            const isCoreConstrained = this._cores.value !== null && this._cores.value <= 4;
            this._isConstrained = isMemConstrained || isCoreConstrained;
        } else {
            this._isConstrained = false;
        }

        console.log(
            `[HostCapability] Initialized: memory=${this._totalMemory.value ? (this._totalMemory.value / (1024 * 1024 * 1024)).toFixed(2) + ' GB' : 'unknown'} (${this._totalMemory.source}), ` +
            `cores=${this._cores.value ?? 'unknown'} (${this._cores.source}), constrained=${this._isConstrained}`
        );
    }

    public static _readCgroupLimit(): number | null {
        if (process.platform !== 'linux') {
            return null;
        }

        // Try cgroup v2
        try {
            // First check /proc/self/cgroup to see if process is in a sub-cgroup
            let cgroupPath = '';
            if (fs.existsSync('/proc/self/cgroup')) {
                const lines = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n');
                for (const line of lines) {
                    // v2 is "0::<path>"
                    const parts = line.split(':');
                    if (parts.length === 3 && (parts[0] === '0' || parts[1] === '')) {
                        cgroupPath = parts[2].trim();
                        break;
                    }
                }
            }

            // Check specific slice/scope path first if found
            if (cgroupPath && cgroupPath !== '/') {
                const subMaxFile = path.join('/sys/fs/cgroup', cgroupPath, 'memory.max');
                if (fs.existsSync(subMaxFile)) {
                    const raw = fs.readFileSync(subMaxFile, 'utf8').trim();
                    if (raw && raw !== 'max') {
                        const parsed = parseInt(raw, 10);
                        if (!isNaN(parsed) && parsed > 0) {
                            return parsed;
                        }
                    }
                }
            }

            // Check root v2 memory.max
            if (fs.existsSync('/sys/fs/cgroup/memory.max')) {
                const raw = fs.readFileSync('/sys/fs/cgroup/memory.max', 'utf8').trim();
                if (raw && raw !== 'max') {
                    const parsed = parseInt(raw, 10);
                    if (!isNaN(parsed) && parsed > 0) {
                        return parsed;
                    }
                }
            }
        } catch {
            // ignore cgroup v2 read errors
        }

        // Try cgroup v1
        try {
            const v1File = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
            if (fs.existsSync(v1File)) {
                const raw = fs.readFileSync(v1File, 'utf8').trim();
                if (raw) {
                    const parsed = parseInt(raw, 10);
                    // cgroup v1 uses a huge number (~0x7FFFFFFFFFFFF000) when no limit is set
                    if (!isNaN(parsed) && parsed > 0 && parsed < 0x7FFFFFFFFFFFF000) {
                        return parsed;
                    }
                }
            }
        } catch {
            // ignore cgroup v1 read errors
        }

        return null;
    }

    /**
     * Read this cgroup's current memory usage (v2 memory.current, falling
     * back to v1 memory.usage_in_bytes). Mirrors _readCgroupLimit's path
     * resolution so limit and usage come from the same hierarchy. Returns
     * null when unreadable — the caller reports nothing rather than a guess.
     */
    public static _readCgroupUsage(): number | null {
        if (process.platform !== 'linux') {
            return null;
        }
        // cgroup v2
        try {
            let cgroupPath = '';
            if (fs.existsSync('/proc/self/cgroup')) {
                const lines = fs.readFileSync('/proc/self/cgroup', 'utf8').split('\n');
                for (const line of lines) {
                    const parts = line.split(':');
                    if (parts.length === 3 && (parts[0] === '0' || parts[1] === '')) {
                        cgroupPath = parts[2].trim();
                        break;
                    }
                }
            }
            const candidates = cgroupPath && cgroupPath !== '/'
                ? [path.join('/sys/fs/cgroup', cgroupPath, 'memory.current'), '/sys/fs/cgroup/memory.current']
                : ['/sys/fs/cgroup/memory.current'];
            for (const file of candidates) {
                if (fs.existsSync(file)) {
                    const parsed = parseInt(fs.readFileSync(file, 'utf8').trim(), 10);
                    if (!isNaN(parsed) && parsed >= 0) {
                        return parsed;
                    }
                }
            }
        } catch {
            // ignore cgroup v2 read errors
        }
        // cgroup v1
        try {
            const v1File = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
            if (fs.existsSync(v1File)) {
                const parsed = parseInt(fs.readFileSync(v1File, 'utf8').trim(), 10);
                if (!isNaN(parsed) && parsed >= 0) {
                    return parsed;
                }
            }
        } catch {
            // ignore cgroup v1 read errors
        }
        return null;
    }

    public getSummary(): HostCapabilitySummary {
        let availableVal: number | null = null;
        let availableSrc: CapabilitySource = 'unavailable';
        try {
            const free = os.freemem();
            if (typeof free === 'number' && free >= 0) {
                availableVal = free;
                availableSrc = 'os';
            }
        } catch {
            // unavailable
        }

        return {
            totalMemoryBytes: this._totalMemory.value,
            totalMemorySource: this._totalMemory.source,
            availableMemoryBytes: availableVal,
            availableMemorySource: availableSrc,
            cores: this._cores.value,
            coresSource: this._cores.source,
            isConstrained: this._isConstrained,
            cgroupLimitBytes: this._cgroupLimitBytes,
        };
    }

    public isConstrained(): boolean {
        return this._isConstrained;
    }

    public getTotalMemory(): HostCapabilityReading<number | null> {
        return this._totalMemory;
    }

    public getCores(): HostCapabilityReading<number | null> {
        return this._cores;
    }

    /**
     * Check if dispatching another seat would exceed the host's measured headroom.
     * Observed RSS is sampled from running seats; if no seats are running, estimate is
     * sampled from process RSS or defaults to 0 (no fallback constant that behaves like a measurement).
     *
     * @param runningSeatCount Number of seats currently running.
     * @param observedSeatRssList Array of observed RSS bytes for running seats.
     */
    public checkDispatchHeadroom(
        runningSeatCount: number,
        observedSeatRssList: number[]
    ): HeadroomCheckResult | null {
        if (this._totalMemory.source === 'unavailable' || this._totalMemory.value === null) {
            // Unknown stays cheap: no ceiling reported when capability is unavailable
            return null;
        }

        const totalMem = this._totalMemory.value;
        let memUsed: number;
        if (this._totalMemory.source === 'cgroup') {
            // os.freemem() is host-wide, not cgroup-scoped: against a cgroup
            // total it goes negative and the check would never fire — exactly
            // the constrained case the report exists for. Read the cgroup's own
            // usage instead; if that is unreadable, report nothing rather than
            // a plausible wrong figure.
            const cgroupUsage = HostCapabilityService._readCgroupUsage();
            if (cgroupUsage === null) {
                return null;
            }
            memUsed = cgroupUsage;
        } else {
            try {
                memUsed = totalMem - os.freemem();
            } catch {
                return null;
            }
        }

        // Per-seat RSS estimate from observed values of running seats
        let estimatedPerSeatBytes: number;
        const validRss = observedSeatRssList.filter(n => typeof n === 'number' && n > 0);
        if (validRss.length > 0) {
            const sum = validRss.reduce((a, b) => a + b, 0);
            estimatedPerSeatBytes = Math.round(sum / validRss.length);
        } else {
            // If no seats running yet, sample board process's own RSS as lower bound
            try {
                estimatedPerSeatBytes = process.memoryUsage().rss;
            } catch {
                estimatedPerSeatBytes = 0;
            }
        }

        const projectedTotal = memUsed + estimatedPerSeatBytes;
        const exceeded = projectedTotal > totalMem;

        return {
            exceeded,
            runningSeats: runningSeatCount,
            memoryUsedBytes: memUsed,
            memoryTotalBytes: totalMem,
            estimatedPerSeatBytes,
            projectedTotalBytes: projectedTotal,
            source: this._totalMemory.source,
        };
    }
}
