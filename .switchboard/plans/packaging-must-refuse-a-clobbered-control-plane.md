# Packaging accepts a clobbered .agents/, so a stale control plane launders itself into the next build

## Goal

Refuse to package a VSIX whose `.agents/` (and `.claude/`) differ from the committed tree. That
single assertion breaks the loop that let a 30 July control plane ship in an August build, without
touching the delivery path that already does the right thing.

### Problem Analysis

**The delivery path is not broken.** On activation, `extension.ts:341-380` walks the bundled
`.agents/skills` and `.agents/workflows`, hashes each file against the workspace copy, overwrites on
difference, creates when absent; `pruneRetiredBundleFiles` then deletes workspace files the bundle
has retired, using `.switchboard-bundled.json` as the discriminator. Given a **current** bundle,
that is exactly the required behaviour: new skills arrive, changed skills update, retired skills
disappear. Nothing in it needs a ledger extension, a merge policy, or an upgrade negotiation.

**The bundle was old, and that is the entire failure.** `abd3659` wrote a `.agents/workflows/switchboard.md`
byte-identical to the file's 30 July state (36412 bytes), discarding `e72dc05d` (17 Aug, the launcher
rewrite) and `684643c3` (24 Aug). In the same commit `.agents/skills/` went **17 files to 69**,
re-creating the 52 that `move-protocols-out-of-skill-discovery.md` and `delete-dead-skill-files.md`
had removed, and returning `<available_skills>` to roughly 91 entries from the 4 that migration
achieved — with 22 skill names present twice, once flat and once as a directory.

**And it is self-sustaining.** The seeding writes into the working tree. `.vscodeignore:57` is
`!.agents/**`, so packaging ships that same working tree verbatim. So:

1. An editor carrying a stale build activates and overwrites the repo's `.agents/`.
2. A VSIX packaged from that tree bundles the overwritten files.
3. Installing it re-applies them, now with a fresh build behind them.

Each turn launders old content into a newer artifact. Nothing errors at any step, and the commit
that records it reads as an ordinary sync.

**The packaging contract already looks at `.agents/` and asks the wrong question.**
`src/test/vsix-packaging-contract.test.js:206` — "the .agents control plane the extension seeds WOULD
be packaged" — walks `.agents/` and asserts no file is excluded by `.vscodeignore`. That guards
against a control-plane file failing to ship. It says nothing about whether the content shipping is
the content the repository intends, which is the failure that actually occurred.

### Root Cause

`.agents/` is simultaneously authored source (committed, reviewed, migrated) and a runtime write
target (seeded into every workspace, including this one). Nothing marks the boundary, so a runtime
write is indistinguishable from an edit, and the packaging step — the one place with a cheap,
authoritative reference for what the content *should* be, namely git — never consults it.

### Non-goals

- **Not changing the seed loop.** Create/overwrite/prune are correct against a current bundle.
- **Not adding ledger hashes, sidecars, or merge policy.** All were proposed against a symptom.
- **Not preventing an already-built stale VSIX from clobbering a workspace.** This guards the build,
  not the install. That gap belongs to `the-seed-loop-resurrects-files-the-workspace-deleted.md`.
- **Not the one-time repair.** Restoring the tree is a git operation; see Dependencies.

## Metadata

**Complexity:** 2
**Tags:** bugfix, devops, reliability, test

## User Review Required

Yes — one decision, narrow.

**Should the assertion fail on any difference, or only on `.agents/` and `.claude/`?**
Recommendation: **`.agents/` and `.claude/` only, and fail on any difference within them** —
untracked, modified, staged or deleted. Reasons:

- Those two trees are the ones the extension writes at runtime, so they are the ones that can be
  silently wrong. A broader dirty-tree check would fail on ordinary in-progress work and be disabled
  within a week.
- "Any difference" is the right severity because there is no benign runtime write to these paths.
  A deliberate edit is committed before packaging; an uncommitted change is either unfinished work or
  a clobber, and neither should ship.

The alternative — warn rather than fail — is worth rejecting explicitly. A warning in a packaging log
is exactly what nobody read for the four weeks this was happening.

## Complexity Audit

### Routine

- A `git status --porcelain -- .agents .claude` call in a test that already walks `.agents/`.

### Complex / Risky

- **The check must run where packaging happens, not only in CI.** `vscode:prepublish` runs
  `npm run package`, and `package:targets` shells `scripts/package-targets.sh`. A contract test that
  only runs under `npm test` will pass while a local `vsce package` ships anyway. Wire it into the
  packaging path, or the guard is advisory.
- **Untracked files must count.** The 52 resurrected skills arrived as *new* files. A check that
  looks only at modifications to tracked files misses the exact failure it exists to catch —
  `--porcelain` reports them as `??` and they must be treated as failure.
- **Deletions must count too**, in the other direction: a tree missing a committed control-plane file
  ships an incomplete bundle.
- **The failure message has to name the remedy.** Someone hitting this is mid-release and will
  otherwise reach for `--no-verify`. It should print the differing paths and the restore command.
- **A shallow or absent git context breaks the reference.** In a tarball build or a shallow CI clone
  the comparison may be unavailable. Fail closed with a clear message rather than silently skipping —
  a skipped guard is the state we are already in.

## Edge-Case & Dependency Audit

**Race conditions**
- An editor activating *during* packaging can write `.agents/` between the check and the archive
  step. Narrow, and largely mitigated by running the check as late as possible in the packaging
  script.

**Security**
- None. A local test-time git query, no new surface.

**Side effects**
- Packaging fails for anyone with legitimate uncommitted control-plane work. That is the intent, and
  the message must make "commit it first" obvious.
- Existing release automation gains a new failure mode. Worth announcing rather than discovering
  during a release.

**Migration**
- Test/build tooling only. No schema, settings, stored state, or shipped behaviour change; no impact
  on the ~4,000-install base.

## Dependencies

- **The two runtime ledgers must be untracked first, or the guard is unusable.**
  `.agents/.switchboard-bundled.json` and `.claude/.switchboard-generated.json` are written on every
  activation with a fresh `generatedAt: new Date().toISOString()` (`ControlPlaneMigrationService.ts:1281`)
  and are currently committed. A guard asserting `git status --porcelain -- .agents .claude` is empty
  would therefore fail after every single activation, and be disabled within a day. Gitignore both —
  the blocklist comment already calls the ledger "generated at runtime into each workspace's
  `.agents/`, never bundled", so tracking it was always a category error.
- **The one-time repair must land first.** The tree currently carries the 69-file skills directory.
  Restore it (`git rm -rq .agents .claude && git checkout abd36593^ -- .agents .claude`, landing on
  17 skills / 32 protocols / 4 workflows) **before** packaging, or the first thing this guard does is
  block a release on damage that predates it.
- **Complements** `the-seed-loop-resurrects-files-the-workspace-deleted.md`, which covers the install
  side. Neither blocks the other; this one is the higher-value half because it stops new stale
  artifacts being created at all.
- **Shrunk by** `protocols-as-db-rows-not-scaffolded-files.md`, which reduces `.agents/` to the four
  workflows plus `improve-plan` and `improve-feature`.

## Adversarial Synthesis

Key risks: (1) wiring the check into `npm test` only, so a local `vsce package` still ships a
clobbered tree and the guard reads as present while being unreachable on the path that matters;
(2) checking modifications but not untracked files, which misses the 52-file resurrection outright
since those arrive as `??`; (3) making it a warning, reproducing the four weeks of unread signal;
(4) failing with a bare "tree is dirty" so a releaser bypasses it; (5) landing it before the repair
and blocking the next release on pre-existing damage, which gets the guard removed rather than the
damage fixed. Mitigations: wire into the packaging script and assert its presence there; treat
`??`, `M`, `A` and `D` alike; fail hard; print the differing paths plus the restore command; and
sequence the repair first.

## Proposed Changes

1. **Add a packaging assertion** in `src/test/vsix-packaging-contract.test.js`, beside the existing
   `:206` check: `git status --porcelain -- .agents .claude` must be empty. Treat untracked,
   modified, staged and deleted alike.
2. **Wire it into the packaging path**, not just the test suite — `vscode:prepublish` /
   `scripts/package-targets.sh` — so `vsce package` cannot bypass it.
3. **Fail closed when git is unavailable**, naming why, rather than skipping.
4. **Make the message actionable**: list the differing paths and print the restore command.
5. **Leave the seed loop and the prune untouched.**

### Migration

Build and test tooling only — no schema, settings, stored state, or shipped behaviour change.

## Verification Plan

1. **Clobbered tree is refused.** Restore the tree, then copy the 69-file `.agents/skills` over it;
   assert packaging fails and the message names `.agents/skills`.
2. **Untracked files fail it.** Add a single untracked file under `.agents/skills/`; assert failure.
   This is the 52-file case in miniature and would pass a modifications-only check.
3. **Deletions fail it.** Delete a committed control-plane file; assert failure.
4. **Clean tree packages.** With `.agents` and `.claude` matching HEAD, assert packaging succeeds.
5. **Unrelated dirt does not block.** Modify a file under `src/`; assert packaging still succeeds —
   the guard must not degenerate into a dirty-tree check.
6. **`vsce package` cannot bypass it.** Run the real packaging entry point (not `npm test`) against a
   clobbered tree; assert it fails. A green contract suite is not evidence for this one.
7. **Message is actionable.** Assert the output lists differing paths and the restore command.
8. **Git-unavailable fails closed.** Run with git unavailable; assert a clear failure, not a skip.
9. **The loop is broken end to end.** From the repaired tree, package, install, activate, and assert
   `.agents/skills` stays at 17 files and `.agents/workflows/switchboard.md` retains the launcher
   body — the round trip that previously laundered 30 July content into an August build.
