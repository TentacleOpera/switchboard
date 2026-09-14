# A Reviewer Defers What It Should Fix, and Escalates Backwards

## Goal

Three defects in the review stage, which share one cause: a reviewer that finds something wrong
has only two exits — fix it now, or write it into `## Deferred Findings` and move on — and no
forward exit at all. Give it a third: an `ESCALATED` column that sits *after* `CODE REVIEWED`, so
a card blocked on an author decision advances into a visible waiting state instead of being thrown
back to `PLAN REVIEWED`. Then make deferral a decision the reviewer has to justify rather than a
free action, and make the size of what it deferred legible without opening the plan file.

### Problem analysis

**Defect 1 — obvious, cheap fixes are deferred rather than applied.**

`fixStep` (`agentPromptBuilder.ts:2145-2147`) is the entire fix mandate. In non-delegation mode it
is one sentence: *"Apply code fixes for valid CRITICAL/MAJOR findings."* In delegation mode it adds
a ~100-line threshold for self-fix versus delegation. Neither says anything about **cost** or
**certainty**. Stage 2 (`:2163`) asks the reviewer to decide *"what to keep, what to fix now, what
can defer"* and gives it no criteria for the third bucket, and
`DEFERRED_FINDINGS_SECTION_INSTRUCTION` (`:1280`) then accepts whatever it deferred without
challenge — it specifies the *format* of a deferral (severity + `file:line`) but never asks *why*
the finding was not simply fixed.

So deferral is the cheapest available action, and the prompt's only pressure runs the other way:
the reviewer is warned repeatedly not to exceed scope (`:2156` "what to build and what's out of
bounds", the ~100-line threshold, "Do NOT re-review the entire codebase"). A reviewer optimising
against that prompt defers a one-line fix it is certain about, because deferring is never wrong and
fixing might be.

Observed on `the-runtime-overlay-passes-one-bound-parameter-per-row.md` (2026-09-14), which
deferred four findings. Two were minutes of work the reviewer had already fully diagnosed:

- *NIT — the V78 runner block calls `this.getMigrationVersion()` a second time into a local named
  `v78` after the V77 block already read it.* Diagnosed to the line, mechanical, no judgment.
- *NIT — plan text cites `SCHEMA_TABLES_SQL:728` as the home for the new index; indexes actually
  live in `SCHEMA_INDEX_STATEMENTS` (`:702`).* The reviewer had already established the correct
  location and was editing the plan file in the same pass.

A third deferral — *"`idx_plan_runtime_state_device` is now used by no query in the tree"* — was
correct and material, and was deferred with the reasoning *"it is retained because Goal Invariant 5
names it"*. That is the reviewer declining to touch a plan-stated invariant, which is the right
instinct and exactly what Defect 3's escalation path exists to serve. It had no way to raise it, so
it went into the deferral list where it sat until a human read the file.

**Defect 2 — nothing says how much work is left.**

`## Deferred Findings` is a flat list. Each item carries a severity and a `file:line`, and nothing
else. A reader cannot tell a two-minute rename from a week of redesign, and there is no total.
`deferred-findings-become-a-structured-record.md` (COMPLETED) deliberately built this section and
settled its shape — severity scale, `file:line`, explicit empty case — but its scope was *where
deferred findings live*, not *how big they are*. The size question was never asked.

The same gap exists one level up: the board shows a card in `CODE REVIEWED` and nothing about that
card distinguishes "reviewed clean" from "reviewed, four things deferred, one of them CRITICAL".

**Defect 3 — escalation moves the card backwards, and hides that it did.**

`ESCALATION ON DESTINATION CHANGE` (`:2180`) instructs a reviewer that changed the plan's
destination or reversed its goal to append `### Review Deviations` and then move the card to
`PLAN REVIEWED`. That is the author's column, behind three stages. Consequences, all observed:

- **The card reads as un-coded.** `PLAN REVIEWED` is `HOP_SOURCE_COLUMNS.code`
  (`HopReadiness.ts:49`) — the column work is dispatched *from*. A card parked there for a decision
  is indistinguishable from a card waiting to be coded, and is a live dispatch candidate.
- **Finished work looks unstarted.** The overlay card had a merged implementation and a completed
  review behind it, and sat in the planning column for a day.
- **The move does not record itself.** The escalation writes `kanban_column = 'PLAN REVIEWED'` but
  leaves `last_action` reading `move-to-code-reviewed` (verified on plan
  `4d715106-a34b-48de-8de4-526223514d54`: column `PLAN REVIEWED`, `last_action`
  `move-to-code-reviewed`, `column_entered_at` 42s after the plan file was rewritten). Every
  forensic read of that row says the card advanced to review. Only the plan-file prose says
  otherwise.

**The design this supersedes.** `goal-invariant-verification-and-review-escalation.md` (COMPLETED)
introduced this path, and settled at its line 125 that escalation must be *"a plan-file state plus
a board move via the sanctioned API path"* — correct, and unchanged here. What it did not settle is
*which column*, and `PLAN REVIEWED` was taken as the only available answer because no column
existed for "reviewed, blocked on the author". This plan supplies one.

### Root cause

The pipeline is a straight line with no waiting state. Every column encodes *work completed*
(`CREATED` → `PLAN REVIEWED` → coded → `CODE REVIEWED` → `ACCEPTANCE TESTED` → `COMPLETED`), and
none encodes *work halted pending a decision*. A reviewer that must not proceed has nowhere to put
the card except backwards, and a reviewer that finds something it should not decide alone has
nowhere to put the finding except `## Deferred Findings`. Both defects are the missing state.

## Metadata

**Tags:** reliability, ux, backend
**Complexity:** 6
**Repo:** switchboard

## User Review Required

No. The three changes are separable but ordered: Change A must land before Change B references the
new column. Nothing here needs a decision the operator has not already given.

## Settled Design

- **`ESCALATED` sits at order 320**, between `CODE REVIEWED` (300) and `ACCEPTANCE TESTED` (350).
  Forward, adjacent to review, and before acceptance — an escalated card has been reviewed and has
  not been accepted.
- **`ESCALATED` carries no `role`.** A role makes a column a dispatch target; `CREATED`, `STAGING`
  and `COMPLETED` all omit it. An escalated card is waiting on a *human* decision, so auto-dispatch
  into it is precisely the behaviour to avoid. This also keeps it out of `HOP_SOURCE_COLUMNS`, so
  it is never a hop source.
- **`kind: 'reviewed'`, `dragDropMode: 'cli'`, `source: 'built-in'`.** `kind` is almost entirely
  presentational — the only behavioural read in the tree is `project.js:2464` — so `'reviewed'`
  groups it correctly without side effects.
- **`ESCALATED` appears whenever `CODE REVIEWED` appears, and this is structural, not a
  convention.** Column visibility is resolved in `_filterDynamicColumns`
  (`KanbanProvider.ts:4631-4637`), and it keys off `role`:
  ```ts
  if (col.featureOnly) return occupiedColumns.has(col.id);
  if (!col.role) return true;                      // role-less: always visible
  if (visibleAgents[col.role] !== false) return true;
  return occupiedColumns.has(col.id);              // never hide a column holding cards
  ```
  `ESCALATED` carries no role, so it falls into the second line and **cannot be hidden by any
  existing mechanism** — there is no `visibleAgents` entry to switch off. The requirement is
  therefore satisfied by construction rather than by a rule someone must remember, and Invariant 7
  pins it so a future edit cannot quietly give the column a role and make it hideable.
- **The converse needs building: `ESCALATED` must NOT appear when `CODE REVIEWED` is hidden.**
  Role-less means *always* visible, which on a board that runs no reviewer leaves a permanently
  empty column. `CODE REVIEWED` carries `role: 'reviewer'` and disappears when that agent is
  hidden, so the two currently decouple in the one direction that produces clutter rather than
  data loss. This is the only genuinely new visibility concept in the plan — see Change D.
- **A paired column that holds cards is never hidden.** The existing filter's last line already
  encodes this for role-carrying columns (`return occupiedColumns.has(col.id)`), and the pairing
  must inherit it verbatim. Hiding a column that holds escalated cards would destroy the exact
  visibility this plan exists to create — an escalation into an invisible column is strictly worse
  than the backwards move it replaces.
- **Exit from `ESCALATED` is a human move, and is not automated.** The operator decides: accept the
  deviation (forward to `ACCEPTANCE TESTED`), or reject it (back to a coding column). Automating
  this would re-create the defect one stage later.
- **`ESCALATED` is NOT added to `DORMANT_KANBAN_COLUMNS`** (`KanbanDatabase.ts:5620`, currently
  `PLAN REVIEWED` and `CODE REVIEWED`). Dormancy drives archival sweeps; a card awaiting an operator
  decision must not be archived out from under them for being idle. Idleness there is the
  *expected* state, which is exactly why it must not be read as staleness.
- **Deferral becomes a justified action, not a default.** The reviewer must fix anything that is
  both cheap and certain, and must record a reason for anything it defers.
- **Effort is a three-value scale, not an estimate.** `TRIVIAL` / `CONTAINED` / `SUBSTANTIAL`.
  Reviewers cannot estimate hours and should not be asked to; what a reader needs is whether the
  remainder is minutes, a sitting, or a project. Three buckets carry that and resist false
  precision, and the scale sits alongside the CRITICAL/MAJOR/NIT severity that
  `deferred-findings-become-a-structured-record.md` settled — severity says how much it matters,
  effort says how much it costs, and neither substitutes for the other.

## Complexity Audit

### Routine
- Adding the column definition to `DEFAULT_KANBAN_COLUMNS` and the sites that enumerate column ids.
- The prompt-string edits in `agentPromptBuilder.ts`.

### Complex / Risky
- **Column-id enumeration is scattered across 12 files** (`agentConfig.ts`, `KanbanProvider.ts`,
  `TaskViewerProvider.ts`, `RemoteControlService.ts`, `reviewLogUtils.ts`,
  `kanbanColumnDerivationImpl.js`, `bundledProtocols.ts`, `webview/kanban.html`,
  `webview/implementation.html`, `webview/project.js`, plus two test files). A column added to the
  definition list but missed at an ordering or label site renders unlabelled or sorts to the wrong
  place, and no gate catches it.
- **The reviewer prompt is pinned by regression gates** (`agentPromptBuilder.test.ts`, and the
  reviewer-prompt regression gate referenced at `:1257` and `:2196`). Byte-identical strings are
  asserted; edits must update those expectations deliberately, never by loosening the assertion.
- **Both composition roots.** The escalation move goes through `POST /kanban/move`, whose
  `moveCard` seam is wired per host (`LocalApiServer.ts:7613`, and the unwired-seam 503 at `:7617`).
  Verification must confirm the move works under the standalone host, which is the one that ships.

## Edge-Case & Dependency Audit

- **Race conditions.** None new. The escalation is a single `POST /kanban/move`, the same path a
  human click takes.
- **Security.** None. No new endpoint, no new auth surface.
- **Side effects.** A new column appears on every existing board. Existing cards are unaffected —
  nothing migrates into `ESCALATED`; it starts empty.
- **Dependencies & conflicts.**
  - `goal-invariant-verification-and-review-escalation.md` (COMPLETED) — supersedes its choice of
    escalation destination only. Its plan-file-state-plus-board-move mechanism is kept intact.
  - `deferred-findings-become-a-structured-record.md` (COMPLETED) — extends its section format with
    two fields. The severity scale, `file:line` convention and explicit-empty-case rule are
    preserved exactly; this adds to them and changes none of them.
  - `completion-testing-stage-checks-acceptance-criteria.md` — replaces the tester role at the
    stage after this one. It does not touch `CODE REVIEWED` or the reviewer prompt, so the two are
    independent; if it lands first, `ESCALATED` still sits before whatever occupies 350.
  - **Not a conflict but adjacent:** `KanbanProvider.ts:7826` hides `ACCEPTANCE TESTED` when no
    acceptance tester is active. `ESCALATED` needs no equivalent — it has no role, so there is no
    agent whose absence would make it meaningless.

## Dependencies

- **Supersedes** `goal-invariant-verification-and-review-escalation.md` (COMPLETED) — its
  plan-file-state-plus-board-move escalation mechanism is kept intact; this plan supersedes only
  its choice of escalation *destination* (`PLAN REVIEWED` → `ESCALATED`).
- **Extends** `deferred-findings-become-a-structured-record.md` (COMPLETED) — preserves its
  severity scale, `file:line` convention, and explicit-empty-case rule verbatim; adds `effort`
  and `why deferred` fields alongside them.
- **Adjacent to** `completion-testing-stage-checks-acceptance-criteria.md` — independent; if it
  lands first, `ESCALATED` still sits before whatever occupies order 350.
- Independent of the missions, automation, and worktree work.

## Adversarial Synthesis

**Risk summary.** The prompt changes are low-risk and reversible; the column addition is the risk,
because column ids are enumerated in twelve places and a miss is silent. The second risk is
prompt-gate churn: the reviewer prompt is pinned byte-for-byte in at least two test files, and the
tempting shortcut when those fail is to relax the assertion rather than update it — which would
retire the gate that makes these prompts reviewable at all. The third risk is behavioural rather
than technical: an `ESCALATED` column with no role and no automated exit can silently accumulate
cards. That is why Change C's board-visible count matters as much as the column itself — a waiting
state nobody can see is a worse failure than the backwards move it replaces.

## Proposed Changes

### Change A — the `ESCALATED` column

#### `src/services/agentConfig.ts`
- **Context:** `DEFAULT_KANBAN_COLUMNS` (`:199-211`).
- **Logic:** Insert between `CODE REVIEWED` (order 300) and `ACCEPTANCE TESTED` (order 350):
  ```ts
  { id: 'ESCALATED', label: 'Escalated', order: 320, kind: 'reviewed', source: 'built-in', dragDropMode: 'cli' },
  ```
- **Edge case:** No `role` key — deliberate, and worth a comment saying so, because every
  neighbouring entry has one and a future editor will read its absence as an oversight. The
  comment must state both consequences: it keeps the column out of dispatch, and it makes the
  column structurally unhideable (`_filterDynamicColumns:4633`).
- **Already correct, do not "fix" it:** `getNextColumn`'s skip rule
  (`KanbanProvider.ts:7827`, `if (!col.role && col.kind !== 'completed') return true`) means the
  **Advance** button steps from `CODE REVIEWED` straight to `ACCEPTANCE TESTED`, skipping
  `ESCALATED`. That is wanted — escalation is a deliberate act by a reviewer or a human, never
  where a card lands by advancing. Do not add an `ESCALATED` carve-out to that function.

#### `src/services/KanbanProvider.ts`
- `:9724-9726` — add `'ESCALATED'` to the explicit column-order array, after `'CODE REVIEWED'`.
- `:3896-3902` and `:15530` — the column→role maps. Add **no** entry; confirm both fall through
  safely to "no role" rather than throwing or defaulting to a real role. If either defaults, fix
  the default to be absent rather than adding a role here.

#### `src/services/reviewLogUtils.ts`
- `:4-8` — the column→display-name map. Add `'ESCALATED': 'Escalated'`.

#### `src/services/kanbanColumnDerivationImpl.js`
- `:28` — add `'escalated': 'ESCALATED'` to the slug map so the derived form round-trips.

#### `src/webview/kanban.html`, `src/webview/implementation.html`, `src/webview/project.js`
- Add `ESCALATED` wherever `ACCEPTANCE TESTED` is enumerated for rendering or ordering.
- `project.js:2464` — the one behavioural `kind` read. Confirm an `ESCALATED` card is *not* treated
  as complete; it must remain visible as outstanding work.

#### `src/services/RemoteControlService.ts`
- `:109` — documentation comment listing columns. Add `ESCALATED`.

### Change B — escalate forwards, and record it

#### `src/services/agentPromptBuilder.ts` — `ESCALATION ON DESTINATION CHANGE` (`:2180`)
- **Logic:** Change the target column from `PLAN REVIEWED` to `ESCALATED`, and state why the card
  moves forward: the work is done and reviewed, and what is blocked is a *decision*, not the code.
- Keep unchanged: the `### Review Deviations` section requirement, its inert-prose framing, and the
  `moveRef` API path. Those are `goal-invariant-verification-and-review-escalation.md`'s settled
  mechanism and are not in question.
- **Add** a requirement that the deviation section name the **decision**, stated as a choice between
  named alternatives with the reviewer's recommendation — not an open question. The overlay plan's
  escalation is the model: it named both readings of the invariant, gave the measurement, and
  recommended one.

#### The `last_action` defect
- **Context:** the escalation currently leaves `last_action` reading `move-to-code-reviewed` while
  writing a different column.
- **Logic:** the move must stamp a distinct action — `escalated-by-reviewer` — so the row is
  self-describing. **Investigation step (do this before choosing the fix layer):** trace
  `last_action` derivation inside `moveCard` — is it derived from the workflow name, passed by
  the caller, or stamped from the target column? The fix goes at whichever layer sets it. If the
  bug is general to `POST /kanban/move` with an explicit target (not reviewer-specific), fix it
  generally — do not special-case the reviewer.
- **Edge case:** `last_action` is read by board queries and by the reconcile preset. Adding a value
  must not break a consumer that switches on known actions — grep every reader before choosing the
  string.

### Change C — fix what is cheap and certain; size what is not

#### `src/services/agentPromptBuilder.ts` — `fixStep` (`:2145`)
- **Logic:** add a fix-first rule that applies in both delegation and non-delegation modes: a
  finding the reviewer can state as a concrete edit to a named line, and is confident about, is
  **fixed now regardless of severity** — NIT included. Deferral is for findings that are uncertain,
  broad, or outside the plan's scope. "It is only a NIT" is not a reason to defer; "I am not sure
  this is wrong" and "this needs a decision I should not make" are.
- **Edge case:** this must not become licence to widen scope. The rule is bounded by certainty and
  by the existing scope language, which stays. A finding that is cheap but *outside the plan's
  scope* is still deferred — and that is what Change B's escalation path is for when it matters.

#### `src/services/agentPromptBuilder.ts` — `DEFERRED_FINDINGS_SECTION_INSTRUCTION` (`:1280`)
- **Logic:** each deferred finding gains two fields alongside its existing severity and `file:line`:
  - **effort** — `TRIVIAL` / `CONTAINED` / `SUBSTANTIAL`
  - **why deferred** — one clause, and it may not be "low severity"
- Require a closing total line so the size of the remainder is readable without counting:
  `Deferred: 4 (1 CRITICAL, 3 NIT) — 2 TRIVIAL, 1 CONTAINED, 1 SUBSTANTIAL`.
- **Preserve exactly:** the explicit-empty-case rule (`None` under the heading, never an omitted
  section). That rule is the load-bearing part of the completed plan this extends.
- **Edge case:** a `TRIVIAL` deferral is now self-indicting — it is a finding the reviewer called
  cheap and still did not fix. That tension is intentional and is the pressure the current prompt
  lacks; the prompt should say so, so the reviewer feels it at authoring time rather than being
  caught by it later.

#### Board visibility
- **Context:** the deferred total exists only inside the plan file.
- **Logic:** surface the count on the card in `CODE REVIEWED` — a small badge reading the deferred
  total and worst severity. Read it from the plan file's total line at import; do not add a schema
  column for it until a second consumer needs it.
- **Edge case:** plans reviewed before this change have no total line. Render nothing — *not* zero.
  A plan with no record and a plan with nothing deferred must not look alike, which is the same
  distinction `DEFERRED_FINDINGS_SECTION_INSTRUCTION` already draws for the section itself.

### Change D — pair `ESCALATED`'s visibility to `CODE REVIEWED`

The requirement is one-directional and already met (`ESCALATED` cannot be hidden). This change adds
only the converse, so the column does not appear on boards that run no reviewer.

#### `src/services/agentConfig.ts`
- **Logic:** add an optional field to `KanbanColumnDefinition` (`:153-165`):
  ```ts
  /** This column is shown only when the named column is shown, and hidden with it —
   *  unless it holds cards. Visibility is otherwise driven by `role`, which a paired
   *  column deliberately lacks. */
  visibilityPairedWith?: string;
  ```
- Set `visibilityPairedWith: 'CODE REVIEWED'` on the `ESCALATED` entry.

#### `src/services/KanbanProvider.ts` — `_filterDynamicColumns` (`:4631`)
- **Logic:** before the `if (!col.role) return true` line, resolve the pairing:
  ```ts
  if (col.visibilityPairedWith) {
      if (occupiedColumns.has(col.id)) return true;   // never hide held cards
      const partner = columns.find(c => c.id === col.visibilityPairedWith);
      if (!partner) return true;                      // unresolvable pair fails VISIBLE
      if (!partner.role) return true;
      return visibleAgents[partner.role] !== false || occupiedColumns.has(partner.id);
  }
  ```
- **Edge case — the fail direction is mandatory.** An unresolvable or missing partner must resolve
  to **visible**. A pairing bug that hides a column silently loses work; one that shows an extra
  column is cosmetic and self-announcing. This is the same visible-failure choice already made at
  `LocalApiServer.ts:11785` for the `'unknown'` case, in the same words: *"an extra column is
  recoverable; a silently missing stage is not."*
- **Edge case:** the partner's own `occupiedColumns` check must be included, or `ESCALATED` would
  vanish in the case where the reviewer is hidden but `CODE REVIEWED` is still on screen holding
  cards — which is exactly the pairing the operator asked for, in the situation that most needs it.

#### `src/services/PlanningPanelProvider.ts` (`:7964`)
- The same filter exists here with the same shape. Both must change together or the two panels
  disagree about which columns exist. Extract the predicate to one shared helper rather than
  editing two copies — a divergence here is invisible until a user compares panels.

#### `src/services/LocalApiServer.ts` — `_handleGetColumns` (`:11780-11792`)
- **Context:** the endpoint currently tags every role-less column
  `{ enabled: true, enabledSource: 'structural' }` (`:11781`).
- **Logic:** a paired column's `enabled` is computed from its partner, so reporting `'structural'`
  would state a derived value as an inherent one. Add a fifth tag, `'paired'`, and report the
  partner-derived `enabled` alongside it.
- **Edge case — a known gate breaks here, deliberately.**
  `src/test/board-read-endpoints-contract.test.js:571-576` filters out `'structural'` and then
  asserts every remaining tag is one of four known values. A fifth tag fails that assertion. Update
  the test's known set to include `'paired'`; do **not** widen the assertion to accept arbitrary
  strings — the closed set is the point of the check.


## Verification Plan

### Automated Tests
1. **Column registration sweep.** A contract test asserting `ESCALATED` resolves at every
   enumeration site: present in `DEFAULT_KANBAN_COLUMNS`, ordered between `CODE REVIEWED` and
   `ACCEPTANCE TESTED`, has a display label, round-trips through the derivation slug map, and
   carries **no** role. This is the gate the twelve scattered sites currently lack.
2. **No-dispatch assertion.** `ESCALATED` is absent from every `HOP_SOURCE_COLUMNS` entry and is
   not a dispatch target — a card sitting there is never auto-seated.
3. **Not dormant.** `ESCALATED` is absent from `DORMANT_KANBAN_COLUMNS`, so the archival sweep
   cannot reclaim a card that is waiting on the operator.
4. **Escalation round-trip.** Drive `POST /kanban/move` with `targetColumn: 'ESCALATED'` against the
   standalone host; assert the row lands in `ESCALATED` **and** that `last_action` reflects the
   escalation rather than a stale prior action. This is the regression test for the observed
   `last_action` defect and must fail against today's code.
5. **Prompt gates updated, not loosened.** The existing reviewer-prompt regression expectations are
   updated to the new strings. The test must still pin exact text; a diff that replaces an equality
   assertion with a substring or regex match fails this plan's intent.
6. **Visibility pairing, both directions and the override.** Drive `_filterDynamicColumns` with
   three fixtures: (a) reviewer visible → both `CODE REVIEWED` and `ESCALATED` present; (b) reviewer
   hidden, no escalated cards → neither present; (c) reviewer hidden, one card sitting in
   `ESCALATED` → `ESCALATED` present. Case (c) is the one that matters: it asserts held work is
   never hidden.
7. **Unresolvable pair fails visible.** Point `visibilityPairedWith` at a column id that does not
   exist and assert the column still renders. A pairing bug must never be able to hide a column.
8. **Panel agreement.** `KanbanProvider` and `PlanningPanelProvider` return the same column set for
   the same inputs — the regression test for the two-copies-of-one-filter hazard.

### Goal Invariants
1. `DEFAULT_KANBAN_COLUMNS` contains an entry with id `ESCALATED`, `order` strictly between the
   `CODE REVIEWED` and `ACCEPTANCE TESTED` orders, and no `role` property.
2. The string `PLAN REVIEWED` does not appear in the `ESCALATION ON DESTINATION CHANGE` block of
   `agentPromptBuilder.ts`; the string `ESCALATED` does. *(Paired: the block still names the
   `### Review Deviations` section and the `/kanban/move` path, so the escalation mechanism is
   relocated, not deleted.)*
3. `DEFERRED_FINDINGS_SECTION_INSTRUCTION` names all of `TRIVIAL`, `CONTAINED`, `SUBSTANTIAL`, and
   still requires the explicit `None` empty case.
4. `fixStep` names a certainty-and-cost rule that is not conditioned on severity — greppable as a
   clause that applies to NIT findings.
5. `KanbanDatabase.DORMANT_KANBAN_COLUMNS` does not contain `ESCALATED`.
6. A card moved to `ESCALATED` has a `last_action` that is not the action it carried before the
   move.
7. The `ESCALATED` entry in `DEFAULT_KANBAN_COLUMNS` has no `role` property, and
   `_filterDynamicColumns` contains no `ESCALATED`-specific branch — its always-visible behaviour
   comes from the general role-less rule, not a special case.
8. `ESCALATED` declares `visibilityPairedWith: 'CODE REVIEWED'`, and no board state exists in which
   `CODE REVIEWED` renders and `ESCALATED` does not. *(Paired positive: a fixture in which the
   reviewer is hidden and `ESCALATED` holds a card still renders `ESCALATED` — the rule hides an
   empty paired column, never one holding work.)*
9. `GET /kanban/columns` reports `ESCALATED` with `enabledSource: 'paired'` and an `enabled` value
   that tracks `CODE REVIEWED`, never a hardcoded `true`.

---

## Implementation Summary

Improve-plan pass completed. Added the missing `## Dependencies` section (supersedes `goal-invariant-verification-and-review-escalation.md`, extends `deferred-findings-become-a-structured-record.md`, adjacent to `completion-testing-stage-checks-acceptance-criteria.md`). Made the `last_action` investigation step in Change B explicit — the plan now directs the coder to trace `last_action` derivation inside `moveCard` before choosing the fix layer, rather than leaving "establish first" as an open instruction. Architecture review confirmed the role-less + visibility-paired approach is the best of three alternatives; the goal-vs-appearance probe found no gap. Adversarial critique identified the `last_action` underspecification as the real finding; balanced synthesis converged on making the investigation step explicit. No superseded conclusions — the plan's approach was validated, not corrected.
