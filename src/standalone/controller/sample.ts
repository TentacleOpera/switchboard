import * as fs from 'fs';
import * as path from 'path';

/**
 * The controller's SAMPLER — process CPU, process RSS and last worktree write
 * (plan: the-judgement-bundle-cannot-see-a-seat-that-is-busy-doing-the-wrong-thing,
 * change 2).
 *
 * The conflation this module exists to undo: **sampling is not probing.**
 * Reading a seat's CPU, its RSS and its last write costs the seat nothing and
 * says nothing to it. Only *acting* — nudging, clearing, rerouting — is spam.
 * Sparseness belongs on the remediation, not on the observation.
 *
 * Nothing here writes. No seat is written to, no prompt is sent, no terminal is
 * cleared, no file is created. Every export takes a pid or a directory and
 * returns a reading. If any part of this module ever writes to a seat, the plan
 * it implements has failed.
 *
 * Every reading is `{ available, ..., source }` or `{ available: false, reason,
 * source }`. A missing CPU figure and a CPU figure of zero are DIFFERENT facts —
 * a seat legitimately blocked on an API call reads 0% and is healthy, and a host
 * with no `/proc` has no figure at all. Collapsing them is the fallback rule.
 */

/**
 * Kernel clock ticks per second. `sysconf(_SC_CLK_TCK)` is not reachable from
 * Node, and this is 100 on every Linux configuration Node ships for. It is an
 * ASSUMPTION, not a reading, so every CPU percentage carries it in its `source`
 * string and `configAssumptions()` states it in the report — a rate computed
 * against a wrong USER_HZ would be a plausible number with no way to tell.
 */
export const ASSUMED_USER_HZ = 100;

/** Bytes per page, for `/proc/<pid>/stat` field 24 (RSS in pages). */
const PAGE_BYTES = 4096;

/** Directories a worktree scan never descends into. */
const SCAN_EXCLUDED_DIRS = new Set([
    '.git', 'node_modules', 'dist', 'out', 'build', 'coverage',
    '.next', '.nuxt', '.cache', 'vendor', 'target', '__pycache__', '.venv',
]);

/** Bound on a worktree scan so a large tree cannot stall a wake on a Pi. */
export const SCAN_MAX_ENTRIES = 20_000;
export const SCAN_MAX_DEPTH = 8;

export interface ProcessRow {
    pid: number;
    ppid: number;
    /** utime + stime, in clock ticks. */
    jiffies: number;
    /** `/proc/<pid>/stat` field 22 — the pid-recycle key. */
    startTime: number;
    rssBytes: number;
}

export interface ProcessTable {
    available: boolean;
    byPid: Map<number, ProcessRow>;
    childrenOf: Map<number, number[]>;
    source: string;
    reason?: string;
}

/**
 * The previous sample for one seat, carried in the controller's persisted state
 * so a rate survives a wake.
 *
 * Keyed by pid AND start time. A seat that dies and respawns reuses the pid
 * slot, and a jiffy delta computed across that recycle is meaningless — it is
 * not a small error, it is a number with no relationship to anything. On a
 * mismatch the reading is "no previous sample", never a rate and never zero.
 */
export interface PreviousSample {
    pid: number;
    startTime: number;
    jiffies: number;
    atMs: number;
}

export type Reading<T> =
    | { available: true; value: T; source: string }
    | { available: false; reason: string; source: string };

export interface SeatSample {
    cpu: Reading<number>;
    rss: Reading<number>;
    /** The sample to carry forward; `null` when nothing could be read. */
    next: PreviousSample | null;
    /** How many processes the tree walk covered, for the report. */
    treeSize: number;
}

function unavailable<T>(reason: string, source: string): Reading<T> {
    return { available: false, reason, source };
}

/**
 * Parse one `/proc/<pid>/stat` line.
 *
 * `comm` (field 2) is wrapped in parentheses and may itself contain spaces and
 * parentheses — `(Web Content)`, `(foo) bar)`. Splitting the whole line on
 * whitespace therefore misaligns every later field, which is how a naive parser
 * silently reports another field's value as the start time. The remainder after
 * the LAST `)` is the only safe split point.
 */
export function parseProcStat(line: string): ProcessRow | null {
    const close = line.lastIndexOf(')');
    if (close < 0) { return null; }
    const pid = Number(line.slice(0, line.indexOf(' ')));
    if (!Number.isFinite(pid)) { return null; }
    const rest = line.slice(close + 1).trim().split(/\s+/);
    // `rest[0]` is field 3 (state), so field N is at index N - 3.
    const ppid = Number(rest[1]);
    const utime = Number(rest[11]);
    const stime = Number(rest[12]);
    const startTime = Number(rest[19]);
    const rssPages = Number(rest[21]);
    if (![ppid, utime, stime, startTime].every(Number.isFinite)) { return null; }
    return {
        pid,
        ppid,
        jiffies: utime + stime,
        startTime,
        rssBytes: Number.isFinite(rssPages) ? rssPages * PAGE_BYTES : 0,
    };
}

/**
 * Read the whole process table once per wake.
 *
 * Once, not per seat: nine seats each walking `/proc` independently is nine
 * scans of the same directory, and the readings would be taken at nine slightly
 * different instants — which makes a CPU rate computed against a shared wall
 * clock subtly wrong.
 */
export function readProcessTable(procRoot = '/proc'): ProcessTable {
    const source = `${procRoot}/<pid>/stat`;
    const byPid = new Map<number, ProcessRow>();
    const childrenOf = new Map<number, number[]>();
    let entries: string[];
    try {
        entries = fs.readdirSync(procRoot);
    } catch (e) {
        // No `/proc` (macOS, Windows, a container without it). CPU and RSS
        // report unavailable WITH THIS REASON and the bundle still assembles —
        // the plan degrades the fields, never the wake.
        return {
            available: false, byPid, childrenOf, source,
            reason: `${procRoot} is not readable on this host (${e instanceof Error ? e.message : String(e)}) — CPU and RSS are Linux-only signals`,
        };
    }
    for (const entry of entries) {
        if (!/^\d+$/.test(entry)) { continue; }
        let line: string;
        try {
            line = fs.readFileSync(path.join(procRoot, entry, 'stat'), 'utf8');
        } catch {
            // A process that exited between readdir and read. Not an error:
            // the table is a snapshot and this pid is simply not in it.
            continue;
        }
        const row = parseProcStat(line);
        if (!row) { continue; }
        byPid.set(row.pid, row);
        const siblings = childrenOf.get(row.ppid);
        if (siblings) { siblings.push(row.pid); } else { childrenOf.set(row.ppid, [row.pid]); }
    }
    return { available: true, byPid, childrenOf, source };
}

/**
 * Every pid in the tree rooted at `pid`, including `pid` itself.
 *
 * The tree, not the shell: a seat's shell is idle while the agent CLI it
 * spawned burns a core, so a reading taken on the shell alone reports 0% for a
 * seat that is at 100%. That is the exact wrong answer this signal exists to
 * prevent. The walk is breadth-first with a visited set — `/proc` can present a
 * cycle if a pid is recycled mid-walk, and an unbounded walk would hang the
 * wake.
 */
export function collectTree(pid: number, table: ProcessTable): number[] {
    const seen = new Set<number>();
    const out: number[] = [];
    const queue = [pid];
    while (queue.length > 0) {
        const current = queue.shift()!;
        if (seen.has(current)) { continue; }
        seen.add(current);
        if (!table.byPid.has(current)) { continue; }
        out.push(current);
        for (const child of table.childrenOf.get(current) || []) {
            if (!seen.has(child)) { queue.push(child); }
        }
    }
    return out;
}

/**
 * Sample one seat's process tree, producing a CPU rate against the previous
 * sample and an RSS total.
 *
 * A rate needs two readings. A single `/proc` read gives CUMULATIVE jiffies
 * since the process started, so reporting it as a percentage would say "this
 * seat has used 400% CPU", which is not a rate and not wrong in a way anyone
 * would notice. The first wake for a seat therefore reports CPU unavailable
 * with that reason, and the second reports a real rate.
 */
export function sampleSeat(args: {
    pid: number | null;
    previous: PreviousSample | null;
    table: ProcessTable;
    nowMs: number;
}): SeatSample {
    const { pid, previous, table, nowMs } = args;
    const source = table.source;
    if (!table.available) {
        const reason = table.reason || 'process table unavailable';
        return { cpu: unavailable(reason, source), rss: unavailable(reason, source), next: null, treeSize: 0 };
    }
    if (pid === null || !Number.isFinite(pid) || pid <= 0) {
        const reason = 'the fleet reported no pid for this seat';
        return { cpu: unavailable(reason, 'fleet:ptyListTerminals'), rss: unavailable(reason, 'fleet:ptyListTerminals'), next: null, treeSize: 0 };
    }
    const root = table.byPid.get(pid);
    if (!root) {
        const reason = `pid ${pid} is not in the process table (the seat's process has exited)`;
        return { cpu: unavailable(reason, source), rss: unavailable(reason, source), next: null, treeSize: 0 };
    }

    const tree = collectTree(pid, table);
    let jiffies = 0;
    let rssBytes = 0;
    for (const member of tree) {
        const row = table.byPid.get(member);
        if (!row) { continue; }
        jiffies += row.jiffies;
        rssBytes += row.rssBytes;
    }

    const next: PreviousSample = { pid, startTime: root.startTime, jiffies, atMs: nowMs };
    const rss: Reading<number> = { available: true, value: rssBytes, source: `${source} field 24 x ${PAGE_BYTES}B, summed over ${tree.length} process(es)` };

    if (!previous) {
        return { cpu: unavailable('no previous sample — a rate needs two readings; the next wake reports one', source), rss, next, treeSize: tree.length };
    }
    if (previous.pid !== pid || previous.startTime !== root.startTime) {
        // The recycle guard. Treated as "no previous sample" rather than as a
        // zero or a delta: a delta across a recycle is a number computed from
        // two different processes.
        return {
            cpu: unavailable(
                `the seat's process was replaced since the last wake (pid ${previous.pid}@${previous.startTime} -> ${pid}@${root.startTime}) — no rate is computed across a recycle`,
                source,
            ),
            rss, next, treeSize: tree.length,
        };
    }
    const elapsedMs = nowMs - previous.atMs;
    if (elapsedMs <= 0) {
        return { cpu: unavailable('the previous sample is not older than this one — no interval to rate against', source), rss, next, treeSize: tree.length };
    }
    const deltaJiffies = jiffies - previous.jiffies;
    if (deltaJiffies < 0) {
        // Cumulative counters do not go backwards within one process. A
        // decrease means the tree membership changed under us (a child exited),
        // so the delta is not a rate for anything.
        return { cpu: unavailable('the process tree shrank between samples — the CPU delta is not a rate', source), rss, next, treeSize: tree.length };
    }
    const percent = (deltaJiffies / ASSUMED_USER_HZ) / (elapsedMs / 1000) * 100;
    return {
        cpu: {
            available: true,
            value: percent,
            source: `${source} fields 14/15 over ${Math.round(elapsedMs / 1000)}s (USER_HZ assumed ${ASSUMED_USER_HZ}), summed over ${tree.length} process(es)`,
        },
        rss, next, treeSize: tree.length,
    };
}

export interface WriteScan {
    /** Age of the most recent write, ms. `null` when nothing was found. */
    ageMs: number | null;
    /** WHICH tree was scanned. `no write in 47m (whole worktree)` and the same
     *  sentence with `(card write set)` are different claims, so the basis is
     *  reported with the duration and never left to the reader to assume. */
    basis: string;
    /** True when the entry/depth budget ran out before the tree was exhausted. */
    truncated: boolean;
    available: boolean;
    reason?: string;
    source: string;
}

/**
 * The most recent mtime under a directory.
 *
 * This is the signal that reveals a research loop, and it is the only one that
 * does: an agent stuck researching emits output constantly, burns CPU and never
 * repeats itself, so bytes, frame and CPU all read as healthy work. `no file
 * written for N minutes` is the one observation that separates it — weighed, by
 * the model, against what the card actually asked for.
 *
 * Reports WHAT and WHEN, never the contents of anything. The scan reads
 * directory entries and stat results only; no file is opened.
 */
export function scanLastWrite(args: {
    dir: string | null;
    basis: string;
    nowMs: number;
    maxEntries?: number;
    maxDepth?: number;
}): WriteScan {
    const { dir, basis, nowMs } = args;
    const maxEntries = args.maxEntries ?? SCAN_MAX_ENTRIES;
    const maxDepth = args.maxDepth ?? SCAN_MAX_DEPTH;
    const source = 'fs.statSync mtime (directory walk)';
    if (!dir) {
        return { ageMs: null, basis, truncated: false, available: false, reason: 'the fleet reported no worktree or cwd for this seat', source: 'fleet:ptyListTerminals' };
    }
    let newest = 0;
    let entries = 0;
    let truncated = false;
    const stack: Array<{ dir: string; depth: number }> = [{ dir, depth: 0 }];
    while (stack.length > 0) {
        const current = stack.pop()!;
        if (current.depth > maxDepth) { truncated = true; continue; }
        let listing: fs.Dirent[];
        try {
            listing = fs.readdirSync(current.dir, { withFileTypes: true });
        } catch (e) {
            if (current.depth === 0) {
                return { ageMs: null, basis, truncated: false, available: false, reason: `worktree is not readable: ${e instanceof Error ? e.message : String(e)}`, source };
            }
            continue; // an unreadable subdirectory is not an unreadable worktree.
        }
        for (const entry of listing) {
            if (entries >= maxEntries) { truncated = true; break; }
            entries++;
            const full = path.join(current.dir, entry.name);
            if (entry.isDirectory()) {
                if (SCAN_EXCLUDED_DIRS.has(entry.name)) { continue; }
                stack.push({ dir: full, depth: current.depth + 1 });
                continue;
            }
            if (!entry.isFile()) { continue; }
            try {
                const st = fs.statSync(full);
                if (st.mtimeMs > newest) { newest = st.mtimeMs; }
            } catch { /* vanished mid-walk — not a write, and not an error. */ }
        }
        if (entries >= maxEntries) { truncated = true; break; }
    }
    if (newest === 0) {
        return { ageMs: null, basis, truncated, available: true, source };
    }
    return { ageMs: Math.max(0, nowMs - newest), basis, truncated, available: true, source };
}

/**
 * Render a duration for the bundle.
 *
 * QUANTISED TO MINUTES, deliberately. Judgement is deterministic for a fixed
 * prompt at temperature 0, so the only way a verdict flips on unchanged board
 * state is a bundle whose text changes for incidental reasons — and a duration
 * rendered to the millisecond changes on every single wake. Minutes make two
 * wakes over an unchanged board produce an identical prompt.
 */
export function renderDuration(ms: number | null): string {
    if (ms === null) { return 'never'; }
    const minutes = Math.round(ms / 60000);
    if (minutes < 1) { return '<1m'; }
    return `${minutes}m`;
}
