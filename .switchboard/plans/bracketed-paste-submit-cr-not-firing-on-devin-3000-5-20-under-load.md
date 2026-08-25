# Detect PTY clear readiness before prompt delivery

## Goal

Replace blind post-`/clear` sleeps on directly-owned PTY seats with CLI-aware readiness detection and a compatibility-preserving Auto/Manual timing policy. Preserve the existing bracketed-paste framing and submit CR sequence; prompt bytes must not be written until the cleared CLI’s final input editor is ready.

### Problem Analysis

**Observed failure.** Seven dispatches across three Devin seats placed prompt text in the input box but never submitted. The later text appearance hid the real ordering defect: prompt and CR bytes had arrived while `/clear` was still tearing down and rebuilding the session.

`sendPromptToPty` currently writes `/clear`, sleeps a fixed direct-PTY delay (600ms by default), then writes the prompt. Controlled `node-pty` probes against Devin `3000.4.25` and `3000.5.20` showed:

- Idle bracketed paste succeeds with the existing 40ms submit settle.
- Three simultaneous seats succeed at 40ms.
- During a real active turn, the first CR queues and the existing confirm CR sends now successfully.
- Payloads from 1k through 10k characters submit successfully.
- `/clear` followed by a prompt after 600ms fails on both Devin versions.
- Devin `3000.5.20` required roughly 8.85 seconds in one trace and passed through multiple paste-enable/disable cycles before its final input editor was safe.

The successful probe had to reject an intermediate `?2004h`/cursor-visible phase because Devin disabled bracketed paste again milliseconds later. Clear completion is a state-machine judgment over the latest terminal-mode transitions—not “first output,” “first paste enable,” or elapsed time.

### Preserved Delivery Contract

- `SUBMIT_SETTLE_MS = 40` remains unchanged.
- `CONFIRM_ENTER_DELAY_MS = 200` remains unchanged.
- Bracketed-paste open/close markers remain whole standalone writes.
- Clear, readiness wait, paste, and CR writes remain inside the per-terminal lock.
- No `POST_PASTE_SETTLE_MS` is added.

## Metadata

**Tags:** backend, bugfix, cli, reliability
**Complexity:** 7
**Project:** Browser Switchboard

## User Review Required

None. Local old/new binary probes established the failure mechanism and proved a working Devin readiness sequence.

## Complexity Audit

### Routine

- Reuse `ExtendedTerminalHandle.onData`, `onExit`, and `lastDataAt`.
- Extract existing startup-command basename logic into shared CLI-family derivation.
- Preserve existing framing tests and add deterministic state-machine tests.

### Complex / Risky

- Escape sequences can split across PTY chunks.
- Devin produces intermediate ready-looking states during one clear.
- Listener/timer cleanup must be correct on success, timeout, exit, and thrown writes.
- Existing explicit delay settings must retain operator intent without allowing contributed defaults to disable Auto detection.

## Edge-Case & Dependency Audit

### Race Conditions

- Subscribe before writing `/clear`; subscribing afterwards can miss the old-session disable.
- Any output after candidate readiness resets the quiet timer.
- A later paste disable invalidates an earlier enable/cursor candidate.
- Terminal exit resolves failure and blocks prompt paste.
- Concurrent sends remain serialized by the existing terminal lock.

### Security

- Store only a normalized family enum (`devin`, `claude`, `antigravity`, `unknown`) on the handle—not the startup command or environment.
- Resolve family host-side; never trust a request payload, terminal friendly name, or role label.

### Side Effects

- Devin Auto clears may hold a send for several seconds until real readiness.
- Claude and Antigravity use short output-settled profiles rather than Devin’s restart state machine.
- Unknown/custom CLIs retain fixed configured fallback behavior.
- Manual PTY timing mode intentionally bypasses detection and uses the operator’s exact delay.

### Dependencies & Conflicts

- Atomic team/feature-run lifecycle consumes this readiness API for roster and destination clears.
- Dispatch-curtain UX consumes structured readiness results for status/telemetry but does not own correctness.
- Kanban Setup UI owns Auto/Manual controls; this plan owns runtime policy resolution.

## Dependencies

None. This is the foundational subtask.

## Adversarial Synthesis

The top risk is false readiness: Devin can enable paste and show a cursor, then disable paste and restart again. The implementation must track the latest transition, require final render completion plus quiet, and retain a bounded fallback without pretending fallback proves readiness.

## Proposed Changes

### 1. `src/services/cliIdentity.ts` — shared CLI-family derivation

Extract the first-token/path-basename normalization currently duplicated by `TaskViewerProvider.deriveAgentDisplayName` and `KanbanProvider._getAgentNames`.

Return display name plus timing family:

- `devin`
- `claude`
- `antigravity` for `agy`/`antigravity`
- `unknown`

Wrapper-heavy/unparseable commands fall back to `unknown`.

### 2. `src/standalone/ptyFleetService.ts` — retain family on PTY handles

Resolve the effective startup command once during terminal creation. Add `cliFamily` to `ExtendedTerminalHandle` and `FleetTerminalInfo`. Delegates use their own explicit startup command when present.

### 3. `src/standalone/clearReadiness.ts` — pure tracker and waiter

Implement a bounded rolling parser and fake-clock-testable waiter.

#### Devin Auto profile

After clear CR:

1. Observe `\x1b[?2004l` from the old session.
2. Latest bracketed-paste transition must be `\x1b[?2004h` later than the latest disable.
3. After that enable, observe `\x1b[?25h` and `\x1b[?2026l`.
4. Require approximately 100ms output quiet.
5. Every new chunk cancels/restarts quiet; a later disable invalidates the enable candidate.
6. Use a calibrated 12–15s hard fallback and report fallback explicitly.

#### Claude/Antigravity Auto profiles

Require post-clear live output before quiet detection, then a short quiet window and a few-second cap. Calibrate with installed Claude `2.1.241` and Agy `1.1.19` before final constants.

#### Unknown profile

Use the resolved fixed fallback delay; do not claim signal readiness.

Return `{ reason: 'signal' | 'fallback' | 'manual' | 'exit', elapsedMs }`.

### 4. Shared PTY timing policy

Preserve:

- `terminal.clearBeforePromptDelay` as exact VS Code-terminal timing.
- `terminal.ptyClearBeforePromptDelay` as PTY manual delay/unknown fallback.

Add `terminal.ptyClearReadinessMode` (`auto` | `manual`), with absence meaning compatibility inference.

Resolve:

1. Explicit Auto → known profiles; unknown uses PTY fallback.
2. Explicit Manual → PTY explicit, else explicit legacy VS Code delay, else 600ms.
3. No mode + explicit PTY delay → compatibility Manual.
4. No mode/PTY value + explicit legacy delay → compatibility Manual.
5. No explicit values → Auto; unknown fallback 600ms.

Use `inspect()` and `!== undefined` on the extension host; use presence/`NaN` checks on standalone. Preserve explicit zero.

### 5. `src/standalone/ptyPromptDelivery.ts` — await readiness

When `clearBeforePrompt` is true:

1. Attach readiness/exit listeners.
2. Write `/clear` through `writeSlashCommandLocked`.
3. Await Auto signal/fallback or Manual delay.
4. Dispose all listeners/timers in `finally`.
5. Paste and submit only if terminal remains active.

When clear is false, allocate no tracker and add no latency.

### 6. `scripts/probe-devin-submit.js` — retain diagnostic harness

Clean the current probe’s argument/output contract. Keep old/new binary selection, clear sequence, busy-state test, payload sizing, timing events, and raw JSON transcript output. Do not create a separate README.

## Verification Plan

### Automated Tests

- Chunk-fragmented escape sequences.
- Intermediate enable/cursor followed by disable does not resolve.
- Final enable after final disable + cursor + render end + quiet resolves once.
- Quiet reset on output.
- Manual and fallback reasons.
- Terminal exit blocks paste.
- Listener/timer cleanup on every exit path.
- Existing `npm run test:contract:pty-prompt-delivery-framing` remains green.

### Goal Invariants

- Output subscription is attached before `/clear` submit.
- Devin intermediate readiness cannot release prompt delivery.
- Auto known-family timing ignores contributed fixed defaults.
- Explicit Manual uses exact resolved PTY delay, including zero.
- VS Code fixed-delay semantics are not changed by this backend.
- Prompt framing remains 40ms plus existing 200ms confirm CR.

### Manual Verification

1. Devin `3000.5.20`: clear then `/help`; detector rejects intermediate restart and submits after final readiness.
2. Same without clear: no detector allocation or added latency.
3. Claude/Agy: calibrate short profiles.
4. Unknown CLI: fixed fallback.
5. Exit during clear: no prompt paste.

## Recommendation

Send to Lead Coder.

## Completion Summary

Implemented CLI-aware PTY clear readiness detection and shared Auto/Manual timing resolution. Shared CLI identity and brand derivation now normalizes CLI families (`devin`, `claude`, `antigravity`, `unknown`) across frontend and backend services. Extended terminal handles and registries retain CLI family metadata, allowing `sendPromptToPty` to track post-clear escape sequences before bracketed paste delivery. Devin's multi-stage restart and intermediate enable transitions are validated with synchronized render completion plus quiet detection, while prompt framing and unconditional confirm CR semantics remain preserved. Added unit test suites verifying state machine transitions, timing resolution invariants, and exit safety.

## Review Findings

Reviewed and fixed. **Files changed:** `tsconfig.json`, `src/standalone/ptyPromptDelivery.ts`, `src/standalone/clearReadiness.ts`, `src/standalone/ptyHost.ts`, `src/test/bootstrap/tsResolveHook.js` (new), `src/test/clear-readiness-state-machine.test.js`, `src/test/pty-prompt-delivery-framing.test.js`, `src/test/pty-route-surface-contract.test.js`. Four defects: the `./clearReadiness.ts` import forced `allowImportingTsExtensions` project-wide, which is incompatible with `tsconfig.test.json` and left `npm run compile-tests` — CI's first typecheck gate — red (fixed by the extensionless import plus a test-local ESM resolve hook); `test:contract:pty-route-surface`, a CI-wired gate, was red because `resolvePtyClearDelay` moved to `ptyClearPolicy.ts` (contract repointed and extended to pin `clearReadinessMode` on all three injection arms); a second, divergent `resolvePtyTimingPolicy` lived in `clearReadiness.ts` with no production caller (deleted — `ptyClearPolicy.ts` is the single ladder); and the Claude/Antigravity output-settled profile treated the CLI's echo of the typed `/clear` as post-clear output, so a 100ms quiet window could resolve ready before the clear began (added `markSubmitted()`, with the echo case pinned by a test). `sendPromptToPty` now returns the `ClearReadinessResult` and `ptyHost` carries it back over the wire, so both hosts report the real reason instead of a hardcoded `signal`. **Validation:** `compile-tests`, `compile`, `lint` (0 errors), and all 10 affected contract suites green; `test:contract:clear-readiness` newly wired into CI. **Remaining risk:** the Devin 12–15s fallback and the 100ms quiet windows are still the plan's uncalibrated estimates — only real-CLI probe runs can confirm them.
