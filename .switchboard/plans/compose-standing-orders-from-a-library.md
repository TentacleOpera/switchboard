# Compose standing orders from a library instead of installing monoliths

## Goal

Replace the fixed per-team order bodies with a library of small, named order fragments composed for the situation — whether the team has a reviewer seat, whether the dispatched work is a feature or a plan, which pacing mode is active, and whether an orchestrator is present — so a team is told what applies to it rather than a superset it must reason about.

### Problem Analysis

Standing orders today are **monolithic bodies installed per team**, not composed per situation. Four constants, each a long paragraph, each installed wholesale:

| Constant | Installer | Scope |
|---|---|---|
| `AGENT_GROUP_CALLBACK_INSTRUCTION` (`teamWiring.ts:54`) | `wireSpawnedTeam` | team |
| `SEAT_QUEUE_DONE_ORDER_BODY` (`:154`) | `applySeatPacingOrders` | team + team-head |
| `TEAM_QUEUE_DONE_ORDER_BODY` (`:314`) | `applyTeamQueueOrders` | team + team-head |
| `GLOBAL_QUEUE_DONE_ORDER_BODY` (`:178`) | `installGlobalQueueDoneOrder` | global |

**Three failures follow from installing per team rather than per situation:**

1. **Contradiction.** The seat body tells any seat to move a feature to `CODE REVIEWED` on a board check; the head body forbids exactly that without a reviewer seat. Both are installed on the head. Documented and addressed separately in `remove-the-seat-orders-code-reviewed-clause.md` — but the *reason* both exist is that neither is conditioned on the team's shape.
2. **Wrong-source routing.** Already diagnosed in this repo's own unbuilt plan `context-aware-completion-reporting.md`: *"orders 2 and 3 are installed per team, not per dispatch source. A team with seat pacing on gets order 2 for ALL completions, even work that came from the file-based queue."* Nothing of that plan shipped — no `CONTEXT_AWARE_COMPLETION_ORDER_BODY` exists in `src/`, and `AGENT_GROUP_CALLBACK_INSTRUCTION` is still live at `:54`, `:1818`, `:2122`.
3. **Unconditional instructions that should be conditional.** The head order posts a report to `.switchboard/orchestrator/reports/` (`:769`, `:819`) whether or not an orchestrator is running. A report nobody reads is not a signal.

**Why one context-aware body is not enough.** The existing plan proposes replacing the installers with a single order that branches on dispatch source. That fixes failure 2 and neither of the others: it does not vary by reviewer-seat presence (failure 1) or orchestrator presence (failure 3), and a single body that branches on everything is the monolith again with more conditionals inside it. The variation is along at least four axes, which is a composition problem, not a bigger string.

**And the composed set is now inspectable.** `add-an-orders-tab-to-agent-control.md` renders installed orders, so a composed set can be verified by eye — which is what makes this buildable rather than a leap.

### Root Cause

Each installer was added by the feature that needed it, and each wrote the full text its feature required. Nothing owned the whole set, so overlap accumulated as new paragraphs rather than shared fragments. The contradiction in failure 1 is the natural end state: two features, two bodies, one head holding both.

## Metadata

**Complexity:** 6
**Tags:** backend, refactor, reliability

## User Review Required

- **The axes are the design.** Proposed: reviewer-seat presence, work kind (feature / plan), pacing mode (head / seat), orchestrator presence. Confirm that set — each axis added is a multiplier on what must be verified, and each omitted is a superset an agent must reason about.
- **Fragment granularity.** Proposed: one fragment per *obligation* (report completion, advance a feature, request the next item, commit), each carrying its own preconditions. Finer than that becomes hard to read as emitted text.

## Complexity Audit

### Routine

- A fragment registry: named bodies with an applicability predicate.
- A composer taking `{ reviewerSeat, workKind, pacing, orchestratorPresent }` and returning the ordered fragment set.
- Replacing the four installers with one composition call.

### Complex / Risky

- **This is a behaviour change to ~4,000 installs, delivered as text agents obey.** A composed order that omits a fragment silently removes an obligation — a seat that no longer reports completion presents as a hung queue, not an error. Every axis needs a case asserting the emitted set, not just that composition ran.
- **Stale installed orders are the delivery problem, not the composition.** Bodies live in DB config; changing the composer changes nothing already installed. `rewriteStandingOrdersForRename` (`standingOrders.ts:63`) is the existing precedent for a rewrite pass, and the repo documents the failure mode as `a-stale-standing-order-can-still-reach-a-live-agent.md`. Recomposition on team wiring, pacing change, roster change and queue-mode change all need to trigger it — a roster edit that adds a reviewer seat must recompose, or the team keeps orders for a shape it no longer has.
- **`selectOrders` scoping interacts with composition.** Delivery already resolves membership from the registered group, and the `team` / `team-head` convention uses `parent` to exclude the head from member delivery (`:374-377`). Composition must respect that rather than introducing a second scoping mechanism.
- **The client mirrors the resolver.** `terminals.js:10353-10354` states it: *"Keep in sync with `src/services/standingOrders.ts` — the marker string is the contract"*, and `:10667` mirrors `applyStandingOrders`. Composition must stay server-side; the client renders what it is given.
- **Superseding the existing plan must be explicit.** `context-aware-completion-reporting.md` proposes deleting `applySeatPacingOrders` and `applyTeamQueueOrders` and their tests. This plan subsumes that. Two plans deleting the same installers independently is how the ordering collision earlier in this programme happened.
- **Orchestrator presence is the one axis with no clean signal.** Reviewer seat comes from the roster, work kind from the card, pacing from the team's stored field — but "is an orchestrator running" needs a source. `orchestratorActive` / `orchestratorArmed` config keys exist; whether either is a reliable liveness signal needs checking before the axis is committed to.

## Edge-Case & Dependency Audit

**Migration.** The substance of the work. Installed orders are rewritten to composed sets; unknown or hand-added orders must be preserved rather than dropped, per this project's rule about state that shipped.

**Security.** Fragments contain endpoint paths and localhost ports, never credentials — `sb_api_call` injects tokens host-side. The composer must not interpolate anything caller-supplied into a fragment beyond validated names (`validateInstruction`, `standingOrders.ts:363`).

**Side effects.** Emitted orders get shorter and more specific, which changes prompt sizes. Worth measuring, since order text rides on every message carrying standing orders — including turn-end notifications.

**Ordering.** After the task-complete endpoint (a fragment names it) and after the Orders tab (so a composed set can be inspected). The clause deletion can land before or be absorbed.

## Dependencies

- **Requires** `add-a-task-complete-endpoint-for-the-lead.md` — the completion fragment calls that route.
- **Wants** `add-an-orders-tab-to-agent-control.md` first, for verification by eye.
- **Supersedes** `context-aware-completion-reporting.md` (C5, unbuilt). That plan should be marked superseded rather than left to be built alongside.
- **Absorbs** `remove-the-seat-orders-code-reviewed-clause.md` if that has not already shipped.

## Adversarial Synthesis

**"Composition is over-engineering — just fix the two bodies."** Fixing the bodies is what produced them: each was correct for its feature and wrong as a superset. There are four axes of real variation; encoding them as conditionals inside two strings is the same object with worse ergonomics.

**"Build the single context-aware order that is already planned."** It addresses one axis of three. It is also the cheaper first step, and if the appetite is for one step this is the one — but it should then be understood as partial, not as the fix.

**"Agents can reason about a superset — they are language models."** They can, and the evidence in this repo is that they do not reliably: the seat body's cheap board check sits beside the head body's roster check, and the cheap one wins. Removing the choice is more reliable than expecting it to be made well.

**"Fragments will drift out of sync with each other."** A real risk, and the reason the Orders tab is a soft prerequisite: the composed set becomes readable. Drift you can see beats a monolith you cannot.

## Proposed Changes

1. **Fragment registry** — named bodies, one per obligation, each with an applicability predicate.
2. **Composer** over `{ reviewerSeat, workKind, pacing, orchestratorPresent }` returning an ordered set.
3. **Replace the four installers** with one composition call, respecting the existing `team` / `team-head` scoping convention.
4. **Recompose on every input change** — team wiring, pacing change, roster change, queue-mode change.
5. **Rewrite installed orders** to composed sets, preserving unknown or hand-added ones.
6. **Make the orchestrator-report fragment conditional** on orchestrator presence.
7. **A fragment naming `POST /kanban/task/complete`** as the lead's completion signal.
8. **Mark `context-aware-completion-reporting.md` superseded.**

### Migration

Installed orders rewritten; unrecognised orders preserved. Recomposition triggers wired to each input.

## Verification Plan

### Goal Invariants

- Every emitted set is the composition of fragments applicable to that team's actual shape.
- No emitted set contains an instruction contradicting another in the same set.
- A team with no reviewer seat is never told to move a card to `CODE REVIEWED`.
- A team with no orchestrator is never told to post an orchestrator report.
- Every seat retains a completion obligation under every combination.

### Automated Tests

- **Axis matrix:** assert the emitted set for each combination of the four axes. This is the plan's core test — a missing fragment is a silently removed obligation, and only a per-combination assertion catches it.
- **No contradictions:** for every combination, assert no two fragments instruct conflicting card movement. This is the invariant whose absence produced the current bug, so it is asserted directly rather than implied by the matrix.
- **Completion always present:** assert every combination yields exactly one completion obligation — never zero (hung queue), never two (double-reporting).
- **Recomposition triggers:** add a reviewer seat to a live team and assert its orders recompose. Roster change is the trigger most likely to be missed, since the others coincide with an explicit toggle.
- **Stale rewrite:** seed old monolithic bodies, migrate, assert composed sets replace them and hand-added orders survive.
- **Server-side only:** assert no composition logic exists client-side, pinning the constraint `terminals.js:10353` already states.
- **Emitted size:** record the emitted text length per combination, so the prompt-size effect is measured rather than assumed.

## Outstanding Questions

- **[user]** Confirm the four axes.
- **[user]** Fragment granularity — one per obligation?
- Is there a reliable orchestrator-liveness signal? `orchestratorActive` and `orchestratorArmed` exist as config keys; if neither is trustworthy, that axis needs a different source or should be dropped from v1 rather than composed on a guess.
- Does any fragment need to vary by role beyond head/member? The `role` scope exists in `StandingOrderScope` (`standingOrders.ts:3`) and is not currently used by these installers.
