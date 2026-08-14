# Multi-Agent Planning 03 — Adjudication Round: Resolving Divergence Against the Code

## Metadata

**Complexity:** 5
**Tags:** planning, verification, multi-agent, dispatch

## Goal

Resolve the split, contradicted and singleton claims surfaced by the divergence map by dispatching bounded, self-contained verification tasks back to the fleet, folding the verdicts into the map, and re-running synthesis with fewer open questions.

Depends on `multi-agent-planning-02-divergence-map.md` for the map. Without this plan, unresolved claims ship as open questions — a working outcome, just a weaker one. This plan converts open questions into settled facts where the code can settle them.

### Problem analysis and root cause

**This is the one phase where cross-agent information sharing is safe, and understanding why is the whole design.** The reason to suppress communication during generation (plan 01) is that agents who read each other's findings anchor collectively, producing correlated error — four agents in confident agreement about a fiction. That risk is entirely a *generation*-phase risk. By the time the divergence map exists, the independent hypotheses have already been formed and recorded; sharing information now cannot corrupt hypothesis generation, because generation is over. So the rule that falls out is: **no communication during generation, communication during resolution.**

The corollary is that no message bus is required. Adjudication traffic is 1→1, lead→worker, short, and factually bounded: *"Investigator B asserts the importer auto-creates a projects row at `src/x.ts:42`; Investigator C asserts it is resolve-only. Read it and report which, with a citation."* That is exactly the shape the existing point-to-point dispatch already handles well (`src/webview/terminals.js:6073+` relaying via `/terminals/verb/ptySendPrompt`). The elaborate shared-channel machinery that a general agent-coordination bus would need buys nothing here — the traffic pattern that actually matters is a star, not a mesh.

**Root cause of why the naive implementation fails.** Three concrete failure modes, none of which are hypothetical:

1. **The claimant will defend its claim.** Sending "you said X, is X true?" back to the agent that asserted X invites motivated reasoning; the agent's context contains the reasoning that produced X and it will restate it. Adjudication has to go to an agent with no stake in either side.
2. **The investigators may not exist any more.** By phase 3 the phase-1 agents have finished their turns; they may have exited, been `/clear`ed, or been reused. Any adjudication prompt written as "reconsider what you concluded earlier" is unanswerable in that state. Prompts must be **self-contained** — claim, counter-claim, citations and file paths inline — so a fresh agent with no history can answer them. This constraint and failure mode (1) resolve each other: self-contained prompts are answerable by a neutral agent, which is who should be answering.
3. **Adjudication can live-lock.** A verdict is itself a claim, and a claim can be disputed. Without a stop condition, verdict-on-verdict traffic keeps agents' turns alive indefinitely — the ping-pong failure that any inter-agent messaging design hits at three or more participants. Needs a read watermark (only claims newer than last adjudicated), a bounded round count, and an explicit rule that a verdict is not itself adjudicable.

**Why the existing dispatch is the right substrate anyway.** Investigators at phase 3 are idle — they have ended their turns — so stdin delivery is correct and carries no interrupt risk. This is the dispatch case, not the mid-flight coordination case. The write path (`src/standalone/ptyPromptDelivery.ts:21`) is a blind chunked paste with no idle gate, which is a real hazard when messaging a *working* agent but harmless against an idle one.

**Blast radius.** Additive on top of plan 02. Adds dispatch traffic and one more artifact in the run directory. If the adjudication budget is exhausted the behaviour degrades exactly to plan 02's — open questions in the emitted plan.

## User Review Required

**One decision:** the adjudication budget — how many claims per run are worth verifying, and how many rounds. Every adjudication is a dispatch and a turn, so an unbounded map on a contentious problem could cost more than the original run. Recommend capping by claim count (verify the N highest-impact disputed claims) rather than by round count, since impact is what the user cares about.

## Complexity Audit

### Routine

- Selecting rows from the divergence map by bucket.
- Dispatching a prompt to an idle terminal via the existing PTY delivery path.
- Appending verdicts to a map artifact.

### Complex / Risky

- **Adjudicator selection must exclude both parties.** Route each disputed claim to an investigator that asserted neither side, or to a fresh agent. Never to the claimant.
- **Prompts must be self-contained.** Phase-1 context is gone by now. Inline the claim, the counter-claim, both citations and the file paths; assume the recipient has no memory of the run.
- **Live-lock prevention is not optional.** Watermark on adjudicated claims, a hard round cap, and a rule that a verdict is terminal — not itself a claim to adjudicate. Without all three this deadlocks under load, and it will deadlock unattended at the worst possible time.
- **A verdict must be falsifiable, not a vote.** The adjudicator's answer is only worth anything if it carries a citation that a human or a later pass can check. "C is right" without a `file:line` is another opinion; the point of this phase is to replace opinion with code.
- **Unresolvable is a legitimate verdict.** Some disagreements are genuinely underdetermined by the code — e.g. two readings of intended behaviour where the code supports both. The adjudicator must be able to return "underdetermined" and have that flow through to an open question, rather than being pressured into picking a side. Forcing a verdict on an underdetermined claim manufactures exactly the false confidence the whole design is built to avoid.
- **Impact ranking, not map order.** Adjudicating in map order spends the budget on whatever happened to sort first. Rank by how much the claim changes the plan if it flips — a disputed root cause outranks a disputed file path.

## Edge-Case & Dependency Audit

**Race Conditions** — concurrent adjudications writing verdicts to one artifact need distinct keys per claim, or atomic append. Two adjudicators assigned the same claim (through a selection bug) must not produce two verdicts that silently overwrite one another; key verdicts by claim id and detect duplicates.

**Security** — none new. Existing authenticated dispatch surface.

**Side Effects** — additional dispatch traffic and token spend. A verdict artifact in the run directory. Re-running synthesis after adjudication may change the emitted plan set — if plan 02 already wrote plans to `.switchboard/plans/`, re-synthesis must update those files rather than emit a second set, or the board gains duplicate cards. Prefer adjudicating *before* first emission; if that ordering cannot be guaranteed, the re-synthesis path must be an update, not an insert.

**Dependencies & Conflicts** — requires the divergence map from plan 02. Shares the dispatch path with plan 01's fan-in but at a different phase, and unlike plan 01 it explicitly *enables* cross-agent information flow, so the run-scoped comms suppression from plan 01 must be lifted for this phase and re-established if any further generation happens.

## Dependencies

`multi-agent-planning-02-divergence-map.md` — provides the claim buckets and citations this plan resolves.

## Implementation

1. Select adjudication candidates from the map: split, contradicted and singleton buckets. Rank by impact — how much the plan changes if the claim flips — and take the top N within the configured budget.
2. For each candidate, choose an adjudicator with no stake: an investigator that asserted neither side, or a fresh agent. Never the claimant.
3. Compose a self-contained adjudication prompt — claim, counter-claim, both citations, file paths, and the required answer shape (verdict + citation, or `underdetermined`). Assume the recipient has no memory of the run.
4. Dispatch via the existing PTY delivery path. Recipients are idle at this point, so stdin delivery is correct and needs no idle gate.
5. Lift plan 01's run-scoped comms suppression for the duration of this phase, and re-establish it if any further generation is triggered.
6. Collect verdicts into a `verdicts.md` artifact keyed by claim id; reject and flag duplicate verdicts for the same claim rather than overwriting.
7. Enforce the stop conditions: watermark so an adjudicated claim is never re-dispatched, a hard round cap, and a rule that a verdict is terminal and not itself adjudicable.
8. Fold verdicts into the map, then re-run plan 02's synthesis. Claims refuted by verdict are dropped; claims confirmed are promoted with their verdict citation; `underdetermined` claims flow through as open questions.
9. Ensure re-synthesis updates any plan files plan 02 already emitted rather than emitting a duplicate set.

## Proposed Changes

### Adjudication candidate selection (new)
- **Context:** The divergence map has no notion of which disagreements are worth paying to resolve.
- **Logic:** Filter to disputed buckets, rank by plan impact, cap by budget.
- **Edge Cases:** Spending the whole budget on trivia because the map sorted that way; an empty candidate set (fully unanimous run) must skip the phase cleanly.

### Self-contained adjudication prompt (new)
- **Context:** Phase-1 investigators may be exited or cleared; nothing today composes a stake-free verification request.
- **Logic:** Inline claim, counter-claim, citations and required answer shape; route to a non-party adjudicator.
- **Edge Cases:** Claimant self-adjudication; a prompt that assumes prior context; an adjudicator pressured into a verdict where the code is genuinely silent.

### Verdict collection + stop conditions (new)
- **Context:** No watermark or round cap exists, so verdict-on-verdict traffic can live-lock.
- **Logic:** Keyed verdict artifact, watermark on adjudicated claims, hard round cap, verdicts terminal.
- **Edge Cases:** Duplicate verdicts overwriting each other; a claim re-entering the queue after adjudication.

### Re-synthesis hand-back
- **Context:** Plan 02 may already have emitted plans into the watched `.switchboard/plans/`.
- **Logic:** Fold verdicts into the map and re-synthesize as an update to existing plan files.
- **Edge Cases:** Duplicate board cards from a second emission; comms suppression left lifted after the phase ends.

## Verification Plan

1. A split claim dispatched for adjudication returns a verdict carrying a `file:line` citation, and the losing side is dropped from the final plan.
2. A singleton claim confirmed by adjudication survives into the final plan; one refuted is dropped — verifying the phase resolves against code rather than by agent count.
3. No adjudication is ever routed to the agent that asserted the claim under test.
4. An adjudication prompt is answerable by an agent with no run history — verified by dispatching one to a freshly spawned terminal with no prior context.
5. A claim whose code genuinely supports both readings returns `underdetermined` and appears in the emitted plan as an open question, rather than being forced to a verdict.
6. Verdict-on-verdict traffic does not occur: a verdict is not re-dispatched for adjudication, and an adjudicated claim is not re-selected in a later round.
7. The round cap terminates a contentious run, and the residue degrades to plan 02's open-question behaviour rather than hanging.
8. Re-synthesis after adjudication **updates** the plan files plan 02 emitted; the board card count is unchanged, with no duplicates.
9. A fully unanimous run skips this phase without error and without dispatching anything.
10. Plan 01's comms suppression is re-established after the phase, verified by confirming a subsequent generation phase still has the inbox check disabled.
11. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline.

## Recommendation

Complexity 5 → **Send to Coder**, after plan 02's map format is settled — the adjudication prompt is a function of the map's claim schema, so building it first would mean rewriting it. The live-lock stop conditions are the part to get right; everything else degrades gracefully, but a deadlocked adjudication loop in an unattended run does not.
