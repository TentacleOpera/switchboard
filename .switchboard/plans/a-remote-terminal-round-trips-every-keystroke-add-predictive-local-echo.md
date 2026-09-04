# A Remote Terminal Round-Trips Every Keystroke — Add Predictive Local Echo

kanbanColumn: CREATED

## Goal

A character typed into a remote Switchboard terminal appears immediately, before the PTY confirms it, and is reconciled when the real echo arrives. Typing stops feeling like the link.

### Problem analysis

Every keystroke in a Switchboard terminal makes a full round trip before the user sees it. On a good link that is invisible. On a real one it is the dominant cost and it is what makes the terminal feel broken.

Measured on this operator's own link (2026-09-04): gateway ping **min 3.5 ms, avg 53.1, max 189.0, jitter 64.0**. Every character waits out that distribution before appearing. The variance is worse than the mean — typing at 53 ms average with 64 ms of jitter does not feel like a 53 ms delay, it feels unpredictable, which is what the operator reports as "far snappier" about mosh over the same wifi.

**This is the difference mosh is famous for.** Mosh renders the keystroke locally and immediately, marked as unconfirmed, then reconciles against the server's authoritative screen. The round trip still happens; the user simply stops waiting on it. Nothing about that technique requires mosh's transport — it is a client-side prediction layer, and xterm.js is perfectly capable of hosting one.

**What exists today.** `a8f75f5d` (*A keystroke echo waits on two frame boundaries it does not need*, Backlog) removes roughly 20-35 ms of local frame quantization from the echo path. Real, and worth landing — but it optimises the tail of a path whose head is a network round trip. Removing 30 ms from a 53±64 ms wait does not change how typing feels.

This card is the head of that path.

## Metadata

- **Complexity:** 7
- **Tags:** terminals, performance, remote, browser

## User Review Required

None.

## Proposed Changes

### 1. Predict the echo, mark it unconfirmed, reconcile on arrival

Render a typed character locally the moment it is typed, visually distinguished as unconfirmed. When the PTY's real output arrives, reconcile: matching predictions become confirmed, mismatches are discarded and the authoritative bytes win.

The PTY is always the source of truth. A prediction is a hint shown early, never a substitute — if the two disagree, the screen must converge on what the PTY actually said, not on what was guessed.

### 2. Predict only where prediction is safe

Prediction is correct for a plain character echoed at a shell prompt. It is wrong, and visibly wrong, in a full-screen application, at a password prompt, mid-escape-sequence, or anywhere the application is redrawing rather than echoing.

Detect those states and predict nothing. A terminal that guesses wrong in a TUI is worse than one that waits — the failure is visible garbage rather than a pause.

### 3. Adapt to the link, and disable itself when it is pointless

Prediction earns nothing on a local board where the round trip is a millisecond, and it costs a reconciliation path that can only misfire. Measure the observed round trip and engage prediction only when it is worth having.

Do not make this a setting the operator has to find and reason about. The client already knows what the link is doing.

### 4. Do not ship prediction as the only echo improvement

`a8f75f5d` is complementary, not redundant: prediction hides the network, and frame de-quantization makes the confirmation land cleanly. Land both. Neither substitutes for the other.

## Edge-Case & Dependency Audit

1. **A wrong prediction must be invisible, not corrected on screen.** The reconciliation has to resolve before paint where possible; a character that appears and then visibly changes is worse than one that appeared late.
2. **Password and hidden input.** A prompt that suppresses echo must not have its input predicted onto the screen. This is a correctness and privacy requirement, not a polish item.
3. **Full-screen applications.** Editors, pagers and TUIs redraw rather than echo. Prediction must be off in alternate-screen mode.
4. **Backspace, arrows, control characters.** These do not echo as themselves. Either predict them properly or predict nothing for them; a naive character-level predictor produces garbage on cursor movement.
5. **Paste and bracketed paste.** A large paste must not generate a prediction per character.
6. **Both hosts.** The browser cockpit and the extension webview both render terminals and both need this — and it is client-side, so it should be one implementation used by both rather than two.
7. **Local boards must be unaffected.** The default on a 1 ms link is no prediction and no behaviour change.

## Verification Plan

1. Typing on a link with 50 ms+ RTT shows characters immediately, and the display converges on the PTY's output.
2. A prediction that turns out wrong resolves without a visible flicker or a character that changes on screen.
3. No prediction occurs at a password prompt, in alternate-screen mode, or mid-escape-sequence.
4. Backspace and arrow keys never leave a stray predicted character.
5. A large paste does not produce per-character predictions.
6. A local board behaves exactly as it does today, with prediction inactive.
7. Measured end-to-end: perceived keystroke latency on the operator's own link, before and after, on the same connection.
