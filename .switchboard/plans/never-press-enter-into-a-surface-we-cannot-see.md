# Never press Enter into a surface we cannot see — gate the submit CR on evidence of an input box

## Goal

Stop the delivery path from pressing Enter blind. Before submitting, require
evidence that the payload actually reached a text input; when that evidence is
absent, report a **drop** — do not press Enter into whatever is on screen. The
queue then does what it already does with a drop: **fails OPEN**, moving the work
to another seat, and stops only when no seat can take it.

**This plan is contingent, and the contingency is the first change in it.** The
signal the whole design rests on — that a live input box echoes a write and a
modal does not — was measured on the *rendered screen*, not on the byte stream a
delivery function can actually see. §1 measures it at the byte level and is a
**go/no-go**: if no rule separates the two states across the eight CLIs, §3 and §4
do not get built and this plan closes unbuilt. Every outcome is specified in §1's
decision table; nothing is deferred to a later design pass.

**Prevention ships first and separately.** `create-seats-already-consented.md`
carries it: a seat launched with the right flags never renders the prompt, so
there is nothing to detect, skip, answer or drop. That plan is cheaper, has no
runtime risk, and is the only available fix on the VS Code path. This plan is the
net underneath it, for prompts that appear because something *changed* — a CLI
that adds a prompt in an update (devin `3000.4.25 → 3000.5.20` did precisely
this), a ToS revision, an expiring login (a claude seat was showing `⚠ Your login
expires in 1 day · run /login to renew` during the measurement, which is this
case arriving on a timer). Flags set today cannot pre-answer a question invented
tomorrow.

### Scope: this gate covers the PTY path only, and that exclusion is permanent

`sendPromptToPty` (`src/standalone/ptyPromptDelivery.ts`) owns a pty master fd and
can subscribe to its output. The VS Code path cannot:
`_sendRobustTextBackground` (`src/services/terminalUtils.ts:292`, reached via
`:213`) delivers through `vscode.Terminal.sendText`, and **there is no API that
reads a terminal's output back.** `onDidWriteTerminalData` has never left proposed
status, so it is unavailable to a published extension, and nothing in this tree
uses `Terminal.shellIntegration` — which in any case only exposes output for
commands it launched itself, not for an interactive TUI's screen.

So on the extension path the blind CR (plus the confirm Enter that
`terminalUtils.ts:220` gives CLI-named terminals) stays exactly as it is, and
prevention is the only fix that reaches it. State this rather than let a reader
infer from the Goal Invariants that the hazard is closed everywhere.

### Problem Analysis

Agent CLIs put modal surfaces in front of the input box. The delivery path knows
two things about a seat — `status` and `lastDataAt` (`ptyFleetService.ts:95-107`)
— and neither says what the seat is showing. The only readiness logic on the path
is a fixed 750 ms sleep before typing the *startup command*
(`SHELL_READINESS_DELAY_MS`, `ptyFleetService.ts:14`), which is about the shell,
not the CLI.

So `sendPromptToPty` writes a bracketed-paste block into whatever is there, then
presses Enter twice, unconditionally (`:142`, `:145`), and returns `void` — no
readback, no failure signal. The card advances (columns advance when work
*starts*), and the board reads "coding".

**The blind CR is not a theoretical hazard. Measured 2026-08-23 across eight
installed CLIs, one pty session each, nothing submitted:**

| CLI | state reached | lone CR into it |
|---|---|---|
| gemini | ToS consent, `● 1. Yes / 2. No`, "Enter to select" | **selected "1. Yes"** |
| qwen | ToS gate | **advanced into the auth-method picker** |
| droid | `> Login / Exit` | **started the device-auth flow, printed a device code** |
| claude, devin, agy, copilot | normal input box, empty | nothing visible |
| grok | rendered blank — no data | nothing visible |

Three of eight, when showing a modal, treated a bare `\r` as "take the highlighted
option". Switchboard sends **two** CRs per prompt dispatch and one per slash
command, so this is a design that votes on dialogs it cannot see.

**Post-turn feedback prompts do NOT steal the input box — and a folder-trust
prompt does.** Measured the same day with one real trivial request per CLI ("reply
with the single word: pong"), then typing into whatever was on screen afterwards:

| CLI | after the turn | typing afterwards |
|---|---|---|
| claude | clean box, no prompt | echoes |
| devin | clean box; the rating hint lives in the footer | echoes |
| agy | clean box | echoes |
| grok | **telemetry-consent banner** — "Help improve Grok `[Opt out] [Opt in]`" | echoes — the banner sits ABOVE a live input box |
| copilot | never reached a turn: **folder-trust prompt on spawn** — `1. Yes / 2. Yes, and remember this folder / 3. No (Esc)` | no echo |
| gemini, qwen, droid | ToS / login gates | no echo |

Two conclusions. The frequent case is benign in the way that matters: a post-turn
consent banner is *drawn above* a working input box, so a payload lands and
submits normally. And the surfaces that actually stole the box were ToS consent,
login and an auth picker — states only a human can clear, where moving the work
elsewhere is exactly the right response.

**The ESC idea is dead, by measurement.**

| CLI | ESC on an empty idle box | single ESC after typing text |
|---|---|---|
| claude | no-op | **text survives** |
| devin | no-op | **text survives** |
| agy | screen changed | **text survives** |
| copilot | screen changed | **echoes a literal `^[` into the input box** |

ESC clears the input on no CLI that echoed text, so it buys nothing Ctrl+U does
not already give (and Ctrl+U already ships). And copilot renders it as `^[` inside
the payload, corrupting the prompt. Do not add ESC to the delivery path.

**`/clear` is not the escape hatch — it is a payload, not a key.** Against
copilot's folder-trust menu the `/clear` text produced **zero visible change**;
against grok's non-blocking banner it reset the context and the banner survived.
So `clearBeforePrompt` is part of the hazard: with it at its default `true`, one
dispatch fires **three** Enters at a blocking menu — one from
`writeSlashCommandLocked` (`ptyPromptDelivery.ts:71`) and two from the prompt path.
The gate therefore covers the slash-command path too, not only the prompt path.

**What the measurement handed us is the signal worth testing.** The four CLIs at a
real input box echoed the typed text into it; the three at a modal did not. Echo
presence *is* the "am I at an input box" probe — no pattern list, no per-CLI
knowledge, no static allowlist pretending to be a runtime check. The seam exists:
`handle.onData(cb)` returns a disposable (`ptyBackend.ts:107-110`) on the very
handle `sendPromptToPty` holds, and the fleet already runs its own subscription on
it (`ptyFleetService.ts:454`).

### But that signal was measured on the screen, not on the stream

The probes read *rendered* text. A delivery function sees bytes. Nothing has
measured whether a modal emits any bytes in response to a write, nor whether a
healthy CLI's echo contains the payload at all. §1 closes that gap before §3 is
written, and may close this plan instead.

## Metadata

**Complexity:** 5
**Tags:** reliability, cli, infrastructure
**Project:** Browser Switchboard

## Dependencies

- `create-seats-already-consented.md` — the prevention half. Ships first and
  independently; this plan does not block on it and it does not block on this one.
- `feature_plan_20260807103200_pty-screen-state-idle-detection-headless-vt.md` —
  referenced only by §1's decision table as the home of the screen-diff option and
  its already-completed `@xterm/headless` dependency research. Not a prerequisite.

## User Review Required

None.

## Proposed Changes

### 1. Measure the echo signal at byte level — go/no-go for the rest of this plan

Extend the probe harness (moved into `scripts/` by the prevention plan) to record,
per CLI and per state, the raw bytes emitted in the 400 ms after a bracketed-paste
write, plus whether a 20-char tail fragment of the payload appears in them. Eight
CLIs × two states (healthy input box, blocking modal). **No prompt is ever
submitted.**

Two candidate rules:

- **(A) Silence rule** — submit only if the payload write produced *any* output
  within the window. Cheap and robust to styling. Fails toward *submit*: a CLI
  that repaints on a timer produces output regardless of our write, so the gate
  silently provides no protection there. Note that idle repainting is a per-CLI,
  per-version property and not a given — Claude Code v2.1.170+ removed idle
  re-renders specifically to cut idle CPU, so bytes *do* stop at an idle prompt on
  current versions.
- **(B) Fragment rule** — submit only if a short tail fragment of the payload
  appears in the echoed bytes. Directly tests the thing we care about. Fails
  toward *drop*, which blocks legitimate dispatches.

**Two probe cases the earlier draft did not have. Both are load-bearing.**

1. **Does claude echo a dispatch-sized payload at all?** Claude Code collapses a
   multi-line paste into a placeholder (`[Pasted text #1 +N lines]`) rather than
   rendering the text. The pty path does **not** flatten newlines — unlike the VS
   Code path, which does at `terminalUtils.ts:244` — so real dispatch payloads
   reach claude as multi-line pastes. If the placeholder is what the stream
   carries, rule B reports "no echo" on a perfectly healthy claude seat, and B is
   dead on the most-used CLI at the payload sizes Switchboard actually sends.
   Probe with a genuine dispatch payload, not a short string.
2. **Is the payload write itself inert at a numbered menu?** The gate writes the
   payload and *then* decides, so the write must be harmless. This is measured for
   gemini (8 characters into its ToS menu changed nothing) but **not** for
   copilot, where the record says only *no echo* — which is not *no effect*. Its
   menu is `1. Yes / 2. Yes, and remember this folder / 3. No`. Write the single
   character `1` at that menu and record whether the highlighted option moves. If
   a digit key selects, write-then-check is itself the hazard this plan exists to
   remove.

**Decision table. Record the numbers in the code comment, or record the closure
in this file — this file's `/clear` history is what happens when a byte-level rule
is documented as a theory instead of a measurement.**

| Measurement outcome | What ships |
|---|---|
| Probe case 2 shows the payload write selects a menu option on any CLI | **Close unbuilt.** The design's ordering is unsafe and no rule fixes it. Prevention is the whole answer. |
| A separates both states on all 8 CLIs | Implement **A** via `lastDataAt` (§3) — strictly less machinery than a subscription. |
| A does not separate (some CLI emits output regardless of input); B separates on all 8, claude included | Implement **B** via an `onData` subscription (§3). |
| Both separate | Implement **A**. Same protection, less code. |
| Neither separates | **Close unbuilt.** Ship prevention only. Do **not** fall through to a third mechanism in this pass: the screen-diff option (feed the stream to `@xterm/headless` and compare rendered frames — which is what the original probes actually measured) is a separate plan with its own dependency and staleness cost, and the headless-VT plan above already carries that research. |

### 2. A missing echo is a SEAT verdict, never a QUEUE verdict

The whole design hinges on this and an earlier revision got it wrong. "No
evidence" must not stall work. A rating prompt or a stale confirm on one seat is
not a reason for the queue to stop, and a delivery gate that wedges the pipeline
on a cosmetic prompt is a worse bug than the blind Enter it prevents.

This is already settled doctrine here, not a new principle:

> "The queue uses this to fail OPEN — a drop must advance to the next plan, never
> wedge waiting for a callback that cannot come." — `TaskViewerProvider.ts:6244`,
> and again at `:6465`.

So a missing echo produces exactly what "no terminal running" already produces — a
**drop**, reported to the caller, which the queue treats as fail-open:

1. **The work moves.** Another seat in the pool, or the next plan. It never waits
   on the seat that dropped it.
2. **No quarantine flag — the gate IS the probe, re-evaluated per dispatch.** An
   earlier draft said to flag the seat and lift the flag "once the seat resumes
   producing output". Wrong twice: a seat parked at a trust menu is **static** and
   emits nothing while it waits, so that condition never arrives without a human;
   and **nothing in this codebase replaces a seat** — `ptyFleetService` reuses
   shared members but never respawns one, and the only respawn logic in the tree is
   a server watchdog explicitly guarded against looping. A flag would shrink the
   pool by one, permanently, per incident.

   So hold **no persistent state**. Each dispatch runs the gate afresh: a blocked
   seat costs one echo window and is dropped again; a seat whose prompt a human
   cleared works on the next dispatch. Nothing to set, nothing to expire.

   **And do not auto-replace the seat.** For the measured case a fresh seat hits
   the *same* folder-trust prompt — trust is asked per folder — so "replace the
   unusable seat" is an infinite spawn/block/drop loop.
3. **The payload stays visible in the seat, and the seat's badge lights.** The
   payload is the human's cue for what was pending. For "which seat needs me",
   reuse the existing per-terminal badge (`terminals.js:228`, fed by WS pushes,
   already the agent-completed signal), driven off the drop event as it is
   delivered. This is the one piece of state the design keeps, and it is the same
   shape the badge already has — a transient signal pushed to the UI, not a
   lifecycle flag the dispatch path reads back. Nothing on the delivery path may
   consult it; if anything does, it has become the quarantine flag §2.2 rejects.
4. **The real cure for the measured case is one human action, not machinery.**
   Choosing "2. Yes, and remember this folder" once, or configuring the flag from
   the prevention plan, removes the entire class for that CLI and folder.
5. **The card does not advance to a working column** — the work was not delivered,
   and a card reading "coding" on a seat sitting at a login prompt is the failure
   this plan exists to remove.

### 3. Gate the submit CR — contingent on §1

Inside `sendPromptToPty`, still under the per-terminal lock:

1. **Rule A:** snapshot `handle.lastDataAt` before the open marker. No new
   subscription — `ptyFleetService.ts:454` already runs a fleet-owned
   `handle.onData(() => { handle.lastDataAt = Date.now(); })`, independent of the
   gateway, live even when `ptyReady === false`. This removes the subscribe/dispose
   dance, the leak, and the stub-`onData` work from the test surface entirely.
   **Rule B:** subscribe via `handle.onData` **before** the open marker (a
   subscription started after the write can miss a fast echo) and dispose it on
   every path.
2. Write the framing and payload exactly as today. The framing contract is
   byte-identical to `_sendRobustTextBackground` and does not change.
3. After the close marker, wait `ECHO_WINDOW_MS` (start from `SUBMIT_SETTLE_MS`'s
   scale; §1's measurement sets the real value), then apply the chosen rule.
4. **Evidence present:** submit as today — `\r`, `CONFIRM_ENTER_DELAY_MS`, `\r`.
5. **Evidence absent:** write **nothing further**. Do not press Enter, do not send
   ESC, do not attempt to dismiss anything — every key we could send is the hazard
   this plan exists to remove. Leave the payload in place and report a drop.

`sendPromptToPty` returns `Promise<void>` today, which cannot express "not
delivered". Give it a delivery result (`{delivered: boolean, reason?:
'no-input-box-echo'}`) rather than a throw: a throw reads as an error to every
caller, and this is a *routing* outcome. The standalone chokepoint is
`deliverPrompt` (`bootstrap.ts:268`, calling through at `:422`) — the result must
propagate through it, not be swallowed there. The verb layer surfaces it
(`ptyHost.ts:269` returns `{success:false,error}`; `sendToTerminal` returns the
real error rather than a false success), and the queue path treats `delivered:
false` exactly as it treats a dropped Phone-a-Friend dispatch: advance, do not
wedge.

**Apply the same gate to `writeSlashCommandLocked`.** Not conditional:
`clearBeforePrompt` defaults to true, so the slash path fires the *first* of the
three Enters a dispatch aims at a blocking menu, and gating only the prompt path
would leave that one live.

One asymmetry to preserve: a **user-initiated** clear (the frame or sidebar
button, via `clearPty`) should still write its payload and simply not submit when
there is no echo, leaving the text visible — the human is right there. Only the
dispatch path converts that into a reported drop.

### 4. Stop when the pool is exhausted — do not burn the plan list

Fail-open routes around *one* blocked seat. It must not route around *every* seat
in turn: a queue that advances through thirty plans reporting thirty drops has
delivered nothing while looking busy, and §2.5 means none of those cards advance.

So the pump's terminus is explicit: **when every candidate seat for a plan has
reported `delivered: false`, stop and report once, naming the seats — do not
advance to the next plan.** Nothing is lost (no plan is consumed, no card moves);
the queue simply stops trying to hand work to a fleet that cannot take it.

This is not a new concept — it is where fail-open already has to end — and it
doubles as the only detector for the failure mode §1 cannot fully exclude. If
rule B has a false negative on some CLI or payload shape, the symptom is every
seat dropping, and this is what turns thirty silent drops into one message a human
can act on. Without it, a wrong rule degrades invisibly.

### 5. No retry, no auto-dismiss, no modal detector

Stated explicitly because all three are the tempting next step:

- **No pattern matching on screen text.** Matching "Do you want to proceed" /
  "(y/n)" / "Press esc" across 19 CLIs that redesign their prompts freely is
  `CLI_AGENT_REGEX` again — a static list standing in for a runtime question,
  which this path has already made once and deleted
  (`ptyPromptDelivery.ts:126-131`).
- **No auto-answer, ever — this is the line.** The same widget shape carries "do
  you trust the files in this folder?" and "delete these files?", and nothing on
  screen distinguishes them. Pre-consenting a known question at spawn time is a
  decision the user makes once, with the question in front of them; answering an
  unread dialog at dispatch time is a decision made by a component that cannot
  read it. Not the same act, and they must not share a mechanism.
- **No retry, of any shape.** Proposed and then killed by measurement, so do not
  re-propose it. The appeal was "the first send's keystrokes will dismiss a
  feedback prompt, so a second send lands clean" — but the prompts that block the
  input box are trust/auth menus, and typing does not clear those (8 characters
  into gemini's ToS menu changed nothing), while the prompts typing *might* clear
  turn out not to block the box at all (grok's banner sits above a live input). A
  retry that *included* the Enter would be worse than useless: what "clears" a
  menu is answering it, so the retry succeeding is exactly what would make an
  accidental consent look like the system working.
- **Reassignment is not a retry.** The work goes to a *different* seat
  immediately, which is why nothing stalls.

### Migration

None. Runtime delivery behaviour only — no persisted state, no config keys, no
on-disk format.

## Verification Plan

### Goal Invariants

- No CR is written to a **pty** unless the same delivery call saw evidence the
  payload reached an input box. (The VS Code path is out of scope — see Scope.)
- A dispatch into a seat showing a modal reports a drop and the queue advances to
  another seat. No seat is flagged, disabled or replaced — the next dispatch
  re-probes it and succeeds the moment a human has cleared the prompt.
- No single seat's screen state can stall the queue; a fleet in which no seat can
  take work stops the queue with one report rather than draining the plan list.
- A dispatch into a normal seat behaves byte-identically to today, including the
  framing and both CRs.
- No ESC is ever written on the delivery path.
- No Enter is written by `clearBeforePrompt` either — the slash path is gated on
  the same evidence as the prompt path.

### Automated Tests

Extend `src/test/pty-prompt-delivery-framing.test.js`, whose stub handle already
records every write (`:102-112`). Rule A needs the stub to carry a mutable
`lastDataAt`; rule B needs an `onData` the test drives.

- **Echo present → today's byte sequence, unchanged.** Assert the write sequence
  still equals `expectedWrites(text)` for the existing parameterised lengths. This
  is the no-regression gate and it must stay byte-exact.
- **Echo absent → no CR at all.** Assert the writes end at the close marker and
  `writes.filter(w => w === '\r').length === 0`.
- **The drop is reported, not thrown.** Assert the call **resolves** with
  `{delivered: false}` and a reason naming the seat. It must not reject: every
  existing caller treats a rejection as an error, and this is a routing outcome.
- **The drop survives the chokepoint.** Assert `deliverPrompt` returns the
  `delivered: false` result rather than swallowing it — a `Promise<void>` seam
  where a no-op is indistinguishable from wired is exactly how this kind of change
  goes green while doing nothing.
- **The queue fails open on a drop:** assert the pump advances to another seat,
  mirroring the existing dropped-dispatch test for Phone-a-Friend. This is the
  assertion that would have caught the earlier revision of this plan.
- **The pump stops when the pool is exhausted:** assert that when every candidate
  seat reports `delivered: false`, the queue stops with one report and does **not**
  consume the next plan.
- **No ESC on the path:** assert no write equals or contains `\x1b` other than the
  two paste markers — a standing guard against the idea this plan rejects.
- **Rule B only — the subscription is disposed on every path**, including the
  no-echo path (a leaked `onData` per dispatch is a slow leak on a long-lived
  host). Not applicable under rule A, which adds no subscription.
- **One attempt, then a drop:** assert a silent stub produces exactly one payload
  write, zero `\r`, and `delivered: false`.

### Manual Verification

1. A normal dispatch to a claude and a devin seat — unchanged behaviour, and the
   payload submits.
2. A dispatch carrying a full-size multi-line plan prompt to a claude seat
   submits. This is §1's probe case 1 re-checked end to end; it is the false
   negative most likely to reach users.
3. Put a seat at a modal deliberately (spawn `gemini` with no accepted ToS, or
   `droid` logged out) and dispatch: the ToS menu is **not** answered, the payload
   stays visible in the seat, the seat's badge lights, and the queue keeps working
   on other seats. Nothing about the seat is disabled.
4. With a queue of 3 plans and one blocked seat among several healthy ones,
   confirm all 3 complete on the remaining seats — no stall.
5. Clear the blocked seat's prompt by hand, dispatch again, and confirm it takes
   work immediately with no un-sticking step.
6. Block **every** seat, dispatch a queue of 3, and confirm the queue stops with
   one report naming the seats — and that no card advanced and no plan was
   consumed.
7. Confirm the drop is visible where a user looks — not only in the output channel.
