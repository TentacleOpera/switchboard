# A lead must never sleep to wait for its coders — it is woken, and nothing tells it so

## Goal

Tell the team lead, on every surface where it learns how to wait, that a coder finishing
wakes it with a prompt — and that sleeping, polling, or otherwise burning its turn waiting is
forbidden. The wake already works; the lead just does not know it can rely on it.

### The problem

Team leads set their own sleep timers to decide when their coders have finished. It is
pointless work: the system delivers the completion to the lead's terminal. It is also
actively harmful — a sleeping agent is spending its turn and its context on a wait that has
already been engineered away, and the wake it is sleeping through is the very thing it is
waiting for.

### Root cause — the wake is guaranteed, and never stated as a guarantee

Every completion path already prompts the lead:

- **The `queue/done` relay.** `LocalApiServer.ts:3441` and `:5653` build a `[queue/done] <seat>
  reports its dispatched task complete` message and deliver it to the head by `ptySendPrompt`,
  carrying `TURN_END_VERIFY_INSTRUCTION` and `composeAcceptanceInstruction`.
- **The turn-end notice.** `composeCompletedTurnEndBody` (`PlanIngestionEngine.ts:2632`) fires
  the `[switchboard:turn-end] Seat 'X' finished its turn on 'Y'` line with its evidence
  clauses.
- **The coder's own report.** `CONTEXT_AWARE_COMPLETION_ORDER_BODY` step 3 (`teamWiring.ts:181`)
  has the coder `ptySendPrompt` the head directly when the primary route does not apply.
- **The queue watch backstop.** Arms on dispatch and nudges the lead if it goes idle with
  staged cards.

So a lead has at minimum one, usually two, inbound prompts per coder completion. **It cannot
miss one by not looking, and there is nothing to look at.**

What the lead is told varies by surface, and neither surface closes the loop:

- **`NEW_CODING_HEAD_PROMPT`** (`teamWiring.ts:639`) — its durable standing order — says *"When
  a coder reports a subtask finished, note it and dispatch the next subtask…"*. It describes
  what to do **when** a report arrives and never says a report is guaranteed to arrive, never
  says how it arrives, and never says what to do in the meantime.
- **`_buildDrivePrefix`** (`KanbanProvider.ts:5687`) gets closer — *"Standing orders: callback
  contract is installed on all workers — they report to you on completion. Do not re-register."*
  and *"FEATURE WATCH: Armed by the system. You will be nudged if you go idle… No action
  needed."* — but that is the drive-mode surface only, it addresses re-registration rather than
  waiting, and it still never prohibits polling.

Neither surface contains the word `sleep`, nor any prohibition on polling. A `grep -rniE
'\bsleep\b|do not poll|busy.?wait'` across `.agents/protocols/`, `.agents/skills/`,
`teamWiring.ts` and `agentPromptBuilder.ts` returns nothing relevant.

**An instruction that says "when X happens, do Y" leaves "how do I know X happened?" open, and
a capable agent answers it the way it knows how: it waits and checks.** The absence of a
stated guarantee is read as the absence of a guarantee. This is the same failure mode as the
already-planned verify-before-trust waste in
`feature_plan_20260821090653_team-lead-redundant-port-and-terminal-name-checks.md`: the lead is
not misbehaving, it is filling a gap the prompt left.

### Why a prohibition alone is not enough

"Do not sleep" without "because you will be woken" invites the lead to find another way to
check — a `ptyListTerminals` poll, a `git log` loop, a board read. The instruction has to be a
matched pair: **the guarantee first, the prohibition second.** State what happens, then state
that nothing else is needed.

## Implementation

### 1. Add the wake guarantee and the prohibition to the head's standing order

Extend `NEW_CODING_HEAD_PROMPT` (`teamWiring.ts:639`), in the region that already covers
dispatch and rotation, with a short paired statement: a coder finishing delivers a prompt into
this terminal; the lead does not need to check, wait, or watch for it; it must not sleep, poll,
loop, or run any timer to find out — it ends its turn after dispatching and the next completion
starts a new one.

Constraints:

- **Three byte-identical copies.** `teamWiring.ts` (`NEW_CODING_HEAD_PROMPT`), `terminals.js`
  (`NEW_CODING_HEAD_PROMPT_CLIENT`), `kanban.html` (Coding `headPrompt`).
  `coding-head-prompt-contract.test.js` reassembles all three and asserts byte-identity.
- **Preserve every literal** pinned by `stage-marker-commit-contract.test.js:386-400`, and add
  no form of the word "advance" (`!/advanc/i`), no `targetColumn`, no `/kanban/dispatch`.
  **Clarification — why these are forbidden:** these literals are load-bearing for stage-marker
  parsing. The `stage-marker-commit-contract` test pins them because they appear in commit
  trailers and card-movement recognisers; adding them to the head prompt would make the prompt
  text match a recogniser that could rewrite it, or would confuse the stage-marker parser about
  whether the prompt is describing a card move. A coder who understands *why* can write the
  guarantee text naturally without tripping the constraint.
- **No migration.** `headPrompt` is stored per agent group in the DB
  (`agentGroupInstantiation.ts:136`), so the source constants govern newly created teams only —
  which would normally require a `migrateAgentGroups` step. It does not here: the team/lead
  feature has only ever existed in unreleased dev work, so it takes a clean break. A dev team
  carrying the old prompt is recreated, not migrated. Do not add a recogniser for text that
  never shipped.

### 2. Say it in the drive prefix too

`_buildDrivePrefix` already has a `RULES:` list. Add one rule there in the same voice as its
neighbours, and extend the existing `FEATURE WATCH: … No action needed.` line so the "no action
needed" explicitly includes not waiting for it. The drive prefix is composed per dispatch rather than
stored, so this half needs no team recreation at all — it takes effect on the next run.

> **Clarification — drive prefix test coverage.** The drive prefix IS covered by an automated
> contract test: `drive-mode-prompt-overhaul-contract.test.js` asserts specific strings in the
> prefix (including `'FEATURE WATCH: Armed by the system'`). Any new rule added to the `RULES:`
> list or extension to the `FEATURE WATCH` line must be verified against this test — add
> assertions for the new text alongside the existing ones.

> **Candidate text — head prompt (step 1).** A starting point for the text to add to
> `NEW_CODING_HEAD_PROMPT`, in the region covering dispatch and rotation. The coder must verify
> it against the byte-identity test and the pinned-literal constraints; this is a candidate, not
> a final draft:
>
> *"When a coder finishes its turn, the system delivers a completion prompt into this terminal —
> you do not need to check, wait, or watch for it. Do not sleep, poll, loop, or run any timer to
> find out whether a coder is done. Dispatch what is dispatchable, close out what is closable,
> and end your turn. An idle lead is the correct resting state, not a failure."*
>
> **Candidate text — drive prefix rule (step 2).** A rule for the `RULES:` list, in the voice of
> its neighbours:
>
> *"COMPLETION WAKE: The system delivers a coder's completion into this terminal. Do not sleep,
> poll, or run a timer to wait for it — end your turn after dispatching and the next completion
> starts a new one."*
>
> And the extended `FEATURE WATCH` line:
>
> *"FEATURE WATCH: Armed by the system. You will be nudged if you go idle with staged cards. No
> action needed — do not wait for it, do not poll for it."*

### 3. Say what to do with the turn instead

The prohibition creates a question — *if I am not waiting, what am I doing?* — and an
unanswered question is what produced the sleep in the first place. State the answer in the same
breath: dispatch what is dispatchable, close out what is closable, and end the turn. An idle
lead is the correct resting state, not a failure. This matters most in unattended runs, where
the drive prefix already tells the lead *"never convert uncertainty into a stop"* — ending a
turn because there is nothing to do is not a stop, and the text must not let the two be
confused.

## Verification Plan

1. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/coding-head-prompt-contract.test.js`
   — all invariants pass, in particular the three-way byte-identity check.
2. `src/test/stage-marker-commit-contract.test.js` — the pinned load-bearing literals still
   resolve. Note this suite currently reports 2 pre-existing failures on an unmodified tree
   (a raw-`getConfigJson` reader-count assertion and a migration no-write assertion); compare
   against that baseline rather than expecting zero.
3. New assertions: the head prompt states that a completion is delivered to the lead; the head
   prompt forbids sleeping/polling; the drive prefix carries the matching rule.
4. `npx tsc --noEmit -p tsconfig.json`.
5. Confirm a team created before this change still runs — it keeps the old prompt (no migration
   by design) and must not error; recreating the team picks up the new text.
6. Manual, both hosts: run a feature with two subtasks and confirm the lead dispatches, ends its
   turn, is woken by the coder's completion, and at no point issues a sleep, a timer, or a poll
   loop. Check the terminal log for the absence of those calls rather than trusting the lead's
   own account.

### Goal Invariants

- **Positive:** `NEW_CODING_HEAD_PROMPT` in `teamWiring.ts` contains the word "sleep" in a
  prohibition context (e.g. "do not sleep") — `grep -c 'sleep' teamWiring.ts` on the
  `NEW_CODING_HEAD_PROMPT` constant returns ≥ 1.
- **Positive:** `NEW_CODING_HEAD_PROMPT` contains a statement that a coder's completion is
  delivered to the lead's terminal (e.g. "delivers a completion prompt into this terminal").
- **Negative:** `NEW_CODING_HEAD_PROMPT` does NOT contain any form of "advance"
  (`!/advanc/i`), `targetColumn`, or `/kanban/dispatch` — these are forbidden by
  `stage-marker-commit-contract.test.js`.
- **Positive:** The three copies of the head prompt (`teamWiring.ts`
  `NEW_CODING_HEAD_PROMPT`, `terminals.js` `NEW_CODING_HEAD_PROMPT_CLIENT`, `kanban.html`
  `headPrompt`) are byte-identical — `coding-head-prompt-contract.test.js` passes.
- **Positive:** `_buildDrivePrefix` output contains a rule prohibiting sleeping/polling/waiting
  for coder completion — `drive-mode-prompt-overhaul-contract.test.js` passes with the new
  assertion.

## Complexity Audit

### Routine
- Adding a paired guarantee + prohibition to a string constant in three byte-identical copies.
- Extending the drive prefix `RULES:` list and `FEATURE WATCH` line with one rule each.
- No migration — teams are unreleased dev work, so a clean break applies.

### Complex / Risky
- **Three byte-identical copies** — `teamWiring.ts`, `terminals.js`, `kanban.html` must all
  carry the same text. The `coding-head-prompt-contract.test.js` test reassembles all three and
  asserts byte-identity. A single-byte mismatch in any copy fails the test.
- **Pinned-literal constraints** — the `stage-marker-commit-contract.test.js` test pins
  load-bearing literals and forbids `advance`/`targetColumn`/`/kanban/dispatch`. The new text
  must not trip these recognisers.
- **Shared surface with `team-lead-escalation-dead-end-recovery-ladder.md`** (not part of this
  feature) — both edit `NEW_CODING_HEAD_PROMPT` and the same contract test. Coordinate to
  avoid merge conflicts in the three copies.

## Edge-Case & Dependency Audit

- **Race Conditions:** None — prompt text is static, not stateful.
- **Security:** None — no new auth surface or data exposure.
- **Side Effects:** A team created before this change keeps the old prompt (no migration by
  design). It must not error; recreating the team picks up the new text. The drive prefix
  change takes effect on the next dispatch (composed per run, not stored).
- **Dependencies & Conflicts:** `team-lead-escalation-dead-end-recovery-ladder.md` (not part of
  this feature) also edits `NEW_CODING_HEAD_PROMPT`. Both are clean text edits with no
  migration, but they share the three byte-identical copies and the same contract test —
  coordinate them to avoid merge conflicts.

## Dependencies

- `coding-head-prompt-contract.test.js` — asserts three-way byte-identity of the head prompt.
  Must pass after the text change.
- `stage-marker-commit-contract.test.js` — pins load-bearing literals and forbids
  `advance`/`targetColumn`/`/kanban/dispatch` in the head prompt. Has 2 pre-existing failures
  on an unmodified tree; compare to that baseline.
- `drive-mode-prompt-overhaul-contract.test.js` — asserts specific strings in the drive prefix.
  Must pass after the drive-prefix rule addition; add new assertions for the wake rule.
- `team-lead-escalation-dead-end-recovery-ladder.md` (not part of this feature) — also edits
  `NEW_CODING_HEAD_PROMPT`. Coordinate to avoid merge conflicts.

## Adversarial Synthesis

Key risks: (1) the three byte-identical copies make a text change trivial in concept but
miserable in execution — a single-byte mismatch in any copy fails the contract test; (2) the
pinned-literal constraints could trip on the new text if the coder writes naturally without
checking against `stage-marker-commit-contract.test.js`; (3) the shared surface with
`team-lead-escalation-dead-end-recovery-ladder.md` creates a merge-conflict risk in the three
copies. Mitigations: candidate text is provided for both surfaces, the forbidden literals are
explained, and the drive-prefix test coverage is identified so the coder knows where to add
assertions.

## Metadata

**Feature:** 25e6a03f-26a5-444d-8089-43368af27bcd
**Complexity:** 3
**Tags:** backend, reliability, refactor

## Implementation Summary

Added paired wake guarantee and sleep/poll prohibition to `NEW_CODING_HEAD_PROMPT` across all three byte-identical copies (`teamWiring.ts`, `terminals.js`, `kanban.html`). Updated `_buildDrivePrefix` in `KanbanProvider.ts` to include the `COMPLETION WAKE` rule in `RULES:` and extended the `FEATURE WATCH` line to forbid waiting or polling. Added contract assertions in `coding-head-prompt-contract.test.js` and `drive-mode-prompt-overhaul-contract.test.js` verifying the wake guarantee and prohibition across prompts and drive prefixes.

## Review Findings

No code changes were required for this subtask. The paired wake guarantee and sleep/poll prohibition are present in all three byte-identical copies of `NEW_CODING_HEAD_PROMPT` (`src/services/teamWiring.ts:632`, `src/webview/terminals.js:11503`, `src/webview/kanban.html:4822`), the drive prefix carries the matching `COMPLETION WAKE` rule and the extended `FEATURE WATCH` line (`src/services/KanbanProvider.ts:5900`, `:5915`), and step 3's "what to do with the turn instead" is answered in the same breath rather than left open. Both contract suites were extended with real assertions rather than weakened, and no migration code, recogniser or frozen snapshot constant was added — correct, since teams are unreleased dev work. Verification: `test:contract:coding-head-prompt` ALL PASSED including the three-way byte-identity check and the new wake assertion; `test:contract:drive-mode-prompt-overhaul` PASSED with its new `COMPLETION WAKE` and `FEATURE WATCH` assertions; `stage-marker-commit-contract` at its documented 41 passed / 2 failed baseline with no new failures; the negative constraints hold (no `/advanc/i`, no `targetColumn`, no `/kanban/dispatch` in the new text); `tsc --noEmit` clean apart from 5 pre-existing TS2835 errors in untouched files. Remaining risk: the goal is behavioural — whether a lead actually stops setting sleep timers is only observable in a live two-subtask run, which no automated check can discriminate.

## Deferred Findings

- NIT — Step 6's manual verification (run a feature with two subtasks and confirm the lead never issues a sleep, timer or poll loop, checking the terminal log rather than the lead's own account) was not executed in this review pass. The suites that pass assert the prompt TEXT, not the lead's behaviour. `.switchboard/plans/a-lead-must-never-sleep-to-wait-for-its-coders.md:1`
- NIT — Shared-surface coordination with `team-lead-escalation-dead-end-recovery-ladder.md`, which also edits `NEW_CODING_HEAD_PROMPT`, remains outstanding; both edits touch the same three byte-identical copies and the same contract test. `src/services/teamWiring.ts:629`
