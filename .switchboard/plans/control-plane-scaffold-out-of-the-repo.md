# Get the control-plane scaffold out of the repository

## Goal

Stop copying ~900K and ~60 files of extension-shipped control-plane content into every repository Switchboard touches. Move the authoritative copy into the store, keep only a gitignored, regenerable projection on disk for the agent hosts that discover capability by globbing the filesystem, and relocate the caches and machine-local JSON that have no business in a repo at all.

### Problem Analysis

Measured on this workspace:

| Path | Size | Files | Committed? | Nature |
| :--- | :--- | :--- | :--- | :--- |
| `.switchboard/plans/` | 43M | 1,984 | yes (gitignore-whitelisted) | user artifacts — stay |
| `.switchboard/features/` | 2.2M | 270 | yes (whitelisted) | user artifacts — stay |
| `.switchboard/sessions/` | 960K | 76 | yes (whitelisted) | runtime, mixed |
| `.agents/` | 744K | ~51 | **yes — not in `.gitignore`** | shipped control plane |
| `.claude/skills/` | 152K | 8 | **yes — not in `.gitignore`** | mirror of the same content |

The 46M is plans, and plans are project content that belongs in git. **The scaffolding problem is the other ~900K:** `.agents/{protocols,skills,workflows,personas,rules,scripts}` plus the `.claude/` mirror plus the root `AGENTS.md` / `CLAUDE.md` / `CONSTITUTION.md` blocks. Neither `.agents` nor `.claude` appears in `.gitignore`, so all of it is committed — and it is byte-identical in every workspace, because it is extension-shipped content, not user content. Duplicated across two directory trees, mirrored again into managed blocks in root markdown files, and re-copied on every scaffold.

**Two categories are sitting in the same directories and they need opposite treatment.** Control-plane *definitions* are the same everywhere, regenerable from the extension, and carry zero data-loss risk if deleted. User *artifacts* are project content, deliberately whitelisted, and irreplaceable. Today both are committed, so the second's legitimacy protects the first from scrutiny.

**Beyond the scaffold, the same directory carries three more things that should not be in a repo.** Enumerated from every `.switchboard/` path referenced in `src/`:

- **Machine-local JSON config, seven files, next to a database that already has `config` and `project_config` tables:** `config.json` (8 references), `settings.json` (4), `integration-config.json` (2), `kanban-state.json` (2), `kanban-state-backup.json` (2), `workspace_identity.json`, `.agent_version.json`.
- **Pure regenerable cache:** `planning-cache/{sourceId}/{docId}.md` and `planning-cache/clickup/documentIdMap.json` (5), `logs/` (2), `local-folder-cache.md` (2).
- **Dead instrumentation:** `feature-clobber-diagnostic.txt` (2) — the temporary diagnostic for the `is_feature` investigation, removed by that plan.

**And there is a filesystem message queue.** `instructions/standing`, `instructions/inbox`, and `instructions/claimed/<name>.claim` (19 references) implement work claiming through atomic file creation. It works, but `board_move_requests` and `job_runs` already exist as tables and are the right home for a queue in a product that ships a database.

### Root Cause

Scaffolding was designed for a world where the agent host reads the repository and nothing else exists. Because agent hosts genuinely do discover capability by globbing the filesystem, "put it on disk in the workspace" was correct for the *definitions*; because there was no global store at the time, "and commit it" followed by default. The store now exists (`~/.switchboard`, via `GlobalIntegrationConfigService`), so the second half of that decision is no longer forced.

### The constraint that shapes the design

**Agent hosts glob; they do not query.** Claude Code discovers skills by reading `.claude/skills/*/SKILL.md`. The harness reads `CLAUDE.md` / `AGENTS.md` at session start. The Antigravity protocol reads `.agents/workflows/*.md`. None of them asks the LocalApiServer — they enumerate the filesystem. A database cannot intercept that.

So the achievable goal is **out of the repository, not off the disk.** The store becomes authoritative; the on-disk tree becomes a derived, disposable projection that is gitignored and regenerated.

`api-server-port.txt` (33 references — the most-referenced non-artifact path in the whole directory) is the hard counterexample and must stay a real file: a CLI that has not connected yet has no way to discover the port except by reading it. Any "move everything into the store" framing has to carve that out explicitly.

### Non-goals

- Moving `plans/`, `features/`, `reviews/`, `docs/`, or `projects/` out of the repo. Those are the necessary MD files and they stay committed.
- Putting plan or feature **bodies** into the store. See the storage boundary rule below.
- Migrating the `instructions/` queue to tables. Identified here, scoped separately — it is a behaviour change to work claiming, not a scaffolding change.
- Changing the storage engine or consolidating databases (separate plans).

### Storage boundary rule

**The store may hold control-plane definitions as bodies. It must never become the sole home of a user artifact.**

The global-database and backup plans both rest on the DB being a derived index over committed markdown, so plan identity and relationships survive a total loss by re-ingesting the repo. Control-plane definitions are safe to hold as bodies because they are regenerable from the extension bundle. User artifacts are regenerable from nothing.

## Metadata

**Complexity:** 6
**Tags:** infrastructure, refactor, devops, database, reliability

## User Review Required

Yes — two decisions:

1. **Projection mechanism.** (a) Regenerate real files into a gitignored `.agents/` and `.claude/` at activation; (b) keep one copy in `~/.switchboard/control-plane/` and symlink per workspace; (c) hardlink from a content-addressed global store. Recommendation: **(a)**. It is the only option with no platform caveats — Windows symlink creation needs either Developer Mode or elevation, and you have Windows users. (b) saves disk as well as repo but buys a platform-support problem for a ~900K saving.
2. **Local override policy.** When a user hand-edits a projected file, does regeneration preserve it, clobber it, or refuse? Recommendation: preserve, by comparing content hash against the registry and skipping any file whose hash does not match what was last written. Clobbering someone's local protocol tweak is the failure mode that will get this reverted.

## Complexity Audit

### Routine

- Adding `.agents/` and the mirrored `.claude/` subtrees to `.gitignore`, and `git rm --cached` for the currently-tracked copies.
- Moving `planning-cache/`, `logs/`, and `local-folder-cache.md` to `~/.switchboard/cache/<workspace-id>/`.
- Deleting `feature-clobber-diagnostic.txt` generation (coordinate with the `is_feature` plan).
- A `control_plane` registry table: name, kind (protocol/skill/workflow/persona/rule), version, content hash, body, and a nullable per-workspace override.

### Complex / Risky

- **Regeneration must not clobber local edits, and must not silently drift either.** The two failure modes pull opposite ways: preserve too eagerly and a stale local copy shadows a shipped fix forever; preserve too little and you destroy a user's customisation. The hash-compare policy above needs a third state — "locally modified, shipped version differs" — surfaced in the UI rather than resolved silently.
- **Ordering against activation.** Agent hosts read these files at *session start*. If regeneration is async and a Claude Code session starts first, the session sees a missing or half-written skill tree. Regeneration must complete before the host is told the workspace is ready, or be atomic (write to a temp tree, rename into place).
- **Seven JSON files, ~40+ call sites, and a proven template.** `stateConfigBridge.ts` already did exactly this for `state.json`: its header records that "state.json no longer exists on disk" and that ~40 legacy call sites route through a facade to the `config` table at a single choke point. The remaining seven files are the same job. The risk is not the pattern — it is that each file has its own read/write call sites to inventory, and `integration-config.json` overlaps `GlobalIntegrationConfigService`, which is already machine-global (`AGENT_GLOBAL_FILE_KEYS` routes `startupCommands`, `visibleAgents`, `customAgents` there). Deciding per-key whether something is workspace-scoped or machine-global is the actual work.
- **`workspace_identity.json` vs `workspace-id`.** These overlap, and `workspace-id` is the one thing that *correctly* stays in the repo — repo holds identity, store holds state. Confirm which is load-bearing before touching either; `ensureWorkspaceIdentity` and `tryWriteCommittedWorkspaceId` are the call sites.
- **Uninstall and downgrade.** A user who removes the extension is left with a gitignored tree of orphaned files, and a user who downgrades gets a projection newer than their extension. The registry needs a version stamp the extension checks and refuses to read forward.

## Edge-Case & Dependency Audit

**Race conditions**
- Two VS Code windows regenerating the same projection: atomic temp-tree-plus-rename, and a per-workspace lock.
- An agent session reading the tree mid-regeneration: solved by the same atomicity, not by timing.

**Security**
- The projection is executable-adjacent: `.agents/scripts/` contains shell scripts agents invoke. Regenerating them from the store means the store's contents become a code-execution path. Bodies must come only from the extension bundle or a user-authored override, never from anything network-fetched, and the projected tree should not be writable by anything but the sidecar.

**Side effects**
- `git rm --cached` on `.agents/` shows up as a large deletion in the next commit for every user who tracks it. That needs saying in a release note, or it reads as data loss.
- `MultiRepoScaffoldingService` and `ControlPlaneMigrationService` both write parts of this tree; both become projection consumers rather than authors.
- `ClaudeCodeMirrorService` (`generateClaudeMirror`, `buildManagedInner`, `CLAUDE_BLOCK_START`/`END`) already owns managed-block generation into root markdown. It is the natural home for the projection writer — extend it rather than adding a parallel mechanism.
- Removing 900K and ~60 files from every repo also removes them from every agent's file-search surface, which is a modest context win nobody asked for but everybody benefits from.

**Migration**
- The scaffold shipped in released versions, so per the project rule: never unlink a file that might carry a local edit. Any projected file whose hash does not match the last-written value is preserved as `<name>.local.bak` before regeneration.
- `planning-cache` and `logs` are pure caches — safe to delete, but move rather than delete on first run so a user can recover if the relocation is wrong.
- Seven JSON files migrate import-before-delete, archived as `*.migrated.bak`, unknown keys preserved rather than dropped.

## Dependencies

- **Independent of the storage-engine work** — this plan needs a store, and the current one suffices. It could ship first, and probably should: it is the problem the user actually feels.
- **Interacts with the global-database plan**: if the store is already global, the registry lives there naturally. If this ships first, the registry lives in the per-workspace DB and migrates with everything else.
- **Coordinate with the `is_feature` plan** on deleting `feature-clobber-diagnostic.txt`.
- **Raises the stakes of the engine plan**: putting ~744K of control-plane bodies into a `sql.js` image is tolerable; it is also the first content the store has ever held, and the boundary rule above is what stops that becoming 43M.

## Adversarial Synthesis

**"900K is nothing — this is not worth a plan."** The byte count is not the complaint. Sixty files of identical machine-generated content committed into every repository is noise in every diff, a merge conflict surface on every extension upgrade, and a thing every contributor has to learn to ignore. And the plans directory being legitimately committed is what has kept the scaffold from being questioned — they share a parent, so the whole directory reads as "user content".

**"Put it all in the database and be done."** Cannot be done, and the reason is worth being precise about: agent hosts enumerate the filesystem rather than calling an API. `api-server-port.txt` — 33 references — is the sharpest illustration, since it exists specifically so a process that cannot yet talk to you can find out how. The achievable goal is out of the repo, not off the disk.

**"Regeneration will break someone's customised protocol."** The most likely way this gets reverted, which is why override preservation is a review gate rather than an implementation detail, and why the third state ("locally modified, shipped version differs") has to be visible instead of silently resolved.

**"The instructions/ queue should move in this plan too."** Tempting — it is the clearest misuse of the filesystem in the directory — but it changes work-claiming semantics under running agents. Scoped out deliberately, and noted so it is not lost.

## Proposed Changes

1. **`control_plane` registry table** — name, kind, version, content hash, body, nullable per-workspace override. Seeded from the extension bundle at activation.
2. **Projection writer**, extending `ClaudeCodeMirrorService`: renders the registry into `.agents/` and `.claude/` as an atomic temp-tree-plus-rename, before the workspace is announced ready. Skips any file whose on-disk hash does not match the last-written value, and reports it as locally modified.
3. **`.gitignore`**: add `.agents/` and the mirrored `.claude/` subtrees; `git rm --cached` the tracked copies, with a release note.
4. **Seven JSON files** migrated to `config` / `project_config` behind a `stateConfigBridge`-style facade, per-key decisions on workspace-scoped vs machine-global, archived as `*.migrated.bak`.
5. **Caches relocated** to `~/.switchboard/cache/<workspace-id>/`: `planning-cache/`, `logs/`, `local-folder-cache.md`.
6. **`MultiRepoScaffoldingService` / `ControlPlaneMigrationService`** become projection consumers rather than tree authors.
7. **Version stamp** on the registry so an older extension refuses a newer projection rather than misreading it.

### Migration

Import before delete, archive as `*.migrated.bak`, never unlink a file that may carry a local edit — any hash mismatch is preserved as `<name>.local.bak` first. Caches are moved rather than deleted on first run.

## Verification Plan

- **Repo footprint:** on a fresh scaffold, assert `git status` is clean and `git ls-files .agents .claude` returns nothing. Assert the projected tree exists on disk and every file matches the registry hash.
- **Host discovery:** with the projection in place, assert a Claude Code session discovers the expected skills, and the Antigravity workflow paths resolve. This is the acceptance test — the whole design rests on the projection being indistinguishable from a committed tree.
- **Atomicity:** start an agent session concurrently with regeneration, 50 iterations; assert the session never observes a missing or partial skill file.
- **Override preservation:** hand-edit a projected protocol, regenerate; assert the edit survives, the file is reported as locally modified, and a `<name>.local.bak` exists when the shipped version also changed.
- **Override staleness:** confirm a locally-modified file whose shipped version has changed is surfaced in the UI rather than silently kept.
- **JSON migration:** for each of the seven files, seed with known values including an unknown legacy key; migrate; assert every value readable through the new path, the unknown key preserved, and a `*.migrated.bak` present.
- **Cache relocation:** assert `planning-cache` reads resolve to the global location and the workspace copy is moved, not deleted.
- **`api-server-port.txt` untouched:** explicit regression test that it remains a real file at its current path and that the CLI scripts still find it.
- **Downgrade:** point an older extension at a newer registry; assert refusal with a clear message.
- **Uninstall:** assert the projected tree is identifiable as orphaned (a marker file) so cleanup is possible.

## Outstanding Questions

- Does any user actually customise `.agents/` content today? If yes, override preservation is the headline feature; if no, it is insurance and the plan gets simpler.
- Do `workspace_identity.json` and `.switchboard/workspace-id` both need to exist, or is one legacy?
- Is `sessions/` (960K, 76 files) user artifact or runtime state? It is gitignore-whitelisted like plans, which suggests artifact, but the name suggests runtime. This determines whether it stays committed.
- Should `.agents/scripts/` be projected at all, or invoked from the extension bundle directly? Projecting executables widens the code-execution surface for no obvious gain.
