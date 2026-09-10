# A tmux Seat Gets a Blind Two-Second Clear and Loses the First Dispatch

## Goal

A dispatch to a tmux team seat must wait for the CLI to be ready after `/clear`, not for a fixed
delay. Today the first dispatch of a review round is the one that clears, and it is the one that
gets lost.

### Problem analysis

**Reported as:** *"the team lead's review round dispatch often fails on the first dispatch sent to a
team terminal, then the second succeeds."*

**The tmux delivery path has no readiness detection. The pty path does.** That asymmetry is stated
in the code:

```
ptyPromptDelivery.ts:17    DEFAULT_CLEAR_SETTLE_MS = 600   // was 2000 — covers the CLI's /clear re-render
                           plus a readiness tracker; the delay is only `fallbackDelayMs` (:120)

tmuxPromptDelivery.ts:62   DEFAULT_CLEAR_SETTLE_MS = 2000  // blind
```

`tmuxPromptDelivery.ts:57-63` says why:

> *"Clear settle — tmux-specific. The `/clear` command goes through send-keys (external process) and
> the pane re-renders **without a readiness signal**, so a conservative default is warranted. The
> PTY default is 600ms with a readiness tracker; **the tmux path has no tracker**, so 2000ms is the
> floor."*

So the pty path was able to come down to 600 ms *because* it detects readiness. The tmux path sleeps
two seconds and hopes. The operator's teams run in tmux (`lc-coding-team` windows created by
`goPtyFleetProjection.ts`), so every team dispatch takes the blind path.

**Only the first dispatch of a work context clears — which is why only the first one fails.**
`TaskViewerProvider.ts:958`:

```js
if (lastTeamWorkKey === workContextKey) {
    // Same feature/work context: preserve context across coder reports, review, fixes, handoffs.
    …
    payload = { ...payload, clearBeforePrompt: false };
} else {
    // New feature/work context enters the team: prepare entire roster barrier once
```

A review round is a **new** work context, so the sequence is:

1. First dispatch — new `workContextKey` → the roster barrier clears **every** roster member,
   concurrently.
2. Delivery to the target does `/clear`, waits the blind 2000 ms, then pastes the prompt.
3. If the CLI has not finished re-rendering, the prompt merges onto the `/clear` line. `/clear`
   takes no arguments, so the CLI discards the prompt — and the API has already reported success.
4. The retry finds `lastTeamWorkKey === workContextKey`, so `clearBeforePrompt: false`. No clear, no
   settle, the prompt lands. **Second succeeds.**

**Step 3 is a documented, reproduced defect, not a guess.**
`a-dispatch-to-a-new-seat-waits-for-the-cli-not-for-silence.md` (COMPLETED, complexity 6) caught it
in a terminal log — `/clear` echoing at shell level before the Claude Code banner painted, then both
on one input line:

```
❯ /clear
YouareactingastheSwitchboardrevieweragent.
```

> *"Claude Code parsed that as `/clear` with arguments. `/clear` takes none — it wiped the (empty)
> session and discarded the prompt. `POST /kanban/dispatch` had already returned
> `{"success":true,…}`."*

That plan built the readiness tracker **for the pty fleet**. The tmux path never got one, so the
same failure is still reachable there — now on an existing seat rather than a newly spawned one.

**And this box makes 2000 ms marginal.** Measured today on the same host: a browser shell load
saturates one core for 2751 ms, with `/health` moving from 37 ms to a 758 ms median and a 1508 ms
maximum. The roster barrier clears all four seats **concurrently**. A fixed 2 s window on a 4 GB Pi
under that load is precisely the shape that works most of the time and fails often enough to be
noticed — which matches "often fails", not "always fails".

**Evidence not available, and why.** Host logging is off at the operator's instruction, so there is
no server log for the observed failures, and `plan_events` carries only activity-light
`start`/`stop` actions (7042 / 3123 rows) — no dispatch action, so no retry signature in the DB. The
code asymmetry and the clear-on-first-dispatch logic are established; the causal link to these
specific failures is inference from them. Change 4 makes the next occurrence self-evidencing.

**Likely the same mechanism as a card already on the board.**
`a-prompt-reported-as-sent-can-vanish-before-reaching-the-seat.md` (PLAN REVIEWED, complexity 6) is
the "reported success, never arrived" symptom whose mechanism was never found. Every hypothesis
chased there concerned the pty path. This is a candidate answer for the tmux half — link them, do
not merge them, until change 4 confirms it.

## Metadata

**Complexity:** 4
**Tags:** bugfix, tmux, prompt-delivery, teams, dispatch
**Dependencies:** related to `A delay setting must not be able to defeat known-CLI readiness`
(CODE REVIEWED, complexity 4) — that establishes the principle for pty; this applies it to tmux. Do
not land a tmux delay knob that can defeat a tmux tracker, which is the same mistake that plan
exists to prevent.

## User Review Required

None.

## Proposed Changes

### 1. Give the tmux path a readiness tracker

- `tmux capture-pane` can read a pane, so readiness is detectable — the tracker the pty path has is
  buildable here. `tmuxBackend.ts:440` records that polling `capture-pane` (or a long-running
  `pipe-pane`) was deliberately avoided; that decision is what leaves the blind delay, and it is the
  one to revisit.
- Poll only inside the clear-settle window, not continuously. The cost that avoidance was protecting
  against is a permanent poller; a bounded poll during a clear is a different trade.
- Detect the CLI's prompt/banner having re-rendered, then send. Keep the 2000 ms only as a
  `fallbackDelayMs`, exactly as the pty path treats its 600 ms.

### 2. Do not let the roster barrier and the target's clear race

- The barrier clears every roster member concurrently, then the dispatch clears the target and
  pastes. On a loaded Pi those overlap. The target's prompt must not be written until the target's
  own clear has settled, independent of how long the other members take.
- The per-pane lock (`withTmuxLock`, `tmuxPromptDelivery.ts:70`) serialises sends to one pane but
  says nothing about a clear issued through a different path. Confirm the barrier's clears go
  through the same lock; if they do not, that alone is enough to produce this.

### 3. Fail loudly when the prompt may not have landed

- A `/clear` whose settle expired without a readiness signal must not report `success: true`. Return
  the uncertainty so the caller can retry deliberately, rather than the operator discovering it by
  watching a silent seat.
- This is the same reporting defect as the COMPLETED plan's `{"success":true,…}` on a discarded
  prompt. Do not rebuild it in the tmux path.

### 4. Make the next occurrence self-evidencing

- The operator cannot debug this today: logging is off by choice and nothing records a dispatch in
  `plan_events`. Record the delivery outcome — settle waited, readiness seen or timed out, bytes
  written — as a `plan_events` row, not as a log line. It survives with the board, is queryable, and
  is pruned by `RetentionService`.
- That both confirms or refutes the mechanism above and closes the gap that made
  `a-prompt-reported-as-sent-can-vanish-before-reaching-the-seat` unfalsifiable.

### 5. Interim mitigation the operator can apply now

- The tmux clear settle is operator-clamped 0–10000 ms (`MAX_CLEAR_SETTLE_MS`). Raising it to ~5000
  should make the first-dispatch failures stop. It is a diagnostic, not the fix: it trades five
  seconds off every new-work-context dispatch and still fails under enough load.

## Verification Plan

- Dispatch a review round to a tmux team while the host is deliberately loaded (a browser shell
  load reproduces the 96%-of-a-core burst). The **first** dispatch lands.
- Repeat 20 times across new work contexts; zero prompts lost, and no `success: true` on a delivery
  whose readiness never arrived.
- With readiness detection in place, the effective settle on an idle box drops well below 2000 ms —
  the pty path's 2000 → 600 is the precedent.
- A `plan_events` row exists per delivery recording whether readiness was seen or the fallback
  expired.
- The pty path is unchanged; assert it, since both paths share the delivery caller.

## Outstanding Questions

- Does the same blind-delay gap apply to a **non-team** tmux seat? The clear logic differs
  (`_lastWorkContextByTerminal` rather than `_lastWorkContextByTeam`), but the delivery path is the
  same file, so the settle is equally blind. If so this is broader than teams and the title
  understates it.
