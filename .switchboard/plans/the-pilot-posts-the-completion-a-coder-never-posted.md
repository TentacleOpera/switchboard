# The Pilot Posts the Completion a Coder Never Posted

**Feature:** cb1ea29b-cfb2-4ffc-8bfa-731e862d6f09

## Goal

When a coder has written its work and never posted the completion, the Pilot
posts it, attributed to the controller. The card then follows the ordinary
route — the lead is notified and reviews the diff — instead of sitting owned and
uncompleted while every card behind it waits.

### Problem analysis

**This is the most common failure on the board, and the current remedy does not
address it.** Completion posts are not enforced; they are prompted. An agent that
finishes its work and never runs `submit` leaves a card owned, uncompleted, and
blocking every dependent behind it. Row 10 of the matrix
(`src/standalone/controller/matrix.ts:306`) already detects it, and its own
comment records the scale: *"The most frequently hit case on the board and
nothing detected it."*

**Row 10 fires precisely on the case a prompt cannot fix.** Its evidence is
*"a prior `finished` before owner_since, none after; worktree written this round;
seat at rest"*. Read that as a scenario: the agent posted correctly on an earlier
round, then did the work for this round, wrote files, and stopped without
posting. The overwhelmingly common cause is that it ran out of context. The
current remediation, `ask-completion-post`, sends that agent a prompt asking it
to do the thing it just failed to do — and on a second pass sends the lead a
message saying nothing has been completed. Neither moves the card.

**The code's stated objection, and why it is overruled.** The remediation arm at
`src/standalone/controller/controller.ts:1833` says:

> *"A prompt, never an auto-complete. Row 1 may mark a card complete because the
> coder ASSERTED `finished` and the board is only recording an assertion that
> already exists. Here nobody has asserted anything, so completing the card would
> be the controller inventing a claim about work it cannot verify — and a wrong
> completion is materially worse than a late one."*

The last clause is the load-bearing one and it is false in this product. **A
wrong completion costs one lead redispatch.** Completion routes the card into
review; the lead never takes a coder at its word and reads the diff regardless,
so a card completed prematurely is bounced back and re-dispatched. A *missing*
completion costs the whole pipeline: the card never advances, its dependents
never unblock, and the mission halts. The asymmetry runs the opposite way to what
that comment assumes, and this change inverts the remediation to match.

> **Superseded:** `ask-completion-post` — prompt the coder, then the lead, and
> complete nothing.
> **Reason:** the agent being prompted is by hypothesis out of context, which is
> why it did not post. The comment's justification rests on "a wrong completion
> is materially worse than a late one", which is untrue here: a wrong completion
> is caught by the lead's review and redispatched, while a late one stalls every
> dependent card.
> **Replaced with:** `post-completion-on-behalf` — the controller posts the
> completion, attributed to itself, and the card follows the ordinary route.

**This is state repair, not the Pilot doing the coder's job.** The work exists:
files were written this round, which is row 10's own evidence. What is missing is
the *record* of it. The Pilot makes the state machine agree with what is on disk.
It does not write code, judge whether the work is any good, or decide what
happens next — the lead still does all three. That boundary is what separates
this from the controller taking over, and it is why the remediation is a post and
nothing more.

**There is nothing to reconstruct, because the post carries nothing.**
`cmdSubmit` (`src/standalone/cli.ts:2663`) takes no positional argument and no
summary; its own comment states the rule — *"the same rule as no summaries,
applied to the fields instead of the prose."* A completion is a signal, not a
report. So posting on a coder's behalf is issuing the identical bare call, with
no content invented and no judgement exercised. Any design that has the
controller assemble a summary from a log tail is out of scope and is the line
between repair and takeover.

**Who posted it must be recorded, and the wire field is not the place.**
`/kanban/queue/done` takes `{ from, outcome }`, where `from` is the seat whose
work it is. If the controller posts with `from: <coderSeat>` and nothing else,
the board records a submit indistinguishable from the coder's own — and the
defect being fixed becomes invisible. "How often do agents fail to post" is the
measure of the underlying problem, and it must survive the remedy. It is also
what tells the lead whether anyone actually claimed the work was done.

## Metadata

**Tags:** backend, reliability, bugfix, api
**Complexity:** 5
**Scope:** `src/standalone/controller/matrix.ts` (row 10's remediation; the
`MatrixRemediation` type and the `MATRIX_REMEDIATIONS` values array),
`src/standalone/controller/controller.ts` (the remediation arm at ~1833),
`src/services/LocalApiServer.ts` (`/kanban/queue/done` accepts and records the
posting actor). Row 10's **evaluator and evidence are unchanged** — this plan
changes what happens on a detection, not what counts as one.
**Standalone only.** The extension host is out of scope.

## User Review Required

- After this lands the controller can complete cards. That is the intended
  authority and it is bounded by row 10's evidence: a prior `finished`, writes
  this round, seat at rest. It cannot fire on a card that was never worked.
- A card completed by the controller reaches the lead exactly as a coder's
  submit does, but labelled with who posted it. The lead's review is the
  correctness gate, and it always was.

## Complexity Audit

### Routine
- Changing row 10's `remediation` string.
- A new arm in the remediation switch, modelled on `mark-complete` (~1676).

### Complex / Risky
- **`MatrixRemediation` is a runtime-validated closed set.** A new verb must be
  added to **both** the type union and the `MATRIX_REMEDIATIONS` values array
  (`matrix.ts:102`). The file's own comment records the failure of doing only
  one: *"a hand-written `matrix.json` naming a remediation … that does not exist
  parsed, loaded, and then fell through the controller's `switch` at wake time
  and did nothing — a rule that is silently ignored at 3am."*
- **Double-post.** The coder may wake and submit after the controller already
  did. The second submit must be a no-op, not a second completion or an error
  that strands the seat.
- **Attribution without a second identity mechanism.** The actor must be
  recorded without turning `from` into something that can be forged — this lands
  alongside `a-seats-identity-has-one-source`, which removes the CLI's `--from`,
  and must not reintroduce the same defect at the HTTP layer.

## Edge-Case & Dependency Audit

- **Race Conditions.** The coder posting between the controller's detection and
  its post. The post is idempotent: a card already carrying `completed_at` is a
  no-op reported as such. Row 10's evaluator already requires the seat to be at
  rest (`lastDataAt` older than `turnEndSilenceMs`), so mid-turn cards do not
  reach this arm.
- **Security.** The controller gains the ability to complete cards. It is
  bounded by the row's evidence and it is **attributed** — it does not and must
  not impersonate the seat. It posts as itself, naming the seat whose work it is.
- **Side Effects.** A completion advances the card into the review route and
  notifies the lead. That is the intent. `owner_since` is untouched, exactly as
  `mark-complete` leaves it (`controller.ts:1683`).
- **Dependencies & Conflicts.** Should land after
  `a-seats-identity-has-one-source.md`, so the controller has no `--from` to
  reach for and the attribution is designed once rather than retrofitted.
  `a-mission-is-watched-for-the-whole-of-its-life` consumes this as its first
  mechanical check: a mission that is not moving because a member never posted
  has a mechanical cause and a mechanical fix, and must never reach the
  Navigator.

## Dependencies

- `a-seats-identity-has-one-source.md` — removes `--from`, so the controller
  cannot post wearing a coder's name.

## Adversarial Synthesis

Key risks: adding a remediation verb to only one half of a runtime-validated
closed set, which fails silently at 3am; a controller-posted completion becoming
indistinguishable from a coder's, which hides the very defect being measured; and
a double-post when the coder wakes late. Mitigations: add the verb to the type
and the values array together and assert both; record the posting actor as a
separate field from `from`; make the post idempotent against `completed_at`.

## Constraints

**The Pilot repairs state; it does not do work.** It posts a completion for work
that exists on disk. It does not write code, assess quality, summarise, or decide
what happens next. Those remain the lead's.

**The post is bare.** No summary, no reconstructed content, no assembled log
tail. `submit` carries no prose by design, and the controller's post carries no
more than a coder's would.

**Attribution is mandatory and is not the `from` field.** `from` names the seat
whose work it is. A separate field names who posted it. A controller-posted
completion must never read as a coder's own — that would hide the frequency of
the defect, which is the only measure of whether it is getting better or worse.

**It fires only on row 10's evidence.** A prior `finished` before `owner_since`,
writes this round, seat at rest. No card that was never worked can be completed
by this path.

**A second post is a no-op.** If the coder submits after the controller already
did, the board records one completion and the seat gets a success, not an error.

**`ask-completion-post` is removed, not left behind.** Row 10 is its only caller.
A remediation verb no row uses is a rung nothing can reach, and leaving it is the
same defect as leaving an unoccupiable tier role in the judgement chain.

## Proposed Changes

### `src/standalone/controller/matrix.ts`

**Context.** Row 10 declares `remediation: 'ask-completion-post'`. The verb
appears in the `MatrixRemediation` union (~line 40) and in the
`MATRIX_REMEDIATIONS` values array (~line 102), which is what a `matrix.json`
override is validated against at load time.

**Logic.** Replace the verb, in both places, and remove the old one.

**Implementation.** Add `'post-completion-on-behalf'` to the union and the values
array; set row 10's `remediation` to it; delete `'ask-completion-post'` from the
union and the array. Leave row 10's `condition`, `evidence`, `judge`, `target`
and `requires` untouched — detection is not changing. The verb stays off
`ESCALATION_LADDER`: like `mark-complete`, it is a terminal one-shot action, not
a rung.

**Edge Cases.** An operator's existing `matrix.json` naming
`ask-completion-post` must fail validation loudly with the retired verb named,
not be silently coerced or dropped.

### `src/standalone/controller/controller.ts`

**Context.** The remediation switch at ~1676 (`mark-complete`) through ~1833
(`ask-completion-post`). The latter carries the stuck-pass escalation from coder
to lead.

**Logic.** Replace the prompting arm with a posting arm modelled on
`mark-complete`.

**Implementation.** Delete the `ask-completion-post` case in full, including its
`stuck > 1` coder-then-lead escalation — there is no ladder here, the post
happens on the first detection. Add `post-completion-on-behalf`: call the board's
completion route for `subject.planId`, naming the controller as the posting
actor and `subject.seat` as the seat whose work it is. Set `action.outcome` from
the response, leave `ownerSinceReStamped` false, and drop the subject's ladder
state as `mark-complete` does. The `action.detail` names the evidence the post
was made on — the prior `finished` timestamp and the worktree write — so the
report says why, not just what.

**Edge Cases.** A refusal because the card is already complete is `outcome:
'applied'` with a detail saying the coder got there first, not a failure. A
refusal for any other reason is `'failed'` and the card is left alone for the
next wake.

### `src/services/LocalApiServer.ts`

**Context.** `/kanban/queue/done` takes `{ from, outcome }` and optionally
`planId`. Nothing records who *posted* as distinct from whose work it is.

**Logic.** Accept an optional posting-actor field and record it.

**Implementation.** Accept a `postedBy` field naming the actor (the controller
id). Absent means the seat posted for itself, which is every existing caller and
needs no migration. Record it on the completion event so the lead's notification
and the board's history can state it. The field is set only by the controller's
own authenticated path; it is not something the CLI offers, because the CLI is
being reduced to one identity mechanism by
`a-seats-identity-has-one-source.md`.

**Edge Cases.** A second completion for a card already carrying `completed_at`
returns success with a stated "already complete" reason rather than an error —
the idempotency the constraint above requires, implemented once at the board
rather than in each caller.

## Verification Plan

*(Compilation and automated tests are written down here but are not executed in
this planning run.)*

### Automated Tests
- A card matching row 10's evidence is completed by the controller on the
  **first** detection; no prompt is sent to the coder or the lead.
- The completion is attributed: the recorded actor is the controller, and `from`
  is the coder's seat. The two are distinguishable in the board's record.
- A card whose coder submits after the controller already posted records **one**
  completion, and the coder's call succeeds rather than erroring.
- A card with no prior `finished` before `owner_since` does not reach this arm —
  row 10 does not fire, and row 1's and row 2's behaviour is unchanged.
- A seat still mid-turn (`lastDataAt` inside `turnEndSilenceMs`) is not
  completed.
- A `matrix.json` naming `ask-completion-post` fails validation, naming the
  retired verb.
- `owner_since` is unchanged by the post.

### Goal Invariants
- **Negative:** the string `'ask-completion-post'` is absent from
  `src/standalone/controller/matrix.ts` and
  `src/standalone/controller/controller.ts`. **Paired positive:**
  `'post-completion-on-behalf'` is present in **both** the `MatrixRemediation`
  union and the `MATRIX_REMEDIATIONS` values array, and row 10's `remediation`
  equals it.
- Count of prompts (`ptySendPrompt` calls) issued by row 10 equals **0**;
  **paired positive**: count of completion posts issued equals 1 per detection.
- After a controller post, the card's `completed_at` is set **and** the recorded
  posting actor is the controller — assert both, because the first alone is
  indistinguishable from a coder's own submit.
- `'post-completion-on-behalf'` is **absent** from `ESCALATION_LADDER`; **paired
  positive**: it is reachable from the remediation switch.
- Row 10's `condition`, `evidence` and `requires` are byte-identical to before
  this change — detection is not what is being altered.

### Ask the running host
- Reproduce the case end to end: dispatch a card, have the seat write a file and
  a `finished` post, dispatch a second round, have it write and **not** post,
  then wait out `turnEndSilenceMs` and run a controller wake. Confirm via
  `curl http://127.0.0.1:7777/controller/report` that row 10 fired with the new
  verb, and via the board that the card completed and the lead was notified.
- Confirm the host is running the bundle you built before trusting any of it —
  `ps -eo lstart` against the mtime of `dist/standalone/cli.js`.

---

## Completion summary

Row 10 (`fix-round-unposted`) now repairs the state instead of prompting: the retired `ask-completion-post` verb is gone from the `MatrixRemediation` union, from `MATRIX_REMEDIATIONS`, from the board's mirrored `KNOWN_REMEDIATIONS` and from row 10, and a new `post-completion-on-behalf` arm in `controller.ts` POSTs the bare completion to `/kanban/queue/done` for `subject.seat` — the identical call `submit` makes — on the FIRST detection, with no coder-then-lead ladder and no prompt to anyone. `/kanban/queue/done` accepts an optional `postedBy` naming the actor that posted, so `from` stays the seat whose work it is and a controller-posted completion is never indistinguishable from the coder's own; the attribution is carried in the lead's relay notice, in the turn-end body, as a field on the durable `turn_end` plan_events row, and echoed in the response. A second post for a card already carrying `completed_at` is now a 200 no-op with `reason: "already complete"` (implemented once at the board, before the mismatch refusal, so a coder that wakes late gets a success rather than a 4xx), and an unreadable card is never reported as already complete. Row 10's `condition`, `evidence`, `judge`, `target` and `requires` are untouched, and the verb stays off `ESCALATION_LADDER`; an operator `matrix.json` naming the retired verb fails load validation by name. Three contract tests were updated or added (row 10 posts and never prompts; the attribution is present in all three records and absent for an ordinary submit; the already-complete no-op and its unreadable-card negative). The running host was NOT exercised end to end: it serves the stale `dist/` bundle (compilation was skipped for this run), so the live board cannot yet exhibit the new verb.
