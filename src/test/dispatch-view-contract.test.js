const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Source-text contract for the STAGING column: the staged-plan count on the
// Staging column header, the removal of the manual per-card entry button, and
// the fan-out controls.
//
// Why source-text and not a DOM test: the whole correctness condition of the count is
// WHERE it is called from. The Planned column header is rendered by renderColumns(),
// which is NOT on the board-refresh path — a count that lives only in that template is
// correct at first paint and stale from the moment Analyze stages anything. That is a
// call-site property, invisible to a test that renders once and asserts a number.
//
// History: this contract was originally written for the DISPATCH display-mode toggle
// (a view overlaid on PLAN REVIEWED). The STAGING migration replaced the toggle with a
// real column (id STAGING, kind 'staging', order 115). The function names changed
// (dispatchStagedCount → stagingCount, updateDispatchToggleCount/updateDispatchViewInfo
// → updateStagingViewInfo), and the three display-mode verbs — toggleDispatchView,
// sendDispatchToCoder, sendDispatchSetToCoders — were removed outright: STAGING is a
// real column, so its cards advance through the ordinary moveSelected/moveAll path with
// the same complexity routing PLAN REVIEWED uses. Their absence is pinned below in BOTH
// directions (webview post AND generated allowlist), because a half-done removal is the
// documented failure mode here and a verb left in the allowlist fails `catalog:check`.

/** Slice a function body out of the source by brace matching from its declaration. */
function functionBody(source, declaration) {
    const start = source.indexOf(declaration);
    assert.notStrictEqual(start, -1, `expected to find "${declaration}" in kanban.html`);
    const open = source.indexOf('{', start);
    assert.notStrictEqual(open, -1, `expected an opening brace after "${declaration}"`);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        const ch = source[i];
        if (ch === '{') depth++;
        else if (ch === '}') {
            depth--;
            if (depth === 0) return source.slice(open, i + 1);
        }
    }
    throw new Error(`unbalanced braces while slicing "${declaration}"`);
}

function testDispatchViewContract() {
    const kanbanHtmlPath = path.join(__dirname, '../webview/kanban.html');
    const kanbanHtml = fs.readFileSync(kanbanHtmlPath, 'utf8');
    const verbAllowlist = fs.readFileSync(path.join(__dirname, '../generated/verbAllowlist.ts'), 'utf8');
    const kanbanProvider = fs.readFileSync(path.join(__dirname, '../services/KanbanProvider.ts'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');

    // ── The staged count ────────────────────────────────────────────────────────

    // 1. The count honours BOTH display filters the Staging column itself applies.
    //    Dropping `!featureId` over-reports a staged feature by its subtask count —
    //    a number the user can never see in the column.
    const stagedCount = functionBody(kanbanHtml, 'function stagingCount(');
    assert.strictEqual(
        /c\.column === 'STAGING'/.test(stagedCount),
        true,
        "stagingCount must filter on column === 'STAGING'"
    );
    assert.strictEqual(
        /!\s*c\.featureId/.test(stagedCount),
        true,
        'stagingCount must exclude subtasks via !featureId (board roll-up contract)'
    );

    // 2. Derived from currentCards — which is ALREADY project-filtered at every
    //    assignment. Re-filtering is the double-filter regression; deriving from
    //    displayCards/computeColumnOccupancy reads AFTER the STAGING strip, where a
    //    STAGING count structurally cannot exist.
    assert.strictEqual(
        stagedCount.includes('currentCards'),
        true,
        'stagingCount must derive from currentCards'
    );
    assert.strictEqual(
        stagedCount.includes('applyBoardProjectFilter'),
        false,
        'stagingCount must NOT re-apply applyBoardProjectFilter (currentCards is already filtered)'
    );
    assert.strictEqual(
        /displayCards|computeColumnOccupancy/.test(stagedCount),
        false,
        'stagingCount must not derive from displayCards/computeColumnOccupancy (both strip STAGING)'
    );

    // 3. THE staleness guard. The header shell renders on a different cadence than the
    //    card bodies, so the patcher must be reachable from every path that can change
    //    the number. This is the assertion a template-only implementation fails.
    const countCallSites = [
        'function renderColumns(',
        'function renderBoard(',
        'function refreshColumnCounts(',
        'function moveCardsOptimistically(',
    ];
    for (const decl of countCallSites) {
        assert.strictEqual(
            functionBody(kanbanHtml, decl).includes('updateStagingViewInfo('),
            true,
            `${decl.replace('function ', '').replace('(', '')} must call updateStagingViewInfo() — the header is not rebuilt on a board refresh`
        );
    }

    // 4. The non-existent helper an early draft named. A ReferenceError here blanks the
    //    board on first paint.
    assert.strictEqual(
        kanbanHtml.includes('filterCardsByProject'),
        false,
        'filterCardsByProject does not exist — the board helper is applyBoardProjectFilter'
    );

    // ── Entry discipline: the manual per-card button is gone ────────────────────

    // 5. Half-done removal (webview post left behind, or the allowlist entry left
    //    behind) is the documented failure mode for this change.
    assert.strictEqual(
        /sendToDispatch|send-to-dispatch/.test(kanbanHtml),
        false,
        'the manual Move-to-Dispatch button, its listener, and its verb must all be gone'
    );
    assert.strictEqual(
        verbAllowlist.includes("'sendToDispatch'"),
        false,
        'sendToDispatch must not remain in KANBAN_VERBS'
    );
    // The card-level "→ Planned" exit button went with the display mode. STAGING is a
    // real column: the operator's override of a wrong analysis is a drag back out, the
    // same gesture every other column uses. The button, its listener and its verb must
    // all be gone together — a listener left behind posts a verb no handler answers.
    assert.strictEqual(
        /send-to-planned-btn/.test(kanbanHtml),
        false,
        'the → Planned card button and its listener must be gone — STAGING is exited by drag'
    );

    // ── The removed display-mode verbs ──────────────────────────────────────────

    // 6. The three DISPATCH-view verbs are gone from BOTH sides. The allowlist is
    //    generated from protocol-catalog.json, which is scanned out of the provider's
    //    switch arms — so a handler deleted without `npm run catalog:generate` leaves a
    //    verb in the allowlist and turns CI's first gate (`catalog:check`) red. Pinning
    //    the absence here catches that before the generated file does.
    for (const verb of ['toggleDispatchView', 'sendDispatchToCoder', 'sendDispatchSetToCoders']) {
        assert.strictEqual(
            verbAllowlist.includes(`'${verb}'`),
            false,
            `${verb} must not remain in KANBAN_VERBS — its handler was removed with the DISPATCH view (regenerate with \`npm run catalog:generate\`)`
        );
        assert.strictEqual(
            kanbanProvider.includes(`case '${verb}':`),
            false,
            `${verb} must not remain as a KanbanProvider switch arm`
        );
        assert.strictEqual(
            kanbanHtml.includes(`type: '${verb}'`),
            false,
            `${verb} must not remain as a webview post — the backend no longer answers it`
        );
    }

    // 7. The coder-terminal count is part of the board SNAPSHOT, not just the payload.
    //    Adding a terminal changes no card, so a cards-only hash skips the push and the
    //    stepper appears to do nothing — the exact regression this pins.
    // Matched on MEMBERSHIP, not on the exact field list: the invariant is that
    // a terminal-only change reaches the hash, and pinning the literal triple
    // made every legitimate addition to the snapshot a red gate (V60 added
    // `codingHeadLive` so a lead coming online flips the Run-queue button, which
    // is the same class of terminal-only change this assertion exists to catch).
    const snapshotHashPayload = (kanbanProvider.match(/\.update\(JSON\.stringify\(\{[^}]*\}\)\)/g) || [])
        .find(m => m.includes('cards') && m.includes('featureWorktrees'));
    assert.ok(snapshotHashPayload, 'the board snapshot hash must be built from a JSON.stringify of the snapshot fields');
    assert.strictEqual(
        snapshotHashPayload.includes('coderTerminalCount'),
        true,
        'the board snapshot hash must include coderTerminalCount, or a terminal-only change is skipped'
    );

    // 8. The webview repaints on a count-only change, where neither renderBoard nor
    //    refreshColumnCounts runs.
    const updateBoardIdx = kanbanHtml.indexOf("case 'updateBoard':");
    assert.notStrictEqual(updateBoardIdx, -1, "case 'updateBoard': must exist");
    const updateBoardBody = kanbanHtml.slice(updateBoardIdx, kanbanHtml.indexOf("case 'settingResult':", updateBoardIdx));
    assert.strictEqual(
        /coderTerminalCountChanged[\s\S]*updateStagingViewInfo\(\)/.test(updateBoardBody),
        true,
        'updateBoard must repaint the Staging header when only the terminal count changed'
    );

    // 9. Capability-gating honesty (PRD contract #6). Terminal CREATION rides a command
    //     only extension.ts registers, so pty readiness is the wrong signal for the
    //     stepper — standalone must disable it rather than fake success.
    assert.strictEqual(
        kanbanHtml.includes('terminalCreateAvailable'),
        true,
        'the + stepper must be gated on terminalCreateAvailable, not pty readiness alone'
    );
    assert.strictEqual(
        /terminalCreateAvailable:\s*false/.test(bootstrap),
        true,
        'standalone must report terminalCreateAvailable: false — the creation command is unbridged there'
    );

    console.log('testDispatchViewContract passed all assertions successfully.');
}

module.exports = { testDispatchViewContract };

if (require.main === module) {
    testDispatchViewContract();
}
