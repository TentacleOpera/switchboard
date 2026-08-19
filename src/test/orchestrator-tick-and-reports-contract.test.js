/**
 * Contract gate for "The Orchestrator Runs as a Ticking Agent".
 *
 * Three of the feature's four subtasks named an automated check in their
 * `### Automated` verification and none was wired to a gate, which is the exact
 * green-while-incomplete hole: the deliverables are two rewritten markdown
 * personas and a filesystem channel, and nothing else in CI reads either.
 *
 * What is pinned here, and why each one is invisible to every other gate:
 *
 * 1. **Persona coherence.** A persona is executable specification with no
 *    compiler. The rewrite kept a Hard Rule ("Coding + code review only.
 *    Planner-stage items escalate.") that contradicts the planning lane three
 *    sections below it — an unattended agent obeying Hard Rules over prose never
 *    feeds lane 2, and half the feature is silently dead. Nothing compiles this
 *    file, so only a grep can see it.
 *
 * 2. **The `Miscellaneous` sweep.** Deleted from the persona AND from
 *    `group-into-features` (`## Unattended mode`), which is the file that
 *    actually performed it. Deleting it in one place leaves the tick refusing to
 *    ask for a sweep while the skill it calls performs one anyway.
 *
 * 3. **The relocated verb-rail traps.** Two facts existed in exactly one file
 *    and that file was deleted. They were moved first; this pins that they are
 *    still somewhere other than git history, and that the relocation did not
 *    duplicate the canonical-column rule that `switchboard-orchestration`
 *    already owned.
 *
 * 4. **The reports channel.** Its whole failure mode is shipping a second unused
 *    inbox: a documented directory nobody writes to. The mechanics are asserted
 *    behaviourally (exclusive-create, frontmatter flatten, traversal rejection,
 *    lazy bootstrap) and the only TS writer is asserted to still have a live
 *    call site in BOTH hosts.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = process.cwd();
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** Every .ts/.js under src/, repo-relative. Used by the no-stray-caller greps. */
function srcFiles(dir = 'src') {
    const out = [];
    for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) { out.push(...srcFiles(rel)); }
        else if (/\.(ts|js)$/.test(entry.name)) { out.push(rel); }
    }
    return out;
}

const PERSONA = '.agents/skills/switchboard-orchestrator/SKILL.md';
const ORCHESTRATION = '.agents/skills/switchboard-orchestration/SKILL.md';
const LAUNCHER = '.agents/workflows/switchboard.md';
const GROUPING = '.agents/skills/group-into-features/SKILL.md';

let failures = 0;
// MUST await fn(). Half the checks below are async (they exercise the real
// filesystem writer); a synchronous runner would report ✅ on a rejected promise
// and turn the whole behavioural half of this gate into decoration.
async function check(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.log(`  ❌ ${name}`);
        console.log(`     ${err.message}`);
    }
}

async function run() {
    console.log('orchestrator tick + reports channel contract\n');

    // ─── 1. Persona: the tick, and the two sections it does not own ──────────
    const persona = read(PERSONA);

    await check('persona keeps the two sections owned by the pre-flight subtask', () => {
        assert.ok(persona.includes('\n## Pre-flight\n'), 'persona lost ## Pre-flight');
        assert.ok(persona.includes('\n## Session File\n'), 'persona lost ## Session File');
    });

    await check('persona is a tick, not a batch: no kickoff, no batch terminator, no no-timers rule', () => {
        for (const dead of ['## Kickoff', '## Batch Completion', 'No timers, no polling', 'Do not restart or re-group']) {
            assert.ok(!persona.includes(dead), `persona still carries the batch-manager frame: "${dead}"`);
        }
    });

    await check('persona describes both lanes and their capacity guards', () => {
        assert.ok(/## The Tick/.test(persona), 'persona has no ## The Tick section');
        assert.ok(/Coding lane/.test(persona) && /Planning lane/.test(persona), 'persona does not name both lanes');
        assert.ok(/one dispatch per lane per wake/i.test(persona), 'persona does not state one dispatch per lane per wake');
        assert.ok(/dropped, not queued/i.test(persona), 'persona does not state drop-not-queue');
    });

    // The load-bearing one. The scope exclusion and the planning lane cannot both
    // be true, and the Hard Rules block is the half an unattended agent obeys.
    await check('persona carries NO surviving coding-only scope exclusion', () => {
        assert.ok(
            !/Coding \+ code review only/.test(persona),
            'persona still says "Coding + code review only" — it contradicts the planning lane, and a Hard Rule beats prose'
        );
        assert.ok(
            !/You never automate planning/.test(persona),
            'persona still says "You never automate planning" — the planning lane overturns it'
        );
        assert.ok(
            /planner.{0,40}routine/is.test(persona),
            'persona must state that planner-stage dispatch is routine work, not an escalation'
        );
    });

    await check('persona retains progress.json — a cleared context cannot hold a stall counter', () => {
        assert.ok(persona.includes('progress.json'), 'progress.json was deleted by silence in the rewrite');
        assert.ok(/stallCount\s*>=\s*3/.test(persona), 'the stall escalation threshold is gone');
    });

    await check('persona hands the CODE REVIEWED advance to the coding head, and says so once', () => {
        assert.ok(/## What You Never Do/.test(persona), 'persona has no ## What You Never Do section');
        assert.ok(
            /Advance a card to CODE REVIEWED/.test(persona),
            'persona does not forbid advancing to CODE REVIEWED — the tick and the head would race on the same card'
        );
    });

    await check('persona points at session.md, never writes the legacy session-log.md', () => {
        assert.ok(persona.includes('session.md'), 'persona does not name session.md');
        assert.ok(
            /do not write\s*\n?`?session-log\.md`?/i.test(persona) || /do not write `session-log\.md`/i.test(persona),
            'persona must tell the agent not to write the legacy session-log.md'
        );
    });

    await check('persona defines the ready-to-go query, its exclusions, and its source', () => {
        assert.ok(/\n## What Is Ready To Go\n/.test(persona), 'persona has no ## What Is Ready To Go section');
        assert.ok(/featureId/.test(persona), 'persona does not state the subtask exclusion (featureId)');
        assert.ok(/ACTIVE_PROJECT_FILTER/.test(persona), 'persona ignores the injected project filter — the answer would not match the board');
        assert.ok(/kanban-state-\*\.md/.test(persona), 'persona does not route this question off the per-column exports (they carry no featureId)');
        assert.ok(/kanban\/plans/.test(persona), 'persona names no endpoint for the ready query');
        // CODE REVIEWED also appears legitimately in ## What You Never Do, so assert
        // the exclusion sentence exists rather than forbidding the string.
        assert.ok(
            /Exclude every other column[\s\S]{0,400}CODE REVIEWED/.test(persona),
            'persona does not exclude the finished columns from the ready set'
        );
        assert.ok(/BACKLOG/.test(persona) && /DISPATCH/.test(persona), 'persona does not exclude the two display-mode columns');
    });

    await check('pre-flight check 5 and the tick both defer to the one ready definition', () => {
        const refs = persona.match(/## What Is Ready To Go/g) || [];
        assert.ok(refs.length >= 3, `the ready definition is referenced ${refs.length} times — check 5 and ## The Tick must both point at it instead of restating the columns`);
    });

    await check('a passing pre-flight check produces no output', () => {
        assert.ok(/Pre-flight clear\./.test(persona), 'persona names no silent-pass report line');
        assert.ok(!/Report what you find in plain terms/.test(persona), 'the six checks still instruct the agent to narrate every check');
    });

    // The Aug 17 rewrite deleted whole load-bearing sections and nothing caught it,
    // which is the failure the self-wake plan exists to repair. These four checks are
    // the gate that repair asked for: every rule restored or added by that plan is
    // asserted here, so the next rewrite that drops one fails CI instead of shipping.
    await check('persona dispatches to the lead only — never to an individual coder terminal', () => {
        assert.ok(
            /never call `POST \/kanban\/dispatch`/i.test(persona),
            'persona does not forbid POST /kanban/dispatch — the orchestrator routes straight to Coding-coder-1 and the lead is bypassed'
        );
        assert.ok(
            /kanban\/queue\/next/.test(persona) && /ptySendPrompt/.test(persona),
            'persona names no permitted lead-dispatch verb to replace the forbidden one'
        );
    });

    await check('persona resolves the port through a health check, and says what a failure means', () => {
        assert.ok(/\n## Port Discovery\n/.test(persona), 'persona has no ## Port Discovery section');
        assert.ok(
            /A port file is not liveness/i.test(persona),
            'persona does not state that a port file is not liveness — it trusts a stale port and hits a dead socket'
        );
        assert.ok(
            /does not mean no terminals exist/i.test(persona),
            'persona does not state that a failed resolve means the board is down, not that the fleet is empty — that misdiagnosis is the reported bug'
        );
        assert.ok(
            !/PORT=\$\(cat [^)]*api-server-port\.txt\)/.test(persona),
            'a bare `cat` of the port file survives in the persona — it resolves a stale port with no /health probe'
        );
    });

    await check('self-wake names a real interval source and owns the clearing it no longer receives', () => {
        assert.ok(/\n## Self-Wake\n/.test(persona), 'persona has no ## Self-Wake section — the agent has no way to wake itself');
        // The interval lives in VS Code workspaceState under the `autoban.state` key.
        // It is not a file and no endpoint returns it; naming a path sends the agent
        // to a `cat` that always fails.
        assert.ok(
            /There is no\s*`?\.switchboard\/autoban\.state`? file/.test(persona),
            'persona does not say .switchboard/autoban.state is not a file — the agent cats a path that never existed and stalls looking for its interval'
        );
        // Strip the disclaimer above before forbidding the path, so the sentence that
        // denies the file does not read as an instruction to open it.
        assert.ok(
            !/\.switchboard\/autoban\.state/.test(
                persona.replace(/There is no\s*`?\.switchboard\/autoban\.state`? file/g, '')
            ),
            'persona points the agent at .switchboard/autoban.state — no such file exists; the wake interval is not readable from disk'
        );
        assert.ok(
            /there is no deliverer to do it for you/i.test(persona),
            'persona still claims every wake clears the terminal — a self-wake `echo WAKE` clears nothing, so the agent must be told it owns the clearing'
        );
        assert.ok(
            /you are the deliverer/i.test(persona),
            'the drop-not-queue rule is still attributed only to the host — under self-wake the sleep loop fires mid-pass and nobody drops it'
        );
    });

    await check('the handoff bullet describes what the queue watch actually does', () => {
        assert.ok(
            !/queue.watch[^.]{0,80}dispatches subsequent cards/i.test(persona),
            'persona claims the queue watch dispatches for the lead — it sends one nudge telling the lead to call POST /kanban/queue/next itself (PlanIngestionEngine queue sweep), then escalates once and stops'
        );
        assert.ok(
            /lead-paced and queue-watched/.test(persona),
            'persona no longer states the handoff pipeline is lead-paced — the lead self-paces and the watch is only a backstop'
        );
    });

    // ─── 2. The Miscellaneous sweep, in BOTH trees ───────────────────────────
    const mdFiles = [];
    const walk = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (entry.name.endsWith('.md')) mdFiles.push(p);
        }
    };
    for (const tree of ['.agents', '.claude']) {
        const abs = path.join(ROOT, tree);
        if (fs.existsSync(abs)) walk(abs);
    }

    await check('no instruction to create a Miscellaneous feature survives in .agents/ or .claude/', () => {
        const offenders = [];
        for (const file of mdFiles) {
            const lines = fs.readFileSync(file, 'utf8').split('\n');
            lines.forEach((line, i) => {
                if (!line.includes('Miscellaneous')) return;
                // A sweep instruction is Miscellaneous next to the machinery that
                // performs it. The two surviving mentions are negative statements
                // ("there is no Miscellaneous catch-all") and are correct.
                if (/create-feature|assign-to-feature|swept|sweep the|ungrouped remainder/.test(line)) {
                    offenders.push(`${path.relative(ROOT, file)}:${i + 1}`);
                }
            });
        }
        assert.strictEqual(offenders.length, 0, `Miscellaneous sweep instruction survives at: ${offenders.join(', ')}`);
    });

    await check('group-into-features leaves standalone plans standalone in unattended mode', () => {
        const grouping = read(GROUPING);
        const unattended = grouping.slice(grouping.indexOf('## Unattended mode'));
        assert.ok(unattended.length > 0, 'group-into-features has no ## Unattended mode section');
        assert.ok(
            /Standalone plans are left standalone/.test(unattended),
            'unattended mode does not state that standalone plans stay standalone'
        );
        assert.ok(
            /skip step 4 \(CONFIRM\)/i.test(unattended),
            'the confirm-skip was removed with the sweep — it is the only remaining effect of UNATTENDED=true'
        );
    });

    // ─── 3. The relocated verb-rail traps (launcher verifications 7 and 8) ───
    const orchestration = read(ORCHESTRATION);

    await check('trap 1 — the read-verb rule survives the console deletion', () => {
        assert.ok(
            /read verbs/i.test(orchestration) && /\{\s*success\s*:\s*true\s*\}/.test(orchestration),
            'the "read verbs return only {success:true}" trap is documented nowhere but git history'
        );
        for (const ep of ['/kanban/board', '/kanban/plans', '/kanban/plan']) {
            assert.ok(orchestration.includes(ep), `the read-verb trap does not name the replacement endpoint ${ep}`);
        }
    });

    await check('trap 2 — the exact webview field names survive the console deletion', () => {
        assert.ok(
            /triggerAction[\s\S]{0,120}sessionId[\s\S]{0,60}targetColumn/.test(orchestration),
            'triggerAction\'s payload shape ({sessionId, targetColumn}) is documented nowhere but git history'
        );
        assert.ok(
            /promptOnDrop[\s\S]{0,140}sessionIds[\s\S]{0,80}sourceColumn[\s\S]{0,60}targetColumn/.test(orchestration),
            'promptOnDrop\'s payload shape ({sessionIds, sourceColumn, targetColumn}) is documented nowhere but git history'
        );
    });

    await check('the canonical-column rule appears exactly once — the relocation did not duplicate it', () => {
        const hits = (orchestration.match(/never state-file slugs/g) || []).length;
        assert.strictEqual(hits, 1, `the canonical-column rule appears ${hits} times; two statements of one rule is how they drift`);
    });

    // ─── 4. The launcher is a launcher ───────────────────────────────────────
    const launcher = read(LAUNCHER);

    await check('/switchboard is two steps, not a console', () => {
        const lines = launcher.split('\n').length;
        assert.ok(lines < 140, `the launcher is ${lines} lines — it must fit on roughly one screen, not narrate the board`);
        for (const dead of ['## Category', 'Board snapshot', 'oversight pass', 'Plan-ID resolution', 'management console']) {
            assert.ok(!launcher.includes(dead), `the launcher still carries console content: "${dead}"`);
        }
    });

    await check('step 1 is a health check, not a port-file existence check', () => {
        assert.ok(/\/health/.test(launcher), 'step 1 does not call GET /health');
        assert.ok(
            /200/.test(launcher) && /port file is not liveness|A port file is not liveness/i.test(launcher),
            'step 1 does not state that a port file is not liveness — a stale port attaches to a URL that 404s'
        );
    });

    await check('step 2 adopts this session — it does not seat a second terminal', () => {
        assert.ok(/orchestration\/adopt/.test(launcher), 'step 2 does not call POST /orchestration/adopt');
        assert.ok(
            !/orchestration\/start/.test(launcher.replace(/Never call[\s\S]{0,200}/g, '')),
            'step 2 still calls POST /orchestration/start — that door creates a separate Orchestrator terminal'
        );
        assert.ok(
            /does not arm|Does not arm/.test(launcher),
            'the launcher must say adopt does not arm — otherwise it reads as a one-click arm'
        );
        assert.ok(
            !/orchestration-starts-as-a-conversation\.md/.test(launcher),
            'the launcher points at a .switchboard/plans/ file — gitignored, not distributed'
        );
    });

    // ─── 5. The reports channel is documented as a contract ──────────────────
    await check('switchboard-orchestration documents the reports channel', () => {
        assert.ok(/Reports channel/i.test(orchestration), 'no reports-channel section — the frontmatter contract exists only in the prompt directive');
        const section = orchestration.slice(orchestration.search(/### Reports channel/i));
        for (const kind of ['finished', 'blocked', 'question', 'status']) {
            assert.ok(section.includes(kind), `the reports section does not name the "${kind}" kind`);
        }
        assert.ok(section.includes('claimed_ts'), 'the reports section does not document the claim-marker body');
        assert.ok(/\.claim/.test(section), 'the reports section does not document the claim-marker filename');
        assert.ok(/24 hours|24-hour/i.test(section), 'the reports section does not state the staleness window');
        assert.ok(
            /not an HTTP surface|no endpoint/i.test(section),
            'the reports section must say there is no endpoint — describing it as HTTP is how a caller looks for a route that does not exist'
        );
    });

    // ─── 6. The reports channel MECHANICS, behaviourally ─────────────────────
    const {
        writeInboxFile,
        writeInstruction,
        writeOrchestratorReport,
        claimInboxItemIn,
        isInboxItemClaimedIn
    } = require(path.join(ROOT, 'out', 'services', 'ScheduledJobsService.js'));

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-reports-'));

    await check('.switchboard absent → no orchestrator tree is created and the write fails honestly', async () => {
        const bare = path.join(tmp, 'bare-workspace');
        fs.mkdirSync(bare, { recursive: true });
        const res = await writeOrchestratorReport(bare, { from: 'Coding-lead', kind: 'status', body: 'hi' });
        assert.strictEqual(res.success, false, 'a workspace with no .switchboard must not gain an orchestrator/ tree');
        assert.ok(!fs.existsSync(path.join(bare, '.switchboard')), 'scaffold litter: .switchboard was created');
    });

    const ws = path.join(tmp, 'workspace');
    fs.mkdirSync(path.join(ws, '.switchboard'), { recursive: true });

    await check('two reports posted in the same second produce two files, neither clobbering the other', async () => {
        const results = await Promise.all([
            writeOrchestratorReport(ws, { from: 'lead-a', kind: 'status', body: 'a' }),
            writeOrchestratorReport(ws, { from: 'lead-b', kind: 'status', body: 'b' })
        ]);
        assert.ok(results.every(r => r.success), `a concurrent post failed: ${JSON.stringify(results)}`);
        assert.notStrictEqual(results[0].filePath, results[1].filePath, 'both reports landed on the same path — a silent clobber');
        const bodies = results.map(r => fs.readFileSync(r.filePath, 'utf8'));
        assert.ok(bodies.some(b => b.endsWith('a')) && bodies.some(b => b.endsWith('b')), 'one report was overwritten by the other');
    });

    await check('report filenames carry the report- prefix; instructions keep instr-', async () => {
        const rep = await writeOrchestratorReport(ws, { from: 'lead', kind: 'finished', body: 'done' });
        assert.ok(rep.success, rep.error);
        assert.ok(path.basename(rep.filePath).startsWith('report-'), `report filename is ${path.basename(rep.filePath)}`);
        assert.ok(rep.filePath.includes(path.join('.switchboard', 'orchestrator', 'reports')), 'report landed outside the reports directory');

        const instr = await writeInstruction(ws, { from: 'user', kind: 'task', body: 'do a thing' });
        assert.ok(instr.success, instr.error);
        assert.ok(path.basename(instr.filePath).startsWith('instr-'), `instruction filename is ${path.basename(instr.filePath)}`);
        assert.ok(
            instr.filePath.includes(path.join('.switchboard', 'instructions', 'inbox')),
            'the shipped instructions channel moved — the refactor was supposed to be byte-compatible'
        );
    });

    await check('a report body cannot forge a frontmatter key (flatten survives the extraction)', async () => {
        const dir = path.join(ws, '.switchboard', 'orchestrator', 'reports');
        const res = await writeInboxFile(dir, {
            from: 'attacker\nkind: finished',
            kind: 'status',
            body: 'legit body'
        }, 'report');
        assert.ok(res.success, res.error);
        const content = fs.readFileSync(res.filePath, 'utf8');
        const frontmatter = content.split('---')[1] || '';
        assert.strictEqual(
            (frontmatter.match(/^kind:/gm) || []).length,
            1,
            'a newline in a frontmatter value forged a second kind: key — flatten() was lost in the extraction'
        );
    });

    await check('claim helpers reject a path-traversal filename before joining', async () => {
        const dir = path.join(ws, '.switchboard', 'orchestrator', 'reports');
        const evil = path.join('..', '..', 'escaped.claim');
        await claimInboxItemIn(dir, evil, 'orchestrator');
        assert.ok(!fs.existsSync(path.join(ws, '.switchboard', 'escaped.claim.claim')), 'claimInboxItemIn escaped its directory');
        assert.strictEqual(await isInboxItemClaimedIn(dir, evil), false, 'isInboxItemClaimedIn must not read outside its directory');
    });

    await check('a claimed report reads as claimed; an unclaimed one does not', async () => {
        const dir = path.join(ws, '.switchboard', 'orchestrator', 'reports');
        const res = await writeOrchestratorReport(ws, { from: 'lead', kind: 'blocked', body: 'need a decision' });
        const name = path.basename(res.filePath);
        assert.strictEqual(await isInboxItemClaimedIn(dir, name), false, 'a fresh report must read as unclaimed');
        await claimInboxItemIn(dir, name, 'orchestrator');
        assert.strictEqual(await isInboxItemClaimedIn(dir, name), true, 'the claim marker did not take — the tick would act on it twice');
        const marker = fs.readFileSync(path.join(dir, 'claimed', `${name}.claim`), 'utf8');
        assert.ok(/claimed_ts:/.test(marker) && /agent:/.test(marker), 'the claim marker does not match the documented format');
    });

    // ─── 7. The only TS writer has a live call site in BOTH hosts ────────────
    await check('the turn-end mirror is wired in both hosts with the same frontmatter mapping', () => {
        const hosts = {
            'src/services/TaskViewerProvider.ts': read('src/services/TaskViewerProvider.ts'),
            'src/standalone/bootstrap.ts': read('src/standalone/bootstrap.ts')
        };
        for (const [file, src] of Object.entries(hosts)) {
            assert.ok(
                src.includes('writeOrchestratorReport('),
                `${file} does not mirror turn-end notices to the reports channel — a report writer with no caller is the zero-caller failure this plan diagnosed`
            );
            assert.ok(
                /from:\s*'system'/.test(src),
                `${file} does not stamp from: 'system' on the mirrored notice`
            );
            assert.ok(
                /kind:\s*info\.outcome === 'completed' \? 'finished' : 'blocked'/.test(src),
                `${file}'s outcome→kind mapping differs — both hosts must produce the same frontmatter for the same event`
            );
            assert.ok(
                /void writeOrchestratorReport\(/.test(src),
                `${file} awaits the mirror — a filesystem write must never delay or suppress the pty send that works today`
            );
        }
    });

    // The bundle is the only place the two directives are named. A count of
    // bundle call sites cannot see the drift this replaces: it stays green when a
    // seventh site re-adds a bare `ensureCompletionDirective(` with no report
    // directive beside it — the exact failure the superseded counting assertion
    // was written for. Grep for the function names instead, across all of src.
    await check('ensureCompletionDirective / ensureOrchestratorReportDirective have no callers outside the bundle', () => {
        const offenders = [];
        for (const rel of srcFiles()) {
            // Tests legitimately import the members to assert their behaviour.
            if (rel.startsWith('src/test/')) { continue; }
            const body = read(rel);
            const lines = body.split('\n');
            lines.forEach((line, i) => {
                if (!/\bensure(CompletionDirective|OrchestratorReportDirective)\s*\(/.test(line)) { return; }
                // Prose naming the function is not a call site.
                if (/^\s*(\/\/|\*|\/\*)/.test(line)) { return; }
                // The definitions themselves, and the one line inside the bundle
                // that composes them, are the permitted occurrences.
                if (/^\s*export function ensure(CompletionDirective|OrchestratorReportDirective)\s*\(/.test(line)) { return; }
                // The bundle's own two-line body. It composes the pair under the
                // orchestratorActive gate; both lines live inside
                // ensureDispatchProtocolDirectives and are the permitted pairing.
                if (/^\s*const withCompletion = ensureCompletionDirective\(text\);$/.test(line)) { return; }
                if (/^\s*return ensureOrchestratorReportDirective\(withCompletion\);$/.test(line)) { return; }
                offenders.push(`${rel}:${i + 1}`);
            });
        }
        assert.deepStrictEqual(
            offenders, [],
            'these sites name a protocol directive directly instead of calling ensureDispatchProtocolDirectives — '
            + 'a site that pairs them by hand is one edit away from pairing them wrong: ' + offenders.join(', ')
        );
        const builder = read('src/services/agentPromptBuilder.ts');
        const bundles = (builder.match(/ensureDispatchProtocolDirectives\(/g) || []).length;
        // 6 board composition sites + the definition.
        assert.ok(bundles >= 7, `ensureDispatchProtocolDirectives has ${bundles} occurrences in the builder, expected at least 7`);
        assert.ok(
            /IN ADDITION TO, never INSTEAD OF/.test(builder),
            'the report directive must state it is in addition to the plan-file completion report — read as a replacement it breaks completion detection for every card'
        );
        assert.ok(
            !/CODING_COMPLETION_REPORT_DIRECTIVE\s*=\s*`[^`]*ORCHESTRATOR REPORT/.test(builder),
            'the report directive was folded into the completion directive, whose exact text is load-bearing for completion detection'
        );
    });

    // A lead-dispatched agent is told the same as a board-dispatched one only if
    // BOTH delivery chokepoints attach the bundle. Implementing one host splits
    // the two hosts on prompt content, which the PRD forbids.
    await check('both delivery chokepoints attach the dispatch protocol bundle', () => {
        for (const [file, needle] of [
            ['src/services/TaskViewerProvider.ts', 'ensureDispatchProtocolDirectives(payload.data, orchestratorActive)'],
            ['src/standalone/bootstrap.ts', 'ensureDispatchProtocolDirectives(out, orchestratorActive)'],
        ]) {
            assert.ok(
                read(file).includes(needle),
                `${file} does not attach the dispatch protocol bundle — a lead dispatching through this host gets no completion directive, and its coders' finished subtasks report nothing the sweep can see`
            );
        }
    });

    // The lead's seat-routing line names `recommendedRole`. A prompt that names a
    // field no read returns is the same defect class this plan exists to remove.
    await check('the recommendedRole the head prompt names is actually stamped by the plan reads', () => {
        const api = read('src/services/LocalApiServer.ts');
        assert.ok(
            /recommendedRole: resolve\(score\)/.test(api),
            'no read stamps recommendedRole — the head prompt tells the lead to read a field that does not exist'
        );
        for (const site of ['_withRecommendedRole(plans)', '_withRecommendedRole(features)', '_withRecommendedRole([{ ...record, content }])']) {
            assert.ok(api.includes(site), `plan read missing the recommendedRole stamp: ${site}`);
        }
        for (const file of ['src/services/TaskViewerProvider.ts', 'src/standalone/bootstrap.ts']) {
            assert.ok(
                /resolveRoutedRole: /.test(read(file)),
                `${file} does not wire resolveRoutedRole — recommendedRole would be absent on this host only`
            );
        }
        for (const file of ['src/services/teamWiring.ts', 'src/webview/terminals.js', 'src/webview/kanban.html']) {
            assert.ok(
                read(file).includes('a recommendedRole; dispatch it to a seat of that role'),
                `${file}'s head prompt lost the seat-routing line`
            );
        }
    });

    // ─── 8. Start seats, confirm arms — the two doors behave identically ─────
    await check('both doors land on the same seat-and-interview method', () => {
        const api = read('src/services/LocalApiServer.ts');
        assert.ok(
            /pathname === '\/orchestration\/adopt' && req\.method === 'POST'/.test(api),
            'POST /orchestration/adopt is not routed in LocalApiServer'
        );
        assert.ok(
            /pathname === '\/orchestration\/confirm' && req\.method === 'POST'/.test(api),
            'POST /orchestration/confirm is not routed — the pre-flight would talk and never arm'
        );
        assert.ok(
            !/Orchestration engine armed/.test(api),
            "POST /orchestration/start still answers 'Orchestration engine armed' — the response message is a script's only signal that the semantics changed"
        );
        assert.ok(
            /awaiting confirmation/i.test(api),
            'POST /orchestration/start does not report that it seated and is awaiting confirmation'
        );
        assert.ok(
            /session\.md[\s\S]{0,400}session-log\.md/.test(api),
            'GET /orchestrator/session-log does not prefer session.md with a legacy fallback — the shipped endpoint returns \'\' forever on unmigrated installs'
        );

        const provider = read('src/services/TaskViewerProvider.ts');
        // Assert on the actual PUBLIC declaration. A bare
        // `provider.includes('buildOrchestratorKickoffPrompt(')` is satisfied by
        // the OLD private name `_buildOrchestratorKickoffPrompt(` too, so it
        // would not prove the rename it was edited for. Require the public
        // declaration AND the absence of the private underscore-prefixed name.
        assert.ok(
            /public\s+async\s+buildOrchestratorKickoffPrompt\(/.test(provider),
            'TaskViewerProvider does not declare public async buildOrchestratorKickoffPrompt('
        );
        assert.ok(
            !/_buildOrchestratorKickoffPrompt\(/.test(provider),
            'TaskViewerProvider still contains _buildOrchestratorKickoffPrompt( — the private name the rename removed'
        );
        const occurrences = (provider.match(/no session file exists/g) || []).length;
        assert.strictEqual(
            occurrences, 1,
            `the interview sentinel string ('no session file exists') occurs ${occurrences} times in TaskViewerProvider — expected exactly 1 (the extraction's whole purpose is that the branch is not duplicated)`
        );
    });

    await check('Stop archives the session so the next Start interviews from scratch', () => {
        const provider = read('src/services/TaskViewerProvider.ts');
        const start = provider.indexOf('public async stopOrchestratorFromKanban');
        assert.ok(start !== -1, 'stopOrchestratorFromKanban must exist');
        const after = provider.slice(start);
        const next = after.slice(1).search(/\n {4}(?:public|private|protected)\s/);
        const body = next === -1 ? after : after.slice(0, next + 1);
        assert.ok(/sessions/.test(body) && /rename/.test(body), 'Stop does not archive session.md — the next Start reads a stale session and never re-interviews');
    });

    // ─── 9. Handoff: hands off to lead, writes session log, and exits ────────
    await check('persona documents ## Handoff, or arm? and ## The handoff sequence ending in exit', () => {
        assert.ok(persona.includes('## Handoff, or arm?'), 'persona lost ## Handoff, or arm?');
        assert.ok(persona.includes('## The handoff sequence'), 'persona lost ## The handoff sequence');
        const handoffSection = persona.slice(persona.indexOf('## The handoff sequence'));
        assert.ok(
            /POST \/orchestration\/handoff/.test(handoffSection),
            'handoff sequence does not call POST /orchestration/handoff'
        );
        assert.ok(
            /exit/i.test(handoffSection),
            'handoff sequence must instruct the agent to exit after reporting handoff'
        );
    });

    await check('POST /orchestration/handoff is routed and wired to TaskViewerProvider', () => {
        const api = read('src/services/LocalApiServer.ts');
        assert.ok(
            /pathname === '\/orchestration\/handoff' && req\.method === 'POST'/.test(api),
            'POST /orchestration/handoff is not routed in LocalApiServer'
        );
        assert.ok(
            /orchestrationHandoff\?:/.test(api),
            'LocalApiServerOptions does not declare orchestrationHandoff'
        );
        const provider = read('src/services/TaskViewerProvider.ts');
        assert.ok(
            provider.includes('handoffOrchestrationSession('),
            'TaskViewerProvider does not implement handoffOrchestrationSession'
        );
    });

    await check('handoff writes summary to session log BEFORE closing terminal and does NOT touch automationMode', () => {
        const provider = read('src/services/TaskViewerProvider.ts');
        const start = provider.indexOf('public async handoffOrchestrationSession(');
        assert.ok(start !== -1, 'handoffOrchestrationSession must exist');
        const after = provider.slice(start);
        const next = after.slice(1).search(/\n {4}(?:public|private|protected)\s/);
        const body = next === -1 ? after : after.slice(0, next + 1);

        const appendLogAt = body.indexOf('appendFile(sessionPath');
        const closeTermAt = body.indexOf('_closeTerminal(');
        assert.ok(
            appendLogAt !== -1 && closeTermAt !== -1 && appendLogAt < closeTermAt,
            'handoff must write to session.md BEFORE closing the orchestrator terminal'
        );
        assert.ok(
            !body.includes('_stopAutobanEngine()'),
            'handoff must NOT call _stopAutobanEngine — it leaves the automation engine state untouched'
        );
        assert.ok(
            !body.includes("automationMode: 'agent-managed'"),
            'handoff must NOT set automationMode'
        );
        assert.ok(
            body.includes('status: 409'),
            'handoff must return 409 on unsafe handoff or second terminal move'
        );
        assert.ok(
            /!p\.dispatchedAt/.test(body) && /!p\.featureId/.test(body),
            'handoff queue validation predicate must match dispatchNextFromQueue candidate filter (!dispatchedAt && !featureId)'
        );
        assert.ok(
            /if \(!db\)[\s\S]{0,100}status: 409/.test(body),
            'handoff must fail closed with 409 when database is unavailable'
        );
    });

    console.log('');
    if (failures > 0) {
        console.error(`${failures} contract(s) failed.`);
        process.exit(1);
    }
    console.log('orchestrator tick + reports channel contract passed');
}

run().catch(err => {
    console.error('orchestrator tick + reports channel contract crashed:', err);
    process.exit(1);
});
