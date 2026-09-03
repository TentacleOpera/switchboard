# A feature dispatch seats exactly one lead — make it an invariant, not an outcome

## Goal

One rule, enforced in one place: **dispatching a feature seats exactly one agent, the lead of the originating team. It is never fanned to a set, and never falls back to workspace-wide resolution.** If exactly one lead seat cannot be resolved, the dispatch is refused with a message naming what was missing. It does not proceed with a best guess.

### Problem Analysis

**Observed 2026-09-03.** A feature was dispatched to `LEAD CODED`. Multiple coding seats received the lead's orchestration prompt, so more than one agent on the team believed it was organising the work. The operator had to cancel the team. This is not a degraded outcome — it is an incoherent one: a team has one head by definition.

**The routing does not have a rule; it has four branches.** `LocalApiServer.ts:2195-2218` resolves a dispatch target through a chain — explicit `targetTerminalOverride`, then `gate.role`, then an origin terminal, then a team lookup — and emits one of four `teamRouting` outcomes:

| branch | condition | `teamOverride` |
| :-- | :-- | :--: |
| `dispatch role unavailable on this host` | `!gate?.role` | **unset** |
| `<origin> → <hit>` | team lookup succeeded | set |
| `no <role> on <origin>'s team` | lookup missed, no opt-in | **unset** |
| `no origin terminal` | origin unresolved | **unset** |

**Three of four leave the target unresolved and fall through to workspace-wide resolution.** The operator's own dispatch response carried the first one:

```
"teamRouting": "team-scoped: dispatch role unavailable on this host — fell back to workspace-wide"
```

So on this host team scoping is not merely imperfect — it is skipped entirely, on every dispatch, before any team is consulted.

**And workspace-wide resolution operates on a set.** `getRoleTerminalSet` returns `{ terminals, locationKey }` — a collection, not a seat. A fallback that resolves a role across the workspace and hands the result to a delivery path is how one dispatch reaches several terminals.

**The correct behaviour is already in the file, as an opt-in.** The `restrictToOriginTeam` branch refuses rather than falling through, and its comment states the reasoning:

> *"Dispatching workspace-wide would hand this team's card to another team's terminal. Add a `<role>` seat to the team, or dispatch the card yourself with an explicit target."*

That is the right answer. It is reachable only from the external-headed `queue/next` path, so the CLI and board dispatches — the ones an operator actually uses — keep the fail-open behaviour.

### Root Cause

Fan-out is prevented by *arriving at* a single target through a resolution chain, rather than by *asserting* that a feature dispatch has exactly one. Every branch is an opportunity to miss, and the misses fail open. No single place states the invariant, so no single place can enforce it, and a routing chain that is correct in the common case degrades into a broadcast in the uncommon one.

## Metadata

**Complexity:** 3
**Tags:** backend, api, teams, correctness
**Project:** Browser Switchboard

## Proposed Changes

1. **State the invariant and enforce it once.** Before delivery, assert that a feature dispatch has resolved to exactly one terminal. Zero or more than one is a refusal, not a fallback. Put the check at the single point every dispatch passes through, not in each branch.

2. **Make refusal the default, not an opt-in.** Invert `restrictToOriginTeam`: team-scoped resolution refuses on a miss unless a caller explicitly asks for workspace-wide. Keep the existing refusal wording — it already tells the operator both remedies (add the seat, or pass an explicit target).

3. **Never resolve a feature dispatch against a terminal set.** `getRoleTerminalSet` may return many; a feature dispatch must take one deliberately or refuse. Selecting "the first" is not acceptable — that is the fan-out bug with one survivor and no diagnosis.

4. **Say why it refused.** The four `teamRouting` strings are already good diagnostics. Return the relevant one as the refusal reason so an operator sees `dispatch role unavailable on this host` rather than a generic failure — and so the host-level defect behind that string stays visible instead of being papered over by the fallback.

### The one fan-out that is wanted, and why this rule does not block it

Two different things share the word "fan-out". Only one of them is a defect.

| | shape | verdict |
| :-- | :-- | :-- |
| **Broadcast** | ONE card → MANY terminals | **Always wrong.** Several agents each believe they own the same work. This is the observed bug. |
| **Distribution** | MANY cards → MANY terminals, **one card each** | **Wanted.** A set of already-analysed plans dragged into a coding column, one assigned per available seat. |

**Distribution does not violate the invariant — it satisfies it N times.** Each plan is its own dispatch seating exactly one terminal. There is no case in which a single dispatch legitimately targets a set, so the assertion in change #1 stands unmodified and distribution needs no exemption from it.

**Two hard constraints on distribution:**

1. **No member of a distribution set may be a feature.** Features are never fanned — not as the thing being distributed, and not as a member of a distributed set. A feature dispatch always resolves to one lead, which is the rule this plan exists to enforce; putting a feature into a distribution set would route around it. Filter features out of the set and refuse if one is present rather than silently skipping it, so the operator learns their selection was not what they thought.

2. **Distribution requires a parallelisation map.** Assigning plans to seats concurrently is only safe when something has established they do not conflict. That map is `plan_dependencies` plus `map_fingerprint`, which `d2e20f6d` (*Analysis writes a durable dependency graph…*) fills — the table has existed since V64 and holds no rows. Until it does, a "drag several plans into a coding column" gesture has no basis on which to claim the work is independent, and must fall back to sequential dispatch rather than assuming.

**Implementation note.** Distribution belongs at the gesture — the drop handler that receives several cards — not inside the single-card dispatch path. Pushing it into the dispatch path is precisely how a distribute becomes a broadcast: the caller passes one card, the resolver finds several seats, and the difference between "one each" and "all of them" disappears.

### Explicitly not in scope

The **column** cascade. `cascadeFeatureByPlanId` moving a feature's subtasks into the same column is a separate mechanism and stays as it is. This plan constrains who is *seated*, not which cards *move*.

## Verification Plan

1. Dispatching a feature seats exactly one terminal. Asserted by count, not by inspecting which one.
2. With `gate.role` unavailable, the dispatch is **refused** naming that reason — it does not fall back to workspace-wide.
3. With no lead on the origin's team, the dispatch is refused naming that. Adding a lead seat makes the same dispatch succeed.
4. With two seats matching the role workspace-wide, the dispatch is refused rather than picking one.
5. An explicit `targetTerminalOverride` still seats exactly that terminal.
6. The `queue/next` path's existing refusal behaviour is unchanged.
7. Column cascade behaviour is unchanged — a feature's subtasks still move with it.
8. Dragging N non-feature plans with a parallelisation map into a coding column seats N terminals, one plan each — no terminal receives two, no plan reaches two terminals.
9. A selection containing a feature is refused, naming the feature, rather than silently dropping it or dispatching it alongside the plans.
10. With no parallelisation map, the same gesture dispatches sequentially rather than concurrently.
11. No dispatch path can deliver one card's prompt to more than one terminal.
