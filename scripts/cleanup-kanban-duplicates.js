/**
 * cleanup-kanban-duplicates.js
 *
 * Removes duplicate CREATED rows from kanban.db caused by the activation race
 * condition where existing plans were re-inserted with kanbanColumn='CREATED'.
 *
 * Usage: node scripts/cleanup-kanban-duplicates.js
 *
 * Safety: only deletes a CREATED row if another active row with the same
 * plan_file exists. Genuine single CREATED plans are left untouched.
 *
 * CORRECTION (v2): Duplicates share the same plan_file but have DIFFERENT
 * session_ids (the duplicate gets a freshly generated UUID). We must group
 * by plan_file, not session_id.
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.resolve(__dirname, '..', '.switchboard', 'kanban.db');

async function main() {
    // 1. Verify DB exists
    if (!fs.existsSync(DB_PATH)) {
        console.error(`[ERROR] Database not found: ${DB_PATH}`);
        process.exit(1);
    }

    // 2. Backup DB
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = `${DB_PATH}.backup.${timestamp}`;
    fs.copyFileSync(DB_PATH, backupPath);
    console.log(`[1/5] Backed up kanban.db -> ${path.basename(backupPath)}`);

    // 3. Load sql.js
    const initSqlJs = require('sql.js');
    const SQL = await initSqlJs({
        locateFile: (file) => require.resolve(`sql.js/dist/${file}`)
    });

    // 4. Load DB into memory
    const buffer = await fs.promises.readFile(DB_PATH);
    const db = new SQL.Database(new Uint8Array(buffer));

    // 5. Find all active plan_files that appear more than once
    const dupResult = db.exec(`
        SELECT plan_file, COUNT(*) as cnt,
               GROUP_CONCAT(session_id) as session_ids,
               GROUP_CONCAT(kanban_column) as columns
        FROM plans
        WHERE status = 'active' AND plan_file != ''
        GROUP BY plan_file
        HAVING COUNT(*) > 1
    `);

    if (dupResult.length === 0 || dupResult[0].values.length === 0) {
        console.log('[2/5] No duplicate plan_files found. Nothing to clean.');
        return;
    }

    const duplicateFiles = dupResult[0].values;
    console.log(`[2/5] Found ${duplicateFiles.length} duplicated plan_file(s)`);

    // 6. For each duplicate file, identify which rows to keep and which to delete
    const toDelete = [];
    for (const [planFile, count, sessionIdsStr, columnsStr] of duplicateFiles) {
        // Split the comma-concatenated values (safe because session_ids and
        // column names never contain commas)
        const sessionIds = String(sessionIdsStr).split(',');
        const columns = String(columnsStr).split(',');

        console.log(`  - plan_file "${planFile}": ${count} active rows`);
        for (let i = 0; i < sessionIds.length; i++) {
            console.log(`      session_id=${sessionIds[i]}  column=${columns[i]}`);
        }

        // Query full row details to decide which to keep
        const rowsResult = db.exec(`
            SELECT plan_id, kanban_column, updated_at, session_id
            FROM plans
            WHERE plan_file = '${planFile.replace(/'/g, "''")}' AND status = 'active'
            ORDER BY
                (kanban_column = 'CREATED') ASC,
                updated_at DESC
        `);

        if (rowsResult.length === 0) continue;
        const rows = rowsResult[0].values;

        // Keep the first row (non-CREATED preferred, then newest), delete the rest
        const [keep, ...rest] = rows;
        console.log(`    -> keeping plan_id=${keep[0]} session_id=${keep[3]} column=${keep[1]}`);
        for (const [pid, col, updated, sid] of rest) {
            toDelete.push(pid);
            console.log(`    -> deleting plan_id=${pid} session_id=${sid} column=${col}`);
        }
    }

    if (toDelete.length === 0) {
        console.log('[3/5] No duplicate rows to remove.');
        return;
    }

    console.log(`[3/5] Will delete ${toDelete.length} duplicate row(s)`);

    // 7. Delete the duplicate rows
    const placeholders = toDelete.map(() => '?').join(',');
    db.run(`DELETE FROM plans WHERE plan_id IN (${placeholders})`, toDelete);

    // 8. Persist the cleaned DB back to disk
    const cleanedData = db.export();
    await fs.promises.writeFile(DB_PATH, Buffer.from(cleanedData));
    console.log(`[4/5] Saved cleaned database to ${DB_PATH}`);

    // 9. Verify no duplicates remain
    const verifyResult = db.exec(`
        SELECT plan_file, COUNT(*) as cnt
        FROM plans
        WHERE status = 'active' AND plan_file != ''
        GROUP BY plan_file
        HAVING COUNT(*) > 1
    `);
    const remaining =
        verifyResult.length > 0 ? verifyResult[0].values.length : 0;
    console.log(`[5/5] Remaining duplicate plan_files: ${remaining}`);

    if (remaining > 0) {
        console.warn('[WARN] Some duplicates could not be removed. Inspect manually.');
        process.exitCode = 1;
    } else {
        console.log('[DONE] Cleanup complete. Reload VS Code window to refresh Kanban.');
    }
}

main().catch((err) => {
    console.error('[FATAL]', err);
    process.exit(1);
});
