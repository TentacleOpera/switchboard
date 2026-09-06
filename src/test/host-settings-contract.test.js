'use strict';

/**
 * Contract: host settings resolve with a distinguishable source, persist
 * atomically under an optimistic revision, and are wired by BOTH composition
 * roots (plan: settings-window-and-the-write-path-review-deleted).
 *
 * WHY THIS FILE EXISTS — the traps it pins.
 *
 * 1. The write path this plan restores was deleted in an earlier review for a
 *    named reason: it stored a preference in a process-private field that
 *    nothing read back, and answered `success: true` regardless. The only
 *    defence against that recurring is a test that asserts a saved value comes
 *    back out of a real file with a changed revision.
 *
 * 2. Per-field provenance is the whole point. `local` resolved from a default
 *    and `local` resolved from a saved document are the same VALUE; if they
 *    carry the same SOURCE, a broken env file looks exactly like a configured
 *    one. Every case below asserts the label, not just the value.
 *
 * 3. Both hosts must wire the same seams. Standalone wired the Setup provider
 *    eagerly at bootstrap while the extension guarded on a lazily-created
 *    field that nothing populated until an HTTP hit, so the extension's Host
 *    tab answered "not wired" on every start and the durable PATH never
 *    reached spawned agents. Both roots are asserted at source level here
 *    because no runtime gate covers the extension host.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`);
    }
}
async function checkAsync(name, fn) {
    try {
        await fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err && err.stack ? err.stack.split('\n').slice(0, 3).join('\n     ') : err}`);
    }
}

// ── Load the compiled service ─────────────────────────────────────────────
// The suite runs against out/ (tsc) when present; that is the same shape the
// hosts import.
const CANDIDATES = [
    path.join(REPO_ROOT, 'out', 'services', 'hostSettings.js'),
    path.join(REPO_ROOT, 'dist', 'services', 'hostSettings.js'),
];
const modulePath = CANDIDATES.find(p => fs.existsSync(p));
if (!modulePath) {
    console.error('  ❌ hostSettings.js not compiled — run `npm run compile:tests` (or `npm run compile`) first.');
    console.error(`     looked in: ${CANDIDATES.join(', ')}`);
    process.exit(1);
}

// Each case gets its own SWITCHBOARD_STATE_HOME so nothing touches the real
// ~/.switchboard. `stateFile()` re-reads the env var on every call, so the
// service does not need re-importing between cases.
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-host-settings-'));
process.env.SWITCHBOARD_STATE_HOME = SANDBOX;
const hs = require(modulePath);

function settingsPath() {
    return path.join(process.env.SWITCHBOARD_STATE_HOME, '.switchboard', 'host-settings.json');
}
function freshSandbox() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-host-settings-'));
    process.env.SWITCHBOARD_STATE_HOME = dir;
    return dir;
}
function writeDoc(doc) {
    const fp = settingsPath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, typeof doc === 'string' ? doc : JSON.stringify(doc, null, 2) + '\n', 'utf8');
}

(async () => {

// ── 1. Missing file → every field tagged `default`, never `durable` ───────
check('a missing document returns defaults tagged `default`', () => {
    freshSandbox();
    const r = hs.createHostSettingsService().read();
    assert.strictEqual(r.revision, hs.EMPTY_REVISION, 'missing file must report the empty revision sentinel');
    assert.strictEqual(r.port.effectiveValue, 7777);
    assert.strictEqual(r.port.effectiveSource, 'default', 'a default port must not be labelled durable');
    assert.strictEqual(r.serveMode.effectiveValue, 'local');
    assert.strictEqual(r.serveMode.effectiveSource, 'default');
    assert.strictEqual(r.port.configuredValue, null, 'nothing is configured when no file exists');
    assert.strictEqual(r.port.configuredSource, null);
});

// ── 2. Precedence table: explicit > durable > legacy-env > default ────────
check('explicit CLI input beats the durable document, and says so', () => {
    freshSandbox();
    writeDoc({ version: 1, workspaces: [], defaultWorkspaceId: null, port: 9100, serveMode: 'tailnet', extraPath: [] });
    const r = hs.createHostSettingsService().resolve({
        explicit: {
            port: { value: 8123, source: 'cli-flag' },
            serveMode: { value: 'local', source: 'cli-subcommand' },
        },
    });
    assert.strictEqual(r.port.effectiveValue, 8123);
    assert.strictEqual(r.port.effectiveSource, 'cli-flag');
    assert.strictEqual(r.serveMode.effectiveValue, 'local');
    assert.strictEqual(r.serveMode.effectiveSource, 'cli-subcommand');
    // The saved next-start value stays visible alongside the explicit one.
    assert.strictEqual(r.port.configuredValue, 9100);
    assert.strictEqual(r.port.configuredSource, 'durable');
    assert.strictEqual(r.serveMode.configuredValue, 'tailnet');
});

check('the durable document beats the legacy env, and says so', () => {
    freshSandbox();
    writeDoc({ version: 1, workspaces: [], defaultWorkspaceId: null, port: 9100, serveMode: 'tailnet', extraPath: [] });
    const r = hs.createHostSettingsService().resolve({ legacy: { port: '7000', serveMode: 'local' } });
    assert.strictEqual(r.port.effectiveValue, 9100);
    assert.strictEqual(r.port.effectiveSource, 'durable');
    assert.strictEqual(r.serveMode.effectiveValue, 'tailnet');
    assert.strictEqual(r.serveMode.effectiveSource, 'durable');
});

check('the legacy env answers only when the durable field is absent', () => {
    freshSandbox();
    const r = hs.createHostSettingsService().resolve({ legacy: { port: '7000', serveMode: 'tailnet' } });
    assert.strictEqual(r.port.effectiveValue, 7000);
    assert.strictEqual(r.port.effectiveSource, 'legacy-env');
    assert.strictEqual(r.serveMode.effectiveValue, 'tailnet');
    assert.strictEqual(r.serveMode.effectiveSource, 'legacy-env');
});

check('equal values from different stores keep different source labels', () => {
    // The defect this guards: `local` is the default AND a legal saved value.
    // If both report the same source, "nothing is configured" is
    // indistinguishable from "the operator chose local".
    freshSandbox();
    const fromDefault = hs.createHostSettingsService().read();
    writeDoc({ version: 1, workspaces: [], defaultWorkspaceId: null, port: null, serveMode: 'local', extraPath: [] });
    const fromDurable = hs.createHostSettingsService().read();
    assert.strictEqual(fromDefault.serveMode.effectiveValue, fromDurable.serveMode.effectiveValue, 'same value');
    assert.notStrictEqual(
        fromDefault.serveMode.effectiveSource, fromDurable.serveMode.effectiveSource,
        'the same value from two stores MUST carry two sources');
});

// ── 3. A malformed legacy value must not borrow the legacy label ──────────
check('a malformed legacy port falls through to the tagged default', () => {
    freshSandbox();
    const r = hs.createHostSettingsService().resolve({ legacy: { port: 'not-a-port' } });
    assert.strictEqual(r.port.effectiveValue, 7777);
    assert.strictEqual(
        r.port.effectiveSource, 'default',
        'a substituted 7777 must NOT be labelled legacy-env — a broken env file would look configured');
});

check('an out-of-range legacy port falls through to the tagged default', () => {
    freshSandbox();
    const r = hs.createHostSettingsService().resolve({ legacy: { port: '99999' } });
    assert.strictEqual(r.port.effectiveSource, 'default');
});

// ── 4. Validation ─────────────────────────────────────────────────────────
check('a corrupt document fails loudly and leaves the file untouched', () => {
    freshSandbox();
    writeDoc('{ this is not json');
    const before = fs.readFileSync(settingsPath(), 'utf8');
    assert.throws(() => hs.createHostSettingsService().read(), (e) => e && e.code === 'corrupt');
    assert.strictEqual(fs.readFileSync(settingsPath(), 'utf8'), before, 'a corrupt file must not be rewritten');
});

check('an invalid stored serveMode is rejected, not silently defaulted', () => {
    freshSandbox();
    writeDoc({ version: 1, workspaces: [], defaultWorkspaceId: null, port: null, serveMode: 'public', extraPath: [] });
    assert.throws(() => hs.createHostSettingsService().read(), (e) => e && e.code === 'invalid');
});

// ── 5. Writes: atomic, revision-checked, unknown-key preserving ───────────
await checkAsync('a saved value round-trips through a real file with a new revision', async () => {
    freshSandbox();
    const svc = hs.createHostSettingsService();
    const before = svc.read();
    const after = await svc.update({ port: 8321, serveMode: 'tailnet' }, before.revision);
    assert.notStrictEqual(after.revision, before.revision, 'the revision must change after a write');
    assert.ok(fs.existsSync(settingsPath()), 'the durable file must exist after a save');
    // Read back through a FRESH service — the value must come off disk, not
    // out of a process-private field (the exact defect the earlier review cut).
    const reread = hs.createHostSettingsService().read();
    assert.strictEqual(reread.port.effectiveValue, 8321);
    assert.strictEqual(reread.port.effectiveSource, 'durable');
    assert.strictEqual(reread.serveMode.effectiveValue, 'tailnet');
    assert.strictEqual(reread.revision, after.revision);
});

await checkAsync('a stale revision is rejected with the fresh state and writes nothing', async () => {
    freshSandbox();
    const svc = hs.createHostSettingsService();
    const first = svc.read();
    await svc.update({ port: 8100 }, first.revision);
    const onDisk = fs.readFileSync(settingsPath(), 'utf8');
    let conflict = null;
    try {
        await svc.update({ port: 8200 }, first.revision); // the stale window
    } catch (e) { conflict = e; }
    assert.ok(conflict, 'a stale save must reject');
    assert.strictEqual(conflict.code, 'conflict');
    assert.ok(conflict.freshState, 'the conflict must carry the fresh state');
    assert.strictEqual(conflict.freshState.port.effectiveValue, 8100);
    assert.strictEqual(fs.readFileSync(settingsPath(), 'utf8'), onDisk, 'a rejected save must not touch the file');
});

await checkAsync('an unrelated stored key survives a partial update', async () => {
    freshSandbox();
    writeDoc({
        version: 1, workspaces: [], defaultWorkspaceId: null, port: 7777,
        serveMode: 'local', extraPath: [], futureInstallKey: { keep: 'me' },
    });
    const svc = hs.createHostSettingsService();
    await svc.update({ port: 8400 }, svc.read().revision);
    const raw = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    assert.deepStrictEqual(raw.futureInstallKey, { keep: 'me' },
        'an unknown key from a newer install must not be dropped by an older writer');
    assert.strictEqual(raw.port, 8400);
});

await checkAsync('an unknown patch field is rejected before any write', async () => {
    freshSandbox();
    const svc = hs.createHostSettingsService();
    const rev = svc.read().revision;
    await assert.rejects(() => svc.update({ bindAddress: '0.0.0.0' }, rev), (e) => e && e.code === 'invalid');
    assert.ok(!fs.existsSync(settingsPath()), 'a rejected patch must not create the file');
});

await checkAsync('a PATH entry containing the platform delimiter is rejected', async () => {
    freshSandbox();
    const svc = hs.createHostSettingsService();
    const delim = process.platform === 'win32' ? ';' : ':';
    await assert.rejects(
        () => svc.update({ extraPath: [`/a${delim}/b`] }, svc.read().revision),
        (e) => e && e.code === 'invalid');
});

await checkAsync('the durable file is written 0600 under a 0700 directory', async () => {
    if (process.platform === 'win32') return;
    freshSandbox();
    const svc = hs.createHostSettingsService();
    await svc.update({ port: 8500 }, svc.read().revision);
    assert.strictEqual(fs.statSync(settingsPath()).mode & 0o777, 0o600);
    assert.strictEqual(fs.statSync(path.dirname(settingsPath())).mode & 0o777, 0o700);
});

await checkAsync('concurrent writes serialize instead of interleaving', async () => {
    freshSandbox();
    const svc = hs.createHostSettingsService();
    const rev = svc.read().revision;
    // Both start from the same revision: exactly one may win, the other must
    // see a conflict. Neither may produce a half-written file.
    const results = await Promise.allSettled([
        svc.update({ port: 8601 }, rev),
        svc.update({ port: 8602 }, rev),
    ]);
    const fulfilled = results.filter(r => r.status === 'fulfilled');
    assert.strictEqual(fulfilled.length, 1, 'exactly one concurrent save may win');
    const rejected = results.find(r => r.status === 'rejected');
    assert.strictEqual(rejected.reason.code, 'conflict');
    JSON.parse(fs.readFileSync(settingsPath(), 'utf8')); // must be valid JSON, not a torn write
});

// ── 6. PATH is applied without shell evaluation ───────────────────────────
check('applyExtraPathToProcessEnv prepends literally, never through a shell', () => {
    const saved = process.env.PATH;
    try {
        process.env.PATH = '/usr/bin:/bin';
        // A value that a shell WOULD expand. It must land verbatim.
        hs.applyExtraPathToProcessEnv(['/opt/$HOME/bin', '/opt/`id`/bin']);
        const entries = process.env.PATH.split(path.delimiter);
        assert.strictEqual(entries[0], '/opt/$HOME/bin', 'entries must be prepended verbatim');
        assert.strictEqual(entries[1], '/opt/`id`/bin');
        assert.ok(entries.includes('/usr/bin') && entries.includes('/bin'), 'the existing PATH must be preserved');
    } finally { process.env.PATH = saved; }
});

check('applyExtraPathToProcessEnv is a no-op for an empty list', () => {
    const saved = process.env.PATH;
    try {
        process.env.PATH = '/usr/bin:/bin';
        hs.applyExtraPathToProcessEnv([]);
        assert.strictEqual(process.env.PATH, '/usr/bin:/bin');
    } finally { process.env.PATH = saved; }
});

// ── 7. Composition-root parity (source level) ─────────────────────────────
// No runtime gate covers the extension host, and the two roots have drifted
// before. Assert the SEAMS each root wires, not the verbs each answers.
const bootstrapSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'bootstrap.ts'), 'utf8');
const providerSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');

check('both composition roots wire readHostSettings and writeHostSettings', () => {
    for (const [label, src] of [['standalone/bootstrap.ts', bootstrapSrc], ['TaskViewerProvider.ts', providerSrc]]) {
        assert.ok(/readHostSettings:\s*\(/.test(src), `${label} must wire readHostSettings into LocalApiServer`);
        assert.ok(/writeHostSettings:\s*\(/.test(src), `${label} must wire writeHostSettings into LocalApiServer`);
    }
});

check('both composition roots inject the service into the Setup provider', () => {
    for (const [label, src] of [['standalone/bootstrap.ts', bootstrapSrc], ['TaskViewerProvider.ts', providerSrc]]) {
        assert.ok(/setHostSettingsService\(/.test(src), `${label} must inject the service into SetupPanelProvider`);
    }
});

check('the extension does not gate the Setup injection on the lazy field', () => {
    // The regression: `if (this._hostSettingsService) { ...setHostSettingsService... }`
    // is always false at wiring time because the field is only populated by an
    // HTTP hit, so the Host tab was dead on every extension start.
    assert.ok(
        !/if\s*\(this\._hostSettingsService\)\s*\{\s*\n\s*this\._setupPanelProvider\.setHostSettingsService/.test(providerSrc),
        'the Setup injection must not be guarded on the lazily-populated _hostSettingsService field');
    assert.ok(
        /setHostSettingsService\(\s*\n?\s*this\._ensureHostSettingsService\(\)/.test(providerSrc),
        'TaskViewerProvider must construct the service when injecting it');
});

check('both roots supply a resolution context, not a bare read', () => {
    // A context-free read labels a host launched as `tailnet` "local (default)"
    // in its own settings window.
    assert.ok(/setHostSettingsService\([^)]*,\s*\(\)\s*=>/s.test(bootstrapSrc),
        'standalone must pass a context provider');
    assert.ok(/setHostSettingsService\([\s\S]{0,160}?\(\)\s*=>\s*this\._buildHostSettingsContext\(\)/.test(providerSrc),
        'the extension must pass its VS Code context provider');
    const setupSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'SetupPanelProvider.ts'), 'utf8');
    assert.ok(/_hostSettingsService\.resolve\(this\._resolveHostSettingsContext\(\)\)/.test(setupSrc),
        'getHostSettings must resolve WITH the host context, not call the context-free read()');
});

check('no process-private settings field or pairing write endpoint returned', () => {
    const apiSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'services', 'LocalApiServer.ts'), 'utf8');
    assert.ok(!/_pendingServeMode/.test(apiSrc), '_pendingServeMode must stay deleted');
    assert.ok(!/_pairingState/.test(apiSrc), '_pairingState must stay deleted');
    assert.ok(!/pathname === '\/pair'/.test(apiSrc), 'no pairing endpoint may be reintroduced');
    assert.ok(/pathname === '\/settings' && req\.method === 'PUT'/.test(apiSrc), 'PUT /settings must exist');
});

// ── 8. The service entrypoint reads durable settings BEFORE boot ──────────
check('`switchboard service` resolves settings before startHeadlessSwitchboard', () => {
    const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    const resolveIdx = cliSrc.indexOf('createHostSettingsService().resolve(hostSettingsContext)');
    const bootIdx = cliSrc.indexOf('startHeadlessSwitchboard({');
    assert.ok(resolveIdx > 0, 'cli.ts must resolve host settings');
    assert.ok(bootIdx > 0, 'cli.ts must call startHeadlessSwitchboard');
    assert.ok(resolveIdx < bootIdx, 'settings must resolve BEFORE the host boots');
    assert.ok(/isServiceCommand && !args\._explicit\?\.port/.test(cliSrc),
        'a durable port must drive the actual listen, not just the /settings report');
});

check('an unresolvable service workspace fails before bootstrap', () => {
    // The plan: `service` is not a synonym for `local`. Falling back to the
    // process cwd serves whatever directory systemd set and reports nothing.
    const cliSrc = fs.readFileSync(path.join(REPO_ROOT, 'src', 'standalone', 'cli.ts'), 'utf8');
    assert.ok(/has no selected startup workspace/.test(cliSrc),
        'service must fail loudly when no startup workspace resolves');
    assert.ok(/Selected startup workspace does not exist/.test(cliSrc),
        'service must fail loudly when the selected workspace root is missing');
});

// ── Summary ───────────────────────────────────────────────────────────────
if (failures > 0) {
    console.error(`\n${failures} contract check(s) failed.`);
    process.exit(1);
}
console.log('\nAll host settings contract checks passed.');

})().catch(err => { console.error(err); process.exit(1); });
