# The bundle ledger is extension bookkeeping written into the user's repository, and it belongs in the database

## Goal

Move the control-plane bundle ledgers out of `.agents/` and `.claude/` and into `kanban.db` config
rows, so nothing the extension writes for its own bookkeeping lands in a user's version-controlled
tree. Pair it with the missing empty-bundle guard, which becomes more dangerous once the ledger is
reliably present.

### Problem Analysis

**Two ledgers are written into workspace directories users commit.**
`.agents/.switchboard-bundled.json` (`ControlPlaneMigrationService.ts:1407-1415`, constant at
`:1053`) and `.claude/.switchboard-generated.json` (`ClaudeCodeMirrorService.ts:415-419`) record
which paths the bundle shipped, so `pruneRetiredBundleFiles` can delete a file the bundle has retired
without touching user-authored files. That discrimination is genuinely needed — the seed loops only
add and overwrite, never delete, so without it "a skill removed from the bundle strands in every
workspace's `.agents/` forever."

**They churn on every activation.** Both are rewritten with a fresh
`generatedAt: new Date().toISOString()` (`ControlPlaneMigrationService.ts:1410`,
`ClaudeCodeMirrorService.ts:410`), and **nothing reads that field** — the only value consumed from
the `.agents` bundle ledger is `parsed.files` (`ControlPlaneMigrationService.ts:1164`); the `.claude`
manifest's `skills` array is read at `ClaudeCodeMirrorService.ts:390-393`. So every user whose
project is a git repository carries a permanently-modified file that the extension created, that
they did not ask for, and that they cannot stop without writing their own ignore rule.

**The blocklist already says they do not belong to the tree.** `AGENT_COPY_BLOCKLIST`
(`ControlPlaneMigrationService.ts:1042-1048`) excludes the ledger from the bundle with the comment
that it is "generated at runtime into each workspace's `.agents/`, never bundled." It is already
understood as runtime state; it is simply stored as workspace content.

**A database is resolvable by the time seeding runs — which is not the same as one sitting in the workspace.** The activation loop iterates refresh
targets gated on `isSwitchboardManagedFolder(root)` (`extension.ts:266-310`, called at `:785`), a
predicate satisfied by `kanban.db`, a `db-pointer`, **or** a `workspace-id`. The `db-pointer` case
is the important one: the database may already live outside the workspace, with only a pointer
inside it. That is the direction of travel — `kanban.db` in the repo is the thing current storage
work is removing — and it makes this plan *more* correct, not less: the bookkeeping leaves the
user's tree entirely rather than moving from one in-repo file to another. `refreshWorkspaceControlPlane(root, context)`
(`extension.ts:329`) then runs with only `root` and `context` in hand, so the database exists but
is not threaded in. Config rows are the established home for exactly this kind of per-workspace
state: `TERMINALS_GROUPS_KEY` (`'switchboard.prompts.terminals.groups'`,
`teamWiring.ts:501`) is read through `getConfigJson` the same way.

**And the prune has no guard for an empty bundle list.** `currentBundlePaths` is built at
`extension.ts:407-409` from `skillFiles` and `workflowFiles`, which come from `seedBundleSurface`
(`ControlPlaneMigrationService.ts:1236`) and remain `[]` if the crawl throws — an unreadable or
missing bundled `.agents/` directory (the catch at `:1281-1283` returns `{ changed: false, files:
[] }`). An empty set means *every* ledger-tracked path is retired, and the prune deletes all of
them. Neither `pruneRetiredBundleFiles` nor its caller checks for this. Today a broken ledger read
limits the blast radius by accident; once the ledger is reliably retrievable from the database,
that accidental protection disappears.

### Root Cause

The ledger was implemented as a sibling of the tree it describes, which makes it easy to reason
about and easy to ship, but conflates two different things living in the same directory: content
the user is meant to see and version, and bookkeeping the extension keeps about its own writes. The
workspace has a store for the second kind; the ledger predates the decision to use it.

### Non-goals

- **Not changing what the ledger is for.** Retirement still needs a discriminator between
  bundle-shipped and user-authored files. This changes where it is kept.
- **Not owning `.agents/` outright.** Users place their own files there; a mirror-the-bundle-exactly
  design would delete them.
- **Not moving skills or protocols into the database.** That is
  `protocols-as-db-rows-not-scaffolded-files.md`. This is bookkeeping only.
- **Not changing the seed loop's create/overwrite behaviour.**

## Metadata

> **Superseded:** **Complexity:** 4
> **Reason:** The plan's own Complexity Audit lists six complex/risky items: mandatory migration for ~4,000 installs, indefinite fallback reads, threading a DB accessor across two hosts, a sync/async boundary crossing in `generateClaudeMirror`, a third read site in `SetupPanelProvider`, and a mass-deletion guard. That is multi-file coordination with moderate logic and data-consistency risks — not a single-file localized change. The scoring guide places this at 5-6 (Medium), not 3-4 (Low).
> **Replaced with:** **Complexity:** 6

**Complexity:** 6
**Tags:** bugfix, backend, database, reliability, devops

## User Review Required

Yes — one decision.

**What happens to a workspace whose database is absent, unreadable, or resolving to the wrong one?** Recommendation: **treat it as
"no prior knowledge" and prune nothing**, matching the existing first-run fail-safe ("First-run (no
ledger) → deletes nothing, seeds the ledger for next time"). Seeding still proceeds; only retirement
pauses until a ledger exists.

The consequence to accept: a workspace copied or cloned without its `kanban.db` loses its ledger,
where today the file travelled with the directory. Retired files then strand until the next
activation rebuilds the ledger and a later retirement removes them. That is a real behaviour change
and the case for keeping a file. It is worth accepting because the alternative — deleting on
incomplete knowledge — is the failure mode this plan also exists to close.

## Complexity Audit

### Routine

- Reading and writing a config key through the existing `getConfigJson` / `setConfigJson` pair (`KanbanDatabase.ts:5668-5676`).
- The `getConfigJsonSync` / `getConfigSync` pair (`KanbanDatabase.ts:5704-5719`) exists for synchronous reads when the DB handle is already open — the `.claude` mirror path may use it if making `generateClaudeMirror` async proves too cascading.

### Complex / Risky

- **Migration is mandatory and must not unlink.** ~4,000 installs hold file ledgers. First run reads
  the file, writes the row, then archives the file as `.switchboard-bundled.json.migrated.bak` — per
  the project rule that legacy files are archived rather than deleted. A cutover that ignores the
  existing file makes every workspace look first-run, which pauses retirement silently.
- **Never assume the migration already ran.** Some installs are many versions behind; the read path
  must accept "row absent, file present" indefinitely, not just for one release.
- **The DB accessor must be threaded, not reached for globally.** `refreshWorkspaceControlPlane`
  takes `(root, context)`. Adding a hidden global lookup inside it makes the seeding path untestable
  and couples it to activation order.
- **Both hosts.** Standalone does not seed today, but it is planned, and it runs the same
  `KanbanDatabase`. Put the accessor in shared code so the standalone seeding work inherits it. Per
  `CLAUDE.md` the trap is composition-root wiring — `bootstrap.ts`'s `default:` arm makes verb audits
  come back green while a seam is unwired.
- **The empty-bundle guard must land in the same change.** Once the ledger is reliably present, a
  failed crawl deletes the entire recorded control plane. Guard at the caller: an empty
  `currentBundlePaths` means the crawl failed, not that the bundle is empty — skip the prune AND skip
  the ledger rewrite, log the skip. Skipping only the prune but still rewriting the ledger with
  `files: []` records that every file is retired, turning the guard into a time-bomb for the next
  activation rather than a fail-safe.
- **Two ledgers, three read sites.** The `.claude` manifest is written by `ClaudeCodeMirrorService`
  (`ClaudeCodeMirrorService.ts:415-419`), which has its own read at `:388-400` (stale-mirror
  cleanup). A **third** read site exists in `SetupPanelProvider._removeMirroredClaudeSkills`
  (`SetupPanelProvider.ts:1759-1762`), which reads the manifest during cleanup to decide which
  `.claude/skills/` dirs to remove. All three must migrate, or `.claude/` keeps churning and the
  fix reads as half-done — or worse, cleanup silently no-ops because "no ledger → not
  Switchboard-generated."
- **`generateClaudeMirror` is synchronous; DB access is async.** `generateClaudeMirror`
  (`ClaudeCodeMirrorService.ts:313`) is a sync function — it reads the ledger with `fs.existsSync`
  / `fs.readFileSync` (`:388-390`) and writes with `fs.writeFileSync` (`:415-419`). Replacing these
  with `getConfigJson` / `setConfigJson` (both async) requires either making `generateClaudeMirror`
  async (both callers — `extension.ts:4113` and `ControlPlaneMigrationService.ts:743` — are already
  async, so the cascade is contained) or using `getConfigJsonSync` (requires the DB handle to be
  open and a DB reference threaded into a function that currently takes `(rootDir,
  extensionVersion)`). The `.agents` ledger lives in `ControlPlaneMigrationService` (async methods,
  `KanbanDatabase` already imported) — that half is straightforward. The `.claude` half crosses a
  sync/async boundary that the implementation must resolve explicitly.

## Edge-Case & Dependency Audit

**Race conditions**
- Two windows activating on the same workspace: both read the same rows and converge on the same
  decision; the write is last-writer-wins on a config key with no partial state observable.
- Activation racing the board's own DB access: config reads are already concurrent elsewhere
  (`TERMINALS_GROUPS_KEY`), so this adds no new pattern.

**Security**
- None. Local database, no new surface, no secrets in the payload — the ledger is a list of relative
  paths.

**Side effects**
- Users who committed the old ledger keep a stale tracked file until they remove it. The `.migrated.bak`
  archive makes the transition visible rather than mysterious, but a release note is warranted.
- `git status` in a user's project stops showing extension churn, which is the point.
- The packaging guard proposed in `packaging-must-refuse-a-clobbered-control-plane.md` becomes clean:
  with no ledger in the tree, `git status --porcelain -- .agents .claude` is empty in normal
  operation, so the guard no longer needs the `generatedAt` carve-out.

**Migration**
- Read file → write row → archive file as `*.migrated.bak`. Never unlink. Unknown keys in the parsed
  JSON are preserved rather than dropped. A workspace with neither row nor file is first-run and
  prunes nothing.

## Dependencies

- **Supersedes** the `generatedAt` removal noted as a prerequisite in
  `packaging-must-refuse-a-clobbered-control-plane.md` — a row has no timestamp problem at all. If
  this plan is deferred, ship the two-line `generatedAt` removal in the meantime; it is the
  user-visible half.
- **Must land with** the empty-bundle prune guard described above.
- **Sequenced after DB resolution is trustworthy.**
  `a-configured-db-path-may-not-be-where-the-board-is.md` establishes that relocation "has been failing
  silently for an unknown number of installs", leaving a workspace resolving to a database that is not
  the one holding its plans. Coupling control-plane retirement to DB resolution before that is settled
  means retirement breaks wherever resolution is broken. The fail-safe bounds the damage — an
  unresolvable database reads as "no ledger", which prunes nothing rather than deleting wrongly — so the
  failure mode is stalled retirement, not data loss. Ship the two-line `generatedAt` removal in the
  meantime; it fixes the user-visible churn without taking the coupling.
- **Related:** `the-seed-loop-resurrects-files-the-workspace-deleted.md`, which adds a ledger lookup
  on the creation path — it should read through whatever accessor this plan introduces, so the two
  are best sequenced together.

## Adversarial Synthesis

Key risks: (1) missing the third read site in `SetupPanelProvider`, so cleanup silently no-ops after
the manifest moves; (2) the sync/async boundary in `generateClaudeMirror` — the `.claude` half cannot
use async `getConfigJson` without either making the function async or threading a DB reference for
`getConfigJsonSync`; (3) the empty-bundle guard skipping only the prune but still rewriting the
ledger with `files: []`, creating a time-bomb instead of a fail-safe; (4) cutting over without
migration, so every existing workspace reads as first-run and retirement silently pauses; (5) moving
the `.agents` ledger and leaving the `.claude` manifest churning. Mitigations: audit all three read
sites; make `generateClaudeMirror` async (both callers are already async) or use `getConfigJsonSync`
with a threaded DB ref; guard skips both prune and ledger rewrite; migrate-then-archive with
indefinite fallback; move both ledgers and all readers.

## Proposed Changes

### `src/services/ControlPlaneMigrationService.ts`

**Context:** This service owns the `.agents` bundle ledger — `readBundleLedger` (`:1158`),
`pruneRetiredBundleFiles` (`:1309`), and `seedBundleSurface` (`:1236`). It already imports
`KanbanDatabase` (`:10`). The ledger constant `BUNDLE_LEDGER_FILE` is at `:1053`; the blocklist at
`:1042-1048`.

**Logic:**
1. Add a config key constant, e.g. `BUNDLE_LEDGER_CONFIG_KEY = 'switchboard.bundleLedger'`.
2. Change `readBundleLedger` from a sync file read to an async DB-first read with file fallback:
   - Accept a `KanbanDatabase` parameter (or a `(root) => Promise<KanbanDatabase | null>` accessor).
   - Try `db.getConfigJson<{ files: string[] }>(BUNDLE_LEDGER_CONFIG_KEY, { files: [] })`. If
     `files` is a non-empty array, return it.
   - If the row is absent or empty, try the file (`readBundleLedger` current logic). If the file
     exists and parses, **migrate**: write the row via `db.setConfigJson`, archive the file as
     `*.migrated.bak`, return the files. Preserve unknown keys from the parsed JSON in the row.
   - If neither row nor file, return `null` (first-run, prunes nothing).
   - If the DB is unavailable (`ensureReady` fails, or the accessor returns null), fall back to the
     file read. If the file is also absent, return `null`.
3. Change `pruneRetiredBundleFiles` to accept a `KanbanDatabase` parameter and call the new async
   `readBundleLedger`. The ledger rewrite at `:1405-1418` changes from `fs.writeFileSync` to
   `db.setConfigJson(BUNDLE_LEDGER_CONFIG_KEY, manifest)`.
4. Remove `generatedAt` from the manifest object at `:1410`.
5. `seedBundleSurface` already takes a `ledgerSnapshot: Set<string>` — no change needed to its
   signature; the caller builds the snapshot from the new async `readBundleLedger`.

**Implementation:**
- `readBundleLedger` becomes `async readBundleLedger(workspaceRoot: string, db: KanbanDatabase | null): Promise<string[] | null>`.
- The migration archive: `fs.renameSync(ledgerPath, ledgerPath + '.migrated.bak')` — never unlink.
- The `AGENT_COPY_BLOCKLIST` entry for `.switchboard-bundled.json` (`:1047`) stays — it prevents
  the file from being seeded from the bundle, which is still correct even after the move (the file
  should never exist in a bundle).

**Edge Cases:**
- DB row exists but `files` is `[]` (empty array, not absent): treat as "ledger exists, bundle was
  empty last run" — return `[]`, not `null`. This is distinct from "row absent" (first-run). The
  prune will find nothing to delete (no prior files), which is correct.
- DB row exists with unknown extra keys: preserve them through read/write (round-trip fidelity).
- File exists but DB row also exists (migration already ran, file not yet archived): DB row wins;
  archive the file if it hasn't been archived yet.
- Concurrent migration (two windows): last-writer-wins on the config row; the archive rename is
  idempotent (second window finds the file already gone, skips).

### `src/services/ClaudeCodeMirrorService.ts`

**Context:** This service owns the `.claude` manifest — `generateClaudeMirror` (`:313`) reads it at
`:388-400` (stale-mirror cleanup) and writes it at `:407-419`. The function is **synchronous**. The
manifest constant `GENERATED_MANIFEST_FILE` is at `:96`.

**Logic:**
1. Add a config key constant, e.g. `CLAUDE_MANIFEST_CONFIG_KEY = 'switchboard.claudeManifest'`.
2. **Resolve the sync/async boundary.** Preferred approach: make `generateClaudeMirror` async. Both
   callers are already async:
   - `extension.ts:4113` inside `scaffoldProtocolLayers` (async, `:4088`).
   - `ControlPlaneMigrationService.ts:743` inside `_bootstrapControlPlaneLayout` (async, `:677`).
   - Change signature to `async function generateClaudeMirror(rootDir: string, extensionVersion:
     string | undefined, db: KanbanDatabase | null): Promise<MirrorResult>`.
   - Replace the file read at `:388-400` with `await db?.getConfigJson(...)` + file fallback (same
     migration pattern as the `.agents` ledger).
   - Replace the file write at `:415-419` with `await db?.setConfigJson(CLAUDE_MANIFEST_CONFIG_KEY,
     manifest)`.
   - Stop writing `generatedAt` at `:410`.
3. **Fallback if async cascade is too deep:** use `getConfigJsonSync` (`KanbanDatabase.ts:5715`) and
   `setConfigJson` (async, called after the sync body). This requires the DB handle to be open and
   passed in. This is the inferior path — it splits the read (sync) from the write (async) and
   requires the DB to be pre-opened — but it avoids changing the function signature. Only use if the
   async conversion reveals unexpected callers.

**Implementation:**
- The stale-mirror cleanup at `:388-400` reads `previous.skills` — the DB row stores the same
  `{ skills: [...], ... }` shape, so the read is a direct replacement.
- The manifest write at `:407-419` writes `{ generator, version, generatedAt, skills,
  settingsAllowEntries, settingsAllowAdded }` — drop `generatedAt`, write the rest to the DB row.
- The file fallback + migration follows the same archive-as-`.migrated.bak` pattern.

**Edge Cases:**
- `db` is `null` (DB unavailable): fall back to file read/write. The file path remains as a
  degraded mode — the ledger churns but the feature works. This is the fail-safe.
- `generateClaudeMirror` is called from `_bootstrapControlPlaneLayout` which may run before the DB
  is opened. The caller must ensure the DB is ready (`await db.ensureReady()`) before calling, or
  pass `null` to use the file fallback.

### `src/services/SetupPanelProvider.ts`

**Context:** `_removeMirroredClaudeSkills` (`:1745`) reads the `.claude` manifest at `:1759-1762`
to decide which `.claude/skills/` dirs to remove during cleanup. It is already async. The constant
`CLAUDE_GENERATED_MANIFEST_FILE` is at `:51`.

**Logic:**
1. Thread a `KanbanDatabase` (or accessor) into `_removeMirroredClaudeSkills`.
2. Replace the file read at `:1759-1762` with `await db?.getConfigJson(CLAUDE_MANIFEST_CONFIG_KEY,
   null)` + file fallback (same migration pattern).
3. The cleanup at `:1786` that removes the ledger file (`fs.promises.rm(ledgerPath, ...)`) should
   also clear the DB row (`await db?.setConfigJson(CLAUDE_MANIFEST_CONFIG_KEY, null)`) or set it to
   `{ skills: [] }`.

**Edge Cases:**
- DB unavailable: fall back to file read. If file is also absent, skip cleanup (same "no ledger →
  not Switchboard-generated" behaviour).
- Row exists but file already archived: read from row, proceed with cleanup.

### `src/extension.ts`

**Context:** `refreshWorkspaceControlPlane` (`:329`) is the activation-time entry point. It reads
the ledger at `:348`, seeds at `:352-355`, scaffolds at `:361-396`, and prunes at `:406-423`. The
DB is not currently threaded in — `KanbanDatabase.forWorkspace(root)` is the established pattern
(used at `:939`, `:1331`, `:1560`, etc.).

**Logic:**
1. At the top of `refreshWorkspaceControlPlane`, resolve the DB: `const db =
   KanbanDatabase.forWorkspace(root); const dbReady = await db.ensureReady();` Use `dbReady ? db :
   null` as the accessor — `null` means "DB unavailable, use file fallback."
2. Pass `db` (or `null`) to the new async `readBundleLedger` at `:348`:
   `const ledgerRaw = await ControlPlaneMigrationService.readBundleLedger(root, dbReady ? db : null);`
3. Pass `db` to `pruneRetiredBundleFiles` at `:413`.
4. **Add the empty-bundle guard** before the prune call at `:406`:
   ```typescript
   if (currentBundlePaths.size === 0) {
       console.warn('[Switchboard] Bundle crawl returned zero files — skipping prune and ledger rewrite (crawl failure, not empty bundle).');
       outputChannel?.appendLine('[Switchboard] .agents drift: crawl returned 0 files, prune skipped.');
       return; // or skip to after the prune block
   }
   ```
   This skips BOTH the prune AND the ledger rewrite. If the ledger were rewritten with `files: []`,
   the next activation would treat every prior file as retired and delete them all — the guard
   would have converted a one-time crawl failure into a permanent mass-deletion trigger.
5. Pass `db` to `scaffoldProtocolLayers` → `generateClaudeMirror` (if made async) or ensure the DB
   is open for `getConfigJsonSync`.

**Edge Cases:**
- `db.ensureReady()` fails: `dbReady = false`, pass `null` — all ledger reads fall back to file,
  prune is skipped (no reliable ledger), seeding proceeds normally.
- `isSwitchboardManagedFolder` already gates on `kanban.db` or `db-pointer` existence, so the DB
  path is resolvable. The `ensureReady` call opens it.

### `src/standalone/bootstrap.ts` (forward-looking)

**Context:** Standalone does not seed today — no calls to `seedBundleSurface`, `pruneRetiredBundleFiles`,
or `refreshWorkspaceControlPlane` exist in `src/standalone/`. When standalone seeding is added, it
must use the same DB accessor.

**Logic:**
1. The accessor lives in `ControlPlaneMigrationService` (shared code, already imported by both
   hosts). When standalone seeding lands, it calls the same `readBundleLedger(root, db)` /
   `pruneRetiredBundleFiles(root, currentBundlePaths, version, db)` signatures.
2. No change needed now — the signatures are designed to accept `KanbanDatabase | null` so the
   standalone host can pass its own DB instance when the time comes.

**Edge Cases:**
- Per `CLAUDE.md`, the composition-root wiring trap: when standalone seeding is added, verify by
  hand that the DB is threaded, not just that the verbs are reachable.

## Verification Plan

### Automated Tests

> **Note:** Compilation and automated tests are not executed in this review pass. The checks below
> remain the plan's verification contract for the implementation phase.

1. **No file written.** After activation on a migrated workspace, assert neither
   `.agents/.switchboard-bundled.json` nor `.claude/.switchboard-generated.json` is (re)created.
2. **No churn.** Activate three times; assert `git status --porcelain -- .agents .claude` stays empty
   throughout. This fails today on the first activation.
3. **Migration preserves the ledger.** Start from a workspace with a populated file ledger; assert
   the row matches its `files` exactly and the file is archived as `*.migrated.bak`, not deleted.
4. **Retirement still works across the migration.** Retire a file from the bundle on a
   just-migrated workspace; assert it is pruned — proving the row carried the prior state rather
   than resetting it.
5. **Unknown keys survive.** Add an unrecognised field to a file ledger; assert it is preserved
   through migration.
6. **Indefinite fallback.** Simulate an install several versions behind (file, no row); assert it
   migrates correctly rather than reading as first-run.
7. **First-run prunes nothing.** Fresh workspace, no row and no file: assert seeding proceeds and
   nothing is deleted.
8. **Empty bundle deletes nothing.** Make the bundled `.agents/` unreadable; assert the prune is
   skipped and logged, that **zero** workspace files are removed, AND that the ledger row is NOT
   rewritten with `files: []` (the guard must skip both prune and rewrite). This is a mass-deletion
   regression test and must fail before the guard.
9. **DB unavailable fails safe.** Make the database unreadable; assert seeding proceeds, prune is
   skipped, and no file is deleted.
10. **Both ledgers moved.** Assert `.claude/.switchboard-generated.json` is no longer written and its
    manifest reads from the row.
11. **Third read site migrated.** Exercise `SetupPanelProvider._removeMirroredClaudeSkills` on a
    migrated workspace; assert it reads from the DB row and successfully removes Switchboard-generated
    `.claude/skills/` dirs. On a workspace with no row and no file, assert it skips (no-op).
12. **Both hosts.** Verify against the VS Code extension host and, once standalone seeds,
    `npx switchboard`. Inspect the wiring in both composition roots — a green verb audit is not
    evidence.
13. **Copied workspace degrades safely.** Copy a workspace without `kanban.db`; assert it seeds,
    prunes nothing, and rebuilds the ledger rather than deleting anything.

### Goal Invariants

**Negative invariants (the goal is a relocation — these are mandatory):**

- Assert `.agents/.switchboard-bundled.json` is absent from a migrated workspace after activation
  (the file must not be recreated).
- Assert `.claude/.switchboard-generated.json` is absent from a migrated workspace after activation
  (the file must not be recreated).
- Assert `generatedAt` does not appear in the DB config row for either ledger key (the churn field
  is eliminated, not relocated).
- Assert no workspace file is deleted when `currentBundlePaths` is empty (the guard holds).

**Positive invariants (paired with the negatives):**

- Assert `db.getConfigJson('switchboard.bundleLedger', { files: [] }).files` is a non-empty array
  on a migrated workspace whose bundle has skills/workflows (the ledger is resolvable at its new
  location).
- Assert `db.getConfigJson('switchboard.claudeManifest', {}).skills` is a non-empty array on a
  migrated workspace whose `.claude` mirror was generated (the manifest is resolvable at its new
  location).
- Assert retirement prunes a file when `currentBundlePaths` is non-empty and a ledger-tracked file
  is no longer in the bundle (retirement still works after the move).
- Assert `SetupPanelProvider._removeMirroredClaudeSkills` removes Switchboard-generated
  `.claude/skills/` dirs when the DB row exists (the third read site resolves from the new
  location).
