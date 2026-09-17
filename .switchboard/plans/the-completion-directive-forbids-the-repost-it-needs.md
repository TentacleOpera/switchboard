# The Completion Directive Forbids the Repost It Needs, and a Test Demands the Flag That Was Removed

## Goal

A coder handed a fix round after a lead review is told, in the round it is working, that it must post
completion for **that** round. The completion directive becomes aware of round and fix status instead
of being static role-scoped text written for a first round. Separately, every remaining instruction to
pass `--from` is removed — including the contract test that currently **requires** it.

### Problem analysis

**Observed, recurring, and currently fixed by hand.** Coders post completion for their first round,
then treat that post as covering every later round. When the lead sends work back for fixes, the fix
lands and nothing is posted. The operator intervenes manually, repeatedly.

**They are not forgetting. They are obeying.** This is the text they receive
(`standingOrders.ts:715`):

> COMPLETION REPORT: **When you have finished implementing ALL parts of the plan**, run
> `node "<cliPath>" done` (or `switchboard done`). This signals task completion to the kanban board —
> the system clears your card's activity light and notifies your lead. **Do NOT report after
> finishing individual parts — only when ALL work is complete.** Also append a brief summary (3-5
> sentences) to the END of the original plan file for the record. Do NOT skip the completion report.

Read by a coder that posted on round 1 and has just been handed a review fix:

- *"only when ALL work is complete"* — all work **was** complete; it was posted. This is a correction
  to finished work.
- *"Do NOT report after finishing individual parts"* — a fix is naturally a *part*, not the whole
  plan. The directive appears to **forbid** posting again.

The anti-over-reporting clause is read as an anti-**re**-reporting clause. The directive is written
entirely in first-round, whole-plan framing, has no concept of a second round, and the one sentence
that could disambiguate says the opposite of what is wanted.

**Delivery is not the problem — that was already fixed.** A lead's review request reaches the coder
as a `kind: "message"` prompt, and standing orders used to be suppressed for exactly that case. They
are not any more: `bootstrap.ts:3155` passes `applyOrders` as `payload.standingOrders !== false`,
no longer gated on `!isMessage`; only the *seat block* is suppressed for a message now. **The orders
arrive. They say the wrong thing.**

**Why it cannot be fixed by editing the string.** The completion directive is installed as a
**role-scoped** standing order — `COMPLETION_DIRECTIVE_ORDER_ID_PREFIX = 'completion-directive:role:'`
(`standingOrders.ts:718`) — one static text per role, not per card and not per delivery. A role-scoped
constant cannot say "this is a fix round", because at install time there is no round. Making it
round-aware means composing it where the target is known, which is the delivery seam
(`applyStandingOrdersForDelivery`, `standingOrdersDelivery.ts:40`), not the constant.

**The same directive exists twice, byte-identical.** `COMPLETION_DIRECTIVE_ORDER_INSTRUCTION`
(`standingOrders.ts:715`) and `CODING_COMPLETION_REPORT_DIRECTIVE` (`agentPromptBuilder.ts:1267`) are
467 characters and identical. Fixing one and not the other gives coders different instructions
depending on which path delivered them, and no gate catches it.

#### `--from` keeps coming back because a contract test demands it

`--from` was deliberately removed: `done`, `accept` and `next` all read `SWITCHBOARD_TERMINAL`, which
the host injects into every seat, and the host attributes the seat from its own evidence — *"host
evidence only, never `from`, never the request body"* (`LocalApiServer.ts:4252` region). Six contract
tests enforce its absence:

| test | assertion |
| --- | --- |
| `coding-head-prompt-contract.test.js:138` | *"no prompt may pass `--from`"* |
| `standing-orders-marker-contract.test.js:386` | headPrompt must not pass `--from` to `next` |
| `member-completion-reminder-contract.test.js:338,351` | the seat route must not ask for `--from` |
| `queue-pipeline-contract.test.js:640` | the seat supplies no `--from` |
| `review-team-triage.test.js:74` | the seat supplies no `--from` |
| `bare-completion-contract.test.js:81` | bare `done` must not ask for `--from` |

**And one demands the opposite.** `completion-directive-standing-order.test.js` asserts the removed
form is **present**:

```js
// :110-112
await check('standing order uses CLI form (switchboard done --from)', () => {
    assert.ok(COMPLETION_DIRECTIVE_ORDER_INSTRUCTION.includes('switchboard done --from'),
        'COMPLETION_DIRECTIVE_ORDER_INSTRUCTION must use the CLI form (switchboard done --from)');
// :188
assert.ok(rendered.includes('done --from "MyCoder"'), ...);
```

It is a registered contract script — `test:contract:completion-directive-standing-order`
(`package.json:1082`) — and the shipped directive does **not** contain `done --from`, so **it fails
today**. That is the mechanism by which this keeps coming back: an agent runs the contract suite,
sees this test fail, and "fixes" it by restoring `--from` to the directive. The removal is undone by
someone doing exactly what the suite told them to do.

**Stale prose repeats the claim** in five docblocks — `standingOrders.ts:359`, `:658`, `:699`,
`:711`, and `agentPromptBuilder.ts:2286` — each describing the directive as *"the `switchboard done
--from` instruction"*. None is executable, all of them mislead a reader deciding what the directive
should say.

**One further stale source.** `.agents/workflows/switchboard.md:72` still tells agents that
`kind: "message"` *"suppresses the standing-orders block, seat directive block, and dispatch
directives."* That stopped being true when the delivery fix landed. A lead following it may pass
`standingOrders: false` explicitly to get the lean message the doc promises, re-creating the original
bug by hand.

### What must not be disturbed

- **`--from` remains accepted by the CLI.** `accept --plan X --from <lead>` is a documented manual
  override (`lead-accept-advances-contract.test.js:487` asserts an explicit `--from` overrides the env
  default, and `:468` asserts the error names it). This plan removes `--from` from **instructions given
  to agents**, never from the CLI's own surface.
- **The anti-over-reporting rule.** "Do not report after finishing each individual part" is correct
  *within* a round and must survive; it is only its cross-round reading that is wrong.
- **Role-scoped standing orders as a mechanism.** This plan composes one directive at delivery; it
  does not rewrite the standing-orders system.

### Non-goals

- Changing when standing orders are delivered. That was fixed and works.
- Removing `--from` from the CLI, its usage text, or its tests.
- Teaching the coder about `coding_rounds`. Round status is resolved for it, not by it.
- Detection of the failure. That is row 10 of the controller's judgement matrix, which stays as a
  backstop — this plan reduces the rate; it does not guarantee compliance.

## Metadata

- **Complexity:** 5
- **Tags:** backend, bugfix, reliability, docs, test

## User Review Required

None on shape — the operator specified it: standing orders dynamic to round and fix status
(*"This is a fix round. When you have implemented these fixes, post completion"*), and nothing
anywhere telling an agent to use `--from`.

## Complexity Audit

### Routine

- Rewriting the directive text and deleting its duplicate.
- Correcting the stale test, the five docblocks and the workflow doc.

### Complex / Risky

- **Moving a role-scoped constant to delivery-time composition.** The directive is currently installed
  once per role; resolving round status requires the target seat's card at delivery. This is a new read
  on a hot path (every prompt delivery), and it must not fail delivery when the read fails.
- **The round signal must not mislabel.** Telling a coder on its first round "this is a fix round"
  would be worse than the current text: it invites a post for work that is not done.

## Edge-Case & Dependency Audit

### Race Conditions

- **Re-dispatch mid-delivery.** A card re-dispatched while a prompt is being composed could resolve
  round status against the previous `owner_since`. Resolve once per delivery and carry the
  `owner_since` the decision was made against, so a mismatch is visible afterwards.
- **A seat holding no card.** An orientation or ad-hoc message to a seat with no `owner_seat` row has
  no round to resolve — it takes the unconditional wording, never the first-round wording.

### Security

- None. No new credential, endpoint, or external call; one additional local DB read on an existing
  authenticated path.

### Side Effects

- Every prompt delivery to a coding role gains a DB read. It must be cheap and it must be optional:
  a failed read degrades the wording, never the delivery.
- The directive gets longer in the fix-round case. It is already the longest standing order; the fix
  branch replaces a clause rather than appending to it.

### Dependencies & Conflicts

- **Independent of the standing-controller feature.** It touches `standingOrders.ts`,
  `agentPromptBuilder.ts`, `standingOrdersDelivery.ts` and tests — none of the controller files. It can
  ship while that work is in flight.
- Complements row 10 of `the-judgement-model-is-gated-behind-the-detection-it-exists-to-replace.md`,
  which detects the failure this plan reduces.

## Adversarial Synthesis

Key risks: a delivery-time DB read on every prompt is a new failure surface on a hot path, and a
wrong round verdict is worse than no verdict — telling a first-round coder it is fixing something
invites a premature post. Mitigations: the read is optional and degrades to wording that is correct in
both rounds, the resolved `owner_since` is carried so a stale decision is visible, and the fix-round
branch requires positive evidence (a prior `finished` predating the current `owner_since`) rather than
the absence of anything.

## Proposed Changes

### 1. The completion directive is composed per delivery, with a round clause

Resolve, at `applyStandingOrdersForDelivery` (`standingOrdersDelivery.ts:40`), the target seat's card
and whether a `finished` turn-end exists for it **predating the current `owner_since`**. That is the
same signal the controller already uses and needs no new schema — `coding_rounds` is not read.

Three outcomes, and the third is the important one:

| resolved state | clause |
| --- | --- |
| **fix round** — prior `finished` before current `owner_since` | *"This is a fix round. You posted completion for an earlier round of this card; that post does not cover this round. When you have implemented the requested fixes, run `switchboard done` again."* |
| **first round** — card held, no prior `finished` | *"When you have finished implementing ALL parts of the plan, run `switchboard done`."* |
| **unresolved** — no card, or the read failed | *"Post completion at the end of every round, including any fix round after a lead review. A previous round's post never covers a later one."* |

**The unresolved branch is deliberately the unconditional wording, not the first-round wording.**
Per the fallback rule: an unresolvable round must not silently render as "first round", which is the
reading that caused the bug. The unconditional text is correct in both rounds, so the failure is safe
rather than quiet, and the delivery records which branch it took.

**The anti-over-reporting clause is scoped to within a round**, not deleted:

> *"Do not post after finishing individual parts of the round — post once, when the round's work is
> complete."*

### 2. One directive, not two

`CODING_COMPLETION_REPORT_DIRECTIVE` (`agentPromptBuilder.ts:1267`) and
`COMPLETION_DIRECTIVE_ORDER_INSTRUCTION` (`standingOrders.ts:715`) are byte-identical. Delete one,
export the other, and have both call sites use it. A test asserts there is exactly one definition, so
the duplication cannot reappear.

### 3. The contract test that demands `--from` is corrected, and its inversion is made permanent

`completion-directive-standing-order.test.js:110-112` and `:188` assert the directive **contains**
`switchboard done --from`. This is the ratchet that keeps restoring the flag. Invert both assertions
to match the other six contract tests: the directive must **not** contain `--from`, and the rendered
order must not interpolate a seat name into a `done` command.

Add one assertion the suite currently lacks: **no standing order, prompt directive or composed prompt
in either host contains `--from`**, as a single check over the exported directive set rather than six
per-file checks that each cover one path.

### 4. Stale prose is corrected

- `standingOrders.ts:359`, `:658`, `:699`, `:711` and `agentPromptBuilder.ts:2286` — five docblocks
  describing the directive as *"the `switchboard done --from` instruction"*. Correct them to the
  current form.
- `.agents/workflows/switchboard.md:72` — still claims `kind: "message"` suppresses the standing-orders
  block. Correct it: a message suppresses the **seat directive block and dispatch directives**;
  standing orders are delivered unless the caller passes `standingOrders: false`, and a lead relaying a
  review **must not** pass it.

## Verification Plan

### Automated Tests

- A delivery to a seat whose card carries a `finished` turn-end predating its current `owner_since`
  renders the **fix-round** clause, naming that a previous post does not cover this round.
- A delivery to a seat whose card has no prior `finished` renders the **first-round** clause.
- A delivery to a seat holding no card, and a delivery whose round read throws, both render the
  **unconditional** clause — never the first-round clause.
- The branch taken is recorded with the `owner_since` it was resolved against.
- A failed round read does not fail the prompt delivery.
- The within-round anti-over-reporting clause is present in all three branches.
- **No exported standing order, prompt directive or composed prompt contains `--from`** — one
  assertion over the whole directive set.
- `completion-directive-standing-order.test.js` passes with the inverted assertions, and fails if
  `--from` is reintroduced to the directive.
- Exactly one definition of the completion directive exists across `standingOrders.ts` and
  `agentPromptBuilder.ts`.
- `switchboard accept --plan X --from <lead>` still works and still overrides the env default — the
  CLI surface is untouched.

### Goal Invariants

1. The fix-round clause is reachable at runtime: assert it renders from a real delivery path, not only
   from a unit call on the constant.
2. `grep -rn -- '--from'` over `src/services/standingOrders.ts`, `src/services/agentPromptBuilder.ts`
   and `.agents/` returns **zero** matches outside CLI-surface documentation — **paired with:** the
   CLI's own `--from` handling and its tests are unchanged and still pass.
3. The string `completion-directive:role:` still prefixes an installed order — the role-scoped
   mechanism is composed at delivery, not replaced.
4. Exactly one completion-directive constant is exported across the two modules.
5. A seat with no resolvable round receives wording that is correct in both rounds — assert the
   unconditional text, and assert it is not the first-round text.

**Goal-vs-appearance:** every assertion above can pass while a coder in a fix round still reads text
that tells it not to post. So:

6. Render the directive for a real fix-round delivery and assert it contains an explicit instruction to
   post **again**, and contains no sentence that conditions posting on the *plan* being complete.

---

**Recommendation: Send to Coder.** Complexity 5 — a wording change, one constant deleted, one test
inverted and six docs corrected, with a single genuinely new piece of work: resolving round status at
the delivery seam without making delivery depend on it.
