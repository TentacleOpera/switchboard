# The Judgement Bundle Cannot See a Seat That Is Busy Doing the Wrong Thing

## Goal

The controller's judgement call receives an evidence bundle rich enough to distinguish **working**
from **stalled** — including the case where a seat is loud, busy, burning CPU and producing nothing.
Today's bundle carries silence, a card title and a log tail; the signals that separate a research
loop from real work are not collected at all. This plan collects them, teaches the model to weigh
them against what the card actually asked for, and routes the result to the team lead rather than
to the seat.

### Problem analysis

> **Superseded:** the original framing of this plan — *"The Judgement Model Is Gated Behind the
> Detection It Exists to Replace"* — argued that rows 3, 5, 6 and 7 each require a mechanical
> detector to match **before** the model is consulted, so the model only ever classifies failures
> mechanical detection has already found, and contributes nothing where detection is the thing
> failing.
> **Reason:** that is not what was built. In `src/standalone/controller/matrix.ts` the condition
> kinds are `'completed-unasserted' | 'quiet-clean-tail' | 'owner-seat-dead' | 'judgement'`. Rows 1,
> 2 and 4 carry mechanical conditions; **rows 3, 5, 6, 7 and 8 all carry
> `condition: { kind: 'judgement', fields: [...] }`**. The "evidence" column of the original row
> table became a *field list sent to the model*, not a gate on whether it runs. And
> `collectSubjects` (`controller.ts:627`) selects **every plan with an owner seat and an uncompleted
> card** — there is no silence pre-filter and no qualification step. The model is already consulted
> for every seat holding work, on every wake.
> **Replaced with:** the real defect, which survives intact and is the rest of this plan: **the
> bundle handed to that model does not contain the signals the judgement needs.** Ungating was never
> required; enriching is.

**One true residue of the original framing.** The shipped system prompt opens *"You classify why a
coding seat on a software board has gone quiet"* (`controller.ts:811`). That presupposes quietness.
A seat in a research loop is the opposite of quiet, and a model told to explain quietness will not
report a seat that is loud. This is a prompt-wording defect, not an architectural one, and change 1
fixes it in a line.

**The grey area is deliberate, and nothing probes it.**

The mechanical checks are intentionally sparse. That is a correct decision: a check that fires often
enough to catch a stall promptly also spams *"what is happening?"* into seats that are working, and
an agent that works 99 times out of 100 is harmed more by interruption than by a late diagnosis.

The conflation to undo: **sampling is not probing.** Reading a seat's CPU, its last write and its
screen buffer costs the seat nothing and says nothing to it. Only *acting* — nudging, clearing,
rerouting — is spam. Sparseness belongs on the remediation, not on the observation.

**The signals that distinguish a stall from work are not collected.**

The operator catches stalls the rows miss by looking. What they are actually reading is available to
the process:

| signal | where it lives today | catches | blind to |
| --- | --- | --- | --- |
| bytes written | `lastDataAt` / `lastActivityAt`, already tracked | hung process | a spinner; a seat blocked on an API |
| screen frame | PTY bytes; no server-side buffer exists | spinner-only motion | slow legitimate render |
| process CPU % | `/proc/<pid>/stat`; fleet already tracks pids | stalled process | **a seat legitimately blocked on an API call — 0% CPU and healthy** |
| process RSS | `/proc/<pid>/status` | crash, leak | steady-state work |
| last worktree write | mtime under the seat's worktree | **a research loop** | genuine long research |
| log tail | already captured | quota errors, questions | — |

Every signal's blind spot is covered by another. None is sufficient alone, and the conjunction is
not expressible as a threshold, which is why no amount of rule-writing closes this.

**What the bundle actually carries today** is `seat`, `card`, `silence`, `ownerSince`, `lastAction`
and `logTail` (`matrix.ts`, the `fields` array on each judgement row). Of the six signals above,
three are absent and one — bytes — is present only as a silence duration.

**A research loop looks maximally alive, and defeats every liveness check.**

An agent stuck researching emits output constantly, burns CPU, and never repeats itself. Bytes flow,
the frame changes, row 6's "repeated identical output" never matches. The only signal that reveals it
is *no file written for N minutes against a card that asked for an implementation*. This is not a gap
in the thresholds; it is invisible to that entire class of check, and it is invisible to the bundle
as shipped.

**The correct threshold is task-dependent, and the task is natural language.**

Forty minutes without a write is alarming against *"fix the typo in README"* and normal against
*"research auth architecture options"*. No constant expresses that difference. A model that reads the
card can, and this is the load-bearing justification for a model being in this loop at all — stronger
than "detection is too sparse", and not answerable by tuning. The card title is already sent; what is
missing is the write history to weigh against it.

**Measured 2026-09-17.** `gemma4:e2b` was given a four-seat bundle in the shape above. It flagged the
seat with no write in 47 minutes against an *implement* card, flagged the seat whose tail held
`Error: 429`, and **left alone** an analyst seat that had never written a file, because its card said
*research*. It also over-reported one plainly healthy seat. The discrimination this feature needs is
present at 2B; the precision is not, which change 4 addresses by design rather than by prompt-tuning.

**The lead is the fixer, and its tokens are the scarce resource.**

The team lead already holds what the watcher never will: it dispatched the work, it holds the plan,
it knows what it asked for. It is also the most expensive model in the fleet. It cannot be put on a
polling loop — wellness checks are the worst possible use of those tokens. The local model exists to
be the lead's eyes so the lead is woken only when woken is earned. This also gives tier 2 its real
justification: it is not a cost saving on inference, it is **the false-positive filter that protects
the lead's tokens**.

### What already works and must not be disturbed

This plan is a follow-on to work that is **already coded and sitting in LEAD CODED**. It is additive.

- **The modelless spine.** Mechanical rows must keep working with no model configured, and a
  modelless board must not present as broken.
- **The ungated judgement path**, which already exists — see the superseded callout above. Nothing
  here re-litigates it, and no change may reintroduce a mechanical precondition on a judgement row.
- **One rung per wake**, the lease, and the report file.
- **Rows 1, 2 and 4 stay mechanical.** They are cheaper and more certain than the model where they
  apply.
- **The board holds no model configuration and makes no model call.** All additions belong to the
  controller.
- **The runtime-agnostic model seam.** `judgement/modelClient.ts` POSTs to `/v1/chat/completions` and
  sends `reasoning_effort: 'none'` on every call (`:75`). The controller holds a URL and never
  inspects what is behind it. **No change here may introduce a runtime-specific code path** — see
  change 5.

### Non-goals

- **Re-architecting the gating.** It is already ungated. A plan that "removes the preconditions"
  would be rewriting working code to the state it is already in.
- **Vision.** The symptoms named are derivable from text. A terminal's screen buffer *is* the
  screenshot, as characters, and a serialized frame additionally supports diffing two samples, which
  a single image cannot express at all. No image capture, no vision model, no image tokens.
- **Removing the mechanical rows.**
- **Making the model decisive.** It observes; the lead decides.
- **Raising remediation frequency.** Observation becomes richer; acting stays sparse.
- **A second controller, clock or lease.** This changes the content of a wake, not the number of
  things ticking.

## Metadata

- **Complexity:** 6
- **Tags:** backend, cli, reliability, performance, feature

*(No `**Feature:**` line: this is a follow-on to the standing-controller feature whose subtasks are
already in LEAD CODED. Linking it would reopen that feature as incomplete. Link it deliberately if
that is wanted — do not let an importer do it by accident.)*

## User Review Required

- **[user] Should tier 1 emit a class, or observations?** The shipped contract is a single closed-set
  label (`judgement/classes.ts`, `CLASS: <one of eight>`). The argument for observations is sound — a
  2B model's observations are reliable and its conclusions are not, and a wrong label misdirects an
  expensive model into fixing the wrong thing. But free-text observations are both the most expensive
  output on a decode-bound host and unvalidatable against a closed set. **Recommended synthesis in
  change 4: closed-vocabulary flags** — `SEAT: coder-1 | FLAGS: no-write-47m, card-implement` — which
  is not a diagnosis, is still parseable, and is the shape the 2026-09-17 e2b test actually produced.
  Proceeding on that assumption; it changes `classes.ts` and its parser, so confirm before coding.
- **[user] `@xterm/headless` and `@xterm/addon-serialize` are new host-process dependencies**, needed
  only by the frame-diff signal in change 2. That signal is the weakest of the six and is marked
  separable. Proceeding on the assumption that **frame diffing is deferred** and the other signals
  ship first; confirm if you want it in scope, because a headless terminal per seat is resident
  scrollback against a memory budget, at nine seats.
- **[user] The free-tier escalation budget is taken from your figure** of 1500 requests/day for cloud
  Gemma 4. It has not been independently verified, and it bounds tier 2 only — tier 1 is local and
  free.

## Complexity Audit

### Routine

- Reading `/proc/<pid>/stat` and `/proc/<pid>/status` for CPU and RSS. The fleet already tracks pids.
- Stat-ing a worktree for its most recent write. Worktree paths are already known to
  `KanbanDatabase` / `PlanIngestionEngine`.
- Adding fields to the bundle. `matrix.ts` already declares per-row `fields`, and `controller.ts`
  already assembles lines from them — the mechanism exists.
- Switching the configured model to `gemma4:e2b`. Configuration, not code.
- The prompt-wording fix (change 1).

### Complex / Risky

- **CPU% requires two samples.** A single `/proc` read gives cumulative jiffies, not a rate. The
  sampler must hold the previous reading per pid, which is state that must survive a wake and be
  invalidated when a pid is recycled.
- **Bundle rendering must be stable across wakes** (change 6). Judgement is deterministic for a
  fixed prompt, so an unstable bundle — reordered seats, rephrased durations, tails truncated at
  varying boundaries — is the only way a verdict flips on unchanged board state.
- **Over-reporting is designed in, and lands on tier 2.** Tier 2's prompt must expect healthy seats in
  its input. If it assumes everything handed to it is suspect, tier 1's permissiveness becomes tier
  2's false positives and the filter stops filtering.
- **A headless terminal per seat is new resident state** — deferred by default, see User Review.

## Edge-Case & Dependency Audit

### Race Conditions

- **Pid recycled between samples.** A seat that dies and respawns reuses the slot; the CPU delta
  against a stale reading is meaningless. Key the previous sample by pid **and** start time
  (`/proc/<pid>/stat` field 22), and treat a mismatch as "no previous sample" rather than as zero.
- **Worktree written by something other than the seat.** A merge, a rebase, or the operator editing a
  file updates mtime and makes a stalled seat look productive. Scope the scan to paths the seat's own
  card claims, where the write set is known, and say in the bundle which basis was used.
- **Frame captured mid-render** (if change 2's frame signal ships). Two samples is the minimum; three
  consecutive identical frames is the usable signal.
- **Verdict instability across wakes** — change 6.

### Security

- **The bundle carries log tails, which carry secrets.** Redaction already runs
  (`controller/redact.ts`) and must be applied at **assembly**, not at send, so a local-only
  deployment exercises the same path and the redaction is tested constantly rather than only on
  escalation.
- **New signals are metadata, not content.** CPU, RSS, mtime and frame-change are counters and
  durations; none carries user data. The worktree scan reports *when*, never *what*.

### Side Effects

- **Sampling is observable to nothing, by design.** No seat is written to, no prompt is sent, no
  terminal is cleared. If any part of the sampler writes to a seat, this plan has failed.
- **A richer bundle on every wake grows the report.** Quiet wakes should append a one-line "nothing
  observed" rather than a full bundle.
- **`/proc` reads are Linux-only.** On a host without `/proc`, those fields report unavailable with a
  reason and the bundle degrades — it does not fail.

### Dependencies & Conflicts

- **Follow-on to the standing-controller feature** (`2f18835b-e10e-47df-b110-dd4f7381918f`), whose
  subtasks are in LEAD CODED. This plan touches `matrix.ts`, `controller.ts` and `judgement/` — files
  that work produced. **It must not be dispatched into the same files while that work is in flight.**
- Change 3 adds `target` to the row schema, which the structured-card renderer displays.
- Change 4 changes `judgement/classes.ts` and its parser, pending the User Review decision above.

## Adversarial Synthesis

Key risks: the plan's original headline was false against the shipped code, and a coder who acts on
it would rewrite a working ungated path into the state it is already in — the superseded callout
above exists to stop exactly that. The genuine risks that remain are that per-pid CPU sampling
carries recycle state that is easy to get subtly wrong, that an unstably-rendered bundle flips
verdicts on unchanged board state, and that a richer bundle plus a permissive tier 1 pushes false
positives onto the lead — the most expensive thing on the board. Mitigations: sample keys include
process start time, bundle rendering is deterministic (sorted seats, quantised durations, fixed
truncation), and tier 2 is calibrated strictly against a tier 1 that is deliberately noisy.

A second-order risk, and the reason change 6 is withdrawn rather than deleted: **this plan asserted
a measured finding that was an artefact of comparing two different prompts**, and it survived into
a change against working code. Measurements quoted here should be reproduced before they are acted
on, and the withdrawal is left visible so the same claim is not re-derived later.

## Proposed Changes

### 1. The prompt stops presupposing silence

`controller.ts:811` opens *"You classify why a coding seat on a software board has gone quiet."* A
seat in a research loop is loud, and a model asked to explain quietness will not report it.

Reword to describe the actual task: classify whether a seat holding a card is making progress on
**that card**, and if not, why. Silence becomes one input among several rather than the premise.

This is the entire honest content of the original "ungating" change — the path is already ungated;
only the question was narrow.

### 2. The bundle gains the signals that distinguish a stall from work

`matrix.ts` already declares per-row `fields` and `controller.ts` already assembles bundle lines from
them. This adds field kinds, not a mechanism.

```
seat <name> | role <role> | card "<title>" | column <column>
  last output        : <duration since lastDataAt>
  cpu                : <percent over the sampling interval>
  rss                : <MB>
  last worktree write: <duration, or "never"> (basis: <card write set | whole worktree>)
  tail               : <last N redacted lines>
```

- **CPU and RSS** — `/proc/<pid>/stat` (fields 14/15 for jiffies, 22 for start time) and
  `/proc/<pid>/status` (`VmRSS`). Two samples required for a rate; hold the previous reading keyed by
  pid **and** start time. Sample the seat's **process tree**, not just the shell, or an agent CLI
  spawned as a child reads as 0%.
- **Last worktree write** — most recent mtime under the seat's worktree, scoped to the card's write
  set where known. **Report the basis used**, per the fallback rule: "no write in 47m (whole
  worktree)" and "no write in 47m (card write set)" are different claims.
- **Bytes and tail** — `lastDataAt` and the existing log capture. No new collection.
- **Screen frame — deferred.** Feeding PTY bytes into `@xterm/headless` and diffing `serialize()`
  output is the weakest of the six signals and the only one with a memory cost. It is separable and
  is **not in this plan's default scope** (see User Review).

The card title stays mandatory in every line. It is what makes the threshold task-dependent, and
without it this plan reduces to the thresholds it replaces.

Sampling runs on the controller's existing clock and **writes to nothing**.

### 3. A row's remediation target may differ from its subject

The row schema assumes the seat diagnosed is the seat acted upon. The case this plan adds — *a member
is looping, so tell the lead* — diagnoses `coder-1` and acts on `lead-1`.

Add `target` to `MatrixRow`, defaulting to the subject. The new row:

| row | signal | judge | remediation | target |
| --- | --- | --- | --- | --- |
| 9 | no worktree write for N against a producing card, seat otherwise live | **model** | hand observations to the lead | the subject's **lead** |

Remediation is a `ptySendPrompt` to the lead carrying **the observations, not a diagnosis**. A
subject with no resolvable lead degrades to recording the observation — never to nudging the subject,
which is the failure mode row 9 exists to avoid.

### 4. Tier 1 reports flags, not conclusions — and the tiers calibrate in opposite directions

**Tier 1 must not emit a diagnosis.** A small model's observations are reliable; its conclusions are
not, and the lead holds context tier 1 never will. A wrong label misdirects an expensive model into
fixing the wrong thing, which costs strictly more than the wellness check the lead was spared.

**Recommended contract — closed-vocabulary flags, not prose and not a single class:**

```
SEAT: <name> | FLAGS: <comma-separated, from a closed set>
```

with flags naming *what was observed* (`no-write-47m`, `card-implement`, `tail-quota-error`,
`cpu-zero`, `silent-30m`) rather than what it means (`stuck`, `looping`, `overthinking`). This keeps
everything the shipped `CLASS:` contract bought — closed set, regex-parseable, validate-and-reject,
one line, cheap on a decode-bound host — while removing the conclusion. It is also the shape the
2026-09-17 e2b run actually produced. **Pending the User Review decision**, since it changes
`judgement/classes.ts`.

**Calibrate the tiers oppositely, and state why:**

- **Tier 1 permissive.** Escalating costs one local call. Missing a stall costs a wedged seat for a
  wake interval. It should flag on any doubt, and over-reporting a healthy seat is an accepted,
  expected outcome.
- **Tier 2 strict.** This is the gate in front of expensive tokens. Its default answer is "not yet",
  and **its prompt must expect healthy seats in its input**, because tier 1 is deliberately noisy.

Tuning both the same way discards the structure.

### 5. Model sizing — and the endpoint does not change

Measured on the controller host (i7-1165G7, 4 cores, 15 GB, no GPU, AVX-512 VNNI), CPU-only:

| model | decode | prefill (warm) | cold load | 4-seat bundle |
| --- | --- | --- | --- | --- |
| `gemma4:12b-it-qat` | 5.6 tok/s | 228 tok/s | 6.9 s | ~40 s |
| **`gemma4:e2b`** | **22–23.6 tok/s** | **2733 tok/s** | 3.1 s | **~3 s** |

A bundle consulted on every wake over every seat justifies a small, fast model rather than a large,
slow one. At 288 wakes/day the fast model costs ~14 minutes of CPU per day. **This is configuration,
not code.**

Measured on the four-seat bundle, same prompt, temperature 0, `gemma4:e2b` on CPU:

| | thinking off | thinking on |
| --- | --- | --- |
| wall | 3.7 s | 35.8 s |
| decode | 32 tok | 698 tok (2224 chars of thinking) |
| seats flagged | coder-1 **and** coder-3 | coder-3 only |

With thinking on, the model **missed the research-loop case entirely** — the 47-minutes-without-a-
write seat — apparently reasoning that `reading src/auth/session.ts` is topically consistent with
"implement token refresh" and therefore fine. Ten times the latency for a false negative on the one
signal this plan exists to catch.

**Read that as a fact about a 2B model, not about thinking.** At this size extended reasoning
rationalises rather than verifies. Whether a larger model on capable hardware reasons its way to a
*better* answer on the same bundle is untested and plausible — the obvious experiment for anyone
deploying on a GPU, and row 9's research-loop case is the one to test it against, because that is
where topical plausibility misleads.

**Thinking is a declared property of the configured backend, not a constant in the controller.** The
controller holds a URL and does not inspect hardware; whether the model behind it should think is
part of that backend's declaration, alongside its endpoint and model name. A deployment that declares
thinking **on** with a capable model is supported, and the controller must not assume otherwise. The
measurements above are guidance for choosing a configuration; nothing in the controller reads them.

> **Superseded:** *"`think: false` is honoured on `/api/generate` and ignored on `/api/chat`... The
> controller must use the native generate endpoint... This also rules out the OpenAI-compatible `/v1`
> path, which has no equivalent flag."*
> **Reason:** the last clause is false, and acting on it would cause real harm. Ollama's
> `/v1/chat/completions` accepts **`reasoning_effort`**, which maps to the internal `Think` field —
> `"high"`/`"medium"`/`"low"` enable it and **`"none"` maps to `think = false`**. It is real but
> undocumented, which is why ollama/ollama#14820 exists (the only way to find it is to read
> `openai/openai.go`), with docs PR #14821 against it. The native `think` flag is indeed ignored on
> `/v1`; `reasoning_effort` is the spelling that works there. **The shipped client already sends it**
> — `judgement/modelClient.ts:75`. Moving to a native Ollama endpoint would make the controller
> runtime-aware, acquiring a per-backend branch for every future tier, to fix something that is not
> broken.
> **Replaced with:** no endpoint change. The seam stays `/v1/chat/completions` with
> `reasoning_effort` carrying the backend's declared thinking preference. Where a backend needs
> thinking on, it declares so and the controller sends a different `reasoning_effort` value — still
> one request shape for every backend.

### 6. WITHDRAWN — local inference is deterministic at temperature 0

> **Superseded:** *"Judgement must not assume run-to-run determinism."* The change claimed that two
> identical prompts at temperature 0 returned different verdicts, concluded that llama.cpp's matmul
> reduction order varies with thread scheduling, asserted this generalises to GPU and hosted
> backends, and called `stuckPasses` (`controller.ts:987`) a defect requiring tolerant counting or
> pre-wake aggregation.
> **Reason:** the two runs compared **were not the same prompt** — one ended with
> `"Reply in at most 4 short lines."` and the other did not. The difference in verdicts was caused by
> the difference in input. Re-tested 2026-09-17 with a controlled method: six identical calls to
> `gemma4:e2b-it-qat` at `temperature: 0`, hashing the full response, produced **six identical
> hashes**. A control at `temperature: 1.0` with two different seeds produced two different hashes,
> confirming the method detects variation when it is present. Three-run repeats of the four-seat
> bundle against both `e2b-it-qat` and `e4b-it-qat` likewise produced identical verdicts every time.
> **Replaced with:** nothing. `stuckPasses` is sound as written. Do not change it on the strength of
> this plan. A consecutive-passes counter is a correct construction over a deterministic judge, and
> the two options proposed above — tolerant counting and pre-wake aggregation — would add complexity
> to defend against a problem that does not exist.

**What remains true, and is much narrower:** determinism holds for a *fixed prompt against a fixed
model at temperature 0*. It does not survive a bundle whose content changes between wakes for
incidental reasons — a re-ordered seat list, a rephrased duration, a truncated tail landing at a
different boundary. That is a reason to make bundle **rendering** stable (sort seats deterministically,
quantise durations, truncate tails on a fixed rule), not a reason to distrust the counter.

Tier 2 is a separate matter: a hosted backend offers no reproducibility guarantee across model
versions, and none is assumed here because tier 2 gates escalation rather than feeding a counter.

**No change to `stuckPasses` is recommended or required by this plan.** The deterministic-judge
result above removes the reason for one. The only actionable residue is bundle-rendering stability,
which belongs with the bundle changes rather than the counter.

### 7. The board's nudge sweeps stand down while the controller is judging

**Operator requirement, 2026-09-17: when a judgement backend is configured — local or cloud — team
leads must stop receiving the system-generated nudges.**

This is the corollary of everything above. The four nudge sweeps take the *same* action for every
cause — re-deliver a prompt — which is precisely the behaviour judgement exists to replace. Once the
controller can tell a seat waiting on a human from a seat out of quota from a seat in a research
loop, a blind 30-minute "what is happening?" into the lead is not a backstop, it is noise competing
with a better answer.

**Which sweeps, and which not:**

| sweep | addressee | suppressed? |
| --- | --- | --- |
| `_runFeatureNudgeSweep` (`:1203`) | feature head | **yes** |
| `_runQueueNudgeSweep` (`:1465`) | head or pacer seat | **yes** |
| `_runMemberCompletionReminderSweep` (`:2104`) | lead, about a member | **yes** |
| `_runDispatchStallSweep` (`:2434`) | lead | **yes** |
| `_runDispatchTimeoutSweep` (`:2768`) | nobody — abandons the card, releases the seat | **never** |

The timeout sweep is not a nudge. It is the bounded end state for a card nobody rescued, it prompts
no one, and it is the backstop that survives a controller failing entirely. Suppressing it would
remove the last guarantee on the board.

**The gate is a live lease, not a config flag.** `config:controller.lease` already exists
(`ControllerBoardStore.ts:33`) and is read board-side. The controller publishes its judgement
availability into the lease it already renews; `PlanIngestionEngine` reads the lease. **The board
still holds no model configuration and makes no model call** — it reads what the controller told it,
exactly as the panel does.

**Three states, and collapsing any two is the bug:**

| lease state | sweeps |
| --- | --- |
| unclaimed — no controller | **active** (today's behaviour, unchanged) |
| current, judgement available | **suppressed** — the controller is answering |
| current, judgement unavailable (modelless, or backend unreachable) | **active** |
| **stale — controller late or dead** | **resumed**, and the resumption is logged and reported |
| **unreadable / corrupt lease** | **active** |

The stale row is the one that matters. A controller that dies holding a lease must not take the
board's nudges down with it — that is a silent degradation in which nobody nudges because the board
believes something better is handling it. Suppression is keyed on a lease that is *currently being
renewed*, never on "a controller was configured once". `ControllerBoardStore` already states the
matching rule for its own read: *"a corrupt lease is NOT an unclaimed board"* — and by the same
discipline, an unreadable lease must not read as "judgement is handling it".

**This does not remove the coordination guard, it narrows where it applies.** The controller's row 2
still requires silence since the **last board nudge** rather than since last output, because in the
modelless-controller configuration both are active and `notifiedSeatsThisTick`
(`PlanIngestionEngine.ts:671`) is a set a separate process cannot join. Suppression removes the
overlap in the judging configuration; the guard covers the one that remains.

**Surfaced, not silent.** The panel shows which state the board is in ("board nudges: suppressed —
controller judging" / "active"), the report records every transition with its reason, and a
resumption after a stale lease is a reported event rather than a return to quietly nudging. A
behaviour change nothing announces is the failure this codebase names repeatedly.

**No migration concern.** The default state — no controller — is unchanged, and suppression can only
engage on a configuration that does not exist before this feature ships.

### 8. The fix round that was finished and never posted

**Operator report, recurring: coders post completion for their first round, then treat that post as
covering every later round. When the lead sends work back for fixes, the fix lands and nothing is
posted, and the operator intervenes by hand.** This is the most frequently hit case on the board and
nothing detects it.

**Half of this was already fixed, and it was the other half.**
`a-lead-completion-post-must-clear-the-seat-completed-at-is-a-latch-that-is-never-reset.md`
established that `completed_at` was write-once, so a re-dispatched card kept a stale completion from
a previous run and the lead's next completion post was discarded as `idempotent: true`. That has
landed: `KanbanDatabase.ts:14450` now resets `completed_at = NULL` on dispatch alongside `owner_seat`
and `owner_since`, and `clearCompletedAt` / `clearCompletedAtByPlanFile` exist. **A fix round
therefore starts clean, and the remaining failure is purely that nobody posts.**

**Why row 1 is structurally blind to it.** `evalCompletedUnasserted` (`controller.ts`) requires the
coder's post as its evidence:

```ts
const finishedAt = ctx.finishedByPlan.get(subject.planId);
if (finishedAt === undefined || finishedAt < subject.ownerSinceMs) { return null; }
```

Row 1 detects *"the coder posted `finished` and the lead never asserted completion"* — a **lead**
failing to close. The operator's case is the **coder** never posting, which leaves no `finished`
event after `owner_since`, so the guard returns null and the row cannot fire. The only things that
eventually notice are `_runDispatchStallSweep` at 30 minutes (which nudges the lead, not the coder,
and says nothing about the work being done) and `_runDispatchTimeoutSweep` at four hours (which
abandons the card). Neither can tell that the work is finished.

**The discriminating evidence is already in the controller's hands and is being discarded.** That
same guard rejects on `finishedAt < subject.ownerSinceMs` — but that condition is not "no evidence".
It is:

> **this seat posted a completion for this very card on an earlier round, and has not on this one.**

That is close to a signature of the reported behaviour. A coder who has never posted for a card might
be new, confused, or genuinely unfinished. A coder who posted on round 1 and is silent on round 2 is
doing exactly what the operator describes.

**Row 10 — the signal is the inverse of row 9's.** Change 2's worktree-write sampler carries this at
no extra cost. Row 9 looks for *no writes* against a producing card (a research loop). Row 10 looks
for the opposite polarity:

| row | mechanical priors | judge | remediation | target |
| --- | --- | --- | --- | --- |
| 10 | `completed_at` NULL; **no** `finished` after `owner_since`; **a** `finished` **before** `owner_since`; seat at rest past `turnEndSilenceMs`; **worktree writes after `owner_since`** | **model** | ask the coder to post its completion | the **subject**, then its **lead** |

All five priors are available now or come free with change 2. They are carried as flags, not as a
gate — consistent with the judgement path being ungated.

**Why the model and not a pure mechanical row.** The priors establish *work happened and nothing was
posted*; they cannot distinguish **finished** from **gave up partway**. The log tail can — a
summary of what was changed reads differently from a stack trace or an abandoned thought — and so
can the card text. That is the judgement, and it is small.

**Why the remediation is a prompt and not an auto-complete.** Row 1 may mark a card complete because
the coder *asserted* `finished`; the board is only recording an assertion that already exists. Here
nobody has asserted anything, so completing the card would be the controller inventing a claim about
work it cannot verify — a wrong completion is materially worse than a late one. The first rung is a
`ptySendPrompt` to the **coder**: *you appear to have finished and no completion is posted for this
round; post it.* That is precisely the operator's manual intervention, automated. Only if the next
wake finds the same state unchanged does it escalate to the **lead**, using change 3's `target`.

**Rounds need no new schema.** "Is this a fix round" is answered by the prior `finished` event
already in `finishedByPlan`; `coding_rounds` does not need to be read. One implementation note: the
map currently holds a single timestamp per plan, and this row needs both *the latest* and *whether
any exists before `owner_since`* — keep both, or key the map by plan and return the full set.

**This is the case to measure the tier-1 model against first.** It is the highest-frequency failure
the operator reports, its evidence is unambiguous, and the flags are cheap. If `gemma4:e2b` cannot
separate "finished, unposted" from "gave up" on this bundle, that is a stronger argument about model
sizing than any of the synthetic scenarios.

## Verification Plan

### Automated Tests

- **The ungated path is not regressed.** Rows 3, 5, 6, 7 and 8 still carry
  `condition.kind === 'judgement'`; assert no mechanical precondition is added to any of them.
- **Prompt framing.** The judgement system prompt contains no phrasing that presupposes the seat is
  quiet or idle; a seat with continuous output and no writes is reportable.
- **Card text present.** Every bundle line contains the card title; a bundle missing one fails.
- **No writes from the sampler.** With a stub PTY host, a full wake in sample-only mode issues zero
  writes to any seat — no prompts, no clears, no input.
- **CPU rate correctness.** A pid whose start time changes between samples reports "no previous
  sample", never a rate computed across the recycle.
- **Process tree.** A seat whose shell is idle but whose child agent CLI is busy reports non-zero CPU.
- **Write basis is reported.** A bundle line naming a write duration also names whether the basis was
  the card's write set or the whole worktree.
- **Research card.** A seat with a research card and no worktree write is **not** flagged, while a
  seat with an implement card and the same write history **is**.
- **Tier 1 emits no conclusion.** A reply containing a diagnosis term from the forbidden set is
  rejected and treated as "the rule did not run".
- **Target indirection.** Row 9 resolves its remediation to the subject's lead; a subject with no lead
  degrades to recording the observation, never to nudging the subject.
- **Redaction at assembly.** A tail containing a known secret pattern is redacted in the assembled
  bundle, before any send and regardless of whether tier 2 is configured.
- **No runtime-specific path.** Grep the controller and judgement sources for `/api/generate`,
  `/api/chat` and a literal `ollama`; assert zero hits. The seam stays `/v1/chat/completions`.
- **Modelless.** With no judgement backend, every model row reports `no judgement backend configured`
  and the mechanical rows act unchanged.
- **No `/proc`.** On a host without `/proc`, CPU and RSS report unavailable with a reason and the
  bundle still assembles.
- **Nudge suppression.** With a current lease declaring judgement available, none of the four nudge
  sweeps delivers a prompt; with no lease, all four behave exactly as today.
- **Stale lease resumes nudges.** A lease that stops being renewed returns the sweeps to active
  within the declared staleness window, and the resumption is recorded in the report.
- **Unreadable lease does not suppress.** A corrupt `controller.lease` row leaves the sweeps active,
  never suppressed.
- **The timeout sweep is never suppressed.** With judgement active and a card past
  `dispatchTimeoutMs`, `_runDispatchTimeoutSweep` still abandons it and releases the seat.
- **Fix round, unposted.** A card re-dispatched after a completed first round, whose seat wrote to
  the worktree, went to rest, and posted no `finished` for the current `owner_since`, is flagged —
  and the first remediation is a prompt to the **coder**, never an auto-complete and never a lead
  nudge.
- **First-round silence is not the same case.** A card with **no** prior `finished` event at all and
  the same write history does not fire row 10; it is row 9's or row 2's domain.
- **Row 10 never completes a card.** Assert no path from row 10 reaches `POST /kanban/task/complete`.
- **Escalation order.** Row 10 escalates to the lead only after the coder prompt has been delivered
  and the state is unchanged on a later wake.
- **Modelless controller does not suppress.** A controller holding a lease with no judgement backend
  leaves the sweeps active, and the controller's row 2 still respects silence-since-last-board-nudge.
- **Deadline.** A model host that never answers does not prevent mechanical rows from acting within
  the wake.

### Goal Invariants

1. Every judgement row's condition remains `kind: 'judgement'`; no mechanical signal becomes a
   precondition for the model running.
2. The bundle for a judgement row contains CPU, RSS and last-worktree-write in addition to today's
   fields — assert their presence by name in an assembled bundle.
3. The sampler never writes to a seat. Observation frequency and remediation frequency are
   independent, and only the former changed.
4. Every bundle line carries the card title.
5. Tier 1 never emits a diagnosis; it names seats and the flags observed about them.
6. Tier 2 accepts healthy seats in its input without treating their presence as an error.
7. A seat that has never written a file is judged against what its card asked for, not against a
   constant.
8. Row 9 acts on the subject's lead, never on the subject.
9. No escalation rule reads a single model verdict as a stable fact.
10. A modelless board behaves exactly as it does today.
11. No image is captured, encoded or sent anywhere.
13. Nudge suppression is keyed on a currently-renewed lease — **paired with:** a stale or unreadable
    lease leaves the sweeps active. Assert both directions; the negative alone passes if suppression
    is never implemented.
14. `_runDispatchTimeoutSweep` has no suppression path at all — grep its call site and assert no
    lease check guards it.
15. Row 10's remediation set contains no completion verb — **paired with:** it does contain a
    `ptySendPrompt` to the subject, so the row acts rather than merely recording.
16. `PlanIngestionEngine` reads no model configuration: grep it for endpoint, model-name and
    `reasoning_effort` references and assert zero. It reads the lease, nothing else.
12. `judgement/modelClient.ts` still POSTs to `/v1/chat/completions` — **paired with:** thinking is
    still suppressed by default, via `reasoning_effort`.

## Outstanding Questions

- **What is N for "no worktree write against a producing card"?** It must be task-dependent, which is
  the model's job — but the bundle still reports a duration, and the model needs some anchor for what
  is long. Candidate: report the duration plainly and let the card text carry the rest; measure
  whether e2b discriminates without an explicit threshold. The 2026-09-17 four-seat test suggests it
  does, on one example.
- **Does "producing card" need to be declared, or inferred?** Inferring *implement vs research* from
  the card title is itself a model judgement, and a wrong inference silently disables row 9. A column
  or a tag may be the honest source.
- **Is tier 2 worth calling before a lead exists?** With no lead configured, tier 2 filters nothing
  and the chain is tier 1 → report. Tier 2 should possibly be inert in that configuration rather than
  called.

---

**Recommendation: Send to Coder.** Complexity 6 — the mechanism for bundle fields already exists, the
sampler is `/proc` reads and an mtime scan, and the riskiest item (`stuckPasses`) is a local fix to
shipped code. Do **not** dispatch into `matrix.ts`, `controller.ts` or `judgement/` while the
standing-controller subtasks are still in flight.
