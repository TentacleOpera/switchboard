'use strict';

/**
 * Contract tests for "Custom agents are standalone; teams are composed explicitly".
 *
 * The bug: adding or launching an agent while a team was selected appended that
 * agent to the active team's roster, silently corrupting a saved team.
 *
 * The two stores are deliberately different shapes and must never be written
 * together:
 *  - custom agents are MACHINE-GLOBAL, in ~/.switchboard/integration-config.json
 *    via GlobalIntegrationConfigService.setAgentConfig('customAgents', ...);
 *  - teams are PER-WORKSPACE, in kanban.db under `terminals.agentGroups`
 *    (TERMINALS_GROUPS_KEY).
 *
 * Conflating them breaks multi-repo isolation: a machine-global agent edit would
 * reach into one workspace's team rosters.
 *
 * What is pinned here:
 *  1. handleSaveCustomAgent writes ONLY the global agent store — it never touches
 *     the team key. This is the roster-isolation invariant the whole plan rests on.
 *  2. The TEAMS tab role roster is filtered by ROLE_KEYS, not the bare
 *     BUILT_IN_AGENT_LABELS list. The labels list carries `jules`, which is
 *     visibility-only — no startup-command input in the AGENTS tab, absent from
 *     DEFAULT_ROLE_CONFIG, absent from KanbanProvider's BUILTIN_ROLES. Offering it
 *     as a head or member role authors a team seat that cannot boot a CLI. The
 *     pre-change static <select> markup correctly excluded it; the switch to a
 *     JS-built roster is exactly where it can leak back in.
 *  3. Custom agent roles ARE offered, so a team can be composed from them
 *     explicitly — that is the sanctioned assignment path.
 *  4. A stored role that is no longer in the roster is re-injected as its own
 *     option. Without it a <select> snaps to its first option and the next SAVE
 *     rewrites the operator's team — the same silent-corruption class the plan
 *     exists to kill.
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '../..');
const kanbanHtml = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/kanban.html'), 'utf8');
const taskViewerTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/TaskViewerProvider.ts'), 'utf8');
const agentGroupInstantiationTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/agentGroupInstantiation.ts'), 'utf8');
const ptyFleetServiceTs = fs.readFileSync(path.join(REPO_ROOT, 'src/standalone/ptyFleetService.ts'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(REPO_ROOT, 'src/standalone/bootstrap.ts'), 'utf8');
const terminalsJs = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/terminals.js'), 'utf8');
const sharedDefaults = require(path.join(REPO_ROOT, 'src/webview/sharedDefaults.js'));

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

/** Slice a function body out of a source string by brace matching from its header. */
function functionBody(source, header) {
    const start = source.indexOf(header);
    assert.ok(start >= 0, `could not find "${header}" — the test needs updating, not the guard removing`);
    const open = source.indexOf('{', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') { depth++; }
        else if (source[i] === '}') {
            depth--;
            if (depth === 0) { return source.slice(start, i + 1); }
        }
    }
    throw new Error(`unbalanced braces walking "${header}"`);
}

console.log('\n--- Custom agent saves never touch a team roster ---');

test('handleSaveCustomAgent writes the global agent store', () => {
    const body = functionBody(taskViewerTs, 'public async handleSaveCustomAgent(');
    assert.ok(
        /GlobalIntegrationConfigService\.setAgentConfig\(\s*'customAgents'/.test(body),
        'handleSaveCustomAgent must persist to the machine-global customAgents key'
    );
});

test('handleSaveCustomAgent never writes terminals.agentGroups', () => {
    const body = functionBody(taskViewerTs, 'public async handleSaveCustomAgent(');
    // Both the constant and the literal key: a save path may reach the team store
    // through either, and both are equally fatal to a saved roster.
    assert.ok(
        !/TERMINALS_GROUPS_KEY/.test(body),
        'handleSaveCustomAgent must not reference TERMINALS_GROUPS_KEY — agent saves are workspace-team-neutral'
    );
    assert.ok(
        !/terminals\.agentGroups|agentGroups/.test(body),
        'handleSaveCustomAgent must not touch agentGroups — this is the auto-append bug the plan removes'
    );
    assert.ok(
        !/mutateTerminalGroups|wireSpawnedTeam|saveTerminalGroupsGuarded/.test(body),
        'handleSaveCustomAgent must not call a team-writing helper'
    );
});

test('handleDeleteCustomAgent never writes terminals.agentGroups either', () => {
    // Symmetry matters: a delete that pruned team rosters would mutate a saved
    // team just as destructively as an append. Teams keep the dangling role and
    // surface it as "(not configured)" in the editor instead.
    const body = functionBody(taskViewerTs, 'public async handleDeleteCustomAgent(');
    assert.ok(
        !/TERMINALS_GROUPS_KEY|mutateTerminalGroups|wireSpawnedTeam/.test(body),
        'handleDeleteCustomAgent must not reach into workspace team rosters'
    );
});

console.log('\n--- The TEAMS tab role roster is the spawnable set ---');

test('jules is in BUILT_IN_AGENT_LABELS but not in ROLE_KEYS', () => {
    // The premise of the filter. If this ever stops holding, the filter below is
    // either unnecessary or guarding the wrong thing — either way, look here first.
    assert.ok(
        sharedDefaults.BUILT_IN_AGENT_LABELS.some(r => r.key === 'jules'),
        'BUILT_IN_AGENT_LABELS is expected to carry jules (visibility-only cloud coder)'
    );
    assert.ok(
        !sharedDefaults.ROLE_KEYS.includes('jules'),
        'ROLE_KEYS is expected to exclude jules — it has no role config and no startup command'
    );
});

test('teamsTabRoleOptions filters the label list by ROLE_KEYS', () => {
    const body = functionBody(kanbanHtml, 'function teamsTabRoleOptions(');
    assert.ok(
        /new Set\(ROLE_KEYS\)/.test(body),
        'teamsTabRoleOptions must derive its built-in roster from ROLE_KEYS'
    );
    assert.ok(
        /BUILT_IN_AGENT_LABELS/.test(body),
        'teamsTabRoleOptions must take its labels from BUILT_IN_AGENT_LABELS, not a fifth hand-written copy'
    );
    // The filter has to actually gate the add() — a Set built and never consulted
    // is the exact shape of a guard that reads green while doing nothing.
    assert.ok(
        /if\s*\(!spawnable\.has\(r\.key\)\)\s*\{\s*continue;\s*\}/.test(body),
        'the ROLE_KEYS set must skip non-spawnable labels before add() — an unused Set is not a filter'
    );
});

test('the head-role select carries no static options to drift from the roster', () => {
    // The markup is an empty <select>; teamsTabRoleOptions is the single writer.
    // A re-added static <option> would survive as a stale duplicate on first paint.
    assert.ok(
        /<select id="agent-groups-head-role" class="modal-input"><\/select>/.test(kanbanHtml),
        'the head-role select must stay empty in markup — JS owns the roster'
    );
});

console.log('\n--- Explicit assignment, and no silent roster rewrites ---');

test('custom agent roles are offered as team roles', () => {
    const body = functionBody(kanbanHtml, 'function teamsTabRoleOptions(');
    assert.ok(
        /optgroup/.test(body) && /Custom Agents/.test(body),
        'teamsTabRoleOptions must offer registered custom agents — the TEAMS tab is the sanctioned assignment path'
    );
});

test('an unknown stored role is preserved as its own option', () => {
    const body = functionBody(kanbanHtml, 'function teamsTabRoleOptions(');
    assert.ok(
        /if\s*\(!known\.has\(want\)\)/.test(body),
        'a stored role missing from the roster must be re-injected, or SAVE silently rewrites the team'
    );
});

test('member rows are read by data-field, not by element index', () => {
    const body = functionBody(kanbanHtml, 'function teamsTabSaveAgentGroup(');
    assert.ok(
        /\[data-field="role"\]/.test(body) && /\[data-field="count"\]/.test(body)
            && /\[data-field="scope"\]/.test(body) && /\[data-field="relationship"\]/.test(body),
        'teamsTabSaveAgentGroup must address member controls by data-field — the role control is a <select> now, '
        + 'so an index-based read shifts both collections and drops every member'
    );
});

console.log('\n--- Team start reports commandless seats ---');

test('instantiateAgentGroupCore pre-flights startup commands and returns commandlessRoles', () => {
    const body = functionBody(agentGroupInstantiationTs, 'export async function instantiateAgentGroupCore(');
    assert.ok(
        /GlobalIntegrationConfigService\.getAgentStartupCommands\(\)/.test(body),
        'instantiateAgentGroupCore must read GlobalIntegrationConfigService.getAgentStartupCommands()'
    );
    assert.ok(
        /commandlessRoles\s*=/.test(body),
        'instantiateAgentGroupCore must compute commandlessRoles'
    );
    assert.ok(
        /commandlessRoles\??:\s*string\[\]/.test(agentGroupInstantiationTs),
        'InstantiateAgentGroupResult must declare commandlessRoles?: string[]'
    );
});

test('instantiateAgentGroupCore pre-flight skips members with own command or shared scope', () => {
    const body = functionBody(agentGroupInstantiationTs, 'export async function instantiateAgentGroupCore(');
    assert.ok(
        /m\?\.startupCommand\s*\|\|\s*m\?\.scope\s*===\s*'shared'/.test(body),
        'the pre-flight must skip members carrying their own startupCommand and members with scope: "shared"'
    );
});

test('commandlessRoles appears on both success returns of instantiateAgentGroupCore', () => {
    const body = functionBody(agentGroupInstantiationTs, 'export async function instantiateAgentGroupCore(');
    const occurrences = (body.match(/commandlessRoles/g) || []).length;
    assert.ok(
        occurrences >= 4,
        'commandlessRoles must be populated and threaded onto both success returns (normal + wired.ok === false)'
    );
    assert.ok(
        /if\s*\(!wired\.ok\)\s*\{[\s\S]*?commandlessRoles[\s\S]*?\}/.test(body),
        'commandlessRoles must be attached to the !wired.ok return'
    );
});

test('startTeam toast logic composes commandlessNote into every branch', () => {
    const body = functionBody(terminalsJs, 'async function startTeam(');
    assert.ok(
        /commandlessNote\s*=/.test(body),
        'startTeam must construct commandlessNote'
    );
    assert.ok(
        /data\.delegateError[\s\S]*?commandlessNote/.test(body),
        'startTeam must compose commandlessNote into the delegateError toast branch'
    );
    assert.ok(
        /data\.error[\s\S]*?commandlessNote/.test(body),
        'startTeam must compose commandlessNote into the error toast branch'
    );
    assert.ok(
        /seatNote\s*\|\|\s*commandlessNote/.test(body),
        'startTeam must show toast when seatNote or commandlessNote is non-empty'
    );
});

test('instantiateAgentGroupCore pre-flight writes nothing to team stores', () => {
    const body = functionBody(agentGroupInstantiationTs, 'export async function instantiateAgentGroupCore(');
    assert.ok(
        !/mutateTerminalGroups|saveTerminalGroupsGuarded|TERMINALS_GROUPS_KEY/.test(body),
        'instantiateAgentGroupCore must not reference team-writing helpers'
    );
});

console.log('\n--- Standalone role-bearing liveness ---');

test('FleetLivenessEntry interface declares role?: string', () => {
    assert.ok(
        /interface\s+FleetLivenessEntry\s*\{[\s\S]*?role\??:\s*string;[\s\S]*?\}/.test(ptyFleetServiceTs),
        'FleetLivenessEntry must declare role?: string'
    );
});

test('PtyFleetService.getLiveness populates role on live entries', () => {
    const body = functionBody(ptyFleetServiceTs, 'public getLiveness(): FleetLivenessEntry[]');
    assert.ok(
        /role:\s*t\.role/.test(body),
        'PtyFleetService.getLiveness must populate role: t.role on live entries'
    );
});

test('standalone bootstrap wires taskViewerProvider.setFleetLivenessProvider', () => {
    assert.ok(
        /taskViewerProvider\.setFleetLivenessProvider\(\(\)\s*=>\s*ptyFleetService\.getLiveness\(\)\)/.test(bootstrapTs),
        'standalone bootstrap must wire taskViewerProvider.setFleetLivenessProvider'
    );
});

test('_isTerminalLive consults getFleetLiveness for PTY liveness', () => {
    const body = functionBody(taskViewerTs, 'private _isTerminalLive(terminalName: string, ptyOnly: boolean = false): boolean');
    assert.ok(
        /getFleetLiveness\(\)/.test(body),
        '_isTerminalLive must consult getFleetLiveness() for PTY liveness'
    );
});

test('_isLikelyPtyDispatchTarget consults getFleetLiveness', () => {
    const body = functionBody(taskViewerTs, 'private _isLikelyPtyDispatchTarget(agentName: string): boolean');
    assert.ok(
        /getFleetLiveness\(\)/.test(body),
        '_isLikelyPtyDispatchTarget must consult getFleetLiveness()'
    );
});

// The standalone route used to be a self-contained `_headlessRuntime.ptyVerb`
// branch with its OWN copy of the name/liveness population. It is now the
// injected `_fleetVerb` seam, which falls through to the single shared
// population block below the route — so pin the population as reachable FROM
// that route, which is what the cache actually depends on.
test('TaskViewerProvider fleet-verb seam populates _ptyTerminalNames and _ptyLiveness on ptyListTerminals', () => {
    const body = functionBody(taskViewerTs, 'private async _ptyHostVerb(verb: string, payload: any, signal?: AbortSignal): Promise<any>');
    assert.ok(
        /this\._fleetVerb\(verb, payload, signal\)[\s\S]*?this\._ptyTerminalNames\s*=\s*result\.terminals/.test(body),
        '_ptyHostVerb must populate _ptyTerminalNames on the _fleetVerb route when ptyListTerminals succeeds'
    );
    assert.ok(
        /this\._fleetVerb\(verb, payload, signal\)[\s\S]*?this\._ptyLiveness\s*=/.test(body),
        '_ptyHostVerb must populate _ptyLiveness on the _fleetVerb route when ptyListTerminals succeeds'
    );
});

// `functionBody` brace-walks from the FIRST `{` after the header, and this
// method's return type is an inline object literal
// (`Promise<{ role: string; name: string } | undefined>`) — so it would extract
// the return type and assert against nothing. Slice to the next member instead.
function createAutobanTerminalBody() {
    const header = 'private async _createAutobanTerminal(';
    const start = taskViewerTs.indexOf(header);
    assert.ok(start >= 0, 'could not find _createAutobanTerminal — the test needs updating, not the guard removing');
    const end = taskViewerTs.indexOf('\n    private ', start + header.length);
    assert.ok(end > start, 'could not find the end of _createAutobanTerminal');
    const body = taskViewerTs.slice(start, end);
    assert.ok(/ptyCreateTerminal/.test(body), 'the extracted body must contain the PTY create call');
    return body;
}

console.log('\n--- PTY seats keep their worktree identity ---');

test('_createAutobanTerminal passes worktreePath to ptyCreateTerminal, not just cwd', () => {
    const body = createAutobanTerminalBody();
    assert.ok(
        /ptyCreateTerminal[\s\S]*?worktreePath:\s*cwd/.test(body),
        'the ptyCreateTerminal payload must carry worktreePath — cwd alone leaves the registry row '
        + 'without one, and _findTerminalNameByWorktreePathAndRole (the create-if-missing guard in '
        + 'ensureWorktreeTerminals, the per-worktree role cap, and worktree affinity) matches on that field'
    );
});

test('the per-role terminal cap can see the PTY rows this path creates', () => {
    const body = createAutobanTerminalBody();
    assert.ok(
        /_getAliveAutobanTerminalNames\([\s\S]{0,160}?allowPtyFleet:\s*true/.test(body),
        'MAX_TERMINALS_PER_ROLE must be counted with allowPtyFleet: true — the default registry read '
        + 'drops every PTY row, so the cap would count zero forever'
    );
});

test('_selectAutobanTerminal filters on the fleet flag, not on an unwritten `hidden` field', () => {
    const body = functionBody(taskViewerTs, 'private async _selectAutobanTerminal(');
    assert.ok(
        /_isFleetTerminalInfo\(info\)/.test(body),
        'team seat selection must be PTY-only'
    );
    assert.ok(
        !/info\?\.hidden/.test(body),
        'nothing in the codebase writes a `hidden` flag onto a terminal registry row — a filter on it '
        + 'is inert while reading as if operator intent were honoured'
    );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
