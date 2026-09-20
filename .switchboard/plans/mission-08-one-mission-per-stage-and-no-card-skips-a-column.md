# Mission 08 — One Mission per Stage, and No Card Skips a Column

Subtask of the feature **Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline** (`8ecfdaee`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

A card belongs to **at most one mission**, and a mission releases a card only
when the card sits in the stage immediately before the mission's stage. A card
never jumps a stage.

## The rule, in two parts

1. **One mission per card.** A card is a member of exactly one mission, or none.
   When a card is claimed into a second mission, it is **removed from the first
   automatically**, and the removal is recorded on both — the later claim wins,
   because it is the one the operator just made.

2. **No stage skipping.** A mission releases a card only when the card sits in
   the stage **immediately before** its own. A review mission may not pull a card
   out of CREATED — that jumps planning and coding at once. Such a member is
   **held, not delivered**, and the card says why.

> **Superseded (operator decision, 2026-09-20):** "Two missions may hold the same
> card only when they act at different, consecutive stages. … A coding mission
> and a review mission on the same card are legitimate: they are consecutive
> stages and the card passes through both. Two coding missions on the same card
> are not — one would redo the other's work."
> **Reason:** the operator has removed the two-missions-on-one-card requirement
> outright — *"there is not meant to be two missions on one card, that's fucking
> stupid … is being changed to remove this requirement."* The code agrees: there
> is **no way to express it**. `mission_members` carries
> `CREATE UNIQUE INDEX IF NOT EXISTS idx_mission_members_member ON
> mission_members(member_id)` (`KanbanDatabase.ts:777`, added by V65 at `:1080`),
> so a `member_id` may appear in exactly one mission — `addMissionMember` is
> `INSERT OR IGNORE` (`:16711-16717`), which means a second claim is **silently
> dropped** rather than stored. `getMissionsForMember`'s own comment says
> "normally zero or one" (`:16752`). The old rule could therefore never be
> implemented without dropping the unique index, and it also made the same-stage
> case ("two coding missions") unreachable — it could only have been detected at
> claim time, which is exactly where the transfer below happens.
> **Replaced with:** **one mission per card, always.** Joining a mission
> transfers the card: the prior membership is removed and the removal is
> recorded on both missions. The stage rule survives as a **release** gate, not
> a membership gate — it decides whether a mission may *deliver* a card, which is
> where "no stage skipping" actually has teeth.

## Build it on what exists

`_PIPELINE_POSITION` (`KanbanProvider.ts:10588`) is derived from
`DEFAULT_KANBAN_COLUMNS`' `order`, and `_isColumnBefore` (`:10603`) answers "is A
before B". **Do not write a second ranking** — that list already disagreed with
reality once, ranking RESEARCHER before PLAN REVIEWED and TICKET UPDATER after
COMPLETED, with a backward move read as forward, *"which dispatches"*.

**The coded lane is ONE stage.** `_isParallelCodedLane` (`:8974`) already says
LEAD / CODER / INTERN CODED are parallel seats, so a mission whose team works
the coded lane is at the coding stage whichever coded column a member sits in.
This is why the "two coding missions" collision disappears entirely under the
one-mission rule: there is one stage and one mission for it.

### Verified against HEAD (2026-09-20) — the stage a mission works at

A mission's stage is derived, in this order, from facts that already exist:

1. `missions.team` → the team definition (`resolveDefinitionForGroup` /
   `DEFAULT_TEAM_DEFINITIONS`, `teamWiring.ts:1011-1213`).
2. the definition's `headRole` → the column the role works at
   (`_columnToRole`'s inverse, `KanbanProvider.ts:16468-16480`;
   `roleToCodingColumn` for the coded lane).
3. that column → a **stage** by collapsing the coded lane with
   `_isParallelCodedLane` (`:8974`) and ranking with `_PIPELINE_POSITION`
   (`:10588`).

One resolver, `resolveMissionStage(mission)`, owns this. **Mission 06 consumes
it** for the release column; Mission 03's created missions set `team`, which is
what makes the derivation possible. A second, hand-kept team→column mapping is
the exact defect `_PIPELINE_POSITION`'s comment records.

## Metadata

- **Tags:** backend, feature
- **Complexity:** 5
- **Feature:** 8ecfdaee-8187-4e16-aa6a-e6975c864aba

## User Review Required

No — the requirement change in this plan is the operator's own decision
(2026-09-20), recorded above. The remaining design (transfer-at-claim, and the
release gate) follows from the schema and from `_PIPELINE_POSITION`.

## Complexity Audit

### Routine

- The one-mission invariant is already enforced by `idx_mission_members_member`;
  no schema change is needed to hold it.
- `removeMissionMember` exists (`:16719`).
- The stage ranking is a read of `_PIPELINE_POSITION` + `_isParallelCodedLane`.

### Complex / Risky

- **Transfer-at-claim must be explicit and recorded.** Today a second claim is
  *silently ignored* by `INSERT OR IGNORE`. Replacing that with remove-then-add
  changes behaviour: a card claimed by a second mission leaves the first. Both
  missions must record it (a `plan_events` entry on each) so "why did mission A
  lose this card?" is answerable after the fact — otherwise the silent-ignore
  bug is replaced by a silent-steal bug.
- **The release gate is where the risk lives.** Holding a card is easy; holding
  it *visibly* is the requirement. A held member must not look like a delivered
  one and must not look like a mission with nothing to do — the empty-list-is-a-
  claim rule applied to a member.
- **Stage derivation must not become a second ranking.** See the resolver above.
- **A mission whose team cannot be resolved to a stage** (a hand-added team, a
  team deleted after the mission was created) must fail loudly at release rather
  than defaulting to "no gate", which would deliver everything.

## Edge-Case & Dependency Audit

**Race Conditions**

- Two claims for the same card in flight: remove-then-add must be serialised (the
  board's move path already serialises bulk moves per workspace,
  `KanbanProvider.setBulkMoveActive`), or the card can end up in neither mission.
  Make the transfer one transaction, not two statements.
- A claim arriving while the first mission is mid-release: the transfer must
  either win before the release reads its member set or lose cleanly; the
  release reads its member set inside the serialised pop (Mission 01), which is
  the point at which the outcome is decided.

**Security**

- No new trust boundary. Claims arrive through the existing board-move path.

**Side Effects**

- A card that leaves a mission changes that mission's member count and therefore
  its derived `runState` (`_deriveMissionRunState`, `KanbanDatabase.ts:16513`).
  A mission can flip from `in-flight` to `completed` because a card was claimed
  away — that is correct (the work left) but must be visible, not a silent
  state change.
- The mission card's "why is this member held" text is a new render state
  (Mission 07 adds the paused badge; this adds a held reason). Both are states
  on the one existing card — do not add a second card.

**Dependencies & Conflicts**

- **Mission 03 (blocker).** A mission created by a batch sets `team`; without it
  the stage derivation has nothing to read.
- **Mission 06.** Consumes `resolveMissionStage` for the release column. M08 owns
  the derivation; M06 must not re-derive it.
- **Mission 01.** The release gate is evaluated inside the mission-scoped pop.
- **Mission 04/05.** A wave/round release is a release, so the no-skip gate
  applies to it too.
- **Mission 07.** A paused mission does not release; a held member is not a
  paused mission.

## Dependencies

- `a-mission-carries-many-teams-and-missions-team-cannot-express-it` — widens
  mission team-ness later; this plan's one-team-per-mission assumption must
  survive that change (the stage derives from the mission's team, and that plan
  keeps `missions.team` as the nominated default).
- `the-researcher-is-a-team-seat-not-a-board-column` — the precedent for a role
  that is a seat but not a pipeline column, which the stage derivation must not
  mistake for a stage.
- `memo-missions-cannot-be-opened-scoped-or-tested` — the card this plan adds a
  held reason to.

## Adversarial Synthesis

Key risks: the old rule was unimplementable (a unique index forbids two missions
per card) and would have shipped as a silent no-op; transfer-at-claim replaces a
silent ignore with a possible silent steal; and a held member can render
identically to a delivered one. Mitigations: state one-mission-per-card as the
rule and let the existing index hold it; make the transfer one recorded
transaction on both missions; give the held member a visible reason and keep the
stage ranking in `_PIPELINE_POSITION` alone.

## Proposed Changes

### 1. One mission per card — transfer at claim (`src/services/KanbanProvider.ts`, `src/services/KanbanDatabase.ts`)

- **Logic:** a `claimIntoMission(missionId, memberId, kind)` operation: read the
  card's current missions (`getMissionsForMember`, `:16753`), and when a
  different mission holds it, `removeMissionMember` from that one and
  `addMissionMember` to the new one **in one transaction**, recording a
  `plan_events` entry on each. `stageForQueue` (`KanbanProvider.ts:9905-9931`)
  and Mission 03's batch claim both call this instead of `addMissionMember`
  directly.
- **Edge cases:** a claim into the mission the card is already in is a no-op.
  A claim into a mission in another workspace is refused (the existing
  workspace-scoped check at `:9888-9896` is the model).

### 2. The release gate — no stage skipping (`src/services/KanbanProvider.ts`, `resolveMissionStage`)

- **Logic:** `resolveMissionStage(mission)` returns the stage the mission's team
  works at (team → `headRole` → column → stage, coded lane collapsed by
  `_isParallelCodedLane`, ranked by `_PIPELINE_POSITION`). The pop (Mission 01's
  scoped candidate set) holds — does not dispatch — any member whose card does
  not sit in the stage immediately before that stage, and the card says why.
- **Edge cases:** a member in `STAGING` (never released) is not "in a stage
  before the mission's" — it is undelivered and eligible, which is the normal
  case. The gate governs *re-release* of a card that already moved. A member
  already past the mission's stage (e.g. `COMPLETED`) is not re-delivered.
- **Failure mode:** an unresolvable stage (unknown team) refuses to release and
  says so, rather than delivering everything.

### 3. One ranking, one card

- **Logic:** no second stage list; `_PIPELINE_POSITION` and `_isParallelCodedLane`
  are the only sources. The held reason renders on the existing mission card.

## Verification Plan

### Automated Tests

- **Claiming a card into a second mission removes it from the first, visibly on
  both** — assert one membership row for the card, and one recorded removal on
  the first mission.
- **A card is never a member of two missions** — assert the unique index holds
  and `getMissionsForMember` returns length ≤ 1 after any sequence of claims.
- **A review mission holding a card that sits in CREATED delivers nothing and
  says why; the same card in a coded column delivers.**
- **The ordering comes from `_PIPELINE_POSITION`; no second ranking exists** —
  source-text assertion, in the style of the existing contract checks.
- **A card in a coded column is at the coding stage regardless of which coded
  column it is in** (`_isParallelCodedLane`).
- **An unresolvable mission team refuses to release, loudly.**

### Goal Invariants

- **Negative:** no card is a member of two missions at any time — a second claim
  leaves exactly one membership row.
- **Negative:** a mission never dispatches a member whose card is not in the
  stage immediately before its own — assert no dispatch event for a review
  mission's member sitting in CREATED, and assert a visible held reason exists.
- **Negative:** no stage ranking other than `_PIPELINE_POSITION` (+
  `_isParallelCodedLane` for the coded lane) exists in the tree.
- **Positive:** a claim that moves a card between missions records the removal on
  the mission that lost it.
- **Positive:** the mission card renders a held member's reason without adding a
  second card element.

## Constraints

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt; nothing here may put it back.

**Derive the pipeline order and the head-role set** — never hand-keep either.
`_PIPELINE_POSITION` shipped wrong once when it was hand-kept.

**Nothing may be silently dropped.** Every plan is delivered or visibly queued.

**Teams are unreleased dev work** — clean break, no migration shims.
