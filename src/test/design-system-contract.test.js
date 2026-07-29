'use strict';

/**
 * Contract tests for the Design System feature set (plans #1–#8).
 *
 * Covers the cross-plan contracts recorded in the feature file:
 *  - #1: `_isDesignOrImageFile` accepts .html/.htm without regressing the whitelist
 *  - #2: `buildDesignSystemBlock` emits the DESIGN SYSTEM framing, never the PRD label
 *  - #3: scope-aware token extraction — 4 scopes normalize to exactly light+dark,
 *        the two dark mechanisms merge into ONE group, raw CSS works (#8 reuse)
 *  - #4: pointer-file bind/unbind roundtrip; empty refs ⇒ no block
 *  - #5: role policy — planner gets full content, coder gets table+link,
 *        reviewer/tester get review framing; exactly one block per prompt
 *  - #7: the starter template parses through the #3 extractor with both schemes
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { installVscodeTrap } = require('./helpers/verbEngineTestSeams');
installVscodeTrap();

const { extractTokensFromCss, extractDesignSystemTokens } = require('../../out/services/designSystemTokens');
const { buildDesignSystemBlock, buildDesignSystemReferencesBlockFromRefs } = require('../../out/services/agentPromptBuilder');
const { STARTER_DESIGN_SYSTEM_HTML } = require('../../out/services/designSystemStarterTemplate');
const {
    getProjectDesignSystemPointerPath,
    getProjectDesignSystemPath,
    setProjectDesignSystemPath,
    removeProjectDesignSystemPath
} = require('../../out/services/designSystemUtils');
const { LocalFolderService } = require('../../out/services/LocalFolderService');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(`     ${e && e.message ? e.message : e}`);
        failed++;
    }
}

// Mirrors the reference file's shape: every token name declared 4× across
// base-light, media-dark, data-theme-dark and data-theme-light scopes.
const FOUR_SCOPE_CSS = `
:root {
    --ground: #FDFDFD;
    --accent: #FF9F21;
}
@media (prefers-color-scheme: dark) {
    :root {
        --ground: #17130F;
        --accent: #FFB454;
    }
}
:root[data-theme="dark"] {
    --ground: #17130F;
    --accent: #FFB454;
}
:root[data-theme="light"] {
    --ground: #FDFDFD;
    --accent: #FF9F21;
}
body { color: red; margin: 0; }
@keyframes spin { 0% { opacity: 0; } 100% { opacity: 1; } }
`;

const FOUR_SCOPE_HTML = `<!DOCTYPE html><html><head><style>${FOUR_SCOPE_CSS}</style></head>
<body><section><h2>Color Palette</h2></section><section><h2>Typography</h2></section></body></html>`;

async function main() {
    console.log('Design System contract tests');

    await test('#3: all declarations found and attributed across the four scopes', () => {
        const decls = extractTokensFromCss(FOUR_SCOPE_CSS);
        const custom = decls.filter(d => d.name.startsWith('--'));
        assert.strictEqual(custom.length, 8, `expected 8 declarations (2 names × 4 scopes), got ${custom.length}`);
        const names = new Set(custom.map(d => d.name));
        assert.deepStrictEqual([...names].sort(), ['--accent', '--ground']);
    });

    await test('#3: four scopes normalize to exactly light + dark, dark mechanisms merged', () => {
        const result = extractDesignSystemTokens(FOUR_SCOPE_HTML);
        const schemes = result.groups.map(g => g.scheme).sort();
        assert.deepStrictEqual(schemes, ['dark', 'light'], `expected [dark, light], got [${schemes}]`);
        const dark = result.groups.find(g => g.scheme === 'dark');
        const light = result.groups.find(g => g.scheme === 'light');
        assert.strictEqual(dark.tokens.length, 2, 'dark group must dedupe the two dark mechanisms');
        assert.strictEqual(light.tokens.length, 2, 'light group must dedupe :root and [data-theme=light]');
        assert.strictEqual(dark.tokens.find(t => t.name === '--ground').value, '#17130F');
        assert.strictEqual(light.tokens.find(t => t.name === '--ground').value, '#FDFDFD');
    });

    await test('#3: ordinary properties and keyframes are excluded', () => {
        const decls = extractTokensFromCss(FOUR_SCOPE_CSS);
        assert.ok(decls.every(d => d.name.startsWith('--')), 'non-custom-property declarations leaked');
    });

    await test('#3: section inventory collected from <h2> headings', () => {
        const result = extractDesignSystemTokens(FOUR_SCOPE_HTML);
        assert.deepStrictEqual(result.sections, ['Color Palette', 'Typography']);
    });

    await test('#3: input with no <style> block and no CSS returns empty groups without throwing', () => {
        const result = extractDesignSystemTokens('<p>just prose</p>');
        assert.deepStrictEqual(result.groups, []);
    });

    await test('#3: nested blocks do not desync scope tracking (depth guard)', () => {
        const css = '@keyframes spin { 0% { opacity: 0; } 100% { opacity: 1; } }\n:root { --after: #ABCDEF; }';
        const decls = extractTokensFromCss(css);
        const after = decls.find(d => d.name === '--after');
        assert.ok(after, '--after was lost after a nested-block construct');
        assert.strictEqual(after.value, '#ABCDEF');
    });

    await test('#8: extractTokensFromCss works on raw stylesheet text (no HTML wrapper)', () => {
        const decls = extractTokensFromCss(':root { --brand: #123456; }');
        assert.strictEqual(decls.length, 1);
        assert.strictEqual(decls[0].name, '--brand');
    });

    await test('#3: size caps bite on oversized token sets and set the truncated flag', () => {
        const many = Array.from({ length: 80 }, (_, i) => `--token-${i}: #ABCDEF;`).join('\n');
        const result = extractDesignSystemTokens(`<style>:root{${many}}</style>`);
        assert.strictEqual(result.truncated, true, 'truncated flag not set');
        const group = result.groups[0];
        assert.ok(group.tokens.length <= 50, `per-group cap exceeded: ${group.tokens.length}`);
    });

    await test('#2: author block uses the DESIGN SYSTEM header, never the PRD label', () => {
        const block = buildDesignSystemBlock({ link: '/tmp/ds.html' });
        assert.ok(block.includes('DESIGN SYSTEM'), 'missing DESIGN SYSTEM header');
        assert.ok(!block.includes('PROJECT PRD REFERENCE'), 'legacy PRD label leaked');
        assert.ok(block.includes('It complements the PRD'), 'approved framing text missing');
    });

    await test('#5: review mode emits review framing', () => {
        const block = buildDesignSystemBlock({ link: '/tmp/ds.html', mode: 'review' });
        assert.ok(block.includes('DESIGN SYSTEM REVIEW CONSTRAINTS'), 'missing review header');
    });

    await test('#2/#3: non-HTML content falls back to the content form', () => {
        const block = buildDesignSystemBlock({ content: 'Use blue buttons. Keep spacing airy.' });
        assert.ok(block.includes('Use blue buttons'), 'content fallback missing');
    });

    await test('#4: empty/absent refs emit no block at all', () => {
        assert.strictEqual(buildDesignSystemReferencesBlockFromRefs([], 'coder'), '');
        assert.strictEqual(buildDesignSystemReferencesBlockFromRefs(undefined, 'coder'), '');
    });

    const tmp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ds-contract-'));
    const dsFile = path.join(tmp, 'ds.html');
    const MARKER = 'UNIQUE-FULL-CONTENT-MARKER-9F1';
    await fs.promises.writeFile(dsFile, `<!DOCTYPE html><html><head><style>${FOUR_SCOPE_CSS}</style></head><body><h2>Palette</h2><p>${MARKER}</p></body></html>`, 'utf8');
    const refs = [{ projectName: 'proj-a', designSystemLink: dsFile }];

    await test('#5: planner prompt carries the full document', () => {
        const block = buildDesignSystemReferencesBlockFromRefs(refs, 'planner');
        assert.ok(block.includes(MARKER), 'planner must receive full content');
        assert.ok(block.includes('--ground'), 'planner must also receive the token table');
    });

    await test('#5: coder prompt carries token table + link, not the full document', () => {
        const block = buildDesignSystemReferencesBlockFromRefs(refs, 'coder');
        assert.ok(!block.includes(MARKER), 'coder must not receive full content');
        assert.ok(block.includes('--ground'), 'coder must receive the token table');
        assert.ok(block.includes(dsFile), 'coder must receive the file link');
        const count = (block.match(/DESIGN SYSTEM/g) || []).length;
        assert.strictEqual(count, 1, `expected exactly one DESIGN SYSTEM block, got ${count}`);
    });

    await test('#5: reviewer and tester prompts use review framing', () => {
        for (const role of ['reviewer', 'tester']) {
            const block = buildDesignSystemReferencesBlockFromRefs(refs, role);
            assert.ok(block.includes('DESIGN SYSTEM REVIEW CONSTRAINTS'), `${role} missing review framing`);
        }
    });

    await test('#7: starter template parses through the extractor with light AND dark schemes', () => {
        const result = extractDesignSystemTokens(STARTER_DESIGN_SYSTEM_HTML);
        const schemes = result.groups.map(g => g.scheme);
        assert.ok(schemes.includes('light'), 'starter template missing light scheme');
        assert.ok(schemes.includes('dark'), 'starter template missing dark scheme');
        const dark = result.groups.find(g => g.scheme === 'dark');
        assert.strictEqual(dark.tokens.find(t => t.name === '--ground').value, '#121212');
        assert.ok(result.sections.length >= 5, `starter template should render >=5 sections, got ${result.sections.length}`);
    });

    await test('#7: starter template contains no invalid at-rule-in-selector-list CSS', () => {
        assert.ok(!/:root\[data-theme="dark"\]\s*,\s*@media/.test(STARTER_DESIGN_SYSTEM_HTML),
            'template mixes an at-rule into a selector list — browsers drop the whole rule');
    });

    await test('#1: _isDesignOrImageFile accepts .html/.htm without whitelist regression', () => {
        const isDesign = (name) => LocalFolderService.prototype['_isDesignOrImageFile'].call({}, name);
        for (const ok of ['x.html', 'x.htm', 'x.md', 'x.css', 'x.scss', 'x.json', 'x.yaml', 'x.png', 'x.svg', 'x.xml']) {
            assert.strictEqual(isDesign(ok), true, `${ok} should be accepted`);
        }
        for (const no of ['x.exe', 'x.ts', 'x.mp4', 'x']) {
            assert.strictEqual(isDesign(no), false, `${no} should be rejected`);
        }
    });

    await test('#4: pointer-file bind/read/unbind roundtrip (workspace-relative)', async () => {
        const wsRoot = path.join(tmp, 'ws');
        const inside = path.join(wsRoot, 'designs', 'system.html');
        await fs.promises.mkdir(path.dirname(inside), { recursive: true });
        await fs.promises.writeFile(inside, '<html></html>', 'utf8');
        await setProjectDesignSystemPath(wsRoot, 'My Project', inside);
        const pointer = getProjectDesignSystemPointerPath(wsRoot, 'My Project');
        assert.ok(fs.existsSync(pointer), 'pointer file not written');
        const stored = JSON.parse(await fs.promises.readFile(pointer, 'utf8'));
        assert.ok(!path.isAbsolute(stored.path), 'in-workspace target must be stored relative');
        assert.strictEqual(await getProjectDesignSystemPath(wsRoot, 'My Project'), inside);
        await removeProjectDesignSystemPath(wsRoot, 'My Project');
        assert.ok(!fs.existsSync(pointer), 'pointer file not removed on unbind');
        assert.strictEqual(await getProjectDesignSystemPath(wsRoot, 'My Project'), null);
    });

    await test('#4: out-of-workspace targets are stored absolute and resolve', async () => {
        const wsRoot = path.join(tmp, 'ws2');
        await fs.promises.mkdir(wsRoot, { recursive: true });
        await setProjectDesignSystemPath(wsRoot, 'Other', dsFile);
        const stored = JSON.parse(await fs.promises.readFile(getProjectDesignSystemPointerPath(wsRoot, 'Other'), 'utf8'));
        assert.ok(path.isAbsolute(stored.path), 'out-of-workspace target must be stored absolute');
        assert.strictEqual(await getProjectDesignSystemPath(wsRoot, 'Other'), dsFile);
    });

    await test('#4: a pointer to a missing file resolves to null (unbound)', async () => {
        const wsRoot = path.join(tmp, 'ws3');
        await setProjectDesignSystemPath(wsRoot, 'Ghost', path.join(tmp, 'does-not-exist.html'));
        assert.strictEqual(await getProjectDesignSystemPath(wsRoot, 'Ghost'), null);
    });

    await fs.promises.rm(tmp, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
