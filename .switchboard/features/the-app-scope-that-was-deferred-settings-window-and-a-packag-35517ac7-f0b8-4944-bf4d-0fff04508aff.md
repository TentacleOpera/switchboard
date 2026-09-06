# The App Scope That Was Deferred — Settings Window and a Package for Every Machine

**Complexity:** 8

## Goal

Two pieces of Switchboard Installs Like an Application that its review recorded as undelivered rather than done: change 10 (a settings window — only a read-only JSON endpoint exists, its write path was deleted in review) and change 0's package-manager half (arm64-only, so no x86 Linux and no Mac). Filed as their own feature because the parent is at CODE REVIEWED and a new plan behind coded subtasks never gets picked up.

## How the Subtasks Achieve This

- **A Settings Window, and the Write Path Its Review Deleted**: Extends the existing Setup surface with source-tagged host settings and a durable write path that the CLI, packaged service, extension host, and standalone host actually consume, closing the reviewed gap without restoring the deleted process-private or pairing state.
- **An amd64 Package and an apt Repository, So More Than One Machine Can Install It**: Turns the arm64-only file build into validated native amd64/arm64 artifacts and a signed, upgradeable apt repository, while making the Node prerequisite, signing identity, publication origin, and direct `.deb` fallback explicit.

## Dependencies & sequencing

- Code and merge **A Settings Window, and the Write Path Its Review Deleted** first. It changes the CLI startup reader and Debian service unit that the package build compiles and copies; publishing packages first would distribute the old startup behavior.
- Packaging-script and repository-builder work may begin in parallel, but native release artifacts must be built, signed, and published only after the settings subtask has landed and its service-startup compatibility path is present.
- Before apt publication, require one validated amd64 package and one validated arm64 package from the same version/source revision, enable GitHub Pages and resolve its actual configured origin, and create the tower-held signing key plus tested encrypted offline backup.
- The user selected Debian-compatible amd64/arm64 Linux only. In this feature, “every machine” means the x86 tower and arm64 Pi; it does not claim or add a macOS package-manager path.

## Team Dispatch Instructions

### A Settings Window, and the Write Path Its Review Deleted

**Seat:** lead

**Acceptance:**
- The existing Setup panel exposes workspace, port, serve-mode, and PATH settings with distinct effective/configured values and source labels in browser, extension, and launcher entry paths.
- An authenticated, revision-checked settings write persists atomically; invalid, stale, corrupt, or unreachable writes fail visibly and never report success.
- Restarting the packaged service consumes saved values through the real startup reader, while explicit CLI mode/port/workspace values remain stronger.
- Both composition roots wire the same settings read/write service, and an existing env-only packaged install remains startable.
- No peer or pairing state is required to open, read, or save the settings surface.

**Must not touch:** Pairing endpoints/state, peer management, tunnel transitions, the deferred two-axis mode picker, operator edits in the legacy env file, or the retired `workspace_mappings` API as a startup catalog.

### An amd64 Package and an apt Repository, So More Than One Machine Can Install It

**Seat:** lead

**Acceptance:**
- Native amd64 and arm64 packages from the same version/source revision carry matching control metadata and load their staged native dependencies on their target machines.
- The signed apt repository publishes through the resolved GitHub Pages origin; inline and detached signatures verify against the public key while the private key remains only on the tower and its encrypted offline backup.
- Clean amd64 Debian 13 and arm64 Raspberry Pi OS targets pass the NodeSource `apt update --audit` gate, satisfy Node 22, install `switchboard` from apt, start a board, and upgrade to a higher published version.
- Same-version/different-bytes publication is rejected, interrupted publication leaves the previous repository authoritative, and direct local `.deb` installation remains supported.

**Must not touch:** Hosted-CI subscription setup, cross-compiled or relabeled native modules, bundled Node runtime, application Node-floor reduction, GPG private-key material, future Go-client packaging, Debian archive/PPA submission, or macOS packaging.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [A Settings Window, and the Write Path Its Review Deleted](../plans/settings-window-and-the-write-path-review-deleted.md) — **CODE REVIEWED** — ID: 307d08aa-7a47-46cd-b761-8a397d71a6a7
- [ ] [An amd64 Package and an apt Repository, So More Than One Machine Can Install It](../plans/amd64-package-and-an-apt-repository.md) — **CODE REVIEWED** — ID: 8c049373-01f1-49b6-a5e4-f86b1b39f300
<!-- END SUBTASKS -->

## Completion Summary

Both subtasks implemented and committed. The settings subtask (307d08aa) added `src/services/hostSettings.ts` (versioned schema, atomic writes, revision conflict detection, source-tagged resolution cli > durable > legacy-env > default), an authenticated `PUT /settings` with 400/409/503/500 error codes on LocalApiServer, a durable-aware `GET /settings`, a Host tab in the Setup panel with source labels and conflict retention, `#setup:host` deep-linking, and a `switchboard service` CLI subcommand that reads durable settings before boot. Both composition roots (standalone/bootstrap.ts, TaskViewerProvider.ts) wire the same read/write service. One fix round: the systemd unit ExecStart was passing `--port`/`--workspace` from the env file as explicit CLI flags, which would have overridden durable values on every restart; corrected to `switchboard service --no-open` so env values reach resolution only as legacy-env fallbacks. The packaging subtask (8c049373) rewrote `scripts/package-deb.sh` for native amd64/arm64 detection (dpkg + process.arch must agree), added `scripts/build-apt-repository.sh` (signed repo with full 40-char fingerprint, InRelease + Release.gpg, by-hash objects, isolated-keyring verification, same-version/different-bytes rejection) and `scripts/publish-apt-repository.sh` (gh-api Pages origin resolution, prior-object retention, post-push hash read-back), extended `scripts/publish-release.sh` to attach both .debs + the apt manifest, updated `packaging/debian/README.md` with NodeSource Node 22 prereq and deb822 Signed-By setup, and added `src/test/deb-packaging-contract.test.js` (30 checks, all passing). End-to-end install/upgrade on real Pi + tower hardware is runtime validation outside this environment.


## Review Findings

Both subtasks reviewed as one delivery unit, settings first because it changes the CLI startup reader and systemd unit the packaging subtask copies. Ten defects fixed across `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`, `src/services/hostSettings.ts`, `src/standalone/bootstrap.ts`, `src/standalone/cli.ts`, `src/services/PlanningPanelProvider.ts`, `packaging/debian/switchboard.service`, `scripts/package-deb.sh` and two test files; the dominant shape was the one this repo keeps reporting — a value written and never read (the extension host's Host tab and its durable PATH were both dead behind a lazily-populated field standalone wired eagerly) and a fallback wearing a configured label (a malformed `SWITCHBOARD_PORT` substituted with 7777 and still tagged `legacy-env`, a context-free settings read calling a running tailnet host "local (default)"). The feature's own sequencing risk — settings changing `ExecStart` to `switchboard service` while a later card made `/usr/bin/switchboard` the static Go client — resolves safely because `service` is not an owned Go verb, and a new contract check now pins that. The CI compile gate was red at the start of this pass (`npm run compile-tests`, three errors from the settings commit plus two from an unrelated card) and is green now; a new `test:contract:host-settings` gate (25 checks) closes the settings subtask's total absence of automated coverage. Both subtask plan files carry their own findings and deferred lists.

## Deferred Findings

- MAJOR — the packaging subtask's repository builder and publisher have never been executed; every packaging assertion is a regex over source text. See `amd64-package-and-an-apt-repository.md` for the itemised list.
- MAJOR — the feature's end-to-end acceptance (native amd64 + arm64 packages installed and upgraded from the signed apt repository on clean Debian 13 and Raspberry Pi OS targets, and a packaged service restarted to consume saved Host-tab values) is runtime validation on real hardware and was not performed in this pass.
