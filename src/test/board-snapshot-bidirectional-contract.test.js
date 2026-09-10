'use strict';

/**
 * Contract: Bidirectional board snapshot — no local-tier field leakage.
 *
 * Asserts that the serialized board snapshot (board.json) contains ONLY
 * shared-tier fields and never carries local runtime state:
 *   - No dispatched_terminal, dispatched_agent, dispatched_ide
 *   - No last_liveness_at, dispatched_at, blocked_at
 *   - No worktree paths, filesystem paths (beyond relative planFile)
 *   - No tokens, secrets, or API keys
 *
 * Also asserts the bidirectional mode constant and CAS infrastructure exist.
 *
 * Run with:
 *   node src/test/board-snapshot-bidirectional-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', 'src', 'services', 'BoardSnapshotPublisher.ts');
const source = fs.readFileSync(SRC, 'utf8');

// `BoardCardEntry` is an alias of `SharedBoardCard`, which the tier split moved into
// storageTiers.ts as the single source of truth for what a shared card is. The
// field-leakage assertions below must follow it there — reading only
// BoardSnapshotPublisher.ts would pass vacuously against the bare alias while the
// actual shape grew local-tier fields elsewhere.
const TIERS_SRC = path.join(__dirname, '..', '..', 'src', 'services', 'storageTiers.ts');
const tiersSource = fs.readFileSync(TIERS_SRC, 'utf8');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function run() {
    console.log('\nboard-snapshot-bidirectional-contract\n');

    // ── 1. Bidirectional mode constant exists ────────────────────────────

    check('BOARD_SNAPSHOT_MODE_BIDIRECTIONAL constant exists', () => {
        assert.ok(/BOARD_SNAPSHOT_MODE_BIDIRECTIONAL\s*=/.test(source),
            'must export BOARD_SNAPSHOT_MODE_BIDIRECTIONAL');
    });

    // ── 2. CAS publish loop exists ───────────────────────────────────────

    check('CAS publish loop exists', () => {
        assert.ok(/_pushSnapshotCAS/.test(source), 'must have _pushSnapshotCAS method');
        assert.ok(/CAS_MAX_RETRIES/.test(source), 'must have CAS_MAX_RETRIES');
        assert.ok(/_replayIntents/.test(source), 'must have _replayIntents method');
    });

    // ── 3. Intent log exists ──────────────────────────────────────────────

    check('intent log infrastructure exists', () => {
        assert.ok(/recordIntent/.test(source), 'must have recordIntent method');
        assert.ok(/IntentEntry/.test(source), 'must have IntentEntry interface');
        assert.ok(/INTENT_MAX_AGE_MS/.test(source), 'must have INTENT_MAX_AGE_MS');
    });

    // ── 4. Ingest path exists ─────────────────────────────────────────────

    check('ingest path exists', () => {
        assert.ok(/public async ingest/.test(source), 'must have public ingest method');
        assert.ok(/applyBoardSnapshotCard/.test(source), 'must call applyBoardSnapshotCard');
    });

    // ── 5. Snapshot identity exists ──────────────────────────────────────

    check('snapshot identity (device_id, user_id) exists', () => {
        assert.ok(/device_id/.test(source), 'must have device_id field');
        assert.ok(/user_id/.test(source), 'must have user_id field');
        assert.ok(/_deviceId/.test(source), 'must have _deviceId');
        assert.ok(/setUserId/.test(source), 'must have setUserId method');
    });

    // ── 6. Ref hygiene exists ────────────────────────────────────────────

    check('ref hygiene (periodic squash) exists', () => {
        assert.ok(/_runHygiene/.test(source), 'must have _runHygiene method');
        assert.ok(/HYGIENE_MAX_COMMITS/.test(source), 'must have HYGIENE_MAX_COMMITS');
        assert.ok(/squash/.test(source), 'must mention squash in hygiene');
    });

    // ── 7. Schema 3 for bidirectional mode ───────────────────────────────

    check('schema 3 for bidirectional mode, schema 2 for read-only', () => {
        assert.ok(/schema:\s*this\._isBidirectional\(\)\s*\?\s*3\s*:\s*2/.test(source),
            'must use schema 3 for bidirectional, 2 for read-only');
    });

    // ── 8. No local-tier fields in BoardCardEntry ────────────────────────

    check('BoardCardEntry contains only shared-tier fields', () => {
        // BoardCardEntry is `type BoardCardEntry = SharedBoardCard`. Assert the alias
        // still points at the shared-tier definition, then read the fields from there.
        assert.ok(
            /type BoardCardEntry\s*=\s*SharedBoardCard\s*;/.test(source),
            'BoardCardEntry must alias SharedBoardCard — the shared-tier definition is the one under test'
        );
        const match = tiersSource.match(/export interface SharedBoardCard \{([\s\S]*?)\n\}/);
        assert.ok(match, 'SharedBoardCard interface must exist in storageTiers.ts');
        const fields = match[1];
        // Must contain shared-tier fields
        assert.ok(/plan_id/.test(fields), 'must have plan_id');
        assert.ok(/topic/.test(fields), 'must have topic');
        assert.ok(/column/.test(fields), 'must have column');
        assert.ok(/feature/.test(fields), 'must have feature');
        assert.ok(/project/.test(fields), 'must have project');
        assert.ok(/complexity/.test(fields), 'must have complexity');
        assert.ok(/planFile/.test(fields), 'must have planFile');
        // Must NOT contain local-tier fields
        assert.ok(!/dispatched_terminal/.test(fields), 'must NOT have dispatched_terminal');
        assert.ok(!/dispatched_agent/.test(fields), 'must NOT have dispatched_agent');
        assert.ok(!/dispatched_ide/.test(fields), 'must NOT have dispatched_ide');
        assert.ok(!/last_liveness_at/.test(fields), 'must NOT have last_liveness_at');
        assert.ok(!/dispatched_at/.test(fields), 'must NOT have dispatched_at');
        assert.ok(!/blocked_at/.test(fields), 'must NOT have blocked_at');
        assert.ok(!/worktree/.test(fields), 'must NOT have worktree paths');
        assert.ok(!/token/.test(fields), 'must NOT have token');
        assert.ok(!/secret/.test(fields), 'must NOT have secret');
        assert.ok(!/api_key/.test(fields), 'must NOT have api_key');
    });

    // ── 8b. The ticket projection is bounded ─────────────────────────────
    //
    // A card imported from Linear/ClickUp carries a ticket projection
    // (ticket-metadata-as-first-class-board-state.md). board.json is git-carried by
    // every clone, so that projection must stay a card index: the ticket BODY, its
    // comment thread and its attachment list belong in the Board store, not here.

    check('the shared ticket projection carries no body, comments or attachments', () => {
        const ticketsSrc = fs.readFileSync(
            path.join(__dirname, '..', '..', 'src', 'services', 'planTickets.ts'), 'utf8'
        );
        const match = ticketsSrc.match(/export interface SharedTicketProjection \{([\s\S]*?)\n\}/);
        assert.ok(match, 'SharedTicketProjection interface must exist');
        const fields = match[1];
        assert.ok(/external_id/.test(fields), 'must identify the ticket');
        assert.ok(/metadata_source/.test(fields), 'must say whether it was fetched or backfilled');
        for (const forbidden of ['body', 'comments', 'attachments', 'payload']) {
            assert.ok(
                !new RegExp(`\\b${forbidden}\\b`).test(fields),
                `SharedTicketProjection must NOT carry ${forbidden} — board.json is not a ticket archive`
            );
        }
    });

    // ── 9. Non-force push in CAS mode ────────────────────────────────────

    check('CAS mode uses non-force push', () => {
        // The CAS loop calls _pushSnapshotToRef with force=false
        assert.ok(/_pushSnapshotToRef\(root, replayedJson, md, html, false\)/.test(source),
            'CAS loop must push with force=false');
    });

    // ── 10. Dispose cleans up timers ─────────────────────────────────────

    check('dispose cleans up timers', () => {
        assert.ok(/public dispose\(\)/.test(source), 'must have dispose method');
        assert.ok(/clearTimeout\(this\._hygieneTimer\)/.test(source), 'must clear hygiene timer');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
