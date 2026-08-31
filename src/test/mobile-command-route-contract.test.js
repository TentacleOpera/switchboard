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

    console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
    if (failed > 0) {
        process.exit(1);
    }
}

if (require.main === module) {
    run();
}

module.exports = { run };
