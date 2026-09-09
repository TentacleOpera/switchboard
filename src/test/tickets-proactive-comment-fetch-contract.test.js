'use strict';

/**
 * Contract: Proactive ticket comment fetching on selection, refresh, and refetch.
 *
 * Source-level assertions per the plan:
 *  1. ticketCommentsCache and _COMMENT_PREFETCH_TTL_MS exist.
 *  2. Selection paths (Linear + ClickUp) prefetch comments gated by cache freshness.
 *  3. importAllTicketsComplete refetches comments gated on !message.autoSync.
 *  4. ticketCommentsLoaded populates the cache unconditionally.
 *  5. openCommentManager renders cached threads instantly if present.
 *
 * Run with:
 *   node src/test/tickets-proactive-comment-fetch-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const SRC = path.join(__dirname, '..', '..', 'src', 'webview', 'tickets.js');
const source = fs.readFileSync(SRC, 'utf8');

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
    console.log('\ntickets-proactive-comment-fetch-contract\n');

    // ── 1. Cache and TTL exist ───────────────────────────────────────────

    check('ticketCommentsCache and _COMMENT_PREFETCH_TTL_MS exist', () => {
        assert.ok(/const ticketCommentsCache = new Map\(\)/.test(source), 'must declare ticketCommentsCache Map');
        assert.ok(/_COMMENT_PREFETCH_TTL_MS\s*=\s*\d+/.test(source), 'must declare _COMMENT_PREFETCH_TTL_MS');
    });

    // ── 2. Selection paths prefetch comments ─────────────────────────────

    check('Linear selection path prefetches comments gated by cache freshness', () => {
        assert.ok(/loadCommentThreads\('linear', _id\)/.test(source), 'must call loadCommentThreads for Linear');
        assert.ok(/ticketCommentsCache\.get\(_id\)/.test(source), 'must check cache before prefetch');
        assert.ok(/_COMMENT_PREFETCH_TTL_MS/.test(source), 'must use TTL gate');
    });

    check('ClickUp selection path prefetches comments gated by cache freshness', () => {
        assert.ok(/loadCommentThreads\('clickup', _id\)/.test(source), 'must call loadCommentThreads for ClickUp');
    });

    // ── 3. importAllTicketsComplete refetch gated on !autoSync ──────────

    check('importAllTicketsComplete refetches comments gated on !message.autoSync', () => {
        // Find the importAllTicketsComplete handler
        const idx = source.indexOf("case 'importAllTicketsComplete':");
        assert.ok(idx >= 0, 'importAllTicketsComplete handler must exist');
        const handlerBody = source.slice(idx, idx + 3000);
        assert.ok(/!message\.autoSync/.test(handlerBody), 'must gate on !message.autoSync');
        assert.ok(/loadCommentThreads\(lastIntegrationProvider, activeId\)/.test(handlerBody),
            'must call loadCommentThreads for the active ticket');
    });

    // ── 4. ticketCommentsLoaded populates cache unconditionally ──────────

    check('ticketCommentsLoaded populates cache unconditionally', () => {
        const idx = source.indexOf("case 'ticketCommentsLoaded':");
        assert.ok(idx >= 0, 'ticketCommentsLoaded handler must exist');
        const handlerBody = source.slice(idx, idx + 1000);
        assert.ok(/ticketCommentsCache\.set\(message\.id/.test(handlerBody),
            'must call ticketCommentsCache.set with message.id');
    });

    // ── 5. openCommentManager renders cached threads instantly ──────────

    check('openCommentManager renders cached threads if present', () => {
        const idx = source.indexOf('function openCommentManager(');
        assert.ok(idx >= 0, 'openCommentManager must exist');
        const fnBody = source.slice(idx, idx + 1000);
        assert.ok(/ticketCommentsCache\.get\(id\)/.test(fnBody), 'must check cache for instant render');
        assert.ok(/renderCommentManager\(_cmThreads, _cmMembers\)/.test(fnBody),
            'must render cached threads instantly');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
