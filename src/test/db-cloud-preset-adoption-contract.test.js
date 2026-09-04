'use strict';

/**
 * Storage verification gap · Proposed Change 4
 * =============================================
 *
 * `adoptPresetDatabase` merges a cloud-synced preset DB (Dropbox/Google Drive/
 * iCloud) into the global store. The negative cases that must NOT silently
 * succeed:
 * 1. Source file not found → returns { success: false, skipped: 'source_not_found' }
 * 2. Source fails integrity check → returns { success: false, skipped: 'integrity_failed' }
 * 3. Source has diverged from target → returns { success: false, skipped: 'diverged' }
 * 4. `isKnownPresetDbPath` rejects non-preset paths (no false positives)
 * 5. `adoptPresetDbOnLaunch` returns null for non-preset configured paths
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:db-cloud-preset-adoption
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { KanbanDatabase } = require(path.join(process.cwd(), 'out', 'services', 'KanbanDatabase.js'));
const { isKnownPresetDbPath, detectSyncFolder, adoptPresetDatabase, adoptPresetDbOnLaunch } = require(path.join(process.cwd(), 'out', 'services', 'cloudSyncMigration.js'));

async function run() {
    const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sb-cloud-preset-'));
    try {
        await test_isKnownPresetDbPath_rejects_non_preset_paths();
        await test_detectSyncFolder_identifies_known_sync_folders();
        await test_adoptPresetDatabase_source_not_found(tmpRoot);
        await test_adoptPresetDatabase_integrity_failure(tmpRoot);
        await test_adoptPresetDbOnLaunch_returns_null_for_non_preset(tmpRoot);
        await test_adoptPresetDbOnLaunch_returns_null_for_missing_preset_file(tmpRoot);

        console.log('\nAll db-cloud-preset-adoption contract tests passed.');
    } finally {
        await KanbanDatabase.disposeAll();
        try { global.gc && global.gc(); } catch {}
        try { await fs.promises.rm(tmpRoot, { recursive: true, force: true }); } catch {}
    }
}

async function test_isKnownPresetDbPath_rejects_non_preset_paths() {
    // Positive cases
    assert.strictEqual(isKnownPresetDbPath('/Users/foo/Dropbox/Switchboard/kanban.db'), true, 'Dropbox preset detected');
    assert.strictEqual(isKnownPresetDbPath('/Users/foo/Google Drive/Switchboard/kanban.db'), true, 'Google Drive preset detected');
    assert.strictEqual(isKnownPresetDbPath('/Users/foo/iCloud Drive/Switchboard/kanban.db'), true, 'iCloud Drive preset detected');

    // Negative cases — must NOT match
    assert.strictEqual(isKnownPresetDbPath('/Users/foo/.switchboard/kanban.db'), false, 'local .switchboard is not a preset');
    assert.strictEqual(isKnownPresetDbPath('/Users/foo/Switchboard/kanban.db'), false, 'bare Switchboard dir without cloud parent is not a preset');
    assert.strictEqual(isKnownPresetDbPath('/Users/foo/Dropbox/Other/kanban.db'), false, 'Dropbox but not Switchboard/kanban.db');
    assert.strictEqual(isKnownPresetDbPath(''), false, 'empty string is not a preset');
    assert.strictEqual(isKnownPresetDbPath(null), false, 'null is not a preset');
    assert.strictEqual(isKnownPresetDbPath(undefined), false, 'undefined is not a preset');

    console.log('Pass: isKnownPresetDbPath rejects non-preset paths (no false positives)');
}

async function test_detectSyncFolder_identifies_known_sync_folders() {
    assert.strictEqual(detectSyncFolder('/Users/foo/Dropbox/file.db'), 'Dropbox', 'Dropbox detected');
    assert.strictEqual(detectSyncFolder('/Users/foo/Google Drive/file.db'), 'Google Drive', 'Google Drive detected');
    assert.strictEqual(detectSyncFolder('/Users/foo/OneDrive/file.db'), 'OneDrive', 'OneDrive detected');
    assert.strictEqual(detectSyncFolder('/Users/foo/iCloud Drive/file.db'), 'iCloud Drive', 'iCloud Drive detected');
    assert.strictEqual(detectSyncFolder('/Users/foo/Documents/file.db'), null, 'non-sync folder returns null');
    assert.strictEqual(detectSyncFolder(''), null, 'empty string returns null');

    console.log('Pass: detectSyncFolder identifies known sync folders');
}

async function test_adoptPresetDatabase_source_not_found(tmpRoot) {
    const nonexistentPath = path.join(tmpRoot, 'nonexistent', 'kanban.db');
    const result = await adoptPresetDatabase(nonexistentPath, { targetDbPath: path.join(tmpRoot, 'target.db') });
    assert.strictEqual(result.success, false, 'source not found → success=false');
    assert.strictEqual(result.skipped, 'source_not_found', 'skipped reason is source_not_found');
    assert.ok(result.error, 'error message provided');

    console.log('Pass: adoptPresetDatabase returns source_not_found for missing source');
}

async function test_adoptPresetDatabase_integrity_failure(tmpRoot) {
    // Create a corrupt DB file (not a valid SQLite file).
    const corruptPath = path.join(tmpRoot, 'corrupt-kanban.db');
    await fs.promises.writeFile(corruptPath, 'this is not a SQLite database file');
    const result = await adoptPresetDatabase(corruptPath, { targetDbPath: path.join(tmpRoot, 'target.db') });
    assert.strictEqual(result.success, false, 'corrupt source → success=false');
    assert.strictEqual(result.skipped, 'integrity_failed', 'skipped reason is integrity_failed');
    assert.ok(result.error, 'error message provided');

    console.log('Pass: adoptPresetDatabase returns integrity_failed for corrupt source');
}

async function test_adoptPresetDbOnLaunch_returns_null_for_non_preset(tmpRoot) {
    // A non-preset path should return null without attempting adoption.
    const nonPresetPath = path.join(tmpRoot, '.switchboard', 'kanban.db');
    await fs.promises.mkdir(path.dirname(nonPresetPath), { recursive: true });
    await fs.promises.writeFile(nonPresetPath, 'dummy');

    let clearConfigCalled = false;
    const result = await adoptPresetDbOnLaunch(
        nonPresetPath,
        {
            clearDbPathConfig: async () => { clearConfigCalled = true; },
            notify: () => {},
            warn: () => {},
            error: () => {},
        },
        tmpRoot
    );
    assert.strictEqual(result, null, 'non-preset path returns null');
    assert.strictEqual(clearConfigCalled, false, 'clearDbPathConfig NOT called for non-preset path');

    console.log('Pass: adoptPresetDbOnLaunch returns null for non-preset configured path');
}

async function test_adoptPresetDbOnLaunch_returns_null_for_missing_preset_file(tmpRoot) {
    // A preset path that does not exist should return null AND clear the config.
    const missingPresetPath = '/Users/foo/Dropbox/Switchboard/kanban.db';
    let clearConfigCalled = false;
    const result = await adoptPresetDbOnLaunch(
        missingPresetPath,
        {
            clearDbPathConfig: async () => { clearConfigCalled = true; },
            notify: () => {},
            warn: () => {},
            error: () => {},
        },
        tmpRoot
    );
    assert.strictEqual(result, null, 'missing preset file returns null');
    assert.strictEqual(clearConfigCalled, true, 'clearDbPathConfig called for missing preset file');

    console.log('Pass: adoptPresetDbOnLaunch returns null and clears config for missing preset file');
}

run().catch((err) => {
    console.error('Test failed:', err && err.stack ? err.stack : err);
    process.exit(1);
});
