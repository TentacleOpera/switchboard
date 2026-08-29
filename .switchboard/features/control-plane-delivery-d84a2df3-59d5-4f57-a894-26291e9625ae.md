---
description: 'Control-plane delivery — guard it, then simplify it'
---

# Control-plane delivery — guard it, then simplify it

**Complexity:** 5

## Goal

Make the delivery of `.agents/` and `.claude/` safe, then make it smaller. The extension writes its
control plane into every workspace on activation, and three separate holes let that write destroy work:
an older install overwrites a newer control plane on every activation, the extension seeds its own
source repo as though it were a user workspace, and packaging re-ships whatever got written. The fourth
subtask removes a generator that delivery does not need once the first three make delivery trustworthy.

Measured damage from these holes: `abd3659` took `.agents/skills/` from 17 files to 69, returned the
CLI skill block to roughly 91 entries from the 4 the protocols migration achieved, and rewrote the
`CLAUDE.md` and `AGENTS.md` managed blocks to their pre-cut form — where they remain, because the
revert that repaired `.agents/` did not touch those two files.

## How the Subtasks Achieve This

- **An older install downgrades the control plane on every activation**: the refresh decision is
  `currentVersion !== lastVersion`, with no ordering anywhere, and the seed loop is not gated on it at
  all — so an old install overwrites `.agents/` every time it activates. Adds a dotted-numeric compare,
  skips on a strict downgrade, and moves the gate ahead of the seed rather than leaving it on the
  scaffold.
- **The extension must not seed its own source repo**: adds the predicate that does not exist —
  is this root the extension's own source tree — and returns early from the refresh when it is. Prevents
  the damage at the point it happens rather than at the point it ships.
- **Packaging must refuse a clobbered control plane**: the backstop, catching a clobber before it is
  packaged into the next build. Also carries the repair of the two protocol files the 27 August revert
  missed, sequenced after the guard so the repair is durable rather than a reset clock.
- **Delete the Claude mirror generator**: 476 lines whose entire transform is two lines of YAML
  frontmatter, running over content the seed loop placed seconds earlier. Commits the eight mirrored
  files as source and delivers them through the same seed surface, removing a second ledger from the
  user's repository.

<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->
## Subtasks
- [ ] [Packaging accepts a clobbered .agents/, so a stale control plane launders itself into the next build](../plans/packaging-must-refuse-a-clobbered-control-plane.md) — **PLAN REVIEWED** — ID: d8d3ea12-a3c8-4e8f-8b1e-198bb24cfaff
- [ ] [An older install overwrites the control plane on every activation, so opening the repo in a second IDE downgrades it](../plans/an-older-install-downgrades-the-control-plane-on-every-activation.md) — **PLAN REVIEWED** — ID: b5fcf774-754a-4188-bd7d-05a5c7c01679
- [ ] [Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets](../plans/delete-the-claude-mirror-generator.md) — **PLAN REVIEWED** — ID: 6c25a1e1-7b7a-4002-a9a3-f4aca43d1412
- [ ] [The extension seeds its own source repo, so a stale build overwrites the authoritative control plane](../plans/the-extension-must-not-seed-its-own-source-repo.md) — **PLAN REVIEWED** — ID: 8633bcba-169c-4b9f-ab30-cd5d8cd617db
<!-- END SUBTASKS -->

## Dependencies & sequencing

Ship the two prevention subtasks before the packaging guard: guarding the package while activation
still clobbers means the guard fires constantly on damage that should not exist. The downgrade guard
comes first — it is a shipped bug affecting any user with two editors, where the source-repo guard
protects one repository.

The protocol-file repair inside the packaging subtask must land after that subtask's own guard, never
before; the 25–26 August history shows an unguarded repair being undone within a day.

The mirror removal is independent and may ship at any point. Its one open question — whether `.claude/`
is already packaged — is answered inside the packaging subtask, so sequencing it after that subtask
saves a verification step.

## Team Dispatch Instructions

### An older install overwrites the control plane on every activation, so opening the repo in a second IDE downgrades it
- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - Downgrade activation (1.6.0 over stamp 1.7.13) leaves `.agents/`, `CLAUDE.md`, `AGENTS.md`, `.claude/skills/` byte-identical
  - `seedBundleSurface` not invoked on skip path (spy, not file state inference)
  - Same-version repair still works (corrupt a bundled skill, activate same version, assert restored)
  - `cleanupLegacyAgentFiles` skipped per-root on downgrade (spy confirms not invoked; legacy files persist)
  - Comparison unit tests pass: `1.7.13 > 1.7.9` (numeric not lexicographic), `1.10.0 > 1.9.99`, unknown → deliver
- **Must not touch:** None specified.

### The extension seeds its own source repo, so a stale build overwrites the authoritative control plane
- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - Source repo untouched by activation (`.agents/`, `CLAUDE.md`, `AGENTS.md` byte-identical before and after)
  - Real workspace still gets full delivery (`.agents/skills`, `.agents/workflows`, `.claude/skills/`, managed blocks created)
  - Both predicate conditions required (name match alone or source file alone → treated as ordinary workspace)
  - `cleanupLegacyAgentFiles` skipped for source repo (spy confirms not invoked for that root)
  - Self-test: `isExtensionSourceRepo` returns `true` for the current repo
- **Must not touch:** None specified.

### Packaging accepts a clobbered .agents/, so a stale control plane launders itself into the next build
- **Seat:** Coder (complexity 4)
- **Acceptance:**
  - `vsce package` (not just `npm test`) refuses a clobbered `.agents/` tree with an actionable message naming differing paths and the restore command
  - Untracked files (`??`) and deletions (`D`) fail the guard, not just modifications
  - Clean tree (`.agents` and `.claude` matching HEAD) packages successfully; unrelated dirt under `src/` does not block
  - `generatedAt` absent from both ledger manifests; activating twice produces byte-identical ledgers
  - Protocol blocks in `CLAUDE.md` and `AGENTS.md` match `RESIDENT_PROTOCOL_BODY` verbatim; hand-authored content outside markers preserved
- **Must not touch:** The seed loop (`seedBundleSurface`, `pruneRetiredBundleFiles`) must not be modified. No ledger hashes, sidecars, or merge policy.

### Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets
- **Seat:** Coder (complexity 5)
- **Acceptance:**
  - Eight `.claude/skills/*/SKILL.md` files byte-identical before and after; drift test asserts each matches `.agents/` counterpart modulo frontmatter
  - `mergePermissionsAllowList` called after generator deletion (`.claude/settings.json` has Switchboard allow entries; user entries preserved)
  - Both `generateClaudeMirror` call sites removed (`extension.ts:4106` and `ControlPlaneMigrationService.ts:743`); zero grep matches outside the deleted function
  - `.claude/.switchboard-generated.json` absent from committed tree; archived as `.migrated.bak` at runtime on upgrade
  - `seedBundleSurface` accepts `claude-skills` surface and writes to `.claude/` destination root; ledger key is `claude-skills/<posix-rel>`
- **Must not touch:** Do not wire the standalone composition root — this plan must not deepen the standalone wiring gap.
