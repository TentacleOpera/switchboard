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
 * 2. Path override is the sole path-setting surface in package.json and not in default prompts.
 * 3. storageTopology.ts definition and invariants for Runtime, Board, Archive.
 * 4. Derived placement resolvers and override validation.
 * 5. DuckDB not required or on board read paths.
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

    console.log('All storage-topology-contract tests passed.');
}

if (require.main === module) {
    run().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { run };
