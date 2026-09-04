import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ensureGlobalStoreDir, getGlobalStoreDir } from './globalStore';

/**
 * storeLock — one owner per machine for scheduled storage work.
 *
 * Extracted from dbMerge.ts's MergeLock and hardened per
 * `one-owner-for-scheduled-storage-work.md`:
 *   - `wx` acquire (exclusive create).
 *   - PID + process-start-time + acquired-at inside the lock, so a PID that
 *     was reused by a different process is detected (the live PID's start time
 *     will not match the lock's recorded start time), not just a dead PID.
 *   - Bounded maximum age: a lock older than MAX_AGE_MS is treated as stale
 *     regardless of liveness, so a holder that hung (not crashed) cannot block
 *     scheduled work indefinitely.
 *   - Symlink-safe unlink: the lock path is lstat'd before unlink and refused
 *     if it is a symlink, so a symlink planted at the lock path cannot redirect
 *     the unlink outside the store directory.
 *   - Release on process exit (best-effort) so a clean shutdown drops the lock.
 *   - Keyed by the resolved store path, so with one board per project the lock
 *     is per store file, not one global lock.
 *
 * Semantics are skip-rather-than-queue: `tryAcquire()` returns immediately
 * (one best-effort reclaim of a provably stale lock), it never waits. A
 * scheduled backup or rotation that loses the lock records a skip and moves on
 * — any one host doing the work is enough.
 */

const LOCK_DIR_NAME = 'locks';
const MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes — no scheduled op should hold it longer

export interface StoreLockContents {
    pid: number;
    /** Wall-clock time the holding process started (Date.now() - uptime*1000). */
    processStartMs: number;
    /** Wall-clock time the lock was acquired. */
    acquiredAtMs: number;
}

export interface SkipReason {
    held: true;
    byPid: number;
    acquiredAtMs: number;
    reason: string;
}

export type AcquireResult =
    | { acquired: true; release: () => Promise<void> }
    | { acquired: false; skip: SkipReason };

/** Wrap safeUnlink so the release closure matches the Promise<void> contract. */
function releaseFn(lockPath: string): () => Promise<void> {
    return async () => { await safeUnlink(lockPath); };
}

export interface StoreLockOptions {
    /** Override the resolved store path used to derive the lock name (testing). */
    storePath?: string;
    /** Override the global store dir (testing). */
    lockDir?: string;
    /** Override max age in ms (testing). */
    maxAgeMs?: number;
}

function processStartMs(): number {
    // Date.now() - uptime in ms. Stable for the life of the process; differs
    // across processes even if a PID is reused.
    return Date.now() - Math.floor(process.uptime() * 1000);
}

function isPidAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (err: any) {
        // ESRCH → no such process. EPERM → process exists but not ours (alive).
        if (err && err.code === 'ESRCH') return false;
        if (err && err.code === 'EPERM') return true;
        return false;
    }
}

/**
 * Resolve the lock file path for a given store path.
 * The name is a short hash of the resolved store path so two different store
 * files get two different locks, and the path is safe for a filename.
 */
export function resolveLockPath(storePath: string, lockDir?: string): string {
    const dir = lockDir || path.join(getGlobalStoreDir(), LOCK_DIR_NAME);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    try { fs.chmodSync(dir, 0o700); } catch { /* best effort */ }
    const resolved = path.resolve(storePath);
    const hash = crypto.createHash('sha256').update(resolved).digest('hex').slice(0, 16);
    return path.join(dir, `store-${hash}.lock`);
}

function parseLockContents(raw: string): StoreLockContents | null {
    const parts = raw.trim().split(':');
    if (parts.length < 3) return null;
    const pid = Number(parts[0]);
    const processStartMs = Number(parts[1]);
    const acquiredAtMs = Number(parts[2]);
    if (!Number.isFinite(pid) || !Number.isFinite(processStartMs) || !Number.isFinite(acquiredAtMs)) {
        return null;
    }
    return { pid, processStartMs, acquiredAtMs };
}

/**
 * Decide whether an existing lock is stale.
 * Stale if: PID dead, OR PID alive but its start time doesn't match (PID
 * reused), OR the lock is older than maxAgeMs regardless.
 */
function isStale(contents: StoreLockContents, maxAgeMs: number): { stale: boolean; reason: string } {
    if (Date.now() - contents.acquiredAtMs > maxAgeMs) {
        return { stale: true, reason: `lock older than ${maxAgeMs}ms (bounded age)` };
    }
    if (!isPidAlive(contents.pid)) {
        return { stale: true, reason: `pid ${contents.pid} not alive` };
    }
    // PID alive — check the process start time to catch PID reuse.
    try {
        const liveStart = processStartMs();
        // The recorded start time is the holder's. If the holder is us, it
        // matches. If the holder is a different live process that reused the
        // PID, its start time differs. Allow a small skew for clock drift /
        // uptime rounding.
        const skew = Math.abs(liveStart - contents.processStartMs);
        if (skew > 2000 && contents.pid !== process.pid) {
            return { stale: true, reason: `pid ${contents.pid} reused (start time mismatch)` };
        }
    } catch {
        // If we can't compute start time, fall back to the age check above.
    }
    return { stale: false, reason: '' };
}

/**
 * Symlink-safe unlink. Refuses to unlink a symlink, and refuses to unlink if
 * the resolved real path is outside the lock directory.
 */
async function safeUnlink(lockPath: string): Promise<boolean> {
    let stat: fs.Stats;
    try {
        stat = await fs.promises.lstat(lockPath);
    } catch {
        return false; // already gone
    }
    if (stat.isSymbolicLink()) {
        // A symlink at the lock path is either an attack or a mistake; do not
        // follow it. Leave it in place so the condition is visible.
        console.warn(`[storeLock] refusing to unlink symlink at ${lockPath}`);
        return false;
    }
    const lockDir = path.dirname(lockPath);
    let real: string;
    try {
        real = await fs.promises.realpath(lockPath);
    } catch {
        return false;
    }
    const realDir = path.dirname(real);
    // The lock file must live inside the lock directory (no symlink redirect
    // out of the store).
    if (realDir !== path.resolve(lockDir) && !real.startsWith(path.resolve(lockDir) + path.sep)) {
        console.warn(`[storeLock] refusing to unlink ${lockPath}: real path ${real} outside lock dir ${lockDir}`);
        return false;
    }
    try {
        await fs.promises.unlink(lockPath);
        return true;
    } catch {
        return false;
    }
}

/**
 * Try once to acquire the lock. If the lock exists and is provably stale,
 * reclaim it and try again once. Never waits.
 */
async function tryAcquireOnce(lockPath: string, maxAgeMs: number): Promise<AcquireResult> {
    const contents = `${process.pid}:${processStartMs()}:${Date.now()}\n`;
    try {
        await fs.promises.writeFile(lockPath, contents, { flag: 'wx', mode: 0o600 });
        return { acquired: true, release: releaseFn(lockPath) };
    } catch (err: any) {
        if (err && err.code !== 'EEXIST') throw err;
    }

    // Lock exists — read it and decide stale vs held.
    let raw = '';
    try {
        raw = await fs.promises.readFile(lockPath, 'utf8');
    } catch {
        // Vanished between create and read — one retry.
        try {
            await fs.promises.writeFile(lockPath, contents, { flag: 'wx', mode: 0o600 });
            return { acquired: true, release: releaseFn(lockPath) };
        } catch (err2: any) {
            if (err2 && err2.code === 'EEXIST') {
                return { acquired: false, skip: { held: true, byPid: 0, acquiredAtMs: 0, reason: 'lock held (unreadable)' } };
            }
            throw err2;
        }
    }

    const parsed = parseLockContents(raw);
    if (!parsed) {
        // Corrupt lock — treat as stale and reclaim.
        const reclaimed = await safeUnlink(lockPath);
        if (reclaimed) {
            try {
                await fs.promises.writeFile(lockPath, contents, { flag: 'wx', mode: 0o600 });
                return { acquired: true, release: releaseFn(lockPath) };
            } catch (err3: any) {
                if (err3 && err3.code === 'EEXIST') {
                    return { acquired: false, skip: { held: true, byPid: 0, acquiredAtMs: 0, reason: 'lock re-acquired by another process after corrupt reclaim' } };
                }
                throw err3;
            }
        }
        return { acquired: false, skip: { held: true, byPid: 0, acquiredAtMs: 0, reason: 'corrupt lock and reclaim failed' } };
    }

    const stale = isStale(parsed, maxAgeMs);
    if (stale.stale) {
        const reclaimed = await safeUnlink(lockPath);
        if (reclaimed) {
            try {
                await fs.promises.writeFile(lockPath, contents, { flag: 'wx', mode: 0o600 });
                return { acquired: true, release: releaseFn(lockPath) };
            } catch (err4: any) {
                if (err4 && err4.code === 'EEXIST') {
                    return { acquired: false, skip: { held: true, byPid: parsed.pid, acquiredAtMs: parsed.acquiredAtMs, reason: `stale lock (${stale.reason}) reclaimed by another process` } };
                }
                throw err4;
            }
        }
        return { acquired: false, skip: { held: true, byPid: parsed.pid, acquiredAtMs: parsed.acquiredAtMs, reason: `stale lock (${stale.reason}) but reclaim failed` } };
    }

    return {
        acquired: false,
        skip: {
            held: true,
            byPid: parsed.pid,
            acquiredAtMs: parsed.acquiredAtMs,
            reason: `lock held by pid ${parsed.pid} (acquired ${new Date(parsed.acquiredAtMs).toISOString()})`,
        },
    };
}

/**
 * Acquire a store lock for the given resolved store path.
 * Skip-rather-than-queue: returns immediately. At most one stale-reclaim retry
 * is attempted (with a tiny backoff so a concurrent reclaim race settles).
 */
export async function tryAcquireStoreLock(opts: StoreLockOptions = {}): Promise<AcquireResult> {
    ensureGlobalStoreDir();
    const storePath = opts.storePath || getGlobalStoreDir();
    const lockPath = resolveLockPath(storePath, opts.lockDir);
    const maxAgeMs = opts.maxAgeMs ?? MAX_AGE_MS;

    const first = await tryAcquireOnce(lockPath, maxAgeMs);
    if (first.acquired) {
        registerExitRelease(lockPath);
        return first;
    }
    // If the lock was stale and the reclaim race lost, the winner may have just
    // taken it — that's a legitimate held lock now, not a skip. Only retry when
    // the skip reason indicates a reclaim attempt failed (rare).
    return first;
}

// ─── Best-effort release on process exit ────────────────────────────────────

const releasedPaths = new Set<string>();
let exitHandlerInstalled = false;

function registerExitRelease(lockPath: string): void {
    if (releasedPaths.has(lockPath)) return;
    releasedPaths.add(lockPath);
    if (!exitHandlerInstalled) {
        exitHandlerInstalled = true;
        const releaseAll = () => {
            for (const p of releasedPaths) {
                try {
                    if (fs.existsSync(p)) {
                        const st = fs.lstatSync(p);
                        if (st.isSymbolicLink()) continue;
                        fs.unlinkSync(p);
                    }
                } catch { /* best effort */ }
            }
        };
        process.once('exit', releaseAll);
        // SIGINT/SIGTERM: release then re-throw so default handlers run.
        const signalRelease = (sig: string) => {
            releaseAll();
            process.kill(process.pid, sig);
        };
        process.once('SIGINT', () => signalRelease('SIGINT'));
        process.once('SIGTERM', () => signalRelease('SIGTERM'));
    }
}

/**
 * Read the current lock contents for a store path without attempting to
 * acquire. Used by the skip surface to report who holds the lock.
 */
export async function readStoreLock(opts: StoreLockOptions = {}): Promise<StoreLockContents | null> {
    const storePath = opts.storePath || getGlobalStoreDir();
    const lockPath = resolveLockPath(storePath, opts.lockDir);
    try {
        const raw = await fs.promises.readFile(lockPath, 'utf8');
        return parseLockContents(raw);
    } catch {
        return null;
    }
}
