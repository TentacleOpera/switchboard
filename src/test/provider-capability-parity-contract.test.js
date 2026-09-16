'use strict';
/**
 * Provider-capability parity contract.
 *
 * `RemoteProviderCapabilities` (src/services/remote/RemoteProvider.ts) is the only
 * interface the provider seam has, and for a long time it covered only the
 * pull/push/archive half — board sync lived outside it, which is exactly why
 * "every provider stays in parity" kept landing truthfully and leaving the
 * important half asymmetric. This test is the enforcement half of the seam:
 *
 *   1. EVERY RemoteProvider implementation is enumerated. The provider list is
 *      discovered from source (`implements RemoteProvider`), not hardcoded —
 *      a new provider that is not added here fails.
 *   2. EVERY field of RemoteProviderCapabilities is enumerated. The key list is
 *      re-parsed from the interface declaration — a new capability field not
 *      added to this test fails.
 *   3. Any asymmetry must carry a TYPED exemption. 'platform-limitation' means
 *      permanently correct (the tracker cannot do it); 'not-yet-built' means a
 *      debt marker and must name the plan/feature file that removes it.
 *   4. A declared capability must DO something. The empty-stub shape — an empty
 *      collection returned with the input cursor unchanged, or a call that
 *      produces no remote write — fails. This is the check that would have
 *      caught ClickUp declaring `pull: true` over a fetchCommentDeltas stub.
 *   5. Capabilities implemented off the RemoteProvider interface (boardPush,
 *      boardRestore, automation) are checked against their backing service
 *      module: declared-true requires the implementation to resolve; an
 *      implementation that lands while the flag stays false also fails —
 *      flipping the flag and deleting the exemption is the proof of landing.
 *   6. UI honesty: the remote-config payload carries the provider's real
 *      declaration (no hardcoded `{ pull: true }`), and the webviews gate on
 *      the split flags, not on the deleted `pull` field.
 *
 * This file supersedes the per-provider capability assertions that used to live
 * in src/test/integrations/{clickup,linear,notion}/*-remote-provider.test.js —
 * one symmetric enumeration replaces three inconsistent ones (one of which
 * asserted `projectContextPush`, a field the interface never declared).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { installVsCodeMock } = require('./integrations/shared/vscode-mock');
const { loadOutModule } = require('./integrations/shared/test-harness');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'src');

let failures = 0;
function check(name, fn) {
    try {
        const r = fn();
        if (r && typeof r.then === 'function') {
            return r.then(
                () => console.log(`  ok  ${name}`),
                (err) => { failures++; console.error(`  FAIL ${name}\n       ${err.message}`); }
            );
        }
        console.log(`  ok  ${name}`);
    } catch (err) {
        failures++;
        console.error(`  FAIL ${name}\n       ${err.message}`);
    }
}

// ── The typed exemption table ────────────────────────────────────────────────
// Every asymmetry the enumeration finds must appear here, typed:
//   platform-limitation — permanently correct; the tracker cannot do it. No
//                         plan reference is allowed or needed.
//   not-yet-built       — a debt marker; `plan` must name the plan or feature
//                         file that removes it, and that file must exist.
// Removing an exemption is how a landing plan proves itself: flip the declared
// capability, land the implementation, delete the row.
const FEATURE_PARITY = '.switchboard/features/board-sync-is-a-capability-all-three-providers-implement-enf-e7e9f2f5-0d12-434d-af07-9113df6b4433.md';
const EXEMPTIONS = [
    {
        provider: 'clickup', capability: 'pullComments', kind: 'not-yet-built',
        plan: FEATURE_PARITY,
        reason: 'fetchCommentDeltas is a stub returning the input cursor; ClickUp has a comments API (ClickUpSyncService.getTaskComments) — the bus is unbuilt work',
    },
    {
        provider: 'clickup', capability: 'archive', kind: 'platform-limitation',
        reason: 'ClickUp has close/delete but no true archive — permanently correct; AutoArchiveService already honours archive:false',
    },
    {
        provider: 'clickup', capability: 'boardRestore', kind: 'not-yet-built',
        plan: '.switchboard/plans/clickup-board-restore.md',
        reason: 'no restoreFrom* orchestration — the planId anchors exist, the bulk pass does not',
    },
    {
        provider: 'linear', capability: 'boardRestore', kind: 'not-yet-built',
        plan: '.switchboard/plans/linear-board-restore-and-planid-anchor.md',
        reason: 'no planId anchor on remote objects; restore is blocked on the anchor + backfill plan',
    },
    {
        provider: 'notion', capability: 'automation', kind: 'not-yet-built',
        plan: FEATURE_PARITY,
        reason: 'no NotionAutomationService — LinearAutomationService and ClickUpAutomationService exist',
    },
    // The store-backed provider is a one-way queue (plan_inbox), not a two-way
    // tracker. Everything below is platform-limitation by design, not debt.
    { provider: 'store', capability: 'pullComments', kind: 'platform-limitation', reason: 'plan_inbox is a one-way queue — no comment channel exists' },
    { provider: 'store', capability: 'push', kind: 'platform-limitation', reason: 'the queue is an inbox, not a two-way channel' },
    { provider: 'store', capability: 'archive', kind: 'platform-limitation', reason: 'queue rows have no archive lifecycle' },
    { provider: 'store', capability: 'boardPush', kind: 'platform-limitation', reason: 'no remote board to push to' },
    { provider: 'store', capability: 'boardRestore', kind: 'platform-limitation', reason: 'no remote board to restore from' },
    { provider: 'store', capability: 'automation', kind: 'platform-limitation', reason: 'no remote rule surface to automate' },
    // Linear-only platform surfaces. Permanently correct on the other providers.
    { provider: 'clickup', capability: 'missions', kind: 'platform-limitation', reason: 'missions/dependency mirroring is a Linear concept' },
    { provider: 'notion', capability: 'missions', kind: 'platform-limitation', reason: 'missions/dependency mirroring is a Linear concept' },
    { provider: 'store', capability: 'missions', kind: 'platform-limitation', reason: 'missions/dependency mirroring is a Linear concept' },
    { provider: 'clickup', capability: 'agentSurface', kind: 'platform-limitation', reason: 'agent actor surface is Linear-only' },
    { provider: 'notion', capability: 'agentSurface', kind: 'platform-limitation', reason: 'agent actor surface is Linear-only' },
    { provider: 'store', capability: 'agentSurface', kind: 'platform-limitation', reason: 'agent actor surface is Linear-only' },
    { provider: 'clickup', capability: 'agentSessions', kind: 'platform-limitation', reason: 'agent sessions/activities are Linear-only' },
    { provider: 'notion', capability: 'agentSessions', kind: 'platform-limitation', reason: 'agent sessions/activities are Linear-only' },
    { provider: 'store', capability: 'agentSessions', kind: 'platform-limitation', reason: 'agent sessions/activities are Linear-only' },
];

// ── Evidence for capabilities that live off the RemoteProvider interface ─────
// boardPush/boardRestore/automation are realised by services, not provider
// methods. A `true` declaration must resolve to a real implementation; an
// implementation that appears while the flag stays false fails (the flag is
// the declaration — flip it and delete the exemption in the same change).
const OFF_INTERFACE_EVIDENCE = {
    boardPush: {
        notion: { module: 'services/NotionBackupService.js', cls: 'NotionBackupService', method: 'backupToNotion' },
        clickup: { module: 'services/ClickUpSyncService.js', cls: 'ClickUpSyncService', method: 'syncPlan' },
        linear: { module: 'services/LinearSyncService.js', cls: 'LinearSyncService', method: 'syncPlan' },
    },
    boardRestore: {
        notion: { module: 'services/NotionBackupService.js', cls: 'NotionBackupService', method: 'restoreFromNotion' },
        // methodPattern watches for the restore landing before the flag flips.
        clickup: { module: 'services/ClickUpSyncService.js', cls: 'ClickUpSyncService', methodPattern: /^restoreFrom/ },
        linear: { module: 'services/LinearSyncService.js', cls: 'LinearSyncService', methodPattern: /^restoreFrom/ },
    },
    automation: {
        clickup: { module: 'services/ClickUpAutomationService.js', cls: 'ClickUpAutomationService' },
        linear: { module: 'services/LinearAutomationService.js', cls: 'LinearAutomationService' },
        notion: { module: 'services/NotionAutomationService.js', cls: 'NotionAutomationService' },
    },
};

function evidenceResolves(spec) {
    try {
        const mod = loadOutModule(spec.module);
        const cls = mod[spec.cls];
        if (typeof cls !== 'function') { return false; }
        if (spec.method) { return typeof cls.prototype[spec.method] === 'function'; }
        if (spec.methodPattern) {
            return Object.getOwnPropertyNames(cls.prototype).some((n) => spec.methodPattern.test(n));
        }
        return true;
    } catch {
        return false;
    }
}

// ── Provider mocks — each must return real data so a stub cannot hide ────────

function makeRecorder() {
    const calls = [];
    return { calls, record: (name, arg) => calls.push({ name, arg }) };
}

function buildClickUp(rec) {
    const { ClickUpRemoteProvider } = loadOutModule('services/remote/ClickUpRemoteProvider.js');
    const clickup = {
        loadConfig: async () => ({ setupComplete: true, columnMappings: { CREATED: 'list-1' } }),
        getListTasks: async (listId) => [
            { id: 'task-1', name: 'Task', dateUpdated: '1770000000000', list: { id: listId } },
        ],
        getTaskDetails: async (id) => ({ task: { id, name: 'Task', markdownDescription: 'd' } }),
        syncPlan: async (plan) => { rec.record('syncPlan', plan); return { success: true }; },
        syncPlanContent: async () => ({ success: true }),
        hasApiToken: async () => true,
    };
    const db = {
        findPlanByClickUpTaskId: async () => ({ planFile: '/tmp/p.md', clickupTaskId: 'task-1', kanbanColumn: 'CREATED' }),
    };
    return new ClickUpRemoteProvider(clickup, {
        db,
        getWorkspaceId: async () => 'ws-1',
        getPlansDir: async () => '/tmp/plans',
    });
}

function buildLinear(rec) {
    const { LinearRemoteProvider } = loadOutModule('services/remote/LinearRemoteProvider.js');
    const linear = {
        loadConfig: async () => ({ setupComplete: true, columnToStateId: { CODING: 'state-1' } }),
        graphqlRequest: async (query) => {
            rec.record('graphql', query);
            if (/issues\s*\(/.test(query)) {
                return { data: { issues: { nodes: [
                    { id: 'ISSUE1', updatedAt: '2026-01-02T00:00:00.000Z', state: { id: 'state-1' } },
                ] } } };
            }
            if (/comments\s*\(/.test(query)) {
                return { data: { comments: { nodes: [
                    { id: 'c1', body: 'human comment', createdAt: '2026-01-02T00:00:00.000Z', issue: { id: 'ISSUE1' } },
                ] } } };
            }
            if (/issueUpdate/.test(query)) { return { data: { issueUpdate: { success: true } } }; }
            return { data: {} };
        },
        archiveIssue: async (id) => { rec.record('archiveIssue', id); return { success: true }; },
        hasApiToken: async () => true,
        syncPlanContent: async () => ({ success: true }),
        syncMissionsAndDependencies: async () => {},
    };
    // No getWorkspaceId dep → skips the missions side-poll; not under test here.
    return new LinearRemoteProvider(linear, {});
}

function buildNotion(rec) {
    const { NotionRemoteProvider } = loadOutModule('services/remote/NotionRemoteProvider.js');
    const notion = {
        httpRequest: async (method, apiPath, body) => {
            rec.record(`${method} ${apiPath}`, body);
            if (apiPath.includes('/databases/PDB/query')) {
                return { status: 200, data: { results: [
                    { id: 'PAGE1', last_edited_time: '2026-01-02T00:00:00.000Z', last_edited_by: { id: 'other' },
                      properties: { 'Kanban Column': { select: { name: 'CODING' } } } },
                ], has_more: false } };
            }
            if (apiPath.includes('/databases/CDB/query')) {
                return { status: 200, data: { results: [
                    { id: 'cmt1', created_time: '2026-01-02T00:00:00.000Z', created_by: { id: 'other' },
                      properties: { Plan: { relation: [{ id: 'PAGE1' }] }, Message: { title: [{ plain_text: 'hi' }] } } },
                ], has_more: false } };
            }
            return { status: 200, data: { id: 'PAGE1' } };
        },
        getBotId: async () => 'bot-1',
        fetchPageMarkdown: async () => ({ markdown: '# body', truncated: false, lastEditedTime: '2026-01-02T00:00:00.000Z' }),
        fetchBlocksRecursive: async () => [],
        convertBlocksToMarkdown: () => '# body',
        postManagedComment: async () => ({ success: true }),
    };
    const db = {
        getConfig: async (key) => key === 'remote.notion.setup'
            ? JSON.stringify({ plansDatabaseId: 'PDB', commentsDatabaseId: 'CDB', botId: 'bot-1' })
            : null,
        findPlanByNotionPageId: async () => null,
    };
    return new NotionRemoteProvider({ notion, db, getWorkspaceId: async () => 'ws-1' });
}

function buildStore(rec) {
    const { StoreRemoteProvider } = loadOutModule('services/StoreRemoteProvider.js');
    const db = {
        execSql: () => {},
        querySql: (sql) => {
            if (/status\s*=\s*'pending'/.test(sql) && /created_at\s*>/.test(sql)) {
                return [{ id: 'row-1', workspace_id: 'ws-1', title: 'T', body: 'B', provenance: '', created_at: '2026-01-02T00:00:00.000Z' }];
            }
            return [];
        },
        runSql: (...args) => { rec.record('runSql', args); },
    };
    return new StoreRemoteProvider({ db, workspaceRoot: '/tmp/store-ws' });
}

const PROVIDERS = {
    clickup: { className: 'ClickUpRemoteProvider', module: 'services/remote/ClickUpRemoteProvider.js', build: buildClickUp },
    linear: { className: 'LinearRemoteProvider', module: 'services/remote/LinearRemoteProvider.js', build: buildLinear },
    notion: { className: 'NotionRemoteProvider', module: 'services/remote/NotionRemoteProvider.js', build: buildNotion },
    store: { className: 'StoreRemoteProvider', module: 'services/StoreRemoteProvider.js', build: buildStore },
};

// ── Source-derived surfaces ──────────────────────────────────────────────────

function walkTs(dir, out = []) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') { continue; }
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) { walkTs(p, out); }
        else if (entry.name.endsWith('.ts')) { out.push(p); }
    }
    return out;
}

/** Field names declared on RemoteProviderCapabilities, parsed from source. */
function declaredCapabilityFields() {
    const src = fs.readFileSync(path.join(SRC, 'services', 'remote', 'RemoteProvider.ts'), 'utf8');
    const block = src.match(/export interface RemoteProviderCapabilities\s*\{([\s\S]*?)\n\}/);
    assert.ok(block, 'RemoteProviderCapabilities interface not found in RemoteProvider.ts');
    const fields = [];
    const re = /(\w+)(\?)?\s*:\s*boolean/g;
    let m;
    while ((m = re.exec(block[1]))) {
        fields.push({ name: m[1], optional: m[2] === '?' });
    }
    return fields;
}

/** Every class that declares `implements RemoteProvider` in src/. */
function discoverProviderClasses() {
    const found = new Set();
    for (const file of walkTs(SRC)) {
        const text = fs.readFileSync(file, 'utf8');
        const re = /class\s+(\w+)\s+implements\s+RemoteProvider\b/g;
        let m;
        while ((m = re.exec(text))) { found.add(m[1]); }
    }
    return found;
}

function readSrc(rel) {
    return fs.readFileSync(path.join(SRC, rel), 'utf8');
}

// ── Run ──────────────────────────────────────────────────────────────────────

async function run() {
    installVsCodeMock();

    // 1. Every RemoteProvider implementation is enumerated.
    check('every `implements RemoteProvider` class is enumerated', () => {
        const discovered = discoverProviderClasses();
        const enumerated = new Set(Object.values(PROVIDERS).map((p) => p.className));
        const missing = [...discovered].filter((c) => !enumerated.has(c));
        const stale = [...enumerated].filter((c) => !discovered.has(c));
        assert.deepStrictEqual([...missing, ...stale], [],
            `provider enumeration drift — missing from test: [${missing}], stale entries: [${stale}]. ` +
            `Add the new provider to PROVIDERS (with a mock) and declare its capabilities.`);
    });

    // 2. Every interface field is enumerated (a new field must be added here).
    const fields = declaredCapabilityFields();
    check('the capability field list matches the interface declaration', () => {
        const names = fields.map((f) => f.name).sort();
        assert.ok(names.length >= 7, `expected ≥7 capability fields, parsed ${names.length}`);
        // If the interface gains a field, this snapshot must be updated — that
        // diff IS the point: a capability cannot slip in unenumerated.
        assert.deepStrictEqual(names, [
            'agentSessions', 'agentSurface', 'archive', 'automation',
            'boardPush', 'boardRestore', 'missions', 'pullComments', 'pullState', 'push',
        ], 'RemoteProviderCapabilities gained or lost a field — update the enumeration');
    });

    // Build every provider once; reuse for all checks.
    const built = {};
    for (const [kind, spec] of Object.entries(PROVIDERS)) {
        const rec = makeRecorder();
        built[kind] = { provider: spec.build(rec), rec, spec };
    }

    // 3. Declared values are booleans; no phantom fields; optional fields honest.
    for (const [kind, { provider }] of Object.entries(built)) {
        check(`${kind}: capabilities object is honest (booleans only, no phantom fields)`, () => {
            const caps = provider.capabilities;
            assert.ok(caps && typeof caps === 'object', `${kind} has no capabilities object`);
            const known = new Set(fields.map((f) => f.name));
            for (const key of Object.keys(caps)) {
                assert.ok(known.has(key), `${kind} declares phantom capability '${key}' — not in RemoteProviderCapabilities`);
                assert.strictEqual(typeof caps[key], 'boolean', `${kind}.capabilities.${key} must be a boolean`);
            }
            for (const f of fields) {
                if (!f.optional) {
                    assert.strictEqual(typeof caps[f.name], 'boolean',
                        `${kind} must declare required capability '${f.name}' — absence reads as "never asked"`);
                }
            }
        });
    }

    // 4. Symmetry: mixed values across providers require typed exemptions.
    check('every asymmetry carries a typed exemption (and no stale exemptions survive)', () => {
        const exemptionKey = (e) => `${e.provider}:${e.capability}`;
        const table = new Map(EXEMPTIONS.map((e) => [exemptionKey(e), e]));
        const problems = [];

        // Validate the exemption rows themselves.
        for (const e of EXEMPTIONS) {
            assert.ok(PROVIDERS[e.provider], `exemption names unknown provider '${e.provider}'`);
            assert.ok(fields.some((f) => f.name === e.capability), `exemption names unknown capability '${e.capability}'`);
            assert.ok(e.kind === 'platform-limitation' || e.kind === 'not-yet-built',
                `exemption ${exemptionKey(e)} has untyped kind '${e.kind}'`);
            assert.ok(typeof e.reason === 'string' && e.reason.length > 0,
                `exemption ${exemptionKey(e)} needs a reason`);
            if (e.kind === 'not-yet-built') {
                assert.ok(typeof e.plan === 'string' && e.plan.length > 0,
                    `not-yet-built exemption ${exemptionKey(e)} must name the plan that removes it`);
                assert.ok(fs.existsSync(path.join(ROOT, e.plan)),
                    `not-yet-built exemption ${exemptionKey(e)} names a plan file that does not exist: ${e.plan}`);
            }
            if (e.kind === 'platform-limitation') {
                assert.ok(!('plan' in e),
                    `platform-limitation exemption ${exemptionKey(e)} must not carry a plan reference — it is permanent`);
            }
        }

        for (const f of fields) {
            const values = Object.entries(built).map(([kind, b]) => [kind, b.provider.capabilities[f.name] === true]);
            const trues = values.filter(([, v]) => v).map(([k]) => k);
            const falses = values.filter(([, v]) => !v).map(([k]) => k);
            if (trues.length === 0 || falses.length === 0) { continue; } // symmetric
            for (const kind of falses) {
                const e = table.get(`${kind}:${f.name}`);
                if (!e) {
                    problems.push(`undeclared asymmetry: '${f.name}' is true for [${trues}] but false/absent for '${kind}' with no exemption`);
                }
            }
        }

        // Stale exemptions: provider actually has the capability, or the
        // capability is uniformly absent (exemption against nothing).
        for (const e of EXEMPTIONS) {
            const caps = built[e.provider].provider.capabilities;
            if (caps[e.capability] === true) {
                problems.push(`stale exemption: ${exemptionKey(e)} is declared but ${e.provider}.${e.capability} is true — delete the exemption, it landed`);
                continue;
            }
            const anyTrue = Object.values(built).some((b) => b.provider.capabilities[e.capability] === true);
            if (!anyTrue) {
                problems.push(`stale exemption: ${exemptionKey(e)} — no provider declares '${e.capability}' at all`);
            }
        }

        assert.deepStrictEqual(problems, [], problems.join('\n'));
    });

    // 5. Stub detection — a declared capability must do something, and a
    //    non-declared one must not silently do it anyway.
    const STUB_CHECK_METHODS = {
        pullState: { call: (p) => p.fetchStateDeltas('2026-01-01T00:00:00.000Z'), isEmpty: (r) => r.deltas.length === 0 && r.nextCursor === '2026-01-01T00:00:00.000Z' },
        pullComments: { call: (p) => p.fetchCommentDeltas('2026-01-01T00:00:00.000Z'), isEmpty: (r) => r.deltas.length === 0 && r.nextCursor === '2026-01-01T00:00:00.000Z' },
    };
    for (const [cap, probe] of Object.entries(STUB_CHECK_METHODS)) {
        for (const [kind, b] of Object.entries(built)) {
            await check(`${kind}: ${cap} declaration matches the implementation`, async () => {
                const res = await probe.call(b.provider);
                const empty = probe.isEmpty(res);
                if (b.provider.capabilities[cap] === true) {
                    assert.ok(!empty,
                        `${kind} declares ${cap}: true but returned the empty-stub shape (empty deltas, cursor unchanged) — the asymmetry hides inside a true`);
                } else {
                    assert.ok(empty,
                        `${kind} declares ${cap}: false but returned deltas — the capability exists undeclared; flip the flag and delete the exemption`);
                }
            });
        }
    }

    // push: declared-true must produce a remote write; declared-false must not.
    for (const [kind, b] of Object.entries(built)) {
        await check(`${kind}: push declaration matches the implementation`, async () => {
            const before = b.rec.calls.length;
            await b.provider.pushState('probe-id', 'CODING');
            const wrote = b.rec.calls.length > before;
            if (b.provider.capabilities.push === true) {
                assert.ok(wrote, `${kind} declares push: true but pushState produced no remote call — stub behind a true`);
            } else {
                assert.ok(!wrote, `${kind} declares push: false but pushState wrote to the remote — undeclared capability`);
            }
        });
    }

    // archive: same shape — a write when declared, none when not.
    for (const [kind, b] of Object.entries(built)) {
        await check(`${kind}: archive declaration matches the implementation`, async () => {
            const before = b.rec.calls.length;
            const res = await b.provider.archiveCard('probe-id');
            const wrote = b.rec.calls.length > before;
            if (b.provider.capabilities.archive === true) {
                assert.ok(wrote || res.ok === true,
                    `${kind} declares archive: true but archiveCard produced no remote call and no ok result — stub behind a true`);
            } else {
                assert.ok(!wrote, `${kind} declares archive: false but archiveCard wrote to the remote — undeclared capability`);
            }
        });
    }

    // 6. Off-interface capabilities: boardPush / boardRestore / automation.
    for (const [cap, byProvider] of Object.entries(OFF_INTERFACE_EVIDENCE)) {
        for (const [kind, b] of Object.entries(built)) {
            check(`${kind}: ${cap} declaration matches the service surface`, () => {
                const spec = byProvider[kind];
                const declared = b.provider.capabilities[cap] === true;
                const resolves = spec ? evidenceResolves(spec) : false;
                if (declared) {
                    assert.ok(resolves,
                        `${kind} declares ${cap}: true but ${spec ? spec.module + '#' + (spec.method || spec.cls) : 'no evidence spec'} does not resolve — stub behind a true`);
                } else if (resolves) {
                    assert.fail(`${kind} declares ${cap}: false but the implementation exists (${spec.module}) — flip the flag and delete the exemption`);
                }
            });
        }
    }

    // 7. Research adapters: all three trackers have one — this is parity, and
    //    it must never need an exemption (a false-premise exemption was seeded
    //    for Notion once; NotionResearchAdapter exists).
    check('every tracker provider has a research adapter (no exemption belongs here)', () => {
        assert.ok(typeof loadOutModule('services/LinearDocsAdapter.js').LinearDocsAdapter === 'function', 'LinearDocsAdapter missing');
        assert.ok(typeof loadOutModule('services/ClickUpDocsAdapter.js').ClickUpDocsAdapter === 'function', 'ClickUpDocsAdapter missing');
        assert.ok(typeof loadOutModule('services/ResearchImportService.js').NotionResearchAdapter === 'function', 'NotionResearchAdapter missing');
        assert.ok(!EXEMPTIONS.some((e) => /research/i.test(e.capability || '') || /ResearchAdapter|DocsAdapter/i.test(e.reason || '')),
            'a research-adapter exemption exists — all three providers have one; remove it');
    });

    // 8. UI honesty — the payload carries the provider's real declaration, and
    //    the webviews gate on the split flags. No hardcoded capability literal.
    check('the remote-config payload reads capabilities from the provider, not a literal', () => {
        const src = readSrc('services/KanbanProvider.ts');
        const fn = src.match(/_buildRemoteConfigPayload[\s\S]*?const capabilities\s*=\s*([^;]+);/);
        assert.ok(fn, '_buildRemoteConfigPayload must assign `capabilities`');
        assert.ok(/_buildRemoteProvider\([\s\S]*?\.capabilities/.test(fn[1]),
            'the payload capabilities must come from the built provider — a hardcoded literal is how the ClickUp pull flag went stale');
        assert.ok(!/capabilities\s*=\s*\{\s*pull:/.test(src), 'hardcoded { pull: ... } capabilities literal found');
    });

    check('the webviews gate on pullState/pullComments, never on the deleted pull flag', () => {
        for (const rel of ['webview/connections.js', 'webview/linear.js']) {
            const src = readSrc(rel);
            assert.ok(/caps\.pullState/.test(src), `${rel} must gate pull modes on caps.pullState`);
            assert.ok(/caps\.pullComments/.test(src), `${rel} must gate the comments toggle on caps.pullComments`);
            assert.ok(!/caps\.pull\b/.test(src), `${rel} still reads the deleted caps.pull flag`);
        }
    });

    const SELF = path.basename(__filename);
    const scanSrc = (exts) => {
        const files = [];
        const walk = (dir) => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out' || entry.name === '.git') { continue; }
                const p = path.join(dir, entry.name);
                if (entry.isDirectory()) { walk(p); }
                else if (entry.name !== SELF && exts.some((e) => entry.name.endsWith(e))) { files.push(p); }
            }
        };
        walk(SRC);
        return files;
    };

    check('the deleted pull flag is read by nothing in src/', () => {
        const offenders = [];
        for (const file of scanSrc(['.ts', '.js'])) {
            const text = fs.readFileSync(file, 'utf8');
            if (/capabilities\.pull\b/.test(text) || /caps\.pull\b/.test(text)) {
                offenders.push(path.relative(ROOT, file));
            }
        }
        assert.deepStrictEqual(offenders, [], `the deleted 'pull' flag is still read: ${offenders.join(', ')}`);
    });

    check('the phantom projectContextPush field is gone everywhere', () => {
        const offenders = [];
        for (const file of scanSrc(['.ts', '.js', '.html'])) {
            if (fs.readFileSync(file, 'utf8').includes('projectContextPush')) {
                offenders.push(path.relative(ROOT, file));
            }
        }
        assert.deepStrictEqual(offenders, [], `phantom capability still referenced: ${offenders.join(', ')}`);
    });

    if (failures > 0) {
        console.error(`\n${failures} provider-capability contract check(s) failed`);
        process.exit(1);
    }
    console.log('provider-capability parity contract passed');
}

run().catch((err) => { console.error(err); process.exit(1); });
