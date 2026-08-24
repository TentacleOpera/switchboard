'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
function test(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

(function main() {
    console.log('\n── Dispatch preparation curtain & UFO contract tests ──');

    const ufoAnimatedPath = path.join(REPO_ROOT, 'icons', 'switchboard-ufo.svg');
    const ufoStaticPath = path.join(REPO_ROOT, 'icons', 'switchboard-ufo-static.svg');
    const ufoClaudifyAnimatedPath = path.join(REPO_ROOT, 'icons', 'switchboard-ufo-claudify.svg');
    const ufoClaudifyStaticPath = path.join(REPO_ROOT, 'icons', 'switchboard-ufo-claudify-static.svg');

    test('All 4 UFO icon assets exist in icons/', () => {
        assert.ok(fs.existsSync(ufoAnimatedPath), 'switchboard-ufo.svg must exist');
        assert.ok(fs.existsSync(ufoStaticPath), 'switchboard-ufo-static.svg must exist');
        assert.ok(fs.existsSync(ufoClaudifyAnimatedPath), 'switchboard-ufo-claudify.svg must exist');
        assert.ok(fs.existsSync(ufoClaudifyStaticPath), 'switchboard-ufo-claudify-static.svg must exist');
    });

    const ufoAnimated = fs.readFileSync(ufoAnimatedPath, 'utf8');
    const ufoStatic = fs.readFileSync(ufoStaticPath, 'utf8');
    const ufoClaudifyAnimated = fs.readFileSync(ufoClaudifyAnimatedPath, 'utf8');
    const ufoClaudifyStatic = fs.readFileSync(ufoClaudifyStaticPath, 'utf8');

    test('Claudify variants use terracotta (#D97757 / #E2A188) and contain no cyan (#00e5ff or #00363a)', () => {
        assert.ok(ufoClaudifyAnimated.includes('#D97757'), 'Claudify animated must contain #D97757');
        assert.ok(ufoClaudifyAnimated.includes('#E2A188'), 'Claudify animated must contain #E2A188');
        assert.ok(!ufoClaudifyAnimated.toLowerCase().includes('#00e5ff'), 'Claudify animated must NOT contain #00e5ff');
        assert.ok(!ufoClaudifyAnimated.toLowerCase().includes('#00363a'), 'Claudify animated must NOT contain #00363a');

        assert.ok(ufoClaudifyStatic.includes('#D97757'), 'Claudify static must contain #D97757');
        assert.ok(ufoClaudifyStatic.includes('#E2A188'), 'Claudify static must contain #E2A188');
        assert.ok(!ufoClaudifyStatic.toLowerCase().includes('#00e5ff'), 'Claudify static must NOT contain #00e5ff');
        assert.ok(!ufoClaudifyStatic.toLowerCase().includes('#00363a'), 'Claudify static must NOT contain #00363a');
    });

    test('Static variants contain no animation or keyframe rules', () => {
        assert.ok(!ufoStatic.includes('@keyframes'), 'Afterburner static must not contain @keyframes');
        assert.ok(!ufoStatic.includes('animation:'), 'Afterburner static must not contain animation:');

        assert.ok(!ufoClaudifyStatic.includes('@keyframes'), 'Claudify static must not contain @keyframes');
        assert.ok(!ufoClaudifyStatic.includes('animation:'), 'Claudify static must not contain animation:');
    });

    test('headlessPanelHtml injects all 4 UFO icon data attributes', () => {
        const headlessCode = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'headlessPanelHtml.ts'), 'utf8');
        assert.ok(headlessCode.includes('data-ufo-animated='), 'Must inject data-ufo-animated');
        assert.ok(headlessCode.includes('data-ufo-static='), 'Must inject data-ufo-static');
        assert.ok(headlessCode.includes('data-ufo-claudify-animated='), 'Must inject data-ufo-claudify-animated');
        assert.ok(headlessCode.includes('data-ufo-claudify-static='), 'Must inject data-ufo-claudify-static');
    });

    test('terminals.html defines required curtain styling and UFO classes', () => {
        const html = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminals.html'), 'utf8');
        assert.ok(html.includes('.terminal-curtain'), 'Must define .terminal-curtain');
        assert.ok(html.includes('.startup-curtain-sublabel'), 'Must define .startup-curtain-sublabel');
        assert.ok(html.includes('.terminal-curtain-sublabel'), 'Must define .terminal-curtain-sublabel');
        assert.ok(html.includes('.dispatch-curtain-icon'), 'Must define .dispatch-curtain-icon');
        assert.ok(html.includes('.item-role-icon.is-preparing'), 'Must define .item-role-icon.is-preparing');
    });

    test('terminals.js defines dispatch curtain lifecycle and UFO resolution', () => {
        const js = fs.readFileSync(path.join(REPO_ROOT, 'src', 'webview', 'terminals.js'), 'utf8');
        assert.ok(js.includes('const dispatchCurtains = new Map()'), 'Must declare dispatchCurtains map');
        assert.ok(js.includes('function getUfoIconUri()'), 'Must declare getUfoIconUri');
        assert.ok(js.includes('function armDispatchCurtain('), 'Must declare armDispatchCurtain');
        assert.ok(js.includes('function disarmDispatchCurtain('), 'Must declare disarmDispatchCurtain');
        assert.ok(js.includes('function renderDispatchCurtain('), 'Must declare renderDispatchCurtain');
        assert.ok(js.includes('function updateCurtainVisuals()'), 'Must declare updateCurtainVisuals');
        assert.ok(js.includes("'terminalDispatchPreparing'"), 'Must handle terminalDispatchPreparing');
        assert.ok(js.includes("'terminalDispatchFinished'"), 'Must handle terminalDispatchFinished');
        assert.ok(js.includes('Preparing for dispatch…'), 'Must have primary label Preparing for dispatch…');
        assert.ok(js.includes('is resetting context.'), 'Must have secondary reset label');
    });

    if (failures > 0) {
        console.error(`\n${failures} check(s) failed.\n`);
        process.exit(1);
    }
    console.log('\nAll dispatch curtain contract tests passed.\n');
})();
