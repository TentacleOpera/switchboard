# Multi-Agent Planning 02 — Divergence Map Before Synthesis

## Metadata

**Complexity:** 6
**Tags:** planning, synthesis, multi-agent, verification

## Goal

Have the lead consume a planning run's N independent drafts and emit a **divergence map** — a typed table of who claimed what and who contradicted it — *before* producing any merged plan, then synthesize the final plan(s) from that map with every claim carrying a `file:line` citation.

Consumes the run directory produced by `multi-agent-planning-01-fan-in-dispatch.md`. Resolving the disagreements the map surfaces is `multi-agent-planning-03-adjudication-round.md`; without 03, unresolved items ship as explicit open questions, which is already a better artifact than a single-agent plan that never knew the questions existed.

### Problem analysis and root cause

**N independent drafts are worthless without a synthesis discipline, and the obvious synthesis is the wrong one.** The natural thing for a lead handed four plans is to read them, pick the best-written one, and lightly graft in anything else that looks good. That throws away the entire epistemic value of independent sampling. The whole reason to pay N× on planning is that *where independent agents disagree, you have located real uncertainty in the problem* — and a lead that merges by taste never surfaces the disagreement at all, so the uncertainty silently resolves in favour of whichever agent wrote most fluently.

**Why the map must be produced before the plan — two independent reasons:**

1. **It forecloses rubber-stamping.** Once a lead has started drafting a merged plan it is committed to a structure, and contradicting evidence gets filed as a caveat rather than reopening the shape. Emitting the disagreement table first makes the uncertainty explicit while it can still change the outcome.
2. **Context budget.** Four deep plans against this repo's section schema is a large amount of context — the sample plans in `.switchboard/plans/` run to thousands of words each. A lead attempting to hold four of them *and* draft a fifth will degrade. The map is a compression step: it reduces four plans to a claim table, and the synthesis then works from the table plus targeted re-reads rather than from four full documents.

**The singleton problem is the crux of the rubric.** A claim only one investigator made is simultaneously the highest-value and highest-risk category — it is either the insight the others missed, or the one hallucination. The failure mode to design against is resolving it by vote. Majority voting on a claim asserted by one of four agents *always* discards it, and on this codebase the lone dissenter is frequently the one who is right: the repo's own `CLAUDE.md` documents that the plan importer is resolve-only, that `window.confirm()` is a silent no-op in webviews, and that `dist/` is not used in development — all cases where the majority reading of the code is wrong. Any rubric that treats agreement as truth will systematically delete the correct minority finding. Singletons must be settled by reading the cited code, never by counting agents.

**Root cause of why this cannot be done today.** Nothing in the tree compares plan files against each other. `improve-feature` (`.agents/skills/improve-feature/SKILL.md`) is the closest precedent — it reconciles a feature's subtasks and is authorised to merge, delete, rewrite and split — but it reconciles plans that describe *different work*, not N descriptions of *the same* work, so its rubric is about coherence and coverage rather than about adjudicating contradictory factual claims. The comparison primitive is genuinely absent.

**Blast radius.** This plan is the first of the three that writes into `.switchboard/plans/`, so it is the first that puts cards on the board. Everything upstream stays in the run directory.

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
- **Spine selection must not reward fluency.** The spine should be the draft with the fewest *refuted* claims, not the longest or the best-written. An agent that wrote confidently and wrongly will read better than one that hedged accurately.
- **Plan sizing will fire more often than usual.** N investigators surface more scope than one, so the repo's authoring rule — split at 3+ distinct deliverables or 2+ independently-shippable phases — will trigger on a large share of runs. The synthesis step must be willing to emit *multiple* plans plus a feature grouping rather than one mega-plan, and must not treat "one run → one plan" as an invariant.
- **The lead must not have investigated.** If the lead formed its own hypothesis during the run it will favour it at synthesis time and the adjudication is no longer neutral. Assembler and investigator must be distinct roles — the same asymmetry the reference architecture uses.
- **Citations must be checked, not trusted.** An investigator can cite `file:line` for a claim the code does not support. If synthesis accepts citations at face value it launders a hallucination into the final plan with a footnote that makes it look verified. At minimum, spot-check citations for claims that survive into the plan.

## Edge-Case & Dependency Audit

**Race Conditions** — none new; the run directory is complete before synthesis begins (plan 01 owns the completion condition). Synthesis must not start on a partial run except when plan 01 reports a quorum completion, in which case the map must record which investigators were absent so a two-of-two "unanimous" is not mistaken for four-of-four.

**Security** — none new. Reads workspace files, writes plan files.

**Side Effects** — writes into `.switchboard/plans/`, which is watched and auto-imported (`TaskViewerProvider.ts:15110-15117`), so each emitted plan becomes a board card. Intended. Per the repo's pinning protocol, an emitted plan carries `**Project:**` only if the run's originating request named one or a PROJECT PIN directive supplied one; otherwise the line is omitted and the plan lands unassigned.

**Dependencies & Conflicts** — depends on plan 01's run directory and manifest. Overlaps conceptually with `improve-feature`'s reconciliation rubric; worth reading that skill before authoring this one, but do not extend it — the inputs differ (N views of one problem vs N different subtasks) and merging the two rubrics will make both worse.

## Dependencies

`multi-agent-planning-01-fan-in-dispatch.md` — provides the run directory, drafts and manifest.

## Implementation

1. Read the run manifest and all present drafts; record which roster entries are missing so quorum runs cannot masquerade as full ones.
2. Extract claims per draft — each a proposition about the codebase with its cited `file:line`, distinguished from proposed *actions*, which are not adjudicable facts.
3. Cluster claims across drafts and bucket each cluster: **unanimous** (all contributing investigators assert it), **split** (asserted and contradicted), **singleton** (one investigator only, uncontradicted), **contradicted** (asserted by some, explicitly refuted by others).
4. Emit `divergence-map.md` into the run directory: one row per claim cluster with bucket, asserting agents, contradicting agents and citations. This artifact is the deliverable of this step — no merged plan yet.
5. Encode the resolution rubric: unanimous claims are kept without re-litigation; split and contradicted claims are resolved by reading the cited code; **singletons are resolved by citation-checking and are never dropped for lack of corroboration.**
6. Spot-check citations for every claim that survives into the final plan, so an unsupported `file:line` cannot launder a hallucination.
7. Select the spine — the draft with the fewest refuted claims — and graft verified findings from the others onto it rather than merging structurally.
8. Apply the repo's plan-sizing rule to the synthesized scope: emit multiple plans where 3+ deliverables or 2+ shippable phases are present, and offer a feature grouping rather than creating one unasked.
9. Record every unresolved disagreement in the emitted plan as an explicit open question carrying both readings and their citations, placed in or below `## Goal` per the authoring protocol. A stated open question is more valuable than a manufactured consensus.

## Proposed Changes

### Divergence map generator (new)
- **Context:** Nothing compares plan files against each other; `improve-feature` reconciles different subtasks, not competing views of one problem.
- **Logic:** Extract, cluster and bucket claims across N drafts; emit the map before any synthesis.
- **Edge Cases:** Over-merging paraphrases hides disagreement; under-merging produces unreadable noise; quorum runs must not read as unanimous.

### Synthesis rubric (new)
- **Context:** No rule exists for resolving contradictory claims between drafts.
- **Logic:** Unanimous kept; split and contradicted resolved against code; singletons citation-checked and never vote-dropped; spine chosen by fewest refutations.
- **Edge Cases:** Fluency mistaken for correctness; citations trusted without checking; plan-sizing rule ignored in favour of one output plan.

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
6. A run whose synthesized scope contains 3+ distinct deliverables emits multiple plans, not one mega-plan, and offers a feature grouping rather than creating one unprompted.
7. An unresolved disagreement appears in the emitted plan as an open question with both readings, not silently resolved in either direction.
8. A quorum run (two of four investigators) produces a map that records the two absences, and its "unanimous" bucket is not presented as four-agent agreement.
9. Emitted plans carry no `**Project:**` line unless the run's request or a PROJECT PIN directive supplied one.
10. `npx tsc --noEmit` introduces no new errors against the pre-existing baseline.

## Recommendation

Complexity 6 → **Send to Planner for one more pass before coding.** The claim-extraction format is the highest-risk piece in the three-plan set and should be prototyped against real drafts from a plan-01 run before it is fixed — the rubric is cheap to change on paper and expensive to change once the map format has consumers.
