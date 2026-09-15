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
- **One policy, one place.** Once the add-on exists, a per-role `subagentPolicy` override and a team
  add-on can disagree. Precedence must be stated and recorded in the delivered prompt's source, or
  this becomes another "which store answered" question.

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

### C — precedence, stated once

- **Logic:** a per-role `subagentPolicy` and the team add-on can disagree. Decide and document which
  wins, and record the source alongside the value so "which layer answered" is answerable after the
  fact.
- **Edge case:** this is the CLAUDE.md tagged-source rule applied to prompt composition — a policy
  arriving from two places with no attribution is how the startup-command bug happened.

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
5. Where a role policy and the team add-on disagree, the delivered prompt's source is recorded.
