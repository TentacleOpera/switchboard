# Never press Enter into a surface we cannot see — gate the submit CR on evidence of an input box

## Goal

Stop the delivery path from pressing Enter blind. Before submitting, require evidence that the payload actually reached a text input; when that evidence is absent, report a **drop** — do not press Enter into whatever is on screen. The queue then does what it already does with a drop: **fails OPEN**, moving the work to another seat or the next plan, and quarantines the seat that could not take it. Turns two silent failure modes — a swallowed prompt reported as success, and an Enter that answers a modal nobody read — into one visible, non-blocking drop.

**But the gate is the second half of the fix, not the first.** A net that catches blocked seats does not keep automation running; it only stops it corrupting things on the way down. The first half is **prevention**: create seats already-consented, so the blocking prompts never render. §1 below is that half, and it is the part that actually preserves throughput. Ship it first; it is also the cheaper of the two.

### Problem Analysis

Agent CLIs put modal surfaces in front of the input box: permission prompts, trust prompts, ToS acceptance after an update, re-auth after token expiry, feedback/rating prompts. Nothing in Switchboard anticipates this. The delivery path knows two things about a seat — `status` (`active`/`exited`) and `lastDataAt` (`ptyFleetService.ts:104-108`) — and neither says what the seat is showing. The only readiness logic on the path is a fixed 750 ms sleep before typing the *startup command* (`SHELL_READINESS_DELAY_MS`, `ptyFleetService.ts:14`), which is about the shell, not the CLI.

So `sendPromptToPty` writes a bracketed-paste block into whatever is there, then presses Enter twice, unconditionally, and returns `void` — no readback, no failure signal. The card advances (columns advance when work *starts*), and the board reads "coding".

**The blind CR is not a theoretical hazard. Measured 2026-08-23 across eight installed CLIs, one pty session each, nothing submitted:**

| CLI | state reached | lone CR into it |
|---|---|---|
| gemini | ToS consent, `● 1. Yes / 2. No`, "Enter to select" | **selected "1. Yes"** |
| qwen | ToS gate | **advanced into the auth-method picker** |
| droid | `> Login / Exit` | **started the device-auth flow, printed a device code** |
| claude, devin, agy, copilot | normal input box, empty | nothing visible |
| grok | rendered blank — no data | nothing visible |

Three of eight, when showing a modal, treated a bare `\r` as "take the highlighted option". Two of those choices are consequential (accepting terms, starting an auth flow). Switchboard sends **two** CRs per prompt dispatch and one per slash command, so this is not an edge the current design merely tolerates — it is a design that votes on dialogs it cannot see.

The states in the table are first-run/auth gates, and a working fleet's seats are authenticated. That does not retire the hazard: these gates reappear exactly when a CLI updates itself — the devin `3000.4.25 → 3000.5.20` update that broke slash-command submission the same day is the existence proof that CLIs change what is on screen without warning.

**Post-turn feedback prompts do NOT steal the input box — and a folder-trust prompt does.** Measured 2026-08-23 with one real trivial request per CLI ("reply with the single word: pong"), then typing into whatever was on screen afterwards:

| CLI | after the turn | typing afterwards |
|---|---|---|
| claude | clean box, no prompt | echoes |
| devin | clean box; the rating hint lives in the footer | echoes |
| agy | clean box | echoes |
| grok | **telemetry-consent banner** — "Help improve Grok `[Opt out] [Opt in]` … Read Terms and Privacy Policy" | echoes — the banner sits ABOVE a live input box |
| copilot | never reached a turn: **folder-trust prompt on spawn** — `1. Yes / 2. Yes, and remember this folder / 3. No (Esc)`, "Enter to select" | no echo |
| gemini, qwen, droid | ToS / login gates | no echo |

Two conclusions. First, the frequent case is benign in the way that matters: a post-turn consent banner (grok) is *drawn above* a working input box, so a payload lands and submits normally and the gate never trips. Second, and worse than the first-run gates: **copilot showed a folder-trust prompt on spawn in this repo**, with "1. Yes" pre-highlighted and "Enter to select". A dispatch into that seat today writes the payload nowhere and then presses Enter twice — accepting folder trust on the user's machine. That is not a contrived state; it is what a fresh copilot seat looks like in normal use.

The probe also validated the gate itself before a line of it was written: it refused to send the real request to copilot precisely because the request never echoed.

**`/clear` is not the escape hatch — it is a payload, not a key.** Measured 2026-08-23:

- **Against grok's consent banner** (non-blocking): `/clear` reset the context — a new session id was printed — and the banner **survived the redraw**. `/clear` does not dismiss it. Harmless, because the box was live before and after.
- **Against copilot's folder-trust menu** (blocking): the `/clear` text produced **zero visible change**. Not a partial landing, not a stray character — nothing. It needs the very input box it is supposed to rescue.

This closes the "just `/clear` first" idea, and it also makes `clearBeforePrompt` part of the hazard rather than a mitigation. Count the Enters a single dispatch fires into copilot's trust menu today, with `terminal.clearBeforePrompt` at its default `true`: **one** from `writeSlashCommandLocked`'s submit, then **two** from the prompt path. Three Enters at a menu that labels itself `❯ 1. Yes … ↑↓ to navigate · Enter to select`. (That Enter selects "Yes" is the menu's own label, not something this probe verified — the CR was deliberately never sent.)

Consequence for the design: the gate covers the slash-command path too, not only the prompt path. The earlier draft made that conditional on slash commands echoing reliably; they do — `/clear` visibly took effect on a healthy grok seat, and typed text echoed on every healthy seat measured — while a blocking surface produced no change whatsoever, which is the cleanest possible signal.

**The ESC idea is dead, by measurement.** The intuitive fix — send the ESC the CLI tells a human to press, then deliver — fails on both halves:

| CLI | ESC on an empty idle box | single ESC after typing text |
|---|---|---|
| claude | no-op | **text survives** |
| devin | no-op | **text survives** |
| agy | screen changed | **text survives** |
| copilot | screen changed | **echoes a literal `^[` into the input box** |

ESC does not clear the input on any CLI that echoed text, so it buys nothing we do not already get from Ctrl+U (which does work, and already ships). And it is not free: copilot renders it as `^[` inside the payload, corrupting the prompt. Do not add ESC to the delivery path.

**What the same measurement handed us is the signal worth building on.** The four CLIs sitting at a real input box echoed the typed text into it; the three sitting at a modal did not. Echo presence *is* the "am I at an input box" probe — no pattern list, no per-CLI knowledge, no static allowlist pretending to be a runtime check. The seam already exists: `handle.onData(cb)` returns a disposable (`ptyBackend.ts:108`) on the very handle `sendPromptToPty` holds.

## Metadata

**Complexity:** 6
**Tags:** reliability, cli, infrastructure
**Project:** Browser Switchboard

## User Review Required

None.

## Proposed Changes

### 1. Prevention: create seats already-consented (do this first — it is the actual solution)

Every CLI measured showing a blocking prompt has a documented way to not ask, and they all land in the same place: `agentStartupCommands[role]`, the per-role invocation string already injected at spawn by `injectStartupCommand` (`ptyFleetService.ts:461-473`). A seat launched with the right flags never renders the prompt, so there is nothing to detect, skip, answer or drop.

| CLI | what it blocked on | pre-consent surface |
|---|---|---|
| copilot | folder-trust menu on spawn | `--allow-all-paths` ("disable file path verification"), `--allow-all`, env `COPILOT_ALLOW_ALL` |
| gemini | ToS / workspace trust | `--skip-trust` ("trust the current workspace for this session"), `--approval-mode` |
| claude | (its `--help` documents a workspace trust dialog and trusted-directories settings) | `--permission-mode`, settings-based trusted directories |
| qwen | ToS notice | `--approval-mode`; `telemetry.enabled` in settings.json |
| droid | account login | out of scope — auth is a human action, not a flag |

Two things to get right, and they are judgement calls rather than mechanics:

- **Do not silently widen permissions on the user's behalf.** `--allow-all` and `--dangerously-skip-permissions` are not the same kind of flag as `--skip-trust`: one pre-answers "is this folder yours", the other pre-answers "may I run anything". Default the *trust* half, surface the *permission* half as an explicit per-role choice with its own label, and never fold the second into the first because they happen to silence the same prompt.
- **Verify each flag actually suppresses the prompt** rather than assuming from the help text. `--allow-all-paths` is described as disabling path verification, which is probably but not certainly the same gate as the trust menu. One spawn per CLI with the flag set answers it — the harness in this plan's Verification section already does exactly this.

Note what prevention does NOT cover, which is why §2's gate still earns its place: prompts that appear because something *changed*. A CLI that adds a prompt in an update (devin `3000.4.25 → 3000.5.20` did precisely this), a ToS revision, or an expiring login — a claude seat was showing `⚠ Your login expires in 1 day · run /login to renew` during the measurement, which is this case arriving on a timer. Flags set today cannot pre-answer a question invented tomorrow.

### 2. A missing echo is a SEAT verdict, never a QUEUE verdict

The whole design hinges on this and an earlier revision of this plan got it wrong. "No evidence" must not stall work. A rating prompt, a tip banner or a stale confirm on one seat is not a reason for the queue to stop, and a delivery gate that wedges the pipeline on a cosmetic prompt is a worse bug than the blind Enter it prevents — it trades a rare wrong keystroke for a common stall.

This is already settled doctrine in this codebase, not a new principle:

> "The queue uses this to fail OPEN — a drop must advance to the next plan, never wedge waiting for a callback that cannot come." — `TaskViewerProvider.ts:6182`, and again at `:6372`.

So a missing echo produces exactly what "no terminal running" already produces — a **drop**, reported to the caller, which the queue treats as fail-open:

1. **The work moves.** The queue advances: another seat in the pool, or the next plan. It never waits on the quarantined seat.
2. **No quarantine flag — the gate IS the probe, re-evaluated per dispatch.** An earlier draft of this plan said to flag the seat and let the flag lift "once the seat resumes producing output". That is wrong twice over, and it is the difference between a skipped seat and a dead one:

   - A seat parked at a trust menu is **static**. It emits nothing while it waits, so "resumes producing output" never happens without a human, and the flag would never lift on its own.
   - **Nothing in this codebase replaces a seat.** There is no respawn path — `ptyFleetService` reuses shared members but never respawns one, and the only respawn logic in the tree is a server watchdog explicitly guarded against looping. So a quarantine flag shrinks the pool by one, permanently, per incident, arriving at the same stall by a slower and less diagnosable route.

   So hold no state at all. Each dispatch runs the gate afresh: a blocked seat costs one echo window (~300 ms) and is dropped again; a seat whose prompt a human cleared simply works on the next dispatch. Nothing to set, nothing to expire, no dead state to escape. This is strictly less machinery than a flag, not more.

   **And do not auto-replace the seat.** For the measured case a fresh seat hits the *same* folder-trust prompt — trust is asked per folder — so "replace the unusable seat" is an infinite spawn/block/drop loop. Replacement is the intuitive move and it is the worst available one.
3. **The payload stays visible in the seat, and the seat's badge lights.** The payload is the human's cue for what was pending. For "which seat needs me", reuse the existing per-terminal badge (`terminals.js:228`, fed by WS pushes, already the agent-completed signal) — derived from the last drop, not a new lifecycle state.

4. **The real cure for the measured case is one human action, not machinery.** Choosing "2. Yes, and remember this folder for future sessions" once, or pre-trusting the folder via the seat's startup command, removes the entire class for that CLI and folder. No gate design beats answering the question once, and the plan should say so rather than implying the gate is a substitute.
5. **The card does not silently advance to a working column** — the work was not delivered, and a card that reads "coding" on a seat sitting at a login prompt is the failure this plan exists to remove.

Note also what the measurement suggests about frequency: devin's rating prompt is a **footer hint** ("Press opt+↑/opt+↓ to rate a response") that leaves `❭` accepting and echoing text, so the gate never trips on it. The surfaces that actually stole the input box in the run were ToS consent, login and an auth picker — states only a human can clear, where moving the work elsewhere and flagging the seat is exactly the right response. Whether that generalises across CLIs is worth one more probe run, because it decides how often this path is taken.

### 3. Measure the echo signal and pick the decision rule from data

The probe above measured *rendered screen* text, not the byte stream a delivery function can see, and it did not record whether a modal emits any bytes at all in response to a write. Two candidate rules, and the data decides:

- **(A) Silence rule:** submit only if the payload write produced *any* output within the window. Cheap and robust to styling, but only correct if modals are genuinely silent on input — unmeasured, and a filter-list modal probably is not.
- **(B) Fragment rule:** submit only if a short tail fragment of the payload appears in the echoed bytes. Directly tests the thing we care about, but risks false negatives when a TUI redraws with escapes interleaved between characters — and a false negative blocks a legitimate dispatch, which is worse than the bug for anyone not hitting a modal.

Extend the existing scratchpad harness (`esc-semantics-probe.js`) to record, per CLI and per state, the raw bytes emitted in the 400 ms after a bracketed-paste write plus whether a 20-char tail fragment appears in them. Eight CLIs × two states; no prompt is ever submitted. Pick A, B, or "B with A as the fallback when the fragment is absent but output occurred" from that table, and record the numbers in the code comment — this file's `/clear` history is what happens when a byte-level rule is documented as a theory instead of a measurement.

### 4. `src/standalone/ptyPromptDelivery.ts` — gate the submit CR

Inside `sendPromptToPty`, still under the per-terminal lock:

1. Subscribe via `handle.onData` **before** the open marker (a subscription started after the write can miss a fast echo).
2. Write the framing and payload exactly as today — the framing contract is byte-identical to `_sendRobustTextBackground` and does not change.
3. After the close marker, wait `ECHO_WINDOW_MS` (start from `SUBMIT_SETTLE_MS`'s scale; the measurement sets the real value), then dispose the subscription and apply the chosen rule.
4. **Evidence present:** submit as today — `\r`, `CONFIRM_ENTER_DELAY_MS`, `\r`.
5. **Evidence absent:** write **nothing further**. Do not press Enter, do not send ESC, do not attempt to dismiss anything — every key we could send is the hazard this plan exists to remove. Leave the payload in place and report a drop.

`sendPromptToPty` returns `Promise<void>` today, which cannot express "not delivered". Give it a delivery result (`{delivered: boolean, reason?: 'no-input-box-echo'}`) rather than a throw: a throw reads as an error to every caller, and this is a *routing* outcome — the same shape `_dispatchWithReport` already returns so the queue can fail open (`TaskViewerProvider.ts:6178-6183`). The verb layer surfaces it (`ptyHost.ts` returns `{success:false,error}`; `sendToTerminal` returns the real error rather than a false success), and the queue path treats `delivered: false` exactly as it treats a dropped Phone-a-Friend dispatch: advance, do not wedge.

**Apply the same gate to `writeSlashCommandLocked`.** This is no longer conditional: `clearBeforePrompt` defaults to true, so the slash path fires the *first* of the three Enters a dispatch aims at a blocking menu, and gating only the prompt path would leave that one live. The false-negative worry that made it conditional is settled — slash commands echo on healthy seats, and a blocking surface swallows them with zero screen change.

One asymmetry to preserve: a **user-initiated** clear (the frame or sidebar button) should still write its payload and simply not submit when there is no echo, leaving the text visible — the human is right there and can see what happened. Only the dispatch path needs to convert that into a reported drop.

### 5. No retry, no auto-dismiss, no modal detector

Stated explicitly because all three are the tempting next step:

- **No pattern matching on screen text.** Matching "Do you want to proceed" / "(y/n)" / "Press esc" across 19 CLIs that redesign their prompts freely is `CLI_AGENT_REGEX` again — a static list standing in for a runtime question, which is the mistake this path has already made once and deleted.
- **No auto-answer, ever — this is the line.** The same widget shape carries "do you trust the files in this folder?" and "delete these files?", and nothing on screen distinguishes them. Pre-consenting a known question at spawn time (§1) is a decision the user makes once, with the question in front of them; answering an unread dialog at dispatch time is a decision made by a component that cannot read it. Those are not the same act and must not share a mechanism.
- **No retry, of any shape.** This was proposed and then killed by measurement, so do not re-propose it. The appeal was "the first send's keystrokes will dismiss a feedback prompt, so a second send lands clean" — but the prompts that actually block the input box are trust/auth menus, and typing does not clear those (8 characters into gemini's ToS menu changed nothing on screen), while the prompts that typing *might* clear turn out not to block the box at all (grok's consent banner sits above a live input). So a retry has no measured case where it rescues a delivery. A retry that *included* the Enter would be worse than useless: what "clears" a menu is answering it, so the retry succeeding is exactly what would make an accidental consent look like the system working.
- **Reassignment is not a retry.** The work goes to a *different* seat immediately, which is why nothing stalls.

### Migration

None. Runtime delivery behaviour only — no persisted state, no config keys, no on-disk format.

## Verification Plan

### Goal Invariants

- No CR is written to a pty unless the same delivery call saw evidence the payload reached an input box.
- A dispatch into a seat showing a modal reports a drop and the queue advances (another seat or the next plan). No seat is flagged, disabled or replaced — the next dispatch re-probes it and succeeds the moment a human has cleared the prompt.
- No single seat's screen state can stall the queue.
- A seat created through the normal path does not show a folder-trust or ToS prompt at all — prevention holds, and the gate is exercised only by prompts that appeared after the seat was configured.
- A dispatch into a normal seat behaves byte-identically to today, including the framing and both CRs.
- No ESC is ever written on the delivery path.
- No Enter is written by `clearBeforePrompt` either — the slash path is gated on the same evidence as the prompt path.

### Automated Tests

Extend `src/test/pty-prompt-delivery-framing.test.js`, whose stub handle already records every write — it needs an `onData` that the test drives:

- **Echo present → today's byte sequence, unchanged.** Feed the stub's `onData` an echo of the payload; assert the write sequence still equals `expectedWrites(text)` for the existing parameterised lengths. This is the no-regression gate and it must stay byte-exact.
- **Echo absent → no CR at all.** Feed nothing; assert the writes end at the close marker, that `writes.filter(w => w === '\r').length === 0`, and that the call rejects.
- **The drop is reported, not thrown:** assert the call resolves with `delivered: false` and a reason naming the seat.
- **The queue fails open on a drop:** assert the queue pump advances to the next plan when a delivery reports `delivered: false`, mirroring the existing dropped-dispatch test for Phone-a-Friend. This is the assertion that would have caught the earlier revision of this plan.
- **No ESC on the path:** assert no write equals or contains `\x1b` other than the two paste markers — a standing guard against the idea this plan rejects.
- **The subscription is disposed on every path**, including the no-echo path (a leaked `onData` per dispatch is a slow leak on a long-lived host).
- **One attempt, then a drop:** assert a silent stub produces exactly one payload write, zero `\r`, and `delivered: false`.

### Manual Verification

1. A normal dispatch to a claude and a devin seat — unchanged behaviour.
2. Put a seat at a modal deliberately (spawn `gemini` in a container/profile with no accepted ToS, or `droid` logged out) and dispatch: the ToS menu is **not** answered, the seat is flagged, and the queue keeps working on other seats.
3. With a queue of 3 plans and one blocked seat, confirm all 3 still complete on the remaining seats — no stall.
4. Clear the blocked seat's prompt by hand, dispatch again, and confirm it takes work immediately with no un-sticking step.
4. Confirm the drop is visible where a user looks — not only in the output channel.
