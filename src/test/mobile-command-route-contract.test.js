'use strict';

/**
 * Contract tests for the mobile command route (/command).
 * Plan: mobile-command-route-borrows-the-sidebar-idiom.md
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const { getPanelsManifest, getPanelHtmlById } = require('../../out/services/headlessPanelHtml');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (err) {
        console.error(`  FAIL ${name}: ${err.message}`);
        failed++;
    }
}

function run() {
    console.log('\n── Mobile command route contract ──\n');

    const manifest = getPanelsManifest();
    const commandEntry = manifest.find(p => p.id === 'command');

    test('getPanelsManifest contains command entry with group: cold and railHidden not true', () => {
        assert.ok(commandEntry, 'Manifest must contain command panel entry');
        assert.strictEqual(commandEntry.route, '/command', 'Route must be /command');
        assert.strictEqual(commandEntry.group, 'cold', 'Group must be cold');
        assert.strictEqual(commandEntry.enabled, true, 'Enabled must be true');
        assert.notStrictEqual(commandEntry.railHidden, true, 'railHidden must NOT be true');
    });

    const result = getPanelHtmlById('command', REPO_ROOT, REPO_ROOT);

    test('getPanelHtmlById("command") returns valid PanelHtmlResult', () => {
        assert.ok(result, 'Result must be non-null');
        assert.ok(typeof result.html === 'string' && result.html.length > 0, 'HTML must be non-empty string');
        assert.ok(typeof result.csp === 'string' && result.csp.length > 0, 'CSP must be non-empty string');
    });

    const html = result ? result.html : '';

    test('served /command HTML contains zero <input, <textarea, contenteditable', () => {
        const inputMatches = html.match(/<input\b/gi) || [];
        const textareaMatches = html.match(/<textarea\b/gi) || [];
        const contentEditableMatches = html.match(/contenteditable\b/gi) || [];

        assert.strictEqual(inputMatches.length, 0, `Expected 0 <input tags, found: ${inputMatches.length}`);
        assert.strictEqual(textareaMatches.length, 0, `Expected 0 <textarea tags, found: ${textareaMatches.length}`);
        assert.strictEqual(contentEditableMatches.length, 0, `Expected 0 contenteditable attributes, found: ${contentEditableMatches.length}`);
    });

    test('served /command HTML adheres to forbidden keywords allowlist', () => {
        const forbidden = ['password', 'PAT', 'scaffold', 'airlock', 'deregister', 'delete', 'memo'];
        for (const word of forbidden) {
            // Case-insensitive word boundary or tag check
            const re = new RegExp(`\\b${word}\\b`, 'i');
            assert.ok(!re.test(html), `Served page must not contain forbidden keyword: '${word}'`);
        }
    });

    test('served /command HTML carries viewport-fit=cover in viewport meta', () => {
        assert.ok(/<meta\s+name=["']viewport["'][^>]*viewport-fit=cover/i.test(html), 'Must include viewport-fit=cover');
    });

    test('served /command CSP contains manifest-src', () => {
        assert.ok(result.csp.includes('manifest-src'), 'CSP must contain manifest-src');
    });

    test('served /command HTML carries Hanken Grotesk font declaration', () => {
        assert.ok(html.includes('Hanken Grotesk'), 'Must contain Hanken Grotesk font family');
    });

    test('served /command HTML contains exactly 4 sub-nav destinations', () => {
        const navMatches = html.match(/data-view=["']([^"']+)["']/g) || [];
        const views = new Set(navMatches.map(m => m.replace(/data-view=["']|["']/g, '')));
        assert.strictEqual(views.size, 4, `Expected exactly 4 views (dispatch, move, mission, teams), found: ${Array.from(views).join(', ')}`);
        assert.ok(views.has('dispatch'), 'Must contain dispatch');
        assert.ok(views.has('move'), 'Must contain move');
        assert.ok(views.has('mission'), 'Must contain mission');
        assert.ok(views.has('teams'), 'Must contain teams');
        assert.ok(!views.has('view'), 'VIEW must be an overlay, not a sub-nav destination');
    });

    test('CSS contains at least two non-prefers-reduced-motion width breakpoints', () => {
        const matches = html.match(/@media\s*\(\s*min-width:[^)]+\)/g) || [];
        assert.ok(matches.length >= 2, `Expected at least 2 width breakpoints, found: ${matches.length}`);
    });

    test('both nav surfaces carry all four destinations', () => {
        // The tablet rail shipped with three: Teams was phone-only, so on an iPad
        // the Teams view was unreachable whenever the roster was empty.
        for (const [label, re] of [
            ['tablet rail', /<nav class="tablet-rail"[\s\S]*?<\/nav>/],
            ['phone nav', /<nav[^>]*id="phone-nav-bar"[\s\S]*?<\/nav>/],
        ]) {
            const block = (html.match(re) || [''])[0];
            assert.ok(block, `${label} block not found in served HTML`);
            for (const view of ['dispatch', 'move', 'mission', 'teams']) {
                assert.ok(block.includes(`data-view="${view}"`),
                    `${label} must carry the ${view} destination`);
            }
        }
    });

    test('served /command CSP grants no eval and no inline script', () => {
        // This is the one surface designed to be reached from a device that is not
        // the operator's desk; it shipped with 'unsafe-eval', 'unsafe-inline' and
        // script-src-attr while using none of them.
        for (const policy of [result.csp, html]) {
            assert.ok(!/unsafe-eval/.test(policy), "CSP must not grant 'unsafe-eval'");
            assert.ok(!/script-src-attr/.test(policy), 'CSP must not grant script-src-attr');
            assert.ok(!/script-src[^;]*unsafe-inline/.test(policy), "script-src must not grant 'unsafe-inline'");
        }
    });

    const js = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'command.js'), 'utf8');

    test('LAUNCH reaches /kanban/queue/next and nothing arms Mission Control', () => {
        assert.ok(js.includes('/kanban/queue/next'), 'LAUNCH must post /kanban/queue/next');
        assert.ok(!js.includes('/mission-control/start'), 'must not call /mission-control/start');
        assert.ok(!js.includes('/mission-control/confirm'), 'must not call /mission-control/confirm');
        assert.ok(!/\bready\s*:\s*true/.test(js), 'must not write ready');
    });

    test('the terminal viewer and the document preview carry no write path', () => {
        assert.ok(!/\.send\s*\(/.test(js), 'the pty socket must never be written to');
        assert.ok(!/method:\s*['"]PUT['"][^}]*plan\b/i.test(js), 'the preview must not save');
        assert.ok(!js.includes('/kanban/plan/save'), 'the preview must not save');
    });

    test('board reads unwrap the { success, data } envelope', () => {
        // /kanban/plans, /kanban/columns and /kanban/plan all answer through
        // _handleReadEndpoint. Read as bare bodies, the board was empty, the
        // column dropdowns were empty and the preview always said "no content".
        for (const route of ['/kanban/plans', '/kanban/columns', '/kanban/plan?']) {
            const idx = js.indexOf(route);
            assert.ok(idx > 0, `expected a read of ${route}`);
            const window = js.slice(idx, idx + 900);
            assert.ok(/payload\.data|\.data\s*!==\s*undefined/.test(window),
                `the read of ${route} must unwrap the { success, data } envelope`);
        }
    });

    test('no read targets a field its writer does not persist', () => {
        // Each of these shipped, and each resolved to undefined on every card,
        // mission or seat. The row projection is KanbanDatabase._readRows; the
        // fleet projection is the ptyListTerminals arm.
        const absent = [
            ['priority_starred', 'plan rows persist priorityStarred'],
            ['.subtaskCount', 'plan rows carry no subtaskCount'],
            ['activeMission.members', 'mission records carry plans/features, not members'],
            ['activeMission.codename', 'a mission codename is persisted as name'],
            ['t.name === headName', 'the fleet projection emits friendlyName, not name'],
            ['liveSeat.working', 'the fleet projection has no working flag'],
            ["ordersData?.groups", 'GET /terminals/standing-orders returns no groups key'],
        ];
        for (const [needle, why] of absent) {
            assert.ok(!js.includes(needle), `${needle}: ${why}`);
        }
    });

    test('the roster is real, and a dormant team seats on tap', () => {
        assert.ok(js.includes('ptyListAgentGroups'), 'the roster must come from ptyListAgentGroups');
        assert.ok(js.includes('ptyStartTeam'), 'a dormant team must seat via ptyStartTeam');
        assert.ok(!/Coder Fleet|Lead Team/.test(js), 'no fabricated placeholder teams');
    });

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    run();
}

module.exports = { run };
