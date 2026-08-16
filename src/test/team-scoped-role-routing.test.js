'use strict';

/**
 * Verification tests for team-scoped reviewer routing on CODE REVIEWED.
 * Plan: feature_plan_20260816164109_team-scoped-reviewer-routing-on-code-reviewed.md
 *
 * Items 1–7 of the plan's Automated Tests section:
 *  1. resolveTeamScopedRoleTerminal — the regression the plan exists for
 *  2. plausibleOriginTerminal — the origin filter
 *  3. Change 0 recording ownership — one writer per path, never 'unknown' on drag
 *  4. POST /kanban/dispatch — from, teamRouting, fallbacks, override precedence
 *  5. custom-user branch — honours caller targetTerminalOverride (Change 4)
 *  6. single-team / no-team — byte-identical to pre-change resolution
 *  7. planner rotation — cursor still advances (custom-user precedence edit)
 *
 * Run with: node src/test/team-scoped-role-routing.test.js
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { resolveTeamScopedRoleTerminal, plausibleOriginTerminal } =
    require('../../out/services/teamWiring');
const { LocalApiServer } = require('../../out/services/LocalApiServer');

const REPO_ROOT = path.resolve(__dirname, '../..');
const teamWiringTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/teamWiring.ts'), 'utf8');
const taskViewerTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/TaskViewerProvider.ts'), 'utf8');
const kanbanProviderTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/KanbanProvider.ts'), 'utf8');
const localApiServerTs = fs.readFileSync(path.join(REPO_ROOT, 'src/services/LocalApiServer.ts'), 'utf8');

let passed = 0;
let failed = 0;

async function test(name, fn) {
    try {
        await fn();
        console.log(`  PASS ${name}`);
        passed++;
    } catch (e) {
        console.error(`  FAIL ${name}`);
        console.error(`     ${e && e.stack ? e.stack.split('\n').slice(0, 4).join('\n     ') : e}`);
        failed++;
    }
}

// ── Shared fixtures ────────────────────────────────────────────────────────

/** Same normaliser the existing role resolvers use (_normalizeAgentKey). */
const normalizeRole = (r) => (r || '')
    .toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Two teams, each with its own reviewer — the reported scenario. */
const TWO_GROUPS = [
    { id: 'team_lead_1', name: 'lead-1', source: 'manual',
      members: ['lead-1', 'lead-1-coder-1', 'Coding-reviewer'],
      order:  ['lead-1', 'lead-1-coder-1', 'Coding-reviewer'] },
    { id: 'team_lead_2', name: 'lead-2', source: 'manual',
      members: ['lead-2', 'lead-2-coder-1', 'Backend-reviewer'],
      order:  ['lead-2', 'lead-2-coder-1', 'Backend-reviewer'] },
];

const SIX_LIVE = [
    { name: 'lead-1',         role: 'lead' },
    { name: 'lead-1-coder-1', role: 'coder' },
    { name: 'Coding-reviewer', role: 'reviewer' },
    { name: 'lead-2',         role: 'lead' },
    { name: 'lead-2-coder-1', role: 'coder' },
    { name: 'Backend-reviewer', role: 'reviewer' },
];

const fakeDb = (groups) => ({
    getConfigJson: async (_k, d) => (groups === undefined ? d : groups),
    ensureReady: async () => true,
});

// ── Item 1: resolveTeamScopedRoleTerminal ──────────────────────────────────

async function item1() {
    console.log('\n── Item 1: resolveTeamScopedRoleTerminal ──');

    await test('lead-1 => Coding-reviewer (own team reviewer)', async () => {
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(TWO_GROUPS), originName: 'lead-1', role: 'reviewer',
            liveTerminals: SIX_LIVE, normalizeRole,
        });
        assert.strictEqual(r, 'Coding-reviewer');
    });

    await test('lead-2 => Backend-reviewer (own team reviewer)', async () => {
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(TWO_GROUPS), originName: 'lead-2', role: 'reviewer',
            liveTerminals: SIX_LIVE, normalizeRole,
        });
        assert.strictEqual(r, 'Backend-reviewer');
    });

    await test('lead-1-coder-1 => Coding-reviewer (member resolves to own team)', async () => {
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(TWO_GROUPS), originName: 'lead-1-coder-1', role: 'reviewer',
            liveTerminals: SIX_LIVE, normalizeRole,
        });
        assert.strictEqual(r, 'Coding-reviewer');
    });

    // THE REGRESSION THE PLAN EXISTS FOR.
    await test('Backend-reviewer is NOT returned for lead-1 (alphabetical-first bug)', async () => {
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(TWO_GROUPS), originName: 'lead-1', role: 'reviewer',
            liveTerminals: SIX_LIVE, normalizeRole,
        });
        assert.notStrictEqual(r, 'Backend-reviewer',
            'Backend-reviewer is team B\'s reviewer — returning it for lead-1 is the bug');
    });

    await test('reviewer exited (absent from liveTerminals) => null, not a dead name', async () => {
        const live = SIX_LIVE.filter(t => t.name !== 'Coding-reviewer');
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(TWO_GROUPS), originName: 'lead-1', role: 'reviewer',
            liveTerminals: live, normalizeRole,
        });
        assert.strictEqual(r, null);
    });

    await test('origin absent from every group => null', async () => {
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(TWO_GROUPS), originName: 'stranger', role: 'reviewer',
            liveTerminals: SIX_LIVE, normalizeRole,
        });
        assert.strictEqual(r, null);
    });

    await test('no terminals.groups key => null (empty-board safety)', async () => {
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(undefined), originName: 'lead-1', role: 'reviewer',
            liveTerminals: SIX_LIVE, normalizeRole,
        });
        assert.strictEqual(r, null);
    });

    await test('origin whose own role is reviewer never returns itself', async () => {
        // lead-1 is a 'lead', but make it a 'reviewer' in the live set and verify
        // it is excluded from its own candidate set.
        const live = [
            { name: 'lead-1', role: 'reviewer' },
            { name: 'lead-1-coder-1', role: 'coder' },
            { name: 'Coding-reviewer', role: 'reviewer' },
        ];
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb([TWO_GROUPS[0]]), originName: 'lead-1', role: 'reviewer',
            liveTerminals: live, normalizeRole,
        });
        assert.notStrictEqual(r, 'lead-1', 'a head must never dispatch a review to itself');
        assert.strictEqual(r, 'Coding-reviewer');
    });

    await test('role match ignores names: named Coding-reviewer with role coder NOT selected', async () => {
        const live = [
            { name: 'lead-1', role: 'lead' },
            { name: 'lead-1-coder-1', role: 'coder' },
            // Name says reviewer but the record role is coder — must NOT be picked.
            { name: 'Coding-reviewer', role: 'coder' },
        ];
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb([TWO_GROUPS[0]]), originName: 'lead-1', role: 'reviewer',
            liveTerminals: live, normalizeRole,
        });
        assert.strictEqual(r, null, 'a terminal whose record role is coder must not be selected as reviewer');
    });

    await test('role match ignores names: named alice with role reviewer IS selected', async () => {
        const group = [{ id: 'team_lead_1', name: 'lead-1', source: 'manual',
            members: ['lead-1', 'alice'], order: ['lead-1', 'alice'] }];
        const live = [
            { name: 'lead-1', role: 'lead' },
            { name: 'alice', role: 'reviewer' },
        ];
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(group), originName: 'lead-1', role: 'reviewer',
            liveTerminals: live, normalizeRole,
        });
        assert.strictEqual(r, 'alice');
    });

    await test('shared member in two groups => same result from either head, no throw', async () => {
        // Both Coding forks share 'Coding-reviewer' as a scope:shared member.
        const groups = [
            { id: 'team_lead_1', name: 'lead-1', source: 'manual',
              members: ['lead-1', 'lead-1-coder-1', 'Shared-reviewer'],
              order:  ['lead-1', 'lead-1-coder-1', 'Shared-reviewer'] },
            { id: 'team_lead_2', name: 'lead-2', source: 'manual',
              members: ['lead-2', 'lead-2-coder-1', 'Shared-reviewer'],
              order:  ['lead-2', 'lead-2-coder-1', 'Shared-reviewer'] },
        ];
        const live = [
            { name: 'lead-1', role: 'lead' },
            { name: 'lead-1-coder-1', role: 'coder' },
            { name: 'lead-2', role: 'lead' },
            { name: 'lead-2-coder-1', role: 'coder' },
            { name: 'Shared-reviewer', role: 'reviewer' },
        ];
        const fromA = await resolveTeamScopedRoleTerminal({
            db: fakeDb(groups), originName: 'lead-1', role: 'reviewer',
            liveTerminals: live, normalizeRole,
        });
        const fromB = await resolveTeamScopedRoleTerminal({
            db: fakeDb(groups), originName: 'lead-2', role: 'reviewer',
            liveTerminals: live, normalizeRole,
        });
        assert.strictEqual(fromA, 'Shared-reviewer');
        assert.strictEqual(fromB, 'Shared-reviewer');
    });

    await test('order array present and different from members => selection follows order', async () => {
        // Two reviewers in the group; order puts the second one first.
        const group = [{
            id: 'team_lead_1', name: 'lead-1', source: 'manual',
            members: ['lead-1', 'revA', 'revB'],
            order:  ['lead-1', 'revB', 'revA'],   // revB before revA in order
        }];
        const live = [
            { name: 'lead-1', role: 'lead' },
            { name: 'revA', role: 'reviewer' },
            { name: 'revB', role: 'reviewer' },
        ];
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(group), originName: 'lead-1', role: 'reviewer',
            liveTerminals: live, normalizeRole,
        });
        assert.strictEqual(r, 'revB', 'order array must be followed, not members');
    });
}

// ── Item 2: plausibleOriginTerminal ────────────────────────────────────────

async function item2() {
    console.log('\n── Item 2: plausibleOriginTerminal (origin filter) ──');

    await test('dispatched_terminal beats dispatched_agent', () => {
        assert.strictEqual(
            plausibleOriginTerminal({ dispatchedTerminal: 'lead-1-coder-1', dispatchedAgent: 'something-else' }),
            'lead-1-coder-1'
        );
    });

    await test("'unknown' yields empty string", () => {
        assert.strictEqual(plausibleOriginTerminal({ dispatchedAgent: 'unknown' }), '');
    });

    await test("bare role word 'coder' yields empty string", () => {
        assert.strictEqual(plausibleOriginTerminal({ dispatchedAgent: 'coder' }), '');
    });

    await test("bare role word 'reviewer' yields empty string", () => {
        assert.strictEqual(plausibleOriginTerminal({ dispatchedAgent: 'reviewer' }), '');
    });

    await test("IDE-shaped name matching dispatched_ide yields empty string", () => {
        assert.strictEqual(
            plausibleOriginTerminal({ dispatchedAgent: 'Visual Studio Code reviewer', dispatchedIde: 'Visual Studio Code' }),
            ''
        );
    });

    await test('a real terminal name passes through', () => {
        assert.strictEqual(
            plausibleOriginTerminal({ dispatchedAgent: 'lead-1-coder-1' }),
            'lead-1-coder-1'
        );
    });

    await test('empty record yields empty string', () => {
        assert.strictEqual(plausibleOriginTerminal({}), '');
    });

    await test('filter returns the recorded name when there is no from (call-site contract)', () => {
        // The filter itself returns the recorded value; the from-vs-recorded
        // precedence is the call site's job, exercised in item 4.
        const recorded = plausibleOriginTerminal({ dispatchedAgent: 'lead-1-coder-1' });
        assert.strictEqual(recorded, 'lead-1-coder-1');
    });
}

// ── Item 3: Change 0 recording ownership ───────────────────────────────────

async function item3() {
    console.log('\n── Item 3: Change 0 recording ownership ──');

    // Structural assertions on the two recording sites. These are the contracts
    // that make the fix work — each is a one-line guard whose absence is the bug.

    await test('handleKanbanTrigger records when targetColumn resolved (not just explicitTargetColumn)', () => {
        // The old guard was `if (explicitTargetColumn && targetColumn)` — the drag
        // path supplies no explicitTargetColumn, so recording was skipped and
        // KanbanProvider's fallback wrote 'unknown'. The new guard is
        // `if (targetColumn)`.
        assert.ok(
            /if\s*\(\s*targetColumn\s*\)\s*\{[\s\S]*_recordDispatchIdentity/.test(taskViewerTs),
            'handleKanbanTrigger must record when targetColumn is resolved, not only when explicitTargetColumn is supplied'
        );
        // Ensure the OLD guard is gone — if both are present, the fix is incomplete.
        assert.ok(
            !/if\s*\(\s*explicitTargetColumn\s*&&\s*targetColumn\s*\)\s*\{[\s\S]*_recordDispatchIdentity/.test(taskViewerTs),
            'the old explicitTargetColumn guard must be removed — its presence means the drag path still skips recording'
        );
    });

    await test('KanbanProvider built-in branch records only when it has a name (if targetTerminalOverride)', () => {
        // The old code recorded unconditionally with targetTerminalOverride (which
        // is undefined for non-planner roles), writing 'unknown'. The new code
        // gates on having a name so it cannot overwrite the resolved name.
        const branchStart = kanbanProviderTs.indexOf('// Record dispatch identity');
        assert.ok(branchStart > 0, 'recording comment must be present in built-in branch');
        // Window must clear the six-line explanatory comment that follows the
        // anchor before it reaches the guard (~600 chars in).
        const branch = kanbanProviderTs.slice(branchStart, branchStart + 900);
        assert.ok(
            /if\s*\(\s*targetTerminalOverride\s*\)/.test(branch),
            'built-in branch must gate recording on having a targetTerminalOverride — unconditional recording overwrites the resolved name with unknown'
        );
    });

    await test('recorded value is never the empty string (guard against unknown -> empty regression)', () => {
        // _recordDispatchIdentity's no-name branch writes 'unknown', never ''.
        // The plan's edge case: turning 'unknown' into '' would be a display
        // regression. Verify the writer still defaults to 'unknown' when no name.
        const writerStart = kanbanProviderTs.indexOf('public async _recordDispatchIdentity');
        assert.ok(writerStart > 0);
        // The signature, the roleFromColumn map and the role lookup sit between
        // the anchor and the fallback assignment (~930 chars in).
        const writer = kanbanProviderTs.slice(writerStart, writerStart + 1200);
        assert.ok(
            /agentName\s*=\s*'unknown'/.test(writer),
            "_recordDispatchIdentity must still default to 'unknown' (never '') when it has no name — empty is a display regression"
        );
    });

    await test('IDE-dispatch branches still call _recordDispatchIdentity with isIdeDispatch (untouched)', () => {
        // The IDE branches call _recordDispatchIdentity with isIdeDispatch set and
        // must be untouched by Change 0. `isIdeDispatch` is the FIFTH POSITIONAL
        // parameter (workspaceRoot, sessionId, targetColumn, terminalName?,
        // isIdeDispatch?) — the codebase has never used a named-argument form, so
        // matching on `isIdeDispatch: true` asserts a call shape that cannot exist.
        const ideCalls = [...kanbanProviderTs.matchAll(
            /_recordDispatchIdentity\([^)]*,\s*undefined,\s*true\s*\)/g
        )];
        assert.ok(ideCalls.length >= 2,
            `IDE-dispatch branches must still record with the isIdeDispatch positional flag — Change 0 must not touch them (found ${ideCalls.length})`);
    });

    await test('handleKanbanTrigger recording comment explains why the guard changed', () => {
        // The comment is load-bearing: it explains why the guard widened, so a
        // future reader does not "fix" it back to the narrow guard.
        const commentIdx = taskViewerTs.indexOf('Record with the RESOLVED terminal');
        assert.ok(commentIdx > 0,
            'the explanatory comment for the widened recording guard must be present');
    });
}

// ── Item 4: POST /kanban/dispatch integration ──────────────────────────────

async function item4() {
    console.log('\n── Item 4: POST /kanban/dispatch (performKanbanDispatch) ──');

    /** Builds a LocalApiServer with stubbed options for dispatch testing. */
    function makeServer(opts = {}) {
        const triggerActionCalls = [];
        const server = new LocalApiServer({
            workspaceRoot: '/ws',
            getAuthToken: async () => '',   // localhost-trust
            getRegisteredTerminals: () => ['lead-1'],
            getKanbanDatabase: async () => ({
                ensureReady: async () => true,
                getPlanByPlanId: async () => opts.record || {
                    planId: 'plan-1', sessionId: 'plan-1', topic: 'Test',
                    kanbanColumn: 'CODER CODED', complexity: 5,
                    dispatchedAgent: '', dispatchedTerminal: '', dispatchedIde: '',
                },
            }),
            kanbanVerb: async (verb, payload) => {
                if (verb === 'triggerAction') {
                    triggerActionCalls.push(payload);
                    return { success: true };
                }
                return { success: true };
            },
            // Presence-based, NOT `=== undefined`: a caller that passes
            // `resolveKanbanDispatch: undefined` is deliberately modelling the
            // UNWIRED standalone posture (audit item 13). An `=== undefined`
            // check cannot tell that apart from "not supplied" and silently
            // reinstalls the default gate, so the unwired case never runs.
            resolveKanbanDispatch: !('resolveKanbanDispatch' in opts)
                ? async () => ({ role: 'reviewer', cliTriggersEnabled: true, dragDropMode: null, source: null })
                : opts.resolveKanbanDispatch,
            resolveTeamRoleTerminal: !('resolveTeamRoleTerminal' in opts)
                ? async (_ws, origin, _role) => {
                    // Stub: return the team-scoped reviewer for known origins.
                    if (origin === 'lead-1') return 'Coding-reviewer';
                    if (origin === 'lead-2') return 'Backend-reviewer';
                    return null;
                }
                : opts.resolveTeamRoleTerminal,
            ...opts.extra,
        });
        return { server, triggerActionCalls };
    }

    await test('from:lead-1 => triggerAction carries targetTerminalOverride Coding-reviewer, teamRouting names the decision', async () => {
        const { server, triggerActionCalls } = makeServer();
        const outcome = await server.performKanbanDispatch('/ws', 'plan-1', 'CODE REVIEWED', { originTerminal: 'lead-1' });
        assert.strictEqual(triggerActionCalls.length, 1, 'triggerAction must be called exactly once');
        assert.strictEqual(triggerActionCalls[0].targetTerminalOverride, 'Coding-reviewer');
        assert.ok(outcome.payload.teamRouting, 'response must carry teamRouting');
        assert.ok(outcome.payload.teamRouting.includes('lead-1'), 'teamRouting must name the origin');
        assert.ok(outcome.payload.teamRouting.includes('Coding-reviewer'), 'teamRouting must name the resolved terminal');
    });

    await test('from omitted and no usable recorded origin => override undefined, teamRouting names fallback, dispatch still fires', async () => {
        const { server, triggerActionCalls } = makeServer({
            record: { planId: 'plan-1', sessionId: 'plan-1', topic: 'Test',
                      kanbanColumn: 'CODER CODED', complexity: 5,
                      dispatchedAgent: 'unknown', dispatchedTerminal: '', dispatchedIde: '' },
        });
        const outcome = await server.performKanbanDispatch('/ws', 'plan-1', 'CODE REVIEWED');
        assert.strictEqual(triggerActionCalls.length, 1, 'triggerAction must still be called even with no origin');
        assert.strictEqual(triggerActionCalls[0].targetTerminalOverride, undefined);
        assert.ok(outcome.payload.teamRouting, 'teamRouting must report the fallback');
        assert.ok(outcome.payload.teamRouting.includes('fell back'), 'teamRouting must say it fell back');
    });

    await test('explicit caller targetTerminalOverride is never overwritten', async () => {
        const { server, triggerActionCalls } = makeServer();
        const outcome = await server.performKanbanDispatch('/ws', 'plan-1', 'CODE REVIEWED', {
            targetTerminalOverride: 'my-explicit-choice',
            originTerminal: 'lead-1',   // would resolve to Coding-reviewer if not overridden
        });
        assert.strictEqual(triggerActionCalls[0].targetTerminalOverride, 'my-explicit-choice',
            'an explicit caller override must win over team-scoped resolution');
        assert.ok(!outcome.payload.teamRouting,
            'teamRouting must be absent when the caller supplied its own override — no team decision was made');
    });

    await test('resolveKanbanDispatch unwired (no gate) => teamRouting reports role-unavailable fallback, dispatch still fires', async () => {
        const { server, triggerActionCalls } = makeServer({
            resolveKanbanDispatch: undefined,   // unwired — standalone posture
            extra: { resolveTeamRoleTerminal: async () => 'should-not-be-called' },
        });
        const outcome = await server.performKanbanDispatch('/ws', 'plan-1', 'CODE REVIEWED', { originTerminal: 'lead-1' });
        assert.strictEqual(triggerActionCalls.length, 1, 'dispatch must still fire when gate is unwired');
        assert.ok(outcome.payload.teamRouting, 'teamRouting must report the fallback');
        assert.ok(outcome.payload.teamRouting.includes('role unavailable'),
            'teamRouting must name the role-unavailable fallback (audit item 13)');
    });

    await test('dispatched_terminal in record is used as origin when from is omitted', async () => {
        const { server, triggerActionCalls } = makeServer({
            record: { planId: 'plan-1', sessionId: 'plan-1', topic: 'Test',
                      kanbanColumn: 'CODER CODED', complexity: 5,
                      dispatchedAgent: 'unknown', dispatchedTerminal: 'lead-1', dispatchedIde: '' },
        });
        const outcome = await server.performKanbanDispatch('/ws', 'plan-1', 'CODE REVIEWED');
        assert.strictEqual(triggerActionCalls[0].targetTerminalOverride, 'Coding-reviewer',
            'dispatched_terminal in the record must be used as the origin when from is omitted');
        assert.ok(outcome.payload.teamRouting.includes('lead-1'),
            'teamRouting must name the origin resolved from the record');
    });

    await test('explicit from beats a CONFLICTING recorded dispatched_terminal at the call site', async () => {
        // Plan Verification item 2: "Assert explicit from beats a conflicting
        // recorded value at the call site." The record carries dispatched_terminal
        // lead-2 (a valid, non-filtered origin that the stub resolves to
        // Backend-reviewer), but the caller supplies from=lead-1. The call site
        // must prefer `from` over the recorded value — so the override is
        // Coding-reviewer (lead-1's reviewer), NOT Backend-reviewer (lead-2's).
        // This fails if the call site stops preferring `from`.
        const { server, triggerActionCalls } = makeServer({
            record: { planId: 'plan-1', sessionId: 'plan-1', topic: 'Test',
                      kanbanColumn: 'CODER CODED', complexity: 5,
                      dispatchedAgent: 'unknown', dispatchedTerminal: 'lead-2', dispatchedIde: '' },
        });
        const outcome = await server.performKanbanDispatch('/ws', 'plan-1', 'CODE REVIEWED', { originTerminal: 'lead-1' });
        assert.strictEqual(triggerActionCalls[0].targetTerminalOverride, 'Coding-reviewer',
            'from must win over the conflicting recorded dispatched_terminal');
        assert.notStrictEqual(triggerActionCalls[0].targetTerminalOverride, 'Backend-reviewer',
            'the recorded origin (lead-2) must NOT win when from is supplied');
        assert.ok(outcome.payload.teamRouting && outcome.payload.teamRouting.includes('lead-1'),
            'teamRouting must name lead-1 (the from), not lead-2 (the record)');
    });
}

// ── Item 5: custom-user branch regression ───────────────────────────────────

async function item5() {
    console.log('\n── Item 5: custom-user branch honours caller override (Change 4) ──');

    await test('custom-user branch reads msg.targetTerminalOverride before planner rotation', () => {
        // The custom-user branch (dispatchSpec.source === 'custom-user') used to
        // compute its own override for planner only and drop the caller's. The fix
        // gives it the same precedence as the built-in branch: caller override
        // first, then planner rotation.
        //
        // Locate the custom-user branch block and assert the override guard.
        const branchIdx = kanbanProviderTs.indexOf("dispatchSpec?.source === 'custom-user'");
        assert.ok(branchIdx > 0, 'custom-user branch must be present');
        const branch = kanbanProviderTs.slice(branchIdx, branchIdx + 2000);

        // The fix: `if (msg?.targetTerminalOverride)` ahead of the planner `else if`.
        assert.ok(
            /if\s*\(\s*msg\?\.targetTerminalOverride\s*\)/.test(branch),
            'custom-user branch must check msg.targetTerminalOverride — without this, a custom-configured CODE REVIEWED column silently discards team routing'
        );
        // And it must be an if/else if chain (not two independent ifs that would
        // let the planner rotation overwrite the caller override).
        assert.ok(
            /if\s*\(\s*msg\?\.targetTerminalOverride\s*\)\s*\{[\s\S]*?\}\s*else\s+if\s*\(\s*role\s*===\s*'planner'/.test(branch),
            'caller override must be an if/else-if with planner rotation — two independent ifs would let rotation overwrite the override'
        );
    });

    await test('built-in branch already had the override guard (unchanged by Change 4)', () => {
        // The built-in branch at :8817 already read msg.targetTerminalOverride.
        // Change 4 only adds the same guard to the custom-user branch. Verify the
        // built-in branch still has it.
        const builtInStart = kanbanProviderTs.indexOf('if (canDispatch) {');
        assert.ok(builtInStart > 0);
        // The IDE-lead sub-branch sits between the anchor and the override read
        // (~2190 chars in), so a 2000-char window stops just short of it.
        const builtIn = kanbanProviderTs.slice(builtInStart, builtInStart + 2600);
        assert.ok(
            /if\s*\(\s*msg\?\.targetTerminalOverride\s*\)/.test(builtIn),
            'built-in branch must still read msg.targetTerminalOverride (Change 4 does not touch it)'
        );
    });

    await test('the comment explains why both branches must honour the override', () => {
        // Load-bearing comment: explains the custom-user gap so it is not reintroduced.
        const commentIdx = kanbanProviderTs.indexOf('authoritative on BOTH branches');
        assert.ok(commentIdx > 0,
            'the comment explaining why both branches must honour the override must be present');
    });
}

// ── Item 6: single-team and no-team boards (no-op regression) ──────────────

async function item6() {
    console.log('\n── Item 6: single-team and no-team boards (no-op) ──');

    await test('single team: resolveTeamScopedRoleTerminal returns the only reviewer', async () => {
        const group = [{ id: 'team_solo', name: 'solo', source: 'manual',
            members: ['solo', 'solo-coder-1', 'solo-reviewer'],
            order:  ['solo', 'solo-coder-1', 'solo-reviewer'] }];
        const live = [
            { name: 'solo', role: 'lead' },
            { name: 'solo-coder-1', role: 'coder' },
            { name: 'solo-reviewer', role: 'reviewer' },
        ];
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb(group), originName: 'solo', role: 'reviewer',
            liveTerminals: live, normalizeRole,
        });
        // With one team, the team-scoped result IS the workspace-wide result.
        assert.strictEqual(r, 'solo-reviewer');
    });

    await test('zero groups: resolveTeamScopedRoleTerminal returns null (falls back to workspace-wide)', async () => {
        const r = await resolveTeamScopedRoleTerminal({
            db: fakeDb([]), originName: 'solo', role: 'reviewer',
            liveTerminals: [{ name: 'solo', role: 'lead' }], normalizeRole,
        });
        assert.strictEqual(r, null, 'no groups => null => caller falls back to today\'s workspace-wide resolution');
    });

    await test('no-team board: performKanbanDispatch falls back and still dispatches', async () => {
        const triggerActionCalls = [];
        const server = new LocalApiServer({
            workspaceRoot: '/ws',
            getAuthToken: async () => '',
            getRegisteredTerminals: () => ['some-reviewer'],
            getKanbanDatabase: async () => ({
                ensureReady: async () => true,
                getPlanByPlanId: async () => ({
                    planId: 'p', sessionId: 'p', topic: 'T',
                    kanbanColumn: 'CODER CODED', complexity: 5,
                    dispatchedAgent: '', dispatchedTerminal: '', dispatchedIde: '',
                }),
            }),
            kanbanVerb: async (verb, payload) => {
                if (verb === 'triggerAction') triggerActionCalls.push(payload);
                return { success: true };
            },
            resolveKanbanDispatch: async () => ({ role: 'reviewer', cliTriggersEnabled: true, dragDropMode: null, source: null }),
            resolveTeamRoleTerminal: async () => null,  // no teams => null
        });
        const outcome = await server.performKanbanDispatch('/ws', 'p', 'CODE REVIEWED', { originTerminal: 'nobody' });
        assert.strictEqual(triggerActionCalls.length, 1, 'dispatch must still fire');
        assert.strictEqual(triggerActionCalls[0].targetTerminalOverride, undefined,
            'no teams => no override => workspace-wide resolution downstream');
        assert.ok(outcome.payload.teamRouting && outcome.payload.teamRouting.includes('fell back'),
            'teamRouting must name the fallback for a no-team board');
    });

    await test('the fleet first-match fallback is unchanged (team check is before it, not replacing it)', () => {
        // _resolveAgentTerminalForPlan must still have the fleet first-match after
        // the team check. The team check is additive, not a replacement.
        const methodStart = taskViewerTs.indexOf('private async _resolveAgentTerminalForPlan(');
        assert.ok(methodStart > 0);
        // `_getAgentNameForRole` is the method's LAST line (~1810 chars in), so
        // the window has to span the whole method body.
        const method = taskViewerTs.slice(methodStart, methodStart + 2200);
        assert.ok(method.includes('ptyListTerminals'), 'fleet consultation must still be present');
        assert.ok(method.includes('_getAgentNameForRole'), 'role fallback must still be present');
        assert.ok(method.includes('resolveTeamRoleTerminal'), 'team check must be present');
        // Ordering: team check AFTER worktree match, BEFORE fleet first-match.
        const wtIdx = method.indexOf('_findTerminalNameByWorktreePathAndRole');
        const teamIdx = method.indexOf('resolveTeamRoleTerminal');
        const fleetIdx = method.indexOf('ptyListTerminals');
        assert.ok(wtIdx > -1 && teamIdx > -1 && fleetIdx > -1, 'all three resolution steps must be present');
        assert.ok(wtIdx < teamIdx, 'worktree match must come before team check');
        assert.ok(teamIdx < fleetIdx, 'team check must come before fleet first-match');
    });
}

// ── Item 7: planner rotation regression ─────────────────────────────────────

async function item7() {
    console.log('\n── Item 7: planner rotation cursor (custom-user precedence edit) ──');

    await test('custom-user branch: planner rotation is in else-if (cursor untouched when caller override wins)', () => {
        // The plan's edge case: "The planner rotation cursor must still advance
        // only on a successful dispatch. The else if keeps the cursor untouched
        // when a caller override wins, which is correct — no planner slot was
        // consumed."
        const branchIdx = kanbanProviderTs.indexOf("dispatchSpec?.source === 'custom-user'");
        assert.ok(branchIdx > 0);
        // The cursor advance sits after the dispatchConfiguredKanbanColumnAction
        // call (~2800 chars in), past a 2000-char window.
        const branch = kanbanProviderTs.slice(branchIdx, branchIdx + 3200);
        // The advance must be gated on `dispatched && plannerCursorLocationKey`.
        assert.ok(
            /if\s*\(\s*dispatched\s*&&\s*plannerCursorLocationKey/.test(branch),
            'planner cursor must advance only on successful dispatch (dispatched && plannerCursorLocationKey)'
        );
        // And plannerCursorLocationKey is only set in the else-if branch, so a
        // caller override leaves it undefined and the advance is a no-op.
        assert.ok(
            /else\s+if\s*\(\s*role\s*===\s*'planner'[\s\S]*plannerCursorLocationKey\s*=\s*locationKey/.test(branch),
            'plannerCursorLocationKey must be set only in the planner else-if — a caller override leaves it undefined'
        );
    });

    await test('built-in branch: planner rotation advance is unchanged (gated on dispatched)', () => {
        // The built-in branch gates the advance in TWO nested levels, not one flat
        // conjunction: `if (dispatched && workspaceRoot) { if (plannerCursorLocationKey
        // && tvp) { advance } }`. That is the shipped shape and Change 4 does not
        // touch it — asserting a single `dispatched && plannerCursorLocationKey && tvp`
        // conjunction fails on correct source because that expression never existed.
        const builtInStart = kanbanProviderTs.indexOf('if (canDispatch) {');
        assert.ok(builtInStart > 0);
        const builtIn = kanbanProviderTs.slice(builtInStart, builtInStart + 4000);
        const outerIdx = builtIn.search(/if\s*\(\s*dispatched\s*&&\s*workspaceRoot\s*\)/);
        assert.ok(outerIdx > -1,
            'built-in branch must still gate its post-dispatch block on dispatched && workspaceRoot');
        const innerIdx = builtIn.search(/if\s*\(\s*plannerCursorLocationKey\s*&&\s*tvp\s*\)/);
        assert.ok(innerIdx > -1,
            'built-in branch planner cursor advance must still be gated on plannerCursorLocationKey && tvp');
        assert.ok(innerIdx > outerIdx,
            'the cursor advance must sit INSIDE the dispatched guard — advancing on a failed dispatch skips a planner slot');
        const advanceIdx = builtIn.indexOf('advancePlannerRotationCursor');
        assert.ok(advanceIdx > innerIdx,
            'advancePlannerRotationCursor must be inside the plannerCursorLocationKey && tvp guard');
    });

    await test('resolveTeamScopedRoleTerminal is role-generic (not reviewer-specific)', () => {
        // The plan says the helper must be role-generic so tester can be wired later.
        // Verify the helper does not hardcode 'reviewer'.
        const helperStart = teamWiringTs.indexOf('export async function resolveTeamScopedRoleTerminal');
        assert.ok(helperStart > 0);
        const helper = teamWiringTs.slice(helperStart, helperStart + 1500);
        assert.ok(!/'reviewer'/.test(helper),
            'resolveTeamScopedRoleTerminal must not hardcode reviewer — it is role-generic for future tester wiring');
        assert.ok(helper.includes('role'), 'helper must accept a role parameter');
    });
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\nRunning team-scoped reviewer routing verification tests\n');

    await item1();
    await item2();
    await item3();
    await item4();
    await item5();
    await item6();
    await item7();

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
    console.error('FATAL:', err);
    process.exit(1);
});
