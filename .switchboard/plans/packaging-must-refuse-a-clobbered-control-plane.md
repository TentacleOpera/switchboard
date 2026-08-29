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

**Complexity:** 4
**Tags:** bugfix, devops, reliability, test
**Feature:** d84a2df3-59d5-4f57-a894-26291e9625ae

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
- Removing the `generatedAt` field from two manifest objects (two lines, one per file).
- Adding a `.claude/` packaging assertion mirroring the existing `.agents/` one at `:206`.
- Prepending a guard script call to the `vscode:prepublish` npm script string.

### Complex / Risky

- **The check must run where packaging happens, not only in CI.** `vscode:prepublish` runs
  `npm run package`, and `package:targets` shells `scripts/package-targets.sh`. A contract test that
  only runs under `npm test` will pass while a local `vsce package` ships anyway. Wire it into
  `vscode:prepublish` so every `vsce package` invocation hits it (vsce has no `--no-prepublish`
  flag — verified), or the guard is advisory.
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
- **The `generatedAt` removal must land in the same change.** Both ledgers
  (`.agents/.switchboard-bundled.json`, `.claude/.switchboard-generated.json`) are rewritten with a
  fresh `generatedAt: new Date().toISOString()` on every activation
  (`ControlPlaneMigrationService.ts:1410`, `ClaudeCodeMirrorService.ts:410`). Nothing reads that
  field — the only value consumed from the bundle ledger is `parsed.files`
  (`ControlPlaneMigrationService.ts:1164-1165`). A guard asserting `git status --porcelain -- .agents
  .claude` is empty would fail after every activation and be disabled within a day. Removing the
  field makes each ledger a pure function of the bundle's file list — byte-stable across activations
  — which fixes the guard and the user-visible churn in the same two lines.

## Edge-Case & Dependency Audit

**Race conditions**
- An editor activating *during* packaging can write `.agents/` between the check and the archive
  step. Narrow, and largely mitigated by running the check as late as possible in the packaging
  script (i.e. in `vscode:prepublish`, which fires immediately before vsce archives).

**Security**
- None. A local test-time git query, no new surface.

**Side effects**
- Packaging fails for anyone with legitimate uncommitted control-plane work. That is the intent, and
  the message must make "commit it first" obvious.
- Existing release automation gains a new failure mode. Worth announcing rather than discovering
  during a release.
- Removing `generatedAt` from the two ledger manifests changes the content of those files on disk.
  Both are tracked in git, so the first activation after the change produces a one-time diff (the
  field disappears). This is a one-time churn, not the perpetual churn the field causes today.

**Migration**
- Test/build tooling only. No schema, settings, stored state, or shipped behaviour change; no impact
  on the ~4,000-install base.

## Dependencies

- **The one-time repair has already landed.** Commit `5cd79357` ("Restore control plane to its
  pre-sync state") restored `.agents/` to 17 skills / 32 protocols / 4 workflows. The tree is clean
  (verified: `git status --porcelain -- .agents .claude` reports only `.agents/.switchboard-bundled.json`
  modified, which is the `generatedAt` churn this plan removes). No repair action is needed before
  implementing this plan.
- **The `generatedAt` removal is part of this plan, not a separate prerequisite.** Originally listed
  as a dependency, but no dedicated plan exists for it. `the-bundle-ledger-belongs-in-the-database-not-the-users-repo.md`
  would fix it by moving the ledgers to the database, but that is a larger effort that has not landed.
  The 2-line fix (remove `generatedAt` from both manifest objects) is promoted to a proposed change
  below — the guard and the removal are one atomic unit; neither works without the other.
- **Complements** `the-seed-loop-resurrects-files-the-workspace-deleted.md`, which covers the install
  side. Neither blocks the other; this one is the higher-value half because it stops new stale
  artifacts being created at all.
- **Shrunk by** `protocols-as-db-rows-not-scaffolded-files.md`, which reduces `.agents/` to the four
  workflows plus `improve-plan` and `improve-feature`. The guard is agnostic to the shape of `.agents/`
  — it checks against HEAD, whatever HEAD contains.

## Adversarial Synthesis

Key risks: (1) the `generatedAt` field was listed as a dependency with no owner, making the guard
unusable on arrival — promoted to a proposed change; (2) wiring the check into `npm test` only, so a
local `vsce package` still ships a clobbered tree — mitigated by wiring into `vscode:prepublish`;
(3) checking modifications but not untracked files, missing the 52-file resurrection — mitigated by
treating `??`, `M`, `A` and `D` alike; (4) making it a warning, reproducing the four weeks of unread
signal — rejected; (5) failing with a bare "tree is dirty" so a releaser bypasses it — mitigated by
printing differing paths plus the restore command; (6) no `.claude/` packaging assertion, so a future
`.vscodeignore` change could exclude `.claude/` while the guard checks a tree that doesn't ship —
mitigated by adding a mirror assertion to the contract test. Mitigations are wired into the proposed
changes, not left as advice.

## Proposed Changes

1. **Remove `generatedAt` from both ledger manifests.**
   - `src/services/ControlPlaneMigrationService.ts:1410` — delete the `generatedAt: new Date().toISOString()`
     line from the manifest object written to `.agents/.switchboard-bundled.json`.
   - `src/services/ClaudeCodeMirrorService.ts:410` — delete the `generatedAt: new Date().toISOString()`
     line from the manifest object written to `.claude/.switchboard-generated.json`.
   - After removal, both ledgers are pure functions of their file/skill lists — byte-stable across
     activations. The one-time diff (field disappears) lands on the next activation and is committed
     as part of this change.

2. **Create `scripts/guard-control-plane.sh`** — a standalone guard script that:
   - Runs `git status --porcelain -- .agents .claude` and fails if the output is non-empty.
   - Treats untracked (`??`), modified (`M`), staged (`A`), and deleted (`D`) entries alike.
   - On failure, prints each differing path and the restore command
     (`git checkout HEAD -- .agents .claude` for tracked changes; `git clean -fd .agents .claude`
     for untracked files; or both, depending on what `--porcelain` reports).
   - Fails closed when git is unavailable (no `.git` directory, git not on PATH) with a clear message
     naming the cause, rather than silently skipping.
   - Exits 0 on a clean tree.

3. **Wire the guard into `vscode:prepublish`** in `package.json`:
   - Change `"vscode:prepublish": "npm run package"` to
     `"vscode:prepublish": "bash scripts/guard-control-plane.sh && npm run package"`.
   - vsce runs `vscode:prepublish` before every `vsce package` call (no `--no-prepublish` flag
     exists — verified). This covers both direct `vsce package` and `scripts/package-targets.sh`
     (which calls `vsce package` per target). The guard runs once per `vsce package` invocation;
     in the matrix build that is 5 times (4 targets + universal), which is cheap (a single
     `git status` call each).

4. **Add a contract test assertion for `.claude/` packaging** in
   `src/test/vsix-packaging-contract.test.js`, mirroring the existing `.agents/` check at `:206`:
   - Walk `.claude/` and assert no file is excluded by the vsce filter.
   - `.claude/` currently ships by default (no `.vscodeignore` rule covers it), but a future
     `.vscodeignore` change could silently exclude it. The guard checks the working tree against
     HEAD; this assertion ensures the tree it checks is the tree that ships.

5. **Add a contract test assertion for the guard itself** in
   `src/test/vsix-packaging-contract.test.js`:
   - Assert that `scripts/guard-control-plane.sh` exists and is executable.
   - Assert that `package.json`'s `vscode:prepublish` script string contains a reference to the
     guard script, so the wiring cannot be silently removed.

6. **Repair the two protocol files the Aug-27 revert missed.** `5cd79357` ("Restore control plane
   to its pre-sync state") restored `.agents/skills/` and the launcher but does **not** contain
   `CLAUDE.md` or `AGENTS.md`. The last commit touching either is `abd36593` — the clobber itself.
   Both therefore still carry pre-cut managed blocks:

   | file | managed block | lines | should be |
   | :--- | :--- | :--- | :--- |
   | `CLAUDE.md` | 49–223 | 173 | 612 chars / 7 lines |
   | `AGENTS.md` | 1–165 | 163 | 612 chars / 7 lines |

   Rewrite each marker-delimited block to `RESIDENT_PROTOCOL_BODY` (`ClaudeCodeMirrorService.ts:148`,
   527 chars of body, 612 with markers). Preserve everything **outside** the markers — `CLAUDE.md`
   lines 1–48 are the hand-authored agent rules (confirmation dialogs, host parity, build, migrations)
   and are not clobber residue. Do not hand-write the body: read the constant so the file cannot drift
   from the code that regenerates it.

   Sequencing matters. This step lands **after** steps 2–3, never before: restoring the blocks while
   the guard is absent resets the clock, and the next activation of a pre-`843bae45` build re-inflates
   them exactly as it did on 25–26 Aug (`AGENTS.md` 616 → 14,296 in one day; `CLAUDE.md`
   2,604 → 4,238 → 22,336 over two). The guard is what makes the repair durable.

7. **Leave the seed loop and the prune untouched.**

### Migration

Build and test tooling only — no schema, settings, stored state, or shipped behaviour change.

## Verification Plan

### Automated Tests

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
10. **`generatedAt` removal is byte-stable.** Activate the extension twice in sequence; assert
    `.agents/.switchboard-bundled.json` and `.claude/.switchboard-generated.json` are identical
    between the two activations (no `generatedAt` field, content is a pure function of the file list).
11. **`.claude/` packaging assertion.** Assert the contract test walks `.claude/` and fails if any
    file would be excluded by the vsce filter.
12. **Protocol blocks match the constant.** Assert the managed block in both `CLAUDE.md` and
    `AGENTS.md` equals `RESIDENT_PROTOCOL_BODY` verbatim (612 chars with markers). This is the
    regression test for step 6 and the standing detector for any future re-inflation — it fails loudly
    on the next clobber instead of letting 18KB of dead protocol sit resident for days.
13. **Content outside the markers survives the repair.** Assert `CLAUDE.md` lines 1–48 (the
    hand-authored agent rules) are byte-identical before and after step 6. The repair must be scoped
    to the managed region; a whole-file rewrite would destroy authored content.

### Goal Invariants

- Assert `scripts/guard-control-plane.sh` exists at the repo root and exits non-zero when
  `git status --porcelain -- .agents .claude` is non-empty.
- Assert `package.json` `vscode:prepublish` contains `guard-control-plane.sh` in its script string.
- Assert the string `generatedAt` is absent from `src/services/ControlPlaneMigrationService.ts`
  manifest object at `:1407-1412` and from `src/services/ClaudeCodeMirrorService.ts` manifest object
  at `:407-414`.
- Assert `src/test/vsix-packaging-contract.test.js` contains a check whose name includes `.claude`
  and asserts no `.claude/` file is excluded by the vsce filter.

## Outstanding Questions

- **[user]** Should the guard also cover `.agents/personas/` and `.agents/protocols/`, or only the
  runtime-written surfaces (skills, workflows)? — proceeding on the assumption that **all** of
  `.agents/` and `.claude/` are in scope, since `git status --porcelain -- .agents .claude` covers
  every file under both trees regardless of subdirectory. A narrower scope would require path
  filtering and would miss a clobber in an unprotected subdirectory.
