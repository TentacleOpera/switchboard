'use strict';

/**
 * Contract: Debian package architecture comes from native probes, not a
 * hardcoded literal.
 *
 * WHY THIS FILE EXISTS — the trap it pins.
 * scripts/package-deb.sh used to hardcode `Architecture: arm64` because the
 * plan it was written from was framed as a Raspberry Pi installer. The
 * consequence: the package installed on the Pi that holds the board and not
 * on the x86 tower that does the coding. A caller-supplied target is not
 * proof of the bytes produced — on an amd64 host passed `arm64`, both native
 * modules build for amd64 and the staged `require()` checks pass; only the
 * package label is wrong.
 *
 * This file asserts:
 *   1. `scripts/package-deb.sh` contains NO hardcoded `Architecture: arm64`
 *      (or amd64) in the control-file heredoc or output-name derivation.
 *   2. The script detects architecture from `dpkg --print-architecture` AND
 *      `process.arch`, maps them, and requires them to agree.
 *   3. `--expect-arch` is treated as an assertion, never the source of
 *      package metadata.
 *   4. The `Depends: nodejs` floor is derived from a single reviewable
 *      constant, not buried as a literal in the heredoc.
 *   5. The output path is `releases/deb/<version>/<arch>/` so two machines
 *      do not race on one repository-root filename.
 *   6. A sidecar manifest is emitted with version, detected architecture,
 *      Node version, source revision, and SHA-256.
 *
 * See amd64-package-and-an-apt-repository.md (Verification Plan test #2).
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'scripts', 'package-deb.sh');

let failures = 0;
function check(name, fn) {
    try {
        fn();
        console.log(`  ✅ ${name}`);
    } catch (err) {
        failures++;
        console.error(`  ❌ ${name}`);
        console.error(`     ${err.message}`);
    }
}

let scriptText = '';
try {
    scriptText = fs.readFileSync(SCRIPT, 'utf8');
} catch (err) {
    console.error(`  ❌ could not read ${SCRIPT}: ${err.message}`);
    process.exit(1);
}

check('scripts/package-deb.sh exists and is readable', () => {
    assert.ok(scriptText.length > 0, 'script is empty');
});

check('no hardcoded Architecture: arm64 in the control heredoc', () => {
    // The control file heredoc must stamp Architecture from the detected
    // variable, not a literal. The old line was `Architecture: arm64`.
    const heredocArchLine = /^Architecture: \$\{ARCH\}/m;
    assert.ok(
        heredocArchLine.test(scriptText),
        'control heredoc must use `Architecture: ${ARCH}`, not a hardcoded literal'
    );
    // The old hardcoded literal must NOT appear in the heredoc body.
    assert.ok(
        !/^Architecture: arm64$/m.test(scriptText),
        '`Architecture: arm64` hardcoded literal is still present — remove it'
    );
    assert.ok(
        !/^Architecture: amd64$/m.test(scriptText),
        '`Architecture: amd64` hardcoded literal is present — use the detected variable'
    );
});

check('no arm64-only output name derivation', () => {
    // The old line was `DEB_NAME="${PKG_NAME}_${VERSION}_arm64.deb"`.
    assert.ok(
        !/_arm64\.deb/m.test(scriptText) || /_arm64\.deb.*#\|expect-arch/.test(scriptText),
        'a literal _arm64.deb output name is hardcoded — derive from ${ARCH}'
    );
    // The new derivation must use ${ARCH}.
    assert.ok(
        /DEB_NAME="\$\{PKG_NAME\}_\$\{VERSION\}_\$\{ARCH\}\.deb"/.test(scriptText),
        'DEB_NAME must derive from ${ARCH}'
    );
});

check('detects Debian architecture via dpkg --print-architecture', () => {
    assert.ok(
        /dpkg --print-architecture/.test(scriptText),
        'must call `dpkg --print-architecture` to detect the native Debian arch'
    );
});

check('detects Node architecture via process.arch', () => {
    assert.ok(
        /process\.arch/.test(scriptText),
        'must read `process.arch` to detect the Node arch'
    );
});

check('maps Node arch -> Debian arch (x64->amd64, arm64->arm64)', () => {
    assert.ok(
        /x64\)\s+printf 'amd64'/.test(scriptText),
        'must map x64 -> amd64'
    );
    assert.ok(
        /arm64\)\s+printf 'arm64'/.test(scriptText),
        'must map arm64 -> arm64'
    );
});

check('requires Debian and Node arch to agree', () => {
    assert.ok(
        /DEB_ARCH.*!=.*NODE_DEB_ARCH/.test(scriptText),
        'must reject when the Debian and Node architectures disagree'
    );
});

check('--expect-arch is an assertion, not the source of metadata', () => {
    // --expect-arch must be parsed and compared, but ARCH must be assigned
    // from DEB_ARCH (the detected value), not from EXPECT_ARCH.
    assert.ok(
        /EXPECT_ARCH/.test(scriptText),
        'must parse --expect-arch'
    );
    assert.ok(
        /ARCH="\$DEB_ARCH"/.test(scriptText),
        'ARCH must be assigned from the detected $DEB_ARCH, not from --expect-arch'
    );
    assert.ok(
        /EXPECT_ARCH.*!=.*ARCH/.test(scriptText),
        'must fail when --expect-arch does not match the detected architecture'
    );
});

check('Depends nodejs floor comes from a single reviewable constant', () => {
    // The plan requires the dependency value in one reviewable packaging
    // constant rather than buried as the only copy in an inline heredoc.
    assert.ok(
        /NODE_ENGINE_FLOOR=/.test(scriptText),
        'must define a NODE_ENGINE_FLOOR constant'
    );
    assert.ok(
        /Depends: nodejs \(>= \$\{NODE_ENGINE_FLOOR\}\)/.test(scriptText),
        'control heredoc must derive Depends from ${NODE_ENGINE_FLOOR}'
    );
    // The plan requires the packaging floor to MATCH the application engine
    // floor, not merely to be spelled once. A hand-typed literal drifts the
    // moment package.json moves and nothing notices.
    assert.ok(
        !/^NODE_ENGINE_FLOOR="\d+"\s*$/m.test(scriptText),
        'NODE_ENGINE_FLOOR must be derived from package.json engines.node, not a hardcoded literal'
    );
    assert.ok(
        /NODE_ENGINE_FLOOR="\$\(node[\s\S]{0,400}engines/.test(scriptText),
        'NODE_ENGINE_FLOOR must read package.json engines.node'
    );
});

check('the systemd unit and the packaged entry point agree', () => {
    // The unit's ExecStart names `/usr/bin/switchboard service`, which the
    // package installs as the static Go client. `service` is not an owned Go
    // verb, so it must fall through to the Node host — if it were ever added to
    // ownedVerbs the packaged service would stop booting and no test would say
    // so.
    const unit = fs.readFileSync(
        path.join(REPO_ROOT, 'packaging', 'debian', 'switchboard.service'), 'utf8');
    assert.ok(
        /^ExecStart=\/usr\/bin\/switchboard service\b/m.test(unit),
        'unit ExecStart must run `/usr/bin/switchboard service`'
    );
    const goMain = fs.readFileSync(path.join(REPO_ROOT, 'cmd', 'switchboard', 'main.go'), 'utf8');
    const owned = goMain.match(/ownedVerbs\s*=\s*map\[string\]bool\{([\s\S]*?)\}/);
    assert.ok(owned, 'could not locate ownedVerbs in cmd/switchboard/main.go');
    assert.ok(
        !/"service"/.test(owned[1]),
        '`service` must NOT be an owned Go verb — it must delegate to the Node host'
    );
    // A missing legacy env file must not be fatal: the durable host-settings
    // document is now the source of truth.
    assert.ok(
        /^EnvironmentFile=-\/etc\/switchboard\/switchboard\.env$/m.test(unit),
        'EnvironmentFile must be `-` prefixed so a durable-only install still starts'
    );
});

check('output path is releases/deb/<version>/<arch>/', () => {
    assert.ok(
        /releases\/deb\/\$\{VERSION\}\/\$\{ARCH\}/.test(scriptText),
        'output must land under releases/deb/<version>/<arch>/ so two machines do not race'
    );
});

check('emits a sidecar manifest with version, arch, node version, revision, sha256', () => {
    assert.ok(
        /MANIFEST_PATH=/.test(scriptText),
        'must define a MANIFEST_PATH'
    );
    // The manifest JSON must include the required fields.
    assert.ok(
        /applicationVersion:/.test(scriptText),
        'manifest must record applicationVersion'
    );
    assert.ok(
        /packageArchitecture:/.test(scriptText),
        'manifest must record packageArchitecture'
    );
    assert.ok(
        /nodeVersion:/.test(scriptText),
        'manifest must record nodeVersion'
    );
    assert.ok(
        /sourceRevision:/.test(scriptText),
        'manifest must record sourceRevision'
    );
    assert.ok(
        /packageSha256:/.test(scriptText),
        'manifest must record packageSha256'
    );
});

check('/usr/bin/switchboard is the static Go client, not the Node bundle', () => {
    // The plan's first goal invariant. A symlink to dist/standalone/cli.js makes
    // every board verb pay a 17 MB bundle parse — the exact cost the static
    // client exists to remove — and it is invisible unless something asserts it.
    assert.ok(
        !/ln -s .*standalone\/cli\.js .*usr\/bin\/switchboard"/.test(scriptText),
        '/usr/bin/switchboard must not be a symlink to the Node CLI bundle'
    );
    assert.ok(
        /go build[\s\S]{0,400}\.\/cmd\/switchboard\b/.test(scriptText),
        'must build ./cmd/switchboard (the static Go client)'
    );
    assert.ok(
        /cp "\$CLIENT_BIN" "\$INSTALL_DIR\/usr\/bin\/switchboard"/.test(scriptText),
        'must install the built Go client at /usr/bin/switchboard'
    );
    assert.ok(
        /client-artifacts\.json/.test(scriptText),
        'must write a client manifest so the host resolves the installed Go client'
    );
});

check('the retired native PTY dependency is absent from packaging', () => {
    assert.ok(
        !scriptText.includes('node-pty'),
        'package-deb.sh must not stage, strip or probe the retired node-pty dependency'
    );
});

check('post-build validation inspects native payload ELF machine', () => {
    assert.ok(
        /validate_native_elf/.test(scriptText),
        'must validate each native binary ELF machine matches the package architecture'
    );
    assert.ok(
        /file -b/.test(scriptText),
        'must use `file -b` to inspect native binary formats'
    );
});

// ── Documentation/source contracts (test #6) ──────────────────────────────
const README = path.join(REPO_ROOT, 'packaging', 'debian', 'README.md');
let readmeText = '';
try {
    readmeText = fs.readFileSync(README, 'utf8');
} catch (err) {
    console.error(`  ❌ could not read ${README}: ${err.message}`);
    process.exit(1);
}

check('README forbids apt-key', () => {
    assert.ok(
        /Do .*not.* use `apt-key`/.test(readmeText),
        'README must forbid apt-key (deprecated; use Signed-By)'
    );
});

check('README requires deb822 Signed-By', () => {
    assert.ok(
        /Signed-By:/.test(readmeText),
        'README must show a deb822 source with Signed-By'
    );
    assert.ok(
        /Types: deb/.test(readmeText) && /Suites:/.test(readmeText) && /Components:/.test(readmeText),
        'README must use deb822 format (Types/Suites/Components)'
    );
});

check('README enforces .asc encoding for the operator-managed key', () => {
    assert.ok(
        /switchboard-archive-keyring\.asc/.test(readmeText),
        'README must name the armored key with .asc extension'
    );
    assert.ok(
        /\/etc\/apt\/keyrings/.test(readmeText),
        'README must place the operator-managed key under /etc/apt/keyrings'
    );
});

check('README requires both architectures', () => {
    assert.ok(
        /Architectures: amd64 arm64/.test(readmeText),
        'README deb822 source must list both amd64 and arm64'
    );
});

check('README documents direct .deb installation', () => {
    assert.ok(
        /apt install \.\/switchboard_/.test(readmeText),
        'README must document direct .deb installation as a fallback'
    );
});

check('README documents the NodeSource Node 22 prerequisite', () => {
    assert.ok(
        /NodeSource/.test(readmeText),
        'README must document NodeSource as the Node 22 prerequisite'
    );
    assert.ok(
        /deb\.nodesource\.com\/setup_22/.test(readmeText),
        'README must point at the NodeSource Node 22 setup script'
    );
    assert.ok(
        /nvm/.test(readmeText) && /Do .*not.* use `nvm`/.test(readmeText),
        'README must warn that nvm does not satisfy the apt dependency'
    );
});

check('README does not claim macOS support', () => {
    assert.ok(
        /no\s+macOS package/i.test(readmeText),
        'README must state there is no macOS package in this plan'
    );
});

// ── build-apt-repository.sh contracts ─────────────────────────────────────
const BUILD_REPO = path.join(REPO_ROOT, 'scripts', 'build-apt-repository.sh');
let buildRepoText = '';
try {
    buildRepoText = fs.readFileSync(BUILD_REPO, 'utf8');
} catch (err) {
    console.error(`  ❌ could not read ${BUILD_REPO}: ${err.message}`);
    process.exit(1);
}

check('build-apt-repository.sh requires --signing-fingerprint (full 40-char)', () => {
    assert.ok(
        /--signing-fingerprint/.test(buildRepoText),
        'build-apt-repository.sh must require --signing-fingerprint'
    );
    assert.ok(
        /\[A-F0-9\]\{40\}/.test(buildRepoText),
        'must validate the fingerprint is 40 hex chars (no key IDs)'
    );
});

check('build-apt-repository.sh verifies signatures in an isolated keyring', () => {
    assert.ok(
        /VERIFY_GNUPGHOME/.test(buildRepoText),
        'must verify signatures in an isolated temporary GPG home'
    );
    assert.ok(
        /isolated keyring/.test(buildRepoText),
        'must document isolated verification'
    );
});

check('build-apt-repository.sh materializes by-hash objects', () => {
    assert.ok(
        /by-hash\/SHA256/.test(buildRepoText),
        'must materialize by-hash/SHA256 objects for every advertised index'
    );
    assert.ok(
        /Acquire-By-Hash/.test(buildRepoText),
        'must advertise Acquire-By-Hash in Release'
    );
});

check('build-apt-repository.sh sets Valid-Until', () => {
    assert.ok(
        /Valid-Until/.test(buildRepoText),
        'must set Valid-Until tied to the release cadence'
    );
});

check('build-apt-repository.sh rejects same-version/different-bytes', () => {
    assert.ok(
        /different bytes/.test(buildRepoText),
        'must reject a same-version package with different bytes'
    );
});

check('build-apt-repository.sh scans for private key leakage', () => {
    assert.ok(
        /PRIVATE KEY/.test(buildRepoText),
        'must scan the generated tree for private key material'
    );
});

// ── publish-apt-repository.sh contracts ───────────────────────────────────
const PUBLISH_REPO = path.join(REPO_ROOT, 'scripts', 'publish-apt-repository.sh');
let publishRepoText = '';
try {
    publishRepoText = fs.readFileSync(PUBLISH_REPO, 'utf8');
} catch (err) {
    console.error(`  ❌ could not read ${PUBLISH_REPO}: ${err.message}`);
    process.exit(1);
}

check('publish-apt-repository.sh resolves Pages origin via gh api (not guessing)', () => {
    assert.ok(
        /gh api.*pages/.test(publishRepoText),
        'must resolve the Pages origin through gh api, not by guessing owner/name'
    );
    assert.ok(
        /PAGES_STATUS.*built/.test(publishRepoText),
        'must refuse to publish when Pages status is not built'
    );
});

check('publish-apt-repository.sh reads back and compares hashes', () => {
    assert.ok(
        /read_back_hash/.test(publishRepoText),
        'must read back deployed artifacts and compare hashes'
    );
    assert.ok(
        /verify_remote/.test(publishRepoText),
        'must verify each remote artifact against the manifest hash'
    );
});

check('publish-apt-repository.sh verifies by-hash objects', () => {
    assert.ok(
        /verify_by_hash/.test(publishRepoText),
        'must verify by-hash objects read back correctly'
    );
});

// ── Summary ───────────────────────────────────────────────────────────────
if (failures > 0) {
    console.error(`\n${failures} contract check(s) failed.`);
    process.exit(1);
}
console.log('\nAll deb packaging contract checks passed.');
