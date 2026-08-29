# The extension seeds its own source repo, so a stale build overwrites the authoritative control plane

## Goal

Add a single predicate — "is this root the extension's own source tree?" — and skip the seed,
scaffold, prune, and mirror paths when it is true. This breaks the clobber loop at the point of
damage rather than at the point of shipping, so no repair, guard, or revert is needed for it.

### Problem Analysis

**The asymmetry nobody encoded.** The Switchboard repository is two things at once: the **source** of
the control plane, and **a workspace the extension manages**. Every user's repo is only the second.
The extension has no predicate distinguishing them, so on activation it treats its own source tree as
a delivery target and overwrites the authoritative copy with a replica from whatever build happens to
be installed. `grep` for `own repo|self.?exclu|dev.?repo|isExtensionSource|sourceRepo|skipOwnWorkspace`
across `extension.ts` and `ControlPlaneMigrationService.ts` returns nothing. No such guard exists.

**Why a stale build is always in play.** `CLAUDE.md` states that `dist/` is not used during
development or testing and that all testing is done via an installed VSIX. So the code that runs on
the source repo is never the code in `src/` — it is the last VSIX someone installed. Any edit to the
control plane therefore has a window, lasting until the next package-and-install, in which the
running extension considers the committed state wrong and rewrites it. That window is not an edge
case; it is the normal development condition.

**The loop, and where each defence sits.**

| step | what happens | code | caught by |
| :--- | :--- | :--- | :--- |
| 1 | Editor with a stale VSIX activates on the source repo | `extension.ts:326` | — |
| 2 | `.agents/{skills,workflows}` overwritten; `CLAUDE.md`/`AGENTS.md` blocks rewritten | `:344-347`, `:353-357` | **this plan** |
| 3 | A commit captures the damage as ordinary history | — | block-equality test |
| 4 | `.vscodeignore:57` `!.agents/**` ships the tree; next VSIX carries it | packaging | `packaging-must-refuse-a-clobbered-control-plane.md` |

The packaging plan catches step 4 — after the damage exists and has been committed. This plan
prevents step 2, so steps 3 and 4 have nothing to propagate. Both are worth having; only this one
stops the damage occurring.

**The measured cost of not having it.** `abd3659` took `.agents/skills/` from 17 files to 69,
returning `<available_skills>` to ~91 entries from the 4 the protocols migration achieved, with 22
names duplicated. It also rewrote the `CLAUDE.md` and `AGENTS.md` managed blocks to their pre-cut
form; `5cd79357` restored `.agents/` but not those two files, so both carried ~18KB of dead protocol —
including `send_message`, `view_file` and role-routing material describing tools the host does not
have — as resident context for every agent run in the repo. `AGENTS.md` went 616 → 14,296 chars in a
single day; `CLAUDE.md` went 2,604 → 4,238 → 22,336 over two. The shrink commits (`843bae45`,
`248cf309`) were correct and landed; they were undone by activation, not by a decision.

### Root Cause

Delivery and authorship share a filesystem location, and the delivery mechanism has no way to
recognise that it is standing on the source. Everything downstream — the ledger, the deletion guard,
the prune discriminator, the packaging assertion — is a consequence of that one missing distinction.

### Non-goals

- **Not the standalone wiring gap.** `src/standalone/` calls none of `seedBundleSurface`,
  `generateClaudeMirror`, or `pruneRetiredBundleFiles`. That is a separate, larger plan. The predicate
  here lands in shared code so a later standalone wiring inherits it rather than reintroducing the bug.
- **Not the mirror removal** (`delete-the-claude-mirror-generator.md`).
- **Not the packaging guard** (`packaging-must-refuse-a-clobbered-control-plane.md`) — complementary,
  and it carries the repair of the two clobbered protocol files.
- **Not a confirmation gate.** Per `CLAUDE.md`, no `confirm()`-style prompt is added anywhere.

## Metadata

**Complexity:** 4
**Tags:** infrastructure, reliability, bugfix
**Feature:** d84a2df3-59d5-4f57-a894-26291e9625ae

## User Review Required

No — the predicate is self-referential and requires no user decision. The one open question
(dogfooding a clone as a real workspace) is handled by leaving the Setup button as the
deliberate path.

## Complexity Audit

### Routine

- A two-condition predicate: parse two `package.json` files, compare `name` and `publisher`,
  check a file exists. All standard `fs` operations.
- An early return at the top of `refreshWorkspaceControlPlane` with one log line.
- Skipping `setLastCopiedAgentVersion` on the skip path (one `if` guard).

### Complex / Risky

- **`cleanupLegacyAgentFiles` at `:961` is NOT inside `refreshWorkspaceControlPlane`.** The early
  return does not cover it. An old install activating on the source repo still deletes 19 hardcoded
  legacy paths. This plan must also guard the `:961` loop, or the source-repo protection is
  incomplete. See proposed change 5.
- **The `src/services/ControlPlaneMigrationService.ts` existence check is a hardcoded path.** A
  rename during a refactor silently disables the predicate. A self-test asserting
  `isExtensionSourceRepo` returns `true` for the current repo catches this at CI time rather than
  at clobber time.
- **Fail-open on malformed `package.json` is asymmetric.** For a user workspace, fail-open (seed
  normally) is the safer default. For the source repo, fail-open means the predicate cannot
  recognise itself and seeds. The source repo's `package.json` is authored and tracked, so this is
  academic — but the packaging guard is the backstop, not this plan.

## Edge-Case & Dependency Audit

**Race conditions**
- None. The predicate is a read-only check that runs before any write. Two IDEs activating
  simultaneously on the source repo both skip — no conflict.

**Security**
- None. A local filesystem check, no new surface.

**Side effects**
- The source repo no longer receives automatic control-plane delivery. Developers who relied on
  activation to sync `.agents/` must use the Setup button or `git pull`. This is strictly better
  than overwriting authored content from a stale build.
- `cleanupLegacyAgentFiles` no longer runs on the source repo. Legacy files that should be retired
  must be removed by a commit, not by activation. This is the correct trade-off — the source repo
  is authored, not managed.

**Dependencies & conflicts**
- Complements `an-older-install-downgrades-the-control-plane-on-every-activation.md`: that plan
  protects all workspaces from older versions; this plan protects one repo from all versions. Both
  add early returns to `refreshWorkspaceControlPlane` — this plan's check should run first (broader
  predicate: skip all delivery for this repo), then the version check.
- Both this plan and the downgrade guard need to gate `cleanupLegacyAgentFiles` at `:961`. The
  cleanest approach: a shared helper that combines both predicates (is-source-repo OR
  is-downgrade), called per-root inside the `:961` loop.
- Complements `packaging-must-refuse-a-clobbered-control-plane.md`: that plan is the backstop. This
  plan prevents the clobber at activation; the packaging guard catches it if this plan's predicate
  fails (e.g. after a service-file rename).

## Dependencies

- **Sequenced after or alongside** `an-older-install-downgrades-the-control-plane-on-every-activation.md`
  — both add early returns to `refreshWorkspaceControlPlane`; this plan's check runs first, then
  the version check. Both gate `cleanupLegacyAgentFiles` at `:961`.
- **Sequenced before** `packaging-must-refuse-a-clobbered-control-plane.md` — the packaging guard
  is the backstop; this plan is the primary prevention. The protocol-file repair inside the
  packaging plan depends on this plan's guard being in place so the repair is durable.
- **Independent of** `delete-the-claude-mirror-generator.md` — the mirror removal does not touch
  the source-repo predicate.

## Adversarial Synthesis

Key risks: (1) `cleanupLegacyAgentFiles` at `:961` is in the activation body, not inside
`refreshWorkspaceControlPlane`, so the early return does not cover it — an old install on the
source repo still deletes legacy paths; mitigated by adding a guard at `:961` (proposed change 5);
(2) the `ControlPlaneMigrationService.ts` path check is a hardcoded string that a refactor can
silently break — mitigated by a self-test asserting the predicate matches the current repo; (3)
fail-open on malformed `package.json` is safe for users but unsafe for the source repo — academic,
the packaging guard is the backstop. Mitigations are wired into the proposed changes, not left as
advice.

## Proposed Changes

1. **Add `isExtensionSourceRepo(root, extensionPath)` to `ControlPlaneMigrationService`.** Shared
   code, not `extension.ts`, so both composition roots can consult it. True when **both** hold:
   - `<root>/package.json` parses and its `name` (and `publisher`, when present) equal those of the
     running extension's own `package.json`, read from `extensionPath`. Self-referential — no
     hardcoded `"switchboard"` string to drift.
   - `<root>/src/services/ControlPlaneMigrationService.ts` exists.

   Both conditions together cannot plausibly match a user workspace. Requiring both means a user who
   happens to name a package `switchboard` is unaffected. Fail **open** on a parse error or unreadable
   `package.json` — return `false`, i.e. treat it as an ordinary workspace and seed normally. A
   fail-closed default would silently stop delivering the control plane to real users on a malformed
   file, which is a worse failure than the one being fixed.

2. **Guard the three automatic activation paths** in `extension.ts`, all inside
   `refreshWorkspaceControlPlane`:
   - `:344` and `:346` — skip both `seedBundleSurface` calls.
   - `:353-357` — skip `scaffoldProtocolLayers` (which carries `ensureAgentsProtocol`,
     `ensureClaudeProtocol`, and `generateClaudeMirror`).
   - `:405` — skip `pruneRetiredBundleFiles`.

   Return early from the function rather than guarding each call, so a future call added to the same
   function is covered by default instead of needing its own guard. Log one line to the output channel
   naming the skip and the reason.

3. **Do NOT stamp the version on the skipped path.** `setLastCopiedAgentVersion` must not run when the
   refresh was skipped. Stamping would record "this version has been applied" for work that was
   deliberately not done, so a later legitimate change of heart (or a clone used as a real workspace)
   would see a satisfied stamp and skip again.

4. **Leave the explicit Setup path (`:4455`) working.** That call site is a deliberate user click in
   the Setup panel, not silent activation. A developer testing scaffolding needs it. Log that the
   target is the source repo so the effect is visible in the output channel. The packaging guard is
   the backstop if a click leaves the tree dirty.

5. **Guard `cleanupLegacyAgentFiles` at `:961` for the source-repo case.** This loop is in the
   activation body, not inside `refreshWorkspaceControlPlane`, so the early return in change 2
   does not cover it. An old install activating on the source repo would still delete 19 hardcoded
   legacy paths. Gate the `:961` loop on `isExtensionSourceRepo` per-root — if the root is the
   source repo, skip `cleanupLegacyAgentFiles` for that root. This composes with the downgrade
   guard's per-root gating: a shared helper that checks (is-source-repo OR is-downgrade) per root
   is the cleanest approach, so both predicates are consulted in one place.

6. **Add a self-test asserting the predicate matches the current repo.** Assert
   `isExtensionSourceRepo(process.cwd(), extensionPath)` returns `true` when run in the source
   repo. This catches a rename of `ControlPlaneMigrationService.ts` at CI time rather than at
   clobber time — the hardcoded path in the predicate is a drift risk that the test makes visible.

## Verification Plan

1. **The source repo is untouched by activation.** Activate against a fixture that satisfies both
   predicate conditions. Assert `.agents/`, `CLAUDE.md`, and `AGENTS.md` are byte-identical before and
   after — the direct regression test for `abd3659`.
2. **A real workspace still gets everything.** Activate against a fixture with a `workspace-id` and no
   `package.json` name match. Assert `.agents/skills`, `.agents/workflows`, `.claude/skills/`, and both
   managed blocks are created exactly as today. This is the test that proves the guard is narrow.
3. **Both conditions are required.** Assert a fixture with a matching `package.json` name but no
   `src/services/ControlPlaneMigrationService.ts` is treated as an ordinary workspace, and vice versa.
4. **Fail-open on malformed input.** Assert an unparseable or unreadable `<root>/package.json` yields
   `false` and normal seeding, not a skip.
5. **No stamp on skip.** Assert `.switchboard/.agent_version.json` is not created or modified when the
   refresh is skipped.
6. **Self-reference, not a literal.** Assert the predicate reads the extension's own `package.json`
   rather than comparing against a hardcoded name, so a rename cannot silently disable it.
7. **The loop is broken end to end.** Install a deliberately stale VSIX over the repaired source tree,
   activate, and assert `git status --porcelain -- .agents .claude CLAUDE.md AGENTS.md` is empty. This
   is the scenario that produced `abd3659`; it must now be a no-op.
8. **Both hosts.** The predicate lives in shared code and is unit-tested there directly. Standalone
   wires none of these seams today, so the expected result for that host is "no behaviour change" —
   record it as such, and do not read a green `npm run standalone-parity:check` as parity evidence,
   since it is scoped to the browser read-back path rather than the composition root.
9. **`cleanupLegacyAgentFiles` is skipped for the source repo.** Place all 19 legacy paths in a
   fixture's `.agents/`, activate against a fixture satisfying the predicate, and assert every one
   still exists. Spy on `cleanupLegacyAgentFiles` to confirm it was not invoked for that root.
10. **Self-test matches the current repo.** Assert `isExtensionSourceRepo(process.cwd(),
    extensionPath)` returns `true` when run in the source repo, so a rename of
    `ControlPlaneMigrationService.ts` fails CI rather than silently disabling the guard.

### Goal Invariants

- Assert `isExtensionSourceRepo` returns `true` when `<root>/package.json` name matches the
  extension's own `package.json` AND `<root>/src/services/ControlPlaneMigrationService.ts` exists.
- Assert `isExtensionSourceRepo` returns `false` when only one of the two conditions holds.
- Assert `isExtensionSourceRepo` returns `false` on malformed or unreadable `<root>/package.json`.
- Assert `cleanupLegacyAgentFiles` is not invoked for a root where `isExtensionSourceRepo` returns
  `true`.
- Assert `setLastCopiedAgentVersion` is not called when `refreshWorkspaceControlPlane` returns early
  due to the source-repo predicate.

## Outstanding Questions

- **[user]** Should a clone of the Switchboard repo that someone genuinely uses *as* a Switchboard
  workspace (board, plans, dispatch — dogfooding) still receive the control plane? Proceeding on the
  assumption **no**: the repo already contains the authoritative `.agents/`, so skipping delivery
  leaves it strictly better off than overwriting it from a stale build. If dogfooding needs the seed,
  the Setup button (step 4) remains the deliberate path.
