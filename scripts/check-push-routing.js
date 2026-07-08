#!/usr/bin/env node
'use strict';

/**
 * Push-routing ratchet guard — Feature A · A2b (Gap A).
 *
 * Host→UI push sites in the provider files must route through the broadcast
 * transport (`broadcaster.push` / `pushTo` / `_pushTo` / `postMessageToWebview` /
 * `postMessageToProjectWebview` / `mirrorToWs`) so external WS/browser clients get
 * live updates instead of going stale. A raw `panel.webview.postMessage(...)` in a
 * provider bypasses that and drops the push from every remote client.
 *
 * This is a RATCHET, not a zero-check: each provider still has a few transport-
 * INTERNAL raw sends (the helper fallbacks themselves). The baselines below are the
 * currently-allowed counts; the guard fails if a file EXCEEDS its baseline (i.e. a
 * new bypass slipped in). Baselines must never be raised — they should only ever be
 * lowered, trending to 0 as the last helper fallbacks are consolidated.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// Allowed raw `.webview.postMessage(` count per provider (transport-internal fallbacks).
// LOWER these as fallbacks are removed; NEVER raise them.
const BASELINES = {
    'src/services/KanbanProvider.ts': 1,
    'src/services/PlanningPanelProvider.ts': 3,
    'src/services/DesignPanelProvider.ts': 1,
    'src/services/SetupPanelProvider.ts': 1,
    'src/services/TaskViewerProvider.ts': 1,
};

const RE = /\.webview\.postMessage\s*\(/g;

let failed = false;
console.log('=== Push-routing ratchet ===\n');
for (const [rel, baseline] of Object.entries(BASELINES)) {
    const full = path.join(REPO_ROOT, rel);
    let count = 0;
    try {
        const src = fs.readFileSync(full, 'utf8');
        count = (src.match(RE) || []).length;
    } catch {
        console.log(`⚠️  not found: ${rel}`);
        continue;
    }
    const base = path.basename(rel);
    if (count > baseline) {
        console.error(`❌ ${base}: ${count} raw webview.postMessage (baseline ${baseline}) — a new push site bypassed the broadcast transport. Route it through a helper (push/pushTo/_pushTo/postMessageTo*), or if it is a genuine transport-internal fallback, justify it and lower nothing.`);
        failed = true;
    } else if (count < baseline) {
        console.log(`✅ ${base}: ${count} (baseline ${baseline}) — improved; lower the baseline in scripts/check-push-routing.js to lock it in.`);
    } else {
        console.log(`✅ ${base}: ${count} (baseline ${baseline})`);
    }
}

if (failed) {
    console.error('\n❌ Push-routing check failed. New raw webview.postMessage must route through the broadcast abstraction (Gap A).');
    process.exit(1);
}
console.log('\n✅ Push-routing check passed.');
process.exit(0);
