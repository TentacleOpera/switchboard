# Nothing Measures What Anything Costs, and Cost Control Is the Product's Central Claim

## Goal

The board can answer what a plan, a mission and a seat cost to run. Today it cannot answer any of them.

### Problem analysis

**The product's central claim is cost control and the product measures no cost.** Every distinctive feature is an argument about where money goes: seat a cheap CLI under an expensive lead, use a free tier or a local model, let a lead reject bad work before an expensive reviewer sees it, have the planner route routine work to the cheaper coder. All of it is unmeasured.

**Verified absent.** A repository-wide search for `tokenCount`, `tokensUsed`, `inputTokens`, `usage.input`/`usage.output` or `token_usage` across `src/` returns nothing. There is no accounting of any kind. The only per-seat record is the terminal transcript under `.switchboard/logs/`, which captures whatever a CLI happens to print in its own format.

**Three questions the operator cannot ask**, each of which the product's own positioning invites:

- *What did that mission cost?* — the thing you decide to run or not run.
- *Was the pair actually cheaper than the flagship alone?* — the justification for pair programming, currently a memory of one run on a superseded build.
- *Which seat is expensive?* — the input to every seating decision the product asks you to make.

**And it blocks the strongest claim available.** An Opus-solo versus Opus-plus-Gemini comparison once showed roughly 30% fewer tokens. It cannot be restated because it cannot be reproduced: measuring it today means a controlled pair of runs read by hand off two vendors' dashboards. A claim that only its author can half-remember is not a claim.

## Metadata

- **Complexity:** 6
- **Tags:** cost, observability, board, agents

## User Review Required

None.

## Proposed Changes

### 1. Decide the unit before building anything

Tokens are not uniformly available and are not the same thing across vendors: a subscription seat, a free-tier seat and a local ollama seat have genuinely different cost meanings, and one number covering all three would be false precision. Pick the unit deliberately and state it — tokens where a CLI reports them, and something honest where it does not.

### 2. Capture what each CLI actually reports, per family

Several CLIs print usage at the end of a turn; the format differs per family and none is stable. So:

- A per-family extractor, keyed on the **frozen CLI family** already resolved at spawn.
- **A family with no extractor reports "not measured", never zero and never an estimate.** This is the load-bearing rule. A plausible number derived from turn counts or elapsed time, presented beside a real one, is the fallback-indistinguishable-from-a-real-value failure applied to the one surface whose entire purpose is to be trusted.
- Attribute the capture to the seat and, through the seat's dispatch record, to the plan.

### 3. Roll up to plan, feature and mission

The dispatch record already joins a seat to a plan, and plans already join to features and missions, so the rollup needs no new relationships. Every rolled-up figure carries **coverage** — how many contributing seats were measured and how many were not. A mission total with three unmeasured seats in it must say so.

### 4. Surface it where the decision is made

Cost belongs next to the thing being decided, not in a report nobody opens: on the card, on the feature, and on the mission before it is launched. A single number with its coverage, expandable to the per-seat breakdown.

### 5. Make the comparison reproducible

A recorded run — same plan, same board state, one configuration changed — is what turns "pair programming is cheaper" into a fact. Once change 2 exists, this is a procedure rather than a feature: run the plan twice, capture both figures, record the method alongside the result. The pair-programming default plan explicitly depends on this to state its case in public.

## Edge-Case & Dependency Audit

1. **Local models cost no money and real electricity.** Reporting ollama at zero alongside a metered seat implies a comparison that is not being made. Report it as local, not as free.
2. **Subscription seats have no marginal token price.** A token count is still the right proxy for quota pressure, but it is not currency and must not be rendered as one.
3. **Transcript parsing is fragile by construction.** A CLI changing its output format silently degrades to "not measured", which is the correct failure — assert that direction, since the wrong one is a confidently stale number.
4. **Do not add a per-turn API call to a vendor's usage endpoint.** That is a rate-limit and credential surface on the dispatch path, for a figure that can be read after the fact.
5. **Retention.** Per-seat, per-turn records grow. Decide the horizon at design time rather than after a database report.
6. **This must not become a billing feature.** It answers "where did the effort go", not "invoice me".

## Verification Plan

1. A dispatch to a CLI whose family has an extractor records a usage figure attributed to the correct seat and plan.
2. A dispatch to a family with **no** extractor records "not measured" — assert specifically that it records neither zero nor an estimate.
3. A mission containing both reports a total plus coverage naming the unmeasured seats.
4. A local model seat is reported as local, distinctly from both measured and unmeasured.
5. The same plan run twice with one configuration changed produces two comparable figures and a recorded method.
6. A CLI output-format change degrades that family to "not measured" rather than reporting a stale figure.
