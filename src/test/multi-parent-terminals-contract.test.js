'use strict';

/**
 * Contract tests for Multi-Parent Workspace Terminals.
 *
 * Half behavioural, half source-text, and the split is deliberate.
 *
 * `resolveParentsForTerminals` is a pure function over paths, so it is tested for
 * real — and it has to be, because every one of its failure modes is SILENT. A
 * prefix test instead of a segment test files `/…/Gitlab-archive` under the
 * `/…/Gitlab` parent; a shortest-match win files `/x/y/z` under `/x` instead of
 * `/x/y`; forgetting the disabled-mappings case returns an empty `parents[]` for
 * the majority of operators, who have configured no mappings at all. Nothing
 * throws in any of those cases. The label is just wrong, which is the exact bug
 * this feature exists to remove.
 *
 * The rest are source-text contracts on decisions that are invisible on
 * inspection and were each wrong in a first pass:
 *
 *   - the proxy must resolve the active parent through KanbanProvider's WRAPPER,
 *     not the bare mappings resolver. The wrapper honours `kanban.controlPlaneRoot`
 *     first; `createAgentGrid` uses it, and this path exists to match that button
 *     exactly. Calling the module function directly makes the two open different
 *     repos for anyone with a control-plane root set — and only for them.
 *   - the STANDALONE host has no proxy in front of it, so it must translate
 *     `parentRoot` itself or the sidebar's per-parent `+` spawns in the boot root
 *     and reports success.
 *   - `create()` must not infer "worktree" from "cwd is not the boot root". Once
 *     the proxy injects the active parent as `cwd`, that inference stamps a
 *     worktreePath on every terminal and the sidebar grows phantom worktree groups.
 *   - an unattributed terminal folds into a sole parent group ONLY when that group
 *     is the synthetic catch-all. With one real configured mapping, folding
 *     re-creates the mislabelling the hierarchy was built to remove.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const { resolveParentsForTerminals } = require('../../out/services/WorkspaceIdentityService');

const terminalsJs = fs.readFileSync(path.join(__dirname, '../webview/terminals.js'), 'utf8');
const taskViewerTs = fs.readFileSync(path.join(__dirname, '../services/TaskViewerProvider.ts'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');
const ptyHostTs = fs.readFileSync(path.join(__dirname, '../standalone/ptyHost.ts'), 'utf8');
const fleetTs = fs.readFileSync(path.join(__dirname, '../standalone/ptyFleetService.ts'), 'utf8');

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

function block(code, startMarker, endMarker) {
    const start = code.indexOf(startMarker);
    assert.ok(start !== -1, `marker not found: ${startMarker}`);
    const end = code.indexOf(endMarker, start);
    assert.ok(end !== -1, `end marker not found after "${startMarker}": ${endMarker}`);
    return code.substring(start, end);
}

const HOME = os.homedir();
const GITLAB = path.resolve('/tmp/sb-fixture/Documents/Gitlab');
const GITHUB = path.resolve('/tmp/sb-fixture/Documents/GitHub');

const TWO_PARENTS = {
    enabled: true,
    mappings: [
        { id: 'm-gitlab', name: 'Autism360App', dbPath: '', parentFolder: GITLAB, workspaceFolders: [path.join(GITLAB, 'be')] },
        { id: 'm-github', name: 'Switchboard', dbPath: '', parentFolder: GITHUB, workspaceFolders: [path.join(GITHUB, 'switchboard')] },
    ],
};

console.log('\n--- resolveParentsForTerminals: attribution ---');

test('attributes each terminal to the mapping that owns its cwd', () => {
    const terminals = [
        { friendlyName: 'coder-1', cwd: path.join(GITLAB, 'be') },
        { friendlyName: 'coder-2', cwd: path.join(GITHUB, 'switchboard-site') },
    ];
    const { parentMap } = resolveParentsForTerminals(TWO_PARENTS, GITLAB, terminals);
    assert.strictEqual(parentMap.get(path.join(GITLAB, 'be')), GITLAB);
    assert.strictEqual(parentMap.get(path.join(GITHUB, 'switchboard-site')), GITHUB);
});

test('a cwd under no mapping resolves to null, not to a nearby parent', () => {
    const terminals = [{ friendlyName: 'coder-1', cwd: path.resolve('/tmp/sb-fixture/elsewhere') }];
    const { parentMap } = resolveParentsForTerminals(TWO_PARENTS, GITLAB, terminals);
    assert.strictEqual(parentMap.get(path.resolve('/tmp/sb-fixture/elsewhere')), null);
});

test('segment comparison: /…/Gitlab-archive is NOT a child of /…/Gitlab', () => {
    const archive = GITLAB + '-archive';
    const { parentMap } = resolveParentsForTerminals(TWO_PARENTS, GITLAB, [{ cwd: archive }]);
    assert.strictEqual(parentMap.get(archive), null, 'raw string prefix match leaked a sibling directory in');
});

test('longest match wins with overlapping mappings /x and /x/y', () => {
    const x = path.resolve('/tmp/sb-fixture/x');
    const xy = path.join(x, 'y');
    const cfg = {
        enabled: true,
        mappings: [
            { id: 'm-x', name: 'X', dbPath: '', parentFolder: x, workspaceFolders: [] },
            { id: 'm-xy', name: 'XY', dbPath: '', parentFolder: xy, workspaceFolders: [] },
        ],
    };
    const { parentMap } = resolveParentsForTerminals(cfg, x, [{ cwd: path.join(xy, 'z') }]);
    assert.strictEqual(parentMap.get(path.join(xy, 'z')), xy);
});

test('a ~-prefixed parentFolder still matches an absolute cwd', () => {
    const cfg = {
        enabled: true,
        mappings: [{ id: 'm-home', name: 'Home', dbPath: '', parentFolder: '~/SbFixtureHome', workspaceFolders: [] }],
    };
    const cwd = path.join(HOME, 'SbFixtureHome', 'repo');
    const { parents, parentMap } = resolveParentsForTerminals(cfg, HOME, [{ cwd }]);
    assert.strictEqual(parents[0].parentFolder, path.resolve(path.join(HOME, 'SbFixtureHome')));
    assert.strictEqual(parentMap.get(cwd), path.resolve(path.join(HOME, 'SbFixtureHome')));
});

console.log('\n--- resolveParentsForTerminals: the parents[] list ---');

test('a configured parent holding zero terminals still appears in parents[]', () => {
    const { parents } = resolveParentsForTerminals(TWO_PARENTS, GITLAB, [{ cwd: path.join(GITLAB, 'be') }]);
    assert.strictEqual(parents.length, 2);
    assert.ok(parents.some(p => p.parentFolder === GITHUB), 'the terminal-less parent was dropped');
});

test('parents carry the configured name, so the header names a real place', () => {
    const { parents } = resolveParentsForTerminals(TWO_PARENTS, GITLAB, []);
    assert.deepStrictEqual(parents.map(p => p.name).sort(), ['Autism360App', 'Switchboard']);
});

test('disabled mappings yield exactly ONE synthetic parent — never an empty array', () => {
    const cwd = path.join(GITLAB, 'be');
    const { parents, parentMap } = resolveParentsForTerminals({ enabled: false, mappings: [] }, GITLAB, [{ cwd }]);
    assert.strictEqual(parents.length, 1, 'the majority case (no mappings configured) rendered nothing');
    assert.strictEqual(parents[0].id, 'workspace-root');
    assert.strictEqual(parents[0].name, path.basename(GITLAB), 'synthetic parent must use the repo basename, not a hardcoded label');
    assert.strictEqual(parentMap.get(cwd), GITLAB, 'every terminal must resolve to the synthetic parent');
});

test('enabled-but-empty mappings also fall back to the synthetic parent', () => {
    const { parents } = resolveParentsForTerminals({ enabled: true, mappings: [] }, GITLAB, []);
    assert.strictEqual(parents.length, 1);
    assert.strictEqual(parents[0].id, 'workspace-root');
});

test('a mapping with no parentFolder falls back to its first workspaceFolder', () => {
    const child = path.join(GITHUB, 'switchboard');
    const cfg = {
        enabled: true,
        mappings: [{ id: 'm-nf', name: 'NoParent', dbPath: '', workspaceFolders: [child] }],
    };
    const { parents, parentMap } = resolveParentsForTerminals(cfg, GITLAB, [{ cwd: child }]);
    assert.strictEqual(parents[0].parentFolder, child);
    assert.strictEqual(parentMap.get(child), child);
});

test('a terminal predating the cwd field resolves to null rather than throwing', () => {
    const { parentMap } = resolveParentsForTerminals(TWO_PARENTS, GITLAB, [{ friendlyName: 'legacy-1' }]);
    assert.strictEqual(parentMap.get(undefined) ?? null, null);
});

console.log('\n--- host parity: both ptyListTerminals copies report cwd ---');

test('the standalone pty host reports cwd per terminal', () => {
    const arm = block(ptyHostTs, "case 'ptyListTerminals': {", "case 'ptyRenameTerminal'");
    assert.ok(/cwd:\s*t\.cwd/.test(arm), 'ptyHost.ts dropped cwd — the extension proxy has nothing to resolve');
});

test('the standalone bootstrap reports cwd AND enriches with parents[]', () => {
    const arm = block(bootstrapTs, "case 'ptyListTerminals': {", "case 'ptyRenameTerminal'");
    assert.ok(/cwd:\s*t\.cwd/.test(arm), 'bootstrap.ts dropped cwd');
    assert.ok(arm.includes('resolveParentsForTerminals'), 'bootstrap.ts must enrich — it has no proxy in front of it');
    assert.ok(/parentRoot:\s*parentMap\.get\(t\.cwd\)/.test(arm), 'bootstrap.ts must attach parentRoot per terminal');
    assert.ok(/parents,/.test(arm), 'bootstrap.ts must return the top-level parents list');
});

test('the fleet records the directory it actually spawned in', () => {
    assert.ok(/cwd:\s*string/.test(fleetTs), 'ExtendedTerminalHandle must carry cwd');
    assert.ok(/cwd:\s*effectiveCwd/.test(fleetTs), 'create() must store the cwd it computed instead of discarding it');
});

console.log('\n--- spawn targeting ---');

test('create() does not infer "worktree" from "cwd is not the boot root"', () => {
    assert.ok(
        /worktreePath:\s*worktreePath\s*\|\|\s*undefined/.test(fleetTs),
        'the back-stamp is back — every injected cwd becomes a phantom worktree group'
    );
    assert.ok(
        !/cwd\s*!==\s*this\.workspaceRoot/.test(fleetTs),
        'the boot-root comparison must be gone, not merely bypassed'
    );
});

test('the proxy resolves the active parent through the KanbanProvider wrapper', () => {
    const arm = block(taskViewerTs, "if (verb === 'ptyCreateTerminal' && payload) {", 'const result = await this._ptyHostVerb(verb, payload)');
    assert.ok(
        /_kanbanProvider\?\.resolveEffectiveWorkspaceRoot\(selected\)/.test(arm),
        'must call the wrapper (it honours kanban.controlPlaneRoot first), not the bare mappings resolver — '
        + 'otherwise this button and OPEN AGENT TERMINALS in VS Code open different repos'
    );
    assert.ok(/getCurrentWorkspaceRoot\(\)/.test(arm), 'the board selection must be read at request time, not at host boot');
});

test('the proxy only injects a cwd when the caller named no target', () => {
    const arm = block(taskViewerTs, "if (verb === 'ptyCreateTerminal' && payload) {", 'const result = await this._ptyHostVerb(verb, payload)');
    const guards = arm.match(/!payload\.cwd\s*&&\s*!payload\.worktreePath/g) || [];
    assert.ok(guards.length >= 2, 'both the parentRoot translation and the active-parent injection must be gated on an absent target');
});

test('the proxy translates parentRoot into cwd and strips it before forwarding', () => {
    const arm = block(taskViewerTs, "if (verb === 'ptyCreateTerminal' && payload) {", 'const result = await this._ptyHostVerb(verb, payload)');
    assert.ok(/cwd:\s*payload\.parentRoot/.test(arm), 'parentRoot must become a cwd — the child never learns the concept');
    assert.ok(/delete payload\.parentRoot/.test(arm), 'parentRoot must not reach the child');
    assert.ok(/payload = \{ \.\.\.payload/.test(arm), 'the payload must be copied, not mutated in the caller');
});

test('the standalone host translates parentRoot itself — it has no proxy', () => {
    const arm = block(bootstrapTs, "case 'ptyCreateTerminal': {", "case 'ptyCloseTerminal'");
    assert.ok(
        /payload\.parentRoot/.test(arm),
        'the sidebar per-parent + is served by this host too; ignoring parentRoot makes it spawn in the boot root and report success'
    );
});

console.log('\n--- sidebar hierarchy ---');

test('the per-parent + posts parentRoot and never a cwd', () => {
    // Marker stops at `targetSpec` on purpose: the parameter list grows (the startup
    // curtain added a third arg), and pinning the full signature made this contract
    // fail on an unrelated edit rather than on the payload shape it actually guards.
    const create = block(terminalsJs, 'async function createTerminal(role, targetSpec', "const res = await fetch('/terminals/verb/ptyCreateTerminal'");
    assert.ok(/targetSpec\.parentRoot/.test(create), 'the parent path needs its own branch');
    const parentBranch = block(create, 'if (targetSpec.parentRoot) {', '}');
    assert.ok(!/payload\.cwd/.test(parentBranch), 'setting cwd alongside parentRoot bypasses the proxy translation');
    assert.ok(
        /onNewTerminalClicked\(parentGroup\.fullPath \? \{ parentRoot: parentGroup\.fullPath \}/.test(terminalsJs),
        'the parent header + must pass its own parentFolder'
    );
});

test('OPEN AGENT TERMINALS still posts no target, so the proxy fills it in', () => {
    const openAll = block(terminalsJs, 'async function openAllTerminals() {', 'await fetchTerminalList();');
    assert.ok(/body: JSON\.stringify\(\{ role \}\)/.test(openAll), 'open-all must stay target-free — the proxy supplies the active parent');
});

test('an unattributed terminal only folds into a sole SYNTHETIC parent', () => {
    const grouping = block(terminalsJs, 'for (const item of fleetList) {', 'const activeGroupsToRender');
    assert.ok(/unmappedGroup/.test(grouping), 'a null parentRoot must be able to reach the Unmapped group');
    assert.ok(
        /workspace-root/.test(grouping) || /!parentGroups\[0\]\.fullPath/.test(grouping),
        'folding into any sole parent re-files an unmapped shell under a real repo name — gate the fold on the synthetic group'
    );
    assert.ok(
        !/parentGroups\.length === 1 \? parentGroups\[0\] : unmappedGroup/.test(grouping),
        'the ungated sole-parent fold is back'
    );
});

test('a worktreePath that is really a parent folder renders as direct, not a sub-accordion', () => {
    const grouping = block(terminalsJs, 'for (const item of fleetList) {', 'const activeGroupsToRender');
    assert.ok(
        /wtPath === targetGroup\.fullPath \|\| allParentFolders\.has\(wtPath\)/.test(grouping),
        'terminals created before the back-stamp fix are still live in the fleet — guard at render time too'
    );
});

test('Unmapped renders only when it holds something', () => {
    assert.ok(
        /unmappedGroup\.direct\.length > 0 \|\| unmappedGroup\.worktreesMap\.size > 0/.test(terminalsJs),
        'an always-on Unmapped header is new UI most operators should never see'
    );
});

test('the parent count aggregates its worktrees; each worktree counts only its own', () => {
    const render = block(terminalsJs, 'for (const parentGroup of activeGroupsToRender) {', 'const headerEl = document.createElement');
    assert.ok(/totalItems \+= wtGroup\.items\.length/.test(render), 'parent count must include nested worktree terminals');
    assert.ok(/activeCount \+= wtGroup\.items\.filter/.test(render), 'the active half of the count must aggregate too');
});

test('both levels collapse independently under one prefixed key set', () => {
    assert.ok(/'parent:' \+ parentGroup\.id/.test(terminalsJs), 'parent keys must be prefixed');
    assert.ok(/'worktree:' \+ wtPath/.test(terminalsJs), 'worktree keys must be prefixed');
    assert.ok(/terminals\.collapsedGroups/.test(terminalsJs), 'the renamed setting must be both loaded and saved');
    assert.ok(!/collapsedWorktrees/.test(terminalsJs), 'the old collapse set must be gone, not shadowed');
});

test('an empty parent gets a notice so its + is discoverable', () => {
    assert.ok(/empty-parent-notice/.test(terminalsJs), 'a parent with zero terminals must still show why it is there');
});

test('the solo-mode empty-fleet guard survived the rewrite', () => {
    const guard = block(terminalsJs, 'function renderSidebarList() {', 'emptyStateEl.style.display = \'none\'');
    assert.ok(
        /if \(!soloTerminalName\)/.test(guard),
        'checkSoloNotFound owns visibility in solo mode — hiding the grid here blanks the pinned pane'
    );
});

test('the terminal row block is shared by both levels, not reimplemented', () => {
    assert.ok(/function renderTerminalRow\(item\)/.test(terminalsJs), 'the row block must be extracted, not inlined twice');
    const calls = terminalsJs.match(/appendChild\(renderTerminalRow\(item\)\)/g) || [];
    assert.strictEqual(calls.length, 2, 'direct terminals and worktree terminals must render through the same helper');
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { process.exit(1); }
