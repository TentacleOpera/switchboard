# Role Defaults Still Allow Subagents, Though Teams Replaced Them

## Goal

Decide whether `subagentPolicy` should default to `noSubagents` for every role, and apply the decision to the role-default path.

### Problem analysis

`KanbanProvider.ts:6955` initialises `let subagentPolicy: SeatDirectiveOptions['subagentPolicy'] = 'default'` per role, moving off it only when a per-role toggle is set (`:6956-6957`).

The reviewer's argument is that teams are this product's replacement for subagents, so every role should start at `noSubagents` and opt *in*, not out. The active card *Prohibit Subagents in Memo and Chat Prompts* is scoped to the memo and chat paths — it does not touch the prompt builder's role defaults, so the two do not overlap.

**Provenance.** Split out of `memo-fourteen-single-defects-that-belong-to-no-cluster.md` (2026-09-04 memo triage), which held it as one of fourteen unrelated
findings. That card was an explicit holding pen — *"not a unit of work"* — and this is the
individually addressable form. Line numbers in the original were from 2026-09-04 and had drifted;
those below were re-checked on 2026-09-15 unless marked otherwise.

## Metadata

**Complexity:** 3
**Tags:** backend, refactor

## User Review Required

**Yes — this is a policy decision, not a defect.** Flipping the default changes the prompt every role receives. Until it is made, nothing here should be implemented.

## Proposed Changes

### `src/services/KanbanProvider.ts:6955`
- **Logic:** if the decision is to flip, initialise to `'noSubagents'` and keep the per-role override winning when set.
- **Edge case:** whatever the Prompts tab renders for this setting must show the new default, or the UI and the delivered prompt disagree.

## Verification Plan

### Goal Invariants

1. The role-default initialiser matches the recorded decision, and a per-role override still wins when set. *(Paired: if the decision is to keep `'default'`, this plan closes with that recorded and no code change.)*
