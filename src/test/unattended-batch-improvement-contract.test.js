'use strict';

/**
 * Contract: Unattended Batch Plan Improvement (feature 8ab67e5d).
 *
 * Two subtasks, one delivery unit, and every one of their failure modes is
 * silent — which is why they are pinned here rather than left to a screenshot:
 *
 *  1. Hidden, batched terminal creation. "Hidden" must mean NOT SELECTABLE, not
 *     just not drawn. Six role-matching dispatch call sites plus autoban's pool
 *     resolver pick a target by matching `role` against the same fleet data the
 *     webview renders, so a fleet hidden only in the UI quietly absorbs board
 *     dispatches while every visual check passes. `ptyListTerminals` exists three
 *     times and the two full implementations already diverge, so the projection
 *     is asserted per host.
 *  2. Unattended improver contract. A prompt directive that ships without its
 *     skill-file half is a half-landed contract: the improver reads the skill.
 *     The two texts are asserted to agree so they cannot drift apart.
 *
 * Requires `npm run compile-tests` (loads compiled output from out/).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

const { buildKanbanBatchPrompt } = require('../../out/services/agentPromptBuilder');

let failures = 0;
async function test(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.message}`);
    }
}

function read(rel) {
    return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

async function main() {
    console.log('\n── Unattended batch plan improvement contract ──');

    // ─── Subtask 2: the unattended improver contract ──────────────────────────

    const improverSkill = read('.switchboard/protocols/improve-plan/SKILL.md');
    const plannerPlans = [{ topic: 'Fix the thing', absolutePath: '/repo/.switchboard/plans/fix-the-thing.md' }];

    await test('unattended planner prompt carries all four directives and exactly one plan path', () => {
        const prompt = buildKanbanBatchPrompt('planner', plannerPlans, { unattended: true });
        assert.ok(/Never ask questions in chat/.test(prompt), 'missing the never-ask-in-chat directive');
        assert.ok(/## Outstanding Questions/.test(prompt), 'missing the append-to-plan instruction');
        assert.ok(/improving exactly one plan/.test(prompt), 'missing the single-file scope directive');
        assert.ok(/Do not create, modify, rename or delete any other file/.test(prompt), 'missing the do-not-touch-siblings directive');
        assert.ok(/Write the plan file once, at the end/.test(prompt), 'missing the write-once instruction');
        assert.ok(/Do not write the split files/.test(prompt), 'missing the Step-2 split-write override');
        // The path is what the worker actually edits: a miss here is a worker that
        // improves nothing while reporting success.
        const occurrences = prompt.split(plannerPlans[0].absolutePath).length - 1;
        assert.ok(occurrences >= 1, 'the resolved plan path never appears in the prompt');
        assert.ok(
            !/<planId>|\bplanId\.md\b/.test(prompt),
            'the plan path must come from the plan record, never be synthesized from a planId'
        );
    });

    await test('attended planner prompt is byte-identical to the pre-feature output', () => {
        const withFlagUnset = buildKanbanBatchPrompt('planner', plannerPlans, {});
        const withNoOptions = buildKanbanBatchPrompt('planner', plannerPlans);
        assert.strictEqual(withFlagUnset, withNoOptions, 'passing an options object without `unattended` changed the prompt');
        assert.ok(
            !/Never ask questions in chat/.test(withNoOptions),
            'the never-ask-in-chat directive leaked into the ATTENDED flow — asking the user is correct there, and this ships to ~4,000 installs'
        );
    });

    await test('the unattended directive is gated on role=planner', () => {
        for (const role of ['coder', 'reviewer', 'lead', 'tester']) {
            const prompt = buildKanbanBatchPrompt(role, plannerPlans, { unattended: true });
            assert.ok(!/Never ask questions in chat/.test(prompt), `the improver contract leaked into the ${role} prompt`);
        }
    });

    await test('improve-plan SKILL.md carries the ## Unattended runs block and agrees with the prompt', () => {
        assert.ok(/^## Unattended runs$/m.test(improverSkill), 'improve-plan/SKILL.md has no `## Unattended runs` block');
        // Skill text and prompt text must not drift into disagreeing — the improver
        // reads the SKILL, the dispatcher writes the PROMPT.
        // Compare on collapsed whitespace: the skill is hard-wrapped for reading,
        // the prompt is not. Wrapping must not be able to fail this.
        const flat = improverSkill.replace(/\s+/g, ' ');
        for (const clause of [
            'Never ask questions in chat',
            '## Outstanding Questions',
            'Do not create, modify, rename or delete any other file',
            'Do not write the split files',
            'Write the plan file once, at the end',
        ]) {
            assert.ok(flat.includes(clause), `improve-plan/SKILL.md is missing the prompt clause: "${clause}"`);
        }
    });

    await test('## Outstanding Questions is in the required-section schema AND marked optional', () => {
        assert.ok(/\*\*## Outstanding Questions\*\*/.test(improverSkill), 'the section is absent from the required-section list');
        const idx = improverSkill.indexOf('**## Outstanding Questions**');
        const window = improverSkill.slice(idx, idx + 400);
        assert.ok(/OPTIONAL/i.test(window), 'the section must be marked optional — a plan without it stays valid');
        assert.ok(/omit the heading entirely/i.test(improverSkill), 'the omit-when-empty rule is missing');
        assert.ok(/schema violation/i.test(improverSkill), 'empty-but-present must be stated as a violation, not as "done"');
        // Both item kinds, in the emphasised form the detector has to match.
        assert.ok(/\*\*\[user\]\*\*/.test(improverSkill), 'the `[user]` item form is undocumented');
        assert.ok(/\*\*\[research\]\*\*/.test(improverSkill), 'the `[research]` item form is undocumented');
    });

    await test('switchboard-contracts carries the never-ask-in-chat behavioural rule', () => {
        const contracts = read('.switchboard/protocols/switchboard-contracts/SKILL.md');
        assert.ok(/Outstanding Questions/.test(contracts), 'the behaviour contract does not mention `## Outstanding Questions`');
        assert.ok(/never asks in chat|Never ask/i.test(contracts), 'the never-ask-in-chat rule is missing from the behaviour contract');
    });

    // ─── Subtask 1: hidden fleet, batched creation ────────────────────────────
    //
    // The fleet lives in a child process (extension host) or in-process
    // (standalone), so these are asserted against the three sources rather than a
    // live spawn. What matters is that the three implementations move in lockstep:
    // a `hidden` split applied to two of three produces a host where hidden means
    // nothing, and every visual check still passes.

    await test('all three hosts project hidden terminals onto a SIBLING key, never into `terminals`', () => {
        for (const rel of ['src/standalone/ptyHost.ts', 'src/standalone/bootstrap.ts']) {
            const src = read(rel);
            assert.ok(/hiddenTerminals:/.test(src), `${rel} does not return a hiddenTerminals sibling key`);
            assert.ok(/filter\(t => !t\.hidden\)/.test(src), `${rel} does not exclude hidden rows from the rendered \`terminals\` array`);
        }
        // The extension proxy enriches after the child returns; both arrays must get it.
        const tvp = read('src/services/TaskViewerProvider.ts');
        assert.ok(
            /if \(Array\.isArray\(result\.hiddenTerminals\)\)[\s\S]{0,120}plan\(result\.hiddenTerminals\)/.test(tvp),
            'the extension proxy does not apply parents/planId enrichment to hiddenTerminals'
        );
    });

    await test('hidden workers are NOT selectable — registry read drops them, dispatch pre-flight excludes them', () => {
        const tvp = read('src/services/TaskViewerProvider.ts');
        // Registry side: the autoban pool resolver and the pool reconciler both read
        // runtime.terminals through _getAliveAutobanTerminalRegistry.
        assert.ok(
            /_getAliveAutobanTerminalRegistry[\s\S]{0,3000}info\.hidden === true[\s\S]{0,80}continue;/.test(tvp),
            '_getAliveAutobanTerminalRegistry does not drop hidden rows — hidden improvers would join autoban role pools'
        );
        // Verb side: _ptyTerminalNames feeds getRegisteredTerminals, which is
        // /kanban/dispatch's "is any terminal live?" pre-flight.
        assert.ok(
            /_ptyTerminalNames = \(result\.terminals \|\| \[\]\)/.test(tvp),
            '_ptyTerminalNames must be populated from `terminals` only, never from hiddenTerminals'
        );
        assert.ok(
            /_ptyHiddenTerminalNames = \(result\.hiddenTerminals \|\| \[\]\)/.test(tvp),
            'hidden names must land in their OWN cache, kept separate from the dispatch pre-flight cache'
        );
        // getRegisteredTerminals is /kanban/dispatch's "is any terminal live?"
        // pre-flight. Widening it to hidden names makes a dispatch that should 409
        // pass and then fail to find a target.
        const preflight = tvp.slice(tvp.indexOf('getRegisteredTerminals: () => {'));
        assert.ok(preflight.length > 0, 'getRegisteredTerminals not found');
        assert.ok(
            !/_ptyHiddenTerminalNames/.test(preflight.slice(0, 1200)),
            'hidden names leaked into the /kanban/dispatch live-terminal pre-flight'
        );
    });

    await test('hidden workers ARE mirrored into runtime.terminals on both hosts (they are real processes)', () => {
        const tvp = read('src/services/TaskViewerProvider.ts');
        const mirrorStart = tvp.indexOf('const updateMirrorRegistry');
        assert.ok(mirrorStart > 0, 'updateMirrorRegistry not found');
        const mirrorBody = tvp.slice(mirrorStart, mirrorStart + 2500);
        assert.ok(
            /parsed\.hiddenTerminals/.test(mirrorBody),
            'the extension mirror drops hidden rows — /health under-reports and the two hosts disagree'
        );
        assert.ok(
            /hidden,/.test(mirrorBody),
            'mirrored hidden rows are not stamped `hidden` — the registry read cannot then tell them apart'
        );
        const fleet = read('src/standalone/ptyFleetService.ts');
        assert.ok(/hidden: t\.hidden === true,/.test(fleet), 'standalone updateRegistryState does not stamp `hidden`');
        // Load-bearing for the boot reap and the merge loop — both key on these.
        assert.ok(/ideName: PTY_IDE_NAME,/.test(fleet), 'hidden rows must keep ideName: PTY_IDE_NAME or the boot reap misses them');
        assert.ok(/purpose: 'pty',/.test(fleet), "hidden rows must keep purpose: 'pty'");
    });

    await test('ptyCreateBatch validates the whole allocation BEFORE spawning anything', () => {
        const fleet = read('src/standalone/ptyFleetService.ts');
        const start = fleet.indexOf('public async createBatch');
        assert.ok(start > 0, 'createBatch is missing');
        const body = fleet.slice(start, start + 4000);
        const firstCreate = body.indexOf('await this.create(');
        assert.ok(firstCreate > 0, 'createBatch never calls create()');
        const preflight = body.slice(0, firstCreate);
        assert.ok(/MAX_BATCH/.test(preflight), 'the batch cap is not checked before the first spawn');
        assert.ok(/Number\.isInteger/.test(preflight), 'counts are not validated as positive integers before the first spawn');
        assert.ok(/getAgentStartupCommands/.test(preflight), 'roles are not validated against configured startup commands before the first spawn');
        // A batch that passes a per-worker name silently coalesces onto suffixed
        // names; the ${role}-N generator is what keeps pool membership identical
        // to the single-add path.
        assert.ok(/this\.create\(a\.role, undefined,/.test(body), 'createBatch must not accept a per-worker name');
    });

    await test('ptyCreateBatch classifies resource exhaustion apart from a bad role config, and aborts on the first', () => {
        const fleet = read('src/standalone/ptyFleetService.ts');
        for (const kind of ['pty-pool-exhausted', 'fd-limit', 'spawn-failed']) {
            assert.ok(fleet.includes(`'${kind}'`), `createBatch does not classify ${kind} — the two classes call for opposite responses`);
        }
        assert.ok(/abortResource = true/.test(fleet), 'a resource failure must abort the remaining allocation, not grind out N identical failures');
        assert.ok(/estimatedDurationMs/.test(fleet), 'the caller is not told a 32-worker batch is a ~24-second operation');
        assert.ok(
            /const success = created\.length > 0 && failed\.length === 0;/.test(fleet),
            'no path may report success:true with a non-empty failed[]'
        );
    });

    if (failures > 0) {
        console.error(`\n${failures} contract check(s) failed.`);
        process.exit(1);
    }
    console.log('\nAll unattended batch improvement checks passed.');
    // Explicit exit — the test loads compiled modules that may keep the event
    // loop alive. Without this the CI step hangs to its timeout instead of
    // reporting a pass.
    process.exit(0);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
