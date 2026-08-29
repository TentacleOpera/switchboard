---
description: 'Control-plane delivery — guard it, then simplify it'
---

# Control-plane delivery — guard it, then simplify it

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
- [ ] (no subtasks)
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
