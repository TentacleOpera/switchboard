# Two Teams Can Share a Head Role, and Routing Decides Between Them

## Goal

Let more than one team claim the same head role, and give dispatch a real rule for choosing between
them: the mission's runsheet, then worktree affinity, then whichever team is free, then a nominated
default. Today a second `lead` team is silently demoted, hidden from the UI, and unreachable.

### Problem analysis

**A head role is currently exclusive to one team, and the exclusivity exists to serve a lookup.**

`migrateAgentGroups` (`teamWiring.ts:895-930`) resolves head-role collisions: the first team in
**stored order** keeps the role, every later one is marked `unassigned: true`. The rule exists because
dispatch resolves a team *by role* — `findTeamForHeadRoleInRoots(roots, db, normalizedRole)` at
`TaskViewerProvider.ts:12252` — and that lookup must return exactly one team.

So this is not a rule about teams. It is a **data-model constraint imposed by a by-role lookup**, and
it fails in two ways:

1. **The winner is arbitrary.** "First in stored order" means which team receives dispatched work
   depends on array insertion order, not on anything the operator chose.
2. **The loser disappears.** The `unassigned` flag's own comment says an unassigned team is *"visible,
   editable, explicitly startable, and does not auto-start — the flag means 'not the auto-start
   default', not 'broken'."* The first word is false: the Teams UI filters unassigned teams out.

**Observed 2026-09-09.** A `Coding` team (the operator's, 2 members) and the shipped `Lead team`
preset both carry `headRole: lead`. `Lead team` was flagged `unassigned: true`, vanished from the
Teams UI, and still started — producing a live `lc-lead-team-team` tmux session for a team the
operator could not see, had never wanted, and had no way to delete. It was removed over the API.
That is the state the design explicitly rules out: not the auto-start default, yet running.

#### Why project scope alone does not answer it

Dispatch already threads `initiatorProject`, and `_projectTier()` / `getScopedRoleConfig()`
(`KanbanProvider.ts:751-790`) already resolve *role config* per project. Reusing that for team
selection is tempting and insufficient: two coding teams frequently live in the **same** project,
split across two worktrees set up by a mission. Project cannot tell them apart.

### The routing ladder

Most specific first. Each rung only runs when the one above it does not decide.

| # | Rung | Signal | Why |
| :-- | :--- | :--- | :--- |
| 1 | **Mission runsheet** | `mission_members` (`mission_id`, `member_id`, `member_kind`) | A mission that names its team is an explicit operator decision; it must be authoritative, not advisory. |
| 2 | **Worktree affinity** | `plans.worktree_id` | This is what distinguishes two teams inside one project: they are told apart by *where their work lives*. Self-maintaining — the worktree assignment already made the choice. |
| 3 | **Whichever team is free** | `dispatched_at` set, `completed_at` null | Self-balancing and needs no configuration. The right default for an operator who just has two teams. |
| 4 | **Nominated default for the scope** | project → workspace → global, as role config already resolves | Deterministic tiebreak; replaces "first in stored order". |

#### "Free" is team-level, and must be asserted

**A team is busy when ANY member holds a row with `dispatched_at` set and `completed_at` null.**

Team-level, not seat-level, and the reason is concrete: a team commits once, as its head. Dispatching
into a team whose lead is mid-review means the lead cannot triage the result and the commit is
disturbed — the exact failure the review structure exists to prevent. A team with two idle coders and
a busy lead is **busy**.

**Never infer freedom from silence.** Not "the seat looks quiet", not "the card sits in a coding
column", not an mtime. This board's standing contract is that completion is asserted and never
inferred, and the stall-nudge work on 2026-09-08 is a live example of what timestamp-derived liveness
costs. A router that computes "free" from silence will hand a second batch to a team mid-task.

**When nobody is free**, queue against the rung-4 default team rather than picking arbitrarily or
refusing. The board is already a queue; this needs no new concept.

## Metadata

**Complexity:** 6
**Tags:** teams, dispatch, routing, missions, worktrees
**Dependencies:** none

## User Review Required

None.

## Proposed Changes

### 1. Stop demoting a colliding team (`src/services/teamWiring.ts:895-930`)

- **Logic:** Remove the automatic first-in-stored-order collision resolution. Two teams may share a
  head role; the ladder decides between them at dispatch time.
- **Edge cases:** Existing installs carry `unassigned: true` rows. Clear the flag on load rather than
  leaving teams hidden — the flag no longer means anything.

### 2. Make the Teams UI show every team

- **Logic:** Whatever survives of the flag, the UI must never hide a team it can still start. A hidden
  startable team is unmanageable by construction: the only surface that could delete it filters it out.
- **Rationale:** This is the bug that stranded the operator, independent of the routing work.

### 3. Replace the by-role lookup with the ladder (`TaskViewerProvider.ts:12252` and its standalone twin)

- **Logic:** `findTeamForHeadRoleInRoots` returns one team by role. Replace with a resolver that takes
  the card (mission, worktree, project) plus the role and walks rungs 1-4.
- **Implementation:** One resolver, called from both hosts. `resolveTeamById` already exists for the
  explicit case; the by-role path is the legacy one and is what dictates the current model.
- **Edge cases:** One team for a role — every rung falls through to it, so a single-team board needs
  no configuration and behaves exactly as today.

### 4. A team-busy predicate with one definition

- **Logic:** `isTeamBusy(team)` = any member has `dispatched_at` set and `completed_at` null. One
  implementation, used by the router and by anything else that asks.
- **Edge cases:** A member whose seat has exited but whose row was never completed must not pin a team
  busy forever — reconcile against the fleet, and prefer a stale-dispatch sweep over widening the
  predicate.

### 5. Nominate a default per role, per scope (Teams UI)

- **Logic:** A per-role dropdown — "lead work in this project goes to → Coding" — resolving
  project → workspace → global, the same tiering `getScopedRoleConfig` uses.
- **Edge cases:** The nominated team being deleted falls back to the next tier, never to insertion
  order.

## Verification Plan

### Automated Tests
- Two teams with `headRole: lead` both load, both appear in the UI, neither is flagged.
- A card carrying a mission that names a team routes there regardless of the other rungs.
- A card in a worktree a team is working routes to that team.
- With no mission and no worktree, a batch goes to the team with no outstanding dispatch.
- A team with idle coders and a lead holding an uncompleted dispatch counts as **busy**.
- With both teams busy, work queues against the nominated default.
- One team for a role: routing is unchanged from today.

### Goal Invariants
- No team is ever hidden from the Teams UI while remaining startable.
- Team choice never depends on stored order.
- "Free" is derived only from an asserted completion, never from silence, column or mtime.

### Manual
- Define two lead-headed teams in one project on two worktrees; dispatch a batch and confirm it lands
  on the worktree's team, then a second batch and confirm it lands on the free one.

## Outstanding Questions

- None.
