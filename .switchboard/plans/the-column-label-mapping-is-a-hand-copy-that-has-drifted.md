# The column label→id mapping is hand-copied into a skill, and it has drifted from the code three ways

<!-- board-collapse-03 -->
> **RESCOPED AND SEQUENCED 2026-09-04 (Board Collapse 03, decision 13).** A correction first: this plan pins the **label-to-id table**, not a SQL table. Every agent needs that table whichever way it reads the board — the per-column exports, the endpoint responses and the database all speak storage ids while the operator speaks labels — so the table and its contract test are **kept**.
> > 
> > **Sequencing:** *Three skills instruct agents to use POSIX-only tooling* lands **first** and removes this skill's SQL templates in favour of the Node helper and the board endpoint. Re-anchor this plan on the rewritten file at implementation time; its current line citations will be stale.
> > 
> > **Edit:** delete any wording that presents the storage ids as values for a SQL `WHERE` clause. Keep the three drift fixes (the `DISPATCH` row that should read `STAGING`, the stale nine-column valid list, the wrong label), keep deleting the duplicate valid-columns list so there is one table not two, and keep the pointer to `GET /kanban/columns` as the authority for custom columns. Edit the `.agents/` and `.claude/` copies directly — the mirror generator is being deleted.


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
(`src/services/agentConfig.ts:181`) carries `id` and `label` on one row per column, and `resolveColumnLabel`
(`:231`) is documented as *"The ONE column-ID → UI-label resolver. Every agent-facing surface
(state-file export, `GET /kanban/columns`, write-path canonicalization) consumes this so the mapping
cannot drift."* That claim holds for **code** paths. It does not cover prose, and prose is what the
agent reads first.

> **Superseded:** The original analysis cited `agentConfig.ts:150` for `DEFAULT_KANBAN_COLUMNS`, `:200`
> for `resolveColumnLabel`, and `:158` for the `ACCEPTANCE TESTED` label, and used the bare path
> `agentConfig.ts`.
> **Reason:** Those line numbers are stale (the file shifted as code was added above) and the path is
> wrong — the file lives at `src/services/agentConfig.ts` (the very skill under repair uses the correct
> path at its own line 102). A plan whose thesis is "hand-copied references rot" had itself rotted.
> **Replaced with:** `src/services/agentConfig.ts:181` (`DEFAULT_KANBAN_COLUMNS`), `:231`
> (`resolveColumnLabel`), and `:190` (the `ACCEPTANCE TESTED` → `Completion Tested` label). Verified
> against the current tree. The substance of the three drifts below is unchanged — they are real.

**Three drifts, all live:**

| # | what the skill says | what the code says |
| :--- | :--- | :--- |
| 1 | `DISPATCH` is a display mode of `PLAN REVIEWED` (`:82`) | `DISPATCH` was retired by `52404992`, *"Replace DISPATCH display mode with real STAGING column"* — and **`STAGING` is absent from the table entirely** |
| 2 | Valid columns are `CREATED, BACKLOG, PLAN REVIEWED, CONTEXT GATHERER, LEAD CODED, CODER CODED, CODE REVIEWED, CODED, COMPLETED` (`:68`) | `CONTEXT GATHERER` no longer exists (it survives only as a deprecated-id migration target in `KanbanDatabase.migrateDeprecatedColumns` / `extension.ts:709`); `RESEARCHER`, `STAGING`, `INTERN CODED`, `ACCEPTANCE TESTED`, `TICKET UPDATER` are all missing from this line |
| 3 | `ACCEPTANCE TESTED`'s label is **"Acceptance Tested"** (`:88`) | its label is **"Completion Tested"** (`src/services/agentConfig.ts:190`) |

**Drift 2 makes the file contradict itself.** Line 68 lists nine columns; the table twenty-one lines
later lists twelve, and they disagree. An agent reading top-down meets the stale list first, and the
skill's own instruction — *"Map it and move on — never reply that a column 'doesn't exist'"* — turns
a wrong mapping into a confident wrong answer rather than a question.

**Drift 3 is the one that reaches the user.** An agent told the label is "Acceptance Tested" will say
that back to someone whose board reads "Completion Tested". The id resolves either way, so nothing
fails; the user is simply told the wrong name for their own column.

**The drift is duplicated across two hosts.** `ClaudeCodeMirrorService`
(`src/services/ClaudeCodeMirrorService.ts`) copies each `.agents/skills/<name>/SKILL.md` verbatim into
`.claude/skills/<name>/SKILL.md` as the Claude Code discovery layer. The committed
`.claude/skills/query-kanban/SKILL.md` mirror carries the **identical three drifts** (same `DISPATCH`
row at `:89`, same stale valid-columns line at `:75`, same "Acceptance Tested" label at `:95`). Because
the mirror only regenerates on extension activation, a fresh clone reads the stale mirror until then.
A fix that touches only the `.agents` source leaves the Claude Code host reading wrong column names
while the source-side test is green.

### Root Cause

`resolveColumnLabel` guarantees consistency across every surface that *calls* it. A markdown table
calls nothing, so it was outside the guarantee from the day it was written — and the file says as much
in its own last line, which is a correct disclaimer standing in for a check. The mirror compounds this:
two prose copies, neither derived, both outside the guarantee.

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
- **Not rewriting `kanban-list.js` or workflow-prose column mentions.** `.agents/scripts/kanban-list.js`
  is a legacy session-derivation script (reads `plan_registry.json`, uses `out/`, collapses
  `LEAD CODED`/`CODER CODED`→`CODED` by design) — not an agent-facing label→id table. Skills like
  `kanban_operations`, `switchboard-mission-control`, and persona files name columns in workflow prose.
  None are mapping tables; the drift guard targets the mapping-table construct only.

## Metadata

**Complexity:** 4
**Tags:** docs, reliability, bugfix, test

> **Superseded:** Complexity 3.
> **Reason:** The plan touches two doc surfaces (the `.agents` source and the `.claude` mirror), writes
> a contract test that must parse a markdown mapping-table construct from both, merge three code maps,
> and compare on id+label with a precisely-scoped "no other stale copy" sweep. Multi-file, moderate
> logic, and the test's target definition is the load-bearing risk. That is a 4, not a 3.
> **Replaced with:** Complexity 4.

## User Review Required

- Confirm the intended fix surface is **both** the `.agents` source and the committed `.claude` mirror.
  The mirror is generated by `ClaudeCodeMirrorService`, so an alternative is to fix only the source and
  rely on the next mirror regeneration to propagate — but the committed mirror stays stale on fresh
  clones until activation, so this plan fixes both now. If you prefer to fix only the source and let
  regeneration handle the mirror, say so before implementation.

## Complexity Audit

### Routine
- Three doc corrections (row swap, line rewrite, label fix) in a markdown table — mechanical edits.
- Deleting one redundant valid-columns line.
- Adding one `test:contract:<name>` npm script entry — follows the 140-script pattern in `package.json`.

### Complex / Risky
- The drift-guard test must parse the `| Board label | kanban_column |` mapping-table construct out of
  markdown and compare it to the union of three code maps (`DEFAULT_KANBAN_COLUMNS`, `DISPLAY_MODE_COLUMNS`,
  `LEGACY_COLUMN_LABELS`) on both id and label, in both directions (no missing, no extra). Parsing
  markdown tables with regex is fiddly and the construct must be defined precisely or the sweep cries wolf.
- The test must cover the optional `.claude` mirror (present on this clone, absent on a clean install
  that never enabled Claude Code scaffolding) without failing when it is absent.
- `AUTOCODE` (a `DISPLAY_ONLY_COLUMN_LABELS` entry that fans out three-to-one) must be asserted absent
  from the table by name — a generic "no extras" check is not enough to communicate the intent.

## Edge-Case & Dependency Audit

- **Race Conditions:** None. The test reads files and code maps at test time; no concurrent writers.
- **Security:** None. No secrets, no network, no untrusted input. The test is a static read.
- **Side Effects:** The doc edits change what agents read and what they tell users about column names.
  Drift 3's fix means an agent will say "Completion Tested" instead of "Acceptance Tested" — correct,
  but a visible behavior change for users who learned the old (wrong) name. No data is touched.
- **Dependencies & Conflicts:**
  - Depends on `DEFAULT_KANBAN_COLUMNS` / `DISPLAY_MODE_COLUMNS` / `LEGACY_COLUMN_LABELS` /
    `DISPLAY_ONLY_COLUMN_LABELS` remaining the code source of truth. If a future refactor moves the
    column definitions, the test's import path must follow.
  - The `.claude` mirror depends on `ClaudeCodeMirrorService` continuing to copy `SKILL.md` verbatim.
    If the mirror format ever diverges (e.g. frontmatter rewriting), the mirror-parse arm of the test
    must track it.
  - `staging-column-contract.test.js` already pins `DISPATCH` out of the code maps; this plan's test
    pins `DISPATCH` out of the doc table. Complementary, not conflicting.

## Dependencies

- None. No `sess_XXXXXXXXXXXXX` dependencies.

## Adversarial Synthesis

Key risks: (1) the test as originally scoped reads only the `.agents` source, so the `.claude` mirror —
the surface a Claude Code agent actually reads — can stay stale while the test is green (goal-vs-appearance
gap); (2) verification point 6's "any column list" sweep is over-broad and would flag legacy scripts and
workflow prose, training maintainers to mute a noisy guard. Mitigations: the test parses both source and
mirror-when-present; the sweep is narrowed to the `| Board label | kanban_column |` mapping-table
construct, with `kanban-list.js` and prose mentions explicitly out of scope.

## Proposed Changes

### `.agents/skills/query-kanban/SKILL.md`
- **Context:** The agent-facing label→id table (`:77-90`) and the standalone valid-columns line (`:68`)
  are the drifted surfaces for the Antigravity host.
- **Logic / Implementation:**
  1. Replace the `DISPATCH` row (`:82`) with a `STAGING` row: `| **Staging** | \`STAGING\` |` (no
     display-mode annotation — `STAGING` is a first-class peer column, `kind: 'staging'`, order 115).
  2. Rewrite the `:68` valid-columns line to match `DEFAULT_KANBAN_COLUMNS` exactly, **or delete it**
     per change 2 below (preferred — one list, not two).
  3. Fix the `ACCEPTANCE TESTED` row's board-label cell (`:88`) from `Acceptance Tested` to
     `Completion Tested` to match `src/services/agentConfig.ts:190`.
  4. Add a `CODED` row annotated `*(legacy alias of \`LEAD CODED\`)*` if the table does not already carry
     it — `LEGACY_COLUMN_LABELS` includes it and the test's union will require it.
- **Edge Cases:** `BACKLOG` (display mode of `CREATED`) is already present and correctly annotated;
  leave it. Do **not** add `AUTOCODE` — it is a `DISPLAY_ONLY_COLUMN_LABELS` entry that fans out
  three-to-one and a one-to-one table listing it would invite the silent wrong-column pick
  `_canonicalColumnId` deliberately refuses.

### `.claude/skills/query-kanban/SKILL.md`  *(mirror — new to this pass)*
- **Context:** `ClaudeCodeMirrorService` copies `SKILL.md` verbatim from `.agents` to `.claude`; the
  committed mirror currently carries the identical three drifts (`:89`, `:75`, `:95`). It only
  regenerates on extension activation.
- **Logic / Implementation:** Apply the same three corrections as the `.agents` source. Fixing the
  source alone leaves the Claude Code host reading wrong names on a fresh clone until activation; fix
  both now so the tree is correct independent of activation, and so the mirror-arm of the test passes.
- **Edge Cases:** Do not assume the mirror exists on every clone — the test must tolerate its absence.
  On this clone it exists and is stale; on a clean install that never enabled Claude Code scaffolding
  it will not.

### `src/test/kanban-column-label-drift-contract.test.js`  *(new file)*
- **Context:** The drift guard. Same shape as the sibling contract tests
  (`staging-column-contract.test.js`, `link-presets-mirror-contract.test.js`) — a standalone node
  script using `assert` / `fs` / `path` with `process.cwd()` as root, run via its own
  `test:contract:<name>` npm script.
- **Logic / Implementation:**
  1. Import the four code maps from `src/services/agentConfig.ts` (or read the source text and evaluate
     the exported constants, matching the pattern used by `staging-column-contract.test.js` which reads
     file text to avoid a build dependency). Build the expected set:
     `DEFAULT_KANBAN_COLUMNS` (id→label) ∪ `DISPLAY_MODE_COLUMNS` (id→label) ∪ `LEGACY_COLUMN_LABELS`
     (id→label).
  2. Parse the `| Board label | \`kanban_column\` |` mapping-table construct out of
     `.agents/skills/query-kanban/SKILL.md` (regex on the table rows between the header separator and
     the next blank line / heading). Extract `(label, id)` pairs, stripping `*(...)*` annotations.
  3. Assert the parsed set equals the expected set on **both** id and label — no missing, no extra.
  4. **If** `.claude/skills/query-kanban/SKILL.md` exists, parse its table the same way and assert it
     equals the expected set (equivalently, assert it equals the `.agents` parsed set). Absent mirror
     → skip this arm, do not fail.
  5. Assert `AUTOCODE` is absent from both parsed tables by name (the forbidden extra).
  6. Assert `DISPATCH` is absent from both parsed tables by name (the retired id).
  7. Sweep arm: scan `.agents/` and `.claude/` for any **other** file containing the mapping-table
     construct (a `| Board label | \`kanban_column\` |`-style header), and assert any such table equals
     the expected set. This is the permanent form of change 5's sweep. **Scope:** the mapping-table
     construct only — not any column-name mention. `kanban-list.js` and workflow-prose column mentions
     are out of scope by construct definition.
- **Edge Cases:**
  - The table cells carry inline annotations like `*(display mode of \`CREATED\`)*`; the parser must
    strip these before comparing labels, or every annotated row mismatches.
  - `BUILT_IN_AGENT_LABELS` (`:175`) labels the tester *role* `Acceptance Tester` — that is the agent
    label, not the column label, and must NOT be conflated with the column label `Completion Tested`.
    The test compares column labels only.
  - The test must fail on the current tree (three known drifts) and pass after the corrections — this
    is the precondition for it testing anything (Verification Plan point 1).

### `package.json`
- **Context:** Each contract test has its own `test:contract:<name>` script (140 exist); there is no
  aggregator.
- **Logic / Implementation:** Add
  `"test:contract:kanban-column-label-drift": "node --require ./src/test/bootstrap/sandboxStateHome.js src/test/kanban-column-label-drift-contract.test.js"`
  alongside the other `test:contract:*` entries.

### `.agents/skills/query-kanban/SKILL.md` — live-lookup pointer  *(strengthen)*
- **Context:** The pointer to `GET /kanban/columns` (`:99-103`) is correct but understated about scope.
- **Logic / Implementation:** Make explicit that the resident table covers **built-ins only** and that
  `GET /kanban/columns` is the answer whenever a board is reachable (it returns custom columns too) —
  so the resident copy is a fallback with a stated scope, not an alternative source of truth. Keep the
  existing "if this table disagrees with that file, the file wins" disclaimer; the new test now enforces it.

## Verification Plan

> **Note:** Per session directives, compilation and automated tests are NOT executed in this run. The
> checks below remain the plan's verification contract and are to be run by the implementer.

### Automated Tests
1. **The table matches the code.** The test from the new file, run against the current tree — it must
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
5. **`AUTOCODE` stays out.** Assert the display-only label is not in the label→id table — by name —
   since it fans out to three columns and a one-to-one table listing it would invite exactly the
   silent wrong-column pick `_canonicalColumnId` deliberately refuses.
6. **No other stale mapping-table copy remains.** The sweep arm asserts no other file under `.agents/`
   or `.claude/` contains the `| Board label | \`kanban_column\` |` mapping-table construct with a
   table that disagrees with the code — the change 5 sweep, made permanent and narrowly scoped to the
   construct (not any column-name mention).
7. **The `.claude` mirror is covered when present.** On this clone the mirror exists and is stale;
   assert the mirror-arm of the test fails before the mirror fix and passes after. On a clone without
   the mirror, the arm skips without failing.

### Goal Invariants
- **Positive:** `src/test/kanban-column-label-drift-contract.test.js` exists and asserts the
  `.agents/skills/query-kanban/SKILL.md` mapping table equals the union of `DEFAULT_KANBAN_COLUMNS` +
  `DISPLAY_MODE_COLUMNS` + `LEGACY_COLUMN_LABELS` on id and label.
- **Negative:** no `DISPATCH` row and no `CONTEXT GATHERER` token exist in the
  `.agents/skills/query-kanban/SKILL.md` mapping table or its valid-columns line.
- **Positive:** a `STAGING` row exists in the `.agents/skills/query-kanban/SKILL.md` mapping table.
- **Negative:** the standalone valid-columns line (`:68` form) is absent from
  `.agents/skills/query-kanban/SKILL.md`.
- **Paired (mirror):** the `ACCEPTANCE TESTED` row's board-label cell reads `Completion Tested` in
  `.agents/skills/query-kanban/SKILL.md` (positive: correct label *here*); and when
  `.claude/skills/query-kanban/SKILL.md` exists, the same cell reads `Completion Tested` there too
  (positive: resolvable *there*) — paired with the negative that no `Acceptance Tested` board-label
  cell remains in either file's mapping table.

## Recommendation

Complexity 4 → **Send to Coder**.
