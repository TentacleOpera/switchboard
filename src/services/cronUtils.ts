/**
 * Standalone cron utility for evaluating 5-field standard cron expressions.
 */

export const WHEN_TIMER_CEILING_MS = 6 * 60 * 60 * 1000; // 6 hours

/**
 * Compute the next matching Date for a standard 5-field cron expression.
 * Returns null if the expression is invalid or no match is found within 366 days.
 *
 * Search starts at the NEXT minute boundary (strictly future).
 */
export function nextCronTime(expr: string, fromNow: Date = new Date()): Date | null {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return null;
    const [minF, hourF, domF, monF, dowF] = fields;

    const parseField = (field: string, min: number, max: number): number[] | null => {
        const result = new Set<number>();
        for (const part of field.split(',')) {
            let step = 1;
            let range = part;
            const slashIdx = part.indexOf('/');
            if (slashIdx !== -1) {
                step = parseInt(part.slice(slashIdx + 1), 10);
                if (!Number.isFinite(step) || step < 1) return null;
                range = part.slice(0, slashIdx);
            }
            let lo: number, hi: number;
            if (range === '*') {
                lo = min; hi = max;
            } else {
                const dashIdx = range.indexOf('-');
                if (dashIdx !== -1) {
                    lo = parseInt(range.slice(0, dashIdx), 10);
                    hi = parseInt(range.slice(dashIdx + 1), 10);
                } else {
                    // Bare value. WITH a step it is the range start and runs
                    // to the field max, so `5/15` yields 5,20,35,50. WITHOUT
                    // one it is exactly that value — `0 3 * * *` must mean
                    // 3am, not "every minute from 3am onward".
                    lo = parseInt(range, 10);
                    hi = slashIdx !== -1 ? max : lo;
                }
                if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo < min || hi > max || lo > hi) return null;
            }
            for (let v = lo; v <= hi; v += step) {
                result.add(v);
            }
        }
        return Array.from(result).sort((a, b) => a - b);
    };

    const minutes = parseField(minF, 0, 59);
    const hours = parseField(hourF, 0, 23);
    const doms = parseField(domF, 1, 31);
    const mons = parseField(monF, 1, 12);
    const dows = parseField(dowF, 0, 6); // 0 = Sunday
    if (!minutes || !hours || !doms || !mons || !dows) return null;

    // Standard cron OR rule: when both dom and dow are restricted (non-*),
    // a match on EITHER suffices. When one is *, the other is ANDed.
    const domRestricted = domF !== '*';
    const dowRestricted = dowF !== '*';
    const bothRestricted = domRestricted && dowRestricted;

    // Search the next matching minute, up to 366 days ahead.
    // Start at the NEXT minute boundary, never the current one.
    const start = new Date(fromNow);
    start.setSeconds(0, 0);
    start.setMinutes(start.getMinutes() + 1);
    for (let i = 0; i < 366 * 24 * 60; i++) {
        const d = new Date(start.getTime() + i * 60_000);
        if (!mons.includes(d.getMonth() + 1)) continue;
        if (!hours.includes(d.getHours())) continue;
        if (!minutes.includes(d.getMinutes())) continue;
        const domMatch = doms.includes(d.getDate());
        const dowMatch = dows.includes(d.getDay());
        if (bothRestricted) {
            if (!domMatch && !dowMatch) continue;
        } else {
            if (!domMatch || !dowMatch) continue;
        }
        return d;
    }
    return null;
}
