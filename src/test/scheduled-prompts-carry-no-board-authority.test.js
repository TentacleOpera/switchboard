'use strict';

/**
 * "A scheduled agent never moves a card" — the executable half of that rule.
 *
 * The `canMoveCards` checkbox was deleted because it was inverted: unticked it
 * restricted nothing, and ticked it appended BOARD_DRIVING_CONTRACT, handing an
 * unattended 03:00 job the sanctioned card-move route with none of the dispatch
 * guards (no in-flight 409, no recorded holder). Board actions are now
 * host-executed; agent prompts carry no board authority.
 *
 * Deleting the gate is not self-enforcing — nothing stops the next person
 * re-adding a `canMoveCards` branch to buildTeamAutomationPrompt, and every
 * other gate would stay green. This is that gate.
 *
 * SCOPE — buildTeamAutomationPrompt and buildFetchPlansPrompt only.
 * buildReconcilePrompt is deliberately EXCLUDED: it still moves cards by prose
 * and will until reconcile-becomes-host-code.md lands. It is asserted here as a
 * POSITIVE (it must still carry the contract), so that when reconcile becomes
 * host code this file fails and forces the exclusion to be revisited rather
 * than silently outliving its reason.
 *
 * Honest limit: an agent with shell access can still run move-card.js whatever
 * its prompt says. This removes the reason and the instruction, not the
 * capability.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const {
    BOARD_DRIVING_CONTRACT,
    buildTeamAutomationPrompt,
    buildFetchPlansPrompt,
    buildReconcilePrompt,
} = require(path.join(process.cwd(), 'out', 'services', 'schedulerPresets.js'));

let passed = 0;
let failed = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
        passed++;
    } catch (err) {
        console.error(`  ❌ ${name}\n     ${err.message}`);
        failed++;
    }
}

// The literal route strings an agent would need to act on. Asserting the
// contract's TEXT, not the constant's NAME — the identifier never appears in
// output, so a name-only assertion can never fail and would be theatre.
const ROUTE_MARKERS = ['move-card.js', '/kanban/move', 'kanban_operations'];

function assertNoBoardAuthority(label, output) {
    assert.strictEqual(typeof output, 'string', `${label} must return a string`);
    assert.ok(!output.includes(BOARD_DRIVING_CONTRACT),
        `${label} must not emit BOARD_DRIVING_CONTRACT`);
    for (const marker of ROUTE_MARKERS) {
        assert.ok(!output.includes(marker),
            `${label} must not reference ${marker} — that is board authority by prose`);
    }
}

function run() {
    console.log('scheduled prompts carry no board authority\n');

    check('buildTeamAutomationPrompt emits no board authority (plain job)', () => {
        assertNoBoardAuthority('buildTeamAutomationPrompt', buildTeamAutomationPrompt({
            promptOverride: 'Do the work.',
            teamTarget: { groupId: 'g1', role: 'lead' },
        }));
    });

    check('buildTeamAutomationPrompt ignores a stale canMoveCards: true from an old config', () => {
        // The field is gone from the type, but jobs live in a shared config blob
        // on ~4,000 installs — a persisted job may still carry it at runtime.
        // It must be inert, not honoured.
        assertNoBoardAuthority('buildTeamAutomationPrompt (stale canMoveCards)', buildTeamAutomationPrompt({
            promptOverride: 'Do the work.',
            teamTarget: { groupId: 'g1', role: 'lead', canMoveCards: true },
        }));
    });

    check('buildTeamAutomationPrompt emits no board authority for a sourceConfig prompt', () => {
        assertNoBoardAuthority('buildTeamAutomationPrompt (sourceConfig)', buildTeamAutomationPrompt({
            sourceConfig: { prompt: 'Nightly tidy.', canMoveCards: true },
        }));
    });

    check('buildTeamAutomationPrompt emits no board authority for the default prompt', () => {
        assertNoBoardAuthority('buildTeamAutomationPrompt (default)', buildTeamAutomationPrompt({}));
    });

    check('buildFetchPlansPrompt emits no board authority', () => {
        assertNoBoardAuthority('buildFetchPlansPrompt', buildFetchPlansPrompt({
            id: 'job_1',
            sourceConfig: {},
        }));
    });

    check('no canMoveCards gate has been re-added to the prompt builder', () => {
        const src = fs.readFileSync(
            path.join(process.cwd(), 'src', 'services', 'schedulerPresets.ts'), 'utf8');
        const fnIdx = src.indexOf('export function buildTeamAutomationPrompt');
        assert.ok(fnIdx >= 0, 'buildTeamAutomationPrompt must exist in schedulerPresets.ts');
        // The signature destructures an inline object type, so its `}): string {`
        // is the FIRST `\n}` after fnIdx. Anchor on the opening brace of the
        // function body itself, or the slice is just the parameter list and the
        // assertions below can never fail.
        const bodyStart = src.indexOf('): string {', fnIdx);
        assert.ok(bodyStart > fnIdx, 'could not locate buildTeamAutomationPrompt body');
        const body = src.slice(bodyStart, src.indexOf('\n}', bodyStart) + 2);
        assert.ok(body.includes('return basePrompt'),
            'body slice must reach the function return — otherwise this check is vacuous');
        // The "do not re-add" comment names the field, so match a real branch on
        // it rather than any mention.
        assert.ok(!/if\s*\([^)]*canMoveCards/.test(body),
            'buildTeamAutomationPrompt must not branch on canMoveCards — that gate was deleted as inverted');
        assert.ok(!body.includes('BOARD_DRIVING_CONTRACT'),
            'buildTeamAutomationPrompt must not reference BOARD_DRIVING_CONTRACT at all');
    });

    check('the BOARD_DRIVING_CONTRACT constant is NOT deleted (it has live consumers)', () => {
        assert.strictEqual(typeof BOARD_DRIVING_CONTRACT, 'string');
        assert.ok(BOARD_DRIVING_CONTRACT.includes('move-card.js'),
            'the constant must still carry the sanctioned route for its remaining consumers');
    });

    check('buildReconcilePrompt STILL carries the contract — exclusion is live, not forgotten', () => {
        // Fails deliberately when reconcile-becomes-host-code.md lands, which is
        // the moment this file's scope exclusion must be revisited.
        const out = buildReconcilePrompt();
        assert.ok(out.includes(BOARD_DRIVING_CONTRACT),
            'buildReconcilePrompt is the documented exception until reconcile-becomes-host-code.md lands; '
            + 'if that has landed, delete this assertion and add reconcile to the no-authority set above');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed > 0) { process.exit(1); }
    console.log('scheduled prompts carry no board authority — contract passed');
}

run();
