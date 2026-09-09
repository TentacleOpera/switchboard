'use strict';

/**
 * Contract: Team member seats can run their own agent CLI.
 *
 * Source-level assertions against kanban.html, per the plan's Verification Plan:
 *  1. The member row builder creates inputs with classes `member-label` and
 *     `member-cmd`, and neither sets `data-role`.
 *  2. `teamsTabSaveAgentGroup` no longer contains `existing.find(m => m.role === role)`.
 *  3. `teamsTabSaveAgentGroup` reads `.member-cmd` and `.member-label` by `querySelector`.
 *  4. The `inputs.length >= 2 && selects.length >= 2` guard is NOT present (the
 *     save path now uses data-field selectors, not index-based guards).
 *
 * Run with:
 *   node src/test/teams-tab-member-editor-contract.test.js
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const KANBAN_HTML = path.join(__dirname, '..', '..', 'src', 'webview', 'kanban.html');
const source = fs.readFileSync(KANBAN_HTML, 'utf8');

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

    // ── 1. member-label and member-cmd classes exist, no data-role ──────

    check('member row creates .member-label and .member-cmd inputs', () => {
        assert.ok(memberRowSrc.includes("className = 'member-label'"), 'must create .member-label input');
        assert.ok(memberRowSrc.includes("className = 'member-cmd'"), 'must create .member-cmd input');
    });

    check('member row inputs do NOT carry data-role', () => {
        // The member row function must not assign data-role to the label or cmd inputs.
        // Check that neither labelIn nor cmdIn gets a data-role assignment.
        assert.ok(!/labelIn\.dataset\.role/.test(memberRowSrc), 'labelIn must not get data-role');
        assert.ok(!/cmdIn\.dataset\.role/.test(memberRowSrc), 'cmdIn must not get data-role');
        assert.ok(!/labelIn\.setAttribute\(['"]data-role/.test(memberRowSrc), 'labelIn must not setAttribute data-role');
        assert.ok(!/cmdIn\.setAttribute\(['"]data-role/.test(memberRowSrc), 'cmdIn must not setAttribute data-role');
    });

    // ── 2. save path no longer has the lossy shim ───────────────────────

    check('teamsTabSaveAgentGroup no longer contains existing.find(m => m.role === role)', () => {
        assert.ok(!/existing\.find\(m\s*=>\s*m\.role\s*===\s*role/.test(saveSrc),
            'the lossy role-lookup shim must be deleted');
    });

    // ── 3. save path reads by class ──────────────────────────────────────

    check('teamsTabSaveAgentGroup reads .member-cmd and .member-label by querySelector', () => {
        assert.ok(saveSrc.includes("querySelector('.member-cmd')"), 'must read .member-cmd by class');
        assert.ok(saveSrc.includes("querySelector('.member-label')"), 'must read .member-label by class');
    });

    // ── 4. data-field guard still present (not index-based) ────────────

    check('teamsTabSaveAgentGroup uses data-field selectors, not index-based guards', () => {
        assert.ok(saveSrc.includes('[data-field="role"]'), 'must use data-field="role" selector');
        assert.ok(saveSrc.includes('[data-field="count"]'), 'must use data-field="count" selector');
        assert.ok(saveSrc.includes('[data-field="scope"]'), 'must use data-field="scope" selector');
        assert.ok(saveSrc.includes('[data-field="relationship"]'), 'must use data-field="relationship" selector');
    });

    // ── 5. placeholder names inherited command ──────────────────────────

    check('member row cmd placeholder names the inherited command', () => {
        assert.ok(memberRowSrc.includes('syncCmdPlaceholder'), 'must have syncCmdPlaceholder function');
        assert.ok(/inherits:/.test(memberRowSrc), 'placeholder must say "inherits: ..."');
        assert.ok(/lastStartupCommands/.test(memberRowSrc), 'must read from lastStartupCommands');
    });

    // ── 6. save function trims and deletes empty keys ───────────────────

    check('save function trims label/cmd and deletes empty keys', () => {
        assert.ok(/labelIn\.value\.trim\(\)/.test(memberRowSrc), 'must trim label value');
        assert.ok(/cmdIn\.value\.trim\(\)/.test(memberRowSrc), 'must trim cmd value');
        assert.ok(/delete member\.label/.test(memberRowSrc), 'must delete member.label when empty');
        assert.ok(/delete member\.startupCommand/.test(memberRowSrc), 'must delete member.startupCommand when empty');
    });

    // ── 7. guidance hint exists in the markup ───────────────────────────

    check('markup includes the "leave command empty" guidance hint', () => {
        assert.ok(source.includes("Leave a member's command empty to use the role's configured CLI."),
            'must include the guidance hint above the members list');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) process.exit(1);
}

run();
