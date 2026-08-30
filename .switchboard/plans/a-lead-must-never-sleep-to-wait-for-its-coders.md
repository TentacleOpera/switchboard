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
- **Migrate stored prompts.** `headPrompt` is stored per agent group in the DB
  (`agentGroupInstantiation.ts:136` passes `group?.headPrompt`); the source constants govern
  newly created teams only. Add a surgical `migrateAgentGroups` step in the same shape as the
  one in `team-lead-escalation-dead-end-recovery-ladder.md` — anchor on an existing unique
  substring, insert the new text, leave a customised prompt alone, and stay idempotent. If both
  plans are in flight, land one migration step that carries both edits rather than two passes
  fighting over the same anchor.

### 2. Say it in the drive prefix too

`_buildDrivePrefix` already has a `RULES:` list. Add one rule there in the same voice as its
neighbours, and extend the existing `FEATURE WATCH: … No action needed.` line so the "no action
needed" explicitly includes not waiting for it. The drive prefix is not stored per install, so
this half needs no migration and ships immediately.

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
4. Migration unit test: a group carrying the pre-edit prompt is rewritten; a customised prompt
   is untouched; a second pass writes nothing; unknown keys survive.
5. `npx tsc --noEmit -p tsconfig.json`.
6. Manual, both hosts: run a feature with two subtasks and confirm the lead dispatches, ends its
   turn, is woken by the coder's completion, and at no point issues a sleep, a timer, or a poll
   loop. Check the terminal log for the absence of those calls rather than trusting the lead's
   own account.

## Metadata

**Complexity:** 3
**Tags:** backend, reliability, refactor
