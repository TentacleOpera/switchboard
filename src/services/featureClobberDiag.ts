import * as fs from 'fs';
import * as path from 'path';

/**
 * DIAGNOSTIC (is_feature clobber investigation) — TEMPORARY.
 *
 * Single sink for every is_feature-clobber probe so ONE repro run produces ONE file an
 * agent can read afterwards, instead of the operator scraping the Dev Tools console and
 * the Switchboard output channel by hand.
 *
 * Output file: <workspaceRoot>/.switchboard/feature-clobber-diagnostic.txt (append-only).
 * Each line is ISO-timestamped. Writes are synchronous + best-effort (never throw into a
 * caller) — correctness of the diagnostic file matters more than its latency, and this
 * only runs while the probes are in the tree.
 *
 * Reading guide: docs/feature-clobber-log-reading-plan.md
 *
 * Remove this file and its call sites once the clobber is identified and fixed.
 */
export function appendFeatureClobberDiag(workspaceRoot: string, line: string): void {
    try {
        if (!workspaceRoot) return;
        const dir = path.join(workspaceRoot, '.switchboard');
        const file = path.join(dir, 'feature-clobber-diagnostic.txt');
        try { fs.mkdirSync(dir, { recursive: true }); } catch { /* dir likely exists */ }
        fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8');
    } catch {
        // A diagnostic must never break the operation it observes. Swallow.
    }
}
