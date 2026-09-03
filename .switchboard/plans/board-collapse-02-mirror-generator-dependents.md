# Board Collapse 02 — Retire the Mirror Generator's Dependent Cards

## Goal

The Claude mirror generator is being deleted. Remove the six board cards that exist only to fix, feed or gate it, and rescope the four that merely reference it, so no coder is dispatched to repair machinery that is on its way out.

### Problem analysis

`ClaudeCodeMirrorService.generateClaudeMirror` is 476 lines whose entire transform is adding two YAML lines of frontmatter, driven by a `MIRROR_MANIFEST` with **eight** entries, producing **eight** files under `.claude/skills/`. Operator decision, 2026-09-04: "we dont need a mirror for 4 files." The generator, the manifest and the `mirror:check` CI gate are deleted; the eight `SKILL.md` files are committed as ordinary source, with a drift test asserting each equals its `.agents/` counterpart modulo frontmatter.

The code change is owned by the existing plan *Delete the Claude mirror generator and commit the eight skill files as ordinary bundle assets*, which survives and becomes the winner. What this plan removes is the eight cards' worth of board debt around it: plans that repair a manifest that will not exist, regenerate a mirror that will not be generated, and gate on a check that will be gone.

## Execution rules

1. Card operations go through the board or `.agents/skills/kanban_operations/*.js`. **Never SQL.**
2. Rescoping preserves the plan id and filename.
3. **No git working-tree operation** while this runs. Commits are fine.
4. Deleting a card uses the board's delete path so the `.md` goes with it.
5. Do not touch `src/` — the generator's actual deletion is the surviving plan's job, not this one's.

## Metadata

- **Complexity:** 3
- **Tags:** board-hygiene, control-plane, cleanup

## Proposed Changes

### 1. Delete

- **`mirror:check` is red because the `delegates` skill was never added to MIRROR_MANIFEST** — appends an entry to a manifest being deleted.
- **The mirror generator deletes shipped skill files silently, and its drift check prints the one remedy that causes the deletion** — hardens a prune loop being deleted.
- **Regenerate Claude mirror for switchboard-remote SKILL.md content drift** — regenerating is exactly what stops happening; committing the file resolves the drift.
- **`.claude/ mirror keeps retired skill until next version bump after `.agents/` deletion** — the stale-skill cleanup it repairs lives inside the generator.
- **`mirror:check` must assert that a gated skill carries no source frontmatter** (subtask of *CI Gates That Fail For the Right Reason*) — extends the check being deleted. The invariant it defends, that a non-door skill carries no frontmatter, moves as one assertion into the surviving drift test; record that in the surviving plan before deleting this card.
- The `mirror:generate` npm script and `scripts/generate-claude-mirror.js` proposed by **The create-feature Skill Documents the Link Mechanism That Works Without the Extension** — delete that section from the plan; the rest of the card (the `**Feature:**` frontmatter linking fix) survives and stays on the board.

Deleting these five cards leaves *The .claude/skills Mirror — Register the Orphan Skill and Make Divergence Loud* with no subtasks. Remove the empty feature.

### 2. Rescope

- **Make standalone the first-class entry point** — replaces "edit `.agents/workflows/switchboard.md`, the mirror source, never the generated `.claude/skills/switchboard/SKILL.md`" with "edit both files"; replaces `npm run mirror:check` in its CI-gate list with the drift test.
- **The Protocol Path in Our Own Agent Instructions Points Nowhere** — its analysis describes `mirror:check` regenerating from `MIRROR_MANIFEST` as a gate that passes green over extra directories. Rewrite that paragraph against the committed tree. Its own new whitelist gate over `.agents/skills/` contents is unaffected and survives.
- **Deletion guard and bundle ledger cover all `.agents` surfaces and all copy paths** — drop the mirror-regeneration step; the `deletionSkipped` flag it depends on came from a card deleted above, so restate the condition directly.
- **A feature contains its dependencies** — drop `scripts/check-claude-mirror.js` from its touched files and the "regenerate the mirror and confirm `mirror:check`" verification line (already marked Superseded in the file).

### 3. Record the consequence

- Add one line to the surviving *Delete the Claude mirror generator* plan: it now also carries the no-frontmatter assertion, and its landing removes the `mirror:check` CI step.
- The Red-at-HEAD triage list loses its `mirror:check` item entirely — note this in whichever triage card survives Board Collapse 09, so nobody re-adds it.

## Verification Plan

- `GET /kanban/plans` for New and Planned contains no card whose topic or Goal names `MIRROR_MANIFEST`, `mirror:check` or `generateClaudeMirror` as something to fix, extend or regenerate. The one permitted mention is the surviving deletion plan.
- The feature *The .claude/skills Mirror* no longer exists on the board.
- The create-feature skill card still exists and still carries its `**Feature:**` linking fix.
- Six cards fewer in Planned; `git status` shows only `.switchboard/` changes.
