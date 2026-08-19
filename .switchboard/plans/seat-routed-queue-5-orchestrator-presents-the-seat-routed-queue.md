# The Orchestrator Presents the Seat-Routed Queue as a Third Option

## Goal

Teach the orchestrator persona that a seat-routed queue exists, when it is the better choice, and how to hand off into it — so an operator who opens the orchestrator is offered the simplest mechanism that fits their work instead of the only two the persona currently knows.

### Problem analysis — root cause

The orchestrator's decision point is `## Handoff, or arm?` (`.agents/skills/switchboard-orchestrator/SKILL.md:256`) and it enumerates exactly two options:

- **Handoff (default for one team)** — stage the queue, dispatch card one, exit; *"the pipeline is lead-paced and queue-watched"* (`:260`).
- **Self-wake (agent-managed persistence)** — the orchestrator stays alive and ticks (`:262`).

Both assume a lead paces the pipeline. The assumption is then hardcoded downstream rather than derived: `## The handoff sequence` step 4 says *"dispatch the first card to the lead"* (`:276`), `## Hard Rules` describes `queue/next` as *"hands the next staged card to the lead"* (`:40`), the session-state vocabulary at `:265` defines `handed off` as *"nothing running but the queue and its watch"*, and the tick's fallback at `:363` routes a ready feature *"to the coding team lead"*.

So after subtasks 1–4 land, the persona is not merely silent about seat pacing — it is **wrong** in four places about what `queue/next` does, because the answer now depends on the team's pacing field. An orchestrator reading it will describe head behaviour to an operator running a seat-paced team, and will hand off with a report that names a pacing lead that is not pacing anything.

This is why the change is a plan and not a docs footnote: the persona is gated by `src/test/orchestrator-tick-and-reports-contract.test.js`, and the preceding feature's notes record that persona edits **serialise** — subtasks 5, 6, 7 and 4 of `lead-paced-pipeline` all wrote this same file and collided. This subtask must be the only agent stream in the file while it runs.

### What the orchestrator should actually say

The persona's value is judgement, and the judgement here is a genuine trade, not a preference:

- **Seat-routed queue** — a flat list of standalone plans of mixed complexity, no cross-plan coordination, and the operator wants to walk away. No head reasoning about the work, no review hop, one card at a time. Cheapest and fewest moving parts.
- **Lead-paced (head) queue** — the plans need a head that reads them, delegates subtasks, and hands the finished work to a reviewer. Keeps the quality gate.
- **Self-wake** — multiple teams, worktrees or repos to coordinate, or merge-back to run.

The persona already states that a resident orchestrator over a one-at-a-time pipeline is *"a manager watching a manager"*. A seat-routed queue is the end of that argument, and the persona should present it as such rather than as an exotic mode.

## Metadata

**Complexity:** 2
**Tags:** docs, feature

## Implementation

1. **Add the third option to `## Handoff, or arm?`** with the trade stated in one line each, in the register the two existing entries use. Name the precondition explicitly: the team's pacing field must be `seat`, and the orchestrator **reads** that field — it does not set it. Setting pacing is the operator's call on the team, and an orchestrator that flips other people's team configuration is exactly the unattended side effect this persona is scoped away from.

2. **Fix the four hardcoded "to the lead" claims** so each derives from pacing instead of asserting head behaviour:
   - `## Hard Rules:40` — `queue/next` hands the card to the lead **in head pacing**, or to the complexity-routed seat **in seat pacing**.
   - `## The handoff sequence:276` — step 4 dispatches card one; where it lands depends on pacing, and the report must name the actual destination the call returned rather than assuming.
   - `:265` — `handed off` stays correct as written but should note that in seat pacing there is no lead holding the pacing instruction; the seats hold it.
   - `:363` — the tick's ready-feature fallback: keep the lead route for head-paced teams, and for a seat-paced team stage into the queue rather than messaging a lead that is not driving.

3. **Add a seat-paced variant of the handoff sequence**, not a second sequence. Steps 1–3 (scope, launch, stage) and step 5 (report and exit) are identical; only step 4's destination and the report's wording differ. Duplicating the whole sequence guarantees the two drift.

4. **State the queue-watch difference in one sentence.** In head pacing the watch nudges the lead. In seat pacing it nudges the seat holding the card, and escalates to the operator on the first pass when no seat holds one — so an orchestrator that has handed off into a seat-paced queue should tell the operator that a dead seat surfaces to *them*, not to an agent.

5. **Leave `POST /orchestration/handoff` unchanged.** Its `409` preconditions — a live coding head and a non-empty `DISPATCH` queue — both still hold in seat pacing: a seat-paced team still needs seats live, and `from` still resolves through a coding head for roster purposes. Changing the endpoint is out of scope; if its refusal text names "the lead" specifically, adjust the *text* only.

6. **Mirror to `.claude/skills/switchboard-orchestrator/SKILL.md`** if that path carries a copy, and to any registry description that enumerates the modes. The preceding feature's review found a prompt sentence missing from its third mirror; grep before declaring done.

## Verification Plan

1. **Gate assertions in `src/test/orchestrator-tick-and-reports-contract.test.js`:** the third option is present in `## Handoff, or arm?`; no remaining unconditional "to the lead" claim about `queue/next` anywhere in the persona; the seat-paced handoff variant exists and shares steps 1–3 and 5 with the head variant.
2. **Mirror gate:** every copy of the persona carries the same three additions. Static assertion, since drift here is invisible at runtime.
3. **Read-only assertion:** the persona contains no instruction to write the pacing field. Assert the absence explicitly — this is the boundary that keeps the orchestrator advisory.
4. **Manual read-through** of the four edited sites in sequence, checking that an orchestrator following them on a *head*-paced team produces exactly today's behaviour. The regression risk here is entirely in over-editing.
5. **One live handoff into a seat-paced queue:** the orchestrator scopes, stages three mixed-complexity plans, dispatches card one, and reports the seat it actually landed on and the fact that the seats pace from there. Assert the report names the destination returned by the call, not a lead.
6. **One live handoff into a head-paced queue** to confirm the report is unchanged from today.

No `npm run compile` dependency — this subtask touches no TypeScript. Persona gates and the mirror gate are the whole verification surface. Run it as the **only** agent stream in the persona file.
