# The manage-features Skill Stops Teaching the File Path

<!-- board-collapse-02 -->
> **RESCOPED 2026-09-04 (Board Collapse 02).** The `mirror:generate` npm script and
> `scripts/generate-claude-mirror.js` were deleted from this plan — the generator was being removed,
> not given a second entry point. That half is void and is not restated below.

> **REWRITTEN 2026-09-15.** This plan's central change — make the `**Feature:**` frontmatter
> carrier the *primary documented* way to link subtasks — is **reversed**. See the superseded
> callout under Defect A. What remains is the commit guidance, two invariants, and removing the
> instructions that send an agent down the file path.

## Goal

Bring the feature skill in line with the system as it now is: the board is the only way to change
board state, and the file path is being removed. Delete the sections that tell an agent to link
subtasks by writing frontmatter, fix the stale "do not commit" instruction, and state the two
invariants an agent gets wrong.

### Problem analysis

**The skill this plan was written against no longer exists.** It targeted
`.agents/skills/create-feature/SKILL.md`. That skill has been consolidated into
`manage-features`, which now carries Create, Create from Plans, Group and Rearrange in one file.
Every path below is re-pointed. `scripts/generate-claude-mirror.js` does not exist (correctly — the
2026-09-04 rescope removed it); `scripts/check-claude-mirror.js` remains as the drift guard.

**Defect A — reversed.**

> **Superseded:** *"Rewrite 'Linking Existing Plans as Subtasks' so the frontmatter carrier is the
> primary method, since it is the one that works in the situation this skill exists for."*
> **Reason:** the situation that justified it is gone. The carrier was the answer to "a cloud agent
> cannot reach the board", and `switchboard tailnet` now serves the board on loopback **and** the
> machine's Tailscale address, so any agent on the tailnet reaches the verb rail directly. The
> operator settled this on 2026-09-15: the file-write operations are being removed
> (`board-operations-leave-the-file-path.md`), because the file path enforces none of the invariants
> the verb path does — `setProjectForPlansInvariant` rejects a direct subtask project change and
> cascades feature→subtasks; a hand-written line does neither — and because a feature file's body is
> not re-read after import, so editing one is a silent no-op that still reports a successful write.
> Promoting the carrier to the primary documented method would teach the exact path being deleted.
> **Replaced with:** the skill documents **one** way to link subtasks — through the board — and says
> plainly that an unreachable board is an error to fix, not a case to work around. The sentence that
> produced the empty feature still goes; it is replaced by "start the board", not by frontmatter.

**Defect A′ — what is actually wrong with the skill today.** Three passages still send an agent to
the file path, all in `.agents/skills/manage-features/SKILL.md`:

- `:113-114` — *"note that subtask linking will need to be done when VS Code is next opened, OR the
  user can drag-and-drop in the kanban UI."* This is the original defect and is still there: the
  section whose premise is "the board is unreachable" tells the agent linking is impossible. It is
  wrong for a new reason now — the board is reachable; start it.
- `:469-470` — the Rearrange primitives table's remote column instructs writing `**Feature:**` and
  `**Project:**` into the metadata block, and removing the `**Feature:**` line to detach.
- `:480` — *"remote: file + `**Feature:**` line → move to PLAN REVIEWED"*.

**Defect B — unchanged and still valid.** `:130-132` still says:

> Do NOT commit or push — creating a feature is a planning action. Leave the new
> file in the working tree for the user. (The features folder will be tracked once
> `expose-features-folder-in-gitignore.md` is deployed.)

That plan deployed and is gone. `.gitignore:63` carries the explicit `!.switchboard/features/`
negation and feature files are tracked today. The parenthetical describes a pre-deployment state,
and the instruction it justifies leaves a remote agent's work uncommitted in an ephemeral container.

**Where the fix goes.** `.agents/` is the source of truth; `.claude/skills/` is generated.
`scripts/check-claude-mirror.js` regenerates from `.agents/` and fails CI on drift — its header names
the reason: *"the exact failure mode behind the 'skill fixes don't stick' bug this guard
backstops."* Hand-editing the `.claude` copy turns `mirror:check` red, and it is the likely wrong
move because it is the copy an agent reads.

### Root cause

The skill was written when an unreachable board was a normal condition, so it documented a way to
work around one. The board became reachable from anywhere on the tailnet and the workaround was
never retired — it hardened into the documented method, and this plan was about to promote it
further.

## Metadata

**Feature:** 497b83ac-da27-4cc9-b862-dbe37ed3718b
**Complexity:** 2
**Tags:** docs, bugfix

## User Review Required

No. Both open questions are settled. The commit-policy question is answered by `.gitignore:63` —
feature files are tracked, so "leave it uncommitted" loses a remote session's work. The linking
question is settled by `board-operations-leave-the-file-path.md`.

## Complexity Audit

### Routine
- Editing markdown in one skill file and regenerating its mirror.
- Grep-based verification that the stale claims are gone.

### Complex / Risky
- **Three separate passages teach the file path**, in two different sections (Create, Rearrange).
  Fixing the famous one at `:113` and leaving the Rearrange table at `:469` leaves the path fully
  documented under another heading.
- **Sequencing with `board-operations-leave-the-file-path.md`.** That plan removes
  `create-feature.js`'s `viaDirectFile` fallback; this one removes the documentation pointing at it.
  Either order works, but landing only this one leaves a working fallback nobody is told about, and
  landing only that one leaves instructions for a path that now fails.

## Edge-Case & Dependency Audit

- **Race conditions / security.** None; documentation.
- **Side effects.** An agent that currently produces a feature with the board down will start
  failing. That is intended and must be a clear error, not a silent empty feature.
- **Dependencies & conflicts.**
  - `board-operations-leave-the-file-path.md` — removes the code path this plan stops documenting.
    This plan is that plan's Change B, kept here because this card already exists and is scoped to
    this skill.
  - `cloud-agent-fills-and-pushes-board-instructions.md` (BACKLOG) — same premise, different
    mechanism; out of scope for both.
  - `check-claude-mirror.js` — the drift guard. Unchanged; the mirror must be regenerated, not
    hand-edited.

## Adversarial Synthesis

Small and low-risk, with two traps. The first is partial removal: three passages teach the file path
and only one is famous, so a fix that reads well against the reported symptom can leave the
mechanism fully documented in the Rearrange table. The second is replacing the deleted sentence with
nothing — an agent that hits an unreachable board needs to be told to start it, or it will invent a
workaround, which is how the original section came to exist.

## Proposed Changes

### `.agents/skills/manage-features/SKILL.md`

**Context:** source-of-truth skill. The `.claude/skills/manage-features/` mirror is generated.

1. **`:113-114` — delete the "linking must wait for VS Code" sentence.** Replace with: linking
   requires a running board; if `switchboard api GET /health` does not answer, start it
   (`switchboard local` or `switchboard tailnet`) and retry. Do not offer a file-based alternative.
2. **`:469-470`, `:480` — remove the remote/file column from the Rearrange primitives.** Membership
   is changed through the board only. Keep the local commands; drop the `**Feature:**`-by-file
   instructions and the "remove the line to detach" row.
3. **`:130-132` — fix "After Writing".** Drop the stale gitignore parenthetical and the blanket
   "do NOT commit". `.switchboard/features/` is tracked; a remote container is ephemeral, so
   uncommitted work is lost work. A local session may leave the file for review; a remote session
   commits it with the plans it groups.
4. **State the two invariants** where linking is described, not only under Filename Convention:
   - A feature's UUID lives **only** in its filename. A body-line UUID that disagrees links nothing.
   - Never write a `**Plan ID:**` line into a plan body — it is never parsed; the importer keys
     identity by file path.
5. **Note that `.agents/` is source of truth** and `.claude/skills/` is generated, so the next agent
   asked to fix a skill edits the right file. Prefer a shared skill-authoring home if one exists —
   it applies to every skill, not this one.

### `.claude/skills/manage-features/SKILL.md`

Regenerate from `.agents/`; do not hand-edit. Commit both in the same commit — one without the other
is the drift `check-claude-mirror.js` exists to catch.

## Verification Plan

### Automated Tests

1. **`npm run mirror:check` is green** after the edit and regeneration.
2. **The two copies differ only by the generated YAML frontmatter.**
3. **No skill teaches file-based membership.** Grep every skill for `**Feature:**` used as a linking
   instruction; assert none remains. Covers all three passages, not just `:113`.
4. **No skill says linking must wait for VS Code**, or that a user should drag-and-drop instead.
5. **No skill repeats the stale gitignore claim** — in `manage-features` or anywhere it was copied.
6. **`.switchboard/features/` is still tracked** (`.gitignore:63` negation present, `git ls-files`
   non-empty), so the commit guidance is not justified by a state that has since changed back.
7. **Read-through as the target reader.** Follow the revised skill with the board **stopped** and
   assert it ends in a clear "start the board" error — not an empty feature, and not a file written
   to `.switchboard/features/`.

### Goal Invariants

1. `.agents/skills/manage-features/SKILL.md` contains no instruction to write `**Feature:**` or
   `**Project:**` into a plan file to change membership. *(Paired positive: it still documents
   `assign-to-feature.js` and the board endpoints, so linking is documented — through one path.)*
2. It contains no sentence stating that subtask linking requires VS Code or must wait for it.
3. It contains no reference to `expose-features-folder-in-gitignore`, and no blanket "do NOT commit".
4. It states both invariants: the UUID lives only in the filename, and `**Plan ID:**` is never
   written.
5. `.claude/skills/manage-features/SKILL.md` differs from the `.agents/` copy only by frontmatter.
