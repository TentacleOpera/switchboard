# Mission Control's hard-skip escalation must spend a bounded recovery budget first

## Goal

Give the Mission Control orchestrator a bounded, on-disk recovery ladder before a stalled
subtask becomes a permanent hard skip, and let an escalation raised for want of an answer
be un-skipped when the answer lands. Preserve the anti-loop guarantees that the current
terminal rules exist to provide — this is an unattended overnight persona, so every added
retry must be a budget spent from disk, never a judgement call a cleared context re-makes.

### The problem

The orchestrator has the same failure shape as the coding-team lead
(`.switchboard/plans/team-lead-escalation-dead-end-recovery-ladder.md`): a rule that ends
in "stop" with cheap recovery untried. It reaches that stop by two independent paths, both
in `.agents/protocols/switchboard-mission-control/SKILL.md`:

1. **Stall counter (`:526-534`).** "no new commits across two consecutive checks -> escalate
   as a stalled agent… At `stallCount >= 3`, escalate in the session log and **stop
   re-dispatching that subtask**." The counter keys purely on branch-tip SHA and card
   column. Nothing is diagnosed before the subtask is retired.
2. **Escalation permanence (`:459-462`).** "An escalated item must stay escalated. With no
   memory, the only way the tick knows is the log — so an escalation entry names the planId
   or feature, and the tick treats a logged escalation as **a hard skip for that item for
   the rest of the session**."

Both are terminal, and together they mean a subtask can be retired at ~30 minutes into an
overnight run and stay retired until 6am, whatever changes on disk afterwards.

### Root cause

**The item is retired when what is actually exhausted is one attempt path.** Three specific
consequences:

- **A stall is counted without ever looking at the seat.** No commits is the observable for
  at least four different states: a lead sitting on a question, a lead that ran out of
  context, a lead whose terminal died, and a lead genuinely making no progress. Only the
  last is a stall. The protocol already knows this — the turn-end branch (`:413`) says
  "check the terminal. If it is asking a question, answer it or escalate. If it crashed or
  ran out of context, re-dispatch the work to the same lead" — and `GET /terminals/<name>/log`
  exists to do it (`LocalApiServer.ts:8102`). **These two rules contradict each other
  today**, and the stall rule wins because it is the one that terminates.
- **Context exhaustion is never treated as recoverable, in the one persona built entirely
  around that idea.** The orchestrator clears its own context every tick and explains at
  length why (`## Context Is Cleared Every Tick`), citing `clearBeforePrompt`
  (`src/standalone/ptyPromptDelivery.ts:32`, `ptyHost.ts:248`). It never applies the same
  remedy to a lead that has gone quiet.
- **Escalation has one kind, so it must be permanent.** "Blocked by an unresolvable merge
  conflict" and "blocked because I did not know the answer" are recorded identically, so
  the hard skip has to be absolute to be safe. The second kind is resolvable — the human
  answers in the plan file at 2am — and nothing can act on that.

### Why the current rules are nonetheless right to exist

The hard skip is not sloppiness; it is the correct consequence of a cleared context. With
no memory, "have I already retried this?" is unanswerable except from disk, and an
unattended persona that re-derives that judgement every tick will re-dispatch forever. Any
fix that relies on the orchestrator *deciding* to try again is a regression. This plan
therefore adds **budgets recorded in `progress.json`**, not latitude.

The unattended cost model also differs from the lead's, and constrains the design:

- A loop overnight burns real budget with nobody watching.
- Re-dispatching into a shared per-feature worktree can destroy uncommitted work.
- A wrongly un-skipped item competes with the merge-back lane for the same worktree.

So: at most **two** extra dispatches per plan per session, each recorded on disk before it
is spent, and never into a dirty tree.

## Implementation

All changes are to **one file**: `.agents/protocols/switchboard-mission-control/SKILL.md`.
Confirmed single-source — `grep` for `stallCount`/`stay escalated`/`hard skip` finds no
other copy, and `agentPromptBuilder.ts:1598-1616` redirects every legacy alias
(`.agents/workflows/switchboard-orchestrator.md`,
`.agents/skills/switchboard-orchestrator/SKILL.md`,
`.switchboard/protocols/switchboard-orchestrator/SKILL.md`) to this path. Unlike the coding
head prompt, there is no byte-identical webview copy and no DB-stored per-install value.

### 1. Extend the `progress.json` schema with the recovery budget

Current shape (`:463-467`): `{ [planId]: { branch, lastSeenSha, stallCount } }`.

Add three fields, all defaulting to absent/false so an existing file from a running session
stays valid and a partially-migrated file is not a failure mode:

- `seatCheckedSha` — the branch-tip SHA at which the seat's terminal was last read. Stops a
  cleared context from re-reading the same terminal every tick.
- `clearRetryUsed` — the clear-and-re-dispatch rung has been spent for this plan.
- `handoffUsed` — the hand-to-another-lead rung has been spent for this plan.

State the invariant explicitly in the persona: **a rung is written to `progress.json` before
the dispatch that spends it, not after.** A crash between dispatch and write must lose the
retry, not duplicate it — the same append-at-the-moment-of-action rule the log already has
(`:481-484`).

### 2. Diagnose before counting a stall

Amend the stall-detection bullet (`:526-534`). Before `stallCount++`, read the seat's
terminal via `GET /terminals/<name>/log` and branch:

- **Asking a question** → answer it if known, else escalate as `awaiting-input` (kind 2
  below). Do not increment; a lead waiting on an answer is not stalled.
- **Crashed, exited, or out of context** → this is the existing "re-dispatch the work to the
  same lead" case (`:413`) and it is not a stall either. Take rung A below.
- **Alive and working, no commits** → increment, as today.

Cross-reference the turn-end branch explicitly so the two rules read as one rule, and state
which wins. Today's contradiction is the bug.

### 3. Recovery ladder before the hard skip

Replace "At `stallCount >= 3`, escalate in the session log and stop re-dispatching that
subtask" with a ladder. Keep the literal `stallCount >= 3` — the threshold does not move,
only what happens when it is reached — because
`mission-control-tick-and-reports-contract.test.js:122` asserts `/stallCount\s*>=\s*3/`.

At `stallCount >= 3`, take the first rung whose budget is unspent, write the budget flag
first, log the rung, and reset `stallCount` to 0 so the new attempt gets a fresh window:

- **Rung A — clear and re-dispatch to the same lead, once** (`clearRetryUsed`). Deliver via
  `ptySendPrompt` with `clearBeforePrompt: true`, naming the subtask and what has not
  progressed. A cleared seat is a new attempt, not a fourth silent tick.
- **Rung B — hand the subtask to a different live lead whose team is idle, once**
  (`handoffUsed`). Resolve candidates from `ptyListTerminals` (`status`, `lastDataAt`,
  `parentInstanceId`). Skip this rung when no other lead exists rather than waiting for one.
- **Rung C — escalate as `blocked` and hard skip**, exactly as today.

**Hard preconditions on rungs A and B, stated as such:**

- Never spend a rung when the feature's worktree is dirty (`git status --porcelain`
  non-empty) or carries `MERGE_HEAD`. The persona already treats a dirty tree as
  "do not advance" (`:524`); make it "do not re-dispatch" too. Escalate as `blocked` instead
  — re-dispatching into a dirty shared checkout is the one recovery that can destroy work.
- Never spend a rung on an item the merge-back lane is currently working.
- Never spend a rung on a plan that was never dispatched this session — no commits on an
  undispatched plan is expected, not a stall. Dispatch it normally instead.

### 4. Two kinds of escalation

Rewrite `:459-462` so escalation records a kind, and only one kind is permanent:

- **`blocked`** — needs a human and cannot proceed (unresolvable merge conflict after
  `git merge --abort`, missing worktree or terminal, contradictory plan, recovery budget
  exhausted). **Hard skip for the rest of the session — unchanged.**
- **`awaiting-input`** — escalated only because the orchestrator lacked an answer. The log
  entry names the planId **and one on-disk condition that would resolve it** (the plan
  file's mtime advancing past the escalation timestamp, or a named section appearing in it).
  The tick hard-skips the item **until that condition flips**, then un-skips it once and
  logs the resumption.

The re-check must be **one cheap on-disk read per escalated item per tick** — a `stat`, not
a re-derivation — so it stays inside the cleared-context contract: the condition lives on
disk, exactly like the stall counter, and the tick never decides from memory whether to
retry. Cap resumptions at one per item per session so an item cannot oscillate.

Keep the surrounding justification prose intact: the reason escalations are logged at all is
that a cleared context has no other memory, and that reasoning still holds — it is the
*number of kinds*, not the mechanism, that was wrong.

### 5. Session-log entries name the rung

Mirror the lead-side change: every recovery action writes which rung it took and why, so the
human's "what happened overnight" record distinguishes "retired after a full ladder" from
"retired on the first stall". Add `blocked` / `awaiting-input` to the final summary
(`## Session Completion`), which currently reports only "escalations outstanding".

## Verification Plan

1. `node --require ./src/test/bootstrap/sandboxStateHome.js src/test/mission-control-tick-and-reports-contract.test.js`
   — passes, in particular the two assertions at `:120-122` that the persona still names
   `progress.json` and still carries the `stallCount >= 3` threshold.
2. Add contract assertions to that test: the persona names both escalation kinds; the
   `blocked` kind is still described as a hard skip for the session; the persona names
   `clearBeforePrompt` in the recovery ladder; the persona no longer contains the bare
   fragment `escalate in the session log and stop re-dispatching that subtask`; the dirty-tree
   precondition is present.
3. Dry-run the ladder against a scratch `progress.json`: confirm each budget flag is written
   before its dispatch, that a second tick reading the same file spends no rung twice, and
   that a file lacking the three new fields is read without error.
4. Simulate an `awaiting-input` escalation: log one, confirm the next tick skips the item,
   then advance the plan file's mtime and confirm the following tick resumes it exactly once.
5. Simulate a dirty worktree at `stallCount >= 3` and confirm the ladder is skipped entirely
   in favour of a `blocked` escalation.
6. **Delivery check, extension host.** `src/extension.ts:4350-4400` refreshes every bundled
   `.agents/` file into the workspace by content hash — copy if absent, overwrite iff the
   hashes differ — so an edited persona reaches existing installs on activation with no
   migration. Verify against a workspace holding an older copy.
7. **Delivery check, standalone host — the open question in this plan.** The content-hash
   refresh loop exists **only in `src/extension.ts`**; `grep` for `crawlDirectory` /
   `shouldRefreshAgentWorkspaceFiles` finds no standalone equivalent, and standalone does
   launch Mission Control against this file (`bootstrap.ts:3168-3200`: "the terminal reads
   switchboard-mission-control/SKILL.md"). Determine how a standalone-only workspace obtains
   and refreshes `.agents/`. If it never refreshes, the persona edit does not reach those
   users and this is a composition-root divergence of exactly the class CLAUDE.md describes
   — a delivery seam wired in one root only. Fix it here or split it out as its own plan;
   do not ship this plan believing it reached standalone until this is answered.

## Metadata

**Complexity:** 5
**Tags:** reliability, backend
