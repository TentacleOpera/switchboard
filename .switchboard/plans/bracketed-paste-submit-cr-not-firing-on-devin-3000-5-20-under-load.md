# Bracketed-paste submit CR not firing on devin 3000.5.20 under team dispatch load

## Goal

Raise the settle delay between the bracketed-paste close marker (`\x1b[201~`) and the submitting CR in `sendPromptToPty` so the CR reliably submits on devin 3000.5.20 under real dispatch conditions — not just on a quiescent input box. This is the prompt-path sibling of the slash-command CR-split fix that already shipped.

### Problem Analysis

**Symptom.** Team dispatches to devin seats arrive as text in the input box but never submit — the user has to manually press Enter. All 7 dispatches across 3 seats in a UAT run produced zero output because none of them actually started. The prompt text was visible; the submitting CR was absorbed as a literal newline.

`sendPromptToPty` currently writes:

```
\x1b[200~          ← paste open
<chunked text>
\x1b[201~          ← paste close
  ── 40ms ──       ← SUBMIT_SETTLE_MS
\r                 ← submit CR (absorbed as newline on 3000.5.20 under load)
  ── 200ms ──      ← CONFIRM_ENTER_DELAY_MS
\r                 ← confirm CR
```

> **Superseded:** The plan treated “`SUBMIT_SETTLE_MS` (40ms) is too short for the bracketed-paste path under load” as the proven root cause, and attributed the failure to devin parsing `\x1b[201~`, exiting paste mode, re-rendering, and applying queued-message semantics before it could interpret CR as submit.
> **Reason:** The 7/7 UAT failure proves the current byte sequence is unreliable under the observed load, but neither this repository nor the installed devin documentation exposes the TUI input-state transition or proves that 200ms is sufficient. The second CR already arrives 240ms after the close marker, so a delay-only explanation can appear green in a framing test while real dispatch remains broken.
> **Replaced with:** Treat insufficient post-close settling as the strongest evidence-backed working hypothesis. Introduce a dedicated 200ms post-paste submit settle, preserve the existing second CR, and make the previously failing multi-seat UAT the acceptance check; do not claim the internal devin mechanism is proven until external research or an instrumented probe confirms it.

The existing plan (`slash-commands-must-send-the-enter-as-its-own-write.md`) measured that 40ms after **plain text** submits on 3000.5.20. That measurement is valid for the slash-command path. The **prompt path** additionally writes a bracketed-paste close marker between the text and the CR, so it has a distinct transition to settle before submission.

The reported mechanism is that the TUI must:

1. Parse the `\x1b[201~` close marker.
2. Exit paste mode.
3. Re-render the input box with the pasted text.
4. Return to a state where a CR means “submit.”

On a quiescent input box, the existing measurement found 40ms sufficient. Under team dispatch load — terminals may have just finished a prior turn, still be rendering, or have output draining — the UAT result shows that the current prompt path is not sufficient.

**Why the confirm CR cannot be accepted as proof of recovery.** The confirm CR arrives 200ms after the first CR, but the observed UAT still left prompts visible and unsubmitted. Devin’s installed changelog confirms that Enter on an empty input while Devin is working has queued-message semantics, but it does not document how a CR following bracketed paste is classified. The implementation must therefore preserve the confirm CR while validating the entire two-CR sequence against the real failure, rather than inferring success from timing alone.

**Why the slash-command path works but the prompt path does not.** `writeSlashCommandLocked` writes plain text (`/clear`) with no bracketed-paste markers. Its measured 40ms settle separates printable command text from CR so the PTY does not coalesce them into one read. The prompt path has the additional bracketed-paste close transition; changing the shared constant would add latency to a path already measured to work and would erase that distinction.

**Why this only appeared in team UAT and not in single-seat testing.** Single-seat testing typically dispatches to a fresh, idle terminal. Team UAT dispatches to terminals that may have just finished processing a prior turn, are mid-render, or have queued output still draining. The observed failure is load-correlated; the exact devin event-loop mechanism remains an external uncertainty.

**Why the `/clear` CR (`src/standalone/ptyPromptDelivery.ts:69-71`) is not the target here.** `/clear` is plain text with no paste markers and already has a dedicated regression test for an awaited settle. The reported symptom is prompt text in the box without submission, which occurs after the bracketed-paste path at `src/standalone/ptyPromptDelivery.ts:133-145`.

## Metadata

**Tags:** bugfix, cli, reliability
**Complexity:** 3
**Project:** Browser Switchboard

> **Superseded:** `**Complexity:** 2`
> **Reason:** The production edit is localized, but the fix changes a timing-sensitive two-CR protocol, extends the per-terminal lock duration, touches its behavioral contract test, and cannot be accepted without real multi-seat PTY UAT.
> **Replaced with:** `**Complexity:** 3`

## User Review Required

None. Proceed with 200ms as the conservative first mitigation, subject to the explicit external-research caveat and real-load acceptance check below.

## Complexity Audit

### Routine

- Add one path-specific constant in `src/standalone/ptyPromptDelivery.ts` and replace one existing settle reference.
- Preserve the bracketed-paste framing, chunk boundaries, clear path, slash-command path, and confirm CR.
- Extend the existing dedicated contract test rather than creating a new harness.

### Complex / Risky

- The failure is observable only against a real interactive devin PTY under load; repository tests can prove the emitted sequence and timing contract but cannot prove devin submitted the prompt.
- A fixed delay is probabilistic unless the 200ms threshold is measured under representative load.
- The second CR already occurs after an additional 200ms, so the proposed first-CR delay could be implemented exactly and still fail the product goal if the true cause is state-dependent Enter handling rather than close-marker settling.

## Edge-Case & Dependency Audit

### Race Conditions

- `withTerminalLock` serializes the complete send for one terminal name. Raising the first settle from 40ms to 200ms extends that lock by 160ms per dispatch; queued sends to the same seat wait longer, while sends to different seats remain concurrent.
- JavaScript timer delays are minimum scheduling targets, not upper bounds. A loaded process may exceed both 40ms and 200ms, so no test should require the unchanged slash-command gap to stay below an arbitrary wall-clock ceiling.
- The close marker, first CR, and confirm CR must remain inside the same lock callback and in the current order; otherwise another send could splice bytes into the submission sequence.

### Security

- No new input surface, command construction, persisted state, or trust boundary is introduced.
- Prompt bytes and control sequences remain unchanged; only one delay changes.

### Side Effects

- Every standalone PTY prompt, including non-devin seats, receives 160ms more pre-submit latency because this path intentionally has no reliable CLI-identity gate.
- The confirm CR remains 200ms after the first CR, so the total close-marker-to-confirm window becomes approximately 400ms instead of 240ms.
- `SUBMIT_SETTLE_MS` remains 40ms for `writeSlashCommandLocked`; clear and model button latency must not change.
- No migration is required. There is no persisted state, configuration key, or on-disk format change.

### Dependencies & Conflicts

- `src/standalone/ptyPromptDelivery.ts:14-20,57-71,91-145` is the source of truth for the direct PTY timing and framing contract.
- `src/test/pty-prompt-delivery-framing.test.js:100-115,239-264,279-349` already records write timestamps and contains source-scoped contract checks; extend it in place.
- `src/services/terminalUtils.ts:79-87,218-235` is an indirect VS Code/clipboard path with different timing physics. Its 100/300ms post-paste settle and later 100/300/600ms newline delay are context only, not constants to reuse or modify.
- The sibling slash-command fix is already present in source. This plan has no blocking in-flight dependency.

## Dependencies

None. The shipped slash-command split is precedent, not an implementation dependency.

## Adversarial Synthesis

Key risks: 200ms is an empirical mitigation rather than a proven devin state transition, the existing confirm CR means a source-level timing test can pass while dispatch still fails, and the longer settle increases per-seat lock time. Mitigations: isolate the delay to the bracketed-paste path, preserve the measured slash-command timing and framing contract, reject flaky timer upper bounds, and require the previously failing multi-seat load scenario to pass before accepting the change.

## Proposed Changes

### 1. `src/standalone/ptyPromptDelivery.ts:14-20,91-145` — add a dedicated post-paste submit settle

**Context.** `SUBMIT_SETTLE_MS` currently serves both plain-text slash commands and the post-`\x1b[201~` prompt transition. The plain-text path succeeded in the existing isolated measurement, while the bracketed-paste path failed in the reported loaded UAT, so they require independently tunable timing contracts.

**Logic.** Add a separate constant for the bracketed-paste path, set it to 200ms, and use it only between the close marker and the first submitting CR:

```ts
// The paste-close marker (\x1b[201~) and the submitting CR need a separately
// tunable settle from the plain-text slash-command path's SUBMIT_SETTLE_MS.
// On devin 3000.5.20, 40ms succeeded for isolated plain text but the prompt
// path stranded all 7 dispatches in the reported loaded UAT. Use 200ms as the
// conservative mitigation and verify it against that real-load failure; the
// exact internal Devin input-state transition is not established here.
// Do not reduce this based only on a quiescent-input measurement.
const POST_PASTE_SETTLE_MS = 200;
```

Then update only the prompt-path await:

```ts
handle.write('\x1b[201~');
await new Promise(r => setTimeout(r, POST_PASTE_SETTLE_MS));
handle.write('\r');
```

`SUBMIT_SETTLE_MS` remains 40ms and continues to be used by `writeSlashCommandLocked` at `src/standalone/ptyPromptDelivery.ts:69-71`.

> **Superseded:** “200ms matches `CONFIRM_ENTER_DELAY_MS` (the delay that already works for the confirm CR on the same seat) and is the value the clipboard path in `terminalUtils.ts` effectively provides through its IPC round-trip.”
> **Reason:** The confirm delay governs the transition after the first CR, not the transition after `\x1b[201~`; the clipboard path also has separate post-paste and newline delays whose combined budget is not 200ms. Neither is proof that 200ms solves this direct-PTY failure.
> **Replaced with:** Use 200ms as a conservative path-local mitigation selected from the observed failure at 40ms and validate it under the previously failing team load. Keep the direct and indirect path constants separate.

**Implementation constraints.**

- Do not change `SUBMIT_SETTLE_MS`, `CONFIRM_ENTER_DELAY_MS`, `DEFAULT_CLEAR_SETTLE_MS`, `CHUNK_DELAY_MS`, or `CLEAR_INPUT_SETTLE_MS`.
- Do not remove or gate the confirm CR.
- Do not add CLI-name, terminal-role, or version detection.
- Do not move any write or await outside `withTerminalLock`.

**Edge cases.** Empty text, one-chunk text, multi-chunk text, and the known close-marker boundary lengths must retain the same write sequence; only the first post-close timestamp changes.

### 2. `src/standalone/ptyPromptDelivery.ts:91-132` — correct the timing commentary without overstating causality

**Context.** The existing comment says an isolated CR 40ms after text submits on both measured devin versions. Preserve that plain-text result and append the bracketed-paste distinction.

**Implementation.** State that:

- The 40ms measurement applies to plain printable text in `writeSlashCommandLocked`.
- The bracketed-paste path has a separate post-close transition and now uses `POST_PASTE_SETTLE_MS`.
- The 200ms value is justified by the load failure and must be re-measured under representative load before reduction.
- The mechanism remains a working hypothesis; acceptance comes from real dispatch behavior, not from the timer alone.

### 3. `src/test/pty-prompt-delivery-framing.test.js:100-115,239-264,279-349` — guard path separation and the awaited delay

**Context.** The test already records `Date.now()` for every `handle.write`, tests the slash-command delay, and performs source-scoped checks. Extend those patterns rather than introducing a new test file.

**Logic.** Add focused checks that:

- `src/standalone/ptyPromptDelivery.ts` defines `POST_PASTE_SETTLE_MS` as 200.
- In `sendPromptToPty`, the close-marker write is followed by an awaited timeout using `POST_PASTE_SETTLE_MS`, then a bare first `handle.write('\r')`.
- A single representative behavioral send records a substantial real gap between `\x1b[201~` and the first CR, proving the await is active rather than merely declared.
- `writeSlashCommandLocked` still awaits `SUBMIT_SETTLE_MS` between the command and CR, and the existing minimum-gap assertion remains.
- Existing framing assertions remain unchanged: whole standalone markers, preserved chunk boundaries, exactly two trailing CR writes, and Ctrl+U outside the paste block.

> **Superseded:** Assert that the slash-command wall-clock gap is `<100ms` to prove the 200ms change did not leak into that path.
> **Reason:** Under scheduler load, `setTimeout(40)` may legally fire after 100ms; an upper-bound wall-clock assertion would be flaky and would not identify which constant the code used.
> **Replaced with:** Source-scope `writeSlashCommandLocked` and assert it references `SUBMIT_SETTLE_MS`, not `POST_PASTE_SETTLE_MS`; retain the existing behavioral minimum-gap check to prove the await is real.

**Edge cases.** Locate the first CR by index after the close marker rather than by a file-wide CR search, because `clearBeforePrompt: true` adds a separate slash-command CR and `sendPromptToPty` intentionally emits a confirm CR.

### Scoped out

- **The slash-command path (`writeSlashCommandLocked`)** is not changed. Its 40ms settle is measured-correct for plain text with no paste markers.
- **`CONFIRM_ENTER_DELAY_MS` (200ms)** is not changed. The second CR remains part of the existing delivery contract.
- **The clear-before-prompt settle (`DEFAULT_CLEAR_SETTLE_MS`, 600ms)** is not changed. It governs the wait after `/clear` submits and before prompt paste begins.
- **The VS Code clipboard path in `src/services/terminalUtils.ts`** is not changed; it has focus, clipboard, IPC, local/remote, and newline-delay concerns absent from direct PTY writes.
- **Adaptive readiness detection or devin-version branching** is not added. No reliable readiness signal or CLI identity exists on this path.

### Migration

None. No persisted state, config keys, or on-disk format are involved; this is a runtime PTY timing change.

## Verification Plan

### Automated Tests

Run the existing focused contract command after implementation:

- `npm run test:contract:pty-prompt-delivery-framing`

The test must cover:

1. `POST_PASTE_SETTLE_MS` exists with value 200 and is awaited only in the post-close prompt path.
2. The first CR follows `\x1b[201~` after the dedicated awaited settle.
3. `writeSlashCommandLocked` still uses `SUBMIT_SETTLE_MS` and retains its real-delay minimum assertion without a flaky upper bound.
4. Existing whole-marker, chunk-boundary, Ctrl+U-placement, no-identity-gate, and two-CR assertions remain green.

### Goal Invariants

- `src/standalone/ptyPromptDelivery.ts` contains `const POST_PASTE_SETTLE_MS = 200`.
- In `sendPromptToPty`, `handle.write('\x1b[201~')` is followed by an awaited timeout using `POST_PASTE_SETTLE_MS`, followed by the first bare `handle.write('\r')`.
- In `writeSlashCommandLocked`, the command-to-CR await still uses `SUBMIT_SETTLE_MS`; `POST_PASTE_SETTLE_MS` is absent from that function body.
- `sendPromptToPty` still emits exactly two bare CR writes after the close marker.
- `src/test/pty-prompt-delivery-framing.test.js` contains a regression assertion for the close-marker-to-first-CR settle and a path-separation assertion for `writeSlashCommandLocked`.
- The previously failing team UAT produces zero prompts left visible and unsubmitted across the same three devin seats.

### Manual Verification

Use `terminals.html` with devin 3000.5.20 and preserve terminal output long enough to distinguish submission from text merely appearing in the input box.

1. Re-run the previously failing team dispatch scenario across the same 3 devin seats while seats are finishing prior turns or draining output. Every prompt must leave the input box, begin a turn, and produce output without manual Enter.
2. Repeat the loaded dispatch enough times to cover at least the prior 7-dispatch failure sample. Acceptance is zero stranded prompts, not merely a successful HTTP/dispatch response.
3. Dispatch to an idle devin seat. Submission must remain automatic.
4. Dispatch to a claude seat under the same team load. Submission must remain automatic and the extra 160ms must not create a visible blank-input side effect.
5. Trigger frame `clear` and `model` actions. Both must retain their current behavior and latency profile because the slash-command path remains at 40ms.
6. If any prompt remains visible and unsubmitted after the change, reject the delay-only hypothesis and capture the PTY input/output timeline around `\x1b[201~`, first CR, and confirm CR before changing another constant.

## Uncertain Assumptions

The user was advised to run web research before implementation to confirm these external, code-unanswerable assumptions:

- Devin CLI 3000.5.20 requires additional processing time after `\x1b[201~` under load, and that transition — rather than another state-dependent Enter rule — causes the observed first CR to become a newline.
- A 200ms post-close settle is sufficient across representative machines and busy terminal states.
- Retaining a second CR 200ms after the first remains safe with devin’s queued-message behavior and with the other supported interactive CLIs.

## Recommendation

Send to Intern.
