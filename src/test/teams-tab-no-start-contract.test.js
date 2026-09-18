'use strict';

/**
 * Contract tests for "The TEAMS tab adopts teams; it does not start them".
 *
 * The TEAMS tab is a tab of the Agent Control panel (agent-control.html +
 * agent-control.js — it left the KANBAN webview in the extraction) — it has no
 * terminal grid, no pane assignments and no layout. A team started from there spawns a
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
 *  - persistence of a newly created team (the `saveAgentGroup` post) and the
 *    rollback that undoes the optimistic push when the host refuses it;
 *  - the `#teams-flow-error` span and the failed-save rollback that writes into it;
 *  - the host's `startAgentGroup` verb arm, which stays registered as an HTTP
 *    surface for external Mission Control. This change removes a UI CONTROL, not a
 *    capability — and deleting the arm would force a regeneration of two
 *    committed generated artefacts (verbAllowlist.ts, protocol-catalog.json).
 *
 * ADOPTION ITSELF IS GONE, and that is not a regression of this contract. The
 * shipped-type catalogue it forked from (`SHIPPED_TEAM_TYPES`) is deleted: the
 * list you chose from was a different list from the one pushed onto you, which is
 * why a board grew a lead-headed team the operator never created. The five
 * shipped defaults now arrive from the host like any other team, so there is
 * nothing to adopt — "ADD TEAM" creates an empty custom definition. The flow
 * panel therefore offers NO action button at all, only the terminals-panel hint.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '../..');
// The TEAMS tab script lives in agent-control.js since the extraction.
const agentControlJs = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/agent-control.js'), 'utf8');
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
        !/type:\s*'startAgentGroup'/.test(agentControlJs),
        'agent-control.js must not post startAgentGroup — the panel has no grid to seat the team in'
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
            !agentControlJs.includes(marker),
            `agent-control.js must not contain '${marker}' — the start path is removed from this panel`
        );
    }
});

test('there is no shipped-type catalogue to adopt from, and no adopt handler', () => {
    // One catalogue. `SHIPPED_TEAM_TYPES` and `teamsTabAdopt` are deleted
    // together: a gallery that forks a hand-written type into the workspace is
    // exactly how the chosen-from list and the pushed-onto list came apart.
    assert.ok(
        !/SHIPPED_TEAM_TYPES\s*=/.test(agentControlJs),
        'agent-control.js must not declare a second team catalogue'
    );
    assert.ok(
        !/function teamsTabAdopt\(/.test(agentControlJs),
        'teamsTabAdopt must be gone — there are no shipped types to fork'
    );
});

test('creating a team still persists through saveAgentGroup, with a rollback key', () => {
    assert.ok(
        /postKanbanMessage\(\{ type: 'saveAgentGroup', group \}\)/.test(agentControlJs),
        'the editor save must post saveAgentGroup — a team is persistence, not local state'
    );
    assert.ok(
        /teamsTabPendingAdoptId = id;/.test(agentControlJs),
        'a NEW team must set the rollback key, so a host refusal does not leave a card '
        + 'drawn for a team the host never saw'
    );
});

test('the flow panel offers a static terminals-panel hint and no button at all', () => {
    const start = agentControlJs.indexOf("actionDiv.className = 'teams-flow-action'");
    assert.ok(start !== -1, 'teams-flow-action block not found');
    const end = agentControlJs.indexOf('panel.appendChild(actionDiv);', start);
    assert.ok(end !== -1, 'end of the action block not found');
    const action = agentControlJs.substring(start, end);
    assert.ok(
        !/START/.test(action),
        'no START / USE & START / STARTING… label may survive in the action block'
    );
    assert.ok(
        !/textContent = 'USE'/.test(action),
        'no USE button may survive — every card in this gallery is already the workspace\'s own team'
    );
    assert.ok(
        /Start it from the terminals panel\./.test(action),
        'the action block must carry the one-line static hint naming the terminals panel'
    );
});

test('the save rollback and its error span survive', () => {
    const start = agentControlJs.indexOf("case 'saveAgentGroupResult':");
    assert.ok(start !== -1, 'saveAgentGroupResult arm not found');
    const end = agentControlJs.indexOf("case 'deleteAgentGroupResult':", start);
    assert.ok(end !== -1, 'end of the saveAgentGroupResult arm not found');
    const arm = agentControlJs.substring(start, end);
    assert.ok(
        /teamsTabPendingAdoptId/.test(arm),
        'the rollback must key on teamsTabPendingAdoptId'
    );
    assert.ok(
        /agentsTabAgentGroups\.splice\(idx, 1\)/.test(arm),
        'a failed save must roll the optimistic push back — a card for a team the host never saw is worse than none'
    );
    assert.ok(
        /getElementById\('teams-flow-error'\)/.test(arm),
        'the failure must surface in #teams-flow-error'
    );
    assert.ok(
        agentControlJs.includes("errorSpan.id = 'teams-flow-error'"),
        'the #teams-flow-error span must still be rendered by the flow panel'
    );
});

test('the host startAgentGroup verb arm stays registered', () => {
    // This plan removes a UI control, not a capability. The arm is an allowlisted
    // kanban verb and appears in the generated protocol catalog; deleting it would
    // move two committed generated artefacts and drop an HTTP surface external
    // Mission Control can legitimately use.
    assert.ok(
        /case 'startAgentGroup'|'startAgentGroup'/.test(kanbanProviderTs),
        'KanbanProvider must keep the startAgentGroup verb arm — headless Mission Control still starts teams'
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
            !agentControlJs.includes(marker),
            `the pacing toggle must not survive in agent-control.js — found "${marker}"`
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
        !/paces the queue|advances on review pass/.test(agentControlJs),
        'the pacing note must not survive — it contradicted the reviewer-seat enforcement in teamWiring.ts'
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
