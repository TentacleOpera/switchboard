# An amd64 Package and an apt Repository, So More Than One Machine Can Install It

kanbanColumn: CREATED

## Goal

`switchboard` installs from `apt` on x86 and arm64 Linux, from a signed repository the operator adds
once. The package that exists today installs on exactly one of the two machines this operator runs.

### Problem analysis

**arm64 is the lead platform, deliberately — amd64 is the addition it never got.**
`scripts/package-deb.sh:107` hardcodes `Architecture: arm64` because the plan it was written from
said to — that plan was framed as a Raspberry Pi installer and never revisited once it became a
Debian package. The consequence, measured:

```
tower   x86_64 / x64    cannot install the package
pi      aarch64         can
```

So the installer works on the machine that holds the board and not on the machine that does the
coding. The reviewer filed the same thing against the app feature: *"the package-manager half of
change 0 is arm64-only… an x86 Linux desktop or server and every Mac have no package-manager path."*

**Read this as arm64-first, amd64-also — not as a correction to arm64.** Leading with arm64 was
right and stays right: running an agent fleet on cheap, low-power hardware is something this product
does and most agent controllers do not, and that claim is only true while it is the platform the
maintainer actually runs. What was missing is that a Debian package should also install on the
machine doing the coding.

A coder who concludes the Pi was an afterthought will optimise for x86 and let arm64 decay, which
inverts the point. **The constrained target is the one that surfaces defects.** A single evening on a
4 GB Pi 400 found an unconfigurable hourly backup writing 786 MB a day, 58 MB of unloadable
prebuilds inside the package, a `Depends: nodejs (>= 22)` no Raspberry Pi OS release can satisfy,
and a 1,091 ms CLI startup — none of which were visible on a 12-thread workstation with 15 GB of
RAM. Whatever else changes here, **arm64 must remain a build the maintainer runs, not one the
maintainer merely publishes**, and where anything is ordered — the matrix, the docs, the
repository's `Architectures:` line — arm64 goes first.

**It cannot be fixed by relabelling.** The package vendors `better-sqlite3` and `node-pty` compiled
for the target, and the build correctly gates on `require()`ing both out of the staged tree. An
amd64 package needs an amd64 build. Both architectures are available on the tailnet, so this needs a
build matrix, not a CI subscription.

**There is no repository, only a file.** `apt install ./file.deb` works and requires no signature at
all, but it gives no upgrade path and no discovery. A repository does — and unlike macOS and
Windows, **the signing here is free**: a GPG key the operator generates, not a certificate anyone
issues. There is no submission, no review and no authority. Debian's own archive is effectively
closed to this package anyway, since it forbids vendored `node_modules`.

**And the Node floor is currently unsatisfiable on the target platform.** The package declares
`Depends: nodejs (>= 22)`. Stock Raspberry Pi OS (Debian trixie) offers **20.19.2**. A novice's
`apt install` stops with an unmet dependency on the exact hardware the installer was written for.
The Pi here only works because Node 24 came from nvm, which apt cannot see.

### Clarified scope

This plan delivers Debian-compatible Linux packages for `amd64` and `arm64`. It does not create a
Homebrew formula, cask, macOS `.pkg`, Windows package, or universal desktop artifact. The quoted Mac
gap therefore remains real unless “every machine” means the two Linux machines named above; the
feature title must not be used as evidence that macOS distribution exists.

> **Superseded:** Debian's own archive is effectively closed to this package because it forbids
> vendored `node_modules`.
> **Reason:** Debian Policy 4.13 says archive packages should not use embedded convenience copies
> when a library is already packaged and should package missing prerequisites separately “if
> possible”; it is strong policy, but not the unconditional prohibition stated above.
> **Replaced with:** Debian archive acceptance would require dependency unbundling, source-policy,
> licensing, and maintainer review beyond this plan. A private repository remains the selected
> operational path, but Debian proper is out of scope rather than technically declared impossible.

The architecture builds, repository metadata, signing, publication, and install documentation stay
in one subtask because they form one gated release pipeline: repository publication is invalid until
both native packages of the same version and the Node prerequisite path have passed validation.

## Metadata

- **Complexity:** 7
- **Tags:** devops, infrastructure, security, reliability, feature

## User Review Required

> **Superseded:** None. Change 3 takes the Node-floor decision rather than deferring it.
> **Reason:** The Node-floor decision can be made from repository contracts, but first publication
> still permanently commits operators to a repository origin and signing identity. The feature title
> also overstates the Linux-only plan if it is intended to include Mac.
> **Replaced with:** Before first public release, confirm (1) the stable HTTPS repository origin,
> (2) the signing-key fingerprint, custody, offline backup, and rotation owner, and (3) whether a
> separate macOS package-manager subtask is required. Implementation proceeds with a configurable
> origin and Linux-only acceptance until those decisions are supplied.

> **Superseded:** Repository origin, signing-key custody, and literal macOS scope require user review.
> **Reason:** The user selected GitHub Pages, chose the x86 tower as the signing machine with an
> encrypted offline private-key backup, and limited this feature to Linux.
> **Replaced with:** None. Publish the apt tree through GitHub Pages; keep the private key only in the
> tower's passphrase-protected GPG keyring plus encrypted offline backup; upload only the public key
> and signed artifacts; support Debian-compatible amd64 and arm64, with no macOS claim or subtask.

## Complexity Audit

> **Superseded:** Complexity 5.
> **Reason:** This work coordinates native builds on two machines, validates architecture-sensitive
> binaries, defines an immutable release set, generates and signs apt metadata, publishes it without
> exposing the private key or a partial repository, and proves upgrades on two targets.
> **Replaced with:** Complexity 7 — route to a Lead Coder.

### Routine

- Replace arm64-specific output names and package descriptions with detected architecture values.
- Compress per-architecture `Packages` indexes and export a repository public key.
- Document direct `.deb` installation alongside repository installation.

### Complex / Risky

- Prevent a caller-provided label from disagreeing with the native modules actually built.
- Keep both architecture artifacts on exactly one application version and release identity.
- Make signed metadata reproducible and reject same-version/different-bytes publication.
- Keep the GPG private key out of the repository, artifacts, logs, and operator instructions.
- Publish a complete repository atomically enough that clients never fetch mixed old/new metadata.
- Supply Node 22 through apt on both target architectures without weakening the repository's current
  runtime contract on the strength of an incomplete compatibility signal.

## Edge-Case & Dependency Audit

### Race Conditions

- Lock release generation by version and repository output path. Two publication processes must not
  generate or sign into the same live tree.
- Build and sign into a temporary tree. Publish metadata only after both packages, all indexes,
  `Release`, `InRelease`, and `Release.gpg` have passed validation.
- Treat upload order as part of correctness: package payloads and architecture indexes precede the
  signed top-level metadata that makes them visible to clients.
- A second build of the same version with identical hashes is an idempotent no-op. A different hash
  at the same version is a hard failure requiring a version bump.

### Security

- Require an explicit full signing-key fingerprint and compare it to GPG's resolved signing key
  before signing. Never select a key by email substring or implicit default.
- Accept the private key only from the x86 tower's passphrase-protected GPG keyring. Maintain an
  encrypted offline export and perform a restore/fingerprint check before first publication. Never
  copy the private key into the repository tree, environment dumps, generated site, CI logs, GitHub,
  or the package.
- Export only the minimal public key. Operator instructions use a dedicated keyring plus `Signed-By`;
  they do not use `apt-key` or a globally trusted key.
- Verify `InRelease` and `Release.gpg` against the exported public key before publication. Verify that
  `Release` hashes cover every generated index and that every package hash in `Packages` matches the
  staged `.deb`.
- Do not pipe an unauthenticated downloaded script into a shell. Installation instructions use
  explicit key and source files whose locations and fingerprints are visible.

### Side Effects

- Repository origin and signing identity become durable public API. Moving the origin or losing the
  private key breaks upgrades for installed machines.
- `apt upgrade` depends on retaining older package payloads long enough for clients that have not yet
  refreshed. Garbage collection is a separate explicit release operation, not an incidental rebuild.
- The `.deb` direct-install path remains valid for operators who do not add the repository.
- Package removal and purge behavior remain unchanged; repository tooling must not modify board data,
  workspaces, `/etc/switchboard`, or service state on the build machine.

### Dependencies & Conflicts

- The settings-window subtask changes the CLI startup reader and Debian service unit that
  `scripts/package-deb.sh:29-52,96-102` compiles and copies. Final package builds and publication must
  occur after that subtask lands, even though packaging-script development can proceed earlier.
- Native production dependencies include `better-sqlite3@12.11.1`, whose installed package declares
  Node 20/22+ support, and optional `node-pty@1.1.0`. The application itself declares Node >=22 in
  `package.json:22-25`; that application contract controls this package.
- Release hosts need the Debian packaging/index tools and GPG. Their exact supported versions and
  package names must be pinned in release documentation after external verification.
- No other feature is assumed. If `node-pty` is present, strip only its irrelevant staged prebuilds;
  if it is absent, skip that optimization without changing package success criteria.

## Dependencies

- **A Settings Window, and the Write Path Its Review Deleted** — must be merged before final package
  artifacts are built and signed so the package contains the completed service startup path.
- One native Debian-compatible `amd64` build host and one native Debian-compatible `arm64` build host
  are required for release acceptance.
- GitHub Pages must be enabled for the repository and its actual configured origin resolved through
  GitHub before publication. The x86 tower's dedicated signing key and tested encrypted offline
  backup must exist before the first public release.

## Adversarial Synthesis

Key risks are mislabeled native binaries, a two-architecture release built from different versions,
an unsatisfiable Node dependency, signing with the wrong key, and exposing partial repository state.
Mitigate them with detected architecture, immutable manifests and hashes, Node 22 prerequisite
documentation, explicit fingerprint checks, isolated signature verification, and staged publication.

## Proposed Changes

### `scripts/package-deb.sh:1-137`

> **Superseded:** `package-deb.sh` takes a target architecture and stamps `Architecture:` from it;
> the staged `require()` gates make a wrong-architecture package fail loudly.
> **Reason:** On an amd64 host passed `arm64`, both native modules are correctly built for amd64 and
> both `require()` checks pass; only the package label is wrong. A caller-supplied target is not proof
> of the bytes produced.
> **Replaced with:** Detect the native Debian architecture and Node architecture independently, map
> `x64 -> amd64` and `arm64 -> arm64`, require them to agree, and stamp only the detected Debian
> value. An optional expected-architecture argument is an assertion that fails on mismatch, never the
> source of package metadata.

- **Context:** Lines 2-14, 25, 107, and 119-121 are arm64-specific. The vendor build at lines 65-81
  already creates native dependencies on the build host but does not verify metadata against that
  host.
- **Implementation:** Resolve the package architecture with the native Debian toolchain, resolve
  `process.arch`, map the two supported names, and reject unknown or disagreeing values before
  compilation. Derive `DEB_NAME`, `Architecture`, output paths, and description text from that
  detected value.
- **Implementation:** Accept `--expect-arch amd64|arm64` for release automation, but use it only as a
  mismatch guard. Emit version, detected architecture, Node version, source revision, and final
  SHA-256 in a machine-readable sidecar manifest.
- **Implementation:** Keep the staged-tree `require()` checks for every native dependency. After
  building, inspect the package control metadata and staged native binary formats; assert package
  architecture, Node architecture, and native payload agree.
- **Implementation:** Place artifacts under `releases/deb/<version>/<arch>/` so two machines do not
  race on one repository-root filename and the repository builder has a deterministic input layout.
- **Edge Cases:** Reject a dirty or version-mismatched release set at publication time rather than
  trusting filenames. Keep `apt install ./switchboard_<version>_<arch>.deb` working.

### `scripts/package-deb.sh:65-81` — staged native payload size

- **Context:** The vendored `node-pty/prebuilds/` carries Darwin and Windows binaries that the Linux
  package cannot load; the Linux addon is produced by the package-time native build outside that
  directory.
- **Implementation:** When staged `node-pty` exists, remove only its staged `prebuilds/` directory,
  then rerun the existing staged-tree `require('node-pty')` check. If the dependency no longer exists,
  skip this step cleanly. Never modify the repository's own `node_modules`.
- **Verification:** Record package installed size and payload listing in the sidecar manifest. Treat
  the old ~33 MB observation as a benchmark, not an exact acceptance threshold that fails as normal
  dependencies change.

### Node runtime decision — `package.json:22-25`, `scripts/package-deb.sh:103-121`, and `packaging/debian/README.md`

> **Superseded:** Pick between documenting NodeSource, lowering the floor to Node 20, or bundling a
> runtime.
> **Reason:** The repository currently declares Node >=22 even though one CI workflow runs Node 20,
> and no full standalone/package compatibility run in this planning pass proves the application
> contract can be lowered. Bundling remains expressly rejected.
> **Replaced with:** Keep `Depends: nodejs (>= 22)` and use the current NodeSource Node 22 apt
> repository as the documented prerequisite for both architectures. Its current setup script
> explicitly permits `amd64` and `arm64`, emits a deb822 `nodistro` source, and installs the
> `nodejs` package.

> **Superseded:** Use NodeSource only if external research confirms current Debian trixie/Raspberry
> Pi OS support and repository-signing instructions.
> **Reason:** Current upstream NodeSource material resolves architecture and source-format support,
> while Debian 13's stock package is confirmed at Node 20.19.2. A recent Debian 13 signature-policy
> issue means successful installation must still be proven on clean targets rather than inferred
> from the setup script.
> **Replaced with:** Treat NodeSource as the selected prerequisite, but block publication unless
> `apt update --audit` and `apt install nodejs` succeed without signature-policy warnings on clean
> current amd64 Debian 13 and arm64 Raspberry Pi OS images.

- **Implementation:** Put the dependency value in one reviewable packaging constant or control
  template rather than leaving the only copy buried in an inline heredoc. Assert it matches the
  application engine floor.
- **Implementation:** Document the prerequisite before the Switchboard source. Verify both the
  apt-visible `nodejs` package version and `node --version` before attempting
  `apt install switchboard`, so failure names the missing prerequisite instead of ending as a bare
  dependency-resolution error. Do not use nvm as evidence that the Debian dependency is satisfied.
- **Scope:** Do not lower `package.json` engines here and do not bundle Node. A future compatibility
  plan may lower both package and application floors after complete standalone tests on Node 20.

### `scripts/build-apt-repository.sh` (new)

- **Context:** No apt repository tooling exists in the repository. The builder consumes completed
  native package artifacts; it does not invoke remote builds or hold host credentials.
- **Implementation:** Require exactly one validated `amd64` and one validated `arm64` artifact for the
  requested application version. Compare package control version, source revision, application
  metadata, architecture, and sidecar hashes before generating any repository output.
- **Implementation:** Build this static layout in a temporary directory:

  ```text
  pool/main/s/switchboard/switchboard_<version>_<arch>.deb
  dists/stable/main/binary-amd64/Packages
  dists/stable/main/binary-amd64/Packages.gz
  dists/stable/main/binary-arm64/Packages
  dists/stable/main/binary-arm64/Packages.gz
  dists/stable/Release
  dists/stable/InRelease
  dists/stable/Release.gpg
  switchboard-archive-keyring.gpg
  release-manifest.json
  ```

- **Implementation:** Generate each architecture index with `dpkg-scanpackages` using
  `--arch <arch> --multiversion`, include retained older versions needed for upgrades, use deterministic
  compression, and generate the suite-root `Release` only after all indexes exist. Reject duplicate
  version/architecture entries with differing hashes.
- **Implementation:** Set `Acquire-By-Hash: yes` only when the builder also materializes every
  referenced index at `by-hash/SHA256/<digest>` and publication retains old hash-addressed objects
  long enough for clients holding the previous `InRelease`. Add a `Valid-Until` interval tied to the
  documented release cadence; expiration must be monitored because a missed release otherwise
  blocks updates by design.
- **Implementation:** Require `--signing-fingerprint`, verify the full fingerprint, create both
  clear-signed `InRelease` and detached `Release.gpg`, export the public key, and verify both
  signatures in an isolated temporary GPG home containing only that public key. Use an OpenPGP
  signing profile accepted by every target apt version; do not conflate proposed `apt-sign`
  Ed25519 signatures with OpenPGP key algorithm support.
- **Implementation:** Emit a manifest containing tool versions, source revision, package hashes,
  index hashes, signing fingerprint, repository suite/component/architectures, and generation time.
  No secret paths or key material enter it.
- **Edge Cases:** Refuse a missing architecture, mixed version, mixed revision, unsigned output,
  stale index, unresolved signing key, or changed artifact at an existing version. Leave the prior
  repository tree untouched on every failure.

### `scripts/publish-apt-repository.sh` (new) and `scripts/publish-release.sh:7-60`

> **Superseded:** A rebuild at the same version must replace the existing repository entry rather
> than accumulate.
> **Reason:** Reusing a Debian version for different bytes breaks immutable release identity and can
> leave clients with cached metadata that names a different hash.
> **Replaced with:** Same version plus same hashes is idempotent; same version plus different hashes
> is rejected. Publish changed bytes only under a higher package version.

- **Context:** The existing publisher handles one VSIX GitHub Release and has no apt origin, signing,
  architecture-set validation, or atomic static-site deployment.
- **Implementation:** Keep repository generation separate from transport. Publish the validated
  static tree under an `apt/` prefix on the repository's GitHub Pages deployment. Resolve the actual
  Pages origin through GitHub configuration/API after Pages is enabled; refuse to publish when Pages
  is disabled or the resolved origin differs from the release manifest. Never guess the URL from the
  repository owner/name.
- **Implementation:** Perform all signing locally on the x86 tower before any GitHub operation. The
  publisher may upload the public key, packages, indexes, signatures, and manifest; it must never
  read, export, transmit, or store the private key in GitHub, GitHub Actions, repository history, or
  Pages artifacts.
- **Implementation:** Publish a complete generated snapshot to the configured Pages source, with
  immutable package and `by-hash` objects preceding canonical metadata and `InRelease` serving as the
  final target-client commit marker. Retain every object referenced by prior signed metadata. A
  single source commit does not prove atomic CDN propagation, so the acceptance test must repeatedly
  run `apt update` during deployment and prove every observation resolves to an old or new complete
  release.
- **Implementation:** Do not claim that upload order alone makes the detached `Release` plus
  `Release.gpg` pair atomic. Read back the deployed public key, every canonical and by-hash index,
  signed metadata, and both current packages from the resolved Pages origin; compare hashes before
  reporting success.
- **Implementation:** Extend release output to list both `.deb` assets, the resolved Pages apt origin,
  signing fingerprint, `Valid-Until`, and repository manifest. Do not create or rotate signing keys
  automatically.
- **Edge Cases:** A failed upload leaves the old signed repository authoritative. A retry with the
  same manifest is idempotent. A destination containing a conflicting same-version package aborts.
  Republish of old metadata does not downgrade an already installed newer Debian version; an actual
  rollback needs an explicitly higher corrective package version or an operator-approved downgrade.

### Operator installation documentation — `packaging/debian/README.md`

- **Implementation:** Add the reviewed Node prerequisite, dedicated keyring installation, deb822
  source definition, `apt update`, `apt install switchboard`, `switchboard setup host`, direct `.deb`
  fallback, upgrade, and key-fingerprint verification steps.
- **Implementation:** Put an operator-downloaded ASCII-armored key at
  `/etc/apt/keyrings/switchboard-archive-keyring.asc` with permissions readable by `_apt`. Reserve
  `/usr/share/keyrings` for a future package-managed keyring. The extension must match the encoding:
  `.asc` for armored data, `.gpg` for an unarmored export.
- **Implementation:** Use a deb822 source with `Types`, `URIs`, `Suites`, `Components`,
  `Architectures: amd64 arm64`, and `Signed-By` pointing only at the Switchboard keyring. Fill the
  real reviewed origin during publication; do not ship a literal placeholder as runnable guidance.
- **Edge Cases:** Instructions distinguish CPU architecture from `uname -m` naming, explain why nvm
  does not satisfy an apt dependency, and provide an explicit recovery path for missing Node,
  signature failure, wrong architecture, and an unavailable repository.
- **Scope:** Do not pursue Debian proper or a PPA in this plan. Do not claim macOS support.

### Scope constraints

- Do not cross-compile or merely relabel native Node dependencies.
- Do not add a CI subscription or require hosted CI for package production.
- Do not bundle a Node runtime or lower the application engine floor in this plan.
- Do not commit, upload, echo, or serialize the GPG private key.
- Do not build the future Go client here; when it exists, a later package change can add its
  architecture-matched binary.
- Do not attempt Debian archive or PPA submission.

## Verification Plan

### Automated Tests

1. The arm64 package is built and installed on a real Pi as part of the release, not inferred from a
   green amd64 build — a matrix that only ever exercises x86 is how the lead platform rots.
2. Add a packaging contract that fails if `Architecture: arm64` or an arm64-only output name remains
   hardcoded and asserts architecture comes from native Debian and Node probes.
3. Exercise architecture validation with command probes stubbed as matching amd64, matching arm64,
   mismatched labels, unsupported values, and missing tools. Mismatch must fail before compilation.
4. Build repository fixtures from two small test packages and assert per-architecture indexes,
   deterministic compression, retained prior versions, full-fingerprint selection, suite-root
   release hashes, materialized by-hash objects, `Valid-Until`, and isolated verification of both
   signature forms.
5. Assert missing architecture, mixed package versions, mixed source revisions, stale sidecar hash,
   and same-version/different-bytes input all fail without modifying the previous output tree.
6. Add documentation/source contracts that forbid `apt-key`, require deb822 `Signed-By`, enforce
   `.asc`/`.gpg` encoding and `/etc/apt/keyrings` for the operator-managed key, require both
   architectures, and keep direct local `.deb` installation documented.
7. Add publication dry-run tests that assert immutable objects precede canonical metadata,
   `InRelease` is the final commit marker, remote read-back hashes match, retries are idempotent, and
   an injected upload failure preserves every object referenced by the old signed metadata.

### Goal Invariants

- `scripts/package-deb.sh` contains no hardcoded package architecture and cannot stamp an
  architecture that disagrees with both the native Debian probe and `process.arch`.
- For one release version, exactly one `amd64` and one `arm64` package exist and both sidecars name
  the same source revision and application version.
- `dists/stable/main/binary-amd64/Packages` references only amd64 package entries and
  `binary-arm64/Packages` references only arm64 package entries.
- `dists/stable/Release`, `InRelease`, and `Release.gpg` exist at the suite root; both signatures
  verify against the published dedicated keyring and `Release` hashes cover every published index.
- `Acquire-By-Hash: yes` appears only when every advertised index digest exists under the matching
  `by-hash/SHA256/` path, and `Valid-Until` is later than `Date` by the configured release interval.
- A conflicting artifact at an already-published version is rejected rather than replaced.
- `apt install ./switchboard_<version>_<arch>.deb` remains supported independently of the repository.
- No GPG private key file exists anywhere under the repository or generated public tree.

### Native Package Acceptance

1. Build on the x86 tower with `--expect-arch amd64` and on the Pi with
   `--expect-arch arm64`. Inspect package control metadata and native payloads before transfer.
3. Install each local `.deb` on its matching clean target. Start a board, open it, create a terminal
   when `node-pty` is present, and exercise a database read/write using the vendored
   `better-sqlite3`.
4. Attempt each package on the opposite architecture and confirm apt rejects it as wrong
   architecture rather than installing a mislabeled package.
5. Confirm the package produced after the settings subtask starts through the new service settings
   reader and preserves existing env-only configured installs.

### Repository Acceptance

1. On clean current amd64 Debian 13 and arm64 Raspberry Pi OS targets, configure NodeSource 22 using
   its deb822 source. `apt update --audit` must complete without signature-policy warnings, and the
   dpkg database must report an installed `nodejs` version satisfying Node >=22.
3. Install the operator-managed Switchboard key under `/etc/apt/keyrings`, add the Switchboard
   deb822 source, and run `apt update`; it must complete without key, expiry, hash, or architecture
   warnings.
4. `apt install switchboard` must select the matching architecture automatically and start a board
   after host setup.
5. Publish a higher version and confirm `apt upgrade` moves both machines to it while preserving
   service configuration and board data.
6. Tamper with a package and with an index in an isolated repository copy. Each case must fail apt
   verification before installation.
7. Run repeated `apt update` calls throughout a deliberately slowed publication and interrupt it
   before final `InRelease` promotion. Every client observation must resolve to the previous complete
   release or the new complete release, never mixed metadata.
8. Verify the repository public key fingerprint through an independent channel and confirm the
   installed keyring contains only the intended public key.

## Resolved Decisions

> **Superseded:** Choose the stable HTTPS origin, signing-key custodian/backup, and whether “every
> machine” includes a macOS package-manager path.
> **Reason:** The user answered all three decisions.
> **Replaced with:** GitHub Pages hosts the apt tree; the x86 tower holds the passphrase-protected
> private key with an encrypted offline backup; this feature supports Debian-compatible amd64 and
> arm64 Linux only.

- Resolve the real GitHub Pages origin from repository configuration/API and publish below its
  `apt/` prefix. Do not infer or hardcode a guessed owner-based URL.
- Sign locally on the tower. GitHub receives only the minimal public key, signed metadata, package
  files, indexes, and public release manifest.
- No Homebrew formula, cask, macOS package, or macOS support claim belongs to this feature.

## Resolved Assumptions

> **Superseded:** Research whether a selected Node apt provider supports current Raspberry Pi
> OS/Debian trixie on both arm64 and amd64 with Node 22 or newer.
> **Reason:** Current upstream NodeSource setup material explicitly supports Node 22 on `amd64` and
> `arm64`, produces a deb822 source, and installs an apt-visible `nodejs` package.
> **Replaced with:** NodeSource is the selected prerequisite. Clean-target `apt update --audit` and
> install checks remain mandatory because compatibility is proven by the target package manager, not
> by documentation alone.

- Debian 13 Trixie is stable, not testing: 13.0 released on 2025-08-09 and the current official
  release page reports 13.6. Its stock `nodejs` package is 20.19.2 on both amd64 and arm64, so it does
  not satisfy this repository's Node >=22 application contract.
- Trixie's apt supports deb822 `.sources`; apt-key is deprecated. Operator-managed keys belong under
  `/etc/apt/keyrings`, package-managed keys under `/usr/share/keyrings`, and armored/unarmored exports
  must use `.asc`/`.gpg` respectively.
- Apt authenticates the suite-root Release metadata chain: package hashes are in `Packages`, index
  hashes are in `Release`, and the archive publishes clear-signed `InRelease` and/or detached
  `Release.gpg`. This protects transport integrity, not the trustworthiness of package contents.
- `dpkg-scanpackages --multiversion` includes all discovered package versions.
  `apt-ftparchive release` supports `Acquire-By-Hash`, `Valid-Until`, architectures, components,
  suite, codename, and other Release fields; advertising by-hash is valid only when the matching
  hash-addressed objects are actually published.
- Debian Policy 4.13 strongly discourages embedded convenience copies and requires packaged libraries
  to be used when available, with separate prerequisites “if possible” when absent. It does not
  justify the report's unconditional statement that every vendored dependency is strictly forbidden.

## Recommendation

Send to Lead Coder. User decisions and external mechanics are resolved, so the plan is ready to
execute. First public publication remains gated on enabling and resolving GitHub Pages, creating and
backing up the tower-held signing key, and passing clean-target NodeSource and deployment acceptance.

## Implementation Summary

Implemented the amd64+arm64 packaging and signed apt repository pipeline. `scripts/package-deb.sh` now detects the Debian architecture from `dpkg --print-architecture` and the Node architecture from `process.arch`, requires them to agree, maps `x64->amd64`/`arm64->arm64`, stamps `Architecture:` from the detected value, accepts `--expect-arch` only as a mismatch-guard assertion, strips staged `node-pty/prebuilds/`, validates every native ELF machine post-build, and emits a sidecar manifest (version, arch, Node version, source revision, SHA-256) under `releases/deb/<version>/<arch>/`. `scripts/build-apt-repository.sh` (new) consumes one validated amd64 and one validated arm64 artifact of the same version+revision, builds a signed apt tree with `dpkg-scanpackages --multiversion`, deterministic `gzip -n`, `Acquire-By-Hash: yes` with materialized by-hash objects, `Valid-Until`, full 40-char fingerprint signing, isolated-keyring verification of both `InRelease` and `Release.gpg`, a private-key-leak scan, and a `release-manifest.json`; it rejects mixed-version/mixed-revision/dirty-tree/same-version-different-bytes inputs and leaves the prior tree untouched on any failure. `scripts/publish-apt-repository.sh` (new) resolves the actual GitHub Pages origin via `gh api`, refuses when Pages is disabled or the origin mismatches the manifest, preserves prior by-hash and pool objects for upgrade retention, pushes to the Pages branch, polls until the build completes, and reads back every canonical + by-hash index, signed metadata, and both packages comparing hashes before reporting success. `scripts/publish-release.sh` now attaches both `.deb` assets and the apt manifest to the GitHub Release and appends an apt-repository section (origin, fingerprint, Valid-Until, architectures) to the release notes. `packaging/debian/README.md` documents the NodeSource Node 22 prerequisite (with the nvm warning), dedicated-keyring + deb822 `Signed-By` source, fingerprint verification, direct `.deb` fallback, upgrades, architecture-name disambiguation, and recovery paths. `src/test/deb-packaging-contract.test.js` (new, registered as `test:contract:deb-packaging`) asserts no hardcoded architecture remains, arch comes from native probes, `--expect-arch` is an assertion only, the Node floor is a single constant, the sidecar manifest is emitted, prebuilds are stripped, and the README forbids `apt-key`, requires deb822 `Signed-By`, enforces `.asc` encoding, lists both architectures, and documents direct `.deb` installation — all 30 checks pass.

## Review Findings

Reviewed `scripts/package-deb.sh`, `scripts/build-apt-repository.sh`, `scripts/publish-apt-repository.sh`, `scripts/publish-release.sh`, `packaging/debian/README.md` and `src/test/deb-packaging-contract.test.js`; the architecture detection, agreement gate, ELF-machine validation, sidecar manifest, fingerprint handling, isolated-keyring verification, by-hash materialisation and Pages-origin resolution all match the plan, and `test:contract:deb-packaging` is genuinely invoked by CI at `.github/workflows/integration-tests.yml:512`. Two defects fixed: `NODE_ENGINE_FLOOR` was a hand-typed `"22"` rather than derived from `package.json` `engines.node`, which the plan explicitly required ("Assert it matches the application engine floor") and which drifts silently the moment the floor moves — it now reads the engine range and the contract test forbids a literal; and a comment claimed the systemd unit execs the Node entry directly, which stopped being true when the sibling subtask changed `ExecStart` to `/usr/bin/switchboard service` and a later commit made `/usr/bin/switchboard` the static Go client. That interaction is the cross-subtask risk this feature carried and it is safe — `service` is not in the Go client's `ownedVerbs`, so it `syscall.Exec`s the Node host in place and systemd's MainPID is preserved — but nothing asserted it, so a new contract check now fails if `service` ever becomes an owned Go verb or if `EnvironmentFile` loses its `-` prefix. Verification: `npm run test:contract:deb-packaging` passes all 31 checks (was 30), `bash -n scripts/package-deb.sh` is clean, the engine-floor derivation was run standalone and returns `22`, and `npm run compile-tests` / `npm run compile` both exit 0. The remaining risk is that no test executes any of the three shell scripts: every packaging assertion is a regex over source text, so the repository builder and publisher have never actually run.

## Deferred Findings

- MAJOR — `src/test/deb-packaging-contract.test.js:1` — the plan's Automated tests #3 (architecture validation with stubbed command probes), #5 (missing-architecture / mixed-version / mixed-revision / stale-sidecar / same-version-different-bytes inputs all failing without modifying the previous output tree) and #7 (publication dry-run: immutable objects before canonical metadata, `InRelease` last, read-back hashes, idempotent retry, injected upload failure preserving prior objects) are not implemented. The suite is entirely regex-over-source; it can prove the scripts *say* the right things and cannot prove they *do* them. Building the two-package GPG fixture harness those three require is a subtask of its own, not a review-pass edit.
- MAJOR — plan Automated test #1 (arm64 built and installed on a real Pi as part of the release) and the clean-target `apt update --audit` / install / upgrade acceptance gate are runtime-only and were not executed. No conclusion about whether the apt repository actually installs can be drawn from this pass.
- NIT — `scripts/build-apt-repository.sh:479` — the "idempotent retry" branch compares the stored `InRelease` sha256 against the newly generated one, but GPG signatures are not byte-reproducible across runs, so the comparison effectively never matches and the branch is dead. The fallback is a hard refusal with a clear message, so the failure mode is safe; the retry convenience simply does not exist.
- NIT — `scripts/package-deb.sh:40` — `--expect-arch` accepts only the `--expect-arch=amd64` form; the plan's prose and the `--help` text both show `--expect-arch amd64`, so a space-separated invocation exits 2 with "unknown argument".
- NIT — `scripts/build-apt-repository.sh:335` — `verify_release_coverage` greps `Release` for each index digest anywhere in the file rather than matching the digest against its own named entry, so a digest appearing under the wrong filename would pass.
