# No-Subagents Becomes a Team Standing Order, and Planner Defaults To It

## Goal

Make "agents do not spawn subagents" a visible, switchable team standing order that is on by
default, and default the planner role to it outright. Teams are this product's replacement for
subagents, and the policy saying so should be somewhere the operator can see and turn off — not a
constant in a prompt builder.

### Problem analysis

`KanbanProvider.ts:6955` initialises `let subagentPolicy: SeatDirectiveOptions['subagentPolicy'] = 'default'` per role, moving off it only when a per-role toggle is set (`:6956-6957`).

The reviewer's argument is that teams are this product's replacement for subagents, so every role should start at `noSubagents` and opt *in*, not out. The active card *Prohibit Subagents in Memo and Chat Prompts* is scoped to the memo and chat paths — it does not touch the prompt builder's role defaults, so the two do not overlap.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 5
**Tags:** backend, refactor, ux

## User Review Required

**Decided 2026-09-15 by the operator.** Not the blanket flip this plan originally proposed.

- **Planner is the one role whose default changes** to `noSubagents`. Every other role keeps
  `'default'` in the prompt builder.
- **For everyone else the mechanism moves**, from a buried prompt-builder default to a **team
  standing-order add-on** that is **on by default and the user can turn off**.

The operator's reasoning: a default nobody can see is not a policy, it is a surprise. As a standing
order it is visible in the orders surface, attributable to a team, and switchable — which is the
difference between "we decided agents do not spawn subagents" and "a constant in a prompt builder
happens to say so".

## Settled Design

- **Planner defaults to `noSubagents` at the role level.** A planner spawning subagents is doing
  invisible work at exactly the stage the board exists to make visible.
- **Every other role keeps `'default'`** in `KanbanProvider.ts:6955`. The blanket flip is rejected.
- **The general policy becomes a team standing-order add-on, default ON, user-disableable.** The
  carrier already exists: `addons.subagentPolicy` is read at `agentPromptBuilder.ts:2830`, and
  `StandingOrderDefinition` (`standingOrders.ts:41`) is the definition shape. What is missing is a
  default-on add-on and its toggle, not a new mechanism.
- **The emitted text is unchanged** — `NO_SUBAGENTS_DIRECTIVE` (`agentDirectives.ts:51`): *"SUBAGENT
  POLICY: You are strictly forbidden from spawning or invoking any subagents. Handle all tasks
  yourself."* Note `'default'` and `'useSubagents'` emit **nothing** (`agentPromptBuilder.ts:1483`),
  so today the absence of the directive is the current behaviour.
- **Precedence is settled: a team standing order always wins.** Decided by the operator 2026-09-15 —
  *"standing orders for teams always override conflicts in the prompt builder."* Where a team
  standing order and a prompt-builder-derived policy disagree, the standing order is the delivered
  value and the builder's is discarded.
- **The rule is general, not a subagent carve-out.** The prompt builder derives **29** policies from
  the `addons` layer — `driveMode`, `gitProhibitionEnabled`, `pairProgrammingEnabled`,
  `accurateCodingEnabled`, `workflowFilePath` and the rest, alongside `subagentPolicy`. Every one of
  them can be contradicted by a team standing order, so the precedence belongs in the composition
  code **once**, as a stated rule, not re-implemented per policy. Implementing it only for
  `subagentPolicy` leaves 28 policies with undefined behaviour on conflict, which is the state this
  plan is trying to leave.
- **The delivered value records which layer produced it.** This is the CLAUDE.md tagged-source rule
  applied to prompt composition: a policy arriving from two layers with no attribution is how the
  four-level startup-command lookup became unanswerable after the fact. Knowing a standing order won
  is worth as much as the win itself.

## Proposed Changes

### A — the planner role default

#### `src/services/KanbanProvider.ts:6955`
- **Logic:** initialise `subagentPolicy` to `'noSubagents'` **for the planner role only**. Every
  other role keeps `'default'`.
- **Edge case:** a per-role override still wins when explicitly set, including for planner.
- **Edge case:** whatever the Prompts tab renders must show the planner's new default, or the UI and
  the delivered prompt disagree — the same class as the CLAUDE.md fallback rule.

### B — the team standing-order add-on

#### `src/services/standingOrders.ts` and the team add-on path
- **Logic:** add a no-subagents standing-order add-on at team scope, **enabled by default**, with a
  toggle to turn it off. Its body is `NO_SUBAGENTS_DIRECTIVE` verbatim
  (`agentDirectives.ts:51`) — one text, not a second copy that can drift.
- **Edge case:** default-ON is the part that needs care. A default add-on must be composed at
  delivery, never persisted as if the operator had added it — the same invariant the system-core
  orders already follow, or turning it off will look like a deletion and be restored on the next
  compose.
- **Edge case:** the toggle must be discoverable in the orders surface. An add-on that is on by
  default and hidden is the buried default this plan exists to remove, relocated.

### C — precedence, stated once, for every policy

- **Logic:** implement "a team standing order overrides the prompt builder on conflict" as a single
  rule in the composition path, covering all 29 `addons` policies — not a branch inside the
  subagent handling.
- **Logic:** record the winning layer alongside the delivered value, so "which layer answered" is
  answerable after the fact.
- **Edge case:** *conflict* needs a definition. A standing order that says nothing about a policy is
  not a conflict and must not blank the builder's value — only an order that actually speaks to it
  overrides. Getting this wrong turns every standing order into a wipe of every unrelated policy.
- **Edge case:** the default-ON no-subagents add-on from Change B is itself a team standing order,
  so under this rule it overrides a per-role `useSubagents`. That is the intended reading, and it
  means the per-role toggle stops being sufficient to opt out — the team-level toggle is the opt-out.
  Confirm that is wanted before shipping both changes together.

## Verification Plan

### Goal Invariants

1. `KanbanProvider.ts` initialises `subagentPolicy` to `'noSubagents'` for the planner role and to
   `'default'` for every other role. *(Paired: a per-role override still wins when explicitly set,
   so the default is a starting point and not a lock.)*
2. A no-subagents team standing-order add-on exists, is enabled by default, and can be turned off
   from the orders surface.
3. The add-on's body is `NO_SUBAGENTS_DIRECTIVE` itself — no second copy of the text exists.
4. A default-on add-on is composed at delivery and never persisted as an operator-authored row
   *(paired positive: turning it off survives the next compose)*.
5. Where a team standing order and a prompt-builder policy disagree, the standing order's value is
   delivered, and the winning layer is recorded alongside it.
6. That precedence is implemented once in the composition path and applies to every `addons` policy,
   not only `subagentPolicy` — greppable as a single rule, not a per-policy branch.
7. A standing order that does not mention a policy leaves the builder's value intact.
