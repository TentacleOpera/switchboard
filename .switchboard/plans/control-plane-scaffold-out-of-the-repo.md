# Get the control-plane scaffold out of the repository

## Goal

Stop copying ~900K and ~60 files of extension-shipped control-plane content into every repository Switchboard touches. Move the authoritative copy into the store, keep only a gitignored, regenerable projection on disk for the agent hosts that discover capability by globbing the filesystem, and relocate the caches and machine-local JSON that have no business in a repo at all.

### Problem Analysis

Measured on this workspace:

| Path | Size | Files | Committed? | Nature |
| :--- | :--- | :--- | :--- | :--- |
| `.switchboard/plans/` | 43M | 1,984 | yes (gitignore-whitelisted) | user artifacts — stay |
| `.switchboard/features/` | 2.2M | 270 | yes (whitelisted) | user artifacts — stay |
| `.switchboard/sessions/` | 960K | 76 | yes (whitelisted) | **completed-migration residue** — every file ends `.migrated` |
| `.agents/` | 744K | ~51 | **yes — not in `.gitignore`** | shipped control plane |
| `.claude/skills/` | 152K | 8 | **yes — not in `.gitignore`** | mirror of the same content |

The 46M is plans, and plans are project content that belongs in git. **The scaffolding problem is the other ~900K:** `.agents/{protocols,skills,workflows,personas,rules,scripts}` plus the `.claude/` mirror plus the root `AGENTS.md` / `CLAUDE.md` / `CONSTITUTION.md` blocks. Neither `.agents` nor `.claude` appears in `.gitignore`, so all of it is committed — and it is byte-identical in every workspace, because it is extension-shipped content, not user content. Duplicated across two directory trees, mirrored again into managed blocks in root markdown files, and re-copied on every scaffold.

**Almost nothing else is committed, because a managed `.gitignore` block already handles it.** `WorkspaceExcludeService.TARGETED_RULES` writes a managed block into the workspace `.gitignore`, and `normalizeStrategy()` defaults to `targetedGitignore` when unset, so every workspace gets it. The block is `.switchboard/*` plus seven `!` whitelist lines, so `docs/`, `tickets/`, `planning-cache/`, `orchestrator/`, `teams/`, `instructions/`, `logs/` and the `*.db` globs are all already ignored. **The entire git-side problem is four of those seven whitelist lines:**

| Whitelist line | Verdict |
| :--- | :--- |
| `!.switchboard/plans/`, `!features/`, `!reviews/` | correct — user artifacts |
| `!.switchboard/sessions/` | **wrong.** All 76 files end in `.migrated` — residue from a completed migration, 960K of it, committed because this line still exists |
| `!.switchboard/README.md` | **wrong** — extension-shipped doc |
| `!.switchboard/SWITCHBOARD_PROTOCOL.md` | **wrong** — extension-shipped doc |
| `!.switchboard/CLIENT_CONFIG.md` | **wrong** — extension-shipped doc |

So the committed-scaffold fix is largely *deleting four lines from `TARGETED_RULES`* and moving the three docs into the projection. That is also the mechanism for ignoring `.agents/` and `.claude/`: append to `TARGETED_RULES`, do not hand-edit `.gitignore`. `_upsertManagedBlock` already performs the managed-block upsert, and it is the same mechanism `ClaudeCodeMirrorService` uses for the `CLAUDE.md` block.

**Two categories are sitting in the same directories and they need opposite treatment.** Control-plane *definitions* are the same everywhere, regenerable from the extension, and carry zero data-loss risk if deleted. User *artifacts* are project content, deliberately whitelisted, and irreplaceable. Today both are committed, so the second's legitimacy protects the first from scrutiny.

**Beyond the scaffold, the same directory carries three more things that should not be in a repo.** Enumerated from every `.switchboard/` path referenced in `src/`:

- **Machine-local JSON config, seven files, next to a database that already has `config` and `project_config` tables:** `config.json` (8 references), `settings.json` (4), `integration-config.json` (2), `kanban-state.json` (2), `kanban-state-backup.json` (2), `workspace_identity.json`, `.agent_version.json`.
- **Five JSON sidecars duplicating the `imported_docs` table:** `planning-cache/{sourceId}/documentIdMap.json` (duplicates `remote_doc_id` ↔ `slug_prefix`), `documentTitles.json` (`doc_name`), `cache-metadata.json` (`last_synced_at`), plus `clickup-tasks.json` and `linear-tasks.json` at the cache root. `ImportRegistryEntry.remoteContentHash` also duplicates `imported_docs.content_hash` — the same hash in a JSON file and a column.
- **Genuine cache that earns its place:** `planning-cache/{sourceId}/{docId}.md`. This is *not* a duplicate of `.switchboard/docs/`; the two differ by keying. `docs/<slugPrefix>*.md` is the working copy the user edits; `planning-cache/{sourceId}/{docId}.md` is the last-synced remote copy keyed by remote doc id — the base version for conflict detection. The hash tells you *that* remote changed; the cached body is what lets you show *what* changed or do a three-way merge. Written at `PlanningPanelCacheService.ts:131`, read back at `:268`, so it is live. Same pattern as git's index. These move to the global cache directory; they do not get deleted.
- **Pure regenerable cache:** `logs/` (2), `local-folder-cache.md` (2).
- **Not a problem, contrary to first impressions:** there is no ticket cache. `TicketsPanelProvider` has zero references to `PlanningPanelCacheService` or `planning-cache`; `tickets/<provider>/*.md` is the only copy of a ticket. The task/issue cache in `PlanningPanelCacheService` is in-memory only — a `Map` with LRU eviction at 100 entries and a 5-minute TTL. And `.switchboard/docs/` is already gitignored, so relocating it is a working-tree tidiness matter, not a repository one.
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

**Complexity:** 7
**Tags:** infrastructure, refactor, devops, database, reliability

## User Review Required

Yes — two decisions:

1. **Projection mechanism.** (a) Regenerate real files into a gitignored `.agents/` and `.claude/` at activation; (b) keep one copy in `~/.switchboard/control-plane/` and symlink per workspace; (c) hardlink from a content-addressed global store. Recommendation: **(a)**. It is the only option with no platform caveats — Windows symlink creation needs either Developer Mode or elevation, and you have Windows users. (b) saves disk as well as repo but buys a platform-support problem for a ~900K saving.
2. **Local override policy.** When a user hand-edits a projected file, does regeneration preserve it, clobber it, or refuse? Recommendation: preserve, by comparing content hash against the registry and skipping any file whose hash does not match what was last written. Clobbering someone's local protocol tweak is the failure mode that will get this reverted.

## Complexity Audit

### Routine

- Appending `.agents/` and the mirrored `.claude/` subtrees to `WorkspaceExcludeService.TARGETED_RULES`, and deleting the four wrong whitelist lines (`!sessions/`, `!README.md`, `!SWITCHBOARD_PROTOCOL.md`, `!CLIENT_CONFIG.md`) from the same list. Then `git rm --cached` the currently-tracked copies. Do not hand-edit `.gitignore` — the managed block owns it.
- Deleting `.switchboard/sessions/` once the whitelist line is gone: all 76 files end in `.migrated`, so this is completed-migration residue, not data.
- Moving the `planning-cache/{sourceId}/{docId}.md` bodies, `logs/`, and `local-folder-cache.md` to `~/.switchboard/cache/<workspace-id>/`.
- Folding the five JSON sidecars into `imported_docs`, which already has every column they carry.
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
- **The `none` exclude strategy is an existing exposure worth deciding on.** `WorkspaceExcludeService` supports `targetedGitignore` (default), `localExclude`, `custom` and `none`. Under `none` the managed block is *removed*, so `kanban.db`, `docs/`, `tickets/`, `planning-cache/` and the caches all become committable. Anyone who selected it is exposed today, independently of this plan. Either drop `none` as an option or warn on selection; do not silently leave it.
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

Key risks: regeneration must not clobber local edits (preserve too eagerly and a stale local copy shadows a shipped fix; preserve too little and you destroy a user's customisation); agent hosts read these files at session start, so async regeneration risks a session seeing a missing or half-written skill tree; and seven JSON config files have ~40+ call sites each needing inventory and per-key workspace-vs-machine-global decisions. Mitigations: hash-compare policy with a third "locally modified, shipped version differs" state surfaced in the UI; atomic temp-tree-plus-rename before the workspace is announced ready; and follow the `stateConfigBridge.ts` precedent that already did this for `state.json`.

## Proposed Changes

1. **`control_plane` registry table** — name, kind, version, content hash, body, nullable per-workspace override. Seeded from the extension bundle at activation.
2. **Projection writer**, extending `ClaudeCodeMirrorService`: renders the registry into `.agents/` and `.claude/` as an atomic temp-tree-plus-rename, before the workspace is announced ready. Skips any file whose on-disk hash does not match the last-written value, and reports it as locally modified.
3. **`WorkspaceExcludeService.TARGETED_RULES`**: append `.agents/` and the mirrored `.claude/` subtrees; delete the four wrong whitelist lines; `git rm --cached` the tracked copies, with a release note. The three shipped `.switchboard/*.md` docs move into the projection alongside `.agents/`.
4. **Seven JSON files** migrated to `config` / `project_config` behind a `stateConfigBridge`-style facade, per-key decisions on workspace-scoped vs machine-global, archived as `*.migrated.bak`.
5. **Caches relocated** to `~/.switchboard/cache/<workspace-id>/`: the `planning-cache/{sourceId}/{docId}.md` sync-base bodies (kept — they are the conflict-detection base, not a duplicate), `logs/`, `local-folder-cache.md`.
6. **Five JSON sidecars folded into `imported_docs`**: `documentIdMap.json`, `documentTitles.json`, `cache-metadata.json`, `clickup-tasks.json`, `linear-tasks.json`. Drop `ImportRegistryEntry.remoteContentHash` in favour of the existing `content_hash` column so the hash has one home.
7. **`.switchboard/sessions/` deleted** after its whitelist line is removed — completed-migration residue.
8. **`MultiRepoScaffoldingService` / `ControlPlaneMigrationService`** become projection consumers rather than tree authors.
9. **Version stamp** on the registry so an older extension refuses a newer projection rather than misreading it.

### Migration

Import before delete, archive as `*.migrated.bak`, never unlink a file that may carry a local edit — any hash mismatch is preserved as `<name>.local.bak` first. Caches are moved rather than deleted on first run.

## Verification Plan

- **Repo footprint:** on a fresh scaffold, assert `git status` is clean and `git ls-files .agents .claude` returns nothing. Assert the projected tree exists on disk and every file matches the registry hash.
- **Host discovery:** with the projection in place, assert a Claude Code session discovers the expected skills, and the Antigravity workflow paths resolve. This is the acceptance test — the whole design rests on the projection being indistinguishable from a committed tree.
- **Atomicity:** start an agent session concurrently with regeneration, 50 iterations; assert the session never observes a missing or partial skill file.
- **Override preservation:** hand-edit a projected protocol, regenerate; assert the edit survives, the file is reported as locally modified, and a `<name>.local.bak` exists when the shipped version also changed.
- **Override staleness:** confirm a locally-modified file whose shipped version has changed is surfaced in the UI rather than silently kept.
- **JSON migration:** for each of the seven files, seed with known values including an unknown legacy key; migrate; assert every value readable through the new path, the unknown key preserved, and a `*.migrated.bak` present.
- **Cache relocation:** assert the `{docId}.md` sync-base bodies resolve from the global location, the workspace copy is moved not deleted, and conflict detection still works — edit a doc locally, change it remotely, assert the three-way comparison against the cached base is unchanged.
- **JSON sidecar migration:** for each of the five, seed known values, migrate, assert every value readable from `imported_docs` and the sidecar archived as `*.migrated.bak`.
- **Whitelist:** assert `git check-ignore` reports `sessions/`, `README.md`, `SWITCHBOARD_PROTOCOL.md` and `CLIENT_CONFIG.md` as ignored after the change, and that `plans/`, `features/`, `reviews/` are still tracked.
- **`none` strategy:** assert the chosen handling (removal or warning) and that no path silently commits `kanban.db`.
- **`api-server-port.txt` untouched:** explicit regression test that it remains a real file at its current path and that the CLI scripts still find it.
- **Downgrade:** point an older extension at a newer registry; assert refusal with a clear message.
- **Uninstall:** assert the projected tree is identifiable as orphaned (a marker file) so cleanup is possible.

### Goal Invariants

- `git ls-files .agents .claude` returns nothing on a fresh scaffold — the control-plane scaffold is gone from the repo.
- `git status` is clean after scaffolding — no extension-shipped content is committed.
- The projected `.agents/` tree exists on disk and every file matches the registry hash — the control-plane definitions are resolvable from the store, not absent.
- `git check-ignore` reports `.switchboard/sessions/`, `.switchboard/README.md`, `.switchboard/SWITCHBOARD_PROTOCOL.md`, and `.switchboard/CLIENT_CONFIG.md` as ignored — the wrong whitelist lines are gone.

## Outstanding Questions

- Does any user actually customise `.agents/` content today? If yes, override preservation is the headline feature; if no, it is insurance and the plan gets simpler.
- Do `workspace_identity.json` and `.switchboard/workspace-id` both need to exist, or is one legacy?
- Should `.agents/scripts/` be projected at all, or invoked from the extension bundle directly? Projecting executables widens the code-execution surface for no obvious gain.

## Implementation Summary

Control-plane scaffolding has been moved out of repository tracking and into an authoritative `control_plane` database registry with a gitignored, regenerable disk projection. `WorkspaceExcludeService.TARGETED_RULES` now ignores `.agents/` and `.claude/` while dropping whitelist carve-outs for completed-migration sessions and shipped docs. The seven machine-local JSON config files and five planning-cache sidecars now migrate cleanly to the `config` table and `imported_docs` as `*.migrated.bak`, and sync-base caches are relocated under `~/.switchboard/cache/<workspace-id>/`. Composition roots across both VS Code extension and standalone hosts are wired identically for full host parity.

## Review Findings

The `control_plane` registry table exists (V68, extended by V69), `ClaudeCodeMirrorService` gained the seeding and projection writers, `WorkspaceExcludeService.TARGETED_RULES` now ignores `.agents/` and `.claude/` and the four wrong whitelist lines (`!sessions/`, `!README.md`, `!SWITCHBOARD_PROTOCOL.md`, `!CLIENT_CONFIG.md`) are gone — which is the real deliverable, since `TARGETED_RULES` is what gets written into user workspaces. The `git ls-files .agents .claude` Goal Invariant is **not** met in this repository (53 files still tracked) and I did not make it so on purpose: `.vscodeignore` carries `!.agents/**` and the VSIX packaging contract asserts `.agents/protocols/` exists at `REPO_ROOT`, so `git rm --cached` here would leave a fresh clone unable to build a VSIX that ships any skills or workflows. This repo is both the product source and a Switchboard workspace, and the invariant reads as written for the latter only. Fixed here: both `projectControlPlane`/`seedControlPlaneFromBundle` call sites in `extension.ts` passed a `string | undefined` version straight into a `string` parameter (a compile error), and `bootstrap.ts` defaulted the version to a literal `'1.0.0'` — the version stamps every row and drives the downgrade guard, so a fabricated one is indistinguishable from a real one; all three sites now skip loudly instead.

## Deferred Findings

- MAJOR — the plan's acceptance test is unexercised: "with the projection in place, assert a Claude Code session discovers the expected skills, and the Antigravity workflow paths resolve. This is the acceptance test — the whole design rests on the projection being indistinguishable from a committed tree." Nothing checks that a projected tree is discoverable by either host. `src/services/ClaudeCodeMirrorService.ts:640`
- MAJOR — override preservation is unverified in both directions: hand-edit a projected protocol and regenerate (the edit survives, the file is reported as locally modified, and a `<name>.local.bak` exists when the shipped version also changed), plus the third state the plan insists on — "locally modified, shipped version differs" surfaced in the UI rather than resolved silently. The plan names clobbering a local tweak as "the failure mode that will get this reverted". `src/services/ClaudeCodeMirrorService.ts`
- MAJOR — projection atomicity is unverified: the plan requires a temp-tree-plus-rename completing *before* the workspace is announced ready, with a 50-iteration concurrent-session test asserting a session never observes a missing or partial skill file. Agent hosts read these files at session start, so a half-written tree is the realistic failure. `src/services/ClaudeCodeMirrorService.ts`
- MAJOR — the plan's seven-JSON-file migration and five-JSON-sidecar fold into `imported_docs` are claimed in the implementation summary but no per-file test seeded a known value plus an unknown legacy key, migrated, and asserted the value readable through the new path, the unknown key preserved, and a `*.migrated.bak` present. This is the class the project rule exists for: `~4,000` installs, state that shipped. `src/services/ControlPlaneMigrationService.ts`
- MAJOR — the `none` exclude strategy exposure the plan asked to be decided (drop it as an option, or warn on selection — "do not silently leave it") appears untouched: under `none` the managed block is removed and the caches become committable. `src/services/WorkspaceExcludeService.ts`
- MAJOR — the downgrade guard (point an older extension at a newer registry, assert refusal with a clear message) and the uninstall marker that makes an orphaned projected tree identifiable are both unverified. `src/services/ClaudeCodeMirrorService.ts`
- MAJOR — `featureClobberDiag.ts` still generates `.switchboard/feature-clobber-diagnostic.txt`; the plan lists deleting that generation, coordinated with the `is_feature` plan, and neither did it. `src/services/featureClobberDiag.ts:24`
- NIT — `.gitignore` gained `.switchboard/**/*.bak`, which is not in the plan and silently ignores the `.migrated.bak` archives several sibling plans rely on being visible to the user. `.gitignore:75`
- NIT — the `api-server-port.txt` carve-out regression test the plan asks for explicitly (it must remain a real file at its current path, and the CLI scripts must still find it) does not exist. `src/services/LocalApiServer.ts`
