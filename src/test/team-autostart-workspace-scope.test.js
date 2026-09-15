'use strict';

/**
 * Contract tests for Team Auto-Start Workspace Scope.
 *
 * The reported UAT defect — "teams do not spawn when team owner spawns" — was a
 * silent reader/writer root divergence: the TEAMS tab writes
 * `terminals.agentGroups` into the BOARD'S SELECTED workspace, while the
 * auto-start trigger read it from the PINNED API-server root. In a multi-root
 * window those are different folders, so the read returned `[]`, the team was
 * never found, and nothing was logged.
 *
 * The first four assertions drive the new multi-root resolver
 * (`findTeamForHeadRoleInRoots`) with fake DBs — no VS Code, no sqlite — and
 * pin the three load-bearing properties: nearest-first search finds the team
 * the writer placed it under (#1); a pinned-root-only search reproduces the
 * defect, proving the test is load-bearing (#2); a member-less team in the
 * nearer root STOPS the search so there is no silent cross-workspace spawn
 * (#3); and an unavailable DB is skipped, not fatal (#4).
 *
 * The rest are source-text contracts on decisions that are invisible on
 * inspection and were each wrong in a first pass: the reader must consult the
 * same root the writer uses (#5), the parentRoot→cwd conversion must stay
 * above the lookup (#6), the candidate loop must use the presence-gated getter
 * so a boardless workspace does not throw a warning toast (#7), and the
 * zero-member outcome must have its OWN log line on both hosts — collapsing it
 * into "no team" is what hid this bug for a release (#8).
 */

const fs = require('fs');
const path = require('path');
const assert = require('assert');

const { findTeamForHeadRoleInRoots, wireSpawnedTeam, listTeamsInRoots, resolveTeamByIdInRoots, isUntouchedSeed, SEEDED_AGENT_GROUP, migrateAgentGroups } = require('../../out/services/teamWiring');
const { instantiateAgentGroupCore } = require('../../out/services/agentGroupInstantiation');

const REPO_ROOT = path.resolve(__dirname, '../..');
const taskViewerTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/TaskViewerProvider.ts'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(REPO_ROOT, 'src/standalone/bootstrap.ts'), 'utf8');
// The Teams tab functions live in agent-control.js since the tabs left kanban.html.
const agentControlJs = fs.readFileSync(path.join(REPO_ROOT, 'src/webview/agent-control.js'), 'utf8');
const extensionTs = fs.readFileSync(path.join(REPO_ROOT, 'src/extension.ts'), 'utf8');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (e) {
        console.error(`  ❌ ${name}\n     ${e.message}`);
        failed++;
    }
}

const fakeDb = (groups) => ({ getConfigJson: async (_k, d) => (groups === undefined ? d : groups) });
const LEAD_TEAM = { id: 'feature-implementation', name: 'Lead team', headRole: 'lead',
    members: [{ role: 'coder', count: 3, scope: 'per-team', relationship: 'reports-to-head' }] };

(async () => {
    console.log('\n--- findTeamForHeadRoleInRoots: multi-root resolution ---');

    // 1. THE REPORTED BUG: the pinned root has no key, the selected root holds the team.
    //    Searching both, nearest-first, must find it.
    await test('selected-root-first search finds the team the writer placed there', async () => {
        const dbs = { '/pinned': fakeDb(undefined), '/selected': fakeDb([LEAD_TEAM]) };
        const m = await findTeamForHeadRoleInRoots(['/selected', '/pinned'], async r => dbs[r], 'lead');
        assert.strictEqual(m && m.team.name, 'Lead team');
        assert.strictEqual(m.root, '/selected');
    });

    // 2. Pinned-root-only search reproduces the defect — proves the test is load-bearing.
    await test('pinned-root-only search returns null (the defect it exists to remove)', async () => {
        const dbs = { '/pinned': fakeDb(undefined), '/selected': fakeDb([LEAD_TEAM]) };
        assert.strictEqual(await findTeamForHeadRoleInRoots(['/pinned'], async r => dbs[r], 'lead'), null);
    });

    // 3. A member-less team in the NEARER root stops the search: no cross-workspace spawn.
    //    This is the SEEDED_AGENT_GROUP shape verbatim — the case that reproduces the
    //    original symptom with every signal green, so it must be a distinguishable
    //    RESULT (team named, members 0), never a null.
    await test('a member-less team in the nearer root stops the search', async () => {
        const seeded = { id: 'feature-implementation', name: 'Lead team', headRole: 'lead', members: [] };
        const dbs3 = { '/near': fakeDb([seeded]), '/far': fakeDb([LEAD_TEAM]) };
        const m3 = await findTeamForHeadRoleInRoots(['/near', '/far'], async r => dbs3[r], 'lead');
        assert.strictEqual(m3.root, '/near');
        assert.strictEqual(m3.team.members.length, 0);
    });

    // 4. An unavailable DB is skipped, not fatal.
    await test('an unavailable DB is skipped, not fatal', async () => {
        const dbs = { '/pinned': fakeDb(undefined), '/selected': fakeDb([LEAD_TEAM]) };
        const m4 = await findTeamForHeadRoleInRoots(['/dead', '/selected'],
            async r => { if (r === '/dead') { throw new Error('boom'); } return dbs[r]; }, 'lead');
        assert.strictEqual(m4.root, '/selected');
    });

    console.log('\n--- source-text contracts ---');

    // 5. Drift guard: the reader consults the same root the writer uses. Source-level —
    //    _teamLookupRoots must reference getCurrentWorkspaceRoot, because that is what
    //    KanbanProvider._resolveWorkspaceRoot resolves to on the save path.
    await test('_teamLookupRoots references getCurrentWorkspaceRoot (the writer path)', async () => {
        const helper = taskViewerTs.slice(taskViewerTs.indexOf('_teamLookupRoots(payloadCwd'),
                             taskViewerTs.indexOf('_teamLookupRoots(payloadCwd') + 1600);
        assert.ok(/getCurrentWorkspaceRoot/.test(helper));
    });

    // 6–8 REMOVED: these tests asserted the head-role auto-start trigger existed
    //    in the ptyCreateTerminal arm of both hosts. The auto-start-on-head-role
    //    behaviour has been removed — teams are started explicitly via the START
    //    TEAM control or the START ON LOAD toggle. The _getKanbanDbIfPresent
    //    getter is still exercised by the explicit-start and autoban paths, and
    //    _teamLookupRoots is still used by startTeamForWorkspace (test 5 covers it).

    console.log('\n--- wireSpawnedTeam groupId return contract ---');

    // 9. wireSpawnedTeam returns a groupId matching the team id formula on
    //    success with children, so the create response can hand it to the
    //    webview verbatim — the id formula must NOT be duplicated client-side.
    await test('wireSpawnedTeam returns groupId on success with children', async () => {
        const store = {};
        const db = {
            getConfigJson: async (k, d) => (k in store ? store[k] : d),
            setConfigJson: async (k, v) => { store[k] = v; },
        };
        const headName = 'lead-1';
        const children = [
            { friendlyName: 'lead-1-coder-1', role: 'coder', agentInstanceId: 'x', status: 'active' },
            { friendlyName: 'lead-1-reviewer-1', role: 'reviewer', agentInstanceId: 'y', status: 'active' },
        ];
        const result = await wireSpawnedTeam({ db, headName, children });
        assert.ok(result.ok, 'wireSpawnedTeam should succeed with a valid DB and children');
        const expected = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');
        assert.strictEqual(result.groupId, expected,
            'groupId must match the team id formula — the webview must not re-derive it');
    });

    // 10. No children → no group registered → no groupId. The webview treats
    //     "delegates present, teamGroupId absent" as a legitimate state (the
    //     by-name fallback), so this contract must hold.
    await test('wireSpawnedTeam returns no groupId when there are no children', async () => {
        const store = {};
        const db = {
            getConfigJson: async (k, d) => (k in store ? store[k] : d),
            setConfigJson: async (k, v) => { store[k] = v; },
        };
        const result = await wireSpawnedTeam({ db, headName: 'lead-1', children: [] });
        assert.ok(result.ok, 'wireSpawnedTeam with no children should return ok');
        assert.strictEqual(result.groupId, undefined,
            'no groupId when no group was registered');
    });

    // 11. Both hosts reference wired.groupId — a source-text assertion so a fix
    //     landing in one host and not the other fails CI (the both-hosts rule).
    await test('both hosts reference wired.groupId (the both-hosts rule)', async () => {
        for (const [label, text] of [['TaskViewerProvider', taskViewerTs], ['bootstrap', bootstrapTs]]) {
            assert.ok(
                /wired\.groupId/.test(text),
                `${label} must reference wired.groupId — the teamGroupId field must land in BOTH hosts`
            );
        }
    });

    // 11a. BEHAVIOURAL: instantiateAgentGroupCore must RETURN the group id, not
    //      just compute it. Test 11 is a source-text grep and cannot see a core
    //      that drops the field one layer below both hosts — which is exactly
    //      the defect the START TEAM path shipped with. Both hosts funnel
    //      ptyStartTeam through this core, so one behavioural case covers both.
    await test('instantiateAgentGroupCore returns teamGroupId for a team with members', async () => {
        const store = {};
        const db = {
            getConfigJson: async (k, d) => (k in store ? store[k] : d),
            setConfigJson: async (k, v) => { store[k] = v; },
        };
        const headName = 'lead-1';
        const result = await instantiateAgentGroupCore({
            db,
            group: { id: 'coding', name: 'Coding', headRole: 'lead', members: [{ role: 'coder', count: 2 }] },
            cwd: '/ws',
            liveDelegateCount: async () => 0,
            createHeadWithDelegates: async () => ({
                success: true,
                terminal: { friendlyName: headName },
                delegates: [
                    { friendlyName: 'lead-1-coder-1', role: 'coder', status: 'active' },
                    { friendlyName: 'lead-1-coder-2', role: 'coder', status: 'active' },
                ],
            }),
        });
        assert.strictEqual(result.success, true, 'the core must succeed');
        const expected = 'team_' + encodeURIComponent(headName).replace(/[^a-zA-Z0-9_]/g, '_');
        assert.strictEqual(result.teamGroupId, expected,
            'the core must return teamGroupId — the webview switches to this group to seat the team');
    });

    // 11b. The member-less team registers no group, so the core must claim no id.
    //      The webview's zero-member branch stays on assignToFocusedPane; a
    //      fabricated id here would lock a one-terminal "team" into a group.
    await test('instantiateAgentGroupCore returns no teamGroupId for a member-less team', async () => {
        const store = {};
        const db = {
            getConfigJson: async (k, d) => (k in store ? store[k] : d),
            setConfigJson: async (k, v) => { store[k] = v; },
        };
        const result = await instantiateAgentGroupCore({
            db,
            group: { id: 'feature-implementation', name: 'Lead team', headRole: 'lead', members: [] },
            cwd: '/ws',
            liveDelegateCount: async () => 0,
            createHeadWithDelegates: async () => ({
                success: true,
                terminal: { friendlyName: 'lead-1' },
                delegates: [],
            }),
        });
        assert.strictEqual(result.success, true, 'a member-less team is a legitimate state');
        assert.strictEqual(result.teamGroupId, undefined,
            'no group is registered for a member-less team, so no id may be claimed');
    });

    console.log('\n--- listTeamsInRoots / resolveTeamByIdInRoots / isUntouchedSeed ---');

    // 12. THE REPORTED BUG (explicit path): the pinned root holds only the
    //     auto-seed, the selected root holds the operator's authored team.
    //     listTeamsInRoots must skip the seed-only root and return the
    //     authored teams from the selected root.
    await test('listTeamsInRoots returns the selected root teams when the pinned root holds only the seed', async () => {
        const seeded = { ...SEEDED_AGENT_GROUP };
        const dbs = { '/pinned': fakeDb([seeded]), '/selected': fakeDb([LEAD_TEAM]) };
        const r = await listTeamsInRoots(['/selected', '/pinned'], async r2 => dbs[r2]);
        assert.strictEqual(r.root, '/selected');
        assert.strictEqual(r.teams.length, 1);
        assert.strictEqual(r.teams[0].name, 'Lead team');
        assert.strictEqual(r.teams[0].members.length, 1);
    });

    // 13. A pinned-root-only read where the pinned root holds NOTHING but the
    //     seed returns no authored teams — proving hasAuthoredTeams is
    //     load-bearing. Without the gate, the seeded `Lead team` would leak
    //     through and shadow every real team in every other candidate.
    await test('a seed-only pinned root returns no authored teams (hasAuthoredTeams is load-bearing)', async () => {
        const seeded = { ...SEEDED_AGENT_GROUP };
        const dbs = { '/pinned': fakeDb([seeded]) };
        const r = await listTeamsInRoots(['/pinned'], async r2 => dbs[r2]);
        assert.strictEqual(r.root, null);
        assert.strictEqual(r.teams.length, 0);
    });

    // 14. isUntouchedSeed is true for SEEDED_AGENT_GROUP and false for an
    //     operator-authored member-less team that differs by name only. A
    //     member-less team an operator authored is legitimate and must be
    //     listed and startable — the predicate is exact-value, never a
    //     "has no members" heuristic.
    await test('isUntouchedSeed is exact-value: true for the seed, false for a renamed member-less team', async () => {
        assert.strictEqual(isUntouchedSeed(SEEDED_AGENT_GROUP), true);
        const authoredMemberless = { id: 'feature-implementation', name: 'My team', headRole: 'lead', members: [] };
        assert.strictEqual(isUntouchedSeed(authoredMemberless), false);
        // An extra key (e.g. headPrompt) also breaks the match — the operator touched it.
        const withExtra = { ...SEEDED_AGENT_GROUP, headPrompt: 'x' };
        assert.strictEqual(isUntouchedSeed(withExtra), false);
    });

    // 14b. THE SHAPE THAT REACHES DISK. `_loadAgentGroups` seeds the group, runs
    //      `migrateAgentGroups`, and PERSISTS the converted result — so the row a
    //      later read sees carries the step-1 member defaults (`scope`,
    //      `relationship`) that the literal in DEFAULT_TEAM_DEFINITIONS does not.
    //      Asserting only against the raw literal (test 14) is green while
    //      `hasAuthoredTeams` reads a seed-only root as authored and
    //      listTeamsInRoots stops there — the phantom-seed bug, restored. This is
    //      the assertion that has to fail if the predicate is tightened again.
    await test('isUntouchedSeed recognises the PERSISTED seed (post-migrateAgentGroups), not just the literal', async () => {
        const persisted = migrateAgentGroups([JSON.parse(JSON.stringify(SEEDED_AGENT_GROUP))])[0];
        assert.ok(persisted.members[0].scope, 'fixture guard: the converter must have stamped scope');
        assert.strictEqual(isUntouchedSeed(persisted), true);
        // …and a seed-only root holding that persisted row is still not authored.
        const r = await listTeamsInRoots(['/pinned'], async () => fakeDb([persisted]));
        assert.strictEqual(r.root, null);
        assert.strictEqual(r.teams.length, 0);
        // The tolerance is the DEFAULT VALUE only — an operator-set scope is an edit.
        const edited = JSON.parse(JSON.stringify(persisted));
        edited.members[0].scope = 'global';
        assert.strictEqual(isUntouchedSeed(edited), false);
    });

    // 15. resolveTeamByIdInRoots finds a team by id in the second candidate root
    //     and returns that root's db, so the caller does not re-open a second,
    //     different one.
    await test('resolveTeamByIdInRoots finds a team by id in the second candidate and returns its db', async () => {
        const dbs = { '/pinned': fakeDb(undefined), '/selected': fakeDb([LEAD_TEAM]) };
        const m = await resolveTeamByIdInRoots(['/pinned', '/selected'], async r => dbs[r], LEAD_TEAM.id);
        assert.ok(m, 'expected a match');
        assert.strictEqual(m.root, '/selected');
        assert.strictEqual(m.team.id, LEAD_TEAM.id);
        assert.strictEqual(m.db, dbs['/selected']);
    });

    // 16. resolveTeamByIdInRoots still resolves a seed-only root's team BY
    //     EXPLICIT ID — proving hasAuthoredTeams gates the LIST walk only,
    //     never the id walk. A seeded team is legitimately startable by id.
    await test('resolveTeamByIdInRoots resolves a seed-only root team by explicit id (id walk is not gated)', async () => {
        const seeded = { ...SEEDED_AGENT_GROUP };
        const dbs = { '/pinned': fakeDb([seeded]) };
        const m = await resolveTeamByIdInRoots(['/pinned'], async r => dbs[r], SEEDED_AGENT_GROUP.id);
        assert.ok(m, 'the seeded team must be startable by explicit id');
        assert.strictEqual(m.root, '/pinned');
        assert.strictEqual(m.team.id, SEEDED_AGENT_GROUP.id);
    });

    // 17. Drift guard: the two team verbs must not drift back to a single root.
    //     startTeamForWorkspace must derive its root via _teamLookupRoots, and
    //     the ptyStartTeam arm must delegate to this.startTeamForWorkspace(
    //     rather than re-deriving a root inline.
    await test('startTeamForWorkspace uses _teamLookupRoots and ptyStartTeam delegates to it', async () => {
        const methodIdx = taskViewerTs.indexOf('startTeamForWorkspace(opts');
        assert.ok(methodIdx > 0, 'startTeamForWorkspace method not found');
        const method = taskViewerTs.slice(methodIdx, methodIdx + 1400);
        assert.ok(/_teamLookupRoots\(/.test(method), 'startTeamForWorkspace must call _teamLookupRoots(');
        const armIdx = taskViewerTs.indexOf("if (verb === 'ptyStartTeam')");
        assert.ok(armIdx > 0, 'ptyStartTeam arm not found');
        // Slice to the NEXT verb arm, not a fixed char window. The arm opens with
        // a long wire-safety comment, so a 600-char window ended BEFORE the
        // delegation line and the assertion could never see its target — a gate
        // that fails no matter what the code does is not a gate.
        const nextArmIdx = taskViewerTs.indexOf("if (verb === '", armIdx + 10);
        const arm = taskViewerTs.slice(armIdx, nextArmIdx > armIdx ? nextArmIdx : armIdx + 2000);
        assert.ok(/this\.startTeamForWorkspace\(/.test(arm), 'ptyStartTeam must delegate to this.startTeamForWorkspace(');
    });

    // 18. Read-only verb guard: bootstrap's ptyListAgentGroups arm must call
    //     peekAgentGroups (read-only), not listAgentGroups (seeds + joins the
    //     write chain). The boot-time seeding pass at the bottom of bootstrap
    //     still calls listAgentGroups — that is correct and stays; this test
    //     pins the VERB arm only.
    await test("bootstrap ptyListAgentGroups arm calls peekAgentGroups, not listAgentGroups", async () => {
        const caseIdx = bootstrapTs.indexOf("case 'ptyListAgentGroups':");
        assert.ok(caseIdx > 0, 'ptyListAgentGroups case not found in bootstrap');
        const arm = bootstrapTs.slice(caseIdx, caseIdx + 400);
        assert.ok(/peekAgentGroups/.test(arm), 'the verb arm must call peekAgentGroups');
        assert.ok(!/listAgentGroups/.test(arm), 'the verb arm must NOT call listAgentGroups (it seeds)');
    });

    console.log('\n--- auto-start deletion contracts ---');

    // 19. Auto-start is gone: startTeamsOnLoad must NOT exist in
    //     TaskViewerProvider.ts. The boot sweep was deleted; a host coming up
    //     must spawn nothing. This is the regression guard on the deletion.
    await test('startTeamsOnLoad is removed from TaskViewerProvider', async () => {
        assert.ok(!/startTeamsOnLoad/.test(taskViewerTs),
            'startTeamsOnLoad must be removed — auto-start is deleted');
        assert.ok(!/_teamAutostartDone/.test(taskViewerTs),
            '_teamAutostartDone latch must be removed with the sweep');
    });

    // 20. Neither host calls startTeamsOnLoad at boot — the both-hosts rule
    //     works in both directions: the deletion must touch both call sites.
    await test('neither host calls startTeamsOnLoad at boot', async () => {
        assert.ok(!/startTeamsOnLoad/.test(extensionTs),
            'extension.ts must NOT call startTeamsOnLoad');
        assert.ok(!/startTeamsOnLoad/.test(bootstrapTs),
            'bootstrap.ts must NOT call startTeamsOnLoad');
    });

    // 21. migrateAgentGroups strips startOnLoad on read (clear-on-read
    //     migration). A stored startOnLoad: true that does nothing is the
    //     fallback-indistinguishable-from-a-value anti-pattern, so the
    //     converter must remove it and flag changed so the cleaned shape
    //     is persisted. All other keys are preserved.
    await test('migrateAgentGroups strips startOnLoad (clear-on-read)', async () => {
        const withStartOnLoad = { id: 't1', name: 'Team 1', headRole: 'lead', members: [], startOnLoad: true, icon: 'jet' };
        const migrated = migrateAgentGroups([withStartOnLoad]);
        assert.ok(migrated !== null, 'migrateAgentGroups must flag changed when startOnLoad is present');
        assert.ok(migrated[0].startOnLoad === undefined,
            'startOnLoad must be stripped from the migrated group');
        assert.strictEqual(migrated[0].icon, 'jet',
            'other keys (icon) must be preserved');
        assert.strictEqual(migrated[0].name, 'Team 1',
            'other keys (name) must be preserved');
    });

    // 22. migrateAgentGroups is idempotent: a group without startOnLoad
    //     returns null (no change), so the clear-on-read does not loop.
    await test('migrateAgentGroups is idempotent after startOnLoad strip', async () => {
        // Fully-migrated shape: no startOnLoad AND the `machine` pin every team
        // now carries (plan: agents-are-saved-per-machine-and-a-team-picks-one).
        // A clear-on-read converter that keeps reporting `changed` rewrites the
        // store on every read forever — that is what this pins.
        const clean = { id: 't1', name: 'Team 1', headRole: 'lead', machine: 'local', members: [] };
        assert.strictEqual(migrateAgentGroups([clean]), null,
            'a fully-migrated group must not be re-flagged');
        // And the machine stamp itself is ONE-TIME: a group missing it is
        // flagged once, and the result of that pass is then stable.
        const unstamped = { id: 't2', name: 'Team 2', headRole: 'lead', members: [] };
        const stamped = migrateAgentGroups([unstamped]);
        assert.ok(Array.isArray(stamped), 'a group without `machine` must be flagged once');
        assert.strictEqual(stamped[0].machine, 'local');
        assert.strictEqual(migrateAgentGroups(stamped), null,
            'the stamped result must not be re-flagged on the next read');
    });

    // 23. Field-carry guard: teamsTabSaveAgentGroup must still carry
    //     startWorktree (load-bearing for manual starts) but must NOT carry
    //     startOnLoad (retired).
    await test("agent-control.js teamsTabSaveAgentGroup carries startWorktree but NOT startOnLoad", async () => {
        const saveIdx = agentControlJs.indexOf('function teamsTabSaveAgentGroup');
        assert.ok(saveIdx > 0, 'teamsTabSaveAgentGroup not found');
        const nextFnIdx = agentControlJs.indexOf('\n        function ', saveIdx + 10);
        const save = agentControlJs.slice(saveIdx, nextFnIdx > saveIdx ? nextFnIdx : saveIdx + 6000);
        assert.ok(/prevGroup\?\.startWorktree/.test(save),
            'teamsTabSaveAgentGroup must carry startWorktree from prevGroup');
        assert.ok(!/prevGroup\?\.startOnLoad/.test(save),
            'teamsTabSaveAgentGroup must NOT carry startOnLoad (retired)');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
})();
