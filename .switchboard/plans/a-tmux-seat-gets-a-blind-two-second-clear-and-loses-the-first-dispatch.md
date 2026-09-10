# A Seat Projected Through tmux Has No Detectable Readiness, So Every Clear Is Blind

> **CORRECTION 2026-09-10.** The first version of this plan blamed
> `tmuxPromptDelivery.ts`'s blind 2000 ms clear settle. **Wrong path.** The operator's team seats are
> **pty** seats — they appear in `ptyListTerminals` with pids and no `paneId`, so delivery goes
> through `ptyPromptDelivery.ts`, which *does* have a readiness tracker. The real defect is that the
> tracker cannot work for these seats, for the reason below. Title and analysis rewritten; the
> symptom and the "first fails, second succeeds" logic are unchanged.

## Goal

A dispatch to a seat running inside tmux must wait for evidence the CLI is ready after `/clear`, not
for a flat per-family timeout. Today readiness is undetectable for every such seat, so the first
dispatch of a review round is the one that clears and the one that gets lost.

### Problem analysis

**Reported as:** *"the team lead's review round dispatch often fails on the first dispatch sent to a
team terminal, then the second succeeds."*

**The seats are pty seats whose agent runs inside tmux.** From the live fleet:

```
Coding            pid 421247   inner = devin
Coding-coder-1    pid 421442   inner = agy
Coding-coder-2    pid 421657   inner = agy
Coding-intern     pid 421811   inner = agy
```

Each seat's pty runs `/bin/bash -l`; its startup command is the tmux chain that creates a window
running the agent and then attaches:

```
tmux has-session -t lc-coding-team && tmux new-window -d -t lc-coding-team -n Coding "devin --permission-mode bypass" || tmux new-session …; … exec tmux attach -t …
```

So the agent's stdin is the tmux pane, and **the pty's output stream is a tmux client's redraw**,
not the agent's own output.

**That destroys readiness detection, for a reason the code already documents about devin.**
`ptyPromptDelivery.ts:28-38`:

> *"The floor is a flat `setTimeout`, NOT the signal-based readiness waiter: on a warm devin seat
> emitting **continuous redraw frames**, the quiet timer in `awaitFirstReadiness` resets on every
> frame and never fires, so reusing it would add 20s per delivery (the ceiling), not 15s (the
> floor)."*

The problem was identified for devin specifically. But a tmux **client** is a continuous redraw
source by construction — it repaints on any pane activity, status change, or resize. So every seat
projected through tmux presents the pattern that defeats the quiet timer, regardless of which CLI is
inside it. The three `agy` workers are in the same position as the `devin` lead.

**With no signal, everything falls back to a flat per-family floor** (`clearReadiness.ts`):

```
DEVIN_DEFAULT_TIMEOUT_MS        = 15000
CLAUDE_DEFAULT_TIMEOUT_MS       =  3000
ANTIGRAVITY_DEFAULT_TIMEOUT_MS  =  3000
unknown -> the devin floor (patient default)
```

So the lead waits a blind 15 s and the three `agy` workers wait a blind **3 s** — and a review round
dispatches to the workers. Three seconds, blind, is where this fails.

**Only the first dispatch of a work context clears, which is why only the first one fails.**
`TaskViewerProvider.ts:958`:

```js
if (lastTeamWorkKey === workContextKey) {
    payload = { ...payload, clearBeforePrompt: false };   // retry: no clear
} else {
    // New feature/work context enters the team: prepare entire roster barrier once
```

1. First dispatch — a review round is a **new** work context → the roster barrier clears **every**
   member, concurrently.
2. Delivery clears the target, waits the blind 3 s (agy), then pastes.
3. If the CLI has not finished re-rendering, the prompt merges onto the `/clear` line. `/clear` takes
   no arguments, so it is discarded — and the API has already returned success.
4. The retry matches the work key → `clearBeforePrompt: false` → no clear, no gate, prompt lands.
   **Second succeeds.**

**Step 3 is documented and reproduced.**
`a-dispatch-to-a-new-seat-waits-for-the-cli-not-for-silence.md` (COMPLETED, complexity 6) caught it
in a terminal log — `/clear` echoing before the banner painted, then both on one input line:

```
❯ /clear
YouareactingastheSwitchboardrevieweragent.
```

> *"`/clear` takes none — it wiped the (empty) session and discarded the prompt. `POST
> /kanban/dispatch` had already returned `{"success":true,…}`."*

**And 3000 ms is marginal on this box.** Measured today on the same host: a browser shell load
saturates one core for 2751 ms, with `/health` going from 37 ms to a 758 ms median and 1508 ms
worst case. The roster barrier clears four seats **concurrently**. A blind 3 s window under that
load is exactly the shape that works most of the time and fails often enough to notice — which
matches "often fails", not "always fails".

### Does this affect general sends?

Yes, but not as a failure. The floor is deliberately applied to **every** delivery, not only
clearing ones (`ptyPromptDelivery.ts:28-32`): *"a warm-seat delivery with no readiness gate still
waits as long as a cleared one."* So every prompt to these seats — a lead's report to a coder, a
coder's report back — pays 3 s or 15 s of flat wait with no confirmation of anything.

The failures cluster on **clearing** sends because only those need the CLI to be in a particular
state. A non-clearing send arrives at a live TUI that is happy to accept a paste, so a blind wait
costs latency and nothing else. Note that agent-to-agent reports set `clearBeforePrompt: false`
explicitly, and `bootstrap.ts:2541` records that an omitted value defaults to false — so the
routine traffic is safe and merely slow.

**Evidence not available, and why.** Host logging is off at the operator's instruction, so there is
no server log for the observed failures, and `plan_events` carries only activity-light
`start`/`stop` actions (7042 / 3123 rows) — no dispatch action, so no retry signature in the DB. The
delivery-path code and the clear-on-first-dispatch logic are established; the causal link to these
specific failures is inference. Change 4 makes the next occurrence self-evidencing.

**Two cards this bears on.** `a-seats-cli-family-is-frozen-at-spawn-so-devin-timing-fixes-never-reach-it.md`
(CODE REVIEWED, complexity 5) and `a-delay-setting-must-not-be-able-to-defeat-known-cli-readiness.md`
(CODE REVIEWED, complexity 4) are both about this timing family. Neither addresses the case where
the readiness *signal itself* is unavailable because tmux sits between the tracker and the CLI.
`a-prompt-reported-as-sent-can-vanish-before-reaching-the-seat.md` (PLAN REVIEWED, complexity 6) is
the unexplained "reported sent, never arrived" symptom; this is a candidate mechanism for it.

## Metadata

**Complexity:** 4
**Tags:** bugfix, prompt-delivery, tmux, teams, dispatch, readiness
**Dependencies:** related to the two CODE REVIEWED readiness cards above. Do not land another flat
timeout knob — that is the mistake `a-delay-setting-must-not-be-able-to-defeat-known-cli-readiness`
exists to prevent.

## User Review Required

None.

## Proposed Changes

### 1. Get a readiness signal that survives tmux

The tracker's input is wrong, not its logic. Options, in preference order:

- **Read the pane, not the client.** `tmux capture-pane -p -t <pane>` returns the pane's rendered
  text directly, bypassing the client redraw stream. Poll it only inside the clear window — the
  cost `tmuxBackend.ts:440` was avoiding is a *permanent* poller, which this is not.
- **Ask tmux instead of inferring.** `#{pane_current_command}` and `#{pane_in_mode}` are cheap
  format queries; a pane whose current command is the agent and which is not in copy-mode is a
  stronger signal than quiet on a redraw stream.
- **Do not** try to filter redraw frames out of the client stream to rescue the quiet timer. A
  status-line clock tick is indistinguishable from agent output at that layer.

### 2. Stop the roster barrier and the target's clear racing

- The barrier clears every roster member concurrently, then the dispatch clears the target and
  pastes. On a loaded Pi these overlap.
- Confirm the barrier's clears and the dispatch's delivery share the same per-seat lock. If they do
  not, that alone is sufficient to produce this symptom and is the cheapest fix in the plan.

### 3. Never report success for an unconfirmed delivery

- A clear whose readiness window expired without a signal must not return `success: true`. Return
  the uncertainty so the caller can retry deliberately.
- Today `bytesWritten` is `Buffer.byteLength(text)` (`ptyPromptDelivery.ts:366`) — the length of what
  was *attempted*, not a receipt. The standing orders tell leads *"bytesWritten is what was written
  to it"*, which overstates what that number knows. Either make it a receipt or stop describing it
  as one.

### 4. Make the next occurrence self-evidencing

- Record the delivery outcome per send — family, floor used, readiness seen or timed out, elapsed,
  whether a clear preceded it — as a `plan_events` row rather than a log line. It survives with the
  board, is queryable, and `RetentionService` prunes it.
- This is what makes the mechanism above falsifiable, and it closes the same gap that left
  `a-prompt-reported-as-sent-can-vanish-before-reaching-the-seat` unresolved.

### 5. Interim mitigation the operator can apply now

- Raise the antigravity floor from 3000 ms. `ClearReadinessTimeouts` already exposes per-family
  overrides (`antigravityTimeoutMs`), so this needs no code change. If the first-dispatch failures
  stop, the mechanism is confirmed.
- It is a diagnostic, not the fix: it adds latency to every send to those seats and still fails
  under enough load.

## Verification Plan

- Dispatch a review round to the team while the host is deliberately loaded (a browser shell load
  reproduces the 96%-of-a-core burst). The **first** dispatch lands.
- Repeat 20 times across new work contexts: zero lost prompts, and no `success: true` on a delivery
  whose readiness never arrived.
- With a working signal, the effective wait on an idle box drops well below the flat floor for both
  families — the pty path's own 2000 → 600 reduction is the precedent for what a real signal buys.
- A `plan_events` row exists per delivery recording the readiness outcome.
- A seat **not** inside tmux is unaffected; assert it, since both share the delivery caller.

## Outstanding Questions

- Does this reach every seat, not just team seats? All four of this operator's seats are projected
  through tmux by the global startup command (`startupCommandSource: global-file`), so the redraw
  problem is a property of the projection, not of teams. If the projection is the default, the
  readiness tracker has effectively never worked in this configuration — which would also explain
  why the per-family floors had to be raised to 15 s for devin in the first place.
