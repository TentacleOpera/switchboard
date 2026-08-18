# A Failed Subtask Escalates to a Stronger Seat

## Goal

When a seat's work comes back from review with defects, the next dispatch of that subtask goes to a **stronger seat**, not back to the same one. The ladder is `intern → coder → lead`, and it terminates: a subtask that fails at lead tier stops and escalates to the human instead of looping. Idle coders stop sitting out while an intern re-attempts work above its tier.

### Problem analysis — measured on this machine, 2026-08-17

**One seat took work at three tiers, and failed most of it.** `lead-1-intern` has held four subtasks:

| complexity | column | outcome |
|---|---|---|
| 5 | `CODER CODED` | **failed review** — added a second `ptyListTerminals` round-trip the plan explicitly forbade |
| 6 | `CODER CODED` | passed |
| 7 | `LEAD CODED` | **failed review** — four independent fabrications in one block (below) |
| 4 | `INTERN CODED` | **failed review** — shipped a test asserting a string its own implementation does not produce |

**This placement was deliberate, and it is not a routing defect.** The operator dragged these cards onto the intern seat on purpose: that seat is running a model under evaluation, and concentrating work there is how the evaluation gets signal. `lead-1-coder-1` and `lead-1-coder-2` sat idle by the same choice.

Do not "fix" the routing. There is no routing bug in this evidence. What the evidence establishes is narrower and still true: **a seat can be handed work above its tier and will attempt it, fail, and report success** — and that is the condition this plan addresses, whoever caused the placement.

**The failure mode is invisible to every automated gate.** The complexity-7 rework replaced a working block with:

- `getRelationshipPreset(rel)` — a function that exists nowhere in `src/`. HEAD had `resolvePresetMeta(relId)`, already imported in the same file.
- `preset.instruction` — a field that does not exist. `LinkPreset` is `{ id, label, direction, template }`.
- a hand-rolled `.replace(/\{child\}/g, …)` that drops `{parent}`, which `linkPresets.ts:52-53` states is `resolvePreset`'s job.
- a silently dropped member-count clamp (`Math.min(def.count || 1, 8)` → `def?.count || 1`).

Every name is *plausible*. The seat reported "No issues encountered" all three times. The one suite that catches the `ReferenceError` was already red at HEAD for an unrelated reason, so a naive "did the failure set change" check would have missed it too.

**This is the documented behaviour of a lower-effort seat, not a fluke.** Such a seat drops or fabricates wiring rather than declining work it cannot do. It does not signal being out of depth, and it never refuses. Therefore:

> A seat's self-report carries no signal about whether the work is sound. The only observable is that a review cycle failed.

That makes **failure count** the correct escalation trigger, and it makes escalation necessary rather than merely nice: without it, the same seat re-attempts the same over-tier work indefinitely, and each cycle costs a full review.

### What is already owned — do not re-implement it

`a-lead-dispatched-agent-is-told-less-than-a-board-dispatched-one.md` **has landed** and owns *initial* tier routing: a subtask's `recommendedRole` and the board's `kanban.routingMapConfig` are honoured by the lead, and the head prompt now carries that instruction (`teamWiring.ts:247-249` — *"a recommendedRole; dispatch it to a seat of that role on your team"*). Correct first-dispatch routing is that plan's job, and the evidence above shows it was landing while these four cards were already in flight.

This plan is the **second** line: what happens after a dispatch — correctly tiered or not — comes back defective. The two compose; neither replaces the other. Correct initial routing reduces how often escalation fires; it cannot remove the need for it, because a correctly-tiered seat can still fail.

**What "tier" resolves to, concretely** (verified, so the coder does not re-derive it): `KanbanProvider.resolveRoutedRole(score)` (`KanbanProvider.ts:1428`) is the single source of truth for score → role. It reads `kanban.routingMapConfig`, whose shipped default is `{ lead: [7,8,9,10], coder: [4,5,6], intern: [1,2,3] }` (`kanban.html:5773`), with a pair-programming bypass that lifts `intern` to `coder` when pair mode is on. The resolved role lands on the plan row's `routed_to` column, which is inside `PLAN_COLUMNS` (`KanbanDatabase.ts:855-860`) and is therefore already returned to any agent as `routedTo` by `GET /kanban/plans?featureId=<id>`.

### The state problem — there is no rework record today

A failed review **does not move the card**. It stays in its coding column while the lead sends corrective work to the same seat. And `plan_events` records only column transitions — every one of its 7,960 rows is `event_type='workflow_event'` with `action` of `start`/`stop` and a `workflow` naming a column move (`move-to-intern-coded`, `move-to-plan-reviewed`). Nothing records *which seat held a card* or *that an attempt failed*.

So a naive "count the failures" design needs new state. It does not have to.

## Metadata

**Complexity:** 5
**Tags:** backend, reliability, docs

## User Review Required

None. The ladder, the trigger, the termination rule, and the one manual pre-step are all decided below.

## Architecture Decision — the rule is prompt text; the failure count lives in the lead's own session

**No new table, no new column, no new agent role, no new UI, no new code path.** The entire change is instruction text in two artefacts the lead already reads: the team head prompt and the attended-dispatch skill.

### The threshold: two failed reviews on the same subtask by the same seat

> **A seat that has failed review twice on the same subtask does not get it a third time.** The third dispatch of that subtask goes one rung up the ladder `intern → coder → lead`. One failure escalates nothing — a first fix resend to the same seat is normal and is what its retained context is for.

> **Superseded:** *"A dispatch is a retry when the plan row already names a `dispatched_terminal` and the card has not advanced past its coding column. On a retry, dispatch one rung up the ladder from the tier of the recorded seat — never to the recorded seat itself."*
> **Reason:** It contradicted this plan's own later rule and its own verification steps. The boxed rule escalates on the **first** failure (any second dispatch is "a retry"); the paragraph below it, and acceptance criteria 6a/6b, escalate on the **third** dispatch. Both cannot be the rule. Worse, the record cannot support the two-failure threshold at all: `dispatched_terminal` records *who last held the card*, never *how many attempts failed*, so a rule keyed on the record can only ever count to one.
> **Replaced with:** the two-failure threshold above, with the count carried by the lead's own conversation (below). One failure is the operator-respecting choice: a hand-placed card is honoured for a real fix cycle before anything overrides it.

### Where the count lives

The lead reviewed both attempts. The count is in its own conversation, on the same turns that produced the reviews — no persistence, no query, no schema. That is the carrier.

> **Superseded:** *"derive the retry from the record that already exists; add no schema, no role"* — the plan row's surviving `dispatched_terminal` as the mechanism.
> **Reason:** The measurement behind it is correct and is preserved below, but it answers a different question than the rule asks. The record survives completion, so it can name the last seat; it cannot count failures, and this plan's threshold is a count.
> **Replaced with:** the lead's session is the carrier. The record is the **cross-restart fallback**, and only that.

**The measurement, preserved.** The plan row does persist `dispatched_terminal` after `dispatched_at` is cleared on completion — `KanbanDatabase.ts:9771` / `:9954` / `:9968` clear only `dispatched_at`, `last_liveness_at`, `blocked_at`. Measured: `team-roster-survives-the-webview-whole-array-save.md` reads `dispatchedTerminal: 'lead-1-intern'`, `dispatchedAt: None`. And that field is readable by any agent — `PLAN_COLUMNS` carries it, so `GET /kanban/plans?featureId=<id>` returns `dispatchedTerminal` and `kanbanColumn` per subtask.

**What that buys, exactly.** A lead that restarts loses its count. On the next dispatch of an un-advanced subtask it can read who last held it and re-dispatch there, restarting the count from zero. The cost of a lost count is one extra review cycle on a subtask that was already going to be escalated. That is the safe direction, and it is why no persisted counter is worth building.

### The ladder is relative to the seat that failed, and it terminates

The rung is derived from the failed seat's `role`, which `ptyListTerminals` already returns — no new lookup. A subtask that fails twice at `lead` tier does **not** escalate further and does **not** go back to the lead. The lead stops, reports to the human with the review findings, and leaves the card where it is. An unbounded ladder that wraps around is worse than no ladder: it burns the strongest seat repeatedly on work that is failing for some other reason.

**The lead never takes the subtask itself.** When the rung above is empty the answer is the human, not the driver picking up a keyboard — a lead that starts coding stops driving, and the other subtasks stall behind it.

**Fallback when the rung is empty.** If the team has no seat at the next rung, dispatch to the highest available rung above the failed seat and **say so in the dispatch prompt**. Never silently fall back *down* to the same tier — that reproduces the loop this plan exists to break. If no rung above exists at all, that is the same terminal case as failing at lead tier: stop and report.

**The threshold is per-subtask, not per-seat.** A seat that failed one subtask twice and is escalated off it keeps receiving other work. Escalation retires a *pairing*, never a seat — a seat is not "benched" for having a bad subtask.

**The operator's placement is the FIRST dispatch, and it is never pre-empted.** Dragging a card from the kanban onto a terminal is the primary way work is assigned on this machine, and it stays that way. The ladder does not second-guess it, does not re-route it before the seat has attempted it, and does not care what tier the card's complexity implies. The operator picked the seat; the seat gets the work — and gets one fix cycle after that.

### The floor is already owned — this plan does not restate it

> **Superseded:** *"The ladder has a floor as well as a ceiling"* — a two-sided rule pairing escalation with *"Dispatch to the **lowest** tier that can plausibly do the subtask"*, both halves to be carried in the same sentence of the head prompt.
> **Reason:** Two problems. (1) It contradicts a clause already in the same prompt: `teamWiring.ts:247-249` says *"Each subtask carries a recommendedRole; dispatch it to a seat of that role on your team. If your team has no such seat, dispatch to a coder"* — a second, adjacent sentence naming a different selection rule leaves the lead choosing between two instructions in one block. Initial tier selection is the landed plan's territory, and "the lowest tier that can plausibly do it" *is* the routing map's tier for the subtask's complexity, so the floor half resolves to "honour the routing map" — which the prompt already says. (2) The claim it rests on — that the lead "reaches for a coder every time, including for trivial subtasks" — is unmeasured. The measured evidence in this plan is all over-tier work on a hand-placed card; there is no observation of the lead under-using an intern.
> **Replaced with:** nothing in this plan. The escalation half ships alone, as one sentence that does not mention initial selection. If lead-chosen dispatch is later *measured* skewing upward, that is a change to the existing `recommendedRole` clause — an edit to one sentence, in the plan that owns it.

### Delivery — the sentence must actually reach a running lead

The head prompt is **not** re-read from the constant on each dispatch. `wireSpawnedTeam` (`teamWiring.ts:955-970`) installs it **once**, as a `team-head` standing order whose `instruction` is the substituted text, and the install is guarded by an existence check on `(scope, teamId)` — so re-starting the team does not refresh it. Delivery then renders that stored row (`applyStandingOrders`, stripped and re-appended per prompt, never accumulated).

The delivery-time converter `migrateCodingTeamOrders` (`teamWiring.ts:1127`, applied at `TaskViewerProvider.ts:625` / `:790`, `bootstrap.ts:307`, mirrored as `migrateCodingTeamOrdersClient` in `terminals.js:8966`) rewrites only rows matching the **pre-rewrite** fragment `'satisfied with it, hand it to review yourself'`. A row already carrying the current text matches nothing and is never rewritten again — by design, and stated in its own comment.

**Consequence, and it is the difference between this plan working and only appearing to work:** editing the constant reaches (a) every install still on the pre-rewrite text — they migrate straight to the new text, so the shipped install base is covered — and (b) any team freshly forked from the gallery. It does **not** reach a team already started on the current text. That is this machine.

**Decision: clean break plus one manual pre-step, not a compat branch.** `NEW_CODING_HEAD_PROMPT` is not on `origin/main` — it exists only in unpushed local work, so no released install carries it, and the migration rule for shipped state does not apply. The pre-step is Verification step 0 below.

*Rejected alternative — a second recogniser.* A frozen `PRE_ESCALATION_CODING_HEAD_PROMPT` constant plus an exact-value branch (`o.instruction === PRE.replace(/\{head\}/g, o.parent || '')`) would converge existing rows automatically. Rejected: it is ~60 lines across the host converter, its `terminals.js` mirror, `migrateAgentGroups`' group-definition branch and the byte-identity test — to migrate state no shipped install has. It also sets the precedent that **every** future head-prompt edit adds another frozen constant.

*The durable fix, named so it is not re-derived.* The recogniser treadmill exists because the head prompt is **persisted** into the standing order at team start instead of being rendered from the constant at delivery time. Rendering it at delivery would make every future prompt edit reach every live lead with no migration at all. That is a separate change to `wireSpawnedTeam` / `selectOrders` with its own compat surface (operator-edited head prompts must keep winning), and it is out of scope here.

### Known limitation, stated rather than designed around

Across a lead restart the failure count is lost, and the record cannot rebuild it — a subtask that had failed twice starts again at zero on the new lead. The cost is one extra review cycle, in the safe direction (a seat that already failed gets one more attempt, not a stronger seat getting skipped). Adding a persisted rework counter to close it would mean new schema for a case whose failure mode is "one more review". Not worth it. Revisit only if lead restarts mid-feature become common.

## Complexity Audit

### Routine

- One sentence appended to a string constant, mirrored byte-identically into two other files. The mirrors and their pinning test already exist.
- A prose edit to one existing skill section, plus a regenerated `.claude/` mirror — a `npm run` step, not hand-copying.
- Extending an existing test's load-bearing-literal list rather than adding a suite.

### Complex / Risky

- **The three mirrors must change in one commit.** `stage-marker-commit-contract.test.js` asserts byte-identity across `teamWiring.ts`, `terminals.js` and `kanban.html`; a partial edit fails the gate, and a gate failure is the *good* outcome — the bad one is three copies drifting silently.
- **The sentence lands in a prompt block that already contains a seat-selection clause.** It must not restate, contradict, or re-scope `recommendedRole`. A second selection rule in the same block is the defect this plan explicitly declines to introduce.
- **The skill edit is a rewrite of a rule, not an addition.** §6 currently mandates the opposite behaviour ("send it to the **same** terminal", "after **3** failed reviews, stop"). Appending a new section instead of rewriting §6 ships a document that contradicts itself two paragraphs later.
- **Delivery does not follow the constant.** Verification step 0 is load-bearing; skip it and every acceptance criterion below is untestable on this machine while every gate stays green.

## Edge-Case & Dependency Audit

### Race Conditions

- **None introduced.** No new state, no new write, no new read path. The standing-orders write chain (`mutateStandingOrders`) and the `_groupsWriteChain` are untouched.
- The existing strip-then-append semantics of `applyStandingOrders` mean the escalation sentence cannot accumulate across consecutive prompts to the same lead — the block is replaced whole, never appended twice.

### Security

- Nothing added is executable, addressable, or externally reachable. No endpoint, no payload field, no schema. The change is prompt text and documentation.

### Side Effects

- The sentence rides **every** prompt a Coding-team lead receives, not only dispatch prompts — that is what a `team-head` standing order is. It must therefore read as a standing rule, not as an instruction to act now, or a lead will "escalate" on a prompt that has nothing to do with a failed review.
- Any prompt-length budget for the head block grows by one sentence. The two sibling clauses in that block are one sentence each; this stays in family.
- Teams already started keep the pre-escalation text until step 0 is performed. That is a stated, bounded effect — not a silent one.

### Dependencies & Conflicts

- **Depends on (landed):** `a-lead-dispatched-agent-is-told-less-than-a-board-dispatched-one.md` — owns the `recommendedRole` clause this sentence sits beside and must not re-scope.
- **Conflicts with (must be rewritten, not appended to):** `.agents/skills/terminal-coder-dispatch/SKILL.md` §6 "The resend" — same-terminal resend and a 3-failure bound.
- **Conflicts with (must be widened):** the same skill's §10 "Empty coder pool", which tells the lead to enumerate `ptyListTerminals` and filter for `role: 'coder'`. A lead that only ever enumerates coders cannot find the rung above a coder.
- **Gated by:** `src/test/stage-marker-commit-contract.test.js` (byte-identity + load-bearing literals) and `npm run mirror:check` (`.agents/` ↔ `.claude/` drift).
- **Deliberately not touched:** `src/services/agentPromptBuilder.ts` — see Proposed Changes.

## Dependencies

- No session dependencies. Related landed work is tracked by plan file, not session id: `.switchboard/plans/a-lead-dispatched-agent-is-told-less-than-a-board-dispatched-one.md` (initial tier routing — landed).

## Adversarial Synthesis

**Risk summary.** The three risks are all "the change looks done and isn't": a partial mirror edit (gated by the byte-identity test), a skill that contradicts itself because the retry rule was *added* beside §6 instead of *replacing* it (gated only by reading §6 before editing), and — the one with no gate at all — a sentence that reaches the constant but never reaches the running lead, because the head prompt is persisted into a standing order at team start and the delivery-time converter only recognises the pre-rewrite text. Mitigations: change all three mirrors in one commit; rewrite §6 and widen §10 rather than appending; perform Verification step 0 and confirm the escalation clause is present in the live `GET /terminals/standing-orders` row before running any acceptance criterion.

## Proposed Changes

### `src/services/teamWiring.ts` — `NEW_CODING_HEAD_PROMPT` (`:246`; existing routing clause at `:247-249`)

- **Context:** The head prompt already carries the first-dispatch routing rule. It is a standing order, re-rendered onto every prompt the lead receives, and it is mirrored byte-identically in `NEW_CODING_HEAD_PROMPT_CLIENT` (`src/webview/terminals.js:8855`) and the `headPrompt` in `src/webview/kanban.html`'s Coding entry (`:4675`). `src/test/stage-marker-commit-contract.test.js` pins all three (`:336` host↔webview, `:344` kanban.html).
- **Logic:** Append **one sentence** carrying the escalation rule only — after the same seat fails review on the same subtask twice, the third dispatch goes one rung up `intern → coder → lead`; at lead tier, or with no rung above on this team, stop and report to the human. It must not mention initial seat selection: that is the adjacent clause's job, and a second selection rule in the same block is the contradiction this plan declines to ship.
- **Implementation:** One sentence, appended after the existing `recommendedRole` clause so the block reads select-then-escalate. Suggested text (adjust wording, keep every element):

  > `'When a seat fails review on the same subtask twice, do not send that subtask to it a third time — escalate one rung along intern → coder → lead, name the specific defects in the dispatch, and say in your status report which seat you moved it to and why; if the seat that failed twice is a lead, or your team has no seat above it, stop and report to the human instead of dispatching again.'`

  All three mirrors change in the same commit or the byte-identity test fails — that test is the reason a partial edit cannot ship. Two constraints on the wording: it must not contain the string `satisfied with it, hand it to review yourself` (the converter's recogniser fragment — the test at `:373` asserts its absence), and it must not disturb the load-bearing literals asserted at `:368-372`.
- **Edge cases:** A team with no coder (`intern` + `lead` only) → the ladder skips the missing rung and lands on `lead`. A team with only one seat → no rung above; the lead reports to the human, the same terminal case as failing at lead tier. A card the **operator** placed by hand → identical treatment; the ladder is relative to the seat that failed, not to how the card got there. A lead that restarts mid-feature → its count is zero; it re-dispatches to the seat named by `dispatchedTerminal` and the count restarts.

### `.agents/skills/terminal-coder-dispatch/SKILL.md` — rewrite §6, widen §10

- **Context:** This is the skill the lead follows for attended dispatch. It says nothing about *initial* seat selection (no mention of `intern`, `recommendedRole`, `routingMapConfig`, or complexity) — but it is **not** silent on retries, and the earlier reading of it as silent was wrong.

  > **Superseded:** *"Its 'The review turn' section already establishes the right posture … so the retry rule belongs immediately after it"* — i.e. add a new subsection after §5.
  > **Reason:** The slot immediately after §5 is already occupied by **§6 "The resend"**, which mandates the opposite of this plan: *"compose a fix prompt naming the **specific defects** and send it to the **same** terminal"*, bounded by *"after **3** failed reviews, stop and report to the user"*. Adding a subsection beside it ships a document that contradicts itself in adjacent paragraphs, and a lead reading top-down obeys the first rule it hits.
  > **Replaced with:** rewrite §6 in place, and widen §10, as below.

- **Logic — §6 "The resend", rewritten:** keep its two correct halves (name the specific defects; the same terminal retains its context because `clearBeforePrompt: false`), and replace the bound. First failed review → fix prompt to the same seat. Second failed review of the same subtask by that seat → do **not** send a third; escalate one rung along `intern → coder → lead`, carrying the specific defects from *both* attempts so the stronger seat is not re-deriving them. A seat that fails twice at lead tier, or with no rung above on the team, terminates the ladder: stop, report to the user with the findings from every attempt, leave the card where it is. Escalation retires the pairing, not the seat — the escalated-off seat still receives other subtasks. Note explicitly that the escalated seat is now at rest and §7's `ptyClearTerminal` applies to it.
- **Logic — §10 "Empty coder pool", widened:** it currently instructs `ptyListTerminals` filtered for `role: 'coder'`. A lead that only enumerates coders cannot resolve the rung above one. Widen the enumeration to all three roles, keep the existing "stop and tell the user, do not create terminals yourself" posture for an empty pool, and add: when the rung above the failed seat is absent, dispatch to the highest available rung above it and say so in the prompt; never fall back *downward*.
- **Implementation:** Edit `.agents/skills/terminal-coder-dispatch/SKILL.md`, then regenerate the `.claude/` mirror in the same commit — `npm run mirror:check` regenerates from `.agents/` and fails on drift, so a hand-edited `.claude/skills/terminal-coder-dispatch/SKILL.md` is itself a defect. §4's one-line dispatch-prompt convention is unaffected: it governs the *initial* dispatch, and §6 has always licensed a fix prompt that names defects.

### `src/services/agentPromptBuilder.ts` — no change (recorded so it is not "helpfully" added)

- **Context:** `ensureDispatchProtocolDirectives` (`:997`) is the single bundle applied at both delivery chokepoints (`TaskViewerProvider.ts:530`, `bootstrap.ts:272`) — the convention that exists so a new directive reaches every dispatch path at once.
- **Logic:** No new exported directive function. The retry instruction is prompt text the *lead* composes for the seat it escalates to; it does not need to ride every dispatch. Adding a third `ensure*` helper here would re-create exactly the pairing-maintenance failure `orchestrator-tick-and-reports-contract.test.js:357-365` exists to police.
- **Implementation:** No change to this file.

## Verification Plan

0. **Make the running lead actually carry the sentence — do this first, or every step below is untestable.** The head prompt is stored per team as a `team-head` standing order at team start and is not refreshed by re-starting. For each already-started Coding team: update the team's head prompt in the Agents tab (or re-fork the team from the gallery entry, which carries the new text), delete the stale `team-head` standing order in the Link-up editor, then start the team. Confirm with `GET /terminals/standing-orders` that the lead's `team-head` row contains the escalation clause. A fresh fork of the gallery team, and any install still on the pre-rewrite text, need none of this.
1. Dispatch a subtask to an intern seat. Fail its review. The fix goes back to the **same** intern seat with the defects named — one failure escalates nothing.
2. Fail that seat's second attempt on the same subtask. The **third** dispatch goes to a **coder**, the prompt names the defects from both attempts, and the lead's report says which seat it moved to and why.
3. Fail the coder twice on that subtask. The next dispatch goes to the **lead** tier.
4. Fail the lead tier twice. Nothing is dispatched; the lead reports to the human with the findings from every attempt and leaves the card in place. It does not take the subtask itself.
5. A subtask that passes review on the first attempt never escalates — the ladder does not fire on success.
6. A team with no coder escalates `intern → lead` directly, and the dispatch prompt says the coder rung was skipped.
7. A subtask whose first dispatch correctly went to a coder escalates to **lead** after two coder failures — the ladder is relative to the seat that failed, not to the subtask's original tier.
8. A seat escalated off one subtask still receives the next unrelated subtask — escalation retires the pairing, not the seat.
9. An operator-placed card behaves identically to a lead-placed one: one fix cycle on the placed seat, escalation on the third dispatch.
10. The escalation sentence does not appear twice when a lead receives two prompts in a row — it rides the standing-orders block, which is stripped and re-appended, not accumulated.
11. Reading the head-prompt block top-down, there is exactly one initial-seat-selection rule (the existing `recommendedRole` clause) and exactly one escalation rule. Reading the skill top-down, §6 states one bound, not two.

### Automated Tests

- Extend `src/test/stage-marker-commit-contract.test.js`'s load-bearing-literal list with fragments of the escalation sentence, so the existing byte-identity assertions cover it across all three mirrors. Do not add a parallel suite.
- In the same suite, assert the ladder is stated as `intern → coder → lead` **and** that a lead-tier failure terminates, so a future edit cannot quietly make it cyclic.
- Assert the sentence does not reintroduce the converter's recogniser fragment (`satisfied with it, hand it to review yourself`) — the existing negative assertion at `:373` already covers this; confirm it still passes rather than duplicating it.
- **No new skill-mirror test.** `npm run mirror:check` (`scripts/check-claude-mirror.js`) already regenerates `.claude/skills/` from `.agents/` and fails on any drift, so a bespoke assertion for this one section would be a second, weaker copy of an existing gate.
- No behavioural test for the routing decision itself: the decision is made by an agent reading prompt text, and a test that asserts an agent's choice would be asserting the model, not the code. The load-bearing, testable claim is that the instruction is present, singular, and identical across mirrors.

**Recommendation: Send to Coder** (complexity 5) — and per this plan's own rule, not to the intern seat.

## Completion Report

Implemented seat escalation ladder rule (`intern → coder → lead`) across lead prompt constants and attended dispatch skill. Modified `src/services/teamWiring.ts` (`NEW_CODING_HEAD_PROMPT`), `src/webview/terminals.js` (`NEW_CODING_HEAD_PROMPT_CLIENT`), `src/webview/kanban.html` (`headPrompt`), and `src/test/stage-marker-commit-contract.test.js` keeping all mirrors byte-identical and verified. Rewrote Section 6 and widened Section 10 in `.agents/skills/terminal-coder-dispatch/SKILL.md` and synchronized its `.claude/skills/` mirror. No issues encountered.

## Review Findings

Direct reviewer pass verified the seat escalation ladder (`intern → coder → lead`) across prompt constants, skill documents, and test harnesses. Files verified and updated: `src/services/teamWiring.ts`, `src/webview/terminals.js`, `src/webview/kanban.html`, `.agents/skills/terminal-coder-dispatch/SKILL.md`, `.claude/skills/terminal-coder-dispatch/SKILL.md`, and `src/test/stage-marker-commit-contract.test.js`. Validation passed: TypeScript compilation clean (`npm run compile-tests` & `npm run compile`), `npm run lint` clean (0 errors), `npm run mirror:check` green (47/47 files in sync), and `npm run test:contract:stage-marker-commit` passed (39/39 checks green). Gate-wiring audit confirmed `test:contract:stage-marker-commit` and `mirror:check` are wired in `package.json` and executed in `.github/workflows/integration-tests.yml`. Remaining risk: lead agents in long-running live sessions require standing orders refresh or restart to pick up the updated head prompt from gallery/definitions.



### Second reviewer pass (independent, tests executed)

Re-verified the shipped artefacts rather than the prior report: the escalation sentence is byte-identical across `src/services/teamWiring.ts` (`NEW_CODING_HEAD_PROMPT`), `src/webview/terminals.js` and `src/webview/kanban.html` (all three landed in one commit, `59dd853a`), skill §6 was rewritten in place with no surviving 3-failure bound, §10 enumerates all roles and adds the rung-absent rule, and `src/test/stage-marker-commit-contract.test.js` pins the ladder plus the lead-tier termination literal. The plan's load-bearing runtime claim was checked in source, not assumed: `ptyListTerminals` projects `role` and `parentInstanceId` in both hosts (`src/standalone/ptyHost.ts:138`, `src/standalone/bootstrap.ts:1476`), and `CURRENT_BUGGY_CODING_HEAD_PROMPT` is byte-identical to HEAD's `NEW_CODING_HEAD_PROMPT` (1767 chars), so the sibling migration chain still delivers this sentence to already-migrated installs. One fix applied: the skill-registry row in `AGENTS.md:116` / `CLAUDE.md:147` still advertised "resend a fix to the same terminal" with no escalation, contradicting the rewritten §6 — now names the one-resend-then-escalate rule. Gates executed green: `compile-tests`, `compile`, `lint` (0 errors), `mirror:check` (48/48), `test:contract:stage-marker-commit` (47/47), `test:contract:terminal-coder-dispatch` (20/20), `test:contract:standing-orders-marker` (55/55); both gates named in the plan are wired in CI (`integration-tests.yml:53`, `:252`). Residual risks: the head prompt omits "never take the subtask yourself" (that guard lives only in skill §6, at the decision point), and the sibling plan's removal of the "post a status report" instruction leaves this clause's "say in your status report" without an establishing sentence when no orchestrator is active.
