#!/usr/bin/env node
/**
 * One-off migration: triage and import existing Mission Control report files
 * (.switchboard/mission-control/reports/*.md) into plan_events.
 *
 * Plan 171 — "Blocked reports nobody can read". The file mirror is deleted;
 * existing reports are settled into the database so the evidence survives.
 *
 * Classification:
 *   - surviving: card is still in a pre-review column (STAGING, LEAD CODED,
 *     CODER CODED, INTERN CODED) → the block is still real backlog.
 *   - stale: card has moved on (CODE REVIEWED, COMPLETED,
 *     PLAN REVIEWED, CREATED) or was deleted/archived → the block resolved.
 *
 * Import: the most recent surviving report per planId is imported (deduped),
 * so 1816 blocked files for the same card produce one plan_events row, not
 * 1816. Stale reports are NOT imported but NOT deleted — the files remain
 * as archival evidence. No bulk delete.
 *
 * Usage: node scripts/triage-mission-control-reports.js [--workspace <path>] [--dry-run]
 */
'use strict';

const fs = require('fs');
const path = require('path');

const workspaceRoot = process.argv.includes('--workspace')
    ? process.argv[process.argv.indexOf('--workspace') + 1]
    : process.cwd();
const dryRun = process.argv.includes('--dry-run');

const reportsDir = path.join(workspaceRoot, '.switchboard', 'mission-control', 'reports');
const plansDir = path.join(workspaceRoot, '.switchboard', 'plans');

// ── 1. Parse report files ──────────────────────────────────────────────────

function parseFrontmatter(content) {
    const m = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
    if (!m) return { frontmatter: {}, body: content };
    const fm = {};
    for (const line of m[1].split('\n')) {
        const kv = line.match(/^(\w+):\s*(.*)$/);
        if (kv) fm[kv[1]] = kv[2].trim();
    }
    return { frontmatter: fm, body: m[2].trim() };
}

function toRelativePlanId(planId) {
    if (!planId) return '';
    // The board stores plan_file as the RELATIVE path from the workspace root
    // (e.g. ".switchboard/plans/foo.md"). The report files carry absolute
    // paths. Strip the workspace root prefix to get the stored shape.
    const p = planId.replace(/\\/g, '/');
    const wsRootPrefix = (workspaceRoot + '/').replace(/\\/g, '/');
    if (p.startsWith(wsRootPrefix)) return p.slice(wsRootPrefix.length);
    // Already has the .switchboard/plans/ prefix — return as-is.
    if (p.includes('.switchboard/plans/')) {
        const idx = p.indexOf('.switchboard/plans/');
        return p.slice(idx);
    }
    // Just a filename — prefix it.
    return '.switchboard/plans/' + path.basename(p);
}

const files = fs.readdirSync(reportsDir)
    .filter(f => f.endsWith('.md'))
    .map(f => {
        const fullPath = path.join(reportsDir, f);
        const content = fs.readFileSync(fullPath, 'utf8');
        const { frontmatter, body } = parseFrontmatter(content);
        return {
            file: f,
            fullPath,
            from: frontmatter.from || '',
            kind: frontmatter.kind || '',
            planId: toRelativePlanId(frontmatter.planId || ''),
            rawPlanId: frontmatter.planId || '',
            created: frontmatter.created || '',
            body,
        };
    })
    .filter(r => r.kind === 'blocked' || r.kind === 'finished' || r.kind === 'question');

console.log(`[triage] Parsed ${files.length} report files.`);
const kindCounts = {};
for (const r of files) { kindCounts[r.kind] = (kindCounts[r.kind] || 0) + 1; }
console.log(`[triage] By kind: ${JSON.stringify(kindCounts)}`);

// ── 2. Open the DB and query board state ───────────────────────────────────

const { KanbanDatabase } = require(path.join(workspaceRoot, 'out', 'services', 'KanbanDatabase.js'));
const db = KanbanDatabase.forWorkspace(workspaceRoot);

// Columns where a blocked card is still parked (real backlog).
const PARKED_COLUMNS = new Set([
    'STAGING',
    'LEAD CODED',
    'CODER CODED',
    'INTERN CODED',
]);

async function getCardColumn(planId) {
    if (!planId) return { column: null, found: false };
    try {
        // planId here is the RELATIVE plan file path (e.g.
        // .switchboard/plans/foo.md). The board stores plan_file as the
        // relative path and plan_id as a UUID. Resolve via plan_file.
        const wsId = await db.getWorkspaceId() || db._getWorkspaceIdFallback() || '';
        if (wsId) {
            const plan = await db.getPlanByPlanFile(planId, wsId);
            if (plan && plan.kanbanColumn) {
                return { column: plan.kanbanColumn, found: true, planId: plan.planId };
            }
        }
        // Try the union (board + archive) in case the card was archived.
        const union = await db.getPlanByPlanIdUnion?.(planId, false);
        if (union && union.kanbanColumn) {
            return { column: union.kanbanColumn, found: true, planId: union.planId };
        }
        return { column: null, found: false };
    } catch (err) {
        return { column: null, found: false, error: err.message };
    }
}

// ── 3. Classify and deduplicate ────────────────────────────────────────────

async function triage() {
    // Group by planId, keep the most recent per planId.
    const byPlanId = new Map();
    for (const r of files) {
        const key = r.planId || `__no-planId__:${r.file}`;
        const existing = byPlanId.get(key);
        if (!existing || (r.created > existing.created)) {
            byPlanId.set(key, r);
        }
    }
    console.log(`[triage] Deduplicated to ${byPlanId.size} unique cards.`);

    const surviving = [];
    const stale = [];
    const orphaned = [];

    for (const [key, report] of byPlanId) {
        const { column, found, planId: resolvedPlanId } = await getCardColumn(report.planId);
        report.currentColumn = column;
        report.cardFound = found;
        report.resolvedPlanId = resolvedPlanId || '';

        if (!found) {
            orphaned.push(report);
        } else if (PARKED_COLUMNS.has(column)) {
            surviving.push(report);
        } else {
            stale.push(report);
        }
    }

    console.log(`[triage] Surviving (card still parked): ${surviving.length}`);
    console.log(`[triage] Stale (card moved on): ${stale.length}`);
    console.log(`[triage] Orphaned (card not found): ${orphaned.length}`);

    // ── 4. Import surviving into plan_events ────────────────────────────────
    let imported = 0;
    if (!dryRun) {
        for (const report of surviving) {
            const action = report.kind === 'finished' ? 'finished'
                : report.kind === 'question' ? 'blocked'
                : 'blocked';
            try {
                // Use the resolved plan_id (UUID) so the JOIN to plans works.
                // Fall back to the relative planFile if resolution failed.
                const planIdForEvent = report.resolvedPlanId || report.planId || '';
                await db.appendPlanEventByPlanId(planIdForEvent, {
                    eventType: 'turn_end',
                    action,
                    timestamp: report.created || new Date().toISOString(),
                    payload: JSON.stringify({
                        message: report.body,
                        source: 'triage-migration',
                        sourceFile: report.file,
                    }),
                });
                imported++;
            } catch (err) {
                console.error(`[triage] Failed to import ${report.file}: ${err.message}`);
            }
        }
    }
    console.log(`[triage] Imported ${imported} surviving reports into plan_events.`);

    // ── 5. Summary ─────────────────────────────────────────────────────────
    console.log('');
    console.log('=== TRIAGE SUMMARY ===');
    console.log(`Total report files parsed: ${files.length}`);
    console.log(`Unique cards (deduplicated): ${byPlanId.size}`);
    console.log(`Surviving (card still parked): ${surviving.length}`);
    console.log(`Stale (card moved on): ${stale.length}`);
    console.log(`Orphaned (card not found): ${orphaned.length}`);
    console.log(`Imported into plan_events: ${imported}`);
    console.log(`Files deleted: 0 (no bulk delete — files remain as archival evidence)`);
    console.log('=== END SUMMARY ===');

    // Print surviving report details for the completion report.
    if (surviving.length > 0) {
        console.log('');
        console.log('Surviving reports (card still parked):');
        for (const r of surviving.slice(0, 20)) {
            console.log(`  ${r.created} ${r.kind} [${r.currentColumn}] ${r.planId} (${r.file})`);
        }
        if (surviving.length > 20) {
            console.log(`  ... and ${surviving.length - 20} more.`);
        }
    }
}

triage().then(() => {
    process.exit(0);
}).catch(err => {
    console.error('[triage] Fatal:', err);
    process.exit(1);
});
