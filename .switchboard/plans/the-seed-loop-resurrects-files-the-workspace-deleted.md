# The activation seed loop re-creates every bundle file the workspace deleted, undoing the protocols migration on restart

## Goal

Stop the `.agents/` seed loop from re-materialising files a workspace has deliberately deleted. A
deletion and a never-seeded file are currently indistinguishable to the loop, so any retirement of a
bundled file is undone on the next activation by a stale bundle.

### Problem Analysis

**The damage, measured.** `abd3659` took `.agents/skills/` from **17 files to 69** — 52 files
re-created. `.agents/protocols/` (32) and `.agents/workflows/` (4) kept their counts, so the skills
tree is the resurrection; the workflows are a separate, content-only revert.

Those 52 are exactly what the protocols migration removed. `move-protocols-out-of-skill-discovery.md`
relocated 33 items out of `.agents/skills/` (landing at `.agents/protocols/` via review fix
`33d4f3d`), and `delete-dead-skill-files.md` removes 23 stale flat `.md` files superseded by their
directory `SKILL.md` form in the July 11 migration. The stated goal was reducing the CLI system
prompt's `<available_skills>` block **from 91 entries to 4**. After `abd3659` it is back to roughly
91, with 22 skill names appearing twice — once flat, once as a directory.

**The line responsible.** `src/extension.ts:363`, the second branch of the content-hash seed loop:

```js
} catch {
    // dest absent → copy new file.
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(destUri.fsPath)));
    await vscode.workspace.fs.copy(srcUri, destUri, { overwrite: false });
    agentsChanged = true;
}
```

Unconditional. `stat` on the destination throws because the file is absent, and absence is read as
"not seeded yet" with no consideration that the workspace may have removed it on purpose. Every
activation re-creates it.

**Why the existing ledger does not catch this.** `pruneRetiredBundleFiles`
(`ControlPlaneMigrationService.ts`) deletes workspace files that the *bundle* has retired — its
input is `currentBundlePaths`, and its comment is explicit that "ONLY paths it previously recorded as
bundle-shipped are ever deleted; user-authored files are never touched." That is the right
discipline, pointed the wrong way for this failure. A stale bundle still **contains** all 52 files,
so they are current bundle members, not retirees. The prune has nothing to prune, and the seed
faithfully restores them.

**The asymmetry is the bug.** In the same activation block, deletions consult the ledger and are
careful; creations consult nothing and are blind. A file can therefore be deleted from the bundle and
correctly disappear everywhere, but cannot be deleted from a *workspace* at all — it returns on
restart.

**Consequences beyond file count.** A `<available_skills>` block back at ~91 entries, with 22
duplicated names, is the skill-discovery spam the migration existed to remove. An agent starting a
session against that list has to work out which of two entries per skill is real, which is a
plausible contributor to the reported startup probing. Restarting the editor is enough to reintroduce
it; no install or upgrade is required.

### Root Cause

The seed loop models one direction of truth: the bundle proposes, the workspace accepts. Retirement
was later recognised as a real event and given a mechanism — the ledger and the prune — but only for
retirement *by the bundle*. Deletion *by the workspace* was never modelled, so the loop has no
concept that an absent file might be a decision. The ledger already holds the information needed to
tell the two apart; it simply is not consulted on the creation path.

### Non-goals

- **Not changing the overwrite branch.** Content-reverting an existing file is a separate failure
  affecting the 4 workflow files, and its fix raises upgrade-policy questions this plan does not
  need. Bounded and out of scope here.
- **Not adding ledger content hashes, sidecars, or merge policy.** None are required to distinguish
  absent-because-deleted from absent-because-new.
- **Not blocking seeding into a fresh workspace.** First run must still seed everything.
- **Not the one-time repair.** Restoring the tree is a git operation, not code — see Dependencies.
- **Not redesigning where protocols live.** `protocols-as-db-rows-not-scaffolded-files.md` owns that
  and shrinks this surface on its own.

## Metadata

**Complexity:** 3
**Tags:** bugfix, backend, reliability, devops

## User Review Required

Yes — one decision.

**Should a workspace deletion be permanent, or re-offered when the bundle's copy changes?**
Recommendation: **permanent, and silent apart from the drift line.** A file the workspace removed
stays removed for as long as the ledger records it as previously shipped. Reasons:

- It matches the deletion path's existing contract — the ledger is the sole discriminator.
- The alternative (re-create when the bundle's content changes) means a retired skill returns as
  soon as anyone edits it upstream, which is the current failure with extra steps.
- Activation already emits `[Switchboard] .agents drift: N bundle file(s) missing, …`. A deliberate
  deletion showing as "missing" in that line is the right amount of visibility: discoverable, not
  intrusive.

The case against: a user who deletes a file by accident never gets it back automatically. That is
acceptable — the bundle copy is still in the installed extension, and re-seeding is a matter of
clearing the ledger entry.

## Complexity Audit

### Routine

- Reading the ledger on the creation path.
- One conditional in the `dest absent` branch.

### Complex / Risky

- **First run must not be starved.** With no ledger, nothing is known to have been shipped, so every
  absent file must be copied — otherwise a fresh workspace gets an empty `.agents/`. The prune has
  exactly this fail-safe ("First-run (no ledger) → deletes nothing, seeds the ledger for next time")
  and the creation path needs its mirror image: no ledger → seed everything.
- **Genuinely new bundle files must still arrive.** A path absent from the ledger *and* absent from
  the workspace is new, and must be copied. Only `in ledger AND absent from workspace` means deleted.
  Getting this backwards silently freezes the control plane at its current contents.
- **The ledger is written after the seed, and both branches depend on it.** Read it once, before the
  loops, and use that snapshot for the whole activation. Reading it lazily mid-loop after a partial
  rewrite would make behaviour order-dependent.
- **The ledger is `{ files: string[] }` with posix separators**, and entries resolve via
  `rel.split('/')` against `.agents/`. The creation-path lookup must normalise identically or every
  comparison misses on Windows.
- **Standalone will seed.** The guard cannot live inline in `extension.ts`. Extract the seed into one
  shared function both composition roots call, so the standalone seeding work inherits it rather than
  reimplementing the bug. Per `CLAUDE.md`, a verb-reachability audit will not catch that divergence —
  only diffing the composition roots by hand will.
- **A malformed ledger must fail safe toward seeding, not starving.** The prune treats an unparseable
  ledger as "no prior knowledge" and skips deleting. The creation path's equivalent is to seed —
  an empty `.agents/` is a worse outcome than a resurrected file.

## Edge-Case & Dependency Audit

**Race conditions**
- Two editor windows activating on the same workspace concurrently: both read the same ledger
  snapshot and reach the same decision, so the outcome is idempotent. The ledger write is already
  atomic.

**Security**
- None. No new surface. The existing path-traversal guard on ledger entries (`abs` must resolve under
  `agentsDir`) applies to the creation path too and must be carried over, since ledger entries now
  drive a second code path.

**Side effects**
- A workspace that deleted files *before* a ledger existed has no record of them, so they seed once
  and are only protected after that activation records them. Unavoidable and self-correcting.
- The drift line's "missing" count becomes non-zero in normal operation for workspaces with
  deliberate deletions. That is the intended signal, but anything treating a non-zero count as an
  error needs checking.

**Migration**
- No schema change: the existing `{ files: string[] }` ledger already carries what is needed. Older
  workspaces without a ledger seed as they do today and gain protection on the next activation. No
  stored state is rewritten, so nothing for the ~4,000-install base to migrate.

## Dependencies

- **One-time repair, first and separately.** The current tree carries the 69-file skills directory.
  Restore it (`git checkout <pre-sync-commit> -- .agents .claude`, then remove the files the sync
  added) **before packaging**, or the resurrected tree ships in the next VSIX and the loop closes
  again from a new build.
- **Shrunk by `protocols-as-db-rows-not-scaffolded-files.md`**, which reduces `.agents/` to the 4
  workflows plus `improve-plan` and `improve-feature`. That lowers the stakes but does not remove
  them — a deletion guard is still what makes those retirements stick.
- **Related:** `delete-dead-skill-files.md` (the 23 flat files) and
  `move-protocols-out-of-skill-discovery.md` (the 33 relocated items) are the deletions this plan
  protects.

## Adversarial Synthesis

Key risks: (1) inverting the condition and skipping files that are new rather than deleted, silently
freezing the control plane so no new skill ever reaches a workspace — the failure mode is invisible
because nothing errors; (2) starving a fresh workspace by treating an absent ledger as "everything
was deleted", producing an empty `.agents/`; (3) landing the guard inline in `extension.ts` so the
standalone seeding work reimplements the unguarded loop, exactly the composition-root divergence
`CLAUDE.md` documents; (4) comparing ledger entries without posix/native normalisation, so the guard
silently no-ops on Windows and the resurrection continues there; (5) shipping the guard without first
repairing the tree, so the next VSIX bundles 69 skills and re-seeds them into every workspace that
does not yet have the guard. Mitigations: state the condition as `in ledger AND absent` and test all
four combinations explicitly; mirror the prune's no-ledger fail-safe in the opposite direction; put
the guard in shared code and diff both composition roots by hand; reuse the prune's own
`rel.split('/')` resolution; and sequence the repair before the fix.

## Proposed Changes

1. **Read the ledger once per activation**, before the seed loops, into a `Set<string>` of
   previously-shipped relative paths — reusing the prune's existing read and its posix→native
   resolution rather than a second parser.
2. **Guard the `dest absent` branch:** copy only when the path is **not** in that set. In-ledger and
   absent means the workspace deleted it — skip.
3. **Fail safe toward seeding:** no ledger, or a malformed one, seeds everything, mirroring the
   prune's "first run deletes nothing".
4. **Extract the seed loop into one shared function** called from `src/extension.ts` now and from
   `src/standalone/bootstrap.ts` when standalone seeding lands, so the guard cannot diverge.
5. **Carry the path-traversal guard** onto the creation path, since ledger entries now drive it.
6. **Leave the drift line as the visibility channel** — a deliberate deletion shows as a missing
   bundle file, which is the intended signal.
7. **Do not touch the overwrite branch** in this plan.

### Migration

No schema change and no stored-state rewrite. The existing `{ files: string[] }` ledger already
holds what the guard needs; workspaces with no ledger behave exactly as they do today on the next
activation and gain protection thereafter.

## Verification Plan

1. **Deletion sticks.** In a workspace with a ledger recording `skills/archive/SKILL.md`, delete that
   file, restart the editor, assert it is **not** re-created. This fails before the fix.
2. **All four combinations.** in-ledger+present → hash path as today; in-ledger+absent → skipped;
   not-in-ledger+absent → copied; not-in-ledger+present → untouched by the creation branch.
3. **New bundle files still arrive.** Add a file to the bundled `.agents/skills/`, activate, assert it
   lands in a workspace that never had it.
4. **Fresh workspace seeds fully.** With no `.switchboard-bundled.json`, activate and assert the
   whole bundled tree is written and the ledger recorded.
5. **Malformed ledger seeds rather than starves.** Corrupt the ledger, activate, assert files are
   seeded and the ledger rewritten.
6. **The migration stays migrated.** Restore the tree to 17 skills, activate against a bundle
   containing 69, assert the count remains 17 and `<available_skills>` stays at 4 entries.
7. **No duplicate names return.** Assert no `skills/<name>.md` reappears beside `skills/<name>/SKILL.md`.
8. **Windows path parity.** Run 1 and 2 on Windows; assert ledger entries resolve and the guard
   applies, since a normalisation slip fails silently.
9. **Both composition roots.** Verify against the VS Code extension host and, once standalone seeds,
   `npx switchboard`. Inspect the wiring in both roots by hand — a green verb audit is not evidence.
10. **Drift line reports it.** Assert a deliberate deletion appears in the `.agents drift` line's
    missing count rather than being silently absent.
11. **Idempotent across restarts.** Activate three times in a row; assert no file churn after the
    first.
