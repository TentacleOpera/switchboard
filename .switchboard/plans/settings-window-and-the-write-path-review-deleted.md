# A Settings Window, and the Write Path Its Review Deleted

kanbanColumn: CREATED

## Goal

The values that live in CLI flags and environment files get a surface an operator can open: the
workspace set, port, serve mode, and the PATH additions agent CLIs need. Each shows where it
resolved from, each can be changed, and a change reaches the thing that reads it.

### Problem analysis

**Extracted from `switchboard-as-a-local-app-and-a-self-hosted-remote.md` (`9adefb23`), which is at
CODE REVIEWED with this explicitly undelivered.** Its review says so:

> MAJOR — change 10's settings **window** does not exist. There is a read-only JSON endpoint and no
> UI, so workspace root, port, PATH additions and mode still have no home an operator can open.

A board search for a settings window or settings UI returns nothing. The launcher plan
(`go-launcher-static-binary.md`) defers to "change 10 of the parent card" — which is a card that has
already been signed off, so the deferral pointed nowhere. This plan is that home.

**The write path was deleted during review, deliberately, and the reasons matter.** From the same
card's Review Deviations:

> `POST /settings`, `POST /pair` and `DELETE /pair` were deleted, along with the `_pendingServeMode`
> and `_pairingState` fields. `GET /settings` was kept and given per-value `source` reporting.
>
> As delivered, all three write endpoints stored their input in a private field of a single
> `LocalApiServer` instance and nothing anywhere read it back. Serve mode is decided by the
> subcommand the operator typed or by `SWITCHBOARD_SERVE_MODE` in the systemd env file; a preference
> held in this process could never reach either, and the endpoint said `success: true` regardless.

So this is not "add a form to an existing API". The read side exists and is good; **the write side
has to be designed**, and the reviewer named the decision it turns on:

> does a stored mode beat an explicit `switchboard tailnet`?

**That question is the plan, not an aside.** Serve mode currently has three sources — the subcommand
typed, `SWITCHBOARD_SERVE_MODE` in `/etc/switchboard/switchboard.env`, and the unit's `ExecStartPre`
which refuses anything that is not `local` or `tailnet`. Adding a fourth that silently outranks the
others is exactly the class of defect this codebase treats as its worst: a stored value that behaves
like a configured one, with no record of which store answered.

### Clarified end state

The existing Setup panel becomes the settings window through a dedicated **Host** tab; a second
shell-level settings application is unnecessary. A shared host-settings service owns validation,
source-tagged resolution, persistence, and optimistic concurrency. Both the extension-host and
standalone composition roots wire that same service into the Setup panel and `LocalApiServer`, and
the CLI/service startup path reads the durable value before it boots the host.

## Metadata

- **Complexity:** 8
- **Tags:** ui, ux, api, security, reliability, feature

## User Review Required

None. The plan resolves precedence as explicit invocation or explicit per-field CLI flags first,
then the durable host setting, then a tagged legacy systemd environment value, then a visible safe
default. It does not restore pairing or add a mode-transition control.

## Complexity Audit

> **Superseded:** Complexity 6.
> **Reason:** The work crosses a persisted machine-global schema, released systemd configuration,
> two composition roots, an authenticated mutation endpoint, launcher/startup precedence, and a UI
> with stale-write handling. These are architectural and migration-sensitive changes, not two
> moderate additions.
> **Replaced with:** Complexity 8 — route to a Lead Coder.

### Routine

- Add the Host tab and field/source/status rendering to the existing Setup panel.
- Validate the finite serve-mode enum and numeric port range.
- Extend the existing source-level host-parity contract style with the new seams.

### Complex / Risky

- Make a durable setting reach the startup reader rather than merely reach a database or process
  field.
- Preserve released `/etc/switchboard/switchboard.env` installs while introducing a user-writable
  authority.
- Keep per-field provenance distinguishable across CLI flags, explicit subcommands, the new store,
  legacy environment values, and defaults.
- Prevent concurrent windows from silently overwriting each other.
- Treat PATH and workspace roots as behavior-changing input at an authenticated network boundary.
- Keep the extension and standalone roots behaviorally symmetric despite their different startup
  mechanisms.

## Edge-Case & Dependency Audit

### Race Conditions

- Return a stable `revision` with every read. `PUT /settings` requires `expectedRevision`; reject a
  stale save with HTTP 409 and return the fresh state so two open windows cannot silently erase one
  another.
- Write `host-settings.json` through a same-directory temporary file, flush/close it, then rename.
  Serialize writes in-process so concurrent requests cannot interleave validation and replacement.
- Complete the HTTP response before scheduling any host restart. Never terminate the server while
  its save response is still in flight.

### Security

- Apply the existing LocalApiServer authentication/trust boundary to `PUT /settings`; do not leave a
  behavior-changing endpoint on the unauthenticated read path merely because `GET /settings` is
  readable.
- Accept only known keys. Reject unknown request fields, NUL/newline characters, non-absolute
  workspace roots after `~` expansion, duplicate canonical roots, invalid ports, invalid modes,
  and PATH entries containing the platform path delimiter.
- Store PATH as an array, not an interpolated shell string. Pass it through process environment APIs;
  never evaluate it in a shell command.
- Never return secrets or authentication material from the settings read.

### Side Effects

- Port, serve mode, selected workspace, and PATH are restart-bound settings. A successful save must
  return `restartRequired: true`, list the affected fields, and leave the current effective values
  unchanged until restart.
- Removing a workspace from the catalog must not delete its `.switchboard/` directory or board
  database. This is routing/configuration only.
- A missing workspace path is a visible validation error for the selected startup workspace. A
  non-selected catalog entry may be retained as unavailable only when the response tags that state;
  it must not silently become the selected root.
- Existing hand-edited `/etc/switchboard/switchboard.env` content remains untouched by UI saves.

### Dependencies & Conflicts

- `scripts/package-deb.sh` copies the current `dist/` and `packaging/debian/switchboard.service` into
  the package. This subtask must land before the packaging subtask performs its final build and
  repository publication, or the package will distribute the old startup reader.
- `src/services/KanbanDatabase.ts:1328-1334` has retired `getWorkspaceMappings()` and
  `setWorkspaceMappings()` as no-ops. The new workspace catalog must not use that dead API.
- Existing Setup-panel mappings UI is unrelated legacy/control-plane presentation. Do not make it a
  second writer of host startup workspaces.

## Dependencies

- **An amd64 Package and an apt Repository, So More Than One Machine Can Install It** — no coding
  prerequisite, but its final package build/publish must follow this subtask so released artifacts
  contain the new startup reader and service unit.
- No external session dependency is required for implementation.

## Adversarial Synthesis

Key risks are a success response disconnected from startup, a privileged or destructive rewrite of
the released conffile, stale-window data loss, and host-only wiring. Mitigate them with one
source-tagged service, a user-writable atomic store, a tagged legacy fallback, revision-checked
writes, strict validation, and explicit extension/standalone composition-root assertions.

## Proposed Changes

### `src/services/hostSettings.ts` (new)

- **Context:** Create the one schema and service used by API, UI, CLI, and both hosts. Use
  `stateFile('host-settings.json')`, which resolves to `~/.switchboard/host-settings.json` (or the
  explicit `SWITCHBOARD_STATE_HOME`) and is available before any workspace database is selected.
- **Logic:** Define a versioned document with `version`, `workspaces` (`id`, `name`, canonical
  `root`), `defaultWorkspaceId`, `port`, `serveMode`, and `extraPath` as an array. Preserve unknown
  stored keys when writing so a newer install is not downgraded by an older writer.
- **Logic:** Expose `readHostSettings(context)` and
  `updateHostSettings(patch, expectedRevision, context)`. Resolution is per field:
  1. an explicit per-field CLI flag or explicit `local`/`tailnet` subcommand;
  2. the durable host-settings document;
  3. a legacy `SWITCHBOARD_*` value when running the package's service entrypoint;
  4. a safe default whose source is literally `default`.
  Return `effectiveValue`, `effectiveSource`, `configuredValue`, `configuredSource`, availability,
  and restart status for each field. Never collapse a fallback into the same source label as a real
  value.
- **Implementation:** Canonicalize roots using the repository's existing path/identity utilities,
  validate all fields before mutation, calculate the revision from the complete stored bytes, and
  use atomic same-directory replace with file mode `0600` and parent mode `0700`.
- **Edge Cases:** A corrupt file fails loudly and remains untouched. A missing file returns defaults
  tagged `default`. A stale revision returns a typed conflict without writing. An unrelated field
  survives a partial update.

### `src/standalone/cli.ts:2056-2339, 2420-2554, 3035-3080, 3980-4051`

- **Context:** `cmdSetupHost()` currently rewrites `/etc/switchboard/switchboard.env` wholesale, the
  bare launcher is rooted in the current working directory, and direct serve commands choose mode
  before bootstrap.
- **Implementation:** Add a package-only `service` subcommand that resolves host settings before
  calling `startHeadlessSwitchboard`. It uses the durable selected workspace, port, mode, and PATH;
  the legacy environment is a tagged fallback only when the durable field is absent. Direct
  `switchboard local`/`tailnet`, `--workspace`, and `--port` remain stronger per field.
- **Implementation:** Track whether each CLI value was explicitly supplied instead of treating the
  parser's default as configured input. Feed source/value pairs to the shared resolver.
- **Implementation:** Update `cmdSetupHost()` to seed the service user's
  `~/.switchboard/host-settings.json`, not root's home, and add
  `SWITCHBOARD_STATE_HOME=<service-home>` to the generated drop-in. Keep the existing env file as a
  released-install compatibility source; do not archive or delete it in this subtask.
- **Implementation:** Make the bare launcher list the same workspace catalog, select a root by stable
  ID, and spawn `local`/`tailnet` with an explicit `--workspace`. An empty catalog retains the current
  directory behavior and reports that source.
- **Edge Cases:** `service` is not a public synonym for `local`; it fails before bootstrap when no
  valid selected workspace can be resolved. PATH changes are applied to `process.env.PATH` before
  child agents can spawn, without shell interpolation.

### `packaging/debian/switchboard.service:9-41` and `packaging/debian/switchboard.env`

- **Context:** The released unit currently interpolates mode, port, and workspace directly from the
  root-owned conffile into `ExecStart`.
- **Implementation:** Start `/usr/bin/switchboard service --no-open`. Change `ExecStartPre` to call a
  non-mutating service-config validation mode that accepts the durable document or the tagged legacy
  environment fallback and names the failing field.
- **Implementation:** Keep `EnvironmentFile` as an optional legacy input during migration. Do not
  make a package upgrade delete or rewrite operator edits.
- **Edge Cases:** An existing configured install with only the old env file still starts. A fresh
  install remains disabled until `switchboard setup host` creates the user store and drop-in. The
  absolute `/usr/bin/switchboard` path remains independent of the configurable agent PATH.

### `src/services/LocalApiServer.ts:201-223, 903-911, 9637-9749`

- **Context:** `GET /settings` currently derives coarse running values directly from `_options` and
  deliberately has no write seam.
- **Implementation:** Add required-in-production, optional-in-test callbacks
  `readHostSettings` and `writeHostSettings` to `LocalApiServerOptions`. Make `GET /settings`
  delegate to the reader while retaining explicit runtime values. Add authenticated
  `PUT /settings` for a validated partial update with `expectedRevision`; return 400 for invalid
  input, 409 for stale revision, 503 when the host did not wire the writer, and 200 only after the
  atomic write completed.
- **Implementation:** Keep pairing endpoints absent. Do not restore `_pendingServeMode` or any
  process-private preference field.
- **Edge Cases:** Read remains usable with no peer configured. Write failure returns a non-2xx status
  and never reports `success: true`. Response fields distinguish current effective state from the
  configured next-start state.

### `src/services/TaskViewerProvider.ts:3650-3700, 4183-4220, 4479-4487, 4708-4716` and `src/standalone/bootstrap.ts:193-204, 3431-3454, 3623-3629, 3960-4006`

- **Context:** These are the two composition roots. The extension currently resolves tailnet mode
  only from `switchboard.remote.tailnet`; standalone receives mode/port after CLI parsing.
- **Implementation:** Construct one `HostSettingsService` per host lifetime, inject it into
  `LocalApiServer`, and inject the same instance into `SetupPanelProvider`. Resolve extension startup
  port/mode from explicit VS Code configuration first and the durable host setting second, reporting
  which source won. Standalone passes the CLI/service resolution context into the same reader.
- **Implementation:** Preserve the extension's explicit `remote.tailnet` setting as a stronger,
  source-tagged compatibility input; saving from the Host tab updates the durable store and clearly
  reports when the explicit VS Code setting still wins.
- **Edge Cases:** Add a source-level parity test that both options objects wire both callbacks and
  both Setup providers receive the same service instance. A missing seam must be visible as 503, not
  a no-op.

### `src/services/SetupPanelProvider.ts:217-227, 1086-1227` and `src/webview/setup.html:671-687, 827-842, 1420-1455, 2368-2480, 3460-3476`

> **Superseded:** The window reads and writes the workspace set through `workspace_mappings`, the
> same list the launcher's picker uses.
> **Reason:** `KanbanDatabase.getWorkspaceMappings()` and `setWorkspaceMappings()` are retired no-ops
> in the current repository, and the current launcher does not read that API. Building on it would
> render editable controls whose writes change nothing.
> **Replaced with:** The Host tab and launcher both use the versioned machine-global workspace
> catalog from `HostSettingsService`. Existing Multi-Repo mapping controls remain separate and are
> not presented as startup workspaces.

- **Implementation:** Add a Host tab to the existing Setup panel. Render workspace catalog entries,
  selected startup workspace, port, serve mode, and PATH entries. Beside every field show both the
  effective source and, when different, the configured next-start source/value.
- **Implementation:** Add `getHostSettings` and `saveHostSettings` service verbs that delegate to the
  injected service and return their result in the verb response as well as the existing browser push
  path. Include the last-read revision on save.
- **Implementation:** On HTTP 409/service conflict, retain the operator's typed values, show the
  fresh server values, and require a deliberate re-apply. On success, name fields needing restart.
- **Implementation:** Extend `openSetupSection` with `host`; the VS Code command can open it directly.
  Extend the shell deep-link bridge to support `#setup:host` and forward the section after the Setup
  frame loads, so the launcher and browser shell reach the same tab.
- **Edge Cases:** The tab loads and saves with no pairing state, no tailnet peer, and no external
  integration configured. A source label is text, never inferred from whether values happen to
  match.

### Precedence and persistence decision

> **Superseded:** Values only the host reads can live in the database, while values systemd reads
> must be written back to `/etc/switchboard/switchboard.env` by the settings UI.
> **Reason:** A database is not available before workspace selection, and a service-user web process
> cannot safely or portably rewrite a root-owned conffile. Splitting the settings across those stores
> also gives the launcher no machine-global workspace catalog.
> **Replaced with:** Persist all four operator-facing settings in the versioned user-owned
> `~/.switchboard/host-settings.json`. Make the extension and the package's new `service` entrypoint
> real readers of that file. Preserve `/etc/switchboard/switchboard.env` as a tagged released-install
> fallback until setup seeds the new file; UI saves never rewrite the conffile.

An explicit instruction at invocation always beats a stored preference. `switchboard tailnet` means
tailnet for that run even when the durable default says `local`. A stored mode supplies the service
entrypoint and launcher default only; it never changes the meaning of an explicit command.

### Scope constraints

- Do not add `POST /pair`, `DELETE /pair`, pairing state, peer management, tunnel transitions, or the
  deferred two-axis mode picker.
- Do not delete or rewrite the operator's legacy env file during migration.
- Do not use `workspace_mappings` as the startup workspace catalog.
- Do not create a second top-level Settings panel; extend the existing Setup surface.

## Verification Plan

### Automated Tests

1. Add focused `HostSettingsService` tests using a sandboxed `SWITCHBOARD_STATE_HOME`: missing,
   valid, corrupt, unknown-key preservation, atomic replacement, validation failures, and stale
   revision conflict.
2. Add precedence table tests for every field: explicit CLI input > durable setting > tagged legacy
   environment > tagged default. Assert equal values with different sources remain distinguishable.
3. Add LocalApiServer endpoint tests for `GET /settings`, authenticated `PUT /settings`, 400 invalid
   input, 409 stale revision, 503 unwired writer, and write failure never returning success.
4. Add source-level composition-root tests asserting both `TaskViewerProvider.ts` and
   `standalone/bootstrap.ts` wire `readHostSettings`, `writeHostSettings`, and the Setup provider.
5. Add Setup-panel/browser contracts for Host-tab hydration after `sbTransportSubscribed`, source
   labels, conflict retention, restart messaging, and `#setup:host` deep-link forwarding.
6. Add CLI/service tests covering explicit-mode precedence, explicit per-field flags, workspace
   selection by stable ID, legacy env fallback, corrupt-file failure, and PATH array application
   without shell evaluation.
7. Add Debian unit/package contracts proving an old env-only configured install still validates and
   a fresh host-settings install starts through `switchboard service`.

### Goal Invariants

- `src/services/LocalApiServer.ts` exposes `GET /settings` and authenticated `PUT /settings`; the PUT
  path delegates to a host-wired writer and contains no `_pendingServeMode` or `_pairingState`.
- Exactly one versioned host-settings schema exists at `src/services/hostSettings.ts`.
- Both `src/services/TaskViewerProvider.ts` and `src/standalone/bootstrap.ts` wire the same read/write
  contract into LocalApiServer and SetupPanelProvider.
- `src/webview/setup.html` contains one Host tab with workspace, port, serve-mode, PATH, source, and
  restart-status controls.
- `src/standalone/cli.ts` has a service startup path that reads the durable settings before
  `startHeadlessSwitchboard` and preserves explicit `local`/`tailnet` precedence.
- The browser deep link `#setup:host` and the VS Code `openSetupSection: host` message resolve to the
  same Host tab.
- No pairing write endpoint or process-private settings field is introduced.

### Manual Acceptance

1. Open Host settings from the browser shell, from the VS Code Setup command, and through the
   launcher deep link. Confirm all three show the same configured values and source labels.
2. Save port, serve mode, selected workspace, and PATH with no peer configured. Confirm the UI names
   the restart requirement and current runtime values do not pretend to change.
3. Restart the packaged service and confirm each saved value is consumed by the real startup path.
4. Run an explicit `switchboard tailnet --port <other-port> --workspace <other-root>` against
   conflicting saved defaults; confirm every explicit field wins and reports its source.
5. Open two settings windows, save from the first, then save stale state from the second. Confirm the
   second receives a conflict and does not overwrite the first.
6. Hand-edit an unrelated line in `/etc/switchboard/switchboard.env`, save a Host setting, and confirm
   the env file is byte-unchanged.
7. Remove a workspace from the catalog and confirm no workspace directory or board database is
   deleted.

## Resolved Assumptions

- Current systemd documentation confirms that prefixing an `EnvironmentFile=` path with `-` makes a
  missing file non-fatal, the file is read shortly before process execution, and non-prefixed
  `ExecStartPre=` commands complete before `ExecStart=`. The service's configured `User=` applies to
  both commands unless a command explicitly overrides credentials; this plan adds no such override.
- The application can deterministically prefer its user-owned document over inherited legacy
  environment values after process start. Systemd supplies inputs; `switchboard service` owns the
  per-field precedence and source reporting.
- Preserve the existing operator selected by `switchboard setup host`; do not introduce the generic
  dedicated `switchboard` account suggested by the research report. The current package resolves
  `SUDO_USER`/current user, its real home, and its drop-in explicitly.

## Recommendation

Send to Lead Coder. The plan is implementation-ready; the external systemd mechanics are resolved,
and migration behavior remains an implementation acceptance test rather than a research question.

## Implementation Summary

Implemented the host-settings schema, service, write path, and UI surface as specified. `src/services/hostSettings.ts` is the one versioned, atomic, revision-checked store at `~/.switchboard/host-settings.json`, with per-field source-tagged resolution honouring the explicit-CLI > durable > legacy-env > default precedence and a `StaleRevisionError` carrying the fresh state on conflict. `LocalApiServer` now exposes an authenticated `PUT /settings` (400 invalid, 409 stale, 503 unwired, 500 IO) and a durable-aware `GET /settings` that reports the configured-vs-effective split; both composition roots (`standalone/bootstrap.ts` and `TaskViewerProvider.ts`) wire the same `readHostSettings`/`writeHostSettings` contract and inject the shared service into `SetupPanelProvider`. The Setup panel gained a Host tab with source labels, restart messaging, and conflict retention, plus `#setup:host` (browser shell) and `openSetupSection: host` (VS Code) deep-link forwarding to the same tab. `switchboard service` reads durable settings before `startHeadlessSwitchboard`, applies PATH entries without shell evaluation, and preserves explicit `local`/`tailnet` precedence; `switchboard setup host` seeds the durable file for the service user without rewriting `/etc/switchboard/switchboard.env`, and the systemd unit's `ExecStart` now runs `switchboard service` while keeping the legacy env as a tagged fallback. No pairing state, no `_pendingServeMode`, no process-private settings fields were introduced.

## Review Findings

Fixed seven defects in `src/services/TaskViewerProvider.ts`, `src/services/SetupPanelProvider.ts`, `src/services/hostSettings.ts`, `src/standalone/bootstrap.ts`, `src/standalone/cli.ts` and `packaging/debian/switchboard.service`: the extension host guarded its Setup-panel injection on a lazily-populated field that nothing set at wiring time, so the Host tab answered "not wired" on every extension start and the durable `extraPath` never reached `process.env.PATH` before agents spawned — standalone wired the same seam eagerly, so the two composition roots had diverged exactly as this repo's precedent predicts. The Host tab also read with no resolution context, labelling a host launched as `switchboard tailnet --port 9000` "local (default) / 7777 (default)" in its own settings window; a malformed `SWITCHBOARD_PORT` was silently substituted with 7777 and still tagged `legacy-env`; `switchboard service` fell back to the process cwd when the selected workspace could not be resolved instead of failing before bootstrap as the plan requires; and the systemd unit still made the legacy env file mandatory (`EnvironmentFile` without `-`, plus hard `ExecStartPre` checks), so a host configured only through the Host tab could not start. The subtask had also broken the CI compile gate — `npm run compile-tests` (integration-tests.yml:53) failed with three type errors introduced by this commit — and shipped zero automated tests against a plan naming seven test groups, so no gate could discriminate on the core mechanism. Verification: `npm run compile-tests` and `npm run compile` now exit 0; new `src/test/host-settings-contract.test.js` (25 checks, wired as `test:contract:host-settings` in `package.json` and `.github/workflows/integration-tests.yml:521`) passes and was negative-control tested by reintroducing the legacy-port mislabelling, which turned it red; `catalog:check`, `parity:check`, `standalone-parity:check`, `deb-packaging`, `setup-panel-element-ids`, `panel-runtime-surface`, `shim-injection`, `broadcast-hub-headless`, all four `verb-engine` suites, `loopback-hostname`, `tailscale-bind`, `cross-client-scope` and `connections-routing` all pass. Remaining risk is runtime only: no test starts a real packaged service, so the `switchboard service` boot path and the relaxed `ExecStartPre` are proven by source-level assertion, not by a started unit.

## Deferred Findings

- NIT — `src/services/hostSettings.ts:441` — a durable `extraPath: []` falls through to the legacy env, so PATH additions cannot be cleared while `SWITCHBOARD_EXTRA_PATH` is set. The source label stays honest (`legacy-env`), so this is a usability gap, not a silent wrong value.
- NIT — `src/standalone/cli.ts:3231` — `service` creates `.switchboard/` in the process cwd before the durable workspace is resolved. Benign in the packaged case (the drop-in pins `WorkingDirectory` to the setup workspace), but it litters the old directory if the Host tab later selects a different root.
- NIT — `src/webview/setup.html:3810` — `getHostSettings` both returns in the verb body and pushes over the WS hub, so a browser Setup tab can render twice; a duplicate push arriving after a save would hide the restart banner. Cosmetic.
- NIT — `packaging/debian/switchboard.service:44` — `ExecStartPre` now short-circuits on the existence of the durable file rather than validating its contents. `switchboard service` performs the real per-field validation and names the failing field, so the unit still fails loudly, but the failure surfaces at `ExecStart` rather than `ExecStartPre`.
- MAJOR (runtime, not fixable here) — the plan's Manual Acceptance steps 3 and 6 (restart the packaged service and confirm each saved value is consumed; confirm the env file is byte-unchanged after a save) require a real Debian host and were not executed in this pass.
