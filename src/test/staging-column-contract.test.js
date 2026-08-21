'use strict';

/**
 * STAGING Column Contract — the migration gate.
 *
 * The DISPATCH column was a display-mode overlay on PLAN REVIEWED. The STAGING
 * migration replaced it with a real built-in column (id STAGING, kind 'staging',
 * order 115) that has its own slot on the board, its own queue semantics, and
 * its own advance-skip rule. This test pins the migration's load-bearing
 * properties so a regression to the old display-mode toggle (or a half-done
 * migration that leaves DISPATCH references behind) fails CI.
 *
 * What is pinned here, and why each one is invisible to every other gate:
 *
 * 1. **Column definition.** STAGING must be in DEFAULT_KANBAN_COLUMNS with
 *    kind 'staging' and NO role — a role would make it a dispatch target,
 *    which would route cards into the queue via the advance path instead of
 *    the staging path. DISPATCH must NOT be in DEFAULT_KANBAN_COLUMNS,
 *    DISPLAY_MODE_COLUMNS, or LEGACY_COLUMN_LABELS — any of those would
 *    either render a phantom column or resolve a dead ID to a label.
 *
 * 2. **Backend queue pop.** The pop in LocalApiServer filters on
 *    `kanbanColumn === 'STAGING'`. A pop that still reads DISPATCH finds
 *    nothing and the queue is silently dead.
 *
 * 3. **Queue position writer.** appendQueuePositions writes
 *    `kanban_column = 'STAGING'`. A writer that still writes DISPATCH creates
 *    cards the pop can never see.
 *
 * 4. **Webview advance skip.** getNextColumn skips role-less columns, and
 *    STAGING has no role. A STAGING card's advance button must land on
 *    LEAD CODED (the next role-bearing column), not on STAGING itself.
 *
 * 5. **Webview drag-into-STAGING.** A drop into STAGING routes through
 *    stageForQueue (cross-column) or reorderQueue (same-column), never
 *    through the generic column-move path. The generic path would move the
 *    card without assigning a queue_position.
 *
 * 6. **Webview STAGEABLE_COLUMNS.** The frontend gate mirrors the backend
 *    stageableColumns Set. STAGING is included (for re-positioning); coded/
 *    reviewed/completed columns are excluded.
 *
 * 7. **stageForQueue arms the queue watch.** Staging is the earliest moment
 *    a silent night becomes possible — a queue staged but never dispatched
 *    must be watched from the staging call, not only from the pop.
 *
 * 8. **Schedule run sheet.** The autoban schedule pops STAGING and nothing
 *    else — the old run sheet that walked CREATED / PLAN REVIEWED is gone.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
    }
}

function run() {
    console.log('staging column contract\n');

    const agentConfig = read('src/services/agentConfig.ts');
    const localApiServer = read('src/services/LocalApiServer.ts');
    const kanbanDatabase = read('src/services/KanbanDatabase.ts');
    const kanbanProvider = read('src/services/KanbanProvider.ts');
    const kanbanHtml = read('src/webview/kanban.html');

    // ─── 1. Column definition ──────────────────────────────────────────────

    check('STAGING is in DEFAULT_KANBAN_COLUMNS with kind staging and no role', () => {
        // Extract the DEFAULT_KANBAN_COLUMNS array body.
        const start = agentConfig.indexOf('export const DEFAULT_KANBAN_COLUMNS');
        assert.notStrictEqual(start, -1, 'DEFAULT_KANBAN_COLUMNS export not found');
        const arrStart = agentConfig.indexOf('[', start);
        const arrEnd = agentConfig.indexOf('];', arrStart);
        const arrBody = agentConfig.slice(arrStart, arrEnd);
        // STAGING entry exists.
        assert.ok(/id:\s*'STAGING'/.test(arrBody), 'STAGING is not in DEFAULT_KANBAN_COLUMNS');
        // Extract the STAGING entry.
        const stagingIdx = arrBody.indexOf("id: 'STAGING'");
        const stagingEntry = arrBody.slice(stagingIdx, arrBody.indexOf('},', stagingIdx) + 1);
        assert.ok(/kind:\s*'staging'/.test(stagingEntry), "STAGING must have kind: 'staging'");
        assert.ok(/order:\s*115/.test(stagingEntry), 'STAGING must have order: 115');
        assert.ok(/label:\s*'Staging'/.test(stagingEntry), "STAGING must have label: 'Staging'");
        // NO role — a role would make it a dispatch target.
        assert.ok(!/role:/.test(stagingEntry), 'STAGING must NOT have a role — it is a queue, not a dispatch seat');
    });

    check('DISPATCH is NOT in DEFAULT_KANBAN_COLUMNS, DISPLAY_MODE_COLUMNS, or LEGACY_COLUMN_LABELS', () => {
        const start = agentConfig.indexOf('export const DEFAULT_KANBAN_COLUMNS');
        const arrStart = agentConfig.indexOf('[', start);
        const arrEnd = agentConfig.indexOf('];', arrStart);
        const arrBody = agentConfig.slice(arrStart, arrEnd);
        assert.ok(!/'DISPATCH'/.test(arrBody), 'DISPATCH must not remain in DEFAULT_KANBAN_COLUMNS');

        const dmStart = agentConfig.indexOf('export const DISPLAY_MODE_COLUMNS');
        const dmBody = agentConfig.slice(dmStart, agentConfig.indexOf('};', dmStart) + 1);
        assert.ok(!/'DISPATCH'/.test(dmBody), 'DISPATCH must not remain in DISPLAY_MODE_COLUMNS');

        const legStart = agentConfig.indexOf('export const LEGACY_COLUMN_LABELS');
        const legBody = agentConfig.slice(legStart, agentConfig.indexOf('};', legStart) + 1);
        assert.ok(!/'DISPATCH'/.test(legBody), 'DISPATCH must not remain in LEGACY_COLUMN_LABELS');
    });

    check('STAGING is in VALID_KANBAN_COLUMNS (via DEFAULT_KANBAN_COLUMNS spread)', () => {
        // VALID_KANBAN_COLUMNS spreads DEFAULT_KANBAN_COLUMNS, so STAGING is
        // included automatically. Verify the spread.
        assert.ok(
            /VALID_KANBAN_COLUMNS\s*=\s*new Set\(\[[\s\S]*\.\.\.DEFAULT_KANBAN_COLUMNS/.test(kanbanDatabase),
            'VALID_KANBAN_COLUMNS must spread DEFAULT_KANBAN_COLUMNS — STAGING is a member'
        );
    });

    // ─── 2. Backend queue pop ──────────────────────────────────────────────

    check('the queue pop filters on kanbanColumn === STAGING', () => {
        assert.ok(
            /kanbanColumn\s*===\s*'STAGING'/.test(localApiServer),
            "the pop must filter on kanbanColumn === 'STAGING' — a DISPATCH filter leaves the queue dead"
        );
        // The old PLAN REVIEWED fallback must be gone from the pop path.
        const popStart = localApiServer.indexOf('dispatchNextFromQueue');
        const popBody = localApiServer.slice(popStart, localApiServer.indexOf('\n    private ', popStart + 50));
        assert.ok(
            !/kanbanColumn\s*===\s*'PLAN REVIEWED'/.test(popBody),
            "the pop must not fall back to PLAN REVIEWED — the interim fallback was the drain-the-lane regression"
        );
    });

    // ─── 3. Queue position writer ──────────────────────────────────────────

    check('appendQueuePositions reads and writes kanban_column = STAGING', () => {
        const fnStart = kanbanDatabase.indexOf('public async appendQueuePositions(');
        assert.notStrictEqual(fnStart, -1, 'appendQueuePositions must exist');
        const fnBody = kanbanDatabase.slice(fnStart, kanbanDatabase.indexOf('\n    public ', fnStart + 50));
        // Both statements bind the column name positionally on the line AFTER the
        // SQL string, so every predicate here must span newlines ([\s\S], not `.`).
        // The first draft of this check used `.` and could not match either
        // statement — it passed only because the file it guards was never run.
        assert.ok(
            !/'DISPATCH'/.test(fnBody),
            "appendQueuePositions must not bind 'DISPATCH' — cards written there are invisible to the pop"
        );
        // The MAX(queue_position) read must be scoped to STAGING, or positions are
        // appended from another column's high-water mark.
        assert.ok(
            /MAX\(queue_position\)[\s\S]*?kanban_column\s*=\s*\?[\s\S]*?\[\s*workspaceId\s*,\s*'STAGING'\s*\]/.test(fnBody),
            "the MAX(queue_position) query must bind 'STAGING' — reading another column returns the wrong high-water mark"
        );
        // The UPDATE must set the column to STAGING, or a staged card keeps its old
        // column and the pop never sees it.
        assert.ok(
            /UPDATE plans SET queue_position = \?, kanban_column = \?[\s\S]*?\[\s*next\s*,\s*'STAGING'/.test(fnBody),
            "the UPDATE must write kanban_column = 'STAGING' — a card that keeps its old column is never popped"
        );
    });

    // ─── 4. Webview advance skip ───────────────────────────────────────────

    check('getNextColumn skips role-less columns (STAGING has no role)', () => {
        const fnStart = kanbanHtml.indexOf('function getNextColumn(');
        assert.notStrictEqual(fnStart, -1, 'getNextColumn must exist');
        const fnBody = kanbanHtml.slice(fnStart, kanbanHtml.indexOf('\n        }', fnStart) + 1);
        // The skip predicate: columns with no role and not completed are skipped.
        assert.ok(
            /!def\.role\s*&&\s*def\.kind\s*!==\s*'completed'/.test(fnBody),
            'getNextColumn must skip role-less non-completed columns — STAGING has no role'
        );
    });

    // ─── 5. Webview drag-into-STAGING ──────────────────────────────────────

    check('a drop into STAGING routes through stageForQueue or reorderQueue, not the generic move', () => {
        const dropIdx = kanbanHtml.indexOf("effectiveTargetColumn === 'STAGING'");
        assert.notStrictEqual(dropIdx, -1, "the drop handler must gate on effectiveTargetColumn === 'STAGING'");
        // The STAGING branch must post either stageForQueue or reorderQueue.
        const branchBody = kanbanHtml.slice(dropIdx, dropIdx + 800);
        assert.ok(
            /stageForQueue|reorderQueue/.test(branchBody),
            'a drop into STAGING must post stageForQueue (cross-column) or reorderQueue (same-column)'
        );
    });

    // ─── 6. Webview STAGEABLE_COLUMNS ──────────────────────────────────────

    check('STAGEABLE_COLUMNS includes STAGING and excludes coded/reviewed/completed', () => {
        const idx = kanbanHtml.indexOf('const STAGEABLE_COLUMNS');
        assert.notStrictEqual(idx, -1, 'STAGEABLE_COLUMNS must exist');
        const line = kanbanHtml.slice(idx, kanbanHtml.indexOf('];', idx) + 2);
        assert.ok(/'STAGING'/.test(line), 'STAGEABLE_COLUMNS must include STAGING (for re-positioning)');
        assert.ok(/'CREATED'/.test(line) && /'PLAN REVIEWED'/.test(line), 'STAGEABLE_COLUMNS must include CREATED and PLAN REVIEWED');
        assert.ok(!/'LEAD CODED'/.test(line), 'STAGEABLE_COLUMNS must not include coded columns');
        assert.ok(!/'CODE REVIEWED'/.test(line), 'STAGEABLE_COLUMNS must not include reviewed columns');
        assert.ok(!/'COMPLETED'/.test(line), 'STAGEABLE_COLUMNS must not include COMPLETED');
    });

    // ─── 7. stageForQueue arms the queue watch ─────────────────────────────

    check('stageForQueue arms the queue watch', () => {
        const fnStart = kanbanProvider.indexOf('public async stageForQueue(');
        assert.notStrictEqual(fnStart, -1, 'stageForQueue must exist');
        const fnBody = kanbanProvider.slice(fnStart, kanbanProvider.indexOf('\n    public ', fnStart + 50));
        assert.ok(
            /armQueueWatch/.test(fnBody),
            'stageForQueue must arm the queue watch — staging is the earliest moment a silent night becomes possible'
        );
    });

    // ─── 8. Schedule run sheet ─────────────────────────────────────────────

    check('the autoban schedule run sheet pops STAGING and nothing else', () => {
        const idx = kanbanHtml.indexOf('sourceColumn: \'STAGING\'');
        assert.notStrictEqual(idx, -1, 'the run sheet must name STAGING as its source column');
        // The old run sheet walked CREATED and PLAN REVIEWED. Those must not
        // appear as sourceColumn entries in the run sheet.
        const runSheetBody = kanbanHtml.slice(kanbanHtml.indexOf('const runSheet = ['), kanbanHtml.indexOf('];', kanbanHtml.indexOf('const runSheet = [')) + 2);
        assert.ok(
            !/sourceColumn:\s*'CREATED'/.test(runSheetBody) && !/sourceColumn:\s*'PLAN REVIEWED'/.test(runSheetBody),
            'the run sheet must not walk CREATED or PLAN REVIEWED — the schedule pops STAGING only'
        );
    });

    // ─── 9. No DISPATCH column references remain in source ──────────────────

    check('no DISPATCH column references remain in the backend source', () => {
        // The column ID DISPATCH must not appear as a column filter in the
        // backend services. Action names (dispatchAnalyze) and constant names
        // (DISPATCH_ROLES) are NOT column references and are excluded from
        // this check — the quoted-literal match below cannot hit either.
        const offenders = [];
        for (const rel of ['src/services/LocalApiServer.ts', 'src/services/KanbanProvider.ts', 'src/services/KanbanDatabase.ts', 'src/services/TaskViewerProvider.ts']) {
            const src = read(rel);
            // Look for DISPATCH used as a column string literal, not as an
            // identifier (DISPATCH_ROLES) or action name (dispatchAnalyze).
            const matches = src.match(/'DISPATCH'/g);
            if (matches) {
                offenders.push(`${rel}: ${matches.length} occurrence(s) of 'DISPATCH'`);
            }
        }
        assert.deepStrictEqual(offenders, [],
            'DISPATCH column references remain in backend source: ' + offenders.join(', '));
    });

    console.log('');
    if (failures > 0) {
        console.error(`${failures} contract(s) failed.`);
        process.exit(1);
    }
    console.log('staging column contract passed');
}

run();
