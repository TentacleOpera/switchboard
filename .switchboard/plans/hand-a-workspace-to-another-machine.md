# Hand a Workspace to Another Machine

## Goal

Clone the repo on a second machine today and you get plan files and nothing else: every card lands in the default column with no project, no priority, no feature grouping, and none of your settings. The board state is in `kanban.db`, `kanban.db` is gitignored, and nothing else carries it.

Ship a **transfer bundle** — one versioned JSON file holding the shared board tier plus the portable settings — with an import that re-keys onto the destination machine and refuses to carry machine-local state. This is the *sequential handover* case (a machine retiring, a laptop being replaced, a remote box being set up), deliberately not the concurrent-sharing case that the shared-store plans own.

### Problem Analysis

**What git carries, and what it does not.** `.gitignore:60` is `.switchboard/*` with un-ignores for only `plans/`, `features/`, `reviews/`, `sessions/`, `CLIENT_CONFIG.md`, `README.md`, `SWITCHBOARD_PROTOCOL.md`. So a clone re-imports every plan through the watcher and reconstructs nothing else — column, project, priority, complexity, feature membership, and every setting are DB-only.

**The two existing exports do not close it.** `.switchboard/kanban-state-<column>.md` is export-only — nothing reads it back, `SparkContextExporter` calls it "a DB-exported mirror", and it is no longer un-ignored so it is not in git either. `BoardSnapshotPublisher`'s `board.json` is closer — its `BoardCardEntry` is the shared tier — but its payload is exactly `{schema, ordering, cards, features}`: **no settings at all**. A user who adopts it still retypes every prompt override, workflow mode and folder mapping.

**Copying `kanban.db` wholesale mostly works, and then poisons the destination.** Two portability landmines are already closed: `plan_file` is relative (the V17→V18 migration pair converted absolute→relative for exactly this), and `workspace_id` travels in the DB's own `config` table with V3's `UPDATE plans SET workspace_id = ?` unifying plans under it — so identity survives a different checkout path. What does *not* survive is everything that describes one machine:

| Carrier | Why it is wrong on the destination |
|---|---|
| `plans.dispatched_terminal` | names a terminal that exists only on the source machine |
| `plans.last_liveness_at` | asserts a process on the source machine is alive |
| `worktrees` rows | absolute paths on the source filesystem |
| `imported_docs` | stores absolute paths |
| `config.workspace_mappings`, `kanban.dbPath` | absolute paths |
| `config.terminals.groups`, `terminals.standingOrders` | seats and standing orders for terminals that do not exist here |
| ~30 `config.switchboard.prompts.terminals.*` keys | pane layouts, pinned panes, collapsed groups — per-machine UI state |
| `config.runtime.*` | live session, task and team state |

`split-shared-board-state-from-machine-local-runtime.md` states the consequence precisely: "machine A's board claims a card is dispatched to a terminal that exists only on machine B."

**And the volume is wrong.** The live database is 7.3 MB. Roughly 40% of it is `plan_events` (8,565 rows) which `the-plan-log-renders-start-stop-to-nobody.md` shows renders as `action=start` / `action=stop` and is unreachable outside one webview overlay. The shared tier a transfer actually needs is on the order of a couple of hundred kilobytes.

### Root Cause

Board state was never given a portable representation because it never had to leave the machine that produced it. Every serialiser built since — the per-column markdown, the board snapshot, `kanban-state-backup.json` — was built for a *reader* (an agent, a web session), never for a *destination that writes*. So all three are one-directional by construction, and none of them carries settings, because a reader does not need them.

> **Superseded:** "all three are one-directional by construction" — this is wrong for `kanban-state-backup.json`. `KanbanDatabase.restoreFromBackup()` (`KanbanDatabase.ts:9113`) is a live two-directional restore path, wired into the extension's DB-rebuild flow (`extension.ts:1630`). It already keys on `plan_file` (not `plan_id`), validates that the plan file exists on disk before restoring, and skips missing files rather than creating them — three of the four properties this plan proposes as novel for its import path.
> **Reason:** the claim that no existing serialiser writes back erased the one precedent that proves the approach works, and hid the fact that the new import path is reinventing an existing one. The distinction that actually matters is narrower: `restoreFromBackup` carries machine-local fields (`brain_source_path`, `mirror_path`, `routed_to`, `dispatched_agent`, `dispatched_ide` — all in its SELECT at `:9084-9088`), carries no settings, has no credential assertion, and is wired in the extension only (not standalone). It is a DB-rebuild tool, not a transfer tool.
> **Replaced with:** `kanban-state-backup.json` is the one existing serialiser that *does* write back, and its restore path already validates the key-on-`plan_file` / skip-missing / never-create contract this plan needs. The transfer bundle is not the first two-directional board serialiser — it is the first *clean* one: a curated field set that excludes machine-local state, plus a settings block, plus a credential self-assertion, wired in both hosts. The import should reuse `restoreFromBackup`'s matching logic (or share its plan-file resolution) rather than duplicating it, and the plan should flag that the existing backup's SELECT must be narrowed if the two paths ever converge.

### Non-goals

- **Concurrent sharing.** Two machines live at once needs arbitration; that is `git-carried-shared-board-state.md` (CAS via non-fast-forward rejection) and `libsql-shared-store-turso-and-self-hosted-sqld.md`. This plan is sequential handover and must not grow a sync loop.
- **Putting settings in the git-carried board snapshot.** `board.json` on the orphan branch is *shared* state read by teammates and by web-only agents. Personal-portable settings must never land there — a snapshot that carries one person's theme, status-bar layout and nudge thresholds imposes them on everyone who adopts it, and the snapshot is overwritten wholesale by whichever machine wrote last. If that snapshot ever grows a settings block it takes **team-shared only**, and that is a decision for `git-carried-shared-board-state.md`, not this plan. The classification here is built so that decision is a filter over an existing class rather than a re-derivation.
- **Secrets.** The bundle must never contain a credential — see the security section. Transferring secrets is a separate, manual, documented step.
- **Plan and feature bodies.** Already committed markdown. Only board state and settings travel.
- **Replacing `kanban.db` on the destination.** Import is an upsert onto whatever the watcher already built from the plan files, never a file swap.

## Metadata

**Complexity:** 6
**Tags:** feature, backend, database, reliability

## User Review Required

None. The transfer/sharing split is settled by the non-goals, the machine-local carrier list is enumerated from the schema, and the secrets posture (never in the bundle) is not a trade-off.

## Complexity Audit

### Routine

- Serialising the shared card fields — two shipped serialisers overlap on the shared tier (`BoardSnapshotPublisher`'s 7-field `BoardCardEntry`, `_writeKanbanStateBackup`'s 24-field SELECT). They do not agree on the set: the backup additionally carries machine-local fields (`brain_source_path`, `mirror_path`, `routed_to`, `dispatched_agent`, `dispatched_ide`) that the snapshot correctly excludes. The transfer bundle's field list should derive from `BoardCardEntry`'s clean set, not the backup's broader one.
- Writing and reading one versioned JSON file.
- Adding an export and an import entry point in both hosts.

### Complex / Risky

- **Classifying every `config` key as portable or machine-local.** There are 87 rows in the live DB and the split is not derivable from the key name alone: `switchboard.prompts.roleConfig_coder` is portable, `switchboard.prompts.terminals.paneAssignments` is not, and both start with `switchboard.prompts.`. Getting this wrong in the portable direction imports a dead terminal roster; getting it wrong in the local direction silently drops a user's prompt customisation. The classification must be an explicit allowlist with a default of *machine-local*, so an unrecognised key is never carried.
- **Re-keying on import.** The bundle must key cards by `plan_file` (relative, and the file itself is in git so it exists on the destination), never by `plan_id` — plan IDs are DB-assigned by the importer, so the destination has already minted its own for the same file. Matching on `plan_id` silently matches nothing and the import reports success having done nothing.
- **Import ordering against the watcher.** The plan watcher imports `.md` files on its own schedule. An import that runs before the watcher has ingested the files finds no rows to update. The import must either run after an explicit rescan or upsert-and-wait.

## Edge-Case & Dependency Audit

**Security — the bundle must never carry a credential.** Verified where secrets actually live: `EncryptedSecretsStore(stateFile('secrets.enc'), stateFile('.master-key'))` (`extension.ts:687`), i.e. `~/.switchboard/secrets.enc` + `~/.switchboard/.master-key`, both mode `0600`, outside any repository. The extension mirrors `vscode.SecretStorage` into that store so standalone can read tokens typed in the editor. `kanban.db` holds none: all 87 `config` rows were scanned for credential-shaped values and token prefixes with no hits, no `setConfig`/`setConfigJson` call site writes a token-named key, and `clickup.config` / `linear.config` are 59-byte `_migrated` husks left behind when credentials moved to the home store. `integration-config.json` is plaintext but holds only IDs, names and flags.

This is a property to *preserve*, not merely observe. The bundle is a file users will attach to messages and commit to repositories. The exporter must therefore assert its own output: fail the export if the serialised bundle matches a credential shape, rather than trusting the key allowlist to have been maintained. A bundle that is safe by construction beats one that is safe by review.

**Migration.** None. The bundle is a new artifact; no existing schema or config key changes shape. Import is additive.

**Idempotency.** Importing the same bundle twice must be a no-op. Keying on `plan_file` gives this for free; the settings apply is last-write-wins onto the same values.

**Partial match.** A card in the bundle whose `plan_file` does not exist on the destination (the plan was never committed, or lives on a branch not checked out) is reported and skipped, never created — creating it would fabricate a card with no file behind it, which is the ghost-feature failure `_regenerateFeatureFile` already refuses in its bodyless-husk guard.

**Host parity.** Export and import must be wired in **both** `src/extension.ts` and `src/standalone/bootstrap.ts`, per the standing rule in `CLAUDE.md` / `AGENTS.md`. Standalone is the likelier *destination* — a fresh remote box is exactly the case this plan serves — so a bundle it cannot import defeats the purpose. Two live instances of this divergence are already recorded: `standalone-arms-no-queue-watch.md`, and the telemetry-retention gap in `the-plan-log-renders-start-stop-to-nobody.md`.

**Relationship to `board-backup-and-per-project-export.md` (PLAN REVIEWED).** That plan owns per-project export/import *after* the global-store consolidation, with backup integrity and retention as its subject. This plan is narrower and lands earlier: one workspace, machine to machine, no consolidation prerequisite. If the two converge later, this bundle format should become that plan's per-project payload rather than a second format. Flag rather than merge — that plan is gated on work that has not started.

## Dependencies

- None blocking. `split-shared-board-state-from-machine-local-runtime.md` (New) enumerates the same shared/local boundary from the storage side; this plan needs the classification but not that plan's schema work, and the two should agree on the boundary. If that plan lands first, adopt its table classification verbatim rather than maintaining a second list.

## Adversarial Synthesis

Key risks. (1) Keying the bundle on `plan_id` produces an import that matches nothing and reports success — the single most likely way to ship this broken, because it works on the machine that exported it. (2) A config allowlist that defaults to *portable* imports a dead terminal roster and pane layout onto the destination, which is worse than importing nothing. (3) Exporting settings without asserting the output is credential-free means one future config key turns the bundle into a token leak, and the bundle is an artifact people attach and commit. (4) Wiring export/import in the extension only, when standalone is the likelier destination. (5) Duplicating `restoreFromBackup`'s plan-file matching logic instead of reusing it — two code paths that should agree will drift, and the existing path already carries machine-local fields the new one must exclude. Mitigations: `plan_file` is named as the key with the reason; the allowlist defaults to machine-local; the exporter self-asserts rather than trusting the list; both roots are named in the changes and in the verification; the import should share or reuse `restoreFromBackup`'s resolution logic, and the backup's SELECT must be narrowed if the two paths converge.

## Proposed Changes

### 1. The bundle format

One versioned JSON file, `switchboard-transfer.json`:

```jsonc
{
  "schema": 1,
  "exportedAt": "<ISO>",
  "sourceWorkspaceName": "<human label, informational only>",
  "cards": [
    { "planFile": "plans/foo.md", "column": "PLAN REVIEWED", "project": "Browser Switchboard",
      "complexity": "5", "isFeature": false, "featureFile": "features/bar.md", "tags": "…",
      "repoScope": "…", "priority": "…" }
  ],
  "settings": { "<allowlisted key>": "<value>" }
}
```

Cards key on **`planFile`** — relative, and the file is in git so it exists on the destination. Feature membership travels as `featureFile`, not `featureId`, for the same reason. No `plan_id`, no `session_id`, no `workspace_id` anywhere in the bundle.

### 2. Config classification — three stores, two axes, defaulting to machine-local

> **Amended — there are three settings stores, not one, and "portable" is two
> different questions.** The first draft allowlisted keys from the DB `config`
> table only. That is one store of three, and it silently assumed a single
> portable/local split.

**Three stores.** A classifier that covers one of them leaves a user retyping
settings the bundle claimed to carry:

| Store | Location | Size here | Standalone can write it? |
|---|---|---|---|
| DB `config` table | `kanban.db` | 87 rows | yes |
| **VS Code settings** | `.vscode/settings.json` / user settings | **86 contributed `switchboard.*` properties** | **no** — the shim's `update()` is a deliberate no-op |
| **Standalone config** | `.switchboard/config.json` | small (theme keys) | yes |

The VS Code store is the one most likely to be missed and the most dangerous to
carry wholesale, because its machine-specific entries are absolute paths:
`kanban.dbPath`, `kanban.controlPlaneRoot`, `workspaceDatabaseMappings`,
`archive.dbPath`, `stitch.defaultOutputFolder`, `research.*FolderPath*`,
`planner.designDocLink`, `workspaceBrainPaths`. Carrying `kanban.dbPath` in
particular is actively destructive: it points the destination at the *source*
machine's database location, which is the exact failure
`a-configured-db-path-may-not-be-where-the-board-is.md` documents.

That store is also already leaking uncontrolled — a committed
`.vscode/settings.json` was shipping one machine's paths to every clone until it
was untracked. So the bundle must not become a second, sanctioned copy of the
same mistake.

**Two axes, not one.** "Portable" answers a different question depending on the
destination, and the two destinations want different subsets:

| Class | Example keys | Transfer bundle (my other machine) | Shared board store (my teammate) |
|---|---|---|---|
| **Machine-local** | `kanban.dbPath`, `worktrees`, `terminals.groups`, all `switchboard.prompts.terminals.*`, `runtime.*` | never | never |
| **Personal-portable** | `theme.name`, `statusBar.*`, `activityLight.*`, retention windows | **yes** | **no** — my chrome is not my team's |
| **Team-shared** | `switchboard.prompts.roleConfig_*`, feature/epic workflow modes, `agents.customAgents`, `planScanner.intervalSeconds` | yes | yes |

A single portable flag cannot express this. Classify each key as one of the
three, and let each consumer take the classes it wants: the transfer bundle
takes personal-portable **plus** team-shared; a shared store takes team-shared
only. See the closing note on the git-carried board for why this matters there.

The classifier's default arm stays **machine-local** across all three stores. A
key added later is excluded until someone deliberately classifies it.

### 2b. The old single-axis list, retained as the team-shared/personal split

Portable (carry): `switchboard.prompts.roleConfig_*`, `feature_*` / `epic_*` workflow and mode flags, `kanban.dynamicComplexityRoutingEnabled`, `kanban.columnDragDropModes`, `agents.customAgents`, `agents.visibleAgents`, `planning.ingestionFolder`, `project_context_enabled`.

Machine-local (never carry): everything else, explicitly including `terminals.groups`, `terminals.standingOrders`, `terminals.agentGroups`, every `switchboard.prompts.terminals.*`, every `runtime.*`, `workspace_mappings`, `workspace_id`, `kanban.dbPath`, `kanban.featureWatches`, `folders.paths`, and the `_migrated` husks.

The classifier's default arm is **machine-local**. A key added later is excluded until someone deliberately adds it — the safe direction, since the failure mode of over-exclusion is "retype one setting" and the failure mode of over-inclusion is a poisoned destination.

### 3. Export

A command and an API route in both hosts. Writes the bundle to a path the user chooses; defaults next to the workspace, not inside `.switchboard/` (which is gitignored, and putting it there makes it invisible to the person meant to carry it).

> **Superseded:** "defaults next to the workspace, not inside `.switchboard/` (which is gitignored, and putting it there makes it invisible to the person meant to carry it)."
>
> **Reason:** that solves discoverability by making the bundle **committable**. A file at the repo root is not covered by any `.gitignore` rule, so the default location invites exactly the failure this plan made a non-goal one section earlier — personal-portable settings reaching shared git. It is the same mistake as the committed `.vscode/settings.json` that shipped one machine's absolute paths to every clone, in a new file and blessed by this plan. The credential self-assertion does not catch it, because the bundle is legitimately credential-free; the problem is one person's theme and thresholds landing in a repo their teammates clone.
>
> **Replaced with:** default **outside the repository** — alongside the other transfer artifacts in `~/.switchboard/transfer/`, which is where `secrets.enc` and `.master-key` already live and which no repo can commit. The export prints the absolute path so it is discoverable by being *told to the user*, not by sitting where git will pick it up. If the user explicitly names a path inside the repo, honour it and **warn once** that the file is committable and carries personal settings. Additionally, add `switchboard-transfer*.json` to the gitignore template the scaffolder writes, so a bundle deliberately placed in the tree is still ignored by default.

**Pre-flight: the bundle references files git has to deliver.** Cards key on
`planFile`, and the destination resolves those paths against files that arrive
through `git clone`. Any plan file that is untracked, modified-but-uncommitted,
or sitting in an unpushed commit will not be on the destination, so its card
silently lands in the "skipped — plan file not in this checkout" list. The user
reads that as data loss, and they are not wrong.

The export must therefore run `git status --porcelain` and `git log @{u}..HEAD`
over the plans and features directories first, and **refuse or warn loudly** with
the count and the paths. This is not a corner case: at the time of writing, this
very workspace has 1 untracked plan file and 17 unpushed commits touching
`.switchboard/plans/`. A transfer taken right now would arrive missing all of
them, and every gate in this plan would report success.

**Self-assertion before write:** scan the serialised bundle for credential shapes — the known token prefixes (`lin_api_`, `ghp_`, `github_pat_`, `sk-`, `xox[bp]-`, `ntn_`, `AIza`, `Bearer `) and long high-entropy strings in values. On a hit, **refuse to write** and name the offending key. This is the guard that survives the allowlist being wrong.

### 4. Import

Reads the bundle, then for each card resolves `planFile` against the destination's `plans` table:

- **Match** → update `kanban_column`, `project_id`, `complexity`, `tags`, `repo_scope`, priority, and feature link (resolving `featureFile` to the destination's own feature `plan_id`).
- **No match** → collect and report at the end. Never create.

> **Reuse note:** `KanbanDatabase.restoreFromBackup()` (`:9113`) already implements plan-file resolution, existence validation, and skip-on-missing. The import should call into the same resolution path (or extract a shared `resolvePlanByPlanFile` helper) rather than duplicating the logic. The existing `restoreFromBackup` creates records (`status: 'active'`, `lastAction: 'restored_from_backup'`); the transfer import is update-only — never create — so the shared helper must separate resolution from the create-vs-update decision.

Then applies the allowlisted settings. Reports a summary: cards updated, cards skipped with reasons, settings applied — **and settings excluded, by key**.

The exclusion list is not optional output. A misclassification in the machine-local direction is silent by construction: the import reports success having quietly dropped the thing the user most wanted. This is not hypothetical — during the manual dry run of this classification, `terminals.agentGroups` was misfiled as machine-local because it shares the `terminals.` prefix with `terminals.standingOrders` and `switchboard.prompts.terminals.groups`, both of which genuinely hold live terminal names. It holds none: it is role/count/scope plus prompt templates with `{child}` and `{head}` placeholders substituted at spawn time. Dropping it silently loses every tuned team prompt while the transfer reports as clean. Printing what was excluded is what makes that visible in the one second the user is looking at the output.

Machine-local fields on matched rows are left exactly as the destination has them — the import never writes `dispatched_terminal`, `last_liveness_at`, or any worktree row.

### 4b. What the user actually does, end to end

The shipped flow, so the seams are visible as a whole rather than per-change:

```
# old machine
$ switchboard export
  Wrote ~/.switchboard/transfer/switchboard-transfer.json
    42 cards · 29 settings · 0 credentials
  ⚠ 1 untracked plan file and 17 unpushed commits — push first or those cards
    will not resolve on the destination.

# move it across — scp, AirDrop, USB, cloud drive. Not this plan's business,
# but the export SHOULD print a ready-to-paste scp line, because "export, then
# somehow, then import" is where a user stalls.

# new machine
$ git clone <repo> && cd <repo>
$ npx switchboard
  No Switchboard database found.
    1) Create a new board       (~/.switchboard/kanban.db — recommended)
    2) Use an existing database (path)
    3) Import a transfer bundle (path)
  > 3
  ✓ 42 cards matched   ✓ 29 settings applied
  – 51 settings excluded (machine-local)
  Board ready → http://127.0.0.1:7777/?token=…
```

Then two things remain manual, both deliberately:

- **Re-authenticate**, or copy `secrets.enc` + `.master-key` (see change 5).
- **Start the team once**, so seats spawn and standing orders register against
  real terminal names. The team *definitions* travel in `terminals.agentGroups`;
  the bindings cannot.

Three commands, one path, one re-auth, one team start. That is the bar this plan
is measured against — not the count of things the bundle carries.

### 5. Document the secrets step separately

Secrets are not in the bundle and never will be. The transfer instructions state the manual step: copy `~/.switchboard/secrets.enc` and `~/.switchboard/.master-key` over a secure channel (both `0600`), or re-enter tokens on the destination via the Setup panel or `npx switchboard secrets set`. Two files, or five minutes of retyping — and for a team handover, retyping is the correct answer, since a shared credential is a worse outcome than a re-authentication.

## Verification Plan

### Automated

1. `npm run compile-tests` — clean.
2. New: round-trip. Build a source DB with cards in non-default columns, projects, complexity and feature links; export; build a *fresh* destination from the same plan files at a **different absolute path**; import; assert every card's column, project, complexity and feature link matches the source. The different path is the point — it is what proves the bundle is not carrying machine identity.
3. New: idempotency. Import the same bundle twice; assert the second import changes nothing.
4. New: machine-local exclusion. Give the source a populated `terminals.groups`, `switchboard.prompts.terminals.paneAssignments`, `workspace_mappings` and a `worktrees` row; assert none appear in the bundle and none are written on import.
5. New: unknown-key default. Add a config key the classifier has never seen; assert it is **not** exported.
6. New: the credential guard. Plant a token-shaped value in an allowlisted key; assert export **refuses** and names the key. Assert the refusal, not just the absence — a test that only checks the bundle is clean passes when the guard is missing.
7. New: unmatched card. Include a `planFile` with no file on the destination; assert it is skipped and reported, and that no row is created.
8. New: host parity — assert both `extension.ts` and `bootstrap.ts` wire export and import.
9. New: import reuse — assert the transfer import calls the same plan-file resolution helper as `restoreFromBackup` (grep both call sites for the shared symbol), and that the import never creates a row (update-only, unlike `restoreFromBackup` which creates).

**Gate wiring:** any new test file needs a `package.json` script **and** a step in `.github/workflows/integration-tests.yml`. A script defined but not invoked is the green-while-incomplete hole.

### Manual

10. Real handover: export from this workspace, clone the repo fresh at a different path, import, and confirm the board matches — columns, projects, complexities, feature grouping — with no terminals, worktrees or pane layout carried over.
11. Import into the **standalone** host and confirm parity with the extension.
12. Inspect a bundle by eye and confirm it contains no credential.

### Goal Invariants

- Assert `switchboard-transfer.json` contains no key named `plan_id`, `session_id`, or `workspace_id` at any depth (the bundle must not carry machine identity).
- Assert every `cards[].planFile` value in the bundle is a relative path (does not start with `/` or a drive letter).
- Assert no `cards[]` entry in the bundle contains keys `dispatched_terminal`, `last_liveness_at`, `brain_source_path`, `mirror_path`, `routed_to`, `dispatched_agent`, or `dispatched_ide` (machine-local fields are absent from the bundle).
- Assert the bundle contains a `settings` object with at least one allowlisted key when the source has personal-portable or team-shared settings configured.
- Assert `restoreFromBackup` and the transfer import share the same plan-file resolution helper (single function or method), verifiable by grep for the shared symbol name in both call sites.

## Recommendation

Send to Coder. The format is simple and the export is mechanical, but three decisions carry the whole thing and each fails silently if got wrong: key on `planFile` not `plan_id`, default the classifier to machine-local, and make the exporter assert its own output rather than trusting the allowlist.

---

## Implementation Summary

Shipped the transfer bundle as `src/services/TransferBundleService.ts` plus wiring in both composition roots. The service exports a versioned JSON bundle (schema 1) carrying the shared board tier (column, project, complexity, featureFile, tags, repoScope, priority) keyed by relative `planFile`, plus personal-portable and team-shared settings classified by a 3-class allowlist that defaults to machine-local. The exporter self-asserts its output against credential shapes (known token prefixes + high-entropy scan) and refuses to write on a hit; it also runs a git pre-flight (`git status --porcelain` + pathspec-filtered `git log @{u}..HEAD`) and warns with the count of untracked/unpushed plan+feature files. Default export path is `~/.switchboard/transfer/` (outside the repo); a path inside the repo earns a one-time committable warning. Import is update-only — it reuses `getPlanByPlanFile` for resolution, never creates a row, skips unmatched cards with reasons, links subtasks to features by `featureFile`, applies allowlisted settings, and prints the excluded settings by key. `restoreFromBackup` was narrowed to call `getPlanByPlanFile` and preserve machine-local fields from the existing row, so both restore paths share the resolution symbol. API routes (`POST /kanban/transfer/export|import`) live in the shared LocalApiServer route table; commands (`switchboard.exportTransferBundle|importTransferBundle`) are registered in both `extension.ts` and `bootstrap.ts`; `switchboard-transfer*.json` was added to the gitignore template. Compilation and tests were skipped per the run directives.

## Review Findings

Two CRITICALs: the service did not compile (six `TS2367` errors on `isFeature === true`), and the credential guard's raw 4.5-bits/char entropy threshold refused the export on this workspace's own data — nine of twenty-three portable keys, including every `roleConfig_*` prompt and `terminals.agentGroups`, are prose in the 4.55–4.77 band, while a 40-char hex token at 4.0 passed. Replaced with a shape-first token-run scan (24–512 chars, digits + letters, entropy ≥ 3.0, prefixes matched per run so an embedded token is caught). Ten MAJORs fixed: `restoreFromBackup`'s `getPlanByPlanFile` call was hoisted out of its open `BEGIN` (the cold-archive fallback calls `restoreToHot`, which opens its own transaction and would roll the whole restore back), its nine unbound record fields deleted and its `??` chain corrected to a non-empty test that re-relativises paths; both commands added to `contributes.commands` (they had no palette entry, so the extension shipped with no reachable entry point); `protocol-catalog.json` regenerated for the two new routes (`catalog:check` was red at CI line 26); `settingsExcluded` moved to `ExportResult` (the import's copy is empty by construction, so the plan's non-optional exclusion report never fired); a complexity equality guard for idempotency; and `partialFailures[]` so a rejected column or unresolved `featureFile` stops counting as a clean update. Files changed: `src/services/TransferBundleService.ts`, `src/services/KanbanDatabase.ts`, `src/extension.ts`, `src/standalone/bootstrap.ts`, `package.json`, `protocol-catalog.json`, `.github/workflows/integration-tests.yml`, and a new `src/test/transfer-bundle-contract.test.js` (11 passes covering Automated 2–9 and all five Goal Invariants, wired to `test:contract:transfer-bundle` in CI). Validation: `compile-tests` clean, eslint 0 errors, new suite green, plus `verb-engine-kanban`, `task-complete`, `plan-sync`, `native-project-api`, `db-backup-retention`, `goal-invariant-verification`, `card-priority-order`, `standalone-parity`, `parity`, `push-routing`, `verb-returns` all green; `mirror:check` (`.claude/skills/switchboard-remote/SKILL.md`) and one `create-feature.js` arm of `feature-file-subtask-link` are pre-existing reds from other commits and untouched here. Remaining risks: the §4b CLI (`switchboard export`) and the npx first-run "3) Import a transfer bundle" menu option are not implemented — only the palette commands and the two API routes are; the standalone host has no file picker, so its import needs an explicit path; and commit 3f2a4066 also flipped `worktrees`/`uat` to `true` in `baseStandaloneCapabilities`, which is another plan's scope riding along in this commit and was left in place rather than reverted.
