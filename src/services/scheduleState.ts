import { KanbanDatabase } from './KanbanDatabase';

/**
 * scheduleState — persisted last-run / last-skip state for scheduled storage
 * work, stored in the kanban config table so it is per-store and survives
 * process restarts. The timers are per-process; the schedule is per-machine,
 * so the last-run timestamp must live in the store, not in memory
 * (`one-owner-for-scheduled-storage-work.md`).
 */

export interface LastRunRecord {
    atMs: number;
    ok: boolean;
    detail?: string;
}

export interface LastSkipRecord {
    atMs: number;
    reason: string;
}

export interface ScheduleState {
    lastRun: LastRunRecord | null;
    lastSkip: LastSkipRecord | null;
}

const EMPTY: ScheduleState = { lastRun: null, lastSkip: null };

function key(kind: 'backup' | 'rotation', part: 'lastRun' | 'lastSkip'): string {
    return `schedule.${kind}.${part}`;
}

export async function readScheduleState(
    db: KanbanDatabase | null,
    kind: 'backup' | 'rotation'
): Promise<ScheduleState> {
    if (!db || !(await db.ensureReady())) return { ...EMPTY };
    let lastRun: LastRunRecord | null = null;
    let lastSkip: LastSkipRecord | null = null;
    try {
        const runRaw = await db.getConfig(key(kind, 'lastRun'));
        if (runRaw) lastRun = JSON.parse(runRaw);
    } catch { /* ignore */ }
    try {
        const skipRaw = await db.getConfig(key(kind, 'lastSkip'));
        if (skipRaw) lastSkip = JSON.parse(skipRaw);
    } catch { /* ignore */ }
    return { lastRun, lastSkip };
}

export async function writeLastRun(
    db: KanbanDatabase | null,
    kind: 'backup' | 'rotation',
    record: LastRunRecord
): Promise<void> {
    if (!db || !(await db.ensureReady())) return;
    try {
        await db.setConfig(key(kind, 'lastRun'), JSON.stringify(record));
    } catch { /* best effort */ }
}

export async function writeLastSkip(
    db: KanbanDatabase | null,
    kind: 'backup' | 'rotation',
    record: LastSkipRecord
): Promise<void> {
    if (!db || !(await db.ensureReady())) return;
    try {
        await db.setConfig(key(kind, 'lastSkip'), JSON.stringify(record));
    } catch { /* best effort */ }
}
