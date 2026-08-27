# The bundle ledger is extension bookkeeping written into the user's repository, and it belongs in the database

## Goal

Move the control-plane bundle ledgers out of `.agents/` and `.claude/` and into `kanban.db` config
rows, so nothing the extension writes for its own bookkeeping lands in a user's version-controlled
tree. Pair it with the missing empty-bundle guard, which becomes more dangerous once the ledger is
reliably present.

### Problem Analysis

**Two ledgers are written into workspace directories users commit.**
`.agents/.switchboard-bundled.json` (`ControlPlaneMigrationService.ts:1281`) and
`.claude/.switchboard-generated.json` (`ClaudeCodeMirrorService.ts:410`) record which paths the
bundle shipped, so `pruneRetiredBundleFiles` can delete a file the bundle has retired without
touching user-authored files. That discrimination is genuinely needed — the seed loops only add and
overwrite, never delete, so without it "a skill removed from the bundle strands in every workspace's
`.agents/` forever."

**They churn on every activation.** Both are rewritten with a fresh
`generatedAt: new Date().toISOString()`, and **nothing reads that field** — the only value consumed
from the bundle ledger is `parsed.files` (`ControlPlaneMigrationService.ts:1184-1185`). So every user
whose project is a git repository carries a permanently-modified file that the extension created,
that they did not ask for, and that they cannot stop without writing their own ignore rule.

**The blocklist already says they do not belong to the tree.** `AGENT_COPY_BLOCKLIST`
(`ControlPlaneMigrationService.ts:1041-1048`) excludes the ledger from the bundle with the comment
that it is "generated at runtime into each workspace's `.agents/`, never bundled." It is already
understood as runtime state; it is simply stored as workspace content.

**A database is resolvable by the time seeding runs — which is not the same as one sitting in the workspace.** The activation loop iterates refresh
targets gated on `isSwitchboardManagedFolder(root)` (`extension.ts:850`), a predicate satisfied by
`kanban.db`, a `db-pointer`, **or** a `workspace-id`. The `db-pointer` case is the important one: the
database may already live outside the workspace, with only a pointer inside it. That is the direction
of travel — `kanban.db` in the repo is the thing current storage work is removing — and it makes this
plan *more* correct, not less: the bookkeeping leaves the user's tree entirely rather than moving from
one in-repo file to another. `refreshWorkspaceControlPlane(root, context)`
(`:329`) then runs with only `root` and `context` in hand, so the database exists but is not threaded
in. Config rows are the established home for exactly this kind of per-workspace state:
`TERMINALS_GROUPS_KEY` is read through `getConfigJson` the same way.

**And the prune has no guard for an empty bundle list.** `currentBundlePaths` is built at
`extension.ts:472-474` from `skillFiles` and `workflowFiles`, which are hoisted and remain `[]` if the
crawl throws — an unreadable or missing bundled `.agents/` directory. An empty set means *every*
ledger-tracked path is retired, and the prune deletes all of them. Neither `pruneRetiredBundleFiles`
nor its caller checks for this. Today a broken ledger read limits the blast radius by accident; once
the ledger is reliably retrievable from the database, that accidental protection disappears.

### Root Cause

The ledger was implemented as a sibling of the tree it describes, which makes it easy to reason about
and easy to ship, but conflates two different things living in the same directory: content the user
is meant to see and version, and bookkeeping the extension keeps about its own writes. The workspace
has a store for the second kind; the ledger predates the decision to use it.

### Non-goals

- **Not changing what the ledger is for.** Retirement still needs a discriminator between
  bundle-shipped and user-authored files. This changes where it is kept.
- **Not owning `.agents/` outright.** Users place their own files there; a mirror-the-bundle-exactly
  design would delete them.
- **Not moving skills or protocols into the database.** That is
  `protocols-as-db-rows-not-scaffolded-files.md`. This is bookkeeping only.
- **Not changing the seed loop's create/overwrite behaviour.**

## Metadata

**Complexity:** 4
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

- Reading and writing a config key through the existing `getConfigJson` / `setConfigJson` pair.

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
  `currentBundlePaths` means the crawl failed, not that the bundle is empty — skip the prune and log.
- **Two ledgers, two owners.** The `.claude` manifest is written by `ClaudeCodeMirrorService`, which
  has its own read at `:388-389`. Both move, or `.claude/` keeps churning and the fix reads as
  half-done.

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

Key risks: (1) cutting over without migration, so every existing workspace reads as first-run,
retirement silently pauses, and retired files strand everywhere — invisible, because nothing errors;
(2) unlinking the legacy file instead of archiving it, against the project's own migration rule;
(3) landing the DB move without the empty-bundle guard, converting an accidental protection into a
reliable path to deleting an entire recorded control plane; (4) moving the `.agents` ledger and
leaving the `.claude` manifest churning, so users still see extension noise and the fix reads as
done; (5) reaching for a global DB handle inside `refreshWorkspaceControlPlane` rather than threading
one, coupling seeding to activation order and making it untestable; (6) wiring the accessor in
`extension.ts` only, so the planned standalone seeding reimplements the file ledger. Mitigations:
migrate-then-archive with an indefinite fallback read; land the guard in the same change; move both
ledgers; thread the accessor through shared code; and verify both composition roots by hand.

## Proposed Changes

1. **Store the bundle ledger as a `kanban.db` config row**, read and written through the existing
   `getConfigJson` / `setConfigJson` pair, keyed per workspace as `TERMINALS_GROUPS_KEY` is.
2. **Thread a database accessor into `refreshWorkspaceControlPlane`** (`extension.ts:329`) rather
   than reaching for one inside it.
3. **Migrate on first read:** file present and row absent → parse the file, write the row, archive
   the file as `*.migrated.bak`. Preserve unknown keys. Keep the fallback read indefinitely.
4. **Do the same for `.claude/.switchboard-generated.json`** in `ClaudeCodeMirrorService`.
5. **Guard the prune against an empty bundle list** at `extension.ts:472-474`: an empty
   `currentBundlePaths` means the crawl failed — skip the prune, log it, do not delete.
6. **Fail safe when the database is unavailable:** treat the ledger as absent, seed normally, prune
   nothing.
7. **Put the accessor in shared code** so the planned standalone seeding inherits it.
8. **Stop writing either ledger file** once migration has run.

### Migration

Read-then-archive, never unlink; legacy files preserved as `*.migrated.bak`. The fallback read stays
permanently, since installs many versions behind will present a file and no row. A workspace with
neither is first-run and prunes nothing.

## Verification Plan

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
   skipped and logged, and that **zero** workspace files are removed. This is a mass-deletion
   regression test and must fail before the guard.
9. **DB unavailable fails safe.** Make the database unreadable; assert seeding proceeds, prune is
   skipped, and no file is deleted.
10. **Both ledgers moved.** Assert `.claude/.switchboard-generated.json` is no longer written and its
    manifest reads from the row.
11. **Both hosts.** Verify against the VS Code extension host and, once standalone seeds,
    `npx switchboard`. Inspect the wiring in both composition roots — a green verb audit is not
    evidence.
12. **Copied workspace degrades safely.** Copy a workspace without `kanban.db`; assert it seeds,
    prunes nothing, and rebuilds the ledger rather than deleting anything.
