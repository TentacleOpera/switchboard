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

---

#### Defect 1 — the reviewer is never asked whether the subtasks exist

`agentPromptBuilder.ts` carries a substantial anti-rubber-stamp apparatus, and every piece of it is
about **verification depth on the diff it was handed**:

- `SKIP_DISCLOSURE_STEP` (`:1187`) — declare when checks were not executed, verdict is provisional.
- `ANTI_LEAKAGE_STEP` (`:1194`) — a plan-file note saying "tests were not run" is a record, not an
  instruction; run them yourself.
- `DELEGATION_ANTI_LEAKAGE_STEP` (`:1214`) — the delegation-mode counterpart.
- Provisional-verdict language for mechanisms with no automated check.

**None of it asks about coverage.** The word `subtask` appears 76 times in the prompt builder and
**not once inside a reviewer-role branch** — every occurrence is a planner or coder directive
(`:1152`, `:1153`, `STAGGERED_IMPLEMENTATION_DIRECTIVE` `:1158`, the drive-mode blocks at `:2384`,
`:2409`, `:2768`). The reviewer's contract is "is this diff correct and was it verified", never
"does this feature have subtasks with no diff at all".

A reviewer that is never asked the question cannot be accused of skipping it. The rubber stamp is
the prompt working as written.

---

#### Defect 2 — the Review team preset ships zero members, and the code that reads it documents a member

`TaskViewerProvider.ts:22462-22482` resolves the coder a reviewer delegates to, and names two team
shapes in its own comment:

```
//  (1) reviewer-as-head (Review team preset — reviewer heads its
//      own team, coder is its member): resolve from the
//      reviewer's OWN team.
//  (2) shared-reviewer-as-member (Coding preset — one reviewer
//      is a member of every coding team)
```

Shape (1) names the Review team preset explicitly and asserts "coder is its member". The preset says
otherwise (`teamWiring.ts:610-614`):

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
team's worktree. Delegation itself is then gated on `coder && originLead` (`:22521`), and `originLead`
has already been dropped by the self-target guard (`:22502`) on any re-dispatch of a card already in
CODE REVIEWED, and by the cross-team guard (`:22517`) whenever the two do not share a group.

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
| `resolveTeamRoleTerminal` | `TaskViewerProvider.ts`, 14 call sites | wired, 1 seam (`bootstrap.ts:3790`) |
| `resolveTeamMembersForHead` own-team branch | `:22479` | **absent** |
| self-target guard | `:22502` | **absent** |
| cross-team guard | `:22517` | **absent** |
| `installReviewerCallbackOrder` | `:22528` | **absent** |
| sets `reviewerDelegationMode` / `reviewerCoderTerminal` | `:22521`, `:22490` | **absent** |

`reviewerDelegationMode` and `reviewerCoderTerminal` are set in exactly one non-test file
(`TaskViewerProvider.ts`). Standalone wires the leaf seam and none of the logic above it, so in
`npx switchboard` the reviewer prompt is *never* built in delegation mode — the option is
structurally unreachable, and no gate catches it because the seam it does wire returns a plausible
value.

---

### Migration

None. Teams have never shipped to users, so this is a clean break — no head-prompt migration, no
compat shim.

## Metadata

**Complexity:** 5
**Tags:** reviewer, teams, prompt, standalone-parity
**Dependencies:** the-three-preset-teams-ship-member-less-and-a-migration-strips-members-on-load (supplies the seats)

## User Review Required

None.

## Proposed Changes

### 1. Make the reviewer check subtask coverage before passing a feature (`src/services/agentPromptBuilder.ts`)

- **Logic:** A new reviewer-role step, in the same register as `SKIP_DISCLOSURE_STEP`: when the card
  under review is a feature, enumerate its subtasks from the feature file's auto-generated Subtasks
  block, and for each one establish whether an implementing diff exists. A subtask with no
  implementation is a **blocking** finding — the feature does not pass review on the strength of the
  subtasks that were done.
- **Implementation:** Add the constant beside the other reviewer steps and select it in the reviewer
  steps array. `ANTI_LEAKAGE_STEP` must stay byte-identical — the reviewer-prompt regression gate
  asserts that (`:1207-1212`).
- **Edge cases:** A single-plan card has no subtasks; the step must no-op rather than fabricate a
  finding. A subtask deliberately descoped in the plan is not a missing implementation.

### 2. Tell the reviewer to dispatch the missing subtask to its own seat, not to fix it silently

- **Logic:** Where step 1 finds an unimplemented subtask and the reviewer has a coder seat on its own
  team, the reviewer dispatches that subtask to the seat and reports; it does not implement the
  subtask itself, and it does not pass the feature while one is outstanding.
- **Edge cases:** Two seats, three missing subtasks — the reviewer queues rather than dropping the
  third. No seat resolves (a Review team started head-only): say so in the findings and refuse the
  pass, rather than falling back to a silent stamp.

### 3. Close the standalone gap (`src/standalone/bootstrap.ts`)

- **Logic:** Extract the reviewer→coder resolution from `TaskViewerProvider.ts:22460-22530` into a
  host-neutral helper over `(db, liveTerminals)` — the shape `resolveTeamScopedRoleTerminal` already
  uses — and call it from both composition roots, so `reviewerDelegationMode` and
  `reviewerCoderTerminal` are reachable in `npx switchboard`.
- **Edge cases:** `installReviewerCallbackOrder` writes a pair-scoped standing order; standalone must
  wire it or the coder reports back to the lead instead of the reviewer.

### Alternatives considered

- **A new agent role for a review-time coder.** Rejected — a new instruction string on the existing
  `coder` role is the cheaper and more conventional fix.

## Verification Plan

### Automated Tests
- `agentPromptBuilder` — the coverage step appears for a feature card in a reviewer prompt and is
  absent for a single-plan card; `ANTI_LEAKAGE_STEP` is byte-identical to its current value.
- A composition-root parity test asserting both hosts wire the reviewer→coder resolution — the gap in
  Defect 3 existed because no such test did.

### Goal Invariants
- A feature with an unimplemented subtask does not reach a passing review verdict.
- A reviewer with a seat dispatches the missing subtask; a reviewer without one refuses and says why.
- The two hosts build the same reviewer prompt for the same card.

### Manual
- Dispatch a feature with one subtask deliberately unimplemented; confirm the reviewer blocks and
  dispatches rather than completing.
- Repeat under `npx switchboard`.

## Outstanding Questions

- None.
