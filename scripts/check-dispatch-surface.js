#!/usr/bin/env node
'use strict';

/**
 * Dispatch-surface ratchet — the `apiOriginated` caller-surface flag must not
 * grow back.
 *
 * What was deleted: the flag answered "what kind of client is calling?" and
 * selected the terminal set from the answer. Terminal dispatch now resolves by
 * NAME (`TaskViewerProvider._pickTerminalCandidate`: live-first, fleet-wins-
 * among-equals); nothing in the dispatch path reads a caller surface. Its
 * failure mode was a silent positive — drop it at any hop and dispatch still
 * resolves a terminal, delivers, and returns true. No error, no log. This
 * script is what converts "grep returns nothing today" into "grep returns
 * nothing tomorrow".
 *
 * This is a RATCHET for `apiOriginated`: a few dead-slot registrations and
 * explanatory comments survive (baselines below). A file exceeding its
 * baseline fails; below baseline is an improvement to lock in by lowering the
 * table.
 *
 * `allowPtyFleet` is PINNED, not banned — the inverse of a ratchet. It is a
 * live, load-bearing, intentional opt-in on the terminal-pool resolver
 * (`getRoleTerminalSet` / `_getAliveAutobanTerminalRegistry`), set
 * unconditionally by its planner-fleet callers in BOTH hosts. Four contract
 * tests assert these exact shapes exist
 * (src/test/browser-planner-dispatch-surface.test.js:148-184). The count is a
 * floor AND a ceiling: growing it reintroduces a caller-surface signal, and
 * "improving" it toward zero deletes the PTY-liveness branch — the planner
 * terminal grid re-collapses onto one terminal and the standalone host, where
 * PTY is the only fleet, goes permanently empty.
 *
 * Arity assertion: `executeCommand` is untyped through the command-registry
 * seam, so deleting the retained `_apiOriginated` dead slot produces no
 * compile error — it silently slides `bypassTriggerGate` into slot 6 while the
 * occurrence count goes DOWN. The single-card registration in extension.ts is
 * the half no test covers; the batch registrations in BOTH hosts are already
 * asserted by src/test/dispatch-analysis-scope-contract.test.js ("both host
 * registrations declare analysisScope as the 7th positional") — do not
 * duplicate that here.
 *
 * Scan scope: src/**\/*.ts, src/**\/*.js and everything under src/webview/,
 * EXCLUDING src/test/** (the contract tests legitimately name the identifier
 * ~60 times). Baselines are occurrence counts per file, never line numbers —
 * lines drift.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const SRC_ROOT = path.join(REPO_ROOT, 'src');

// `apiOriginated` occurrences allowed per file (registrations + comments).
// Measured at HEAD. LOWER these as slots/comments are removed; NEVER raise.
const API_ORIGINATED_BASELINES = {
    'src/extension.ts': 4,            // 2 dead-slot registrations + 2 explaining comments
    'src/standalone/bootstrap.ts': 3, // 2 dead-slot registrations + 1 explaining comment
    'src/services/KanbanProvider.ts': 1, // comment inside the allowPtyFleet rationale block
};

// `allowPtyFleet` occurrences required per file — the intended pool-resolver
// API. PINNED both ways: growth is a new caller-surface signal; shrinkage is a
// deleted load-bearing site. Change a pin only with a reason written here.
const ALLOW_PTY_FLEET_PINS = {
    'src/services/TaskViewerProvider.ts': 7, // 3 signatures + isPtyRow gate + 2 internal callers + 1 comment
    'src/services/KanbanProvider.ts': 2,     // unconditional { allowPtyFleet: true } call + rationale comment
    'src/standalone/bootstrap.ts': 2,        // unconditional { allowPtyFleet: true } call + rationale comment
};

const IDENTIFIERS = [
    { name: 'apiOriginated', table: API_ORIGINATED_BASELINES, mode: 'ratchet' },
    { name: 'allowPtyFleet', table: ALLOW_PTY_FLEET_PINS, mode: 'pin' },
];

function collectFiles(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            collectFiles(full, out);
        } else {
            out.push(full);
        }
    }
    return out;
}

function relPosix(full) {
    return path.relative(REPO_ROOT, full).split(path.sep).join('/');
}

const files = collectFiles(SRC_ROOT).filter((full) => {
    const rel = relPosix(full);
    if (rel.startsWith('src/test/')) return false;
    if (rel.startsWith('src/webview/')) return true;
    return rel.endsWith('.ts') || rel.endsWith('.js');
});

let failed = false;
console.log('=== Dispatch-surface ratchet ===\n');

for (const { name, table, mode } of IDENTIFIERS) {
    // Reject identifiers that merely START with the name, or the pin is
    // satisfiable by a RENAME: `allowPtyFleet` → `allowPtyFleetV2` deletes the
    // load-bearing API while a bare substring scan still counts 7 and reports
    // the floor as held. A leading `_` is deliberately still matched — the dead
    // slot is spelled `_apiOriginated`.
    const re = new RegExp(`${name}(?![A-Za-z0-9_])`, 'g');
    console.log(`── ${name} (${mode}) ──`);
    const seen = new Set();
    for (const full of files) {
        const rel = relPosix(full);
        let src;
        try {
            src = fs.readFileSync(full, 'utf8');
        } catch {
            continue;
        }
        const lines = src.split('\n');
        const hitLines = [];
        let count = 0;
        for (let i = 0; i < lines.length; i++) {
            const n = (lines[i].match(re) || []).length;
            if (n > 0) {
                hitLines.push(i + 1);
                count += n;
            }
        }
        const baseline = Object.prototype.hasOwnProperty.call(table, rel) ? table[rel] : 0;
        if (count === 0 && baseline === 0) continue;
        seen.add(rel);
        const base = path.basename(rel);
        if (mode === 'ratchet') {
            if (count > baseline) {
                console.error(`❌ ${rel}:${hitLines.join(',')}: ${count} '${name}' (baseline ${baseline}) — the caller-surface flag is growing back. Terminal dispatch resolves by NAME now; do not thread a surface boolean.`);
                failed = true;
            } else if (count < baseline) {
                console.log(`✅ ${base}: ${count} (baseline ${baseline}) — improved; lower the baseline in scripts/check-dispatch-surface.js to lock it in.`);
            } else {
                console.log(`✅ ${base}: ${count} (baseline ${baseline})`);
            }
        } else {
            if (count > baseline) {
                console.error(`❌ ${rel}:${hitLines.join(',')}: ${count} '${name}' (pin ${baseline}) — a NEW allowPtyFleet site is a caller-surface signal growing back. The flag is an opt-in on the pool resolver, not a dispatch-path parameter.`);
                failed = true;
            } else if (count < baseline) {
                console.error(`❌ ${rel}: ${count} '${name}' (pin ${baseline}) — a load-bearing allowPtyFleet site was deleted. Four contract tests assert these shapes; dropping them re-collapses the planner terminal grid and leaves the standalone host's PTY-only fleet empty.`);
                failed = true;
            } else {
                console.log(`✅ ${base}: ${count} (pin ${baseline})`);
            }
        }
    }
    for (const rel of Object.keys(table)) {
        if (!seen.has(rel)) {
            if (mode === 'ratchet') {
                console.log(`✅ ${rel}: gone or empty (baseline ${table[rel]}) — lower the baseline to lock it in.`);
            } else {
                console.error(`❌ ${rel}: file missing or pin count fell to 0 — a pinned allowPtyFleet site was deleted.`);
                failed = true;
            }
        }
    }
    console.log('');
}

// Arity assertion: extension.ts's single-card registration must keep the
// retained `_apiOriginated` dead slot ahead of `bypassTriggerGate` and
// `unattended`. Same walk as dispatch-analysis-scope-contract.test.js:180-186.
{
    const ext = fs.readFileSync(path.join(REPO_ROOT, 'src/extension.ts'), 'utf8');
    const reg = ext.split('switchboard.triggerAgentFromKanban')[1] || '';
    const sig = reg.slice(0, reg.indexOf('=>'));
    // Walk the declared PARAMETER NAMES, not string offsets. Offsets only prove
    // relative order, so deleting a slot AHEAD of the dead one (e.g.
    // targetTerminalOverride) slides all three down together and still reads as
    // ordered — while every positional caller is now off by one. The three must
    // be CONSECUTIVE, which is the property the untyped seam actually depends on.
    const open = sig.indexOf('(');
    const close = sig.lastIndexOf(')');
    const params = open === -1 || close < open
        ? []
        : sig.slice(open + 1, close).split(',').map((p) => p.trim().split(/[?:]/)[0].trim()).filter(Boolean);
    const order = ['_apiOriginated', 'bypassTriggerGate', 'unattended'];
    // Consecutive AND at a fixed absolute slot. Consecutiveness alone is not
    // enough: deleting `targetTerminalOverride?` (slot 5) keeps the three
    // adjacent while sliding them to 5/6/7, and every positional caller —
    // KanbanProvider's triggerAction arm passes `undefined` into slot 6 by
    // hand — is then off by one, with no compile error. `_apiOriginated` is the
    // SIXTH positional; the batch command's equivalent is pinned the same way
    // by dispatch-analysis-scope-contract.test.js ("the 7th positional").
    const DEAD_SLOT_INDEX = 5; // 0-based; the 6th parameter
    const ok = order.every((pname, i) => params[DEAD_SLOT_INDEX + i] === pname);
    if (!ok) {
        console.error(`❌ extension.ts: switchboard.triggerAgentFromKanban must declare ${order.join('?, ')}? as positionals ${DEAD_SLOT_INDEX + 1}–${DEAD_SLOT_INDEX + order.length} — found [${params.join(', ')}]. The dead slot protects the untyped executeCommand seam; removing, reordering or inserting ahead of it shifts bypassTriggerGate under every positional caller with no compile error.`);
        failed = true;
    } else {
        console.log(`✅ extension.ts: triggerAgentFromKanban dead slot intact (positional ${DEAD_SLOT_INDEX + 1}: _apiOriginated? → bypassTriggerGate? → unattended?)`);
    }
}

if (failed) {
    console.error('\n❌ Dispatch-surface check failed. The caller-surface flag must not re-enter the dispatch path — resolution is by name.');
    process.exit(1);
}
console.log('\n✅ Dispatch-surface check passed.');
process.exit(0);
