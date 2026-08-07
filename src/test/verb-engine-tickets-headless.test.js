'use strict';

/**
 * Verb Engine · Layer-1 — TicketsProvider headless seam tests.
 *
 * Drives migrated TicketsProvider arms end-to-end through the generic
 * `handleServiceVerb` dispatcher under a BOOBY-TRAPPED vscode module (any
 * property access throws) and an in-memory HostSeams bundle. A passing run
 * proves the migrated arms execute with no vscode reachable, return their
 * results (the HTTP body contract), and keep the webview push additive.
 *
 * Slice 2c moved 8 ticket-file/sync verbs here from PlanningPanelProvider;
 * the two return-contract assertions below (getTicketSyncStatuses,
 * readLocalTicketFile) were stranded in the planning suite when their verbs
 * left PLANNING_VERBS and now live here.
 *
 * Run with:
 *   npm run compile-tests && node src/test/verb-engine-tickets-headless.test.js
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { installVscodeTrap, createHeadlessTestSeams, createFakeStateStore } = require('./helpers/verbEngineTestSeams');

// Install the trap BEFORE any out/services module loads.
installVscodeTrap();

const { TicketsPanelProvider } = require('../../out/services/TicketsPanelProvider');
const { BroadcastHub } = require('../../out/services/broadcastHub');
const { validateVerbPayload } = require('../../out/services/verbSchemas');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}`);
        console.error(e && e.stack ? e.stack : e);
        failed++;
    }
}

/** Build a TicketsPanelProvider wired for headless execution against a temp workspace. */
function buildHeadlessTicketsProvider(tmpRoot, seamOpts = {}) {
    const { seams, recorders } = createHeadlessTestSeams({ roots: [tmpRoot], ...seamOpts });
    const stateStore = createFakeStateStore();
    const pushes = [];
    const fakeWebview = {
        postMessage: (msg) => {
            pushes.push(msg);
            return Promise.resolve(true);
        },
    };

    const dummyUri = { fsPath: path.join(tmpRoot, 'ext') };
    const dummyContext = {
        secrets: null,
        globalState: {
            get: (_key, dflt) => dflt,
            update: async () => {},
        },
    };
    const dummyFactories = {
        getLinearSyncService: () => ({}),
        getClickUpSyncService: () => ({}),
        getCacheService: () => ({}),
    };

    const provider = new TicketsPanelProvider(
        dummyUri,
        dummyContext,
        stateStore,
        undefined,
        dummyFactories
    );

    // Test-seam injection
    // The ClickUp/Linear config arms relocated from Setup in plan 4 delegate to
    // TaskViewer through a non-null-asserted `_taskViewerProvider`, so the harness
    // must supply one or they throw before reaching the behaviour under test.
    provider._taskViewerProvider = {
        handleApplyClickUpConfig: async (token) => ({ success: true, tokenReceived: !!token }),
        handleApplyLinearConfig: async (token) => ({ success: true, tokenReceived: !!token }),
        handleSaveClickUpMappings: async () => ({ success: true }),
        handleSaveClickUpAutomation: async () => ({ success: true }),
        handleSaveLinearAutomation: async () => ({ success: true }),
        getIntegrationSetupStates: async () => ({ clickup: {}, linear: {}, notion: {} }),
        postSetupPanelState: async () => {},
    };
    provider._hostSeams = seams;
    provider._broadcaster = new BroadcastHub({ webview: fakeWebview, apiServer: null });
    // Override vscode-dependent root accessors so the trap is never reached.
    provider._getWorkspaceRoots = () => [tmpRoot];
    provider._getWorkspaceRoot = () => tmpRoot;
    return { provider, seams, recorders, stateStore, pushes };
}

async function main() {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-verb-engine-tickets-'));

    console.log('\n=== Verb Engine · Layer-1 — TicketsProvider headless seam tests ===\n');

    // ── Dispatch contract & Schema validation ──────────────────────────────

    await test('Tickets: unknown verb is rejected by allowlist', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('notARealTicketsVerb', {}),
            /Unknown Tickets verb/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (saveLocalTicketFile missing id)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('saveLocalTicketFile', { workspaceRoot: tmpRoot, provider: 'clickup' }),
            /Invalid payload for Tickets verb 'saveLocalTicketFile'.*id/
        );
    });

    // ── 2c return-contract assertions (moved from planning suite) ───────────

    await test('getTicketSyncStatuses RETURNS success:false in-body when ids missing', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        const result = await provider.handleServiceVerb('getTicketSyncStatuses', { workspaceRoot: tmpRoot, provider: 'clickup' });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.type, 'ticketSyncStatusesLoaded');
        assert.ok(/Missing workspaceRoot or ids/.test(result.error));
    });

    await test('readLocalTicketFile RETURNS success:false in-body when file not found', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        const result = await provider.handleServiceVerb('readLocalTicketFile', { workspaceRoot: tmpRoot, provider: 'clickup', id: 'nonexistent' });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.type, 'localTicketFileRead');
    });

    // ── 2b stranded assertions (verbs moved in 2b, tests moved here in 2c) ──

    await test('listTicketsFolders RETURNS in-body paths and keeps push additive', async () => {
        const { provider, pushes } = buildHeadlessTicketsProvider(tmpRoot);
        const result = await provider.handleServiceVerb('listTicketsFolders', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.paths));
        assert.strictEqual(result.type, 'ticketsFoldersListed');
        const push = pushes.find(p => p.type === 'ticketsFoldersListed');
        assert.ok(push, 'webview push emitted');
    });

    await test('browseTicketsFolder RETURNS in-body success with null path headless (no dialog)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        const result = await provider.handleServiceVerb('browseTicketsFolder', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.path, null);
        assert.strictEqual(result.type, 'browseTicketsFolderResult');
    });

    await test('Tickets: schema validation rejects malformed payload (removeTicketsFolder missing folderPath)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('removeTicketsFolder', { workspaceRoot: tmpRoot }),
            /Invalid payload for Tickets verb 'removeTicketsFolder'.*folderPath/
        );
    });

    // ── 2b stranded: no-workspace in-body failure ───────────────────────────
    // These two were deleted from the planning suite when their verbs moved, with
    // comments claiming they had been migrated here — they had not. Restored.
    //
    // The assertion is ADAPTED, not weakened. Planning had a GLOBAL
    // `allRoots.length === 0` guard ahead of its switch that returned a flat
    // `{ success:false, error:'No workspace open' }`, so the old test asserted that
    // shape. TicketsPanelProvider has no global guard: each arm guards itself and
    // returns its own typed payload plus `success:false`. The contract worth pinning
    // is unchanged and is what both versions exist for — the verb fails IN-BODY
    // rather than throwing across the HTTP boundary, where a throw becomes a 500
    // with no structured error for the webview to render.
    //
    // Reaching the guard needs care: `_resolveWorkspaceRoot` returns `givenRoot`
    // verbatim when one is supplied — even an unknown path — so passing a bogus
    // root does NOT trip it. The guard fires only with no root supplied and no
    // workspace open, so these call with neither and null the root accessor.

    function buildNoWorkspaceTicketsProvider() {
        const built = buildHeadlessTicketsProvider(tmpRoot, { roots: [] });
        built.provider._getWorkspaceRoots = () => [];
        built.provider._getWorkspaceRoot = () => null;
        return built;
    }

    await test('linearLoadProject RETURNS success:false in-body when no workspace is open', async () => {
        const { provider } = buildNoWorkspaceTicketsProvider();
        const result = await provider.handleServiceVerb('linearLoadProject', {});
        assert.strictEqual(result.success, false, 'linearLoadProject must fail in-body, not throw');
        assert.strictEqual(result.type, 'linearProjectLoaded');
        assert.strictEqual(result.status, 'error');
        assert.match(result.message, /No workspace open/);
    });

    await test('clickupLoadSpaces RETURNS success:false in-body when no workspace is open', async () => {
        const { provider } = buildNoWorkspaceTicketsProvider();
        const result = await provider.handleServiceVerb('clickupLoadSpaces', {});
        assert.strictEqual(result.success, false, 'clickupLoadSpaces must fail in-body, not throw');
        assert.strictEqual(result.type, 'clickupError');
        assert.match(result.error, /No workspace folder found/);
    });

    // ── 2f: importAllTickets moved from PlanningPanelProvider. The no-workspace
    //    guard returns `{ success:false, error:'No workspace root resolved' }`
    //    in-body (the arm-level guard, not a global pre-switch guard — Tickets
    //    has none). The verb must fail in-body, not throw across the HTTP boundary. ──
    await test('importAllTickets RETURNS success:false in-body when no workspace is open', async () => {
        const { provider } = buildNoWorkspaceTicketsProvider();
        const result = await provider.handleServiceVerb('importAllTickets', { provider: 'clickup', importMode: 'document' });
        assert.strictEqual(result.success, false, 'importAllTickets must fail in-body, not throw');
        assert.match(result.error, /No workspace root resolved/);
    });

    // The other half of the same behaviour, and the third assertion dropped in 2b.
    // An unknown explicit root must NOT be treated as "no workspace": Tickets'
    // `_resolveWorkspaceRoot` returns a supplied root verbatim when it matches no
    // open folder, so the guard stays unreached. Without this, the two tests above
    // become indistinguishable from the fallback path if `_resolveWorkspaceRoot` is
    // ever tightened — they would pass for the wrong reason.
    await test('an unknown explicit workspaceRoot does not trip the no-workspace guard', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        let result;
        try {
            result = await provider.handleServiceVerb('clickupLoadSpaces', { workspaceRoot: '/not/a/real/root' });
        } catch {
            // Reaching the adapter stub and throwing means it got past the guard,
            // which is exactly what this asserts.
            return;
        }
        assert.notStrictEqual(
            result?.error, 'No workspace folder found',
            'unknown explicit root must be used verbatim, not trip the no-workspace guard'
        );
    });

    // ── 2c stranded assertions (verbs moved in 2c, tests migrated here) ─────
    // Bodies preserved verbatim from the planning suite; only the provider under
    // test and the provider name in the expected error changed.

    await test('importTicketSubtasks RETURNS in-body enriched:false when params missing (no vscode reached)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        const result = await provider.handleServiceVerb('importTicketSubtasks', { workspaceRoot: tmpRoot });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.enriched, false);
        assert.strictEqual(result.reason, 'missing-params');
    });

    await test('fetchMoveTargets RETURNS success:false in-body when workspace not resolved', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        const result = await provider.handleServiceVerb('fetchMoveTargets', { workspaceRoot: '/not/a/real/root', provider: 'clickup', ticketId: 't1' });
        assert.strictEqual(result.success, false);
        assert.strictEqual(result.type, 'moveTargetsResult');
        assert.ok(Array.isArray(result.targets));
    });

    await test('Tickets: schema validation rejects malformed payload (moveTicket missing ticketId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('moveTicket', { provider: 'clickup', targetId: 'lst1' }),
            /Invalid payload for Tickets verb 'moveTicket'.*ticketId/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (changeTicketStatus missing statusId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('changeTicketStatus', { provider: 'clickup', id: 't1' }),
            /Invalid payload for Tickets verb 'changeTicketStatus'.*statusId/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (deleteTicketConfirmed missing id)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('deleteTicketConfirmed', { provider: 'clickup' }),
            /Invalid payload for Tickets verb 'deleteTicketConfirmed'.*id/
        );
    });

    // ── 2d: schema validation for verbs moved from PLANNING_VERB_SCHEMAS ──

    await test('Tickets: schema validation rejects malformed payload (editTicket missing id)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('editTicket', { provider: 'clickup' }),
            /Invalid payload for Tickets verb 'editTicket'.*id/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (pushTicket missing id)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('pushTicket', { provider: 'clickup' }),
            /Invalid payload for Tickets verb 'pushTicket'.*id/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (convertToSubtask missing parentId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('convertToSubtask', { provider: 'clickup', taskId: 't1' }),
            /Invalid payload for Tickets verb 'convertToSubtask'.*parentId/
        );
    });

    // The schema must match what the webview posts and the handler reads
    // (provider/taskId/parentId). It previously demanded the kanban feature
    // verbs' session ids, so every "To subtask" click failed validation with an
    // error naming subtaskSessionId and never reached the arm.
    await test('Tickets: convertToSubtask accepts the provider/taskId/parentId payload the panel sends', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.doesNotReject(
            () => provider.handleServiceVerb('convertToSubtask', {
                provider: 'clickup', taskId: 't1', parentId: 'p1', workspaceRoot: tmpRoot
            })
        );
    });

    await test('Tickets: schema validation rejects malformed payload (clickupUpdateTaskAssignees missing taskId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('clickupUpdateTaskAssignees', { workspaceRoot: tmpRoot }),
            /Invalid payload for Tickets verb 'clickupUpdateTaskAssignees'.*taskId/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (clickupUpdateTaskPriority missing taskId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('clickupUpdateTaskPriority', { workspaceRoot: tmpRoot }),
            /Invalid payload for Tickets verb 'clickupUpdateTaskPriority'.*taskId/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (clickupUpdateTaskTags missing taskId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('clickupUpdateTaskTags', { workspaceRoot: tmpRoot }),
            /Invalid payload for Tickets verb 'clickupUpdateTaskTags'.*taskId/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (linearUpdateIssueAssignee missing issueId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('linearUpdateIssueAssignee', { workspaceRoot: tmpRoot }),
            /Invalid payload for Tickets verb 'linearUpdateIssueAssignee'.*issueId/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (linearUpdateIssuePriority missing issueId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('linearUpdateIssuePriority', { workspaceRoot: tmpRoot }),
            /Invalid payload for Tickets verb 'linearUpdateIssuePriority'.*issueId/
        );
    });

    await test('Tickets: schema validation rejects malformed payload (linearUpdateIssueLabels missing issueId)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('linearUpdateIssueLabels', { workspaceRoot: tmpRoot }),
            /Invalid payload for Tickets verb 'linearUpdateIssueLabels'.*issueId/
        );
    });

    // ── 2d stranded assertions (comment/attachment verbs moved with 2d) ─────
    // Bodies preserved verbatim; only the provider under test and the provider
    // name in the expected error changed.

    await test('downloadAttachment RETURNS in-body attachmentDownloaded and keeps push additive', async () => {
        const { provider, pushes } = buildHeadlessTicketsProvider(tmpRoot, {
            commandResults: {
                'switchboard.downloadAttachment': () => ({ success: true, filePath: '/tmp/dl.bin' }),
            },
        });
        const result = await provider.handleServiceVerb('downloadAttachment', { url: 'https://x/y', provider: 'clickup', ticketId: 't1' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.filePath, '/tmp/dl.bin');
        assert.strictEqual(result.type, 'attachmentDownloaded');
        const push = pushes.find(p => p.type === 'attachmentDownloaded');
        assert.ok(push, 'webview push emitted');
    });

    await test('viewAttachments RETURNS in-body attachments (headless: no webviewUri rewrite, no vscode reached)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot, {
            commandResults: {
                'switchboard.getAttachmentList': () => ([{ isDownloaded: true, localPath: '/tmp/a.png' }]),
            },
        });
        const result = await provider.handleServiceVerb('viewAttachments', { provider: 'clickup', ticketId: 't1', attachments: [] });
        assert.strictEqual(result.success, true);
        assert.ok(Array.isArray(result.attachments));
        // Headless has no webview → webviewUri must NOT be set (host-agnostic guard).
        assert.strictEqual(result.attachments[0].webviewUri, undefined);
        assert.strictEqual(result.type, 'attachmentsListResult');
    });

    await test('loadTicketComments RETURNS in-body ticketCommentsLoaded via command seam and keeps push additive', async () => {
        const { provider, pushes } = buildHeadlessTicketsProvider(tmpRoot, {
            commandResults: {
                'switchboard.loadTicketComments': () => ({ success: true, threads: [{ id: 'c1' }], members: [], threadingSupported: false }),
            },
        });
        const result = await provider.handleServiceVerb('loadTicketComments', { workspaceRoot: tmpRoot, provider: 'clickup', id: 't1' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.type, 'ticketCommentsLoaded');
        assert.ok(Array.isArray(result.threads));
        assert.strictEqual(result.threads.length, 1);
        const push = pushes.find(p => p.type === 'ticketCommentsLoaded');
        assert.ok(push, 'webview push emitted');
    });

    await test('Tickets: schema validation rejects malformed payload (postTicketComment missing provider)', async () => {
        const { provider } = buildHeadlessTicketsProvider(tmpRoot);
        await assert.rejects(
            () => provider.handleServiceVerb('postTicketComment', { id: 't1', comment: 'hi' }),
            /Invalid payload for Tickets verb 'postTicketComment'.*provider/
        );
    });

    // ── Plan 4 stranded assertion (applyClickUpConfig moved from Setup) ─────
    // Body preserved verbatim; only the provider under test changed.

    await test('Tickets: applyClickUpConfig schema validates and RETURNS body data', async () => {
        const { provider, pushes } = buildHeadlessTicketsProvider(tmpRoot);
        const result = await provider.handleServiceVerb('applyClickUpConfig', { token: 'secret-token-123' });
        assert.strictEqual(result.success, true);
        assert.strictEqual(result.tokenReceived, true);
        const push = pushes.find(p => p.type === 'clickupApplyResult');
        assert.ok(push, 'webview push emitted');
    });

    // ── Cleanup ─────────────────────────────────────────────────────────────

    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) process.exit(1);
}

main().catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
});
