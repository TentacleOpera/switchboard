# The Orchestrator Presents the Seat-Routed Queue as a Third Option

## Goal

Teach the orchestrator persona that a seat-routed queue exists, when it is the better choice, and how to hand off into it — so an operator who opens the orchestrator is offered the simplest mechanism that fits their work instead of the only two the persona currently knows.

### Problem analysis — root cause

The orchestrator's decision point is `## Handoff, or arm?` (`.agents/skills/switchboard-orchestrator/SKILL.md:256`) and it enumerates exactly two options:

- **Handoff (default for one team)** — stage the queue, dispatch card one, exit; *"the pipeline is lead-paced and queue-watched"* (`:260`).
- **Self-wake (agent-managed persistence)** — the orchestrator stays alive and ticks (`:262`).

> **Correction (factual error in original analysis):** The persona at `## Handoff, or arm?` (line 258) actually says *"Three session models:"* and enumerates **three** bullets, not two. The bullet omitted from the analysis above is:
> - **Arm (multi-team exception)** (`:261`) — *"Multiple teams across worktrees or separate repos requiring persistent coordination. State the reason in one line, then confirm to arm."*
>
> The "Arm" and "Self-wake" bullets are complementary, not alternatives: "Arm" is the *decision* to stay alive for multi-team coordination; "Self-wake" is the *mechanism* (the timer loop). The plan's desired three-option state (seat-routed, lead-paced, self-wake) does not account for the existing "Arm" bullet. The implementation below adds the seat-routed option as a **fourth** bullet and preserves "Arm" unchanged. See `## Outstanding Questions` for the open decision on whether to merge "Arm" and "Self-wake" into a single bullet to return to three options.

Both assume a lead paces the pipeline. The assumption is then hardcoded downstream rather than derived: `## The handoff sequence` step 4 says *"dispatch the first card to the lead"* (`:276`), `## Hard Rules` describes `queue/next` as *"hands the next staged card to the lead"* (`:40`), the session-state vocabulary at `:265` defines `handed off` as *"nothing running but the queue and its watch"*, and the tick's fallback at `:363` routes a ready feature *"to the coding team lead"*.

So after subtasks 1–4 land, the persona is not merely silent about seat pacing — it is **wrong** in four places about what `queue/next` does, because the answer now depends on the team's pacing field. An orchestrator reading it will describe head behaviour to an operator running a seat-paced team, and will hand off with a report that names a pacing lead that is not pacing anything.

> **Correction (fifth site missed):** The original analysis identifies four hardcoded "to the lead" sites. A fifth exists: the handoff report shape at `:296` says *"the pacing lead's terminal name"*, and the handoff example JSON at `:290` names *"Coding lead"* in its summary. In seat pacing there is no pacing lead — the report must name the seat the card actually landed on. The implementation below adds this fifth site to the fix list.

> **Correction (Hard Rule 6 contradiction):** The original analysis does not flag Hard Rule 6 at `:37`: *"Dispatch to the lead, never to individual coders."* An unattended agent obeys Hard Rules over prose. In seat pacing, `queue/next` routes to a complexity-routed seat (an individual coder), not the lead. If Hard Rule 6's headline stays unchanged, an agent reading it will refuse to hand off into a seat-paced queue no matter what the handoff section says. The implementation below updates Hard Rule 6 to derive its constraint from pacing rather than asserting head behaviour unconditionally.

This is why the change is a plan and not a docs footnote: the persona is gated by `src/test/orchestrator-tick-and-reports-contract.test.js`, and the preceding feature's notes record that persona edits **serialise** — subtasks 5, 6, 7 and 4 of `lead-paced-pipeline` all wrote this same file and collided. This subtask must be the only agent stream in the file while it runs.

### What the orchestrator should actually say

The persona's value is judgement, and the judgement here is a genuine trade, not a preference:

- **Seat-routed queue** — a flat list of standalone plans of mixed complexity, no cross-plan coordination, and the operator wants to walk away. No head reasoning about the work, no review hop, one card at a time. Cheapest and fewest moving parts.
- **Lead-paced (head) queue** — the plans need a head that reads them, delegates subtasks, and hands the finished work to a reviewer. Keeps the quality gate.
- **Self-wake** — multiple teams, worktrees or repos to coordinate, or merge-back to run.

The persona already states that a resident orchestrator over a one-at-a-time pipeline is *"a manager watching a manager"*. A seat-routed queue is the end of that argument, and the persona should present it as such rather than as an exotic mode.

## Metadata

**Complexity:** 3
**Tags:** docs, feature
**Feature:** 69d427d8-cf87-4977-825b-d3553b869745

## User Review Required

Yes — the plan's original analysis miscounted the persona's options (said two, actually three). The implementation adds the seat-routed option as a fourth bullet and preserves the existing "Arm" bullet unchanged. An open question (see `## Outstanding Questions`) is whether to merge "Arm" and "Self-wake" into a single bullet to return to three options, matching the plan's original desired state. This is a structural design decision that affects how an operator reads the decision point.

## Complexity Audit

### Routine
- Single-file edit (`.agents/skills/switchboard-orchestrator/SKILL.md` — markdown persona, no TypeScript).
- No new endpoints, no new state, no database changes.
- The seat-routed queue mechanism itself is implemented by sibling subtasks 1–3; this subtask only teaches the persona it exists.
- Mirror check is a no-op (no `.claude/` copy exists — confirmed by `find_file_by_name`).

### Complex / Risky
- **Five sites to fix, not four.** The original plan identified four hardcoded "to the lead" claims; a fifth (the handoff report shape at `:296` and the example JSON at `:290`) was missed. An incomplete fix leaves the persona internally contradictory.
- **Hard Rule 6 must be updated, not just the `queue/next` line.** The Hard Rule headline at `:37` says "Dispatch to the lead, never to individual coders." In seat pacing this is wrong. An unattended agent obeys Hard Rules over prose, so an unchanged Hard Rule 6 would override the seat-paced option.
- **Test gate sensitivity.** The persona is gated by `src/test/orchestrator-tick-and-reports-contract.test.js`, which asserts on string presence: `lead-paced and queue-watched` (line 226), `## Handoff, or arm?` (line 609), `never call \`POST /kanban/dispatch\`` (line 168), and `kanban/queue/next` + `ptySendPrompt` (line 172). All four strings must survive the edit.
- **Regression risk is entirely in over-editing.** The head-paced path must produce byte-for-byte today's behaviour. Five sites in the persona describe head behaviour; each must gain a pacing-conditional, not be rewritten.

## Edge-Case & Dependency Audit

- **Race Conditions:** Persona edits serialise — four subtasks of `lead-paced-pipeline` collided in this exact file. This subtask must be the only agent stream writing the file while it runs. No runtime race (the persona is a static document).
- **Security:** No security surface. The plan does not introduce any new API call, credential, or data path.
- **Side Effects:** The orchestrator reads the pacing field — it never writes it. Setting pacing is the operator's call on the team. An orchestrator that flips other people's team configuration is exactly the unattended side effect this persona is scoped away from. The plan must state this boundary explicitly and the verification must assert its absence.
- **Dependencies & Conflicts:**
  - Depends on subtasks 1–3 landing first: subtask 1 gives `queue/next` its seat-routed branch, subtask 2 installs the seat orders, subtask 3 adds the `pacing` field and the toggle. Without them, the seat-routed option described in the persona would reference behaviour that does not exist yet.
  - The `POST /orchestration/handoff` endpoint's `409` preconditions (a live coding head and a non-empty `DISPATCH` queue) both still hold in seat pacing. The endpoint is unchanged; only its refusal text may need adjusting if it names "the lead" specifically.
  - The test gate at `src/test/orchestrator-tick-and-reports-contract.test.js` must remain green. Four string-presence assertions (listed in Complexity Audit) are load-bearing and must survive.

## Dependencies

- `seat-routed-queue-1-seats-take-cards-and-report-done.md` — gives `queue/next` its seat-routed dispatch branch (hard prerequisite).
- `seat-routed-queue-2-seat-orders-and-the-escalation-ladder.md` — installs the seat orders that drive self-advance (hard prerequisite).
- `seat-routed-queue-3-choosing-seat-pacing-and-the-idle-watch.md` — adds the `pacing` field, the team toggle, and the idle-watch correction (hard prerequisite).
- This subtask goes **last and alone** — persona edits serialise.

## Adversarial Synthesis

Key risks: (1) the original analysis miscounted the persona's options and missed a fifth "to the lead" site, so an implementer following it literally would produce an incomplete fix; (2) Hard Rule 6's headline contradicts seat pacing and must be updated, not just the `queue/next` line beneath it; (3) the `## The ready set` reference points to a section that does not exist (`## What Is Ready To Go` is the actual name). Mitigations: all five sites are enumerated with line numbers, Hard Rule 6 is added to the fix list, and the section reference is corrected.

## Proposed Changes

### `.agents/skills/switchboard-orchestrator/SKILL.md`

**Context:** The orchestrator persona is an executable specification read by an unattended agent. It is gated by `src/test/orchestrator-tick-and-reports-contract.test.js`, which asserts on string presence. The persona currently has three session models at `## Handoff, or arm?` (line 258): Handoff, Arm, Self-wake. All assume a lead paces the pipeline. After sibling subtasks 1–3 land, the `queue/next` endpoint routes by pacing, making the persona's hardcoded "to the lead" claims wrong in five places.

**Logic:** Add the seat-routed queue as a fourth option. Derive all five "to the lead" sites from pacing. Update Hard Rule 6 to condition its "never to individual coders" constraint on head pacing. Add a seat-paced variant of the handoff sequence (steps 1–3 and 5 shared, only step 4's destination differs). Describe what a finished seat-paced board looks like so an orchestrator does not misread resting cards as in-progress. Preserve every test-gated string.

**Implementation:**

1. **Add the seat-routed queue option to `## Handoff, or arm?`** (after line 260, the Handoff bullet) with the trade stated in one line each, in the register the two existing entries use. Name the precondition explicitly: the team's pacing field must be `seat`, and the orchestrator **reads** that field — it does not set it. Setting pacing is the operator's call on the team, and an orchestrator that flips other people's team configuration is exactly the unattended side effect this persona is scoped away from.

   The bullet should read as the cheapest option, not an exotic mode — the persona already argues that a resident orchestrator over a one-at-a-time pipeline is "a manager watching a manager," and a seat-routed queue is the end of that argument.

   The "Arm (multi-team exception)" bullet at `:261` stays unchanged. See `## Outstanding Questions` for the open decision on merging it with "Self-wake."

2. **Fix the five hardcoded "to the lead" claims** so each derives from pacing instead of asserting head behaviour:
   - `## Hard Rules:37` (the headline, not just `:40`) — Hard Rule 6 says *"Dispatch to the lead, never to individual coders."* In seat pacing, `queue/next` itself routes to the complexity-routed seat. The orchestrator still only calls `queue/next` and `ptySendPrompt` — it never calls `POST /kanban/dispatch`. Update the headline to condition on pacing: the orchestrator never calls `POST /kanban/dispatch` (this stays unconditional and test-gated); `queue/next`'s destination depends on the team's pacing field.
   - `## Hard Rules:40` — `queue/next` hands the card to the lead **in head pacing**, or to the complexity-routed seat **in seat pacing**.
   - `## The handoff sequence:276` — step 4 dispatches card one; where it lands depends on pacing, and the report must name the actual destination the call returned rather than assuming.
   - `:265` — `handed off` stays correct as written but should note that in seat pacing there is no lead holding the pacing instruction; the seats hold it.
   - `:296` (the handoff report shape) — *"the pacing lead's terminal name"* must become pacing-derived: in head pacing, the lead's terminal name; in seat pacing, the seat the call returned. The example JSON at `:290` should show both variants or use a generic placeholder that makes clear the destination is call-returned, not assumed.
   - `:363` — the tick's ready-feature fallback: keep the lead route for head-paced teams, and for a seat-paced team stage into the queue rather than messaging a lead that is not driving.

3. **Add a seat-paced variant of the handoff sequence**, not a second sequence. Steps 1–3 (scope, launch, stage) and step 5 (report and exit) are identical; only step 4's destination and the report's wording differ. Duplicating the whole sequence guarantees the two drift.

4. **State the queue-watch difference in one sentence.** In head pacing the watch nudges the lead. In seat pacing it nudges the seat holding the card, and escalates to the operator on the first pass when no seat holds one — so an orchestrator that has handed off into a seat-paced queue should tell the operator that a dead seat surfaces to *them*, not to an agent.

5. **State what a finished seat-paced run looks like on the board.** This is the addition most likely to be omitted and most likely to cause a wrong read later. A completed seat-paced run leaves every card **resting in the coding column of the seat that coded it**, with `dispatched_at` cleared — nothing in `CODE REVIEWED`, nothing in `COMPLETED`. Cards move on coding start and never on finish (`switchboard-contracts` #1), and this mode adds no completion move.

   Two consequences the persona must state, because an orchestrator reading the board without them will report the run as broken:
   - **A card in a coding column is not evidence of work in progress.** The persona already states this in `## Signals` (lines 435–437: *"A card in a coding column means work began, not that it ended"*). Extend that existing statement with the seat-paced nuance — do not duplicate it. The working-state latch is `dispatched_at` set on a card, and it is per-card. An orchestrator summarising board state must not describe resting cards as in-flight, and must not "help" by moving them.
   - **`## What Is Ready To Go` is unaffected but its complement is not.** (The original plan referred to this as `## The ready set`; the actual section heading is `## What Is Ready To Go` at line 62.) Cards resting in coding columns are neither ready nor running; they are done. Say so, so the orchestrator does not offer to re-dispatch them.

6. **Leave `POST /orchestration/handoff` unchanged.** Its `409` preconditions — a live coding head and a non-empty `DISPATCH` queue — both still hold in seat pacing: a seat-paced team still needs seats live, and `from` still resolves through a coding head for roster purposes. Changing the endpoint is out of scope; if its refusal text names "the lead" specifically, adjust the *text* only.

7. **Mirror check — no-op.** The plan says to mirror to `.claude/skills/switchboard-orchestrator/SKILL.md` if that path carries a copy. Confirmed by file search: no `.claude/skills/switchboard-orchestrator/SKILL.md` exists. The step is a no-op. Grep before declaring done as a safety check, but no mirror write is expected. No registry description enumerates the handoff/arm/self-wake modes (the AGENTS.md skill table describes `switchboard-orchestrator` functionally, not by mode), so no registry to update.

**Edge Cases:**
- **Head-paced regression:** The head-paced path must produce exactly today's behaviour. Every edit is a pacing-conditional added to an existing statement, not a rewrite. The verification plan includes a manual read-through of all five edited sites to confirm a head-paced team is unaffected.
- **Test gate strings:** Four strings are asserted by the test gate and must survive: `lead-paced and queue-watched` (test line 226), `## Handoff, or arm?` (test line 609), `never call \`POST /kanban/dispatch\`` (test line 168), and `kanban/queue/next` + `ptySendPrompt` (test line 172). The Hard Rule 6 update must preserve `never call \`POST /kanban/dispatch\`` unconditionally — only the "to the lead" framing is pacing-conditional.
- **Absent pacing field:** The pacing field defaults to `head` when absent (subtask 3, compatibility contract for ~4,000 installs). The persona's head-paced claims must remain the default reading, with seat-paced as the conditional branch.

## Verification Plan

1. **Gate assertions in `src/test/orchestrator-tick-and-reports-contract.test.js`:** the seat-routed option is present in `## Handoff, or arm?`; no remaining unconditional "to the lead" claim about `queue/next` anywhere in the persona (check all five sites: lines 37, 40, 276, 296, 363); the seat-paced handoff variant exists and shares steps 1–3 and 5 with the head variant.
2. **Mirror gate:** every copy of the persona carries the same additions. Confirmed: only one copy exists (`.agents/skills/switchboard-orchestrator/SKILL.md`). Static assertion that no `.claude/` mirror exists, since drift here is invisible at runtime. Grep as a safety check.
3. **Read-only assertion:** the persona contains no instruction to write the pacing field. Assert the absence explicitly — this is the boundary that keeps the orchestrator advisory.
4. **Gate assertion on the resting-state description:** the persona states that a finished seat-paced run leaves cards in coding columns with the latch (`dispatched_at`) cleared, and contains no instruction to move them. Assert the persona extends the existing `## Signals` statement (lines 435–437) rather than duplicating it.
5. **Hard Rule 6 gate:** the persona's Hard Rule 6 still unconditionally forbids `POST /kanban/dispatch`, and conditions the "to the lead" framing on pacing. Assert `never call \`POST /kanban/dispatch\`` survives and that the headline no longer says "never to individual coders" unconditionally.
6. **Test-gated string survival:** assert `lead-paced and queue-watched`, `## Handoff, or arm?`, `kanban/queue/next`, and `ptySendPrompt` all still appear in the persona after the edit.
7. **Manual read-through** of the five edited sites in sequence, checking that an orchestrator following them on a *head*-paced team produces exactly today's behaviour. The regression risk here is entirely in over-editing.
8. **One live handoff into a seat-paced queue:** the orchestrator scopes, stages three mixed-complexity plans, dispatches card one, and reports the seat it actually landed on and the fact that the seats pace from there. Assert the report names the destination returned by the call, not a lead.
9. **One live handoff into a head-paced queue** to confirm the report is unchanged from today.

No `npm run compile` dependency — this subtask touches no TypeScript. Persona gates and the mirror gate are the whole verification surface. Run it as the **only** agent stream in the persona file.

## Outstanding Questions
- **[user]** Should the "Arm (multi-team exception)" and "Self-wake" bullets be merged into a single bullet to return the decision point to three options (seat-routed, handoff, arm/self-wake), matching the plan's original desired state? Or should all four bullets stay separate? — proceeding on the assumption that all four stay separate (add seat-routed as a fourth, preserve Arm unchanged), because merging is a structural change beyond this subtask's scope and the feature description should be corrected separately.

---

## Completion Report

Added the seat-routed queue as a fourth option in `## Handoff, or arm?` with the trade stated (flat list, mixed complexity, no coordination, operator walks away — cheapest, not exotic) and the precondition that the team's `pacing` field must be `seat` (orchestrator reads, never sets). Fixed all five hardcoded "to the lead" claims: Hard Rule 6 headline now conditions on pacing (`never call \`POST /kanban/dispatch\`` preserved unconditional); `queue/next` line derives destination from pacing; handoff sequence step 4 names the call-returned destination; session-state `handed off` notes seats hold pacing in seat mode; handoff report shape and example JSON use a pacing-derived destination. Added seat-paced variant inline in step 4 (not a second sequence). Added queue-watch difference sentence (head nudges lead, seat nudges seat, escalates to operator first pass). Extended the existing `## Signals` "Column state" statement with the finished seat-paced run description (cards resting in coding columns with `dispatched_at` cleared, not in-flight, do not move). `POST /orchestration/handoff` left unchanged. Test gate green; no `.claude/` mirror exists. File changed: `.agents/skills/switchboard-orchestrator/SKILL.md`. No issues encountered.

## Review Findings

Reviewed the shared orchestrator persona and corrected its contradictory `Two session models` heading to the three models actually present after the runtime split. Extended `src/test/orchestrator-tick-and-reports-contract.test.js` to pin the seat-routed, handoff, and arm options. The orchestrator contract, compile-tests, and compile passed; no remaining unconditional lead-only instruction or pacing-write instruction was found.
