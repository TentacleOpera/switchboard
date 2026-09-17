# The Judge Rejects Answers It Asked For, and Cannot See a Stuck Input Line

## Goal

A judgement reply that names a valid class is accepted whether or not the model prefixed it with
`CLASS:`; a tail carrying no information yields `unknown` rather than a guess; and a seat whose
input line holds unsent text is a diagnosable state with a remediation that depends on what the text
says.

### Problem analysis

**Measured 2026-09-17** against `gemma4:e2b-it-qat` on **six real log tails** taken from this board's
own `.switchboard/logs/`, using the shipped system prompt from `controller.ts:810-818` verbatim.
Replies:

```
CLASS: idle
CLASS: crashed
idle                 <- rejected
idle                 <- rejected
finished-unreported  <- rejected
waiting-human        <- rejected
```

**1. Four of six valid answers are thrown away on formatting.**

`parseClassReply` (`classes.ts:84`) requires the prefix:

```js
const classMatch = text.match(/^[ \t]*CLASS:[ \t]*([A-Za-z-]+)[ \t]*$/m);
if (!classMatch) { return { ok: false, error: 'no CLASS: line in reply' }; }
```

A bare `crashed` on its own line is rejected as if the model had failed. The consequence is not a
wrong answer — it is a **wasted tier**. The reply is marked invalid, the ladder escalates to tier 2,
and a paid or rate-limited call is spent re-deriving a classification tier 1 had already reached
correctly. On this sample that is a 67% escalation rate caused entirely by punctuation.

The closed set is what carries the safety, and it still does: `JUDGEMENT_CLASSES` membership is
checked after extraction either way. Accepting a bare class weakens nothing — the prefix is a
formatting convention, not a guard. A model that replies `banana` is still rejected.

**Why no test caught it.** Fixtures are written by hand in the shape the prompt asks for. Only a
real small model, replying as small models actually reply, produces the bare form.

**2. A contentless tail produces a guess instead of `unknown`.**

One of the six tails was nothing but spinner fragments:

```
5
●
✻Noodling…
✶
```

`✻Noodling…` is an agent actively thinking. The model answered `idle`. There was no information in
that tail to support any class, and row 8 exists precisely for this — the plan for the judgement
tiers states *"Row 8 is load-bearing. Without an explicit `unknown` outcome the model is forced to
name a [row]."* The prompt never tells the model when to prefer it, so it does not.

Guessing `idle` here is the harmful direction: it is a *quiet* verdict about a seat that is working,
and the remediation for idle is a nudge — interrupting an agent mid-thought, which is the spam the
sparse-check design exists to avoid.

**3. A seat can hold unsent text in its input line, and nothing diagnoses it.**

Two shapes, both observed on this board:

- **A queued dispatch.** The CLI shows `❭ Press Enter to send queued messages now`. Switchboard
  pasted a prompt while the agent was mid-turn, so the CLI buffered it. It is not lost — it flushes
  at the next turn end — but the work that was dispatched has not started, and the delay is
  unbounded by anything except the agent's own next turn.
- **A stale command.** A clear that did not submit — a CLI update changes the submit key, or a
  paste lands a line break where an Enter was meant — leaves `/clear` or a fragment sitting in the
  input.

Both look identical to every existing signal: the process is alive, CPU is normal, bytes flowed
recently. Neither is any of the eight rows.

**The remediations are opposite, which is why this needs the model.**

| what the input line holds | correct action | wrong action costs |
| --- | --- | --- |
| a queued dispatch | **send Enter** — flush it now rather than waiting | Ctrl+U discards dispatched work |
| a stale or partial command | **send Ctrl+U** — cancel the entry | Enter executes something nobody asked for |

Telling them apart means reading the text. No threshold expresses it, and guessing wrong in either
direction is worse than doing nothing.

**These are underlying bugs and should be fixed at the source.** A dispatch that lands mid-turn
should not need rescuing, and a clear that does not submit is a delivery defect. This plan does not
excuse either. But both are reachable states today, they are silent, and the controller is the only
thing watching.

### What already works and must not be disturbed

- **The closed set.** `JUDGEMENT_CLASSES` membership is the validation. Nothing here loosens it.
- **Validate-and-reject.** An unparseable reply still means the rule did not run.
- **`ptyPromptDelivery.ts`** already owns `CLEAR_INPUT_LINE = '\x15'` (`:105`) and settles for
  `CLEAR_INPUT_SETTLE_MS` after writing it. The new remediation uses that existing path — it does
  not introduce a second way to write control characters to a pty.
- **`sendToTerminal`** is wired in the standalone host (`bootstrap.ts:2253`, `:3699`) and takes a raw
  `input` string.

### Non-goals

- **Loosening the closed set**, or accepting a class outside it.
- **Prompt engineering to force the prefix.** A worked example would probably fix the formatting,
  but it costs prefill on every call forever to work around a regex that could be one character
  more permissive.
- **Fixing the underlying delivery bugs.** They deserve their own plan; this one makes the states
  diagnosable while they exist.
- **Auto-pressing Enter on anything that looks pending.** The remediation is content-dependent by
  design, and a seat whose input line cannot be read confidently is `unknown`.

## Metadata

**Feature:** (unassigned)
- **Complexity:** 4
- **Tags:** backend, controller, terminals

## User Review Required

- **[user] Change 3 writes keystrokes into a live agent's terminal.** Sending Enter submits queued
  work; sending Ctrl+U destroys whatever was typed. Both are cheap when right and unrecoverable when
  wrong, and they act on a seat that may be mid-turn. Confirm that a model-judged remediation is
  allowed to do this at all — the alternative is that row 9 only ever reports, and a human presses
  the key.

## Complexity Audit

### Routine

- The parser change: one regex, plus a fallback for a bare class on its own line.
- A prompt line telling the model when to prefer `unknown`.

### Complex / Risky

- **Writing keystrokes to a live pty.** The existing clear path settles 30 ms after `\x15`; a
  remediation must use that path rather than writing directly, or the two races.
- **Reading the input line at all.** What the seat holds unsent is the *last* line of the rendered
  screen, which is exactly what the space-stripping defect damages. Row 9's evidence is the tail
  least likely to survive capture intact — see the log-tail plan; this row is weakest until that
  lands.

## Edge-Case & Dependency Audit

### Race Conditions

- **The turn ends between diagnosis and remediation.** The queue flushes on its own, and the
  controller's Enter then lands on an empty prompt — harmless, but the report must not claim it
  rescued anything. Re-read the line immediately before acting.
- **The agent is mid-render.** A tail sampled during a redraw can show a partial input line. Require
  the same content across two samples before acting, consistent with the frame-diff rule.

### Security

- **Ctrl+U destroys operator input.** If a human typed into that seat and walked away, the
  controller cancelling it is data loss with no undo. The report must record the discarded text so
  it is recoverable by hand.

### Side Effects

- **Accepting bare classes changes the escalation rate**, and therefore tier-2 spend — downward.
  Anything calibrated against the current (inflated) escalation volume will see it drop.

### Dependencies & Conflicts

- Row 9's evidence quality depends on the log-tail spacing fix. The parser and `unknown` changes are
  independent of it and can land first.
- Standalone only, per the cutover rule. `clearTerminalInputLine` in `terminalUtils.ts` is the legacy
  host's; `ptyPromptDelivery.ts` is the one to use.

## Adversarial Synthesis

The risk in change 1 is that leniency lets a malformed reply through — it does not, because set
membership is unchanged and is what was ever doing the work. The risk in change 3 is real and is why
it carries a User Review: a model with a 2B parameter budget deciding whether to press Enter or
Ctrl+U in a live terminal is a small model making an unrecoverable choice. The mitigation is that
`unknown` is always available and always safe, and the plan makes declining the default rather than
the exception. The risk in change 2 is nil.

## Proposed Changes

### 1. Accept a bare class on its own line

Extend `parseClassReply` to match a line that is exactly a class name, as a fallback when no
`CLASS:` line is present. Set membership is unchanged and still rejects anything outside
`JUDGEMENT_CLASSES`.

Keep asking for `CLASS:` in the prompt — the convention is useful when the model honours it, and a
`REASON:` line still needs somewhere to sit. This change only stops a correct answer being thrown
away for wearing the wrong hat.

### 2. Tell the model when to answer `unknown`

Add one line to the system prompt: that a tail carrying no diagnostic content — only spinner frames,
redraw fragments or an empty screen — is `unknown`, and that `unknown` is the correct answer rather
than a failure. Row 8 exists; the prompt never mentions it.

### 3. Row 9 — the input line holds text that nothing will send

**Signal:** the rendered last line shows pending input — a queued-message notice, or a non-empty
prompt line — unchanged across two samples.

**Decided by:** model. The evidence is the rendered input line plus the card.

**Remediation, chosen by what the line holds:**

| content | action |
| --- | --- |
| a queued dispatch awaiting submit | write `\r` via the existing delivery path |
| a stale or partial command | write `CLEAR_INPUT_LINE` (`\x15`) via the existing delivery path |
| anything the model cannot read confidently | `unknown` — report, act not at all |

The report records the text that was pending and which action was taken, so a wrong Ctrl+U is
recoverable by hand.

## Verification Plan

### Automated Tests

- **Bare class accepted.** `parseClassReply('crashed')` and `parseClassReply('  waiting-human  ')`
  return that class. `parseClassReply('CLASS: crashed')` is unchanged.
- **Bare junk still rejected.** `parseClassReply('banana')` and `parseClassReply('the seat is idle')`
  both fail — the second because it is not a line that is exactly a class.
- **Recorded replies.** The six real replies measured above are a fixture; all six parse.
- **Contentless tail.** A tail of only spinner glyphs yields `unknown` from the shipped prompt.
- **Row 9 remediation selection.** A queued-message tail selects `\r`; a tail showing a partial
  command selects `\x15`; an unreadable one selects neither and records `unknown`.
- **Two-sample requirement.** An input line seen once does not trigger row 9.
- **Delivery path.** Row 9 writes through `ptyPromptDelivery`, not directly to a pty handle.
- **Discarded text is recorded.** A `\x15` remediation writes the cancelled text into the report.

### Goal Invariants

- A reply naming a valid class is accepted with or without the `CLASS:` prefix.
- A reply naming anything outside the closed set is rejected, exactly as today.
- Tier 2 is never spent on a tier-1 reply that named a valid class.
- A tail with no diagnostic content yields `unknown`, never a guess.
- Row 9 never sends Enter to a line holding a stale command, and never sends Ctrl+U to a queued
  dispatch.
- Every row-9 action records the pending text it acted on.
- No control character reaches a pty except through the existing delivery path.

## Outstanding Questions

- **Should row 9 act at all, or only report?** See User Review. Reporting is safe and slow; acting is
  fast and occasionally unrecoverable.
- **Is the queued-message case worth acting on**, given it flushes at the next turn end anyway? The
  argument for is that "next turn end" is unbounded on a seat that is stuck for other reasons — the
  queue and the stall compound. The argument against is that it is the least harmful of all the
  states here.
- **How is the input line identified in a tail?** It is the last rendered line, which presumes the
  grid reconstruction from the log-tail plan. Before that lands, this row is guessing at a line whose
  spacing has been destroyed.
