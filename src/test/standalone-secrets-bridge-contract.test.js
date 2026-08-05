'use strict';
/**
 * Standalone secrets bridge contract.
 *
 * The machine-global encrypted store is the ONLY copy of a standalone user's API
 * tokens — there is no keychain behind it to re-read. Every assertion below pins a
 * path where a plausible-looking implementation silently destroys those tokens:
 *
 *   1. Legacy-workspace migration ran as an un-awaited async loop, so the renames
 *      fired first and every `get()` then read an already-renamed store. It imported
 *      NOTHING and retired the user's only copy — silently, with no error log.
 *   2. The editor-host activation sweep deleted any mirrored key the keychain did
 *      not hold, so a token entered via `secrets set` or the browser Setup panel was
 *      wiped on the next VS Code launch.
 *   3. Decrypt failure renamed the store to `.corrupt-*.bak`. Shared across the
 *      editor host, the standalone host and the CLI, one process lacking
 *      SWITCHBOARD_MASTER_PASSPHRASE was enough to condemn a healthy store.
 *
 * All three are invisible to a plan-compliance read of the diff.
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT = path.join(process.cwd(), 'out');
const { StandaloneHostSecrets } = require(path.join(OUT, 'services', 'encryptedSecretsStore.js'));

const MIRRORED_SECRET_KEYS = [
    'switchboard.clickup.apiToken',
    'switchboard.linear.apiToken',
    'switchboard.notion.apiToken',
    'switchboard.stitch.apiKey',
];

function tmpDir(prefix) {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function storeIn(dir) {
    return new StandaloneHostSecrets(path.join(dir, 'secrets.enc'), path.join(dir, '.master-key'));
}

/** Re-enter createStandaloneHostSecrets() the way a fresh `npx switchboard` boot does. */
function bootStandalone(workspaceRoot, stateHome) {
    for (const m of ['standalone/hostServices.js', 'utils/stateHome.js']) {
        const resolved = require.resolve(path.join(OUT, m));
        delete require.cache[resolved];
    }
    process.env.SWITCHBOARD_STATE_HOME = stateHome;
    const { createStandaloneHostSecrets } = require(path.join(OUT, 'standalone', 'hostServices.js'));
    return createStandaloneHostSecrets(workspaceRoot);
}

function seedLegacyWorkspace(entries) {
    const ws = tmpDir('sb-secrets-ws-');
    const legacyDir = path.join(ws, '.switchboard');
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacy = storeIn(legacyDir);
    for (const [k, v] of Object.entries(entries)) { legacy.storeSync(k, v); }
    return { ws, legacyDir };
}

function run() {
    const originalStateHome = process.env.SWITCHBOARD_STATE_HOME;
    delete process.env.SWITCHBOARD_MASTER_KEY;
    delete process.env.SWITCHBOARD_MASTER_PASSPHRASE;

    try {
        // ── 1. Migration must complete BEFORE the store is handed to callers ──
        // The regression: an async loop suspends at its first `await`, the renames
        // run, and the loop then reads a store that no longer exists.
        {
            const { ws, legacyDir } = seedLegacyWorkspace({
                'switchboard.clickup.apiToken': 'pk_LEGACY',
                'switchboard.linear.apiToken': 'lin_LEGACY',
            });
            const stateHome = tmpDir('sb-secrets-home-');

            const secrets = bootStandalone(ws, stateHome);

            // Synchronously after construction — this is the instant bootstrap hands
            // `secrets` to ClickUpSyncService, LinearSyncService et al.
            assert.strictEqual(
                secrets.getSync('switchboard.clickup.apiToken'), 'pk_LEGACY',
                'migration must be complete before the constructed store is readable'
            );
            assert.strictEqual(secrets.getSync('switchboard.linear.apiToken'), 'lin_LEGACY');

            // Durable on disk, not just in the migrating instance's cache.
            const globalDir = path.join(stateHome, '.switchboard');
            assert.strictEqual(storeIn(globalDir).getSync('switchboard.clickup.apiToken'), 'pk_LEGACY',
                'migrated values must be persisted to the global store file');

            // Rename, never unlink.
            const after = fs.readdirSync(legacyDir).sort();
            assert.ok(after.includes('secrets.enc.migrated.bak'), `expected .migrated.bak, got ${after}`);
            assert.ok(after.includes('.master-key.migrated.bak'), `expected key .migrated.bak, got ${after}`);
            assert.ok(!after.includes('secrets.enc'), 'legacy store should no longer be live');
        }

        // ── 2. Migration is idempotent and never clobbers a newer global value ──
        {
            const { ws } = seedLegacyWorkspace({ 'switchboard.clickup.apiToken': 'pk_LEGACY' });
            const stateHome = tmpDir('sb-secrets-home-');

            const first = bootStandalone(ws, stateHome);
            assert.strictEqual(first.getSync('switchboard.clickup.apiToken'), 'pk_LEGACY');

            first.storeSync('switchboard.clickup.apiToken', 'pk_ROTATED');
            const second = bootStandalone(ws, stateHome);
            assert.strictEqual(second.getSync('switchboard.clickup.apiToken'), 'pk_ROTATED',
                'a second boot must not re-import over a rotated token');
        }

        // Collision on the FIRST boot: a non-empty global value wins.
        {
            const { ws } = seedLegacyWorkspace({ 'switchboard.notion.apiToken': 'LEGACY' });
            const stateHome = tmpDir('sb-secrets-home-');
            storeIn(path.join(stateHome, '.switchboard')).storeSync('switchboard.notion.apiToken', 'GLOBAL');

            const secrets = bootStandalone(ws, stateHome);
            assert.strictEqual(secrets.getSync('switchboard.notion.apiToken'), 'GLOBAL',
                'global value must win a migration collision');
        }

        // ── 3. The rename is a receipt for a completed import, never speculative ──
        // Legacy key file missing => cannot decrypt => nothing imported => leave BOTH
        // files exactly where they are. Renaming here would claim a migration that
        // provably did not happen.
        {
            const { ws, legacyDir } = seedLegacyWorkspace({ 'switchboard.clickup.apiToken': 'pk_LEGACY' });
            fs.unlinkSync(path.join(legacyDir, '.master-key'));
            const stateHome = tmpDir('sb-secrets-home-');

            bootStandalone(ws, stateHome);
            const after = fs.readdirSync(legacyDir).sort();
            assert.ok(after.includes('secrets.enc'), `legacy store must stay put, got ${after}`);
            assert.ok(!after.some(f => f.endsWith('.migrated.bak')), `must not claim migration, got ${after}`);
        }

        // Corrupt legacy store: the store self-renames to .corrupt-*, and the key must
        // NOT be renamed away beside it — that would orphan the only key that could
        // ever decrypt the backup.
        {
            const { ws, legacyDir } = seedLegacyWorkspace({ 'switchboard.clickup.apiToken': 'pk_LEGACY' });
            fs.writeFileSync(path.join(legacyDir, 'secrets.enc'), Buffer.alloc(64, 0x7));
            const stateHome = tmpDir('sb-secrets-home-');

            bootStandalone(ws, stateHome);
            const after = fs.readdirSync(legacyDir).sort();
            assert.ok(after.some(f => f.includes('.corrupt-')), `expected corrupt backup, got ${after}`);
            assert.ok(after.includes('.master-key'), `master key must not be orphaned, got ${after}`);
            assert.ok(!after.includes('.master-key.migrated.bak'), `must not claim migration, got ${after}`);
        }

        // ── 4. Editor-host mirror: the sweep writes, only onDidChange deletes ──
        // Mirrors extension.ts's syncSecretToGlobalStore(key, allowDelete). If the
        // sweep is allowed to delete, a standalone-only user loses every token they
        // entered, on every VS Code launch.
        {
            const globalDir = path.join(tmpDir('sb-secrets-home-'), '.switchboard');
            const store = storeIn(globalDir);
            store.storeSync('switchboard.clickup.apiToken', 'SET_VIA_CLI');

            const keychain = new Map(); // an editor that has never held these keys
            const mirror = (key, allowDelete) => {
                if (!MIRRORED_SECRET_KEYS.includes(key)) { return; }
                const val = keychain.get(key);
                if (val && val.trim().length > 0) { store.storeSync(key, val); }
                else if (allowDelete) { store.deleteSync(key); }
            };

            for (const key of MIRRORED_SECRET_KEYS) { mirror(key, false); } // activation sweep
            assert.strictEqual(store.getSync('switchboard.clickup.apiToken'), 'SET_VIA_CLI',
                'the activation sweep must never delete — an empty keychain read is not a deletion');

            keychain.set('switchboard.clickup.apiToken', 'SET_IN_VSCODE');
            mirror('switchboard.clickup.apiToken', true);
            assert.strictEqual(store.getSync('switchboard.clickup.apiToken'), 'SET_IN_VSCODE',
                'an editor token must write through to the global store');

            keychain.delete('switchboard.clickup.apiToken');
            mirror('switchboard.clickup.apiToken', true); // a real deletion in VS Code
            assert.strictEqual(store.getSync('switchboard.clickup.apiToken'), undefined,
                'a genuine editor deletion must propagate');

            // switchboard.apiToken is deliberately NOT mirrored (standalone mints its
            // own session tokens); the allowlist is what enforces that.
            assert.ok(!MIRRORED_SECRET_KEYS.includes('switchboard.apiToken'),
                'the LocalApiServer auth token must never be mirrored');
        }

        // A delete of an absent key must not materialise the store or its master key.
        // The activation sweep calls delete for keys most users never set.
        {
            const dir = tmpDir('sb-secrets-empty-');
            storeIn(dir).deleteSync('switchboard.clickup.apiToken');
            assert.deepStrictEqual(fs.readdirSync(dir), [],
                'deleting an absent key must not create secrets.enc / .master-key');
        }

        // ── 5. A store we cannot decrypt is not automatically a store we may destroy ──
        // Written under SWITCHBOARD_MASTER_PASSPHRASE (which never materialises a
        // .master-key file), then opened by a host without the env var.
        {
            const dir = tmpDir('sb-secrets-envmix-');
            process.env.SWITCHBOARD_MASTER_PASSPHRASE = 'correct-horse';
            storeIn(dir).storeSync('switchboard.clickup.apiToken', 'FROM_STANDALONE');
            delete process.env.SWITCHBOARD_MASTER_PASSPHRASE;

            const blind = storeIn(dir);
            assert.strictEqual(blind.getSync('switchboard.clickup.apiToken'), undefined);
            assert.ok(!fs.readdirSync(dir).some(f => f.includes('.corrupt-')),
                'a store we had no key to even attempt must NOT be renamed away');
            assert.throws(() => blind.storeSync('switchboard.linear.apiToken', 'x'),
                /Refusing to overwrite unreadable/,
                'writes must fail loudly rather than replace ciphertext we never read');

            process.env.SWITCHBOARD_MASTER_PASSPHRASE = 'correct-horse';
            assert.strictEqual(storeIn(dir).getSync('switchboard.clickup.apiToken'), 'FROM_STANDALONE',
                'the host holding the passphrase must still read its own store');
            delete process.env.SWITCHBOARD_MASTER_PASSPHRASE;
        }

        // The reverse mix: a file-keyed store opened by a host that HAS an env
        // passphrase must fall back to the file key rather than condemn the store.
        {
            const dir = tmpDir('sb-secrets-envmix2-');
            storeIn(dir).storeSync('switchboard.clickup.apiToken', 'FROM_EDITOR');
            process.env.SWITCHBOARD_MASTER_PASSPHRASE = 'correct-horse';
            try {
                assert.strictEqual(storeIn(dir).getSync('switchboard.clickup.apiToken'), 'FROM_EDITOR',
                    'the file key must be tried when the env-derived key fails');
                assert.ok(!fs.readdirSync(dir).some(f => f.includes('.corrupt-')),
                    'store was wrongly renamed away');
            } finally {
                delete process.env.SWITCHBOARD_MASTER_PASSPHRASE;
            }
        }

        // A genuinely corrupt store (a key existed and failed) IS renamed, and the
        // next write must not resurrect it.
        {
            const dir = tmpDir('sb-secrets-corrupt-');
            storeIn(dir).storeSync('k', 'v');
            fs.writeFileSync(path.join(dir, 'secrets.enc'), Buffer.alloc(64, 0x9));

            const fresh = storeIn(dir);
            assert.deepStrictEqual(fresh.keysSync(), [], 'corrupt store must yield an empty cache');
            fresh.storeSync('k2', 'v2');
            assert.strictEqual(storeIn(dir).getSync('k2'), 'v2', 'a fresh store must be writable');
            assert.ok(fs.readdirSync(dir).some(f => f.includes('.corrupt-')),
                'the corrupt bytes must be preserved as a .corrupt-*.bak');
        }

        // ── 6. Cross-process staleness: a running host sees another process's write ──
        {
            const dir = tmpDir('sb-secrets-stale-');
            const running = storeIn(dir);
            running.storeSync('switchboard.clickup.apiToken', 'v1');
            assert.strictEqual(running.getSync('switchboard.clickup.apiToken'), 'v1');

            storeIn(dir).storeSync('switchboard.clickup.apiToken', 'v2'); // the editor mirror
            const f = path.join(dir, 'secrets.enc');
            const t = new Date(Date.now() + 2000); // beat coarse mtime resolution
            fs.utimesSync(f, t, t);

            assert.strictEqual(running.getSync('switchboard.clickup.apiToken'), 'v2',
                'a running host must pick up a mirror write without a restart');
        }

        // ── 7. Key material stays 0600 and writes leave no temp files behind ──
        {
            const dir = tmpDir('sb-secrets-mode-');
            const store = storeIn(dir);
            store.storeSync('a', '1');
            store.storeSync('b', '2');
            store.deleteSync('a');
            for (const name of ['secrets.enc', '.master-key']) {
                const mode = fs.statSync(path.join(dir, name)).mode & 0o777;
                if (process.platform !== 'win32') {
                    assert.strictEqual(mode, 0o600, `${name} must be 0600, got ${mode.toString(8)}`);
                }
            }
            assert.ok(!fs.readdirSync(dir).some(f => f.endsWith('.tmp')),
                `atomic write must not leak temp files: ${fs.readdirSync(dir)}`);
        }

        // ── 8. The HTTP secret-write gate is opt-in and default-closed ──
        // Static, because instantiating LocalApiServer needs the extension host. The
        // property that matters is textual: the extension host's construction site
        // must not set the flag, and standalone's must.
        {
            const serverSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'LocalApiServer.ts'), 'utf8');
            const gateChecks = serverSrc.match(/!this\._options\.allowSecretWritesOverHttp\s*&&\s*SECRET_WRITE_VERBS\.has\(verb\)/g) || [];
            assert.strictEqual(gateChecks.length, 2,
                'both the design-verb and setup-verb secret gates must consult the flag');

            const tvpSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'TaskViewerProvider.ts'), 'utf8');
            assert.ok(!tvpSrc.includes('allowSecretWritesOverHttp'),
                'the extension host must never open the HTTP secret-write gate (its empty auth token means loopback-trust)');
            assert.ok(/secretsEntry:\s*false/.test(tvpSrc),
                'the extension host must keep secretsEntry: false');

            const bootSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'standalone', 'bootstrap.ts'), 'utf8');
            assert.ok(/allowSecretWritesOverHttp:\s*true/.test(bootSrc),
                'standalone must opt in to HTTP secret writes');
            assert.ok(/secretsEntry:\s*true/.test(bootSrc),
                'standalone must advertise secretsEntry so the browser inputs un-gate');

            // The gate is only safe because standalone authenticates every request.
            assert.ok(/SameSite=Strict/.test(serverSrc),
                'the sb_session cookie must be SameSite=Strict — it rides the newly-opened verbs automatically');
        }

        // ── 9. Credentials must be git-ignored by name, not just by glob ──
        // Source of truth is WorkspaceExcludeService, which REGENERATES the managed
        // block; an entry added only to .gitignore is wiped on the next render.
        {
            const rulesSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'services', 'WorkspaceExcludeService.ts'), 'utf8');
            for (const rule of ['.switchboard/secrets.enc*', '.switchboard/.master-key*']) {
                assert.ok(rulesSrc.includes(`'${rule}'`),
                    `WorkspaceExcludeService.TARGETED_RULES must contain ${rule} (it regenerates the managed block)`);
                assert.ok(fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8').includes(rule),
                    `.gitignore must contain ${rule}`);
            }
        }

        // ── 10. The mirror reads as well as writes, and cannot resurrect a delete ──
        {
            const extSrc = fs.readFileSync(path.join(process.cwd(), 'src', 'extension.ts'), 'utf8');
            assert.ok(/importSecretFromGlobalStore/.test(extSrc),
                'the editor host must import from the machine-global store, or `secrets set` is invisible to it');
            // Fill-only: an unconditional store() would clobber a freshly-entered token
            // and, with delete-propagation, resurrect cleared ones.
            assert.ok(/if \(existing && existing\.trim\(\)\.length > 0\) \{ return; \}/.test(extSrc),
                'the import must skip keys the keychain already holds');
            // Ordering: import must precede the write-only backfill sweep.
            assert.ok(extSrc.indexOf('importSecretFromGlobalStore(key)') < extSrc.indexOf('syncSecretToGlobalStore(key, false)'),
                'import must run before the backfill sweep');
            // The gating itself must NOT be relaxed by this change.
            assert.ok(!extSrc.includes('allowSecretWritesOverHttp'), 'the editor host must not open HTTP secret writes');
        }

        {
            const t = fs.readFileSync(path.join(process.cwd(), 'src', 'webview', 'transport.js'), 'utf8');
            assert.ok(!/open this workspace in VS Code to set it/.test(t),
                'the secrets hint must name the CLI store path, not only the editor');
            assert.ok(/switchboard secrets set/.test(t), 'the hint must name the CLI command');
        }

        console.log('standalone-secrets-bridge-contract: PASS');
    } finally {
        if (originalStateHome === undefined) { delete process.env.SWITCHBOARD_STATE_HOME; }
        else { process.env.SWITCHBOARD_STATE_HOME = originalStateHome; }
    }
}

try {
    run();
} catch (err) {
    console.error('standalone-secrets-bridge-contract: FAIL');
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
}
