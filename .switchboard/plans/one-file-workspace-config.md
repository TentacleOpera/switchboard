# One File Configures a Workspace, and It Is the File the Docs Show

kanbanColumn: CREATED

## Goal

A single declarative file expresses a complete working Switchboard setup — where the board lives,
which CLIs seat which roles, which tracker, which serve mode. It is what the documentation shows, it
is what you copy to a second machine, and it is diffable in git.

### Problem analysis

**Configuration currently lives in five places, and no single one can describe a working install.**

```
package.json contributes    88 VS Code settings
config table                in the board database
integration-config.json     global, machine-wide
/etc/switchboard/switchboard.env   what systemd reads
.switchboard/config.json    per workspace
```

A new user cannot see their setup, cannot copy it, and cannot tell which store answered a given
question. An experienced one cannot either — tonight established that `linear.config` in the
database can hold nothing but `{"_migrated":true}` while a working credential sits in the encrypted
store, so *"is Linear configured?"* is unanswerable from any single file.

**The nearest comparable tool does this in one file.** Sortie's whole configuration is a
`WORKFLOW.md` — YAML frontmatter for tracker kind, credentials, `query_filter`, `agent.kind` and
`max_concurrent_agents`, with the body as the templated prompt. Switching agent is described as
*"a one-line change"*. Whatever else differs between the products, that is a better onboarding
artefact than 88 settings across five stores, and it is the difference between a README that shows a
config and a README that describes a UI tour.

**This matters most for the goal of getting people to try it.** Every question a first-run flow has
to ask is a question a file could have answered, and every setup that cannot be copied is a setup
that has to be rebuilt on the second machine.

**The hazard is obvious and must be designed against.** A sixth configuration store that competes
with the five is worse than the five. This codebase's most-cited defect class is a value whose
source cannot be identified after the fact.

> **Superseded:** "Configuration currently lives in five places" — the enumeration omits a sixth
> store that already shipped and already covers the `board:` block this plan proposes.
> **Reason:** `src/services/hostSettings.ts` defines a versioned, atomically-written, source-tagged
> durable document at `~/.switchboard/host-settings.json` (`stateFile('host-settings.json')`), wired
> into both composition roots (`src/standalone/bootstrap.ts:1443` constructs and injects it into
> `SetupPanelProvider` and `LocalApiServer`; `src/services/TaskViewerProvider.ts:2158`/`5067` does
> the same in the extension host). It already holds `port`, `serveMode`, the workspace catalog
> (`workspaces` + `defaultWorkspaceId`), and `extraPath`, and `GET /settings`
> (`src/services/LocalApiServer.ts:11963`) already reports a per-field `source` label for each with
> precedence explicit-CLI → durable → legacy-env → tagged-default. The plan's `board: { location,
> port, serve }` block is a YAML projection of a JSON document that already exists, validates, and
> round-trips through the settings window the plan references as `307d08aa`.
> **Replaced with:** Configuration lives in **six** places. The sixth — `~/.switchboard/host-settings.json`
> — is the one this plan's `board:` block most directly overlaps. The file model chosen here (see
> Proposed Changes) treats the existing stores as **machine-global fallback** for keys the file
> omits, so the file is additive rather than a competing seventh store. The five-store framing is
> retained above verbatim per content-preservation but is superseded by this callout and the Proposed
> Changes.

## Metadata

- **Complexity:** 7
- **Tags:** ux, cli, infrastructure, feature, docs

> **Superseded:** Complexity 6.
> **Reason:** The plan must coordinate with an already-shipped durable store
> (`host-settings.json`) it originally did not know existed — extending its source vocabulary and
> precedence, not greenfield. It also spans both composition roots, a settings-window round-trip,
> the machine-global `integration-config.json` (for `agents:`/`tracker:`), and the docs. That is
> multi-store coordination against released state, not two moderate additions.
> **Replaced with:** Complexity 7 — route to a Lead Coder.

## User Review Required

None. The model is decided: the file is workspace-local config, the UI edits the file, and the
existing stores stay as machine-global fallback for keys the file omits. No migration of existing
stores — the file is additive. All three blocks (`board:`, `agents:`, `tracker:`) are in scope
because the Goal names them ("which CLIs seat which roles, which tracker").

## Complexity Audit

### Routine

- Parse one YAML file at the workspace root (the codebase already consumes YAML in
  `src/services/PlanningPanelProvider.ts` and `DesignPanelProvider.ts` — confirm which library is
  vendored before adding a dependency).
- Map the `board:` block onto the existing `HostSettingsDocument` fields (`port`, `serveMode`,
  `workspaces`, `extraPath`) — the schema and validation already exist in
  `src/services/hostSettings.ts:218-280`.
- Show the file in the README, first-run flow, and Pi install guide.

### Complex / Risky

- Insert the file as a new workspace-local precedence layer in `HostSettingsService.resolve()`
  (`src/services/hostSettings.ts:395-530`) without disturbing the existing explicit-CLI → durable →
  legacy-env → default chain — the file sits between explicit CLI and the durable store, and only
  for keys the file declares.
- Make the settings UI write back to the file (when a file exists) rather than to
  `host-settings.json`, so the file and the UI are one truth, not competing writers. When no file
  exists, the UI continues to write to the stores (current behavior).
- Extend the `SourceLabel` union (`src/services/hostSettings.ts:43-49`) with
  `'switchboard.yaml'` and thread it through `buildResolution` so `GET /settings` reports the file
  as the source for declared keys.
- Wire the file reader into **both** composition roots at a named seam; a missing seam must be
  visible, not silent — the standing `standalone-arms-no-queue-watch.md` defect class.
- Add per-workspace agent and tracker config as new capability (the `agents:` and `tracker:`
  blocks), with the file overriding the machine-global `integration-config.json` for declared keys.
  This is net-new scope, but it is the scope the Goal explicitly names.
- Reject token-shaped keys loudly (the file is an artifact people paste into issues and commit).
- Surface a malformed file through the same loud-failure channel the existing stores use
  (`HostSettingsError` code `'corrupt'`), not a `console.error` nobody reads.

## Edge-Case & Dependency Audit

### Race Conditions

- The file is read at runtime (not applied once at startup), so there is no startup-apply race
  against `PUT /settings`. The file is the source for declared keys; the stores are the source for
  omitted keys; the two do not compete for the same key.
- If the operator edits the file by hand while the UI is open, the UI's next read sees the new
  values. The UI does not cache the file across saves. A UI save writes the file atomically
  (temp-write + rename), so a half-written file is never observed by the runtime.
- File writes are serialized through the same in-process write discipline
  (`src/services/hostSettings.ts:309` `_writeChain` pattern) so a concurrent UI save and a hand-edit
  cannot interleave.

### Security

- **No secrets, ever.** Tokens stay in the encrypted store (`EncryptedSecretsStore` at
  `~/.switchboard/secrets.enc` + `.master-key`, per `hand-a-workspace-to-another-machine.md`). The
  file names *which* tracker, not how to authenticate to it. A contract test must fail if a
  token-shaped key is accepted; the loader should self-assert its parsed output is credential-free
  (the bundle exporter in `hand-a-workspace-to-another-machine.md` already sets this precedent —
  safe-by-construction beats safe-by-review).
- The file is committable and pasted into issues; treat unknown keys as preserved-but-ignored, never
  evaluated.

### Side Effects

- A file present at startup does not modify the existing stores. The stores keep their values; the
  file simply wins for the keys it declares. Removing the file restores the stores as the
  authority — no cleanup, no migration back.
- Adding a key to the file shadows the store's value for that key. The store's value is not
  deleted; it is simply not read while the file declares the key. This is reversible: delete the
  key from the file, the store's value answers again.
- The `agents:` and `tracker:` blocks introduce per-workspace agent routing and tracker config
  where none existed (both are machine-global in `integration-config.json` today). A workspace
  with `agents.coder: { cli: devin }` seats `devin` as coder for that workspace only; other
  workspaces on the same machine are unaffected.

### Dependencies & Conflicts

- **Both hosts read it.** A file honoured by standalone and ignored by the extension is worse than
  no file. The injection seam must be named in both `src/standalone/bootstrap.ts` and
  `src/services/TaskViewerProvider.ts` (the two roots that already wire
  `createHostSettingsService`). Verify by reading both roots — and by asserting the seam at the
  source level, not just the verb reach (the `standalone-arms-no-queue-watch.md` lesson: the
  `default:` arm delegates every verb, so verb-reachability audits always pass while the seam is
  unwired).
- **It is not the transfer bundle.** `hand-a-workspace-to-another-machine.md` carries board
  *state* — plans, projects, priorities — in `switchboard-transfer.json`. This carries
  *configuration*. Both are portable and they are not the same thing; say so in each. The transfer
  bundle's settings block and this file's `board:` block both touch `host-settings.json`-owned
  fields and must agree on the field set, or the two portable artifacts will fight over the same
  keys.
- **Unknown keys are preserved, not dropped.** A file written by a newer version and read by an
  older one must survive a round trip through the settings window — `host-settings.json` already
  preserves unknown keys (`src/services/hostSettings.ts:275-278`); the yaml loader and the UI
  write-back must do the same.
- **A malformed file fails loudly at startup.** It must never be read as "unconfigured" — that is
  the `catch { return {} }` defect (`GlobalIntegrationConfigService.loadGlobal` at
  `src/services/GlobalIntegrationConfigService.ts:120-123` returns `{}` on parse failure, the exact
  silent-fallback pattern to avoid). Surface through `HostSettingsError` code `'corrupt'`.
- **Do not migrate the 88 VS Code settings here.** That is the sidebar plan's stage 4. This layer
  sits above whatever those become.

## Dependencies

- No external session dependency. Internal dependency on the shipped `host-settings.json` store
  (`src/services/hostSettings.ts`), the machine-global `integration-config.json` store
  (`src/services/GlobalIntegrationConfigService.ts`), and the settings window
  (`src/services/SetupPanelProvider.ts`, plan
  `settings-window-and-the-write-path-review-deleted.md`) — all already wired in both roots.

## Adversarial Synthesis

Key risks: (1) the file and the UI become competing writers if the UI writes to the stores while the
file declares the same keys — the file shadows the store, the UI edit vanishes on next read;
mitigation: the UI writes to the file when a file exists, so the two are one truth. (2) A value
from the file reports `source: 'durable'` on `GET /settings` if the new source label is not threaded
through `buildResolution`, making "which store answered?" unanswerable; mitigation: add
`'switchboard.yaml'` to `SourceLabel` and report it. (3) The reader is wired in one root only and
the gates stay green; mitigation: name the injection seam in both composition roots and assert it at
the source level. (4) `agents:`/`tracker:` are net-new per-workspace scope that changes agent
routing semantics; mitigation: the Goal explicitly names this scope, the file is additive (omitted
keys fall through to machine-global), and the per-workspace override is reversible by deleting the
key.

## Proposed Changes

### 1. `switchboard.yaml` at the workspace root — declarative, partial, and optional

One file, checked into the repo if the operator wants, holding what a setup actually needs:

```yaml
board:     { location: ~/.switchboard, port: 7777, serve: tailnet }
agents:
  lead:     { cli: claude, startup: "claude --permission-mode bypass" }
  coder:    { cli: devin }
  reviewer: { cli: claude, host: tower }        # host: the SSH-seat card
tracker:   { kind: linear, project: Switchboard, import: "label:agent-ready" }
```

**Partial is normal.** A file declaring only `board.port` is valid; everything it omits resolves
exactly as it does today (from the existing stores). This is not a migration of the six stores — it
is a workspace-local layer that can express any subset, with the stores as fallback for the rest.

**The file is the config, the UI is its editor.** When a file exists, the settings window reads
from it (for declared keys) and writes back to it. The file and the UI are one truth, not competing
writers. When no file exists, the UI reads from and writes to the stores as it does today. The
window offers "export to `switchboard.yaml`" — a one-shot write of the current resolved values to
the file — and from then on, the UI edits the file.

**Credentials are never in it.** Tokens stay in the encrypted store. The file names *which* tracker,
not how to authenticate to it — `integration-config.json`'s corruption history is reason enough not
to put a secret in a file people will paste into issues.

**`agents:` and `tracker:` are net-new per-workspace scope.** No per-workspace agent or tracker
config exists today — both are machine-global in `integration-config.json` by design
(`GlobalIntegrationConfigService` docstring: agent config is "shared across every workspace AND
every IDE"). The file introduces per-workspace override for declared keys: a workspace with
`agents.coder: { cli: devin }` seats `devin` as coder for that workspace only. Omitted keys fall
through to the machine-global store. This is the scope the Goal names ("which CLIs seat which roles,
which tracker"), not configuration cleanup.

### 2. Precedence, decided and reported

> **Superseded:** "The order, most specific first: an explicit CLI flag → `switchboard.yaml` → the
> existing stores → the built-in default."
> **Reason:** The original order was correct in spirit but written without knowing
> `host-settings.json` exists, and without specifying that the UI writes to the file (not the
> stores), which is what prevents the file from becoming a competing seventh store.
> **Replaced with:** The order, most specific first: **an explicit CLI flag → `switchboard.yaml`
> (for declared keys only) → the existing stores (`host-settings.json`, `integration-config.json`)
> → the built-in default.** The file is read at runtime, not applied once at startup. For keys the
> file declares, the file wins and the stores are not consulted. For keys the file omits, the stores
> answer as they do today. The UI writes to the file when a file exists (so the file stays the truth
> for what it declares), and to the stores when no file exists (current behavior).

Every read reports which layer answered, extending the `source` vocabulary `GET /settings` already
has (`SourceLabel` at `src/services/hostSettings.ts:43-49`). The new label `'switchboard.yaml'` must
be named explicitly in the `SourceLabel` union and threaded through `buildResolution`
(`:395-530`) — a source vocabulary you do not define is a source vocabulary you do not have. "Which
store answered?" must be answerable after the fact, for every value, or this becomes the seventh
store rather than the front door.

### 3. The settings window writes it back

`307d08aa` gives the operator a UI (`src/services/SetupPanelProvider.ts`, wired to
`HostSettingsService` in both roots). This gives them a file. They must be the same configuration
seen two ways:

- When a `switchboard.yaml` exists, the window reads declared keys from the file and omitted keys
  from the stores, shows the merged view with the file named as the source for declared keys, and
  on save writes back to the file (not the stores).
- When no file exists, the window reads and writes the stores as it does today.
- The window offers "export to `switchboard.yaml`" — a one-shot write of the current resolved
  values to the file. From then on, the UI edits the file.

Two surfaces that cannot round-trip is how the seventh store appears. The file and the UI are one
truth: the UI is the file's editor, not a competing writer.

### 4. It is what the documentation shows

The README, the first-run flow and the Pi install guide all show the file. A user who reads any of
them ends up with something they can copy, diff and paste into an issue when asking for help.

This is the actual deliverable. The parser is straightforward; making it the documented path is the
change.

### 5. `src/services/hostSettings.ts` — add the file as a precedence layer and source

- **Context:** `host-settings.json` already ships as the versioned, source-tagged, atomically-written
  durable document for `board:` fields, wired in both roots. The file is a new workspace-local
  layer above it for declared keys.
- **Logic:** Add `'switchboard.yaml'` to the `SourceLabel` union (`:43-49`). Extend
  `HostSettingsContext` with an optional `workspaceConfigFile: { path: string; values: Partial<HostSettingsDocument> }`
  field. In `buildResolution` (`:395-530`), check the workspace file before the durable store for
  each field — if the file declares the key, the file wins and the source is `'switchboard.yaml'`;
  if not, fall through to the existing durable → legacy-env → default chain unchanged.
- **Logic:** Add a `readWorkspaceConfigFile(workspaceRoot)` helper that parses
  `<workspaceRoot>/switchboard.yaml`, validates the `board:` subset against the existing
  `validateDocument` (`:218-280`), and returns the declared keys. A missing file returns `null`
  (no override); a malformed file throws `HostSettingsError` code `'corrupt'`.
- **Edge Cases:** A malformed file throws `HostSettingsError` code `'corrupt'` with the YAML line,
  surfaced through the same loud channel as a corrupt `host-settings.json` (`:300-301`); it is
  never read as "unconfigured". A token-shaped key in the `board:` subset is rejected with a message
  naming the secret store. Unknown keys are preserved, not dropped (`:275-278` precedent).

### 6. `agents:` and `tracker:` — per-workspace override against `integration-config.json`

- **Context:** `agents.startupCommands`, `agents.visibleAgents`, `agents.customAgents` and Linear
  `includeProjectNames` are machine-global in `~/.switchboard/integration-config.json`
  (`src/services/GlobalIntegrationConfigService.ts`). No per-workspace agent or tracker config
  exists today.
- **Logic:** Extend `readWorkspaceConfigFile` to parse the `agents:` and `tracker:` blocks. At the
  read sites that consult `GlobalIntegrationConfigService` for agent startup commands and tracker
  config, check the workspace file first; if the file declares the key, the file wins for this
  workspace, and the source is `'switchboard.yaml'`; if not, fall through to the machine-global
  store. The machine-global store is unchanged — the file is additive, per-workspace.
- **Edge Cases:** A workspace with `agents.coder: { cli: devin }` seats `devin` as coder for that
  workspace only; other workspaces on the same machine keep the machine-global coder. Deleting the
  key from the file restores the machine-global value. `tracker.import` (a query filter) is a new
  field with no existing store equivalent — it is owned by the file and has no fallback.

### 7. Both composition roots — wire the reader at a named seam

- **Context:** `src/standalone/bootstrap.ts:1443` and `src/services/TaskViewerProvider.ts:2158`/`5067`
  already construct and inject one `HostSettingsService` per host lifetime.
- **Implementation:** In both roots, after `createHostSettingsService()`, read
  `<workspaceRoot>/switchboard.yaml` (if it exists) and pass the parsed values into the
  `HostSettingsContext` as `workspaceConfigFile`. The seam is the same place
  `hostSettingsService` is constructed and the context is built — name it in both files. A missing
  file is a no-op (context has no `workspaceConfigFile`); a present file supplies overrides.
- **Edge Cases:** Add a source-level parity assertion (the `standalone-arms-no-queue-watch.md`
  lesson) that both roots read the workspace file and pass it into the context at the named seam.
  A missing seam must be visible — the file is silently ignored — not green-gated. Do not rely on
  the standalone `default:` verb arm delegating to the provider; that arm makes verb-reachability
  audits pass while the seam is unwired.

## Verification Plan

### Automated Tests

1. A workspace with only `switchboard.yaml` and no other configuration starts a board on the
   declared port, in the declared serve mode, with the declared roles seated.
2. A file declaring one key changes only that key; everything else resolves as before (from the
   stores).
3. Every value's source is reportable, and a value from the file reports `source:
   'switchboard.yaml'`.
4. A CLI flag overrides the file for that run, and the reported source says so.
5. Copying the file to a second machine reproduces the setup, with no secrets carried.
6. A token-shaped key in the file is rejected with a message naming the secret store.
7. A malformed file stops startup with a parse error naming the line — it is never treated as absent.
8. Round-tripping through the settings window preserves unknown keys.
9. Both hosts honour the file, verified by reading both roots and by a source-level seam assertion.
10. The settings UI writes to the file when a file exists, and to the stores when no file exists.
11. Deleting a key from the file restores the store's value for that key (the override is
    reversible).
12. A workspace with `agents.coder: { cli: devin }` seats `devin` for that workspace only; another
    workspace on the same machine keeps the machine-global coder.

### Goal Invariants

- `src/services/hostSettings.ts` `SourceLabel` union contains the literal `'switchboard.yaml'`, and
  `buildResolution` threads it for fields the file declares.
- Exactly one `switchboard.yaml` reader exists, and it is invoked at a named seam in both
  `src/standalone/bootstrap.ts` and `src/services/TaskViewerProvider.ts` (assertable by grep of the
  `readWorkspaceConfigFile` / `workspaceConfigFile` call at the construction site in each root).
- A workspace with only `switchboard.yaml` present and no `host-settings.json` starts a board whose
  `GET /settings` response reports `source: 'switchboard.yaml'` for the declared `board:` fields.
- No `switchboard.yaml` parse path returns `{}` on a malformed file (assert the corrupt branch
  throws `HostSettingsError` code `'corrupt'`); the `catch { return {} }` pattern is absent from the
  new reader.
- A token-shaped key in `switchboard.yaml` is rejected before any runtime read (assert no
  `host-settings.json` or `integration-config.json` write occurs on a file containing a
  `*_token`/`*_secret`/`*_key` field).
- The settings UI, when a `switchboard.yaml` exists, writes to the file (assert the file's content
  changes on save and `host-settings.json`'s `revision` does not).
