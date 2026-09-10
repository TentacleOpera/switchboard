'use strict';

/**
 * Storage Topology Contract Test
 * ==============================
 *
 * Verifies:
 * 1. Retired mechanisms absent from config schema (package.json):
 *    switchboard.kanban.dbPath
 *    switchboard.archive.dbPath
 *    switchboard.workspaceDatabaseMappings
 *    switchboard.kanban.controlPlaneRoot
 *    switchboard.boardStateExport
 * 2. Path override is the sole path-setting surface in package.json, defaults empty,
 *    and is described as advanced.
 * 3. storageTopology.ts definition and invariants for Runtime, Board, Archive.
 * 4. Derived placement resolvers and override validation.
 * 5. DuckDB is reachable only from ArchiveManager (opt-in analytics), and never
 *    defaults onto the SQLite cold store's own file.
 * 6. Every `plans` column is named by exactly one tier in storageTiers.ts, the four
 *    V74-dropped columns are absent from `plans` and present in `plan_runtime_state`,
 *    `vector_clock` is gone from the current schema, and the runtime orphan sweep is
 *    both defined and invoked.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

if (!process.env.SWITCHBOARD_STATE_HOME) {
    try {
        require('./bootstrap/sandboxStateHome');
    } catch {}
}

async function run() {
    console.log('Running storage-topology-contract tests...');

    // 1. package.json schema check
    const packageJsonPath = path.join(__dirname, '..', '..', 'package.json');
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const properties = packageJson.contributes.configuration.properties;

    const retiredKeys = [
        'switchboard.kanban.dbPath',
        'switchboard.archive.dbPath',
        'switchboard.workspaceDatabaseMappings',
        'switchboard.kanban.controlPlaneRoot',
        'switchboard.boardStateExport',
        'switchboard.boardStateExport.remoteUrl',
    ];

    for (const key of retiredKeys) {
        assert.strictEqual(
            properties[key],
            undefined,
            `Retired configuration key "${key}" MUST NOT be present in package.json configuration schema.`
        );
    }

    // Assert advanced path override exists
    assert(
        properties['switchboard.storage.pathOverride'],
        'switchboard.storage.pathOverride MUST be defined in package.json as an advanced override.'
    );

    // 2. storageTopology module export and invariants
    let topologyModule;
    try {
        topologyModule = require('../services/storageTopology');
    } catch {
        // May be running against compiled out/
        topologyModule = require('../../out/services/storageTopology');
    }

    const { STORAGE_TOPOLOGY, resolveStorageTopology, validatePathOverride } = topologyModule;

    assert(STORAGE_TOPOLOGY, 'STORAGE_TOPOLOGY must be exported');
    assert(STORAGE_TOPOLOGY.runtime, 'Runtime store must be defined');
    assert(STORAGE_TOPOLOGY.board, 'Board store must be defined');
    assert(STORAGE_TOPOLOGY.archive, 'Archive store must be defined');

    // Invariants check
    assert(
        STORAGE_TOPOLOGY.runtime.replication.includes('Never leaves') ||
        STORAGE_TOPOLOGY.runtime.placement.includes('local'),
        'Runtime store must be strictly local and never leave machine'
    );
    assert(
        STORAGE_TOPOLOGY.board.lifecycle.includes('Authoritative') ||
        STORAGE_TOPOLOGY.board.placement.includes('target'),
        'Board store must be authoritative and follow chosen target'
    );
    assert(
        STORAGE_TOPOLOGY.archive.lifecycle.includes('on-demand') ||
        STORAGE_TOPOLOGY.archive.placement.includes('derived'),
        'Archive store must be on-demand and derived from target'
    );

    // 3. Derived placement
    const testWsId = 'test-workspace-1234';
    const topology = resolveStorageTopology(testWsId);
    assert.strictEqual(topology.workspaceId, testWsId);
    assert(topology.board.path.endsWith(`${testWsId}.db`), 'Board path must end with workspace-id.db');
    assert.strictEqual(topology.board.source, 'board_default');
    assert(topology.archive.path.endsWith(`${testWsId}-archive.db`), 'Archive path must end with workspace-id-archive.db');
    assert.strictEqual(topology.archive.source, 'board_default');
    assert(topology.runtime.path.endsWith(`${testWsId}.runtime.db`), 'Runtime path must end with workspace-id.runtime.db');
    assert.strictEqual(topology.runtime.source, 'local_default');

    // 4. Override validation
    const repoPathCheck = validatePathOverride(path.join(__dirname, '..', '..'));
    assert.strictEqual(
        repoPathCheck.ok,
        false,
        'validatePathOverride must reject paths inside a git repository'
    );

    // 5. The override is the SOLE path input in the product.
    //
    // Goal Invariant: "assert the path override is the sole path-setting surface".
    // The header claimed this check; it was never made. Without it, retiring five
    // path mechanisms buys nothing — the sixth grows back as a new setting, which is
    // exactly how the ten answers accumulated. `storage.archivePathOverride` is
    // deliberately NOT contributed: the Archive is DERIVED from the target, and the
    // DuckDB analytics export reads its opt-in path from the retired key or the
    // environment rather than adding a second path field.
    const PATH_INPUT_ALLOWLIST = new Set(['switchboard.storage.pathOverride']);
    const pathLikeKeys = Object.entries(properties)
        .filter(([key, def]) => {
            if (PATH_INPUT_ALLOWLIST.has(key)) { return false; }
            if (def && def.type !== 'string') { return false; }
            // A *path input* names a filesystem location for a Switchboard store.
            // Workflow/skill/doc-file settings are not storage placement.
            return /(^|\.)(dbPath|databasePath|storePath|archivePath|archivePathOverride|controlPlaneRoot)$/i.test(key)
                || /(^|\.)(storage)\.[A-Za-z]*[Pp]ath/.test(key);
        })
        .map(([key]) => key);
    assert.deepStrictEqual(
        pathLikeKeys,
        [],
        `switchboard.storage.pathOverride must be the ONLY storage path input in the config schema. Extra path settings: ${pathLikeKeys.join(', ')}`
    );

    // The override must not appear in any default, onboarding copy or help text.
    const overrideDef = properties['switchboard.storage.pathOverride'];
    assert.strictEqual(
        overrideDef.default,
        '',
        'switchboard.storage.pathOverride must default to empty — a fresh install performs zero storage configuration.'
    );
    assert.ok(
        /advanced/i.test(String(overrideDef.description || '')),
        'switchboard.storage.pathOverride must be described as an advanced override, so it is not read as the interface.'
    );

    // 6. DuckDB is off every board read path.
    //
    // Goal Invariant: "assert no board read path imports or shells out to duckdb".
    // Also claimed in this file's header and never asserted. `ArchiveManager` is the
    // opt-in analytics export and is the ONLY module allowed to name the binary.
    const servicesDir = path.join(__dirname, '..', 'services');
    const DUCKDB_ALLOWED = new Set(['ArchiveManager.ts']);
    const duckDbOffenders = [];
    for (const file of fs.readdirSync(servicesDir)) {
        if (!file.endsWith('.ts') || DUCKDB_ALLOWED.has(file)) { continue; }
        const src = fs.readFileSync(path.join(servicesDir, file), 'utf8');
        // Match an actual invocation or import, not the word in a comment.
        if (/execFile(?:Async|Sync)?\(\s*['"`]duckdb['"`]/.test(src)
            || /require\(\s*['"`]duckdb['"`]/.test(src)
            || /from\s+['"`]duckdb['"`]/.test(src)) {
            duckDbOffenders.push(file);
        }
    }
    assert.deepStrictEqual(
        duckDbOffenders,
        [],
        `Only ArchiveManager may reach the duckdb CLI; the board must render with no duckdb binary present. Offenders: ${duckDbOffenders.join(', ')}`
    );

    // The DuckDB archive must be OPT-IN: no derived default may point it at the
    // SQLite cold store's own file, because two engines on one path means whichever
    // writes first makes the file unreadable to the other.
    const archiveMgrSrc = fs.readFileSync(path.join(servicesDir, 'ArchiveManager.ts'), 'utf8');
    assert.ok(
        !/_archivePath\s*=\s*[^;]*resolveArchiveDbPath\(/.test(archiveMgrSrc),
        'ArchiveManager must NOT default its DuckDB path to resolveArchiveDbPath() — that is the SQLite cold store file.'
    );
    assert.ok(
        /'legacy:archive\.dbPath'/.test(archiveMgrSrc),
        'ArchiveManager must still READ the retired switchboard.archive.dbPath, tagged as legacy, so an existing DuckDB archive is not orphaned.'
    );

    // 7. Every `plans` column belongs to exactly one tier.
    //
    // The tier constants are the plan's "single source no future reader has to
    // re-derive". They had NO consumer at first landing, so nothing noticed that
    // worktree_id / worktree_status were in neither list. This is what makes them
    // load-bearing rather than decorative.
    let tiersModule;
    try {
        tiersModule = require('../services/storageTiers');
    } catch {
        tiersModule = require('../../out/services/storageTiers');
    }
    const { SHARED_PLAN_COLUMNS, LOCAL_PLAN_COLUMNS } = tiersModule;
    const kanbanDbSrc = fs.readFileSync(path.join(servicesDir, 'KanbanDatabase.ts'), 'utf8');
    const plansDdl = kanbanDbSrc.match(/CREATE TABLE IF NOT EXISTS plans\s*\(([\s\S]*?)\n\);/);
    assert.ok(plansDdl, 'Could not locate the plans DDL in KanbanDatabase.ts');
    const ddlColumns = plansDdl[1]
        .split('\n')
        .map(line => line.trim())
        .filter(line => line && !line.startsWith('--'))
        .map(line => (line.match(/^(\w+)\s/) || [])[1])
        .filter(Boolean);
    assert.ok(ddlColumns.length > 20, `Parsed only ${ddlColumns.length} plans columns — the DDL parse is wrong.`);
    const shared = new Set(SHARED_PLAN_COLUMNS);
    const local = new Set(LOCAL_PLAN_COLUMNS);
    const untiered = ddlColumns.filter(c => !shared.has(c) && !local.has(c));
    const doubleTiered = ddlColumns.filter(c => shared.has(c) && local.has(c));
    assert.deepStrictEqual(untiered, [],
        `Every plans column must be named by storageTiers. Untiered: ${untiered.join(', ')}`);
    assert.deepStrictEqual(doubleTiered, [],
        `A plans column cannot be both tiers. Both: ${doubleTiered.join(', ')}`);

    // The four columns V74 physically removed must be absent from the DDL, and
    // present in the local-tier table (absent HERE, present THERE — the paired
    // positive the tier-split plan's Goal Invariants require).
    for (const dropped of ['dispatched_terminal', 'dispatched_at', 'last_liveness_at', 'blocked_at']) {
        assert.ok(!ddlColumns.includes(dropped),
            `${dropped} must be absent from the plans DDL after the V74 tier split.`);
        assert.ok(local.has(dropped), `${dropped} must be named as a local-tier column.`);
        assert.ok(
            new RegExp(`CREATE TABLE IF NOT EXISTS plan_runtime_state[\\s\\S]*?${dropped}`).test(kanbanDbSrc),
            `${dropped} must be resolvable in plan_runtime_state.`
        );
    }
    assert.ok(
        /PRIMARY KEY \(plan_id, device_id\)/.test(kanbanDbSrc),
        'plan_runtime_state must be keyed by plan_id + device_id.'
    );

    // 8. `vector_clock` is gone from the CURRENT schema and from every INSERT site.
    // Shipped MIGRATION_V5/V20 bodies keep it by design — a historical migration body
    // is never edited (see CLAUDE.md) — so those two are the only permitted mentions.
    const vectorClockLines = kanbanDbSrc.split('\n').filter(line => line.includes('vector_clock'));
    assert.ok(vectorClockLines.length <= 4,
        `vector_clock survives in ${vectorClockLines.length} places; only the shipped V5/V20 migration bodies may mention it.`);
    const currentPlanEvents = kanbanDbSrc.match(/CREATE TABLE IF NOT EXISTS plan_events \(([\s\S]*?)\n\);/);
    assert.ok(currentPlanEvents, 'Could not locate the current plan_events DDL');
    assert.ok(!currentPlanEvents[1].includes('vector_clock'),
        'vector_clock must be absent from the current plan_events schema.');

    // 9. The runtime-tier orphan sweep exists and is invoked.
    assert.ok(/public async sweepOrphanedRuntimeState\(/.test(kanbanDbSrc),
        'The tier split requires an orphan sweep for local-tier rows whose shared row is gone.');
    assert.ok(/await this\.sweepOrphanedRuntimeState\(\)/.test(kanbanDbSrc),
        'sweepOrphanedRuntimeState must actually be called — a defined-but-uninvoked sweep is not a sweep.');

    console.log('All storage-topology-contract tests passed.');
}

if (require.main === module) {
    run().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { run };
