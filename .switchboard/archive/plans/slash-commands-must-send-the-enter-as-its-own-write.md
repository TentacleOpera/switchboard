# Slash commands must send the Enter as its own write — devin 3000.5.20 no longer submits a concatenated CR

## Goal

Make `writeSlashCommandLocked` deliver the command text and its submitting CR as two writes separated by a real delay, and fix the one sibling site that concatenates them. This restores the frame/sidebar clear and model buttons on devin seats, and stops `clearBeforePrompt` from silently prefixing every dispatched prompt with an unsubmitted `/clear`.

### Problem Analysis

**Symptom.** Clicking `clear` on a devin terminal's frame in `terminals.html` leaves `/clear` sitting in devin's input box with a blank second line under it. The command is never submitted; the user has to press Enter manually.

**Root cause — a devin-side change, not ours.** The devin CLI updated from `3000.4.25` to `3000.5.20` on 2026-08-23 at 09:51 (`~/.local/share/devin/cli/_versions/`). The new build no longer treats a CR as *submit* when that CR arrives in the same read as printable text — it inserts it as a literal newline instead. Measured on a `node-pty` master at 100×30, writing to a fully-drawn input frame:

| bytes written | 3000.4.25 | 3000.5.20 |
|---|---|---|
| `\x15` → 30 ms → `"/clear\r"` — today's shipped shape | submits (`✓ Started new session`) | **input box grows to 2 rows: `["❭ /clear", ""]`** |
| `"/clear\r"` — the pre-2026-08-17 shape | — | **same failure** |
| `"/clear"` → 0 ms → `"\r"` (separate `write()` calls, no delay) | — | **same failure** |
| `"/clear"` → 40 ms → `"\r"` | — | submits |
| `"/clear"` → 300 ms → `"\r"` | — | submits |
| `"/clear"` → 300 ms → `"\n"` (LF instead of CR) | — | **fails** |
| `\x1b[200~ /clear \x1b[201~` → 40 ms → `\r` → 200 ms → `\r` — the prompt path | — | submits |

Four things follow, and each kills a plausible theory:

1. **The 2026-08-17 Ctrl+U change (`59dd853a`) is not the cause.** The exact pre-`59dd853a` byte shape (`"/clear\r"`, no Ctrl+U) fails identically on the new build. The Ctrl+U prefix is innocent and stays.
2. **"Its own write" is not sufficient — it needs its own *read*.** Two back-to-back `write()` calls with no `await` between them fail exactly like one concatenated write; the pty coalesces them into a single read. Only a real delay separates them. Anyone "optimising away" the await reintroduces this bug, so the comment must say so.
3. **It is not a CR-vs-LF question.** LF does not submit at any delay.
4. **The prompt path is unaffected** — the bracketed-paste close marker plus a 40 ms settle already isolates its CR. Only the slash-command path is broken, which is why prompt dispatch still appears to work.

**The serious half: `clearBeforePrompt` now corrupts every devin dispatch.** `sendPromptToPty`'s clear branch calls the same helper, so on 3000.5.20 the `/clear` never submits — it stays in the buffer, and the prompt's bracketed-paste block appends to it. Replaying the exact `clearBeforePrompt: true` sequence and stopping before the submit CR renders:

```
❭ /clear
  PROBE_PAYLOAD_MARKER_DO_NOT_SUBMIT
────────────────────────────────────
```

The submit CR then sends `/clear` + newline + the entire prompt as one message, and the context is never reset. `terminal.clearBeforePrompt` defaults to `true`, so this is the current behaviour of every prompt dispatched to a devin seat. This is the same concatenation bug the Ctrl+U was added to prevent, arriving from the other end — Ctrl+U clears what the *user* left behind, and nothing clears what *we* left behind.

**Why no other CLI is affected.** Every other CLI in the fleet submits on the concatenated CR, so the single-write shape has always worked for them; devin's editor is the only one that changed. Devin is also the only Rust CLI here (its binary links `crossterm` and `termwiz`), so it has never shared the Node/Ink CLIs' input decoder. Its startup DEC private modes are byte-identical between the two builds (`?2004h ?1004h ?2026h ?25h …`), so the change is in key handling, not in mode negotiation — consistent with the new build's message-queueing feature ("Type while the agent works to queue messages; press Enter on an empty input to send them now"), which is a rework of exactly this code path.

**Why the fix is unconditional.** Splitting the CR is free for every other CLI — they submit on an isolated CR too, as the prompt path has demonstrated on all of them since 2026-07-20. The deleted `CLI_AGENT_REGEX` allowlist is the standing precedent: a static name list standing in for a runtime question is how this path broke before, and a devin-only branch would be that mistake again.

## Metadata

**Complexity:** 3
**Tags:** bugfix, cli, reliability
**Project:** Browser Switchboard

## User Review Required

None.

## Proposed Changes

### 1. `src/standalone/ptyPromptDelivery.ts:57-61` — split the CR (the fix)

`writeSlashCommandLocked` becomes:

```ts
export async function writeSlashCommandLocked(handle: ExtendedTerminalHandle, command: string): Promise<void> {
    handle.write(CLEAR_INPUT_LINE);
    await new Promise(r => setTimeout(r, CLEAR_INPUT_SETTLE_MS));
    handle.write(command.replace(/[\r\n]+$/, ''));
    await new Promise(r => setTimeout(r, SUBMIT_SETTLE_MS));
    handle.write('\r');
}
```

Reuse the file's existing `SUBMIT_SETTLE_MS` (40) rather than adding a fourth constant: it already means "settle between the payload and its Enter", it is the value the prompt path uses on this same seat, and 40 ms is measured sufficient here. If a slow machine ever flakes, that one constant is the dial, and raising it fixes both paths at once.

The `await` is load-bearing, not cosmetic pacing — see Problem Analysis point 2. Say so in a comment, or the next reader deletes it.

This one change fixes every caller: the frame `clear` and `model` buttons, the sidebar row's `clear`, CLEAR ALL TERMINALS, the team clear verbs, the `ptyWrite` slash-command branch (`ptyHost.ts:206`, `bootstrap.ts:1983`), and `clearBeforePrompt`.

### 2. `src/services/TaskViewerProvider.ts:15710` — the seam leg of `sendToTerminal`

```ts
terminal.sendText(input, true);          // becomes text + '\r' in one write
```

For a non-`vscode.Terminal` handle this resolves to `ptyBackend.ts:103`, `ptyProcess.write(text + (addNewLine !== false ? '\r' : ''))` — the identical defect, reached through the seam. Split it the way the branch above already splits Ctrl+U: `sendText(input, false)`, settle `SUBMIT_SETTLE_MS`, `sendText('', true)`.

**Fix the call site, not the seam.** `TerminalHandle.sendText` is synchronous and returns `void`, so it cannot settle between its two writes without a fire-and-forget timer that would reorder against the caller's next write. The call site can `await`; the seam cannot.

**Do not touch `ptyFleetService.ts:471`** (`injectStartupCommand`). That `sendText(cmd, true)` goes to the *shell*, before the CLI launches — a shell's line discipline submits a concatenated CR correctly, and there is no TUI editor to confuse. Leave the seam's `addNewLine` contract intact for it.

### 3. `src/standalone/ptyPromptDelivery.ts:80-118` — update the comment block to the measurement

The framing-rules comment currently records the second CR's justification as an open question: *"Nobody has tested devin at 100ms with a SINGLE CR — do that before treating the second CR as load-bearing."* That test has now been run, and the answer is in the table above. Replace the open question with the measured result: on 3000.5.20 a CR concatenated with text never submits at any delay, and an isolated CR ≥40 ms after the text always does. Keep the refuted-theory note (both CLIs honour the paste markers) — it is still true and still worth not re-deriving.

### Scoped out, with the decision stated

**The prompt path's second CR stays for now.** It is measured-necessary on 3000.4.25 and harmless on an empty input box, and this plan does not change it. But 3000.5.20's new queueing feature makes an Enter on an empty input mean "send queued messages now", so a stray second CR could flush a message the user was mid-typing. That deserves its own measurement (type into the box while an agent works, then send a lone CR) and its own change — bundling an unmeasured removal into a fix that is otherwise fully measured would be trading a known bug for an unknown one.

### Migration

None. No persisted state, no config keys, no on-disk format — this is a byte sequence written to a pty at runtime.

## Verification Plan

### Goal Invariants

- No code path writes printable text and its submitting CR without an awaited delay between them.
- The frame `clear` and `model` buttons submit on a devin seat.
- A dispatch with `clearBeforePrompt: true` resets a devin seat's context, and the delivered prompt begins with the prompt's own first character — never `/clear`.
- Ctrl+U still precedes every slash command, still outside any bracketed-paste block.

### Automated Tests

Extend `src/test/pty-prompt-delivery-framing.test.js`, which already records writes into an array and asserts `writes[0] === '\x15'`:

- **The CR is its own write:** for `writeSlashCommandLocked(handle, '/clear')`, assert the recorded writes are exactly `['\x15', '/clear', '\r']` — in particular that no write both ends with `\r` and carries other characters. This is the regression test for the reported bug and it needs no devin.
- **The delay is real:** assert a nonzero wall-clock gap between the text write and the CR write (or that the implementation awaits between them). Point 2 above is the reason: a test that only checks write *boundaries* passes the broken zero-delay shape.
- **Ctrl+U placement is unchanged:** keep the existing assertions that `\x15` is first and never appears after `\x1b[200~`.
- **The seam leg splits too:** assert `sendToTerminal`'s non-`processId` branch does not call `sendText(input, true)` for a control string — the existing `pty-route-surface-contract.test.js` already greps this function for the Ctrl+U reset and is the natural home.

### Manual Verification

On a devin seat in `terminals.html`, with 3000.5.20:

1. Frame `clear` → the context resets, nothing is left in the input box, no manual Enter.
2. Frame `model` → the model picker opens (same helper, so it is the free second data point).
3. Dispatch a plan to a devin seat with `clearBeforePrompt` at its default → the seat's context is reset and the prompt devin receives does not begin with `/clear`.
4. Repeat 1 on a claude seat → unchanged, confirming the split is harmless where the old shape worked.

The probe harness used for the measurements above lives in this session's scratchpad (`devin-cr-probe2.js`, parameterised by gap, and `devin-clearbeforeprompt-probe.js`, which stops before the submit CR so nothing is dispatched). `scripts/capture-cli-modes.js` is the committed sibling for startup-mode questions; if this recurs on another CLI, extend that script rather than writing a third harness.

## Review Findings

All three proposed changes landed as written: `writeSlashCommandLocked` splits the CR behind an awaited `SUBMIT_SETTLE_MS`, the `TaskViewerProvider` seam leg splits at the call site rather than in `TerminalHandle.sendText`, and the framing-rules comment now records the 2026-08-23 measurement instead of an open question. One CI gate was left red by the change and is fixed here: `src/test/verb-engine-headless-seams.test.js` asserted `terminalSends` held exactly one entry, but the headless seam records every `sendText`, so the split makes two — that suite runs at `integration-tests.yml:513`. Files changed by this review: `src/test/verb-engine-headless-seams.test.js`. Validation: `tsc -p tsconfig.test.json` clean, `eslint` 0 errors, `test:contract:pty-prompt-delivery-framing` and `test:contract:pty-route-surface` green, and `verb-engine-headless-seams` reports 25 passed / 0 failed. Remaining risk: that suite still hard-exits in CI on a pre-existing unhandled rejection from 2026-07-13 constructor migrations, unrelated to this plan.

## Deferred Findings

- NIT — `SUBMIT_SETTLE_MS` is now defined twice at 40 (`src/standalone/ptyPromptDelivery.ts:17` and `src/services/terminalUtils.ts:65`); the plan intended one dial. Unifying would require the vscode-free standalone module to import a vscode-carrying one, so the duplication is forced and documented in both comments.
- NIT — The seam leg at `src/services/TaskViewerProvider.ts:15232` splits payload from CR for prompts as well as control strings, broader than the plan's step 2 specified. Correct either way; it satisfies the goal invariant more completely.
- MAJOR (pre-existing, out of scope) — `test:contract:verb-engine` (`.github/workflows/integration-tests.yml:513`) exits non-zero on an unhandled rejection raised by `_foldAgentConfigToGlobalFile` / `_migratePlannerWorkflowPathProfileTiersWorkflowsToSkills` reaching `vscode.workspace` during headless construction (`src/services/TaskViewerProvider.ts:1395`). Introduced 2026-07-13, long before this plan. Every assertion passes under `--unhandled-rejections=warn`.
