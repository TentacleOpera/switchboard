# Fix `_regenerateFeatureFile` splice so it collapses to exactly one `## Subtasks` block

## Goal

Make `KanbanProvider._regenerateFeatureFile` always leave a feature `.md` with **exactly one** auto-generated `<!-- BEGIN SUBTASKS -->` … `<!-- END SUBTASKS -->` block, healing any pre-existing duplicate/orphan blocks in the same pass. Today the splice can *append* a fresh block instead of *replacing* the old one, so blocks accrete on every regeneration.

### Problem (observed 2026-07-07)

The feature `global-override-workspace-project-settings-scoping-4cc4569d…md` accumulated **five** stacked `## Subtasks` blocks — one showing PLAN REVIEWED, one CODE REVIEWED, one `(no subtasks)`, another CODE REVIEWED, and one LEAD CODED — each a stale snapshot from a different point in the feature's life. The board reads subtask membership from the DB (`plans.feature_id`), so the display was unaffected, but the file itself is corrupt and grows without bound. This file has been manually collapsed to one block already; this plan fixes the code so it cannot recur (in this or any of the ~4,000 installs' feature files).

### Root cause

`src/services/KanbanProvider.ts` (locate by symbol — line numbers drift; this was `~10245–10255` on 2026-07-07):

```ts
const beginMarker = '<!-- BEGIN SUBTASKS';
const endMarker = '<!-- END SUBTASKS -->';
const beginIdx = existingContent.indexOf(beginMarker);   // FIRST begin
const endIdx   = existingContent.indexOf(endMarker);     // FIRST end — INDEPENDENT of begin
if (beginIdx !== -1 && endIdx !== -1) {
    newContent = existingContent.slice(0, beginIdx) + subtaskSection + existingContent.slice(endIdx + endMarker.length);
} else {
    newContent = existingContent.replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n';
}
```

Two independent `indexOf` calls. The splice is only correct when the **first** `END` belongs to the **first** `BEGIN`. It breaks when the file contains an **orphan block** — a `## Subtasks … <!-- END SUBTASKS -->` region with *no* `<!-- BEGIN SUBTASKS -->` before it. Then `endIdx` (the orphan's END) is **less than** `beginIdx` (the first real BEGIN), and:

- `slice(0, beginIdx)` keeps everything up to the first BEGIN — including the entire orphan block, and
- `slice(endIdx + len)` re-appends everything after the orphan's END — including every real block that followed.

The new section is inserted between the two, and **nothing is removed** → one extra block per regen. Once one orphan `END`-before-`BEGIN` exists, the file grows on every subsequent regeneration (column change, subtask assign/detach, etc.). The observed file went 1,156 → 5,119 → 6,795 bytes across three commits this way.

**Seed of the orphan block:** a `## Subtasks … <!-- END SUBTASKS -->` written *without* the `<!-- BEGIN SUBTASKS -->` opener. Candidate producers are the LLM-authored feature-refinement paths that are only *told to preserve* the block — `agentPromptBuilder.ts:565` and `PlanningPanelProvider.ts:6237,6259` — plus any older regen format. The fix must not assume how the orphan arose; it must be robust to a malformed/duplicated existing block.

### The same bug exists in the WORKTREES splice

The `<!-- BEGIN WORKTREES -->` block a few lines below (`~10284–10292`) uses the identical independent-`indexOf` shape and has the identical latent defect. Fix both in one pass so worktree blocks can't accrete either.

## Metadata

**Complexity:** 4
**Tags:** bugfix, backend, reliability, feature-files

## User Review Required

None. Two decisions are made in-plan rather than deferred:
1. **Strip-all-then-insert-one** (not "fix the two `indexOf` calls"): a minimal `indexOf(endMarker, beginIdx)` fix would stop *new* accretion but leave the orphan block and any already-accreted duplicates in place. Stripping all blocks and writing one heals existing corruption on the next natural regen — strictly better and the same code path.
2. **Lazy healing, no directory sweep:** healing happens on each feature's next `_regenerateFeatureFile` call. Do **not** add a startup `regenerateAllFeatureFiles` sweep — that rewrites every feature `.md` at once and courts the file-churn / refresh-storm failure class. The byte-identical-skip already in the method means untouched files stay untouched.

## Complexity Audit

### Routine
- Replacing the subtask splice with strip-all-then-insert-one — one self-contained region of one private method.
- Applying the same shape to the WORKTREES splice.

### Complex / Risky
- **Insertion position must be preserved.** The subtasks block currently lives *between* `## Dependencies & sequencing` and `## Review Findings`. Naive "strip all + append at end" would drop it *after* Review Findings. The replacement must insert the single block at the offset of the earliest removed block (captured before stripping), falling back to append-at-end only when the file has no existing block at all (first-ever generation). This preserves today's layout.
- **Regex must catch three shapes:** (a) well-formed `BEGIN…END` pairs, (b) orphan `## Subtasks…END` with no BEGIN, and (c) any dangling lone `BEGIN` or `END` marker left after (a)/(b). Then collapse the doubled blank lines the removals leave behind.

## Edge-Case & Dependency Audit

### Correctness / idempotency
- **Byte-identical skip is preserved.** The existing content-no-op guard (skip write when generated == existing) must remain, so a healthy single-block file produces no write and does not re-fire the watcher. Note: the *first* heal of an accreted file **will** write once (content changes from N blocks to 1) — expected and correct; subsequent regens are no-ops.
- **Empty subtask set** still renders the `- [ ] (no subtasks)` placeholder inside one properly-marked block.
- **Feature with no existing block** (first generation) appends one block, as today.

### Race conditions
- No new race. The method already wraps its write with `GlobalPlanWatcherService.registerPendingCreation(featureAbsPath)` to suppress the self-write re-import, and the byte-identical skip breaks the regen self-loop. Strip-all changes only the string transform between read and write.

### Shipped-state / migration
- **No schema migration.** The `.md` marker format is unchanged; only the number of blocks changes (many → one). The block is fully derived from the DB, so collapsing duplicates loses no source-of-truth data.
- **Install base (~4,000):** any feature file that already accreted duplicates self-heals on its next regen. No forced migration; no data at risk (worst case, a stale file keeps showing duplicates until its feature is next touched).

### Side effects
- One regen call also rewrites the `## Worktrees` block and refreshes the `**Complexity:**` marker (unchanged behavior). The WORKTREES fix means a previously-accreted worktrees block also collapses to one on next regen.

## Dependencies

None. Self-contained within `KanbanProvider._regenerateFeatureFile`. Complements — does not depend on — `feature_plan_20260706_delete-subtask-regenerates-feature-md.md` (that plan wires the delete/detach *callers* to invoke this regenerator; it assumes the regenerator's output is correct, which is exactly the assumption this plan repairs). Landing both gives correct output *and* correct invocation.

## Proposed Changes

### `src/services/KanbanProvider.ts` — `_regenerateFeatureFile`: replace the subtask splice

Replace the independent-`indexOf` splice with strip-all-then-insert-one:

```ts
const subtaskSection = `<!-- BEGIN SUBTASKS (auto-generated, do not edit) -->\n## Subtasks\n${subtaskLines.join('\n') || '- [ ] (no subtasks)'}\n<!-- END SUBTASKS -->`;

// Capture where the first existing block starts, so the replacement lands in place
// (between "Dependencies & sequencing" and "Review Findings"), not appended at EOF.
const firstBeginIdx = existingContent.search(/(^|\n)\s*(<!-- BEGIN SUBTASKS|##\s*Subtasks\b)/);

// Strip EVERY existing subtask block: well-formed BEGIN…END pairs, orphan
// "## Subtasks … END" regions with no BEGIN, then any dangling lone markers.
let stripped = existingContent
    .replace(/<!-- BEGIN SUBTASKS[\s\S]*?<!-- END SUBTASKS -->/g, '')
    .replace(/##\s*Subtasks\b[\s\S]*?<!-- END SUBTASKS -->/g, '')   // orphan block (no BEGIN)
    .replace(/<!-- (?:BEGIN|END) SUBTASKS[^\n]*-->/g, '')            // any dangling marker
    .replace(/\n{3,}/g, '\n\n');                                    // collapse gaps left behind

let newContent;
if (firstBeginIdx !== -1) {
    // Re-insert one block at the (now-shifted) position of the old first block.
    const anchor = stripped.search(/\n##\s*Review Findings\b/); // prefer just before Review Findings
    if (anchor !== -1) {
        newContent = stripped.slice(0, anchor).replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n' + stripped.slice(anchor);
    } else {
        newContent = stripped.replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n';
    }
} else {
    // No block existed at all → first-ever generation: append.
    newContent = existingContent.replace(/\n*$/, '') + '\n\n' + subtaskSection + '\n';
}
```

Implementer notes:
- Anchor on `## Review Findings` when present (it must stay last); otherwise append. This is more robust than trusting the pre-strip offset, which shifts as blocks are removed.
- Keep the non-greedy `*?` so each `BEGIN…END` matches its own `END`, and keep the `/g` flag so **all** blocks go.
- Leave the downstream WORKTREES handling operating on `newContent` exactly as today.

### `src/services/KanbanProvider.ts` — same method: fix the WORKTREES splice

Apply the identical strip-all-then-insert-one shape to the `<!-- BEGIN WORKTREES -->` region (currently independent `indexOf(wtBeginMarker)` / `indexOf(wtEndMarker)`), so worktree blocks cannot accrete via an orphan either.

## Files touched

- `src/services/KanbanProvider.ts` — rewrite the subtask block splice and the worktree block splice inside `_regenerateFeatureFile` (locate by symbol; do not trust line numbers).

## Verification Plan

No automated tests / no compile this pass (project convention: test via installed VSIX; `src/` is source of truth; `dist/`/`out/` not used in dev). If a regression test is added later, the natural shape is: seed a feature `.md` pre-populated with an **orphan** `## Subtasks…END` block plus two real `BEGIN…END` blocks, call `regenerateFeatureFile`, and assert the result has exactly one `<!-- BEGIN SUBTASKS -->`, one `<!-- END SUBTASKS -->`, one `## Subtasks`, the correct current statuses, and `## Review Findings` still last.

Manual (installed VSIX):
1. **Heal existing corruption** — take a feature file with multiple stacked blocks (or hand-craft one with an orphan block), trigger any regen (move a subtask column, or assign/detach a subtask), confirm it collapses to exactly one block in the correct position (before Review Findings).
2. **No new accretion** — move the same feature's cards through several columns; confirm the block count stays at one and statuses update.
3. **Byte-identical skip** — trigger a regen with no actual change; confirm the file is not rewritten (mtime unchanged) and the watcher does not re-fire.
4. **Empty set** — detach the last subtask; confirm one block with `- [ ] (no subtasks)` and markers intact.
5. **First generation** — create a fresh feature; confirm exactly one block is added.
6. **Worktrees** — repeat 1–2 for a feature that has worktrees; confirm the `## Worktrees` block also collapses to one.

---

**Recommendation:** Complexity 4 (Mostly routine, one positional-insertion subtlety) → **Send to Coder.**
