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

- **Complexity:** 6
- **Tags:** backend, bugfix, reliability, docs, test

## User Review Required

None on shape — the operator specified it: standing orders dynamic to round and fix status
(*"This is a fix round. When you have implemented these fixes, post completion"*), and nothing
anywhere telling an agent to use `--from`.

One scope addition made by the improve pass, flagged for visibility rather than permission: change 5
(carries a `roleMap` through the standing-orders snapshot so the role-scoped directive renders on the
tmux/`sendRobustText` rails, where `roleMap: undefined` currently skips it entirely). Included
because the goal is unmet on those rails without it; it is a small adjacent fix on the same seam, not
new product scope.

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
  `agentPromptBuilder.ts`, `agentDirectives.ts`, the two composition roots, `TaskViewerProvider.ts`,
  `terminalUtils.ts` and tests — none of the controller files. It can ship while that work is in
  flight. (`standingOrdersDelivery.ts` is *not* touched — see the Superseded callout in Proposed
  Changes.)
- Complements row 10 of `the-judgement-model-is-gated-behind-the-detection-it-exists-to-replace.md`,
  which detects the failure this plan reduces.

## Dependencies

- `the-judgement-model-is-gated-behind-the-detection-it-exists-to-replace.md` — complementary;
  row 10 of its judgement matrix detects the failure this plan reduces. Independent — either order.
- `feature_plan_20260827172158_completion-directive-becomes-standing-order.md` — the ancestor plan
  that moved the directive from prompt-injected text to a role-scoped standing order. Already landed;
  context only.

## Adversarial Synthesis

Key risks: a delivery-time DB read on every prompt is a new failure surface on a hot path, and a
wrong round verdict is worse than no verdict — telling a first-round coder it is fixing something
invites a premature post. Mitigations: the read is optional and degrades to the unconditional wording
that is correct in both rounds (never the first-round wording), the resolved `owner_since`/`planId`
are logged per delivery so a stale decision is answerable after the fact, and the fix-round branch
requires positive evidence — a `finished` turn-end predating the current `owner_since` — rather than
the absence of anything.

## Proposed Changes

### 1. Round status is resolved by a shared helper and threaded through `StandingOrderRenderOptions` — the `hasRegisteredRounds` precedent

> **Superseded:** "Resolve, at `applyStandingOrdersForDelivery` (`standingOrdersDelivery.ts:40`), the
> target seat's card and whether a `finished` turn-end exists for it predating the current
> `owner_since`."
> **Reason:** Two faults. (a) `standingOrdersDelivery.ts` is a deliberately leaf module — its own
> docblock forbids importing the `standingOrders`/`KanbanDatabase` chain, because
> `tmuxPromptDelivery.ts` loads it under Node's strip-only TypeScript mode and
> `ptyPromptDelivery.ts` must stay vscode-free. A resolver reading `plans`/`plan_events` cannot live
> there. (b) Even if it could, the seam covers only the applier rails (`extension.ts:1102`,
> `bootstrap.ts:4203`, `terminalUtils.ts`'s fallback branch); the primary dispatch rails call
> `applyStandingOrders`/`renderStandaloneOrdersBlock` directly — `TaskViewerProvider.ts:1358`,
> `bootstrap.ts:675`, `TaskViewerProvider.ts:2900` — so the fix-round clause would never render on the
> paths where fix rounds actually arrive.
> **Replaced with:** Resolve in the same place `hasRegisteredRounds` is resolved — at each render
> call site — via a new shared async helper in `standingOrders.ts`, carried to render as a new
> `StandingOrderRenderOptions.completionRound` field.

New helper in `src/services/standingOrders.ts`:

```ts
export type CompletionRound = 'first' | 'fix' | 'unresolved';
export async function resolveCompletionRoundForSeat(
    db: any,
    targetName: string
): Promise<{ round: CompletionRound; ownerSince?: string; planId?: string }>
```

Logic: missing `db`/`targetName` → `{ round: 'unresolved' }`. `wsId = await db.getWorkspaceId()`;
`rows = await db.getActiveDispatchedRowsByTerminal(wsId, targetName)` (the PLURAL variant,
`KanbanDatabase.ts:15144` — a seat can hold a batch; the singular `getActiveDispatchedByTerminal`
`LIMIT 1`s it). Empty → `'unresolved'` (seat holds no live card). For each row,
`getPlanEventsByPlanId(row.planId)` and test `event_type === 'turn_end' && action === 'finished' &&
Date.parse(e.timestamp) < Date.parse(row.ownerSince)`; any true → `'fix'` carrying that row's
`ownerSince`/`planId`; none → `'first'` against the newest row. Any throw → `'unresolved'` plus
`console.warn`. One `console.log` per call naming seat, round, `planId`, `ownerSince` — the
"records which branch it took" requirement (the fallback rule: which store answered must be
answerable after the fact).

**Wiring sites — the composition-root audit.** Every render call site resolves and passes the option.
All five, both roots:

| site | rail |
| --- | --- |
| `TaskViewerProvider.ts:1353-1363` | extension `ptySendPrompt` path |
| `TaskViewerProvider.ts:2895-2904` | extension establish/clear standalone block |
| `TaskViewerProvider._resolveStandingOrdersForVsCode` (`:1690-1696`) | snapshot feeding `sendRobustText` and the `extension.ts:1102` applier |
| `bootstrap.ts:675-686` | standalone `deliverPrompt` (PTY rail) |
| `bootstrap.ts:4202-4203` | standalone applier seam (tmux rail) |

The snapshot object (`resolveStandingOrdersSnapshotForDelivery`'s return type and
`sendRobustText`'s `options.standingOrders` type at `terminalUtils.ts:193`) gains
`completionRound?: CompletionRound`; `terminalUtils.ts:209-217` passes it through exactly like
`hasRegisteredRounds`.

**Message-delivered fix rounds resolve `'unresolved'`, by design — state it, don't discover it.**
`queue/done` clears `owner_seat`/`owner_since` (`KanbanDatabase.ts:14865`), and a lead's
`kind: "message"` fix relay does not re-stamp them, so the seat holds no live row and takes the
unconditional wording — correct in both rounds, never the first-round wording. The `'fix'` clause
fires only when the card was re-attributed to the seat (a re-dispatch stamps `owner_since` via
`updateDispatchInfoByPlanFile`, `KanbanDatabase.ts:14575`). This is safe degradation, not a gap —
but reviewers should know the fix clause is not the only path the goal rides on.

### 2. The clause is composed at render, keyed on the deterministic order id

In `renderStandaloneOrdersBlock`/`renderOrder`: an order whose `id` starts with
`completion-directive:role:` (`COMPLETION_DIRECTIVE_ORDER_ID_PREFIX`, `standingOrders.ts:717`) does
**not** render its stored `instruction`; it renders `composeCompletionDirective(round)` for the
resolved round (`options.completionRound ?? 'unresolved'`). The stored row becomes a scope marker
whose text is decorative — which also neutralizes **stale persisted rows**: installation happens only
on `ptyCreateTerminal` per role (`TaskViewerProvider.ts:4520`, `bootstrap.ts:2543`), so a row written
by an older build (e.g. carrying the removed `done --from "${terminalName}"` text) would otherwise
survive in the install base until a terminal of that role is next created. Render-time canonical
composition makes persisted text unable to reach an agent regardless of install recency.
`materializeStandingOrderForInspection` applies the same substitution (with `'unresolved'` — it has
no delivery context) so the Orders tab shows what an agent would read, not a stale stored copy.

Clause text:

| resolved state | clause |
| --- | --- |
| **fix round** — prior `finished` before current `owner_since` | *"This is a fix round. Completion was posted for an earlier round of this card; that post does not cover this round. When you have implemented the requested fixes, run `node "<cliPath>" done` (or `switchboard done`) again."* |
| **first round** — card held, no prior `finished` | *"When you have finished implementing ALL parts of the plan, run `node "<cliPath>" done` (or `switchboard done`)."* |
| **unresolved** — no card, or the read failed | *"Post completion at the end of every round, including any fix round after a lead review. A previous round's post never covers a later one — run `node "<cliPath>" done` (or `switchboard done`) when the round's work is complete."* |

The fix clause says "Completion was posted", **not** "you posted" — the earlier round may have been
a different seat's (reassignment between rounds), and the claim must stay true either way.

**The unresolved branch is deliberately the unconditional wording, not the first-round wording.**
Per the fallback rule: an unresolvable round must not silently render as "first round", which is the
reading that caused the bug. The unconditional text is correct in both rounds, so the failure is safe
rather than quiet, and the delivery records which branch it took.

**The anti-over-reporting clause is scoped to within a round**, present in all three branches:

> *"Do not post after finishing individual parts of the round — post once, when the round's work is
> complete."*

The plan-file summary sentence ("append a brief summary to the END of the original plan file") also
survives in all three.

### 3. One directive definition, housed in the leaf module

`CODING_COMPLETION_REPORT_DIRECTIVE` (`agentPromptBuilder.ts:1267`) and
`COMPLETION_DIRECTIVE_ORDER_INSTRUCTION` (`standingOrders.ts:715`) are byte-identical. The canonical
text moves to `agentDirectives.ts` — the leaf module that already exists for exactly this problem
(it holds `GIT_SAFETY_DIRECTIVE` et al. because keeping them in `agentPromptBuilder.ts` closed the
`builder → protocolDirectives → KanbanDatabase → standingOrderFragments → builder` import cycle).
Add `composeCompletionDirective(round)` plus the clause constants there. Both existing exported names
become aliases bound to `composeCompletionDirective('unresolved')`, so every existing import path
still works and there is one definition. A test asserts the two names are the same string.

The payload fallback (`ensureCompletionDirective` inside `ensureDispatchProtocolDirectives`) runs at
the pty verb **before** standing-orders composition and has no round context — the unconditional
wording is the correct text for it: safe in both rounds, and the round-aware standing order appended
afterwards carries the specific clause when resolution succeeded.

### 4. The tests that demand `--from` are inverted — two files, not one

- `completion-directive-standing-order.test.js`: `:110-112` asserts the instruction contains
  `switchboard done --from`; `:153` asserts rendered output contains the terminal name (fails today —
  the current instruction has no `${terminalName}` placeholder); `:186-189` asserts
  `done --from "MyCoder"` appears. Rewrite: assert `--from` is absent from every exported directive
  variant and from the rendered block; move `${terminalName}` interpolation coverage to a synthetic
  order carrying the placeholder (the machinery stays for other orders — test 8's pattern).
- `agentPromptBuilder.test.ts:371` asserts
  `STAGGERED_IMPLEMENTATION_DIRECTIVE.includes('switchboard done --from')` — **also fails today** and
  is a second ratchet the original draft missed. Invert it.
- New sweep assertion: **no exported standing order, prompt directive, fragment body, or composed
  prompt contains `--from`** — one check enumerating the directive set
  (`COMPLETION_DIRECTIVE_ORDER_INSTRUCTION`, `CODING_COMPLETION_REPORT_DIRECTIVE`, all three
  `composeCompletionDirective` variants, `STAGGERED_IMPLEMENTATION_DIRECTIVE`, and the
  `STANDING_ORDER_FRAGMENTS` bodies) rather than six per-file checks that each cover one path. This
  is the permanent inversion: a future regression fails one loud test instead of silently restoring
  the flag.

### 5. The applier rails pass `roleMap: undefined` — the directive renders on no tmux/VS Code-terminal seat today

Found in review: `extension.ts:1102` and `bootstrap.ts:4203` both pass `undefined` as `roleMap`, and
`selectOrders` skips role-scoped orders when `roleMap` is absent — so the completion directive
(role-scoped) never reaches seats on the tmux or `sendRobustText` rails at all, and no amount of
round-awareness fixes that. The snapshot must carry the role data: extend
`resolveStandingOrdersSnapshotForDelivery`'s return (and `sendRobustText`'s `standingOrders` option
type) with a `roleMap` built from the same role source each host already uses — the fleet handles'
`role` field in standalone (the map `bootstrap.ts:669-674` already builds), the registry/role rows in
the extension (the map `TaskViewerProvider.ts:1340-1345` already builds). Both applier registrations
pass it through. This is a pre-existing gap made in-scope because the Goal — "a coder handed a fix
round is told to post completion" — is unmet on those rails without it.

### 6. Stale prose is corrected — the full enumeration

Docblocks describing the directive or the legacy pop as `done --from`:

- `standingOrders.ts:359`, `:658`, `:699`, `:711` (the four the draft named — note the id-prefix
  constant is at `:717`, not `:718`).
- `standingOrderFragments.ts:58` and `:309-312` — `hasRegisteredRounds` context docblock and the
  `headNext` comment.
- `TaskViewerProvider.ts:1352` and `:2894` — the two "legacy dispatch + done --from pop instructions"
  comments.
- `agentPromptBuilder.ts:2286` — the reviewer-block comment.
- Test-file comments (non-executable but misleading): `agentPromptBuilder.test.ts:193`, `:358`;
  `self-reported-completion-clears-contract.test.js:18`; `completion-asserted-never-inferred.test.js:246`.

`cli.ts` usage text and error messages naming `--from` are the CLI's own surface — untouched by
design (see "What must not be disturbed").

### 7. The workflow doc's message-suppression claim — both mirrors

`.agents/workflows/switchboard.md:72` **and** `.claude/skills/switchboard/SKILL.md:74` carry the
identical stale sentence ("`kind: "message"` suppresses the standing-orders block, seat directive
block, and dispatch directives"). Correct both: a message suppresses the **seat directive block and
dispatch directives**; standing orders are still delivered unless the caller passes
`standingOrders: false` — and a lead relaying a review **must not** pass it.

## Verification Plan

### Automated Tests

- `resolveCompletionRoundForSeat` unit coverage: a held card with a `finished` turn-end predating
  its `owner_since` → `'fix'`; a held card with none → `'first'`; no held card, missing inputs, or a
  throwing read → `'unresolved'` (and the throw does not propagate).
- A seat holding a batch resolves `'fix'` when **any** held card has a predating `finished`
  (the plural `getActiveDispatchedRowsByTerminal` path, not `LIMIT 1`).
- Render coverage through `applyStandingOrders`/`renderStandaloneOrdersBlock`: option
  `completionRound: 'fix'` renders the fix-round clause naming that a previous post does not cover
  this round; `'first'` renders the ALL-parts clause; `'unresolved'` and an absent option both render
  the unconditional clause — never the first-round clause.
- The render substitution is keyed on the `completion-directive:role:` id prefix: a persisted order
  row carrying **stale** instruction text (e.g. the old `done --from "${terminalName}"` body) still
  renders the canonical composed text — persisted instruction content cannot reach an agent.
- The branch taken is recorded: the resolver logs seat, round, `planId` and the `owner_since` it
  resolved against.
- A failed round read does not fail the prompt delivery.
- The within-round anti-over-reporting clause and the plan-file summary sentence are present in all
  three branches.
- **No exported standing order, prompt directive, fragment body or composed prompt contains
  `--from`** — one assertion over the directive set (change 4's sweep), which fails if `--from` is
  reintroduced anywhere in it.
- `completion-directive-standing-order.test.js` passes with the inverted assertions;
  `agentPromptBuilder.test.ts:371` passes inverted; both fail if `--from` is reintroduced.
- `COMPLETION_DIRECTIVE_ORDER_INSTRUCTION` and `CODING_COMPLETION_REPORT_DIRECTIVE` are the same
  string — one definition in `agentDirectives.ts`.
- The standing-orders snapshot carries a `roleMap`, and a role-scoped completion order renders on a
  delivery that goes through the applier seam (previously skipped: `roleMap` was `undefined`).
- `switchboard accept --plan X --from <lead>` still works and still overrides the env default — the
  CLI surface is untouched.
- `switchboard.md` and its `.claude` mirror no longer claim `kind: "message"` suppresses the
  standing-orders block.

### Goal Invariants

1. The fix-round clause is reachable at runtime: assert it renders from a real delivery path
   (`applyStandingOrders` with the option threaded as the composition roots thread it), not only
   from a unit call on the constant.
2. `grep -rn -- '--from'` over `src/services/standingOrders.ts`, `src/services/agentPromptBuilder.ts`,
   `src/services/agentDirectives.ts`, `src/services/standingOrderFragments.ts` and `.agents/`/
   `.claude/` docs returns **zero** matches outside CLI-surface documentation — **paired with:** the
   CLI's own `--from` handling and its tests are unchanged and still pass.
3. The string `completion-directive:role:` still prefixes an installed order — the role-scoped
   mechanism is composed at delivery, not replaced.
4. Exactly one completion-directive definition exists (`composeCompletionDirective` in
   `agentDirectives.ts`); both legacy exported names resolve to it.
5. A seat with no resolvable round receives wording that is correct in both rounds — assert the
   unconditional text, and assert it is not the first-round text.
6. Every production call site of `applyStandingOrders`/`renderStandaloneOrdersBlock` passes a
   resolved `completionRound` — five sites, both composition roots (change 1's table).

**Goal-vs-appearance:** every assertion above can pass while a coder in a fix round still reads text
that tells it not to post. So:

7. Render the directive for a real fix-round delivery and assert it contains an explicit instruction
   to post **again**, and contains no sentence that conditions posting on the *plan* being complete.
8. Render through the applier seam (snapshot path) for a coder seat and assert the `COMPLETION
   REPORT:` sentinel is present — the order must actually reach the rails, not merely exist.

---

**Recommendation: Send to Coder.** Complexity 6 — a wording change plus a genuinely new piece of
wiring: a shared round resolver threaded through `StandingOrderRenderOptions` at five render sites in
both composition roots, a role-map fix on the applier rails, two inverted test files, and a docblock
sweep. The structure is all established precedent (`hasRegisteredRounds`); the risk is a missed
wiring site, which the verification plan now enumerates.
