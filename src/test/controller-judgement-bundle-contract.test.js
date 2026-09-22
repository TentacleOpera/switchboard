'use strict';

/**
 * Contract: the judgement bundle can see a seat that is busy doing the wrong
 * thing (plan:
 * the-judgement-bundle-cannot-see-a-seat-that-is-busy-doing-the-wrong-thing).
 *
 * These are BEHAVIOURAL assertions against the compiled modules in `out/`, not
 * source greps. The distinction is the point: a grep for `cpu` in `matrix.ts`
 * passes whether or not a rate is ever computed correctly, and the defects this
 * plan is about — a rate computed across a pid recycle, a lease state that
 * collapses "stale" into "judging", a model conclusion laundered into a
 * remediation — are all invisible to a text search.
 *
 * Run with:
 *   npm run compile-tests && npm run test:contract:judgement-bundle
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'out');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err && err.message ? err.message : err}`);
    }
}

function requireOut(rel) {
    const full = path.join(OUT, rel);
    if (!fs.existsSync(full)) {
        throw new Error(`${rel} is missing from out/ — run \`npm run compile-tests\` first`);
    }
    return require(full);
}

function run() {
    console.log('\nContract: the judgement bundle sees a seat busy doing the wrong thing\n');

    const matrix = requireOut('standalone/controller/matrix.js');
    const flags = requireOut('standalone/judgement/flags.js');
    const classes = requireOut('standalone/judgement/classes.js');
    const sample = requireOut('standalone/controller/sample.js');
    const suppression = requireOut('services/nudgeSuppression.js');

    // ── 1. The ungated path is not regressed ──────────────────────────────

    check('every judgement row still carries condition.kind === judgement', () => {
        const judged = matrix.DEFAULT_MATRIX_ROWS.filter(r => r.judge === 'model');
        assert.ok(judged.length >= 7, `expected at least 7 model-judged rows, got ${judged.length}`);
        for (const row of judged) {
            assert.strictEqual(row.condition.kind, 'judgement',
                `row '${row.id}' is model-judged but its condition kind is '${row.condition.kind}'`);
        }
    });

    check('no judgement row has acquired a mechanical precondition', () => {
        // The failure this guards: a "cheap pre-filter" added in front of the
        // model turns the judgement path back into a classifier for failures
        // mechanical detection already found.
        const mechanicalKinds = matrix.MATRIX_CONDITION_KINDS.filter(k => k !== 'judgement');
        for (const row of matrix.DEFAULT_MATRIX_ROWS) {
            if (row.condition.kind !== 'judgement') { continue; }
            for (const kind of mechanicalKinds) {
                assert.ok(!JSON.stringify(row.condition).includes(kind),
                    `judgement row '${row.id}' references the mechanical kind '${kind}'`);
            }
        }
    });

    // ── 2. The bundle carries the collected signals ───────────────────────

    check('every judgement row requests cpu, rss and lastWrite by name', () => {
        for (const row of matrix.DEFAULT_MATRIX_ROWS) {
            if (row.condition.kind !== 'judgement') { continue; }
            for (const field of ['cpu', 'rss', 'lastWrite']) {
                assert.ok(row.condition.fields.includes(field),
                    `row '${row.id}' does not request '${field}'`);
            }
        }
    });

    check('every judgement row carries the card, on every row', () => {
        for (const row of matrix.DEFAULT_MATRIX_ROWS) {
            if (row.condition.kind !== 'judgement') { continue; }
            assert.ok(row.condition.fields.includes('card'),
                `row '${row.id}' does not request the card — the threshold stops being task-dependent`);
        }
    });

    // ── 3. CPU rate correctness ───────────────────────────────────────────

    const table = (rows) => {
        const byPid = new Map();
        const childrenOf = new Map();
        for (const r of rows) {
            byPid.set(r.pid, r);
            const sib = childrenOf.get(r.ppid);
            if (sib) { sib.push(r.pid); } else { childrenOf.set(r.ppid, [r.pid]); }
        }
        return { available: true, byPid, childrenOf, source: 'test:/proc' };
    };

    check('a pid whose start time changed reports no previous sample, never a rate', () => {
        const t = table([{ pid: 100, ppid: 1, jiffies: 9000, startTime: 777, rssBytes: 1024 }]);
        const result = sample.sampleSeat({
            pid: 100,
            // Same pid, DIFFERENT start time: the slot was recycled.
            previous: { pid: 100, startTime: 555, jiffies: 10, atMs: 1_000 },
            table: t,
            nowMs: 61_000,
        });
        assert.strictEqual(result.cpu.available, false, 'a recycled pid must not produce a rate');
        assert.ok(/replaced since the last wake/.test(result.cpu.reason),
            `reason must name the recycle, got: ${result.cpu.reason}`);
    });

    check('a matching pid and start time produces a real rate', () => {
        const t = table([{ pid: 100, ppid: 1, jiffies: 3010, startTime: 555, rssBytes: 1024 }]);
        // 3000 ticks over 60s at 100 ticks/s == 30s of CPU == 50%.
        const result = sample.sampleSeat({
            pid: 100,
            previous: { pid: 100, startTime: 555, jiffies: 10, atMs: 1_000 },
            table: t,
            nowMs: 61_000,
        });
        assert.strictEqual(result.cpu.available, true, `expected a rate, got: ${result.cpu.reason}`);
        assert.ok(Math.abs(result.cpu.value - 50) < 0.001, `expected ~50%, got ${result.cpu.value}`);
    });

    check('the first sample for a seat reports no rate rather than zero', () => {
        const t = table([{ pid: 100, ppid: 1, jiffies: 3010, startTime: 555, rssBytes: 1024 }]);
        const result = sample.sampleSeat({ pid: 100, previous: null, table: t, nowMs: 61_000 });
        assert.strictEqual(result.cpu.available, false);
        assert.ok(/two readings/.test(result.cpu.reason), result.cpu.reason);
    });

    // ── 4. The process TREE, not the shell ────────────────────────────────

    check('an idle shell with a busy child agent reports non-zero CPU', () => {
        const t = table([
            { pid: 100, ppid: 1, jiffies: 5, startTime: 555, rssBytes: 1024 },      // the shell: idle
            { pid: 101, ppid: 100, jiffies: 3000, startTime: 556, rssBytes: 2048 }, // the agent CLI: busy
            { pid: 102, ppid: 101, jiffies: 5, startTime: 557, rssBytes: 512 },     // a grandchild
        ]);
        const result = sample.sampleSeat({
            pid: 100,
            previous: { pid: 100, startTime: 555, jiffies: 10, atMs: 1_000 },
            table: t,
            nowMs: 61_000,
        });
        assert.strictEqual(result.cpu.available, true, `expected a rate, got: ${result.cpu.reason}`);
        assert.ok(result.cpu.value > 40, `a busy child must show as busy, got ${result.cpu.value}%`);
        assert.strictEqual(result.treeSize, 3, 'the whole tree must be walked');
        assert.strictEqual(result.rss.value, 1024 + 2048 + 512, 'RSS must sum over the tree');
    });

    check('a cycle in the process table cannot hang the walk', () => {
        const t = table([
            { pid: 100, ppid: 101, jiffies: 1, startTime: 1, rssBytes: 0 },
            { pid: 101, ppid: 100, jiffies: 1, startTime: 2, rssBytes: 0 },
        ]);
        const tree = sample.collectTree(100, t);
        assert.deepStrictEqual(tree.sort(), [100, 101]);
    });

    // ── 5. No /proc degrades the fields, not the wake ─────────────────────

    check('an unavailable process table reports a reason and still returns', () => {
        const t = { available: false, byPid: new Map(), childrenOf: new Map(), source: '/proc/<pid>/stat', reason: '/proc is not readable on this host' };
        const result = sample.sampleSeat({ pid: 100, previous: null, table: t, nowMs: 1 });
        assert.strictEqual(result.cpu.available, false);
        assert.strictEqual(result.rss.available, false);
        assert.ok(result.cpu.reason.length > 0, 'the reason must be carried, not left blank');
    });

    check('/proc/<pid>/stat parses a comm containing spaces and parentheses', () => {
        // The trap: splitting the whole line on whitespace misaligns every
        // later field, so a naive parser silently reports another field's
        // value as the start time.
        // Index 0 is field 3 (state), so utime/stime (fields 14/15) sit at
        // indices 11/12, starttime (22) at 19 and rss (24) at 21.
        const fields = ['R', '7', '7', '0', '-1', '4194304', '100', '0', '0', '0', '0',
            '111', '222', '0', '0', '20', '0', '1', '0', '98765', '1000', '250'];
        const line = `42 (we (irdly) named) ${fields.join(' ')}`;
        const row = sample.parseProcStat(line);
        assert.strictEqual(row.pid, 42);
        assert.strictEqual(row.ppid, 7);
        assert.strictEqual(row.jiffies, 111 + 222);
        assert.strictEqual(row.startTime, 98765);
        assert.strictEqual(row.rssBytes, 250 * 4096);
    });

    // ── 6. The write basis is reported ────────────────────────────────────

    check('a write scan reports which tree it scanned', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-writescan-'));
        fs.writeFileSync(path.join(dir, 'a.txt'), 'x');
        const scan = sample.scanLastWrite({ dir, basis: 'whole worktree', nowMs: Date.now() });
        assert.strictEqual(scan.available, true);
        assert.strictEqual(scan.basis, 'whole worktree', 'the basis must be carried through verbatim');
        assert.ok(scan.ageMs !== null && scan.ageMs >= 0);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    check('an unreadable worktree is unavailable with a reason, not "never written"', () => {
        const scan = sample.scanLastWrite({ dir: path.join(os.tmpdir(), 'sb-does-not-exist-' + Date.now()), basis: 'whole worktree', nowMs: Date.now() });
        assert.strictEqual(scan.available, false, 'a missing directory must not read as "no writes"');
        assert.ok(/not readable/.test(scan.reason), scan.reason);
    });

    check('a seat with no directory says so rather than reporting never', () => {
        const scan = sample.scanLastWrite({ dir: null, basis: 'none', nowMs: Date.now() });
        assert.strictEqual(scan.available, false);
        assert.ok(/no worktree or cwd/.test(scan.reason), scan.reason);
    });

    check('durations are quantised to minutes so an unchanged board renders identically', () => {
        assert.strictEqual(sample.renderDuration(47 * 60_000), '47m');
        assert.strictEqual(sample.renderDuration(47 * 60_000 + 900), '47m', 'sub-minute jitter must not change the bundle');
        assert.strictEqual(sample.renderDuration(null), 'never');
    });

    // ── 7. Tier 1 emits no conclusion ─────────────────────────────────────

    check('a reply containing a diagnosis term is rejected', () => {
        for (const term of ['stuck', 'looping', 'overthinking', 'wedged', 'crashed']) {
            const parsed = flags.parseFlagsReply(`SEAT: coder-1 | FLAGS: ${term}`);
            assert.strictEqual(parsed.ok, false, `'${term}' must be rejected`);
            assert.ok(/conclusion/.test(parsed.error), `the rejection must say why: ${parsed.error}`);
        }
    });

    check('a flag outside the closed set is rejected, never coerced', () => {
        const parsed = flags.parseFlagsReply('SEAT: coder-1 | FLAGS: no-writes-at-all');
        assert.strictEqual(parsed.ok, false);
        assert.ok(/outside the closed set/.test(parsed.error), parsed.error);
    });

    check('a reply with no FLAGS: line means the rule did not run', () => {
        assert.strictEqual(flags.parseFlagsReply('I think the seat is fine.').ok, false);
        assert.strictEqual(flags.parseFlagsReply('').ok, false);
        assert.strictEqual(flags.parseFlagsReply(null).ok, false);
    });

    check('the plan\'s own example shape parses, and its duration suffix is discarded', () => {
        const parsed = flags.parseFlagsReply('SEAT: coder-1 | FLAGS: no-write-47m, card-implement');
        assert.strictEqual(parsed.ok, true, parsed.error);
        assert.deepStrictEqual(parsed.flags, ['no-write', 'card-implement'],
            'the measured duration is the controller\'s, not the model\'s');
        assert.strictEqual(parsed.seat, 'coder-1');
    });

    // ── 8. A research card is judged against what it asked for ────────────

    const PRIORS_IDLE = { finishedOnEarlierRound: false, noFinishedThisRound: true, wroteThisRound: false, atRest: true };

    check('no-write + an IMPLEMENT card is the research loop', () => {
        assert.strictEqual(flags.deriveClass(['no-write', 'card-implement'], PRIORS_IDLE), 'research-loop');
    });

    check('no-write + a RESEARCH card is left alone', () => {
        // The same write history, a different card. This is the whole reason
        // the card text is mandatory in the bundle.
        const derived = flags.deriveClass(['no-write', 'card-research'], PRIORS_IDLE);
        assert.notStrictEqual(derived, 'research-loop',
            'a research card with no writes must not be flagged as a research loop');
    });

    check('no-concern resolves to no class at all, so no row fires', () => {
        assert.strictEqual(flags.deriveClass(['no-concern'], PRIORS_IDLE), null);
    });

    check('a quota error outranks everything else observed', () => {
        assert.strictEqual(flags.deriveClass(['tail-quota-error', 'no-write', 'card-implement'], PRIORS_IDLE), 'quota');
    });

    // ── 9. Row 10 — the fix round that was finished and never posted ──────

    const PRIORS_FIX_ROUND = { finishedOnEarlierRound: true, noFinishedThisRound: true, wroteThisRound: true, atRest: true };

    check('a finished-looking tail on a fix round with writes is row 10', () => {
        assert.strictEqual(flags.deriveClass(['tail-summary'], PRIORS_FIX_ROUND), 'finished-unposted-round');
    });

    check('FIRST-round silence is not row 10 — no prior finished event', () => {
        const firstRound = { ...PRIORS_FIX_ROUND, finishedOnEarlierRound: false };
        assert.notStrictEqual(flags.deriveClass(['tail-summary'], firstRound), 'finished-unposted-round',
            'a coder who never posted for this card at all is row 9 or row 2, not row 10');
    });

    check('a round with no writes is not row 10, however the tail reads', () => {
        const noWrites = { ...PRIORS_FIX_ROUND, wroteThisRound: false };
        assert.notStrictEqual(flags.deriveClass(['tail-summary'], noWrites), 'finished-unposted-round');
    });

    check('a tail that reads as abandoned is not treated as finished', () => {
        assert.notStrictEqual(flags.deriveClass(['tail-summary', 'tail-abandoned'], PRIORS_FIX_ROUND), 'finished-unposted-round');
    });

    check('row 10 POSTS the completion on the coder\'s behalf — never a prompt', () => {
        const row = matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'fix-round-unposted');
        assert.ok(row, 'row 10 must exist');
        assert.notStrictEqual(row.remediation, 'mark-complete',
            'row 10 posts the seat-paced completion, not the board\'s COMPLETED column move');
        assert.strictEqual(row.remediation, 'post-completion-on-behalf');
        // Paired with the positive: the row must ACT, not merely record — and it
        // must act by POSTING, because the agent it used to prompt is by
        // hypothesis out of context, which is why it never posted.
        const controllerSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'controller.ts'), 'utf8');
        const arm = controllerSrc.slice(controllerSrc.indexOf("case 'post-completion-on-behalf':"));
        const armBody = arm.slice(0, arm.indexOf("case 'restart-board':"));
        assert.ok(/\/kanban\/queue\/done/.test(armBody), 'row 10 must post the completion, not merely record');
        assert.ok(!/ptySendPrompt/.test(armBody),
            'row 10 must NOT prompt: the agent that failed to post is the agent that ran out of context');
        // Attribution is mandatory and is NOT the `from` field: `from` names the
        // seat whose work it is, `postedBy` names the controller that posted it.
        // Without it the post is indistinguishable from a coder's own and "how
        // often do agents fail to post" stops being measurable.
        assert.ok(/postedBy/.test(armBody), 'row 10 must attribute the post to the controller, not impersonate the seat');
    });

    // ── 10. Target indirection ────────────────────────────────────────────

    check('row 9 targets the LEAD; row 10 targets the subject', () => {
        const row9 = matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'research-loop-no-write');
        const row10 = matrix.DEFAULT_MATRIX_ROWS.find(r => r.id === 'fix-round-unposted');
        assert.ok(row9, 'row 9 must exist');
        assert.strictEqual(row9.target, 'lead');
        assert.strictEqual(row9.remediation, 'report-to-lead');
        assert.strictEqual(row10.target, 'subject');
    });

    check('a target outside the closed set is refused at load time', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-matrix-'));
        fs.mkdirSync(path.join(dir, '.switchboard', 'controller'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.switchboard', 'controller', 'matrix.json'), JSON.stringify([{
            id: 'x', order: 1, cause: 'c', judge: 'model', condition: { kind: 'judgement' },
            remediation: 'record-unknown', requires: ['model'], target: 'the-operator',
        }]));
        assert.throws(() => matrix.loadMatrix(dir), /unknown target/,
            'an unknown target must fail loudly rather than loading as inert');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    check('an override naming the RETIRED ask-completion-post fails loudly, naming the verb', () => {
        // An operator's saved matrix.json is the case this guards: the verb is
        // gone from the closed set, so the load must refuse and NAME it. A
        // silent coercion to the new verb would leave a row doing something its
        // author did not write; a silent drop would leave the row doing nothing
        // at 3am.
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-matrix-'));
        fs.mkdirSync(path.join(dir, '.switchboard', 'controller'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.switchboard', 'controller', 'matrix.json'), JSON.stringify([{
            id: 'fix-round-unposted', order: 10, cause: 'c', judge: 'model',
            condition: { kind: 'judgement' }, remediation: 'ask-completion-post',
            requires: ['model'], target: 'subject',
        }]));
        assert.throws(() => matrix.loadMatrix(dir), /ask-completion-post/,
            'a retired remediation must be refused BY NAME at load time');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    check('row 9 degrades to recording, never to nudging the subject', () => {
        const controllerSrc = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'controller.ts'), 'utf8');
        const arm = controllerSrc.slice(controllerSrc.indexOf("case 'report-to-lead':"));
        const armBody = arm.slice(0, arm.indexOf("case 'post-completion-on-behalf':"));
        const noLeadBranch = armBody.slice(armBody.indexOf('if (!target.seat)'), armBody.indexOf('const data ='));
        assert.ok(/'recorded'/.test(noLeadBranch), 'with no lead, the outcome must be recorded');
        assert.ok(!/ptySendPrompt/.test(noLeadBranch), 'with no lead, nothing may be sent to the subject');
    });

    // ── 11. Nudge suppression — BOTH directions ───────────────────────────

    const live = { holder: 'ctl-1', stale: false, available: true, source: 'config:controller.lease' };

    check('a current lease declaring judgement available SUPPRESSES the sweeps', () => {
        const d = suppression.decideNudgeSweeps({ ...live, judgement: { available: true, reason: 'tier configured', source: 'capability:model' } });
        assert.strictEqual(d.suppressed, true);
        assert.strictEqual(d.state, 'suppressed-judging');
    });

    check('an unclaimed board leaves the sweeps active — today\'s behaviour', () => {
        const d = suppression.decideNudgeSweeps({ holder: null, stale: false, available: true, source: 'unclaimed' });
        assert.strictEqual(d.suppressed, false);
        assert.strictEqual(d.state, 'active-unclaimed');
    });

    check('a STALE lease resumes the sweeps and says why', () => {
        const d = suppression.decideNudgeSweeps({ ...live, stale: true, judgement: { available: true, reason: 'tier configured', source: 'capability:model' } });
        assert.strictEqual(d.suppressed, false, 'a dead controller must not take the nudges down with it');
        assert.strictEqual(d.state, 'active-stale-lease');
        assert.ok(/stopped being renewed/.test(d.reason), d.reason);
    });

    check('an UNREADABLE lease leaves the sweeps active, never suppressed', () => {
        const d = suppression.decideNudgeSweeps({ holder: null, stale: false, available: false, source: 'unreadable', reason: 'lease row is not valid JSON' });
        assert.strictEqual(d.suppressed, false);
        assert.strictEqual(d.state, 'active-unreadable-lease');
    });

    check('a modelless controller holding a lease does NOT suppress', () => {
        const d = suppression.decideNudgeSweeps({ ...live, judgement: { available: false, reason: 'no judgement backend configured', source: 'capability:model' } });
        assert.strictEqual(d.suppressed, false);
        assert.strictEqual(d.state, 'active-no-judgement');
    });

    check('a lease with no declaration yet does NOT suppress', () => {
        const d = suppression.decideNudgeSweeps({ ...live, judgement: null });
        assert.strictEqual(d.suppressed, false);
        assert.strictEqual(d.state, 'active-undeclared');
    });

    check('suppression is reachable ONLY through suppressed-judging', () => {
        // The paired assertion: the negatives above all pass trivially if
        // suppression is never implemented, so the positive has to be beside
        // them AND no other state may reach it.
        const states = new Set();
        for (const lease of [
            null,
            { holder: null, stale: false, available: true, source: 'unclaimed' },
            { holder: null, stale: false, available: false, source: 'unreadable' },
            { ...live, stale: true, judgement: { available: true, reason: '', source: '' } },
            { ...live, judgement: null },
            { ...live, judgement: { available: false, reason: '', source: '' } },
            { ...live, judgement: { available: true, reason: '', source: '' } },
        ]) {
            const d = suppression.decideNudgeSweeps(lease);
            if (d.suppressed) { states.add(d.state); }
        }
        assert.deepStrictEqual([...states], ['suppressed-judging']);
    });

    // ── 12. The timeout sweep is never suppressed ─────────────────────────

    check('_runDispatchTimeoutSweep sits outside the suppression gate', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const gateOpen = src.indexOf('if (!sweepDecision.suppressed) {');
        const timeoutCall = src.indexOf('this._runDispatchTimeoutSweep({');
        assert.ok(gateOpen > 0, 'the suppression gate must exist');
        assert.ok(timeoutCall > 0, 'the timeout sweep must still be called');
        assert.ok(timeoutCall > gateOpen, 'the timeout sweep must come after the gate');
        // The gate's own closing brace sits at its opening indent. Finding it
        // between the gate and the timeout sweep is the structural proof that
        // the sweep is outside — brace counting is defeated by the template
        // literals and comment text in between.
        const gateIndent = ' '.repeat(src.slice(0, gateOpen).length - src.lastIndexOf('\n', gateOpen) - 1);
        const gateBody = src.slice(gateOpen, timeoutCall);
        assert.ok(gateBody.split('\n').some(l => l === `${gateIndent}}`),
            'the suppression gate must be closed before the timeout sweep is called');
    });

    check('all four nudge sweeps sit INSIDE the gate', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        const gateOpen = src.indexOf('if (!sweepDecision.suppressed) {');
        const timeoutCall = src.indexOf('this._runDispatchTimeoutSweep({');
        const gated = src.slice(gateOpen, timeoutCall);
        for (const sweep of ['_runFeatureNudgeSweep', '_runQueueNudgeSweep', '_runMemberCompletionReminderSweep', '_runDispatchStallSweep']) {
            assert.ok(gated.includes(sweep), `${sweep} must be inside the suppression gate`);
        }
    });

    // ── 13. The board reads no model configuration ────────────────────────

    check('PlanIngestionEngine reads the lease and no model configuration', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'PlanIngestionEngine.ts'), 'utf8');
        for (const forbidden of ['reasoning_effort', 'chat/completions', 'judgementModel', 'apiKey']) {
            assert.ok(!src.includes(forbidden),
                `PlanIngestionEngine must not reference '${forbidden}' — the board makes no model call`);
        }
        assert.ok(src.includes('readLease'), 'it reads the lease, which is the only thing it reads');
    });

    // ── 14. No runtime-specific model path ────────────────────────────────

    check('the controller and judgement sources name no model runtime', () => {
        const files = [
            ...fs.readdirSync(path.join(ROOT, 'src', 'standalone', 'controller')).map(f => path.join('src', 'standalone', 'controller', f)),
            ...fs.readdirSync(path.join(ROOT, 'src', 'standalone', 'judgement')).map(f => path.join('src', 'standalone', 'judgement', f)),
        ].filter(f => f.endsWith('.ts'));
        for (const rel of files) {
            const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
            for (const marker of ['/api/generate', '/api/chat']) {
                assert.ok(!src.includes(marker), `${rel} names the runtime-specific path '${marker}'`);
            }
            assert.ok(!/\bollama\b/i.test(src), `${rel} names a specific runtime`);
        }
    });

    check('the model seam still POSTs /v1/chat/completions with reasoning_effort', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'judgement', 'modelClient.ts'), 'utf8');
        assert.ok(src.includes('/v1/chat/completions'), 'the endpoint must not have moved');
        assert.ok(/reasoning_effort:\s*'none'/.test(src), 'thinking must still be suppressed by default');
    });

    // ── 15. The sampler writes to nothing ─────────────────────────────────

    check('the sampler contains no write, no prompt and no seat-facing call', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'sample.ts'), 'utf8');
        for (const forbidden of ['writeFile', 'appendFile', 'mkdir', 'ptySendPrompt', 'apiRequest', 'fetch(', 'unlink', 'rmSync']) {
            assert.ok(!src.includes(forbidden),
                `sample.ts must not reference '${forbidden}' — observation must cost the seat nothing`);
        }
    });

    check('no image is captured, encoded or sent', () => {
        const files = ['sample.ts', 'controller.ts', 'matrix.ts'];
        for (const f of files) {
            const src = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', f), 'utf8');
            for (const marker of ['screenshot', 'image/png', 'toDataURL', 'base64,']) {
                assert.ok(!src.includes(marker), `${f} references '${marker}'`);
            }
        }
    });

    // ── 16. Class/row mapping stays total ─────────────────────────────────

    check('every actionable class maps to a row that exists in the matrix', () => {
        const ids = new Set(matrix.DEFAULT_MATRIX_ROWS.map(r => r.id));
        for (const cls of classes.MODEL_ACTIONABLE_CLASSES) {
            const rowId = classes.CLASS_TO_ROW_ID[cls];
            assert.ok(rowId, `class '${cls}' has no row mapping`);
            assert.ok(ids.has(rowId), `class '${cls}' maps to '${rowId}', which is not in the matrix`);
        }
    });

    check('every class deriveClass can return is in the closed class set', () => {
        const all = new Set();
        const priorSets = [PRIORS_IDLE, PRIORS_FIX_ROUND];
        for (const f of flags.JUDGEMENT_FLAGS) {
            for (const priors of priorSets) {
                const c = flags.deriveClass([f], priors);
                if (c !== null) { all.add(c); }
                const c2 = flags.deriveClass([f, 'card-implement'], priors);
                if (c2 !== null) { all.add(c2); }
            }
        }
        for (const c of all) {
            assert.ok(classes.JUDGEMENT_CLASSES.includes(c), `'${c}' is outside the closed class set`);
        }
    });

    check('every remediation the matrix names is in the closed remediation set', () => {
        for (const row of matrix.DEFAULT_MATRIX_ROWS) {
            assert.ok(matrix.MATRIX_REMEDIATIONS.includes(row.remediation),
                `row '${row.id}' names the unknown remediation '${row.remediation}'`);
        }
    });

    check('the new remediations are terminal — not on the escalation ladder', () => {
        // On the ladder they would climb: a research loop would earn a clear
        // and then a board restart from one observation. Row 10 is a one-shot
        // action too — the post happens on the FIRST detection, with no
        // coder-then-lead ladder behind it.
        assert.ok(!matrix.ESCALATION_LADDER.includes('report-to-lead'));
        assert.ok(!matrix.ESCALATION_LADDER.includes('post-completion-on-behalf'));
        // Paired positive: it is reachable — declared in the closed set, so a
        // `matrix.json` override naming it loads and the controller's switch
        // answers it, rather than the row being silently inert at 3am.
        assert.ok(matrix.MATRIX_REMEDIATIONS.includes('post-completion-on-behalf'));
    });

    // ── 17. The board's mirrored vocabulary matches the controller's ──────

    check('the board\'s save-time validation knows every remediation, kind, capability and target', () => {
        // These lists are hand-mirrored in ControllerBoardStore because that
        // file imports no standalone module. Drift is silent in BOTH
        // directions: a value only in the controller makes the panel refuse a
        // row the controller would run, and a value only in the board loads and
        // is inert. Nothing but this assertion notices.
        const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ControllerBoardStore.ts'), 'utf8');
        const listOf = (name) => {
            const start = src.indexOf(`const ${name} = `);
            assert.ok(start > 0, `${name} must exist in ControllerBoardStore`);
            const body = src.slice(start, src.indexOf('];', start));
            return new Set([...body.matchAll(/'([a-z-]+)'/g)].map(m => m[1]));
        };
        const mirrors = [
            ['KNOWN_REMEDIATIONS', matrix.MATRIX_REMEDIATIONS],
            ['KNOWN_CAPABILITIES', matrix.MATRIX_CAPABILITY_KEYS],
            ['KNOWN_CONDITION_KINDS', matrix.MATRIX_CONDITION_KINDS],
            ['KNOWN_TARGETS', matrix.MATRIX_TARGETS],
        ];
        for (const [name, authoritative] of mirrors) {
            const mirrored = listOf(name);
            for (const value of authoritative) {
                assert.ok(mirrored.has(value),
                    `${name} is missing '${value}' — the panel would refuse a row the controller runs`);
            }
            for (const value of mirrored) {
                assert.ok(authoritative.includes(value),
                    `${name} carries '${value}', which the controller does not know — it would load and be inert`);
            }
        }
    });

    check('every shipped row passes the board\'s own save-time validation', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'services', 'ControllerBoardStore.ts'), 'utf8');
        // The shipped matrix is what an operator starts from in the panel, so a
        // shipped row the board would refuse to save is a dead-end surface.
        for (const row of matrix.DEFAULT_MATRIX_ROWS) {
            assert.ok(src.includes(`'${row.remediation}'`),
                `the board's validation does not know remediation '${row.remediation}' from row '${row.id}'`);
            if (row.target) {
                assert.ok(src.includes(`'${row.target}'`),
                    `the board's validation does not know target '${row.target}' from row '${row.id}'`);
            }
        }
    });

    // ── 18. The prompt no longer presupposes silence ──────────────────────

    check('the judgement prompt does not presuppose the seat is quiet', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'controller.ts'), 'utf8');
        const start = src.indexOf('const system = [');
        const systemBlock = src.slice(start, src.indexOf('].join', start));
        assert.ok(!/has gone quiet/.test(systemBlock), 'the prompt must not ask why a seat went quiet');
        assert.ok(/not whether it is quiet/.test(systemBlock), 'it must say silence is not the question');
        assert.ok(/loud, busy and burning CPU while producing nothing/.test(systemBlock),
            'a loud seat must be reportable');
    });

    // ── 19. The Pilot is the ONLY judge ───────────────────────────────────
    // The escalation rung is retired (plan: the-navigator-is-its-own-model-slot):
    // the Navigator has its own model slot and a different job, so there is no
    // second opinion behind the classifier. The opposite-calibration pair this
    // case used to pin is therefore gone, and the classifier's prompt must not
    // promise a filter that does not exist.
    check('the Pilot prompt is calibrated as the sole judge', () => {
        const src = fs.readFileSync(path.join(ROOT, 'src', 'standalone', 'controller', 'controller.ts'), 'utf8');
        assert.ok(/You are the ONLY judge/.test(src), 'the Pilot must be told it is the only judge');
        assert.ok(!/A later stage filters you/.test(src),
            'no later stage exists — a permissive instruction justified by a filter that cannot be installed must be gone');
        assert.ok(!/Be STRICT/.test(src), 'the retired escalation calibration must be gone');
        assert.ok(!/Healthy seats are EXPECTED in your input/.test(src),
            'tier 2 no longer exists to expect healthy seats');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    if (failures > 0) { process.exit(1); }
}

run();
