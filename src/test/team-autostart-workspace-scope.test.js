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

const { findTeamForHeadRoleInRoots, wireSpawnedTeam, listTeamsInRoots, resolveTeamByIdInRoots, isUntouchedSeed, SEEDED_AGENT_GROUP } = require('../../out/services/teamWiring');

const REPO_ROOT = path.resolve(__dirname, '../..');
const taskViewerTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/TaskViewerProvider.ts'), 'utf8');
const bootstrapTs = fs.readFileSync(path.join(REPO_ROOT, 'src/standalone/bootstrap.ts'), 'utf8');

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

    // 6. Invariant guard (replaces the block-order guard): the parentRoot -> cwd
    //    conversion is the ONLY writer of a cwd the lookup can consume, so it must
    //    stay above the lookup. Below it, a per-parent `+` would silently resolve the
    //    team from the selected workspace instead of the one the operator clicked.
    await test('parentRoot -> cwd conversion stays above the team lookup', async () => {
        const arm = taskViewerTs.slice(taskViewerTs.indexOf("if (verb === 'ptyCreateTerminal' && payload)"));
        assert.ok(arm.indexOf('cwd: payload.parentRoot') < arm.indexOf('_teamLookupRoots('));
    });

    // 7. Toast guard: the candidate loop must use the presence-gated getter, and that
    //    getter must actually check the file. _getKanbanDb warns the USER for every
    //    root whose kanban.db is absent.
    await test('lookup uses _getKanbanDbIfPresent which checks the file on disk', async () => {
        const arm = taskViewerTs.slice(taskViewerTs.indexOf("if (verb === 'ptyCreateTerminal' && payload)"));
        const call = arm.slice(arm.indexOf('findTeamForHeadRoleInRoots'),
                               arm.indexOf('findTeamForHeadRoleInRoots') + 400);
        assert.ok(/_getKanbanDbIfPresent/.test(call));
        // Anchor on the DECLARATION (`_getKanbanDbIfPresent(root: string)`), not on a
        // bare `(root)` — the typed signature never matches that, indexOf returns -1,
        // and the slice silently degrades to '' so the assertion below can only fail.
        const declIdx = taskViewerTs.indexOf('_getKanbanDbIfPresent(root:');
        assert.ok(declIdx > 0, '_getKanbanDbIfPresent declaration not found');
        const getter = taskViewerTs.slice(declIdx, declIdx + 900);
        assert.ok(/existsSync/.test(getter), 'the getter must stat the file before opening the DB');
        // ...and stat the RESOLVED db path, not the hardcoded default. A db-pointer or
        // the shipped `kanban.dbPath` setting relocates the file, so a default-path-only
        // gate skips a root that HAS a board — this plan's own bug, re-introduced by its
        // own guard, for every install with a custom DB location.
        assert.ok(/readDbPointer/.test(getter) && /kanban\.dbPath/.test(getter),
            'the getter must honour db-pointer and the kanban.dbPath override');
    });

    // 8. Legibility guard, both hosts: the zero-member outcome must have its OWN
    //    message. One collapsed "no team" line is what hid this bug for a release.
    await test('both hosts log the zero-member case distinctly', async () => {
        for (const [label, text] of [['TaskViewerProvider', taskViewerTs], ['bootstrap', bootstrapTs]]) {
            assert.ok(/ZERO members/.test(text), `${label} must log the zero-member case distinctly`);
        }
    });

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
        const arm = taskViewerTs.slice(armIdx, armIdx + 600);
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

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
})();
