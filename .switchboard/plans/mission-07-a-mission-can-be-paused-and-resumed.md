# Mission 07 — A Mission Can Be Paused and Resumed

Subtask of the feature **Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline** (`8ecfdaee`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

A mission can be paused without losing its members or its queue order, and
resumed from the next undelivered member.

## Why

A batch left running overnight must survive the operator stopping a team, and a
restart. Without pause, stopping a team either releases the mission with members
undelivered or leaves it wedged.

### Verified against HEAD (2026-09-20) — pause cannot be derived

- `missions` carries `ready INTEGER DEFAULT 0` (`KanbanDatabase.ts:527`,
  `:1072`) — arm-ness, exactly as this plan says.
- `runState` is **derived, never stored**: `_deriveMissionRunState`
  (`:16513-16530`) computes `'not-started' | 'in-flight' | 'completed'` from
  members' asserted completion, and `_hydrateDerivedMissionFields` (`:16503`)
  attaches it to every read. There is **no fact in the row from which
  "paused" could be derived** — a paused mission with no in-flight member is
  indistinguishable from an unstarted one.
- Therefore pause must be **stored**. `updateMission` (`:16678-16703`) writes a
  fixed field list (`name, type, goal, ready, team, max_extra_worktrees`) and
  needs a `paused` member added.
- Delivery is already tracked by column: a member that has been released has
  moved out of `STAGING` (the pop dispatches it to its stage column, Mission 06),
  and the `mission_members` row survives (`kanban.html:5016-5021` records that a
  dispatched member's row survives). So **"undelivered" = still in `STAGING`**,
  and "resume from the next undelivered member" needs no new ledger.

## Metadata

- **Tags:** backend, feature
- **Complexity:** 5
- **Feature:** 8ecfdaee-8187-4e16-aa6a-e6975c864aba

## User Review Required

No. The one design question this plan carried — new column or a state on the
existing one — is settled by the code above: `ready` is arm-ness and `runState`
is derived, so pause needs its own stored field. This plan records that choice.

## Complexity Audit

### Routine

- `ALTER TABLE missions ADD COLUMN paused INTEGER DEFAULT 0` under a new
  migration gate, plus the column in `SCHEMA_TABLES_SQL`'s `CREATE TABLE`
  (`:1072`) so fresh DBs match.
- `updateMission` gains `paused` in its field list.
- The card badge and the roster read the new field.

### Complex / Risky

- **The default must be safe and visible.** `DEFAULT 0` (not paused) is the
  correct reading for every pre-existing row — a mission that could not be
  paused was never paused. Unlike the config/identity reads AGENTS.md warns
  about, this default cannot turn a loud failure into a quiet wrong answer
  *provided* the card and the row never render paused and unarmed identically.
- **Stopping a team mid-flight must pause, not release.** Today the team
  lifecycle releases a team when its card completes (the in-flight scan reads
  `completed_at`, `:171-172`). A stop with members undelivered must write
  `paused = 1` and keep the team held — **a pause must not read as a release**,
  and the team must not be held twice on resume.
- **The pop must honour pause inside the serialised chain.** The pause check
  belongs in the same candidate filter Mission 01 adds, computed inside
  `_runQueuePop` — not a caller-side check that races a resume.
- **Wave/round advance must honour pause.** Mission 04's advance trigger fires
  on completion; a paused mission must not advance a wave.
- **Resume is not re-launch.** `launchMission` re-stamps owner state and can
  re-provision a worktree (`:16756-16771`). Resume must continue the drain, not
  call `launchMission` again.

## Edge-Case & Dependency Audit

**Race Conditions**

- Pause and a pop in flight: the pop is serialised; the pause write must be
  observed by the next pop, and a pop already committed must not be rolled back
  (a delivered member stays delivered). Document the boundary rather than
  pretending the two are atomic.
- Pause → host restart → resume: pause is stored, so it survives; the member
  order is `column_order` on the cards, which is also stored. Both halves are
  durable by construction.

**Security**

- No new trust boundary. Pause/resume ride the existing mission verbs
  (`updateMission` is already reachable through `mcUpdateMission`,
  `LocalApiServer.ts:6641`).

**Side Effects**

- The board payload must carry `paused` on each mission (`boardMissions`), or
  the card cannot render it. The roster's HELD state must not flip when paused.
- A paused mission still counts toward `getMissions`' cost — no change to that
  known issue.

**Dependencies & Conflicts**

- **Mission 01 (blocker).** The pause check lives in the mission-scoped
  candidate filter.
- **Mission 04.** The advance trigger must consult pause.
- **Mission 03.** Creates and launches; a mission created by a batch launches
  immediately, so pause is the operator's only way to hold it.
- **`completion-is-the-only-way-to-release-a-team-so-it-gets-posted-early`** —
  the release semantics pause must not disturb.

## Dependencies

- `completion-is-the-only-way-to-release-a-team-so-it-gets-posted-early` — the
  release contract; pause must not forge a release.
- `supervised-missions-wake-the-controller-on-transitions` — a pause is a
  transition the supervision surface should see.
- `memo-missions-cannot-be-opened-scoped-or-tested` — the card this plan adds a
  badge to is that plan's subject.

## Adversarial Synthesis

Key risks: pause has no derivable source, so a plan that tries to express it as
a `runState` value will silently be unable to represent it; a stop that releases
the team instead of pausing loses undelivered members; and resume-as-relaunch
would re-provision worktrees and re-stamp owners. Mitigations: a stored `paused`
column with a safe default; the stop path writes paused and keeps the hold;
resume continues the drain rather than calling `launchMission`.

## Proposed Changes

### 1. Pause stops the drain (`src/services/KanbanDatabase.ts`, `src/services/LocalApiServer.ts`)

- **Logic:** add `paused INTEGER DEFAULT 0` to `missions` (new migration gate;
  also in `SCHEMA_TABLES_SQL`'s `CREATE TABLE` at `:1072`; add `paused` to
  `updateMission`'s field list at `:16678`). In `_runQueuePop`'s candidate
  filter, a mission-scoped pop excludes a mission with `paused = 1` — members
  are not released, `column_order` is untouched, the team is not released.
- **Edge cases:** a paused mission's pop returns the mission-named empty result
  (Mission 01's shape), with the reason naming pause, so "paused" and "drained"
  are distinguishable.

### 2. Resume continues from the next undelivered member

- **Logic:** clear `paused`; the next mission-scoped pop selects the
  highest-precedence member still in `STAGING` — the first undelivered one, not
  the first member. No re-launch, no re-hold.
- **Edge cases:** a resume with every member delivered is a no-op that says so.

### 3. A paused mission says so on its card

- **Logic:** render a `PAUSED` badge on `.kanban-card.mission-card` distinct
  from the unarmed state, and carry `paused` on the mission in the board
  payload. The two states must be different strings on the card **and**
  different in the row (`ready = 0` vs `paused = 1`).
- **Edge cases:** a mission that is both unarmed and paused renders both facts,
  not one — collapse is how the fallback rule gets violated on a state field.

### 4. Stopping a team mid-flight pauses its mission

- **Logic:** the team-stop path, when the team holds a mission with undelivered
  members, writes `paused = 1` and keeps the team held, rather than releasing
  the team with members undelivered.
- **Edge cases:** a team with no mission stops exactly as today. A team whose
  mission is fully delivered stops and releases as today.

## Verification Plan

### Automated Tests

- **A paused mission delivers nothing, keeps its members and its queue order** —
  assert member count and `column_order` before/after a pause + pop attempt.
- **Resume continues from the next undelivered member, not the first** — the
  strongest assertion in this plan: pause after two of five are delivered, resume,
  and assert the third member is the one dispatched.
- **Pausing does not release the team; resuming does not re-hold it twice** —
  assert the roster's HELD state and the hold count across a pause/resume cycle.
- **A paused mission and an unarmed one are distinguishable on the card and in
  the row.**
- **Pause survives a host restart** — the flag is stored, and a fresh process
  reads it.

### Goal Invariants

- **Negative:** a mission with `paused = 1` produces no dispatch evidence for
  any member, and its team is not released.
- **Negative:** resume does not call `launchMission` (no second worktree is
  provisioned, no owner state is re-stamped) — behavioural and source-text
  assertion.
- **Positive:** after resume, the first member dispatched is the
  highest-precedence member still in `STAGING`.
- **Negative:** the card never renders "paused" and "unarmed" with the same
  string, and the row never stores them in the same field.
- **Positive:** a mission created and launched by a batch (Mission 03) can be
  paused before its first release and delivers nothing while paused.

## Constraints

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt; nothing here may put it back.

**Derive the pipeline order and the head-role set** — never hand-keep either.
`_PIPELINE_POSITION` shipped wrong once when it was hand-kept.

**Nothing may be silently dropped.** Every plan is delivered or visibly queued.

**Teams are unreleased dev work** — clean break, no migration shims.
