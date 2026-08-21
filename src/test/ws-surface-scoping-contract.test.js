'use strict';

/**
 * Source-text contract for per-connection WS surface scoping.
 *
 * Every failure mode here is a panel that silently stops updating, which is
 * harder to notice and harder to attribute than the lag it replaces. Three
 * specific traps, all pinned below: treating an untagged push as "no
 * subscribers" (deletes roughly half the system's pushes at once); attaching the
 * surface set after the resync is sent (leaks the single largest payload past
 * the filter); and giving a panel exactly one surface (drops theme and
 * status-message pushes, which are genuinely cross-panel).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const wsHubCode = fs.readFileSync(path.join(__dirname, '../services/wsHub.ts'), 'utf8');
const transportJs = fs.readFileSync(path.join(__dirname, '../webview/transport.js'), 'utf8');
const bootstrapCode = fs.readFileSync(path.join(__dirname, '../standalone/bootstrap.ts'), 'utf8');
const kanbanProviderCode = fs.readFileSync(path.join(__dirname, '../services/KanbanProvider.ts'), 'utf8');
const headlessPanelCode = fs.readFileSync(path.join(__dirname, '../services/headlessPanelHtml.ts'), 'utf8');

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
    assert.ok(end !== -1, `end marker not found: ${endMarker}`);
    return code.substring(start, end);
}

test('an untagged push and an undeclared connection both receive everything', () => {
    assert.ok(wsHubCode.includes('if (surface && meta.surfaces && !meta.surfaces.has(surface))'),
        'the skip must require ALL THREE of: tagged push, declared connection, tag absent — roughly half the producers pass no surface, and released clients predate the parameter');
    assert.ok(wsHubCode.includes('surfaces?: Set<string>'),
        'undefined must remain distinguishable from an empty set');
});

test('a declaration that survives filtering with nothing left fails OPEN', () => {
    assert.ok(/surfaces = parsed\.size > 0 \? parsed : undefined/.test(wsHubCode),
        '?surfaces= or an all-unknown list would otherwise store an empty set, which means "deliver nothing tagged" — a silently deaf connection');
});

test('unknown surfaces are discarded, not stored', () => {
    assert.ok(wsHubCode.includes('VALID_SURFACES.has(s)'),
        'an unbounded set of client-supplied strings held per connection is a free memory amplifier, and an unrecognised surface must never act as a wildcard');
});

test('the surface set is parsed BEFORE the resync is sent', () => {
    const upgrade = wsHubCode.indexOf('public async handleUpgrade(');
    const parse = wsHubCode.indexOf("reqUrl.searchParams.get('surfaces')");
    const resync = wsHubCode.indexOf("type: '__resync'");
    assert.ok(upgrade !== -1 && parse !== -1 && resync !== -1, 'all three sites must exist');
    assert.ok(parse > upgrade && parse < resync,
        'the resync is the LARGEST payload — parsing after it sends leaks exactly the frame this change exists to filter');
});

test('the resync array is filtered per connection', () => {
    assert.ok(/state\.filter\(\(item: any\) => !item\.surface \|\| meta\.surfaces!\.has\(item\.surface\)\)/.test(wsHubCode),
        'the resync is a heterogeneous array; it must be filtered entry-by-entry with the same untagged-means-everyone rule');
});

test('seq is not incremented on the skip path', () => {
    const broadcast = block(wsHubCode, 'broadcast(verb: string', 'send(ws: WebSocket');
    assert.ok(broadcast.indexOf('continue;') < broadcast.indexOf('meta.seq += 1;'),
        'clients use seq to detect dropped pushes; incrementing on skip shows a filtered connection a permanent gap');
});

test('every panel subscribes to `common` as well as its own surface', () => {
    const map = block(wsHubCode, 'export const PANEL_SURFACES', '};');
    const entries = map.match(/^\s+\w+: \[.*\],$/gm) || [];
    assert.ok(entries.length >= 6, `expected the panel map to be populated, saw ${entries.length}`);
    entries.forEach(line => {
        assert.ok(line.includes('SURFACES.common'),
            `theme, status messages and agentCompleted are cross-panel — a one-surface-per-panel map drops them: ${line.trim()}`);
    });
});

test('the panel map is a subset of the real /panels manifest, and `project` stays fail-open', () => {
    const stamped = new Set(
        (headlessPanelCode.match(/data-panel="(\w+)"/g) || []).map(m => m.replace(/.*"(\w+)"/, '$1'))
    );
    assert.ok(stamped.size > 0, 'headlessPanelHtml.ts must stamp data-panel');
    const map = block(wsHubCode, 'export const PANEL_SURFACES', '};');
    const keys = (map.match(/^\s+(\w+): \[/gm) || []).map(m => m.trim().replace(':', '').replace(' [', ''));
    keys.forEach(k => assert.ok(stamped.has(k),
        `PANEL_SURFACES key '${k}' matches no data-panel value — a key no panel stamps is dead config`));
    assert.ok(!keys.includes('project'),
        'the Project panel consumes messages PlanningPanelProvider tags \'planning\' (project.js saveFileContentResult / chatPromptCopied) as well as ones it tags \'project\'; declaring a set for it drops half of them and silently breaks saving');
});

test('the client mirror matches the server map exactly', () => {
    const server = block(wsHubCode, 'export const PANEL_SURFACES', '};');
    const client = block(transportJs, 'const PANEL_SURFACES_MAP = {', '};');
    const serverKeys = (server.match(/^\s+(\w+): \[/gm) || []).map(m => m.trim().replace(/: \[$/, '')).sort();
    const clientKeys = (client.match(/^\s+(\w+): \[/gm) || []).map(m => m.trim().replace(/: \[$/, '')).sort();
    assert.deepStrictEqual(clientKeys, serverKeys,
        'transport.js cannot import from a .ts module, so the two maps are kept in step by hand and must not drift');
});

test('the client declares from dataset.panel INSIDE wsUrl(), not at module scope', () => {
    const wsUrlFn = block(transportJs, 'function wsUrl()', '\n    function ');
    assert.ok(wsUrlFn.includes('document.body.dataset.panel'),
        'captured at module scope, a reconnect would not re-declare — same reason the scope parameter is read live');
    assert.ok(wsUrlFn.includes('surfaces='), 'the parameter must be appended here');
    assert.ok(/if \(panel && PANEL_SURFACES_MAP\[panel\]\)/.test(wsUrlFn),
        'an unmapped or absent panel must send NO surfaces parameter — that is the fail-open default, not an error');
});

test('the client does not double-filter', () => {
    // Logging the surface is not filtering on it. transport.js prints it in the frame
    // wsLog for diagnosis (added by 3b3c6367) — `'surface=' + (msg.surface || '<untagged>')`
    // — and a bare /msg\.surface/ read that as a double-filter, failing this CI gate on a
    // false positive. Strip logging calls, then apply the ORIGINAL strictness to everything
    // that remains, so a real filter still trips in any form (comparison, if-guard,
    // .filter callback, early return) rather than only the shapes someone enumerated.
    const nonLogging = transportJs.replace(
        /\b(?:wsLog|console\.(?:log|debug|info|warn|error))\s*\([^\n]*\)/g, '');
    // Matches ANY `.surface` property read, not just `msg.surface`: a filter written as
    // `.filter(m => m.surface === ...)` renames the binding and slipped straight past the
    // original `msg.`-prefixed check. The only real `.surface` read in this file is the
    // stripped wsLog above — every other mention is prose with no leading dot — so this
    // stays specific while catching a filter under any variable name.
    assert.ok(!/\.surface\b/.test(nonLogging),
        'a second client-side filter would only mask a producer mis-tag by making it look like a delivery problem');
});

test('every resync producer tags its entries', () => {
    // Re-anchored 2026-08-10. This used to require bootstrap.ts to BUILD the four
    // board resync entries itself. It no longer does, deliberately: the standalone
    // column-parity work deleted the hand-assembled payload so both hosts read the
    // one producer, KanbanProvider.getFullStateMessages. Asserting bootstrap still
    // builds them would pin the fork that change removed — so the tag contract is
    // asserted at the producer, and bootstrap is checked only for what it still
    // builds on its own (today: the theme entry).
    const resync = block(kanbanProviderCode, 'public async getFullStateMessages(', '\n    /**');
    ['updateColumns', 'updateWorkspaceSelection', 'cliTriggersState', 'updateBoard'].forEach(type => {
        const at = resync.indexOf(`type: '${type}'`);
        assert.ok(at !== -1, `getFullStateMessages must build a '${type}' resync entry`);
        // Bound the search to this entry: the next `type: '` starts the next one, so a
        // neighbour's tag can never stand in for a missing one.
        const nextEntry = resync.indexOf("type: '", at + 7);
        const entry = resync.substring(at, nextEntry === -1 ? resync.length : nextEntry);
        assert.ok(/surface: SURFACES\.kanban/.test(entry),
            `resync entry '${type}' must be tagged — untagged, the full board snapshot ships to every panel, which is the single largest payload the filter exists for`);
    });
    assert.ok(/updateAutobanConfig[^\n]*surface: SURFACES\./.test(resync),
        'the autoban entries are spread in CONDITIONALLY — tag them as built, or a post-pass ships them untagged');
    // Anything bootstrap still assembles by hand must carry a tag too.
    bootstrapCode.split('\n')
        .filter(l => /^\s*(?:const \w+ = )?\{ type: '/.test(l))
        .forEach(l => assert.ok(l.includes('surface: SURFACES.'),
            `bootstrap.ts builds an untagged resync entry: ${l.trim()}`));
});

test('producers use the shared constant, not string literals', () => {
    assert.ok(bootstrapCode.includes("import { SURFACES } from '../services/wsHub'"),
        'a mis-tag is a silent functional bug with no type-level protection, so the vocabulary must be a shared import');
    const literalTagged = bootstrapCode.match(/broadcastWs\([^)]*,\s*'(kanban|terminals|common|planning|design|setup|memo)'\s*\)/g) || [];
    assert.deepStrictEqual(literalTagged, [], `bootstrap.ts must not spell a surface as a literal: ${literalTagged.join(', ')}`);
});

console.log(`\nResults: ${passed} passed, ${failed} failed.`);
if (failed > 0) { process.exit(1); }
