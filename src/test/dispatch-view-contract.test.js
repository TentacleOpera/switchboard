const fs = require('fs');
const path = require('path');
const assert = require('assert');

// Source-text contract for the Dispatch view: the staged-plan count on the DISPATCH
// toggle, the removal of the manual per-card entry button, and the fan-out controls.
//
// Why source-text and not a DOM test: the whole correctness condition of the count is
// WHERE it is called from. The Planned column header is rendered by renderColumns(),
// which is NOT on the board-refresh path — a count that lives only in that template is
// correct at first paint and stale from the moment Analyze stages anything. That is a
// call-site property, invisible to a test that renders once and asserts a number.

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
    const verbSchemas = fs.readFileSync(path.join(__dirname, '../services/verbSchemas.ts'), 'utf8');
    const kanbanProvider = fs.readFileSync(path.join(__dirname, '../services/KanbanProvider.ts'), 'utf8');
    const bootstrap = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');

    // ── The staged count ────────────────────────────────────────────────────────

    // 1. The count honours BOTH display filters the Dispatch view itself applies.
    //    Dropping `!featureId` over-reports a staged feature by its subtask count —
    //    a number the user can never see in the column.
    const stagedCount = functionBody(kanbanHtml, 'function dispatchStagedCount(');
    assert.strictEqual(
        /c\.column === 'DISPATCH'/.test(stagedCount),
        true,
        "dispatchStagedCount must filter on column === 'DISPATCH'"
    );
    assert.strictEqual(
        /!\s*c\.featureId/.test(stagedCount),
        true,
        'dispatchStagedCount must exclude subtasks via !featureId (board roll-up contract)'
    );

    // 2. Derived from currentCards — which is ALREADY project-filtered at every
    //    assignment. Re-filtering is the double-filter regression; deriving from
    //    displayCards/computeColumnOccupancy reads AFTER the DISPATCH strip, where a
    //    DISPATCH count structurally cannot exist.
    assert.strictEqual(
        stagedCount.includes('currentCards'),
        true,
        'dispatchStagedCount must derive from currentCards'
    );
    assert.strictEqual(
        stagedCount.includes('applyBoardProjectFilter'),
        false,
        'dispatchStagedCount must NOT re-apply applyBoardProjectFilter (currentCards is already filtered)'
    );
    assert.strictEqual(
        /displayCards|computeColumnOccupancy/.test(stagedCount),
        false,
        'dispatchStagedCount must not derive from displayCards/computeColumnOccupancy (both strip DISPATCH)'
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
            functionBody(kanbanHtml, decl).includes('updateDispatchToggleCount('),
            true,
            `${decl.replace('function ', '').replace('(', '')} must call updateDispatchToggleCount() — the header is not rebuilt on a board refresh`
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
    // The exit direction stays — it is the operator's override of a wrong analysis.
    assert.strictEqual(
        kanbanHtml.includes('send-to-planned-btn'),
        true,
        'the → Planned exit button must survive the removal'
    );

    // ── Fan-out ─────────────────────────────────────────────────────────────────

    // 6. The verb is allowlisted AND schema-validated. A schemaless verb passes the
    //    HTTP boundary unvalidated (PRD contract #5).
    assert.strictEqual(
        verbAllowlist.includes("'sendDispatchSetToCoders'"),
        true,
        'sendDispatchSetToCoders must be in KANBAN_VERBS'
    );
    assert.strictEqual(
        /sendDispatchSetToCoders:\s*\{/.test(verbSchemas),
        true,
        'sendDispatchSetToCoders must have a KANBAN_VERB_SCHEMAS entry (PRD contract #5)'
    );

    // 7. The arm re-reads the DISPATCH set itself rather than trusting a webview card
    //    list, so a card dragged out between render and press is skipped.
    const armIdx = kanbanProvider.indexOf("case 'sendDispatchSetToCoders': {");
    assert.notStrictEqual(armIdx, -1, "KanbanProvider must have a 'sendDispatchSetToCoders' arm");
    const armBody = kanbanProvider.slice(armIdx, kanbanProvider.indexOf("case 'importFromClipboard'", armIdx));
    assert.strictEqual(
        /_lastCards[\s\S]{0,200}column === 'DISPATCH'/.test(armBody),
        true,
        'sendDispatchSetToCoders must re-read the DISPATCH set inside the handler'
    );
    assert.strictEqual(
        armBody.includes('msg.sessionIds'),
        false,
        'sendDispatchSetToCoders must not trust a webview-supplied card list'
    );

    // 8. The coder-terminal count is part of the board SNAPSHOT, not just the payload.
    //    Adding a terminal changes no card, so a cards-only hash skips the push and the
    //    stepper appears to do nothing — the exact regression this pins.
    assert.strictEqual(
        /JSON\.stringify\(\{\s*cards,\s*featureWorktrees,\s*coderTerminalCount\s*\}\)/.test(kanbanProvider),
        true,
        'the board snapshot hash must include coderTerminalCount, or a terminal-only change is skipped'
    );

    // 9. The webview repaints on a count-only change, where neither renderBoard nor
    //    refreshColumnCounts runs.
    const updateBoardIdx = kanbanHtml.indexOf("case 'updateBoard':");
    assert.notStrictEqual(updateBoardIdx, -1, "case 'updateBoard': must exist");
    const updateBoardBody = kanbanHtml.slice(updateBoardIdx, kanbanHtml.indexOf("case 'settingResult':", updateBoardIdx));
    assert.strictEqual(
        /coderTerminalCountChanged[\s\S]*updateDispatchViewInfo\(\)/.test(updateBoardBody),
        true,
        'updateBoard must repaint the Dispatch header when only the terminal count changed'
    );

    // 10. Capability-gating honesty (PRD contract #6). Terminal CREATION rides a command
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
