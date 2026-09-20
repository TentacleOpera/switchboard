# Mission 06 — A Mission Owns Its Members' Columns; a Single Plan Still Routes

Subtask of the feature **Every Batch Move Becomes One Declared Thing — a Mission or a Fan-Out Pipeline** (`8ecfdaee`). The feature file carries the full argument and the constraints binding every subtask. This plan is self-sufficient on its own scope and, where the two disagree, **this plan wins** — it is the source of truth for the seat implementing it.

## Goal

Complexity routing decides the seat for a **single** plan and stops deciding for
a **batch**, which the mission now owns.

## The rule is about the unit, not the team

**Unchanged and load-bearing:** an individual plan dispatch still routes by
complexity. A cx-2 card sent on its own still goes **straight to the Coding
team's intern**, and with no Coding team it still routes by band into the Feature
team. That is what makes a cheap seat worth having.

**What changes:** once a batch's plans are a mission's members, the mission
decides where each goes as it delivers it. Routing members individually scatters
one mission across three columns and contradicts the seat the team was going to
give each one. `LocalApiServer.ts:6016` records that exact failure — *"a cx-2
subtask resolved INTERN CODED while the card sat at LEAD CODED … the move was
refused, and the whole round reported a delivery error"* — and notes it *"only
ever appeared to work by coincidence."*

**Features are already exempt** (`resolveAutoDispatchColumn` returns the lead
column before the band is read) and stay exempt.

### Verified against HEAD (2026-09-20) — where the auto-route actually fires

- `_resolveKanbanDispatchPreDelivery` (`LocalApiServer.ts:3452`) routes by
  complexity whenever the caller passes no column or `'auto'`:
  `resolveAutoDispatchColumn(workspaceRoot, record.complexity, isFeature)`
  (`:3491-3498`). An explicit column is canonicalised and **wins** (`:3499-3504`).
- The queue pop passes **no column** except for the escalation override:
  `const rawColumn = overrideRole ? roleToCodingColumn(overrideRole) : undefined;`
  (`:4316-4317`). So **every ordinary pop is complexity-routed per card** — this
  is the mechanism the feature's Gap 6 names.
- `resolveAutoDispatchColumn` (`KanbanProvider.ts:10940-10997`) returns
  `LEAD CODED` for a feature (`:10947-10952`) and for routing-off
  (`:10953-10956`), and the intern/coder/lead band otherwise, with degradation
  when a role is hidden.
- The precedent for "the team decides, not complexity" is already in the code:
  `_dispatchRoundCore` passes `keepColumn = subtaskRec?.kanbanColumn`
  (`:6030-6036`) with the comment *"Keep the card where it is. A team decides
  who works what; complexity routing is the NON-team path."*

So this plan does not invent a mechanism — it applies the round path's rule to
the mission release, using the pop's existing explicit-column channel.

## Metadata

- **Tags:** backend, refactor
- **Complexity:** 4
- **Feature:** 8ecfdaee-8187-4e16-aa6a-e6975c864aba

## User Review Required

No. This is the same rule the feature-round path already follows, extended to
the mission release.

## Complexity Audit

### Routine

- Passing an explicit column on the mission release, through the channel the
  escalation override already uses (`LocalApiServer.ts:4316-4317`).
- The single-plan path is untouched: no `missionId` → no override.

### Complex / Risky

- **"Keep the card where it is" is not literally available here.** The rounds
  path can keep the card's column because the card already sits in the team's
  column. A mission member sits in `STAGING`; keeping it there would dispatch a
  card in the queue column. The release must pass **the mission's stage column**
  — the column the mission's team works at — which Mission 08 derives. This plan
  consumes that derivation; it must not hand-keep a second mapping.
- **Explicit column precedence.** The release's column must be passed as the
  dispatch's `targetColumn`, i.e. through the *same* precedence as an operator
  drag, so the rule stays one rule: an explicit column wins over auto-routing,
  whoever supplied it. Do not add a `skipAutoRoute` flag — a second switch that
  means the same thing is how the two paths drift.
- **Non-mission pops must not change.** The Run-queue button, the schedule
  timer, the queue watch and the standalone coder all pop without a mission and
  must keep complexity routing. Gate strictly on the mission release.
- **Escalation override still wins.** `_dispatchRoleOverride`
  (`:4307-4317`, `:4346`) re-stages a failed card to a stronger seat and passes
  that column explicitly; on a mission member it must keep doing so, and must
  not be clobbered by the mission's stage column.

## Edge-Case & Dependency Audit

**Race Conditions**

- None new. The column is resolved at pop time inside the serialised chain.

**Security**

- No new trust boundary.

**Side Effects**

- A mission's members all land in the team's stage column, so a Coding mission's
  four members sit in `CODER CODED` together rather than scattering across
  `INTERN CODED`/`CODER CODED`/`LEAD CODED`. That is the requested behaviour; the
  board must render N cards in one column without treating them as a batch that
  needs re-routing.
- The run sheet's direction classification (`_isColumnBefore`, `:10603`) is
  unaffected: the release is a forward move from `STAGING` into the stage column.

**Dependencies & Conflicts**

- **Mission 01 (blocker).** The release must be mission-scoped before its column
  can be mission-owned.
- **Mission 08.** Owns the stage derivation (`_PIPELINE_POSITION` +
  `_isParallelCodedLane`) this plan reads. Landing M06 before M08 means the
  stage column is computed in two places — do not do that; land M08's derivation
  first or in the same change.
- **Mission 04.** The wave release dispatches N members at once; every member's
  column comes from here.
- **Mission 05.** The rounds path already keeps the card's column; it must not
  be changed by this plan (its `keepColumn` is correct for a card that is
  already in the right column).

## Dependencies

- `two-teams-can-share-a-head-role-and-routing-decides-between-them` — reads
  `missions.team` at dispatch; the stage column here derives from the same team
  binding, so the two must agree on where `missions.team` is read.
- `the-researcher-is-a-team-seat-not-a-board-column` — the retired-column
  precedent for keeping a role out of the pipeline ranking.

## Adversarial Synthesis

Key risks: the release's column could be hand-kept as a second mapping of team →
column (the exact drift `_PIPELINE_POSITION` shipped wrong once); a
`skipAutoRoute` flag would create a second precedence rule; and the escalation
override could be clobbered. Mitigations: consume Mission 08's derived stage
column; pass it through the existing explicit-column channel so drag and release
share one precedence; keep the escalation override's column applied last.

## Proposed Changes

### 1. The per-card auto-route does not run for a member being released from a mission (`src/services/LocalApiServer.ts:4316`)

- **Logic:** when the pop is mission-scoped (Mission 01's `missionId`), resolve
  the mission's stage column (Mission 08's derivation) and pass it as the
  dispatch's explicit column, taking precedence over the auto-route the same way
  the escalation override does. The escalation override, when present, is
  applied **after** and still wins.
- **Edge cases:** a mission whose team cannot be resolved to a stage column
  (a hand-added team with an unknown `headRole`) fails loudly rather than
  falling back to auto-routing — a silent fallback would scatter the mission
  exactly as before, and be invisible.
- **Implementation:** `_resolveKanbanDispatchPreDelivery` needs no change: it
  already treats a non-empty `rawColumn` as explicit (`:3499-3504`). The change
  is at the pop, where `rawColumn` is computed.

### 2. A dispatch naming an explicit column still lands there

- **Logic:** a drag with `targetColumn` is the operator deciding, and that is
  not auto-routing (`:3499`). Unchanged; assert it so a later refactor cannot
  make the mission release override an operator's explicit column.

### 3. Single-plan dispatch is untouched

- **Logic:** no mission → no explicit column → today's `resolveAutoDispatchColumn`
  behaviour, byte-for-byte, including the feature exemption and the degradation
  when a role is hidden.

## Verification Plan

### Automated Tests

- **A cx-2 card dispatched on its own reaches the Coding intern; with no Coding
  team it reaches the Feature team by band** — the existing
  `resolveAutoDispatchColumn` fixtures are the gate and must pass unmodified.
- **A mission's members are not re-routed card by card as they are released** —
  assert all members of a Coding mission land in one column and the number of
  distinct release columns is 1.
- **A feature still ignores complexity entirely** (`:10947`).
- **An explicit column still wins** — a dispatch naming `LEAD CODED` for a cx-2
  card lands at `LEAD CODED`.
- **The escalation override still wins** over the mission's stage column.
- **An unresolvable team stage fails loudly** — no silent fallback to
  auto-routing.

### Goal Invariants

- **Negative:** a mission-scoped release never calls the auto-route path
  (`resolveAutoDispatchColumn`) for its members — source-text and behavioural
  assertion.
- **Positive:** every member of a mission is released into the mission's team's
  stage column, and that column comes from Mission 08's derivation, not a second
  mapping (source-text: exactly one team→stage resolver exists).
- **Positive:** a non-mission pop still complexity-routes — a cx-2 card popped
  from the plain queue lands at `INTERN CODED`.
- **Positive:** a dispatch that names an explicit column lands there regardless
  of complexity.

## Constraints

**No hand-dispatch on the Coding team.** `ptySendPrompt`-to-a-seat was
deliberately removed from its head prompt; nothing here may put it back.

**Derive the pipeline order and the head-role set** — never hand-keep either.
`_PIPELINE_POSITION` shipped wrong once when it was hand-kept.

**Nothing may be silently dropped.** Every plan is delivered or visibly queued.

**Teams are unreleased dev work** — clean break, no migration shims.
