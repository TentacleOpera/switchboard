'use strict';

/**
 * Contract: Team member seats resolve their CLI from the team's machine.
 *
 * Source-level assertions against agent-control.html + agent-control.js (the
 * Teams tab's home since it left kanban.html), per the plan
 * `agents-are-saved-per-machine-and-a-team-picks-one`:
 *  1. The member row builder creates an input with class `member-label` and
 *     does NOT create a `member-cmd` input (per-member startupCommand retired).
 *  2. `teamsTabSaveAgentGroup` no longer contains `existing.find(m => m.role === role)`.
 *  3. `teamsTabSaveAgentGroup` reads `.member-label` by `querySelector` and does
 *     NOT read `.member-cmd`.
 *  4. The `inputs.length >= 2 && selects.length >= 2` guard is NOT present (the
 *     save path now uses data-field selectors, not index-based guards).
 *  5. The team form has a machine selector (`#agent-groups-machine`).
 *  6. `teamsTabSaveAgentGroup` reads the machine selector and stamps `machine`
 *     on the saved group.
 *  7. The saved member object never carries `startupCommand`.
 *
 * Run with:
 *   node src/test/teams-tab-member-editor-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const WEBVIEW = path.join(__dirname, '..', '..', 'src', 'webview');
// The tab's markup lives in agent-control.html, its functions in agent-control.js.
const source = fs.readFileSync(path.join(WEBVIEW, 'agent-control.html'), 'utf8')
    + '\n' + fs.readFileSync(path.join(WEBVIEW, 'agent-control.js'), 'utf8');

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

function extractFunction(src, fnName) {
    const start = src.indexOf(`function ${fnName}`);
    if (start < 0) return '';
    // Find the matching closing brace by counting
    let depth = 0;
    let i = src.indexOf('{', start);
    if (i < 0) return '';
    const begin = i;
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
    return '';
}

function run() {
    console.log('\nteams-tab-member-editor-contract\n');

    const memberRowSrc = extractFunction(source, 'teamsTabAgentGroupMemberRow');
    const saveSrc = extractFunction(source, 'teamsTabSaveAgentGroup');

    assert.ok(memberRowSrc.length > 0, 'teamsTabAgentGroupMemberRow must exist');
    assert.ok(saveSrc.length > 0, 'teamsTabSaveAgentGroup must exist');

    // ── 1. member-label exists, member-cmd is retired ───────────────────

    check('member row creates .member-label input', () => {
        assert.ok(memberRowSrc.includes("className = 'member-label'"), 'must create .member-label input');
    });

    check('member row does NOT create .member-cmd input', () => {
        assert.ok(!memberRowSrc.includes("className = 'member-cmd'"), 'member-cmd is retired');
        assert.ok(!/cmdIn/.test(memberRowSrc), 'no cmdIn variable in member row');
    });

    check('member row inputs do NOT carry data-role', () => {
        assert.ok(!/labelIn\.dataset\.role/.test(memberRowSrc), 'labelIn must not get data-role');
        assert.ok(!/labelIn\.setAttribute\(['"]data-role/.test(memberRowSrc), 'labelIn must not setAttribute data-role');
    });

    // ── 2. save path no longer has the lossy shim ───────────────────────

    check('teamsTabSaveAgentGroup no longer contains existing.find(m => m.role === role)', () => {
        assert.ok(!/existing\.find\(m\s*=>\s*m\.role\s*===\s*role/.test(saveSrc),
            'the lossy role-lookup shim must be deleted');
    });

    // ── 3. save path reads label by class, does NOT read cmd ────────────

    check('teamsTabSaveAgentGroup reads .member-label by querySelector and NOT .member-cmd', () => {
        assert.ok(saveSrc.includes("querySelector('.member-label')"), 'must read .member-label by class');
        assert.ok(!saveSrc.includes("querySelector('.member-cmd')"), 'must NOT read .member-cmd (retired)');
    });

    // ── 4. data-field guard still present (not index-based) ────────────

    check('teamsTabSaveAgentGroup uses data-field selectors, not index-based guards', () => {
        assert.ok(saveSrc.includes('[data-field="role"]'), 'must use data-field="role" selector');
        assert.ok(saveSrc.includes('[data-field="count"]'), 'must use data-field="count" selector');
        assert.ok(saveSrc.includes('[data-field="scope"]'), 'must use data-field="scope" selector');
        assert.ok(saveSrc.includes('[data-field="relationship"]'), 'must use data-field="relationship" selector');
    });

    // ── 5. team form has a machine selector ─────────────────────────────

    check('markup includes the team machine selector', () => {
        assert.ok(source.includes('id="agent-groups-machine"'), 'must include #agent-groups-machine select');
    });

    // ── 6. save stamps machine on the group ─────────────────────────────

    check('teamsTabSaveAgentGroup reads the machine selector and stamps machine on the group', () => {
        assert.ok(/agent-groups-machine/.test(saveSrc), 'must read the machine selector');
        assert.ok(/machine:\s*teamMachine/.test(saveSrc), 'must stamp machine: teamMachine on the group');
    });

    // ── 7. saved member never carries startupCommand ─────────────────────

    check('teamsTabSaveAgentGroup does NOT persist per-member startupCommand', () => {
        assert.ok(!/startupCommand\s*:/.test(saveSrc), 'must not stamp startupCommand on a member');
    });

    check('member row save() deletes member.startupCommand', () => {
        assert.ok(/delete member\.startupCommand/.test(memberRowSrc), 'must delete member.startupCommand (retired)');
    });

    // ── 8. guidance hint reflects machine-resolved commands ─────────────

    check('markup includes the machine-resolved command guidance hint', () => {
        assert.ok(source.includes("Each member resolves its startup command from the selected machine's command map"),
            'must include the machine-resolved guidance hint above the members list');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
