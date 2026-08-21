'use strict';

/**
 * Contract tests for "The TEAMS tab adopts teams; it does not start them".
 *
 * The board's TEAMS tab is a tab of the KANBAN webview — it has no terminal
 * grid, no pane assignments and no layout. A team started from there spawns a
 * head and its members into a panel that cannot render them: the flow-panel
 * button read STARTING…, `startAgentGroupResult` came back `success: true`,
 * the button reset, and nothing appeared anywhere the operator was looking.
 * With the terminals panel closed, the team spawned entirely off-screen.
 *
 * Seating is done by the CALLER of the start, from the pty verb response
 * (`switchToTeamGroup(data.teamGroupId, headName)` in terminals.js). The TEAMS
 * tab is not that caller and cannot be — it is a different webview and receives
 * its result over postMessage. So the start action is removed from the tab and
 * the terminals panel's START TEAM button is the single entry point.
 *
 * What must NOT be removed, and is pinned here:
 *  - adoption (`teamsTabAdopt` + the `saveAgentGroup` post) — the flow panel is
 *    the only adoption entry point for a shipped type besides `+ Build your own`;
 *  - the `#teams-flow-error` span and the failed-adopt rollback that writes into it;
 *  - the host's `startAgentGroup` verb arm, which stays registered as an HTTP
 *    surface for external orchestration. This change removes a UI CONTROL, not a
 *    capability — and deleting the arm would force a regeneration of two
 *    committed generated artefacts (verbAllowlist.ts, protocol-catalog.json).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '../..');
const kanbanHtml = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/kanban.html'), 'utf8');
const kanbanProviderTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/KanbanProvider.ts'), 'utf8');

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

console.log('\n--- TEAMS tab: adopt-only ---');

test('the TEAMS tab posts no startAgentGroup message', () => {
    assert.ok(
        !/type:\s*'startAgentGroup'/.test(kanbanHtml),
        'kanban.html must not post startAgentGroup — the panel has no grid to seat the team in'
    );
});

test('the start button, its busy state and its result arm are gone', () => {
    for (const marker of [
        'teams-flow-start-btn',
        'teamsTabStartTeam',
        'teamsTabStartingId',
        'teamsTabPendingStartId',
        "case 'startAgentGroupResult'",
    ]) {
        assert.ok(
            !kanbanHtml.includes(marker),
            `kanban.html must not contain '${marker}' — the start path is removed from this panel`
        );
    }
});

test('adoption survives the start deletion', () => {
    // Deleting teamsTabAdoptAndStart wholesale would delete adoption too: the
    // card-body USE button was already removed when adoption moved onto the flow
    // panel, so this is the only adoption entry point for a shipped type besides
    // `+ Build your own`.
    assert.ok(
        kanbanHtml.includes('function teamsTabAdopt('),
        'kanban.html must keep teamsTabAdopt — the fork-and-persist half of the old handler'
    );
    assert.ok(
        /teamsTabAdopt\(entry\.group\)/.test(kanbanHtml),
        'the flow panel USE button must call teamsTabAdopt with the picked type'
    );
    assert.ok(
        /postKanbanMessage\(\{ type: 'saveAgentGroup', group: forked \}\)/.test(kanbanHtml),
        'teamsTabAdopt must still post saveAgentGroup — adoption is persistence, not local state'
    );
});

test('the flow panel offers USE and a static terminals-panel hint, and no START', () => {
    const start = kanbanHtml.indexOf("actionDiv.className = 'teams-flow-action'");
    assert.ok(start !== -1, 'teams-flow-action block not found');
    const end = kanbanHtml.indexOf('panel.appendChild(actionDiv);', start);
    assert.ok(end !== -1, 'end of the action block not found');
    const action = kanbanHtml.substring(start, end);
    assert.ok(
        /btn\.textContent = 'USE';/.test(action),
        "the flow panel's only button must read USE"
    );
    assert.ok(
        !/START/.test(action),
        'no START / USE & START / STARTING… label may survive in the action block'
    );
    assert.ok(
        /if \(!entry\.adopted\)/.test(action),
        'the USE button must be gated on the type being un-adopted — an adopted team gets no action button'
    );
    assert.ok(
        /Start it from the terminals panel\./.test(action),
        'the action block must carry the one-line static hint naming the terminals panel'
    );
});

test('the adopt rollback and its error span survive', () => {
    const start = kanbanHtml.indexOf("case 'saveAgentGroupResult':");
    assert.ok(start !== -1, 'saveAgentGroupResult arm not found');
    const end = kanbanHtml.indexOf("case 'deleteAgentGroupResult':", start);
    assert.ok(end !== -1, 'end of the saveAgentGroupResult arm not found');
    const arm = kanbanHtml.substring(start, end);
    assert.ok(
        /teamsTabPendingAdoptId/.test(arm),
        'the rollback must key on teamsTabPendingAdoptId'
    );
    assert.ok(
        /agentsTabAgentGroups\.splice\(idx, 1\)/.test(arm),
        'a failed save must roll the optimistic push back — an adopted card for a team the host never saw is worse than none'
    );
    assert.ok(
        /getElementById\('teams-flow-error'\)/.test(arm),
        'the failure must surface in #teams-flow-error'
    );
    assert.ok(
        kanbanHtml.includes("errorSpan.id = 'teams-flow-error'"),
        'the #teams-flow-error span must still be rendered by the flow panel'
    );
});

test('the host startAgentGroup verb arm stays registered', () => {
    // This plan removes a UI control, not a capability. The arm is an allowlisted
    // kanban verb and appears in the generated protocol catalog; deleting it would
    // move two committed generated artefacts and drop an HTTP surface external
    // orchestration can legitimately use.
    assert.ok(
        /case 'startAgentGroup'|'startAgentGroup'/.test(kanbanProviderTs),
        'KanbanProvider must keep the startAgentGroup verb arm — headless orchestration still starts teams'
    );
});

// ------------------------------------------- UAT: the pacing toggle is gone

test('the SEATS PACE THE QUEUE toggle is absent from the TEAMS tab', () => {
    // Routing is automatic — features to the team lead, standalone plans to
    // members by complexity. The per-team checkbox was a manual control over a
    // decision the system makes, and it is removed. The backend `pacing` field
    // is untouched: teams that already carry pacing:'seat' keep seat-paced
    // dispatch, they just cannot be flipped from this tab.
    for (const marker of ['SEATS PACE THE QUEUE', 'pacingCb', 'pacingNote', 'pacingDiv', 'pacingLabel']) {
        assert.ok(
            !kanbanHtml.includes(marker),
            `the pacing toggle must not survive in kanban.html — found "${marker}"`
        );
    }
});

test('the misleading head-advances-the-queue note is gone', () => {
    // The note claimed "Head paces the queue: cards go to the head, which
    // delegates and advances on review pass." The head cannot advance a card to
    // CODE REVIEWED without a reviewer seat — teamWiring.ts's head prompt says
    // so explicitly. The note contradicted the enforcement, so it is deleted
    // rather than reworded.
    assert.ok(
        !/paces the queue|advances on review pass/.test(kanbanHtml),
        'the pacing note must not survive — it contradicted the reviewer-seat enforcement in teamWiring.ts'
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
