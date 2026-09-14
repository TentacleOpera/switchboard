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

    check('a seed persisted BEFORE the machine field still reads as untouched', () => {
        const legacyShaped = {
            id: SEEDED_AGENT_GROUP.id,
            name: SEEDED_AGENT_GROUP.name,
            headRole: SEEDED_AGENT_GROUP.headRole,
            members: [{ role: 'coder', count: 3, label: '', startupCommand: '', scope: 'per-team', relationship: 'reports-to-head' }],
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
            members: [{ role: 'coder', count: 3, label: '', scope: 'per-team', relationship: 'reports-to-head' }],
        };
        assert.strictEqual(isUntouchedSeed(current), true);
    });

    check('an authored team still fails the seed match', () => {
        assert.strictEqual(isUntouchedSeed({
            id: SEEDED_AGENT_GROUP.id, name: SEEDED_AGENT_GROUP.name, headRole: SEEDED_AGENT_GROUP.headRole,
            machine: 'local',
            members: [{ role: 'coder', count: 3, label: '', startupCommand: 'claude', scope: 'per-team', relationship: 'reports-to-head' }],
        }), false, 'a real per-member command is an operator edit');
        assert.strictEqual(isUntouchedSeed({
            id: SEEDED_AGENT_GROUP.id, name: SEEDED_AGENT_GROUP.name, headRole: SEEDED_AGENT_GROUP.headRole,
            machine: 'tower',
            members: [{ role: 'coder', count: 3, label: '', scope: 'per-team', relationship: 'reports-to-head' }],
        }), false, 'a re-pinned machine is an operator edit');
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

    console.log(`\n${failures === 0 ? 'ALL PASSED' : `${failures} FAILED`}\n`);
    process.exit(failures === 0 ? 0 : 1);
}

run();
