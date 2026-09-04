# Multi-Agent Planning 02 — Divergence Map Before Synthesis

<!-- board-collapse-09 -->
> **RE-HOMED 2026-09-04 (Board Collapse 09).** Moved into *The multi-agent planning team plans as a team*. Its former parent, *Multi-Agent Planning Runs*, is dissolved, and that feature's first subtask — *Multi-Agent Planning 01, Fan-In Dispatch* — is **deleted**: the fan-out head prompt in the surviving feature dispatches N planners at one problem through the shipped teams mechanism, which is what 01 was building in parallel. 01's investigators were also coder-role seats, which the role-scoped completion standing order would wrongly reach.
> 
> **Read the run directory as this plan's own responsibility now.** 01 created `.switchboard/planning-runs/<run-id>/` and its manifest; with 01 gone, whichever of 02 or 03 lands first creates them. State that explicitly before coding.


## Goal

Have the lead consume a planning run's N independent drafts and emit a **divergence map** — a typed table of who claimed what and who contradicted it — *before* producing any merged plan, then synthesize the final plan(s) from that map with every claim carrying a `file:line` citation.

Consumes the run directory produced by `multi-agent-planning-01-fan-in-dispatch.md`. Resolving the disagreements the map surfaces is `multi-agent-planning-03-adjudication-round.md`; without 03, unresolved items ship as explicit open questions, which is already a better artifact than a single-agent plan that never knew the questions existed.

**The lead is the planning team's head.** Plan 01 provisions the run as a team, so this plan runs *in the head terminal* — it is not a separate actor to be introduced. That has three consequences worth stating before the design: the head is woken by the members' `reports-to-head` callbacks rather than polling; the head never investigated, which is the assembler/investigator asymmetry this plan requires anyway (see Complex/Risky); and the head's own conversation context persists across those wake-ups by construction, so the map can be built incrementally as drafts land rather than in one pass at the end.

### Problem analysis and root cause

**N independent drafts are worthless without a synthesis discipline, and the obvious synthesis is the wrong one.** The natural thing for a lead handed four plans is to read them, pick the best-written one, and lightly graft in anything else that looks good. That throws away the entire epistemic value of independent sampling. The whole reason to pay N× on planning is that *where independent agents disagree, you have located real uncertainty in the problem* — and a lead that merges by taste never surfaces the disagreement at all, so the uncertainty silently resolves in favour of whichever agent wrote most fluently.

**Why the map must be produced before the plan — two independent reasons:**

1. **It forecloses rubber-stamping.** Once a lead has started drafting a merged plan it is committed to a structure, and contradicting evidence gets filed as a caveat rather than reopening the shape. Emitting the disagreement table first makes the uncertainty explicit while it can still change the outcome.
2. **Context budget.** Four deep plans against this repo's section schema is a large amount of context — the sample plans in `.switchboard/plans/` run to thousands of words each. A lead attempting to hold four of them *and* draft a fifth will degrade. The map is a compression step: it reduces four plans to a claim table, and the synthesis then works from the table plus targeted re-reads rather than from four full documents.

**The singleton problem is the crux of the rubric.** A claim only one investigator made is simultaneously the highest-value and highest-risk category — it is either the insight the others missed, or the one hallucination. The failure mode to design against is resolving it by vote. Majority voting on a claim asserted by one of four agents *always* discards it, and on this codebase the lone dissenter is frequently the one who is right: the repo's own `CLAUDE.md` documents that the plan importer is resolve-only, that `window.confirm()` is a silent no-op in webviews, and that `dist/` is not used in development — all cases where the majority reading of the code is wrong. Any rubric that treats agreement as truth will systematically delete the correct minority finding. Singletons must be settled by reading the cited code, never by counting agents.

**Agreement is only evidence to the extent the inputs were independent — and they are not fully independent.** Plan 01 carries the run-invariant half of the brief as the planning team's `prompt`, delivered to every member as one `team`-scoped standing order on every message (`wireSpawnedTeam`, `teamWiring.ts:626-628`; `selectOrders`, `standingOrders.ts:104-111`). Every investigator therefore reads *identical* framing text, and any terminology, emphasis or worked example in it is a **shared input**: convergence downstream of it is not independent corroboration, it is the same prompt echoing four times. The map must be able to tell those apart, which is why plan 01's manifest records the in-force team prompt. Treat unanimity on a point the team prompt raised as weaker evidence than unanimity on a point no shared input mentioned.

**Root cause of why this cannot be done today.** Nothing in the tree compares plan files against each other. `improve-feature` (`.agents/skills/improve-feature/SKILL.md`) is the closest precedent — re-verified 2026-08-16: it reconciles a feature's subtasks, is explicitly "**This skill is authorised to cut.**" (`:9` — merge overlapping, delete superseded, rewrite contradictory, split oversized), and its preservation rule states the unit of preservation is "the union of intent across the set, never each individual `.md`" (`:15`). But it reconciles plans that describe *different work*, not N descriptions of *the same* work, so its rubric is about coherence and coverage rather than about adjudicating contradictory factual claims — and its guardrails assume every input is worth preserving somewhere, which is precisely wrong for a refuted claim. The comparison primitive is genuinely absent.

**Blast radius.** This plan is the first of the three that writes into `.switchboard/plans/`, so it is the first that puts cards on the board. Everything upstream stays in the run directory.

## Metadata

**Tags:** feature, backend, docs
**Complexity:** 6

## User Review Required

**One decision:** what the lead does with an unresolved disagreement when plan 03 is not yet available — ship the plan with both readings recorded as an open question (recommended, and the assumption below), or refuse to emit a plan until the disagreement is resolved by hand. The first keeps the pipeline moving and is honest about what is unknown; the second is safer but will stall runs.

## Complexity Audit

### Routine

- Reading N files from the run directory and its manifest.
- Emitting a markdown table.
- Writing the final plan(s) into `.switchboard/plans/` using the existing authoring protocol.

### Complex / Risky

- **Claim extraction is the hard problem.** Two investigators can assert the same thing in different words, or subtly different things in near-identical words. Over-merging hides disagreement; under-merging produces a map so noisy nobody reads it. This is where the design risk of all three plans is concentrated, and it should be prototyped against real drafts before the format is fixed.
- **The singleton rule must be encoded, not implied.** See Problem analysis. The rubric text must state that singletons are resolved by citation-checking and are never dropped for lack of corroboration. Getting this wrong inverts the value of the whole exercise.
- **Shared inputs inflate apparent agreement.** The team prompt reaches all N seats verbatim. A claim that merely restates something the shared brief already framed is not four-agent corroboration, and scoring it as such manufactures exactly the false confidence the run exists to avoid. The map needs a way to mark a cluster as *downstream of a shared input* — which requires reading the manifest's recorded team prompt, not just the drafts.
- **Spine selection must not reward fluency.** The spine should be the draft with the fewest *refuted* claims, not the longest or the best-written. An agent that wrote confidently and wrongly will read better than one that hedged accurately.
- **Plan sizing will fire more often than usual.** N investigators surface more scope than one, so the repo's authoring rule — split at 3+ distinct deliverables or 2+ independently-shippable phases — will trigger on a large share of runs. The synthesis step must be willing to emit *multiple* plans plus a feature grouping rather than one mega-plan, and must not treat "one run → one plan" as an invariant.
- **The lead must not have investigated.** If the lead formed its own hypothesis during the run it will favour it at synthesis time and the adjudication is no longer neutral. Assembler and investigator must be distinct roles — the same asymmetry the reference architecture uses, and the one the teams head/member split already enforces on the *standing-orders* path: `selectOrders` excludes the head from the team-scoped order by name (`standingOrders.ts:104-111`, matching `o.parent`), so the head cannot receive the team brief even though it appears in the group's members array. That exclusion does **not** cover the dispatch path: nothing stops an operator sending the fan-in prompt to the head as well as its members. The fan-in dispatch must exclude the head from the seat list explicitly, not by convention.
- **Citations must be checked, not trusted.** An investigator can cite `file:line` for a claim the code does not support. If synthesis accepts citations at face value it launders a hallucination into the final plan with a footnote that makes it look verified. At minimum, spot-check citations for claims that survive into the plan. On this codebase the failure is routine rather than exotic: `KanbanProvider.ts` and `TaskViewerProvider.ts` shift by hundreds of lines between commits, so a citation can be honestly authored and already wrong — check the **symbol**, not the line.

## Edge-Case & Dependency Audit

**Race Conditions** — none new; the run directory is complete before synthesis begins (plan 01 owns the completion condition). Synthesis must not start on a partial run except when plan 01 reports a quorum completion, in which case the map must record which investigators were absent so a two-of-two "unanimous" is not mistaken for four-of-four. One teams-specific hazard: the head is woken by each member's callback, and a callback can arrive before that member's draft is renamed into place. Synthesis keys off the manifest's completion condition, never off "a callback arrived".

**Security** — none new. Reads workspace files, writes plan files.

**Side Effects** — writes into `.switchboard/plans/`, which is watched and auto-imported (`_listSupportedLocalPlanPaths`, `TaskViewerProvider.ts:15734`; watchers at `:13867` and `:13940`), so each emitted plan becomes a board card. Intended. Per the repo's pinning protocol, an emitted plan carries `**Project:**` only if the run's originating request named one or a PROJECT PIN directive supplied one; otherwise the line is omitted and the plan lands unassigned.

**Dependencies & Conflicts** — depends on plan 01's run directory and manifest, and specifically on the manifest recording the in-force team prompt (without it, the shared-input discount above cannot be applied). Overlaps conceptually with `improve-feature`'s reconciliation rubric; worth reading that skill before authoring this one, but do not extend it — the inputs differ (N views of one problem vs N different subtasks) and merging the two rubrics will make both worse.

**Project-PRD interaction (Browser Switchboard).** This plan adds no verb and no host wiring — it reads files and writes plan files, so the PRD's return-contract ratchet, `verbSchemas.ts` boundary validation and two-layer completion model do not bind. If the map generator is ever surfaced as a panel action, contracts #4/#5/#7 apply in full and it must be wired in both hosts.

## Dependencies

`multi-agent-planning-01-fan-in-dispatch.md` — provides the run directory, drafts and manifest (including the recorded team prompt).

Transitively, the **teams feature**: this plan's actor is the planning team's head, and its wake-ups are the members' `reports-to-head` callbacks, which reach them via the team-scoped standing order. It adds no terminal, no role and no messaging mechanism of its own.

## Adversarial Synthesis

**Risk Summary.** The concentrated risk is the claim-extraction format itself: over-merging paraphrases hides the disagreements the run was paid for, under-merging buries them in noise, and the format is expensive to change once the adjudication round in plan 03 consumes it. Two rubric failures compound it — dropping singletons for lack of corroboration (which systematically deletes the correct minority finding on a codebase whose documented traps all defeat the majority reading), and counting agreement that merely echoes the shared team prompt as independent corroboration. Mitigations: prototype the format against real drafts before fixing it, encode the singleton rule as "resolve by citation, never by vote", mark clusters that sit downstream of a shared input using the manifest's recorded team prompt, choose the spine by fewest refutations rather than by prose quality, and spot-check surviving citations by symbol rather than by line.

## Implementation

1. Read the run manifest and all present drafts; record which roster entries are missing so quorum runs cannot masquerade as full ones. Read the *files*, not the callback messages — a member's report to the head is a summary written by the party under review, and treating it as the draft would reintroduce exactly the fluency bias the spine rule exists to prevent.
2. Read the manifest's recorded team prompt and hold it as the run's **shared input set**, so clusters that merely restate it can be discounted rather than scored as agreement.
3. Extract claims per draft — each a proposition about the codebase with its cited `file:line`, distinguished from proposed *actions*, which are not adjudicable facts.
4. Cluster claims across drafts and bucket each cluster: **unanimous** (all contributing investigators assert it), **split** (asserted and contradicted), **singleton** (one investigator only, uncontradicted), **contradicted** (asserted by some, explicitly refuted by others). Flag any cluster traceable to the shared input set.
5. Emit `divergence-map.md` into the run directory: one row per claim cluster with bucket, asserting agents, contradicting agents, citations and the shared-input flag. This artifact is the deliverable of this step — no merged plan yet.
6. Encode the resolution rubric: unanimous claims are kept without re-litigation *unless* flagged as shared-input, in which case they are citation-checked like any other; split and contradicted claims are resolved by reading the cited code; **singletons are resolved by citation-checking and are never dropped for lack of corroboration.**
7. Spot-check citations for every claim that survives into the final plan, resolving by symbol name rather than by line number, so an unsupported or merely stale `file:line` cannot launder a hallucination.
8. Select the spine — the draft with the fewest refuted claims — and graft verified findings from the others onto it rather than merging structurally.
9. Apply the repo's plan-sizing rule to the synthesized scope: emit multiple plans where 3+ deliverables or 2+ shippable phases are present, and offer a feature grouping rather than creating one unasked.
10. Record every unresolved disagreement in the emitted plan as an explicit open question carrying both readings and their citations, placed in or below `## Goal` per the authoring protocol. A stated open question is more valuable than a manufactured consensus.

## Proposed Changes

### Divergence map generator (new)
- **Context:** Nothing compares plan files against each other; `improve-feature` reconciles different subtasks, not competing views of one problem.
- **Logic:** Extract, cluster and bucket claims across N drafts; flag clusters downstream of the shared team prompt; emit the map before any synthesis.
- **Edge Cases:** Over-merging paraphrases hides disagreement; under-merging produces unreadable noise; quorum runs must not read as unanimous; shared-input echo scored as corroboration.

### Synthesis rubric (new)
- **Context:** No rule exists for resolving contradictory claims between drafts.
- **Logic:** Unanimous kept (shared-input-flagged ones still checked); split and contradicted resolved against code; singletons citation-checked and never vote-dropped; spine chosen by fewest refutations.
- **Edge Cases:** Fluency mistaken for correctness; citations trusted without checking; a stale-but-honest line number read as a fabrication (or vice versa); plan-sizing rule ignored in favour of one output plan.

### Plan emission
- **Context:** `.switchboard/plans/` is auto-imported, so emission creates board cards.
- **Logic:** Write the synthesized plan(s), with open questions recorded in or below `## Goal`.
- **Edge Cases:** Project pin — omit unless the request or a PROJECT PIN directive named one; never substitute the workspace name.

## Verification Plan

1. Given a run directory with four drafts, `divergence-map.md` is emitted **before** any file appears in `.switchboard/plans/`.
2. Every claim cluster in the map carries a bucket, its asserting agents and at least one citation.
3. A claim asserted by exactly one investigator survives to the final plan when its citation checks out — the singleton rule, and the single most important behavioural test in this plan.
4. A claim asserted by three investigators is **dropped** when the cited code refutes it, confirming the rubric resolves against code rather than by vote.
5. A citation that does not support its claim is caught by the spot-check and the claim does not reach the final plan.
6. A claim whose cited line has merely drifted but whose cited *symbol* still supports it is **kept**, with the citation corrected — distinguishing staleness from fabrication.
7. A claim every investigator asserts that merely restates a phrase from the run's team prompt is flagged as shared-input and citation-checked rather than passed through as unanimous.
8. A run whose synthesized scope contains 3+ distinct deliverables emits multiple plans, not one mega-plan, and offers a feature grouping rather than creating one unprompted.
9. An unresolved disagreement appears in the emitted plan as an open question with both readings, not silently resolved in either direction.
10. A quorum run (two of four investigators) produces a map that records the two absences, and its "unanimous" bucket is not presented as four-agent agreement.
11. Emitted plans carry no `**Project:**` line unless the run's request or a PROJECT PIN directive supplied one.
12. The head's map is built from the draft files, not from the members' callback summaries — verified by making one member's callback contradict its own draft and confirming the draft wins.
13. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline (re-verified 2026-08-16: exactly 5 `TS2835` errors at HEAD, unrelated).

### Automated Tests

- Unit: claim clustering over a fixture set of four drafts produces the expected four buckets, including a deliberately-paraphrased pair that must merge and a near-identical pair that must not.
- Unit: the shared-input flag fires for a claim echoing the manifest's team prompt and does not fire for one that does not.
- Unit: the quorum path records absent roster entries and refuses to label a two-of-four cluster "unanimous".
- Unit: spine selection picks the draft with fewest refuted claims over a longer, unrefuted-but-uncited one.
- Integration (temp dir): synthesis emits the map file before any file under `.switchboard/plans/`, and emits N plan files for a scope with N deliverables.

## Recommendation

Complexity 6 → **Send to Planner for one more pass before coding.** The claim-extraction format is the highest-risk piece in the three-plan set and should be prototyped against real drafts from a plan-01 run before it is fixed — the rubric is cheap to change on paper and expensive to change once the map format has consumers (plan 03's adjudication prompt is a direct function of the claim schema).

> **Improved 2026-08-16.** The synthesis discipline stands as authored; one substantive addition follows from plan 01's team-prompt split — every investigator now reads an identical run-invariant brief carried as a `team`-scoped standing order, so agreement downstream of it is **shared-input echo, not independent corroboration**. The map, the rubric and the tests now discount it, and this plan depends on plan 01's manifest recording the team prompt in force. Also: the head/investigator asymmetry is now shown to be structurally enforced *on the standing-orders path only* (`selectOrders` excludes the head by name) — the dispatch path is still unguarded, so the explicit seat-list exclusion stands. Citation-checking now resolves by symbol rather than line, because these two provider files drift by hundreds of lines between commits.
>
> **Revised 2026-08-15 to sit on the teams feature.** No design change — this plan's synthesis discipline stands as authored. What changed is that its actor is now identified: the lead is the planning team's **head**, woken by member callbacks, structurally excluded from investigating.
>
> **Citation freshness (2026-08-16).** All `file:line` references re-verified against the working tree and updated — they had drifted since the 2026-08-15 pass (`_listSupportedLocalPlanPaths` 15862→15734; watchers 13995→13867 and 14068→13940). The `improve-feature` quotes were re-checked against the skill file and are exact.
