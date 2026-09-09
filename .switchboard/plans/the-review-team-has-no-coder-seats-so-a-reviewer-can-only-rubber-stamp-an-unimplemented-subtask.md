# The Review Team Has No Coder Seats, So a Reviewer Can Only Rubber-Stamp an Unimplemented Subtask

## Goal

Make the reviewer use the coder seats its team now has. Before a feature can pass review, every
subtask must be verified as actually implemented; any subtask that is not gets dispatched to one of
the reviewer's own seats rather than waved through. The seats themselves are supplied by the
companion preset plan — this plan is the reviewer's side of that contract, in both hosts.

### Problem analysis

**Reported symptom.** A reviewer passes a feature and marks it completed while entire subtasks of
that feature were never implemented.

This is not one defect. Three compose, and each is independently sufficient to produce the symptom.

> **Citation convention.** Line numbers below are as-of-read (2026-09-09) and drift; the **symbol
> names are authoritative**. Cite by symbol when editing.

---

#### Defect 1 — the reviewer is never asked whether the subtasks exist

`agentPromptBuilder.ts` carries a substantial anti-rubber-stamp apparatus, and every piece of it is
about **verification depth on the diff it was handed**:

- `SKIP_DISCLOSURE_STEP` (`agentPromptBuilder.ts:1212`) — declare when checks were not executed, verdict is provisional.
- `ANTI_LEAKAGE_STEP` (`:1221`) — a plan-file note saying "tests were not run" is a record, not an
  instruction; run them yourself.
- `DELEGATION_ANTI_LEAKAGE_STEP` (`:1240`) — the delegation-mode counterpart.
- Provisional-verdict language for mechanisms with no automated check.

**None of it asks about coverage.** The reviewer steps array is built at `agentPromptBuilder.ts:2127-2145`
(inside the `if (role === 'reviewer')` block at `:2106`). Every occurrence of `subtask` in the file
sits in a coder, lead, or planner directive — the feature-overview authoring directive
(`:1173-1180`), `STAGGERED_IMPLEMENTATION_DIRECTIVE` (`:1185`), and the coder/lead subagent clauses
(`:1528-1550`). The reviewer's contract is "is this diff correct and was it verified", never
"does this feature have subtasks with no diff at all".

A reviewer that is never asked the question cannot be accused of skipping it. The rubber stamp is
the prompt working as written.

---

#### Defect 2 — the Review team preset ships zero members, and the code that reads it documents a member

`TaskViewerProvider.ts` resolves the coder a reviewer delegates to, and names two team shapes in
its own comment (single-card path, `TaskViewerProvider.ts:8552-8557`):

```
//  (1) reviewer-as-head (Review team preset — reviewer heads its
//      own team, coder is its member): resolve from the
//      reviewer's OWN team.
//  (2) shared-reviewer-as-member (Coding preset — one reviewer
//      is a member of every coding team)
```

Shape (1) names the Review team preset explicitly and asserts "coder is its member". The preset says
otherwise (`teamWiring.ts:772-776`):

```ts
{
    id: 'review-team',
    name: 'Review team',
    headRole: 'reviewer',
    members: [],
},
```

So `resolveTeamMembersForHead` returns empty, `ownTeam && ownTeam.length > 0` is false, and control
falls to the `originLead` branch — which resolves a coder on the **coding** team, in the coding
team's worktree. Delegation itself is then gated on `coder && originLead` (single-card path
`:22850`), and `originLead` has already been dropped by the self-target guard (`:22831`) on any
re-dispatch of a card already in CODE REVIEWED, and by the cross-team guard (`:22844`) whenever the
two do not share a group.

**Shape (1) is unreachable at factory defaults.** The reviewer has no seat of its own to hand work to,
so even a reviewer that noticed a missing subtask has nowhere to send it and no mandate to implement
it itself.

The member-less preset is the defect, not a constraint on this one. It is fixed in the companion plan
*The Three Preset Teams Ship Member-Less, and a Migration Strips Members on Load*, which populates all
three presets and deletes the migration that strips members on load. This plan assumes those seats
exist and covers only what the reviewer does with them.

#### Defect 3 — the whole reviewer→coder resolution is extension-only

Per the standing rule that the two hosts must not diverge, this was checked at the composition roots
rather than by verb reachability.

| | extension | standalone |
| :--- | :--- | :--- |
| `resolveTeamRoleTerminal` | `TaskViewerProvider.ts`, 14 call sites | wired, 1 seam (`bootstrap.ts:4370`) |
| `resolveTeamMembersForHead` own-team branch | `:8558` (batch), `:22807` (single-card) | **absent** |
| self-target guard | `:8570` (batch), `:22831` (single-card) | **absent** |
| cross-team guard | `:8574` (batch), `:22844` (single-card) | **absent** |
| `installReviewerCallbackOrder` | `:8591` (batch), `:22859` (single-card) | **absent** |
| sets `reviewerDelegationMode` / `reviewerCoderTerminal` | `:8582-8583` (batch), `:22851` (single-card) | **absent** |

`reviewerDelegationMode` and `reviewerCoderTerminal` are set in exactly one non-test file
(`TaskViewerProvider.ts`). Standalone wires the leaf seam and none of the logic above it, so in
`npx switchboard` the reviewer prompt is *never* built in delegation mode — the option is
structurally unreachable, and no gate catches it because the seam it does wire returns a plausible
value.

> **Superseded:** the resolution logic exists at one site, `TaskViewerProvider.ts:22460-22530`.
> **Reason:** there are **two** duplicated resolution blocks in `TaskViewerProvider.ts` — a batch path
> (`:8534-8595`, reached when a reviewer batch is dispatched) and a single-card path (`:22781-22860`).
> The original plan cited only the single-card path. An extraction that replaces only the cited path
> leaves the batch path extension-only and duplicated — the exact composition-root divergence trap
> the standing rule exists to prevent, and invisible to the verb-reachability parity gate.
> **Replaced with:** the host-neutral helper (Proposed Change 3) must consolidate **both** blocks; a
> parity test asserts the inline `resolveTeamMembersForHead`+`originLead` sequence appears in zero
> places in `TaskViewerProvider.ts` after extraction.

---

### Migration

None. Teams have never shipped to users, so this is a clean break — no head-prompt migration, no
compat shim.

## Metadata

**Complexity:** 6
**Tags:** bugfix, backend, reliability
**Dependencies:** the-three-preset-teams-ship-member-less-and-a-migration-strips-members-on-load (supplies the seats)

## User Review Required

None.

## Complexity Audit

### Routine
- Adding one reviewer-role step constant to `agentPromptBuilder.ts` beside the existing
  `SKIP_DISCLOSURE_STEP` / `ANTI_LEAKAGE_STEP` family and selecting it in the reviewer steps array
  (`:2127-2145`). Same register, same selection pattern.
- Updating the `teamWiring.ts` preset is out of scope (companion plan); this plan only consumes the
  seats it populates.
- The regression pin on `ANTI_LEAKAGE_STEP` text selection already lives in
  `src/test/team-scoped-role-routing.test.js:877-893`; the new step must not disturb it.

### Complex / Risky
- **Two-site extraction.** The reviewer→coder resolution is duplicated across a batch path
  (`TaskViewerProvider.ts:8534-8595`) and a single-card path (`:22781-22860`). The host-neutral helper
  must replace both, and both composition roots must call it. Missing the batch path reproduces the
  divergence defect this plan exists to fix.
- **Standalone `installReviewerCallbackOrder` wiring.** The install is best-effort-wrapped in the
  extension (`catch { /* best-effort */ }` at `:8592` / `:22860`). The extracted helper must preserve
  that boundary — a thrown error on a locked standalone DB silently drops to the non-delegation
  (fix-itself) path, which is the bug.
- **Coverage attribution.** The new coverage step needs a concrete, checkable signal for "this
  subtask has no implementation" (see Proposed Change 1); without it the step is vacuously satisfiable
  and the goal invariant is unenforceable.

## Edge-Case & Dependency Audit

- **Race Conditions.** A reviewer dispatching a missing subtask to its seat while the lead
  concurrently re-dispatches the same card: the self-target guard (`:22831`) and cross-team guard
  (`:22844`) already handle re-dispatch of a card already in CODE REVIEWED; the new dispatch must
  respect the same `coder && originLead` gate, not bypass it.
- **Security.** None — no new trust boundary; the reviewer already holds dispatch authority.
- **Side Effects.** `installReviewerCallbackOrder` writes a pair-scoped standing order to the DB; it
  is removed when the coder is cleared or re-dispatched by the lead. The helper must not double-install
  on the batch and single-card paths for the same pair.
- **Dependencies & Conflicts.** Hard dependency on the companion preset plan — without populated
  Review-team members, `resolveTeamMembersForHead` still returns empty and this plan's dispatch path is
  unreachable (shape (1) stays dead). The coverage step (Defect 1) is independently valuable and ships
  regardless; the dispatch (Defects 2+3) is a no-op until the seats exist, by design.

## Dependencies

- `the-three-preset-teams-ship-member-less-and-a-migration-strips-members-on-load` — supplies the
  Review-team coder seats this plan's dispatch path consumes. Without it, the coverage step still
  blocks bad passes but the reviewer cannot dispatch (it refuses and says why, per Proposed Change 2).

## Adversarial Synthesis

Key risks: (1) the extraction misses the second, batch-path copy of the resolution logic and
re-diverges the two hosts on the batch path; (2) the coverage step has no concrete attribution signal
and is vacuously satisfiable, reproducing the rubber stamp in a new costume; (3) the
`installReviewerCallbackOrder` best-effort boundary is lost in extraction and a standalone DB error
silently drops to the non-delegation fix-itself path. Mitigations: a parity test asserting the inline
resolution sequence is absent from `TaskViewerProvider.ts` post-extraction; the coverage step keys on
the feature file's `## Implementation Notes` (populated by `STAGGERED_IMPLEMENTATION_DIRECTIVE`) as
the per-subtask implementation record; the helper preserves the `catch` best-effort wrap verbatim.

## Proposed Changes

### 1. Make the reviewer check subtask coverage before passing a feature (`src/services/agentPromptBuilder.ts`)

- **Logic:** A new reviewer-role step, in the same register as `SKIP_DISCLOSURE_STEP`: when the card
  under review is a feature, enumerate its subtasks from the feature file's auto-generated Subtasks
  block, and for each one establish whether an implementation exists. A subtask with no implementation
  is a **blocking** finding — the feature does not pass review on the strength of the subtasks that
  were done.
- **Attribution signal (Clarification — strictly implied by existing requirements):** the feature
  batch is one merged git diff and cannot be attributed to subtasks from the diff alone. Use the
  per-subtask implementation record the codebase already produces: `STAGGERED_IMPLEMENTATION_DIRECTIVE`
  (`agentPromptBuilder.ts:1185`) makes each coder append a per-subtask entry to the feature file's
  `## Implementation Notes` section. **A subtask listed in the Subtasks block with no entry in
  `## Implementation Notes` and no attributable diff is the blocking condition.** This makes the goal
  invariant ("a feature with an unimplemented subtask does not reach a passing verdict") checkable
  rather than vacuous.
- **Implementation:** Add the constant beside the other reviewer steps and select it in the reviewer
  steps array (`:2127-2145`). `ANTI_LEAKAGE_STEP` must stay byte-identical — the reviewer-prompt
  regression gate pins its text selection (`src/test/team-scoped-role-routing.test.js:877-893`, the
  "delegation OFF emits fix-itself text" backward-compat pin).
- **Edge cases:** A single-plan card has no subtasks; the step must no-op rather than fabricate a
  finding (gate on the feature/Subtasks-block presence, same condition the feature-overview directive
  at `:1173` uses). A subtask deliberately descoped in its own plan is not a missing implementation —
  read the subtask plan's scope notes; a descoped subtask is documented, not silent.

### 2. Tell the reviewer to dispatch the missing subtask to its own seat, not to fix it silently

- **Logic:** Where step 1 finds an unimplemented subtask and the reviewer has a coder seat on its own
  team, the reviewer dispatches that subtask to the seat and reports; it does not implement the
  subtask itself, and it does not pass the feature while one is outstanding.
- **Edge cases:** Two seats, three missing subtasks — the reviewer queues rather than dropping the
  third. No seat resolves (a Review team started head-only): say so in the findings and refuse the
  pass, rather than falling back to a silent stamp.

### 3. Close the standalone gap (`src/standalone/bootstrap.ts`, `src/services/TaskViewerProvider.ts`, new host-neutral helper)

- **Logic:** Extract the reviewer→coder resolution from **both** `TaskViewerProvider.ts` blocks — the
  batch path (`:8534-8595`) and the single-card path (`:22781-22860`) — into a host-neutral helper
  over `(db, liveTerminals)`, the shape `resolveTeamScopedRoleTerminal` already uses. Call it from
  both composition roots (`extension.ts` and `bootstrap.ts:4370` region), so
  `reviewerDelegationMode` and `reviewerCoderTerminal` are reachable in `npx switchboard`.
- **Preserve the best-effort boundary:** `installReviewerCallbackOrder` is wrapped in
  `catch { /* best-effort */ }` at `:8592` and `:22860`. The helper must keep that wrap — without it a
  locked-DB throw in standalone silently falls through to the non-delegation fix-itself path, which is
  the defect. Do not "harden" it into a rethrow.
- **Edge cases:** `installReviewerCallbackOrder` writes a pair-scoped standing order; standalone must
  wire it or the coder reports back to the lead instead of the reviewer. The helper must not
  double-install when both the batch and single-card paths would have run for the same pair.

### Alternatives considered

- **A new agent role for a review-time coder.** Rejected — a new instruction string on the existing
  `coder` role is the cheaper and more conventional fix.
- **Duplicate the resolution block into `bootstrap.ts`.** Rejected — copies the exact composition-root
  divergence the standing rule exists to prevent; two copies drift and the verb-reachability parity
  gate stays green.
- **Push the coverage check into the kanban mechanical pre-check.** Rejected as the sole mechanism —
  the pre-check runs before the reviewer sees the card and cannot judge "deliberately descoped" vs
  "missing". Could complement the reviewer step, not replace it.

## Verification Plan

### Automated Tests
- `agentPromptBuilder` — the coverage step appears for a feature card in a reviewer prompt and is
  absent for a single-plan card; `ANTI_LEAKAGE_STEP` is byte-identical to its current value (pinned by
  `src/test/team-scoped-role-routing.test.js:877-893`).
- A composition-root parity test asserting both hosts wire the reviewer→coder resolution — the gap in
  Defect 3 existed because no such test did.
- **New:** a parity test asserting the inline `resolveTeamMembersForHead`+`originLead` resolution
  sequence is **absent** from `TaskViewerProvider.ts` after extraction (grep the file for the inline
  sequence, expect zero hits) — the gate the original batch-path/single-card-path duplication lacked.
- **New:** a coverage-step test asserting a feature with a subtask that has no `## Implementation Notes`
  entry produces a blocking finding, and a feature whose every subtask has an entry does not.

### Goal Invariants
- A feature with an unimplemented subtask (no `## Implementation Notes` entry and no attributable diff)
  does not reach a passing review verdict.
- A reviewer with a seat dispatches the missing subtask; a reviewer without one refuses and says why.
- The two hosts build the same reviewer prompt for the same card.
- The reviewer→coder resolution lives in exactly one place (the host-neutral helper); the inline
  sequence is absent from `TaskViewerProvider.ts`.

### Manual
- Dispatch a feature with one subtask deliberately unimplemented; confirm the reviewer blocks and
  dispatches rather than completing.
- Repeat under `npx switchboard`.

## Outstanding Questions
- None.
