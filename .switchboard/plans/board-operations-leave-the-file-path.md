# Board Operations Leave the File Path

## Goal

Remove the file-write path for board *operations* — creating a feature, carrying membership — and
leave exactly one way to change board state: the verb rail. Plan **arrival** by file stays untouched;
that is ingestion, and it is how plans are meant to reach the board. What goes is the fallback that
performs a board operation by writing markdown when the API is unreachable.

### Problem analysis

**The premise the fallback was built on no longer holds.** `create-feature.js`'s offline path
(`:73`, `viaDirectFile`) exists so a cloud agent with no reachable board could still create a
feature, by writing `.switchboard/features/<slug>-<uuid>.md` with a `<!-- BEGIN SUBTASKS -->` block
for the watcher to ingest. That made sense when the board was an editor extension on someone's
laptop. It is moot now: `switchboard tailnet` serves the board on loopback **and** this machine's
Tailscale address, so any agent on the tailnet reaches the verb rail directly. The operator's
framing, 2026-09-15: *"the board's own remote focus now makes that moot — you don't need to be
running a cloud agent with an always on remote board."*

**The file path enforces none of the invariants the verb path does.** Observed today:

- `setProjectForPlansInvariant` rejects a direct subtask project change (a subtask's project is
  governed by its feature) and cascades feature → subtasks. A `**Project:**` line in a file does
  neither.
- `assignSelectedToProject` routes through that invariant. Writing the pin by hand bypasses it.
- A feature file's body is **not re-read after initial import**, so editing an existing feature file
  changes nothing — and the writer sees a successful `writeFileSync` either way. A board operation
  that silently no-ops while reporting success is the worst available outcome.

**The safe model already exists in-tree, in five of six scripts.** `assign-to-feature.js`,
`delete-feature.js`, `remove-from-feature.js`, `split-feature.js` and `reconcile-features.js` all
contain **zero** `writeFileSync` calls and fail loudly instead — `assign-to-feature.js:87` is the
template: *"Extension not reachable — no safe direct-DB fallback for feature assignment."*
`create-feature.js` is the sole exception, and it is the one that taught an agent the file path was
acceptable.

**The documentation teaches it too.** The `manage-features` skill's **Create** section is an
explicit remote-session fallback: write the feature file directly, with format notes, filename
convention, and a warning that subtask linking will have to happen later. An agent following that
skill correctly still takes the path that enforces nothing.

**A residual hole even after the fallback goes.** `**Feature:**` is applied **apply-if-empty** on
import (`PlanIngestionEngine.ts:3137`, `KanbanProvider.ts:16554`), so it is not limited to newly
arriving plans — any *existing* card whose `feature_id` is empty can be reassigned by editing its
file. That is how 24 already-imported plans were bulk-assigned to features on 2026-09-15: a board
mutation, performed entirely through file writes, with no verb involved and no invariant consulted.

### Root cause

"Plans arrive as files" and "board state is mutated through verbs" are two correct rules that share
one mechanism: the import watcher. Because the watcher must read metadata off an arriving plan, the
same metadata became a lever for mutating plans that had already arrived — and because a missing
board was once a real condition, a write-the-file fallback was added on top. Neither decision was
wrong when made; together they leave a second, unguarded way to change board state that no gate
watches.

## Metadata

**Tags:** refactor, reliability, cli, docs
**Complexity:** 4
**Repo:** switchboard

## User Review Required

No. The operator set the direction: remove the file-write operations, because the board's remote
focus makes the cloud-agent premise moot.

## Settled Design

- **The line is arrival versus mutation.** A `.md` file appearing in the plans directory is
  ingestion and stays exactly as it is — CLAUDE.md is explicit that plans reach the board on their
  own and that no agent should import one. Creating a feature, or changing what an existing card
  belongs to, is a board operation and goes through a verb.
- **`create-feature.js` loses `viaDirectFile` and fails loudly**, matching the five sibling scripts
  that already do. The error names the board and how to reach it; it does not offer a workaround.
- **The `manage-features` skill loses its Create-by-file section.** Documentation that teaches the
  unguarded path is as load-bearing as the code that implements it.
- **`**Feature:**` and `**Project:**` become arrival metadata only** — applied on INSERT, not on
  update of a row that already exists. This keeps a plan able to declare its feature as it arrives,
  and closes the bulk-reassign hole without touching ingestion.
- **No replacement fallback is added.** If the board is unreachable, that is the answer: start it.
  The failure must be loud and actionable, never a second path that quietly does less.
- **Not in scope: the board-instruction-file design.** `cloud-agent-fills-and-pushes-board-instructions`
  (BACKLOG) is a different, deliberate mechanism — an instruction file plus a receipt, not a silent
  fallback. It rests on the same premise the operator called moot and should be re-decided, but that
  is its own call and not this plan's to make.

## Complexity Audit

### Routine
- Deleting `viaDirectFile` and its call site.
- Deleting the skill section.

### Complex / Risky
- **Tightening apply-if-empty to apply-on-insert changes ingestion behaviour**, which is the one
  area this plan otherwise promises not to touch. It must be verified against a plan arriving for
  the first time *with* a `**Feature:**` line — the legitimate case — and against a re-import of an
  unchanged file, which must remain a no-op.
- **Something may depend on the fallback.** Grep for callers before deleting; a caller that silently
  relied on the offline path will start failing, which is correct but must be a deliberate, named
  break rather than a surprise.
- **`create-feature.js` returns `ok:true` on a blank feature today** (the docblock notes the
  extension deliberately allows zero linked subtasks). Removing the fallback must not change that
  contract by accident.

## Edge-Case & Dependency Audit

- **Race conditions.** None; this removes a path rather than adding one.
- **Security.** Mildly positive — one fewer way to mutate board state without passing the verb
  allowlist.
- **Side effects.** Any workflow that currently creates features with the board down stops working.
  That is the intent, and it must be stated in the release note rather than discovered.
- **Dependencies & conflicts.**
  - `create-feature-skill-documents-the-frontmatter-carrier.md` (PLAN REVIEWED, active) — **this
    plan supersedes its remaining scope.** That plan's stated purpose is to *document* the
    `**Feature:**` frontmatter carrier for remote agents and to flip "never commit the feature file"
    to "commit it in remote sessions". Both instructions teach the path being removed here. It
    should be retired or rewritten when this lands, not implemented alongside it.
  - `cloud-agent-fills-and-pushes-board-instructions.md` (BACKLOG) — same premise, different
    mechanism. Flagged above as out of scope.
  - `f78bb9e6` *The Feature File Is a Faithful Projection of the Database* — reinforced by this
    plan: once the file is never a write path, "projection" is unambiguous.
  - `aef9bed6` *Scaffolding Installs a CLI Dependency It Never Checks* — adjacent. Both narrow the
    ways an agent can proceed without a reachable board.

## Adversarial Synthesis

**Risk summary.** The deletions are small and well-precedented — five sibling scripts already behave
the way this plan asks the sixth to. The real risk is the apply-if-empty tightening, which touches
ingestion, the one path this plan otherwise leaves alone; get it wrong and a plan arriving with a
legitimate `**Feature:**` line lands unattached, which is silent. The second risk is
documentation drift: deleting the code while leaving the skill section, or vice versa, leaves an
agent following instructions into a path that no longer exists. The third is that removing a
fallback always looks like a regression to whoever hits it, so the error message is part of the
deliverable, not decoration.

## Proposed Changes

### Change A — `create-feature.js` stops writing files

#### `.agents/skills/kanban_operations/create-feature.js`
- **Logic:** delete `viaDirectFile` (`:73-150`) and the fallback branch that calls it (`:161-170`).
  On an unreachable board, return `ok:false` with a message naming the board and how to start it —
  mirroring `assign-to-feature.js:87-91`.
- **Edge case:** the `ok:true`-with-zero-subtasks contract is unrelated and must not change.

### Change B — the skill stops teaching it

#### `manage-features` skill (`~/.claude/skills/manage-features/SKILL.md` and any repo copy)
- **Logic:** delete the **Create** (remote file write) section. In **Create from Plans**, replace the
  "fall back to the Create section" instruction with "the board must be running".
- **Edge case:** the **Rearrange** section's remote column of its primitives table also documents
  file-based membership (`**Feature:**` in the metadata block). Same treatment — these are the same
  path under another heading.

### Change C — membership metadata becomes arrival-only

#### `src/services/PlanIngestionEngine.ts` (`:3137`) and the sibling carrier in `KanbanProvider.ts` (`:16554`, `:16613`)
- **Logic:** apply `**Feature:**` / `**Project:**` on INSERT only. On a row that already exists,
  ignore both — the verb rail owns membership from that point on.
- **Edge case:** a plan file deleted and re-added is an INSERT again, so it re-declares. Acceptable,
  and worth a comment so it is not read as a leak.
- **Edge case:** confirm the feature-creation verb path does not itself rely on the update-time
  application to link subtasks — if it does, it must link through the DB, not via the file.

### Change D — the superseded plan is retired

- **Logic:** `create-feature-skill-documents-the-frontmatter-carrier.md` teaches the removed path.
  Retire it, or rewrite it to document that the carrier is arrival-only. Do not leave it in
  PLAN REVIEWED where it will be dispatched and re-add what this plan removes.

## Verification Plan

### Automated Tests
1. **No file-write fallback survives.** No script under `.agents/skills/kanban_operations/` calls
   `writeFileSync` on a path under `.switchboard/features/`. Fails today on `create-feature.js`.
2. **Unreachable board fails loudly.** With no board listening, `create-feature.js` exits non-zero
   with a message naming how to start one, and creates no file.
3. **Arrival still works.** A new plan file carrying `**Feature:** <id>` imports and links. The
   ingestion path is untouched — this is the guard on Change C.
4. **Re-assignment by file is refused.** Editing `**Feature:**` on a plan already on the board does
   **not** move it. Fails today; this is the hole used to bulk-assign 24 cards.
5. **The skill teaches one path.** No `manage-features` section instructs writing a feature file
   directly.

### Goal Invariants
1. `create-feature.js` contains no `writeFileSync`. *(Paired positive: it still reaches the board
   over HTTP and still creates features when one is running — the write path is removed, not the
   script.)*
2. Every script under `.agents/skills/kanban_operations/` that cannot reach the board returns a
   failure naming the board; none writes a file instead.
3. The `manage-features` skill contains no instruction to create or link a feature by writing a
   file.
4. `**Feature:**` and `**Project:**` are applied only when the plan row is being inserted.
5. `create-feature-skill-documents-the-frontmatter-carrier.md` is no longer in a dispatchable
   column, or no longer instructs agents to use the frontmatter carrier for membership.
