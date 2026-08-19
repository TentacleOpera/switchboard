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

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
