'use strict';

/**
 * Contract: agents are saved PER MACHINE, and a team picks one.
 *
 * Plan: `agents-are-saved-per-machine-and-a-team-picks-one`.
 *
 * The plan's core mechanism had no automated check at all — the machine id had
 * to thread config-read -> spawn, the spawn had to be transport-aware, and the
 * CLI identity had to be derived from the INNER cli at every derivation site.
 * Every one of those is a silent failure: a decorative selector, a seat that
 * spawns locally anyway, or a remote seat whose family reads `unknown` and
 * flat-waits the Devin ceiling on every prompt with no readiness detection.
 *
 * Behavioural assertions run against `out/` (run `npm run compile-tests` first);
 * the threading assertions are source-level against `src/`, because "which
 * composition root wires the seam" is not observable from a verb call.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..', '..');
const { GlobalIntegrationConfigService: Svc, LOCAL_AGENT_MACHINE } =
    require(path.join(REPO, 'out', 'services', 'GlobalIntegrationConfigService.js'));
const { isUntouchedSeed, SEEDED_AGENT_GROUP, DEFAULT_TEAM_DEFINITIONS, migrateAgentGroups } =
    require(path.join(REPO, 'out', 'services', 'teamWiring.js'));

let failures = 0;
function check(name, fn) {
    try { fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err && err.message}`); }
}
async function acheck(name, fn) {
    try { await fn(); console.log(`  PASS  ${name}`); }
    catch (err) { failures++; console.error(`  FAIL  ${name}\n        ${err && err.message}`); }
}

function read(rel) { return fs.readFileSync(path.join(REPO, rel), 'utf8'); }

const { stateFile } = require(path.join(REPO, 'out', 'utils', 'stateHome.js'));
function configPath() {
    return stateFile('integration-config.json');
}
function writeConfig(obj) {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(obj, null, 2));
    // The migration is a per-process one-shot; reset it so each phase starts clean.
    Svc._machineMigrationDone = false;
}
function readConfig() { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); }

async function run() {
    console.log('\nagent-machines-contract\n');

    // ── 1. Transport-aware spawn composition ────────────────────────────

    check('local renders the inner CLI unchanged (byte-identical to today)', () => {
        assert.strictEqual(Svc.renderSpawnCommand('claude --model opus', LOCAL_AGENT_MACHINE), 'claude --model opus');
        assert.strictEqual(
            Svc.renderSpawnCommand('claude', { id: 'x', name: 'X', transport: 'local', transportPrefix: '' }),
            'claude');
    });

    check('ssh single-quote-wraps the CLI as ONE remote argument', () => {
        assert.strictEqual(
            Svc.renderSpawnCommand('claude --model opus', { id: 't', name: 'T', transport: 'ssh', transportPrefix: 'user@tower' }),
            "ssh user@tower 'claude --model opus'");
    });

    check('ssh escapes single quotes inside the CLI', () => {
        const out = Svc.renderSpawnCommand("agy --say 'hi'", { id: 't', name: 'T', transport: 'ssh', transportPrefix: 'tower' });
        assert.strictEqual(out, "ssh tower 'agy --say '\\''hi'\\'''");
        assert.ok(!/'hi'/.test(out.slice(out.indexOf("'"))) || out.includes("'\\''"),
            'inner quotes must be escaped, never left to terminate the wrapper');
    });

    check('mosh uses -- and never quote-wraps (a dumb concat breaks one transport)', () => {
        assert.strictEqual(
            Svc.renderSpawnCommand('claude --model opus', { id: 'm', name: 'M', transport: 'mosh', transportPrefix: 'user@pi' }),
            'mosh user@pi -- claude --model opus');
    });

    check('an unknown transport never blind-concats the prefix', () => {
        const out = Svc.renderSpawnCommand('claude', { id: 'z', name: 'Z', transport: 'telnet', transportPrefix: 'host' });
        assert.strictEqual(out, 'claude', 'an unrecognised transport must not produce `<prefix> <cli>`');
    });

    // ── 2. Migration is lossless and always yields `local` ──────────────

    await acheck('legacy flat startupCommands migrate into machineStartupCommands.local, losslessly', async () => {
        const legacy = { planner: 'agy --approval-mode auto_edit', coder: 'claude --model opus', reviewer: 'devin' };
        writeConfig({ agents: { startupCommands: { ...legacy } } });

        const machines = await Svc.getMachines();
        assert.ok(machines.some(m => m.id === 'local' && m.transportPrefix === ''),
            'machines must contain local with an empty transport prefix after migration');

        const local = await Svc.getMachineStartupCommands('local');
        assert.deepStrictEqual(local, legacy, 'the local set must equal the pre-migration flat map');

        const onDisk = readConfig();
        assert.deepStrictEqual(onDisk.agents.machineStartupCommands.local, legacy);
        assert.deepStrictEqual(onDisk.agents.startupCommands, legacy,
            'the legacy key stays as the transition-window read-fallback');
    });

    await acheck('getAgentStartupCommands(machineId) is machine-scoped, with no cross-machine fallback', async () => {
        writeConfig({
            agents: {
                startupCommands: { coder: 'claude' },
                machines: [LOCAL_AGENT_MACHINE, { id: 'tower', name: 'Tower', transport: 'ssh', transportPrefix: 'user@tower' }],
                machineStartupCommands: { local: { coder: 'claude' }, tower: { coder: 'agy' } },
            },
        });
        assert.deepStrictEqual(await Svc.getAgentStartupCommands('local'), { coder: 'claude' });
        assert.deepStrictEqual(await Svc.getAgentStartupCommands('tower'), { coder: 'agy' });
        assert.strictEqual(await Svc.getAgentStartupCommands('nope'), undefined,
            'an unregistered machine must resolve to nothing, never to the local/legacy set');
    });

    // ── 3. The wipe guard survives the per-machine write path ───────────

    await acheck('setMachineStartupCommands refuses to blank a populated set (wipe guard)', async () => {
        writeConfig({ agents: { startupCommands: { coder: 'claude' }, machineStartupCommands: { local: { coder: 'claude' } } } });
        await Svc.setMachineStartupCommands('local', {});
        const after = readConfig();
        assert.deepStrictEqual(after.agents.machineStartupCommands.local, { coder: 'claude' },
            'an empty incoming map must not blank the machine set');
        assert.deepStrictEqual(after.agents.startupCommands, { coder: 'claude' },
            'and must not blank the legacy key the guard was added to protect');
    });

    await acheck('setMachineStartupCommands still writes a real map, and mirrors local to the legacy key', async () => {
        writeConfig({ agents: { startupCommands: { coder: 'claude' }, machineStartupCommands: { local: { coder: 'claude' } } } });
        await Svc.setMachineStartupCommands('local', { coder: 'claude', lead: 'agy' });
        const after = readConfig();
        assert.deepStrictEqual(after.agents.machineStartupCommands.local, { coder: 'claude', lead: 'agy' });
        assert.deepStrictEqual(after.agents.startupCommands, { coder: 'claude', lead: 'agy' });
    });

    // ── 4. Team definitions pin a machine, members carry no command ─────

    check('every seeded team definition pins machine: local and no member command', () => {
        for (const t of DEFAULT_TEAM_DEFINITIONS) {
            assert.strictEqual(t.machine, 'local', `${t.id} must pin machine: 'local'`);
            for (const m of t.members) {
                assert.ok(!('startupCommand' in m), `${t.id}/${m.role} must not carry startupCommand`);
            }
        }
    });

    check('migrateAgentGroups stamps machine, strips member startupCommand and any per-member machine', () => {
        const out = migrateAgentGroups([{
            id: 'g', name: 'G', headRole: 'lead',
            members: [{ role: 'coder', count: 1, startupCommand: "ssh tower 'claude'", machine: 'tower' }],
        }]);
        assert.ok(Array.isArray(out), 'a legacy group must be reported as changed');
        assert.strictEqual(out[0].machine, 'local');
        assert.ok(!('startupCommand' in out[0].members[0]), 'per-member startupCommand is retired');
        assert.ok(!('machine' in out[0].members[0]), 'split-team guard: a member never carries its own machine');
    });

    // ── 5. The phantom-seed predicate tolerates both persisted shapes ───

    // The persisted shape DERIVED from the seed, never retyped. These fixtures
    // used to hard-code `[{ role: 'coder', count: 3 }]`, which silently stopped
    // describing the seed the moment its roster changed — and the roster did
    // change (the Feature team is 2 coders and an intern, not 3 coders). A
    // hand-copied fixture turns a roster edit into a red gate that looks like a
    // predicate bug, which is the two-copies-disagreeing trap in a test file.
    const seedMembersAsPersisted = (extra) => SEEDED_AGENT_GROUP.members.map(m => ({
        ...m, scope: 'per-team', relationship: 'reports-to-head', ...(extra || {}),
    }));

    check('a seed persisted BEFORE the machine field still reads as untouched', () => {
        const legacyShaped = {
            id: SEEDED_AGENT_GROUP.id,
            name: SEEDED_AGENT_GROUP.name,
            headRole: SEEDED_AGENT_GROUP.headRole,
            members: seedMembersAsPersisted({ startupCommand: '' }),
        };
        assert.strictEqual(isUntouchedSeed(legacyShaped), true,
            'a persisted seed with the retired startupCommand and no machine key must NOT read as authored');
    });

    check('a seed persisted AFTER the machine field reads as untouched', () => {
        const current = {
            id: SEEDED_AGENT_GROUP.id,
            name: SEEDED_AGENT_GROUP.name,
            headRole: SEEDED_AGENT_GROUP.headRole,
            machine: 'local',
            members: seedMembersAsPersisted(),
        };
        assert.strictEqual(isUntouchedSeed(current), true);
    });

    check('an authored team still fails the seed match', () => {
        assert.strictEqual(isUntouchedSeed({
            id: SEEDED_AGENT_GROUP.id, name: SEEDED_AGENT_GROUP.name, headRole: SEEDED_AGENT_GROUP.headRole,
            machine: 'local',
            members: seedMembersAsPersisted({ startupCommand: 'claude' }),
        }), false, 'a real per-member command is an operator edit');
        assert.strictEqual(isUntouchedSeed({
            id: SEEDED_AGENT_GROUP.id, name: SEEDED_AGENT_GROUP.name, headRole: SEEDED_AGENT_GROUP.headRole,
            machine: 'tower',
            members: seedMembersAsPersisted(),
        }), false, 'a re-pinned machine is an operator edit');
        assert.strictEqual(isUntouchedSeed({
            id: SEEDED_AGENT_GROUP.id, name: SEEDED_AGENT_GROUP.name, headRole: SEEDED_AGENT_GROUP.headRole,
            machine: 'local',
            members: [...seedMembersAsPersisted(), { role: 'reviewer', count: 1, label: '', scope: 'per-team', relationship: 'reports-to-head' }],
        }), false, 'an added seat is an operator edit');
    });

    // ── 6. The machine id reaches the HEAD, not just the delegates ──────

    check('instantiateAgentGroupCore threads group.machine into createHeadWithDelegates', () => {
        const src = read('src/services/agentGroupInstantiation.ts');
        assert.ok(/const teamMachineId = \(typeof group\?\.machine === 'string' && group\.machine\) \? group\.machine : 'local'/.test(src),
            'the team machine must be resolved from group.machine with a local default');
        const headCall = src.slice(src.indexOf('createHeadWithDelegates({'));
        assert.ok(/machineId: teamMachineId/.test(headCall.slice(0, 1200)),
            'createHeadWithDelegates must receive the team machine — otherwise the head spawns locally');
        assert.ok(/machineId: \(typeof group\?\.machine === 'string' && group\.machine\) \? group\.machine : 'local'/.test(src),
            'the external-headed team must hand its workers the team machine too');
    });

    check('both fleet roots thread machineId into create and spawnDelegates', () => {
        for (const rel of ['src/standalone/ptyFleetService.ts', 'src/services/goPtyFleetProjection.ts']) {
            const src = read(rel);
            assert.ok(/getAgentStartupCommands\(machineId\)/.test(src), `${rel} must resolve commands per machine`);
            assert.ok(/const delegateMachineId = opts\?\.machineId \|\| parent\.machineId \|\| 'local'/.test(src),
                `${rel} delegates must inherit the team machine`);
            assert.ok(/refusing to spawn on a fallback machine/.test(src),
                `${rel} must FAIL LOUDLY on an unregistered machine, never fall back to local`);
            assert.ok(!/d\.startupCommand/.test(src), `${rel} must not read the retired per-member startupCommand`);
        }
    });

    check('no composition root spawns an external-headed team without the machine', () => {
        assert.ok(/machineId: spec\.machineId/.test(read('src/standalone/bootstrap.ts')),
            'bootstrap createDelegatesOnly must pass the team machine');
        assert.ok(/machineId: spec\.machineId/.test(read('src/services/LocalApiServer.ts')),
            'LocalApiServer createDelegatesOnly must pass the team machine');
    });

    // ── 7. CLI identity is never derived from a transport-wrapped string ─

    check('cliFamily is derived from the INNER cli at every derivation site', () => {
        const fleet = read('src/standalone/ptyFleetService.ts');
        assert.ok(/const cliFamily = deriveCliFamily\(innerCli\);/.test(fleet),
            'ptyFleetService spawn-time derivation must read the inner cli');
        assert.ok(/handle\.cliFamily = deriveCliFamily\(injected\.inner\);/.test(fleet),
            'ptyFleetService re-derivation after injection must read the inner cli');
        assert.ok(!/deriveCliFamily\(effectiveStartupCommand\)/.test(fleet),
            'ptyFleetService must never derive from the composed command');

        const go = read('src/services/goPtyFleetProjection.ts');
        assert.ok(/cliFamily: deriveCliFamily\(innerCli\)/.test(go),
            'goPtyFleetProjection must derive from the inner cli');
        assert.ok(/deriveCliFamily\(row\.startupCommandInner \|\| row\.startupCommand\)/.test(go),
            'the read-back projection must prefer the inner cli');
        assert.ok(!/deriveCliFamily\(effectiveStartupCommand\)/.test(go),
            'goPtyFleetProjection must never derive from the composed command');

        const delivery = read('src/standalone/ptyPromptDelivery.ts');
        assert.ok(/handle\.startupCommandInner \?\? handle\.startupCommand/.test(delivery),
            'ptyPromptDelivery re-derivation must prefer the inner cli');
    });

    check('the Go host records and reports the inner cli and the machine id', () => {
        const main = read('cmd/switchboard-pty-host/main.go');
        assert.ok(/startupCommandInner: strField\(payload, "startupCommandInner"\)/.test(main),
            'the host must accept startupCommandInner at create');
        assert.ok(/machineId:\s+strField\(payload, "machineId"\)/.test(main),
            'the host must accept machineId at create');
        assert.ok(/"startupCommandInner": t\.startupCommandInner/.test(main),
            'the host must report startupCommandInner so the projection can re-derive');
        assert.ok(/"machineId":\s+t\.machineId/.test(main),
            'the host must report machineId');
        // Inbound field-existence: the writer must actually send them.
        const go = read('src/services/goPtyFleetProjection.ts');
        assert.ok(/startupCommandInner: innerCli/.test(go), 'the create payload must carry startupCommandInner');
        assert.ok(/machineId,/.test(go), 'the create payload must carry machineId');
    });

    // ── 8. The probe is argv, batch-mode, and time-bounded ──────────────

    check('the reachability probe never builds a shell string from the transport prefix', () => {
        const src = read('src/services/KanbanProvider.ts');
        const probe = src.slice(src.indexOf("case 'probeMachine'"), src.indexOf("case 'probeMachine'") + 3000);
        assert.ok(/execFile\(/.test(probe), 'the probe must use execFile (argv), not exec (shell)');
        assert.ok(/BatchMode=yes/.test(probe), 'ssh must run in BatchMode or it blocks on a prompt it cannot answer');
        assert.ok(/ConnectTimeout=5/.test(probe), 'the probe must bound the connect');
        assert.ok(/timeout: 10000/.test(probe), 'the probe must carry an overall ceiling');
    });

    // ── 9. Remote-seat env inlining — identity and board URL ride in argv ─
    // Plan: a-remote-seat-reaches-the-board-over-http-not-a-tunnel. ssh/mosh do
    // not forward the pty's environment, so the host inlines `env K=V …` into
    // the composed command. The command is typed, stored and logged — a
    // credential in it is a persistent leak, so the renderable set is closed.

    const seatEnv = {
        SWITCHBOARD_TERMINAL: 'Coding-coder-1',
        SWITCHBOARD_AGENT_INSTANCE_ID: 'inst-123',
        SWITCHBOARD_SERVER_URL: 'http://100.64.0.1:7777',
        SWITCHBOARD_WORKSPACE_ROOT: '/home/patrick/switchboard',
    };
    const sshMachine = { id: 'tower', name: 'Tower', transport: 'ssh', transportPrefix: 'user@tower' };
    const moshMachine = { id: 'pi', name: 'Pi', transport: 'mosh', transportPrefix: 'user@pi' };

    check('ssh inlines env inside the single-quoted remote arg, in allowlist order', () => {
        assert.strictEqual(
            Svc.renderSpawnCommand('claude', sshMachine, seatEnv),
            "ssh user@tower 'env SWITCHBOARD_TERMINAL='\\''Coding-coder-1'\\'' SWITCHBOARD_AGENT_INSTANCE_ID='\\''inst-123'\\'' SWITCHBOARD_SERVER_URL='\\''http://100.64.0.1:7777'\\'' SWITCHBOARD_WORKSPACE_ROOT='\\''/home/patrick/switchboard'\\'' claude'");
    });

    check('mosh inlines env after -- (argv preserved to the remote exec)', () => {
        assert.strictEqual(
            Svc.renderSpawnCommand('claude', moshMachine, seatEnv),
            "mosh user@pi -- env SWITCHBOARD_TERMINAL='Coding-coder-1' SWITCHBOARD_AGENT_INSTANCE_ID='inst-123' SWITCHBOARD_SERVER_URL='http://100.64.0.1:7777' SWITCHBOARD_WORKSPACE_ROOT='/home/patrick/switchboard' claude");
    });

    check('local ignores seatEnv — the pty env already carries it', () => {
        assert.strictEqual(Svc.renderSpawnCommand('claude', LOCAL_AGENT_MACHINE, seatEnv), 'claude');
        assert.strictEqual(Svc.renderSpawnCommand('claude', sshMachine), "ssh user@tower 'claude'",
            'no seatEnv renders exactly the pre-env-inlining command');
    });

    check('a smuggled credential NEVER renders — allowlist drops it', () => {
        const out = Svc.renderSpawnCommand('claude', sshMachine,
            { ...seatEnv, SWITCHBOARD_API_TOKEN: 'sekrit-token-value' });
        assert.ok(!out.includes('SWITCHBOARD_API_TOKEN'),
            'the token KEY must never appear in a typed command (scrollback + handle field + log line)');
        assert.ok(!out.includes('sekrit-token-value'),
            'the token VALUE must never appear in a typed command');
        assert.ok(out.includes('SWITCHBOARD_TERMINAL'), 'allowlisted env still renders alongside the drop');
    });

    check('the renderable allowlist is closed and excludes the credential', () => {
        const src = read('src/services/GlobalIntegrationConfigService.ts');
        const decl = src.slice(src.indexOf('SEAT_ENV_ALLOWLIST'), src.indexOf('];', src.indexOf('SEAT_ENV_ALLOWLIST')));
        for (const key of ['SWITCHBOARD_TERMINAL', 'SWITCHBOARD_AGENT_INSTANCE_ID', 'SWITCHBOARD_SERVER_URL', 'SWITCHBOARD_WORKSPACE_ROOT']) {
            assert.ok(decl.includes(`'${key}'`), `${key} must be renderable`);
        }
        assert.ok(!decl.includes('SWITCHBOARD_API_TOKEN'), 'the credential must not be renderable');
    });

    check('env values with spaces and quotes are single-quote-escaped', () => {
        const out = Svc.renderSpawnCommand('claude', moshMachine, { SWITCHBOARD_WORKSPACE_ROOT: "/a b's" });
        assert.strictEqual(out, "mosh user@pi -- env SWITCHBOARD_WORKSPACE_ROOT='/a b'\\''s' claude",
            'an unquoted space would split the env assignment into a command name');
    });

    check('remoteCwd renders cd ahead of env for ssh', () => {
        const out = Svc.renderSpawnCommand('claude', { ...sshMachine, remoteCwd: '/srv/work' }, seatEnv);
        const cdIdx = out.indexOf('cd ');
        const envIdx = out.indexOf('env SWITCHBOARD_TERMINAL');
        const cliIdx = out.lastIndexOf('claude');
        assert.ok(cdIdx > "ssh".length && envIdx > cdIdx && cliIdx > envIdx,
            `expected cd <wd> && env … <cli> order inside the remote arg, got: ${out}`);
    });

    check('mosh wraps the remote in sh -c when remoteCwd is set (post-`--` is exec, cd is a builtin)', () => {
        const out = Svc.renderSpawnCommand('claude', { ...moshMachine, remoteCwd: '/srv/work' }, seatEnv);
        assert.ok(out.startsWith('mosh user@pi -- sh -c '), `expected sh -c wrap, got: ${out}`);
        assert.ok(/cd .*&& env /.test(out), 'cd <wd> && env … must be inside the sh -c script');
        // Without a remoteCwd there is no shell — env (a binary) is exec'd.
        assert.ok(!Svc.renderSpawnCommand('claude', moshMachine, seatEnv).includes('sh -c'));
    });

    check('AgentMachine carries cliPath and remoteCwd (new config surface)', () => {
        const src = read('src/services/GlobalIntegrationConfigService.ts');
        const decl = src.slice(src.indexOf('export interface AgentMachine'), src.indexOf('}', src.indexOf('export interface AgentMachine')));
        assert.ok(/cliPath\?: string/.test(decl), 'cliPath must be an optional field');
        assert.ok(/remoteCwd\?: string/.test(decl), 'remoteCwd must be an optional field');
    });

    check('the projection builds seatEnv for remote machines only — and the token is never in it', () => {
        const src = read('src/services/goPtyFleetProjection.ts');
        const block = src.slice(src.indexOf('let seatEnv'), src.indexOf('const innerCli'));
        assert.ok(/machine\.transport !== 'local'/.test(block), 'seatEnv must be gated on a non-local machine');
        assert.ok(/SWITCHBOARD_TERMINAL: name/.test(block), 'seatEnv carries the seat name');
        assert.ok(/SWITCHBOARD_AGENT_INSTANCE_ID: agentInstanceId/.test(block), 'seatEnv carries the host-generated instance id');
        assert.ok(/SWITCHBOARD_SERVER_URL: boardEndpoint/.test(block), 'seatEnv carries the resolved board URL');
        assert.ok(/SWITCHBOARD_WORKSPACE_ROOT: this\.workspaceRoot/.test(block), 'seatEnv carries the workspace root');
        assert.ok(!/SWITCHBOARD_API_TOKEN/.test(block), 'seatEnv must never carry the credential');
        assert.ok(/renderSpawnCommand\(innerCli, machine, seatEnv\)/.test(src),
            'the composed command must receive the env');
    });

    check('a remote spawn with no board endpoint throws, naming `switchboard tailnet`', () => {
        const src = read('src/services/goPtyFleetProjection.ts');
        assert.ok(/setBoardEndpointResolver/.test(src), 'the resolver seam must exist');
        // The source escapes the backticks inside the template literal, so the
        // file contains \`switchboard tailnet\` — match the escaped form.
        assert.ok(/is remote but the board has no tailnet listener — run \\`switchboard tailnet\\`/.test(src),
            'a loopback-only board + remote machine must fail loudly, naming the posture');
    });

    check('the host-generated agentInstanceId is sent in the create payload (same id in pty env and inlined env)', () => {
        const go = read('src/services/goPtyFleetProjection.ts');
        const reqStart = go.indexOf("this.supervisor.request('ptyCreateTerminal'");
        const payload = go.slice(reqStart, go.indexOf('});', reqStart));
        assert.ok(/agentInstanceId,/.test(payload), 'the payload must carry the host-generated id');
        const main = read('cmd/switchboard-pty-host/main.go');
        assert.ok(/strField\(payload, "agentInstanceId"\)/.test(main) && /agentID = existing/.test(main),
            'the Go host must honour a caller-supplied agentInstanceId over its generated one');
    });

    check('bootstrap wires the board-endpoint resolver to the tailnet listener', () => {
        const src = read('src/standalone/bootstrap.ts').replace(/\s+/g, ' ');
        assert.ok(/ptyFleetService\.setBoardEndpointResolver\(/.test(src),
            'the standalone host must tell the fleet which URL a remote seat dials');
        assert.ok(/isTailnetPolicy\(bindPolicy\) \? `http:\/\/\$\{bindPolicy\.tailnetAddress\}:\$\{port\}` : null/.test(src),
            'the resolver must answer the tailnet-listener URL and null under a loopback-only bind');
        assert.ok(!/serve/i.test(src.slice(src.indexOf('setBoardEndpointResolver'), src.indexOf('setBoardEndpointResolver') + 300)),
            'the `tailscale serve` URL must never be the seat endpoint — its proxy lands on loopback and would 401');
    });

    check('the env-wrapped composed string still never reaches cli derivation (load-bearing now it starts with `env `)', () => {
        for (const rel of ['src/standalone/ptyFleetService.ts', 'src/services/goPtyFleetProjection.ts']) {
            const src = read(rel);
            assert.ok(!/deriveCliFamily\(composed/.test(src) && !/deriveCliIdentity\(composed/.test(src),
                `${rel} must not derive family or identity from the composed command`);
            assert.ok(!/deriveCliFamily\(startupCommandComposed/.test(src),
                `${rel} must not derive family from startupCommandComposed`);
        }
    });

    // ── 10. Per-machine CLI invocation at the prompt seams ────────────────
    // Plan: a-remote-machines-cli-path-and-working-directory. A remote seat
    // must be handed ITS machine's CLI — the configured `cliPath`, or bare
    // `switchboard` resolved by the remote's own PATH — never the board host's
    // absolute binary path, which does not exist on the remote (and a
    // path-shaped coincidence would be the wrong architecture anyway).

    const { resolveCliInvocationForMachine, substituteCliPath, formatCliInvocation, resolveBundledCliPath } =
        require(path.join(REPO, 'out', 'utils', 'cliPathToken.js'));

    check('local resolves today\'s formatCliInvocation() byte-for-byte', () => {
        assert.strictEqual(resolveCliInvocationForMachine(LOCAL_AGENT_MACHINE), formatCliInvocation());
        assert.strictEqual(resolveCliInvocationForMachine({ id: 'x', name: 'X', transport: 'local', transportPrefix: '' }), formatCliInvocation());
    });

    check('an absent machine is not proven local — resolves remote-PATH switchboard, never the host path', () => {
        assert.strictEqual(resolveCliInvocationForMachine(undefined), 'switchboard');
        assert.strictEqual(resolveCliInvocationForMachine(null), 'switchboard');
        assert.ok(!resolveCliInvocationForMachine(undefined).includes(resolveBundledCliPath()));
    });

    await acheck('resolveCliInvocationForMachineId: remote cliPath wins; absent resolves bare switchboard', async () => {
        writeConfig({
            agents: {
                machines: [
                    LOCAL_AGENT_MACHINE,
                    { id: 'tower', name: 'Tower', transport: 'ssh', transportPrefix: 'user@tower', cliPath: '/opt/switchboard/bin/switchboard' },
                    { id: 'bare', name: 'Bare', transport: 'ssh', transportPrefix: 'user@bare' },
                ],
            },
        });
        assert.strictEqual(await Svc.resolveCliInvocationForMachineId('tower'), '"/opt/switchboard/bin/switchboard"');
        assert.strictEqual(await Svc.resolveCliInvocationForMachineId('bare'), 'switchboard',
            'no cliPath → remote PATH answers — right architecture by construction');
        assert.strictEqual(await Svc.resolveCliInvocationForMachineId('local'), formatCliInvocation());
        assert.strictEqual(await Svc.resolveCliInvocationForMachineId(undefined), formatCliInvocation());
        const hostPath = resolveBundledCliPath();
        for (const id of ['tower', 'bare']) {
            const inv = await Svc.resolveCliInvocationForMachineId(id);
            assert.ok(!inv.includes(hostPath), `remote '${id}' must never inherit the host's absolute CLI path`);
        }
    });

    check('substituteCliPath honours an invocation override verbatim — remote never sees the host path', () => {
        const text = 'run `node "<cliPath>" done` when finished; binary lives at <cliPath>';
        assert.strictEqual(
            substituteCliPath(text, undefined, 'switchboard'),
            'run `switchboard done` when finished; binary lives at switchboard');
        assert.strictEqual(
            substituteCliPath(text, undefined, '"/opt/sw/switchboard"'),
            'run `"/opt/sw/switchboard" done` when finished; binary lives at /opt/sw/switchboard');
        const hostPath = resolveBundledCliPath();
        for (const inv of ['switchboard', '"/opt/sw/switchboard"']) {
            const out = substituteCliPath(text, undefined, inv);
            assert.ok(!out.includes(hostPath), `remote invocation '${inv}' must not leak the host path`);
            assert.ok(!out.includes('node "'), 'a remote invocation is never re-wrapped in `node "…"`');
        }
        // No override → identical to today (the local contract).
        assert.strictEqual(substituteCliPath(text), substituteCliPath(text, resolveBundledCliPath()));
    });

    check('every delivery seam resolves the target seat\'s machine before substituting', () => {
        const boot = read('src/standalone/bootstrap.ts');
        assert.ok(/resolveCliInvocationForMachineId\(handle\?\.machineId\)/.test(boot),
            'deliverPrompt must resolve the seat\'s machineId before applyStandingOrders');
        assert.ok(/resolveCliInvocationForMachineId\(targetHandle\?\.machineId\)/.test(boot),
            'the tmux standing-orders applier must resolve the target\'s machineId');

        const tvp = read('src/services/TaskViewerProvider.ts');
        assert.ok(/resolveCliInvocationForMachineId\(targetRow\?\.machineId\)/.test(tvp),
            'the ptySendPrompt composition must resolve the target row\'s machineId');
        assert.ok(/resolveCliInvocationForMachineId\(targetMachineId\)/.test(tvp),
            'the establish/clear and VS Code snapshot paths must resolve the target\'s machineId');

        const kp = read('src/services/KanbanProvider.ts');
        assert.ok(/cliInvocation: await this\._resolveCliInvocationForSeat\(overrides\?\.dispatchTargetTerminal\)/.test(kp),
            'resolvedOptions must carry the target seat\'s machine-resolved invocation');
        assert.ok(/_resolveCliInvocationForSeat\(head \|\| undefined\)/.test(kp),
            'the drive prefixes must resolve the head seat\'s machine');
        const ext = read('src/extension.ts');
        assert.ok(/cliInvocation: snapshot\.cliInvocation/.test(ext),
            'the extension applier must thread the snapshot\'s resolved invocation');

        const tw = read('src/services/teamWiring.ts');
        assert.ok(/resolveCliInvocationForMachineId\(opts\.machineId\)/.test(tw),
            'member-orders.md must resolve the team\'s machine — the file is read ON the remote');
        assert.ok(/machineId: opts\.machineId/.test(tw),
            'wireSpawnedTeam must thread the team machine into writeMemberOrdersFile');
        for (const rel of ['src/services/agentGroupInstantiation.ts', 'src/services/TaskViewerProvider.ts', 'src/standalone/bootstrap.ts']) {
            assert.ok(/machineId:/.test(read(rel).slice(read(rel).indexOf('wireSpawnedTeam('), read(rel).indexOf('wireSpawnedTeam(') + 900)),
                `${rel} must pass the team machine to wireSpawnedTeam`);
        }
    });

    await acheck('the machines store round-trips cliPath and remoteCwd through save and reload', async () => {
        writeConfig({ agents: {} });
        const machine = {
            id: 'tower', name: 'Tower', transport: 'ssh', transportPrefix: 'user@tower',
            cliPath: '/opt/switchboard/bin/switchboard', remoteCwd: '/srv/checkout',
        };
        await Svc.setMachines([LOCAL_AGENT_MACHINE, machine]);
        const reloaded = await Svc.getMachineSync('tower');
        assert.strictEqual(reloaded?.cliPath, '/opt/switchboard/bin/switchboard');
        assert.strictEqual(reloaded?.remoteCwd, '/srv/checkout');
    });

    check('both saveMachine handlers pass cliPath/remoteCwd through normalization', () => {
        for (const rel of ['src/services/KanbanProvider.ts', 'src/services/TaskViewerProvider.ts']) {
            const src = read(rel);
            const block = src.slice(src.indexOf("case 'saveMachine'"), src.indexOf("case 'saveMachine'") + 2500);
            assert.ok(/cliPath/.test(block), `${rel} saveMachine must carry cliPath`);
            assert.ok(/remoteCwd/.test(block), `${rel} saveMachine must carry remoteCwd`);
        }
    });

    check('the machine probe extends to a CLI check on the remote (advisory, both handlers)', () => {
        for (const rel of ['src/services/KanbanProvider.ts', 'src/services/TaskViewerProvider.ts']) {
            const src = read(rel);
            const block = src.slice(src.indexOf("case 'probeMachine'"), src.indexOf("case 'probeMachine'") + 4500);
            assert.ok(/command -v switchboard/.test(block), `${rel} probe must check the remote for switchboard`);
            assert.ok(/cliFound/.test(block), `${rel} probe result must report cliFound`);
        }
    });

    check('the machine editor exposes cliPath and remoteCwd inputs', () => {
        const html = read('src/webview/agent-control.html');
        assert.ok(/id="agents-tab-machine-clipath"/.test(html), 'cliPath input must exist');
        assert.ok(/id="agents-tab-machine-remotecwd"/.test(html), 'remoteCwd input must exist');
        const js = read('src/webview/agent-control.js');
        assert.ok(/agents-tab-machine-clipath/.test(js) && /agents-tab-machine-remotecwd/.test(js),
            'the editor must populate and collect both fields');
    });

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

run();
