#!/usr/bin/env node
'use strict';

/**
 * Kanban Dispatch Callers Guard.
 *
 * Ensures the webview's CODED_AUTO drop path sends `targetColumn: 'CODED_AUTO'`
 * as intent (not a pre-resolved column), that the server's KanbanProvider
 * delegates CODED_AUTO to `_advanceCards` for per-card complexity routing, and
 * — the ratchet — that no NEW arm open-codes a direct
 * `executeCommand('switchboard.trigger*AgentFromKanban', …)` call instead of
 * routing through `_advanceCards`.
 *
 * Assertions:
 *  1. resolveCodedAutoTarget is absent from kanban.html (deleted).
 *  2. The CODED_AUTO drop block sends targetColumn: 'CODED_AUTO' (not a
 *     pre-resolved target).
 *  3. KanbanProvider's triggerBatchAction and triggerAction arms delegate
 *     CODED_AUTO to _advanceCards.
 *  4. _advanceCards exists.
 *  5. Occurrence ratchet: every direct trigger-call site in KanbanProvider.ts
 *     is attributed to its owning member (a `private …name(` method or a
 *     `case 'name':` arm). Sites inside `_advanceCards` are the operation
 *     itself; a named allowlist covers call sites whose dispatch shape the
 *     operation does not model. The total outside both must stay at or below
 *     DIRECT_TRIGGER_CEILING — a number that only ever ratchets DOWN, one step
 *     per arm converted.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..');
const kanbanHtml = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/kanban.html'), 'utf8');
const kanbanProviderCode = fs.readFileSync(path.join(REPO_ROOT, 'src/services/KanbanProvider.ts'), 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

// 1. resolveCodedAutoTarget is deleted from kanban.html.
test('resolveCodedAutoTarget is absent from kanban.html', () => {
    assert.ok(
        !/function\s+resolveCodedAutoTarget\s*\(/.test(kanbanHtml),
        'resolveCodedAutoTarget must be deleted from kanban.html — the server resolves complexity routing via _advanceCards'
    );
});

// 2. The CODED_AUTO drop block sends targetColumn: 'CODED_AUTO'.
test('CODED_AUTO drop sends targetColumn CODED_AUTO as intent', () => {
    // The drop block must send 'CODED_AUTO' as the targetColumn, not a
    // pre-resolved column ID. Look for the pattern in the triggerAction /
    // triggerBatchAction messages within the CODED_AUTO drop block.
    const codedAutoBlock = kanbanHtml.substring(
        kanbanHtml.indexOf("if (targetColumn === 'CODED_AUTO')"),
        kanbanHtml.indexOf("const forwardIds = []")
    );
    assert.ok(codedAutoBlock.includes("targetColumn: 'CODED_AUTO'"),
        'CODED_AUTO drop block must send targetColumn: \'CODED_AUTO\' as intent'
    );
});

// 3. KanbanProvider delegates CODED_AUTO to _advanceCards.
test('KanbanProvider triggerBatchAction delegates CODED_AUTO to _advanceCards', () => {
    const armStart = kanbanProviderCode.indexOf("case 'triggerBatchAction':");
    assert.ok(armStart !== -1, "case 'triggerBatchAction': not found");
    const armEnd = kanbanProviderCode.indexOf("case 'moveCardBackwards':", armStart);
    const armCode = kanbanProviderCode.substring(armStart, armEnd);
    assert.ok(
        armCode.includes("_advanceCards") && armCode.includes("CODED_AUTO"),
        'triggerBatchAction must delegate CODED_AUTO to _advanceCards'
    );
});

test('KanbanProvider triggerAction delegates CODED_AUTO to _advanceCards', () => {
    const armStart = kanbanProviderCode.indexOf("case 'triggerAction':");
    assert.ok(armStart !== -1, "case 'triggerAction': not found");
    // Find the next case after triggerAction
    const nextCase = kanbanProviderCode.indexOf("\n            case '", armStart + 100);
    const armCode = kanbanProviderCode.substring(armStart, nextCase);
    assert.ok(
        armCode.includes("_advanceCards") && armCode.includes("CODED_AUTO"),
        'triggerAction must delegate CODED_AUTO to _advanceCards'
    );
});

// 4. _advanceCards method exists.
test('_advanceCards method exists on KanbanProvider', () => {
    assert.ok(
        /private\s+async\s+_advanceCards\s*\(/.test(kanbanProviderCode),
        '_advanceCards method must exist on KanbanProvider — the unified advance operation'
    );
});

// 5. Occurrence ratchet over direct trigger-call sites.
//
// Owner attribution: a site belongs to the nearest preceding member boundary —
// either a class method declaration at 4-space indent (`method:<name>`) or a
// `case '<verb>':` label (`case:<verb>`). A site that lands outside every
// boundary attributes to `unknown` and counts against the ceiling, so a call
// hidden in an unrecognised construct still fails rather than passing.
test('direct trigger*AgentFromKanban calls are confined to _advanceCards + the named allowlist', () => {
    const TRIGGER_CALL_RE = /executeCommand(?:<[^>]*>)?\(\s*'switchboard\.trigger(?:Batch)?AgentFromKanban'/g;

    // Named exemptions — each entry is a site whose dispatch shape the advance
    // operation deliberately does NOT model. The expected count is exact: a
    // site added OR removed inside an allowlisted owner fails, so the list
    // cannot quietly rot.
    const ALLOWED_SITES = new Map([
        // The operation itself: the four calls every other affordance delegates to.
        ['method:_advanceCards', 4],
        // Private helper with no browser surface — comment/integration-driven
        // re-dispatch of a card already in a role column; there is no move half
        // to delegate.
        ['method:_remoteDispatchColumnAgent', 1],
        // Planner fan-out: owns the per-terminal bucket partition, the
        // persistent rotation cursor, and the 'improve-plan' instruction.
        // Shares _advanceCards' move half (dispatch:false); keeps its own
        // dispatch shape.
        ['method:_distributePlannerDispatch', 2],
        // Fixed 'jules' role dispatch — no column move.
        ['case:julesLowComplexity', 1],
        ['case:julesSelected', 1],
        // Dispatches the column as-is for dispatch-analysis — no move.
        ['case:dispatchAnalyze', 1],
        // Single-card dispatch carries terminal-override, unattended,
        // origin-terminal and clear/skip-clear args plus planner-rotation,
        // pair-programming, drive-mode-watch and prompt-fallback follow-ups the
        // operation does not model. The arm delegates its MOVE half to
        // _advanceCards(dispatch:false); the dispatch call itself stays.
        ['case:triggerAction', 1],
        // The no-workspaceRoot fallback dispatches raw ids when there is
        // nothing to persist against — a degenerate path the operation cannot
        // own (it needs a root for the db). The rooted path delegates fully.
        ['case:triggerBatchAction', 1],
    ]);

    // Only ever ratchets DOWN — lower it in the same commit that removes the
    // sites. History: 9 at extraction start (triggerAction 1, triggerBatchAction
    // 1, moveSelected 4, moveAll 3; the sendDispatch* arms were already deleted);
    // triggerAction + triggerBatchAction moved to the named allowlist above
    // when their move halves converted; moveSelected and moveAll then delegated
    // both branches, leaving zero unlisted direct calls.
    const DIRECT_TRIGGER_CEILING = 0;

    const boundaries = [];
    for (const m of kanbanProviderCode.matchAll(
        /^    (?:private|public|protected)\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\w+)\s*\(/gm
    )) {
        boundaries.push({ index: m.index, owner: `method:${m[1]}` });
    }
    for (const m of kanbanProviderCode.matchAll(/case '([A-Za-z0-9_]+)':/g)) {
        boundaries.push({ index: m.index, owner: `case:${m[1]}` });
    }
    boundaries.sort((a, b) => a.index - b.index);

    const byOwner = new Map();
    for (const m of kanbanProviderCode.matchAll(TRIGGER_CALL_RE)) {
        let owner = 'unknown';
        for (const b of boundaries) {
            if (b.index < m.index) { owner = b.owner; } else { break; }
        }
        byOwner.set(owner, (byOwner.get(owner) || 0) + 1);
    }

    const listing = [...byOwner.entries()].map(([o, n]) => `${o}×${n}`).join(', ');

    // Allowlisted owners must match their declared count exactly.
    for (const [owner, expected] of ALLOWED_SITES) {
        const actual = byOwner.get(owner) || 0;
        assert.strictEqual(actual, expected,
            `allowlisted owner ${owner} must hold exactly ${expected} direct trigger call(s), found ${actual} (all sites: ${listing})`);
    }

    // Everything else is the ratchet: direct calls outside the operation and
    // the allowlist must be ≤ the ceiling. A new arm that open-codes a
    // trigger call instead of routing through _advanceCards trips this.
    let unlisted = 0;
    const unlistedOwners = [];
    for (const [owner, count] of byOwner) {
        if (!ALLOWED_SITES.has(owner)) {
            unlisted += count;
            unlistedOwners.push(`${owner}×${count}`);
        }
    }
    assert.ok(
        unlisted <= DIRECT_TRIGGER_CEILING,
        `${unlisted} direct trigger call(s) outside _advanceCards + allowlist (ceiling ${DIRECT_TRIGGER_CEILING}): ${unlistedOwners.join(', ')}. ` +
        `Route the arm through _advanceCards, or lower the ceiling as sites are converted.`
    );
});

// Summary
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
    process.exit(1);
}
