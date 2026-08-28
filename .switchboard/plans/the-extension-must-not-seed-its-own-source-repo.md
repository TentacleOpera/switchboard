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

## Outstanding Questions

- **[user]** Should a clone of the Switchboard repo that someone genuinely uses *as* a Switchboard
  workspace (board, plans, dispatch — dogfooding) still receive the control plane? Proceeding on the
  assumption **no**: the repo already contains the authoritative `.agents/`, so skipping delivery
  leaves it strictly better off than overwriting it from a stale build. If dogfooding needs the seed,
  the Setup button (step 4) remains the deliberate path.
