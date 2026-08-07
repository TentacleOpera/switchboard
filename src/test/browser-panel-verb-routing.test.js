'use strict';

/**
 * Contract: every verb a browser panel posts must be reachable on that panel's
 * HTTP route. The two original offenders were `improvePlan` and `webviewReady`
 * in project.js, both rejected by the PLANNING_VERBS guard and rendered as a red
 * banner on every project-panel open.
 *
 * (browser-project-panel-verbs-rejected-by-planning-allowlist.md)
 *
 * Route-accurate guard: parses each panel's outbound vscode.postMessage({type:…})
 * calls and asserts the verb is reachable on that panel's route (allowlist
 * membership OR a documented pre-guard delegation). Excludes iframe messages
 * (contentWindow.postMessage / window.parent.postMessage). Run with:
 *   node src/test/browser-panel-verb-routing.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const WEBVIEW_DIR = path.join(REPO_ROOT, 'src', 'webview');
const ALLOWLIST_PATH = path.join(REPO_ROOT, 'src', 'generated', 'verbAllowlist.ts');
const PLANNING_PROVIDER_PATH = path.join(REPO_ROOT, 'src', 'services', 'PlanningPanelProvider.ts');

const allowlistSource = fs.readFileSync(ALLOWLIST_PATH, 'utf8');
const planningProviderSource = fs.readFileSync(PLANNING_PROVIDER_PATH, 'utf8');

let passed = 0;
let failed = 0;

function test(name, fn) {
    try {
        fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (error) {
        console.error(`  FAIL ${name}: ${error.message}`);
        failed++;
    }
}

/** Parse a `export const NAME: Set<string> = new Set([...])` literal into a real Set. */
function parseSet(name) {
    const re = new RegExp(`export\\s+const\\s+${name}\\s*:\\s*Set<string>\\s*=\\s*new\\s+Set\\(\\[([^\\]]*)\\]\\)`);
    const m = re.exec(allowlistSource);
    if (!m) { throw new Error(`Allowlist ${name} not found in verbAllowlist.ts`); }
    const verbs = m[1].match(/'([^']+)'/g) || [];
    return new Set(verbs.map(v => v.slice(1, -1)));
}

const PLANNING_VERBS = parseSet('PLANNING_VERBS');
const KANBAN_VERBS = parseSet('KANBAN_VERBS');
const TICKETS_VERBS = parseSet('TICKETS_VERBS');
const DESIGN_VERBS = parseSet('DESIGN_VERBS');
const SETUP_VERBS = parseSet('SETUP_VERBS');
const TASKVIEWER_VERBS = parseSet('TASKVIEWER_VERBS');

/**
 * Extract every `vscode.postMessage({ type: 'X' … })` verb from a source string.
 * Excludes iframe messages: contentWindow.postMessage / window.parent.postMessage.
 */
function extractPostedVerbs(source) {
    const verbs = new Set();
    // Match vscode.postMessage({ type: 'X' or vscode.postMessage({type:'X'
    const re = /vscode\.postMessage\(\s*\{\s*type\s*:\s*'([^']+)'/g;
    let m;
    while ((m = re.exec(source)) !== null) {
        // Guard against a preceding contentWindow. / window.parent. (iframe messages).
        const prefix = source.slice(Math.max(0, m.index - 40), m.index);
        if (/contentWindow\s*\.\s*$/.test(prefix)) { continue; }
        if (/window\.parent\s*\.\s*$/.test(prefix)) { continue; }
        verbs.add(m[1]);
    }
    return verbs;
}

function readWebview(file) {
    return fs.readFileSync(path.join(WEBVIEW_DIR, file), 'utf8');
}

function run() {
    console.log('\n── Browser panel verb routing contract ──\n');

    // --- the two specific offenders the plan called out -------------------
    test('webviewReady is catalogued in PLANNING_VERBS (no more red banner on project open)', () => {
        assert.ok(PLANNING_VERBS.has('webviewReady'),
            "webviewReady must be in PLANNING_VERBS so POST /project/verb/webviewReady returns 200, not 500.");
    });

    test('improvePlan is delegated pre-guard to KanbanProvider (not adopted into PLANNING_VERBS)', () => {
        // The delegation arm must sit BEFORE the PLANNING_VERBS guard.
        const delegIdx = planningProviderSource.indexOf("if (verb === 'improvePlan')");
        const guardIdx = planningProviderSource.indexOf("if (!PLANNING_VERBS.has(verb))");
        assert.ok(delegIdx >= 0, "improvePlan pre-guard delegation arm must exist.");
        assert.ok(guardIdx >= 0, "PLANNING_VERBS guard must exist.");
        assert.ok(delegIdx < guardIdx,
            "improvePlan delegation MUST sit before the PLANNING_VERBS guard (else it is rejected).");
        // improvePlan must NOT be in PLANNING_VERBS — adding it there swaps a loud error for a silent no-op.
        assert.ok(!PLANNING_VERBS.has('improvePlan'),
            "improvePlan must NOT be in PLANNING_VERBS (it is delegated, not adopted — adopting it reaches a _handleMessage with no case).");
        // The delegation returns the provider result verbatim (so `prompt` survives to the browser clipboard).
        const region = planningProviderSource.slice(delegIdx, delegIdx + 400);
        assert.match(region, /return\s+this\._kanbanProvider\.handleServiceVerb\(\s*verb,\s*payload\s*\)/,
            "improvePlan delegation must return KanbanProvider's result verbatim (carries `prompt` for the browser clipboard).");
        assert.match(region, /throw\s+new\s+Error\(`Verb '\$\{verb\}' requires KanbanProvider/,
            "improvePlan delegation must throw a named error when KanbanProvider is not attached (not a silent success).");
    });

    test('webviewReady HTTP path is an explicit no-op ack (not a queue flush)', () => {
        // The HTTP-originated branch must return { success: true } and NOT call
        // _flushPendingProjectMessages (that would mark the editor panel ready).
        const caseIdx = planningProviderSource.indexOf("case 'webviewReady':");
        assert.ok(caseIdx >= 0, "a case 'webviewReady' must exist in _handleMessage.");
        const region = planningProviderSource.slice(caseIdx, caseIdx + 400);
        assert.match(region, /return\s*\{\s*success:\s*true\s*\}/,
            "the HTTP webviewReady branch must return { success: true } (ack).");
        assert.doesNotMatch(region, /_flushPendingProjectMessages/,
            "the HTTP webviewReady branch must NOT flush _pendingProjectMessages (editor-only queue).");
        // The editor branch (isProject) must still flush — placed BEFORE the case.
        const editorIdx = planningProviderSource.indexOf("if (msg.type === 'webviewReady' && isProject)");
        assert.ok(editorIdx >= 0, "the editor isProject webviewReady branch must still exist.");
        const editorRegion = planningProviderSource.slice(editorIdx, editorIdx + 200);
        assert.match(editorRegion, /_flushPendingProjectMessages/,
            "the editor isProject webviewReady branch must still call _flushPendingProjectMessages.");
        assert.ok(editorIdx < caseIdx,
            "the isProject branch must precede the HTTP case 'webviewReady' so the editor handshake is not broken.");
    });

    // --- route-accurate sweep over every browser panel --------------------
    // Reachable set per route. The /project, /planning, /memo routes all land on
    // PlanningPanelProvider.handleServiceVerb, whose reachable set is
    // PLANNING_VERBS ∪ TASKVIEWER_VERBS (memo verbs are catalogued there and
    // delegated) ∪ {improvePlan} (delegated to Kanban pre-guard).
    const PLANNING_ROUTE = new Set([
        ...PLANNING_VERBS, ...TASKVIEWER_VERBS, 'improvePlan'
    ]);
    // Known vestigial cluster: planning.js still posts 13 tickets-family verbs
    // (refreshTicketsDelta, loadTicketMembers, …) left over from before the
    // tickets surface moved to its own panel. The plan's §3 says to verify
    // reachability in-browser then DELETE them (or add a TICKETS_VERBS
    // delegation arm if any proves live). That browser UAT was not run, so they
    // are tracked here as a documented pending-deletion exception — the routing
    // guard still catches any NEW offender, and these are pre-existing, not
    // introduced by this feature.
    const PLANNING_VESTIGIAL_TICKETS = new Set([
        'refreshTicketsDelta', 'loadTicketMembers', 'loadTicketAssignees',
        'listLocalTicketFiles', 'readLocalTicketFile', 'ticketAttachImage',
        'ticketsDefaultRoot', 'ticketsRootChanged', 'getTicketSyncStatuses',
        'clickupUpdateTaskAssignees', 'clickupUpdateTaskPriority',
        'linearUpdateIssueAssignee', 'linearUpdateIssuePriority'
    ]);
    const PLANNING_ROUTE_WITH_VESTIGIAL = new Set([
        ...PLANNING_ROUTE, ...PLANNING_VESTIGIAL_TICKETS
    ]);
    const panels = [
        { file: 'project.js', reachable: PLANNING_ROUTE },
        { file: 'planning.js', reachable: PLANNING_ROUTE_WITH_VESTIGIAL },
        { file: 'memo.js', reachable: PLANNING_ROUTE },
        { file: 'tickets.js', reachable: TICKETS_VERBS },
        { file: 'design.js', reachable: DESIGN_VERBS },
        { file: 'connections.js', reachable: new Set([...SETUP_VERBS, ...PLANNING_VERBS]) },
    ];

    for (const p of panels) {
        test(`${p.file}: every posted vscode.postMessage verb is reachable on its route`, () => {
            const src = readWebview(p.file);
            const posted = extractPostedVerbs(src);
            assert.ok(posted.size > 0, `${p.file} must post at least one verb (else the test is vacuous).`);
            const offenders = [];
            for (const verb of posted) {
                if (!p.reachable.has(verb)) { offenders.push(verb); }
            }
            assert.strictEqual(offenders.length, 0,
                `${p.file} posts verbs not reachable on its route: ${offenders.join(', ')}.`);
        });
    }

    // kanban.html inline script → /kanban → KANBAN_VERBS.
    test('kanban.html inline script: every posted verb is in KANBAN_VERBS', () => {
        const src = readWebview('kanban.html');
        const posted = extractPostedVerbs(src);
        assert.ok(posted.size > 0, 'kanban.html must post at least one verb.');
        const offenders = [];
        for (const verb of posted) {
            if (!KANBAN_VERBS.has(verb)) { offenders.push(verb); }
        }
        assert.strictEqual(offenders.length, 0,
            `kanban.html posts verbs not in KANBAN_VERBS: ${offenders.join(', ')}.`);
    });

    // --- the guard still guards (trust boundary intact) -------------------
    test('the PLANNING_VERBS unknown-verb guard is still present and throwing', () => {
        assert.match(planningProviderSource, /if\s*\(!PLANNING_VERBS\.has\(verb\)\)\s*\{\s*throw\s+new\s+Error\(`Unknown Planning verb: '\$\{verb\}'`\)/,
            "the PLANNING_VERBS guard must still throw on unknown verbs (the network trust boundary).");
    });

    console.log(`\nResult: ${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
}

run();
