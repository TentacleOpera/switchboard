# The column label→id mapping is hand-copied into a skill, and it has drifted from the code three ways

## Goal

Stop maintaining the column label→id mapping by hand. `agentConfig.ts` is the source of truth and
`resolveColumnLabel` is already the single resolver; the copy in `query-kanban/SKILL.md` has drifted,
contradicts itself, and is what agents actually read. Assert the doc against the code so drift fails a
test instead of misleading an agent.

### Problem Analysis

**The mapping is not missing — it is duplicated.** `CLAUDE.md`'s resident block warns that *"Displayed
column labels differ from the stored IDs, so hand-written SQL silently returns nothing"* and points at
the `query-kanban` skill, which does carry a full label→id table (`SKILL.md:77-89`). The complaint that
no mapping exists is really that the mapping lives in a hand-maintained copy rather than being derived.

**The source of truth is already singular and already correct.** `DEFAULT_KANBAN_COLUMNS`
(`agentConfig.ts:150`) carries `id` and `label` on one row per column, and `resolveColumnLabel`
(`:200`) is documented as *"The ONE column-ID → UI-label resolver. Every agent-facing surface
(state-file export, `GET /kanban/columns`, write-path canonicalization) consumes this so the mapping
cannot drift."* That claim holds for **code** paths. It does not cover prose, and prose is what the
agent reads first.

**Three drifts, all live:**

| # | what the skill says | what the code says |
| :--- | :--- | :--- |
| 1 | `DISPATCH` is a display mode of `PLAN REVIEWED` (`:80`) | `DISPATCH` was retired by `52404992`, *"Replace DISPATCH display mode with real STAGING column"* — and **`STAGING` is absent from the table entirely** |
| 2 | Valid columns are `CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED` (`:68`) | `CONTEXT GATHERER` no longer exists; `RESEARCHER`, `STAGING`, `INTERN CODED`, `ACCEPTANCE TESTED`, `TICKET UPDATER` are all missing |
| 3 | `ACCEPTANCE TESTED`'s label is **"Acceptance Tested"** (`:87`) | its label is **"Completion Tested"** (`agentConfig.ts:158`) |

**Drift 2 makes the file contradict itself.** Line 68 lists nine columns; the table twenty-one lines
later lists twelve, and they disagree. An agent reading top-down meets the stale list first, and the
skill's own instruction — *"Map it and move on — never reply that a column 'doesn't exist'"* — turns
a wrong mapping into a confident wrong answer rather than a question.

**Drift 3 is the one that reaches the user.** An agent told the label is "Acceptance Tested" will say
that back to someone whose board reads "Completion Tested". The id resolves either way, so nothing
fails; the user is simply told the wrong name for their own column.

### Root Cause

`resolveColumnLabel` guarantees consistency across every surface that *calls* it. A markdown table
calls nothing, so it was outside the guarantee from the day it was written — and the file says as much
in its own last line, which is a correct disclaimer standing in for a check.

### Non-goals

- **Not renaming columns.** `Coder` is a better header than `CODER CODED`, and the ids are load-bearing
  across the database, the state exports and every plan file's history. Divergent label and id is the
  right design; an undocumented, drifting copy of the mapping is the defect.
- **Not removing the table.** A live `GET /kanban/columns` lookup is the authoritative path, but it
  requires a running board — and a resident table is what lets an agent map a label in a cloud session
  with no board at all. Keep it; make it verified.
- **Not touching `_canonicalColumnId`.** The write path already accepts ids, slugs and labels, already
  prefers built-in ids over labels so a custom column cannot shadow `CREATED`, and already refuses
  many→one display labels like `AUTOCODE` rather than guessing. It is correct.

## Metadata

**Complexity:** 3
**Tags:** docs, reliability, bugfix

## Proposed Changes

1. **Correct the three drifts** in `.agents/skills/query-kanban/SKILL.md`: replace the `DISPATCH` row
   with `STAGING`, rewrite the `:68` valid-columns line to match `DEFAULT_KANBAN_COLUMNS`, and fix
   `ACCEPTANCE TESTED`'s label to `Completion Tested`.

2. **Delete the standalone valid-columns line.** It is a second, lossier statement of what the table
   below already says — and being terser, it is what drifted furthest. One list, not two.

3. **Add a test asserting the table matches the code.** Parse the label→id table out of the skill and
   assert it equals `DEFAULT_KANBAN_COLUMNS` plus `DISPLAY_MODE_COLUMNS` plus `LEGACY_COLUMN_LABELS`,
   on both label and id, with no extra and no missing rows. This is the mechanism the file's own
   closing disclaimer describes but cannot enforce: *"if this table ever disagrees with that file, the
   file wins and this table is stale."*

   Same shape as the drift guards in the sibling plans — the mirror plan's body-match assertion, the
   front-door plan's route-existence assertion. The pattern is: prose that restates code gets a test,
   or it rots.

4. **Keep the live-lookup pointer and strengthen it.** The table already names `GET /kanban/columns` as
   authoritative for custom columns. Make it explicit that the table covers built-ins only and the
   endpoint is the answer whenever a board is reachable — so the resident copy is a fallback with a
   stated scope rather than an alternative source of truth.

5. **Fix any other copies the test finds.** Run the same comparison across `.agents/` and `.claude/`
   before writing the test, and fold any other hand-copied column list into it. A second stale copy
   elsewhere would make this fix cosmetic.

## Verification Plan

1. **The table matches the code.** The test from change 3, run against the current tree — it must
   **fail** before the change 1 corrections and pass after. A test that passes on a tree with three
   known drifts is testing nothing.
2. **A new column breaks the test.** Add a fictional column to `DEFAULT_KANBAN_COLUMNS` in a fixture
   and assert the test fails. This is the regression the plan exists to prevent: the next column added
   without touching the skill.
3. **A renamed label breaks the test.** Change one `label` in the fixture and assert failure — drift 3
   was a label-only mismatch that no id-based check would have caught.
4. **Display modes and legacy aliases are covered.** Assert `BACKLOG` (display mode of `CREATED`) and
   `CODED` (legacy alias of `LEAD CODED`) are both present and correctly annotated, since they are in
   neither `DEFAULT_KANBAN_COLUMNS` nor each other's map.
5. **`AUTOCODE` stays out.** Assert the display-only label is not in the label→id table — it fans out
   to three columns, and a one-to-one table listing it would invite exactly the silent wrong-column
   pick `_canonicalColumnId` deliberately refuses.
6. **No other stale copy remains.** Assert no other file under `.agents/` or `.claude/` contains a
   column list that disagrees with the code — the change 5 sweep, made permanent.
